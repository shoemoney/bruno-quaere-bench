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

// scoreModel(model, runs) -> {model, rung, turns, fidelity, trap, tokens, wallMs, cost}
export function scoreModel(model, runs) {
  const rep = medianRun(runs);
  return {
    model,
    rung: rep.rung,
    turns: rep.turns,
    fidelity: mean(runs.map((r) => r.fidelity)),
    trap: mean(runs.map((r) => r.trap)),
    tokens: mean(runs.map((r) => r.tokensIn + r.tokensOut)),
    wallMs: mean(runs.map((r) => r.wallMs)),
    cost: null,
  };
}

// scoreRuns(RunResult[]) -> board row per model, per ARCHITECTURE.md's score.js contract.
export function scoreRuns(results) {
  const byModel = groupByModel(results);
  return [...byModel.entries()].map(([model, runs]) => scoreModel(model, runs));
}
