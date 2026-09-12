// Addendum F adapter: gpt-6-astra (or any codex-cli-reachable model) driven as a native CLI.
//
//   codex exec --json -m <model> -C <sandbox> --skip-git-repo-check
//     --dangerously-bypass-approvals-and-sandbox "<prompt>"
//
// Isolation: CODEX_HOME points at a fresh, per-run directory containing a COPY (never the
// original) of the real ~/.codex/auth.json -- copyAuth() below does the copying.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'codex';

function requireOpt(opts, key, label) {
  if (!opts || !opts[key]) throw new Error(`codex adapter: ${label || key} is required`);
  return opts[key];
}

// copyAuth(home, {from}) -> destPath. Copies auth.json into a fresh CODEX_HOME so the real
// ~/.codex/auth.json is never pointed at directly (isolation, and never shared/mutated across
// concurrent runs). `from` defaults to the real file; a test can point it at a fixture instead.
// Never logs or returns the file's contents -- it is a live credential.
export function copyAuth(home, { from = path.join(os.homedir(), '.codex', 'auth.json') } = {}) {
  if (!home) throw new Error('codex adapter: copyAuth() needs a home (fresh CODEX_HOME) directory');
  fs.mkdirSync(home, { recursive: true });
  const dest = path.join(home, 'auth.json');
  fs.copyFileSync(from, dest);
  return dest;
}

// build({sandbox, prompt, model, home}) -> {cmd, args, env, cwd}
export function build(opts = {}) {
  const sandbox = requireOpt(opts, 'sandbox');
  const prompt = requireOpt(opts, 'prompt');
  const model = requireOpt(opts, 'model');
  const home = requireOpt(opts, 'home', 'home (fresh CODEX_HOME)');
  return {
    cmd: 'codex',
    args: [
      'exec',
      '--json',
      '-m', model,
      '-C', sandbox,
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      prompt,
    ],
    env: { CODEX_HOME: path.resolve(home) },
    cwd: sandbox,
  };
}

// resume(threadId, {sandbox, prompt, home, model?}) -> {cmd, args, env, cwd}. `codex exec resume
// <thread_id>` (Addendum F). `codex exec resume` has no `-C/--cd` flag (checked against `codex
// exec resume --help`), so the working directory carries only through spawn's own `cwd`.
export function resume(threadId, opts = {}) {
  if (!threadId) throw new Error('codex adapter: resume() needs a thread id');
  const sandbox = requireOpt(opts, 'sandbox');
  const prompt = requireOpt(opts, 'prompt');
  const home = requireOpt(opts, 'home', 'home (fresh CODEX_HOME)');
  const args = ['exec', 'resume', threadId, prompt, '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];
  if (opts.model) args.push('-m', opts.model);
  return { cmd: 'codex', args, env: { CODEX_HOME: path.resolve(home) }, cwd: sandbox };
}

// parseUsage(stdout, home?) -> {tokensIn, tokensCached, tokensOut, modelVersion, usageEstimated,
// threadId}. `stdout` is the whole captured JSONL stream of one `codex exec --json` invocation
// (Addendum F: "turn.completed.usage events"). Shape verified against a live fixture, see
// test/fixtures/cli-codex-usage.jsonl. Sums every `turn.completed` event rather than taking only
// the last one: `codex exec resume` on an existing thread starts a NEW turn, so a resumed run's
// stdout can legitimately carry more than one, and each is the incremental cost of that turn, not
// a running total (unlike the ai adapter's single-shot JSON result). `home` is accepted (unused)
// to match the shared adapter signature -- codex's usage is already on stdout, unlike kimi's.
export function parseUsage(stdout, home) { // eslint-disable-line no-unused-vars
  const lines = String(stdout).split('\n').filter(Boolean);
  let threadId = null;
  let tokensIn = 0;
  let tokensCached = 0;
  let tokensOut = 0;
  let sawUsage = false;
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // codex can interleave non-JSON noise on stdout; skip rather than fail the run
    }
    if (event.type === 'thread.started' && event.thread_id) threadId = event.thread_id;
    if (event.type === 'turn.completed' && event.usage) {
      sawUsage = true;
      tokensIn += event.usage.input_tokens || 0;
      tokensCached += event.usage.cached_input_tokens || 0;
      tokensOut += event.usage.output_tokens || 0;
    }
  }
  if (!sawUsage) {
    throw new Error('codex adapter: no turn.completed usage event found in --json stdout');
  }
  return {
    tokensIn,
    tokensCached,
    tokensOut,
    // codex's --json event stream carries no per-turn model field today; the requested model is
    // already known to the caller (it's what build() was given), so there is nothing to reconcile
    // here the way ai.js's modelUsage breakdown requires.
    modelVersion: null,
    usageEstimated: false,
    threadId,
  };
}
