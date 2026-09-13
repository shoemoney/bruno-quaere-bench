// harness/cli/muse.js (Jeremy's 2026-09-13 lineup addition): build()/resume() invocation shape,
// the fresh-home session marker, copyAuth() isolation, and parseUsage() against live-captured
// fixtures -- test/fixtures/cli-muse-stdout.jsonl (the --json stdout stream, which never carries
// usage) plus test/fixtures/cli-muse-session.jsonl and cli-muse-subagent-{1,2}.jsonl (the on-disk
// session logs muse itself wrote, which do), all captured 2026-09-13 by running `muse exec --json
// --yolo --no-foreign-personal-context --model muse-spark-1.3-contributor "Reply with exactly the
// single word: PONG"` once with a fresh XDG_CONFIG_HOME/XDG_DATA_HOME containing a copy of
// ~/.config/muse/{auth.json,trust.json}, then trimmed to the handful of event kinds this adapter
// actually reads (the full capture also carries ~40KB of embedded system-prompt text per line
// that parseUsage() never looks at).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import {
  build,
  resume,
  parseUsage,
  copyAuth,
  readSessionMarker,
  sumUsageFromSessionLogs,
  name as adapterName,
} from '../src/harness/cli/muse.js';
import { loadAdapter } from '../src/harness/cli/index.js';

const STDOUT_FIXTURE_URL = new URL('./fixtures/cli-muse-stdout.jsonl', import.meta.url);
const SESSION_FIXTURE_URL = new URL('./fixtures/cli-muse-session.jsonl', import.meta.url);
const SUBAGENT1_FIXTURE_URL = new URL('./fixtures/cli-muse-subagent-1.jsonl', import.meta.url);
const SUBAGENT2_FIXTURE_URL = new URL('./fixtures/cli-muse-subagent-2.jsonl', import.meta.url);

// The session id the fixtures were captured under -- the directory name the main/subagent files
// below get placed at in a fake home, matching how build()'s marker file points parseUsage() at
// exactly this session.
const FIXTURE_SESSION_ID = '01a09c99-1547-7482-b6e4-425c372de5e1';
const FIXTURE_SUBAGENT_1_ID = '6efdd747-2fc5-41e5-b354-c54d6d6b0472';
const FIXTURE_SUBAGENT_2_ID = 'c4f50751-3056-480a-962c-bd7fabe97103';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quaere-cli-muse-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// seedFixtureHome(home) -> writes the marker file plus the main + two subagent session logs at
// exactly the paths sumUsageFromSessionLogs() walks: <home>/muse/sessions/<y>/<m>/<d>/<id>/
// session.jsonl, with subagents nested at .../<id>/subagent/<subagent-id>/session.jsonl.
async function seedFixtureHome(home) {
  const dayDir = path.join(home, 'muse', 'sessions', '2026', '09', '13', FIXTURE_SESSION_ID);
  const subagent1Dir = path.join(dayDir, 'subagent', FIXTURE_SUBAGENT_1_ID);
  const subagent2Dir = path.join(dayDir, 'subagent', FIXTURE_SUBAGENT_2_ID);
  await mkdir(dayDir, { recursive: true });
  await mkdir(subagent1Dir, { recursive: true });
  await mkdir(subagent2Dir, { recursive: true });
  await writeFile(path.join(home, 'muse', '.quaere-session-id'), FIXTURE_SESSION_ID, 'utf8');
  await writeFile(path.join(dayDir, 'session.jsonl'), await readFile(SESSION_FIXTURE_URL, 'utf8'));
  await writeFile(path.join(subagent1Dir, 'session.jsonl'), await readFile(SUBAGENT1_FIXTURE_URL, 'utf8'));
  await writeFile(path.join(subagent2Dir, 'session.jsonl'), await readFile(SUBAGENT2_FIXTURE_URL, 'utf8'));
}

