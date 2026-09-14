# House rules the ladder answer key depends on

Ladder version **0.7.1** (`src/world.js` `VERSION`). Written by the ladder workstream for the
skill workstream and the docsolver workstream. Was `docs/RULES-0.5.md` through 0.5.1 and
`docs/RULES-0.6.md` through 0.6.0; renamed each time, never restarted, so every rule number below
is stable across every bump.

**The contract.** Nothing in any rung's answer key may turn on a rule that is not in this file.
Every rule below is stated in plain language, the way `skill.js` has to say it and the way an
agent has to be able to find it in the sloppy 5 MB document. If the key ever needs a rule that is
not here, that is a generator bug of exactly the kind Addendum I was written about — the
`docsolver` gate exists to catch it, and this file is what `docsolver` is allowed to read.

Rules 1–15 carried over from 0.4.0 and are unchanged in substance; 16–27 are new in 0.5.0; 28–29
are new in 0.6.0; 30–37 are new in 0.7.0 (Addendum Q); **38 is new in 0.7.1** (Addendum S). All of
them are appended rather than slotted in, so nothing renumbers.

**What changed most in 0.7.0 is not a rule but the appendix.** Through 0.6.0 the last section of
this file published the closed set of *sentences* the task text could emit, and a solver parsed
rung text with literal-string regexes written once at rung 0 and never again. From 0.7.0 the
appendix publishes the closed set of **clause kinds and what each one obliges**, and every clause
renders as one of **four** seeded phrasings of identical meaning. A reader pays nothing for that;
a regex pays everything. Nothing in a key turns on *which* phrasing a clause drew.

Sections marked **(skill)** must appear in `SKILL.md` (and therefore, verbatim, inside the sloppy
expansion). Sections marked **(task text)** are stated in the rung text itself and are listed here
only so the docsolver knows to parse them.

---

## Arithmetic and sizes

1. **(skill)** A measurement given in a physical unit is turned into pixels by multiplying by the
   house dots-per-inch. Inches multiply by the dpi directly; centimetres divide by 2.54 first;
   points divide by 72 first.

2. **(skill)** Before any rounding happens, the raw pixel figure is snapped to six decimal places.
   This is the house's answer to floating-point dust: `0.56 inches at 300 dpi` is 168, never
   168.00000000000003.

3. **(skill)** Every size the house stores — a canvas width, a canvas height, a resize target — is
   then rounded onto the house grid, using the house grid step and the house rounding direction
   (up, down, or to the nearest). A size that is already an exact multiple of the grid step is
   left exactly where it is, whichever direction the house rounds.

4. **(skill)** The grid rounding lands **after every single step**, in the order the steps are
   done, never once at the end. Two resizes in a row are two roundings.

5. **(skill)** A percentage resize is worked out as `size × percent ÷ 100`, snapped to six
   decimals (rule 2), then rounded onto the grid (rule 3). It is **not** rounded to a whole pixel
   first and then gridded. A width can never come out below one whole step of the house grid.

6. **(skill)** When a picture is resized, every shape on it moves and scales with the canvas:
   horizontal figures multiply by the width ratio, vertical figures by the height ratio, a radius
   by the average of the two, and each result is rounded to the nearest whole pixel.

## Defaults the house supplies when you do not

7. **(skill)** A picture saved without a named flavor gets the house default picture flavor. A
   sound without one gets the house default sound flavor. A moving clip without one gets the house
   clip flavor.

8. **(skill)** A sound created without a stated sample rate gets the house default sample rate.

9. **(skill)** A moving clip created without a stated frame rate gets the house default frame rate.
   Rung 60 and up depend on this: the frame count that sets those rungs' resize cannot be worked
   out without it.

## Stacking, differencing and styles

10. **(skill)** Stacking pictures into one keeps the first one's canvas and ground, and appends
    every later one's shapes on top in the order given. The stacking step fades each later layer
    against the one below it by the house's own compounding rule — either multiplying each layer's
    solidity by the step raised to that layer's position, or subtracting the step times that
    position — and the result is clamped between nothing and fully solid.

11. **(skill)** Taking one picture away from another leaves the shapes the first has that the
    second does not, on the first one's canvas, keeping the first one's ground. Two shapes are the
    same shape when every one of their figures matches; stacking order is not part of that.

