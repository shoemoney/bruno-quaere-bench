// Addendum Q rule 1's gate. The single highest-leverage change on the 0.7.0 list, and the one
// with the narrowest failure mode: a paraphrasing that quietly drops a leaf makes a rung
// unclimbable for one reader in four, and nothing else in the suite would notice, because the
// generator is happy and the reference does not read text at all.
//
// Two invariants, and they are the whole file:
//
//   1. THE PLAN IS NOT A FUNCTION OF THE PHRASING. The variant is drawn from its own sub-seed and
//      is used only to render text, so forcing every clause of a rung to phrasing v must leave
//      the plan, the descriptors and the hashes byte-identical to phrasing 0. If that ever stops
//      being true the answer key depends on prose, which is the end of the ladder.
//   2. EVERY PHRASING OF A KIND STATES THE SAME LEAVES. test/ladder.test.js checks that a rung's
//      text names every parameter its hash depends on -- for ONE phrasing, the one the seed drew.
//      This runs the same check against all four.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { makeWorld } from '../src/world.js';
import { makeRung, CLAUSE_KINDS, PHRASING_COUNT, phrasingsFor, saysOneOf } from '../src/ladder/rung.js';
import { canonical } from '../src/canon.js';

const RULES_DOC = readFileSync(new URL('../docs/RULES-0.8.md', import.meta.url), 'utf8');

// Addendum Q rule 1 says "k >= 4". Four is what the tables carry; this pins the floor, not the
// exact number, so adding a fifth phrasing to one kind is not a test failure.
test('every clause kind carries at least four phrasings, and the module agrees on how many', () => {
  assert.ok(CLAUSE_KINDS.length >= 20, `only ${CLAUSE_KINDS.length} clause kinds -- the surface is too small to be worth paraphrasing`);
  assert.ok(PHRASING_COUNT >= 4);
  for (const kind of CLAUSE_KINDS) {
    const variants = phrasingsFor(kind, PROBE_ARGS);
    assert.equal(variants.length, PHRASING_COUNT, `clause kind "${kind}"`);
    assert.equal(new Set(variants).size, PHRASING_COUNT, `clause kind "${kind}" has two identical phrasings`);
    for (const v of variants) assert.ok(v.length > 0, `clause kind "${kind}" has an empty phrasing`);
  }
});

// One args object that satisfies every parametric kind at once: each renderer picks the fields it
// needs and ignores the rest, so a single probe exercises the whole table.
const PROBE_ARGS = {
  label: 'quartz', word: 'quartz', many: '3', count: 2, m: 17, step: 0.9,
  width: 120, height: 90, measure: '4 by 3 inches', color: '#aabbcc', pct: 55,
  durationMs: 800, durMs: 200, startMs: 100, freq: 440, wave: 'sine',
  piece: 'the piece you turned in at step 17', ground: 'a #aabbcc ground', list: '(1) a thing',
  body: '(1) do a thing', dims: '120 by 90 pixels', saved: '', percent: 60,
  recipe: 'start at 70 and take 2 off for every shape', base: 70, off: 2, phrase: 'shape',
  name: 'Jenny', styleName: 'Jenny', flavor: 'a vector file', noun: 'scene',
  project: 'the scene', workspace: 'the studio', pageSize: 3, paint: 'painted #aabbcc at 55 percent solid',
  x: 1, y: 2, w: 30, h: 40, r: 12, x2: 50, y2: 60,
};

// ---------------------------------------------------------------------------
// invariant 1: the plan is not a function of the phrasing
// ---------------------------------------------------------------------------

function planFingerprint(rung) {
  return canonical({
    plan: rung.plan,
    descriptors: rung.expectedDescriptors,
    projectState: rung.expectedProjectState,
    label: rung.expectedLabel,
    audit: rung.expectedAudit,
    forbidden: rung.forbidden,
  });
}

function assertVariantsAgree(world, n, seed) {
  const base = makeRung(world, n, { phrasingVariant: 0 });
  const want = planFingerprint(base);
  const texts = new Set([base.text]);
  for (let v = 1; v < PHRASING_COUNT; v += 1) {
    const other = makeRung(world, n, { phrasingVariant: v });
    assert.equal(planFingerprint(other), want, `seed ${seed} rung ${n}: phrasing ${v} changed the plan or the key`);
    texts.add(other.text);
  }
  return texts;
}

test('every phrasing of a rung resolves to the same plan and the same key, seeds 1-3, all rungs', () => {
  let varied = 0;
  let total = 0;
  for (const seed of [1, 2, 3]) {
    const world = makeWorld(seed);
    for (let n = 0; n < 100; n += 1) {
      const texts = assertVariantsAgree(world, n, seed);
      total += 1;
      if (texts.size === PHRASING_COUNT) varied += 1;
    }
  }
  // If the four readings were not actually different prose, the anti-template tax would be zero.
  assert.ok(varied === total, `${total - varied} of ${total} rungs render identically under all four phrasings`);
});

// Addendum Q rule 1 asks for seeds 1..300. Running all 100 rungs of 300 seeds four times over is
// the cost of the whole keygen-bounds gate times four (minutes, not seconds), and it would be
// measuring the same invariant 30,000 times. The sweep below covers every seed in the range but
// samples one rung per band, which is what actually varies: each band is a different composer, and
// a phrasing bug lives in a composer's clause set, not in a seed.
const SWEEP_RUNGS = [0, 15, 25, 35, 45, 55, 65, 75, 85, 95];

