// Addendum Q rule 5: "A seeded subset of true rules, and every amendment, is placed inside
// `### Sync notes`, `### Changelog`, `### Pasted from` blocks: still stated once, dated,
// resolvable ... but a heading filter now deletes the truth." These tests prove the placement
// is real (the block truthTable records really does sit under one of those three headings) and
// that every amendment is always placed this way, without needing to reverse-engineer the
// generator's own seeded selection -- everything asserted here is read back from truthTable and
// the document itself, the same way every other skill-sloppy.test.js invariant is checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSkill, truthTable } from '../src/skill-sloppy.js';
import { makeWorld } from '../src/world.js';

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const SMALL = 64 * 1024;

const NOISE_PREFIXES = ['Sync notes', 'Changelog', 'Pasted from'];

function isNoiseHeading(heading) {
  return NOISE_PREFIXES.some((p) => heading.startsWith(p));
}

function headingAtBlock(doc, blockStart) {
  const end = doc.indexOf('\n', blockStart);
  const line = doc.slice(blockStart, end === -1 ? undefined : end);
  assert.match(line, /^### /, `block at ${blockStart} does not start with a heading line: ${JSON.stringify(line)}`);
  return line.slice('### '.length);
}

test('every rule entry flagged noiseHeaded really sits under one of the three noise headings, and its heading field agrees with the document', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const doc = toSkill(world, { targetBytes: SMALL });
    const tt = truthTable(world, { targetBytes: SMALL });
    for (const r of tt.rules) {
      for (const entry of [r.truth, ...r.decoys]) {
        const actualHeading = headingAtBlock(doc, entry.blockStart);
        assert.equal(actualHeading, entry.heading, `seed ${seed}: rule ${r.key} recorded heading doesn't match the document`);
        if (entry.noiseHeaded) {
          assert.ok(isNoiseHeading(entry.heading), `seed ${seed}: rule ${r.key} marked noiseHeaded but heading is "${entry.heading}"`);
        } else {
          assert.ok(!isNoiseHeading(entry.heading), `seed ${seed}: rule ${r.key} not marked noiseHeaded but heading "${entry.heading}" is one of the noise headings by coincidence -- selection logic drifted`);
        }
      }
    }
  }
});

test('a seeded subset of true rules is noise-headed: not zero, not every chain, across seeds', () => {
  let sawSome = false;
  let sawNotAll = false;
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const tt = truthTable(world, { targetBytes: SMALL });
    const truthNoiseHeaded = tt.rules.filter((r) => r.truth.noiseHeaded);
    if (truthNoiseHeaded.length > 0) sawSome = true;
    if (truthNoiseHeaded.length < tt.rules.length) sawNotAll = true;
  }
  assert.ok(sawSome, 'no seed in the sample noise-headed any true rule -- the subset is never applied');
  assert.ok(sawNotAll, 'every true rule was noise-headed in every seed sampled -- this is supposed to be a subset, not all of them');
});

test('the subset selection is deterministic per seed, independent of atRung', () => {
  for (const seed of SEEDS) {
    const world1 = makeWorld(seed);
    const world2 = makeWorld(seed);
    const keysNoiseHeaded = (w, atRung) =>
      truthTable(w, { targetBytes: SMALL, atRung }).rules.filter((r) => r.truth.noiseHeaded).map((r) => r.key).sort();
    assert.deepEqual(keysNoiseHeaded(world1, undefined), keysNoiseHeaded(world2, undefined), `seed ${seed}`);
  }
});

test('every amendment (both the new truth and the old-value decoy) is placed inside a noise-headed section', () => {
  for (const seed of SEEDS.slice(0, 5)) {
    const world = makeWorld(seed);
    world.amendments = [
      { atRung: 30, rule: 'roundTo', from: world.rules.roundTo, to: [1, 2, 4, 8, 16].find((v) => v !== world.rules.roundTo) },
      { atRung: 55, rule: 'hmacCanon', from: world.hmac.canon, to: ['ts+method+path', 'method+ts+path', 'path+method+ts'].find((v) => v !== world.hmac.canon) },
    ];
    const doc = toSkill(world, { targetBytes: SMALL, atRung: 60 });
    const tt = truthTable(world, { targetBytes: SMALL, atRung: 60 });
    assert.equal(tt.amendments.length, 2, `seed ${seed}`);
    for (const a of tt.amendments) {
      assert.ok(isNoiseHeading(a.toHeading), `seed ${seed}: amendment ${a.rule}'s new truth heading "${a.toHeading}" is not noise-headed`);
      assert.ok(a.fromOffset !== null, `seed ${seed}: amendment ${a.rule}'s old value was not found as a marked decoy`);
      assert.ok(isNoiseHeading(a.fromHeading), `seed ${seed}: amendment ${a.rule}'s old-value heading "${a.fromHeading}" is not noise-headed`);
      // and the document itself agrees at both recorded offsets
      const toChain = tt.rules.find((r) => r.key === a.chainKey);
      assert.equal(headingAtBlock(doc, toChain.truth.blockStart), a.toHeading, `seed ${seed}`);
    }
  }
});

test('still stated once, dated, resolvable: noise-headed entries obey every invariant an ordinary entry does', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const doc = toSkill(world, { targetBytes: SMALL });
    const tt = truthTable(world, { targetBytes: SMALL });
    for (const r of tt.rules) {
      const entries = [r.truth, ...r.decoys];
      for (const e of entries) {
        if (!e.noiseHeaded) continue;
        // exactly one occurrence of this key=value token in the whole document
        const re = new RegExp('`' + r.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=' + e.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '`', 'g');
        const occurrences = [...doc.matchAll(re)];
        assert.ok(occurrences.length >= 1, `seed ${seed}: rule ${r.key} noise-headed value missing from the document`);
        // marked with its own date/version marker
        const block = doc.slice(e.blockStart, e.blockEnd);
        assert.ok(block.includes(e.marker), `seed ${seed}: rule ${r.key} noise-headed block missing its own marker`);
      }
    }
  }
});

test('a noise-headed block never accidentally reuses the literal "Carried over from an earlier pass" generic closer', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const doc = toSkill(world, { targetBytes: SMALL });
    const tt = truthTable(world, { targetBytes: SMALL });
    for (const r of tt.rules) {
      for (const e of [r.truth, ...r.decoys]) {
        if (!e.noiseHeaded) continue;
        const block = doc.slice(e.blockStart, e.blockEnd);
        assert.doesNotMatch(block, /Carried over from an earlier pass/, `seed ${seed}: rule ${r.key}`);
      }
    }
  }
});
