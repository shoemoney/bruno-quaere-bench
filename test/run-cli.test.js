// src/harness/{supervise,run-cli,task-md}.js: the CLI climb from ARCHITECTURE Addendum F.
//
// The real cli/{ai,codex,qwen,gemini,kimi} adapters are a separate, parallel workstream, so these
// tests stand in a FAKE adapter matching the Addendum F contract -- {name, build, parseUsage,
// resume} -- built as a real Node subprocess that reads TASK.md and talks to the API over plain
// `fetch` (never `bru`), exactly per this module's brief. That also happens to be a clean way to
// exercise the violations column: fetch's User-Agent is never `bruno-runtime/...`, so a passing
// climb here should still report at least one violation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { makeWorld, fieldName } from '../src/world.js';
import { makeRung } from '../src/ladder/rung.js';
import { climb, bruShimSource } from '../src/harness/run-cli.js';
import { superviseProcess, killTree } from '../src/harness/supervise.js';
import { buildTaskMd } from '../src/harness/task-md.js';
import { resolveBru } from '../src/harness/sandbox.js';

const CREATE_PATH = { image: '/images', audio: '/audio', video: '/video' };

// A run whose whole climb never touches HTTP (task-md.js, killTree's null-safety) can share one
// scratch dir; anything that starts a server gets its own runDir under a fresh tmpdir so parallel
// `node --test` files never collide on ports or files.
async function tmpRunsDir() {
  return mkdtemp(path.join(os.tmpdir(), 'quaere-run-cli-'));
}

// buildFakeAdapterScript(): a standalone Node/ESM script, written to disk, that plays the part of
// a real CLI's whole session for ONE rung: read TASK.md, POST /auth/token, POST the create route
// for the plan handed to it via env (a real CLI would reason this out itself; ours can't, so the
// test bakes in the exact params for the rung it's aimed at), then POST /rungs/{n}/submit and
// print a JSON usage line the fake adapter's parseUsage() reads back.
async function buildFakeAdapterScript(dir) {
  const scriptPath = path.join(dir, 'fake-cli.mjs');
  const source = `#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const taskText = readFileSync('TASK.md', 'utf8');
const baseUrlMatch = taskText.match(/Base URL: (\\S+)/);
const apiKeyMatch = taskText.match(/API key: (\\S+) --/);
if (!baseUrlMatch || !apiKeyMatch) {
  console.error('fake-cli: could not find Base URL / API key in TASK.md');
  process.exit(1);
}
const baseUrl = baseUrlMatch[1];
const apiKey = apiKeyMatch[1];
const plan = JSON.parse(process.env.QUAERE_FAKE_PLAN);
const naming = JSON.parse(process.env.QUAERE_FAKE_NAMING);

async function main() {
  const tokenRes = await fetch(baseUrl + '/auth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [naming.apiKeyField]: apiKey }),
  });
  const tokenBody = await tokenRes.json();
  const access = tokenBody[naming.accessTokenField];

  const createRes = await fetch(baseUrl + naming.createPath, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + access, 'content-type': 'application/json' },
    body: JSON.stringify(plan.params),
  });
  const createBody = await createRes.json();

  const submitRes = await fetch(baseUrl + naming.submitPath, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + access, 'content-type': 'application/json' },
    body: JSON.stringify({ [naming.assetsField]: [createBody.id] }),
  });
  const submitBody = await submitRes.json();

  console.log(JSON.stringify({
    usage: { tokensIn: 4321, tokensOut: 987, tokensCached: 0, modelVersion: 'fake-model-1' },
    submit: submitBody,
  }));
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
`;
  await writeFile(scriptPath, source, 'utf8');
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

// makeFakeAdapter(world, n): a real, single-rung fake per the module brief ("reads TASK.md,
// creates rung n's asset via fetch, submits, exits"). `resume` returns null so a climb that keeps
// going past this rung falls back to a fresh `build()` (run-cli.js's documented fallback) rather
// than needing session-id plumbing this fake doesn't have.
async function makeFakeAdapter(world, n, scriptDir) {
  const rung = makeRung(world, n);
  const step = rung.plan[rung.plan.length - 1];
  const scriptPath = await buildFakeAdapterScript(scriptDir);
  const naming = {
    apiKeyField: fieldName(world, 'api_key'),
    accessTokenField: fieldName(world, 'access_token'),
    assetsField: fieldName(world, 'assets'),
    createPath: CREATE_PATH[step.args.kind],
    submitPath: `/rungs/${n}/submit`,
  };
  return {
    name: 'fake',
    build: () => ({
      cmd: process.execPath,
      args: [scriptPath],
      env: {
        QUAERE_FAKE_PLAN: JSON.stringify(step.args),
        QUAERE_FAKE_NAMING: JSON.stringify(naming),
      },
    }),
    parseUsage: (stdout) => {
      const lines = stdout.trim().split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (parsed && parsed.usage) return parsed.usage;
        } catch {
          // not a JSON line (e.g. a stray console.error), keep looking
        }
      }
      return { tokensIn: 0, tokensOut: 0, tokensCached: 0 };
    },
    resume: () => null,
  };
}

