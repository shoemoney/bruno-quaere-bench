// Addendum G: the answer key must never depend on float error. Seed 220 rung 0 found
// 0.56in x 300dpi = 168.00000000000003 in IEEE-754 -- close enough to 168 that
// roundToGrid(step=2, mode='up') ceil'd the /2 quotient up a whole extra grid step (170) instead
// of the exact 168, making that rung unpassable by a correct agent. media.js now snaps every
// unit-to-pixel product to 6 decimals before any rounding rule runs (see media.js's snap6), and
// grammar.js's generator refuses to hand out a dimension whose exact product sits within 1e-6 of
// a grid boundary in the first place (see grammar.js's nearGridBoundary). This file is the gate
// for both: it recomputes every unit-tagged create/render dimension across seeds 1-50 and all 100
// rungs using BigInt (exact rational, never a float multiply-by-a-decimal) and asserts the
// created descriptor agrees exactly, plus pins the specific 0.56in/300dpi/roundTo=2/up regression.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeWorld } from '../src/world.js';
import { create } from '../src/media.js';
import { composePlan, runPlanLocallyTrace } from '../src/ladder/grammar.js';

// ---------------------------------------------------------------------------
// exact (BigInt) reimplementation of media.js's unit -> px -> grid pipeline
//
// A unit-tagged width/height in this generator always carries at most 2 decimal digits (every
// composer draws it through grammar.js's unitValueForPx, which rounds via toFixed(2)), so it can
// be represented exactly as an integer number of "cents" of the house unit. From there every step
// -- the unit conversion and the grid rounding -- is a ratio of two integers, computed here with
// BigInt so no step ever passes through a float multiply/divide that could lose precision the way
// `0.56 * 300` does. inches: cents * dpi / 100. cm: cents * dpi / (100 * 2.54) = cents*dpi/254.
// pt: cents * dpi / (100 * 72) = cents*dpi/7200.
// ---------------------------------------------------------------------------

const UNIT_DENOMINATOR = { in: 100n, cm: 254n, pt: 7200n };

function ceilDivBig(a, b) {
  return (a + b - 1n) / b;
}

function floorDivBig(a, b) {
  return a / b;
}

// Math.round rounds a positive x.5 up (towards +Infinity); reproduce that exactly in integers:
// round(a/b) == floor(a/b + 1/2) == floor((2a + b) / (2b)).
function roundHalfUpDivBig(a, b) {
  return (2n * a + b) / (2n * b);
}

// exactGriddedPx(value, unit, dpi, roundTo, roundMode) -> the integer px media.js's
// create()/resolveDim() should produce for this unit-tagged dimension, computed without ever
// forming the intermediate float `value * dpi`.
function exactGriddedPx(value, unit, dpi, roundTo, roundMode) {
  const cents = Math.round(value * 100); // value always has <= 2 decimal digits by construction
  const den = UNIT_DENOMINATOR[unit];
  const num = BigInt(cents) * BigInt(dpi); // exact: two small integers, well under 2^53
  const stepDen = den * BigInt(roundTo);
  const divide = roundMode === 'up' ? ceilDivBig : roundMode === 'down' ? floorDivBig : roundHalfUpDivBig;
  const q = divide(num, stepDen);
  return Number(q * BigInt(roundTo));
}

// ---------------------------------------------------------------------------
// seeds 1..50, every rung: every create/render step whose params carry a unit gets its width and
// height independently recomputed and checked against the descriptor the generator actually
// produced. composePlan + runPlanLocallyTrace (rather than makeRung) is the exact same pipeline
// makeRung's expectedDescriptors (the answer key) comes from, run once per rung instead of twice.
// ---------------------------------------------------------------------------

const SEEDS = Array.from({ length: 50 }, (_, i) => i + 1);

