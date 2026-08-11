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

## 4. "Too slippery, like it drifts by itself" was three separate bugs and one wrong guess

**Round 8 → 9. Found by:** driving the deployed build.

> The road is too slippery. It's kind of like it drifts by itself.

and, a few minutes later:

> The road when it curves should use the same setting as the normal road.

**The second sentence was wrong, and it was still worth having.** Per-wheel grip in
corners measures **0.896** against **0.772** on the straights — corners are the
grippier part of this circuit, because the line rides the 0.95 kerb through
apexes. Applying the reporter's own proposed fix would have made it worse. But
the report correctly localised *something* to corners, and it was the thing that
sent one agent to a constant-radius constant-surface bench where the vehicle
defect was finally isolated. A wrong diagnosis attached to a real observation is
still evidence; what it is not is a work order.

Three defects, none of them the tyre grip table everyone reaches for first.

### The racing line was laid inside the sand

`track.ts` clamps the racing line to `halfWidth − RACING_MARGIN` with
`RACING_MARGIN = 1.35`. `surfaceAt` returns `SandDrift`, grip **0.62**, within
`SAND_EDGE_WIDTH = 1.7` of the edge. **The two constants had never been compared
to each other.** Wherever the clamp bit — 925 m of a 1624 m lap — the line sat
0.35 m inside the sand, and a kart of real width sat with its outer wheel 0.99 m
into it and its inner wheel 0.29 m outside.

Result: a permanent, one-sided 0.88 / 0.62 axle split across **85.2% of straight-
line distance**, mean signed asymmetry **+0.2216**. That is "it drifts by itself",
literally: the kart is pulled one way, all the time, with nothing commanded.

`road.ts` paints the rubber lay-down *along* `racingLine`, so the dark line a
human naturally aims at was exactly the sand. The game was inviting the player
onto its slipperiest surface.

**It also closes a red that had been blamed on the chassis.** `steer-test`'s
check 6 asymmetry — 8.4%, then 17.2% after the suspension fix restored tyre load
— was measured by a probe that `seek`s to `lateral: 0`, which resolves to the
racing *line*, not the centreline. Placed on the centreline instead, the same
build measures **0.00% asymmetry and 2.8e-8 m of zero-steer drift.** The kart is
bit-exactly symmetric: `dRight +1.4418569242656136`, `dLeft −1.4418569242656136`.
Two agents spent hours looking for a yaw moment inside a vehicle that did not
have one, because the instrument was standing with one axle on each of two
surfaces and nothing said so.

### The chassis oversteered by construction, and a fake damper hid it

`FRONT_AXLE = 0.72`, `REAR_AXLE = −0.68` — the mass centre sits *behind* the
wheelbase midpoint on a rear-driven kart. And because chassis attitude is taken
from the averaged road normal there is **no pitch or roll degree of freedom**:
all four springs sit at the same length, static load is **637.65 N on every
wheel, exactly 50/50, with zero load transfer under cornering**. So the rear has
50% of the capacity and is asked for 51.4% of the force. At saturation the net
yaw moment is `(a−b)·F_peak = +45 N·m` — **pro-spin, with no restoring term at
all.**

Every steady-state measurement said understeer. That reading was manufactured by
`yawRate *= 1 − step·1.65`, a yaw-rate damper with no physical counterpart. The
measured understeer gradient varies **3.25× with speed** — a real one does not
vary at all — and fits `K₀ + A/v` with **K₀ = −0.0159**, negative, oversteering.
The entire apparent stability was the 1/v term. Remove the damper and the kart
departs at every speed and every steer tried. Above 26 m/s it was supplying more
yaw damping than all four tyres combined.

**A fictitious term that makes a broken model look right is worse than the break
it hides**, because every instrument agrees with it.

### The engine could ask for 3.1× what the rear tyres could transmit

`ENGINE_FORCE = 3450` N against a rear-axle budget of `2 × 637.65 × 0.88 = 1122`
N. Below 21.3 m/s at full throttle the rear was in gross wheelspin — contact
patch at **278.7 m/s while the kart did 21.2**, slip-saturated for **99.9%** of a
0→25 run — and the friction circle correctly took the lateral force away. This is
the leg the player actually felt, because it fires the moment you use the
throttle in a corner.

### What the numbers did

