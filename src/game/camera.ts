/**
 * THE CHASE CAMERA — and the only thing in the game allowed to write a camera
 * transform.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE OWNERSHIP SPLIT IN `ICameraRig` IS THE WHOLE DESIGN
 *
 * The contract says exactly one subsystem writes the transform, through
 * `follow`, and everything else contributes an ADDITIVE, DECAYING channel. That
 * is not tidiness. Three subsystems that each `camera.position.set(...)` produce
 * last-writer-wins, which manifests as a camera that stutters or snaps at
 * moments nobody can attribute — the boost punch is in `fx/`, the landing jolt
 * is in `kart/`, the base dolly is here, and the frame shows one broken camera
 * with no owner. So `follow` computes a base pose from scratch every tick and
 * the impulse channels are summed on top of it. An impulse can never leave
 * residue in the base pose, because the base pose is never accumulated into.
 *
 * Consequently `addFovPunch` and `addShake` do not touch `camera` at all. They
 * only push a slot into a fixed-size ring. The pose is assembled once, in
 * `follow`, in a fixed order, from state that fully decays to zero.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * WHY THE TRANSFORM IS COMPUTED ON THE FIXED STEP AND NOT PER FRAME
 *
 * `follow` takes a `Seconds` step and is driven from `fixedUpdate`. Springs
 * integrated against a wall-clock delta settle differently on a busy machine
 * than on an idle one, so the camera would be in a different place at tick N
 * depending on frame rate — and every §11 vantage screenshot, every energy
 * measurement and every luma tile would inherit that. `lateUpdate` here does
 * exactly one thing: keep the projection aspect matched to the canvas.
 *
 * WHY THE HORIZON ROLLS
 *
 * ART_DIRECTION §6: "On The Wall the chassis stays normal to the banked surface
 * while the camera horizon rolls 20°. The bank must be felt, not just seen."
 * `camera.up` is therefore driven from the ROAD normal (`TrackSample.normal`,
 * already rotated by the bank) rather than from world up or from the chassis.
 * Road normal rather than chassis up on purpose: a kart that hops a kerb or
 * lands from the arch pitches its chassis hard, and hanging the horizon off it
 * makes the frame heave for reasons the player did not cause.
 */

import { PerspectiveCamera, Quaternion, Vector3 } from 'three'

import { SURFACE_PROPS } from '../types'
import type {
  CameraFactory,
  Ctx,
  GameServices,
  ICameraRig,
  IInput,
  IKart,
  ITrack,
  Seconds,
  Subsystem,
  TrackLocation,
  TrackSample,
} from '../types'

const RAD2DEG = 180 / Math.PI

// ---------------------------------------------------------------------------
// Rig geometry
// ---------------------------------------------------------------------------

/**
 * Matches the placeholder dolly in the composition root. 62° is wide enough
 * that the §11 vantages frame the canyon walls they are graded on, and narrow
 * enough that an +8° boost punch (§7) is a punch rather than a fisheye.
 */
const BASE_FOV = 62

/** Metres behind the kart at a standstill, and the extra at top speed. */
const CHASE_DISTANCE = 6.1
const CHASE_DISTANCE_SPEED = 1.7
/** Metres above the road plane, measured along the ROAD normal, not world up. */
const CHASE_HEIGHT = 2.45
const CHASE_HEIGHT_SPEED = 0.35
/** Height of the aim point above the road. Slightly above the kart's roll bar. */
const AIM_HEIGHT = 1.35

/** Reference top speed, used only to normalise the speed-dependent terms. */
const SPEED_REFERENCE = 31.5

/**
 * How far down the road the camera aims, in metres, at a standstill and per
 * m/s. ~0.8 s of travel. This is the term that makes a corner readable: aiming
 * at a point a fixed TIME ahead is roughly what a driver's eyes do, and it is
 * also the cheapest check that the spline's frame is coherent — a track whose
 * tangent or normal quietly goes wrong makes this camera lurch, and no still
 * frame would show it. (The placeholder dolly in `main.ts` had already learned
 * this; it is kept, with the fixed `t` offset replaced by a real distance so it
 * does not shorten as the track gets longer.)
 */
