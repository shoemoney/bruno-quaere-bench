// One model, one seed, one climb -> RunResult. Starts a fresh instance, wires the agent's
// sandbox, drives turns until the agent fails a rung, exhausts its budget, or clears the top,
// and writes the transcript, the result, and a copy of the collection the agent leaves behind.
//
// Wall-clock timing (Date.now()) is allowed here: this is the harness, not anything that feeds
// an artifact, a spec, a skill, or a rung.

import { mkdir, writeFile, readFile, cp, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { makeWorld, VERSION as LADDER_VERSION, amendmentsAt } from '../world.js';
import { createServer } from '../api/server.js';
import { toOpenApi, listLies } from '../spec.js';
import { toSkill } from '../skill.js';
import { answerKey } from '../ladder/reference.js';

import { makeSandbox } from './sandbox.js';
import { buildLocalEnv, LOCAL_ENV_PATH } from './sandbox-env.js';
import { createDriver as createAnthropicDriver } from './drivers/anthropic.js';
import { createDriver as createOpenAiDriver } from './drivers/openai.js';
import { createDriver as createGoogleDriver } from './drivers/google.js';

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

// Exported for test/harness-transcript.test.js: proves the xai/deepseek presets actually wire up
// the right baseUrl/key env var without needing a full climb() (or a real network call -- tests
// stub global.fetch and inspect what createDriver's returned {step} sends it).
export function resolveDriver(driverName, { model, systemPrompt, maxOutputTokens }) {
  // Addendum K: every message-loop preset below forwards maxOutputTokens as `maxTokens` so the
  // request carries it (createDriver defaults to 32768 itself when this is undefined, e.g. a
  // caller that never threads the option through).
  if (driverName === 'anthropic') {
    return createAnthropicDriver({ model, apiKey: process.env.ANTHROPIC_API_KEY, systemPrompt, maxTokens: maxOutputTokens });
  }
  if (driverName === 'openai') {
    return createOpenAiDriver({ model, apiKey: process.env.OPENAI_API_KEY, systemPrompt, maxTokens: maxOutputTokens });
  }
  if (driverName === 'openrouter') {
    return createOpenAiDriver({
      model,
      apiKey: process.env.OPENROUTER_API_KEY,
      baseUrl: 'https://openrouter.ai/api/v1',
      systemPrompt,
      maxTokens: maxOutputTokens,
      extraHeaders: { 'HTTP-Referer': 'https://git.shoemoney.ai', 'X-Title': 'Bruno QUAERE' },
      // Addendum D: OpenRouter may route to an Anthropic model, which needs explicit
      // cache_control breakpoints (plain OpenAI caches automatically, so its driver leaves this
      // off). Harmless no-op against a non-Anthropic upstream -- it just adds a field they ignore.
      cacheControl: true,
    });
  }
  // Generic openai-compatible provider presets: same Chat Completions wire protocol as `openai`,
  // just a different baseUrl and key env var. Model ids are the provider's own, never verified
  // here (that's the operator's job, same as openrouter).
  if (driverName === 'xai') {
    return createOpenAiDriver({
      model,
      apiKey: process.env.XAI_API_KEY,
      baseUrl: 'https://api.x.ai/v1',
      systemPrompt,
      maxTokens: maxOutputTokens,
    });
  }
  if (driverName === 'deepseek') {
    return createOpenAiDriver({
      model,
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseUrl: 'https://api.deepseek.com',
      systemPrompt,
      maxTokens: maxOutputTokens,
    });
  }
  // Addendum H: gemini-cli 0.59.0 doesn't know gemini-3.8-flash (silently coerces it to
  // 3.5-flash), but the vaulted Google key reaches 3.8 fine through Google's own
  // OpenAI-compatible endpoint. Runs on this preset until a Gemini CLI release knows the literal
  // id (Jeremy's ruling: prefer the CLI once it does). A dedicated driver, not createOpenAiDriver
  // -- see drivers/google.js's header for why (thought_signature round-tripping on tool calls,
  // an array-shaped error body) -- but the same Chat Completions wire protocol otherwise.
  if (driverName === 'google') {
    return createGoogleDriver({ model, apiKey: process.env.GEMINI_API_KEY, systemPrompt, maxTokens: maxOutputTokens });
  }
  throw new Error(`unknown driver: ${driverName}`);
}

// --- Addendum D: novel-token accounting, context trimming, context-length-error recovery -------

// A provider's 400 for "the conversation is too big" -- distinct from TRANSIENT (rate limits,
// 5xx, sockets): retrying the identical request fails identically forever, only trimming helps.
const CONTEXT_LENGTH_ERROR =
  /context[_ ]length|context.window|too many tokens|prompt is too long|maximum context|input is too long/i;

// Addendum E (06:36, gpt-6-astra): a generic 400/413 that does NOT match the message-shaped
// regex above is still context-length if the call that produced it was made near the limit --
// that is exactly the failure that cut gpt-6-astra at rung 59 with no trim-and-retry. Only
// classify this way when the call was already at or above 85% of contextLimit; a 400 from a
// nearly-empty context is some other, real error and must not be swallowed as recoverable.
const GENERIC_4XX_ERROR = /\b(400|413)\b/;

function isContextLengthError(message, estimateTokens, contextLimit) {
  if (CONTEXT_LENGTH_ERROR.test(message)) return true;
  return GENERIC_4XX_ERROR.test(message) && estimateTokens >= contextLimit * 0.85;
}

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
  // A tool result whose assistant tool_calls message was just trimmed away is an orphan, and both
  // wire formats reject it (OpenAI 400s on a `role: "tool"` with no matching tool_call_id).
  while (msgs.length > 1 && msgs[0].role === 'tool') {
    msgs = msgs.slice(1);
    removed += 1;
  }
  // NOTE: an assistant/tool_calls message can legitimately land at index 0 too (its own paired
  // tool response is still present right after it) -- that's fine content-wise, but Gemini 400s
  // with "function call turn comes immediately after a user turn or after a function response
  // turn" because nothing precedes it (hit at seed 413 turn 247, 0.4.0 calibration: rung 15,
  // cleared 16 submissions before this). A real climb can run dozens of turns with no interstitial
  // 'user' message at all (every turn is assistant-tool_call/tool-response once past "Begin"), so
  // cascading further front-removal hunting for a natural 'user' boundary (tried first, seed 413
  // rerun turn 160) over-trims catastrophically -- 318 of ~320 messages gone, right back down to
  // the same bug with no content left to recover from. The caller prepends a synthetic 'user' trim
  // note as the new message 0 instead, which satisfies Gemini's adjacency rule without touching
  // which messages survive.
  return { messages: msgs, removed };
}

