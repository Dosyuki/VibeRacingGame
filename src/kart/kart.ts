import { Matrix4, Object3D, Quaternion, Vector3 } from 'three'

import {
  SURFACE_PROPS,
  Surface,
  type BoostSource,
  type Ctx,
  type DriftTier,
  type GameServices,
  type HitKind,
  type IKart,
  type InputFrame,
  type KartFactory,
  type KartIdentity,
  type KartState,
  type Seconds,
  type StartSlot,
  type Subsystem,
  type TrackLocation,
  type TrackSample,
} from '../types'

/*
 * The numbers in this file describe a deliberately small, heavy kart.  They
 * are kept together because changing one side of the tyre/load relationship in
 * isolation is the easiest way to make a drift either impossible or dominant.
 */
const MASS = 260
const GRAVITY = 9.81
const YAW_INERTIA = 185
const WHEEL_RADIUS = 0.36
const WHEEL_INERTIA = 1.55
const HALF_TRACK = 0.64
/*
 * The mass centre sits AHEAD of the wheelbase midpoint, and those four
 * centimetres are the whole reason this kart stopped spinning.
 *
 * Chassis attitude is taken from the averaged road normal (see the basis built
 * at the end of `step`), so there is NO pitch or roll degree of freedom: all
 * four springs sit at the same ray length whenever the road under all four of
 * them is flat, and carry 637.65 N each, statically and at 7.5 m/s^2 of lateral
 * acceleration alike. ON A FLAT PLANE load transfer is therefore exactly zero —
 * 1275 N front, 1275 N rear, cornering or not — and both axles have exactly
 * half the grip.
 *
 * That qualifier is load-bearing and an earlier version of this comment did not
 * have it: it claimed zero transfer as a measured fact about the kart, when the
 * only instrument that had been pointed at it was a flat-plane bench, which
 * cannot show pitch-curvature transfer by construction. The rays are cast from
 * four points 1.40 m apart in the ROAD's frame, so road pitch curvature lands
 * entirely as axle load transfer, and on this circuit it is large. Measured per
 * wheel from the published `compression`, with a controller holding the line:
 *
 *   where                                front    rear   rear's share
 *   t=0.02  hardpan straight, flat      1315 N  1275 N       49%
 *   t=0.15  dune-sweep, elevation       1582 N   971 N       38%
 *   t=0.62  The Wall, +20 deg bank      1274 N  1821 N       59%
 *
 * With capacity fixed at half each on the flat, whichever axle is ASKED for
 * more than half lets go first, and that split is pure lever arithmetic: the
 * rear carries FRONT_AXLE / wheelbase of the cornering force. At the old
 * 0.72 / -0.68 the rear was asked for 51.4% against its 50%, so on a
 * rear-driven kart the rear saturated first — and with both axles then making
 * the same peak force, that left a net yaw moment of
 * (0.72 - 0.68) * 1122 N = +45 N.m INTO the turn with no restoring term at any
 * slip angle beyond it. The kart was divergent by construction, and a human
 * playing it reported exactly that: "the road is too slippery, it's kind of
 * like it drifts by itself".
 *
 * Swapping the two makes the rear share 48.6% against its 50% and turns that
 * +45 N.m into -45 N.m of restoring moment. The wheelbase is unchanged at
 * 1.40 m, so no geometry, model, suspension or camera number moves with it.
 * Measured: understeer gradient K0 -0.0159 -> +0.0741 deg/(m/s^2) (it was
 * OVERSTEERING), usable steer while holding 22 m/s 0.343 -> 0.675, and
 * acceleration bit-identical.
 *
 * Two things that arithmetic does NOT survive, both since fixed elsewhere:
 *
 *  - "both axles then make the same peak force" is only true off the throttle.
 *    Under throttle the friction circle in `step` used to cut the DRIVEN rear
 *    to peak/sqrt(2) while the undriven front kept all of it, which turns the
 *    -45 N.m back into +192 N.m the wrong way — 4.3x the magnitude, opposite
 *    sign, and it does not decay. That is fixed where the circle is applied,
 *    because it is a property of the circle and not of these two numbers.
 *  - at t=0.15 the rear holds 38% of the grip while the levers ask it for
 *    48.6%, and holding the racing line there at 20 m/s DID depart — after
 *    2.56 s, through a corner of 83 m radius, well inside the 7.4 m/s^2 the
 *    same kart sustains on the flat. That departure was the friction-circle
 *    bug above, arriving early because the rear started with a quarter less
 *    grip than the levers assume; with the circle fixed the same run holds the
 *    line for the full 4 s at |body slip| under 5 deg. Moving the mass centre
 *    forward to cover the transfer itself was measured too (0.58 / -0.82,
 *    wheelbase held): it costs max sustained lateral acceleration
 *    7.68 -> 6.65 m/s^2 and pushes the minimum stable radius at 20 m/s from
 *    52.7 m to 60.4 m, which puts more of the circuit out of reach than the
 *    load transfer does. These two stay where they are — but they are now a
 *    choice made against a road, not against a flat plane.
 *
 * If load transfer is ever given a degree of freedom, re-measure BOTH numbers
 * together, and re-measure them at t=0.02, t=0.15 and t=0.62 rather than on the
 * bench. A rearward mass centre is only wrong here because the springs cannot
 * tell the two axles apart on a flat road.
 */
const FRONT_AXLE = 0.68
const REAR_AXLE = -0.72

