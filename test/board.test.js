// board.js / score.js: reading runs/**/result.json off disk, grouping into board rows, and
// rendering board.md per Addendum G -- grouped by ladder version (never medianed across
// versions), one row per (model, driver, seed), a corrupt result.json or one missing `model`
// dropped rather than crashing the board, superseded versions under their own heading, and a
// hand-written runs/DNR.json surfacing models that never produced a result.json at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { collectResults, readDnr, renderBoard, writeBoard } from '../src/harness/board.js';
import { scoreRuns } from '../src/harness/score.js';
import { VERSION as CURRENT_LADDER_VERSION } from '../src/world.js';

function freshRunsDir() {
  return mkdtemp(path.join(os.tmpdir(), 'quaere-board-'));
}

async function putResult(runsDir, model, seed, attempt, data) {
  const dir = path.join(runsDir, model, String(seed), String(attempt));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'result.json'), JSON.stringify(data, null, 2));
}

function fixture(overrides) {
  return {
    model: 'model-a',
    driver: 'anthropic',
    seed: 1,
    attempt: 1,
    rung: 10,
    turns: 20,
    tokensIn: 100,
    tokensOut: 50,
    tokensNovel: 150,
    tokensBilled: 150,
    trims: 0,
    wallMs: 1000,
    fidelity: 1,
    trap: 1,
    violations: 0,
    resumes: 0,
    submissions: [],
    stoppedBecause: 'fail',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// collectResults: malformed and well-formed files on disk together
// ---------------------------------------------------------------------------

test('collectResults skips a malformed result.json and still reads the good ones', async () => {
  const runsDir = await freshRunsDir();
  try {
    await putResult(runsDir, 'model-a', 1, 1, fixture({ model: 'model-a' }));
    const brokenDir = path.join(runsDir, 'model-b', '1', '1');
    await mkdir(brokenDir, { recursive: true });
    // truncated mid-write, as a killed process would leave it -- not valid JSON
    await writeFile(path.join(brokenDir, 'result.json'), '{"model": "model-b", "rung": 4, ');

    const results = await collectResults(runsDir);
    assert.equal(results.length, 1);
    assert.equal(results[0].model, 'model-a');
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test('collectResults returns [] for a directory with no result.json files anywhere', async () => {
  const runsDir = await freshRunsDir();
  try {
    await mkdir(path.join(runsDir, 'model-a', '1'), { recursive: true });
    await writeFile(path.join(runsDir, 'model-a', '1', 'transcript.jsonl'), '{}\n');
    assert.deepEqual(await collectResults(runsDir), []);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// scoreRuns: grouping key is (version, model, driver, seed); missing model is dropped
// ---------------------------------------------------------------------------

test('scoreRuns groups attempts of the same seed into one row, keeps different seeds separate', () => {
  const runs = [
    fixture({ seed: 1, attempt: 1, rung: 10, turns: 20 }),
    fixture({ seed: 1, attempt: 2, rung: 12, turns: 22 }),
    fixture({ seed: 2, attempt: 1, rung: 30, turns: 15 }),
  ];
  const rows = scoreRuns(runs);
  assert.equal(rows.length, 2, 'one row per (model, driver, seed), not one row per model');
  const bySeed = new Map(rows.map((r) => [r.seed, r]));
  assert.equal(bySeed.get(1).rung, 10, 'medianRun of the two seed-1 attempts (lower-middle on tie)');
  assert.equal(bySeed.get(2).rung, 30);
});

test('scoreRuns never blends two ladder versions into one row', () => {
  const runs = [fixture({ version: '0.1.0', rung: 5, turns: 8 }), fixture({ version: '0.2.0', rung: 90, turns: 8 })];
  const rows = scoreRuns(runs);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.version).sort(),
    ['0.1.0', '0.2.0'],
  );
});

test('scoreRuns falls back to version "unknown" when result.json has no version field', () => {
  const [row] = scoreRuns([fixture({})]);
  assert.equal(row.version, 'unknown');
});

test('scoreRuns skips a parsed result with no model rather than surfacing "undefined"', () => {
  const noModel = fixture({});
  delete noModel.model;
  const rows = scoreRuns([noModel, fixture({ model: 'model-a' })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, 'model-a');
});

test('scoreRuns keeps different drivers of the same model/seed as separate rows', () => {
  const rows = scoreRuns([fixture({ driver: 'anthropic' }), fixture({ driver: 'cli:ai' })]);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.driver).sort(),
    ['anthropic', 'cli:ai'],
  );
});

// ---------------------------------------------------------------------------
// renderBoard: current vs superseded sections, DNR, empty board
// ---------------------------------------------------------------------------

test('renderBoard puts the current ladder version first and groups older versions under Superseded', () => {
  const md = renderBoard([
    fixture({ model: 'old-model', version: '0.1.0', rung: 99, turns: 1 }),
    fixture({ model: 'new-model', version: CURRENT_LADDER_VERSION, rung: 40, turns: 1 }),
  ]);
  const currentHeadingIdx = md.indexOf(`## Ladder version ${CURRENT_LADDER_VERSION} (current)`);
  const supersededHeadingIdx = md.indexOf('## Superseded');
  const oldVersionHeadingIdx = md.indexOf('### Ladder version 0.1.0');
  assert.ok(currentHeadingIdx >= 0, 'names the current version explicitly');
  assert.ok(supersededHeadingIdx > currentHeadingIdx, 'current section leads, superseded follows');
  assert.ok(oldVersionHeadingIdx > supersededHeadingIdx, 'old version gets its own subheading under Superseded');
  // A model whose only result is on an old ladder version must not silently vanish, nor get
  // averaged in with the current version's row.
  assert.ok(md.indexOf('old-model') > supersededHeadingIdx);
  assert.ok(md.indexOf('new-model') < supersededHeadingIdx);
});

test('renderBoard groups an unversioned result under its own "unknown" subheading, not the current version', () => {
  const md = renderBoard([fixture({ model: 'legacy-model' })]); // no `version` field at all
  assert.doesNotMatch(md, new RegExp(`## Ladder version ${CURRENT_LADDER_VERSION.replace('.', '\\.')} \\(current\\)`));
  assert.match(md, /## Superseded/);
  assert.match(md, /### Ladder version unknown/);
});

test('renderBoard columns are Model/Driver/Seed/Rung/Turns/Fidelity/Trap/Novel/Billed/Violations/Resumes/Stop', () => {
  const md = renderBoard([fixture({ model: 'model-a', seed: 7, rung: 10, turns: 20, violations: 1, resumes: 2, stoppedBecause: 'budget' })]);
  assert.match(md, /\| Model \| Driver \| Seed \| Rung \| Turns \| Fidelity \| Trap \| Novel \| Billed \| Violations \| Resumes \| Stop \|/);
  assert.match(md, /\| model-a \| anthropic \| 7 \| 10 \| 20 \| 100\.0% \| 100\.0% \| 150 \| 150 \| 1\.0 \| 2\.0 \| budget \|/);
});

test('renderBoard prints "No runs yet." when there are no results and no DNR entries', () => {
  const md = renderBoard([]);
  assert.match(md, /No runs yet\./);
});

test('renderBoard appends a "Did not run" section fed from the dnr list, even with zero results', () => {
  const md = renderBoard([], { dnr: [{ model: 'qwen3.8-max', driver: 'cli:qwen', reason: 'operator agent errored before launching' }] });
  assert.match(md, /## Did not run/);
  assert.match(md, /qwen3\.8-max \/ cli:qwen\*\*: did not run -- operator agent errored before launching/);
});

test('renderBoard: a model with a real row and a model that did not run both show up, never silently', () => {
  const md = renderBoard([fixture({ model: 'model-a', version: CURRENT_LADDER_VERSION })], {
    dnr: [{ model: 'model-b', reason: 'crashed on launch' }],
  });
  assert.match(md, /model-a/);
  assert.match(md, /## Did not run/);
  assert.match(md, /model-b.*did not run -- crashed on launch/);
});

// ---------------------------------------------------------------------------
// writeBoard: end-to-end against a fixture runs/ directory, including a hand-written DNR.json
// ---------------------------------------------------------------------------

test('writeBoard reads runs/DNR.json when present and folds it into the published board', async () => {
  const runsDir = await freshRunsDir();
  try {
    await putResult(runsDir, 'model-a', 1, 1, fixture({ model: 'model-a', version: CURRENT_LADDER_VERSION }));
    await writeFile(path.join(runsDir, 'DNR.json'), JSON.stringify([{ model: 'qwen3.8-max', reason: 'operator agent errored before launching' }]));

    const outPath = path.join(runsDir, 'board.md');
    const md = await writeBoard(runsDir, outPath);

    assert.match(md, /model-a/);
    assert.match(md, /## Did not run/);
    assert.match(md, /qwen3\.8-max\*\*: did not run -- operator agent errored before launching/);

    const { readFile } = await import('node:fs/promises');
    const onDisk = await readFile(outPath, 'utf8');
    assert.equal(onDisk, md);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test('writeBoard tolerates a missing or malformed DNR.json (no operator file yet)', async () => {
  const runsDir = await freshRunsDir();
  try {
    await putResult(runsDir, 'model-a', 1, 1, fixture({ model: 'model-a' }));
    const outPath = path.join(runsDir, 'board.md');
    const md = await writeBoard(runsDir, outPath);
    assert.match(md, /model-a/);
    assert.doesNotMatch(md, /## Did not run/);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test('readDnr returns [] for a missing DNR.json and for one that is not a JSON array', async () => {
  const runsDir = await freshRunsDir();
  try {
    assert.deepEqual(await readDnr(runsDir), []);
    await writeFile(path.join(runsDir, 'DNR.json'), '{"not": "an array"}');
    assert.deepEqual(await readDnr(runsDir), []);
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});
