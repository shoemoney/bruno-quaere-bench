# Bruno QUAERE architecture

Read this before touching any file. It is the contract between modules. The spec it implements is
`docs/SPEC.md` (copied from the ideas workspace). When this document and your instinct disagree,
this document wins; if it is wrong, fix it here first, then the code.

## What is measured

Three axes, and every design choice serves one of them:

1. **Advanced reasoning.** Quant operations (units, color, timeline, compounding) and
   interpreting a long skill file that overrides spec defaults.
2. **API calling.** Sixteen HTTP behaviors a competent consumer handles, plus exact parameter
   fidelity on deep JSON.
3. **Long session.** A hundred rungs under a 3 million token budget with one agent and no
   subagents. The ladder is longer than any context window on purpose.

The judge is `bru run` plus hash equality. No AI ever grades. Media is deterministic so that holds.

## Ground rules for code

- ESM, Node 22+, **zero runtime dependencies**. `node:crypto`, `node:zlib`, `node:http`,
  `node:fs`, `node:child_process`, `fetch`. If you think you need a package, you do not.
- Determinism everywhere. Same seed and version, same bytes. No `Date.now()` or `Math.random()`
  in anything that feeds an artifact, a spec, a skill, or a rung. Wall clock is allowed only in
  the HTTP layer for token TTL, rate windows, timestamps on responses, and in the harness.
- Every module exports pure functions over plain objects unless it is the HTTP server or the
  harness. Tests are `node:test`, in `test/`, one file per module, run with `npm test`.
- Small files. One concern per file. No classes unless state genuinely needs one (the server).
- Errors in the API are RFC 9457 `application/problem+json`. Never a bare string body.

## Module map and ownership

```
src/
  seed.js          PRNG and sub-seeding                       [core]
  canon.js         canonical JSON, sha256, descriptor hashing [core]
  world.js         seed -> World (vocabulary, rules, traps)   [core]
  routes.js        the route table, pure data                 [core]
  render/
    image.js       shapes -> SVG text, and -> PNG bytes       [core]
    audio.js       notes -> WAV bytes, and -> QA8 bytes       [core]
    video.js       timeline -> QVID bytes                     [core]
  media.js         create/convert/combine/diff/lora on descriptors [core]
  api/
    server.js      createServer({world, ports}) -> {start, stop, log} [api]
    router.js      tiny method+path matcher with params       [api]
    auth.js        api key -> bearer token, TTL, refresh      [api]
    behaviors.js   etag, idempotency, rate limit, negotiation, hmac, redirects [api]
    resources.js   in-memory store: workspaces, projects, assets, jobs, loras [api]
    problem.js     problem+json helpers                       [api]
    admin.js       admin port handlers                        [api]
  spec.js          World -> OpenAPI 3.1 JSON, with lies applied [spec]
  skill.js         World -> SKILL.md text                     [spec]
  ladder/
    grammar.js     difficulty bands and primitive composition [ladder]
    rung.js        (world, n) -> Rung                         [ladder]
    reference.js   executes a Rung's plan over HTTP, returns expected hashes [ladder]
  harness/
    sandbox.js     a directory where the only binary on PATH is bru [harness]
    drivers/
      anthropic.js Messages API driver with one tool: bru    [harness]
      openai.js    Chat Completions driver with one tool: bru [harness]
    run.js         one model, one seed, one climb -> RunResult [harness]
    score.js       RunResult[] -> Rung/Turns/Fidelity/Trap     [harness]
    board.js       runs/ -> board.md                          [harness]
bin/quaere.js      CLI: serve, spec, skill, rung, reference, run, board
collections/behaviors/   OpenCollection YAML proving all 16 behaviors with bru run [collection]
test/              node:test, one file per src module
docs/              this file, SPEC.md, and generated examples
Dockerfile         node:22-alpine, SEED env, ports 8080 and 8081
```

