// One model, one seed, one climb -> RunResult. Starts a fresh instance, wires the agent's
// sandbox, drives turns until the agent fails a rung, exhausts its budget, or clears the top,
// and writes the transcript, the result, and a copy of the collection the agent leaves behind.
//
// Wall-clock timing (Date.now()) is allowed here: this is the harness, not anything that feeds
// an artifact, a spec, a skill, or a rung.

import { mkdir, writeFile, readFile, cp, readdir } from 'node:fs/promises';
import path from 'node:path';

import { makeWorld } from '../world.js';
import { createServer } from '../api/server.js';
import { toOpenApi, listLies } from '../spec.js';
import { toSkill } from '../skill.js';
import { answerKey } from '../ladder/reference.js';

import { makeSandbox } from './sandbox.js';
import { createDriver as createAnthropicDriver } from './drivers/anthropic.js';
import { createDriver as createOpenAiDriver } from './drivers/openai.js';

const PROMPT_URL = new URL('./prompt.md', import.meta.url);

// The five tools every driver exposes to the model, per Addendum B. Kept here (not per-driver)
// so every provider sees byte-identical tool definitions.
export const TOOLS = [
  {
    name: 'bru',
    description:
      'Run the Bruno CLI. This is the only tool that opens a network socket. Pass everything ' +
      'that would come after "bru" on the command line, e.g. "run requests/create-image.bru --env local".',
    input_schema: {
      type: 'object',
      properties: { args: { type: 'string', description: 'Everything after `bru` on the command line.' } },
      required: ['args'],
    },
  },
  {
    name: 'write_file',
    description: 'Write a text file inside your sandbox, creating parent directories as needed. Overwrites if it exists.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'read_file',
    description: 'Read up to 200 lines of a text file in your sandbox, starting at `offset` (0-based line number).',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } },
      required: ['path'],
    },
  },
  {
    name: 'grep',
    description:
      'Search a regular expression inside your sandbox: a single file, or every file under a directory. ' +
      'Returns up to 100 matching lines with line numbers.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string' } },
      required: ['pattern', 'path'],
    },
  },
  {
    name: 'ls',
    description: 'List the contents of a directory in your sandbox.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

function fillPrompt(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in vars ? String(vars[key]) : `{{${key}}}`));
}

function resolveDriver(driverName, { model, systemPrompt }) {
  if (driverName === 'anthropic') {
    return createAnthropicDriver({ model, apiKey: process.env.ANTHROPIC_API_KEY, systemPrompt });
  }
  if (driverName === 'openai') {
    return createOpenAiDriver({ model, apiKey: process.env.OPENAI_API_KEY, systemPrompt });
  }
  if (driverName === 'openrouter') {
    return createOpenAiDriver({
      model,
      apiKey: process.env.OPENROUTER_API_KEY,
      baseUrl: 'https://openrouter.ai/api/v1',
      systemPrompt,
      extraHeaders: { 'HTTP-Referer': 'https://git.shoemoney.ai', 'X-Title': 'Bruno QUAERE' },
      // Addendum D: OpenRouter may route to an Anthropic model, which needs explicit
      // cache_control breakpoints (plain OpenAI caches automatically, so its driver leaves this
      // off). Harmless no-op against a non-Anthropic upstream -- it just adds a field they ignore.
      cacheControl: true,
    });
  }
  throw new Error(`unknown driver: ${driverName}`);
}

// --- Addendum D: novel-token accounting, context trimming, context-length-error recovery -------

// A provider's 400 for "the conversation is too big" -- distinct from TRANSIENT (rate limits,
// 5xx, sockets): retrying the identical request fails identically forever, only trimming helps.
const CONTEXT_LENGTH_ERROR =
  /context[_ ]length|context.window|too many tokens|prompt is too long|maximum context|input is too long/i;

function trimNote(removed) {
  return `[context trimmed: ${removed} earlier turns removed. Files you wrote in the sandbox persist.]`;
}

// Same chars/4 heuristic the spec calls for: no tokenizer here (zero deps), and it only has to
// be consistent enough to decide "we are over the limit," not exact.
function estimateCharsOf(messages) {
  return messages.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
}

