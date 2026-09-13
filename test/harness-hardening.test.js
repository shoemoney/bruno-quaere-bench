// Addendum J harness rules: admin-port hardening (a per-run X-Admin-Token, generated here and
// sent on every admin call, never persisted to the sandbox or TASK.md), the adminProbes/
// violationSamples fields on result.json (and the voiding rule: any adminProbe voids the run),
// the 5000-bru-request turn cap, and board.js's Probes column + violation-sample rendering.
//
// The admin-port ENFORCEMENT of the token (401 on missing/wrong X-Admin-Token, logging the
// attempt) is api/admin.js's job -- a different workstream, not touched here. These tests prove
// the harness's own half of the contract: it generates the token, sends it unconditionally on
// every admin call it makes, never writes it anywhere the agent's sandbox can read it, and reads
// back {adminProbes, samples} from GET /admin/violations the moment that endpoint reports them
// (faked here via a stubbed fetch, since the real endpoint doesn't emit those fields yet).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { climb } from '../src/harness/run.js';
import { climb as cliClimb } from '../src/harness/run-cli.js';
import { superviseProcess } from '../src/harness/supervise.js';
import { scoreRuns } from '../src/harness/score.js';
import { renderBoard } from '../src/harness/board.js';
import { makeWorld, fieldName } from '../src/world.js';

let nextPort = 49900;
function freshPorts() {
  const publicPort = nextPort;
  const adminPort = nextPort + 1;
  nextPort += 2;
  return { publicPort, adminPort };
}

async function withOutDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quaere-hardening-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// makeScriptedDriver(script): same contract every other harness-*.test.js file uses -- one `ls`
// tool call per turn by default, so the loop advances without needing `bru` on PATH.
function makeScriptedDriver(script) {
  let i = 0;
  return {
    async step() {
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      const toolCalls = 'toolCalls' in step ? step.toolCalls : [{ id: `t${i}`, name: 'ls', input: { path: '.' } }];
      return {
        assistant: step.assistant || '',
        toolCalls,
        usage: step.usage || { input_tokens: 50, output_tokens: 50 },
        stop: toolCalls.length ? 'tool_use' : 'end_turn',
      };
    },
  };
}

// withAdminSpy(fn): wraps global.fetch to record every request whose path starts with `/admin/`
// (url, method, headers) while still letting it hit the real in-process server -- climb() starts
// a REAL createServer, so this only observes and never has to fake the transport.
async function withAdminSpy(fn) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.pathname.startsWith('/admin/')) {
      seen.push({ pathname: u.pathname, method: opts.method || 'GET', headers: opts.headers || {} });
    }
    return original(url, opts);
  };
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = original;
  }
}

// withFakeViolations(body, fn): wraps global.fetch so GET .../admin/violations resolves with a
// synthetic `body` instead of the real (today: {count, samples}) server response -- everything
// else passes straight through to the real in-process server. This is the "fake" half of these
// tests: admin.js doesn't emit `adminProbes` yet, so the only way to prove run.js/run-cli.js
// consume it correctly is to hand them a response that already has it.
async function withFakeViolations(body, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.pathname === '/admin/violations') {
      return { ok: true, json: async () => body };
    }
    return original(url, opts);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// ---------------------------------------------------------------------------
// run.js: admin token generation and propagation
// ---------------------------------------------------------------------------

test('climb(): generates a per-run X-Admin-Token and sends it on every admin call', async () => {
  await withOutDir(async (outDir) => {
    const driver = makeScriptedDriver([{}, {}, {}]);
    await withAdminSpy(async (seen) => {
      await climb({ model: 'fake-hardening-a', seed: 1, outDir, driver, maxTurns: 3, ...freshPorts() });

      assert.ok(seen.length >= 3, 'expected at least the rungs-set, submissions-poll, and violations calls');
      const tokens = new Set(seen.map((r) => r.headers['x-admin-token']));
      assert.equal(tokens.size, 1, 'every admin call in one climb uses the same token');
      const [token] = [...tokens];
      assert.equal(typeof token, 'string');
      assert.ok(token.length >= 32, 'the token is a real random secret, not a short/empty placeholder');
      // Every admin route the harness calls must have carried it, not just some.
      const paths = new Set(seen.map((r) => r.pathname));
      assert.ok(paths.has('/admin/rungs'));
      assert.ok(paths.has('/admin/submissions'));
      assert.ok(paths.has('/admin/violations'));
      for (const r of seen) assert.equal(r.headers['x-admin-token'], token, `${r.method} ${r.pathname} missing/wrong token`);
    });
  });
});

