// Runs one adapter-built process under the Addendum F polling loop.
//
// Spawns it detached (its own process group, so the whole tree it forks -- a CLI product commonly
// forks helper processes -- dies together), polls admin `/submissions` every `pollMs`, and reacts
// to whatever it finds there: a failing submission drains then kills the tree; a passing
// submission at or past `topRung` drains then kills it too (the climb is over, no reason to let it
// keep running); anything short of the top gets `/admin/rungs/advance` and the process is left
// running to keep climbing on its own. A wall-clock deadline also drains then kills the tree.
// Absent any of that, this resolves whenever the process exits on its own -- run-cli.js decides
// what a clean exit without a fall means (resume, or stop).
//
// Wall-clock timing (Date.now(), setInterval, setTimeout) is allowed throughout: this is the
// harness, never anything that feeds an artifact, a spec, a skill, or a rung.
//
// --- Addendum G: two bugs fixed here after native round two ------------------------------------
//
// 1. "Supervisor baseline is per run, not per spawn." Each resume used to start a fresh
//    superviseProcess() call whose local "how many submissions have I already reacted to" counter
//    began at zero, even though the SERVER's /admin/submissions list is cumulative across the
//    whole run. The very first poll after a resume would then see every submission from every
//    earlier spawn as "new" and advance the rung once per old submission -- 60 clean submissions
//    became rung 240. Fix: the caller passes `knownSubmissionsCount`, the number of submissions it
//    already knows about (accumulated across prior spawns in this run); only submissions past that
//    count are treated as new, advanced for, or checked for fail/top. The returned `submissions`
//    array is still the full, authoritative list straight from the server either way.
// 2. "Drain usage before the kill." Killing the CLI the instant a fall/top/wall appears loses its
//    usage output -- most CLIs only print their `--output-format json` result once the process is
//    about to exit cleanly, and a bare SIGKILL never gives them the chance. Fix: `killedFor` cases
//    now SIGTERM first, wait up to `drainMs` (default 20s) for the process to exit on its own, and
//    only SIGKILL if it hasn't. run-cli.js's parseUsage() call afterward sees whatever the process
//    managed to print during that window instead of an empty/truncated stream.
// 3. "Assert current <= 99 ... treat any overshoot as a harness error, never a fall." A defensive
//    backstop for the same class of bug as (1): if `/admin/rungs/advance` ever reports a rung past
//    the real ladder's top (99), that is this harness double-advancing, not the agent falling off
//    anything -- `killedFor` becomes 'overshoot' rather than silently continuing to advance.

import { spawn } from 'node:child_process';

export const DEFAULT_POLL_MS = 2000;
// Addendum G: "SIGTERM ... wait up to 20 s ... then SIGKILL."
export const DEFAULT_DRAIN_MS = 20_000;
// The ladder is always rungs 0-99 (ARCHITECTURE.md); this is independent of a caller's `topRung`,
// which a test may shorten to end a climb early without touching what counts as an impossible
// admin-reported rung.
const REAL_LADDER_MAX_RUNG = 99;

// Addendum J: "Turn cap. 5000 bru requests per run, reported as stoppedBecause: 'turns'."
export const DEFAULT_MAX_BRU_TURNS = 5000;

function iso() {
  return new Date().toISOString();
}

// Addendum J admin-port hardening: `adminToken` is optional here (undefined is a harmless header
// value against a server that doesn't check it yet) purely so supervise.test.js's existing fake
// admin server -- which predates this and never asserted on the header -- keeps working unchanged.
// A real climb via run-cli.js always supplies the per-run token.
function adminHeaders(adminToken) {
  return adminToken ? { 'x-admin-token': adminToken } : {};
}

async function adminGetSubmissions(adminBase, adminToken) {
  const res = await fetch(`${adminBase}/admin/submissions`, { headers: adminHeaders(adminToken) });
  return res.json();
}

async function adminAdvance(adminBase, adminToken) {
  const res = await fetch(`${adminBase}/admin/rungs/advance`, { method: 'POST', headers: adminHeaders(adminToken) });
  return res.json();
}

// Addendum J: the same admin-log query run-cli.js uses at the very end to compute the real
// `turns` field (Addendum G: "Turns are counted at the API, not by the shim"), polled here too so
// a runaway climb is stopped mid-flight at the cap instead of only being labeled after the fact.
async function adminGetLog(adminBase, adminToken) {
  const res = await fetch(`${adminBase}/admin/log`, { headers: adminHeaders(adminToken) });
  return res.json();
}

function countBruRequests(logBody) {
  const entries = Array.isArray(logBody && logBody.data) ? logBody.data : [];
  return entries.filter((e) => typeof e.ua === 'string' && e.ua.startsWith('bruno-runtime/')).length;
}

