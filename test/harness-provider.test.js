// harness/run.js: Addendum H -- the `google` driver preset (openai driver against Google's
// OpenAI-compatible endpoint, GEMINI_API_KEY), the openrouter preset still resolving arbitrary
// model ids like x-ai/grok-4.6, and 401/403 mid-climb classification: exactly one retry after a
// fixed delay, then stoppedBecause 'provider' (never 'error', never 'fail') with the status
// folded into driverError.
//
// All climb() tests use a scripted fake driver -- no real model, no network beyond the in-process
// server pair climb() itself starts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { climb, resolveDriver } from '../src/harness/run.js';

let nextPort = 49500;
function freshPorts() {
  const publicPort = nextPort;
  const adminPort = nextPort + 1;
  nextPort += 2;
  return { publicPort, adminPort };
}

// makeScriptedDriver(script) -> {driver, calls}. `script[i]` (or the last entry, once the script
// runs out) describes turn i+1: `usage`, `toolCalls` (default one `ls` call so run.js's turn loop
// keeps advancing), `stop`, `assistant`, or `throwMessage` to reject with instead of returning.
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
        usage: step.usage || { input_tokens: 50, output_tokens: 50 },
        stop: step.stop || (toolCalls.length ? 'tool_use' : 'end_turn'),
      };
    },
  };
  return { driver, calls };
}

async function withOutDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quaere-provider-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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

// ---------------------------------------------------------------------------
// Addendum H: --driver google
// ---------------------------------------------------------------------------

test('resolveDriver: --driver google hits the Gemini OpenAI-compat endpoint with GEMINI_API_KEY', async () => {
  const originalKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  try {
    await withStubbedFetch(FAKE_CHAT_RESPONSE, async (seen) => {
      const driver = resolveDriver('google', { model: 'gemini-3.8-flash', systemPrompt: 'sys' });
      await driver.step([{ role: 'user', content: 'hello' }], []);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
      assert.equal(seen[0].opts.headers.authorization, 'Bearer test-gemini-key');
      const body = JSON.parse(seen[0].opts.body);
      assert.equal(body.model, 'gemini-3.8-flash');
    });
  } finally {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  }
});

// Verified live against https://generativelanguage.googleapis.com/v1beta/openai on 2026-09-12:
// every tool_call in a Gemini 3 response carries extra_content.google.thought_signature, and a
// follow-up turn that replays the tool call without echoing it back 400s with INVALID_ARGUMENT
// ("Function call is missing a thought_signature..."). This is why --driver google is its own
// drivers/google.js rather than a createOpenAiDriver preset like xai/deepseek.
test('the google driver round-trips extra_content.google.thought_signature on a tool call across turns', async () => {
  const originalKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  try {
    const sig = 'fake-thought-signature-abc123';
    const firstResponse = {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'ls', arguments: '{"path":"."}' },
                extra_content: { google: { thought_signature: sig } },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    let call = 0;
    const seen = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      seen.push(opts);
      call += 1;
      return { ok: true, json: async () => (call === 1 ? firstResponse : FAKE_CHAT_RESPONSE) };
    };
    try {
      const driver = resolveDriver('google', { model: 'gemini-3.8-flash', systemPrompt: 'sys' });
      const step1 = await driver.step([{ role: 'user', content: 'call ls' }], []);
      assert.equal(step1.toolCalls.length, 1);
      assert.deepEqual(step1.toolCalls[0].providerMeta, { google: { thought_signature: sig } });

      // Exactly what run.js's turn loop does after a tool call: append the assistant message
      // (toolCalls carried through unmodified, providerMeta included) and the tool result.
      const messages = [
        { role: 'user', content: 'call ls' },
        { role: 'assistant', content: step1.assistant, toolCalls: step1.toolCalls },
        { role: 'tool', toolCallId: 'call_1', content: '{"entries":[]}' },
      ];
      await driver.step(messages, []);

      assert.equal(seen.length, 2);
      const secondBody = JSON.parse(seen[1].body);
      const assistantMsg = secondBody.messages.find((m) => m.role === 'assistant');
      assert.ok(assistantMsg, 'expected the assistant tool-call message in the second request');
      assert.deepEqual(assistantMsg.tool_calls[0].extra_content, { google: { thought_signature: sig } });
    } finally {
      globalThis.fetch = original;
    }
  } finally {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  }
});

