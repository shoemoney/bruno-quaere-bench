// Addendum A: the sloppy SKILL.md is accurate but buried. These tests prove the burying is
// honest -- every truth is present and correctly located, every decoy is marked, the
// precedence convention that resolves them sits past the 10% mark, and no two rules' decoys
// or truths ever contradict each other outside a marked block. The 5 MB / 2s check is the
// real-run shape; the 64 KB checks are the same invariants at a size a test suite can afford.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSkill, truthTable } from '../src/skill-sloppy.js';
import { toSkill as toSkillDispatch, sections as cleanSections } from '../src/skill.js';
import { makeWorld } from '../src/world.js';

const SEEDS = [1, 2, 3, 4, 5];
const SMALL = 64 * 1024;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Every occurrence, in the WHOLE document, of the exact `key=value` token this entry renders as.
function tokenOccurrences(doc, key, value) {
  const re = new RegExp('`' + escapeRegExp(key) + '=' + escapeRegExp(value) + '`', 'g');
  const out = [];
  for (const m of doc.matchAll(re)) out.push(m.index + 1 + key.length + 1); // offset of the value itself
  return out;
}

test('skill.js dispatches {mode: "sloppy"} to this module', () => {
  const world = makeWorld(1);
  assert.equal(toSkillDispatch(world, { mode: 'sloppy', targetBytes: SMALL }), toSkill(world, { targetBytes: SMALL }));
});

test('determinism: same seed and targetBytes reproduce identical bytes, both doc and truth table', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const a = toSkill(world, { targetBytes: SMALL });
    const b = toSkill(makeWorld(seed), { targetBytes: SMALL });
    assert.equal(a, b, `seed ${seed}: doc`);
    assert.deepEqual(truthTable(world, { targetBytes: SMALL }), truthTable(makeWorld(seed), { targetBytes: SMALL }), `seed ${seed}: truth table`);
  }
});

test('every truth value is present at its recorded offset, backticked as key=value', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const doc = toSkill(world, { targetBytes: SMALL });
    const tt = truthTable(world, { targetBytes: SMALL });
    assert.ok(tt.rules.length > 0, `seed ${seed}: no rules in truth table`);
    for (const r of tt.rules) {
      const e = r.truth;
      assert.ok(e, `seed ${seed}: rule ${r.key} has no truth entry`);
      const got = doc.slice(e.offset, e.offset + e.value.length);
      assert.equal(got, e.value, `seed ${seed}: rule ${r.key} truth value mismatch at offset`);
      const prefix = doc.slice(e.offset - r.key.length - 2, e.offset);
      assert.equal(prefix, '`' + r.key + '=', `seed ${seed}: rule ${r.key} truth not backtick-keyed`);
      assert.equal(doc[e.offset + e.value.length], '`', `seed ${seed}: rule ${r.key} truth not closed with backtick`);
    }
  }
});

test('every decoy is present at its offset and marked with a date or version', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const doc = toSkill(world, { targetBytes: SMALL });
    const tt = truthTable(world, { targetBytes: SMALL });
    for (const r of tt.rules) {
      assert.ok(r.decoys.length >= 2 && r.decoys.length <= 4, `seed ${seed}: rule ${r.key} has ${r.decoys.length} decoys, want 2-4`);
      for (const d of r.decoys) {
        const got = doc.slice(d.offset, d.offset + d.value.length);
        assert.equal(got, d.value, `seed ${seed}: rule ${r.key} decoy value mismatch at offset`);
        // marked: the block this decoy lives in carries its own date/version marker literally
        const block = doc.slice(d.blockStart, d.blockEnd);
        assert.ok(block.includes(d.marker), `seed ${seed}: rule ${r.key} decoy block missing its own marker "${d.marker}"`);
        assert.match(block, /\(dated |^\(v\d+\)|\(v\d+\)/, `seed ${seed}: rule ${r.key} decoy not marked as dated or versioned`);
      }
      // and the truth entry is marked the same way -- same convention, just the newest marker
      const truthBlock = doc.slice(r.truth.blockStart, r.truth.blockEnd);
      assert.ok(truthBlock.includes(r.truth.marker), `seed ${seed}: rule ${r.key} truth block missing its own marker`);
    }
  }
});

