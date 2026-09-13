// Addendum I rule 4: the answer key must be derivable from the documents.
// docsolver.js is written clean-room from docs/RULES-0.5.md, the skill, the spec and the
// rung text. If it disagrees with makeRung on any rung, one of the two is wrong and the
// build is red.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeWorld } from '../src/world.js';
import { makeRung } from '../src/ladder/rung.js';
import {
  solve, gate, snap6, roundToGrid, gridAfterScale, firstDifference, DocSolveError,
} from '../src/ladder/docsolver.js';

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

// A task the solver can chew on without any live state, used by the loud-failure tests.
const PLAIN_SHAPE = 'a rectangle 10 across and 10 down, its top-left corner 1 from the left '
  + 'and 1 from the top, painted #ffffff at 50 percent solid';
const plainTask = (middle) =>
  `Make a picture 100 by 100 pixels, on a #000000 ground, carrying these, bottom of the pile first: `
  + `(1) ${PLAIN_SHAPE}. ${middle}Turn in exactly that piece.`;

test('house arithmetic matches the rules RULES-0.5 states', () => {
  // rule 2: the six-decimal snap, so 0.56 in at 300 dpi is 168, never 168.00000000000003
  assert.equal(snap6(168.00000000000003), 168);
  assert.equal(snap6(0.1234565), 0.123457);
  // rule 3: the house grid, in each of the three house directions
  assert.equal(roundToGrid(139.960630, 4, 'down'), 136);
  assert.equal(roundToGrid(139.960630, 4, 'up'), 140);
  assert.equal(roundToGrid(139.960630, 4, 'nearest'), 140);
  assert.equal(roundToGrid(207.00000000000003, 4, 'down'), 204);
  assert.equal(roundToGrid(-78.03, 4, 'down'), -80);
  assert.equal(roundToGrid(41, 16, 'nearest'), 48);
  // rule 3, second sentence: an exact multiple is left exactly where it is
  for (const mode of ['up', 'down', 'nearest']) assert.equal(roundToGrid(128, 16, mode), 128);
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
    () => solve(world, plainTask('Then, in this order: (1) rotate what you have by 90 degrees. '), 0),
    (err) => {
      assert.ok(err instanceof DocSolveError);
      assert.match(err.message, /rotate what you have by 90 degrees/);
      return true;
    },
  );
});

test('a sentence with no rule behind it is left unconsumed and fails loudly', () => {
  const world = makeWorld(1);
  assert.throws(
    () => solve(world, plainTask('The house quietly halves everything on a Tuesday. '), 0),
    (err) => {
      assert.ok(err instanceof DocSolveError);
      assert.match(err.message, /unconsumed task text/);
      assert.match(err.message, /halves everything on a Tuesday/);
      return true;
    },
  );
});

test('a derived percentage over something the rung never produced fails loudly', () => {
  const world = makeWorld(1);
  const middle = 'Then, in this order: (1) shrink what you have down to a percentage of its own size '
    + 'you have to work out like this -- start at 90 and take 2 off for every frame in the stitched clip '
    + '-- keeping its shape the same. ';
  assert.throws(
    () => solve(world, plainTask(middle), 0),
    (err) => {
      assert.ok(err instanceof DocSolveError);
      assert.match(err.message, /counts something this rung never produced/);
      assert.match(err.message, /every frame in the stitched clip/);
      return true;
    },
  );
  const unknown = 'Then, in this order: (1) shrink what you have down to a percentage of its own size '
    + 'you have to work out like this -- start at 90 and take 2 off for every seagull on the roof '
    + '-- keeping its shape the same. ';
  assert.throws(
    () => solve(world, plainTask(unknown), 0),
    (err) => {
      assert.match(err.message, /unknown thing to count/);
      assert.match(err.message, /every seagull on the roof/);
      return true;
    },
  );
});

test('a cross-rung reference with nothing remembered fails loudly rather than guessing', () => {
  const world = makeWorld(1);
  const text = 'Make a picture as wide and as tall as the piece you turned in at step 7, on a #000000 ground, '
    + `carrying these, bottom of the pile first: (1) ${PLAIN_SHAPE}. Turn in exactly that piece.`;
  assert.throws(
    () => solve(world, text, 20),
    (err) => {
      assert.ok(err instanceof DocSolveError);
      assert.match(err.message, /opts\.history/);
      return true;
    },
  );
  // rules 21 + 22: a recalled size comes straight off what was turned in, already on the grid.
  const history = new Map([[7, { kind: 'image', width: 128, height: 64, background: { color: '#abcdef' }, shapes: [] }]]);
  const [out] = solve(world, text, 20, { history });
  assert.equal(out.width, 128);
  assert.equal(out.height, 64);
  assert.equal(out.background.color, '#000000');

  const ground = 'Make a picture 100 by 100 pixels, on the same ground colour as the piece you turned in at step 7, '
    + `carrying these, bottom of the pile first: (1) ${PLAIN_SHAPE}. Turn in exactly that piece.`;
  const [recalled] = solve(world, ground, 20, { history });
  assert.equal(recalled.background.color, '#abcdef');
});