12. **(skill)** A house style is looked up by its display name in the house style library, which
    is reachable only from the link the house hands back with a workspace — it is not in the
    written reference. Applying one shifts hue, scales, changes solidity or inverts, depending on
    the style.

13. **(skill)** A style that scales re-rounds every shape figure onto the house grid as it goes,
    the same grid rule as rule 3.

## Sounds and moving clips

14. **(skill)** A sound's length is whatever it was created with. Re-encoding a sound to another
    flavor, or re-cutting it to another sample rate, changes neither its tones nor its length.

15. **(skill)** Taking one sound away from another leaves the tones the first has that the second
    does not, keeping the first one's length and sample rate. Two tones are the same tone when
    pitch, start, length, loudness and shape all match.

16. **(skill, new in 0.5.0)** Stitching moving clips end to end runs them one after another: the
    second clip's contents start after the whole of the first clip's length, and the stitched
    clip's length is the sum of the lengths. The stitched clip keeps the first one's size and
    frame rate.

17. **(skill, new in 0.5.0)** A clip's frame count is
    `length in seconds times its frame rate`, rounded to the nearest whole frame. With nobody
    having said otherwise, that is the house default frame rate (rule 9).

## Derived numbers — a number the task does not state

18. **(task text, new in 0.5.0)** From rung 30 up, at least one number a rung needs is not in the
    task text. The text states a recipe instead: *start at B and take P off for every X*. The
    answer is `B − P × (how many X there are)`, and `how many X there are` can only be learned by
    asking the house.

19. **(task text, new in 0.5.0)** The five things `X` can be, and what counts each one:
    - *every shape left on that leftover piece* — the shapes on the result of taking the second
      picture away from the first (rule 11).
    - *every shape on the stack you just built* — the shapes on the result of the stacking
      (rule 10).
    - *every tone left over when you took the second sound out of the first* — the tones on the
      result of taking the second sound away from the first (rule 15).
    - *every frame in the stitched clip* — the frame count of the stitched clip (rules 16 and 17).
    - *every copy of yours still standing in that listing once the cleared-out ones are left out* —
      how many of the copies this rung made are still visible in the ordinary listing after this
      rung's own clear-out. The listing comes back a page at a time, and cleared-out entries are
      invisible unless they are explicitly asked for.

20. **(skill, new in 0.5.0)** The derived percentage goes through exactly the same arithmetic as a
    stated one: rule 5 then rule 3. It is never rounded some other way for being derived.

## Cross-rung references — a value the task does not repeat

21. **(task text, new in 0.5.0)** From rung 20 up, a rung may name a property of *the piece you
    turned in at step M* and never state the value. There are exactly two such properties:
    - *as wide and as tall as the piece you turned in at step M* — that piece's canvas width and
      height, in pixels, exactly as the house stored them.
    - *the same ground colour as the piece you turned in at step M* — that piece's ground colour.

22. **(task text, new in 0.5.0)** A recalled size is already on the house grid, so rounding it
    again (rule 3) changes nothing.

## The house stages, signing, and conditional writes

23. **(skill)** A project goes through its stages in one order and the house refuses any stage
    asked for out of turn, with a refusal that says so. The finishing run is asynchronous: it is
    kicked off, and it is only done when a check-back says it is done.

24. **(skill)** A release notice must be signed. The signature is a keyed hash over the house's
    canonical string — the timestamp, then the method, then the path — and both the timestamp and
    the signature travel in the headers the skill names.

25. **(skill)** A conditional write sends the tag the house last handed out for that thing. If the
    thing has changed since, the house refuses the write rather than overwriting. A conditional
    write changes only labels; it never changes the thing's contents or its hash. Which word goes
    on is stated in the task text, never chosen by the writer (rule 29).

## Announced changes

26. **(task text, new in 0.5.0)** From rung 40 up, a rung may say that the house
    `has changed something about the way it answers`, starting with that piece of work, without
    saying what.
    The change is always one of: a status code that is no longer the usual one; a field that is no
    longer in a reply; a field that comes back under a different name; a field that comes back as
    a different type. It is never a refusal and never a listing that will not advance — every call
    the rung needs still works.

