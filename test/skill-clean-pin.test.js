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
// Rebaselined again for RULES-0.5.0 rules 1, 3-6, 9-17, 20, 23, 25 (new sections and expanded
// prose so the clean skill states everything docs/RULES-0.5.md marks (skill)) -- see
// test/skill-rules-subset.test.js, which is what actually proves the new content is complete.
const CLEAN_SEED_1_SHA256 = '356ae8c57315f58a0dbb2c4aa397e8e84be957af2d18c6de36c26dfe6d739780';

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
