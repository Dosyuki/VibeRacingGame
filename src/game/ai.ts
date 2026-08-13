/**
 * THE REFERENCE AI DRIVER.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THIS IS A MEASURING INSTRUMENT BEFORE IT IS AN OPPONENT.
 *
 * ART_DIRECTION §10c is graded with this file in the loop. Criterion 1 ("a
 * drifting lap is measurably faster than a clean lap") is not a property of the
 * kart alone — it is a comparison between two laps that something has to drive,
 * and if one driver drives both then the difference it reports is the drift's,
 * not the driver's. That is why `AIMode` is an explicit mode on the driver and
 * not a difficulty setting: `'clean'` and `'drift'` are the two arms of the
 * benchmark, and everything else about them is held identical on purpose —
 * same racing line, same look-ahead law, same entry-speed solver, same gains.
 *
 * Criterion 2 (≥60% of drift attempts bank tier 1, ≥25% reach tier 3) is
 * likewise a statement about THIS code's attempts. A driver that spams the
 * drift button on every straight would fail it while the kart's drift ladder
 * was perfect, so an attempt is only started when the corner ahead has been
 * measured to be long enough to bank something.
 *
 * Criterion 6 (every kart finishes three laps unattended) is the reason for the
 * recovery section at the bottom, and the reason nothing here ever calls
 * `IKart.respawn` — respawn is `game/race.ts`'s to own, and an AI that respawns
 * itself out of trouble is precisely the "respawn loop" the criterion forbids.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * STEERING SIGN. This file produces INTENT and nothing else. `steer > 0` means
 * "go right" in world terms, identically to a human's. There is no negation
 * anywhere below, and there must not be one added: the single conversion from
 * intent to yaw torque lives inside `IKart.step`, and a second negation here
 * would make both look correct while only one of them was. Every sign in the
 * steering solve is derived rather than tuned:
 *
 *   - the aim point is transformed into the KART's frame, so a positive
 *     component along the chassis right axis literally means "the place I want
 *     to be is to my right";
 *   - `TrackLocation.lateral` and `ITrack.racingLine` are both already "positive
 *     is the driver's right", per the contract;
 *   - `TrackSample.curvature` is already "positive curves right".
 *
 * All four conventions agree, which is what lets the whole controller be
 * written without a single sign flip. `tools/steer-test.mjs` asserts it.
 *
 * ALLOCATION. `step` is called from `fixedUpdate` and allocates nothing. The
 * `TrackSample` / `TrackLocation` out-objects are per-driver because the
 * contract makes them caller-owned so that two call sites cannot quietly share
 * one; the pure-maths vectors are module scope, which is safe here because
 * nothing `step` calls can re-enter it.
 *
 * DETERMINISM. The only randomness is one `ctx.rngFor` stream, drawn from at
 * construction for the driver's lane preference and at each item pulse. No
 * `Math.random`, no clock of any kind — `step` is handed its own `Seconds` and
 * accumulates from that.
 */

import { SURFACE_PROPS, type Ctx, type IKart, type InputFrame, type ITrack, type Metres, type Seconds } from '../types'
import { Vector3 } from 'three'
import type { TrackLocation, TrackSample } from '../types'

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * The two arms of the §10c criterion-1 benchmark.
 *
 *   `'clean'`  never presses drift. It carries the geometric corner speed and
 *              nothing else, so its lap time is the control.
 *   `'drift'`  arms a drift wherever the corner is long enough to bank a tier,
 *              enters marginally slower to keep the slip angle controllable,
 *              and cashes the release onto the exit.
 *
 * If `'drift'` is not faster, that is a finding about the kart's drift economy,
 * not about this file — and it is reported as such rather than hidden by tuning
 * `'clean'` down until the gap appears.
 */
export type AIMode = 'clean' | 'drift'

export interface AIDriverOptions {
  /** Defaults to `'drift'` — the reference driver races. */
  readonly mode?: AIMode
  /**
   * 0..1, defaults to 1. Scales cornering commitment and look-ahead only. It
   * exists so a field of eight does not drive one identical line into one
   * identical corner; it is NOT a handicap system and 1 is the reference.
   */
  readonly skill?: number
}

export interface AIDriver {
  readonly kartId: number
  /** Switchable at any time; the change takes effect on the next `step`. */
  mode: AIMode
  /**
   * Stable object, rewritten in place each `step`. Read fields; never retain it
   * across a tick — same rule as `IInput.frame`, and for the same reason.
   */
  readonly frame: Readonly<InputFrame>
  /** Drift attempts started since the last `reset`. Telemetry aid for §10c.2. */
  readonly driftAttempts: number
  /** Advance one fixed simulation tick and return the refreshed frame. */
  step(step: Seconds): Readonly<InputFrame>
  /** Clear all controller state. Call on grid reset, not on respawn. */
  reset(): void
}

// ---------------------------------------------------------------------------
// Constants mirrored from the kart, and why that is not an import
// ---------------------------------------------------------------------------
/*
 * Sibling imports are banned and this file does not have one. These four
 * numbers are `kart/`'s and are restated here as the AI's MODEL of the kart,
 * which is a different thing from the kart: they set the GAIN of the steering
 * solve, never its sign or its structure. If `kart/` retunes them the AI
 * over- or under-steers slightly and the closed-loop yaw term below absorbs it;
 * nothing becomes wrong, only slightly softer. Importing them would buy exact
 * agreement at the cost of the one property the contract exists to protect.
 */
const WHEELBASE: Metres = 1.4
const STEER_LOCK = 0.48
const STEER_FADE_SPEED = 34
const STEER_FADE_FLOOR = 0.38
const TOP_SPEED_REFERENCE = 31.5
/** The kart gates drift initiation on this much lock at the rising edge. */
const KART_DRIFT_MIN_STEER = 0.18
const KART_DRIFT_MIN_SPEED = 7
/** Slip angle below which drift charge stops accumulating. */
const KART_DRIFT_SLIP_GATE = 0.095

const G = 9.81

