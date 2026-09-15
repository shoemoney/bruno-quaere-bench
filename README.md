# 🔬 Bruno QUAERE

**Quantitative Unseen Agentic Endpoint Reasoning Evaluation.**
*Latin* quaere, *"to seek, to ask"*, the root of *query*. Pronounced roughly "KWY-reh."

<div align="center">

[![Node 22+](https://img.shields.io/badge/Node-22%2B-39b600?logo=node.js)](package.json)
[![Zero deps](https://img.shields.io/badge/runtime%20deps-0-blue)](package.json)
[![Judge](https://img.shields.io/badge/judge-bru%20run%20%2B%20sha256-orange)](docs/ARCHITECTURE.md)
[![Ladder](https://img.shields.io/badge/ladder-0.6.0%20measured%20%C2%B7%200.9.0%20verified-purple)](docs/ARCHITECTURE.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](package.json)

</div>

> 🚧 **Status, 2026-09-14 evening.** Ladder **0.6.0** is the last version with a clean, fully
> valid round (seven models, below). Ladder **0.7.0**'s first nine-model round found a real bug
> in the benchmark itself: six independent models, six different seeds, all hit the exact same
> wall the instant they reached the new stage-recovery audit check (Addendum S, fixed in 0.7.1).
> Round six found a second undocumented grading rule the same way (Addendum T) — see
> [What 0.8.0 changes](#-what-080-changes). 0.8.0 also moves the graded release chain and a
> clear-out composer down to rungs 20-49, since round five cleared to 49 on five of nine seeds
> with no rung below 50 costing anyone anything.
> **0.8.0 is verified** (2026-09-14): the full suite passed twice in a row (787/787 both runs),
> including the three in-process 100-rung reference climbs, after three self-inflicted failures
> were fixed on the way — the shrinkFloor cap-yield collapse (86c456b), the docsolver missing
> the `:409` audit stage (82d4c44), and the hardcoded test ports that only collided inside the
> full suite (56278e3) — and the pinned answer keys were rebaselined for all three (9e7bb16).
> The reference solver also passes 100/100 on the round-seven seeds (1100, 1101, 1105).
>
> **Round seven ran 0.8.0** (2026-09-14, seeds 1100-1108, seven subscription CLIs plus
> DeepSeek V4.1 Flash direct): astra 48, kimi k3 42, fable 40, qwen3.8-max 39, qwen3.8-flash 23,
> muse 20, deepseek-flash 19 (max 48, median 39, seven distinct fall rungs, not in band). The
> bottom three fell on the audit trail at 20, 21 and 24 and kimi on a wrong hash at 43; those
> four are valid. Astra, fable and qwen3.8-max each fell on the **first** "write the word onto
> that stack" ask their seed drew, and the rule that makes refusing correct (a stated word goes
> only onto the turn-in piece, rule 29's 0.7.0 amendment) was in `docs/RULES-0.8.md`, which the
> docsolver reads, and in nothing the models were given — it was tagged `(task text)`, which
> exempted it from the skill-coverage test, and no rung text stated it. Those three are lower
> bounds, not scores. See `blog/2026-09-14-the-trap-nobody-could-see.md` in the ideas repo.
>
> **0.9.0 is verified** (2026-09-14, Addendum U, `e691c12` + `4401468`): the skill now states the
> placement rule for every rung and every intermediate, a per-act test pins the forbidding
> sentence so no refusal act can enter the pool without one, and the same ask now fires on the
> tier 5 leftover sound and the tier 6 stitched clip from rung 25 (`labelTheLeftover`, one rung in
> two, own sub-seed, so the pinned answer keys did not move). The full suite is 794 tests; runs
> one and three were 794/794 (87 min for run three), run two failed exactly one wall-clock guard
> (`keygen-bounds`, seed 8 answerKey 8325 ms against an 8000 ms budget, 4.3 s uncontended on both
> 0.8.0 and 0.9.0 because png-default seeds render real PNG bytes for the hash; the same test took
> 580 s in the passing run). The reference solver passes 100/100 on seeds 1200, 1201 and 1205.
> **Round eight ran 0.9.0** (2026-09-14 20:07 to 23:02, seeds 1200-1208, same lineup): astra
> **97** (stopped by the 5000-turn budget at 5001 turns, 175 min, no fall), fable 70 (wrong hash
> at 71, 151 min, 4440 turns), qwen3.8-max 39 (refusal at 40, 135 min), muse 24 (audit at 25),
> deepseek-flash 19 (audit at 20), qwen3.8-flash 19 (audit at 20), kimi k3 4 (wrong hash at 5,
> after 42 the round before). Every result has `driverError: null`. CLI rows: max 97, median
> 31.5, six distinct fall rungs, **not in band**. The stated placement rule and the leftover
> refusal at 25-39 stopped nobody: the two frontier models walked straight through it, so the
> round-seven falls at 39-49 were the unstated rule and nothing else. What round eight measures
> is the ladder above 40 with the rule in place: fable's 4440 turns to reach 70 against 651 to
> reach 40 the round before says rungs 40-70 are expensive, not impossible. Next steepen is
> designed from the astra and fable transcripts, not from the fall rungs.
> Every earlier round is kept under its version number, superseded, never rescored. The design
> promise "no current model past rung 30" did not survive contact with 2026 models and is no
> longer claimed.

## 🧒 Like you're five

**Why does this exist?** People keep asking which AI is best, and the usual tests are like
spelling bees: the AI has already seen the words. This is a test where the words are made up
fresh every time, so the only way to win is to actually read and think. It exists so the answer
to "which one is best" is true, not memorized.

**What does it do?** It hands the AI a recipe book that is five hundred pages long, badly
organized, and completely correct, then asks it to cook a hundred dishes that get harder one
after another. A machine tastes every plate and says yes or no; no person and no other AI
ever tastes. Once a dish is wrong, the AI is out, and its score is how far it got.

**What does it use?** One kitchen tool only: Bruno, the little program that sends web requests,
plus a plain notepad to write in. Everything the AI cooks is fake but exact, like a Lego picture
that is the same bricks every time, so the machine can check it brick for brick. Nine different
AIs each get their own kitchen with their own fresh recipe book.

**Why is it hard?** The recipe book has old crossed-out numbers next to the real ones and you
must notice which is newer. Dish forty needs something you cooked at dish twelve and nobody
repeats the measurement. Sometimes the oven changes its own settings and you have to notice.
Sometimes the recipe asks for something the house rules forbid, and the right answer is to say no.

**What should you take from the scores?** How far an AI got is how many hard, checkable things
it did right in a row, with no help and no hints. The gaps between AIs on the same version are
real, and the transcript shows exactly where and why each one fell. Watching the same AI on the
next, harder version tells you whether it reasons or just found a trick.

**What should you not take from them?** One climb is one roll of the dice; the same AI went from
the top to rung five on two different days. Numbers from different ladder versions cannot be
compared, and older versions had bugs of ours that cut good climbs short. A perfect score means
the AI beat this version of the test, not that it is smart in general, and the next version is
built to take that score away.

## 🎯 What it is

A seeded, deterministic **media API** (images, audio, video rendered byte-for-byte from JSON)
plus a **hundred-rung task ladder** written in plain language. An AI agent climbs it using only
the Bruno CLI (`bru`) and a dumb editor, reading a **5 MB deliberately sloppy house-rules
document** whose every fact is correct and buried. The judge is `bru run` plus **sha256 hash
equality** on rendered bytes and, from rung 50 up, the project state and label the task demanded.
No model ever grades anything.

## 📚 Table of contents

| | | |
|---|---|---|
| [🧒 Like you're five](#-like-youre-five) | [📊 Results](#-results) | [🧭 How a climb works](#-how-a-climb-works) |
| [🚦 Gates](#-gates-before-any-paid-climb) | [🖥️ Lineup and drivers](#️-lineup-and-drivers) | [🚀 Quick start](#-quick-start) |
| [⌨️ CLI](#️-cli) | [🪜 Ladder history](#-ladder-history) | [🧠 What 0.8.0 changes](#-what-080-changes) |
| [📁 Layout](#-layout) | | |

## 📊 Results

### Ladder 0.6.0, round four (seeds 700-706, one attempt each, caffeinated, 6 h wall)

| 🏁 | Model | Driver | Rung | Turns | Novel tokens | Wall | Fell on |
|---|---|---|---|---|---|---|---|
| 🥇 | gpt-6-astra | codex CLI | **99, cleared** | 3733 | 0.37M | 66 min | |
| 🥇 | deepseek-flash | direct API | **99, cleared** | 1740 | 0.93M | 96 min | |
| 🥉 | qwen3.8-max | qwen CLI | 74 | 1111 | | 135 min | hash at 75, chain checks true |
| | claude-fable-5.1 | `ai` (Claude Code) | 70 | 1060 | 0.27M | 33 min | its own script's silent error at 71 |
| | gemini-3.8-flash | Google direct | 59 | 1328 | 0.75M | 61 min | drafted the conditional write, never ran it |
| | x-ai/grok-4.6 | OpenRouter | 39 | 504 | 0.25M | 38 min | ignored a page-size anomaly at 40 |
| | kimi-k3 | kimi CLI | 2 | 25 | 0.12M | 9 min | lost a variable handoff, submitted rung 0's hash |

Zero rule violations, zero admin probes, zero resumes across all seven. Every fall was a wrong
hash with both chain checks passing. **One attempt per model is noise** (qwen went 99 on one
ladder and 5 on the next); the published board will be the median of three once a version holds.
`board.md` is regenerated from `runs/` by the CLI and the same data is available as JSON.

### Ladder 0.7.0, round five (seeds 900-909, nine models) — voided by a real bug in the benchmark

Astra, qwen3.8-max, qwen3.8-flash, muse, kimi, and grok-4.6 (six of six that reached the band)
each cleared to rung 49 and fell at 50 with **hash, project state, and label all correct** and
only the new stage-recovery **audit** check wrong. The reference proved rung 50 was passable, and
six independent models converging on the identical failure shape on six different answers was
the tell: the generator required a deliberate out-of-turn stage attempt that the task text only
*warned about*, never *instructed*. A competent agent that read the sentence honestly and did
every stage correctly in order — exactly what the rest of the sentence says to do — could not
pass. Fixed as **Addendum S**: the sentence now instructs the early reach outright when it's
required, and states nothing when it isn't. Every rung-50 fall above is voided, not scored.
A non-JSON gateway error page (Addendum R) separately killed a clean grok-4.6 climb at rung 36
mid-round; the three message-loop drivers now retry that instead of dying on a bare parse error.

<details>
<summary>📜 Superseded rounds (kept, never rescored)</summary>

| Ladder | Round | What it measured | Why superseded |
|---|---|---|---|
| 0.1 | OpenRouter, 7 models | kimi 11, gemini 44, astra 59 (cut by a context bug) | novel-token budget and context trimming did not exist |
| 0.3.0 | native CLIs | astra 24, grok 23, fable 16, deepseek 15, gemini 9, kimi 5, qwen 5 | an undocumented rounding rule decided 28% of resize rungs |
| 0.4.0 | native CLIs | **qwen 99**, kimi 94 (wall), fable 71, gemini 69, grok 59, deepseek 57, astra 29 | rungs differed in size, not kind; one script climbed eighty |
| 0.5.0 | native CLIs | **astra 99**, gemini 59, grok 40, kimi 25; three 59s voided | rung 60's antecedent was unstated; rungs 50+ were graded on scenery |
| 0.6.0 round three | native CLIs | astra 63, fable 52, gemini 43 in 26 minutes each | the laptop slept; void as a ceiling, valid as a rate |

</details>

## 🧭 How a climb works

```mermaid
sequenceDiagram
    autonumber
    participant H as Harness 🎛️
    participant A as Agent 🤖
    participant B as bru CLI
    participant API as Seeded media API 🎨
    participant J as Judge 🔍
    H->>API: start instance (seed, admin token)
    H->>A: TASK.md · spec.json · HOUSE-RULES.md (5 MB) · environments/local.yml
    loop each rung
        A->>B: bru run rungs/current
        B->>API: GET /rungs/current
        A->>B: bru run create · convert · lora · publish …
        B->>API: requests (User-Agent bruno-runtime/*)
        A->>B: bru run submit {assets}
        B->>API: POST /rungs/{n}/submit
        API->>J: hash + project state + label vs answer key
        J-->>H: pass → advance · fail → stop
    end
    H->>H: result.json · transcript.jsonl · board
```

| Axis | What is measured | Where |
|---|---|---|
| 🧠 Advanced reasoning | unit math, rounding order, derived parameters, a skill that overrides the spec | the rung text and the house rules |
| 🔌 API calling | 16 HTTP behaviors, exact parameter fidelity, planted spec lies | the API and the trap column |
| ⏳ Long session | one agent, no subagents, 3M novel-token budget, cross-rung recall, context that outlives the window | the ladder's length and the collection on disk |

**The one rule:** nothing but `bru` opens a socket. A native CLI has a shell, so the rule is
enforced by detection: the API logs every User-Agent, anything that is not `bruno-runtime/*` is
a violation, and `axios/*` from bru's own script sandbox is counted separately. Neither voids a
run silently; both are published.

## 🚦 Gates before any paid climb

| Gate | What it proves | Test |
|---|---|---|
| ✅ Reference climb | a scripted solution clears all 100 rungs on seeds 1, 2, 3 and a fresh seed | `test/reference.test.js` |
| ✅ Clean-room doc-solver | a solver written from the docs alone, never reading the generator, agrees with the key on seeds 1-20 and the round's seed block | `test/docsolver.test.js` |
| ✅ Sandbox fidelity | the reference climbs using only files found in a prepared sandbox | `test/sandbox-fidelity.test.js` |
| ✅ Rules in the document | every skill-marked rule in `docs/RULES-*.md` appears in the clean skill and the 5 MB sloppy one | `test/skill-rules-subset.test.js` |
| ✅ Generation bounds | keys for 300 seeds under 8 s CPU time and 2 MB | `test/keygen-bounds.test.js` |
| ✅ Behaviors | 16 behaviors proven with `bru run` against a live instance | `scripts/run-behaviors.sh` |
| ✅ Rung-0 smoke | every driver produces `result.json` for rung 0 | `--max-rung 0` |

The first two exist because the reference gate is blind to undocumented rules: it shares the
generator's code. Twice it certified rungs no correct agent could pass (a float artifact, then a
hidden rounding). The third exists because the doc-solver proves a key is derivable, not that
the sandbox contains what the docs promise.

## 🖥️ Lineup and drivers

| Model | Driver | Notes |
|---|---|---|
| claude-fable-5-1 | `--driver cli --cli ai` | Claude Code via the `ai` wrapper, fresh `CLAUDE_CONFIG_DIR` |
| gpt-6-astra | `--driver cli --cli codex` | fresh `CODEX_HOME` with only the auth file |
| qwen3.8-max | `--driver cli --cli qwen` | fresh `HOME`, env from `~/.qwen/.env` |
| qwen3.8-flash | `--driver cli --cli qwen` | same adapter/isolation as qwen3.8-max, different `-m` |
| kimi-code/k3 | `--driver cli --cli kimi` | model id must carry the `kimi-code/` prefix |
| gemini-3.8-flash | `--driver google` | the Gemini CLI silently serves 3.5-flash for any 3.8 id |
| deepseek-flash | `--driver deepseek` | the only flash id DeepSeek's API serves |
| x-ai/grok-4.6 | `--driver openrouter` | while the x.ai key is team-blocked |
| muse-spark-1.3-contributor | `--driver cli --cli muse` | fresh `XDG_CONFIG_HOME`/`XDG_DATA_HOME`; usage lives only on disk (the session log), never in `--json` stdout |

Every CLI runs from an isolated home with only its credentials, so no user skills or memories
climb with it. Each adapter records the model the tool actually served; a mismatch voids the run.

| Command | What it checks |
|---|---|
| `node bin/quaere.js doctor [--json] [--no-smoke] [--no-network]` | scans this Mac for every CLI above (login-shell alias resolution, `--version`, a live headless smoke through the same adapters `run` uses), probes every direct-provider key (google/deepseek/xai) and the fallback OpenRouter key against their own APIs so a found-but-blocked key (e.g. an xai key with `team_blocked: true`) is never trusted, and writes `.quaere/settings.json` mapping each lineup id to the driver it should actually run through -- a direct provider driver is only picked when its key actually works, otherwise it falls back to openrouter; `--no-network` skips the key probes; exits non-zero if a lineup CLI is missing or fails its smoke |

## 🚀 Quick start

```bash
npm test                                   # ~30 min, all gates
node bin/quaere.js serve --seed 42         # public + admin ports; admin needs X-Admin-Token
node bin/quaere.js reference --seed 42     # scripted climb, must print 100/100
node bin/quaere.js rung --seed 42 --n 60   # a task in plain language (--answer shows the key)
node bin/quaere.js skill --seed 42 --mode sloppy --bytes 5000000 > HOUSE-RULES.md

# one real climb (keys exported per process; caffeinate so the laptop cannot sleep it away)
caffeinate -i -s node bin/quaere.js run --driver cli --cli codex --model gpt-6-astra \
  --seed 801 --attempts 1 --skill-mode sloppy --skill-bytes 5000000 --wall-ms 21600000
node bin/quaere.js board runs/ > board.md
```

`node --test` exits 0 even when tests fail. Write its output to a file and read the
`# pass` / `# fail` lines; never trust an exit code.

## ⌨️ CLI

| Command | Purpose |
|---|---|
| `serve --seed N [--port P --admin-port A]` | run one seeded instance |
| `spec --seed N` | OpenAPI document, with the seed's planted lies |
| `skill --seed N [--mode clean\|sloppy --bytes B]` | the house rules, clean or 5 MB sloppy |
| `rung --seed N --n K [--answer]` | one task's text, optionally its answer key |
| `reference --seed N [--from A --to B]` | the scripted reference climb |
| `run --driver D [--cli C] --model M --seed N …` | one agent climb; see flags below |
| `board runs/ [--json out.json]` | the board grouped by ladder version |

<details>
<summary>⚙️ <code>run</code> flags</summary>

| Flag | Default | Meaning |
|---|---|---|
| `--attempts` | 1 | fresh-context attempts per model |
| `--budget` | 3000000 | novel-token cap per attempt (output plus new input per turn) |
| `--skill-mode` / `--skill-bytes` | sloppy / 5000000 | which house-rules document the sandbox gets |
| `--wall-ms` | | active-time wall; suspended time (sleep) is excluded |
| `--max-rung` | 99 | stop after this rung passes (smokes use 0) |
| `--max-turns` | 5000 | `bru` requests before `stoppedBecause: turns` |
| `--context-limit` | 160000 | message-loop drivers trim before this many tokens |
| `--max-output-tokens` | 32768 | output budget for reasoning models |

</details>

## 🪜 Ladder history

```mermaid
flowchart LR
    A[0.1 🧪<br/>OpenRouter, harness bugs] --> B[0.3 🧮<br/>exact arithmetic]
    B --> C[0.4 📐<br/>keys follow documented rules<br/>doc-solver gate]
    C --> D[0.5 🧗<br/>cross-rung memory, derived params,<br/>announced mutations, chains]
    D --> E[0.6 🧾<br/>stitch antecedent stated,<br/>chain graded, sandbox fidelity]
    E --> F[0.7 🧠<br/>attacks the replayable solver]
    F --> G[0.8 🪜<br/>obligations move to 20-49]
    G --> H[0.9 🧾<br/>label rule stated to the agent,<br/>leftover refusal from 25]
    style E fill:#2b6,stroke:#333,color:#fff
    style F fill:#96f,stroke:#333,color:#fff
    style H fill:#96f,stroke:#333,color:#fff
```

Every version is a dated addendum in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), which
records each rule and the bug that changed it. The rules the answer key may depend on live in
[`docs/RULES-0.9.md`](docs/RULES-0.9.md).

## 🧠 What 0.7.0 changes

A forensic read of Astra's clear showed **261 lines of Python, written in 23 tool calls, replayed
for the last 51 calls with no new code**. It parsed the rung text with literal regexes, read the
5 MB skill once and cut it to 34 KB by dropping sections by heading name, and never saw a
mutation because all 33 landed on routes its pipeline never read. 0.7.0 breaks each assumption
that made replay possible:

| # | Change | Who pays |
|---|---|---|
| 1 | clause kinds rendered in four or more seeded phrasings; the rules publish obligations, never surface strings | replayers only |
| 2 | mutations land on the fields a solver must parse, re-picked per rung | replayers, and anyone who ignores what came back |
| 3 | ETag, next cursor, Retry-After live in headers only | one-time client fix |
| 4 | dated rule amendments written into the sandbox's skill file at rungs 30, 55, 78 | everyone, a few turns each |
| 5 | true rules planted inside the noise-headed sections a heading filter deletes | heading filters only |
| 6 | regression rungs: rebuild an earlier piece under amended rules | forward-only ledgers |
| 7 | refusal rungs: the text asks for something a house rule forbids; graded by absence | dispatchers that execute every clause |
| 8 | byte-budget search over live responses | everyone, a few turns |
| 9 | short pages under throttle that undercount silently | naive loops |
| 10 | the path is graded: ordered stage audit, HMAC bound to the artifact's digest | one-line HMAC helpers |
| 11 | fresh reels per batch rung, so the top third is hard rather than long | nobody; it returns turns |

Two new board columns, **code writes** and **doc reads**, separate templating from reasoning
better than turns do.

**Postscript, same day.** Round five's own new check — rule 10, "grade the path" — caught a bug
in the benchmark itself before anyone published a number from it: the generator required a
recovery step the task text never asked for, six models failed it identically, and the fix
(Addendum S) is what "no rung publishes a rule the docs don't state" looks like applied to the
benchmark's own build process, not just the models being graded.

## 🧠 What 0.8.0 changes

Round five cleared to rung 49 on five of nine seeds with **no text parser written below rung 49**
— every model transcribed the task by hand — and rung 50, where the graded release chain begins,
was the only rung whose cost tripled for everyone. Nothing in 20-49 held a real obligation.
0.8.0 (Addendum T) is a band-table move, not a new mechanism: the composer and text builder are
already picked by `tier`, not by rung range, so pulling tiers 5-9 down to rungs 20-99 is data.

| # | Change | Effect |
|---|---|---|
| 1 | the graded release chain (render, 409 recovery, HMAC publish, ETag label) moves to 20-39 | rung 50's cost tripling now happens at 20 |
| 2 | a clear-out, ordering batch composer moves to 40-59 | refusal grading now starts at 40, not 70 |
| 3 | announced mutations start at rung 20, not 40, ramping to 0.9 by rung 50 | write-route mutations land well before the release chain does |
| 4 | rule amendments move to rungs 20/30/40/60, each drawn from a rule the NEXT band actually depends on | the round-five rung-30 re-read that cost every model and changed nothing for four of nine seeds can no longer be inert |
| 5 | `recover409` is a per-rung coin flip, not baked in true | render rungs stop being one indistinguishable shape |
| 6 | the two `shapeRect`/`shapeCircle` phrasings that read "N in from the left" as inches are reworded | closes the phrasing hazard behind deepseek's round-five rung-1 fall |
| 7 | a second undocumented grading rule found the same way as Addendum S: the audit trail is graded by EXACT sequence, refusals included — now stated outright (rule 39) | closes the round-six rung-50 fall on muse seed 1008 |

## 📁 Layout

```
src/ladder/      grammar, rung text, reference climb, clean-room doc-solver
src/api/         the seeded media API, admin port, behaviors
src/harness/     drivers (message-loop and native CLI), supervisor, scoring, board
src/render/      deterministic SVG, PNG, WAV, QVID
docs/            ARCHITECTURE.md (contract + addenda), RULES-*.md, SPEC.md, ARENA.md
collections/     the 16-behavior Bruno collection
runs/            results and transcripts per model, seed, attempt (gitignored)
```

---

🐶 *Built as the unseen row of the Bruno API Arena. Latin for "ask"; measured in rungs.*
