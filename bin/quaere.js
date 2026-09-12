#!/usr/bin/env node
// quaere: serve, spec, skill, rung, reference, run, board. Minimal arg parsing, zero deps.

import { makeWorld } from '../src/world.js';
import { createServer } from '../src/api/server.js';
import { toOpenApi } from '../src/spec.js';
import { toSkill } from '../src/skill.js';
import { makeRung } from '../src/ladder/rung.js';
import { climb as referenceClimb, answerKey } from '../src/ladder/reference.js';
import { climb as harnessClimb } from '../src/harness/run.js';
import { climb as cliClimb } from '../src/harness/run-cli.js';
import { collectResults, readDnr, renderBoard } from '../src/harness/board.js';

// parseArgs(['--seed', '42', '--answer', 'runs/']) -> {seed:'42', answer:true, _:['runs/']}
export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function seedFrom(args) {
  return args.seed !== undefined ? Number(args.seed) : 1;
}

async function cmdServe(args) {
  const world = makeWorld(seedFrom(args));
  const server = createServer({
    world,
    publicPort: args.port !== undefined ? Number(args.port) : 8080,
    adminPort: args['admin-port'] !== undefined ? Number(args['admin-port']) : 8081,
  });
  const ports = await server.start();
  console.log(`quaere serving seed ${world.seed}`);
  console.log(`public  http://127.0.0.1:${ports.publicPort}`);
  console.log(`admin   http://127.0.0.1:${ports.adminPort} (loopback only)`);
  console.log(`api key ${world.auth.apiKey}`);
}

function cmdSpec(args) {
  const world = makeWorld(seedFrom(args));
  process.stdout.write(`${JSON.stringify(toOpenApi(world), null, 2)}\n`);
}

function cmdSkill(args) {
  const world = makeWorld(seedFrom(args));
  // --mode clean (default) prints the tight, honest document; --mode sloppy prints the
  // Addendum A version, where the same facts are buried in --bytes of plausible noise.
  const mode = args.mode !== undefined ? args.mode : 'clean';
  if (!KNOWN_SKILL_MODES.has(mode)) {
    throw new Error(`--mode must be one of clean|sloppy, got: ${mode}`);
  }
  const opts = { mode };
  if (args.bytes !== undefined) {
    const targetBytes = Number(args.bytes);
    if (!Number.isFinite(targetBytes) || targetBytes <= 0) {
      throw new Error(`--bytes must be a positive number, got: ${args.bytes}`);
    }
    opts.targetBytes = targetBytes;
  }
  process.stdout.write(`${toSkill(world, opts)}\n`);
}

function cmdRung(args) {
  const world = makeWorld(seedFrom(args));
  const n = args.n !== undefined ? Number(args.n) : 0;
  const rung = makeRung(world, n);
  if (args.answer) {
    process.stdout.write(
      `${JSON.stringify({ n: rung.n, text: rung.text, plan: rung.plan, expectedDescriptors: rung.expectedDescriptors }, null, 2)}\n`,
    );
  } else {
    console.log(`Rung ${rung.n}`);
    console.log(rung.text);
  }
}

async function cmdReference(args) {
  const world = makeWorld(seedFrom(args));
  const server = createServer({ world, publicPort: 0, adminPort: 0 });
  const ports = await server.start();
  try {
    await fetch(`http://127.0.0.1:${ports.adminPort}/admin/rungs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(answerKey(world)),
    });
    const from = args.from !== undefined ? Number(args.from) : 0;
    const to = args.to !== undefined ? Number(args.to) : 99;
    const result = await referenceClimb({
      world,
      baseUrl: `http://127.0.0.1:${ports.publicPort}`,
      apiKey: world.auth.apiKey,
      from,
      to,
    });
    console.log(`passed ${result.passed.length}/${to - from + 1}`);
    if (result.failed.length > 0) {
      console.log('failed:');
      for (const f of result.failed) console.log(`  rung ${f.n}: ${f.reason}`);
    }
    process.exitCode = result.failed.length > 0 ? 1 : 0;
  } finally {
    await server.stop();
  }
}

