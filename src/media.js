// Media descriptor algebra: create/convert/combine/diff/lora/fidelity/validate.
// Every function here is pure: descriptor in (or params in), descriptor out. No bytes, no I/O.
// Rendering descriptors to bytes lives in render/*.js.

import { makeWorld } from './world.js';
import { canonical } from './canon.js';

// world is always the first argument to every exported function here. Callers normally pass a
// real World from world.js; the default below only exists so these functions are usable/testable
// on their own without wiring one up, and it stays deterministic (fixed seed, no wall clock).
const DEFAULT_SEED = 0;
const defaultWorld = () => makeWorld(DEFAULT_SEED);

export class MediaValidationError extends Error {
  constructor(errors) {
    super('media validation failed');
    this.name = 'MediaValidationError';
    this.errors = errors;
  }
}

// ---------------------------------------------------------------------------
// small numeric / grid helpers
// ---------------------------------------------------------------------------

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function inRange01(v) {
  return isNum(v) && v >= 0 && v <= 1;
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

// Addendum G: snap a raw (pre-rounding) product to 6 decimal places. Seed 220 rung 0 found
// 0.56in x 300dpi = 168.00000000000003 in IEEE-754 -- indistinguishable from 168 to any human
// and to exact (integer) arithmetic, but enough for `roundToGrid`'s ceil/floor to jump a whole
// extra grid step (roundTo=2, mode=up: raw/2 = 84.00000000000001, Math.ceil -> 85 -> 170, instead
// of the exact 84 -> 168). Every unit-to-pixel conversion snaps here, before any rounding rule
// runs, so the API, the reference (which only ever calls through this same function via the live
// API), and this module's own answer-key computation all agree byte for byte with what integer
// arithmetic would give.
export function snap6(value) {
  return Math.round(value * 1e6) / 1e6;
}

// Convert a value given in a house unit to px at the given dpi. `unit` must already be a
// canonical unit code ('in'|'cm'|'pt') - resolving skill-defined synonym words to that code is
// the caller's job (the skill/API layer), not this module's. Exported so the ladder generator
// (grammar.js) can check, at compose time and with the exact same arithmetic, whether a candidate
// dimension it is about to draw would land within 1e-6px of a grid boundary (see snap6's comment)
// and redraw instead -- without media.js and the generator drifting into two slightly different
// notions of "the exact product".
export function pxFromUnit(value, unit, dpi) {
  let raw;
  if (unit === 'in') raw = value * dpi;
  else if (unit === 'cm') raw = (value / 2.54) * dpi;
  else if (unit === 'pt') raw = (value / 72) * dpi;
  else throw new Error(`unknown unit code: ${unit}`);
  return snap6(raw);
}

// Round `value` to the nearest multiple of `step` (default 1, i.e. plain integer px), per mode.
// Exported (Addendum I) so grammar.js's percentOfDims compute uses this exact function -- the
// same one the API and every other conversion path apply -- instead of a parallel Math.round.
export function roundToGrid(value, step = 1, mode = 'nearest') {
  const s = step > 0 ? step : 1;
  const q = value / s;
  let rounded;
  if (mode === 'up') rounded = Math.ceil(q);
  else if (mode === 'down') rounded = Math.floor(q);
  else rounded = Math.round(q);
  return rounded * s;
}

function resolveDim(world, value, unit) {
  const px = unit !== undefined ? pxFromUnit(value, unit, world.rules.dpi) : value;
  return roundToGrid(px, world.rules.roundTo, world.rules.roundMode);
}

// ---------------------------------------------------------------------------
// color: hex <-> rgb <-> hsl / hsv
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function clampByte(v) {
  return Math.min(255, Math.max(0, Math.round(v)));
}

function rgbToHex({ r, g, b }) {
  const toHex = (v) => clampByte(v).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function rgbToHsl({ r, g, b }) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  return { h, s: s * 100, l: l * 100 };
}

function hslToRgb({ h, s, l }) {
  const sn = s / 100;
  const ln = l / 100;
  if (sn === 0) {
    const v = ln * 255;
    return { r: v, g: v, b: v };
  }
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  const hk = ((h % 360) + 360) % 360 / 360;
  const toChannel = (t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return {
    r: toChannel(hk + 1 / 3) * 255,
    g: toChannel(hk) * 255,
    b: toChannel(hk - 1 / 3) * 255,
  };
}

function rgbToHsv({ r, g, b }) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  const v = max;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
  }
  return { h, s: s * 100, v: v * 100 };
}

