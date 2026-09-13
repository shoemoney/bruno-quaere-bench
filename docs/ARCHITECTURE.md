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
  seed, version: '0.3.0',
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

Three columns are inputs the composers read (`params`, `kinds`, `features`); `steps`, `lookups`
and `quant` are the measured envelope of what those inputs produce. `params` is a budget of
*stated leaves* -- the numbers, colours and words the rung text spells out and the agent has to
transcribe without drift: a canvas costs 3, a shape or a tone costs 5, a batch item costs 6.
`features` maps an obligation to the first offset **inside** the band at which it switches on, so
a band is a ramp rather than a flat shelf.

Values below are the Addendum C round-2 steepening (world version 0.2.0). Round 1's numbers are in
the git history; a 0.1.x result is not comparable to a 0.2.x one.

| Rungs | Steps | Stated leaves | Skill/API lookups | Quant ops | Kinds | Behaviors in play |
|---|---|---|---|---|---|---|
| 0-9 | 1 | 13-18 | 0-1 | 0-1 | picture or sound | auth, create |
| 10-19 | 3-4 | 18-23 | 1-3 | 1-3 | mostly picture | + convert, idempotency, lora lookup; 15+: percent resize, live trap |
| 20-29 | 4-5 | 23-28 | 2-4 | 2 | picture | + live trap, rounding order 2; 25+: a second lora |
| 30-39 | 5-6 | 28-33 | 2-4 | 3 | picture | + diff, etag, live trap; 35+: a lora on the leftover |
| 40-49 | 5-6 | 30-36 | 3-5 | 1 | picture | + pagination batch (page 3 < subset 5-6), rate limit, live trap; 45+: a second lora |
| 50-59 | 6-7 | 33-38 | 3-4 | 3-4 | picture | + async render, state machine, post-render rounding chain; 55+: a save |
| 60-69 | 8 | 36-41 | 4 | 4 | picture | + token expiry mid-chain, hmac publish, post-publish rounding chain |
| 70-79 | 8 | 38-44 | 5 | 2 | picture | + content negotiation, soft delete, live trap, page 2 < subset 6-7 |
| 80-89 | 9 | 41-47 | 6 | 2 | picture | + a live trap must be caught to pass, page 2 < subset 7-8 |
| 90-99 | 12 | 44-53 | 4 | 5 | picture | everything, three shrinks and a growth in order, live trap |

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

## Addendum A: the skill is accurate but sloppy

Added 2026-09-12 00:55 after the first build phase started. Implemented as a follow-up
workstream; the clean generator above stays and becomes the ground truth the sloppy one wraps.

The skill the agent gets is not a tidy document. It is the kind of internal doc a real team has:
every rule is in there and correct, and it is buried in megabytes of noise. Reading it carefully
is the test. Skimming it is how you fall off the ladder.

`skill.js` gains `toSkill(world, {mode: 'clean'|'sloppy', targetBytes})`. Clean is the 200 to 400
line version and is the source of truth. Sloppy expands it deterministically (seeded, same seed
same bytes) to `targetBytes` (default 5 MB for a real run, 64 KB in tests) using these layers:

- **Every rule stated once canonically** somewhere in the document, under a heading that does not
  say what it contains ("Misc", "Notes from the migration", "READ THIS (old)").
- **Decoys that a careful reader can resolve.** Older, wrong values for the same rule, each one
  dated or versioned, with the document's own precedence convention stated once near the top
  ("newest dated entry wins", or "entries marked v4 supersede v3"). A rule stated three times with
  different values is answerable only by applying that convention.
- **Filler that is plausibly real:** changelogs, meeting notes, Slack pastes, an FAQ that answers
  questions nobody asked, tables of unrelated config, a long section about a retired feature
  clearly marked retired, duplicated sections with typos, TODOs, commented-out YAML.
- **Noise never contradicts the truth without a resolvable marker.** Sloppy is not the same as
  wrong. If two statements conflict and neither is dated or versioned, that is a generator bug.
- **The precedence convention, the unit words, the lora names, and the signing recipe** are the
  four things the agent must find. They are placed by seed, never in the first 10 percent of the
  file.

Export `truthTable(world)`: the list of rules with their true values and the byte offsets where
the canonical statement and each decoy sit in the sloppy output, so tests can assert that the
truth is present, the decoys are all marked, and nothing before the precedence convention
contradicts it unresolvably.

## Addendum B: the sandbox has an editor, and only bru opens sockets

The one rule stands: nothing but `bru` opens a socket. But a 5 MB skill cannot be read in one
turn, and an agent with only `bru` cannot author request files. So the sandbox exposes an editor,
and the editor is deliberately dumb:

| Tool | Args | Limits |
|---|---|---|
| `bru` | `{args}` | the CLI, the only thing that reaches the network |
| `write_file` | `{path, content}` | inside the sandbox only |
| `read_file` | `{path, offset, limit}` | max 200 lines per call |
| `grep` | `{pattern, path}` | regex, returns line numbers and lines, max 100 hits |
| `ls` | `{path}` | inside the sandbox only |

No shell. No pipes. No `cat`. Finding the DPI in 5 MB means choosing search terms well, reading
the hits, and noticing that three of them are decoys. That is on the reasoning axis, and every
tool call is a turn, so it costs on the Turns column too.

`harness/prompt.md` names all five tools, states the one rule, and does not hint at the
precedence convention. Finding it is part of the climb.

## Addendum C: calibration against OpenRouter, steepen until nobody passes 30

Added 2026-09-12 01:20. Runs after the suite is green and Addenda A and B are implemented.

- `drivers/openai.js` must accept `baseUrl` and extra headers; `--driver openrouter` is that
  driver with `baseUrl=https://openrouter.ai/api/v1`, key from env `OPENROUTER_API_KEY` (or the
  aigate vault via the add-key skill), headers `HTTP-Referer: https://git.shoemoney.ai` and
  `X-Title: Bruno QUAERE`. Model ids are OpenRouter ids and MUST be verified against
  `GET https://openrouter.ai/api/v1/models` before a run; never guess an id.
- Model choice for a calibration round: the current flagship from each of Anthropic, OpenAI,
  Google, xAI, DeepSeek, Moonshot, Qwen as listed by OpenRouter that day, five to seven models.
- Round rule: one attempt each with the full 3M budget and sloppy 5 MB skill. If ANY model's
  rung >= 30, steepen `src/ladder/grammar.js` band parameters (more steps, more params, more
  lookups, more quant ops per band, and the trap and rounding requirements pulled into lower
  bands), rerun the reference on seeds 1, 2, 3 (must still be 100/100), rerun ONLY the models that
  cleared 30. Repeat up to three rounds. Never hand-edit a rung.
- Also enforce the bottom-band spread: if every model falls at the same rung ±2, the bottom is a
  wall, not a ladder; flatten rungs 0-29 (fewer axes rising at once) and rerun.
- Publish `board.md` after every round with a `## Round N` section, the grammar parameters used,
  and each model's fall rung, turns, tokens, fidelity, trap.

## Addendum D: budget counts novel tokens, the harness trims context, drivers cache

Added 2026-09-12 04:10 after the first live climb (claude-sonnet-5 via OpenRouter, seed 11):
63 turns cost 1.88M input tokens against 21.5K output, an 87:1 ratio, because the full
conversation is resent every turn. At that rate the 3M budget dies near rung 5, which measures
the harness, not the model.

- **Budget = novel tokens.** Per turn, count `output_tokens` plus the input delta
  `max(0, input_tokens_t - (input_tokens_{t-1} + output_tokens_{t-1}))`, which is the new content
  appended (tool results, trims, notes). Cumulative resend is NOT charged. Report cumulative
  provider input tokens and dollars separately as `tokensBilled` and `cost`. `RunResult` gains
  `tokensNovel`, `tokensBilled`. The 3M cap applies to `tokensNovel`.
- **The harness trims context.** When the estimated context (last `input_tokens` from the
  provider, or chars/4 before the first call) exceeds `--context-limit` (default 160000), drop the
  oldest non-system turns until it is under 60 percent of the limit, and append one user note:
  `[context trimmed: N earlier turns removed. Files you wrote in the sandbox persist.]`. Log every
  trim in the transcript and count trims in `RunResult.trims`. This is the "context outlives the
  window" measurement: the agent that used the collection as its notebook keeps climbing.
- **Provider context-length errors are not a fall.** On a 400 context-length error, trim harder
  (to 40 percent) and retry once; only if that fails is `stoppedBecause = 'error'`.
- **Drivers use prompt caching where the provider offers it.** Anthropic and OpenRouter-to-
  Anthropic: `cache_control: {type: 'ephemeral'}` on the system prompt block and on the last tool
  result. OpenAI-compatible: nothing to do, automatic. Cache read tokens are reported, never
  charged to the budget.
- **Degenerate geometry is a generator bug.** Tiers 2 and 9 create at physical units and high
  DPI then convert down to a few hundred px, collapsing shapes to w:1 h:0. `rung.js` must keep
  every shape at least 8 px on each axis after every step in the plan; assert it in the ladder
  test for all 100 rungs on seeds 1..3. Re-baselining hashes is fine; nothing is published yet.
- **Admin bind.** `ADMIN_BIND` env (default `127.0.0.1`); the Dockerfile sets `0.0.0.0` so the
  mapped 8081 answers. The harness always uses loopback.

