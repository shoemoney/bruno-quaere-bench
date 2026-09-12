// Addendum F adapter: kimi-k3 driven as a native CLI via Moonshot's kimi-code CLI.
//
//   kimi [-m <model>] -p "<prompt>" --output-format stream-json
//
// Unlike its qwen/gemini siblings, `model` is OPTIONAL here (only appended as `-m` when given):
// Addendum F's own literal invocation for kimi omits -m entirely ("plain -p"), because
// config.toml's `default_model` already pins `kimi-code/k3`. A caller that wants a different
// kimi-code model alias can still pass one; kimi supports `-m, --model <model>` (verified against
// `kimi --help`).
//
// --- Deviation from ARCHITECTURE.md, verified live 2026-09-12 -----------------------------------
// Addendum F says isolation is "HOME=<fresh dir> with ~/.kimi/credentials and ~/.kimi/device_id
// copied in". On this box (kimi-code 0.42.0) that fails outright:
//   $ HOME=<fresh> kimi -p "..." --output-format stream-json
//   error: failed to run prompt: No model configured. Run `kimi` and use /login to sign in...
// Cause, found in ~/.kimi-code/migration-report.json (migratorVersion 0.1.1, ran 2026-09-07,
// source ~/.kimi -> target ~/.kimi-code): a one-time migrator moved the CLI's real home from
// ~/.kimi to ~/.kimi-code and explicitly did NOT bring the old device id or provider config along
// (`"config":{"migrated":false,...}`, `"deviceIdCopied":false`). What's left at the old path is
// stale: ~/.kimi/device_id is the PRE-migration id, and ~/.kimi/credentials is a 0-byte lock file
// (kimi-code.lock) -- never a credential store; there is no separate token file anywhere on disk,
// auth is bound to device_id server-side. ~/.kimi-code/config.toml is what actually carries
// default_model and the `managed:kimi-code` provider binding.
// Fix, verified end to end (real reply, real session + usage file written): seed the fresh HOME's
// ~/.kimi-code/ with the REAL config.toml + device_id from ~/.kimi-code (not ~/.kimi) --
// seedKimiHome() below. ARCHITECTURE.md's Addendum F kimi row should be corrected to this path;
// flagging here rather than hand-editing another workstream's doc addendum out from under it
// mid-build.
//
// Invocation and output shape verified live: `--output-format stream-json` prints
// newline-delimited JSON to stdout -- a {"role":"meta","type":"system.version"}, the
// {"role":"assistant","content":...} reply, and a {"type":"session.resume_hint","session_id":...}
// trailer. No usage totals in that stream at all -- the real per-turn token accounting lives in
// <HOME>/.kimi-code/sessions/<workdir-bucket>/<session_id>/agents/<agent>/wire.jsonl, one
// {"type":"usage.record","model":...,"usage":{inputOther,output,inputCacheRead,inputCacheCreation}}
// event per model call (also not under <HOME>/.kimi/sessions as Addendum F says -- same rename).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const name = 'kimi';

const REAL_KIMI_CODE_HOME = path.join(os.homedir(), '.kimi-code');

function requireOpt(opts, key, label) {
  if (!opts || !opts[key]) throw new Error(`kimi adapter: ${label || key} is required`);
  return opts[key];
}

// seedKimiHome(home, {realHome?}) -> destDir. Copies the two files that make a fresh HOME an
// already-authorized kimi-code session: config.toml (default_model + the managed:kimi-code
// provider binding) and device_id (the server-side auth key). `realHome` defaults to the
// operator's real ~/.kimi-code; a test can point it at a fixture dir instead. Never logs either
// file's contents -- device_id is a live credential.
export function seedKimiHome(home, { realHome = REAL_KIMI_CODE_HOME } = {}) {
  if (!home) throw new Error('kimi adapter: seedKimiHome() needs a home (fresh HOME) directory');
  const dst = path.join(home, '.kimi-code');
  fs.mkdirSync(dst, { recursive: true });
  for (const file of ['config.toml', 'device_id']) {
    fs.copyFileSync(path.join(realHome, file), path.join(dst, file));
  }
  return dst;
}

// build({sandbox, prompt, model?, home, kimiRealHome?}) -> {cmd, args, env, cwd}. Seeds `home`
// with a working kimi-code identity as a side effect (mirrors the qwen/gemini adapters reading
// real credentials at build time) -- safe to call more than once, copyFileSync overwrites.
// `kimiRealHome` is an optional override (default ~/.kimi-code) passed to seedKimiHome(), same
// spirit as the codex adapter's `copyAuth({from})`, so a test can seed from a fixture dir instead
// of the operator's real one.
export function build(opts = {}) {
  const sandbox = requireOpt(opts, 'sandbox');
  const prompt = requireOpt(opts, 'prompt');
  const home = requireOpt(opts, 'home', 'home (fresh HOME)');
  seedKimiHome(home, { realHome: opts.kimiRealHome });
  const args = [];
  if (opts.model) args.push('-m', opts.model);
  // Addendum B/E: -p cannot combine with -y/--auto (prompt mode already runs tools on its own).
  args.push('-p', prompt, '--output-format', 'stream-json');
  return { cmd: 'kimi', args, env: { HOME: path.resolve(home) }, cwd: sandbox };
}

