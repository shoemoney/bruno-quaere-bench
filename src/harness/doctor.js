// `quaere doctor`: scan this Mac for every lineup CLI, run a trivial headless smoke test through
// each adapter's own build()/parseUsage(), probe every direct-provider key (google/deepseek/xai)
// and the OpenRouter key against their own APIs, resolve a driver per lineup model, and write
// .quaere/settings.json.
//
// Zero deps; every child process is spawned in the foreground with a hard timeout -- doctor never
// backgrounds a CLI and waits. `--no-network` skips the provider-key probes (CLI smoke tests are
// skipped separately by `--no-smoke`).

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadAdapter } from './cli/index.js';
import {
  LINEUP,
  findOpenrouterKey,
  readOpenrouterKey,
  findProviderKey,
  readProviderKey,
  probeProviderKey,
  resolveModels,
  writeSettings,
  SMOKE_SKIPPED_ERROR,
} from './settings.js';

// The direct-provider drivers this lineup can fall back to (google/deepseek/xai), derived from
// LINEUP itself so this list can never drift out of sync with settings.js's own mapping.
const DIRECT_PROVIDERS = [...new Set(LINEUP.filter((entry) => entry.directDriver).map((entry) => entry.directDriver))];

// The seven CLIs this bench's lineup can run through (deepseek-flash has no CLI at all).
export const CLI_LIST = ['ai', 'codex', 'qwen', 'gemini', 'kimi', 'grok', 'muse'];

// One trivial, cheap prompt reused for every CLI's smoke test -- just enough to prove the
// binary, its auth, and its headless flag all actually work end to end.
export const SMOKE_PROMPT = 'Reply with exactly the single word: PONG';

// The model each CLI is smoke-tested against -- the lineup id that CLI drives (settings.js LINEUP).
const SMOKE_MODEL = Object.fromEntries(LINEUP.filter((e) => e.cli).map((e) => [e.cli, e.id]));

// grok.js's header comment (verified against the installed @vibe-kit/grok-cli source,
// processPromptHeadless()): `-p` prints only {role, content} JSON lines, with no model or usage
// field anywhere in the stream, ever. There is nothing a live smoke run could show that isn't
// already known from reading the CLI's own source, so doctor records the finding without
// spending a real xAI-billed call to reconfirm it.
export const GROK_HEADLESS_UNVERIFIED_REASON =
  'grok-cli\'s -p headless output never reports the served model or token usage ' +
  '(verified against @vibe-kit/grok-cli\'s own source: it prints bare {role,content} JSON per ' +
  'turn, discarding the provider response after extracting text) -- cannot confirm which model ' +
  'actually answered, so this is not run as a verified headless smoke.';

const KNOWN_DIRS = [path.join('/opt', 'homebrew', 'bin'), path.join(os.homedir(), '.local', 'bin')];

