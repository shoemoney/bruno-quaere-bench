#!/usr/bin/env node
// Summarise one round from runs/: every result.json whose seed lies in [from, to], one row per
// model, plus the calibration predicate the steepening loop is driven by (max rung, median rung,
// distinct fall rungs, and whether any row used a per-token driver). Reads only; zero deps.
//
//   node scripts/round-summary.js <from-seed> <to-seed> [runsDir] [--json]

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const positional = argv.filter((a) => !a.startsWith('--'));
const from = Number(positional[0]);
const to = Number(positional[1]);
const runsDir = positional[2] || 'runs';
if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) {
  console.error('usage: node scripts/round-summary.js <from-seed> <to-seed> [runsDir] [--json]');
  process.exit(1);
}

const PAID_DRIVERS = new Set(['openrouter', 'xai', 'deepseek', 'google', 'openai', 'anthropic']);

function* resultFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* resultFiles(full);
    else if (entry.name === 'result.json') yield full;
  }
}

const rows = [];
for (const file of resultFiles(runsDir)) {
  let r;
  try { r = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
  const seed = Number(r.seed);
  if (!Number.isInteger(seed) || seed < from || seed > to) continue;
  rows.push({
    model: r.model,
    driver: r.driver,
    seed,
    version: r.version,
    rung: r.rung,
    stop: r.stoppedBecause,
    turns: r.turns,
    wallMin: Math.round((r.wallMs || 0) / 60000),
    novelTokens: r.tokensNovel,
    codeWrites: r.codeWrites,
    docReads: r.docReads,
    file,
  });
}
rows.sort((a, b) => b.rung - a.rung || a.model.localeCompare(b.model));

const rungs = rows.map((r) => r.rung).sort((a, b) => a - b);
const median = rungs.length === 0 ? null
  : rungs.length % 2 ? rungs[(rungs.length - 1) / 2]
  : (rungs[rungs.length / 2 - 1] + rungs[rungs.length / 2]) / 2;
const paid = rows.filter((r) => PAID_DRIVERS.has(String(r.driver).split(':')[0]));
const versions = [...new Set(rows.map((r) => r.version))];
const predicate = {
  rows: rows.length,
  versions,
  max: rungs.length ? rungs[rungs.length - 1] : null,
  median,
  distinctFallRungs: new Set(rungs).size,
  paidDrivers: paid.map((r) => `${r.model}(${r.driver})`),
  inBand: rows.length > 0 && rungs[rungs.length - 1] <= 40 && median >= 20 && median <= 40
    && new Set(rungs).size >= 3 && paid.length === 0 && versions.length === 1,
};

if (json) {
  console.log(JSON.stringify({ rows, predicate }, null, 2));
} else {
  console.log(`| Model | Driver | Seed | Ver | Rung | Stop | Turns | Wall min | Novel tok | codeWrites | docReads |`);
  console.log(`|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of rows) {
    console.log(`| ${r.model} | ${r.driver} | ${r.seed} | ${r.version} | ${r.rung} | ${r.stop} | ${r.turns} | ${r.wallMin} | ${r.novelTokens ?? ''} | ${r.codeWrites ?? ''} | ${r.docReads ?? ''} |`);
  }
  console.log('');
  console.log(`rows=${predicate.rows} versions=${versions.join(',')} max=${predicate.max} median=${predicate.median} distinctFallRungs=${predicate.distinctFallRungs} paidDrivers=${predicate.paidDrivers.length} inBand=${predicate.inBand}`);
}
