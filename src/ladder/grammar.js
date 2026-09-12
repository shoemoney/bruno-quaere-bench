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

export const BANDS = [
  { tier: 0, min: 0, max: 9, steps: [1, 1], params: [3, 6], lookups: [0, 1], quant: [0, 1], behaviors: ['auth', 'create'] },
  { tier: 1, min: 10, max: 19, steps: [2, 2], params: [6, 10], lookups: [1, 2], quant: [1, 2], behaviors: ['convert', 'idempotency'] },
  { tier: 2, min: 20, max: 29, steps: [3, 3], params: [8, 12], lookups: [2, 2], quant: [2, 2], behaviors: ['combine', 'loraLookup'] },
  { tier: 3, min: 30, max: 39, steps: [3, 4], params: [10, 14], lookups: [2, 3], quant: [2, 3], behaviors: ['diff', 'etag'] },
  { tier: 4, min: 40, max: 49, steps: [4, 5], params: [12, 16], lookups: [3, 3], quant: [3, 3], behaviors: ['paginationBatch', 'rateLimit'] },
  { tier: 5, min: 50, max: 59, steps: [5, 5], params: [14, 18], lookups: [3, 4], quant: [3, 4], behaviors: ['asyncRender', 'stateMachine'] },
  { tier: 6, min: 60, max: 69, steps: [5, 6], params: [16, 20], lookups: [4, 4], quant: [4, 4], behaviors: ['tokenExpiry', 'hmacPublish'] },
  { tier: 7, min: 70, max: 79, steps: [6, 7], params: [18, 22], lookups: [4, 5], quant: [5, 5], behaviors: ['contentNegotiation', 'softDelete'] },
  { tier: 8, min: 80, max: 89, steps: [7, 8], params: [20, 24], lookups: [5, 5], quant: [5, 6], behaviors: ['liveTrap'] },
  { tier: 9, min: 90, max: 99, steps: [8, 10], params: [22, 28], lookups: [5, 6], quant: [6, 7], behaviors: ['everything', 'roundingOrder3'] },
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
  const buffer = events.length * 3;
  return Math.ceil(floorPx / minCum) + buffer;
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
// per-tier composers
// ---------------------------------------------------------------------------

function tier0(world, r) {
  const kind = pick(r, ['image', 'audio']);
  let params;
  if (kind === 'image') {
    const { unit, pxWidth, pxHeight } = drawImageCanvas(r, { minPx: 40, maxPx: 200, useUnit: r() < 0.5 });
    params = makeImageParams(world, r, { shapeCount: int(r, 1, 2), pxWidth, pxHeight, unit });
  } else {
    params = makeAudioParams(r, { noteCount: int(r, 1, 2) });
  }
  const plan = [{ op: 'create', resultKey: 'final', args: { kind, params } }];
  return { plan, submitKey: 'final', narrative: { tier: 0, kind, params } };
}

function tier1(world, r) {
  const kind = pick(r, ['image', 'audio']);
  if (kind === 'audio') {
    const params = makeAudioParams(r, { noteCount: int(r, 2, 3) });
    const opts = { format: pick(r, ['wav', 'qa8']), sampleRate: pick(r, [22050, 44100, 48000]) };
    const plan = [
      { op: 'create', resultKey: 'a', args: { kind, params } },
      { op: 'convert', resultKey: 'final', args: { from: 'a', opts } },
    ];
    return { plan, submitKey: 'final', narrative: { tier: 1, kind, params, opts } };
  }
  // Image path: the convert target is drawn *before* the shapes, so the exact scale factor this
  // convert will apply is known up front and shapes are born big enough to survive it.
  const { unit, pxWidth, pxHeight } = drawImageCanvas(r, { minPx: 80, maxPx: 300, useUnit: true });
  const optsWidth = int(r, 100, 400);
  const optsHeight = int(r, 100, 400);
  const events = [{ kind: 'convert', scaleX: optsWidth / pxWidth, scaleY: optsHeight / pxHeight }];
  const params = makeImageParams(world, r, {
    shapeCount: int(r, 2, 3),
    pxWidth,
    pxHeight,
    unit,
    minShapeW: requiredMin(events, 'x', 8),
    minShapeH: requiredMin(events, 'y', 8),
    minShapeR: requiredMin(events, 'r', 4),
  });
  const opts = { format: pick(r, ['svg', 'png']), width: optsWidth, height: optsHeight };
  const plan = [
    { op: 'create', resultKey: 'a', args: { kind: 'image', params } },
    { op: 'convert', resultKey: 'final', args: { from: 'a', opts } },
  ];
  return { plan, submitKey: 'final', narrative: { tier: 1, kind: 'image', params, opts } };
}

function tier2(world, r) {
  const { unit, pxWidth, pxHeight } = drawImageCanvas(r, { minPx: 100, maxPx: 300, useUnit: true });
  const lora = pick(r, world.loras);
  const optsWidth = int(r, 100, 400);
  const optsHeight = int(r, 100, 400);
  // Order matters: the plan applies the lora, *then* converts, so the chain has to reflect that
  // order for the "smallest cumulative prefix" logic in scaleChain to hold.
  const events = [];
  if (lora.op === 'scale') events.push({ kind: 'loraScale', amount: lora.amount });
  events.push({ kind: 'convert', scaleX: optsWidth / pxWidth, scaleY: optsHeight / pxHeight });
  const params = makeImageParams(world, r, {
    shapeCount: int(r, 2, 4),
    pxWidth,
    pxHeight,
    unit,
    minShapeW: requiredMin(events, 'x', 8),
    minShapeH: requiredMin(events, 'y', 8),
    minShapeR: requiredMin(events, 'r', 4),
  });
  const opts = { format: pick(r, ['svg', 'png']), width: optsWidth, height: optsHeight };
  const plan = [
    { op: 'create', resultKey: 'a', args: { kind: 'image', params } },
    { op: 'lora', resultKey: 'b', args: { from: 'a', loraName: lora.name } },
    { op: 'convert', resultKey: 'final', args: { from: 'b', opts } },
  ];
  return { plan, submitKey: 'final', narrative: { tier: 2, params, loraName: lora.name, opts } };
}

function tier3(world, r) {
  const kind = pick(r, ['image', 'audio']);
  let paramsA;
  let paramsB;
  if (kind === 'image') {
    // diff never scales anything -- it is a pure set difference of the primitive lists -- so
    // these two images carry no downstream scale events and use the tier-0 floor.
    const a = drawImageCanvas(r, { minPx: 100, maxPx: 300, useUnit: false });
    paramsA = makeImageParams(world, r, { shapeCount: int(r, 2, 4), pxWidth: a.pxWidth, pxHeight: a.pxHeight, unit: a.unit });
    const b = drawImageCanvas(r, { minPx: 100, maxPx: 300, useUnit: false });
    paramsB = makeImageParams(world, r, { shapeCount: int(r, 1, 3), pxWidth: b.pxWidth, pxHeight: b.pxHeight, unit: b.unit });
  } else {
    paramsA = makeAudioParams(r, { noteCount: int(r, 2, 4) });
    paramsB = makeAudioParams(r, { noteCount: int(r, 1, 3) });
  }
  const plan = [
    { op: 'create', resultKey: 'a', args: { kind, params: paramsA } },
    { op: 'create', resultKey: 'b', args: { kind, params: paramsB } },
    { op: 'diff', resultKey: 'final', args: { a: 'a', b: 'b', verifyEtag: true } },
  ];
  return { plan, submitKey: 'final', narrative: { tier: 3, kind, paramsA, paramsB } };
}

function batchTier(world, r, { subsetSize, pageSize, withSideChecks }) {
  const store = seedSnapshot(world);
  const { workspaceId, projectId } = pickProject(store, r);
  // The batch's assets come from the seeded project library, not from a create() this composer
  // controls the geometry of -- so instead of computing a survival size, only ever pick loras
  // that provably cannot shrink them (see safeLoraPool).
  const pool = safeLoraPool(world);
  const applyLoraName = pick(r, pool).name;
  const finalLora = pick(r, pool).name;
  const combineOpts = { mode: 'layer', opacityStep: Number((0.85 + r() * 0.1).toFixed(2)) };
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
    { op: 'lora', resultKey: 'final', args: { from: 'combined', loraName: finalLora } },
  ];
  return {
    plan,
    submitKey: 'final',
    narrative: {
      workspaceId,
      projectId,
      // Human-visible labels, so the task text can point at one project without handing over an
      // id: the agent still has to list and match. Ids are opaque and never appear in rung text.
      workspaceLabel: store.workspaces.get(workspaceId).name,
      projectLabel: store.projects.get(projectId).name,
      applyLoraName,
      finalLora,
      combineOpts,
      subsetSize,
      pageSize,
    },
  };
}

