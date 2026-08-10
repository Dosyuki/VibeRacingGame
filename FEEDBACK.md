# What humans found by playing

Findings that came from a person operating the game, kept separately from
anything a harness or a critic produced.

**The separation is the point.** Automated visual critique is structurally blind
to everything a still frame cannot show, and a harness only answers the question
it was built to ask. This file is the record of what got through both. It is
also the honest measure of how much of the game has actually been *played*,
which is a different number from how much of it has been measured.

## Rules for this file

- One entry per finding, and only if a human found it by operating the game.
  A harness result is not feedback, however useful — it belongs in that
  harness's output and in `ART_DIRECTION.md` §10c.
- Record what the person did and saw, before recording the cause. The
  description is the evidence; the diagnosis is a later claim about it.
- **Every entry must say why the existing gates missed it.** A finding whose
  entry ends at "fixed in `foo.ts`" has taught the project nothing — the
  transferable part is the shape of the blind spot.
- Criticism that turns out to be right gets written down as right, in the words
  it arrived in. A verdict table that never says "true" is a press release.

---

## 1. The first frame was ninety degrees wrong, and seven harnesses said green

**Round 6 → 7. Found by:** pressing START and looking at the screen.

> A player pressing START got a view across the road at a canyon wall.

Not a subtle one. The camera rig was working correctly the entire time; nothing
was reading its output. `main.ts` built its own `PerspectiveCamera` for the
placeholder dolly and never stopped, so `renderer.render()` and the harness
getter both pointed at that module-local object while `cameraRig` maintained a
second camera that was never rendered, never resized and never read. At the grid
the kart faces +X and the abandoned dolly still looked down −Z — exactly the
ninety degrees on screen.

### Why every gate missed it

| gate | why it was green |
|---|---|
| all seven harnesses | each begins by calling `seek()`, which teleports to a clean mid-circuit position |
| every review shot in project history | `vantage()` writes the *same* module-local camera — the one that was being rendered |
| the seam check, on the deliberately broken build | scored a clean PASS: a camera that never rotates has an angular rate of exactly zero |

**The transferable rule, and it is not one Kart Royale ever learned:**

> **A harness that arranges its own convenient starting state cannot find a
> starting-state bug.**

Every instrument in the project shared one setup step, so every instrument
shared one blind spot, and the count of them — seven — provided false comfort
rather than coverage. Seven agreeing instruments that call the same `seek()`
first are one instrument.

**Acted on.** `tools/grid-start.mjs` is the standing answer: it loads the page
and presses START, and it may not call `seek()` or `resetRace()` anywhere,
**including in its own self-test**. That prohibition is the whole value of the
harness and it is the first thing a tidy-up will try to remove. It would have
caught this at 91.8° off tangent against a 35° gate.

Its author tightened two near-misses while building it — a 3.0 m side-offset
gate that would have passed a kart 2.7 m off centreline, and the zero-angular-
rate seam check above. Both are instances of the same thing: an instrument that
has never been watched failing is not evidence.

**Two more bugs fell out of building it**, neither visible in any frame:

- `IRace` was stepped twice per tick — explicitly, and again through its own
  `fixedUpdate`. The three-second countdown finished in 1.55 s and **every lap
  time recorded in the project up to that point was against a clock running at
  double rate.** `camera.ts` guards this exact hazard with a `lastFollowTick`
  check; `race.ts` had nothing.
- A ternary in `resetRace` whose two branches were identical.

**Correction on the record:** the previous round's report claimed the reference
AI did not drive. It does — all seven AI karts accelerate from rest to 24 m/s.
The stationary kart was the player, at zero speed because nothing was pressing a
key, which is correct behaviour. A report that misreads correct behaviour as a
defect costs a round in the other direction.

---

## Standing gaps — what nobody has done yet

These are not findings. They are the honest shape of what this file does *not*
contain, and each one is a place a finding is waiting.

- **No human has driven a full race.** The first frame has been looked at. The
  three laps after it have been measured by `autoplay.mjs` and not played.
- **One machine, one browser.** Nothing has been operated on a second GPU, and
  this machine has two — a Radeon 780M and an RTX 4050 — which is a hazard the
  timing harnesses already handle and the *play* experience does not.
- **No touch device, at all.** `src/ui/` has no touch controls yet, so there is
  nothing to try. Kart Royale shipped unusable mobile controls through three
  full rounds of six reviewers; the reason to write this line now is that the
  gap is currently invisible rather than currently fine.
- **Nobody outside the project has played it.** The build is public at
  `https://dosyuki.github.io/VibeRacingGame/`. Kart Royale's single most useful
  piece of design feedback and its sharpest criticism both came from strangers,
  and its first drift build banked nothing on 83% of attempts — spotted by
  somebody playing it, before any automated reviewer.

## What a human should try next

Derived from gates that are currently red or absent, so a person knows where to
point. Harness output, not feedback — listed here only to aim the playing.

1. **Turn one.** `grid-start.mjs` reports karts interpenetrating to 0.23 m
   against a 1.93 m footprint, and one ending 18.1 m off a 15.0 m half-width
   road. Play it and describe what that feels like from the driver's seat; the
   numbers say "pile-up" but not whether it is unfair, funny, or unplayable.
2. **The camera through a full lap.** It violates its behind/tangent gates
   during *part* of a run rather than all of it, which is the profile of
   something that looks fine in every still and is unpleasant in motion.
3. **Drift.** §10c 1 and 2 are gated by `autoplay.mjs` and graded on lap time
   and ladder rate. Neither number can tell you whether the payout *feels*
   earned, which is the axis Kart Royale's players cared about most.
