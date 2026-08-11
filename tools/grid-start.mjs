/**
 * THE FIRST FIFTEEN SECONDS. What a player actually gets for pressing START.
 *
 *   node tools/grid-start.mjs            # against the production build
 *   node tools/grid-start.mjs --dev      # against the dev server
 *   node tools/grid-start.mjs --broken   # self-test: prove every detector fires
 *
 * WHY THIS EXISTS, AND WHY SEVEN GREEN HARNESSES MISSED IT
 * -------------------------------------------------------
 * `track-check`, `seam-check`, `steer-test`, `energy-check`, `smoke`, `fps-bench`
 * and `autoplay` are good instruments. Twelve track invariants, a watertight
 * ground, a frame-energy budget, a partial-present detector, the steering sign on
 * two independent anchors. Every one of them opens with `__harness.seek()`, which
 * TELEPORTS the kart to a clean mid-circuit position with the field scattered and
 * idle.
 *
 * So not one of them has ever looked at a standing start. And that is where the
 * bug was: press START and the camera points sideways at a canyon wall. Seven
 * instruments green, and the first thing anybody sees is broken.
 *
 * CLAUDE.md says "a screenshot cannot find a gameplay bug". It has a twin:
 *
 *     A HARNESS THAT ARRANGES ITS OWN CONVENIENT STARTING STATE
 *     CANNOT FIND A STARTING-STATE BUG.
 *
 * THE RULE THIS FILE OBEYS
 * ------------------------
 * **It may not call `seek()` or `resetRace()` before its measurements.** Not once,
 * not "just to be deterministic", not in the self-test. It loads the page and
 * calls `startRace()`, which is what the START button does (`ui/hud.ts:325`
 * `activate()` calls the same `race.start()`). Everything it asserts has to come
 * out of that state.
 *
 * Two harness calls are made DURING the run, both after the measurements that
 * could be affected by them, and both are named where they happen:
 *   - `setDriver(playerKartId, 'referenceAI')` at GO+8 s, so the player kart
 *     eventually leaves the grid and the camera can be measured against a MOVING
 *     kart and across the t=0 seam. Everything check 4 asserts about the resting
 *     player is already measured by then. It repositions nothing.
 * Nothing else touches the world.
 *
 * WHAT IT ASSERTS
 * ---------------
 *   grid-slots        `track.startGrid` itself: every slot on the road, inside
 *                     halfWidth by a kart's footprint, no two slots overlapping,
 *                     each facing along the tangent at its own `t`. Deterministic
 *                     — no simulation is involved, so this one cannot flake.
 *   grid-karts        The eight karts, AS OBSERVED at the earliest tick the
 *                     harness exists, are actually ON those slots, at rest, on
 *                     the road, facing forward, not overlapping.
 *   cam-behind        The camera sits BEHIND the player kart along its own
 *                     forward axis and near its centreline. Not beside it, not
 *                     in front of it, not parked at the world origin.
 *   cam-tangent       The camera's forward axis agrees with the track tangent at
 *                     the player's position. THIS is the shipped bug's check.
 *   cam-follows       Over the run the camera travels a distance comparable to
 *                     the kart's. A detached camera scores zero here and no
 *                     threshold argument is needed to see it.
 *   cam-seam          Across the t=0 crossing the view does not jump: the tangent
 *                     agreement holds through it with no special case, and the
 *                     angular rate of the view stays under a cap derived from
 *                     the tightest corner on this stretch of road.
 *   countdown-order   idle -> countdown -> racing happens at all.
 *   countdown-timing  ...and the transition lands where a three-beat countdown
 *                     puts it. Split from the above so that a build with a
 *                     timing bug can still prove its start-button detector works.
 *   countdown-clock   `IRace.clock` is negative through the countdown, rises
 *                     monotonically, and crosses zero on exactly the tick the
 *                     phase becomes 'racing'.
 *   countdown-hud     The 3 / 2 / 1 / GO! a player actually sees. A PROXY for
 *                     `race:countdown`, which is unobservable — see PENDING.
 *   countdown-hold    ...and NOTHING MOVES while it runs. Every kart's position
 *                     and speed stay at their grid values from the tick START
 *                     was pressed until the phase becomes 'racing'. Added after
 *                     a human found the field driving through 3-2-1 while the
 *                     three checks above were all green: they grade the phases,
 *                     the timing and the clock, and none of them ever asked
 *                     whether a kart moved.
 *   launch-field      Every AI kart accelerates away, against a known-good
 *                     reference measured from the real game.
 *   launch-player     The player kart is at EXACTLY zero with no input. This is
 *                     correct and it is asserted as correct, so a reader knows
 *                     which stationary kart is the expected one.
 *   stuck-motion      Over the first 15 s every kart that should be moving keeps
 *                     covering ground.
 *   stuck-respawn     Nobody respawns and nobody grinds a wall.
 *   progress-counter  `ticksWithoutProgress` behaves. NOT gated on its value —
 *                     see the note on the lap-1 latch below.
 *   corner-onroad     Through the first real corner nobody leaves the road.
 *   corner-clearance  Through the first real corner nobody interpenetrates.
 *   corner-flow       Through the first real corner nobody stops.
 *
 * THE LAP-1 `bestProgress` LATCH — HANDLED THE WAY autoplay.mjs HANDLES IT
 * ------------------------------------------------------------------------
 * The grid sits BEFORE the start line, at t = 0.9834 .. 0.9963 (`world/track.ts`
 * :1058, eight slots at `length - (6 + (i>>1)*7)` metres). `Standing.progress` is
 * `completedLaps + t`, so `bestProgress` latches ~0.996 the moment the lights
 * come on and cannot be beaten again until the kart is 99% of the way round.
 * `ticksWithoutProgress` therefore counts a WHOLE LAP of "no progress" on a
 * perfectly healthy field, by construction.
 *
 * `tools/autoplay.mjs:397-416` already worked this out and keeps the lap-1 peak
 * separately rather than gating on it. This file does the same thing rather than
 * inventing a second answer: `progress-counter` asserts the counter RUNS (rises
 * with the tick count, never goes backward, never resets inside a window in
 * which no lap can possibly have been completed) and reports the value. It does
 * not gate on the value. The stall detector that IS gated is `stuck-motion`,
 * which measures metres of world displacement and owes nothing to `bestProgress`.
 *
 * HOW IT GETS AN UNCONTAMINATED VIEW OF THE GRID
 * ----------------------------------------------
 * `main.ts:driverFrame` used to step every driver and every kart on every tick
 * with NO PHASE GUARD, and the seven AI karts default to `'referenceAI'` from
 * build. They were therefore driving before anybody pressed START, and "the
 * state of the grid" decayed with wall-clock time between page load and the
 * first thing the harness could ask — exactly the machine-load dependence the
 * contract's CLOCK section exists to forbid. `countdown-hold` below is the check
 * that finally named it, and the gate in `driverFrame` is the fix.
 *
 * THE INIT-SCRIPT CAPTURE STAYS, AND THE GUARD LANDING IS NOT A REASON TO
 * REMOVE IT. It is what makes the grid snapshot independent of how long this
 * machine took to boot the page, and it is the ONLY reading in this file that
 * does not go through the phase gate — so it is also the only reading that could
 * ever catch that gate regressing. A capture taken after `ready` plus a
 * Playwright round trip would land at tick 30-80 and would agree with a broken
 * build for as long as the breakage was small.
 *
 * So the grid snapshot is taken from an INIT SCRIPT that polls rAF and captures
 * the instant `window.__harness` becomes visible (`main.ts:1043`). That lands at
 * tick 0-2. The tick it actually landed on is printed with the result, because a
 * measurement whose contamination is unreported is a measurement you cannot
 * argue with.
 *
 * This is also why `lib/browser.mjs:openGame` is not called directly: it has no
 * hook for an init script. The page-open below is otherwise the same code and the
 * same console-error collection, and it is the one duplication in this file.
 *
 * SCREENSHOTS ARE TAKEN FROM INSIDE THE PAGE, ON EXACT TICKS
 * ---------------------------------------------------------
 * `loop.stepTicks` restarts the live rAF loop when it returns (`core/loop.ts`
 * :141-147). Leaving the page to take a Playwright screenshot therefore hands the
 * simulation back to the wall clock for however long the screenshot takes, and
 * drops an unknown number of ticks into the middle of a launch measurement.
 * Instead the run stays inside ONE `page.evaluate`, and grabs the canvas with
 * `toDataURL` at named ticks. That needs `preserveDrawingBuffer`, which is what
 * `?debug=frames` is for; if it is absent the screenshots go PENDING and every
 * number is still measured. One composited Playwright screenshot is taken at the
 * end as well, because the canvas alone does not show the HUD.
 *
 * SELF-TEST. `--broken` reloads the page once per sabotage, damages the REAL
 * running game — live kart positions, the live camera object, the real
 * `setDriver`, the real `startRace` — runs the whole battery against the damage,
 * and asserts the OWNING check went red. The battery is completely sabotage-blind:
 * everything is installed from the init script before the game has finished
 * booting, so there is no branch inside the measurement that a sabotage could
 * take. A sabotage that cannot be applied is a MISS, not a skip.
 */

import path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { ROOT, startServer } from './vite-server.mjs'
import { launch } from './lib/browser.mjs'

const args = process.argv.slice(2)
const useDev = args.includes('--dev')
const selfTest = args.includes('--broken')

const OUT = path.join(ROOT, 'tools', 'out')
mkdirSync(OUT, { recursive: true })

// ---------------------------------------------------------------------------
// Tolerances. Every one has a derivation, and the derivation names its source.
// ---------------------------------------------------------------------------

