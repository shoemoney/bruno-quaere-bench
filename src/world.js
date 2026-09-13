// seed -> World: vocabulary, id formats, naming, house rules, auth, traps,
// deprecations, and loras. Every facet draws from its own sub-seed so that
// adding a new field later never reshuffles the facets that already exist.

import { rng, sub, pick, int, shuffle, chance } from './seed.js';

// Bumped to 0.2.0 by Addendum C round-2 steepening: the difficulty grammar's band parameters
// changed, so the same seed no longer yields the same ladder as a 0.1.x run did. Results from the
// two versions are not comparable and the version is what says so.
//
// Bumped to 0.3.0 by Addendum G: media.js's unit-to-pixel conversion now snaps its raw product to
// 6 decimals before rounding, and grammar.js's generator rejects and redraws any unit-tagged
// dimension whose exact product would land within 1e-6px of a grid boundary. Both change which
// concrete descriptors (and so which hashes) a seed produces versus 0.2.x -- not the difficulty
// curve itself, but still enough that a 0.2.x run and a 0.3.x run are not directly comparable.
//
// Bumped to 0.4.0 by Addendum I: a percent-resize compute step now targets
// `roundToGrid(snap6(raw), roundTo, roundMode)` -- the same function every other convert target
// uses -- instead of a hidden `Math.round(raw)` the docs never stated, and the generator redraws
// any rung whose percent step would have been ambiguous between the two readings. 0.3.x hashes
// for any rung with a percent step are superseded.
// Bumped to 0.5.0 by Addendum J: the whole ladder grammar changed shape. Rungs now carry
// cross-rung references (rule 1), derived parameters the API has to be asked for (rule 2),
// announced per-rung mutations (rule 3, `rungMutations` below), state-machine + HMAC + ETag
// chains at 50+ (rule 4), audio/video math at 50+ (rules 5 and 8), multi-rule ordering at 70+
// (rule 6) and a much longer step envelope (rule 9). Every 0.4.x hash is superseded and no 0.4.x
// board row is comparable with a 0.5.x one.
// Bumped to 0.6.0 by Addendum O, the rung-60 audit. Three changes a 0.5.x row cannot be compared
// against: (1) every stitch rung's text now states the antecedent of the chain that follows it
// ("That stitched piece is only there to be counted; carry on with the finished picture."), the
// missing sentence that cost three of five finished climbs a rung-60 fall at fidelity 0.03;
// (2) the answer key grades the chain from rung 50 up -- beside the hashes it records the project
// state the submitted asset must have reached (`published`, in order) and the label the text told
// the agent to write under If-Match, so six mechanisms of work that were invisible to the scorer
// now count, and tier 5 walks the release it always described; (3) the conditional write's label
// is a seeded word stated in the task text instead of an ungradeable "a word of your own".
// Bumped to 0.7.0 by Addendum Q, which attacks the replayable solver rather than the arithmetic.
// Four things in this file change with it, and any one of them makes a 0.6.x row incomparable:
// (1) every clause of a rung's text now renders as one of four seeded paraphrasings of identical
// meaning (Q1), so the same seed produces different prose than 0.6.0 did; (2) `amendments` (Q4) --
// dated mid-ladder rule changes at rungs 30, 55 and 78, read through `rulesAt(world, n)`, which is
// the single function the key, the reference and the house must all agree to call; (3) the
// announced-mutation density is now a ramp, 0.6 up to 0.9 from rung 70 (Q2), and the target pool
// this file publishes names the load-bearing fields a solver actually parses rather than the
// decorative ones 0.6.0 moved; (4) `rate.buckets` (Q9) declares the tighter bucket on the listing
// that feeds a derived count, and with it the short-page rule.
export const VERSION = '0.7.0';

// ---------------------------------------------------------------------------
// Addendum J rule 3: announced per-rung mutations
// ---------------------------------------------------------------------------

