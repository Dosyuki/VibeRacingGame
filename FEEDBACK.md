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

## 2. The kart was not sliding. It was airborne.

**Round 7 → 8. Found by:** driving for a while and watching the kart go straight
on while the road bent away.

> While driving, after a certain amount of time, the kart slides — the whole
> body slides. Maybe because it's trying to move straight while the road curves.

The reporter's guess was right about the effect and wrong about the cause, in a
way worth recording: there was indeed almost no lateral force, so the kart did
carry straight on while the road turned. But nothing was wrong with the tyre
model, the steering, the road frame or the camera. **The kart was hovering.**

`kart.ts` subtracts an analytic road-roughness profile from each suspension ray
length, and computed the damper's `compressionSpeed` as a backward difference of
that same ray length. The bump is a function of *distance travelled*, so
differencing it yields a damper velocity of `A·k·v` — proportional to **speed**.
`Math.max(0, …)` on the spring force then rectified it: the negative half of
every 1.10 m cycle was clipped and the positive half was not, so the mean
vertical force exceeded the kart's weight and the body climbed to the droop stop
and stayed there.

Parity with the 637.7 N static wheel load arrives at 11.8 m/s on asphalt and at
**5.9 m/s on the dusty asphalt of the grid straight**. Over a full lap, 90.7% of
ticks had zero static spring load and 8.4% had all four wheels off the ground.
Achieved lateral acceleration under a held steer was 2.78 m/s² where the same
tyre model delivers 7.91 with the wheels down — same command, same speed, 35% of
the grip.

The single most convincing measurement was not a slip angle. A **zero-steer**
hold on the grid straight left the wheels reading `SandDrift` for 589 of 960
wheel-ticks and `Gravel` for 172: with nothing whatsoever commanded, the kart
slid off the road. That is the human's report, in the contract's own vocabulary.

**Why it looked like a time-based bug and was not.** It is a function of speed,
not elapsed time. "After a while" was how long the kart took to accelerate past
5.9 m/s. Every reproduction that started from a fresh `seek` hovered within 90
ticks at 16 m/s and never hovered at 2 m/s however long it ran.

**Why the gates missed it.** Every one of them for a different reason, which is
what makes it worth writing down:

- `smoke.mjs`, `energy-check.mjs`, `fps-bench.mjs` grade pixels and frame cost.
  **A hovering kart renders a flawless frame.**
- `steer-test.mjs` probes 36 ticks — 0.30 s — at one speed, and asks only which
  **sign** the kart moves in. A kart with 35% of its grip still moves the right
  way. Whether it hovers at all depends entirely on `CFG.probeSpeed`.
- `autoplay.mjs` gates on lap times, drift ratios, respawns and stalls. A whole
  field at 35% grip satisfies every one of those: everybody finishes, and
  because there is no baseline for what a lap time *should* be, the field
  produces a **self-consistent set of slow lap times that no threshold rejects.**
- Nothing asserted the one invariant that catches it in a line: on flat, level
  road, at every speed the game supports, all four wheels stay in contact and
  mean compression stays near static. `WheelState.grounded` and
  `WheelState.compression` were already on the contract the whole time.

**Acted on.** `tools/slip-check.mjs` — 40 s of simulated driving, sampled every
tick, binned by curvature so that slip in a corner and slip on a straight are
never averaged together. Two properties of it are the point:

- Its straight-line slip gate is **derived from the run itself** — degrees of
  body slip per m/s² measured in that same kart's own corners — rather than from
  a number somebody chose.
- Its `--broken` world is a real bicycle model with linear tyres, so slip is a
  physical output rather than a value the self-test hands itself. Twelve
  sabotages fire. One of them, `soft-tyres`, is a **decoy that must not fire**:
  6° of legitimate cornering slip, and the gate correctly stays quiet.

The sabotage that mattered most was `hovering`. With the tyre model untouched
and the kart lifted above 15 m/s, `wheel-contact` reported 0.00/4 grounded while
`slip-straight`, `slip-corner` and `slip-agreement` **all stayed green.** A slip
gate does not subsume a contact gate, and without that sabotage nobody would
have known.

**Recorded against ourselves, twice:**

- `wheel-contact` was added *after* the cause was known, so it is not an
  independent discovery and must not be cited as one. It earns its place by
  measuring a separately derived invariant and by moving no slip threshold.
- The harness reaches 25.1 m/s. The hover is worst at 31. **`wheel-contact`
  being green does not yet cover the bug it was written for**, and the harness
  prints that caveat itself rather than passing silently.