const TOL = {
  // --- sampling -----------------------------------------------------------
  /** Ticks between samples. 6 ticks = 0.05 s at SIMULATION_STEP = 1/120. Chosen
   *  so the angular-rate cap below is evaluated over a window short enough that
   *  a single-frame whip cannot average itself away. */
  sampleTicks: 6,
  /** Ticks the run advances before giving up on the countdown ever ending.
   *  `autoplay.mjs:236` uses 1200 for the same purpose and states the argument:
   *  the countdown is 3 s per `GameEvents['race:countdown']`, so 10 s is three
   *  times it and a build that never starts is a real fault, not a slow one. */
  countdownTicksMax: 1200,

  // --- check 1: the grid --------------------------------------------------
  /**
   * Kart footprint radius in plan, metres: sqrt(FRONT_AXLE^2 + HALF_TRACK^2)
   * = sqrt(0.72^2 + 0.64^2) = 0.963, from `src/kart/kart.ts:33-35`. Everything
   * about overlap and road clearance is measured against THIS rather than a
   * guessed "kart width", so a chassis change moves the number honestly.
   */
  kartRadius: 0.963,
  /** Two karts closer than twice the footprint radius are inside each other. */
  gridMinSeparation: 1.926,
  /**
   * A slot's heading against the tangent at its own `t`. The grid is built from
   * `makeBasis(right, normal, -tangent)` off the same sample (`world/track.ts`
   * :1080), so the correct answer is 0.000 deg and this is a float-slop rail
   * rather than a tuning parameter. 2 deg is also the point at which it stops
   * being slop: at 2.7 m off centre over the 27 m from the back row to the
   * line, 2 deg is 0.94 m of drift, about a kart width.
   */
  headingDeg: 2.0,
  /**
   * How far a kart may sit from its slot in PLAN (XZ). The kart is placed on the
   * slot and then settles onto its suspension, which moves it in Y only —
   * SUSPENSION_TRAVEL is 0.09 m (`kart.ts:37`), so Y is reported and not gated.
   * In plan the correct answer is 0.000; 5 cm is slop.
   */
  gridOffsetM: 0.05,
  /** A grid is at rest. Not "nearly" at rest. Float zero. */
  restSpeed: 1e-6,

  // --- check 2: the camera ------------------------------------------------
  /**
   * Metres the camera must sit BEHIND the player, measured as the negative
   * component of (camera - kart) along the kart's forward axis.
   *
   * The rig's own design value is CHASE_DISTANCE = 6.1 m at a standstill rising
   * to 7.8 m at SPEED_REFERENCE (`src/game/camera.ts:74-77`). The gate is
   * deliberately WIDER than the rig: [2, 20] m passes any defensible re-tune of
   * the chase distance and fails anything that is beside, in front of, or
   * detached from the kart. It is not trying to grade the rig's taste.
   */
  camBehindMin: 2.0,
  camBehindMax: 20.0,
  /**
   * Metres the camera may sit off the kart's centreline. The rig puts it at
   * exactly 0 by construction (`camera.ts:527-530` adds only along
   * `followForward` and `smoothUp`).
   *
   * DERIVED, and the derivation is why it is 2.0 and not 3.0: at the 6.1 m
   * chase distance a 62 deg FOV (`camera.ts:70`) is 2 * 6.1 * tan(31 deg) = 7.3 m
   * wide, so half-frame is 3.66 m. At 2.0 m of lateral offset the kart sits 55%
   * of the way to the frame edge — the point at which it stops being the subject
   * of the shot. 3.0 m would have been too loose to catch the shipped bug at
   * kart 0's grid slot, which is 2.7 m off the centreline.
   */
  camSideMax: 2.0,
  /**
   * Degrees between the camera's forward axis and the track tangent at the
   * player, both projected to the horizontal plane.
   *
   * DERIVED for the stretch this harness measures, which is the grid to the exit
   * of turn one and nothing else. The rig aims at a blend of the road ahead and
   * the kart's nose (AIM_ROAD_WEIGHT = 0.55, `camera.ts:107`) at
   * min(9 + 0.8*v, 42) m (`camera.ts:88-90`). Turn one is `grid-ease`, 70 m for
   * 48.19 deg (`world/track.ts:149`), R = 83.2 m. At 24 m/s the aim point is
   * 28 m ahead, and 28 m of an 83.2 m radius is 19.3 deg of tangent change. Add
   * the spring lag and the nose-blend and 35 deg has comfortable headroom on
   * correct behaviour.
   *
   * The shipped bug measures ~88 deg: START_BEARING is 88.2 deg (`track.ts:111`)
   * so the start straight runs very nearly +X, while the placeholder dolly in
   * `main.ts:132-134` looks down -Z. 35 deg catches that with 2.5x of margin.
   */
  camTangentDeg: 35.0,
  /**
   * Degrees per second the view may swing.
   *
   * DERIVED: the tightest radius on the measured stretch is R = 83.2 m and the
   * game's top speed is 31.5 m/s (`kart.ts:55`), so the fastest legitimate
   * heading rate anywhere in this window is v/R = 0.379 rad/s = 21.7 deg/s. The
   * cap is 5.5x that. It cannot fire on driving; it fires on a discontinuity —
   * a snap, a whip-pan, or a seam the rig does not handle.
   */
  camSwingDegPerSec: 120.0,
  /**
   * Camera path length as a fraction of kart path length over the same window.
   * A chase camera at a roughly fixed offset travels what the kart travels, so
   * the correct answer is ~1.0. 0.5 is a floor only a detached or frozen camera
   * can fail, and it needs no argument about rig taste at all.
   */
  camFollowRatio: 0.5,
  /** Below this much kart travel the ratio above is noise, so it is not gated. */
  camFollowMinKartPath: 40.0,

  // --- check 3: the countdown ---------------------------------------------
  /**
   * Ticks from `startRace()` to phase 'racing'. `GameEvents['race:countdown']`
   * enumerates n = 3 | 2 | 1 | 0 in the contract, so the countdown is three
   * beats = 360 ticks at 120 Hz. The band is +/- 0.5 s: a re-tune of the
   * countdown length is not a failure, a missing or doubled countdown is.
   */
  goTickMin: 300,
  goTickMax: 480,

  // --- check 3b: the countdown HOLDS the field ----------------------------
  /*
   * FOUND BY A HUMAN PLAYING THE GAME, WHICH IS THE WHOLE POINT OF THIS FILE.
   *
   * Press START and the field drives off during 3-2-1. Every check above was
   * green while it did: `countdown-order` only asks that the phases happen,
   * `countdown-timing` only that GO lands on the beat, `countdown-clock` only
   * that the clock is a clock. Not one of them ever asked whether a kart MOVED
   * while the lights were still on — and `launch-field`'s own reference numbers
   * were measured against the bug, which is why they are "seconds after
   * startRace()" and not "seconds after GO".
   *
   * A standing start is standing. The correct answer for both numbers below is
   * exactly 0, so these are slop rails and not tuning parameters.
   */
  /**
   * Metres a kart may move in PLAN (XZ) between `startRace()` and the phase
   * becoming 'racing'. Y is excluded for the same reason `gridOffsetM` excludes
   * it: the kart settles onto SUSPENSION_TRAVEL = 0.09 m (`kart.ts:37`) in Y
   * alone, and that is not driving. 5 cm matches `gridOffsetM` because it is the
   * same claim about the same karts on the same slots.
   */
  countdownDriftM: 0.05,
  /**
   * `KartState.speed` is signed m/s along chassis forward, so suspension
   * settling does not enter it at all. Not float zero like `restSpeed`: a kart
   * resting on a graded road may creep, and a gate that fires on creep would be
   * grading the surface model rather than the countdown. 0.05 m/s is 0.15 m over
   * the three-second countdown — well inside `countdownDriftM`, so this is the
   * secondary rail. It catches a kart that has started moving but has not yet
   * gone anywhere, which is what a sample landing just after GO-minus-epsilon
   * looks like.
   */
  countdownSpeed: 0.05,

  // --- check 4: the launch ------------------------------------------------
  /**
   * KNOWN-GOOD REFERENCE, measured from the real game: [seconds after GO, m/s].
   *
   * RE-ANCHORED FROM `startRace()` TO GO, AND THAT IS PART OF THE BUG FIX.
   *
   * These used to be "seconds after `startRace()`", with a comment explaining
   * that `main.ts` stepped the AI during the countdown so "the field is already
   * rolling when the lights go out; the reference numbers include that". They
   * did include it — which made this a reference calibrated against a defect,
   * and the exact shape CLAUDE.md warns about: a confident, precise number that
   * is fiction because the thing it was measured on was wrong. The moment the
   * gate in `main.ts:driverFrame` landed, `launch-field` went red on a CORRECT
   * build, reporting 0.00 m/s at "t+1s" because t+1s was still the countdown.
   *
   * Anchored to GO these are the same physical claim they were always trying to
   * make — a kart accelerates from rest to racing speed in the first few seconds
   * — and they are now measurable on a build where the standing start stands.
   */
  launchRef: [[1, 4], [4, 15], [8, 24]],
  /**
   * Fractional band on the reference. The eight karts run different lines and
   * different skill, and a modest physics re-tune should not fail this gate —
   * but 0 m/s ("did not launch") and 60 m/s ("teleported") must. The observed
   * spread across the seven AI karts on the clean run is printed with the result
   * so this number can be tightened against evidence rather than taste.
   */
  launchTolFrac: 0.4,

  // --- check 5: nothing is stuck ------------------------------------------
  /**
   * Seconds of race the stall window covers, FROM GO.
   *
   * Also re-anchored, and for the same reason as `launchRef`: from
   * `startRace()` this window graded the three seconds of countdown, in which a
   * correctly-held kart covers 0 m against a 1 m/s floor. "Nothing is stuck" is
   * a claim about a race, and the race starts at GO.
   */
  stuckWindowSeconds: 15,
  /**
   * Metres a kart that should be moving must cover per 1 s window.
   * `MIN_TARGET_SPEED` in the reference AI is 8 m/s (`src/game/ai.ts:229`), so a
   * kart under 1 m/s is at an eighth of the slowest speed the AI ever asks for.
   * That is wedged, not slow.
   */
  minMetresPerSecond: 1.0,
  /** A standing start on an empty straight into one open corner. Zero. */
  maxRespawns: 0,
  /**
   * Wall contacts permitted per kart over the window. NOT derived — taken from
   * the clean run's observed maximum plus headroom, and the observed value is
   * printed so the next reader can see whether the headroom is real.
   */
  maxWallHits: 4,

  // --- check 6: the first corner ------------------------------------------
  /**
   * Curvature above which a piece of road is "a corner", in 1/m. This is the
   * project's own number, not a new one: `world/track.ts:381` puts a kerb
   * wherever R < 170 m, so the track file already calls anything tighter than
   * 170 m a corner.
   */
  cornerKappa: 1 / 170,
  /** Metres of road before the corner's start that count as its entry. */
  cornerLeadIn: 30,
  /**
   * Minimum speed through the corner. Below the AI's own `MIN_TARGET_SPEED` of
   * 8 m/s by a wide margin, so only a genuine stoppage fires.
   */
  cornerMinSpeed: 5.0,
  /**
   * Metres between kart centres. Two footprint radii is 1.93 m and that is
   * TOUCHING, which is legal racing — `HitKind` has a 'bump'. 1.2 m is 38%
   * interpenetration, which no collision response should let stand even for one
   * tick.
   */
  cornerMinSeparation: 1.2,

  /**
   * Seconds the whole run covers, FROM `startRace()` and deliberately not from
   * GO — this is the run's LENGTH, not an anchor for a measurement, and it has
   * to be a number the harness can compute before it knows whether GO will ever
   * happen at all (the `no-start` sabotage is a build where it does not).
   *
   * Raised from 26 to 29 when the countdown gate landed, so that the budget
   * AFTER GO is unchanged: 29 - 3.05 s of countdown is the same ~26 s of racing
   * every threshold below was set against. The player is handed to the AI at
   * GO+8 s and needs to reach turn one from a standing start on the grid.
   */
  runSeconds: 29,
  /** Seconds after GO at which the player is handed to the reference AI. Every
   *  assertion about the resting player is complete by then. */
  handoverSeconds: 8,
}

/** Kept in step with `src/types.ts`; asserted against the live value in-page. */
const SIMULATION_STEP = 1 / 120
const BARRIER_MARGIN = 1.5

// ---------------------------------------------------------------------------
// The battery. Runs entirely in the page; must not close over module scope, and
// must contain no branch a sabotage could take — every sabotage is installed
// before this function is ever called.
// ---------------------------------------------------------------------------

