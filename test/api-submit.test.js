// Addendum E: POST /rungs/{n}/submit returns 422 problem+json and records NOTHING for a
// malformed body (invalid JSON, assets missing, assets not an array, an id that doesn't resolve)
// so a later correct submit to the same rung still works. Wrong count and wrong hash are real
// attempts: they are recorded as a fail. Also covers the admin request log's `ua` field and
// GET /admin/violations.
//
// Addendum O, "grade the chain": from rung 20 up (Addendum T; was 50) an answer key entry may
// also carry expectedProjectState/expectedLabel (src/ladder/rung.js's answer-key shape). A submit
// then passes only if the hash matches AND the submitted asset's project reached that state
// (through compose -> render -> publish, in order) AND the asset's display name equals the label
// written under If-Match -- and the response/recorded submission say which of the three failed.
// Tested here on rungs well under 20 (the check itself doesn't care what rung number it's
// attached to; the ladder workstream is what restricts it to 20+ in practice) so this file
// doesn't have to duplicate the full 100-rung ladder to prove the three-way check.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { makeWorld, resolvePath, fieldName } from '../src/world.js';
import { routes } from '../src/routes.js';
import { createServer } from '../src/api/server.js';
import { publishHeaders } from './fixtures/sign.js';

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

function routeTemplate(id) {
  return resolvePath(world, routes.find((r) => r.id === id).path);
}

function withParams(template, params) {
  let out = template;
  for (const [k, v] of Object.entries(params)) out = out.replace(`{${k}}`, encodeURIComponent(v));
  return out;
}

function urlFor(id, params = {}) {
  return `${base}${withParams(routeTemplate(id), params)}`;
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

// Addendum Q rule 3: ETag is a header-only value now (never repeated in the body) -- merge it in
// here so every caller below that reads `created.etag` keeps working unchanged.
async function createImage(token, params) {
  const res = await fetch(`${base}/images`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(params),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  return { ...body, etag: res.headers.get('etag') };
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

// Addendum N: `state.rungs.current` only ever moves via /admin/rungs/advance. Every test below
// submits against the CURRENT rung, so each move to the next rung number in the sequence calls
// this once first.
async function advanceRung() {
  const res = await fetch(`${adminBase}/admin/rungs/advance`, { method: 'POST' });
  assert.equal(res.status, 200);
  return res.json();
}

// walkProjectTo(status, token, wsId, assetId): drives a fresh project through
// draft -> composed -> [rendered] -> [published] up to (and including) `status`, composing in
// `assetId` along the way. Used to build the Addendum O chain-grading fixtures below: a
// submission's expectedProjectState is checked against the STATUS the submitted asset's project
// actually reached, and the only way to reach `published` at all is compose -> render -> publish
// in that order (each 409s out of turn), so "reached `rendered`" and "reached `published`" are
// each built by simply stopping the walk at the right step.
async function walkProjectTo(status, token, wsId, assetId) {
  const created = await fetch(urlFor('projects.create', { workspace_id: wsId }), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ [f('name')]: `chain-grading fixture (${status})` }),
  });
  const project = await created.json();

  const compose = await fetch(urlFor('projects.compose', { workspace_id: wsId, project_id: project.id }), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ [f('asset_ids')]: [assetId] }),
  });
  assert.equal(compose.status, 200);
  if (status === 'composed') return project.id;

  const render = await fetch(urlFor('projects.render', { workspace_id: wsId, project_id: project.id }), {
    method: 'POST',
    headers: authHeaders(token),
  });
  assert.equal(render.status, 202);
  const location = render.headers.get('location');
  // jobs.get's status ladder is queued -> running -> done, one step per poll (see server.js's
  // jobs.get handler): three polls always reaches 'done'. project.status itself already flipped
  // to 'rendered' synchronously inside projects.render above, and publish gates on THAT, not on
  // the job -- polling to completion here is just exercising the documented flow faithfully.
  await fetch(`${base}${location}`, { headers: authHeaders(token) });
  await fetch(`${base}${location}`, { headers: authHeaders(token) });
  await fetch(`${base}${location}`, { headers: authHeaders(token) });
  if (status === 'rendered') return project.id;

  const publishPath = withParams(routeTemplate('projects.publish'), { workspace_id: wsId, project_id: project.id });
  // RULES-0.8 rule 35: the release signature binds the house's own digest of the artifact being
  // released, and the house checks that digest names a live asset in THIS project -- which the
  // composed asset is. Its digest is the `hash` the house reports for it.
  const asset = await (await fetch(urlFor('assets.get', { asset_id: assetId }), { headers: authHeaders(token) })).json();
  const publish = await fetch(`${base}${publishPath}`, {
    method: 'POST',
    headers: { ...authHeaders(token), ...publishHeaders(world, { path: publishPath, bodyDigest: asset.hash }) },
  });
  assert.equal(publish.status, 200, `publish: ${JSON.stringify(await publish.clone().json())}`);
  assert.equal((await publish.json()).status, 'published');
  return project.id;
}

