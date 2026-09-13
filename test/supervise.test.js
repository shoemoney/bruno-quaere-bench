// src/harness/supervise.js in isolation, against a tiny fake admin HTTP server rather than the
// real API -- these tests are about the polling/kill/baseline contract, not the ladder itself.
// Addendum G is the brief: a per-run submission baseline (never re-react to an old submission
// after a resume), drain-then-kill (SIGTERM, wait up to drainMs, then SIGKILL), and an overshoot
// backstop (an admin-reported rung past the real ladder's top is a harness error, never a fall).

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { superviseProcess, killTree, gracefulKillTree, DEFAULT_DRAIN_MS } from '../src/harness/supervise.js';

// startFakeAdmin({submissions, advance}) -> Promise<{baseUrl, advanceCalls, close}>.
// `submissions` is either a static array or a () => array (so a test can make the list grow
// mid-run); `advance` is an optional () => body override for POST /admin/rungs/advance (default
// {current: 0}). `advanceCalls` is a live counter the test reads after the fact.
// `submissionsDelayMs`/`advanceDelayMs` (both default 0) make the admin deliberately slow, which
// is how the overlap regression test below forces the poll check and the exit check to interleave
// on demand instead of waiting for a loaded CI machine to do it by chance.
function startFakeAdmin({ submissions = [], advance, submissionsDelayMs = 0, advanceDelayMs = 0 } = {}) {
  const state = { advanceCalls: 0 };
  const submissionsFn = typeof submissions === 'function' ? submissions : () => submissions;
  const after = (ms, fn) => (ms > 0 ? setTimeout(fn, ms) : fn());
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://admin.internal');
    if (req.method === 'GET' && url.pathname === '/admin/submissions') {
      const body = JSON.stringify({ data: submissionsFn() });
      after(submissionsDelayMs, () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/admin/rungs/advance') {
      state.advanceCalls += 1;
      const body = advance ? advance() : { current: 0 };
      after(advanceDelayMs, () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
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
        get advanceCalls() {
          return state.advanceCalls;
        },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// killTree / gracefulKillTree primitives
// ---------------------------------------------------------------------------

test('killTree: a no-op on a process that already exited never throws', async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise((resolve) => child.on('exit', resolve));
  assert.doesNotThrow(() => killTree(child));
});

test('gracefulKillTree: a no-op on a process that already exited never throws and schedules nothing', async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise((resolve) => child.on('exit', resolve));
  assert.doesNotThrow(() => gracefulKillTree(child, { drainMs: 50 }));
});

// ---------------------------------------------------------------------------
// Addendum G #1: "Supervisor baseline is per run, not per spawn."
// ---------------------------------------------------------------------------

test('superviseProcess: baseline-across-resumes -- 60 prior submissions, one resume that submits nothing new, current stays 60', async () => {
  // Stands in for a resume: the server already carries 60 clean submissions from earlier spawns
  // in this same run (the list never grows during this call -- the process below submits
  // nothing), and this spawn is told about that baseline up front. Before the Addendum G fix,
  // superviseProcess started its "already reacted to" count at 0 on every call, so it would have
  // treated all 60 as brand new and called /admin/rungs/advance once per old submission.
  const priorSubmissions = Array.from({ length: 60 }, (_, i) => ({ rung: i, pass: true, fidelity: 1 }));
  const admin = await startFakeAdmin({ submissions: priorSubmissions });
  try {
    const outcome = await superviseProcess({
      cmd: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env: process.env,
      adminBase: admin.baseUrl,
      topRung: 99,
      wallMsLeft: 5000,
      pollMs: 40,
      knownSubmissionsCount: 60,
    });
    assert.equal(outcome.killedFor, null, 'nothing new happened -- no fail, no top, no overshoot');
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.submissions.length, 60, 'the full server-side list is still returned in full');
    assert.equal(admin.advanceCalls, 0, 'current stays 60: not one of the 60 prior submissions gets re-advanced for');
  } finally {
    await admin.close();
  }
});

test('superviseProcess: with no baseline, the same 60 submissions ARE all reacted to (the bug this guards against)', async () => {
  // The other side of the same fixture: knownSubmissionsCount defaults to 0, so every one of the
  // 60 is "new" to this call and gets advanced for -- demonstrating the baseline param is what
  // makes the difference above, not some other change in behavior.
  const priorSubmissions = Array.from({ length: 60 }, (_, i) => ({ rung: i, pass: true, fidelity: 1 }));
  const admin = await startFakeAdmin({ submissions: priorSubmissions });
  try {
    const outcome = await superviseProcess({
      cmd: process.execPath,
      args: ['-e', 'process.exit(0)'],
      env: process.env,
      adminBase: admin.baseUrl,
      topRung: 99,
      wallMsLeft: 5000,
      pollMs: 40,
      // knownSubmissionsCount omitted -- defaults to 0
    });
    assert.equal(outcome.killedFor, null);
    assert.equal(admin.advanceCalls, 60, 'every old submission was (wrongly, without a baseline) advanced for');
  } finally {
    await admin.close();
  }
});

// ---------------------------------------------------------------------------
// Addendum G #1, third face: a check must never be settled out from under itself.
// ---------------------------------------------------------------------------

test('superviseProcess: a fall in the tail of an in-flight check is still caught when the process exits mid-check', async () => {
  // The regression this guards: the poll timer's check and the exit handler's check used to be
  // able to run CONCURRENTLY. The timer's check would consume the whole submissions list and start
  // advancing through it one await at a time; the exit handler's check would then find nothing new
  // (already consumed), settle the promise immediately, and the `if (settled) return` guard inside
  // the timer's still-running loop would abandon every submission it had not yet reached. A fall
  // sitting in that abandoned tail was never seen -- killedFor stayed null, and run-cli.js reads a
  // null killedFor on a clean exit as "resume", so a run that had actually FALLEN kept climbing.
  //
  // Measured against the pre-fix code with exactly these delays: 15 of 60 submissions reacted to,
  // and the fail at rung 50 missed entirely (killedFor: null).
  const submissions = Array.from({ length: 60 }, (_, i) => ({ rung: i, pass: i !== 50, fidelity: 1 }));
  const admin = await startFakeAdmin({ submissions, submissionsDelayMs: 60, advanceDelayMs: 5 });
  try {
    const outcome = await superviseProcess({
      cmd: process.execPath,
      // Exits while a poll check is still in flight -- the whole point of the fixture.
      args: ['-e', 'setTimeout(() => process.exit(0), 120)'],
      env: process.env,
      adminBase: admin.baseUrl,
      topRung: 99,
      wallMsLeft: 10_000,
      pollMs: 50,
    });
    assert.equal(outcome.killedFor, 'fail', 'the fall at rung 50 must be caught, not abandoned with the tail');
    assert.equal(admin.advanceCalls, 50, 'rungs 0-49 advanced, then the loop stops at the fall -- no truncation');
  } finally {
    await admin.close();
  }
});

// ---------------------------------------------------------------------------
// Addendum G #2: "Drain usage before the kill."
// ---------------------------------------------------------------------------

test('superviseProcess: a fall SIGTERMs first and drains -- the process gets to print its result before exiting', async () => {
  // The fall is withheld until the child says it is ready. Without that gate this test is a race
  // against node's own startup: the poll fires at 40ms, and on a loaded machine `node -e` has not
  // yet executed the script by then, so SIGTERM arrives BEFORE the handler below is installed, the
  // default action kills the child outright, and the drain being tested never happens. Readiness
  // goes to stderr so stdout stays purely the result JSON the assertions parse.
  let childReady = false;
  const admin = await startFakeAdmin({
    submissions: () => (childReady ? [{ rung: 0, pass: false, fidelity: 0.4 }] : []),
  });
  // Traps SIGTERM, waits briefly (simulating a CLI wrapping up and printing its
  // --output-format json result), THEN exits cleanly -- if supervise.js still sent a bare SIGKILL
  // the moment the fail showed up, this process would die mid-timer and never print anything.
  const drainScript = `
    process.on('SIGTERM', () => {
      setTimeout(() => {
        console.log(JSON.stringify({ drained: true, usage: { tokensIn: 42, tokensOut: 7 } }));
        process.exit(0);
      }, 150);
    });
    setInterval(() => {}, 1000);
    console.error('READY');
  `;
  const startedAt = Date.now();
  try {
    const outcome = await superviseProcess({
      cmd: process.execPath,
      args: ['-e', drainScript],
      env: process.env,
      adminBase: admin.baseUrl,
      topRung: 99,
      wallMsLeft: 10_000,
      pollMs: 40,
      onEvent: (e) => {
        if (e.type === 'stderr' && e.text.includes('READY')) childReady = true;
      },
      // Default drainMs (20s) is what production uses; asserting elapsed time stays well under it
      // shows the process exiting on its own during the drain, not the drain window itself, is
      // what ended this call.
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(outcome.killedFor, 'fail');
    assert.equal(outcome.exitCode, 0, 'the process exited on its own during the drain window, never SIGKILLed');
    assert.notEqual(outcome.signal, 'SIGKILL');
    assert.match(outcome.stdout, /"drained":true/, 'the drained stdout must be captured, not lost to an immediate kill');
    const parsed = JSON.parse(outcome.stdout.trim());
    assert.deepEqual(parsed.usage, { tokensIn: 42, tokensOut: 7 }, 'a caller can parseUsage() this exactly as a clean exit');
    assert.ok(
      elapsedMs < DEFAULT_DRAIN_MS,
      `drain finished in ${elapsedMs}ms, well under the ${DEFAULT_DRAIN_MS}ms SIGKILL fallback`,
    );
  } finally {
    await admin.close();
  }
});

test('superviseProcess: a fall against a process that ignores SIGTERM is SIGKILLed once drainMs elapses', async () => {
  // Same readiness gate as the drain test above: if SIGTERM lands before this child has installed
  // its swallowing handler, the child dies of SIGTERM and never reaches the SIGKILL being asserted.
  let childReady = false;
  const admin = await startFakeAdmin({
    submissions: () => (childReady ? [{ rung: 0, pass: false, fidelity: 0 }] : []),
  });
  const stubbornScript = `
    process.on('SIGTERM', () => {}); // swallow it -- never exits on its own
    setInterval(() => {}, 1000);
    console.error('READY');
  `;
  try {
    const outcome = await superviseProcess({
      cmd: process.execPath,
      args: ['-e', stubbornScript],
      env: process.env,
      adminBase: admin.baseUrl,
      topRung: 99,
      wallMsLeft: 10_000,
      pollMs: 40,
      drainMs: 200, // short, just for the test -- production default is 20s
      onEvent: (e) => {
        if (e.type === 'stderr' && e.text.includes('READY')) childReady = true;
      },
    });
    assert.equal(outcome.killedFor, 'fail');
    assert.equal(outcome.signal, 'SIGKILL', 'ignoring SIGTERM for longer than drainMs falls back to SIGKILL');
  } finally {
    await admin.close();
  }
});

// ---------------------------------------------------------------------------
// Addendum G #3: "assert current <= 99 ... a harness error, never a fall."
// ---------------------------------------------------------------------------

test('superviseProcess: an admin-reported rung past the real ladder top is an overshoot, not a fall or a top', async () => {
  const admin = await startFakeAdmin({
    submissions: [{ rung: 5, pass: true, fidelity: 1 }],
    advance: () => ({ current: 500 }), // impossible for a real 0-99 ladder -- a harness bug
  });
  try {
    const outcome = await superviseProcess({
      cmd: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      env: process.env,
      adminBase: admin.baseUrl,
      topRung: 99, // rung 5 < 99, so this goes down the advance() path, not the 'top' path
      wallMsLeft: 10_000,
      pollMs: 40,
      drainMs: 300,
    });
    assert.equal(outcome.killedFor, 'overshoot');
    assert.notEqual(outcome.killedFor, 'fail');
    assert.notEqual(outcome.killedFor, 'top');
  } finally {
    await admin.close();
  }
});

// ---------------------------------------------------------------------------
// pre-existing behavior, unchanged by Addendum G
// ---------------------------------------------------------------------------

test('superviseProcess: a wall-clock deadline kills the tree and reports killedFor "wall"', async () => {
  const outcome = await superviseProcess({
    cmd: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 60000)'],
    env: process.env,
    adminBase: 'http://127.0.0.1:1', // never reached: nothing to submit in this test
    wallMsLeft: 100,
    pollMs: 5000,
  });
  assert.equal(outcome.killedFor, 'wall');
  assert.equal(outcome.timedOut, true);
});

test('superviseProcess: a process that just exits on its own resolves with killedFor null', async () => {
  const outcome = await superviseProcess({
    cmd: process.execPath,
    args: ['-e', 'console.log("hi"); process.exit(3)'],
    env: process.env,
    adminBase: 'http://127.0.0.1:1',
    wallMsLeft: 5000,
    pollMs: 5000,
  });
  assert.equal(outcome.killedFor, null);
  assert.equal(outcome.exitCode, 3);
  assert.match(outcome.stdout, /hi/);
});