test('the google driver unwraps an array-shaped error body ([{error}]) instead of stringifying to an empty message', async () => {
  const originalKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  try {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => [{ error: { code: 403, message: 'team_blocked', status: 'PERMISSION_DENIED' } }],
    });
    try {
      const driver = resolveDriver('google', { model: 'gemini-3.8-flash', systemPrompt: 'sys' });
      await assert.rejects(
        () => driver.step([{ role: 'user', content: 'hi' }], []),
        /google 403: team_blocked/,
      );
    } finally {
      globalThis.fetch = original;
    }
  } finally {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  }
});

test('resolveDriver: --driver openrouter still resolves an arbitrary upstream model id like x-ai/grok-4.6', async () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  try {
    await withStubbedFetch(FAKE_CHAT_RESPONSE, async (seen) => {
      const driver = resolveDriver('openrouter', { model: 'x-ai/grok-4.6', systemPrompt: 'sys' });
      await driver.step([{ role: 'user', content: 'hello' }], []);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, 'https://openrouter.ai/api/v1/chat/completions');
      assert.equal(seen[0].opts.headers.authorization, 'Bearer test-openrouter-key');
      const body = JSON.parse(seen[0].opts.body);
      assert.equal(body.model, 'x-ai/grok-4.6');
    });
  } finally {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  }
});

// ---------------------------------------------------------------------------
// Addendum H: 401/403 mid-climb classification
// ---------------------------------------------------------------------------

test("a 401 mid-climb retries once after the fixed delay, then succeeds and the climb continues normally", async () => {
  await withOutDir(async (outDir) => {
    const script = [
      { toolCalls: [{ id: 't1', name: 'ls', input: { path: '.' } }] },
      { throwMessage: 'openai-compatible 401: Invalid API Key' },
      // The retry succeeds: the climb must continue as if nothing happened.
      { toolCalls: [{ id: 't3', name: 'ls', input: { path: '.' } }] },
    ];
    const { driver } = makeScriptedDriver(script);

    const result = await climb({
      model: 'fake-401-recovers',
      seed: 21,
      outDir,
      driver,
      maxTurns: 3,
      budgetTokens: 10_000_000,
      providerRetryDelayMs: 1, // real 30s in production; keep the suite fast
      ...freshPorts(),
    });

    assert.notEqual(result.stoppedBecause, 'provider');
    assert.notEqual(result.stoppedBecause, 'error');
    assert.notEqual(result.stoppedBecause, 'fail');
    assert.equal(result.driverError, null);
    assert.equal(result.turns, 3, 'the retried turn still counts as the one turn it was');
  });
});

test("a 403 mid-climb that fails again on retry stops as 'provider', never 'error' or 'fail', with the status in driverError", async () => {
  await withOutDir(async (outDir) => {
    const script = [
      { toolCalls: [{ id: 't1', name: 'ls', input: { path: '.' } }] },
      { throwMessage: 'openai-compatible 403: team_blocked' },
      { throwMessage: 'openai-compatible 403: team_blocked' },
    ];
    const { driver } = makeScriptedDriver(script);

    const result = await climb({
      model: 'fake-403-persists',
      seed: 22,
      outDir,
      driver,
      maxTurns: 5,
      budgetTokens: 10_000_000,
      providerRetryDelayMs: 1,
      ...freshPorts(),
    });

    assert.equal(result.stoppedBecause, 'provider');
    assert.notEqual(result.stoppedBecause, 'error');
    assert.notEqual(result.stoppedBecause, 'fail');
    assert.match(result.driverError, /403/);
  });
});

test('401/403 is never reclassified as a TRANSIENT retry (no exponential backoff attempted first)', async () => {
  await withOutDir(async (outDir) => {
    // If the 401 were routed through stepWithRetry's TRANSIENT path instead of the dedicated
    // Addendum H path, it would throw immediately (401 doesn't match TRANSIENT) with no retry at
    // all, landing on stoppedBecause: 'error' rather than 'provider'. This proves the dedicated
    // retry-then-'provider' path actually ran.
    const script = [
      { toolCalls: [{ id: 't1', name: 'ls', input: { path: '.' } }] },
      { throwMessage: '401 unauthorized: bad key' },
      { throwMessage: '401 unauthorized: bad key' },
    ];
    const { driver } = makeScriptedDriver(script);

    const result = await climb({
      model: 'fake-401-persists',
      seed: 23,
      outDir,
      driver,
      maxTurns: 5,
      budgetTokens: 10_000_000,
      providerRetryDelayMs: 1,
      ...freshPorts(),
    });

    assert.equal(result.stoppedBecause, 'provider');
    assert.match(result.driverError, /401/);
  });
});

test('resolveDriver: an unknown driver name still throws (google does not shadow the generic error)', () => {
  assert.throws(() => resolveDriver('not-a-real-driver', { model: 'x', systemPrompt: 'x' }), /unknown driver/);
});
