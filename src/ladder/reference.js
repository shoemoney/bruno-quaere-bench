// The reference solution: executes a Rung's plan over real HTTP against a running instance, and
// the admin answer-key payload the harness posts before any model (or this module) starts.
// A rung the reference cannot pass is a generator bug, per ARCHITECTURE.md -- this file is the
// gate, not a fixture.

import { createHmac } from 'node:crypto';

import { routes } from '../routes.js';
import { resolvePath, fieldName, rulesAt } from '../world.js';
import { canonicalString } from '../hmac.js';
import { renderImage } from '../render/image.js';
import { renderAudio } from '../render/audio.js';
import { hashArtifact } from '../canon.js';
import { makeRung } from './rung.js';
import { runCompute, resolveRefs, recallValue, composePlan, runPlanLocally } from './grammar.js';

// recallFallbackResolver(world) -> (fromRung, field) -> value. The OPT-IN escape hatch for a
// climb that starts mid-ladder (`--from 40`) and so cannot possibly remember what rung 12 turned
// in. It recomputes the earlier rung's submitted descriptor locally, which is exactly what the
// 0.5.x climb path did silently -- and exactly why an unretrievable cross-rung value was never
// detected (Addendum O finding 4). It is never wired in by default: a caller has to name it.
export function recallFallbackResolver(world) {
  return (fromRung, field) => recallValue(world, fromRung, field);
}

// ---------------------------------------------------------------------------
// answer key
// ---------------------------------------------------------------------------

function hashDescriptorLocal(desc) {
  const bytes = desc.kind === 'image' ? renderImage(desc) : renderAudio(desc);
  return hashArtifact(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes);
}