/* eslint-disable */
async function battery(opts) {
  const TOL = opts.tol
  const STEP = opts.simulationStep
  const BARRIER_MARGIN = opts.barrierMargin

  const h = window.__harness
  if (!h) return { blocked: 'NO_HARNESS' }

  const t0 = window.__gridStartT0
  if (!t0) return { blocked: 'NO_T0_CAPTURE' }

  let track
  try {
    track = h.track
  } catch (err) {
    return { blocked: 'TRACK_PENDING', message: String((err && err.message) || err) }
  }
  if (!track || typeof track.sample !== 'function') return { blocked: 'NO_TRACK' }
  if (!track.startGrid || track.startGrid.length === 0) return { blocked: 'NO_START_GRID' }

  let camera
  try {
    camera = h.camera
  } catch (err) {
    return { blocked: 'CAMERA_PENDING', message: String((err && err.message) || err) }
  }
  if (!camera || !camera.position || !camera.quaternion) return { blocked: 'NO_CAMERA' }

  // ---- vector maths without THREE ----------------------------------------
  // The page does not expose THREE, but `track.group.position` is a Vector3 and
  // its constructor is reachable, which is all `sample`/`locate` need. The rest
  // is plain objects; nothing here is in a hot path.
  const V3 = track.group.position.constructor
  const newSample = () => ({
    position: new V3(), tangent: new V3(), normal: new V3(), right: new V3(),
    halfWidth: 0, bank: 0, curvature: 0,
  })
  const newLoc = () => ({ t: 0, lateral: 0, height: 0, onTrack: false, checkpointIndex: 0 })
  const smp = newSample()
  const smp2 = newSample()
  const loc = newLoc()
  const probe = new V3()

  const v = (x, y, z) => ({ x: x, y: y, z: z })
  const sub = (a, b) => v(a.x - b.x, a.y - b.y, a.z - b.z)
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z
  const len = (a) => Math.sqrt(dot(a, a))
  const lenXZ = (a) => Math.sqrt(a.x * a.x + a.z * a.z)
  const norm = (a) => { const l = len(a) || 1; return v(a.x / l, a.y / l, a.z / l) }
  const flat = (a) => { const l = Math.sqrt(a.x * a.x + a.z * a.z) || 1; return v(a.x / l, 0, a.z / l) }
  /** Angle in degrees between two vectors already normalised. */
  const angDeg = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180 / Math.PI
  /** Rotate `d` by quaternion `q`. Same maths three.js uses; no allocation worry. */
  const qrot = (q, d) => {
    const x = q.x, y = q.y, z = q.z, w = q.w
    const ix = w * d.x + y * d.z - z * d.y
    const iy = w * d.y + z * d.x - x * d.z
    const iz = w * d.z + x * d.y - y * d.x
    const iw = -x * d.x - y * d.y - z * d.z
    return v(
      ix * w + iw * -x + iy * -z - iz * -y,
      iy * w + iw * -y + iz * -x - ix * -z,
      iz * w + iw * -z + ix * -y - iy * -x,
    )
  }
  const FWD = v(0, 0, -1)
  const RIGHT = v(1, 0, 0)
  const forwardOf = (q) => qrot(q, FWD)
  const rightOf = (q) => qrot(q, RIGHT)

  // ---- check bookkeeping --------------------------------------------------
  const checks = {}
  const CHECK_IDS = [
    'grid-slots', 'grid-karts',
    'cam-behind', 'cam-tangent', 'cam-follows', 'cam-seam',
    'countdown-order', 'countdown-timing', 'countdown-clock', 'countdown-hud',
    'countdown-hold',
    'launch-field', 'launch-player',
    'stuck-motion', 'stuck-respawn', 'progress-counter',
    'corner-onroad', 'corner-clearance', 'corner-flow',
  ]
  for (const id of CHECK_IDS) checks[id] = { id: id, n: 0, worst: null, fails: [], measured: 0 }
  const bump = (id, magnitude, message) => {
    const c = checks[id]
    c.n++
    if (c.worst === null || magnitude > c.worst) c.worst = magnitude
    if (c.fails.length < 8) c.fails.push(message)
  }
  const saw = (id, n) => { checks[id].measured += (n === undefined ? 1 : n) }

  const f = (x, d) => (typeof x === 'number' && isFinite(x) ? x.toFixed(d === undefined ? 3 : d) : String(x))

  // =========================================================================
  // CHECK 1a — grid-slots. The grid DEFINITION, with no simulation in it.
  // =========================================================================
  const slots = []
  for (let i = 0; i < track.startGrid.length; i++) {
    const s = track.startGrid[i]
    probe.set(s.position.x, s.position.y, s.position.z)
    track.locate(probe, loc)
    track.sample(s.t, smp)
    const fwd = forwardOf(s.orientation)
    const tanDeg = angDeg(flat(fwd), flat(smp.tangent))
    slots.push({
      i: i, t: s.t, lateral: loc.lateral, halfWidth: smp.halfWidth,
      onTrack: loc.onTrack, headingDeg: tanDeg,
      pos: v(s.position.x, s.position.y, s.position.z),
      fwd: fwd,
    })
    saw('grid-slots')

    const room = smp.halfWidth - Math.abs(loc.lateral)
    if (room < TOL.kartRadius) {
      bump('grid-slots', TOL.kartRadius - room,
        `slot ${i}: |lateral| ${f(loc.lateral)} m leaves ${f(room)} m to the road edge ` +
        `(halfWidth ${f(smp.halfWidth)}); a kart's footprint radius is ${TOL.kartRadius} m`)
    }
    if (!loc.onTrack) {
      bump('grid-slots', 1, `slot ${i}: track.locate says onTrack=false at t=${f(s.t, 4)}`)
    }
    if (tanDeg > TOL.headingDeg) {
      bump('grid-slots', tanDeg,
        `slot ${i}: faces ${f(tanDeg, 2)} deg off the tangent at its own t=${f(s.t, 4)}`)
    }
  }
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const d = len(sub(slots[i].pos, slots[j].pos))
      if (d < TOL.gridMinSeparation) {
        bump('grid-slots', TOL.gridMinSeparation - d,
          `slots ${i} and ${j} are ${f(d)} m apart; two footprint radii is ${TOL.gridMinSeparation} m`)
      }
    }
  }

  // =========================================================================
  // CHECK 1b — grid-karts. Where the karts ACTUALLY were, at the earliest tick
  // this harness could see them. `t0` was captured by the init script.
  // =========================================================================
  const gridReport = []
  for (const k of t0.karts) {
    const slot = slots[k.slotIndex]
    saw('grid-karts')
    if (!slot) {
      bump('grid-karts', 1, `kart ${k.id}: no grid slot at index ${k.slotIndex}`)
      continue
    }
    probe.set(k.pos.x, k.pos.y, k.pos.z)
    track.locate(probe, loc)
    track.sample(loc.t, smp)
    const fwd = forwardOf(k.quat)
    const headDeg = angDeg(flat(fwd), flat(smp.tangent))
    const dPlan = lenXZ(sub(k.pos, slot.pos))
    const dY = k.pos.y - slot.pos.y
    const room = smp.halfWidth - Math.abs(loc.lateral)

    gridReport.push({
      id: k.id, slot: k.slotIndex, speed: k.speed, t: loc.t, lateral: loc.lateral,
      halfWidth: smp.halfWidth, planOffset: dPlan, yOffset: dY, headingDeg: headDeg,
      onTrack: loc.onTrack,
    })

    if (Math.abs(k.speed) > TOL.restSpeed) {
      bump('grid-karts', Math.abs(k.speed),
        `kart ${k.id} is already moving at ${f(k.speed)} m/s at tick ${t0.tick} — ` +
        `the field left the grid before anybody pressed START`)
    }
    if (dPlan > TOL.gridOffsetM) {
      bump('grid-karts', dPlan,
        `kart ${k.id} is ${f(dPlan)} m (in plan) off startGrid[${k.slotIndex}] at tick ${t0.tick}`)
    }
    if (room < TOL.kartRadius) {
      bump('grid-karts', TOL.kartRadius - room,
        `kart ${k.id}: |lateral| ${f(loc.lateral)} m leaves only ${f(room)} m to the road edge`)
    }
    if (!loc.onTrack) {
      bump('grid-karts', 1, `kart ${k.id}: off track at t=${f(loc.t, 4)}, lateral ${f(loc.lateral)}`)
    }
    if (headDeg > TOL.headingDeg) {
      bump('grid-karts', headDeg,
        `kart ${k.id} faces ${f(headDeg, 2)} deg off the track tangent`)
    }
  }
  for (let i = 0; i < t0.karts.length; i++) {
    for (let j = i + 1; j < t0.karts.length; j++) {
      const d = len(sub(t0.karts[i].pos, t0.karts[j].pos))
      if (d < TOL.gridMinSeparation) {
        bump('grid-karts', TOL.gridMinSeparation - d,
          `karts ${t0.karts[i].id} and ${t0.karts[j].id} are ${f(d)} m apart on the grid`)
      }
    }
  }

  // =========================================================================
  // Find the first real corner. Measured from the live curvature profile, not
  // read off the §1 table — a table can go stale and this cannot.
  // =========================================================================
  const SCAN = 4000
  let cornerStart = null
  let cornerEnd = null
  let cornerPeak = 0
  for (let i = 0; i < SCAN; i++) {
    const t = i / SCAN
    track.sample(t, smp)
    const kappa = Math.abs(smp.curvature)
    if (cornerStart === null) {
      if (kappa >= TOL.cornerKappa) { cornerStart = t; cornerPeak = kappa }
    } else if (cornerEnd === null) {
      if (kappa > cornerPeak) cornerPeak = kappa
      if (kappa < TOL.cornerKappa) cornerEnd = t
    }
  }
  const cornerWindow = cornerStart === null
    ? null
    : {
        from: cornerStart - TOL.cornerLeadIn / track.length,
        start: cornerStart,
        end: cornerEnd === null ? cornerStart + 0.05 : cornerEnd,
        radius: cornerPeak > 0 ? 1 / cornerPeak : Infinity,
      }

  // =========================================================================
  // THE RUN. `startRace()` and `stepTicks` and nothing else.
  // =========================================================================
  const preStartTel = h.telemetry()
  const preStartTick = preStartTel.tick
  const prePhase = preStartTel.phase
  const preClock = preStartTel.clock

  saw('countdown-order')
  if (prePhase !== 'idle') {
    bump('countdown-order', 1,
      `phase was '${prePhase}' before startRace(), not 'idle' — the race started without a player`)
  }

  const kartIds = preStartTel.karts.map((k) => k.kartId)
  const playerId = h.playerKartId
  const aiIds = kartIds.filter((id) => id !== playerId)
  const respawnsAtStart = {}
  const wallHitsAtStart = {}

  // ---- press START --------------------------------------------------------
  h.startRace()
  const afterStart = h.telemetry()
  const startTick = afterStart.tick

  /*
   * THE RESPAWN AND WALL BASELINES ARE TAKEN AFTER `startRace()`, NOT BEFORE.
   *
   * Same argument as the GO anchors below, one step earlier in the run:
   * `stuck-respawn` asks "did anybody get stuck and need rescuing DURING the
   * race", and the race is established by `start()`. `game/race.ts:start` places
   * the whole field back on the grid, which goes through `IKart.respawn` and
   * therefore emits eight `kart:respawn` events — one per kart, on purpose. That
   * is the race being set up, not eight karts getting wedged, and `camera.ts`
   * :764 wants exactly that event so the rig SNAPS to the gridded kart instead
   * of whip-panning to it from wherever the start screen left it.
   *
   * Baselining before the button counted all eight of those as failures. Nothing
   * is lost by moving it: the OUTCOME of that placement is still fully graded —
   * `countdown-hold` asserts the field is then at rest and `grid-karts` asserts
   * it is on its slots — so a placement that went wrong still has two checks
   * looking straight at it.
   */
  for (const k of afterStart.karts) {
    respawnsAtStart[k.kartId] = k.respawns
    wallHitsAtStart[k.kartId] = k.wallHits
  }

  saw('countdown-order')
  if (afterStart.phase !== 'countdown') {
    bump('countdown-order', 1,
      `phase is '${afterStart.phase}' immediately after startRace(); a countdown was expected`)
  }
  saw('countdown-clock')
  if (!(afterStart.clock < 0)) {
    bump('countdown-clock', Math.abs(afterStart.clock),
      `clock is ${f(afterStart.clock)} immediately after startRace(); it must be negative through the countdown`)
  }

  const totalTicks = Math.ceil(TOL.runSeconds / STEP)
  const horizonTick = startTick + Math.min(totalTicks, Math.ceil(opts.horizonSeconds / STEP))

  /*
   * EVERYTHING THAT GRADES THE RACE IS ANCHORED TO GO. Only the run's length is
   * anchored to `startRace()`, because it must be computable on a build where GO
   * never arrives.
   *
   * These were all `startTick + ...` and they were wrong in a way that only a
   * CORRECT build reveals: while the karts drove during the countdown, "1 s
   * after START" and "1 s after GO" happened to describe similar states, so the
   * bug hid the anchor error and the anchor error hid the bug. Fixing one
   * without the other turns `launch-field` and `stuck-motion` red on a build
   * whose standing start is finally standing — which is how this was found.
   *
   * They are null until GO because GO's tick is not knowable in advance: the
   * countdown length is the race's to choose, and `countdown-timing` is the
   * check that has an opinion about it. A gate that never gets a tick asserts
   * nothing and reports itself unmeasured, which is the honest answer for a
   * build that never started.
   */
  let handoverTick = null
  let stuckEndTick = null
  const launchMarks = TOL.launchRef.map((r) => ({
    seconds: r[0], reference: r[1], tick: null, taken: null,
  }))
  const anchorToGo = (goAt) => {
    handoverTick = goAt + Math.round(TOL.handoverSeconds / STEP)
    stuckEndTick = goAt + Math.round(TOL.stuckWindowSeconds / STEP)
    for (const m of launchMarks) m.tick = goAt + Math.round(m.seconds / STEP)
  }

  const samples = []
  const shots = {}
  const canvas = (() => {
    let best = null
    const list = document.querySelectorAll('canvas')
    for (let i = 0; i < list.length; i++) {
      const c = list[i]
      if (!best || c.width * c.height > best.width * best.height) best = c
    }
    return best
  })()
  let preserveDrawingBuffer = null
  try { preserveDrawingBuffer = h.glReport().preserveDrawingBuffer } catch (err) { preserveDrawingBuffer = null }
  const grab = (name) => {
    if (!canvas || preserveDrawingBuffer !== true) return
    try { shots[name] = canvas.toDataURL('image/png') } catch (err) { /* reported as PENDING */ }
  }

  let goTick = null
  let clockPrev = afterStart.clock
  let clockMonotonic = true
  let lastNegativeClock = afterStart.clock
  let firstNonNegativeTick = null
  let handedOver = false
  let camPathLength = 0
  let camAngleTravel = 0
  let kartPathLength = 0
  let prevCamPos = null
  let prevPlayerPos = null
  let prevCamFwd = null
  let seamCrossed = false
  let seamTick = null

  grab('lights')

  const prevPos = {}
  for (const k of afterStart.karts) {
    const s = h.kartSnapshot(k.kartId)
    prevPos[k.kartId] = s ? v(s.position.x, s.position.y, s.position.z) : null
  }

  /*
   * The countdown-hold baseline, taken at the tick START was pressed and NOT at
   * the t0 grid capture.
   *
   * Those are different claims and only this one is `countdown-hold`'s. t0 is
   * "where the karts were at page load"; whatever happens between load and the
   * button belongs to whether the game should be simulating at all before a race
   * exists, and `printFacts` already reports that gap in ticks. This check asks
   * the narrower question a player asks: from the moment I pressed START, did
   * anything move before GO?
   */
  const holdBase = {}
  for (const k of afterStart.karts) {
    const s = h.kartSnapshot(k.kartId)
    if (s) holdBase[k.kartId] = { pos: v(s.position.x, s.position.y, s.position.z), speed: s.speed }
  }
  const holdWorst = {}
  for (const id of kartIds) holdWorst[id] = { drift: 0, dY: 0, speed: 0, samples: 0 }
  let holdSamples = 0
  /** Largest throttle any driver COMMANDED during the countdown. See below. */
  let holdCommandPeak = 0
  let windowStartTick = startTick
  const metresThisSecond = {}
  for (const id of kartIds) metresThisSecond[id] = 0
  const stuckWindowEnd = {}

  let tick = startTick
  let guard = 0
  while (tick < horizonTick && guard < 100000) {
    guard++
    await h.stepTicks(TOL.sampleTicks)
    const tel = h.telemetry()
    tick = tel.tick

    // --- the one driver change in this file, and it is after check 4 -------
    if (!handedOver && handoverTick !== null && tick >= handoverTick) {
      h.setDriver(playerId, 'referenceAI')
      handedOver = true
    }

    // --- countdown ---------------------------------------------------------
    if (goTick === null) {
      if (tel.phase === 'racing') {
        goTick = tick
        anchorToGo(goTick)
        // The 1 s displacement windows start counting at GO too, and the metres
        // banked during the countdown are discarded rather than credited: a kart
        // that was correctly held has zero of them and must not be graded on it.
        windowStartTick = tick
        for (const id of kartIds) metresThisSecond[id] = 0
        grab('go')
      } else if (tel.phase === 'countdown') {
        saw('countdown-clock')
        if (tel.clock < clockPrev - 1e-9) clockMonotonic = false
        if (tel.clock >= 0) {
          if (firstNonNegativeTick === null) firstNonNegativeTick = tick
        } else {
          lastNegativeClock = tel.clock
        }
        clockPrev = tel.clock
      }
      if (goTick === null && tick - startTick > TOL.countdownTicksMax) {
        saw('countdown-order')
        bump('countdown-order', tick - startTick,
          `the race stayed in phase '${tel.phase}' for ${tick - startTick} ticks after startRace()`)
        break
      }
    }

    // --- per-kart sample ---------------------------------------------------
    const row = { tick: tick, sinceStart: tick - startTick, phase: tel.phase, clock: tel.clock, karts: [] }
    const positions = {}
    for (const k of tel.karts) {
      const s = h.kartSnapshot(k.kartId)
      if (!s) continue
      const p = v(s.position.x, s.position.y, s.position.z)
      positions[k.kartId] = p
      probe.set(p.x, p.y, p.z)
      track.locate(probe, loc)
      track.sample(loc.t, smp)
      row.karts.push({
        id: k.kartId, speed: s.speed, t: loc.t, lateral: loc.lateral,
        halfWidth: smp.halfWidth, onTrack: loc.onTrack,
        respawns: k.respawns, wallHits: k.wallHits,
        twp: k.ticksWithoutProgress, laps: k.completedLaps,
        pos: p,
      })
      const before = prevPos[k.kartId]
      if (before) metresThisSecond[k.kartId] += len(sub(p, before))
      prevPos[k.kartId] = p
    }

    // --- countdown-hold ----------------------------------------------------
    /*
     * Only samples whose phase READS 'countdown' are graded, so a sample is
     * never blamed for movement that was legitimate. `race.fixedUpdate` flips
     * the phase after the kart loop has already run for that tick, so the last
     * up-to-`sampleTicks` ticks of the countdown land in the first 'racing'
     * sample and are NOT graded here. That is a 0.05 s blind spot at the end and
     * it is stated rather than closed: the failure this check exists for moves
     * karts by metres over three seconds, and closing the window would mean
     * asserting on ticks the harness cannot attribute to a phase.
     */
    if (row.phase === 'countdown') {
      holdSamples++
      for (const r of row.karts) {
        const base = holdBase[r.id]
        if (!base) continue
        const w = holdWorst[r.id]
        /*
         * WHAT THE DRIVER ASKED FOR, WHICH IS WHAT MAKES THIS CHECK NON-VACUOUS.
         *
         * "Nothing moved during the countdown" is satisfied just as well by a
         * gate that holds the field as by a reference AI that commanded nothing
         * at all — and the second one is a broken AI, not a working gate. This
         * check would print an identical green for both.
         *
         * `main.ts` records `lastInput` UNGATED for exactly this reason: it is
         * the driver's command, not the frame the kart received. So a commanded
         * throttle above zero against a kart at 0.000 m/s IS the gate working,
         * observably, and if no kart ever commands anything the check reports
         * itself unmeasured below rather than passing on nothing. Same treatment
         * `cam-seam` gets when the camera never rotates.
         */
        let li = null
        try { li = h.lastInput(r.id) } catch (err) { li = null }
        if (li && typeof li.throttle === 'number' && li.throttle > holdCommandPeak) {
          holdCommandPeak = li.throttle
        }
        const drift = lenXZ(sub(r.pos, base.pos))
        const dY = Math.abs(r.pos.y - base.pos.y)
        const spd = Math.abs(r.speed)
        w.samples++
        if (drift > w.drift) w.drift = drift
        if (dY > w.dY) w.dY = dY
        if (spd > w.speed) w.speed = spd

        saw('countdown-hold', 2)
        if (drift > TOL.countdownDriftM) {
          bump('countdown-hold', drift,
            `kart ${r.id} moved ${f(drift)} m (in plan) from its grid slot ${f((tick - startTick) * STEP, 2)} s ` +
            `after START, with ${f(-tel.clock, 2)} s of countdown still to run — the lights are still on ` +
            `(max ${TOL.countdownDriftM} m)`)
        }
        if (spd > TOL.countdownSpeed) {
          bump('countdown-hold', spd,
            `kart ${r.id} is doing ${f(spd)} m/s at ${f((tick - startTick) * STEP, 2)} s after START, ` +
            `clock ${f(tel.clock, 2)} s — a standing start is standing (max ${TOL.countdownSpeed} m/s)`)
        }
      }
    }

    // --- camera ------------------------------------------------------------
    // Read the LIVE camera each time. `harness.camera` is a getter; caching the
    // object once would survive a rig that swapped it and would report the pose
    // of something nobody renders.
    let cam = null
    try { cam = h.camera } catch (err) { cam = null }
    const playerRow = row.karts.find((r) => r.id === playerId)
    if (cam && playerRow) {
      const cp = v(cam.position.x, cam.position.y, cam.position.z)
      const cf = norm(qrot(cam.quaternion, FWD))
      const ps = h.kartSnapshot(playerId)
      const kf = norm(forwardOf(ps.quaternion))
      const kr = norm(rightOf(ps.quaternion))
      const rel = sub(cp, playerRow.pos)
      const behind = -dot(rel, kf)
      const side = dot(rel, kr)
      track.sample(playerRow.t, smp2)
      const tangentDeg = angDeg(flat(cf), flat(smp2.tangent))

      row.cam = {
        pos: cp, fwd: cf, behind: behind, side: side, tangentDeg: tangentDeg,
        dist: len(rel),
      }

      saw('cam-behind', 2)
      if (behind < TOL.camBehindMin || behind > TOL.camBehindMax) {
        bump('cam-behind', Math.abs(behind - TOL.camBehindMin),
          `t+${f((tick - startTick) * STEP, 2)}s: camera is ${f(behind)} m behind the player ` +
          `(band ${TOL.camBehindMin}..${TOL.camBehindMax} m; negative means it is IN FRONT)`)
      }
      if (Math.abs(side) > TOL.camSideMax) {
        bump('cam-behind', Math.abs(side),
          `t+${f((tick - startTick) * STEP, 2)}s: camera is ${f(side)} m off the player's centreline ` +
          `(max ${TOL.camSideMax} m)`)
      }

      // Tangent agreement is only meaningful while the kart is on the road: off
      // it, the rig deliberately collapses the road weight (`camera.ts:541`) and
      // pointing at the road would be the wrong behaviour.
      if (playerRow.onTrack) {
        saw('cam-tangent')
        if (tangentDeg > TOL.camTangentDeg) {
          bump('cam-tangent', tangentDeg,
            `t+${f((tick - startTick) * STEP, 2)}s: camera looks ${f(tangentDeg, 1)} deg off the track ` +
            `tangent at the player (t=${f(playerRow.t, 4)}, max ${TOL.camTangentDeg} deg)`)
        }
      }

      if (prevCamPos) camPathLength += len(sub(cp, prevCamPos))
      if (prevPlayerPos) kartPathLength += len(sub(playerRow.pos, prevPlayerPos))
      if (prevCamFwd) {
        camAngleTravel += angDeg(cf, prevCamFwd)
        const swing = angDeg(cf, prevCamFwd) / (TOL.sampleTicks * STEP)
        row.cam.swingDegPerSec = swing
        saw('cam-seam')
        if (swing > TOL.camSwingDegPerSec) {
          bump('cam-seam', swing,
            `t+${f((tick - startTick) * STEP, 2)}s: the view swung ${f(swing, 1)} deg/s ` +
            `(max ${TOL.camSwingDegPerSec}); player t=${f(playerRow.t, 4)}`)
        }
      }
      // The t=0 crossing itself. The grid is at t~0.99 and the line is at t=0,
      // so the first wrap of the player's t IS the seam.
      if (prevPlayerPos && !seamCrossed && row.karts.length) {
        const prevT = samples.length ? (samples[samples.length - 1].karts.find((r) => r.id === playerId) || {}).t : null
        if (prevT !== null && prevT !== undefined && prevT > 0.9 && playerRow.t < 0.1) {
          seamCrossed = true
          seamTick = tick
        }
      }
      prevCamPos = cp
      prevPlayerPos = playerRow.pos
      prevCamFwd = cf
    }

    // --- launch marks ------------------------------------------------------
    for (const m of launchMarks) {
      if (m.taken === null && m.tick !== null && tick >= m.tick) {
        // `lastInput` is captured HERE and not at the end of the run. At the end
        // the player has been handed to the reference AI, so reading it then
        // reports the AI's command and reads as "the player was at full throttle
        // and doing 0 m/s", which is a nonsense the report would have printed
        // with a straight face.
        let li = null
        try { li = h.lastInput(playerId) } catch (err) { li = null }
        m.taken = {
          tick: tick,
          karts: row.karts.map((r) => ({ id: r.id, speed: r.speed })),
          playerInput: li ? { throttle: li.throttle, steer: li.steer, brake: li.brake } : null,
        }
      }
    }

    // --- 1-second displacement windows, for the stall gate -----------------
    if (tick - windowStartTick >= Math.round(1 / STEP)) {
      const seconds = (tick - windowStartTick) * STEP
      for (const r of row.karts) {
        // The player is EXPECTED to be stationary until the handover. Gating it
        // before then would be gating the very thing check 4 asserts is correct.
        const exempt = r.id === playerId &&
          (handoverTick === null || tick < handoverTick + Math.round(1 / STEP))
        if (exempt) continue
        // Anchored to GO. Before it, EVERY kart is expected to be stationary and
        // a stall gate that fires on a held grid is grading the countdown.
        if (goTick !== null && tick > goTick + Math.round(1 / STEP) && tick <= stuckEndTick) {
          saw('stuck-motion')
          const metres = metresThisSecond[r.id]
          if (metres < TOL.minMetresPerSecond * seconds) {
            bump('stuck-motion', TOL.minMetresPerSecond * seconds - metres,
              `kart ${r.id} covered ${f(metres)} m in ${f(seconds, 2)} s ending GO+${f((tick - goTick) * STEP, 1)}s ` +
              `(floor ${f(TOL.minMetresPerSecond * seconds)} m); t=${f(r.t, 4)} lateral=${f(r.lateral)}`)
          }
        }
      }
      for (const id of kartIds) metresThisSecond[id] = 0
      windowStartTick = tick
    }

    // --- respawns and wall grinding ---------------------------------------
    // Counters are CUMULATIVE, so they are latched at the end of the window and
    // graded once. Grading them per sample reports the same single respawn 150
    // times and makes a one-off look like a loop.
    if (stuckEndTick !== null && tick <= stuckEndTick) {
      for (const r of row.karts) {
        stuckWindowEnd[r.id] = { respawns: r.respawns, wallHits: r.wallHits }
      }
    }

    // --- the first corner --------------------------------------------------
    if (cornerWindow) {
      const inCorner = row.karts.filter((r) => {
        const t = r.t
        // The window wraps only if it straddles t=0; turn one does not.
        return t >= cornerWindow.from && t <= cornerWindow.end
      })
      for (const r of inCorner) {
        saw('corner-onroad')
        if (!r.onTrack) {
          bump('corner-onroad', Math.abs(r.lateral) - r.halfWidth,
            `kart ${r.id} left the road in turn one: t=${f(r.t, 4)} lateral=${f(r.lateral)} ` +
            `halfWidth=${f(r.halfWidth)} (+${BARRIER_MARGIN} m margin)`)
        }
        saw('corner-flow')
        if (Math.abs(r.speed) < TOL.cornerMinSpeed) {
          bump('corner-flow', TOL.cornerMinSpeed - Math.abs(r.speed),
            `kart ${r.id} was doing ${f(r.speed)} m/s in turn one (floor ${TOL.cornerMinSpeed})`)
        }
      }
      for (let a = 0; a < inCorner.length; a++) {
        for (let b = a + 1; b < inCorner.length; b++) {
          saw('corner-clearance')
          const d = len(sub(inCorner[a].pos, inCorner[b].pos))
          if (d < TOL.cornerMinSeparation) {
            bump('corner-clearance', TOL.cornerMinSeparation - d,
              `karts ${inCorner[a].id} and ${inCorner[b].id} were ${f(d)} m apart in turn one ` +
              `(two footprint radii is ${TOL.gridMinSeparation} m; ${TOL.cornerMinSeparation} m is deep overlap)`)
          }
        }
      }
      if (!cornerWindow.seen) cornerWindow.seen = 0
      cornerWindow.seen += inCorner.length
    }

    samples.push(row)
    if (goTick !== null && tick >= goTick + Math.round(5 / STEP) && !shots.launch) grab('launch')
  }

  // =========================================================================
  // Post-run grading of things that need the whole series
  // =========================================================================

  // ---- countdown ----------------------------------------------------------
  // Split on purpose. "Does the race start at all" and "does it start on time"
  // are different questions with different owners, and rolling them together
  // means a build with a timing bug can never prove that its start-button
  // detector still works.
  saw('countdown-order')
  if (goTick === null) {
    bump('countdown-order', 1,
      `the race never reached phase 'racing' within ${horizonTick - startTick} ticks of startRace()`)
  } else {
    const dt = goTick - startTick
    saw('countdown-timing')
    if (dt < TOL.goTickMin || dt > TOL.goTickMax) {
      bump('countdown-timing', Math.abs(dt - 360),
        `GO landed ${dt} ticks (${f(dt * STEP, 2)} s) after startRace(); a three-beat countdown ` +
        `puts it in ${TOL.goTickMin}..${TOL.goTickMax} ticks`)
    }
    saw('countdown-clock')
    if (!clockMonotonic) {
      bump('countdown-clock', 1, 'IRace.clock went backwards during the countdown')
    }
    // The clock must cross zero AT the phase flip, not before it and not after.
    const atGo = samples.find((s) => s.tick === goTick)
    if (atGo && atGo.clock < -TOL.sampleTicks * STEP - 1e-6) {
      bump('countdown-clock', Math.abs(atGo.clock),
        `phase became 'racing' while the clock was still ${f(atGo.clock)} s`)
    }
    if (firstNonNegativeTick !== null && firstNonNegativeTick < goTick - TOL.sampleTicks) {
      bump('countdown-clock', (goTick - firstNonNegativeTick) * STEP,
        `the clock reached zero ${goTick - firstNonNegativeTick} ticks before the phase became 'racing'`)
    }
    if (lastNegativeClock >= 0) {
      bump('countdown-clock', 1, 'the clock was never observed negative during the countdown')
    }
  }

  // ---- the HUD countdown, as a PROXY for `race:countdown` ------------------
  /*
   * ATTRIBUTED TO ONE ELEMENT, and this is not a detail.
   *
   * The first version matched any DOM text of "3", "2", "1" or "GO!" anywhere on
   * the page and read the countdown as
   *     [3, 1, 2, 1, GO!, 2, 1, 2, 3, 2, 1, 2, 3, ...]
   * because the lap counter and the position indicator are also single digits
   * and they update every time a place changes. The token that is NOT ambiguous
   * is "GO!" — only the countdown writes it — so the element that produced GO!
   * identifies the countdown node, and the sequence is then read off that node
   * alone. Still selector-free: keying on the HUD's class name would turn a
   * cosmetic rename into a countdown failure.
   */
  const hudAll = (window.__gridStartHud || []).filter((e) => e.tick >= startTick - 5)
  const goEntry = hudAll.find((e) => e.text === 'GO!')
  const hudSeq = goEntry
    ? hudAll.filter((e) => e.node === goEntry.node).map((e) => e.text)
    : []
  saw('countdown-hud')
  if (hudAll.length === 0 && goTick !== null) {
    // The race demonstrably started and NOTHING appeared on screen. That is a
    // failure, not an absence of evidence — and it is deliberately keyed on any
    // of the four tokens rather than on "GO!" alone, so that renaming the GO
    // caption is a cosmetic change and not a red gate.
    bump('countdown-hud', 1,
      'the race reached \'racing\' and no countdown text (3 / 2 / 1 / GO!) appeared anywhere on the page')
  } else if (!goEntry) {
    // Tokens appeared but none of them was GO!, so there is no unambiguous node
    // to attribute the sequence to. Unmeasured, not passed: a gate that quietly
    // covers nothing prints the same green as a gate that passed.
    checks['countdown-hud'].measured = 0
  } else {
    const want = ['3', '2', '1', 'GO!']
    const got = hudSeq.slice(0, 4)
    if (got.join(',') !== want.join(',')) {
      bump('countdown-hud', 1,
        `the countdown a player sees was [${hudSeq.join(', ')}]; expected [${want.join(', ')}]`)
    }
  }

  // ---- launch -------------------------------------------------------------
  const launchReport = []
  for (const m of launchMarks) {
    if (!m.taken) continue
    const lo = m.reference * (1 - TOL.launchTolFrac)
    const hi = m.reference * (1 + TOL.launchTolFrac)
    const aiSpeeds = []
    for (const r of m.taken.karts) {
      if (r.id === playerId) {
        saw('launch-player')
        if (Math.abs(r.speed) > TOL.restSpeed) {
          bump('launch-player', Math.abs(r.speed),
            `the player kart is doing ${f(r.speed)} m/s at GO+${m.seconds}s with no input injected; ` +
            `it must be at exactly rest`)
        }
        continue
      }
      aiSpeeds.push(r.speed)
      saw('launch-field')
      if (r.speed < lo || r.speed > hi) {
        bump('launch-field', Math.abs(r.speed - m.reference),
          `kart ${r.id} at GO+${m.seconds}s: ${f(r.speed, 2)} m/s against a reference of ` +
          `${m.reference} m/s (band ${f(lo, 2)}..${f(hi, 2)})`)
      }
    }
    aiSpeeds.sort((a, b) => a - b)
    launchReport.push({
      seconds: m.seconds, reference: m.reference,
      min: aiSpeeds[0], max: aiSpeeds[aiSpeeds.length - 1],
      mean: aiSpeeds.reduce((a, b) => a + b, 0) / (aiSpeeds.length || 1),
      band: [lo, hi],
      player: (m.taken.karts.find((r) => r.id === playerId) || {}).speed,
      playerInput: m.taken.playerInput,
    })
  }
  // Monotone acceleration is threshold-free and catches a field that launches
  // and then stalls, which the three point checks above can straddle.
  if (launchMarks.length === 3 && launchMarks.every((m) => m.taken)) {
    for (const id of aiIds) {
      const a = (launchMarks[0].taken.karts.find((r) => r.id === id) || {}).speed
      const b = (launchMarks[1].taken.karts.find((r) => r.id === id) || {}).speed
      const c = (launchMarks[2].taken.karts.find((r) => r.id === id) || {}).speed
      if (a === undefined || b === undefined || c === undefined) continue
      saw('launch-field')
      if (!(b > a && c > b)) {
        bump('launch-field', 1,
          `kart ${id} did not keep accelerating: ${f(a, 2)} -> ${f(b, 2)} -> ${f(c, 2)} m/s ` +
          `at 1 / 4 / 8 s`)
      }
    }
  }

  // ---- respawns and wall grinding, graded once on the latched counters -----
  const stallReport = []
  for (const id of kartIds) {
    const end = stuckWindowEnd[id]
    if (!end) continue
    saw('stuck-respawn', 2)
    const dResp = end.respawns - (respawnsAtStart[id] || 0)
    const dWall = end.wallHits - (wallHitsAtStart[id] || 0)
    stallReport.push({ id: id, respawns: dResp, wallHits: dWall })
    if (dResp > TOL.maxRespawns) {
      bump('stuck-respawn', dResp,
        `kart ${id} respawned ${dResp} time(s) inside the first ${TOL.stuckWindowSeconds} s`)
    }
    if (dWall > TOL.maxWallHits) {
      bump('stuck-respawn', dWall,
        `kart ${id} hit a wall ${dWall} time(s) inside the first ${TOL.stuckWindowSeconds} s ` +
        `(budget ${TOL.maxWallHits})`)
    }
  }

  // ---- camera follow ------------------------------------------------------
  saw('cam-follows')
  if (kartPathLength < TOL.camFollowMinKartPath) {
    // Not gated: with the player at rest the ratio has no meaning. Reported.
    checks['cam-follows'].measured = 0
  } else {
    const ratio = camPathLength / kartPathLength
    if (ratio < TOL.camFollowRatio) {
      bump('cam-follows', TOL.camFollowRatio - ratio,
        `the camera travelled ${f(camPathLength, 1)} m while the player travelled ` +
        `${f(kartPathLength, 1)} m — a ratio of ${f(ratio, 3)}, floor ${TOL.camFollowRatio}. ` +
        `A chase camera travels what the kart travels.`)
    }
  }

  /*
   * A DETACHED CAMERA MAKES cam-seam VACUOUS, AND A VACUOUS PASS IS THE WORST
   * OUTPUT AN INSTRUMENT CAN PRODUCE.
   *
   * cam-seam caps the angular RATE of the view. A camera that never rotates has
   * a rate of exactly zero and sails through it — so on the build that shipped
   * the detached-camera bug, cam-seam printed `PASS 519 assertions` while
   * proving nothing whatsoever. That is the same shape as the first smoke.mjs,
   * whose sabotage never touched the drawing buffer.
   *
   * The condition is angular travel and not path length, because the quantity
   * being capped is angular: a camera bolted to a moving kart with a frozen
   * ORIENTATION would also make this check vacuous while travelling hundreds of
   * metres.
   */
  if (camAngleTravel < 1) checks['cam-seam'].measured = 0

  /*
   * The same treatment for countdown-hold, and for the same reason: a gate that
   * holds a field nobody was driving has not been shown to hold anything. If no
   * driver commanded throttle at any point in the countdown, every "the kart did
   * not move" assertion above is true for a reason that has nothing to do with
   * the gate, so they are reported as unmeasured rather than as a pass.
   */
  if (holdCommandPeak <= 0) checks['countdown-hold'].measured = 0

  // ---- ticksWithoutProgress behaves --------------------------------------
  /*
   * NOT GATED ON ITS VALUE, per the header and per `autoplay.mjs:397-416`.
   *
   * AND A CORRECTION TO THE FOLKLORE, which this harness measured rather than
   * assumed. The grid does not latch `bestProgress` at the lights. It latches it
   * at the START LINE. The back row sits at t = 0.9834 and the front row at
   * 0.9963, so for the ~27 m and ~2.5 s it takes to reach the line every kart is
   * genuinely GAINING progress (0.9834 -> 0.9999) and `ticksWithoutProgress`
   * legitimately resets on almost every tick. Only after the wrap to t = 0.00
   * does the latch engage and the counter start its lap-long climb.
   *
   * The first version of this check called a reset-without-a-lap "impossible"
   * and fired on all eight karts of a healthy field. It was wrong, and the run
   * that proved it wrong is the reason the rule below is about the counter's
   * RATE rather than its value:
   *
   *   1. Between two samples the counter either reset (it is at or below the
   *      sample width, so progress was made inside the window) or it advanced by
   *      EXACTLY the tick delta. A counter that advances at any other rate is
   *      not counting ticks.
   *   2. Somewhere in the field, somebody's counter must exceed 2 s. Once ANY
   *      kart crosses the line, `bestProgress` cannot be beaten again until it
   *      is 99% of the way round, and a lap is far longer than 2 s. A counter
   *      frozen at zero never reaches it — which is the failure a stall gate
   *      cannot survive, because a frozen counter reports a healthy field for
   *      ever.
   */
  const TWP_MIN_PEAK = 240
  const twpReport = []
  let twpPeakAcrossField = 0
  for (const id of kartIds) {
    const series = samples
      .map((s) => ({ tick: s.tick, r: s.karts.find((r) => r.id === id) }))
      .filter((e) => e.r && typeof e.r.twp === 'number')
    if (series.length < 3) continue
    let resets = 0
    let peak = 0
    for (let i = 0; i < series.length; i++) {
      const twp = series[i].r.twp
      if (twp > peak) peak = twp
      saw('progress-counter')
      if (!isFinite(twp) || twp < 0 || twp !== Math.floor(twp)) {
        bump('progress-counter', 1, `kart ${id}: ticksWithoutProgress is ${twp}, not a non-negative integer`)
        continue
      }
      if (i === 0) continue
      const dt = series[i].tick - series[i - 1].tick
      const d = twp - series[i - 1].r.twp
      if (twp <= dt) { resets++; continue }
      if (d !== dt) {
        bump('progress-counter', Math.abs(d - dt),
          `kart ${id}: ticksWithoutProgress moved ${d} over ${dt} ticks without resetting; ` +
          `a tick counter moves by the tick delta or it resets`)
      }
    }
    if (peak > twpPeakAcrossField) twpPeakAcrossField = peak
    twpReport.push({
      id: id, first: series[0].r.twp, last: series[series.length - 1].r.twp,
      peak: peak, elapsed: series[series.length - 1].tick - series[0].tick, resets: resets,
    })
  }
  if (twpReport.length) {
    saw('progress-counter')
    if (twpPeakAcrossField < TWP_MIN_PEAK) {
      bump('progress-counter', TWP_MIN_PEAK - twpPeakAcrossField,
        `no kart's ticksWithoutProgress was ever seen above ${twpPeakAcrossField} ticks. Once a kart ` +
        `crosses the line bestProgress is latched for a whole lap, so the counter must climb past ` +
        `${TWP_MIN_PEAK} ticks (2 s). It did not, so it is not counting.`)
    }
  }

  // ---- did anything actually reach the corner? ---------------------------
  if (!cornerWindow) {
    checks['corner-onroad'].measured = 0
    checks['corner-clearance'].measured = 0
    checks['corner-flow'].measured = 0
  }

  const finalTel = h.telemetry()
  return {
    facts: {
      kartCount: kartIds.length,
      playerKartId: playerId,
      trackLength: track.length,
      simulationStepLive: null,
      t0Tick: t0.tick,
      t0Phase: t0.phase,
      preStartTick: preStartTick,
      preStartPhase: prePhase,
      preStartClock: preClock,
      startTick: startTick,
      goTick: goTick,
      goTicksAfterStart: goTick === null ? null : goTick - startTick,
      handoverTick: handoverTick,
      handedOver: handedOver,
      horizonTick: horizonTick,
      endTick: finalTel.tick,
      endPhase: finalTel.phase,
      seamCrossed: seamCrossed,
      seamTick: seamTick,
      camPathLength: camPathLength,
      camAngleTravel: camAngleTravel,
      kartPathLength: kartPathLength,
      preserveDrawingBuffer: preserveDrawingBuffer,
      canvas: canvas ? { w: canvas.width, h: canvas.height } : null,
      sabotageError: window.__gridStartSabotageError || null,
      sabotageApplied: window.__gridStartSabotageApplied || null,
      playerLastInput: h.lastInput(playerId),
      gridSlots: slots.map((s) => ({ i: s.i, t: s.t, lateral: s.lateral, halfWidth: s.halfWidth, headingDeg: s.headingDeg })),
      grid: gridReport,
      corner: cornerWindow
        ? { from: cornerWindow.from, start: cornerWindow.start, end: cornerWindow.end,
            radius: cornerWindow.radius, samplesInside: cornerWindow.seen || 0 }
        : null,
      launch: launchReport,
      countdownHold: {
        samples: holdSamples,
        commandPeak: holdCommandPeak,
        karts: kartIds.map((id) => ({
          id: id, drift: holdWorst[id].drift, dY: holdWorst[id].dY,
          speed: holdWorst[id].speed, samples: holdWorst[id].samples,
        })),
      },
      twp: twpReport,
      stall: stallReport,
      hud: hudSeq,
      hudUnfiltered: hudAll.map((e) => e.text),
    },
    checks: CHECK_IDS.map((id) => checks[id]),
    // Trimmed to twice a second; the full series is what the checks already
    // consumed, and returning 480 frames of eight karts helps nobody read it.
    series: samples
      .filter((s, i) => i % Math.max(1, Math.round(0.5 / (TOL.sampleTicks * STEP))) === 0)
      .map((s) => ({
        sinceStart: +(s.sinceStart * STEP).toFixed(2),
        phase: s.phase,
        clock: +s.clock.toFixed(3),
        cam: s.cam
          ? { behind: +s.cam.behind.toFixed(2), side: +s.cam.side.toFixed(2),
              tangentDeg: +s.cam.tangentDeg.toFixed(1),
              swing: s.cam.swingDegPerSec === undefined ? null : +s.cam.swingDegPerSec.toFixed(1) }
          : null,
        karts: s.karts.map((r) => ({
          id: r.id, v: +r.speed.toFixed(2), t: +r.t.toFixed(4), lat: +r.lateral.toFixed(2),
          on: r.onTrack, twp: r.twp,
        })),
      })),
    shots: shots,
  }
}

