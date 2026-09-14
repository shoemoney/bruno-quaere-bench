import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { makeWorld, resolvePath, fieldName } from '../src/world.js';
import { routes } from '../src/routes.js';
import { createServer } from '../src/api/server.js';
import { STUCK_CURSOR_TOKEN } from '../src/api/behaviors.js';
import { publishHeaders } from './fixtures/sign.js';

const SEED = 7;

let world;
let server;
let base;
let adminBase;
let mainToken;

// shared fixtures set up in before()
let wsId;
let projectId; // a seeded draft project, left untouched by the state-machine test
let assetId; // a seeded asset, used for read/etag/patch tests

function f(name) {
  return fieldName(world, name);
}

function routeTemplate(id) {
  const route = routes.find((r) => r.id === id);
  return resolvePath(world, route.path);
}

function withParams(template, params) {
  let out = template;
  for (const [k, v] of Object.entries(params)) out = out.replace(`{${k}}`, encodeURIComponent(v));
  return out;
}

function urlFor(id, params = {}) {
  return `${base}${withParams(routeTemplate(id), params)}`;
}

function authHeaders(token = mainToken) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function getToken() {
  const res = await fetch(`${base}/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [f('api_key')]: world.auth.apiKey }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  return body[f('access_token')];
}

async function createImage(token, params, headers = {}) {
  return fetch(`${base}/images`, {
    method: 'POST',
    headers: { ...authHeaders(token), ...headers },
    body: JSON.stringify(params),
  });
}

test.before(async () => {
  world = makeWorld(SEED);
  server = createServer({ world, publicPort: 0, adminPort: 0 });
  const ports = await server.start();
  base = `http://127.0.0.1:${ports.publicPort}`;
  adminBase = `http://127.0.0.1:${ports.adminPort}`;

  mainToken = await getToken();

  const wsRes = await fetch(urlFor('workspaces.list'), { headers: authHeaders() });
  const wsBody = await wsRes.json();
  wsId = wsBody.data[0].id;

  const projRes = await fetch(urlFor('projects.list', { workspace_id: wsId }), { headers: authHeaders() });
  const projBody = await projRes.json();
  projectId = projBody.data[0].id;

  const assetsRes = await fetch(urlFor('projects.assets', { workspace_id: wsId, project_id: projectId }), {
    headers: authHeaders(),
  });
  const assetsBody = await assetsRes.json();
  assetId = assetsBody.data[0].id;
});

test.after(async () => {
  await server.stop();
});

// Every test starts with its own fresh token: rate limiting is per-token (correctly), and a
// single mainToken shared across every test in the file would eventually trip a small
// world.rate.limit purely from test-suite traffic, which is a suite hygiene problem, not a
// behavior under test.
test.beforeEach(async () => {
  mainToken = await getToken();
});

// ---------------------------------------------------------------------------
// auth lifecycle
// ---------------------------------------------------------------------------

test('auth: valid api key exchanges for a bearer token with TTL and a refresh token', async () => {
  const res = await fetch(urlFor('auth.token'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [f('api_key')]: world.auth.apiKey }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body[f('token_type')], 'bearer');
  assert.equal(body[f('expires_in')], world.auth.tokenTtlSec);
  assert.equal(typeof body[f('access_token')], 'string');
  assert.equal(typeof body[f('refresh_token')], 'string');
});

test('auth: wrong api key is rejected as problem+json', async () => {
  const res = await fetch(urlFor('auth.token'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [f('api_key')]: 'not-the-real-key' }),
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('content-type'), 'application/problem+json');
  const body = await res.json();
  assert.equal(body.status, 401);
  assert.equal(body.type, 'about:blank');
});

test('auth: refresh token exchanges for a new bearer token', async () => {
  const tokenRes = await fetch(urlFor('auth.token'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [f('api_key')]: world.auth.apiKey }),
  });
  const issued = await tokenRes.json();
  const refreshRes = await fetch(urlFor('auth.refresh'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [f('refresh_token')]: issued[f('refresh_token')] }),
  });
  assert.equal(refreshRes.status, 200);
  const refreshed = await refreshRes.json();
  assert.notEqual(refreshed[f('access_token')], issued[f('access_token')]);

  // the fresh token works against a protected route
  const check = await fetch(urlFor('workspaces.list'), {
    headers: { authorization: `Bearer ${refreshed[f('access_token')]}` },
  });
  assert.equal(check.status, 200);
});

test('auth: protected routes 401 without a bearer token', async () => {
  const res = await fetch(urlFor('workspaces.list'));
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('content-type'), 'application/problem+json');
});

