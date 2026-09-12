// Difficulty bands (data, from ARCHITECTURE.md) plus the primitive composer: given a world and a
// rung number, picks a concrete Step[] plan within that band's complexity envelope. Also exports
// the small pure pieces (`runCompute`, `resolveRefs`, `runPlanLocally`) that rung.js and
// reference.js both need so the local (answer-key) and HTTP (reference) executions of the same
// plan agree by construction.
//
// Step = { op, args, resultKey }, op one of:
//   create   args:{kind:'image'|'audio', params}                    -> descriptor
//   convert  args:{from, opts}                                      -> descriptor
//   combine  args:{from:[key,...], opts:{mode, opacityStep?}}       -> descriptor
//   diff     args:{a, b, verifyEtag?}                                -> descriptor
//   lora     args:{from, loraName}                                   -> descriptor
//   batch    args:{workspaceId, projectId, subsetSize, pageSize,
//                  apply:{op:'lora',loraName}|{op:'convert',opts},
//                  sideChecks?:{csv?,softDelete?}}                   -> descriptor[]
//   compute  args:{fn, of?, percent?}                                -> plain value (number/object)
//   render   args:{kind, params, workspaceId}                        -> descriptor (side effect:
//                                                                       records {workspaceId,projectId})
//   publish  args:{renderKey}                                        -> same descriptor as renderKey
//
// Every step's args may contain `{ $ref: key, field? }` placeholders, resolved against the
// running env (of descriptors/values) via resolveRefs before the op executes.

import { rng, sub, pick, int } from '../seed.js';
import { create, convert, combine, diff, applyLora } from '../media.js';
import { createResourceStore, seedInitialData, listWorkspaces, listProjects, listAssetsForProject } from '../api/resources.js';


// Difficulty bands. Three of the six columns are *inputs* the composers below read, and three are
// the measured envelope of what those inputs produce:
//
//   params   INPUT.  A budget of stated leaves -- the numbers, colours and words the rung's text
//            spells out and the agent has to transcribe without drift. A drawn canvas costs 3
//            (across, down, ground colour); every shape on it costs 5 (kind-and-size, x, y,
//            colour, opacity); every tone costs 5. shapeCountFor/noteCountFor/subsetFor spend it.
//   kinds    INPUT.  Which media a rung in this band may ask for. Audio is measurably the easier
//            path -- it skips unit conversion, the rounding grid and all geometry -- so it lives
//            only at the bottom two bands; everything above is pictures.
//   features INPUT.  name -> the first offset INSIDE the band at which that obligation switches
//            on, so a band is itself a ramp rather than a flat shelf (see featureAt).
//
//   steps    measured plan length for this band across seeds 1-3 (see scripts/band-envelope.js).
//   lookups  measured count of things the rung makes the agent go and find: a house-style label,
//            a workspace/project label, a live behaviour the written reference gets wrong.
//   quant    measured count of quantising operations: unit-to-pixel conversions and resizes, each
//            of which re-rounds on the house grid.
//
// Round 2 of Addendum C calibration put gpt-6-astra at rung 59 with sixty first-try submissions
// and zero failures, which means tiers 0-5 as they stood measured nothing about it. This table
// and the composers that read it are that round's steepening: more shapes and tones per rung,
// pictures instead of audio above tier 1, a house-style lookup and a percent resize pulled down
// into rungs 10-39, trap-dependence pulled down into rungs 15-39, pagination that actually
// paginates (page smaller than the subset) in every batch band, and post-render chains where
// tiers 5 and 6 used to be a single call.
export const BANDS = [
  {
    tier: 0, min: 0, max: 9,
    steps: [1, 1], params: [13, 18], lookups: [0, 1], quant: [0, 1],
    kinds: ['image', 'audio'],
    features: {},
    behaviors: ['auth', 'create'],
  },
  {
    tier: 1, min: 10, max: 19,
    steps: [3, 4], params: [18, 23], lookups: [1, 3], quant: [1, 3],
    kinds: ['image', 'image', 'audio'],
    features: { percentRound: 5, liveTrap: 5 },
    behaviors: ['convert', 'idempotency', 'loraLookup'],
  },
  {
    tier: 2, min: 20, max: 29,
    steps: [4, 5], params: [23, 28], lookups: [2, 4], quant: [2, 2],
    kinds: ['image'],
    features: { liveTrap: 0, secondLora: 5 },
    behaviors: ['combine', 'loraLookup', 'roundingOrder2', 'liveTrap'],
  },
  {
    tier: 3, min: 30, max: 39,
    steps: [5, 6], params: [28, 33], lookups: [2, 4], quant: [3, 3],
    kinds: ['image'],
    features: { liveTrap: 0, loraLookup: 5 },
    behaviors: ['diff', 'etag', 'roundingOrder2', 'liveTrap'],
  },
  {
    tier: 4, min: 40, max: 49,
    steps: [5, 6], params: [30, 36], lookups: [3, 5], quant: [1, 1],
    kinds: ['image'],
    features: { liveTrap: 0, secondLora: 5 },
    behaviors: ['paginationBatch', 'rateLimit', 'liveTrap'],
  },
  {
    tier: 5, min: 50, max: 59,
    steps: [6, 7], params: [33, 38], lookups: [3, 4], quant: [3, 4],
    kinds: ['image'],
    features: { save: 5 },
    behaviors: ['asyncRender', 'stateMachine', 'roundingOrder2'],
  },
  {
    tier: 6, min: 60, max: 69,
    steps: [8, 8], params: [36, 41], lookups: [4, 4], quant: [4, 4],
    kinds: ['image'],
    features: { save: 0 },
    behaviors: ['tokenExpiry', 'hmacPublish', 'roundingOrder2'],
  },
  {
    tier: 7, min: 70, max: 79,
    steps: [8, 8], params: [38, 44], lookups: [5, 5], quant: [2, 2],
    kinds: ['image'],
    features: { liveTrap: 0, secondLora: 0, secondGrow: 0 },
    behaviors: ['contentNegotiation', 'softDelete', 'liveTrap'],
  },
  {
    tier: 8, min: 80, max: 89,
    steps: [9, 9], params: [41, 47], lookups: [6, 6], quant: [2, 2],
    kinds: ['image'],
    features: { liveTrap: 0, secondLora: 0, secondGrow: 0, thirdLora: 0 },
    behaviors: ['liveTrap'],
  },
  {
    tier: 9, min: 90, max: 99,
    steps: [12, 12], params: [44, 53], lookups: [4, 4], quant: [5, 5],
    kinds: ['image'],
    features: { liveTrap: 0 },
    behaviors: ['everything', 'roundingOrder3', 'liveTrap'],
  },
];

