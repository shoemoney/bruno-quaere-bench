// World -> sloppy SKILL.md text (Addendum A). The clean skill.js document is the ground
// truth: every fact it states is correct and every fact stays correct here too. What changes
// is presentation -- the same facts are buried in megabytes of plausible internal-doc noise,
// each one stated multiple times at different (dated or versioned) points in the document's
// history, with the document's own precedence convention as the only way to tell which
// statement is current. Reading carefully resolves it; skimming does not.
//
// Every rule value in this document, true or decoy, is rendered inside backticks, e.g.
// `72` or `nearest`. That convention is deliberate and load-bearing: it is what lets
// truthTable() and its tests search for an exact, unambiguous "claim about this rule" token
// instead of a bare substring that might also occur by coincidence inside filler prose (English
// is full of short common words that collide with enum values like "up" or "down"). Filler
// generators below never wrap a rule's own domain values in backticks, so a backtick-delimited
// occurrence of a rule's value is always a genuine claim -- canonical or decoy -- never noise.
//
// Determinism: every draw in this module comes from sub(world.seed, '<label>'), never from a
// single shared PRNG stream, so adding a new filler generator or rule later never reshuffles
// output that already shipped for an existing seed.

import { rng, sub, pick, int, shuffle, chance } from './seed.js';
// Circular by design: skill.js dispatches its {mode: 'sloppy'} to this module, and this module
// asks skill.js for the clean document's own section bodies to embed (Addendum I rule 3). Both
// bindings are only ever called from inside a function body here, never at module-evaluation
// time, so it resolves fine under ESM's live-binding circular-import handling -- see the
// comment on `sections` in skill.js.
import { sections as cleanSections } from './skill.js';

const PREFIX_FRACTION = 0.15; // > the 10% floor Addendum A requires, with margin
const DEFAULT_TARGET_BYTES = 5 * 1024 * 1024;

const HEADINGS = [
  'Misc', 'Notes from the migration', 'READ THIS (old)', 'Housekeeping', 'Loose ends',
  'Appendix Q', 'Untitled', 'zzz-notes', 'Draft -- do not ship', 'Historical context',
  'Cleanup TODO', 'From the old wiki', 'Random notes', 'Scratch', 'Onboarding leftovers',
  'Ops runbook fragment', 'Team chat archive', 'Postmortem follow-ups', 'Parking lot',
  'Deprecated (kept for reference)', 'Things to file', 'Backlog grooming notes',
  'Context for new hires', 'Open questions', 'Assorted', 'Filed under other',
];

const FAKE_PEOPLE = [
  'Priya', 'Marcus', 'Yuki', 'Delphine', 'Otto', 'Naledi', 'Ravi', 'Astrid', 'Kwame', 'Lior',
  'Sana', 'Theo', 'Berit', 'Constance', 'Idris', 'Malia',
];

const RETIRED_FEATURES = [
  'the legacy thumbnail worker', 'the v0 batch importer', 'the old webhook relay',
  'the standalone lora trainer', 'the CSV export button', 'the inline preview iframe',
  'the polling-only job API', 'the manual re-sign endpoint',
];

const FAQ_QUESTIONS = [
  'Why does the export button say "beta" everywhere?',
  'Who do I ping if a render job never leaves queued?',
  'Is there a Slack channel for this API?',
  'Can I get a staging key without going through the form?',
  'Why did my bookmarked doc link 404 last month?',
  'Do we still support the old importer?',
  'Where do I file a bug against the docs themselves?',
];

const CONFIG_KEYS = [
  'LOG_LEVEL', 'FEATURE_FLAG_X', 'CACHE_TTL_UNRELATED', 'WORKER_POOL_SIZE',
  'METRICS_SAMPLE_RATE', 'BUILD_CHANNEL', 'EXPORT_QUEUE_NAME', 'SHADOW_TRAFFIC_PCT',
];

function pad2(n) { return String(n).padStart(2, '0'); }