const AIM_AHEAD_BASE = 9
const AIM_AHEAD_PER_SPEED = 0.8
const AIM_AHEAD_MAX = 42

/**
 * How much of the aim point comes from the road ahead versus from straight out
 * of the kart's nose.
 *
 * Pure road-ahead is the better corner read but detaches from the kart when it
 * spins or leaves the road; pure nose-ahead points at a cliff on every corner.
 * 0.55 keeps the corner lead and still swings back to the kart when the kart
 * stops agreeing with the road.
 */
const AIM_ROAD_WEIGHT = 0.55

// ---------------------------------------------------------------------------
// Spring constants — the numbers that decide whether this is nauseating
// ---------------------------------------------------------------------------
/**
 * Both springs are CRITICALLY DAMPED and integrated implicitly, so they cannot
 * overshoot and cannot go unstable at any step size. An underdamped chase
 * camera is the classic way to make a kart racer unplayable: it oscillates once
 * per corner at a frequency the inner ear notices and the eye does not.
 *
 * ω is an angular frequency in rad/s; the useful reading is the settling time,
 * roughly 4.6/ω to 1%.
 *
 *   POSITION ω = 7.0   → ~660 ms to settle, ~140 ms time constant.
 *     This is THE lag term. Under full throttle the kart pulls away from the
 *     rig and the rig closes the gap over about a fifth of a second, which is
 *     what acceleration feels like from behind. Raise it past ~11 and the
 *     camera is bolted to the chassis and the game reads as flat; drop it below
 *     ~5 and the kart wanders around the frame.
 *
 *   LOOK ω = 10.5      → ~440 ms to settle.
 *     Deliberately FASTER than the position spring. The aim must arrive at the
 *     corner before the body does — that ordering is what "leads into corners"
 *     means mechanically. If the two are equal the camera turns and translates
 *     together and the corner opens up late.
 *
 *   UP ω = 5.5         → ~840 ms.
 *     The slowest of the three, because roll is the axis the vestibular system
 *     complains about first. The Wall's bank ramps in over 40 m ≈ 1.4 s at
 *     racing speed, so 840 ms still tracks the ramp with room to spare while
 *     refusing to snap when a wheel clips a kerb.
 */
const POS_OMEGA = 7.0
const LOOK_OMEGA = 10.5
const UP_OMEGA = 5.5

/** `Settings.reducedMotion` variants. Slower springs low-pass the target, which
 *  genuinely removes angular rate rather than merely reporting less of it. */
const POS_OMEGA_REDUCED = 6.0
const LOOK_OMEGA_REDUCED = 6.5
const UP_OMEGA_REDUCED = 3.5

/** Fraction of the road's bank the horizon adopts. §6 wants the full 20°. */
const ROLL_GAIN = 1.0
const ROLL_GAIN_REDUCED = 0.2

/**
 * Hard ceiling on how fast the view may rotate, in degrees per second.
 *
 * 240°/s never binds in ordinary driving — a 74 m corner at 30 m/s is 23°/s —
 * so it is not a handling constraint. It exists for the pathological tick: a
 * respawn that is not caught by the snap path, a spin under `applyHit`, a
 * harness `seek` across the map. One 180° frame is what people actually
 * remember as motion sickness.
 *
 * The reduced-motion value is a real limit rather than a formality, and it is
 * applied to the pose, not to the reported metric. `swingDegPerSec` always
 * reports what the eye received.
 */
const MAX_SWING_DEG_PER_SEC = 240
const MAX_SWING_DEG_PER_SEC_REDUCED = 55

/** Distance the kart may move in one tick before the rig treats it as a
 *  teleport and snaps instead of springing. 3 m at 120 Hz is 360 m/s. */
const TELEPORT_METRES = 3.0

// ---------------------------------------------------------------------------
// Additive channels
// ---------------------------------------------------------------------------