// ---------------------------------------------------------------------------
// Look-ahead
// ---------------------------------------------------------------------------
/**
 * THE LOOK-AHEAD LAW: `d = LOOK_BASE + LOOK_PER_SPEED · v`, clamped.
 *
 * Distance rather than track parameter, because `t` is normalised arc length
 * and a fixed `t` offset silently shortens the horizon on a longer circuit.
 * Affine in speed rather than purely proportional because a purely
 * time-proportional horizon collapses to zero at a standstill and the pursuit
 * solve then divides by nothing — that is the "AI stuck against a wall
 * twitching" failure, and it is a division, not a behaviour.
 *
 * 0.62 s of travel at the low end: short enough that the ideal line's apex is
 * actually cut rather than smoothed away, long enough that the pursuit does not
 * chase its own oscillation. At 30 m/s it reaches 25.6 m, which is about a
 * third of the radius of the tightest corner on the lap.
 */
const LOOK_BASE: Metres = 6.4
const LOOK_PER_SPEED = 0.64
const LOOK_MIN: Metres = 5.5
const LOOK_MAX: Metres = 32

// ---------------------------------------------------------------------------
// The steering solve
// ---------------------------------------------------------------------------
/**
 * Understeer gradient, rad per m/s² of lateral acceleration.
 *
 * A pure bicycle model says the steer angle for a path curvature κ is `L·κ`,
 * which on this kart is 1.9° for the 74 m banked wall — about 4% of lock. Real
 * lap after real lap the tyres need far more than that, because the brush model
 * in `kart/` only reaches peak force at a real slip angle. `δ = (L + K·v²)·κ`
 * is the standard first-order correction and `K = 0.011` puts the required lock
 * at roughly the measured slip reference (0.115 rad) when the tyres are at the
 * limit, which is where the AI intends to be.
 */
const K_UNDERSTEER = 0.011

/**
 * THE CROSS-TRACK WEIGHT, and the frame error it exists to fix.
 *
 * Pure pursuit's chord to an aim point `d` metres down the road carries THREE
 * things added together, and they are not the same size:
 *
 *     dRight  ≈  e  +  ψ·d  +  κ·d²/2
 *                │     │        └─ the road's own bend over the look-ahead
 *                │     └────────── heading error against the line
 *                └──────────────── how far the line is to my right, HERE
 *
 * Only the first term says which side of the racing line the kart is on, and
 * pure pursuit divides the whole sum by d², so that term arrives attenuated by
 * 1/d² while the other two arrive attenuated by 1/d and 1/1. On Vermilion Nine
 * the racing line crosses the road at up to 0.41 m per metre — `world/track.ts`
 * solves it by minimising path curvature, and a minimum-curvature line runs
 * DIAGONALLY across a straight between two corners — so at the 18 m look-ahead
 * the ψ·d term reaches 6 m while the whole road is 8 m wide. The cross-track
 * error is then not a small correction to the sum, it is a rounding error in
 * it, and the command comes out with the sign of the line's drift rather than
 * the sign of the error. Measured: placed 2.5 m either side of the line at
 * t = 0.343, the driver commanded +0.81 and +0.22 — right-hand from both sides,
 * with no negation anywhere and none needed to explain it.
 *
 * So the cross-track error is read a SECOND time, in the frame where it is
 * unambiguous: at the kart's own station, against the line at that station.
 * `laneLateral(loc.t) - loc.lateral` is positive exactly when the line is to
 * the driver's right — `TrackLocation.lateral` says so and `ITrack.racingLine`
 * says so — and a positive value asks for positive steer. That is the same
 * convention as everything else in this file and it is READ, not assumed.
 *
 * 2 makes the term worth 2 m of aim-point offset per metre of error, and it is
 * the LOWEST value the harness supports rather than a preference. Every row
 * below varies K_CROSS and nothing else, on this file, against `steer-test` at
 * its re-sited probe (632ba8c) and a clean-mode field over 150 s:
 *
 *     K_CROSS   ai-command L / R      ai-outcome   field laps   respawns
 *       0       0.2207 / -0.1264      FAIL           2.19          1-2
 *       1       0.4364 / -0.2384      FAIL           1.39          3-5
 *       2       0.6756 / -0.3459      PASS           2.21          1     <- here
 *       2.5     0.7684 / -0.4006      PASS           2.21          1
 *
 * `ai-outcome` — the kart actually converging on the line, which no amount of
 * correct sign substitutes for — is what sets the floor at 2; `ai-command`
 * passes without this term at all once the probe is sited where the line does
 * not move across it. The field column is quoted with `insideCurvature` in
 * place, and it must be: without it the same rows read 2.19 / 1.39 / 1.37 /
 * 1.42, and the term looks like a 37% pace regression. See `insideCurvature`
 * for why the two changes are only correct together.
 *
 * It is a gain, not a sign: getting it wrong makes the driver sloppy, never
 * inverted.
 */
const K_CROSS = 2

/**
 * HOW MUCH ERROR THE CROSS-TRACK TERM IS ALLOWED TO SEE, in metres.
 *
 * The term's job is to decide which side of the line the kart is on and to make
 * it converge — a signal of a metre or two. It is NOT the path follower; pure
 * pursuit is, and pure pursuit is the thing that has to handle a kart 11 m off
 * line. Letting the gain run unsaturated over that range is what a first
 * version did, and the arithmetic is the whole story: the racing line at the
 * start line sits 11.3 m to the right of a kart on the grid, so at a gain of 4
 * the term contributed 45 m of aim-point offset, the field charged at the line
 * and left the road within seven seconds of the lights. Measured on that build
 * (gain 4, unsaturated, and the old 1.6 m lane spread): a clean-mode field that
 * otherwise completes 2.2 laps in 150 s completed 0.27-1.28 with five to eight
 * respawns each.
 *
 * The loop's damping is why turning the gain down instead is not the answer.
 * Writing it out with `e' = ψ` gives `ζ = 1/√(2(1+K_CROSS))`, 0.71 at 0 and
 * 0.41 at 2 — the gain that buys convergence is the same gain that rings on a
 * large error. Saturating the INPUT keeps the authority where the signal is
 * small and hands the large-error case back to pure pursuit, which is well
 * damped and was never the part that was wrong.
 *
 * 2.5 m: wider than the road's share of a lane offset and wider than any error
 * a kart on the line accumulates, narrower than the excursions that pure pursuit
 * should own.
 */