// The pool the ladder is allowed to announce. It is a strict subset of the Arena mutation list
// (`MUTATION_NAMES` in src/api/admin.js) on purpose: `rejectAuth` makes a route answer 401
// forever and `stuckCursor` makes a listing repeat page one forever, so either one, applied for
// a whole rung to a route that rung needs, makes the rung unpassable by ANY correct client --
// which is a generator bug, not difficulty. The four here all change what comes back (status
// code, a dropped field, a renamed field, a retyped field) without making any call impossible, so
// a client that verifies what it actually got still gets through and one that trusted the written
// reference's shape does not. That is the whole point of announcing it.
export const RUNG_MUTATION_POOL = ['statusCode', 'dropField', 'renameField', 'retypeField'];

// Addendum J rule 3: "from rung 40 on".
export const FIRST_MUTATION_RUNG = 40;

// Addendum Q rule 2: the density is a ramp, not a shelf. 0.6 from rung 40, rising to 0.9 from
// rung 70, so the top third of the ladder re-picks a change under the agent nearly every rung and
// one normalization layer written once at rung 40 is not enough.
const MUTATION_DENSITY_BASE = 0.6;
const MUTATION_DENSITY_TOP = 0.9;
const DENSITY_RAMP_RUNG = 70;

// mutationDensityAt(n): the probability rung n announces a change.
export function mutationDensityAt(n) {
  if (n < FIRST_MUTATION_RUNG) return 0;
  return n < DENSITY_RAMP_RUNG ? MUTATION_DENSITY_BASE : MUTATION_DENSITY_TOP;
}

// ---------------------------------------------------------------------------
// Addendum Q rule 2: the TARGET pool, published here and owned by the API workstream
// ---------------------------------------------------------------------------
//
// 0.6.0's mutations all landed on GET routes (`workspaces.get`, `projects.get`, `assets.get`,
// `jobs.get`). Astra's seed-701 climb announced 33 of them and paid nothing for a single one,
// because a POST-driven pipeline never reads those bodies. A mutation is only a tax if it lands
// on a field the solver's own parse is load-bearing on, which means the WRITE routes and the
// LISTING. This constant is the ladder workstream's statement of which targets the Arena's
// candidate lists must cover; `src/api/admin.js` owns the implementation (its
// `*_CANDIDATES` arrays) and `test/ladder-0-7.test.js` pins the list so the two cannot drift
// apart silently. Rule 27 still binds: the artifact never changes, only the parse.
export const RUNG_MUTATION_TARGETS = [
  { mutation: 'renameField', route: 'images.create', field: 'id', to: 'uid' },
  { mutation: 'retypeField', route: 'assets.convert', field: 'width' },
  { mutation: 'retypeField', route: 'assets.combine', field: 'shapes' },
  // A dropped field has to be RECOVERABLE, or the rung that announces it is unpassable by any
  // correct client and that is a generator bug rather than difficulty (the same reason
  // `rejectAuth` and `stuckCursor` are not in RUNG_MUTATION_POOL). `projects.render`'s `job_id`
  // was the obvious target and is exactly the wrong one: the check-back rule 23 requires is a
  // poll of THAT JOB, there is no jobs listing to find it another way, and the audit's 'rendered'
  // stage is only recorded when the job itself reports done -- so dropping it makes every rung
  // 50-69 unpassable. `assets.combine`'s whole `descriptor` is load-bearing in the same way (every
  // solver reads the stacked size off it to feed the next step) and IS recoverable: ask
  // `assets.get` for the asset the reply did give you an id for.
  { mutation: 'dropField', route: 'assets.combine', field: 'descriptor' },
  { mutation: 'renameField', route: 'projects.assets', field: 'cursor', to: 'next' },
  { mutation: 'statusCode', route: 'assets.lora', to: 202 },
];

// makeRungMutations(seed) -> (RungMutation | null)[], indexed BY RUNG NUMBER so
// `world.rungMutations[n]` is the entry for rung n and nothing has to search. Entry shape is
// `{ n, mutation }` (mutation being one of RUNG_MUTATION_POOL), or `null` for a rung that
// announces nothing.
//
// API contract (the API workstream owns the other half): when `POST /admin/rungs/advance` moves
// the current rung to n, the server REPLACES its active mutation set with
// `world.rungMutations[n] ? [world.rungMutations[n].mutation] : []`, so the announced mutation is
// live from the first request of rung n and no earlier rung's mutation leaks forward.
function makeRungMutations(seed) {
  const r = rng(sub(seed, 'rungMutations'));
  const out = [];
  for (let n = 0; n < 100; n += 1) {
    if (n < FIRST_MUTATION_RUNG) {
      out.push(null);
      continue;
    }
    out.push(chance(r, mutationDensityAt(n)) ? { n, mutation: pick(r, RUNG_MUTATION_POOL) } : null);
  }
  return out;
}

