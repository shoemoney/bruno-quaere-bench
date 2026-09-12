// seed -> World: vocabulary, id formats, naming, house rules, auth, traps,
// deprecations, and loras. Every facet draws from its own sub-seed so that
// adding a new field later never reshuffles the facets that already exist.

import { rng, sub, pick, int, shuffle } from './seed.js';

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
export const VERSION = '0.4.0';

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

function makeRate(seed) {
  const r = rng(sub(seed, 'rate'));
  return { limit: int(r, 20, 60), windowSec: 10 };
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