// killTree(child): send `signal` to the whole process group the child leads. `child` must have
// been spawned with `detached: true` for this to reach anything it forked, not just itself -- a
// negative pid targets the group rather than the single process. Falls back to signaling just the
// child if the group signal fails (e.g. it already exited, or the platform doesn't support
// negative-pid kill), so this never throws. A no-op once the child has already exited, by any
// means, so calling it again (e.g. the drain timer's eventual SIGKILL after a natural exit) is safe.
export function killTree(child, signal = 'SIGKILL') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

// gracefulKillTree(child, {drainMs}): Addendum G's drain-before-kill. SIGTERM now, SIGKILL after
// `drainMs` ONLY if the child (or its process group) hasn't exited by then -- most CLIs treat
// SIGTERM as "wrap up and print your result", which is exactly the window this exists to give
// them. `child.once('exit', ...)` clears the pending SIGKILL timer the moment the process is
// actually gone, whether that's from the SIGTERM itself, a signal it forwarded to children, or
// anything else -- so a process that drains quickly doesn't hold this open for the full window.
export function gracefulKillTree(child, { drainMs = DEFAULT_DRAIN_MS } = {}) {
  killTree(child, 'SIGTERM');
  if (child.exitCode !== null || child.signalCode !== null) return;
  const timer = setTimeout(() => {
    killTree(child, 'SIGKILL');
  }, drainMs);
  child.once('exit', () => clearTimeout(timer));
}