test('climb(): two separate climbs are issued two different admin tokens', async () => {
  await withOutDir(async (outDir) => {
    const tokensSeen = [];
    await withAdminSpy(async (seen) => {
      const driver1 = makeScriptedDriver([{}]);
      await climb({ model: 'fake-hardening-b1', seed: 1, outDir, driver: driver1, maxTurns: 1, ...freshPorts() });
      tokensSeen.push(seen[0].headers['x-admin-token']);
    });
    await withAdminSpy(async (seen) => {
      const driver2 = makeScriptedDriver([{}]);
      await climb({ model: 'fake-hardening-b2', seed: 2, outDir, driver: driver2, maxTurns: 1, ...freshPorts() });
      tokensSeen.push(seen[0].headers['x-admin-token']);
    });
    assert.notEqual(tokensSeen[0], tokensSeen[1]);
  });
});

test('climb(): the admin token is never written into spec.json, SKILL.md, transcript.jsonl, or result.json', async () => {
  await withOutDir(async (outDir) => {
    const driver = makeScriptedDriver([{}, {}]);
    let capturedToken;
    await withAdminSpy(async (seen) => {
      await climb({ model: 'fake-hardening-c', seed: 3, outDir, driver, maxTurns: 2, skillBytes: 2000, ...freshPorts() });
      capturedToken = seen[0].headers['x-admin-token'];
    });
    assert.ok(capturedToken);
    const runDir = path.join(outDir, 'fake-hardening-c', '3', '1');
    const [spec, skill, transcript, result] = await Promise.all([
      readFile(path.join(runDir, 'sandbox', 'spec.json'), 'utf8'),
      readFile(path.join(runDir, 'sandbox', 'SKILL.md'), 'utf8'),
      readFile(path.join(runDir, 'transcript.jsonl'), 'utf8'),
      readFile(path.join(runDir, 'result.json'), 'utf8'),
    ]);
    for (const [name, text] of [
      ['spec.json', spec],
      ['SKILL.md', skill],
      ['transcript.jsonl', transcript],
      ['result.json', result],
    ]) {
      assert.ok(!text.includes(capturedToken), `${name} must never contain the admin token`);
    }
  });
});

// ---------------------------------------------------------------------------
// run.js: turn cap -- 5000 bru requests -> stoppedBecause 'turns'
// ---------------------------------------------------------------------------

test("climb(): the bru-call cap stops the run with stoppedBecause 'turns'", async () => {
  await withOutDir(async (outDir) => {
    // Every turn calls `bru` once; maxBruCalls is overridden down from the real 5000 so the test
    // doesn't need to run 5000 turns to prove the rule.
    const driver = makeScriptedDriver([{ toolCalls: [{ id: 't', name: 'bru', input: { args: '--version' } }] }]);
    const result = await climb({
      model: 'fake-hardening-turns',
      seed: 4,
      outDir,
      driver,
      maxTurns: 10,
      maxBruCalls: 3,
      budgetTokens: 10_000_000,
      ...freshPorts(),
    });
    assert.equal(result.stoppedBecause, 'turns');
    assert.equal(result.rung, -1, 'never submitted anything, so no rung was cleared');
  });
});