// Section 6 fixes total travel at 0.09 m.  REST_LENGTH sits inside that range;
// the remaining constants merely name its hard endpoints.
const SUSPENSION_TRAVEL = 0.09
const REST_LENGTH = 0.205
const FULL_EXTENSION = REST_LENGTH + SUSPENSION_TRAVEL * 0.5
const BOTTOM_LENGTH = REST_LENGTH - SUSPENSION_TRAVEL * 0.5
const SPRING_RATE = 25_000
const DAMPER_RATE = 2_250
// `REST_LENGTH` is the unloaded spring length.  Placing the chassis there left
// all four springs at zero force, so every seek began with a one-frame fall and
// a large damper transient instead of the requested driving state.
const STATIC_SAG = MASS * GRAVITY / (4 * SPRING_RATE)
const STATIC_RAY_LENGTH = REST_LENGTH - STATIC_SAG
const RIDE_HEIGHT = WHEEL_RADIUS + STATIC_RAY_LENGTH

/*
 * 2200 N, and the number to read next to it is 1122: two rear wheels times
 * 637.65 N of static load times 0.88 grip is the ENTIRE longitudinal budget the
 * rear axle has. Anything the engine asks for beyond that is not thrust, it is
 * wheelspin, and the friction circle below pays for it out of the rear's
 * LATERAL force — the axle the kart corners on.
 *
 * At the old 3450 N the demand was 3.1x that budget: the contact patch ran at
 * 278.7 m/s while the kart did 21.2, the rear was slip-saturated for 99.9% of a
 * 0 -> 25 m/s run, and the spin stored in the wheels then discharged back into
 * the chassis as a top-speed overshoot to 42.3 m/s that took 150 s of held
 * throttle to decay to its real 28.97 — the stock kart never reached steady
 * state inside a race at all. 0 -> 25 m/s is UNCHANGED at 6.97 s by this
 * reduction, because the 1250 N removed was never doing any of the
 * accelerating. What moves is genuine terminal speed, 28.97 -> 27.80 m/s
 * (reached in 20 s, and flat), and usable steer at full throttle: 0.087 -> 0.389 at
 * 14 m/s, and 0.288 -> full lock at 26 m/s.
 *
 * Do NOT instead clamp `driveForce` to the rear's capacity and keep 3450. That
 * was measured: it pins the rear at exactly its longitudinal limit whenever the
 * engine asks for more, so the friction circle has ZERO lateral budget left
 * below 21.3 m/s — the same lost corner wheelspin was causing — while also
 * costing 0 -> 25 m/s 6.97 -> 7.98 s. Both together are worse than either
 * (9.95 s, no extra steer). Lowering the DEMAND is the only version of this
 * that frees lateral force.
 *
 * Re-measured since, against a version of the clamp that subtracts the LATERAL
 * demand first rather than clamping to the whole circle: it does fix the
 * throttle-triggered departure, and it costs 0 -> 25 m/s 6.96 -> 9.94 s at the
 * plain budget and 8.28 s at 1.3x it. The friction circle's allocation carries
 * that fix for nothing instead — see the note where the circle is applied.
 * 1122 is still the number to read next to 2200, and the rear is still asked
 * for twice what it has; what changed is only what the tyre does about it.
 */
const ENGINE_FORCE = 2_200
const REVERSE_FORCE = 1_450
const BRAKE_TORQUE = 620
const BASE_TOP_SPEED = 31.5
const AERO_DRAG = 0.00108
const ROLLING_ACCEL = 0.16
const MAX_STEER = 0.48
const STEER_FADE_SPEED = 34
const TYRE_SLIP_ANGLE = 0.115
const TYRE_SLIP_RATIO = 0.13
const MAX_TYRE_LOAD = MASS * GRAVITY * 0.75
/*
 * The chassis cap, and it is NOT the same number as `MAX_TYRE_LOAD`.
 *
 * `MAX_TYRE_LOAD` only ever limited the load handed to the brush model. The
 * chassis received the full, unclamped spring+damper force, so a single-tick
 * damper spike of ~24 kN on one wheel put 24_000 / 260 * step = 0.77 m/s of
 * upward delta-v into the body — the kart flicked itself into the air off a
 * feature it should have absorbed. Capping at 2 g per wheel still lets four
 * wheels arrest 8 g, which is more than any drop on this circuit asks for,
 * while leaving `MAX_TYRE_LOAD` strictly the smaller of the two so the guard
 * below keeps doing its own separate job.
 */
const MAX_SUSPENSION_FORCE = MASS * GRAVITY * 2

const DRIFT_MIN_STEER = 0.18
const DRIFT_MIN_SPEED = 7
const DRIFT_SLIP_GATE = 0.095
const DRIFT_CARRY_SECONDS = 0.34
const TIER_ONE_SECONDS = 0.42
const TIER_TWO_SECONDS = 0.94
const TIER_THREE_SECONDS = 1.52

const PAD_BOOST_SECONDS = 0.85
const PAD_BOOST_STRENGTH = 1.12

// Front-left, front-right, rear-left, rear-right.  Typed arrays make the hot
// loop's data layout explicit and, unlike a list of wheel objects, cannot grow.
const WHEEL_RIGHT = new Float64Array([-HALF_TRACK, HALF_TRACK, -HALF_TRACK, HALF_TRACK])
const WHEEL_FORWARD = new Float64Array([FRONT_AXLE, FRONT_AXLE, REAR_AXLE, REAR_AXLE])

interface MutableWheelState {
  compression: number
  steerAngle: number
  spin: number
  grounded: boolean
  surface: Surface
  slip: number
}

interface MutableDriftState {
  active: boolean
  direction: -1 | 0 | 1
  charge: Seconds
  tier: DriftTier
  slipAngle: number
}

