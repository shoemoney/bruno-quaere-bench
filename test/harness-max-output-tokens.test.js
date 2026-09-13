// Addendum K: "message-loop drivers request max_tokens >= 32768 (make it configurable via
// --max-output-tokens, default 32768; if a provider rejects it as too large, halve and retry
// once, logging the accepted value into result.json as maxOutputTokens)."
//
// Covers the three message-loop driver files (openai.js, which also backs openrouter/xai/
// deepseek, anthropic.js, and google.js) plus run.js's resolveDriver plumbing and the
// RunResult.maxOutputTokens field.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { climb, resolveDriver } from '../src/harness/run.js';
import { createDriver as createOpenAiDriver } from '../src/harness/drivers/openai.js';
import { createDriver as createAnthropicDriver } from '../src/harness/drivers/anthropic.js';
import { createDriver as createGoogleDriver } from '../src/harness/drivers/google.js';

let nextPort = 49700;
function freshPorts() {
  const publicPort = nextPort;
  const adminPort = nextPort + 1;
  nextPort += 2;
  return { publicPort, adminPort };
}

async function withOutDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quaere-max-output-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// withSequentialFetch(responses, fn): each call to fetch() pops the next {status, body} entry
// (the last entry repeats once exhausted). Records every request body sent so a test can inspect
// the max_tokens value actually requested each attempt.
function withSequentialFetch(responses, fn) {
  const original = globalThis.fetch;
  const seen = [];
  let i = 0;
  globalThis.fetch = async (url, opts) => {
    const entry = responses[Math.min(i, responses.length - 1)];
    i += 1;
    seen.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return {
      ok: entry.status < 300,
      status: entry.status,
      json: async () => entry.body,
      text: async () => JSON.stringify(entry.body),
    };
  };
  return Promise.resolve()
    .then(() => fn(seen))
    .finally(() => {
      globalThis.fetch = original;
    });
}