async function patchLabel(token, assetId, etag, label) {
  const res = await fetch(urlFor('assets.patch', { asset_id: assetId }), {
    method: 'PATCH',
    headers: { ...authHeaders(token), 'if-match': etag },
    body: JSON.stringify({ [f('display_name')]: label }),
  });
  assert.equal(res.status, 200);
}

let token;
let assetId;
let assetHash;
let assetDescriptor;
// Addendum O chain-grading fixtures, built once up front alongside everything else the initial
// setRungs() call below needs -- see the rung comments for which of the three checks each one
// isolates.
let chainPassAsset;
let chainStateFailAsset;
let chainLabelFailAsset;
let chainHashFailAsset;
const CHAIN_LABEL = 'quartz';

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

  const wsListRes = await fetch(urlFor('workspaces.list'), { headers: authHeaders(token) });
  const wsId = (await wsListRes.json()).data[0].id;

  // Each fixture below runs 7-8 requests (create, patch, compose, render, three job polls,
  // publish) through the state machine -- comfortably under world.rate.limit per token on its
  // own, but not shared with `token`, which the numbered-rung tests further down also spend
  // against across the same 10-second window. A fresh token per fixture keeps this setup from
  // ever tripping the very rate limit Addendum-era tests elsewhere exist to prove works.

  // n=9: every check holds -- the control case a strict three-way AND has to still pass.
  const t9 = await getToken();
  chainPassAsset = await createImage(t9, { width: 8, height: 8, background: { transparent: true }, shapes: [] });
  await patchLabel(t9, chainPassAsset.id, chainPassAsset.etag, CHAIN_LABEL);
  await walkProjectTo('published', t9, wsId, chainPassAsset.id);

  // n=10: hash and label are right, but the project only ever reached 'rendered' -- isolates the
  // project-state check.
  const t10 = await getToken();
  chainStateFailAsset = await createImage(t10, { width: 8, height: 8, background: { transparent: true }, shapes: [] });
  await patchLabel(t10, chainStateFailAsset.id, chainStateFailAsset.etag, CHAIN_LABEL);
  await walkProjectTo('rendered', t10, wsId, chainStateFailAsset.id);

  // n=11: hash and project state are right, but the display name was never patched to the
  // expected word -- isolates the label check.
  const t11 = await getToken();
  chainLabelFailAsset = await createImage(t11, { width: 8, height: 8, background: { transparent: true }, shapes: [] });
  await walkProjectTo('published', t11, wsId, chainLabelFailAsset.id);

  // n=12: project state and label are right, but the submitted hash is wrong -- proves the hash
  // check still gates the other two rather than being made redundant by them.
  const t12 = await getToken();
  chainHashFailAsset = await createImage(t12, { width: 8, height: 8, background: { transparent: true }, shapes: [] });
  await patchLabel(t12, chainHashFailAsset.id, chainHashFailAsset.etag, CHAIN_LABEL);
  await walkProjectTo('published', t12, wsId, chainHashFailAsset.id);

  await setRungs([
    { n: 0, text: 'invalid json', expected: [assetHash], expectedDescriptors: [assetDescriptor] },
    { n: 1, text: 'not an array', expected: [assetHash], expectedDescriptors: [assetDescriptor] },
    { n: 2, text: 'missing assets', expected: [assetHash], expectedDescriptors: [assetDescriptor] },
    { n: 3, text: 'unresolvable id', expected: [assetHash], expectedDescriptors: [assetDescriptor] },
    { n: 4, text: 'wrong count', expected: [assetHash, assetHash], expectedDescriptors: [assetDescriptor, assetDescriptor] },
    { n: 5, text: 'wrong hash', expected: ['sha256:not-the-real-hash'], expectedDescriptors: [assetDescriptor] },
    { n: 6, text: 'happy path', expected: [assetHash], expectedDescriptors: [assetDescriptor] },
    { n: 7, text: 'non-current rung: future probe', expected: [assetHash], expectedDescriptors: [assetDescriptor] },
    { n: 8, text: 'non-current rung: stale probe', expected: [assetHash], expectedDescriptors: [assetDescriptor] },
    {
      n: 9,
      text: 'chain grading: everything holds',
      expected: [chainPassAsset.hash],
      expectedDescriptors: [chainPassAsset.descriptor],
      expectedProjectState: 'published',
      expectedLabel: CHAIN_LABEL,
    },
    {
      n: 10,
      text: 'chain grading: project never reached published',
      expected: [chainStateFailAsset.hash],
      expectedDescriptors: [chainStateFailAsset.descriptor],
      expectedProjectState: 'published',
      expectedLabel: CHAIN_LABEL,
    },
    {
      n: 11,
      text: 'chain grading: label never written',
      expected: [chainLabelFailAsset.hash],
      expectedDescriptors: [chainLabelFailAsset.descriptor],
      expectedProjectState: 'published',
      expectedLabel: CHAIN_LABEL,
    },
    {
      n: 12,
      text: 'chain grading: wrong hash despite a correct state and label',
      expected: ['sha256:not-the-real-hash'],
      expectedDescriptors: [chainHashFailAsset.descriptor],
      expectedProjectState: 'published',
      expectedLabel: CHAIN_LABEL,
    },
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
  await advanceRung(); // current: 0 -> 1
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
  await advanceRung(); // current: 1 -> 2
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
  await advanceRung(); // current: 2 -> 3
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
  await advanceRung(); // current: 3 -> 4
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
  await advanceRung(); // current: 4 -> 5
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
  await advanceRung(); // current: 5 -> 6
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

// Addendum N: a submission to a rung that is not the current rung is a 409, never a recorded
// fall -- a probe or stale client hitting a future or past rung must not be scored, and the
// current rung must still be submittable afterward.
test('submit: a future rung (current+5) is 409 and records nothing; a correct submit to the current rung still passes', async () => {
  await advanceRung(); // current: 6 -> 7
  const futureRes = await fetch(submitUrl(12), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ assets: [assetId] }),
  });
  assert.equal(futureRes.status, 409);
  assert.equal(futureRes.headers.get('content-type'), 'application/problem+json');
  const futureBody = await futureRes.json();
  assert.equal(futureBody.detail, 'rung 12 is not the current rung (7)');
  assert.deepEqual(await submissionsFor(12), [], 'a wrong-rung probe must record nothing');

  const goodRes = await fetch(submitUrl(7), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ assets: [assetId] }),
  });
  assert.equal(goodRes.status, 200);
  const goodBody = await goodRes.json();
  assert.equal(goodBody.pass, true);
  assert.equal((await submissionsFor(7)).length, 1, 'the correct submit to the current rung is the only one recorded');
});

