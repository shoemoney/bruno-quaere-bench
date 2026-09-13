import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { toSkill } from '../src/skill.js';
import { listLies } from '../src/spec.js';
import { makeWorld, resolvePath, fieldName } from '../src/world.js';
import { routes } from '../src/routes.js';
import { create } from '../src/media.js';
import { createServer } from '../src/api/server.js';

const SEEDS = [1, 2, 3, 4, 5, 42, 7, 99];

test('toSkill produces frontmatter with a name and a description', () => {
  for (const seed of SEEDS) {
    const md = toSkill(makeWorld(seed));
    const lines = md.split('\n');
    assert.equal(lines[0], '---', `seed ${seed}`);
    const closeIdx = lines.indexOf('---', 1);
    assert.ok(closeIdx > 1, `seed ${seed}: no closing frontmatter fence`);
    const frontmatter = lines.slice(1, closeIdx).join('\n');
    assert.match(frontmatter, /^name:\s*\S+/m, `seed ${seed}`);
    assert.match(frontmatter, /^description:\s*\S+/m, `seed ${seed}`);
  }
});

test('toSkill is 200 to 400 lines', () => {
  for (const seed of SEEDS) {
    const md = toSkill(makeWorld(seed));
    const n = md.split('\n').length;
    assert.ok(n >= 200 && n <= 400, `seed ${seed}: ${n} lines`);
  }
});

test('toSkill is deterministic: repeated calls, and repeated makeWorld, agree', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    assert.equal(toSkill(world), toSkill(world), `seed ${seed}`);
    assert.equal(toSkill(world), toSkill(makeWorld(seed)), `seed ${seed}`);
  }
});

test('every documented section a real Bruno skill needs is present', () => {
  const REQUIRED_HEADINGS = [
    'house dpi and rounding',
    'unit words',
    'naming convention',
    'auth lifecycle',
    'pagination',
    'finding the lora library',
    'publish signing',
    'project state machine',
    'opacity compounding',
    'defaults',
    'video container facts',
    'cleared-out assets',
    'amendments',
    'negative-space grading',
    'byte budgets',
    'overrides',
  ];
  for (const seed of SEEDS) {
    const md = toSkill(makeWorld(seed)).toLowerCase();
    for (const heading of REQUIRED_HEADINGS) {
      assert.ok(md.includes(`## ${heading}`), `seed ${seed}: missing heading "${heading}"`);
    }
  }
});

test('the solo-agent rule and the task loop (rungs/current, rungs/{n}/submit) are stated', () => {
  for (const seed of SEEDS) {
    const md = toSkill(makeWorld(seed));
    assert.match(md, /one agent|alone/i, `seed ${seed}: no solo-agent statement`);
    assert.match(md, /subagent/i, `seed ${seed}: no no-delegation statement`);
    assert.ok(md.includes('/rungs/current'), `seed ${seed}`);
    assert.ok(md.includes('/rungs/{n}/submit'), `seed ${seed}`);
  }
});

test('an OpenCollection YAML example and an environment file example are both present', () => {
  for (const seed of SEEDS) {
    const md = toSkill(makeWorld(seed));
    assert.ok(md.includes('```yaml'), `seed ${seed}: no yaml request example`);
    assert.match(md, /vars\s*\{/, `seed ${seed}: no environment file example`);
  }
});

test('never uses the word "trap"', () => {
  for (const seed of SEEDS) {
    const md = toSkill(makeWorld(seed));
    assert.doesNotMatch(md, /trap/i, `seed ${seed}`);
  }
});

test('contains exactly three "the reference says X" override statements, corresponding to listLies', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const md = toSkill(world);
    const overridesHeadingIdx = md.indexOf('## Overrides');
    assert.ok(overridesHeadingIdx >= 0, `seed ${seed}`);
    const nextHeadingIdx = md.indexOf('\n## ', overridesHeadingIdx + 1);
    const section = md.slice(overridesHeadingIdx, nextHeadingIdx === -1 ? undefined : nextHeadingIdx);
    const bulletCount = (section.match(/^- /gm) || []).length;
    assert.equal(bulletCount, 3, `seed ${seed}: expected 3 override bullets, section was:\n${section}`);
    const lies = listLies(world).slice(0, 3);
    for (const lie of lies) {
      if (lie.trap === 'fieldCase') assert.ok(section.includes(lie.detail.spec) && section.includes(lie.detail.real), seed);
      if (lie.trap === 'enumSpelling') assert.ok(section.includes(lie.detail.spec) && section.includes(lie.detail.real), seed);
      if (lie.trap === 'missingRequiredHeader') assert.ok(section.includes(lie.detail.header), seed);
      if (lie.trap === 'optionalIsRequired') assert.ok(section.includes(lie.detail.field), seed);
      if (lie.trap === 'wrongDefault') assert.ok(section.includes(String(lie.detail.spec)) && section.includes(String(lie.detail.real)), seed);
      if (lie.trap === 'deleteStatus') assert.ok(section.includes(String(lie.detail.spec)) && section.includes(String(lie.detail.real)), seed);
    }
  }
});