const CROSS_LIMIT: Metres = 2.5

/**
 * DAMPING FOR THE CROSS-TRACK TERM, in metres of aim-point offset per radian.
 *
 * A proportional term on cross-track error carries no damping of its own:
 * writing the loop out with `e' = ψ` gives `ζ = 1/√(2(1+K_CROSS))`, so the gain
 * that breaks the tie also rings, and the ring is what puts a kart off the road
 * at every corner where the line rides the inside limit — which on this circuit
 * is most of them.
 *
 * DERIVATIVE ON THE MEASUREMENT, NOT ON THE ERROR, and that choice is the whole
 * point. The setpoint here is the racing line and it moves across the road at
 * up to 0.41 m per metre, so differencing the ERROR would feed the line's own
 * drift into the damper — the textbook derivative kick from a moving setpoint,
 * and here it would cancel exactly the signal the term exists to produce. The
 * measurement is `loc.lateral`, and its derivative along the road is the angle
 * between the nose and the ROAD tangent. So this brakes the kart's rate of
 * crossing the road and nothing else: it is identically zero for a kart running
 * parallel to the road, whatever the line is doing.
 *
 * It buys ζ = (d + K_CROSS·D)/(d·√(2(1+K_CROSS))), which at K_CROSS = 2, D = 6
 * and an 18 m look-ahead is 0.68 against 0.41 without it. The cost is a standing
 * lag where the line crosses the road fastest — `K_CROSS·D·slope/(1+K_CROSS)`,
 * about 0.7 m at the lap's steepest transition (0.418 m/m) — and the lag is
 * toward the middle of the road, which is the safe side to be wrong on.
 */
const CROSS_DAMP: Metres = 6

/**
 * Closed-loop yaw-rate correction, in units of lock per rad/s of error.
 *
 * This is what makes the mirrored constants above survivable. The feed-forward
 * can be wrong by a factor of two — a retune in `kart/`, a surface the model
 * did not expect, a kart at a slip angle the linear model does not describe —
 * and the yaw term still closes the loop on the response that actually
 * happened. Keep it modest: this is a proportional term on a measured
 * derivative, and a large gain on it rings at the tick rate.
 */
const K_YAW = 0.34

// ---------------------------------------------------------------------------
// The entry-speed model
// ---------------------------------------------------------------------------
/**
 * ENTRY SPEED: `v² = a_lat / κ`, solved along a braking horizon and taken as a
 * minimum, with `a_lat` from the BANKED-CORNER limit rather than the flat one.
 *
 *     a_lat = g · (µ + tanθ) / (1 − µ·tanθ)
 *
 * θ is the road bank where it falls TOWARD the inside of the corner, which is
 * the case exactly when `sign(bank) === sign(curvature)` — the contract defines
 * both as positive-to-the-right, so this is a comparison and not a coordinate
 * conversion. On The Wall (20°, µ≈0.72) the term is 2.3× the flat limit, and
 * that is what makes §10c criterion 5 ("mean speed through The Wall exceeds an
 * equivalent flat 74 m corner by ≥ 6%") something the AI actually goes and
 * collects rather than something the geometry merely permits.
 *
 * `µ` comes from `SURFACE_PROPS[surface].grip` sampled ON THE RACING LINE, not
 * under the kart: the two sand bands across the wash descent are the corner
 * entry, and reading grip only where the kart already is means braking for them
 * one car length after it mattered.
 */
const LAT_UTIL_CLEAN = 0.82
/**
 * The single most load-bearing tuning number in this file for §10c criterion 1.
 *
 * A drifting kart runs its rear tyres at 0.61 of peak by design, so it cannot
 * hold the clean line's lateral g and must arrive slower. Set this too high and
 * the drift lap runs wide, loses the line and is slower for a reason that has
 * nothing to do with the drift economy; too low and it hands the clean lap a
 * free advantage. 0.76 is the honest estimate of the four-wheel average grip
 * during a drift; it is a guess, it is stated as a guess, and it is the first
 * number to measure if the criterion-1 margin comes out ambiguous.
 */
const LAT_UTIL_DRIFT = 0.76
/** Fraction of peak grip spent on braking. The rest stays for turning. */
const BRAKE_UTIL = 0.78
/** Never crawl. Below this the corner is not the reason the kart is slow. */
const MIN_TARGET_SPEED = 8

// ---------------------------------------------------------------------------
// Drift policy
// ---------------------------------------------------------------------------
/**
 * A corner is worth a drift below R = 160 m. On Vermilion Nine that selects
 * eight corners a lap — grid-ease, dune sweep, all three esses, The Wall, the
 * wash and the final corner — and rejects The Slot (R 348), the mesa climb
 * (393) and the arch (188). Twenty-four attempts over a three-lap race is a
 * large enough sample for §10c criterion 2 to mean something.
 */
const DRIFT_CURVATURE = 1 / 160
/** Metres before the corner at which the drift is committed. */
const DRIFT_COMMIT_DISTANCE: Metres = 5
const DRIFT_ARM_SPEED = 12
/**
 * Minimum predicted seconds of corner before an attempt is started.
 *
 * Tier 1 needs 0.42 s of CHARGE and charge only begins once the slip angle has
 * developed, which takes about 0.2 s. 0.85 s of corner is the point below which
 * an attempt would reliably release at tier 0 — and every one of those counts
 * against criterion 2's 60% floor while adding nothing to the lap.
 */
const DRIFT_MIN_ARC_SECONDS = 0.85
/** Lock forced on the initiation tick. See the note in `arm` for why. */
const DRIFT_ARM_STEER = 0.3
/** Ticks allowed for the kart to report `drift.active` before retrying. */
const DRIFT_ARM_TICKS = 5
const DRIFT_COOLDOWN: Seconds = 0.2

/**
 * Target slip angle while holding, in radians.
 *
 * The kart banks charge only above 0.095 rad, so the target has to clear that
 * with margin against the noise of a bumpy surface; past about 0.35 the kart is
 * spinning rather than drifting and the exit costs more than the boost pays.
 * 0.21 sits in the middle of that band, which is what makes the ladder
 * REACHABLE rather than merely defined — criterion 2 measures exactly this.
 */
