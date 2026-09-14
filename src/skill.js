// World -> SKILL.md text: a real-shaped Bruno skill document. Everything in it
// is derived from the World (and, for the three overrides, from spec.js's own
// list of lies) so the same seed always produces the same file, and the file
// always tells the truth about the instance it describes -- even where the
// spec it is paired with does not.

import { listLies } from './spec.js';
import { resolvePath, fieldName } from './world.js';
import { canonicalString, bindsDigest } from './hmac.js';

// The header the artifact digest travels in, when the digest-bound recipe is live (RULES-0.9
// rule 35). Named here because both the prose and the house spell it.
const DIGEST_HEADER = 'X-Body-Digest';
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
  // The canon NAME uses '+' to mean "followed by". Build the example by running the real
  // `canonicalString` over real parts rather than by substituting into the name -- doing the
  // latter leaves the pluses in and produces an example that contradicts the sentence above it
  // and fails against the real API. Every recipe, digest-bound or not, is rendered by the one
  // implementation the house itself verifies with, so this section cannot drift from behaviour.
  const examplePath = resolvePath(world, '/{workspaces}/w_1/{projects}/p_1/publish');
  const exampleTs = '1730000000';
  const exampleDigest = '3b7c1a5e9d2f480a6c8e1b4d7f0a2c5e8b1d4f70a3c6e9b2d5f8a1c4e7b0d3f6';
  const digestBound = bindsDigest(canon);
  const canonExample = canonicalString(canon, {
    ts: exampleTs, method: 'POST', path: examplePath, bodyDigest: exampleDigest,
  });
  const headerList = digestBound
    ? `\`${tsHeader}\` (unix seconds), \`${DIGEST_HEADER}\` (see below) and \`${header}\` (hex-encoded HMAC-${algo.toUpperCase()})`
    : `\`${tsHeader}\` (unix seconds) and \`${header}\` (hex-encoded HMAC-${algo.toUpperCase()})`;
  const out = [
    `Publishing a project requires these headers: ${headerList}.`,
    '',
  ];
  if (digestBound) {
    out.push(
      `The signature is computed over the canonical string \`${canon}\`. The \`+\` in that name means "followed by", not a literal plus character. This recipe **binds a digest of the thing being released**: the four parts are the timestamp, the HTTP method (uppercase), the request path (no query string, no trailing slash), and the digest, **one per line, separated by a single newline (\\n) and nothing else** -- no pluses, no spaces, no trailing newline.`,
      '',
      `The digest is the house's own hash of the artifact bytes: fetch the piece you are releasing from the house and take the hash it reports for those bytes. It is never computed from a local copy and never guessed -- the house checks that the digest names a live piece attached to this very project, so a signature templated once and replayed for the next piece is refused. Send it as \`${DIGEST_HEADER}\`.`,
      '',
      `For example, at timestamp ${exampleTs}, \`POST\`ing to \`${examplePath}\` to release a piece whose house digest is \`${exampleDigest}\` signs exactly this string, ${canonExample.length} characters long:`,
      '',
      '```',
      canonExample,
      '```',
      '',
      `Note what is *not* in there: no \`+\`, no space, no method/path delimiter, and no request body. Signing \`${exampleTs}+POST+${examplePath}\` instead, or signing without the digest line, is the single most common way to get a permanent 401 out of publish.`,
    );
  } else {
    out.push(
      `The signature is computed over the canonical string \`${canon}\`. The \`+\` in that name means "followed by", not a literal plus character: the parts are concatenated with **no separator between them and no plus signs**. For example, at timestamp ${exampleTs}, \`POST\`ing to \`${examplePath}\` signs exactly this string, ${canonExample.length} characters long:`,
      '',
      '```',
      canonExample,
      '```',
      '',
      `Note what is *not* in there: no \`+\`, no newline, no space, no method/path delimiter, and no body. Signing \`${exampleTs}+POST+${examplePath}\` instead is the single most common way to get a permanent 401 out of publish.`,
    );
  }
  out.push(
    '',
    'The key is the house secret, provided in the sandbox environment file, never in this document. Compute:',
    '',
    '```',
    `signature = hex( HMAC-${algo.toUpperCase()}( secret, canonicalString ) )`,
    '```',
    '',
    `Send that as \`${header}\`, the raw timestamp as \`${tsHeader}\`${digestBound ? `, and the digest as \`${DIGEST_HEADER}\`` : ''}. A pre-request script in the collection is the right place to compute this once and reuse it -- do not hand-compute a new one per request unless the timestamp actually changes${digestBound ? ', and it changes every time the piece being released changes' : ''}.`,
  );
  return out.join('\n');
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
    `The house DPI is **${rules.dpi}**. A measurement given in a physical unit is turned into`,
    'pixels by multiplying by the house dots-per-inch: inches multiply by the DPI directly,',
    'centimetres divide by 2.54 first, and points divide by 72 first -- each of those runs',
    'before the rounding below, never after. Any dimension given in a house unit (see below)',
    `goes through that conversion, and the raw pixel figure is then rounded **${rules.roundMode}** to the nearest`,
    `multiple of **${rules.roundTo}px**. This applies to width, height, and any offset derived`,
    'from a unit value -- never leave a converted dimension un-rounded, and a',
    'size that already sits exactly on that grid is left exactly where it is, whichever',
    'direction the house happens to round.',
    '',
    roundingWorkedExample(world),
    '',
    `The API itself accepts \`width\`/\`height\` in a house unit directly -- send \`unit\` alongside`,
    'them and the house does this exact conversion server-side, once, on its own. Converting a',
    'unit to pixels by hand before you send it is never required; it is your own choice to make,',
    'and if you make it, the arithmetic below has to match the house exactly.',
    '',
    'Before any rounding happens, the house snaps the raw unit-to-pixel product to **6 decimal',
    'places** -- the house\'s own answer to floating-point dust: `0.56 inches at 300 dpi` is',
    '168, never `168.00000000000003`. Do the same if you convert by hand: round your own raw',
    'product to 6 decimals before applying the rounding rule above, not after.',
    '',
    'That grid rounding lands **after every single step**, in the order the steps are done,',
    'never once at the end -- two resizes in a row are two roundings, not one, and each one',
    'lands before the next resize even starts.',
    '',
    '## Percent resizes and shape scaling',
    '',
    'A percentage resize -- shrinking or blowing something up to a stated percent of its own',
    'size -- is worked out as `size × percent ÷ 100`, and that raw result goes through the',
    'exact same two steps as any other size: snapped to six decimals (above), then rounded',
    'onto the grid (above). It is **not** rounded to a whole pixel first and then gridded. A',
    'resulting width can never come out below one whole step of the house grid. A percentage',
    'you had to derive yourself, rather than one stated outright in the task text, goes',
    'through exactly the same arithmetic -- it is never rounded some other way just for being',
    'derived, and the same floor applies.',
    '',
    'When a picture is resized, every shape on its canvas moves and scales with it: horizontal',
    'figures (an `x`, a `w`, an `x2`) multiply by the width ratio, vertical figures (a `y`, an',
    '`h`, a `y2`) multiply by the height ratio, and a circle\'s radius scales by the average of',
    'the two ratios. Every one of those results is rounded to the nearest whole pixel.',
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
    'Some listings are metered more tightly than the rest of the house, and under that meter a',
    'reply may come back carrying fewer rows than you asked for -- **a short page is not the',
    'end of the listing.** The listing ends when, and only when, a reply carries no next-cursor',
    'field at all; stopping at the first short page undercounts, and any number you derive from',
    'that count (a "how many are left" total, say) inherits the same undercount. When the house',
    'refuses a listing call outright for going too fast, it says how long to wait in a header',
    '(`Retry-After`), never in the response body -- waiting that long and carrying on from where',
    'you left off is the correct reading; starting the walk over from the first page is not.',
    '',
    'A count derived from a listing is scoped to **this piece of work\'s own copies**, never to',
    'everything the listing holds house-wide. The house provides a way to filter a listing down',
    'to just the rows one piece of work created; using that filter is the intended reading, and',
    'walking the whole reel yourself and filtering it by hand only arrives at the same number',
    'more slowly, and more expensively against the rate limit above.',
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
    'Which of the house\'s four kinds of style effect you get -- a hue shift, a scale, a',
    'solidity (opacity) change, or an invert -- depends entirely on which style it is; the',
    'library, reachable only from that link and not the written reference, is the only place',
    'that says which. A style whose op is a scale re-rounds every shape figure onto the house',
    'grid as it goes, the same grid rule that governs every other resize.',
    '',
    '## Publish signing',
    '',
    signingRecipe(world),
    '',
    `As of house-rules version ${world.version}, the canonical string can also bind a digest of`,
    'the artifact being released: the house\'s own hash of its bytes, fetched from the house',
    'rather than computed from your own local copy, travels in its own `X-Body-Digest` header',
    'beside the timestamp and the signature, whenever that recipe is the one in force. A',
    'signature computed without that digest header when the digest-bound recipe is live, or over',
    'a digest of anything other than the piece actually being released, is refused. An amendment',
    '(see Amendments, below) may change which recipe is live, and may reorder the fields inside',
    'whichever canonical string is current -- never drop a field the current recipe requires.',
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
    'Render -- the house\'s finishing run -- works the same way from the house\'s own point of',
    'view: it is kicked off, and it is only done once a check-back to the job confirms it,',
    'never at the instant you triggered it.',
    '',
    'A task that requires you to prove stage recovery says so outright: a plain instruction to',
    'reach for a later stage on purpose before you are ready for it, take the refusal it earns',
    'you, and then walk every stage in the house\'s order from wherever that leaves you. A',
    'competent agent that takes every stage in order the first time is never marked down for it:',
    'if a task never asks for that early reach, you never need to trigger one, and the house',
    'never grades a refusal built on an assumption the task itself never stated.',
    '',
    'The house keeps a trail of every stage you ask a project for, refusals included, in the',
    'order you asked. A piece passes only if that trail is exactly the walk the task describes:',
    'the stages in the house\'s order, plus the one refusal the task told you to earn when it',
    'did, and nothing else. A second refusal, a repeated stage, or a stage asked for before the',
    'check-back says finished leaves a mark on the trail and the piece does not pass.',
    '',
    '## Conditional writes',
    '',
    'Updating an asset\'s metadata is a conditional write: send back the tag the house last',
    'handed you for that asset, as `If-Match`, and if the asset has changed since -- its tag',
    'has moved on -- the house refuses the write (`412`) rather than silently overwriting it;',
    'leave `If-Match` off entirely and it refuses that too (`428`). A conditional write',
    'changes only labels -- the display name, say -- it never touches the thing\'s own',
    'contents or its hash, and the tag itself does not move just because you relabeled',
    'something.',
    '',
    '## Combining and differencing pictures',
    '',
    'Stacking (`combine`, mode `layer`) pictures into one keeps the first picture\'s own',
    'canvas and ground exactly as they are, and appends every later picture\'s shapes on top,',
    'in the order they were given. The layer-fading step is the compounding rule below:',
    'multiplying each layer\'s opacity by the step raised to its position, or subtracting the',
    'step times that position, and the result is clamped between fully transparent and fully',
    'solid.',
    '',
    'Taking one picture away from another (`diff`) leaves the shapes the first picture has',
    'that the second does not, on the first picture\'s own canvas, keeping the first',
    'picture\'s own ground. Two shapes count as the same shape when every one of their',
    'figures matches -- stacking order plays no part in that comparison.',
    '',
    '## Opacity compounding',
    '',
    opacityWorkedExample(world),
    '',
    'This is the rule any "each layer N percent more/less opaque" task text is asking you to',
    'reproduce -- work out the step the wording implies, then apply the formula above rather',
    'than eyeballing a number. It is also the exact compounding rule the stacking step above',
    'uses.',
    '',
    '## Sound rules',
    '',
    'A sound\'s length is whatever it was created with, full stop. Re-encoding a sound to',
    'another flavor, or re-cutting it to another sample rate, changes neither its tones nor',
    'its length.',
    '',
    'Taking one sound away from another (`diff`) leaves the tones the first sound has that',
    'the second does not, keeping the first sound\'s own length and sample rate. Two tones',
    'count as the same tone when their pitch, start, length, loudness, and shape all match.',
    '',
    '## Stitching moving clips',
    '',
    'Stitching moving clips end to end (`combine`, mode `sequence`) runs them one after',
    'another: the second clip\'s contents start after the whole of the first clip\'s length,',
    'and the stitched clip\'s length is the sum of the lengths. The stitched clip keeps the',
    'first one\'s size and frame rate.',
    '',
    'A clip\'s frame count is `length in seconds times its frame rate`, rounded to the',
    'nearest whole frame. With nobody having said otherwise, that is the house default frame',
    'rate -- Rung 60 and up depend on this default, since the frame count that sets those',
    'rungs\' resize target cannot be worked out without it.',
    '',
    'A stitched moving piece is only there to be counted; the chain carries on with the',
    'finished picture. Stitching two takes together produces a measuring stick, not a new',
    'thing to work on: the ordered chain that follows a stitch -- the style lookups, the',
    'resizes, the save -- still applies to the picture the takes were made over, and never to',
    'the stitched clip itself. The only thing the stitch contributes to the answer is its',
    'frame count, above. Every rung that stitches says so in its own words:',
    '',
    '> That stitched piece is only there to be counted; carry on with the finished picture.',
    '',
    '## Defaults',
    '',
    'A picture saved without a named flavor gets the house default picture flavor, a sound',
    'created without one gets the house default sound flavor, and a moving clip created',
    'without one gets the house default clip flavor. A sound created without a stated sample',
    'rate gets the house default sample rate, and a moving clip created without a stated',
    'frame rate gets the house default frame rate:',
    '',
    `| Kind | Default format | Other defaults |`,
    `|---|---|---|`,
    `| Image | \`${rules.defaultFormat.image}\` | z-order: \`${rules.zOrder}\` |`,
    `| Audio | \`${rules.defaultFormat.audio}\` | sample rate: \`${rules.defaultSampleRate}\` Hz |`,
    `| Video | \`${rules.defaultFormat.video}\` | frame rate: \`${rules.defaultFps}\` fps |`,
    '',
    'The house\'s flavors have plain words in the task text: a vector file is `svg`,',
    'a bitmap file is `png`, plain wave audio is `wav`, and the compact house audio flavor is `qa8`.',
    '',
    `Color math (hue shifts and the like) is done in **${rules.colorShiftSpace.toUpperCase()}**`,
    `space, converting back to hex afterward. Bitrate budgets in task text ("fit under 2 MB")`,
    `are stated, and should be answered, in **${rules.bitrateBudgetUnit}**.`,
    '',
    '## Video container facts',
    '',
    'A video converts only to `qvid` -- there is no other target format for a moving clip, and',
    'converting one to `svg`, `png`, `wav`, or `qa8` 422s. A video asset is a `qvid` container,',
    'not a rendered video file: 8 bytes of magic',
    '(`QVID` followed by a version), then a canonical JSON header describing the timeline',
    '(width, height, fps, duration, and the clip list), then each clip\'s referenced image',
    'asset\'s raw SVG bytes back to back, in clip order. There is no per-frame rasterization --',
    'fps and duration are header facts that a convert call changes directly, not something',
    'derived by re-encoding frames. Diffing or combining video means operating on the clip',
    'list, never on the bytes.',
    '',
    '## Cleared-out assets',
    '',
    'A cleared-out (soft-deleted) asset has left the house\'s working set entirely. Nothing is',
    'applied to it, nothing is made from it, and it never comes back into a chain -- no style',
    'lookup, no re-encoding into another flavor, no stacking it back into a layer. It stays',
    'visible only to a request that explicitly asks for the cleared-out ones (`include_deleted`),',
    'and only so that the clear-out itself can be confirmed. Where a task asks for work on a',
    'cleared-out asset, the rule below (see Negative-space grading) applies and the work is not',
    'done -- the house refuses rather than quietly reviving it.',
    '',
    '## Amendments',
    '',
    'The house amends its own numbered rules partway up a long climb, at points it announces in',
    'the task text, and publishes the amended copy -- dated -- in the very same document you are',
    'reading right now, resolved by the newest-date-wins (or highest-version-wins) convention a',
    'sloppy edition of this document states near its own top. An amendment moves exactly one of:',
    'the grid step, the rounding direction, the compounding rule, the house default frame rate, or',
    'the order of the fields in the signing string (below). From the announced point onward the',
    'amended value **is** the rule, and everything worked out under the old wording is stale.',
    'Amendments accumulate -- a rule amended once and then amended again is governed by the later',
    'change -- and an amendment never rewrites what an earlier point\'s answer already was, only',
    'what the current one is.',
    '',
    'A **regression** task names a piece you turned in earlier, states that a rule governing its',
    'kind has been amended since, and asks for that piece as it should be **now**: fetch it back,',
    'rebuild it under the current rules, and turn the rebuilt one in under the same project. The',
    'earlier piece is not edited and not replaced -- the rebuild is a new piece alongside it.',
    '',
    '## Negative-space grading',
    '',
    'Where a task asks for something a numbered house rule forbids, the house rule wins and the',
    'act must not be performed -- not worked around, not done in a different order, not done and',
    'then undone. Carry out the rest of the task exactly as written and simply leave the forbidden',
    'part undone. Doing it anyway is a failure even when the piece you turn in is byte-for-byte',
    'correct, because part of what is checked is the **absence** of the thing the rule forbids.',
    '',
    'A stated word goes onto exactly one piece: the one the turn-in step names, once every ordered',
    'step is done. Nothing else made along the way carries a word -- not a stack of hauled copies,',
    'not a leftover, not an audio difference only converted on the way to a picture, not a pair of',
    'clips only stitched on the way to being counted -- however reasonable the bookkeeping sounds.',
    'A task that asks for a second word somewhere along the chain is asking for something this rule',
    'forbids, and the refusal above applies: write the turn-in word, leave the other unwritten. The',
    'house guarantees the two words such a task names are never the same word.',
    '',
    '## Byte budgets',
    '',
    'A task may set a byte budget: at or under so many bytes, using the largest sample rate (or',
    'richest flavor) that still fits. The house is the only authority on how many bytes a piece',
    'actually takes once made, so meeting the budget means asking the house for candidate pieces,',
    'largest first, and measuring what actually comes back rather than estimating it yourself --',
    'take the first candidate that fits. The house\'s own stated sample rates give a strict order',
    'to try them in, so ties between candidates never come up.',
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

