// World -> OpenAPI 3.1 document, with every live trap applied as a deliberate,
// deterministic lie on top of an otherwise-accurate spec.
//
// toOpenApi(world) is what a real client would download and read. listLies(world)
// is what the harness uses to score Trap: the ground truth of what was lied about,
// which the OpenAPI document itself does not (and must not) admit to.

import { routes } from './routes.js';
import { resolvePath, fieldName } from './world.js';
import { rng, sub, pick } from './seed.js';

const REF_MAP = { workspace: 'Workspace', project: 'Project', asset: 'Asset', lora: 'Lora' };

// Status code a real response for this route carries, absent any lie. Kept here
// (not derived from behaviors[]) because it is a documentation fact, independent
// of how the api/ workstream implements it.
const STATUS_OVERRIDES = {
  'projects.render': 202,
  'assets.delete': 204,
  'pictures.legacy': 301,
  'images.create': 201,
  'audio.create': 201,
  'video.create': 201,
  'projects.create': 201,
};

// Addendum O, "the house refuses the wrong reading": assets.convert.format is a per-kind enum,
// not one flat list -- media.js's convertImage/convertAudio/convertVideo (src/media.js) 422 any
// format outside the target asset's own kind, and this is that same fact stated in the doc. Kept
// here as a literal, mirroring media.js's own IMAGE_FORMATS/AUDIO_FORMATS/VIDEO_FORMATS, for the
// same reason STATUS_OVERRIDES above is a literal: it is a documentation fact independent of how
// the api/ workstream implements the check, not a value to import across the ownership line.
const CONVERT_FORMATS_BY_KIND = {
  image: ['svg', 'png'],
  audio: ['wav', 'qa8'],
  video: ['qvid'],
};

// The convert request never states which kind it targets (that's implied by the asset in the
// path), so there is no discriminator field to hang an `if`/`then` off of. A `oneOf` of
// non-overlapping enums says the same thing a discriminated union would -- a submitted format
// validates against exactly one branch, or none -- and each branch's description spells out
// which kind it is for, which is the part a flat five-value enum (the old shape here) left the
// reader to guess at, wrongly, for two of three kinds.
function convertFormatSchema() {
  return {
    oneOf: [
      { enum: CONVERT_FORMATS_BY_KIND.image, description: 'valid when converting an image asset' },
      { enum: CONVERT_FORMATS_BY_KIND.audio, description: 'valid when converting an audio asset' },
      { enum: CONVERT_FORMATS_BY_KIND.video, description: 'valid when converting a video asset' },
    ],
  };
}

function statusFor(route) {
  if (route.id in STATUS_OVERRIDES) return STATUS_OVERRIDES[route.id];
  if (route.method === 'DELETE') return 204;
  return 200;
}

function typeFor(t) {
  return t === 'integer' || t === 'boolean' ? t : 'string';
}

// Rename schema property keys per world.naming (and its exceptions), fix up the
// bare {$ref: 'workspace'} shorthand routes.js uses into a real component
// pointer, and swap a literal `descriptor: {type:'object'}` placeholder for a
// pointer at the real Descriptor component. Recurses into object/array schemas
// only -- routes.js never nests deeper than that.
function transformSchema(world, schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (typeof schema.$ref === 'string') {
    const target = REF_MAP[schema.$ref];
    return { $ref: target ? `#/components/schemas/${target}` : schema.$ref };
  }
  if (schema.type === 'array') {
    return { ...schema, items: transformSchema(world, schema.items) };
  }
  if (schema.type === 'object' && schema.properties) {
    const properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      const renamed = fieldName(world, key);
      if (key === 'descriptor' && value && value.type === 'object' && !value.properties) {
        properties[renamed] = { $ref: '#/components/schemas/Descriptor' };
        continue;
      }
      properties[renamed] = transformSchema(world, value);
    }
    const out = { ...schema, properties };
    if (Array.isArray(schema.required)) out.required = schema.required.map((f) => fieldName(world, f));
    return out;
  }
  return schema;
}