test('auth: protected routes 401 on a garbage bearer token', async () => {
  const res = await fetch(urlFor('workspaces.list'), { headers: { authorization: 'Bearer nonsense' } });
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

// Addendum Q rule 3: the cursor travels ONLY in a `Link: rel="next"` response header now, never
// as a body field -- workspaces.list has exactly 2 seeded workspaces, so page_size=1 makes page 2
// the last page and its Link header must be absent entirely.
test('pagination: cursor travels only in the Link header; last page carries no Link at all', async () => {
  const page1Res = await fetch(`${urlFor('workspaces.list')}?page_size=1`, { headers: authHeaders() });
  const page1 = await page1Res.json();
  assert.equal(page1.data.length, 1);
  assert.equal('cursor' in page1, false, 'cursor must never appear in the body');
  const link1 = page1Res.headers.get('link');
  assert.match(link1, /rel="next"/);
  const cursorMatch = /[?&]cursor=([^&>]+)/.exec(link1);
  assert.ok(cursorMatch, `Link header must carry a cursor query param, got ${link1}`);
  const cursor = decodeURIComponent(cursorMatch[1]);

  const page2Res = await fetch(`${urlFor('workspaces.list')}?page_size=1&cursor=${encodeURIComponent(cursor)}`, {
    headers: authHeaders(),
  });
  const page2 = await page2Res.json();
  assert.equal(page2.data.length, 1);
  assert.notEqual(page2.data[0].id, page1.data[0].id);
  assert.equal('cursor' in page2, false, 'cursor must never appear in the body');
  assert.equal(page2Res.headers.get('link'), null, 'last page must carry no Link header at all');
});

// ---------------------------------------------------------------------------
// discovery: workspace links -> loras, not in the route table but reachable
// ---------------------------------------------------------------------------

test('discovery: workspace links to the lora library, which is reachable and filterable', async () => {
  const wsRes = await fetch(urlFor('workspaces.get', { workspace_id: wsId }), { headers: authHeaders() });
  const wsBody = await wsRes.json();
  const lorasPath = wsBody.links.loras;
  assert.equal(typeof lorasPath, 'string');

  const lorasRes = await fetch(`${base}${lorasPath}`, { headers: authHeaders() });
  assert.equal(lorasRes.status, 200);
  const lorasBody = await lorasRes.json();
  assert.ok(lorasBody.data.length >= 6);

  const target = world.loras[0];
  const filterRes = await fetch(`${base}${lorasPath}?name=${target.name.toUpperCase()}`, { headers: authHeaders() });
  const filterBody = await filterRes.json();
  assert.equal(filterBody.data.length, 1);
  assert.equal(filterBody.data[0].id, target.id);
});

// ---------------------------------------------------------------------------
// idempotency
// ---------------------------------------------------------------------------

test('idempotency: same key and token replay the original response, 201 status included', async () => {
  const token = await getToken();
  const params = { width: 64, height: 64, background: { color: '#00ff00' }, shapes: [] };
  const first = await createImage(token, params, { 'idempotency-key': 'idem-1' });
  assert.equal(first.status, 201);
  const firstBody = await first.json();

  const second = await createImage(token, params, { 'idempotency-key': 'idem-1' });
  // 201, not 200: the spec declares only 201 for a create, and an undeclared status here would
  // be a status lie outside the trap catalog.
  assert.equal(second.status, 201);
  const secondBody = await second.json();
  assert.deepEqual(secondBody, firstBody);
});

test('idempotency: a replayed create does not allocate a second asset', async () => {
  const token = await getToken();
  const params = { width: 65, height: 65, background: { color: '#00ff00' }, shapes: [] };
  const first = await createImage(token, params, { 'idempotency-key': 'idem-count' });
  const firstBody = await first.json();
  await createImage(token, params, { 'idempotency-key': 'idem-count' });
  await createImage(token, params, { 'idempotency-key': 'idem-count' });
  // the next un-keyed create must be exactly one id past the first, proving the replays
  // never ran the create path.
  const after = await createImage(token, params);
  const afterBody = await after.json();
  assert.notEqual(afterBody.id, firstBody.id);
  const reread = await fetch(urlFor('assets.get', { asset_id: firstBody.id }), {
    headers: authHeaders(token),
  });
  assert.equal(reread.status, 200);
});

test('idempotency: no key creates a new asset every time', async () => {
  const token = await getToken();
  const params = { width: 32, height: 32, background: { color: '#123456' }, shapes: [] };
  const first = await createImage(token, params);
  const second = await createImage(token, params);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const firstBody = await first.json();
  const secondBody = await second.json();
  assert.notEqual(firstBody.id, secondBody.id);
});

// ---------------------------------------------------------------------------
// rate limiting
// ---------------------------------------------------------------------------

test('rate limit: 429 with an integer Retry-After once the token exceeds its budget', async () => {
  const token = await getToken();
  let last;
  for (let i = 0; i < world.rate.limit + 1; i += 1) {
    last = await fetch(urlFor('workspaces.list'), { headers: authHeaders(token) });
  }
  assert.equal(last.status, 429);
  const retryAfter = last.headers.get('retry-after');
  assert.match(retryAfter, /^\d+$/);
  assert.ok(Number(retryAfter) >= 1);
  const body = await last.json();
  assert.equal(body.status, 429);
});

// ---------------------------------------------------------------------------
// etag / conditional requests
// ---------------------------------------------------------------------------

test('etag: GET returns an ETag, If-None-Match replays as 304', async () => {
  const res = await fetch(urlFor('assets.get', { asset_id: assetId }), { headers: authHeaders() });
  assert.equal(res.status, 200);
  const etag = res.headers.get('etag');
  assert.match(etag, /^"[0-9a-f]{16}"$/);

  const cached = await fetch(urlFor('assets.get', { asset_id: assetId }), {
    headers: { ...authHeaders(), 'if-none-match': etag },
  });
  assert.equal(cached.status, 304);
});

test('etag: PATCH requires If-Match, 428 missing / 412 mismatch / 200 on match', async () => {
  const getRes = await fetch(urlFor('assets.get', { asset_id: assetId }), { headers: authHeaders() });
  const etag = getRes.headers.get('etag');

  const missing = await fetch(urlFor('assets.patch', { asset_id: assetId }), {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify({ [f('display_name')]: 'renamed' }),
  });
  assert.equal(missing.status, 428);

  const mismatch = await fetch(urlFor('assets.patch', { asset_id: assetId }), {
    method: 'PATCH',
    headers: { ...authHeaders(), 'if-match': '"0000000000000000"' },
    body: JSON.stringify({ [f('display_name')]: 'renamed' }),
  });
  assert.equal(mismatch.status, 412);

  const ok = await fetch(urlFor('assets.patch', { asset_id: assetId }), {
    method: 'PATCH',
    headers: { ...authHeaders(), 'if-match': etag },
    body: JSON.stringify({ [f('display_name')]: 'renamed-for-real' }),
  });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body[f('display_name')], 'renamed-for-real');
});

// ---------------------------------------------------------------------------
// content negotiation + soft delete + nested listing
// ---------------------------------------------------------------------------

test('nested resources: project assets are only discoverable by listing the project', async () => {
  const res = await fetch(urlFor('projects.assets', { workspace_id: wsId, project_id: projectId }), {
    headers: authHeaders(),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.data.length > 0);
  const getRes = await fetch(urlFor('assets.get', { asset_id: body.data[0].id }), { headers: authHeaders() });
  assert.equal(getRes.status, 200);
});

test('content negotiation: Accept text/csv on the project asset list returns a header row', async () => {
  const res = await fetch(urlFor('projects.assets', { workspace_id: wsId, project_id: projectId }), {
    headers: { ...authHeaders(), accept: 'text/csv' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/csv');
  const text = await res.text();
  const [header] = text.split('\r\n');
  assert.equal(header, 'id,kind,hash,etag,display_name,created_at,updated_at');
});

test('soft delete: DELETE hides an asset unless include_deleted=true', async () => {
  const created = await createImage(mainToken, { width: 16, height: 16, background: { transparent: true }, shapes: [] });
  const asset = await created.json();

  const del = await fetch(urlFor('assets.delete', { asset_id: asset.id }), { method: 'DELETE', headers: authHeaders() });
  assert.equal(del.status, 204);

  const getAfter = await fetch(urlFor('assets.get', { asset_id: asset.id }), { headers: authHeaders() });
  assert.equal(getAfter.status, 404);

  const listHidden = await fetch(urlFor('projects.assets', { workspace_id: wsId, project_id: projectId }), {
    headers: authHeaders(),
  });
  const hiddenBody = await listHidden.json();
  assert.ok(!hiddenBody.data.some((a) => a.id === asset.id));
});

// ---------------------------------------------------------------------------
// media operations: convert / combine / diff / lora
// ---------------------------------------------------------------------------

test('media ops: convert, combine, diff, and lora each produce a new asset', async () => {
  const aRes = await createImage(mainToken, { width: 50, height: 50, background: { color: '#ff0000' }, shapes: [] });
  const a = await aRes.json();
  const bRes = await createImage(mainToken, { width: 50, height: 50, background: { color: '#0000ff' }, shapes: [] });
  const b = await bRes.json();

  const convertRes = await fetch(urlFor('assets.convert', { asset_id: a.id }), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ format: a.descriptor.format === 'svg' ? 'png' : 'svg' }),
  });
  assert.equal(convertRes.status, 201);
  const converted = await convertRes.json();
  assert.notEqual(converted.id, a.id);
  assert.notEqual(converted.hash, a.hash);

  const combineRes = await fetch(urlFor('assets.combine'), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ ids: [a.id, b.id], mode: 'layer' }),
  });
  assert.equal(combineRes.status, 201);
  const combined = await combineRes.json();
  assert.equal(combined.descriptor.shapes.length, 0);

  const diffRes = await fetch(urlFor('assets.diff'), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ a: a.id, b: b.id }),
  });
  assert.equal(diffRes.status, 201);

  const lora = world.loras[0];
  const loraRes = await fetch(urlFor('assets.lora', { asset_id: a.id }), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ [f('lora_id')]: lora.id }),
  });
  assert.equal(loraRes.status, 201);
  const loraBody = await loraRes.json();
  assert.equal(loraBody.descriptor.lora.id, lora.id);
});

