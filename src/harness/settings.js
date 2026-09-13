// .quaere/settings.json: doctor's findings (CLI scan + resolved provider key sources/working
// status for google/deepseek/xai/openrouter + per-model driver resolution) and the `run`
// command's openrouter-key confirmation prompt. Zero deps.
//
// Nothing in this file ever returns, logs, or writes a KEY VALUE -- only file paths, an env var
// name, and (for the provider-key probes) an HTTP status/reason string. `readOpenrouterKey()`
// and `readProviderKey()` are the only functions that touch an actual key value, and only at the
// caller's request (immediately before using it), never as a return value that gets printed or
// persisted.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createInterface } from 'node:readline/promises';

export const DEFAULT_CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
export const DEFAULT_AIGATE_ENV_PATH = path.join(os.homedir(), '.claude', 'aigate', 'env');

export function settingsPathFor(repoRoot) {
  return path.join(repoRoot, '.quaere', 'settings.json');
}

// Lineup entry -> {cli adapter name|null, direct provider driver if the CLI is missing/unusable}.
// The `directDriver` values (google/deepseek/xai) are exactly the labs this bench already has a
// message-loop driver for (src/harness/run.js resolveDriver); the other three CLIs (ai/codex/qwen/
// kimi) have no such counterpart here, so their fallback is `openrouter`.
export const LINEUP = [
  { id: 'claude-fable-5-1', cli: 'ai', directDriver: null },
  { id: 'gpt-6-astra', cli: 'codex', directDriver: null },
  // qwen3.8-flash before qwen3.8-max: both share the `qwen` CLI, and doctor.js's SMOKE_MODEL map
  // (settings.js LINEUP filtered to one id per cli) keeps whichever entry comes LAST for a given
  // cli, so max stays doctor's qwen smoke-test model, unchanged from before this addition.
  { id: 'qwen3.8-flash', cli: 'qwen', directDriver: null },
  { id: 'qwen3.8-max', cli: 'qwen', directDriver: null },
  { id: 'gemini-3.8-flash', cli: 'gemini', directDriver: 'google' },
  { id: 'kimi-code/k3', cli: 'kimi', directDriver: null },
  { id: 'x-ai/grok-4.6', cli: 'grok', directDriver: 'xai' },
  { id: 'deepseek-flash', cli: null, directDriver: 'deepseek' },
  // Jeremy's lineup addition, 2026-09-13: Meta Muse via the `muse` CLI (src/harness/cli/muse.js).
  { id: 'muse-spark-1.3-contributor', cli: 'muse', directDriver: null },
];

