// Addendum F adapter (Jeremy 2026-09-13): Meta Muse driven headless as a native CLI, via the
// `muse` launcher (Muse Code 1.2.1 installed at ~/.local/bin/muse).
//
//   muse exec --json --yolo --no-foreign-personal-context --session-id <uuid> --model <model> "<prompt>"
//
// -- Binary vs. launcher, and why --yolo/--session-id are explicit --
// `muse` on PATH is a bash LAUNCHER SCRIPT (checks for updates, then `exec`s the real
// `muse-bin-<version>`), not the agent itself. This Mac also has an INTERACTIVE zsh function
// (from the shell startup cache) that shadows `muse` and auto-injects `--yolo` for `exec`/
// `resume` -- but that function exists only inside an interactive shell; a direct, no-shell spawn
// (exactly what Node's build()/spawnSync produces) resolves `muse` straight off PATH to the
// launcher script and never sees that function, so `--yolo` must be passed explicitly here or the
// run hangs on an approval prompt with no TTY to answer it.
//
// -- Isolation: XDG_CONFIG_HOME *and* XDG_DATA_HOME, both pointed at the fresh per-run `home` --
// `muse --help` and `muse exec --help` carry no MUSE_HOME or MUSE_CONFIG_DIR; the binary's own
// strings settle it: "Config root: $XDG_CONFIG_HOME/muse, else $HOME/.config/muse" and "no usable
// config directory from XDG_CONFIG_HOME or HOME" for config (auth.json/settings.json/trust.json),
// and the same pattern for XDG_DATA_HOME (data dir default $HOME/.local/share, verified live: a
// run with only XDG_CONFIG_HOME overridden still wrote its session log under the OPERATOR's real
// ~/.local/share/muse/sessions/). copyAuth() below copies auth.json/trust.json into
// `<home>/muse/`; build()/resume() point BOTH env vars at the same `home` so config AND every
// session log this run produces -- main session, and any subagent session, see below -- land
// under `<home>/muse` and nothing touches the operator's real muse state. `--no-foreign-personal-
// context` additionally excludes the "Claude Code and Codex personal rules and skills" muse
// auto-loads from the real $HOME (~/.agents/skills, ~/.claude, ~/.codex) when that flag is absent
// -- verified live: dropped duplicate-skill warnings from 172 to 6 on this Mac's real skill tree.
//
// -- Usage lives ONLY on disk, never in --json stdout (verified live, Muse Code 1.2.1) --
// Every other Addendum F adapter gets usage from its own --json stdout (codex, qwen) with a disk
// fallback only for a killed/truncated process (Addendum G). muse's `--json` stream NEVER carries
// a usage field at all -- grepped a full captured run for "usage"/"token": zero hits. The real
// numbers live in `model_completed` events inside the session log muse itself writes at
// `<XDG_DATA_HOME>/muse/sessions/<yyyy>/<mm>/<dd>/<session-id>/session.jsonl`. So build() always
// passes an explicit `--session-id` (a UUID this adapter generates, NOT muse's own auto-generated
// one) and records it in a marker file under `home` -- this makes the session log's path knowable
// even if stdout is empty (a SIGTERMed run prints nothing), the same spirit as codex's rollout
// fallback, except for muse it's the ONLY source, not a fallback.
//
// -- Subagent sessions are real, separate cost, easy to miss --
// muse spawns background "reminder" subagents (skill-reminder/goal-reminder/verify-reminder) as
// their OWN sessions, at `<session-dir>/subagent/<subagent-session-id>/session.jsonl`, each with
// its own `model_completed` events -- verified live: two subagent calls on one trivial "reply
// PONG" prompt cost 3,166+3,330 input and 1,511+127 output tokens, more than double the main
// session's own 28,758 in / 42 out. parseUsage() below walks the WHOLE `<home>/muse/sessions`
// tree and sums every model_completed event it finds, main and subagent alike, or the run's real
// cost is silently undercounted by more than half.
//
// -- Cumulative, not incremental, across a resume() --
// Unlike codex's rollout (a running `thread_token_usage` total where only the LAST record is
// taken) or qwen's usage_record.jsonl (one line per finished session), muse's session.jsonl has NO
// cumulative field -- each `model_completed` line carries only that one model call's own usage.
// resume() reuses the SAME --session-id, so the SAME session.jsonl file gets appended to; summing
// "every model_completed line in the file" after a resume therefore returns the run's TOTAL usage
// to date, not merely the newest call's delta. There is no turn-boundary marker to slice by, so a
// caller that wants the incremental delta of one resumed call must snapshot the file's line count
// before and after -- parseUsage() here always returns the cumulative total for the session.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const name = 'muse';