export function bandFor(n) {
  const band = BANDS[Math.floor(n / 10)];
  if (!band) throw new Error(`no band for rung ${n}`);
  return band;
}

// ---------------------------------------------------------------------------
// the seeded project library, recomputed (never persisted) from world alone
// ---------------------------------------------------------------------------

// seedSnapshot(world): the exact store state the live server has immediately after startup,
// before any client request. Ids and descriptors are deterministic; `now` is a fixed dummy value
// since createdAt/updatedAt never feed a descriptor or its hash.
function seedSnapshot(world) {
  const store = createResourceStore();
  seedInitialData(world, store, 0);
  return store;
}

function pickProject(store, r) {
  const pairs = [];
  for (const ws of listWorkspaces(store)) {
    for (const p of listProjects(store, ws.id)) pairs.push({ workspaceId: ws.id, projectId: p.id });
  }
  return pick(r, pairs);
}

// ---------------------------------------------------------------------------
// small value helpers
// ---------------------------------------------------------------------------

function hex2(r) {
  return int(r, 0, 255).toString(16).padStart(2, '0');
}

function randomHexColor(r) {
  return `#${hex2(r)}${hex2(r)}${hex2(r)}`;
}

// ---------------------------------------------------------------------------
// Addendum D geometry floor
//
// media.js's convert() scales shapes by (newWidth/oldWidth, newHeight/oldHeight), and a 'scale'
// lora scales them by a flat amount. Both are applied purely mechanically -- media.js never
// clamps a shape's size, by design (it is a pure function of its inputs). So it is on the
// composer, here, to never *hand* media.js an input whose shrink would collapse a shape below the
// 8px-per-axis floor. Two independent failure modes fed that collapse before this fix:
//
//   1. A canvas created "at physical units and high DPI": makeImageParams used to feed a raw
//      value like 80-300 directly as inches, which pxFromUnit(value, 'in', dpi) turns into tens
//      of thousands of pixels at dpi=300 -- while the shapes drawn on that canvas stayed a fixed
//      5-40px regardless. A later convert to an absolute small target (100-400px) then divides by
//      that huge width, producing a scale factor near zero.
//   2. Even without unit blow-up, a chain of shrinking steps (a convert, then a lora, then
//      another convert) compounds: two 50%-ish shrinks in a row is a 25% shrink overall, and nothing
//      stopped a shape's starting size from being smaller than what the *end* of that chain needs.
//
// The fix is two-sided: unitValueForPx (below) picks the physical magnitude that lands the
// created canvas near the pixel size the plan actually wants (killing failure mode 1), and
// requiredMin/scaleChain (below) work out, from the *exact* scale factors this specific rung's
// plan is about to apply -- known at compose time, since every convert target and lora pick is
// already decided before shapes are drawn -- the smallest starting size that survives every
// prefix of that chain, including the unscaled original (failure mode 2). Nothing here ever
// clamps a shape after the fact; every shape is born big enough to survive its own plan.
// ---------------------------------------------------------------------------

