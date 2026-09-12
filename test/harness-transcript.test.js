// harness/run.js: transcript tool results (Addendum E), the 'degenerate' stop reason, the
// Addendum E context-trim thresholds (90% proactive / 85%+generic-4xx reclassification), the
// xai/deepseek openai-compatible driver presets, and the RunResult fields Addendum F adds
// (violations, resumes, modelVersion, modelMismatch, usageEstimated). Also covers score.js/board.js
// (also owned here) rendering the Driver/Violations/Resumes/Stop columns.
//
// All climb() tests use a scripted fake driver -- no real model, no network beyond the in-process
// server pair climb() itself starts -- and stick to `ls`/`write_file`/`read_file` tool calls so
// they never need `bru` on PATH for the *tool call itself* (constructing the sandbox still
// symlinks a real bru, same as every other harness test in this repo).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { climb, resolveDriver } from '../src/harness/run.js';
import { scoreRuns } from '../src/harness/score.js';
import { renderBoard } from '../src/harness/board.js';

let nextPort = 49300;
function freshPorts() {
  const publicPort = nextPort;
  const adminPort = nextPort + 1;
  nextPort += 2;
  return { publicPort, adminPort };
}

// makeScriptedDriver(script) -> {driver, calls}. `script[i]` (or the last entry, once the script
// runs out) describes turn i+1: `usage`, `toolCalls` (default one `ls` call so run.js's turn loop
// keeps advancing), `stop`, `assistant`, or `throwMessage` to reject with instead of returning.
// `calls` records every `messages` array sent, so tests can inspect exactly what went out.
function makeScriptedDriver(script) {
  const calls = [];
  let i = 0;
  const driver = {
    async step(messages) {
      calls.push(messages);
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      if (step.throwMessage) {
        throw new Error(step.throwMessage);
      }
      const toolCalls = 'toolCalls' in step ? step.toolCalls : [{ id: `t${i}`, name: 'ls', input: { path: '.' } }];
      return {
        assistant: step.assistant || '',
        toolCalls,
        usage: step.usage,
        stop: step.stop || (toolCalls.length ? 'tool_use' : 'end_turn'),
      };
    },
  };
  return { driver, calls };
}

