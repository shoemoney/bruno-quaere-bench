// docs/RULES-0.6.md is the answer key's contract: every rule it marks (skill) must be stated,
// in plain language, inside the clean SKILL.md (and therefore, verbatim, inside the sloppy
// expansion too -- skill-sloppy.js embeds every `## ` clean section as an intact block). This
// test parses that file directly and proves the clean skill actually says what it claims to
// say, rather than trusting the prose in docs/ARCHITECTURE.md's Addendum I/J commentary.
//
// Method: for every rule numbered 1-27, pull its full text (including wrapped/indented
// continuation lines) and its `**(...)**` marker. For a (skill) rule, extract its "operative
// tokens" -- the numbers, quoted "..." strings, backticked `...` identifiers/formulas, and its
// 3 longest words -- and assert every one of them appears (case-insensitively) somewhere in the
// clean skill for seeds 1..5, and somewhere in the 64 KB sloppy expansion for the same seeds.
// A (task text) rule is a rung-text-only concern (docsolver's job, not skill.js's) and is
// explicitly asserted OUT of the must-appear set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toSkill } from '../src/skill.js';
import { makeWorld } from '../src/world.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_PATH = path.join(__dirname, '..', 'docs', 'RULES-0.6.md');

const SEEDS = [1, 2, 3, 4, 5];
const SLOPPY_TARGET = 64 * 1024;

// ---------------------------------------------------------------------------
// Parsing docs/RULES-0.6.md
// ---------------------------------------------------------------------------

// A rule starts with "N. **(marker)** text..." at column 0 and continues through every
// following line (blank, indented continuation, or nested "- " sub-bullets) until either the
// next top-level numbered rule or a `## ` heading (the appendix that follows rule 27).
const RULE_START_RE = /^(\d+)\.\s+\*\*\(([^)]*)\)\*\*\s*(.*)$/;

function parseRules(text) {
  const lines = text.split('\n');
  const rules = [];
  let current = null;
  for (const line of lines) {
    const m = RULE_START_RE.exec(line);
    if (m) {
      if (current) rules.push(current);
      current = { n: Number(m[1]), marker: m[2].trim(), text: m[3] };
      continue;
    }
    if (current) {
      if (/^## /.test(line) || /^---\s*$/.test(line)) {
        rules.push(current);
        current = null;
        continue;
      }
      current.text += `\n${line}`;
    }
  }
  if (current) rules.push(current);
  return rules;
}

function markerKind(marker) {
  if (marker.startsWith('skill')) return 'skill';
  if (marker.startsWith('task text')) return 'task text';
  return 'other'; // e.g. rule 27: "(new in 0.5.0)" -- neither a skill nor a task-text rule
}

// Illustrative-example numbers the docs themselves invent to demonstrate a rule (rule 2's
// "0.56 inches at 300 dpi -> 168px") are handled by writing them into the skill verbatim as a
// fixed, world-independent aside (skill.js does this), so no exclusion list is needed here --
// every number rule 1-27 actually states is either a fixed constant (2.54, 72, 6, 60, ...) or
// this file's own worked example, and both are required verbatim.
//
// Cross-references to another rule's number ("(rule 3)", "rule 5 then rule 3") are not values
// the skill needs to restate -- they cite this document's own numbering, not a house fact -- so
// they're stripped before numbers are extracted.
function stripRuleCrossRefs(text) {
  return text.replace(/\brules?\s+\d+(?:\s*(?:,|and)\s*\d+)*\b/gi, ' ');
}

