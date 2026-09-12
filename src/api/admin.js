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

// createAdminHandler(state, {reset}) -> (req, res) => void, an http.Server request listener.
// `reset()` is supplied by server.js since it also owns the auth store and rate limiter that a
// reset must clear alongside the resource store and mutation flags admin.js owns here.
export function createAdminHandler(state, { reset }) {
  const router = createRouter(ADMIN_ROUTES);

  return function handleAdmin(req, res) {
    const url = new URL(req.url, 'http://admin.internal');
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
    const samples = offenders.slice(0, MAX_VIOLATION_SAMPLES).map((entry) => ({ ua: entry.ua, path: entry.path }));
    sendJson(res, 200, { count: offenders.length, samples });
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
    sendJson(res, 200, { current: state.rungs.current });
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
