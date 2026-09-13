// Proves the spec's lies are real lies: for every entry listLies(world) reports, the published
// OpenAPI document says one thing and the running API demonstrably does another.
//
// This is the test that keeps the trap catalog honest. A "trap" that the spec and the API agree
// on is not a trap at all, it is just a spec, and an agent that trusted the spec would sail past
// it. Each case below asserts BOTH halves: the document really carries the false statement, and
// a live request really contradicts it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { makeWorld, resolvePath, fieldName } from '../src/world.js';
import { routes } from '../src/routes.js';
import { createServer } from '../src/api/server.js';
import { toOpenApi, listLies } from '../src/spec.js';
import { publishHeaders } from './fixtures/sign.js';

const SEEDS = [1, 2, 3];

// --------------------------------------------------------------------------
// a live server plus the fixtures every probe needs, per seed
// --------------------------------------------------------------------------

async function bootstrap(seed) {
  const world = makeWorld(seed);
  const server = createServer({ world, publicPort: 0, adminPort: 0 });
  const ports = await server.start();
  const base = `http://127.0.0.1:${ports.publicPort}`;

  const f = (n) => fieldName(world, n);
  const tmpl = (id) => resolvePath(world, routes.find((r) => r.id === id).path);
  const fill = (t, params) => {
    let out = t;
    for (const [k, v] of Object.entries(params)) out = out.replace(`{${k}}`, encodeURIComponent(v));
    return out;
  };

  async function call(method, path, { body, headers = {}, token } = {}) {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + path, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const text = await res.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* non-JSON bodies (204, csv, bytes) stay as text */
    }
    return { status: res.status, headers: res.headers, body: parsed, text };
  }

  async function mint() {
    const res = await call('POST', '/auth/token', { body: { [f('api_key')]: world.auth.apiKey } });
    assert.equal(res.status, 200, 'token mint must succeed');
    return res.body[f('access_token')];
  }

  // Every probe re-mints rather than sharing one token: these suites make far more requests in
  // ten seconds than world.rate.limit allows, and a 429 would mask the behavior under test.
  const ctx = { world, server, base, f, tmpl, fill, call, mint };

  const token = await mint();
  const wsList = await call('GET', tmpl('workspaces.list'), { token });
  ctx.workspaceId = wsList.body.data[0].id;
  const projList = await call('GET', fill(tmpl('projects.list'), { workspace_id: ctx.workspaceId }), { token });
  ctx.projectId = projList.body.data[0].id;
  ctx.draftProjectId = projList.body.data[1] ? projList.body.data[1].id : projList.body.data[0].id;
  const assetList = await call(
    'GET',
    `${fill(tmpl('projects.assets'), { workspace_id: ctx.workspaceId, project_id: ctx.projectId })}?page_size=50`,
    { token },
  );
  ctx.assetIds = assetList.body.data.map((a) => a.id);
  ctx.assetId = ctx.assetIds[0];
  ctx.assetEtag = assetList.body.data[0].etag;
  return ctx;
}

// The OpenAPI operation object a lie points at.
function operationFor(doc, lie) {
  const item = doc.paths[lie.path];
  assert.ok(item, `spec has no path ${lie.path}`);
  const op = item[lie.detail.method];
  assert.ok(op, `spec has no ${lie.detail.method} on ${lie.path}`);
  return op;
}

// A header a lie names, spelled as the world spells it.
function isHeaderLie(world, name) {
  return [world.hmac.tsHeader, world.hmac.header, 'If-Match', 'If-None-Match', 'Idempotency-Key'].includes(name);
}

// --------------------------------------------------------------------------
// one probe per trap: assert the document, then contradict it against the API
// --------------------------------------------------------------------------