// Inverse of media.js's pxFromUnit, rounded to keep the narrated value short and clean. media.js
// re-derives the pixel width from this value independently (pxFromUnit then roundToGrid), so the
// round-trip only needs to land within a couple of px of pxTarget -- comfortably inside the
// safety buffer requiredMin() adds below -- not hit it exactly.
function unitValueForPx(world, pxTarget, unit) {
  if (unit === undefined) return pxTarget;
  const dpi = world.rules.dpi;
  let raw;
  if (unit === 'in') raw = pxTarget / dpi;
  else if (unit === 'cm') raw = (pxTarget / dpi) * 2.54;
  else raw = (pxTarget / dpi) * 72; // 'pt'
  return Number(raw.toFixed(2));
}

// drawImageCanvas(r, {minPx, maxPx, useUnit}) -> {unit, pxWidth, pxHeight}: picks the pixel
// target a created image's canvas should resolve to, and (if useUnit) the house unit it will be
// expressed in. Composers that need to know the canvas's approximate pixel size *before* drawing
// shapes (anything that will later convert or lora-scale that same image) call this first.
function drawImageCanvas(r, { minPx, maxPx, useUnit }) {
  const unit = useUnit ? pick(r, ['in', 'cm', 'pt']) : undefined;
  const pxWidth = int(r, minPx, maxPx);
  const pxHeight = int(r, minPx, maxPx);
  return { unit, pxWidth, pxHeight };
}

// A scale event this rung's plan will apply, in order, to an image created via makeImageParams:
//   { kind: 'convert', scaleX, scaleY }  -- media.js's convertImage: w/x2 by scaleX, h/y2 by
//                                           scaleY, r by their average
//   { kind: 'loraScale', amount }        -- media.js's applyScale: every axis by the same amount
//
// scaleChain(events, axis) walks the cumulative product for the given axis ('x'|'y'|'r') across
// every prefix of `events`, *including* the empty prefix (cum = 1, i.e. the shape as originally
// drawn, before anything happens to it) -- that is itself one of the states the 8px floor has to
// hold at -- and returns the smallest cumulative value seen. That is the tightest constraint any
// starting size has to survive.
function scaleChain(events, axis) {
  let cum = 1;
  let minCum = 1;
  for (const e of events) {
    const factor = e.kind === 'loraScale'
      ? e.amount
      : axis === 'x' ? e.scaleX : axis === 'y' ? e.scaleY : (e.scaleX + e.scaleY) / 2;
    cum *= factor;
    if (cum < minCum) minCum = cum;
  }
  return minCum;
}

// requiredMin(events, axis, floorPx) -> the smallest starting size on `axis` such that
// size * scaleChain-so-far never drops below floorPx at any prefix of `events`. The buffer
// absorbs the small, known sources of slack between this estimate and what media.js actually
// computes: roundToGrid on each convert's target dimensions, percentOfDims's own rounding, and
// unitValueForPx's 2-decimal-place round-trip -- each worth at most a couple of px, never more
// than `floorPx` itself, so a fixed per-event buffer dominates them with room to spare.
function requiredMin(events, axis, floorPx) {
  const minCum = scaleChain(events, axis);
  // Absolute loss budget, charged BEFORE dividing by the tightest cumulative scale: a 'scale'
  // lora re-quantises every shape dimension onto the house grid, which can be as coarse as 16px
  // and can round DOWN, while a convert only rounds each scaled dimension to the nearest whole
  // pixel. A chain of several of each can therefore lose real pixels on top of the scaling.
  const loss = events.reduce((acc, e) => acc + (e.kind === 'loraScale' ? 16 : 1), 0);
  const buffer = events.length * 3;
  return Math.ceil((floorPx + loss) / minCum) + buffer;
}

// makeImageParams(world, r, {..., pxWidth, pxHeight, unit, minShapeW, minShapeH, minShapeR}):
// pxWidth/pxHeight/unit come from drawImageCanvas (or an equivalent inline draw); minShapeW/H/R
// default to the tier-0 floor (no scaling ever applied) and are overridden with requiredMin(...)
// by any composer whose plan will later shrink this image.
function makeImageParams(world, r, { shapeCount, pxWidth, pxHeight, unit, minShapeW = 8, minShapeH = 8, minShapeR = 4 }) {
  const width = unit !== undefined ? unitValueForPx(world, pxWidth, unit) : pxWidth;
  const height = unit !== undefined ? unitValueForPx(world, pxHeight, unit) : pxHeight;
  const shapes = [];
  for (let i = 0; i < shapeCount; i += 1) {
    const type = pick(r, ['rect', 'circle', 'line']);
    const shape = {
      type,
      x: int(r, 0, Math.max(1, pxWidth - minShapeW)),
      y: int(r, 0, Math.max(1, pxHeight - minShapeH)),
      color: randomHexColor(r),
      opacity: Number((0.5 + r() * 0.5).toFixed(2)),
    };
    if (type === 'rect') {
      shape.w = int(r, minShapeW, minShapeW + 32);
      shape.h = int(r, minShapeH, minShapeH + 32);
    } else if (type === 'circle') {
      shape.r = int(r, minShapeR, minShapeR + 20);
    } else {
      // A line's "each axis" extent is |x2-x| and |y2-y|; both must independently clear the
      // floor (and survive scaleX/scaleY respectively), so draw a signed delta on each axis
      // rather than an unrelated absolute endpoint.
      const dx = int(r, minShapeW, minShapeW + 40) * pick(r, [-1, 1]);
      const dy = int(r, minShapeH, minShapeH + 40) * pick(r, [-1, 1]);
      shape.x2 = shape.x + dx;
      shape.y2 = shape.y + dy;
    }
    if (world.rules.zOrder === 'explicit') shape.z = i;
    shapes.push(shape);
  }
  const params = { width, height, background: { color: randomHexColor(r) }, shapes };
  if (unit !== undefined) params.unit = unit;
  return params;
}