Ownership tags are the workstreams. A workstream touches only its own files plus its tests.

## Core types (plain objects, documented here, no runtime type system)

```js
// seed.js
rng(seed: number): () => number            // mulberry32, uniform [0,1)
sub(seed: number, label: string): number   // stable sub-seed = fnv1a(seed + ':' + label)
pick(r, array), int(r, lo, hi), shuffle(r, array), chance(r, p)

// canon.js
canonical(value): string                   // JSON with sorted keys, no whitespace, numbers as shortest round-trip
sha256(bytes | string): string             // hex
hashArtifact(bytes: Uint8Array): string    // sha256 of bytes, the only thing the judge compares

// world.js
World = {
  seed, version: '0.1.0',
  vocab: { workspace, project, asset, library },   // e.g. 'studio','scene','clip','library' (nouns used in paths and spec)
  ids: { style: 'uuid'|'ulid'|'prefixed'|'int', prefixes: {workspace,project,asset,job,lora} },
  naming: 'snake'|'camel',                         // field convention for the API
  namingExceptions: string[],                       // fields that break the convention (seeded, 1 to 3)
  rules: {
    dpi: number,                 // 72 | 96 | 150 | 300
    roundTo: number,             // 1 | 2 | 4 | 8 | 16 px
    roundMode: 'nearest'|'up'|'down',
    unitWords: { inch: string[], cm: string[], pt: string[] },  // synonyms the skill defines
    opacityCompound: 'additive'|'multiplicative',
    defaultFormat: { image: 'svg'|'png', audio: 'wav'|'qa8', video: 'qvid' },
    defaultSampleRate: 22050|44100|48000,
    defaultFps: 12|24|30,
    zOrder: 'listOrder'|'explicit',
    colorShiftSpace: 'hsl'|'hsv',
    bitrateBudgetUnit: 'KB'|'MB',
  },
  auth: { apiKey: string, secret: string, tokenTtlSec: number /* 90..600 */, refreshPath: string },
  rate: { limit: number /* 20..60 */, windowSec: 10 },
  pagination: { pageSize: number /* 5..25 */, cursorStyle: 'b64json'|'b64id'|'opaque' },
  traps: { live: TrapName[] },                      // >= 2 of the catalog below, seeded
  deprecated: { [oldPath]: newPath },               // >= 1
  loras: [{ id, name, op: 'hueShift'|'scale'|'opacity'|'invert', amount }],   // 6 to 12, names are human ("Jenny", "Moss")
  hmac: { header: 'X-Signature', tsHeader: 'X-Timestamp', algo: 'sha256', canon: 'ts+method+path' },
}
TrapName = 'fieldCase' | 'deleteStatus' | 'optionalIsRequired' | 'enumSpelling' | 'wrongDefault' | 'missingRequiredHeader'
makeWorld(seed): World      // fully deterministic

// routes.js
routes: Route[] where Route = { id, method, path, summary, params, requestSchema?, responseSchema?, behaviors: string[], inSpec: boolean }
// paths use world.vocab nouns via placeholders: '/{workspaces}/{id}/{projects}' and are resolved by resolvePath(world, path)
```

### Media model

All media are structured lists of primitives on a canvas. That makes combine and diff exact set
operations and keeps every artifact a pure function of its descriptor.

```js
ImageDescriptor = {
  kind: 'image', format: 'svg'|'png',
  width: int, height: int,                 // pixels, after DPI and rounding rules
  background: { color: hex } | { transparent: true },
  shapes: Shape[],                         // z-order = list order unless rules.zOrder === 'explicit' (then Shape.z)
  lora?: { id, applied: true },
}
Shape = { type: 'rect'|'circle'|'line', x, y, w?, h?, r?, x2?, y2?, color: hex, opacity: 0..1, z?: int }

AudioDescriptor = {
  kind: 'audio', format: 'wav'|'qa8',
  sampleRate: int, durationMs: int,
  notes: Note[],
}
Note = { freq: number, startMs: int, durMs: int, amp: 0..1, wave: 'sine'|'square'|'saw'|'triangle' }

VideoDescriptor = {
  kind: 'video', format: 'qvid',
  width, height, fps: int, durationMs: int,
  clips: Clip[],                            // each clip is an image asset shown from startMs for durMs, with a transform
  audio?: { assetId },
}
Clip = { assetId, startMs, durMs, opacity: 0..1, z?: int }
```

