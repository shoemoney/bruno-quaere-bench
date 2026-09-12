// harness/cli/codex.js (Addendum F): build() invocation shape, resume(), copyAuth() isolation,
// and parseUsage() against a live-captured fixture (test/fixtures/cli-codex-usage.jsonl, captured
// 2026-09-12 by running `codex exec --json -m gpt-6-astra -C <sandbox> --skip-git-repo-check
// --dangerously-bypass-approvals-and-sandbox "Reply with exactly the word OK and nothing else."`
// once with a fresh CODEX_HOME containing a copy of ~/.codex/auth.json).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, readFile as fsReadFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { build, resume, parseUsage, copyAuth, name as adapterName } from '../src/harness/cli/codex.js';

const FIXTURE_URL = new URL('./fixtures/cli-codex-usage.jsonl', import.meta.url);

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quaere-cli-codex-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function hasCodex() {
  const result = spawnSync('codex', ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

// ---------------------------------------------------------------------------
// build() / resume()
// ---------------------------------------------------------------------------

test('codex.build: matches the Addendum F invocation exactly', () => {
  const { cmd, args, env, cwd } = build({
    sandbox: '/sandbox/dir',
    prompt: 'do the thing',
    model: 'gpt-6-astra',
    home: '/fresh/codex-home',
  });
  assert.equal(cmd, 'codex');
  assert.deepEqual(args, [
    'exec',
    '--json',
    '-m',
    'gpt-6-astra',
    '-C',
    '/sandbox/dir',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    'do the thing',
  ]);
  assert.equal(env.CODEX_HOME, path.resolve('/fresh/codex-home'));
  assert.equal(cwd, '/sandbox/dir');
  assert.equal(adapterName, 'codex');
});

test('codex.build: throws a clear error for every missing required option', () => {
  const full = { sandbox: 's', prompt: 'p', model: 'm', home: 'h' };
  for (const key of Object.keys(full)) {
    const partial = { ...full, [key]: undefined };
    assert.throws(() => build(partial), new RegExp(key === 'home' ? 'home' : key));
  }
});

test('codex.resume: "codex exec resume <thread_id> <prompt>", no -C (resume has none)', () => {
  const { cmd, args, env, cwd } = resume('thread-abc', {
    sandbox: '/sandbox/dir',
    prompt: 'continue; the current rung is 12',
    home: '/fresh/codex-home',
  });
  assert.equal(cmd, 'codex');
  assert.deepEqual(args, [
    'exec',
    'resume',
    'thread-abc',
    'continue; the current rung is 12',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
  ]);
  assert.equal(env.CODEX_HOME, path.resolve('/fresh/codex-home'));
  assert.equal(cwd, '/sandbox/dir');
});

test('codex.resume: an explicit model is appended as -m', () => {
  const { args } = resume('thread-abc', {
    sandbox: '/s',
    prompt: 'p',
    home: '/h',
    model: 'gpt-6-astra',
  });
  assert.deepEqual(args.slice(-2), ['-m', 'gpt-6-astra']);
});

test('codex.resume: refuses to resume without a thread id', () => {
  assert.throws(() => resume(undefined, { sandbox: 's', prompt: 'p', home: 'h' }), /thread id/);
});

// ---------------------------------------------------------------------------
// copyAuth()
// ---------------------------------------------------------------------------

test('copyAuth: copies auth.json into a fresh CODEX_HOME without touching the source', async () => {
  await withTempDir(async (dir) => {
    const sourceDir = path.join(dir, 'source-home');
    const home = path.join(dir, 'fresh-home');
    await (await import('node:fs/promises')).mkdir(sourceDir, { recursive: true });
    const fakeAuth = path.join(sourceDir, 'auth.json');
    await writeFile(fakeAuth, JSON.stringify({ tokens: { access_token: 'not-a-real-token' } }));

    const dest = copyAuth(home, { from: fakeAuth });
    assert.equal(dest, path.join(home, 'auth.json'));
    const copied = await fsReadFile(dest, 'utf8');
    const original = await fsReadFile(fakeAuth, 'utf8');
    assert.equal(copied, original);
  });
});

test('copyAuth: requires a home directory', () => {
  assert.throws(() => copyAuth(undefined, { from: '/x' }), /home/);
});

// ---------------------------------------------------------------------------
// parseUsage() against the live fixture
// ---------------------------------------------------------------------------

test('codex.parseUsage: sums turn.completed usage and reads the thread id off a live fixture', async () => {
  const stdout = await readFile(FIXTURE_URL, 'utf8');
  const usage = parseUsage(stdout);
  assert.equal(usage.tokensIn, 22127);
  assert.equal(usage.tokensCached, 12160);
  assert.equal(usage.tokensOut, 5);
  assert.equal(usage.usageEstimated, false);
  assert.equal(usage.threadId, '01a09583-c9c2-7372-9a92-bc908fc9a110');
});

test('codex.parseUsage: sums MULTIPLE turn.completed events (a resumed thread runs a new turn)', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 5 } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 40, cached_input_tokens: 30, output_tokens: 2 } }),
  ].join('\n');
  const usage = parseUsage(stdout);
  assert.equal(usage.tokensIn, 140);
  assert.equal(usage.tokensCached, 40);
  assert.equal(usage.tokensOut, 7);
  assert.equal(usage.threadId, 't1');
});

test('codex.parseUsage: tolerates interleaved non-JSON noise on stdout', () => {
  const stdout = [
    'Reading additional input from stdin...',
    JSON.stringify({ type: 'thread.started', thread_id: 't2' }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }),
  ].join('\n');
  const usage = parseUsage(stdout);
  assert.equal(usage.tokensIn, 1);
  assert.equal(usage.threadId, 't2');
});

test('codex.parseUsage: throws a clear error when no turn.completed usage event is present', () => {
  assert.throws(() => parseUsage(JSON.stringify({ type: 'thread.started', thread_id: 't3' })), /no turn\.completed usage/);
});

// ---------------------------------------------------------------------------
// Optional live smoke test: rung-0-equivalent trivial prompt, skipped when codex isn't installed.
// ---------------------------------------------------------------------------

test('codex CLI live smoke: a trivial prompt produces parseable --json usage', async (t) => {
  if (!hasCodex()) {
    t.skip('codex is not on PATH');
    return;
  }
  await withTempDir(async (dir) => {
    const home = path.join(dir, 'codex-home');
    const sandbox = path.join(dir, 'sandbox');
    await (await import('node:fs/promises')).mkdir(sandbox, { recursive: true });
    let authSource;
    try {
      authSource = path.join(os.homedir(), '.codex', 'auth.json');
      await fsReadFile(authSource);
    } catch {
      t.skip('no ~/.codex/auth.json to copy for a live smoke test');
      return;
    }
    copyAuth(home, { from: authSource });
    const { cmd, args, env, cwd } = build({
      sandbox,
      prompt: 'Reply with exactly the word OK and nothing else.',
      model: 'gpt-6-astra',
      home,
    });
    const result = spawnSync(cmd, args, { env: { ...process.env, ...env }, cwd, encoding: 'utf8', timeout: 90_000 });
    assert.equal(result.status, 0, result.stderr);
    const usage = parseUsage(result.stdout);
    assert.ok(usage.tokensIn > 0);
  });
});