function hasMuse() {
  const result = spawnSync('muse', ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

// ---------------------------------------------------------------------------
// build() / resume()
// ---------------------------------------------------------------------------

test('muse.build: matches the documented invocation, generates and records a session id', () =>
  withTempDir(async (dir) => {
    const home = path.join(dir, 'fresh-home');
    const { cmd, args, env, cwd } = build({
      sandbox: '/sandbox/dir',
      prompt: 'do the thing',
      model: 'muse-spark-1.3-contributor',
      home,
    });
    assert.equal(cmd, 'muse');
    assert.equal(args[0], 'exec');
    assert.deepEqual(args.slice(1, 4), ['--json', '--yolo', '--no-foreign-personal-context']);
    const sessionIdIndex = args.indexOf('--session-id');
    assert.ok(sessionIdIndex > 0);
    const sessionId = args[sessionIdIndex + 1];
    assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.deepEqual(args.slice(sessionIdIndex + 2), ['--model', 'muse-spark-1.3-contributor', 'do the thing']);
    assert.equal(env.XDG_CONFIG_HOME, path.resolve(home));
    assert.equal(env.XDG_DATA_HOME, path.resolve(home));
    assert.equal(env.MUSE_NO_AUTO_UPDATE, '1');
    assert.equal(cwd, '/sandbox/dir');
    assert.equal(adapterName, 'muse');

    // the marker file build() writes is exactly what readSessionMarker()/parseUsage() read back
    assert.equal(readSessionMarker(home), sessionId);
  }));

test('muse.build: throws a clear error for every missing required option', () => {
  const full = { sandbox: 's', prompt: 'p', model: 'm', home: 'h' };
  for (const key of Object.keys(full)) {
    const partial = { ...full, [key]: undefined };
    assert.throws(() => build(partial), new RegExp(key === 'home' ? 'home' : key));
  }
});

test('muse.resume: reuses the given session id via --session-id (no `muse resume` -- interactive-only)', () =>
  withTempDir(async (dir) => {
    const home = path.join(dir, 'fresh-home');
    const { cmd, args, env, cwd } = resume('existing-session-id', {
      sandbox: '/sandbox/dir',
      prompt: 'continue; the current rung is 12',
      model: 'muse-spark-1.3-contributor',
      home,
    });
    assert.equal(cmd, 'muse');
    assert.deepEqual(args, [
      'exec',
      '--json',
      '--yolo',
      '--no-foreign-personal-context',
      '--session-id',
      'existing-session-id',
      '--model',
      'muse-spark-1.3-contributor',
      'continue; the current rung is 12',
    ]);
    assert.equal(env.XDG_CONFIG_HOME, path.resolve(home));
    assert.equal(env.XDG_DATA_HOME, path.resolve(home));
    assert.equal(cwd, '/sandbox/dir');
    assert.equal(readSessionMarker(home), 'existing-session-id');
  }));

test('muse.resume: omits --model when none is given', () =>
  withTempDir(async (dir) => {
    const { args } = resume('sid', { sandbox: '/s', prompt: 'p', home: path.join(dir, 'h') });
    assert.deepEqual(args, ['exec', '--json', '--yolo', '--no-foreign-personal-context', '--session-id', 'sid', 'p']);
  }));

test('muse.resume: refuses to resume without a session id', () => {
  assert.throws(() => resume(undefined, { sandbox: 's', prompt: 'p', home: 'h' }), /session id/);
});

// ---------------------------------------------------------------------------
// copyAuth()
// ---------------------------------------------------------------------------

test('copyAuth: copies auth.json AND trust.json into a fresh home without touching the source', () =>
  withTempDir(async (dir) => {
    const sourceDir = path.join(dir, 'source-config');
    const home = path.join(dir, 'fresh-home');
    await mkdir(sourceDir, { recursive: true });
    const fakeAuth = path.join(sourceDir, 'auth.json');
    const fakeTrust = path.join(sourceDir, 'trust.json');
    await writeFile(fakeAuth, JSON.stringify({ providers: { meta: { mechanism: 'oauth', access_token: 'not-a-real-token' } } }));
    await writeFile(fakeTrust, JSON.stringify({ projects: {} }));

    const { authDest, trustDest } = copyAuth(home, { authFrom: fakeAuth, trustFrom: fakeTrust });
    assert.equal(authDest, path.join(home, 'muse', 'auth.json'));
    assert.equal(trustDest, path.join(home, 'muse', 'trust.json'));
    assert.equal(await readFile(authDest, 'utf8'), await readFile(fakeAuth, 'utf8'));
    assert.equal(await readFile(trustDest, 'utf8'), await readFile(fakeTrust, 'utf8'));
  }));

test('copyAuth: a missing trust.json is fine -- trustDest comes back null, auth still copies', () =>
  withTempDir(async (dir) => {
    const sourceDir = path.join(dir, 'source-config');
    const home = path.join(dir, 'fresh-home');
    await mkdir(sourceDir, { recursive: true });
    const fakeAuth = path.join(sourceDir, 'auth.json');
    await writeFile(fakeAuth, JSON.stringify({ providers: {} }));

    const { authDest, trustDest } = copyAuth(home, { authFrom: fakeAuth, trustFrom: path.join(sourceDir, 'does-not-exist.json') });
    assert.equal(trustDest, null);
    assert.equal(await readFile(authDest, 'utf8'), await readFile(fakeAuth, 'utf8'));
  }));

test('copyAuth: requires a home directory', () => {
  assert.throws(() => copyAuth(undefined, { authFrom: '/x' }), /home/);
});

// ---------------------------------------------------------------------------
// parseUsage() / sumUsageFromSessionLogs() against the live fixtures
// ---------------------------------------------------------------------------

test('muse.parseUsage: stdout alone has no usage -- home is required', async () => {
  const stdout = await readFile(STDOUT_FIXTURE_URL, 'utf8');
  assert.throws(() => parseUsage(stdout, undefined), /needs `home`/);
});

test('muse.parseUsage: sums model_completed usage across the main session AND both subagent sessions', () =>
  withTempDir(async (dir) => {
    const home = path.join(dir, 'fresh-home');
    await seedFixtureHome(home);
    const stdout = await readFile(STDOUT_FIXTURE_URL, 'utf8');

    const usage = parseUsage(stdout, home);
    // main: 28758 in / 42 out+30 reasoning; subagent1: 3166 in / 1511 out+1373 reasoning;
    // subagent2: 3330 in / 127 out+30 reasoning -- verified against the raw live capture.
    assert.equal(usage.tokensIn, 28758 + 3166 + 3330);
    assert.equal(usage.tokensCached, 0);
    assert.equal(usage.tokensOut, (42 + 30) + (1511 + 1373) + (127 + 30));
    assert.equal(usage.modelVersion, 'muse-spark-1.3-contributor');
    assert.equal(usage.usageEstimated, false);
    assert.equal(usage.sessionId, FIXTURE_SESSION_ID);
  }));

test('muse.parseUsage: modelVersion prefers stdout\'s run.model.configured over the disk usage event', () =>
  withTempDir(async (dir) => {
    const home = path.join(dir, 'fresh-home');
    await seedFixtureHome(home);
    // stdout with no run.model.configured event at all -- falls back to the model field the disk
    // usage events themselves carry, so modelVersion is never left null when either source has it.
    const usage = parseUsage('not json\n', home);
    assert.equal(usage.modelVersion, 'muse-spark-1.3-contributor');
  }));

test('muse.parseUsage: throws a clear error when no model_completed usage event is found anywhere', () =>
  withTempDir(async (dir) => {
    const home = path.join(dir, 'fresh-home');
    await mkdir(path.join(home, 'muse'), { recursive: true });
    await writeFile(path.join(home, 'muse', '.quaere-session-id'), 'ghost-session', 'utf8');
    assert.throws(() => parseUsage('{}', home), /no model_completed usage event/);
  }));

test('sumUsageFromSessionLogs: returns null (not throw) when the sessions tree does not exist yet', () =>
  withTempDir(async (dir) => {
    const home = path.join(dir, 'never-ran');
    assert.equal(sumUsageFromSessionLogs(home), null);
  }));

test('readSessionMarker: returns null when build()/resume() never wrote one', () =>
  withTempDir(async (dir) => {
    assert.equal(readSessionMarker(path.join(dir, 'untouched')), null);
  }));

// ---------------------------------------------------------------------------
// index.js registry
// ---------------------------------------------------------------------------

test('loadAdapter("muse") resolves to this module\'s exports', async () => {
  const adapter = await loadAdapter('muse');
  assert.equal(adapter.name, 'muse');
  assert.equal(typeof adapter.build, 'function');
  assert.equal(typeof adapter.parseUsage, 'function');
  assert.equal(typeof adapter.resume, 'function');
  assert.equal(typeof adapter.copyAuth, 'function');
});

// ---------------------------------------------------------------------------
// Optional live smoke test: rung-0-equivalent trivial prompt, skipped when muse isn't installed.
// ---------------------------------------------------------------------------

test('muse CLI live smoke: a trivial prompt produces a usable session log with real usage', async (t) => {
  if (!hasMuse()) {
    t.skip('muse is not on PATH');
    return;
  }
  await withTempDir(async (dir) => {
    const home = path.join(dir, 'muse-home');
    const sandbox = path.join(dir, 'sandbox');
    await mkdir(sandbox, { recursive: true });
    let authSource;
    try {
      authSource = path.join(os.homedir(), '.config', 'muse', 'auth.json');
      await readFile(authSource);
    } catch {
      t.skip('no ~/.config/muse/auth.json to copy for a live smoke test');
      return;
    }
    copyAuth(home, { authFrom: authSource, trustFrom: path.join(os.homedir(), '.config', 'muse', 'trust.json') });
    const { cmd, args, env, cwd } = build({
      sandbox,
      prompt: 'Reply with exactly the single word: PONG',
      model: 'muse-spark-1.3-contributor',
      home,
    });
    const result = spawnSync(cmd, args, { env: { ...process.env, ...env }, cwd, encoding: 'utf8', timeout: 90_000 });
    assert.equal(result.status, 0, result.stderr);
    const usage = parseUsage(result.stdout, home);
    assert.ok(usage.tokensIn > 0);
    assert.equal(usage.modelVersion, 'muse-spark-1.3-contributor');
  });
});
