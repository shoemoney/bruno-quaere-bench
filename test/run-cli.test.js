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

import { makeWorld, fieldName, VERSION as LADDER_VERSION } from '../src/world.js';
import { makeRung } from '../src/ladder/rung.js';
import { climb, bruShimSource } from '../src/harness/run-cli.js';
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

// supervise.js's own primitives (killTree, gracefulKillTree, the baseline/drain/overshoot
// contract) are exercised in test/supervise.test.js, not here -- this file is climb()'s own
// integration surface: task-md.js, the bru shim, and the whole CLI-adapter loop.

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
    // Addendum G: turns is counted from the admin log's bruno-runtime/ User-Agent entries, not
    // the shim. This fake adapter talks over plain fetch (never bru), so neither source has
    // anything to count -- see the dedicated "turns-from-admin-log" test below for the case where
    // they'd actually disagree.
    assert.equal(result.turns, 0, 'the fake adapter never calls bru, so admin-log turns is 0');
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
    // Addendum G: the board groups rows by ladder version, so result.json has to carry the real
    // one. Without this, score.js's versionOf() falls back to 'unknown' for every run ever made
    // and the board's "(current)" section is permanently empty -- a feature that only ever worked
    // on hand-written test fixtures.
    assert.equal(resultOnDisk.version, LADDER_VERSION);
    assert.equal(result.version, LADDER_VERSION);

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

// ---------------------------------------------------------------------------
// Addendum P: suspended time -- a fake `now()` simulates a multi-hour sleep between two spawns
// (the CLI-path equivalent of run.js's turn-to-turn gap) without the test actually waiting for
// it. The jump is injected from inside the fake adapter's build() -- called by climb() between
// one spawn finishing and the next one starting, i.e. strictly before the next loop iteration's
// own wall-check tick() -- so no knowledge of supervise.js's internal now()-call count is needed.
// ---------------------------------------------------------------------------

