// Ladder 0.7.0's own gate (Addendum Q). test/ladder-0-5.test.js and test/ladder-0-6.test.js still
// pin every 0.5.0 and 0.6.0 rule 0.7.0 keeps; test/phrasing.test.js, test/amendment.test.js and
// test/refusal.test.js each own one whole rule. What is left -- and what this file pins -- is the
// World-level surface 0.7.0 added and the three fields the answer key grew.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  makeWorld, VERSION, RUNG_MUTATION_POOL, RUNG_MUTATION_TARGETS, FIRST_MUTATION_RUNG,
  mutationDensityAt,
} from '../src/world.js';
import { MUTATION_NAMES } from '../src/api/admin.js';
import { routes } from '../src/routes.js';
import { makeRung, saysOneOf } from '../src/ladder/rung.js';
import { answerKey, canonicalString } from '../src/ladder/reference.js';
import { canonical, sha256 } from '../src/canon.js';

const RULES_DOC = readFileSync(new URL('../docs/RULES-0.9.md', import.meta.url), 'utf8');
const SEEDS = [1, 2, 3];

test('the world declares ladder 0.9.0', () => {
  assert.equal(VERSION, '0.9.0');
  assert.equal(makeWorld(1).version, '0.9.0');
});

// ---------------------------------------------------------------------------
// rule 2: mutations on the fields a solver parses, at a density that ramps
// Addendum T (0.8.0): the ramp now starts at rung 20 and reaches its top at rung 50 (was 40/70).
// ---------------------------------------------------------------------------

test('the announced-mutation density ramps from 0.6 to 0.9 at rung 50', () => {
  for (const n of [0, 10, 19]) assert.equal(mutationDensityAt(n), 0, `rung ${n}`);
  for (const n of [20, 35, 49]) assert.equal(mutationDensityAt(n), 0.6, `rung ${n}`);
  for (const n of [50, 75, 99]) assert.equal(mutationDensityAt(n), 0.9, `rung ${n}`);
});

test('the top half really does announce a change nearly every rung', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const count = (from, to) => {
      let hits = 0;
      for (let n = from; n <= to; n += 1) if (world.rungMutations[n] !== null) hits += 1;
      return hits;
    };
    assert.equal(count(0, FIRST_MUTATION_RUNG - 1), 0, `seed ${seed} announces a change below rung ${FIRST_MUTATION_RUNG}`);
    const mid = count(20, 49);
    const top = count(50, 99);
    assert.ok(mid >= 10 && mid <= 26, `seed ${seed}: ${mid} of 30 in 20-49, expected about 18`);
    assert.ok(top >= 35, `seed ${seed}: only ${top} of 50 in 50-99, expected about 45`);
  }
});

// Addendum Q rule 2's whole point: 0.6.0's mutations all landed on GET-and-read-the-body routes a
// POST-driven pipeline never looks at, so 33 announced changes cost the top climb nothing. The
// published target pool is the ladder's statement of which load-bearing fields the API's candidate
// lists must cover, and src/api/admin.js derives its candidates from this very constant -- so this
// test is what keeps the two from drifting if either side ever stops importing the other.
test('the published mutation target pool names write and listing routes, not only GET bodies', () => {
  const ids = new Set(routes.map((r) => r.id));
  for (const t of RUNG_MUTATION_TARGETS) {
    assert.ok(RUNG_MUTATION_POOL.includes(t.mutation), `target names "${t.mutation}", which is not in the announced pool`);
    assert.ok(MUTATION_NAMES.includes(t.mutation), `target names "${t.mutation}", which the Arena does not implement`);
    assert.ok(ids.has(t.route), `target names route "${t.route}", which is not in the route table`);
  }
  const writeRoutes = RUNG_MUTATION_TARGETS.filter((t) => {
    const route = routes.find((r) => r.id === t.route);
    return route.method !== 'GET';
  });
  assert.ok(
    writeRoutes.length >= RUNG_MUTATION_TARGETS.length / 2,
    `only ${writeRoutes.length} of ${RUNG_MUTATION_TARGETS.length} targets are on write routes -- back to the 0.6.0 failure`,
  );
  // every mutation kind the ladder may announce has at least one target, or announcing it is a
  // no-op on some rungs and the density ramp buys nothing
  for (const mutation of RUNG_MUTATION_POOL) {
    assert.ok(
      RUNG_MUTATION_TARGETS.some((t) => t.mutation === mutation),
      `"${mutation}" is announceable but has no published target`,
    );
  }
});

