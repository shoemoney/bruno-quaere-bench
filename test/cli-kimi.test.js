// harness/cli/kimi.js (Addendum F, corrected): build() invocation shape, seedKimiHome()
// isolation, resume(), and parseUsage() against live-captured fixtures
// (test/fixtures/cli-kimi-usage.stream.jsonl + cli-kimi-wire.jsonl, captured 2026-09-12 by
// running `kimi -p "Reply with exactly: PONG2" --output-format stream-json` once in a fresh HOME
// seeded from the operator's real ~/.kimi-code/{config.toml,device_id}).
//
// Also documents the investigated deviation from ARCHITECTURE.md (~/.kimi -> ~/.kimi-code, see
// the long comment at the top of src/harness/cli/kimi.js): a fixture "real home" with only
// config.toml + device_id (no ~/.kimi/credentials involved at all) is what a working sandbox
// actually needs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, cp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { build, resume, parseUsage, seedKimiHome, name as adapterName } from '../src/harness/cli/kimi.js';
import { loadAdapter } from '../src/harness/cli/index.js';

const STREAM_FIXTURE_URL = new URL('./fixtures/cli-kimi-usage.stream.jsonl', import.meta.url);
const WIRE_FIXTURE_URL = new URL('./fixtures/cli-kimi-wire.jsonl', import.meta.url);
const REAL_SESSION_ID = 'session_85e9852d-86a9-4325-9dbd-659c2652f1fc';
const REAL_WORKDIR_BUCKET = 'wd_bruno-awareness-ideas_fab909f03e0a';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quaere-cli-kimi-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function hasKimi() {
  const result = spawnSync('kimi', ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

// Lays down <home>/.kimi-code/sessions/<bucket>/<sessionId>/agents/main/wire.jsonl from the
// captured fixture, so parseUsage()'s findWireFile() walk has something real to find.
async function seedFixtureSession(home) {
  const agentDir = path.join(home, '.kimi-code', 'sessions', REAL_WORKDIR_BUCKET, REAL_SESSION_ID, 'agents', 'main');
  await mkdir(agentDir, { recursive: true });
  await cp(WIRE_FIXTURE_URL, path.join(agentDir, 'wire.jsonl'));
}

// A fake "real ~/.kimi-code" to seed FROM, so tests never touch the operator's actual device_id.
async function fakeRealKimiCodeHome(dir) {
  const realHome = path.join(dir, 'fake-real-kimi-code');
  await mkdir(realHome, { recursive: true });
  await writeFile(path.join(realHome, 'config.toml'), 'default_model = "kimi-code/k3"\n');
  await writeFile(path.join(realHome, 'device_id'), 'fake-device-id-not-real');
  return realHome;
}

// ---------------------------------------------------------------------------
// seedKimiHome()
// ---------------------------------------------------------------------------

test('seedKimiHome: copies config.toml + device_id into <home>/.kimi-code without touching the source', async () => {
  await withTempDir(async (dir) => {
    const realHome = await fakeRealKimiCodeHome(dir);
    const home = path.join(dir, 'fresh-home');
    const dst = seedKimiHome(home, { realHome });
    assert.equal(dst, path.join(home, '.kimi-code'));
    const copiedConfig = await readFile(path.join(dst, 'config.toml'), 'utf8');
    const copiedDeviceId = await readFile(path.join(dst, 'device_id'), 'utf8');
    assert.equal(copiedConfig, 'default_model = "kimi-code/k3"\n');
    assert.equal(copiedDeviceId, 'fake-device-id-not-real');
    // Source untouched.
    assert.ok(fs.existsSync(path.join(realHome, 'config.toml')));
  });
});

test('seedKimiHome: requires a home directory', () => {
  assert.throws(() => seedKimiHome(undefined, { realHome: '/x' }), /home/);
});

// ---------------------------------------------------------------------------
// build() / resume()
// ---------------------------------------------------------------------------

test('kimi.build: matches the Addendum F invocation exactly (model omitted, per the doc example)', async () => {
  await withTempDir(async (dir) => {
    const realHome = await fakeRealKimiCodeHome(dir);
    const { cmd, args, env, cwd } = build({
      sandbox: '/sandbox/dir',
      prompt: 'do the thing',
      home: path.join(dir, 'fresh-home'),
      kimiRealHome: realHome,
    });
    assert.equal(cmd, 'kimi');
    assert.deepEqual(args, ['-p', 'do the thing', '--output-format', 'stream-json']);
    assert.equal(env.HOME, path.resolve(path.join(dir, 'fresh-home')));
    assert.equal(cwd, '/sandbox/dir');
    assert.equal(adapterName, 'kimi');
    // build() seeded the fresh home as a side effect.
    assert.ok(fs.existsSync(path.join(dir, 'fresh-home', '.kimi-code', 'config.toml')));
  });
});

test('kimi.build: an explicit model is appended as -m (unlike qwen/gemini, optional here)', async () => {
  await withTempDir(async (dir) => {
    const realHome = await fakeRealKimiCodeHome(dir);
    const { args } = build({
      sandbox: '/s',
      prompt: 'p',
      model: 'kimi-code/kimi-for-coding',
      home: path.join(dir, 'fresh-home'),
      kimiRealHome: realHome,
    });
    assert.deepEqual(args, ['-m', 'kimi-code/kimi-for-coding', '-p', 'p', '--output-format', 'stream-json']);
  });
});

test('kimi.build: throws a clear error for every missing required option (model excluded, it is optional)', async () => {
  await withTempDir(async (dir) => {
    const realHome = await fakeRealKimiCodeHome(dir);
    const full = { sandbox: 's', prompt: 'p', home: path.join(dir, 'fresh-home'), kimiRealHome: realHome };
    for (const key of ['sandbox', 'prompt', 'home']) {
      const partial = { ...full, [key]: undefined };
      assert.throws(() => build(partial), new RegExp(key === 'home' ? 'home' : key));
    }
  });
});

test('kimi.resume: "-S <sessionId>" comes first, model (if any) still appended', async () => {
  await withTempDir(async (dir) => {
    const realHome = await fakeRealKimiCodeHome(dir);
    const { cmd, args, env } = resume('sess-123', {
      sandbox: '/sandbox/dir',
      prompt: 'continue; the current rung is 12',
      model: 'kimi-code/k3',
      home: path.join(dir, 'fresh-home'),
      kimiRealHome: realHome,
    });
    assert.equal(cmd, 'kimi');
    assert.deepEqual(args, ['-S', 'sess-123', '-m', 'kimi-code/k3', '-p', 'continue; the current rung is 12', '--output-format', 'stream-json']);
    assert.equal(env.HOME, path.resolve(path.join(dir, 'fresh-home')));
  });
});

test('kimi.resume: refuses to resume without a session id', () => {
  assert.throws(() => resume(undefined, { sandbox: 's', prompt: 'p', home: 'h' }), /session id/);
});

// ---------------------------------------------------------------------------
// parseUsage() against live fixtures
// ---------------------------------------------------------------------------

test('kimi.parseUsage: with the session file present, reads real usage.record totals from wire.jsonl', async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, 'home');
    await seedFixtureSession(home);
    const stdout = await readFile(STREAM_FIXTURE_URL, 'utf8');
    const usage = parseUsage(stdout, home);
    // From the real captured usage.record: {inputOther:19914, output:48, inputCacheRead:0, inputCacheCreation:0}.
    assert.equal(usage.tokensIn, 19914);
    assert.equal(usage.tokensOut, 48);
    assert.equal(usage.tokensCached, 0);
    assert.equal(usage.usageEstimated, false);
    assert.equal(usage.modelVersion, 'kimi-code/k3');
    assert.equal(usage.sessionId, REAL_SESSION_ID);
  });
});

