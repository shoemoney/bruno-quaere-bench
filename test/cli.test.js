// bin/quaere.js: spec/skill/rung print for seed 1, and board renders from a fixture. Each
// subcommand is exercised as a real subprocess (spawnSync node bin/quaere.js ...) so this is
// also the only place that would notice, say, a broken shebang or a bad import path.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeWorld } from '../src/world.js';
import { toOpenApi } from '../src/spec.js';
import { toSkill } from '../src/skill.js';
import { makeRung } from '../src/ladder/rung.js';
import { parseArgs } from '../bin/quaere.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const binPath = path.join(repoRoot, 'bin', 'quaere.js');

function runCli(args, opts = {}) {
  return spawnSync('node', [binPath, ...args], { cwd: repoRoot, encoding: 'utf8', ...opts });
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs: flags with values, boolean flags, and positionals', () => {
  assert.deepEqual(parseArgs(['runs/', '--seed', '42', '--answer']), { _: ['runs/'], seed: '42', answer: true });
  assert.deepEqual(parseArgs(['run', '--driver', 'anthropic']), { _: ['run'], driver: 'anthropic' });
});

// ---------------------------------------------------------------------------
// spec / skill / rung for seed 1
// ---------------------------------------------------------------------------

test('quaere spec --seed 1 prints the same OpenAPI document toOpenApi(makeWorld(1)) would', () => {
  const result = runCli(['spec', '--seed', '1']);
  assert.equal(result.status, 0, result.stderr);
  const printed = JSON.parse(result.stdout);
  // Round-trip the expected value through JSON too: toOpenApi legitimately leaves a few schema
  // keys (e.g. array `items`) as an explicit `undefined` for shapes with no item schema, which
  // JSON.stringify drops -- that's a serialization detail, not something the CLI got wrong.
  assert.deepEqual(printed, JSON.parse(JSON.stringify(toOpenApi(makeWorld(1)))));
});

test('quaere skill --seed 1 prints the same markdown toSkill(makeWorld(1)) would', () => {
  const result = runCli(['skill', '--seed', '1']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${toSkill(makeWorld(1))}\n`);
  assert.match(result.stdout, /^---/);
});

test('quaere rung --seed 1 --n 3 prints the rung number and its task text', () => {
  const result = runCli(['rung', '--seed', '1', '--n', '3']);
  assert.equal(result.status, 0, result.stderr);
  const rung = makeRung(makeWorld(1), 3);
  assert.equal(result.stdout, `Rung 3\n${rung.text}\n`);
});

test('quaere rung --seed 1 --n 3 --answer prints the plan and expected descriptors as JSON', () => {
  const result = runCli(['rung', '--seed', '1', '--n', '3', '--answer']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  const rung = makeRung(makeWorld(1), 3);
  assert.equal(parsed.n, 3);
  assert.equal(parsed.text, rung.text);
  assert.deepEqual(parsed.plan, rung.plan);
});

test('quaere with no/unknown subcommand prints usage and exits nonzero', () => {
  const result = runCli([]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /usage: quaere/);
});

// ---------------------------------------------------------------------------
// board, from a fixture
// ---------------------------------------------------------------------------

async function writeFixtureResult(runsDir, model, seed, attempt, result) {
  const dir = path.join(runsDir, model, String(seed), String(attempt));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
}

function fixtureResult({ model, rung, turns, fidelity, trap, tokensIn, tokensOut, wallMs, pass }) {
  return {
    model,
    modelVersion: model,
    seed: 1,
    attempt: 1,
    rung,
    turns,
    tokensIn,
    tokensOut,
    wallMs,
    fidelity,
    trap,
    submissions: pass
      ? []
      : [{ rung: rung + 1, pass: false, submittedHashes: ['deadbeef'], expectedHashes: ['c0ffee'], fidelity: 0.5 }],
    stoppedBecause: pass ? 'top' : 'fail',
  };
}

test('quaere board <dir> renders a fixture sorted by rung desc, turns asc', async () => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'quaere-board-fixture-'));
  try {
    await writeFixtureResult(
      runsDir,
      'model-a',
      1,
      1,
      fixtureResult({ model: 'model-a', rung: 12, turns: 40, fidelity: 0.9, trap: 0.5, tokensIn: 1000, tokensOut: 500, wallMs: 5000 }),
    );
    await writeFixtureResult(
      runsDir,
      'model-b',
      1,
      1,
      fixtureResult({ model: 'model-b', rung: 20, turns: 60, fidelity: 0.8, trap: 1, tokensIn: 2000, tokensOut: 1000, wallMs: 9000 }),
    );

    const result = runCli(['board', runsDir]);
    assert.equal(result.status, 0, result.stderr);

    const lines = result.stdout.trim().split('\n');
    assert.equal(lines[0], '# Bruno QUAERE board');
    const modelBLine = lines.findIndex((l) => l.includes('model-b'));
    const modelALine = lines.findIndex((l) => l.includes('model-a'));
    assert.ok(modelBLine > 0 && modelALine > 0);
    assert.ok(modelBLine < modelALine, 'model-b (rung 20) should sort above model-a (rung 12)');
    assert.match(result.stdout, /fell at rung 13/);
    assert.match(result.stdout, /fell at rung 21/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test('quaere board <dir> with no result.json files prints a friendly empty board', async () => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'quaere-board-empty-'));
  try {
    const result = runCli(['board', runsDir]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No runs yet/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});
