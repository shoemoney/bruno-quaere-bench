// Canonical JSON and content hashing. Byte-identical output for byte-identical
// inputs is the whole basis of the judge (bru run + hash equality).

import { createHash } from 'node:crypto';

// Deep-sort object keys recursively; arrays keep their order (order is
// meaningful, e.g. z-order and clip sequencing).
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortValue(value[key]);
    }
    return out;
  }
  return value;
}

// canonical(value) -> JSON string, sorted keys, no whitespace. JS's
// Number#toString (what JSON.stringify uses) already emits the shortest
// round-trip decimal representation, so no extra number formatting is needed.
export function canonical(value) {
  return JSON.stringify(sortValue(value));
}

// sha256(bytes | string) -> lowercase hex digest.
export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

// hashArtifact(bytes) -> sha256 hex of raw artifact bytes. The only thing
// the judge ever compares.
export function hashArtifact(bytes) {
  return sha256(bytes);
}
