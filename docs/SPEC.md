# Bruno QUAERE

**Quantitative Unseen Agentic Endpoint Reasoning Evaluation.** Latin *quaere*, "to seek, to ask,"
the root of *query*.

A purpose-built media API whose only job is to be figured out. It creates images, audio, and video
from deep JSON specs, converts, combines, and diffs them, and every artifact is deterministic: same
params, same bytes. Every instance is seeded, so no model can memorize it. Every trap is designed,
so the score means something. The agent under test gets one tool, the Bruno CLI, a skill file that
explains how the house does things, and a ladder of a hundred tasks in plain language that get
harder until it falls off. The transcript of the climb is itself the product demo.

QUAERE is the permanent unseen row in the API Arena (`ARENA.md`). The borrowed APIs on that board
measure recall. This one measures reading.

## Why purpose-built

| Borrowed API (Stripe, otari) | QUAERE |
|---|---|
| Unseen until the first board is published, then it is training data | Shape is public, instance is seeded per run, never the same twice |
| Spec is whatever the vendor wrote | Spec lies on purpose, in known places, so catching lies is scorable |
| Mutations need a proxy in front | Mutations are native, flipped on an admin port the model cannot reach |
| One shared sandbox, probing by one model can dirty another's state | One instance per model per run, own port, own seed |
| Vendor can change it mid-season | Pinned by version and seed, reproducible forever |

## The one rule for the agent

The sandbox the agent runs in has exactly one binary that can open a socket: `bru`. No curl, no
Python, no node. The agent writes `.bru` request files and environment files, runs `bru run`, reads
the output, and repeats. Every invocation is logged with its arguments and output.

That log is the deliverable behind the score. It is a recording of an agent learning an API
through Bruno alone, and every published run is a worked example of the CLI doing real work.

## Why the media is fake

`bru run` can assert on status, headers, and JSON. It cannot assert that an image is a red cat.
The moment the API makes real images, grading needs a vision model, and an AI is judging AI, which
is the one thing the whole pitch promises never to do.

So the endpoints are real and the artifacts are deterministic. An image is an SVG or PNG rendered
from shapes, layers, colors, and sizes. Audio is a WAV built from tones, durations, and envelopes.
Video is frames from a timeline. A lora is a named style preset that changes the output in a fixed
way. Every response carries the artifact, a canonical descriptor, and a content hash. The harness
computed the correct hash from the seed before the run started. Judge stays `bru run` plus hash
equality, and the board can show "expected vs what model X made" side by side, which is the press
shot.

## The skill is the Rosetta stone

Tasks are written in plain language: "make an image 12 by 22 inches with a transparent background
using Jenny's lora." Nothing in the spec says inches. The skill file says the house DPI is 300,
that transparency lives under `canvas.background`, that loras are looked up by name at an endpoint
that only appears in a `links` block, and that dimensions round to the nearest multiple of 8.

That is the measurement: can the agent read a long, real-shaped skill and apply it, rather than
autocomplete from the spec. The skill is generated from the seed too, so house rules differ per
instance, and it deliberately overrides spec defaults in a few places so "did it read the skill"
has a checkable answer. Published as a real Bruno skill after each season, because it is one.

## The ladder

A hundred rungs, stop at the first failure. Rungs are not hand-written. A difficulty grammar
composes each one from primitives, and the seed picks the concrete task, so no two runs climb the
same ladder and the harness always knows the answer because it built the question.

| Primitive | Example |
|---|---|
| Create | one artifact to a deep spec: nested options, enums, units, mutually exclusive fields |
| Convert | change format, size, sample rate, color space |
| Combine | layer, mix, or sequence two or more artifacts under stated rules |
| Diff | compare two artifacts, produce only the delta |
| Batch | do a step across a paginated set of assets |
| Compute | a quantity the task needs but does not state |

Difficulty at rung *n* rises across four axes at once: steps in the chain, parameters per step,
skill lookups required, and quant operations. Rung 0 is one call with exact params. Rung 20 is
create, convert, combine with a lookup. Rung 60 is a batch over a paginated library with a token
expiring mid-loop. Rung 90 is a diff of two composed artifacts where every dimension is derived,
a spec lie is live, and the answer is only correct if three rounding rules from the skill were
applied in order.