// ---------------------------------------------------------------------------
// Sabotage. Installed from an init script BEFORE the game finishes booting, so
// the battery above contains no branch that knows a sabotage exists.
//
// Every sabotage damages the real running game. The three channels are:
//
//   1. `kartSnapshot(id)` hands back the LIVE `KartState` (`main.ts:955`), whose
//      `position` and `quaternion` are the objects the physics integrates. This
//      violates the contract's deep-copy promise, and the violation is the only
//      route a harness has to move a kart without `seek`. If someone fixes it,
//      these sabotages stop applying and are reported as MISSes rather than
//      passing quietly — which is the correct outcome, because the instrument
//      would genuinely have lost its self-test.
//
//   2. `stepTicks` is a writable property on the harness object. Wrapping it
//      gives a post-tick hook: the game computes its pose, the sabotage damages
//      it, and the battery measures the damage. That is the same input to the
//      detector as a rig that produced the wrong pose itself, and it is the only
//      way to make the camera lie without editing `src/`, which this file may
//      not do.
//
//   3. The real `startRace`, `setDriver` and `telemetry` are replaced with
//      honestly-wrong versions of themselves.
// ---------------------------------------------------------------------------

function gridStartSabotage(spec) {
  const h = window.__harness
  const V3 = h.track.group.position.constructor
  const step0 = h.stepTicks.bind(h)
  const tel0 = h.telemetry.bind(h)
  const start0 = h.startRace.bind(h)

  /**
   * Run `fn` after every underlying `stepTicks`, once `IRace.clock` has reached
   * `fromClock` (negative through the countdown, 0 at GO, so `null` means "from
   * the moment START is pressed"). The battery reads the camera and the karts
   * immediately after its own `stepTicks` returns, so this lands exactly in
   * between: the game computes its state, the sabotage damages it, the detector
   * measures the damage. That is the same input to the detector as a game that
   * produced the damaged state itself.
   */
  const afterEachStep = (fromClock, fn) => {
    h.stepTicks = async (n) => {
      await step0(n)
      const t = tel0()
      if (t.phase === 'idle') return
      if (fromClock !== null && t.clock < fromClock) return
      try { fn(t) } catch (err) { window.__gridStartSabotageError = String((err && err.message) || err) }
    }
  }

  const player = () => h.kartSnapshot(h.playerKartId)
  const smp = {
    position: new V3(), tangent: new V3(), normal: new V3(), right: new V3(),
    halfWidth: 0, bank: 0, curvature: 0,
  }
  const loc = { t: 0, lateral: 0, height: 0, onTrack: false, checkpointIndex: 0 }

  if (spec.kind === 'grid-overlap') {
    // Kart 3 parked inside kart 2. `grid-karts` owns "not overlapping another".
    const a = h.kartSnapshot(2)
    const b = h.kartSnapshot(3)
    if (!a || !b) return { applied: false, why: 'no karts 2 and 3' }
    b.position.set(a.position.x + 0.2, a.position.y, a.position.z + 0.2)
  } else if (spec.kind === 'grid-offroad') {
    // Kart 5 shoved out past the barrier line before anybody looks.
    const k = h.kartSnapshot(5)
    if (!k) return { applied: false, why: 'no kart 5' }
    h.track.locate(k.position, loc)
    h.track.sample(loc.t, smp)
    const push = smp.halfWidth + 5
    k.position.set(
      k.position.x + smp.right.x * push,
      k.position.y + smp.right.y * push,
      k.position.z + smp.right.z * push,
    )
  } else if (spec.kind === 'camera-placeholder') {
    /*
     * THE SHIPPED BUG, reproduced at the exact surface it shipped on.
     *
     * `main.ts:132-134` built a placeholder dolly at the world origin looking
     * down -Z, rendered THAT, and returned it from `harness.camera`, while
     * `cameraRig.follow` drove a different camera nobody ever drew. The start
     * straight runs at START_BEARING = 88.2 deg, i.e. very nearly +X, so the
     * player got a static sideways view of an empty road with the grid behind
     * the lens. This is that, byte for byte.
     */
    const dolly = h.camera.clone()
    dolly.position.set(0, 2.3, 0)
    dolly.up.set(0, 1, 0)
    dolly.lookAt(0, 3.2, -40)
    dolly.updateMatrixWorld(true)
    Object.defineProperty(h, 'camera', { get: () => dolly, configurable: true })
  } else if (spec.kind === 'camera-sideways') {
    // Correct position, correct follow, view yawed 90 deg. Isolates cam-tangent.
    afterEachStep(null, () => { h.camera.rotateY(Math.PI / 2) })
  } else if (spec.kind === 'camera-beside') {
    // Beside the kart, still looking down the road. Isolates cam-behind.
    afterEachStep(null, () => {
      const p = player()
      if (!p) return
      h.track.locate(p.position, loc)
      h.track.sample(loc.t, smp)
      const cam = h.camera
      cam.position.set(
        p.position.x + smp.right.x * 8,
        p.position.y + smp.right.y * 8 + 2.5,
        p.position.z + smp.right.z * 8,
      )
      cam.lookAt(
        p.position.x + smp.right.x * 8 + smp.tangent.x * 30,
        p.position.y + smp.right.y * 8 + 2.5 + smp.tangent.y * 30,
        p.position.z + smp.right.z * 8 + smp.tangent.z * 30,
      )
      cam.updateMatrixWorld(true)
    })
  } else if (spec.kind === 'camera-frozen') {
    // The camera stops following once the kart is moving. Owns cam-follows.
    let held = null
    afterEachStep(0.5, () => {
      const cam = h.camera
      if (!held) { held = { p: cam.position.clone(), q: cam.quaternion.clone() }; return }
      cam.position.copy(held.p)
      cam.quaternion.copy(held.q)
      cam.updateMatrixWorld(true)
    })
  } else if (spec.kind === 'camera-whip') {
    // A discontinuity in the view, of the size a mishandled seam produces.
    afterEachStep(4, () => {
      h.camera.rotateY(25 * Math.PI / 180)
      h.camera.updateMatrixWorld(true)
    })
  } else if (spec.kind === 'no-start') {
    // The START button does nothing. This is a real shipped bug class: CLAUDE.md
    // records a pause menu that permanently ended the race, elsewhere.
    h.startRace = () => {}
  } else if (spec.kind === 'clock-clamped') {
    // The race reports a clock that never goes negative — the countdown has no
    // time coordinate a HUD or a harness can read.
    h.telemetry = () => {
      const t = tel0()
      return {
        sinceTick: t.sinceTick, tick: t.tick, phase: t.phase,
        clock: Math.max(0, t.clock), karts: t.karts,
      }
    }
  } else if (spec.kind === 'countdown-drive') {
    /*
     * THE BUG A HUMAN FOUND, REPRODUCED AT THE SURFACE IT SHIPPED ON.
     *
     * The real defect was that `main.ts:driverFrame` handed every driver's frame
     * to `IKart.step` on every tick without ever reading `IRace.phase`, so the
     * player and the seven AI karts drove off during 3-2-1. This file may not
     * edit `src/`, so it reproduces the OUTCOME: one kart rolling forward while
     * the lights are still on.
     *
     * Velocity is REWRITTEN every step rather than nudged once, because the
     * chassis damps a one-off impulse away in a few ticks and a detector proven
     * only against a transient is not proven against a kart that is genuinely
     * driving. Position therefore drifts (the primary rail) and `speed` reads
     * non-zero (the secondary rail), which is both halves of `countdown-hold`.
     *
     * 0.5 m/s is chosen to be unambiguous against a 0.05 m/s gate and harmless
     * to `launch-field`: over a three-second countdown it is 1.5 m of head
     * start, and the t+1s launch band is 2.4..5.6 m/s wide.
     */
    afterEachStep(null, (t) => {
      if (t.phase !== 'countdown') return
      const k = h.kartSnapshot(4)
      if (!k) return
      h.track.locate(k.position, loc)
      h.track.sample(loc.t, smp)
      k.velocity.set(smp.tangent.x * 0.5, k.velocity.y, smp.tangent.z * 0.5)
      k.position.set(
        k.position.x + smp.tangent.x * 0.5 * (1 / 120),
        k.position.y,
        k.position.z + smp.tangent.z * 0.5 * (1 / 120),
      )
    })
  } else if (spec.kind === 'field-asleep') {
    // Nobody launches.
    const t = tel0()
    for (const k of t.karts) if (k.kartId !== h.playerKartId) h.setDriver(k.kartId, 'idle')
  } else if (spec.kind === 'one-kart-asleep') {
    // ONE kart does not launch. Proves the gate is per-kart and not an average.
    h.setDriver(4, 'idle')
  } else if (spec.kind === 'player-driven') {
    // The player kart is not at rest. Proves `launch-player` is not inert — a
    // check that asserts "expected zero" is exactly the shape of check that
    // quietly passes for ever without anyone noticing it stopped measuring.
    h.setDriver(h.playerKartId, 'referenceAI')
  } else if (spec.kind === 'kart-wedged') {
    // Kart 6 pinned from 3 s after GO: wedged on something, in the first 15 s.
    let held = null
    afterEachStep(3, () => {
      const k = h.kartSnapshot(6)
      if (!k) return
      if (!held) { held = k.position.clone(); return }
      k.position.copy(held)
      k.velocity.set(0, 0, 0)
    })
  } else if (spec.kind === 'corner-offroad') {
    // Kart 2 pushed off the road, but only inside turn one.
    afterEachStep(null, () => {
      const k = h.kartSnapshot(2)
      if (!k) return
      h.track.locate(k.position, loc)
      if (loc.t < 0.04 || loc.t > 0.12) return
      h.track.sample(loc.t, smp)
      const push = smp.halfWidth + 6 - loc.lateral
      k.position.set(
        k.position.x + smp.right.x * push,
        k.position.y + smp.right.y * push,
        k.position.z + smp.right.z * push,
      )
    })
  } else if (spec.kind === 'corner-pileup') {
    // Two karts inside each other, but only inside turn one.
    afterEachStep(null, () => {
      const a = h.kartSnapshot(1)
      const b = h.kartSnapshot(3)
      if (!a || !b) return
      h.track.locate(a.position, loc)
      if (loc.t < 0.04 || loc.t > 0.12) return
      b.position.set(a.position.x + 0.15, a.position.y, a.position.z + 0.15)
    })
  } else if (spec.kind === 'progress-frozen') {
    // The stall counter stops counting. A frozen counter reports a permanently
    // healthy field for ever, which is the worst possible failure in a gate.
    h.telemetry = () => {
      const t = tel0()
      return {
        sinceTick: t.sinceTick, tick: t.tick, phase: t.phase, clock: t.clock,
        karts: t.karts.map((k) => ({
          kartId: k.kartId, driftAttempts: k.driftAttempts, driftReleases: k.driftReleases,
          boostSecondsBySource: k.boostSecondsBySource, respawns: k.respawns, wallHits: k.wallHits,
          lapTimes: k.lapTimes, bestLap: k.bestLap, finished: k.finished,
          completedLaps: k.completedLaps, lastCheckpoint: k.lastCheckpoint,
          t: k.t, lateral: k.lateral, ticksWithoutProgress: 0,
        })),
      }
    }
  } else if (spec.kind === 'hud-silent') {
    // The countdown a player sees never appears.
    window.__gridStartHudMuted = true
  } else {
    return { applied: false, why: `unknown sabotage ${spec.kind}` }
  }

  void start0
  window.__gridStartSabotageApplied = spec.kind
  return { applied: true }
}

