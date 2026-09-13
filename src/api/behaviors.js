// The cross-cutting behaviors woven into every route: etags, idempotency, rate limiting,
// cursor pagination, HMAC request signing, CSV negotiation, and response field naming.
// Pure helpers plus small stateful factories (rate limiter, idempotency store); no HTTP here.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { fieldName } from '../world.js';
// Addendum Q rule 10: ONE canonical-string implementation, shared by the ladder's reference
// solution and the house, so the two can never drift on what bytes the release signature covers.
// See src/ladder/rung.js's "THE CANONICAL STRING" comment for the full ladder<->API contract.
import { canonicalString } from '../hmac.js';

// ---------------------------------------------------------------------------
// naming
// ---------------------------------------------------------------------------

// renameFields(world, value): deep-walks a plain JSON value and renames every object key
// through fieldName(world, key). Keys with no underscore (already-camel media-descriptor
// fields like `startMs`, `durationMs`) are a no-op under fieldName, so this is safe to apply
// to a whole response body, descriptor included, without disturbing the fixed media model.
export function renameFields(world, value) {
  if (Array.isArray(value)) return value.map((v) => renameFields(world, v));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[fieldName(world, k)] = renameFields(world, v);
    }
    return out;
  }
  return value;
}

// readField(world, body, snakeName): the inverse of renameFields for a single request-body
// field. A client under naming: 'camel' sends `displayName`; one under 'snake' (or where
// `snakeName` is a naming exception) sends `display_name`. Try the client-facing spelling
// first, then the canonical one, so callers always end up with plain snake-keyed values.
export function readField(world, body, snakeName) {
  if (!body || typeof body !== 'object') return undefined;
  const clientKey = fieldName(world, snakeName);
  if (body[clientKey] !== undefined) return body[clientKey];
  return body[snakeName];
}

// ---------------------------------------------------------------------------
// etag
// ---------------------------------------------------------------------------

// makeEtag(hash) -> the asset's ETag, a strong-looking quoted 16-hex-char tag.
export function makeEtag(hash) {
  return `"${hash.slice(0, 16)}"`;
}

// ---------------------------------------------------------------------------
// idempotency
// ---------------------------------------------------------------------------

export function createIdempotencyStore() {
  return new Map();
}

export function idempotencyKey(tokenId, routeId, key) {
  return `${tokenId}::${routeId}::${key}`;
}

// ---------------------------------------------------------------------------
// rate limiting: sliding window log per token, wall clock via Date.now passed in as `now`.
// ---------------------------------------------------------------------------