const SLIP_TARGET = 0.21
const K_SLIP = 2.3
/** Seconds of starved slip tolerated before the attempt is abandoned. */
const SLIP_STARVED_LIMIT: Seconds = 0.45

/**
 * A long corner is re-armed after tier 3 is banked rather than held to the
 * exit: 232 m of The Wall is roughly 8 s and tier 3 arrives at 1.5, so holding
 * would spend six seconds at 0.61 rear grip for nothing. 110 m is enough
 * remaining corner for a second attempt to reach tier 3 in its own right, so
 * the re-arm does not dilute criterion 2's tier-3 fraction with cheap attempts.
 */
const DRIFT_REARM_ARC: Metres = 110

// Corner scan geometry. Re-run at 30 Hz rather than every tick; between scans
// the distances are advanced by the distance travelled, which is exact on a
// constant-curvature segment and close enough everywhere else.
const SCAN_STEP: Metres = 6
const SCAN_ENTRY_MAX: Metres = 66
const SCAN_ARC_MAX: Metres = 252
const SCAN_INTERVAL_TICKS = 4

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------
/**
 * `kart/` has no reachable reverse gear: `REVERSE_FORCE` only engages once
 * forward speed is already below −0.5 m/s, and the brake cannot push a
 * stationary kart backward. A kart facing a wall therefore CANNOT back off it,
 * and every recovery here is a forward manoeuvre — full lock toward the racing
 * line with part throttle, which scrubs the nose around. This is stated
 * explicitly because the obvious fix ("reverse out") silently does nothing and
 * would look like an AI bug rather than a missing gear.
 */
const RECOVERY_AHEAD: Metres = 15
const STALL_SPEED = 2.5
const STALL_SECONDS: Seconds = 1.6

/**
 * Metres of lateral spread between drivers so eight karts are not one kart.
 *
 * WAS 1.6, AND THE ROAD DOES NOT HAVE IT. `world/track.ts` puts the ideal line
 * 1.35 m from the sand wherever the width clamp bites, and it bites through
 * every long corner on this circuit — the line reaches 13.46 m on a 14.00 m
 * half-width, leaving 0.54 m of road outside it. A ±1.6 m preference there is
 * not a lane, it is a clamp: `laneLateral` returns the same edge value for
 * every driver whose preference points outward, so the spread it was supposed
 * to buy does not exist, while the ones pointing inward aim a full 1.6 m off
 * the line all the way round.
 *
 * It also sits directly on top of the cross-track reading. At the steer-test
 * placement the preference is 38% of the 2.5 m probe offset, so the driver was
 * being graded on a target it had deliberately moved; 0.7 leaves the spread
 * real (0.4 m of separation between adjacent drivers is more than a kart's
 * width of overlap) and stops the lane offset from dominating the error the
 * driver is trying to null.
 */
const LANE_SPREAD: Metres = 0.7
/** Clearance the AI keeps from the road edge when placing its target. */
const EDGE_MARGIN: Metres = 1.6

/** Seconds between item pulses. `useItem` is a ONE-TICK PULSE per the contract. */
const ITEM_MIN_INTERVAL: Seconds = 2.4
const ITEM_INTERVAL_SPAN: Seconds = 2.2

// ---------------------------------------------------------------------------
// Module-scope scratch — `step` is on the MUST NOT ALLOCATE list
// ---------------------------------------------------------------------------
const kartForward = new Vector3()
const kartRight = new Vector3()
const prevRight = new Vector3()
const aimPoint = new Vector3()
const toAim = new Vector3()

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function makeSample(): TrackSample {
  return {
    position: new Vector3(),
    tangent: new Vector3(),
    normal: new Vector3(),
    right: new Vector3(),
    halfWidth: 0,
    bank: 0,
    curvature: 0,
  }
}

function makeLocation(): TrackLocation {
  return { t: 0, lateral: 0, height: 0, onTrack: true, checkpointIndex: 0 }
}

/**
 * Steering lock actually available at this speed.
 *
 * `kart/` fades the lock with speed, hard: at 25 m/s only 38% of it survives.
 * An AI that divides its desired steer angle by the full lock therefore asks
 * for a third of what it needs at racing speed, understeers off at the same
 * point every lap, and looks exactly like a track bug. Modelling the fade is
 * what stops that being the default behaviour.
 */
function availableLock(speed: number): number {
  return STEER_LOCK * clamp(1 - Math.abs(speed) / STEER_FADE_SPEED, STEER_FADE_FLOOR, 1)
}

// ---------------------------------------------------------------------------

type DriftPhase = 'idle' | 'arming' | 'holding' | 'cooldown'

/**
 * Build a driver bound to one kart on one track.
 *
 * The kart is bound at construction rather than passed per tick because the
 * driver carries state ABOUT that kart — its measured yaw rate, its drift
 * attempt in progress, its stall timer — and a driver that could be pointed at
 * a different kart between ticks would silently apply one kart's history to
 * another's chassis.
 */