// Addendum O, "the house refuses the wrong reading": house styles apply to pictures only. Before
// 0.6.0 this 201'd on audio/video and stamped `lora: {applied: true}` on a descriptor otherwise
// untouched -- a false "something happened" signal.
test('lora on a non-image asset is 422 problem+json, never a 201 with applied stamped on nothing', async () => {
  const audioRes = await fetch(urlFor('audio.create'), {
    method: 'POST',
    headers: authHeaders(mainToken),
    body: JSON.stringify({ durationMs: 100, notes: [] }),
  });
  assert.equal(audioRes.status, 201);
  const audio = await audioRes.json();

  const lora = world.loras[0];
  const res = await fetch(urlFor('assets.lora', { asset_id: audio.id }), {
    method: 'POST',
    headers: authHeaders(mainToken),
    body: JSON.stringify({ [f('lora_id')]: lora.id }),
  });
  assert.equal(res.status, 422);
  assert.equal(res.headers.get('content-type'), 'application/problem+json');
  const body = await res.json();
  assert.deepEqual(body.errors, [{ field: 'lora_id', message: 'styles apply to pictures only' }]);

  // and the audio asset itself is untouched -- no new asset, same hash, no lora field
  const after = await fetch(urlFor('assets.get', { asset_id: audio.id }), { headers: authHeaders(mainToken) });
  const afterBody = await after.json();
  assert.equal(afterBody.hash, audio.hash);
  assert.equal(afterBody.descriptor.lora, undefined);
});

