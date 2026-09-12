// Addendum D: novel-token budget accounting, context trimming, and context-length-error
// recovery. Uses a scripted fake driver that reports synthetic `usage` and (for the
// context-length case) throws a provider-shaped error on cue -- no real model, no `bru`, no
// network beyond the in-process server pair climb() itself starts. Each test always calls the
// `ls` tool so the harness never trips its own "must call a tool" nudge.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { climb } from '../src/harness/run.js';

let nextPort = 48300;
function freshPorts() {
  const publicPort = nextPort;
  const adminPort = nextPort + 1;
  nextPort += 2;
  return { publicPort, adminPort };
}

// makeScriptedDriver(script) -> {driver, calls}. `script[i]` (or the last entry, once the script
// runs out) describes turn i+1: `usage` to report, or `throwMessage` to reject with instead of
// returning. Always answers with one `ls` tool call so run.js's turn loop keeps advancing without
// needing `bru` on PATH. `calls` records every `messages` array the driver was invoked with, so
// tests can inspect exactly what the harness sent (e.g. a trim note).
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
      return {
        assistant: step.assistant || '',
        toolCalls: [{ id: `t${i}`, name: 'ls', input: { path: '.' } }],
        usage: step.usage,
        stop: 'tool_use',
      };
    },
  };
  return { driver, calls };
}

async function withOutDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quaere-budget-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (a) resend is not charged: tokensNovel << tokensBilled when input_tokens mostly just re-sends
//     what was already paid for.
// ---------------------------------------------------------------------------

test('novel accounting: resending the transcript is not charged twice', async () => {
  await withOutDir(async (outDir) => {
    // Turn 1: nothing sent before, so the whole 1000-token input is novel.       novel = 1100
    // Turn 2: input grew by only 50 over (prevIn + prevOut) = 1100 -- the other  novel = 130
    //         100 tokens of the 1150 sent were the turn-1 conversation resent.
    // Turn 3: input grew by only 70 over (prevIn + prevOut) = 1230.              novel = 130
    const script = [
      { usage: { input_tokens: 1000, output_tokens: 100 } },
      { usage: { input_tokens: 1150, output_tokens: 80 } },
      { usage: { input_tokens: 1300, output_tokens: 60 } },
    ];
    const { driver } = makeScriptedDriver(script);

    const result = await climb({
      model: 'fake-budget-a',
      seed: 1,
      outDir,
      driver,
      maxTurns: 3,
      budgetTokens: 10_000_000, // high enough that only maxTurns ends the run
      ...freshPorts(),
    });

    assert.equal(result.tokensIn, 1000 + 1150 + 1300);
    assert.equal(result.tokensOut, 100 + 80 + 60);
    assert.equal(result.tokensBilled, result.tokensIn + result.tokensOut);
    assert.equal(result.tokensNovel, 1100 + 130 + 130);
    assert.ok(
      result.tokensNovel < result.tokensBilled,
      `resend must not be charged: novel ${result.tokensNovel} should be well under billed ${result.tokensBilled}`,
    );
  });
});

// ---------------------------------------------------------------------------
// (d) the budget stop fires on tokensNovel, not tokensBilled.
// ---------------------------------------------------------------------------

test('budget stop fires on tokensNovel crossing budgetTokens, not tokensBilled', async () => {
  await withOutDir(async (outDir) => {
    // Simulate a real climb's shape: turn 1 pays for a real base context (BASE); every turn after
    // that just resends the whole prior conversation (input_t = input_{t-1} + output_{t-1}) plus
    // a constant OUT tokens of genuinely new output. So novel_t = OUT for every turn but 1 (the
    // resend contributes nothing new), while billed keeps summing the ever-growing resent input.
    const BASE = 500;
    const OUT = 5;
    const script = [{ usage: { input_tokens: BASE, output_tokens: OUT } }];
    for (let i = 1; i < 12; i += 1) {
      const prev = script[i - 1].usage;
      script.push({ usage: { input_tokens: prev.input_tokens + prev.output_tokens, output_tokens: OUT } });
    }
    const { driver } = makeScriptedDriver(script);

    // Crosses exactly at turn 6: novel = BASE + 6*OUT = 500 + 30 = 530.
    const budgetTokens = BASE + 6 * OUT;
    const result = await climb({
      model: 'fake-budget-d',
      seed: 2,
      outDir,
      driver,
      maxTurns: 10, // comfortably past the expected turn-6 crossing
      budgetTokens,
      ...freshPorts(),
    });

    assert.equal(result.stoppedBecause, 'budget');
    assert.equal(result.turns, 6);
    assert.equal(result.tokensNovel, budgetTokens);
    // Proof the stop was not keyed on tokensBilled: by turn 6, cumulative billed (summing every
    // resent input) is already several times the budget, yet the run kept climbing turns instead
    // of stopping the moment billed alone crossed it (which happens turn 1 or 2).
    assert.ok(
      result.tokensBilled > budgetTokens * 3,
      `expected billed ${result.tokensBilled} to dwarf budget ${budgetTokens}, proving billed alone did not stop the run`,
    );
  });
});

// ---------------------------------------------------------------------------
// (b) proactive trimming fires once the estimated context exceeds --context-limit, and the note
//     is appended to what the driver is sent next.
// ---------------------------------------------------------------------------