// ---------------------------------------------------------------------------
// rule 9: the listing bucket and the short-page rule
// ---------------------------------------------------------------------------

test('the world declares a listing bucket strictly tighter than the house-wide one', () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const { rate } = makeWorld(seed);
    assert.ok(rate.buckets && rate.buckets.listing, `seed ${seed} has no listing bucket`);
    const listing = rate.buckets.listing;
    assert.equal(listing.route, 'projects.assets');
    assert.ok(listing.limit >= 4, `seed ${seed}: a listing limit of ${listing.limit} would stall a correct client`);
    assert.ok(listing.limit < rate.limit, `seed ${seed}: the listing bucket (${listing.limit}) is not tighter than ${rate.limit}`);
    assert.equal(listing.windowSec, rate.windowSec);
  }
});

test('every rung that pages a listing states the short-page rule', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    for (let n = 0; n < 100; n += 1) {
      // Addendum T: tiers 7-9 (the only composers that page a listing) are now contiguous, 40-99.
      const paged = n >= 40;
      if (!paged) continue;
      assert.ok(
        saysOneOf(makeRung(world, n).text, 'shortPage'),
        `seed ${seed} rung ${n} walks a metered listing but never says a short page is not the end`,
      );
    }
  }
});

test('the rules doc states the short-page rule and the listing scope rule', () => {
  // hard-wrapped markdown: flatten the line breaks, the wording is the contract
  const flat = RULES_DOC.replace(/\s+/g, ' ');
  assert.match(RULES_DOC, /31\. \*\*\(skill, new in 0\.7\.0\)\*\*/);
  assert.ok(flat.includes('a short page is not the end of the listing'), 'rule 31 never states the short-page rule');
  assert.ok(flat.includes('no next cursor'), 'rule 31 never says what DOES end a listing');
  assert.match(RULES_DOC, /32\. \*\*\(skill, new in 0\.7\.0\)\*\*/);
  assert.ok(flat.includes("this piece of work's own copies"), 'rule 32 never scopes the count');
});

// ---------------------------------------------------------------------------
// rule 11: the haul is dealt round the projects instead of sampled with replacement
// ---------------------------------------------------------------------------

test('consecutive batch rungs do not pile onto the same project', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const hauls = [];
    for (let n = 40; n < 100; n += 1) {
      const rung = makeRung(world, n);
      const batch = rung.plan.find((s) => s.op === 'batch');
      if (batch) hauls.push({ n, projectId: batch.args.projectId });
    }
    assert.ok(hauls.length >= 30, `seed ${seed}: only ${hauls.length} batch rungs`);
    let repeats = 0;
    for (let i = 1; i < hauls.length; i += 1) {
      // adjacent RUNGS, not adjacent entries: since Addendum T, tiers 7-9 (40-99) haul on every
      // single rung with no gap, so this now checks every consecutive pair in the range.
      if (hauls[i].n === hauls[i - 1].n + 1 && hauls[i].projectId === hauls[i - 1].projectId) repeats += 1;
    }
    // Dealt round-robin, a project can never be hauled twice in a row; sampling with replacement
    // (what 0.6.0 did) put roughly one haul in N straight back onto the reel the previous haul had
    // just grown, where N is the number of seeded projects.
    assert.equal(repeats, 0, `seed ${seed}: ${repeats} back-to-back hauls of the same project`);
    const distinct = new Set(hauls.map((h) => h.projectId)).size;
    // The seeded library holds three projects, so the rotation can divide the accumulation by
    // three and no further -- the rest of Addendum Q rule 11 is the documented scope filter
    // (RULES-0.9 rule 32), which lets a count be taken without walking anybody else's rows and is
    // the API workstream's half. A library with more projects would raise this number on its own.
    assert.ok(distinct >= 3, `seed ${seed}: only ${distinct} distinct projects across ${hauls.length} hauls`);
    assert.equal(distinct, new Set(hauls.map((h) => h.projectId)).size);
  }
});

// ---------------------------------------------------------------------------
// rule 10: the key records the path, and the signature binds a digest
// ---------------------------------------------------------------------------