// Addendum O: assets.convert.format is a per-kind enum, not a flat five-value list -- converting
// an image to an audio/video-only format (or vice versa) 422s, exactly like any other field
// outside its documented enum.
test('convert: a format outside the target asset\'s own kind is 422, not silently accepted', async () => {
  const img = await (await createImage(mainToken, { width: 10, height: 10, background: { color: '#ff0000' }, shapes: [] })).json();
  const crossKindRes = await fetch(urlFor('assets.convert', { asset_id: img.id }), {
    method: 'POST',
    headers: authHeaders(mainToken),
    body: JSON.stringify({ format: 'wav' }),
  });
  assert.equal(crossKindRes.status, 422);
  assert.equal(crossKindRes.headers.get('content-type'), 'application/problem+json');

  const audioRes = await fetch(urlFor('audio.create'), {
    method: 'POST',
    headers: authHeaders(mainToken),
    body: JSON.stringify({ durationMs: 50, notes: [] }),
  });
  const audio = await audioRes.json();
  const audioCrossKindRes = await fetch(urlFor('assets.convert', { asset_id: audio.id }), {
    method: 'POST',
    headers: authHeaders(mainToken),
    body: JSON.stringify({ format: 'qvid' }),
  });
  assert.equal(audioCrossKindRes.status, 422);
});

test('422: invalid media params return problem+json with a field-level errors array', async () => {
  const res = await createImage(mainToken, { width: -5 });
  assert.equal(res.status, 422);
  assert.equal(res.headers.get('content-type'), 'application/problem+json');
  const body = await res.json();
  assert.ok(Array.isArray(body.errors));
  assert.ok(body.errors.length > 0);
  assert.ok(body.errors[0].field);
  assert.ok(body.errors[0].message);
});

// ---------------------------------------------------------------------------
// state machine + async render + hmac publish
// ---------------------------------------------------------------------------

test('compose rejects unknown asset ids with a 422 instead of silently dropping them', async () => {
  const token = await getToken();
  const created = await fetch(urlFor('projects.create', { workspace_id: wsId }), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ [f('name')]: 'compose validation' }),
  });
  const project = await created.json();
  const res = await fetch(urlFor('projects.compose', { workspace_id: wsId, project_id: project.id }), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ [f('asset_ids')]: [assetId, 'no-such-asset'] }),
  });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(res.headers.get('content-type').split(';')[0], 'application/problem+json');
  assert.deepEqual(body.errors.map((e) => e.field), ['asset_ids']);
  assert.match(body.errors[0].message, /no-such-asset/);

  // and the rejected compose left the project alone
  const after = await fetch(urlFor('projects.get', { workspace_id: wsId, project_id: project.id }), {
    headers: authHeaders(token),
  });
  assert.equal((await after.json()).status, 'draft');
});

test('compose attaches the referenced assets, so they show up in the project asset listing', async () => {
  const token = await getToken();
  const created = await fetch(urlFor('projects.create', { workspace_id: wsId }), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ [f('name')]: 'compose attachment' }),
  });
  const project = await created.json();

  const listPath = urlFor('projects.assets', { workspace_id: wsId, project_id: project.id });
  const before = await fetch(`${listPath}?page_size=50`, { headers: authHeaders(token) });
  assert.equal((await before.json()).data.length, 0, 'a brand new project starts empty');

  const made = await createImage(token, { width: 48, height: 48, background: { color: '#00ff00' }, shapes: [] });
  const madeBody = await made.json();

  const composed = await fetch(urlFor('projects.compose', { workspace_id: wsId, project_id: project.id }), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ [f('asset_ids')]: [madeBody.id] }),
  });
  assert.equal(composed.status, 200);

  const after = await fetch(`${listPath}?page_size=50`, { headers: authHeaders(token) });
  const afterBody = await after.json();
  assert.deepEqual(afterBody.data.map((a) => a.id), [madeBody.id]);
});

