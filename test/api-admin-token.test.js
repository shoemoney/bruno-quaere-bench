// Addendum J, "Admin port hardening": a native CLI has a shell, and the admin port answers on
// the loopback address that same shell can always reach. createServer({..., adminToken}) makes
// every admin request carry X-Admin-Token or be a 401; a miss is counted as `adminProbe`,
// exposed at GET /admin/violations alongside the existing rogue-User-Agent count. No adminToken
// (the default) must leave the port exactly as unauthenticated as it always was -- that half is
// covered elsewhere (test/api-submit.test.js talks to /admin/* with no token at all).

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeWorld, resolvePath, fieldName, FIRST_MUTATION_RUNG } from '../src/world.js';
import { routes } from '../src/routes.js';
import { createServer } from '../src/api/server.js';
import { mutationForRung, MUTATION_NAMES, chooseMutationTargets } from '../src/api/admin.js';

const SEED = 11;
const TOKEN = 'secret-run-token-abc123';

async function boot(opts = {}) {
  const world = makeWorld(SEED);
  const server = createServer({ world, publicPort: 0, adminPort: 0, ...opts });
  const ports = await server.start();
  return {
    world,
    server,
    adminBase: `http://127.0.0.1:${ports.adminPort}`,
    publicBase: `http://127.0.0.1:${ports.publicPort}`,
  };
}

// ---------------------------------------------------------------------------
// gating
// ---------------------------------------------------------------------------

test('adminToken configured: a request with no X-Admin-Token is 401 problem+json', async (t) => {
  const { server, adminBase } = await boot({ adminToken: TOKEN });
  t.after(() => server.stop());

  const res = await fetch(`${adminBase}/admin/world`);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('content-type').split(';')[0], 'application/problem+json');
  const body = await res.json();
  assert.equal(body.status, 401);
  assert.equal(typeof body.title, 'string');
});

test('adminToken configured: a wrong token is also 401, a correct token succeeds', async (t) => {
  const { server, adminBase, world } = await boot({ adminToken: TOKEN });
  t.after(() => server.stop());

  const wrong = await fetch(`${adminBase}/admin/world`, { headers: { 'x-admin-token': 'nope' } });
  assert.equal(wrong.status, 401);

  const right = await fetch(`${adminBase}/admin/world`, { headers: { 'x-admin-token': TOKEN } });
  assert.equal(right.status, 200);
  const body = await right.json();
  assert.equal(body.seed, world.seed);
});

test('adminToken configured: gating applies to every admin route, including ones that would otherwise 404', async (t) => {
  const { server, adminBase } = await boot({ adminToken: TOKEN });
  t.after(() => server.stop());

  // A path with no matching admin route still must not leak past the token check: it should
  // read as 401 (unauthenticated), never 404 (route-not-found), when no token is presented --
  // the gate runs before routing.
  const res = await fetch(`${adminBase}/admin/does-not-exist`);
  assert.equal(res.status, 401);

  // With the right token, the same nonexistent path falls through to the router's own 404.
  const withToken = await fetch(`${adminBase}/admin/does-not-exist`, { headers: { 'x-admin-token': TOKEN } });
  assert.equal(withToken.status, 404);
});

test('no adminToken configured: admin routes work exactly as before, unauthenticated', async (t) => {
  const { server, adminBase } = await boot();
  t.after(() => server.stop());

  const res = await fetch(`${adminBase}/admin/world`);
  assert.equal(res.status, 200);
});

// ---------------------------------------------------------------------------
// adminProbe counting, exposed at GET /admin/violations
// ---------------------------------------------------------------------------

