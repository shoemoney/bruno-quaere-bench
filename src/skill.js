// World -> SKILL.md text: a real-shaped Bruno skill document. Everything in it
// is derived from the World (and, for the three overrides, from spec.js's own
// list of lies) so the same seed always produces the same file, and the file
// always tells the truth about the instance it describes -- even where the
// spec it is paired with does not.

import { listLies } from './spec.js';
import { resolvePath, fieldName } from './world.js';
import { toSkill as toSloppySkill, truthTable as sloppyTruthTable } from './skill-sloppy.js';

const TRAP_OVERRIDE_TEXT = {
  fieldCase: (l) => `- The reference lists a field as \`${l.detail.spec}\` on \`${l.detail.method.toUpperCase()} ${l.path}\`. What the response actually carries is \`${l.detail.real}\`. Read field names off a real response body, never off memory of the docs.`,
  deleteStatus: (l) => `- The reference says \`${l.detail.method.toUpperCase()} ${l.path}\` returns ${l.detail.spec}. It returns ${l.detail.real}, with an empty body. A collection test asserting on ${l.detail.spec} will fail against the real house; assert on ${l.detail.real}.`,
  optionalIsRequired: (l) => `- \`${l.detail.field}\` reads as optional on \`${l.detail.method.toUpperCase()} ${l.path}\` in the reference. Leave it out and the house rejects the call. Always send it.`,
  enumSpelling: (l) => `- The reference spells one enum value for \`${l.detail.field}\` on \`${l.detail.method.toUpperCase()} ${l.path}\` as \`${l.detail.spec}\`. The house only accepts \`${l.detail.real}\`; the printed spelling 422s.`,
  wrongDefault: (l) => `- The reference lists a default of \`${l.detail.spec}\` for \`${l.detail.field}\`. The house default actually applied when you omit it is \`${l.detail.real}\`. Don't rely on the printed number.`,
  missingRequiredHeader: (l) => `- \`${l.detail.header}\` is not documented anywhere on \`${l.detail.method.toUpperCase()} ${l.path}\`. The call 400s without it regardless. Send it.`,
};

const FILLER_OVERRIDES = [
  '- The reference reads like the asset list ends when `data` comes back empty. It does not: the last page is signaled by the response simply having no cursor field at all, even when `data` is non-empty. A loop that stops on an empty array will spin one page too many, or quit one page early.',
  '- Nothing in the reference says so, but opacity compounding (below) applies inside `combine` regardless of whether you pass an explicit step; if you do not have a step in mind, do not assume the house leaves opacity alone.',
];

function overridesSection(world) {
  const lies = listLies(world).slice(0, 3);
  const lines = lies.map((l) => TRAP_OVERRIDE_TEXT[l.trap](l));
  let i = 0;
  while (lines.length < 3 && i < FILLER_OVERRIDES.length) {
    lines.push(FILLER_OVERRIDES[i]);
    i += 1;
  }
  return lines.join('\n\n');
}

function unitWordsTable(world) {
  const rows = Object.entries(world.rules.unitWords).map(([unit, words]) => `| ${unit} | ${words.map((w) => `\`${w}\``).join(', ')} |`);
  return ['| House unit | Accepted words in task text |', '|---|---|', ...rows].join('\n');
}

function opacityWorkedExample(world) {
  if (world.rules.opacityCompound === 'multiplicative') {
    const step = 0.9;
    const base = 0.8;
    const vals = [0, 1, 2].map((i) => (base * step ** i).toFixed(3));
    return [
      `This house compounds **multiplicatively**: \`opacity_i = base_opacity * step ** i\` for the i-th layer counting from 0 (the bottom layer, i = 0, is always left at its own opacity, since anything to the 0th power is 1).`,
      '',
      `Worked example: three layers with base opacity 0.8, combined with step 0.9:`,
      '',
      `| Layer (i) | Opacity |`,
      `|---|---|`,
      `| 0 | ${vals[0]} |`,
      `| 1 | ${vals[1]} |`,
      `| 2 | ${vals[2]} |`,
      '',
      'Every result is clamped to [0, 1] after the formula runs.',
    ].join('\n');
  }
  const step = 0.15;
  const base = 0.8;
  const vals = [0, 1, 2].map((i) => Math.max(0, Math.min(1, base - step * i)).toFixed(3));
  return [
    `This house compounds **additively**: \`opacity_i = base_opacity - step * i\` for the i-th layer counting from 0 (the bottom layer, i = 0, is always left at its own opacity).`,
    '',
    `Worked example: three layers with base opacity 0.8, combined with step 0.15:`,
    '',
    `| Layer (i) | Opacity |`,
    `|---|---|`,
    `| 0 | ${vals[0]} |`,
    `| 1 | ${vals[1]} |`,
    `| 2 | ${vals[2]} |`,
    '',
    'Every result is clamped to [0, 1] after the formula runs.',
  ].join('\n');
}