function hsvToRgb({ h, s, v }) {
  const sn = s / 100;
  const vn = v / 100;
  const c = vn * sn;
  const hk = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hk % 2) - 1));
  const m = vn - c;
  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (hk < 1) { rp = c; gp = x; }
  else if (hk < 2) { rp = x; gp = c; }
  else if (hk < 3) { gp = c; bp = x; }
  else if (hk < 4) { gp = x; bp = c; }
  else if (hk < 5) { rp = x; bp = c; }
  else { rp = c; bp = x; }
  return { r: (rp + m) * 255, g: (gp + m) * 255, b: (bp + m) * 255 };
}

function shiftHue(hex, amount, space) {
  const rgb = hexToRgb(hex);
  if (space === 'hsv') {
    const hsv = rgbToHsv(rgb);
    hsv.h = ((hsv.h + amount) % 360 + 360) % 360;
    return rgbToHex(hsvToRgb(hsv));
  }
  const hsl = rgbToHsl(rgb);
  hsl.h = ((hsl.h + amount) % 360 + 360) % 360;
  return rgbToHex(hslToRgb(hsl));
}

function invertHex(hex) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex({ r: 255 - r, g: 255 - g, b: 255 - b });
}

// ---------------------------------------------------------------------------
// validation (shared by validate() and create())
// ---------------------------------------------------------------------------

const IMAGE_FORMATS = new Set(['svg', 'png']);
const AUDIO_FORMATS = new Set(['wav', 'qa8']);
const VIDEO_FORMATS = new Set(['qvid']);
const SHAPE_TYPES = new Set(['rect', 'circle', 'line']);
const WAVE_TYPES = new Set(['sine', 'square', 'saw', 'triangle']);
const UNITS = new Set(['in', 'cm', 'pt']);
const SAMPLE_RATES = new Set([22050, 44100, 48000]);
const FPS_VALUES = new Set([12, 24, 30]);
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function collectErrors(world, kind, params) {
  const errors = [];
  if (kind !== 'image' && kind !== 'audio' && kind !== 'video') {
    errors.push({ field: 'kind', message: 'kind must be one of image, audio, video' });
    return errors;
  }
  if (!params || typeof params !== 'object') {
    errors.push({ field: 'params', message: 'params must be an object' });
    return errors;
  }
  if (kind === 'image') collectImageErrors(world, params, errors);
  else if (kind === 'audio') collectAudioErrors(params, errors);
  else collectVideoErrors(world, params, errors);
  return errors;
}

function collectImageErrors(world, params, errors) {
  if (params.unit !== undefined && !UNITS.has(params.unit)) {
    errors.push({ field: 'unit', message: `unit must be one of ${[...UNITS].join(', ')}` });
  }
  requireDim(params, 'width', errors);
  requireDim(params, 'height', errors);
  if (params.format !== undefined && !IMAGE_FORMATS.has(params.format)) {
    errors.push({ field: 'format', message: `format must be one of ${[...IMAGE_FORMATS].join(', ')}` });
  }
  collectBackgroundErrors(params.background, errors);

  const shapes = params.shapes;
  if (shapes !== undefined && !Array.isArray(shapes)) {
    errors.push({ field: 'shapes', message: 'shapes must be an array' });
  } else if (Array.isArray(shapes)) {
    shapes.forEach((shape, i) => collectShapeErrors(world, shape, i, errors));
  }
}

function requireDim(params, field, errors) {
  const v = params[field];
  if (v === undefined) errors.push({ field, message: `${field} is required` });
  else if (!isNum(v) || v <= 0) errors.push({ field, message: `${field} must be a positive number` });
}

