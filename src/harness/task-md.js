// The fixed prompt text for a CLI-driven climb (ARCHITECTURE Addendum F). Unlike the message-loop
// path's harness/prompt.md (which describes five sandbox tools -- bru plus a dumb text editor,
// per Addendum B), a real CLI product already has its own file-editing tools built in. The only
// thing this file has to teach it is: the one rule (nothing but `bru` opens a socket), where the
// base URL and api key are, how the ladder works, and that it works alone. `-p` is one line
// ("Read TASK.md and begin.") -- everything else lives here, in the sandbox, where the CLI's own
// tools can re-read it any time.
//
// Wall-clock timing is not used here -- this module is pure text templating -- but it lives under
// harness/ (not spec/ or ladder/) because its content is a harness artifact (what we tell the
// agent), never anything a rung's hash or a spec/skill document is judged against.

// buildTaskMd({baseUrl, apiKey, budgetTokens}) -> string. Deterministic given its inputs: same
// baseUrl/apiKey/budgetTokens, same bytes.
export function buildTaskMd({ baseUrl, apiKey, budgetTokens = 3_000_000 } = {}) {
  if (!baseUrl) throw new Error('buildTaskMd requires baseUrl');
  if (!apiKey) throw new Error('buildTaskMd requires apiKey');

  return `# Bruno QUAERE task

You are climbing the Bruno QUAERE ladder: a hundred numbered rungs of tasks against a media API,
each stated in plain language. You stop the moment you fail one. Your score is the highest rung
you clear.

## The one rule

The only thing that may ever open a network socket, here or anywhere else in this session, is the
Bruno CLI, \`bru\`. Never call the API with curl, a language's HTTP client, a raw socket, or any
tool other than \`bru\` -- every genuine \`bru\` invocation is logged and checked, and anything else
touching the wire is recorded as a violation of this run.

## Where things are

- Base URL: ${baseUrl}
- API key: ${apiKey} -- exchange it for a bearer token at the auth endpoint the spec describes.
  The token expires and there is a refresh endpoint; both are described exactly in \`spec.json\`
  and in \`HOUSE-RULES.md\`.
- \`spec.json\`, in this directory, is the OpenAPI 3.1 spec for this instance.
- \`HOUSE-RULES.md\`, in this directory, is the house skill: units, rounding, naming, auth,
  pagination, signing, and the handful of places it deliberately overrides the spec. It is real
  internal documentation -- long, imperfectly organized, not a tidy cheat sheet -- and reading it
  carefully is part of the task. Skimming it is how you fall off the ladder.
- \`environments/local.yml\`, in this directory, is your Bruno environment for this instance --
  \`baseUrl\`, \`apiKey\`, and the \`secret\` a signed publish request needs -- use it with \`--env local\`.

## The ladder

\`GET /rungs/current\` (through \`bru\`, once you are authenticated) returns the current rung's
number and its plain-language task text. Work the task using \`spec.json\` and \`HOUSE-RULES.md\`,
build whatever \`.bru\` requests you need, then \`POST /rungs/{n}/submit\` with the asset id(s) it
asks for. You get exactly one submission per rung -- a second submission for the same rung is
rejected outright, so do not submit until you believe the artifact is exactly right. A pass
advances you to the next rung automatically; a fail ends your run where you stand.

## Rules of engagement

You are the only agent working this instance. Do not delegate to another agent, do not spawn
subagents or background tasks, do not parallelize -- one \`bru\` invocation at a time, in this one
session, from start to whatever rung you reach.

You have a token budget of ${budgetTokens} for this entire run, input plus output. Spend it
climbing, not narrating: keep your reasoning proportional to the rung in front of you.

Begin: read this file once, fetch the current rung, and get to work.
`;
}