## Addendum E: a malformed submission is a 422, not a fall; transcripts carry tool results

Added 2026-09-12 06:10 after calibration round 1.

- **claude-fable-5.1 fell at rung 0 on a shell-quoting slip, not on the task.** It passed
  `--env-var submitAssets=["asse_8e4_37"]`; the sandbox tokenizer (correctly, like any shell)
  stripped the quotes, the interpolated body became invalid JSON, the server parsed an empty
  body, recorded a submission with no assets, and the run ended. Its reasoning up to that point
  was exact (0.85 x 1.09 cm at 300 dpi to 96 x 128 px on a 16 grid, correct). kimi-k3 used the
  working pattern (`"assets": ["{{assetId}}"]` in the file, a bare id in `--env-var`) and climbed
  to rung 11.
- **Rule:** `POST /rungs/{n}/submit` returns 422 problem+json and records NOTHING when the body
  is not valid JSON, `assets` is missing or not an array, or any id does not resolve to an asset
  the caller can see. A submission is recorded only when every id resolves. Wrong count, wrong
  order, or wrong hashes still fail the rung: pickiness is about the artifact, never about JSON
  transport. Add tests for all three 422 cases and for the recorded-only-when-resolved rule.
- **Transcripts must include tool results.** `transcript.jsonl` currently records assistant text,
  tool calls, and usage only. Add `toolResults: [{id, name, output (truncated to 4 KB), ms}]` per
  turn. Without it the fall above was undiagnosable from the transcript alone.
- **Degenerate output is its own stop reason.** kimi-k3 collapsed into repeated `<|close|>`
  tokens with `stop: 'length'` and no tool calls at rung 11. Two consecutive turns with no tool
  call and `stop === 'length'` set `stoppedBecause: 'degenerate'`; the fall rung stands.
- **Model selection filters on tool support.** OpenRouter's `/models` entries carry
  `supported_parameters`; pick only ids that include `tools`. `x-ai/grok-4.20-multi-agent`
  answered `404 No endpoints found that support tool use`. Choose that vendor's tool-capable
  flagship instead.
- Runs affected by the 422 rule (round 1 fable) are rerun, not rescored.

### Calibration lineup (Jeremy, 2026-09-12 06:33)

Fixed seven, OpenRouter ids verified with `tools` in `supported_parameters`:
`openai/gpt-6-astra`, `x-ai/grok-4.6`, `deepseek/deepseek-v4.1-flash`, `moonshotai/kimi-k3`,
`qwen/qwen3.8-max-0902`, `anthropic/claude-fable-5.1`, `google/gemini-3.8-flash`.
Never the `:batch`, `-pro`, or `multi-agent` variants.
- **(06:36) gpt-6-astra was cut at rung 59 by the harness, not the task.** Turn 445 was sent at
  160,107 input tokens, over the 160,000 limit, and the next call returned a generic
  `400: Provider returned error` that the context-length classifier did not recognize, so no trim
  and retry happened. Rules: (1) trim BEFORE a call whenever the last reported `input_tokens` is
  at or above 90 percent of `--context-limit`, never after; (2) any 400 or 413 from a call made
  at or above 85 percent of the limit is treated as context-length: trim to 40 percent and retry
  once; (3) fake-driver tests for both. That run is voided and rerun.

## Addendum F: native CLI drivers, direct provider keys, OpenRouter only as a last resort

Added 2026-09-12 07:05. Jeremy's ruling: run each model through its own agent CLI installed on
this Mac, with provider keys from aigate for labs that have no CLI, and OpenRouter only for a lab
that is in neither. The benchmark now measures model plus harness product, which is what a user
actually gets. All smoke-tested headless from an isolated home on 2026-09-12 07:00.

