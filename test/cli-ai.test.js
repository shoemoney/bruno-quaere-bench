// harness/cli/ai.js (Addendum F): build() invocation shape, resume(), and parseUsage() against a
// live-captured fixture (test/fixtures/cli-ai-usage.json, captured 2026-09-12 by running
// `ai --no-chrome -p "Reply with exactly the word OK and nothing else." --model claude-sonnet-5
// --output-format json` once in a temp sandbox with a fresh CLAUDE_CONFIG_DIR).
//
// Also covers harness/cli/shim.js (the logging bru shim writer) and harness/cli/index.js (the
// per-name dispatcher), since both are small enough to share this file rather than get their own.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, resume, parseUsage, name as adapterName } from '../src/harness/cli/ai.js';
import { writeBruShim, buildShimEnv, readTurns, resolveRealBru } from '../src/harness/cli/shim.js';
import { loadAdapter, CLI_NAMES } from '../src/harness/cli/index.js';

const FIXTURE_URL = new URL('./fixtures/cli-ai-usage.json', import.meta.url);

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quaere-cli-ai-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function hasBru() {
  const result = spawnSync('bru', ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

// ---------------------------------------------------------------------------
// build() / resume()
// ---------------------------------------------------------------------------

test('ai.build: matches the Addendum F invocation exactly', () => {
  const { cmd, args, env, cwd } = build({
    sandbox: '/sandbox/dir',
    prompt: 'do the thing',
    model: 'claude-fable-5-1',
    home: '/fresh/config',
  });
  assert.equal(cmd, 'ai');
  assert.deepEqual(args, ['--no-chrome', '-p', 'do the thing', '--model', 'claude-fable-5-1', '--output-format', 'json']);
  assert.equal(env.CLAUDE_CONFIG_DIR, path.resolve('/fresh/config'));
  assert.equal(env.AI_NO_RTK, '1');
  assert.equal(cwd, '/sandbox/dir');
  assert.equal(adapterName, 'ai');
});

test('ai.build: throws a clear error for every missing required option', () => {
  const full = { sandbox: 's', prompt: 'p', model: 'm', home: 'h' };
  for (const key of Object.keys(full)) {
    const partial = { ...full, [key]: undefined };
    assert.throws(() => build(partial), new RegExp(key === 'home' ? 'home' : key));
  }
});

test('ai.resume: splices --resume <sessionId> in before -p, keeps everything else', () => {
  const { cmd, args, env } = resume('sess-123', {
    sandbox: '/sandbox/dir',
    prompt: 'continue; the current rung is 12',
    model: 'claude-fable-5-1',
    home: '/fresh/config',
  });
  assert.equal(cmd, 'ai');
  assert.deepEqual(args, [
    '--no-chrome',
    '--resume',
    'sess-123',
    '-p',
    'continue; the current rung is 12',
    '--model',
    'claude-fable-5-1',
    '--output-format',
    'json',
  ]);
  assert.equal(env.CLAUDE_CONFIG_DIR, path.resolve('/fresh/config'));
});

test('ai.resume: refuses to resume without a session id', () => {
  assert.throws(() => resume(undefined, { sandbox: 's', prompt: 'p', model: 'm', home: 'h' }), /session id/);
});

// ---------------------------------------------------------------------------
// parseUsage() against the live fixture
// ---------------------------------------------------------------------------

test('ai.parseUsage: reads tokens, cost, session id, and the working model off a live fixture', async () => {
  const stdout = await readFile(FIXTURE_URL, 'utf8');
  const usage = parseUsage(stdout);
  assert.equal(usage.tokensIn, 2);
  assert.equal(usage.tokensOut, 4);
  // cache_read_input_tokens (18531) + cache_creation_input_tokens (9111) from the fixture.
  assert.equal(usage.tokensCached, 18531 + 9111);
  assert.equal(usage.usageEstimated, false);
  assert.equal(usage.sessionId, '1a1afae0-5952-4a18-a4ab-84b4f6bd0edb');
  assert.equal(typeof usage.costUsd, 'number');
  assert.ok(usage.costUsd > 0);
  // The fixture's modelUsage carries a claude-haiku-4-5 helper entry alongside the model that
  // actually did the work; parseUsage must pick the one matching top-level usage, not either
  // arbitrarily or the alphabetically-first one.
  assert.equal(usage.modelVersion, 'claude-sonnet-5');
});

test('ai.parseUsage: throws a clear error on unparsable stdout', () => {
  assert.throws(() => parseUsage('not json'), /could not parse/);
});

test('ai.parseUsage: single-entry modelUsage is trusted directly', () => {
  const usage = parseUsage(
    JSON.stringify({
      session_id: 'abc',
      usage: { input_tokens: 5, output_tokens: 1 },
      modelUsage: { 'some-model': { inputTokens: 5, outputTokens: 1 } },
    }),
  );
  assert.equal(usage.modelVersion, 'some-model');
});

// ---------------------------------------------------------------------------
// shim.js
// ---------------------------------------------------------------------------

test('writeBruShim: logs {ts, argv} then execs the real bru with the same argv/exit code', async () => {
  if (!hasBru()) {
    return; // bru is a dev/CI tool here, not a runtime dependency of this package
  }
  await withTempDir(async (dir) => {
    const binDir = path.join(dir, 'bin');
    const turnsPath = path.join(dir, 'turns.jsonl');
    const realBru = resolveRealBru();
    const { shimPath } = writeBruShim({ binDir, turnsPath, realBruPath: realBru });

    const first = spawnSync(shimPath, ['--version'], { encoding: 'utf8' });
    const real = spawnSync(realBru, ['--version'], { encoding: 'utf8' });
    assert.equal(first.status, real.status);
    assert.equal(first.stdout, real.stdout);

    spawnSync(shimPath, ['run', 'nothing.bru'], { encoding: 'utf8' });
    const turns = readTurns(turnsPath);
    assert.equal(turns.length, 2);
    assert.deepEqual(turns[0].argv, ['--version']);
    assert.deepEqual(turns[1].argv, ['run', 'nothing.bru']);
    assert.equal(typeof turns[0].ts, 'number');
  });
});

test('writeBruShim: pins binDir to CommonJS so `require` works regardless of ancestor package.json', async () => {
  await withTempDir(async (dir) => {
    // Simulate a sandbox nested under a fake "type": "module" ancestor, the way a real run's
    // sandbox sits under this repo's own package.json.
    await mkdir(path.join(dir, 'esm-ancestor'), { recursive: true });
    await import('node:fs/promises').then((fsp) =>
      fsp.writeFile(path.join(dir, 'esm-ancestor', 'package.json'), '{"type":"module"}'),
    );
    const binDir = path.join(dir, 'esm-ancestor', 'sandbox', 'bin');
    const turnsPath = path.join(dir, 'turns.jsonl');
    const fakeRealBru = path.join(dir, 'fake-bru.js');
    await import('node:fs/promises').then((fsp) =>
      fsp.writeFile(fakeRealBru, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 }),
    );
    const { shimPath } = writeBruShim({ binDir, turnsPath, realBruPath: fakeRealBru });
    const result = spawnSync(shimPath, ['x'], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  });
});

test('buildShimEnv: prepends binDir to PATH, keeps the rest of the base env intact', () => {
  const env = buildShimEnv('/sandbox/bin', { PATH: '/usr/bin:/bin', HOME: '/x' });
  assert.equal(env.PATH, `/sandbox/bin${path.delimiter}/usr/bin:/bin`);
  assert.equal(env.HOME, '/x');
});

test('readTurns: an unwritten turns.jsonl reads as zero turns', () => {
  assert.deepEqual(readTurns('/does/not/exist/turns.jsonl'), []);
});

// ---------------------------------------------------------------------------
// index.js dispatch
// ---------------------------------------------------------------------------

test('loadAdapter: "ai" resolves to this module', async () => {
  const adapter = await loadAdapter('ai');
  assert.equal(adapter.name, 'ai');
  assert.equal(typeof adapter.build, 'function');
  assert.equal(typeof adapter.parseUsage, 'function');
  assert.equal(typeof adapter.resume, 'function');
});

test('loadAdapter: an unknown name throws and lists the known ones', async () => {
  await assert.rejects(loadAdapter('not-a-real-cli'), /unknown cli adapter.*known:/s);
});

test('loadAdapter: a known-but-unimplemented adapter names the missing file, not a bare module error', async () => {
  // qwen/gemini/kimi are other workstreams' files; whichever of them is not yet in this checkout
  // must fail with an actionable message rather than Node's raw "Cannot find module" -- and if one
  // has since been implemented, dispatch just works, which is also fine.
  const otherAdapters = CLI_NAMES.filter((n) => n !== 'ai' && n !== 'codex');
  for (const n of otherAdapters) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const adapter = await loadAdapter(n);
      assert.equal(adapter.name, n);
    } catch (err) {
      assert.match(err.message, /not implemented yet/);
    }
  }
});