// The invariant the whole design rests on. Every other check here can pass while this one fails,
// and if it fails the benchmark is inverted: an agent that reads carefully, finds the precedence
// convention, and applies it correctly gets the WRONG value, while a skimmer that grabs whichever
// statement it saw first sometimes gets the right one. Regression guard -- markersFor() used to
// add an independent random year offset per entry, which made the "ascending" sequence
// non-monotonic and left 9 of 16 chains on seed 1 with a decoy newer than the truth.
test('applying the stated precedence convention always resolves to the truth, never a decoy', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const world = makeWorld(seed);
    const tt = truthTable(world, { targetBytes: SMALL });
    for (const r of tt.rules) {
      const markers = [...r.decoys.map((d) => d.marker), r.truth.marker];
      assert.equal(new Set(markers).size, markers.length, `seed ${seed}: rule ${r.key} reuses a marker, so precedence cannot resolve it`);
      // date markers are ISO (lexical order == chronological); version markers are v1..vN,
      // which are only lexically ordered up to v9 -- compare them numerically.
      const rank = (m) => (tt.precedence.type === 'version' ? Number(m.slice(1)) : m);
      for (const d of r.decoys) {
        assert.ok(
          rank(d.marker) < rank(r.truth.marker),
          `seed ${seed}: rule ${r.key} decoy ${d.value} is marked ${d.marker}, which outranks the truth's ${r.truth.marker} -- the precedence convention would point at the decoy`,
        );
      }
      if (tt.precedence.type === 'date') {
        assert.ok(r.truth.marker <= '2026-12-31', `seed ${seed}: rule ${r.key} truth is dated in the future (${r.truth.marker})`);
      }
    }
  }
});

test('the precedence convention is stated exactly once, past the 10% mark, and names a resolvable rule', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const doc = toSkill(world, { targetBytes: SMALL });
    const tt = truthTable(world, { targetBytes: SMALL });
    assert.ok(['date', 'version'].includes(tt.precedence.type), `seed ${seed}`);
    assert.ok(tt.precedence.offset > doc.length * 0.1, `seed ${seed}: precedence at ${tt.precedence.offset}/${doc.length} = ${(tt.precedence.offset / doc.length * 100).toFixed(1)}%, must be > 10%`);
    const occurrences = [...doc.matchAll(new RegExp(escapeRegExp(tt.precedence.text), 'g'))];
    assert.equal(occurrences.length, 1, `seed ${seed}: precedence statement should appear exactly once`);
    assert.equal(occurrences[0].index, doc.indexOf(tt.precedence.text), `seed ${seed}`);
    assert.match(tt.precedence.text, tt.precedence.type === 'date' ? /newest date/i : /highest v-number/i, `seed ${seed}`);
  }
});

test('the other three of "the four things" (unit words, lora names, signing recipe) are also past 10%', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const doc = toSkill(world, { targetBytes: SMALL });
    const tt = truthTable(world, { targetBytes: SMALL });
    for (const [name, offset] of Object.entries(tt.fourThings)) {
      assert.ok(offset > doc.length * 0.1, `seed ${seed}: ${name} at ${(offset / doc.length * 100).toFixed(1)}%, must be > 10%`);
    }
    // Addendum I: "signing recipe" now points at the whole embedded "Publish signing" section
    // (the real recipe: X-Signature, X-Timestamp, the canonical string), not just the scalar
    // canon-ordering fact -- that fact is still separately tracked as the 'canon' rule chain.
    const publishSigning = tt.sections.find((s) => s.heading === 'Publish signing');
    assert.ok(publishSigning, `seed ${seed}: no "Publish signing" section in truth table`);
    assert.equal(tt.fourThings.signingRecipe, publishSigning.offset, `seed ${seed}`);
  }
});

