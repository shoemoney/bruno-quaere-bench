# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Bruno QUAERE: a seeded, deterministic media API plus a hundred-rung task ladder that AI agents
climb using only the Bruno CLI (`bru`), judged by sha256 hash equality on rendered bytes plus,
from rung 20 up, the project state and label the task demanded. Zero runtime dependencies, Node
22+, ESM. The contract is `docs/ARCHITECTURE.md`; its dated Addenda A through U are the change
log of every rule and every bug that changed a rule. Read the newest addenda first. `docs/SPEC.md`
is the original intent; `docs/RULES-0.9.md` is the plain-language list of every house rule the
answer key may depend on.

## Commands

```bash
npm run lint                         # node --check over bin, src, test
npm test                             # node:test, ~90-95 min measured (0.9.0 run three: 87 min; 794 tests); includes the 100-rung reference climbs
node --test test/<file>.test.js      # one file; ALWAYS write output to a file and grep it:
node --test test/x.test.js > /tmp/x.log 2>&1; grep -E "^# (pass|fail)" /tmp/x.log
bash scripts/run-behaviors.sh        # 16 behaviors proven with bru run against a live instance
node bin/quaere.js reference --seed N [--from A --to B]   # scripted climb, must be 100/100
node bin/quaere.js serve --seed N    # public + admin ports; admin needs X-Admin-Token
node bin/quaere.js rung --seed N --n K [--answer]
node bin/quaere.js skill --seed N [--mode sloppy --bytes 5000000]
node bin/quaere.js board runs/ [--json results.json] > board.md
node bin/quaere.js doctor [--json] [--no-smoke]      # scan every lineup CLI, resolve an openrouter fallback key, write .quaere/settings.json
```

`node --test` exits 0 even when tests fail, and the rtk shell hook mangles its output when
piped into grep. Read the `# pass` / `# fail` lines from a file, never trust an exit code.

## Gates that must stay green before any paid climb

1. `npm test`, including `test/docsolver.test.js` (a clean-room solver written from the docs
   alone agrees with the answer key on seeds 1..20 and 500..540), `test/reference.test.js`,
   `test/keygen-bounds.test.js` (300 seeds under 2 s and 2 MB), `test/sandbox-fidelity.test.js`
   (the reference climbs using only files found in a prepared sandbox), and
   `test/skill-rules-subset.test.js` (every skill-marked rule in RULES appears in the skill).
2. A rung-0 smoke per driver with `--max-rung 0`.
3. Never patch the doc-solver to match undocumented behavior. If it disagrees with the key,
   either the key or the docs are wrong; fix that. Never hand-edit a rung; steepen by changing
   band parameters in `src/ladder/grammar.js` and bump `VERSION` in `src/world.js`.

## Running a calibration round

Climbs are launched from the main session as detached processes, never from workflow subagents
(they get forced to return before a multi-hour run ends and report placeholders):

```bash
# one model; keys come from aigate (google, deepseek) or ./.env (OPENROUTER_API_KEY), exported per process
caffeinate -i -s node bin/quaere.js run --driver <cli|google|openrouter|deepseek> [--cli ai|codex|qwen|kimi|muse] \
  --model <id> --seed N --attempts 1 --skill-mode sloppy --skill-bytes 5000000 --wall-ms 21600000
```

Lineup and drivers: claude-fable-5-1 via `--cli ai`, gpt-6-astra via `--cli codex`, qwen3.8-max and
qwen3.8-flash both via `--cli qwen` (same adapter, different `-m`), kimi-code/k3 via `--cli kimi`
(bare `k3` fails), gemini-3.8-flash via `--driver google` (the Gemini CLI silently serves
3.5-flash), deepseek-flash direct, x-ai/grok-4.6 via OpenRouter while the x.ai key is team-blocked,
and muse-spark-1.3-contributor via `--cli muse` (fresh `XDG_CONFIG_HOME`/`XDG_DATA_HOME`; its
`--json` stdout never carries usage at all, so tokens come only from the session log muse itself
writes under that isolated home -- see src/harness/cli/muse.js). Always `caffeinate`: the laptop slept 26
minutes into round three and voided it. Watch with a `bash -c` loop over
`find runs -path "*/<seed>/1/result.json"`; a zsh `for p in $paths` does not word-split.

Results: `runs/<model>/<seed>/<attempt>/result.json` and `transcript.jsonl` (gitignored). A row
is comparable only with rows from the same `version`. Publish the median of three attempts.

## Things learned the hard way (each is an addendum)

- The reference gate is blind to undocumented rules because it shares the generator's code
  (Addenda G, I); the doc-solver exists for that, and the sandbox-fidelity gate exists because the
  solver proves derivability, not delivery (Addendum L).
- A transport slip is a 422, not a fall; a submission to a non-current rung is a 409 (E, N).
- Kill-on-fall loses the CLI's usage; drain first (G). Reasoning models exhaust a 4K output
  budget silently; use 32K and never append an empty assistant turn (K).
- `axios/*` requests are bru pre-request scripts, not a shell (K). Turns are counted at the API
  by User-Agent `bruno-runtime/` (G).
- Anything the rung text demands must be graded or removed from the text (O) -- and the reverse
  holds too: anything a rung's answer key requires must be an explicit instruction in the task
  text, never a fact only implied by a warning about the consequence of not doing it (S). The
  tell for both directions is the same one that catches undocumented generator rules generally:
  several independent models converging on the identical failure shape on different answers.
- A driver must read a fetch response body as text and parse it, never call `res.json()`
  directly -- a non-JSON gateway error page (an HTML 502/Cloudflare challenge) throws a bare
  `SyntaxError` with no `.status`, invisible to the transient-retry classifier, and kills a clean
  climb instead of retrying it (R).
- `scripts/launch-round.sh`: driver flags must be appended to the args array AFTER the base
  `run ...` args, never prepended -- `run` is a positional subcommand and must stay `argv[0]`, or
  every launch prints the usage banner and exits in under a second while looking like nine climbs
  that started successfully (their PIDs are real, their logs are one line).
- A live check can be stricter than the docs without anyone noticing for a whole version: the
  house grades the audit trail by EXACT sequence, refusals included, and nothing said so until a
  second independent-models-same-wall tell (round six, muse seed 1008) caught it the same way
  Addendum S did (T). Steepening the ladder is a data-only change in `src/ladder/grammar.js`'s
  `BANDS` (`tier`, not array index, selects the composer and text builder) plus the constants
  beside it in `src/world.js`; never hand-edit a rung.
