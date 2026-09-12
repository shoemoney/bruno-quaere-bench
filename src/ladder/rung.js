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

function describeDims(world, params) {
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
// the expected hash. Only the house's own rules (unit-to-pixel conversion, the rounding grid, the
// default file flavor and sample rate, what a stacking step compounds to) stay unsaid -- those
// live in the skill, and looking them up is the point.
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

function describeShapes(params) {
  const ground = params.background.color !== undefined ? `a ${params.background.color} ground` : 'a see-through ground';
  const list = params.shapes.map((s, i) => `(${i + 1}) ${describeShape(s)}`).join('; ');
  return `on ${ground}, carrying these, bottom of the pile first: ${list}`;
}

function describeNote(note) {
  return `${note.durMs} ms of ${note.freq} hertz starting ${note.startMs} ms in, ${percentOf(note.amp)} loud, ${note.wave}-shaped`;
}

function describeTones(params) {
  const list = params.notes.map((n, i) => `(${i + 1}) ${describeNote(n)}`).join('; ');
  return `running ${params.durationMs} ms end to end and carrying these tones in order: ${list}`;
}

function describeCreate(world, kind, params) {
  if (kind === 'image') return `a picture ${describeDims(world, params)}, ${describeShapes(params)}`;
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

const TURN_IN_LAST = 'Turn in the last piece that leaves you with.';

function describeChainStep(step) {
  if (step.kind === 'lora') return `look up the house style called "${step.name}" and give what you have that look`;
  if (step.kind === 'save') return `save what you have as ${describeKind('image', step.format)}`;
  const saved = step.format !== undefined ? `, saved as ${describeKind('image', step.format)}` : '';
  if (step.kind === 'resize') return `resize what you have so it comes out ${step.width} by ${step.height} pixels${saved}`;
  const verb = step.kind === 'grow' ? 'blow what you have up to' : 'shrink what you have down to';
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

// ---------------------------------------------------------------------------
// per-tier text
// ---------------------------------------------------------------------------

function text0(world, narrative) {
  return `Make ${describeCreate(world, narrative.kind, narrative.params)}. Turn in exactly that piece.`;
}

const IDEMPOTENCY_NOTE = "Use a fresh repeat-safe request the house won't double-book if you send it twice.";

function text1(world, narrative) {
  if (narrative.kind === 'audio') {
    return `Make ${describeCreate(world, 'audio', narrative.params)}. Then, in this order: (1) re-encode it as ${describeKind('audio', narrative.format)}; (2) re-cut what you have to ${narrative.sampleRate} samples a second. ${TURN_IN_LAST} ${IDEMPOTENCY_NOTE}`;
  }
  return `Make ${describeCreate(world, 'image', narrative.params)}.${describeChain(narrative.chain)} ${TURN_IN_LAST} ${IDEMPOTENCY_NOTE}${trapNote(narrative)}`;
}

function text2(world, narrative) {
  return `Make ${describeCreate(world, 'image', narrative.params)}.${describeChain(narrative.chain)} ${TURN_IN_LAST}${trapNote(narrative)}`;
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

function text5(world, narrative) {
  return `Inside a fresh ${world.vocab.project} of your own making, over in ${labelled(world.vocab.workspace, narrative.workspaceLabel)}, make ${describeCreate(world, 'image', narrative.params)}. Walk it all the way through the house's usual stages -- lock it in, kick off the finishing run, and don't call it done until you check back and it actually says finished.${describeChain(narrative.chain)} ${TURN_IN_LAST}`;
}

function text6(world, narrative) {
  return `Inside a fresh ${world.vocab.project} of your own making, over in ${labelled(world.vocab.workspace, narrative.workspaceLabel)}, make ${describeCreate(world, 'image', narrative.params)}. Walk it through the house's usual stages until the finishing run is done, then sign and send the release notice the house requires before anything can go out the door.${describeChain(narrative.chain)} ${TURN_IN_LAST}`;
}

function text7(world, narrative) {
  return `${describeHaul(world, narrative)}. Give the house style called "${narrative.applyLoraName}" to the first ${narrative.subsetSize} of them in the order the house lists them. Before you stack anything: pull that same listing as a spreadsheet instead of the usual reply, then clear out the last of the ${narrative.subsetSize} you just worked on -- confirm it really is gone from the ordinary listing, and that it still turns up when you ask for the cleared-out ones as well. Then ${describeStack(narrative)}. ${STACK_NOTE}${describeChain(narrative.chain)} ${TURN_IN_LAST}${trapNote(narrative)}`;
}

function text8(world, narrative) {
  return `${describeHaul(world, narrative)} -- there are more of them to get through this time. Give the house style called "${narrative.applyLoraName}" to the first ${narrative.subsetSize} of them in the order the house lists them. Before you stack anything: pull that same listing as a spreadsheet instead of the usual reply, then clear out the last of the ${narrative.subsetSize} you just worked on -- don't take the written reference's word for how the house confirms a clean-up, check what actually comes back, and make sure it is gone from the ordinary listing but still turns up when you ask for the cleared-out ones. Then ${describeStack(narrative)}. ${STACK_NOTE}${describeChain(narrative.chain)} ${TURN_IN_LAST}${trapNote(narrative)}`;
}

function text9(world, narrative) {
  return `Make ${describeCreate(world, 'image', narrative.params)}.${describeChain(narrative.chain)} ${TURN_IN_LAST}${trapNote(narrative)}`;
}

const TEXT_BUILDERS = [text0, text1, text2, text3, text4, text5, text6, text7, text8, text9];

// ---------------------------------------------------------------------------
// makeRung / difficulty
// ---------------------------------------------------------------------------

// makeRung(world, n) -> Rung. Deterministic: same (world, n) always yields the same Rung, byte
// for byte, since every draw comes from sub(world.seed, 'rung:'+n) inside grammar.js.
export function makeRung(world, n) {
  const { plan, submitKey, narrative, band } = composePlan(world, n);
  const env = runPlanLocally(world, plan);
  const expectedDescriptors = [env.get(submitKey)];
  const text = TEXT_BUILDERS[band.tier](world, narrative);
  return { n, text, plan, expectedDescriptors, submitCount: expectedDescriptors.length };
}

// difficulty(rung) -> number, strictly increasing in rung.n across 0..99 for any world: the band
// tier dominates (more steps/params/lookups/quant per the grammar table as tier rises) and n
// itself breaks ties within a tier, so the curve never dips.
export function difficulty(rung) {
  const band = bandFor(rung.n);
  return band.tier * 1000 + rung.n;
}
