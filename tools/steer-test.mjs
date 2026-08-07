/**
 * THE STEERING SIGN, END TO END. §10c criterion 4, made executable.
 *
 *   node tools/steer-test.mjs              # assert the live build
 *   node tools/steer-test.mjs --reference  # run the battery on the built-in reference
 *   node tools/steer-test.mjs --broken     # self-test: prove every detector fires
 *
 * WHY THIS FILE IS THE CHEAPEST THING IN THE REPO AND GUARDS THE MOST EXPENSIVE BUG
 * ---------------------------------------------------------------------------------
 * Inverted steering shipped elsewhere and survived three full rounds of six
 * reviewers scoring beautiful screenshots, because a still frame contains no
 * information about which way the kart went when the player pressed right. This
 * file is four minutes of measurement against that. The contract says it exists —
 * `src/types.ts`, STEERING SIGN, "tools/steer-test.mjs asserts it end to end for
 * both a scripted player input and the reference AI. Run it after touching
 * either." — so this is the file discharging a promise the contract already made.
 *
 * WHAT IT ASSERTS, and why each one is separate
 *
 *   surface              which HarnessAPI methods this needs, and which refused
 *   straight             where on the circuit it measured, and how straight it was
 *   repeatability        two identical runs produce identical numbers. This is the
 *                        noise floor for every threshold below; a fixed-step sim
 *                        should make it exactly zero, and if it is not, nothing
 *                        else on this page is a measurement.
 *   player-track-anchor  constant +steer moves the kart to positive `lateral` as
 *                        reported by `track.locate`, and -steer mirrors it
 *   player-world-anchor  the same run, measured in WORLD space against the kart's
 *                        own chassis frame, touching ITrack for nothing
 *   steer-response       the response is large enough to be a vehicle, roughly
 *                        symmetric, and grows with steer
 *   ai-command           with the racing line calling for a right-hand move, the
 *                        reference AI COMMANDS a positive steer
 *   ai-outcome           and the kart actually converges on the line
 *
 * TWO ANCHORS, AND WHY ONE IS NOT ENOUGH
 * --------------------------------------
 * `track.locate().lateral` is signed "positive is the driver's right". Assert
 * against it alone and a build where BOTH the track's lateral sign and the
 * chassis are inverted reads as perfect: the kart goes to what the track calls
 * positive, and the track is wrong about which side that is. Two mistakes, one
 * green light, and the second one is invisible until an AI or a HUD arrow reads
 * `lateral` and points the wrong way.
 *
 * So the same displacement is measured a second time in world space, projected
 * onto the kart's own initial right vector — `quaternion ⊗ (1,0,0)`, which is the
 * driver's right by the contract's own axis statement ("+X right, +Y up, -Z
 * forward at identity rotation") and by nothing else. That measurement cannot be
 * moved by any track bug. `--broken` sabotages exactly this pair: `both-flipped`
 * fools the track anchor and must be caught by the world anchor, and the run
 * asserts the track anchor stayed QUIET so the independence is demonstrated
 * rather than assumed.
 *
 * WHY THE AI TEST READS THE COMMAND AND NOT THE OUTCOME
 * ----------------------------------------------------
 * An AI that compensates for an inverted chassis with a second negation produces
 * karts that drive around the circuit perfectly. The bug is real, it is invisible
 * in play, and it detonates the day somebody fixes the chassis. So `ai-command`
 * grades the sign of what the AI ASKED FOR, and `ai-outcome` — where the kart
 * ended up — is a separate check with its own sabotage. `ai-double-negation`
 * proves the split works: it drives correctly, `ai-outcome` stays quiet, and
 * `ai-command` goes red.
 *
 * Reading the command needs one thing HarnessAPI does not declare; see the
 * PENDING block and CONTRACT_ADDITION at the bottom of a live run. Until it
 * lands, the command is graded through `KartState.wheels[].steerAngle`, whose
 * contract is "Steer angle applied to this wheel. Sign follows STEERING SIGN" —
 * a real signal, one layer downstream of the command, and this file says so
 * rather than pretending it is the command itself.
 *
 * EVERY MEASUREMENT IS A DIFFERENCE AGAINST steer = 0
 * ---------------------------------------------------
 * A kart holding steer = 0 on a curving road drifts to the outside, and on a
 * banked one it slides downhill. Both are larger than the steering signal at
 * small steer. Every number here is therefore `run(steer) - run(0)` from the
 * identical seek, which cancels the road, the bank and the surface exactly and
 * leaves only what steering did. It also means the check does not depend on
 * finding a truly straight section, only on finding a repeatable one.
 *
 * SELF-TEST. `--broken` needs no game and no server. It builds a complete
 * reference world in the page — a stadium circuit with real arc-length
 * parameterisation, a bicycle-model kart, and a pure-pursuit AI — installs it on
 * `window.__harness`, asserts the battery passes it clean, then applies eight
 * sabotages and asserts each is caught BY THE CHECK THAT OWNS IT. Two of them
 * additionally assert that a NAMED OTHER CHECK STAYED QUIET, because "everything
 * went red" would hide the fact that the two anchors are supposed to be
 * independent. It also drives the real extraction path — a harness that is
 * absent, one that refuses honestly, and one that works — so the code that must
 * run the day `src/game/ai.ts` lands is not the one thing here nobody has
 * watched.
 */

import path from 'node:path'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { ROOT, startServer } from './vite-server.mjs'
import { launch, openGame } from './lib/browser.mjs'

const args = process.argv.slice(2)
const MODE = args.includes('--broken') ? 'broken' : args.includes('--reference') ? 'reference' : 'live'
const useDev = args.includes('--dev')

const OUT = path.join(ROOT, 'tools', 'out')
mkdirSync(OUT, { recursive: true })

// ---------------------------------------------------------------------------
// Contract constants, re-derived from the contract
// ---------------------------------------------------------------------------
/*
 * Read out of `src/types.ts`, not remembered. A harness that hardcodes 1/120
 * keeps reporting metres per second after somebody moves the tick rate, and it
 * keeps doing it silently — every rate on this page would be wrong by the ratio
 * and nothing would say so. If the parse fails this file refuses to run.
 */
const TYPES_PATH = path.join(ROOT, 'src', 'types.ts')
const typesSrc = readFileSync(TYPES_PATH, 'utf8')

function ratioFromContract(re, what) {
  const m = typesSrc.match(re)
  const num = m ? Number(m[1]) : NaN
  const den = m && m[2] !== undefined ? Number(m[2]) : 1
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    console.error(
      `FAIL  cannot read ${what} out of ${TYPES_PATH}.\n` +
        `      This harness re-derives the contract's constants instead of remembering them.\n` +
        `      Refusing to run against a value it cannot confirm.`,
    )
    process.exit(1)
  }
  return num / den
}

const SIMULATION_STEP = ratioFromContract(
  /SIMULATION_STEP\s*:\s*Seconds\s*=\s*([\d.]+)(?:\s*\/\s*([\d.]+))?/,
  'SIMULATION_STEP',
)

/*
 * The marker `src/main.ts` throws for a surface that does not exist yet.
 * `tools/contract-check.mjs` keys on the same literal; if it moves, both files
 * start reporting a real method as broken rather than pending.
 */
const PENDING_MARKER = 'is not available yet'

// ---------------------------------------------------------------------------
// Limits. DERIVED or guess, marked per line.
// ---------------------------------------------------------------------------
const CFG = {
  simStep: SIMULATION_STEP,
  seed: 20260807,
  totalLaps: 3,

  /** Centreline samples for the straight finder. 2048 over ~1.2 km is 0.6 m. */
  sweep: 2048,
  /*
   * DERIVED. The probe travels `probeSpeed * ticks * simStep` metres — 18 m at
   * the numbers below — and the window has to contain all of it with room to
   * start inside it. 60 m is three times the run.
   */
  straightWindowM: 60,
  /** Where in the window the probe starts, as a fraction. Leaves 48 m ahead. */
  straightEntryFrac: 0.2,

  /*
   * guess, and a mild one. Fast enough that the tyres are doing real work and
   * the response is unmistakable, slow enough that full lock is not a spin. Any
   * speed would prove the sign; this one also makes the reported rate a number a
   * tuner recognises.
   */
  probeSpeed: 18,
  throttle: 1.0,
  /*
   * DERIVED, and it is a two-sided constraint. 90 ticks is exactly 0.75 s at the
   * contract's step. Longer makes the signal bigger and eventually walks the
   * kart off the road, where surface drag and a respawn contaminate the run;
   * shorter shrinks the signal toward the floor below. At 18 m/s a kart with a
   * 14 m minimum turn radius is 6 m off line by the end of this window and one
   * with a sluggish 60 m radius is 1.5 m off — both unmistakable, neither off
   * an 8 m half-width road.
   */
  ticks: 90,
  /** Trajectory resolution. 10 ticks is 9 samples across the window. */
  sliceTicks: 10,

  /** The magnitude the sign checks use. Both signs, always. */
  signSteer: 0.6,
  /** The rate table. Reported, never gated on the value. */
  rateSteers: [0.25, 0.6, 1.0],

  /*
   * DERIVED, and deliberately far below anything real. A kart at 18 m/s holding
   * a steer for 0.75 s traces an arc of R(1 - cos(vt/R)); a sluggish 60 m
   * effective radius puts it 1.5 m off line and a 14 m one puts it 6.0 m off.
   * 0.5 m is between three and twelve times below a working vehicle and four
   * orders above numerical noise, so only a kart that has essentially ignored
   * the input can fall under it.
   *
   * This floor belongs to `steer-response`, NOT to the two sign anchors. The
   * anchors gate on sign against the measured noise floor alone, so a kart with
   * the right sign and a hundredth of the authority fails one check and not
   * three — which is the difference between a diagnosis and an alarm.
   */
  minLateralM: 0.5,
  /*
   * How far above the run-to-run noise floor a displacement must sit before its
   * SIGN is asserted. Same 4x rule §10c uses for the drift margin, and for the
   * same reason: a margin quoted without a noise floor is not evidence.
   */
  noiseMultiple: 4,
  /*
   * DERIVED. A deterministic fixed-step sim repeats bit for bit, so the measured
   * floor should be 0 and this is only the guard against dividing by it. 1e-4 m
   * is 0.1 mm — below any physical effect, above double-precision drift.
   */
  epsilonM: 1e-4,
  /*
   * guess. Left/right asymmetry is REPORTED, not gated, up to here — a real
   * chassis is not perfectly symmetric and a banked road makes it less so. Above
   * this the two directions are not the same manoeuvre and the mirror test is
   * comparing different things, which is worth saying out loud.
   */
  asymmetryReportFrac: 0.35,

  // -- the AI ---------------------------------------------------------------
  /*
   * guess. Far enough off the racing line that the correct action is
   * unambiguous, close enough to stay well inside a 7-8 m half-width. Clamped
   * against the measured half-width at run time.
   */
  aiOffsetM: 2.5,
  /** DERIVED: 36 ticks is 0.30 s — long enough for a controller to commit, short
   *  enough that the kart has not yet reached the line and stopped steering. */
  aiTicks: 36,
  aiSliceTicks: 6,
  /*
   * guess. Below this the AI is not asking for anything and its sign is not
   * meaningful; asserting on the sign of 0.001 would be asserting on noise.
   */
  minAiSteer: 0.02,
  /*
   * guess. Over 0.30 s from 2.5 m off line, a controller that is converging has
   * closed some of it. 0.10 m is a tenth of the error and still comfortably
   * above the repeatability floor.
   */
  aiConvergenceM: 0.1,

  /** DERIVED: the countdown is 3 s (§ GameEvents race:countdown 3/2/1/0); 1200
   *  ticks is 10 s, so a build that never reaches 'racing' is a real fault. */
  phaseTicksMax: 1200,
}

