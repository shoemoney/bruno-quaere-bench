// Deterministic PRNG and sub-seeding. No Date.now, no Math.random.

// mulberry32: fast, small, well-distributed 32-bit PRNG.
// rng(seed) returns a function that produces uniform floats in [0, 1).
export function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// fnv1a-32 over a string, used to turn a seed+label into a stable sub-seed.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// A stable sub-seed derived from a parent seed and a label. Two different
// labels never collide in practice, and the same (seed, label) pair always
// produces the same sub-seed, so callers can seed independent facets of a
// World without one facet's draw count shifting another's.
export function sub(seed, label) {
  return fnv1a(`${seed >>> 0}:${label}`) >>> 0;
}

// Pick one element of array using r() in [0, 1).
export function pick(r, array) {
  const i = Math.floor(r() * array.length);
  return array[i >= array.length ? array.length - 1 : i];
}

// Integer in [lo, hi], inclusive on both ends.
export function int(r, lo, hi) {
  return lo + Math.floor(r() * (hi - lo + 1));
}

// Fisher-Yates shuffle, non-mutating.
export function shuffle(r, array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

// true with probability p (0..1).
export function chance(r, p) {
  return r() < p;
}