// Addendum E: transcript tool results are capped at 4 KB so a giant `bru run` dump doesn't blow
// up transcript.jsonl. Cuts on a UTF-8 boundary rather than mid-codepoint.
const TOOL_RESULT_MAX_BYTES = 4096;

function truncateToBytes(str, maxBytes) {
  const s = str == null ? '' : String(str);
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const buf = Buffer.from(s, 'utf8').subarray(0, maxBytes);
  let end = buf.length;
  while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) end -= 1;
  return `${buf.subarray(0, end).toString('utf8')}…[truncated]`;
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

// --- Addendum Q rule 13: codeWrites / docReads -------------------------------------------------
//
// Two counters that "separate templating from reasoning better than turns" (Astra's were 23 and
// 10 on the CLI path). Message-loop drivers see every tool call directly, so both are exact here
// (no mtime scanning or transcript text-mining needed -- that's the CLI-driver-only fallback in
// run-cli.js, which has no equivalent direct visibility into what the product's own tools did).
const SCRIPT_EXT_RE = /\.(py|js|sh|ts)$/i;

// touchesSkillDoc(sandboxDir, rel, docName): true when a read_file/grep call's own `path` input
// resolves to the planted skill document itself, or to the sandbox root (a grep of '.' walks
// every file under it, docName included, per sandbox.js's own grep). Deliberately conservative --
// a grep of an unrelated subdirectory that happens not to contain the doc does not count.
function touchesSkillDoc(sandboxDir, rel, docName) {
  if (typeof rel !== 'string' || rel.length === 0 || path.isAbsolute(rel)) return false;
  let resolved;
  try {
    resolved = path.resolve(sandboxDir, rel);
  } catch {
    return false;
  }
  return resolved === path.join(sandboxDir, docName) || resolved === sandboxDir;
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
const TRANSIENT = /\b(429|500|502|503|504|529)\b|overloaded|rate.?limit|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|\bterminated\b/i;

const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];

