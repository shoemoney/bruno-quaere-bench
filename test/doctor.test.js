// harness/doctor.js + harness/settings.js: CLI detection order (login shell -> PATH -> known
// dirs), the settings.json shape doctor writes, the openrouter key search order (first hit wins,
// recorded by FILE PATH only, never value), the direct-provider key search/probe (google/
// deepseek/xai: env var or aigate, then a real read-only API call to prove it actually works --
// the xai team_blocked gap this addendum closes), the model->driver resolution rule (a direct
// driver is only chosen when its key is working), and the `run` command's openrouter-consent
// prompt (fake TTY, no real terminal).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  resolveBinary,
  getVersion,
  probeOne,
  probeKeys,
  runDoctor,
  renderDoctorTable,
  anyLineupCliFailed,
  GROK_HEADLESS_UNVERIFIED_REASON,
  CLI_LIST,
} from '../src/harness/doctor.js';
import {
  findOpenrouterKey,
  readOpenrouterKey,
  findProviderKey,
  readProviderKey,
  probeProviderKey,
  resolveModels,
  openrouterConsentQuestion,
  ensureOpenrouterConsent,
  LINEUP,
} from '../src/harness/settings.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quaere-doctor-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function throwingExecFileSync() {
  throw new Error('no login shell / not found');
}

// ---------------------------------------------------------------------------
// resolveBinary(): login shell -> PATH -> known locations
// ---------------------------------------------------------------------------

test('resolveBinary() prefers a login-shell alias resolution when one is found', () =>
  withTempDir(async (dir) => {
    const aliasTarget = path.join(dir, 'real-fakecli');
    await writeFile(aliasTarget, '#!/bin/sh\necho hi\n');
    await chmod(aliasTarget, 0o755);
    const execFileSyncImpl = (cmd, args) => {
      if (cmd === 'zsh' && args[1] === "whence -p fakecli") return `${aliasTarget}\n`;
      throw new Error('unexpected exec');
    };
    const found = resolveBinary('fakecli', { execFileSyncImpl, env: { PATH: '' } });
    assert.equal(found, aliasTarget);
  }));

test('resolveBinary() falls back to a plain PATH search when the login shell has no alias', () =>
  withTempDir(async (dir) => {
    const binPath = path.join(dir, 'fakecli');
    await writeFile(binPath, '#!/bin/sh\necho hi\n');
    await chmod(binPath, 0o755);
    const found = resolveBinary('fakecli', { execFileSyncImpl: throwingExecFileSync, env: { PATH: dir } });
    assert.equal(found, binPath);
  }));

test('resolveBinary() falls back to npm global root when PATH and the login shell both miss', () =>
  withTempDir(async (dir) => {
    const npmRoot = path.join(dir, 'npm-root');
    await mkdir(npmRoot, { recursive: true });
    const binPath = path.join(npmRoot, 'fakecli');
    await writeFile(binPath, '#!/bin/sh\necho hi\n');
    await chmod(binPath, 0o755);
    const execFileSyncImpl = (cmd, args) => {
      if (cmd === 'zsh') throw new Error('not aliased');
      if (cmd === 'npm' && args[0] === 'root') return `${npmRoot}\n`;
      throw new Error('unexpected exec');
    };
    const found = resolveBinary('fakecli', { execFileSyncImpl, env: { PATH: '' } });
    assert.equal(found, binPath);
  }));

test('resolveBinary() returns null when the binary is nowhere', () =>
  withTempDir(async (dir) => {
    const execFileSyncImpl = (cmd) => {
      throw new Error(`no ${cmd}`);
    };
    const found = resolveBinary('totally-not-a-real-cli', { execFileSyncImpl, env: { PATH: dir } });
    assert.equal(found, null);
  }));

test('getVersion() returns the first line of --version output, or null on failure', () => {
  const ok = getVersion('/bin/anything', {
    execFileSyncImpl: () => 'v9.9.9\nextra noise\n',
  });
  assert.equal(ok, 'v9.9.9');
  const fail = getVersion('/bin/anything', {
    execFileSyncImpl: () => {
      throw new Error('no such flag');
    },
  });
  assert.equal(fail, null);
});

// ---------------------------------------------------------------------------
// probeOne(): the grok special case, --no-smoke, smoke success/mismatch/failure
// ---------------------------------------------------------------------------

function fakeFoundBinary(dir, name) {
  return { execFileSyncImpl: () => `${path.join(dir, name)}\n`, path: path.join(dir, name) };
}

