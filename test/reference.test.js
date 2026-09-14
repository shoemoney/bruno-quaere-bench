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
//     recomputation that could agree with a broken key. Addendum O makes that strict: there is no
//     recomputation fallback in the climb path any more, so a borrowed value the climb could not
//     actually retrieve is a loud failure instead of a quiet pass.
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
import { composePlan } from '../src/ladder/grammar.js';
import { climb, answerKey, recallFallbackResolver } from '../src/ladder/reference.js';

async function postAdminJson(adminPort, path, body) {
  const res = await fetch(`http://127.0.0.1:${adminPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`admin ${path} -> ${res.status}`);
  return res.json();
}

async function climbSeed(seed, { from = 0, to = 99, mutate, resolveMissingRecall } = {}) {
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
      resolveMissingRecall,
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
//
// Each slice is a four-rung climb started mid-ladder, so it cannot possibly hold the submission
// history a rule-1 cross-rung reference reads from -- every rung in the 60-63 slice, for one,
// borrows dims from a rung in the twenties or thirties. That is exactly the case Addendum O's
// `recallFallbackResolver` exists for, and this test names it explicitly rather than getting it
// for free: the strict path is what the full 0..99 climbs above and the two dedicated tests below
// gate. What this test is asking is whether a forced mutation makes a rung unpassable, and a
// borrowed value it was never in a position to remember is not that question.
test('every announced mutation leaves the ladder passable', { concurrency: true }, async (t) => {
  const slices = [[30, 33], [40, 43], [50, 53], [60, 63]];
  await Promise.all(RUNG_MUTATION_POOL.map((mutation, i) => t.test(mutation, async () => {
    const [from, to] = slices[i % slices.length];
    const result = await climbSeed(1, {
      from, to, mutate: mutation, resolveMissingRecall: recallFallbackResolver(makeWorld(1)),
    });
    assertClean(1, result, to - from + 1);
  })));
});

// ---------------------------------------------------------------------------
// Addendum O finding 4: the reference used to fall back to recomputing an earlier rung's
// submitted descriptor whenever its own history did not have it, which meant a cross-rung value
// the agent could never actually retrieve still let the gate pass. The gate proved the key was
// self-consistent, not that the ladder was climbable. The fallback is now opt-in only.
// ---------------------------------------------------------------------------

// The cheapest rung on seed 1 that borrows from an earlier one. Asserted rather than assumed: if
// the grammar ever stops putting a cross-rung reference here, these two tests would pass
// vacuously and the regression they guard would be unguarded.
// Addendum T: recall now starts at rung 30 (tier 6), not rung 20 (tier 5 never recalls).
const RECALL_RUNG = 30;

test('a partial climb fails loudly on a recall it cannot resolve from its own submissions', async () => {
  const recall = composePlan(makeWorld(1), RECALL_RUNG).plan.find((s) => s.op === 'recall');
  assert.ok(recall, `rung ${RECALL_RUNG} of seed 1 is expected to borrow from an earlier rung`);
  assert.ok(recall.args.fromRung < RECALL_RUNG);

  const result = await climbSeed(1, { from: RECALL_RUNG, to: RECALL_RUNG });
  assert.equal(result.passed.length, 0, 'a climb that never submitted the earlier rung must not pass');
  assert.equal(result.failed.length, 1);
  assert.match(
    result.failed[0].reason,
    new RegExp(`borrows ${recall.args.field} from rung ${recall.args.fromRung}, which this climb never submitted`),
    `the failure has to name the rung it could not remember, got: ${result.failed[0].reason}`,
  );
});

test('the same partial climb passes when the caller explicitly opts into the recall fallback', async () => {
  const result = await climbSeed(1, {
    from: RECALL_RUNG,
    to: RECALL_RUNG,
    resolveMissingRecall: recallFallbackResolver(makeWorld(1)),
  });
  assertClean(1, result, 1);
});

// ---------------------------------------------------------------------------
// Addendum O, "grade the chain": the two fields the key now carries beside the hashes, proven
// against a real climb rather than only against the generator. The reference walks compose ->
// render -> publish and writes the stated word under If-Match, so a server that grades on
// expectedProjectState/expectedLabel grades the reference as a pass.
//
// Addendum Q adds three obligations the 0..99 climbs above now also carry, each of which would
// have made every rung above its band red rather than merely ungraded:
//   * rule 3 -- the listing's next page lives ONLY in a `Link: rel="next"` header. A client that
//     looks for a body field stops after page one, undercounts, and gets the derived percent
//     wrong on every batch rung.
//   * rule 10 -- the climb compares the stage sequence it actually walked against
//     `expectedAudit.stages` and fails the rung on a mismatch, so the state machine, the 409
//     recovery and the release are graded work rather than six invisible mechanisms.
//   * rule 7 -- the climb refuses what a house rule forbids and fails itself if it does not;
//     test/refusal.test.js drives the failing half.
// ---------------------------------------------------------------------------

test('the answer key a real climb is graded against carries the project state and label', () => {
  // Addendum T: the graded release chain is now at rungs 20-39 (was 50-69), and `recover409` is
  // a per-rung seeded draw rather than always true, so `render:409` is only sometimes in the
  // stage list.
  const world = makeWorld(1);
  const key = answerKey(world);
  const graded = key.rungs.filter((r) => r.expectedProjectState !== null);
  assert.deepEqual(graded.map((r) => r.n), Array.from({ length: 20 }, (_, i) => 20 + i));
  let recovers = 0;
  for (const entry of graded) {
    assert.equal(entry.expectedProjectState, 'published');
    // Addendum Q rule 1 paraphrases the clause, so the word is what is checked, not the sentence.
    assert.ok(entry.expectedLabel && entry.text.includes(`"${entry.expectedLabel}"`));
    // Addendum Q rule 10: the same rungs record the path, not only the terminal artifact.
    assert.ok(entry.expectedAudit, `rung ${entry.n} publishes but records no audit`);
    assert.equal(entry.expectedAudit.bodyDigestOf, 'submittedAsset');
    if (entry.expectedAudit.stages.includes('render:409')) recovers += 1;
  }
  assert.ok(recovers > 0 && recovers < graded.length, `seed 1: recover409 never varies across rungs 20-39 (${recovers}/${graded.length})`);
});
