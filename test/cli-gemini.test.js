// harness/cli/gemini.js (Addendum F): build() invocation shape, aigate key-fetch isolation,
// resume(), and parseUsage() against live-captured fixtures (test/fixtures/cli-gemini-usage-*.json,
// captured 2026-09-12 by running `gemini -y -o json -m <model> -p "Reply with exactly: OK"` once
// in a fresh HOME with GEMINI_API_KEY fetched from aigate provider "google").
//
// Also documents the investigated gemini-3.8-flash -> gemini-3.5-flash model-alias mismatch (see
// the long comment at the top of src/harness/cli/gemini.js) with a fixture of each outcome.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { build, resume, parseUsage, fetchGeminiApiKey, readUsageFromGeminiSessions, name as adapterName } from '../src/harness/cli/gemini.js';
import { loadAdapter } from '../src/harness/cli/index.js';

const MISMATCH_FIXTURE_URL = new URL('./fixtures/cli-gemini-usage-mismatch.json', import.meta.url);
const MATCH_FIXTURE_URL = new URL('./fixtures/cli-gemini-usage-match.json', import.meta.url);

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quaere-cli-gemini-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function hasGemini() {
  const result = spawnSync('gemini', ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function fakeAigateEnv(dir, token = 'fake-test-token') {
  const envPath = path.join(dir, 'aigate.env');
  return writeFile(envPath, `AIGATE_URL=https://aigate.example.invalid\nAIGATE_TOKEN=${token}\n`).then(() => envPath);
}

function fakeFetch(expectedKey) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      json: async () => ({ provider: 'google', label: 'test', key: expectedKey }),
    };
  };
  impl.calls = calls;
  return impl;
}

// ---------------------------------------------------------------------------
// fetchGeminiApiKey() -- the add-key skill's curl recipe, in fetch()
// ---------------------------------------------------------------------------

test('fetchGeminiApiKey: sources the env file, GETs /api/keys/google with a bearer, returns the key', async () => {
  await withTempDir(async (dir) => {
    const envPath = await fakeAigateEnv(dir, 'fake-bearer-abc');
    const fetchImpl = fakeFetch('fake-google-key-xyz');
    const key = await fetchGeminiApiKey({ envPath, fetchImpl });
    assert.equal(key, 'fake-google-key-xyz');
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, 'https://aigate.example.invalid/api/keys/google');
    assert.equal(fetchImpl.calls[0].opts.headers.authorization, 'Bearer fake-bearer-abc');
  });
});

test('fetchGeminiApiKey: throws (never the token) when the env file has no AIGATE_TOKEN', async () => {
  await withTempDir(async (dir) => {
    const envPath = path.join(dir, 'aigate.env');
    await writeFile(envPath, 'AIGATE_URL=https://aigate.example.invalid\n');
    await assert.rejects(fetchGeminiApiKey({ envPath, fetchImpl: fakeFetch('x') }), /AIGATE_TOKEN/);
  });
});

test('fetchGeminiApiKey: throws a clear error on a non-ok aigate response', async () => {
  await withTempDir(async (dir) => {
    const envPath = await fakeAigateEnv(dir);
    const fetchImpl = async () => ({ ok: false, status: 404, statusText: 'Not Found' });
    await assert.rejects(fetchGeminiApiKey({ envPath, fetchImpl }), /404/);
  });
});

// ---------------------------------------------------------------------------
// build() / resume()
// ---------------------------------------------------------------------------

test('gemini.build: matches the Addendum F invocation exactly', async () => {
  await withTempDir(async (dir) => {
    const envPath = await fakeAigateEnv(dir);
    const { cmd, args, env, cwd } = await build({
      sandbox: '/sandbox/dir',
      prompt: 'do the thing',
      model: 'gemini-3.8-flash',
      home: '/fresh/home',
      aigateEnvPath: envPath,
      aigateFetch: fakeFetch('fake-google-key'),
    });
    assert.equal(cmd, 'gemini');
    assert.deepEqual(args, ['-y', '-o', 'json', '-m', 'gemini-3.8-flash', '-p', 'do the thing']);
    assert.equal(env.HOME, path.resolve('/fresh/home'));
    assert.equal(env.GEMINI_API_KEY, 'fake-google-key');
    assert.equal(env.GEMINI_CLI_TRUST_WORKSPACE, 'true');
    assert.equal(cwd, '/sandbox/dir');
    assert.equal(adapterName, 'gemini');
  });
});

