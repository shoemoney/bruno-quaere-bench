// Addendum J: ladder 0.5.0's own gate. 0.4.0 was cleared outright by one model that read the
// skill once, wrote a generic solver script and replayed it, because rungs 20-99 differed in
// their parameters and not in their kind. Every test here pins one of the nine generator rules
// that make a rung something a replayed template cannot answer -- and, just as importantly, pins
// that each of them stays DERIVABLE, since a rung nobody can solve from the documents is not
// difficulty, it is the Addendum I bug wearing a new hat.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { makeWorld, VERSION, RUNG_MUTATION_POOL, FIRST_MUTATION_RUNG } from '../src/world.js';
import { MUTATION_NAMES } from '../src/api/admin.js';
import { create, diff, combine } from '../src/media.js';
import { makeRung, saysOneOf, difficulty } from '../src/ladder/rung.js';
import { BANDS, bandFor, composePlan, runPlanLocallyTrace, submittedDescriptorFor } from '../src/ladder/grammar.js';

const SEEDS = [1, 2, 3];
const RULES_DOC = readFileSync(new URL('../docs/RULES-0.7.md', import.meta.url), 'utf8');

function everyRung(fn) {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    for (let n = 0; n < 100; n += 1) fn(world, n, seed);
  }
}

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------

test('the world declares ladder 0.7.0', () => {
  // Addendum M bumped 0.5.0 -> 0.5.1 (descriptor caps plus the percentOfDims grid-floor fix, not
  // a grammar change, so the running 0.5.0 round kept its own label). Addendum O then bumped
  // 0.5.1 -> 0.6.0: the stitch antecedent, the graded chain and the stated label are all
  // generator changes, so no 0.5.x row is comparable with a 0.6.x one. Every rule pinned in the
  // rest of this file is a 0.5.0 rule that 0.6.0 keeps; test/ladder-0-6.test.js pins the new ones.
  // Addendum Q then bumped 0.6.0 -> 0.7.0 (paraphrased clause surface, amendments, the mutation
  // density ramp, the listing bucket); test/ladder-0-7.test.js pins those.
  assert.equal(VERSION, '0.7.0');
  assert.equal(makeWorld(1).version, '0.7.0');
});

// ---------------------------------------------------------------------------
// rule 9: the band table, and difficulty(n) monotone
// ---------------------------------------------------------------------------

// Addendum J rule 9 states the step envelope per band directly. BANDS is the data; this is the
// assertion that the data says what the doc says.
const RULE_9_STEPS = [
  { from: 0, to: 9, steps: [1, 2] },
  { from: 10, to: 29, steps: [3, 5] },
  { from: 30, to: 49, steps: [6, 9] },
  // Addendum O widened the top of the 50-59 row by exactly one: tier 5 used to stop at
  // `rendered`, and now walks the release too, because from rung 50 up the key grades the project
  // having reached `published` in order. One graded step, one more step in the envelope. 60-69
  // already published and is unchanged.
  { from: 50, to: 59, steps: [10, 15] },
  { from: 60, to: 69, steps: [10, 14] },
  { from: 70, to: 89, steps: [15, 20] },
  { from: 90, to: 99, steps: [20, 30] },
];

function declaredStepsFor(n) {
  const row = RULE_9_STEPS.find((b) => n >= b.from && n <= b.to);
  assert.ok(row, `rule 9 declares no step band for rung ${n}`);
  return row.steps;
}

test('rule 9: BANDS declares exactly the step envelope Addendum J states', () => {
  for (const band of BANDS) {
    for (const n of [band.min, band.max]) {
      assert.deepEqual(band.steps, declaredStepsFor(n), `band ${band.tier} disagrees with rule 9 at rung ${n}`);
    }
  }
});

test('rule 9: every composed plan lands inside its band step envelope, seeds 1-3', () => {
  everyRung((world, n, seed) => {
    const { plan } = composePlan(world, n);
    const [lo, hi] = declaredStepsFor(n);
    assert.ok(
      plan.length >= lo && plan.length <= hi,
      `seed ${seed} rung ${n}: ${plan.length} steps, rule 9 wants ${lo}-${hi}`,
    );
  });
});

test('rule 9: difficulty(n) is monotone over 0..99 and strictly rises at every band edge', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    let prev = -Infinity;
    for (let n = 0; n < 100; n += 1) {
      const d = difficulty(makeRung(world, n));
      assert.ok(d >= prev, `seed ${seed}: difficulty dropped at rung ${n}`);
      prev = d;
    }
    for (let tier = 0; tier < 9; tier += 1) {
      const last = difficulty(makeRung(world, tier * 10 + 9));
      const next = difficulty(makeRung(world, (tier + 1) * 10));
      assert.ok(next > last, `seed ${seed}: difficulty did not rise from rung ${tier * 10 + 9} to ${(tier + 1) * 10}`);
    }
  }
});