function fakeDate(r, baseYear) {
  const year = baseYear + int(r, 0, 5);
  const month = int(r, 1, 12);
  const day = int(r, 1, 28);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function escapeForBacktick(value) {
  // Values here are always short identifiers/numbers with no backtick or newline in them;
  // this is just a defensive guard, not a general-purpose escaper.
  return String(value).replace(/[`\n]/g, '');
}

// --- rule chain construction -----------------------------------------------------------
// A "chain" is one fact restated at several points in the document's history: 2-4 older,
// decoy values plus the one true, current value, each tagged with an ascending marker
// (date or version) under the world's chosen precedence convention.

// Picks 2-4 decoy values from `domain` minus the true value. Some rules are binary
// (opacityCompound, imageFormat, audioFormat, zOrder, bitrateUnit) and so have exactly one
// possible wrong value -- picking WITH repetition (rather than clipping to domain.length-1)
// still produces 2-4 decoy entries for those: the same wrong value restated at different past
// dates/versions, which is exactly what a document that changed its mind more than once, or
// just kept re-copying stale text, looks like.
function enumChain(seed, key, label, trueValue, domain) {
  const r = rng(sub(seed, `sloppy.decoys.${key}`));
  const others = domain.map(String).filter((v) => v !== String(trueValue));
  const count = int(r, 2, 4);
  const decoyValues = Array.from({ length: count }, () => pick(r, others));
  // `domain`: the full enum, string-cast, kept so Addendum J rule 7's extra "retracted" decoy
  // (see drawFreshValue below) can draw a value this chain never rendered elsewhere, rather than
  // reusing one of decoyValues and complicating that value's occurrence accounting.
  return { key, label, trueValue: String(trueValue), decoyValues, domain: domain.map(String) };
}

function rangeChain(seed, key, label, trueValue, lo, hi) {
  const r = rng(sub(seed, `sloppy.decoys.${key}`));
  const count = Math.min(int(r, 2, 4), hi - lo);
  const seen = new Set([trueValue]);
  const out = [];
  let guard = 0;
  while (out.length < count && guard < 2000) {
    guard += 1;
    const v = int(r, lo, hi);
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  // `lo`/`hi`: same purpose as `domain` above, for a range chain's much larger space.
  return { key, label, trueValue: String(trueValue), decoyValues: out.map(String), lo, hi };
}

function buildRuleChains(world) {
  const seed = world.seed;
  const namingTrue = world.naming === 'snake' ? 'snake_case' : 'camelCase';
  const canonDomain = ['ts+method+path', 'method+ts+path', 'path+ts+method', 'path+method+ts', 'method+path+ts'];
  return [
    enumChain(seed, 'dpi', 'The house DPI', world.rules.dpi, [72, 96, 150, 300]),
    enumChain(seed, 'roundTo', 'The rounding grid, in pixels', world.rules.roundTo, [1, 2, 4, 8, 16]),
    enumChain(seed, 'roundMode', 'The rounding direction', world.rules.roundMode, ['nearest', 'up', 'down']),
    enumChain(seed, 'opacityCompound', 'Opacity compounding mode', world.rules.opacityCompound, ['additive', 'multiplicative']),
    enumChain(seed, 'imageFormat', 'Default image format', world.rules.defaultFormat.image, ['svg', 'png']),
    enumChain(seed, 'audioFormat', 'Default audio format', world.rules.defaultFormat.audio, ['wav', 'qa8']),
    enumChain(seed, 'sampleRate', 'Default audio sample rate, in Hz', world.rules.defaultSampleRate, [22050, 44100, 48000]),
    enumChain(seed, 'fps', 'Default video frame rate', world.rules.defaultFps, [12, 24, 30]),
    enumChain(seed, 'zOrder', 'Z-order convention', world.rules.zOrder, ['listOrder', 'explicit']),
    enumChain(seed, 'colorShiftSpace', 'Color-shift math space', world.rules.colorShiftSpace, ['hsl', 'hsv']),
    enumChain(seed, 'bitrateUnit', 'Bitrate budget unit', world.rules.bitrateBudgetUnit, ['KB', 'MB']),
    enumChain(seed, 'cursorStyle', 'Pagination cursor style', world.pagination.cursorStyle, ['b64json', 'b64id', 'opaque']),
    enumChain(seed, 'naming', 'Body field naming convention', namingTrue, ['snake_case', 'camelCase']),
    enumChain(seed, 'canon', 'The publish signing string order', world.hmac.canon, canonDomain),
    rangeChain(seed, 'tokenTtl', 'Bearer token TTL, in seconds', world.auth.tokenTtlSec, 90, 600),
    rangeChain(seed, 'pageSize', 'Default page size', world.pagination.pageSize, 5, 25),
  ];
}

// --- Addendum Q rule 4: dated mid-ladder amendments ---------------------------------------
//
// world.amendments (owned by the ladder workstream, wire contract from ARCHITECTURE.md Addendum
// Q rule 4) is `[{atRung, rule, from, to}]`, one entry per announced amendment rung (30, 55, 78),
// `rule` drawn from the closed set the addendum names: grid step, rounding direction, compounding
// rule, default fps, or the signing canonical string order -- which are exactly the `roundTo`,
// `roundMode`, `opacityCompound`, `fps`, and `canon` rule-chain keys already defined above. That
// file does not exist yet as of this writing (world.js is still 0.6.0); this module is written to
// the wire contract and degrades to a no-op when `world.amendments` is absent or `atRung` is not
// passed, so it activates the moment the ladder side ships without either side needing to
// coordinate a simultaneous edit.
//
// Rendering an amendment is deliberately NOT a new mechanism: it folds the amendment into the
// same rule-chain / marker / precedence machinery every other fact already uses. The amended
// chain's trueValue becomes `to` (so it renders as the document's current, newest-dated answer)
// and `from` is appended as one more decoy in that same chain, so it picks up an ordinary
// ascending marker earlier than the truth's -- "the newest-date-wins convention" resolves it
// exactly the way it resolves every other chain, no special-cased wording required.
//
// `world.js`'s own `AMENDMENT_RULES` (Addendum Q rule 4, shipped alongside this file) names the
// closed set as `roundTo`, `roundMode`, `opacityCompound`, `defaultFps`, `hmacCanon` -- two of
// those (`defaultFps`, `hmacCanon`) spell the same house fact this module's rule chains already
// track under the shorter keys `fps` and `canon` (see buildRuleChains above). This map is the one
// place that translation happens; everything downstream of it talks in this module's own chain
// keys, same as always.
const AMENDMENT_RULE_TO_CHAIN_KEY = {
  roundTo: 'roundTo',
  roundMode: 'roundMode',
  opacityCompound: 'opacityCompound',
  defaultFps: 'fps',
  hmacCanon: 'canon',
};

// activeAmendments(world, atRung) -> amendments in force AT this point in the ladder: only those
// whose atRung <= the given atRung ("renders amendments dated for rungs <= atRung" -- an
// amendment announced at a later rung than the reader has reached does not exist in the document
// yet), one per chain key (the latest qualifying one, in the vanishingly unlikely case two
// announced rungs both amend the same rule before atRung). `world.amendments` is
// `AMENDMENTS_ENFORCED ? drawAmendments(seed) : []` as of world.js 0.7.0, so this is a no-op on
// every world in the wild today and activates the instant that switch flips, with no coordinated
// edit needed on this side.
function activeAmendments(world, atRung) {
  if (atRung === undefined || atRung === null) return [];
  const list = Array.isArray(world.amendments) ? world.amendments : [];
  const byChainKey = new Map();
  for (const a of list) {
    if (!a || typeof a.atRung !== 'number' || a.atRung > atRung) continue;
    const chainKey = AMENDMENT_RULE_TO_CHAIN_KEY[a.rule];
    if (!chainKey) continue; // defensive: only the closed set this module models
    const prev = byChainKey.get(chainKey);
    if (!prev || a.atRung > prev.atRung) byChainKey.set(chainKey, { ...a, chainKey });
  }
  return [...byChainKey.values()].sort((a, b) => a.atRung - b.atRung);
}

// applyAmendments(chains, amendments) -> mutates the matching chains in place (trueValue becomes
// `to`, `from` is appended to decoyValues) and returns a compact record of what it did, including
// `decoyIndex` -- the position `from` landed at in `decoyValues`, so the render loop below can
// flag that ONE specific decoy entry (not every decoy of that chain) as amendment-derived.
// `amendments` entries here already carry `chainKey` (see activeAmendments above); the returned
// record keeps the ladder side's own `rule` name too, so a caller cross-referencing
// `world.amendments` never has to reverse the translation.
function applyAmendments(chains, amendments) {
  const byKey = new Map(chains.map((c) => [c.key, c]));
  const applied = [];
  for (const a of amendments) {
    const chain = byKey.get(a.chainKey);
    if (!chain) continue; // shouldn't happen given the fixed translation table, but never throw on it
    const toValue = String(a.to);
    const fromValue = String(a.from ?? chain.trueValue);
    chain.decoyValues = [...chain.decoyValues, fromValue];
    const decoyIndex = chain.decoyValues.length - 1;
    chain.trueValue = toValue;
    applied.push({ rule: a.rule, chainKey: a.chainKey, atRung: a.atRung, from: fromValue, to: toValue, decoyIndex });
  }
  return applied;
}

// --- Addendum Q rule 5: truth inside noise-headed sections ---------------------------------
//
// "A seeded subset of true rules, and every amendment, is placed inside `### Sync notes`,
// `### Changelog`, `### Pasted from` blocks." Every other buried fact in this document sits under
// an unhelpful-but-generic heading drawn from HEADINGS; these three headings are special because
// they are exactly the ones the filler generators above (genChangelog, genMeetingNotes,
// genSlackPaste) already use for pure noise -- so a reader who filters sections out BY heading
// name to skip the noise deletes the truth right along with it. The block itself is unchanged
// (still one dated, resolvable statement, same marker machinery); only the heading text changes.
const NOISE_HEADING_CLOSERS = {
  syncNotes: ['Came up in the sync, no one has revisited it since.', 'Nobody followed up after the meeting; still sitting here.'],
  changelog: ['Logged in the changelog and never touched again.', 'Filed here during a cleanup pass, then forgotten.'],
  pastedFrom: ["Pasted in from an old message; no idea if it's still accurate.", 'Copied out of the channel history, unverified since.'],
};

function noiseHeading(r) {
  const kind = pick(r, ['syncNotes', 'changelog', 'pastedFrom']);
  const closer = pick(r, NOISE_HEADING_CLOSERS[kind]);
  if (kind === 'syncNotes') return { heading: `Sync notes -- ${fakeDate(r, 2021)}`, closer };
  if (kind === 'changelog') return { heading: 'Changelog (partial, unsorted)', closer };
  return { heading: 'Pasted from #internal-eng', closer };
}

// pickNoiseHeadedChainKeys(seed, chains) -> a seeded, roughly-one-third subset of chain keys
// whose TRUE value gets a noise heading regardless of amendments. Deterministic, and independent
// of atRung/amendments -- this is a standing 0.7.0 property of the sloppy generator, not something
// that only switches on once the ladder side ships world.amendments.
function pickNoiseHeadedChainKeys(seed, chains) {
  const r = rng(sub(seed, 'sloppy.noiseSubset'));
  const keys = new Set();
  for (const c of chains) {
    if (chance(r, 1 / 3)) keys.add(c.key);
  }
  return keys;
}

// --- precedence convention --------------------------------------------------------------

function buildPrecedence(world) {
  const type = pick(rng(sub(world.seed, 'sloppy.precedence.type')), ['date', 'version']);
  const text =
    type === 'date'
      ? "This document's own rule for itself: where the same fact is stated more than once, the entry carrying the newest date wins. An entry with no date on it is not authoritative on its own."
      : "This document's own rule for itself: where the same fact is stated more than once, the entry carrying the highest v-number wins. An entry with no version marker on it is not authoritative on its own.";
  return { type, text };
}

// markersFor(type, r, count): `count` markers, oldest first, STRICTLY ascending.
//
// Strictness is the whole mechanism, not a nicety. The truth is always the last marker in the
// chain, and the document's only stated way to resolve its own contradictions is "the entry
// carrying the newest date (or highest v-number) wins". If any decoy could carry a marker at or
// past the truth's, an agent that read carefully and applied the convention correctly would land
// on a decoy -- the benchmark would punish exactly the behavior it exists to reward. So each
// entry gets its own distinct year, ascending, rather than a per-entry random offset that can
// invert the order. The newest year is also kept in the past, since this is meant to read as an
// internal document's accumulated history.
function markersFor(type, r, count) {
  if (type === 'version') return Array.from({ length: count }, (_, i) => `v${i + 1}`);
  const newestYear = 2022 + int(r, 0, 4);
  return Array.from({ length: count }, (_, i) => {
    const year = newestYear - (count - 1 - i);
    return `${year}-${pad2(int(r, 1, 12))}-${pad2(int(r, 1, 28))}`;
  });
}

function markerLabel(type, marker) {
  return type === 'version' ? `(${marker})` : `(dated ${marker})`;
}

// --- Addendum J rule 7: per-section precedence rotation + one retracted, newer-dated decoy ----
//
// Everywhere else in this document, ONE global precedence convention (picked above, in
// buildPrecedence) resolves every rule chain -- that is what the existing invariants below check
// and what a careful reader learns to rely on. Addendum J asks for a second kind of pressure on
// top of that: one section that states, of ITSELF, a DIFFERENT convention ("in this section the
// highest version wins" when the document's own global rule is date-based, or the date-based
// mirror of that sentence when the global rule is version-based), plus one extra decoy for a
// real rule -- carrying a date marker that reads as newer than every genuine truth marker in the
// whole document -- immediately followed by an explicit retraction two lines later. The decoy is
// never authoritative under EITHER convention: the local rule here is versioned/dated the other
// way, and the retraction says so outright regardless. This is still never an unmarked
// contradiction (every claim here is dated, and the wrong one is flagged wrong in the text
// itself) and the document is still a strict superset of the clean skill's facts -- this block
// adds one extra, clearly-resolved wrinkle, it does not remove or reword anything else.
//
// Extra decoy VALUES are drawn fresh (never reusing one of the chain's own recorded decoy
// values), so this block's token never collides with -- and so never needs folding into -- the
// existing per-chain occurrence accounting the "contradiction scan" test performs; it gets its
// own, separate test instead.
function drawFreshValue(seed, chain) {
  if (chain.domain) {
    const used = new Set([chain.trueValue, ...chain.decoyValues]);
    const fresh = chain.domain.filter((v) => !used.has(v));
    const r = rng(sub(seed, `sloppy.sectionPrecedence.value.${chain.key}`));
    if (fresh.length > 0) return pick(r, fresh);
    return pick(r, chain.domain.filter((v) => v !== chain.trueValue)); // binary domain: reuse tolerated
  }
  const used = new Set([chain.trueValue, ...chain.decoyValues]);
  const r = rng(sub(seed, `sloppy.sectionPrecedence.value.${chain.key}`));
  let guard = 0;
  while (guard < 500) {
    guard += 1;
    const v = String(int(r, chain.lo, chain.hi));
    if (!used.has(v)) return v;
  }
  return chain.decoyValues[0];
}

// Builds the whole special block's text and every offset a test needs, but does NOT append it --
// the caller places it like any other item so its position in the document is seeded the same
// way everything else's is.
function buildSectionPrecedenceBlock(world, globalPrecedence, chains) {
  const seed = world.seed;
  // A binary-domain chain (opacityCompound, zOrder, naming, ...) has no value left over once its
  // truth and 2-4 decoys are drawn, so drawFreshValue would have to reuse one -- which is exactly
  // the unmarked-collision case the contradiction scan exists to catch. Restrict the pick to
  // chains that provably have a spare value (every range chain does; an enum chain does whenever
  // its domain outsizes what it already used).
  const usable = chains.filter((c) => {
    if (!c.domain) return true;
    return c.domain.length > new Set([c.trueValue, ...c.decoyValues]).size;
  });
  const chain = pick(rng(sub(seed, 'sloppy.sectionPrecedence.chain')), usable.length > 0 ? usable : chains);
  const localType = globalPrecedence.type === 'date' ? 'version' : 'date';
  const localText =
    localType === 'version'
      ? "In this section, the entry carrying the highest v-number wins, no matter what the rest of this document says about dates."
      : "In this section, the entry carrying the newest date wins, no matter what the rest of this document says about version numbers.";

  // "Newer-dated": strictly after the newest date-marker YEAR that appears anywhere else in the
  // document. When the global convention is itself date-based, that is the max truth-marker year
  // across every chain (each chain's own newest marker is its truth's, by construction --
  // markersFor() only ever ascends). When the global convention is version-based, nothing else in
  // the document carries a date at all, so any ordinary near-future year already reads as newer.
  let baseYear;
  if (globalPrecedence.type === 'date') {
    baseYear = 0;
    for (const c of chains) {
      const rMark = rng(sub(seed, `sloppy.markers.${c.key}`));
      const markers = markersFor('date', rMark, c.decoyValues.length + 1);
      const truthYear = Number(markers[markers.length - 1].slice(0, 4));
      if (truthYear > baseYear) baseYear = truthYear;
    }
  } else {
    baseYear = 2026;
  }
  const rYear = rng(sub(seed, 'sloppy.sectionPrecedence.year'));
  const year = baseYear + 1 + int(rYear, 0, 2);
  const retractedMarker = `${year}-${pad2(int(rYear, 1, 12))}-${pad2(int(rYear, 1, 28))}`;

  const value = drawFreshValue(seed, chain);
  const token = `${chain.key}=${escapeForBacktick(value)}`;
  const claimLine = `(dated ${retractedMarker}) ${chain.label} is \`${token}\`. Just turned up going through an old export, flagging it here.`;
  const bufferLine = 'No other context was attached to this note at the time it was found.';
  const retractionLine = 'RETRACTED -- ignore the line two above; it was a copy-paste error caught in review and never reflected a real value.';

  return { chain, localType, localText, retractedMarker, value, token, claimLine, bufferLine, retractionLine };
}

// Renders one buildSectionPrecedenceBlock() spec as its own `### ` block (same shape as every
// other buried block) and records every offset a test needs. "Two lines later": claimLine and
// retractionLine sit two document lines apart (bufferLine is the one line between them), which is
// what lets a test assert the exact spacing Addendum J calls for rather than just "somewhere below".
function renderSectionPrecedenceEntry(state, headingsPick, spec) {
  const heading = pick(headingsPick, HEADINGS);
  const lines = [`### ${heading}`, '', spec.localText, '', spec.claimLine, spec.bufferLine, spec.retractionLine, ''];
  const block = lines.join('\n');
  const { start } = appendChunk(state, block);
  const localTextOffset = start + block.indexOf(spec.localText);
  const claimLineOffset = start + block.indexOf(spec.claimLine);
  const retractionLineOffset = start + block.indexOf(spec.retractionLine);
  const needle = '`' + spec.token + '`';
  const valueOffset = start + block.indexOf(needle) + 1 + spec.chain.key.length + 1; // past `, key, '='
  return { heading, localTextOffset, claimLineOffset, retractionLineOffset, valueOffset };
}

// --- filler generators -------------------------------------------------------------------
// Each returns a self-contained block of prose. None of these ever wrap a short generic word
// in backticks -- that's reserved for genuine rule-value claims -- so they can never collide
// with a rule chain's marked occurrences.

function genChangelog(world, r) {
  const lines = ['### Changelog (partial, unsorted)', ''];
  const n = int(r, 3, 6);
  for (let i = 0; i < n; i++) {
    const date = fakeDate(r, 2020);
    const verb = pick(r, ['Fixed', 'Reworked', 'Tweaked', 'Removed', 'Added', 'Renamed']);
    const noun = pick(r, [
      'the retry backoff in the export worker', 'a race in the thumbnail cache',
      'the staging vs prod env banner', 'an off-by-one in the changelog itself',
      'the onboarding email template', 'a flaky assertion in the smoke suite',
      'the internal metrics dashboard link', 'a typo in the runbook',
    ]);
    lines.push(`- ${date}: ${verb} ${noun}.`);
  }
  return lines.join('\n') + '\n';
}

function genMeetingNotes(world, r) {
  const date = fakeDate(r, 2021);
  const attendees = shuffle(r, FAKE_PEOPLE).slice(0, int(r, 2, 4));
  const lines = [`### Sync notes -- ${date}`, '', `Attendees: ${attendees.join(', ')}`, ''];
  const n = int(r, 2, 4);
  for (let i = 0; i < n; i++) {
    lines.push(`- ${pick(r, attendees)}: ${pick(r, [
      'no update, still blocked on infra ticket',
      'shipped the dashboard change from last week',
      'wants a second pair of eyes on the queue depth alert',
      'raised that the wiki search is basically unusable',
      'reminded everyone the retro doc is due Friday',
      'asked whether anyone still owns the old crawler',
    ])}.`);
  }
  return lines.join('\n') + '\n';
}

function genSlackPaste(world, r) {
  const lines = ['### Pasted from #internal-eng', ''];
  const n = int(r, 3, 5);
  for (let i = 0; i < n; i++) {
    const who = pick(r, FAKE_PEOPLE);
    const hh = int(r, 8, 18);
    const mm = pad2(int(r, 0, 59));
    lines.push(`**${who}** [${hh}:${mm}] ${pick(r, [
      'anyone know why the staging box keeps rebooting',
      'lol the docs site cache took another hour to bust',
      'reminder we still owe design a review on the empty states',
      'the on-call rotation doc is out of date again',
      'does anyone still use the old export button',
      'shipping a small fix, will ping if anything breaks',
    ])}`);
  }
  return lines.join('\n') + '\n';
}

function genFaq(world, r) {
  const qs = shuffle(r, FAQ_QUESTIONS).slice(0, int(r, 2, 4));
  const lines = ['### FAQ', ''];
  for (const q of qs) {
    lines.push(`**Q: ${q}**`);
    lines.push(`A: ${pick(r, [
      'Ask in the internal channel, nobody has written this down properly yet.',
      'Not officially, but it comes up often enough that it should be.',
      'Yes, but it is being phased out -- do not build anything new on it.',
      'This is tracked, no ETA.',
      'Check with whoever is on-call this week.',
    ])}`);
    lines.push('');
  }
  return lines.join('\n');
}

function genConfigTable(world, r) {
  const keys = shuffle(r, CONFIG_KEYS).slice(0, int(r, 3, 6));
  const lines = ['### Unrelated service config (for the record)', '', '| Key | Value |', '|---|---|'];
  for (const k of keys) {
    const v = pick(r, ['true', 'false', 'default', String(int(r, 1, 999)), 'unset']);
    lines.push(`| ${k} | ${v} |`);
  }
  return lines.join('\n') + '\n';
}

function genRetiredFeature(world, r) {
  const feature = pick(r, RETIRED_FEATURES);
  const year = 2018 + int(r, 0, 5);
  return [
    `### ${feature[0].toUpperCase()}${feature.slice(1)} (RETIRED, kept for history)`,
    '',
    `${feature[0].toUpperCase()}${feature.slice(1)} was retired in ${year} and no longer exists. Nothing in this section describes current behavior; it is kept only so old links do not 404. Do not implement against anything below this line in this subsection.`,
    '',
  ].join('\n');
}

function genTodos(world, r) {
  const n = int(r, 2, 5);
  const lines = ['### TODO', ''];
  for (let i = 0; i < n; i++) {
    lines.push(`- [ ] ${pick(r, [
      'file a ticket for the flaky nightly job',
      'ask design about the empty-state illustration',
      'move this doc out of the wiki graveyard',
      'double check the on-call handoff doc is current',
      'delete the retired-feature section once nobody complains',
      'reconcile this page with the actual OpenAPI file',
    ])}`);
  }
  return lines.join('\n') + '\n';
}

function genCommentedYaml(world, r) {
  const lines = ['```yaml', '# old pipeline config, left here for reference, not applied anywhere', '# stage: build'];
  const n = int(r, 3, 6);
  for (let i = 0; i < n; i++) {
    lines.push(`#   ${pick(r, ['timeout', 'retries', 'concurrency', 'cache', 'artifact_ttl'])}: ${int(r, 1, 99)}`);
  }
  lines.push('```', '');
  return lines.join('\n');
}

function genDuplicateIntro(world, r, introText) {
  // A duplicated section with a seeded typo -- reproduces earlier FILLER prose (never a rule
  // value) with one word lightly mangled, the way a copy-pasted section actually looks.
  const words = introText.split(' ');
  if (words.length > 4) {
    const idx = int(r, 1, words.length - 2);
    const w = words[idx];
    if (w.length > 3) {
      const pos = int(r, 1, w.length - 1);
      words[idx] = w.slice(0, pos) + w[pos] + w.slice(pos);
    }
  }
  return ['### Copy of the intro (someone pasted this twice)', '', words.join(' '), ''].join('\n');
}

const FILLER_GENERATORS = [
  genChangelog, genMeetingNotes, genSlackPaste, genFaq, genConfigTable,
  genRetiredFeature, genTodos, genCommentedYaml,
];

// --- assembly ------------------------------------------------------------------------------

function appendChunk(state, text) {
  const start = state.pos;
  state.chunks.push(text);
  state.pos += text.length;
  return { start, end: state.pos };
}

// Renders one marked statement of a chain (either the true value or one decoy), inside its own
// small section under an unhelpful heading, and records where the value itself sits.
//
// The token is rendered `key=value` inside its backticks, not a bare `value` -- several rule
// chains draw from overlapping numeric domains (pageSize's 5-25 range overlaps roundTo's
// {1,2,4,8,16}; tokenTtl's 90-600 range overlaps dpi's {72,96,150,300}), so a bare backticked
// number cannot be attributed to one rule by its text alone. Namespacing with the chain's key
// makes every rendered token unique to its rule by construction, independent of which numbers
// the world happened to roll.
function renderChainEntry(state, headingsPick, precedence, entry, noiseRng) {
  // Addendum Q rule 5: a noise-headed entry (a seeded subset of true rules, and every amendment)
  // renders under one of the three noise headings instead of the generic HEADINGS pool, with a
  // closing line that reads like that noise kind rather than the generic "carried over" sentence.
  const noise = entry.noiseHeaded ? noiseHeading(noiseRng) : null;
  const heading = noise ? noise.heading : pick(headingsPick, HEADINGS);
  const markerText = markerLabel(precedence.type, entry.marker);
  const valueText = escapeForBacktick(entry.value);
  const token = `${entry.chainKey}=${valueText}`;
  const closer = noise ? noise.closer : 'Carried over from an earlier pass at this document; not re-verified since.';
  const body = `${markerText} ${entry.label} is \`${token}\`. ${closer}`;
  const block = [`### ${heading}`, '', body, ''].join('\n');
  const { start, end } = appendChunk(state, block);
  const localIdx = block.indexOf('`' + token + '`');
  const valueOffset = start + localIdx + 1 + entry.chainKey.length + 1; // past the backtick, the key, and '='
  return {
    offset: valueOffset,
    blockStart: start,
    blockEnd: end,
    marker: entry.marker,
    value: entry.value,
    heading,
    noiseHeaded: Boolean(entry.noiseHeaded),
  };
}

function renderSpecialBlock(state, headingsPick, heading, bodyLines) {
  const block = [`### ${heading}`, '', ...bodyLines, ''].join('\n');
  const { start, end } = appendChunk(state, block);
  return { start, end };
}

// --- Addendum I rule 3: full clean-skill sections, embedded verbatim ---------------------
// Unlike a rule chain, a prose section from the clean skill is not a scalar fact with 2-4
// decoy readings -- it's the actual signing recipe, the actual worked example, the actual
// state-machine paragraph. There is exactly one true copy of each, and the fix for "the
// sloppy doc dropped the whole publish-signing recipe" is to paste that one true copy in,
// intact, somewhere a careful reader will find it. So these get a note explaining why an
// old copy of a whole section is sitting in an internal doc (plausible -- teams do this) and
// then the section's body, character for character, with nothing inserted into the middle of
// it: the filler and the wrapper note are entirely outside the appendChunk call that emits it.
const SECTION_COPY_NOTES = [
  (h) => `(pasted wholesale from an older copy of the house-rules skill; that document called this section "${h}")`,
  (h) => `Mirror of the published skill's "${h}" section, copied here in case the live doc ever moves. Word for word, as far as anyone checked.`,
  (h) => `Someone pasted the whole "${h}" section into this doc a while back so it would not get lost.`,
  (h) => `Full copy of "${h}" from the reference skill, kept here for people who do not want to click through.`,
  (h) => `Backup of "${h}" from before the last skill rewrite. May or may not still match the live one -- it does, this time.`,
];

function renderSectionBlock(state, headingsPick, notePick, item) {
  const heading = pick(headingsPick, HEADINGS);
  const note = pick(notePick, SECTION_COPY_NOTES)(item.heading);
  const before = [`### ${heading}`, '', note, ''].join('\n');
  appendChunk(state, before);
  const { start, end } = appendChunk(state, item.body);
  appendChunk(state, '\n\n');
  return { offset: start, length: end - start, heading: item.heading };
}

function build(world, targetBytes, atRung) {
  const seed = world.seed;
  const state = { chunks: [], pos: 0 };
  const rFiller = rng(sub(seed, 'sloppy.filler'));
  const rHeadings = rng(sub(seed, 'sloppy.headings'));
  const rLayout = rng(sub(seed, 'sloppy.layout'));
  const rSectionNote = rng(sub(seed, 'sloppy.sectionNotes'));
  const rNoiseHeading = rng(sub(seed, 'sloppy.noiseHeadingText'));

  const title = [
    `# ${world.vocab.workspace} media house -- internal notes (unsorted)`,
    '',
    'This is not the published reference. It is the working document the team actually edits,',
    'which means it is long, out of order, and has old answers sitting next to current ones.',
    'Nothing below has been reorganized or cleaned up before being handed to you.',
    '',
  ].join('\n');
  appendChunk(state, title);

  // Precedence convention text is generated now (its wording is fixed) but not placed in the
  // document until after the mandatory filler prefix, satisfying the "never in the first 10%"
  // requirement with margin.
  const precedence = buildPrecedence(world);

  // Leading filler prefix: pure noise, no rule facts, no precedence statement, sized past the
  // 10% floor before anything load-bearing appears.
  const prefixTarget = targetBytes * PREFIX_FRACTION;
  let genIdx = 0;
  while (state.pos < prefixTarget) {
    const gen = FILLER_GENERATORS[genIdx % FILLER_GENERATORS.length];
    genIdx += 1;
    appendChunk(state, gen(world, rFiller));
  }

  // Precedence convention: exactly one statement, own section, past the prefix.
  const precedenceBlockHeading = pick(rHeadings, HEADINGS);
  const precedenceBlock = renderSpecialBlock(state, rHeadings, precedenceBlockHeading, [precedence.text]);
  const precedenceOffset = state.chunks[state.chunks.length - 1].indexOf(precedence.text) + precedenceBlock.start;

  // Unit words: the four-things burial, no decoy chain (a multi-word list, not a scalar).
  const unitLines = Object.entries(world.rules.unitWords).map(
    ([unit, words]) => `${unit}: ${words.map((w) => `\`${w}\``).join(', ')}`,
  );
  const unitBlock = renderSpecialBlock(state, rHeadings, pick(rHeadings, HEADINGS), [
    "The accepted words for each house unit, in case the reference copy of this table ever drifts:",
    '',
    ...unitLines,
  ]);

  // Lora names: same treatment.
  const loraBlock = renderSpecialBlock(state, rHeadings, pick(rHeadings, HEADINGS), [
    'The current lora roster (names only; see the library endpoint for ids):',
    '',
    world.loras.map((l) => `\`${l.name}\``).join(', '),
  ]);

  // Addendum G: two facts stated plainly, once, with no decoy chain and nothing to resolve --
  // unlike the rule chains below, there is only ever one true statement of either of these in
  // this document, so there is no precedence convention to apply and nothing to get wrong other
  // than not reading this far.
  renderSpecialBlock(state, rHeadings, pick(rHeadings, HEADINGS), [
    'Two things that keep coming up when people hand-roll the unit math instead of just sending',
    'the unit:',
    '',
    "- The API itself takes width/height in a house unit directly (send `unit` alongside them)",
    'and converts server-side, on its own, every time. Converting by hand first is never required',
    '-- it is purely the caller\'s own choice, and if you make that choice your arithmetic has to',
    'land exactly where the house\'s does.',
    '- Before the house rounds a converted dimension onto the grid, it snaps the raw (un-rounded)',
    'pixel product to 6 decimal places. Do this yourself too if you convert by hand -- it is what',
    'keeps a raw product that works out to, say, 168.00000000000003 in floating point landing on',
    'exactly 168 instead of one float-noise hair off it.',
  ]);

  // Rule chains: flatten into individual (chain, marker, value, isTruth) items, one item is
  // the true value, the rest are decoys, each gets its own marker ascending oldest to newest.
  const chains = buildRuleChains(world);

  // Addendum Q rule 4: fold in whichever amendments are in force as of `atRung` BEFORE flattening
  // -- this mutates chain.trueValue/decoyValues so every downstream step (markers, shuffle,
  // rendering) treats an amended chain exactly like any other chain, with no separate code path.
  const appliedAmendments = applyAmendments(chains, activeAmendments(world, atRung));
  const amendedByChain = new Map(appliedAmendments.map((a) => [a.chainKey, a]));

  // Addendum Q rule 5: a seeded subset of chains get their TRUE value noise-headed regardless of
  // amendments; every amendment additionally forces noise-heading on both its `to` (the new truth)
  // and its specific `from` decoy (identified by decoyIndex, not by value, since decoy values can
  // legitimately repeat -- see enumChain's comment on binary domains above).
  const noiseHeadedChainKeys = pickNoiseHeadedChainKeys(seed, chains);

  const flatItems = [];
  for (const chain of chains) {
    const rMark = rng(sub(seed, `sloppy.markers.${chain.key}`));
    const totalCount = chain.decoyValues.length + 1;
    const markers = markersFor(precedence.type, rMark, totalCount);
    const amendment = amendedByChain.get(chain.key);
    chain.decoyValues.forEach((value, i) => {
      flatItems.push({
        type: 'rule',
        chainKey: chain.key,
        label: chain.label,
        value,
        marker: markers[i],
        isTruth: false,
        noiseHeaded: Boolean(amendment) && i === amendment.decoyIndex,
      });
    });
    flatItems.push({
      type: 'rule',
      chainKey: chain.key,
      label: chain.label,
      value: chain.trueValue,
      marker: markers[markers.length - 1],
      isTruth: true,
      noiseHeaded: Boolean(amendment) || noiseHeadedChainKeys.has(chain.key),
    });
  }

  // Addendum I rule 3: every `## ` section of the clean skill, as its own item, mixed in with
  // the rule-chain items so it lands anywhere the shuffle puts it -- never in the mandatory
  // filler prefix above, since that's already emitted, but otherwise unpredictable per seed.
  const cleanSecs = cleanSections(world);
  const sectionItems = cleanSecs.map((s) => ({ type: 'section', heading: s.heading, body: s.body }));

  // Addendum J rule 7: the one rotated-precedence, retracted-decoy block, mixed into the same
  // shuffle so its position varies per seed exactly like everything else -- the only fixed
  // guarantee (checked below, same as every other buried fact) is that it lands past the 10% mark.
  const sectionPrecedenceSpec = buildSectionPrecedenceBlock(world, precedence, chains);
  const sectionPrecedenceItems = [{ type: 'sectionPrecedence', spec: sectionPrecedenceSpec }];

  const order = shuffle(rLayout, [...flatItems, ...sectionItems, ...sectionPrecedenceItems]);

  const byChain = new Map(chains.map((c) => [c.key, { key: c.key, label: c.label, truth: null, decoys: [] }]));
  const bySection = new Map(cleanSecs.map((s) => [s.heading, { heading: s.heading, offset: null, length: null }]));

  const introTextForDuplicate = title.split('\n')[2] || 'This is not the published reference.';
  let dupCounter = 0;
  let sectionPrecedenceRendered = null;

  for (const item of order) {
    // A little filler before each item keeps items from clumping and adds required variety;
    // every few items, use the duplicate-with-typo generator specifically.
    dupCounter += 1;
    if (dupCounter % 7 === 0) {
      appendChunk(state, genDuplicateIntro(world, rFiller, introTextForDuplicate));
    } else {
      const gen = FILLER_GENERATORS[genIdx % FILLER_GENERATORS.length];
      genIdx += 1;
      appendChunk(state, gen(world, rFiller));
    }

    if (item.type === 'rule') {
      const rendered = renderChainEntry(state, rHeadings, precedence, item, rNoiseHeading);
      const rec = byChain.get(item.chainKey);
      if (item.isTruth) rec.truth = rendered;
      else rec.decoys.push(rendered);
    } else if (item.type === 'sectionPrecedence') {
      sectionPrecedenceRendered = renderSectionPrecedenceEntry(state, rHeadings, item.spec);
    } else {
      const rendered = renderSectionBlock(state, rHeadings, rSectionNote, item);
      const rec = bySection.get(item.heading);
      rec.offset = rendered.offset;
      rec.length = rendered.length;
    }
  }

  // Trailing padding: keep adding filler until close to the target, favoring generator variety.
  while (state.pos < targetBytes * 0.99) {
    const gen = FILLER_GENERATORS[genIdx % FILLER_GENERATORS.length];
    genIdx += 1;
    const chunk = gen(world, rFiller);
    if (state.pos + chunk.length > targetBytes * 1.05) break;
    appendChunk(state, chunk);
  }

  const closing = ['---', '', `(seed ${world.seed}, generated, do not hand-edit)`, ''].join('\n');
  appendChunk(state, closing);

  const doc = state.chunks.join('');

  const rules = chains.map((c) => {
    const rec = byChain.get(c.key);
    return { key: c.key, label: c.label, truth: rec.truth, decoys: rec.decoys };
  });

  // Section offsets in clean-document order (not shuffle order), so a caller can look one up
  // by heading without re-deriving cleanSections(world) itself.
  const sections = cleanSecs.map((s) => {
    const rec = bySection.get(s.heading);
    return { heading: s.heading, offset: rec.offset, length: rec.length, body: s.body };
  });
  const publishSigningSection = sections.find((s) => s.heading === 'Publish signing');

  const truth = {
    seed: world.seed,
    targetBytes,
    length: doc.length,
    precedence: { type: precedence.type, text: precedence.text, offset: precedenceOffset },
    fourThings: {
      precedenceConvention: precedenceOffset,
      unitWords: unitBlock.start,
      loraNames: loraBlock.start,
      // Addendum I: the "signing recipe" one of the four things is now the whole embedded
      // "Publish signing" section (X-Signature, X-Timestamp, the canonical string, the worked
      // example) -- not just the scalar canon-ordering fact, which is also still tracked below
      // as the 'canon' rule chain.
      signingRecipe: publishSigningSection ? publishSigningSection.offset : null,
    },
    rules,
    sections,
    // Addendum Q rule 4: amendments in force as of `atRung` (empty when atRung is not passed, or
    // world.amendments is absent/doesn't reach this atRung). `toOffset`/`fromOffset` point at the
    // exact same rule-chain entries `rules` already carries (rules.find(r => r.key === rule).truth
    // / .decoys), duplicated here so a caller checking "did the amendment actually land" never has
    // to cross-reference decoyIndex through the shuffle itself.
    amendments: appliedAmendments.map((a) => {
      const rec = byChain.get(a.chainKey);
      const fromEntry = rec.decoys.find((d) => d.noiseHeaded && d.value === a.from);
      return {
        rule: a.rule,
        chainKey: a.chainKey,
        atRung: a.atRung,
        from: a.from,
        to: a.to,
        toOffset: rec.truth.offset,
        toHeading: rec.truth.heading,
        fromOffset: fromEntry ? fromEntry.offset : null,
        fromHeading: fromEntry ? fromEntry.heading : null,
      };
    }),
    // Addendum J rule 7: see buildSectionPrecedenceBlock / renderSectionPrecedenceEntry above.
    // `localTextOffset`/`retracted.*Offset` are all string indices into `doc`, same convention
    // as everything else here.
    sectionPrecedence: {
      chainKey: sectionPrecedenceSpec.chain.key,
      localType: sectionPrecedenceSpec.localType,
      localText: sectionPrecedenceSpec.localText,
      localTextOffset: sectionPrecedenceRendered.localTextOffset,
      retracted: {
        marker: sectionPrecedenceSpec.retractedMarker,
        value: sectionPrecedenceSpec.value,
        offset: sectionPrecedenceRendered.valueOffset,
        claimOffset: sectionPrecedenceRendered.claimLineOffset,
        retractionOffset: sectionPrecedenceRendered.retractionLineOffset,
      },
    },
  };

  return { doc, truth };
}

