// Addendum Q rule 4's gate: dated mid-ladder amendments, and `rulesAt(world, n)` as the ONE
// function that says which rules are in force at a rung.
//
// Rule 4 is the only mechanism on the ladder that makes the 5 MB house document keep costing
// after rung 0. Astra's seed-701 climb opened the skill on 10 of 373 tool calls, 7 of them at
// rung 0, because nothing in 0.6.0 ever changed: house constants were ladder-constant, so the
// skill was read once and cached into a 34 KB file. An amendment at rungs 30, 55 and 78 makes a
// cached reading wrong three times, and the only way through is to go back and read.
//
// WHAT IS AND IS NOT LIVE YET. An amendment is only real when the HOUSE changes behaviour at the
// announced rung, and the grid step, the rounding direction, the compounding rule, the default
// frame rate and the signing string are all applied by src/media.js and src/api/behaviors.js,
// which read world.rules / world.hmac once and know nothing about the current rung. Until they
// resolve through rulesAt too, publishing an amendment would only desync the key from the live
// house, so `AMENDMENTS_ENFORCED` in src/world.js is false and `makeWorld` hands back an empty
// `amendments` array. Everything below still proves the whole mechanism, by injecting the drawn
// amendments into a world by hand -- which is exactly what flipping the constant will do.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  makeWorld, rulesAt, amendmentsAt, drawAmendments, AMENDMENT_RUNGS, AMENDMENT_RULES,
  AMENDMENTS_ENFORCED,
} from '../src/world.js';
import { makeRung, saysOneOf } from '../src/ladder/rung.js';
import { canonical } from '../src/canon.js';

const RULES_DOC = readFileSync(new URL('../docs/RULES-0.7.md', import.meta.url), 'utf8');

// A world with the amendments this seed draws, live. Identical to `makeWorld(seed)` now that
// AMENDMENTS_ENFORCED is true; kept as its own name so every test below still says which world it
// means, and so these tests would still prove the mechanism if the flag were ever turned off.
function amendedWorld(seed) {
  return { ...makeWorld(seed), amendments: drawAmendments(seed) };
}

// The same world with nothing amended -- the ladder as it would read if rule 33 did not exist.
// This is the control every "the amendment actually moved something" assertion compares against.
function unamendedWorld(seed) {
  return { ...makeWorld(seed), amendments: [] };
}

// ---------------------------------------------------------------------------
// the draw
// ---------------------------------------------------------------------------

test('amendments land at exactly the three announced rungs', () => {
  assert.deepEqual(AMENDMENT_RUNGS, [30, 55, 78]);
  for (let seed = 1; seed <= 40; seed += 1) {
    const drawn = drawAmendments(seed);
    assert.equal(drawn.length, 3, `seed ${seed}`);
    assert.deepEqual(drawn.map((a) => a.atRung), AMENDMENT_RUNGS, `seed ${seed}`);
  }
});

test('every amendment is one item from the closed set, and really moves it', () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    for (const a of drawAmendments(seed)) {
      assert.ok(AMENDMENT_RULES[a.rule] !== undefined, `seed ${seed}: "${a.rule}" is not in the closed set`);
      const { choices } = AMENDMENT_RULES[a.rule];
      assert.ok(choices.includes(a.to), `seed ${seed}: ${a.rule} -> ${a.to} is not a legal value`);
      assert.notEqual(a.to, a.from, `seed ${seed}: ${a.rule} "changes" to the value it already had`);
    }
  }
});

test('the three amendments of one seed never move the same rule twice', () => {
  // Amendments accumulate (rule 33), so two amendments to one rule would make the second silently
  // overwrite the first and the ladder would only really have two of them.
  for (let seed = 1; seed <= 60; seed += 1) {
    const rules = drawAmendments(seed).map((a) => a.rule);
    assert.equal(new Set(rules).size, rules.length, `seed ${seed} amends the same rule twice: ${rules.join(', ')}`);
  }
});

test('drawAmendments is pure in the seed', () => {
  for (const seed of [1, 7, 42, 300]) {
    assert.equal(canonical(drawAmendments(seed)), canonical(drawAmendments(seed)), `seed ${seed}`);
  }
});

// ---------------------------------------------------------------------------
// rulesAt
// ---------------------------------------------------------------------------

test('rulesAt is the base world below the first amendment and accumulates above it', () => {
  const seed = 3; // roundTo at 30, roundMode at 55, defaultFps at 78
  const base = makeWorld(seed);
  const world = amendedWorld(seed);
  const [first, second, third] = world.amendments;

  for (const n of [0, 15, 29]) {
    assert.equal(rulesAt(world, n), world, `rung ${n} should resolve to the world itself`);
    assert.equal(rulesAt(world, n).rules[first.rule], base.rules[first.rule]);
  }
  assert.equal(rulesAt(world, first.atRung).rules[first.rule], first.to, 'live from its own rung, not the next one');
  assert.equal(rulesAt(world, 54).rules[second.rule], second.from, 'a later amendment must not leak backwards');
  assert.equal(rulesAt(world, second.atRung).rules[second.rule], second.to);
  assert.equal(rulesAt(world, second.atRung).rules[first.rule], first.to, 'amendments accumulate');
  assert.equal(rulesAt(world, 99).rules[third.rule], third.to);
  assert.equal(rulesAt(world, 99).rules[first.rule], first.to);
});