// resume(sessionId, {sandbox, prompt, model?, home, kimiRealHome?}) -> {cmd, args, env, cwd}.
// `kimi -S <session_id>` (Addendum F).
export function resume(sessionId, opts = {}) {
  if (!sessionId) throw new Error('kimi adapter: resume() needs a session id');
  const sandbox = requireOpt(opts, 'sandbox');
  const prompt = requireOpt(opts, 'prompt');
  const home = requireOpt(opts, 'home', 'home (fresh HOME)');
  seedKimiHome(home, { realHome: opts.kimiRealHome });
  const args = ['-S', sessionId];
  if (opts.model) args.push('-m', opts.model);
  args.push('-p', prompt, '--output-format', 'stream-json');
  return { cmd: 'kimi', args, env: { HOME: path.resolve(home) }, cwd: sandbox };
}

function parseNdjson(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // stream-json is line-delimited; a stray non-JSON line is skipped, not fatal.
    }
  }
  return out;
}

// findWireFile(home, sessionId) -> path | null. The session lives under a workdir-hash bucket
// directory whose name we don't know in advance (kimi-code derives it from cwd), so this walks
// <home>/.kimi-code/sessions/*/​<sessionId>/agents/*/wire.jsonl rather than assuming one.
function findWireFile(home, sessionId) {
  const sessionsRoot = path.join(home, '.kimi-code', 'sessions');
  let buckets;
  try {
    buckets = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    const agentsDir = path.join(sessionsRoot, bucket.name, sessionId, 'agents');
    let agents;
    try {
      agents = fs.readdirSync(agentsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const agent of agents) {
      const wire = path.join(agentsDir, agent.name, 'wire.jsonl');
      if (fs.existsSync(wire)) return wire;
    }
  }
  return null;
}

// parseUsage(stdout, home) -> {tokensIn, tokensCached, tokensOut, modelVersion, usageEstimated,
// sessionId}. Unlike its qwen/gemini/ai/codex siblings, kimi's stdout carries no usage at all --
// `home` is REQUIRED here to go dig the real per-turn totals out of the session's wire.jsonl
// (Addendum F: "usage from the session file ... if present else chars/4 with usageEstimated
// true"; path corrected from <HOME>/.kimi/sessions to <HOME>/.kimi-code/sessions per the
// deviation noted above).
export function parseUsage(stdout, home) {
  const events = parseNdjson(stdout);
  const assistantText = events
    .filter((e) => e.role === 'assistant')
    .map((e) => e.content || '')
    .join('');
  const resumeHint = events.find((e) => e.type === 'session.resume_hint');
  const sessionId = (resumeHint && resumeHint.session_id) || null;

  const wirePath = sessionId && home ? findWireFile(home, sessionId) : null;
  if (wirePath) {
    const wireEvents = parseNdjson(fs.readFileSync(wirePath, 'utf8'));
    const usageRecords = wireEvents.filter((e) => e.type === 'usage.record');
    if (usageRecords.length > 0) {
      const totals = usageRecords.reduce(
        (acc, e) => {
          const u = e.usage || {};
          acc.inputOther += u.inputOther || 0;
          acc.inputCacheRead += u.inputCacheRead || 0;
          acc.inputCacheCreation += u.inputCacheCreation || 0;
          acc.output += u.output || 0;
          return acc;
        },
        { inputOther: 0, inputCacheRead: 0, inputCacheCreation: 0, output: 0 },
      );
      return {
        tokensIn: totals.inputOther + totals.inputCacheRead + totals.inputCacheCreation,
        tokensCached: totals.inputCacheRead,
        tokensOut: totals.output,
        modelVersion: usageRecords[usageRecords.length - 1].model || null,
        usageEstimated: false,
        sessionId,
      };
    }
  }

  // Fallback per Addendum F: no session file found (chat recording off, session pruned, HOME not
  // seeded by seedKimiHome()) -- estimate tokens from characters.
  const totalChars = stdout.length;
  const outChars = assistantText.length;
  return {
    tokensIn: Math.ceil(Math.max(0, totalChars - outChars) / 4),
    tokensCached: 0,
    tokensOut: Math.ceil(outChars / 4),
    modelVersion: null,
    usageEstimated: true,
    sessionId,
  };
}