const KNOWN_DRIVERS = new Set(['anthropic', 'openai', 'openrouter', 'xai', 'deepseek', 'google', 'cli']);
const KNOWN_SKILL_MODES = new Set(['clean', 'sloppy']);
// Addendum F: "Wall cap --wall-ms default 3 h." Applies to every driver, not just `cli` -- an
// operator who forgets the flag on a real run gets a run that eventually stops and still writes
// result.json, rather than one an outer `timeout` can kill mid-write.
const DEFAULT_WALL_MS = 10_800_000;

async function cmdRun(args) {
  const driverName = args.driver || 'anthropic';
  if (!KNOWN_DRIVERS.has(driverName)) {
    throw new Error(`--driver must be one of anthropic|openai|openrouter|xai|deepseek|google|cli, got: ${driverName}`);
  }
  const skillMode = args['skill-mode'] !== undefined ? args['skill-mode'] : 'sloppy';
  if (!KNOWN_SKILL_MODES.has(skillMode)) {
    throw new Error(`--skill-mode must be one of clean|sloppy, got: ${skillMode}`);
  }
  const wallMsLimit = args['wall-ms'] !== undefined ? Number(args['wall-ms']) : DEFAULT_WALL_MS;
  const attempts = args.attempts !== undefined ? Number(args.attempts) : 1;
  const results = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let result;
    if (driverName === 'cli') {
      // Addendum F: native CLI drivers (--cli ai|codex|qwen|gemini|kimi) run the model through its
      // own agent CLI as a subprocess, rather than a tool-calling loop this process drives itself.
      if (!args.cli) {
        throw new Error('--driver cli requires --cli <name> (e.g. ai|codex|qwen|gemini|kimi)');
      }
      // eslint-disable-next-line no-await-in-loop
      result = await cliClimb({
        cliName: args.cli,
        model: args.model,
        seed: seedFrom(args),
        attempt,
        budgetTokens: args.budget !== undefined ? Number(args.budget) : undefined,
        wallMsLimit,
        outDir: args.out || 'runs',
        skillMode,
        skillBytes: args['skill-bytes'] !== undefined ? Number(args['skill-bytes']) : undefined,
        // --max-rung N caps the climb: clearing rung N stops it as 'top' instead of climbing to 99.
        topRung: args['max-rung'] !== undefined ? Number(args['max-rung']) : undefined,
      });
    } else {
      // eslint-disable-next-line no-await-in-loop
      result = await harnessClimb({
        driverName,
        model: args.model,
        seed: seedFrom(args),
        attempt,
        budgetTokens: args.budget !== undefined ? Number(args.budget) : undefined,
        // Addendum D: proactive context-trim threshold (tokens); defaults to climb()'s own 160000.
        contextLimit: args['context-limit'] !== undefined ? Number(args['context-limit']) : undefined,
        maxTurns: args['max-turns'] !== undefined ? Number(args['max-turns']) : undefined,
        // --wall-ms caps a climb by wall clock so an operator-imposed timeout still produces a
        // result.json; without it an outer `timeout` kills the process mid-turn and the run is lost.
        wallMsLimit,
        outDir: args.out || 'runs',
        // Addendum A: the skill the agent gets is sloppy (5 MB, buried facts) by default for a real
        // run; --skill-mode clean and/or a smaller --skill-bytes are for debugging the harness itself.
        skillMode,
        skillBytes: args['skill-bytes'] !== undefined ? Number(args['skill-bytes']) : undefined,
        topRung: args['max-rung'] !== undefined ? Number(args['max-rung']) : undefined,
      });
    }
    results.push(result);
    console.log(JSON.stringify(result));
  }
  return results;
}

async function cmdBoard(args) {
  const dir = args._[0] || 'runs';
  // readDnr reads an operator-written runs/DNR.json (missing/malformed -> []), so a model that
  // errored out before ever producing a result.json still gets a "did not run" line instead of
  // silently vanishing from the board.
  const [results, dnr] = await Promise.all([collectResults(dir), readDnr(dir)]);
  process.stdout.write(renderBoard(results, { dnr }));
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);

  const commands = {
    serve: cmdServe,
    spec: cmdSpec,
    skill: cmdSkill,
    rung: cmdRung,
    reference: cmdReference,
    run: cmdRun,
    board: cmdBoard,
  };

  const handler = commands[cmd];
  if (!handler) {
    console.error('usage: quaere <serve|spec|skill|rung|reference|run|board> [options]');
    process.exitCode = 1;
    return;
  }
  await handler(args);
}

// Only run when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  });
}
