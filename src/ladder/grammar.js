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

function makeImageParams(world, r, { shapeCount, minDim, maxDim, useUnit }) {
  const unit = useUnit ? pick(r, ['in', 'cm', 'pt']) : undefined;
  const width = int(r, minDim, maxDim);
  const height = int(r, minDim, maxDim);
  const shapes = [];
  for (let i = 0; i < shapeCount; i += 1) {
    const type = pick(r, ['rect', 'circle', 'line']);
    const shape = {
      type,
      x: int(r, 0, Math.max(1, width - 10)),
      y: int(r, 0, Math.max(1, height - 10)),
      color: randomHexColor(r),
      opacity: Number((0.5 + r() * 0.5).toFixed(2)),
    };
    if (type === 'rect') {
      shape.w = int(r, 5, 40);
      shape.h = int(r, 5, 40);
    } else if (type === 'circle') {
      shape.r = int(r, 5, 25);
    } else {
      shape.x2 = int(r, 0, width);
      shape.y2 = int(r, 0, height);
    }
    if (world.rules.zOrder === 'explicit') shape.z = i;
    shapes.push(shape);
  }
  const params = { width, height, background: { color: randomHexColor(r) }, shapes };
  if (unit) params.unit = unit;
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

// runPlanLocally(world, plan) -> Map(resultKey -> descriptor | descriptor[] | computeValue)
export function runPlanLocally(world, plan) {
  const env = new Map();
  const store = seedSnapshot(world);
  for (const step of plan) {
    const args = resolveRefs(step.args, env);
    if (step.op === 'create') {
      env.set(step.resultKey, create(world, args.kind, args.params));
    } else if (step.op === 'convert') {
      env.set(step.resultKey, convert(world, env.get(args.from), args.opts));
    } else if (step.op === 'combine') {
      const descs = args.from.flatMap((k) => {
        const v = env.get(k);
        return Array.isArray(v) ? v : [v];
      });
      env.set(step.resultKey, combine(world, descs, args.opts));
    } else if (step.op === 'diff') {
      env.set(step.resultKey, diff(world, env.get(args.a), env.get(args.b)));
    } else if (step.op === 'lora') {
      const lora = findLora(world, args.loraName);
      env.set(step.resultKey, applyLora(world, env.get(args.from), lora));
    } else if (step.op === 'batch') {
      const assets = listAssetsForProject(store, args.projectId).slice(0, args.subsetSize);
      const out = assets.map((a) => {
        if (args.apply.op === 'lora') return applyLora(world, a.descriptor, findLora(world, args.apply.loraName));
        return convert(world, a.descriptor, args.apply.opts);
      });
      env.set(step.resultKey, out);
    } else if (step.op === 'compute') {
      env.set(step.resultKey, runCompute(args.fn, args));
    } else if (step.op === 'render') {
      env.set(step.resultKey, create(world, args.kind, args.params));
    } else if (step.op === 'publish') {
      env.set(step.resultKey, env.get(args.renderKey));
    } else {
      throw new Error(`unknown op: ${step.op}`);
    }
  }
  return env;
}

// ---------------------------------------------------------------------------
// per-tier composers
// ---------------------------------------------------------------------------

function tier0(world, r) {
  const kind = pick(r, ['image', 'audio']);
  const params = kind === 'image'
    ? makeImageParams(world, r, { shapeCount: int(r, 1, 2), minDim: 40, maxDim: 200, useUnit: r() < 0.5 })
    : makeAudioParams(r, { noteCount: int(r, 1, 2) });
  const plan = [{ op: 'create', resultKey: 'final', args: { kind, params } }];
  return { plan, submitKey: 'final', narrative: { tier: 0, kind, params } };
}

function tier1(world, r) {
  const kind = pick(r, ['image', 'audio']);
  const params = kind === 'image'
    ? makeImageParams(world, r, { shapeCount: int(r, 2, 3), minDim: 80, maxDim: 300, useUnit: true })
    : makeAudioParams(r, { noteCount: int(r, 2, 3) });
  const opts = kind === 'image'
    ? { format: pick(r, ['svg', 'png']), width: int(r, 100, 400), height: int(r, 100, 400) }
    : { format: pick(r, ['wav', 'qa8']), sampleRate: pick(r, [22050, 44100, 48000]) };
  const plan = [
    { op: 'create', resultKey: 'a', args: { kind, params } },
    { op: 'convert', resultKey: 'final', args: { from: 'a', opts } },
  ];
  return { plan, submitKey: 'final', narrative: { tier: 1, kind, params, opts } };
}

function tier2(world, r) {
  const params = makeImageParams(world, r, { shapeCount: int(r, 2, 4), minDim: 100, maxDim: 300, useUnit: true });
  const lora = pick(r, world.loras);
  const opts = { format: pick(r, ['svg', 'png']), width: int(r, 100, 400), height: int(r, 100, 400) };
  const plan = [
    { op: 'create', resultKey: 'a', args: { kind: 'image', params } },
    { op: 'lora', resultKey: 'b', args: { from: 'a', loraName: lora.name } },
    { op: 'convert', resultKey: 'final', args: { from: 'b', opts } },
  ];
  return { plan, submitKey: 'final', narrative: { tier: 2, params, loraName: lora.name, opts } };
}

function tier3(world, r) {
  const kind = pick(r, ['image', 'audio']);
  const paramsA = kind === 'image'
    ? makeImageParams(world, r, { shapeCount: int(r, 2, 4), minDim: 100, maxDim: 300, useUnit: false })
    : makeAudioParams(r, { noteCount: int(r, 2, 4) });
  const paramsB = kind === 'image'
    ? makeImageParams(world, r, { shapeCount: int(r, 1, 3), minDim: 100, maxDim: 300, useUnit: false })
    : makeAudioParams(r, { noteCount: int(r, 1, 3) });
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
  const applyLoraName = pick(r, world.loras).name;
  const finalLora = pick(r, world.loras).name;
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
  const params = kind === 'image'
    ? makeImageParams(world, r, { shapeCount: int(r, 2, 4), minDim: 100, maxDim: 300, useUnit: true })
    : makeAudioParams(r, { noteCount: int(r, 2, 4) });
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
  const params = makeImageParams(world, r, { shapeCount: int(r, 2, 4), minDim: 200, maxDim: 400, useUnit: true });
  const percent = int(r, 40, 75);
  const scaleLora = world.loras.find((l) => l.op === 'scale');
  const plan = [
    { op: 'create', resultKey: 'a', args: { kind: 'image', params } },
    { op: 'compute', resultKey: 'dims', args: { fn: 'percentOfDims', of: { $ref: 'a' }, percent } },
    {
      op: 'convert',
      resultKey: 'b',
      args: { from: 'a', opts: { width: { $ref: 'dims', field: 'width' }, height: { $ref: 'dims', field: 'height' } } },
    },
  ];
  let percent2;
  if (scaleLora) {
    plan.push({ op: 'lora', resultKey: 'final', args: { from: 'b', loraName: scaleLora.name } });
  } else {
    percent2 = int(r, 40, 75);
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
