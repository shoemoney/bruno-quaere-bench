// Pins the exact bytes of clean-mode toSkill() output for seed 1. Addendum A adds a
// 'sloppy' mode to skill.js that wraps this same clean generator; this test exists to
// prove that work never changes a single byte of what clean mode produces -- clean stays
// the ground truth the sloppy generator expands, never the other way around.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSkill } from '../src/skill.js';
import { makeWorld } from '../src/world.js';
import { sha256 } from '../src/canon.js';

// Rebaselined by Addendum G: the "House DPI and rounding" section gained two plainly-stated
// facts (the API accepts `unit` and converts server-side; the 6-decimal snap before rounding),
// which is a real, intended content change, not a regression.
const CLEAN_SEED_1_SHA256 = '42a7cfff7a39774c3f173abbc5bb1e7fb5e41a5b88e0e19c30303b531236a920';

test('clean-mode toSkill(world) output for seed 1 is byte-identical to the pre-sloppy baseline', () => {
  const world = makeWorld(1);
  const md = toSkill(world);
  assert.equal(sha256(md), CLEAN_SEED_1_SHA256);
});

test('explicit {mode: "clean"} matches the no-opts default', () => {
  const world = makeWorld(1);
  assert.equal(toSkill(world), toSkill(world, { mode: 'clean' }));
  assert.equal(sha256(toSkill(world, { mode: 'clean' })), CLEAN_SEED_1_SHA256);
});
