// Addendum E: POST /rungs/{n}/submit returns 422 problem+json and records NOTHING for a
// malformed body (invalid JSON, assets missing, assets not an array, an id that doesn't resolve)
// so a later correct submit to the same rung still works. Wrong count and wrong hash are real
// attempts: they are recorded as a fail. Also covers the admin request log's `ua` field and
// GET /admin/violations.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeWorld, resolvePath, fieldName } from '../src/world.js';
import { routes } from '../src/routes.js';
import { createServer } from '../src/api/server.js';

const SEED = 7;

let world;
let server;
let base;
let adminBase;

function f(name) {
  return fieldName(world, name);
}

function submitUrl(n) {
  const route = routes.find((r) => r.id === 'rungs.submit');
  return `${base}${resolvePath(world, route.path).replace('{n}', String(n))}`;
}

async function getToken() {
  const res = await fetch(`${base}/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [f('api_key')]: world.auth.apiKey }),
  });
  const body = await res.json();
  return body[f('access_token')];
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function createImage(token, params) {
  const res = await fetch(`${base}/images`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(params),
  });
  assert.equal(res.status, 201);
  return res.json();
}

// Sets the answer key for a single rung n, wiping every previously recorded submission for
// EVERY rung (admin.rungs.set resets state.rungs.submissions wholesale) -- so tests that need
// more than one rung's worth of history call this once with all the rungs they need, up front.
async function setRungs(rungs) {
  const res = await fetch(`${adminBase}/admin/rungs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rungs }),
  });
  assert.equal(res.status, 200);
}

async function submissionsFor(n) {
  const res = await fetch(`${adminBase}/admin/submissions`);
  const { data } = await res.json();
  return data.filter((s) => s.rung === n);
}

let token;
let assetId;
let assetHash;
let assetDescriptor;

test.before(async () => {
  world = makeWorld(SEED);
  server = createServer({ world, publicPort: 0, adminPort: 0 });
  const ports = await server.start();
  base = `http://127.0.0.1:${ports.publicPort}`;
  adminBase = `http://127.0.0.1:${ports.adminPort}`;
  token = await getToken();

  const asset = await createImage(token, { width: 16, height: 16, background: { transparent: true }, shapes: [] });
  assetId = asset.id;
  assetHash = asset.hash;
  assetDescriptor = asset.descriptor;

  await setRungs([
    { n: 0, text: 'invalid json', expected: [assetHash], expectedDescriptors: [assetDescriptor] },
    { n: 1, text: 'not an array', expected: [assetHash], expectedDescriptors: [assetDescriptor] },
    { n: 2, text: 'missing assets', expected: [assetHash], expectedDescriptors: [assetDescriptor] },
    { n: 3, text: 'unresolvable id', expected: [assetHash], expectedDescriptors: [assetDescriptor] },
    { n: 4, text: 'wrong count', expected: [assetHash, assetHash], expectedDescriptors: [assetDescriptor, assetDescriptor] },
    { n: 5, text: 'wrong hash', expected: ['sha256:not-the-real-hash'], expectedDescriptors: [assetDescriptor] },
    { n: 6, text: 'happy path', expected: [assetHash], expectedDescriptors: [assetDescriptor] },
  ]);
});

test.after(async () => {
  await server.stop();
});

test('submit: invalid JSON body is 422 and records nothing; a later correct submit still passes', async () => {
  const badRes = await fetch(submitUrl(0), {
    method: 'POST',
    headers: authHeaders(token),
    body: '{not json',
  });
  assert.equal(badRes.status, 422);
  assert.equal(badRes.headers.get('content-type'), 'application/problem+json');
  const badBody = await badRes.json();
  assert.ok(Array.isArray(badBody.errors) && badBody.errors.length > 0);
  assert.deepEqual(await submissionsFor(0), [], 'a malformed submission must record nothing');

  const goodRes = await fetch(submitUrl(0), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ assets: [assetId] }),
  });
  assert.equal(goodRes.status, 200);
  const goodBody = await goodRes.json();
  assert.equal(goodBody.pass, true);
  assert.equal((await submissionsFor(0)).length, 1, 'the correct submit is the only one recorded for this rung');
});