// ---------------------------------------------------------------------------
// The init script. Runs before any page script; captures the grid at the first
// frame `window.__harness` exists, installs the sabotage if there is one, and
// records the countdown a player actually sees.
// ---------------------------------------------------------------------------

function gridStartInit(cfg) {
  window.__gridStartHud = []

  /*
   * WHY THE GRID IS CAPTURED HERE AND NOT IN THE BATTERY.
   *
   * `main.ts:682` steps every kart on every tick with no phase guard and the AI
   * karts default to 'referenceAI', so the field is driving before START is
   * pressed. Waiting for `ready` plus a Playwright round trip costs 30-80 ticks
   * of that, and the amount depends on how busy the machine is — which is the
   * exact machine-dependence the contract's CLOCK section forbids a measurement
   * from having. Polling rAF from document start captures at tick 0-2 instead.
   * The tick it landed on is returned and printed either way.
   */
  const poll = () => {
    const h = window.__harness
    if (!h || !h.track || !h.track.startGrid || !h.track.startGrid.length) {
      requestAnimationFrame(poll)
      return
    }
    if (cfg.sabotage && typeof window.__gridStartSabotage === 'function') {
      try {
        window.__gridStartSabotageResult = window.__gridStartSabotage(cfg.sabotage)
      } catch (err) {
        window.__gridStartSabotageError = String((err && err.message) || err)
      }
    }
    try {
      const tel = h.telemetry()
      const karts = []
      for (let i = 0; i < tel.karts.length; i++) {
        const id = tel.karts[i].kartId
        const s = h.kartSnapshot(id)
        if (!s) continue
        karts.push({
          id: id,
          slotIndex: i % h.track.startGrid.length,
          pos: { x: s.position.x, y: s.position.y, z: s.position.z },
          quat: { x: s.quaternion.x, y: s.quaternion.y, z: s.quaternion.z, w: s.quaternion.w },
          speed: s.speed,
          grounded: s.grounded,
        })
      }
      window.__gridStartT0 = { tick: tel.tick, phase: tel.phase, clock: tel.clock, karts: karts }
    } catch (err) {
      window.__gridStartT0Error = String((err && err.message) || err)
      requestAnimationFrame(poll)
    }
  }
  requestAnimationFrame(poll)

  /*
   * The countdown a player sees. `race:countdown` cannot be subscribed to —
   * `HarnessAPI` exposes no `EventBus` — so this watches the DOM for the text
   * the HUD writes in response to it. It is a PROXY and it is labelled as one
   * everywhere it is reported. Selector-free on purpose: keying on the HUD's
   * class name would make a cosmetic rename look like a countdown failure.
   */
  let nodeSeq = 0
  const lastByNode = {}
  const record = (owner, text) => {
    if (window.__gridStartHudMuted) return
    const clean = String(text).trim()
    if (!/^(3|2|1|GO!?)$/.test(clean)) return
    // Give each writing element a stable id so the reader can attribute the
    // sequence to ONE node. The lap counter and the position indicator are also
    // single digits; without this the countdown reads as noise.
    if (!owner.__gridStartNodeId) owner.__gridStartNodeId = ++nodeSeq
    const id = owner.__gridStartNodeId
    if (lastByNode[id] === clean) return
    lastByNode[id] = clean
    let tick = -1
    try { tick = window.__harness.telemetry().tick } catch (err) { /* pre-boot */ }
    window.__gridStartHud.push({ text: clean, tick: tick, node: id })
  }
  const scan = (node) => {
    if (!node) return
    if (node.nodeType === 3) {
      if (node.parentElement) record(node.parentElement, node.data)
      return
    }
    if (node.nodeType !== 1) return
    if (node.children && node.children.length === 0) record(node, node.textContent)
  }
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') scan(r.target)
      else if (r.addedNodes) for (let i = 0; i < r.addedNodes.length; i++) scan(r.addedNodes[i])
    }
  })
  const attach = () => {
    if (!document.body) { requestAnimationFrame(attach); return }
    observer.observe(document.body, { subtree: true, childList: true, characterData: true })
  }
  attach()
}
/* eslint-enable */

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/**
 * Each sabotage names the ONE check that owns the failure it constructs, and how
 * far the run has to get before that owner can possibly have an opinion. Other
 * checks firing as well is recorded but is not the evidence — "something went
 * red" is not the same claim as "the detector for this failure fired".
 *
 * `horizon` is SECONDS AFTER `startRace()`, not after GO, because it bounds the
 * run and the run has to be bounded on a build where GO never arrives — see
 * `no-start`. Every horizon that has to reach racing time therefore carries the
 * ~3.05 s countdown inside it, and the ones below grew by 3 when the countdown
 * gate landed: before it, the field was already at speed when the lights went
 * out, so a horizon of 9 bought nine seconds of driving. It now buys six.
 */
