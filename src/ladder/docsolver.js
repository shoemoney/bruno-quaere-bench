// docsolver.js -- Addendum I rule 4: a doc-only solver that gates every rung.
//
// Clean room. This file was written without reading src/ladder/grammar.js,
// src/ladder/rung.js or src/ladder/reference.js. solve() computes a rung's expected
// descriptor from:
//   - docs/RULES-0.7.md (the enumerated house rules the key is allowed to depend on)
//   - docs/ARCHITECTURE.md (descriptor shapes; Addendum Q is the 0.7.0 spec)
//   - the generated skill (`quaere skill`, clean and sloppy) and `truthTable(world)`
//   - the generated OpenAPI document (`quaere spec`)
//   - the rung's own plain-language text, observed the way a climbing agent observes it:
//     `node bin/quaere.js rung --seed N --n K`, never `--answer`
//   - black-box observation of the live API, which is what the climbing agent has
//
// solve() imports nothing from grammar.js, rung.js or media.js internals: every unit
// conversion, grid rounding, percent resize, opacity compounding, diff, stitch and
// z-order decision below is this file's own reading of the documents. Re-running the
// generator's own arithmetic would make the gate blind exactly where the reference gate
// already is (Addendum G's float bug, Addendum I's hidden Math.round).
//
// WHAT CHANGED IN 0.7.0 (Addendum Q). Through 0.6.0 the RULES appendix published the
// closed set of SENTENCES the task text could emit, and this file parsed rung text with
// literal-string regexes. Rule 1 of Addendum Q deletes that: the appendix now publishes
// the closed set of clause KINDS and the OBLIGATION each one carries, and every clause
// renders as one of four seeded phrasings of identical meaning. So this file is now
// organised as a table of clause kinds -- `CLAUSES` below -- each with the phrasings that
// state it and one extractor that turns any of them into the same leaves. Nothing
// downstream of `parseClause` can tell which phrasing was drawn, which is the invariant
// `test/phrasing.test.js` pins from the generator side and `docsolver.test.js` pins here.
//
// The parse is a LOOP, not a fixed sequence: at every position the clause table is tried
// in order and the first kind that matches consumes its text. A position where no kind
// matches is a DocSolveError naming the residue -- rule 36 and the RULES appendix both
// require this file to fail loudly on an unrecognised clause rather than guess.
//
// Four things cross the clean-room boundary, all by injection and all only inside gate():
//
//   1. opts.colorOracle -- what a hueShift/invert lora does to a colour. The skill names
//      only the SPACE ("color math is done in HSL"/"HSV"); the channel-rounding
//      convention at an exact .5 tie is stated in no document, and the agent never
//      computes it by hand -- it POSTs to /{assets}/{id}/lora and reads the answer.
//      gate() therefore asks the house (makeColorOracle), the way the agent does.
//      shiftHue()/invertHex() below stay as the offline fallback; they agree with the
//      house on all but a handful of exact ties per thousand colours.
//   2. opts.listProjectAssets -- the seeded workspace/project inventory a batch rung
//      works through. It is server state, not a document; the agent pages the listing
//      over HTTP. gate() reads it from the API's own store, never from the ladder.
//   3. opts.history -- what THIS solver turned in at each earlier rung, which is how a
//      cross-rung reference ("as wide and as tall as the piece you turned in at step 18",
//      RULES-0.7 rule 21) is resolved. It is the solver's own memory, never the
//      generator's: gate() fills it from solve()'s own earlier answers, exactly as the
//      climbing agent reads back its own collection on disk.
//   4. `rulesAt` from ../world.js -- NOT from the ladder. RULES-0.7 rule 33 lets the house
//      amend one numbered rule at an announced rung, and world.js's own comment names the
//      four callers that must resolve rules through that one function ("the answer key
//      calls it, the reference calls it, the docsolver has to call it, and the house has
//      to call it -- if any of the four resolve the rules another way the ladder is
//      ungradeable"). A ladder-local reimplementation would be a fifth copy, which is the
//      bug that rule exists to prevent. Everything else about an amendment -- which rungs
//      announce one, how the announcement reads, what the amended rule then does to the
//      arithmetic -- is this file's own reading of rule 33.
//
// Announced mutations (rules 26/27) never change the artifact, only the shape of the
// replies on the way there, so the warning clause is parsed and consumed and has no
// effect on the descriptor. That IS the documented rule.
//
// The graded answer is five things, not one, and gate() compares all five:
//
//   descriptors            the pieces to turn in (rules 1-22)
//   expectedProjectState   how far through the house stages the text drives the project
//   expectedLabel          the word a conditional write puts on the LAST piece (rules 25, 29)
//   expectedAudit          the ordered stage sequence and the canonical signing string,
//                          Addendum Q rule 10 -- the path is graded, not just the terminus
//   forbidden              Addendum Q rule 7 / RULES-0.7 rule 36: an act the text asks for
//                          that a numbered rule forbids. The act must NOT be performed and
//                          what is graded is its ABSENCE, so it is part of the answer.
//
// solveGraded(world, rungText, n, opts) -> {descriptors, expectedProjectState,
//                                           expectedLabel, expectedAudit, forbidden}
// solve(world, rungText, n, opts)       -> Descriptor[]
// gate(world, from, to, opts)           -> {agree: n[], disagree: [{n, leaf, doc, key}]}

import { canonical } from '../canon.js';
import { rulesAt } from '../world.js';

export class DocSolveError extends Error {
  constructor(message, phrase) {
    super(message);
    this.name = 'DocSolveError';
    this.phrase = phrase;
  }
}

const fail = (message, phrase) => {
  throw new DocSolveError(`${message}${phrase === undefined ? '' : `: ${JSON.stringify(phrase)}`}`, phrase);
};

// ---------------------------------------------------------------------------
// House arithmetic (RULES-0.7 rules 1-6), resolved through the rules in force
// ---------------------------------------------------------------------------

// Rule 2: snap the raw product to 6 decimals before any rounding rule runs.
export function snap6(value) {
  return Math.round(value * 1e6) / 1e6;
}

// Rule 1: inches multiply by dpi, centimetres divide by 2.54 first, points by 72 first.
const PX_PER_UNIT = {
  in: (value, dpi) => value * dpi,
  cm: (value, dpi) => (value / 2.54) * dpi,
  pt: (value, dpi) => (value / 72) * dpi,
};

export function pxFromUnit(value, unit, dpi) {
  if (unit === 'px') return value;
  const f = PX_PER_UNIT[unit];
  if (f === undefined) fail('unknown house unit', unit);
  return snap6(f(value, dpi));
}

// Rule 3: every stored size is rounded onto the house grid, house direction. Rule 33 may
// have amended either the step or the direction by the rung being solved; `w` here is
// always the rules-in-force world, never the pristine one.
export function roundToGrid(value, roundTo, roundMode) {
  const v = snap6(value);
  const q = v / roundTo;
  if (roundMode === 'up') return Math.ceil(q) * roundTo;
  if (roundMode === 'down') return Math.floor(q) * roundTo;
  if (roundMode === 'nearest') return Math.round(q) * roundTo;
  return fail('unknown rounding direction', roundMode);
}

const grid = (w, value) => roundToGrid(value, w.rules.roundTo, w.rules.roundMode);

// THE ONE RULE THIS SOLVER USES THAT docs/RULES-0.7.md DOES NOT STATE.
//
// Rule 13 says a house style that scales "re-rounds every shape figure onto the house
// grid as it goes, the same grid rule as rule 3", and rule 2 says the six-decimal snap
// happens "before any rounding happens". Read together, a doc-only agent snaps first.
// The live house does not: inside a scale lora it grids the RAW product, so a figure
// that lands an ulp off a grid line goes the other way. Concretely, seed 10 (roundTo 2,
// direction up) turns 75 x 1.36 = 102.00000000000001 into 104, where snapping first
// gives 102; seed 5 (roundTo 16, nearest) turns 200 x 1.16 = 231.99999999999997 into
// 224, where snapping first gives 240.
//
// Nine rungs on seeds 1-20 are decided by this, so it is an Addendum I class gap: a key
// that turns on a rule absent from the RULES file. It is survivable for a climbing agent
// only because the agent POSTs to /{assets}/{id}/lora and reads the geometry back rather
// than computing it, the same way it reads a hue shift back. The fix belongs upstream --
// either media.js snaps inside the scale lora, or RULES-0.7.md states that it does not.
// Until then this function models the house, and `gridAfterScale is load-bearing` in the
// test pins it so nobody deletes it without reading this.
export function gridAfterScale(w, value) {
  const { roundTo, roundMode } = w.rules;
  const q = value / roundTo;
  if (roundMode === 'up') return Math.ceil(q) * roundTo;
  if (roundMode === 'down') return Math.floor(q) * roundTo;
  return Math.round(q) * roundTo;
}

// Rule 5 + rule 20: percent resize is size x percent / 100, snapped, then gridded, floored
// at one whole grid step (Addendum M rebaselined rule 5's floor from bare `1` to `roundTo`:
// a floor of 1 is not itself on the grid whenever roundTo > 1, so the very next grid pass
// rule 3 requires would round it straight back down to 0). A derived percentage goes
// through exactly the same arithmetic as a stated one.
function percentTarget(w, size, pct) {
  return Math.max(w.rules.roundTo, grid(w, snap6((size * pct) / 100)));
}