const PROBES = {
  // spec: DELETE answers 200. api: it answers 204.
  async deleteStatus(ctx, lie) {
    const { detail } = lie;
    const op = operationFor(ctx.doc, lie);
    assert.ok(op.responses[String(detail.spec)], `spec must declare ${detail.spec} on DELETE`);
    assert.equal(op.responses[String(detail.real)], undefined, `spec must NOT declare the real ${detail.real}`);

    const token = await ctx.mint();
    // a throwaway asset so the shared fixtures stay intact
    const shape = { type: 'rect', x: 0, y: 0, w: 4, h: 4, color: '#ff0000', opacity: 1 };
    if (ctx.world.rules.zOrder === 'explicit') shape.z = 0;
    const made = await ctx.call('POST', '/images', {
      token,
      body: { width: 16, height: 16, background: { color: '#000000' }, shapes: [shape] },
    });
    assert.equal(made.status, 201);
    const res = await ctx.call('DELETE', ctx.fill(ctx.tmpl('assets.delete'), { asset_id: made.body.id }), { token });
    assert.equal(res.status, detail.real, 'the API really answers the un-documented status');
    assert.notEqual(res.status, detail.spec, 'and it is not what the spec claims');
  },

  // spec: the field is spelled one way. api: it is spelled the other way.
  async fieldCase(ctx, lie) {
    const { detail } = lie;
    const op = operationFor(ctx.doc, lie);
    const schema = op.responses[detail.status].content['application/json'].schema;
    const props = schema.properties || {};
    assert.ok(detail.spec in props, `spec must carry the lie spelling ${detail.spec}`);
    assert.ok(!(detail.real in props), `spec must NOT carry the real spelling ${detail.real}`);

    const body = await liveBodyFor(ctx, lie.path, detail.method, detail.status);
    assert.ok(detail.real in body, `the API really returns ${detail.real}, got ${Object.keys(body)}`);
    assert.ok(!(detail.spec in body), `the API must not also return the spec's ${detail.spec}`);
  },

  // spec: the field/header is optional. api: omitting it fails.
  async optionalIsRequired(ctx, lie) {
    const { detail } = lie;
    const op = operationFor(ctx.doc, lie);
    if (isHeaderLie(ctx.world, detail.field)) {
      const param = (op.parameters || []).find((p) => p.name === detail.field);
      assert.ok(param, `spec must still list the header ${detail.field}`);
      assert.notEqual(param.required, true, 'spec must claim it is optional');
    } else {
      const required = op.requestBody.content['application/json'].schema.required || [];
      assert.ok(!required.includes(detail.field), `spec must not list ${detail.field} as required`);
    }
    await assertOmittingFails(ctx, lie);
  },

  // spec: the header is not documented at all. api: omitting it fails.
  async missingRequiredHeader(ctx, lie) {
    const { detail } = lie;
    const op = operationFor(ctx.doc, lie);
    const names = (op.parameters || []).map((p) => p.name);
    assert.ok(!names.includes(detail.header), `spec must omit ${detail.header} entirely, saw ${names}`);
    await assertOmittingFails(ctx, { ...lie, detail: { ...detail, field: detail.header } });
  },

  // spec: the enum carries a misspelling. api: it emits the correct spelling.
  async enumSpelling(ctx, lie) {
    const { detail } = lie;
    const op = operationFor(ctx.doc, lie);
    const schema = op.responses['200'].content['application/json'].schema;
    const values = schema.properties[detail.field].enum;
    assert.ok(values.includes(detail.spec), `spec enum must carry the misspelling ${detail.spec}`);
    assert.ok(!values.includes(detail.real), `spec enum must not carry the real ${detail.real}`);

    const body = await liveBodyFor(ctx, lie.path, detail.method, '200');
    assert.equal(body[detail.field], detail.real, 'the API emits the correctly-spelled value');
    assert.notEqual(body[detail.field], detail.spec);
  },

  // spec: the default page size is N. api: it is something else.
  async wrongDefault(ctx, lie) {
    const { detail } = lie;
    const op = operationFor(ctx.doc, lie);
    const param = (op.parameters || []).find((p) => p.name === detail.field);
    assert.ok(param, `spec must document the ${detail.field} parameter`);
    assert.equal(param.schema.default, detail.spec, 'spec carries the false default');
    assert.notEqual(detail.spec, detail.real, 'and it differs from the real one');
    assert.equal(detail.real, ctx.world.pagination.pageSize, 'the real default is the world value');

    // Measured, not asserted from the world object: stock a project with more assets than any
    // page size the generator can pick (5..25), then ask for a page with no page_size at all.
    const made = [];
    for (let i = 0; i < 20; i += 1) {
      const shape = { type: 'rect', x: i, y: 0, w: 3, h: 3, color: '#00ff00', opacity: 1 };
      if (ctx.world.rules.zOrder === 'explicit') shape.z = 0;
      const res = await ctx.call('POST', '/images', {
        token: await ctx.mint(),
        body: { width: 32, height: 32, background: { color: '#111111' }, shapes: [shape] },
      });
      assert.equal(res.status, 201);
      made.push(res.body.id);
    }
    const projectPath = ctx.fill(ctx.tmpl('projects.compose'), {
      workspace_id: ctx.workspaceId,
      project_id: ctx.draftProjectId,
    });
    const composed = await ctx.call('POST', projectPath, {
      token: await ctx.mint(),
      body: { [ctx.f('asset_ids')]: made },
    });
    assert.equal(composed.status, 200, 'compose must attach the new assets to the project');

    const listPath = ctx.fill(ctx.tmpl('projects.assets'), {
      workspace_id: ctx.workspaceId,
      project_id: ctx.draftProjectId,
    });
    const page = await ctx.call('GET', listPath, { token: await ctx.mint() });
    assert.equal(page.status, 200);
    assert.equal(page.body.data.length, detail.real, 'the observed default page size is the real one');
    assert.notEqual(page.body.data.length, detail.spec, 'and not the one the spec advertises');
  },
};