test('every rule value from the world appears literally in the document', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const md = toSkill(world);
    const literal = [
      String(world.rules.dpi),
      String(world.rules.roundTo),
      world.rules.roundMode,
      world.naming,
      String(world.auth.tokenTtlSec),
      world.auth.refreshPath,
      String(world.pagination.pageSize),
      world.pagination.cursorStyle,
      world.rules.opacityCompound,
      world.rules.defaultFormat.image,
      world.rules.defaultFormat.audio,
      world.rules.defaultFormat.video,
      String(world.rules.defaultSampleRate),
      String(world.rules.defaultFps),
      world.rules.zOrder,
      world.rules.bitrateBudgetUnit,
      world.hmac.header,
      world.hmac.tsHeader,
      world.hmac.canon,
      world.vocab.workspace,
    ];
    for (const value of literal) {
      assert.ok(md.includes(value), `seed ${seed}: missing literal "${value}"`);
    }
    assert.ok(md.toLowerCase().includes(world.rules.colorShiftSpace.toLowerCase()), `seed ${seed}: missing colorShiftSpace`);
    for (const lora of world.loras) {
      assert.ok(md.includes(lora.name), `seed ${seed}: missing lora name ${lora.name}`);
    }
    for (const exception of world.namingExceptions) {
      // The skill must print the WIRE spelling (fieldName flips an exception to the opposite
      // convention), not the canonical snake_case key -- that key is the one spelling the API
      // never sends for these fields.
      const wire = fieldName(world, exception);
      assert.ok(md.includes(wire), `seed ${seed}: missing naming exception ${wire}`);
    }
    for (const words of Object.values(world.rules.unitWords)) {
      for (const w of words) {
        assert.ok(md.includes(w), `seed ${seed}: missing unit word "${w}"`);
      }
    }
  }
});

test('the lora library section never hardcodes a path, and points at the links block instead', () => {
  for (const seed of SEEDS) {
    const md = toSkill(makeWorld(seed));
    const idx = md.indexOf('## Finding the lora library');
    const end = md.indexOf('\n## ', idx + 1);
    const section = md.slice(idx, end);
    assert.match(section, /links/i, `seed ${seed}`);
  }
});

// ---------------------------------------------------------------------------
// The tests above prove values are PRESENT somewhere in the document. These prove they are
// stated in the right place and are actually TRUE -- by parsing the numbers back out of the
// prose and running the real API and the real media pipeline with them. A whole-document
// `includes()` cannot fail for a value like roundTo === 1, and would not notice a worked
// example that contradicts the rule sitting three lines above it.
// ---------------------------------------------------------------------------

// The body of `## <heading>`, up to the next h2. Scoping every assertion to its own section is
// what stops a number borrowed from an unrelated table from satisfying it.
function section(md, heading) {
  const start = md.indexOf(`## ${heading}`);
  assert.ok(start >= 0, `no section "${heading}"`);
  const end = md.indexOf('\n## ', start + 1);
  return md.slice(start, end === -1 ? undefined : end);
}

function only(re, text, label) {
  const matches = [...text.matchAll(re)];
  assert.equal(matches.length, 1, `expected exactly one ${label}, found ${matches.length}`);
  return matches[0];
}