test('the answer key records an ordered stage sequence for exactly the rungs that walk one', () => {
  // Addendum T: the render/publish/etag chain moved to 20-39 (was 50-69), and `recover409` is now
  // a per-rung seeded draw rather than always true, so the expected stage list forks on it instead
  // of always including `render:409`.
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const key = answerKey(world);
    for (const entry of key.rungs) {
      const walks = entry.n >= 20 && entry.n <= 39;
      if (!walks) {
        assert.equal(entry.expectedAudit, null, `seed ${seed} rung ${entry.n} grades a path it never walks`);
        continue;
      }
      assert.ok(entry.expectedAudit, `seed ${seed} rung ${entry.n} walks the stages but records no audit`);
      const recovers = entry.expectedAudit.stages.includes('render:409');
      assert.deepEqual(
        entry.expectedAudit.stages,
        recovers
          ? ['draft', 'render:409', 'composed', 'rendering', 'rendered', 'published']
          : ['draft', 'composed', 'rendering', 'rendered', 'published'],
        `seed ${seed} rung ${entry.n}`,
      );
      assert.equal(entry.expectedAudit.bodyDigestOf, 'submittedAsset');
      assert.equal(typeof entry.expectedAudit.canonical, 'string');
    }
  }
});

test('recover409 actually varies across 20-39, so the base stage list is exercised too', () => {
  const world = makeWorld(1);
  const key = answerKey(world);
  const seen = new Set();
  for (const entry of key.rungs) {
    if (entry.n < 20 || entry.n > 39) continue;
    seen.add(entry.expectedAudit.stages.includes('render:409'));
  }
  assert.deepEqual([...seen].sort(), [false, true], 'seed 1 never varies recover409 across rungs 20-39');
});

test('the canonical string is one implementation, and the digest-bound recipe needs a real digest', () => {
  const parts = { ts: '1700000000', method: 'POST', path: '/scenes/x/publish' };
  assert.equal(canonicalString('ts+method+path', parts), '1700000000POST/scenes/x/publish');
  assert.equal(canonicalString('ts+path+method', parts), '1700000000/scenes/x/publishPOST');
  assert.equal(canonicalString('method+path+ts', parts), 'POST/scenes/x/publish1700000000');
  const digest = 'a'.repeat(64);
  assert.equal(
    canonicalString('ts+method+path+digest', { ...parts, bodyDigest: digest }),
    `1700000000\nPOST\n/scenes/x/publish\n${digest}`,
  );
  assert.throws(() => canonicalString('ts+method+path+digest', parts), /64-hex body digest/);
  assert.throws(() => canonicalString('nonsense', parts), /unknown canonical-string recipe/);
});

test('the rules doc states the path audit and the digest-bound signature', () => {
  assert.match(RULES_DOC, /35\. \*\*\(skill, new in 0\.7\.0\)\*\*/);
  assert.ok(RULES_DOC.includes('binds a digest of the thing being released'), 'rule 35 never binds the digest');
});

// ---------------------------------------------------------------------------
// the key's shape, end to end
// ---------------------------------------------------------------------------

test('every answer-key entry carries the 0.7.0 fields, additively', () => {
  const world = makeWorld(1);
  const key = answerKey(world);
  assert.equal(key.rungs.length, 100);
  for (const entry of key.rungs) {
    // 0.5.x
    assert.ok(Array.isArray(entry.expected) && entry.expected.length > 0, `rung ${entry.n}`);
    assert.ok(Array.isArray(entry.expectedDescriptors) && entry.expectedDescriptors.length > 0);
    assert.equal(typeof entry.text, 'string');
    // 0.6.0
    assert.ok(entry.expectedProjectState === null || entry.expectedProjectState === 'published');
    assert.ok(entry.expectedLabel === null || typeof entry.expectedLabel === 'string');
    // 0.7.0
    assert.ok(Object.prototype.hasOwnProperty.call(entry, 'expectedAudit'), `rung ${entry.n} has no audit field`);
    assert.ok(Object.prototype.hasOwnProperty.call(entry, 'forbidden'), `rung ${entry.n} has no forbidden field`);
    assert.ok(Array.isArray(entry.amendments), `rung ${entry.n} has no amendments field`);
  }
});

test('the ladder <-> API contract for all three new fields is written down in one place', () => {
  const contract = readFileSync(new URL('../src/ladder/rung.js', import.meta.url), 'utf8').slice(0, 8000);
  for (const needle of ['expectedAudit', 'forbidden', 'amendments', 'X-Body-Digest', 'signPublish', 'ANSWER-KEY SHAPE, ladder 0.7.0']) {
    assert.ok(contract.includes(needle), `the answer-key contract block never mentions "${needle}"`);
  }
});

