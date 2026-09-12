# Bruno QUAERE board

| Model | Driver | Rung | Turns | Fidelity | Trap | Novel | Billed | Violations | Resumes | Stop |
|---|---|---|---|---|---|---|---|---|---|---|
| openai/gpt-6-astra | openai/gpt-6-astra | 59 | 446 | 100.0% | 33.3% | 212073 | 41478037 | 0.0 | 0.0 | error |
| deepseek/deepseek-v4-flash-0731 | deepseek/deepseek-v4-flash-0731 | 59 | 983 | 100.0% | 100.0% | 492341 | 119295729 | 0.0 | 0.0 | error |
| google/gemini-3.8-flash | google/gemini-3.8-flash | 44 | 608 | 98.7% | 66.7% | 318004 | 61821372 | 0.0 | 0.0 | fail |
| deepseek-flash | deepseek | 28 | 138 | 91.9% | 33.3% | 143527 | 12020096 | 0.0 | 0.0 | fail |
| grok-4.6 | xai | 27 | 288 | 99.6% | 100.0% | 138467 | 27257128 | 0.0 | 0.0 | fail |
| gemini-3.8-flash | cli:gemini | 16 | 69 | 92.8% | 66.7% | 0 | 0 | 0.0 | 0.0 | fail |
| gpt-6-astra | cli:codex | 15 | 0 | 99.4% | 91.7% | 127795 | 5593779 | 0.0 | 1.5 | fail |
| moonshotai/kimi-k3 | moonshotai/kimi-k3 | 11 | 83 | 100.0% | 50.0% | 87122 | 4433321 | 0.0 | 0.0 | error |
| kimi-code/k3 | cli:kimi | 3 | 23 | 98.9% | 66.7% | 80189 | 80189 | 0.0 | 0.0 | fail |
| anthropic/claude-sonnet-5 | anthropic/claude-sonnet-5 | 2 | 63 | 89.5% | 0.0% | 1905687 | 1905687 | 0.0 | 0.0 | fail |
| x-ai/grok-4.20-multi-agent | x-ai/grok-4.20-multi-agent | -1 | 1 | 0.0% | 0.0% | 0 | 0 | 0.0 | 0.0 | error |
| claude-fable-5-1 | cli:ai | -1 | 12 | 95.2% | 50.0% | 0 | 0 | 0.0 | 0.0 | fail |
| anthropic/claude-fable-5.1 | anthropic/claude-fable-5.1 | -1 | 26 | 0.0% | 50.0% | 69460 | 1121663 | 0.0 | 0.0 | fail |
| undefined | undefined | undefined | undefined | NaN% | NaN% | 0 | 0 | 0.0 | 0.0 | undefined |

## Expected vs produced at the fall rung

- **openai/gpt-6-astra**: stopped (error) after clearing rung 59
- **deepseek/deepseek-v4-flash-0731**: stopped (error) after clearing rung 59
- **google/gemini-3.8-flash**: fell at rung 45 -- expected [93510573ab646778aaa90e032cd953affb8fd86d25561df14c5ee083ca9282a5], produced [aa9b1bef26974a386d99d5b0bbbe1b882eee5420f7c6d91b5bf06a6257150a9f] (fidelity 38.6%)
- **deepseek-flash**: fell at rung 29 -- expected [7302fc180e4107cf4c2269e2a3089e9471f450470c0955b32baa00cbe04bdf56], produced [5b6b83d65a4982d549821e01ee32856556af3b372008f4ab5c176a8557382d19] (fidelity 77.8%)
- **grok-4.6**: fell at rung 28 -- expected [fe168c50aa8d8a1e25b5c83b8f3ea7a040f752ab3a515459dc03c014aa494335], produced [2b35ca84a82480481d052e20dc958830b525e6d2ec1cc1f3dc4a27a21c3fef83] (fidelity 89.5%)
- **gemini-3.8-flash**: fell at rung 17 -- expected [8f441561929e738c6e0acf25a539016b76cab9d37fc0918004141c118217a080], produced [fd39264596ceff5c0356d9d3d5a6e3973023a71c04df8f921bc313c9a335a9f0] (fidelity 71.4%)
- **gpt-6-astra**: fell at rung 16 -- expected [c9feade0326d2b5bc334c7d78d63c12b5d5122834088dbf73446df9c1ba05b14], produced [3e62727c684c24b8327fbccf92fb3881758521ea9d7201f482841f27a41ee19f] (fidelity 78.8%)
- **moonshotai/kimi-k3**: stopped (error) after clearing rung 11
- **kimi-code/k3**: fell at rung 4 -- expected [93d23a9bfe0069bab8ebfe6068d873f73641f1e45553de3f9fe741deb32e4a85], produced [9fda2fd82b45a73e63a7e4560a4ae8c3db7b6ccb42341d37b4fc633069da43e7] (fidelity 94.4%)
- **anthropic/claude-sonnet-5**: fell at rung 3 -- expected [1156febfe003a96a02bb671eadb7e0ca8e37d921380657a57fad040f05fe1f21], produced [eca23715e1291388c02062df41c1612acea4becadf0465f1c7f68dd151bf8bf1] (fidelity 57.9%)
- **x-ai/grok-4.20-multi-agent**: stopped (error) after clearing rung -1
- **claude-fable-5-1**: fell at rung 0 -- expected [8e66f44dd4488bab31774fce5e0fdc8e874302a0f394ff006a20019a9599f848], produced [d2d76f696baecb647e0cb32d9b85f7d20ea6a3379aedf545819ed5895de88aa3] (fidelity 95.2%)
- **anthropic/claude-fable-5.1**: fell at rung 0 -- expected [86099182a28c743de8780cde231ac3a1a795ca7791e731fe95c65e692fcebd14], produced [] (fidelity 0.0%)
- **undefined**: stopped (undefined) after clearing rung undefined

