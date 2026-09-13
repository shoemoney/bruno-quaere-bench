// harness/cli/grok.js: build()/resume() invocation shape, seedGrokHome() isolation, and
// parseUsage() against a fixture matching grok-cli's real headless output shape (verified by
// reading the installed @vibe-kit/grok-cli source directly -- see the adapter's own header
// comment: `-p` prints one {role, content[, tool_calls]} JSON object per line, with no usage or
// model field anywhere in the stream).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { build, resume, parseUsage, seedGrokHome, name as adapterName } from '../src/harness/cli/grok.js';
import { loadAdapter } from '../src/harness/cli/index.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quaere-cli-grok-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function fakeRealGrokSettings(dir) {
  const realDir = path.join(dir, 'fake-real-grok');
  await mkdir(realDir, { recursive: true });
  const file = path.join(realDir, 'user-settings.json');
  await writeFile(file, JSON.stringify({ apiKey: 'fake-not-a-real-key', baseURL: 'https://api.x.ai/v1', defaultModel: 'grok-code-fast-1' }));
  return file;
}

test('adapter name', () => {
  assert.equal(adapterName, 'grok');
});

test('loadAdapter("grok") resolves through the shared registry with the full interface', async () => {
  const adapter = await loadAdapter('grok');
  assert.equal(adapter.name, 'grok');
  assert.equal(typeof adapter.build, 'function');
  assert.equal(typeof adapter.parseUsage, 'function');
  assert.equal(typeof adapter.resume, 'function');
});

test('seedGrokHome copies user-settings.json into a fresh HOME without altering it', () =>
  withTempDir(async (dir) => {
    const realSettingsFile = await fakeRealGrokSettings(dir);
    const home = path.join(dir, 'home');
    const dest = seedGrokHome(home, { realSettingsFile });
    assert.equal(dest, path.join(home, '.grok', 'user-settings.json'));
    const written = JSON.parse(await readFile(dest, 'utf8'));
    assert.equal(written.apiKey, 'fake-not-a-real-key');
    const original = JSON.parse(await readFile(realSettingsFile, 'utf8'));
    assert.equal(original.apiKey, 'fake-not-a-real-key');
  }));

test('build() sets GROK_YOLO/GROK_MODEL, runs -p headlessly, and seeds the fresh HOME', () =>
  withTempDir(async (dir) => {
    const realSettingsFile = await fakeRealGrokSettings(dir);
    const sandbox = path.join(dir, 'sandbox');
    const home = path.join(dir, 'home');
    await mkdir(sandbox, { recursive: true });
    const spec = build({ sandbox, prompt: 'hello', model: 'grok-code-fast-1', home, realSettingsFile });
    assert.equal(spec.cmd, 'grok');
    assert.deepEqual(spec.args, ['-p', 'hello']);
    assert.equal(spec.env.GROK_YOLO, '1');
    assert.equal(spec.env.GROK_MODEL, 'grok-code-fast-1');
    assert.equal(spec.env.HOME, path.resolve(home));
    assert.equal(spec.cwd, sandbox);
    // build() seeds the isolated home as a side effect, same as kimi.js's seedKimiHome().
    const seeded = JSON.parse(await readFile(path.join(home, '.grok', 'user-settings.json'), 'utf8'));
    assert.equal(seeded.apiKey, 'fake-not-a-real-key');
  }));

test('build() throws a clear error when a required option is missing', () => {
  assert.throws(() => build({ prompt: 'hi', model: 'm', home: '/tmp/x' }), /sandbox is required/);
  assert.throws(() => build({ sandbox: '/tmp/s', model: 'm', home: '/tmp/x' }), /prompt is required/);
  assert.throws(() => build({ sandbox: '/tmp/s', prompt: 'hi', home: '/tmp/x' }), /model is required/);
});

test('resume() has no session flag to carry (grok-cli headless is single-shot); it re-runs build()', () =>
  withTempDir(async (dir) => {
    const realSettingsFile = await fakeRealGrokSettings(dir);
    const sandbox = path.join(dir, 'sandbox');
    const home = path.join(dir, 'home');
    await mkdir(sandbox, { recursive: true });
    const spec = resume('some-session-id', { sandbox, prompt: 'continue', model: 'grok-code-fast-1', home, realSettingsFile });
    assert.equal(spec.cmd, 'grok');
    assert.deepEqual(spec.args, ['-p', 'continue']);
  }));

// Fixture shape matches processPromptHeadless() read straight off the installed CLI's own dist
// (see grok.js's header comment): one JSON object per line, no usage/model field anywhere.
const FIXTURE_STDOUT = [
  JSON.stringify({ role: 'user', content: 'Reply with exactly the single word: PONG' }),
  JSON.stringify({ role: 'assistant', content: 'PONG' }),
  '',
].join('\n');

test('parseUsage() estimates tokens from characters and never claims a served model', () => {
  const usage = parseUsage(FIXTURE_STDOUT);
  assert.equal(usage.modelVersion, null);
  assert.equal(usage.usageEstimated, true);
  assert.ok(usage.tokensOut > 0, 'assistant content should count as output chars/4');
  assert.ok(usage.tokensIn >= 0);
});

test('parseUsage() skips stray non-JSON lines instead of throwing', () => {
  const stdout = `not json\n${FIXTURE_STDOUT}`;
  const usage = parseUsage(stdout);
  assert.equal(usage.usageEstimated, true);
});
