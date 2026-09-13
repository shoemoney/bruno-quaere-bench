// createServer({world, publicPort, adminPort}) -> {start, stop, log}. Two node:http servers,
// one process, wired to the world via resolvePath/fieldName and every behavior in behaviors.js.

import http from 'node:http';

import { resolvePath, fieldName } from '../world.js';
import { routes } from '../routes.js';
import { create, convert, combine, diff, applyLora, fidelity, MediaValidationError } from '../media.js';

import { createRouter } from './router.js';
import { sendProblem } from './problem.js';
import {
  renameFields,
  readField,
  createIdempotencyStore,
  idempotencyKey,
  createRateLimiter,
  paginate,
  verifyHmac,
  toCsv,
  wantsCsv,
  STUCK_CURSOR_TOKEN,
} from './behaviors.js';
import { createAuthStore, issueToken, refreshToken, verifyBearer } from './auth.js';
import {
  createResourceStore,
  seedInitialData,
  nextId,
  buildAsset,
  renderAssetBytes,
  contentTypeFor,
  listWorkspaces,
  listProjects,
  listAssetsForProject,
} from './resources.js';
import { createAdminHandler, chooseMutationTargets } from './admin.js';

// Routes that work before a bearer token exists, or that never touch protected state.
const NO_AUTH_ROUTES = new Set(['auth.token', 'auth.refresh', 'pictures.legacy']);

