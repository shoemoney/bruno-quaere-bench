// harness/cli/qwen.js (Addendum F): build() invocation shape, env sourcing from ~/.qwen/.env,
// resume(), and parseUsage() against a live-captured fixture (test/fixtures/cli-qwen-usage.json,
// captured 2026-09-12 by running `qwen --approval-mode yolo -o json -m qwen3.8-max -p "Reply with
// exactly: OK"` once in a fresh HOME with the real ~/.qwen/.env sourced).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { build, resume, parseUsage, readQwenEnv, name as adapterName } from '../src/harness/cli/qwen.js';
import { loadAdapter } from '../src/harness/cli/index.js';

const FIXTURE_URL = new URL('./fixtures/cli-qwen-usage.json', import.meta.url);

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quaere-cli-qwen-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function hasQwen() {
  const result = spawnSync('qwen', ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

// ---------------------------------------------------------------------------
// build() / resume()
// ---------------------------------------------------------------------------

test('qwen.build: matches the Addendum F invocation exactly', () => {
  const { cmd, args, env, cwd } = build({
    sandbox: '/sandbox/dir',
    prompt: 'do the thing',
    model: 'qwen3.8-max',
    home: '/fresh/home',
    envPath: '/does/not/exist/.env', // no real dotenv on the test machine required
  });
  assert.equal(cmd, 'qwen');
  assert.deepEqual(args, ['--approval-mode', 'yolo', '-o', 'json', '-m', 'qwen3.8-max', '-p', 'do the thing']);
  assert.equal(env.HOME, path.resolve('/fresh/home'));
  assert.equal(env.QWEN_CODE_SUPPRESS_YOLO_WARNING, '1');
  assert.equal(cwd, '/sandbox/dir');
  assert.equal(adapterName, 'qwen');
});

test('qwen.build: merges ~/.qwen/.env (via readQwenEnv) into the child env', async () => {
  await withTempDir(async (dir) => {
    const envPath = path.join(dir, 'fake.env');
    // Fake, non-secret values -- proves the merge works without touching any real credential.
    await writeFile(envPath, 'OPENAI_API_KEY=fake-test-key\nOPENAI_BASE_URL="https://example.invalid/v1"\n# comment\n\nOPENAI_MODEL=qwen3.8-max\n');
    const { env } = build({ sandbox: '/s', prompt: 'p', model: 'qwen3.8-max', home: '/h', envPath });
    assert.equal(env.OPENAI_API_KEY, 'fake-test-key');
    assert.equal(env.OPENAI_BASE_URL, 'https://example.invalid/v1');
    assert.equal(env.OPENAI_MODEL, 'qwen3.8-max');
    // HOME set by the adapter always wins over anything a dotenv could contain.
    assert.equal(env.HOME, path.resolve('/h'));
  });
});

test('qwen.build: a missing dotenv file is not fatal, env merge is just empty', () => {
  assert.deepEqual(readQwenEnv('/definitely/does/not/exist/.env'), {});
  const { env } = build({ sandbox: '/s', prompt: 'p', model: 'm', home: '/h', envPath: '/definitely/does/not/exist/.env' });
  assert.equal(env.HOME, path.resolve('/h'));
});

test('qwen.build: throws a clear error for every missing required option', () => {
  const full = { sandbox: 's', prompt: 'p', model: 'm', home: 'h' };
  for (const key of Object.keys(full)) {
    const partial = { ...full, [key]: undefined };
    assert.throws(() => build(partial), new RegExp(key === 'home' ? 'home' : key));
  }
});

test('qwen.resume: splices --resume <sessionId> in before -m/-p, keeps everything else', () => {
  const { cmd, args, env } = resume('sess-123', {
    sandbox: '/sandbox/dir',
    prompt: 'continue; the current rung is 12',
    model: 'qwen3.8-max',
    home: '/fresh/home',
    envPath: '/does/not/exist/.env',
  });
  assert.equal(cmd, 'qwen');
  assert.deepEqual(args, [
    '--approval-mode',
    'yolo',
    '-o',
    'json',
    '--resume',
    'sess-123',
    '-m',
    'qwen3.8-max',
    '-p',
    'continue; the current rung is 12',
  ]);
  assert.equal(env.HOME, path.resolve('/fresh/home'));
});

test('qwen.resume: refuses to resume without a session id', () => {
  assert.throws(() => resume(undefined, { sandbox: 's', prompt: 'p', model: 'm', home: 'h' }), /session id/);
});

// ---------------------------------------------------------------------------
// parseUsage() against the live fixture
// ---------------------------------------------------------------------------

test('qwen.parseUsage: reads tokens, session id, and the working model off a live fixture', async () => {
  const stdout = await readFile(FIXTURE_URL, 'utf8');
  const usage = parseUsage(stdout);
  assert.equal(usage.tokensIn, 35194);
  assert.equal(usage.tokensOut, 296);
  assert.equal(usage.tokensCached, 0);
  assert.equal(usage.usageEstimated, false);
  assert.equal(usage.modelVersion, 'qwen3.8-max');
  assert.equal(usage.sessionId, '82099c1d-d3cb-4d60-adc9-55eeb9598f6c');
});

test('qwen.parseUsage: throws a clear error on unparsable stdout', () => {
  assert.throws(() => parseUsage('not json'), /could not parse|not valid JSON/);
});

test('qwen.parseUsage: throws a clear error when no {"type":"result"} event is present', () => {
  assert.throws(() => parseUsage(JSON.stringify([{ type: 'system', subtype: 'init' }])), /no.*result.*event/);
});

test('qwen.parseUsage: accepts a bare object (not wrapped in an array) defensively', () => {
  const usage = parseUsage(
    JSON.stringify({
      type: 'result',
      session_id: 'abc',
      usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 2 },
      stats: { models: { 'qwen3.8-max': {} } },
    }),
  );
  assert.equal(usage.tokensIn, 5);
  assert.equal(usage.tokensOut, 1);
  assert.equal(usage.tokensCached, 2);
  assert.equal(usage.modelVersion, 'qwen3.8-max');
});

// ---------------------------------------------------------------------------
// index.js dispatch
// ---------------------------------------------------------------------------

test('loadAdapter: "qwen" resolves to this module', async () => {
  const adapter = await loadAdapter('qwen');
  assert.equal(adapter.name, 'qwen');
  assert.equal(typeof adapter.build, 'function');
  assert.equal(typeof adapter.parseUsage, 'function');
  assert.equal(typeof adapter.resume, 'function');
});

// ---------------------------------------------------------------------------
// Optional live smoke test: rung-0-equivalent trivial prompt, skipped when qwen isn't installed
// or ~/.qwen/.env doesn't exist.
// ---------------------------------------------------------------------------

test('qwen CLI live smoke: a trivial prompt produces parseable -o json usage', async (t) => {
  if (!hasQwen()) {
    t.skip('qwen is not on PATH');
    return;
  }
  const realEnvPath = path.join(os.homedir(), '.qwen', '.env');
  if (Object.keys(readQwenEnv(realEnvPath)).length === 0) {
    t.skip('no ~/.qwen/.env to source for a live smoke test');
    return;
  }
  await withTempDir(async (dir) => {
    const home = path.join(dir, 'home');
    const sandbox = path.join(dir, 'sandbox');
    const fsp = await import('node:fs/promises');
    await fsp.mkdir(sandbox, { recursive: true });
    await fsp.mkdir(home, { recursive: true });
    const { cmd, args, env, cwd } = build({
      sandbox,
      prompt: 'Reply with exactly the word OK and nothing else.',
      model: 'qwen3.8-max',
      home,
    });
    const result = spawnSync(cmd, args, { env: { ...process.env, ...env }, cwd, encoding: 'utf8', timeout: 90_000 });
    assert.equal(result.status, 0, result.stderr);
    const usage = parseUsage(result.stdout);
    assert.ok(usage.tokensIn > 0);
  });
});