test('climb(): a mix of bru and non-bru tool calls only counts the bru ones toward the cap', async () => {
  await withOutDir(async (outDir) => {
    const script = [
      { toolCalls: [{ id: 't1', name: 'ls', input: { path: '.' } }] },
      { toolCalls: [{ id: 't2', name: 'bru', input: { args: 'run a.bru' } }] },
      { toolCalls: [{ id: 't3', name: 'ls', input: { path: '.' } }] },
      { toolCalls: [{ id: 't4', name: 'bru', input: { args: 'run b.bru' } }] },
    ];
    const driver = makeScriptedDriver(script);
    const result = await climb({
      model: 'fake-hardening-mixed-turns',
      seed: 41,
      outDir,
      driver,
      maxTurns: 4,
      maxBruCalls: 2,
      budgetTokens: 10_000_000,
      ...freshPorts(),
    });
    // Two `ls` + two `bru` across 4 turns: the cap (2 bru calls) is reached on turn 4, not turn 2.
    assert.equal(result.stoppedBecause, 'turns');
    assert.equal(result.turns, 4);
  });
});

// ---------------------------------------------------------------------------
// run.js: adminProbes voids the run; violationSamples persist (up to 20)
// ---------------------------------------------------------------------------

test("climb(): adminProbes > 0 voids the run as stoppedBecause 'voided-admin-probe', overriding a clean stop", async () => {
  await withOutDir(async (outDir) => {
    const driver = makeScriptedDriver([{}, {}]);
    const result = await withFakeViolations(
      {
        count: 2,
        samples: [
          { ua: 'python-requests/2.31', method: 'GET', path: '/admin/world' },
          { ua: 'curl/8.4.0', method: 'POST', path: '/admin/rungs/advance' },
        ],
        adminProbes: 3,
      },
      () =>
        climb({
          model: 'fake-hardening-probe',
          seed: 6,
          outDir,
          driver,
          maxTurns: 2,
          budgetTokens: 10_000_000,
          ...freshPorts(),
        }),
    );
    assert.equal(result.stoppedBecause, 'voided-admin-probe');
    assert.equal(result.adminProbes, 3);
    assert.equal(result.violations, 2);
    assert.deepEqual(result.violationSamples, [
      { ua: 'python-requests/2.31', method: 'GET', path: '/admin/world' },
      { ua: 'curl/8.4.0', method: 'POST', path: '/admin/rungs/advance' },
    ]);
  });
});

test('climb(): violationSamples is capped at 20 even when the API reports more', async () => {
  await withOutDir(async (outDir) => {
    const driver = makeScriptedDriver([{}]);
    const samples = Array.from({ length: 25 }, (_, i) => ({ ua: `bad-agent/${i}`, method: 'GET', path: `/x/${i}` }));
    const result = await withFakeViolations({ count: 25, samples, adminProbes: 0 }, () =>
      climb({ model: 'fake-hardening-samples', seed: 7, outDir, driver, maxTurns: 1, ...freshPorts() }),
    );
    assert.equal(result.violationSamples.length, 20);
    assert.notEqual(result.stoppedBecause, 'voided-admin-probe', 'adminProbes: 0 must not void the run');
  });
});

test("climb(): adminProbes absent from the response (today's real server) defaults to 0 and never voids a run", async () => {
  await withOutDir(async (outDir) => {
    const driver = makeScriptedDriver([{}]);
    const result = await climb({ model: 'fake-hardening-noprobe', seed: 8, outDir, driver, maxTurns: 1, ...freshPorts() });
    assert.equal(result.adminProbes, 0);
    assert.deepEqual(result.violationSamples, []);
    assert.notEqual(result.stoppedBecause, 'voided-admin-probe');
  });
});

// Addendum K: axios/* admin-log hits are bru's own script sandbox, kept on a separate
// scriptRequests column and never folded into violations or the void rule.
test('climb(): scriptRequests and scriptSamples are read from /admin/violations onto result.json, separate from violations', async () => {
  await withOutDir(async (outDir) => {
    const driver = makeScriptedDriver([{}]);
    const result = await withFakeViolations(
      {
        count: 1,
        samples: [{ ua: 'curl/8.4.0', method: 'GET', path: '/workspaces' }],
        scriptRequests: 2,
        scriptSamples: [
          { ua: 'axios/1.16.0', method: 'POST', path: '/auth/token' },
          { ua: 'axios/1.16.0', method: 'GET', path: '/workspaces' },
        ],
        adminProbes: 0,
      },
      () => climb({ model: 'fake-hardening-scripted', seed: 9, outDir, driver, maxTurns: 1, ...freshPorts() }),
    );
    assert.equal(result.violations, 1);
    assert.equal(result.scriptRequests, 2);
    assert.deepEqual(result.scriptSamples, [
      { ua: 'axios/1.16.0', method: 'POST', path: '/auth/token' },
      { ua: 'axios/1.16.0', method: 'GET', path: '/workspaces' },
    ]);
    assert.notEqual(result.stoppedBecause, 'voided-admin-probe', 'scriptRequests must never void a run');
  });
});

