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
export function parseUsage(stdout, home) { // eslint-disable-line no-unused-vars
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
