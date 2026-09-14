// Addendum Q rule 4: dated mid-ladder amendments. world.amendments = [{atRung, rule, from, to}]
// is world.js's own wire contract (shipped in the same round as this file, as `AMENDMENT_RULES` /
// `drawAmendments` / `AMENDMENTS_ENFORCED`) -- `rule` there is `roundTo`, `roundMode`,
// `opacityCompound`, `defaultFps`, or `hmacCanon` (world.js's own field names; two of those,
// `defaultFps` and `hmacCanon`, spell the same house facts this module's rule chains track under
// the shorter keys `fps`/`canon`, which is exactly what AMENDMENT_RULE_TO_CHAIN_KEY in
// skill-sloppy.js translates). `AMENDMENTS_ENFORCED` is currently `false`, so a real
// `makeWorld(seed).amendments` is always `[]` -- these tests attach amendments by hand (the same
// escape-hatch pattern test/harness-amendments.test.js uses), both synthetic ones and, in the
// last block below, world.js's own real `drawAmendments()` output, so this proves the exact
// integration that activates the day that switch flips, not just a hypothetical shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSkill, truthTable } from '../src/skill-sloppy.js';
import { makeWorld, drawAmendments, AMENDMENT_RULES, AMENDMENT_RUNGS } from '../src/world.js';

const SEEDS = [1, 2, 3, 4, 5];
const SMALL = 64 * 1024;

// One amendment per closed-set rule key Addendum Q rule 4 names, spelled exactly as world.js's
// own AMENDMENT_RULES does, each a value legitimately in that chain's own domain but distinct
// from the seed's rolled default, so `from` is always genuinely different from the base value.
function amendmentsFor(world) {
  const flipDomain = (real, domain) => domain.find((v) => String(v) !== String(real));
  return [
    { atRung: 30, rule: 'roundTo', from: world.rules.roundTo, to: flipDomain(world.rules.roundTo, [1, 2, 4, 8, 16]) },
    { atRung: 55, rule: 'opacityCompound', from: world.rules.opacityCompound, to: flipDomain(world.rules.opacityCompound, ['additive', 'multiplicative']) },
    { atRung: 78, rule: 'defaultFps', from: world.rules.defaultFps, to: flipDomain(world.rules.defaultFps, [12, 24, 30]) },
  ];
}

function withAmendments(seed) {
  const world = makeWorld(seed);
  world.amendments = amendmentsFor(world);
  return world;
}

test('with no atRung passed, amendments are never applied -- output is unchanged from before this option existed', () => {
  for (const seed of SEEDS) {
    const plain = makeWorld(seed);
    const amended = withAmendments(seed);
    assert.equal(toSkill(plain, { targetBytes: SMALL }), toSkill(amended, { targetBytes: SMALL }), `seed ${seed}`);
    assert.deepEqual(truthTable(plain, { targetBytes: SMALL }).rules, truthTable(amended, { targetBytes: SMALL }).rules, `seed ${seed}`);
    assert.deepEqual(truthTable(amended, { targetBytes: SMALL }).amendments, [], `seed ${seed}: amendments must be empty with no atRung`);
  }
});

test('an amendment announced at a later rung than atRung does not appear at all', () => {
  for (const seed of SEEDS) {
    const world = withAmendments(seed);
    // atRung 29 is before the earliest announced amendment (rung 30)
    const tt = truthTable(world, { targetBytes: SMALL, atRung: 29 });
    assert.deepEqual(tt.amendments, [], `seed ${seed}`);
    const roundToRule = tt.rules.find((r) => r.key === 'roundTo');
    assert.equal(roundToRule.truth.value, String(world.rules.roundTo), `seed ${seed}: unamended truth must still be the base world value`);
  }
});

test('an amendment at or before atRung becomes the truth; the old value becomes a decoy', () => {
  for (const seed of SEEDS) {
    const world = withAmendments(seed);
    const doc = toSkill(world, { targetBytes: SMALL, atRung: 30 });
    const tt = truthTable(world, { targetBytes: SMALL, atRung: 30 });
    assert.equal(tt.amendments.length, 1, `seed ${seed}: only the rung-30 amendment should be in force at rung 30`);
    const a = tt.amendments[0];
    assert.equal(a.rule, 'roundTo');
    assert.equal(a.atRung, 30);
    assert.equal(typeof a.to, 'string');
    const chain = tt.rules.find((r) => r.key === 'roundTo');
    assert.equal(chain.truth.value, a.to, `seed ${seed}: chain truth must equal the amendment's "to"`);
    assert.equal(chain.truth.offset, a.toOffset, `seed ${seed}`);
    assert.ok(chain.decoys.some((d) => d.value === a.from), `seed ${seed}: the old value must appear as one of the chain's decoys`);
    assert.equal(doc.slice(a.toOffset, a.toOffset + a.to.length), a.to, `seed ${seed}`);
    assert.equal(doc.slice(a.fromOffset, a.fromOffset + a.from.length), a.from, `seed ${seed}`);
  }
});