// superviseProcess({cmd, args, env, cwd, adminBase, adminToken, topRung, wallMsLeft, pollMs,
// drainMs, knownSubmissionsCount, maxBruTurns, onEvent}) -> Promise<{exitCode, signal, timedOut,
// killedFor: 'fail'|'top'|'wall'|'turns'|'overshoot'|'error'|null, submissions, stdout, stderr}>.
//
// `knownSubmissionsCount` (default 0): how many submissions this RUN already had before this
// spawn (i.e. from earlier spawns/resumes) -- Addendum G. Only submissions past this count are
// reacted to (advanced past, or checked for fail/top); the returned `submissions` is always the
// full, current list from the server regardless.
//
// `adminToken`: Addendum J -- forwarded as X-Admin-Token on every admin fetch this function makes
// (optional; a fake admin server that doesn't check it, like supervise.test.js's, is unaffected).
//
// `maxBruTurns` (default 5000, Addendum J): once the admin log shows this many `bru`-tagged
// requests, the process is drained and killed with `killedFor: 'turns'`, same drain-then-kill
// treatment as a fall or the top.
//
// `onEvent(entry)` fires synchronously, once per stdout chunk (`{ts, type:'stdout', text}`), per
// stderr chunk (`{ts, type:'stderr', text}`), and per newly observed submission (`{ts,
// type:'submission', submission}`) -- run-cli.js builds transcript.jsonl straight from these
// rather than reconstructing timing after the fact.
export function superviseProcess({
  cmd,
  args = [],
  env,
  cwd,
  adminBase,
  adminToken,
  topRung = 99,
  wallMsLeft = Infinity,
  pollMs = DEFAULT_POLL_MS,
  drainMs = DEFAULT_DRAIN_MS,
  knownSubmissionsCount = 0,
  maxBruTurns = DEFAULT_MAX_BRU_TURNS,
  onEvent = () => {},
}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    // The full, authoritative submissions list as last seen from the server -- always assigned in
    // full on every successful poll, independent of how many of them this call has "consumed"
    // (reacted to). This is what gets returned; a fresh run has this at [] until the first poll.
    let submissions = [];
    // How many of the server's submissions this RUN has already reacted to -- Addendum G's
    // baseline. Starts at the caller's count instead of 0 so a resume never re-advances for, or
    // re-fails on, submissions from an earlier spawn.
    let consumedCount = knownSubmissionsCount;
    let killedFor = null;
    let settled = false;
    let child;

    try {
      // detached: true makes `child` the leader of a new process group (its pid doubles as the
      // group's pgid), which is what makes killTree's `-child.pid` reach the whole tree.
      child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      onEvent({ ts: iso(), type: 'stdout', text });
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      onEvent({ ts: iso(), type: 'stderr', text });
    });

    // checkSubmissionsOnce(): one admin fetch, reacting to whatever is new since last time. Called
    // both on the pollMs timer and once more, awaited, right as the process exits -- a process can
    // finish and exit faster than pollMs (routine for a fake/scripted adapter in a test; a real
    // CLI's lifetime dwarfs pollMs so this second call rarely finds anything new in production),
    // and without this last look a submission that landed in the instant before exit would read as
    // "the process vanished with nothing to show," which is a stall, not what actually happened.
    async function checkSubmissionsOnce() {
      if (settled) return;
      let body;
      try {
        body = await adminGetSubmissions(adminBase, adminToken);
      } catch {
        return; // admin unreachable this tick -- next call (timer or exit) tries again
      }
      if (settled) return;
      const subs = body.data || [];
      // Always the full truth from the server, whether or not anything is "new" to react to --
      // this is what the caller gets back, and a resumed run needs it accurate from the very first
      // poll even if there is nothing fresh for THIS call to act on.
      submissions = subs;
      if (subs.length <= consumedCount) return;
      const freshOnes = subs.slice(consumedCount);
      consumedCount = subs.length;
      for (const s of freshOnes) {
        onEvent({ ts: iso(), type: 'submission', submission: s });
        if (!s.pass) {
          killedFor = 'fail';
          gracefulKillTree(child, { drainMs });
          return;
        }
        if (s.rung >= topRung) {
          killedFor = 'top';
          gracefulKillTree(child, { drainMs });
          return;
        }
        // eslint-disable-next-line no-await-in-loop
        const advanced = await adminAdvance(adminBase, adminToken).catch(() => null);
        if (settled) return;
        // Addendum G: a harness bug over-advancing (see the baseline fix above; this is the
        // backstop for whatever the next version of that bug looks like) is not a fall.
        if (advanced && typeof advanced.current === 'number' && advanced.current > REAL_LADDER_MAX_RUNG) {
          killedFor = 'overshoot';
          onEvent({
            ts: iso(),
            type: 'error',
            text: `admin rung advanced past ${REAL_LADDER_MAX_RUNG} (current=${advanced.current}) -- harness bug, not a fall`,
          });
          gracefulKillTree(child, { drainMs });
          return;
        }
      }
    }

    // Addendum J turn cap: polled at the same cadence as submissions, but independent of them --
    // a climb can burn through 5000 bru requests without ever submitting. Skipped once some other
    // reason has already decided to kill the process, so a fall/top/overshoot found in the same
    // tick is never overwritten by the turn cap.
    async function checkTurnCapOnce() {
      if (settled || killedFor) return;
      let body;
      try {
        body = await adminGetLog(adminBase, adminToken);
      } catch {
        return; // admin unreachable this tick -- next call (timer or exit) tries again
      }
      if (settled || killedFor) return;
      if (countBruRequests(body) >= maxBruTurns) {
        killedFor = 'turns';
        onEvent({ ts: iso(), type: 'error', text: `bru request count reached the ${maxBruTurns} turn cap` });
        gracefulKillTree(child, { drainMs });
      }
    }

    // Addendum G, third face of the same bug: admin checks must be SERIALIZED and must all run to
    // completion. The poll timer and the exit handler both call checkSubmissionsOnce(), and they
    // used to be able to overlap. When they did, the exit handler's own check (which finds nothing
    // new, because the timer's in-flight check already consumed the list) would settle() the
    // promise while the timer's check was still mid-loop advancing -- and the `if (settled) return`
    // guard inside that loop then abandoned every submission it had not yet reached. A FALL sitting
    // in that abandoned tail was never seen, so `killedFor` stayed null and run-cli.js read a fall
    // as a clean exit and resumed the run. Measured on a slow admin: 15 of 60 submissions reacted
    // to, and a fail at rung 50 missed entirely.
    //
    // Every check now goes through this one chain, so a check always runs to completion before the
    // next one starts, and the exit handler settles only after the whole chain has drained.
    let pendingChecks = 0;
    let checkChain = Promise.resolve();
    function queueCheck(fn) {
      pendingChecks += 1;
      checkChain = checkChain
        .catch(() => {})
        .then(fn)
        .catch(() => {})
        .finally(() => {
          pendingChecks -= 1;
        });
      return checkChain;
    }

    const pollTimer = setInterval(() => {
      // A slow admin must not let identical polls stack up unboundedly -- if a check is still
      // queued or running, this tick has nothing to add.
      if (pendingChecks > 0) return;
      queueCheck(() => checkSubmissionsOnce().then(() => checkTurnCapOnce()));
    }, pollMs);
    const wallTimer = Number.isFinite(wallMsLeft)
      ? setTimeout(() => {
          if (settled) return;
          killedFor = 'wall';
          gracefulKillTree(child, { drainMs });
        }, Math.max(0, wallMsLeft))
      : null;

    function settle(result) {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      if (wallTimer) clearTimeout(wallTimer);
      resolve(result);
    }

    child.on('error', (err) => {
      if (settled) return;
      onEvent({ ts: iso(), type: 'error', text: err.message });
      settle({ exitCode: null, signal: null, timedOut: false, killedFor: 'error', submissions, stdout, stderr });
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      // Queued, not called directly: this waits out any in-flight poll check (see queueCheck) and
      // only then takes its own last look, so nothing is settled out from under a check that is
      // still reacting to submissions.
      queueCheck(() => checkSubmissionsOnce()).finally(() => {
        settle({ exitCode: code, signal, timedOut: killedFor === 'wall', killedFor, submissions, stdout, stderr });
      });
    });
  });
}