test('state machine: draft -> composed -> rendered -> published, wrong order is 409', async () => {
  const createRes = await fetch(urlFor('projects.create', { workspace_id: wsId }), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ name: 'state machine test project' }),
  });
  assert.equal(createRes.status, 201);
  const project = await createRes.json();

  // render before compose -> 409
  const earlyRender = await fetch(urlFor('projects.render', { workspace_id: wsId, project_id: project.id }), {
    method: 'POST',
    headers: authHeaders(),
  });
  assert.equal(earlyRender.status, 409);

  // A FRESH asset, not the seeded fixture: composing only claims an asset that belongs to no
  // project yet, and rule 35's digest has to name a live asset in THIS project.
  const ownAsset = await (await createImage(mainToken, {
    [f('width')]: 40, [f('height')]: 40, [f('background')]: { [f('color')]: '#123456' }, [f('shapes')]: [],
  })).json();
  const compose = await fetch(urlFor('projects.compose', { workspace_id: wsId, project_id: project.id }), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ [f('asset_ids')]: [ownAsset.id] }),
  });
  assert.equal(compose.status, 200);
  assert.equal((await compose.json()).status, 'composed');

  // compose again -> 409 (no longer draft)
  const recompose = await fetch(urlFor('projects.compose', { workspace_id: wsId, project_id: project.id }), {
    method: 'POST',
    headers: authHeaders(),
  });
  assert.equal(recompose.status, 409);

  const render = await fetch(urlFor('projects.render', { workspace_id: wsId, project_id: project.id }), {
    method: 'POST',
    headers: authHeaders(),
  });
  assert.equal(render.status, 202);
  const location = render.headers.get('location');
  assert.ok(location.startsWith('/'));
  const renderBody = await render.json();
  assert.equal(typeof renderBody[f('job_id')], 'string');

  const statuses = [];
  for (let i = 0; i < 4; i += 1) {
    const poll = await fetch(`${base}${location}`, { headers: authHeaders() });
    assert.equal(poll.status, 200);
    statuses.push((await poll.json()).status);
  }
  assert.deepEqual(statuses, ['queued', 'running', 'done', 'done']);

  const publishPath = withParams(routeTemplate('projects.publish'), { workspace_id: wsId, project_id: project.id });

  const noSig = await fetch(`${base}${publishPath}`, { method: 'POST', headers: authHeaders() });
  assert.equal(noSig.status, 401);

  // RULES-0.8 rule 35: the signature binds the house's own digest of the artifact being released.
  const digest = ownAsset.hash;
  const ts = String(Math.floor(Date.now() / 1000));
  const badSig = createHmac(world.hmac.algo, 'wrong-secret').update(`${ts}POST${publishPath}`).digest('hex');
  const wrongSig = await fetch(`${base}${publishPath}`, {
    method: 'POST',
    headers: {
      ...authHeaders(), ...publishHeaders(world, { path: publishPath, bodyDigest: digest, ts }), [world.hmac.header]: badSig,
    },
  });
  assert.equal(wrongSig.status, 401);

  // ... and a digest that names nothing live in this project is refused before the signature is
  // even considered, so a correctly-signed-but-wrongly-bound release cannot get through.
  const strayDigest = 'f'.repeat(64);
  const wrongDigest = await fetch(`${base}${publishPath}`, {
    method: 'POST',
    headers: { ...authHeaders(), ...publishHeaders(world, { path: publishPath, bodyDigest: strayDigest, ts }) },
  });
  assert.equal(wrongDigest.status, 401);

  const publish = await fetch(`${base}${publishPath}`, {
    method: 'POST',
    headers: { ...authHeaders(), ...publishHeaders(world, { path: publishPath, bodyDigest: digest, ts }) },
  });
  assert.equal(publish.status, 200);
  assert.equal((await publish.json()).status, 'published');

  // publish again -> 409 (already published, not rendered)
  const republish = await fetch(`${base}${publishPath}`, {
    method: 'POST',
    headers: { ...authHeaders(), ...publishHeaders(world, { path: publishPath, bodyDigest: digest }) },
  });
  assert.equal(republish.status, 409);
});

// ---------------------------------------------------------------------------
// deprecation redirect
// ---------------------------------------------------------------------------

test('deprecation: GET /v1/pictures 301s to /images', async () => {
  const res = await fetch(`${base}/v1/pictures`, { redirect: 'manual' });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/images');
});

// ---------------------------------------------------------------------------
// misc problem+json / routing
// ---------------------------------------------------------------------------

test('problem+json: an unknown route is a 404 problem body', async () => {
  const res = await fetch(`${base}/nope/not/a/route`, { headers: authHeaders() });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('content-type'), 'application/problem+json');
});