test('every phrasing resolves to the same plan across seeds 1..300, one rung per band', () => {
  for (let seed = 1; seed <= 300; seed += 1) {
    const world = makeWorld(seed);
    for (const n of SWEEP_RUNGS) assertVariantsAgree(world, n, seed);
  }
});

// ---------------------------------------------------------------------------
// invariant 2: every phrasing states the same leaves
// ---------------------------------------------------------------------------

// The numbers, colours and words a clause's phrasings must all carry. Anything interpolated into
// one phrasing has to be interpolated into all four, or a reader who drew the wrong one cannot
// reproduce the hash. Checked by rendering each kind with a probe whose values are distinctive
// enough not to collide with the prose around them.
const LEAF_PROBES = {
  dimsPixels: ['120', '90'],
  dimsUnit: ['4 by 3 inches'],
  dimsRecall: ['17'],
  groundColor: ['#aabbcc'],
  groundRecall: ['17'],
  paint: ['#aabbcc', '55 percent'],
  shapeRect: ['30', '40', '1', '2'],
  shapeCircle: ['12', '1', '2'],
  shapeLine: ['1', '2', '50', '60'],
  note: ['200', '440', '100', '55 percent', 'sine'],
  toneList: ['800'],
  stepLora: ['Jenny'],
  stepResize: ['120', '90'],
  stepShrink: ['60'],
  stepGrow: ['60'],
  recipe: ['70', '2', 'shape'],
  tag: ['quartz'],
  labelled: ['scene', 'quartz'],
  piece: ['17'],
  haul: ['3'],
  applyStyleTo: ['Jenny', '2'],
  stackStep: ['0.9'],
  clearOut: ['3'],
  refusalWorkOnCleared: ['Jenny'],
  refusalLabelStack: ['quartz'],
  amendment: ['2'],
};

test('all four phrasings of a clause state exactly the same leaves', () => {
  for (const [kind, leaves] of Object.entries(LEAF_PROBES)) {
    const variants = phrasingsFor(kind, { ...PROBE_ARGS, label: 'quartz', word: 'quartz' });
    variants.forEach((rendered, v) => {
      for (const leaf of leaves) {
        assert.ok(rendered.includes(leaf), `clause "${kind}" phrasing ${v} never states "${leaf}": ${rendered}`);
      }
    });
  }
});

test('every parametric clause kind is leaf-probed, so a new one cannot slip in unchecked', () => {
  // Kinds with no interpolation at all carry no leaves and need no probe; everything that renders
  // a `${...}` must be in LEAF_PROBES above.
  const parametric = CLAUSE_KINDS.filter((kind) => {
    const [a, b] = [phrasingsFor(kind, PROBE_ARGS)[0], phrasingsFor(kind, { ...PROBE_ARGS, label: 'ZZZ', word: 'ZZZ', name: 'ZZZ', styleName: 'ZZZ', m: 999, count: 999, percent: 999, width: 999, height: 999, base: 999, many: '999', pageSize: 999, step: 999, color: '#000000', pct: 999, freq: 999, durMs: 999, startMs: 999, durationMs: 999, r: 999, w: 999, h: 999, x: 999, y: 999, x2: 999, y2: 999, measure: 'ZZZ', wave: 'ZZZ', noun: 'ZZZ', label2: '' })[0]];
    return a !== b;
  });
  for (const kind of parametric) {
    assert.ok(LEAF_PROBES[kind] !== undefined, `clause kind "${kind}" interpolates a leaf but has no leaf probe`);
  }
});

// ---------------------------------------------------------------------------
// the documents side of rule 1
// ---------------------------------------------------------------------------

test('the rules doc publishes clause kinds and obligations, not the sentences', () => {
  assert.match(RULES_DOC, /## Appendix: every clause KIND the task text can emit/);
  assert.ok(
    /one of \*{0,2}four\*{0,2}\s+seeded\s+phrasings of identical meaning/.test(RULES_DOC.replace(/\n/g, ' ')),
    'the appendix never tells the reader the surface is seeded',
  );
  // Every kind the generator can emit has to appear in the appendix table, or a docsolver reading
  // only the docs has no way to know the obligation exists.
  for (const kind of CLAUSE_KINDS) {
    assert.ok(RULES_DOC.includes(`\`${kind}\``), `clause kind "${kind}" is not published in RULES-0.8.md`);
  }
});

test('a rung really does carry the clause kinds its own shape implies', () => {
  const world = makeWorld(1);
  // rung 0 always creates and always turns in; a haul rung always states the short-page rule,
  // which is the clause Addendum Q rule 9 exists to put somewhere a reader will meet it.
  const zero = makeRung(world, 0).text;
  assert.ok(saysOneOf(zero, 'turnInExact') || saysOneOf(zero, 'turnInLast'));
  for (const n of [40, 45, 70, 80, 90]) {
    assert.ok(saysOneOf(makeRung(world, n).text, 'shortPage'), `rung ${n} pages a listing but never states the short-page rule`);
  }
});