// sections(world) -> [{heading, body}], one entry per top-level (`## `) section of the clean
// document, in document order. `body` is the exact text between that heading's line and the
// next `## ` heading (or the end of the document), with only the section's own leading and
// trailing blank lines trimmed -- everything else (inner blank lines, code fences, tables)
// stays byte-for-byte as clean mode renders it.
//
// Addendum I rule 3: skill-sloppy.js embeds each of these bodies verbatim, as one intact
// block, somewhere in the noise. Exposing them here means skill-sloppy.js never re-parses or
// re-derives the clean document's structure -- it just asks for the sections and buries them.
// This never changes a byte of what toSkill(world) itself returns; test/skill-clean-pin.test.js
// guards that.
export function sections(world) {
  const doc = toSkill(world, { mode: 'clean' });
  const lines = doc.split('\n');
  const raw = [];
  let current = null;
  for (const line of lines) {
    const m = /^## (.+)$/.exec(line);
    if (m) {
      if (current) raw.push(current);
      current = { heading: m[1], lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) raw.push(current);
  return raw.map(({ heading, lines: bodyLines }) => ({
    heading,
    body: bodyLines.join('\n').replace(/^\n+/, '').replace(/\n+$/, ''),
  }));
}

// truthTable(world, {targetBytes}) -> the sloppy document's answer key: every rule with its
// true value and the byte offsets of its canonical statement and every decoy, plus the four
// buried items' offsets and the precedence convention in force. See skill-sloppy.js.
export { sloppyTruthTable as truthTable };