// ---------------------------------------------------------------------------
// The battery. Runs in the page against window.__harness, real or reference.
// ---------------------------------------------------------------------------
/*
 * Self-contained: it is stringified and rebuilt inside the browser, so it may
 * not close over anything in this module. Everything arrives as an argument.
 *
 * It touches no three.js method. Vectors that must be handed to `ITrack.locate`
 * are built by cloning `track.group.position`, which is a Vector3 by contract —
 * the same trick track-check.mjs uses, and for the same reason: no build-time
 * dependency and no second entry in the contract.
 */
async function battery(CFG) {
  const R = { checks: [], info: {}, missing: [], broke: [] }
  const checks = R.checks
  const MARKER = CFG.pendingMarker

  function mk(id, title) {
    const c = { id, title, status: 'PASS', metrics: {}, problems: [], notes: [] }
    checks.push(c)
    return c
  }
  const fail = (c, m) => {
    c.problems.push(m)
    c.status = 'FAIL'
  }
  const pend = (c, m) => {
    c.notes.push(m)
    if (c.status !== 'FAIL') c.status = 'PEND'
  }

  const h = window.__harness
  if (!h) return { blocked: 'NO_HARNESS' }

  // =========================================================================
  // surface — what this needs, and what refused
  // =========================================================================
  /*
   * Probed by CALLING, not by `typeof`. `src/main.ts` declares every method the
   * contract lists and throws the pending marker from the ones that do not
   * exist yet, so presence proves nothing and only a call distinguishes "live"
   * from "declared". Anything that throws something OTHER than the marker is a
   * genuine breakage and is reported separately — that distinction is the whole
   * value of the marker.
   */
  const surface = mk('surface', 'the HarnessAPI methods this file drives')
  const missing = []
  const broke = []
  const have = {}
  async function probe(name, fn) {
    try {
      await fn()
      have[name] = true
      return true
    } catch (err) {
      const msg = String((err && err.message) || err)
      if (msg.indexOf(MARKER) >= 0) missing.push(name)
      else broke.push(`${name}: ${msg}`)
      have[name] = false
      return false
    }
  }

  await probe('track', () => {
    if (!h.track || typeof h.track.sample !== 'function' || typeof h.track.locate !== 'function') {
      throw new Error('present but not an ITrack (needs sample and locate)')
    }
  })
  await probe('resetRace', () => h.resetRace({ seed: CFG.seed, totalLaps: CFG.totalLaps }))
  await probe('playerKartId', () => {
    if (typeof h.playerKartId !== 'number') throw new Error(`playerKartId is ${typeof h.playerKartId}, not a number`)
  })
  await probe('setDriver', () => h.setDriver(have.playerKartId ? h.playerKartId : 0, 'scripted'))
  await probe('setInput', () => h.setInput({ steer: 0, throttle: 0, brake: 0, drift: false, useItem: false, look: 0 }))
  await probe('releaseInput', () => h.releaseInput())
  await probe('stepTicks', () => h.stepTicks(1))
  await probe('seek', () => h.seek({ t: 0 }))
  await probe('telemetry', () => {
    const t = h.telemetry()
    if (!t || !Array.isArray(t.karts)) throw new Error('telemetry() did not return a RaceTelemetry with a karts array')
  })
  await probe('kartSnapshot', () => {
    const s = h.kartSnapshot(have.playerKartId ? h.playerKartId : 0)
    if (!s || !s.position || !s.quaternion) throw new Error('kartSnapshot() returned no position/quaternion')
  })
  await probe('startRace', () => h.startRace())

  R.missing = missing
  R.broke = broke
  surface.metrics.live = Object.keys(have).filter((k) => have[k]).length
  surface.metrics.pending = missing.length
  for (const b of broke) fail(surface, `${b} — that is not the pending marker, so it is a breakage, not an absence`)
  if (missing.length) {
    pend(
      surface,
      `NOT AVAILABLE YET: ${missing.join(', ')}. Every check below that needs one of these reports PENDING and ` +
        `measures nothing. It is not a pass.`,
    )
  }

  const straight = mk('straight', 'where on the circuit this measured')
  const repeat = mk('repeatability', 'two identical runs produce identical numbers')
  const trackAnchor = mk('player-track-anchor', '+steer increases track.locate().lateral; -steer mirrors it')
  const worldAnchor = mk('player-world-anchor', 'the same displacement, in world space, against the chassis frame')
  const response = mk('steer-response', 'the response is a vehicle: large enough, symmetric, growing with steer')
  const aiCommand = mk('ai-command', 'the reference AI COMMANDS positive steer for a right-hand move')
  const aiOutcome = mk('ai-outcome', 'and the kart converges on the racing line')

  /*
   * `straight` needs only ITrack, which landed before the karts did. Running it
   * on a build with no karts is not busywork: it reports WHERE this file will
   * measure and how straight that place actually is, which is the one thing
   * about this harness that can be reviewed before there is anything to drive.
   * Everything below it needs a kart and says so.
   */
  if (!have.track) {
    for (const c of [straight, repeat, trackAnchor, worldAnchor, response, aiCommand, aiOutcome]) {
      pend(c, 'requires HarnessAPI.track; it is not available in this build')
    }
    return R
  }

  const track = h.track
  const pid = have.playerKartId ? h.playerKartId : -1
  const makeVec = () => track.group.position.clone()
  const mkSample = () => ({
    position: makeVec(),
    tangent: makeVec(),
    normal: makeVec(),
    right: makeVec(),
    halfWidth: 0,
    bank: 0,
    curvature: 0,
  })
  const mkLoc = () => ({ t: 0, lateral: 0, height: 0, onTrack: false, checkpointIndex: 0 })
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z
  const wrap01 = (x) => x - Math.floor(x)
  function rotQ(out, v, q) {
    const ix = q.w * v.x + q.y * v.z - q.z * v.y
    const iy = q.w * v.y + q.z * v.x - q.x * v.z
    const iz = q.w * v.z + q.x * v.y - q.y * v.x
    const iw = -q.x * v.x - q.y * v.y - q.z * v.z
    out.x = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y
    out.y = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z
    out.z = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x
    return out
  }

  // =========================================================================
  // straight — pick the flattest window, and say where it is
  // =========================================================================
  const L = track.length
  const N = CFG.sweep
  const ds = L / N
  const curv = new Float64Array(N)
  const hw = new Float64Array(N)
  {
    const s = mkSample()
    for (let i = 0; i < N; i++) {
      track.sample(i / N, s)
      curv[i] = Math.abs(s.curvature)
      hw[i] = s.halfWidth
    }
  }
  const win = Math.max(2, Math.round(CFG.straightWindowM / ds))
  let bestStart = 0
  let bestMax = Infinity
  for (let i = 0; i < N; i++) {
    let worst = 0
    for (let k = 0; k < win; k++) {
      const c = curv[(i + k) % N]
      if (c > worst) worst = c
    }
    if (worst < bestMax) {
      bestMax = worst
      bestStart = i
    }
  }
  const t0 = wrap01((bestStart + win * CFG.straightEntryFrac) / N)
  const sAt0 = mkSample()
  track.sample(t0, sAt0)
  straight.metrics.t0 = t0
  straight.metrics.windowM = CFG.straightWindowM
  straight.metrics.worstCurvature = bestMax
  straight.metrics.minRadiusM = bestMax > 0 ? 1 / bestMax : Infinity
  straight.metrics.halfWidthM = sAt0.halfWidth
  straight.metrics.lapLengthM = L
  straight.notes.push(
    `probing at t=${t0.toFixed(4)} on the flattest ${CFG.straightWindowM} m of the lap: worst |curvature| there is ` +
      `${bestMax.toExponential(2)} 1/m (radius ${(bestMax > 0 ? 1 / bestMax : Infinity).toFixed(0)} m), halfWidth ` +
      `${sAt0.halfWidth.toFixed(2)} m. Every number below is a DIFFERENCE against a steer=0 run from this same seek, ` +
      `so whatever the road does here cancels exactly and only steering is left.`,
  )
  if (!(sAt0.halfWidth > CFG.aiOffsetM + 1)) {
    straight.notes.push(
      `halfWidth ${sAt0.halfWidth.toFixed(2)} m is narrower than the ${CFG.aiOffsetM} m AI offset probe, so the ` +
        `offset was clamped to fit. Reported because it shrinks the AI's error signal and therefore its command.`,
    )
  }

  const needed = ['playerKartId', 'setInput', 'stepTicks', 'seek', 'kartSnapshot']
  const lack = needed.filter((n) => !have[n])
  if (lack.length) {
    const why =
      `requires ${lack.join(', ')}; ${lack.length === 1 ? 'it is' : 'they are'} not available in this build, so ` +
      `NOTHING about the steering sign was measured by this run`
    for (const c of [repeat, trackAnchor, worldAnchor, response, aiCommand, aiOutcome]) pend(c, why)
    return R
  }

  // =========================================================================
  // the probe
  // =========================================================================
  const scratchP = makeVec()
  const scratchLoc = mkLoc()

  function locateSnapshot(snap) {
    scratchP.set(snap.position.x, snap.position.y, snap.position.z)
    const r = track.locate(scratchP, scratchLoc) || scratchLoc
    return { t: r.t, lateral: r.lateral, height: r.height, onTrack: Boolean(r.onTrack) }
  }

  /** Bring the race to 'racing' without a wall-clock wait. */
  async function ensureRacing() {
    if (!have.telemetry || !have.startRace) return { ok: false, why: 'no telemetry/startRace to confirm the phase' }
    let phase = h.telemetry().phase
    if (phase === 'finished') {
      if (have.resetRace) await h.resetRace({ seed: CFG.seed, totalLaps: CFG.totalLaps })
      h.startRace()
    } else if (phase === 'idle') {
      h.startRace()
    }
    let spent = 0
    while (spent < CFG.phaseTicksMax) {
      phase = h.telemetry().phase
      if (phase === 'racing') return { ok: true, ticks: spent }
      await h.stepTicks(30)
      spent += 30
    }
    return { ok: false, why: `phase stayed '${h.telemetry().phase}' after ${CFG.phaseTicksMax} ticks` }
  }

  /**
   * One scripted run: seek, hold a constant frame, step, and report the
   * trajectory. Returns plain numbers only — nothing here retains a snapshot.
   */
  async function run(steer, opts) {
    const o = opts || {}
    await h.seek({ t: o.t === undefined ? t0 : o.t, lateral: o.lateral || 0, speed: CFG.probeSpeed })
    if (o.driver) h.setDriver(pid, o.driver)
    if (o.driver === 'referenceAI') {
      if (have.releaseInput) h.releaseInput()
    } else {
      h.setInput({ steer, throttle: CFG.throttle, brake: 0, drift: false, useItem: false, look: 0 })
    }

    const s0 = h.kartSnapshot(pid)
    if (!s0) return { blocked: `kartSnapshot(${pid}) returned null` }
    const p0 = { x: s0.position.x, y: s0.position.y, z: s0.position.z }
    const q0 = { x: s0.quaternion.x, y: s0.quaternion.y, z: s0.quaternion.z, w: s0.quaternion.w }
    // The driver's right, from the chassis alone. WORLD axes are +X right, +Y
    // up, -Z forward at identity, so this is the contract's own definition and
    // it borrows nothing from ITrack.
    const right0 = rotQ({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, q0)
    const fwd0 = rotQ({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, q0)
    const loc0 = locateSnapshot(s0)

    const total = o.ticks || CFG.ticks
    const slice = o.slice || CFG.sliceTicks
    const series = []
    let stunTicks = 0
    let offTrackTicks = 0
    let speedSum = 0
    let speedN = 0
    let wheelSteerSum = 0
    let wheelSteerN = 0
    let cmdSum = 0
    let cmdN = 0
    let done = 0
    while (done < total) {
      const n = Math.min(slice, total - done)
      await h.stepTicks(n)
      done += n
      const s = h.kartSnapshot(pid)
      if (!s) return { blocked: `kartSnapshot(${pid}) returned null mid-run` }
      const loc = locateSnapshot(s)
      const d = { x: s.position.x - p0.x, y: s.position.y - p0.y, z: s.position.z - p0.z }
      if (s.stunTime > 0) stunTicks += n
      if (!loc.onTrack) offTrackTicks += n
      speedSum += s.speed * n
      speedN += n
      if (s.wheels && s.wheels.length >= 2) {
        // Front left and front right, per KartState.wheels' stated order.
        wheelSteerSum += (s.wheels[0].steerAngle + s.wheels[1].steerAngle) * 0.5 * n
        wheelSteerN += n
      }
      if (typeof h.lastInput === 'function') {
        try {
          const f = h.lastInput(pid)
          if (f && typeof f.steer === 'number') {
            cmdSum += f.steer * n
            cmdN += n
          }
        } catch (err) {
          /* declared-but-pending; the PENDING note below says so */
        }
      }
      series.push({
        ticks: done,
        lateral: loc.lateral,
        t: loc.t,
        world: dot(d, right0),
        along: dot(d, fwd0),
        speed: s.speed,
      })
    }

    return {
      steer,
      t0: loc0.t,
      lateral0: loc0.lateral,
      lateralEnd: series.length ? series[series.length - 1].lateral : loc0.lateral,
      dLateral: (series.length ? series[series.length - 1].lateral : loc0.lateral) - loc0.lateral,
      dWorldRight: series.length ? series[series.length - 1].world : 0,
      dWorldAlong: series.length ? series[series.length - 1].along : 0,
      q0,
      right0: { x: right0.x, y: right0.y, z: right0.z },
      fwd0: { x: fwd0.x, y: fwd0.y, z: fwd0.z },
      meanSpeed: speedN ? speedSum / speedN : 0,
      meanWheelSteer: wheelSteerN ? wheelSteerSum / wheelSteerN : null,
      meanCommandedSteer: cmdN ? cmdSum / cmdN : null,
      stunTicks,
      offTrackTicks,
      series,
      seconds: total * CFG.simStep,
    }
  }

  const racing = await ensureRacing()
  R.info.racing = racing
  if (!racing.ok) {
    for (const c of [repeat, trackAnchor, worldAnchor, response, aiCommand, aiOutcome]) {
      pend(c, `the race never reached phase 'racing' (${racing.why}) — a kart that is not racing does not respond to input, so nothing here was measured`)
    }
    return R
  }

  // =========================================================================
  // repeatability — the noise floor every threshold below is quoted against
  // =========================================================================
  const base = await run(0)
  const baseAgain = await run(0)
  if (base.blocked || baseAgain.blocked) {
    for (const c of [repeat, trackAnchor, worldAnchor, response, aiCommand, aiOutcome]) {
      pend(c, `the baseline run was blocked: ${base.blocked || baseAgain.blocked}`)
    }
    return R
  }
  const noiseLat = Math.abs(base.dLateral - baseAgain.dLateral)
  const noiseWorld = Math.abs(base.dWorldRight - baseAgain.dWorldRight)
  const noise = Math.max(noiseLat, noiseWorld, CFG.epsilonM)
  repeat.metrics.lateralSpreadM = noiseLat
  repeat.metrics.worldSpreadM = noiseWorld
  repeat.metrics.floorM = noise
  repeat.metrics.baselineDLateralM = base.dLateral
  repeat.metrics.meanSpeed = base.meanSpeed
  if (noiseLat > CFG.epsilonM || noiseWorld > CFG.epsilonM) {
    fail(
      repeat,
      `two IDENTICAL runs from the same seek differ by ${noiseLat.toExponential(2)} m of lateral and ` +
        `${noiseWorld.toExponential(2)} m of world displacement (limit ${CFG.epsilonM} m). The simulation is ` +
        `fixed-step and seeded, so this should be zero to the last bit. Until it is, every threshold on this page ` +
        `is quoted against a floor that moves, and two runs of the "same" test are not the same test. ` +
        `Look for a wall clock reaching fixedUpdate, or Math.random() outside ctx.rngFor.`,
    )
  } else {
    repeat.notes.push(
      `noise floor is ${noiseLat === 0 && noiseWorld === 0 ? 'exactly zero' : noise.toExponential(2) + ' m'}; ` +
        `the sign gates below therefore use the ${CFG.epsilonM} m arithmetic floor, not a measured spread. ` +
        `A deterministic sim SHOULD land here — that is the point of THE CLOCK.`,
    )
  }
  const signGate = Math.max(CFG.noiseMultiple * noise, CFG.epsilonM)
  R.info.signGateM = signGate
  R.info.baselineDrift = { lateral: base.dLateral, world: base.dWorldRight }

  // =========================================================================
  // the two anchors
  // =========================================================================
  const right = await run(+CFG.signSteer)
  const left = await run(-CFG.signSteer)
  if (right.blocked || left.blocked) {
    for (const c of [trackAnchor, worldAnchor, response]) pend(c, `a run was blocked: ${right.blocked || left.blocked}`)
  } else {
    const dLatR = right.dLateral - base.dLateral
    const dLatL = left.dLateral - base.dLateral
    const dWorldR = right.dWorldRight - base.dWorldRight
    const dWorldL = left.dWorldRight - base.dWorldRight

    trackAnchor.metrics.steer = CFG.signSteer
    trackAnchor.metrics.rightDLateralM = dLatR
    trackAnchor.metrics.leftDLateralM = dLatL
    trackAnchor.metrics.rawRight = right.dLateral
    trackAnchor.metrics.rawBaseline = base.dLateral
    trackAnchor.metrics.gateM = signGate
    trackAnchor.metrics.seconds = right.seconds
    trackAnchor.metrics.meanSpeed = right.meanSpeed

    const explain =
      `TrackLocation.lateral is "signed metres from the centreline; positive is the driver's right", and ` +
      `InputFrame.steer is "-1 hard left .. +1 hard right. Positive = driver's right". There is exactly one ` +
      `conversion from that intent to yaw torque and it lives inside IKart.step. Do not fix this with a negation ` +
      `at the call site — the second negation somewhere else then looks correct too and only one of them is.`

    if (!(dLatR > signGate)) {
      fail(
        trackAnchor,
        `steer=+${CFG.signSteer} for ${right.seconds.toFixed(2)} s at ${right.meanSpeed.toFixed(1)} m/s moved the kart ` +
          `${dLatR >= 0 ? '+' : ''}${dLatR.toFixed(3)} m of lateral relative to the steer=0 run (needs > +${signGate.toExponential(2)} m). ` +
          (dLatR < -signGate ? 'It went LEFT. ' : 'It barely moved. ') + explain,
      )
    }
    if (!(dLatL < -signGate)) {
      fail(
        trackAnchor,
        `steer=-${CFG.signSteer} moved the kart ${dLatL >= 0 ? '+' : ''}${dLatL.toFixed(3)} m of lateral relative to ` +
          `the steer=0 run (needs < -${signGate.toExponential(2)} m). ` +
          (dLatL > signGate ? 'It went RIGHT. ' : 'It barely moved. ') + explain,
      )
    }

    worldAnchor.metrics.rightDWorldM = dWorldR
    worldAnchor.metrics.leftDWorldM = dWorldL
    worldAnchor.metrics.chassisRight = right.right0
    worldAnchor.metrics.chassisForward = right.fwd0
    worldAnchor.metrics.alongM = right.dWorldAlong
    worldAnchor.metrics.gateM = signGate

    const worldExplain =
      `This measurement projects the kart's displacement onto its OWN initial right vector, quaternion x (1,0,0), ` +
      `and touches ITrack for nothing. The contract fixes that as the driver's right: "World axes: +X right, +Y up, ` +
      `-Z forward at identity rotation". A build where both the chassis and the track's lateral sign are inverted ` +
      `passes the track anchor and fails here, which is the only reason this check is separate.`

    if (!(dWorldR > signGate)) {
      fail(
        worldAnchor,
        `steer=+${CFG.signSteer} displaced the kart ${dWorldR >= 0 ? '+' : ''}${dWorldR.toFixed(3)} m along its own ` +
          `chassis right, relative to the steer=0 run (needs > +${signGate.toExponential(2)} m). ` + worldExplain,
      )
    }
    if (!(dWorldL < -signGate)) {
      fail(
        worldAnchor,
        `steer=-${CFG.signSteer} displaced the kart ${dWorldL >= 0 ? '+' : ''}${dWorldL.toFixed(3)} m along its own ` +
          `chassis right (needs < -${signGate.toExponential(2)} m). ` + worldExplain,
      )
    }
    if (!(right.dWorldAlong > 0)) {
      fail(
        worldAnchor,
        `the kart travelled ${right.dWorldAlong.toFixed(2)} m along its own initial forward over ${right.seconds.toFixed(2)} s ` +
          `— it is not going forwards, so "the driver's right" is not a meaningful direction for this run and the ` +
          `sign above cannot be trusted either. Check that seek() faces the kart down the road and that throttle is reaching it.`,
      )
    }
    // The two anchors must agree. If they do not, one of the track's lateral
    // sign or the chassis frame is wrong and the pair says which.
    /*
     * If the two anchors disagree, one of them has ALREADY failed above — they
     * gate on opposite signs of the same run, so a disagreement is exactly one
     * red. This is therefore a DIAGNOSIS attached to both, not a third failure:
     * adding a status change here would make the two anchors go red together on
     * every single-sided bug and destroy the only thing having two of them buys.
     */
    const agree = Math.sign(dLatR) === Math.sign(dWorldR) && Math.sign(dLatL) === Math.sign(dWorldL)
    worldAnchor.metrics.anchorsAgree = agree
    if (!agree) {
      const diagnosis =
        `THE TWO ANCHORS DISAGREE. In track terms the kart moved ${dLatR.toFixed(3)} m for +steer and ` +
        `${dLatL.toFixed(3)} m for -steer; in world terms it moved ${dWorldR.toFixed(3)} m and ${dWorldL.toFixed(3)} m. ` +
        `Exactly one of ITrack's lateral sign and the chassis's yaw sign is inverted — whichever anchor went red ` +
        `above names which. The world measurement is anchored to the contract's world axes and nothing else; the ` +
        `track one is anchored to TrackSample.right. tools/track-check.mjs 'signs' grades the track side in ` +
        `isolation — run it before touching either.`
      worldAnchor.notes.push(diagnosis)
      trackAnchor.notes.push(diagnosis)
    }

    // -- steer-response ------------------------------------------------------
    const rows = []
    for (const s of CFG.rateSteers) {
      if (Math.abs(s - CFG.signSteer) < 1e-9) {
        rows.push({ steer: s, run: right })
        continue
      }
      const r = await run(s)
      if (r.blocked) {
        pend(response, `the steer=${s} run was blocked: ${r.blocked}`)
        continue
      }
      rows.push({ steer: s, run: r })
    }
    const table = rows.map(({ steer, run: r }) => {
      const d = r.dLateral - base.dLateral
      const dw = r.dWorldRight - base.dWorldRight
      const tail = r.series.length >= 2 ? r.series[r.series.length - 1] : null
      const prev = r.series.length >= 2 ? r.series[r.series.length - 2] : null
      const terminal =
        tail && prev ? (tail.lateral - prev.lateral) / ((tail.ticks - prev.ticks) * CFG.simStep) : null
      return {
        steer,
        dLateralM: d,
        dWorldM: dw,
        meanSpeed: r.meanSpeed,
        seconds: r.seconds,
        /** Mean lateral velocity over the window, per unit steer. */
        ratePerSteer: d / r.seconds / steer,
        /** Lateral velocity over the final slice, per unit steer. Closer to
         *  steady state; a step steer input has not settled at 1 s. */
        terminalRatePerSteer: terminal === null ? null : terminal / steer,
        stunTicks: r.stunTicks,
        offTrackTicks: r.offTrackTicks,
      }
    })
    response.metrics.table = table
    response.metrics.asymmetry = Math.abs(dLatR + dLatL) / Math.max(Math.abs(dLatR), Math.abs(dLatL), CFG.epsilonM)
    response.metrics.minLateralM = CFG.minLateralM
    const mag = Math.min(Math.abs(dLatR), Math.abs(dLatL))
    response.metrics.smallestMagnitudeM = mag
    if (!(mag >= CFG.minLateralM)) {
      fail(
        response,
        `the smaller of the two responses is ${mag.toFixed(4)} m over ${right.seconds.toFixed(2)} s at ` +
          `${right.meanSpeed.toFixed(1)} m/s with steer ${CFG.signSteer} (floor ${CFG.minLateralM} m). ` +
          `Even a 60 m effective turn radius puts a kart 3.3 m off line over that window, so this is not a steerable ` +
          `vehicle: the input is being scaled to nothing, clamped, or dropped before it reaches the yaw torque. ` +
          `The SIGN checks above are separate and may well be green — a kart can be correctly signed and still inert.`,
      )
    }
    const asym = response.metrics.asymmetry
    if (asym > CFG.asymmetryReportFrac) {
      response.notes.push(
        `left/right asymmetry is ${(asym * 100).toFixed(1)}% (+steer ${dLatR.toFixed(3)} m, -steer ${dLatL.toFixed(3)} m). ` +
          `Reported, not gated — a banked or cambered road makes the two directions genuinely different manoeuvres. ` +
          `Worth a look if the road here is flat: bank at t=${t0.toFixed(4)} is ${(sAt0.bank * 180 / Math.PI).toFixed(2)} deg.`,
      )
    }
    let growing = true
    for (let i = 1; i < table.length; i++) {
      if (!(Math.abs(table[i].dLateralM) > Math.abs(table[i - 1].dLateralM))) growing = false
    }
    response.metrics.monotoneInSteer = growing
    if (!growing) {
      response.notes.push(
        `displacement is not monotone in steer magnitude across ${CFG.rateSteers.join(', ')} — reported, not gated. ` +
          `A tyre model that saturates does exactly this at full lock and it is not a bug; a controller that clamps ` +
          `at 0.3 is.`,
      )
    }
  }

  // =========================================================================
  // the reference AI
  // =========================================================================
  if (!have.setDriver) {
    pend(aiCommand, 'requires setDriver; it is not available in this build')
    pend(aiOutcome, 'requires setDriver; it is not available in this build')
  } else {
    const offset = Math.min(CFG.aiOffsetM, Math.max(0.5, sAt0.halfWidth - 1.5))
    const lineAt0 = typeof track.racingLine === 'function' ? track.racingLine(t0) : 0
    aiCommand.metrics.racingLineM = lineAt0
    aiCommand.metrics.offsetM = offset

    /*
     * Place the kart to the LEFT of the racing line on the flattest section of
     * the lap. There is then exactly one correct action and no ambiguity about
     * what "the racing line calls for a right-hand move" means: the line is to
     * the kart's right, at every look-ahead distance, for the whole probe.
     * Then the mirror.
     */
    const fromLeft = await run(0, {
      driver: 'referenceAI',
      lateral: lineAt0 - offset,
      ticks: CFG.aiTicks,
      slice: CFG.aiSliceTicks,
    })
    const fromRight = await run(0, {
      driver: 'referenceAI',
      lateral: lineAt0 + offset,
      ticks: CFG.aiTicks,
      slice: CFG.aiSliceTicks,
    })
    if (have.setInput) h.setDriver(pid, 'scripted')

    if (fromLeft.blocked || fromRight.blocked) {
      pend(aiCommand, `an AI run was blocked: ${fromLeft.blocked || fromRight.blocked}`)
      pend(aiOutcome, `an AI run was blocked: ${fromLeft.blocked || fromRight.blocked}`)
    } else {
      const direct = fromLeft.meanCommandedSteer !== null && fromRight.meanCommandedSteer !== null
      const proxy = fromLeft.meanWheelSteer !== null && fromRight.meanWheelSteer !== null
      aiCommand.metrics.source = direct ? 'lastInput' : proxy ? 'wheels[].steerAngle' : 'none'
      aiCommand.metrics.fromLeftSteer = direct ? fromLeft.meanCommandedSteer : fromLeft.meanWheelSteer
      aiCommand.metrics.fromRightSteer = direct ? fromRight.meanCommandedSteer : fromRight.meanWheelSteer
      aiCommand.metrics.fromLeftWheelRad = fromLeft.meanWheelSteer
      aiCommand.metrics.fromRightWheelRad = fromRight.meanWheelSteer

      if (!direct && !proxy) {
        pend(
          aiCommand,
          `NO ROUTE TO THE AI'S COMMANDED STEER. HarnessAPI declares no way to read the InputFrame a driver ` +
            `produced, and KartState.wheels[].steerAngle was unavailable too, so the sign of what the AI ASKED FOR ` +
            `is UNTESTED by this run. ai-outcome below grades where the kart ended up, which a double negation ` +
            `passes. See the CONTRACT SURFACE block at the end of this run.`,
        )
      } else {
        if (!direct) {
          pend(
            aiCommand,
            `graded through KartState.wheels[].steerAngle ("Steer angle applied to this wheel. Sign follows ` +
              `STEERING SIGN"), not through the AI's InputFrame — HarnessAPI declares no route to that. It is one ` +
              `layer downstream of the command, so an implementation that negates between the driver and the wheel ` +
              `would defeat it. See the CONTRACT SURFACE block at the end of this run.`,
          )
        }
        const cmdL = aiCommand.metrics.fromLeftSteer
        const cmdR = aiCommand.metrics.fromRightSteer
        // The proxy is an angle in radians, the direct read is a -1..1 intent.
        // Only the sign is asserted; the floor scales with which one we have.
        const floor = direct ? CFG.minAiSteer : CFG.minAiSteer * 0.05
        const why =
          `The AI "solves for a lateral target and expresses the result in this same intent space; if an AI ` +
          `implementation finds itself flipping a sign to make karts turn the right way, the bug is in the AI's ` +
          `frame maths, not in this convention." The chassis checks above grade the conversion independently, so ` +
          `if they are green and this is red, the negation is inside the AI.`
        if (!(cmdL > floor)) {
          fail(
            aiCommand,
            `placed ${offset.toFixed(2)} m to the LEFT of the racing line at t=${t0.toFixed(4)}, the reference AI ` +
              `commanded a mean steer of ${cmdL === null ? 'nothing' : cmdL.toFixed(4)} over ${(CFG.aiTicks * CFG.simStep).toFixed(2)} s ` +
              `(source: ${aiCommand.metrics.source}; needs > +${floor}). The line is to its right; steer > 0 is the ` +
              `only correct request. ${why}`,
          )
        }
        if (!(cmdR < -floor)) {
          fail(
            aiCommand,
            `placed ${offset.toFixed(2)} m to the RIGHT of the racing line, the reference AI commanded a mean steer ` +
              `of ${cmdR === null ? 'nothing' : cmdR.toFixed(4)} (needs < -${floor}). ${why}`,
          )
        }
      }

      // -- ai-outcome --------------------------------------------------------
      const closedL = -(fromLeft.lateralEnd - fromLeft.lateral0)
      const closedR = fromRight.lateralEnd - fromRight.lateral0
      aiOutcome.metrics.startedLeftBy = offset
      aiOutcome.metrics.closedFromLeftM = -closedL
      aiOutcome.metrics.closedFromRightM = -closedR
      aiOutcome.metrics.seconds = CFG.aiTicks * CFG.simStep
      aiOutcome.metrics.gateM = CFG.aiConvergenceM
      if (!(closedL < -CFG.aiConvergenceM)) {
        fail(
          aiOutcome,
          `from ${offset.toFixed(2)} m left of the line the AI closed ${(-closedL).toFixed(3)} m in ` +
            `${(CFG.aiTicks * CFG.simStep).toFixed(2)} s (needs > ${CFG.aiConvergenceM} m toward the line). ` +
            `This is the OUTCOME check and it is deliberately separate from ai-command: a controller can command ` +
            `the right sign and still be too weak to drive, and it can command the wrong sign into an inverted ` +
            `chassis and drive perfectly.`,
        )
      }
      if (!(closedR < -CFG.aiConvergenceM)) {
        fail(
          aiOutcome,
          `from ${offset.toFixed(2)} m right of the line the AI closed ${(-closedR).toFixed(3)} m in ` +
            `${(CFG.aiTicks * CFG.simStep).toFixed(2)} s (needs > ${CFG.aiConvergenceM} m toward the line).`,
        )
      }
    }
  }

  return R
}

// ---------------------------------------------------------------------------
// The reference world, and its sabotages
// ---------------------------------------------------------------------------
/*
 * A complete, honest world implementing the slice of HarnessAPI this file
 * drives, installed on `window.__harness` so the battery runs against it
 * unchanged — the same code, the same extraction path, no second implementation
 * to drift out of step.
 *
 * THE TRACK is a stadium: two 220 m straights joined by two 90 m-radius
 * semicircles, parameterised by exact arc length because the shape has a closed
 * form for it. It is flat and unbanked on purpose. A steering-sign harness that
 * needed a banked, climbing, curving road to find its answer would be measuring
 * something else, and the straight is what makes the probe unambiguous. The
 * bends exist so `racingLine` has something to do and `curvature` has a sign.
 *
 * THE KART is a kinematic bicycle: yaw integrates steer x speed / wheelbase, and
 * velocity points along the chassis. No tyre model, no slip — this file grades a
 * SIGN and a rough magnitude, and a sign does not need a tyre.
 *
 * THE AI is pure pursuit on the racing line: locate, look ahead a fixed arc
 * length, take the target's offset in the chassis frame, steer toward it. It
 * expresses its answer in InputFrame.steer with no negation anywhere, which is
 * exactly what the contract asks a real AI to do.
 *
 * SABOTAGES. Each is a plausible mistake rather than a nonsense value, each is
 * owned by one named check, and two of them additionally require a named other
 * check to stay QUIET — because the whole argument for having two anchors is
 * that they fail independently, and an argument nobody has watched hold is not
 * evidence.
 */
function installReferenceWorld(sabotage) {
  const S = sabotage || 'none'

  function V(x, y, z) {
    this.x = x || 0
    this.y = y || 0
    this.z = z || 0
  }
  V.prototype.set = function (x, y, z) {
    this.x = x
    this.y = y
    this.z = z
    return this
  }
  V.prototype.clone = function () {
    return new V(this.x, this.y, this.z)
  }
  const vec = () => new V(0, 0, 0)

  // -- the stadium -----------------------------------------------------------
  const STRAIGHT = 220
  const RADIUS = 90
  const HALF_WIDTH = 8
  const BEND = Math.PI * RADIUS
  const LENGTH = 2 * STRAIGHT + 2 * BEND
  const wrap01 = (x) => x - Math.floor(x)

  /*
   * right = (-tangent.z, 0, tangent.x). That is tangent x normal with normal =
   * +Y, and it is the driver's right under the contract's axes: facing -Z the
   * right is +X, facing +X the right is +Z. Both fall out of it.
   */
  function frameAt(s, out) {
    const u = ((s % LENGTH) + LENGTH) % LENGTH
    let px
    let pz
    let tx
    let tz
    let k
    if (u < STRAIGHT) {
      px = -STRAIGHT / 2 + u
      pz = -RADIUS
      tx = 1
      tz = 0
      k = 0
    } else if (u < STRAIGHT + BEND) {
      const a = -Math.PI / 2 + (u - STRAIGHT) / RADIUS
      px = STRAIGHT / 2 + RADIUS * Math.cos(a)
      pz = RADIUS * Math.sin(a)
      tx = -Math.sin(a)
      tz = Math.cos(a)
      k = 1 / RADIUS
    } else if (u < 2 * STRAIGHT + BEND) {
      px = STRAIGHT / 2 - (u - STRAIGHT - BEND)
      pz = RADIUS
      tx = -1
      tz = 0
      k = 0
    } else {
      const a = Math.PI / 2 + (u - 2 * STRAIGHT - BEND) / RADIUS
      px = -STRAIGHT / 2 + RADIUS * Math.cos(a)
      pz = RADIUS * Math.sin(a)
      tx = -Math.sin(a)
      tz = Math.cos(a)
      k = 1 / RADIUS
    }
    out.position.set(px, 0, pz)
    out.tangent.set(tx, 0, tz)
    out.normal.set(0, 1, 0)
    out.right.set(-tz, 0, tx)
    out.halfWidth = HALF_WIDTH
    out.bank = 0
    out.curvature = k
    return out
  }

  const mkSample = () => ({
    position: vec(),
    tangent: vec(),
    normal: vec(),
    right: vec(),
    halfWidth: 0,
    bank: 0,
    curvature: 0,
  })
  const sample = (t, out) => frameAt(wrap01(t) * LENGTH, out)

  const P = 4096
  const lutX = new Float64Array(P)
  const lutZ = new Float64Array(P)
  {
    const s = mkSample()
    for (let i = 0; i < P; i++) {
      frameAt((i / P) * LENGTH, s)
      lutX[i] = s.position.x
      lutZ[i] = s.position.z
    }
  }
  const locScratch = mkSample()
  function locate(p, out) {
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < P; i++) {
      const d = (lutX[i] - p.x) ** 2 + (lutZ[i] - p.z) ** 2
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    // Refine onto the chord either side of the argmin.
    let bt = best / P
    let bd = Infinity
    for (const b of [(best - 1 + P) % P, best]) {
      const n = (b + 1) % P
      const ex = lutX[n] - lutX[b]
      const ez = lutZ[n] - lutZ[b]
      const ee = ex * ex + ez * ez
      let u = ee > 0 ? ((p.x - lutX[b]) * ex + (p.z - lutZ[b]) * ez) / ee : 0
      if (u < 0) u = 0
      else if (u > 1) u = 1
      const qx = lutX[b] + ex * u - p.x
      const qz = lutZ[b] + ez * u - p.z
      const d = qx * qx + qz * qz
      if (d < bd) {
        bd = d
        bt = wrap01((b + u) / P)
      }
    }
    frameAt(bt * LENGTH, locScratch)
    const dx = p.x - locScratch.position.x
    const dy = p.y - locScratch.position.y
    const dz = p.z - locScratch.position.z
    let lateral = dx * locScratch.right.x + dz * locScratch.right.z
    // The track's own sign convention, inverted. A kart that is correct now
    // looks wrong to the track anchor and stays right to the world anchor.
    if (S === 'track-lateral-flip' || S === 'both-flipped') lateral = -lateral
    out.t = bt
    out.lateral = lateral
    out.height = dy
    out.onTrack = Math.abs(lateral) <= HALF_WIDTH + 1.5
    out.checkpointIndex = Math.floor(bt * 8)
    return out
  }

  const rlScratch = mkSample()
  function racingLine(t) {
    frameAt(wrap01(t) * LENGTH, rlScratch)
    return 0.55 * HALF_WIDTH * Math.tanh(rlScratch.curvature * 60)
  }

  const track = {
    length: LENGTH,
    group: { position: vec() },
    sample,
    locate,
    surfaceAt: () => 1,
    racingLine,
    checkpoints: [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875],
    startGrid: [],
  }

  // -- the kart --------------------------------------------------------------
  /*
   * Yaw about +Y. Rotating (0,0,-1) by `a` about +Y gives (-sin a, 0, -cos a),
   * whose derivative with respect to `a` is -(cos a, 0, -sin a) = -right. So
   * INCREASING yaw turns the kart LEFT, and a right-hand steer must DECREASE it.
   * Writing that out is the whole reason this reference exists: it is the one
   * place in the file where the sign is derived rather than asserted, and
   * `chassis-inverted` is what happens if you get it wrong.
   */
  const SIM_STEP = 1 / 120
  /*
   * Expressed as a minimum turn radius rather than a wheelbase, because a
   * kinematic bicycle with a kart's real 1 m wheelbase and 30 deg of lock turns
   * at 5 rad/s with no tyre model to stop it, which is not a plausible subject
   * to grade a harness against. 14 m at full lock is a kart.
   */
  const MIN_TURN_RADIUS = 14
  const MAX_STEER_RAD = 0.52
  const kart = { x: 0, y: 0, z: 0, yaw: 0, speed: 0, steer: 0, wheelSteer: 0 }
  let driver = 'scripted'
  let injected = { steer: 0, throttle: 0, brake: 0, drift: false, useItem: false, look: 0 }
  let phase = 'idle'
  let tick = 0
  let nonce = 0

  const aiSample = mkSample()
  const aiLoc = { t: 0, lateral: 0, height: 0, onTrack: true, checkpointIndex: 0 }
  const aiP = vec()

  function referenceAISteer() {
    aiP.set(kart.x, kart.y, kart.z)
    locate(aiP, aiLoc)
    const LOOK = 14
    const ta = wrap01(aiLoc.t + LOOK / LENGTH)
    frameAt(ta * LENGTH, aiSample)
    const targetX = aiSample.position.x + aiSample.right.x * racingLine(ta)
    const targetZ = aiSample.position.z + aiSample.right.z * racingLine(ta)
    // Into the chassis frame. Forward = (-sin yaw, 0, -cos yaw); right = (cos
    // yaw, 0, -sin yaw). Positive `lat` means the target is to the driver's
    // right, and the intent that heads for it is a POSITIVE steer.
    const dx = targetX - kart.x
    const dz = targetZ - kart.z
    const fwd = -Math.sin(kart.yaw) * dx + -Math.cos(kart.yaw) * dz
    const lat = Math.cos(kart.yaw) * dx + -Math.sin(kart.yaw) * dz
    let steer = 2.2 * Math.atan2(lat, Math.max(2, Math.abs(fwd)))
    if (S === 'ai-negates' || S === 'ai-double-negation') steer = -steer
    if (S === 'ai-lazy') steer *= 0.02
    return Math.max(-1, Math.min(1, steer))
  }

  function stepOne() {
    let frame = injected
    if (driver === 'referenceAI') {
      frame = { steer: referenceAISteer(), throttle: 1, brake: 0, drift: false, useItem: false, look: 0 }
    } else if (driver === 'idle') {
      frame = { steer: 0, throttle: 0, brake: 0, drift: false, useItem: false, look: 0 }
    }
    // WheelState.steerAngle: "Sign follows STEERING SIGN". One conversion, here.
    kart.wheelSteer = frame.steer * MAX_STEER_RAD

    let effective = frame.steer
    if (S === 'steer-100x-weak') effective *= 0.01
    if (S === 'nondeterministic') {
      nonce = (nonce * 1103515245 + 12345) & 0x7fffffff
      effective += ((nonce / 0x7fffffff) - 0.5) * 0.02
    }

    if (phase === 'racing') {
      const target = frame.throttle * 30
      kart.speed += (target - kart.speed) * 0.02
      // A right-hand steer decreases yaw. `chassis-inverted` is the second
      // negation this whole harness exists to find.
      const dir = S === 'chassis-inverted' || S === 'both-flipped' || S === 'ai-double-negation' ? +1 : -1
      kart.yaw += dir * effective * (kart.speed / MIN_TURN_RADIUS) * SIM_STEP
      const fx = -Math.sin(kart.yaw)
      const fz = -Math.cos(kart.yaw)
      kart.x += fx * kart.speed * SIM_STEP
      kart.z += fz * kart.speed * SIM_STEP
    }
    tick++
    if (phase === 'countdown' && tick > countdownEndsAt) phase = 'racing'
  }

  let countdownEndsAt = 0

  function snapshot() {
    const wheel = () => ({
      compression: 0.5,
      steerAngle: kart.wheelSteer,
      spin: 0,
      grounded: true,
      surface: 1,
      slip: 0,
    })
    const rear = () => ({ compression: 0.5, steerAngle: 0, spin: 0, grounded: true, surface: 1, slip: 0 })
    return {
      position: { x: kart.x, y: kart.y, z: kart.z },
      quaternion: { x: 0, y: Math.sin(kart.yaw / 2), z: 0, w: Math.cos(kart.yaw / 2) },
      velocity: { x: -Math.sin(kart.yaw) * kart.speed, y: 0, z: -Math.cos(kart.yaw) * kart.speed },
      speed: kart.speed,
      surface: 1,
      grounded: true,
      drift: { active: false, direction: 0, charge: 0, tier: 0, slipAngle: 0 },
      boost: { active: false, remaining: 0, strength: 1, source: 'none' },
      wheels: [wheel(), wheel(), rear(), rear()],
      stunTime: 0,
    }
  }

  function placeAt(t, lateral, speed) {
    const s = mkSample()
    frameAt(wrap01(t) * LENGTH, s)
    // seek() places by the TRACK's own lateral convention, so an inverted track
    // places the kart on the mirrored side. That is faithful: it is what a real
    // seek built on ITrack would do, and the world anchor is unmoved by it.
    const lat = S === 'track-lateral-flip' || S === 'both-flipped' ? -lateral : lateral
    kart.x = s.position.x + s.right.x * lat
    kart.y = 0
    kart.z = s.position.z + s.right.z * lat
    kart.yaw = Math.atan2(-s.tangent.x, -s.tangent.z)
    kart.speed = speed === undefined ? 0 : speed
  }

  window.__harness = {
    version: 2,
    ready: Promise.resolve(),
    get playerKartId() {
      return 0
    },
    get track() {
      return track
    },
    async resetRace() {
      phase = 'idle'
      tick = 0
      nonce = 0
      driver = 'referenceAI'
      injected = { steer: 0, throttle: 0, brake: 0, drift: false, useItem: false, look: 0 }
      placeAt(0, 0, 0)
    },
    startRace() {
      phase = 'countdown'
      countdownEndsAt = tick + 360
    },
    setDriver(_id, mode) {
      driver = mode
    },
    setInput(frame) {
      driver = 'scripted'
      injected = Object.assign({}, injected, frame)
    },
    releaseInput() {
      injected = { steer: 0, throttle: 0, brake: 0, drift: false, useItem: false, look: 0 }
    },
    async stepTicks(n) {
      for (let i = 0; i < n; i++) stepOne()
    },
    async seek(o) {
      placeAt(o.t, o.lateral || 0, o.speed)
    },
    telemetry() {
      return { sinceTick: 0, tick, phase, clock: tick * SIM_STEP, karts: [] }
    },
    kartSnapshot() {
      return snapshot()
    },
    /* Deliberately absent: lastInput. The live build does not declare it either,
     * so the reference must not — otherwise the self-test would exercise a path
     * the real run never takes, and the PENDING that path prints, which is the
     * only record of the gap, would never be seen. */
  }
}

// ---------------------------------------------------------------------------
// Which check owns which sabotage, and which must stay quiet
// ---------------------------------------------------------------------------
const SABOTAGES = [
  {
    name: 'chassis-inverted',
    owner: 'player-world-anchor',
    what: 'a right-hand steer yaws the kart left — the bug this whole file exists for',
  },
  {
    name: 'track-lateral-flip',
    owner: 'player-track-anchor',
    quiet: ['player-world-anchor'],
    what: 'ITrack.locate reports -lateral; the kart is fine. The world anchor must NOT fire',
  },
  {
    name: 'both-flipped',
    owner: 'player-world-anchor',
    quiet: ['player-track-anchor'],
    what: 'the track AND the chassis are inverted — reads perfect in track terms. THE reason there are two anchors',
  },
  {
    name: 'steer-100x-weak',
    owner: 'steer-response',
    quiet: ['player-track-anchor', 'player-world-anchor'],
    what: 'correct sign, a hundredth of the authority — a sign gate must not catch this and a magnitude gate must',
  },
  {
    name: 'ai-negates',
    owner: 'ai-command',
    what: 'the AI commands the wrong sign into a correct chassis, so it drives away from the line',
  },
  {
    name: 'ai-double-negation',
    owner: 'ai-command',
    quiet: ['ai-outcome'],
    what: 'inverted chassis plus a negating AI: the karts drive correctly and the command is wrong',
  },
  {
    name: 'ai-lazy',
    owner: 'ai-outcome',
    quiet: ['ai-command'],
    what: 'the AI asks for the right thing at 2% authority and never reaches the line',
  },
  {
    name: 'nondeterministic',
    owner: 'repeatability',
    what: 'a per-tick perturbation — two runs of the same test stop being the same test',
  },
]

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
const CHECK_ORDER = [
  'surface',
  'straight',
  'repeatability',
  'player-track-anchor',
  'player-world-anchor',
  'steer-response',
  'ai-command',
  'ai-outcome',
]

function fmt(n, digits = 3) {
  if (n === null || n === undefined) return '-'
  if (!Number.isFinite(n)) return String(n)
  if (n !== 0 && (Math.abs(n) < 1e-3 || Math.abs(n) >= 1e6)) return n.toExponential(2)
  return n.toFixed(digits)
}

function summarise(c) {
  const m = c.metrics
  switch (c.id) {
    case 'surface':
      return `${m.live ?? 0} live, ${m.pending ?? 0} pending`
    case 'straight':
      return `t=${fmt(m.t0, 4)}  worst |k| ${fmt(m.worstCurvature)} 1/m (R ${fmt(m.minRadiusM, 0)} m)  halfWidth ${fmt(m.halfWidthM, 2)} m`
    case 'repeatability':
      return `spread lateral ${fmt(m.lateralSpreadM)} m  world ${fmt(m.worldSpreadM)} m  -> floor ${fmt(m.floorM)} m`
    case 'player-track-anchor':
      return `+steer ${fmt(m.rightDLateralM)} m   -steer ${fmt(m.leftDLateralM)} m   (gate ±${fmt(m.gateM)} m, ${fmt(m.seconds, 2)} s at ${fmt(m.meanSpeed, 1)} m/s)`
    case 'player-world-anchor':
      return `+steer ${fmt(m.rightDWorldM)} m   -steer ${fmt(m.leftDWorldM)} m   along ${fmt(m.alongM, 1)} m   anchors agree ${m.anchorsAgree === undefined ? '-' : m.anchorsAgree}`
    case 'steer-response':
      return `smallest ${fmt(m.smallestMagnitudeM)} m (floor ${fmt(m.minLateralM, 2)} m)  asymmetry ${m.asymmetry === undefined ? '-' : (m.asymmetry * 100).toFixed(1) + '%'}  monotone ${m.monotoneInSteer === undefined ? '-' : m.monotoneInSteer}`
    case 'ai-command':
      return `from left ${fmt(m.fromLeftSteer, 4)}   from right ${fmt(m.fromRightSteer, 4)}   via ${m.source ?? '-'}`
    case 'ai-outcome':
      return `closed ${fmt(m.closedFromLeftM)} m / ${fmt(m.closedFromRightM)} m of ${fmt(m.startedLeftBy, 2)} m in ${fmt(m.seconds, 2)} s`
    default:
      return ''
  }
}

function printRateTable(result) {
  const c = result.checks.find((x) => x.id === 'steer-response')
  if (!c || !c.metrics.table) return
  console.log('')
  console.log('LATERAL RATE — the number §10c criterion 4 asks for, reported not gated')
  console.log('  steer   d(lateral) over window   m/s per unit steer   terminal m/s per unit steer   at speed')
  for (const r of c.metrics.table) {
    console.log(
      `  ${r.steer.toFixed(2).padStart(5)}   ${fmt(r.dLateralM).padStart(21)}   ${fmt(r.ratePerSteer).padStart(18)}   ` +
        `${fmt(r.terminalRatePerSteer).padStart(27)}   ${fmt(r.meanSpeed, 1)} m/s`,
    )
  }
  console.log(
    '  The window rate is the MEAN lateral velocity over the run; a step steer input has not settled by then, so\n' +
      '  the terminal-slice rate is the closer thing to a steady-state number. Both are quoted because neither is\n' +
      '  the whole answer and picking one silently would be picking the flattering one.',
  )
}

function printReport(result) {
  const byId = new Map(result.checks.map((c) => [c.id, c]))
  let n = 0
  for (const id of CHECK_ORDER) {
    const c = byId.get(id)
    if (!c) continue
    n++
    console.log(`${c.status.padEnd(4)} ${String(n).padStart(2)}  ${c.id.padEnd(21)} ${summarise(c)}`)
    for (const p of c.problems) console.log(`        ${p.replace(/\n/g, '\n        ')}`)
    for (const note of c.notes) console.log(`        note: ${note.replace(/\n/g, '\n        ')}`)
  }
  return {
    failed: result.checks.filter((c) => c.status === 'FAIL'),
    pending: result.checks.filter((c) => c.status === 'PEND'),
  }
}

// ---------------------------------------------------------------------------
// The contract surface this file wants and does not have
// ---------------------------------------------------------------------------
const CONTRACT_ADDITION = `
  CONTRACT SURFACE THIS HARNESS NEEDS — not added here; a contract change is the lead's
  ─────────────────────────────────────────────────────────────────────────────────────
  There is no way to read what a DRIVER asked for. HarnessAPI can inject an
  InputFrame (setInput) and can read the resulting KartState (kartSnapshot), but
  the frame the reference AI produced on the last tick is not exposed anywhere.

      // src/types.ts, inside HarnessAPI
      /**
       * The InputFrame the given kart's driver produced on the most recent tick,
       * before IKart.step converted it to yaw torque. Null for a kart with no
       * driver, or before the first tick.
       *
       * STEERING SIGN says the AI "expresses the result in this same intent
       * space". Without this, that sentence is unfalsifiable: an AI that negates
       * to compensate for an inverted chassis drives perfectly, and the only
       * evidence of the bug is the sign of a number nothing can read.
       */
      lastInput(kartId: number): Readonly<InputFrame> | null

  Until it lands, ai-command grades KartState.wheels[].steerAngle instead, whose
  contract is "Steer angle applied to this wheel. Sign follows STEERING SIGN".
  That is a real signal and it is one layer downstream: an implementation that
  negates between the driver and the wheel defeats it, and this file reports that
  gap as PENDING on every run rather than quietly counting it as coverage.

  THE ALTERNATIVES, and why they lose
  · Infer the command from the outcome. That is ai-outcome, it already exists,
    and a double negation passes it — which is the entire failure mode.
  · Emit the command on the EventBus. Continuous per-tick data does not belong on
    an event channel; the contract says so where it defines GameEvents.
  · Import the AI directly in the page. Works only on the dev server, so it
    measures a module graph players never run.
`

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------
const BATTERY_SRC = battery.toString()
const REFERENCE_SRC = installReferenceWorld.toString()
const RUN_CFG = { ...CFG, pendingMarker: PENDING_MARKER }

async function runIn(page) {
  return page.evaluate(
    async ({ src, cfg }) => {
      const fn = new Function('return (' + src + ')')()
      return fn(cfg)
    },
    { src: BATTERY_SRC, cfg: RUN_CFG },
  )
}

async function install(page, sabotage) {
  await page.evaluate(
    ({ src, sab }) => {
      const fn = new Function('return (' + src + ')')()
      fn(sab)
    },
    { src: REFERENCE_SRC, sab: sabotage },
  )
}

function blockedMessage(blocked) {
  return {
    NO_HARNESS: 'window.__harness is absent — the game did not boot.',
  }[blocked]
}

async function main() {
  if (MODE === 'live') {
    const server = await startServer({ mode: useDev ? 'dev' : 'preview' })
    const browser = await launch({ timing: false })
    try {
      const { page, consoleErrors } = await openGame(browser, server.url, {
        seed: CFG.seed,
        quality: 'high',
      })
      const out = await runIn(page)

      console.log('steer-test — STEERING SIGN, end to end   (ART_DIRECTION §10c criterion 4)')
      console.log('')

      if (out.blocked) {
        console.log(`PENDING  ${blockedMessage(out.blocked)}`)
        console.log('')
        console.log('Nothing was measured. The instrument itself is proven: node tools/steer-test.mjs --broken')
        process.exitCode = 1
        return
      }

      const { failed, pending } = printReport(out)
      printRateTable(out)
      writeFileSync(path.join(OUT, 'steer-test.json'), JSON.stringify(out, null, 2))
      console.log('')
      if (out.missing.length) {
        console.log(
          `PENDING  ${out.missing.length} HarnessAPI method(s) refused with the "not available yet" marker: ` +
            `${out.missing.join(', ')}.`,
        )
        console.log(
          '         That is the honest answer, not a skip. Everything downstream of them measured NOTHING, and a\n' +
            '         gate that quietly covers nothing prints the same green as a gate that passed.',
        )
      }
      if (out.broke.length) {
        for (const b of out.broke) console.log(`FAIL     ${b}`)
      }
      if (pending.some((c) => c.id === 'ai-command') || out.missing.length) {
        console.log(CONTRACT_ADDITION)
      }
      console.log(`report   ${path.join(OUT, 'steer-test.json')}`)
      console.log('')

      if (consoleErrors.length) {
        console.error(`FAIL — console errors:\n  ${consoleErrors.join('\n  ')}`)
        process.exitCode = 1
      } else if (failed.length) {
        console.error(`FAIL — ${failed.length} check(s) violated: ${failed.map((c) => c.id).join(', ')}`)
        process.exitCode = 1
      } else if (pending.length) {
        console.log(
          `${pending.length} check(s) PENDING: ${pending.map((c) => c.id).join(', ')}. No violations, but coverage is ` +
            `incomplete. NOT A PASS.`,
        )
        process.exitCode = 1
      } else {
        console.log('PASS — steer > 0 means the driver’s right, for the scripted player and for the reference AI.')
      }
    } finally {
      await browser.close()
      await server.stop()
    }
    return
  }

  /*
   * --reference and --broken need no server and no game. That is deliberate: a
   * self-test that can only run once the subsystem it guards exists is
   * unavailable during exactly the window when the instrument is unproven, which
   * is now.
   */
  const browser = await launch({ timing: false })
  try {
    const page = await browser.newPage()
    page.on('pageerror', (e) => console.error(`page error: ${e}`))
    await page.goto('about:blank')

    console.log('steer-test — self-test against a reference world')
    console.log('')

    await install(page, 'none')
    const clean = await runIn(page)
    if (clean.blocked) {
      console.error(`SELF-TEST FAILED — the reference world did not install: ${clean.blocked}`)
      process.exitCode = 1
      return
    }
    console.log('reference (unsabotaged)')
    const { failed, pending } = printReport(clean)
    printRateTable(clean)
    console.log('')

    if (failed.length) {
      console.error(
        `SELF-TEST FAILED — the clean reference violated ${failed.length} check(s): ${failed.map((c) => c.id).join(', ')}.\n` +
          `Either a limit in CFG is wrong or a detector is. Until this is green the instrument's verdicts on the real\n` +
          `game mean nothing, because it has been shown to fail something correct.`,
      )
      process.exitCode = 1
      return
    }
    /*
     * The reference deliberately does NOT implement `lastInput`, because the
     * live build does not declare it either — so ai-command is expected to be
     * PENDING here, and that PENDING is itself part of what the self-test
     * proves: the fallback path is the one that will run on the real game.
     */
    const unexpectedPending = pending.filter((c) => c.id !== 'ai-command')
    if (unexpectedPending.length) {
      console.error(
        `SELF-TEST FAILED — the clean reference left ${unexpectedPending.map((c) => c.id).join(', ')} PENDING; the\n` +
          `reference is meant to exercise every check except the one the contract cannot reach.`,
      )
      process.exitCode = 1
      return
    }
    if (MODE === 'reference') {
      console.log('PASS — the reference world satisfies every steering-sign invariant.')
      return
    }

    console.log('sabotages — each must be caught by the check that owns it, and leave the named others QUIET')
    console.log('')
    const misses = []
    const rows = []
    for (const sab of SABOTAGES) {
      await install(page, sab.name)
      const out = await runIn(page)
      const byId = new Map((out.checks || []).map((c) => [c.id, c]))
      const target = byId.get(sab.owner)
      const caught = Boolean(target && target.status === 'FAIL')
      /*
       * "Quiet" means DID NOT FIRE, not "reported PASS". A check that is PENDING
       * because the contract cannot reach it — ai-command without `lastInput` —
       * has not fired, and demanding PASS here would make the independence test
       * fail for a reason that has nothing to do with independence.
       */
      const noisy = (sab.quiet || []).filter((id) => {
        const c = byId.get(id)
        return !c || c.status === 'FAIL'
      })
      const collateral = (out.checks || [])
        .filter((c) => c.status === 'FAIL' && c.id !== sab.owner)
        .map((c) => c.id)
      const ok = caught && noisy.length === 0
      rows.push({ name: sab.name, owner: sab.owner, caught, noisy, collateral })
      console.log(
        `${ok ? 'CAUGHT' : 'MISSED'}  ${sab.name.padEnd(20)} -> ${sab.owner.padEnd(21)} ${sab.what}` +
          (collateral.length ? `\n                                                    also red: ${collateral.join(', ')}` : '') +
          ((sab.quiet || []).length ? `\n                                                    must stay quiet: ${sab.quiet.join(', ')} — ${noisy.length ? 'DID NOT: ' + noisy.join(', ') : 'held'}` : ''),
      )
      if (caught) {
        console.log(`                             ${target.problems[0].split('\n')[0].slice(0, 140)}`)
      } else {
        misses.push(`${sab.name}: ${sab.owner} stayed ${target ? target.status : 'absent'}`)
      }
      if (noisy.length) {
        misses.push(
          `${sab.name}: ${noisy.join(', ')} was supposed to stay quiet and did not — the checks are not independent, ` +
            `so "both went red" is not evidence that either one works`,
        )
      }
    }

    // A harness with the kart surface missing must PEND, never PASS.
    console.log('')
    const stub = await page.evaluate(
      async ({ src, cfg }) => {
        window.__harness = {
          version: 2,
          get playerKartId() {
            throw new Error('[harness] playerKartId is not available yet — the subsystem that provides it has not been built.')
          },
          get track() {
            throw new Error('[harness] track is not available yet — the subsystem that provides it has not been built.')
          },
          resetRace: () => {
            throw new Error('[harness] resetRace is not available yet — the subsystem that provides it has not been built.')
          },
          startRace: () => {
            throw new Error('[harness] startRace is not available yet — the subsystem that provides it has not been built.')
          },
          setDriver: () => {
            throw new Error('[harness] setDriver is not available yet — the subsystem that provides it has not been built.')
          },
          setInput: () => {
            throw new Error('[harness] setInput is not available yet — the subsystem that provides it has not been built.')
          },
          releaseInput: () => {
            throw new Error('[harness] releaseInput is not available yet — the subsystem that provides it has not been built.')
          },
          stepTicks: () => {
            throw new Error('[harness] stepTicks is not available yet — the subsystem that provides it has not been built.')
          },
          seek: () => {
            throw new Error('[harness] seek is not available yet — the subsystem that provides it has not been built.')
          },
          telemetry: () => {
            throw new Error('[harness] telemetry is not available yet — the subsystem that provides it has not been built.')
          },
          kartSnapshot: () => {
            throw new Error('[harness] kartSnapshot is not available yet — the subsystem that provides it has not been built.')
          },
        }
        const fn = new Function('return (' + src + ')')()
        return fn(cfg)
      },
      { src: BATTERY_SRC, cfg: RUN_CFG },
    )
    const stubGreen = (stub.checks || []).filter((c) => c.status === 'PASS')
    if (stubGreen.length) {
      misses.push(`a harness with no kart surface still passed: ${stubGreen.map((c) => c.id).join(', ')}`)
      console.log(`MISSED  ${'pending-harness'.padEnd(20)} -> ${stubGreen.map((c) => c.id).join(', ')} reported PASS with nothing to measure`)
    } else {
      console.log(
        `CAUGHT  ${'pending-harness'.padEnd(20)} -> every check reported PEND; none reported PASS. ` +
          `Missing: ${(stub.missing || []).join(', ')}`,
      )
    }

    // And an absent harness must be blocked, not silently green.
    await page.evaluate(() => {
      delete window.__harness
    })
    const absent = await runIn(page)
    if (absent.blocked === 'NO_HARNESS') {
      console.log(`CAUGHT  ${'absent-harness'.padEnd(20)} -> blocked: NO_HARNESS`)
    } else {
      misses.push(`an absent __harness produced ${absent.blocked ?? 'a result'} instead of NO_HARNESS`)
      console.log(`MISSED  ${'absent-harness'.padEnd(20)} -> ${absent.blocked ?? 'a result'}`)
    }

    writeFileSync(path.join(OUT, 'steer-test-selftest.json'), JSON.stringify({ rows, misses }, null, 2))
    console.log('')
    if (misses.length) {
      console.error(`SELF-TEST FAILED — ${misses.length} problem(s):`)
      for (const m of misses) console.error(`  ${m}`)
      console.error('A detector that only goes red because a neighbour noticed is inert. Fix it before trusting a verdict.')
      process.exitCode = 1
    } else {
      console.log(
        `SELF-TEST PASSED — the reference passes clean, all ${SABOTAGES.length} sabotages were caught by their owning\n` +
          `check, the independence of the two anchors held on both of the sabotages built to break it, and a harness\n` +
          `with nothing behind it reported PENDING rather than green.`,
      )
    }
  } finally {
    await browser.close()
  }
}

await main()
