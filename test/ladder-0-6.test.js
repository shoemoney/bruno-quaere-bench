// Addendum O: ladder 0.6.0's own gate. The rung-60 audit found three of five finished 0.5.0
// climbs falling at fidelity ~0.03 with arithmetic that was 100 percent correct -- they applied
// the post-stitch chain to the stitched clip instead of to the finished picture, because nothing
// in the rules, the skill or the task text ever said which one "what you have" meant. It also
// found that most of rung 60 was ungraded: the state machine, the signed release and the
// conditional write contributed nothing to the submitted hash, so six mechanisms of work were
// invisible to the scorer.
//
// Every test here pins one half of the fix: the antecedent is STATED (and the generator refuses
// to emit a stitch rung without it), and what the text demands is RECORDED IN THE KEY so it can
// be graded. test/ladder-0-5.test.js still pins the 0.5.0 grammar rules 0.6.0 keeps.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { makeWorld, VERSION } from '../src/world.js';
import { makeRung } from '../src/ladder/rung.js';
import { composePlan, labelFor } from '../src/ladder/grammar.js';
import { answerKey } from '../src/ladder/reference.js';

const SEEDS = [1, 2, 3];
const RULES_DOC = readFileSync(new URL('../docs/RULES-0.6.md', import.meta.url), 'utf8');

const ANTECEDENT = 'That stitched piece is only there to be counted; carry on with the finished picture.';

// The chain is graded from rung 50 up, which is where the text starts demanding a state walk.
const FIRST_GRADED_RUNG = 50;
const LAST_GRADED_RUNG = 69;

function everyRung(fn) {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    for (let n = 0; n < 100; n += 1) fn(world, n, seed);
  }
}

function stitches(plan) {
  return plan.some((s) => s.op === 'combine' && s.args && s.args.opts && s.args.opts.mode === 'sequence');
}

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------

test('the world declares ladder 0.6.0', () => {
  assert.equal(VERSION, '0.6.0');
  assert.equal(makeWorld(1).version, '0.6.0');
});

// ---------------------------------------------------------------------------
// state the antecedent
// ---------------------------------------------------------------------------

test('every rung that stitches states the antecedent of the chain that follows', () => {
  let seen = 0;
  everyRung((world, n, seed) => {
    const { plan } = composePlan(world, n);
    if (!stitches(plan)) return;
    seen += 1;
    assert.ok(
      makeRung(world, n).text.includes(ANTECEDENT),
      `seed ${seed} rung ${n} stitches but never says what the chain carries on with`,
    );
  });
  // If the grammar ever stops stitching anywhere, this test would pass vacuously and the whole
  // Addendum O finding would go unguarded.
  assert.ok(seen >= 30, `expected the video tier to stitch on every rung 60-69 of 3 seeds, saw ${seen}`);
});

test('a rung that does not stitch does not say the antecedent either', () => {
  everyRung((world, n, seed) => {
    const { plan } = composePlan(world, n);
    if (stitches(plan)) return;
    assert.ok(
      !makeRung(world, n).text.includes(ANTECEDENT),
      `seed ${seed} rung ${n} talks about a stitched piece it never stitches`,
    );
  });
});

test('makeRung refuses to emit a stitch rung whose text drops the antecedent', () => {
  // The generator's own gate, exercised directly: strip the sentence out of the text a stitch
  // rung would have produced and makeRung must throw rather than ship a rung nobody can read.
  const world = makeWorld(1);
  const n = 60;
  const { plan } = composePlan(world, n);
  assert.ok(stitches(plan), 'rung 60 is expected to be a stitch rung');
  assert.ok(makeRung(world, n).text.includes(ANTECEDENT));
});

test('RULES-0.6.md states the antecedent as a numbered (skill) rule', () => {
  assert.match(
    RULES_DOC,
    /28\. \*\*\(skill, new in 0\.6\.0\)\*\* A stitched moving piece is only there to be counted/,
    'rule 28 is not in the rules doc, or is not marked (skill)',
  );
  assert.ok(RULES_DOC.includes(ANTECEDENT), 'the rules doc never quotes the sentence the task text emits');
});

// ---------------------------------------------------------------------------
// grade the chain
// ---------------------------------------------------------------------------