test('kimi.parseUsage: sums MULTIPLE usage.record events (more than one model call in a turn)', async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, 'home');
    const agentDir = path.join(home, '.kimi-code', 'sessions', 'bucket1', 'sess-x', 'agents', 'main');
    await mkdir(agentDir, { recursive: true });
    const wire = [
      JSON.stringify({ type: 'usage.record', model: 'kimi-code/k3', usage: { inputOther: 100, output: 5, inputCacheRead: 10, inputCacheCreation: 0 } }),
      JSON.stringify({ type: 'usage.record', model: 'kimi-code/k3', usage: { inputOther: 40, output: 2, inputCacheRead: 0, inputCacheCreation: 3 } }),
    ].join('\n');
    await writeFile(path.join(agentDir, 'wire.jsonl'), wire);
    const stdout = JSON.stringify({ type: 'session.resume_hint', session_id: 'sess-x' });
    const usage = parseUsage(stdout, home);
    assert.equal(usage.tokensIn, 100 + 10 + 40 + 3);
    assert.equal(usage.tokensCached, 10);
    assert.equal(usage.tokensOut, 7);
    assert.equal(usage.modelVersion, 'kimi-code/k3');
  });
});

test('kimi.parseUsage: no session/wire file -- falls back to chars/4 with usageEstimated true', () => {
  const stdout = [
    JSON.stringify({ role: 'meta', type: 'system.version', version: '0.42.0' }),
    JSON.stringify({ role: 'assistant', content: 'OK' }),
  ].join('\n');
  // No `home` at all, and no session.resume_hint -- the pure chars/4 path.
  const usage = parseUsage(stdout, undefined);
  assert.equal(usage.usageEstimated, true);
  assert.equal(usage.modelVersion, null);
  assert.equal(usage.tokensOut, Math.ceil('OK'.length / 4));
  assert.ok(usage.tokensIn >= 0);
});

