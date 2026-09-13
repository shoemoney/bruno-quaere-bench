// Admin-port handlers: mutate, reset, log, the rungs answer key, submissions, and the raw World.
// Bound to 127.0.0.1 by the caller (server.js); nothing here assumes that, it just serves.

import { createRouter } from './router.js';
import { sendProblem } from './problem.js';
import { rng, sub, pick } from '../seed.js';

// The one rule (ARCHITECTURE Addendum F): nothing but `bru` opens a socket, and every genuine
// bru invocation sends this as its User-Agent. `count` is exhaustive over the whole log; `samples`
// is capped so a long, badly-behaved run can't blow up the admin/violations response body.
const BRUNO_RUNTIME_PREFIX = 'bruno-runtime/';
const MAX_VIOLATION_SAMPLES = 20;

// Addendum J, "Admin port hardening": a native CLI has a shell, and the admin port answers on
// the loopback address that same shell can always reach. `adminToken`, when the caller (server.js)
// supplies one, is a per-run random secret held only by the harness process and never written
// into the sandbox -- every admin request must carry it as `X-Admin-Token` or it is a 401,
// counted as an `adminProbe` rather than folded into the User-Agent violations above (a probe
// never got far enough to identify itself as bru or not; it is a distinct signal: something
// inside the sandbox reached for the admin port at all). Passing no `adminToken` (undefined)
// leaves the port exactly as unauthenticated as it always was -- every existing caller that
// starts a server without one keeps working unchanged.
const ADMIN_TOKEN_HEADER = 'x-admin-token';

export const MUTATION_NAMES = [
  'statusCode',
  'dropField',
  'renameField',
  'retypeField',
  'rejectAuth',
  'stuckCursor',
];

// One candidate list per mutation, so "seeded" means "which candidate", never "whether it
// exists" — every mutation is always defined, only whether it's *active* is admin-controlled.
const STATUS_CODE_CANDIDATES = [
  { route: 'assets.get', to: 201 },
  { route: 'jobs.get', to: 201 },
  { route: 'projects.get', to: 201 },
];
const DROP_FIELD_CANDIDATES = [
  { route: 'workspaces.get', field: 'created_at' },
  { route: 'projects.get', field: 'updated_at' },
  { route: 'assets.get', field: 'hash' },
];
// `to` is deliberately a single word (no underscore): it still passes through the generic
// naming pass afterward, and fieldName() is a no-op on underscore-free keys regardless of
// world.naming, so the renamed key lands exactly as written here in every world.
const RENAME_FIELD_CANDIDATES = [
  { route: 'workspaces.get', field: 'name', to: 'title' },
  { route: 'assets.get', field: 'id', to: 'uid' },
];
const RETYPE_FIELD_CANDIDATES = [
  { route: 'projects.get', field: 'status' },
  { route: 'assets.get', field: 'hash' },
];
const REJECT_AUTH_CANDIDATES = ['workspaces.list', 'projects.list', 'projects.assets'];
const STUCK_CURSOR_CANDIDATES = ['workspaces.list', 'projects.list', 'projects.assets'];

// chooseMutationTargets(world): one deterministic target per mutation, picked from world.seed
// so every instance has the same live mutation surface for a given seed, documented here as
// the single source of truth for which (route, field) each mutation name touches.
export function chooseMutationTargets(world) {
  return {
    statusCode: pick(rng(sub(world.seed, 'admin.mutate.statusCode')), STATUS_CODE_CANDIDATES),
    dropField: pick(rng(sub(world.seed, 'admin.mutate.dropField')), DROP_FIELD_CANDIDATES),
    renameField: pick(rng(sub(world.seed, 'admin.mutate.renameField')), RENAME_FIELD_CANDIDATES),
    retypeField: pick(rng(sub(world.seed, 'admin.mutate.retypeField')), RETYPE_FIELD_CANDIDATES),
    rejectAuth: { route: pick(rng(sub(world.seed, 'admin.mutate.rejectAuth')), REJECT_AUTH_CANDIDATES) },
    stuckCursor: { route: pick(rng(sub(world.seed, 'admin.mutate.stuckCursor')), STUCK_CURSOR_CANDIDATES) },
  };
}

// mutationForRung(world, n): Addendum J rule 3, "mid-rung mutations", per the API contract
// documented on `makeRungMutations` in world.js -- `world.rungMutations` is an array indexed BY
// RUNG NUMBER, each slot either `{n, mutation}` or `null`. Defensive only against a world with no
// `rungMutations` at all (every fixture in this repo's own tests that builds a world by hand
// rather than through `makeWorld`), in which case this is a no-op, same as before this addendum.
export function mutationForRung(world, n) {
  const list = world && world.rungMutations;
  if (!Array.isArray(list)) return null;
  const entry = list[n];
  return entry ? entry.mutation : null;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(buf.length) });
  res.end(buf);
}