interface MutableBoostState {
  active: boolean
  remaining: Seconds
  strength: number
  source: BoostSource
}

interface MutableKartState {
  position: Vector3
  quaternion: Quaternion
  velocity: Vector3
  speed: number
  surface: Surface
  grounded: boolean
  drift: MutableDriftState
  boost: MutableBoostState
  wheels: [MutableWheelState, MutableWheelState, MutableWheelState, MutableWheelState]
  stunTime: Seconds
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value
}

function makeTrackSample(): TrackSample {
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

function makeTrackLocation(): TrackLocation {
  return { t: 0, lateral: 0, height: 0, onTrack: true, checkpointIndex: 0 }
}

function makeWheel(): MutableWheelState {
  return {
    compression: 0.5,
    steerAngle: 0,
    spin: 0,
    grounded: true,
    surface: Surface.DustyAsphalt,
    slip: 0,
  }
}

/**
 * Raycast suspension and brush tyres for one arcade kart.
 *
 * Nothing in `step` constructs a temporary.  Scratch storage belongs to this
 * factory instance rather than the module so synchronous event handlers may
 * safely step or respawn a different kart without trampling the first one's
 * contact data.
 */
export const createKart: KartFactory = (
  ctx: Ctx,
  identity: KartIdentity,
  slot: StartSlot,
): IKart & Subsystem => {
  const modelRoot = new Object3D()
  const fxRoot = new Object3D()
  const audioRoot = new Object3D()
  modelRoot.name = `kart/${identity.id}/model`
  fxRoot.name = `kart/${identity.id}/fx`
  audioRoot.name = `kart/${identity.id}/audio`

  const initialUp = new Vector3(0, RIDE_HEIGHT, 0).applyQuaternion(slot.orientation)
  const position = new Vector3().copy(slot.position).add(initialUp)
  const quaternion = new Quaternion().copy(slot.orientation)
  const velocity = new Vector3()

  const wheels: [MutableWheelState, MutableWheelState, MutableWheelState, MutableWheelState] = [
    makeWheel(),
    makeWheel(),
    makeWheel(),
    makeWheel(),
  ]
  const drift: MutableDriftState = {
    active: false,
    direction: 0,
    charge: 0,
    tier: 0,
    slipAngle: 0,
  }
  const boost: MutableBoostState = {
    active: false,
    remaining: 0,
    strength: 1,
    source: 'none',
  }
  const state: MutableKartState = {
    position,
    quaternion,
    velocity,
    speed: 0,
    surface: Surface.DustyAsphalt,
    grounded: true,
    drift,
    boost,
    wheels,
    stunTime: 0,
  }

  let track: GameServices['track'] | null = null
  let previousDriftButton = false
  let driftCarry = 0
  let yawRate = 0
  let suspensionHistoryValid = false
  let built = false

  const wheelOmega = new Float64Array(4)
  const previousRayLength = new Float64Array(4)
  previousRayLength.fill(STATIC_RAY_LENGTH)
  const wheelLocation = [makeTrackLocation(), makeTrackLocation(), makeTrackLocation(), makeTrackLocation()]
  const wheelSample = [makeTrackSample(), makeTrackSample(), makeTrackSample(), makeTrackSample()]
  const centreLocation = makeTrackLocation()
  const centreSample = makeTrackSample()
  const respawnSample = makeTrackSample()

  // Per-instance maths scratch.  Vector3 methods mutate these objects and do
  // not allocate, which keeps both direct `step` and composed fixed updates
  // within the contract's measured allocation boundary.
  const forward = new Vector3()
  const right = new Vector3()
  const up = new Vector3()
  const mount = new Vector3()
  const wheelForward = new Vector3()
  const wheelRight = new Vector3()
  const backward = new Vector3()
  const basis = new Matrix4()

  function syncRoots(): void {
    modelRoot.position.copy(position)
    modelRoot.quaternion.copy(quaternion)
    fxRoot.position.copy(position)
    fxRoot.quaternion.copy(quaternion)
    audioRoot.position.copy(position)
    audioRoot.quaternion.copy(quaternion)
  }

  function endBoost(): void {
    if (!boost.active) return
    boost.active = false
    boost.remaining = 0
    boost.strength = 1
    boost.source = 'none'
    ctx.events.emit('boost:end', { kartId: identity.id })
  }

  function clearDrift(): void {
    drift.active = false
    drift.direction = 0
    drift.charge = 0
    drift.tier = 0
    drift.slipAngle = 0
    driftCarry = 0
  }

  function setTier(next: 1 | 2 | 3): void {
    if (next <= drift.tier) return
    drift.tier = next
    ctx.events.emit('drift:tier', { kartId: identity.id, tier: next })
  }

  const kart: IKart & Subsystem = {
    name: `kart/${identity.id}`,
    identity,
    state: state as Readonly<KartState>,
    modelRoot,
    fxRoot,
    audioRoot,

    build(): void {
      if (built) return
      built = true
      ctx.scene.add(modelRoot, fxRoot, audioRoot)
      syncRoots()
    },

    link(services: GameServices): void {
      track = services.track
      // Resolve the real centre surface only after services exist.  The slot's
      // `t` alone cannot tell us the grid's lateral surface.
      services.track.locate(position, centreLocation)
      state.surface = services.track.surfaceAt(centreLocation.t, centreLocation.lateral)
      for (let i = 0; i < 4; i++) wheels[i]!.surface = state.surface
    },

    step(step: Seconds, input: Readonly<InputFrame>): void {
      if (track === null || step <= 0) return

      if (state.stunTime > 0) state.stunTime = Math.max(0, state.stunTime - step)
      const steerIntent = state.stunTime > 0 ? 0 : clamp(input.steer, -1, 1)
      const throttle = clamp(input.throttle, 0, 1)
      const brake = clamp(input.brake, 0, 1)

      // These are chassis axes, not track axes.  Keeping tyre velocity in the
      // chassis frame is what lets slip angle exist when the kart yaws away
      // from its direction of travel.
      forward.set(0, 0, -1).applyQuaternion(quaternion).normalize()
      right.set(1, 0, 0).applyQuaternion(quaternion).normalize()
      up.set(0, 1, 0).applyQuaternion(quaternion).normalize()

      track.locate(position, centreLocation)
      track.sample(centreLocation.t, centreSample)
      const previousSurface = state.surface
      state.surface = track.surfaceAt(centreLocation.t, centreLocation.lateral)
      if (state.surface !== previousSurface) {
        ctx.events.emit('surface:change', {
          kartId: identity.id,
          from: previousSurface,
          to: state.surface,
        })
        if (state.surface === Surface.BoostPad) {
          kart.applyBoost(PAD_BOOST_SECONDS, PAD_BOOST_STRENGTH, 'pad')
        }
      }

      const wasGrounded = state.grounded
      let groundedCount = 0
      let normalX = 0
      let normalY = 0
      let normalZ = 0
      let totalForceX = 0
      let totalForceY = -MASS * GRAVITY
      let totalForceZ = 0
      let yawMoment = 0

      const speedForward = velocity.dot(forward)
      state.speed = speedForward
      const speedAbs = velocity.length()
      /*
       * The fade is a function of the speed the TYRES see, which is the
       * chassis-PLANE speed, not its forward projection.
       *
       * Taken from `speedForward` it RELAXED as the kart slid: forward speed
       * falls during a slide while road speed does not, so the front wheel
       * angle grew at exactly the moment the front was already asking for too
       * much. That is a positive feedback loop, and it sat on top of a
       * divergent yaw mode. At 22 m/s commanding 0.35 the cap is 0.0638 rad;
       * the sliding kart was measured averaging 0.0735.
       *
       * `speedAbs` is deliberately NOT used here even though it is right
       * above: it carries the vertical component, and a landing is not extra
       * road speed for a steered wheel to fade against.
       */
      const steerFade = clamp(
        1 - Math.hypot(speedForward, velocity.dot(right)) / STEER_FADE_SPEED,
        0.38,
        1,
      )
      const frontSteer = steerIntent * MAX_STEER * steerFade * (drift.active ? 1.12 : 1)

      const driftPressed = input.drift && !previousDriftButton
      if (
        driftPressed &&
        Math.abs(steerIntent) >= DRIFT_MIN_STEER &&
        speedAbs >= DRIFT_MIN_SPEED &&
        wasGrounded &&
        state.stunTime <= 0
      ) {
        drift.active = true
        drift.direction = steerIntent > 0 ? 1 : -1
        drift.charge = 0
        drift.tier = 0
        driftCarry = DRIFT_CARRY_SECONDS
        // A vertical impulse is physical state, not a visual-only animation:
        // unloading the tyres briefly is the reliable initiation cue and makes
        // the ensuing rotation come from the front/rear force imbalance.
        velocity.addScaledVector(centreSample.normal, 1.72)
        ctx.events.emit('drift:start', { kartId: identity.id, direction: drift.direction })
      }
      previousDriftButton = input.drift

      for (let i = 0; i < 4; i++) {
        const wheel = wheels[i]!
        const leverRight = WHEEL_RIGHT[i]!
        const leverForward = WHEEL_FORWARD[i]!

        mount.copy(position).addScaledVector(right, leverRight).addScaledVector(forward, leverForward)
        track.locate(mount, wheelLocation[i]!)
        const location = wheelLocation[i]!
        const sample = wheelSample[i]!
        track.sample(location.t, sample)
        wheel.surface = track.surfaceAt(location.t, location.lateral)
        const props = SURFACE_PROPS[wheel.surface]

        // Roughness perturbs the ray target, not the chassis after integration.
        // That distinction lets the SPRING filter the bump instead of
        // teleporting the body, while the fixed phase keeps it deterministic.
        // Both tyres on an axle cross the same transverse road feature at the
        // same longitudinal station.  Giving left and right unrelated phases
        // injected a permanent yaw moment even on the harness' perfectly flat
        // straight, which then made the saturated tyre response chaotic.
        const bumpPhase = location.t * track.length * 5.7 + (i >> 1) * 1.91 + identity.id * 0.73
        const bump = Math.sin(bumpPhase) * props.roughness * 0.42
        /*
         * TWO ray lengths, and the difference between them is the entire reason
         * the kart used to hover and then slide.
         *
         * `smoothRayLength` measures the chassis against the road SURFACE.
         * `rayLength` adds the roughness profile; the spring and the contact
         * test use that one, so the bump is still felt exactly as before.
         *
         * The DAMPER is fed the smooth ray only. `bump` is a function of
         * distance travelled, so a finite difference of a ray length that
         * contains it yields A*k*v — a damper velocity proportional to SPEED,
         * with k = 5.7 rad/m (a 1.10 m wavelength). On DustyAsphalt that term
         * reached the 638 N static wheel load at just 5.9 m/s, and because the
         * `Math.max(0, …)` below rectifies it, the clipped mean exceeded the
         * kart's weight: the body was pumped to full droop, all four wheels
         * spent half of every tick in the air, tyre load fell to the 120 N
         * floor and the kart slid instead of turning. Achieved lateral
         * acceleration at 14 m/s was 2.4 m/s^2 against the 8.1 the same tyre
         * model produces with its wheels down.
         *
         * A real car does not do this because the tyre's own vertical
         * compliance sits between the road and the damper and swallows
         * short-wavelength input. We have no unsprung mass to model that with,
         * so the difference is taken upstream of the bump instead — that is
         * what this stands in for. The bump still reaches the spring, which is
         * SPRING_RATE * A = 210 N of load variation on DustyAsphalt: rumble,
         * three times too small to ever unload a wheel.
         *
         * Do NOT "fix" a recurrence of this by lowering `roughness` in
         * SURFACE_PROPS. Those values are shared with fx/ and the camera, the
         * sand ones were raised on purpose, and lowering them only moves the
         * onset speed instead of removing the mechanism.
         */
        const smoothRayLength =
          (mount.x - sample.position.x) * sample.normal.x +
          (mount.y - sample.position.y) * sample.normal.y +
          (mount.z - sample.position.z) * sample.normal.z -
          WHEEL_RADIUS
        const rayLength = smoothRayLength - bump
        wheel.grounded = rayLength <= FULL_EXTENSION

        // The damper history is kept OUTSIDE the grounded branch and over the
        // same quantity every tick, airborne or not.  Parking it at
        // FULL_EXTENSION whenever a wheel lifted meant the re-contact tick
        // differenced a length the wheel had never been at: up to
        // (0.25 - 0.16) / step = 10.8 m/s, a ~24 kN spike earned by hopping two
        // millimetres over a bump crest.  Tracking the real (clamped) smooth
        // ray makes that tick report the body's actual approach speed.
        const damperRayLength = clamp(smoothRayLength, BOTTOM_LENGTH, FULL_EXTENSION)
        // A pose assignment has no previous contact sample.  Treat its first
        // ray as history rather than manufacturing a damper velocity from the
        // old pose; the next fixed tick then has a real finite difference.
        const compressionSpeed = suspensionHistoryValid
          ? (previousRayLength[i]! - damperRayLength) / step
          : 0
        previousRayLength[i] = damperRayLength

        if (!wheel.grounded) {
          wheel.compression = 0
          wheel.slip = 0
          wheelOmega[i] = wheelOmega[i]! * Math.max(0, 1 - step * 0.3)
          wheel.spin += wheelOmega[i]! * step
          wheel.steerAngle = i < 2 ? frontSteer : 0
          continue
        }

        groundedCount++
        normalX += sample.normal.x
        normalY += sample.normal.y
        normalZ += sample.normal.z
        const springRayLength = clamp(rayLength, BOTTOM_LENGTH, FULL_EXTENSION)
        wheel.compression = clamp((FULL_EXTENSION - springRayLength) / SUSPENSION_TRAVEL, 0, 1)
        // Capped for the chassis, not just for the tyre — see MAX_SUSPENSION_FORCE.
        const springForce = Math.min(
          MAX_SUSPENSION_FORCE,
          Math.max(
            0,
            SPRING_RATE * (REST_LENGTH - springRayLength) + DAMPER_RATE * compressionSpeed,
          ),
        )
        totalForceX += sample.normal.x * springForce
        totalForceY += sample.normal.y * springForce
        totalForceZ += sample.normal.z * springForce

        const steerAngle = i < 2 ? frontSteer : 0
        wheel.steerAngle = steerAngle
        const cs = Math.cos(steerAngle)
        const sn = Math.sin(steerAngle)
        // Positive steer rotates the wheel's forward vector toward chassis
        // right.  This is the sole intent-to-physical-turn conversion.
        wheelForward.copy(forward).multiplyScalar(cs).addScaledVector(right, sn).normalize()
        wheelRight.copy(right).multiplyScalar(cs).addScaledVector(forward, -sn).normalize()

        // Contact velocity includes yaw.  `yawRate > 0` is defined as a right
        // turn, hence a front contact moves right and a right contact moves
        // backward around the centre of mass.
        const contactRightSpeed = velocity.dot(right) + yawRate * leverForward
        const contactForwardSpeed = velocity.dot(forward) - yawRate * leverRight
        const tyreLongSpeed = contactForwardSpeed * cs + contactRightSpeed * sn
        const tyreLatSpeed = contactRightSpeed * cs - contactForwardSpeed * sn
        const slipAngle = Math.atan2(tyreLatSpeed, Math.abs(tyreLongSpeed) + 0.55)
        const slipRatio =
          (wheelOmega[i]! * WHEEL_RADIUS - tyreLongSpeed) / Math.max(2, Math.abs(tyreLongSpeed))

        // A drift is still the same saturated tyre model.  Reducing rear peak
        // and corner stiffness moves the equilibrium to a visible slip angle;
        // there is no sideways position injection or scripted heading change.
        const rearDriftScale = drift.active && i >= 2 ? 0.61 : 1
        // Damper force is allowed to arrest a landing, but it is not a usable
        // tyre load without limit.  Feeding an impact spike straight into the
        // brush model produced forces large enough to reverse the kart through
        // the rearward component of a steered wheel's lateral force.  This is
        // still the tighter of the two caps — `MAX_SUSPENSION_FORCE` bounds what
        // the chassis feels, this bounds what the tyre may grip with — so it is
        // not redundant with the clamp applied to `springForce` above.
        const tyreLoad = Math.min(springForce, MAX_TYRE_LOAD)
        const peakForce = Math.max(120, tyreLoad * props.grip * rearDriftScale)
        let lateralForce = -Math.tanh(slipAngle / (TYRE_SLIP_ANGLE / rearDriftScale)) * peakForce
        let longitudinalForce = Math.tanh(slipRatio / TYRE_SLIP_RATIO) * peakForce

        /*
         * The friction circle, and WHICH of the two components pays for it is
         * the difference between a kart that can be caught and one that ignores
         * the wheel entirely.
         *
         * Scaling both by peak/combined projects the demand radially, which
         * keeps whatever direction the two INDEPENDENT tanh curves happened to
         * land on. When both are saturated that direction is exactly 45
         * degrees, so a longitudinally-saturated driven rear kept only
         * peak/sqrt(2) = 0.707 of its lateral force while the undriven front
         * kept all of it. The lever balance (see FRONT_AXLE) then reads
         *
         *   2 * (0.68 * peak - 0.72 * 0.707 * peak) = +0.342 * peak = +192 N.m
         *
         * INTO the turn, against the -45 N.m the axle split exists to provide,
         * and 192 / (YAW_INERTIA * 1.65) = 0.629 rad/s is a yaw rate the damper
         * at the bottom of `step` balances but cannot remove. Measured on the
         * flat bench at 20 m/s: 0.615 rad/s, held for 5.5 s with the steer at
         * ZERO, 184 degrees of heading gone; off the throttle the same step
         * steer peaks at 5.2 degrees of body slip and is straight again in
         * 0.63 s. It is a THROTTLE-triggered departure, invisible to every
         * steady-state sweep in this file's history, and a human playing it
         * reported it as "then it's like I can't control anything" — which is
         * literal: going from steer 0 to FULL OPPOSITE LOCK with the throttle
         * still down moved the sustained yaw rate by under 0.02 rad/s, because
         * past saturation the front cannot out-lever a rear that has been
         * handed a 29% grip cut it never asked for. Lifting off recovered in
         * 1.88 s and braking in 1.97 s; with the throttle still down, nothing
         * done with the wheel recovered at all.
         *
         * So the overage comes out of LONGITUDINAL only. The two demands are
         * not equally meaningful past their peaks: slip ANGLE is kinematic —
         * it is where the kart is actually going relative to where it points,
         * and it is what the driver steers with — whereas slip RATIO past
         * saturation is wheelspin, an artefact of an engine asking the rear for
         * 2200 N against the 1122 N budget named at ENGINE_FORCE, carrying no
         * information about how much thrust the tyre should make. The total is
         * still bounded by the same circle. Only the allocation changes.
         *
         * Measured against every alternative, same bench, same tick: step steer
         * 0.85 held 3 s at 20 m/s under throttle, then the steer RELEASED to
         * zero with the throttle still down.
         *
         *   allocation                        turns after release   0->25 m/s
         *   radial, both scaled                     184.0 deg         6.96 s
         *   normalised combined slip                171.6 deg         6.96 s
         *   drive demand capped at rear budget        5.8 deg         9.94 s
         *   drive demand capped at 1.3x budget        5.4 deg         8.28 s
         *   lateral priority (this)                   5.7 deg         6.96 s
         *
         * The second row is the textbook answer — force magnitude from the
         * combined slip, direction along the slip vector — and it is WORSE, not
         * better: it sends nearly all of a spinning rear's force longitudinal
         * and leaves the front's yaw moment completely unopposed. Being the
         * physically honest tyre model does not make it the right one for a
         * chassis with no pitch freedom and a tanh that has no falling branch.
         * Rows three and four are the demand clamp already rejected at
         * ENGINE_FORCE, re-measured: it works, and it still costs exactly what
         * that note says it costs. This one is free, and it does not touch the
         * steady state at all — K0 is bit-identical, and usable steer while
         * holding 22 m/s goes 0.70 -> full lock.
         *
         * What it does NOT fix, so that the next person does not read the good
         * numbers above as a clean bill: while the rear is laterally saturated
         * its longitudinal force is now near zero, so `wheelOmega` below has
         * almost nothing to react the drive torque against and runs away, and
         * the stored spin discharges as thrust once the slide ends. That is the
         * ENGINE_FORCE=3450 top-speed-overshoot failure, and it was ALREADY
         * here — a 3 s deliberate drift then held throttle peaks at 37.1 m/s
         * against a 27.8 m/s terminal with radial clipping and 38.5 with this.
         * Short drifts get better, not worse (0.8 s: 33.6 -> no overshoot at
         * all), because the kart no longer departs on the exit. Fixing the
         * discharge is a change to the wheel model, not to the circle, and it
         * wants its own measurement.
         */
        const combined = Math.hypot(lateralForce, longitudinalForce)
        if (combined > peakForce) {
          longitudinalForce =
            Math.sign(longitudinalForce) *
            Math.sqrt(Math.max(0, peakForce * peakForce - lateralForce * lateralForce))
        }

        const topSpeed = BASE_TOP_SPEED * (boost.active ? boost.strength : 1)
        let driveForce = 0
        if (i >= 2 && throttle > 0) {
          if (speedForward >= -0.5) {
            driveForce =
              ENGINE_FORCE * throttle * clamp(1 - Math.max(0, speedForward) / topSpeed, 0.08, 1)
          } else {
            driveForce = REVERSE_FORCE * throttle
          }
        }
        const brakeSign = Math.abs(wheelOmega[i]!) > 0.15
          ? Math.sign(wheelOmega[i]!)
          : Math.sign(tyreLongSpeed)
        const axleTorque = driveForce * WHEEL_RADIUS * 0.5 - brake * BRAKE_TORQUE * brakeSign
        wheelOmega[i] =
          wheelOmega[i]! +
          (axleTorque - longitudinalForce * WHEEL_RADIUS) / WHEEL_INERTIA * step
        wheel.spin += wheelOmega[i]! * step

        totalForceX +=
          wheelForward.x * longitudinalForce + wheelRight.x * lateralForce
        totalForceY +=
          wheelForward.y * longitudinalForce + wheelRight.y * lateralForce
        totalForceZ +=
          wheelForward.z * longitudinalForce + wheelRight.z * lateralForce
        yawMoment += leverForward * lateralForce - leverRight * longitudinalForce
        wheel.slip = clamp(
          Math.max(Math.abs(slipAngle) / 0.34, Math.abs(slipRatio) / 0.55),
          0,
          1,
        )
      }

      suspensionHistoryValid = true

      state.grounded = groundedCount >= 2
      if (!wasGrounded && state.grounded) {
        const impactSpeed = Math.max(0, -velocity.dot(centreSample.normal))
        ctx.events.emit('kart:land', { kartId: identity.id, impactSpeed, surface: state.surface })
      }

      // Contract surface drag is exactly quadratic at the named reference
      // speed.  Wheel surfaces are averaged so a kart straddling gravel pays a
      // proportional cost instead of flickering between two chassis regimes.
      let surfaceDragAt30 = 0
      for (let i = 0; i < 4; i++) surfaceDragAt30 += SURFACE_PROPS[wheels[i]!.surface].dragAccelAt30
      surfaceDragAt30 *= 0.25
      if (speedAbs > 0.001) {
        const dragAccel =
          AERO_DRAG * speedAbs * speedAbs +
          surfaceDragAt30 * (speedAbs / 30) * (speedAbs / 30) +
          (state.grounded ? ROLLING_ACCEL : 0)
        const dragForce = MASS * dragAccel / speedAbs
        totalForceX -= velocity.x * dragForce
        totalForceY -= velocity.y * dragForce
        totalForceZ -= velocity.z * dragForce
      }

      velocity.x += totalForceX / MASS * step
      velocity.y += totalForceY / MASS * step
      velocity.z += totalForceZ / MASS * step
      position.addScaledVector(velocity, step)

      if (state.grounded) {
        yawRate += yawMoment / YAW_INERTIA * step
        /*
         * This term is doing physical work now. It was not before, and the
         * difference is the reason it is documented rather than deleted.
         *
         * It used to be the only thing between the player and a chassis that
         * was divergent by construction (see FRONT_AXLE). ALL of the apparent
         * understeer was this line: the fitted gradient K0 was NEGATIVE at
         * -0.0159 deg/(m/s^2), and with the term removed the kart departed at
         * every speed and steer tried, including 0.15 at 14 m/s. Above ~26 m/s
         * it supplied more yaw damping than all four tyres combined.
         *
         * With the axle balance fixed, K0 is +0.0741 at every damper value from
         * 0 to 1.65 — the STEADY state no longer needs it. The TRANSIENT does.
         * The brush model is a tanh, so past saturation it returns a constant
         * force and contributes neither yaw stiffness nor yaw damping, and
         * nothing else in the kart contributes either. Step steer 0.4 held for
         * 4 s on the fixed chassis, peak |body slip| in degrees:
         *
         *   damper   16 m/s   20 m/s   24 m/s   31 m/s
         *   0.00       89.8     89.8     90.0     89.9
         *   0.40       89.8     89.8     89.9     14.7
         *   0.60       76.4     89.8     63.5     12.6
         *   0.80        7.3      8.3      9.6     11.3
         *   1.65        4.9      5.6      6.5      8.0
         *
         * Below 0.8 the yaw mode swings the kart to 90 degrees of slip and back
         * again, and 0.80 still costs usable steer at 22 m/s (0.404 against
         * 0.791 here). So the value stands, measured rather than inherited.
         *
         * Raising it is the trap that has already been sprung once here: yaw
         * damping that does not fall off with speed reads as grip and can hide
         * a real balance fault underneath, which is precisely how the axle bug
         * survived a round. If this number ever seems to want to go UP, what
         * actually changed is somewhere else.
         */
        yawRate *= Math.max(0, 1 - step * (drift.active ? 0.75 : 1.65))

        const nl = Math.hypot(normalX, normalY, normalZ)
        if (nl > 0.001) up.set(normalX / nl, normalY / nl, normalZ / nl)
        const yawStep = yawRate * step
        const cy = Math.cos(yawStep)
        const sy = Math.sin(yawStep)
        const fx = forward.x * cy + right.x * sy
        const fy = forward.y * cy + right.y * sy
        const fz = forward.z * cy + right.z * sy
        forward.set(fx, fy, fz)
        // Project onto the contacted road plane.  The suspension supplies the
        // forces; this only keeps the rigid chassis' orientation normal to a
        // bank, as section 6 requires for The Wall.
        forward.addScaledVector(up, -forward.dot(up)).normalize()
        right.crossVectors(forward, up).normalize()
        backward.copy(forward).multiplyScalar(-1)
        basis.makeBasis(right, up, backward)
        quaternion.setFromRotationMatrix(basis).normalize()
      } else {
        yawRate *= Math.max(0, 1 - step * 0.25)
      }

      const newForwardSpeed = velocity.dot(forward)
      const newRightSpeed = velocity.dot(right)
      state.speed = newForwardSpeed
      drift.slipAngle = Math.atan2(newRightSpeed, Math.abs(newForwardSpeed) + 0.2)

      if (drift.active && (!input.drift || state.stunTime > 0)) {
        const releasedTier = drift.tier
        let boostSeconds = 0
        let boostStrength = 1
        if (releasedTier === 1) {
          boostSeconds = 0.72
          boostStrength = 1.08
        } else if (releasedTier === 2) {
          boostSeconds = 1.28
          boostStrength = 1.14
        } else if (releasedTier === 3) {
          boostSeconds = 2.05
          boostStrength = 1.22
        }
        ctx.events.emit('drift:release', {
          kartId: identity.id,
          tier: releasedTier,
          boostSeconds,
        })
        clearDrift()
        if (boostSeconds > 0) kart.applyBoost(boostSeconds, boostStrength, 'drift')
      } else if (drift.active) {
        if (Math.abs(drift.slipAngle) >= DRIFT_SLIP_GATE) {
          driftCarry = DRIFT_CARRY_SECONDS
          drift.charge += step
          if (drift.charge >= TIER_THREE_SECONDS) setTier(3)
          else if (drift.charge >= TIER_TWO_SECONDS) setTier(2)
          else if (drift.charge >= TIER_ONE_SECONDS) setTier(1)
        } else if (driftCarry > 0) {
          driftCarry = Math.max(0, driftCarry - step)
        } else {
          // A long straight while holding drift is a new attempt, not free
          // charge carried indefinitely into the next corner.
          drift.charge = 0
          drift.tier = 0
        }
      }

      if (boost.active) {
        boost.remaining -= step
        if (boost.remaining <= 0) endBoost()
      }
      syncRoots()
    },

    applyBoost(seconds: Seconds, strength: number, source: BoostSource): void {
      if (seconds <= 0 || strength <= 1 || source === 'none') return
      const sourceOrStrengthChanged = !boost.active || boost.source !== source || boost.strength !== strength
      if (!boost.active || strength >= boost.strength) {
        boost.active = true
        boost.remaining = seconds
        boost.strength = strength
        boost.source = source
        if (sourceOrStrengthChanged) {
          ctx.events.emit('boost:start', { kartId: identity.id, seconds, source })
        }
      } else if (seconds > boost.remaining) {
        // A weaker boost may preserve momentum for longer, but it never changes
        // the active strength or claims ownership of its source.
        boost.remaining = seconds
      }
    },

    applyHit(kind: HitKind, incomingDirectionWorld: Vector3): void {
      ctx.events.emit('kart:hit', { kartId: identity.id, kind })
      if (kind === 'spin') {
        state.stunTime = Math.max(state.stunTime, 1.05)
        yawRate += incomingDirectionWorld.dot(right) >= 0 ? 4.8 : -4.8
        velocity.multiplyScalar(0.48)
      } else if (kind === 'squash') {
        state.stunTime = Math.max(state.stunTime, 0.72)
        velocity.multiplyScalar(0.32)
      } else {
        state.stunTime = Math.max(state.stunTime, 0.28)
        velocity.multiplyScalar(0.78).addScaledVector(incomingDirectionWorld, 4.2)
      }
      if (drift.active) clearDrift()
    },

    respawn(t: number): void {
      kart.placeAt(t, track === null ? 0 : track.racingLine(t))
    },

    /**
     * The pose setter behind `respawn`, and behind the steering-sign gate.
     *
     * These were one function; splitting them IS the change. A harness has to
     * place a kart somewhere other than the ideal line to ask which way it moves
     * from there, and without that the sign convention is untestable — see the
     * note on `IKart.placeAt` in the contract.
     */
    placeAt(t: number, lateral: number, speed = 0): void {
      if (track === null) return
      track.sample(t, respawnSample)
      position
        .copy(respawnSample.position)
        .addScaledVector(respawnSample.right, lateral)
        .addScaledVector(respawnSample.normal, RIDE_HEIGHT)
      backward.copy(respawnSample.tangent).multiplyScalar(-1)
      basis.makeBasis(respawnSample.right, respawnSample.normal, backward)
      quaternion.setFromRotationMatrix(basis).normalize()
      /*
       * Velocity is SET, not driven up to.
       *
       * The composition root originally reached a target speed by holding full
       * throttle and stepping the simulation, which is defensible — a kart
       * placed by assignment carries whatever tyre load the assignment left
       * behind. But it moved the kart tens of metres down the road before the
       * measurement even started, so `seek(t, speed)` did not leave the kart at
       * `t`, and every steering measurement taken from it was taken somewhere
       * else. Setting the state is the lesser evil, and the wheels are spun to
       * match so the tyre model does not see a locked-wheel slide on tick one.
       */
      velocity.copy(respawnSample.tangent).multiplyScalar(speed)
      wheelOmega.fill(speed / WHEEL_RADIUS)
      previousRayLength.fill(STATIC_RAY_LENGTH)
      yawRate = 0
      suspensionHistoryValid = false
      state.speed = speed
      state.grounded = true
      state.stunTime = 0
      previousDriftButton = false
      clearDrift()
      endBoost()
      track.locate(position, centreLocation)
      state.surface = track.surfaceAt(centreLocation.t, centreLocation.lateral)
      for (let i = 0; i < 4; i++) {
        wheels[i]!.compression = 0.5
        wheels[i]!.steerAngle = 0
        wheels[i]!.spin = 0
        wheels[i]!.grounded = true
        wheels[i]!.surface = state.surface
        wheels[i]!.slip = 0
      }
      syncRoots()
      ctx.events.emit('kart:respawn', { kartId: identity.id })
    },

    dispose(): void {
      modelRoot.removeFromParent()
      fxRoot.removeFromParent()
      audioRoot.removeFromParent()
      built = false
      track = null
    },
  }

  return kart
}
