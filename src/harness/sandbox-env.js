// Addendum L: "the sandbox never contained the signing secret." Both run paths (the message-loop
// harness in run.js and the native CLI harness in run-cli.js) write this ONE file into the
// sandbox before the first turn, so `world.auth.secret` -- the HMAC signing secret publish rungs
// (50+) require -- actually exists somewhere the agent can read it. Every other document
// (SKILL.md/HOUSE-RULES.md, spec.json, the system prompt / TASK.md) says the secret lives here
// and deliberately never states its value itself; before this addendum nothing ever wrote the
// file, so that promise was a lie and every publish rung was unpassable on every driver.
//
// OpenCollection environment format (see the reference shape this mirrors:
// resume/demos/bruno-otari/environments/local.yml): a `variables` list of {name, value, secret?}.

// buildLocalEnv({baseUrl, apiKey, secret}) -> environments/local.yml text. Deterministic given
// its inputs: same three values in, same bytes out.
export function buildLocalEnv({ baseUrl, apiKey, secret } = {}) {
  if (!baseUrl) throw new Error('buildLocalEnv requires baseUrl');
  if (!apiKey) throw new Error('buildLocalEnv requires apiKey');
  if (!secret) throw new Error('buildLocalEnv requires secret');

  return `name: local
variables:
  - name: baseUrl
    value: ${baseUrl}
  - name: apiKey
    value: ${apiKey}
    secret: true
  - name: secret
    value: ${secret}
    secret: true
`;
}

// The sandbox-relative path every caller writes this to, and the one sentence each of TASK.md
// (run-cli.js) and the system prompt (run.js's prompt.md) uses to name it -- kept here so both
// paths and their tests reference the identical path and wording instead of retyping it.
export const LOCAL_ENV_PATH = 'environments/local.yml';
