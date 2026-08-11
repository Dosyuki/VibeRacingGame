import type {
  Ctx,
  GameServices,
  IKart,
  RaceFactory,
  RacePhase,
  Seconds,
  Standing,
  Subsystem,
  TrackLocation,
} from '../types'

/*
 * Race policy lives here rather than in the track or kart.  In particular,
 * `TrackLocation.checkpointIndex` only says which interval contains a kart; it
 * is not proof that the kart drove through the checkpoint which begins it.
 */
const DEFAULT_LAPS = 3
const COUNTDOWN_SECONDS = 3
const OFF_TRACK_GRACE_SECONDS = 2.25
const STALL_SECONDS = 12
const PROGRESS_EPSILON = 1e-6

/*
 * A physics tick at the kart's governed speed is well under one metre.  A
 * larger displacement is a seek, reset, or teleport and must re-baseline the
 * crossing detector instead of manufacturing every boundary between its two
 * endpoints.
 */
const MAX_CONTINUOUS_STEP_METRES = 5
const RESPAWN_ADVANCE_METRES = 1

interface MutableStanding extends Standing {
  place: number
  completedLaps: number
  progress: number
  bestProgress: number
  lapTimes: Seconds[]
  finished: boolean
  finishOrder: number
}

interface Racer {
  kart: IKart
  standing: MutableStanding
  location: TrackLocation
  previousT: number
  previousCheckpoint: number
  previousOnTrack: boolean
  previousX: number
  previousY: number
  previousZ: number
  armed: boolean
  /** Crossings after the first, lap-arming pass over checkpoint zero. */
  checkpointDepth: number
  lastLapStartedAt: Seconds
  offTrackFor: Seconds
  stalledFor: Seconds
  initialX: number
  initialY: number
  initialZ: number
  initialQx: number
  initialQy: number
  initialQz: number
  initialQw: number
}

function makeLocation(): TrackLocation {
  return { t: 0, lateral: 0, height: 0, onTrack: true, checkpointIndex: 0 }
}

function wrapIndex(index: number, count: number): number {
  const wrapped = index % count
  return wrapped < 0 ? wrapped + count : wrapped
}

/**
 * Fixed-step race state and anti-cut checkpoint validation.
 *
 * Storage is created in `link`, when the composition root finally has a track
 * and karts.  Every object touched by `step` is retained from that point; the
 * only hot-path allocations are the event payloads explicitly sanctioned by
 * the contract.
 */