// ---------------------------------------------------------------------------
// pinned hashes
//
// The judge is hash equality, so the one thing that must never move quietly is the set of hashes
// a seed's answer key produces. Every pin below is a REBASELINE MARKER, not a correctness claim:
// when a deliberate grammar change moves them, recompute and say so in the commit, the way
// Addenda G, I, J, M, O and Q each did. When they move and nobody meant them to, something
// non-deterministic has got into the generator -- which is the failure this catches and nothing
// else in the suite would.
//
// Recompute with:
//   node --input-type=module -e "import {makeWorld} from './src/world.js';
//     import {answerKey} from './src/ladder/reference.js';
//     import {canonical, sha256} from './src/canon.js';
//     for (const s of [1,2,3]) console.log(s, sha256(canonical(answerKey(makeWorld(s)).rungs.map(r=>r.expected))));"
// ---------------------------------------------------------------------------

// Rebaselined for Addendum T (0.8.0): the band-tier reassignment, the moved mutation/amendment/
// refusal constants, the per-rung recover409 draw and the two reworded phrasings all change which
// composer runs at which rung and what its plan looks like, so every hash moved. Deliberate; see
// src/world.js and src/ladder/grammar.js. (Addendum Q rule 4's amendments are LIVE
// (AMENDMENTS_ENFORCED true) and rule 10's canonical string is digest-bound by default: every rung
// at or above the first amendment rung is composed against the rules in force at it.)
// Rebaselined again for the batchTier shrink floor (0.8.0, Addendum D): the ordered batch chain's
// shrink step now carries a minPercent pinned from the seeded library's smallest rect, and the
// Addendum I solver nudges those percents upward to honor it -- so the affected rungs' keys moved.
// Deliberate; see the shrinkFloor computation in src/ladder/grammar.js's batchTier.
// Rebaselined once more for the shrinkFloor cap-yield fix (0.8.0): on seed 2 the rung-40
// roundTo 4->16 amendment pins batchTier's floor above the SHRINK_PERCENT cap, and
// solveChainPercents now lets the floor win (hiEff = max(hi, lo)) instead of collapsing the
// chain to MIN_CHAIN_STEPS -- so seed 2's key moved and seeds 1 and 3 did not. Deliberate;
// see the hiEff computation in src/ladder/grammar.js's solveChainPercents.
const PINNED_KEY_HASHES = {
  1: 'd3c8f1df9a9e9b685e78882c912ed05c6f5bf79686096d35fb1f4fcf03ab2444',
  2: 'fff25489bb4d8cb1ab4a2f6cc56b19feef45ddc4502fc70909c062a0f50a18d6',
  3: 'bf3a8033208d76c1bb1fd913745cc30598355c38c317afe7aed5d1d83375e32c',
};

test('the 0.7.0 answer key hashes are pinned for seeds 1, 2 and 3', () => {
  for (const [seed, want] of Object.entries(PINNED_KEY_HASHES)) {
    const key = answerKey(makeWorld(Number(seed)));
    const got = sha256(canonical(key.rungs.map((r) => r.expected)));
    assert.equal(got, want, `seed ${seed}: the answer key moved. If that was deliberate, rebaseline and say so; if not, the generator is no longer deterministic.`);
  }
});

test('the answer key is a pure function of the seed', () => {
  const a = answerKey(makeWorld(2));
  const b = answerKey(makeWorld(2));
  assert.equal(canonical(a), canonical(b));
});

test('phrasing does not move a single hash', () => {
  // The other half of Addendum Q rule 1's invariant, stated where the hashes are pinned: the key
  // is built from makeRung's default (seeded) phrasing, and forcing any one phrasing on every
  // clause must produce exactly the same hashes.
  const world = makeWorld(1);
  const base = answerKey(world).rungs.map((r) => r.expected);
  for (let v = 0; v < 4; v += 1) {
    const forced = [];
    for (let n = 0; n < 100; n += 1) forced.push(makeRung(world, n, { phrasingVariant: v }));
    assert.equal(
      canonical(forced.map((r, i) => base[i].length)),
      canonical(base.map((e) => e.length)),
      `phrasing ${v} changed how many artifacts a rung submits`,
    );
  }
});
