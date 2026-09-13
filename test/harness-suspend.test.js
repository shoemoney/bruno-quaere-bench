// Addendum P: "the machine slept." run.js's message-loop climb() ticks once per turn; a gap
// between two consecutive ticks over 5 minutes is assumed to be a sleep/suspend rather than the
// model thinking, and is excluded from the wall-ms comparison via `suspendedMs`. These tests
// inject a fake `now()` so a multi-hour gap can be simulated without the test actually waiting for
// it -- see run-cli.test.js and supervise.test.js for the CLI-path equivalents.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { climb } from '../src/harness/run.js';

let nextPort = 49960;
function freshPorts() {
  const publicPort = nextPort;
  const adminPort = nextPort + 1;
  nextPort += 2;
  return { publicPort, adminPort };
}

async function withOutDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quaere-suspend-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// makeClock(): a fake `now()` that advances 1 second of "active" time on every call (never a gap
// over SUSPEND_GAP_MS on its own) plus a `.jump(ms)` a test can call between turns to simulate a
// sleep -- attached directly to the function, since `now` itself must stay callable as `now()`.
function makeClock() {
  let clock = 0;
  const now = () => {
    clock += 1000;
    return clock;
  };
  now.jump = (ms) => {
    clock += ms;
  };
  return now;
}

// A scripted driver that always calls the `ls` tool (never needs `bru` on PATH) and, on its
// `jumpAtStep`-th call, jumps the shared clock BEFORE returning -- landing the gap between that
// turn and the next one, exactly where run.js's tick() looks for it.
function makeSleepyDriver(now, { jumpAtStep = -1, jumpMs = 0 } = {}) {
  let i = 0;
  return {
    async step() {
      const s = i;
      i += 1;
      if (s === jumpAtStep) now.jump(jumpMs);
      return {
        assistant: '',
        toolCalls: [{ id: `t${s}`, name: 'ls', input: { path: '.' } }],
        usage: { input_tokens: 50, output_tokens: 50 },
        stop: 'tool_use',
      };
    },
  };
}

test('climb(): a 6-hour gap between turns does not end a run whose active time is under the wall (Addendum P)', async () => {
  await withOutDir(async (outDir) => {
    const now = makeClock();
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    const driver = makeSleepyDriver(now, { jumpAtStep: 2, jumpMs: SIX_HOURS_MS });
    const result = await climb({
      driver,
      model: 'fake-sleepy',
      seed: 1,
      outDir,
      maxTurns: 5,
      // 60s of ACTIVE wall budget -- a single unexcluded 6h gap would blow straight through this.
      wallMsLimit: 60_000,
      now,
      ...freshPorts(),
    });
    assert.equal(result.stoppedBecause, 'budget', 'ran to maxTurns rather than being cut by the wall');
    assert.equal(result.turns, 5);
    assert.ok(
      result.suspendedMs >= SIX_HOURS_MS,
      `expected suspendedMs to include the 6h gap, got ${result.suspendedMs}`,
    );
  });
});

test('climb(): via the same fake clock, active time (no sleep) over the wall still ends the run as "time" (Addendum P)', async () => {
  await withOutDir(async (outDir) => {
    const now = makeClock();
    const driver = makeSleepyDriver(now); // never jumps -- every gap is well under 5 minutes
    const result = await climb({
      driver,
      model: 'fake-active',
      seed: 1,
      outDir,
      maxTurns: 5,
      wallMsLimit: 5_000,
      now,
      ...freshPorts(),
    });
    assert.equal(result.stoppedBecause, 'time');
    assert.ok(result.turns < 5, 'the wall must cut the climb before it reaches maxTurns');
    assert.equal(result.suspendedMs, 0);
  });
});