test('climb(): scriptRequests absent from the response defaults to 0 with an empty scriptSamples array', async () => {
  await withOutDir(async (outDir) => {
    const driver = makeScriptedDriver([{}]);
    const result = await climb({ model: 'fake-hardening-noscript', seed: 10, outDir, driver, maxTurns: 1, ...freshPorts() });
    assert.equal(result.scriptRequests, 0);
    assert.deepEqual(result.scriptSamples, []);
  });
});

// ---------------------------------------------------------------------------
// supervise.js: X-Admin-Token propagation and the turn cap (CLI path)
// ---------------------------------------------------------------------------

// startFakeAdmin: same shape as test/supervise.test.js's helper, extended with /admin/log so the
// turn-cap poll has something to read, and header capture so the token-propagation test can see it.
function startFakeAdmin({ submissions = [], log = [] } = {}) {
  const state = { headersSeen: [] };
  const server = http.createServer((req, res) => {
    state.headersSeen.push({ path: req.url, headers: req.headers });
    const url = new URL(req.url, 'http://admin.internal');
    if (req.method === 'GET' && url.pathname === '/admin/submissions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: typeof submissions === 'function' ? submissions() : submissions }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/admin/rungs/advance') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ current: 0 }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/admin/log') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: typeof log === 'function' ? log() : log }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: `no fake admin route for ${req.method} ${url.pathname}` }));
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        get headersSeen() {
          return state.headersSeen;
        },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('superviseProcess: forwards X-Admin-Token on every admin request it makes', async () => {
  const admin = await startFakeAdmin({ submissions: [{ rung: 0, pass: true }] });
  try {
    await superviseProcess({
      cmd: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      adminBase: admin.baseUrl,
      adminToken: 'test-secret-token',
      topRung: 0,
      pollMs: 20,
      drainMs: 500,
    });
    assert.ok(admin.headersSeen.length > 0);
    for (const req of admin.headersSeen) {
      assert.equal(req.headers['x-admin-token'], 'test-secret-token', `${req.path} missing the admin token`);
    }
  } finally {
    await admin.close();
  }
});

test("superviseProcess: the bru-request cap (read from /admin/log) kills the tree with killedFor 'turns'", async () => {
  const bruEntries = Array.from({ length: 5 }, () => ({ ua: 'bruno-runtime/1.2.3' }));
  const admin = await startFakeAdmin({ submissions: [], log: bruEntries });
  try {
    const outcome = await superviseProcess({
      cmd: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      adminBase: admin.baseUrl,
      adminToken: 'test-secret-token',
      maxBruTurns: 3,
      pollMs: 20,
      drainMs: 500,
      wallMsLeft: 10_000,
    });
    assert.equal(outcome.killedFor, 'turns');
  } finally {
    await admin.close();
  }
});

test('superviseProcess: a log shorter than the cap never trips the turn-cap kill', async () => {
  const admin = await startFakeAdmin({ submissions: [{ rung: 0, pass: true }], log: [{ ua: 'bruno-runtime/1.2.3' }] });
  try {
    const outcome = await superviseProcess({
      cmd: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      adminBase: admin.baseUrl,
      adminToken: 'test-secret-token',
      maxBruTurns: 5000,
      topRung: 0,
      pollMs: 20,
      drainMs: 500,
    });
    assert.equal(outcome.killedFor, 'top', 'the real submission still decides the outcome, not the far-off cap');
  } finally {
    await admin.close();
  }
});

// ---------------------------------------------------------------------------
// run-cli.js: end-to-end -- admin token sent, adminProbes voids the run, and the turn cap maps
// to stoppedBecause 'turns' against a REAL server (genuine bruno-runtime/-tagged public API hits,
// not a faked admin response).
// ---------------------------------------------------------------------------

function makeNoopAdapter() {
  return {
    name: 'noop-hardening',
    build: () => ({ cmd: process.execPath, args: ['-e', 'process.exit(0)'], env: {} }),
    parseUsage: () => ({ tokensIn: 1, tokensOut: 1, modelVersion: 'fake-noop' }),
    resume: () => null,
  };
}

test('cliClimb(): sends X-Admin-Token on its own admin calls (rungs, violations, log)', async () => {
  await withOutDir(async (outDir) => {
    await withAdminSpy(async (seen) => {
      await cliClimb({ cli: makeNoopAdapter(), seed: 10, outDir, pollMs: 20, ...freshPorts() });
      assert.ok(seen.length > 0);
      const tokens = new Set(seen.map((r) => r.headers['x-admin-token']));
      assert.equal(tokens.size, 1, 'every admin call in one climb uses the same token');
      const [token] = [...tokens];
      assert.ok(token && token.length >= 32);
    });
  });
});

test("cliClimb(): adminProbes > 0 voids the run as stoppedBecause 'voided-admin-probe'", async () => {
  await withOutDir(async (outDir) => {
    const result = await withFakeViolations({ count: 1, samples: [{ ua: 'nc', method: 'GET', path: '/admin/log' }], adminProbes: 1 }, () =>
      cliClimb({ cli: makeNoopAdapter(), seed: 11, outDir, pollMs: 20, ...freshPorts() }),
    );
    assert.equal(result.stoppedBecause, 'voided-admin-probe');
    assert.equal(result.adminProbes, 1);
    assert.deepEqual(result.violationSamples, [{ ua: 'nc', method: 'GET', path: '/admin/log' }]);
  });
});

// A fake adapter whose script authenticates several times with the real bru User-Agent, then
// idles -- so genuine bruno-runtime/-tagged public API hits pile up in the REAL admin log, and
// the turn cap (enforced by supervise.js's poll loop) fires against real data, not a stub.
async function makeIdleAuthAdapter(world, scriptDir) {
  const naming = { apiKeyField: fieldName(world, 'api_key') };
  const scriptPath = path.join(scriptDir, 'idle-cli.mjs');
  const source = `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const taskText = readFileSync('TASK.md', 'utf8');
const baseUrl = taskText.match(/Base URL: (\\S+)/)[1];
const apiKey = taskText.match(/API key: (\\S+) --/)[1];
const naming = JSON.parse(process.env.QUAERE_FAKE_NAMING);

async function main() {
  // Real requests carrying the bruno-runtime/ User-Agent, exactly as \`bru\` itself sends -- this
  // is what should trip the harness's turn cap, never anything fake-injected.
  for (let i = 0; i < 6; i += 1) {
    await fetch(baseUrl + '/auth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'bruno-runtime/9.9.9' },
      body: JSON.stringify({ [naming.apiKeyField]: apiKey }),
    });
  }
  console.log(JSON.stringify({ usage: { tokensIn: 1, tokensOut: 1, modelVersion: 'fake-turns' } }));
  // Stay alive so supervise.js's poll can observe the cap and kill this process, rather than
  // racing a natural exit that would report "stalled" instead.
  setInterval(() => {}, 1000);
}
main();
`;
  await writeFile(scriptPath, source, 'utf8');
  return {
    name: 'idle',
    build: () => ({ cmd: process.execPath, args: [scriptPath], env: { QUAERE_FAKE_NAMING: JSON.stringify(naming) } }),
    parseUsage: (stdout) => {
      const lines = stdout.trim().split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (parsed && parsed.usage) return parsed.usage;
        } catch {
          // not a JSON line, keep looking
        }
      }
      return { tokensIn: 0, tokensOut: 0, tokensCached: 0 };
    },
    resume: () => null,
  };
}

