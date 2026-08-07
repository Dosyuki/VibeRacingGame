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
const FRONT_AXLE = 0.72
const REAR_AXLE = -0.68

// Section 6 fixes total travel at 0.09 m.  REST_LENGTH sits inside that range;
// the remaining constants merely name its hard endpoints.
const SUSPENSION_TRAVEL = 0.09
const REST_LENGTH = 0.205
const FULL_EXTENSION = REST_LENGTH + SUSPENSION_TRAVEL * 0.5
const BOTTOM_LENGTH = REST_LENGTH - SUSPENSION_TRAVEL * 0.5
const SPRING_RATE = 25_000
const DAMPER_RATE = 2_250
const RIDE_HEIGHT = WHEEL_RADIUS + REST_LENGTH

const ENGINE_FORCE = 3_450
const REVERSE_FORCE = 1_450
const BRAKE_TORQUE = 620
const BASE_TOP_SPEED = 31.5
const AERO_DRAG = 0.00108
const ROLLING_ACCEL = 0.16
const MAX_STEER = 0.48
const STEER_FADE_SPEED = 34
const TYRE_SLIP_ANGLE = 0.115
const TYRE_SLIP_RATIO = 0.13

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
  let built = false

  const wheelOmega = new Float64Array(4)
  const previousRayLength = new Float64Array(4)
  previousRayLength.fill(REST_LENGTH)
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
      const steerFade = clamp(1 - Math.abs(speedForward) / STEER_FADE_SPEED, 0.38, 1)
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
        // That distinction lets spring/damper forces filter the bump instead of
        // teleporting the body, while the fixed phase keeps it deterministic.
        const bumpPhase = location.t * track.length * 5.7 + i * 1.91 + identity.id * 0.73
        const bump = Math.sin(bumpPhase) * props.roughness * 0.42
        let rayLength =
          (mount.x - sample.position.x) * sample.normal.x +
          (mount.y - sample.position.y) * sample.normal.y +
          (mount.z - sample.position.z) * sample.normal.z -
          WHEEL_RADIUS -
          bump
        wheel.grounded = rayLength <= FULL_EXTENSION

        if (!wheel.grounded) {
          wheel.compression = 0
          wheel.slip = 0
          previousRayLength[i] = FULL_EXTENSION
          wheelOmega[i] = wheelOmega[i]! * Math.max(0, 1 - step * 0.3)
          wheel.spin += wheelOmega[i]! * step
          wheel.steerAngle = i < 2 ? frontSteer : 0
          continue
        }

        groundedCount++
        normalX += sample.normal.x
        normalY += sample.normal.y
        normalZ += sample.normal.z
        rayLength = clamp(rayLength, BOTTOM_LENGTH, FULL_EXTENSION)
        wheel.compression = clamp((FULL_EXTENSION - rayLength) / SUSPENSION_TRAVEL, 0, 1)
        const compressionSpeed = (previousRayLength[i]! - rayLength) / step
        previousRayLength[i] = rayLength
        const springForce = Math.max(
          0,
          SPRING_RATE * (REST_LENGTH - rayLength) + DAMPER_RATE * compressionSpeed,
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
        const peakForce = Math.max(120, springForce * props.grip * rearDriftScale)
        let lateralForce = -Math.tanh(slipAngle / (TYRE_SLIP_ANGLE / rearDriftScale)) * peakForce
        let longitudinalForce = Math.tanh(slipRatio / TYRE_SLIP_RATIO) * peakForce

        const combined = Math.hypot(lateralForce, longitudinalForce)
        if (combined > peakForce) {
          const scale = peakForce / combined
          lateralForce *= scale
          longitudinalForce *= scale
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
      if (track === null) return
      track.sample(t, respawnSample)
      position
        .copy(respawnSample.position)
        .addScaledVector(respawnSample.right, track.racingLine(t))
        .addScaledVector(respawnSample.normal, RIDE_HEIGHT)
      backward.copy(respawnSample.tangent).multiplyScalar(-1)
      basis.makeBasis(respawnSample.right, respawnSample.normal, backward)
      quaternion.setFromRotationMatrix(basis).normalize()
      velocity.set(0, 0, 0)
      wheelOmega.fill(0)
      previousRayLength.fill(REST_LENGTH)
      yawRate = 0
      state.speed = 0
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