Renderers are total functions of the descriptor:

- `render/image.js`: `toSvg(desc) -> string` and `toPng(desc) -> Uint8Array`. PNG is a real PNG
  (IHDR, IDAT via `zlib.deflateSync`, IEND, CRC32) rasterized at a fixed scale so the long side is
  at most 256 px; true dimensions live in the descriptor and in a tEXt chunk. Rasterization is
  integer, nearest-neighbor, shapes painted in z-order with source-over alpha. No antialiasing.
- `render/audio.js`: `toWav(desc) -> Uint8Array` 16-bit PCM mono, notes mixed additively then
  clipped; `toQa8(desc)` 8-bit unsigned PCM with a 16-byte header `QA8\0` + sampleRate + length.
  Sample math uses integer sample indexes and `Math.sin` on doubles; that is deterministic on one
  platform, and the test suite pins hashes for a fixed set of descriptors.
- `render/video.js`: `toQvid(desc, resolveAsset) -> Uint8Array`, a container: 8-byte magic
  `QVID\0\0\0\1`, then canonical JSON header, then each referenced image's SVG bytes in clip order.
  No per-frame rasterization; fps and duration are header fields that conversion changes.

`media.js` operations (all pure, descriptor in, descriptor out, never bytes):

```js
create(world, kind, params)                  // validates against rules, applies DPI/rounding/defaults, returns descriptor
convert(world, desc, {format?, width?, height?, sampleRate?, fps?})   // format or resample; scaling shapes/notes proportionally
combine(world, [descA, descB, ...], {mode: 'layer'|'mix'|'sequence', opacityRule?})  // union with z-order and compounding per world.rules
diff(world, descA, descB)                    // primitives in A not in B (by canonical identity), same canvas as A
applyLora(world, desc, lora)                 // deterministic transform per lora.op and amount
fidelity(expected, actual)                   // share of leaf params equal, 0..1, walking both descriptors
```

`hash(desc)` = `hashArtifact(renderBytes(desc))`. The API stores both.

## API surface

Two `node:http` servers from one `createServer({world, publicPort, adminPort})`.

Public routes (paths shown with default vocab; the real nouns come from `world.vocab`):

| Method | Path | Behaviors |
|---|---|---|
| POST | /auth/token | apiKey in body -> bearer, expiresIn |
| POST | /auth/refresh | refresh token -> new bearer (world.auth.refreshPath is this) |
| GET | /workspaces | cursor pagination, rate limit |
| GET | /workspaces/{w} | includes `links` block with the lora library URL (link-only discovery) |
| GET, POST | /workspaces/{w}/projects | pagination; POST needs Idempotency-Key semantics |
| GET | /workspaces/{w}/projects/{p} | state machine status, ETag |
| POST | /workspaces/{w}/projects/{p}/compose | 409 unless status draft |
| POST | /workspaces/{w}/projects/{p}/render | 202 + Location: /jobs/{id}; 409 unless composed |
| POST | /workspaces/{w}/projects/{p}/publish | HMAC required (X-Timestamp + X-Signature); 409 unless rendered |
| GET | /workspaces/{w}/projects/{p}/assets | pagination, Accept json or text/csv, soft-delete filter `include_deleted` |
| POST | /images, /audio, /video | create; Idempotency-Key; returns asset with descriptor, hash, etag |
| GET | /assets/{id} | ETag + If-None-Match 304 |
| PATCH | /assets/{id} | If-Match required, 412 on mismatch; metadata only |
| DELETE | /assets/{id} | soft delete; 204 (or 200 if trap deleteStatus flips the spec, not the API) |
| GET | /assets/{id}/content | bytes, Content-Type by format |
| POST | /assets/{id}/convert | -> new asset |
| POST | /assets/combine | body {ids, mode, ...} -> new asset |
| POST | /assets/diff | body {a, b} -> new asset |
| GET | /loras | NOT in spec, reachable via links; supports ?name= |
| POST | /assets/{id}/lora | body {loraId} -> new asset |
| GET | /jobs/{id} | status queued -> running -> done, advances on each poll (deterministic, 3 polls) |
| GET | /v1/pictures | 301 -> /images (in spec as the old path) |
| GET | /rungs/current | the current rung's plain-language task text and its number |
| POST | /rungs/{n}/submit | body {assets: [ids]} -> {pass, rung} ; one submission per rung |

