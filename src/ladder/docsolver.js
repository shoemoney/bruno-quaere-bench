// docsolver.js -- Addendum I rule 4: a doc-only solver that gates every rung.
//
// Clean room. This file was written without reading src/ladder/grammar.js or
// src/ladder/rung.js. solve() computes a rung's expected descriptor from:
//   - docs/ARCHITECTURE.md (descriptor shapes)
//   - the generated skill (`quaere skill`, clean and sloppy) and `truthTable(world)`
//   - the generated OpenAPI document (`quaere spec`)
//   - the rung's own plain-language text
//   - black-box observation of the live API, which is what the climbing agent has
//
// solve() imports nothing from grammar.js, rung.js or media.js: every unit conversion,
// grid rounding, percent resize, opacity compounding, diff and z-order decision below is
// this file's own reading of the documents. Re-running the generator's own arithmetic
// would make the gate blind exactly where the reference gate already is (Addendum G's
// float bug, Addendum I's hidden Math.round).
//
// Two things cross that boundary, both by injection and both only inside gate():
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
// House arithmetic, stated in the skill
// ---------------------------------------------------------------------------

// Addendum G: snap the raw product to 6 decimals before any rounding rule runs.
export function snap6(value) {
  return Math.round(value * 1e6) / 1e6;
}

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

// The single rounding rule the whole house shares: grid size + direction from world.rules.
export function roundToGrid(value, roundTo, roundMode) {
  const v = snap6(value);
  const q = v / roundTo;
  if (roundMode === 'up') return Math.ceil(q) * roundTo;
  if (roundMode === 'down') return Math.floor(q) * roundTo;
  if (roundMode === 'nearest') return Math.round(q) * roundTo;
  return fail('unknown rounding direction', roundMode);
}

const grid = (world, value) => roundToGrid(value, world.rules.roundTo, world.rules.roundMode);

// Same grid rule without the 6-decimal snap. The snap is a house rule for unit-to-pixel
// conversion (Addendum G); the live house does NOT apply it inside a scale lora, so a
// product that lands an ulp above a grid line rounds up there. Observed, not documented.
function gridRaw(world, value) {
  const { roundTo, roundMode } = world.rules;
  const q = value / roundTo;
  if (roundMode === 'up') return Math.ceil(q) * roundTo;
  if (roundMode === 'down') return Math.floor(q) * roundTo;
  return Math.round(q) * roundTo;
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

// Pure, document-derived hue rotation. The skill states only the SPACE ("Color math
// ... is done in HSL/HSV space"); it does not state the channel-rounding convention,
// so this agrees with the live house everywhere except a handful of exact .5 ties per
// thousand colours. gate() therefore resolves hueShift/invert through a colour oracle
// (see makeColorOracle) and this stays the offline fallback.
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
// Descriptor operations, as the live API performs them
// ---------------------------------------------------------------------------

const clone = (d) => JSON.parse(JSON.stringify(d));

const GEOM = ['x', 'y', 'w', 'h', 'r', 'x2', 'y2'];

// A resize scales x/w/x2 by the width ratio and y/h/y2 by the height ratio; a radius,
// having only one axis, takes the mean of the two. Observed from the live house -- the
// skill states the grid rule for the TARGET size (below) but not the per-shape scaling.
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

function applyLora(world, desc, lora, ctx = {}) {
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
      for (const key of GEOM) if (s[key] !== undefined) s[key] = gridRaw(world, shape[key] * lora.amount);
    } else fail('unknown lora op', lora.op);
    return s;
  });
  out.lora = { id: lora.id, applied: true };
  return out;
}