test('gemini.build: throws a clear error for every missing required option', async () => {
  const full = { sandbox: 's', prompt: 'p', model: 'm', home: 'h' };
  for (const key of Object.keys(full)) {
    const partial = { ...full, [key]: undefined };
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(build(partial), new RegExp(key === 'home' ? 'home' : key));
  }
});

test('gemini.resume: splices --resume <sessionId> in before -m/-p, keeps everything else', async () => {
  await withTempDir(async (dir) => {
    const envPath = await fakeAigateEnv(dir);
    const { cmd, args, env } = await resume('sess-123', {
      sandbox: '/sandbox/dir',
      prompt: 'continue; the current rung is 12',
      model: 'gemini-3.8-flash',
      home: '/fresh/home',
      aigateEnvPath: envPath,
      aigateFetch: fakeFetch('fake-google-key'),
    });
    assert.equal(cmd, 'gemini');
    assert.deepEqual(args, [
      '-y',
      '-o',
      'json',
      '--resume',
      'sess-123',
      '-m',
      'gemini-3.8-flash',
      '-p',
      'continue; the current rung is 12',
    ]);
    assert.equal(env.GEMINI_API_KEY, 'fake-google-key');
  });
});

test('gemini.resume: refuses to resume without a session id', async () => {
  await assert.rejects(resume(undefined, { sandbox: 's', prompt: 'p', model: 'm', home: 'h' }), /session id/);
});

// ---------------------------------------------------------------------------
// parseUsage() against live fixtures
// ---------------------------------------------------------------------------

test('gemini.parseUsage: reads tokens off the live MISMATCH fixture (requested 3.8, reported 3.5)', async () => {
  const stdout = await readFile(MISMATCH_FIXTURE_URL, 'utf8');
  const usage = parseUsage(stdout);
  assert.equal(usage.modelVersion, 'gemini-3.5-flash');
  assert.equal(usage.usageEstimated, false);
  assert.ok(usage.tokensIn > 0);
  assert.ok(usage.tokensOut > 0);
  assert.equal(typeof usage.sessionId, 'string');
  // The caller (which already knows it asked for gemini-3.8-flash, since that's what it passed to
  // build()) is the one that turns this into RunResult.modelMismatch -- see the long comment at
  // the top of gemini.js for why this adapter itself cannot fix or hide the substitution.
  assert.notEqual(usage.modelVersion, 'gemini-3.8-flash');
});

test('gemini.parseUsage: reads tokens off the live MATCH fixture (requested and reported both 3.5)', async () => {
  const stdout = await readFile(MATCH_FIXTURE_URL, 'utf8');
  const usage = parseUsage(stdout);
  assert.equal(usage.modelVersion, 'gemini-3.5-flash');
  assert.equal(usage.usageEstimated, false);
  assert.ok(usage.tokensIn > 0);
});

test('gemini.parseUsage: tokensIn is stats.models[*].tokens.prompt (already includes cached)', async () => {
  const stdout = await readFile(MATCH_FIXTURE_URL, 'utf8');
  const data = JSON.parse(stdout);
  const t = data.stats.models['gemini-3.5-flash'].tokens;
  const usage = parseUsage(stdout);
  assert.equal(usage.tokensIn, t.prompt);
  assert.equal(usage.tokensCached, t.cached);
  assert.equal(usage.tokensOut, t.candidates + t.thoughts);
});

test('gemini.parseUsage: throws a clear error on unparsable stdout', () => {
  assert.throws(() => parseUsage('not json'), /not valid JSON/);
});

test('gemini.parseUsage: sums multiple stats.models keys, first key wins modelVersion', () => {
  const usage = parseUsage(
    JSON.stringify({
      session_id: 'abc',
      stats: {
        models: {
          'gemini-3.5-flash': { tokens: { prompt: 100, candidates: 5, thoughts: 10, cached: 20 } },
          'classifier-helper': { tokens: { prompt: 10, candidates: 1, thoughts: 0, cached: 0 } },
        },
      },
    }),
  );
  assert.equal(usage.modelVersion, 'gemini-3.5-flash');
  assert.equal(usage.tokensIn, 110);
  assert.equal(usage.tokensOut, 16);
  assert.equal(usage.tokensCached, 20);
});

// ---------------------------------------------------------------------------
// index.js dispatch
// ---------------------------------------------------------------------------

