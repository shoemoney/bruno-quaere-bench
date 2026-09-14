#!/usr/bin/env node
// Addendum T (0.8.0): regenerates the measured `steps`/`lookups`/`quant` columns of
// `src/ladder/grammar.js`'s BANDS table. Referenced by that table's own comment so the numbers in
// the table are reproducible rather than hand-typed guesses.
//
// For every seed in SEEDS and every rung 0-99, composes the plan the way the ladder actually would
// (`composePlan`) and counts:
//
//   steps    plan.length -- the same thing test/ladder-0-5.test.js's rule-9 envelope test checks a
//            composed plan against, so this number must bound reality or that gate fails.
//   lookups  one per house-style ('lora') chain step, plus one each for a drawn workspace label, a
//            drawn project label, and a live-trap dependence -- "things the rung makes the agent go
//            and find" per the table's own header comment.
//   quant    one per unit-tagged canvas this rung draws (a unit-to-pixel conversion, which
//            re-rounds on the house grid) plus one per chain step that resizes
//            (resize/shrink/grow/derivedShrink/derivedGrow), each of which also re-rounds.
//
// Run: node scripts/band-envelope.js
import { makeWorld } from '../src/world.js';
import { BANDS, composePlan } from '../src/ladder/grammar.js';

const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
const RESIZE_KINDS = new Set(['resize', 'shrink', 'grow', 'derivedShrink', 'derivedGrow']);

function countLookups(narrative) {
  let n = 0;
  for (const step of narrative.chain || []) if (step.kind === 'lora') n += 1;
  if (narrative.workspaceLabel) n += 1;
  if (narrative.projectLabel) n += 1;
  if (narrative.liveTrap) n += 1;
  return n;
}

function countQuant(narrative) {
  let n = 0;
  for (const key of ['params', 'paramsA', 'paramsB']) {
    if (narrative[key] && narrative[key].unit !== undefined) n += 1;
  }
  for (const step of narrative.chain || []) if (RESIZE_KINDS.has(step.kind)) n += 1;
  return n;
}

function emptyEnvelope(band) {
  return {
    min: band.min,
    max: band.max,
    tier: band.tier,
    steps: [Infinity, -Infinity],
    lookups: [Infinity, -Infinity],
    quant: [Infinity, -Infinity],
  };
}

function widen(range, value) {
  if (value < range[0]) range[0] = value;
  if (value > range[1]) range[1] = value;
}

const envelopes = BANDS.map(emptyEnvelope);

for (const seed of SEEDS) {
  const world = makeWorld(seed);
  for (let n = 0; n < 100; n += 1) {
    const { plan, narrative } = composePlan(world, n);
    const e = envelopes[Math.floor(n / 10)];
    widen(e.steps, plan.length);
    widen(e.lookups, countLookups(narrative));
    widen(e.quant, countQuant(narrative));
  }
}

for (let i = 0; i < envelopes.length; i += 1) {
  const e = envelopes[i];
  console.log(
    `index ${i} (${e.min}-${e.max}, tier ${e.tier}): steps=[${e.steps[0]}, ${e.steps[1]}] `
    + `lookups=[${e.lookups[0]}, ${e.lookups[1]}] quant=[${e.quant[0]}, ${e.quant[1]}]`,
  );
}
