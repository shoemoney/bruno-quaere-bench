# House rules the ladder 0.5.0 answer key depends on

Ladder version **0.5.0** (`src/world.js` `VERSION`). Written by the ladder workstream for the
skill workstream and the docsolver workstream.

**The contract.** Nothing in any rung's answer key may turn on a rule that is not in this file.
Every rule below is stated in plain language, the way `skill.js` has to say it and the way an
agent has to be able to find it in the sloppy 5 MB document. If the key ever needs a rule that is
not here, that is a generator bug of exactly the kind Addendum I was written about — the
`docsolver` gate exists to catch it, and this file is what `docsolver` is allowed to read.

Rules 1–15 carried over from 0.4.0 and are unchanged in substance; 16–27 are new in 0.5.0.
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
   first and then gridded. A width can never come out below 1.

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
    write changes only labels; it never changes the thing's contents or its hash.

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

---

## What this file does NOT contain, on purpose

The per-rung numbers (sizes, colours, percentages, style names, page sizes, how many to work
through) are in the task text, never here. The traps (`fieldCase`, `deleteStatus`,
`optionalIsRequired`, `enumSpelling`, `wrongDefault`, `missingRequiredHeader`) are in the written
reference as lies and are not house rules — rule 27's promise is about announced changes, not
about traps, which are permanent and were always wrong.

---

## Appendix: every phrase the 0.5.0 task text can emit

The docsolver parses rung text, so this is the closed set of shapes it has to recognise. Anything
outside it is a generator bug (and `docsolver` should fail loudly on it rather than guess, as it
already does for an unknown create clause). Square brackets are placeholders.

**Making something**

- `Make a picture [W] by [H] [unit word or "pixels"], on a [#hex] ground, carrying these, bottom of the pile first: (1) ...`
- `Make a picture as wide and as tall as the piece you turned in at step [M], on a [#hex] ground, carrying these, ...`
- `... on the same ground colour as the piece you turned in at step [M], carrying these, ...`
- `Make a short sound running [D] ms end to end and carrying these tones in order: (1) ...`

**Shapes and tones**

- `a rectangle [W] across and [H] down, its top-left corner [X] from the left and [Y] from the top, painted [#hex] at [P] percent solid`
- `a circle of radius [R] centred [X] from the left and [Y] from the top, painted [#hex] at [P] percent solid`
- `a line running from ([X], [Y]) to ([X2], [Y2]), counting from the top-left corner, painted [#hex] at [P] percent solid`
- `[D] ms of [F] hertz starting [S] ms in, [P] percent loud, [sine|square|saw|triangle]-shaped`

**Ordered chain steps** (always introduced by `Then, in this order: (1) ...; (2) ...`)

- `look up the house style called "[name]" and give what you have that look`
- `save what you have as [a vector file | a bitmap file]`
- `resize what you have so it comes out [W] by [H] pixels[, saved as ...]`
- `shrink what you have down to [P] percent of its own size, keeping its shape the same[, saved as ...]`
- `blow what you have up to [P] percent of its own size, keeping its shape the same[, saved as ...]`
- `shrink what you have down to a percentage of its own size you have to work out like this -- start at [B] and take [P] off for every [X] -- keeping its shape the same[, saved as ...]`
- `blow what you have up to a percentage of its own size you have to work out like this -- start at [B] and take [P] off for every [X] -- keeping its shape the same[, saved as ...]`

**Fixed notes** (each appears verbatim or not at all)

- rounding: `The house rounds every size to its usual grid; do that after every resize, in the order you do them, not just once at the end.`
- stacking: `The house's own compounding rule decides what that stacking step does to each layer.`
- repeat-safety: `Use a fresh repeat-safe request the house won't double-book if you send it twice.`
- trap: `Take nothing here on the written reference's word: ...`
- ordering (rule 6): `Order is the whole game here: ...`
- announced change (rule 26): `Fair warning: the house has changed something about the way it answers, starting with this piece of work. ...`
- stages (rule 23): `Walk it all the way through the house stages in the house order -- ...`
- signing (rule 24): `Then sign and send the release notice the house requires before anything can go out the door.`
- conditional write (rule 25): `Once it is finished, write a word of your own onto it -- ...`
- turn-in: `Turn in the last piece that leaves you with.` or `Turn in exactly that piece.`

**Whole-rung shapes**

- library haul: `Work through the pictures held in the [project noun] the house calls "[label]", over in the [workspace noun] the house calls "[label]", [K] at a time.`
- clearing out: `clear out the last [one | N of them] of the copies you just made -- confirm they really are gone from the ordinary listing, and that they still turn up when you ask for the cleared-out ones as well -- and then count how many of your copies are still standing in the ordinary listing, remembering it comes back a page at a time`
- moving takes: `Then build a pair of short moving takes over that same finished picture: (1) one running [D] ms, [W] by [H] pixels, showing that picture from its very start for the whole of it, at full strength; (2) ... Don't tell the house how fast to run them -- let it use its own usual speed. Stitch the two end to end, first one first, into a single moving piece.`
- sound difference: `Work out every tone the first sound has that the second one does not -- that leftover sound is the one that matters later -- and re-encode it as [flavor] at [N] samples a second.`
- picture difference: `Work out everything the first one has that the second one does not -- that leftover piece is what you carry on with.`

**Never in the text**

An API field name, a route path, an opaque id, a derived percentage, a recalled value, the house
dpi, the house grid, the house rounding direction, the house default flavors, the house default
sample rate, the house default frame rate, the compounding rule, or the name of an announced
change. Every one of those is a rule above, or in the skill, or is the agent's own earlier work.