test('rulesAt never mutates the world it is given', () => {
  const world = amendedWorld(3);
  const before = canonical(world.rules);
  rulesAt(world, 99);
  assert.equal(canonical(world.rules), before);
});

test('rulesAt returns the same object for the same rung, so caches keyed on identity still hit', () => {
  const world = amendedWorld(3);
  assert.equal(rulesAt(world, 60), rulesAt(world, 60));
});

test('amendmentsAt names only what lands at exactly that rung', () => {
  const world = amendedWorld(3);
  for (let n = 0; n < 100; n += 1) {
    const landed = amendmentsAt(world, n);
    assert.equal(landed.length, AMENDMENT_RUNGS.includes(n) ? 1 : 0, `rung ${n}`);
  }
});

// ---------------------------------------------------------------------------
// the generator reads it
// ---------------------------------------------------------------------------

// Seeds whose FIRST amendment is one that moves geometry (the grid step or the rounding
// direction), so the amended key is observably different rather than merely differently labelled.
const GEOMETRY_SEEDS = [3, 5, 11];

test('a rung composed above a geometry amendment differs from the same rung composed below it', () => {
  for (const seed of GEOMETRY_SEEDS) {
    const base = unamendedWorld(seed);
    const world = amendedWorld(seed);
    const first = world.amendments[0];
    assert.ok(['roundTo', 'roundMode'].includes(first.rule), `seed ${seed} is not a geometry-amendment seed any more`);

    // below the amendment: byte-identical, because nothing is in force yet
    for (const n of [0, 10, 29]) {
      assert.equal(
        canonical(makeRung(world, n, { phrasingVariant: 0 }).expectedDescriptors),
        canonical(makeRung(base, n, { phrasingVariant: 0 }).expectedDescriptors),
        `seed ${seed} rung ${n} changed below the first amendment`,
      );
    }
    // at and above it: the key is computed under the amended rule, so it moves
    let moved = 0;
    for (let n = first.atRung; n < first.atRung + 8; n += 1) {
      const a = canonical(makeRung(world, n, { phrasingVariant: 0 }).expectedDescriptors);
      const b = canonical(makeRung(base, n, { phrasingVariant: 0 }).expectedDescriptors);
      if (a !== b) moved += 1;
    }
    assert.ok(moved > 0, `seed ${seed}: the amendment at rung ${first.atRung} changed no key at all`);
  }
});

test('every rung records the amendments in force at it, and its own resolved rules', () => {
  const seed = 3;
  const world = amendedWorld(seed);
  for (const n of [0, 29, 30, 54, 55, 77, 78, 99]) {
    const rung = makeRung(world, n);
    const live = world.amendments.filter((a) => a.atRung <= n);
    assert.deepEqual(rung.amendments, live, `rung ${n}`);
    assert.deepEqual(rung.rules, rulesAt(world, n).rules, `rung ${n} records rules rulesAt does not agree with`);
  }
});

test('the rung an amendment lands at tells the reader to go and read the rules again', () => {
  const world = amendedWorld(3);
  for (let n = 0; n < 100; n += 1) {
    // one amendment lands per announced rung, so the clause is rendered with count 1
    const announced = saysOneOf(makeRung(world, n).text, 'amendment', { count: 1 });
    assert.equal(announced, AMENDMENT_RUNGS.includes(n), `rung ${n}: announced=${announced}`);
  }
});

// ---------------------------------------------------------------------------
// what is published while the house does not enforce it
// ---------------------------------------------------------------------------

test('a rung announces an amendment if and only if the house applies one there', () => {
  // A rule the house does not actually apply must never be announced, and a rule it DOES apply
  // must never go unannounced -- either way the agent is told something the live house will not
  // do, and loses a rung to a generator bug. The flag is the one switch that decides which world
  // ships, and both sides of it are held to the same invariant here.
  assert.equal(typeof AMENDMENTS_ENFORCED, 'boolean');
  const world = makeWorld(1);
  assert.deepEqual(world.amendments, AMENDMENTS_ENFORCED ? drawAmendments(1) : []);
  for (let n = 0; n < 100; n += 1) {
    const announced = Boolean(saysOneOf(makeRung(world, n).text, 'amendment', { count: 1 }));
    const applies = AMENDMENTS_ENFORCED && AMENDMENT_RUNGS.includes(n);
    assert.equal(announced, applies, `rung ${n}: announced=${announced}, house applies=${applies}`);
    assert.deepEqual(
      makeRung(world, n).amendments,
      AMENDMENTS_ENFORCED ? drawAmendments(1).filter((a) => a.atRung <= n) : [],
      `rung ${n} records the wrong amendments`,
    );
  }
});

test('the rules doc states the amendment convention as a numbered (skill) rule', () => {
  assert.match(RULES_DOC, /33\. \*\*\(skill, new in 0\.7\.0\)\*\* The house \*\*amends its own rules partway up the ladder\*\*/);
  assert.ok(RULES_DOC.includes('Amendments accumulate'), 'the doc never says amendments accumulate');
  assert.ok(RULES_DOC.includes('the amended rule is the rule'), 'the doc never says which reading wins');
  // the closed set has to be published, or a reader cannot know what an amendment may move
  for (const phrase of ['the grid step', 'the rounding direction', 'the compounding rule', 'the house default frame rate']) {
    assert.ok(RULES_DOC.includes(phrase), `the doc never names "${phrase}" as amendable`);
  }
});
