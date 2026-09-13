// Addendum I rule 4: the answer key must be derivable from the documents.
// docsolver.js is written clean-room from docs/RULES-0.7.md, the skill, the spec and the
// rung text. If it disagrees with makeRung on any rung, one of the two is wrong and the
// build is red.
//
// Addendum O rule 4 ("gates cover the seeds that run"): seeds 1-20 were the whole gate
// through 0.5.1 while every round ran on a different block, so the seeds that burned money
// were never the seeds the build checked. The default list is both. QUAERE_GATE_SEEDS
// overrides it ("1-20,700-740", "727", "600-620") for a round on a different block.
//
// New in 0.7.0 (Addendum Q):
//
//   rule 1  Every clause renders as one of FOUR seeded phrasings of identical meaning, so
//           a per-rung gate that only ever sees the phrasing the seed happened to draw
//           checks one reading in four. `makeRung(world, n, {phrasingVariant})` forces
//           each of them, and the sweep below asserts all four produce the same answer and
//           the same answer as the key. That is the test a literal-string solver fails.
//   rule 4  `rulesAt(world, n)` is the one resolver for an amended rule; the solver reads
//           it, so an amendment moves the arithmetic and the signing string with it.
//   rule 7  A refusal rung's answer includes the ABSENCE of the act the text asked for.
//   rule 10 The path is graded: the audit's stage sequence and canonical signing string
//           ride beside the descriptors.
//
// Tests here never grep a fixed sentence to decide what a rung says. Where a test needs to
// find or edit one, it asks the generator for the phrasings of that KIND (`phrasingsFor`)
// or the solver for its own predicate (`statesStitchAntecedent`). Nothing in this file may
// depend on which of the four a seed drew.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeWorld, drawAmendments, rulesAt, AMENDMENT_RULES } from '../src/world.js';
import { makeRung, PHRASING_COUNT, CLAUSE_KINDS, phrasingsFor } from '../src/ladder/rung.js';
import {
  solve, solveGraded, gate, solverOpts, snap6, roundToGrid, gridAfterScale, firstDifference,
  forbiddenSummary, statesStitchAntecedent, stripStitchAntecedent, PHRASINGS_PER_KIND,
  rebuildUnderCurrentRules, byteBudgetChoice, DocSolveError,
} from '../src/ladder/docsolver.js';

