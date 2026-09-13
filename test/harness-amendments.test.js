// src/harness/run.js: Addendum Q rule 4 (mid-ladder amendments rewrite the sandbox's skill
// document before the amended rung's text is served, logged in the transcript) and rule 13
// (codeWrites/docReads counters). world.amendments does not exist on makeWorld()'s own output
// yet -- that half of Addendum Q is the [ladder]/[skill] workstreams' job -- so these tests use
// climb()'s `world` test hook (same escape-hatch pattern as its existing `driver` param) to attach
// one by hand, proving the harness-side wiring fires correctly the day that field is real.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { makeWorld, AMENDMENT_RULES } from '../src/world.js';
import { toSkill } from '../src/skill.js';
import { makeRung } from '../src/ladder/rung.js';
import { climb } from '../src/harness/run.js';

function hasBru() {
  const result = spawnSync('bru', ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

const SEED = 950;
const PUBLIC_PORT = 48390;
const ADMIN_PORT = 48391;
const SKILL_BYTES = 64 * 1024;

function yamlBlock(text, indent) {
  const pad = ' '.repeat(indent);
  return text
    .split('\n')
    .map((line) => (line.length ? pad + line : line))
    .join('\n');
}

function buildOpenCollectionYml() {
  return ['opencollection: 1.0.0', '', 'info:', '  name: quaere amendment test climb', '  version: "1"', ''].join('\n');
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

// One request per rung, exactly test/harness.test.js's own buildRungYml -- duplicated locally
// (not imported) because test files stay independent of each other in this project.
function buildRungYml(n, kind, params) {
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
    `  test('rung ${n} submit passed', function () {`,
    '    expect(submitBody.pass).to.equal(true);',
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

// A single, well-formed amendment at rung 1 (structurally identical to what drawAmendments(seed)
// itself produces -- same {atRung, rule, path, from, to} shape, same AMENDMENT_RULES entry -- just
// announced early so the test doesn't have to climb 30 real rungs to see it fire). rulesAt(world,
// n) (called unconditionally by composePlan/answerKey, per world.js's own doc comment) folds this
// into rung >= 1's composed rules; since this test only ever submits rung 0 (never graded against
// an amended rule), that is harmless to the climb's own pass/fail correctness.
function makeAmendmentAtRung1(world) {
  const { path: rulePath, choices } = AMENDMENT_RULES.roundTo;
  const from = world.rules.roundTo;
  const to = choices.find((c) => c !== from);
  return { atRung: 1, rule: 'roundTo', path: rulePath, from, to };
}

test(
  'run.js climb(): an amendment rung rewrites SKILL.md and logs it in the transcript (Addendum Q rule 4)',
  { timeout: 60_000 },
  async (t) => {
    if (!hasBru()) {
      t.skip('bru is not on PATH');
      return;
    }

    const world = makeWorld(SEED);
    const amendment = makeAmendmentAtRung1(world);
    // world.amendments doesn't exist on a real makeWorld() output yet (AMENDMENTS_ENFORCED is
    // false) -- attached by hand via climb()'s `world` test hook, same as `driver` above.
    world.amendments = [amendment];

    const baseUrl = `http://127.0.0.1:${PUBLIC_PORT}`;
    const rung0 = makeRung(world, 0);
    const plan0 = { kind: rung0.plan[0].args.kind, params: rung0.plan[0].args.params };

    const driver = makeScriptedDriver([
      { toolCalls: [{ id: 't1', name: 'write_file', input: { path: 'opencollection.yml', content: buildOpenCollectionYml() } }] },
      {
        toolCalls: [
          { id: 't2', name: 'write_file', input: { path: 'environments/local.yml', content: buildEnvYml(baseUrl, world.auth.apiKey) } },
        ],
      },
      { toolCalls: [{ id: 't3', name: 'write_file', input: { path: 'climb-0.yml', content: buildRungYml(0, plan0.kind, plan0.params) } }] },
      // Rung 0 passes here -> the harness advances to rung 1, the amendment rung: SKILL.md must
      // be rewritten and logged in this same turn, before the agent could ever ask for rung 1's
      // text. The driver has no more scripted steps after this -- the climb ends on its own via
      // the no-tool-call streak, which is fine: this test only cares about what already happened
      // by the time rung 0's submission turn completes.
      { toolCalls: [{ id: 't4', name: 'bru', input: { args: 'run climb-0.yml --env local --sandbox developer' } }] },
    ]);

    const outDir = await mkdtemp(path.join(os.tmpdir(), 'quaere-amend-run-'));
    try {
      const result = await climb({
        model: 'fake-amend-model',
        seed: SEED,
        world,
        attempt: 1,
        outDir,
        driver,
        maxTurns: 15,
        publicPort: PUBLIC_PORT,
        adminPort: ADMIN_PORT,
        skillBytes: SKILL_BYTES,
        topRung: 5,
      });

      assert.equal(result.stoppedBecause, 'error', 'no more scripted steps after rung 0 -- ends on the no-tool-call streak');
      assert.equal(result.rung, 0);
      assert.deepEqual(
        result.submissions.map((s) => s.pass),
        [true],
      );

      const runDir = path.join(outDir, 'fake-amend-model', String(SEED), '1');
      const transcriptLines = (await readFile(path.join(runDir, 'transcript.jsonl'), 'utf8')).trim().split('\n');
      const transcript = transcriptLines.map((line) => JSON.parse(line));
      const amendmentEntries = transcript.filter((e) => e.amendments);
      assert.equal(amendmentEntries.length, 1, 'exactly one amendment turn should have fired, at rung 1');
      assert.deepEqual(amendmentEntries[0].amendments, [
        { atRung: amendment.atRung, rule: amendment.rule, from: amendment.from, to: amendment.to },
      ]);
      // It fires on the very same turn as rung 0's own submission (the advance-then-check happens
      // inline, before the turn loop moves on), not some later turn.
      const submitTurn = transcript.find((e) => (e.toolCalls || []).some((c) => c.name === 'bru')).turn;
      assert.equal(amendmentEntries[0].turn, submitTurn);

      // The sandbox's skill document reflects the amended-mode call (mode: 'sloppy', the atRung
      // option threaded through) -- byte-identical to a direct toSkill() call with the same args.
      const skillOnDisk = await readFile(path.join(runDir, 'collection', 'SKILL.md'), 'utf8');
      assert.equal(skillOnDisk, toSkill(world, { mode: 'sloppy', atRung: 1, targetBytes: SKILL_BYTES }));
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  },
);

test(
  'run.js climb(): codeWrites counts script write_file calls, docReads counts read_file/grep against SKILL.md (Addendum Q rule 13)',
  { timeout: 60_000 },
  async (t) => {
    if (!hasBru()) {
      t.skip('bru is not on PATH');
      return;
    }

    const world = makeWorld(SEED + 5);
    const baseUrl = `http://127.0.0.1:${PUBLIC_PORT + 4}`;
    const rung0 = makeRung(world, 0);
    const plan0 = { kind: rung0.plan[0].args.kind, params: rung0.plan[0].args.params };

    const driver = makeScriptedDriver([
      // Two docReads: a grep and a read_file, both against the planted skill document.
      { toolCalls: [{ id: 't0', name: 'grep', input: { pattern: 'dpi=', path: 'SKILL.md' } }] },
      { toolCalls: [{ id: 't0b', name: 'read_file', input: { path: 'SKILL.md', offset: 0, limit: 50 } }] },
      // Two codeWrites: a .py and a .sh script; a .yml write right after must NOT count.
      { toolCalls: [{ id: 't0c', name: 'write_file', input: { path: 'solve.py', content: '# generated solver\n' } }] },
      { toolCalls: [{ id: 't0d', name: 'write_file', input: { path: 'run.sh', content: '#!/bin/sh\necho hi\n' } }] },
      { toolCalls: [{ id: 't1', name: 'write_file', input: { path: 'opencollection.yml', content: buildOpenCollectionYml() } }] },
      {
        toolCalls: [
          { id: 't2', name: 'write_file', input: { path: 'environments/local.yml', content: buildEnvYml(baseUrl, world.auth.apiKey) } },
        ],
      },
      // A grep of an UNRELATED subdirectory must not count as a docRead.
      { toolCalls: [{ id: 't2b', name: 'grep', input: { pattern: 'baseUrl', path: 'environments' } }] },
      { toolCalls: [{ id: 't3', name: 'write_file', input: { path: 'climb-0.yml', content: buildRungYml(0, plan0.kind, plan0.params) } }] },
      { toolCalls: [{ id: 't4', name: 'bru', input: { args: 'run climb-0.yml --env local --sandbox developer' } }] },
    ]);

    const outDir = await mkdtemp(path.join(os.tmpdir(), 'quaere-amend-run-'));
    try {
      const result = await climb({
        model: 'fake-q13-model',
        seed: SEED + 5,
        world,
        attempt: 1,
        outDir,
        driver,
        maxTurns: 12,
        publicPort: PUBLIC_PORT + 4,
        adminPort: ADMIN_PORT + 4,
        skillBytes: SKILL_BYTES,
        topRung: 0,
      });

      assert.equal(result.stoppedBecause, 'top');
      assert.equal(result.codeWrites, 2, 'the .py and .sh writes count; the two .yml writes do not');
      assert.equal(result.docReads, 2, 'grep+read_file on SKILL.md count; the grep of environments/ does not');
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  },
);

test(
  'run.js climb(): no world.amendments -- no amendment fires, transcript carries no amendment entries (regression guard)',
  { timeout: 60_000 },
  async (t) => {
    if (!hasBru()) {
      t.skip('bru is not on PATH');
      return;
    }

    const world = makeWorld(SEED + 1);
    // world.amendments deliberately left unset, same as every current makeWorld() output.
    const baseUrl = `http://127.0.0.1:${PUBLIC_PORT + 2}`;
    const rung0 = makeRung(world, 0);
    const plan0 = { kind: rung0.plan[0].args.kind, params: rung0.plan[0].args.params };

    const driver = makeScriptedDriver([
      { toolCalls: [{ id: 't1', name: 'write_file', input: { path: 'opencollection.yml', content: buildOpenCollectionYml() } }] },
      {
        toolCalls: [
          { id: 't2', name: 'write_file', input: { path: 'environments/local.yml', content: buildEnvYml(baseUrl, world.auth.apiKey) } },
        ],
      },
      { toolCalls: [{ id: 't3', name: 'write_file', input: { path: 'climb-0.yml', content: buildRungYml(0, plan0.kind, plan0.params) } }] },
      { toolCalls: [{ id: 't4', name: 'bru', input: { args: 'run climb-0.yml --env local --sandbox developer' } }] },
    ]);

    const outDir = await mkdtemp(path.join(os.tmpdir(), 'quaere-amend-run-'));
    try {
      const result = await climb({
        model: 'fake-noamend-model',
        seed: SEED + 1,
        world,
        attempt: 1,
        outDir,
        driver,
        maxTurns: 10,
        publicPort: PUBLIC_PORT + 2,
        adminPort: ADMIN_PORT + 2,
        skillBytes: SKILL_BYTES,
        topRung: 0,
      });

      assert.equal(result.stoppedBecause, 'top');
      assert.equal(result.codeWrites, 0);
      assert.equal(result.docReads, 0);

      const runDir = path.join(outDir, 'fake-noamend-model', String(SEED + 1), '1');
      const transcriptLines = (await readFile(path.join(runDir, 'transcript.jsonl'), 'utf8')).trim().split('\n');
      const transcript = transcriptLines.map((line) => JSON.parse(line));
      assert.equal(transcript.filter((e) => e.amendment).length, 0);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  },
);
