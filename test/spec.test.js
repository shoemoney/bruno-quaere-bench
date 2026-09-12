import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toOpenApi, listLies } from '../src/spec.js';
import { makeWorld, resolvePath } from '../src/world.js';
import { routes } from '../src/routes.js';

const SEEDS = [1, 2, 3, 4, 5, 42, 7, 99];

function allJsonStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => allJsonStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => allJsonStrings(v, out));
  return out;
}

function allRefs(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => allRefs(v, out));
  else if (value && typeof value === 'object') {
    if (typeof value.$ref === 'string') out.push(value.$ref);
    Object.values(value).forEach((v) => allRefs(v, out));
  }
  return out;
}

test('toOpenApi is the right shape: openapi 3.1, info, paths, components with a bearer scheme', () => {
  const spec = toOpenApi(makeWorld(1));
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(typeof spec.info.title, 'string');
  assert.equal(spec.info.version, makeWorld(1).version);
  assert.equal(spec.components.securitySchemes.bearerAuth.type, 'http');
  assert.equal(spec.components.securitySchemes.bearerAuth.scheme, 'bearer');
  assert.deepEqual(spec.security, [{ bearerAuth: [] }]);
});

test('every inSpec route resolves to a concrete path with no vocab placeholders left', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const spec = toOpenApi(world);
    const inSpecRoutes = routes.filter((r) => r.inSpec);
    const operationCount = Object.values(spec.paths).reduce((n, methods) => n + Object.keys(methods).length, 0);
    assert.equal(operationCount, inSpecRoutes.length, `seed ${seed}: operation count mismatch`);
    for (const route of inSpecRoutes) {
      const resolved = resolvePath(world, route.path);
      assert.ok(spec.paths[resolved], `seed ${seed}: ${route.id} -> ${resolved} missing from spec.paths`);
      assert.ok(spec.paths[resolved][route.method.toLowerCase()], `seed ${seed}: ${route.id} missing its method`);
    }
  }
});

test('/loras never appears in the spec (not inSpec)', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const spec = toOpenApi(world);
    assert.ok(!Object.keys(spec.paths).some((p) => p.endsWith(`/${world.vocab.library}`)));
  }
});

test('the deprecated legacy path is present and marked deprecated:true', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const spec = toOpenApi(world);
    const op = spec.paths['/v1/pictures']?.get;
    assert.ok(op, `seed ${seed}: /v1/pictures missing`);
    assert.equal(op.deprecated, true);
  }
});

test('no placeholder braces remain anywhere in the document', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const json = JSON.stringify(toOpenApi(world));
    for (const token of ['{workspaces}', '{projects}', '{assets}', '{library}']) {
      assert.ok(!json.includes(token), `seed ${seed}: leftover ${token}`);
    }
  }
});

test('every $ref in the document resolves to a schema actually present in components.schemas', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const spec = toOpenApi(world);
    const refs = allRefs(spec.paths);
    const names = Object.keys(spec.components.schemas);
    for (const ref of refs) {
      assert.ok(ref.startsWith('#/components/schemas/'), `seed ${seed}: unresolved bare ref ${ref}`);
      const name = ref.slice('#/components/schemas/'.length);
      assert.ok(names.includes(name), `seed ${seed}: dangling ref ${ref}`);
    }
  }
});

test('the required component schemas exist: Asset, Descriptor, Shape, Note, Clip, Problem', () => {
  const spec = toOpenApi(makeWorld(1));
  for (const name of ['Asset', 'Descriptor', 'Shape', 'Note', 'Clip', 'Problem']) {
    assert.ok(spec.components.schemas[name], `missing component ${name}`);
  }
});

