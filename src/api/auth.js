// Bearer-token auth: api key exchange, TTL, refresh. Wall clock (Date.now, passed in as `now`
// by the caller) is allowed here per the architecture doc's HTTP-layer carve-out.

import { randomBytes } from 'node:crypto';

// createAuthStore(): the per-server-instance token bookkeeping. Two indexes (by access token and
// by refresh token) so both verify and refresh are O(1).
export function createAuthStore() {
  return { byAccess: new Map(), byRefresh: new Map(), seq: 0 };
}

function genToken(prefix) {
  return `${prefix}_${randomBytes(24).toString('hex')}`;
}

// issueToken(world, store, now) -> {tokenId, accessToken, refreshToken, expiresAt, expiresIn}
export function issueToken(world, store, now) {
  store.seq += 1;
  const tokenId = `tok_${store.seq}`;
  const accessToken = genToken('at');
  const refreshToken = genToken('rt');
  const expiresIn = world.auth.tokenTtlSec;
  const record = { tokenId, accessToken, refreshToken, expiresAt: now + expiresIn * 1000, expiresIn };
  store.byAccess.set(accessToken, record);
  store.byRefresh.set(refreshToken, record);
  return record;
}

// refreshToken(world, store, refreshTokenValue, now) -> new record, or null if the refresh
// token is unknown. The old pair is retired (rotation) so a spent refresh token can't be reused.
export function refreshToken(world, store, refreshTokenValue, now) {
  const record = store.byRefresh.get(refreshTokenValue);
  if (!record) return null;
  store.byAccess.delete(record.accessToken);
  store.byRefresh.delete(refreshTokenValue);
  return issueToken(world, store, now);
}

// parseBearer(authorizationHeader) -> token string, or null if the header is missing/malformed.
export function parseBearer(authorizationHeader) {
  if (typeof authorizationHeader !== 'string') return null;
  const m = /^Bearer\s+(.+)$/.exec(authorizationHeader.trim());
  return m ? m[1] : null;
}

// verifyBearer(store, authorizationHeader, now) -> one of:
//   { ok: true, tokenId }
//   { ok: false, reason: 'missing' | 'invalid' | 'expired', tokenId? }
export function verifyBearer(store, authorizationHeader, now) {
  const token = parseBearer(authorizationHeader);
  if (!token) return { ok: false, reason: 'missing' };
  const record = store.byAccess.get(token);
  if (!record) return { ok: false, reason: 'invalid' };
  if (now >= record.expiresAt) return { ok: false, reason: 'expired', tokenId: record.tokenId };
  return { ok: true, tokenId: record.tokenId };
}