test('two amendments in force at once, at a later atRung, both resolve correctly and independently', () => {
  for (const seed of SEEDS) {
    const world = withAmendments(seed);
    const tt = truthTable(world, { targetBytes: SMALL, atRung: 55 });
    assert.equal(tt.amendments.length, 2, `seed ${seed}: rungs 30 and 55 both qualify, rung 78 does not`);
    const byRule = Object.fromEntries(tt.amendments.map((a) => [a.rule, a]));
    assert.ok(byRule.roundTo && byRule.opacityCompound, `seed ${seed}`);
    assert.ok(!byRule.fps, `seed ${seed}: the rung-78 amendment must not be in force yet`);
    for (const rule of ['roundTo', 'opacityCompound']) {
      const chain = tt.rules.find((r) => r.key === rule);
      assert.equal(chain.truth.value, byRule[rule].to, `seed ${seed}: ${rule}`);
    }
    // and the not-yet-amended fps chain must still read the base world value
    const fpsChain = tt.rules.find((r) => r.key === 'fps');
    assert.equal(fpsChain.truth.value, String(world.rules.defaultFps), `seed ${seed}`);
  }
});

test('all three amendments in force resolves under the newest-date-wins convention: applying the stated precedence never points at a decoy', () => {
  for (const seed of SEEDS) {
    const world = withAmendments(seed);
    const tt = truthTable(world, { targetBytes: SMALL, atRung: 99 });
    assert.equal(tt.amendments.length, 3, `seed ${seed}`);
    for (const r of tt.rules) {
      const rank = (m) => (tt.precedence.type === 'version' ? Number(m.slice(1)) : m);
      for (const d of r.decoys) {
        assert.ok(
          rank(d.marker) < rank(r.truth.marker),
          `seed ${seed}: rule ${r.key} decoy ${d.value} (${d.marker}) outranks truth ${r.truth.value} (${r.truth.marker})`,
        );
      }
    }
  }
});

test('an unknown amendment rule name is ignored rather than throwing (defensive against a wire-contract key mismatch)', () => {
  const world = makeWorld(1);
  world.amendments = [{ atRung: 10, rule: 'somethingTheLadderSideInventedLater', from: 'x', to: 'y' }];
  assert.doesNotThrow(() => toSkill(world, { targetBytes: SMALL, atRung: 50 }));
  const tt = truthTable(world, { targetBytes: SMALL, atRung: 50 });
  assert.deepEqual(tt.amendments, []);
});

test('a real makeWorld(seed) renders its own drawn amendments, and only those dated at or before atRung', () => {
  // AMENDMENTS_ENFORCED is true as of ladder 0.7.0, so makeWorld hands back the drawn amendments
  // and this module is live on every real world. The document at rung 60 must state the two
  // amendments dated 30 and 55 and know nothing of the one dated 78.
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    assert.deepEqual(world.amendments, drawAmendments(seed), `seed ${seed}: makeWorld no longer publishes its own draw`);
    assert.doesNotThrow(() => toSkill(world, { targetBytes: SMALL, atRung: 60 }));
    const tt = truthTable(world, { targetBytes: SMALL, atRung: 60 });
    const want = world.amendments.filter((a) => a.atRung <= 60).map((a) => a.rule).sort();
    assert.deepEqual(tt.amendments.map((a) => a.rule).sort(), want, `seed ${seed}`);
    // and at rung 0 the document is the one the sandbox is seeded with: no amendment at all
    assert.deepEqual(truthTable(world, { targetBytes: SMALL, atRung: 0 }).amendments, [], `seed ${seed} at rung 0`);
  }
});

test('determinism: same (seed, targetBytes, atRung, amendments) reproduces identical bytes and truth table', () => {
  for (const seed of SEEDS) {
    const a = withAmendments(seed);
    const b = withAmendments(seed);
    assert.equal(toSkill(a, { targetBytes: SMALL, atRung: 60 }), toSkill(b, { targetBytes: SMALL, atRung: 60 }), `seed ${seed}`);
    assert.deepEqual(
      truthTable(a, { targetBytes: SMALL, atRung: 60 }),
      truthTable(b, { targetBytes: SMALL, atRung: 60 }),
      `seed ${seed}`,
    );
  }
});

