import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rng, sub, pick, int, shuffle, chance } from '../src/seed.js';

test('rng is deterministic for the same seed', () => {
  const a = rng(42);
  const b = rng(42);
  const seqA = Array.from({ length: 10 }, () => a());
  const seqB = Array.from({ length: 10 }, () => b());
  assert.deepEqual(seqA, seqB);
});

test('rng differs across seeds', () => {
  const a = rng(1);
  const b = rng(2);
  const seqA = Array.from({ length: 10 }, () => a());
  const seqB = Array.from({ length: 10 }, () => b());
  assert.notDeepEqual(seqA, seqB);
});

test('rng values stay within [0, 1)', () => {
  const r = rng(7);
  for (let i = 0; i < 1000; i++) {
    const v = r();
    assert.ok(v >= 0 && v < 1, `value out of range: ${v}`);
  }
});

test('sub is stable for the same seed+label', () => {
  assert.equal(sub(42, 'vocab'), sub(42, 'vocab'));
});

test('sub differs across labels for the same seed', () => {
  assert.notEqual(sub(42, 'vocab'), sub(42, 'ids'));
});

test('sub differs across seeds for the same label', () => {
  assert.notEqual(sub(1, 'vocab'), sub(2, 'vocab'));
});

test('pick returns an element from the array, deterministically', () => {
  const arr = ['a', 'b', 'c', 'd'];
  const r1 = rng(5);
  const r2 = rng(5);
  assert.equal(pick(r1, arr), pick(r2, arr));
  assert.ok(arr.includes(pick(rng(5), arr)));
});

test('int stays within inclusive bounds and is deterministic', () => {
  const r = rng(9);
  for (let i = 0; i < 200; i++) {
    const v = int(r, 3, 3);
    assert.equal(v, 3);
  }
  const r2 = rng(9);
  const values = new Set();
  for (let i = 0; i < 500; i++) values.add(int(r2, 1, 5));
  for (const v of values) assert.ok(v >= 1 && v <= 5);
});

test('shuffle is a permutation and does not mutate the input', () => {
  const arr = [1, 2, 3, 4, 5];
  const copy = arr.slice();
  const shuffled = shuffle(rng(3), arr);
  assert.deepEqual(arr, copy, 'input array must not be mutated');
  assert.deepEqual([...shuffled].sort(), [...arr].sort());
});

test('shuffle is deterministic for the same seed', () => {
  const arr = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.deepEqual(shuffle(rng(11), arr), shuffle(rng(11), arr));
});

test('chance respects extremes deterministically', () => {
  const r = rng(1);
  assert.equal(chance(r, 0), false);
});

test('chance(1) is always true', () => {
  const r = rng(1);
  for (let i = 0; i < 50; i++) assert.equal(chance(r, 1), true);
});
