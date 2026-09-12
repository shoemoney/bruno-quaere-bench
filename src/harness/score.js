// RunResult[] -> board rows. Pure and synchronous: no filesystem here (board.js owns reading
// result.json files off disk).

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function groupByModel(results) {
  const byModel = new Map();
  for (const r of results) {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push(r);
  }
  return byModel;
}

// The run whose rung is the median of the group. Runs sort by rung then turns so that with an
// even count we deterministically pick the lower-middle run, and "turns at that rung" is always
// an actual run's turn count, never an interpolated one.
export function medianRun(runs) {
  const sorted = [...runs].sort((a, b) => a.rung - b.rung || a.turns - b.turns);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

// Older result.json files (pre-Addendum-D) never recorded tokensNovel/tokensBilled/trims; fall
// back to the billed total (tokensIn + tokensOut) and zero trims rather than propagate NaN.
function billedOf(r) {
  return (r.tokensIn || 0) + (r.tokensOut || 0);
}

// scoreModel(model, runs) -> {model, rung, turns, fidelity, trap, novel, billed, trims, wallMs}
export function scoreModel(model, runs) {
  const rep = medianRun(runs);
  return {
    model,
    rung: rep.rung,
    turns: rep.turns,
    fidelity: mean(runs.map((r) => r.fidelity)),
    trap: mean(runs.map((r) => r.trap)),
    // Addendum D: Novel is what the 3M budget is spent against; Billed is what the provider
    // actually charges (cumulative resend included).
    novel: mean(runs.map((r) => (r.tokensNovel != null ? r.tokensNovel : billedOf(r)))),
    billed: mean(runs.map((r) => (r.tokensBilled != null ? r.tokensBilled : billedOf(r)))),
    trims: mean(runs.map((r) => r.trims || 0)),
    wallMs: mean(runs.map((r) => r.wallMs)),
  };
}

// scoreRuns(RunResult[]) -> board row per model, per ARCHITECTURE.md's score.js contract.
export function scoreRuns(results) {
  const byModel = groupByModel(results);
  return [...byModel.entries()].map(([model, runs]) => scoreModel(model, runs));
}