const range = (lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

// "1-20,700-740" -> [1..20, 700..740]; a bare number is a one-seed range.
function parseSeeds(spec) {
  const seeds = [];
  for (const piece of spec.split(',').map((s) => s.trim()).filter((s) => s !== '')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(piece);
    if (m === null) throw new Error(`QUAERE_GATE_SEEDS: cannot read ${JSON.stringify(piece)}`);
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (hi < lo) throw new Error(`QUAERE_GATE_SEEDS: ${piece} runs backwards`);
    seeds.push(...range(lo, hi));
  }
  if (seeds.length === 0) throw new Error('QUAERE_GATE_SEEDS is empty');
  return [...new Set(seeds)];
}

// Round four ran on 700-706; 0.7.0's round runs on the same block. The ladder is developed
// on 1-20. Both are gated.
const DEFAULT_SEEDS = [...range(1, 20), ...range(700, 740)];
const SEEDS = process.env.QUAERE_GATE_SEEDS === undefined
  ? DEFAULT_SEEDS
  : parseSeeds(process.env.QUAERE_GATE_SEEDS);
const FROM = 0;
const TO = 99;

// Addendum O: from this rung up a submission is graded on the project state, the label and
// (Addendum Q rule 10) the audit as well as the hash.
const GRADED_FROM = 50;

// The four-phrasing sweep is the expensive one: 100 rungs x 4 readings x a seed. Run it
// over a window of the gate seeds rather than all of them, and let QUAERE_PHRASING_SEEDS
// widen it when a phrasing bug is suspected.
const PHRASING_SEEDS = process.env.QUAERE_PHRASING_SEEDS === undefined
  ? [SEEDS[0], SEEDS[Math.floor(SEEDS.length / 2)], SEEDS[SEEDS.length - 1]]
  : parseSeeds(process.env.QUAERE_PHRASING_SEEDS);

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
// Every sentence in it is one of the four phrasings the generator can draw for its kind;
// which one is arbitrary and nothing here may depend on the choice.
const PLAIN_SHAPE = 'a rectangle 10 across and 10 down, its top-left corner 1 from the left '
  + 'and 1 from the top, painted #ffffff at 50 percent solid';
const plainTask = (middle, tail = '') =>
  'Make a picture 100 by 100 pixels, on a #000000 ground, carrying these, bottom of the pile first: '
  + `(1) ${PLAIN_SHAPE}. ${middle}${tail}Turn in exactly that piece.`;

const STAGES = 'Walk it all the way through the house stages in the house order -- lock it in, '
  + 'kick off the finishing run, and do not call it done until you check back and it actually says '
  + 'finished. ';
const SIGN = 'Then sign and send the release notice the house requires before anything can go out '
  + 'the door. ';
const writeNote = (word) => `Once you have that last piece, write the word "${word}" onto it -- and `
  + 'do it in a way that will fail rather than overwrite if anyone touched it between your reading '
  + 'it and your writing. ';

// Walk a seed's ladder, keeping this solver's own memory of what it turned in, and hand
// back the first rung whose KEY satisfies `wants`. Every test that needs a refusal rung, a
// stitch rung or a graded rung uses real generated text, never a hand-written imitation.
async function findRung(seed, wants) {
  const world = makeWorld(seed);
  const base = await solverOpts(world);
  const history = new Map();
  for (let n = FROM; n <= TO; n += 1) {
    const rung = makeRung(world, n);
    const opts = { ...base, history };
    if (wants(rung)) return { world, n, rung, opts };
    try {
      history.set(n, solve(world, rung.text, n, opts)[0]);
    } catch { /* only the rung the test wants has to solve */ }
  }
  return null;
}

// Does this text state that clause KIND, in any of its four phrasings? `phrasingsFor`
// renders a phrasing with its arguments interpolated, and a test rarely knows a rung's
// arguments, so the match is on the fixed fragments either side of them: a phrasing states
// the kind when every substantial fragment of it appears in the text. Nothing here greps a
// whole sentence, which is what Addendum Q rule 1 broke.
function statesKind(text, kind, args = {}) {
  return phrasingsFor(kind, args).some((phrase) => phrase
    .split('undefined')
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length > 12)
    .every((fragment) => text.includes(fragment)));
}

// Put a sentence in FRONT of the turn-in clause, whichever of its eight phrasings the seed
// drew. Used by the tests that need a rung to say one thing too many.
function insertBeforeTurnIn(text, sentence) {
  for (const kind of ['turnInLast', 'turnInExact']) {
    for (const phrase of phrasingsFor(kind, {})) {
      const at = text.indexOf(phrase);
      if (at !== -1) return `${text.slice(0, at)}${sentence} ${text.slice(at)}`;
    }
  }
  return assert.fail('that task states no turn-in clause in any phrasing');
}

// ---------------------------------------------------------------------------
// The arithmetic the rules state
// ---------------------------------------------------------------------------