function extractTokens(text) {
  const quoted = [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const backticked = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const numbers = [...new Set([...stripRuleCrossRefs(text).matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]))];

  // Longest-3-words: strip backtick spans (their content is checked separately, verbatim, above)
  // and markdown emphasis/punctuation, then rank the remaining words by length, longest first,
  // ties broken by first occurrence (deterministic, and matches how a human would pick "the
  // three standout words" reading top to bottom).
  const stripped = text
    .replace(/`[^`]*`/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/[*_]/g, '')
    .replace(/[.,;:()"—–[\]]/g, ' ');
  const seen = new Set();
  const words = [];
  for (const raw of stripped.split(/\s+/)) {
    const w = raw.trim().replace(/^['"]+|['"]+$/g, '');
    if (!w || !/[a-zA-Z]/.test(w)) continue;
    const key = w.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(w);
  }
  const longestWords = [...words].sort((a, b) => b.length - a.length).slice(0, 3);

  return { quoted, backticked, numbers, longestWords };
}

const ALL_RULES = parseRules(readFileSync(RULES_PATH, 'utf8'));
const SKILL_RULES = ALL_RULES.filter((r) => markerKind(r.marker) === 'skill');
const TASK_TEXT_RULES = ALL_RULES.filter((r) => markerKind(r.marker) === 'task text');

// ---------------------------------------------------------------------------
// Sanity on the parse itself -- if this drifts to 0, every test below would vacuously pass.
// ---------------------------------------------------------------------------

test('parses a plausible number of (skill) and (task text) rules out of RULES-0.6.md', () => {
  assert.ok(ALL_RULES.length >= 25, `only found ${ALL_RULES.length} numbered rules total`);
  assert.ok(SKILL_RULES.length >= 20, `only found ${SKILL_RULES.length} (skill) rules`);
  assert.ok(TASK_TEXT_RULES.length >= 4, `only found ${TASK_TEXT_RULES.length} (task text) rules`);
  // spot-check a few numbers landed on the marker the file actually gives them
  const byN = new Map(ALL_RULES.map((r) => [r.n, r]));
  assert.equal(markerKind(byN.get(1).marker), 'skill', 'rule 1 (unit->px) must be (skill)');
  assert.equal(markerKind(byN.get(18).marker), 'task text', 'rule 18 (derived-number recipe) must be (task text)');
  assert.equal(markerKind(byN.get(19).marker), 'task text', 'rule 19 (the five X kinds) must be (task text)');
  assert.equal(markerKind(byN.get(21).marker), 'task text', 'rule 21 (cross-rung recall) must be (task text)');
  assert.equal(markerKind(byN.get(25).marker), 'skill', 'rule 25 (conditional write) must be (skill)');
});

// No (task text) rule may be required as skill content -- the skill states house RULES, never
// the ladder's own rung-phrasing grammar. This is mostly a self-check on the categorization
// above, but it also guards against a future edit to RULES-0.6.md relabeling a rule without the
// generator noticing: if a rule the file calls task-text-only ever migrated into SKILL_RULES,
// this would start requiring the skill to contain rung-grammar placeholders like `[W]` or `[M]`,
// which it correctly never does.
test('no (task text)-only rule is required as skill content', () => {
  const skillNumbers = new Set(SKILL_RULES.map((r) => r.n));
  for (const r of TASK_TEXT_RULES) {
    assert.ok(!skillNumbers.has(r.n), `rule ${r.n} is marked (task text) but also parsed as (skill)`);
  }
  const world = makeWorld(1);
  const clean = toSkill(world);
  // Rung-grammar placeholders are exclusive to the task-text appendix (rules 18/19/21/22/26 and
  // the phrase catalogue below them) -- the clean skill must never speak in that placeholder
  // syntax, since it describes house rules, not rung wording.
  assert.doesNotMatch(clean, /\[[WHXYPMDBFSK]\]/, 'clean skill must not contain rung-text placeholders like [W] or [M]');
});

// ---------------------------------------------------------------------------
// The main coverage assertion
// ---------------------------------------------------------------------------

function allTokens(rule) {
  const tok = extractTokens(rule.text);
  // dedupe case-insensitively across categories so a token required twice (e.g. a number that's
  // also substring-equal to part of a longest word) doesn't get checked twice for no reason
  const out = [];
  const seen = new Set();
  const push = (kind, value) => {
    const key = `${kind}:${value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, value });
  };
  tok.quoted.forEach((v) => push('quoted', v));
  tok.backticked.forEach((v) => push('backticked', v));
  tok.numbers.forEach((v) => push('number', v));
  tok.longestWords.forEach((v) => push('word', v));
  return out;
}

function findMissing(haystack, tokens) {
  const lower = haystack.toLowerCase();
  for (const t of tokens) {
    if (!lower.includes(t.value.toLowerCase())) return t;
  }
  return null;
}

test('every (skill) rule\'s operative tokens appear in the clean skill for seeds 1..5', () => {
  for (const seed of SEEDS) {
    const clean = toSkill(makeWorld(seed));
    for (const rule of SKILL_RULES) {
      const tokens = allTokens(rule);
      assert.ok(tokens.length > 0, `rule ${rule.n} produced no operative tokens to check -- parser bug`);
      const missing = findMissing(clean, tokens);
      if (missing) {
        // Verbose, as asked: the rule number, its marker, its full extracted text, and exactly
        // which token of which kind could not be found, so a failure is diagnosable without
        // re-deriving the parse by hand.
        assert.fail(
          [
            `seed ${seed}: clean skill is missing rule ${rule.n} [${rule.marker}]`,
            `  missing token: ${missing.kind} = ${JSON.stringify(missing.value)}`,
            `  all required tokens for this rule: ${JSON.stringify(tokens)}`,
            `  rule ${rule.n} text:`,
            rule.text.split('\n').map((l) => `    ${l}`).join('\n'),
          ].join('\n'),
        );
      }
    }
  }
});

test('every (skill) rule\'s operative tokens appear in the 64 KB sloppy output for seeds 1..5', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const sloppy = toSkill(world, { mode: 'sloppy', targetBytes: SLOPPY_TARGET });
    for (const rule of SKILL_RULES) {
      const tokens = allTokens(rule);
      const missing = findMissing(sloppy, tokens);
      if (missing) {
        assert.fail(
          [
            `seed ${seed}: sloppy (64 KB) skill is missing rule ${rule.n} [${rule.marker}]`,
            `  missing token: ${missing.kind} = ${JSON.stringify(missing.value)}`,
            `  all required tokens for this rule: ${JSON.stringify(tokens)}`,
            `  rule ${rule.n} text:`,
            rule.text.split('\n').map((l) => `    ${l}`).join('\n'),
          ].join('\n'),
        );
      }
    }
  }
});