test('field names in request/response schemas follow world.naming, honoring exceptions', () => {
  // The project-assets listing's include_deleted query param is a multi-word field, so it
  // actually flips under the naming convention (unlike single-word fields such as `id`).
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const spec = toOpenApi(world);
    const route = routes.find((r) => r.id === 'projects.assets');
    const resolvedPath = resolvePath(world, route.path);
    const params = spec.paths[resolvedPath].get.parameters.map((p) => p.name);
    const expected = world.namingExceptions.includes('include_deleted')
      ? (world.naming === 'camel' ? 'include_deleted' : 'includeDeleted')
      : (world.naming === 'camel' ? 'includeDeleted' : 'include_deleted');
    assert.ok(params.includes(expected), `seed ${seed}: expected ${expected} in ${JSON.stringify(params)}`);
  }
});

test('listLies returns exactly one entry per live trap, and every trap name is one of the six', () => {
  const VALID = new Set(['fieldCase', 'deleteStatus', 'optionalIsRequired', 'enumSpelling', 'wrongDefault', 'missingRequiredHeader']);
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const lies = listLies(world);
    assert.equal(lies.length, world.traps.live.length, `seed ${seed}`);
    assert.deepEqual(lies.map((l) => l.trap).sort(), [...world.traps.live].sort());
    for (const lie of lies) {
      assert.ok(VALID.has(lie.trap));
      assert.equal(typeof lie.path, 'string');
      assert.ok(lie.path.length > 0);
      assert.equal(typeof lie.detail, 'object');
    }
  }
});

test('deleteStatus lie: spec says 200 on the delete route, with 204 nowhere on it', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    if (!world.traps.live.includes('deleteStatus')) continue;
    const spec = toOpenApi(world);
    const lie = listLies(world).find((l) => l.trap === 'deleteStatus');
    const op = spec.paths[lie.path].delete;
    assert.ok(op.responses['200'], `seed ${seed}: expected a lied 200 on ${lie.path}`);
    assert.ok(!op.responses['204'], `seed ${seed}: real 204 should not appear in the spec`);
  }
});

test('fieldCase lie: the named field in the spec is not present under its real spelling', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    if (!world.traps.live.includes('fieldCase')) continue;
    const spec = toOpenApi(world);
    const lie = listLies(world).find((l) => l.trap === 'fieldCase');
    const schema = spec.paths[lie.path][lie.detail.method].responses[lie.detail.status].content['application/json'].schema;
    assert.ok(Object.prototype.hasOwnProperty.call(schema.properties, lie.detail.spec), `seed ${seed}`);
    assert.ok(!Object.prototype.hasOwnProperty.call(schema.properties, lie.detail.real), `seed ${seed}`);
    assert.notEqual(lie.detail.spec, lie.detail.real);
  }
});

test('optionalIsRequired lie: the named field is absent from the spec\'s required list (or marked not required)', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    if (!world.traps.live.includes('optionalIsRequired')) continue;
    const spec = toOpenApi(world);
    const lie = listLies(world).find((l) => l.trap === 'optionalIsRequired');
    const op = spec.paths[lie.path][lie.detail.method];
    const bodySchema = op.requestBody?.content?.['application/json']?.schema;
    const param = op.parameters?.find((p) => p.name === lie.detail.field);
    const stillRequiredInBody = bodySchema?.required?.includes(lie.detail.field);
    const stillRequiredAsParam = param?.required === true;
    assert.ok(!stillRequiredInBody && !stillRequiredAsParam, `seed ${seed}: ${lie.detail.field} still required in spec`);
  }
});

test('enumSpelling lie: the misspelled value appears in the spec enum, the real value does not', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    if (!world.traps.live.includes('enumSpelling')) continue;
    const spec = toOpenApi(world);
    const lie = listLies(world).find((l) => l.trap === 'enumSpelling');
    const op = spec.paths[lie.path][lie.detail.method];
    const schema = lie.detail.status
      ? op.responses[lie.detail.status]?.content?.['application/json']?.schema
      : op.requestBody?.content?.['application/json']?.schema;
    // status may live inside detail.method/detail only implicitly; search both locations robustly
    const candidates = [
      op.requestBody?.content?.['application/json']?.schema,
      ...Object.values(op.responses).map((r) => r.content?.['application/json']?.schema),
    ].filter(Boolean);
    const owner = candidates.find((s) => s.properties?.[lie.detail.field]?.enum?.includes(lie.detail.spec));
    assert.ok(owner, `seed ${seed}: misspelled enum value not found in spec`);
    assert.ok(!owner.properties[lie.detail.field].enum.includes(lie.detail.real), `seed ${seed}: real value should not remain`);
    void schema;
  }
});