const OK_CHAT_RESPONSE = {
  status: 200,
  body: { choices: [{ message: { content: 'hi', tool_calls: [] }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
};

// ---------------------------------------------------------------------------
// Default output budget: 32768, not the old 4096
// ---------------------------------------------------------------------------

test('openai driver: defaults to max_tokens 32768', async () => {
  await withSequentialFetch([OK_CHAT_RESPONSE], async (seen) => {
    const driver = createOpenAiDriver({ model: 'gpt-x', apiKey: 'k' });
    await driver.step([{ role: 'user', content: 'hi' }], []);
    assert.equal(seen[0].body.max_tokens, 32_768);
    assert.equal(driver.maxOutputTokens, 32_768);
  });
});

test('anthropic driver: defaults to max_tokens 32768', async () => {
  await withSequentialFetch(
    [{ status: 200, body: { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' } }],
    async (seen) => {
      const driver = createAnthropicDriver({ model: 'claude-x', apiKey: 'k', systemPrompt: 'sys' });
      await driver.step([{ role: 'user', content: 'hi' }], []);
      assert.equal(seen[0].body.max_tokens, 32_768);
      assert.equal(driver.maxOutputTokens, 32_768);
    },
  );
});

test('google driver: defaults to max_tokens 32768', async () => {
  await withSequentialFetch([OK_CHAT_RESPONSE], async (seen) => {
    const driver = createGoogleDriver({ model: 'gemini-x', apiKey: 'k', systemPrompt: 'sys' });
    await driver.step([{ role: 'user', content: 'hi' }], []);
    assert.equal(seen[0].body.max_tokens, 32_768);
    assert.equal(driver.maxOutputTokens, 32_768);
  });
});

test('resolveDriver: --max-output-tokens threads through to the openai-compatible preset', async () => {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  try {
    await withSequentialFetch([OK_CHAT_RESPONSE], async (seen) => {
      const driver = resolveDriver('openai', { model: 'gpt-x', systemPrompt: 'sys', maxOutputTokens: 8192 });
      await driver.step([{ role: 'user', content: 'hi' }], []);
      assert.equal(seen[0].body.max_tokens, 8192);
    });
  } finally {
    process.env.OPENAI_API_KEY = originalKey;
  }
});

// ---------------------------------------------------------------------------
// Halve-and-retry once on a "too large" rejection
// ---------------------------------------------------------------------------

test('openai driver: halves max_tokens and retries once when the provider rejects it as too large', async () => {
  await withSequentialFetch(
    [
      { status: 400, body: { error: { message: 'max_tokens is too large: 32768 > 16000' } } },
      OK_CHAT_RESPONSE,
    ],
    async (seen) => {
      const driver = createOpenAiDriver({ model: 'gpt-x', apiKey: 'k' });
      const result = await driver.step([{ role: 'user', content: 'hi' }], []);
      assert.equal(seen.length, 2, 'exactly one retry');
      assert.equal(seen[0].body.max_tokens, 32_768);
      assert.equal(seen[1].body.max_tokens, 16_384, 'halved once');
      assert.equal(driver.maxOutputTokens, 16_384, 'the accepted value is what the driver reports afterward');
      assert.equal(result.assistant, 'hi');
    },
  );
});

test('openai driver: a too-large rejection that persists after the retry still throws (no infinite halving)', async () => {
  await withSequentialFetch(
    [
      { status: 400, body: { error: { message: 'max_tokens is too large: 32768 > 16000' } } },
      { status: 400, body: { error: { message: 'max_tokens is too large: 16384 > 8000' } } },
    ],
    async (seen) => {
      const driver = createOpenAiDriver({ model: 'gpt-x', apiKey: 'k' });
      await assert.rejects(() => driver.step([{ role: 'user', content: 'hi' }], []), /too large/);
      assert.equal(seen.length, 2, 'only one retry attempted, then it throws');
    },
  );
});

test('openai driver: a 400 for an unrelated reason is never treated as too-large (no halving, throws immediately)', async () => {
  await withSequentialFetch([{ status: 400, body: { error: { message: 'model not found: gpt-x' } } }], async (seen) => {
    const driver = createOpenAiDriver({ model: 'gpt-x', apiKey: 'k' });
    await assert.rejects(() => driver.step([{ role: 'user', content: 'hi' }], []), /model not found/);
    assert.equal(seen.length, 1, 'no retry for an unrelated 400');
    assert.equal(driver.maxOutputTokens, 32_768, 'never halved');
  });
});

test('anthropic driver: halves max_tokens and retries once on "maximum allowed number of output tokens"', async () => {
  await withSequentialFetch(
    [
      { status: 400, body: { error: { message: 'max_tokens: 32768 > 16000, which is the maximum allowed number of output tokens' } } },
      { status: 200, body: { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' } },
    ],
    async (seen) => {
      const driver = createAnthropicDriver({ model: 'claude-x', apiKey: 'k', systemPrompt: 'sys' });
      const result = await driver.step([{ role: 'user', content: 'hi' }], []);
      assert.equal(seen.length, 2);
      assert.equal(seen[0].body.max_tokens, 32_768);
      assert.equal(seen[1].body.max_tokens, 16_384);
      assert.equal(driver.maxOutputTokens, 16_384);
      assert.equal(result.assistant, 'hi');
    },
  );
});

// ---------------------------------------------------------------------------
// RunResult.maxOutputTokens
// ---------------------------------------------------------------------------

function makeScriptedDriver(script) {
  let i = 0;
  const driver = {
    async step() {
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      const toolCalls = 'toolCalls' in step ? step.toolCalls : [{ id: `t${i}`, name: 'ls', input: { path: '.' } }];
      return {
        assistant: step.assistant || '',
        toolCalls,
        usage: step.usage || { input_tokens: 50, output_tokens: 50 },
        stop: toolCalls.length ? 'tool_use' : 'end_turn',
      };
    },
  };
  return driver;
}

test('climb(): RunResult.maxOutputTokens defaults to the configured value when the driver never exposes one (a hand-built fake)', async () => {
  await withOutDir(async (outDir) => {
    const driver = makeScriptedDriver([{}]);
    const result = await climb({ model: 'fake-maxtok-a', seed: 1, outDir, driver, maxTurns: 1, ...freshPorts() });
    assert.equal(result.maxOutputTokens, 32_768);
  });
});

test('climb(): RunResult.maxOutputTokens reflects a custom --max-output-tokens value for a fake driver too', async () => {
  await withOutDir(async (outDir) => {
    const driver = makeScriptedDriver([{}]);
    const result = await climb({
      model: 'fake-maxtok-b',
      seed: 2,
      outDir,
      driver,
      maxTurns: 1,
      maxOutputTokens: 12_345,
      ...freshPorts(),
    });
    assert.equal(result.maxOutputTokens, 12_345);
  });
});