test('house arithmetic matches the rules RULES-0.7 states', () => {
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

// The one rule this solver uses that docs/RULES-0.7.md does not state. If a future change
// makes media.js snap inside a scale lora, or RULES-0.7.md grows the sentence that says it
// does not, THIS test is the one to delete -- not the carve-out on its own.
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

test('firstDifference reports the first differing leaf', () => {
  assert.equal(firstDifference({ a: 1, b: [2, 3] }, { a: 1, b: [2, 3] }), null);
  assert.deepEqual(firstDifference({ a: 1 }, { a: 2 }), { path: '$.a', a: 1, b: 2 });
  assert.deepEqual(firstDifference([1], [1, 2]), { path: '$.length', a: 1, b: 2 });
});

// ---------------------------------------------------------------------------
// Addendum Q rule 1: four phrasings, one meaning
// ---------------------------------------------------------------------------

test('every paraphrased clause kind is read in all four of its phrasings', () => {
  const short = Object.entries(PHRASINGS_PER_KIND).filter(([, n]) => n !== PHRASING_COUNT);
  assert.deepEqual(
    short,
    [],
    `these kinds have drifted off ${PHRASING_COUNT} phrasings, so the ladder can state them `
    + 'in a way this solver cannot read -- a silent one-in-four failure, not a loud one',
  );
});

test('every clause kind the generator can emit is either read or known not to be emitted yet', () => {
  // RULES-0.7's appendix closes with the two kinds 0.7.0 does not emit: rule 34's
  // regression piece and rule 37's byte budget. They have no phrasings to read because no
  // rung states them; everything else must be in the solver's table.
  const NOT_YET_EMITTED = ['regressionRebuild', 'byteBudget'];
  // Kinds the solver reads as part of a larger clause rather than on their own: the
  // create clauses swallow their dims, ground, shape and tone kinds, and `piece` and
  // `labelled` are sub-phrases of other kinds.
  const READ_INSIDE = ['createImage', 'createAudio', 'shapeList', 'toneList', 'trap', 'mutation', 'round', 'order', 'idem'];
  const missing = CLAUSE_KINDS.filter((kind) => (
    PHRASINGS_PER_KIND[kind] === undefined
    && !READ_INSIDE.includes(kind)
    && !NOT_YET_EMITTED.includes(kind)
  ));
  assert.deepEqual(missing, [], `no clause-kind table in docsolver.js for: ${missing.join(', ')}`);
});

for (const seed of PHRASING_SEEDS) {
  test(`all four phrasings of every rung give the same answer, seed ${seed}`, async () => {
    const world = makeWorld(seed);
    const base = await solverOpts(world);
    const history = new Map();
    for (let n = FROM; n <= TO; n += 1) {
      const opts = { ...base, history };
      let first = null;
      for (let v = 0; v < PHRASING_COUNT; v += 1) {
        const rung = makeRung(world, n, { phrasingVariant: v });
        const got = solveGraded(world, rung.text, n, opts);
        const answer = {
          descriptors: got.descriptors,
          expectedProjectState: got.expectedProjectState,
          expectedLabel: got.expectedLabel,
          expectedAudit: got.expectedAudit,
          forbidden: forbiddenSummary(got.forbidden),
        };
        if (first === null) {
          first = answer;
          history.set(n, got.descriptors[got.descriptors.length - 1]);
        } else {
          const drift = firstDifference(answer, first);
          assert.equal(drift, null, `seed ${seed} rung ${n} phrasing ${v} drifts at ${drift && drift.path}`
            + `\n  phrasing 0: ${JSON.stringify(drift && drift.b)}\n  phrasing ${v}: ${JSON.stringify(drift && drift.a)}`
            + `\n  task: ${rung.text}`);
        }
        // The key does not move either: nothing in an answer turns on which phrasing drew.
        const keyDrift = firstDifference(answer.descriptors, rung.expectedDescriptors);
        assert.equal(keyDrift, null, `seed ${seed} rung ${n} phrasing ${v}: key disagrees at ${keyDrift && keyDrift.path}`);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Failing loudly, which is the whole point of a clean-room gate
// ---------------------------------------------------------------------------

test('a clause kind outside the RULES-0.7 appendix fails loudly and names the residue', () => {
  const world = makeWorld(SEEDS[0]);
  assert.throws(
    () => solve(world, plainTask('The house quietly halves everything on a Tuesday. '), 0),
    (err) => {
      assert.ok(err instanceof DocSolveError, `expected DocSolveError, got ${err && err.name}`);
      assert.match(err.message, /no clause kind in the RULES-0\.7 appendix states this/);
      assert.match(err.message, /halves everything on a Tuesday/);
      return true;
    },
  );
});

test('an unreadable create clause and an unreadable shape both fail loudly', () => {
  const world = makeWorld(SEEDS[0]);
  assert.throws(
    () => solve(world, 'Make a picture 10 by 10 furlongs, on a #000000 ground, carrying these, bottom of the pile first: (1) a blob. Turn in exactly that piece.', 0),
    (err) => {
      assert.ok(err instanceof DocSolveError);
      assert.match(err.message, /furlongs|blob|no clause kind/);
      return true;
    },
  );
  assert.throws(
    () => solve(world, `Make a picture 100 by 100 pixels, on a #000000 ground, carrying these, bottom of the pile first: (1) a blob 3 wide, painted #ffffff at 50 percent solid. Turn in exactly that piece.`, 0),
    (err) => {
      assert.ok(err instanceof DocSolveError);
      assert.match(err.message, /no shape kind in the appendix states this/);
      return true;
    },
  );
});

test('an unreadable chain step fails loudly and names the step', () => {
  const world = makeWorld(SEEDS[0]);
  assert.throws(
    () => solve(world, plainTask('Then, in this order: (1) rotate what you have by 90 degrees. '), 0),
    (err) => {
      assert.ok(err instanceof DocSolveError);
      assert.match(err.message, /no chain step kind in the appendix states this/);
      assert.match(err.message, /rotate what you have by 90 degrees/);
      return true;
    },
  );
});

test('a derived percentage over something the rung never produced fails loudly', () => {
  const world = makeWorld(SEEDS[0]);
  const middle = 'Then, in this order: (1) shrink what you have down to a percentage of its own size '
    + 'you have to work out like this -- start at 90 and take 2 off for every frame in the stitched clip '
    + '-- keeping its shape the same. ';
  assert.throws(
    () => solve(world, plainTask(middle), 0),
    (err) => {
      assert.ok(err instanceof DocSolveError);
      assert.match(err.message, /counts something this rung never produced/);
      assert.match(err.message, /frame in the stitched clip/);
      return true;
    },
  );
  const unknown = 'Then, in this order: (1) shrink what you have down to a percentage of its own size '
    + 'you have to work out like this -- start at 90 and take 2 off for every seagull on the roof '
    + '-- keeping its shape the same. ';
  assert.throws(
    () => solve(world, plainTask(unknown), 0),
    (err) => {
      // rule 19 closes the list of things that can be counted, so an unknown one is a
      // generator bug, never a number to guess at.
      assert.match(err.message, /no chain step kind in the appendix states this/);
      assert.match(err.message, /seagull on the roof/);
      return true;
    },
  );
});

test('a cross-rung reference with nothing remembered fails loudly rather than guessing', () => {
  const world = makeWorld(SEEDS[0]);
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

test('a library haul with no listing to read fails loudly rather than inventing one', () => {
  const world = makeWorld(SEEDS[0]);
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

test('an announced change never alters the finished artifact (rule 27)', () => {
  const world = makeWorld(SEEDS[0]);
  const warning = 'Fair warning: the house has changed something about the way it answers, starting with this '
    + 'piece of work. Nobody will tell you what. Read what actually comes back on every call rather than what '
    + 'you expected to come back.';
  const quiet = solve(world, plainTask(''), 0);
  const warned = solve(world, `${plainTask('')} ${warning}`, 0);
  assert.deepEqual(warned, quiet);
});

// ---------------------------------------------------------------------------
// Rule 28: the antecedent of the chain that follows a stitch
// ---------------------------------------------------------------------------

// This is the rung-60 fall of 0.5.0 round two: three climbs did the arithmetic perfectly
// and applied it to the stitched clip instead of the picture.
test('after a stitch the chain carries on with the picture, not the clip', async () => {
  const found = await findRung(SEEDS[0], (rung) => statesStitchAntecedent(rung.text));
  assert.ok(found !== null, `no rung on seed ${SEEDS[0]} stitches`);
  const [out] = solve(found.world, found.rung.text, found.n, found.opts);
  assert.equal(out.kind, 'image', `rung ${found.n} should turn in the picture, not the ${out.kind}`);
  assert.match(found.rung.text, /frame in the stitched clip/);
});

test('a stitch rung whose text drops the antecedent fails loudly rather than inferring it', async () => {
  const found = await findRung(SEEDS[0], (rung) => statesStitchAntecedent(rung.text));
  assert.ok(found !== null);
  const stripped = stripStitchAntecedent(found.rung.text);
  assert.notEqual(stripped, found.rung.text);
  assert.equal(statesStitchAntecedent(stripped), false);
  assert.throws(
    () => solve(found.world, stripped, found.n, found.opts),
    (err) => {
      assert.ok(err instanceof DocSolveError, `expected DocSolveError, got ${err && err.name}`);
      assert.match(err.message, /only there to be counted \(rule 28\)/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Rules 23, 25, 29 and Addendum O: the graded chain
// ---------------------------------------------------------------------------

test('the conditional write names the word, and it is read off the text never chosen', () => {
  const world = makeWorld(SEEDS[0]);
  const graded = solveGraded(world, plainTask(`${STAGES}${SIGN}`, writeNote('quartz')), 0);
  assert.equal(graded.expectedLabel, 'quartz');
  assert.equal(graded.expectedProjectState, 'published');
  // Rule 25: the write changes labels only, never the descriptor.
  assert.deepEqual(graded.descriptors, solve(world, plainTask(''), 0));
});

test('a rung that demands no stages and no word grades neither', () => {
  const graded = solveGraded(makeWorld(SEEDS[0]), plainTask(''), 0);
  assert.equal(graded.expectedProjectState, null);
  assert.equal(graded.expectedLabel, null);
  assert.equal(graded.expectedAudit, null);
  assert.equal(graded.forbidden, null);
});

test('a release notice with no finishing run before it fails loudly (rule 23)', () => {
  const world = makeWorld(SEEDS[0]);
  assert.throws(
    () => solve(world, plainTask(SIGN), 0),
    (err) => {
      assert.ok(err instanceof DocSolveError);
      assert.match(err.message, /release notice out of turn \(rule 23\)/);
      return true;
    },
  );
  assert.equal(solveGraded(world, plainTask(STAGES), 0).expectedProjectState, 'rendered');
});

test('a word written after the turn-in would label a different piece, and fails loudly', () => {
  const world = makeWorld(SEEDS[0]);
  const text = `${plainTask(`${STAGES}${SIGN}`)} ${writeNote('quartz').trim()}`;
  assert.throws(
    () => solve(world, text, 0),
    (err) => {
      assert.ok(err instanceof DocSolveError);
      assert.match(err.message, /conditional write lands after the turn-in \(rule 29\)/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Addendum Q rule 10: grade the path, not only the terminus
// ---------------------------------------------------------------------------

test('the audit records the stage sequence and the canonical signing string', async () => {
  const found = await findRung(SEEDS[0], (rung) => rung.expectedAudit !== null && rung.expectedAudit !== undefined);
  assert.ok(found !== null, `no rung on seed ${SEEDS[0]} grades a path`);
  assert.ok(found.n >= GRADED_FROM, `the audit is graded below rung ${GRADED_FROM}`);
  const graded = solveGraded(found.world, found.rung.text, found.n, found.opts);
  assert.deepEqual(graded.expectedAudit, found.rung.expectedAudit);
  // The 409 the text promises is in the sequence: rule 23 says the house refuses a stage
  // asked for out of turn, and Addendum Q rule 10 says the recovery is part of the path.
  assert.ok(graded.expectedAudit.stages.some((s) => s.endsWith(':409')), 'the audit records no out-of-turn refusal');
  assert.equal(graded.expectedAudit.stages[graded.expectedAudit.stages.length - 1], 'published');
  // Rule 35: the canonical string is the house's, and rule 33 may amend its field order,
  // so it is read off the rules in force and never hardcoded.
  assert.equal(graded.expectedAudit.canonical, rulesAt(found.world, found.n).hmac.canon);
  assert.equal(graded.expectedAudit.bodyDigestOf, 'submittedAsset');
});

test('a rung that never reaches published has no audit to grade', () => {
  const world = makeWorld(SEEDS[0]);
  assert.equal(solveGraded(world, plainTask(STAGES), 0).expectedAudit, null);
  assert.notEqual(solveGraded(world, plainTask(`${STAGES}${SIGN}`), 0).expectedAudit, null);
});

// ---------------------------------------------------------------------------
// Addendum Q rule 7 / RULES-0.7 rule 36: negative-space grading
// ---------------------------------------------------------------------------

test('a refusal rung reports the forbidden act and never performs it', async () => {
  const seen = new Set();
  for (const seed of SEEDS.slice(0, 12)) {
    const found = await findRung(seed, (rung) => rung.forbidden !== null && rung.forbidden !== undefined
      && !seen.has(rung.forbidden.act));
    if (found === null) continue;
    seen.add(found.rung.forbidden.act);
    const graded = solveGraded(found.world, found.rung.text, found.n, found.opts);
    assert.deepEqual(
      forbiddenSummary(graded.forbidden),
      forbiddenSummary(found.rung.forbidden),
      `seed ${seed} rung ${found.n}: the solver and the key disagree about what is forbidden`,
    );
    // Rule 36: the act is left undone. A rung that forbids a word grades no label, and a
    // rung that forbids work on the cleared-out copies never reaches for them, so the
    // piece turned in is exactly the piece the rest of the task produces.
    assert.equal(graded.expectedLabel, null, 'a refusal rung graded a label as well');
    assert.deepEqual(graded.descriptors, found.rung.expectedDescriptors);
    assert.ok([29, 30].includes(graded.forbidden.rule), `rule ${graded.forbidden.rule} is not one of 29 or 30`);
  }
  assert.ok(seen.size >= 2, `only ${seen.size} of the three forbidden acts turned up on the first twelve gate seeds`);
});

test('two forbidden asks in one rung fail loudly rather than resolving to one reading', async () => {
  const found = await findRung(SEEDS[0], (rung) => rung.forbidden !== null && rung.forbidden !== undefined);
  assert.ok(found !== null, `no rung on seed ${SEEDS[0]} asks for anything forbidden`);
  const second = phrasingsFor('refusalLabelStack', { word: 'amber' })[0];
  const doubled = insertBeforeTurnIn(found.rung.text, second);
  assert.throws(
    () => solve(found.world, doubled, found.n, found.opts),
    (err) => {
      assert.ok(err instanceof DocSolveError, `expected DocSolveError, got ${err && err.name}`);
      assert.match(err.message, /rule 36 must resolve to one reading/);
      return true;
    },
  );
});

test('a rung that both demands a word and forbids one fails loudly (rules 29, 36)', async () => {
  const found = await findRung(SEEDS[0], (rung) => rung.forbidden !== null && rung.forbidden !== undefined
    && rung.forbidden.act === 'labelTheStack');
  if (found === null) return; // no labelTheStack rung on this seed; the gate still covers it
  const demanded = insertBeforeTurnIn(found.rung.text, writeNote('quartz').trim());
  assert.throws(
    () => solve(found.world, demanded, found.n, found.opts),
    (err) => {
      assert.ok(err instanceof DocSolveError);
      assert.match(err.message, /both demands a word and forbids one \(rule 29\)/);
      return true;
    },
  );
});

test('a refusal clause with nothing to refuse work on fails loudly', () => {
  const world = makeWorld(SEEDS[0]);
  const orphan = phrasingsFor('refusalWorkOnCleared', { lora: 'Moss' })[0];
  assert.throws(
    () => solve(world, plainTask(`${orphan} `)),
    (err) => {
      assert.ok(err instanceof DocSolveError);
      assert.match(err.message, /nothing cleared out|no clause kind/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Rules 31 and 32: a short page is not the end, and the count is this rung's own
// ---------------------------------------------------------------------------

test('every rung that hauls a listing states the short-page rule, and the solver reads it', async () => {
  const shortPage = phrasingsFor('shortPage', {});
  assert.equal(shortPage.length, PHRASING_COUNT);
  let hauls = 0;
  const world = makeWorld(SEEDS[0]);
  const base = await solverOpts(world);
  const history = new Map();
  for (let n = FROM; n <= TO; n += 1) {
    const rung = makeRung(world, n);
    const opts = { ...base, history };
    if (statesKind(rung.text, 'shortPage')) hauls += 1;
    history.set(n, solve(world, rung.text, n, opts)[0]);
  }
  assert.ok(hauls > 0, `no rung on seed ${SEEDS[0]} states rule 31, so the short-page rule is untested`);
});

test('a clear-out with no haul in front of it fails loudly', () => {
  const world = makeWorld(SEEDS[0]);
  const orphan = 'Then clear out the last 2 of the copies you just made -- confirm they really are gone '
    + 'from the ordinary listing, and that they still turn up when you ask for the cleared-out ones as '
    + 'well -- and then count how many of your copies are still standing in the ordinary listing, '
    + 'remembering it comes back a page at a time. ';
  assert.throws(
    () => solve(world, plainTask(orphan), 40),
    (err) => {
      assert.ok(err instanceof DocSolveError);
      assert.match(err.message, /no library haul|no clause kind/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Rule 33: the house amends its own rules partway up the ladder
// ---------------------------------------------------------------------------

// `drawAmendments` is exported unconditionally so the mechanism can be proved without
// waiting on the house to enforce it (src/world.js AMENDMENTS_ENFORCED). These tests
// inject amendments into a world by hand, exactly as test/amendment.test.js does on the
// generator side, and assert the solver resolves them through the same `rulesAt`.
function worldWithAmendment(seed, rule, to, atRung = 30) {
  const base = makeWorld(seed);
  const { path } = AMENDMENT_RULES[rule];
  const from = base[path[0]][path[1]];
  return { ...base, amendments: [{ atRung, rule, path, from, to }] };
}

test('an amended grid step moves the arithmetic from the announced rung on (rule 33)', () => {
  const base = makeWorld(SEEDS[0]);
  const { choices } = AMENDMENT_RULES.roundTo;
  const before = roundToGrid(100, base.rules.roundTo, base.rules.roundMode);
  const to = choices.find((c) => c !== base.rules.roundTo
    && roundToGrid(100, c, base.rules.roundMode) !== before);
  assert.ok(to !== undefined, 'no candidate grid step changes this seed 100-pixel answer');
  const world = worldWithAmendment(SEEDS[0], 'roundTo', to, 30);

  // Rule 33: below the announced rung the old rule is the rule.
  assert.equal(solve(world, plainTask(''), 29)[0].width, before);
  // From the announced rung on, the amended rule is the rule.
  assert.equal(solve(world, plainTask(''), 30)[0].width, roundToGrid(100, to, base.rules.roundMode));
  // And it accumulates: rung 99 is still on the amended grid.
  assert.equal(solve(world, plainTask(''), 99)[0].width, roundToGrid(100, to, base.rules.roundMode));
  // rulesAt is the one resolver, and the solver uses it rather than a copy of its own.
  assert.equal(rulesAt(world, 30).rules.roundTo, to);
  assert.equal(rulesAt(world, 29).rules.roundTo, base.rules.roundTo);
});

test('an amended signing order moves the audit and nothing else (rules 33, 35)', () => {
  const base = makeWorld(SEEDS[0]);
  const to = AMENDMENT_RULES.hmacCanon.choices.find((c) => c !== base.hmac.canon);
  const world = worldWithAmendment(SEEDS[0], 'hmacCanon', to, 30);
  const text = plainTask(`${STAGES}${SIGN}`, writeNote('quartz'));
  const before = solveGraded(world, text, 29);
  const after = solveGraded(world, text, 30);
  assert.equal(before.expectedAudit.canonical, base.hmac.canon);
  assert.equal(after.expectedAudit.canonical, to);
  // Rule 27's cousin: an amendment to the signing string changes what is signed, never
  // what the piece is.
  assert.deepEqual(after.descriptors, before.descriptors);
});

test('drawAmendments draws one change per announced rung, from the closed set', () => {
  const drawn = drawAmendments(SEEDS[0]);
  assert.ok(drawn.length > 0);
  for (const a of drawn) {
    assert.ok(Object.keys(AMENDMENT_RULES).includes(a.rule), `${a.rule} is outside the closed set`);
    assert.notEqual(a.from, a.to, 'an amendment that changes nothing is not an amendment');
    assert.ok(AMENDMENT_RULES[a.rule].choices.includes(a.to));
  }
  const rungs = drawn.map((a) => a.atRung);
  assert.deepEqual([...rungs].sort((x, y) => x - y), rungs, 'the announced rungs are out of order');
});

// ---------------------------------------------------------------------------
// Rules 34 and 37: written down, not yet emitted
// ---------------------------------------------------------------------------

test('rule 34 rebuilds an earlier piece under the rules in force NOW, and never edits it', () => {
  const base = makeWorld(SEEDS[0]);
  const to = AMENDMENT_RULES.roundTo.choices.find((c) => c !== base.rules.roundTo);
  const world = worldWithAmendment(SEEDS[0], 'roundTo', to, 30);
  const earlier = { kind: 'image', width: 100, height: 100, background: { color: '#000000' }, shapes: [] };
  const recipe = (w, piece) => ({ ...piece, width: roundToGrid(piece.width, w.rules.roundTo, w.rules.roundMode) });

  const old = rebuildUnderCurrentRules(world, 29, earlier, recipe);
  const now = rebuildUnderCurrentRules(world, 30, earlier, recipe);
  assert.equal(old.width, roundToGrid(100, base.rules.roundTo, base.rules.roundMode));
  assert.equal(now.width, roundToGrid(100, to, base.rules.roundMode));
  // "The earlier piece is not edited and not replaced; the rebuild is a new piece."
  assert.equal(earlier.width, 100);
  assert.notEqual(now, earlier);
  assert.throws(() => rebuildUnderCurrentRules(world, 30, null, recipe), DocSolveError);
  assert.throws(() => rebuildUnderCurrentRules(world, 30, earlier, undefined), DocSolveError);
});

test('rule 37 takes the largest candidate the house says still fits', () => {
  const bytes = { 48000: 900, 44100: 820, 22050: 410, 8000: 150 };
  const measure = (rate) => bytes[rate];
  const candidates = [8000, 22050, 44100, 48000];
  assert.deepEqual(byteBudgetChoice(candidates, measure, 1000), { candidate: 48000, bytes: 900 });
  assert.deepEqual(byteBudgetChoice(candidates, measure, 850), { candidate: 44100, bytes: 820 });
  assert.deepEqual(byteBudgetChoice(candidates, measure, 200), { candidate: 8000, bytes: 150 });
  // "The house is the only authority on how many bytes a piece actually takes": nothing
  // is computed locally, and nothing fitting is an error rather than a guess.
  assert.throws(() => byteBudgetChoice(candidates, measure, 100), DocSolveError);
  assert.throws(() => byteBudgetChoice([44100, 44100], measure, 1000), DocSolveError);
  assert.throws(() => byteBudgetChoice([], measure, 1000), DocSolveError);
});

// ---------------------------------------------------------------------------
// Coverage: the gate is green for the right reason
// ---------------------------------------------------------------------------

// Every obligation the solver models has to be on the ladder somewhere, or the gate is
// green for the wrong reason: it cannot prove a rule is right if no rung exercises it.
// Each entry asks a clause KIND whether it is stated -- never a fixed sentence, since rule
// 1 means any of four could be the one drawn.
test('the ladder exercises every obligation the solver models', () => {
  const byKind = {
    'cross-rung recalled size (rule 21)': (text) => statesKind(text, 'dimsRecall'),
    'cross-rung recalled ground (rule 21)': (text) => statesKind(text, 'groundRecall'),
    'derived count: leftover shapes (rule 19)': (text) => /shape left on that leftover piece/.test(text),
    'derived count: stacked shapes (rule 19)': (text) => /shape on the stack you just built/.test(text),
    'derived count: leftover tones (rule 19)': (text) => /tone left over when you took the second sound out of the first/.test(text),
    'derived count: stitched frames (rules 16, 17, 19)': (text) => /frame in the stitched clip/.test(text),
    'derived count: standing copies (rules 19, 32)': (text) => /copy of yours still standing in that listing/.test(text),
    'stitch antecedent (rule 28)': statesStitchAntecedent,
  };
  for (const kind of ['mutation', 'stage', 'sign', 'shortPage', 'clearOut', 'csvPull', 'order', 'trap', 'stack', 'idem']) {
    byKind[`clause kind: ${kind}`] = (text) => statesKind(text, kind);
  }
  const outstanding = new Set(Object.keys(byKind));
  // Deliberately DEFAULT_SEEDS and not SEEDS: whether the grammar can emit an obligation
  // at all is a property of the grammar, not of whichever block a round happens to run on.
  // The early exit is what keeps a 61-seed sweep cheap.
  for (const seed of DEFAULT_SEEDS) {
    if (outstanding.size === 0) break;
    const world = makeWorld(seed);
    for (let n = FROM; n <= TO; n += 1) {
      const { text } = makeRung(world, n);
      for (const label of [...outstanding]) if (byKind[label](text)) outstanding.delete(label);
    }
  }
  assert.deepEqual([...outstanding], [], `no rung on the default seeds exercises: ${[...outstanding].join(', ')}`);
});

// The whole of Addendum O's grading rule plus Addendum Q rule 10, over a real ladder: the
// key and the solver agree on what is graded, only rungs at or above GRADED_FROM are
// graded, and every graded label is a word the task text actually states.
test('the graded chain rides beside the descriptors, and only from rung 50 up', async () => {
  for (const seed of [SEEDS[0], SEEDS[SEEDS.length - 1]]) {
    const world = makeWorld(seed);
    let gradedRungs = 0;
    for (let n = FROM; n <= TO; n += 1) {
      const rung = makeRung(world, n);
      const where = `seed ${seed} rung ${n}`;
      if (rung.expectedProjectState === null) {
        assert.equal(rung.expectedLabel, null, `${where}: a label with no project state`);
        assert.equal(rung.expectedAudit ?? null, null, `${where}: an audit with no project state`);
        continue;
      }
      gradedRungs += 1;
      assert.ok(n >= GRADED_FROM, `${where}: graded below rung ${GRADED_FROM}`);
      assert.equal(rung.expectedProjectState, 'published', `${where}: graded short of published`);
      assert.notEqual(rung.expectedAudit ?? null, null, `${where}: published with no audit (Addendum Q rule 10)`);
      // Rule 29: the word is STATED in the text, in one of the tag clause's four phrasings.
      assert.ok(
        statesKind(rung.text, 'tag', { label: rung.expectedLabel })
          && rung.text.includes(`"${rung.expectedLabel}"`),
        `${where}: the graded word ${JSON.stringify(rung.expectedLabel)} is in no phrasing of the text`,
      );
    }
    assert.ok(gradedRungs > 0, `seed ${seed} grades no rung at all`);
  }
});

// ---------------------------------------------------------------------------
// The gate itself
// ---------------------------------------------------------------------------

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