const cache = new WeakMap();

function memoBuild(world, targetBytes, atRung) {
  let perWorld = cache.get(world);
  if (!perWorld) {
    perWorld = new Map();
    cache.set(world, perWorld);
  }
  const cacheKey = `${targetBytes}:${atRung ?? ''}`;
  if (!perWorld.has(cacheKey)) {
    perWorld.set(cacheKey, build(world, targetBytes, atRung));
  }
  return perWorld.get(cacheKey);
}

// toSkill(world, {targetBytes, atRung}) -> sloppy SKILL.md text, deterministic per
// (world.seed, targetBytes, atRung). `atRung` (Addendum Q rule 4) is the rung the reader has
// reached: amendments announced at or before it are folded into the document; omitting it (the
// default) renders the document with no amendments applied at all, unchanged from before this
// option existed.
export function toSkill(world, opts = {}) {
  const targetBytes = opts.targetBytes ?? DEFAULT_TARGET_BYTES;
  return memoBuild(world, targetBytes, opts.atRung).doc;
}

// truthTable(world, {targetBytes}) -> { precedence, fourThings, rules: [{key,label,truth,decoys}],
// sections: [{heading,offset,length,body}] } with every offset a JS string index into the
// document toSkill(world, opts) would return. These coincided with UTF-8 byte
// offsets while the document was ASCII-only; since Addendum I rule 3 embeds the clean skill's
// sections verbatim, the document carries whatever non-ASCII they do (today: the `->` arrow the
// clean skill renders as U+2192), so index and byte offset diverge after the first such
// character. Slice the string, never a Buffer. `truth`/each decoy is
// `{offset, blockStart, blockEnd, marker, value}` where
// `offset` is the index of the first character of the value itself, always immediately preceded
// and followed by a backtick. `sections` (Addendum I rule 3) is one entry per `## ` section of
// the clean skill, in clean-document order, each with the exact index range of that section's
// body as embedded verbatim somewhere in the sloppy document -- `doc.slice(offset, offset +
// length) === body`, and `body` is also exactly what skill.js's own `sections(world)` returns.
// `sectionPrecedence` (Addendum J rule 7) is the one rotated-local-convention block:
// `{chainKey, localType, localText, localTextOffset, retracted: {marker, value, offset,
// claimOffset, retractionOffset}}` -- `chainKey` names which of `rules` it restates, `localType`
// is always the OPPOSITE of `precedence.type`, and `retracted` is the newer-dated decoy that is
// explicitly retracted two document lines below its own claim (`retractionOffset`'s line is
// exactly `claimOffset`'s line + 2). `amendments` (Addendum Q rule 4) is one entry per amendment
// in force as of `opts.atRung` -- `{rule, chainKey, atRung, from, to, toOffset, toHeading,
// fromOffset, fromHeading}` (`rule` is world.js's own AMENDMENT_RULES name, e.g. `hmacCanon`;
// `chainKey` is this module's matching rule-chain key, e.g. `canon`, and is what `rules` above is
// keyed by) -- empty when `opts.atRung` is omitted. Every `rules[].truth`/`.decoys[]` entry
// also now carries `heading` (the exact heading text, sans `### `) and `noiseHeaded` (Addendum Q
// rule 5): when true, `doc.slice(blockStart, blockStart + heading.length + 4)` is
// `### ${heading}` and `heading` starts with `Sync notes`, `Changelog`, or `Pasted from`.
export function truthTable(world, opts = {}) {
  const targetBytes = opts.targetBytes ?? DEFAULT_TARGET_BYTES;
  return memoBuild(world, targetBytes, opts.atRung).truth;
}