test('probeOne("grok") never runs a live smoke -- found:true, headless:false, with the documented reason', () =>
  withTempDir(async (dir) => {
    const binPath = path.join(dir, 'grok');
    await writeFile(binPath, '#!/bin/sh\n');
    const { execFileSyncImpl } = fakeFoundBinary(dir, 'grok');
    const info = await probeOne('grok', { execFileSyncImpl, smokeTestImpl: async () => { throw new Error('should never be called'); } });
    assert.equal(info.found, true);
    assert.equal(info.headless, false);
    assert.equal(info.servedModel, null);
    assert.equal(info.error, GROK_HEADLESS_UNVERIFIED_REASON);
  }));

test('probeOne() reports found:false when the binary cannot be resolved at all', async () => {
  // A name that can't collide with a real binary anywhere on this machine's PATH/known dirs.
  const info = await probeOne('totally-not-a-real-quaere-cli', { execFileSyncImpl: throwingExecFileSync, env: { PATH: '' } });
  assert.equal(info.found, false);
  assert.equal(info.path, null);
  assert.equal(info.headless, false);
  assert.equal(info.error, 'binary not found');
});

test('probeOne() with --no-smoke skips the headless check but still reports found + version', () =>
  withTempDir(async (dir) => {
    const binPath = path.join(dir, 'ai');
    await writeFile(binPath, '#!/bin/sh\n');
    const execFileSyncImpl = () => `${binPath}\n`;
    const info = await probeOne('ai', { noSmoke: true, execFileSyncImpl });
    assert.equal(info.found, true);
    assert.equal(info.headless, false);
    assert.equal(info.error, 'smoke skipped (--no-smoke)');
  }));

test('probeOne() marks headless:true and records the served model on a clean smoke', () =>
  withTempDir(async (dir) => {
    const binPath = path.join(dir, 'ai');
    await writeFile(binPath, '#!/bin/sh\n');
    const execFileSyncImpl = () => `${binPath}\n`;
    const smokeTestImpl = async () => ({ requestedModel: 'claude-fable-5-1', servedModel: 'claude-fable-5-1', usage: {} });
    const info = await probeOne('ai', { execFileSyncImpl, smokeTestImpl });
    assert.equal(info.headless, true);
    assert.equal(info.servedModel, 'claude-fable-5-1');
    assert.equal(info.error, null);
  }));

test('probeOne() marks headless:false on a served-model mismatch (the gemini 3.8->3.5 case)', () =>
  withTempDir(async (dir) => {
    const binPath = path.join(dir, 'gemini');
    await writeFile(binPath, '#!/bin/sh\n');
    const execFileSyncImpl = () => `${binPath}\n`;
    const smokeTestImpl = async () => ({ requestedModel: 'gemini-3.8-flash', servedModel: 'gemini-3.5-flash', usage: {} });
    const info = await probeOne('gemini', { execFileSyncImpl, smokeTestImpl });
    assert.equal(info.headless, false);
    assert.equal(info.servedModel, 'gemini-3.5-flash');
    assert.match(info.error, /modelMismatch/);
  }));

test('probeOne() marks headless:false and captures the error text when the smoke throws', () =>
  withTempDir(async (dir) => {
    const binPath = path.join(dir, 'qwen');
    await writeFile(binPath, '#!/bin/sh\n');
    const execFileSyncImpl = () => `${binPath}\n`;
    const smokeTestImpl = async () => {
      throw new Error('exit 1: No model configured');
    };
    const info = await probeOne('qwen', { execFileSyncImpl, smokeTestImpl });
    assert.equal(info.headless, false);
    assert.match(info.error, /No model configured/);
  }));

// ---------------------------------------------------------------------------
// runDoctor(): settings.json shape, table rendering, exit-condition helper
// ---------------------------------------------------------------------------