| | before | after |
|---|---|---|
| cross-axle grip step ≥0.2, straights | 85.2% | **0.00%** |
| zero-steer drift in 0.75 s | +0.0548 m | 2.8e-8 m |
| step-steer 0.4 at 24 m/s, peak body slip | **74.7°** | 6.5° |
| …and on releasing the wheel | **90.0°** (spins) | 5.7° |
| understeer gradient K₀ | −0.0159 (oversteer) | **+0.0741** |
| max usable steer at 22 m/s | 0.343 | 0.791 |
| `slip-check` corner compliance | 2.792 deg/(m/s²) | **0.640** |
| 0→25 m/s | 6.97 s | **6.97 s** |
| `steer-test` check 6 asymmetry | 17.2% | 4.2% |
| `grid-start` corner-onroad | FAIL | **PASS** |

### Why the gates missed it

- **`steer-test` probes for 0.75 s.** Step steer at 20 m/s looks *settled* at 1 s
  and departs between 2 and 3. A short probe does not merely risk missing a slow
  divergence — here it reliably reported the stable-looking part of a divergent
  response.
- **Its probe stood on a grip discontinuity**, so the one number that could have
  exposed the sand — `baselineDrift.lateral`, +0.1396 m of movement at zero steer
  — was printed in every report and read by nobody as a defect.
- **No harness had a reference vehicle.** "Is 2.79 deg/(m/s²) of body slip a lot?"
  is unanswerable without one. `slip-check`'s bicycle model measures 0.37, and
  that ratio is what turned a taste argument into a defect.
- **`autoplay` gates outcomes.** Both builds respawn ~85 times a race; stock
  completes *fewer* laps. A field that is uniformly broken satisfies every
  outcome threshold that has no baseline.
- **Nothing compared two constants in the same file.** `RACING_MARGIN` and
  `SAND_EDGE_WIDTH` are 3 lines apart in `track.ts` and describe the same
  geometry. There is no harness class for "two numbers that must be related and
  are not", and this project now has two instances: these, and the damper hiding
  the axle split.

### Recorded against ourselves

- The `--broken` self-test for `grid-start` cannot prove six of its detectors
  while their checks are red on a clean build, and says so rather than passing.
- `slip-check` caps at ~25 m/s, so it **never reached** the throttle-limited
  corner; `slip-corner` reads identically across all three engine variants. The
  gate that graded this fix could not see one third of it.
- `slip-corner`'s peak of 70.6° is unchanged and is **the harness's own
  controller** saturating at ±1.00 and leaving the road at 4 m/s, in both builds.
  It was not tuned to.
- The user asked for all three engine options and got two. Stacking the traction
  limit onto the engine reduction costs **+43% on 0→25 for zero steering gain**,
  because pinning `driveForce` at exactly the longitudinal limit leaves the
  friction circle no lateral budget at all — the same lost corner, by a different
  route. Reporting that back was worth more than executing the instruction.
- Deliberate drift still reaches tier 3 at 18 and 24 m/s, but the AI's tier-3
  rate fell **14.8% → 8.9%**. That is the one number that moved the wrong way and
  it is written here rather than left in a log.

---

## 5. Three sentences, three unrelated bugs, and one of them no harness could ever have found

**Round 9 → 10. Found by:** playing the deployed build for several minutes.

> Driving along for a fair distance, then it turns right by itself — I think —
> and then it's like I can't control anything. And after a while it resets itself
> and starts again.

Three clauses. Three separate defects, in three different subsystems, none of
them the one the sentence structure implies.

### "It turns right by itself" — partly the road, and partly an idle gamepad

**The kart does not self-steer.** Zero commanded steer on a validated flat plane,
60 s × 12 conditions: heading drift, lateral drift and ∫yaw all **bit-exactly
0.0000**. On the real circuit over 25 s the kart turned −0.120° while **the road
turned +43.7°**. The lap is 1040 m of right-handers against 436 m of left, and
from the grid it is 129 m of straight into a 257 m right-hander.

But the other half was real, and it is the finding of the round. `input.ts`
picks one device — "the one most recently used" — and for a gamepad, which fires
no events, "used" meant `1e-3` of axis movement between polls. **A worn stick
jitters by more than that untouched.** Reproduced on the shipped build with a pad
parked at 0.35 with 0.004 of jitter:

```
steer 0.207 with no key held                    <- "it turns right by itself"
ArrowLeft + ArrowUp -> steer 0.207, throttle 0  <- "I can't control anything"
```

**The keyboard could never take the frame back**, and that is the cruel part: a
key held down emits no further events. `keydown` fired once, `keyup` has not
happened, and OS auto-repeat is deliberately discarded. The pad re-claimed on its
own noise every tick, forever.

"After a fair distance" is explained too — Chrome hides a connected gamepad until
the user interacts with it, so an idle controller is invisible at load and
appears mid-race the moment it is bumped.

### "I can't control anything" — under throttle the wheel was disconnected

