// (world, n) -> Rung: plain-language task text, the reference's exact execution plan, and the
// answer-key descriptors computed purely through media.js (via grammar.js's local interpreter).

import { bandFor, composePlan, runPlanLocally } from './grammar.js';

// ---------------------------------------------------------------------------
// text helpers -- plain language only, never a route/descriptor field name
// ---------------------------------------------------------------------------

// Task text doesn't need its own rng draw (the plan's own rng already consumed what it needed),
// so text just uses the first listed synonym for the unit in play -- still varies rung to rung
// because *which* unit and *which world* varies. world.rules.unitWords is keyed by the unit's
// English label ('inch'/'cm'/'pt'), while media.js's own unit codes are 'in'/'cm'/'pt'.
const UNIT_LABEL = { in: 'inch', cm: 'cm', pt: 'pt' };

function firstUnitWord(world, unit) {
  return world.rules.unitWords[UNIT_LABEL[unit]][0];
}

// "the piece you turned in at step 12" -- Addendum J rule 1. A cross-rung reference names an
// earlier rung and the property borrowed from it, and never, ever the value.
function earlierPiece(fromRung) {
  return `the piece you turned in at step ${fromRung}`;
}

function describeDims(world, params, crossRef) {
  if (crossRef && crossRef.field === 'dims') return `as wide and as tall as ${earlierPiece(crossRef.fromRung)}`;
  const { width, height, unit } = params;
  if (!unit) return `${width} by ${height} pixels`;
  const word = firstUnitWord(world, unit);
  // A house unit word can be a bare symbol (" or '); glue those to the number so the task reads
  // as a measurement and not as a dangling quote.
  return /^[a-z]/i.test(word) ? `${width} by ${height} ${word}` : `${width} by ${height}${word}`;
}

function percentOf(value) {
  return `${Math.round(value * 100)} percent`;
}

// Every leaf the artifact's bytes depend on has to be in the task, or no reader could reproduce
// the expected hash -- EXCEPT a leaf borrowed from an earlier rung (Addendum J rule 1), which is
// reproducible from the agent's own earlier work, and a number the API has to be asked for
// (Addendum J rule 2), which is reproducible from the stated recipe. Only the house's own rules
// (unit-to-pixel conversion, the rounding grid, the default file flavor, sample rate and frame
// rate, what a stacking step compounds to) stay unsaid -- those live in the skill, and looking
// them up is the point.
function describeShape(shape) {
  const paint = `painted ${shape.color} at ${percentOf(shape.opacity)} solid`;
  if (shape.type === 'rect') {
    return `a rectangle ${shape.w} across and ${shape.h} down, its top-left corner ${shape.x} from the left and ${shape.y} from the top, ${paint}`;
  }
  if (shape.type === 'circle') {
    return `a circle of radius ${shape.r} centred ${shape.x} from the left and ${shape.y} from the top, ${paint}`;
  }
  return `a line running from (${shape.x}, ${shape.y}) to (${shape.x2}, ${shape.y2}), counting from the top-left corner, ${paint}`;
}

function describeGround(params, crossRef) {
  if (crossRef && crossRef.field === 'ground') return `the same ground colour as ${earlierPiece(crossRef.fromRung)}`;
  return params.background.color !== undefined ? `a ${params.background.color} ground` : 'a see-through ground';
}

function describeShapes(params, crossRef) {
  const list = params.shapes.map((s, i) => `(${i + 1}) ${describeShape(s)}`).join('; ');
  return `on ${describeGround(params, crossRef)}, carrying these, bottom of the pile first: ${list}`;
}

function describeNote(note) {
  return `${note.durMs} ms of ${note.freq} hertz starting ${note.startMs} ms in, ${percentOf(note.amp)} loud, ${note.wave}-shaped`;
}

function describeTones(params) {
  const list = params.notes.map((n, i) => `(${i + 1}) ${describeNote(n)}`).join('; ');
  return `running ${params.durationMs} ms end to end and carrying these tones in order: ${list}`;
}

function describeCreate(world, kind, params, crossRef) {
  if (kind === 'image') return `a picture ${describeDims(world, params, crossRef)}, ${describeShapes(params, crossRef)}`;
  return `a short sound ${describeTones(params)}`;
}

// "the one the house calls X" -- a display label, never an id. The agent still has to list and
// match, which is the API-calling half of the exercise.
function labelled(noun, label) {
  return `the ${noun} the house calls "${label}"`;
}