// answerKey(world) -> the admin payload for POST /admin/rungs: every rung's text, its expected
// hashes (hash(render(expectedDescriptor)), the only thing the judge compared through 0.5.x), the
// descriptors themselves (used by the API to also report fidelity on a fail), and -- new in
// 0.6.0, Addendum O -- the two things beside the hash a rung's own text demanded and nothing
// graded: the project state the submitted asset must have reached, and the label it must carry.
// The full shape is written out once, at the top of src/ladder/rung.js.
export function answerKey(world) {
  const rungs = [];
  for (let n = 0; n < 100; n += 1) {
    const rung = makeRung(world, n);
    rungs.push({
      n,
      text: rung.text,
      expected: rung.expectedDescriptors.map(hashDescriptorLocal),
      expectedDescriptors: rung.expectedDescriptors,
      expectedProjectState: rung.expectedProjectState,
      expectedLabel: rung.expectedLabel,
      // Addendum Q rules 10, 7 and 4. Additive; the full shape is written out once, at the top
      // of src/ladder/rung.js, which is the ladder <-> API contract for all three.
      expectedAudit: rung.expectedAudit,
      forbidden: rung.forbidden,
      amendments: rung.amendments,
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

// ---------------------------------------------------------------------------
// Addendum Q rule 2: reading a reply that has moved under you
//
// 0.7.0's announced mutations land on the fields a solver's parse is load-bearing on -- a create's
// `id` renamed, a convert's `descriptor.width` retyped to a string, a combine's `descriptor.shapes`
// handed back as a count, a render's `job_id` dropped. Rule 27 still holds: the artifact never
// changes, only the parse. So the reference does what a correct client has to do -- check what it
// actually got, and go and ask again by another route when the reply it was handed is not usable.
// It never asks which mutation is live; it only ever looks at the value in its hand.
// ---------------------------------------------------------------------------

// The id of a freshly made thing, whatever the reply decided to call it this rung.
function idOf(body) {
  if (body === null || typeof body !== 'object') return undefined;
  for (const key of ['id', 'uid', 'assetId', 'asset_id']) {
    if (typeof body[key] === 'string') return body[key];
  }
  return undefined;
}

const NUMERIC_DESCRIPTOR_FIELDS = ['width', 'height', 'durationMs', 'fps', 'sampleRate'];
const LIST_DESCRIPTOR_FIELDS = ['shapes', 'notes', 'clips'];

// A descriptor is USABLE when every number reads as a number and every list reads as a list. A
// retyped number is repairable in place (the value is still there, wearing a string); a list
// handed back as a count has genuinely lost its contents and can only be fetched again.
function repairDescriptor(desc) {
  if (desc === null || typeof desc !== 'object') return { desc, usable: false };
  const out = { ...desc };
  for (const f of NUMERIC_DESCRIPTOR_FIELDS) {
    if (typeof out[f] === 'string' && out[f].trim() !== '' && Number.isFinite(Number(out[f]))) out[f] = Number(out[f]);
  }
  const usable = LIST_DESCRIPTOR_FIELDS.every((f) => out[f] === undefined || Array.isArray(out[f]));
  return { desc: out, usable };
}

// descriptorFor(ctx, body, assetId): the descriptor of the thing that reply is about, fetched
// again from `assets.get` when the reply's own copy came back unusable. One mutation is live per
// rung, so a reply damaged on a write route reads clean on the read route and the other way round.
async function descriptorFor(ctx, body, assetId) {
  const first = repairDescriptor(body && body.descriptor);
  if (first.usable) return first.desc;
  if (assetId === undefined) throw new Error('descriptor came back unusable and there is no id to ask about');
  const { body: fresh } = await requestJson(ctx, 'GET', pathFor(ctx.world, 'assets.get', { asset_id: assetId }));
  const second = repairDescriptor(fresh && fresh.descriptor);
  if (!second.usable) throw new Error(`descriptor for ${assetId} is unusable from both the write reply and assets.get`);
  return second.desc;
}

// created(ctx, body): the {id, descriptor} pair every write route is supposed to hand back, read
// defensively.
async function created(ctx, body) {
  const id = idOf(body);
  if (id === undefined) throw new Error('a write reply carried no id under any name this house uses');
  return { id, descriptor: await descriptorFor(ctx, body, id) };
}

const CREATE_ROUTE = { image: 'images.create', audio: 'audio.create', video: 'video.create' };

async function createAssetHttp(ctx, kind, params, idemKey) {
  const routeId = CREATE_ROUTE[kind];
  if (routeId === undefined) throw new Error(`no create route for kind ${kind}`);
  const { body } = await requestJson(ctx, 'POST', pathFor(ctx.world, routeId), {
    body: params,
    headers: { 'Idempotency-Key': idemKey },
  });
  return created(ctx, body);
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
  return created(ctx, resBody);
}

// ---------------------------------------------------------------------------
// Addendum Q rules 3 and 9: the next page is a header, and a short page is not the end
// ---------------------------------------------------------------------------

// The listing's next cursor lives ONLY in `Link: <path?cursor=...>; rel="next"` -- there is no
// body field to read any more, and a client that looks for one silently stops after page one and
// undercounts every derived number that comes off a listing. The Link carries the whole next
// request, including whatever the cursor query param is called on this rung (a live `renameField`
// may have renamed it), so following it verbatim is both the simplest and the only
// mutation-proof way to page.
function nextPageFrom(headers) {
  const link = headers.get('link');
  if (!link) return undefined;
  const m = /<([^>]+)>\s*;\s*rel="next"/i.exec(link);
  return m ? m[1] : undefined;
}

// Rule 9: a page shorter than the one asked for is NOT the end of the listing -- the house meters
// the listing route on its own tighter bucket and answers inside the throttle window with a short
// page rather than an error. Only the absence of a next link ends the walk. (The 429 that the
// same bucket produces past the grace window is handled once, in `request`, off `Retry-After`.)
const MAX_PAGES = 400;

async function httpListAllAssets(ctx, workspaceId, projectId, pageSize, extra = {}) {
  const base = pathFor(ctx.world, 'projects.assets', { workspace_id: workspaceId, project_id: projectId });
  const qs = new URLSearchParams({ page_size: String(pageSize), ...extra });
  const items = [];
  let path = `${base}?${qs.toString()}`;
  for (let page = 0; page < MAX_PAGES && path !== undefined; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { body, headers } = await requestJson(ctx, 'GET', path);
    items.push(...body.data);
    const next = nextPageFrom(headers);
    // a listing that hands back the page it just gave is a stuck cursor, not progress
    path = next === path ? undefined : next;
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
      // eslint-disable-next-line no-await-in-loop
      out.push(await created(ctx, body));
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

// Addendum Q rule 10, "grade the path": the reference records the ordered stage sequence it
// actually walked, and `climb` compares it against the sequence the key demands. Through 0.6.0
// the state machine, the 409 recovery and the release were six mechanisms of work that nothing
// looked at; this is the check that looks.
async function httpRender(ctx, args, resultKey, projectsMap, idemPrefix, audit) {
  const asset = await createAssetHttp(ctx, args.kind, args.params, `${idemPrefix}-${resultKey}-create`);
  const wsId = args.workspaceId;
  const projBody = { [F(ctx.world, 'name')]: `render-${idemPrefix}-${resultKey}` };
  const { body: proj } = await requestJson(ctx, 'POST', pathFor(ctx.world, 'projects.create', { workspace_id: wsId }), {
    body: projBody,
    headers: { 'Idempotency-Key': `${idemPrefix}-${resultKey}-project` },
  });
  const projectId = proj.id;
  if (audit) audit.push('draft');
  if (args.recover409) {
    // Addendum J rule 4: at least one 409 recovery per rung from 50 up. Reaching for the
    // finishing run before the project is locked in is refused; take the refusal and carry on.
    const refused = await request(ctx, 'POST', pathFor(ctx.world, 'projects.render', { workspace_id: wsId, project_id: projectId }));
    if (audit) audit.push(refused.status === 409 ? 'render:409' : `render:${refused.status}`);
  }
  const composeBody = { [F(ctx.world, 'asset_ids')]: [asset.id] };
  await requestJson(ctx, 'POST', pathFor(ctx.world, 'projects.compose', { workspace_id: wsId, project_id: projectId }), {
    body: composeBody,
  });
  if (audit) audit.push('composed');
  const { body: renderBody } = await requestJson(
    ctx,
    'POST',
    pathFor(ctx.world, 'projects.render', { workspace_id: wsId, project_id: projectId }),
  );
  // Addendum Q rule 2 again: the finishing run's job id is one of the announced drop targets, and
  // a reply without it is not a reply without a finishing run. The fallback asks the PROJECT how
  // it is getting on instead of polling a job by an id nobody handed over.
  const jobId = renderBody[F(ctx.world, 'job_id')] ?? renderBody.jobId ?? renderBody.job;
  if (audit) audit.push('rendering');
  const projectPath = pathFor(ctx.world, 'projects.get', { workspace_id: wsId, project_id: projectId });
  for (let i = 0; i < 8; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { body: seen } = jobId !== undefined
      ? await requestJson(ctx, 'GET', pathFor(ctx.world, 'jobs.get', { job_id: jobId }))
      : await requestJson(ctx, 'GET', projectPath);
    const state = String(seen.status ?? '');
    if (state === 'done' || state === 'rendered' || state === 'published') {
      if (audit) audit.push('rendered');
      break;
    }
  }
  projectsMap.set(resultKey, { workspaceId: wsId, projectId });
  return asset;
}

// ---------------------------------------------------------------------------
// Addendum Q rule 10: the release signature binds a digest of what is being released
// ---------------------------------------------------------------------------

// The one implementation lives in src/hmac.js, where the house (src/api/behaviors.js) and the
// written reference (src/skill.js) reach it without importing the answer key. Re-exported here
// because the ladder's own callers and tests have always found it at this name.
export { canonicalString } from '../hmac.js';

// signPublish(world, {ts, method, path, bodyDigest}) -> hex signature.
export function signPublish(world, parts) {
  return createHmac(world.hmac.algo, world.auth.secret)
    .update(canonicalString(world.hmac.canon, parts))
    .digest('hex');
}

// bodyDigestFor(ctx, assetId): sha256 of the artifact bytes the house actually holds for that
// asset -- fetched, never recomputed locally, because the whole point of binding it is that the
// value can only come from a live response.
async function bodyDigestFor(ctx, assetId) {
  const res = await request(ctx, 'GET', pathFor(ctx.world, 'assets.content', { asset_id: assetId }));
  if (!res.ok) throw new Error(`assets.content -> ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return hashArtifact(bytes);
}

async function httpPublish(ctx, args, projectsMap, assetId, audit) {
  const target = projectsMap.get(args.renderKey);
  if (!target) throw new Error(`publish: no render context for ${args.renderKey}`);
  const path = pathFor(ctx.world, 'projects.publish', { workspace_id: target.workspaceId, project_id: target.projectId });
  const ts = String(Math.floor(Date.now() / 1000));
  const bodyDigest = assetId !== undefined ? await bodyDigestFor(ctx, assetId) : undefined;
  const signature = signPublish(ctx.world, { ts, method: 'POST', path, bodyDigest });
  const headers = { [ctx.world.hmac.tsHeader]: ts, [ctx.world.hmac.header]: signature };
  // The digest travels as its own header so the house can check the client computed it rather
  // than guessed it. Harmless to a house that does not read it yet.
  if (bodyDigest !== undefined) headers['X-Body-Digest'] = bodyDigest;
  await requestJson(ctx, 'POST', path, { headers });
  if (audit) audit.push('published');
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
  const live = await httpListAllAssets(ctx, args.workspaceId, args.projectId, args.pageSize);
  const liveIds = new Set(live.map((a) => a.id));
  // the confirming half of the obligation: the cleared-out ones come back when asked for
  await httpListAllAssets(ctx, args.workspaceId, args.projectId, 100, { include_deleted: 'true' });
  return { count: copyIds.filter((id) => liveIds.has(id)).length, victims };
}

// ---------------------------------------------------------------------------
// Addendum Q rule 7: the reference HONOURS the refusal
//
// A refusal rung's plan does not contain the forbidden step, so simply executing the plan is the
// correct reading and the reference passes by construction. `performForbidden` exists so
// test/refusal.test.js can prove the other half: a climb that DOES the forbidden thing is caught
// and the rung fails. Without that, "the reference honours the refusal" is unfalsifiable -- the
// same trap Addendum O found in the recall fallback.
// ---------------------------------------------------------------------------

// -> how many forbidden artifacts or states actually came into existence. The house is a second
// line of defence and sometimes wins on its own: `assets.lora` 404s a soft-deleted asset and
// `assets.convert` refuses one too, so neither cleared-copy act can actually be carried out by a
// caller that tries. `labelTheStack` is the one the house permits -- a PATCH of a display name is
// legal on any live asset -- so it is the act that can really be violated, the violation is
// invisible in the submitted hash (a label never touches a descriptor), and it is the one
// test/refusal.test.js drives. All three stay in the pool: the variety is the anti-template value,
// and RULES-0.9 rules 29 and 30 forbid all three regardless of which the house happens to catch.
async function performForbiddenAct(ctx, forbidden, { victims, ids }) {
  let created = 0;
  if (forbidden.act === 'labelTheStack' || forbidden.act === 'labelTheLeftover') {
    // Addendum U: labelTheLeftover targets whichever intermediate the rung named (tier 5's
    // converted diff result, tier 6's stitched clip) instead of the batch tiers' `combined`.
    const target = ids.get(forbidden.act === 'labelTheStack' ? 'combined' : forbidden.targetKey);
    if (target === undefined) return 0;
    const path = pathFor(ctx.world, 'assets.patch', { asset_id: target });
    // Addendum Q rule 3: ETag travels only in the response header now, never the body.
    const got = await requestJson(ctx, 'GET', pathFor(ctx.world, 'assets.get', { asset_id: target }));
    const res = await request(ctx, 'PATCH', path, {
      body: { [F(ctx.world, 'display_name')]: forbidden.word },
      headers: { 'if-match': got.headers.get('etag') },
    });
    return res.ok ? 1 : 0;
  }
  for (const id of victims) {
    let res;
    if (forbidden.act === 'workOnClearedCopies') {
      const path = pathFor(ctx.world, 'assets.lora', { asset_id: id });
      // eslint-disable-next-line no-await-in-loop
      const loraId = await httpLookupLora(ctx, ctx.forbiddenStyleName);
      // eslint-disable-next-line no-await-in-loop
      res = await request(ctx, 'POST', path, { body: { [F(ctx.world, 'lora_id')]: loraId } });
    } else if (forbidden.act === 'reflavourClearedCopies') {
      // eslint-disable-next-line no-await-in-loop
      res = await request(ctx, 'POST', pathFor(ctx.world, 'assets.convert', { asset_id: id }), { body: { format: 'png' } });
    } else {
      throw new Error(`reference has no way to perform forbidden act "${forbidden.act}"`);
    }
    if (res.ok) created += 1;
  }
  return created;
}

// httpEtag(ctx, args, assetId): Addendum J rule 4's conditional update. Read the tag, prove the
// house refuses a stale one, then write with the fresh one. Metadata only: the descriptor and so
// the hash are untouched, which is why this can sit in a plan whose key never sees a server.
//
// Addendum Q rule 3: the tag lives ONLY in the `ETag` response header now, never as a body field,
// so it is read off the headers with the body's own `etag` kept as a fallback for an older house.
async function httpEtag(ctx, args, assetId) {
  const path = pathFor(ctx.world, 'assets.get', { asset_id: assetId });
  const { body, headers } = await requestJson(ctx, 'GET', path);
  const tag = headers.get('etag') ?? (body && body.etag);
  if (!tag) throw new Error(`no ETag for ${assetId}, in the header or the body`);
  const patchPath = pathFor(ctx.world, 'assets.patch', { asset_id: assetId });
  const patchBody = { [F(ctx.world, 'display_name')]: args.label };
  await request(ctx, 'PATCH', patchPath, { body: patchBody, headers: { 'if-match': '"stale-etag"' } });
  await requestJson(ctx, 'PATCH', patchPath, { body: patchBody, headers: { 'if-match': tag } });
}

// execPlanHttp(ctx, plan, n) -> {env, ids}: mirrors grammar.js's runPlanLocally op-for-op, but
// each op is a real HTTP call. `env` collects descriptors (for compute-step $refs), `ids`
// collects the asset ids those descriptors live at on the server (what actually gets submitted).
// `n` (the rung number) is folded into every Idempotency-Key: resultKey names ('a', 'final', ...)
// repeat across rungs, and the idempotency store is keyed only by (token, route, key), so without
// `n` the second rung to reuse a name would silently get back the FIRST rung's cached asset.
async function execPlanHttp(ctx, plan, n, history, resolveMissingRecall, refusal) {
  const env = new Map();
  const ids = new Map();
  const projects = new Map();
  const audit = [];
  // Addendum Q rule 4: every compute step resolves its house rules through rulesAt for THIS rung,
  // the same function grammar.js composed the plan with. `ctx.world` stays the base world -- paths
  // and field names never move -- and only the arithmetic reads the amended copy.
  const rungWorld = rulesAt(ctx.world, n);
  let refusalViolated = false;
  let victims = [];
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
      // eslint-disable-next-line no-await-in-loop
      const converted = await created(ctx, body);
      env.set(step.resultKey, converted.descriptor);
      ids.set(step.resultKey, converted.id);
    } else if (step.op === 'combine') {
      const idList = args.from.flatMap((k) => {
        const v = ids.get(k);
        return Array.isArray(v) ? v : [v];
      });
      const reqBody = { ids: idList, mode: args.opts.mode };
      if (args.opts.opacityStep !== undefined) reqBody[F(ctx.world, 'opacity_step')] = args.opts.opacityStep;
      // eslint-disable-next-line no-await-in-loop
      const { body } = await requestJson(ctx, 'POST', pathFor(ctx.world, 'assets.combine'), { body: reqBody });
      // eslint-disable-next-line no-await-in-loop
      const combined = await created(ctx, body);
      env.set(step.resultKey, combined.descriptor);
      ids.set(step.resultKey, combined.id);
    } else if (step.op === 'diff') {
      // eslint-disable-next-line no-await-in-loop
      const { body } = await requestJson(ctx, 'POST', pathFor(ctx.world, 'assets.diff'), {
        body: { a: ids.get(args.a), b: ids.get(args.b) },
      });
      // eslint-disable-next-line no-await-in-loop
      const differenced = await created(ctx, body);
      env.set(step.resultKey, differenced.descriptor);
      ids.set(step.resultKey, differenced.id);
      if (args.verifyEtag) {
        const aId = ids.get(args.a);
        // eslint-disable-next-line no-await-in-loop
        const first = await requestJson(ctx, 'GET', pathFor(ctx.world, 'assets.get', { asset_id: aId }));
        // Addendum Q rule 3: ETag travels only in the response header now, never the body.
        // eslint-disable-next-line no-await-in-loop
        await requestJson(ctx, 'GET', pathFor(ctx.world, 'assets.get', { asset_id: aId }), {
          headers: { 'if-none-match': first.headers.get('etag') },
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
      env.set(step.resultKey, runCompute(rungWorld, args.fn, args));
    } else if (step.op === 'render') {
      // eslint-disable-next-line no-await-in-loop
      const result = await httpRender(ctx, args, step.resultKey, projects, idemPrefix, audit);
      env.set(step.resultKey, result.descriptor);
      ids.set(step.resultKey, result.id);
    } else if (step.op === 'publish') {
      // eslint-disable-next-line no-await-in-loop
      await httpPublish(ctx, args, projects, ids.get(args.renderKey), audit);
      env.set(step.resultKey, env.get(args.renderKey));
      ids.set(step.resultKey, ids.get(args.renderKey));
    } else if (step.op === 'recall') {
      // Addendum J rule 1 as tightened by Addendum O: the reference resolves a cross-rung
      // reference STRICTLY out of its own history of what it turned in, exactly as the agent has
      // to resolve it out of its collection on disk. 0.5.x fell back to recomputing the earlier
      // rung locally, which meant a value the agent could never actually retrieve still let the
      // gate pass -- the reference proved nothing about retrievability. It now fails loudly.
      // A caller that genuinely cannot have the history (a partial climb started mid-ladder) has
      // to opt in by passing `resolveMissingRecall`; see recallFallbackResolver below.
      const remembered = history ? history.get(args.fromRung) : undefined;
      let value;
      if (remembered !== undefined) {
        value = args.field === 'dims'
          ? { width: remembered.width, height: remembered.height }
          : remembered.background.color;
      } else if (resolveMissingRecall) {
        value = resolveMissingRecall(args.fromRung, args.field);
      } else {
        throw new Error(
          `recall: rung ${n} borrows ${args.field} from rung ${args.fromRung}, which this climb never submitted`,
        );
      }
      env.set(step.resultKey, value);
    } else if (step.op === 'listCount') {
      // eslint-disable-next-line no-await-in-loop
      const { count, victims: cleared } = await httpListCount(ctx, args, ids.get(args.subsetKey));
      env.set(step.resultKey, count);
      victims = cleared;
    } else if (step.op === 'etag') {
      // eslint-disable-next-line no-await-in-loop
      await httpEtag(ctx, args, ids.get(args.from));
      env.set(step.resultKey, env.get(args.from));
      ids.set(step.resultKey, ids.get(args.from));
    } else {
      throw new Error(`unknown op: ${step.op}`);
    }
  }
  // Addendum Q rule 7, performed last so every id the act might need exists. The check is on the
  // ABSENCE of the forbidden artifact or state, so a house that refused the act on its own is not
  // a violation -- nothing came into existence.
  if (refusal && refusal.perform && refusal.forbidden) {
    const created = await performForbiddenAct(ctx, refusal.forbidden, { victims, ids });
    if (created > 0) refusalViolated = true;
  }
  return { env, ids, audit, refusalViolated };
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
//     recomputation -- the same memory the agent is expected to keep, kept the same way. Since
//     Addendum O that is the ONLY way they resolve: a rung that borrows from a rung this climb
//     never submitted fails loudly, so an unretrievable cross-rung value cannot slip the gate.
//     `resolveMissingRecall` (see recallFallbackResolver) is the explicit opt-out, for a partial
//     climb that starts mid-ladder and has no history to have kept.
//   * When `adminBaseUrl` is given it advances the admin-side current rung in step with itself,
//     so Addendum J rule 3's announced mutation for rung n is LIVE for the whole of rung n. A
//     rung the reference cannot pass with its own announced mutation applied is a generator bug,
//     and without this the gate would never see one.
//
// `onRungReady(n)`, when given, is awaited after the climb has advanced the server to rung n but
// before that rung's plan is executed or submitted. `POST /admin/rungs/advance` REPLACES the
// server's active mutation set with whatever rung n naturally announces (admin.js), which is
// empty for every rung below `FIRST_MUTATION_RUNG` -- so a caller that forced a mutation on
// (e.g. via `POST /admin/mutate`) before the climb started would otherwise have it wiped out the
// moment the climb advances past rung 1. The hook exists so such a caller can re-force it, live
// again, for each rung it actually needs to test.
export async function climb({
  world, baseUrl, apiKey, adminBaseUrl, adminToken, from = 0, to = 99, log, onRungReady, resolveMissingRecall,
  performForbidden = false,
}) {
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
      // eslint-disable-next-line no-await-in-loop
      if (onRungReady) await onRungReady(n);
      const rung = makeRung(world, n);
      // Addendum Q rule 4: the release signature's recipe can itself be amended mid-ladder, so the
      // client signs with the rules in force at THIS rung, not with the ones it booted on.
      ctx.world = rulesAt(world, n);
      ctx.forbiddenStyleName = rung.forbidden && rung.forbidden.act === 'workOnClearedCopies'
        ? composePlan(world, n).narrative.refusal.styleName
        : undefined;
      // eslint-disable-next-line no-await-in-loop
      const { env, ids, audit, refusalViolated } = await execPlanHttp(ctx, rung.plan, n, history, resolveMissingRecall, {
        forbidden: rung.forbidden,
        perform: performForbidden,
      });
      // Addendum Q rule 10: the path, not just the terminal artifact.
      if (rung.expectedAudit) {
        const want = rung.expectedAudit.stages.join(' -> ');
        const got = audit.join(' -> ');
        if (want !== got) throw new Error(`audit: rung ${n} walked "${got}" but the key requires "${want}"`);
      }
      const lastKey = rung.plan[rung.plan.length - 1].resultKey;
      const submitId = ids.get(lastKey);
      history.set(n, env.get(lastKey));
      const reqBody = { assets: [submitId] };
      const path = pathFor(world, 'rungs.submit', { n: String(n) });
      // eslint-disable-next-line no-await-in-loop
      const { body } = await requestJson(ctx, 'POST', path, { body: reqBody });
      if (body.pass && refusalViolated) {
        // Addendum Q rule 7: the fourth check, proved against the HOUSE rather than asserted here.
        // The reference passes a refusal rung by not doing the thing; when it is told to do it
        // anyway (test/refusal.test.js's other half) the submission still goes in, so what is
        // being tested is whether the house's `refusal` check actually catches it. A pass here
        // means the absence check is not grading -- exactly the failure Addendum O found when a
        // demand in the text was graded by nothing.
        failed.push({
          n,
          reason: `refusal: rung ${n} performed the forbidden act "${rung.forbidden.act}" (RULES-0.9 rule ${rung.forbidden.rule}) and the house passed it anyway: ${rung.forbidden.detail}`,
        });
        if (log) log({ n, pass: false, checks: body.checks });
        continue;
      }
      if (body.pass) {
        passed.push(n);
      } else {
        // Name the checks that actually said no. A bare "pass:false" tells an operator nothing
        // about whether the hash, the project state, the label, the path audit or the refusal is
        // what went wrong, and those are five very different bugs.
        const failing = Object.entries(body.checks || {}).filter(([, ok]) => ok === false).map(([k]) => k);
        const which = failing.length > 0 ? ` (failed: ${failing.join(', ')})` : '';
        // On a hash failure, say WHAT differs: the descriptor this file built locally against the
        // key's rules versus the one the house actually holds for the submitted asset. One extra
        // request, only ever on a failing rung, and it turns "pass:false" into a diff.
        let detail = '';
        if (failing.includes('hash')) {
          // Name the FIRST step whose result diverged from the same plan run against the key's
          // own rules. "pass:false" says nothing; "step c1 diverged" points straight at the op.
          try {
            const want = runPlanLocally(rulesAt(world, n), rung.plan);
            const step = rung.plan.find((s) => JSON.stringify(env.get(s.resultKey)) !== JSON.stringify(want.get(s.resultKey)));
            detail = step
              ? ` first divergence at step ${step.resultKey} (${step.op}): climbed=${JSON.stringify(env.get(step.resultKey))} key=${JSON.stringify(want.get(step.resultKey))}`
              : ' the climbed plan matches the key locally, so the house rendered it differently';
          } catch (err) { detail = ` (could not diff: ${err.message})`; }
        }
        failed.push({ n, reason: `submit returned pass:false${which}${detail}` });
      }
      if (log) log({ n, pass: body.pass, checks: body.checks });
    } catch (err) {
      failed.push({ n, reason: err.message });
      if (log) log({ n, pass: false, error: err.message });
    }
  }
  return { passed, failed };
}