// A fake adapter that never talks to the API at all -- used to exercise the stalled/resume path
// without depending on rung content. Exits cleanly every time, immediately.
function makeNoOpAdapter() {
  let calls = 0;
  return {
    name: 'noop',
    build: () => {
      calls += 1;
      return { cmd: process.execPath, args: ['-e', 'process.exit(0)'], env: {} };
    },
    parseUsage: () => ({ tokensIn: 10, tokensOut: 10, tokensCached: 0 }),
    resume: () => null,
    get calls() {
      return calls;
    },
  };
}

// A fake adapter whose script deliberately submits the WRONG asset id for rung 0, so the server's
// pickiness about the artifact (never about JSON transport, per Addendum E) fails the rung.
async function makeFailingAdapter(world, scriptDir) {
  const naming = {
    apiKeyField: fieldName(world, 'api_key'),
    accessTokenField: fieldName(world, 'access_token'),
    assetsField: fieldName(world, 'assets'),
    submitPath: '/rungs/0/submit',
  };
  const scriptPath = path.join(scriptDir, 'fail-cli.mjs');
  const source = `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const taskText = readFileSync('TASK.md', 'utf8');
const baseUrl = taskText.match(/Base URL: (\\S+)/)[1];
const apiKey = taskText.match(/API key: (\\S+) --/)[1];
const naming = JSON.parse(process.env.QUAERE_FAKE_NAMING);

async function main() {
  const tokenRes = await fetch(baseUrl + '/auth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [naming.apiKeyField]: apiKey }),
  });
  const tokenBody = await tokenRes.json();
  const access = tokenBody[naming.accessTokenField];
  // Create SOMETHING valid (an image) so the id resolves, but it is never the rung's own
  // expected artifact -- this is a wrong-answer fail, not a malformed-submission 422.
  const createRes = await fetch(baseUrl + '/images', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + access, 'content-type': 'application/json' },
    body: JSON.stringify({ width: 8, height: 8, background: { color: '#000000' }, shapes: [] }),
  });
  const createBody = await createRes.json();
  await fetch(baseUrl + naming.submitPath, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + access, 'content-type': 'application/json' },
    body: JSON.stringify({ [naming.assetsField]: [createBody.id] }),
  });
  console.log(JSON.stringify({ usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0 } }));
}
main();
`;
  await writeFile(scriptPath, source, 'utf8');
  await chmod(scriptPath, 0o755);
  return {
    name: 'fail',
    build: () => ({ cmd: process.execPath, args: [scriptPath], env: { QUAERE_FAKE_NAMING: JSON.stringify(naming) } }),
    parseUsage: () => ({ tokensIn: 1, tokensOut: 1, tokensCached: 0 }),
    resume: () => null,
  };
}

// ---------------------------------------------------------------------------
// task-md.js
// ---------------------------------------------------------------------------

test('buildTaskMd: states the one rule, the base URL, the api key, the ladder endpoints, and the file names', () => {
  const md = buildTaskMd({ baseUrl: 'http://127.0.0.1:9999', apiKey: 'key_abc123', budgetTokens: 42 });
  assert.match(md, /only thing that may ever open a network socket.*`bru`/s);
  assert.match(md, /Base URL: http:\/\/127\.0\.0\.1:9999/);
  assert.match(md, /API key: key_abc123/);
  assert.match(md, /GET \/rungs\/current/);
  assert.match(md, /POST \/rungs\{n\}\/submit|POST \/rungs\/\{n\}\/submit/);
  assert.match(md, /one submission per rung|exactly one submission per rung/);
  assert.match(md, /only agent|Do not delegate/);
  assert.match(md, /do not spawn\s+subagents/);
  assert.match(md, /HOUSE-RULES\.md/);
  assert.match(md, /spec\.json/);
  assert.match(md, /\b42\b/);
});

test('buildTaskMd: throws without baseUrl/apiKey', () => {
  assert.throws(() => buildTaskMd({ apiKey: 'x' }), /baseUrl/);
  assert.throws(() => buildTaskMd({ baseUrl: 'http://x' }), /apiKey/);
});