function collectBackgroundErrors(bg, errors) {
  if (bg === undefined || bg === null || typeof bg !== 'object') {
    errors.push({ field: 'background', message: 'background is required' });
    return;
  }
  const hasColor = bg.color !== undefined;
  const hasTransparent = bg.transparent !== undefined;
  if (hasColor && hasTransparent) {
    errors.push({ field: 'background', message: 'background.color and background.transparent are mutually exclusive' });
    return;
  }
  if (hasColor) {
    if (typeof bg.color !== 'string' || !HEX_RE.test(bg.color)) {
      errors.push({ field: 'background.color', message: 'background.color must be a 6-digit hex color' });
    }
    return;
  }
  if (hasTransparent) {
    if (bg.transparent !== true) {
      errors.push({ field: 'background.transparent', message: 'background.transparent must be true' });
    }
    return;
  }
  errors.push({ field: 'background', message: 'background requires color or transparent' });
}

function collectShapeErrors(world, shape, i, errors) {
  const p = `shapes.${i}`;
  if (!shape || typeof shape !== 'object') {
    errors.push({ field: p, message: 'shape must be an object' });
    return;
  }
  if (!SHAPE_TYPES.has(shape.type)) {
    errors.push({ field: `${p}.type`, message: `type must be one of ${[...SHAPE_TYPES].join(', ')}` });
  }
  if (!isNum(shape.x)) errors.push({ field: `${p}.x`, message: 'x is required and must be a number' });
  if (!isNum(shape.y)) errors.push({ field: `${p}.y`, message: 'y is required and must be a number' });
  if (typeof shape.color !== 'string' || !HEX_RE.test(shape.color)) {
    errors.push({ field: `${p}.color`, message: 'color must be a 6-digit hex color' });
  }
  if (shape.opacity !== undefined && !inRange01(shape.opacity)) {
    errors.push({ field: `${p}.opacity`, message: 'opacity must be between 0 and 1' });
  }
  if (shape.type === 'rect') {
    if (!isNum(shape.w) || shape.w <= 0) errors.push({ field: `${p}.w`, message: 'w is required for rect' });
    if (!isNum(shape.h) || shape.h <= 0) errors.push({ field: `${p}.h`, message: 'h is required for rect' });
  } else if (shape.type === 'circle') {
    if (!isNum(shape.r) || shape.r <= 0) errors.push({ field: `${p}.r`, message: 'r is required for circle' });
  } else if (shape.type === 'line') {
    if (!isNum(shape.x2)) errors.push({ field: `${p}.x2`, message: 'x2 is required for line' });
    if (!isNum(shape.y2)) errors.push({ field: `${p}.y2`, message: 'y2 is required for line' });
  }
  if (world.rules.zOrder === 'explicit' && shape.z === undefined) {
    errors.push({ field: `${p}.z`, message: 'z is required when zOrder is explicit' });
  }
}

function collectAudioErrors(params, errors) {
  if (params.format !== undefined && !AUDIO_FORMATS.has(params.format)) {
    errors.push({ field: 'format', message: `format must be one of ${[...AUDIO_FORMATS].join(', ')}` });
  }
  if (params.sampleRate !== undefined && !SAMPLE_RATES.has(params.sampleRate)) {
    errors.push({ field: 'sampleRate', message: `sampleRate must be one of ${[...SAMPLE_RATES].join(', ')}` });
  }
  if (params.durationMs === undefined) {
    errors.push({ field: 'durationMs', message: 'durationMs is required' });
  } else if (!isNum(params.durationMs) || params.durationMs < 0) {
    errors.push({ field: 'durationMs', message: 'durationMs must be a non-negative number' });
  }
  const notes = params.notes;
  if (notes !== undefined && !Array.isArray(notes)) {
    errors.push({ field: 'notes', message: 'notes must be an array' });
  } else if (Array.isArray(notes)) {
    notes.forEach((n, i) => collectNoteErrors(n, i, errors));
  }
}

