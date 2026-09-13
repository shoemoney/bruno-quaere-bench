// Addendum L's proof obligation: "a sandbox-fidelity test runs the reference climb using ONLY
// files present in a freshly prepared sandbox ... as its inputs, so anything the docs promise
// the sandbox contains is proven present." This prepares a sandbox exactly the way run-cli.js's
// climb() does (via the same prepareCliSandbox() it calls) for seed 5 -- no CLI spawned, no
// climb() run -- then drives the FULL reference climb (rungs 0..99) reading baseUrl, apiKey, and
// the HMAC signing secret ONLY from the sandbox's environments/local.yml, never from the World
// object those values were originally drawn from. A wrong or stale value written into the file
// would fail this test even though the world itself is fine, which is exactly the class of bug
// Addendum L describes (the file was never written at all).
//
// Like test/reference.test.js, this is a full 100-rung climb over real HTTP against the house
// rate limiter -- expect several minutes, not seconds. Run with a generous --test-timeout.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { makeWorld } from '../src/world.js';
import { createServer } from '../src/api/server.js';
import { climb as referenceClimb, answerKey } from '../src/ladder/reference.js';
import { prepareCliSandbox } from '../src/harness/run-cli.js';
import { LOCAL_ENV_PATH } from '../src/harness/sandbox-env.js';

const SEED = 5;

// Same tiny format-specific reader as test/sandbox-env.test.js -- deliberately not a general
// YAML parser, just enough for the fixed `variables: [{name, value, secret?}]` shape.
function parseLocalEnv(text) {
  const vars = {};
  let current = null;
  for (const rawLine of text.split('\n')) {
    const nameMatch = rawLine.match(/^\s*-\s*name:\s*(.+)$/);
    if (nameMatch) {
      current = nameMatch[1].trim();
      vars[current] = { value: undefined, secret: false };
      continue;
    }
    const valueMatch = rawLine.match(/^\s*value:\s*(.*)$/);
    if (valueMatch && current) {
      vars[current].value = valueMatch[1].trim();
      continue;
    }
    const secretMatch = rawLine.match(/^\s*secret:\s*(true|false)\s*$/);
    if (secretMatch && current) {
      vars[current].secret = secretMatch[1] === 'true';
    }
  }
  return vars;
}

async function postAdminJson(adminPort, pathname, body) {
  const res = await fetch(`http://127.0.0.1:${adminPort}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`admin ${pathname} -> ${res.status}`);
  return res.json();
}

test('sandbox fidelity: the reference climb passes 100/100 for seed 5 using only baseUrl/apiKey/secret read from environments/local.yml', async () => {
  const world = makeWorld(SEED);
  const server = createServer({ world, publicPort: 0, adminPort: 0 });
  const { publicPort, adminPort } = await server.start();
  const baseUrl = `http://127.0.0.1:${publicPort}`;
  const adminBaseUrl = `http://127.0.0.1:${adminPort}`;

  const sandboxDir = await mkdtemp(path.join(os.tmpdir(), 'quaere-sandbox-fidelity-'));
  try {
    await postAdminJson(adminPort, '/admin/rungs', answerKey(world));

    // Prepare the sandbox exactly as run-cli.js's climb() does -- no CLI spawned, no climb run.
    await prepareCliSandbox({ world, sandboxDir, baseUrl, skillMode: 'clean' });

    // Confirm spec.json and HOUSE-RULES.md exist too (allowed reads per Addendum L, even though
    // this particular check doesn't need their content).
    await readFile(path.join(sandboxDir, 'spec.json'), 'utf8');
    await readFile(path.join(sandboxDir, 'HOUSE-RULES.md'), 'utf8');

    // The only three values this climb is allowed to use, and the only place it reads them from:
    // the sandbox's own environments/local.yml, never world.auth directly.
    const envText = await readFile(path.join(sandboxDir, LOCAL_ENV_PATH), 'utf8');
    const vars = parseLocalEnv(envText);
    const sandboxBaseUrl = vars.baseUrl.value;
    const sandboxApiKey = vars.apiKey.value;
    const sandboxSecret = vars.secret.value;
    assert.ok(sandboxBaseUrl && sandboxApiKey && sandboxSecret, 'environments/local.yml must carry all three values');

    // A world clone whose auth is sourced ONLY from the sandbox file -- if prepareCliSandbox ever
    // wrote a wrong or stale apiKey/secret, this diverges from the server's real world.auth and
    // the climb below fails (a 401, or a bad HMAC signature on the first publish rung).
    const sandboxWorld = { ...world, auth: { ...world.auth, apiKey: sandboxApiKey, secret: sandboxSecret } };

    const result = await referenceClimb({
      world: sandboxWorld,
      baseUrl: sandboxBaseUrl,
      adminBaseUrl,
      apiKey: sandboxApiKey,
      from: 0,
      to: 99,
    });

    if (result.failed.length > 0) {
      const detail = result.failed.map((f) => `  rung ${f.n}: ${f.reason}`).join('\n');
      assert.fail(`seed ${SEED} failed ${result.failed.length}/100 rungs using only sandbox files:\n${detail}`);
    }
    assert.equal(result.passed.length, 100);
  } finally {
    await server.stop();
    await rm(sandboxDir, { recursive: true, force: true });
  }
});