Two detector defects were caught while building it, both the same shape as the
`smoke.mjs` self-test that never touched the drawing buffer: the `onTrack`
contradiction check sat inside a filter that the sabotage emptied — a detector
switched off by the very thing it detects — and `command-path` was originally
*passive*, so a parked kart, which never asks for much steer, passed it over
nothing at all.

---

## 3. The field drove off before the lights went out, and stopping the input did not stop it

**Round 7 → 8. Found by:** pressing START and watching the karts leave during the
countdown.

> When you press Start, the countdown isn't finished yet and they can already
> move.

Measured, before the fix: the seven AI karts covered **17.788 – 17.976 m**
between START and GO, peaking at **11.78 – 11.91 m/s**. 829 violations of 960
assertions.

**The obvious half.** `main.ts`'s `driverFrame` never consulted `race.phase`, and
`fixedUpdate` passed its result straight into `IKart.step`. Nothing gated input
on the race at all: across the whole of `src/`, `race.phase` was read by exactly
two places, `ui/hud.ts` and telemetry. It was missing rather than broken —
`kart.ts` has no phase awareness and `ai.ts` never reads `IRace`, so there was no
failing hold to repair.

**The half that would have been shipped as a fix.** Gating the input is not
sufficient, and a build with only that change still creeps. The reference AI
drives from page load, so the field carries **momentum** across `startRace()`:
with the gate alone the karts still coasted 2.605 m and peaked at 1.07 m/s before
GO. Worse, *how much* depends on how long the machine took to boot the page —
wall-clock leaking into the simulation through the one door the fixed-timestep
rule does not cover. `race.ts`'s `start()` set phase and clock and nothing else;
it now establishes the grid. `hud.ts` restarts via `reset()` + `start()` and so
began on a grid already, which is exactly why only the *first* race of a session
showed it and why it would have survived a casual retest.

Both halves are needed. Removing either brings the creep back.

**Why the gates missed it.** `grid-start.mjs` — the one harness that presses
START rather than calling `seek()`, written last round precisely to catch
starting-state bugs — was *watching the field launch and grading it*, and had
anchored two of its own reference measurements to `startRace()`. Its comment
stated plainly that `launchRef` **included** the countdown driving. The illegal
behaviour had been read, described in a comment, and adopted as the baseline.

The moment the gate landed, `launch-field` and `stuck-motion` went red **on a
correct build**. Re-anchoring them to GO turned them green with their reference
*values* unchanged — GO+1 s measures 3.88 m/s against a reference of 4 — which is
the strongest available evidence that the anchor was the error and the numbers
were right all along. A harness can encode a bug as its definition of normal, and
nothing about its green output says so.

**Acted on.** `countdown-hold` in `grid-start.mjs`: every kart's position and
speed must not move between START and GO. 960 assertions, 0 violations after the
fix. It also prints **peak throttle commanded during the countdown = 1.000**,
which is what stops it passing vacuously — the karts are *held*, not merely
undriven, and if no driver ever commands throttle the check reports itself
unmeasured instead of green. The `countdown-drive` sabotage rewrites velocity
every step rather than nudging once, because a detector proven only against a
transient is not proven.

**Recorded against ourselves.** `countdown-hold` proves the gate for the seven AI
karts and **cannot prove it for the player**. A headless run has no keyboard, so
the player kart reads 0 m/s whether or not the gate exists, and `setInput` cannot
substitute: it switches the player to `'scripted'`, which bypasses the gate by
design, so injecting throttle there would measure the bypass and **pass
identically on a build with no gate at all**. It is filed PENDING. Closing it
needs `HarnessAPI.injectInput`, which this build honestly reports as unavailable.

**A trap created and removed inside the same round.** The first version of the
gate held input during `'idle'` as well. Every harness in this repo runs with the
race never started, so that version silently zeroed another agent's scripted
probe mid-investigation and it measured a stationary kart with no error of any
kind — the same defect shape as the `releaseInput` bug fixed days earlier, one
commit later, in a different file. `'idle'` is now ungated and `'scripted'`
bypasses the gate, so a caller that has seized the controls is never silently
overridden. The residue that gating `'idle'` was covering up is properly fixed by
`race.start()` establishing the grid.

`lastInput` deliberately records the driver's **ungated** command. Recording the
gated zero would make the gate invisible to every harness that reads it, and
would make `steer-test`'s `ai-command` read `0.0000` against a working AI outside
`'racing'` — which is, once again, the bug this project has now paid for twice.

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