// ---------------------------------------------------------------------------
// rule 1: cross-rung references, and the value is never repeated
// ---------------------------------------------------------------------------

function recallSteps(plan) {
  return plan.filter((s) => s.op === 'recall');
}

test('rule 1: no rung below 20 carries a cross-rung reference', () => {
  everyRung((world, n) => {
    if (n >= 20) return;
    assert.equal(recallSteps(composePlan(world, n).plan).length, 0, `rung ${n} recalls an earlier rung`);
  });
});

test('rule 1: a cross-rung reference always points strictly backwards, and 50+ points into 20-40', () => {
  everyRung((world, n, seed) => {
    for (const step of recallSteps(composePlan(world, n).plan)) {
      const m = step.args.fromRung;
      assert.ok(m < n, `seed ${seed} rung ${n} recalls rung ${m}, which is not earlier`);
      const [lo, hi] = n < 50 ? [10, 19] : [20, 40];
      assert.ok(m >= lo && m <= hi, `seed ${seed} rung ${n} recalls rung ${m}, outside ${lo}-${hi}`);
    }
  });
});

test('rule 1: the recalled value is never repeated in the task text', () => {
  let recalls = 0;
  everyRung((world, n, seed) => {
    const { plan, narrative } = composePlan(world, n);
    for (const step of recallSteps(plan)) {
      recalls += 1;
      const source = submittedDescriptorFor(world, step.args.fromRung);
      const text = makeRung(world, n).text;
      // the reference must be POINTED at in the text, by rung number
      // Addendum Q rule 1: the sentence that points at the earlier rung is one of four
      // phrasings, so the check is against the clause KIND, not against a fixed sentence. What
      // every phrasing of `piece` must do is name the step number, which is what makes the
      // reference resolvable at all.
      assert.ok(saysOneOf(text, 'piece', { m: step.args.fromRung }),
        `seed ${seed} rung ${n} recalls rung ${step.args.fromRung} but never names it`);
      if (step.args.field === 'ground') {
        assert.ok(!text.includes(source.background.color),
          `seed ${seed} rung ${n} states the recalled ground colour ${source.background.color} outright`);
      } else {
        // the borrowed size must not be printed as the canvas size ("N by M ...")
        assert.ok(!text.includes(`${source.width} by ${source.height}`),
          `seed ${seed} rung ${n} states the recalled size ${source.width} by ${source.height} outright`);
      }
      assert.ok(narrative.crossRef, `seed ${seed} rung ${n} has a recall step but no crossRef narrative`);
    }
  });
  assert.ok(recalls > 50, `expected cross-rung references to be common above rung 20, saw ${recalls}`);
});

test('rule 1: a recalled value resolves to exactly what that rung submits', () => {
  const world = makeWorld(1);
  for (let n = 20; n < 100; n += 1) {
    for (const step of recallSteps(composePlan(world, n).plan)) {
      const submitted = makeRung(world, step.args.fromRung).expectedDescriptors[0];
      const memo = submittedDescriptorFor(world, step.args.fromRung);
      assert.deepEqual(memo, submitted, `rung ${n}'s memo of rung ${step.args.fromRung} is not what that rung submits`);
    }
  }
});

// ---------------------------------------------------------------------------
// rule 2: derived parameters
// ---------------------------------------------------------------------------

function derivedChainSteps(narrative) {
  const chain = narrative.chain ?? [];
  return chain.filter((s) => s.kind === 'derivedShrink' || s.kind === 'derivedGrow');
}

test('rule 2: every rung from 30 up carries at least one parameter the API has to be asked for', () => {
  everyRung((world, n, seed) => {
    if (n < 30) return;
    const { narrative, plan } = composePlan(world, n);
    const derived = derivedChainSteps(narrative);
    assert.ok(derived.length >= 1, `seed ${seed} rung ${n} states every parameter outright`);
    // and the plan really does go and compute it rather than carrying a constant
    const computes = plan.filter((s) => s.op === 'compute' && s.args.fn === 'percentFromCount');
    assert.equal(computes.length, derived.length, `seed ${seed} rung ${n}: derived steps and percentFromCount steps disagree`);
  });
});