function makeAudioParams(r, { noteCount }) {
  const notes = [];
  let cursor = 0;
  for (let i = 0; i < noteCount; i += 1) {
    const durMs = int(r, 100, 400);
    notes.push({
      freq: int(r, 150, 900),
      startMs: cursor,
      durMs,
      amp: Number((0.4 + r() * 0.6).toFixed(2)),
      wave: pick(r, ['sine', 'square', 'saw', 'triangle']),
    });
    cursor += durMs;
  }
  return { durationMs: cursor + int(r, 50, 200), notes };
}

// safeLoraPool(world): loras a *seeded* asset (one this composer did not draw the geometry for,
// e.g. the project library batchTier pulls from) may safely have applied without a geometry
// check, because they are provably non-shrinking: any op other than 'scale' never touches
// geometry at all, and a 'scale' lora with amount >= 1 only holds size or grows it.
function safeLoraPool(world) {
  const safe = world.loras.filter((l) => l.op !== 'scale' || l.amount >= 1);
  return safe.length > 0 ? safe : world.loras;
}

// ---------------------------------------------------------------------------
// compute + ref resolution (shared verbatim by the local and HTTP interpreters)
// ---------------------------------------------------------------------------

// runCompute(fn, args): args has already had every {$ref} resolved to a concrete value.
export function runCompute(fn, args) {
  if (fn === 'percentOfDims') {
    const { of, percent } = args;
    return { width: Math.max(1, Math.round(of.width * (percent / 100))), height: Math.max(1, Math.round(of.height * (percent / 100))) };
  }
  throw new Error(`unknown compute fn: ${fn}`);
}