function requireOpt(opts, key, label) {
  if (!opts || !opts[key]) throw new Error(`muse adapter: ${label || key} is required`);
  return opts[key];
}

function configRoot(home) {
  return path.join(path.resolve(home), 'muse');
}

function sessionMarkerPath(home) {
  return path.join(configRoot(home), '.quaere-session-id');
}

// copyAuth(home, {authFrom, trustFrom}) -> {authDest, trustDest|null}. Copies auth.json (and
// trust.json, when present) into a fresh `<home>/muse` so the operator's real
// ~/.config/muse/{auth.json,trust.json} is never pointed at directly. trust.json is optional:
// --yolo bypasses the interactive trust prompt regardless, so a sandbox muse has never seen
// (no trust.json entry for it yet) is fine.
export function copyAuth(home, {
  authFrom = path.join(os.homedir(), '.config', 'muse', 'auth.json'),
  trustFrom = path.join(os.homedir(), '.config', 'muse', 'trust.json'),
} = {}) {
  if (!home) throw new Error('muse adapter: copyAuth() needs a home (fresh XDG_CONFIG_HOME/XDG_DATA_HOME) directory');
  const resolvedAuthFrom = authFrom;
  const resolvedTrustFrom = trustFrom;
  const dir = configRoot(home);
  fs.mkdirSync(dir, { recursive: true });
  const authDest = path.join(dir, 'auth.json');
  fs.copyFileSync(resolvedAuthFrom, authDest);
  let trustDest = null;
  try {
    const dest = path.join(dir, 'trust.json');
    fs.copyFileSync(resolvedTrustFrom, dest);
    trustDest = dest;
  } catch {
    trustDest = null; // no trust.json to copy yet -- fine, --yolo bypasses the trust prompt anyway
  }
  return { authDest, trustDest };
}

function buildEnv(home) {
  const resolved = path.resolve(home);
  return {
    XDG_CONFIG_HOME: resolved,
    XDG_DATA_HOME: resolved,
    // Keeps a climb from silently downloading a new muse build mid-run (the launcher
    // auto-updates in the background by default); determinism over freshness for a benchmark.
    MUSE_NO_AUTO_UPDATE: '1',
  };
}

function writeSessionMarker(home, sessionId) {
  fs.mkdirSync(configRoot(home), { recursive: true });
  fs.writeFileSync(sessionMarkerPath(home), sessionId, 'utf8');
}