test('an announced change never alters the finished artifact (RULES-0.5 rule 27)', () => {
  const world = makeWorld(1);
  const warning = 'Fair warning: the house has changed something about the way it answers, starting with this '
    + 'piece of work. Nobody will tell you what. Read what actually comes back on every call rather than what '
    + 'you expected to come back.';
  const quiet = solve(world, plainTask(''), 0);
  const warned = solve(world, `${plainTask('')} ${warning}`, 0);
  assert.deepEqual(warned, quiet);
});

test('a library haul with no listing to read fails loudly rather than inventing one', () => {
  const world = makeWorld(1);
  const text = 'Work through the pictures held in the session the house calls "Project 1.1", over in the shop '
    + 'the house calls "Workspace 1", 3 at a time. Give the house style called "Moss" to the first 6 of them '
    + 'in the order the house lists them, then stack all of those into one, oldest at the bottom, fading each '
    + 'layer against the one below it with a stacking step of 0.91. Turn in the last piece that leaves you with.';
  assert.throws(
    () => solve(world, text, 40),
    (err) => {
      assert.ok(err instanceof DocSolveError);
      assert.match(err.message, /listProjectAssets/);
      return true;
    },
  );
});

// The one rule this solver uses that docs/RULES-0.5.md does not state. If a future
// change makes media.js snap inside a scale lora, or RULES-0.5.md grows the sentence
// that says it does not, THIS test is the one to delete -- not the carve-out on its own.
test('gridAfterScale is load-bearing: the scale lora grids the raw product, not the snapped one', () => {
  // seed 10: roundTo 2, direction up. 75 x 1.36 is 102.00000000000001 in IEEE-754.
  const up2 = { rules: { roundTo: 2, roundMode: 'up' } };
  assert.equal(gridAfterScale(up2, 75 * 1.36), 104);
  assert.equal(roundToGrid(snap6(75 * 1.36), 2, 'up'), 102);
  // seed 5: roundTo 16, nearest. 200 x 1.16 is 231.99999999999997.
  const near16 = { rules: { roundTo: 16, roundMode: 'nearest' } };
  assert.equal(gridAfterScale(near16, 200 * 1.16), 224);
  assert.equal(roundToGrid(snap6(200 * 1.16), 16, 'nearest'), 240);
});

// Nine rungs on seeds 1-20 are decided by the carve-out above. They are gated by the
// per-seed gate tests below too; naming them here is what makes a regression legible.
test('the rungs decided by the undocumented scale-lora rounding still agree', async () => {
  for (const [seed, rungs] of [[5, [90]], [10, [40, 77, 81, 84, 86, 88, 91, 93]]]) {
    const world = makeWorld(seed);
    const { agree, disagree } = await gate(world, 0, 99);
    assert.deepEqual(
      disagree.map((d) => d.n),
      [],
      `seed ${seed} should still agree everywhere; the rungs this carve-out decides are ${rungs.join(', ')}`,
    );
    for (const n of rungs) assert.ok(agree.includes(n), `seed ${seed} rung ${n} not in the agreeing set`);
  }
});

test('firstDifference reports the first differing leaf', () => {
  assert.equal(firstDifference({ a: 1, b: [2, 3] }, { a: 1, b: [2, 3] }), null);
  assert.deepEqual(firstDifference({ a: 1 }, { a: 2 }), { path: '$.a', a: 1, b: 2 });
  assert.deepEqual(firstDifference([1], [1, 2]), { path: '$.length', a: 1, b: 2 });
});

// Every 0.5.0 obligation has to be on the ladder somewhere, or the gate above is green
// for the wrong reason: it cannot prove a rule is right if no rung ever exercises it.
test('the ladder exercises every 0.5.0 obligation the solver models', () => {
  const wanted = {
    'cross-rung recalled size (rule 21)': /as wide and as tall as the piece you turned in at step \d+/,
    'cross-rung recalled ground (rule 21)': /same ground colour as the piece you turned in at step \d+/,
    'derived count: leftover shapes (rule 19)': /every shape left on that leftover piece/,
    'derived count: stacked shapes (rule 19)': /every shape on the stack you just built/,
    'derived count: leftover tones (rule 19)': /every tone left over when you took the second sound out of the first/,
    'derived count: stitched frames (rules 16, 17, 19)': /every frame in the stitched clip/,
    'derived count: standing copies (rule 19)': /every copy of yours still standing in that listing/,
    'announced change (rule 26)': /Fair warning: the house has changed something/,
    'signing chain (rule 24)': /sign and send the release notice/,
    'conditional write (rule 25)': /write a word of your own onto it/,
    'content negotiation': /as a spreadsheet/,
    'soft delete': /clear out the last/,
    'multi-rule ordering (0.5.0 rule 6)': /Order is the whole game here/,
  };
  const seen = Object.fromEntries(Object.keys(wanted).map((k) => [k, 0]));
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    for (let n = FROM; n <= TO; n += 1) {
      const { text } = makeRung(world, n);
      for (const [label, re] of Object.entries(wanted)) if (re.test(text)) seen[label] += 1;
    }
  }
  const missing = Object.entries(seen).filter(([, count]) => count === 0).map(([label]) => label);
  assert.deepEqual(missing, [], `no rung on seeds ${SEEDS[0]}-${SEEDS[SEEDS.length - 1]} exercises: ${missing.join(', ')}`);
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