| Model | Driver | Invocation (cwd = sandbox) | Isolation | Usage source |
|---|---|---|---|---|
| claude-fable-5.1 | `cli:ai` | `AI_NO_RTK=1 ai --no-chrome -p "<prompt>" --model claude-fable-5-1 --output-format json` | `CLAUDE_CONFIG_DIR=<fresh dir>` (the aigate warden still authenticates) | result JSON `usage` + `modelUsage` + `total_cost_usd` |
| gpt-6-astra | `cli:codex` | `codex exec --json -m gpt-6-astra -C <sandbox> --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "<prompt>"` | `CODEX_HOME=<fresh dir>` containing a copy of `~/.codex/auth.json` | `turn.completed.usage` events |
| qwen3.8-max | `cli:qwen` | `command qwen --approval-mode yolo -o json -m qwen3.8-max "<prompt>"` with `~/.qwen/.env` sourced | `HOME=<fresh dir>`; `QWEN_CODE_SUPPRESS_YOLO_WARNING=1` | result JSON `usage`, `stats.models` |
| gemini-3.8-flash | `cli:gemini` | `gemini -y -o json -m gemini-3.8-flash -p "<prompt>"` | `HOME=<fresh dir>`, `GEMINI_API_KEY` from aigate `google`, `GEMINI_CLI_TRUST_WORKSPACE=true` | `stats.models.<model>.tokens` |
| kimi-k3 | `cli:kimi` | `kimi -p "<prompt>" --output-format stream-json` (`-p` cannot combine with `-y`/`--auto`; prompt mode already runs tools) | `HOME=<fresh dir>` with `~/.kimi-code/config.toml` and `~/.kimi-code/device_id` copied in (corrected 2026-09-12, see below) | stream has tool calls but no usage; read the session file under `<HOME>/.kimi-code/sessions/*/<id>/agents/*/wire.jsonl` after exit, else estimate chars/4 and mark `usageEstimated: true` |
| grok-4.6 | `openai` driver | `baseUrl=https://api.x.ai/v1`, key aigate `xai`, model id verified against `GET /v1/models` | n/a | API usage |
| deepseek-v4.1-flash | `openai` driver | `baseUrl=https://api.deepseek.com`, key aigate `deepseek`, model id verified against `GET /v1/models` | n/a | API usage |

Gemini smoke test reported `gemini-3.5-flash` in `stats.models` when asked for `gemini-3.8-flash`.
Every adapter records the model the tool actually reports as `modelVersion`; if it differs from
the requested id the run is marked `modelMismatch: true` and the operator must resolve the alias
before the run counts. Never silently accept a fallback model. Root cause (2026-09-12): the
installed `@google/gemini-cli` (0.59.0) doesn't recognize the literal id yet -- its own
`resolveModel()` coerces any unrecognized `*-flash` request to the account's current default flash
model. Not fixable from a flag; either request `gemini-3.5-flash` directly or wait for a CLI build
that knows the literal id.

**kimi path corrected 2026-09-12.** `~/.kimi/credentials` + `~/.kimi/device_id` is the PRE-migration
layout and no longer works: a one-time migrator (kimi-code 0.42.0, ran 2026-09-07 on the build
machine) moved the CLI's real home to `~/.kimi-code` and explicitly left `device_id` and the
provider config behind (`migration-report.json`: `deviceIdCopied: false`). `~/.kimi/credentials` is
just a 0-byte lock file, never a credential store -- auth is device-bound, with no separate token
file. Seed the sandbox from `~/.kimi-code/{config.toml,device_id}` instead; verified end to end
(real reply, real session + usage file written).

### How a CLI climb works

- The harness writes into the sandbox: `TASK.md` (the fixed prompt: the one rule, base URL, api
  key, how to fetch `/rungs/current`, how to submit, one submission per rung, "you are the only
  agent, do not delegate"), `spec.json`, and `HOUSE-RULES.md` (the sloppy skill; not named
  SKILL.md so no CLI auto-loads 5 MB into context). The `-p` prompt is one line: read TASK.md and
  begin.
- `sandbox/bin/bru` is a logging shim first on PATH: appends `{ts, argv}` to `turns.jsonl` then
  execs the real bru. Turns = shim lines. PATH keeps the original entries after it so the CLI's
  own runtime resolves.
- Rule enforcement is by detection, not prevention: the API's admin log records `User-Agent`
  per request. Anything other than `bruno-runtime/<version>` is a violation. `RunResult.violations`
  counts them and the board shows the column; a run with violations is published with the
  number, not disqualified silently.
- Supervision: the harness polls admin `/submissions` every 2 s while the CLI runs. On a failed
  submission it kills the process tree (`stoppedBecause: 'fail'`). If the CLI exits on its own
  before falling, the harness resumes the same session with "continue; the current rung is N"
  (claude `--resume <session_id>`, codex `exec resume <id>`, kimi `-S <id>`, qwen and gemini
  `--resume` where supported, otherwise a fresh session with the note) and counts it in
  `RunResult.resumes`. Three resumes with no new submission is `stoppedBecause: 'stalled'`.
- Budget: `tokensBilled` = reported input + output; `tokensNovel` = (input − cached) + output
  from the tool's own usage. The 3M cap applies to novel. Wall cap `--wall-ms` default 3 h.
- Trims are the CLI's own compaction; not observable uniformly, so the column is `resumes`.

### Files