Every error is problem+json. 422 carries `errors: [{field, message}]`. 429 carries Retry-After.

Admin routes (adminPort, loopback only):

| Method | Path | Purpose |
|---|---|---|
| POST | /admin/mutate | {name} from the mutation list; applies until reset |
| POST | /admin/reset | clear mutations, state, log; keep world |
| GET | /admin/log | every public request: method, path, status, ms, tokenId |
| POST | /admin/rungs | {rungs: [{n, text, expected: [hashes], expectedDescriptors}]} sets the answer key |
| POST | /admin/rungs/advance | move current rung to n+1 |
| GET | /admin/submissions | every submit with pass/fail, hashes, and fidelity |
| GET | /admin/world | the World object |

Mutation names (from the Arena spec): `statusCode`, `dropField`, `renameField`, `retypeField`,
`rejectAuth`, `stuckCursor`.

## Spec and skill generation

`spec.js`: `toOpenApi(world) -> object`. Walks `routes.js`, resolves vocab, emits schemas that
follow `world.naming`, then applies each live trap as a deliberate lie:

- `fieldCase`: spec shows the other case for one field in one response schema
- `deleteStatus`: spec says 200 on DELETE, API returns 204
- `optionalIsRequired`: spec marks a required field optional
- `enumSpelling`: one enum value misspelled in the spec
- `wrongDefault`: a default in the spec differs from the API's real default
- `missingRequiredHeader`: a required header omitted from one operation

`skill.js`: `toSkill(world) -> string`, markdown, 200 to 400 lines, real-shaped. Sections: house
units and DPI, rounding rule, naming, auth and refresh cadence, pagination rule, the lora library
and how to find it, publish signing, project state machine, opacity compounding, default formats,
and three explicit "the spec says X, we do Y" overrides that match the live traps without naming
them as traps.

## Ladder

`grammar.js` defines bands:

| Rungs | Steps | Params per step | Skill lookups | Quant ops | Behaviors in play |
|---|---|---|---|---|---|
| 0-9 | 1 | 3-6 | 0-1 | 0-1 | auth, create |
| 10-19 | 2 | 6-10 | 1-2 | 1-2 | + convert, idempotency |
| 20-29 | 3 | 8-12 | 2 | 2 | + combine, lora lookup |
| 30-39 | 3-4 | 10-14 | 2-3 | 2-3 | + diff, etag |
| 40-49 | 4-5 | 12-16 | 3 | 3 | + pagination batch, rate limit |
| 50-59 | 5 | 14-18 | 3-4 | 3-4 | + async render, state machine |
| 60-69 | 5-6 | 16-20 | 4 | 4 | + token expiry mid-chain, hmac publish |
| 70-79 | 6-7 | 18-22 | 4-5 | 5 | + content negotiation, soft delete |
| 80-89 | 7-8 | 20-24 | 5 | 5-6 | + a live trap must be caught to pass |
| 90-99 | 8-10 | 22-28 | 5-6 | 6-7 | everything, three rounding rules in order |

