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
// Addendum B/A together: the sandbox's read_file/grep exist because a 5 MB sloppy skill cannot be
// read in one turn. The full-size test would just be slow, so this climb asks for a 64 KB sloppy
// skill instead -- small enough to build fast, still sloppy enough to exercise the editor tools
// for real (grep finds several `dpi=...` claims, decoys included, per skill-sloppy.js).
const SKILL_BYTES = 64 * 1024;

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

// One request per rung, run through bru as its own separate invocation: authenticate, create,
// submit to `/rungs/{n}/submit`, and assert the expected pass/fail. Addendum N ties a submit's
// fate to the server's notion of "current rung", and that pointer only ever moves via run.js's
// own /admin/rungs/advance call between turns -- so unlike the old single-script climb, each
// rung here MUST be its own bru run, one per driver turn, so the harness's real poll-then-advance
// cycle runs for real between them.
function buildRungYml(n, kind, params, { expectPass = true } = {}) {
  const label = expectPass ? 'submit passed' : 'submit correctly fails on a wrong asset';
  const codeLines = [
    "const base = bru.getEnvVar('baseUrl');",
    'let accessToken = res.body.accessToken || res.body.access_token;',
    '',
    'async function run() {',
    `  const createPath = ${JSON.stringify(kind === 'image' ? '/images' : '/audio')};`,
    '  const createRes = await fetch(base + createPath, {',
    "    method: 'POST',",
    "    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + accessToken },",
    `    body: JSON.stringify(${JSON.stringify(params)}),`,
    '  });',
    '  const created = await createRes.json();',
    `  test('rung ${n} create succeeded', function () {`,
    '    expect(createRes.status).to.equal(201);',
    '  });',
    '',
    `  const submitRes = await fetch(base + '/rungs/${n}/submit', {`,
    "    method: 'POST',",
    "    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + accessToken },",
    '    body: JSON.stringify({ assets: [created.id] }),',
    '  });',
    '  const submitBody = await submitRes.json();',
    `  test('rung ${n} ${label}', function () {`,
    `    expect(submitBody.pass).to.equal(${expectPass});`,
    '  });',
    '}',
    '',
    'await run();',
  ].join('\n');

  return [
    'info:',
    `  name: climb-${n}`,
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

// A fake driver: a fixed script of tool calls, no model, no network call of its own.
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
      // Addendum B: before writing anything, the agent goes looking in the sloppy skill --
      // grep for a rule, then read the region around a hit. Neither call's result feeds this
      // scripted driver's later steps (it isn't adaptive), but both must round-trip through the
      // real sandbox tools against the real (64 KB) SKILL.md the harness wrote to disk.
      { toolCalls: [{ id: 't0', name: 'grep', input: { pattern: 'dpi=', path: 'SKILL.md' } }] },
      { toolCalls: [{ id: 't0b', name: 'read_file', input: { path: 'SKILL.md', offset: 0, limit: 50 } }] },
      { toolCalls: [{ id: 't1', name: 'write_file', input: { path: 'opencollection.yml', content: buildOpenCollectionYml() } }] },
      {
        toolCalls: [
          { id: 't2', name: 'write_file', input: { path: 'environments/local.yml', content: buildEnvYml(baseUrl, world.auth.apiKey) } },
        ],
      },
      { toolCalls: [{ id: 't3', name: 'write_file', input: { path: 'climb-0.yml', content: buildRungYml(plans[0].n, plans[0].kind, plans[0].params) } }] },
      { toolCalls: [{ id: 't4', name: 'bru', input: { args: 'run climb-0.yml --env local --sandbox developer' } }] },
      { toolCalls: [{ id: 't5', name: 'write_file', input: { path: 'climb-1.yml', content: buildRungYml(plans[1].n, plans[1].kind, plans[1].params) } }] },
      { toolCalls: [{ id: 't6', name: 'bru', input: { args: 'run climb-1.yml --env local --sandbox developer' } }] },
      { toolCalls: [{ id: 't7', name: 'write_file', input: { path: 'climb-2.yml', content: buildRungYml(plans[2].n, plans[2].kind, plans[2].params) } }] },
      { toolCalls: [{ id: 't8', name: 'bru', input: { args: 'run climb-2.yml --env local --sandbox developer' } }] },
      // Rung 3 deliberately submits the wrong kind of asset (rung 0's plan) so the run ends in a
      // clean, deterministic fail once the pointer has genuinely advanced to rung 3.
      { toolCalls: [{ id: 't9', name: 'write_file', input: { path: 'climb-3.yml', content: buildRungYml(3, plans[0].kind, plans[0].params, { expectPass: false }) } }] },
      { toolCalls: [{ id: 't10', name: 'bru', input: { args: 'run climb-3.yml --env local --sandbox developer' } }] },
    ]);

    const outDir = await mkdtemp(path.join(os.tmpdir(), 'quaere-run-'));
    try {
      const result = await climb({
        model: 'fake-model',
        seed: SEED,
        attempt: 1,
        outDir,
        driver,
        maxTurns: 14,
        publicPort: PUBLIC_PORT,
        adminPort: ADMIN_PORT,
        skillBytes: SKILL_BYTES,
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

      const transcriptLines = (await readFile(path.join(runDir, 'transcript.jsonl'), 'utf8')).trim().split('\n');
      assert.equal(transcriptLines.length, 12);
      const transcript = transcriptLines.map((line) => JSON.parse(line));
      assert.equal(transcript[0].toolCalls[0].name, 'grep');
      assert.equal(transcript[1].toolCalls[0].name, 'read_file');

      const collected = await readFile(path.join(runDir, 'collection', 'climb-0.yml'), 'utf8');
      assert.match(collected, /submit passed/);

      // The skill the agent actually read from disk is the small sloppy one this run asked for
      // (skillBytes), not the 5 MB default, and it is sloppy enough that the grep step above
      // would have found real hits -- both a `--skill-bytes` wiring check and a sanity check on
      // Addendum A's noise.
      const skillOnDisk = await readFile(path.join(runDir, 'collection', 'SKILL.md'), 'utf8');
      assert.ok(
        skillOnDisk.length > SKILL_BYTES * 0.5 && skillOnDisk.length < SKILL_BYTES * 2,
        `SKILL.md is ${skillOnDisk.length} bytes, expected close to ${SKILL_BYTES}`,
      );
      assert.match(skillOnDisk, /dpi=/);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  },
);