test('the rounding rule is stated in its own section, and its worked example obeys it', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const sec = section(toSkill(world), 'House DPI and rounding');

    const stated = only(/The house DPI is \*\*(\d+)\*\*/g, sec, 'DPI statement');
    assert.equal(Number(stated[1]), world.rules.dpi, `seed ${seed}: stated DPI`);

    const rule = only(
      /rounded \*\*(nearest|up|down)\*\* to the nearest\s+multiple of \*\*(\d+)px\*\*/g,
      sec,
      'rounding rule',
    );
    assert.equal(rule[1], world.rules.roundMode, `seed ${seed}: stated round mode`);
    assert.equal(Number(rule[2]), world.rules.roundTo, `seed ${seed}: stated round step`);

    // the worked example, re-derived through the real media pipeline
    const ex = only(
      /A ([\d.]+)-inch dimension at (\d+) DPI is ([\d.]+)px raw\. Rounded (nearest|up|down) to the nearest multiple of (\d+)px, that becomes \*\*(\d+)px\*\*/g,
      sec,
      'worked example',
    );
    const [, inches, exDpi, rawPx, exMode, exStep, exResult] = ex;
    assert.equal(Number(exDpi), world.rules.dpi, `seed ${seed}: example DPI must be the house DPI`);
    assert.equal(exMode, world.rules.roundMode, `seed ${seed}: example mode must be the house mode`);
    assert.equal(Number(exStep), world.rules.roundTo, `seed ${seed}: example step must be the house step`);
    assert.equal(Number(rawPx), Number(inches) * world.rules.dpi, `seed ${seed}: raw px arithmetic`);

    // create() is the thing the agent will actually call; the document's answer must equal its answer
    const made = create(world, 'image', {
      width: Number(inches),
      height: Number(inches),
      unit: 'in',
      background: { color: '#000000' },
      shapes: [],
    });
    assert.equal(
      made.width,
      Number(exResult),
      `seed ${seed}: the document says ${inches}in becomes ${exResult}px, create() produced ${made.width}px`,
    );

    // and the example must be worth printing: with a real grid it has to actually move the value
    if (world.rules.roundTo > 1) {
      assert.notEqual(
        Number(rawPx) % world.rules.roundTo,
        0,
        `seed ${seed}: the worked example starts on the grid, so it demonstrates nothing about rounding`,
      );
    }
  }
});

test('the pagination, auth and naming sections each state their own value, not a neighbour\'s', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const md = toSkill(world);

    const page = section(md, 'Pagination');
    const size = only(/\*\*(\d+)\*\* items per page/g, page, 'page size');
    assert.equal(Number(size[1]), world.pagination.pageSize, `seed ${seed}: page size`);
    const style = only(/a `(b64json|b64id|opaque)`\s*\n?\s*cursor/g, page, 'cursor style');
    assert.equal(style[1], world.pagination.cursorStyle, `seed ${seed}: cursor style`);
    // the rule that actually trips clients: absence of the cursor, not an empty page
    assert.match(page, /cursor field being absent/i, `seed ${seed}`);

    const auth = section(md, 'Auth lifecycle');
    const ttl = only(/valid for\s*\n?\*\*(\d+) seconds\*\*/g, auth, 'token TTL');
    assert.equal(Number(ttl[1]), world.auth.tokenTtlSec, `seed ${seed}: token TTL`);
    assert.ok(auth.includes(world.auth.refreshPath), `seed ${seed}: refresh path`);
    // the secret must never be written down
    assert.ok(!md.includes(world.auth.apiKey), `seed ${seed}: the skill leaks the api key`);
    assert.ok(!md.includes(world.auth.secret), `seed ${seed}: the skill leaks the hmac secret`);

    const naming = section(md, 'Naming convention');
    const conv = only(/Body fields follow \*\*(snake_case|camelCase)\*\* house-wide/g, naming, 'naming convention');
    assert.equal(
      conv[1],
      world.naming === 'snake' ? 'snake_case' : 'camelCase',
      `seed ${seed}: naming convention`,
    );
    for (const exception of world.namingExceptions) {
      const wire = fieldName(world, exception);
      assert.ok(naming.includes(wire), `seed ${seed}: exception ${wire} outside its section`);
    }
  }
});