const ADMIN_ROUTES = [
  { method: 'POST', path: '/admin/mutate', id: 'admin.mutate' },
  { method: 'POST', path: '/admin/reset', id: 'admin.reset' },
  { method: 'GET', path: '/admin/log', id: 'admin.log' },
  { method: 'GET', path: '/admin/violations', id: 'admin.violations' },
  { method: 'POST', path: '/admin/rungs', id: 'admin.rungs.set' },
  { method: 'POST', path: '/admin/rungs/advance', id: 'admin.rungs.advance' },
  { method: 'GET', path: '/admin/submissions', id: 'admin.submissions' },
  { method: 'GET', path: '/admin/world', id: 'admin.world' },
];

// createAdminHandler(state, {reset, adminToken}) -> (req, res) => void, an http.Server request
// listener. `reset()` is supplied by server.js since it also owns the auth store and rate
// limiter that a reset must clear alongside the resource store and mutation flags admin.js owns
// here. `adminToken`, when set, gates every admin route (see ADMIN_TOKEN_HEADER above); a probe
// is logged to `state.adminProbes` and answered 401 before the route is even matched, so an
// unauthenticated caller learns nothing about which admin routes exist.
export function createAdminHandler(state, { reset, adminToken }) {
  const router = createRouter(ADMIN_ROUTES);

  return function handleAdmin(req, res) {
    const url = new URL(req.url, 'http://admin.internal');

    if (adminToken) {
      const provided = req.headers[ADMIN_TOKEN_HEADER];
      if (provided !== adminToken) {
        state.adminProbes.push({ method: req.method, path: url.pathname, ua: req.headers['user-agent'] || '' });
        sendProblem(res, 401, { detail: 'missing or invalid X-Admin-Token' });
        return;
      }
    }

    const match = router(req.method, url.pathname);
    if (!match) {
      sendProblem(res, 404, { detail: `no admin route for ${req.method} ${url.pathname}` });
      return;
    }

    Promise.resolve()
      .then(() => dispatch(match.entry.id, state, { req, res, reset }))
      .catch((err) => {
        sendProblem(res, 400, { detail: err.message });
      });
  };
}

async function dispatch(id, state, { req, res, reset }) {
  if (id === 'admin.mutate') {
    const body = await readJsonBody(req);
    if (!MUTATION_NAMES.includes(body.name)) {
      sendProblem(res, 400, { detail: `unknown mutation: ${body.name}` });
      return;
    }
    state.mutations.active.add(body.name);
    sendJson(res, 200, { name: body.name, active: true, target: state.mutations.targets[body.name] });
    return;
  }

  if (id === 'admin.reset') {
    reset();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (id === 'admin.log') {
    sendJson(res, 200, { data: state.log });
    return;
  }

  if (id === 'admin.violations') {
    const offenders = state.log.filter((entry) => !(entry.ua || '').startsWith(BRUNO_RUNTIME_PREFIX));
    const samples = offenders
      .slice(0, MAX_VIOLATION_SAMPLES)
      .map((entry) => ({ ua: entry.ua, method: entry.method, path: entry.path }));
    // Addendum J: `adminProbes` is a distinct signal from a rogue public-port User-Agent above --
    // a count of requests to the ADMIN port itself that never carried a valid X-Admin-Token. Flat
    // top-level number (the [harness] workstream's run.js/run-cli.js read
    // `violationsBody.adminProbes` directly, defaulting to 0 when it's absent so an instance that
    // predates this addendum still reports cleanly) per "any adminProbe voids the run".
    // `adminProbeSamples` is the same `{method, path, ua}` shape as `samples` above, for an
    // operator diagnosing why a run was voided; the harness contract itself only needs the count.
    sendJson(res, 200, {
      count: offenders.length,
      samples,
      adminProbes: state.adminProbes.length,
      adminProbeSamples: state.adminProbes.slice(0, MAX_VIOLATION_SAMPLES),
    });
    return;
  }

  if (id === 'admin.rungs.set') {
    const body = await readJsonBody(req);
    const rungs = Array.isArray(body.rungs) ? body.rungs : [];
    state.rungs.answers = new Map(rungs.map((r) => [r.n, r]));
    state.rungs.current = 0;
    state.rungs.submissions = [];
    sendJson(res, 200, { ok: true, count: rungs.length });
    return;
  }

  if (id === 'admin.rungs.advance') {
    state.rungs.current += 1;
    const announced = mutationForRung(state.world, state.rungs.current);
    const applied = announced && MUTATION_NAMES.includes(announced) ? announced : null;
    // world.js's own contract for `rungMutations` (see makeRungMutations): the announced
    // mutation REPLACES the active set outright, live from the first request of the new rung --
    // never accumulates, so neither an earlier rung's announced mutation nor a manually-set
    // `POST /admin/mutate` survives past the rung boundary that didn't ask for it.
    state.mutations.active = new Set(applied ? [applied] : []);
    sendJson(res, 200, { current: state.rungs.current, mutationApplied: applied });
    return;
  }

  if (id === 'admin.submissions') {
    sendJson(res, 200, { data: state.rungs.submissions });
    return;
  }

  if (id === 'admin.world') {
    sendJson(res, 200, state.world);
    return;
  }

  sendProblem(res, 404, { detail: `unhandled admin route: ${id}` });
}