function buildParameters(world, params) {
  return params.map((p) => {
    const inQuery = p.in === 'query';
    return {
      name: inQuery ? fieldName(world, p.name) : p.name,
      in: p.in,
      required: !!p.required,
      schema: { type: typeFor(p.type) },
    };
  });
}

function problemRef() {
  return { $ref: '#/components/schemas/Problem' };
}

function buildResponses(world, route, status) {
  const responses = {};
  const entry = { description: route.summary };
  if (status === 202) entry.headers = { Location: { schema: { type: 'string' }, description: 'Poll this to track the job' } };
  if (status === 301) entry.headers = { Location: { schema: { type: 'string' }, description: 'The route this path now lives at' } };
  // Addendum Q rule 3/8: load-bearing values that travel only in a response header (ETag, the
  // pagination Link) -- see routes.js's `responseHeaders`.
  if (Array.isArray(route.responseHeaders) && route.responseHeaders.length > 0) {
    entry.headers = { ...entry.headers };
    for (const h of route.responseHeaders) {
      entry.headers[h.name] = { schema: { type: 'string' }, description: h.description };
    }
  }
  if (route.responseSchema && status !== 204 && status !== 301) {
    // routes.js schemas are shared literals (e.g. bearerTokenSchema is reused by two
    // routes); clone before transformSchema/the trap functions mutate anything, or a
    // lie applied here would leak into routes.js's module-level state permanently.
    entry.content = { 'application/json': { schema: transformSchema(world, structuredClone(route.responseSchema)) } };
  }
  responses[String(status)] = entry;
  if (route.requestSchema) {
    responses['422'] = {
      description: 'Validation failed',
      content: { 'application/problem+json': { schema: problemRef() } },
    };
  }
  responses.default = {
    description: 'Unexpected error',
    content: { 'application/problem+json': { schema: problemRef() } },
  };
  return responses;
}

function componentSchemas() {
  return {
    Workspace: {
      type: 'object',
      required: ['id', 'name', 'created_at', 'links'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        created_at: { type: 'string' },
        links: { type: 'object', description: 'Discovery block; the only documented way to find sibling resources not in this spec' },
      },
    },
    Project: {
      type: 'object',
      required: ['id', 'status'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'composed', 'rendered', 'published'] },
        created_at: { type: 'string' },
        updated_at: { type: 'string' },
      },
    },
    Asset: {
      type: 'object',
      required: ['id', 'descriptor', 'hash'],
      properties: {
        id: { type: 'string' },
        descriptor: { $ref: '#/components/schemas/Descriptor' },
        hash: { type: 'string' },
        etag: { type: 'string' },
        display_name: { type: 'string' },
        created_at: { type: 'string' },
        deleted_at: { type: 'string', nullable: true },
      },
    },
    // Descriptor/Shape/Note/Clip mirror src/media.js's descriptor model exactly.
    // Those field names (kind, durationMs, assetId, ...) are the fixed internal
    // media contract and are never subject to world.naming -- only the API's own
    // wrapper fields (Asset, Workspace, Project, ...) follow that convention.
    Descriptor: {
      type: 'object',
      required: ['kind', 'format'],
      properties: {
        kind: { type: 'string', enum: ['image', 'audio', 'video'] },
        format: { type: 'string', enum: ['svg', 'png', 'wav', 'qa8', 'qvid'] },
        width: { type: 'integer' },
        height: { type: 'integer' },
        background: { type: 'object' },
        shapes: { type: 'array', items: { $ref: '#/components/schemas/Shape' } },
        lora: { type: 'object' },
        sampleRate: { type: 'integer' },
        durationMs: { type: 'integer' },
        notes: { type: 'array', items: { $ref: '#/components/schemas/Note' } },
        fps: { type: 'integer' },
        clips: { type: 'array', items: { $ref: '#/components/schemas/Clip' } },
        audio: { type: 'object' },
      },
    },
    Shape: {
      type: 'object',
      required: ['type', 'color', 'opacity'],
      properties: {
        type: { type: 'string', enum: ['rect', 'circle', 'line'] },
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
        r: { type: 'number' },
        x2: { type: 'number' },
        y2: { type: 'number' },
        color: { type: 'string' },
        opacity: { type: 'number', minimum: 0, maximum: 1 },
        z: { type: 'integer' },
      },
    },
    Note: {
      type: 'object',
      required: ['freq', 'startMs', 'durMs', 'amp', 'wave'],
      properties: {
        freq: { type: 'number' },
        startMs: { type: 'integer' },
        durMs: { type: 'integer' },
        amp: { type: 'number', minimum: 0, maximum: 1 },
        wave: { type: 'string', enum: ['sine', 'square', 'saw', 'triangle'] },
      },
    },
    Clip: {
      type: 'object',
      required: ['assetId', 'startMs', 'durMs', 'opacity'],
      properties: {
        assetId: { type: 'string' },
        startMs: { type: 'integer' },
        durMs: { type: 'integer' },
        opacity: { type: 'number', minimum: 0, maximum: 1 },
        z: { type: 'integer' },
      },
    },
    Problem: {
      type: 'object',
      required: ['type', 'title', 'status'],
      properties: {
        type: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'integer' },
        detail: { type: 'string' },
        instance: { type: 'string' },
        errors: {
          type: 'array',
          items: {
            type: 'object',
            required: ['field', 'message'],
            properties: { field: { type: 'string' }, message: { type: 'string' } },
          },
        },
      },
    },
  };
}