test('submit: a past rung (current-1) is 409 and records nothing', async () => {
  await advanceRung(); // current: 7 -> 8
  const staleRes = await fetch(submitUrl(7), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ assets: [assetId] }),
  });
  assert.equal(staleRes.status, 409);
  assert.equal(staleRes.headers.get('content-type'), 'application/problem+json');
  const staleBody = await staleRes.json();
  assert.equal(staleBody.detail, 'rung 7 is not the current rung (8)');
  assert.equal((await submissionsFor(7)).length, 1, 'the stale probe must not add another submission for rung 7');

  const goodRes = await fetch(submitUrl(8), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ assets: [assetId] }),
  });
  assert.equal(goodRes.status, 200);
  assert.equal((await goodRes.json()).pass, true);
  assert.equal((await submissionsFor(8)).length, 1);
});

// ---------------------------------------------------------------------------
// Addendum O: chain grading -- hash AND project state AND label
// ---------------------------------------------------------------------------

test('submit: chain grading passes when the hash, the project state, and the label all hold', async () => {
  await advanceRung(); // current: 8 -> 9
  const res = await fetch(submitUrl(9), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ assets: [chainPassAsset.id] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pass, true);
  assert.deepEqual(body.checks, { hash: true, [f('project_state')]: true, label: true, audit: true, refusal: true });
  const recorded = await submissionsFor(9);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].pass, true);
  assert.deepEqual(recorded[0].checks, { hash: true, project_state: true, label: true, audit: true, refusal: true });
});