// resolveRefs(value, env): deep-walk, replacing {$ref:key, field?} leaves with env.get(key)
// (or that value's .field). env maps resultKey -> whatever runPlanLocally / the HTTP
// interpreter stored there (a descriptor, a descriptor[], or a plain compute value).
export function resolveRefs(value, env) {
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, env));
  if (value !== null && typeof value === 'object') {
    if ('$ref' in value) {
      const base = env.get(value.$ref);
      return value.field !== undefined ? base[value.field] : base;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveRefs(v, env);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// local (pure) interpreter: builds the answer-key descriptors, no HTTP
// ---------------------------------------------------------------------------

function findLora(world, name) {
  const lora = world.loras.find((l) => l.name === name);
  if (!lora) throw new Error(`unknown lora name in plan: ${name}`);
  return lora;
}

// execStep(world, store, env, step) -> the value the step produced (and records it into env under
// step.resultKey). Factored out of runPlanLocally so runPlanLocallyTrace can reuse it to also
// return the value produced after *every* step, not just the last -- which is what the Addendum D
// geometry-floor test walks.
function execStep(world, store, env, step) {
  const args = resolveRefs(step.args, env);
  let value;
  if (step.op === 'create') {
    value = create(world, args.kind, args.params);
  } else if (step.op === 'convert') {
    value = convert(world, env.get(args.from), args.opts);
  } else if (step.op === 'combine') {
    const descs = args.from.flatMap((k) => {
      const v = env.get(k);
      return Array.isArray(v) ? v : [v];
    });
    value = combine(world, descs, args.opts);
  } else if (step.op === 'diff') {
    value = diff(world, env.get(args.a), env.get(args.b));
  } else if (step.op === 'lora') {
    value = applyLora(world, env.get(args.from), findLora(world, args.loraName));
  } else if (step.op === 'batch') {
    const assets = listAssetsForProject(store, args.projectId).slice(0, args.subsetSize);
    value = assets.map((a) => {
      if (args.apply.op === 'lora') return applyLora(world, a.descriptor, findLora(world, args.apply.loraName));
      return convert(world, a.descriptor, args.apply.opts);
    });
  } else if (step.op === 'compute') {
    value = runCompute(args.fn, args);
  } else if (step.op === 'render') {
    value = create(world, args.kind, args.params);
  } else if (step.op === 'publish') {
    value = env.get(args.renderKey);
  } else {
    throw new Error(`unknown op: ${step.op}`);
  }
  env.set(step.resultKey, value);
  return value;
}

// runPlanLocally(world, plan) -> Map(resultKey -> descriptor | descriptor[] | computeValue)
export function runPlanLocally(world, plan) {
  const env = new Map();
  const store = seedSnapshot(world);
  for (const step of plan) execStep(world, store, env, step);
  return env;
}

// runPlanLocallyTrace(world, plan) -> the value produced by each step, in plan order (a
// descriptor, a descriptor[], or a plain compute value). Exists so tests can walk every
// intermediate state a plan passes through -- not just its final submitKey -- which is what the
// Addendum D geometry floor ("after every step") requires checking.
export function runPlanLocallyTrace(world, plan) {
  const env = new Map();
  const store = seedSnapshot(world);
  return plan.map((step) => execStep(world, store, env, step));
}

// ---------------------------------------------------------------------------
// band-parameter interpretation
// ---------------------------------------------------------------------------

// featureAt(band, n, name): is the obligation `name` switched on at rung n? A band is a ramp, not
// a shelf -- `features` maps a name to the first offset inside the band where it turns on, so
// rungs 15-19 can carry an obligation rungs 10-14 do not without either of them being hand-written.
function featureAt(band, n, name) {
  const at = band.features[name];
  return at !== undefined && n - band.min >= at;
}

// shapeCountFor / noteCountFor / subsetFor: spend the band's `params` leaf budget. A canvas costs
// 3 leaves before any shape is drawn on it; a shape or a tone costs 5. A batch rung draws nothing
// itself, so its budget buys library items to work through instead (capped at the 12 a seeded
// project holds).
function spend(band, r, perItem, overhead, cap) {
  const [lo, hi] = band.params;
  const min = Math.max(1, Math.round((lo - overhead) / perItem));
  const max = Math.max(min, Math.round((hi - overhead) / perItem));
  return Math.min(cap, int(r, min, Math.min(cap, max)));
}

function shapeCountFor(band, r) {
  return spend(band, r, 5, 3, 12);
}

function noteCountFor(band, r) {
  return spend(band, r, 5, 0, 12);
}

function subsetFor(band, r) {
  return spend(band, r, 6, 0, 12);
}

// The page a batch rung is told to work in has to be SMALLER than the subset it has to cover, or
// pagination is a word in the task text and nothing in the work. Round 2's batch bands asked for
// four items four at a time, i.e. exactly one page.
function pageSizeFor(band) {
  return band.tier >= 7 ? 2 : 3;
}

// ---------------------------------------------------------------------------
// chains: the shared post-create obligation list
// ---------------------------------------------------------------------------

// A chain is the ordered list of things a rung does to whatever the step before it produced.
// grammar.js turns a chain into plan steps (chainSteps) and rung.js turns the SAME chain into
// task text, so the plan and the prose can never drift apart. Kinds:
//
//   { kind:'lora', name }                  a house-style lookup by display label -- one lookup
//   { kind:'shrink'|'grow', percent, format? }
//                                          percentOfDims then convert: the agent has to read the
//                                          size back off the live descriptor and let the house
//                                          re-round it on the grid -- one quant op
//   { kind:'resize', width, height, format?, scaleX, scaleY }
//                                          convert to an absolute pixel target -- one quant op.
//                                          scaleX/scaleY are carried for the geometry floor only
//                                          and never reach the task text.
//   { kind:'save', format }                convert to a file flavor, size untouched
function chainScaleEvents(world, chain) {
  const events = [];
  for (const s of chain) {
    if (s.kind === 'lora') {
      const lora = findLora(world, s.name);
      if (lora.op === 'scale') events.push({ kind: 'loraScale', amount: lora.amount });
    } else if (s.kind === 'shrink' || s.kind === 'grow') {
      events.push({ kind: 'convert', scaleX: s.percent / 100, scaleY: s.percent / 100 });
    } else if (s.kind === 'resize') {
      events.push({ kind: 'convert', scaleX: s.scaleX, scaleY: s.scaleY });
    }
  }
  return events;
}

// chainSteps(chain, fromKey, prefix) -> {steps, lastKey}: the plan steps the chain expands to,
// each one feeding the next. Result keys are prefixed so a chain can be spliced into any plan
// without colliding with the keys that plan already uses.
function chainSteps(chain, fromKey, prefix) {
  const steps = [];
  let cur = fromKey;
  chain.forEach((s, i) => {
    const key = `${prefix}${i}`;
    if (s.kind === 'lora') {
      steps.push({ op: 'lora', resultKey: key, args: { from: cur, loraName: s.name } });
    } else if (s.kind === 'save') {
      steps.push({ op: 'convert', resultKey: key, args: { from: cur, opts: { format: s.format } } });
    } else if (s.kind === 'resize') {
      const opts = { width: s.width, height: s.height };
      if (s.format !== undefined) opts.format = s.format;
      steps.push({ op: 'convert', resultKey: key, args: { from: cur, opts } });
    } else {
      const dimsKey = `${key}dims`;
      steps.push({ op: 'compute', resultKey: dimsKey, args: { fn: 'percentOfDims', of: { $ref: cur }, percent: s.percent } });
      const opts = { width: { $ref: dimsKey, field: 'width' }, height: { $ref: dimsKey, field: 'height' } };
      if (s.format !== undefined) opts.format = s.format;
      steps.push({ op: 'convert', resultKey: key, args: { from: cur, opts } });
    }
    cur = key;
  });
  return { steps, lastKey: cur };
}

// canvasPxRange(events, base): the created canvas has to survive the chain the shapes on it do.
// percentOfDims floors a dimension at 1px and the grid rounding can then round that 1 DOWN to 0,
// which would divide every shape on the canvas by zero. Start big enough that the tightest
// cumulative scale in the chain still leaves a comfortable canvas at the far end.
function canvasPxRange(events, base) {
  const minCum = Math.min(scaleChain(events, 'x'), scaleChain(events, 'y'));
  const minPx = Math.max(base, Math.ceil(96 / minCum));
  return { minPx, maxPx: minPx * 2 };
}

// shapeFloors(events): the three minShape* overrides makeImageParams takes, for a canvas whose
// shapes are about to go through `events`.
function shapeFloors(events) {
  return {
    minShapeW: requiredMin(events, 'x', 8),
    minShapeH: requiredMin(events, 'y', 8),
    minShapeR: requiredMin(events, 'r', 4),
  };
}

const SHRINK_PERCENT = [55, 85];
const GROW_PERCENT = [120, 180];

// ---------------------------------------------------------------------------
// per-tier composers
// ---------------------------------------------------------------------------

function tier0(world, r, band) {
  const kind = pick(r, band.kinds);
  let params;
  if (kind === 'image') {
    const { unit, pxWidth, pxHeight } = drawImageCanvas(r, { minPx: 40, maxPx: 200, useUnit: r() < 0.5 });
    params = makeImageParams(world, r, { shapeCount: shapeCountFor(band, r), pxWidth, pxHeight, unit });
  } else {
    params = makeAudioParams(r, { noteCount: noteCountFor(band, r) });
  }
  const plan = [{ op: 'create', resultKey: 'final', args: { kind, params } }];
  return { plan, submitKey: 'final', narrative: { tier: 0, kind, params } };
}

function tier1(world, r, band, n) {
  const kind = pick(r, band.kinds);
  if (kind === 'audio') {
    // Two converts rather than one: the flavor change and the re-cut are separate rounds, so the
    // agent has to chain a call onto the id the previous call handed back.
    const params = makeAudioParams(r, { noteCount: noteCountFor(band, r) });
    const format = pick(r, ['wav', 'qa8']);
    const sampleRate = pick(r, [22050, 44100, 48000]);
    const plan = [
      { op: 'create', resultKey: 'a', args: { kind, params } },
      { op: 'convert', resultKey: 'b', args: { from: 'a', opts: { format } } },
      { op: 'convert', resultKey: 'final', args: { from: 'b', opts: { sampleRate } } },
    ];
    return { plan, submitKey: 'final', narrative: { tier: 1, kind, params, format, sampleRate } };
  }
  const lora = pick(r, world.loras);
  const format = pick(r, ['svg', 'png']);
  let chain;
  let canvas;
  if (featureAt(band, n, 'percentRound')) {
    // Rungs 15-19: the target size is a percent of a size the agent has to read off the live
    // descriptor, so the house's grid rounding lands twice -- once on the created canvas, once
    // on the resize -- instead of once.
    chain = [{ kind: 'lora', name: lora.name }, { kind: 'shrink', percent: int(r, ...SHRINK_PERCENT), format }];
    canvas = drawImageCanvas(r, { ...canvasPxRange(chainScaleEvents(world, chain), 120), useUnit: true });
  } else {
    canvas = drawImageCanvas(r, { minPx: 120, maxPx: 320, useUnit: true });
    const width = int(r, 120, 400);
    const height = int(r, 120, 400);
    chain = [
      { kind: 'lora', name: lora.name },
      { kind: 'resize', width, height, format, scaleX: width / canvas.pxWidth, scaleY: height / canvas.pxHeight },
    ];
  }
  const events = chainScaleEvents(world, chain);
  const params = makeImageParams(world, r, {
    shapeCount: shapeCountFor(band, r),
    pxWidth: canvas.pxWidth,
    pxHeight: canvas.pxHeight,
    unit: canvas.unit,
    ...shapeFloors(events),
  });
  const { steps, lastKey } = chainSteps(chain, 'a', 'c');
  const plan = [{ op: 'create', resultKey: 'a', args: { kind: 'image', params } }, ...steps];
  return {
    plan,
    submitKey: lastKey,
    narrative: { tier: 1, kind: 'image', params, chain, liveTrap: featureAt(band, n, 'liveTrap') },
  };
}

function tier2(world, r, band, n) {
  const format = pick(r, ['svg', 'png']);
  const chain = [
    { kind: 'lora', name: pick(r, world.loras).name },
    { kind: 'shrink', percent: int(r, ...SHRINK_PERCENT), format },
  ];
  if (featureAt(band, n, 'secondLora')) chain.push({ kind: 'lora', name: pick(r, world.loras).name });
  const events = chainScaleEvents(world, chain);
  const canvas = drawImageCanvas(r, { ...canvasPxRange(events, 140), useUnit: true });
  const params = makeImageParams(world, r, {
    shapeCount: shapeCountFor(band, r),
    pxWidth: canvas.pxWidth,
    pxHeight: canvas.pxHeight,
    unit: canvas.unit,
    ...shapeFloors(events),
  });
  const { steps, lastKey } = chainSteps(chain, 'a', 'c');
  const plan = [{ op: 'create', resultKey: 'a', args: { kind: 'image', params } }, ...steps];
  return { plan, submitKey: lastKey, narrative: { tier: 2, params, chain, liveTrap: featureAt(band, n, 'liveTrap') } };
}

function tier3(world, r, band, n) {
  const format = pick(r, ['svg', 'png']);
  // Only the FIRST picture's shapes survive a diff (it is a set difference of the primitive
  // lists), so only the first one carries the chain's scale events; the second is drawn at the
  // unscaled floor.
  const chain = [{ kind: 'shrink', percent: int(r, ...SHRINK_PERCENT), format }];
  if (featureAt(band, n, 'loraLookup')) chain.push({ kind: 'lora', name: pick(r, world.loras).name });
  const events = chainScaleEvents(world, chain);
  const shapeCount = shapeCountFor(band, r);
  const ca = drawImageCanvas(r, { ...canvasPxRange(events, 140), useUnit: true });
  const paramsA = makeImageParams(world, r, {
    shapeCount,
    pxWidth: ca.pxWidth,
    pxHeight: ca.pxHeight,
    unit: ca.unit,
    ...shapeFloors(events),
  });
  const cb = drawImageCanvas(r, { minPx: 140, maxPx: 320, useUnit: true });
  const paramsB = makeImageParams(world, r, {
    shapeCount: Math.max(1, shapeCount - 1),
    pxWidth: cb.pxWidth,
    pxHeight: cb.pxHeight,
    unit: cb.unit,
  });
  const { steps, lastKey } = chainSteps(chain, 'd', 'c');
  const plan = [
    { op: 'create', resultKey: 'a', args: { kind: 'image', params: paramsA } },
    { op: 'create', resultKey: 'b', args: { kind: 'image', params: paramsB } },
    { op: 'diff', resultKey: 'd', args: { a: 'a', b: 'b', verifyEtag: true } },
    ...steps,
  ];
  return {
    plan,
    submitKey: lastKey,
    narrative: { tier: 3, kind: 'image', paramsA, paramsB, chain, liveTrap: featureAt(band, n, 'liveTrap') },
  };
}

function batchTier(world, r, band, n, { withSideChecks }) {
  const store = seedSnapshot(world);
  const { workspaceId, projectId } = pickProject(store, r);
  // The batch's items come from the seeded library, not from a create() this composer controls
  // the geometry of -- so every style it applies comes from safeLoraPool, and every resize in the
  // chain only ever grows. Neither can drop a shape through the 8px floor.
  const pool = safeLoraPool(world);
  const applyLoraName = pick(r, pool).name;
  const subsetSize = subsetFor(band, r);
  const pageSize = pageSizeFor(band);
  const combineOpts = { mode: 'layer', opacityStep: Number((0.85 + r() * 0.1).toFixed(2)) };
  const chain = [
    { kind: 'lora', name: pick(r, pool).name },
    { kind: 'grow', percent: int(r, ...GROW_PERCENT) },
  ];
  if (featureAt(band, n, 'secondLora')) chain.push({ kind: 'lora', name: pick(r, pool).name });
  if (featureAt(band, n, 'secondGrow')) chain.push({ kind: 'grow', percent: int(r, ...GROW_PERCENT) });
  if (featureAt(band, n, 'thirdLora')) chain.push({ kind: 'lora', name: pick(r, pool).name });
  const { steps, lastKey } = chainSteps(chain, 'combined', 'c');
  const plan = [
    {
      op: 'batch',
      resultKey: 'batched',
      args: {
        workspaceId,
        projectId,
        subsetSize,
        pageSize,
        apply: { op: 'lora', loraName: applyLoraName },
        sideChecks: withSideChecks ? { csv: true, softDelete: true } : undefined,
      },
    },
    { op: 'combine', resultKey: 'combined', args: { from: ['batched'], opts: combineOpts } },
    ...steps,
  ];
  return {
    plan,
    submitKey: lastKey,
    narrative: {
      workspaceId,
      projectId,
      // Human-visible labels, so the task text can point at one project without handing over an
      // id: the agent still has to list and match. Ids are opaque and never appear in rung text.
      workspaceLabel: store.workspaces.get(workspaceId).name,
      projectLabel: store.projects.get(projectId).name,
      applyLoraName,
      combineOpts,
      subsetSize,
      pageSize,
      chain,
      liveTrap: featureAt(band, n, 'liveTrap'),
    },
  };
}

function tier4(world, r, band, n) {
  const { plan, submitKey, narrative } = batchTier(world, r, band, n, { withSideChecks: false });
  return { plan, submitKey, narrative: { tier: 4, ...narrative } };
}

function renderTier(world, r, band, n, { withPublish }) {
  const store = seedSnapshot(world);
  const workspace = pick(r, listWorkspaces(store));
  const workspaceId = workspace.id;
  const format = pick(r, ['svg', 'png']);
  // Round 2's render bands were a single call whose whole difficulty was the state machine. The
  // chain keeps the state machine and hangs the rounding ladder off the far end of it.
  const chain = [
    { kind: 'shrink', percent: int(r, ...SHRINK_PERCENT) },
    { kind: 'lora', name: pick(r, world.loras).name },
    { kind: 'shrink', percent: int(r, ...SHRINK_PERCENT) },
  ];
  if (featureAt(band, n, 'save')) chain.push({ kind: 'save', format });
  const events = chainScaleEvents(world, chain);
  const canvas = drawImageCanvas(r, { ...canvasPxRange(events, 160), useUnit: true });
  const params = makeImageParams(world, r, {
    shapeCount: shapeCountFor(band, r),
    pxWidth: canvas.pxWidth,
    pxHeight: canvas.pxHeight,
    unit: canvas.unit,
    ...shapeFloors(events),
  });
  const plan = [{ op: 'render', resultKey: 'rendered', args: { kind: 'image', params, workspaceId } }];
  if (withPublish) plan.push({ op: 'publish', resultKey: 'published', args: { renderKey: 'rendered' } });
  const { steps, lastKey } = chainSteps(chain, 'rendered', 'c');
  plan.push(...steps);
  return {
    plan,
    submitKey: lastKey,
    narrative: { kind: 'image', params, workspaceId, workspaceLabel: workspace.name, withPublish, chain },
  };
}

function tier5(world, r, band, n) {
  const { plan, submitKey, narrative } = renderTier(world, r, band, n, { withPublish: false });
  return { plan, submitKey, narrative: { tier: 5, ...narrative } };
}

function tier6(world, r, band, n) {
  const { plan, submitKey, narrative } = renderTier(world, r, band, n, { withPublish: true });
  return { plan, submitKey, narrative: { tier: 6, ...narrative } };
}

function tier7(world, r, band, n) {
  const { plan, submitKey, narrative } = batchTier(world, r, band, n, { withSideChecks: true });
  return { plan, submitKey, narrative: { tier: 7, ...narrative } };
}

function tier8(world, r, band, n) {
  const { plan, submitKey, narrative } = batchTier(world, r, band, n, { withSideChecks: true });
  return { plan, submitKey, narrative: { tier: 8, ...narrative } };
}

function tier9(world, r, band, n) {
  const format = pick(r, ['svg', 'png']);
  const scaleLora = world.loras.find((l) => l.op === 'scale');
  // Three shrinks with two style lookups wedged between them, then one growth and a flavor
  // change: the "rounding order 3" behaviour, with every intermediate size read back off a live
  // descriptor rather than carried forward from arithmetic the agent did in its head.
  const chain = [
    { kind: 'shrink', percent: int(r, ...SHRINK_PERCENT) },
    { kind: 'lora', name: (scaleLora ?? pick(r, world.loras)).name },
    { kind: 'shrink', percent: int(r, ...SHRINK_PERCENT) },
    { kind: 'lora', name: pick(r, world.loras).name },
    { kind: 'shrink', percent: int(r, ...SHRINK_PERCENT) },
    { kind: 'grow', percent: int(r, ...GROW_PERCENT) },
    { kind: 'save', format },
  ];
  const events = chainScaleEvents(world, chain);
  const canvas = drawImageCanvas(r, { ...canvasPxRange(events, 200), useUnit: true });
  const params = makeImageParams(world, r, {
    shapeCount: shapeCountFor(band, r),
    pxWidth: canvas.pxWidth,
    pxHeight: canvas.pxHeight,
    unit: canvas.unit,
    ...shapeFloors(events),
  });
  const { steps, lastKey } = chainSteps(chain, 'a', 'c');
  const plan = [{ op: 'create', resultKey: 'a', args: { kind: 'image', params } }, ...steps];
  return { plan, submitKey: lastKey, narrative: { tier: 9, params, chain, liveTrap: featureAt(band, n, 'liveTrap') } };
}

const TIER_COMPOSERS = [tier0, tier1, tier2, tier3, tier4, tier5, tier6, tier7, tier8, tier9];

// composePlan(world, n) -> { plan, submitKey, narrative }. `plan` is exactly what
// runPlanLocally and the HTTP interpreter both execute.
export function composePlan(world, n) {
  const band = bandFor(n);
  const r = rng(sub(world.seed, `rung:${n}`));
  const result = TIER_COMPOSERS[band.tier](world, r, band, n);
  return { ...result, band };
}