// The plain-language phrase each derived source reads as. Mirrors grammar/rung's own table; the
// recipe clause is checked through saysOneOf, so only the noun phrase has to be supplied here.
const DERIVED_SOURCE_PHRASE_FOR_TEST = {
  d: 'shape left on that leftover piece',
  combined: 'shape on the stack you just built',
  sd: 'tone left over when you took the second sound out of the first',
  vseq: 'frame in the stitched clip',
  live: 'copy of yours still standing in that listing once the cleared-out ones are left out',
};

test('rule 2: the derived percent is never printed in the task text, only its recipe', () => {
  everyRung((world, n, seed) => {
    if (n < 30) return;
    const { narrative } = composePlan(world, n);
    const text = makeRung(world, n).text;
    for (const step of derivedChainSteps(narrative)) {
      assert.ok(
        saysOneOf(text, 'recipe', {
          base: step.base,
          off: Math.abs(step.perUnit),
          phrase: DERIVED_SOURCE_PHRASE_FOR_TEST[step.sourceKey],
        }),
        `seed ${seed} rung ${n} never states the derived recipe`,
      );
      assert.equal(step.base - Math.abs(step.perUnit) * step.count, step.percent,
        `seed ${seed} rung ${n}: the printed recipe does not reproduce the key's percent`);
    }
  });
});

test('rule 2: every derived source the generator uses is documented in RULES-0.7.md', () => {
  const seen = new Set();
  everyRung((world, n) => {
    for (const step of derivedChainSteps(composePlan(world, n).narrative)) seen.add(step.sourceKey);
  });
  assert.ok(seen.size >= 4, `expected several derived sources across the ladder, saw ${[...seen].join(', ')}`);
  const documented = {
    d: 'shape left on that leftover piece',
    combined: 'shape on the stack you just built',
    sd: 'tone left over when you took the second sound out of the first',
    vseq: 'frame in the stitched clip',
    live: 'copy of yours still standing in that listing',
  };
  for (const key of seen) {
    assert.ok(documented[key] !== undefined, `derived source "${key}" has no documented phrase`);
    assert.ok(RULES_DOC.includes(documented[key]), `RULES-0.7.md does not document the derived source "${key}"`);
  }
});

// ---------------------------------------------------------------------------
// rule 3: announced per-rung mutations
// ---------------------------------------------------------------------------

test('rule 3: rungMutations is indexed by rung, empty below 40, and drawn from a safe pool', () => {
  for (let seed = 1; seed <= 12; seed += 1) {
    const world = makeWorld(seed);
    assert.equal(world.rungMutations.length, 100);
    for (let n = 0; n < 100; n += 1) {
      const entry = world.rungMutations[n];
      if (n < FIRST_MUTATION_RUNG) {
        assert.equal(entry, null, `seed ${seed} rung ${n} announces a mutation below rung ${FIRST_MUTATION_RUNG}`);
        continue;
      }
      if (entry === null) continue;
      assert.equal(entry.n, n, 'rungMutations entries must be self-describing and indexed by n');
      assert.ok(RUNG_MUTATION_POOL.includes(entry.mutation), `unknown mutation ${entry.mutation}`);
    }
  }
});

test('rule 3: the pool is a strict subset of the Arena list, excluding the two that make a rung unpassable', () => {
  for (const name of RUNG_MUTATION_POOL) assert.ok(MUTATION_NAMES.includes(name), `${name} is not an Arena mutation`);
  assert.ok(!RUNG_MUTATION_POOL.includes('rejectAuth'), 'rejectAuth makes a route answer 401 for a whole rung');
  assert.ok(!RUNG_MUTATION_POOL.includes('stuckCursor'), 'stuckCursor makes a listing never advance');
});

test('rule 3: a rung with an announced mutation says so in its text, and one without does not', () => {
  let announced = 0;
  everyRung((world, n, seed) => {
    const rung = makeRung(world, n);
    const warned = saysOneOf(rung.text, 'mutation');
    const expected = world.rungMutations[n] !== null;
    assert.equal(warned, expected, `seed ${seed} rung ${n}: warning ${warned}, mutation ${expected}`);
    assert.deepEqual(rung.mutation, world.rungMutations[n]);
    if (expected) announced += 1;
  });
  assert.ok(announced > 50, `expected announced mutations to be common from rung 40 up, saw ${announced}`);
});

// ---------------------------------------------------------------------------
// rule 4: state machine, HMAC publish and ETag chains at 50+
// ---------------------------------------------------------------------------