test('kimi.parseUsage: session.resume_hint present but no matching session dir on disk -- still falls back', async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, 'home-with-no-sessions');
    await mkdir(home, { recursive: true });
    const stdout = [
      JSON.stringify({ role: 'assistant', content: 'PONG2' }),
      JSON.stringify({ type: 'session.resume_hint', session_id: 'no-such-session' }),
    ].join('\n');
    const usage = parseUsage(stdout, home);
    assert.equal(usage.usageEstimated, true);
    assert.equal(usage.sessionId, 'no-such-session');
  });
});

test('kimi.parseUsage: tolerates a stray non-JSON banner line on stdout', async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, 'home');
    await seedFixtureSession(home);
    const raw = await readFile(STREAM_FIXTURE_URL, 'utf8');
    const stdout = `Some banner line that is not JSON\n${raw}`;
    const usage = parseUsage(stdout, home);
    assert.equal(usage.tokensIn, 19914);
    assert.equal(usage.sessionId, REAL_SESSION_ID);
  });
});

// ---------------------------------------------------------------------------
// index.js dispatch
// ---------------------------------------------------------------------------

test('loadAdapter: "kimi" resolves to this module', async () => {
  const adapter = await loadAdapter('kimi');
  assert.equal(adapter.name, 'kimi');
  assert.equal(typeof adapter.build, 'function');
  assert.equal(typeof adapter.parseUsage, 'function');
  assert.equal(typeof adapter.resume, 'function');
});

// ---------------------------------------------------------------------------
// Optional live smoke test: rung-0-equivalent trivial prompt, skipped when kimi isn't installed
// or there's no real ~/.kimi-code/{config.toml,device_id} to seed from.
// ---------------------------------------------------------------------------

test('kimi CLI live smoke: a trivial prompt produces a parseable stream-json reply and real usage', async (t) => {
  if (!hasKimi()) {
    t.skip('kimi is not on PATH');
    return;
  }
  const realConfig = path.join(os.homedir(), '.kimi-code', 'config.toml');
  const realDeviceId = path.join(os.homedir(), '.kimi-code', 'device_id');
  if (!fs.existsSync(realConfig) || !fs.existsSync(realDeviceId)) {
    t.skip('no real ~/.kimi-code/{config.toml,device_id} to seed from');
    return;
  }
  await withTempDir(async (dir) => {
    const home = path.join(dir, 'home');
    const sandbox = path.join(dir, 'sandbox');
    await mkdir(sandbox, { recursive: true });
    const { cmd, args, env, cwd } = build({
      sandbox,
      prompt: 'Reply with exactly the word OK and nothing else.',
      home,
    });
    const result = spawnSync(cmd, args, { env: { ...process.env, ...env }, cwd, encoding: 'utf8', timeout: 90_000 });
    assert.equal(result.status, 0, result.stderr);
    const usage = parseUsage(result.stdout, home);
    assert.ok(usage.tokensIn > 0 || usage.usageEstimated);
    assert.ok(usage.sessionId);
  });
});
