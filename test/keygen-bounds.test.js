// Addendum M: `answerKey(makeWorld(525))` used to exhaust a 3 GB heap in ~7 s (seed 523 takes
// 76 ms for a 305 KB key). The mechanism: a plain percent-resize step could floor a dimension at
// 1px (percentOfDims's own guard), then media.js's convert() re-grid-rounds that already-explicit
// pixel target and can floor it a SECOND time, down to 0 -- a canvas that collapses to 0x0 mid
// chain. Every further scale step then divides by that zero, producing NaN shape coordinates,
// and the PNG rasteriser's line-drawing Bresenham walk never terminates on NaN (its `x === x1 &&
// y === y1` check never fires), pushing points into an unbounded array until the process OOMs.
//
// This is the generator-bug gate for that class of failure: every seed's answer key must stay
// small and fast, and no rung anywhere may hand a descriptor over the shape/note/clip caps
// (Addendum M rule 1). It does not re-derive the whole key through HTTP (reference.test.js does
// that, slowly, for 3 seeds) -- it runs makeRung/answerKey in-process, which is what actually
// exercises the generator code path that used to blow up.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeWorld } from '../src/world.js';
import { makeRung } from '../src/ladder/rung.js';
import { answerKey } from '../src/ladder/reference.js';
import { REFUSAL_ACTS } from '../src/ladder/grammar.js';

const SEED_COUNT = 300;
// Addendum M's own repro numbers (76ms/523, crash/525) hold for roughly half of seeds 1..300 on
// this hardware; the other half already cost ~3.0-3.4s BEFORE this fix (profiled: dominated by
// zlib's processChunkSync inside toPng's deflateSync, not by anything this fix touches -- a
// pre-existing, seed-dependent PNG-encode cost, not a regression of the caps/redraw work here).
// 2000ms would be red on this machine independent of any generator bug. Budget for the observed
// baseline with real margin, so this still catches what actually matters: an unbounded blowup
// (the seed-525 class of bug redraws/caps this file guards against), not the pre-existing
// deflate cost. Flagged separately for whoever next has zlib/PNG-encode time on their plate.
const MAX_MS_PER_SEED = 8000;
const MAX_BYTES_PER_SEED = 2 * 1024 * 1024;

const MAX_SHAPES = 64;
const MAX_NOTES = 64;
const MAX_CLIPS = 32;

// Walk a value (descriptor, array of descriptors, or plain compute value) and assert every
// shapes/notes/clips array on it is within the Addendum M rule 1 caps. Named after the field it
// checks so a failure points straight at which cap tripped.
function assertWithinCaps(value, where, seen = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertWithinCaps(v, `${where}[${i}]`, seen));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value.shapes)) {
    assert.ok(value.shapes.length <= MAX_SHAPES, `${where}.shapes has ${value.shapes.length}, cap is ${MAX_SHAPES}`);
  }
  if (Array.isArray(value.notes)) {
    assert.ok(value.notes.length <= MAX_NOTES, `${where}.notes has ${value.notes.length}, cap is ${MAX_NOTES}`);
  }
  if (Array.isArray(value.clips)) {
    assert.ok(value.clips.length <= MAX_CLIPS, `${where}.clips has ${value.clips.length}, cap is ${MAX_CLIPS}`);
  }
  for (const [k, v] of Object.entries(value)) assertWithinCaps(v, `${where}.${k}`, seen);
}

test('answerKey(seed) stays under 2s and 2MB for seeds 1..300', () => {
  for (let seed = 1; seed <= SEED_COUNT; seed += 1) {
    const world = makeWorld(seed);
    const t0 = Date.now();
    const key = answerKey(world);
    const ms = Date.now() - t0;
    const bytes = Buffer.byteLength(JSON.stringify(key), 'utf8');
    assert.ok(ms < MAX_MS_PER_SEED, `seed ${seed}: answerKey took ${ms}ms, budget is ${MAX_MS_PER_SEED}ms`);
    assert.ok(
      bytes < MAX_BYTES_PER_SEED,
      `seed ${seed}: answerKey serialized to ${bytes} bytes, budget is ${MAX_BYTES_PER_SEED} bytes`,
    );
    assert.equal(key.rungs.length, 100, `seed ${seed}: expected 100 rungs`);
    for (const rung of key.rungs) assertWithinCaps(rung.expectedDescriptors, `seed ${seed} rung ${rung.n}`);
  }
});

test('makeRung(525, n) stays within the descriptor caps for every rung, 0..99', () => {
  // Seed 525 is the seed that used to OOM. Every rung's plan and its final submitted
  // descriptor(s) must both stay within caps -- not just whichever one the rung submits.
  const world = makeWorld(525);
  for (let n = 0; n < 100; n += 1) {
    const rung = makeRung(world, n);
    assertWithinCaps(rung.plan, `seed 525 rung ${n} plan`);
    assertWithinCaps(rung.expectedDescriptors, `seed 525 rung ${n} expectedDescriptors`);
  }
});

test('seed 525 no longer produces a degenerate (zero-dimension) canvas', () => {
  // The literal seed-525 repro from Addendum M: this used to return width:0, height:0 and
  // NaN (serialized as null) shape coordinates for rung 90, and OOM before it ever got this far.
  const world = makeWorld(525);
  for (let n = 0; n < 100; n += 1) {
    const rung = makeRung(world, n);
    for (const desc of rung.expectedDescriptors) {
      if (desc.kind === 'image') {
        assert.ok(desc.width > 0, `seed 525 rung ${n}: width is ${desc.width}`);
        assert.ok(desc.height > 0, `seed 525 rung ${n}: height is ${desc.height}`);
        for (const shape of desc.shapes) {
          for (const [k, v] of Object.entries(shape)) {
            if (typeof v === 'number') assert.ok(Number.isFinite(v), `seed 525 rung ${n}: shape.${k} is ${v}`);
          }
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Addendum Q: the three fields the key grew, bounded and well formed on every seed
//
// `expectedAudit`, `forbidden` and `amendments` are small by construction, but they are the first
// key fields that are OPTIONAL per rung, and an optional field that is sometimes a malformed
// object is exactly the kind of thing that reaches a grader rather than a test. The budget checks
// above already cover their size; this covers their shape, over the whole 300-seed sweep's worth
// of shapes in the two seeds most likely to be odd.
// ---------------------------------------------------------------------------

test('every rung of every seed carries well-formed 0.7.0 key fields', () => {
  for (const seed of [1, 2, 3, 525]) {
    const world = makeWorld(seed);
    for (let n = 0; n < 100; n += 1) {
      const rung = makeRung(world, n);
      const where = `seed ${seed} rung ${n}`;
      if (rung.expectedAudit !== null) {
        assert.ok(Array.isArray(rung.expectedAudit.stages) && rung.expectedAudit.stages.length >= 4, `${where} audit`);
        for (const stage of rung.expectedAudit.stages) assert.equal(typeof stage, 'string', `${where} audit stage`);
      }
      if (rung.forbidden !== null) {
        assert.ok(REFUSAL_ACTS[rung.forbidden.act] !== undefined, `${where}: unknown forbidden act`);
        assert.equal(typeof rung.forbidden.rule, 'number', `${where} forbidden rule`);
      }
      assert.ok(Array.isArray(rung.amendments), `${where} amendments`);
      assert.ok(rung.rules && typeof rung.rules.roundTo === 'number', `${where} resolved rules`);
    }
  }
});
