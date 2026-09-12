import test from 'node:test';
import assert from 'node:assert/strict';

import { makeWorld } from '../src/world.js';
import {
  create,
  convert,
  combine,
  diff,
  applyLora,
  fidelity,
  validate,
  MediaValidationError,
} from '../src/media.js';

// A minimal, fully explicit World test double. world.js's real makeWorld(seed) is used too
// (below, for a couple of integration smoke tests), but its rules are seed-randomized, so the
// exhaustive quant tables here need a world whose rules we pin exactly.
function testWorld(overrides = {}) {
  const { rules: ruleOverrides, ...rest } = overrides;
  const rules = {
    dpi: 300,
    roundTo: 8,
    roundMode: 'nearest',
    unitWords: { inch: ['in', 'inch', 'inches'], cm: ['cm'], pt: ['pt'] },
    opacityCompound: 'multiplicative',
    defaultFormat: { image: 'svg', audio: 'wav', video: 'qvid' },
    defaultSampleRate: 44100,
    defaultFps: 24,
    zOrder: 'listOrder',
    colorShiftSpace: 'hsl',
    bitrateBudgetUnit: 'MB',
    ...ruleOverrides,
  };
  return {
    seed: 1,
    version: '0.2.0',
    vocab: { workspace: 'studio', project: 'scene', asset: 'clip', library: 'library' },
    ids: { style: 'prefixed', prefixes: { workspace: 'ws_1', project: 'pr_1', asset: 'as_1', job: 'jb_1', lora: 'lo_1' } },
    naming: 'snake',
    namingExceptions: [],
    rules,
    auth: { apiKey: 'key_test', secret: 'sec_test', tokenTtlSec: 300, refreshPath: '/auth/refresh' },
    rate: { limit: 30, windowSec: 10 },
    pagination: { pageSize: 10, cursorStyle: 'b64json' },
    traps: { live: ['fieldCase', 'deleteStatus'] },
    deprecated: { '/v1/pictures': '/images' },
    loras: [{ id: 'lora_0_jenny', name: 'Jenny', op: 'hueShift', amount: 30 }],
    hmac: { header: 'X-Signature', tsHeader: 'X-Timestamp', algo: 'sha256', canon: 'ts+method+path' },
    ...rest,
  };
}