const WORKSPACE_NOUNS = ['studio', 'fleet', 'lab', 'yard', 'shop', 'depot', 'guild', 'forge', 'atelier', 'bureau'];
const PROJECT_NOUNS = ['scene', 'vehicle', 'sensor', 'mission', 'reel', 'session', 'build', 'sketch', 'spread', 'rig'];
const ASSET_NOUNS = ['clip', 'frame', 'sample', 'tile', 'snapshot', 'cut', 'trace', 'stem', 'panel', 'print'];
const LIBRARY_NOUNS = ['library', 'vault', 'archive', 'stacks', 'catalog', 'crate', 'locker', 'stash'];

const ID_STYLES = ['uuid', 'ulid', 'prefixed', 'int'];
const NAMING = ['snake', 'camel'];
const ROUND_TO = [1, 2, 4, 8, 16];
const ROUND_MODE = ['nearest', 'up', 'down'];
const DPI_CHOICES = [72, 96, 150, 300];
const OPACITY_COMPOUND = ['additive', 'multiplicative'];
const IMAGE_FORMATS = ['svg', 'png'];
const AUDIO_FORMATS = ['wav', 'qa8'];
const SAMPLE_RATES = [22050, 44100, 48000];
const FPS_CHOICES = [12, 24, 30];
const ZORDER = ['listOrder', 'explicit'];
const COLOR_SHIFT_SPACE = ['hsl', 'hsv'];
const BITRATE_UNIT = ['KB', 'MB'];
const CURSOR_STYLE = ['b64json', 'b64id', 'opaque'];

const TRAP_NAMES = ['fieldCase', 'deleteStatus', 'optionalIsRequired', 'enumSpelling', 'wrongDefault', 'missingRequiredHeader'];

const NAMING_EXCEPTION_CANDIDATES = [
  'created_at', 'updated_at', 'content_type', 'asset_id', 'job_id',
  'file_name', 'display_name', 'api_key', 'rate_limit', 'page_size',
  'workspace_id', 'project_id',
];

const LORA_FIRST_NAMES = [
  'Jenny', 'Moss', 'Iker', 'Petra', 'Dax', 'Wren', 'Sable', 'Omar',
  'Ines', 'Tulli', 'Vex', 'Rune', 'Sana', 'Botan', 'Leni', 'Cass',
];
const LORA_OPS = ['hueShift', 'scale', 'opacity', 'invert'];

const UNIT_WORD_POOL = {
  inch: ['inch', 'inches', 'in', '"'],
  cm: ['cm', 'centimeter', 'centimeters', 'centimetre'],
  pt: ['pt', 'point', 'points'],
};

function hex(r, len) {
  let s = '';
  while (s.length < len) {
    s += Math.floor(r() * 16).toString(16);
  }
  return s.slice(0, len);
}