`src/harness/cli/{ai,codex,qwen,gemini,kimi}.js` each export
`{ name, build({sandbox, prompt, model, home}) -> {cmd, args, env}, parseUsage(stdout, home) ->
{tokensIn, tokensCached, tokensOut, modelVersion, usageEstimated}, resume(sessionId) }`,
`src/harness/cli/index.js` dispatches, `src/harness/supervise.js` runs a process under the
polling loop, `bin/quaere.js run --driver cli --cli <name>`. Tests: adapter build() and
parseUsage() on captured fixtures; a live smoke per CLI that runs rung 0 only, skipped when the
binary is missing.

## Addendum G: exact arithmetic in the answer key, supervisor baseline, drained usage, whole-round rule

Added 2026-09-12 12:05 after native round two.

- **The answer key must never depend on float error.** Seed 220 rung 0: `0.56 in × 300 dpi` is
  `168.00000000000003` in IEEE-754, so ceil-to-even gave 170 while exact arithmetic gives 168.
  claude-fable-5.1 computed 168, matched every other byte, and fell. That rung was unpassable by
  a correct agent, which violates the reference-gates-everything promise (the reference passes
  because it shares the bug). Rule: every unit-to-pixel conversion in `media.js` and the ladder
  snaps the raw product to 6 decimals (`Math.round(x * 1e6) / 1e6`) before any rounding rule, in
  the API, the reference, and the key alike. The skill states the snap as a house rule. The
  ladder generator additionally rejects any dimension whose exact product lies within 1e-6 of a
  grid boundary and draws again. Test: for seeds 1..50 and every rung, recompute each conversion
  with integer arithmetic (inches × 100 × dpi, etc.) and assert equality with the key. Rebaseline.
- **Supervisor baseline is per run, not per spawn.** On each resume `superviseProcess` re-read
  `/admin/submissions`, treated all prior submissions as new, and advanced the rung once per
  old submission: 60 clean submissions became rung 240 and an empty task. gpt-6-astra, clean at
  rung 59 with fidelity 1.0, asked the harness to restore rung 60, wrote a status file, and was
  marked `stalled`. Rule: the caller passes the baseline count; advance only on submissions
  newer than it; assert `current <= 99` and treat any overshoot as a harness error, never a fall.
- **Drain usage before the kill.** Killing the CLI the instant a fall appears loses its usage
  output, so every fallen run reports zero tokens and no model version. Rule: on a fall, send
  SIGTERM, wait up to 20 s for the process to print its result, then SIGKILL. For `ai` and
  `qwen`, additionally read usage from the session files under the isolated home. Mark
  `usageEstimated` only when both fail.
- **Model id facts (verified against provider `/v1/models`).** DeepSeek serves `deepseek-flash`
  and `deepseek-v4-pro` only; `deepseek-v4.1-flash` does not exist there. Record the served id as
  the model name on the board and say so. Gemini's reported model must be captured from the
  drained result, not left null.
- **Whole-round rule.** A board row is comparable only with rows from the same ladder version.
  After any steepening, every model in the lineup reruns; never rerun only the passers. The board
  groups rows by ladder version and marks the current one.
- **Gate the calibration on verification.** The orchestration script must not start climbs
  unless the verify stage returned green with fresh output.
- **Unit-tag rung failures are real falls.** grok-4.6 (rung 28), gemini-3.8-flash (rung 17), and
  kimi-k3 (rung 4) all hand-converted a unit-tagged dimension with the wrong dpi, rounding rule,
  or layer, while the skill states the house rules. Those stand. The skill must, however, state
  plainly once that the API accepts `unit` and converts server-side, so the choice to convert by
  hand is the agent's.
- **Turns are counted at the API, not by the shim.** codex's native round-three run reported
  0 turns because its shell did not inherit the shim PATH. Rule: Turns = number of requests in
  the admin log whose User-Agent starts with `bruno-runtime/`, uniform across every driver. The
  shim stays as a secondary log only.
- **The board is grouped by ladder version and lists one row per (model, driver, seed).** No
  medians across versions, no `undefined` rows (skip result.json files missing `model`), and
  rows from superseded versions sit under a "superseded" heading with the version they ran on.
- **qwen never ran in round two** (the operator agent errored before launching). Every model in
  the lineup gets a row or an explicit "did not run: <reason>" line; silence is not allowed.

## Addendum H: Gemini 3.8 is not reachable through the Gemini CLI; x.ai team is blocked

Added 2026-09-12 14:45 after the first full native round on ladder 0.3.0.