// Candidates are tried in this fixed order, so the choice is deterministic per world. The
// first one whose raw pixel value is NOT already on the grid wins: a worked example where the
// rounding is a no-op (3.2in at 150 DPI is 480px, already a multiple of 4) demonstrates
// nothing, and a reader cannot tell a correct rule from a broken one by looking at it.
const ROUNDING_SAMPLE_INCHES = [3.2, 2.5, 1.75, 4.3, 0.9, 5.1, 1.3, 2.2, 6.7];

function roundOnGrid(value, roundTo, roundMode) {
  const q = value / roundTo;
  const n = roundMode === 'up' ? Math.ceil(q) : roundMode === 'down' ? Math.floor(q) : Math.round(q);
  return n * roundTo;
}

function roundingWorkedExample(world) {
  const { dpi, roundTo, roundMode } = world.rules;
  const offGrid = ROUNDING_SAMPLE_INCHES.find((inches) => {
    const px = inches * dpi;
    return Number.isInteger(px) && px % roundTo !== 0;
  });
  // roundTo === 1 puts every value on the grid; there is then nothing to demonstrate and the
  // first candidate is as good as any.
  const sampleInches = offGrid ?? ROUNDING_SAMPLE_INCHES[0];
  const rawPx = sampleInches * dpi;
  const rounded = roundOnGrid(rawPx, roundTo, roundMode);
  const note =
    rounded === rawPx
      ? ` (with a ${roundTo}px grid every whole pixel is already on the grid, so this step only ever changes a value when \`roundTo\` is greater than 1)`
      : '';
  // The closing sentence must stay CONDITIONAL. An unconditional "every width, height and offset
  // goes through this conversion" contradicts the paragraph above it and the answer key: a rung
  // states its canvas in a house unit but its shape geometry as bare numbers, which are already
  // pixels. Observed live -- a model converted the shape coordinates too and fell at rung 3 with
  // a correct canvas and correctly-scaled nothing else.
  return `A ${sampleInches}-inch dimension at ${dpi} DPI is ${rawPx}px raw. Rounded ${roundMode} to the nearest multiple of ${roundTo}px, that becomes **${rounded}px**${note}. Any width, height, or offset **stated in a house unit** goes through this same conversion before it reaches the descriptor. A bare number carrying no unit word is already in pixels -- pass it through untouched, and never scale shape geometry just because the canvas around it was given in a unit.`;
}

function namingSection(world) {
  const other = world.naming === 'snake' ? 'camelCase' : 'snake_case';
  // world.namingExceptions stores the CANONICAL snake_case key, which is the one spelling that is
  // guaranteed wrong on the wire for an exception field. The agent needs the literal it will
  // actually send and receive, so run each through fieldName() -- otherwise this section claims
  // "these are camelCase" and then prints the snake_case name directly underneath.
  const exceptions = world.namingExceptions.length
    ? world.namingExceptions.map((f) => `\`${fieldName(world, f)}\``).join(', ')
    : '(none this instance)';
  return [
    `Body fields follow **${world.naming === 'snake' ? 'snake_case' : 'camelCase'}** house-wide, with one carve-out: the fields below are deliberately spelled in ${other} instead, everywhere they appear, request or response:`,
    '',
    exceptions,
    '',
    'This is not a typo and it is not the same thing as the reference lying about a field (see Overrides, below) -- these fields are consistently the odd convention out in every real response the house sends, and the reference documents them correctly.',
  ].join('\n');
}