function describeKind(kind, kindOption) {
  if (kind === 'image') return kindOption === 'png' ? 'a bitmap file' : 'a vector file';
  return kindOption === 'wav' ? 'plain wave audio' : 'the compact house audio flavor';
}

function countOfThem(count) {
  return count === 1 ? 'one' : `${count} of them`;
}

// ---------------------------------------------------------------------------
// chain text
//
// grammar.js hands the narrative the SAME chain it expanded into plan steps, so a rung's prose
// and its answer key cannot drift apart: every lookup and every resize in the plan is rendered
// here, in plan order, and nothing that is not in the plan is.
// ---------------------------------------------------------------------------

const ROUND_NOTE = 'The house rounds every size to its usual grid; do that after every resize, in the order you do them, not just once at the end.';

// Trap-dependence, pulled down into rungs 15-39 (and kept at the top) by Addendum C's round-2
// steepening. The written reference is wrong about at least one call each of these rungs needs,
// and the only way through is to look at what the live house actually hands back.
const TRAP_NOTE = "Take nothing here on the written reference's word: at least one thing it says about the calls this needs is wrong about the live house, so check what actually comes back.";

// Addendum J rule 3. The change is announced, never named: an agent that reads every reply gets
// through it, an agent that hardcoded the shape of the first reply it ever saw does not.
const MUTATION_NOTE = 'Fair warning: the house has changed something about the way it answers, starting with this piece of work. Nobody will tell you what. Read what actually comes back on every call rather than what you expected to come back.';

// Addendum J rule 6. Three or more house rules land in one chain and they do not commute.
const ORDER_NOTE = 'Order is the whole game here: a house style and a resize do not commute, and the grid rounding lands again after every single step. Do these one at a time, in exactly the order written, reading each new size back off what the house hands you -- never fold two of them into one call and never carry a size forward in your head.';

const TURN_IN_LAST = 'Turn in the last piece that leaves you with.';

// Addendum J rule 2: the derived-parameter phrases. The task states the recipe; the number it
// needs is only ever on the other end of a call.
const DERIVED_SOURCE_PHRASE = {
  d: 'shape left on that leftover piece',
  combined: 'shape on the stack you just built',
  sd: 'tone left over when you took the second sound out of the first',
  vseq: 'frame in the stitched clip',
  live: 'copy of yours still standing in that listing once the cleared-out ones are left out',
};

function describeDerivedPercent(step) {
  const phrase = DERIVED_SOURCE_PHRASE[step.sourceKey];
  if (phrase === undefined) throw new Error(`no plain-language phrase for derived source "${step.sourceKey}"`);
  const off = Math.abs(step.perUnit);
  return `start at ${step.base} and take ${off} off for every ${phrase}`;
}

function describeChainStep(step) {
  if (step.kind === 'lora') return `look up the house style called "${step.name}" and give what you have that look`;
  if (step.kind === 'save') return `save what you have as ${describeKind('image', step.format)}`;
  const saved = step.format !== undefined ? `, saved as ${describeKind('image', step.format)}` : '';
  if (step.kind === 'resize') return `resize what you have so it comes out ${step.width} by ${step.height} pixels${saved}`;
  const grows = step.kind === 'grow' || step.kind === 'derivedGrow';
  if (step.kind === 'derivedShrink' || step.kind === 'derivedGrow') {
    const verb = grows ? 'blow what you have up' : 'shrink what you have down';
    return `${verb} to a percentage of its own size you have to work out like this -- ${describeDerivedPercent(step)} -- keeping its shape the same${saved}`;
  }
  const verb = grows ? 'blow what you have up to' : 'shrink what you have down to';
  return `${verb} ${step.percent} percent of its own size, keeping its shape the same${saved}`;
}

function describeChain(chain) {
  if (!chain || chain.length === 0) return '';
  const body = chain.map((s, i) => `(${i + 1}) ${describeChainStep(s)}`).join('; ');
  const resizes = chain.some((s) => s.kind !== 'lora' && s.kind !== 'save');
  return ` Then, in this order: ${body}.${resizes ? ` ${ROUND_NOTE}` : ''}`;
}

function trapNote(narrative) {
  return narrative.liveTrap ? ` ${TRAP_NOTE}` : '';
}

function orderNote(narrative) {
  return narrative.ordering ? ` ${ORDER_NOTE}` : '';
}

// ---------------------------------------------------------------------------
// per-tier text
// ---------------------------------------------------------------------------