test('problem+json: malformed JSON body is a 400 problem body', async () => {
  const res = await fetch(urlFor('projects.create', { workspace_id: wsId }), {
    method: 'POST',
    headers: authHeaders(),
    body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('content-type'), 'application/problem+json');
});

// ---------------------------------------------------------------------------
// rungs
// ---------------------------------------------------------------------------

test('rungs: current rung, submit pass/fail, one submission per rung', async () => {
  mainToken = await getToken(); // earlier tests share mainToken; keep this one under the rate limit
  const getRes = await fetch(urlFor('assets.get', { asset_id: assetId }), { headers: authHeaders() });
  const asset = await getRes.json();

  const setRes = await fetch(`${adminBase}/admin/rungs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rungs: [{ n: 0, text: 'submit the seeded asset', expected: [asset.hash], expectedDescriptors: [asset.descriptor] }],
    }),
  });
  assert.equal(setRes.status, 200);

  const currentRes = await fetch(urlFor('rungs.current'), { headers: authHeaders() });
  const current = await currentRes.json();
  assert.equal(current.n, 0);
  assert.equal(current.text, 'submit the seeded asset');

  const submitPath = withParams(routeTemplate('rungs.submit'), { n: 0 });
  const failRes = await fetch(`${base}${submitPath}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ assets: [] }),
  });
  const failBody = await failRes.json();
  assert.equal(failBody.pass, false);

  const dupeRes = await fetch(`${base}${submitPath}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ assets: [assetId] }),
  });
  assert.equal(dupeRes.status, 409);

  await fetch(`${adminBase}/admin/rungs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rungs: [{ n: 0, text: 'submit the seeded asset', expected: [asset.hash], expectedDescriptors: [asset.descriptor] }],
    }),
  });
  const passPath = withParams(routeTemplate('rungs.submit'), { n: 0 });
  const passRes = await fetch(`${base}${passPath}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ assets: [assetId] }),
  });
  const passBody = await passRes.json();
  assert.equal(passBody.pass, true);
  assert.equal(passBody.rung, 0);

  const submissionsRes = await fetch(`${adminBase}/admin/submissions`);
  const submissions = (await submissionsRes.json()).data;
  assert.ok(submissions.some((s) => s.pass === true));
});

// A client that JSON-decodes an `int`-style id ("37") into the number 37 and submits that must
// still be graded on its artifact. Before the String() coercion in rungs.submit the lookup missed,
// so a byte-identical artifact scored pass:false with empty submittedHashes and fidelity 0 -- the
// benchmark reported a perfect descriptor as a total miss. Observed live on seed 11, rung 0.
// Needs an `int`-style world (seed 11), where ids are all-digit strings like "37" -- that is the
// only shape a JSON client can silently turn back into a number. SEED 7's ids carry a prefix, so
// Number() on them is NaN and the bug cannot appear.
test('rungs: a numeric asset id grades the same as the string the API handed out', async () => {
  const intWorld = makeWorld(11);
  assert.equal(intWorld.ids.style, 'int', 'this test needs digit-only ids to be meaningful');
  const intServer = createServer({ world: intWorld, publicPort: 0, adminPort: 0 });
  const ports = await intServer.start();
  const intBase = `http://127.0.0.1:${ports.publicPort}`;
  const intAdmin = `http://127.0.0.1:${ports.adminPort}`;

  try {
    const tok = await (
      await fetch(`${intBase}/auth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [fieldName(intWorld, 'api_key')]: intWorld.auth.apiKey }),
      })
    ).json();
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${tok[fieldName(intWorld, 'access_token')]}`,
    };

    const created = await (
      await fetch(`${intBase}${resolvePath(intWorld, routes.find((r) => r.id === 'audio.create').path)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          durationMs: 708,
          notes: [{ freq: 596, startMs: 0, durMs: 197, amp: 0.58, wave: 'saw' }],
        }),
      })
    ).json();
    assert.equal(typeof created.id, 'string', 'ids leave the API as strings');
    assert.match(created.id, /^\d+$/, 'int-style ids are all digits');

    await fetch(`${intAdmin}/admin/rungs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rungs: [{ n: 0, text: 'submit it', expected: [created.hash], expectedDescriptors: [created.descriptor] }],
      }),
    });

    const submitPath = resolvePath(intWorld, routes.find((r) => r.id === 'rungs.submit').path).replace('{n}', '0');
    const body = await (
      await fetch(`${intBase}${submitPath}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ assets: [Number(created.id)] }),
      })
    ).json();
    assert.equal(body.pass, true, 'numeric id must resolve to the same asset');

    const submissions = (await (await fetch(`${intAdmin}/admin/submissions`)).json()).data;
    const mine = submissions[submissions.length - 1];
    assert.deepEqual(mine.submittedHashes, [created.hash], 'hashes must be recorded, not empty');
    assert.equal(mine.fidelity, 1, 'an exact descriptor must score fidelity 1, not 0');
  } finally {
    await intServer.stop();
  }
});

// ---------------------------------------------------------------------------
// admin mutations
// ---------------------------------------------------------------------------

// Addendum Q rule 2: the ladder-announced mutations' candidate lists now live on write/list
// load-bearing routes (world.js's RUNG_MUTATION_TARGETS), not the plain GET routes 0.6.0 used --
// rejectAuth/stuckCursor stay on the original listing routes, since they are never
// ladder-announced (see admin.js).
function fetchForRoute(routeId, ids, headers) {
  if (routeId === 'workspaces.get') return fetch(urlFor('workspaces.get', { workspace_id: ids.wsId }), { headers });
  if (routeId === 'projects.get') return fetch(urlFor('projects.get', { workspace_id: ids.wsId, project_id: ids.projectId }), { headers });
  if (routeId === 'assets.get') return fetch(urlFor('assets.get', { asset_id: ids.assetId }), { headers });
  // page_size=1 guarantees a next page (and thus a Link header) exists to inspect/mutate.
  if (routeId === 'workspaces.list') return fetch(`${urlFor('workspaces.list')}?page_size=1`, { headers });
  if (routeId === 'projects.list') return fetch(`${urlFor('projects.list', { workspace_id: ids.wsId })}?page_size=1`, { headers });
  if (routeId === 'projects.assets') {
    return fetch(`${urlFor('projects.assets', { workspace_id: ids.wsId, project_id: ids.projectId })}?page_size=1`, { headers });
  }
  if (routeId === 'images.create') {
    return fetch(urlFor('images.create'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ width: 16, height: 16, background: { color: '#000000' }, shapes: [] }),
    });
  }
  if (routeId === 'assets.convert') {
    return fetch(urlFor('assets.convert', { asset_id: ids.assetId }), {
      method: 'POST',
      headers,
      body: JSON.stringify({ width: 32, height: 32 }),
    });
  }
  if (routeId === 'assets.combine') {
    return fetch(urlFor('assets.combine'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ ids: [ids.assetId, ids.assetId2], mode: 'layer' }),
    });
  }
  if (routeId === 'projects.render') {
    return fetch(urlFor('projects.render', { workspace_id: ids.wsId, project_id: ids.projectId }), { method: 'POST', headers });
  }
  if (routeId === 'assets.lora') {
    return fetch(urlFor('assets.lora', { asset_id: ids.assetId }), {
      method: 'POST',
      headers,
      body: JSON.stringify({ [f('lora_id')]: ids.loraId }),
    });
  }
  throw new Error(`no fetcher wired for ${routeId}`);
}

// A fresh token + a fresh seeded workspace/project (composed but NOT yet rendered, so the
// dropField-on-projects.render candidate can actually be exercised) and two of its seeded assets.
// Candidate lists overlap across mutations (e.g. both dropField and retypeField can land near the
// same route), so each mutation is checked against its own clean reset rather than layered on top
// of the others, which would otherwise have one mutation eat the field another expects.
async function freshMutationFixtures() {
  await fetch(`${adminBase}/admin/reset`, { method: 'POST' });
  const token = await getToken();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const ws = (await (await fetch(urlFor('workspaces.list'), { headers })).json()).data[0].id;
  const project = (await (await fetch(urlFor('projects.list', { workspace_id: ws }), { headers })).json()).data[0].id;
  const assetsPage = await (
    await fetch(urlFor('projects.assets', { workspace_id: ws, project_id: project }), { headers })
  ).json();
  const asset = assetsPage.data[0].id;
  const asset2 = assetsPage.data[1].id;
  await fetch(urlFor('projects.compose', { workspace_id: ws, project_id: project }), { method: 'POST', headers });
  return {
    headers,
    ids: { wsId: ws, projectId: project, assetId: asset, assetId2: asset2, loraId: world.loras[0].id },
  };
}

test('admin: mutate flips a live behavior, one at a time, and reset restores it', async () => {
  for (const name of ['dropField', 'renameField', 'retypeField', 'statusCode', 'stuckCursor', 'rejectAuth']) {
    const { headers, ids } = await freshMutationFixtures();
    const mutateRes = await fetch(`${adminBase}/admin/mutate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    assert.equal(mutateRes.status, 200);
    const { target } = await mutateRes.json();

    const res = await fetchForRoute(target.route, ids, headers);
    if (name === 'rejectAuth') {
      assert.equal(res.status, 401);
      continue;
    }
    if (name === 'statusCode') {
      assert.equal(res.status, target.to);
      continue;
    }
    if (name === 'stuckCursor') {
      const link = res.headers.get('link');
      assert.ok(link && link.includes(STUCK_CURSOR_TOKEN), `Link header should carry the stuck cursor token, got ${link}`);
      continue;
    }
    const body = await res.json();
    if (name === 'dropField') {
      assert.equal(f(target.field) in body, false, `${target.field} should be dropped from ${target.route}`);
    } else if (name === 'renameField') {
      if (target.field === 'cursor') {
        // Addendum Q rule 3: cursor never lives in the body -- the rename shows up as the Link
        // header's query-param name instead (Addendum Q rule 2's projects.assets.cursor -> next).
        const link = res.headers.get('link');
        assert.ok(link, 'a next-page Link header must be present');
        assert.ok(link.includes(`${target.to}=`), `Link header should use the renamed param "${target.to}", got ${link}`);
        assert.ok(!link.includes('cursor='), `the original param name must not appear once renamed, got ${link}`);
      } else {
        assert.equal(f(target.field) in body, false);
        assert.ok(f(target.to) in body);
      }
    } else if (name === 'retypeField') {
      const container = target.field in body ? body : body.descriptor;
      if (target.field === 'shapes') {
        assert.equal(typeof container[target.field], 'number', `${target.field} should retype to a count`);
      } else {
        assert.equal(typeof container[target.field], 'string', `${target.field} should retype to a string`);
      }
    }
  }

  // final reset restores plain behavior, and re-seeds what the rest of the suite still needs
  const resetRes = await fetch(`${adminBase}/admin/reset`, { method: 'POST' });
  assert.equal(resetRes.status, 200);

  mainToken = await getToken();
  const wsRes2 = await fetch(urlFor('workspaces.list'), { headers: authHeaders() });
  wsId = (await wsRes2.json()).data[0].id;
  const projRes2 = await fetch(urlFor('projects.list', { workspace_id: wsId }), { headers: authHeaders() });
  projectId = (await projRes2.json()).data[0].id;
  const assetsRes2 = await fetch(urlFor('projects.assets', { workspace_id: wsId, project_id: projectId }), {
    headers: authHeaders(),
  });
  assetId = (await assetsRes2.json()).data[0].id;

  const wsGet = await fetch(urlFor('workspaces.get', { workspace_id: wsId }), { headers: authHeaders() });
  const wsBody = await wsGet.json();
  assert.equal(wsGet.status, 200);
  assert.ok('created_at' in wsBody || 'createdAt' in wsBody);

  const listAgain = await fetch(urlFor('workspaces.list'), { headers: authHeaders() });
  assert.equal(listAgain.status, 200);
});