test('submit: assets not an array is 422 and records nothing; a later correct submit still passes', async () => {
  const badRes = await fetch(submitUrl(1), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ assets: assetId }),
  });
  assert.equal(badRes.status, 422);
  const badBody = await badRes.json();
  assert.equal(badBody.errors[0].field, 'assets');
  assert.deepEqual(await submissionsFor(1), []);

  const goodRes = await fetch(submitUrl(1), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ assets: [assetId] }),
  });
  assert.equal((await goodRes.json()).pass, true);
  assert.equal((await submissionsFor(1)).length, 1);
});

test('submit: missing assets field is 422 and records nothing; a later correct submit still passes', async () => {
  const badRes = await fetch(submitUrl(2), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({}),
  });
  assert.equal(badRes.status, 422);
  assert.deepEqual(await submissionsFor(2), []);

  // An empty body altogether (no Content-Type body at all) must behave the same as `{}`.
  const emptyRes = await fetch(submitUrl(2), { method: 'POST', headers: authHeaders(token) });
  assert.equal(emptyRes.status, 422);
  assert.deepEqual(await submissionsFor(2), []);

  const goodRes = await fetch(submitUrl(2), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ assets: [assetId] }),
  });
  assert.equal((await goodRes.json()).pass, true);
  assert.equal((await submissionsFor(2)).length, 1);
});

test('submit: an unresolvable asset id is 422 and records nothing; a later correct submit still passes', async () => {
  const badRes = await fetch(submitUrl(3), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ assets: ['does-not-exist'] }),
  });
  assert.equal(badRes.status, 422);
  assert.equal(badRes.headers.get('content-type'), 'application/problem+json');
  assert.deepEqual(await submissionsFor(3), []);

  const goodRes = await fetch(submitUrl(3), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ assets: [assetId] }),
  });
  assert.equal((await goodRes.json()).pass, true);
  assert.equal((await submissionsFor(3)).length, 1);
});

test('submit: wrong count is a real attempt -- recorded as a fail, not a 422', async () => {
  const res = await fetch(submitUrl(4), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ assets: [assetId] }), // rung 4 expects two hashes
  });
  assert.equal(res.status, 200, 'a resolvable but wrong submission is a normal 200, never a 422');
  const body = await res.json();
  assert.equal(body.pass, false);
  const recorded = await submissionsFor(4);
  assert.equal(recorded.length, 1, 'a wrong-count attempt is recorded');
  assert.equal(recorded[0].pass, false);
});

test('submit: wrong hash is a real attempt -- recorded as a fail, not a 422', async () => {
  const res = await fetch(submitUrl(5), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ assets: [assetId] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pass, false);
  const recorded = await submissionsFor(5);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].pass, false);
});

test('submit: happy path passes and is recorded once; a second submit to the same rung is 409', async () => {
  const res = await fetch(submitUrl(6), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ assets: [assetId] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pass, true);
  assert.equal(body.rung, 6);
  const recorded = await submissionsFor(6);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].pass, true);
  assert.deepEqual(recorded[0].submittedHashes, [assetHash]);

  const dupe = await fetch(submitUrl(6), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ assets: [assetId] }),
  });
  assert.equal(dupe.status, 409, 'one submission per rung, even after a pass');
});

// ---------------------------------------------------------------------------
// admin log User-Agent + /admin/violations
// ---------------------------------------------------------------------------