const UNAUTHENTICATED = new Set(['auth.token', 'auth.refresh']);

function buildPaths(world) {
  const paths = {};
  for (const route of routes.filter((r) => r.inSpec)) {
    const resolved = resolvePath(world, route.path);
    const status = statusFor(route);
    const operation = {
      operationId: route.id,
      summary: route.summary,
      parameters: buildParameters(world, route.params),
      responses: buildResponses(world, route, status),
      security: UNAUTHENTICATED.has(route.id) ? [] : [{ bearerAuth: [] }],
    };
    if (route.requestSchema) {
      const schema = transformSchema(world, structuredClone(route.requestSchema));
      // Addendum O: route.requestSchema (routes.js) declares `format` as a bare `{type:
      // 'string'}` with no enum at all, since routes.js has no notion of "which kind" a convert
      // targets. Overlay the real per-kind constraint here, after the generic naming pass above,
      // so `fieldName(world, 'format')` (a no-op -- `format` has no underscore either way) has
      // already run and this doesn't have to duplicate it.
      if (route.id === 'assets.convert' && schema.properties && schema.properties.format) {
        schema.properties.format = convertFormatSchema();
      }
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema } },
      };
    }
    if (route.behaviors.includes('deprecated')) operation.deprecated = true;
    paths[resolved] = paths[resolved] || {};
    paths[resolved][route.method.toLowerCase()] = operation;
  }
  return paths;
}

function findOperations(spec) {
  const out = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      out.push({ path, method, operation });
    }
  }
  // Object key order is insertion order for string keys in V8, and paths/
  // methods are inserted in routes[] order, so this is already deterministic;
  // sort anyway so a future refactor of buildPaths can't silently change lie
  // placement for a fixed seed.
  out.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
  return out;
}