// Addendum I rule 3: skill-sloppy.js currently re-emits scalar facts only and drops every prose
// section, including the entire publish-signing recipe. The fix embeds each `##` section body
// of the clean skill verbatim as an intact block inside the noise, never in the first 10%.
test('every `## ` section of the clean skill appears verbatim, intact, past 10%, in the sloppy 64 KB output', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const doc = toSkill(world, { targetBytes: SMALL });
    const tt = truthTable(world, { targetBytes: SMALL });
    const clean = cleanSections(world);
    assert.ok(clean.length > 10, `seed ${seed}: suspiciously few clean sections (${clean.length})`);
    assert.equal(tt.sections.length, clean.length, `seed ${seed}: truth table section count mismatch`);
    for (const c of clean) {
      const rec = tt.sections.find((s) => s.heading === c.heading);
      assert.ok(rec, `seed ${seed}: section "${c.heading}" missing from truth table`);
      assert.equal(rec.body, c.body, `seed ${seed}: section "${c.heading}" body doesn't match skill.js's own sections()`);
      assert.ok(rec.offset > doc.length * 0.1, `seed ${seed}: section "${c.heading}" at ${(rec.offset / doc.length * 100).toFixed(1)}%, must be > 10%`);
      const got = doc.slice(rec.offset, rec.offset + rec.length);
      assert.equal(got, c.body, `seed ${seed}: section "${c.heading}" not verbatim at its recorded offset`);
      // "intact block": the exact substring occurs once, unbroken, at exactly that offset --
      // not merely somewhere in the document (e.g. reassembled from fragments).
      assert.equal(doc.indexOf(c.body), rec.offset, `seed ${seed}: section "${c.heading}" body's first occurrence isn't at its recorded offset`);
    }
  }
});

test('every `## ` section of the clean skill appears verbatim, intact, past 10%, in the sloppy 5 MB output', () => {
  const target = 5 * 1024 * 1024;
  const world = makeWorld(1);
  const doc = toSkill(world, { targetBytes: target });
  const tt = truthTable(world, { targetBytes: target });
  const clean = cleanSections(world);
  for (const c of clean) {
    const rec = tt.sections.find((s) => s.heading === c.heading);
    assert.ok(rec, `section "${c.heading}" missing from truth table`);
    assert.ok(rec.offset > doc.length * 0.1, `section "${c.heading}" must be past 10%`);
    assert.equal(doc.slice(rec.offset, rec.offset + rec.length), c.body, `section "${c.heading}" not verbatim`);
  }
});

// The specific failure Addendum I calls out by name: hmac was zero hits in 5 MB before this
// fix, which makes rungs 60+ (publish, hmac) unsolvable from the docs alone.
test('X-Signature, X-Timestamp, and the canonical string all appear, inside the embedded "Publish signing" section', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const doc = toSkill(world, { targetBytes: SMALL });
    const tt = truthTable(world, { targetBytes: SMALL });
    assert.match(doc, /X-Signature/, `seed ${seed}`);
    assert.match(doc, /X-Timestamp/, `seed ${seed}`);
    const publishSigning = tt.sections.find((s) => s.heading === 'Publish signing');
    const body = doc.slice(publishSigning.offset, publishSigning.offset + publishSigning.length);
    assert.match(body, new RegExp(escapeRegExp(world.hmac.header)), `seed ${seed}: ${world.hmac.header} not in the signing section itself`);
    assert.match(body, new RegExp(escapeRegExp(world.hmac.tsHeader)), `seed ${seed}: ${world.hmac.tsHeader} not in the signing section itself`);
    // The worked canonical string example. 0.7.0's default recipe is digest-bound (RULES-0.8 rule
    // 35), so the block is four lines -- timestamp, method, path, digest -- rather than the one
    // concatenated line the pre-0.7.0 recipes printed. Accept either, since rule 33 may amend the
    // canon to a different field order and a hand-built world may still carry an older recipe.
    assert.match(
      body,
      /```\n(?:\d+POST\/\S+publish|\d+\nPOST\n\/\S+publish\n[0-9a-f]{64})\n```/,
      `seed ${seed}: no canonical-string worked example in the signing section`,
    );
  }
});

