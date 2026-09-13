// The reference solution: executes a Rung's plan over real HTTP against a running instance, and
// the admin answer-key payload the harness posts before any model (or this module) starts.
// A rung the reference cannot pass is a generator bug, per ARCHITECTURE.md -- this file is the
// gate, not a fixture.

import { createHmac } from 'node:crypto';

import { routes } from '../routes.js';
import { resolvePath, fieldName } from '../world.js';
import { renderImage } from '../render/image.js';
import { renderAudio } from '../render/audio.js';
import { hashArtifact } from '../canon.js';
import { makeRung } from './rung.js';
import { runCompute, resolveRefs, recallValue } from './grammar.js';

// ---------------------------------------------------------------------------
// answer key
// ---------------------------------------------------------------------------

function hashDescriptorLocal(desc) {
  const bytes = desc.kind === 'image' ? renderImage(desc) : renderAudio(desc);
  return hashArtifact(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes);
}

// answerKey(world) -> the admin payload for POST /admin/rungs: every rung's text, its expected
// hashes (hash(render(expectedDescriptor)), the only thing the judge compares), and the
// descriptors themselves (used by the API to also report fidelity on a fail).
export function answerKey(world) {
  const rungs = [];
  for (let n = 0; n < 100; n += 1) {
    const rung = makeRung(world, n);
    rungs.push({
      n,
      text: rung.text,
      expected: rung.expectedDescriptors.map(hashDescriptorLocal),
      expectedDescriptors: rung.expectedDescriptors,
    });
  }
  return { rungs };
}

// ---------------------------------------------------------------------------
// tiny HTTP client: auth lifecycle, 401 refresh, 429 backoff
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pathFor(world, routeId, params = {}) {
  const route = routes.find((r) => r.id === routeId);
  if (!route) throw new Error(`unknown route id: ${routeId}`);
  let p = resolvePath(world, route.path);
  for (const [k, v] of Object.entries(params)) p = p.replace(`{${k}}`, encodeURIComponent(String(v)));
  return p;
}

function F(world, snakeName) {
  return fieldName(world, snakeName);
}

function createClient(world, baseUrl, apiKey) {
  return { world, baseUrl, apiKey, access: null, refresh: null };
}

async function getFreshToken(ctx) {
  const body = {};
  body[F(ctx.world, 'api_key')] = ctx.apiKey;
  const res = await fetch(`${ctx.baseUrl}/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`auth/token failed: ${res.status}`);
  const json = await res.json();
  ctx.access = json[F(ctx.world, 'access_token')];
  ctx.refresh = json[F(ctx.world, 'refresh_token')];
}

async function refreshOrReauth(ctx) {
  if (!ctx.refresh) return getFreshToken(ctx);
  const body = {};
  body[F(ctx.world, 'refresh_token')] = ctx.refresh;
  const res = await fetch(`${ctx.baseUrl}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    await getFreshToken(ctx);
    return;
  }
  const json = await res.json();
  ctx.access = json[F(ctx.world, 'access_token')];
  ctx.refresh = json[F(ctx.world, 'refresh_token')];
}