function tier4(world, r) {
  const { plan, submitKey, narrative } = batchTier(world, r, { subsetSize: 4, pageSize: 4, withSideChecks: false });
  return { plan, submitKey, narrative: { tier: 4, ...narrative } };
}

function renderTier(world, r, { withPublish }) {
  const store = seedSnapshot(world);
  const workspace = pick(r, listWorkspaces(store));
  const workspaceId = workspace.id;
  const kind = pick(r, ['image', 'audio']);
  // render (and publish, which just signs off on the same render) never scale the asset, so no
  // downstream scale events -- the tier-0 floor applies as-is.
  let params;
  if (kind === 'image') {
    const { unit, pxWidth, pxHeight } = drawImageCanvas(r, { minPx: 100, maxPx: 300, useUnit: true });
    params = makeImageParams(world, r, { shapeCount: int(r, 2, 4), pxWidth, pxHeight, unit });
  } else {
    params = makeAudioParams(r, { noteCount: int(r, 2, 4) });
  }
  const plan = [{ op: 'render', resultKey: 'rendered', args: { kind, params, workspaceId } }];
  let submitKey = 'rendered';
  if (withPublish) {
    plan.push({ op: 'publish', resultKey: 'published', args: { renderKey: 'rendered' } });
    submitKey = 'published';
  }
  return { plan, submitKey, narrative: { kind, params, workspaceId, workspaceLabel: workspace.name, withPublish } };
}