test('context trimming fires at the limit and appends the trim note', async () => {
  await withOutDir(async (outDir) => {
    const contextLimit = 500; // tiny, so a handful of turns cross it
    // Filler on the assistant text so the ACTUAL message-array size (what trimToFraction measures)
    // is comfortably above the 60%-of-limit target once trimming fires -- independent of however
    // big the sandbox's own `ls` tool-result JSON happens to be.
    const filler = 'x'.repeat(1000);
    // Each turn's reported input_tokens grows past contextLimit; the NEXT turn's proactive check
    // (which uses the previous turn's reported input_tokens) must then trim before sending.
    const script = [
      { usage: { input_tokens: 100, output_tokens: 20 }, assistant: filler },
      { usage: { input_tokens: 300, output_tokens: 20 }, assistant: filler },
      { usage: { input_tokens: 700, output_tokens: 20 }, assistant: filler }, // now over contextLimit=500
      { usage: { input_tokens: 100, output_tokens: 20 }, assistant: filler }, // post-trim, small again
    ];
    const { driver, calls } = makeScriptedDriver(script);

    const result = await climb({
      model: 'fake-budget-b',
      seed: 3,
      outDir,
      driver,
      maxTurns: 4,
      budgetTokens: 10_000_000,
      contextLimit,
      ...freshPorts(),
    });

    assert.ok(result.trims >= 1, `expected at least one trim, got ${result.trims}`);
    const trimEvents = result.trims; // RunResult.trims is the count, per ARCHITECTURE.md
    assert.equal(typeof trimEvents, 'number');

    // The transcript.jsonl on disk logs the trim with the note text.
    const { readFile } = await import('node:fs/promises');
    const runDir = path.join(outDir, 'fake-budget-b', '3', '1');
    const transcript = (await readFile(path.join(runDir, 'transcript.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const trimEntry = transcript.find((t) => t.trim);
    assert.ok(trimEntry, 'expected a transcript entry logging the trim');
    assert.match(trimEntry.trim.note, /context trimmed/);
    assert.equal(trimEntry.trim.reason, 'proactive');

    // The very next call the driver received (same turn -- the trim happens before sending) must
    // include the trim note as a message. `calls` is 0-indexed by call order, turns are 1-indexed.
    const callAfterTrim = calls[trimEntry.turn - 1];
    assert.ok(callAfterTrim, 'expected a driver call after the trim');
    const hasNote = callAfterTrim.some((m) => typeof m.content === 'string' && /context trimmed/.test(m.content));
    assert.ok(hasNote, 'the trimmed note must be present in the next call to the driver');
  });
});

// ---------------------------------------------------------------------------
// (c) a simulated context-length error triggers a harder trim and exactly one retry.
// ---------------------------------------------------------------------------

test('a context-length error trims harder and retries once, then continues', async () => {
  await withOutDir(async (outDir) => {
    // Filler bulks up the ACTUAL message array (what trimToFraction measures) well past the
    // hard-trim target, independent of the sandbox's own tool-result JSON sizes.
    const filler = 'x'.repeat(3000);
    // contextLimit is well above the (small) provider-reported input_tokens below, so the
    // PROACTIVE check never fires -- only the thrown error forces a trim here. Its 40% target
    // (contextLimit * 0.4 * 4 = 1600 chars) is far under the ~6.5k chars two filled turns build up.
    const contextLimit = 1000;
    const script = [
      { usage: { input_tokens: 200, output_tokens: 20 }, assistant: filler },
      { usage: { input_tokens: 200, output_tokens: 20 }, assistant: filler },
      // Turn 3 (index 2): provider rejects with a context-length-shaped 400.
      { throwMessage: '400 context_length_exceeded: this model supports at most 128000 tokens' },
      // The retry after the harder trim (still logically "turn 3") succeeds.
      { usage: { input_tokens: 150, output_tokens: 20 } },
      { usage: { input_tokens: 150, output_tokens: 20 } },
    ];
    // Because the scripted driver advances its internal counter on every call including the
    // throw, a duplicate of the throwing entry isn't needed -- the retry call consumes script[3]
    // (the recovery usage) since `i` already moved past script[2] on the throw.
    const { driver } = makeScriptedDriver(script);

    const result = await climb({
      model: 'fake-budget-c',
      seed: 4,
      outDir,
      driver,
      maxTurns: 5,
      budgetTokens: 10_000_000,
      contextLimit,
      ...freshPorts(),
    });

    assert.notEqual(result.stoppedBecause, 'error');
    assert.equal(result.driverError, null);
    assert.ok(result.trims >= 1, 'the context-length error must have triggered a trim');

    const { readFile } = await import('node:fs/promises');
    const runDir = path.join(outDir, 'fake-budget-c', '4', '1');
    const transcript = (await readFile(path.join(runDir, 'transcript.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const trimEntry = transcript.find((t) => t.trim && t.trim.reason === 'context-length-error');
    assert.ok(trimEntry, 'expected a context-length-error trim logged in the transcript');
  });
});

test('a context-length error that persists after the one retry ends the run in error', async () => {
  await withOutDir(async (outDir) => {
    // Every call throws -- after the harder trim, the retry throws too, so the run must stop.
    const script = [{ throwMessage: '400 context_length_exceeded: too many tokens' }];
    const { driver } = makeScriptedDriver(script);

    const result = await climb({
      model: 'fake-budget-c2',
      seed: 5,
      outDir,
      driver,
      maxTurns: 5,
      budgetTokens: 10_000_000,
      contextLimit: 100_000,
      ...freshPorts(),
    });

    assert.equal(result.stoppedBecause, 'error');
    assert.match(result.driverError, /context_length_exceeded/);
    // Exactly one retry: the run stops on turn 1, it doesn't loop trimming forever.
    assert.equal(result.turns, 1);
  });
});