// request(): the one place that talks to the network. Transparently refreshes on 401 and backs
// off on 429 using Retry-After, then retries -- both invisible to every op handler below.
async function request(ctx, method, path, { body, headers = {} } = {}) {
  if (!ctx.access) await getFreshToken(ctx);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(`${ctx.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${ctx.access}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      // eslint-disable-next-line no-await-in-loop
      await refreshOrReauth(ctx);
      continue;
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') || '1') || 1;
      // eslint-disable-next-line no-await-in-loop
      await sleep(retryAfter * 1000);
      continue;
    }
    return res;
  }
  throw new Error(`giving up on ${method} ${path} after repeated 401/429`);
}

async function requestJson(ctx, method, path, opts) {
  const res = await request(ctx, method, path, opts);
  if (!res.ok && res.status !== 304) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  }
  if (res.status === 204 || res.status === 304) return { status: res.status, body: null, headers: res.headers };
  const body = await res.json();
  return { status: res.status, body, headers: res.headers };
}

// ---------------------------------------------------------------------------
// op handlers
// ---------------------------------------------------------------------------

const CREATE_ROUTE = { image: 'images.create', audio: 'audio.create', video: 'video.create' };

async function createAssetHttp(ctx, kind, params, idemKey) {
  const routeId = CREATE_ROUTE[kind];
  if (routeId === undefined) throw new Error(`no create route for kind ${kind}`);
  const { body } = await requestJson(ctx, 'POST', pathFor(ctx.world, routeId), {
    body: params,
    headers: { 'Idempotency-Key': idemKey },
  });
  return { id: body.id, descriptor: body.descriptor };
}

async function httpLookupLora(ctx, name) {
  const path = `${pathFor(ctx.world, 'loras.list')}?name=${encodeURIComponent(name)}`;
  const { body } = await requestJson(ctx, 'GET', path);
  const item = body.data[0];
  if (!item) throw new Error(`lora not found by name: ${name}`);
  return item.id;
}

async function httpApplyLora(ctx, assetId, loraName, loraIdCache) {
  const loraId = loraIdCache?.get(loraName) ?? (await httpLookupLora(ctx, loraName));
  loraIdCache?.set(loraName, loraId);
  const path = pathFor(ctx.world, 'assets.lora', { asset_id: assetId });
  const body = { [F(ctx.world, 'lora_id')]: loraId };
  const { body: resBody } = await requestJson(ctx, 'POST', path, { body });
  return { id: resBody.id, descriptor: resBody.descriptor };
}

async function httpListAllAssets(ctx, workspaceId, projectId, pageSize) {
  const items = [];
  let cursor;
  for (;;) {
    const base = pathFor(ctx.world, 'projects.assets', { workspace_id: workspaceId, project_id: projectId });
    const qs = new URLSearchParams({ page_size: String(pageSize) });
    if (cursor) qs.set('cursor', cursor);
    // eslint-disable-next-line no-await-in-loop
    const { body } = await requestJson(ctx, 'GET', `${base}?${qs.toString()}`);
    items.push(...body.data);
    if (body.cursor === undefined) break;
    cursor = body.cursor;
  }
  return items;
}

async function httpBatch(ctx, args) {
  const items = await httpListAllAssets(ctx, args.workspaceId, args.projectId, args.pageSize);
  const subset = items.slice(0, args.subsetSize);
  const out = [];
  const loraIdCache = new Map();
  for (const item of subset) {
    if (args.apply.op === 'lora') {
      // eslint-disable-next-line no-await-in-loop
      out.push(await httpApplyLora(ctx, item.id, args.apply.loraName, loraIdCache));
    } else {
      const path = pathFor(ctx.world, 'assets.convert', { asset_id: item.id });
      // eslint-disable-next-line no-await-in-loop
      const { body } = await requestJson(ctx, 'POST', path, { body: args.apply.opts });
      out.push({ id: body.id, descriptor: body.descriptor });
    }
  }
  if (args.sideChecks && args.sideChecks.csv) {
    // Content negotiation: the same listing, asked for as a spreadsheet instead of the usual
    // reply. Nothing downstream reads it -- the point is that the call happens and succeeds.
    const base = pathFor(ctx.world, 'projects.assets', { workspace_id: args.workspaceId, project_id: args.projectId });
    await request(ctx, 'GET', `${base}?page_size=100`, { headers: { accept: 'text/csv' } });
  }
  return out;
}

async function httpRender(ctx, args, resultKey, projectsMap, idemPrefix) {
  const asset = await createAssetHttp(ctx, args.kind, args.params, `${idemPrefix}-${resultKey}-create`);
  const wsId = args.workspaceId;
  const projBody = { [F(ctx.world, 'name')]: `render-${idemPrefix}-${resultKey}` };
  const { body: proj } = await requestJson(ctx, 'POST', pathFor(ctx.world, 'projects.create', { workspace_id: wsId }), {
    body: projBody,
    headers: { 'Idempotency-Key': `${idemPrefix}-${resultKey}-project` },
  });
  const projectId = proj.id;
  if (args.recover409) {
    // Addendum J rule 4: at least one 409 recovery per rung from 50 up. Reaching for the
    // finishing run before the project is locked in is refused; take the refusal and carry on.
    await request(ctx, 'POST', pathFor(ctx.world, 'projects.render', { workspace_id: wsId, project_id: projectId }));
  }
  const composeBody = { [F(ctx.world, 'asset_ids')]: [asset.id] };
  await requestJson(ctx, 'POST', pathFor(ctx.world, 'projects.compose', { workspace_id: wsId, project_id: projectId }), {
    body: composeBody,
  });
  const { body: renderBody } = await requestJson(
    ctx,
    'POST',
    pathFor(ctx.world, 'projects.render', { workspace_id: wsId, project_id: projectId }),
  );
  const jobId = renderBody[F(ctx.world, 'job_id')];
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { body: jobBody } = await requestJson(ctx, 'GET', pathFor(ctx.world, 'jobs.get', { job_id: jobId }));
    if (jobBody.status === 'done') break;
  }
  projectsMap.set(resultKey, { workspaceId: wsId, projectId });
  return asset;
}

async function httpPublish(ctx, args, projectsMap) {
  const target = projectsMap.get(args.renderKey);
  if (!target) throw new Error(`publish: no render context for ${args.renderKey}`);
  const path = pathFor(ctx.world, 'projects.publish', { workspace_id: target.workspaceId, project_id: target.projectId });
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = createHmac(ctx.world.hmac.algo, ctx.world.auth.secret).update(`${ts}POST${path}`).digest('hex');
  await requestJson(ctx, 'POST', path, {
    headers: { [ctx.world.hmac.tsHeader]: ts, [ctx.world.hmac.header]: signature },
  });
}

// httpListCount(ctx, args, copyIds): Addendum J rule 2's most literal derived parameter. Clear
// the last few of THIS rung's own copies out, confirm the clear-out took (gone from the ordinary
// listing, still there when the cleared-out ones are asked for), then walk every page of the
// listing and count how many of this rung's copies are still standing. Scoped to this rung's own
// copies so the number is a pure function of this rung and not of whatever ran before it.
async function httpListCount(ctx, args, copyIds) {
  const victims = args.deleteCount > 0 ? copyIds.slice(copyIds.length - args.deleteCount) : [];
  for (const id of victims) {
    // eslint-disable-next-line no-await-in-loop
    await request(ctx, 'DELETE', pathFor(ctx.world, 'assets.delete', { asset_id: id }));
  }
  const base = pathFor(ctx.world, 'projects.assets', { workspace_id: args.workspaceId, project_id: args.projectId });
  const live = await httpListAllAssets(ctx, args.workspaceId, args.projectId, args.pageSize);
  const liveIds = new Set(live.map((a) => a.id));
  // the confirming half of the obligation: the cleared-out ones come back when asked for
  await request(ctx, 'GET', `${base}?page_size=100&include_deleted=true`);
  return copyIds.filter((id) => liveIds.has(id)).length;
}

// httpEtag(ctx, args, assetId): Addendum J rule 4's conditional update. Read the tag, prove the
// house refuses a stale one, then write with the fresh one. Metadata only: the descriptor and so
// the hash are untouched, which is why this can sit in a plan whose key never sees a server.
async function httpEtag(ctx, args, assetId) {
  const path = pathFor(ctx.world, 'assets.get', { asset_id: assetId });
  const { body } = await requestJson(ctx, 'GET', path);
  const patchPath = pathFor(ctx.world, 'assets.patch', { asset_id: assetId });
  const patchBody = { [F(ctx.world, 'display_name')]: args.label };
  await request(ctx, 'PATCH', patchPath, { body: patchBody, headers: { 'if-match': '"stale-etag"' } });
  await requestJson(ctx, 'PATCH', patchPath, { body: patchBody, headers: { 'if-match': body.etag } });
}

// execPlanHttp(ctx, plan, n) -> {env, ids}: mirrors grammar.js's runPlanLocally op-for-op, but
// each op is a real HTTP call. `env` collects descriptors (for compute-step $refs), `ids`
// collects the asset ids those descriptors live at on the server (what actually gets submitted).
// `n` (the rung number) is folded into every Idempotency-Key: resultKey names ('a', 'final', ...)
// repeat across rungs, and the idempotency store is keyed only by (token, route, key), so without
// `n` the second rung to reuse a name would silently get back the FIRST rung's cached asset.
async function execPlanHttp(ctx, plan, n, history) {
  const env = new Map();
  const ids = new Map();
  const projects = new Map();
  const idemPrefix = `idem-${n}`;
  for (const step of plan) {
    // `ids` is threaded in so a {$assetRef: key} leaf (video clips, and nothing else) resolves to
    // the real server id rather than the answer key's local placeholder.
    const args = resolveRefs(step.args, env, ids);
    if (step.op === 'create') {
      // eslint-disable-next-line no-await-in-loop
      const result = await createAssetHttp(ctx, args.kind, args.params, `${idemPrefix}-${step.resultKey}`);
      env.set(step.resultKey, result.descriptor);
      ids.set(step.resultKey, result.id);
    } else if (step.op === 'convert') {
      const path = pathFor(ctx.world, 'assets.convert', { asset_id: ids.get(args.from) });
      // eslint-disable-next-line no-await-in-loop
      const { body } = await requestJson(ctx, 'POST', path, { body: args.opts });
      env.set(step.resultKey, body.descriptor);
      ids.set(step.resultKey, body.id);
    } else if (step.op === 'combine') {
      const idList = args.from.flatMap((k) => {
        const v = ids.get(k);
        return Array.isArray(v) ? v : [v];
      });
      const reqBody = { ids: idList, mode: args.opts.mode };
      if (args.opts.opacityStep !== undefined) reqBody[F(ctx.world, 'opacity_step')] = args.opts.opacityStep;
      // eslint-disable-next-line no-await-in-loop
      const { body } = await requestJson(ctx, 'POST', pathFor(ctx.world, 'assets.combine'), { body: reqBody });
      env.set(step.resultKey, body.descriptor);
      ids.set(step.resultKey, body.id);
    } else if (step.op === 'diff') {
      // eslint-disable-next-line no-await-in-loop
      const { body } = await requestJson(ctx, 'POST', pathFor(ctx.world, 'assets.diff'), {
        body: { a: ids.get(args.a), b: ids.get(args.b) },
      });
      env.set(step.resultKey, body.descriptor);
      ids.set(step.resultKey, body.id);
      if (args.verifyEtag) {
        const aId = ids.get(args.a);
        // eslint-disable-next-line no-await-in-loop
        const first = await requestJson(ctx, 'GET', pathFor(ctx.world, 'assets.get', { asset_id: aId }));
        // eslint-disable-next-line no-await-in-loop
        await requestJson(ctx, 'GET', pathFor(ctx.world, 'assets.get', { asset_id: aId }), {
          headers: { 'if-none-match': first.body.etag },
        });
      }
    } else if (step.op === 'lora') {
      // eslint-disable-next-line no-await-in-loop
      const result = await httpApplyLora(ctx, ids.get(args.from), args.loraName);
      env.set(step.resultKey, result.descriptor);
      ids.set(step.resultKey, result.id);
    } else if (step.op === 'batch') {
      // eslint-disable-next-line no-await-in-loop
      const out = await httpBatch(ctx, args);
      env.set(step.resultKey, out.map((o) => o.descriptor));
      ids.set(step.resultKey, out.map((o) => o.id));
    } else if (step.op === 'compute') {
      env.set(step.resultKey, runCompute(ctx.world, args.fn, args));
    } else if (step.op === 'render') {
      // eslint-disable-next-line no-await-in-loop
      const result = await httpRender(ctx, args, step.resultKey, projects, idemPrefix);
      env.set(step.resultKey, result.descriptor);
      ids.set(step.resultKey, result.id);
    } else if (step.op === 'publish') {
      // eslint-disable-next-line no-await-in-loop
      await httpPublish(ctx, args, projects);
      env.set(step.resultKey, env.get(args.renderKey));
      ids.set(step.resultKey, ids.get(args.renderKey));
    } else if (step.op === 'recall') {
      // Addendum J rule 1: the reference resolves a cross-rung reference out of its OWN history
      // of what it turned in, exactly as the agent is expected to resolve it out of its
      // collection on disk. The local recomputation is the fallback for a partial climb
      // (`--from 40`) where the earlier rung was never actually run in this process; the two
      // agree by construction, since both are pure functions of (world, fromRung).
      const remembered = history && history.get(args.fromRung);
      const desc = remembered !== undefined ? remembered : null;
      let value;
      if (desc !== null) {
        value = args.field === 'dims' ? { width: desc.width, height: desc.height } : desc.background.color;
      } else {
        value = recallValue(ctx.world, args.fromRung, args.field);
      }
      env.set(step.resultKey, value);
    } else if (step.op === 'listCount') {
      // eslint-disable-next-line no-await-in-loop
      env.set(step.resultKey, await httpListCount(ctx, args, ids.get(args.subsetKey)));
    } else if (step.op === 'etag') {
      // eslint-disable-next-line no-await-in-loop
      await httpEtag(ctx, args, ids.get(args.from));
      env.set(step.resultKey, env.get(args.from));
      ids.set(step.resultKey, ids.get(args.from));
    } else {
      throw new Error(`unknown op: ${step.op}`);
    }
  }
  return { env, ids };
}

// ---------------------------------------------------------------------------
// climb
// ---------------------------------------------------------------------------

// climb({world, baseUrl, apiKey, adminBaseUrl, adminToken, from, to, log}) ->
//   {passed:[n...], failed:[{n, reason}...]}.
//
// Executes each rung's plan for real, over HTTP, and submits the resulting asset id(s). Every
// composer in grammar.js makes its plan's *last* step the one to submit, so that convention (not
// re-deriving the plan) is all climb needs to know what to hand to /rungs/{n}/submit.
//
// Two things it does beyond executing plans:
//
//   * It keeps a history of the descriptor it turned in at each rung, so Addendum J rule 1's
//     cross-rung references resolve out of the climb's own past rather than out of a
//     recomputation -- the same memory the agent is expected to keep, kept the same way.
//   * When `adminBaseUrl` is given it advances the admin-side current rung in step with itself,
//     so Addendum J rule 3's announced mutation for rung n is LIVE for the whole of rung n. A
//     rung the reference cannot pass with its own announced mutation applied is a generator bug,
//     and without this the gate would never see one.
export async function climb({ world, baseUrl, apiKey, adminBaseUrl, adminToken, from = 0, to = 99, log }) {
  const ctx = createClient(world, baseUrl, apiKey);
  const passed = [];
  const failed = [];
  const history = new Map();
  let adminCurrent = 0;
  const advanceTo = async (n) => {
    if (!adminBaseUrl) return;
    while (adminCurrent < n) {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(`${adminBaseUrl}/admin/rungs/advance`, {
        method: 'POST',
        // Addendum J admin hardening: the admin port is gated by a per-run secret whenever the
        // harness sets one. The reference is inside the harness, so it is allowed to hold it.
        headers: adminToken ? { 'X-Admin-Token': adminToken } : {},
      });
      if (!res.ok) throw new Error(`admin advance -> ${res.status}`);
      adminCurrent += 1;
    }
  };
  for (let n = from; n <= to; n += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await advanceTo(n);
      const rung = makeRung(world, n);
      // eslint-disable-next-line no-await-in-loop
      const { env, ids } = await execPlanHttp(ctx, rung.plan, n, history);
      const lastKey = rung.plan[rung.plan.length - 1].resultKey;
      const submitId = ids.get(lastKey);
      history.set(n, env.get(lastKey));
      const reqBody = { assets: [submitId] };
      const path = pathFor(world, 'rungs.submit', { n: String(n) });
      // eslint-disable-next-line no-await-in-loop
      const { body } = await requestJson(ctx, 'POST', path, { body: reqBody });
      if (body.pass) {
        passed.push(n);
      } else {
        failed.push({ n, reason: 'submit returned pass:false' });
      }
      if (log) log({ n, pass: body.pass });
    } catch (err) {
      failed.push({ n, reason: err.message });
      if (log) log({ n, pass: false, error: err.message });
    }
  }
  return { passed, failed };
}