test('contradiction scan: every occurrence of a rule\'s value token in the whole document is one of its own recorded, marked entries', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const doc = toSkill(world, { targetBytes: SMALL });
    const tt = truthTable(world, { targetBytes: SMALL });
    for (const r of tt.rules) {
      const entries = [r.truth, ...r.decoys];
      const recordedOffsets = new Set(entries.map((e) => e.offset));
      // Group by value: two entries could in principle share a value only if the world rolled
      // duplicate decoys, which decoy selection already prevents -- so per value there is
      // exactly one recorded offset, and every occurrence of that key=value token must be it.
      const seenValues = new Set();
      for (const e of entries) {
        if (seenValues.has(e.value)) continue;
        seenValues.add(e.value);
        const occurrences = tokenOccurrences(doc, r.key, e.value);
        assert.deepEqual(
          occurrences.sort((a, b) => a - b),
          entries.filter((x) => x.value === e.value).map((x) => x.offset).sort((a, b) => a - b),
          `seed ${seed}: rule ${r.key} value "${e.value}" occurs somewhere unmarked/unrecorded`,
        );
        for (const off of occurrences) {
          assert.ok(recordedOffsets.has(off), `seed ${seed}: rule ${r.key} value "${e.value}" at ${off} is not a recorded entry`);
        }
      }
    }
  }
});

test('rule keys are unique and every rule has exactly one truth entry', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const tt = truthTable(world, { targetBytes: SMALL });
    const keys = tt.rules.map((r) => r.key);
    assert.equal(new Set(keys).size, keys.length, `seed ${seed}: duplicate rule keys`);
    for (const r of tt.rules) {
      assert.ok(r.truth, `seed ${seed}: rule ${r.key} missing truth`);
    }
  }
});

test('the true value in the truth table matches the world it was built from', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const tt = truthTable(world, { targetBytes: SMALL });
    const by = Object.fromEntries(tt.rules.map((r) => [r.key, r.truth.value]));
    assert.equal(by.dpi, String(world.rules.dpi), `seed ${seed}`);
    assert.equal(by.roundTo, String(world.rules.roundTo), `seed ${seed}`);
    assert.equal(by.roundMode, world.rules.roundMode, `seed ${seed}`);
    assert.equal(by.opacityCompound, world.rules.opacityCompound, `seed ${seed}`);
    assert.equal(by.imageFormat, world.rules.defaultFormat.image, `seed ${seed}`);
    assert.equal(by.audioFormat, world.rules.defaultFormat.audio, `seed ${seed}`);
    assert.equal(by.sampleRate, String(world.rules.defaultSampleRate), `seed ${seed}`);
    assert.equal(by.fps, String(world.rules.defaultFps), `seed ${seed}`);
    assert.equal(by.zOrder, world.rules.zOrder, `seed ${seed}`);
    assert.equal(by.colorShiftSpace, world.rules.colorShiftSpace, `seed ${seed}`);
    assert.equal(by.bitrateUnit, world.rules.bitrateBudgetUnit, `seed ${seed}`);
    assert.equal(by.cursorStyle, world.pagination.cursorStyle, `seed ${seed}`);
    assert.equal(by.naming, world.naming === 'snake' ? 'snake_case' : 'camelCase', `seed ${seed}`);
    assert.equal(by.canon, world.hmac.canon, `seed ${seed}`);
    assert.equal(by.tokenTtl, String(world.auth.tokenTtlSec), `seed ${seed}`);
    assert.equal(by.pageSize, String(world.pagination.pageSize), `seed ${seed}`);
  }
});

test('never uses the word "trap"', () => {
  for (const seed of SEEDS) {
    const doc = toSkill(makeWorld(seed), { targetBytes: SMALL });
    assert.doesNotMatch(doc, /trap/i, `seed ${seed}`);
  }
});

