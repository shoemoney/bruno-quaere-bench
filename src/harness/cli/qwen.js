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

// parseFromStdout(stdout) -> the same shape as parseUsage(), or throws. Split out from parseUsage()
// so the drained-result / session-file fallback below (Addendum G) has something to catch around.
function parseFromStdout(stdout) {
  let events;
  try {
    events = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`qwen adapter: -o json output was not valid JSON: ${err.message}`);
  }
  return resultFromEvents(Array.isArray(events) ? events : [events], 'qwen adapter');
}

// resultFromEvents(events, label) -> the parsed usage shape, or throws `${label}: no {"type":
// "result"} event found`. Shared between parsing a fresh -o json stdout and scanning a session
// file for the same event shape (Addendum G's fallback below re-uses this rather than
// re-implementing the {"type":"result"} search).
function resultFromEvents(events, label) {
  const result = [...events].reverse().find((e) => e && e.type === 'result');
  if (!result) {
    throw new Error(`${label}: no {"type":"result"} event found`);
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

// findQwenSessionFiles(home) -> path[]. qwen-code (Addendum F: HOME points at the isolated `home`
// for this adapter) keeps its own session/chat state under `$HOME/.qwen`; unlike kimi-code's
// sessions directory (Addendum F/kimi.js, verified live against an installed CLI), the exact
// on-disk layout here has not been captured against a live qwen-code install, so this walks the
// whole `.qwen` tree for any `.json`/`.jsonl` file rather than assuming one fixed path -- a
// {"type":"result"} event (the same shape -o json prints, see resultFromEvents above) is what's
// actually being searched for, wherever qwen-code happens to persist it.
function findQwenSessionFiles(home) {
  const root = path.join(home, '.qwen');
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl'))) out.push(full);
    }
  }
  walk(root);
  return out;
}

// readUsageFromQwenSessions(home) -> usage shape, or null. Addendum G's fallback for `qwen`: when
// the CLI got killed before its -o json stdout carried a usable {"type":"result"} event, look for
// the same event shape in whatever qwen-code already wrote under `$HOME/.qwen` -- tries the most
// recently modified candidate file first (whole-file JSON, array or object, else newline-delimited
// JSON), moving on to the next file if a candidate doesn't parse or has no result event.
// readUsageFromQwenUsageRecord(home) -> usage shape, or null. The precise, live-captured half of
// the fallback below: qwen-code writes `$HOME/.qwen/usage_record.jsonl`, ONE line per finished
// session, carrying `sessionId` and a `models` map keyed by the model it actually used
// ({requests, inputTokens, outputTokens, cachedTokens, thoughtsTokens, totalTokens}) -- the same
// per-model breakdown `-o json`'s `stats.models` carries, already summed over the whole session.
// Captured from a real killed rung-0 run (qwen exits on SIGTERM printing only a
// FatalCancellationError on stderr, with stdout empty), so this is the file that actually rescues
// a fallen run's tokens and model, not the generic {"type":"result"} search below.
//
// The last line is the newest session; the isolated home is fresh per run, so that is this run's.
export function readUsageFromQwenUsageRecord(home) {
  let text;
  try {
    text = fs.readFileSync(path.join(home, '.qwen', 'usage_record.jsonl'), 'utf8');
  } catch {
    return null;
  }
  let latest = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry && entry.models && Object.keys(entry.models).length > 0) latest = entry;
    } catch {
      // a partially-written last line from a killed process is skipped, not fatal
    }
  }
  if (!latest) return null;
  const modelKeys = Object.keys(latest.models);
  const totals = modelKeys.reduce(
    (acc, key) => {
      const m = latest.models[key] || {};
      acc.input += m.inputTokens || 0;
      acc.output += m.outputTokens || 0;
      acc.cached += m.cachedTokens || 0;
      acc.thoughts += m.thoughtsTokens || 0;
      return acc;
    },
    { input: 0, output: 0, cached: 0, thoughts: 0 },
  );
  return {
    tokensIn: totals.input,
    tokensCached: totals.cached,
    // thoughtsTokens is billed reasoning with no visible text -- output-side spend, same call the
    // gemini adapter makes.
    tokensOut: totals.output + totals.thoughts,
    modelVersion: modelKeys[0],
    usageEstimated: false,
    sessionId: latest.sessionId || null,
  };
}

export function readUsageFromQwenSessions(home) {
  // The live-verified path first; the generic {"type":"result"} sweep below stays as the backstop
  // for a qwen-code build that does not write usage_record.jsonl.
  const fromUsageRecord = readUsageFromQwenUsageRecord(home);
  if (fromUsageRecord) return fromUsageRecord;
  const files = findQwenSessionFiles(home);
  if (files.length === 0) return null;
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const events = [];
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) events.push(...parsed);
      else events.push(parsed);
    } catch {
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          events.push(JSON.parse(trimmed));
        } catch {
          // a partially-written line from a killed process is skipped, not fatal
        }
      }
    }
    try {
      return resultFromEvents(events, 'qwen adapter session file');
    } catch {
      // no result event in this candidate -- try the next most recent file, if any
    }
  }
  return null;
}

// parseUsage(stdout, home?) -> {tokensIn, tokensCached, tokensOut, modelVersion, usageEstimated,
// sessionId}. Addendum G: when stdout doesn't carry a usable {"type":"result"} event (typically a
// drained-but-still-truncated result from a killed process), falls back to
// readUsageFromQwenSessions(home) before giving up. `home` is optional -- omitting it (or a
// stdout failure with nothing found under it) reproduces the original behavior exactly: throw.
export function parseUsage(stdout, home) {
  try {
    return parseFromStdout(stdout);
  } catch (err) {
    if (home) {
      const fromSession = readUsageFromQwenSessions(home);
      if (fromSession) return fromSession;
    }
    throw err;
  }
}