test('admin: world exposes the seeded World object', async () => {
  const res = await fetch(`${adminBase}/admin/world`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.seed, SEED);
  assert.equal(body.version, world.version);
});

// ---------------------------------------------------------------------------
// Addendum Q rule 8: rendered byte length on asset responses and content HEAD
// ---------------------------------------------------------------------------

test('byte length: assets expose "bytes" in the body, matching HEAD .../content Content-Length, with no HEAD body', async () => {
  const token = await getToken();
  const created = await createImage(token, { width: 20, height: 20, background: { color: '#ff00ff' }, shapes: [] });
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.equal(typeof body.bytes, 'number');
  assert.ok(body.bytes > 0);

  const contentUrl = urlFor('assets.content', { asset_id: body.id });
  const getRes = await fetch(contentUrl, { headers: authHeaders(token) });
  const getBuf = Buffer.from(await getRes.arrayBuffer());
  assert.equal(getBuf.length, body.bytes, 'the "bytes" field must equal the actual rendered length');
  assert.equal(getRes.headers.get('content-length'), String(body.bytes));

  const headRes = await fetch(contentUrl, { method: 'HEAD', headers: authHeaders(token) });
  assert.equal(headRes.status, 200);
  assert.equal(headRes.headers.get('content-length'), String(body.bytes), 'HEAD reports the same length as GET');
  const headBuf = Buffer.from(await headRes.arrayBuffer());
  assert.equal(headBuf.length, 0, 'HEAD must carry no body at all');
});