test('admin log: records the User-Agent per request, and /admin/violations flags non-bru callers', async () => {
  const freshWorld = makeWorld(SEED + 1);
  const freshServer = createServer({ world: freshWorld, publicPort: 0, adminPort: 0 });
  const ports = await freshServer.start();
  const freshBase = `http://127.0.0.1:${ports.publicPort}`;
  const freshAdmin = `http://127.0.0.1:${ports.adminPort}`;

  try {
    await fetch(`${freshBase}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'bruno-runtime/1.0.0' },
      body: JSON.stringify({ [fieldName(freshWorld, 'api_key')]: freshWorld.auth.apiKey }),
    });
    await fetch(`${freshBase}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'curl/8.0' },
      body: JSON.stringify({ [fieldName(freshWorld, 'api_key')]: freshWorld.auth.apiKey }),
    });
    await fetch(`${freshBase}/auth/token`, {
      method: 'POST',
      // Node's own fetch stamps a default `User-Agent: node` when none is set explicitly, which
      // is itself a fine stand-in for "no header at all": either way it isn't `bruno-runtime/`.
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [fieldName(freshWorld, 'api_key')]: freshWorld.auth.apiKey }),
    });

    const logRes = await fetch(`${freshAdmin}/admin/log`);
    assert.equal(logRes.status, 200);
    const log = (await logRes.json()).data;
    assert.equal(log.length, 3);
    assert.deepEqual(
      log.map((e) => e.ua),
      ['bruno-runtime/1.0.0', 'curl/8.0', 'node'],
    );
    // admin/log stays exactly the shape it always was, plus this field.
    for (const entry of log) {
      assert.equal(typeof entry.method, 'string');
      assert.equal(typeof entry.path, 'string');
      assert.equal(typeof entry.status, 'number');
      assert.equal(typeof entry.ms, 'number');
      assert.ok('tokenId' in entry);
    }

    const violRes = await fetch(`${freshAdmin}/admin/violations`);
    assert.equal(violRes.status, 200);
    const violations = await violRes.json();
    assert.equal(violations.count, 2, 'curl and the missing-header request are both violations');
    assert.equal(violations.samples.length, 2);
    assert.ok(violations.samples.every((s) => 'ua' in s && 'path' in s));
    assert.ok(!violations.samples.some((s) => s.ua === 'bruno-runtime/1.0.0'));
  } finally {
    await freshServer.stop();
  }
});

// Addendum K: axios/* User-Agents are bru's own pre/post-request script sandbox reaching the
// network on the agent's behalf, not the agent bypassing bru -- they must count separately as
// scriptRequests, never fold into violations.count, and never appear in the violations samples.
test('admin/violations: axios/* requests count as scriptRequests, not violations', async () => {
  const freshWorld = makeWorld(SEED + 2);
  const freshServer = createServer({ world: freshWorld, publicPort: 0, adminPort: 0 });
  const ports = await freshServer.start();
  const freshBase = `http://127.0.0.1:${ports.publicPort}`;
  const freshAdmin = `http://127.0.0.1:${ports.adminPort}`;

  try {
    await fetch(`${freshBase}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'bruno-runtime/1.0.0' },
      body: JSON.stringify({ [fieldName(freshWorld, 'api_key')]: freshWorld.auth.apiKey }),
    });
    await fetch(`${freshBase}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'axios/1.16.0' },
      body: JSON.stringify({ [fieldName(freshWorld, 'api_key')]: freshWorld.auth.apiKey }),
    });
    await fetch(`${freshBase}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'curl/8.0' },
      body: JSON.stringify({ [fieldName(freshWorld, 'api_key')]: freshWorld.auth.apiKey }),
    });

    const violRes = await fetch(`${freshAdmin}/admin/violations`);
    assert.equal(violRes.status, 200);
    const body = await violRes.json();
    assert.equal(body.count, 1, 'only curl is a real violation; axios and bruno-runtime are not');
    assert.ok(!body.samples.some((s) => (s.ua || '').startsWith('axios/')), 'axios must never appear in violation samples');
    assert.equal(body.scriptRequests, 1);
    assert.equal(body.scriptSamples.length, 1);
    assert.equal(body.scriptSamples[0].ua, 'axios/1.16.0');
  } finally {
    await freshServer.stop();
  }
});
