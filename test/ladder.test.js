import test from 'node:test';
import assert from 'node:assert/strict';

import { makeWorld } from '../src/world.js';
import { routes } from '../src/routes.js';
import { makeRung, difficulty } from '../src/ladder/rung.js';
import { runPlanLocallyTrace } from '../src/ladder/grammar.js';

// ---------------------------------------------------------------------------
// banned field names: every property name declared anywhere in routes.js's request/response
// schemas. Rung text must never say one of these -- it speaks in plain language, never API shape.
// ---------------------------------------------------------------------------

function collectPropertyNames(schema, out) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.properties) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      out.add(key);
      collectPropertyNames(sub, out);
    }
  }
  if (schema.items) collectPropertyNames(schema.items, out);
}

function bannedFieldNames() {
  const out = new Set();
  for (const route of routes) {
    collectPropertyNames(route.requestSchema, out);
    collectPropertyNames(route.responseSchema, out);
  }
  // Single-letter and very short/common-English names produce false positives in plain prose
  // ("a picture", "call it", "the id of the thing") -- keep only names distinctive enough that a
  // plain-language task would never need them.
  return [...out].filter((name) => name.length > 3 && name !== 'data');
}

const BANNED = bannedFieldNames();

function assertNoFieldNames(text) {
  const lower = text.toLowerCase();
  for (const name of BANNED) {
    const needle = name.toLowerCase();
    const pattern = new RegExp(`(?:^|[^a-z0-9])${needle}(?:[^a-z0-9]|$)`, 'i');
    assert.ok(!pattern.test(lower), `rung text contains API field name "${name}": ${text}`);
  }
}

const SEEDS = [1, 2, 3];
const SAMPLE_RUNGS = [0, 3, 9, 10, 15, 19, 20, 25, 29, 30, 39, 40, 49, 50, 59, 60, 69, 70, 79, 80, 89, 90, 95, 99];

test('makeRung is deterministic', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    for (const n of SAMPLE_RUNGS) {
      const a = makeRung(world, n);
      const b = makeRung(world, n);
      assert.equal(JSON.stringify(a), JSON.stringify(b), `rung ${n} not deterministic for seed ${seed}`);
    }
  }
});

test('makeRung produces a well-shaped Rung for every band', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    for (const n of SAMPLE_RUNGS) {
      const rung = makeRung(world, n);
      assert.equal(rung.n, n);
      assert.equal(typeof rung.text, 'string');
      assert.ok(rung.text.length > 10);
      assert.ok(Array.isArray(rung.plan));
      assert.ok(rung.plan.length >= 1);
      assert.ok(Array.isArray(rung.expectedDescriptors));
      assert.equal(rung.expectedDescriptors.length, rung.submitCount);
      for (const desc of rung.expectedDescriptors) {
        assert.ok(desc.kind === 'image' || desc.kind === 'audio');
      }
    }
  }
});

test('rung text never leaks an API field name', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    for (let n = 0; n < 100; n += 1) {
      assertNoFieldNames(makeRung(world, n).text);
    }
  }
});

// ---------------------------------------------------------------------------
// The judge is hash equality on an exact-match ladder, so a rung whose text omits any leaf the
// artifact's bytes depend on is unclimbable by anything but the reference. House rules (DPI,
// rounding grid, default format/sample rate, opacity compounding) are deliberately absent -- they
// live in the skill -- but every per-rung parameter must be stated.
// ---------------------------------------------------------------------------

function statedNumbers(params, out) {
  out.push(String(params.width), String(params.height));
  if (params.background && params.background.color !== undefined) out.push(params.background.color);
  for (const s of params.shapes ?? []) {
    out.push(String(s.x), String(s.y), s.color, `${Math.round(s.opacity * 100)} percent`, s.type === 'rect' ? String(s.w) : '');
    if (s.type === 'rect') out.push(String(s.h));
    if (s.type === 'circle') out.push(String(s.r));
    if (s.type === 'line') out.push(String(s.x2), String(s.y2));
  }
  if (params.notes) {
    out.push(String(params.durationMs));
    for (const nt of params.notes) {
      out.push(String(nt.freq), String(nt.startMs), String(nt.durMs), nt.wave, `${Math.round(nt.amp * 100)} percent`);
    }
  }
}