- **gemini-cli 0.59.0 (latest) does not know `gemini-3.8-flash`.** Its bundle names only 3.5 and
  3.1 models, and an unknown `-m` silently becomes `gemini-3.5-flash`. The vaulted Google key CAN
  reach `gemini-3.8-flash` (present in `GET /v1beta/models`), and Google's OpenAI-compatible
  endpoint `https://generativelanguage.googleapis.com/v1beta/openai` answers it with tool calls.
  Rule: add `--driver google` (openai driver preset, that baseUrl, key env `GEMINI_API_KEY`
  from aigate provider `google`). The Gemini row runs on `google` direct until a Gemini CLI
  release knows 3.8 (check the nightly tag first; if it does, prefer the CLI per Jeremy's
  ruling). The round-one 0.3.0 gemini row (served 3.5-flash) is marked `modelMismatch` and is
  not a lineup result.
- **x.ai key status: `team_blocked: true`.** Every chat call returns 403. grok-4.6's 0.3.0 run
  was cut at rung 23 by that 403, not by the task; `stoppedBecause: 'error'` is correct and the
  row is not a fall. Unblocking is on Jeremy's console. Until then grok runs through OpenRouter
  (`x-ai/grok-4.6`, verified tool-capable), which is the "lab not reachable through aigate"
  case, and the board says so in the Driver column.
- **Provider 403 handling.** A 403 or 401 mid-climb is a provider error: retry once after 30 s,
  then stop with `stoppedBecause: 'provider'` and the status code in `driverError`. Never
  classify it as a fall.

## Addendum I: the key must be derivable from the documents, and a doc-only solver proves it

Added 2026-09-12 14:50 from an audit of the three top falls on ladder 0.3.0 (fable rung 17,
astra rung 25, deepseek rung 16). All three fell on one undocumented rule.

**What happened.** For a "shrink to N percent" step the answer key computed
`Math.round(raw)` and then the house grid (`src/ladder/grammar.js:372`). Nothing in the 5 MB
skill or the spec states the `Math.round` step. Worse, the rung text's own note ("the house
rounds every size to its usual grid; do that after every resize") describes grid-rounding the
raw value, which gives a different integer whenever the two cross a grid line. deepseek's notes
file shows it resolved every decoy correctly, applied the documented rule, and lost. Measured
over seeds 300-330: 28 percent of all rungs with a percent step are decided by that hidden
rounding. The reference passes because it calls the same code, so the reference gate is
structurally blind to this class of bug, exactly as it was to the Addendum G float bug.

**Rules.**
1. **The key follows the documented rule.** A percent resize target is
   `roundToGrid(snap6(raw), roundTo, roundMode)`, the same function the API applies. Remove the
   hidden `Math.round`. `ROUND_NOTE` in `rung.js` then reads true as written. Rebaseline.
2. **Generator guard.** Reject any percent whose two plausible roundings disagree
   (`grid(round(raw)) !== grid(raw)`) and redraw, so no rung ever turns on that ambiguity even
   if a future rule change reintroduces it.
3. **The sloppy skill is a superset of the clean skill.** `skill-sloppy.js` currently re-emits
   scalar facts only and drops every prose section, including the entire publish-signing
   recipe (`X-Signature`, `X-Timestamp`, hmac: zero hits in 5 MB), which makes rungs 60+
   unsolvable from docs. It must embed each `##` section body of the clean skill verbatim as an
   intact block inside the noise. Test: every clean section body appears verbatim in the sloppy
   output, and `truthTable` covers the prose rules too.
4. **A doc-only solver gates every rung.** `src/ladder/docsolver.js` computes each rung's
   expected descriptor from `truthTable(world)`, the spec, and the rung text only, with no
   import from `grammar.js`, `rung.js`, or `media.js` internals beyond the public render and
   descriptor shapes. It is written by a different agent than the generator, from the docs. Gate:
   for seeds 1..20 and every rung, `docsolver` equals the key, or the build is red. This is the
   check that would have caught both the float bug and this one before a round burned money.
5. **Version bump to 0.4.0 and a whole-round rerun.** All 0.3.0 rows are superseded.

## Addendum J: ladder 0.4.0 was cleared; the next ladder is built for 2028

Added 2026-09-12 19:20. Full native round on 0.4.0, one attempt each, 5 MB sloppy skill:

| Model | Driver | Rung | Turns | Novel tokens | Notes |
|---|---|---|---|---|---|
| qwen3.8-max | qwen CLI | **99 (cleared all 100)** | 3401 | 1.40M | fidelity 1.0, trap 1.0, 1 resume, 0 violations, 2.0 h |
| claude-fable-5.1 | ai | 71 | 1138 | 0.22M | stale layer count in its own reused script |
| gemini-3.8-flash | google direct | 69 | 1499 | 0.93M | fell at 70, fidelity 0.78 |
| x-ai/grok-4.6 | openrouter | 59 | 1057 | 0.64M | fell at 60; **40 rule violations** (see below) |
| deepseek-flash | direct | 57 | 285 | 0.34M | fell at 58, fidelity 0.98 |
| gpt-6-astra | codex | 29 | 151 | 0.11M | trap rung 30, trusted the docs |
| kimi-k3 | kimi CLI | 94, stopped by the 3 h wall | 1146 | 0.54M | fidelity 1.0, trap 1.0, 0 resumes, 0 violations, still clean at the wall |