const SABOTAGES = [
  { kind: 'grid-overlap', owner: 'grid-karts', horizon: 2,
    what: 'kart 3 parked inside kart 2 on the grid' },
  { kind: 'grid-offroad', owner: 'grid-karts', horizon: 2,
    what: 'kart 5 shoved past the barrier line before the lights' },
  { kind: 'camera-placeholder', owner: 'cam-tangent', horizon: 5,
    what: 'THE SHIPPED BUG: harness.camera is a static dolly at the origin looking down -Z' },
  { kind: 'camera-sideways', owner: 'cam-tangent', horizon: 5,
    what: 'the view yawed 90 deg, position and follow untouched' },
  { kind: 'camera-beside', owner: 'cam-behind', horizon: 5,
    what: 'the camera moved 8 m to the kart\'s right, still looking down the road' },
  { kind: 'camera-frozen', owner: 'cam-follows', horizon: 21,
    what: 'the camera stops following once the kart moves' },
  { kind: 'camera-whip', owner: 'cam-seam', horizon: 8,
    what: 'a 25 deg discontinuity in the view every 0.05 s' },
  { kind: 'no-start', owner: 'countdown-order', horizon: 12,
    what: 'the START button does nothing' },
  { kind: 'clock-clamped', owner: 'countdown-clock', horizon: 5,
    what: 'IRace.clock never reports a negative value' },
  { kind: 'countdown-drive', owner: 'countdown-hold', horizon: 5,
    what: 'kart 4 rolls forward at 0.5 m/s while the lights are still on' },
  { kind: 'field-asleep', owner: 'launch-field', horizon: 12,
    what: 'no AI kart launches' },
  { kind: 'one-kart-asleep', owner: 'launch-field', horizon: 12,
    what: 'exactly one AI kart does not launch' },
  { kind: 'player-driven', owner: 'launch-player', horizon: 8,
    what: 'the player kart is driven, so it is not at rest with no input' },
  { kind: 'kart-wedged', owner: 'stuck-motion', horizon: 19,
    what: 'kart 6 pinned in place from 3 s in' },
  { kind: 'progress-frozen', owner: 'progress-counter', horizon: 9,
    what: 'ticksWithoutProgress frozen at zero' },
  { kind: 'corner-offroad', owner: 'corner-onroad', horizon: 17,
    what: 'kart 2 pushed off the road, but only inside turn one' },
  { kind: 'corner-pileup', owner: 'corner-clearance', horizon: 17,
    what: 'karts 1 and 3 inside each other, but only inside turn one' },
  { kind: 'hud-silent', owner: 'countdown-hud', horizon: 5,
    what: 'the countdown a player sees never appears' },
]