// ---------------------------------------------------------------------------
// Addendum Q rule 11: a documented server-side scope filter for listings
// ---------------------------------------------------------------------------

test('scope filter: ?after=<asset id> restricts a project listing to copies made after it', async () => {
  const token = await getToken();
  const listUrl = `${urlFor('projects.assets', { workspace_id: wsId, project_id: projectId })}?page_size=50`;
  const full = await (await fetch(listUrl, { headers: authHeaders(token) })).json();
  assert.ok(full.data.length >= 3, 'fixture project needs at least 3 assets for this to be meaningful');
  const markerId = full.data[1].id;
  const scoped = await (await fetch(`${listUrl}&after=${encodeURIComponent(markerId)}`, { headers: authHeaders(token) })).json();
  assert.deepEqual(scoped.data.map((a) => a.id), full.data.slice(2).map((a) => a.id));

  // An unknown marker (never in the listing) is a documented no-op, not an error: the filter
  // simply never matched, so nothing is dropped.
  const unknown = await (await fetch(`${listUrl}&after=does-not-exist`, { headers: authHeaders(token) })).json();
  assert.deepEqual(unknown.data.map((a) => a.id), full.data.map((a) => a.id));
});

// ---------------------------------------------------------------------------
// Addendum Q rule 9: a tighter, separately-bucketed limit on the listing route that feeds a
// derived count -- short pages before an outright 429, with Retry-After.
// ---------------------------------------------------------------------------

test('listing bucket: projects.assets goes short before it 429s, and 429s with Retry-After', async () => {
  const token = await getToken();
  const bucket = world.rate.buckets.listing;
  const listUrl = `${urlFor('projects.assets', { workspace_id: wsId, project_id: projectId })}?page_size=5`;
  let sawShort = false;
  let last;
  let lastBody;
  for (let i = 0; i < bucket.limit * 2 + 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    last = await fetch(listUrl, { headers: authHeaders(token) });
    if (last.status === 429) break;
    // eslint-disable-next-line no-await-in-loop
    lastBody = await last.json();
    if (lastBody.data.length < 5) sawShort = true;
  }
  assert.ok(sawShort, 'expected at least one short page before the bucket hard-limits');
  assert.equal(last.status, 429, 'the bucket must eventually 429, not error out on the short pages themselves');
  const retryAfter = last.headers.get('retry-after');
  assert.match(retryAfter, /^\d+$/);
  assert.ok(Number(retryAfter) >= 1);
});
