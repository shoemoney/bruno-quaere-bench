// Addendum I: a percent resize step's answer-key target must be `roundToGrid(snap6(raw),
// roundTo, roundMode)` -- the SAME function every other convert target in media.js uses -- never
// a hidden `Math.round(raw)`. The old hidden Math.round decided ~28% of all percent-step rungs
// (measured over seeds 300-330) on a rule stated nowhere in the docs, and the rung text's own
// ROUND_NOTE ("the house rounds every size to its usual grid; do that after every resize") only
// reads true once the compute step itself grid-rounds. This file pins that fix directly (rule 1)
// and gates the generator so no rung ever hinges on the ambiguity again (rule 2).

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeWorld } from '../src/world.js';
import { snap6, roundToGrid } from '../src/media.js';
import { runCompute, composePlan, runPlanLocallyTrace, resolveRefs } from '../src/ladder/grammar.js';

// ---------------------------------------------------------------------------
// rule 1: three real seed/rung scenarios, pinned against runCompute directly.
//
// Each (of, percent) pair below is exactly what that rung's plan drew for its percentOfDims step
// before the Addendum I guard existed (verified against the pre-guard generator): a canvas whose
// house-grid width/height, once shrunk by the stated percent, lands close enough to a grid line
// that "round the raw value to a pixel first, then grid-round that integer" (what the rung text's
// own note literally describes, and what the old hidden Math.round effectively did once convert()
// re-gridded it) and "grid-round the raw value directly" (the documented, now-implemented rule)
// disagree. The old key silently used the first path; the fix uses the second.
// ---------------------------------------------------------------------------

test('regression: seed 310 rung 17, 208 x 81% -> 176 under roundTo 8 up (not 168)', () => {
  const world = makeWorld(310);
  assert.deepEqual(world.rules && { roundTo: world.rules.roundTo, roundMode: world.rules.roundMode }, { roundTo: 8, roundMode: 'up' });
  // sanity: this is the exact boundary the old rule got wrong -- round-then-grid and grid-direct
  // disagree for this input, which is what makes it a regression worth pinning.
  const raw = snap6(208 * 0.81);
  assert.equal(roundToGrid(Math.round(raw), 8, 'up'), 168, 'the round-then-grid reading (old bug) should give 168');
  assert.equal(roundToGrid(raw, 8, 'up'), 176, 'the grid-direct reading (documented rule) should give 176');

  const result = runCompute(world, 'percentOfDims', { of: { width: 208, height: 208 }, percent: 81 });
  assert.deepEqual(result, { width: 176, height: 176 });
});

test('regression: seed 311 rung 25, 248x232 at 66% -> 160x152 under roundTo 4 down (not 164x152)', () => {
  const world = makeWorld(311);
  assert.deepEqual({ roundTo: world.rules.roundTo, roundMode: world.rules.roundMode }, { roundTo: 4, roundMode: 'down' });

  const result = runCompute(world, 'percentOfDims', { of: { width: 248, height: 232 }, percent: 66 });
  assert.deepEqual(result, { width: 160, height: 152 });
});

test('regression: seed 316 rung 16, 180x152 at 58% -> 108x92 under roundTo 4 up (not 104x88)', () => {
  const world = makeWorld(316);
  assert.deepEqual({ roundTo: world.rules.roundTo, roundMode: world.rules.roundMode }, { roundTo: 4, roundMode: 'up' });

  const result = runCompute(world, 'percentOfDims', { of: { width: 180, height: 152 }, percent: 58 });
  assert.deepEqual(result, { width: 108, height: 92 });
});

// ---------------------------------------------------------------------------
// rule 1, generally: runCompute always agrees with roundToGrid(snap6(raw), roundTo, roundMode),
// never with a bare Math.round, across a spread of worlds and inputs.
// ---------------------------------------------------------------------------