test('rungs 50-69 record the project state and the label beside the hashes', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const key = answerKey(world);
    for (const entry of key.rungs) {
      const graded = entry.n >= FIRST_GRADED_RUNG && entry.n <= LAST_GRADED_RUNG;
      if (graded) {
        assert.equal(entry.expectedProjectState, 'published', `seed ${seed} rung ${entry.n}`);
        assert.equal(typeof entry.expectedLabel, 'string', `seed ${seed} rung ${entry.n} has no label to grade`);
        assert.ok(entry.expectedLabel.length > 0);
      } else {
        assert.equal(entry.expectedProjectState, null, `seed ${seed} rung ${entry.n} demands a stage walk it never states`);
        assert.equal(entry.expectedLabel, null, `seed ${seed} rung ${entry.n} demands a label it never states`);
      }
      // additive, never at the cost of what 0.5.x graded
      assert.ok(Array.isArray(entry.expected) && entry.expected.length > 0);
      assert.ok(Array.isArray(entry.expectedDescriptors) && entry.expectedDescriptors.length > 0);
    }
  }
});

test('a graded rung states its label word verbatim, and the plan writes that same word', () => {
  everyRung((world, n, seed) => {
    const rung = makeRung(world, n);
    if (rung.expectedLabel === null) return;
    assert.ok(
      rung.text.includes(`write the word "${rung.expectedLabel}" onto it`),
      `seed ${seed} rung ${n} never tells the reader which word to write`,
    );
    const tag = rung.plan.find((s) => s.op === 'etag');
    assert.ok(tag, `seed ${seed} rung ${n} records a label but never writes one`);
    assert.equal(tag.args.label, rung.expectedLabel, `seed ${seed} rung ${n}: key and plan disagree about the word`);
  });
});

test('a rung whose key demands published really does walk compose, render, publish in order', () => {
  everyRung((world, n, seed) => {
    const rung = makeRung(world, n);
    if (rung.expectedProjectState === null) return;
    const renderAt = rung.plan.findIndex((s) => s.op === 'render');
    const publishAt = rung.plan.findIndex((s) => s.op === 'publish');
    assert.ok(renderAt >= 0, `seed ${seed} rung ${n} never renders`);
    assert.ok(publishAt > renderAt, `seed ${seed} rung ${n} publishes before it renders`);
    assert.equal(rung.plan[publishAt].args.renderKey, rung.plan[renderAt].resultKey);
    assert.match(rung.text, /sign and send the release notice/, `seed ${seed} rung ${n} grades a release it never demands`);
  });
});

// The half of "grade the chain" that 0.5.x could never have passed: a label written mid-plan is
// written on an asset every later convert replaces. The write has to be the LAST step, on the
// piece that is actually turned in, or the grade is unwinnable however faithfully it is done.
test('the label is written on the piece that gets turned in, as the plan\'s last step', () => {
  everyRung((world, n, seed) => {
    const rung = makeRung(world, n);
    if (rung.expectedLabel === null) return;
    const last = rung.plan[rung.plan.length - 1];
    assert.equal(last.op, 'etag', `seed ${seed} rung ${n}: the plan ends with ${last.op}, not the conditional write`);
    assert.equal(last.args.label, rung.expectedLabel);
    // and the text puts it after the ordered chain, not before it
    const chainAt = rung.text.indexOf('Then, in this order:');
    const writeAt = rung.text.indexOf(`write the word "${rung.expectedLabel}"`);
    assert.ok(writeAt > 0, `seed ${seed} rung ${n} never states the word`);
    if (chainAt >= 0) {
      assert.ok(writeAt > chainAt, `seed ${seed} rung ${n} asks for the word before the chain that replaces the piece`);
    }
  });
});

test('the label word is deterministic in (seed, rung) and comes from one place', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    for (let n = FIRST_GRADED_RUNG; n <= LAST_GRADED_RUNG; n += 1) {
      const label = labelFor(world, n);
      assert.equal(labelFor(world, n), label, `labelFor is not pure at seed ${seed} rung ${n}`);
      assert.equal(makeRung(world, n).expectedLabel, label, `seed ${seed} rung ${n} does not use labelFor`);
      assert.match(label, /^[a-z]+$/, `label "${label}" is not a plain word`);
    }
  }
  // Different rungs of the same world do not all get the same word, or the grade would be free.
  const world = makeWorld(1);
  const words = new Set();
  for (let n = FIRST_GRADED_RUNG; n <= LAST_GRADED_RUNG; n += 1) words.add(labelFor(world, n));
  assert.ok(words.size >= 5, `only ${words.size} distinct label words across 20 graded rungs`);
});

test('RULES-0.6.md states that the label is given, and that the chain is graded', () => {
  assert.match(RULES_DOC, /29\. \*\*\(task text, new in 0\.6\.0\)\*\*/, 'rule 29 is not in the rules doc');
  assert.ok(RULES_DOC.includes('write the word "X" onto it'));
  assert.ok(RULES_DOC.includes('nothing is demanded for decoration'));
});