test('a different atRung is a distinct cache entry, not a stale one from a prior call with the same world', () => {
  const world = withAmendments(1);
  const before = truthTable(world, { targetBytes: SMALL, atRung: 10 });
  assert.equal(before.amendments.length, 0);
  const after = truthTable(world, { targetBytes: SMALL, atRung: 90 });
  assert.equal(after.amendments.length, 3);
  // and re-requesting the first atRung again still returns the original (memoization keyed correctly)
  const again = truthTable(world, { targetBytes: SMALL, atRung: 10 });
  assert.deepEqual(again, before);
});

// ---------------------------------------------------------------------------
// Real integration: world.js's own drawAmendments(), not a hand-rolled fixture. AMENDMENT_RUNGS
// is [20, 30, 40, 60] and AMENDMENT_RULES's five keys are exactly what AMENDMENT_RULE_TO_CHAIN_KEY
// in skill-sloppy.js translates. AMENDMENTS_ENFORCED is true, so makeWorld already attaches these;
// the tests below re-attach by hand to pin the actual object shape flowing into world.amendments
// (same pattern test/harness-amendments.test.js uses on the harness side).
// ---------------------------------------------------------------------------

test('drawAmendments(seed) attached by hand: every one of world.js\'s five real rule names is recognized, one per AMENDMENT_RUNGS entry', () => {
  assert.deepEqual(Object.keys(AMENDMENT_RULES).sort(), ['defaultFps', 'hmacCanon', 'opacityCompound', 'roundMode', 'roundTo'].sort());
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    world.amendments = drawAmendments(seed);
    assert.equal(world.amendments.length, AMENDMENT_RUNGS.length, `seed ${seed}`);
    const tt = truthTable(world, { targetBytes: SMALL, atRung: 99 });
    assert.equal(tt.amendments.length, world.amendments.length, `seed ${seed}: every drawn amendment must be recognized, none silently dropped`);
    for (const drawn of world.amendments) {
      const rec = tt.amendments.find((a) => a.rule === drawn.rule && a.atRung === drawn.atRung);
      assert.ok(rec, `seed ${seed}: drawn amendment ${JSON.stringify(drawn)} not found in the truth table`);
      assert.equal(rec.to, String(drawn.to), `seed ${seed}: rule ${drawn.rule}`);
      assert.equal(rec.from, String(drawn.from), `seed ${seed}: rule ${drawn.rule}`);
      // and the chain it landed on is the one AMENDMENT_RULE_TO_CHAIN_KEY says it should be
      const expectedChainKey = { roundTo: 'roundTo', roundMode: 'roundMode', opacityCompound: 'opacityCompound', defaultFps: 'fps', hmacCanon: 'canon' }[drawn.rule];
      assert.equal(rec.chainKey, expectedChainKey, `seed ${seed}: rule ${drawn.rule}`);
    }
  }
});

test('drawAmendments(seed) staged progressively through its own AMENDMENT_RUNGS matches world.js\'s rulesAt() at every stage', () => {
  // rulesAt(world, n) is the ladder side's ground truth for "which rules are in force at rung n".
  // toSkill's atRung must agree with it at every amendment boundary, not just the final rung.
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    world.amendments = drawAmendments(seed);
    for (const boundary of [AMENDMENT_RUNGS[0] - 1, AMENDMENT_RUNGS[0], AMENDMENT_RUNGS[1], AMENDMENT_RUNGS[2], 99]) {
      const tt = truthTable(world, { targetBytes: SMALL, atRung: boundary });
      const expectedCount = world.amendments.filter((a) => a.atRung <= boundary).length;
      assert.equal(tt.amendments.length, expectedCount, `seed ${seed}, atRung ${boundary}`);
      for (const drawn of world.amendments.filter((a) => a.atRung <= boundary)) {
        const chainKey = { roundTo: 'roundTo', roundMode: 'roundMode', opacityCompound: 'opacityCompound', defaultFps: 'fps', hmacCanon: 'canon' }[drawn.rule];
        const chain = tt.rules.find((r) => r.key === chainKey);
        assert.equal(chain.truth.value, String(drawn.to), `seed ${seed}, atRung ${boundary}, rule ${drawn.rule}`);
      }
    }
  }
});