// readSessionMarker(home) -> the session id build()/resume() recorded for this home, or null.
export function readSessionMarker(home) {
  try {
    return fs.readFileSync(sessionMarkerPath(home), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// build({sandbox, prompt, model, home}) -> {cmd, args, env, cwd}. Generates a fresh session id
// itself (rather than letting muse pick one) and records it in a marker file under `home` --
// parseUsage() below reads that marker to find this run's session log even if stdout never
// carried anything (a SIGTERMed process). `muse exec` has no `-C`/`--cd` flag (checked against
// `muse exec --help`), so the sandbox is set only via spawn's own `cwd`, same as codex's
// `exec resume`.
export function build(opts = {}) {
  const sandbox = requireOpt(opts, 'sandbox');
  const prompt = requireOpt(opts, 'prompt');
  const model = requireOpt(opts, 'model');
  const home = requireOpt(opts, 'home', 'home (fresh XDG_CONFIG_HOME/XDG_DATA_HOME)');
  const sessionId = randomUUID();
  writeSessionMarker(home, sessionId);
  return {
    cmd: 'muse',
    args: [
      'exec',
      '--json',
      '--yolo',
      '--no-foreign-personal-context',
      '--session-id', sessionId,
      '--model', model,
      prompt,
    ],
    env: buildEnv(home),
    cwd: sandbox,
  };
}

// resume(sessionId, {sandbox, prompt, model, home}) -> {cmd, args, env, cwd}. `muse resume` is
// interactive-only (opens a session picker; no --json, no way to feed it a continuation prompt --
// checked against `muse resume --help`), so the practical headless equivalent is a fresh
// `muse exec` reusing the SAME --session-id: verified live end to end (a second, separate `muse
// exec --session-id <same uuid>` invocation correctly recalled a secret word planted in the
// first), so this is a real continuation, not a coincidence of shared config.
export function resume(sessionId, opts = {}) {
  if (!sessionId) throw new Error('muse adapter: resume() needs a session id');
  const sandbox = requireOpt(opts, 'sandbox');
  const prompt = requireOpt(opts, 'prompt');
  const home = requireOpt(opts, 'home', 'home (fresh XDG_CONFIG_HOME/XDG_DATA_HOME)');
  writeSessionMarker(home, sessionId);
  const args = [
    'exec',
    '--json',
    '--yolo',
    '--no-foreign-personal-context',
    '--session-id', sessionId,
  ];
  if (opts.model) args.push('--model', opts.model);
  args.push(prompt);
  return { cmd: 'muse', args, env: buildEnv(home), cwd: sandbox };
}

// modelVersionFromStdout(stdout) -> the model id off a "run.model.configured" event, or null.
// stdout carries the served model (verified live) even though it never carries usage.
function modelVersionFromStdout(stdout) {
  for (const line of String(stdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue; // interleaved non-JSON noise -- same tolerance as the codex adapter
    }
    const payload = event.payload || {};
    if (event.payload_type === 'run.model.configured' && payload.model_id) {
      return payload.model_id;
    }
  }
  return null;
}

// Every *.jsonl file under `dir`, recursive (main session.jsonl plus any subagent/**/session.jsonl
// alongside it) -- same non-throwing, missing-dir-is-fine walk as codex.js's newestJsonlFiles.
function allJsonlFiles(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

// sumUsageFromSessionLogs(home) -> {tokensIn, tokensCached, tokensOut, modelVersion} | null.
// Walks the WHOLE `<home>/muse/sessions` tree (this `home` is fresh per run, so every session log
// under it belongs to this run) and sums every `model_completed` event's usage it finds, main
// session and any subagent session alike -- see the file header on why subagents matter here.
export function sumUsageFromSessionLogs(home) {
  const root = path.join(configRoot(home), 'sessions');
  const files = allJsonlFiles(root);
  let tokensIn = 0;
  let tokensCached = 0;
  let tokensOut = 0;
  let modelVersion = null;
  let sawAny = false;
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue; // a partially-written last line from a killed process is skipped, not fatal
      }
      const event = ((record.payload || {}).event) || {};
      if (event.kind !== 'model_completed' || !event.usage) continue;
      sawAny = true;
      const usage = event.usage;
      tokensIn += usage.input_tokens || 0;
      // cached_tokens and cache_read_tokens have both shown 0 in every live capture so far, with
      // no documentation distinguishing them -- fold both in rather than silently drop one.
      tokensCached += (usage.cached_tokens || 0) + (usage.cache_read_tokens || 0);
      // reasoning_tokens is billed, invisible-text output spend -- same call the qwen adapter
      // makes for its own thoughtsTokens.
      tokensOut += (usage.output_tokens || 0) + (usage.reasoning_tokens || 0);
      if (!modelVersion && event.model) modelVersion = event.model;
    }
  }
  if (!sawAny) return null;
  return { tokensIn, tokensCached, tokensOut, modelVersion };
}

// parseUsage(stdout, home) -> {tokensIn, tokensCached, tokensOut, modelVersion, usageEstimated,
// sessionId}. `home` is REQUIRED here, not an optional fallback like codex/qwen -- muse's --json
// stdout never carries usage at all (see file header), so the session log under `home` is the
// only source there is.
export function parseUsage(stdout, home) {
  if (!home) {
    throw new Error(
      'muse adapter: parseUsage() needs `home` -- muse\'s --json stdout never carries token usage '
        + '(verified live against Muse Code 1.2.1); usage only exists in the session log this run '
        + 'wrote under the isolated home.',
    );
  }
  const sessionId = readSessionMarker(home);
  const usage = sumUsageFromSessionLogs(home);
  if (!usage) {
    throw new Error(
      `muse adapter: no model_completed usage event found under ${path.join(configRoot(home), 'sessions')}`
        + `${sessionId ? ` for session ${sessionId}` : ''}`,
    );
  }
  return {
    tokensIn: usage.tokensIn,
    tokensCached: usage.tokensCached,
    tokensOut: usage.tokensOut,
    modelVersion: modelVersionFromStdout(stdout) || usage.modelVersion || null,
    usageEstimated: false,
    sessionId,
  };
}