const BLOCKED_WHY = {
  NO_HARNESS: '`window.__harness` is absent.',
  NO_T0_CAPTURE:
    'the init-script grid capture never ran, so the state of the grid at t=0 was never observed. ' +
    'Nothing downstream of it can be trusted.',
  NO_TRACK: '`__harness.track` is absent. Nothing about the grid can be located without it.',
  TRACK_PENDING: '`__harness.track` refused honestly.',
  NO_START_GRID: '`ITrack.startGrid` is empty. There is no grid to check.',
  NO_CAMERA: '`__harness.camera` is absent or is not a camera.',
  CAMERA_PENDING: '`__harness.camera` refused honestly.',
}

/**
 * `lib/browser.mjs:openGame` is the shared opener and this is the same code with
 * one addition: an init script, which `openGame` has no parameter for. That is
 * the only reason it is duplicated here, and it is the contract-surface ask at
 * the bottom of the run.
 */
async function openRun(browser, baseUrl, { sabotage, viewport }) {
  const page = await browser.newPage({ viewport })

  const consoleErrors = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push(String(e)))

  await page.addInitScript({ content: `window.__gridStartSabotage = ${gridStartSabotage.toString()}` })
  await page.addInitScript(gridStartInit, { sabotage: sabotage ?? null })

  const params = new URLSearchParams()
  params.set('seed', '20260807')
  params.set('quality', 'high')
  // Required for the in-page `toDataURL` grabs; see the header. Without it the
  // screenshots go PENDING and every number is still measured.
  params.set('debug', 'frames')
  const url = `${baseUrl}?${params}`

  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__harness), null, { timeout: 30_000 })
  await page.evaluate(() => window.__harness.ready)

  return { page, consoleErrors, url }
}

function grade(res) {
  return res.checks.filter((c) => c.n > 0)
}

function unmeasured(res) {
  return res.checks.filter((c) => c.n === 0 && c.measured === 0)
}

function writeShots(shots, prefix) {
  const written = []
  for (const [name, dataUrl] of Object.entries(shots ?? {})) {
    const comma = dataUrl.indexOf(',')
    if (comma < 0) continue
    const file = path.join(OUT, `${prefix}-${name}.png`)
    writeFileSync(file, Buffer.from(dataUrl.slice(comma + 1), 'base64'))
    written.push(file)
  }
  return written
}

const fmt = (n, d = 2) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : String(n))

function printFacts(F) {
  const L = []
  L.push(`field        ${F.kartCount} karts, player is #${F.playerKartId}`)
  L.push(`track        ${fmt(F.trackLength, 1)} m centreline`)
  L.push(
    `grid capture tick ${F.t0Tick} (phase '${F.t0Phase}') — the earliest tick this harness can observe. ` +
    `It is still taken from an init script rather than after ready: the capture must not depend on how ` +
    `long the machine took to boot the page, whatever the game does in the meantime.`,
  )
  L.push(
    `start        startRace() at tick ${F.startTick}, phase was '${F.preStartPhase}', clock ` +
    `${fmt(F.preStartClock)} — ${F.startTick - F.t0Tick} tick(s) elapsed between the grid capture and ` +
    `the button; 'grid karts' below is what they cost`,
  )
  L.push(
    F.goTick === null
      ? 'GO           never reached'
      : `GO           tick ${F.goTick}, ${F.goTicksAfterStart} ticks (${fmt(F.goTicksAfterStart / 120)} s) after startRace()`,
  )
  L.push(`countdown    a player saw [${F.hud.join(', ') || '(nothing)'}]   (DOM proxy for race:countdown)`)
  const CH = F.countdownHold
  if (!CH || CH.samples === 0) {
    L.push('countdown hold  NOT MEASURED — no sample of this run ever read phase \'countdown\'')
  } else {
    L.push(
      `countdown hold  worst movement between startRace() and GO, over ${CH.samples} sample(s). ` +
      `Gates: ${TOL.countdownDriftM} m in plan, ${TOL.countdownSpeed} m/s. dY is reported, not gated.`,
    )
    L.push(
      `                peak throttle COMMANDED by any driver during the countdown: ${fmt(CH.commandPeak, 3)}. ` +
      (CH.commandPeak > 0
        ? 'Non-zero, so the karts below were HELD rather than merely undriven — that is the gate working.'
        : 'ZERO, so nothing was asking to move and this check is reported unmeasured, not passed.'),
    )
    for (const g of CH.karts) {
      L.push(
        `  kart ${g.id}   moved ${String(fmt(g.drift, 3)).padStart(8)} m  ` +
        `dY ${String(fmt(g.dY, 3)).padStart(6)} m  peak speed ${String(fmt(g.speed, 3)).padStart(7)} m/s`,
      )
    }
  }
  L.push(
    F.handoverTick === null
      ? 'handover     never scheduled — GO was never reached, so there is no clock to hang it on'
      : `handover     player -> referenceAI at tick ${F.handoverTick} (GO+${TOL.handoverSeconds}s)` +
        `${F.handedOver ? '' : ' (not reached)'}`,
  )
  L.push(`run          ended at tick ${F.endTick}, phase '${F.endPhase}'`)
  L.push('')
  L.push('grid slots   (from ITrack.startGrid, no simulation involved)')
  for (const s of F.gridSlots) {
    L.push(
      `  slot ${s.i}   t=${fmt(s.t, 4)}  lateral=${String(fmt(s.lateral)).padStart(6)} m  ` +
      `halfWidth=${fmt(s.halfWidth)} m  heading off tangent ${fmt(s.headingDeg, 3)} deg`,
    )
  }
  L.push('')
  L.push('grid karts   (as observed at tick ' + F.t0Tick + ')')
  for (const g of F.grid) {
    L.push(
      `  kart ${g.id}   slot ${g.slot}  speed=${String(fmt(g.speed, 4)).padStart(8)} m/s  ` +
      `plan offset ${fmt(g.planOffset, 3)} m  dY ${fmt(g.yOffset, 3)} m  ` +
      `heading ${fmt(g.headingDeg, 2)} deg  lateral ${fmt(g.lateral)}  onTrack=${g.onTrack}`,
    )
  }
  L.push('')
  if (F.corner) {
    L.push(
      `first corner  t=${fmt(F.corner.start, 4)} .. ${fmt(F.corner.end, 4)}, peak radius ` +
      `${fmt(F.corner.radius, 1)} m, entry window opens at t=${fmt(F.corner.from, 4)}; ` +
      `${F.corner.samplesInside} kart-samples were taken inside it`,
    )
  } else {
    L.push('first corner  NOT FOUND — no |curvature| >= 1/170 anywhere on the lap')
  }
  L.push('')
  L.push('launch       reference is measured from the real game, in seconds after GO — NOT after')
  L.push('             startRace(). Anchored to startRace() it graded the countdown as racing time,')
  L.push('             which was only survivable while the field illegally drove through it.')
  for (const l of F.launch) {
    L.push(
      `  GO+${l.seconds}s  AI ${fmt(l.min)} .. ${fmt(l.max)} m/s (mean ${fmt(l.mean)})   ` +
      `reference ${l.reference} m/s, band ${fmt(l.band[0])}..${fmt(l.band[1])}   ` +
      `player ${fmt(l.player, 4)} m/s`,
    )
  }
  const pin = (F.launch[0] || {}).playerInput
  L.push(
    `  the player kart reads exactly ${fmt((F.launch[0] || {}).player, 4)} m/s and THAT IS CORRECT — it is ` +
    `the one stationary kart a reader should expect. Driver mode 'human', nothing injected: ` +
    `lastInput at GO+1s was ${pin ? `throttle ${fmt(pin.throttle)}, brake ${fmt(pin.brake)}, steer ${fmt(pin.steer)}` : 'null'}. ` +
    `It is handed to the reference AI at GO+${TOL.handoverSeconds}s, after every assertion above.`,
  )
  L.push('')
  L.push('camera       ' +
    `path ${fmt(F.camPathLength, 1)} m against a player path of ${fmt(F.kartPathLength, 1)} m` +
    (F.kartPathLength > 0 ? `  (ratio ${fmt(F.camPathLength / F.kartPathLength, 3)})` : '') +
    `; the view rotated ${fmt(F.camAngleTravel, 1)} deg in total`)
  L.push(`seam         player crossed t=0 ${F.seamCrossed ? `at tick ${F.seamTick}` : 'NOT during this run'}`)
  L.push('')
  L.push('respawns / wall hits in the first ' + TOL.stuckWindowSeconds + ' s (cumulative, graded once)')
  L.push('  ' + F.stall.map((s) => `#${s.id} r${s.respawns} w${s.wallHits}`).join('   '))
  L.push('')
  L.push('ticksWithoutProgress — REPORTED, NOT GATED, the same treatment tools/autoplay.mjs:397-416')
  L.push('  gives it. The grid sits before the line at t = 0.983..0.996, so once a kart crosses')
  L.push('  the line bestProgress latches a near-complete lap and a healthy field reads a whole')
  L.push('  lap of "no progress". MEASURED CORRECTION to that folklore: the latch engages at the')
  L.push('  LINE, not at the lights — for the ~27 m before it every kart is genuinely gaining')
  L.push('  progress (0.983 -> 0.9999) and the counter legitimately resets almost every tick.')
  L.push('  What is gated is the counter\'s RATE and its peak, never its value.')
  for (const t of F.twp) {
    L.push(
      `  kart ${t.id}   ${t.first} -> ${t.last}, peak ${t.peak} over ${t.elapsed} ticks, ` +
      `${t.resets} reset(s)`,
    )
  }
  return L.join('\n')
}