function tier5(world, r) {
  const { plan, submitKey, narrative } = renderTier(world, r, { withPublish: false });
  return { plan, submitKey, narrative: { tier: 5, ...narrative } };
}

function tier6(world, r) {
  const { plan, submitKey, narrative } = renderTier(world, r, { withPublish: true });
  return { plan, submitKey, narrative: { tier: 6, ...narrative } };
}

function tier7(world, r) {
  const { plan, submitKey, narrative } = batchTier(world, r, { subsetSize: 4, pageSize: 4, withSideChecks: true });
  return { plan, submitKey, narrative: { tier: 7, ...narrative } };
}

function tier8(world, r) {
  const { plan, submitKey, narrative } = batchTier(world, r, { subsetSize: 6, pageSize: 4, withSideChecks: true });
  return { plan, submitKey, narrative: { tier: 8, ...narrative } };
}

function tier9(world, r) {
  const { unit, pxWidth, pxHeight } = drawImageCanvas(r, { minPx: 200, maxPx: 400, useUnit: true });
  const percent = int(r, 40, 75);
  const scaleLora = world.loras.find((l) => l.op === 'scale');
  // Two shrinking steps in a row is the case the addendum calls out by name -- work out the
  // exact combined chain (percent, then either the known scale-lora amount or a second percent)
  // before drawing any shapes.
  const events = [{ kind: 'convert', scaleX: percent / 100, scaleY: percent / 100 }];
  let percent2;
  if (scaleLora) {
    events.push({ kind: 'loraScale', amount: scaleLora.amount });
  } else {
    percent2 = int(r, 40, 75);
    events.push({ kind: 'convert', scaleX: percent2 / 100, scaleY: percent2 / 100 });
  }
  const params = makeImageParams(world, r, {
    shapeCount: int(r, 2, 4),
    pxWidth,
    pxHeight,
    unit,
    minShapeW: requiredMin(events, 'x', 8),
    minShapeH: requiredMin(events, 'y', 8),
    minShapeR: requiredMin(events, 'r', 4),
  });
  const plan = [
    { op: 'create', resultKey: 'a', args: { kind: 'image', params } },
    { op: 'compute', resultKey: 'dims', args: { fn: 'percentOfDims', of: { $ref: 'a' }, percent } },
    {
      op: 'convert',
      resultKey: 'b',
      args: { from: 'a', opts: { width: { $ref: 'dims', field: 'width' }, height: { $ref: 'dims', field: 'height' } } },
    },
  ];
  if (scaleLora) {
    plan.push({ op: 'lora', resultKey: 'final', args: { from: 'b', loraName: scaleLora.name } });
  } else {
    plan.push({ op: 'compute', resultKey: 'dims2', args: { fn: 'percentOfDims', of: { $ref: 'b' }, percent: percent2 } });
    plan.push({
      op: 'convert',
      resultKey: 'final',
      args: { from: 'b', opts: { width: { $ref: 'dims2', field: 'width' }, height: { $ref: 'dims2', field: 'height' } } },
    });
  }
  return { plan, submitKey: 'final', narrative: { tier: 9, params, percent, percent2, scaleLoraName: scaleLora?.name } };
}

const TIER_COMPOSERS = [tier0, tier1, tier2, tier3, tier4, tier5, tier6, tier7, tier8, tier9];

// composePlan(world, n) -> { plan, submitKey, narrative }. `plan` is exactly what
// runPlanLocally and the HTTP interpreter both execute.
export function composePlan(world, n) {
  const band = bandFor(n);
  const r = rng(sub(world.seed, `rung:${n}`));
  const result = TIER_COMPOSERS[band.tier](world, r);
  return { ...result, band };
}