27. **(new in 0.5.0)** An announced change never alters what the finished artifact should be. It
    changes only what the replies look like on the way there. An answer that was right before the
    change is still right after it.

## What a stitched clip is for — new in 0.6.0

28. **(skill, new in 0.6.0)** A stitched moving piece is only there to be counted; the chain
    carries on with the finished picture. Stitching two takes together produces a measuring stick,
    not a new thing to work on: the ordered chain that follows a stitch — the style lookups, the
    resizes, the save — still applies to the **picture** the takes were made over, never to the
    stitched clip. The only thing the stitch contributes to the answer is its frame count
    (rules 16, 17 and 19). Every rung that stitches says so in its own words:
    *That stitched piece is only there to be counted; carry on with the finished picture.*

29. **(task text, new in 0.6.0)** The conditional write of rule 25 puts a **stated** word on the
    thing. The task text names it — *write the word "X" onto it* — and it is written onto the
    **last** piece, after every ordered step is done, because that is the piece that gets turned
    in and a label does not travel from one piece to the next one made out of it. From rung 50 up
    it is graded: a piece whose hash is right but which never got the word written onto it, or
    whose project never came all the way through the house stages to released, does not pass.
    Everything the task text demands is graded; nothing is demanded for decoration.
    **Amended in 0.7.0:** a word goes onto a piece only where a turn-in step asks for it, and only
    onto the piece that is turned in. A piece of work that asks for a word to be written somewhere
    else — onto a stack, onto a leftover, onto an intermediate — is asking for something this rule
    forbids, and rule 36 applies.

## Amendments — a rule that changes partway up the ladder — new in 0.7.0

30. **(skill, new in 0.7.0)** A cleared-out piece has left the house's working set. Nothing is
    applied to it, nothing is made from it, and it never comes back into a chain: no style, no
    re-save in another flavour, no stacking it back in. It stays visible only to a request that
    explicitly asks for the cleared-out ones, and only so that the clear-out can be confirmed
    (rule 19). Where a task asks for work on a cleared-out piece, rule 36 applies and the work is
    not done.

31. **(skill, new in 0.7.0)** A listing comes back a page at a time and **a short page is not the
    end of the listing**. The house meters some listings more tightly than the rest of itself, and
    under that meter it may hand back fewer rows than were asked for rather than an error. The
    listing ends when, and only when, a reply carries no next cursor. A client that stops at the
    first short page undercounts, and any number derived from that count (rule 19) is then wrong.
    When the house does answer a listing with a refusal for going too fast, it says how long to
    wait in a header, not in the body, and waiting that long and carrying on is the correct
    reading — not starting the walk again.

32. **(skill, new in 0.7.0)** A count taken off a listing is taken over **this piece of work's own
    copies**, never over everything the listing holds. The house provides a way to ask a listing
    for only the rows a given piece of work created; using it is the intended reading, and walking
    the whole reel and filtering by hand is merely a slower way to the same number. Either way the
    answer is about this rung's copies alone, so it does not depend on what earlier rungs left
    behind.

33. **(skill, new in 0.7.0)** The house **amends its own rules partway up the ladder**, at rungs it
    announces in the task text, and publishes the amended copy — dated — in the same place the
    house rules were found in the first place. An amendment names one numbered rule and changes it
    from one stated value to another: the grid step, the rounding direction, the compounding rule,
    the house default frame rate, or the order of the fields in the signing string. From the
    announced piece of work onward, **the amended rule is the rule**, and everything worked out
    under the old wording is out of date. Amendments accumulate: a rule amended at an earlier rung
    stays amended unless a later amendment moves it again. An amendment never changes what an
    earlier rung's answer *was*; it changes what the current rung's answer *is*.

34. **(task text, new in 0.7.0)** A **regression** piece of work names a piece turned in earlier,
    states that a rule governing its kind has been amended since (rule 33), and asks for that piece
    **as it should be now**: fetch it back, compare it against what the amended rules would
    produce, rebuild it under the current rules, and turn the rebuilt one in under the same
    project. The earlier piece is not edited and not replaced; the rebuild is a new piece.