test("cliClimb(): the turn cap fires against real bruno-runtime/ admin-log entries and maps to stoppedBecause 'turns'", async () => {
  await withOutDir(async (outDir) => {
    const seed = 12;
    const world = makeWorld(seed);
    const adapter = await makeIdleAuthAdapter(world, outDir);
    const result = await cliClimb({
      cli: adapter,
      seed,
      outDir,
      pollMs: 20,
      maxBruTurns: 3,
      wallMsLimit: 15_000,
      ...freshPorts(),
    });
    assert.equal(result.stoppedBecause, 'turns');
  });
});

// ---------------------------------------------------------------------------
// score.js / board.js: the Probes column and violation-sample rendering
// ---------------------------------------------------------------------------

function fixtureResult(overrides) {
  return {
    model: 'model-a',
    driver: 'anthropic',
    seed: 1,
    attempt: 1,
    rung: 10,
    turns: 20,
    tokensIn: 100,
    tokensOut: 50,
    tokensNovel: 150,
    tokensBilled: 150,
    trims: 0,
    wallMs: 1000,
    fidelity: 1,
    trap: 1,
    violations: 0,
    violationSamples: [],
    adminProbes: 0,
    resumes: 0,
    submissions: [],
    stoppedBecause: 'fail',
    ...overrides,
  };
}