function collectNoteErrors(note, i, errors) {
  const p = `notes.${i}`;
  if (!note || typeof note !== 'object') {
    errors.push({ field: p, message: 'note must be an object' });
    return;
  }
  if (!isNum(note.freq) || note.freq <= 0) errors.push({ field: `${p}.freq`, message: 'freq must be a positive number' });
  if (!isNum(note.startMs) || note.startMs < 0) errors.push({ field: `${p}.startMs`, message: 'startMs must be a non-negative number' });
  if (!isNum(note.durMs) || note.durMs <= 0) errors.push({ field: `${p}.durMs`, message: 'durMs must be a positive number' });
  if (note.amp !== undefined && !inRange01(note.amp)) {
    errors.push({ field: `${p}.amp`, message: 'amp must be between 0 and 1' });
  }
  if (note.wave !== undefined && !WAVE_TYPES.has(note.wave)) {
    errors.push({ field: `${p}.wave`, message: `wave must be one of ${[...WAVE_TYPES].join(', ')}` });
  }
}

function collectVideoErrors(world, params, errors) {
  if (params.unit !== undefined && !UNITS.has(params.unit)) {
    errors.push({ field: 'unit', message: `unit must be one of ${[...UNITS].join(', ')}` });
  }
  requireDim(params, 'width', errors);
  requireDim(params, 'height', errors);
  if (params.format !== undefined && !VIDEO_FORMATS.has(params.format)) {
    errors.push({ field: 'format', message: `format must be one of ${[...VIDEO_FORMATS].join(', ')}` });
  }
  if (params.fps !== undefined && !FPS_VALUES.has(params.fps)) {
    errors.push({ field: 'fps', message: `fps must be one of ${[...FPS_VALUES].join(', ')}` });
  }
  if (params.durationMs === undefined) {
    errors.push({ field: 'durationMs', message: 'durationMs is required' });
  } else if (!isNum(params.durationMs) || params.durationMs < 0) {
    errors.push({ field: 'durationMs', message: 'durationMs must be a non-negative number' });
  }
  const clips = params.clips;
  if (clips !== undefined && !Array.isArray(clips)) {
    errors.push({ field: 'clips', message: 'clips must be an array' });
  } else if (Array.isArray(clips)) {
    clips.forEach((c, i) => collectClipErrors(world, c, i, errors));
  }
  if (params.audio !== undefined && params.audio !== null) {
    if (typeof params.audio.assetId !== 'string' || params.audio.assetId.length === 0) {
      errors.push({ field: 'audio.assetId', message: 'audio.assetId must be a non-empty string' });
    }
  }
}

function collectClipErrors(world, clip, i, errors) {
  const p = `clips.${i}`;
  if (!clip || typeof clip !== 'object') {
    errors.push({ field: p, message: 'clip must be an object' });
    return;
  }
  if (typeof clip.assetId !== 'string' || clip.assetId.length === 0) {
    errors.push({ field: `${p}.assetId`, message: 'assetId must be a non-empty string' });
  }
  if (!isNum(clip.startMs) || clip.startMs < 0) errors.push({ field: `${p}.startMs`, message: 'startMs must be a non-negative number' });
  if (!isNum(clip.durMs) || clip.durMs <= 0) errors.push({ field: `${p}.durMs`, message: 'durMs must be a positive number' });
  if (clip.opacity !== undefined && !inRange01(clip.opacity)) {
    errors.push({ field: `${p}.opacity`, message: 'opacity must be between 0 and 1' });
  }
  if (world.rules.zOrder === 'explicit' && clip.z === undefined) {
    errors.push({ field: `${p}.z`, message: 'z is required when zOrder is explicit' });
  }
}