## 🔬 Calibration Rounds

### Round 1: OpenRouter (Superseded)
Round 1 results with OpenRouter providers are superseded by round 2. Ladder version 0.1.0 discovered bugs in the harness and generator. Results: kimi-k3 rung 11, gemini-3.8-flash rung 44, gpt-6-astra rung 59 (interrupted by harness context bug), fable voided, grok voided.

### Round 2: Native CLI Drivers

#### claude-fable-5-1 (cli:ai)
- **Fall rung**: 0 (seed 220)
- **Rungs cleared**: none (fell on first submission)
- **Turns**: 12
- **Tokens**: novel 0, billed 0
- **Violations**: 0
- **Resumes**: 0
- **Stop reason**: fail

**Why it fell**: Harness float bug in `src/seed.js` → `src/ladder/grammar.js` roundOnGrid() + `src/skill.js` dpi conversion. Seed 220 rules specify `dpi=300, roundMode=up, roundTo=2`. Rung 0 asks for "0.33 by 0.56 in". Model correctly dug dpi=300 out of the 5 MB skill, applied ceil-to-even correctly, and submitted `width=100 height=168` (exact arithmetic). Expected answer: `height=170` because `0.56 * 300 = 168.00000000000003` in IEEE-754, so `Math.ceil(168.00000000000003 / 2) * 2 = 170`. A rung with no correct solution is a generator bug. **Fix**: src/ladder/grammar.js px conversion needs epsilon snap (round raw px to ~1e-6 before ceil) before seed 220 is used for calibration.

**Blockers resolved**: 
- Stale fixture (test/harness.test.js). NOW: accumulates created ids in `made[]` and submits `made[0]` to rung 3 as a resolvable-but-wrong input.
- Usage parsing (src/harness/cli/ai.js parseUsage()). NOW: newer `ai` CLI emits `--output-format json` as a stream array of events rather than a single result object. normalizes: if Array.isArray, take the last `result` event.
- Process kill path (src/harness/run-cli.js). NOW: when supervise.js SIGKILLs a fall/top/wall, the child never prints JSON. Sets `usage = {}` and `usageEstimated = true` so killedFor handling sets stoppedBecause without crashing on undefined usage.

#### gpt-6-astra (cli:codex)
- **Fall rung**: 59 (seed 221, cleared all 60 rungs with fidelity 1.0)
- **Rungs cleared**: 0-59
- **Turns**: 0 (login shell PATH rebuild; real usage via Python wrapper generating .bru files)
- **Tokens**: novel 255,589, billed 11,187,557
- **Violations**: 0
- **Resumes**: 3 (recovered once per resume; no new failures)
- **Stop reason**: stalled
- **Wall time**: 1,187,694 ms (~19.8 min)

**Why it fell**: Harness bug in `src/harness/supervise.js` submissions baseline reset per spawn. On each resume, superviseProcess locally re-initialized `submissions = []`, re-read /admin/submissions (seeing all 60 prior submissions as "fresh"), and called POST /admin/rungs/advance once for each. Result: `state.rungs.current` went 60 → 120 → 180 → 240 while answer key only covers 0-99. GET /admin/rungs response served `{"n":180,"text":""}` and later `{"n":240,"text":""}`. Agent correctly recognized the conflict, asked for a restore, and wrote STATUS.md instead of fabricating. Three resumes with no forward progress → stalled. **Fix**: src/harness/supervise.js now accepts caller-supplied baseline (allSubmissions.length at first spawn) instead of resetting to [] per spawn.

**Harness fixes in this round**:
- src/harness/run-cli.js:197 — runDir now `path.resolve(...)` not `path.join(...)`. Run got `-C runs/gpt-6-astra/221/1/sandbox` while cwd was already sandbox; relative path resolved against itself → `ENOENT` in ~220 ms, no JSON.
- src/harness/cli/index.js loadAdapter() — NOW includes `copyAuth`. run-cli.js:256 calls `adapter.copyAuth(homeDir)` before first spawn so CODEX_HOME gets a ~/.codex/auth.json copy.
- src/harness/run-cli.js:~318 — parseUsage throw no longer crashes before result.json is written. Records `usage-parse-error` transcript entry with exit code and stderr tails, ends climb as stoppedBecause "error".
- Added `spawn` transcript entry logging cmd/args/cwd/env, exposing the relative-path bug.

#### gemini-3.8-flash (cli:gemini)
- **Fall rung**: 17 (seed 220)
- **Rungs cleared**: 0-16
- **Turns**: 69
- **Tokens**: novel 0, billed 0
- **Violations**: 0
- **Resumes**: 0
- **Stop reason**: fail

**Why it fell**: Task reasoning, not tooling. Rung 17 text: "Make a picture 1.08 by 2.26 INCHES ... then resized so it comes out 217 by 206 pixels". Answer key expects raw figures with unit tag: `{"width":1.08,"height":2.26,"unit":"in"}`, letting server do dpi conversion. Model applied server dpi rules client-side and submitted processed pixel dimensions instead of raw inches. Mean fidelity rungs 0-16: 0.928. Trap 0.667 (caught 2 of 3 traps in that band).

**Steepened after**: Clarified rung 17 spec to rule out client-side unit conversion; tightened skill section on unit handling with explicit examples.
