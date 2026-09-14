// The release signature's canonical string: ONE implementation, shared by the generator, the
// reference, the doc-solver, the house and the written reference (`src/skill.js`), so no two of
// them can drift. Which recipe is in force is a World field, `hmac.canon`, resolved through
// `rulesAt(world, n)` because Addendum Q rule 4's closed set includes the field order of this
// very string.
//
// Addendum Q rule 10 / RULES-0.8 rule 35: from 0.7.0 the string BINDS A DIGEST of the artifact
// being released. The digest is the house's own sha256 of the artifact bytes, so the value can
// only come from a live response -- a signature cannot be templated once and replayed per rung.
// The three digest-bound recipes differ only in the order of the first three fields, which is
// exactly what rule 33 licenses an amendment to move.

// Every recipe the house knows, digest-bound ones first. `CANON_RECIPES` is what a decoy table or
// a doc generator should enumerate; `AMENDMENT_RULES.hmacCanon` in src/world.js draws from the
// digest-bound subset.
export const CANON_RECIPES = [
  'ts+method+path+digest',
  'ts+path+method+digest',
  'method+path+ts+digest',
  'ts+method+path',
  'ts+path+method',
  'method+path+ts',
];

// bindsDigest(canon): does this recipe require the artifact digest?
export function bindsDigest(canon) {
  return typeof canon === 'string' && canon.endsWith('+digest');
}

// canonicalString(canon, {ts, method, path, bodyDigest}) -> the exact bytes signed.
//
// The pre-0.7.0 recipes concatenate with NO separator at all (that is the single most common way
// to get a permanent 401 out of publish, and src/skill.js says so). The digest-bound recipes are
// newline-separated so no two fields can run together, with the digest last so a grader reading
// the `X-Body-Digest` header can line it up with the tail of the string.
export function canonicalString(canon, { ts, method, path, bodyDigest } = {}) {
  const part = { ts: String(ts), method, path };
  const order = typeof canon === 'string' ? canon.split('+') : [];
  const digestBound = bindsDigest(canon);
  const fields = digestBound ? order.slice(0, -1) : order;
  if (fields.length !== 3 || !fields.every((f) => part[f] !== undefined)) {
    throw new Error(`unknown canonical-string recipe: ${canon}`);
  }
  const known = new Set(['ts', 'method', 'path']);
  if (new Set(fields).size !== 3 || !fields.every((f) => known.has(f))) {
    throw new Error(`unknown canonical-string recipe: ${canon}`);
  }
  if (!digestBound) return fields.map((f) => part[f]).join('');
  if (typeof bodyDigest !== 'string' || bodyDigest.length !== 64) {
    throw new Error('canonicalString: the digest-bound recipe needs a 64-hex body digest');
  }
  return [...fields.map((f) => part[f]), bodyDigest].join('\n');
}
