import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../src/canon.js';
import { makeWorld, resolvePath, fieldName } from '../src/world.js';

test('makeWorld is deterministic for the same seed', () => {
  const a = makeWorld(42);
  const b = makeWorld(42);
  assert.equal(canonical(a), canonical(b));
});

test('makeWorld differs across seeds', () => {
  const a = makeWorld(1);
  const b = makeWorld(2);
  assert.notEqual(canonical(a), canonical(b));
});

test('adding an unrelated seeded facet does not reshuffle another', () => {
  // Regression guard on the sub-seed design itself: vocab and loras are
  // independent sub-seeds, so nothing about loras generation should be able
  // to move vocab's draw, and vice versa, across many seeds.
  for (const seed of [1, 2, 3, 4, 5]) {
    const w = makeWorld(seed);
    const w2 = makeWorld(seed);
    assert.deepEqual(w.vocab, w2.vocab);
    assert.deepEqual(w.loras, w2.loras);
  }
});

test('world has the exact top-level shape from the architecture doc', () => {
  const w = makeWorld(42);
  const keys = Object.keys(w).sort();
  assert.deepEqual(keys, [
    'auth', 'deprecated', 'hmac', 'ids', 'loras', 'naming',
    'namingExceptions', 'pagination', 'rate', 'rules', 'rungMutations', 'seed',
    'traps', 'vocab', 'version',
  ].sort());
});

test('world.version is pinned', () => {
  // Rebaselined 0.3.0 -> 0.4.0 by Addendum I's percent-resize fix (runCompute now grid-rounds the
  // same way every other convert target does, plus grammar.js's ambiguous-percent redraw), then
  // 0.4.0 -> 0.5.0 by Addendum J, which changed the ladder grammar wholesale (cross-rung
  // references, derived parameters, announced per-rung mutations, state-machine/HMAC/ETag chains,
  // audio and video math, multi-rule ordering, a much longer step envelope), then 0.5.0 -> 0.5.1
  // by Addendum M's descriptor caps and percentOfDims grid-floor fix, then 0.5.1 -> 0.6.0 by
  // Addendum O (the stitch antecedent stated in text and skill, the house refusing a lora on a
  // non-image, and the chain graded from rung 50 up) -- see world.js's VERSION comment.
  assert.equal(makeWorld(1).version, '0.6.0');
});

test('vocab has the four required nouns as non-empty strings', () => {
  const w = makeWorld(3);
  for (const key of ['workspace', 'project', 'asset', 'library']) {
    assert.equal(typeof w.vocab[key], 'string');
    assert.ok(w.vocab[key].length > 0);
  }
});

test('ids.style is one of the documented styles, prefixes cover all five kinds', () => {
  const w = makeWorld(4);
  assert.ok(['uuid', 'ulid', 'prefixed', 'int'].includes(w.ids.style));
  assert.deepEqual(Object.keys(w.ids.prefixes).sort(), ['asset', 'job', 'lora', 'project', 'workspace'].sort());
});

test('naming is snake or camel, namingExceptions has 1 to 3 entries', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const w = makeWorld(seed);
    assert.ok(['snake', 'camel'].includes(w.naming));
    assert.ok(w.namingExceptions.length >= 1 && w.namingExceptions.length <= 3);
  }
});

test('rules carries every documented field with a valid value', () => {
  const w = makeWorld(5);
  assert.ok([72, 96, 150, 300].includes(w.rules.dpi));
  assert.ok([1, 2, 4, 8, 16].includes(w.rules.roundTo));
  assert.ok(['nearest', 'up', 'down'].includes(w.rules.roundMode));
  assert.ok(['additive', 'multiplicative'].includes(w.rules.opacityCompound));
  assert.ok(['svg', 'png'].includes(w.rules.defaultFormat.image));
  assert.ok(['wav', 'qa8'].includes(w.rules.defaultFormat.audio));
  assert.equal(w.rules.defaultFormat.video, 'qvid');
  assert.ok([22050, 44100, 48000].includes(w.rules.defaultSampleRate));
  assert.ok([12, 24, 30].includes(w.rules.defaultFps));
  assert.ok(['listOrder', 'explicit'].includes(w.rules.zOrder));
  assert.ok(['hsl', 'hsv'].includes(w.rules.colorShiftSpace));
  assert.ok(['KB', 'MB'].includes(w.rules.bitrateBudgetUnit));
  for (const unit of ['inch', 'cm', 'pt']) {
    assert.ok(Array.isArray(w.rules.unitWords[unit]));
    assert.ok(w.rules.unitWords[unit].length >= 2);
  }
});