test('runDoctor() writes .quaere/settings.json with the documented shape and resolves models', () =>
  withTempDir(async (repoRoot) => {
    const bins = {};
    for (const name of CLI_LIST) {
      const p = path.join(repoRoot, name);
      await writeFile(p, '#!/bin/sh\n');
      bins[name] = p;
    }
    const execFileSyncImpl = (cmd, args) => {
      const name = String(args[1] || '').replace('whence -p ', '');
      if (bins[name]) return `${bins[name]}\n`;
      throw new Error('not found');
    };
    // Every CLI smoke-tests clean except qwen (fails) so both branches of resolveModels() show up.
    const smokeTestImpl = async (cliName, { model }) => {
      if (cliName === 'qwen') throw new Error('boom');
      return { requestedModel: model, servedModel: model, usage: {} };
    };
    await writeFile(path.join(repoRoot, '.env'), 'OPENROUTER_API_KEY=sk-or-fake-test-value\n');

    // No real network here: xai's key is present (env var) but its probe reports the exact gap
    // this addendum closes (team_blocked); openrouter's key probes clean.
    const fetchImpl = async (url) => {
      const u = String(url);
      if (u.includes('api.x.ai')) return { ok: true, status: 200, json: async () => ({ team_blocked: true }) };
      if (u.includes('openrouter.ai')) return { ok: true, status: 200, json: async () => ({ data: {} }) };
      throw new Error(`unexpected fetch: ${u}`);
    };

    const { settings, table } = await runDoctor({
      repoRoot,
      execFileSyncImpl,
      smokeTestImpl,
      env: { XAI_API_KEY: 'fake-xai-key' },
      fetchImpl,
    });

    assert.equal(typeof settings.generatedAt, 'string');
    assert.ok(Object.keys(settings.clis).length === CLI_LIST.length);
    for (const name of CLI_LIST) {
      if (name === 'grok') continue;
      assert.equal(typeof settings.clis[name].found, 'boolean');
    }
    assert.equal(settings.clis.grok.headless, false);
    assert.equal(settings.clis.qwen.headless, false);
    assert.equal(settings.clis.ai.headless, true);

    // keys.openrouter is recorded by FILE PATH only -- never the value.
    assert.equal(settings.keys.openrouter.found, true);
    assert.equal(settings.keys.openrouter.source, 'dotenv');
    assert.equal(settings.keys.openrouter.file, path.join(repoRoot, '.env'));
    assert.equal(settings.keys.openrouter.working, true);
    assert.ok(!JSON.stringify(settings).includes('sk-or-fake-test-value'), 'settings.json must never carry the key value');
    assert.ok(!JSON.stringify(settings).includes('fake-xai-key'), 'settings.json must never carry the key value');

    // xai's key is FOUND (env var) but NOT working (team_blocked) -- the gap this addendum closes.
    assert.equal(settings.keys.xai.found, true);
    assert.equal(settings.keys.xai.source, 'env');
    assert.equal(settings.keys.xai.working, false);
    assert.equal(settings.keys.xai.reason, 'team_blocked');
    // google/deepseek: no key anywhere in this fixture.
    assert.equal(settings.keys.google.found, false);
    assert.equal(settings.keys.google.working, false);
    assert.equal(settings.keys.deepseek.found, false);

    // models: qwen has no direct-provider fallback in this lineup -> openrouter; grok's direct
    // fallback (xai) is found but not working (team_blocked), so it ALSO falls to openrouter now.
    assert.equal(settings.models['qwen3.8-max'].driver, 'openrouter');
    assert.equal(settings.models['x-ai/grok-4.6'].driver, 'openrouter');
    assert.match(settings.models['x-ai/grok-4.6'].reason, /team_blocked/);
    assert.equal(settings.models['gpt-6-astra'].driver, 'cli');
    // deepseek-flash has no CLI at all and no working deepseek key in this fixture -> openrouter.
    assert.equal(settings.models['deepseek-flash'].driver, 'openrouter');

    // it was actually written to disk, and read() would see the same JSON.
    const onDisk = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(repoRoot, '.quaere', 'settings.json'), 'utf8'));
    assert.deepEqual(onDisk, settings);

    assert.match(table, /CLI\s+Found\s+Path/);
    assert.match(table, /grok/);
    assert.match(table, /Providers:/);
    assert.match(table, /xai\s+✅\s+env\s+❌/);
    assert.equal(anyLineupCliFailed(settings), true); // qwen and grok both fail their lineup check
  }));

// ---------------------------------------------------------------------------
// findProviderKey() / readProviderKey() / probeProviderKey(): the google/deepseek/xai gap
// ---------------------------------------------------------------------------

test('findProviderKey(): env var wins, recorded with no file (nothing to point at)', async () => {
  const record = await findProviderKey('google', { env: { GEMINI_API_KEY: 'fake-key' } });
  assert.deepEqual(record, { found: true, source: 'env', file: null });
});

