// docsolver.js -- Addendum I rule 4: a doc-only solver that gates every rung.
//
// Clean room. This file was written without reading src/ladder/grammar.js,
// src/ladder/rung.js or src/ladder/reference.js. solve() computes a rung's expected
// descriptor from:
//   - docs/RULES-0.5.md (the enumerated house rules the key is allowed to depend on)
//   - docs/ARCHITECTURE.md (descriptor shapes)
//   - the generated skill (`quaere skill`, clean and sloppy) and `truthTable(world)`
//   - the generated OpenAPI document (`quaere spec`)
//   - the rung's own plain-language text
//   - black-box observation of the live API, which is what the climbing agent has
//
// solve() imports nothing from grammar.js, rung.js or media.js internals: every unit
// conversion, grid rounding, percent resize, opacity compounding, diff, stitch and
// z-order decision below is this file's own reading of the documents. Re-running the
// generator's own arithmetic would make the gate blind exactly where the reference gate
// already is (Addendum G's float bug, Addendum I's hidden Math.round).
//
// Three things cross that boundary, all by injection and all only inside gate():
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
//      0.5.0 cross-rung reference ("as wide and as tall as the piece you turned in at
//      step 18", RULES-0.5 rule 21) is resolved. It is the solver's own memory, never
//      the generator's: gate() fills it from solve()'s own earlier answers, exactly as
//      the climbing agent reads back its own collection on disk.
//
// Announced mutations (RULES-0.5 rule 26/27) never change the artifact, only the shape
// of the replies on the way there, so the warning sentence is parsed and consumed and
// has no effect on the descriptor. That IS the documented rule.
//
// solve(world, rungText, n, opts) -> Descriptor[]   (one per asset to submit)
// gate(world, from, to, opts)     -> {agree: n[], disagree: [{n, leaf, doc, key}]}

import { canonical } from '../canon.js';

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
// House arithmetic (RULES-0.5 rules 1-6)
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

// Rule 3: every stored size is rounded onto the house grid, house direction.
export function roundToGrid(value, roundTo, roundMode) {
  const v = snap6(value);
  const q = v / roundTo;
  if (roundMode === 'up') return Math.ceil(q) * roundTo;
  if (roundMode === 'down') return Math.floor(q) * roundTo;
  if (roundMode === 'nearest') return Math.round(q) * roundTo;
  return fail('unknown rounding direction', roundMode);
}

const grid = (world, value) => roundToGrid(value, world.rules.roundTo, world.rules.roundMode);

// THE ONE RULE THIS SOLVER USES THAT docs/RULES-0.5.md DOES NOT STATE.
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
// Nine rungs on seeds 1-20 are decided by this (seed 5 rung 90; seed 10 rungs 40, 77,
// 81, 84, 86, 88, 91, 93), so it is an Addendum I class gap: a key that turns on a rule
// absent from RULES-0.5.md. It is survivable for a climbing agent only because the agent
// POSTs to /{assets}/{id}/lora and reads the geometry back rather than computing it, the
// same way it reads a hue shift back. The fix belongs upstream -- either media.js snaps
// inside the scale lora, or RULES-0.5.md states that it does not. Until then this
// function models the house, and `gridAfterScale is load-bearing` in the test pins it so
// nobody deletes it without reading this.
export function gridAfterScale(world, value) {
  const { roundTo, roundMode } = world.rules;
  const q = value / roundTo;
  if (roundMode === 'up') return Math.ceil(q) * roundTo;
  if (roundMode === 'down') return Math.floor(q) * roundTo;
  return Math.round(q) * roundTo;
}

