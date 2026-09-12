// harness/sandbox.js and harness/run.js: the sandbox's PATH/path-escape guarantees, and a full
// climb of rungs 0-2 through a scripted fake driver against a real, live server. Skips (not
// fails) the parts that need `bru` when it isn't on PATH -- Bruno is a dev/CI tool here, not a
// runtime dependency of this package (same convention as test/collection.test.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { makeWorld } from '../src/world.js';
import { toSkill } from '../src/skill.js';
import { toOpenApi } from '../src/spec.js';
import { makeRung } from '../src/ladder/rung.js';
import { makeSandbox, parseCommandLine } from '../src/harness/sandbox.js';
import { climb, computeTrap } from '../src/harness/run.js';

function hasBru() {
  const result = spawnSync('bru', ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quaere-sandbox-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// parseCommandLine
// ---------------------------------------------------------------------------

test('parseCommandLine: respects single and double quotes', () => {
  assert.deepEqual(parseCommandLine('run "my file.bru" --env local'), ['run', 'my file.bru', '--env', 'local']);
  assert.deepEqual(parseCommandLine("run 'a b' c"), ['run', 'a b', 'c']);
  assert.deepEqual(parseCommandLine('  run   x  '), ['run', 'x']);
});

// ---------------------------------------------------------------------------
// sandbox: non-bru rejection and path escapes (need a real bru to build the sandbox at all)
// ---------------------------------------------------------------------------

test('makeSandbox: exec rejects anything whose argv[0] is not bru', async (t) => {
  if (!hasBru()) {
    t.skip('bru is not on PATH');
    return;
  }
  await withTempDir(async (dir) => {
    const sandbox = makeSandbox(dir);
    await assert.rejects(() => sandbox.exec('node -e "1"'), /only "bru" may be run/);
    await assert.rejects(() => sandbox.exec('curl https://example.com'), /only "bru" may be run/);
  });
});

test('makeSandbox: exec runs a real bru invocation with only the sandbox bin on PATH', async (t) => {
  if (!hasBru()) {
    t.skip('bru is not on PATH');
    return;
  }
  await withTempDir(async (dir) => {
    const sandbox = makeSandbox(dir);
    const r = await sandbox.exec('bru --version');
    assert.equal(r.code, 0);
    assert.match(r.stdout, /\d+\.\d+\.\d+/);
    assert.equal(typeof r.ms, 'number');
  });
});

test('makeSandbox: write_file/read_file/grep/ls reject paths that escape the sandbox', async (t) => {
  if (!hasBru()) {
    t.skip('bru is not on PATH');
    return;
  }
  await withTempDir(async (dir) => {
    const sandbox = makeSandbox(dir);
    await assert.rejects(() => sandbox.writeFile('../escape.txt', 'x'), /escapes sandbox/);
    await assert.rejects(() => sandbox.writeFile('/etc/passwd', 'x'), /escapes sandbox/);
    await assert.rejects(() => sandbox.readFile('../../etc/passwd'), /escapes sandbox/);
    await assert.rejects(() => sandbox.ls('..'), /escapes sandbox/);

    await sandbox.writeFile('notes/plan.md', 'line1\nline2\nline3\n');
    const read = await sandbox.readFile('notes/plan.md');
    assert.equal(read.lines.length, 4); // trailing newline makes a 4th, empty, line
    assert.equal(read.lines[0].text, 'line1');

    const grepped = await sandbox.grep('line2', 'notes/plan.md');
    assert.equal(grepped.hits.length, 1);
    assert.equal(grepped.hits[0].line, 2);

    const listed = await sandbox.ls('notes');
    assert.deepEqual(listed.entries.map((e) => e.name), ['plan.md']);
  });
});

// ---------------------------------------------------------------------------
// run.js: a scripted fake driver climbs rungs 0-2 end to end, through a real server, using bru.
// ---------------------------------------------------------------------------

const SEED = 909;
const PUBLIC_PORT = 48190;
const ADMIN_PORT = 48191;

function yamlBlock(text, indent) {
  const pad = ' '.repeat(indent);
  return text
    .split('\n')
    .map((line) => (line.length ? pad + line : line))
    .join('\n');
}

function buildOpenCollectionYml() {
  return ['opencollection: 1.0.0', '', 'info:', '  name: quaere harness test climb', '  version: "1"', ''].join('\n');
}

function buildEnvYml(baseUrl, apiKey) {
  return [
    'name: local',
    'variables:',
    '  - name: baseUrl',
    `    value: ${baseUrl}`,
    '  - name: apiKey',
    `    value: ${apiKey}`,
    '',
  ].join('\n');
}

// One request whose "tests" script does the actual work: authenticate, then create+submit for
// every rung in `plans` (in order, by path -- submitting for rung n never depends on the server's
// notion of "current rung", only on the answer key for n), then deliberately submit a wrong asset
// for rung 3 so the run ends in a clean, deterministic fail.
function buildClimbYml(plans) {
  const codeLines = [
    `const PLANS = ${JSON.stringify(plans)};`,
    "const base = bru.getEnvVar('baseUrl');",
    'let accessToken = res.body.accessToken || res.body.access_token;',
    '',
    'async function run() {',
    '  for (const p of PLANS) {',
    "    const createPath = p.kind === 'image' ? '/images' : '/audio';",
    '    const createRes = await fetch(base + createPath, {',
    "      method: 'POST',",
    "      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + accessToken },",
    '      body: JSON.stringify(p.params),',
    '    });',
    '    const created = await createRes.json();',
    "    test('rung ' + p.n + ' create succeeded', function () {",
    '      expect(createRes.status).to.equal(201);',
    '    });',
    '',
    "    const submitRes = await fetch(base + '/rungs/' + p.n + '/submit', {",
    "      method: 'POST',",
    "      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + accessToken },",
    '      body: JSON.stringify({ assets: [created.id] }),',
    '    });',
    '    const submitBody = await submitRes.json();',
    "    test('rung ' + p.n + ' submit passed', function () {",
    '      expect(submitBody.pass).to.equal(true);',
    '    });',
    '  }',
    '',
    "  const failRes = await fetch(base + '/rungs/3/submit', {",
    "    method: 'POST',",
    "    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + accessToken },",
    "    body: JSON.stringify({ assets: ['does-not-exist'] }),",
    '  });',
    '  const failBody = await failRes.json();',
    "  test('rung 3 correctly fails on a wrong asset', function () {",
    '    expect(failBody.pass).to.equal(false);',
    '  });',
    '}',
    '',
    'await run();',
  ].join('\n');

  return [
    'info:',
    '  name: climb',
    '  type: http',
    '  seq: 1',
    '',
    'http:',
    '  method: POST',
    '  url: "{{baseUrl}}/auth/token"',
    '  headers:',
    '    - name: content-type',
    '      value: application/json',
    '  body:',
    '    type: json',
    '    data: |-',
    '      {',
    '        "api_key": "{{apiKey}}"',
    '      }',
    '',
    'runtime:',
    '  assertions:',
    '    - expression: res.status',
    '      operator: eq',
    '      value: "200"',
    '  scripts:',
    '    - type: tests',
    '      code: |-',
    yamlBlock(codeLines, 8),
    '',
  ].join('\n');
}

// A fake driver: a fixed script of tool calls, no model, no network call of its own. Turn 1-3
// write the collection; turn 4 runs it, which is enough for run.js to see rungs 0-2 pass and
// rung 3 fail on the very next submissions poll.
function makeScriptedDriver(steps) {
  let i = 0;
  return {
    async step() {
      const s = steps[i] || { toolCalls: [] };
      i += 1;
      return {
        assistant: s.assistant || '',
        toolCalls: s.toolCalls || [],
        usage: { input_tokens: 50, output_tokens: 50 },
        stop: (s.toolCalls || []).length ? 'tool_use' : 'end_turn',
      };
    },
  };
}

// Trap must measure what the AGENT wrote, not what the harness handed it. SKILL.md spells out
// every override in plain text, so when it was included in the scan every run scored Trap 1.0 --
// the metric was a constant. Seed 11's needles ("running", "job_id") appear in SKILL.md and in no
// file this fake agent authored, which makes the two cases cleanly separable.
test('computeTrap: credit comes from agent-authored files, never the planted SKILL.md/spec.json', async () => {
  const world = makeWorld(11);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quaere-trap-'));
  try {
    // Exactly what copyCollection() leaves behind: the harness's own files plus the agent's.
    await writeFile(path.join(dir, 'SKILL.md'), toSkill(world), 'utf8');
    await writeFile(path.join(dir, 'spec.json'), JSON.stringify(toOpenApi(world)), 'utf8');
    await writeFile(path.join(dir, 'notes.bru'), 'the agent never went looking for anything\n', 'utf8');

    assert.equal(await computeTrap(world, dir), 0, 'planted files must not earn trap credit');

    // Now the agent itself records both real values it had to discover.
    await writeFile(path.join(dir, 'notes.bru'), 'poll status running, then read job_id\n', 'utf8');
    assert.equal(await computeTrap(world, dir), 1, 'agent-authored evidence must earn full credit');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  'run.js climb(): a scripted driver climbs rungs 0-2 through a real server via bru, then fails rung 3',
  { timeout: 60_000 },
  async (t) => {
    if (!hasBru()) {
      t.skip('bru is not on PATH');
      return;
    }

    const world = makeWorld(SEED);
    const baseUrl = `http://127.0.0.1:${PUBLIC_PORT}`;
    const plans = [0, 1, 2].map((n) => {
      const rung = makeRung(world, n);
      return { n, kind: rung.plan[0].args.kind, params: rung.plan[0].args.params };
    });

    const driver = makeScriptedDriver([
      { toolCalls: [{ id: 't1', name: 'write_file', input: { path: 'opencollection.yml', content: buildOpenCollectionYml() } }] },
      {
        toolCalls: [
          { id: 't2', name: 'write_file', input: { path: 'environments/local.yml', content: buildEnvYml(baseUrl, world.auth.apiKey) } },
        ],
      },
      { toolCalls: [{ id: 't3', name: 'write_file', input: { path: 'climb.yml', content: buildClimbYml(plans) } }] },
      { toolCalls: [{ id: 't4', name: 'bru', input: { args: 'run . --env local --sandbox developer' } }] },
    ]);

    const outDir = await mkdtemp(path.join(os.tmpdir(), 'quaere-run-'));
    try {
      const result = await climb({
        model: 'fake-model',
        seed: SEED,
        attempt: 1,
        outDir,
        driver,
        maxTurns: 10,
        publicPort: PUBLIC_PORT,
        adminPort: ADMIN_PORT,
      });

      assert.equal(result.rung, 2, `expected to clear through rung 2, got ${JSON.stringify(result)}`);
      assert.equal(result.stoppedBecause, 'fail');
      assert.equal(result.submissions.length, 4);
      assert.deepEqual(
        result.submissions.map((s) => s.pass),
        [true, true, true, false],
      );
      assert.ok(result.fidelity > 0);
      assert.equal(typeof result.tokensIn, 'number');
      assert.equal(typeof result.tokensOut, 'number');

      const runDir = path.join(outDir, 'fake-model', String(SEED), '1');
      const resultOnDisk = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8'));
      assert.equal(resultOnDisk.rung, 2);

      const transcript = (await readFile(path.join(runDir, 'transcript.jsonl'), 'utf8')).trim().split('\n');
      assert.equal(transcript.length, 4);

      const collected = await readFile(path.join(runDir, 'collection', 'climb.yml'), 'utf8');
      assert.match(collected, /submit passed/);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  },
);