// ---------------------------------------------------------------------------
// Colour math (skill: "Color math (hue shifts and the like) is done in HSL/HSV space")
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) fail('not a hex colour', hex);
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function rgbToHex([r, g, b]) {
  const c = (x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function hueDegrees(r, g, b, max, d) {
  if (d === 0) return 0;
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return h * 60;
}

function hue2rgb(p, q, t) {
  let u = t;
  if (u < 0) u += 1;
  if (u > 1) u -= 1;
  if (u < 1 / 6) return p + (q - p) * 6 * u;
  if (u < 1 / 2) return q;
  if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
  return p;
}

// Pure, document-derived hue rotation. The skill states only the SPACE; it does not
// state the channel-rounding convention, so this agrees with the live house everywhere
// except a handful of exact .5 ties per thousand colours. gate() therefore resolves
// hueShift/invert through a colour oracle (see makeColorOracle); this is the fallback.
function shiftHue(hex, degrees, space) {
  const [r8, g8, b8] = hexToRgb(hex);
  const r = r8 / 255;
  const g = g8 / 255;
  const b = b8 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const H = (((hueDegrees(r, g, b, max, d) + degrees) % 360) + 360) % 360;
  if (space === 'hsv') {
    const v = max;
    const s = max === 0 ? 0 : d / max;
    const c = v * s;
    const x = c * (1 - Math.abs(((H / 60) % 2) - 1));
    const m = v - c;
    const i = Math.floor(H / 60) % 6;
    return rgbToHex([[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][i].map((z) => (z + m) * 255));
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (s === 0) return rgbToHex([l * 255, l * 255, l * 255]);
  const h = H / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return rgbToHex([hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255]);
}

function invertHex(hex) {
  return rgbToHex(hexToRgb(hex).map((v) => 255 - v));
}

// ---------------------------------------------------------------------------
// Descriptor operations, as the documents describe them
// ---------------------------------------------------------------------------

const clone = (d) => JSON.parse(JSON.stringify(d));

const GEOM = ['x', 'y', 'w', 'h', 'r', 'x2', 'y2'];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Rule 6: horizontal figures by the width ratio, vertical by the height ratio, a radius
// by the average of the two, each rounded to the nearest whole pixel.
function resizeImage(desc, targetW, targetH) {
  const sx = targetW / desc.width;
  const sy = targetH / desc.height;
  const sr = (sx + sy) / 2;
  const out = clone(desc);
  out.width = targetW;
  out.height = targetH;
  out.shapes = desc.shapes.map((shape) => {
    const s = clone(shape);
    for (const key of ['x', 'w', 'x2']) if (s[key] !== undefined) s[key] = Math.round(shape[key] * sx);
    for (const key of ['y', 'h', 'y2']) if (s[key] !== undefined) s[key] = Math.round(shape[key] * sy);
    if (s.r !== undefined) s.r = Math.round(shape.r * sr);
    return s;
  });
  return out;
}

// Rule 12/13: a house style shifts hue, scales, changes solidity or inverts; a style
// that scales re-rounds every shape figure onto the house grid as it goes.
function applyLora(w, desc, lora, ctx = {}) {
  if (desc.kind !== 'image') fail('a house style was asked for on something that is not a picture', desc.kind);
  const out = clone(desc);
  const oracle = ctx.colorOracle;
  const recoloured = (lora.op === 'hueShift' || lora.op === 'invert') && typeof oracle === 'function'
    ? oracle(lora, desc.shapes.map((s) => s.color))
    : null;
  out.shapes = desc.shapes.map((shape, i) => {
    const s = clone(shape);
    if (lora.op === 'hueShift') s.color = recoloured ? recoloured[i] : shiftHue(shape.color, lora.amount, w.rules.colorShiftSpace);
    else if (lora.op === 'invert') s.color = recoloured ? recoloured[i] : invertHex(shape.color);
    else if (lora.op === 'opacity') s.opacity = shape.opacity * lora.amount;
    else if (lora.op === 'scale') {
      for (const key of GEOM) if (s[key] !== undefined) s[key] = gridAfterScale(w, shape[key] * lora.amount);
    } else fail('unknown lora op', lora.op);
    return s;
  });
  out.lora = { id: lora.id, applied: true };
  return out;
}

// Rule 10: stacking keeps the first one's canvas and ground and appends every later
// one's shapes on top in the order given, fading the i-th layer by the house's own
// compounding rule -- base * step**i (multiplicative) or base - step*i (additive),
// clamped between nothing and fully solid. Rule 33 may have amended which of the two.
function combineLayer(w, descs, step) {
  if (descs.length === 0) fail('stacking with nothing to stack');
  const out = clone(descs[0]);
  delete out.lora;
  const shapes = [];
  descs.forEach((d, i) => {
    for (const shape of d.shapes) {
      const s = clone(shape);
      if (step !== undefined) {
        s.opacity = clamp01(w.rules.opacityCompound === 'multiplicative'
          ? shape.opacity * Math.pow(step, i)
          : shape.opacity - step * i);
      }
      shapes.push(s);
    }
  });
  if (w.rules.zOrder === 'explicit') shapes.forEach((s, i) => { s.z = i; });
  out.shapes = shapes;
  return out;
}

// Rule 11: the shapes the first has that the second does not, on the first one's canvas,
// keeping the first one's ground. Two shapes are the same when every figure matches;
// stacking order is not part of that.
function diffImages(a, b) {
  const inB = new Set(b.shapes.map((s) => canonical(shapeIdentity(s))));
  const out = clone(a);
  delete out.lora;
  out.shapes = a.shapes.filter((s) => !inB.has(canonical(shapeIdentity(s)))).map(clone);
  return out;
}

function shapeIdentity(shape) {
  const s = { ...shape };
  delete s.z;
  return s;
}

// Rule 15: the tones the first has that the second does not, keeping the first one's
// length and sample rate. Two tones are the same when pitch, start, length, loudness
// and shape all match.
function diffAudio(a, b) {
  const inB = new Set(b.notes.map((t) => canonical(t)));
  const out = clone(a);
  out.notes = a.notes.filter((t) => !inB.has(canonical(t))).map(clone);
  return out;
}

// Rules 16 + 17: stitching runs the clips one after another, the stitched length is the
// sum, the stitched clip keeps the first one's size and frame rate; a clip's frame count
// is length in seconds times frame rate, rounded to the nearest whole frame.
function stitchClips(w, clips) {
  if (clips.length === 0) fail('stitching with nothing to stitch');
  const fps = clips[0].fps;
  let cursor = 0;
  const out = {
    kind: 'video',
    format: w.rules.defaultFormat.video,
    width: clips[0].width,
    height: clips[0].height,
    fps,
    durationMs: 0,
    clips: [],
  };
  for (const clip of clips) {
    for (const c of clip.clips) out.clips.push({ ...clone(c), startMs: c.startMs + cursor });
    cursor += clip.durationMs;
  }
  out.durationMs = cursor;
  return out;
}

function frameCount(desc) {
  return Math.round((desc.durationMs / 1000) * desc.fps);
}

// ---------------------------------------------------------------------------
// The clause table: kinds, phrasings, obligations (Addendum Q rule 1)
// ---------------------------------------------------------------------------
//
// Every entry below is one KIND from the RULES-0.7 appendix. `says` is the list of
// phrasings that state it -- four of them wherever the generator paraphrases, one where
// it does not -- and every phrasing in a list must yield the same leaves through the same
// extractor. Nothing outside `parseClause` ever sees which phrasing matched.

const NUM = String.raw`-?\d+(?:\.\d+)?`;
const HEX = String.raw`#[0-9a-fA-F]{6}`;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A cursor over the task text. `eat` anchors at the current position; `mark`/`reset` let
// a composed clause back out cleanly when one of its later components does not match.
class Cursor {
  constructor(text) { this.text = text.trim(); this.i = 0; }
  rest() { return this.text.slice(this.i); }
  mark() { return this.i; }
  reset(i) { this.i = i; }
  eat(source, eatSpace = true) {
    const src = source instanceof RegExp ? source.source : source;
    const m = new RegExp(`^(?:${src})`, 's').exec(this.rest());
    if (m === null) return null;
    this.i += m[0].length;
    if (eatSpace) {
      const ws = /^\s+/.exec(this.rest());
      if (ws !== null) this.i += ws[0].length;
    }
    return m;
  }
  atEnd() { return this.rest().trim() === ''; }
}

// Try each phrasing of a kind in order; the first that matches wins and its extractor
// turns the match into the kind's leaves. Returns undefined when the kind is not stated
// here at all, which is how an optional clause reports its absence.
function saysOneOf(c, phrasings, eatSpace = true) {
  for (const [source, extract] of phrasings) {
    const at = c.mark();
    const m = c.eat(source, eatSpace);
    if (m === null) { c.reset(at); continue; }
    const value = extract === undefined ? {} : extract(m);
    if (value === undefined) { c.reset(at); continue; }
    return value;
  }
  return undefined;
}

// A kind with no leaves at all -- a note whose whole obligation is "this is true, carry
// on". Consumed and dropped.
const note = (...sources) => sources.map((s) => [s, () => ({})]);

// --- cross-rung reference: `piece` (rule 21) --------------------------------
const PIECE = [
  'the piece you turned in at step (\\d+)',
  'the piece you handed in at step (\\d+)',
  'whatever you turned in back at step (\\d+)',
  'the piece that was your answer to step (\\d+)',
];
const PIECE_ALT = `(?:${PIECE.join('|')})`;
// Whichever of the four matched, the step number is the only leaf, and exactly one of the
// four groups is defined.
const stepOf = (m, first) => {
  for (let i = first; i < first + PIECE.length; i += 1) if (m[i] !== undefined) return Number(m[i]);
  return fail('a cross-rung reference with no step number', m[0]);
};

// --- `labelled`: a workspace or project named by its display name, never an id --------
const LABELLED = [
  '\\w+ the house calls "([^"]+)"',
  '\\w+ that goes by "([^"]+)" in the house\'s own listing',
  '\\w+ listed by the house as "([^"]+)"',
  '\\w+ the house has written down as "([^"]+)"',
];
const LABELLED_ALT = `(?:${LABELLED.join('|')})`;
const nameOf = (m, first) => {
  for (let i = first; i < first + LABELLED.length; i += 1) if (m[i] !== undefined) return m[i];
  return fail('a labelled thing with no display name', m[0]);
};

// --- `dimsPixels` / `dimsUnit` / `dimsRecall` -------------------------------
function unitAlternation(w) {
  const entries = [];
  for (const [unit, words] of Object.entries(w.rules.unitWords)) {
    for (const word of words) entries.push([word, unit === 'inch' ? 'in' : unit]);
  }
  entries.sort((a, b) => b[0].length - a[0].length);
  return { pattern: entries.map(([word]) => esc(word)).join('|'), lookup: new Map(entries) };
}

// The four ways the task says "and those two numbers are exact", all meaning nothing.
const UNIT_TAIL = '(?: exactly| on the nose| as measured)?';

function dimsPhrasings(units) {
  const U = units.pattern;
  return [
    // dimsUnit (rule 1): the two numbers are in a named house unit.
    [`(${NUM}) by (${NUM}) ?(${U})${UNIT_TAIL}(?=[,;])`,
      (m) => ({ kind: 'unit', w: +m[1], h: +m[2], unit: units.lookup.get(m[3]) })],
    // dimsPixels: four phrasings, same two leaves.
    [`(${NUM}) by (${NUM}) pixels`, (m) => ({ kind: 'px', w: +m[1], h: +m[2] })],
    [`(${NUM}) by (${NUM}), counted in pixels`, (m) => ({ kind: 'px', w: +m[1], h: +m[2] })],
    [`(${NUM}) wide by (${NUM}) tall, in pixels`, (m) => ({ kind: 'px', w: +m[1], h: +m[2] })],
    [`(${NUM}) pixels across and (${NUM}) pixels down`, (m) => ({ kind: 'px', w: +m[1], h: +m[2] })],
    // dimsRecall (rule 21): no size is stated at all.
    [`as wide and as tall as ${PIECE_ALT}`, (m) => ({ kind: 'recall', step: stepOf(m, 1) })],
    [`sized to match ${PIECE_ALT}, across and down`, (m) => ({ kind: 'recall', step: stepOf(m, 1) })],
    [`exactly as big as ${PIECE_ALT}, both ways`, (m) => ({ kind: 'recall', step: stepOf(m, 1) })],
    [`matching ${PIECE_ALT} across and matching it down as well`, (m) => ({ kind: 'recall', step: stepOf(m, 1) })],
  ];
}

// --- `groundColor` / `groundClear` / `groundRecall` --------------------------
const GROUND = [
  [`, on a ground of (${HEX})`, (m) => ({ kind: 'hex', color: m[1].toLowerCase() })],
  [`, on a (${HEX}) ground`, (m) => ({ kind: 'hex', color: m[1].toLowerCase() })],
  [`, on a ground painted (${HEX})`, (m) => ({ kind: 'hex', color: m[1].toLowerCase() })],
  [`, on (${HEX}) underneath as the ground`, (m) => ({ kind: 'hex', color: m[1].toLowerCase() })],
  [`, on the same ground colour as ${PIECE_ALT}`, (m) => ({ kind: 'recall', step: stepOf(m, 1) })],
  [`, on whatever ground colour ${PIECE_ALT} had`, (m) => ({ kind: 'recall', step: stepOf(m, 1) })],
  [`, on a ground in the colour ${PIECE_ALT} used`, (m) => ({ kind: 'recall', step: stepOf(m, 1) })],
  [`, on the ground colour you gave ${PIECE_ALT}`, (m) => ({ kind: 'recall', step: stepOf(m, 1) })],
  // groundClear: the house stores a see-through ground as `{transparent: true}`, never as
  // a colour (media.js rejects the two together). No 0.7.0 rung has drawn one on any gated
  // seed, but the kind is in the appendix, so it is parsed rather than left to fail.
  [', on a see-through ground', () => ({ kind: 'clear' })],
  [', on a ground you can see straight through', () => ({ kind: 'clear' })],
  [', on nothing behind it -- a see-through ground', () => ({ kind: 'clear' })],
  [', on a transparent, see-through ground', () => ({ kind: 'clear' })],
];

// --- `shapeList`: the ground, then what sits on it, bottom of the pile first ----
const SHAPE_INTRO = note(
  ', with these on it, the first one lowest in the pile: ',
  ', carrying these, bottom of the pile first: ',
  '; these sit on it, bottom of the pile first: ',
  ', holding the following, listed from the bottom of the pile up: ',
);

// --- `shapeCircle` / `shapeRect` / `shapeLine`, each with its own four phrasings ---
// Every phrasing of a kind captures its figures in the SAME order, so one extractor
// serves all four.
const SHAPE_GEOM = [
  [`a circle of radius (${NUM}) centred (${NUM}) from the left and (${NUM}) from the top`,
    (m) => ({ type: 'circle', r: +m[1], x: +m[2], y: +m[3] })],
  [`a circle, radius (${NUM}), centred at (${NUM}) from the left and (${NUM}) from the top`,
    (m) => ({ type: 'circle', r: +m[1], x: +m[2], y: +m[3] })],
  [`a circle whose radius is (${NUM}), its centre (${NUM}) in from the left and (${NUM}) down from the top`,
    (m) => ({ type: 'circle', r: +m[1], x: +m[2], y: +m[3] })],
  [`a round one of radius (${NUM}) with its centre (${NUM}) from the left edge and (${NUM}) from the top edge`,
    (m) => ({ type: 'circle', r: +m[1], x: +m[2], y: +m[3] })],
  [`a rectangle (${NUM}) across and (${NUM}) down, its top-left corner (${NUM}) from the left and (${NUM}) from the top`,
    (m) => ({ type: 'rect', w: +m[1], h: +m[2], x: +m[3], y: +m[4] })],
  [`a rectangle, (${NUM}) wide and (${NUM}) high, with its top-left corner sitting (${NUM}) from the left edge and (${NUM}) from the top`,
    (m) => ({ type: 'rect', w: +m[1], h: +m[2], x: +m[3], y: +m[4] })],
  [`a rectangle measuring (${NUM}) left to right and (${NUM}) top to bottom, anchored at its top-left corner (${NUM}) from the left and (${NUM}) from the top`,
    (m) => ({ type: 'rect', w: +m[1], h: +m[2], x: +m[3], y: +m[4] })],
  [`a (${NUM}) by (${NUM}) rectangle \\(across first\\), placed with its top-left corner (${NUM}) in from the left and (${NUM}) down from the top`,
    (m) => ({ type: 'rect', w: +m[1], h: +m[2], x: +m[3], y: +m[4] })],
  [`a line running from \\((${NUM}), (${NUM})\\) to \\((${NUM}), (${NUM})\\), counting from the top-left corner`,
    (m) => ({ type: 'line', x: +m[1], y: +m[2], x2: +m[3], y2: +m[4] })],
  [`a line drawn from \\((${NUM}), (${NUM})\\) across to \\((${NUM}), (${NUM})\\), both measured from the top-left corner`,
    (m) => ({ type: 'line', x: +m[1], y: +m[2], x2: +m[3], y2: +m[4] })],
  [`a line whose ends are \\((${NUM}), (${NUM})\\) and \\((${NUM}), (${NUM})\\), measured from the top-left corner`,
    (m) => ({ type: 'line', x: +m[1], y: +m[2], x2: +m[3], y2: +m[4] })],
  [`a straight line between \\((${NUM}), (${NUM})\\) and \\((${NUM}), (${NUM})\\), counted from the top-left corner`,
    (m) => ({ type: 'line', x: +m[1], y: +m[2], x2: +m[3], y2: +m[4] })],
];

// --- `paint`: the shape's colour and its solidity as a percentage ------------
const PAINT = [
  [`, painted (${HEX}) at (${NUM}) percent solid`, (m) => ({ color: m[1].toLowerCase(), opacity: +m[2] / 100 })],
  [`, in (${HEX}), (${NUM}) percent solid`, (m) => ({ color: m[1].toLowerCase(), opacity: +m[2] / 100 })],
  [`, coloured (${HEX}) and (${NUM}) percent solid`, (m) => ({ color: m[1].toLowerCase(), opacity: +m[2] / 100 })],
  [`, painted (${HEX}), its solidity (${NUM}) percent`, (m) => ({ color: m[1].toLowerCase(), opacity: +m[2] / 100 })],
];

// --- `note` (a tone): pitch, start, length, loudness, shape ------------------
const WAVE = '(sine|saw|square|triangle)';
const TONE = [
  [`a ${WAVE}-shaped tone of (${NUM}) hertz, (${NUM}) ms long, starting (${NUM}) ms in, (${NUM}) percent loud`,
    (m) => ({ freq: +m[2], durMs: +m[3], startMs: +m[4], amp: +m[5] / 100, wave: m[1] })],
  [`(${NUM}) hertz for (${NUM}) ms, beginning (${NUM}) ms in, at (${NUM}) percent loud, ${WAVE}-shaped`,
    (m) => ({ freq: +m[1], durMs: +m[2], startMs: +m[3], amp: +m[4] / 100, wave: m[5] })],
  [`(${NUM}) ms of (${NUM}) hertz starting (${NUM}) ms in, (${NUM}) percent loud, ${WAVE}-shaped`,
    (m) => ({ freq: +m[2], durMs: +m[1], startMs: +m[3], amp: +m[4] / 100, wave: m[5] })],
  [`starting (${NUM}) ms in: (${NUM}) ms of (${NUM}) hertz, ${WAVE}-shaped, (${NUM}) percent loud`,
    (m) => ({ freq: +m[3], durMs: +m[2], startMs: +m[1], amp: +m[5] / 100, wave: m[4] })],
];

// --- `createAudio`: the whole length, then the tones in order ----------------
const AUDIO_NOUN = '(?:a short sound clip|a short sound|one short sound,|a brief sound)';
const AUDIO_BODY = [
  [` running (${NUM}) ms end to end and carrying these tones in order: `, (m) => ({ durationMs: +m[1] })],
  [` whose whole length is (${NUM}) ms, carrying the following tones in order: `, (m) => ({ durationMs: +m[1] })],
  [` (${NUM}) ms long end to end, holding these tones in this order: `, (m) => ({ durationMs: +m[1] })],
  [` that runs (${NUM}) ms from start to finish and carries these tones, in order: `, (m) => ({ durationMs: +m[1] })],
];

// --- `chainIntro`: what follows is an ordered list ---------------------------
const CHAIN_INTRO = note(
  'Then, in this order: ',
  'Then do the following, in this order: ',
  'After that, in exactly this order: ',
  'Then work through these in order: ',
);

// --- `recipe` (rules 18, 19): start at B and take P off for every X ----------
// The five things X can be are rule 19's closed list; the recipe wrapper is paraphrased
// four ways and the count phrase is not.
const COUNT_PHRASES = [
  ['shape left on that leftover piece', 'leftoverShapes'],
  ['shape on the stack you just built', 'stackShapes'],
  ['tone left over when you took the second sound out of the first', 'leftoverTones'],
  ['frame in the stitched clip', 'stitchedFrames'],
  ['copy of yours still standing in that listing once the cleared-out ones are left out', 'standingCopies'],
];
const COUNT_ALT = `(?:${COUNT_PHRASES.map(([text]) => esc(text)).join('|')})`;
const countKeyOf = (phrase) => {
  for (const [text, key] of COUNT_PHRASES) if (text === phrase) return key;
  return fail('unknown thing to count in a derived percentage', phrase);
};

const RECIPE = [
  [`start at (${NUM}) and take (${NUM}) off for every (${COUNT_ALT})`, (m) => ({ base: +m[1], per: +m[2], what: m[3] })],
  [`(${NUM}) to begin with, less (${NUM}) for every (${COUNT_ALT})`, (m) => ({ base: +m[1], per: +m[2], what: m[3] })],
  [`begin from (${NUM}), subtracting (${NUM}) for each (${COUNT_ALT})`, (m) => ({ base: +m[1], per: +m[2], what: m[3] })],
  [`take (${NUM}), then knock (${NUM}) off it for each (${COUNT_ALT})`, (m) => ({ base: +m[1], per: +m[2], what: m[3] })],
];
const RECIPE_ALT = `(?:${RECIPE.map(([src]) => src).join('|')})`;
// The four recipe phrasings each capture (base, per, what) in that order, so whichever
// three of the twelve groups are defined are the leaves.
const recipeOf = (m, first) => {
  for (let i = first; i < first + RECIPE.length * 3; i += 3) {
    if (m[i] !== undefined) return { base: +m[i], per: +m[i + 1], what: m[i + 2] };
  }
  return fail('a derived percentage with no recipe', m[0]);
};

const SAVED_AS = '(?:, saved as an? (vector|bitmap) file)?';
const FORMAT_WORDS = { vector: 'svg', bitmap: 'png' };
const AUDIO_FORMAT_WORDS = { 'plain wave audio': 'wav', 'the compact house audio flavor': 'qa8' };
const AUDIO_FORMAT_ALT = '(plain wave audio|the compact house audio flavor)';

// --- the chain steps --------------------------------------------------------
// Each entry is one step KIND; the four phrasings of a kind extract identically.
const STEPS = [
  // stepLora (rules 12, 13)
  ['look up the house style called "([^"]+)" and give what you have that look', (m) => ({ op: 'lora', name: m[1] })],
  ['look the house style called "([^"]+)" up and put it on what you have', (m) => ({ op: 'lora', name: m[1] })],
  ['find the house style called "([^"]+)" in the house\'s own library and apply it to what you have', (m) => ({ op: 'lora', name: m[1] })],
  ['give what you have the look of the house style called "([^"]+)", which you will have to look up', (m) => ({ op: 'lora', name: m[1] })],

  // stepDerivedShrink / stepDerivedGrow (rules 18, 19, 20) -- tried BEFORE the stated
  // percent steps, because "shrink what you have down to a percentage ..." shares a
  // prefix with "shrink what you have down to 81 percent ...".
  [`shrink what you have down to a percentage of its own size you have to work out like this -- ${RECIPE_ALT} -- keeping its shape the same${SAVED_AS}`,
    (m) => ({ op: 'resizePctDerived', recipe: recipeOf(m, 1), saved: m[m.length - 1] })],
  [`reduce what you have to a percentage of its own size you must derive -- ${RECIPE_ALT} -- holding its proportions${SAVED_AS}`,
    (m) => ({ op: 'resizePctDerived', recipe: recipeOf(m, 1), saved: m[m.length - 1] })],
  [`shrink what you have to a percentage of its own size that is not written here: work it out as ${RECIPE_ALT}, and keep the shape${SAVED_AS}`,
    (m) => ({ op: 'resizePctDerived', recipe: recipeOf(m, 1), saved: m[m.length - 1] })],
  [`work out a percentage like this: ${RECIPE_ALT}; then shrink what you have to that percentage of its own size, shape unchanged${SAVED_AS}`,
    (m) => ({ op: 'resizePctDerived', recipe: recipeOf(m, 1), saved: m[m.length - 1] })],
  [`blow what you have up to a percentage of its own size you have to work out like this -- ${RECIPE_ALT} -- keeping its shape the same${SAVED_AS}`,
    (m) => ({ op: 'resizePctDerived', recipe: recipeOf(m, 1), saved: m[m.length - 1] })],
  [`grow what you have to a percentage of its own size you must derive -- ${RECIPE_ALT} -- holding its proportions${SAVED_AS}`,
    (m) => ({ op: 'resizePctDerived', recipe: recipeOf(m, 1), saved: m[m.length - 1] })],
  [`enlarge what you have to a percentage of its own size that is not written here: work it out as ${RECIPE_ALT}, and keep the shape${SAVED_AS}`,
    (m) => ({ op: 'resizePctDerived', recipe: recipeOf(m, 1), saved: m[m.length - 1] })],
  [`work out a percentage like this: ${RECIPE_ALT}; then blow what you have up to that percentage of its own size, shape unchanged${SAVED_AS}`,
    (m) => ({ op: 'resizePctDerived', recipe: recipeOf(m, 1), saved: m[m.length - 1] })],

  // stepShrink / stepGrow (rule 5)
  [`shrink what you have down to (${NUM}) percent of its own size, keeping its shape the same${SAVED_AS}`,
    (m) => ({ op: 'resizePct', pct: +m[1], saved: m[2] })],
  [`reduce what you have to (${NUM}) percent of the size it currently is, holding its proportions${SAVED_AS}`,
    (m) => ({ op: 'resizePct', pct: +m[1], saved: m[2] })],
  [`take what you have down to (${NUM}) percent of its own size, shape unchanged${SAVED_AS}`,
    (m) => ({ op: 'resizePct', pct: +m[1], saved: m[2] })],
  [`scale what you have down so it is (${NUM}) percent of its own size, same shape${SAVED_AS}`,
    (m) => ({ op: 'resizePct', pct: +m[1], saved: m[2] })],
  [`blow what you have up to (${NUM}) percent of its own size, keeping its shape the same${SAVED_AS}`,
    (m) => ({ op: 'resizePct', pct: +m[1], saved: m[2] })],
  [`enlarge what you have to (${NUM}) percent of its own size, shape unchanged${SAVED_AS}`,
    (m) => ({ op: 'resizePct', pct: +m[1], saved: m[2] })],
  [`take what you have up to (${NUM}) percent of the size it currently is, holding its proportions${SAVED_AS}`,
    (m) => ({ op: 'resizePct', pct: +m[1], saved: m[2] })],
  [`scale what you have up so it is (${NUM}) percent of its own size, same shape${SAVED_AS}`,
    (m) => ({ op: 'resizePct', pct: +m[1], saved: m[2] })],

  // stepResize (rules 3, 4, 6): a stated absolute pixel target
  [`resize what you have so it comes out (${NUM}) by (${NUM}) pixels${SAVED_AS}`,
    (m) => ({ op: 'resizeAbs', w: +m[1], h: +m[2], saved: m[3] })],
  [`bring what you have to exactly (${NUM}) by (${NUM}) pixels${SAVED_AS}`,
    (m) => ({ op: 'resizeAbs', w: +m[1], h: +m[2], saved: m[3] })],
  [`resize it to (${NUM}) pixels across by (${NUM}) pixels down${SAVED_AS}`,
    (m) => ({ op: 'resizeAbs', w: +m[1], h: +m[2], saved: m[3] })],
  [`size what you have to (${NUM}) by (${NUM}) pixels${SAVED_AS}`,
    (m) => ({ op: 'resizeAbs', w: +m[1], h: +m[2], saved: m[3] })],

  // stepSave: re-save in the named flavor; the size is untouched
  ['save what you have as an? (vector|bitmap) file', (m) => ({ op: 'save', word: m[1] })],
  ['keep what you have as an? (vector|bitmap) file', (m) => ({ op: 'save', word: m[1] })],
  ['store what you have in the form of an? (vector|bitmap) file', (m) => ({ op: 'save', word: m[1] })],
  ['write what you have out as an? (vector|bitmap) file', (m) => ({ op: 'save', word: m[1] })],

  // the sound equivalents (rule 14: neither re-encoding nor re-cutting changes the tones)
  [`re-encode it as ${AUDIO_FORMAT_ALT}`, (m) => ({ op: 'reencode', word: m[1] })],
  [`re-cut what you have to (${NUM}) samples a second`, (m) => ({ op: 'recut', rate: +m[1] })],
];

// ---------------------------------------------------------------------------
// solve
// ---------------------------------------------------------------------------

// Rule 21: a recalled property of the piece turned in at an earlier step. The value is
// never in the text; it is this solver's own memory of what it turned in.
function recall(opts, step, what) {
  const history = opts.history;
  if (history === undefined) {
    fail('a recalled value needs opts.history (what this solver turned in earlier)', `step ${step}`);
  }
  const prior = history instanceof Map ? history.get(step) : history[step];
  if (prior === undefined || prior === null) {
    fail('nothing remembered for the piece turned in at that step', `step ${step}`);
  }
  if (what === 'size') {
    if (prior.kind !== 'image') fail('the piece turned in at that step has no width or height', `step ${step} is ${prior.kind}`);
    return { width: prior.width, height: prior.height };
  }
  if (what === 'ground') {
    if (prior.background === undefined || prior.background.color === undefined) {
      fail('the piece turned in at that step has no ground colour', `step ${step}`);
    }
    return prior.background.color;
  }
  return fail('unknown recalled property', what);
}

// Addendum Q rule 10: the house records ordered stage transitions per project and the
// release notice is signed over a canonical string that binds a digest of the artifact
// being released (rule 35). Both are part of the answer from rung 50 up, and the
// canonical string's field order is itself amendable (rule 33), which is why it is read
// off the rules in force rather than off the pristine world.
// Addendum S / RULES-0.7 rule 38: `render:409` belongs in the stage sequence only when the
// task text itself carries the instructional stage-recovery sentence (clauseStageRecover,
// below) -- never merely because the project reaches `published`. The plan that actually
// produces the 409 is invisible to this file; the text is the only thing it may read.
const AUDIT_STAGES_BASE = ['draft', 'composed', 'rendering', 'rendered', 'published'];
const AUDIT_STAGES_RECOVER = ['draft', 'render:409', 'composed', 'rendering', 'rendered', 'published'];
const auditFor = (w, recover409) => ({
  stages: [...(recover409 ? AUDIT_STAGES_RECOVER : AUDIT_STAGES_BASE)],
  canonical: w.hmac.canon,
  bodyDigestOf: 'submittedAsset',
});

// RULES-0.7 rule 36: what a refusal clause asks for, and the numbered rule that forbids
// it. The gate compares these three leaves; the key's own `detail` is prose about the
// same fact and is not something a doc-only solver can or should reproduce word for word.
export function forbiddenSummary(forbidden) {
  if (forbidden === null || forbidden === undefined) return null;
  return {
    act: forbidden.act,
    rule: forbidden.rule,
    word: forbidden.word === undefined ? null : forbidden.word,
  };
}

export function solveGraded(world, rungText, n, opts = {}) {
  // Rule 33: the rules in force at THIS rung, amendments applied in order. Everything
  // below reads `w`, never `world`.
  const w = rulesAt(world, n);
  const units = unitAlternation(w);
  const dims = dimsPhrasings(units);
  const c = new Cursor(rungText);

  const state = {
    w,
    n,
    opts,
    units,
    dims,
    current: null,
    counts: {},
    projectState: null,
    label: null,
    forbidden: null,
    stageRecover409: false,
    stitched: false,
    stitchAntecedent: false,
    turnedIn: false,
    haul: null,
  };

  let guard = 0;
  while (!c.atEnd()) {
    if ((guard += 1) > 4000) fail('the clause loop is not advancing', c.rest().slice(0, 120));
    let matched = false;
    for (const clause of CLAUSE_ORDER) {
      const at = c.mark();
      if (clause(c, state) === true) { matched = true; break; }
      c.reset(at);
    }
    if (!matched) {
      fail('no clause kind in the RULES-0.7 appendix states this', c.rest().slice(0, 220));
    }
  }

  if (state.current === null) fail('task produced nothing to turn in', rungText.slice(0, 120));
  if (!state.turnedIn) fail('no turn-in clause', rungText.slice(-160));
  // Rule 28: a stitch rung must state the antecedent of the chain that follows it. THE
  // SOLVER NEVER INFERS IT -- on 0.5.0 three climbs read it the other way and lost rung
  // 60 with arithmetic that was 100 percent correct.
  if (state.stitched && !state.stitchAntecedent) {
    fail('a rung that stitches must state that the stitched piece is only there to be counted (rule 28)', rungText.slice(0, 160));
  }

  return {
    descriptors: [state.current],
    expectedProjectState: state.projectState,
    expectedLabel: state.label,
    expectedAudit: state.projectState === 'published' ? auditFor(w, state.stageRecover409) : null,
    forbidden: state.forbidden,
  };
}

// The descriptors alone, which is every caller that predates 0.6.0.
export function solve(world, rungText, n, opts = {}) {
  return solveGraded(world, rungText, n, opts).descriptors;
}

// ---------------------------------------------------------------------------
// The clause kinds, in the order the loop tries them
// ---------------------------------------------------------------------------

// --- `haul` (rule 32 scopes the count to this rung's own copies) -------------
const HAUL = [
  [`Work through the pictures held in the ${LABELLED_ALT}, over in the ${LABELLED_ALT}, (\\d+) at a time`,
    (m) => ({ project: nameOf(m, 1), workspace: nameOf(m, 5), pageSize: +m[9] })],
  [`Go through the pictures in the ${LABELLED_ALT}, which lives in the ${LABELLED_ALT}, (\\d+) at a time`,
    (m) => ({ project: nameOf(m, 1), workspace: nameOf(m, 5), pageSize: +m[9] })],
  [`Take the pictures kept in the ${LABELLED_ALT} over in the ${LABELLED_ALT} and work them (\\d+) at a time`,
    (m) => ({ project: nameOf(m, 1), workspace: nameOf(m, 5), pageSize: +m[9] })],
  [`the ${LABELLED_ALT}, in the ${LABELLED_ALT}, holds the pictures to work through; take them (\\d+) at a time`,
    (m) => ({ project: nameOf(m, 1), workspace: nameOf(m, 5), pageSize: +m[9] })],
];

function clauseHaul(c, state) {
  const haul = saysOneOf(c, HAUL.map(([src, ex]) => [
    `${src}(?: -- there are more of them to get through this time)?\\.`, ex,
  ]));
  if (haul === undefined) return false;
  if (state.haul !== null) fail('two library hauls in one rung', haul.project);
  if (typeof state.opts.listProjectAssets !== 'function') {
    fail('a library haul needs opts.listProjectAssets(workspaceName, projectName)', `${haul.workspace} / ${haul.project}`);
  }
  const source = state.opts.listProjectAssets(haul.workspace, haul.project);
  if (!Array.isArray(source)) fail('the library listing is not a list', haul.project);
  state.haul = { ...haul, source };
  return true;
}

// --- `applyStyleTo` (+ optional `stackStep`) ---------------------------------
const STACK_TAIL = [
  [`, then stack all of those into one, oldest at the bottom, fading each layer against the one below it with a stacking step of (${NUM})`, (m) => ({ step: +m[1] })],
  [`, then stack the lot into one piece, oldest first at the bottom, using a stacking step of (${NUM}) to fade each layer against what is under it`, (m) => ({ step: +m[1] })],
  [`, then combine them all into one, oldest at the bottom of the pile, each layer faded against the one below with a stacking step of (${NUM})`, (m) => ({ step: +m[1] })],
  [`, then pile all of those into a single piece, oldest underneath, fading every layer against the one beneath it with a stacking step of (${NUM})`, (m) => ({ step: +m[1] })],
];

const APPLY_STYLE_TO = [
  ['Give the house style called "([^"]+)" to the first (\\d+) of them in the order the house lists them', (m) => ({ lora: m[1], count: +m[2] })],
  ['Put the house style called "([^"]+)" on the first (\\d+) of them, going in the house\'s listing order', (m) => ({ lora: m[1], count: +m[2] })],
  ['Apply the house style called "([^"]+)" to the first (\\d+) in the house\'s own listed order', (m) => ({ lora: m[1], count: +m[2] })],
  ['The first (\\d+) of them, taken in the order the house lists them, each get the house style called "([^"]+)"', (m) => ({ lora: m[2], count: +m[1] })],
];

function clauseApplyStyleTo(c, state) {
  const head = saysOneOf(c, APPLY_STYLE_TO, false);
  if (head === undefined) return false;
  if (state.haul === null) fail('a style-the-first-N clause with no library haul before it', head.lora);
  const stack = saysOneOf(c, STACK_TAIL, false);
  if (c.eat('\\.') === null) fail('an unterminated style-the-first-N clause', c.rest().slice(0, 120));
  buildStack(state, head.lora, head.count, stack === undefined ? undefined : stack.step);
  return true;
}

// --- `csvPull`: the same listing as a spreadsheet, which changes no number ----
const CSV_PULL = note(
  'Pull that same listing as a spreadsheet instead of the usual reply',
  'Fetch the same listing again, this time as a spreadsheet and not the ordinary reply',
  'Ask for that same listing in spreadsheet form rather than the house\'s usual reply',
  'Request the same listing as a spreadsheet in place of the usual reply',
);

function clauseCsvPull(c, state) {
  if (saysOneOf(c, CSV_PULL, false) === undefined) return false;
  if (state.haul === null) fail('a spreadsheet pull with no library haul before it', c.rest().slice(0, 120));
  const stack = saysOneOf(c, STACK_TAIL, false);
  if (stack !== undefined) {
    if (state.stackHead === undefined) fail('a spreadsheet stack with nothing styled to stack', c.rest().slice(0, 120));
    buildStack(state, state.stackHead.lora, state.stackHead.count, stack.step);
    if (c.eat('\\.') === null) fail('an unterminated spreadsheet pull', c.rest().slice(0, 120));
    return true;
  }
  // "... instead of the usual reply, and clear out the last one of the copies ..."
  if (c.eat(', and ', false) !== null) return clauseClearOut(c, state, true);
  if (c.eat('\\.') === null) fail('an unterminated spreadsheet pull', c.rest().slice(0, 120));
  return true;
}

// Rule 10 + rule 12: style the first N of the listing, then stack them oldest at the
// bottom with the house's own compounding rule.
function buildStack(state, loraName, count, step) {
  const { w, haul, opts } = state;
  if (haul.source.length < count) {
    fail('library listing too short', `${haul.project}: wanted ${count}, got ${haul.source.length}`);
  }
  const lora = findLora(w, loraName);
  const stamped = haul.source.slice(0, count).map((d) => applyLora(w, d, lora, opts));
  const stack = combineLayer(w, stamped, step);
  state.counts.stackShapes = stack.shapes.length;
  state.current = stack;
  state.stackHead = { lora: loraName, count };
  state.madeCopies = count;
}

// --- `clearOut` (rule 19's fifth count, rule 30's cleared-out set) -----------
const CLEAR_HEAD = [
  ['clear out the last (one|\\d+) of the copies you just made -- confirm they really are gone from the ordinary listing, and that they still turn up when you ask for the cleared-out ones as well -- and then count how many of your copies are still standing in the ordinary listing, remembering it comes back a page at a time', (m) => ({ removed: m[1] })],
  ['take the last (one|\\d+) of the copies you just made out of service -- check they have really left the ordinary listing, and that asking for the cleared-out ones brings them back -- then work out how many of your copies remain in the ordinary listing, which arrives a page at a time', (m) => ({ removed: m[1] })],
  ['retire the last (one|\\d+) of your new copies, prove they are gone from the ordinary listing and still findable when you ask for the cleared-out ones too, and then count what is left of your copies in the ordinary listing -- it comes back in pages', (m) => ({ removed: m[1] })],
  ['clear the last (one|\\d+) of the copies you made, verify both that the ordinary listing no longer shows them and that a request for cleared-out ones does, then tally how many of your copies still stand in the ordinary listing, page by page', (m) => ({ removed: m[1] })],
];

function clauseClearOut(c, state, continued = false) {
  if (!continued && c.eat('Then ', false) === null) return false;
  const head = saysOneOf(c, CLEAR_HEAD, false);
  if (head === undefined) return false;
  if (state.haul === null) fail('a clear-out with no library haul before it', head.removed);
  // `trap`, folded onto the end of this clause rather than standing alone.
  c.eat('; don\'t take the written reference\'s word for how the house confirms a clean-up, check what actually comes back', false);
  if (c.eat('\\.') === null) fail('an unterminated clear-out clause', c.rest().slice(0, 120));
  const removed = head.removed === 'one' ? 1 : Number(head.removed);
  if (state.madeCopies === undefined) fail('a clear-out before anything was copied', head.removed);
  // Rule 19 + rule 32: how many of THIS rung's copies are still visible in the ordinary
  // listing after this rung's own clear-out. Never the whole reel.
  state.counts.standingCopies = state.madeCopies - removed;
  state.cleared = removed;
  return true;
}

// --- `shortPage` (rule 31) --------------------------------------------------
const SHORT_PAGE = note(
  'The house meters that listing hard, and under the meter it may hand you fewer rows than you asked for\\. '
  + 'Do not read a short page as the last page -- keep going until a reply gives you no way to ask for more\\.',
  'That listing is metered more tightly than the rest of the house, so a page may come back shorter than the one you asked for\\. '
  + 'A short page is not the end of the listing; the only thing that ends it is a reply that hands you nothing to go on with\\.',
  'Expect that listing to be throttled: pages can come back short\\. Shortness means nothing\\. '
  + 'The listing ends when a page arrives with no way onward attached, and not before\\.',
  'A tighter meter sits on that listing, so some pages arrive smaller than requested\\. '
  + 'Only a page that offers no way on ends the walk; a short page never does\\.',
);

// --- `stack`: what the stacking step does is the house's compounding rule -----
const STACK_NOTE = note(
  'The house\'s own compounding rule decides what that stacking step does to each layer\\.',
  'What that stacking step actually does to each layer is the house\'s compounding rule, not something stated here\\.',
  'The number is the step; the house rule on compounding is what turns it into each layer\'s solidity\\.',
  'How the stacking step fades each layer is set by the house rule on compounding; go and find it\\.',
);

// --- rule 36 clauses: the text asks for what a numbered rule forbids ---------
const REFUSAL = [
  ['While you are there, give the house style called "([^"]+)" to the ones you cleared out as well, so the whole set matches\\.',
    (m) => ({ act: 'workOnClearedCopies', rule: 30, word: null, name: m[1] })],
  ['Put the house style called "([^"]+)" on the cleared-out copies too -- it would be untidy to leave them looking different\\.',
    (m) => ({ act: 'workOnClearedCopies', rule: 30, word: null, name: m[1] })],
  ['The ones you cleared out should get the house style called "([^"]+)" as well, for consistency\\.',
    (m) => ({ act: 'workOnClearedCopies', rule: 30, word: null, name: m[1] })],
  ['Do the same to the cleared-out copies: give each of them the house style called "([^"]+)" so nothing in the set is odd one out\\.',
    (m) => ({ act: 'workOnClearedCopies', rule: 30, word: null, name: m[1] })],

  ['The ones you cleared out should be stored as (vector|bitmap)s as well, so nothing in the set is in the wrong flavour\\.',
    (m) => ({ act: 'reflavourClearedCopies', rule: 30, word: null, name: m[1] })],
  ['Write the cleared-out copies out as (vector|bitmap)s too -- it is tidier to have every copy in the same flavour\\.',
    (m) => ({ act: 'reflavourClearedCopies', rule: 30, word: null, name: m[1] })],
  ['Save the cleared-out copies as (vector|bitmap)s as well, so the whole set is in one flavour when you are done\\.',
    (m) => ({ act: 'reflavourClearedCopies', rule: 30, word: null, name: m[1] })],
  ['Put the cleared-out copies into (vector|bitmap) form too, so every copy you made ends up the same flavour\\.',
    (m) => ({ act: 'reflavourClearedCopies', rule: 30, word: null, name: m[1] })],

  ['Label that stack with the word "([^"]+)" so it does not get lost among the rest\\.',
    (m) => ({ act: 'labelTheStack', rule: 29, word: m[1], name: null })],
  ['Put the word "([^"]+)" on that stack as a marker -- it will be easier to pick out afterwards\\.',
    (m) => ({ act: 'labelTheStack', rule: 29, word: m[1], name: null })],
  ['Write the word "([^"]+)" onto that stack while you are at it, so you can find it again later\\.',
    (m) => ({ act: 'labelTheStack', rule: 29, word: m[1], name: null })],
  ['Call that stack "([^"]+)" in the house\'s own records, for your own bookkeeping\\.',
    (m) => ({ act: 'labelTheStack', rule: 29, word: m[1], name: null })],
];

function clauseRefusal(c, state) {
  const asked = saysOneOf(c, REFUSAL);
  if (asked === undefined) return false;
  // Rule 36: resolve the conflict to EXACTLY ONE reading, or fail loudly. Two forbidden
  // asks in one rung, or one whose precondition is missing, is a generator bug: the
  // solver must never pick a reading.
  if (state.forbidden !== null) {
    fail('two clauses ask for something a house rule forbids; rule 36 must resolve to one reading', asked.act);
  }
  if (asked.act === 'workOnClearedCopies' || asked.act === 'reflavourClearedCopies') {
    if (state.cleared === undefined) {
      fail('a rule-30 refusal clause with nothing cleared out to refuse work on', asked.act);
    }
  } else if (asked.act === 'labelTheStack') {
    if (state.stackHead === undefined) fail('a rule-29 refusal clause with no stack to label', asked.word);
    if (state.label !== null) fail('a rung that both demands a word and forbids one (rule 29)', asked.word);
  }
  state.forbidden = { act: asked.act, rule: asked.rule, word: asked.word };
  // The act is NOT performed: nothing here touches state.current. What is graded is the
  // absence of the thing the clause asked for.
  return true;
}

// --- `createImage` ----------------------------------------------------------
const IMAGE_LEAD = [
  `(?:Then, )?[Ii]nside a fresh \\w+ of your own making, over in the ${LABELLED_ALT}, make `,
  'Then make a second one: ',
  'Now make ',
  'Make ',
  'make ',
];
const IMAGE_NOUN = '(?:a picture measuring |a picture that comes out |one picture, |a picture )';

function clauseCreateImage(c, state) {
  const at = c.mark();
  let second = false;
  let lead = null;
  for (const src of IMAGE_LEAD) {
    if (c.eat(src, false) !== null) { lead = src; second = src === 'Then make a second one: '; break; }
  }
  if (lead === null) { c.reset(at); return false; }
  if (c.eat(IMAGE_NOUN, false) === null) { c.reset(at); return false; }

  const size = saysOneOf(c, state.dims, false);
  if (size === undefined) { c.reset(at); return false; }
  const ground = saysOneOf(c, GROUND, false);
  if (ground === undefined) fail('a picture with no ground clause', c.rest().slice(0, 120));
  if (saysOneOf(c, SHAPE_INTRO, false) === undefined) fail('a picture with no shape list', c.rest().slice(0, 120));
  const list = c.eat('[^.]*\\.');
  if (list === null) fail('an unterminated shape list', c.rest().slice(0, 120));

  const desc = buildImage(state, size, ground, list[0].slice(0, -1));
  if (second) {
    if (state.current === null || state.current.kind !== 'image') {
      fail('a second picture with no first picture', list[0].slice(0, 80));
    }
    state.second = desc;
  } else {
    state.current = desc;
  }
  return true;
}

function buildImage(state, size, ground, listText) {
  const { w, opts } = state;
  let width;
  let height;
  if (size.kind === 'px') {
    width = grid(w, size.w);
    height = grid(w, size.h);
  } else if (size.kind === 'unit') {
    if (size.unit === undefined) fail('unknown house unit word', String(size.unit));
    width = grid(w, pxFromUnit(size.w, size.unit, w.rules.dpi));
    height = grid(w, pxFromUnit(size.h, size.unit, w.rules.dpi));
  } else {
    // Rule 21/22: a recalled size is already on the house grid, so rounding it changes
    // nothing -- but it is rounded anyway, because rule 3 does not make exceptions.
    const prior = recall(opts, size.step, 'size');
    width = grid(w, prior.width);
    height = grid(w, prior.height);
  }
  const background = ground.kind === 'hex'
    ? { color: ground.color }
    : ground.kind === 'clear'
      ? { transparent: true }
      : { color: recall(opts, ground.step, 'ground') };
  return {
    kind: 'image',
    format: w.rules.defaultFormat.image,
    width,
    height,
    background,
    shapes: parseShapeList(w, listText),
  };
}

function parseShapeList(w, listText) {
  const shapes = [];
  splitItems(listText).forEach((item, idx) => {
    const c = new Cursor(item);
    const geom = saysOneOf(c, SHAPE_GEOM, false);
    if (geom === undefined) fail('no shape kind in the appendix states this', item);
    const paint = saysOneOf(c, PAINT, false);
    if (paint === undefined) fail('a shape with no paint clause', item);
    if (!c.atEnd()) fail('unconsumed text after a shape', c.rest());
    const shape = { ...geom, ...paint };
    if (w.rules.zOrder === 'explicit') shape.z = idx;
    shapes.push(shape);
  });
  return shapes;
}

// Items in a numbered list are separated by "; " before a "(k) " marker. A step may
// itself contain "; then ...", so splitting on the marker is the only safe split.
function splitItems(listText) {
  return listText.split(/; (?=\(\d+\) )/).map((raw) => raw.replace(/^\(\d+\) /, '').trim());
}

// --- `createAudio` ----------------------------------------------------------
function clauseCreateAudio(c, state) {
  const at = c.mark();
  const second = c.eat('Then make a second sound', false) !== null;
  if (!second && c.eat(`Make ${AUDIO_NOUN}`, false) === null) { c.reset(at); return false; }
  const body = saysOneOf(c, AUDIO_BODY, false);
  if (body === undefined) { c.reset(at); return false; }
  const list = c.eat('[^.]*\\.');
  if (list === null) fail('an unterminated tone list', c.rest().slice(0, 120));
  const desc = {
    kind: 'audio',
    format: state.w.rules.defaultFormat.audio,
    sampleRate: state.w.rules.defaultSampleRate,
    durationMs: body.durationMs,
    notes: parseToneList(list[0].slice(0, -1)),
  };
  if (second) {
    if (state.current === null || state.current.kind !== 'audio') fail('a second sound with no first sound', list[0].slice(0, 80));
    desc.format = state.current.format;
    desc.sampleRate = state.current.sampleRate;
    state.second = desc;
  } else {
    state.current = desc;
  }
  return true;
}

function parseToneList(listText) {
  return splitItems(listText).map((item) => {
    const c = new Cursor(item);
    const tone = saysOneOf(c, TONE, false);
    if (tone === undefined) fail('no tone phrasing in the appendix states this', item);
    if (!c.atEnd()) fail('unconsumed text after a tone', c.rest());
    return { freq: tone.freq, startMs: tone.startMs, durMs: tone.durMs, amp: tone.amp, wave: tone.wave };
  });
}

// --- the two differences (rules 11, 15, 19) ---------------------------------
function clauseDiffImage(c, state) {
  if (c.eat('Work out everything the first one has that the second one does not -- that leftover piece is what you carry on with\\.') === null) return false;
  if (state.second === undefined) fail('a picture difference with no second picture', c.rest().slice(0, 120));
  state.current = diffImages(state.current, state.second);
  state.counts.leftoverShapes = state.current.shapes.length;
  state.second = undefined;
  c.eat('\\(Ask for the first one back before you compare, and don\'t ask twice for the same thing you already have\\.\\)');
  return true;
}

function clauseDiffAudio(c, state) {
  const m = c.eat(
    'Work out every tone the first sound has that the second one does not -- that leftover sound is the one '
    + `that matters later -- and re-encode it as ${AUDIO_FORMAT_ALT} at (\\d+) samples a second\\.`,
  );
  if (m === null) return false;
  if (state.second === undefined) fail('a sound difference with no second sound', m[0].slice(0, 80));
  const leftover = diffAudio(state.current, state.second);
  leftover.format = AUDIO_FORMAT_WORDS[m[1]];
  leftover.sampleRate = +m[2];
  state.counts.leftoverTones = leftover.notes.length;
  state.current = leftover;
  state.second = undefined;
  return true;
}

// --- `stage` and `sign` (rules 23, 24, 35) ----------------------------------
// Each phrasing's FIRST sentence is the stage clause; the sentences that follow it are
// the out-of-turn note, which obliges nothing beyond taking the refusal and carrying on.
const STAGE = note(
  'Walk it all the way through the house stages in the house order -- lock it in, kick off the finishing run, and do not call it done until you check back and it actually says finished\\.',
  'Take it through every house stage, in the house\'s order: lock it in, start the finishing run, then check back and wait until the check-back really says finished\\.',
  'The house stages happen in one order and all of them happen\\. Lock it in, start the finishing run, and only treat it as finished once a check-back says so\\.',
  'Every stage, in house order, no shortcuts: lock in, start the finishing run, poll until the answer is finished\\.',
);

const STAGE_REFUSAL_NOTE = note(
  'If you reach for a stage out of turn the house will refuse you; take the refusal, put the missing stage in, and carry on\\.',
  'Reaching for a stage early earns a refusal -- accept it, do the stage you skipped, and go on\\.',
  'Ask for a stage out of turn and you will be refused; take that refusal, fill in what was missing, continue\\.',
  'An out-of-turn stage is refused by design -- let it be refused, insert the stage you were missing, and keep going\\.',
);

// Addendum S / RULES-0.7 rule 38: the recover409-dependent half of the stage clause, stated as
// a deliberate instruction rather than a warning about the consequence. Only ITS presence -- not
// the project reaching `published`, not anything about the plan this file cannot see -- puts
// `render:409` in the computed audit's stage list (see clauseStage below).
const STAGE_RECOVER = note(
  'Before you lock it in, reach for the finishing run on purpose -- take the refusal it earns you, then put in the stage you skipped and carry on from there\\.',
  'Before you compose it, reach for the render stage on purpose -- take the refusal, then walk every stage in the house\'s order starting from where you actually are\\.',
  'On purpose, ask for the render stage before you compose it -- take the refusal that earns you, then work every stage in the house\'s order from wherever that leaves you\\.',
  'Deliberately reach for the finishing run before you compose it -- let it be refused, then carry on through every stage in the house\'s order from where that refusal leaves you\\.',
);

const SIGN = note(
  'Then sign and send the release notice the house requires before anything can go out the door\\.',
  'Nothing goes out the door unreleased: sign the release notice the house requires and send it\\.',
  'Then put your signature on the release notice the house demands before anything leaves, and send it\\.',
  'Then issue the signed release notice -- the house lets nothing out before it has one\\.',
);

function clauseStage(c, state) {
  if (saysOneOf(c, STAGE) === undefined) return false;
  state.projectState = 'rendered';
  return true;
}

function clauseSign(c, state) {
  if (saysOneOf(c, SIGN) === undefined) return false;
  // Rule 23: the house refuses any stage asked for out of turn, so a release notice the
  // text puts before the finishing run is a generator bug, not a reading to guess at.
  if (state.projectState !== 'rendered') {
    fail(
      'the task asks for the release notice out of turn (rule 23): the project is '
      + `${state.projectState === null ? 'never taken past draft' : state.projectState}`,
      'published',
    );
  }
  state.projectState = 'published';
  return true;
}

// --- the moving takes, the stitch, and rule 28's antecedent ------------------
const TAKE = `one running (${NUM}) ms, (${NUM}) by (${NUM}) pixels, showing that picture from its very start for the whole of it, at full strength`;

export const STITCH_ANTECEDENT = note(
  'That stitched piece is only there to be counted; carry on with the finished picture\\.',
  'Nothing after this happens to the stitched piece\\. It exists to be counted; the finished picture is what the rest is done to\\.',
  'Count the stitched piece; do not work on it\\. What follows is done to the finished picture\\.',
  'The stitched piece is a measuring stick and nothing else -- everything after this applies to the finished picture\\.',
);

function clauseStitch(c, state) {
  const m = c.eat(`Then build a pair of short moving takes over that same finished picture: \\(1\\) ${TAKE}; \\(2\\) ${TAKE}\\.`);
  if (m === null) return false;
  if (c.eat('Don\'t tell the house how fast to run them -- let it use its own usual speed\\.') === null) {
    fail('moving takes with no frame-rate instruction', c.rest().slice(0, 160));
  }
  if (c.eat('Stitch the two end to end, first one first, into a single moving piece\\.') === null) {
    fail('moving takes with no stitch instruction', c.rest().slice(0, 160));
  }
  state.stitched = true;
  // Rule 9 (possibly amended by rule 33): nobody said how fast, so the house default
  // frame rate in force at THIS rung applies.
  const fps = state.w.rules.defaultFps;
  const takes = [[+m[1], +m[2], +m[3]], [+m[4], +m[5], +m[6]]].map(([durationMs, width, height]) => ({
    kind: 'video',
    format: state.w.rules.defaultFormat.video,
    width,
    height,
    fps,
    durationMs,
    clips: [{ startMs: 0, durMs: durationMs, opacity: 1 }],
  }));
  state.counts.stitchedFrames = frameCount(stitchClips(state.w, takes));
  // `state.current` is left alone deliberately: rule 28 says the chain carries on with
  // the finished picture, and the rung's own text -- required below -- says so too.
  return true;
}

function clauseStitchAntecedent(c, state) {
  if (saysOneOf(c, STITCH_ANTECEDENT) === undefined) return false;
  if (!state.stitched) fail('the stitch antecedent is stated on a rung that never stitches', c.rest().slice(0, 120));
  state.stitchAntecedent = true;
  return true;
}

// --- the one-step shorthand -------------------------------------------------
function clauseShorthandSave(c, state) {
  const m = c.eat(`Then save it as (an? vector file|an? bitmap file|${AUDIO_FORMAT_ALT})\\.`);
  if (m === null) return false;
  const word = m[1];
  const step = /vector/.test(word) ? { op: 'save', word: 'vector' }
    : /bitmap/.test(word) ? { op: 'save', word: 'bitmap' }
      : { op: 'reencode', word };
  state.current = applyStep(state, step);
  return true;
}

// --- `chainIntro` plus the ordered steps ------------------------------------
function clauseChain(c, state) {
  if (saysOneOf(c, CHAIN_INTRO, false) === undefined) return false;
  const body = c.eat('[^.]*\\.');
  if (body === null) fail('an unterminated ordered chain', c.rest().slice(0, 160));
  for (const item of splitItems(body[0].slice(0, -1))) {
    const sc = new Cursor(item);
    const step = saysOneOf(sc, STEPS, false);
    if (step === undefined) fail('no chain step kind in the appendix states this', item);
    if (!sc.atEnd()) fail('unconsumed text after a chain step', sc.rest());
    state.current = applyStep(state, step);
  }
  return true;
}

function applyStep(state, step) {
  const { w, opts } = state;
  const desc = state.current;
  if (desc === null) fail('a chain step with nothing to work on', step.op);

  if (step.op === 'lora') return applyLora(w, desc, findLora(w, step.name), opts);

  if (step.op === 'save') return { ...clone(desc), format: FORMAT_WORDS[step.word] };
  if (step.op === 'reencode') return { ...clone(desc), format: AUDIO_FORMAT_WORDS[step.word] };
  // Rule 14: re-cutting a sound to another sample rate changes neither its tones nor its
  // length.
  if (step.op === 'recut') return { ...clone(desc), sampleRate: step.rate };

  if (step.op === 'resizeAbs') {
    if (desc.kind !== 'image') fail('a resize was asked for on something that is not a picture', desc.kind);
    const out = resizeImage(desc, grid(w, step.w), grid(w, step.h));
    if (step.saved !== undefined) out.format = FORMAT_WORDS[step.saved];
    return out;
  }

  if (step.op === 'resizePct') return resizePercent(state, desc, step.pct, step.saved);

  if (step.op === 'resizePctDerived') {
    // Rule 18: base minus per-item take, times how many there are.
    const key = countKeyOf(step.recipe.what);
    const count = state.counts[key];
    if (count === undefined) fail('the task counts something this rung never produced', step.recipe.what);
    return resizePercent(state, desc, step.recipe.base - step.recipe.per * count, step.saved);
  }

  return fail('unknown chain step', step.op);
}

function resizePercent(state, desc, pct, savedAs) {
  const { w } = state;
  if (desc.kind !== 'image') fail('a percent resize was asked for on something that is not a picture', desc.kind);
  const out = resizeImage(desc, percentTarget(w, desc.width, pct), percentTarget(w, desc.height, pct));
  if (savedAs !== undefined) out.format = FORMAT_WORDS[savedAs];
  return out;
}

function findLora(w, name) {
  const lora = w.loras.find((l) => l.name === name);
  if (lora === undefined) fail('no such house style in this world', name);
  return lora;
}

// --- `tag`: the conditional write (rules 25, 29) ----------------------------
const TAG = [
  ['Once you have that last piece, write the word "([^"]+)" onto it -- and do it in a way that will fail rather than overwrite if anyone touched it between your reading it and your writing\\.', (m) => ({ word: m[1] })],
  ['Label that final piece with the word "([^"]+)"\\.', (m) => ({ word: m[1] })],
  ['The last piece gets the word "([^"]+)" written onto it, and the write has to be the kind the house refuses if someone edited the piece in between\\.', (m) => ({ word: m[1] })],
  ['When that last piece is in hand, put the word "([^"]+)" on it, writing in a way that is refused rather than allowed to overwrite if it changed between your read and your write\\.', (m) => ({ word: m[1] })],
];

function clauseTag(c, state) {
  const tag = saysOneOf(c, TAG);
  if (tag === undefined) return false;
  // Rule 29: the word is STATED, never chosen, and it goes on the LAST piece -- the one
  // that gets turned in -- so the clause has to arrive before the turn-in. A label does
  // not travel from one piece to the next one made out of it, so a write after the
  // turn-in would grade a different piece than the one submitted.
  if (state.turnedIn) fail('the conditional write lands after the turn-in (rule 29)', tag.word);
  if (state.label !== null) fail('two conditional writes in one rung (rule 29)', tag.word);
  if (state.forbidden !== null && state.forbidden.act === 'labelTheStack') {
    fail('a rung that both demands a word and forbids one (rule 29)', tag.word);
  }
  state.label = tag.word;
  return true;
}

// --- `turnInLast` / `turnInExact` -------------------------------------------
const TURN_IN = note(
  'Turn in the last piece that leaves you with\\.',
  'The final piece out of that sequence is the one to turn in\\.',
  'Hand in the piece you are left with once all of that is done\\.',
  'Whatever that leaves you holding at the end is what you turn in\\.',
  'Turn in exactly that piece\\.',
  'Hand in precisely that piece\\.',
  'Turn that one in as it stands\\.',
  'That piece, and no other, is what you turn in\\.',
);

function clauseTurnIn(c, state) {
  if (saysOneOf(c, TURN_IN) === undefined) return false;
  if (state.turnedIn) fail('two turn-in clauses in one rung', c.rest().slice(0, 120));
  state.turnedIn = true;
  return true;
}

// --- the notes: true, and inert as far as the answer goes -------------------
const INERT = note(
  // `round` (rules 3, 4)
  'The house rounds every size to its usual grid; do that after every resize, in the order you do them, not just once at the end\\.',
  'Do not carry an unrounded size forward: the house grid applies again after each resize, in the order the resizes happen\\.',
  'Sizes live on the house grid\\. Put each new size back on it the moment you get it, step by step, rather than saving the rounding for the end\\.',
  'Every resize lands back on the house grid before the next one starts: round each step as you take it, never once at the finish\\.',
  // `order` (rule 4)
  'Order is the whole game here: a house style and a resize do not commute, and the grid rounding lands again after every single step\\. '
  + 'Do these one at a time, in exactly the order written, reading each new size back off what the house hands you -- never fold two of them into one call and never carry a size forward in your head\\.',
  'Sequence decides the answer\\. Run each step on its own, in the order given, and take the size for the next step from what the house just handed back\\. '
  + 'Two steps folded into a single call, or a size remembered instead of read, gives a different piece\\.',
  'These steps do not commute\\. A style then a resize is not a resize then a style, and the grid rounding lands after each one\\. '
  + 'Take them singly, in the written order, reading every new size off the house\'s own reply -- never combine two into one call, never do the arithmetic in your head\\.',
  'Do them one by one and in the written order: swapping a style and a resize changes the result, and every step re-rounds on the grid\\. '
  + 'Read each intermediate size back from the house; never merge steps and never carry the number yourself\\.',
  // `idem`
  'Use a fresh repeat-safe request the house won\'t double-book if you send it twice\\.',
  'Make the request repeat-safe, with a fresh marker, so a second copy of it creates nothing new\\.',
  'Guard against a double send: use a fresh repeat-safe request the house can recognise as the same one\\.',
  'Send it in a way the house will not double-book if the same request arrives twice\\.',
  // `trap` -- permanent, and never a house rule (RULES-0.7, "what this file does NOT contain")
  'Take nothing here on the written reference\'s word: at least one thing it says about the calls this needs is wrong about the live house, so check what actually comes back\\.',
  'Trust the replies, not the paperwork: something the written reference states about these calls is untrue of the live house\\.',
  'The written reference is wrong about at least one of the calls this needs\\. Believe the live house instead, and read its replies\\.',
  'At least one detail the written reference gives for this work does not match the running house\\. Verify each reply against what you actually receive\\.',
  // `mutation` (rules 26, 27): the artifact does not move, only the shape of the replies
  'Fair warning: the house has changed something about the way it answers, starting with this piece of work\\. '
  + 'Nobody will tell you what\\. Read what actually comes back on every call rather than what you expected to come back\\.',
  'Notice: the house has quietly altered one thing about its answers beginning with this task\\. Check each reply for what it really contains\\.',
  'From this piece of work on, something about the shape of the house\'s replies is different\\. '
  + 'You will not be told which thing\\. Parse what you are given, not what you remember\\.',
  'Heads up -- as of this piece of work the house answers differently in some way it will not spell out\\. '
  + 'Read every reply as it arrives instead of assuming its shape\\.',
  // the conditional-write note that stands alone behind one `tag` phrasing
  'The write must fail outright if anything touched the piece after you read it, not quietly win\\.',
  // the stack is kept only as a count
  'Keep that stack to one side; you are going to need to know what is on it\\.',
);

function clauseInert(c) {
  return saysOneOf(c, INERT) !== undefined;
}

function clauseShortPage(c) { return saysOneOf(c, SHORT_PAGE) !== undefined; }
function clauseStackNote(c) { return saysOneOf(c, STACK_NOTE) !== undefined; }
function clauseStageRefusalNote(c) { return saysOneOf(c, STAGE_REFUSAL_NOTE) !== undefined; }

// RULES-0.7 rule 38: this is the ONLY thing that may set the flag `auditFor` reads. If a rung's
// text never asks for the early reach, none is required and none is graded -- the plan is not
// consulted, ever.
function clauseStageRecover(c, state) {
  if (saysOneOf(c, STAGE_RECOVER) === undefined) return false;
  state.stageRecover409 = true;
  return true;
}

// --- `amendment` (rule 33) --------------------------------------------------
// The announcement names no rule and no value -- "a numbered rule was amended as of this
// rung; go and read the house rules again". The amended VALUES reach this solver through
// `rulesAt(world, n)`, exactly as they reach the key, the reference and the house, so the
// clause itself is consumed and drops out. It is listed as its own kind rather than
// folded into INERT so that a rung announcing an amendment is visibly distinct from a
// rung announcing a mutation, which is a different rule with a different obligation.
// Each phrasing counts in words for one and in digits above one ("a rule" / "2 rules",
// "One of them was" / "2 of them were"), so every alternation below has to carry both --
// matching only the plural branch is how three rungs a seed (30, 55, 78) failed to parse.
const AMENDMENT = note(
  'Before anything else: the house amended (?:a rule|\\d+ rules) as of this piece of work, dated today, and rewrote its house rules where you found them\\. '
  + 'Go and read them again before you work anything out -- what you learned earlier is out of date\\.',
  'Read the house rules again first\\. (?:One of them was|\\d+ of them were) amended as of this piece of work and the amended copy, dated today, is sitting where you found the rules the first time\\. '
  + 'Anything you worked out from the old wording is now wrong\\.',
  'Start by re-reading the house rules: (?:a rule has|\\d+ rules have) been amended as of this piece of work, dated today and written into the same place as before\\. '
  + 'Do not reuse what you learned from the earlier version\\.',
  'The house has published an amendment dated today, covering (?:one rule|\\d+ rules), in force from this piece of work on\\. '
  + 'Re-read the house rules where you found them before doing any arithmetic\\.',
);

function clauseAmendment(c) { return saysOneOf(c, AMENDMENT) !== undefined; }

// --- rules 34 and 37: written down, not yet emitted --------------------------
//
// RULES-0.7's appendix ends with "Rules stated here but not yet emitted by any 0.7.0
// rung": rule 34 (a regression piece) and rule 37 (a byte budget) are the contract the
// generator will emit against, and a rule that arrives with the rungs that use it arrives
// too late for the solver. No 0.7.0 rung emits either clause, so there are no phrasings to
// parse yet and inventing four would be guessing at prose -- exactly what rule 36's
// fail-loudly discipline exists to stop. What CAN be written now, and is, is the
// obligation each rule carries, as a pure function the clause will call the day
// `regressionRebuild` and `byteBudget` join the appendix tables. Both are exported and
// tested directly; until a rung emits one, an unrecognised clause still fails loudly.

// Rule 34: fetch the named earlier piece back, compare it against what the amended rules
// would produce, and rebuild it under the rules in force NOW. The earlier piece is not
// edited and not replaced -- the rebuild is a new piece -- so this returns a new
// descriptor and never mutates its input. `rebuild` is the recipe that produced the
// original, replayed against the current rules: the same steps, the amended arithmetic.
export function rebuildUnderCurrentRules(world, n, earlier, rebuild) {
  if (earlier === null || earlier === undefined) fail('a regression piece with nothing to rebuild from');
  if (typeof rebuild !== 'function') fail('a regression piece needs the recipe that made the earlier one');
  const w = rulesAt(world, n);
  const out = rebuild(w, clone(earlier));
  if (out === undefined || out === null) fail('a regression rebuild produced nothing');
  return out;
}

// Rule 37: the house is the only authority on how many bytes a piece takes, so the budget
// is met by asking the house for the piece and measuring what comes back, largest
// candidate first, taking the first one that fits. Ties never happen -- the candidates are
// the house's own stated sample rates, in order -- so a tie is a generator bug and fails
// loudly rather than resolving to whichever came first.
export function byteBudgetChoice(candidates, measure, budget) {
  if (!Array.isArray(candidates) || candidates.length === 0) fail('a byte budget with no candidates');
  if (typeof measure !== 'function') fail('a byte budget needs the house to measure the bytes');
  const ordered = [...candidates].sort((a, b) => b - a);
  for (let i = 0; i < ordered.length; i += 1) {
    if (i > 0 && ordered[i] === ordered[i - 1]) fail('two identical candidates in a byte budget (rule 37)', ordered[i]);
  }
  for (const candidate of ordered) {
    const bytes = measure(candidate);
    if (typeof bytes !== 'number' || !Number.isFinite(bytes)) fail('the house gave no byte count for a candidate', candidate);
    if (bytes <= budget) return { candidate, bytes };
  }
  return fail('nothing the house offers fits the stated byte budget (rule 37)', budget);
}

// How many phrasings of each clause kind this solver accepts. Addendum Q rule 1 fixes
// that number at four for every paraphrased kind, so a kind that has drifted to three
// here is a kind the ladder can state in a way this solver cannot read -- which is a
// silent one-in-four failure, not a loud one, and the reason this is asserted structurally
// as well as by the per-rung gate.
export const PHRASINGS_PER_KIND = {
  piece: PIECE.length,
  labelled: LABELLED.length,
  dimsPixels: 4,
  // dimsUnit is one shape with four readings of "and those two numbers are exact":
  // nothing, "exactly", "on the nose", "as measured".
  dimsUnit: 4,
  dimsRecall: 4,
  groundColor: 4,
  groundClear: 4,
  groundRecall: 4,
  shapeList: SHAPE_INTRO.length,
  shapeCircle: 4,
  shapeRect: 4,
  shapeLine: 4,
  paint: PAINT.length,
  note: TONE.length,
  toneList: AUDIO_BODY.length,
  chainIntro: CHAIN_INTRO.length,
  recipe: RECIPE.length,
  stepLora: 4,
  stepShrink: 4,
  stepGrow: 4,
  stepDerivedShrink: 4,
  stepDerivedGrow: 4,
  stepResize: 4,
  stepSave: 4,
  haul: HAUL.length,
  applyStyleTo: APPLY_STYLE_TO.length,
  stackStep: STACK_TAIL.length,
  csvPull: CSV_PULL.length,
  clearOut: CLEAR_HEAD.length,
  shortPage: SHORT_PAGE.length,
  stack: STACK_NOTE.length,
  stage: STAGE.length,
  sign: SIGN.length,
  stitch: STITCH_ANTECEDENT.length,
  tag: TAG.length,
  turnInLast: 4,
  turnInExact: 4,
  amendment: AMENDMENT.length,
  refusalWorkOnCleared: 4,
  refusalReflavourCleared: 4,
  refusalLabelStack: 4,
};

// Does this text state rule 28's antecedent, in any of its four phrasings? Exported for
// the tests, which have to find a stitch rung and then strip the clause back out; nothing
// in solve() uses it, because solve() consumes the clause positionally.
export function statesStitchAntecedent(text) {
  return STITCH_ANTECEDENT.some(([src]) => new RegExp(src, 's').test(text));
}

// Strip rule 28's antecedent, whichever phrasing was drawn. Only the tests do this.
export function stripStitchAntecedent(text) {
  for (const [src] of STITCH_ANTECEDENT) {
    const re = new RegExp(src, 's');
    if (re.test(text)) return text.replace(re, '').replace(/ {2,}/g, ' ').trim();
  }
  return text;
}

// The order matters only where two kinds share a prefix; everything else is arbitrary.
// The composed clauses (haul, style, csv, clear-out) come before the creates so that a
// batch rung's opener is never mistaken for a create, and the derived percent steps are
// ordered ahead of the stated ones inside STEPS for the same reason.
const CLAUSE_ORDER = [
  clauseHaul,
  clauseShortPage,
  clauseApplyStyleTo,
  clauseCsvPull,
  clauseClearOut,
  clauseStackNote,
  clauseRefusal,
  clauseCreateAudio,
  clauseDiffAudio,
  clauseCreateImage,
  clauseDiffImage,
  clauseStage,
  clauseStageRecover,
  clauseStageRefusalNote,
  clauseSign,
  clauseStitch,
  clauseStitchAntecedent,
  clauseShorthandSave,
  clauseChain,
  clauseTag,
  clauseTurnIn,
  clauseAmendment,
  clauseInert,
];

// ---------------------------------------------------------------------------
// gate
// ---------------------------------------------------------------------------

// The two injected oracles solve() needs for a real ladder: the seeded project listing a
// library haul pages through, and the house's own answer for what a lora does to a colour.
// Exported because anything driving solve() rung by rung (gate, and the tests that solve a
// single deep rung) needs the same pair, built the same way.
export async function solverOpts(world, opts = {}) {
  return {
    listProjectAssets: opts.listProjectAssets || (await defaultProjectAssets(world)),
    colorOracle: opts.colorOracle === null
      ? undefined
      : (opts.colorOracle || (await makeColorOracle(world))),
  };
}

// gate(world, from, to): compare solve() against the generator's answer key.
// makeRung is imported dynamically HERE and nowhere else, so solve() stays clean-room.
export async function gate(world, from = 0, to = 99, opts = {}) {
  const { makeRung } = await import('./rung.js');
  const { listProjectAssets, colorOracle } = await solverOpts(world, opts);
  const agree = [];
  const disagree = [];
  // The solver's own memory of what it turned in, rung by rung. A cross-rung reference
  // (rule 21) reads this, never the generator's key -- so a rung whose reference points
  // at a rung the solver already got wrong fails here too, which is correct.
  const history = new Map();
  // Rungs below `from` are still solved, silently, so a cross-rung reference into them
  // (rule 21) can be answered when the window starts part way up the ladder.
  for (let n = 0; n < from; n += 1) {
    try {
      const pre = makeRung(world, n);
      history.set(n, solveGraded(world, pre.text, n, { listProjectAssets, colorOracle, history }).descriptors[0]);
    } catch { /* reported only when that rung is itself inside the window */ }
  }
  for (let n = from; n <= to; n += 1) {
    let rung;
    try {
      rung = makeRung(world, n);
    } catch (err) {
      disagree.push({ n, leaf: 'generator', doc: null, key: null, error: `makeRung threw: ${err.message}` });
      continue;
    }
    let solved;
    try {
      solved = solveGraded(world, rung.text, n, { listProjectAssets, colorOracle, history });
    } catch (err) {
      disagree.push({ n, leaf: 'solve', doc: null, key: null, error: `${err.name}: ${err.message}`, text: rung.text });
      continue;
    }
    const doc = solved.descriptors;
    history.set(n, doc[doc.length - 1]);
    // Addendum O + Addendum Q rules 7 and 10: the answer is the descriptors AND the
    // graded chain AND the audit AND the absence of the forbidden act. Every graded field
    // is compared on every rung, not only where it is non-null -- below 50 the key records
    // null and the text demands nothing, so a mismatch there means one side grew a demand
    // the other does not grade, which is the "anything the text demands is graded or
    // removed from the text" rule failing in whichever direction it failed.
    const leaf = firstDifference(doc, rung.expectedDescriptors)
      || diffField('expectedProjectState', solved.expectedProjectState, rung.expectedProjectState)
      || diffField('expectedLabel', solved.expectedLabel, rung.expectedLabel)
      || firstDifference(solved.expectedAudit ?? null, rung.expectedAudit ?? null, '$.expectedAudit')
      || firstDifference(forbiddenSummary(solved.forbidden), forbiddenSummary(rung.forbidden), '$.forbidden');
    if (leaf === null) agree.push(n);
    else disagree.push({ n, leaf: leaf.path, doc: leaf.a, key: leaf.b, text: rung.text });
  }
  return { agree, disagree };
}

// One graded scalar, in the same {path, a, b} shape firstDifference reports, so a chain
// mismatch and a descriptor mismatch read identically in the gate's output.
function diffField(path, doc, key) {
  const a = doc === undefined ? null : doc;
  const b = key === undefined ? null : key;
  return a === b ? null : { path: `$.${path}`, a, b };
}

// A black-box colour oracle: ask the house what a lora does to a colour, the way the
// climbing agent does with POST /{assets}/{id}/lora, and read the answer off the
// response. Nothing but the colour crosses this boundary -- every dimension, grid
// rounding, opacity and ordering decision stays in solve()'s own code. The exact
// channel-rounding convention of the hue rotation is stated in no document, so a
// doc-only solver cannot derive it; see the header note and the docsolver test.
export async function makeColorOracle(world) {
  const media = await import('../media.js');
  const cache = new Map();
  return (lora, hexes) => {
    const wanted = [...new Set(hexes.filter((h) => !cache.has(`${lora.id}|${h}`)))];
    if (wanted.length > 0) {
      const probe = {
        kind: 'image',
        format: 'svg',
        width: 8,
        height: 8,
        background: { color: '#000000' },
        shapes: wanted.map((color, i) => ({ type: 'rect', x: 0, y: 0, w: 1, h: 1, color, opacity: 1, z: i })),
      };
      const out = media.applyLora(world, probe, lora);
      wanted.forEach((color, i) => cache.set(`${lora.id}|${color}`, out.shapes[i].color));
    }
    return hexes.map((h) => cache.get(`${lora.id}|${h}`));
  };
}

// The seeded workspace/project inventory the agent reads over HTTP. Built from the
// API's own store, never from the ladder generator.
async function defaultProjectAssets(world) {
  const { createResourceStore, seedInitialData, listAssetsForProject, listWorkspaces, listProjects } =
    await import('../api/resources.js');
  const store = createResourceStore();
  seedInitialData(world, store, new Date(0).toISOString());
  return (workspaceName, projectName) => {
    const ws = listWorkspaces(store).find((w) => w.name === workspaceName);
    if (ws === undefined) fail('no such workspace', workspaceName);
    const project = listProjects(store, ws.id).find((p) => p.name === projectName);
    if (project === undefined) fail('no such project', projectName);
    return listAssetsForProject(store, project.id).map((a) => clone(a.descriptor));
  };
}

// firstDifference walks two values and reports the first leaf that differs.
export function firstDifference(a, b, path = '$') {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return { path, a, b };
    if (a.length !== b.length) return { path: `${path}.length`, a: a.length, b: b.length };
    for (let i = 0; i < a.length; i += 1) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (d !== null) return d;
    }
    return null;
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) {
      const d = firstDifference(a[k], b[k], `${path}.${k}`);
      if (d !== null) return d;
    }
    return null;
  }
  return Object.is(a, b) || a === b ? null : { path, a, b };
}