/** Concurrent impulses of each kind. Fixed size: `addShake` in a particle
 *  callback must never be able to grow an array inside a frame. */
const PUNCH_SLOTS = 8
const SHAKE_SLOTS = 8

/**
 * Total FOV punch is clamped here. §7 asks for +8°; a runaway caller adding a
 * punch per particle would otherwise walk the FOV to 179° and the projection
 * matrix would degenerate, which reads as the world inverting rather than as a
 * camera bug.
 */
const MAX_FOV_PUNCH = 22
const FOV_PUNCH_REDUCED_SCALE = 0.4

/** Metres of positional shake per unit of summed intensity. */
const SHAKE_METRES = 0.16
/** Radians of rotational shake per unit of summed intensity. Small: rotation is
 *  what causes nausea, translation is what sells impact. */
const SHAKE_RADIANS = 0.016

/**
 * Continuous surface rumble, from `SurfaceProps.roughness` — which the contract
 * describes as exactly this: "Chassis perturbation amplitude in metres. Drives
 * rumble and camera shake."
 *
 * This lives in the BASE pose rather than in the additive channel because it is
 * a continuous function of state, not a discrete moment, and the contract is
 * explicit that continuous data does not travel as impulses. It is deliberately
 * small — 0.12 roughness on `OffTrack` at speed reaches 0.055 m — so that when
 * `fx/` adds a real impact shake on top, the impact still dominates.
 */
const RUMBLE_GAIN = 0.45
const RUMBLE_SPEED_REFERENCE = 18

// ---------------------------------------------------------------------------
// Module-scope scratch. `follow` is on the contract's MUST NOT ALLOCATE list.
// ---------------------------------------------------------------------------
/*
 * Module scope rather than per-instance is safe here for a reason worth stating:
 * there is exactly one camera rig in a world, and nothing `follow` calls can
 * re-enter it — `ITrack.sample` and `locate` emit nothing and call nothing back.
 * The two TrackSample/TrackLocation out-objects are still per-instance, because
 * the contract makes those caller-owned precisely so a second call site cannot
 * quietly share one.
 */
const chassisForward = new Vector3()
const travelForward = new Vector3()
const followForward = new Vector3()
const targetUp = new Vector3()
const desiredPos = new Vector3()
const desiredAim = new Vector3()
const roadAim = new Vector3()
const noseAim = new Vector3()
const camLocalRight = new Vector3()
const camLocalUp = new Vector3()

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * One critically damped spring step, implicit, per axis.
 *
 * The explicit form (`v += (ω²(x*-x) - 2ωv)·h`) is the one everybody writes and
 * it goes unstable for ωh > 2, which is reachable the moment somebody calls
 * `follow` with a catch-up step instead of `SIMULATION_STEP`. This form is
 * unconditionally stable and costs three multiplies more.
 */
