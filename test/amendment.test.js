// Addendum Q rule 4's gate: dated mid-ladder amendments, and `rulesAt(world, n)` as the ONE
// function that says which rules are in force at a rung.
//
// Rule 4 is the only mechanism on the ladder that makes the 5 MB house document keep costing
// after rung 0. Astra's seed-701 climb opened the skill on 10 of 373 tool calls, 7 of them at
// rung 0, because nothing in 0.6.0 ever changed: house constants were ladder-constant, so the
// skill was read once and cached into a 34 KB file. An amendment at rungs 20, 30, 40 and 60
// (Addendum T; was 30, 55, 78) makes a cached reading wrong four times, and the only way through
// is to go back and read.
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
  AMENDMENT_ALLOWED_RULES, AMENDMENTS_ENFORCED,
} from '../src/world.js';
import { makeRung, saysOneOf } from '../src/ladder/rung.js';
import { canonical } from '../src/canon.js';

const RULES_DOC = readFileSync(new URL('../docs/RULES-0.9.md', import.meta.url), 'utf8');

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

test('amendments land at exactly the four announced rungs', () => {
  assert.deepEqual(AMENDMENT_RUNGS, [20, 30, 40, 60]);
  for (let seed = 1; seed <= 40; seed += 1) {
    const drawn = drawAmendments(seed);
    assert.equal(drawn.length, 4, `seed ${seed}`);
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

// Addendum T: each rung draws from its own allow-list. Two rungs' allow-lists can overlap (20 and
// 40 both allow roundTo/roundMode), so a seed CAN move the same rule twice -- rule 33 explicitly
// allows this ("a rule amended at an earlier rung stays amended unless a later amendment moves it
// again"), so this only pins that every draw is a legal member of its own rung's allow-list, and
// that `.from` always reflects whatever the running value actually is (so a repeat is a real
// second move, never a no-op).
test('every rung draws only from its own allow-list, and a repeat move is a real change', () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    const drawn = drawAmendments(seed);
    const seenRules = new Map();
    for (const a of drawn) {
      const allowed = AMENDMENT_ALLOWED_RULES[a.atRung];
      assert.ok(allowed, `seed ${seed}: rung ${a.atRung} has no allow-list`);
      assert.ok(allowed.includes(a.rule), `seed ${seed}: rung ${a.atRung} drew "${a.rule}", outside its allow-list ${allowed.join(', ')}`);
      const prior = seenRules.get(a.rule);
      if (prior !== undefined) assert.equal(a.from, prior, `seed ${seed}: rung ${a.atRung}'s "from" for ${a.rule} does not match the earlier amendment's "to"`);
      assert.notEqual(a.to, a.from, `seed ${seed}: rung ${a.atRung} "changes" ${a.rule} to the value it already had`);
      seenRules.set(a.rule, a.to);
    }
  }
});

test('every amendment rule that a future band could depend on has at least one rung whose allow-list can draw it', () => {
  for (const rule of Object.keys(AMENDMENT_RULES)) {
    const coverable = AMENDMENT_RUNGS.some((atRung) => (AMENDMENT_ALLOWED_RULES[atRung] ?? Object.keys(AMENDMENT_RULES)).includes(rule));
    assert.ok(coverable, `"${rule}" cannot be drawn by any amendment rung`);
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

// valueOf(entry, world, n): the entry's own field, resolved through rulesAt at rung n. Generic
// over `path` because an amendment's field can live under `rules` (roundTo, roundMode,
// opacityCompound, defaultFps) or under `hmac` (hmacCanon) -- `AMENDMENT_RULES` says which.
function valueOf(entry, world, n) {
  return rulesAt(world, n)[entry.path[0]][entry.path[1]];
}

test('rulesAt is the base world below the first amendment and accumulates above it', () => {
  const seed = 3;
  const base = makeWorld(seed);
  const world = amendedWorld(seed);
  const [first, second, third, fourth] = world.amendments;
  assert.deepEqual([first.atRung, second.atRung, third.atRung, fourth.atRung], AMENDMENT_RUNGS);

  for (const n of [0, 10, 19]) {
    assert.equal(rulesAt(world, n), world, `rung ${n} should resolve to the world itself`);
    assert.equal(valueOf(first, world, n), valueOf(first, base, n));
  }
  assert.equal(valueOf(first, world, first.atRung), first.to, 'live from its own rung, not the next one');
  assert.equal(valueOf(second, world, 29), second.from, 'a later amendment must not leak backwards');
  assert.equal(valueOf(second, world, second.atRung), second.to);
  assert.equal(valueOf(first, world, second.atRung), first.to, 'amendments accumulate');
  assert.equal(valueOf(third, world, 59), third.to);
  assert.equal(valueOf(fourth, world, 59), fourth.from, 'the fourth amendment must not leak backwards either');
  assert.equal(valueOf(fourth, world, 99), fourth.to);
  assert.equal(valueOf(first, world, 99), first.to);
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

// Seeds whose FIRST amendment (Addendum T: at rung 20, drawn from {roundTo, roundMode,
// opacityCompound}) moves geometry (the grid step or the rounding direction), so the amended key
// is observably different rather than merely differently labelled.
const GEOMETRY_SEEDS = [2, 5, 6];

test('a rung composed above a geometry amendment differs from the same rung composed below it', () => {
  for (const seed of GEOMETRY_SEEDS) {
    const base = unamendedWorld(seed);
    const world = amendedWorld(seed);
    const first = world.amendments[0];
    assert.ok(['roundTo', 'roundMode'].includes(first.rule), `seed ${seed} is not a geometry-amendment seed any more`);

    // below the amendment: byte-identical, because nothing is in force yet
    for (const n of [0, 10, 19]) {
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
  for (const n of [0, 19, 20, 29, 30, 39, 40, 59, 60, 99]) {
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