export function createRateLimiter(world) {
  const hits = new Map(); // tokenId -> ascending timestamps (ms) within the current window
  const windowMs = world.rate.windowSec * 1000;
  return {
    check(tokenId, now) {
      const prior = hits.get(tokenId) || [];
      const kept = prior.filter((t) => now - t < windowMs);
      if (kept.length >= world.rate.limit) {
        hits.set(tokenId, kept);
        const retryAfter = Math.max(1, Math.ceil((kept[0] + windowMs - now) / 1000));
        return { allowed: false, retryAfter };
      }
      kept.push(now);
      hits.set(tokenId, kept);
      return { allowed: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Addendum Q rule 9: a second, tighter bucket on the listing route that feeds a derived count.
// ---------------------------------------------------------------------------
//
// Same sliding-window shape as createRateLimiter above, but with a middle zone: once a token has
// used up the bucket's own (tighter) limit within the window, the house does not error outright --
// it hands back a SHORT page instead (checked() reports `short: true`; the caller is expected to
// cap the page it serves). Only once the token has burned all the way through the grace zone
// (`limit * GRACE`) does this actually 429, with `retryAfter` in seconds. `bucket` is
// `world.rate.buckets.listing` ({route, limit, windowSec}); a falsy bucket (older/hand-built world
// fixtures that predate Addendum Q) makes this a permanent no-op, same shape as before.
const LISTING_GRACE_MULTIPLIER = 2;

export function createBucketLimiter(bucket) {
  if (!bucket) return { check: () => ({ allowed: true, short: false }) };
  const hits = new Map(); // tokenId -> ascending timestamps (ms) within the current window
  const windowMs = bucket.windowSec * 1000;
  const hardLimit = bucket.limit * LISTING_GRACE_MULTIPLIER;
  return {
    check(tokenId, now) {
      const prior = hits.get(tokenId) || [];
      const kept = prior.filter((t) => now - t < windowMs);
      if (kept.length >= hardLimit) {
        hits.set(tokenId, kept);
        const retryAfter = Math.max(1, Math.ceil((kept[0] + windowMs - now) / 1000));
        return { allowed: false, retryAfter };
      }
      const short = kept.length >= bucket.limit;
      kept.push(now);
      hits.set(tokenId, kept);
      return { allowed: true, short };
    },
  };
}

// ---------------------------------------------------------------------------
// cursor pagination: cursorStyle decides encoding; callers never see a bare offset.
// ---------------------------------------------------------------------------

function encodeCursor(cursorStyle, offset, lastId) {
  if (cursorStyle === 'b64id' && lastId !== undefined) {
    return Buffer.from(String(lastId), 'utf8').toString('base64');
  }
  if (cursorStyle === 'opaque') {
    return Buffer.from(`o:${offset}`, 'utf8').toString('base64url');
  }
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64');
}

function decodeCursor(cursorStyle, cursor, items) {
  if (!cursor) return 0;
  try {
    if (cursorStyle === 'b64id') {
      const id = Buffer.from(cursor, 'base64').toString('utf8');
      const idx = items.findIndex((it) => it.id === id);
      return idx === -1 ? 0 : idx + 1;
    }
    if (cursorStyle === 'opaque') {
      const raw = Buffer.from(cursor, 'base64url').toString('utf8');
      const m = /^o:(\d+)$/.exec(raw);
      return m ? Number(m[1]) : 0;
    }
    const obj = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
    const offset = Number(obj.offset);
    return Number.isFinite(offset) && offset >= 0 ? offset : 0;
  } catch {
    return 0;
  }
}

// paginate(items, {cursor, pageSize, cursorStyle}) -> {data, cursor?}
// The last page carries no `cursor` key at all (never an empty-array/null signal).
export function paginate(items, { cursor, pageSize, cursorStyle }) {
  const offset = decodeCursor(cursorStyle, cursor, items);
  const data = items.slice(offset, offset + pageSize);
  const nextOffset = offset + pageSize;
  const result = { data };
  if (nextOffset < items.length) {
    result.cursor = encodeCursor(cursorStyle, nextOffset, data[data.length - 1]?.id);
  }
  return result;
}

// A cursor value that deliberately never decodes to a real offset, for the stuckCursor
// admin mutation: any client that trusts it back verbatim loops on page one forever.
export const STUCK_CURSOR_TOKEN = 'stuck-cursor-token';

// ---------------------------------------------------------------------------
// Addendum Q rule 3: the listing's next cursor travels ONLY in a `Link: rel="next"` header, never
// as a body field. buildNextLink keeps the request's other query params (page_size, etc.) and
// overwrites/sets `cursorParam` to `cursorValue`; the caller decides `cursorParam`'s name (plain
// "cursor", or whatever a live `renameField` mutation has renamed it to -- see admin.js's
// RUNG_MUTATION_TARGETS-derived candidates).
// ---------------------------------------------------------------------------
export function buildNextLink(pathname, searchParams, cursorParam, cursorValue) {
  const params = new URLSearchParams(searchParams);
  params.set(cursorParam, cursorValue);
  return `<${pathname}?${params.toString()}>; rel="next"`;
}

// ---------------------------------------------------------------------------
// HMAC request signing (publish)
// ---------------------------------------------------------------------------

// verifyHmac(world, {ts, signature, method, path, bodyDigest}, now) -> boolean.
// `world.hmac.canon` names the recipe in force (resolved by the caller through `rulesAt(world, n)`
// so a mid-ladder amendment can move it) and `canonicalString` (imported from src/hmac.js, the one
// reference solution) is the ONE place that turns a recipe name into bytes -- see Addendum Q rule
// 10. `ts` must be unix seconds within 300s of now regardless of which recipe is live.
export function verifyHmac(world, { ts, signature, method, path, bodyDigest }, now) {
  if (!ts || !signature) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(now / 1000 - tsNum) > 300) return false;
  let payload;
  try {
    payload = canonicalString(world.hmac.canon, { ts, method, path, bodyDigest });
  } catch {
    // Either an unknown recipe (a world.js bug, not this request's fault) or -- far more likely
    // in practice -- the digest-bound recipe is live and the caller sent no X-Body-Digest at all.
    // Either way, that is not a valid signature.
    return false;
  }
  const expected = createHmac(world.hmac.algo, world.auth.secret).update(payload).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const gotBuf = Buffer.from(String(signature), 'utf8');
  if (expectedBuf.length !== gotBuf.length) return false;
  return timingSafeEqual(expectedBuf, gotBuf);
}

// ---------------------------------------------------------------------------
// CSV negotiation
// ---------------------------------------------------------------------------

function csvEscape(value) {
  const s = value === undefined || value === null ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// toCsv(rows, columns) -> CSV text with a header row, columns in the given order.
export function toCsv(rows, columns) {
  const header = columns.map(csvEscape).join(',');
  const lines = rows.map((row) => columns.map((c) => csvEscape(row[c])).join(','));
  return [header, ...lines].map((l) => `${l}\r\n`).join('');
}

// wantsCsv(acceptHeader) -> true if the client's Accept header prefers text/csv over json.
export function wantsCsv(acceptHeader) {
  if (typeof acceptHeader !== 'string') return false;
  return acceptHeader.split(',').some((part) => part.trim().toLowerCase().startsWith('text/csv'));
}