test('findProviderKey(): falls back to aigate provider "<name>" when the env var is absent', () =>
  withTempDir(async (dir) => {
    const aigateEnvPath = path.join(dir, 'aigate.env');
    await writeFile(aigateEnvPath, 'AIGATE_URL=https://aigate.example.invalid\nAIGATE_TOKEN=fake-token\n');
    const fetchImpl = async (url) => {
      assert.match(String(url), /\/api\/keys\/xai$/);
      return { ok: true, json: async () => ({ key: 'sk-xai-from-aigate' }) };
    };
    const record = await findProviderKey('xai', { env: {}, aigateEnvPath, fetchImpl });
    assert.equal(record.found, true);
    assert.equal(record.source, 'aigate');
    assert.equal(record.file, aigateEnvPath);
  }));

test('findProviderKey(): not found when neither source has it', async () => {
  const record = await findProviderKey('deepseek', { env: {}, aigateEnvPath: '/no/such/file' });
  assert.deepEqual(record, { found: false, source: null, file: null });
});

test('findProviderKey(): --no-network skips the aigate lookup entirely', async () => {
  const record = await findProviderKey('deepseek', {
    env: {},
    noNetwork: true,
    fetchImpl: async () => {
      throw new Error('should never be called');
    },
  });
  assert.deepEqual(record, { found: false, source: null, file: null });
});

test('readProviderKey(): reads the env var value only at the point of use', async () => {
  const record = { found: true, source: 'env', file: null };
  const key = await readProviderKey('deepseek', record, { env: { DEEPSEEK_API_KEY: 'sk-real-value' } });
  assert.equal(key, 'sk-real-value');
});

test('probeProviderKey("xai"): 2xx with team_blocked:true is NOT working -- the exact reported gap', async () => {
  const fetchImpl = async (url) => {
    assert.equal(String(url), 'https://api.x.ai/v1/api-key');
    return { ok: true, status: 200, json: async () => ({ team_blocked: true }) };
  };
  const result = await probeProviderKey('xai', 'sk-blocked', { fetchImpl });
  assert.equal(result.working, false);
  assert.equal(result.status, 200);
  assert.equal(result.reason, 'team_blocked');
});

test('probeProviderKey("xai"): a clean key with no blocked flags is working', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ team_blocked: false }) });
  const result = await probeProviderKey('xai', 'sk-fine', { fetchImpl });
  assert.equal(result.working, true);
});

test('probeProviderKey("xai"): any non-2xx is not working', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({ error: 'forbidden' }) });
  const result = await probeProviderKey('xai', 'sk-bad', { fetchImpl });
  assert.equal(result.working, false);
  assert.equal(result.status, 403);
  assert.equal(result.reason, 'forbidden');
});