test('runCompute percentOfDims always matches roundToGrid(snap6(raw), roundTo, roundMode)', () => {
  // Rebaselined by Addendum M: the floor is now `roundTo` (one whole grid step), not bare `1` --
  // a bare-1 floor is not itself grid-aligned whenever roundTo > 1, so the next grid-rounding
  // pass (what a live resize target goes through next) rounded it straight back down to 0, which
  // is what OOM'd seed 525's answer key. See docs/RULES-0.6.md rule 5 and grammar.js's
  // runCompute for the full mechanism.
  const cases = [
    { of: { width: 100, height: 50 }, percent: 33 },
    { of: { width: 999, height: 1 }, percent: 150 },
    { of: { width: 17, height: 17 }, percent: 50 },
  ];
  for (const seed of [1, 5, 42, 310, 311, 316]) {
    const world = makeWorld(seed);
    const { roundTo, roundMode } = world.rules;
    for (const c of cases) {
      const expected = {
        width: Math.max(roundTo, roundToGrid(snap6(c.of.width * (c.percent / 100)), roundTo, roundMode)),
        height: Math.max(roundTo, roundToGrid(snap6(c.of.height * (c.percent / 100)), roundTo, roundMode)),
      };
      assert.deepEqual(runCompute(world, 'percentOfDims', c), expected, `seed ${seed} ${JSON.stringify(c)}`);
    }
  }
});

// ---------------------------------------------------------------------------
// rule 2: the generator guard. Walk every rung's ACTUAL composed plan (post-guard) and recompute,
// independently of grammar.js's own planHasAmbiguousPercent, whether any percentOfDims step it
// contains is ambiguous. None should ever be -- that is exactly what the redraw exists to prevent.
// ---------------------------------------------------------------------------

function findAmbiguousPercentSteps(world, plan, trace) {
  const { roundTo, roundMode } = world.rules;
  const env = new Map();
  const hits = [];
  plan.forEach((step, i) => {
    if (step.op === 'compute') {
      const args = resolveRefs(step.args, env);
      if (args.fn === 'percentOfDims') {
        for (const dim of ['width', 'height']) {
          const raw = snap6(args.of[dim] * (args.percent / 100));
          const viaRoundFirst = roundToGrid(Math.round(raw), roundTo, roundMode);
          const viaGridDirect = roundToGrid(raw, roundTo, roundMode);
          if (viaRoundFirst !== viaGridDirect) {
            hits.push({ step: i, dim, of: args.of[dim], percent: args.percent, viaRoundFirst, viaGridDirect });
          }
        }
      }
    }
    env.set(step.resultKey, trace[i]);
  });
  return hits;
}

test('guard: no rung 0-99, seeds 1-50, ever composes an ambiguous percent step', () => {
  let percentStepsChecked = 0;
  for (let seed = 1; seed <= 50; seed += 1) {
    const world = makeWorld(seed);
    for (let n = 0; n < 100; n += 1) {
      const { plan } = composePlan(world, n);
      const trace = runPlanLocallyTrace(world, plan);
      const hits = findAmbiguousPercentSteps(world, plan, trace);
      assert.equal(hits.length, 0, `seed ${seed} rung ${n} composed an ambiguous percent step: ${JSON.stringify(hits)}`);
      percentStepsChecked += plan.filter((s) => s.op === 'compute' && s.args.fn === 'percentOfDims').length;
    }
  }
  // Sanity: percent steps really are exercised across 50 seeds x 100 rungs, so a future refactor
  // that stops emitting percent chains entirely (silently vacuous-passing this test) is caught.
  assert.ok(percentStepsChecked > 100, `expected many percent steps to be checked, only saw ${percentStepsChecked}`);
});

// The three regressions above are real seeds/rungs that WOULD have been ambiguous pre-guard
// (verified against the pre-guard generator) -- confirm the guard actually redraws them away
// rather than the fix happening to dodge them by coincidence.
test('guard: seeds 310/311/316 no longer compose the exact ambiguous draw pinned above', () => {
  const ambiguousDraws = [
    { seed: 310, n: 17, of: 208, percent: 81 },
    { seed: 311, n: 25, of: 248, percent: 66 },
    { seed: 316, n: 16, of: 180, percent: 58 },
  ];
  for (const { seed, n, of, percent } of ambiguousDraws) {
    const world = makeWorld(seed);
    const { plan } = composePlan(world, n);
    const trace = runPlanLocallyTrace(world, plan);
    const env = new Map();
    plan.forEach((step, i) => {
      if (step.op === 'compute' && step.args.fn === 'percentOfDims') {
        const args = resolveRefs(step.args, env);
        const isTheOldAmbiguousDraw = args.of.width === of && args.percent === percent;
        assert.ok(!isTheOldAmbiguousDraw, `seed ${seed} rung ${n} still composes the pre-guard ambiguous draw (of=${of}, percent=${percent})`);
      }
      env.set(step.resultKey, trace[i]);
    });
  }
});