function iso(ms) {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

function createState(world) {
  const now = Date.now();
  const state = {
    world,
    log: [],
    authStore: createAuthStore(),
    rateLimiter: createRateLimiter(world),
    idempotency: createIdempotencyStore(),
    store: createResourceStore(),
    rungs: { current: 0, answers: new Map(), submissions: [] },
    mutations: { active: new Set(), targets: chooseMutationTargets(world) },
    routePaths: new Map(routes.map((r) => [r.id, resolvePath(world, r.path)])),
    // Addendum J: unauthenticated-or-wrong-token hits on the admin port (see admin.js). Kept
    // uncapped for an exhaustive count, same as `log` above; GET /admin/violations caps the
    // sample list it returns.
    adminProbes: [],
  };
  seedInitialData(world, state.store, now);
  return state;
}

function resetState(state) {
  state.log.length = 0;
  state.mutations.active.clear();
  state.authStore = createAuthStore();
  state.rateLimiter = createRateLimiter(state.world);
  state.idempotency.clear();
  state.store = createResourceStore();
  seedInitialData(state.world, state.store, Date.now());
  state.rungs = { current: 0, answers: new Map(), submissions: [] };
  state.adminProbes.length = 0;
}

function buildPublicRouter(world) {
  const entries = routes.map((route) => ({
    method: route.method,
    path: resolvePath(world, route.path),
    id: route.id,
  }));
  return createRouter(entries);
}

// ---------------------------------------------------------------------------
// small shared helpers
// ---------------------------------------------------------------------------

// A replay replays the ORIGINAL response, status included. Returning 200 where the first call
// returned 201 would be a status code the spec never declares for these operations, and status
// lies belong to the trap catalog alone (`deleteStatus`), never to a behavior.
function withIdempotency(state, routeId, tokenId, idemKeyHeader, buildResult) {
  if (!idemKeyHeader) return buildResult();
  const key = idempotencyKey(tokenId, routeId, idemKeyHeader);
  const cached = state.idempotency.get(key);
  if (cached) return { status: cached.status, body: cached.body };
  const fresh = buildResult();
  state.idempotency.set(key, { status: fresh.status, body: fresh.body });
  return fresh;
}

function assetDetail(asset) {
  return { id: asset.id, descriptor: asset.descriptor, hash: asset.hash, etag: asset.etag };
}

function assetSummary(asset) {
  return {
    id: asset.id,
    kind: asset.descriptor.kind,
    hash: asset.hash,
    etag: asset.etag,
    display_name: asset.displayName,
    created_at: iso(asset.createdAt),
    updated_at: iso(asset.updatedAt),
  };
}

function findProject(store, workspaceId, projectId) {
  const project = store.projects.get(projectId);
  if (!project || project.workspaceId !== workspaceId) return null;
  return project;
}

function paginationQuery(world, url) {
  const cursor = url.searchParams.get('cursor') || undefined;
  const rawPageSize = url.searchParams.get('page_size');
  const parsed = rawPageSize ? parseInt(rawPageSize, 10) : NaN;
  const pageSize = Number.isFinite(parsed) && parsed > 0 ? parsed : world.pagination.pageSize;
  return { cursor, pageSize, cursorStyle: world.pagination.cursorStyle };
}

// applies the field-level admin mutations (dropField/renameField/retypeField), then the world's
// naming convention, then the statusCode and stuckCursor mutations that don't touch field shape.
function finalizeJsonResponse(state, routeId, status, rawBody) {
  const { active, targets } = state.mutations;
  let body = rawBody;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    if (active.has('dropField') && targets.dropField.route === routeId && targets.dropField.field in body) {
      body = { ...body };
      delete body[targets.dropField.field];
    }
    if (active.has('renameField') && targets.renameField.route === routeId && targets.renameField.field in body) {
      body = { ...body };
      body[targets.renameField.to] = body[targets.renameField.field];
      delete body[targets.renameField.field];
    }
    if (active.has('retypeField') && targets.retypeField.route === routeId && targets.retypeField.field in body) {
      // Wrap in an array: observably a different type regardless of the field's original type
      // (string, number, ...), unlike String(x), which is a no-op on a field already a string.
      body = { ...body, [targets.retypeField.field]: [body[targets.retypeField.field]] };
    }
  }
  const renamed = renameFields(state.world, body);
  if (active.has('stuckCursor') && targets.stuckCursor.route === routeId && renamed && renamed.cursor !== undefined) {
    renamed.cursor = STUCK_CURSOR_TOKEN;
  }
  let finalStatus = status;
  if (active.has('statusCode') && targets.statusCode.route === routeId) {
    finalStatus = targets.statusCode.to;
  }
  return { status: finalStatus, body: renamed };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// route handlers
// ---------------------------------------------------------------------------

async function routeHandlers(routeId, ctx) {
  const { state, req, res, url, params, now, tokenId, json, finalizeAndSend } = ctx;
  const world = state.world;

  if (routeId === 'auth.token') {
    const body = json();
    if (readField(world, body, 'api_key') !== world.auth.apiKey) {
      sendProblem(res, 401, { detail: 'invalid api key' });
      return;
    }
    const rec = issueToken(world, state.authStore, now);
    finalizeAndSend(200, {
      access_token: rec.accessToken,
      token_type: 'bearer',
      expires_in: rec.expiresIn,
      refresh_token: rec.refreshToken,
    });
    return;
  }

  if (routeId === 'auth.refresh') {
    const body = json();
    const rec = refreshToken(world, state.authStore, readField(world, body, 'refresh_token'), now);
    if (!rec) {
      sendProblem(res, 401, { detail: 'invalid refresh token' });
      return;
    }
    finalizeAndSend(200, {
      access_token: rec.accessToken,
      token_type: 'bearer',
      expires_in: rec.expiresIn,
      refresh_token: rec.refreshToken,
    });
    return;
  }

  if (routeId === 'workspaces.list') {
    const items = listWorkspaces(state.store).map((w) => ({
      id: w.id,
      name: w.name,
      created_at: iso(w.createdAt),
    }));
    finalizeAndSend(200, paginate(items, paginationQuery(world, url)));
    return;
  }

  if (routeId === 'workspaces.get') {
    const ws = state.store.workspaces.get(params.workspace_id);
    if (!ws) {
      sendProblem(res, 404, { detail: 'workspace not found' });
      return;
    }
    finalizeAndSend(200, {
      id: ws.id,
      name: ws.name,
      created_at: iso(ws.createdAt),
      links: { loras: state.routePaths.get('loras.list') },
    });
    return;
  }

  if (routeId === 'projects.list') {
    const ws = state.store.workspaces.get(params.workspace_id);
    if (!ws) {
      sendProblem(res, 404, { detail: 'workspace not found' });
      return;
    }
    const items = listProjects(state.store, ws.id).map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      created_at: iso(p.createdAt),
    }));
    finalizeAndSend(200, paginate(items, paginationQuery(world, url)));
    return;
  }

  if (routeId === 'projects.create') {
    const ws = state.store.workspaces.get(params.workspace_id);
    if (!ws) {
      sendProblem(res, 404, { detail: 'workspace not found' });
      return;
    }
    const idemKey = req.headers['idempotency-key'];
    const result = withIdempotency(state, routeId, tokenId, idemKey, () => {
      const body = json();
      const name = readField(world, body, 'name');
      if (!name) throw new MediaValidationError([{ field: 'name', message: 'name is required' }]);
      const id = nextId(world, state.store, 'project');
      const project = { id, workspaceId: ws.id, name, status: 'draft', createdAt: now, updatedAt: now };
      state.store.projects.set(id, project);
      return { status: 201, body: { id, name: project.name, status: project.status, created_at: iso(now) } };
    });
    finalizeAndSend(result.status, result.body);
    return;
  }

  if (routeId === 'projects.get') {
    const project = findProject(state.store, params.workspace_id, params.project_id);
    if (!project) {
      sendProblem(res, 404, { detail: 'project not found' });
      return;
    }
    finalizeAndSend(200, { id: project.id, status: project.status, updated_at: iso(project.updatedAt) });
    return;
  }

  if (routeId === 'projects.compose') {
    const project = findProject(state.store, params.workspace_id, params.project_id);
    if (!project) {
      sendProblem(res, 404, { detail: 'project not found' });
      return;
    }
    if (project.status !== 'draft') {
      sendProblem(res, 409, { detail: `cannot compose a project in status ${project.status}` });
      return;
    }
    const body = json();
    const assetIds = readField(world, body, 'asset_ids') || [];
    // Validate like every other route that takes asset ids (combine, diff, lora): an unknown id
    // is a 422, never a silent no-op.
    const missing = assetIds.filter((id) => {
      const a = state.store.assets.get(id);
      return !a || a.deleted;
    });
    if (missing.length > 0) {
      sendProblem(res, 422, {
        errors: missing.map((id) => ({ field: 'asset_ids', message: `asset not found: ${id}` })),
      });
      return;
    }
    // Composing is what puts a free-standing asset into a project, so it is what makes the
    // asset visible from GET .../{assets}. Without this, asset_ids has no observable effect
    // anywhere in the API and the field could never be got wrong.
    for (const id of assetIds) {
      const asset = state.store.assets.get(id);
      if (asset.projectId === null) asset.projectId = project.id;
    }
    project.assetIds = assetIds;
    project.status = 'composed';
    project.updatedAt = now;
    finalizeAndSend(200, { id: project.id, status: project.status });
    return;
  }

  if (routeId === 'projects.render') {
    const project = findProject(state.store, params.workspace_id, params.project_id);
    if (!project) {
      sendProblem(res, 404, { detail: 'project not found' });
      return;
    }
    if (project.status !== 'composed') {
      sendProblem(res, 409, { detail: `cannot render a project in status ${project.status}` });
      return;
    }
    project.status = 'rendered';
    project.updatedAt = now;
    const jobId = nextId(world, state.store, 'job');
    state.store.jobs.set(jobId, { id: jobId, projectId: project.id, pollCount: 0 });
    const location = state.routePaths.get('jobs.get').replace('{job_id}', encodeURIComponent(jobId));
    finalizeAndSend(202, { job_id: jobId }, { location });
    return;
  }

  if (routeId === 'projects.publish') {
    const project = findProject(state.store, params.workspace_id, params.project_id);
    if (!project) {
      sendProblem(res, 404, { detail: 'project not found' });
      return;
    }
    const ts = req.headers[world.hmac.tsHeader.toLowerCase()];
    const signature = req.headers[world.hmac.header.toLowerCase()];
    if (!verifyHmac(world, { ts, signature, method: 'POST', path: url.pathname }, now)) {
      sendProblem(res, 401, { detail: 'missing or invalid request signature' });
      return;
    }
    if (project.status !== 'rendered') {
      sendProblem(res, 409, { detail: `cannot publish a project in status ${project.status}` });
      return;
    }
    project.status = 'published';
    project.updatedAt = now;
    finalizeAndSend(200, { id: project.id, status: project.status });
    return;
  }

  if (routeId === 'projects.assets') {
    const project = findProject(state.store, params.workspace_id, params.project_id);
    if (!project) {
      sendProblem(res, 404, { detail: 'project not found' });
      return;
    }
    const includeDeleted = url.searchParams.get('include_deleted') === 'true';
    const items = listAssetsForProject(state.store, project.id, { includeDeleted }).map(assetSummary);
    const page = paginate(items, paginationQuery(world, url));
    if (wantsCsv(req.headers.accept)) {
      const csv = toCsv(page.data, ['id', 'kind', 'hash', 'etag', 'display_name', 'created_at', 'updated_at']);
      const buf = Buffer.from(csv, 'utf8');
      res.writeHead(200, { 'content-type': 'text/csv', 'content-length': String(buf.length) });
      res.end(buf);
      return;
    }
    finalizeAndSend(200, page);
    return;
  }

  if (routeId === 'images.create' || routeId === 'audio.create' || routeId === 'video.create') {
    const kind = { 'images.create': 'image', 'audio.create': 'audio', 'video.create': 'video' }[routeId];
    const idemKey = req.headers['idempotency-key'];
    const result = withIdempotency(state, routeId, tokenId, idemKey, () => {
      const body = json();
      const descriptor = create(world, kind, body);
      const id = nextId(world, state.store, 'asset');
      const asset = buildAsset({ id, descriptor, store: state.store, now });
      state.store.assets.set(id, asset);
      return { status: 201, body: assetDetail(asset) };
    });
    finalizeAndSend(result.status, result.body);
    return;
  }

  if (routeId === 'assets.get') {
    const asset = state.store.assets.get(params.asset_id);
    if (!asset || asset.deleted) {
      sendProblem(res, 404, { detail: 'asset not found' });
      return;
    }
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch === asset.etag) {
      res.writeHead(304, { etag: asset.etag });
      res.end();
      return;
    }
    finalizeAndSend(200, assetDetail(asset), { etag: asset.etag });
    return;
  }

  if (routeId === 'assets.patch') {
    const asset = state.store.assets.get(params.asset_id);
    if (!asset || asset.deleted) {
      sendProblem(res, 404, { detail: 'asset not found' });
      return;
    }
    const ifMatch = req.headers['if-match'];
    if (!ifMatch) {
      sendProblem(res, 428, { detail: 'If-Match header is required' });
      return;
    }
    if (ifMatch !== asset.etag) {
      sendProblem(res, 412, { detail: 'If-Match does not match the current ETag' });
      return;
    }
    const body = json();
    const displayName = readField(world, body, 'display_name');
    if (displayName !== undefined) asset.displayName = displayName;
    asset.updatedAt = now;
    finalizeAndSend(200, { id: asset.id, display_name: asset.displayName });
    return;
  }

  if (routeId === 'assets.delete') {
    const asset = state.store.assets.get(params.asset_id);
    if (!asset || asset.deleted) {
      sendProblem(res, 404, { detail: 'asset not found' });
      return;
    }
    asset.deleted = true;
    asset.deletedAt = now;
    res.writeHead(204);
    res.end();
    return;
  }

  if (routeId === 'assets.content') {
    const asset = state.store.assets.get(params.asset_id);
    if (!asset || asset.deleted) {
      sendProblem(res, 404, { detail: 'asset not found' });
      return;
    }
    const bytes = renderAssetBytes(asset.descriptor, state.store);
    const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
    res.writeHead(200, {
      'content-type': contentTypeFor(asset.descriptor),
      'content-length': String(buf.length),
      etag: asset.etag,
    });
    res.end(buf);
    return;
  }

  if (routeId === 'assets.convert') {
    const asset = state.store.assets.get(params.asset_id);
    if (!asset || asset.deleted) {
      sendProblem(res, 404, { detail: 'asset not found' });
      return;
    }
    const body = json();
    const descriptor = convert(world, asset.descriptor, body);
    const id = nextId(world, state.store, 'asset');
    const newAsset = buildAsset({ id, projectId: asset.projectId, descriptor, store: state.store, now });
    state.store.assets.set(id, newAsset);
    finalizeAndSend(201, assetDetail(newAsset));
    return;
  }

  if (routeId === 'assets.combine') {
    const body = json();
    const ids = readField(world, body, 'ids') || [];
    const descs = [];
    for (const id of ids) {
      const a = state.store.assets.get(id);
      if (!a || a.deleted) {
        sendProblem(res, 422, { errors: [{ field: 'ids', message: `asset not found: ${id}` }] });
        return;
      }
      descs.push(a.descriptor);
    }
    const descriptor = combine(world, descs, {
      mode: readField(world, body, 'mode'),
      opacityStep: readField(world, body, 'opacity_step'),
    });
    const id = nextId(world, state.store, 'asset');
    const newAsset = buildAsset({ id, descriptor, store: state.store, now });
    state.store.assets.set(id, newAsset);
    finalizeAndSend(201, assetDetail(newAsset));
    return;
  }

  if (routeId === 'assets.diff') {
    const body = json();
    const aId = readField(world, body, 'a');
    const bId = readField(world, body, 'b');
    const a = state.store.assets.get(aId);
    const b = state.store.assets.get(bId);
    if (!a || !b) {
      sendProblem(res, 422, { errors: [{ field: !a ? 'a' : 'b', message: 'asset not found' }] });
      return;
    }
    const descriptor = diff(world, a.descriptor, b.descriptor);
    const id = nextId(world, state.store, 'asset');
    const newAsset = buildAsset({ id, descriptor, store: state.store, now });
    state.store.assets.set(id, newAsset);
    finalizeAndSend(201, assetDetail(newAsset));
    return;
  }

  if (routeId === 'loras.list') {
    const nameFilter = url.searchParams.get('name');
    let items = world.loras;
    if (nameFilter) {
      const lower = nameFilter.toLowerCase();
      items = items.filter((l) => l.name.toLowerCase() === lower);
    }
    finalizeAndSend(200, { data: items.map((l) => ({ id: l.id, name: l.name, op: l.op, amount: l.amount })) });
    return;
  }

  if (routeId === 'assets.lora') {
    const asset = state.store.assets.get(params.asset_id);
    if (!asset || asset.deleted) {
      sendProblem(res, 404, { detail: 'asset not found' });
      return;
    }
    const body = json();
    const loraId = readField(world, body, 'lora_id');
    const lora = world.loras.find((l) => l.id === loraId);
    if (!lora) {
      sendProblem(res, 422, { errors: [{ field: 'lora_id', message: 'unknown lora' }] });
      return;
    }
    const descriptor = applyLora(world, asset.descriptor, lora);
    const id = nextId(world, state.store, 'asset');
    const newAsset = buildAsset({ id, projectId: asset.projectId, descriptor, store: state.store, now });
    state.store.assets.set(id, newAsset);
    finalizeAndSend(201, assetDetail(newAsset));
    return;
  }

  if (routeId === 'jobs.get') {
    const job = state.store.jobs.get(params.job_id);
    if (!job) {
      sendProblem(res, 404, { detail: 'job not found' });
      return;
    }
    const statuses = ['queued', 'running', 'done'];
    const idx = Math.min(job.pollCount, statuses.length - 1);
    const status = statuses[idx];
    if (job.pollCount < statuses.length - 1) job.pollCount += 1;
    finalizeAndSend(200, { id: job.id, status });
    return;
  }

  if (routeId === 'pictures.legacy') {
    res.writeHead(301, { location: state.routePaths.get('images.create') });
    res.end();
    return;
  }

  if (routeId === 'rungs.current') {
    const n = state.rungs.current;
    const answer = state.rungs.answers.get(n);
    finalizeAndSend(200, { n, text: answer ? answer.text : '' });
    return;
  }

  if (routeId === 'rungs.submit') {
    const n = Number(params.n);
    // Addendum N: a submission to a rung that is not the current rung is a 409, never a
    // recorded fall. A probe or stale client hitting an old/future rung must not be scored --
    // nothing is recorded, and the current-rung one-submission rule below is unaffected.
    if (n !== state.rungs.current) {
      sendProblem(res, 409, { detail: `rung ${n} is not the current rung (${state.rungs.current})` });
      return;
    }
    if (state.rungs.submissions.some((s) => s.rung === n)) {
      sendProblem(res, 409, { detail: `rung ${n} already submitted` });
      return;
    }
    // Addendum E: a malformed submission is a 422, not a fall, and NOTHING is recorded for it --
    // a later, correct submit to the same rung must still be possible. This covers three shapes:
    // invalid JSON, `assets` missing or not an array, and any id that does not resolve to an
    // asset the caller can see. Only once every id resolves does this become a real attempt, and
    // from there on pickiness is about the artifact (count, order, hashes), never JSON transport.
    let body;
    try {
      body = json();
    } catch {
      sendProblem(res, 422, { errors: [{ field: 'body', message: 'invalid JSON body' }] });
      return;
    }
    const submittedIds = readField(world, body, 'assets');
    if (!Array.isArray(submittedIds)) {
      sendProblem(res, 422, { errors: [{ field: 'assets', message: 'assets is required and must be an array' }] });
      return;
    }
    const submittedAssets = [];
    for (const id of submittedIds) {
      // Asset ids are opaque STRINGS in the store for every world.ids.style -- `int` style
      // yields String(n), so asset 37 is keyed "37". JSON round-trips that id back as the number
      // 37 for any client that treats an all-digit id as a number, and Map.get(37) misses "37".
      // Without the coercion a numeric id would look "unresolvable" purely from JSON id typing,
      // not from the media work the ladder is supposed to grade.
      const asset = state.store.assets.get(String(id));
      if (!asset || asset.deleted) {
        sendProblem(res, 422, { errors: [{ field: 'assets', message: `asset not found: ${id}` }] });
        return;
      }
      submittedAssets.push(asset);
    }
    const submittedHashes = submittedAssets.map((a) => a.hash);
    const answer = state.rungs.answers.get(n);
    const expectedHashes = answer ? answer.expected : [];
    const hashMatch =
      expectedHashes.length === submittedHashes.length &&
      expectedHashes.every((h, i) => h === submittedHashes[i]);

    // Addendum O, "grade the chain": from rung 50 up the answer key also carries
    // expectedProjectState/expectedLabel -- the state-machine walk and the conditional-write
    // label a rung's text demands but the hash comparison alone never sees (four public calls
    // reproduce a rung-60 hash exactly with none of that work done). Checked against the LAST
    // submitted asset, the piece the rung text has the agent turn in ("Turn in the last piece
    // that leaves you with" / "Turn in exactly that piece" -- always singular for a chain-graded
    // rung). A field the answer key leaves undefined never gates the pass: a rung whose text
    // never demanded a stage or a label is graded on hashes alone, exactly as before 0.6.0.
    //
    // `project.status === expectedProjectState` alone proves the walk happened IN ORDER, not
    // just that the project now reads that way: compose/render/publish above each 409 unless the
    // project is currently in the exact prior state they expect, so there is no route from
    // `draft` to `published` other than draft -> composed -> rendered -> published in sequence.
    const target = submittedAssets[submittedAssets.length - 1];
    let stateMatch = true;
    if (answer && answer.expectedProjectState !== undefined && answer.expectedProjectState !== null) {
      const project = target && target.projectId !== null ? state.store.projects.get(target.projectId) : null;
      stateMatch = !!project && project.status === answer.expectedProjectState;
    }
    let labelMatch = true;
    if (answer && answer.expectedLabel !== undefined && answer.expectedLabel !== null) {
      labelMatch = !!target && target.displayName === answer.expectedLabel;
    }
    const pass = hashMatch && stateMatch && labelMatch;
    // Named per-check so the caller (and the recorded submission) can see exactly which of the
    // three failed, rather than a single opaque `pass: false` -- the whole point of grading the
    // chain instead of only the hash.
    const checks = { hash: hashMatch, project_state: stateMatch, label: labelMatch };
    let fidelityScore = 0;
    if (answer && Array.isArray(answer.expectedDescriptors) && answer.expectedDescriptors.length > 0) {
      const scores = answer.expectedDescriptors.map((expected, i) =>
        fidelity(expected, submittedAssets[i] ? submittedAssets[i].descriptor : {}),
      );
      fidelityScore = scores.reduce((sum, v) => sum + v, 0) / scores.length;
    }
    state.rungs.submissions.push({ rung: n, pass, submittedHashes, expectedHashes, fidelity: fidelityScore, checks });
    finalizeAndSend(200, { pass, rung: n, checks });
    return;
  }

  sendProblem(res, 404, { detail: `unhandled route: ${routeId}` });
}

