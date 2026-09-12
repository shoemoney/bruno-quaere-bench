import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routes } from '../src/routes.js';
import { makeWorld, resolvePath } from '../src/world.js';

test('every route has a unique id', () => {
  const ids = routes.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate route ids found');
});

test('every route has the required shape', () => {
  for (const route of routes) {
    assert.equal(typeof route.id, 'string', `${JSON.stringify(route)} missing id`);
    assert.ok(['GET', 'POST', 'PATCH', 'DELETE', 'PUT'].includes(route.method), `${route.id} has bad method`);
    assert.equal(typeof route.path, 'string');
    assert.ok(route.path.startsWith('/'), `${route.id} path must start with /`);
    assert.equal(typeof route.summary, 'string');
    assert.ok(route.summary.length > 0);
    assert.ok(Array.isArray(route.params));
    assert.ok(Array.isArray(route.behaviors));
    assert.equal(typeof route.inSpec, 'boolean');
  }
});

test('every route path resolves cleanly for every seed', () => {
  for (const seed of [1, 2, 3, 42]) {
    const world = makeWorld(seed);
    for (const route of routes) {
      const resolved = resolvePath(world, route.path);
      assert.ok(!resolved.includes('{workspaces}'), `${route.id} left {workspaces} unresolved`);
      assert.ok(!resolved.includes('{projects}'), `${route.id} left {projects} unresolved`);
      assert.ok(!resolved.includes('{assets}'), `${route.id} left {assets} unresolved`);
      assert.ok(!resolved.includes('{library}'), `${route.id} left {library} unresolved`);
    }
  }
});

test('/loras is not in spec', () => {
  const loras = routes.find((r) => r.id === 'loras.list');
  assert.ok(loras, 'loras.list route must exist');
  assert.equal(loras.inSpec, false);
  assert.equal(loras.path, '/{library}');
});

test('/v1/pictures is in spec and marked deprecated', () => {
  const legacy = routes.find((r) => r.id === 'pictures.legacy');
  assert.ok(legacy, 'pictures.legacy route must exist');
  assert.equal(legacy.inSpec, true);
  assert.equal(legacy.path, '/v1/pictures');
  assert.ok(legacy.behaviors.includes('deprecated'));
});

test('deprecated map from world.js points at the pictures legacy route target', () => {
  const world = makeWorld(1);
  assert.equal(world.deprecated['/v1/pictures'], '/images');
  const imagesRoute = routes.find((r) => r.id === 'images.create');
  assert.equal(imagesRoute.path, world.deprecated['/v1/pictures']);
});

test('every path param placeholder is unique and matches its params entry, in order', () => {
  // A router turns a path template into a param map, so two segments may never
  // share a placeholder name. Every non-vocab placeholder is the declared name
  // of the path param it binds, in declaration order.
  const vocabTokens = ['{workspaces}', '{projects}', '{assets}', '{library}'];
  for (const route of routes) {
    let templateWithoutVocab = route.path;
    for (const t of vocabTokens) templateWithoutVocab = templateWithoutVocab.split(t).join('');
    const placeholders = (templateWithoutVocab.match(/\{([^}]+)\}/g) || []).map((t) => t.slice(1, -1));
    assert.equal(
      new Set(placeholders).size,
      placeholders.length,
      `${route.id}: duplicate path placeholder in ${route.path}`,
    );
    const pathParams = route.params.filter((p) => p.in === 'path').map((p) => p.name);
    assert.deepEqual(placeholders, pathParams, `${route.id}: placeholders must match path params in order`);
  }
});

test('core CRUD-ish routes for images/audio/video all support idempotency', () => {
  for (const id of ['images.create', 'audio.create', 'video.create']) {
    const route = routes.find((r) => r.id === id);
    assert.ok(route.behaviors.includes('idempotency'), `${id} should be idempotent`);
  }
});

test('routes list is stable across calls (pure data)', () => {
  assert.equal(routes.length, routes.length);
  const idsA = routes.map((r) => r.id).sort();
  const idsB = routes.map((r) => r.id).sort();
  assert.deepEqual(idsA, idsB);
});
