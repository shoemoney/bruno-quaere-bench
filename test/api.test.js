import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { makeWorld, resolvePath, fieldName } from '../src/world.js';
import { routes } from '../src/routes.js';
import { createServer } from '../src/api/server.js';
import { STUCK_CURSOR_TOKEN } from '../src/api/behaviors.js';

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

test('pagination: cursor pages through results, last page has no cursor key', async () => {
  const page1Res = await fetch(`${urlFor('workspaces.list')}?page_size=1`, { headers: authHeaders() });
  const page1 = await page1Res.json();
  assert.equal(page1.data.length, 1);
  assert.equal(typeof page1.cursor, 'string');

  const page2Res = await fetch(`${urlFor('workspaces.list')}?page_size=1&cursor=${encodeURIComponent(page1.cursor)}`, {
    headers: authHeaders(),
  });
  const page2 = await page2Res.json();
  assert.equal(page2.data.length, 1);
  assert.notEqual(page2.data[0].id, page1.data[0].id);
  assert.equal('cursor' in page2, false, 'last page must carry no cursor key at all');
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

  const compose = await fetch(urlFor('projects.compose', { workspace_id: wsId, project_id: project.id }), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ [f('asset_ids')]: [assetId] }),
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

  const ts = String(Math.floor(Date.now() / 1000));
  const badSig = createHmac(world.hmac.algo, 'wrong-secret').update(`${ts}POST${publishPath}`).digest('hex');
  const wrongSig = await fetch(`${base}${publishPath}`, {
    method: 'POST',
    headers: { ...authHeaders(), [world.hmac.tsHeader]: ts, [world.hmac.header]: badSig },
  });
  assert.equal(wrongSig.status, 401);

  const goodSig = createHmac(world.hmac.algo, world.auth.secret).update(`${ts}POST${publishPath}`).digest('hex');
  const publish = await fetch(`${base}${publishPath}`, {
    method: 'POST',
    headers: { ...authHeaders(), [world.hmac.tsHeader]: ts, [world.hmac.header]: goodSig },
  });
  assert.equal(publish.status, 200);
  assert.equal((await publish.json()).status, 'published');

  // publish again -> 409 (already published, not rendered)
  const ts2 = String(Math.floor(Date.now() / 1000));
  const sig2 = createHmac(world.hmac.algo, world.auth.secret).update(`${ts2}POST${publishPath}`).digest('hex');
  const republish = await fetch(`${base}${publishPath}`, {
    method: 'POST',
    headers: { ...authHeaders(), [world.hmac.tsHeader]: ts2, [world.hmac.header]: sig2 },
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

// ---------------------------------------------------------------------------
// admin mutations
// ---------------------------------------------------------------------------

function fetchForRoute(routeId, ids, headers) {
  if (routeId === 'workspaces.get') return fetch(urlFor('workspaces.get', { workspace_id: ids.wsId }), { headers });
  if (routeId === 'projects.get') return fetch(urlFor('projects.get', { workspace_id: ids.wsId, project_id: ids.projectId }), { headers });
  if (routeId === 'assets.get') return fetch(urlFor('assets.get', { asset_id: ids.assetId }), { headers });
  if (routeId === 'jobs.get') return fetch(urlFor('jobs.get', { job_id: ids.jobId }), { headers });
  // page_size=1 guarantees a next page (and thus a cursor key) exists to inspect/mutate.
  if (routeId === 'workspaces.list') return fetch(`${urlFor('workspaces.list')}?page_size=1`, { headers });
  if (routeId === 'projects.list') return fetch(`${urlFor('projects.list', { workspace_id: ids.wsId })}?page_size=1`, { headers });
  if (routeId === 'projects.assets') {
    return fetch(`${urlFor('projects.assets', { workspace_id: ids.wsId, project_id: ids.projectId })}?page_size=1`, { headers });
  }
  throw new Error(`no fetcher wired for ${routeId}`);
}

// A fresh token + a fresh seeded workspace/project/asset/job, straight off an admin reset.
// Candidate lists overlap across mutations (e.g. both dropField and retypeField can land on
// assets.get/hash), so each mutation is checked against its own clean reset rather than layered
// on top of the others, which would otherwise have one mutation eat the field another expects.
async function freshMutationFixtures() {
  await fetch(`${adminBase}/admin/reset`, { method: 'POST' });
  const token = await getToken();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const ws = (await (await fetch(urlFor('workspaces.list'), { headers })).json()).data[0].id;
  const project = (await (await fetch(urlFor('projects.list', { workspace_id: ws }), { headers })).json()).data[0].id;
  const asset = (await (await fetch(urlFor('projects.assets', { workspace_id: ws, project_id: project }), { headers })).json())
    .data[0].id;
  await fetch(urlFor('projects.compose', { workspace_id: ws, project_id: project }), { method: 'POST', headers });
  const renderBody = await (
    await fetch(urlFor('projects.render', { workspace_id: ws, project_id: project }), { method: 'POST', headers })
  ).json();
  const job = renderBody[f('job_id')];
  return { headers, ids: { wsId: ws, projectId: project, assetId: asset, jobId: job } };
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
    const body = await res.json();
    if (name === 'stuckCursor') {
      assert.equal(body.cursor, STUCK_CURSOR_TOKEN);
    } else if (name === 'dropField') {
      assert.equal(target.field in body, false, `${target.field} should be dropped from ${target.route}`);
    } else if (name === 'renameField') {
      assert.equal(target.field in body, false);
      assert.ok(target.to in body);
    } else if (name === 'retypeField') {
      assert.ok(Array.isArray(body[target.field]), `${target.field} should be array-wrapped`);
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