35. **(skill, new in 0.7.0)** A release notice's signature is computed over the house's canonical
    string, and from 0.7.0 that string **binds a digest of the thing being released** as well as
    the timestamp, the method and the path. The digest is the house's own hash of the artifact
    bytes, taken from the house rather than computed from a local copy, and it travels in its own
    header beside the timestamp and the signature. A signature computed without it, or computed
    over a digest of something other than the piece being released, is refused. Rule 33 may amend
    the order of the fields in that string.

36. **(skill, new in 0.7.0)** **Where the task asks for something a house rule forbids, the house
    rule wins and the act must not be performed.** The task text is written by people who do not
    always know the rules; the numbered rules are the house. An ask that a numbered rule forbids is
    to be left undone — not worked around, not done in a different order, not done and then undone
    — and the rest of the task is carried out as written. Doing it is a failure even when the piece
    that gets turned in is byte-for-byte correct, because what is graded is also the **absence** of
    the thing the rule forbids.

37. **(skill, new in 0.7.0)** A piece of work may state a **byte budget**: at or under so many
    bytes, using the largest sample rate (or the richest flavor) that still fits. The house is the
    only authority on how many bytes a piece actually takes, so the budget is met by asking the
    house for the piece and measuring what comes back, largest candidate first, taking the first
    one that fits. Ties never happen: the candidates are the house's own stated sample rates, in
    order.

## Stage recovery is stated outright, not inferred — new in 0.7.1

38. **(skill, new in 0.7.1)** **A rung that tests stage recovery says so outright.** Rule 23 says
    the house refuses a stage asked for out of turn; a rung whose answer key requires that refusal
    to have happened says as much in the task text itself, as a plain instruction to reach for a
    later stage on purpose before you are ready for it, take the refusal, and then walk every
    stage in the house's order from wherever that leaves you. **If a rung's task text does not ask
    for that early reach, none is required of the agent and none is graded** — a competent agent
    that takes every stage in order the first time, exactly as asked, cannot be marked down for
    never having been refused. What decides whether the audit trail includes the refusal is the
    instruction in the text, never an assumption baked into the key from something the text itself
    never says.

---

## What this file does NOT contain, on purpose

The per-rung numbers (sizes, colours, percentages, style names, page sizes, how many to work
through) are in the task text, never here. The traps (`fieldCase`, `deleteStatus`,
`optionalIsRequired`, `enumSpelling`, `wrongDefault`, `missingRequiredHeader`) are in the written
reference as lies and are not house rules — rule 27's promise is about announced changes, not
about traps, which are permanent and were always wrong.

---

## Appendix: every clause KIND the task text can emit

Through 0.6.0 this appendix published the closed set of sentences. It no longer does, and that is
the single highest-leverage change in Addendum Q. **Every clause below renders as one of four
seeded phrasings of identical meaning**, drawn per (seed, rung, clause kind). What is closed, and
what the docsolver is entitled to rely on, is the set of KINDS and the OBLIGATION each one carries.
A solver that recognises obligations reads all four; a solver that memorised sentences reads one in
four. `src/ladder/rung.js` holds the phrasing tables and `test/phrasing.test.js` pins the two
invariants: every phrasing of a kind states exactly the same leaves, and the plan, the descriptors
and the hashes do not depend on which phrasing was drawn.

Anything outside this set of kinds is a generator bug, and `docsolver` should fail loudly on it
rather than guess, as it already does for an unknown create clause.

### Making something

