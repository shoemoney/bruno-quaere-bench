# Bruno QUAERE board

## Ladder version 0.3.0 (current)

| Model | Driver | Seed | Rung | Turns | Fidelity | Trap | Novel | Billed | Violations | Resumes | Stop |
|---|---|---|---|---|---|---|---|---|---|---|---|
| gpt-6-astra | cli:codex | 311 | 24 | 124 | 99.6% | 50.0% | 122372 | 5553284 | 0.0 | 0.0 | fail |
| grok-4.6 | xai | 315 | 23 | 181 | 100.0% | 20.0% | 141620 | 18439250 | 0.0 | 0.0 | error |
| claude-fable-5-1 | cli:ai | 310 | 16 | 91 | 97.1% | 75.0% | 98986 | 103472 | 0.0 | 0.0 | fail |
| deepseek-flash | deepseek | 316 | 15 | 176 | 97.1% | 100.0% | 145019 | 17194730 | 0.0 | 0.0 | fail |
| gemini-3.8-flash | cli:gemini | 313 | 9 | 56 | 99.7% | 83.3% | 76930 | 215125 | 0.0 | 0.0 | fail |
| qwen3.8-max | cli:qwen | 312 | 5 | 39 | 94.6% | 75.0% | 135863 | 4343756 | 0.0 | 0.0 | fail |
| k3 | cli:kimi | 314 | -1 | 0 | 41.7% | 100.0% | 51825 | 2341617 | 0.0 | 1.5 | stalled |

#### Expected vs produced at the fall rung

- **gpt-6-astra** (cli:codex, seed 311): fell at rung 25 -- expected [a58f7085a9f6c2cd97fcf908e388bff4296aeee9f8d1071d88d0c98a8bd2180a], produced [887d3ee32fd0fd6dbd3a89b531f98e5c050d2806cefe718143f646df2e3f82cd] (fidelity 88.4%)
- **grok-4.6** (xai, seed 315): stopped (error) after clearing rung 23
- **claude-fable-5-1** (cli:ai, seed 310): fell at rung 17 -- expected [bb8b3a59ef074ea123174295e36c7e2b1d655bc53b393a32de441db534dc7679], produced [a6aa0a2f60c05bea9031228eebbf89b7e1c75e401ab46a8914d06e6a944a491c] (fidelity 48.6%)
- **deepseek-flash** (deepseek, seed 316): fell at rung 16 -- expected [8d02ea08ca75c6735daf4c52b9c30105b27b827d72ff0224f04a1350597eb810], produced [db8b16fd06ebb42463b6095476be552813bdd41d04c700b837a8b8e72654ba55] (fidelity 50.0%)
- **gemini-3.8-flash** (cli:gemini, seed 313): fell at rung 10 -- expected [9d94d3f2ac0a808a0fc002b287402ffddfaebca594f5d63a5e3aacd0078fca43], produced [95d31aaf56f6b0976043a3dd32ec544ee00c2cfadf933b4842ddc0d1409b4f7a] (fidelity 96.4%)
- **qwen3.8-max** (cli:qwen, seed 312): fell at rung 6 -- expected [2da0f87d41ef9394ff1e62ad851978017273e97911c900f69d106860890ac803], produced [e9ba69e402251b36d47adc6e2687a67b3421957b162825b9f863a115f2449bbc] (fidelity 61.9%)
- **k3** (cli:kimi, seed 314): stopped (stalled) after clearing rung -1

## Superseded

### Ladder version unknown

