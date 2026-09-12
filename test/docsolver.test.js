// Addendum I rule 4: the answer key must be derivable from the documents.
// docsolver.js is written clean-room from the skill, the spec and the rung text.
// If it disagrees with makeRung on any rung, one of the two is wrong and the build is red.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeWorld } from '../src/world.js';
import { solve, gate, snap6, roundToGrid, firstDifference, DocSolveError } from '../src/ladder/docsolver.js';

const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
const FROM = 0;
const TO = 99;

function describe(entry) {
  const head = `  seed ${entry.seed} rung ${entry.n}`;
  if (entry.error !== undefined) {
    return [head, `    ${entry.error}`, entry.text === undefined ? null : `    task: ${entry.text}`]
      .filter((l) => l !== null).join('\n');
  }
  return [
    head,
    `    leaf: ${entry.leaf}`,
    `    docsolver: ${JSON.stringify(entry.doc)}`,
    `    answer key: ${JSON.stringify(entry.key)}`,
    `    task: ${entry.text}`,
  ].join('\n');
}

test('house arithmetic matches the rules the skill states', () => {
  assert.equal(snap6(168.00000000000003), 168);
  assert.equal(snap6(0.1234565), 0.123457);
  assert.equal(roundToGrid(139.960630, 4, 'down'), 136);
  assert.equal(roundToGrid(139.960630, 4, 'up'), 140);
  assert.equal(roundToGrid(139.960630, 4, 'nearest'), 140);
  assert.equal(roundToGrid(207.00000000000003, 4, 'down'), 204);
  assert.equal(roundToGrid(-78.03, 4, 'down'), -80);
  assert.equal(roundToGrid(41, 16, 'nearest'), 48);
});

test('an unparsable task phrase fails loudly and names the phrase', () => {
  const world = makeWorld(1);
  assert.throws(
    () => solve(world, 'Make a picture 10 by 10 furlongs, on a #000000 ground, carrying these, bottom of the pile first: (1) a blob. Turn in exactly that piece.', 0),
    (err) => {
      assert.ok(err instanceof DocSolveError, `expected DocSolveError, got ${err && err.name}`);
      assert.match(err.message, /furlongs|blob|create clause/);
      return true;
    },
  );
  assert.throws(
    () => solve(world, 'Make a picture 100 by 100 pixels, on a #000000 ground, carrying these, bottom of the pile first: (1) a rectangle 10 across and 10 down, its top-left corner 1 from the left and 1 from the top, painted #ffffff at 50 percent solid. Then, in this order: (1) rotate what you have by 90 degrees. Turn in exactly that piece.', 0),
    (err) => {
      assert.ok(err instanceof DocSolveError);
      assert.match(err.message, /rotate what you have by 90 degrees/);
      return true;
    },
  );
});

test('firstDifference reports the first differing leaf', () => {
  assert.equal(firstDifference({ a: 1, b: [2, 3] }, { a: 1, b: [2, 3] }), null);
  assert.deepEqual(firstDifference({ a: 1 }, { a: 2 }), { path: '$.a', a: 1, b: 2 });
  assert.deepEqual(firstDifference([1], [1, 2]), { path: '$.length', a: 1, b: 2 });
});

for (const seed of SEEDS) {
  test(`docsolver equals the answer key for seed ${seed}, rungs ${FROM}-${TO}`, async () => {
    const world = makeWorld(seed);
    const { agree, disagree } = await gate(world, FROM, TO);
    if (disagree.length > 0) {
      const shown = disagree.slice(0, 3).map((d) => describe({ seed, ...d })).join('\n');
      assert.fail(
        `seed ${seed}: ${disagree.length} of ${agree.length + disagree.length} rungs disagree `
        + `(${disagree.map((d) => d.n).join(', ')})\n${shown}`,
      );
    }
    assert.equal(agree.length, TO - FROM + 1);
  });
}