test('submit: chain grading fails, and names the project-state check, when the project never reached published', async () => {
  await advanceRung(); // current: 9 -> 10
  const res = await fetch(submitUrl(10), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ assets: [chainStateFailAsset.id] }),
  });
  assert.equal(res.status, 200, 'a resolvable but failing chain submission is a normal 200, never a 422');
  const body = await res.json();
  assert.equal(body.pass, false);
  assert.deepEqual(body.checks, { hash: true, [f('project_state')]: false, label: true, audit: true, refusal: true });
  const recorded = await submissionsFor(10);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].pass, false);
  assert.deepEqual(recorded[0].checks, { hash: true, project_state: false, label: true, audit: true, refusal: true });
});

test('submit: chain grading fails, and names the label check, when the display name was never written', async () => {
  await advanceRung(); // current: 10 -> 11
  const res = await fetch(submitUrl(11), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ assets: [chainLabelFailAsset.id] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pass, false);
  assert.deepEqual(body.checks, { hash: true, [f('project_state')]: true, label: false, audit: true, refusal: true });
  const recorded = await submissionsFor(11);
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0].checks, { hash: true, project_state: true, label: false, audit: true, refusal: true });
});

test('submit: chain grading fails on hash alone even when the project state and label are both correct', async () => {
  await advanceRung(); // current: 11 -> 12
  const res = await fetch(submitUrl(12), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ assets: [chainHashFailAsset.id] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pass, false);
  assert.deepEqual(body.checks, { hash: false, [f('project_state')]: true, label: true, audit: true, refusal: true });
});