// Addendum H: a 401/403 mid-climb is the provider itself refusing the key (a blocked team, a
// revoked or wrong credential) -- distinct from a TRANSIENT provider hiccup (which gets the
// escalating retry above) and distinct from the agent failing a rung. Exactly one retry, after a
// fixed delay; if that retry also errors, the climb stops as 'provider' with the status folded
// into driverError -- never 'error' (which the board reads as a harness problem) and never
// 'fail' (which it reads as a bad submission).
const PROVIDER_AUTH_ERROR = /\b(401|403)\b/;

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

// Addendum J admin-port hardening: every admin call the harness makes carries the per-run
// X-Admin-Token generated in climb() below (never written to the sandbox or TASK.md -- it lives
// only in this process's memory and on the wire to 127.0.0.1). The real enforcement (401 on a
// missing/wrong token, logging the attempt as an adminProbe) is the [api] workstream's admin.js,
// not this file's; these two helpers are the harness's half of the contract, sent unconditionally
// so the day admin.js starts checking it, no caller here has to change.
async function adminPost(adminBase, pathname, body, adminToken) {
  const res = await fetch(`${adminBase}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': adminToken },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

async function adminGet(adminBase, pathname, adminToken) {
  const res = await fetch(`${adminBase}${pathname}`, { headers: { 'x-admin-token': adminToken } });
  return res.json();
}

// Addendum J: "Turn cap. 5000 bru requests per run, reported as stoppedBecause: 'turns'." Counted
// locally from the tool calls this process itself dispatches (call.name === 'bru'), not from the
// admin log -- for the message-loop driver every bru invocation is a tool call this file already
// sees, so no extra admin round trip is needed to enforce the cap.
const DEFAULT_MAX_BRU_CALLS = 5000;

// climb({driverName, model, seed, attempt, budgetTokens, maxTurns, outDir, driver?, publicPort?,
// adminPort?}) -> RunResult
//
// Three params beyond ARCHITECTURE.md's literal signature, all escape hatches for tests rather
// than something a real run needs:
//   - `driver`: a pre-built {step(messages, tools)} that skips driverName/model resolution
//     entirely, letting tests climb rungs with a scripted fake instead of a real provider.
//   - `publicPort`/`adminPort`: normally 0 (ephemeral, per ARCHITECTURE.md's "start a server pair
//     on free ports"); a test that needs to know the base URL *before* the server starts (to bake
//     it into a scripted driver's collection files) can pin them instead.
//   - `providerRetryDelayMs`: the fixed delay before the single Addendum H retry on a 401/403.
//     A real run always waits the full 30 s; tests override it so the suite stays fast.
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
  // Highest rung that counts as the top: clearing it stops the climb with stoppedBecause 'top'.
  // `quaere run --max-rung N` exposes it; a short calibration climb can cap well below 99.
  topRung = 99,
  // Addendum H: see the doc comment above climb().
  providerRetryDelayMs = 30_000,
  // Addendum J: overridable only so a test can trip the cap in a handful of calls instead of
  // 5000; a real run never passes this and gets the documented default.
  maxBruCalls = DEFAULT_MAX_BRU_CALLS,
  // Addendum K: message-loop drivers request at least this many output tokens so a reasoning
  // model has room to think AND still emit a tool call in the same turn (deepseek-flash seed 506
  // burned its whole 4096-token budget on invisible reasoning and never got the chance). `quaere
  // run --max-output-tokens N` exposes it; a provider that rejects it as too large gets halved
  // and retried once by the driver itself (see resolveDriver/createDriver), and the value it
  // actually settled on is logged onto RunResult.maxOutputTokens below.
  maxOutputTokens = 32_768,
  // Addendum P: injectable clock, purely for tests -- a fake `now()` lets a test jump the clock
  // forward (simulating a multi-hour sleep) between two turns without actually waiting. A real
  // run never passes this and gets the real Date.now.
  now = Date.now,
  // Addendum Q rule 4 test hook: a pre-built world, skipping makeWorld(seed). A real run never
  // passes this. Exists so a test can attach a `world.amendments` array (not yet produced by
  // makeWorld -- that half of Addendum Q is the [ladder]/[skill] workstreams' job) without
  // waiting on that generator work to land, same escape-hatch pattern as `driver` above.
  world: providedWorld,
} = {}) {
  const world = providedWorld || makeWorld(seed);
  const runDir = path.join(outDir, String(model || driverName), String(seed), String(attempt));
  const sandboxDir = path.join(runDir, 'sandbox');
  await mkdir(sandboxDir, { recursive: true });
  const sandbox = makeSandbox(sandboxDir);

  // Addendum J: a fresh, unguessable secret every climb -- never derived from the seed (which is
  // public, printed on the board and in the skill/spec) and never persisted anywhere the agent's
  // sandbox can read (not spec.json, not SKILL.md, not the transcript, not result.json).
  const adminToken = randomBytes(24).toString('hex');
  const server = createServer({ world, publicPort, adminPort, adminToken });
  const boundPorts = await server.start();
  const baseUrl = `http://127.0.0.1:${boundPorts.publicPort}`;
  const adminBase = `http://127.0.0.1:${boundPorts.adminPort}`;

  const startedAt = now();
  const transcript = [];
  const submissions = [];
  let stoppedBecause = 'error';
  let driverError = null;

  // Addendum P: "the machine slept." A climb's wall check used to compare raw elapsed real time
  // against wallMsLimit, so a laptop sleeping mid-run counted every minute of sleep as if the
  // agent had been burning wall clock -- round three's 371-wall-minute runs against a 180-minute
  // cap were 344 of those minutes suspended, not spent. Any gap between two consecutive turns
  // over SUSPEND_GAP_MS is assumed to be a sleep/suspend, not the model thinking, and is folded
  // into `suspendedMs`, which is subtracted from elapsed before every wall-ms comparison below.
  const SUSPEND_GAP_MS = 5 * 60 * 1000;
  let suspendedMs = 0;
  let lastTickAt = startedAt;
  // tick(): call once per turn (never mid-turn) -- folds the gap since the last tick into
  // suspendedMs when it exceeds SUSPEND_GAP_MS, then moves the tick forward. Returns the elapsed
  // ACTIVE time so far (wall time minus everything folded into suspendedMs), which is what every
  // wallMsLimit comparison in this file is measured against.
  function tick() {
    const t = now();
    const gap = t - lastTickAt;
    if (gap > SUSPEND_GAP_MS) suspendedMs += gap;
    lastTickAt = t;
    return t - startedAt - suspendedMs;
  }
  // elapsedMs(): the same active-time figure as tick(), without folding in a new gap -- used
  // between ticks (e.g. computing how much budget a retry has left mid-turn) so a slow provider
  // call itself is never mistaken for a suspend.
  function elapsedMs() {
    return now() - startedAt - suspendedMs;
  }

  try {
    await adminPost(adminBase, '/admin/rungs', answerKey(world), adminToken);

    await sandbox.writeFile('spec.json', JSON.stringify(toOpenApi(world), null, 2));
    // Addendum A: sloppy mode buries every rule in megabytes of plausible noise; skill.js
    // dispatches on `mode` to skill-sloppy.js, which does the burying and owns targetBytes.
    await sandbox.writeFile('SKILL.md', toSkill(world, { mode: skillMode, targetBytes: skillBytes }));
    // Addendum L: the sandbox never contained the signing secret -- SKILL.md says it lives here
    // and never states its value, and before this nothing ever wrote the file. Written before the
    // first turn so every publish rung (50+) is actually passable.
    await sandbox.writeFile(
      LOCAL_ENV_PATH,
      buildLocalEnv({ baseUrl, apiKey: world.auth.apiKey, secret: world.auth.secret }),
    );

    const promptTemplate = await readFile(PROMPT_URL, 'utf8');
    const systemPrompt = fillPrompt(promptTemplate, {
      BASE_URL: baseUrl,
      API_KEY: world.auth.apiKey,
      BUDGET_TOKENS: budgetTokens,
    });

    const driver = providedDriver || resolveDriver(driverName, { model, systemPrompt, maxOutputTokens });

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
    // Addendum J turn cap: real `bru` tool calls this climb has dispatched, independent of
    // `turns` (model turns/maxTurns) above -- a single model turn can carry several tool calls,
    // and only the `bru` ones count toward the 5000 cap.
    let bruCalls = 0;
    // Addendum Q rule 13: write_file calls that create/patch a script file (.py/.js/.sh/.ts), and
    // read_file/grep calls that touch the planted skill document -- see touchesSkillDoc() above.
    let codeWrites = 0;
    let docReads = 0;
    let lastSubmissionCount = 0;
    let noToolStreak = 0;
    // Addendum E (kimi-k3, rung 11): two consecutive turns with no tool call AND stop === 'length'
    // means the model collapsed into repeating filler, not that it is thinking -- distinct from
    // (and reached before) the generic 3-turn noToolStreak, which covers a model that just forgot
    // to call a tool for reasons other than degenerate repetition.
    let degenerateStreak = 0;

    turnLoop: while (turns < maxTurns) {
      // Addendum P: tick() first so a gap since the previous turn (a sleeping machine) is folded
      // into suspendedMs BEFORE it's checked against the wall, never after.
      if (tick() >= wallMsLimit) {
        stoppedBecause = 'time';
        break;
      }
      turns += 1;

      // Addendum E (06:36, gpt-6-astra): trim BEFORE sending whenever the last reported
      // input_tokens is already at or above 90% of contextLimit, never wait for it to actually
      // exceed the limit -- gpt-6-astra's fatal call went out at turn 445's 160,107 tokens
      // against a 160,000 limit because the old check only fired once already over.
      const preEstimate = contextEstimate != null ? contextEstimate : estimateTokensOf(messages);
      if (preEstimate >= contextLimit * 0.9) {
        const { messages: trimmed, removed } = trimToFraction(messages, contextLimit, 0.6);
        if (removed > 0) {
          messages = [{ role: 'user', content: trimNote(removed) }, ...trimmed];
          trims += 1;
          transcript.push({ turn: turns, trim: { removed, reason: 'proactive', contextLimit, note: trimNote(removed) } });
          contextEstimate = null;
        }
      }
      // What we're actually about to send this call, after any proactive trim just above --
      // used to classify a generic 400/413 below as context-length only when the call itself
      // was made near the limit (Addendum E rule 2).
      const callEstimate = contextEstimate != null ? contextEstimate : estimateTokensOf(messages);

      // A live provider call is the one step here that fails for reasons that have nothing to do
      // with the climb: 429s, 5xx, and socket resets. Letting those throw out of climb() loses the
      // whole run -- the transcript and result.json below never get written, so a two-hour climb
      // that tripped one rate limit on its last turn scores nothing. Retry the transient ones with
      // backoff, and on anything fatal stop the loop cleanly so the partial run is still recorded.
      let stepResult;
      try {
        stepResult = await stepWithRetry(driver, messages, TOOLS, wallMsLimit - elapsedMs());
      } catch (err) {
        // Addendum H: a 401/403 is the provider itself, not the agent or the harness -- exactly
        // one retry after a fixed delay (never stepWithRetry's escalating backoff), then stop as
        // 'provider' with the status in driverError. Checked before the context-length regexes
        // below since 400/413 and 401/403 never overlap.
        if (PROVIDER_AUTH_ERROR.test(err.message)) {
          const msLeftForRetry = wallMsLimit - elapsedMs();
          if (Number.isFinite(msLeftForRetry) && providerRetryDelayMs >= msLeftForRetry) {
            stoppedBecause = 'provider';
            driverError = err.message;
            transcript.push({ turn: turns, error: err.message });
            break;
          }
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, providerRetryDelayMs));
          try {
            // eslint-disable-next-line no-await-in-loop
            stepResult = await stepWithRetry(driver, messages, TOOLS, wallMsLimit - elapsedMs());
          } catch (err2) {
            stoppedBecause = 'provider';
            driverError = err2.message;
            transcript.push({ turn: turns, error: err2.message });
            break;
          }
        } else if (isContextLengthError(err.message, callEstimate, contextLimit)) {
          // Addendum D/E: a context-length error is not a fall -- trim harder (40%) and retry
          // once; only if that retry also fails does the run actually end in 'error'. Addendum E
          // widens detection beyond the message-shaped regex: any 400/413 from a call made at or
          // above 85% of contextLimit is treated as context-length too, since providers don't all
          // say so.
          const { messages: trimmed, removed } = trimToFraction(messages, contextLimit, 0.4);
          if (removed > 0) {
            messages = [{ role: 'user', content: trimNote(removed) }, ...trimmed];
            trims += 1;
            transcript.push({
              turn: turns,
              trim: { removed, reason: 'context-length-error', contextLimit, note: trimNote(removed) },
            });
            contextEstimate = null;
            try {
              stepResult = await stepWithRetry(driver, messages, TOOLS, wallMsLimit - elapsedMs());
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

      // Addendum E: transcripts must carry tool results -- `toolResults` is filled in below, after
      // the tool calls (if any) actually run, by mutating this same object still sitting in
      // `transcript`.
      const transcriptEntry = {
        turn: turns,
        assistant: stepResult.assistant,
        toolCalls: stepResult.toolCalls,
        usage,
        novel: novelDelta,
        stop: stepResult.stop,
      };
      transcript.push(transcriptEntry);

      if (tokensNovel >= budgetTokens) {
        stoppedBecause = 'budget';
        break;
      }

      const toolCalls = stepResult.toolCalls || [];
      // Addendum K: "never append an assistant message with neither content nor tool_calls" --
      // a reasoning model can burn its whole output budget on invisible reasoning and return
      // stop: 'length' with nothing else; appending that turn produces a message the provider's
      // own API rejects on the very next call ("content or tool_calls must be set"), which is
      // what killed deepseek-flash seed 506 at rung 44. Skip the append and prompt for a tool
      // call instead; a normal empty-but-content-bearing turn (assistant said something, just
      // didn't call a tool) still gets appended and still gets the generic nudge below.
      const isEmptyTurn = !stepResult.assistant && toolCalls.length === 0;
      if (!isEmptyTurn) {
        messages = [...messages, { role: 'assistant', content: stepResult.assistant, toolCalls: stepResult.toolCalls }];
      }

      if (toolCalls.length === 0) {
        noToolStreak += 1;
        // Addendum E: degenerate stop reason -- two turns running with no tool call and the
        // provider itself saying it hit its length cap, not that it chose to stop. Left tied to
        // stop === 'length' specifically (not the broader isEmptyTurn above): a model that keeps
        // returning real text with no tool call under a normal stop reason still falls under the
        // generic 3-turn noToolStreak rule just below, never the 2-turn degenerate one.
        degenerateStreak = stepResult.stop === 'length' ? degenerateStreak + 1 : 0;
        if (degenerateStreak >= 2) {
          stoppedBecause = 'degenerate';
          break;
        }
        if (noToolStreak >= 3) {
          stoppedBecause = 'error';
          break;
        }
        messages = [
          ...messages,
          {
            role: 'user',
            content: isEmptyTurn
              ? 'Your last reply was cut off before any tool call. Answer with a tool call.'
              : 'You must call one of your five tools (bru, write_file, read_file, grep, ls) to make progress.',
          },
        ];
        if (turns >= maxTurns) stoppedBecause = 'budget';
        continue;
      }
      noToolStreak = 0;
      degenerateStreak = 0;

      const toolResults = [];
      for (const call of toolCalls) {
        if (call.name === 'bru') bruCalls += 1;
        const toolStartedAt = Date.now();
        // eslint-disable-next-line no-await-in-loop
        const outcome = await runTool(sandbox, call);
        const ms = Date.now() - toolStartedAt;
        toolResults.push({ id: call.id, name: call.name, output: truncateToBytes(outcome.content, TOOL_RESULT_MAX_BYTES), ms });
        messages = [...messages, { role: 'tool', toolCallId: call.id, name: call.name, content: outcome.content, isError: outcome.isError }];
        // Addendum Q rule 13 counters -- see touchesSkillDoc()'s comment above for what counts.
        if (call.name === 'write_file' && !outcome.isError && SCRIPT_EXT_RE.test(String((call.input && call.input.path) || ''))) {
          codeWrites += 1;
        }
        if (
          (call.name === 'read_file' || call.name === 'grep') &&
          touchesSkillDoc(sandboxDir, call.input && call.input.path, 'SKILL.md')
        ) {
          docReads += 1;
        }
      }
      transcriptEntry.toolResults = toolResults;

      // eslint-disable-next-line no-await-in-loop
      const subsBody = await adminGet(adminBase, '/admin/submissions', adminToken);
      const subs = subsBody.data || [];
      if (subs.length > lastSubmissionCount) {
        for (let i = lastSubmissionCount; i < subs.length; i += 1) {
          const s = subs[i];
          submissions.push(s);
          if (s.pass) {
            if (s.rung >= topRung) {
              stoppedBecause = 'top';
              break turnLoop;
            }
            // eslint-disable-next-line no-await-in-loop
            const advanced = await adminPost(adminBase, '/admin/rungs/advance', undefined, adminToken);
            const newRung = advanced && typeof advanced.current === 'number' ? advanced.current : s.rung + 1;
            // Addendum Q rule 4: a dated mid-ladder amendment lands on disk the moment the
            // ladder reaches its rung, before the agent's next turn (and so before it can ever
            // ask for that rung's text). amendmentsAt() is world.js's own canonical resolver for
            // "what amendment(s) does this rung announce" (AMENDMENTS_ENFORCED is false today, so
            // makeWorld() hands back an empty `amendments` array and this is a no-op in every real
            // run until that flips -- see world.js's own doc comment on the flag).
            const amendments = amendmentsAt(world, newRung);
            if (amendments.length > 0) {
              // eslint-disable-next-line no-await-in-loop
              await sandbox.writeFile('SKILL.md', toSkill(world, { mode: 'sloppy', atRung: newRung, targetBytes: skillBytes }));
              transcript.push({
                turn: turns,
                amendments: amendments.map((a) => ({ atRung: a.atRung, rule: a.rule, from: a.from, to: a.to })),
              });
            }
          } else {
            stoppedBecause = 'fail';
            break turnLoop;
          }
        }
        lastSubmissionCount = subs.length;
      }

      // Addendum J: "Turn cap. 5000 bru requests per run, reported as stoppedBecause: 'turns'."
      // Checked AFTER the submissions poll just above so a run that happened to submit on its
      // very last permitted bru call is still recorded as 'top'/'fail' from that submission; this
      // only fires when the cap is hit without a decisive submission in the same turn.
      if (bruCalls >= maxBruCalls) {
        stoppedBecause = 'turns';
        break turnLoop;
      }

      if (turns >= maxTurns) stoppedBecause = 'budget';
    }

    const wallMs = now() - startedAt;
    const passedNs = submissions.filter((s) => s.pass).map((s) => s.rung);
    const rung = passedNs.length ? Math.max(...passedNs) : -1;
    const fidelityScores = submissions.map((s) => s.fidelity).filter((v) => typeof v === 'number');
    const fidelity = fidelityScores.length ? fidelityScores.reduce((a, b) => a + b, 0) / fidelityScores.length : 0;

    const collectionDir = path.join(runDir, 'collection');
    await copyCollection(sandboxDir, collectionDir);
    const trap = await computeTrap(world, collectionDir);

    // Addendum F: violations are counted from the admin log's User-Agent check, published by the
    // [api] workstream at `GET /admin/violations`. Read defensively -- adminGet never throws on a
    // non-2xx (it just returns whatever JSON body came back), so an instance that doesn't
    // implement the route yet reports 0 rather than crashing the run.
    //
    // Addendum J extends the same response with two harness-consumed fields, both read the same
    // defensive way and both defaulting to empty/zero until [api]'s admin.js emits them: `samples`
    // (up to 20 `{ua, method, path}` violation samples, persisted here so a violation is still
    // readable after the server that saw it is gone) and `adminProbes` (a count of requests to the
    // ADMIN port itself that skipped or forged X-Admin-Token -- never something this harness's own
    // calls above can produce, since they always send the real token; only a sandboxed script
    // reaching for the admin port directly can generate one).
    let violations = 0;
    let violationSamples = [];
    let adminProbes = 0;
    // Addendum K: `scriptRequests` counts admin-log hits whose User-Agent is `axios/*` -- bru's
    // own pre/post-request script sandbox, not the agent bypassing bru -- kept separate from
    // `violations` (a User-Agent that is neither `bruno-runtime/*` nor `axios/*`) and never
    // voids a run.
    let scriptRequests = 0;
    let scriptSamples = [];
    try {
      const violationsBody = await adminGet(adminBase, '/admin/violations', adminToken);
      if (typeof violationsBody.count === 'number') violations = violationsBody.count;
      else if (Array.isArray(violationsBody.data)) violations = violationsBody.data.length;
      if (Array.isArray(violationsBody.samples)) {
        violationSamples = violationsBody.samples.slice(0, 20).map((s) => ({
          ua: s && s.ua != null ? s.ua : null,
          method: s && s.method != null ? s.method : null,
          path: s && s.path != null ? s.path : null,
        }));
      }
      if (typeof violationsBody.scriptRequests === 'number') scriptRequests = violationsBody.scriptRequests;
      if (Array.isArray(violationsBody.scriptSamples)) {
        scriptSamples = violationsBody.scriptSamples.slice(0, 20).map((s) => ({
          ua: s && s.ua != null ? s.ua : null,
          method: s && s.method != null ? s.method : null,
          path: s && s.path != null ? s.path : null,
        }));
      }
      if (typeof violationsBody.adminProbes === 'number') adminProbes = violationsBody.adminProbes;
    } catch {
      violations = 0;
    }

    // Addendum J: "any adminProbe voids the run" -- overrides whatever stoppedBecause the climb
    // otherwise earned (even 'top'), because a probe means the sandbox reached for admin-level
    // control (skip rungs, reset state, read the answer key) rather than solving the ladder.
    if (adminProbes > 0) stoppedBecause = 'voided-admin-probe';

    const result = {
      // Addendum G: the board groups rows by ladder version, so every run records the ladder it
      // actually climbed (see run-cli.js for the same stamp on the CLI path).
      version: LADDER_VERSION,
      model: model || driverName,
      // Addendum F: which driver produced this run -- message-loop drivers here (anthropic,
      // openai, openrouter, xai, deepseek); the `cli:*` drivers under src/harness/cli/ are a
      // separate workstream and report their own value for this field.
      driver: driverName || null,
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
      // Addendum P: total gap time folded out of the wall check as "the machine slept," not the
      // agent working -- 0 for every ordinary run, nonzero only when a turn-to-turn gap exceeded
      // SUSPEND_GAP_MS (5 minutes).
      suspendedMs,
      fidelity,
      trap,
      submissions,
      stoppedBecause,
      driverError,
      // Addendum F fields. The message-loop path here never resumes a killed session (that's the
      // CLI drivers' job) and always has real, not estimated, provider usage, so those two are
      // fixed; violations comes from the admin log above; modelMismatch has nothing to compare
      // against outside the CLI drivers (which check the tool's own reported model against what
      // was requested) so it stays false here.
      violations,
      violationSamples,
      // Addendum K: axios/* admin-log hits -- bru's own script sandbox, not a rule violation.
      scriptRequests,
      scriptSamples,
      adminProbes,
      // Addendum K: the max_tokens the message-loop driver ended up using this run, after any
      // halve-and-retry the provider forced (see resolveDriver/createDriver below); falls back to
      // the configured request value when the driver never exposes what it settled on (a test's
      // hand-built fake driver, for instance).
      maxOutputTokens: driver && typeof driver.maxOutputTokens === 'number' ? driver.maxOutputTokens : maxOutputTokens,
      resumes: 0,
      modelMismatch: false,
      usageEstimated: false,
      // Addendum Q rule 13: exact for the message-loop driver (every tool call is seen directly).
      codeWrites,
      docReads,
    };

    await writeFile(path.join(runDir, 'transcript.jsonl'), `${transcript.map((t) => JSON.stringify(t)).join('\n')}\n`);
    await writeFile(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));

    return result;
  } finally {
    await server.stop();
  }
}