| Model | Driver | Seed | Rung | Turns | Fidelity | Trap | Novel | Billed | Violations | Resumes | Stop |
|---|---|---|---|---|---|---|---|---|---|---|---|
| gpt-6-astra | cli:codex | 221 | 59 | 0 | 100.0% | 100.0% | 255589 | 11187557 | 0.0 | 3.0 | stalled |
| openai/gpt-6-astra | openai/gpt-6-astra | 111 | 59 | 446 | 100.0% | 33.3% | 212073 | 41478037 | 0.0 | 0.0 | error |
| deepseek/deepseek-v4-flash-0731 | deepseek/deepseek-v4-flash-0731 | 114 | 59 | 983 | 100.0% | 100.0% | 492341 | 119295729 | 0.0 | 0.0 | error |
| google/gemini-3.8-flash | google/gemini-3.8-flash | 112 | 44 | 608 | 98.7% | 66.7% | 318004 | 61821372 | 0.0 | 0.0 | fail |
| deepseek-flash | deepseek | 226 | 28 | 138 | 91.9% | 33.3% | 143527 | 12020096 | 0.0 | 0.0 | fail |
| grok-4.6 | xai | 225 | 27 | 288 | 99.6% | 100.0% | 138467 | 27257128 | 0.0 | 0.0 | fail |
| gemini-3.8-flash | cli:gemini | 223 | 16 | 69 | 92.8% | 66.7% | 0 | 0 | 0.0 | 0.0 | fail |
| gpt-6-astra | cli:codex | 230 | 15 | 0 | 98.8% | 83.3% | 0 | 0 | 0.0 | 0.0 | fail |
| moonshotai/kimi-k3 | moonshotai/kimi-k3 | 115 | 11 | 83 | 100.0% | 50.0% | 87122 | 4433321 | 0.0 | 0.0 | error |
| kimi-code/k3 | cli:kimi | 224 | 3 | 23 | 98.9% | 66.7% | 80189 | 80189 | 0.0 | 0.0 | fail |
| anthropic/claude-sonnet-5 | anthropic/claude-sonnet-5 | 11 | 2 | 63 | 89.5% | 0.0% | 1905687 | 1905687 | 0.0 | 0.0 | fail |
| qwen3.8-max | cli:qwen | 5 | 0 | 7 | 100.0% | 100.0% | 0 | 0 | 0.0 | 0.0 | top |
| x-ai/grok-4.20-multi-agent | x-ai/grok-4.20-multi-agent | 113 | -1 | 1 | 0.0% | 0.0% | 0 | 0 | 0.0 | 0.0 | error |
| claude-fable-5-1 | cli:ai | 220 | -1 | 12 | 95.2% | 50.0% | 0 | 0 | 0.0 | 0.0 | fail |
| anthropic/claude-fable-5.1 | anthropic/claude-fable-5.1 | 110 | -1 | 26 | 0.0% | 50.0% | 69460 | 1121663 | 0.0 | 0.0 | fail |

#### Expected vs produced at the fall rung

- **gpt-6-astra** (cli:codex, seed 221): stopped (stalled) after clearing rung 59
- **openai/gpt-6-astra** (openai/gpt-6-astra, seed 111): stopped (error) after clearing rung 59
- **deepseek/deepseek-v4-flash-0731** (deepseek/deepseek-v4-flash-0731, seed 114): stopped (error) after clearing rung 59
- **google/gemini-3.8-flash** (google/gemini-3.8-flash, seed 112): fell at rung 45 -- expected [93510573ab646778aaa90e032cd953affb8fd86d25561df14c5ee083ca9282a5], produced [aa9b1bef26974a386d99d5b0bbbe1b882eee5420f7c6d91b5bf06a6257150a9f] (fidelity 38.6%)
- **deepseek-flash** (deepseek, seed 226): fell at rung 29 -- expected [7302fc180e4107cf4c2269e2a3089e9471f450470c0955b32baa00cbe04bdf56], produced [5b6b83d65a4982d549821e01ee32856556af3b372008f4ab5c176a8557382d19] (fidelity 77.8%)
- **grok-4.6** (xai, seed 225): fell at rung 28 -- expected [fe168c50aa8d8a1e25b5c83b8f3ea7a040f752ab3a515459dc03c014aa494335], produced [2b35ca84a82480481d052e20dc958830b525e6d2ec1cc1f3dc4a27a21c3fef83] (fidelity 89.5%)
- **gemini-3.8-flash** (cli:gemini, seed 223): fell at rung 17 -- expected [8f441561929e738c6e0acf25a539016b76cab9d37fc0918004141c118217a080], produced [fd39264596ceff5c0356d9d3d5a6e3973023a71c04df8f921bc313c9a335a9f0] (fidelity 71.4%)
- **gpt-6-astra** (cli:codex, seed 230): fell at rung 16 -- expected [c9feade0326d2b5bc334c7d78d63c12b5d5122834088dbf73446df9c1ba05b14], produced [3e62727c684c24b8327fbccf92fb3881758521ea9d7201f482841f27a41ee19f] (fidelity 78.8%)
- **moonshotai/kimi-k3** (moonshotai/kimi-k3, seed 115): stopped (error) after clearing rung 11
- **kimi-code/k3** (cli:kimi, seed 224): fell at rung 4 -- expected [93d23a9bfe0069bab8ebfe6068d873f73641f1e45553de3f9fe741deb32e4a85], produced [9fda2fd82b45a73e63a7e4560a4ae8c3db7b6ccb42341d37b4fc633069da43e7] (fidelity 94.4%)
- **anthropic/claude-sonnet-5** (anthropic/claude-sonnet-5, seed 11): fell at rung 3 -- expected [1156febfe003a96a02bb671eadb7e0ca8e37d921380657a57fad040f05fe1f21], produced [eca23715e1291388c02062df41c1612acea4becadf0465f1c7f68dd151bf8bf1] (fidelity 57.9%)
- **qwen3.8-max** (cli:qwen, seed 5): cleared all 100 rungs
- **x-ai/grok-4.20-multi-agent** (x-ai/grok-4.20-multi-agent, seed 113): stopped (error) after clearing rung -1
- **claude-fable-5-1** (cli:ai, seed 220): fell at rung 0 -- expected [8e66f44dd4488bab31774fce5e0fdc8e874302a0f394ff006a20019a9599f848], produced [d2d76f696baecb647e0cb32d9b85f7d20ea6a3379aedf545819ed5895de88aa3] (fidelity 95.2%)
- **anthropic/claude-fable-5.1** (anthropic/claude-fable-5.1, seed 110): fell at rung 0 -- expected [86099182a28c743de8780cde231ac3a1a795ca7791e731fe95c65e692fcebd14], produced [] (fidelity 0.0%)


