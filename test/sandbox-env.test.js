// Addendum L: "the sandbox never contained the signing secret." Both run paths must write
// environments/local.yml into the sandbox before the first turn, carrying baseUrl, apiKey, and
// the world's HMAC signing secret -- the one thing every publish rung (50+) needs and no other
// document (SKILL.md/HOUSE-RULES.md, spec.json, TASK.md, the system prompt) ever states.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { makeWorld } from '../src/world.js';
import { buildLocalEnv, LOCAL_ENV_PATH } from '../src/harness/sandbox-env.js';
import { climb } from '../src/harness/run.js';
import { prepareCliSandbox } from '../src/harness/run-cli.js';

let nextPort = 49800;
function freshPorts() {
  const publicPort = nextPort;
  const adminPort = nextPort + 1;
  nextPort += 2;
  return { publicPort, adminPort };
}

async function withTmpDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quaere-sandbox-env-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A tiny, format-specific YAML reader -- just enough to parse the fixed shape buildLocalEnv
// produces (a top-level `variables:` list of `{name, value, secret?}` entries), never a general
// YAML parser.
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

test('buildLocalEnv: produces an OpenCollection environment with baseUrl, apiKey, and secret', () => {
  const text = buildLocalEnv({ baseUrl: 'http://127.0.0.1:9999', apiKey: 'key_abc', secret: 'sec_xyz' });
  assert.match(text, /^name: local/);
  const vars = parseLocalEnv(text);
  assert.equal(vars.baseUrl.value, 'http://127.0.0.1:9999');
  assert.equal(vars.apiKey.value, 'key_abc');
  assert.equal(vars.apiKey.secret, true);
  assert.equal(vars.secret.value, 'sec_xyz');
  assert.equal(vars.secret.secret, true, 'the signing secret variable must be marked secret: true');
});

test('buildLocalEnv: throws on any missing input rather than writing a partial file', () => {
  assert.throws(() => buildLocalEnv({ apiKey: 'a', secret: 'b' }), /baseUrl/);
  assert.throws(() => buildLocalEnv({ baseUrl: 'http://x', secret: 'b' }), /apiKey/);
  assert.throws(() => buildLocalEnv({ baseUrl: 'http://x', apiKey: 'a' }), /secret/);
});

// ---------------------------------------------------------------------------
// run.js (message-loop path)
// ---------------------------------------------------------------------------

function makeScriptedDriver() {
  return {
    async step() {
      return { assistant: '', toolCalls: [{ id: 't1', name: 'ls', input: { path: '.' } }], usage: { input_tokens: 10, output_tokens: 10 }, stop: 'tool_use' };
    },
  };
}

test('climb() (message-loop path): writes environments/local.yml carrying world.auth.secret before the first turn', async () => {
  await withTmpDir(async (outDir) => {
    const seed = 501;
    const world = makeWorld(seed);
    const driver = makeScriptedDriver();

    await climb({ model: 'fake-sandbox-env', seed, outDir, driver, maxTurns: 1, ...freshPorts() });

    const envPath = path.join(outDir, 'fake-sandbox-env', String(seed), '1', 'sandbox', LOCAL_ENV_PATH);
    const text = await readFile(envPath, 'utf8');
    const vars = parseLocalEnv(text);
    assert.equal(vars.apiKey.value, world.auth.apiKey);
    assert.equal(vars.secret.value, world.auth.secret);
    assert.match(vars.baseUrl.value, /^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

// ---------------------------------------------------------------------------
// run-cli.js (native CLI path)
// ---------------------------------------------------------------------------

test('prepareCliSandbox() (CLI path): writes environments/local.yml carrying world.auth.secret', async () => {
  await withTmpDir(async (sandboxDir) => {
    const seed = 502;
    const world = makeWorld(seed);
    const baseUrl = 'http://127.0.0.1:12345';

    await prepareCliSandbox({ world, sandboxDir, baseUrl, budgetTokens: 1000, skillMode: 'clean' });

    const text = await readFile(path.join(sandboxDir, LOCAL_ENV_PATH), 'utf8');
    const vars = parseLocalEnv(text);
    assert.equal(vars.baseUrl.value, baseUrl);
    assert.equal(vars.apiKey.value, world.auth.apiKey);
    assert.equal(vars.secret.value, world.auth.secret);

    // TASK.md must name the file in at least one sentence.
    const taskMd = await readFile(path.join(sandboxDir, 'TASK.md'), 'utf8');
    assert.match(taskMd, /environments\/local\.yml/);
  });
});

test('run.js system prompt (prompt.md) also names environments/local.yml', async () => {
  const promptPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'harness', 'prompt.md');
  const text = await readFile(promptPath, 'utf8');
  assert.match(text, /environments\/local\.yml/);
});