function estimateTokensOf(messages) {
  return Math.ceil(estimateCharsOf(messages) / 4);
}

// trimToFraction(messages, contextLimit, fraction) -> {messages, removed}. Drops the OLDEST
// messages first (never the single most recent one, so there is always something to send) until
// the estimated size is under contextLimit * fraction.
function trimToFraction(messages, contextLimit, fraction) {
  let msgs = messages;
  let removed = 0;
  const targetChars = contextLimit * fraction * 4;
  while (msgs.length > 1 && estimateCharsOf(msgs) > targetChars) {
    msgs = msgs.slice(1);
    removed += 1;
  }
  return { messages: msgs, removed };
}

async function runTool(sandbox, call) {
  try {
    if (call.name === 'bru') {
      // The tool's own schema (TOOLS below) tells the model `args` is "everything after bru";
      // sandbox.exec expects the whole command line, argv[0] included, so prepend it back here.
      const r = await sandbox.exec(`bru ${call.input.args}`);
      return { content: JSON.stringify(r), isError: r.code !== 0 };
    }
    if (call.name === 'write_file') {
      const r = await sandbox.writeFile(call.input.path, call.input.content);
      return { content: JSON.stringify(r), isError: false };
    }
    if (call.name === 'read_file') {
      const r = await sandbox.readFile(call.input.path, { offset: call.input.offset, limit: call.input.limit });
      return { content: JSON.stringify(r), isError: false };
    }
    if (call.name === 'grep') {
      const r = await sandbox.grep(call.input.pattern, call.input.path);
      return { content: JSON.stringify(r), isError: false };
    }
    if (call.name === 'ls') {
      const r = await sandbox.ls(call.input.path);
      return { content: JSON.stringify(r), isError: false };
    }
    return { content: `unknown tool: ${call.name}`, isError: true };
  } catch (err) {
    return { content: `error: ${err.message}`, isError: true };
  }
}

async function copyCollection(sandboxDir, collectionDir) {
  await mkdir(collectionDir, { recursive: true });
  await cp(sandboxDir, collectionDir, {
    recursive: true,
    filter: (source) => {
      const rel = path.relative(sandboxDir, source);
      if (rel === '') return true;
      return rel.split(path.sep)[0] !== 'bin';
    },
  });
}