// Field shape here (`adminProbes` as a flat top-level number, `adminProbeSamples` as the sample
// list) matches what src/harness/run.js and run-cli.js already read from this endpoint
// (`violationsBody.adminProbes`) -- see test/harness-hardening.test.js, a different workstream's
// test written against this same contract.
test('adminProbe: every rejected admin request is counted and sampled at GET /admin/violations', async (t) => {
  const { server, adminBase } = await boot({ adminToken: TOKEN });
  t.after(() => server.stop());

  await fetch(`${adminBase}/admin/world`); // no header at all
  await fetch(`${adminBase}/admin/log`, { headers: { 'x-admin-token': 'wrong-1' } });
  await fetch(`${adminBase}/admin/submissions`, { headers: { 'x-admin-token': 'wrong-2' } });

  const res = await fetch(`${adminBase}/admin/violations`, { headers: { 'x-admin-token': TOKEN } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.adminProbes, 3);
  assert.equal(body.adminProbeSamples.length, 3);
  const paths = body.adminProbeSamples.map((s) => s.path).sort();
  assert.deepEqual(paths, ['/admin/log', '/admin/submissions', '/admin/world'].sort());
  for (const s of body.adminProbeSamples) {
    assert.equal(typeof s.method, 'string');
    assert.equal(typeof s.path, 'string');
  }
  // the existing rogue-User-Agent count keeps its own shape, untouched by adminProbes
  assert.equal(body.count, 0);
  assert.deepEqual(body.samples, []);
});

test('adminProbe: capped sample list, exhaustive count, same MAX as the existing violations list', async (t) => {
  const { server, adminBase } = await boot({ adminToken: TOKEN });
  t.after(() => server.stop());

  for (let i = 0; i < 25; i += 1) {
    await fetch(`${adminBase}/admin/world`);
  }
  const res = await fetch(`${adminBase}/admin/violations`, { headers: { 'x-admin-token': TOKEN } });
  const body = await res.json();
  assert.equal(body.adminProbes, 25);
  assert.equal(body.adminProbeSamples.length, 20);
});

test('adminProbe: reset() clears the counter along with everything else it clears', async (t) => {
  const { server, adminBase } = await boot({ adminToken: TOKEN });
  t.after(() => server.stop());

  await fetch(`${adminBase}/admin/world`);
  await fetch(`${adminBase}/admin/world`);
  const before = await (await fetch(`${adminBase}/admin/violations`, { headers: { 'x-admin-token': TOKEN } })).json();
  assert.equal(before.adminProbes, 2);

  const reset = await fetch(`${adminBase}/admin/reset`, { method: 'POST', headers: { 'x-admin-token': TOKEN } });
  assert.equal(reset.status, 200);

  const after = await (await fetch(`${adminBase}/admin/violations`, { headers: { 'x-admin-token': TOKEN } })).json();
  assert.equal(after.adminProbes, 0);
});

test('a correctly-authenticated admin call is never itself counted as a probe', async (t) => {
  const { server, adminBase } = await boot({ adminToken: TOKEN });
  t.after(() => server.stop());

  for (let i = 0; i < 5; i += 1) {
    const res = await fetch(`${adminBase}/admin/log`, { headers: { 'x-admin-token': TOKEN } });
    assert.equal(res.status, 200);
  }
  const body = await (await fetch(`${adminBase}/admin/violations`, { headers: { 'x-admin-token': TOKEN } })).json();
  assert.equal(body.adminProbes, 0);
});

// ---------------------------------------------------------------------------
// per-rung announced mutation, applied on advance, reading world.rungMutations
// ---------------------------------------------------------------------------

test('mutationForRung: real makeWorld() output, indexed by rung number per the world.js contract', () => {
  const world = makeWorld(SEED);
  assert.ok(Array.isArray(world.rungMutations), 'makeWorld must populate rungMutations');
  assert.equal(world.rungMutations.length, 100);
  for (let n = 0; n < FIRST_MUTATION_RUNG; n += 1) {
    assert.equal(world.rungMutations[n], null, `rung ${n} is below FIRST_MUTATION_RUNG, must announce nothing`);
    assert.equal(mutationForRung(world, n), null);
  }
  for (let n = 0; n < 100; n += 1) {
    const entry = world.rungMutations[n];
    if (entry) {
      assert.equal(entry.n, n);
      assert.equal(mutationForRung(world, n), entry.mutation);
      assert.ok(MUTATION_NAMES.includes(entry.mutation), `rung ${n} announces an unknown mutation ${entry.mutation}`);
    } else {
      assert.equal(mutationForRung(world, n), null);
    }
  }
});

test('mutationForRung: a world with no rungMutations array at all is a no-op (defensive, hand-built fixtures)', () => {
  assert.equal(mutationForRung({}, 40), null);
  assert.equal(mutationForRung(undefined, 40), null);
});

test('advancing to an announced rung activates the mutation and reports it in the response', async (t) => {
  const world = makeWorld(SEED);
  world.rungMutations = [null, { n: 1, mutation: 'dropField' }];
  const server = createServer({ world, publicPort: 0, adminPort: 0, adminToken: TOKEN });
  const ports = await server.start();
  t.after(() => server.stop());
  const adminBase = `http://127.0.0.1:${ports.adminPort}`;

  const advance = await fetch(`${adminBase}/admin/rungs/advance`, {
    method: 'POST',
    headers: { 'x-admin-token': TOKEN },
  });
  assert.equal(advance.status, 200);
  const body = await advance.json();
  assert.equal(body.current, 1);
  assert.equal(body.mutationApplied, 'dropField');
});

test('advancing to a rung with no announced mutation applies nothing and says so', async (t) => {
  const world = makeWorld(SEED);
  world.rungMutations = [null, null, null, null, null, { n: 5, mutation: 'dropField' }];
  const server = createServer({ world, publicPort: 0, adminPort: 0, adminToken: TOKEN });
  const ports = await server.start();
  t.after(() => server.stop());
  const adminBase = `http://127.0.0.1:${ports.adminPort}`;

  const advance = await fetch(`${adminBase}/admin/rungs/advance`, {
    method: 'POST',
    headers: { 'x-admin-token': TOKEN },
  });
  const body = await advance.json();
  assert.equal(body.current, 1);
  assert.equal(body.mutationApplied, null);
});

test('an unknown mutation name in rungMutations is never applied (defensive against a bad seed)', async (t) => {
  const world = makeWorld(SEED);
  world.rungMutations = [null, { n: 1, mutation: 'not-a-real-mutation' }];
  assert.ok(!MUTATION_NAMES.includes('not-a-real-mutation'));
  const server = createServer({ world, publicPort: 0, adminPort: 0, adminToken: TOKEN });
  const ports = await server.start();
  t.after(() => server.stop());
  const adminBase = `http://127.0.0.1:${ports.adminPort}`;

  const advance = await fetch(`${adminBase}/admin/rungs/advance`, {
    method: 'POST',
    headers: { 'x-admin-token': TOKEN },
  });
  const body = await advance.json();
  assert.equal(body.mutationApplied, null);
});

// The world.js contract (see makeRungMutations) is explicit: the announced mutation REPLACES the
// active set, live from the first request of the new rung -- it must never accumulate across
// rungs, and must clear even a mutation someone set by hand via POST /admin/mutate.
// Addendum Q rule 2: dropField never targets `projects.render`'s `job_id` -- it was the obvious
// choice and is exactly the wrong one (see RUNG_MUTATION_TARGETS in src/world.js): with no jobs
// listing, a dropped job id is unrecoverable and every rung that renders becomes unpassable. That
// route is a `renameField` target instead (recoverable: `reference.js` falls back through
// `jobId`/`job`). `assets.combine`'s `descriptor` IS a dropField target and is recoverable -- ask
// `assets.get` for the asset whose id the reply did hand back -- so the rung still has a correct
// path through it.
async function fetchDropFieldTarget(world, publicBase, target) {
  if (target.route !== 'assets.combine') {
    throw new Error(`fetchDropFieldTarget: no fetcher wired for dropField target route ${target.route}`);
  }
  const f = (n) => fieldName(world, n);
  const tmpl = (id) => resolvePath(world, routes.find((r) => r.id === id).path);
  const mint = async () => {
    const res = await fetch(`${publicBase}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [f('api_key')]: world.auth.apiKey }),
    });
    return (await res.json())[f('access_token')];
  };
  const headers = { authorization: `Bearer ${await mint()}`, 'content-type': 'application/json' };
  const post = async (path, body) => fetch(`${publicBase}${path}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });

  // `background` is required on some seeds (the `optionalIsRequired` trap), so state it always --
  // a 422 body has no `descriptor` either, and would make the dropField assertion below pass for
  // entirely the wrong reason.
  const mkImage = async () => {
    const res = await post(tmpl('images.create'), {
      [f('width')]: 32,
      [f('height')]: 32,
      [f('background')]: { [f('color')]: '#112233' },
      [f('shapes')]: [],
    });
    const body = await res.json();
    assert.equal(res.status, 201, `images.create fixture: ${JSON.stringify(body)}`);
    return body.id;
  };
  const a = await mkImage();
  const b = await mkImage();
  const res = await post(tmpl('assets.combine'), { [f('ids')]: [a, b], [f('mode')]: 'layer' });
  const body = await res.json();
  assert.equal(res.status, 201, `assets.combine fixture: ${JSON.stringify(body)}`);
  return body;
}

// The world.js contract (see makeRungMutations) is explicit: the announced mutation REPLACES the
// active set, live from the first request of the new rung -- it must never accumulate across
// rungs, and must clear even a mutation someone set by hand via POST /admin/mutate.
test("replace semantics: a rung's announced mutation clears a manually-set one, and does not leak into the next rung", async (t) => {
  const world = makeWorld(SEED);
  const dropTarget = chooseMutationTargets(world, 1).dropField; // {route: 'assets.combine', field: 'descriptor'}
  world.rungMutations = [null, { n: 1, mutation: 'dropField' }, null];
  const server = createServer({ world, publicPort: 0, adminPort: 0, adminToken: TOKEN });
  const ports = await server.start();
  t.after(() => server.stop());
  const adminBase = `http://127.0.0.1:${ports.adminPort}`;
  const publicBase = `http://127.0.0.1:${ports.publicPort}`;

  // Manually activate a DIFFERENT mutation before any rung advance.
  const manual = await fetch(`${adminBase}/admin/mutate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify({ name: 'renameField' }),
  });
  assert.equal(manual.status, 200);

  // Advance to rung 1 (announces dropField): the manual renameField must be gone, dropField live.
  const adv1 = await fetch(`${adminBase}/admin/rungs/advance`, { method: 'POST', headers: { 'x-admin-token': TOKEN } });
  assert.equal((await adv1.json()).mutationApplied, 'dropField');
  const body1 = await fetchDropFieldTarget(world, publicBase, dropTarget);
  assert.ok(!(fieldName(world, dropTarget.field) in body1), `rung 1: ${dropTarget.field} should be dropped, got ${JSON.stringify(body1)}`);

  // Advance to rung 2 (announces nothing): rung 1's dropField must not leak forward.
  const adv2 = await fetch(`${adminBase}/admin/rungs/advance`, { method: 'POST', headers: { 'x-admin-token': TOKEN } });
  assert.equal((await adv2.json()).mutationApplied, null);
  const body2 = await fetchDropFieldTarget(world, publicBase, dropTarget);
  assert.ok(fieldName(world, dropTarget.field) in body2, `rung 2: ${dropTarget.field} must be present again, got ${JSON.stringify(body2)}`);
});
