import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, sha256, hashArtifact } from '../src/canon.js';

test('canonical sorts object keys regardless of input order', () => {
  const a = canonical({ b: 1, a: 2, c: 3 });
  const b = canonical({ c: 3, a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1,"c":3}');
});

test('canonical sorts nested object keys', () => {
  const out = canonical({ z: { y: 1, x: 2 }, a: 1 });
  assert.equal(out, '{"a":1,"z":{"x":2,"y":1}}');
});

test('canonical preserves array order', () => {
  const out = canonical({ a: [3, 1, 2] });
  assert.equal(out, '{"a":[3,1,2]}');
});

test('canonical emits no extra whitespace', () => {
  const out = canonical({ a: 1, b: [1, 2] });
  assert.ok(!/\s/.test(out));
});

test('canonical is stable for repeated calls', () => {
  const value = { nested: { list: [{ b: 2, a: 1 }] }, top: true };
  assert.equal(canonical(value), canonical(value));
});

test('sha256 is deterministic and hex-encoded', () => {
  const h1 = sha256('hello');
  const h2 = sha256('hello');
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test('sha256 differs for different input', () => {
  assert.notEqual(sha256('hello'), sha256('world'));
});

test('sha256 works on Uint8Array bytes', () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const h = sha256(bytes);
  assert.match(h, /^[0-9a-f]{64}$/);
});

test('hashArtifact matches sha256 of the same bytes', () => {
  const bytes = new Uint8Array([9, 8, 7]);
  assert.equal(hashArtifact(bytes), sha256(bytes));
});

test('hashArtifact is deterministic', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  assert.equal(hashArtifact(bytes), hashArtifact(bytes));
});
