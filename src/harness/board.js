// runs/**/result.json -> board.md, sorted by Rung desc then Turns asc, with an
// expected-vs-produced note per model for the rung it fell at.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { scoreRuns, medianRun } from './score.js';

async function findResultFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await findResultFiles(full)));
    } else if (entry.isFile() && entry.name === 'result.json') {
      out.push(full);
    }
  }
  return out;
}

// collectResults(runsDir) -> RunResult[], read from every runs/**/result.json under it.
export async function collectResults(runsDir) {
  const files = await findResultFiles(runsDir);
  const results = [];
  for (const file of files) {
    try {
      results.push(JSON.parse(await readFile(file, 'utf8')));
    } catch {
      // a partial/corrupt result.json from a killed run; skip it rather than fail the board
    }
  }
  return results;
}

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function fellNote(run) {
  const failing = (run.submissions || []).find((s) => !s.pass);
  if (failing) {
    const expected = (failing.expectedHashes || []).join(', ');
    const produced = (failing.submittedHashes || []).join(', ');
    return `fell at rung ${failing.rung} -- expected [${expected}], produced [${produced}] (fidelity ${pct(failing.fidelity || 0)})`;
  }
  if (run.stoppedBecause === 'top') return 'cleared all 100 rungs';
  return `stopped (${run.stoppedBecause}) after clearing rung ${run.rung}`;
}

// renderBoard(RunResult[]) -> board.md text.
export function renderBoard(results) {
  const rows = scoreRuns(results).sort((a, b) => b.rung - a.rung || a.turns - b.turns);
  const byModel = new Map();
  for (const r of results) {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push(r);
  }

  const lines = ['# Bruno QUAERE board', ''];
  if (rows.length === 0) {
    lines.push('No runs yet.');
    return `${lines.join('\n')}\n`;
  }

  // Addendum D: Novel (what the budget is spent against) and Billed (what the provider actually
  // charges, cumulative resend included) side by side make the 87:1 resend ratio visible per run.
  lines.push('| Model | Rung | Turns | Fidelity | Trap | Novel | Billed | Trims | Wall ms |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const row of rows) {
    lines.push(
      `| ${row.model} | ${row.rung} | ${row.turns} | ${pct(row.fidelity)} | ${pct(row.trap)} | ${Math.round(row.novel)} | ${Math.round(row.billed)} | ${row.trims.toFixed(1)} | ${Math.round(row.wallMs)} |`,
    );
  }

  lines.push('', '## Expected vs produced at the fall rung', '');
  for (const row of rows) {
    const runs = byModel.get(row.model);
    const rep = medianRun(runs);
    lines.push(`- **${row.model}**: ${fellNote(rep)}`);
  }

  return `${lines.join('\n')}\n`;
}

// writeBoard(runsDir, outPath) -> board.md text, also written to outPath. Used by the calibration
// workflow (Addendum C) to publish a `## Round N` board after each round; the CLI's `board`
// subcommand prints to stdout instead so `quaere board runs/ > board.md` works as documented.
export async function writeBoard(runsDir, outPath) {
  const results = await collectResults(runsDir);
  const md = renderBoard(results);
  await writeFile(outPath, md, 'utf8');
  return md;
}