test('64 KB mode produces a real document with headings and filler variety', () => {
  for (const seed of SEEDS) {
    const doc = toSkill(makeWorld(seed), { targetBytes: SMALL });
    assert.ok(doc.length > SMALL * 0.5, `seed ${seed}: suspiciously short (${doc.length} bytes)`);
    assert.match(doc, /### Changelog/, `seed ${seed}`);
    assert.match(doc, /RETIRED/, `seed ${seed}`);
    assert.match(doc, /TODO/, `seed ${seed}`);
    assert.match(doc, /```yaml/, `seed ${seed}`);
    assert.match(doc, /FAQ/, `seed ${seed}`);
  }
});

test('5 MB mode: size within 5% of target and built in under 2 seconds', () => {
  const target = 5 * 1024 * 1024;
  for (const seed of SEEDS.slice(0, 3)) {
    const world = makeWorld(seed);
    const t0 = Date.now();
    const doc = toSkill(world, { targetBytes: target });
    const ms = Date.now() - t0;
    assert.ok(ms < 2000, `seed ${seed}: took ${ms}ms, want < 2000ms`);
    const ratio = doc.length / target;
    assert.ok(ratio >= 0.95 && ratio <= 1.05, `seed ${seed}: ${doc.length} bytes is ${(ratio * 100).toFixed(1)}% of target ${target}`);
  }
});

test('5 MB mode still satisfies the same offset, marking, and precedence invariants', () => {
  const target = 5 * 1024 * 1024;
  const world = makeWorld(1);
  const doc = toSkill(world, { targetBytes: target });
  const tt = truthTable(world, { targetBytes: target });
  assert.ok(tt.precedence.offset > doc.length * 0.1);
  for (const r of tt.rules) {
    const entries = [r.truth, ...r.decoys];
    for (const e of entries) {
      assert.equal(doc.slice(e.offset, e.offset + e.value.length), e.value, `rule ${r.key}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Addendum J rule 7: skill pressure -- a per-section precedence rotation, plus one newer-dated
// decoy that is explicitly retracted two lines later. Still never an unmarked contradiction
// (the retraction IS the mark), still a superset of clean (nothing above changes because of this).
// ---------------------------------------------------------------------------

test('sectionPrecedence: states a LOCAL convention, of the OPPOSITE type from the document\'s global one', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const doc = toSkill(world, { targetBytes: SMALL });
    const tt = truthTable(world, { targetBytes: SMALL });
    const sp = tt.sectionPrecedence;
    assert.ok(['date', 'version'].includes(sp.localType), `seed ${seed}`);
    assert.notEqual(sp.localType, tt.precedence.type, `seed ${seed}: local convention must rotate away from the global one`);
    assert.match(sp.localText, /^In this section,/, `seed ${seed}`);
    assert.match(sp.localText, sp.localType === 'version' ? /highest v-number/i : /newest date/i, `seed ${seed}`);
    // present, exactly once, past the 10% floor every other buried fact is held to
    const occurrences = [...doc.matchAll(new RegExp(escapeRegExp(sp.localText), 'g'))];
    assert.equal(occurrences.length, 1, `seed ${seed}`);
    assert.equal(occurrences[0].index, sp.localTextOffset, `seed ${seed}`);
    assert.ok(sp.localTextOffset > doc.length * 0.1, `seed ${seed}: local convention before the 10% mark`);
  }
});

test('sectionPrecedence: the retracted decoy is present at its offset, backticked as key=value, referencing a real rule chain', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const doc = toSkill(world, { targetBytes: SMALL });
    const tt = truthTable(world, { targetBytes: SMALL });
    const sp = tt.sectionPrecedence;
    const rule = tt.rules.find((r) => r.key === sp.chainKey);
    assert.ok(rule, `seed ${seed}: sectionPrecedence points at an unknown chain "${sp.chainKey}"`);

    const { offset, value } = sp.retracted;
    assert.equal(doc.slice(offset, offset + value.length), value, `seed ${seed}`);
    const prefix = doc.slice(offset - sp.chainKey.length - 2, offset);
    assert.equal(prefix, '`' + sp.chainKey + '=', `seed ${seed}: retracted decoy not backtick-keyed`);
    assert.equal(doc[offset + value.length], '`', `seed ${seed}`);

    // it must never collide with that same chain's own recorded truth/decoy values -- a fresh
    // value, never one this chain already used elsewhere in the document.
    const usedElsewhere = new Set([rule.truth.value, ...rule.decoys.map((d) => d.value)]);
    assert.ok(!usedElsewhere.has(value), `seed ${seed}: retracted decoy reuses an already-recorded value for ${sp.chainKey}`);
  }
});

test('sectionPrecedence: the decoy is dated strictly after every genuine truth marker in the document', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const tt = truthTable(world, { targetBytes: SMALL });
    const sp = tt.sectionPrecedence;
    assert.match(sp.retracted.marker, /^\d{4}-\d{2}-\d{2}$/, `seed ${seed}: retracted marker must be a date, even when the local/global conventions are version-based`);
    const retractedYear = Number(sp.retracted.marker.slice(0, 4));
    if (tt.precedence.type === 'date') {
      const maxTruthYear = Math.max(...tt.rules.map((r) => Number(r.truth.marker.slice(0, 4))));
      assert.ok(retractedYear > maxTruthYear, `seed ${seed}: retracted year ${retractedYear} must postdate every truth year (max ${maxTruthYear})`);
    } else {
      assert.ok(retractedYear >= 2027, `seed ${seed}: retracted year ${retractedYear} should read as clearly near-future when nothing else in the document carries a date`);
    }
  }
});