test('probeProviderKey("google"): hits the models endpoint with the key as a query param', async () => {
  const fetchImpl = async (url) => {
    assert.match(String(url), /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\?pageSize=1&key=sk-g$/);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const result = await probeProviderKey('google', 'sk-g', { fetchImpl });
  assert.equal(result.working, true);
});

test('probeProviderKey("deepseek"): hits GET /models with a bearer header', async () => {
  const fetchImpl = async (url, opts) => {
    assert.equal(String(url), 'https://api.deepseek.com/models');
    assert.equal(opts.headers.authorization, 'Bearer sk-d');
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const result = await probeProviderKey('deepseek', 'sk-d', { fetchImpl });
  assert.equal(result.working, true);
});

test('probeProviderKey("openrouter"): hits GET auth/key with a bearer header', async () => {
  const fetchImpl = async (url, opts) => {
    assert.equal(String(url), 'https://openrouter.ai/api/v1/auth/key');
    assert.equal(opts.headers.authorization, 'Bearer sk-or');
    return { ok: true, status: 200, json: async () => ({ data: {} }) };
  };
  const result = await probeProviderKey('openrouter', 'sk-or', { fetchImpl });
  assert.equal(result.working, true);
});

test('probeProviderKey(): a network throw is caught and reported as not working, never rethrown', async () => {
  const fetchImpl = async () => {
    throw new Error('fetch failed: ECONNRESET');
  };
  const result = await probeProviderKey('xai', 'sk-x', { fetchImpl });
  assert.equal(result.working, false);
  assert.equal(result.status, null);
  assert.match(result.reason, /ECONNRESET/);
});

// ---------------------------------------------------------------------------
// probeKeys(): found-but-not-found, --no-network, and the full found+working shape
// ---------------------------------------------------------------------------

test('probeKeys(): a key that is not found anywhere is working:false with a plain reason', () =>
  withTempDir(async (repoRoot) => {
    // Isolate from this machine's real ~/.claude/settings.json / vaulted openrouter key --
    // otherwise findOpenrouterKey's (b)/(e) steps would find a real key on Jeremy's box.
    const keys = await probeKeys({
      repoRoot,
      env: {},
      aigateEnvPath: '/no/such/file',
      claudeSettingsPath: path.join(repoRoot, 'no-such-claude-settings.json'),
    });
    for (const provider of ['google', 'deepseek', 'xai', 'openrouter']) {
      assert.equal(keys[provider].found, false);
      assert.equal(keys[provider].working, false);
      assert.equal(keys[provider].reason, 'no key found');
    }
  }));

test('probeKeys(): --no-network finds env-var keys but never probes them (working:null)', () =>
  withTempDir(async (repoRoot) => {
    const keys = await probeKeys({
      repoRoot,
      noNetwork: true,
      claudeSettingsPath: path.join(repoRoot, 'no-such-claude-settings.json'),
      env: { GEMINI_API_KEY: 'sk-g', OPENROUTER_API_KEY: 'sk-or' },
      fetchImpl: async () => {
        throw new Error('should never be called under --no-network');
      },
    });
    assert.equal(keys.google.found, true);
    assert.equal(keys.google.working, null);
    assert.match(keys.google.reason, /--no-network/);
    assert.equal(keys.openrouter.found, true);
    assert.equal(keys.openrouter.working, null);
  }));

test('probeKeys(): found + working end to end for a clean google key via env var', () =>
  withTempDir(async (repoRoot) => {
    const fetchImpl = async (url) => {
      if (String(url).includes('generativelanguage.googleapis.com')) return { ok: true, status: 200, json: async () => ({}) };
      return { ok: false, status: 401, json: async () => ({ error: 'no key' }) };
    };
    const keys = await probeKeys({
      repoRoot,
      claudeSettingsPath: path.join(repoRoot, 'no-such-claude-settings.json'),
      env: { GEMINI_API_KEY: 'sk-g' },
      fetchImpl,
    });
    assert.equal(keys.google.found, true);
    assert.equal(keys.google.source, 'env');
    assert.equal(keys.google.working, true);
    assert.equal(keys.google.status, 200);
  }));

test('anyLineupCliFailed() is false only when every lineup CLI is found and headless-ok', () => {
  const clis = Object.fromEntries(
    ['ai', 'codex', 'qwen', 'gemini', 'kimi', 'grok'].map((n) => [n, { found: true, headless: true }]),
  );
  assert.equal(anyLineupCliFailed({ clis }), false);
  clis.grok.headless = false;
  assert.equal(anyLineupCliFailed({ clis }), true);
});

test('renderDoctorTable() marks each CLI with a check or an X for found and headless', () => {
  const settings = {
    clis: {
      ai: { found: true, path: '/x/ai', version: '1.0', headless: true, servedModel: 'claude-fable-5-1', error: null },
      grok: { found: true, path: '/x/grok', version: '1.0.1', headless: false, servedModel: null, error: 'unverified' },
    },
    keys: { openrouter: { found: false, source: null, file: null } },
    models: { 'claude-fable-5-1': { driver: 'cli', cli: 'ai', reason: 'ok' } },
  };
  const table = renderDoctorTable(settings);
  assert.match(table, /ai\s+✅/);
  assert.match(table, /grok\s+✅.*❌/s);
  assert.match(table, /openrouter key: not found/);
});

// ---------------------------------------------------------------------------
// settings.js: openrouter key search order (first hit wins), file-only recording
// ---------------------------------------------------------------------------

test('findOpenrouterKey(): (a) .quaere/settings.json openrouterKeyFile wins over everything else', () =>
  withTempDir(async (repoRoot) => {
    const keyFile = path.join(repoRoot, 'my-openrouter.env');
    await writeFile(keyFile, 'OPENROUTER_API_KEY=sk-or-from-settings\n');
    await mkdir(path.join(repoRoot, '.quaere'), { recursive: true });
    await writeFile(path.join(repoRoot, '.quaere', 'settings.json'), JSON.stringify({ openrouterKeyFile: keyFile }));
    await writeFile(path.join(repoRoot, '.env'), 'OPENROUTER_API_KEY=sk-or-from-dotenv\n');

    const record = await findOpenrouterKey({ repoRoot, env: { OPENROUTER_API_KEY: 'sk-or-from-env-var' } });
    assert.equal(record.found, true);
    assert.equal(record.source, 'settings.json');
    assert.equal(record.file, keyFile);
  }));

test('findOpenrouterKey(): (b) ~/.claude/settings.json env block, when (a) is absent', () =>
  withTempDir(async (repoRoot) => {
    const claudeSettingsPath = path.join(repoRoot, 'fake-claude-settings.json');
    await writeFile(claudeSettingsPath, JSON.stringify({ env: { OPENROUTER_API_KEY: 'sk-or-claude' } }));
    await writeFile(path.join(repoRoot, '.env'), 'OPENROUTER_API_KEY=sk-or-from-dotenv\n');

    const record = await findOpenrouterKey({ repoRoot, claudeSettingsPath, env: { OPENROUTER_API_KEY: 'sk-or-from-env-var' } });
    assert.equal(record.source, 'claude-settings');
    assert.equal(record.file, claudeSettingsPath);
  }));

test('findOpenrouterKey(): (c) ./.env, when (a) and (b) are absent', () =>
  withTempDir(async (repoRoot) => {
    await writeFile(path.join(repoRoot, '.env'), 'OPENROUTER_API_KEY=sk-or-from-dotenv\n');
    const record = await findOpenrouterKey({
      repoRoot,
      claudeSettingsPath: path.join(repoRoot, 'no-such-claude-settings.json'),
      env: { OPENROUTER_API_KEY: 'sk-or-from-env-var' },
    });
    assert.equal(record.source, 'dotenv');
    assert.equal(record.file, path.join(repoRoot, '.env'));
  }));

test('findOpenrouterKey(): (d) the bare env var, when nothing else is present -- no file', () =>
  withTempDir(async (repoRoot) => {
    const record = await findOpenrouterKey({
      repoRoot,
      claudeSettingsPath: path.join(repoRoot, 'nope.json'),
      env: { OPENROUTER_API_KEY: 'sk-or-from-env-var' },
    });
    assert.equal(record.found, true);
    assert.equal(record.source, 'env');
    assert.equal(record.file, null);
  }));

test('findOpenrouterKey(): (e) aigate is the last resort, and is recorded by env-file path only', () =>
  withTempDir(async (repoRoot) => {
    const aigateEnvPath = path.join(repoRoot, 'aigate.env');
    await writeFile(aigateEnvPath, 'AIGATE_URL=https://aigate.example.invalid\nAIGATE_TOKEN=fake-token\n');
    const fetchImpl = async (url) => {
      assert.match(String(url), /\/api\/keys\/openrouter$/);
      return { ok: true, json: async () => ({ provider: 'openrouter', key: 'sk-or-from-aigate' }) };
    };
    const record = await findOpenrouterKey({
      repoRoot,
      claudeSettingsPath: path.join(repoRoot, 'nope.json'),
      aigateEnvPath,
      env: {},
      fetchImpl,
    });
    assert.equal(record.found, true);
    assert.equal(record.source, 'aigate');
    assert.equal(record.file, aigateEnvPath);
  }));

test('findOpenrouterKey(): not found when every source misses', () =>
  withTempDir(async (repoRoot) => {
    const record = await findOpenrouterKey({
      repoRoot,
      claudeSettingsPath: path.join(repoRoot, 'nope.json'),
      aigateEnvPath: path.join(repoRoot, 'nope-aigate.env'),
      env: {},
    });
    assert.equal(record.found, false);
    assert.equal(record.source, null);
    assert.equal(record.file, null);
  }));

test('readOpenrouterKey() reads the actual value only at the point of use, from the recorded file', () =>
  withTempDir(async (repoRoot) => {
    await writeFile(path.join(repoRoot, '.env'), 'OPENROUTER_API_KEY=sk-or-real-value\n');
    const record = { found: true, source: 'dotenv', file: path.join(repoRoot, '.env') };
    const key = await readOpenrouterKey(record);
    assert.equal(key, 'sk-or-real-value');
  }));

// ---------------------------------------------------------------------------
// resolveModels(): cli headless-ok -> cli; else a direct provider driver, but ONLY when its key
// is working; else openrouter. This is the doctor addendum's core rule -- the grok/xai gap
// (a direct driver picked purely because the CLI failed, with no check that the key even works).
// ---------------------------------------------------------------------------

test('resolveModels() picks cli when headless-ok, a direct driver when its key is working, else openrouter', () => {
  const clis = {
    ai: { found: true, headless: true },
    codex: { found: false, headless: false },
    qwen: { found: true, headless: false },
    gemini: { found: true, headless: false }, // e.g. the 3.8->3.5 mismatch
    kimi: { found: true, headless: true },
    grok: { found: true, headless: false },
  };
  const keys = {
    google: { found: true, working: true, reason: 'ok' },
    xai: { found: true, working: false, reason: 'team_blocked' }, // the reported gap
    deepseek: { found: true, working: true, reason: 'ok' },
  };
  const models = resolveModels(clis, keys, LINEUP);
  assert.deepEqual(models['claude-fable-5-1'], { driver: 'cli', cli: 'ai', reason: 'CLI found and headless smoke passed' });
  assert.equal(models['gpt-6-astra'].driver, 'openrouter'); // codex missing, no direct fallback
  assert.equal(models['qwen3.8-max'].driver, 'openrouter'); // qwen not headless-ok, no direct fallback
  assert.equal(models['gemini-3.8-flash'].driver, 'google'); // direct fallback exists and works
  assert.equal(models['kimi-code/k3'].driver, 'cli');
  // grok's CLI failed AND its direct fallback key (xai) is team_blocked -> openrouter, not xai.
  assert.equal(models['x-ai/grok-4.6'].driver, 'openrouter');
  assert.match(models['x-ai/grok-4.6'].reason, /team_blocked/);
  assert.equal(models['deepseek-flash'].driver, 'deepseek'); // no cli at all for this lab, key works
});

test('resolveModels() falls back to openrouter for a direct-driver entry whose key was never found', () => {
  const clis = { grok: { found: false, headless: false } };
  const models = resolveModels(clis, {}, LINEUP);
  assert.equal(models['x-ai/grok-4.6'].driver, 'openrouter');
  assert.match(models['x-ai/grok-4.6'].reason, /key not found/);
});

// ---------------------------------------------------------------------------
// ensureOpenrouterConsent(): the exact prompt sentence, --yes, and non-TTY abort
// ---------------------------------------------------------------------------

test('openrouterConsentQuestion() prints the exact required sentence', () => {
  assert.equal(
    openrouterConsentQuestion({ found: true, source: 'dotenv', file: '/repo/.env' }),
    'This will use openrouter key in /repo/.env. Continue? [y/N]',
  );
  assert.equal(
    openrouterConsentQuestion({ found: true, source: 'env', file: null }),
    'This will use openrouter key in the OPENROUTER_API_KEY environment variable. Continue? [y/N]',
  );
});

test('ensureOpenrouterConsent(): --yes skips the prompt entirely', async () => {
  let asked = false;
  await ensureOpenrouterConsent({
    yes: true,
    isTTY: true,
    promptFn: async () => {
      asked = true;
      return 'y';
    },
    findOpenrouterKeyFn: async () => ({ found: true, source: 'dotenv', file: '/repo/.env' }),
  });
  assert.equal(asked, false);
});

test('ensureOpenrouterConsent(): a fake TTY answering "y" proceeds', async () => {
  await ensureOpenrouterConsent({
    yes: false,
    isTTY: true,
    promptFn: async () => 'y',
    findOpenrouterKeyFn: async () => ({ found: true, source: 'dotenv', file: '/repo/.env' }),
  });
});

test('ensureOpenrouterConsent(): a fake TTY answering "n" (or anything else) aborts', async () => {
  await assert.rejects(
    ensureOpenrouterConsent({
      yes: false,
      isTTY: true,
      promptFn: async () => 'n',
      findOpenrouterKeyFn: async () => ({ found: true, source: 'dotenv', file: '/repo/.env' }),
    }),
    /not confirmed/,
  );
});

test('ensureOpenrouterConsent(): no TTY and no --yes aborts with the sentence plus "pass --yes"', async () => {
  await assert.rejects(
    ensureOpenrouterConsent({
      yes: false,
      isTTY: false,
      findOpenrouterKeyFn: async () => ({ found: true, source: 'dotenv', file: '/repo/.env' }),
    }),
    /This will use openrouter key in \/repo\/\.env\. Continue\? \[y\/N\] pass --yes/,
  );
});