test('wrongDefault lie: the named field\'s default in the spec differs from the world\'s real value', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    if (!world.traps.live.includes('wrongDefault')) continue;
    const spec = toOpenApi(world);
    const lie = listLies(world).find((l) => l.trap === 'wrongDefault');
    const op = spec.paths[lie.path][lie.detail.method];
    const param = op.parameters.find((p) => p.name === lie.detail.field);
    assert.equal(param.schema.default, lie.detail.spec, `seed ${seed}`);
    assert.notEqual(param.schema.default, world.pagination.pageSize, `seed ${seed}: default should be lied about`);
    assert.equal(lie.detail.real, world.pagination.pageSize);
  }
});

test('missingRequiredHeader lie: the named header parameter is entirely absent from that operation', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    if (!world.traps.live.includes('missingRequiredHeader')) continue;
    const spec = toOpenApi(world);
    const lie = listLies(world).find((l) => l.trap === 'missingRequiredHeader');
    const op = spec.paths[lie.path][lie.detail.method];
    assert.ok(!op.parameters.some((p) => p.in === 'header' && p.name === lie.detail.header), `seed ${seed}`);
  }
});

test('toOpenApi and listLies are pure and deterministic: repeated calls, and repeated makeWorld, agree', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    assert.equal(JSON.stringify(toOpenApi(world)), JSON.stringify(toOpenApi(world)));
    assert.equal(JSON.stringify(listLies(world)), JSON.stringify(listLies(world)));
    assert.equal(JSON.stringify(toOpenApi(world)), JSON.stringify(toOpenApi(makeWorld(seed))));
  }
});

test('generating specs for many seeds in one process never lets one seed\'s lie leak into another\'s (routes.js must stay unmutated)', () => {
  // Regression test: transformSchema must clone route.request/responseSchema before any
  // trap mutates it in place, or a later seed would inherit an earlier seed's lie because
  // routes.js's schema objects (e.g. bearerTokenSchema) are shared literals.
  const before = JSON.stringify(routes);
  for (const seed of SEEDS) {
    toOpenApi(makeWorld(seed));
    listLies(makeWorld(seed));
  }
  const after = JSON.stringify(routes);
  assert.equal(before, after, 'routes.js was mutated by spec generation');
  // And re-running the very first seed again after all the others still agrees with itself.
  const first = JSON.stringify(toOpenApi(makeWorld(SEEDS[0])));
  const firstAgain = JSON.stringify(toOpenApi(makeWorld(SEEDS[0])));
  assert.equal(first, firstAgain);
});

test('every operation that takes a request body documents a 422 problem+json response', () => {
  const spec = toOpenApi(makeWorld(5));
  for (const [, methods] of Object.entries(spec.paths)) {
    for (const op of Object.values(methods)) {
      if (op.requestBody) {
        assert.ok(op.responses['422'], `${op.operationId} missing 422`);
        assert.ok(op.responses['422'].content['application/problem+json']);
      }
    }
  }
});

test('auth.token and auth.refresh require no bearer security; every other operation does', () => {
  const spec = toOpenApi(makeWorld(6));
  for (const [, methods] of Object.entries(spec.paths)) {
    for (const op of Object.values(methods)) {
      if (op.operationId === 'auth.token' || op.operationId === 'auth.refresh') {
        assert.deepEqual(op.security, []);
      } else {
        assert.deepEqual(op.security, [{ bearerAuth: [] }]);
      }
    }
  }
});