Quant catalog, all deterministic and all checkable against the descriptor:

- Unit conversion at a house DPI, with a stated rounding rule
- Aspect ratio locks and letterboxing
- Sample rate times duration equals frames; bitrate budgets ("fit under 2 MB")
- Color math: hex to HSL, shift by a percentage, back to hex
- Compounding: "each layer 10 percent more opaque than the one before it"
- Percent-of-parent sizing across nested layers
- Timeline math: offsets, overlaps, and total duration across clips

## Calibration: hard, picky, and provably solvable

The target at launch is that **no current model passes rung 30**. The ladder is built for the next
five years of models, not this year's. If a frontier model clears 30 in the private dry run, the
curve is too easy and gets steepened before season one publishes, never after.

Picky means picky. A rung passes only on exact hash equality for every artifact in the task. No
partial credit inside a rung. A rounding rule applied out of order, an opacity off by one percent,
a layer in the wrong z-order, a field named in the wrong case, a cursor loop that stopped one page
early: all of these are a fall, and the board shows the expected artifact next to what the model
produced so the miss is visible.

Two guardrails keep hard from becoming broken:

- **Every rung has a reference solution the harness executes before any model does.** A scripted
  climb, written from the skill and the spec alone, that passes all hundred rungs on every seed.
  A rung the reference cannot pass is a bug in the generator, not a hard task. Nothing is
  published that the reference has not cleared.
- **The bottom thirty rungs must spread the field.** A board where every model sits between 12
  and 28 is as useless as one where they all sit at 100. Rungs 0 to 30 rise steadily enough that
  a weak model falls at 8, a mid model at 17, a frontier model at 26, and the gaps are legible.
  Rungs 31 to 100 are headroom, and the first model to clear 50 is a headline on its own.

## Behaviors woven in

Sixteen behaviors a competent API consumer has to handle. They are the texture of the media API,
not a separate app: video render returns 202, the asset library is cursor paginated, create takes
an idempotency key, the token expires partway up the ladder. Which ones are live, and the concrete
names and formats, come from the seed.

| # | Behavior | What it tests | Skill it maps to |
|---|---|---|---|
| 1 | Cursor pagination, opaque cursors, last page signaled by a missing cursor, not an empty array | Loops that stop correctly | Pagination |
| 2 | Bearer token with a 60-second TTL and a refresh endpoint | Chaining requests, pre-request scripts | Auth lifecycle |
| 3 | `Idempotency-Key` on POST: same key returns the same resource, no key creates a duplicate | Reading a header's contract, not just its name | Idempotency |
| 4 | 429 with `Retry-After`, budget resets on the second | Backoff, not retry storms | Rate limits |
| 5 | `ETag` with `If-None-Match` 304 on reads and `If-Match` 412 on writes | Conditional requests | Caching and concurrency |
| 6 | POST returns 202 and a `Location`, job must be polled to `done` | Async workflows | Long-running operations |
| 7 | Some resources reachable only by following `links` in a response, absent from the spec | Reading responses, not just the spec | Discovery |
| 8 | Same path returns JSON or CSV by `Accept` | Content negotiation | Headers |
| 9 | Errors are `application/problem+json` with field-level detail on 422 | Asserting on error shape | Error handling |
| 10 | A spec-listed route 301s to a new path | Following redirects, updating the collection | Deprecation |
| 11 | Spec says `created_at`, API returns `createdAt` | Catching a spec lie | Contract testing |
| 12 | Spec says 200 on delete, API returns 204 | Catching a spec lie | Contract testing |
| 13 | Draft, compose, render, publish: a state machine that returns 409 out of order | Multi-step workflows | Sequencing |
| 14 | `/workspaces/{w}/projects/{p}/assets`: ids only discoverable by listing the parent | Nested resources | Hierarchy |
| 15 | One endpoint requires `X-Timestamp` plus an HMAC signature over it, using the API secret | Scripting in pre-request | Request signing |
| 16 | Soft-deleted rows hidden by default, visible with `?include_deleted=true` | Reading query parameter semantics | Filters |

Items 11 and 12 are traps. A season has at least two live traps and never reveals which.

## Seeding

One integer seed per instance controls:

- Entity vocabulary (orgs, projects, keys in one world; fleets, vehicles, sensors in another)
- Id formats (UUID, ULID, prefixed like `proj_…`, plain integers)
- Field naming convention (snake, camel, and which fields break the convention)
- Which traps are live and where
- Which routes are deprecated
- Cursor encoding
- Rate limit budget
- Token TTL

The spec is generated from the same seed, so it matches the instance except where a trap says
otherwise. Two instances with the same seed and version are byte-identical. That is what makes a
result reproducible.

## Budget and the single-agent rule

- **3 million tokens per run**, input plus output, hard cap. The run ends where the budget does.
- **One agent, one context.** No subagents, no parallel workers, no delegation. The instructions
  say so and the harness enforces it: one model session, one API key, one instance.
- **The ladder is longer than any context window.** That is on purpose. Somewhere between rung
  30 and rung 60 the agent will have to compact or clear its own context and keep climbing. How
  it survives that is measured, not excused: what it forgets, what it re-derives, how many turns
  it burns rediscovering the DPI rule it already read.

The Bruno-shaped answer is sitting on disk the whole time. The collection the agent has been
writing is its memory of the API: every request it got right, every variable it learned, every
test that encodes a house rule. An agent that treats the repo as its notebook climbs through a
context reset. An agent that kept everything in its head falls off. That is the manifesto's
argument, "collections co-located with the code as a living set of examples," measured on a
model instead of a team.

## Runs and scoring

Three runs per model, each on a fresh context. Within a run, context is never reset by the
harness, so running out of context at rung 70 is a real failure and is measured as one. A rung
passes when every artifact hash in the task matches the harness's answer.

| Name | Definition |
|---|---|
| Rung | Highest rung passed clean, median of three runs. The score |
| Turns | `bru run` invocations to reach that rung. The tiebreak |
| Fidelity | Share of parameters set correctly across every attempt, including failed rungs |
| Trap | Share of planted spec lies the collection's tests flagged |
| Tokens | Spent of the 3 million, and how many rungs per million. Reported |
| Time, Cost | Wall clock, dollars at list price. Reported, not scored |

Wall clock is deliberately not scored. Time up the ladder is dominated by provider latency and
rate limits, so scoring it ranks infrastructure, not the model. Turns measures the same thing
honestly: how many calls it took to figure the API out.

Reach and Guard from `ARENA.md` still apply to the collection the agent leaves behind, and are
published in the Arena board. Rung is the QUAERE headline.

## Instances and the harness

- One process per instance. Two ports: a public one the agent sees, an admin one it cannot.
- Admin port: `POST /admin/mutate` with a break name from the `ARENA.md` list, `POST /admin/reset`,
  `GET /admin/log` for every request the instance served.
- Harness: start N instances with N seeds, hand each model its port, spec, skill, and initial
  credential, feed rungs one at a time until one fails, then run Reach, apply each mutation and
  run Guard, compute Trap and Fidelity from the descriptors, tear down. Three times.
- One Docker image, tagged by version. `docker run -e SEED=42 -p 8080:8080` is the whole setup,
  which matches the official Bruno Docker image and GitHub Action story.

## Tech

Node, single package, no framework beyond the standard library or the smallest router that fits.
Not Python: Bruno's contributors are JavaScript, and "fast" does not matter here because the
model's latency is a thousand times the server's. Deterministic SVG, WAV, and frame generation
is trivial in Node.
Bruno's contributor base is JavaScript and Anoop chose Electron so a contributor can ship in a day.
QUAERE should be the same: one file to read, one seed to change. State lives in memory. Nothing is
persisted between runs, on purpose.

## What gets published per season

- The gauntlet table above, with the season's live set
- The generator, so anyone can spin an instance with any seed
- The difficulty grammar and the skill template
- Per model, per run: the collection it left behind, the full `bru run` transcript, the rung it
  fell off, and the expected-vs-produced artifact pair for that rung
- Rung, Turns, Fidelity, Trap, Time, Cost
- The seeds used, so every result can be rerun byte for byte

## What it is not

- Not a product feature. It is a benchmark harness and a Docker image.
- Not hosted. No public instance anyone can log in to. Anyone who wants one runs the image.
- Not AI. Bruno grades. The model competes. Same framing as `ARENA.md`.