async function walkTextFiles(dir) {
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
      out.push(...(await walkTextFiles(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

// The Trap heuristic (documented in ARCHITECTURE.md as ours to define): for every live spec lie
// (listLies already filters to world.traps.live), grep the agent's collection for the REAL
// value the lie hid -- the real field name for fieldCase, the real status for deleteStatus, the
// real spelling for enumSpelling, the real default for wrongDefault. If the agent's own request
// or test files mention that real value anywhere, we credit it with having caught the lie. Crude
// but cheap, deterministic, and it only rewards evidence that the agent went looking.
function trapNeedle(lie) {
  switch (lie.trap) {
    case 'fieldCase':
    case 'enumSpelling':
    case 'wrongDefault':
      return String(lie.detail.real);
    case 'deleteStatus':
      return String(lie.detail.real);
    case 'optionalIsRequired':
      return lie.detail.field;
    case 'missingRequiredHeader':
      return lie.detail.header;
    default:
      return null;
  }
}

// Files the HARNESS planted in the sandbox, not the agent. SKILL.md states every override in
// plain text (that is its job) and spec.json carries the lied-about paths, so scanning them for
// the real values credits the agent for reading nothing: before this exclusion every run scored
// Trap 1.0 regardless of behavior, because the needles were always sitting in the copied SKILL.md.
// Only files the agent actually authored count as evidence it went looking.
const PLANTED_FILES = new Set(['spec.json', 'SKILL.md']);

// Exported for test/harness.test.js: the planted-file exclusion is the whole reason Trap means
// anything, so it needs a direct regression test rather than only running inside a full climb.
export async function computeTrap(world, collectionDir) {
  const lies = listLies(world);
  if (lies.length === 0) return 1;
  const files = (await walkTextFiles(collectionDir)).filter(
    (f) => !PLANTED_FILES.has(path.relative(collectionDir, f)),
  );
  let text = '';
  for (const file of files) {
    try {
      text += `\n${await readFile(file, 'utf8')}`;
    } catch {
      // binary or unreadable, skip
    }
  }
  let caught = 0;
  for (const lie of lies) {
    const needle = trapNeedle(lie);
    if (needle && text.includes(needle)) caught += 1;
  }
  return caught / lies.length;
}

// A provider failure is transient if retrying the identical request could plausibly succeed:
// rate limits, gateway/overload 5xx, and socket-level resets. Anything else (401 bad key, 400 bad
// request, 404 unknown model) will fail identically forever, so retrying only burns wall clock.
const TRANSIENT = /\b(429|500|502|503|504|529)\b|overloaded|rate.?limit|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up/i;

const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];

async function stepWithRetry(driver, messages, tools, msLeft) {
  let lastErr;
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await driver.step(messages, tools);
    } catch (err) {
      lastErr = err;
      if (!TRANSIENT.test(err.message) || i === RETRY_DELAYS_MS.length) throw err;
      const delay = RETRY_DELAYS_MS[i];
      // Don't sleep past the run's own deadline -- surface the error instead of stalling out.
      if (Number.isFinite(msLeft) && delay >= msLeft) throw err;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function adminPost(adminBase, pathname, body) {
  const res = await fetch(`${adminBase}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

async function adminGet(adminBase, pathname) {
  const res = await fetch(`${adminBase}${pathname}`);
  return res.json();
}

// climb({driverName, model, seed, attempt, budgetTokens, maxTurns, outDir, driver?, publicPort?,
// adminPort?}) -> RunResult
//
// Two params beyond ARCHITECTURE.md's literal signature, both escape hatches for tests rather
// than something a real run needs:
//   - `driver`: a pre-built {step(messages, tools)} that skips driverName/model resolution
//     entirely, letting tests climb rungs with a scripted fake instead of a real provider.
//   - `publicPort`/`adminPort`: normally 0 (ephemeral, per ARCHITECTURE.md's "start a server pair
//     on free ports"); a test that needs to know the base URL *before* the server starts (to bake
//     it into a scripted driver's collection files) can pin them instead.
export async function climb({
  driverName,
  model,
  seed,
  attempt = 1,
  budgetTokens = 3_000_000,
  maxTurns = 5000,
  wallMsLimit = Infinity,
  outDir = 'runs',
  driver: providedDriver,
  publicPort = 0,
  adminPort = 0,
  // Addendum A: the skill the agent gets is sloppy and 5 MB by default for a real run; tests (and
  // `quaere run --skill-mode clean`) can ask for the tidy 200-400 line document, or a smaller
  // `skillBytes`, instead.
  skillMode = 'sloppy',
  skillBytes = 5_000_000,
  // Addendum D: proactive context trimming threshold, in estimated tokens. The harness trims
  // down to 60% of this on a normal breach, 40% on a provider context-length error.
  contextLimit = 160_000,
} = {}) {
  const world = makeWorld(seed);
  const runDir = path.join(outDir, String(model || driverName), String(seed), String(attempt));
  const sandboxDir = path.join(runDir, 'sandbox');
  await mkdir(sandboxDir, { recursive: true });
  const sandbox = makeSandbox(sandboxDir);

  const server = createServer({ world, publicPort, adminPort });
  const boundPorts = await server.start();
  const baseUrl = `http://127.0.0.1:${boundPorts.publicPort}`;
  const adminBase = `http://127.0.0.1:${boundPorts.adminPort}`;

  const startedAt = Date.now();
  const transcript = [];
  const submissions = [];
  let stoppedBecause = 'error';
  let driverError = null;

  try {
    await adminPost(adminBase, '/admin/rungs', answerKey(world));

    await sandbox.writeFile('spec.json', JSON.stringify(toOpenApi(world), null, 2));
    // Addendum A: sloppy mode buries every rule in megabytes of plausible noise; skill.js
    // dispatches on `mode` to skill-sloppy.js, which does the burying and owns targetBytes.
    await sandbox.writeFile('SKILL.md', toSkill(world, { mode: skillMode, targetBytes: skillBytes }));

    const promptTemplate = await readFile(PROMPT_URL, 'utf8');
    const systemPrompt = fillPrompt(promptTemplate, {
      BASE_URL: baseUrl,
      API_KEY: world.auth.apiKey,
      BUDGET_TOKENS: budgetTokens,
    });

    const driver = providedDriver || resolveDriver(driverName, { model, systemPrompt });

    let messages = [
      { role: 'user', content: 'Begin. Fetch the current rung with bru and start working toward passing it.' },
    ];

    let tokensIn = 0;
    let tokensOut = 0;
    let tokensNovel = 0;
    let cacheReadTokens = 0;
    let trims = 0;
    // Previous turn's raw usage, for the novel-token delta below; 0 before the first call so
    // turn 1's whole (empty-history) input is counted as novel, same as any other new content.
    let prevInputTokens = 0;
    let prevOutputTokens = 0;
    // The harness's own running estimate of what's about to be sent: the provider's last-reported
    // input_tokens once we have one, else null so the pre-first-call check falls back to chars/4.
    let contextEstimate = null;
    let turns = 0;
    let lastSubmissionCount = 0;
    let noToolStreak = 0;

    turnLoop: while (turns < maxTurns) {
      if (Date.now() - startedAt >= wallMsLimit) {
        stoppedBecause = 'time';
        break;
      }
      turns += 1;

      // Addendum D: trim BEFORE sending, using what we already know about the context we're
      // about to build -- the last real input_tokens the provider reported, or (turn 1, nothing
      // reported yet) a chars/4 estimate of the messages themselves.
      const preEstimate = contextEstimate != null ? contextEstimate : estimateTokensOf(messages);
      if (preEstimate > contextLimit) {
        const { messages: trimmed, removed } = trimToFraction(messages, contextLimit, 0.6);
        if (removed > 0) {
          messages = [...trimmed, { role: 'user', content: trimNote(removed) }];
          trims += 1;
          transcript.push({ turn: turns, trim: { removed, reason: 'proactive', contextLimit, note: trimNote(removed) } });
          contextEstimate = null;
        }
      }

      // A live provider call is the one step here that fails for reasons that have nothing to do
      // with the climb: 429s, 5xx, and socket resets. Letting those throw out of climb() loses the
      // whole run -- the transcript and result.json below never get written, so a two-hour climb
      // that tripped one rate limit on its last turn scores nothing. Retry the transient ones with
      // backoff, and on anything fatal stop the loop cleanly so the partial run is still recorded.
      let stepResult;
      try {
        stepResult = await stepWithRetry(driver, messages, TOOLS, wallMsLimit - (Date.now() - startedAt));
      } catch (err) {
        // Addendum D: a context-length error is not a fall -- trim harder (40%) and retry once;
        // only if that retry also fails does the run actually end in 'error'.
        if (CONTEXT_LENGTH_ERROR.test(err.message)) {
          const { messages: trimmed, removed } = trimToFraction(messages, contextLimit, 0.4);
          if (removed > 0) {
            messages = [...trimmed, { role: 'user', content: trimNote(removed) }];
            trims += 1;
            transcript.push({
              turn: turns,
              trim: { removed, reason: 'context-length-error', contextLimit, note: trimNote(removed) },
            });
            contextEstimate = null;
            try {
              stepResult = await stepWithRetry(driver, messages, TOOLS, wallMsLimit - (Date.now() - startedAt));
            } catch (err2) {
              stoppedBecause = 'error';
              driverError = err2.message;
              transcript.push({ turn: turns, error: err2.message });
              break;
            }
          } else {
            stoppedBecause = 'error';
            driverError = err.message;
            transcript.push({ turn: turns, error: err.message });
            break;
          }
        } else {
          stoppedBecause = 'error';
          driverError = err.message;
          transcript.push({ turn: turns, error: err.message });
          break;
        }
      }
      const usage = stepResult.usage || {};
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      tokensIn += inputTokens;
      tokensOut += outputTokens;
      cacheReadTokens += usage.cache_read_input_tokens || 0;

      // Budget = novel tokens (Addendum D): the new content this turn added, never the resend of
      // everything already paid for. `max(0, ...)` also absorbs the entirely expected case where
      // input_tokens actually DROPS turn over turn because we just trimmed.
      const novelDelta = outputTokens + Math.max(0, inputTokens - (prevInputTokens + prevOutputTokens));
      tokensNovel += novelDelta;
      prevInputTokens = inputTokens;
      prevOutputTokens = outputTokens;
      contextEstimate = inputTokens || contextEstimate;

      transcript.push({
        turn: turns,
        assistant: stepResult.assistant,
        toolCalls: stepResult.toolCalls,
        usage,
        novel: novelDelta,
        stop: stepResult.stop,
      });

      if (tokensNovel >= budgetTokens) {
        stoppedBecause = 'budget';
        break;
      }

      messages = [...messages, { role: 'assistant', content: stepResult.assistant, toolCalls: stepResult.toolCalls }];

      const toolCalls = stepResult.toolCalls || [];
      if (toolCalls.length === 0) {
        noToolStreak += 1;
        if (noToolStreak >= 3) {
          stoppedBecause = 'error';
          break;
        }
        messages = [
          ...messages,
          {
            role: 'user',
            content: 'You must call one of your five tools (bru, write_file, read_file, grep, ls) to make progress.',
          },
        ];
        if (turns >= maxTurns) stoppedBecause = 'budget';
        continue;
      }
      noToolStreak = 0;

      for (const call of toolCalls) {
        // eslint-disable-next-line no-await-in-loop
        const outcome = await runTool(sandbox, call);
        messages = [...messages, { role: 'tool', toolCallId: call.id, name: call.name, content: outcome.content, isError: outcome.isError }];
      }

      // eslint-disable-next-line no-await-in-loop
      const subsBody = await adminGet(adminBase, '/admin/submissions');
      const subs = subsBody.data || [];
      if (subs.length > lastSubmissionCount) {
        for (let i = lastSubmissionCount; i < subs.length; i += 1) {
          const s = subs[i];
          submissions.push(s);
          if (s.pass) {
            if (s.rung >= 99) {
              stoppedBecause = 'top';
              break turnLoop;
            }
            // eslint-disable-next-line no-await-in-loop
            await adminPost(adminBase, '/admin/rungs/advance');
          } else {
            stoppedBecause = 'fail';
            break turnLoop;
          }
        }
        lastSubmissionCount = subs.length;
      }

      if (turns >= maxTurns) stoppedBecause = 'budget';
    }

    const wallMs = Date.now() - startedAt;
    const passedNs = submissions.filter((s) => s.pass).map((s) => s.rung);
    const rung = passedNs.length ? Math.max(...passedNs) : -1;
    const fidelityScores = submissions.map((s) => s.fidelity).filter((v) => typeof v === 'number');
    const fidelity = fidelityScores.length ? fidelityScores.reduce((a, b) => a + b, 0) / fidelityScores.length : 0;

    const collectionDir = path.join(runDir, 'collection');
    await copyCollection(sandboxDir, collectionDir);
    const trap = await computeTrap(world, collectionDir);

    const result = {
      model: model || driverName,
      modelVersion: model || null,
      seed,
      attempt,
      rung,
      turns,
      tokensIn,
      tokensOut,
      // Addendum D: tokensNovel is what the 3M budget is measured against; tokensBilled is the
      // old (pre-Addendum-D) cumulative-resend accounting, kept because it's still what the
      // provider actually charges for.
      tokensNovel,
      tokensBilled: tokensIn + tokensOut,
      cacheReadTokens,
      trims,
      wallMs,
      fidelity,
      trap,
      submissions,
      stoppedBecause,
      driverError,
    };

    await writeFile(path.join(runDir, 'transcript.jsonl'), `${transcript.map((t) => JSON.stringify(t)).join('\n')}\n`);
    await writeFile(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));

    return result;
  } finally {
    await server.stop();
  }
}
