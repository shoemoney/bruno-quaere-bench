// Addendum F adapter: gemini-3.8-flash driven as a native CLI via the Gemini CLI.
//
//   gemini -y -o json -m <model> -p "<prompt>"
//
// Auth: GEMINI_API_KEY, fetched fresh from aigate (provider "google") rather than read off disk,
// so the key never sits in a dotfile the sandbox could leak. Uses the add-key skill's own fetch
// recipe: source ~/.claude/aigate/env for AIGATE_URL/AIGATE_TOKEN, then
// GET $AIGATE_URL/api/keys/google -> {provider, label, key}. Never logged, never thrown into an
// error message. build() is therefore async (a real HTTP call), unlike its siblings.
//
// Invocation and output shape verified live 2026-09-12, @google/gemini-cli 0.59.0: `-o json`
// prints one JSON object to stdout (banners/YOLO notices go to stderr -- confirmed by capturing
// stdout/stderr separately, stdout alone is valid JSON) carrying `session_id` and `stats.models`
// keyed by the model name the CLI actually used.
//
// --- Investigated: the smoke test's gemini-3.8-flash -> gemini-3.5-flash mismatch -------------
// Reproduced directly against the installed CLI (0.59.0) and root-caused in its own bundle
// (packages/core/dist/src/config/models.js, inlined into
// /opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/chunk-YSBB75DZ.js):
//   - VALID_GEMINI_MODELS in this build tops out at "gemini-3.5-flash" / the 3.1 preview family.
//     "gemini-3.8-flash" (an OpenRouter-catalog id, picked for the Addendum C calibration lineup)
//     is not a literal this CLI build knows.
//   - resolveModel()'s default case keeps an unrecognized id as-is, BUT a later guard fires for
//     ANY name ending in "flash": `isFlashModel(resolved)` is `model.endsWith('flash')`, and when
//     that's true and `useGemini3_5Flash` is set (an account/build entitlement flag) the resolver
//     substitutes DEFAULT_GEMINI_FLASH_MODEL regardless of what was asked for, unless the exact
//     literal happens to equal PREVIEW_GEMINI_FLASH_MODEL ("gemini-3-flash-preview").
//   - Confirmed empirically: requesting "gemini-3.8-flash" AND requesting the real, current
//     "gemini-2.5-flash" both came back with stats.models key "gemini-3.5-flash" on this account;
//     requesting the exact literal "gemini-3.5-flash" round-tripped clean (no substitution).
//   - Resolution: this is not fixable from a CLI flag (no "--exact-model" escape hatch in
//     `gemini --help`) or from this adapter -- it is the installed gemini-cli build silently
//     aliasing every *-flash request it doesn't literally recognize to its own current default
//     flash model. Per Addendum F ("never silently accept a fallback model") the correct handling
//     is exactly what this adapter does: report the reported id as `modelVersion` so the caller
//     (which already knows the requested model, since it's what it passed to build()) can flag
//     `modelMismatch` itself. The operational fix is either (a) request "gemini-3.5-flash"
//     directly until an installed CLI build recognizes "gemini-3.8-flash" as a literal, or
//     (b) upgrade `@google/gemini-cli` past 0.59.0 once such a build ships.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const name = 'gemini';

const DEFAULT_AIGATE_ENV_FILE = path.join(os.homedir(), '.claude', 'aigate', 'env');
const DEFAULT_AIGATE_BASE_URL = 'https://aigate.shoemoney.ai';

function requireOpt(opts, key, label) {
  if (!opts || !opts[key]) throw new Error(`gemini adapter: ${label || key} is required`);
  return opts[key];
}

// Same tiny dotenv shape as ~/.claude/aigate/env (KEY=VALUE, optional `export ` prefix and
// matching quotes per the add-key skill's own description of the file).
function parseDotEnv(text) {
  const out = {};
  for (const rawLine of text.split('\n')) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    out[key] = value;
  }
  return out;
}