// ---------------------------------------------------------------------------
// supervise.js in isolation
// ---------------------------------------------------------------------------

test('killTree: a no-op on a process that already exited never throws', async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise((resolve) => child.on('exit', resolve));
  assert.doesNotThrow(() => killTree(child));
});

test('superviseProcess: a wall-clock deadline kills the tree and reports killedFor "wall"', async () => {
  const outcome = await superviseProcess({
    cmd: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 60000)'],
    env: process.env,
    adminBase: 'http://127.0.0.1:1', // never reached: nothing to submit in this test
    wallMsLeft: 100,
    pollMs: 5000,
  });
  assert.equal(outcome.killedFor, 'wall');
  assert.equal(outcome.timedOut, true);
});

test('superviseProcess: a process that just exits on its own resolves with killedFor null', async () => {
  const outcome = await superviseProcess({
    cmd: process.execPath,
    args: ['-e', 'console.log("hi"); process.exit(3)'],
    env: process.env,
    adminBase: 'http://127.0.0.1:1',
    wallMsLeft: 5000,
    pollMs: 5000,
  });
  assert.equal(outcome.killedFor, null);
  assert.equal(outcome.exitCode, 3);
  assert.match(outcome.stdout, /hi/);
});

// ---------------------------------------------------------------------------
// climb() end to end, fake adapter
// ---------------------------------------------------------------------------

test('climb(): a fake CLI adapter that reads TASK.md, creates rung 0 via fetch, and submits clears the (test-shortened) top', async () => {
  const seed = 1;
  const world = makeWorld(seed);
  const runsDir = await tmpRunsDir();
  const scriptDir = await mkdtemp(path.join(os.tmpdir(), 'quaere-fake-cli-'));
  try {
    const adapter = await makeFakeAdapter(world, 0, scriptDir);

    const result = await climb({
      cli: adapter,
      model: 'fake-model-1',
      seed,
      attempt: 1,
      outDir: runsDir,
      pollMs: 150,
      wallMsLimit: 30_000,
      // The fake only knows how to play rung 0 -- tell the harness that passing rung 0 IS the
      // top, so this climb ends there instead of trying (and failing) to resume into rung 1.
      topRung: 0,
    });

    assert.equal(result.stoppedBecause, 'top');
    assert.equal(result.rung, 0);
    assert.equal(result.driver, 'cli:fake');
    assert.equal(result.submissions.length, 1);
    assert.equal(result.submissions[0].pass, true);
    assert.equal(result.submissions[0].rung, 0);
    assert.ok(result.tokensNovel > 0, 'tokensNovel should reflect the fake adapter\'s reported usage');
    assert.equal(result.modelVersion, 'fake-model-1');
    assert.equal(result.modelMismatch, false);
    assert.equal(result.usageEstimated, false);
    assert.equal(result.resumes, 0);
    assert.equal(result.turns, 0, 'the fake adapter never calls bru, so shim-logged turns is 0');
    // The fake adapter talks over plain fetch, never bru -- that is exactly a violation per
    // Addendum F's detection rule, and it should show up rather than be silently absorbed.
    assert.ok(result.violations >= 1, 'fetch, not bru, should be caught as a User-Agent violation');

    const runDir = path.join(runsDir, 'fake-model-1', String(seed), '1');
    const sandboxDir = path.join(runDir, 'sandbox');

    // Files the harness must plant before the adapter's process ever starts.
    const spec = await readFile(path.join(sandboxDir, 'spec.json'), 'utf8');
    JSON.parse(spec); // valid JSON
    const houseRules = await readFile(path.join(sandboxDir, 'HOUSE-RULES.md'), 'utf8');
    assert.ok(houseRules.length > 0);
    const taskMd = await readFile(path.join(sandboxDir, 'TASK.md'), 'utf8');
    assert.match(taskMd, /Base URL: http:\/\/127\.0\.0\.1:\d+/);
    assert.match(taskMd, new RegExp(`API key: ${world.auth.apiKey}`));

    // The bru shim itself: installed, executable, and (per Addendum F) not the real bru --
    // exercised even though this particular fake adapter never invokes it.
    const shimStat = await stat(path.join(sandboxDir, 'bin', 'bru'));
    assert.ok(shimStat.mode & 0o111, 'the shim must be executable');
    const shimSource = await readFile(path.join(sandboxDir, 'bin', 'bru'), 'utf8');
    assert.equal(shimSource, bruShimSource(resolveBru()));
    assert.match(shimSource, /turns\.jsonl/);
    const shimPackageJson = await readFile(path.join(sandboxDir, 'bin', 'package.json'), 'utf8');
    assert.deepEqual(JSON.parse(shimPackageJson), { type: 'commonjs' });

    // transcript.jsonl and result.json on disk, matching what climb() returned.
    const transcriptText = await readFile(path.join(runDir, 'transcript.jsonl'), 'utf8');
    const transcriptLines = transcriptText.trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(transcriptLines.some((e) => e.type === 'stdout'));
    assert.ok(transcriptLines.some((e) => e.type === 'submission' && e.submission.pass === true));
    assert.ok(transcriptLines.some((e) => e.type === 'exit'));

    const resultOnDisk = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8'));
    assert.equal(resultOnDisk.stoppedBecause, 'top');
    assert.equal(resultOnDisk.rung, 0);

    // The sandbox collection (minus the harness's own bin/ shim dir) was copied out.
    const collectionSpec = await readFile(path.join(runDir, 'collection', 'spec.json'), 'utf8');
    assert.equal(collectionSpec, spec);
    await assert.rejects(stat(path.join(runDir, 'collection', 'bin')));
  } finally {
    await rm(runsDir, { recursive: true, force: true });
    await rm(scriptDir, { recursive: true, force: true });
  }
});