test('loadAdapter: "gemini" resolves to this module', async () => {
  const adapter = await loadAdapter('gemini');
  assert.equal(adapter.name, 'gemini');
  assert.equal(typeof adapter.build, 'function');
  assert.equal(typeof adapter.parseUsage, 'function');
  assert.equal(typeof adapter.resume, 'function');
});

// ---------------------------------------------------------------------------
// Optional live smoke test: rung-0-equivalent trivial prompt, skipped when gemini isn't installed
// or aigate has no working "google" key.
// ---------------------------------------------------------------------------

test('gemini CLI live smoke: a trivial prompt produces parseable -o json usage', async (t) => {
  if (!hasGemini()) {
    t.skip('gemini is not on PATH');
    return;
  }
  let apiKey;
  try {
    apiKey = await fetchGeminiApiKey();
  } catch {
    t.skip('no working aigate "google" key for a live smoke test');
    return;
  }
  await withTempDir(async (dir) => {
    const home = path.join(dir, 'home');
    const sandbox = path.join(dir, 'sandbox');
    await mkdir(sandbox, { recursive: true });
    await mkdir(home, { recursive: true });
    // Request the exact literal this installed CLI is verified (above) to round-trip clean, so
    // this smoke test doesn't spuriously "fail" on the very alias behavior it documents.
    const { cmd, args, env, cwd } = await build({
      sandbox,
      prompt: 'Reply with exactly the word OK and nothing else.',
      model: 'gemini-3.5-flash',
      home,
      aigateFetch: async () => ({ ok: true, json: async () => ({ key: apiKey }) }),
    });
    const result = spawnSync(cmd, args, { env: { ...process.env, ...env }, cwd, encoding: 'utf8', timeout: 90_000 });
    assert.equal(result.status, 0, result.stderr);
    const usage = parseUsage(result.stdout);
    assert.ok(usage.tokensIn > 0);
    assert.equal(usage.modelVersion, 'gemini-3.5-flash');
  });
});


// --- Addendum G: "Gemini's reported model must be captured from the drained result, not left
// null." Verified live: on SIGTERM gemini exits 0 having printed NO `-o json` result at all, so
// the drain window alone cannot rescue it. cli-gemini-chat.jsonl is a trimmed capture of the chat
// transcript that same run left under $HOME/.gemini/tmp/<project>/chats/, including the
// same-id-written-twice streaming duplicate that the reader has to dedupe.

const CHAT_FIXTURE_URL = new URL('./fixtures/cli-gemini-chat.jsonl', import.meta.url);

async function withGeminiChatHome(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quaere-cli-gemini-chat-'));
  try {
    const chatsDir = path.join(dir, '.gemini', 'tmp', 'sandbox', 'chats');
    await mkdir(chatsDir, { recursive: true });
    const body = await readFile(CHAT_FIXTURE_URL, 'utf8');
    await writeFile(path.join(chatsDir, 'session-2026-09-12T18-11-46e54e9c.jsonl'), body);
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('readUsageFromGeminiSessions recovers the served model and tokens from the chat transcript', async () => {
  await withGeminiChatHome(async (home) => {
    const usage = readUsageFromGeminiSessions(home);
    assert.ok(usage, 'the chat transcript under the isolated home must be found');
    // The served model, not the requested one -- gemini silently resolves 3.8-flash to a 3.5
    // flash build, and reporting what it actually used is what lets run-cli.js flag modelMismatch.
    assert.equal(usage.modelVersion, 'gemini-3.5-flash');
    // input/cached are running context totals, so the last message wins...
    assert.equal(usage.tokensIn, 11564);
    assert.equal(usage.tokensCached, 8112);
    // ...while output/thoughts are per-message spend and are summed over DEDUPED ids
    // (102+138) + (22+234). Counting the streaming duplicates would double this.
    assert.equal(usage.tokensOut, 496);
    assert.equal(usage.usageEstimated, false);
    assert.equal(usage.sessionId, '46e54e9c-5c6c-4380-bbc7-fcccc3b4ab4c');
  });
});

test('parseUsage falls back to the chat transcript when a killed gemini printed nothing', async () => {
  await withGeminiChatHome(async (home) => {
    const usage = parseUsage('', home);
    assert.equal(usage.modelVersion, 'gemini-3.5-flash');
    assert.equal(usage.tokensOut, 496);
  });
});

test('parseUsage with unparsable stdout and no session file still throws, as before', () => {
  assert.equal(readUsageFromGeminiSessions(undefined), null);
  assert.throws(() => parseUsage('not json'), /was not valid JSON/);
});
