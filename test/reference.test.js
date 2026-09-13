// The gate: for seeds 1, 2, 3, start a real in-process server, post the answer key computed
// purely from the world, then climb rungs 0..99 for real over HTTP and require zero failures.
// A failure here means the ladder generator (or, occasionally, the API) has a bug -- not that the
// task was merely hard, since the reference is handed the exact plan it needs to execute.
//
// Addendum J adds two obligations to that gate:
//   * The climb drives `/admin/rungs/advance` in step with itself, so each rung's ANNOUNCED
//     mutation (Addendum J rule 3) is live for the whole of that rung. A rung the reference
//     cannot pass under its own announced change is a generator bug, and nothing else would
//     catch it.
//   * The climb resolves cross-rung references (rule 1) out of its own history of what it turned
//     in, so the gate exercises the same memory the agent is expected to keep rather than a
//     recomputation that could agree with a broken key.
//
// The three seeds run concurrently: each climb is almost entirely time spent asleep against the
// house rate limiter, so running them in parallel costs nothing and cuts the gate's wall clock
// by three. It is still the slowest thing in the suite by a wide margin -- 0.5.0 rungs run 10 to
// 30 steps each, which is roughly 2,500 real HTTP calls per seed, metered by a house rate limit
// of 20 to 60 requests per ten seconds depending on the seed. Tens of minutes is NORMAL here and
// is not the gate hanging; run it with a generous --test-timeout.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeWorld, RUNG_MUTATION_POOL } from '../src/world.js';
import { createServer } from '../src/api/server.js';
import { climb, answerKey } from '../src/ladder/reference.js';

async function postAdminJson(adminPort, path, body) {
  const res = await fetch(`http://127.0.0.1:${adminPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`admin ${path} -> ${res.status}`);
  return res.json();
}

async function climbSeed(seed, { from = 0, to = 99, mutate } = {}) {
  const world = makeWorld(seed);
  const server = createServer({ world, publicPort: 0, adminPort: 0 });
  const { publicPort, adminPort } = await server.start();
  try {
    await postAdminJson(adminPort, '/admin/rungs', answerKey(world));
    if (mutate) await postAdminJson(adminPort, '/admin/mutate', { name: mutate });
    return await climb({
      world,
      baseUrl: `http://127.0.0.1:${publicPort}`,
      adminBaseUrl: `http://127.0.0.1:${adminPort}`,
      apiKey: world.auth.apiKey,
      from,
      to,
      // `POST /admin/rungs/advance` replaces the server's active mutation set with whatever rung n
      // naturally announces (nothing, below FIRST_MUTATION_RUNG), so the mutation forced above gets
      // wiped out the moment the climb advances past rung 1. Re-force it live for every rung this
      // climb actually submits against.
      onRungReady: mutate ? () => postAdminJson(adminPort, '/admin/mutate', { name: mutate }) : undefined,
    });
  } finally {
    await server.stop();
  }
}

function assertClean(seed, result, expected) {
  if (result.failed.length > 0) {
    assert.fail(`seed ${seed}: ${result.failed.length} rungs failed, first: ${JSON.stringify(result.failed.slice(0, 5))}`);
  }
  assert.equal(result.passed.length, expected);
}

test('reference climbs 0..99 clean on seeds 1, 2 and 3', { concurrency: true }, async (t) => {
  await Promise.all([1, 2, 3].map((seed) => t.test(`seed ${seed}`, async () => {
    assertClean(seed, await climbSeed(seed), 100);
  })));
});

// Addendum J rule 3 in its strongest form: the announced change never makes a rung unpassable.
// Each mutation in the pool is forced live for a slice of the ladder and the reference must still
// come through it. This is the check that keeps `rejectAuth` and `stuckCursor` out of the pool:
// either of them here would fail loudly rather than quietly making a rung unclimbable in a run.
test('every announced mutation leaves the ladder passable', { concurrency: true }, async (t) => {
  const slices = [[30, 33], [40, 43], [50, 53], [60, 63]];
  await Promise.all(RUNG_MUTATION_POOL.map((mutation, i) => t.test(mutation, async () => {
    const [from, to] = slices[i % slices.length];
    const result = await climbSeed(1, { from, to, mutate: mutation });
    assertClean(1, result, to - from + 1);
  })));
});