test('climb(): a wrong-answer submission fails the rung, kills the process tree, and stops the climb', async () => {
  const seed = 1;
  const world = makeWorld(seed);
  const runsDir = await tmpRunsDir();
  const scriptDir = await mkdtemp(path.join(os.tmpdir(), 'quaere-fail-cli-'));
  try {
    const adapter = await makeFailingAdapter(world, scriptDir);
    const result = await climb({
      cli: adapter,
      model: 'fake-fail',
      seed,
      outDir: runsDir,
      pollMs: 150,
      wallMsLimit: 30_000,
    });
    assert.equal(result.stoppedBecause, 'fail');
    assert.equal(result.submissions.length, 1);
    assert.equal(result.submissions[0].pass, false);
    assert.equal(result.rung, -1, 'no PASSING rung means -1, matching run.js\'s convention');
  } finally {
    await rm(runsDir, { recursive: true, force: true });
    await rm(scriptDir, { recursive: true, force: true });
  }
});

test('climb(): a process that exits without ever submitting resumes up to 3 times, then stops as "stalled"', async () => {
  const seed = 1;
  const runsDir = await tmpRunsDir();
  try {
    const adapter = makeNoOpAdapter();
    const result = await climb({
      cli: adapter,
      model: 'fake-noop',
      seed,
      outDir: runsDir,
      pollMs: 100,
      wallMsLimit: 30_000,
    });
    assert.equal(result.stoppedBecause, 'stalled');
    assert.equal(result.submissions.length, 0);
    assert.equal(result.resumes, 3);
    assert.equal(adapter.calls, 4, 'the initial build() plus exactly 3 resume-as-fresh-build() calls');
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test('climb(): the wall-clock cap stops a climb that never submits anything, as "time"', async () => {
  const seed = 1;
  const runsDir = await tmpRunsDir();
  try {
    const slowAdapter = {
      name: 'slow',
      build: () => ({ cmd: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], env: {} }),
      parseUsage: () => ({ tokensIn: 0, tokensOut: 0 }),
      resume: () => null,
    };
    const result = await climb({
      cli: slowAdapter,
      model: 'fake-slow',
      seed,
      outDir: runsDir,
      pollMs: 100,
      wallMsLimit: 300,
    });
    assert.equal(result.stoppedBecause, 'time');
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test('climb(): exceeding the token budget stops the climb as "budget" even after a pass', async () => {
  const seed = 1;
  const world = makeWorld(seed);
  const runsDir = await tmpRunsDir();
  const scriptDir = await mkdtemp(path.join(os.tmpdir(), 'quaere-budget-cli-'));
  try {
    const adapter = await makeFakeAdapter(world, 0, scriptDir);
    const result = await climb({
      cli: adapter,
      model: 'fake-budget',
      seed,
      outDir: runsDir,
      pollMs: 150,
      wallMsLimit: 30_000,
      budgetTokens: 10, // the fake reports far more than this per attempt
      topRung: 99,
    });
    assert.equal(result.stoppedBecause, 'budget');
    assert.equal(result.submissions[0].pass, true, 'the rung still passed; budget is a separate cap');
  } finally {
    await rm(runsDir, { recursive: true, force: true });
    await rm(scriptDir, { recursive: true, force: true });
  }
});