// Simple, deterministic English pluralization for the small vocab word set.
function pluralize(word) {
  if (/[sxz]$|[sc]h$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

function makeVocab(seed) {
  const r = rng(sub(seed, 'vocab'));
  return {
    workspace: pick(r, WORKSPACE_NOUNS),
    project: pick(r, PROJECT_NOUNS),
    asset: pick(r, ASSET_NOUNS),
    library: pick(r, LIBRARY_NOUNS),
  };
}

function makeIds(seed) {
  const r = rng(sub(seed, 'ids'));
  const style = pick(r, ID_STYLES);
  const prefixOf = (label) => `${label.slice(0, 4)}_${hex(rng(sub(seed, `ids.prefix.${label}`)), 3)}`;
  return {
    style,
    prefixes: {
      workspace: prefixOf('workspace'),
      project: prefixOf('project'),
      asset: prefixOf('asset'),
      job: prefixOf('job'),
      lora: prefixOf('lora'),
    },
  };
}

function makeNaming(seed) {
  const r = rng(sub(seed, 'naming'));
  const naming = pick(r, NAMING);
  const rEx = rng(sub(seed, 'naming.exceptions'));
  const count = int(rEx, 1, 3);
  const namingExceptions = shuffle(rEx, NAMING_EXCEPTION_CANDIDATES).slice(0, count).sort();
  return { naming, namingExceptions };
}

function makeUnitWords(seed) {
  const out = {};
  for (const unit of Object.keys(UNIT_WORD_POOL)) {
    const pool = UNIT_WORD_POOL[unit];
    const rUnit = rng(sub(seed, `rules.unitWords.${unit}`));
    const count = int(rUnit, 2, pool.length);
    out[unit] = shuffle(rUnit, pool).slice(0, count);
  }
  return out;
}

function makeRules(seed) {
  return {
    dpi: pick(rng(sub(seed, 'rules.dpi')), DPI_CHOICES),
    roundTo: pick(rng(sub(seed, 'rules.roundTo')), ROUND_TO),
    roundMode: pick(rng(sub(seed, 'rules.roundMode')), ROUND_MODE),
    unitWords: makeUnitWords(seed),
    opacityCompound: pick(rng(sub(seed, 'rules.opacityCompound')), OPACITY_COMPOUND),
    defaultFormat: {
      image: pick(rng(sub(seed, 'rules.defaultFormat.image')), IMAGE_FORMATS),
      audio: pick(rng(sub(seed, 'rules.defaultFormat.audio')), AUDIO_FORMATS),
      video: 'qvid',
    },
    defaultSampleRate: pick(rng(sub(seed, 'rules.defaultSampleRate')), SAMPLE_RATES),
    defaultFps: pick(rng(sub(seed, 'rules.defaultFps')), FPS_CHOICES),
    zOrder: pick(rng(sub(seed, 'rules.zOrder')), ZORDER),
    colorShiftSpace: pick(rng(sub(seed, 'rules.colorShiftSpace')), COLOR_SHIFT_SPACE),
    bitrateBudgetUnit: pick(rng(sub(seed, 'rules.bitrateBudgetUnit')), BITRATE_UNIT),
  };
}

function makeAuth(seed) {
  const r = rng(sub(seed, 'auth'));
  return {
    apiKey: `key_${hex(r, 24)}`,
    secret: `sec_${hex(rng(sub(seed, 'auth.secret')), 32)}`,
    tokenTtlSec: int(rng(sub(seed, 'auth.ttl')), 90, 600),
    refreshPath: '/auth/refresh',
  };
}

// Addendum Q rule 9: a second, tighter bucket on exactly the route whose paginated walk feeds a
// derived count, so a client that pages flat out 429s partway through the count instead of at
// some harmless moment. `Retry-After` travels as a real header. The house also, on that same
// pooled route, sometimes hands back a SHORT page inside the throttle window rather than an
// error -- which is why the short-page rule (RULES-0.7 rule 31) has to be written down: a page
// shorter than the one you asked for is not the end of the listing; only the absence of a next
// cursor is. The API workstream owns enforcing this bucket; the ladder publishes it.
function makeRate(seed) {
  const r = rng(sub(seed, 'rate'));
  const limit = int(r, 20, 60);
  const rListing = rng(sub(seed, 'rate.listing'));
  return {
    limit,
    windowSec: 10,
    buckets: {
      // the listing bucket is always strictly tighter than the global one
      listing: { route: 'projects.assets', limit: Math.max(4, Math.floor(limit / int(rListing, 3, 5))), windowSec: 10 },
    },
    shortPage: true,
  };
}

// ---------------------------------------------------------------------------
// Addendum Q rule 4: dated mid-ladder amendments
// ---------------------------------------------------------------------------
//
// The house amends one numbered rule at each of three announced rungs. The harness rewrites
// HOUSE-RULES.md in the sandbox at those rungs and the rung text says so; the amendment is the
// only mechanism on the ladder that makes the 5 MB document keep costing after rung 0.
//
// `rulesAt(world, n)` is the ONE function that resolves "which rules are in force at rung n". The
// answer key calls it, the reference calls it, the docsolver has to call it, and the house has to
// call it -- if any of the four resolve the rules another way the ladder is ungradeable. It is
// exported from this file, not from the ladder, precisely so there is no ladder-only copy.
export const AMENDMENT_RUNGS = [30, 55, 78];

// The closed set an amendment may draw from, per Addendum Q rule 4. Each entry names the World
// field it moves and the candidate values it may move to.
export const AMENDMENT_RULES = {
  roundTo: { path: ['rules', 'roundTo'], choices: ROUND_TO },
  roundMode: { path: ['rules', 'roundMode'], choices: ROUND_MODE },
  opacityCompound: { path: ['rules', 'opacityCompound'], choices: OPACITY_COMPOUND },
  defaultFps: { path: ['rules', 'defaultFps'], choices: FPS_CHOICES },
  hmacCanon: { path: ['hmac', 'canon'], choices: ['ts+method+path', 'ts+path+method', 'method+path+ts'] },
};

// ---------------------------------------------------------------------------
// AMENDMENTS_ENFORCED: the one switch that says whether the HOUSE applies an amendment.
//
// An amendment is only real when the house itself changes behaviour at the announced rung -- the
// grid step, the rounding direction, the compounding rule, the default frame rate and the signing
// canonical string are all applied by `src/media.js` and `src/api/behaviors.js`, which read
// `world.rules` / `world.hmac` once and know nothing about the current rung. Until those two
// resolve their rules through `rulesAt(world, currentRung)` instead, an amendment could only ever
// desync the answer key from the live house: the key would round on the amended grid and the
// server would round on the original one, and every rung from 30 up would fail the reference gate
// for a reason that has nothing to do with the ladder.
//
// So amendments are DRAWN and TESTED here but not PUBLISHED while this is false: `makeWorld`
// hands back an empty `amendments` array, nothing is written into the sandbox, no rung text
// announces one, and `rulesAt` is a no-op that still threads through every call site. Flipping
// this to true is a one-line change once the API workstream lands two things:
//
//   1. `src/media.js`'s create/convert/combine/applyLora resolve dpi, grid step, rounding
//      direction, compounding rule and default fps from `rulesAt(world, n)` for the CURRENT rung
//      rather than from `world.rules`.
//   2. `src/api/behaviors.js`'s `verifyHmac` builds its canonical string from
//      `rulesAt(world, n).hmac.canon` (it currently hardcodes `ts+method+path`, ignoring
//      `world.hmac.canon` entirely) and the harness rewrites HOUSE-RULES.md at each amendment rung.
//
// `drawAmendments(seed)` is exported unconditionally so `test/amendment.test.js` can prove the
// whole mechanism -- draws, `rulesAt` resolution, and the generator composing against amended
// rules -- without waiting on the house.
export const AMENDMENTS_ENFORCED = false;

export function drawAmendments(seed) {
  const r = rng(sub(seed, 'amendments'));
  const names = shuffle(r, Object.keys(AMENDMENT_RULES));
  const base = {
    rules: makeRules(seed),
    hmac: makeHmac(),
  };
  return AMENDMENT_RUNGS.map((atRung, i) => {
    const rule = names[i % names.length];
    const { path, choices } = AMENDMENT_RULES[rule];
    const from = base[path[0]][path[1]];
    const others = choices.filter((c) => c !== from);
    const to = pick(rng(sub(seed, `amendments.${rule}.${atRung}`)), others.length > 0 ? others : choices);
    base[path[0]] = { ...base[path[0]], [path[1]]: to };
    return { atRung, rule, path, from, to };
  });
}

// rulesAt(world, n) -> a World whose `rules` and `hmac` are the ones in force at rung n. Pure,
// cheap, and identity-returning when nothing has been amended yet, so calling it on every hot
// path costs nothing on a world with no amendments.
const RULES_AT_CACHE = new WeakMap();

export function rulesAt(world, n) {
  const live = (world.amendments || []).filter((a) => a.atRung <= n);
  if (live.length === 0) return world;
  // Memoised on (world, n): a rung's plan is composed, run locally, run again for the caps check
  // and run a third time by makeRung, and every one of those has to see the SAME object or
  // grammar.js's plan-run cache (keyed on world identity) misses every time.
  let byRung = RULES_AT_CACHE.get(world);
  if (byRung === undefined) {
    byRung = new Map();
    RULES_AT_CACHE.set(world, byRung);
  }
  const hit = byRung.get(n);
  if (hit !== undefined) return hit;
  const next = { ...world, rules: { ...world.rules }, hmac: { ...world.hmac } };
  for (const a of live) next[a.path[0]][a.path[1]] = a.to;
  byRung.set(n, next);
  return next;
}

// amendmentsAt(world, n): the amendments announced at exactly rung n (what the harness writes into
// HOUSE-RULES.md when the climb reaches it, and what that rung's text tells the agent to go read).
export function amendmentsAt(world, n) {
  return (world.amendments || []).filter((a) => a.atRung === n);
}

function makePagination(seed) {
  const r = rng(sub(seed, 'pagination'));
  return {
    pageSize: int(r, 5, 25),
    cursorStyle: pick(rng(sub(seed, 'pagination.cursorStyle')), CURSOR_STYLE),
  };
}

function makeTraps(seed) {
  const r = rng(sub(seed, 'traps'));
  const count = int(r, 2, TRAP_NAMES.length);
  const live = shuffle(r, TRAP_NAMES).slice(0, count).sort();
  return { live };
}

function makeDeprecated(seed) {
  // /v1/pictures -> /images is a fixed deprecation the ladder and route
  // table both depend on; it alone satisfies the ">= 1" requirement.
  void seed;
  return { '/v1/pictures': '/images' };
}

function makeLoras(seed) {
  const r = rng(sub(seed, 'loras'));
  const count = int(r, 6, 12);
  const names = shuffle(r, LORA_FIRST_NAMES).slice(0, count);
  return names.map((name, i) => {
    const rl = rng(sub(seed, `loras.${i}.${name}`));
    const op = pick(rl, LORA_OPS);
    const amount = amountFor(op, rl);
    return { id: `lora_${i}_${name.toLowerCase()}`, name, op, amount };
  });
}

function amountFor(op, r) {
  if (op === 'hueShift') return int(r, -180, 180);
  if (op === 'scale') return Number((0.5 + r() * 1.5).toFixed(2));
  if (op === 'opacity') return Number(r().toFixed(2));
  return 1; // invert has no meaningful magnitude
}

function makeHmac() {
  return { header: 'X-Signature', tsHeader: 'X-Timestamp', algo: 'sha256', canon: 'ts+method+path' };
}

// makeWorld(seed): number -> World, fully deterministic.
export function makeWorld(seed) {
  return {
    seed,
    version: VERSION,
    vocab: makeVocab(seed),
    ids: makeIds(seed),
    ...makeNaming(seed),
    rules: makeRules(seed),
    auth: makeAuth(seed),
    rate: makeRate(seed),
    pagination: makePagination(seed),
    traps: makeTraps(seed),
    deprecated: makeDeprecated(seed),
    loras: makeLoras(seed),
    hmac: makeHmac(),
    rungMutations: makeRungMutations(seed),
    // Addendum Q rule 4. Empty until the house resolves its own rules through rulesAt() -- see
    // AMENDMENTS_ENFORCED above for the exact two changes that flip it on.
    amendments: AMENDMENTS_ENFORCED ? drawAmendments(seed) : [],
  };
}

const VOCAB_PLACEHOLDERS = {
  '{workspaces}': (world) => pluralize(world.vocab.workspace),
  '{projects}': (world) => pluralize(world.vocab.project),
  '{assets}': (world) => pluralize(world.vocab.asset),
  '{library}': (world) => world.vocab.library,
};

// resolvePath(world, templatePath): replace vocab placeholders with the
// world's nouns. Non-vocab placeholders (e.g. {id}, {n}) are left as-is;
// route-level params describe those.
export function resolvePath(world, templatePath) {
  let out = templatePath;
  for (const [token, resolve] of Object.entries(VOCAB_PLACEHOLDERS)) {
    if (out.includes(token)) out = out.split(token).join(resolve(world));
  }
  return out;
}

function snakeToCamel(name) {
  return name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

// fieldName(world, snakeName): apply world.naming, flipping fields listed in
// world.namingExceptions to the opposite convention.
export function fieldName(world, snakeName) {
  const camelConvention = world.naming === 'camel';
  const isException = world.namingExceptions.includes(snakeName);
  const useCamel = isException ? !camelConvention : camelConvention;
  return useCamel ? snakeToCamel(snakeName) : snakeName;
}