// ---------------------------------------------------------------------------
// request lifecycle
// ---------------------------------------------------------------------------

async function handleRequest(state, publicRouter, req, res) {
  const startedAt = Date.now();
  const url = new URL(req.url, 'http://public.internal');
  const ctx = { tokenId: null };
  res.on('finish', () => {
    state.log.push({
      method: req.method,
      path: url.pathname,
      status: res.statusCode,
      ms: Date.now() - startedAt,
      tokenId: ctx.tokenId,
      // Rule enforcement is by detection, not prevention (ARCHITECTURE Addendum F): the harness
      // sandbox only lets `bru` reach the network, and every genuine bru invocation sends
      // `bruno-runtime/<version>`. Anything else on the wire is the agent (or its CLI) reaching
      // the API directly, and /admin/violations below is how that gets caught.
      ua: req.headers['user-agent'] || '',
    });
  });

  const match = publicRouter(req.method, url.pathname);
  if (!match) {
    sendProblem(res, 404, { detail: `no route for ${req.method} ${url.pathname}` });
    return;
  }
  const routeId = match.entry.id;
  const { params } = match;
  const now = Date.now();

  if (!NO_AUTH_ROUTES.has(routeId)) {
    const authResult = verifyBearer(state.authStore, req.headers.authorization, now);
    if (!authResult.ok) {
      sendProblem(res, 401, { detail: `bearer token ${authResult.reason}` });
      return;
    }
    ctx.tokenId = authResult.tokenId;
    const { active, targets } = state.mutations;
    if (active.has('rejectAuth') && targets.rejectAuth.route === routeId) {
      sendProblem(res, 401, { detail: 'unauthorized' });
      return;
    }
    const rl = state.rateLimiter.check(ctx.tokenId, now);
    if (!rl.allowed) {
      sendProblem(res, 429, { detail: 'rate limit exceeded', headers: { 'Retry-After': String(rl.retryAfter) } });
      return;
    }
  }

  let bodyBuf = Buffer.alloc(0);
  if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
    bodyBuf = await readBody(req);
  }
  const json = () => (bodyBuf.length === 0 ? {} : JSON.parse(bodyBuf.toString('utf8')));

  function finalizeAndSend(status, rawBody, extraHeaders = {}) {
    const finalized = finalizeJsonResponse(state, routeId, status, rawBody);
    const buf = Buffer.from(JSON.stringify(finalized.body), 'utf8');
    res.writeHead(finalized.status, {
      'content-type': 'application/json',
      'content-length': String(buf.length),
      ...extraHeaders,
    });
    res.end(buf);
  }

  try {
    await routeHandlers(routeId, { state, req, res, url, params, now, tokenId: ctx.tokenId, json, finalizeAndSend });
  } catch (err) {
    if (err instanceof MediaValidationError) {
      sendProblem(res, 422, { errors: err.errors });
    } else if (err instanceof SyntaxError) {
      sendProblem(res, 400, { detail: 'invalid JSON body' });
    } else {
      sendProblem(res, 500, { detail: err.message });
    }
  }
}