// fetchGeminiApiKey({envPath?, baseUrl?, fetchImpl?}) -> Promise<string>. The add-key skill's
// curl recipe, in fetch(): source ~/.claude/aigate/env for the bearer, then
// GET <base>/api/keys/google -> {provider, label, key}. Throws (never logs the key or the
// bearer) if the env file is missing, the bearer is absent, or aigate has no working google key.
export async function fetchGeminiApiKey({
  envPath = DEFAULT_AIGATE_ENV_FILE,
  baseUrl,
  fetchImpl = fetch,
} = {}) {
  let envText;
  try {
    envText = fs.readFileSync(envPath, 'utf8');
  } catch (err) {
    throw new Error(`gemini adapter: could not read aigate env at ${envPath}: ${err.message}`);
  }
  const env = parseDotEnv(envText);
  const token = env.AIGATE_TOKEN;
  if (!token) {
    throw new Error(`gemini adapter: ${envPath} has no AIGATE_TOKEN`);
  }
  const base = (baseUrl || env.AIGATE_URL || DEFAULT_AIGATE_BASE_URL).replace(/\/$/, '');
  const res = await fetchImpl(`${base}/api/keys/google`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`gemini adapter: aigate GET /api/keys/google -> ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  if (!data || typeof data.key !== 'string' || !data.key) {
    throw new Error('gemini adapter: aigate returned no working key for provider "google"');
  }
  return data.key;
}

function buildEnv(home, apiKey) {
  return { HOME: path.resolve(home), GEMINI_API_KEY: apiKey, GEMINI_CLI_TRUST_WORKSPACE: 'true' };
}

function aigateOpts(opts) {
  return { envPath: opts.aigateEnvPath, baseUrl: opts.aigateBaseUrl, fetchImpl: opts.aigateFetch };
}

// build({sandbox, prompt, model, home, aigateEnvPath?, aigateBaseUrl?, aigateFetch?}) ->
// Promise<{cmd, args, env, cwd}>. Async because fetching the key is a real HTTP call. The three
// `aigate*` keys are optional overrides passed straight through to fetchGeminiApiKey() -- same
// spirit as the codex adapter's `copyAuth({from})` -- so a test can point them at a fixture env
// file and a fake fetch instead of the operator's real aigate.
export async function build(opts = {}) {
  const sandbox = requireOpt(opts, 'sandbox');
  const prompt = requireOpt(opts, 'prompt');
  const model = requireOpt(opts, 'model');
  const home = requireOpt(opts, 'home', 'home (fresh HOME)');
  const apiKey = await fetchGeminiApiKey(aigateOpts(opts));
  return {
    cmd: 'gemini',
    args: ['-y', '-o', 'json', '-m', model, '-p', prompt],
    env: buildEnv(home, apiKey),
    cwd: sandbox,
  };
}

// resume(sessionId, {sandbox, prompt, model, home, aigate*?}) -> Promise<{cmd, args, env, cwd}>.
// `gemini --resume <id>` (Addendum F: "gemini ... `--resume` where supported"); the id is the
// top-level `session_id` field parseUsage() below reads off a prior invocation's JSON result.
export async function resume(sessionId, opts = {}) {
  if (!sessionId) throw new Error('gemini adapter: resume() needs a session id');
  const sandbox = requireOpt(opts, 'sandbox');
  const prompt = requireOpt(opts, 'prompt');
  const model = requireOpt(opts, 'model');
  const home = requireOpt(opts, 'home', 'home (fresh HOME)');
  const apiKey = await fetchGeminiApiKey(aigateOpts(opts));
  return {
    cmd: 'gemini',
    args: ['-y', '-o', 'json', '--resume', sessionId, '-m', model, '-p', prompt],
    env: buildEnv(home, apiKey),
    cwd: sandbox,
  };
}

// parseUsage(stdout, home?) -> {tokensIn, tokensCached, tokensOut, modelVersion, usageEstimated,
// sessionId}. `home` is accepted (unused) to match the shared adapter signature -- gemini's usage
// is entirely self-contained in the `-o json` result, unlike kimi's.
//
// `stats.models` can (rarely) carry more than one key in a single response (e.g. a classifier
// sub-call on a different model) -- token totals sum across every key; `modelVersion` is the
// first key, which is the main turn's model in every captured fixture.
function parseFromStdout(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`gemini adapter: -o json output was not valid JSON: ${err.message}`);
  }
  const models = (data.stats && data.stats.models) || {};
  const modelKeys = Object.keys(models);
  const totals = modelKeys.reduce(
    (acc, key) => {
      const t = models[key].tokens || {};
      acc.prompt += t.prompt || 0;
      acc.candidates += t.candidates || 0;
      acc.thoughts += t.thoughts || 0;
      acc.cached += t.cached || 0;
      return acc;
    },
    { prompt: 0, candidates: 0, thoughts: 0, cached: 0 },
  );
  return {
    // `prompt` already includes `cached` (verified: input + cached === prompt on every captured
    // fixture), matching the other drivers' input_tokens semantics.
    tokensIn: totals.prompt,
    tokensCached: totals.cached,
    // `candidates` is the visible reply; `thoughts` is billed reasoning tokens with no visible
    // text -- both are real output-side spend.
    tokensOut: totals.candidates + totals.thoughts,
    modelVersion: modelKeys[0] || null,
    usageEstimated: false,
    sessionId: data.session_id || null,
  };
}

// Every chat transcript gemini wrote under this isolated home, newest-modified first:
// `$HOME/.gemini/tmp/<project>/chats/session-<ts><id>.jsonl`.
function geminiChatFiles(home) {
  const tmpDir = path.join(home, '.gemini', 'tmp');
  const files = [];
  let projects;
  try {
    projects = fs.readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const chatsDir = path.join(tmpDir, project.name, 'chats');
    let names;
    try {
      names = fs.readdirSync(chatsDir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const full = path.join(chatsDir, n);
      try {
        files.push({ full, mtimeMs: fs.statSync(full).mtimeMs });
      } catch {
        // raced with the CLI's own cleanup; skip
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.map((f) => f.full);
}

// readUsageFromGeminiSessions(home) -> the parseUsage shape, or null. Addendum G: "Gemini's
// reported model must be captured from the drained result, not left null." Gemini exits 0 on
// SIGTERM WITHOUT printing its `-o json` result at all (verified live: stdout empty, exit code 0,
// killedFor 'top'), so the drain alone cannot rescue it -- but the same session it just ran is on
// disk in its own chat transcript, one JSON object per line.
//
// Shape captured from a live killed run, not reconstructed: `{"$set":{"messages":[...]}}` lines
// rewrite the whole message list, plain message lines append to it, and each assistant message
// (`type: 'gemini'`) carries `model` plus `tokens: {input, output, cached, thoughts, tool,
// total}`. The same message id is written TWICE (a streaming update, then the final), so ids are
// deduped. `tokens.input`/`cached` are running context totals (monotonically increasing across
// the session, matching `-o json`'s `stats.models[*].tokens.prompt`), so the last message wins
// for those; `output`/`thoughts` are per-message spend and are summed.
export function readUsageFromGeminiSessions(home) {
  if (!home) return null;
  for (const file of geminiChatFiles(home)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let sessionId = null;
    const seen = new Set();
    let tokensOut = 0;
    let lastInput = 0;
    let lastCached = 0;
    let modelVersion = null;
    const take = (m) => {
      if (!m || typeof m !== 'object' || m.type !== 'gemini') return;
      if (m.id && seen.has(m.id)) return;
      if (m.id) seen.add(m.id);
      const t = m.tokens || {};
      tokensOut += (t.output || 0) + (t.thoughts || 0);
      if (t.input) lastInput = t.input;
      if (t.cached) lastCached = t.cached;
      if (m.model) modelVersion = m.model;
    };
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue; // partially-written last line from a killed process
      }
      if (entry.sessionId) sessionId = entry.sessionId;
      if (entry.$set && Array.isArray(entry.$set.messages)) {
        for (const m of entry.$set.messages) take(m);
      } else {
        take(entry);
      }
    }
    if (!modelVersion && tokensOut === 0 && lastInput === 0) continue;
    return { tokensIn: lastInput, tokensCached: lastCached, tokensOut, modelVersion, usageEstimated: false, sessionId };
  }
  return null;
}

// parseUsage(stdout, home?) -> the shape above. stdout first; on a killed run (empty or truncated
// stdout) fall back to the isolated home's own chat transcript so the run still reports real
// tokens and a real model instead of nulls.
export function parseUsage(stdout, home) {
  try {
    return parseFromStdout(stdout);
  } catch (err) {
    const fromSession = readUsageFromGeminiSessions(home);
    if (fromSession) return fromSession;
    throw err;
  }
}
