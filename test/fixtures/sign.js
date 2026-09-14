// Signing a release the way RULES-0.8 rule 35 describes, for the tests that need a publish to
// succeed. One helper, built on src/hmac.js's `canonicalString`, so no test carries its own copy
// of the recipe and none of them has to be touched again if rule 33 amends the field order.
//
// The digest is the house's own hash of the artifact bytes -- which is exactly the `hash` the
// house reports for the asset, so a test that already holds a create response already holds it.
import { createHmac } from 'node:crypto';

import { canonicalString, bindsDigest } from '../../src/hmac.js';

export const DIGEST_HEADER = 'X-Body-Digest';

export function publishHeaders(world, { path, bodyDigest, ts = String(Math.floor(Date.now() / 1000)) }) {
  const signature = createHmac(world.hmac.algo, world.auth.secret)
    .update(canonicalString(world.hmac.canon, { ts, method: 'POST', path, bodyDigest }))
    .digest('hex');
  const headers = { [world.hmac.tsHeader]: ts, [world.hmac.header]: signature };
  if (bindsDigest(world.hmac.canon)) headers[DIGEST_HEADER] = bodyDigest;
  return headers;
}