test('the signing recipe is self-consistent, and signing by it actually publishes', async (t) => {
  for (const seed of SEEDS.slice(0, 3)) {
    const world = makeWorld(seed);
    const sec = section(toSkill(world), 'Publish signing');

    // the example string the document tells the agent to copy. The section carries two fenced
    // blocks -- the canonical string, then the HMAC formula -- so take the one that is the
    // canonical string and assert there are exactly the two we expect.
    const fences = [...sec.matchAll(/```\n([^\n]+)\n```/g)].map((m) => m[1]);
    assert.equal(fences.length, 2, `seed ${seed}: expected the canonical string and the HMAC formula`);
    assert.match(fences[1], /^signature = hex\(/, `seed ${seed}: second fence must be the formula`);
    const example = fences[0];
    const exampleTs = only(/at timestamp (\d+)/g, sec, 'example timestamp')[1];

    assert.ok(example.startsWith(exampleTs), `seed ${seed}: example must start with the timestamp`);
    const afterTs = example.slice(exampleTs.length);
    assert.ok(afterTs.startsWith('POST'), `seed ${seed}: method must follow the timestamp directly`);
    const examplePath = afterTs.slice('POST'.length);
    assert.ok(examplePath.startsWith('/'), `seed ${seed}: the path must follow the method directly`);
    // the whole point: `ts+method+path` names the parts, it is not the separator
    assert.equal(
      example,
      `${exampleTs}POST${examplePath}`,
      `seed ${seed}: the example is not a bare concatenation`,
    );
    assert.ok(!example.includes('+'), `seed ${seed}: the example still carries literal plus signs`);
    assert.ok(sec.includes(world.hmac.header) && sec.includes(world.hmac.tsHeader), `seed ${seed}: headers`);

    // now do it for real: an agent that follows this section must get a 200 out of publish
    const server = createServer({ world, publicPort: 0, adminPort: 0 });
    const ports = await server.start();
    const base = `http://127.0.0.1:${ports.publicPort}`;
    t.after(() => server.stop());

    const f = (n) => fieldName(world, n);
    const tmpl = (id) => resolvePath(world, routes.find((r) => r.id === id).path);
    const fill = (s, p) => Object.entries(p).reduce((acc, [k, v]) => acc.replace(`{${k}}`, encodeURIComponent(v)), s);
    const call = async (method, path, { body, headers = {}, token } = {}) => {
      const h = { ...headers };
      if (token) h.authorization = `Bearer ${token}`;
      if (body !== undefined) h['content-type'] = 'application/json';
      const res = await fetch(base + path, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const mint = async () =>
      (await call('POST', '/auth/token', { body: { [f('api_key')]: world.auth.apiKey } })).body[f('access_token')];

    const wsId = (await call('GET', tmpl('workspaces.list'), { token: await mint() })).body.data[0].id;
    const created = await call('POST', fill(tmpl('projects.create'), { workspace_id: wsId }), {
      token: await mint(),
      body: { name: 'signing probe' },
    });
    const params = { workspace_id: wsId, project_id: created.body.id };
    await call('POST', fill(tmpl('projects.compose'), params), { token: await mint(), body: {} });
    await call('POST', fill(tmpl('projects.render'), params), { token: await mint(), body: {} });

    const publishPath = fill(tmpl('projects.publish'), params);
    const ts = String(Math.floor(Date.now() / 1000));

    // the WRONG recipe -- the one the old example printed -- must be rejected
    const plussed = createHmac(world.hmac.algo, world.auth.secret)
      .update(`${ts}+POST+${publishPath}`)
      .digest('hex');
    const rejected = await call('POST', publishPath, {
      token: await mint(),
      body: {},
      headers: { [world.hmac.tsHeader]: ts, [world.hmac.header]: plussed },
    });
    assert.equal(rejected.status, 401, `seed ${seed}: the plus-separated string must NOT verify`);

    // the recipe as written must be accepted
    const signed = createHmac(world.hmac.algo, world.auth.secret).update(`${ts}POST${publishPath}`).digest('hex');
    const accepted = await call('POST', publishPath, {
      token: await mint(),
      body: {},
      headers: { [world.hmac.tsHeader]: ts, [world.hmac.header]: signed },
    });
    assert.equal(accepted.status, 200, `seed ${seed}: signing as the skill describes must publish`);
    assert.equal(accepted.body.status, 'published', `seed ${seed}`);
  }
});

test('lora names in the document are exactly the ones the world defines, and no others', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const sec = section(toSkill(world), 'Finding the lora library');
    const listed = only(/names in this instance\s*\n?include ([^.]+)\./g, sec, 'lora name list')[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const real = new Set(world.loras.map((l) => l.name));
    for (const name of listed) {
      assert.ok(real.has(name), `seed ${seed}: "${name}" is named in the skill but is not a lora in this world`);
    }
    assert.equal(new Set(listed).size, listed.length, `seed ${seed}: duplicate lora names listed`);
  }
});