## Calibration rounds

### Ladder version 0.3.0

**Round 1**: Seed 310–315 (six models) ran native against ladder 0.3.0 in parallel (wall clock ~14 hours total, staggered launches 2026-09-11).

| Model | Driver | Fall Rung | Turns | Novel Tokens | Billed Tokens | Violations | Resumes | Reason |
|---|---|---|---|---|---|---|---|---|
| **gpt-6-astra** | cli:codex | 25 | 124 | 122,372 | 5,553,284 | 0 | 0 | Task reasoning: API pipeline correct (5×HTTP 201/200), but final asset content (shape/style/opacity) diverged from reference despite dimension math being exact at every stage — caught by content-hash mismatch (fidelity 88.4%). |
| **claude-fable-5-1** | cli:ai | 17 | 91 | 98,986 | 103,472 | 0 | 0 | Task reasoning: house-rules interpretation failure. Model executed technically perfect API flow but produced spec-mismatched content; likely misread dated-decoy clause in 5MB sloppy HOUSE-RULES.md. |
| **deepseek-flash** | deepseek | 16 | 176 | 145,019 | 17,194,730 | 0 | 0 | Task reasoning: fell one rung before gpt-6-astra's failure point. |
| **gemini-3.8-flash** | cli:gemini | 10 | 56 | 76,930 | 215,125 | 0 | 0 | Tooling slip: built asset correctly (POST returned 201 w/ exact hash match), but reused stale asset id from prior rung in submit call instead of fresh id — off-by-one copy-paste in template. Model reasoning was sound; execution stumbled. |
| **qwen3.8-max** | cli:qwen | 5 | 39 | 135,863 | 4,343,756 | 0 | 0 | In-progress at forced finalization (3hr wall, Monitor task still armed). |
| **grok-4.6** | xai | 23 | 181 | 141,620 | 18,439,250 | 0 | 0 | Stopped (error) after clearing rung 23. |

**Pre-run fix (k3)**: kimi CLI adapter (src/harness/cli/kimi.js) passed `--model k3` bare, but kimi-code's config.toml namespaces models under "kimi-code/" prefix. First attempt died immediately with "Model 'k3' is not configured" (rung -1, 0 turns, 3 resumes, stalled). Fixed resolveModelAlias() in adapter; moved dead run to runs/k3/314/1-failed-modelalias/ and reran.

| Model | Driver | Fall Rung | Turns | Novel Tokens | Billed Tokens | Violations | Resumes | Reason |
|---|---|---|---|---|---|---|---|---|
| **k3** | cli:kimi | 6 | 32 | 103,589 | 4,683,173 | 0 | 0 | Tooling slip (post-fix, rerun attempt): at rung 6, model created fresh asset (POST 201, id "43", hash exact-match). But submit call reused prior rung's asset id (41) instead of the fresh one — one tool call off. Model understood task; execution templating error. (harnessBug=true pre-run from kimi.js fix, harnessBug=false on this attempt.) |

#### Steepening applied post-round-1

After gpt-6-astra reached rung 25 (fell at 25 with high fidelity 88.4%), the lowest effective floor across all models was gemini-3.8-flash at rung 10, with k3/qwen in single digits. **Ladder must be steep:** most of the signal came from the top 2 models (gpt-6-astra, grok in older round); mid-tier models (claude-fable, deepseek) clustered rung 15–17. No model had rungs 18–24 before gpt-6-astra probed them.

**Action:** Post-round-1, steepen rungs 10–20 (increase trap complexity and dimension/constraint nesting) so mid-tier models encounter failure points closer to the ceiling rather than a long tail of trivial rungs. This prevents stalls from platform/driver issues looking like model reasoning gaps.

