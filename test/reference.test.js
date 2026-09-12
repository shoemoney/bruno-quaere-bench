// The gate: for seeds 1, 2, 3, start a real in-process server, post the answer key computed
// purely from the world, then climb rungs 0..99 for real over HTTP and require zero failures.
// A failure here means the ladder generator (or, occasionally, the API) has a bug -- not that the
// task was merely hard, since the reference is handed the exact plan it needs to execute.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeWorld } from '../src/world.js';
import { createServer } from '../src/api/server.js';
import { climb, answerKey } from '../src/ladder/reference.js';

async function postAdminJson(adminPort, path, body) {
  const res = await fetch(`http://127.0.0.1:${adminPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`admin ${path} -> ${res.status}`);
  return res.json();
}

for (const seed of [1, 2, 3]) {
  test(`reference climbs 0..99 clean on seed ${seed}`, async () => {
    const world = makeWorld(seed);
    const server = createServer({ world, publicPort: 0, adminPort: 0 });
    const { publicPort, adminPort } = await server.start();
    try {
      const key = answerKey(world);
      await postAdminJson(adminPort, '/admin/rungs', key);

      const result = await climb({
        world,
        baseUrl: `http://127.0.0.1:${publicPort}`,
        apiKey: world.auth.apiKey,
        from: 0,
        to: 99,
      });

      if (result.failed.length > 0) {
        const first = result.failed.slice(0, 5);
        assert.fail(`seed ${seed}: ${result.failed.length} rungs failed, first: ${JSON.stringify(first)}`);
      }
      assert.equal(result.passed.length, 100);
    } finally {
      await server.stop();
    }
  });
}