`rung.js`: `makeRung(world, n) -> Rung`:

```js
Rung = {
  n,
  text: string,                 // plain language, uses unit words and lora names, never API field names
  plan: Step[],                 // the reference's plan; the agent never sees this
  expectedDescriptors: Descriptor[],   // computed purely via media.js, no HTTP
  submitCount: int,             // how many asset ids the agent must submit
}
Step = { op: 'create'|'convert'|'combine'|'diff'|'lora'|'batch'|'compute'|'render'|'publish', args, resultKey }
```

`reference.js`: `climb(world, baseUrl, apiKey, rungs) -> {passed: n[], failed: n[]}` executes each
plan over HTTP (plain `fetch`, the harness is allowed) and asserts the API's hash equals
`hash(expectedDescriptor)`. This is the gate: **a rung the reference cannot pass is a generator
bug**. `npm test` runs the reference over rungs 0-99 for seeds 1, 2, 3 against an in-process server.

## Harness

`sandbox.js`: creates `runs/<model>/<seed>/<attempt>/sandbox/` with `bin/bru` symlinked to the
real `bru`, and executes commands with `PATH=<sandbox>/bin` and `cwd=<sandbox>`. Rejects any
command that is not `bru ...`. Captures stdout, stderr, exit code, duration.

Drivers expose one interface:

```js
driver({model, apiKey, baseUrl?}) -> { step(messages, tools) -> {assistant, toolCalls, usage} }
```

with exactly one tool, `bru`, taking `{args: string}`. The system prompt is fixed text in
`harness/prompt.md`: the one rule, the base URL, the api key, where the spec and skill are on
disk, how to fetch the current rung, how to submit, and "do not use subagents; you are the only
agent." Both drivers count input and output tokens from the provider's usage fields.

`run.js`: `climb({driver, world, seed, attempt, budgetTokens: 3_000_000})`:

1. Start a server pair on free ports, POST the answer key for all 100 rungs to admin.
2. Write spec.json and SKILL.md into the sandbox.
3. Loop: agent turns until it submits; on pass advance the rung; on fail or budget exhausted stop.
4. Record `transcript.jsonl` (every message and every bru invocation), `result.json`
   (RunResult), and copy the collection the agent left behind.

```js
RunResult = { model, modelVersion, seed, attempt, rung, turns, tokensIn, tokensOut, wallMs,
              fidelity, trap, submissions: [...], stoppedBecause: 'fail'|'budget'|'error'|'top' }
```

`score.js` reduces three RunResults to the board row (median rung, turns at that rung, mean
fidelity, trap). `board.js` writes `board.md` sorted by Rung then Turns.

## CLI

```
quaere serve      --seed 42 [--port 8080 --admin-port 8081]
quaere spec       --seed 42 > spec.json
quaere skill      --seed 42 > SKILL.md
quaere rung       --seed 42 --n 37            # prints the task text and, with --answer, the plan and descriptors
quaere reference  --seed 42 [--from 0 --to 99]  # starts a server, climbs, reports
quaere run        --driver anthropic --model claude-sonnet-5 --seed 42 --attempts 3
quaere board      runs/ > board.md
```

## Definition of done for the night

1. `npm test` green, including the reference climbing 0-99 on seeds 1, 2, 3.
2. `bru run collections/behaviors --env local` green against `quaere serve --seed 1`, one request
   per behavior, each with tests that would fail if the behavior broke.
3. `quaere reference --seed 7` passes 100/100 from the CLI.
4. `docker build` succeeds and the container answers `/auth/token`.
5. A single attempt of `quaere run` completes against a real model with a real transcript, even
   if it falls at rung 3. The run is not scored tonight; it proves the loop.
6. README.md written per the house style, with the one-rule, the axes, the CLI, and the board.