function tryNpmGlobalDirs(execFileSyncImpl) {
  try {
    const root = execFileSyncImpl('npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
    if (!root) return [];
    return [root, path.join(path.dirname(root), 'bin')];
  } catch {
    return [];
  }
}

// resolveBinary(name, opts) -> path | null. Login shell first (several of these are aliases on
// this box: gemini, grok), then a plain PATH search, then known install locations.
export function resolveBinary(name, { execFileSyncImpl = execFileSync, env = process.env } = {}) {
  try {
    const out = execFileSyncImpl('zsh', ['-ic', `whence -p ${name}`], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    const line = out.trim().split('\n').filter(Boolean).pop();
    if (line && fs.existsSync(line)) return line;
  } catch {
    // not aliased, or no login shell available -- fall through to a plain PATH search
  }

  const pathDirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }

  for (const dir of [...KNOWN_DIRS, ...tryNpmGlobalDirs(execFileSyncImpl)]) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

export function getVersion(binPath, { execFileSyncImpl = execFileSync } = {}) {
  try {
    const out = execFileSyncImpl(binPath, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    return out.trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

function truncate(text, max = 500) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// smokeTest(cliName, {model, binPath, spawnSyncImpl, timeoutMs}) -> Promise<{servedModel,
// modelVersion, requestedModel, usage}>, or throws. Seeds an isolated temp HOME + sandbox, calls
// the adapter's own copyAuth()/build()/parseUsage() exactly as run-cli.js does for a real climb,
// just for one trivial prompt instead of a whole ladder.
export async function smokeTest(cliName, { model, spawnSyncImpl = spawnSync, timeoutMs = 90_000, adapter: adapterOverride } = {}) {
  const adapter = adapterOverride || (await loadAdapter(cliName));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `quaere-doctor-${cliName}-`));
  const home = path.join(base, 'home');
  const sandbox = path.join(base, 'sandbox');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(sandbox, { recursive: true });
  try {
    if (typeof adapter.copyAuth === 'function') await adapter.copyAuth(home);
    const spec = await adapter.build({ sandbox, prompt: SMOKE_PROMPT, model, home });
    const res = spawnSyncImpl(spec.cmd, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    if (res.error) throw res.error;
    const stdout = res.stdout || '';
    if (res.status !== 0 && !stdout.trim()) {
      throw new Error(`exit ${res.status ?? 'signal ' + res.signal}: ${truncate(res.stderr)}`);
    }
    const usage = adapter.parseUsage(stdout, home);
    return { requestedModel: model, servedModel: usage.modelVersion || null, usage };
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// probeOne(cliName, {noSmoke, execFileSyncImpl, spawnSyncImpl, smokeTestImpl}) -> Promise<{found,
// path, version, headless, servedModel, error}>. `smokeTestImpl` (default the real smokeTest
// above) is injectable so a test can fake a CLI's smoke result without a real binary or network.
export async function probeOne(cliName, { noSmoke = false, execFileSyncImpl, spawnSyncImpl, smokeTestImpl = smokeTest, env } = {}) {
  const binPath = resolveBinary(cliName, { execFileSyncImpl, ...(env ? { env } : {}) });
  if (!binPath) {
    return { found: false, path: null, version: null, headless: false, servedModel: null, error: 'binary not found' };
  }
  const version = getVersion(binPath, { execFileSyncImpl });

  if (cliName === 'grok') {
    // See GROK_HEADLESS_UNVERIFIED_REASON above -- no live call, by design.
    return { found: true, path: binPath, version, headless: false, servedModel: null, error: GROK_HEADLESS_UNVERIFIED_REASON };
  }

  if (noSmoke) {
    return { found: true, path: binPath, version, headless: false, servedModel: null, error: SMOKE_SKIPPED_ERROR };
  }

  const model = SMOKE_MODEL[cliName];
  try {
    const result = await smokeTestImpl(cliName, { model, spawnSyncImpl });
    const mismatch = result.servedModel && result.servedModel !== model;
    if (mismatch) {
      return {
        found: true,
        path: binPath,
        version,
        headless: false,
        servedModel: result.servedModel,
        error: `served model "${result.servedModel}" does not match requested "${model}" (modelMismatch)`,
      };
    }
    return { found: true, path: binPath, version, headless: true, servedModel: result.servedModel, error: null };
  } catch (err) {
    return { found: true, path: binPath, version, headless: false, servedModel: null, error: truncate(err.message || String(err)) };
  }
}

// resolveKeyStatus(record, {noNetwork, probe}) -> Promise<record & {working, status, reason}>.
// Shared by every provider below: not found -> working:false with a plain reason; --no-network
// -> working:null (never probed, never claimed working); otherwise runs `probe()` (which reads
// the key VALUE and throws it away the moment probeProviderKey returns) and folds its result in.
// A probe that throws (e.g. aigate unreachable at read time) is recorded as not-working, not
// thrown further -- one bad key must never abort the rest of doctor's scan.
async function resolveKeyStatus(record, { noNetwork, probe }) {
  if (!record.found) return { ...record, working: false, status: null, reason: 'no key found' };
  if (noNetwork) return { ...record, working: null, status: null, reason: 'network probe skipped (--no-network)' };
  try {
    const result = await probe();
    return { ...record, ...result };
  } catch (err) {
    return { ...record, working: false, status: null, reason: truncate(err.message || String(err)) };
  }
}

// probeKeys({repoRoot, noNetwork, env, ...keyOpts}) -> Promise<{google, deepseek, xai,
// openrouter}>, each {found, source, file, working, status, reason}. Every direct-provider
// driver this lineup can fall back to, plus openrouter (the universal last resort) -- probed the
// same way doctor smokes a CLI: a real, cheap, read-only call against the provider's own API.
export async function probeKeys({
  repoRoot = process.cwd(),
  noNetwork = false,
  env,
  fetchImpl,
  aigateEnvPath,
  aigateBaseUrl,
  findOpenrouterKeyImpl = findOpenrouterKey,
  findProviderKeyImpl = findProviderKey,
  readOpenrouterKeyImpl = readOpenrouterKey,
  readProviderKeyImpl = readProviderKey,
  probeProviderKeyImpl = probeProviderKey,
  ...openrouterFindOpts
} = {}) {
  const keys = {};
  for (const provider of DIRECT_PROVIDERS) {
    // eslint-disable-next-line no-await-in-loop -- probed one at a time, in the foreground.
    const record = await findProviderKeyImpl(provider, { env, fetchImpl, aigateEnvPath, aigateBaseUrl, noNetwork });
    // eslint-disable-next-line no-await-in-loop
    keys[provider] = await resolveKeyStatus(record, {
      noNetwork,
      probe: async () => {
        const key = await readProviderKeyImpl(provider, record, { env, fetchImpl, aigateBaseUrl });
        return probeProviderKeyImpl(provider, key, { fetchImpl });
      },
    });
  }

  const orRecord = await findOpenrouterKeyImpl({ repoRoot, env, fetchImpl, aigateEnvPath, aigateBaseUrl, noNetwork, ...openrouterFindOpts });
  keys.openrouter = await resolveKeyStatus(orRecord, {
    noNetwork,
    probe: async () => {
      const key = await readOpenrouterKeyImpl(orRecord, { env, fetchImpl, aigateBaseUrl });
      return probeProviderKeyImpl('openrouter', key, { fetchImpl });
    },
  });

  return keys;
}

// runDoctor({repoRoot, noSmoke, noNetwork, cliList, ...opts}) -> Promise<{settings, table}>.
// Writes .quaere/settings.json as a side effect (via settings.js's writeSettings()).
export async function runDoctor({
  repoRoot = process.cwd(),
  noSmoke = false,
  noNetwork = false,
  cliList = CLI_LIST,
  execFileSyncImpl,
  spawnSyncImpl,
  smokeTestImpl,
  probeOneImpl = probeOne,
  probeKeysImpl = probeKeys,
  env,
  ...keyOpts
} = {}) {
  const clis = {};
  for (const cliName of cliList) {
    // eslint-disable-next-line no-await-in-loop -- CLIs are probed one at a time, in the
    // foreground, never fanned out into background jobs.
    clis[cliName] = await probeOneImpl(cliName, { noSmoke, execFileSyncImpl, spawnSyncImpl, smokeTestImpl, env });
  }

  const keys = await probeKeysImpl({ repoRoot, noNetwork, env, ...keyOpts });
  const models = resolveModels(clis, keys);

  const settings = {
    generatedAt: new Date().toISOString(),
    clis,
    keys,
    models,
  };

  writeSettings(repoRoot, settings);
  return { settings, table: renderDoctorTable(settings) };
}

function pad(str, width) {
  const s = String(str);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

// renderDoctorTable(settings) -> a fixed-width text table, one row per CLI, ✅/❌ per column.
export function renderDoctorTable(settings) {
  const rows = Object.entries(settings.clis).map(([cliName, info]) => ({
    cli: cliName,
    found: info.found ? '✅' : '❌',
    path: info.path || '—',
    version: info.version || '—',
    headless: info.headless ? '✅' : '❌',
    servedModel: info.servedModel || '—',
    error: info.error || '',
  }));

  const cols = [
    { key: 'cli', label: 'CLI' },
    { key: 'found', label: 'Found' },
    { key: 'path', label: 'Path' },
    { key: 'version', label: 'Version' },
    { key: 'headless', label: 'Headless' },
    { key: 'servedModel', label: 'Served Model' },
    { key: 'error', label: 'Error' },
  ];
  const widths = cols.map((c) => Math.max(c.label.length, ...rows.map((r) => String(r[c.key]).length)));

  const lines = [];
  lines.push(cols.map((c, i) => pad(c.label, widths[i])).join('  '));
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    lines.push(cols.map((c, i) => pad(row[c.key], widths[i])).join('  '));
  }

  lines.push('');
  lines.push(
    settings.keys.openrouter.found
      ? `openrouter key: found via ${settings.keys.openrouter.source}${settings.keys.openrouter.file ? ` (${settings.keys.openrouter.file})` : ''}`
      : 'openrouter key: not found',
  );

  lines.push('');
  lines.push('Providers:');
  const providerRows = Object.entries(settings.keys).map(([provider, info]) => ({
    provider,
    found: info.found ? '✅' : '❌',
    source: info.source || '—',
    working: info.working === true ? '✅' : info.working === false ? '❌' : '—',
    status: info.status !== null && info.status !== undefined ? String(info.status) : '—',
    reason: info.reason || '',
  }));
  const providerCols = [
    { key: 'provider', label: 'Provider' },
    { key: 'found', label: 'Found' },
    { key: 'source', label: 'Source' },
    { key: 'working', label: 'Working' },
    { key: 'status', label: 'Status' },
    { key: 'reason', label: 'Reason' },
  ];
  const providerWidths = providerCols.map((c) => Math.max(c.label.length, ...providerRows.map((r) => String(r[c.key]).length)));
  lines.push(providerCols.map((c, i) => pad(c.label, providerWidths[i])).join('  '));
  lines.push(providerWidths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of providerRows) {
    lines.push(providerCols.map((c, i) => pad(row[c.key], providerWidths[i])).join('  '));
  }

  lines.push('');
  lines.push('models:');
  for (const [id, m] of Object.entries(settings.models)) {
    lines.push(`  ${id}: driver=${m.driver}${m.cli ? ` cli=${m.cli}` : ''} (${m.reason})`);
  }

  return `${lines.join('\n')}\n`;
}

// anyLineupCliFailed(settings) -> true if any lineup CLI (all but deepseek-flash, which has none)
// is missing or failed its smoke -- the doctor command's non-zero exit condition. A found CLI
// whose smoke was deliberately skipped (--no-smoke; SMOKE_SKIPPED_ERROR) is NOT a failure --
// resolveModels() already routes it to the cli driver just like a passed smoke, so doctor exiting
// 1 here for that same CLI would contradict the settings.json it just wrote. Any other
// found-but-not-headless CLI (a real smoke failure, or grok's by-design unverified-headless case)
// still counts as a failure.
export function anyLineupCliFailed(settings) {
  return LINEUP.filter((entry) => entry.cli).some((entry) => {
    const info = settings.clis[entry.cli];
    if (!info || !info.found) return true;
    if (info.headless) return false;
    return info.error !== SMOKE_SKIPPED_ERROR;
  });
}