// layer: the union of every descriptor's shapes on the FIRST descriptor's canvas, with
// the i-th descriptor's shapes faded by the house compounding rule (skill, "Opacity
// compounding"). Under explicit z-order the merged list is renumbered from 0.
function combineLayer(world, descs, step) {
  if (descs.length === 0) fail('combine with no inputs');
  const out = clone(descs[0]);
  delete out.lora;
  const shapes = [];
  // skill, "Opacity compounding": multiplicative houses use base * step**i, additive
  // houses use base - step*i, for the i-th layer counting from 0. Clamped to [0,1].
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

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function diffDescriptors(a, b) {
  const inB = new Set(b.shapes.map((s) => canonical(s)));
  const out = clone(a);
  delete out.lora;
  out.shapes = a.shapes.filter((s) => !inB.has(canonical(s))).map(clone);
  return out;
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
    const m = new RegExp(`^(?:${re.source !== undefined ? re.source : re})`, 's').exec(this.rest());
    if (m === null) return null;
    this.i += m[0].length;
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

function makeImage(world, w, h, unit, bgHex, shapes) {
  return {
    kind: 'image',
    format: world.rules.defaultFormat.image,
    width: grid(world, pxFromUnit(w, unit, world.rules.dpi)),
    height: grid(world, pxFromUnit(h, unit, world.rules.dpi)),
    background: { color: bgHex.toLowerCase() },
    shapes,
  };
}

const FORMAT_WORDS = { vector: 'svg', bitmap: 'png' };

// ---------------------------------------------------------------------------
// solve
// ---------------------------------------------------------------------------

export function solve(world, rungText, n, opts = {}) {
  const units = unitAlternation(world);
  const U = units.pattern;
  const c = new Cursor(rungText.trim());
  let current = null;
  let second = null;
  let batch = null;

  const imageClause = (lead) => new RegExp(
    `${lead}a picture (${NUM}) by (${NUM}) ?(${U}), on a (${HEX}) ground, carrying these, bottom of the pile first: (.*?)\\.(?= |$)`,
  );

  // optional "Inside a fresh <project> of your own making, over in the <workspace> the house calls "W", "
  c.try(/Inside a fresh \w+ of your own making, over in the \w+ the house calls "[^"]+", /);

  // batch opener
  const bm = c.try(new RegExp(
    'Work through the pictures held in the \\w+ the house calls "([^"]+)", over in the \\w+ the house calls "([^"]+)", '
    + '(\\d+) at a time(?: -- there are more of them to get through this time)?\\. '
    + 'Give the house style called "([^"]+)" to the first (\\d+) of them in the order the house lists them'
    + `(?:, then stack all of those into one, oldest at the bottom, fading each layer against the one below it with a stacking step of (${NUM}))?\\. `,
  ));
  if (bm !== null) {
    batch = { workspace: bm[2], project: bm[1], loraName: bm[4], count: +bm[5], step: bm[6] === undefined ? undefined : +bm[6] };
  } else {
    const am = c.try(new RegExp(
      `Make a short sound running (${NUM}) ms end to end and carrying these tones in order: (.*?)\\.(?= |$)`,
    ));
    if (am !== null) {
      current = {
        kind: 'audio',
        format: world.rules.defaultFormat.audio,
        sampleRate: world.rules.defaultSampleRate,
        durationMs: +am[1],
        notes: am[2].split('; ').map((raw) => {
          const item = raw.replace(/^\(\d+\) /, '');
          const m = new RegExp(`^(${NUM}) ms of (${NUM}) hertz starting (${NUM}) ms in, (${NUM}) percent loud, (\\w+)-shaped$`).exec(item);
          if (m === null) fail('unparsable tone phrase', item);
          return { freq: +m[2], startMs: +m[3], durMs: +m[1], amp: +m[4] / 100, wave: m[5] };
        }),
      };
    } else {
      const im = c.try(imageClause('[Mm]ake '));
      if (im === null) fail('no create clause at start of task', c.rest().slice(0, 120));
      current = makeImage(world, +im[1], +im[2], units.lookup.get(im[3]), im[4], parseShapeList(world, im[5]));
    }
  }
  c.try(/ /);

  // optional second picture + diff
  const sm = c.try(imageClause('Then make a second one: '));
  if (sm !== null) {
    second = makeImage(world, +sm[1], +sm[2], units.lookup.get(sm[3]), sm[4], parseShapeList(world, sm[5]));
    c.try(/ /);
    if (c.try(/Work out everything the first one has that the second one does not -- that leftover piece is what you carry on with\. ?/) === null) {
      fail('second picture with no diff instruction', c.rest().slice(0, 120));
    }
    current = diffDescriptors(current, second);
    c.try(/\(Ask for the first one back before you compare, and don't ask twice for the same thing you already have\.\) ?/);
  }

  // optional state-machine walk (no effect on the descriptor)
  c.try(/Walk it all the way through the house's usual stages -- lock it in, kick off the finishing run, and don't call it done until you check back and it actually says finished\. ?/);
  c.try(/Walk it through the house's usual stages until the finishing run is done, then sign and send the release notice the house requires before anything can go out the door\. ?/);

  // batch body
  if (batch !== null) {
    c.try(/Before you stack anything: pull that same listing as a spreadsheet instead of the usual reply, then clear out the last of the \d+ you just worked on -- (?:confirm it really is gone from the ordinary listing, and that it still turns up when you ask for the cleared-out ones as well|don't take the written reference's word for how the house confirms a clean-up, check what actually comes back, and make sure it is gone from the ordinary listing but still turns up when you ask for the cleared-out ones)\. ?/);
    const stack = c.try(new RegExp(`Then stack all of those into one, oldest at the bottom, fading each layer against the one below it with a stacking step of (${NUM})\\. ?`));
    if (stack !== null) batch.step = +stack[1];
    c.try(/The house's own compounding rule decides what that stacking step does to each layer\. ?/);

    if (typeof opts.listProjectAssets !== 'function') {
      fail('batch task needs opts.listProjectAssets(workspaceName, projectName)', `${batch.workspace} / ${batch.project}`);
    }
    const source = opts.listProjectAssets(batch.workspace, batch.project);
    if (!Array.isArray(source) || source.length < batch.count) {
      fail('batch listing too short', `${batch.project}: wanted ${batch.count}, got ${source && source.length}`);
    }
    const lora = findLora(world, batch.loraName);
    const stamped = source.slice(0, batch.count).map((d) => applyLora(world, d, lora, opts));
    current = combineLayer(world, stamped, batch.step);
  }

  // ordered step list
  const sl = c.try(/Then, in this order: (.*?)\.(?= (?:The house rounds|Turn in|Take nothing)|$)/);
  if (sl !== null) {
    for (const raw of sl[1].split('; ')) {
      current = applyStep(world, current, raw.replace(/^\(\d+\) /, ''), opts);
    }
    c.try(/ /);
  }

  // trailing boilerplate, none of which touches the descriptor
  c.try(/The house rounds every size to its usual grid; do that after every resize, in the order you do them, not just once at the end\. ?/);
  if (c.try(/Turn in exactly that piece\. ?/) === null && c.try(/Turn in the last piece that leaves you with\. ?/) === null) {
    fail('no "Turn in" clause', c.rest().slice(0, 120));
  }
  c.try(/Use a fresh repeat-safe request the house won't double-book if you send it twice\. ?/);
  c.try(/Take nothing here on the written reference's word: at least one thing it says about the calls this needs is wrong about the live house, so check what actually comes back\. ?/);

  if (!c.atEnd()) fail('unconsumed task text', c.rest().slice(0, 160));
  return [current];
}

function findLora(world, name) {
  const lora = world.loras.find((l) => l.name === name);
  if (lora === undefined) fail('no such house style in this world', name);
  return lora;
}

function applyStep(world, desc, phrase, ctx = {}) {
  let m;

  m = /^look up the house style called "([^"]+)" and give what you have that look$/.exec(phrase);
  if (m !== null) return applyLora(world, desc, findLora(world, m[1]), ctx);

  m = new RegExp(`^(shrink what you have down to|blow what you have up to) (${NUM}) percent of its own size, keeping its shape the same(?:, saved as a (vector|bitmap) file)?$`).exec(phrase);
  if (m !== null) {
    const pct = +m[2];
    const out = resizeImage(
      desc,
      grid(world, snap6((desc.width * pct) / 100)),
      grid(world, snap6((desc.height * pct) / 100)),
    );
    if (m[3] !== undefined) out.format = FORMAT_WORDS[m[3]];
    return out;
  }

  m = new RegExp(`^resize what you have so it comes out (${NUM}) by (${NUM}) pixels(?:, saved as a (vector|bitmap) file)?$`).exec(phrase);
  if (m !== null) {
    const out = resizeImage(desc, grid(world, +m[1]), grid(world, +m[2]));
    if (m[3] !== undefined) out.format = FORMAT_WORDS[m[3]];
    return out;
  }

  m = /^save what you have as a (vector|bitmap) file$/.exec(phrase);
  if (m !== null) return { ...clone(desc), format: FORMAT_WORDS[m[1]] };

  m = /^re-encode it as (plain wave audio|the compact house audio flavor)$/.exec(phrase);
  if (m !== null) return { ...clone(desc), format: m[1] === 'plain wave audio' ? 'wav' : 'qa8' };

  m = new RegExp(`^re-cut what you have to (${NUM}) samples a second$`).exec(phrase);
  if (m !== null) return { ...clone(desc), sampleRate: +m[1] };

  return fail('unparsable step phrase', phrase);
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
      doc = solve(world, rung.text, n, { listProjectAssets, colorOracle });
    } catch (err) {
      disagree.push({ n, leaf: 'solve', doc: null, key: null, error: `${err.name}: ${err.message}`, text: rung.text });
      continue;
    }
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