The calibration promise ("no current model past rung 30") is false on the honest ladder by a
wide margin, and one model cleared it entirely. The bottom band still discriminates (29 to 99).
What follows is the design for ladder 0.5.0, built to hold for two years, not two hours.

### What made 0.4.0 easy

The transcripts of the top climbs show the same strategy: read the skill once, write a small
generic solver script that parses the rung text into API calls, and replay it. Rungs 20 to 99
differ in parameters, not in kind. A ladder whose rungs are one template with bigger numbers is
climbed by one script. The steepening must add kinds of difficulty a script cannot template.

### Rules for 0.5.0 (grammar and generator; keys must stay doc-derivable, docsolver gate stays)

1. **Cross-rung dependencies.** From rung 20 on, a rung may reference an artifact by a property
   the agent saw earlier ("the second picture you published today", "the clip whose hash you were
   told at rung 12") and the text never repeats the value. Rung 60+ references rung 20-40 state.
   This is the long-session axis, finally measured: the collection on disk is the memory.
2. **Derived parameters.** From rung 30 on, at least one parameter per rung is not stated but
   must be computed from data the API returns: a CSV export (content negotiation), a paginated
   count with soft-deleted rows excluded, the difference between two descriptors, the duration of
   an audio asset. The number in the task text is the input to a computation, never the answer.
3. **Mid-rung mutations (regression day inside a rung).** From rung 40 on, a mutation from the
   Arena list is applied by the harness after step k of the plan (announced in the text as "the
   house may change something under you; verify what comes back"). The correct answer accounts
   for the change; the docsolver models it from the announced rule.
   **Wire contract (ladder 0.5.0):** `world.rungMutations` is an array indexed by rung number;
   `world.rungMutations[n]` is `null` or `{ n, mutation }` with `mutation` drawn from
   `RUNG_MUTATION_POOL` (`statusCode`, `dropField`, `renameField`, `retypeField` -- `rejectAuth`
   and `stuckCursor` are excluded because either one, live for a whole rung, makes that rung
   unpassable by any correct client), and when `POST /admin/rungs/advance` moves the current rung
   to `n` the server REPLACES its active mutation set with that entry's mutation (or clears it),
   so the change is live from the rung's first request and no earlier rung's mutation leaks
   forward. `src/ladder/reference.js`'s `climb()` drives that advance in step with itself, so the
   reference gate proves every rung is passable with its own announced mutation applied. The
   house rules every 0.5.0 key depends on are enumerated in `docs/RULES-0.5.md`; nothing in a key
   may turn on a rule absent from that file.
4. **State-machine and signing chains.** Rungs 50+ require compose, render (202 + polling),
   publish (HMAC with the canonical string from the skill), and ETag-conditional updates in the
   same rung, and at least one 409 recovery.
5. **Audio and video math.** Rungs 50+ use timeline overlaps, sample-rate times duration equals
   frames, bitrate budgets, and combine modes across kinds ("the video's audio track"), not only
   images.
6. **Multi-rule ordering.** Rungs 70+ require three or more house rules applied in a stated order
   where the order changes the answer (snap, grid, compounding, lora before or after resize).
7. **Skill pressure.** The sloppy skill rotates the precedence convention per section ("in this
   section the highest version wins") and plants one decoy that is newer-dated but explicitly
   retracted two lines later. Still never an unmarked contradiction; still a superset of clean.
8. **Novelty per season.** Each season adds one new primitive the previous season's solver
   scripts cannot have seen. 0.5.0 adds `diff` over audio and `sequence` over video.
9. **Band table.** Steps per rung: 0-9: 1-2; 10-29: 3-5; 30-49: 6-9; 50-69: 10-14; 70-89: 15-20;
   90-99: 20-30, with the dependencies above layered in by band. Difficulty stays monotone.

### Harness rules

- **Admin port hardening.** A native CLI has a shell. The admin server must require
  `X-Admin-Token`, a per-run random secret held only by the harness process and never written
  into the sandbox. Bind stays loopback. Requests without the token are 401 and logged as
  `adminProbe` on the result; any adminProbe voids the run.
- **Violation samples persist.** `result.json` stores up to 20 `{ua, method, path}` samples of
  non-bru requests so a violation can be read after the server is gone. Grok's 40 violations on
  0.4.0 cannot be diagnosed because they were not saved.
- **Turn cap.** 5000 `bru` requests per run, reported as `stoppedBecause: 'turns'`.
- **Climbs are launched and watched by the main session**, not by workflow subagents, which get
  forced to return before a multi-hour run ends. Workflows build and verify; the round runs from
  the session with detached processes and a bash (not zsh) watcher.

## Addendum K: reasoning models exhaust max_tokens silently; axios in bru scripts is not a shell

Added 2026-09-12 23:45 during the 0.5.0 round.

- **deepseek-flash, seed 506, clean at rung 44, killed by the harness.** Turn 363 returned an
  empty assistant message with `stop: 'length'` and 4096 output tokens: the model's reasoning
  consumed the whole output budget and no visible text or tool call survived. The harness then
  appended that empty assistant turn and the provider rejected the next call with
  `400 Invalid assistant message: content or tool_calls must be set`. Two rules: (1) message-loop
  drivers request at least 32768 output tokens (provider max if lower) so reasoning has room;
  (2) an assistant turn with neither content nor tool calls is never appended; on `stop: 'length'`
  with empty content the harness appends a user note ("your last reply was cut off before any
  tool call; answer with a tool call") and retries; two in a row is `degenerate`. That run is
  voided and rerun.
- **`axios/1.16.0` requests are bru scripts, not a shell.** deepseek's 287 "violations" and
  grok's 40 on 0.4.0 were all `POST /auth/token` from bru's script sandbox (`--sandbox
  developer`, `require('axios')` in pre-request scripts). On the message-loop drivers the agent
  has no shell, so an axios User-Agent can only come from inside bru's runtime. Rule: the
  violations column counts requests whose User-Agent is neither `bruno-runtime/*` nor `axios/*`;
  a separate `scriptRequests` column counts the axios ones. Neither voids a run. The board notes
  the distinction. For CLI drivers axios could also be the CLI's own node code; the column is
  published either way and the samples say which path.

## Addendum L: the sandbox never contained the signing secret

Added 2026-09-13 00:00 during the 0.5.0 round. gpt-6-astra (seed 501) reached rung 59 clean,
then asked three times for "the signing secret or the path to its Bruno environment file" and
was marked stalled. The skill says, correctly, that the key and secret "live in the sandbox's
Bruno environment file, never in this document", and `run-cli.js` / `task-md.js` never write
one: TASK.md carries the api key only. Every publish rung (50+) was unpassable on every driver.
The docsolver did not catch it because it reads `world.auth.secret` directly; it is a solver, not
a sandbox.

Rules: both run paths write `environments/local.yml` (OpenCollection environment: `baseUrl`,
`apiKey`, `secret` marked secret) into the sandbox before the first turn, and TASK.md names the
file. A test asserts the file exists, parses, and carries the world's secret for both paths, and
a sandbox-fidelity test runs the reference climb using ONLY files present in a freshly prepared
sandbox (TASK.md, spec.json, HOUSE-RULES.md, environments/local.yml) as its inputs, so anything
the docs promise the sandbox contains is proven present. The 0.5.0 round is voided and rerun
on one harness version for all seven.

## Addendum M: a seed can make the generator explode

Added 2026-09-13 01:00. `answerKey(makeWorld(525))` exhausts a 3 GB heap in 6.6 s; seed 523
takes 76 ms and 305 KB. The grok run on seed 525 died at setup with `FATAL ERROR: JavaScript heap
out of memory` before its sandbox was written. Some composition in the 0.5.0 grammar grows
without bound on certain seeds (a stack-everything step over accumulated artifacts, a redraw loop
that never converges, or a cross-rung reference chain that re-embeds prior descriptors).

Rules: (1) every artifact descriptor is capped (at most 64 shapes, 64 notes, 32 clips) and every
combine or stack step draws inputs bounded by that cap; the generator asserts the cap after each
step and redraws the step if exceeded, never silently truncating; (2) `test/keygen-bounds.test.js`
generates the answer key for seeds 1..300 and asserts each finishes under 2 s and serializes under
2 MB, and that `makeRung` for seed 525 rung by rung stays under those bounds; (3) VERSION bumps to
0.5.1; the running 0.5.0 round keeps its label. A seed that cannot be generated is a generator
bug, never a "hard seed".
- **(01:05) `driverError: "terminated"` is a transient transport error, not a stop.** grok
  (OpenRouter, seed 527) was clean at rung 13 when fetch threw `terminated` (the response body
  stream was closed mid-read). The driver treated it as fatal. Rule: `terminated`, `ECONNRESET`,
  `ETIMEDOUT`, `socket hang up`, `fetch failed`, and 5xx are retried up to 3 times with 5/15/45 s
  backoff before `stoppedBecause: 'provider'`; never `'error'` with the raw message. Voided and
  rerun on seed 528.