async function withOutDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quaere-transcript-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readTranscript(outDir, model, seed, attempt = 1) {
  const runDir = path.join(outDir, model, String(seed), String(attempt));
  const text = await readFile(path.join(runDir, 'transcript.jsonl'), 'utf8');
  return text
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// toolResults on the transcript
// ---------------------------------------------------------------------------

test('transcript.jsonl records toolResults per turn: id, name, ms, and output truncated to 4 KB', async () => {
  await withOutDir(async (outDir) => {
    const bigContent = 'A'.repeat(10_000); // one line, well past the 4 KB cap once JSON-quoted
    const script = [
      { usage: { input_tokens: 100, output_tokens: 10 }, toolCalls: [{ id: 'w1', name: 'write_file', input: { path: 'big.txt', content: bigContent } }] },
      { usage: { input_tokens: 100, output_tokens: 10 }, toolCalls: [{ id: 'r1', name: 'read_file', input: { path: 'big.txt' } }] },
      // A third turn so the SECOND turn's tool result (from read_file) has actually gone out as a
      // driver call by the time we inspect `calls` -- run.js appends a turn's tool-result messages
      // to `messages` for the NEXT call, not the one that produced them.
      { usage: { input_tokens: 100, output_tokens: 10 }, toolCalls: [{ id: 'l1', name: 'ls', input: { path: '.' } }] },
    ];
    const { driver, calls } = makeScriptedDriver(script);

    await climb({
      model: 'fake-transcript-a',
      seed: 1,
      outDir,
      driver,
      maxTurns: 3,
      budgetTokens: 10_000_000,
      ...freshPorts(),
    });

    const transcript = await readTranscript(outDir, 'fake-transcript-a', 1);
    assert.equal(transcript.length, 3);

    const [turn1, turn2] = transcript;
    assert.ok(Array.isArray(turn1.toolResults), 'turn 1 must carry toolResults');
    assert.equal(turn1.toolResults.length, 1);
    assert.equal(turn1.toolResults[0].id, 'w1');
    assert.equal(turn1.toolResults[0].name, 'write_file');
    assert.equal(typeof turn1.toolResults[0].ms, 'number');
    assert.ok(turn1.toolResults[0].ms >= 0);

    const readResult = turn2.toolResults[0];
    assert.equal(readResult.id, 'r1');
    assert.equal(readResult.name, 'read_file');
    // The transcript record is capped at 4 KB...
    assert.ok(
      Buffer.byteLength(readResult.output, 'utf8') <= 4096 + 32,
      `expected output capped near 4 KB, got ${Buffer.byteLength(readResult.output, 'utf8')} bytes`,
    );
    assert.match(readResult.output, /truncated/);

    // ...but what actually gets SENT to the driver as the tool result message is the full,
    // untruncated content -- truncation is a transcript-size concern only, never a capability cut.
    // calls[2] is the THIRD driver.step() invocation (turn 3) -- the first call whose `messages`
    // include turn 2's read_file tool result.
    assert.equal(calls.length, 3);
    const sentToolMessage = calls[2].find((m) => m.role === 'tool' && m.toolCallId === 'r1');
    assert.ok(sentToolMessage, 'expected the read_file tool result to have been sent to the driver');
    assert.ok(
      sentToolMessage.content.length > 4096,
      'the message actually sent to the model must not be truncated, only the transcript record',
    );
  });
});

// ---------------------------------------------------------------------------
// 'degenerate' stop reason
// ---------------------------------------------------------------------------

test("degenerate stop reason: two consecutive no-tool-call turns with stop === 'length' end the run", async () => {
  await withOutDir(async (outDir) => {
    const script = [
      { usage: { input_tokens: 50, output_tokens: 50 }, toolCalls: [{ id: 't1', name: 'ls', input: { path: '.' } }] },
      { usage: { input_tokens: 50, output_tokens: 50 }, toolCalls: [], stop: 'length' },
      { usage: { input_tokens: 50, output_tokens: 50 }, toolCalls: [], stop: 'length' },
      // Never reached -- the run must stop after exactly 2 consecutive degenerate turns.
      { usage: { input_tokens: 50, output_tokens: 50 }, toolCalls: [{ id: 't4', name: 'ls', input: { path: '.' } }] },
    ];
    const { driver } = makeScriptedDriver(script);

    const result = await climb({
      model: 'fake-degenerate-a',
      seed: 2,
      outDir,
      driver,
      maxTurns: 10,
      budgetTokens: 10_000_000,
      ...freshPorts(),
    });

    assert.equal(result.stoppedBecause, 'degenerate');
    assert.equal(result.turns, 3, 'turn 1 (tool call) + 2 degenerate turns before stopping');
  });
});

test("a no-tool-call streak with stop !== 'length' is NOT degenerate (falls back to the 3-turn error rule)", async () => {
  await withOutDir(async (outDir) => {
    const script = [
      { usage: { input_tokens: 50, output_tokens: 50 }, toolCalls: [], stop: 'end_turn' },
      { usage: { input_tokens: 50, output_tokens: 50 }, toolCalls: [], stop: 'end_turn' },
      { usage: { input_tokens: 50, output_tokens: 50 }, toolCalls: [], stop: 'end_turn' },
    ];
    const { driver } = makeScriptedDriver(script);

    const result = await climb({
      model: 'fake-degenerate-b',
      seed: 3,
      outDir,
      driver,
      maxTurns: 10,
      budgetTokens: 10_000_000,
      ...freshPorts(),
    });

    assert.equal(result.stoppedBecause, 'error');
    assert.equal(result.turns, 3, 'the generic noToolStreak rule (3 turns), not degenerate (2)');
  });
});

test("a tool call between two stop:'length' turns resets the degenerate streak", async () => {
  await withOutDir(async (outDir) => {
    const script = [
      { usage: { input_tokens: 50, output_tokens: 50 }, toolCalls: [], stop: 'length' },
      { usage: { input_tokens: 50, output_tokens: 50 }, toolCalls: [{ id: 't2', name: 'ls', input: { path: '.' } }] },
      { usage: { input_tokens: 50, output_tokens: 50 }, toolCalls: [], stop: 'length' },
      { usage: { input_tokens: 50, output_tokens: 50 }, toolCalls: [], stop: 'length' },
    ];
    const { driver } = makeScriptedDriver(script);

    const result = await climb({
      model: 'fake-degenerate-c',
      seed: 4,
      outDir,
      driver,
      maxTurns: 10,
      budgetTokens: 10_000_000,
      ...freshPorts(),
    });

    assert.equal(result.stoppedBecause, 'degenerate');
    assert.equal(result.turns, 4, 'streak must restart after the intervening tool call at turn 2');
  });
});

// ---------------------------------------------------------------------------
// Addendum E context rules
// ---------------------------------------------------------------------------

test('proactive trim fires at 90% of --context-limit, before the estimate actually exceeds it', async () => {
  await withOutDir(async (outDir) => {
    const contextLimit = 1000;
    const filler = 'x'.repeat(3000); // bulks up the real message array so trimToFraction has work to do
    const script = [
      // 920 tokens is 92% of 1000 -- ABOVE the limit is 1000+, so the OLD (>contextLimit) rule
      // would never have trimmed here; the new (>=90%) rule must.
      { usage: { input_tokens: 920, output_tokens: 20 }, assistant: filler },
      { usage: { input_tokens: 100, output_tokens: 20 } },
    ];
    const { driver } = makeScriptedDriver(script);

    const result = await climb({
      model: 'fake-trim-90',
      seed: 5,
      outDir,
      driver,
      maxTurns: 2,
      budgetTokens: 10_000_000,
      contextLimit,
      ...freshPorts(),
    });

    assert.ok(result.trims >= 1, `expected a proactive trim at 92% of the limit, got ${result.trims}`);
    const transcript = await readTranscript(outDir, 'fake-trim-90', 5);
    const trimEntry = transcript.find((t) => t.trim && t.trim.reason === 'proactive');
    assert.ok(trimEntry, 'expected a proactive trim logged in the transcript');
    assert.equal(trimEntry.turn, 2, 'the trim happens before turn 2 is sent, using turn 1s reported input_tokens');
  });
});

test('a generic 400 is reclassified as context-length only when the call was made at >= 85% of the limit', async () => {
  await withOutDir(async (outDir) => {
    const contextLimit = 1000;
    const filler = 'x'.repeat(3000);
    // 860 tokens is 86% of 1000: at/above the 85% reclassification floor, but below the 90%
    // proactive-trim floor, so the ONLY trim in this run comes from the error-recovery path.
    const script = [
      { usage: { input_tokens: 860, output_tokens: 20 }, assistant: filler },
      { throwMessage: '400: Provider returned error' }, // deliberately does NOT match the message-shaped regex
      { usage: { input_tokens: 150, output_tokens: 20 } },
    ];
    const { driver } = makeScriptedDriver(script);

    const result = await climb({
      model: 'fake-generic-400-high',
      seed: 6,
      outDir,
      driver,
      maxTurns: 5,
      budgetTokens: 10_000_000,
      contextLimit,
      ...freshPorts(),
    });

    assert.notEqual(result.stoppedBecause, 'error', 'a 400 at 86% of the limit must be treated as recoverable context-length');
    assert.equal(result.driverError, null);
    const transcript = await readTranscript(outDir, 'fake-generic-400-high', 6);
    const trimEntry = transcript.find((t) => t.trim && t.trim.reason === 'context-length-error');
    assert.ok(trimEntry, 'expected the generic 400 to trigger a context-length-error trim');
  });
});

test('a generic 400 made well under 85% of the limit is a real error, not silently retried', async () => {
  await withOutDir(async (outDir) => {
    const contextLimit = 1000;
    // 800 tokens is 80% -- under the 85% floor, so this 400 is NOT context-length; it must fall
    // straight through to stoppedBecause: 'error' rather than trim-and-retry into it forever.
    const script = [
      { usage: { input_tokens: 800, output_tokens: 20 } },
      { throwMessage: '400: Provider returned error' },
    ];
    const { driver } = makeScriptedDriver(script);

    const result = await climb({
      model: 'fake-generic-400-low',
      seed: 7,
      outDir,
      driver,
      maxTurns: 5,
      budgetTokens: 10_000_000,
      contextLimit,
      ...freshPorts(),
    });

    assert.equal(result.stoppedBecause, 'error');
    assert.match(result.driverError, /Provider returned error/);
    assert.equal(result.trims, 0, 'a genuine 400 below the 85% floor must not be treated as context-length');
  });
});

// ---------------------------------------------------------------------------
// generic openai-compatible provider presets: --driver xai, --driver deepseek
// ---------------------------------------------------------------------------

async function withStubbedFetch(fakeResponseBody, fn) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, opts });
    return { ok: true, json: async () => fakeResponseBody };
  };
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = original;
  }
}

