// Runs one adapter-built process under the Addendum F polling loop.
//
// Spawns it detached (its own process group, so the whole tree it forks -- a CLI product commonly
// forks helper processes -- dies together), polls admin `/submissions` every `pollMs`, and reacts
// to whatever it finds there: a failing submission kills the tree immediately; a passing
// submission at or past `topRung` kills it too (the climb is over, no reason to let it keep
// running); anything short of the top gets `/admin/rungs/advance` and the process is left running
// to keep climbing on its own. A wall-clock deadline also kills the tree. Absent any of that, this
// resolves whenever the process exits on its own -- run-cli.js decides what a clean exit without a
// fall means (resume, or stop).
//
// Wall-clock timing (Date.now(), setInterval, setTimeout) is allowed throughout: this is the
// harness, never anything that feeds an artifact, a spec, a skill, or a rung.

import { spawn } from 'node:child_process';

export const DEFAULT_POLL_MS = 2000;

function iso() {
  return new Date().toISOString();
}

async function adminGetSubmissions(adminBase) {
  const res = await fetch(`${adminBase}/admin/submissions`);
  return res.json();
}

async function adminAdvance(adminBase) {
  const res = await fetch(`${adminBase}/admin/rungs/advance`, { method: 'POST' });
  return res.json();
}

// killTree(child): SIGKILL the whole process group the child leads. `child` must have been
// spawned with `detached: true` for this to reach anything it forked, not just itself -- a
// negative pid targets the group rather than the single process. Falls back to killing just the
// child if the group signal fails (e.g. it already exited, or the platform doesn't support
// negative-pid kill), so this never throws.
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

// superviseProcess({cmd, args, env, cwd, adminBase, topRung, wallMsLeft, pollMs, onEvent}) ->
// Promise<{exitCode, signal, timedOut, killedFor: 'fail'|'top'|'wall'|'error'|null, submissions,
// stdout, stderr}>.
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
  topRung = 99,
  wallMsLeft = Infinity,
  pollMs = DEFAULT_POLL_MS,
  onEvent = () => {},
}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let submissions = [];
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
        body = await adminGetSubmissions(adminBase);
      } catch {
        return; // admin unreachable this tick -- next call (timer or exit) tries again
      }
      if (settled) return;
      const subs = body.data || [];
      if (subs.length <= submissions.length) return;
      const freshOnes = subs.slice(submissions.length);
      submissions = subs;
      for (const s of freshOnes) {
        onEvent({ ts: iso(), type: 'submission', submission: s });
        if (!s.pass) {
          killedFor = 'fail';
          killTree(child);
          return;
        }
        if (s.rung >= topRung) {
          killedFor = 'top';
          killTree(child);
          return;
        }
        // eslint-disable-next-line no-await-in-loop
        await adminAdvance(adminBase).catch(() => {});
        if (settled) return;
      }
    }

    const pollTimer = setInterval(() => {
      checkSubmissionsOnce();
    }, pollMs);
    const wallTimer = Number.isFinite(wallMsLeft)
      ? setTimeout(() => {
          if (settled) return;
          killedFor = 'wall';
          killTree(child);
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
      checkSubmissionsOnce().finally(() => {
        settle({ exitCode: code, signal, timedOut: killedFor === 'wall', killedFor, submissions, stdout, stderr });
      });
    });
  });
}