// Fetch a real 2xx body from the operation a lie points at.
async function liveBodyFor(ctx, specPath, method, status) {
  const token = await ctx.mint();
  if (specPath === '/auth/refresh') {
    const first = await ctx.call('POST', '/auth/token', { body: { [ctx.f('api_key')]: ctx.world.auth.apiKey } });
    const res = await ctx.call('POST', '/auth/refresh', {
      body: { [ctx.f('refresh_token')]: first.body[ctx.f('refresh_token')] },
    });
    assert.equal(res.status, Number(status));
    return res.body;
  }
  if (specPath === '/auth/token') {
    const res = await ctx.call('POST', '/auth/token', { body: { [ctx.f('api_key')]: ctx.world.auth.apiKey } });
    assert.equal(res.status, Number(status));
    return res.body;
  }
  if (specPath.startsWith('/jobs/')) {
    const { jobPath } = await driveProjectToRender(ctx);
    const res = await ctx.call('GET', jobPath, { token: await ctx.mint() });
    assert.equal(res.status, 200);
    return res.body;
  }
  if (specPath === ctx.tmpl('workspaces.get')) {
    const res = await ctx.call('GET', ctx.fill(specPath, { workspace_id: ctx.workspaceId }), { token });
    assert.equal(res.status, 200);
    return res.body;
  }
  if (specPath === ctx.tmpl('assets.get')) {
    const res = await ctx.call('GET', ctx.fill(specPath, { asset_id: ctx.assetId }), { token });
    assert.equal(res.status, 200);
    return res.body;
  }
  if (specPath === ctx.tmpl('projects.get')) {
    const res = await ctx.call(
      'GET',
      ctx.fill(specPath, { workspace_id: ctx.workspaceId, project_id: ctx.projectId }),
      { token },
    );
    assert.equal(res.status, 200);
    return res.body;
  }
  throw new Error(`no live probe wired for ${method.toUpperCase()} ${specPath}`);
}

// Walk a fresh project draft -> composed -> rendered and hand back both the job URL and the
// project it left in `rendered`, so a publish probe has a project in the right state.
async function driveProjectToRender(ctx) {
  const token = await ctx.mint();
  const created = await ctx.call('POST', ctx.fill(ctx.tmpl('projects.create'), { workspace_id: ctx.workspaceId }), {
    token,
    body: { name: 'spec-vs-api render probe' },
  });
  assert.equal(created.status, 201);
  const params = { workspace_id: ctx.workspaceId, project_id: created.body.id };
  // A fresh asset per probe: composing only claims an asset no project owns yet, and rule 35's
  // release digest has to name a live asset belonging to THIS project.
  const shape = { type: 'rect', x: 0, y: 0, w: 4, h: 4, color: '#ff0000', opacity: 1 };
  if (ctx.world.rules.zOrder === 'explicit') shape.z = 0;
  const asset = await ctx.call('POST', '/images', {
    token: await ctx.mint(),
    body: { width: 16, height: 16, background: { color: '#000000' }, shapes: [shape] },
  });
  assert.equal(asset.status, 201);
  const composed = await ctx.call('POST', ctx.fill(ctx.tmpl('projects.compose'), params), {
    token: await ctx.mint(),
    body: { [ctx.f('asset_ids')]: [asset.body.id] },
  });
  assert.equal(composed.status, 200);
  const rendered = await ctx.call('POST', ctx.fill(ctx.tmpl('projects.render'), params), {
    token: await ctx.mint(),
    body: {},
  });
  assert.equal(rendered.status, 202);
  return { jobPath: rendered.headers.get('location'), projectId: created.body.id, digest: asset.body.hash };
}