function springStep(pos: Vector3, vel: Vector3, target: Vector3, omega: number, h: Seconds): void {
  const f = 1 + 2 * h * omega
  const oo = omega * omega
  const hoo = h * oo
  const hhoo = h * hoo
  const detInv = 1 / (f + hhoo)

  // Velocity uses the OLD position; compute all three before writing any back.
  const vx = (vel.x + hoo * (target.x - pos.x)) * detInv
  const vy = (vel.y + hoo * (target.y - pos.y)) * detInv
  const vz = (vel.z + hoo * (target.z - pos.z)) * detInv

  pos.x = (f * pos.x + h * vel.x + hhoo * target.x) * detInv
  pos.y = (f * pos.y + h * vel.y + hhoo * target.y) * detInv
  pos.z = (f * pos.z + h * vel.z + hhoo * target.z) * detInv

  vel.set(vx, vy, vz)
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

// ---------------------------------------------------------------------------

export const createCameraRig: CameraFactory = (ctx: Ctx): ICameraRig & Subsystem => {
  /*
   * `near` is lifted off 0.1 and `far` reaches the outermost mesa ring, matching
   * the composition root's placeholder camera. Depth precision across 2400 m is
   * the reason for both; z-fighting on the strata bands is an §10b criterion 7
   * "amateur tell" and it is entirely a near-plane decision.
   */
  const camera = new PerspectiveCamera(BASE_FOV, 1, 0.3, 2400)
  camera.name = 'game/camera'

  /*
   * Called here rather than inside `build` on purpose. Streams are keyed by
   * namespace and world seed, never by call order — that is the entire reason
   * `rngFor` is memoised — so drawing the shake phases in the factory produces
   * the same numbers as drawing them in `build`, and cannot shift anyone else's
   * stream. See the DETERMINISM section of the contract.
   */
  const rng = ctx.rngFor('game/camera')

  // --- persistent rig state -------------------------------------------------
  const springPos = new Vector3()
  const springPosVel = new Vector3()
  const springAim = new Vector3()
  const springAimVel = new Vector3()
  const smoothUp = new Vector3(0, 1, 0)
  const prevKartPos = new Vector3()
  const prevQuat = new Quaternion()
  const desiredQuat = new Quaternion()
  const shakeQuat = new Quaternion()

  const here = makeSample()
  const ahead = makeSample()
  const loc = makeLocation()

  let track: ITrack | null = null
  let input: IInput | null = null
  let fallbackKart: IKart | null = null
  let unsubscribeRespawn: (() => void) | null = null

  /** True until the first `follow`, and again after any teleport. */
  let needsSnap = true
  /** Simulation seconds accumulated inside `follow`. Never a wall clock. */
  let elapsed = 0
  /** Smoothed look-behind blend, 0 = chase, 1 = fully reversed. */
  let lookBack = 0
  let swingDegPerSec = 0
  /** Ticks are counted so the rig can tell "nobody called `follow`" apart from
   *  "`follow` was called and the kart did not move". */
  let lastFollowTick = -1

  // --- additive channels ----------------------------------------------------
  const punchDeg = new Float64Array(PUNCH_SLOTS)
  const punchAttack = new Float64Array(PUNCH_SLOTS)
  const punchDecay = new Float64Array(PUNCH_SLOTS)
  const punchAge = new Float64Array(PUNCH_SLOTS)

  const shakeAmp = new Float64Array(SHAKE_SLOTS)
  const shakeDur = new Float64Array(SHAKE_SLOTS)
  const shakeAge = new Float64Array(SHAKE_SLOTS)

  /*
   * Shake noise: six sinusoids at mutually irrational-ish rates with seeded
   * phases. A table of `rng()` samples indexed by tick would be equally
   * deterministic but steps discontinuously, which a camera turns into a buzz;
   * summed sines are C∞ and cost six `Math.sin` calls a tick.
   *
   * The rates are fixed constants and only the PHASES are seeded, so a shake
   * looks like the same kind of shake in every world while never landing on the
   * same frame twice.
   */
  const SHAKE_RATE = [27.31, 19.73, 41.29, 33.17, 23.87, 31.69]
  const shakePhase = new Float64Array(6)
  for (let i = 0; i < 6; i++) shakePhase[i] = rng() * Math.PI * 2

  function noise(i: number, j: number, k: number, t: number): number {
    return (
      Math.sin(t * SHAKE_RATE[i]! + shakePhase[i]!) * 0.55 +
      Math.sin(t * SHAKE_RATE[j]! + shakePhase[j]!) * 0.3 +
      Math.sin(t * SHAKE_RATE[k]! + shakePhase[k]!) * 0.15
    )
  }

  /** Sum the live FOV punches and age them by `step`. Returns degrees. */
  function stepPunches(step: Seconds): number {
    let total = 0
    for (let i = 0; i < PUNCH_SLOTS; i++) {
      const deg = punchDeg[i]!
      if (deg === 0) continue
      const age = punchAge[i]! + step
      punchAge[i] = age
      const attack = punchAttack[i]!
      const decay = punchDecay[i]!
      if (age < attack) {
        // Smoothstep in, so the punch has no corner on it. A linear attack over
        // 120 ms is visible as a kink at 120 fps.
        const u = age / attack
        total += deg * u * u * (3 - 2 * u)
      } else if (age < attack + decay) {
        const u = (age - attack) / decay
        // Ease-out quadratic: fast off the peak, long tail. §7 asks for a 400 ms
        // decay that reads as a release, not a fade.
        const w = 1 - u
        total += deg * w * w
      } else {
        punchDeg[i] = 0
        punchAge[i] = 0
      }
    }
    return total
  }

  /** Sum the live shakes and age them by `step`. Returns a unitless intensity. */
  function stepShakes(step: Seconds): number {
    let total = 0
    for (let i = 0; i < SHAKE_SLOTS; i++) {
      const dur = shakeDur[i]!
      if (dur <= 0) continue
      const age = shakeAge[i]! + step
      shakeAge[i] = age
      if (age >= dur) {
        shakeDur[i] = 0
        shakeAmp[i] = 0
        shakeAge[i] = 0
        continue
      }
      const w = 1 - age / dur
      // Squared falloff: an impact should be mostly over in the first third of
      // its stated duration and merely settling for the rest.
      total += shakeAmp[i]! * w * w
    }
    return total
  }

  function snapTo(): void {
    springPosVel.set(0, 0, 0)
    springAimVel.set(0, 0, 0)
    springPos.copy(desiredPos)
    springAim.copy(desiredAim)
    smoothUp.copy(targetUp)
  }

  const rig: ICameraRig & Subsystem = {
    name: 'game/camera',
    camera,

    get swingDegPerSec(): number {
      return swingDegPerSec
    },

    // -----------------------------------------------------------------------
    follow(kart: IKart, step: Seconds): void {
      if (step <= 0) return
      lastFollowTick = ctx.clock.tick
      elapsed += step

      const reduced = ctx.settings.reducedMotion
      const state = kart.state
      const speed = Math.abs(state.speed)
      const speedNorm = clamp(speed / SPEED_REFERENCE, 0, 1.25)

      // --- 1. the frame the rig hangs off ---------------------------------
      chassisForward.set(0, 0, -1).applyQuaternion(state.quaternion)

      /*
       * The follow direction is the chassis heading blended toward the
       * DIRECTION OF TRAVEL, and the blend is what makes a drift legible.
       *
       * Sitting behind the chassis keeps the kart pointing up the screen, which
       * is exactly wrong for §7's drift layer: a kart at 20° of slip looks
       * perfectly straight and the sparks come off the sides for no visible
       * reason. Sitting behind the velocity vector leaves the chassis visibly
       * rotated in frame, which is the read. It is only a partial blend because
       * a full one turns the camera into a spectator of a spin.
       */
      const vlen = state.velocity.length()
      if (vlen > 2.5) {
        travelForward.copy(state.velocity).multiplyScalar(1 / vlen)
        const blend = state.drift.active ? 0.6 : 0.25
        followForward.copy(chassisForward).lerp(travelForward, blend)
      } else {
        followForward.copy(chassisForward)
      }
      if (followForward.lengthSq() < 1e-6) followForward.copy(chassisForward)
      followForward.normalize()

      // --- 2. where the road is -------------------------------------------
      let haveRoad = false
      if (track !== null) {
        track.locate(state.position, loc)
        track.sample(loc.t, here)
        const aimDist = Math.min(
          AIM_AHEAD_BASE + speed * AIM_AHEAD_PER_SPEED,
          AIM_AHEAD_MAX,
        )
        // Look-behind samples BEHIND on the same axis, so a reversed camera
        // still aims down the road rather than at the inside of a cliff.
        const dirSign = lookBack > 0.5 ? -1 : 1
        track.sample(loc.t + (dirSign * aimDist) / track.length, ahead)
        roadAim
          .copy(ahead.position)
          .addScaledVector(ahead.right, track.racingLine(loc.t + (dirSign * aimDist) / track.length))
          .addScaledVector(ahead.normal, AIM_HEIGHT)
        haveRoad = true
      }

      // --- 3. the horizon --------------------------------------------------
      /*
       * §6: the horizon rolls with the road. `TrackSample.normal` is already
       * rotated by the bank, so adopting it IS the roll — there is no separate
       * roll angle to compute and therefore no second place for the bank's sign
       * to be got wrong.
       *
       * Airborne, the road normal under a kart that has left the arch is
       * whatever the projection happens to find; the rig holds the last horizon
       * instead, which is what a real chase camera does over a crest.
       */
      const rollGain = reduced ? ROLL_GAIN_REDUCED : ROLL_GAIN
      if (haveRoad && state.grounded) {
        targetUp.set(0, 1, 0).lerp(here.normal, rollGain).normalize()
      } else {
        targetUp.copy(smoothUp)
      }
      const upOmega = reduced ? UP_OMEGA_REDUCED : UP_OMEGA
      smoothUp.lerp(targetUp, 1 - Math.exp(-upOmega * step)).normalize()
      if (smoothUp.lengthSq() < 1e-6) smoothUp.set(0, 1, 0)

      // --- 4. look-behind ---------------------------------------------------
      /*
       * `InputFrame.look < 0` is look-behind. The rig does NOT apply
       * `Settings.invertLook` — inversion is a device-to-intent mapping and
       * belongs to whoever produced the frame. Applying it in two places is the
       * same class of bug the STEERING SIGN section exists to prevent: both
       * negations look correct in isolation and only one of them is.
       */
      const rawLook = input !== null ? input.frame.look : 0
      const wantBack = clamp(-rawLook, 0, 1)
      // Fast in, slower out: glancing back should be immediate, returning to the
      // race should not whip.
      const lookOmega = wantBack > lookBack ? 12 : 7
      lookBack += (wantBack - lookBack) * (1 - Math.exp(-lookOmega * step))
      const faceSign = 1 - 2 * lookBack

      // --- 5. desired pose --------------------------------------------------
      const distance = CHASE_DISTANCE + CHASE_DISTANCE_SPEED * speedNorm
      const height = CHASE_HEIGHT + CHASE_HEIGHT_SPEED * speedNorm
      desiredPos
        .copy(state.position)
        .addScaledVector(followForward, -distance * faceSign)
        .addScaledVector(smoothUp, height)

      const aimDist = Math.min(AIM_AHEAD_BASE + speed * AIM_AHEAD_PER_SPEED, AIM_AHEAD_MAX)
      noseAim
        .copy(state.position)
        .addScaledVector(followForward, aimDist * faceSign)
        .addScaledVector(smoothUp, AIM_HEIGHT)
      if (haveRoad) {
        // Off the road the road-ahead point is no longer where the kart is going
        // and following it hides the kart behind a cliff. Weight collapses.
        const w = loc.onTrack ? AIM_ROAD_WEIGHT : AIM_ROAD_WEIGHT * 0.35
        desiredAim.copy(noseAim).lerp(roadAim, w)
      } else {
        desiredAim.copy(noseAim)
      }

      // --- 6. teleport detection -------------------------------------------
      /*
       * A respawn or a harness `seek` moves the kart hundreds of metres between
       * two ticks. Springing through that is a full-screen whip-pan that also
       * spikes `swingDegPerSec` — the rig would fail its own nausea gate for a
       * reason that has nothing to do with driving. The event subscription
       * catches the respawn path; this distance test catches everything else.
       */
      if (!needsSnap && prevKartPos.distanceToSquared(state.position) > TELEPORT_METRES * TELEPORT_METRES) {
        needsSnap = true
      }
      prevKartPos.copy(state.position)

      if (needsSnap) {
        snapTo()
        needsSnap = false
        // Establish an orientation before the swing metric can measure against
        // it, or the first tick after a respawn reports a 180° swing.
        camera.up.copy(smoothUp)
        camera.position.copy(springPos)
        camera.lookAt(springAim)
        prevQuat.copy(camera.quaternion)
      } else {
        springStep(springPos, springPosVel, desiredPos, reduced ? POS_OMEGA_REDUCED : POS_OMEGA, step)
        springStep(springAim, springAimVel, desiredAim, reduced ? LOOK_OMEGA_REDUCED : LOOK_OMEGA, step)
      }

      // --- 7. base pose -----------------------------------------------------
      camera.up.copy(smoothUp)
      camera.position.copy(springPos)
      camera.lookAt(springAim)
      desiredQuat.copy(camera.quaternion)

      // Rate-limit the BASE pose only. See MAX_SWING_DEG_PER_SEC.
      const maxSwing = (reduced ? MAX_SWING_DEG_PER_SEC_REDUCED : MAX_SWING_DEG_PER_SEC) / RAD2DEG
      const baseAngle = prevQuat.angleTo(desiredQuat)
      const allowed = maxSwing * step
      if (baseAngle > allowed && baseAngle > 1e-6) {
        camera.quaternion.slerpQuaternions(prevQuat, desiredQuat, allowed / baseAngle)
      }

      // --- 8. additive channels, applied last, decaying to exactly zero -----
      let shakeLevel = stepShakes(step)

      /*
       * Continuous surface rumble. `Kerb` at 0.06 and `Gravel` at 0.09 are what
       * make the road surface readable through the camera as well as through
       * the tyres — §7 wants the player to know what is under them without
       * looking down, and the camera is one of the channels that says so.
       */
      if (state.grounded) {
        const rough = SURFACE_PROPS[state.surface].roughness
        shakeLevel += rough * clamp(speed / RUMBLE_SPEED_REFERENCE, 0, 1.4) * RUMBLE_GAIN
      }
      if (reduced) shakeLevel = 0

      if (shakeLevel > 0) {
        const nx = noise(0, 2, 4, elapsed)
        const ny = noise(1, 3, 5, elapsed)
        // Axes are captured from the UNSHAKEN pose, so the rotational and
        // positional offsets share one frame instead of chasing each other.
        camLocalRight.set(1, 0, 0).applyQuaternion(camera.quaternion)
        camLocalUp.set(0, 1, 0).applyQuaternion(camera.quaternion)

        shakeQuat.setFromAxisAngle(camLocalRight, ny * shakeLevel * SHAKE_RADIANS)
        camera.quaternion.premultiply(shakeQuat)
        shakeQuat.setFromAxisAngle(camLocalUp, nx * shakeLevel * SHAKE_RADIANS)
        camera.quaternion.premultiply(shakeQuat)

        camera.position
          .addScaledVector(camLocalRight, nx * shakeLevel * SHAKE_METRES)
          .addScaledVector(camLocalUp, ny * shakeLevel * SHAKE_METRES)
      }

      let punch = stepPunches(step)
      if (reduced) punch *= FOV_PUNCH_REDUCED_SCALE
      const fov = BASE_FOV + clamp(punch, -MAX_FOV_PUNCH, MAX_FOV_PUNCH)
      if (Math.abs(camera.fov - fov) > 1e-4) {
        camera.fov = fov
        camera.updateProjectionMatrix()
      }

      // --- 9. the nausea metric --------------------------------------------
      /*
       * Measured on the FINAL orientation, after the additive channels, because
       * that is the rotation the eye received. A rig that is smooth underneath
       * and violently shaken on top is still nauseating, and a metric that
       * excused the shake would report a comfortable number for an
       * uncomfortable camera — which is the exact failure mode CLAUDE.md
       * describes for every other instrument in this project.
       */
      swingDegPerSec = (prevQuat.angleTo(camera.quaternion) * RAD2DEG) / step
      prevQuat.copy(camera.quaternion)

      camera.updateMatrixWorld()
    },

    // -----------------------------------------------------------------------
    addFovPunch(degrees: number, attackMs: number, decayMs: number): void {
      if (!Number.isFinite(degrees) || degrees === 0) return
      const attack = Math.max(0.001, attackMs / 1000)
      const decay = Math.max(0.001, decayMs / 1000)

      let slot = -1
      let weakest = Infinity
      for (let i = 0; i < PUNCH_SLOTS; i++) {
        if (punchDeg[i] === 0) {
          slot = i
          break
        }
        // No free slot: evict the one with the least left to give, so a burst of
        // impulses degrades by dropping the quietest rather than the newest.
        const remaining = Math.abs(punchDeg[i]!) * (1 - punchAge[i]! / (punchAttack[i]! + punchDecay[i]!))
        if (remaining < weakest) {
          weakest = remaining
          slot = i
        }
      }
      punchDeg[slot] = degrees
      punchAttack[slot] = attack
      punchDecay[slot] = decay
      punchAge[slot] = 0
    },

    addShake(intensity: number, durationMs: number): void {
      if (!Number.isFinite(intensity) || intensity <= 0 || durationMs <= 0) return
      const dur = durationMs / 1000

      let slot = -1
      let weakest = Infinity
      for (let i = 0; i < SHAKE_SLOTS; i++) {
        if (shakeDur[i]! <= 0) {
          slot = i
          break
        }
        const w = 1 - shakeAge[i]! / shakeDur[i]!
        const remaining = shakeAmp[i]! * w * w
        if (remaining < weakest) {
          weakest = remaining
          slot = i
        }
      }
      shakeAmp[slot] = intensity
      shakeDur[slot] = dur
      shakeAge[slot] = 0
    },

    // -----------------------------------------------------------------------
    build(): void {
      // Nothing to allocate on the GPU. The camera itself is built in the
      // factory so a caller may wire `ctx.scene`/renderer against it before the
      // lifecycle runs.
    },

    link(services: GameServices): void {
      track = services.track
      input = services.input
      fallbackKart = services.kartById(services.playerKartId)
      needsSnap = true

      /*
       * A respawn is a discrete moment, so it arrives on the bus rather than
       * being polled. Without it the rig only notices via the 3 m distance test,
       * which is one tick late — and one tick of a 300 m whip-pan is a frame
       * that gets screenshotted.
       */
      unsubscribeRespawn = ctx.events.on('kart:respawn', (payload) => {
        if (fallbackKart !== null && payload.kartId === fallbackKart.identity.id) needsSnap = true
      })
    },

    fixedUpdate(step: Seconds): void {
      /*
       * FALLBACK, not the primary path.
       *
       * `follow` is `game/`'s to call, and `game/race.ts` calls it with whatever
       * kart the view is currently on. But the contract's fixedUpdate order puts
       * the camera last precisely so it can see the finished tick, and a rig
       * that silently freezes when nobody calls `follow` is a camera bug with no
       * error message. So: if this tick already had a `follow`, do nothing;
       * otherwise drive the player kart. The channels still decay either way,
       * because they decay inside `follow`.
       */
      if (lastFollowTick === ctx.clock.tick) return
      if (fallbackKart === null) return
      rig.follow(fallbackKart, step)
    },

    lateUpdate(): void {
      /*
       * Aspect only. The transform is fixed-step (see the file header). The
       * canvas is read directly rather than through `renderer.getSize`, which
       * requires a `Vector2` out-parameter this would have to keep alive for the
       * one number it wants.
       */
      const el = ctx.renderer.domElement
      const w = el.clientWidth
      const h = el.clientHeight
      if (w > 0 && h > 0) {
        const aspect = w / h
        if (Math.abs(camera.aspect - aspect) > 1e-6) {
          camera.aspect = aspect
          camera.updateProjectionMatrix()
        }
      }
    },

    dispose(): void {
      if (unsubscribeRespawn !== null) {
        unsubscribeRespawn()
        unsubscribeRespawn = null
      }
      camera.removeFromParent()
      track = null
      input = null
      fallbackKart = null
      punchDeg.fill(0)
      punchAge.fill(0)
      shakeAmp.fill(0)
      shakeDur.fill(0)
      shakeAge.fill(0)
      swingDegPerSec = 0
      needsSnap = true
      lastFollowTick = -1
    },
  }

  return rig
}