function baseImageParams(overrides = {}) {
  return {
    width: 100,
    height: 100,
    background: { color: '#ff0000' },
    shapes: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// unit conversion table: dpi x roundTo x roundMode, 3 sizes
// ---------------------------------------------------------------------------

function expectedPxFromInches(inches, dpi, step, mode) {
  const raw = inches * dpi;
  const q = raw / step;
  let rounded;
  if (mode === 'up') rounded = Math.ceil(q);
  else if (mode === 'down') rounded = Math.floor(q);
  else rounded = Math.round(q);
  return rounded * step;
}

test('create: unit conversion table over dpi x roundTo x roundMode x size (inches)', () => {
  const dpis = [72, 96, 150, 300];
  const roundTos = [1, 2, 4, 8, 16];
  const roundModes = ['nearest', 'up', 'down'];
  const sizesIn = [1, 5.5, 12.25];

  for (const dpi of dpis) {
    for (const roundTo of roundTos) {
      for (const roundMode of roundModes) {
        const world = testWorld({ rules: { dpi, roundTo, roundMode } });
        for (const size of sizesIn) {
          const desc = create(world, 'image', baseImageParams({ width: size, height: size, unit: 'in' }));
          const expected = expectedPxFromInches(size, dpi, roundTo, roundMode);
          assert.equal(desc.width, expected, `dpi=${dpi} roundTo=${roundTo} mode=${roundMode} size=${size}`);
          assert.equal(desc.height, expected);
        }
      }
    }
  }
});

test('create: the SPEC.md worked example (12x22in @ 300dpi, round to 8, nearest)', () => {
  const world = testWorld({ rules: { dpi: 300, roundTo: 8, roundMode: 'nearest' } });
  const desc = create(world, 'image', baseImageParams({ width: 12, height: 22, unit: 'in' }));
  assert.equal(desc.width, 3600);
  assert.equal(desc.height, 6600);
});

test('create: cm and pt unit conversion formulas', () => {
  const world = testWorld({ rules: { dpi: 96, roundTo: 1, roundMode: 'nearest' } });
  const cmDesc = create(world, 'image', baseImageParams({ width: 2.54, height: 5.08, unit: 'cm' }));
  assert.equal(cmDesc.width, 96); // 1 inch
  assert.equal(cmDesc.height, 192); // 2 inches
  const ptDesc = create(world, 'image', baseImageParams({ width: 72, height: 36, unit: 'pt' }));
  assert.equal(ptDesc.width, 96); // 1 inch
  assert.equal(ptDesc.height, 48); // 0.5 inch
});

test('create: px given directly (no unit) still runs through the rounding rule', () => {
  const world = testWorld({ rules: { roundTo: 8, roundMode: 'up' } });
  const desc = create(world, 'image', baseImageParams({ width: 101, height: 1 }));
  assert.equal(desc.width, 104); // ceil(101/8)*8
  assert.equal(desc.height, 8);
});

// ---------------------------------------------------------------------------
// validate / create rejects
// ---------------------------------------------------------------------------

test('validate: background.color and background.transparent are mutually exclusive -> 422 shape', () => {
  const world = testWorld();
  const result = validate(world, 'image', baseImageParams({ background: { color: '#ff0000', transparent: true } }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === 'background'));
});

test('create throws MediaValidationError on the same exclusivity violation', () => {
  const world = testWorld();
  assert.throws(
    () => create(world, 'image', baseImageParams({ background: { color: '#ff0000', transparent: true } })),
    MediaValidationError,
  );
});

test('validate: missing width/height/background reported by field', () => {
  const world = testWorld();
  const result = validate(world, 'image', { shapes: [] });
  assert.equal(result.ok, false);
  const fields = result.errors.map((e) => e.field);
  assert.ok(fields.includes('width'));
  assert.ok(fields.includes('height'));
  assert.ok(fields.includes('background'));
});

test('validate: enum violations on format and shape type', () => {
  const world = testWorld();
  const result = validate(world, 'image', baseImageParams({ format: 'gif', shapes: [{ type: 'blob', x: 0, y: 0, color: '#000000' }] }));
  assert.equal(result.ok, false);
  const fields = result.errors.map((e) => e.field);
  assert.ok(fields.includes('format'));
  assert.ok(fields.includes('shapes.0.type'));
});

test('validate: shapes/notes/clips may be empty arrays and that is valid', () => {
  const world = testWorld();
  assert.equal(validate(world, 'image', baseImageParams({ shapes: [] })).ok, true);
  assert.equal(validate(world, 'audio', { durationMs: 0, notes: [] }).ok, true);
  assert.equal(validate(world, 'video', { width: 10, height: 10, durationMs: 0, clips: [] }).ok, true);
});

test('create: zOrder explicit requires z on shapes, listOrder strips it', () => {
  const explicitWorld = testWorld({ rules: { zOrder: 'explicit' } });
  const missingZ = validate(explicitWorld, 'image', baseImageParams({
    shapes: [{ type: 'rect', x: 0, y: 0, w: 1, h: 1, color: '#000000' }],
  }));
  assert.equal(missingZ.ok, false);
  assert.ok(missingZ.errors.some((e) => e.field === 'shapes.0.z'));

  const withZ = create(explicitWorld, 'image', baseImageParams({
    shapes: [{ type: 'rect', x: 0, y: 0, w: 1, h: 1, color: '#000000', z: 5 }],
  }));
  assert.equal(withZ.shapes[0].z, 5);

  const listOrderWorld = testWorld({ rules: { zOrder: 'listOrder' } });
  const noZ = create(listOrderWorld, 'image', baseImageParams({
    shapes: [{ type: 'rect', x: 0, y: 0, w: 1, h: 1, color: '#000000', z: 999 }],
  }));
  assert.equal('z' in noZ.shapes[0], false);
});

test('create: defaults for format/sampleRate/fps come from world.rules', () => {
  const world = testWorld({ rules: { defaultFormat: { image: 'png', audio: 'qa8', video: 'qvid' }, defaultSampleRate: 48000, defaultFps: 30 } });
  const img = create(world, 'image', baseImageParams());
  assert.equal(img.format, 'png');
  const audio = create(world, 'audio', { durationMs: 100, notes: [] });
  assert.equal(audio.format, 'qa8');
  assert.equal(audio.sampleRate, 48000);
  const video = create(world, 'video', { width: 10, height: 10, durationMs: 100, clips: [] });
  assert.equal(video.fps, 30);
  assert.equal(video.format, 'qvid');
});

// ---------------------------------------------------------------------------
// convert
// ---------------------------------------------------------------------------

test('convert: image resize scales shapes proportionally', () => {
  const world = testWorld({ rules: { roundTo: 1 } });
  const desc = create(world, 'image', baseImageParams({
    width: 100,
    height: 100,
    shapes: [{ type: 'rect', x: 10, y: 20, w: 30, h: 40, color: '#000000' }],
  }));
  const resized = convert(world, desc, { width: 200, height: 50 });
  assert.equal(resized.width, 200);
  assert.equal(resized.height, 50);
  assert.equal(resized.shapes[0].x, 20); // x2 scale
  assert.equal(resized.shapes[0].y, 10); // x0.5 scale
  assert.equal(resized.shapes[0].w, 60);
  assert.equal(resized.shapes[0].h, 20);
});

test('convert: image format change is a no-op on geometry', () => {
  const world = testWorld();
  const desc = create(world, 'image', baseImageParams());
  const converted = convert(world, desc, { format: 'png' });
  assert.equal(converted.format, 'png');
  assert.equal(converted.width, desc.width);
});

test('convert: audio sampleRate change, video fps/size change', () => {
  const world = testWorld({ rules: { roundTo: 1 } });
  const audio = create(world, 'audio', { durationMs: 100, notes: [] });
  const convertedAudio = convert(world, audio, { sampleRate: 48000 });
  assert.equal(convertedAudio.sampleRate, 48000);

  const video = create(world, 'video', { width: 10, height: 10, durationMs: 100, clips: [] });
  const convertedVideo = convert(world, video, { fps: 30, width: 20, height: 20 });
  assert.equal(convertedVideo.fps, 30);
  assert.equal(convertedVideo.width, 20);
  assert.equal(convertedVideo.height, 20);
});

// ---------------------------------------------------------------------------
// combine algebra
// ---------------------------------------------------------------------------

test('combine layer of A,B then diff against A yields exactly Bs shapes (default opacity step)', () => {
  const world = testWorld({ rules: { zOrder: 'listOrder' } });
  const a = create(world, 'image', baseImageParams({
    shapes: [{ type: 'rect', x: 0, y: 0, w: 10, h: 10, color: '#111111' }],
  }));
  const b = create(world, 'image', baseImageParams({
    background: { color: '#00ff00' },
    shapes: [{ type: 'circle', x: 5, y: 5, r: 3, color: '#222222' }],
  }));
  const combined = combine(world, [a, b], { mode: 'layer' });
  assert.equal(combined.shapes.length, 2);
  // canvas comes from the first input (A), not B
  assert.deepEqual(combined.background, a.background);

  const delta = diff(world, combined, a);
  assert.deepEqual(delta.shapes, b.shapes);
});

test('combine layer: explicit zOrder reassigns z sequentially across all inputs', () => {
  const world = testWorld({ rules: { zOrder: 'explicit' } });
  const a = create(world, 'image', baseImageParams({
    shapes: [{ type: 'rect', x: 0, y: 0, w: 1, h: 1, color: '#000000', z: 9 }],
  }));
  const b = create(world, 'image', baseImageParams({
    shapes: [
      { type: 'rect', x: 0, y: 0, w: 1, h: 1, color: '#000001', z: 9 },
      { type: 'rect', x: 0, y: 0, w: 1, h: 1, color: '#000002', z: 9 },
    ],
  }));
  const combined = combine(world, [a, b], { mode: 'layer' });
  assert.deepEqual(combined.shapes.map((s) => s.z), [0, 1, 2]);
});

test('combine layer: multiplicative opacity compounding by opts.opacityStep ** index', () => {
  const world = testWorld({ rules: { opacityCompound: 'multiplicative' } });
  const a = create(world, 'image', baseImageParams({ shapes: [{ type: 'rect', x: 0, y: 0, w: 1, h: 1, color: '#000000', opacity: 1 }] }));
  const b = create(world, 'image', baseImageParams({ shapes: [{ type: 'rect', x: 0, y: 0, w: 1, h: 1, color: '#000000', opacity: 1 }] }));
  const c = create(world, 'image', baseImageParams({ shapes: [{ type: 'rect', x: 0, y: 0, w: 1, h: 1, color: '#000000', opacity: 1 }] }));
  const combined = combine(world, [a, b, c], { mode: 'layer', opacityStep: 0.5 });
  assert.equal(combined.shapes[0].opacity, 1); // 1 * 0.5^0
  assert.equal(combined.shapes[1].opacity, 0.5); // 1 * 0.5^1
  assert.equal(combined.shapes[2].opacity, 0.25); // 1 * 0.5^2
});

test('combine layer: additive opacity compounding subtracts opts.opacityStep * index, clamped', () => {
  const world = testWorld({ rules: { opacityCompound: 'additive' } });
  const a = create(world, 'image', baseImageParams({ shapes: [{ type: 'rect', x: 0, y: 0, w: 1, h: 1, color: '#000000', opacity: 1 }] }));
  const b = create(world, 'image', baseImageParams({ shapes: [{ type: 'rect', x: 0, y: 0, w: 1, h: 1, color: '#000000', opacity: 1 }] }));
  const c = create(world, 'image', baseImageParams({ shapes: [{ type: 'rect', x: 0, y: 0, w: 1, h: 1, color: '#000000', opacity: 1 }] }));
  const combined = combine(world, [a, b, c], { mode: 'layer', opacityStep: 0.6 });
  assert.equal(combined.shapes[0].opacity, 1);
  assert.equal(combined.shapes[1].opacity, 0.4);
  assert.equal(combined.shapes[2].opacity, 0); // 1 - 1.2 clamped to 0
});

test('combine mix: audio notes unioned, later inputs offset by opts.offsetMs * index', () => {
  const world = testWorld();
  const a = create(world, 'audio', { durationMs: 100, notes: [{ freq: 440, startMs: 0, durMs: 50, amp: 1, wave: 'sine' }] });
  const b = create(world, 'audio', { durationMs: 100, notes: [{ freq: 220, startMs: 0, durMs: 50, amp: 1, wave: 'sine' }] });
  const combined = combine(world, [a, b], { mode: 'mix', offsetMs: 100 });
  assert.equal(combined.notes.length, 2);
  assert.equal(combined.notes[0].startMs, 0);
  assert.equal(combined.notes[1].startMs, 100);
  assert.equal(combined.durationMs, 200); // b's duration(100) + offset(100)
});

test('combine sequence: video clips appended with startMs shifted by cumulative duration', () => {
  const world = testWorld();
  const a = create(world, 'video', { width: 10, height: 10, durationMs: 300, clips: [{ assetId: 'x', startMs: 0, durMs: 300 }] });
  const b = create(world, 'video', { width: 10, height: 10, durationMs: 200, clips: [{ assetId: 'y', startMs: 0, durMs: 200 }] });
  const combined = combine(world, [a, b], { mode: 'sequence' });
  assert.equal(combined.clips[0].startMs, 0);
  assert.equal(combined.clips[1].startMs, 300);
  assert.equal(combined.durationMs, 500);
});

test('combine: mode mismatched with kind is rejected', () => {
  const world = testWorld();
  const a = create(world, 'image', baseImageParams());
  const b = create(world, 'image', baseImageParams());
  assert.throws(() => combine(world, [a, b], { mode: 'mix' }), MediaValidationError);
});

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

test('diff: primitives in A not in B, ignoring z, same canvas as A', () => {
  const world = testWorld({ rules: { zOrder: 'explicit' } });
  const shared = { type: 'rect', x: 0, y: 0, w: 1, h: 1, color: '#abcdef', opacity: 1 };
  const a = create(world, 'image', baseImageParams({ shapes: [{ ...shared, z: 0 }, { type: 'circle', x: 1, y: 1, r: 1, color: '#000000', z: 1 }] }));
  const b = create(world, 'image', baseImageParams({ shapes: [{ ...shared, z: 7 }] })); // same primitive, different z
  const delta = diff(world, a, b);
  assert.equal(delta.shapes.length, 1);
  assert.equal(delta.shapes[0].color, '#000000');
  assert.deepEqual(delta.background, a.background);
  assert.equal(delta.width, a.width);
});

test('diff: rejects mismatched kinds', () => {
  const world = testWorld();
  const image = create(world, 'image', baseImageParams());
  const audio = create(world, 'audio', { durationMs: 1, notes: [] });
  assert.throws(() => diff(world, image, audio), MediaValidationError);
});

// ---------------------------------------------------------------------------
// applyLora
// ---------------------------------------------------------------------------

test('applyLora: hueShift is deterministic and round-trips exactly at 0 and 360 degrees', () => {
  const world = testWorld({ rules: { colorShiftSpace: 'hsl' } });
  const desc = create(world, 'image', baseImageParams({ shapes: [{ type: 'rect', x: 0, y: 0, w: 1, h: 1, color: '#ff0000' }] }));
  const lora = { id: 'lora_hue', op: 'hueShift', amount: 0 };
  const shifted0 = applyLora(world, desc, lora);
  assert.equal(shifted0.shapes[0].color, '#ff0000');
  const shifted360 = applyLora(world, desc, { ...lora, amount: 360 });
  assert.equal(shifted360.shapes[0].color, '#ff0000');
  assert.deepEqual(shifted0, applyLora(world, desc, lora)); // pure/deterministic
});

test('applyLora: hueShift +120/+240 rotates a saturated primary exactly, in both hsl and hsv space', () => {
  for (const space of ['hsl', 'hsv']) {
    const world = testWorld({ rules: { colorShiftSpace: space } });
    const desc = create(world, 'image', baseImageParams({ shapes: [{ type: 'rect', x: 0, y: 0, w: 1, h: 1, color: '#ff0000' }] }));
    const green = applyLora(world, desc, { id: 'l', op: 'hueShift', amount: 120 });
    assert.equal(green.shapes[0].color, '#00ff00', space);
    const blue = applyLora(world, desc, { id: 'l', op: 'hueShift', amount: 240 });
    assert.equal(blue.shapes[0].color, '#0000ff', space);
  }
});

test('applyLora: scale multiplies geometry and rounds per rules', () => {
  const world = testWorld({ rules: { roundTo: 4, roundMode: 'nearest' } });
  const desc = create(world, 'image', baseImageParams({ shapes: [{ type: 'rect', x: 10, y: 10, w: 10, h: 10, color: '#000000' }] }));
  const scaled = applyLora(world, desc, { id: 'l', op: 'scale', amount: 2.1 });
  // 10 * 2.1 = 21 -> nearest multiple of 4 = 20
  assert.equal(scaled.shapes[0].x, 20);
  assert.equal(scaled.shapes[0].w, 20);
});

test('applyLora: opacity multiplies and clamps to [0,1]', () => {
  const world = testWorld();
  const desc = create(world, 'image', baseImageParams({ shapes: [{ type: 'rect', x: 0, y: 0, w: 1, h: 1, color: '#000000', opacity: 0.5 }] }));
  const boosted = applyLora(world, desc, { id: 'l', op: 'opacity', amount: 3 });
  assert.equal(boosted.shapes[0].opacity, 1);
  const dimmed = applyLora(world, desc, { id: 'l', op: 'opacity', amount: 0.2 });
  assert.equal(dimmed.shapes[0].opacity, 0.1);
});

test('applyLora: invert is an involution and marks lora.applied', () => {
  const world = testWorld();
  const desc = create(world, 'image', baseImageParams({ shapes: [{ type: 'rect', x: 0, y: 0, w: 1, h: 1, color: '#123456' }] }));
  const inverted = applyLora(world, desc, { id: 'lora_x', op: 'invert' });
  assert.deepEqual(inverted.lora, { id: 'lora_x', applied: true });
  const back = applyLora(world, inverted, { id: 'lora_x', op: 'invert' });
  assert.equal(back.shapes[0].color, '#123456');
});

// ---------------------------------------------------------------------------
// fidelity
// ---------------------------------------------------------------------------

test('fidelity: 1.0 for identical descriptors', () => {
  const world = testWorld();
  const desc = create(world, 'image', baseImageParams({ shapes: [{ type: 'rect', x: 1, y: 2, w: 3, h: 4, color: '#abcdef', opacity: 0.5 }] }));
  assert.equal(fidelity(desc, desc), 1);
  assert.equal(fidelity(desc, structuredClone(desc)), 1);
});

test('fidelity: known fraction for one planted difference out of a fixed leaf count', () => {
  const expected = {
    kind: 'image', format: 'svg', width: 100, height: 100,
    background: { color: '#ff0000' },
    shapes: [{ type: 'rect', x: 0, y: 0, color: '#000000', opacity: 1, w: 10, h: 10 }],
  };
  // 12 leaves: kind, format, width, height, background.color, shapes.0.{type,x,y,color,opacity,w,h}
  const actual = structuredClone(expected);
  actual.shapes[0].color = '#111111';
  assert.equal(fidelity(expected, actual), 11 / 12);
});

test('fidelity: arrays are compared positionally, not as sets', () => {
  const expected = { list: [{ v: 'a' }, { v: 'b' }] };
  const swapped = { list: [{ v: 'b' }, { v: 'a' }] };
  // both leaf paths mismatch even though the same values exist, just at swapped indices
  assert.equal(fidelity(expected, swapped), 0);
  assert.equal(fidelity(expected, structuredClone(expected)), 1);
});

test('fidelity: leaves present on only one side count as mismatches, union-sized denominator', () => {
  const expected = { a: 1, b: 2 };
  const actual = { a: 1, c: 3 };
  // union of leaf paths: a, b, c -> a matches, b and c do not
  assert.equal(fidelity(expected, actual), 1 / 3);
});

// ---------------------------------------------------------------------------
// integration smoke test against the real, seeded World
// ---------------------------------------------------------------------------

test('integration: create/convert/combine/diff/applyLora/fidelity all run against a real makeWorld()', () => {
  const world = makeWorld(7);
  const a = create(world, 'image', baseImageParams({ width: 4, height: 4, unit: 'in' }));
  const b = create(world, 'image', baseImageParams({ width: 4, height: 4, unit: 'in', shapes: [{ type: 'circle', x: 1, y: 1, r: 1, color: '#00ff00', z: 0 }] }));
  const combined = combine(world, [a, b], { mode: 'layer' });
  const delta = diff(world, combined, a);
  assert.equal(fidelity(delta.shapes[0] ?? {}, b.shapes[0] ?? {}) >= 0, true);
  const lora = world.loras[0];
  const styled = applyLora(world, combined, lora);
  assert.equal(styled.lora.applied, true);
  const resized = convert(world, styled, { width: styled.width * 2, height: styled.height });
  assert.equal(resized.width, styled.width * 2);
});
