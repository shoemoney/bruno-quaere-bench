// The cross-cutting behaviors woven into every route: etags, idempotency, rate limiting,
// cursor pagination, HMAC request signing, CSV negotiation, and response field naming.
// Pure helpers plus small stateful factories (rate limiter, idempotency store); no HTTP here.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { fieldName } from '../world.js';

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
// HMAC request signing (publish)
// ---------------------------------------------------------------------------

// verifyHmac(world, {ts, signature, method, path}, now) -> boolean.
// canon is world.hmac.canon === 'ts+method+path'; ts must be unix seconds within 300s of now.
export function verifyHmac(world, { ts, signature, method, path }, now) {
  if (!ts || !signature) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(now / 1000 - tsNum) > 300) return false;
  const payload = `${ts}${method}${path}`;
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