const FAKE_CHAT_RESPONSE = {
  choices: [{ message: { content: 'hi', tool_calls: [] }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

test('resolveDriver: --driver xai reuses the openai driver against api.x.ai with XAI_API_KEY', async () => {
  const originalKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'test-xai-key';
  try {
    await withStubbedFetch(FAKE_CHAT_RESPONSE, async (seen) => {
      const driver = resolveDriver('xai', { model: 'grok-4.6', systemPrompt: 'sys' });
      await driver.step([{ role: 'user', content: 'hello' }], []);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, 'https://api.x.ai/v1/chat/completions');
      assert.equal(seen[0].opts.headers.authorization, 'Bearer test-xai-key');
    });
  } finally {
    if (originalKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = originalKey;
  }
});

test('resolveDriver: --driver deepseek reuses the openai driver against api.deepseek.com with DEEPSEEK_API_KEY', async () => {
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
  try {
    await withStubbedFetch(FAKE_CHAT_RESPONSE, async (seen) => {
      const driver = resolveDriver('deepseek', { model: 'deepseek-v4.1-flash', systemPrompt: 'sys' });
      await driver.step([{ role: 'user', content: 'hello' }], []);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, 'https://api.deepseek.com/chat/completions');
      assert.equal(seen[0].opts.headers.authorization, 'Bearer test-deepseek-key');
    });
  } finally {
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  }
});

test('resolveDriver: an unknown driver name still throws', () => {
  assert.throws(() => resolveDriver('not-a-real-driver', { model: 'x', systemPrompt: 'x' }), /unknown driver/);
});

// ---------------------------------------------------------------------------
// RunResult gains: driver, violations, resumes, modelMismatch, usageEstimated
// ---------------------------------------------------------------------------

test('RunResult carries driver, violations, resumes, modelMismatch, usageEstimated for the message-loop path', async () => {
  await withOutDir(async (outDir) => {
    const script = [{ usage: { input_tokens: 50, output_tokens: 50 } }];
    const { driver } = makeScriptedDriver(script);

    const result = await climb({
      driverName: 'openrouter',
      model: 'fake-model-x',
      seed: 8,
      outDir,
      driver, // pre-built driver skips resolveDriver, but driverName is still recorded on the result
      maxTurns: 1,
      budgetTokens: 10_000_000,
      ...freshPorts(),
    });

    assert.equal(result.driver, 'openrouter');
    // No admin/violations endpoint activity happened (the fake driver never touches the network
    // except through the sandboxed `bru`, which this script never calls) -- reading it back must
    // not throw even if the endpoint isn't implemented on some older server, and must default 0.
    assert.equal(typeof result.violations, 'number');
    assert.equal(result.violations, 0);
    // The message-loop path never resumes a killed session and never estimates usage -- those are
    // CLI-driver-only concerns (Addendum F) -- so they are fixed, honest defaults here.
    assert.equal(result.resumes, 0);
    assert.equal(result.modelMismatch, false);
    assert.equal(result.usageEstimated, false);
    assert.equal(result.modelVersion, 'fake-model-x');

    const runDir = path.join(outDir, 'fake-model-x', '8', '1');
    const onDisk = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8'));
    assert.equal(onDisk.driver, 'openrouter');
    assert.equal(onDisk.violations, 0);
    assert.equal(onDisk.resumes, 0);
  });
});

// ---------------------------------------------------------------------------
// score.js / board.js: Driver, Violations, Resumes, Stop columns
// ---------------------------------------------------------------------------

function fixtureResult(overrides) {
  return {
    model: 'model-a',
    driver: 'anthropic',
    modelVersion: 'model-a',
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

test('scoreModel: violations and resumes default to 0 and average across attempts', () => {
  const runs = [fixtureResult({ violations: 2, resumes: 1 }), fixtureResult({ violations: 0, resumes: 0 })];
  const [row] = scoreRuns(runs);
  assert.equal(row.driver, 'anthropic');
  assert.equal(row.violations, 1);
  assert.equal(row.resumes, 0.5);
  assert.equal(row.stop, 'fail');
});

test('scoreModel: older result.json files with no driver/violations/resumes fields degrade gracefully', () => {
  const legacy = fixtureResult({});
  delete legacy.driver;
  delete legacy.violations;
  delete legacy.resumes;
  const [row] = scoreRuns([legacy]);
  assert.equal(row.driver, 'model-a', 'falls back to the model name when no driver was recorded');
  assert.equal(row.violations, 0);
  assert.equal(row.resumes, 0);
});

test('board.md renders the Model/Driver/Seed/.../Violations/Resumes/Stop columns', () => {
  const md = renderBoard([fixtureResult({ model: 'model-a', driver: 'anthropic', violations: 1, resumes: 2, stoppedBecause: 'budget' })]);
  assert.match(md, /\| Model \| Driver \| Seed \| Rung \| Turns \| Fidelity \| Trap \| Novel \| Billed \| Violations \| Resumes \| Stop \|/);
  assert.match(md, /\| model-a \| anthropic \| 1 \| 10 \| 20 \| 100\.0% \| 100\.0% \| 150 \| 150 \| 1\.0 \| 2\.0 \| budget \|/);
});