Step steer 0.85 held 3 s at 20 m/s with the throttle down, then release the wheel
to zero: **the kart turned another 183.3° over 5.57 s**, yaw rate pinned at
0.615 rad/s. Off the throttle the same input peaks at 5.2° and straightens in
0.63 s. And **full opposite lock with the throttle held moved the sustained yaw
rate by under 0.02 rad/s versus doing nothing at all.**

The friction circle scaled both force components radially. Radial scaling
preserves whatever direction two independent `tanh` curves landed on — and with
both saturated that direction is exactly 45°. A longitudinally-saturated driven
rear therefore kept `peak/√2` of lateral force while the undriven front kept all
of it: `2·(0.68·peak − 0.72·0.707·peak) = +192 N·m`, against the −45 N·m the axle
split exists to provide. **Same term, opposite sign, 4.3× the magnitude.**

### "It resets itself" — the stall detector fired on a kart driving perfectly

`race.ts` reset the stall timer only when `progress` beat `bestProgress`. But
`progress` is a **position**, and `respawn()` moves the kart backwards on purpose
without re-baselining it. Every rescue handed the kart a distance debt to re-drive
inside 12 s — and **six of the seven sections take longer than 12 s from a
standstill**, worst 18.1 s. The debt is normally unpayable.

One deliberate 1.2 s mistake in a 200 s run that otherwise holds the road 100% of
the time: **8 respawns instead of 1**, at 34.0 s and then 46.0, 58.1, 70.1, 82.1,
94.1, 106.1, 118.1 — **12.005 s apart, every time, with the kart on the centreline
at 18.3 m/s.** Zero laps completed instead of one.

Both respawn triggers were checked and **neither was wrong**, which is why neither
constant moved. `onTrack` is generous rather than tight — by the time it flips
false all four wheels are on gravel. The 2.25 s off-track grace recovered 95 of 95
controlled excursions, worst 2.18 s.

### Why the gates missed them

- **No harness in this project can press a key.** `HarnessAPI.injectInput` does
  not exist; `grid-start.mjs` files the player half of its countdown check as
  PENDING for exactly that reason. The gamepad defect was invisible **by
  construction** — and the keyboard path had never been exercised end to end
  until this round, when it was finally driven in a real Chrome with real trusted
  events and found clean across nine sequences.
- **`steer-test` probes 0.75 s.** The departure needs 2.5–3 s of held steer to
  build. A slow steer *ramp* never departs at any speed — only a step does — so
  every steady-state sweep in the repo is blind to it.
- **Nothing in the repo ever released a held steer and asked whether the car
  straightens.** That single measurement is what separates "it slides in corners"
  from "the steering has stopped working", and it did not exist.
- **`slip-check`'s cruise controller lifts off for corners.** The departure is
  throttle-triggered, so the one long-run harness in the project **drives around
  its own trigger**, and its 15.5 m/s mean sits below the danger band.
- **The stall bug was a second instance of a trap the file already documents.**
  `race.ts` carries a comment explaining that `progress` falls at the seam and
  after a respawn. The comment was right, the detector next to it was not.

### Recorded against ourselves

- **A fix shipped earlier the same day rested on a false premise.** The axle-swap
  comment claimed "measured load transfer is exactly zero — 1275 N front, 1275 N
  rear, cornering or not." That was measured on a synthetic flat plane, which
  **cannot show pitch-curvature transfer by construction**. On the real road the
  rear's share is 49% on the flat straight, **38% on the dune sweep**, 59% on The
  Wall. The value survived re-examination; its justification did not, and the
  alternative the finding implies was measured and rejected on cost.
- The textbook elliptical combined-slip model was implemented and is measurably
  **worse** here (171.6° vs 184.0°). Being the honest tyre model does not make it
  the right one for a chassis with no pitch freedom.
- `slip-check` passing all 12 for the first time is **corroboration, not proof**,
  for the reason above — it lifts off for corners.
- **`ess-2` may be untakeable.** R = 47.6 m, unbanked, opening 1.6 m after a 72.4 m
  left-hander with no straight to brake in. Minimum stable radius is 52.7 m at
  20 m/s, so the corner needs ≲18.8 m/s. A closed-loop run went off there **seven
  times in 100 s and never completed a lap**, every excursion identical: t=0.2936,
  18.2 m/s, commanded steer **+1.000**. That is circuit geometry and it is still
  open.
- An agent killed the user's Discord while cleaning up a stray harness process,
  using a `CommandLine -match 'autoplay'` filter that also matched Discord's
  renderer flags. Nothing was lost, and it is written here because the next
  cleanup will be tempted by the same shortcut.

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