function saveTail(narrative) {
  if (narrative.saveFormat === undefined) return ' Turn in exactly that piece.';
  const flavor = describeKind(narrative.kind, narrative.saveFormat);
  return ` Then save it as ${flavor}. ${TURN_IN_LAST}`;
}

function text0(world, narrative) {
  return `Make ${describeCreate(world, narrative.kind, narrative.params)}.${saveTail(narrative)}`;
}

const IDEMPOTENCY_NOTE = "Use a fresh repeat-safe request the house won't double-book if you send it twice.";

function text1(world, narrative) {
  if (narrative.kind === 'audio') {
    return `Make ${describeCreate(world, 'audio', narrative.params)}. Then, in this order: (1) re-encode it as ${describeKind('audio', narrative.format)}; (2) re-cut what you have to ${narrative.sampleRate} samples a second. ${TURN_IN_LAST} ${IDEMPOTENCY_NOTE}`;
  }
  return `Make ${describeCreate(world, 'image', narrative.params)}.${describeChain(narrative.chain)} ${TURN_IN_LAST} ${IDEMPOTENCY_NOTE}${trapNote(narrative)}`;
}

function text2(world, narrative) {
  return `Make ${describeCreate(world, 'image', narrative.params, narrative.crossRef)}.${describeChain(narrative.chain)} ${TURN_IN_LAST}${trapNote(narrative)}`;
}

function text3(world, narrative) {
  return `Make ${describeCreate(world, 'image', narrative.paramsA)}. Then make a second one: ${describeCreate(world, 'image', narrative.paramsB)}. Work out everything the first one has that the second one does not -- that leftover piece is what you carry on with. (Ask for the first one back before you compare, and don't ask twice for the same thing you already have.)${describeChain(narrative.chain)} ${TURN_IN_LAST}${trapNote(narrative)}`;
}

// The stacking step is a bare number on purpose: what the house *does* with it (compound it down
// or subtract it off) is a house rule the reader has to go and find.
const STACK_NOTE = "The house's own compounding rule decides what that stacking step does to each layer.";

function describeStack(narrative) {
  return `stack all of those into one, oldest at the bottom, fading each layer against the one below it with a stacking step of ${narrative.combineOpts.opacityStep}`;
}

// The page size is deliberately smaller than the run of items to get through, so the listing
// really does come back in several goes and a one-shot read quietly misses most of the work.
function describeHaul(world, narrative) {
  return `Work through the pictures held in ${labelled(world.vocab.project, narrative.projectLabel)}, over in ${labelled(world.vocab.workspace, narrative.workspaceLabel)}, ${narrative.pageSize} at a time`;
}

function text4(world, narrative) {
  return `${describeHaul(world, narrative)}. Give the house style called "${narrative.applyLoraName}" to the first ${narrative.subsetSize} of them in the order the house lists them, then ${describeStack(narrative)}. ${STACK_NOTE}${describeChain(narrative.chain)} ${TURN_IN_LAST}${trapNote(narrative)}`;
}

// Addendum J rule 4, in plain language: lock it in, kick off the finishing run and wait for it to
// really say finished, put a name on it without trampling anyone else's edit, and expect the
// house to refuse anything asked out of order.
const STAGE_NOTE = 'Walk it all the way through the house stages in the house order -- lock it in, kick off the finishing run, and do not call it done until you check back and it actually says finished. If you reach for a stage out of turn the house will refuse you; take the refusal, put the missing stage in, and carry on.';
const TAG_NOTE = 'Once it is finished, write a word of your own onto it -- and do it in a way that will fail rather than overwrite if anyone touched it between your reading it and your writing.';
const SIGN_NOTE = 'Then sign and send the release notice the house requires before anything can go out the door.';

function text5(world, narrative) {
  return `Make ${describeCreate(world, 'audio', narrative.audioA)}. Then make a second sound ${describeTones(narrative.audioB)}. Work out every tone the first sound has that the second one does not -- that leftover sound is the one that matters later -- and re-encode it as ${describeKind('audio', narrative.audioFormat)} at ${narrative.sampleRate} samples a second. Then, inside a fresh ${world.vocab.project} of your own making, over in ${labelled(world.vocab.workspace, narrative.workspaceLabel)}, make ${describeCreate(world, 'image', narrative.params, narrative.crossRef)}. ${STAGE_NOTE} ${TAG_NOTE}${describeChain(narrative.chain)} ${TURN_IN_LAST}`;
}

