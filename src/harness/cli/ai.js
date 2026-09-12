// Addendum F adapter: claude-fable-5.1 (or any model reachable through the `ai` wrapper around
// Claude Code) driven as a native CLI, not a message-loop driver.
//
//   AI_NO_RTK=1 ai --no-chrome -p "<prompt>" --model <model> --output-format json
//
// Isolation: CLAUDE_CONFIG_DIR points at a fresh, per-run directory (the aigate warden still
// authenticates through it -- this only isolates SESSION/config state across runs, never auth).

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

// parseUsage(stdout, home?) -> {tokensIn, tokensCached, tokensOut, modelVersion, usageEstimated,
// sessionId, costUsd}. `stdout` is the whole captured stdout of one `--output-format json`
// invocation: a single JSON object carrying `usage`, `modelUsage` (per-model breakdown, keyed by
// canonical model id -- Addendum F: "Every adapter records the model the tool actually reports"),
// and `total_cost_usd`. Shape verified against a live fixture, see test/fixtures/cli-ai-usage.json.
// `home` is accepted (unused) to match the shared adapter signature -- ai's own JSON result is
// self-contained, unlike kimi's, which has to go dig usage out of a session file under `home`.
export function parseUsage(stdout, home) { // eslint-disable-line no-unused-vars
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
  const usage = data.usage || {};
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