export function validate(world = defaultWorld(), kind, params) {
  const errors = collectErrors(world, kind, params);
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export function create(world = defaultWorld(), kind, params) {
  const errors = collectErrors(world, kind, params);
  if (errors.length > 0) throw new MediaValidationError(errors);
  if (kind === 'image') return buildImage(world, params);
  if (kind === 'audio') return buildAudio(world, params);
  return buildVideo(world, params);
}

function buildImage(world, params) {
  const width = resolveDim(world, params.width, params.unit);
  const height = resolveDim(world, params.height, params.unit);
  const format = params.format ?? world.rules.defaultFormat.image;
  const background = params.background.color !== undefined
    ? { color: params.background.color.toLowerCase() }
    : { transparent: true };
  const shapes = (params.shapes ?? []).map((s) => buildShape(world, s));
  return { kind: 'image', format, width, height, background, shapes };
}

function buildShape(world, s) {
  const shape = {
    type: s.type,
    x: s.x,
    y: s.y,
    color: s.color.toLowerCase(),
    opacity: s.opacity ?? 1,
  };
  if (s.type === 'rect') {
    shape.w = s.w;
    shape.h = s.h;
  } else if (s.type === 'circle') {
    shape.r = s.r;
  } else if (s.type === 'line') {
    shape.x2 = s.x2;
    shape.y2 = s.y2;
  }
  if (world.rules.zOrder === 'explicit') shape.z = s.z;
  return shape;
}

function buildAudio(world, params) {
  const format = params.format ?? world.rules.defaultFormat.audio;
  const sampleRate = params.sampleRate ?? world.rules.defaultSampleRate;
  const notes = (params.notes ?? []).map(buildNote);
  return { kind: 'audio', format, sampleRate, durationMs: params.durationMs, notes };
}

function buildNote(n) {
  return {
    freq: n.freq,
    startMs: n.startMs,
    durMs: n.durMs,
    amp: n.amp ?? 1,
    wave: n.wave ?? 'sine',
  };
}

function buildVideo(world, params) {
  const width = resolveDim(world, params.width, params.unit);
  const height = resolveDim(world, params.height, params.unit);
  const format = params.format ?? world.rules.defaultFormat.video;
  const fps = params.fps ?? world.rules.defaultFps;
  const clips = (params.clips ?? []).map((c) => buildClip(world, c));
  const desc = { kind: 'video', format, width, height, fps, durationMs: params.durationMs, clips };
  if (params.audio) desc.audio = { assetId: params.audio.assetId };
  return desc;
}

function buildClip(world, c) {
  const clip = { assetId: c.assetId, startMs: c.startMs, durMs: c.durMs, opacity: c.opacity ?? 1 };
  if (world.rules.zOrder === 'explicit') clip.z = c.z;
  return clip;
}

// ---------------------------------------------------------------------------
// convert
// ---------------------------------------------------------------------------

export function convert(world = defaultWorld(), desc, opts = {}) {
  if (desc.kind === 'image') return convertImage(world, desc, opts);
  if (desc.kind === 'audio') return convertAudio(world, desc, opts);
  return convertVideo(world, desc, opts);
}

function convertImage(world, desc, opts) {
  const format = opts.format ?? desc.format;
  if (!IMAGE_FORMATS.has(format)) {
    throw new MediaValidationError([{ field: 'format', message: `format must be one of ${[...IMAGE_FORMATS].join(', ')}` }]);
  }
  const width = opts.width !== undefined
    ? roundToGrid(opts.width, world.rules.roundTo, world.rules.roundMode)
    : desc.width;
  const height = opts.height !== undefined
    ? roundToGrid(opts.height, world.rules.roundTo, world.rules.roundMode)
    : desc.height;
  const scaleX = width / desc.width;
  const scaleY = height / desc.height;
  const shapes = desc.shapes.map((s) => scaleShape(s, scaleX, scaleY));
  return { ...desc, format, width, height, shapes };
}

function scaleShape(s, scaleX, scaleY) {
  const scaled = { ...s, x: Math.round(s.x * scaleX), y: Math.round(s.y * scaleY) };
  if (s.w !== undefined) scaled.w = Math.round(s.w * scaleX);
  if (s.h !== undefined) scaled.h = Math.round(s.h * scaleY);
  if (s.r !== undefined) scaled.r = Math.round(s.r * ((scaleX + scaleY) / 2));
  if (s.x2 !== undefined) scaled.x2 = Math.round(s.x2 * scaleX);
  if (s.y2 !== undefined) scaled.y2 = Math.round(s.y2 * scaleY);
  return scaled;
}

function convertAudio(world, desc, opts) {
  const format = opts.format ?? desc.format;
  if (!AUDIO_FORMATS.has(format)) {
    throw new MediaValidationError([{ field: 'format', message: `format must be one of ${[...AUDIO_FORMATS].join(', ')}` }]);
  }
  const sampleRate = opts.sampleRate ?? desc.sampleRate;
  if (!SAMPLE_RATES.has(sampleRate)) {
    throw new MediaValidationError([{ field: 'sampleRate', message: `sampleRate must be one of ${[...SAMPLE_RATES].join(', ')}` }]);
  }
  return { ...desc, format, sampleRate };
}

function convertVideo(world, desc, opts) {
  const format = opts.format ?? desc.format;
  if (!VIDEO_FORMATS.has(format)) {
    throw new MediaValidationError([{ field: 'format', message: `format must be one of ${[...VIDEO_FORMATS].join(', ')}` }]);
  }
  const fps = opts.fps ?? desc.fps;
  if (!FPS_VALUES.has(fps)) {
    throw new MediaValidationError([{ field: 'fps', message: `fps must be one of ${[...FPS_VALUES].join(', ')}` }]);
  }
  const width = opts.width !== undefined
    ? roundToGrid(opts.width, world.rules.roundTo, world.rules.roundMode)
    : desc.width;
  const height = opts.height !== undefined
    ? roundToGrid(opts.height, world.rules.roundTo, world.rules.roundMode)
    : desc.height;
  return { ...desc, format, fps, width, height };
}

// ---------------------------------------------------------------------------
// combine
// ---------------------------------------------------------------------------

export function combine(world = defaultWorld(), descs, opts = {}) {
  if (!Array.isArray(descs) || descs.length === 0) {
    throw new MediaValidationError([{ field: 'descs', message: 'descs must be a non-empty array' }]);
  }
  const kind = descs[0].kind;
  if (!descs.every((d) => d.kind === kind)) {
    throw new MediaValidationError([{ field: 'descs', message: 'all descriptors must share the same kind' }]);
  }
  const expectedMode = { image: 'layer', audio: 'mix', video: 'sequence' }[kind];
  const mode = opts.mode ?? expectedMode;
  if (mode !== expectedMode) {
    throw new MediaValidationError([{ field: 'mode', message: `mode must be ${expectedMode} for kind ${kind}` }]);
  }
  if (kind === 'image') return combineLayer(world, descs, opts);
  if (kind === 'audio') return combineMix(world, descs, opts);
  return combineSequence(descs);
}

// Opacity compounding for combine(mode: 'layer'), keyed off world.rules.opacityCompound and
// applied per input index i (0-based; the first input, i === 0, is always left unchanged since
// step ** 0 === 1 and step * 0 === 0):
//   multiplicative: shape.opacity_i = originalOpacity * (opts.opacityStep ** i)   [default step 1]
//   additive:       shape.opacity_i = originalOpacity - (opts.opacityStep * i)   [default step 0]
// Both are clamped to [0, 1] afterwards. z is then reassigned across the whole combined list:
// sequential 0..n-1 when world.rules.zOrder === 'explicit' (append order becomes the z order),
// or dropped entirely when zOrder === 'listOrder' (array position alone carries z order).
function combineLayer(world, descs, opts) {
  const first = descs[0];
  const compound = world.rules.opacityCompound;
  const step = opts.opacityStep ?? (compound === 'multiplicative' ? 1 : 0);
  let shapes = [];
  descs.forEach((d, i) => {
    d.shapes.forEach((s) => {
      const opacity = compound === 'multiplicative'
        ? s.opacity * Math.pow(step, i)
        : s.opacity - step * i;
      shapes.push({ ...s, opacity: clamp01(opacity) });
    });
  });
  if (world.rules.zOrder === 'explicit') {
    shapes = shapes.map((s, i) => ({ ...s, z: i }));
  } else {
    shapes = shapes.map(({ z, ...rest }) => rest);
  }
  return {
    kind: 'image',
    format: first.format,
    width: first.width,
    height: first.height,
    background: first.background,
    shapes,
  };
}

// Later inputs' notes are shifted later in time: input i's notes get + (opts.offsetMs * i) ms,
// so the first input (i === 0) is untouched. Duration is the latest end time across every
// shifted note and every input's own (shifted) duration, so a trailing silent input still
// extends the mix.
function combineMix(world, descs, opts) {
  const first = descs[0];
  const offsetMs = opts.offsetMs ?? 0;
  const notes = [];
  descs.forEach((d, i) => {
    const shift = offsetMs * i;
    d.notes.forEach((n) => notes.push({ ...n, startMs: n.startMs + shift }));
  });
  const ends = [
    0,
    ...descs.map((d, i) => d.durationMs + offsetMs * i),
    ...notes.map((n) => n.startMs + n.durMs),
  ];
  return {
    kind: 'audio',
    format: first.format,
    sampleRate: first.sampleRate,
    durationMs: Math.max(...ends),
    notes,
  };
}

// Each input's clips are appended after every prior input's full duration: input i's clips get
// + (sum of descs[0..i-1].durationMs) ms. Total duration is the sum of every input's duration.
function combineSequence(descs) {
  const first = descs[0];
  const clips = [];
  let cumulative = 0;
  descs.forEach((d) => {
    d.clips.forEach((c) => clips.push({ ...c, startMs: c.startMs + cumulative }));
    cumulative += d.durationMs;
  });
  const desc = {
    kind: 'video',
    format: first.format,
    width: first.width,
    height: first.height,
    fps: first.fps,
    durationMs: cumulative,
    clips,
  };
  if (first.audio) desc.audio = first.audio;
  return desc;
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

export function diff(world = defaultWorld(), a, b) {
  if (a.kind !== b.kind) {
    throw new MediaValidationError([{ field: 'kind', message: 'cannot diff descriptors of different kinds' }]);
  }
  if (a.kind === 'image') return diffImage(a, b);
  if (a.kind === 'audio') return diffAudio(a, b);
  return diffVideo(a, b);
}

// Canonical identity of a primitive, ignoring z (z is display order, not identity).
function identityKey(primitive) {
  const { z, ...rest } = primitive;
  return canonical(rest);
}

function diffList(listA, listB) {
  const keysB = new Set(listB.map(identityKey));
  return listA.filter((item) => !keysB.has(identityKey(item)));
}

function diffImage(a, b) {
  return {
    kind: 'image',
    format: a.format,
    width: a.width,
    height: a.height,
    background: a.background,
    shapes: diffList(a.shapes, b.shapes),
  };
}

function diffAudio(a, b) {
  return {
    kind: 'audio',
    format: a.format,
    sampleRate: a.sampleRate,
    durationMs: a.durationMs,
    notes: diffList(a.notes, b.notes),
  };
}

function diffVideo(a, b) {
  const desc = {
    kind: 'video',
    format: a.format,
    width: a.width,
    height: a.height,
    fps: a.fps,
    durationMs: a.durationMs,
    clips: diffList(a.clips, b.clips),
  };
  if (a.audio) desc.audio = a.audio;
  return desc;
}

// ---------------------------------------------------------------------------
// applyLora
// ---------------------------------------------------------------------------

// Addendum O finding 2 / "The house refuses the wrong reading": a style is a house style
// (RULES rule 12) and house styles apply to pictures, full stop -- before 0.6.0 a lora applied
// to an audio or video descriptor 201'd and stamped `lora: {applied: true}` on a descriptor
// `applyHueShift`/`applyScale`/`applyInvert` returned untouched (they all short-circuit on
// `desc.kind !== 'image'`), which is exactly the "wrong reading" the fidelity-0.03 rung-60 falls
// exposed: a caller sees 201 + applied:true and reasonably concludes something happened. Reject
// before any op-specific branch runs, so applyLora never reaches the stamping step below for a
// non-image descriptor and never again claims a style was applied when nothing was.
export function applyLora(world = defaultWorld(), desc, lora) {
  if (desc.kind !== 'image') {
    throw new MediaValidationError([{ field: 'lora_id', message: 'styles apply to pictures only' }]);
  }
  let next;
  if (lora.op === 'hueShift') next = applyHueShift(world, desc, lora.amount);
  else if (lora.op === 'scale') next = applyScale(world, desc, lora.amount);
  else if (lora.op === 'opacity') next = applyOpacity(desc, lora.amount);
  else if (lora.op === 'invert') next = applyInvert(desc);
  else throw new MediaValidationError([{ field: 'lora.op', message: `unknown lora op: ${lora.op}` }]);
  return { ...next, lora: { id: lora.id, applied: true } };
}

function applyHueShift(world, desc, amount) {
  if (desc.kind !== 'image') return { ...desc };
  const space = world.rules.colorShiftSpace;
  const shapes = desc.shapes.map((s) => ({ ...s, color: shiftHue(s.color, amount, space) }));
  return { ...desc, shapes };
}

function applyScale(world, desc, amount) {
  if (desc.kind !== 'image') return { ...desc };
  const { roundTo, roundMode } = world.rules;
  const shapes = desc.shapes.map((s) => {
    const scaled = { ...s };
    if (s.x !== undefined) scaled.x = roundToGrid(s.x * amount, roundTo, roundMode);
    if (s.y !== undefined) scaled.y = roundToGrid(s.y * amount, roundTo, roundMode);
    if (s.w !== undefined) scaled.w = roundToGrid(s.w * amount, roundTo, roundMode);
    if (s.h !== undefined) scaled.h = roundToGrid(s.h * amount, roundTo, roundMode);
    if (s.r !== undefined) scaled.r = roundToGrid(s.r * amount, roundTo, roundMode);
    if (s.x2 !== undefined) scaled.x2 = roundToGrid(s.x2 * amount, roundTo, roundMode);
    if (s.y2 !== undefined) scaled.y2 = roundToGrid(s.y2 * amount, roundTo, roundMode);
    return scaled;
  });
  return { ...desc, shapes };
}

function applyOpacity(desc, amount) {
  if (desc.kind === 'image') {
    return { ...desc, shapes: desc.shapes.map((s) => ({ ...s, opacity: clamp01(s.opacity * amount) })) };
  }
  if (desc.kind === 'video') {
    return { ...desc, clips: desc.clips.map((c) => ({ ...c, opacity: clamp01(c.opacity * amount) })) };
  }
  return { ...desc };
}

function applyInvert(desc) {
  if (desc.kind !== 'image') return { ...desc };
  const shapes = desc.shapes.map((s) => ({ ...s, color: invertHex(s.color) }));
  return { ...desc, shapes };
}

// ---------------------------------------------------------------------------
// fidelity
// ---------------------------------------------------------------------------

function collectLeaves(value, prefix, out) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.set(prefix, '[]');
      return;
    }
    value.forEach((v, i) => collectLeaves(v, prefix ? `${prefix}.${i}` : String(i), out));
    return;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      out.set(prefix, '{}');
      return;
    }
    for (const k of keys) collectLeaves(value[k], prefix ? `${prefix}.${k}` : k, out);
    return;
  }
  out.set(prefix, value);
}

// Share of leaf params equal, walking the union of leaf paths of both descriptors. Arrays are
// compared positionally (index becomes part of the path), not as sets. 1.0 for two descriptors
// with no leaves at all (both empty).
export function fidelity(expected, actual) {
  const expectedLeaves = new Map();
  collectLeaves(expected, '', expectedLeaves);
  const actualLeaves = new Map();
  collectLeaves(actual, '', actualLeaves);
  const keys = new Set([...expectedLeaves.keys(), ...actualLeaves.keys()]);
  if (keys.size === 0) return 1;
  let matches = 0;
  for (const k of keys) {
    if (expectedLeaves.has(k) && actualLeaves.has(k) && Object.is(expectedLeaves.get(k), actualLeaves.get(k))) {
      matches += 1;
    }
  }
  return matches / keys.size;
}