test('rule 4: every rung 50-69 walks the state machine, recovers a 409 and does a conditional write', () => {
  everyRung((world, n, seed) => {
    if (n < 50 || n > 69) return;
    const { plan } = composePlan(world, n);
    const render = plan.find((s) => s.op === 'render');
    assert.ok(render, `seed ${seed} rung ${n} never goes through the finishing run`);
    assert.equal(render.args.recover409, true, `seed ${seed} rung ${n} never provokes a 409`);
    assert.ok(plan.some((s) => s.op === 'etag'), `seed ${seed} rung ${n} has no conditional write`);
  });
});

test('rule 4: every rung 60-69 signs a release', () => {
  everyRung((world, n, seed) => {
    if (n < 60 || n > 69) return;
    const { plan } = composePlan(world, n);
    assert.ok(plan.some((s) => s.op === 'publish'), `seed ${seed} rung ${n} never signs a release`);
  });
});

// ---------------------------------------------------------------------------
// rules 5 and 8: audio and video math, and the two primitives new this season
// ---------------------------------------------------------------------------

// The primitive itself, before any rung uses it. media.js already differenced sounds and stitched
// clips; 0.5.0 is the first season that puts either on the ladder, so this is the unit-level pin
// for the two operations rule 8 names -- a regression here would show up as a whole band failing
// the reference gate with nothing to point at.
test('rule 8 primitive: a difference over two sounds leaves the tones A has and B does not', () => {
  const world = makeWorld(1);
  const tone = (freq, startMs) => ({ freq, startMs, durMs: 100, amp: 1, wave: 'sine' });
  const a = create(world, 'audio', { durationMs: 500, sampleRate: 44100, notes: [tone(440, 0), tone(220, 100), tone(660, 200)] });
  const b = create(world, 'audio', { durationMs: 500, sampleRate: 44100, notes: [tone(220, 100)] });
  const left = diff(world, a, b);
  assert.equal(left.kind, 'audio');
  assert.deepEqual(left.notes.map((n) => n.freq), [440, 660]);
  // the leftover keeps A's length and sample rate, which is what rule 14/15 of RULES-0.7.md says
  assert.equal(left.durationMs, a.durationMs);
  assert.equal(left.sampleRate, a.sampleRate);
  assert.equal(diff(world, a, a).notes.length, 0);
});

test('rule 8 primitive: stitching clips end to end sums the lengths and shifts the second', () => {
  const world = makeWorld(1);
  const clip = (durMs) => ({ width: 320, height: 240, durationMs: durMs, clips: [{ assetId: 'x', startMs: 0, durMs, z: 0 }] });
  const a = create(world, 'video', clip(300));
  const b = create(world, 'video', clip(200));
  const stitched = combine(world, [a, b], { mode: 'sequence' });
  assert.equal(stitched.durationMs, 500);
  assert.deepEqual(stitched.clips.map((c) => c.startMs), [0, 300]);
  assert.equal(stitched.fps, world.rules.defaultFps);
});

test('rule 8: every rung 50-59 takes a difference over two SOUNDS', () => {
  everyRung((world, n, seed) => {
    if (n < 50 || n > 59) return;
    const { plan } = composePlan(world, n);
    const trace = runPlanLocallyTrace(world, plan);
    const diffIndex = plan.findIndex((s) => s.op === 'diff');
    assert.ok(diffIndex >= 0, `seed ${seed} rung ${n} has no difference step`);
    assert.equal(trace[diffIndex].kind, 'audio', `seed ${seed} rung ${n}'s difference is not over sounds`);
    assert.ok(trace[diffIndex].notes.length >= 1, `seed ${seed} rung ${n}'s sound difference came out empty`);
  });
});

test('rule 8: every rung 60-69 stitches clips end to end with sequence', () => {
  everyRung((world, n, seed) => {
    if (n < 60 || n > 69) return;
    const { plan } = composePlan(world, n);
    const trace = runPlanLocallyTrace(world, plan);
    const seqIndex = plan.findIndex((s) => s.op === 'combine' && s.args.opts && s.args.opts.mode === 'sequence');
    assert.ok(seqIndex >= 0, `seed ${seed} rung ${n} never stitches clips`);
    const stitched = trace[seqIndex];
    assert.equal(stitched.kind, 'video');
    const inputs = plan[seqIndex].args.from.map((k) => trace[plan.findIndex((s) => s.resultKey === k)]);
    assert.equal(stitched.durationMs, inputs.reduce((sum, v) => sum + v.durationMs, 0),
      `seed ${seed} rung ${n}: a stitched clip's length is the sum of its parts`);
  });
});

