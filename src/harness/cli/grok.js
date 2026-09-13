// quaere doctor adapter: x-ai/grok-4.6 driven as a native CLI via @vibe-kit/grok-cli ("grok").
//
//   GROK_YOLO=1 GROK_MODEL=<model> grok -p "<prompt>"
//
// On this box `grok` is a login-shell ALIAS (`alias grok='GROK_YOLO=1 GROK_MODEL=grok-code-fast-1
// grok'`), not a plain PATH binary -- doctor resolves it with `zsh -ic 'whence -p grok'` first for
// exactly this reason. The alias's trailing `grok` still resolves to the real
// /opt/homebrew/bin/grok (-> @vibe-kit/grok-cli, `--version` reports "1.0.1"); this adapter sets
// the same two env vars explicitly rather than relying on the operator's alias being sourced.
//
// Auth: `~/.grok/user-settings.json` carries `{apiKey, baseURL, defaultModel}` (apiKey vaulted in
// aigate under provider "xai" per ~/.claude-memory-git's grok-cli-xai-setup note). Isolation seeds
// a FRESH HOME's `~/.grok/user-settings.json` with a copy of the real one (never the original
// path), same spirit as codex.js's copyAuth() -- seedGrokHome() below.
//
// --- Investigated: does grok's headless mode report the served model? (2026-09-13) -------------
// Read straight from the installed CLI's own source
// (/opt/homebrew/lib/node_modules/@vibe-kit/grok-cli/dist/index.js,
// processPromptHeadless() around line 177): `-p` prints each chat turn as ONE JSON object per
// line -- `{"role":"user"|"assistant"|"tool", "content":..., "tool_calls"?:[...]}` -- built from
// the CLI's OWN chat history, never from the provider's raw HTTP response. There is no `model`,
// `usage`, or any other field anywhere in that stream. The model actually asked for is knowable
// (GROK_MODEL / -m / ~/.grok/user-settings.json's defaultModel, in that order -- see loadModel()
// in the same file) but NOT the model that actually answered: xAI's response body is discarded
// after its `content` is extracted. Per Addendum F ("never silently accept a fallback model"),
// that is not verifiable from here, so doctor treats grok as `headless:false` with a reason
// rather than claim a served-model check it cannot perform -- see src/harness/doctor.js's
// `GROK_HEADLESS_UNVERIFIED_REASON`. This adapter is still complete (build/parseUsage/resume) so
// a real climb can use `--driver cli --cli grok` manually; only doctor's verification is skipped.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const name = 'grok';

const REAL_USER_SETTINGS = path.join(os.homedir(), '.grok', 'user-settings.json');

function requireOpt(opts, key, label) {
  if (!opts || !opts[key]) throw new Error(`grok adapter: ${label || key} is required`);
  return opts[key];
}

// seedGrokHome(home, {realSettingsFile?}) -> destPath. Copies ~/.grok/user-settings.json (the
// apiKey/baseURL/defaultModel the CLI reads when GROK_API_KEY/-k aren't given) into a fresh HOME
// so the real file is never pointed at directly. Never logs its contents -- apiKey is live.
export function seedGrokHome(home, { realSettingsFile = REAL_USER_SETTINGS } = {}) {
  if (!home) throw new Error('grok adapter: seedGrokHome() needs a home (fresh HOME) directory');
  const destDir = path.join(home, '.grok');
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'user-settings.json');
  fs.copyFileSync(realSettingsFile, dest);
  return dest;
}

// build({sandbox, prompt, model, home, realSettingsFile?}) -> {cmd, args, env, cwd}. `model` is
// passed via GROK_MODEL (loadModel() in the CLI checks the env var before user-settings), not
// `-m` -- matches the box's own alias convention and keeps `-m`/`GROK_MODEL` from disagreeing.
export function build(opts = {}) {
  const sandbox = requireOpt(opts, 'sandbox');
  const prompt = requireOpt(opts, 'prompt');
  const model = requireOpt(opts, 'model');
  const home = requireOpt(opts, 'home', 'home (fresh HOME)');
  seedGrokHome(home, { realSettingsFile: opts.realSettingsFile });
  return {
    cmd: 'grok',
    args: ['-p', prompt],
    env: { HOME: path.resolve(home), GROK_YOLO: '1', GROK_MODEL: model },
    cwd: sandbox,
  };
}

// resume() -- grok-cli's `-p` is single-shot with no session/resume flag in `grok --help`
// (verified 2026-09-13: no -S/--session/--resume option exists). Addendum F's harness treats a
// missing resume() as "start a fresh session with the note" for CLIs that don't support one; this
// just re-runs build() with the note folded into the prompt by the caller.
export function resume(sessionId, opts = {}) {
  return build(opts);
}

function parseNdjson(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // headless output is line-delimited JSON; a stray non-JSON line (banner, warning) is
      // skipped, not fatal.
    }
  }
  return out;
}

// parseUsage(stdout) -> {tokensIn, tokensCached, tokensOut, modelVersion, usageEstimated}.
// grok-cli's `-p` stream carries neither usage totals nor a served-model field (see the header
// comment) -- every call is therefore `usageEstimated: true` (chars/4, same fallback shape as
// kimi.js's) and `modelVersion: null`. `home` is accepted for signature parity with the other
// adapters but unused: there is no session/usage file on disk to fall back to either.
export function parseUsage(stdout) {
  const events = parseNdjson(stdout);
  const assistantText = events
    .filter((e) => e && e.role === 'assistant')
    .map((e) => e.content || '')
    .join('');
  const totalChars = String(stdout).length;
  const outChars = assistantText.length;
  return {
    tokensIn: Math.ceil(Math.max(0, totalChars - outChars) / 4),
    tokensCached: 0,
    tokensOut: Math.ceil(outChars / 4),
    modelVersion: null,
    usageEstimated: true,
  };
}
