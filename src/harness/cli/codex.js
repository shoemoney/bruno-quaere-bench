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
function parseFromStdout(stdout) {
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
    // codex's --json event stream carries no per-turn model field; the rollout file under
    // CODEX_HOME does (turn_context.payload.model), so parseUsage() below tops this up from
    // there rather than leaving the board's Model column empty on an otherwise clean run.
    modelVersion: null,
    usageEstimated: false,
    threadId,
  };
}

// Every *.jsonl under `dir`, newest-modified first. Shared by the rollout reader below; a
// directory that does not exist (or cannot be read) yields nothing rather than throwing.
function newestJsonlFiles(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(dir);
  const withMtime = [];
  for (const f of out) {
    try {
      withMtime.push({ f, mtimeMs: fs.statSync(f).mtimeMs });
    } catch {
      // raced with the CLI's own cleanup; skip it rather than fail the whole read
    }
  }
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withMtime.map((x) => x.f);
}

// readUsageFromCodexRollout(home) -> {tokensIn, tokensCached, tokensOut, modelVersion,
// usageEstimated, threadId} or null. Addendum G's drained-kill fallback for codex: a SIGTERMed
// `codex exec --json` exits without ever printing its turn.completed events, but the same numbers
// are already durable in the rollout transcript codex writes itself, at
// `$CODEX_HOME/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<session-id>.jsonl` -- one JSON object per
// line, carrying `token_usage_record` payloads (with a cumulative `thread_token_usage`),
// `turn_context` payloads (with the model codex actually used) and a `session_meta` (session id).
//
// Captured from a live killed run's rollout file, not reconstructed from documentation.
export function readUsageFromCodexRollout(home) {
  if (!home) return null;
  const files = newestJsonlFiles(path.join(home, 'sessions'));
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let threadId = null;
    let modelVersion = null;
    let latestUsage = null;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue; // a partially-written last line from a killed process is skipped, not fatal
      }
      const payload = entry.payload || {};
      if (entry.type === 'session_meta' && payload.session_id) threadId = payload.session_id;
      if (entry.type === 'turn_context' && payload.model) modelVersion = payload.model;
      // thread_token_usage is the running total for the whole thread, so the LAST record wins --
      // summing them would multiply-count every earlier turn.
      if (entry.type === 'token_usage_record' && (payload.thread_token_usage || payload.usage)) {
        latestUsage = payload.thread_token_usage || payload.usage;
      }
    }
    if (!latestUsage && !modelVersion) continue;
    return {
      tokensIn: (latestUsage && latestUsage.input_tokens) || 0,
      tokensCached: (latestUsage && latestUsage.cached_input_tokens) || 0,
      tokensOut: (latestUsage && latestUsage.output_tokens) || 0,
      modelVersion,
      usageEstimated: !latestUsage,
      threadId,
    };
  }
  return null;
}

// parseUsage(stdout, home?) -> the shape above. Reads stdout first; on a killed/truncated stream
// (Addendum G) falls back to the rollout transcript under CODEX_HOME. Even when stdout parses,
// the model is only ever in the rollout, so fill it in from there when `home` is available.
export function parseUsage(stdout, home) {
  let fromStdout;
  try {
    fromStdout = parseFromStdout(stdout);
  } catch (err) {
    const fromRollout = readUsageFromCodexRollout(home);
    if (fromRollout) return fromRollout;
    throw err;
  }
  if (fromStdout.modelVersion == null && home) {
    const fromRollout = readUsageFromCodexRollout(home);
    if (fromRollout && fromRollout.modelVersion) fromStdout.modelVersion = fromRollout.modelVersion;
  }
  return fromStdout;
}