// ---------------------------------------------------------------------------
// createServer
// ---------------------------------------------------------------------------

// `adminToken` (Addendum J, "Admin port hardening"): when the caller supplies one -- a per-run
// random secret it holds and never writes into the sandbox -- every admin request must carry it
// as `X-Admin-Token` or gets a 401, counted in `state.adminProbes` (see admin.js). Omitting it
// (the default) leaves the admin port exactly as unauthenticated as every caller before this
// addendum relied on; nothing here changes for a `createServer({world})` call that names no token.
export function createServer({ world, publicPort = 0, adminPort = 0, adminToken } = {}) {
  const state = createState(world);
  const publicRouter = buildPublicRouter(world);

  const publicServer = http.createServer((req, res) => {
    handleRequest(state, publicRouter, req, res).catch((err) => {
      try {
        sendProblem(res, 500, { detail: err.message });
      } catch {
        // headers already sent; nothing more we can do
      }
    });
  });

  const adminServer = http.createServer(createAdminHandler(state, { reset: () => resetState(state), adminToken }));

  async function start() {
    await new Promise((resolve, reject) => {
      publicServer.once('error', reject);
      publicServer.listen(publicPort, () => resolve());
    });
    // ADMIN_BIND lets the container answer its mapped admin port from outside (Dockerfile sets
    // 0.0.0.0); the harness never sets this and so always gets loopback-only, per ARCHITECTURE.md.
    const adminBind = process.env.ADMIN_BIND || '127.0.0.1';
    await new Promise((resolve, reject) => {
      adminServer.once('error', reject);
      adminServer.listen(adminPort, adminBind, () => resolve());
    });
    return {
      publicPort: publicServer.address().port,
      adminPort: adminServer.address().port,
    };
  }

  function stop() {
    return Promise.all([
      new Promise((resolve) => publicServer.close(() => resolve())),
      new Promise((resolve) => adminServer.close(() => resolve())),
    ]);
  }

  return { start, stop, log: state.log };
}
