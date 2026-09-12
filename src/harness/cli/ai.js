// Addendum F adapter: claude-fable-5.1 (or any model reachable through the `ai` wrapper around
// Claude Code) driven as a native CLI, not a message-loop driver.
//
//   AI_NO_RTK=1 ai --no-chrome -p "<prompt>" --model <model> --output-format json
//
// Isolation: CLAUDE_CONFIG_DIR points at a fresh, per-run directory (the aigate warden still
// authenticates through it -- this only isolates SESSION/config state across runs, never auth).

import fs from 'node:fs';
import path from 'node:path';

export const name = 'ai';

function requireOpt(opts, key, label) {
  if (!opts || !opts[key]) throw new Error(`ai adapter: ${label || key} is required`);
  return opts[key];
}

// build({sandbox, prompt, model, home}) -> {cmd, args, env, cwd}
export function build(opts = {}) {
  const sandbox = requireOpt(opts, 'sandbox');
  const prompt = requireOpt(opts, 'prompt');
  const model = requireOpt(opts, 'model');
  const home = requireOpt(opts, 'home', 'home (fresh CLAUDE_CONFIG_DIR)');
  return {
    cmd: 'ai',
    args: ['--no-chrome', '-p', prompt, '--model', model, '--output-format', 'json'],
    env: { CLAUDE_CONFIG_DIR: path.resolve(home), AI_NO_RTK: '1' },
    cwd: sandbox,
  };
}

// resume(sessionId, {sandbox, prompt, model, home}) -> {cmd, args, env, cwd}, the same shape as
// build(). `claude --resume <session_id> via -p` (Addendum F): the id is the `session_id` field
// parseUsage() below reads off a prior invocation's JSON result.
export function resume(sessionId, opts = {}) {
  if (!sessionId) throw new Error('ai adapter: resume() needs a session id');
  const sandbox = requireOpt(opts, 'sandbox');
  const prompt = requireOpt(opts, 'prompt');
  const model = requireOpt(opts, 'model');
  const home = requireOpt(opts, 'home', 'home (fresh CLAUDE_CONFIG_DIR)');
  return {
    cmd: 'ai',
    args: ['--no-chrome', '--resume', sessionId, '-p', prompt, '--model', model, '--output-format', 'json'],
    env: { CLAUDE_CONFIG_DIR: path.resolve(home), AI_NO_RTK: '1' },
    cwd: sandbox,
  };
}

// parseFromStdout(stdout) -> the same shape as parseUsage(), or throws. Split out from parseUsage()
// so the drained-result fallback below (Addendum G) has something to catch around.
function parseFromStdout(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`ai adapter: could not parse --output-format json stdout as JSON: ${err.message}`);
  }
  // Newer `ai`/Claude Code builds emit --output-format json as an ARRAY of stream events
  // (rate_limit_event, system, assistant..., result) rather than the single result object the
  // fixture captured. The usage-bearing object is the final `result` event either way.
  if (Array.isArray(data)) {
    const events = data.filter((e) => e && typeof e === 'object');
    data = [...events].reverse().find((e) => e.type === 'result' && e.usage) || events[events.length - 1] || {};
  }
  if (!data.usage) {
    // Addendum G: a process SIGTERMed/SIGKILLed mid-write (a fall/top/wall/overshoot kill that
    // outran even the drain window) can leave stdout as VALID json with no usage-bearing event at
    // all (e.g. only a `system` init event ever got flushed). That is functionally the same
    // failure as unparsable stdout -- throw so the caller's session-file fallback gets a chance.
    throw new Error('ai adapter: --output-format json stdout carried no usage-bearing event');
  }
  const usage = data.usage;
  const tokensIn = usage.input_tokens || 0;
  const tokensOut = usage.output_tokens || 0;
  // cache_read + cache_creation both count as "already paid for" context, not novel input.
  const tokensCached = (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);

  // modelUsage can carry more than one entry (e.g. a haiku helper alongside the model that did the
  // actual work). Prefer whichever entry's own counters match top-level usage; fall back to the
  // one with the most output tokens, since a helper's contribution is typically tiny by comparison.
  const modelUsage = data.modelUsage || {};
  const modelIds = Object.keys(modelUsage);
  let modelVersion = null;
  if (modelIds.length === 1) {
    [modelVersion] = modelIds;
  } else if (modelIds.length > 1) {
    const exact = modelIds.find(
      (id) => modelUsage[id].inputTokens === tokensIn && modelUsage[id].outputTokens === tokensOut,
    );
    modelVersion =
      exact || modelIds.reduce((a, b) => (modelUsage[b].outputTokens > modelUsage[a].outputTokens ? b : a));
  }

  return {
    tokensIn,
    tokensCached,
    tokensOut,
    modelVersion,
    usageEstimated: false,
    sessionId: data.session_id || null,
    costUsd: typeof data.total_cost_usd === 'number' ? data.total_cost_usd : null,
  };
}