test('submit: a rung whose answer key never mentions project state or label grades on hashes alone (checks are vacuously true)', async () => {
  await advanceRung(); // current: 12 -> 13
  await setRungs([
    { n: 13, text: 'no chain obligations', expected: [assetHash], expectedDescriptors: [assetDescriptor] },
  ]);
  // admin.rungs.set resets state.rungs.current to 0 -- put it back where this test needs it.
  for (let i = 0; i < 13; i += 1) await advanceRung();
  const res = await fetch(submitUrl(13), {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ assets: [assetId] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pass, true);
  assert.deepEqual(body.checks, { hash: true, [f('project_state')]: true, label: true, audit: true, refusal: true });
});

// ---------------------------------------------------------------------------
// Addendum Q rule 10, "grade the path": audit trail, negative-space refusal, HMAC body-digest
// ---------------------------------------------------------------------------
//
// Each test below calls setRungs with a single rung 0 (setRungs always resets state.rungs.current
// to 0, per admin.rungs.set), so no advanceRung() bookkeeping is needed -- unlike the shared rung
// sequence above, these are self-contained and do not depend on, or feed, one another.

async function freshWsId(t) {
  const res = await fetch(urlFor('workspaces.list'), { headers: authHeaders(t) });
  return (await res.json()).data[0].id;
}

test('submit: audit check passes when the project shows the exact expected stage sequence', async () => {
  const t = await getToken();
  const ws = await freshWsId(t);
  const auditAsset = await createImage(t, { width: 8, height: 8, background: { transparent: true }, shapes: [] });
  await walkProjectTo('published', t, ws, auditAsset.id);

  await setRungs([
    {
      n: 0,
      text: 'audit check: everything holds',
      expected: [auditAsset.hash],
      expectedDescriptors: [auditAsset.descriptor],
      expectedAudit: { stages: ['draft', 'composed', 'rendering', 'rendered', 'published'] },
    },
  ]);

  const res = await fetch(submitUrl(0), {
    method: 'POST',
    headers: authHeaders(t),
    body: JSON.stringify({ assets: [auditAsset.id] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pass, true);
  assert.deepEqual(body.checks, { hash: true, [f('project_state')]: true, label: true, audit: true, refusal: true });
});

test('submit: audit check fails on a wrong sequence even though the hash and project state are both right', async () => {
  const t = await getToken();
  const ws = await freshWsId(t);
  const auditAsset = await createImage(t, { width: 9, height: 9, background: { transparent: true }, shapes: [] });
  await walkProjectTo('published', t, ws, auditAsset.id);

  await setRungs([
    {
      n: 0,
      text: 'audit check: a refusal that never happened',
      expected: [auditAsset.hash],
      expectedDescriptors: [auditAsset.descriptor],
      expectedAudit: { stages: ['draft', 'render:409', 'composed', 'rendering', 'rendered', 'published'] },
    },
  ]);

  const res = await fetch(submitUrl(0), {
    method: 'POST',
    headers: authHeaders(t),
    body: JSON.stringify({ assets: [auditAsset.id] }),
  });
  const body = await res.json();
  assert.equal(body.pass, false);
  assert.equal(body.checks.hash, true, 'the hash is still right -- only the path was wrong');
  assert.equal(body.checks.audit, false);
});

test('submit: refusal check fails when a live asset descends from a copy this project cleared out', async () => {
  const t = await getToken();
  const ws = await freshWsId(t);
  const source = await createImage(t, { width: 10, height: 10, background: { color: '#123456' }, shapes: [] });

  const created = await fetch(urlFor('projects.create', { workspace_id: ws }), {
    method: 'POST',
    headers: authHeaders(t),
    body: JSON.stringify({ [f('name')]: 'refusal fixture (violated)' }),
  });
  const project = await created.json();
  await fetch(urlFor('projects.compose', { workspace_id: ws, project_id: project.id }), {
    method: 'POST',
    headers: authHeaders(t),
    body: JSON.stringify({ [f('asset_ids')]: [source.id] }),
  });

  const styledRes = await fetch(urlFor('assets.lora', { asset_id: source.id }), {
    method: 'POST',
    headers: authHeaders(t),
    body: JSON.stringify({ [f('lora_id')]: world.loras[0].id }),
  });
  const derived = await styledRes.json();

  const del = await fetch(urlFor('assets.delete', { asset_id: source.id }), { method: 'DELETE', headers: authHeaders(t) });
  assert.equal(del.status, 204, 'the source must really be cleared out before the check matters');

  await setRungs([
    {
      n: 0,
      text: 'refusal check: violated',
      expected: [derived.hash],
      expectedDescriptors: [derived.descriptor],
      forbidden: { act: 'workOnClearedCopies', rule: 30, detail: 'no asset may exist that was made from a cleared-out copy' },
    },
  ]);

  const res = await fetch(submitUrl(0), {
    method: 'POST',
    headers: authHeaders(t),
    body: JSON.stringify({ assets: [derived.id] }),
  });
  const body = await res.json();
  assert.equal(body.checks.hash, true);
  assert.equal(body.checks.refusal, false);
  assert.equal(body.pass, false);
});

test('submit: refusal check passes when nothing live descends from a cleared-out copy', async () => {
  const t = await getToken();
  const ws = await freshWsId(t);
  const source = await createImage(t, { width: 11, height: 11, background: { color: '#654321' }, shapes: [] });
  const created = await fetch(urlFor('projects.create', { workspace_id: ws }), {
    method: 'POST',
    headers: authHeaders(t),
    body: JSON.stringify({ [f('name')]: 'refusal fixture (honoured)' }),
  });
  const project = await created.json();
  await fetch(urlFor('projects.compose', { workspace_id: ws, project_id: project.id }), {
    method: 'POST',
    headers: authHeaders(t),
    body: JSON.stringify({ [f('asset_ids')]: [source.id] }),
  });

  await setRungs([
    {
      n: 0,
      text: 'refusal check: honoured',
      expected: [source.hash],
      expectedDescriptors: [source.descriptor],
      forbidden: { act: 'workOnClearedCopies', rule: 30, detail: 'no asset may exist that was made from a cleared-out copy' },
    },
  ]);

  const res = await fetch(submitUrl(0), {
    method: 'POST',
    headers: authHeaders(t),
    body: JSON.stringify({ assets: [source.id] }),
  });
  const body = await res.json();
  assert.equal(body.checks.refusal, true);
  assert.equal(body.pass, true);
});

// world.hmac.canon defaults to the 0.6.0 recipe ('ts+method+path') -- see world.js's makeHmac and
// src/ladder/rung.js's "THE CANONICAL STRING" comment: flipping the default to the digest-bound
// 0.7.0 recipe is the ladder workstream's side of the contract, held back until this half (the API
// building its payload from `rulesAt(world, n).hmac.canon`) exists. Mutate the shared `world`
// in place for the span of this one test to prove that half works whenever the switch does flip.
test('submit: the digest-bound canon (ts+method+path+digest) verifies X-Body-Digest against a live asset', async () => {
  const originalCanon = world.hmac.canon;
  world.hmac.canon = 'ts+method+path+digest';
  try {
    const t = await getToken();
    const ws = await freshWsId(t);
    const asset = await createImage(t, { width: 12, height: 12, background: { color: '#abcdef' }, shapes: [] });
    const created = await fetch(urlFor('projects.create', { workspace_id: ws }), {
      method: 'POST',
      headers: authHeaders(t),
      body: JSON.stringify({ [f('name')]: 'hmac digest fixture' }),
    });
    const project = await created.json();
    await fetch(urlFor('projects.compose', { workspace_id: ws, project_id: project.id }), {
      method: 'POST',
      headers: authHeaders(t),
      body: JSON.stringify({ [f('asset_ids')]: [asset.id] }),
    });
    await fetch(urlFor('projects.render', { workspace_id: ws, project_id: project.id }), { method: 'POST', headers: authHeaders(t) });

    const publishPath = withParams(routeTemplate('projects.publish'), { workspace_id: ws, project_id: project.id });
    const ts = String(Math.floor(Date.now() / 1000));
    const canonical = `${ts}\nPOST\n${publishPath}\n${asset.hash}`;
    const sig = createHmac(world.hmac.algo, world.auth.secret).update(canonical).digest('hex');

    const missingDigest = await fetch(`${base}${publishPath}`, {
      method: 'POST',
      headers: { ...authHeaders(t), [world.hmac.tsHeader]: ts, [world.hmac.header]: sig },
    });
    assert.equal(missingDigest.status, 401, 'no X-Body-Digest at all must fail once the digest-bound recipe is live');

    const ts2 = String(Math.floor(Date.now() / 1000) + 1);
    const fakeDigest = '0'.repeat(64);
    const badCanonical = `${ts2}\nPOST\n${publishPath}\n${fakeDigest}`;
    const badSig = createHmac(world.hmac.algo, world.auth.secret).update(badCanonical).digest('hex');
    const wrongDigest = await fetch(`${base}${publishPath}`, {
      method: 'POST',
      headers: { ...authHeaders(t), [world.hmac.tsHeader]: ts2, [world.hmac.header]: badSig, 'X-Body-Digest': fakeDigest },
    });
    assert.equal(wrongDigest.status, 401, 'a digest naming no live asset in this project must fail');

    const good = await fetch(`${base}${publishPath}`, {
      method: 'POST',
      headers: { ...authHeaders(t), [world.hmac.tsHeader]: ts, [world.hmac.header]: sig, 'X-Body-Digest': asset.hash },
    });
    assert.equal(good.status, 200);
    assert.equal((await good.json()).status, 'published');
  } finally {
    world.hmac.canon = originalCanon;
  }
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