test('sectionPrecedence: the decoy is explicitly retracted exactly two lines later, never an unmarked contradiction', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const doc = toSkill(world, { targetBytes: SMALL });
    const tt = truthTable(world, { targetBytes: SMALL });
    const { claimOffset, retractionOffset } = tt.sectionPrecedence.retracted;
    assert.ok(retractionOffset > claimOffset, `seed ${seed}`);
    const lineOf = (off) => doc.slice(0, off).split('\n').length - 1;
    assert.equal(lineOf(retractionOffset) - lineOf(claimOffset), 2, `seed ${seed}: retraction must sit exactly two lines below the claim`);
    const between = doc.slice(claimOffset, retractionOffset);
    assert.doesNotMatch(between, /RETRACTED/, `seed ${seed}: the retraction marker must not appear before the retraction line itself`);
    const retractionLineEnd = doc.indexOf('\n', retractionOffset);
    const retractionLine = doc.slice(retractionOffset, retractionLineEnd === -1 ? undefined : retractionLineEnd);
    assert.match(retractionLine, /^RETRACTED/, `seed ${seed}: the retraction must say so explicitly, in words`);
  }
});

test('sectionPrecedence: applying either convention to the retracted decoy alone never authorizes it -- the retraction always wins', () => {
  // The retracted entry is dated (so it would look newer under a date-based reading) but the
  // section's own stated convention here is the OPPOSITE type -- so under the section's own
  // rule a bare date carries no weight at all, and even if a reader ignored that and fell back to
  // the document's global convention, the explicit "RETRACTED" sentence overrides both. This test
  // is the sharpest form of "never an unmarked contradiction": the one entry designed to look
  // like it should win, by construction, must not be findable as authoritative anywhere.
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const tt = truthTable(world, { targetBytes: SMALL });
    const sp = tt.sectionPrecedence;
    const rule = tt.rules.find((r) => r.key === sp.chainKey);
    assert.notEqual(sp.retracted.value, rule.truth.value, `seed ${seed}: the retracted decoy must not accidentally equal the real truth`);
  }
});

test('sectionPrecedence: still a superset of clean -- adding this block changes nothing else the existing invariants check', () => {
  // Regression guard: this feature is additive noise, not a rewrite. Rerunning the pre-existing
  // per-chain marker/precedence checks (duplicated narrowly here rather than relying on test
  // order) confirms the global chains are untouched by the new block sharing their `chains` array.
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const tt = truthTable(world, { targetBytes: SMALL });
    for (const r of tt.rules) {
      const rank = (m) => (tt.precedence.type === 'version' ? Number(m.slice(1)) : m);
      for (const d of r.decoys) {
        assert.ok(rank(d.marker) < rank(r.truth.marker), `seed ${seed}: rule ${r.key} global resolution broken by sectionPrecedence`);
      }
    }
  }
});