| kind | obligation |
|---|---|
| `createImage` | make a picture of the stated size, on the stated ground, carrying the listed shapes, bottom of the pile first |
| `createAudio` | make a sound of the stated whole length carrying the listed tones in order |
| `dimsPixels` | the two stated numbers are a width and a height in pixels |
| `dimsUnit` | the two stated numbers are a width and a height in the named house unit (rule 1) |
| `dimsRecall` | the width and height are those of the piece turned in at the named earlier step (rule 21); no size is stated |
| `groundColor` / `groundClear` / `groundRecall` | the ground is the stated colour / see-through / the ground colour of the named earlier piece |
| `shapeList` | the ground, then the shapes that sit on it, listed bottom of the pile first (rule 10's ordering) |
| `shapeRect` / `shapeCircle` / `shapeLine` | one shape, with every figure it needs stated |
| `paint` | the shape's colour and its solidity as a percentage |
| `toneList` / `note` | the sound's whole length, and one tone with pitch, start, length, loudness and shape |

### The ordered chain

| kind | obligation |
|---|---|
| `chainIntro` | what follows is an ordered list; each step is done to what the step before it produced |
| `stepLora` | look the named house style up by its display name and apply it (rules 12, 13) |
| `stepSave` | re-save what you have in the named flavor; the size is untouched |
| `stepResize` | resize to the stated absolute pixel target (rules 3, 4, 6) |
| `stepShrink` / `stepGrow` | resize to the stated percentage of the current size (rule 5) |
| `stepDerivedShrink` / `stepDerivedGrow` | the same, with the percentage not stated but derived by the recipe (rules 18, 19, 20) |
| `recipe` | *start at B and take P off for every X*: the percentage is `B − P × (how many X)` |
| `round` | the grid rounding lands after every step, in order, never once at the end (rules 3, 4) |
| `order` | the steps do not commute; do them singly and read each new size off the house (rule 4) |

### Whole-rung shapes

| kind | obligation |
|---|---|
| `haul` | work through the pictures in the named project, in the named workspace, the stated number at a time |
| `applyStyleTo` | apply the named house style to the first N in the house's own listing order |
| `stackStep` | stack all of them into one, oldest at the bottom, with the stated stacking step (rule 10) |
| `stack` | what the stacking step does to each layer is the house's compounding rule, not stated here |
| `csvPull` | ask for the same listing as a spreadsheet rather than the usual reply |
| `clearOut` | clear the last N of this rung's copies out, confirm both directions, then count what stands (rule 19) |
| `shortPage` | that listing is metered tightly; a short page is not the end, only a missing next cursor is (rule 31) |
| `stage` | walk every house stage in house order, wait for the finishing run's check-back (rule 23); when the rung tests stage recovery it also instructs a deliberate early reach for the render stage before composing, taking the refusal, and carrying on from there (rule 38) -- graded only when stated |
| `sign` | sign and send the release notice before anything leaves (rules 24, 35) |
| `stitch` | a stitched moving piece is only there to be counted; carry on with the finished picture (rule 28) |
| `tag` | write the STATED word onto the LAST piece, conditionally, so it fails rather than overwrites (rules 25, 29) |
| `turnInLast` / `turnInExact` | which piece is submitted |
| `idem` | send it in a way the house will not double-book |
| `trap` | the written reference is wrong about at least one call this needs; believe the live house |
| `mutation` | something about the shape of the house's replies changed as of this rung (rules 26, 27) |
| `amendment` | a numbered rule was amended as of this rung; re-read the house rules before working anything out (rule 33) |
| `piece` / `labelled` | a cross-rung reference by step number (rule 21); a workspace/project by its display name, never an id |

### Clauses that ask for something a rule forbids (rule 36)

These read as ordinary, reasonable instructions. They are not. Each one is forbidden by a numbered
rule, the act must not be performed, and what is graded is the ABSENCE of what it asked for.

| kind | asks for | forbidden by |
|---|---|---|
| `refusalWorkOnCleared` | give a house style to the copies you just cleared out | rule 30 |
| `refusalReflavourCleared` | re-save the cleared-out copies in another flavour | rule 30 |
| `refusalLabelStack` | write a stated word onto the stack, on a rung whose turn-in asks for no word | rules 29, 36 |

### Rules stated here but not yet emitted by any 0.7.0 rung

Rule 34 (regression pieces) and rule 37 (byte budgets) are written down because they are the
contract the generator will emit against, and because a rule that arrives with the rungs that use
it arrives too late for the skill and the docsolver. **No rung in 0.7.0 emits either clause yet**;
when they land, the kinds `regressionRebuild` and `byteBudget` join the tables above. Nothing in
any 0.7.0 answer key turns on rule 34 or rule 37, so a solver that ignores both is complete for
0.7.0 and ready for the rung that is not.

### Never in the text

An API field name, a route path, an opaque id, a derived percentage, a recalled value, the house
dpi, the house grid, the house rounding direction, the house default flavors, the house default
sample rate, the house default frame rate, the compounding rule, the name of an announced change,
or the name of the rule an amendment moved. Every one of those is a rule above, or in the skill, or
is the agent's own earlier work.