test('climb(): a 6-hour gap between spawns does not end a CLI climb whose active time is under the wall (Addendum P)', async () => {
  const seed = 1;
  const runsDir = await tmpRunsDir();
  try {
    let clock = 0;
    const now = () => {
      clock += 5;
      return clock;
    };
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    let calls = 0;
    const adapter = {
      name: 'sleepy',
      build: () => {
        calls += 1;
        // The machine "slept" for 6 hours right after the very first spawn, while the second was
        // being prepared -- landing the gap exactly between the two, where run-cli.js's own
        // tick() (at the top of its resume loop) looks for it.
        if (calls === 2) clock += SIX_HOURS_MS;
        return { cmd: process.execPath, args: ['-e', 'process.exit(0)'], env: {} };
      },
      parseUsage: () => ({ tokensIn: 10, tokensOut: 10, tokensCached: 0 }),
      resume: () => null,
    };
    const result = await climb({
      cli: adapter,
      model: 'fake-sleepy',
      seed,
      outDir: runsDir,
      pollMs: 20,
      // 1 hour of ACTIVE wall budget -- a single unexcluded 6h gap would blow straight through it.
      wallMsLimit: 60 * 60 * 1000,
      now,
    });
    assert.equal(result.stoppedBecause, 'stalled', 'ran to the resume cap rather than being cut by the wall');
    assert.equal(result.resumes, 3);
    assert.equal(calls, 4, 'the initial build() plus exactly 3 resume-as-fresh-build() calls');
    assert.ok(
      result.suspendedMs >= SIX_HOURS_MS,
      `expected suspendedMs to include the 6h gap, got ${result.suspendedMs}`,
    );
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test('climb(): via the same fake clock, active time (no sleep) over the wall still ends a CLI climb as "time" (Addendum P)', async () => {
  const seed = 1;
  const runsDir = await tmpRunsDir();
  try {
    let clock = 0;
    const now = () => {
      clock += 20_000; // pure active time per tick -- never a gap over the 5-minute threshold
      return clock;
    };
    const adapter = {
      name: 'active',
      build: () => ({ cmd: process.execPath, args: ['-e', 'process.exit(0)'], env: {} }),
      parseUsage: () => ({ tokensIn: 10, tokensOut: 10, tokensCached: 0 }),
      resume: () => null,
    };
    const result = await climb({
      cli: adapter,
      model: 'fake-active',
      seed,
      outDir: runsDir,
      pollMs: 20,
      wallMsLimit: 50_000,
      now,
    });
    assert.equal(result.stoppedBecause, 'time');
    assert.equal(result.suspendedMs, 0);
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

// ---------------------------------------------------------------------------
// Addendum G: "Turns are counted at the API, not by the shim."
// ---------------------------------------------------------------------------

// buildTurnsAdapterScript(): like buildFakeAdapterScript, but first fires `QUAERE_FAKE_BRU_TURNS`
// extra GET /rungs/current requests carrying a literal `bruno-runtime/1.0.0` User-Agent -- standing
// in for genuine bru invocations reaching the API by some path this run's shim never observed
// (codex's round-three PATH miss, per Addendum G). The token/create/submit calls that follow use
// fetch's own default User-Agent, same as every other fake adapter here, so they must NOT count.
async function buildTurnsAdapterScript(dir) {
  const scriptPath = path.join(dir, 'turns-cli.mjs');
  const source = `#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const taskText = readFileSync('TASK.md', 'utf8');
const baseUrl = taskText.match(/Base URL: (\\S+)/)[1];
const apiKey = taskText.match(/API key: (\\S+) --/)[1];
const plan = JSON.parse(process.env.QUAERE_FAKE_PLAN);
const naming = JSON.parse(process.env.QUAERE_FAKE_NAMING);
const bruTurns = Number(process.env.QUAERE_FAKE_BRU_TURNS || '0');

async function main() {
  // Stand-ins for real bru invocations: same User-Agent a genuine bru sends, none of which this
  // run's shim (never installed on this fake process's PATH) ever sees.
  for (let i = 0; i < bruTurns; i += 1) {
    await fetch(baseUrl + '/rungs/current', { headers: { 'user-agent': 'bruno-runtime/1.0.0' } });
  }

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
    usage: { tokensIn: 111, tokensOut: 22, tokensCached: 0, modelVersion: 'fake-turns-model' },
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

async function makeTurnsAdapter(world, n, scriptDir, bruTurns) {
  const rung = makeRung(world, n);
  const step = rung.plan[rung.plan.length - 1];
  const scriptPath = await buildTurnsAdapterScript(scriptDir);
  const naming = {
    apiKeyField: fieldName(world, 'api_key'),
    accessTokenField: fieldName(world, 'access_token'),
    assetsField: fieldName(world, 'assets'),
    createPath: CREATE_PATH[step.args.kind],
    submitPath: `/rungs/${n}/submit`,
  };
  return {
    name: 'fake-turns',
    build: () => ({
      cmd: process.execPath,
      args: [scriptPath],
      env: {
        QUAERE_FAKE_PLAN: JSON.stringify(step.args),
        QUAERE_FAKE_NAMING: JSON.stringify(naming),
        QUAERE_FAKE_BRU_TURNS: String(bruTurns),
      },
    }),
    parseUsage: (stdout) => {
      const lines = stdout.trim().split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (parsed && parsed.usage) return parsed.usage;
        } catch {
          // keep looking
        }
      }
      return { tokensIn: 0, tokensOut: 0, tokensCached: 0 };
    },
    resume: () => null,
  };
}

test('climb(): turns is counted from the admin log\'s bruno-runtime/ entries, not the shim -- the two can disagree', async () => {
  const seed = 1;
  const world = makeWorld(seed);
  const runsDir = await tmpRunsDir();
  const scriptDir = await mkdtemp(path.join(os.tmpdir(), 'quaere-turns-cli-'));
  try {
    const bruTurns = 5;
    const adapter = await makeTurnsAdapter(world, 0, scriptDir, bruTurns);

    const result = await climb({
      cli: adapter,
      model: 'fake-turns-model',
      seed,
      outDir: runsDir,
      pollMs: 150,
      wallMsLimit: 30_000,
      topRung: 0,
    });

    assert.equal(result.stoppedBecause, 'top');
    assert.equal(result.submissions[0].pass, true);
    // This adapter never touches the sandbox's bin/bru shim at all -- turns.jsonl is empty --
    // yet it made 5 requests carrying bru's own User-Agent. Per Addendum G, turns must come from
    // the admin log, so it must be 5, not 0.
    assert.equal(result.turns, bruTurns);

    const runDir = path.join(runsDir, 'fake-turns-model', String(seed), '1');
    const shimTurnsText = await readFile(path.join(runDir, 'sandbox', 'turns.jsonl'), 'utf8').catch(() => '');
    assert.equal(shimTurnsText.trim(), '', 'the shim log stays empty; this adapter never invoked bin/bru');
  } finally {
    await rm(runsDir, { recursive: true, force: true });
    await rm(scriptDir, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// Addendum G follow-up: the usage settle window after a supervised kill
// ---------------------------------------------------------------------------

// Measured on a real killed qwen run: the CLI wrote $HOME/.qwen/usage_record.jsonl at
// 18:44:17.952 and parseUsage read it at 18:44:17.953. One millisecond early, and the run
// reported zero tokens and a null model with the real answer already on disk. A killed spawn now
// re-reads for a short settle window, so an adapter whose session file lands a beat after the
// process exits still reports real usage.

test('climb(): a killed spawn re-reads usage until the CLI\'s own shutdown write lands', async () => {
  const seed = 1;
  const world = makeWorld(seed);
  const runsDir = await tmpRunsDir();
  const scriptDir = await mkdtemp(path.join(os.tmpdir(), 'quaere-fake-cli-settle-'));
  try {
    const adapter = await makeFakeAdapter(world, 0, scriptDir);
    // Stand in for "the session file isn't written yet": throw the way ai/codex/gemini/qwen's
    // parseUsage does when it can find nothing, then succeed once the file would have landed.
    let calls = 0;
    const inner = adapter.parseUsage;
    adapter.parseUsage = (stdout, home) => {
      calls += 1;
      if (calls < 3) throw new Error('fake adapter: session file not written yet');
      return { ...inner(stdout, home), modelVersion: 'fake-model-1' };
    };

    const result = await climb({
      cli: adapter,
      model: 'fake-model-1',
      seed,
      attempt: 1,
      outDir: runsDir,
      pollMs: 150,
      wallMsLimit: 30_000,
      topRung: 0,
    });

    assert.ok(calls >= 3, 'parseUsage must be retried, not taken as final on the first miss');
    assert.equal(result.usageEstimated, false, 'a late-landing session file is real usage, not an estimate');
    assert.equal(result.modelVersion, 'fake-model-1');
    assert.ok(result.tokensNovel > 0);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
    await rm(scriptDir, { recursive: true, force: true });
  }
});

test('climb(): a killed spawn that never produces usage still ends as an estimate, not a throw', async () => {
  const seed = 1;
  const world = makeWorld(seed);
  const runsDir = await tmpRunsDir();
  const scriptDir = await mkdtemp(path.join(os.tmpdir(), 'quaere-fake-cli-nousage-'));
  try {
    const adapter = await makeFakeAdapter(world, 0, scriptDir);
    adapter.parseUsage = () => {
      throw new Error('fake adapter: nothing to read, ever');
    };

    const result = await climb({
      cli: adapter,
      model: 'fake-model-1',
      seed,
      attempt: 1,
      outDir: runsDir,
      pollMs: 150,
      wallMsLimit: 30_000,
      topRung: 0,
    });

    // The climb's outcome was already decided by the passing submission; a usage read that never
    // succeeds costs the tokens column, not the run.
    assert.equal(result.stoppedBecause, 'top');
    assert.equal(result.rung, 0);
    assert.equal(result.usageEstimated, true);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
    await rm(scriptDir, { recursive: true, force: true });
  }
});