let exitCode = 0
const pendings = []
const server = await startServer({ mode: useDev ? 'dev' : 'preview' })
const browser = await launch({})

try {
  // The clean run always happens, self-test or not: a sabotage attributed
  // against an already-red check is not evidence, and the only way to know
  // which checks are already red is to measure them.
  const cleanViewport = { width: 1920, height: 1080 }
  const { page, consoleErrors } = await openRun(browser, server.url, {
    sabotage: null,
    viewport: cleanViewport,
  })

  const opts = {
    tol: TOL,
    simulationStep: SIMULATION_STEP,
    barrierMargin: BARRIER_MARGIN,
    horizonSeconds: TOL.runSeconds,
  }

  const clean = await page.evaluate(battery, opts)

  if (clean.blocked) {
    const why = BLOCKED_WHY[clean.blocked] ?? clean.blocked
    console.log(`PENDING  ${why}${clean.message ? ` (${clean.message})` : ''}`)
    console.log('')
    console.log('Nothing was measured. Exiting non-zero on purpose.')
    process.exitCode = 1
  } else {
    console.log(printFacts(clean.facts))
    console.log('')

    for (const c of clean.checks) {
      if (c.measured === 0 && c.n === 0) {
        console.log(`PENDING  ${c.id.padEnd(18)} nothing was measured — see the PENDING block below`)
      } else if (c.n === 0) {
        console.log(`PASS     ${c.id.padEnd(18)} ${c.measured} assertion(s)`)
      } else {
        console.log(
          `FAIL     ${c.id.padEnd(18)} ${c.n} violation(s) of ${c.measured}, ` +
          `worst ${c.worst === null ? '?' : fmt(c.worst, 3)}`,
        )
        for (const m of c.fails) console.log(`           ${m}`)
        if (c.n > c.fails.length) console.log(`           … and ${c.n - c.fails.length} more`)
      }
    }

    // --- honest PENDINGs ---------------------------------------------------
    pendings.push(
      'race:countdown — `HarnessAPI` exposes no `EventBus`, so the EVENT cannot be subscribed to and ' +
      '"race:countdown fires 3, 2, 1, 0" is not directly assertable. `countdown-hud` watches the DOM for ' +
      'the text the HUD writes in response to it, which is a proxy: it proves a player saw the numbers, ' +
      'not that the payload carried n=3|2|1|0. What is missing is one line — see the CONTRACT block below.',
    )
    if (clean.facts.preserveDrawingBuffer !== true) {
      pendings.push(
        'screenshots — `glReport().preserveDrawingBuffer` is ' +
        `${clean.facts.preserveDrawingBuffer}, so the canvas cannot be read at an exact tick and no ` +
        'in-page screenshot was taken. `?debug=frames` is meant to set it.',
      )
    }
    if (!clean.facts.corner) {
      pendings.push(
        'first corner — no point on the lap has |curvature| >= 1/170, so corner-onroad, ' +
        'corner-clearance and corner-flow validated NOTHING.',
      )
    }
    if (!clean.facts.seamCrossed) {
      pendings.push(
        'the t=0 seam — the player kart never crossed the start line during the run, so the seam ' +
        'clause of cam-seam validated nothing. Only the swing cap did.',
      )
    }
    if (clean.facts.camAngleTravel < 1) {
      pendings.push(
        `cam-seam — the camera's orientation moved a total of ${fmt(clean.facts.camAngleTravel, 3)} deg ` +
        'over the whole run, so the angular-rate cap had nothing to cap and cam-seam is reported as ' +
        'unmeasured rather than as a pass. A camera that never rotates passes a swing gate perfectly.',
      )
    }
    pendings.push(
      'countdown-hold, the PLAYER half — this check proves the countdown gate for the seven AI karts by ' +
      'direct measurement, because they are under a driver that would otherwise drive. The player kart ' +
      'is in mode \'human\' with no keyboard in a headless run, so it reads 0 m/s whether the gate exists ' +
      'or not, and its row of the table is evidence of nothing on its own. It CANNOT be closed with ' +
      '`setInput`: that switches the player to \'scripted\', and \'scripted\' bypasses the countdown gate ' +
      'BY DESIGN (`main.ts:inputReachesKart`) so that a harness which has seized the controls is never ' +
      'silently overridden. Injecting throttle here would therefore measure the bypass, not the gate, ' +
      'and would pass identically on a build with no gate at all — a vacuous pass, which is the worst ' +
      'output an instrument can produce. What covers the player is that the gate is ONE predicate ' +
      'evaluated ahead of the driver-mode switch, so \'human\' and \'referenceAI\' cannot diverge, plus ' +
      'the `countdown-drive` sabotage in --broken. Closing it properly needs a keyboard the harness can ' +
      'press — `HarnessAPI.injectInput`, which this build reports as not available yet.',
    )
    pendings.push(
      'the simultaneous eight-kart first corner — the player kart is correctly stationary through the ' +
      'launch window (that is check 4), so it reaches turn one alone, ~8 s behind the seven AI karts. ' +
      'corner-* therefore grades SEVEN karts arriving together and the eighth arriving separately. ' +
      'Having both a resting player and a player in the pack needs two runs, and a second run needs ' +
      '`resetRace()`, which this file may not call.',
    )
    // Anything still unmeasured that has not already explained itself above.
    const alreadyExplained = new Set(pendings.map((p) => p.split(' ')[0]))
    for (const c of unmeasured(clean)) {
      if (alreadyExplained.has(c.id)) continue
      pendings.push(`${c.id} — the check ran but had nothing to assert against on this build.`)
    }

    const failed = grade(clean)
    if (failed.length) exitCode = 1
    if (consoleErrors.length) {
      console.log(`FAIL     console errors:\n           ${consoleErrors.join('\n           ')}`)
      exitCode = 1
    }

    const shotFiles = writeShots(clean.shots, 'grid-start')
    // The canvas grabs are the 3D at an exact tick; this one is the composited
    // page, which is the only way to see the HUD and the start card.
    const composite = path.join(OUT, 'grid-start-composite.png')
    writeFileSync(composite, await page.screenshot())
    shotFiles.push(composite)

    writeFileSync(path.join(OUT, 'grid-start.json'), JSON.stringify(clean, (k, v) => (k === 'shots' ? undefined : v), 2))

    console.log('')
    console.log('screenshots  (this is a visual bug class — look at them)')
    for (const file of shotFiles) console.log(`  ${file}`)
    console.log(`report       ${path.join(OUT, 'grid-start.json')}`)
  }

  // -------------------------------------------------------------------------
  // Self-test
  // -------------------------------------------------------------------------
  if (selfTest) {
    console.log('\n--- SELF-TEST: sabotaging the real running game -------------------------')
    if (clean.blocked) {
      console.error('SELF-TEST FAILED — the clean run was blocked, so no sabotage can be attributed.')
      process.exitCode = 1
    } else {
      await page.close()
      const cleanFailed = grade(clean).map((c) => c.id)
      const cleanUnmeasuredIds = unmeasured(clean).map((c) => c.id)
      if (cleanFailed.length) {
        console.log(
          `note: the build under test is ALREADY failing [${cleanFailed.join(', ')}]. A sabotage owned by ` +
          'one of those is confounded by the pre-existing failure and is reported as BLOCKED, which is a ' +
          'statement about the build and not about the instrument.',
        )
      }
      if (cleanUnmeasuredIds.length) {
        console.log(
          `note: [${cleanUnmeasuredIds.join(', ')}] measured nothing on the clean run (reported PENDING). ` +
          'A sabotage owned by one of those IS attributable if it fires — no assertions to violations is ' +
          'unconfounded — and is BLOCKED only if it stays silent.',
        )
      }

      const misses = []
      const blocked = []
      for (const sab of SABOTAGES) {
        // A smaller viewport, and only for the self-test. Nothing here is graded
        // on pixels and the simulation is viewport-independent, so this buys a
        // large amount of present cost back across seventeen full page loads.
        const run = await openRun(browser, server.url, {
          sabotage: { kind: sab.kind },
          viewport: { width: 960, height: 540 },
        })
        let broken
        try {
          broken = await run.page.evaluate(battery, { ...opts, horizonSeconds: sab.horizon })
        } finally {
          await run.page.close()
        }

        const applyErr = broken.blocked ? null : broken.facts.sabotageError
        const applied = broken.blocked ? null : broken.facts.sabotageApplied
        if (broken.blocked) {
          misses.push(`${sab.kind}: the run was blocked (${broken.blocked})`)
          console.log(` MISS     ${sab.kind.padEnd(20)} blocked: ${broken.blocked}`)
          continue
        }
        if (applied !== sab.kind) {
          misses.push(`${sab.kind}: could not be applied${applyErr ? ` (${applyErr})` : ''}`)
          console.log(` MISS     ${sab.kind.padEnd(20)} not applied${applyErr ? ` — ${applyErr}` : ''}`)
          continue
        }

        const fired = grade(broken).map((c) => c.id)
        /*
         * BLOCKED is not MISS, and conflating them would be the same mistake as
         * a silent skip.
         *
         * A detector that is ALREADY red on the clean build cannot be
         * attributed: its violations are the shipped bug's, not the sabotage's,
         * and "it is still red" is no evidence at all. That is a statement about
         * the GAME, not about the instrument, and it has a different fix — ship
         * the bug fix, then re-run this. A MISS is a statement about the
         * instrument and means the detector is inert.
         *
         * Both still fail the self-test. An instrument nobody has watched fail
         * is not evidence, whatever the reason nobody could watch it.
         */
        const ownerAlreadyRed = cleanFailed.includes(sab.owner)
        const ownerBlind = cleanUnmeasuredIds.includes(sab.owner)
        // A detector that measured NOTHING on the clean run and fires on the
        // sabotage IS attributable — it went from no assertions to violations,
        // and nothing pre-existing could have produced them. Only an owner that
        // was already RED is confounded.
        const ownerFired = fired.includes(sab.owner) && !ownerAlreadyRed
        const label = ownerFired ? 'CAUGHT  ' : ownerAlreadyRed || ownerBlind ? 'BLOCKED ' : 'MISS    '
        console.log(
          ` ${label} ${sab.kind.padEnd(20)} owner=${sab.owner.padEnd(17)} fired=[${fired.join(', ') || 'nothing'}]`,
        )
        if (ownerFired) {
          /* attributed */
        } else if (ownerAlreadyRed) {
          blocked.push(
            `${sab.kind}: ${sab.owner} is ALREADY red on the clean build, so nothing this sabotage does ` +
            `can be attributed to it. Fix the build, then re-run --broken.`,
          )
        } else if (ownerBlind) {
          blocked.push(
            `${sab.kind}: ${sab.owner} measured NOTHING on the clean build (it reported PENDING), so it ` +
            `has no baseline to be attributed against.`,
          )
        } else {
          misses.push(
            `${sab.kind}: ${sab.owner} did not fire; ${fired.join(', ') || 'nothing'} did. ` +
            `The detector is inert.`,
          )
        }
        if (applyErr) console.log(`           note: the sabotage reported ${applyErr}`)
      }

      const caught = SABOTAGES.length - misses.length - blocked.length
      console.log(`\n${caught} of ${SABOTAGES.length} sabotages were caught by the check that owns them.`)
      if (blocked.length) {
        console.log(`\n${blocked.length} could not be attributed because their owner is not green on this build:`)
        for (const b of blocked) console.log(`  ${b}`)
      }
      if (misses.length) {
        console.error(`\n${misses.length} were NOT caught, and that is an instrument fault:`)
        for (const m of misses) console.error(`  ${m}`)
      }
      if (misses.length || blocked.length) {
        console.error(
          `\nSELF-TEST FAILED — ${misses.length + blocked.length} detector(s) are unproven. ` +
          `${blocked.length} of those are unprovable until the build is green, which is the correct ` +
          `answer and not a reason to relax the gate.`,
        )
        process.exitCode = 1
      } else {
        console.log(
          `\nSELF-TEST PASSED — all ${SABOTAGES.length} sabotages were caught by the check that owns them.`,
        )
        process.exitCode = 0
      }
    }
  } else {
    if (pendings.length) {
      console.log('')
      for (const p of pendings) console.log(`PENDING  ${p}`)
      console.log('(reported, never silently skipped)')
    }
    console.log('')
    console.log('CONTRACT SURFACE THIS HARNESS WOULD USE (not added here — a contract change is the lead\'s):')
    console.log('    // src/types.ts, in HarnessAPI')
    console.log('    /** Subscribe to the real EventBus. Without it `race:countdown` cannot be asserted. */')
    console.log('    on<K extends EventName>(name: K, fn: (p: GameEvents[K]) => void): () => void')
    console.log('')
    console.log('    // and, on ICameraRig, already present but not reachable from the harness:')
    console.log('    readonly swingDegPerSec: number   // cam-seam recomputes this by hand today')
    console.log('')
    if (exitCode === 0) console.log('PASS')
    else {
      console.log('FAIL — the first fifteen seconds are not right. Prove the instrument first:')
      console.log('       node tools/grid-start.mjs --broken')
      process.exitCode = 1
    }
  }
} finally {
  await browser.close()
  await server.stop()
}