// Send the operation a valid request with the lied-about field/header removed and assert the
// API rejects it — which is what "really required" means.
async function assertOmittingFails(ctx, lie) {
  const name = lie.detail.field;
  const token = await ctx.mint();

  if (lie.path.endsWith('/publish')) {
    // Each half gets its own project driven all the way to `rendered`, so a 409 for the wrong
    // state can never be mistaken for the 401 this probe is looking for.
    const signedHeaders = (path, bodyDigest) => publishHeaders(ctx.world, { path, bodyDigest });
    const publishPathFor = (projectId) =>
      ctx.fill(ctx.tmpl('projects.publish'), { workspace_id: ctx.workspaceId, project_id: projectId });

    // control: every header present, and it succeeds
    const control = await driveProjectToRender(ctx);
    const controlPath = publishPathFor(control.projectId);
    const withAll = await ctx.call('POST', controlPath, {
      token: await ctx.mint(),
      body: {},
      headers: signedHeaders(controlPath, control.digest),
    });
    assert.equal(withAll.status, 200, 'the fully-signed request is the control and must succeed');

    // probe: the same request with only the lied-about header dropped
    const probe = await driveProjectToRender(ctx);
    const probePath = publishPathFor(probe.projectId);
    const partial = signedHeaders(probePath, probe.digest);
    assert.ok(name in partial, `${name} must be one of the headers this probe controls`);
    delete partial[name];
    const res = await ctx.call('POST', probePath, { token: await ctx.mint(), body: {}, headers: partial });
    assert.equal(res.status, 401, `omitting ${name} must be rejected, not accepted as optional`);
    return;
  }

  if (lie.path === ctx.tmpl('assets.patch')) {
    const headers = { 'If-Match': ctx.assetEtag, 'If-None-Match': '"x"' };
    delete headers[name];
    const res = await ctx.call('PATCH', ctx.fill(lie.path, { asset_id: ctx.assetId }), {
      token,
      body: { [ctx.f('display_name')]: 'probe' },
      headers,
    });
    assert.ok(res.status >= 400, `omitting ${name} must be rejected, got ${res.status}`);
    assert.equal(res.headers.get('content-type').split(';')[0], 'application/problem+json');
    return;
  }

  if (lie.path === '/images' || lie.path === '/audio' || lie.path === '/video') {
    const shape = { type: 'rect', x: 0, y: 0, w: 4, h: 4, color: '#ff0000', opacity: 1 };
    if (ctx.world.rules.zOrder === 'explicit') shape.z = 0;
    const full = { width: 16, height: 16, background: { color: '#000000' }, shapes: [shape] };
    const control = await ctx.call('POST', lie.path, { token, body: full });
    assert.equal(control.status, 201, 'the complete body is the control and must succeed');
    const partial = { ...full };
    delete partial[name];
    const res = await ctx.call('POST', lie.path, { token: await ctx.mint(), body: partial });
    assert.equal(res.status, 422, `omitting ${name} must be a 422, not accepted as optional`);
    const fields = (res.body.errors || []).map((e) => e.field);
    assert.ok(fields.includes(name), `the 422 must name ${name}, got ${JSON.stringify(fields)}`);
    return;
  }

  throw new Error(`no omission probe wired for ${lie.path} / ${name}`);
}

// --------------------------------------------------------------------------
// the suite
// --------------------------------------------------------------------------

for (const seed of SEEDS) {
  test(`seed ${seed}: every lie listLies() reports is a real divergence between the spec and the API`, async (t) => {
    const ctx = await bootstrap(seed);
    ctx.doc = toOpenApi(ctx.world);
    t.after(() => ctx.server.stop());

    const lies = listLies(ctx.world);
    assert.ok(lies.length >= 2, 'every world runs at least two live traps');
    assert.deepEqual(
      [...new Set(lies.map((l) => l.trap))].sort(),
      [...ctx.world.traps.live].sort(),
      'listLies covers exactly the live traps and nothing else',
    );

    for (const lie of lies) {
      const probe = PROBES[lie.trap];
      assert.ok(probe, `no probe implemented for trap ${lie.trap}`);
      await t.test(`${lie.trap} @ ${lie.detail.method.toUpperCase()} ${lie.path}`, async () => {
        await probe(ctx, lie);
      });
    }
  });
}

test('a trap that is not live never shows up as a lie, and the spec then tells the truth', async (t) => {
  // seed 4 runs three traps; the three it does not run must leave the document honest.
  const world = makeWorld(4);
  const server = createServer({ world, publicPort: 0, adminPort: 0 });
  await server.start();
  t.after(() => server.stop());

  const doc = toOpenApi(world);
  const live = new Set(world.traps.live);
  const lies = listLies(world);
  assert.deepEqual([...new Set(lies.map((l) => l.trap))].sort(), [...live].sort());

  if (!live.has('deleteStatus')) {
    const del = doc.paths[resolvePath(world, routes.find((r) => r.id === 'assets.delete').path)].delete;
    assert.ok(del.responses['204'], 'with deleteStatus dormant the spec must document the real 204');
    assert.equal(del.responses['200'], undefined);
  }
});
