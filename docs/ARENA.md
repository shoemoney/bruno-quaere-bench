# API Arena

A recurring public benchmark where AI models compete to write Bruno collections against real APIs,
and Bruno's own test runner is the judge. Reruns on every model launch. Publishes the board, the
prompt, the collections, and the cost.

## What it is for

- **Awareness.** A model launch is the one day developers go looking for comparisons. Having a
  board up within 48 hours puts Bruno in that news cycle every time, for free.
- **The BYOK question.** Bruno's assistant is bring-your-own-key. "Which key do I plug in" is a
  real user question. The arena is the published answer, and it changes with every rerun.
- **A CLI ad.** The methodology page is a `bru run` tutorial. Every published collection is a
  worked example of tests and assertions in a Bruno collection.
- **Vendor naming.** APIs that score well get named on the board. That is the hook that makes a
  vendor want a Bruno Score badge (see `FLYWHEEL.md`).

## The lines it must not cross

- **Bruno grades, models compete.** Nothing in the arena adds AI to the product. It uses the
  product to measure AI. Say it that way every time (issue #9010 context in `CONTEXT.md`).
- **No user data, no server.** Runs happen on the operator's machine. Outputs are text files in a
  git repo. A reader can rerun any result with `bru run`.
- **Bring your own key applies to the arena too.** Model access is through the operator's own
  keys. Bruno never proxies a model call.
- **Second pitch, not first.** The Bruno Score badge leads. The arena is the press engine behind it.

## The task

Each contestant gets the same three inputs and must produce one output.

| Input | What it is |
|---|---|
| Spec | The vendor's OpenAPI document, unmodified |
| Sandbox | A base URL for a running instance of the API, with a working credential in a Bruno environment file |
| Prompt | One fixed prompt, published verbatim, unchanged between models in the same run |

Output: a Bruno collection on disk with at least one request per operation the model chose to
cover, each with tests. The collection must load in Bruno and run under `bru run`.

Tiers:

- **Blind (v0).** The model sees the spec and writes the collection in one shot. No network.
- **Probe (v1).** The model may send requests to the sandbox before submitting. Turn cap and
  request cap are published. This is the agentic tier and the one that eventually matters.

## Scoring

Three numbers per collection, two of them scored.

| Name | Definition | Range |
|---|---|---|
| Reach | Share of spec operations that have a request returning the status the spec says it should | 0 to 100 |
| Guard | Share of injected breaks the collection's tests catch (see mutations below) | 0 to 100 |
| Cost | Wall clock, tokens in and out, dollars at list price | reported, not scored |

**Arena Score = Reach × Guard / 100.**

A collection that hits every endpoint and asserts nothing scores 0. A collection with perfect
tests on a tenth of the API scores 10. The product punishes the two easy ways to game a test
count: covering endpoints without asserting, and asserting `status 200` on everything.

### Mutations

After the clean run, the sandbox is broken on purpose, one break at a time, and the collection is
rerun. A break is caught if at least one test that passed clean now fails.

1. Status code changed on one operation (200 to 500)
2. Required field dropped from a response body
3. Field renamed in a response body
4. Field type changed (string to number)
5. Auth rejected (valid credential returns 401)
6. Pagination broken (next cursor never advances)

Breaks are applied by a mutating proxy in front of the sandbox, so the same mutation set works for
a local API and a vendor test mode. The mutation list is public and fixed for a season.

### Fairness

- Same prompt, same spec, same sandbox snapshot, same environment file for every model in a run.
- Three attempts per model, median score reported, all three collections published.
- Temperature and any reasoning settings published per model.
- Model identified by the exact version string the provider returns, never the marketing name.
- A model that produces a collection Bruno cannot load scores 0 for that attempt and the load
  error is published.

## Cadence

- **Launch runs.** Within 48 hours of any major model release, rerun the full board with the new
  model added. This is the awareness event.
- **Season runs.** Once a month, rerun everything. Season boundaries are when the API list, the
  mutation list, or the prompt changes. Old seasons stay published, never rescored.
- **Regression day.** When a vendor on the list ships a breaking change, rerun every model's last
  collection against the new version. The board that day is "who wrote tests that caught it."

## What gets published

One git repo per season. Everything is text, so it fits the product's own argument.

- `board.md` sorted by Arena Score, with Reach, Guard, and Cost columns
- `prompt.md`, the exact prompt
- `apis/<vendor>/spec.yaml`, `env.yml` with placeholders, `mutations.yml`
- `runs/<model-version>/<vendor>/attempt-{1,2,3}/`, each a loadable Bruno collection
- `results/<model-version>.json` from `bru run --reporter-json`, clean and per mutation
- `methodology.md`, which is the CLI tutorial

Elite Retreat rule: methodology is public before the run, results are published all at once when
the board is up, nobody outside the run sees raw failures early.

## First six APIs

Chosen for a public OpenAPI spec and a sandbox the operator controls, so mutations are honest.

The suite deliberately mixes two kinds of API. **Seen** APIs are in every model's training data;
a model can write a passable Stripe collection with the spec closed, so those rows measure recall.
**Unseen** APIs have no meaningful presence in any training set, so the only way to score is to
read the spec and understand it. The gap between a model's seen and unseen scores is a headline
result on its own: a model at 90 on Stripe and 30 on otari memorized Stripe, and that is what a
Bruno user will get when they point the assistant at their own internal API. Every season adds at
least one fresh unseen API that no model has trained on yet.

| API | Kind | Why | Sandbox |
|---|---|---|---|
| Bruno QUAERE (`QUAERE.md`) | unseen, permanent | Purpose-built and seeded per run, so it can never enter training data; spec lies on purpose, mutations native, one instance per model | local, one process per model |
| otari (Mozilla AI) | unseen | Near-zero training presence, 162-path spec, runs locally, and a hand-written control collection already exists at `~/Projects/resume/demos/bruno-otari` | local |
| Ollama | seen | Ships `openapi.yaml`, runs locally, the local-model crowd is Bruno's crowd | local |
| LiteLLM | seen | Ships `openapi.json`, runs locally, big surface area | local |
| Stripe | seen | The API every vendor copies, Ryan already maintains a collection | test mode behind the mutating proxy |
| GitHub REST | seen | Universally known, Ryan already maintains a collection | real API with a scoped token, behind the proxy |

Next in line, from `FLYWHEEL.md` targets: Anthropic, OpenAI, Twilio, Auth0, Supabase, Neon,
Resend, Clerk, Scalekit, mcpd.

## Game formats

Promoted from the parking lot in `IDEAS-API-NATIVE.md`. Each is a special run with its own board.

- **Relay.** Model 2 inherits Model 1's collection and must extend it without breaking it. Score
  is the delta. Contamination is the story.
- **Blind spec.** Models get the sandbox and no spec. The produced collection is diffed against
  the vendor's own. Only meaningful on unseen APIs; on a seen one it measures memory.
- **Regression day.** Described under cadence. The only format that needs no new run, just a
  vendor shipping a change.
- **Contract Fight Club.** Model A implements the API from the spec, Model B writes the collection
  that tries to break it, Model C audits. Expensive. Season finale material, not monthly.

## v0 in one evening

Everything below already exists on this machine except the harness script.

1. Start otari locally. Point `environments/local.yml` at it.
2. Prompt four models (one key each from aigate) with the spec and the fixed prompt. Save each
   answer as a collection directory.
3. `bru run --env local --reporter-json` on each. That is Reach.
4. Put a mutating proxy in front of otari, apply the six breaks, rerun each. That is Guard.
5. Fill in the board by hand. Four rows is enough to walk into the room with.

The vendor collection (8 requests, 16 tests, 25 assertions, all green) is the control row.
If no model beats the hand-written control on Guard, that is a finding worth publishing on its own.

## Risks

- **Framing.** One headline that reads "Bruno adds AI benchmark" feeds the remove-all-AI crowd.
  Every public sentence says Bruno is the judge.
- **Gaming.** Models will learn to write `expect(res.status).to.equal(200)` on everything.
  Guard exists for this. Mutation list rotates each season.
- **Cost.** Probe tier against five APIs times three attempts times ten models adds up. Publish
  the bill. It is part of the result and part of the story.
- **Spec drift.** A vendor changes their spec mid-season. Pin the spec file in the season repo,
  note the drift, rescore only at the season boundary.
- **It becomes a product.** The arena stays a published result and a script. The moment it wants
  a server, an account, or a hosted dashboard, it has crossed the line in `CONTEXT.md`.
