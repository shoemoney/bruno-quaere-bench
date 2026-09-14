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
// Rebaselined again for RULES-0.6.0 rules 1, 3-6, 9-17, 20, 23, 25 (new sections and expanded
// prose so the clean skill states everything docs/RULES-0.6.md marks (skill)) -- see
// test/skill-rules-subset.test.js, which is what actually proves the new content is complete.
// Rebaselined a third time by Addendum M: rule 5's percent-resize floor is now stated as "one
// whole step of the house grid" instead of a bare "1px" (the old bare-1 floor was not itself
// grid-aligned and could get rounded back down to 0 by the very next resize -- see
// grammar.js's runCompute and docs/RULES-0.6.md rule 5).
// Rebaselined a fourth time by Addendum O / ladder 0.6.0, rule 28 ("What a stitched clip is for"):
// the "Stitching moving clips" section now states the antecedent rule -- a stitched piece is only
// there to be counted, the ordered chain that follows a stitch still applies to the picture, never
// to the stitched clip -- and "Video container facts" now states outright that a video converts
// only to `qvid`. Both are real, intended content additions (see test/skill-rules-subset.test.js,
// which proves docs/RULES-0.6.md rule 28's tokens are actually present), not a regression.
// Rebaselined a fifth time for ladder 0.7.0 / docs/RULES-0.8.md rules 30-37 (Addendum Q): four new
// sections -- "Cleared-out assets" (30), "Amendments" (33, plus the regression-task paragraph for
// 34), "Negative-space grading" (36), "Byte budgets" (37) -- inserted between "Video container
// facts" and "Overrides"; the Pagination section gained the short-page/undercount and
// scoped-derived-count paragraphs (31, 32); the Publish signing section gained the digest-binding
// paragraph (35, `X-Body-Digest`). test/skill-rules-subset.test.js (now pointed at RULES-0.8.md)
// proves every new (skill) rule's tokens are actually present; this is a real, intended content
// addition, not a regression.
// Rebaselined a sixth time when Addendum Q rule 10's digest-bound canonical string became the
// house default: "Publish signing" now states where the digest comes from (the house's own hash
// of the artifact, fetched, never computed locally), that it travels as `X-Body-Digest`, and that
// the four parts are newline-separated rather than concatenated -- and its worked example is four
// lines instead of one. test/skill.test.js proves an agent following the section actually
// publishes, and that the pre-0.7.0 recipes do not. A real, intended content change.
// Rebaselined a seventh time for ladder 0.7.1 / docs/RULES-0.8.md rule 38 (Addendum S): the
// "Project state machine" section now states outright that a task testing stage recovery says so
// as a plain instruction, and that a task which never asks for the early reach never requires or
// grades one. A real, intended content addition, not a regression.
// Rebaselined an eighth time for ladder 0.8.0 / docs/RULES-0.8.md rule 40 (Addendum T): the
// Defaults section now states that the task text's plain words name the flavors ("a vector file"
// is `svg`, "a bitmap file" is `png`, "plain wave audio" is `wav`, "the compact house audio
// flavor" is `qa8`) -- the word-to-flavor mapping previously existed only in the docsolver, so
// nothing agent-facing derived it. test/skill-rules-subset.test.js proves rule 40's tokens are
// actually present. A real, intended content addition, not a regression.
const CLEAN_SEED_1_SHA256 = '1917e930e86c432bf9921d75ed2873bad5599231239bdcc4d1d657f2e97d04e5';

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