// Rule 5 + rule 20: percent resize is size x percent / 100, snapped, then gridded, floored at
// one whole grid step (Addendum M rebaselined rule 5's floor from bare `1` to `roundTo`: a floor
// of 1 is not itself on the grid whenever roundTo > 1, so the very next grid-rounding pass rule 3
// requires -- what a live resize does to any explicit pixel target next, stated or derived alike
// -- would round it straight back down to 0). A derived percentage goes through exactly the same
// arithmetic as a stated one.
function percentTarget(world, size, pct) {
  return Math.max(world.rules.roundTo, grid(world, snap6((size * pct) / 100)));
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
function applyLora(world, desc, lora, ctx = {}) {
  if (desc.kind !== 'image') fail('a house style was asked for on something that is not a picture', desc.kind);
  const out = clone(desc);
  const oracle = ctx.colorOracle;
  const recoloured = (lora.op === 'hueShift' || lora.op === 'invert') && typeof oracle === 'function'
    ? oracle(lora, desc.shapes.map((s) => s.color))
    : null;
  out.shapes = desc.shapes.map((shape, i) => {
    const s = clone(shape);
    if (lora.op === 'hueShift') s.color = recoloured ? recoloured[i] : shiftHue(shape.color, lora.amount, world.rules.colorShiftSpace);
    else if (lora.op === 'invert') s.color = recoloured ? recoloured[i] : invertHex(shape.color);
    else if (lora.op === 'opacity') s.opacity = shape.opacity * lora.amount;
    else if (lora.op === 'scale') {
      for (const key of GEOM) if (s[key] !== undefined) s[key] = gridAfterScale(world, shape[key] * lora.amount);
    } else fail('unknown lora op', lora.op);
    return s;
  });
  out.lora = { id: lora.id, applied: true };
  return out;
}

// Rule 10: stacking keeps the first one's canvas and ground and appends every later
// one's shapes on top in the order given, fading the i-th layer by the house's own
// compounding rule -- base * step**i (multiplicative) or base - step*i (additive),
// clamped between nothing and fully solid.
function combineLayer(world, descs, step) {
  if (descs.length === 0) fail('stacking with nothing to stack');
  const out = clone(descs[0]);
  delete out.lora;
  const shapes = [];
  descs.forEach((d, i) => {
    for (const shape of d.shapes) {
      const s = clone(shape);
      if (step !== undefined) {
        s.opacity = clamp01(world.rules.opacityCompound === 'multiplicative'
          ? shape.opacity * Math.pow(step, i)
          : shape.opacity - step * i);
      }
      shapes.push(s);
    }
  });
  if (world.rules.zOrder === 'explicit') shapes.forEach((s, i) => { s.z = i; });
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
function stitchClips(world, clips) {
  if (clips.length === 0) fail('stitching with nothing to stitch');
  const fps = clips[0].fps;
  let cursor = 0;
  const out = {
    kind: 'video',
    format: world.rules.defaultFormat.video,
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
// Parsing the plain-language task
// ---------------------------------------------------------------------------

const NUM = String.raw`-?\d+(?:\.\d+)?`;
const HEX = String.raw`#[0-9a-fA-F]{6}`;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function unitAlternation(world) {
  const entries = [];
  for (const [unit, words] of Object.entries(world.rules.unitWords)) {
    for (const w of words) entries.push([w, unit === 'inch' ? 'in' : unit]);
  }
  entries.push(['pixels', 'px']);
  entries.sort((a, b) => b[0].length - a[0].length);
  return {
    pattern: entries.map(([w]) => esc(w)).join('|'),
    lookup: new Map(entries),
  };
}

class Cursor {
  constructor(text) { this.text = text; this.i = 0; }
  rest() { return this.text.slice(this.i); }
  try(re) {
    const source = re.source !== undefined ? re.source : re;
    const m = new RegExp(`^(?:${source})`, 's').exec(this.rest());
    if (m === null) return null;
    this.i += m[0].length;
    this.try(/ +/);
    return m;
  }
  atEnd() { return this.rest().trim() === ''; }
}

const SHAPE_RES = [
  [/a circle of radius (NUM) centred (NUM) from the left and (NUM) from the top, painted (HEX) at (NUM) percent solid/,
    (m) => ({ type: 'circle', x: +m[2], y: +m[3], r: +m[1], color: m[4].toLowerCase(), opacity: +m[5] / 100 })],
  [/a rectangle (NUM) across and (NUM) down, its top-left corner (NUM) from the left and (NUM) from the top, painted (HEX) at (NUM) percent solid/,
    (m) => ({ type: 'rect', x: +m[3], y: +m[4], w: +m[1], h: +m[2], color: m[5].toLowerCase(), opacity: +m[6] / 100 })],
  [/a line running from \((NUM), (NUM)\) to \((NUM), (NUM)\), counting from the top-left corner, painted (HEX) at (NUM) percent solid/,
    (m) => ({ type: 'line', x: +m[1], y: +m[2], x2: +m[3], y2: +m[4], color: m[5].toLowerCase(), opacity: +m[6] / 100 })],
];

function parseShapeList(world, listText) {
  const items = listText.split('; ');
  const shapes = [];
  items.forEach((raw, idx) => {
    const item = raw.replace(/^\(\d+\) /, '');
    let shape = null;
    for (const [re, build] of SHAPE_RES) {
      const src = re.source.replace(/NUM/g, NUM).replace(/HEX/g, HEX);
      const m = new RegExp(`^${src}$`).exec(item);
      if (m !== null) { shape = build(m); break; }
    }
    if (shape === null) fail('unparsable shape phrase', item);
    if (world.rules.zOrder === 'explicit') shape.z = idx;
    shapes.push(shape);
  });
  return shapes;
}

function parseToneList(listText) {
  return listText.split('; ').map((raw) => {
    const item = raw.replace(/^\(\d+\) /, '');
    const m = new RegExp(`^(${NUM}) ms of (${NUM}) hertz starting (${NUM}) ms in, (${NUM}) percent loud, (\\w+)-shaped$`).exec(item);
    if (m === null) fail('unparsable tone phrase', item);
    return { freq: +m[2], startMs: +m[3], durMs: +m[1], amp: +m[4] / 100, wave: m[5] };
  });
}

const FORMAT_WORDS = { vector: 'svg', bitmap: 'png' };
const AUDIO_FORMAT_WORDS = { 'plain wave audio': 'wav', 'the compact house audio flavor': 'qa8' };

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

// ---------------------------------------------------------------------------
// solve
// ---------------------------------------------------------------------------

export function solve(world, rungText, n, opts = {}) {
  const units = unitAlternation(world);
  const U = units.pattern;
  const c = new Cursor(rungText.trim());

  // Working state. `current` is "what you have"; `counts` holds the derived numbers a
  // later chain step may ask for (RULES-0.5 rule 19).
  const state = { current: null, counts: {} };

  // --- opener: either a library haul or a create clause -----------------------
  if (!parseBatch(c, world, state, opts, U, units)) {
    parseCreateSection(c, world, state, opts, U, units);
  }

  // --- the house stages, signing, conditional writes (rules 23-25) ------------
  // None of them changes the artifact; a conditional write changes labels only.
  parseStages(c);

  // --- moving takes and the stitch (rules 16, 17, 19) ------------------------
  parseMovingTakes(c, world, state);

  // --- the one-step shorthand: "Then save it as a bitmap file." ---------------
  const shorthand = c.try(/Then save it as (a vector file|a bitmap file|plain wave audio|the compact house audio flavor)\./);
  if (shorthand !== null) {
    const word = shorthand[1];
    state.current = applyStep(
      world,
      state.current,
      word.startsWith('a ') ? `save what you have as ${word}` : `re-encode it as ${word}`,
      state,
      opts,
    );
  }

  // --- the ordered chain ------------------------------------------------------
  const sl = c.try(/Then, in this order: ([^.]*)\./);
  if (sl !== null) {
    for (const raw of sl[1].split('; ')) {
      state.current = applyStep(world, state.current, raw.replace(/^\(\d+\) /, ''), state, opts);
    }
  }

  // --- trailing notes, none of which touches the descriptor -------------------
  parseTrailing(c);

  if (!c.atEnd()) fail('unconsumed task text', c.rest().slice(0, 200));
  if (state.current === null) fail('task produced nothing to turn in', rungText.slice(0, 120));
  return [state.current];
}

// --- the library haul (RULES-0.5 appendix "library haul") --------------------
function parseBatch(c, world, state, opts, U, units) {
  const opener = c.try(new RegExp(
    'Work through the pictures held in the \\w+ the house calls "([^"]+)", over in the \\w+ the house calls "([^"]+)", '
    + '(\\d+) at a time(?: -- there are more of them to get through this time)?\\.',
  ));
  if (opener === null) return false;

  const projectName = opener[1];
  const workspaceName = opener[2];

  const give = c.try(new RegExp(
    'Give the house style called "([^"]+)" to the first (\\d+) of them in the order the house lists them'
    + `(?:, then stack all of those into one, oldest at the bottom, fading each layer against the one below it with a stacking step of (${NUM}))?\\.`,
  ));
  if (give === null) fail('library haul with no "give the house style" clause', c.rest().slice(0, 160));
  const loraName = give[1];
  const count = +give[2];
  let step = give[3] === undefined ? undefined : +give[3];

  // "Pull that same listing as a spreadsheet instead of the usual reply, then stack ..."
  const csvStack = c.try(new RegExp(
    'Pull that same listing as a spreadsheet instead of the usual reply, then stack all of those into one, '
    + `oldest at the bottom, fading each layer against the one below it with a stacking step of (${NUM})\\.`,
  ));
  if (csvStack !== null) step = +csvStack[1];

  // the clear-out, in either of its two announced spellings
  const CLEAR_TAIL = 'of the copies you just made -- confirm they really are gone from the ordinary listing, '
    + 'and that they still turn up when you ask for the cleared-out ones as well -- and then count how many of '
    + 'your copies are still standing in the ordinary listing, remembering it comes back a page at a time'
    + "(?:; don't take the written reference's word for how the house confirms a clean-up, check what actually comes back)?\\.";
  let cleared = null;
  const clearA = c.try(new RegExp(`Then clear out the last (one|\\d+ of them) ${CLEAR_TAIL}`));
  if (clearA !== null) cleared = clearA[1];
  else {
    const clearB = c.try(new RegExp(`Pull that listing as a spreadsheet too, and clear out the last (one|\\d+ of them) ${CLEAR_TAIL}`));
    if (clearB !== null) cleared = clearB[1];
  }

  c.try(/The house's own compounding rule decides what that stacking step does to each layer\./);

  if (typeof opts.listProjectAssets !== 'function') {
    fail('a library haul needs opts.listProjectAssets(workspaceName, projectName)', `${workspaceName} / ${projectName}`);
  }
  const source = opts.listProjectAssets(workspaceName, projectName);
  if (!Array.isArray(source) || source.length < count) {
    fail('library listing too short', `${projectName}: wanted ${count}, got ${source && source.length}`);
  }
  const lora = findLora(world, loraName);
  const stamped = source.slice(0, count).map((d) => applyLora(world, d, lora, opts));
  const stack = combineLayer(world, stamped, step);

  state.counts.stackShapes = stack.shapes.length;
  if (cleared !== null) {
    // Rule 19: how many of the copies THIS rung made are still visible in the ordinary
    // listing after this rung's own clear-out.
    const removed = cleared === 'one' ? 1 : Number(/^\d+/.exec(cleared)[0]);
    state.counts.standingCopies = count - removed;
  }
  state.current = stack;

  c.try(/Keep that stack to one side; you are going to need to know what is on it\./);

  // "Now make a picture ..." replaces the working piece; the stack stays only as a count.
  const now = tryImageClause(c, world, state, opts, U, units, LEAD_NOW);
  if (now !== null) state.current = now;
  return true;
}

// --- the create section ------------------------------------------------------
function parseCreateSection(c, world, state, opts, U, units) {
  const audio = c.try(new RegExp(
    `Make a short sound running (${NUM}) ms end to end and carrying these tones in order: (.*?)\\.(?= |$)`,
  ));
  if (audio !== null) {
    state.current = {
      kind: 'audio',
      format: world.rules.defaultFormat.audio,
      sampleRate: world.rules.defaultSampleRate,
      durationMs: +audio[1],
      notes: parseToneList(audio[2]),
    };

    // optional second sound + the sound difference (rules 15, 19)
    const second = c.try(new RegExp(
      `Then make a second sound running (${NUM}) ms end to end and carrying these tones in order: (.*?)\\.(?= |$)`,
    ));
    if (second !== null) {
      const other = {
        kind: 'audio',
        format: state.current.format,
        sampleRate: state.current.sampleRate,
        durationMs: +second[1],
        notes: parseToneList(second[2]),
      };
      const reenc = c.try(new RegExp(
        'Work out every tone the first sound has that the second one does not -- that leftover sound is the one '
        + `that matters later -- and re-encode it as (plain wave audio|the compact house audio flavor) at (\\d+) samples a second\\.`,
      ));
      if (reenc === null) fail('second sound with no difference instruction', c.rest().slice(0, 160));
      const leftover = diffAudio(state.current, other);
      leftover.format = AUDIO_FORMAT_WORDS[reenc[1]];
      leftover.sampleRate = +reenc[2];
      state.counts.leftoverTones = leftover.notes.length;
      state.current = leftover;
    }

    // "Then, inside a fresh <project> ..., make a picture ..." -- the picture becomes
    // the working piece; the leftover sound survives only as a count.
    const pic = tryImageClause(c, world, state, opts, U, units, LEAD_AFTER_SOUND);
    if (pic !== null) state.current = pic;
    return;
  }

  const first = tryImageClause(c, world, state, opts, U, units, LEAD_FIRST);
  if (first === null) fail('no create clause at start of task', c.rest().slice(0, 160));
  state.current = first;

  // optional second picture + the picture difference (rules 11, 19)
  const second = tryImageClause(c, world, state, opts, U, units, LEAD_SECOND);
  if (second !== null) {
    if (c.try(/Work out everything the first one has that the second one does not -- that leftover piece is what you carry on with\./) === null) {
      fail('second picture with no difference instruction', c.rest().slice(0, 160));
    }
    state.current = diffImages(state.current, second);
    state.counts.leftoverShapes = state.current.shapes.length;
    c.try(/\(Ask for the first one back before you compare, and don't ask twice for the same thing you already have\.\)/);
  }
}

// The four announced leads a create-a-picture clause can arrive under.
const IN_A_FRESH = '(?:inside|Inside) a fresh \\w+ of your own making, over in the \\w+ the house calls "[^"]+", make ';
const LEAD_FIRST = `(?:${IN_A_FRESH}|Make )`;
const LEAD_SECOND = 'Then make a second one: ';
const LEAD_NOW = 'Now make ';
const LEAD_AFTER_SOUND = `Then, ${IN_A_FRESH}`;

// A create-a-picture clause. `lead` is the complete, non-optional prefix regex.
function tryImageClause(c, world, state, opts, U, units, lead) {
  const SIZE = `(?:(${NUM}) by (${NUM}) ?(${U})|as wide and as tall as the piece you turned in at step (\\d+))`;
  const GROUND = `(?:on a (${HEX}) ground|on the same ground colour as the piece you turned in at step (\\d+))`;
  const m = c.try(new RegExp(
    `${lead}a picture ${SIZE}, ${GROUND}, carrying these, bottom of the pile first: (.*?)\\.(?= |$)`,
  ));
  if (m === null) return null;

  let width;
  let height;
  if (m[3] !== undefined) {
    const unit = units.lookup.get(m[3]);
    if (unit === undefined) fail('unknown unit word', m[3]);
    width = grid(world, pxFromUnit(+m[1], unit, world.rules.dpi));
    height = grid(world, pxFromUnit(+m[2], unit, world.rules.dpi));
  } else {
    // Rule 21/22: a recalled size is already on the house grid.
    const size = recall(opts, Number(m[4]), 'size');
    width = grid(world, size.width);
    height = grid(world, size.height);
  }

  const background = m[5] !== undefined
    ? { color: m[5].toLowerCase() }
    : { color: recall(opts, Number(m[6]), 'ground') };

  return {
    kind: 'image',
    format: world.rules.defaultFormat.image,
    width,
    height,
    background,
    shapes: parseShapeList(world, m[7]),
  };
}

// --- house stages, signing, conditional writes (rules 23-25) -----------------
// Every one of these is process, not artifact: they change nothing about the
// descriptor, which is the whole point of rule 25's "never changes the thing's
// contents or its hash".
const STAGE_SENTENCES = [
  /Walk it all the way through the house stages in the house order -- lock it in, kick off the finishing run, and do not call it done until you check back and it actually says finished\./,
  /Walk it all the way through the house's usual stages -- lock it in, kick off the finishing run, and don't call it done until you check back and it actually says finished\./,
  /If you reach for a stage out of turn the house will refuse you; take the refusal, put the missing stage in, and carry on\./,
  /Then sign and send the release notice the house requires before anything can go out the door\./,
  /Once it is finished, write a word of your own onto it -- and do it in a way that will fail rather than overwrite if anyone touched it between your reading it and your writing\./,
];

function parseStages(c) {
  let moved = true;
  while (moved) {
    moved = false;
    for (const re of STAGE_SENTENCES) if (c.try(re) !== null) { moved = true; break; }
  }
}

// --- moving takes and the stitch (rules 16, 17) ------------------------------
function parseMovingTakes(c, world, state) {
  const TAKE = `one running (${NUM}) ms, (${NUM}) by (${NUM}) pixels, showing that picture from its very start for the whole of it, at full strength`;
  const m = c.try(new RegExp(
    `Then build a pair of short moving takes over that same finished picture: \\(1\\) ${TAKE}; \\(2\\) ${TAKE}\\.`,
  ));
  if (m === null) return;
  if (c.try(/Don't tell the house how fast to run them -- let it use its own usual speed\./) === null) {
    fail('moving takes with no frame-rate instruction', c.rest().slice(0, 160));
  }
  if (c.try(/Stitch the two end to end, first one first, into a single moving piece\./) === null) {
    fail('moving takes with no stitch instruction', c.rest().slice(0, 160));
  }
  // Rule 9: nobody said how fast, so the house default frame rate applies.
  const fps = world.rules.defaultFps;
  const takes = [[+m[1], +m[2], +m[3]], [+m[4], +m[5], +m[6]]].map(([durationMs, width, height]) => ({
    kind: 'video',
    format: world.rules.defaultFormat.video,
    width,
    height,
    fps,
    durationMs,
    clips: [{ startMs: 0, durMs: durationMs, opacity: 1 }],
  }));
  const stitched = stitchClips(world, takes);
  state.counts.stitchedFrames = frameCount(stitched);
  // The stitched clip is a measuring stick, not the artifact: the chain that follows
  // says "save what you have as a vector file", so "what you have" is still the picture.
}

// --- trailing notes ----------------------------------------------------------
const TRAILING_SENTENCES = [
  /The house rounds every size to its usual grid; do that after every resize, in the order you do them, not just once at the end\./,
  /Order is the whole game here: a house style and a resize do not commute, and the grid rounding lands again after every single step\./,
  /Do these one at a time, in exactly the order written, reading each new size back off what the house hands you -- never fold two of them into one call and never carry a size forward in your head\./,
  /Use a fresh repeat-safe request the house won't double-book if you send it twice\./,
  /Take nothing here on the written reference's word: at least one thing it says about the calls this needs is wrong about the live house, so check what actually comes back\./,
  // Rule 26/27: an announced change never alters what the finished artifact should be.
  /Fair warning: the house has changed something about the way it answers, starting with this piece of work\./,
  /Nobody will tell you what\./,
  /Read what actually comes back on every call rather than what you expected to come back\./,
];

function parseTrailing(c) {
  let turnedIn = false;
  let moved = true;
  while (moved) {
    moved = false;
    if (c.try(/Turn in exactly that piece\./) !== null || c.try(/Turn in the last piece that leaves you with\./) !== null) {
      turnedIn = true;
      moved = true;
      continue;
    }
    for (const re of TRAILING_SENTENCES) if (c.try(re) !== null) { moved = true; break; }
  }
  if (!turnedIn) {
    // Distinguish the two ways this goes wrong: a sentence the solver has no rule for
    // sitting in front of the turn-in, versus a task that never says to turn anything in.
    const rest = c.rest().trim();
    if (/Turn in /.test(rest)) fail('unconsumed task text before the "Turn in" clause', rest.slice(0, 200));
    fail('no "Turn in" clause', rest.slice(0, 200));
  }
}

function findLora(world, name) {
  const lora = world.loras.find((l) => l.name === name);
  if (lora === undefined) fail('no such house style in this world', name);
  return lora;
}

// --- the derived number (rules 18, 19, 20) ----------------------------------
const COUNT_PHRASES = [
  ['every shape left on that leftover piece', 'leftoverShapes'],
  ['every shape on the stack you just built', 'stackShapes'],
  ['every tone left over when you took the second sound out of the first', 'leftoverTones'],
  ['every frame in the stitched clip', 'stitchedFrames'],
  ['every copy of yours still standing in that listing once the cleared-out ones are left out', 'standingCopies'],
];

function derivedCount(state, phrase) {
  for (const [text, key] of COUNT_PHRASES) {
    if (text === phrase) {
      const value = state.counts[key];
      if (value === undefined) fail('the task counts something this rung never produced', phrase);
      return value;
    }
  }
  return fail('unknown thing to count in a derived percentage', phrase);
}

// --- one step of the ordered chain ------------------------------------------
function applyStep(world, desc, phrase, state, ctx = {}) {
  if (desc === null) fail('a chain step with nothing to work on', phrase);
  let m;

  m = /^look up the house style called "([^"]+)" and give what you have that look$/.exec(phrase);
  if (m !== null) return applyLora(world, desc, findLora(world, m[1]), ctx);

  const SAVED = '(?:, saved as a (vector|bitmap) file)?';

  m = new RegExp(`^(?:shrink what you have down to|blow what you have up to) (${NUM}) percent of its own size, keeping its shape the same${SAVED}$`).exec(phrase);
  if (m !== null) return resizePercent(world, desc, +m[1], m[2]);

  m = new RegExp(
    '^(?:shrink what you have down to|blow what you have up to) a percentage of its own size you have to work out like this '
    + `-- start at (${NUM}) and take (${NUM}) off for (.+?) -- keeping its shape the same${SAVED}$`,
  ).exec(phrase);
  if (m !== null) {
    // Rule 18: base minus per-item take, times how many there are.
    const pct = +m[1] - +m[2] * derivedCount(state, m[3]);
    return resizePercent(world, desc, pct, m[4]);
  }

  m = new RegExp(`^resize what you have so it comes out (${NUM}) by (${NUM}) pixels${SAVED}$`).exec(phrase);
  if (m !== null) {
    if (desc.kind !== 'image') fail('a resize was asked for on something that is not a picture', desc.kind);
    const out = resizeImage(desc, grid(world, +m[1]), grid(world, +m[2]));
    if (m[3] !== undefined) out.format = FORMAT_WORDS[m[3]];
    return out;
  }

  m = /^save what you have as a (vector|bitmap) file$/.exec(phrase);
  if (m !== null) return { ...clone(desc), format: FORMAT_WORDS[m[1]] };

  m = /^re-encode it as (plain wave audio|the compact house audio flavor)$/.exec(phrase);
  if (m !== null) return { ...clone(desc), format: AUDIO_FORMAT_WORDS[m[1]] };

  m = new RegExp(`^re-cut what you have to (${NUM}) samples a second$`).exec(phrase);
  // Rule 14: re-cutting a sound to another sample rate changes neither its tones nor
  // its length.
  if (m !== null) return { ...clone(desc), sampleRate: +m[1] };

  return fail('unparsable step phrase', phrase);
}

function resizePercent(world, desc, pct, savedAs) {
  if (desc.kind !== 'image') fail('a percent resize was asked for on something that is not a picture', desc.kind);
  const out = resizeImage(desc, percentTarget(world, desc.width, pct), percentTarget(world, desc.height, pct));
  if (savedAs !== undefined) out.format = FORMAT_WORDS[savedAs];
  return out;
}

// ---------------------------------------------------------------------------
// gate
// ---------------------------------------------------------------------------

// gate(world, from, to): compare solve() against the generator's answer key.
// makeRung is imported dynamically HERE and nowhere else, so solve() stays clean-room.
export async function gate(world, from = 0, to = 99, opts = {}) {
  const { makeRung } = await import('./rung.js');
  const listProjectAssets = opts.listProjectAssets || (await defaultProjectAssets(world));
  const colorOracle = opts.colorOracle === null ? undefined : (opts.colorOracle || (await makeColorOracle(world)));
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
      history.set(n, solve(world, pre.text, n, { listProjectAssets, colorOracle, history })[0]);
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
    let doc;
    try {
      doc = solve(world, rung.text, n, { listProjectAssets, colorOracle, history });
    } catch (err) {
      disagree.push({ n, leaf: 'solve', doc: null, key: null, error: `${err.name}: ${err.message}`, text: rung.text });
      continue;
    }
    history.set(n, doc[doc.length - 1]);
    const key = rung.expectedDescriptors;
    const leaf = firstDifference(doc, key);
    if (leaf === null) agree.push(n);
    else disagree.push({ n, leaf: leaf.path, doc: leaf.a, key: leaf.b, text: rung.text });
  }
  return { agree, disagree };
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