// --- tiny dotenv, same shape as the gemini/qwen adapters' own copies (KEY=VALUE, '#' comments,
// optional `export ` prefix, optional matching quotes) -----------------------------------------
export function parseDotEnv(text) {
  const out = {};
  for (const rawLine of String(text).split('\n')) {
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
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// findOpenrouterKey(opts) -> Promise<{found, source, file}>. Search order (first hit wins),
// exactly per Jeremy's spec: (a) .quaere/settings.json's own `openrouterKeyFile`/`openrouterKey`,
// (b) ~/.claude/settings.json env.OPENROUTER_API_KEY, (c) ./.env OPENROUTER_API_KEY, (d) the
// OPENROUTER_API_KEY env var itself, (e) aigate provider "openrouter" via ~/.claude/aigate/env.
// `file` is a PATH only -- never the key -- and null for the bare env-var source. `noNetwork`
// skips step (e), the only one of the five that touches the network.
export async function findOpenrouterKey({
  repoRoot = process.cwd(),
  settingsPath,
  claudeSettingsPath = DEFAULT_CLAUDE_SETTINGS_PATH,
  dotenvPath,
  aigateEnvPath = DEFAULT_AIGATE_ENV_PATH,
  env = process.env,
  fetchImpl = fetch,
  aigateBaseUrl,
  noNetwork = false,
} = {}) {
  const resolvedSettingsPath = settingsPath || settingsPathFor(repoRoot);
  const resolvedDotenvPath = dotenvPath || path.join(repoRoot, '.env');

  // (a) our own settings.json, hand-edited or from a previous run
  const ownSettings = readJsonSafe(resolvedSettingsPath);
  if (ownSettings && typeof ownSettings.openrouterKeyFile === 'string' && ownSettings.openrouterKeyFile) {
    try {
      const text = fs.readFileSync(ownSettings.openrouterKeyFile, 'utf8');
      const parsed = parseDotEnv(text);
      if (parsed.OPENROUTER_API_KEY || text.trim()) {
        return { found: true, source: 'settings.json', file: ownSettings.openrouterKeyFile };
      }
    } catch {
      // referenced file missing/unreadable -- fall through to the next source
    }
  }
  if (ownSettings && typeof ownSettings.openrouterKey === 'string' && ownSettings.openrouterKey) {
    return { found: true, source: 'settings.json', file: resolvedSettingsPath };
  }

  // (b) ~/.claude/settings.json env block
  const claudeSettings = readJsonSafe(claudeSettingsPath);
  if (claudeSettings && claudeSettings.env && claudeSettings.env.OPENROUTER_API_KEY) {
    return { found: true, source: 'claude-settings', file: claudeSettingsPath };
  }

  // (c) ./.env
  try {
    const text = fs.readFileSync(resolvedDotenvPath, 'utf8');
    if (parseDotEnv(text).OPENROUTER_API_KEY) {
      return { found: true, source: 'dotenv', file: resolvedDotenvPath };
    }
  } catch {
    // no .env, or unreadable -- fine, fall through
  }

  // (d) env var
  if (env.OPENROUTER_API_KEY) {
    return { found: true, source: 'env', file: null };
  }

  // (e) aigate provider "openrouter" -- the only step that touches the network
  if (noNetwork) return { found: false, source: null, file: null };
  try {
    const aigateEnv = parseDotEnv(fs.readFileSync(aigateEnvPath, 'utf8'));
    const token = aigateEnv.AIGATE_TOKEN;
    const base = (aigateBaseUrl || aigateEnv.AIGATE_URL || '').replace(/\/$/, '');
    if (token && base) {
      const res = await fetchImpl(`${base}/api/keys/openrouter`, { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data.key === 'string' && data.key) {
          return { found: true, source: 'aigate', file: aigateEnvPath };
        }
      }
    }
  } catch {
    // aigate unreachable/unconfigured -- genuinely not found
  }

  return { found: false, source: null, file: null };
}

// readOpenrouterKey(record, opts) -> Promise<string>. Reads the KEY VALUE from wherever
// findOpenrouterKey() said it lives, at the moment it's actually needed -- never persisted,
// logged, or returned by findOpenrouterKey() itself.
export async function readOpenrouterKey(record, { env = process.env, fetchImpl = fetch, aigateBaseUrl } = {}) {
  if (!record || !record.found) throw new Error('no openrouter key source recorded');
  if (record.source === 'env') {
    if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set in the environment');
    return env.OPENROUTER_API_KEY;
  }
  if (record.source === 'aigate') {
    const aigateEnv = parseDotEnv(fs.readFileSync(record.file, 'utf8'));
    const base = (aigateBaseUrl || aigateEnv.AIGATE_URL || '').replace(/\/$/, '');
    const res = await fetchImpl(`${base}/api/keys/openrouter`, {
      headers: { authorization: `Bearer ${aigateEnv.AIGATE_TOKEN}` },
    });
    if (!res.ok) throw new Error(`aigate GET /api/keys/openrouter -> ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (!data || typeof data.key !== 'string' || !data.key) {
      throw new Error('aigate returned no working key for provider "openrouter"');
    }
    return data.key;
  }
  // dotenv, claude-settings, settings.json: `record.file` is either a JSON file with an
  // `env.OPENROUTER_API_KEY`/`openrouterKey` field, or a KEY=VALUE dotenv file.
  const text = fs.readFileSync(record.file, 'utf8');
  const asJson = readJsonSafe(record.file);
  if (asJson) {
    if (asJson.env && asJson.env.OPENROUTER_API_KEY) return asJson.env.OPENROUTER_API_KEY;
    if (typeof asJson.openrouterKey === 'string' && asJson.openrouterKey) return asJson.openrouterKey;
  }
  const parsed = parseDotEnv(text);
  if (parsed.OPENROUTER_API_KEY) return parsed.OPENROUTER_API_KEY;
  if (text.trim() && record.source === 'settings.json') return text.trim();
  throw new Error(`no OPENROUTER_API_KEY found in ${record.file}`);
}

// --- direct provider keys (google/deepseek/xai): same idea as the openrouter helpers above, ---
// --- just a two-source search (env var, then aigate) instead of openrouter's five. -------------

// The env var each direct driver reads at run time (src/harness/run.js resolveDriver) -- doctor
// checks the same var so "doctor says it works" and "run actually uses this" never diverge.
export const DIRECT_PROVIDER_ENV_VAR = {
  google: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  xai: 'XAI_API_KEY',
};

// findProviderKey(provider, opts) -> Promise<{found, source, file}>. (a) the provider's own env
// var (source "env", file null -- nothing to point at), (b) aigate provider `<provider>` via
// ~/.claude/aigate/env (source "aigate", file the env-file path). `noNetwork` skips (b).
export async function findProviderKey(
  provider,
  { env = process.env, aigateEnvPath = DEFAULT_AIGATE_ENV_PATH, fetchImpl = fetch, aigateBaseUrl, noNetwork = false } = {},
) {
  const envVar = DIRECT_PROVIDER_ENV_VAR[provider];
  if (!envVar) throw new Error(`unknown direct provider: ${provider}`);
  if (env[envVar]) return { found: true, source: 'env', file: null };
  if (noNetwork) return { found: false, source: null, file: null };
  try {
    const aigateEnv = parseDotEnv(fs.readFileSync(aigateEnvPath, 'utf8'));
    const token = aigateEnv.AIGATE_TOKEN;
    const base = (aigateBaseUrl || aigateEnv.AIGATE_URL || '').replace(/\/$/, '');
    if (token && base) {
      const res = await fetchImpl(`${base}/api/keys/${provider}`, { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data.key === 'string' && data.key) {
          return { found: true, source: 'aigate', file: aigateEnvPath };
        }
      }
    }
  } catch {
    // aigate unreachable/unconfigured -- genuinely not found
  }
  return { found: false, source: null, file: null };
}

// readProviderKey(provider, record, opts) -> Promise<string>. Reads the KEY VALUE from wherever
// findProviderKey() said it lives, at the point of use only -- never persisted, logged, or
// returned by findProviderKey() itself.
export async function readProviderKey(provider, record, { env = process.env, fetchImpl = fetch, aigateBaseUrl } = {}) {
  if (!record || !record.found) throw new Error(`no ${provider} key source recorded`);
  if (record.source === 'env') {
    const envVar = DIRECT_PROVIDER_ENV_VAR[provider];
    if (!env[envVar]) throw new Error(`${envVar} not set in the environment`);
    return env[envVar];
  }
  if (record.source === 'aigate') {
    const aigateEnv = parseDotEnv(fs.readFileSync(record.file, 'utf8'));
    const base = (aigateBaseUrl || aigateEnv.AIGATE_URL || '').replace(/\/$/, '');
    const res = await fetchImpl(`${base}/api/keys/${provider}`, {
      headers: { authorization: `Bearer ${aigateEnv.AIGATE_TOKEN}` },
    });
    if (!res.ok) throw new Error(`aigate GET /api/keys/${provider} -> ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (!data || typeof data.key !== 'string' || !data.key) {
      throw new Error(`aigate returned no working key for provider "${provider}"`);
    }
    return data.key;
  }
  throw new Error(`unknown key source: ${record.source}`);
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function describeErrorBody(body) {
  if (!body) return null;
  if (typeof body.error === 'string') return body.error;
  if (body.error && typeof body.error.message === 'string') return body.error.message;
  if (typeof body.message === 'string') return body.message;
  return null;
}

function truncateReason(text, max = 300) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// probeProviderKey(provider, apiKey, opts) -> Promise<{working, status, reason}>. The one place
// an actual key VALUE is used over the wire; the caller never logs or persists it -- only this
// return value (a boolean, an HTTP status, and free text) makes it into settings.json.
export async function probeProviderKey(provider, apiKey, { fetchImpl = fetch } = {}) {
  try {
    if (provider === 'google') {
      const res = await fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(apiKey)}`,
      );
      if (res.ok) return { working: true, status: res.status, reason: 'ok' };
      const body = await safeJson(res);
      return { working: false, status: res.status, reason: describeErrorBody(body) || `HTTP ${res.status}` };
    }
    if (provider === 'deepseek') {
      const res = await fetchImpl('https://api.deepseek.com/models', { headers: { authorization: `Bearer ${apiKey}` } });
      if (res.ok) return { working: true, status: res.status, reason: 'ok' };
      const body = await safeJson(res);
      return { working: false, status: res.status, reason: describeErrorBody(body) || `HTTP ${res.status}` };
    }
    if (provider === 'xai') {
      const res = await fetchImpl('https://api.x.ai/v1/api-key', { headers: { authorization: `Bearer ${apiKey}` } });
      const body = await safeJson(res);
      if (!res.ok) return { working: false, status: res.status, reason: describeErrorBody(body) || `HTTP ${res.status}` };
      if (body && body.team_blocked === true) return { working: false, status: res.status, reason: 'team_blocked' };
      if (body && body.api_key_blocked === true) return { working: false, status: res.status, reason: 'api_key_blocked' };
      if (body && body.api_key_disabled === true) return { working: false, status: res.status, reason: 'api_key_disabled' };
      return { working: true, status: res.status, reason: 'ok' };
    }
    if (provider === 'openrouter') {
      const res = await fetchImpl('https://openrouter.ai/api/v1/auth/key', { headers: { authorization: `Bearer ${apiKey}` } });
      if (res.ok) return { working: true, status: res.status, reason: 'ok' };
      const body = await safeJson(res);
      return { working: false, status: res.status, reason: describeErrorBody(body) || `HTTP ${res.status}` };
    }
    throw new Error(`unknown provider to probe: ${provider}`);
  } catch (err) {
    return { working: false, status: null, reason: truncateReason(err.message || String(err)) };
  }
}

// resolveModels(clis, keys, lineup?) -> {<lineup id>: {driver, cli|null, reason}}. cli found +
// headless smoke ok -> driver "cli"; else a direct provider driver (google/deepseek/xai) but
// ONLY when doctor found that provider's key working; else "openrouter" (with a reason that says
// why the direct driver was skipped, when it was).
export function resolveModels(clis, keys = {}, lineup = LINEUP) {
  const models = {};
  for (const entry of lineup) {
    if (entry.cli) {
      const info = clis[entry.cli];
      if (info && info.found && info.headless) {
        models[entry.id] = { driver: 'cli', cli: entry.cli, reason: 'CLI found and headless smoke passed' };
        continue;
      }
    }
    if (entry.directDriver) {
      const keyInfo = keys[entry.directDriver];
      if (keyInfo && keyInfo.working) {
        models[entry.id] = {
          driver: entry.directDriver,
          cli: null,
          reason: entry.cli ? 'no working CLI; using the direct provider driver' : 'no CLI for this lab; direct provider driver',
        };
        continue;
      }
      const keyReason = keyInfo && keyInfo.reason ? keyInfo.reason : 'key not found';
      models[entry.id] = {
        driver: 'openrouter',
        cli: null,
        reason: entry.cli
          ? `no working CLI; ${entry.directDriver} key not working (${keyReason}); falling back to openrouter`
          : `${entry.directDriver} key not working (${keyReason}); falling back to openrouter`,
      };
      continue;
    }
    models[entry.id] = { driver: 'openrouter', cli: null, reason: 'no working CLI' };
  }
  return models;
}

export function readSettings(repoRoot) {
  return readJsonSafe(settingsPathFor(repoRoot));
}

export function writeSettings(repoRoot, data) {
  const filePath = settingsPathFor(repoRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return filePath;
}

// --- run's openrouter-key confirmation prompt ---------------------------------------------------

export function openrouterConsentQuestion(record) {
  const fileLabel = record && record.file ? record.file : 'the OPENROUTER_API_KEY environment variable';
  return `This will use openrouter key in ${fileLabel}. Continue? [y/N]`;
}

// ensureOpenrouterConsent({repoRoot, yes, isTTY, promptFn, findOpenrouterKeyFn}) -> Promise<void>.
// Throws (never proceeds) unless `yes` is true or the operator answers y/yes at a real prompt.
// `isTTY`/`promptFn`/`findOpenrouterKeyFn` are injectable so a test can drive this without a real
// terminal or a real key source.
export async function ensureOpenrouterConsent({
  repoRoot = process.cwd(),
  yes = false,
  isTTY = Boolean(process.stdin.isTTY),
  promptFn,
  findOpenrouterKeyFn = findOpenrouterKey,
} = {}) {
  const record = await findOpenrouterKeyFn({ repoRoot });
  const question = openrouterConsentQuestion(record);
  if (yes) return { record, question };
  if (!isTTY) {
    throw new Error(`${question} pass --yes`);
  }
  const ask = promptFn || defaultPrompt;
  const answer = await ask(`${question} `);
  if (!/^y(es)?$/i.test(String(answer || '').trim())) {
    throw new Error('aborted: openrouter key use was not confirmed');
  }
  return { record, question };
}

async function defaultPrompt(text) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(text);
  } finally {
    rl.close();
  }
}
