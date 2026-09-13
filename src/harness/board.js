// runs/**/result.json -> board.md. Addendum G: rows are grouped by ladder version (never
// medianed across versions), one row per (model, driver, seed), the current ladder version's
// rows lead the document and every other version sits under a "Superseded" heading, and a
// runs/DNR.json the operator can hand-write feeds a "Did not run" list so a model that never
// produced a result.json still shows up on the board instead of vanishing silently.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { scoreRuns } from './score.js';
import { VERSION as CURRENT_LADDER_VERSION } from '../world.js';

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

// collectResults(runsDir) -> RunResult[], read from every runs/**/result.json under it. A file
// that fails to parse (a partial/corrupt result.json from a killed run) is skipped rather than
// failing the whole board; score.js separately skips a file that parsed fine but has no `model`.
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

// readDnr(runsDir) -> [{model, driver?, seed?, reason?}], from runs/DNR.json. This file is
// operator-written, not generated: when a model errored out before ever producing a result.json
// (Addendum G: "qwen never ran in round two ... every model in the lineup gets a row or an
// explicit 'did not run: <reason>' line; silence is not allowed"), the operator records it here
// so the board still names it. Missing or malformed -> no entries, never a board failure.
export async function readDnr(runsDir) {
  let raw;
  try {
    raw = JSON.parse(await readFile(path.join(runsDir, 'DNR.json'), 'utf8'));
  } catch {
    return [];
  }
  return Array.isArray(raw) ? raw.filter((e) => e && typeof e === 'object') : [];
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

function dnrLine(entry) {
  const label = [entry.model, entry.driver, entry.seed != null ? `seed ${entry.seed}` : null].filter(Boolean).join(' / ') || 'unknown';
  return `- **${label}**: did not run${entry.reason ? ` -- ${entry.reason}` : ''}`;
}

// Addendum J: Probes is appended AFTER Stop, not slotted next to Violations -- both
// test/board.test.js and test/harness-transcript.test.js assert an exact
// `| Model | ... | Violations | Resumes | Stop |` substring, and appending keeps that substring
// intact (the regex isn't end-anchored) instead of forcing every caller to touch those columns.
// Addendum K: Script (axios/* script-sandbox request count) is appended after Probes for the
// same reason -- it keeps the `... | Stop | Probes |` substring the Addendum J tests assert on.
const TABLE_HEADER =
  '| Model | Driver | Seed | Rung | Turns | Fidelity | Trap | Novel | Billed | Violations | Resumes | Stop | Probes | Script |';
const TABLE_RULE = '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';

// Addendum P: Suspended (gap time excluded from the wall check as "the machine slept") is
// appended after Script for the same reason Probes/Script were -- it keeps the Addendum J/K
// substring assertions intact -- and only when at least one row in the section actually has any,
// so an ordinary clean round's board doesn't grow a column of zeroes.
function tableHeader(showSuspended) {
  return showSuspended ? `${TABLE_HEADER} Suspended |` : TABLE_HEADER;
}
function tableRule(showSuspended) {
  return showSuspended ? `${TABLE_RULE}---|` : TABLE_RULE;
}

function rowLine(row, showSuspended) {
  const base = `| ${row.model} | ${row.driver} | ${row.seed} | ${row.rung} | ${row.turns} | ${pct(row.fidelity)} | ${pct(row.trap)} | ${Math.round(row.novel)} | ${Math.round(row.billed)} | ${row.violations.toFixed(1)} | ${row.resumes.toFixed(1)} | ${row.stop} | ${row.probes.toFixed(1)} | ${row.scriptRequests.toFixed(1)} |`;
  if (!showSuspended) return base;
  return `${base} ${(row.suspendedMs / 60_000).toFixed(1)}m |`;
}

// Addendum J: bru's OWN --sandbox developer scripts (a `.bru` `script:post-request` or similar
// that reaches for `require('http')`, `fetch`, or any other socket API instead of another `bru`
// invocation) send a non-bru User-Agent just like a stray curl would, and count as a violation
// here -- same signal, same column, not a false positive to special-case. A row's Violations
// count alone doesn't say which; the samples below are what let a human tell them apart.
function violationSampleLines(row) {
  const samples = (row.representative && row.representative.violationSamples) || [];
  const lines = [`- **${row.model}** (${row.driver}, seed ${row.seed}): ${row.violations.toFixed(1)} violation(s)`];
  if (samples.length === 0) {
    lines.push('  - no samples recorded (result.json predates violationSamples, or the API instance never returned any)');
    return lines;
  }
  for (const s of samples.slice(0, 20)) {
    lines.push(`  - ${s.method || '?'} ${s.path || '?'} (User-Agent: ${s.ua || 'unknown'})`);
  }
  return lines;
}

// One row per (model, driver, seed) already (score.js), sorted for a stable, readable board:
// best rung first, then fewest turns to get there, then alphabetically so ties don't shuffle
// between publishes.
function sortRows(rows) {
  return [...rows].sort(
    (a, b) => b.rung - a.rung || a.turns - b.turns || a.model.localeCompare(b.model) || String(a.seed).localeCompare(String(b.seed)),
  );
}

// groupRowsByVersion(rows) -> {current: {version, rows}|null, superseded: [{version, rows}]}.
// Addendum G's grouping on its own, so the markdown board and the JSON sibling below agree on
// which version leads and how the rest are ordered by construction rather than by two copies of
// the same sort drifting apart.
function groupRowsByVersion(rows) {
  const byVersion = new Map();
  for (const row of rows) {
    if (!byVersion.has(row.version)) byVersion.set(row.version, []);
    byVersion.get(row.version).push(row);
  }
  const currentRows = byVersion.get(CURRENT_LADDER_VERSION);
  return {
    current: currentRows ? { version: CURRENT_LADDER_VERSION, rows: currentRows } : null,
    superseded: [...byVersion.keys()]
      .filter((v) => v !== CURRENT_LADDER_VERSION)
      .sort()
      .map((version) => ({ version, rows: byVersion.get(version) })),
  };
}

function renderVersionSection(rows) {
  const showSuspended = rows.some((row) => row.suspendedMs > 0);
  const lines = [tableHeader(showSuspended), tableRule(showSuspended)];
  for (const row of sortRows(rows)) lines.push(rowLine(row, showSuspended));
  lines.push('', '#### Expected vs produced at the fall rung', '');
  for (const row of sortRows(rows)) {
    lines.push(`- **${row.model}** (${row.driver}, seed ${row.seed}): ${fellNote(row.representative)}`);
  }
  // Addendum J: "shows violation samples for any row with violations > 0" -- only rendered when
  // at least one row in this version has a nonzero count, so a clean round adds nothing here.
  const violatingRows = sortRows(rows).filter((row) => row.violations > 0);
  if (violatingRows.length > 0) {
    lines.push(
      '',
      '#### Violation samples',
      '',
      "Note: bru's own --sandbox developer scripts that call `require('http')` or similar produce " +
        'non-bru User-Agents too, and count here exactly like a stray curl or fetch would.',
      '',
    );
    for (const row of violatingRows) lines.push(...violationSampleLines(row));
  }
  return lines;
}

// renderBoard(RunResult[], {dnr?}) -> board.md text. `dnr` is the parsed contents of a
// runs/DNR.json (see readDnr); pass it explicitly so this stays the pure half and writeBoard
// stays the only place that touches the filesystem for it.
export function renderBoard(results, { dnr = [] } = {}) {
  const rows = scoreRuns(results);
  const lines = ['# Bruno QUAERE board', ''];

  if (rows.length === 0) {
    lines.push('No runs yet.');
  } else {
    const { current, superseded } = groupRowsByVersion(rows);

    if (current) {
      lines.push(`## Ladder version ${CURRENT_LADDER_VERSION} (current)`, '');
      lines.push(...renderVersionSection(current.rows));
    }

    if (superseded.length > 0) {
      lines.push('', '## Superseded', '');
      for (const section of superseded) {
        lines.push(`### Ladder version ${section.version}`, '');
        lines.push(...renderVersionSection(section.rows));
        lines.push('');
      }
    }
  }

  if (dnr.length > 0) {
    lines.push('', '## Did not run', '');
    for (const entry of dnr) lines.push(dnrLine(entry));
  }

  return `${lines.join('\n')}\n`;
}

// A board row as it goes out to a consumer that isn't board.js: `representative` is the whole
// RunResult medianRun picked (transcript and submission internals included, not something to
// publish) and `version` is already the key of the section the row sits in. Shallow-copied so the
// rows scoreRuns() returned are never mutated -- renderBoard reads the same objects.
function publicRow(row) {
  const { representative, version, ...rest } = row;
  return rest;
}

function versionEntry({ version, rows }, isCurrent) {
  return { version, current: isCurrent, rows: sortRows(rows).map(publicRow) };
}

// renderResultsData(RunResult[], {dnr?}) -> the same board as a plain JSON-serializable object,
// for anything that wants the numbers without parsing a markdown table. Pure, like renderBoard,
// and deliberately derived from the same groupRowsByVersion/sortRows: section order (current
// first, then superseded ascending) and row order match board.md exactly. No entry is emitted for
// a version with no rows, so an empty board is `versions: []`.
export function renderResultsData(results, { dnr = [] } = {}) {
  const { current, superseded } = groupRowsByVersion(scoreRuns(results));
  const versions = [];
  if (current) versions.push(versionEntry(current, true));
  for (const section of superseded) versions.push(versionEntry(section, false));
  return {
    generatedAt: new Date().toISOString(),
    currentVersion: CURRENT_LADDER_VERSION,
    versions,
    didNotRun: dnr,
  };
}

// writeBoard(runsDir, outPath) -> board.md text, also written to outPath. Used by the calibration
// workflow (Addendum C) to publish a `## Round N` board after each round; the CLI's `board`
// subcommand prints to stdout instead so `quaere board runs/ > board.md` works as documented.
// writeResultsData below is its JSON sibling, and the CLI reaches the same data through
// `quaere board runs/ --json results.json`, which writes the file and still prints the markdown.
export async function writeBoard(runsDir, outPath) {
  const [results, dnr] = await Promise.all([collectResults(runsDir), readDnr(runsDir)]);
  const md = renderBoard(results, { dnr });
  await writeFile(outPath, md, 'utf8');
  return md;
}

// writeResultsData(runsDir, outPath) -> the renderResultsData object, also written to outPath as
// pretty-printed JSON. Same shape of call as writeBoard, same runs/DNR.json folded in.
export async function writeResultsData(runsDir, outPath) {
  const [results, dnr] = await Promise.all([collectResults(runsDir), readDnr(runsDir)]);
  const data = renderResultsData(results, { dnr });
  await writeFile(outPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return data;
}