function invertCase(name) {
  if (/[A-Z]/.test(name)) {
    // camel -> snake
    return name.replace(/([A-Z])/g, (_, c) => `_${c.toLowerCase()}`);
  }
  // snake -> camel
  return name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

// A field name only makes a legible "the other case" lie if inverting its case
// actually changes it (single-word fields like `id` or `hash` look identical
// in either convention).
function invertible(field) {
  return /_/.test(field) || /[A-Z]/.test(field);
}

function lieFieldCase(world, spec) {
  const candidates = [];
  for (const { path, method, operation } of findOperations(spec)) {
    for (const status of Object.keys(operation.responses)) {
      const schema = operation.responses[status].content?.['application/json']?.schema;
      if (schema?.properties) {
        for (const field of Object.keys(schema.properties)) {
          if (invertible(field)) candidates.push({ path, method, status, field });
        }
      }
    }
  }
  if (candidates.length === 0) return null;
  const r = rng(sub(world.seed, 'trap.fieldCase'));
  const choice = pick(r, candidates);
  const schema = spec.paths[choice.path][choice.method].responses[choice.status].content['application/json'].schema;
  const lied = invertCase(choice.field);
  const value = schema.properties[choice.field];
  delete schema.properties[choice.field];
  schema.properties[lied] = value;
  if (Array.isArray(schema.required)) {
    schema.required = schema.required.map((f) => (f === choice.field ? lied : f));
  }
  return { trap: 'fieldCase', path: choice.path, detail: { method: choice.method, status: choice.status, real: choice.field, spec: lied } };
}

function lieDeleteStatus(world, spec) {
  const route = routes.find((r) => r.id === 'assets.delete');
  const path = resolvePath(world, route.path);
  const op = spec.paths[path]?.delete;
  if (!op || !op.responses['204']) return null;
  op.responses['200'] = { ...op.responses['204'], description: op.responses['204'].description };
  delete op.responses['204'];
  return { trap: 'deleteStatus', path, detail: { method: 'delete', spec: 200, real: 204 } };
}

function lieOptionalIsRequired(world, spec) {
  const candidates = [];
  for (const { path, method, operation } of findOperations(spec)) {
    const schema = operation.requestBody?.content?.['application/json']?.schema;
    if (Array.isArray(schema?.required) && schema.required.length > 0) {
      for (const field of schema.required) candidates.push({ path, method, field, where: 'requestBody' });
    }
    for (const param of operation.parameters || []) {
      if (param.required && param.in !== 'path') candidates.push({ path, method, field: param.name, where: 'parameter' });
    }
  }
  if (candidates.length === 0) return null;
  const r = rng(sub(world.seed, 'trap.optionalIsRequired'));
  const choice = pick(r, candidates);
  const op = spec.paths[choice.path][choice.method];
  if (choice.where === 'requestBody') {
    const schema = op.requestBody.content['application/json'].schema;
    schema.required = schema.required.filter((f) => f !== choice.field);
  } else {
    const param = op.parameters.find((p) => p.name === choice.field);
    param.required = false;
  }
  return { trap: 'optionalIsRequired', path: choice.path, detail: { method: choice.method, field: choice.field, real: 'required', spec: 'optional' } };
}

function lieEnumSpelling(world, spec) {
  const candidates = [];
  const visit = (schema, path, method, where) => {
    if (schema?.type === 'object' && schema.properties) {
      for (const [field, value] of Object.entries(schema.properties)) {
        if (Array.isArray(value.enum) && value.enum.some((v) => typeof v === 'string' && v.length > 1)) {
          candidates.push({ path, method, where, field });
        }
      }
    }
  };
  for (const { path, method, operation } of findOperations(spec)) {
    visit(operation.requestBody?.content?.['application/json']?.schema, path, method, 'requestBody');
    for (const status of Object.keys(operation.responses)) {
      visit(operation.responses[status].content?.['application/json']?.schema, path, method, `response:${status}`);
    }
  }
  if (candidates.length === 0) return null;
  const r = rng(sub(world.seed, 'trap.enumSpelling'));
  const choice = pick(r, candidates);
  const op = spec.paths[choice.path][choice.method];
  const schema = choice.where === 'requestBody'
    ? op.requestBody.content['application/json'].schema
    : op.responses[choice.where.split(':')[1]].content['application/json'].schema;
  const values = schema.properties[choice.field].enum;
  const stringValues = values.map((v, i) => ({ v, i })).filter((x) => typeof x.v === 'string' && x.v.length > 1);
  const target = pick(r, stringValues);
  const chars = target.v.split('');
  const at = Math.max(0, Math.min(chars.length - 2, Math.floor(r() * (chars.length - 1))));
  [chars[at], chars[at + 1]] = [chars[at + 1], chars[at]];
  const misspelled = chars.join('');
  values[target.i] = misspelled;
  return { trap: 'enumSpelling', path: choice.path, detail: { method: choice.method, field: choice.field, real: target.v, spec: misspelled } };
}

function lieWrongDefault(world, spec) {
  const candidates = [];
  for (const { path, method, operation } of findOperations(spec)) {
    for (const param of operation.parameters || []) {
      if (fieldName(world, 'page_size') === param.name && param.schema) candidates.push({ path, method, param });
    }
  }
  if (candidates.length === 0) return null;
  const trueDefault = world.pagination.pageSize;
  for (const c of candidates) c.param.schema.default = trueDefault;
  const r = rng(sub(world.seed, 'trap.wrongDefault'));
  const choice = pick(r, candidates);
  const wrong = trueDefault === 1 ? trueDefault + 1 : trueDefault - 1;
  choice.param.schema.default = wrong;
  return { trap: 'wrongDefault', path: choice.path, detail: { method: choice.method, field: choice.param.name, real: trueDefault, spec: wrong } };
}

function lieMissingRequiredHeader(world, spec) {
  const candidates = [];
  for (const { path, method, operation } of findOperations(spec)) {
    for (const param of operation.parameters || []) {
      if (param.in === 'header' && param.required) candidates.push({ path, method, header: param.name });
    }
  }
  if (candidates.length === 0) return null;
  const r = rng(sub(world.seed, 'trap.missingRequiredHeader'));
  const choice = pick(r, candidates);
  const op = spec.paths[choice.path][choice.method];
  op.parameters = op.parameters.filter((p) => !(p.in === 'header' && p.name === choice.header));
  return { trap: 'missingRequiredHeader', path: choice.path, detail: { method: choice.method, header: choice.header, real: 'required', spec: 'absent' } };
}

const LIE_FNS = {
  fieldCase: lieFieldCase,
  deleteStatus: lieDeleteStatus,
  optionalIsRequired: lieOptionalIsRequired,
  enumSpelling: lieEnumSpelling,
  wrongDefault: lieWrongDefault,
  missingRequiredHeader: lieMissingRequiredHeader,
};

function buildSpecAndLies(world) {
  const spec = {
    openapi: '3.1.0',
    info: {
      title: `${world.vocab.workspace} media API`,
      version: world.version,
      summary: 'Deterministic image, audio, and video generation over a seeded instance.',
    },
    servers: [{ url: '/' }],
    security: [{ bearerAuth: [] }],
    paths: buildPaths(world),
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      schemas: componentSchemas(),
    },
  };
  // Always annotate the true page_size default first, in path/method order, so
  // wrongDefault (if live) has a single, deterministic, already-correct value
  // to corrupt rather than one that is missing.
  const pageSizeCandidates = [];
  for (const { operation } of findOperations(spec)) {
    for (const param of operation.parameters || []) {
      if (param.name === fieldName(world, 'page_size')) pageSizeCandidates.push(param);
    }
  }
  for (const param of pageSizeCandidates) param.schema.default = world.pagination.pageSize;

  const lies = [];
  for (const trap of world.traps.live) {
    const fn = LIE_FNS[trap];
    const lie = fn ? fn(world, spec) : null;
    if (lie) lies.push(lie);
  }
  lies.sort((a, b) => a.trap.localeCompare(b.trap));
  return { spec, lies };
}

// toOpenApi(world) -> a full OpenAPI 3.1 document. Deterministic per seed.
export function toOpenApi(world) {
  return buildSpecAndLies(world).spec;
}

// listLies(world) -> [{trap, path, detail}], the ground truth of every lie
// toOpenApi applied, for the harness to score Trap against. Never shipped to
// the agent; the agent only ever sees toOpenApi's output.
export function listLies(world) {
  return buildSpecAndLies(world).lies;
}