test('rule 5: the video frame rate is never stated, so it can only come from the house default', () => {
  everyRung((world, n, seed) => {
    if (n < 60 || n > 69) return;
    const { plan } = composePlan(world, n);
    for (const step of plan) {
      if (step.op !== 'create' || step.args.kind !== 'video') continue;
      assert.equal(step.args.params.fps, undefined, `seed ${seed} rung ${n} states the frame rate outright`);
    }
    const trace = runPlanLocallyTrace(world, plan);
    const vIndex = plan.findIndex((s) => s.op === 'create' && s.args.kind === 'video');
    assert.equal(trace[vIndex].fps, world.rules.defaultFps);
  });
});

// ---------------------------------------------------------------------------
// rule 6: multi-rule ordering at 70+
// ---------------------------------------------------------------------------

// A chain where the order matters: at least three ordered obligations, of at least two kinds, and
// with a style lookup adjacent to a resize -- which is exactly the pair that does not commute,
// since a scaling style re-rounds on the house grid and a resize grid-rounds its own target.
test('rule 6: every rung from 70 up applies three or more ordered house rules, with a style next to a resize', () => {
  everyRung((world, n, seed) => {
    if (n < 70) return;
    const chain = composePlan(world, n).narrative.chain;
    assert.ok(chain.length >= 3, `seed ${seed} rung ${n}: only ${chain.length} ordered steps`);
    const kinds = new Set(chain.map((s) => s.kind));
    assert.ok(kinds.size >= 3, `seed ${seed} rung ${n}: only ${kinds.size} kinds of rule in play`);
    const resizes = new Set(['shrink', 'grow', 'derivedShrink', 'derivedGrow', 'resize']);
    const adjacent = chain.some((s, i) =>
      i + 1 < chain.length
      && ((s.kind === 'lora' && resizes.has(chain[i + 1].kind)) || (resizes.has(s.kind) && chain[i + 1].kind === 'lora')));
    assert.ok(adjacent, `seed ${seed} rung ${n}: no style sits next to a resize, so nothing turns on the order`);
    assert.ok(saysOneOf(makeRung(world, n).text, 'order'),
      `seed ${seed} rung ${n} never tells the reader the order decides the answer`);
  });
});

// ---------------------------------------------------------------------------
// the documents gate: nothing in a key may turn on a rule that is not written down
// ---------------------------------------------------------------------------

test('RULES-0.7.md documents every rule the 0.5.0 generator newly relies on', () => {
  const required = [
    'snapped to six decimal places',
    'rounded onto the house grid',
    'after every single step',
    'house default frame rate',
    'Stitching moving clips end to end',
    'length in seconds times its frame rate',
    'start at B and take P off for every X',
    'as wide and as tall as the piece you turned in at step M',
    'the same ground colour as the piece you turned in at step M',
    'has changed something about the way it answers',
    'never alters what the finished artifact should be',
    'keyed hash over the house',
  ];
  for (const phrase of required) {
    assert.ok(RULES_DOC.includes(phrase), `RULES-0.7.md is missing the rule: "${phrase}"`);
  }
});

// ---------------------------------------------------------------------------
// geometry floor still holds at the new chain lengths (Addendum D, re-checked)
// ---------------------------------------------------------------------------

function assertShapeFloor(value, ctx) {
  if (!value || value.kind !== 'image') return;
  for (const s of value.shapes) {
    if (s.type === 'rect') {
      assert.ok(s.w >= 8 && s.h >= 8, `${ctx}: rect ${s.w}x${s.h} under 8px`);
    } else if (s.type === 'circle') {
      assert.ok(s.r * 2 >= 8, `${ctx}: circle diameter ${s.r * 2} under 8px`);
    } else if (s.type === 'line') {
      assert.ok(Math.abs(s.x2 - s.x) >= 8 && Math.abs(s.y2 - s.y) >= 8, `${ctx}: line under 8px on an axis`);
    }
  }
}

test('Addendum D still holds at 0.5.0 chain lengths: no shape drops under 8px at any step', () => {
  everyRung((world, n, seed) => {
    const { plan } = composePlan(world, n);
    runPlanLocallyTrace(world, plan).forEach((value, i) => {
      const ctx = `seed ${seed} rung ${n} step ${i} (${plan[i].op}:${plan[i].resultKey})`;
      if (Array.isArray(value)) value.forEach((v) => assertShapeFloor(v, ctx));
      else assertShapeFloor(value, ctx);
    });
  });
});

test('bandFor covers every rung 0..99', () => {
  for (let n = 0; n < 100; n += 1) assert.ok(bandFor(n));
});
