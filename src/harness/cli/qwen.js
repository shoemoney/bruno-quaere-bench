// Addendum F adapter: qwen3.8-max driven as a native CLI via qwen-code.
//
//   qwen --approval-mode yolo -o json -m <model> -p "<prompt>"
//
// Isolation: HOME points at a fresh, per-run directory (so ~/.qwen/settings.json, chat history,
// and extensions from the operator's real home never leak into a climb), but auth is env-var
// based (auth-type "openai") rather than a file under HOME -- Addendum F: "source ~/.qwen/.env
// into env, HOME fresh". build() reads that dotenv file itself (fs, no shell `source`, no deps)
// and merges it into the child's env.
//
// Invocation and output shape verified live 2026-09-12, qwen-code 0.23.3: `-o json` prints ONE
// JSON array of session events to stdout; the last `{"type":"result"}` element carries `usage`
// (input_tokens/output_tokens/cache_read_input_tokens), `session_id`, and `stats.models` keyed by
// the model name the CLI actually used. See test/fixtures/cli-qwen-usage.json, a real captured run.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const name = 'qwen';

const DEFAULT_ENV_FILE = path.join(os.homedir(), '.qwen', '.env');

function requireOpt(opts, key, label) {
  if (!opts || !opts[key]) throw new Error(`qwen adapter: ${label || key} is required`);
  return opts[key];
}

// Minimal dotenv: KEY=VALUE per line, '#' comments, optional matching quotes. No interpolation,
// no multiline values -- ~/.qwen/.env only ever holds OPENAI_API_KEY/OPENAI_BASE_URL/OPENAI_MODEL.
function parseDotEnv(text) {
  const out = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
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

// Exported so tests can point it at a fixture dotenv file instead of the operator's real
// ~/.qwen/.env. Returns {} (never throws) when the file is absent.
export function readQwenEnv(envPath = DEFAULT_ENV_FILE) {
  let text;
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch {
    return {};
  }
  return parseDotEnv(text);
}

function buildEnv(home, envPath) {
  return { ...readQwenEnv(envPath), HOME: path.resolve(home), QWEN_CODE_SUPPRESS_YOLO_WARNING: '1' };
}

// build({sandbox, prompt, model, home, envPath?}) -> {cmd, args, env, cwd}. `envPath` (default
// ~/.qwen/.env) is an optional override, same spirit as the codex adapter's `copyAuth({from})` --
// lets a test point it at a fixture dotenv instead of the operator's real one.
export function build(opts = {}) {
  const sandbox = requireOpt(opts, 'sandbox');
  const prompt = requireOpt(opts, 'prompt');
  const model = requireOpt(opts, 'model');
  const home = requireOpt(opts, 'home', 'home (fresh HOME)');
  return {
    cmd: 'qwen',
    args: ['--approval-mode', 'yolo', '-o', 'json', '-m', model, '-p', prompt],
    env: buildEnv(home, opts.envPath),
    cwd: sandbox,
  };
}

// resume(sessionId, {sandbox, prompt, model, home}) -> {cmd, args, env, cwd}. `qwen --resume
// <id>` (Addendum F: "qwen ... `--resume` where supported"); the id is the `session_id` field
// parseUsage() below reads off a prior invocation's JSON result.
export function resume(sessionId, opts = {}) {
  if (!sessionId) throw new Error('qwen adapter: resume() needs a session id');
  const sandbox = requireOpt(opts, 'sandbox');
  const prompt = requireOpt(opts, 'prompt');
  const model = requireOpt(opts, 'model');
  const home = requireOpt(opts, 'home', 'home (fresh HOME)');
  return {
    cmd: 'qwen',
    args: ['--approval-mode', 'yolo', '-o', 'json', '--resume', sessionId, '-m', model, '-p', prompt],
    env: buildEnv(home, opts.envPath),
    cwd: sandbox,
  };
}

// parseUsage(stdout, home?) -> {tokensIn, tokensCached, tokensOut, modelVersion, usageEstimated,
// sessionId}. `home` is accepted (unused) to match the shared adapter signature -- qwen's usage
// is entirely self-contained in the `-o json` result, unlike kimi's.
export function parseUsage(stdout, home) { // eslint-disable-line no-unused-vars
  let events;
  try {
    events = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`qwen adapter: -o json output was not valid JSON: ${err.message}`);
  }
  const list = Array.isArray(events) ? events : [events];
  const result = [...list].reverse().find((e) => e && e.type === 'result');
  if (!result) {
    throw new Error('qwen adapter: no {"type":"result"} event found in -o json output');
  }
  const usage = result.usage || {};
  const modelKeys = Object.keys((result.stats && result.stats.models) || {});
  return {
    tokensIn: usage.input_tokens || 0,
    tokensCached: usage.cache_read_input_tokens || 0,
    tokensOut: usage.output_tokens || 0,
    modelVersion: modelKeys[0] || null,
    usageEstimated: false,
    sessionId: result.session_id || null,
  };
}