export const createRace: RaceFactory = (ctx: Ctx): StandingRace => {
  let phase: RacePhase = 'idle'
  let clock: Seconds = 0
  let countdownNext: 2 | 1 | 0 = 2
  let services: GameServices | null = null
  let finishCount = 0

  const racers: Racer[] = []
  const standings: MutableStanding[] = []

  function updatePlaces(): void {
    // Insertion sort is deterministic for ties and, unlike a callback-based
    // `Array.sort`, has no engine-dependent temporary allocation in this hot
    // path.  Finished karts remain locked ahead in their recorded order.
    for (let i = 1; i < standings.length; i++) {
      const value = standings[i]!
      let j = i - 1
      while (j >= 0 && comesBefore(value, standings[j]!)) {
        standings[j + 1] = standings[j]!
        j--
      }
      standings[j + 1] = value
    }
    for (let i = 0; i < standings.length; i++) {
      const standing = standings[i]!
      standing.place = standing.finished ? standing.finishOrder : i + 1
    }
  }

  function comesBefore(a: MutableStanding, b: MutableStanding): boolean {
    if (a.finished !== b.finished) return a.finished
    if (a.finished) return a.finishOrder < b.finishOrder
    if (a.progress !== b.progress) return a.progress > b.progress
    // Identity order is the final deterministic tie-breaker.  Depending on
    // incidental array history here made grid order differ after a reset.
    return a.kartId < b.kartId
  }

  function rebaseline(racer: Racer): void {
    const track = services!.track
    track.locate(racer.kart.state.position, racer.location)
    racer.previousT = racer.location.t
    racer.previousCheckpoint = racer.location.checkpointIndex
    racer.previousOnTrack = racer.location.onTrack
    racer.previousX = racer.kart.state.position.x
    racer.previousY = racer.kart.state.position.y
    racer.previousZ = racer.kart.state.position.z
  }

  function removeRolledBackLap(racer: Racer): void {
    const times = racer.standing.lapTimes
    const removed = times.length > 0 ? times[times.length - 1]! : 0
    if (times.length > 0) times.length--
    // Preserve the old lap's start.  Otherwise reversing one metre over the
    // line and crossing again creates a fraudulent sub-second best lap.
    racer.lastLapStartedAt = clock - removed
  }

  function crossForward(racer: Racer, checkpoint: number): void {
    const track = services!.track
    const count = track.checkpoints.length

    if (!racer.armed) {
      if (checkpoint !== 0) return
      racer.armed = true
      racer.checkpointDepth = 0
      racer.lastLapStartedAt = clock
      return
    }

    const expected = (racer.checkpointDepth + 1) % count
    if (checkpoint !== expected) return
    racer.checkpointDepth++

    if (checkpoint !== 0) return
    const lap = Math.floor(racer.checkpointDepth / count)
    const lapTime = clock - racer.lastLapStartedAt
    racer.standing.completedLaps = lap
    racer.standing.lapTimes.push(lapTime)
    racer.lastLapStartedAt = clock
    ctx.events.emit('lap:complete', {
      kartId: racer.standing.kartId,
      lap,
      lapTime,
    })

    if (lap < race.totalLaps || racer.standing.finished) return
    finishCount++
    racer.standing.finished = true
    racer.standing.finishOrder = finishCount
    racer.standing.place = finishCount
    ctx.events.emit('race:finish', {
      kartId: racer.standing.kartId,
      place: finishCount,
    })
  }

  function crossBackward(racer: Racer, checkpoint: number): void {
    if (!racer.armed || racer.standing.finished) return
    const count = services!.track.checkpoints.length
    const expected = racer.checkpointDepth % count
    if (checkpoint !== expected) return

    if (racer.checkpointDepth === 0) {
      // Reversing back over the initial start crossing disarms the sequence;
      // it emphatically does not turn the grid into a completed lap.
      racer.armed = false
      racer.lastLapStartedAt = 0
      return
    }

    const oldLaps = Math.floor(racer.checkpointDepth / count)
    racer.checkpointDepth--
    const newLaps = Math.floor(racer.checkpointDepth / count)
    racer.standing.completedLaps = newLaps
    if (newLaps < oldLaps) removeRolledBackLap(racer)
  }

  function respawn(racer: Racer): void {
    const track = services!.track
    let t: number
    if (!racer.armed) {
      // No checkpoint has been earned yet.  Returning to the kart's actual
      // grid row lets it cross checkpoint zero normally instead of granting it.
      const index = racers.indexOf(racer)
      t = track.startGrid[index % track.startGrid.length]!.t
    } else {
      const lastCheckpoint = racer.checkpointDepth % track.checkpoints.length
      t = track.checkpoints[lastCheckpoint]! + RESPAWN_ADVANCE_METRES / track.length
    }
    racer.kart.respawn(t)
    racer.offTrackFor = 0
    racer.stalledFor = 0
    rebaseline(racer)
  }

  function updateRacer(racer: Racer, step: Seconds): void {
    const track = services!.track
    const position = racer.kart.state.position
    track.locate(position, racer.location)

    const dx = position.x - racer.previousX
    const dy = position.y - racer.previousY
    const dz = position.z - racer.previousZ
    const continuous = dx * dx + dy * dy + dz * dz <=
      MAX_CONTINUOUS_STEP_METRES * MAX_CONTINUOUS_STEP_METRES

    let deltaT = racer.location.t - racer.previousT
    if (deltaT > 0.5) deltaT -= 1
    else if (deltaT < -0.5) deltaT += 1

    if (
      continuous &&
      racer.previousOnTrack &&
      racer.location.onTrack &&
      racer.location.checkpointIndex !== racer.previousCheckpoint
    ) {
      const count = track.checkpoints.length
      if (
        deltaT > 0 &&
        racer.location.checkpointIndex === (racer.previousCheckpoint + 1) % count
      ) {
        crossForward(racer, racer.location.checkpointIndex)
      } else if (
        deltaT < 0 &&
        racer.location.checkpointIndex === wrapIndex(racer.previousCheckpoint - 1, count)
      ) {
        // On a backward interval transition the crossed line is the one which
        // began the interval being left, not the destination interval.
        crossBackward(racer, racer.previousCheckpoint)
      }
    }

    racer.standing.progress = racer.standing.completedLaps + racer.location.t

    /*
     * `progress` deliberately falls at the seam and after respawn.  Only its
     * high-water mark is monotonic.  Before the first legitimate start crossing
     * the grid's t ~= 1 must not become that high-water mark: doing so would
     * classify the whole first lap as stalled because no value can exceed it.
     */
    if (
      racer.armed &&
      racer.standing.progress > racer.standing.bestProgress + PROGRESS_EPSILON
    ) {
      racer.standing.bestProgress = racer.standing.progress
      racer.stalledFor = 0
    } else {
      racer.stalledFor += step
    }

    if (racer.location.onTrack) racer.offTrackFor = 0
    else racer.offTrackFor += step

    racer.previousT = racer.location.t
    racer.previousCheckpoint = racer.location.checkpointIndex
    racer.previousOnTrack = racer.location.onTrack
    racer.previousX = position.x
    racer.previousY = position.y
    racer.previousZ = position.z

    if (
      !racer.standing.finished &&
      (racer.offTrackFor >= OFF_TRACK_GRACE_SECONDS || racer.stalledFor >= STALL_SECONDS)
    ) {
      respawn(racer)
      // Respawn moves backwards by design; publish that current value now so
      // standings never retain the pre-respawn high-water value as progress.
      racer.standing.progress = racer.standing.completedLaps + racer.location.t
    }
  }

  function resetRacer(racer: Racer): void {
    // `respawn` is the only interface operation which clears private kart drift,
    // boost and stun.  Restore the cached grid transform afterwards because a
    // respawn targets the single racing line, whereas the grid is two abreast.
    racer.kart.respawn(services!.track.startGrid[racers.indexOf(racer) % services!.track.startGrid.length]!.t)
    racer.kart.state.position.set(racer.initialX, racer.initialY, racer.initialZ)
    racer.kart.state.quaternion.set(
      racer.initialQx,
      racer.initialQy,
      racer.initialQz,
      racer.initialQw,
    )
    racer.kart.state.velocity.set(0, 0, 0)
    racer.kart.modelRoot.position.copy(racer.kart.state.position)
    racer.kart.modelRoot.quaternion.copy(racer.kart.state.quaternion)
    racer.kart.fxRoot.position.copy(racer.kart.state.position)
    racer.kart.fxRoot.quaternion.copy(racer.kart.state.quaternion)
    racer.kart.audioRoot.position.copy(racer.kart.state.position)
    racer.kart.audioRoot.quaternion.copy(racer.kart.state.quaternion)

    racer.armed = false
    racer.checkpointDepth = 0
    racer.lastLapStartedAt = 0
    racer.offTrackFor = 0
    racer.stalledFor = 0
    racer.standing.place = 1
    racer.standing.completedLaps = 0
    racer.standing.progress = 0
    racer.standing.bestProgress = 0
    racer.standing.lapTimes.length = 0
    racer.standing.finished = false
    racer.standing.finishOrder = 0
    rebaseline(racer)
    racer.standing.progress = racer.location.t
  }

  const race: StandingRace = {
    name: 'game/race',
    totalLaps: DEFAULT_LAPS,

    get phase(): RacePhase {
      return phase
    },

    get clock(): Seconds {
      return clock
    },

    standings,

    build(): void {
      // Cross-subsystem objects intentionally do not exist during build.
    },

    link(nextServices: GameServices): void {
      services = nextServices
      racers.length = 0
      standings.length = 0

      for (let i = 0; i < nextServices.karts.length; i++) {
        const kart = nextServices.karts[i]!
        const location = makeLocation()
        nextServices.track.locate(kart.state.position, location)

        // Reserve the complete race's lap-time capacity before fixed updates.
        // Resetting length retains that capacity in current JS engines, so the
        // discrete writes below do not grow an array during a measured tick.
        const lapTimes = new Array<Seconds>(race.totalLaps)
        lapTimes.length = 0
        const standing: MutableStanding = {
          kartId: kart.identity.id,
          place: i + 1,
          completedLaps: 0,
          progress: location.t,
          bestProgress: 0,
          lapTimes,
          finished: false,
          finishOrder: 0,
        }
        const position = kart.state.position
        const quaternion = kart.state.quaternion
        racers.push({
          kart,
          standing,
          location,
          previousT: location.t,
          previousCheckpoint: location.checkpointIndex,
          previousOnTrack: location.onTrack,
          previousX: position.x,
          previousY: position.y,
          previousZ: position.z,
          armed: false,
          checkpointDepth: 0,
          lastLapStartedAt: 0,
          offTrackFor: 0,
          stalledFor: 0,
          initialX: position.x,
          initialY: position.y,
          initialZ: position.z,
          initialQx: quaternion.x,
          initialQy: quaternion.y,
          initialQz: quaternion.z,
          initialQw: quaternion.w,
        })
        standings.push(standing)
      }
      updatePlaces()
    },

    step(step: Seconds): void {
      if (services === null || step <= 0 || phase === 'idle' || phase === 'finished') return

      if (phase === 'countdown') {
        clock = Math.min(0, clock + step)
        if (countdownNext === 2 && clock >= -2) {
          ctx.events.emit('race:countdown', { n: 2 })
          countdownNext = 1
        }
        if (countdownNext === 1 && clock >= -1) {
          ctx.events.emit('race:countdown', { n: 1 })
          countdownNext = 0
        }
        if (countdownNext === 0 && clock >= 0) {
          ctx.events.emit('race:countdown', { n: 0 })
          phase = 'racing'
          ctx.events.emit('race:start', {})
        }
        return
      }

      clock += step
      for (let i = 0; i < racers.length; i++) updateRacer(racers[i]!, step)
      updatePlaces()
      if (finishCount === racers.length && racers.length > 0) phase = 'finished'
    },

    fixedUpdate(step: Seconds): void {
      race.step(step)
    },

    /*
     * A STANDING START STARTS FROM THE GRID, AND ESTABLISHING THAT IS `start`'s
     * JOB — NOT THE CALLER'S AND NOT THE COUNTDOWN'S.
     *
     * This used to set the phase and the clock and nothing else, which left an
     * asymmetry nobody could see from either side of it: the HUD's RESTART path
     * is `reset()` then `start()` (`ui/hud.ts:337-339`) and therefore begins on a
     * grid, while the FIRST race of a session is `start()` alone (`hud.ts:328`)
     * and begins wherever the field happens to be.
     *
     * Wherever the field happens to be is not the grid. The reference AI drives
     * every kart from the moment the page boots — no race is required for that
     * and there should not be one, because `src/main.ts` deliberately does NOT
     * gate driver input in phase 'idle': every measuring harness in this repo
     * drives a kart with the race unstarted, and a gate there turns a probe that
     * drove into a probe that measured a parked kart and reported no error.
     *
     * So the field is already rolling when the lights come on, by an amount that
     * depends on how long the player looked at the start screen. Measured with
     * `tools/grid-start.mjs`, which presses START about 12 ticks after load —
     * roughly the best case — the field carried 0.51 m/s across `start()` and
     * coasted 2.6 m up the grid before GO, with the input gate working
     * perfectly. A player who reads the start card for twenty seconds would find
     * the field most of a lap away. `grid-start.mjs`'s `countdown-hold` reports
     * 0.000 m with this in place and 2.605 m without it.
     *
     * `resetRacer` is reused rather than a narrower "place on grid", because the
     * narrower version is how the two paths drifted apart in the first place.
     * It is safe here precisely because `start()` refuses unless the phase is
     * 'idle', and the only routes into 'idle' are construction and `reset()`,
     * both of which have already zeroed `finishCount` and the standings.
     */
    start(): void {
      if (services === null || phase !== 'idle') return
      for (let i = 0; i < racers.length; i++) resetRacer(racers[i]!)
      updatePlaces()
      phase = 'countdown'
      clock = -COUNTDOWN_SECONDS
      countdownNext = 2
      ctx.events.emit('race:countdown', { n: 3 })
    },

    reset(): void {
      if (services === null) return
      phase = 'idle'
      clock = 0
      countdownNext = 2
      finishCount = 0
      for (let i = 0; i < racers.length; i++) resetRacer(racers[i]!)
      updatePlaces()
    },

    dispose(): void {
      services = null
      racers.length = 0
      standings.length = 0
      phase = 'idle'
      clock = 0
      finishCount = 0
    },
  }

  return race
}

type StandingRace = ReturnType<RaceFactory> & Subsystem