function describeClip(params, index) {
  return `(${index}) one running ${params.durationMs} ms, ${params.width} by ${params.height} pixels, showing that picture from its very start for the whole of it, at full strength`;
}

function text6(world, narrative) {
  return `Inside a fresh ${world.vocab.project} of your own making, over in ${labelled(world.vocab.workspace, narrative.workspaceLabel)}, make ${describeCreate(world, 'image', narrative.params, narrative.crossRef)}. ${STAGE_NOTE} ${SIGN_NOTE} ${TAG_NOTE} Then build a pair of short moving takes over that same finished picture: ${describeClip(narrative.videoA, 1)}; ${describeClip(narrative.videoB, 2)}. Don't tell the house how fast to run them -- let it use its own usual speed. Stitch the two end to end, first one first, into a single moving piece.${describeChain(narrative.chain)} ${TURN_IN_LAST}`;
}

// Addendum J rule 2's most literal form, in plain language. The count is never stated, the
// listing comes back in pages, and the cleared-out copies are invisible unless you ask for them.
function describeClearOut(narrative) {
  const many = countOfThem(narrative.deleteCount);
  return `clear out the last ${many} of the copies you just made -- confirm they really are gone from the ordinary listing, and that they still turn up when you ask for the cleared-out ones as well -- and then count how many of your copies are still standing in the ordinary listing, remembering it comes back a page at a time`;
}

function text7(world, narrative) {
  return `${describeHaul(world, narrative)}. Give the house style called "${narrative.applyLoraName}" to the first ${narrative.subsetSize} of them in the order the house lists them. Pull that same listing as a spreadsheet instead of the usual reply, then ${describeStack(narrative)}. Then ${describeClearOut(narrative)}. ${STACK_NOTE}${describeChain(narrative.chain)}${orderNote(narrative)} ${TURN_IN_LAST}${trapNote(narrative)}`;
}

function text8(world, narrative) {
  return `${describeHaul(world, narrative)} -- there are more of them to get through this time. Give the house style called "${narrative.applyLoraName}" to the first ${narrative.subsetSize} of them in the order the house lists them. Pull that same listing as a spreadsheet instead of the usual reply, then ${describeStack(narrative)}. Then ${describeClearOut(narrative)}; don't take the written reference's word for how the house confirms a clean-up, check what actually comes back. ${STACK_NOTE}${describeChain(narrative.chain)}${orderNote(narrative)} ${TURN_IN_LAST}${trapNote(narrative)}`;
}

function text9(world, narrative) {
  return `${describeHaul(world, narrative)}. Give the house style called "${narrative.applyLoraName}" to the first ${narrative.subsetSize} of them in the order the house lists them, then ${describeStack(narrative)}. Pull that listing as a spreadsheet too, and ${describeClearOut(narrative)}. ${STACK_NOTE} Keep that stack to one side; you are going to need to know what is on it. Now make ${describeCreate(world, 'image', narrative.params, narrative.crossRef)}.${describeChain(narrative.chain)} ${ORDER_NOTE} ${TURN_IN_LAST}${trapNote(narrative)}`;
}

const TEXT_BUILDERS = [text0, text1, text2, text3, text4, text5, text6, text7, text8, text9];

// ---------------------------------------------------------------------------
// makeRung / difficulty
// ---------------------------------------------------------------------------

// makeRung(world, n) -> Rung. Deterministic: same (world, n) always yields the same Rung, byte
// for byte, since every draw comes from sub(world.seed, 'rung:'+n) inside grammar.js.
// `mutation` is Addendum J rule 3's announced change (or null); it is read off the World, never
// drawn here, so the API and the task text cannot disagree about it.
export function makeRung(world, n) {
  const { plan, submitKey, narrative, band, mutation } = composePlan(world, n);
  const env = runPlanLocally(world, plan);
  const expectedDescriptors = [env.get(submitKey)];
  const body = TEXT_BUILDERS[band.tier](world, narrative);
  const text = mutation ? `${body} ${MUTATION_NOTE}` : body;
  return { n, text, plan, expectedDescriptors, submitCount: expectedDescriptors.length, mutation };
}

// difficulty(rung) -> number, strictly increasing in rung.n across 0..99 for any world: the band
// tier dominates (more steps/params/lookups/quant per the grammar table as tier rises) and n
// itself breaks ties within a tier, so the curve never dips.
export function difficulty(rung) {
  const band = bandFor(rung.n);
  return band.tier * 1000 + rung.n;
}