export function createAIDriver(
  ctx: Ctx,
  track: ITrack,
  kart: IKart,
  options?: AIDriverOptions,
): AIDriver {
  const skill = clamp(options?.skill ?? 1, 0, 1)

  /*
   * One stream, forked per kart id. Forking by IDENTITY rather than by
   * construction order is the whole point: building the field in a different
   * order, or adding an `await` to somebody's `build`, must not change which
   * lane a given kart prefers. See the DETERMINISM section of the contract.
   */
  const rng = ctx.rngFor('game/ai').fork(`kart-${kart.identity.id}`)

  /** This driver's standing lateral preference, so a field of eight spreads. */
  const lanePreference = (rng() * 2 - 1) * LANE_SPREAD

  const frame: InputFrame = {
    steer: 0,
    throttle: 0,
    brake: 0,
    drift: false,
    useItem: false,
    look: 0,
  }

  // Caller-owned out-objects, one per call site, allocated once.
  const loc = makeLocation()
  const here = makeSample()
  const aim = makeSample()
  const probe = makeSample()

  const prevForward = new Vector3()
  let havePrevForward = false
  let yawRate = 0

  let phase: DriftPhase = 'idle'
  let armSign: 1 | -1 = 1
  let armTicks = 0
  let cooldownLeft: Seconds = 0
  let holdTime: Seconds = 0
  let slipStarved: Seconds = 0
  let driftAttempts = 0

  let scanCountdown = 0
  /** Metres until the next drift-worthy corner. `Infinity` when there is none. */
  let cornerDist: Metres = Infinity
  /** Metres of that corner still to come, measured from `cornerDist`. */
  let cornerArc: Metres = 0
  let cornerSign: 1 | -1 = 1

  let stallTime: Seconds = 0
  let itemTimer: Seconds = ITEM_MIN_INTERVAL

  /**
   * Locate the next corner worth drifting and measure how long it lasts.
   *
   * Two separate walks on purpose. The first answers "is there a corner", the
   * second answers "is it long enough to bank a tier", and only the second one
   * decides whether an attempt is started. Merging them into one threshold is
   * what produces a driver that flicks the drift button at every kink and fails
   * §10c criterion 2 with a perfectly good kart underneath it.
   */
  function scanCorner(): void {
    const length = track.length
    const t0 = loc.t
    cornerDist = Infinity
    cornerArc = 0

    let entry = -1
    for (let s = 0; s <= SCAN_ENTRY_MAX; s += SCAN_STEP) {
      track.sample(t0 + s / length, probe)
      if (Math.abs(probe.curvature) >= DRIFT_CURVATURE) {
        entry = s
        cornerSign = probe.curvature > 0 ? 1 : -1
        break
      }
    }
    if (entry < 0) return
    cornerDist = entry

    /*
     * The arc ends where the curvature drops below 55% of the entry threshold
     * OR where it changes sign. The sign test is what makes the strata esses
     * work: ess-1 turns right and ess-2 turns left 62 m later, and a drift held
     * across the transition banks nothing and arrives at the second corner
     * pointing the wrong way.
     */
    for (let s = entry; s <= SCAN_ARC_MAX; s += SCAN_STEP) {
      track.sample(t0 + s / length, probe)
      const k = probe.curvature
      if (Math.abs(k) < DRIFT_CURVATURE * 0.55) break
      if ((k > 0 ? 1 : -1) !== cornerSign) break
      cornerArc = s - entry + SCAN_STEP
    }
  }

  /**
   * CURVATURE OF THE ARC THE KART ACTUALLY DRIVES at `t`. `s` must be the
   * sample at that same `t` — passed in rather than re-sampled, because this is
   * called thirteen times a tick and `step` is on the MUST NOT ALLOCATE list.
   *
   * `TrackSample.curvature` is the CENTRELINE's, and the racing line is not
   * parallel to it. This used to be a constant 0.88 "racing-line relief", on
   * the reasoning that the ideal line is straighter than the road. Where the
   * road is wide enough that is true — `world/track.ts` minimises path
   * curvature and comes out straight — but where it is not, the width clamp
   * bites and the line runs parallel to the INSIDE edge, so the arc is tighter
   * than the road rather than straighter. On The Wall the centreline is R = 74 m
   * and the line sits 12.46 m inside it: the kart drives R = 61.5 m while 0.88
   * modelled 84 m. That is 37% out in curvature, 17% in speed, in the direction
   * that says "go faster", through the fastest corner on the lap.
   *
   * Derived, not tuned. With `P(s) = C(s) + l(s)·R(s)`, `T' = κR`, `R' = −κT`,
   * the offset curve's arc-length ratio is `1 − κl`, so `κ_p = κ/(1 − κl)`.
   *
   * THE `l''` TERM IS DELIBERATELY ABSENT and this is the load-bearing part of
   * the comment. The full formula carries `+ l''/(1−κl)²` — the line's own bend
   * where it crosses the road — and it cannot be had from a finite difference
   * of `racingLine`, because the line KINKS where it meets the lateral clamp at
   * a corner entry. A 6 m second difference across that kink returns −0.017 1/m,
   * larger than the corner itself and opposite in sign, so the driver brakes for
   * a corner that turns the other way. Measured with it in: the clean field went
   * from 2.21 laps per 150 s to 1.50 with three respawns each. Whoever wants
   * that term should get it from `world/`, which solved the line and has its
   * curvature without differencing anything.
   *
   * THIS CHANGE AND THE CROSS-TRACK TERM ARE ONLY CORRECT TOGETHER, which is
   * the thing that makes both of them hard to find alone:
   *
   *     K_CROSS   corner model          clean laps/150 s   respawns   off-track
   *       0       centreline x 0.88          2.19            1-2         135
   *       0       this one                   1.50            3            —
   *       2       centreline x 0.88          1.37            4-5         853
   *       2       this one                   2.21            1             0
   *
   * At K_CROSS = 0 the driver never actually reached the racing line — pure
   * pursuit lagged it and cut across the middle of the road, where the arc is
   * close to the centreline's, so the old constant described what was really
   * being driven and braking for the true line was pure loss. The cross-track
   * term put the kart ON the line, which is what made the speed model wrong;
   * fixing the speed model is what pays for the cross-track term. Neither
   * ordering shows a win on its own, and the pair is better than the build
   * before either.
   */
  function insideCurvature(t: number, s: TrackSample): number {
    /*
     * `1 − κl` is the ratio of the offset arc to the centreline arc, and it
     * reaches zero only where the line passes through the centre of curvature,
     * which no road can do. Clamped for the same reason as the bank denominator
     * below: an unguarded division there returns an infinite curvature, and the
     * AI brakes to a standstill on a straight.
     */
    return s.curvature / clamp(1 - s.curvature * track.racingLine(t), 0.25, 4)
  }

  /**
   * The speed this corner can be taken at, from grip, curvature and bank.
   * See the LAT_UTIL comment block for the derivation. `curvature` is the
   * DRIVEN arc's, from `insideCurvature` — see there for why it is not the
   * centreline's with a constant on it.
   */
  function cornerSpeed(curvature: number, bank: number, grip: number, util: number): number {
    const k = Math.abs(curvature)
    if (k < 1e-5) return 1e4
    const mu = grip * util
    // Positive when the road falls toward the inside of THIS corner.
    const signedBank = curvature >= 0 ? bank : -bank
    const tb = Math.tan(clamp(signedBank, -0.5, 0.5))
    // Guarded: `1 - µ·tanθ` goes to zero for a bank the circuit does not have,
    // and an unguarded division there returns a corner speed of infinity, which
    // is the one wrong answer that never looks wrong until the kart is airborne.
    const denom = Math.max(0.3, 1 - mu * tb)
    const aLat = Math.max(1, (G * (mu + tb)) / denom)
    return Math.sqrt(aLat / k)
  }

  /**
   * WHERE THIS DRIVER WANTS TO BE at track parameter `t`: the track's one
   * racing line, plus this driver's standing lane preference faded out as the
   * corner tightens, clamped inside the road. `s` must be the sample at `t`.
   *
   * ONE function, called at the look-ahead AND at the kart's own station. Two
   * copies of this policy would let "where I am going" and "where I should be"
   * disagree about the lane offset, and the cross-track term would then drive
   * the kart to a standing error of exactly that disagreement — a bias that
   * looks like a steering bug and is a bookkeeping one.
   */
  function laneLateral(t: number, s: TrackSample, isRecovering: boolean): Metres {
    let lat = track.racingLine(t)
    if (!isRecovering) {
      // Lane preference, faded out as the corner tightens: spread the field on
      // the straights, share the one correct line through the corners.
      const cornerness = clamp(Math.abs(s.curvature) / 0.012, 0, 1)
      lat += lanePreference * (1 - 0.78 * cornerness)

      /*
       * Drift mode enters wide. A bigger entry angle is what buys a slip angle
       * the kart can hold for a second and a half without running out of road,
       * and running out of road is the thing that turns a tier-3 attempt into
       * a tier-0 attempt plus a wall hit.
       */
      if (driver.mode === 'drift' && phase === 'idle' && cornerDist < 40) {
        lat -= cornerSign * 1.5
      }
    }
    const limit = Math.max(0.3, s.halfWidth - EDGE_MARGIN)
    return clamp(lat, -limit, limit)
  }

  function endAttempt(cooldown: Seconds): void {
    phase = 'cooldown'
    cooldownLeft = cooldown
    holdTime = 0
    slipStarved = 0
  }

  function resetState(): void {
    frame.steer = 0
    frame.throttle = 0
    frame.brake = 0
    frame.drift = false
    frame.useItem = false
    frame.look = 0
    havePrevForward = false
    yawRate = 0
    phase = 'idle'
    armTicks = 0
    cooldownLeft = 0
    holdTime = 0
    slipStarved = 0
    driftAttempts = 0
    scanCountdown = 0
    cornerDist = Infinity
    cornerArc = 0
    stallTime = 0
    itemTimer = ITEM_MIN_INTERVAL
  }

  const driver: AIDriver = {
    kartId: kart.identity.id,
    mode: options?.mode ?? 'drift',
    frame,

    get driftAttempts(): number {
      return driftAttempts
    },

    reset(): void {
      resetState()
    },

    step(step: Seconds): Readonly<InputFrame> {
      if (step <= 0) return frame

      const state = kart.state
      const speed = Math.max(0, state.speed)
      const length = track.length

      // --- where we are ---------------------------------------------------
      track.locate(state.position, loc)
      track.sample(loc.t, here)

      kartForward.set(0, 0, -1).applyQuaternion(state.quaternion)
      kartRight.set(1, 0, 0).applyQuaternion(state.quaternion)

      /*
       * Measured yaw rate, positive to the driver's right — the same sense the
       * kart integrates in. `prevRight` is the PREVIOUS tick's chassis right,
       * so `forward · prevRight` is the sine of the angle the nose swept toward
       * the right. No sign is chosen here; it falls out of `right = forward ×
       * up`, which is the frame both this file and `kart/` build from.
       */
      if (havePrevForward) {
        prevRight.crossVectors(prevForward, here.normal)
        const sinT = kartForward.dot(prevRight)
        const cosT = kartForward.dot(prevForward)
        yawRate = Math.atan2(sinT, cosT) / step
      }
      prevForward.copy(kartForward)
      havePrevForward = true

      // --- corner scan (30 Hz, advanced by odometry in between) ------------
      if (scanCountdown <= 0) {
        scanCorner()
        scanCountdown = SCAN_INTERVAL_TICKS
      } else {
        scanCountdown--
        const travelled = speed * step
        if (cornerDist > 0 && cornerDist !== Infinity) {
          cornerDist = Math.max(0, cornerDist - travelled)
        } else if (cornerArc > 0) {
          cornerArc = Math.max(0, cornerArc - travelled)
        }
      }

      // --- recovery test ---------------------------------------------------
      const alongTrack = kartForward.dot(here.tangent)
      stallTime = speed < STALL_SPEED ? stallTime + step : 0
      const strayed = Math.abs(loc.lateral) > here.halfWidth * 0.75
      const recovering = !loc.onTrack || alongTrack < 0.15 || (stallTime > STALL_SECONDS && strayed)

      // --- the target point on the road ------------------------------------
      const lookAhead = recovering
        ? RECOVERY_AHEAD
        : clamp(LOOK_BASE + speed * LOOK_PER_SPEED * (0.85 + 0.15 * skill), LOOK_MIN, LOOK_MAX)
      const tAim = loc.t + lookAhead / length
      track.sample(tAim, aim)

      /*
       * ONE racing line, the track's. `ITrack.racingLine` is already the ideal
       * lateral offset derived from curvature — the contract says so and
       * `world/track.ts` solves it by minimising path curvature inside the
       * boundaries. Inventing a second one here would put the AI, the ghost and
       * the boost pads (which are placed against `racingLine`) on three
       * different lines, and only the pads would visibly disagree.
       */
      const targetLat = laneLateral(tAim, aim, recovering)
      aimPoint.copy(aim.position).addScaledVector(aim.right, targetLat)

      // --- pure pursuit, in the kart's own frame ---------------------------
      /*
       * `κ = 2·dRight / |d|²` is the curvature of the circle through the kart,
       * tangent to its heading, passing through the aim point. It folds heading
       * error and cross-track error into one number with no gains to balance
       * between them, and — the reason it is used here — its SIGN is a geometric
       * fact rather than a convention: `dRight > 0` means the target is to the
       * driver's right, so the kart must turn right, so `steer` is positive.
       */
      toAim.copy(aimPoint).sub(state.position)
      toAim.addScaledVector(here.normal, -toAim.dot(here.normal))
      const dRightAim = toAim.dot(kartRight)
      const dForward = toAim.dot(kartForward)

      /*
       * THE CROSS-TRACK ERROR, READ WHERE IT IS UNAMBIGUOUS.
       *
       * `dRightAim` cannot say which side of the line the kart is on, because
       * the line moves under the look-ahead: see the K_CROSS block for the
       * decomposition and the measurement. This reads the same error a second
       * time in the frame that does not move — the kart's own station, against
       * the line at that station — and adds it to the pursuit's lateral offset
       * rather than to the chord, so the geometry of the chord is untouched and
       * only the term that was being divided away gets its weight back.
       *
       * NO NEGATION, and none is possible here: `laneLateral` returns "signed
       * metres from the centreline, positive is the driver's right" because
       * `ITrack.racingLine` is defined that way, `loc.lateral` is defined the
       * same way by `TrackLocation`, so their difference is "how far the line is
       * to my right" in the same units and the same sense as `dRightAim`. A
       * positive value asks for positive steer, exactly as the contract says.
       */
      const crossRight = laneLateral(loc.t, here, recovering) - loc.lateral

      /*
       * The kart's heading against the ROAD, which is `d(loc.lateral)/ds` — how
       * fast it is crossing the road, and the only derivative in this solve.
       * `atan2(forward·right, forward·tangent)` in that argument order is
       * positive when the nose points to the driver's right, the same sense as
       * everything else here; subtracting it therefore opposes a rightward
       * crossing, which is damping and not a sign flip. Clamped because a spun
       * or reversing kart reads near ±π, and recovery owns that case.
       */
      const crossRate = clamp(
        Math.atan2(kartForward.dot(here.right), kartForward.dot(here.tangent)),
        -0.5,
        0.5,
      )
      const dRight =
        dRightAim +
        K_CROSS * (clamp(crossRight, -CROSS_LIMIT, CROSS_LIMIT) - CROSS_DAMP * crossRate)

      /*
       * `d2` stays the REAL chord to the aim point. The cross-track term above
       * corrects the lateral offset the pursuit is solving for; it is not a
       * second target, and folding it into the chord as well would shorten the
       * pursuit circle at the same time as widening its offset — two changes
       * for one reading, and the gain would then be quadratic in the error.
       */
      const d2 = Math.max(1, dRightAim * dRightAim + dForward * dForward)
      const kappaDesired = (2 * dRight) / d2

      const lock = availableLock(speed)
      const deltaFF = (WHEELBASE + K_UNDERSTEER * speed * speed) * kappaDesired
      let steer = deltaFF / lock + K_YAW * (kappaDesired * speed - yawRate)

      /*
       * The aim point is beside or behind the kart. Pure pursuit degenerates
       * there — a target directly astern has `dRight ≈ 0` and produces no steer
       * at all, which is precisely the kart that sits against a wall doing
       * nothing. Full lock toward whichever side the road is on.
       */
      if (dForward < 3) {
        steer = dRight >= 0 ? 1 : -1
      }
      steer = clamp(steer, -1, 1)

      // --- entry speed ------------------------------------------------------
      const gripHere = SURFACE_PROPS[state.surface].grip
      const brakeAccel = Math.max(1.5, gripHere * G * BRAKE_UTIL)
      const latUtil =
        (driver.mode === 'drift' ? LAT_UTIL_DRIFT : LAT_UTIL_CLEAN) * (0.9 + 0.1 * skill)

      // Braking distance from here to a standstill, plus a margin. Any corner
      // beyond this horizon cannot yet require a lift.
      const horizon = clamp((speed * speed) / (2 * brakeAccel) + 10, 22, 190)
      let targetSpeed = cornerSpeed(insideCurvature(loc.t, here), here.bank, gripHere, latUtil)

      const probes = 12
      for (let i = 1; i <= probes; i++) {
        const s = (horizon * i) / probes
        const ts = loc.t + s / length
        track.sample(ts, probe)
        const surf = track.surfaceAt(ts, track.racingLine(ts))
        const vCorner = cornerSpeed(insideCurvature(ts, probe), probe.bank, SURFACE_PROPS[surf].grip, latUtil)
        // The speed we may be doing HERE and still shed to `vCorner` in `s`
        // metres. This is the braking curve, evaluated backwards.
        const vAllowed = Math.sqrt(vCorner * vCorner + 2 * brakeAccel * s)
        if (vAllowed < targetSpeed) targetSpeed = vAllowed
      }
      targetSpeed = Math.max(MIN_TARGET_SPEED, Math.min(targetSpeed, TOP_SPEED_REFERENCE * 1.6))

      let throttle: number
      let brake = 0
      const speedError = targetSpeed - speed
      if (speedError > 0.6) {
        throttle = clamp(speedError * 0.6, 0.4, 1)
      } else if (speedError < -0.5) {
        throttle = 0
        brake = clamp(-speedError * 0.45, 0.18, 1)
      } else {
        // Inside the deadband: hold the corner on a trailing throttle rather
        // than alternating full power and full brake, which unsettles the rear
        // and turns a controlled drift into a spin.
        throttle = 0.55
      }

      // --- drift state machine ---------------------------------------------
      let drift = false
      if (recovering || state.stunTime > 0) {
        if (phase !== 'idle') endAttempt(DRIFT_COOLDOWN)
      }

      if (cooldownLeft > 0) {
        cooldownLeft -= step
        if (cooldownLeft <= 0 && phase === 'cooldown') phase = 'idle'
      }

      if (driver.mode === 'drift' && !recovering && state.stunTime <= 0) {
        if (phase === 'idle') {
          const committed = cornerDist <= DRIFT_COMMIT_DISTANCE
          const arcSeconds = cornerArc / Math.max(speed, 6)
          if (
            committed &&
            cornerArc > 0 &&
            speed >= Math.max(DRIFT_ARM_SPEED, KART_DRIFT_MIN_SPEED + 1) &&
            arcSeconds >= DRIFT_MIN_ARC_SECONDS &&
            state.grounded
          ) {
            phase = 'arming'
            armSign = cornerSign
            armTicks = 0
          }
        }

        if (phase === 'arming') {
          drift = true
          /*
           * THE RISING EDGE IS CONSUMED WHETHER OR NOT IT TAKES.
           *
           * `kart/` gates initiation on `|steer| >= 0.18` at the rising edge and
           * then latches the button state unconditionally. A request that fails
           * the gate therefore does not retry while the button stays held — the
           * attempt is silently dead and the kart drives the corner flat. So the
           * lock is forced past the gate on the arming ticks, and if the kart
           * still has not reported `drift.active` after five of them, the button
           * is released through `cooldown` so a clean edge can be produced.
           */
          const into = Math.max(steer * armSign, DRIFT_ARM_STEER)
          steer = clamp(armSign * Math.max(into, KART_DRIFT_MIN_STEER + 0.05), -1, 1)
          armTicks++
          if (state.drift.active) {
            phase = 'holding'
            holdTime = 0
            slipStarved = 0
            // Counted HERE, not at arming. An arm that failed the kart's gate is
            // not an attempt the ladder ever saw, and counting it would deflate
            // §10c criterion 2's percentages against a kart that did nothing
            // wrong. This counter tracks `drift:start` one-for-one.
            driftAttempts++
          } else if (armTicks > DRIFT_ARM_TICKS) {
            endAttempt(0.1)
            drift = false
          }
        } else if (phase === 'holding') {
          drift = true
          holdTime += step

          const dir = state.drift.direction !== 0 ? state.drift.direction : armSign
          /*
           * `slipAngle` is the angle from chassis forward to the velocity, so a
           * kart drifting RIGHT (direction +1) has its velocity to the LEFT of
           * its nose and a NEGATIVE slip angle. `-slip · dir` is therefore the
           * magnitude of slip in the drift's own direction, positive when the
           * drift is doing what it is supposed to.
           */
          const slipInto = -state.drift.slipAngle * dir
          // Not counted during the first quarter second: the slip angle has not
          // physically had time to develop yet, and starving the attempt for
          // that would abandon every drift before it began.
          slipStarved = holdTime > 0.25 && slipInto < KART_DRIFT_SLIP_GATE ? slipStarved + step : 0
          steer = clamp(steer + dir * clamp(K_SLIP * (SLIP_TARGET - slipInto), -0.5, 0.55), -1, 1)

          // Power keeps the rear loose: longitudinal force competes with lateral
          // inside the same friction budget, which is what sustains the slip.
          if (speedError > -3) throttle = Math.max(throttle, 0.9)
          // A short trail brake on entry rotates the kart into the corner rather
          // than pushing it wide while the slip angle is still building.
          if (holdTime < 0.22) brake = Math.max(brake, 0.22)

          const releaseDistance = Math.max(5, speed * 0.3)
          const banked3 = state.drift.tier === 3
          /*
           * `cornerArc` alone is NOT a sufficient exit test, and the way it
           * fails is quiet. Once the kart clears the corner, the next scan
           * reports the corner AFTER this one — a fresh, long `cornerArc` — and
           * a release keyed only on `cornerArc <= releaseDistance` would then
           * hold the button all the way down the following straight, banking
           * nothing and arriving at the next corner already committed the wrong
           * way. `stillOnCorner` is the test that this is the same corner the
           * attempt was armed for: within the commit window, and turning the
           * same way. It is what releases the drift across the strata esses,
           * where ess-1 becomes ess-2 with no straight in between.
           */
          const stillOnCorner = cornerDist <= DRIFT_COMMIT_DISTANCE + 2 && cornerSign === dir
          const release =
            !state.drift.active ||
            !loc.onTrack ||
            !stillOnCorner ||
            slipStarved > SLIP_STARVED_LIMIT ||
            cornerArc <= releaseDistance ||
            (banked3 && cornerArc >= DRIFT_REARM_ARC)
          if (release) {
            drift = false
            endAttempt(DRIFT_COOLDOWN)
          }
        }
      } else if (phase !== 'idle' && phase !== 'cooldown') {
        // Mode switched to `'clean'` mid-corner, or the kart was stunned. Drop
        // the button; the kart cashes whatever tier it had.
        endAttempt(DRIFT_COOLDOWN)
      }

      // --- recovery ---------------------------------------------------------
      if (recovering) {
        drift = false
        if (state.speed < -1) {
          // Rolling backwards. Stop first: there is no reverse to steer with.
          throttle = 0
          brake = 0.6
        } else {
          // Part throttle. Flooring it at full lock understeers straight on into
          // whatever the kart is already stuck against; this keeps the front
          // tyres inside their friction budget so the nose actually comes round.
          throttle = alongTrack > 0.4 ? 0.85 : 0.45
          brake = 0
        }
      }

      // --- items ------------------------------------------------------------
      /*
       * ONE-TICK PULSE, per the contract: `game/` consumes it and calls
       * `IItems.use`, and nothing else edge-detects it. The AI does not know
       * what it is holding — `IItems.held` is not on the driver's surface — so
       * it fires on a straight, out of a drift, on a per-driver deterministic
       * cadence. `use` with nothing held is a no-op, which is the right cost for
       * not plumbing an item query into a controller that has no use for one.
       */
      itemTimer -= step
      let useItem = false
      if (
        itemTimer <= 0 &&
        !recovering &&
        phase === 'idle' &&
        Math.abs(here.curvature) < 0.006
      ) {
        useItem = true
        itemTimer = ITEM_MIN_INTERVAL + rng() * ITEM_INTERVAL_SPAN
      }

      frame.steer = clamp(steer, -1, 1)
      frame.throttle = clamp(throttle, 0, 1)
      frame.brake = clamp(brake, 0, 1)
      frame.drift = drift
      frame.useItem = useItem
      // The AI never asks for a camera. `look` is a viewer control and an AI
      // kart is not the viewer; leaving it at 0 keeps the chase camera default
      // for whichever kart the rig happens to be following.
      frame.look = 0
      return frame
    },
  }

  return driver
}