function signingRecipe(world) {
  const { header, tsHeader, algo, canon } = world.hmac;
  // The canon NAME ('ts+method+path') uses '+' to mean "followed by". The signed string itself
  // has no separators at all, so build the example by concatenating the real parts rather than
  // by substituting into the name -- doing the latter leaves the pluses in and produces an
  // example that contradicts the sentence above it and fails against the real API.
  const examplePath = resolvePath(world, '/{workspaces}/w_1/{projects}/p_1/publish');
  const exampleTs = '1730000000';
  const canonExample = `${exampleTs}POST${examplePath}`;
  return [
    `Publishing a project requires two headers: \`${tsHeader}\` (unix seconds) and \`${header}\` (hex-encoded HMAC-${algo.toUpperCase()}).`,
    '',
    `The signature is computed over the canonical string \`${canon}\`. The \`+\` in that name means "followed by", not a literal plus character: the signed string is the timestamp, the HTTP method (uppercase), and the request path (no query string, no trailing slash) concatenated with **no separator between them and no plus signs**. For example, at timestamp ${exampleTs}, \`POST\`ing to \`${examplePath}\` signs exactly this string, ${canonExample.length} characters long:`,
    '',
    '```',
    canonExample,
    '```',
    '',
    `Note what is *not* in there: no \`+\`, no newline, no space, no method/path delimiter, and no body. Signing \`${exampleTs}+POST+${examplePath}\` instead is the single most common way to get a permanent 401 out of publish.`,
    '',
    'The key is the house secret, provided in the sandbox environment file, never in this document. Compute:',
    '',
    '```',
    `signature = hex( HMAC-${algo.toUpperCase()}( secret, canonicalString ) )`,
    '```',
    '',
    `Send that as \`${header}\`, the raw timestamp as \`${tsHeader}\`. A pre-request script in the collection is the right place to compute this once and reuse it -- do not hand-compute a new one per request unless the timestamp actually changes.`,
  ].join('\n');
}