test('every unit-tagged create/render dimension matches exact integer arithmetic, seeds 1-50, rungs 0-99', () => {
  let checked = 0;
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const { dpi, roundTo, roundMode } = world.rules;
    for (let n = 0; n < 100; n += 1) {
      const { plan } = composePlan(world, n);
      const trace = runPlanLocallyTrace(world, plan);
      plan.forEach((step, i) => {
        if (step.op !== 'create' && step.op !== 'render') return;
        const { params } = step.args;
        if (params.unit === undefined) return;
        const desc = trace[i];
        const expectedWidth = exactGriddedPx(params.width, params.unit, dpi, roundTo, roundMode);
        const expectedHeight = exactGriddedPx(params.height, params.unit, dpi, roundTo, roundMode);
        assert.equal(
          desc.width, expectedWidth,
          `seed ${seed} rung ${n} step ${i}: width ${params.width}${params.unit} @ ${dpi}dpi grid ${roundTo}/${roundMode} -> got ${desc.width}, want ${expectedWidth}`,
        );
        assert.equal(
          desc.height, expectedHeight,
          `seed ${seed} rung ${n} step ${i}: height ${params.height}${params.unit} @ ${dpi}dpi grid ${roundTo}/${roundMode} -> got ${desc.height}, want ${expectedHeight}`,
        );
        checked += 1;
      });
    }
  }
  // Sanity: this generator does draw unit-tagged canvases somewhere in 50 seeds x 100 rungs, so a
  // future refactor that stops emitting `unit` entirely (silently vacuous-passing this test)
  // would be caught here.
  assert.ok(checked > 100, `expected many unit-tagged dimensions to be checked, only saw ${checked}`);
});

// ---------------------------------------------------------------------------
// the exact seed-220-rung-0 regression, pinned directly against media.js's create()
// ---------------------------------------------------------------------------

function minimalWorld(rules) {
  return {
    seed: 0,
    version: '0.3.0',
    vocab: { workspace: 'studio', project: 'scene', asset: 'clip', library: 'library' },
    ids: { style: 'prefixed', prefixes: { workspace: 'ws', project: 'pr', asset: 'as', job: 'jb', lora: 'lo' } },
    naming: 'snake',
    namingExceptions: [],
    rules: {
      unitWords: { inch: ['in'], cm: ['cm'], pt: ['pt'] },
      opacityCompound: 'multiplicative',
      defaultFormat: { image: 'svg', audio: 'wav', video: 'qvid' },
      defaultSampleRate: 44100,
      defaultFps: 24,
      zOrder: 'listOrder',
      colorShiftSpace: 'hsl',
      bitrateBudgetUnit: 'MB',
      ...rules,
    },
    auth: { apiKey: 'k', secret: 's', tokenTtlSec: 300, refreshPath: '/auth/refresh' },
    rate: { limit: 30, windowSec: 10 },
    pagination: { pageSize: 10, cursorStyle: 'b64json' },
    traps: { live: [] },
    deprecated: {},
    loras: [],
    hmac: { header: 'X-Signature', tsHeader: 'X-Timestamp', algo: 'sha256', canon: 'ts+method+path' },
  };
}

test('regression: 0.56 in at 300 dpi, roundTo 2, up -> 168 (not 170)', () => {
  // Before the snap6 fix, 0.56 * 300 === 168.00000000000003 in IEEE-754, and
  // Math.ceil(168.00000000000003 / 2) === 85 -> 170, one whole grid step past the exact answer.
  assert.equal(0.56 * 300, 168.00000000000003, 'the float hazard this regression guards against is no longer reproducible on this platform -- re-check the assertion below still exercises the fix');

  const world = minimalWorld({ dpi: 300, roundTo: 2, roundMode: 'up' });
  const desc = create(world, 'image', {
    width: 0.56,
    height: 0.56,
    unit: 'in',
    background: { color: '#ff0000' },
    shapes: [],
  });
  assert.equal(desc.width, 168);
  assert.equal(desc.height, 168);
});