test('auth has a bearer TTL in the documented 90..600 range', () => {
  const w = makeWorld(6);
  assert.ok(w.auth.tokenTtlSec >= 90 && w.auth.tokenTtlSec <= 600);
  assert.equal(typeof w.auth.apiKey, 'string');
  assert.equal(typeof w.auth.secret, 'string');
  assert.equal(w.auth.refreshPath, '/auth/refresh');
});

test('rate limit is in the documented 20..60 range, window is 10s', () => {
  const w = makeWorld(7);
  assert.ok(w.rate.limit >= 20 && w.rate.limit <= 60);
  assert.equal(w.rate.windowSec, 10);
});

test('pagination page size is in the documented 5..25 range', () => {
  const w = makeWorld(8);
  assert.ok(w.pagination.pageSize >= 5 && w.pagination.pageSize <= 25);
  assert.ok(['b64json', 'b64id', 'opaque'].includes(w.pagination.cursorStyle));
});

test('traps.live has at least 2 unique, valid trap names', () => {
  const catalog = ['fieldCase', 'deleteStatus', 'optionalIsRequired', 'enumSpelling', 'wrongDefault', 'missingRequiredHeader'];
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const w = makeWorld(seed);
    assert.ok(w.traps.live.length >= 2, `seed ${seed} has fewer than 2 live traps`);
    assert.equal(new Set(w.traps.live).size, w.traps.live.length, 'trap names must be unique');
    for (const t of w.traps.live) assert.ok(catalog.includes(t));
  }
});

test('deprecated has at least one entry', () => {
  const w = makeWorld(9);
  assert.ok(Object.keys(w.deprecated).length >= 1);
});

test('loras: 6 to 12 entries, human first names, valid ops, unique ids', () => {
  const humanNames = new Set([
    'Jenny', 'Moss', 'Iker', 'Petra', 'Dax', 'Wren', 'Sable', 'Omar',
    'Ines', 'Tulli', 'Vex', 'Rune', 'Sana', 'Botan', 'Leni', 'Cass',
  ]);
  for (const seed of [1, 2, 3, 4, 5]) {
    const w = makeWorld(seed);
    assert.ok(w.loras.length >= 6 && w.loras.length <= 12);
    const ids = new Set(w.loras.map((l) => l.id));
    assert.equal(ids.size, w.loras.length, 'lora ids must be unique');
    for (const lora of w.loras) {
      assert.ok(humanNames.has(lora.name), `${lora.name} is not a human first name`);
      assert.ok(['hueShift', 'scale', 'opacity', 'invert'].includes(lora.op));
      assert.equal(typeof lora.amount, 'number');
    }
  }
});

test('hmac config matches the documented shape', () => {
  const w = makeWorld(10);
  assert.deepEqual(w.hmac, { header: 'X-Signature', tsHeader: 'X-Timestamp', algo: 'sha256', canon: 'ts+method+path' });
});

test('resolvePath replaces all four vocab placeholders', () => {
  const w = makeWorld(11);
  const resolved = resolvePath(w, '/{workspaces}/{id}/{projects}/{id}/{assets}');
  assert.ok(!resolved.includes('{workspaces}'));
  assert.ok(!resolved.includes('{projects}'));
  assert.ok(!resolved.includes('{assets}'));
  assert.ok(resolved.includes('{id}'), 'non-vocab placeholders are left alone');
});

test('resolvePath resolves {library} without pluralizing it', () => {
  const w = makeWorld(12);
  assert.equal(resolvePath(w, '/{library}'), `/${w.vocab.library}`);
});

test('resolvePath leaves paths with no placeholders untouched', () => {
  const w = makeWorld(13);
  assert.equal(resolvePath(w, '/auth/token'), '/auth/token');
});

test('resolvePath is deterministic', () => {
  const w = makeWorld(14);
  const path = '/{workspaces}/{id}/{projects}';
  assert.equal(resolvePath(w, path), resolvePath(w, path));
});

test('fieldName applies the base naming convention', () => {
  const snakeWorld = { naming: 'snake', namingExceptions: [] };
  const camelWorld = { naming: 'camel', namingExceptions: [] };
  assert.equal(fieldName(snakeWorld, 'created_at'), 'created_at');
  assert.equal(fieldName(camelWorld, 'created_at'), 'createdAt');
});

test('fieldName flips exception fields to the opposite convention', () => {
  const snakeWorld = { naming: 'snake', namingExceptions: ['created_at'] };
  const camelWorld = { naming: 'camel', namingExceptions: ['created_at'] };
  assert.equal(fieldName(snakeWorld, 'created_at'), 'createdAt');
  assert.equal(fieldName(camelWorld, 'created_at'), 'created_at');
});

test('fieldName only affects listed exceptions', () => {
  const snakeWorld = { naming: 'snake', namingExceptions: ['created_at'] };
  assert.equal(fieldName(snakeWorld, 'updated_at'), 'updated_at');
});