test('rung text states every per-rung parameter the expected hash depends on', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    for (let n = 0; n < 100; n += 1) {
      const rung = makeRung(world, n);
      const wanted = [];
      for (const step of rung.plan) {
        if (step.op === 'create' || step.op === 'render') statedNumbers(step.args.params, wanted);
        if (step.op === 'combine' && step.args.opts && step.args.opts.opacityStep !== undefined) {
          wanted.push(String(step.args.opts.opacityStep));
        }
        if (step.op === 'lora') wanted.push(step.args.loraName);
        if (step.op === 'compute' && step.args.percent !== undefined) wanted.push(String(step.args.percent));
      }
      for (const needle of wanted) {
        if (needle === '' || needle === 'undefined') continue;
        assert.ok(
          rung.text.includes(needle),
          `rung ${n} (seed ${seed}) never states "${needle}": ${rung.text}`,
        );
      }
    }
  }
});

test('difficulty is non-decreasing over rungs 0..99, for seeds 1..3', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    let prev = -Infinity;
    for (let n = 0; n < 100; n += 1) {
      const rung = makeRung(world, n);
      const d = difficulty(rung);
      assert.ok(d >= prev, `difficulty dropped at rung ${n} for seed ${seed}: ${d} < ${prev}`);
      prev = d;
    }
  }
});

test('difficulty strictly rises across band boundaries', () => {
  const world = makeWorld(1);
  for (let tier = 0; tier < 9; tier += 1) {
    const last = makeRung(world, tier * 10 + 9);
    const next = makeRung(world, (tier + 1) * 10);
    assert.ok(difficulty(next) > difficulty(last));
  }
});

// ---------------------------------------------------------------------------
// Addendum D geometry floor: media.js's convert() and applyLora('scale') never clamp a shape's
// size -- by design, they are pure functions of their inputs -- so it is the composer's job in
// grammar.js to never generate a plan that shrinks a shape below 8px on any axis. Checked after
// *every* step of every rung's plan (runPlanLocallyTrace), not just the final submitted
// descriptor, because a plan can pass through an undersized intermediate on its way to a
// final descriptor that happens to look fine.
// ---------------------------------------------------------------------------

function assertShapeFloor(value, ctx) {
  if (!value || value.kind !== 'image') return;
  for (const s of value.shapes) {
    if (s.type === 'rect') {
      assert.ok(s.w >= 8, `${ctx}: rect w=${s.w} < 8px`);
      assert.ok(s.h >= 8, `${ctx}: rect h=${s.h} < 8px`);
    } else if (s.type === 'circle') {
      assert.ok(s.r * 2 >= 8, `${ctx}: circle diameter=${s.r * 2} < 8px`);
    } else if (s.type === 'line') {
      assert.ok(Math.abs(s.x2 - s.x) >= 8, `${ctx}: line dx=${s.x2 - s.x} < 8px`);
      assert.ok(Math.abs(s.y2 - s.y) >= 8, `${ctx}: line dy=${s.y2 - s.y} < 8px`);
    }
  }
}

test('Addendum D: every shape stays >= 8px on each axis after every plan step, rungs 0-99, seeds 1-3', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    for (let n = 0; n < 100; n += 1) {
      const rung = makeRung(world, n);
      const trace = runPlanLocallyTrace(world, rung.plan);
      trace.forEach((value, i) => {
        const step = rung.plan[i];
        const ctx = `rung ${n} seed ${seed} step ${i} (${step.op}:${step.resultKey})`;
        if (Array.isArray(value)) value.forEach((v) => assertShapeFloor(v, ctx));
        else assertShapeFloor(value, ctx);
      });
    }
  }
});