// readUsageFromClaudeSessions(home) -> usage shape, or null. Addendum G's fallback for `ai`: when
// the CLI got killed (drained or not) before its --output-format json result printed a usable
// usage event, the same numbers are already durable on disk -- Claude Code's own session
// transcripts under `$CLAUDE_CONFIG_DIR/projects/<project-slug>/<session-id>.jsonl`, one JSON
// object per line, assistant turns carrying `message.usage` (the same input_tokens/output_tokens/
// cache_read_input_tokens/cache_creation_input_tokens shape as the --output-format json result
// above) and `message.model`. `home` here IS `$CLAUDE_CONFIG_DIR` (ai.js's build() sets
// CLAUDE_CONFIG_DIR to the isolated `home` directory), so the search root is `<home>/projects`.
//
// Not captured against a live truncated-output fixture (unlike kimi.js's wire.jsonl reading,
// which was): this is Claude Code's own well-known transcript format, reconstructed from that
// rather than from a fixture. Sums every assistant usage event across the session (a session can
// span several turns/tool-calls, and cache tokens especially only make sense summed across the
// whole thing) and takes the model off the LAST assistant event, matching "the model the tool
// actually reports" for whichever turn ran most recently.
export function readUsageFromClaudeSessions(home) {
  const projectsDir = path.join(home, 'projects');
  let projectEntries;
  try {
    projectEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const files = [];
  for (const entry of projectEntries) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(projectsDir, entry.name);
    let sessionFiles;
    try {
      sessionFiles = fs.readdirSync(projectDir);
    } catch {
      continue;
    }
    for (const f of sessionFiles) {
      if (f.endsWith('.jsonl')) files.push(path.join(projectDir, f));
    }
  }
  if (files.length === 0) return null;
  // Several sessions can exist under a fresh, per-run CLAUDE_CONFIG_DIR (a resume writes a new
  // session file rather than appending); the most recently modified one is this spawn's own.
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  let text;
  try {
    text = fs.readFileSync(files[0], 'utf8');
  } catch {
    return null;
  }
  let tokensIn = 0;
  let tokensOut = 0;
  let tokensCached = 0;
  let modelVersion = null;
  let sessionId = null;
  let sawUsage = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // a partially-written last line from a killed process is skipped, not fatal
    }
    if (entry.sessionId) sessionId = entry.sessionId;
    const msg = entry.message;
    if (msg && msg.role === 'assistant' && msg.usage) {
      sawUsage = true;
      tokensIn += msg.usage.input_tokens || 0;
      tokensOut += msg.usage.output_tokens || 0;
      tokensCached += (msg.usage.cache_read_input_tokens || 0) + (msg.usage.cache_creation_input_tokens || 0);
      if (msg.model) modelVersion = msg.model;
    }
  }
  if (!sawUsage) return null;
  return { tokensIn, tokensCached, tokensOut, modelVersion, usageEstimated: false, sessionId, costUsd: null };
}

// parseUsage(stdout, home?) -> {tokensIn, tokensCached, tokensOut, modelVersion, usageEstimated,
// sessionId, costUsd}. `stdout` is the whole captured stdout of one `--output-format json`
// invocation: a single JSON object carrying `usage`, `modelUsage` (per-model breakdown, keyed by
// canonical model id -- Addendum F: "Every adapter records the model the tool actually reports"),
// and `total_cost_usd`. Shape verified against a live fixture, see test/fixtures/cli-ai-usage.json.
//
// Addendum G: when stdout doesn't parse into a usable usage event (typically a drained-but-still-
// truncated result from a killed process), falls back to reading it straight off the isolated
// home's own session files (readUsageFromClaudeSessions above) before giving up. `home` is
// optional -- omitting it (or a stdout failure with nothing found under it) reproduces the
// original behavior exactly: throw, since there is nowhere else to get usage from.
export function parseUsage(stdout, home) {
  try {
    return parseFromStdout(stdout);
  } catch (err) {
    if (home) {
      const fromSession = readUsageFromClaudeSessions(home);
      if (fromSession) return fromSession;
    }
    throw err;
  }
}