// toSkill(world, {mode, targetBytes}) -> markdown text, deterministic per seed (and, for
// sloppy mode, per targetBytes). mode 'clean' (the default, and the only mode this function
// used to have) is the 200-400 line ground-truth document below: frontmatter, then sections a
// team would actually write and an agent would actually need.
//
// mode 'sloppy' (Addendum A) wraps that same set of facts in megabytes of plausible internal-doc
// noise -- see skill-sloppy.js, which owns everything about how that document is built and
// where its truth table's offsets come from. Nothing about the clean document below changes
// because sloppy mode exists; test/skill-clean-pin.test.js pins its exact bytes for seed 1.
export function toSkill(world, opts = {}) {
  const mode = opts.mode ?? 'clean';
  if (mode === 'sloppy') return toSloppySkill(world, opts);
  const { vocab, rules, auth, pagination, loras } = world;
  const loraNames = loras.map((l) => l.name).join(', ');

  const lines = [
    '---',
    `name: ${vocab.workspace}-media-house-rules`,
    `description: House rules for the ${vocab.workspace} media API -- units, DPI, naming, auth, signing, and the handful of places the written reference and the real behavior disagree.`,
    '---',
    '',
    `# ${vocab.workspace[0].toUpperCase()}${vocab.workspace.slice(1)} media API -- house rules`,
    '',
    'This is the internal skill for working against this instance of the media API. The',
    'OpenAPI reference describes the shapes; this document describes how the house actually',
    'runs things, which is not always the same. When the two disagree, this document wins --',
    'see **Overrides** near the end for the specific, checkable places that happens.',
    '',
    '## You are alone on this',
    '',
    'One agent, one context, one credential, for the whole climb. Do not spawn subagents and',
    'do not try to split the work across sessions -- there is exactly one API key issued for',
    'this run and a second caller against it will only confuse the rate limiter and the',
    'idempotency store. If you need to remember something for later, write it into the',
    'collection you are building, not into a delegated task.',
    '',
    '## The task loop',
    '',
    `1. \`GET /rungs/current\` returns the current task's number and its plain-language text.`,
    '   The text never uses API field names -- it uses the words in this document (unit',
    '   words, lora names, plain nouns for the resources). Translating that language into',
    '   calls is the actual job.',
    `2. Do the work: create, convert, combine, diff, or publish whatever the task asks for,`,
    '   entirely through `bru run` against request files in your collection.',
    `3. \`POST /rungs/{n}/submit\` with body \`{"assets": [...]}\`, the id(s) of what you made,`,
    '   in the order the task implies. You get one submission per rung -- there is no partial',
    '   credit and no re-roll, so don\'t submit until you believe every artifact is exactly',
    '   right.',
    '4. On a pass the next rung is already live at `/rungs/current`. On a fail, the run is',
    '   over. There is no hint about which part was wrong.',
    '',
    'Nothing here is optional plumbing: the sandbox has no shell, no `curl`, no `python`. The',
    'only thing that opens a socket is `bru`. Everything you do to this API happens through a',
    '`.bru` request file and `bru run`.',
    '',
    '## House DPI and rounding',
    '',
    `The house DPI is **${rules.dpi}**. Any dimension given in a house unit (see below) is`,
    `first converted to pixels at that DPI, then rounded **${rules.roundMode}** to the nearest`,
    `multiple of **${rules.roundTo}px**. This applies to width, height, and any offset derived`,
    'from a unit value -- never leave a converted dimension un-rounded.',
    '',
    roundingWorkedExample(world),
    '',
    `The API itself accepts \`width\`/\`height\` in a house unit directly -- send \`unit\` alongside`,
    'them and the house does this exact conversion server-side, once, on its own. Converting a',
    'unit to pixels by hand before you send it is never required; it is your own choice to make,',
    'and if you make it, the arithmetic below has to match the house exactly.',
    '',
    'Before rounding, the house snaps the raw unit-to-pixel product to **6 decimal places** --',
    'a raw product that works out to, say, `168.00000000000003` in floating point reads as',
    'exactly `168`, never one float-noise hair off a whole pixel. Do the same if you convert by',
    'hand: round your own raw product to 6 decimals before applying the rounding rule above, not',
    'after.',
    '',
    '## Unit words',
    '',
    'Task text uses plain English, not API parameter names. These are the words this',
    'instance uses for each house unit; treat all of them as synonyms for the same',
    'conversion:',
    '',
    unitWordsTable(world),
    '',
    '## Naming convention',
    '',
    namingSection(world),
    '',
    '## Auth lifecycle',
    '',
    `Exchange the api key for a bearer token at \`POST /auth/token\`. The token is valid for`,
    `**${auth.tokenTtlSec} seconds**. It does not renew itself, and a request with an expired`,
    `token is rejected the same as one with no token at all -- there is no grace window.`,
    `Refresh it before it lapses at \`POST ${auth.refreshPath}\` using the refresh token from`,
    'the original exchange (or the previous refresh -- each refresh returns a new one, and',
    'the old refresh token stops working the moment you use it).',
    '',
    'On a long climb the token WILL expire mid-chain. Build the refresh into your collection',
    '(a pre-request script that checks token age, or just refresh proactively every so many',
    'requests) rather than reacting to the first 401 -- by the time you see the 401 you may',
    'already be mid-way through a multi-step task and have to redo work that depended on the',
    'old token.',
    '',
    'The api key and secret themselves live in the sandbox\'s Bruno environment file, not in',
    'this document -- see the environment example near the end.',
    '',
    '## Pagination',
    '',
    `Every listing endpoint (workspaces, projects, assets) pages at up to`,
    `**${pagination.pageSize}** items per page by default, using a \`${pagination.cursorStyle}\``,
    'cursor. **The last page is signaled by the cursor field being absent from the response,',
    'not by an empty `data` array.** A loop that keeps paging while `data.length > 0` will',
    'either loop one page too many (if the last page happens to be non-empty, which it',
    'usually is) or stop one page early (if it checks the wrong thing). Loop on the presence',
    'of the cursor field, full stop.',
    '',
    '## Finding the lora library',
    '',
    'The lora library is not in the OpenAPI reference. It does not need to be: `GET` any',
    'workspace and read its `links` block. The block names the library endpoint for this',
    'instance; follow that URL rather than guessing or hardcoding a path, because the path',
    'itself is not guaranteed stable across seeds. Once you have it, `GET` it (optionally with',
    `\`?name=\`) to look up a lora by the name a task gives you -- names in this instance`,
    `include ${loraNames}. Applying one is \`POST\` to the asset's \`/lora\` endpoint with the`,
    'looked-up id; the response is a new asset, the original is untouched.',
    '',
    '## Publish signing',
    '',
    signingRecipe(world),
    '',
    '## Project state machine',
    '',
    'A project moves through exactly one path: `draft` → `composed` → `rendered` →',
    '`published`. Each transition is its own endpoint (`compose`, `render`, `publish`), and',
    'each one 409s if the project is not currently in the state it expects -- there is no',
    'skipping a step and no going back. `render` in particular is asynchronous: it returns',
    '202 with a `Location` header pointing at a job; poll that job until its status reaches',
    '`done` before you attempt to publish. Polling too early just means you poll again --',
    'there is no penalty for polling, only for publishing before the render is actually done.',
    '',
    '## Opacity compounding',
    '',
    opacityWorkedExample(world),
    '',
    'This is the rule any "each layer N percent more/less opaque" task text is asking you to',
    'reproduce -- work out the step the wording implies, then apply the formula above rather',
    'than eyeballing a number.',
    '',
    '## Defaults',
    '',
    `| Kind | Default format | Other defaults |`,
    `|---|---|---|`,
    `| Image | \`${rules.defaultFormat.image}\` | z-order: \`${rules.zOrder}\` |`,
    `| Audio | \`${rules.defaultFormat.audio}\` | sample rate: \`${rules.defaultSampleRate}\` Hz |`,
    `| Video | \`${rules.defaultFormat.video}\` | frame rate: \`${rules.defaultFps}\` fps |`,
    '',
    `Color math (hue shifts and the like) is done in **${rules.colorShiftSpace.toUpperCase()}**`,
    `space, converting back to hex afterward. Bitrate budgets in task text ("fit under 2 MB")`,
    `are stated, and should be answered, in **${rules.bitrateBudgetUnit}**.`,
    '',
    '## Video container facts',
    '',
    'A video asset is a `qvid` container, not a rendered video file: 8 bytes of magic',
    '(`QVID` followed by a version), then a canonical JSON header describing the timeline',
    '(width, height, fps, duration, and the clip list), then each clip\'s referenced image',
    'asset\'s raw SVG bytes back to back, in clip order. There is no per-frame rasterization --',
    'fps and duration are header facts that a convert call changes directly, not something',
    'derived by re-encoding frames. Diffing or combining video means operating on the clip',
    'list, never on the bytes.',
    '',
    '## Overrides',
    '',
    'Three places the written reference and the house disagree, checked and current for this',
    'instance. Nothing else in the reference is wrong -- these are the exceptions, not the',
    'rule:',
    '',
    overridesSection(world),
    '',
    '## Minimal request example (OpenCollection YAML)',
    '',
    '```yaml',
    'type: http',
    'name: get token',
    'seq: 1',
    'method: POST',
    'url: "{{baseUrl}}/auth/token"',
    'body:',
    '  mode: json',
    '  json: |',
    '    {',
    '      "api_key": "{{apiKey}}"',
    '    }',
    'script:',
    '  post-response: |',
    '    bru.setEnvVar("bearerToken", res.body.access_token);',
    '```',
    '',
    '## Environment file example',
    '',
    'A Bruno environment for this instance -- values are placeholders; the sandbox\'s own',
    'environment file has the real ones, never this document:',
    '',
    '```',
    'vars {',
    '  baseUrl: http://localhost:8080',
    '  apiKey: {{process.env.QUAERE_API_KEY}}',
    '  bearerToken:',
    '}',
    '```',
    '',
  ];

  return lines.join('\n');
}

// truthTable(world, {targetBytes}) -> the sloppy document's answer key: every rule with its
// true value and the byte offsets of its canonical statement and every decoy, plus the four
// buried items' offsets and the precedence convention in force. See skill-sloppy.js.
export { sloppyTruthTable as truthTable };