test('scoreRuns: probes averages adminProbes across attempts, defaulting to 0 for legacy result.json', () => {
  const withProbes = fixtureResult({ adminProbes: 4 });
  const legacy = fixtureResult({});
  delete legacy.adminProbes;
  const [row] = scoreRuns([withProbes, legacy]);
  assert.equal(row.probes, 2);
});

test('board.md appends a Probes column after Stop, keeping the existing header/row substrings intact', () => {
  const md = renderBoard([fixtureResult({ model: 'model-a', seed: 7, violations: 1, resumes: 2, adminProbes: 3, stoppedBecause: 'budget' })]);
  // The exact substring other test files assert on (board.test.js, harness-transcript.test.js)
  // must still match: Probes is appended, not inserted in the middle.
  assert.match(md, /\| Model \| Driver \| Seed \| Rung \| Turns \| Fidelity \| Trap \| Novel \| Billed \| Violations \| Resumes \| Stop \|/);
  assert.match(md, /\| Model \| .* \| Stop \| Probes \|/);
  assert.match(md, /\| model-a \| anthropic \| 7 \| 10 \| 20 \| 100\.0% \| 100\.0% \| 150 \| 150 \| 1\.0 \| 2\.0 \| budget \| 3\.0 \|/);
});

test('board.md renders violation samples for a row with violations > 0, with the --sandbox note', () => {
  const md = renderBoard([
    fixtureResult({
      model: 'grok-4.6',
      driver: 'openrouter',
      violations: 2,
      violationSamples: [
        { ua: 'python-requests/2.31', method: 'GET', path: '/workspaces' },
        { ua: null, method: 'POST', path: '/projects' },
      ],
      stoppedBecause: 'fail',
    }),
  ]);
  assert.match(md, /#### Violation samples/);
  assert.match(md, /grok-4\.6/);
  assert.match(md, /GET \/workspaces \(User-Agent: python-requests\/2\.31\)/);
  assert.match(md, /POST \/projects \(User-Agent: unknown\)/);
  assert.match(md, /--sandbox developer scripts/);
});

test('board.md omits the Violation samples section entirely when no row has a violation', () => {
  const md = renderBoard([fixtureResult({ model: 'clean-model', violations: 0 })]);
  assert.doesNotMatch(md, /#### Violation samples/);
});

test('board.md notes "no samples recorded" for a violating row from a result.json that predates violationSamples', () => {
  const legacy = fixtureResult({ model: 'old-model', violations: 1 });
  delete legacy.violationSamples;
  const md = renderBoard([legacy]);
  assert.match(md, /#### Violation samples/);
  assert.match(md, /no samples recorded/);
});
