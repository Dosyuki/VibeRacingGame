/**
 * THE AUTOMATED PLAYER. Full unattended races, graded on outcomes.
 *
 *   node tools/autoplay.mjs                 # gate the live build
 *   node tools/autoplay.mjs --broken        # self-test: prove every gate fires
 *   node tools/autoplay.mjs --seeds=3       # more circuits, more evidence
 *   node tools/autoplay.mjs --laps=5        # longer races for a tighter noise floor
 *
 * WHY THIS EXISTS IN ROUND 1 AND NOT ROUND 9
 * ------------------------------------------
 * Inverted steering, unusable touch controls and a pause menu that permanently
 * ended the race all survived three full rounds of six reviewers scoring
 * beautiful stills, elsewhere. A screenshot cannot find a gameplay bug. This
 * file and `tools/steer-test.mjs` are the answer to that, and they are scheduled
 * first for the same reason a thermometer is bought before the patient arrives.
 *
 * WHAT IT GATES — ART_DIRECTION §10c, made executable
 *
 *   determinism   two identical runs produce identical lap times. Not a §10c
 *                 criterion; it is the PRECONDITION for criterion 1. A margin
 *                 measured on a simulation that does not repeat is not a margin.
 *   drift-pays    §10c 1. Drifting laps beat clean laps by more than 4x the
 *                 measured noise floor.
 *   ladder        §10c 2. >=60% of drift attempts bank tier 1 or better,
 *                 >=25% reach tier 3.
 *   completes     §10c 6. Every kart finishes, nobody respawn-loops, nobody
 *                 sticks.
 *
 * REPORTED, NEVER GATED — the diagnostics for whoever tunes next
 *
 *   lap-time spread across karts and laps, and how it compares to the margin
 *   wall contacts per kart per lap
 *   WHERE ON THE LAP karts lose time, binned around the circuit and ranked
 *
 * Every threshold above is parsed out of ART_DIRECTION.md at run time rather
 * than copied here. A harness that hardcodes 60% keeps passing after somebody
 * raises the rubric to 70%, and it keeps passing for the wrong reason.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE NOISE FLOOR, AND THE PART OF §10c THAT DOES NOT SURVIVE CONTACT WITH THIS
 * SIMULATION
 *
 * §10c criterion 1 says the margin must exceed "the run-to-run noise floor" by
 * 4x. Read literally, on this project, that number is ZERO: the contract's CLOCK
 * and DETERMINISM sections require that the same seed and the same build produce
 * the same lap times, bit for bit. Run the same race twice, subtract, get zero,
 * and "4 x 0" is a gate that passes on any margin at all including a negative
 * one rounded up. A criterion that reduces to a division by zero has to be
 * interpreted, and interpreting it silently would be the same sin as quoting a
 * margin without a floor.
 *
 * So this file measures THREE things and says which one it gated on:
 *
 *   1. The repeat floor. The same seed, the same mode, twice, differenced. This
 *      is the literal reading. It MUST be exactly zero and it is checked as its
 *      own gate — if it is not zero, determinism is broken and nothing else on
 *      this page is a measurement.
 *   2. The within-mode lap spread. The standard deviation of individual lap
 *      times inside one mode: traffic, item hits, a missed apex. This is the
 *      real variability of the quantity being compared.
 *   3. The standard error of the mean lap time, sd/sqrt(n) — how far the number
 *      actually being differenced would move on a fresh draw of the same
 *      conditions. THIS is what the gate divides by.
 *
 * The SEM is the honest denominator: it is what "run-to-run" means once the run
 * is a mean over many laps, it shrinks as more laps are collected (so more
 * measurement buys a finer resolvable margin, which is correct), and margin >=
 * 4 SEM is an ordinary four-sigma claim rather than a number chosen to be
 * passable. It is also floored at one SIMULATION_STEP, because no lap time can
 * resolve a difference finer than a tick.
 *
 * SEEDS CHANGE THE CIRCUIT, so the comparison is always PAIRED WITHIN A SEED.
 * `ResetOptions.seed` regenerates the world; a clean lap on seed A and a
 * drifting lap on seed B are laps of two different racetracks and their
 * difference is mostly architecture. Extra seeds are extra independent
 * replications of the same paired experiment, never extra samples in one pool.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * HOW A HARNESS IS SUPPOSED TO KNOW A LAP TIME
 * --------------------------------------------
 * `KartTelemetry.lapTimes`, and nothing else. `Standing.lapTimes` is behind
 * `IRace`, which HarnessAPI does not expose, and timing laps from the outside by
 * watching `t` wrap would quantise every lap to the polling interval and measure
 * the harness rather than the game. The contract does not say whether those
 * seconds come from the tick counter or from a wall clock, and the difference is
 * the difference between this gate working and this gate measuring how busy the
 * laptop was, so the run REPORTS whether every lap time is an exact multiple of
 * SIMULATION_STEP and what each answer would mean. See the diagnostics.
 *
 * CLEAN VERSUS DRIFTING IS NOT IN THE CONTRACT
 * --------------------------------------------
 * `DriverMode` is human | scripted | referenceAI | idle. There is no way to ask
 * the reference AI to stop drifting, so criterion 1's controlled comparison
 * cannot be run at all today. This file asks for one optional field
 * (`ResetOptions.aiDrift`), passes it, and then VERIFIES IT TOOK by checking
 * that the clean race banked no drifts — a flag that is silently ignored would
 * otherwise produce two identical races, a margin of zero, and a confident FAIL
 * against an AI that is working perfectly. When it has not taken, drift-pays
 * reports PENDING and names the line it needs. See CONTRACT_ADDITIONS.
 *
 * SELF-TEST. `--broken` needs no game and no server. It installs a complete
 * reference game on `window.__harness` — eight karts, a binned circuit, drift
 * attempts with a tunable tier distribution, wall hits, respawns, tick-quantised
 * lap times — asserts the gates pass it clean, then applies ten sabotages and
 * asserts each is caught BY THE GATE THAT OWNS IT, with the STATUS THAT SABOTAGE
 * SHOULD PRODUCE. Two of them must produce PENDING rather than FAIL, because a
 * missing experiment and a failed experiment are different findings and a
 * harness that conflates them is how a build ships with a gate that covered
 * nothing.
 */

import path from 'node:path'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { ROOT, startServer } from './vite-server.mjs'
import { launch, openGame } from './lib/browser.mjs'

const args = process.argv.slice(2)
const selfTest = args.includes('--broken')
const useDev = args.includes('--dev')
const argNum = (name, dflt) => {
  const a = args.find((x) => x.startsWith(`--${name}=`))
  if (!a) return dflt
  const v = Number(a.split('=')[1])
  return Number.isFinite(v) && v > 0 ? v : dflt
}

const OUT = path.join(ROOT, 'tools', 'out')
mkdirSync(OUT, { recursive: true })

// ---------------------------------------------------------------------------
// The contract's constants and the rubric's numbers, re-derived from source
// ---------------------------------------------------------------------------
/*
 * Neither file is remembered. A harness that hardcodes 60% keeps passing after
 * the rubric moves to 70% and keeps doing it silently; a harness that hardcodes
 * 1/120 reports every rate wrong by the ratio the day the tick rate changes.
 * If a parse fails this file refuses to run rather than falling back to a
 * remembered value, because a remembered value is exactly the
 * plausible-but-unknowable answer this repo exists to prevent.
 */
const TYPES_PATH = path.join(ROOT, 'src', 'types.ts')
const RUBRIC_PATH = path.join(ROOT, 'ART_DIRECTION.md')
const typesSrc = readFileSync(TYPES_PATH, 'utf8')
const rubricSrc = readFileSync(RUBRIC_PATH, 'utf8')

function refuse(what, file) {
  console.error(
    `FAIL  cannot read ${what} out of ${file}.\n` +
      `      This harness re-derives its thresholds instead of remembering them.\n` +
      `      Refusing to run against a value it cannot confirm.`,
  )
  process.exit(1)
}

function ratioFrom(src, file, re, what) {
  const m = src.match(re)
  const num = m ? Number(m[1]) : NaN
  const den = m && m[2] !== undefined ? Number(m[2]) : 1
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) refuse(what, file)
  return num / den
}

const SIMULATION_STEP = ratioFrom(
  typesSrc,
  TYPES_PATH,
  /SIMULATION_STEP\s*:\s*Seconds\s*=\s*([\d.]+)(?:\s*\/\s*([\d.]+))?/,
  'SIMULATION_STEP',
)

/** §10c 1: "…exceeding the run-to-run noise floor by at least 4×." */
const NOISE_MULTIPLE = ratioFrom(rubricSrc, RUBRIC_PATH, /noise floor by at least\s+(\d+)\s*×/, '§10c criterion 1 noise multiple')
/** §10c 2: "≥ 60% of drift attempts by the reference AI bank at least tier 1" */
const TIER1_RATE = ratioFrom(rubricSrc, RUBRIC_PATH, /≥\s*(\d+)%\s*of drift attempts/, '§10c criterion 2 tier-1 rate') / 100
/** §10c 2: "≥ 25% reach tier 3." */
const TIER3_RATE = ratioFrom(rubricSrc, RUBRIC_PATH, /≥\s*(\d+)%\s*reach tier 3/, '§10c criterion 2 tier-3 rate') / 100
/** §10c 6: "Every kart finishes three laps unattended…" */
const RUBRIC_LAPS = (() => {
  const m = rubricSrc.match(/Every kart finishes\s+([a-z]+|\d+)\s+laps/)
  if (!m) refuse('§10c criterion 6 lap count', RUBRIC_PATH)
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 }
  const n = words[m[1]] ?? Number(m[1])
  if (!Number.isFinite(n) || n < 1) refuse('§10c criterion 6 lap count', RUBRIC_PATH)
  return n
})()

/** The literal `src/main.ts` throws for surface that does not exist yet.
 *  `tools/contract-check.mjs` keys on the same string. */
const PENDING_MARKER = 'is not available yet'

// ---------------------------------------------------------------------------
// Limits. DERIVED or guess, marked per line.
// ---------------------------------------------------------------------------
const CFG = {
  simStep: SIMULATION_STEP,
  noiseMultiple: NOISE_MULTIPLE,
  tier1Rate: TIER1_RATE,
  tier3Rate: TIER3_RATE,

  /** §10c 6 says three laps. Overridable upward; the completes gate always
   *  grades whatever was actually asked for and says so. */
  laps: argNum('laps', RUBRIC_LAPS),
  /*
   * Seeds are independent CIRCUITS, not repeats — `ResetOptions.seed`
   * regenerates the world. One seed is one complete paired experiment and is
   * the affordable default; more seeds are replications and each one costs
   * three full races.
   */
  seeds: argNum('seeds', 1),
  seed0: 20260807,

  /*
   * DERIVED. 30 ticks is 0.25 s, which at 30 m/s is 7.5 m — about a fifth of a
   * lap bin, so the time-loss binning below is not dominated by its own
   * sampling grid. Smaller costs telemetry() calls for no resolution that the
   * bins can use.
   */
  pollTicks: 30,
  /*
   * DERIVED from the report it feeds: 32 bins over a ~1.2 km lap is ~37 m per
   * bin, which is about one corner. Finer bins split a single corner across two
   * rows and the ranking stops naming places a tuner recognises.
   */
  bins: 32,

  /*
   * guess, with the arithmetic. The tick budget for a race is
   * laps * length / minMeanSpeed, and a kart that cannot average 8 m/s over a
   * lap is not racing — Surface.OffTrack is the worst the game has at grip 0.5
   * and 9 m/s^2 of drag, and even limping across it beats this. It exists so a
   * stuck field cannot hang the run for ever, and hitting it is itself a
   * reported failure rather than a timeout.
   */
  minMeanSpeed: 8,
  /** DERIVED: the countdown is 3 s per GameEvents race:countdown; 10 s of ticks
   *  is three times that and a build that never starts is a real fault. */
  countdownTicksMax: 1200,

  /*
   * DERIVED from the confidence the gate needs. §10c 2 asks whether the tier-3
   * rate clears 25%. Distinguishing 25% from 32.5% at 95% confidence needs
   * n = p(1-p)(1.96/0.075)^2 = 0.25*0.75*683 = 128 attempts. Below that the
   * rate is reported with its interval and the gate is PENDING, because a 100%
   * tier-3 rate on four attempts is not evidence of anything.
   */
  minDriftAttempts: 128,

  /*
   * guess, with the arithmetic. Over three laps a kart that genuinely loses the
   * road once a lap is unlucky, not looping; twice a lap is a loop. The failure
   * this names is the one where a kart respawns into the wall it just hit and
   * does it for the rest of the race.
   */
  maxRespawnsPerLap: 2,
  /*
   * DERIVED-ish. `ticksWithoutProgress` counts ticks since `bestProgress` last
   * increased, so any forward motion at all resets it. A legitimate stop is a
   * spin and a recovery, roughly 1.5 s. 360 ticks is 3 s — twice that, and a
   * kart that has made no forward progress for three seconds is on a wall.
   */
  maxTicksWithoutProgress: 360,

  /*
   * Reported, not gated. Under this many comparable laps the SEM is built on so
   * few samples that quoting it is theatre; the drift-pays gate goes PENDING.
   * Two laps per kart across eight karts is 16, which is the default run.
   */
  minComparableLaps: 8,
}

// ---------------------------------------------------------------------------
// In the page: probe the measurement surface
// ---------------------------------------------------------------------------
/*
 * Probed by CALLING. `src/main.ts` declares every method the contract lists and
 * throws the pending marker from the ones that do not exist yet, so presence
 * proves nothing. Anything that throws something OTHER than the marker is a
 * breakage rather than an absence, and the two are reported separately —
 * that distinction is the entire value of the marker.
 */
async function probeSurface(cfg) {
  const h = window.__harness
  if (!h) return { blocked: 'NO_HARNESS' }
  const missing = []
  const broke = []
  const have = {}
  async function probe(name, fn) {
    try {
      await fn()
      have[name] = true
    } catch (err) {
      const msg = String((err && err.message) || err)
      if (msg.indexOf(cfg.pendingMarker) >= 0) missing.push(name)
      else broke.push(`${name}: ${msg}`)
      have[name] = false
    }
  }

  await probe('track', () => {
    if (!h.track || typeof h.track.length !== 'number') throw new Error('present but has no ITrack.length')
  })
  await probe('resetRace', () => h.resetRace({ seed: cfg.seed0, totalLaps: cfg.laps }))
  await probe('playerKartId', () => {
    if (typeof h.playerKartId !== 'number') throw new Error(`playerKartId is ${typeof h.playerKartId}`)
  })
  await probe('setDriver', () => h.setDriver(0, 'referenceAI'))
  await probe('stepTicks', () => h.stepTicks(1))
  await probe('telemetry', () => {
    const t = h.telemetry()
    if (!t || !Array.isArray(t.karts)) throw new Error('telemetry() returned no RaceTelemetry.karts array')
    if (t.karts.length === 0) throw new Error('telemetry().karts is empty — there is no field to race')
  })
  await probe('startRace', () => h.startRace())

  const tel = have.telemetry ? h.telemetry() : null
  return {
    missing,
    broke,
    have,
    kartCount: tel ? tel.karts.length : 0,
    trackLength: have.track ? h.track.length : null,
    checkpoints: have.track && h.track.checkpoints ? Array.prototype.slice.call(h.track.checkpoints) : [],
  }
}

// ---------------------------------------------------------------------------
// In the page: one complete unattended race
// ---------------------------------------------------------------------------
/*
 * Advances the world with `stepTicks` and nothing else. A wall-clock wait
 * samples a different point of the simulation on every machine, and then two
 * runs of the "same" race are not the same race — which is precisely the
 * property the drift margin is built on.
 *
 * Returns plain numbers. Nothing here retains a telemetry object across a step:
 * the contract promises a deep value copy per call, and relying on that promise
 * to hold across a mutation would be exactly the flakiness it exists to prevent.
 */
async function runRace(cfg) {
  const h = window.__harness
  const BINS = cfg.bins
  const drivers = {}
  const tel0 = h.telemetry()
  for (const k of tel0.karts) drivers[k.kartId] = 'referenceAI'

  /*
   * `aiDrift` is NOT in ResetOptions today. It is passed anyway and its effect
   * is verified downstream by checking that a clean race banked no drifts —
   * an ignored flag must not be able to masquerade as a controlled comparison.
   */
  await h.resetRace({ seed: cfg.seed, totalLaps: cfg.laps, drivers, aiDrift: cfg.mode })
  h.startRace()

  let ticks = 0
  let countdownTicks = 0
  while (countdownTicks < cfg.countdownTicksMax) {
    const phase = h.telemetry().phase
    if (phase === 'racing') break
    if (phase === 'finished') break
    await h.stepTicks(cfg.pollTicks)
    countdownTicks += cfg.pollTicks
  }
  if (h.telemetry().phase !== 'racing') {
    return { blocked: `the race never reached phase 'racing' — it stayed '${h.telemetry().phase}' for ${countdownTicks} ticks` }
  }

  const ids = tel0.karts.map((k) => k.kartId)
  const state = {}
  for (const id of ids) {
    state[id] = {
      kartId: id,
      binTicks: new Array(BINS).fill(0),
      binPasses: new Array(BINS).fill(0),
      lastBin: -1,
      maxTicksWithoutProgress: 0,
      maxTicksWithoutProgressLap1: 0,
      lapTickMarks: [],
      lastCompletedLaps: 0,
    }
  }

  const budget = Math.ceil((cfg.laps * cfg.trackLength) / cfg.minMeanSpeed / cfg.simStep)
  let hitBudget = false
  let tel = h.telemetry()
  while (true) {
    const allDone = tel.karts.every((k) => k.finished)
    if (allDone || tel.phase === 'finished') break
    if (ticks >= budget) {
      hitBudget = true
      break
    }
    await h.stepTicks(cfg.pollTicks)
    ticks += cfg.pollTicks
    tel = h.telemetry()
    for (const k of tel.karts) {
      const s = state[k.kartId]
      if (!s) continue
      /*
       * THE STALL PEAK IS TAKEN ON LAP 2 ONWARDS, AND THIS IS NOT LAXNESS.
       *
       * `Standing.progress` is `completedLaps + t` and the contract says in as
       * many words that it is NOT monotonic. The grid sits BEHIND the start
       * line, so every kart begins lap 1 at t ≈ 0.99 and then wraps to 0.00 —
       * `bestProgress` latches that 0.99 at the lights and cannot be beaten
       * again until the kart is 99% of the way round. A perfectly healthy field
       * therefore reads a whole lap of "no progress" once, by construction, and
       * gating on it would fail every correct build on its first lap.
       *
       * The lap-1 peak is kept and reported separately rather than discarded,
       * because it is the only way to tell that artefact apart from a kart that
       * is genuinely stuck on the grid.
       */
      if (k.completedLaps >= 1) {
        if (k.ticksWithoutProgress > s.maxTicksWithoutProgress) s.maxTicksWithoutProgress = k.ticksWithoutProgress
      } else if (k.ticksWithoutProgress > s.maxTicksWithoutProgressLap1) {
        s.maxTicksWithoutProgressLap1 = k.ticksWithoutProgress
      }
      /*
       * Bin the lap and attribute this chunk to whichever bin the kart is in at
       * the end of it. That is a quarter-second quantisation of a ~37 m bin —
       * good enough to rank where time goes, and the report says so rather than
       * implying a precision the sampling does not have.
       */
      let b = Math.floor(((k.t % 1) + 1) % 1 * BINS)
      // NaN passes both comparisons below, so it is rejected explicitly: a
      // telemetry that omits `t` must show up as a missing diagnostic, not as
      // a silent write into binTicks[NaN] that nothing ever reads back.
      if (!Number.isFinite(b)) b = -1
      else if (b < 0) b = 0
      else if (b >= BINS) b = BINS - 1
      // Lap 1 carries a standing start and is not comparable with the rest.
      if (b >= 0 && k.completedLaps >= 1) {
        s.binTicks[b] += cfg.pollTicks
        if (b !== s.lastBin) s.binPasses[b] += 1
      }
      s.lastBin = b
      if (k.completedLaps > s.lastCompletedLaps) {
        s.lapTickMarks.push(ticks)
        s.lastCompletedLaps = k.completedLaps
      }
    }
  }

  const final = h.telemetry()
  return {
    seed: cfg.seed,
    mode: cfg.mode,
    laps: cfg.laps,
    ticks,
    countdownTicks,
    budget,
    hitBudget,
    phase: final.phase,
    clock: final.clock,
    karts: final.karts.map((k) => {
      const s = state[k.kartId] || {}
      return {
        kartId: k.kartId,
        lapTimes: Array.prototype.slice.call(k.lapTimes || []),
        bestLap: k.bestLap,
        finished: Boolean(k.finished),
        completedLaps: k.completedLaps,
        driftAttempts: k.driftAttempts,
        driftReleases: Array.prototype.slice.call(k.driftReleases || []),
        driftBoostSeconds:
          k.boostSecondsBySource && typeof k.boostSecondsBySource.drift === 'number' ? k.boostSecondsBySource.drift : null,
        respawns: k.respawns,
        wallHits: k.wallHits,
        ticksWithoutProgress: k.ticksWithoutProgress,
        maxTicksWithoutProgress: s.maxTicksWithoutProgress || 0,
        maxTicksWithoutProgressLap1: s.maxTicksWithoutProgressLap1 || 0,
        binTicks: s.binTicks || [],
        binPasses: s.binPasses || [],
        lapTickMarks: s.lapTickMarks || [],
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// The reference game, and its sabotages
// ---------------------------------------------------------------------------
/*
 * A complete, honest game implementing the slice of HarnessAPI this file drives,
 * installed on `window.__harness` so the gates run against it unchanged. Same
 * code, same extraction path, no second implementation to drift out of step.
 *
 * IT IS NOT A PHYSICS SIMULATION AND MUST NOT BE. This file grades lap times,
 * drift-tier ratios and completion, all of which are counters; a reference that
 * modelled tyres would be a second game to debug and would prove nothing extra
 * about the instrument. What it DOES model faithfully is the shape of the data:
 * tick-quantised lap times, a lap made of fast and slow bins, per-lap
 * variability so the noise floor has something to measure, drift attempts that
 * only happen in corners, a tier distribution, wall hits and respawns.
 *
 * Determinism is by construction — every random draw is an LCG keyed on (seed,
 * kart, lap, bin), never on call order — which is what lets `nondeterministic`
 * be a sabotage rather than the default state.
 */
function installReferenceGame(sabotage) {
  const S = sabotage || 'none'
  const SIM_STEP = 1 / 120
  const LENGTH = 1000
  const BINS = 32
  const KARTS = 8
  const COUNTDOWN = 360

  /** Deterministic in its arguments, not in call order. */
  function draw(a, b, c, d) {
    let x = (a * 374761393 + b * 668265263 + c * 2147483647 + d * 1274126177) >>> 0
    x = Math.imul(x ^ (x >>> 13), 1274126177) >>> 0
    x = (x ^ (x >>> 16)) >>> 0
    return x / 4294967296
  }

  /** The circuit: a fixed pattern of straights and corners, same every seed.
   *  cornerness in [0,1]; 1 is a hairpin. */
  const corner = new Array(BINS)
  for (let i = 0; i < BINS; i++) {
    const u = i / BINS
    corner[i] = Math.max(0, Math.sin(u * Math.PI * 6) * 0.55 + Math.sin(u * Math.PI * 2 + 1) * 0.45)
  }

  const BASE_SPEED = 30
  /*
   * A speed bonus in the corner bins only. 0.14 lands the clean reference at
   * roughly nine times its own noise floor — comfortably over the 4x rubric, so
   * the pass is not itself balanced on a knife edge. `drift-margin-in-the-noise`
   * lands at about 2x: a REAL margin, in the right direction, that the gate must
   * still reject. If that sabotage ever starts passing, the 4x arithmetic has
   * stopped biting and the gate is decorative.
   */
  const DRIFT_GAIN = S === 'drift-pays-nothing' ? 0 : S === 'drift-margin-in-the-noise' ? 0.03 : 0.14
  const LAP_NOISE = 0.07
  const ATTEMPT_RATE = S === 'few-attempts' ? 0.05 : 0.9
  /** [tier0, tier1, tier2, tier3] release probabilities. */
  const TIERS =
    S === 'ladder-tier1-starved'
      ? [0.5, 0.2, 0.2, 0.1]
      : S === 'ladder-tier3-starved'
        ? [0.15, 0.4, 0.3, 0.15]
        : [0.2, 0.25, 0.25, 0.3]

  const track = {
    length: LENGTH,
    group: { position: { x: 0, y: 0, z: 0, clone: () => ({ x: 0, y: 0, z: 0 }) } },
    checkpoints: [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875],
    startGrid: [],
    sample: (t, out) => out,
    locate: (p, out) => out,
    surfaceAt: () => 1,
    racingLine: () => 0,
  }

  let seed = 0
  let laps = 3
  let mode = 'seek'
  let phase = 'idle'
  let tick = 0
  let startTick = 0
  let drift = true
  let globalNonce = 0
  let karts = []

  function reset(options) {
    const o = options || {}
    seed = o.seed === undefined ? 0 : o.seed
    laps = o.totalLaps === undefined ? 3 : o.totalLaps
    mode = o.aiDrift === undefined ? 'seek' : o.aiDrift
    // A build that ignores an unknown option is exactly what this models.
    drift = S === 'clean-mode-ignored' ? true : mode !== 'clean'
    phase = 'idle'
    tick = 0
    startTick = 0
    karts = []
    for (let k = 0; k < KARTS; k++) {
      karts.push({
        kartId: k,
        s: -k * 3,
        lap: 0,
        lapStartTick: 0,
        lapTimes: [],
        finished: false,
        driftAttempts: 0,
        driftReleases: [0, 0, 0, 0],
        driftBoost: 0,
        respawns: 0,
        wallHits: 0,
        lastBin: -1,
        bestProgress: -Infinity,
        ticksWithoutProgress: 0,
        skill: 1 + (k - (KARTS - 1) / 2) * 0.004,
        stuck: false,
      })
    }
  }

  function stepOne() {
    tick++
    if (phase === 'countdown') {
      if (tick - startTick >= COUNTDOWN) phase = 'racing'
      return
    }
    if (phase !== 'racing') return
    let allDone = true
    for (const k of karts) {
      if (k.finished) continue
      allDone = false
      const t = ((k.s / LENGTH) % 1 + 1) % 1
      let b = Math.floor(t * BINS)
      if (b >= BINS) b = BINS - 1
      const c = corner[b]

      if (b !== k.lastBin) {
        // -- entering a new bin: the discrete events of a lap --------------
        const r = draw(seed, k.kartId, k.lap, b)
        if (c > 0.55) {
          if (drift && r < ATTEMPT_RATE) {
            k.driftAttempts++
            const q = draw(seed + 7, k.kartId, k.lap, b)
            let acc = 0
            for (let tier = 0; tier < 4; tier++) {
              acc += TIERS[tier]
              if (q < acc) {
                k.driftReleases[tier]++
                k.driftBoost += tier * 0.35
                break
              }
            }
          }
          if (draw(seed + 13, k.kartId, k.lap, b) < 0.05) k.wallHits++
          if (draw(seed + 29, k.kartId, k.lap, b) < 0.012) k.respawns++
        }
        // Three a lap: past the two-a-lap limit without being a nonsense value,
        // so the threshold is what rejects it rather than the magnitude.
        if (S === 'respawn-loop' && k.kartId === 3 && (b === 6 || b === 14 || b === 26)) k.respawns += 1
        if (S === 'stuck-kart' && k.kartId === 5 && k.lap === 1 && b === 20) k.stuck = true
        k.lastBin = b
      }

      let noise = (draw(seed + 101, k.kartId, k.lap * BINS + b, 0) - 0.5) * 2 * LAP_NOISE
      if (S === 'nondeterministic') {
        globalNonce = (globalNonce * 1103515245 + 12345) & 0x7fffffff
        noise += (globalNonce / 0x7fffffff - 0.5) * 0.02
      }
      const bonus = drift && c > 0.55 ? DRIFT_GAIN : 0
      const v = k.stuck ? 0 : BASE_SPEED * (1 - 0.4 * c) * k.skill * (1 + bonus) * (1 + noise)
      k.s += v * SIM_STEP

      const progress = k.lap + t
      if (progress > k.bestProgress) {
        k.bestProgress = progress
        k.ticksWithoutProgress = 0
      } else {
        k.ticksWithoutProgress++
      }

      if (k.s >= (k.lap + 1) * LENGTH) {
        k.lap++
        k.lapTimes.push((tick - k.lapStartTick) * SIM_STEP)
        k.lapStartTick = tick
        if (k.lap >= laps) {
          k.finished = !(S === 'never-finishes' && k.kartId === 2)
          if (S === 'never-finishes' && k.kartId === 2) k.s = k.lap * LENGTH - 1
        }
      }
    }
    if (allDone) phase = 'finished'
  }

  reset({})

  window.__harness = {
    version: 2,
    ready: Promise.resolve(),
    get playerKartId() {
      return 0
    },
    get track() {
      return track
    },
    async resetRace(options) {
      reset(options)
    },
    startRace() {
      phase = 'countdown'
      startTick = tick
    },
    setDriver() {},
    async stepTicks(n) {
      for (let i = 0; i < n; i++) stepOne()
    },
    telemetry() {
      return {
        sinceTick: 0,
        tick,
        phase,
        clock: (tick - startTick - COUNTDOWN) * SIM_STEP,
        karts: karts.map((k) => ({
          kartId: k.kartId,
          driftAttempts: k.driftAttempts,
          driftReleases: k.driftReleases.slice(),
          boostSecondsBySource: { none: 0, drift: k.driftBoost, pad: 0, item: 0, slipstream: 0 },
          respawns: k.respawns,
          wallHits: k.wallHits,
          lapTimes: k.lapTimes.slice(),
          bestLap: k.lapTimes.length ? Math.min.apply(null, k.lapTimes) : null,
          finished: k.finished,
          completedLaps: k.lap,
          lastCheckpoint: 0,
          t: ((k.s / LENGTH) % 1 + 1) % 1,
          lateral: 0,
          ticksWithoutProgress: k.ticksWithoutProgress,
        })),
      }
    },
    /* Deliberately absent: kartSnapshot, seek, setInput, releaseInput,
     * injectInput and the rest of HarnessAPI. This file drives races and reads
     * counters; a reference that stubbed the other half would be handing back
     * values it cannot know, which is the exact failure tools/contract-check.mjs
     * exists to catch. What autoplay does not call, the reference does not
     * pretend to have. */
  }
}

// ---------------------------------------------------------------------------
// Analysis. Pure arithmetic on the race summaries — no page, no browser.
// ---------------------------------------------------------------------------

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN)
function stdev(a) {
  if (a.length < 2) return NaN
  const m = mean(a)
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1))
}

/** Lap times excluding lap 1, which carries the standing start. */
function comparableLaps(race) {
  const out = []
  for (const k of race.karts) for (let i = 1; i < k.lapTimes.length; i++) out.push(k.lapTimes[i])
  return out
}

function mkCheck(id, title) {
  return { id, title, status: 'PASS', metrics: {}, problems: [], notes: [] }
}
const fail = (c, m) => {
  c.problems.push(m)
  c.status = 'FAIL'
}
const pend = (c, m) => {
  c.notes.push(m)
  if (c.status !== 'FAIL') c.status = 'PEND'
}

/**
 * @param {{ seed:number, seek:object, seekRepeat:object, clean:object }[]} runs
 */
function grade(runs, cfg) {
  const determinism = mkCheck('determinism', 'the same seed twice produces the same lap times')
  const driftPays = mkCheck('drift-pays', '§10c 1 — a drifting lap beats a clean lap by > 4x the noise floor')
  const ladder = mkCheck('ladder', '§10c 2 — the drift ladder is reachable')
  const completes = mkCheck('completes', '§10c 6 — every kart finishes, nobody loops, nobody sticks')
  const checks = [determinism, driftPays, ladder, completes]

  // -- determinism ----------------------------------------------------------
  let worstRepeat = 0
  let worstWhere = null
  let repeatPairs = 0
  for (const r of runs) {
    if (!r.seek || !r.seekRepeat || r.seek.blocked || r.seekRepeat.blocked) continue
    for (let i = 0; i < r.seek.karts.length; i++) {
      const a = r.seek.karts[i]
      const b = r.seekRepeat.karts[i]
      if (!b) continue
      const n = Math.max(a.lapTimes.length, b.lapTimes.length)
      for (let j = 0; j < n; j++) {
        repeatPairs++
        const d = Math.abs((a.lapTimes[j] ?? NaN) - (b.lapTimes[j] ?? NaN))
        if (!Number.isFinite(d)) {
          if (worstWhere === null) worstWhere = { seed: r.seed, kartId: a.kartId, lap: j + 1, a: a.lapTimes[j], b: b.lapTimes[j] }
          worstRepeat = Infinity
        } else if (d > worstRepeat) {
          worstRepeat = d
          worstWhere = { seed: r.seed, kartId: a.kartId, lap: j + 1, a: a.lapTimes[j], b: b.lapTimes[j] }
        }
      }
    }
  }
  determinism.metrics.pairs = repeatPairs
  determinism.metrics.worstDeltaS = repeatPairs ? worstRepeat : null
  if (!repeatPairs) {
    pend(determinism, 'no pair of identical runs completed, so determinism was not tested and the drift margin below rests on nothing')
  } else if (worstRepeat > 0) {
    const w = worstWhere
    fail(
      determinism,
      `two IDENTICAL races (seed ${w.seed}, same mode, same drivers) produced different lap times: kart ${w.kartId} ` +
        `lap ${w.lap} was ${w.a === undefined ? 'absent' : w.a.toFixed(4)} s and then ` +
        `${w.b === undefined ? 'absent' : w.b.toFixed(4)} s (worst delta ${worstRepeat === Infinity ? 'a missing lap' : worstRepeat.toFixed(4) + ' s'}). ` +
        `The contract's DETERMINISM section requires that the same seed and build produce the same lap times, and ` +
        `THE CLOCK requires that no wall-clock delta reaches physics, AI or race progression. Until this is zero, ` +
        `the drift margin below is a difference between two numbers that both move on their own, and no threshold ` +
        `on it means anything. Look for performance.now() or Date.now() inside fixedUpdate, Math.random() outside ` +
        `ctx.rngFor, or iteration over a Set.`,
    )
  }

  // -- drift-pays -----------------------------------------------------------
  const perSeed = []
  let anySeekDrifts = false
  let anyCleanDrifts = false
  for (const r of runs) {
    if (!r.seek || !r.clean || r.seek.blocked || r.clean.blocked) continue
    const seekAttempts = r.seek.karts.reduce((a, k) => a + (k.driftAttempts || 0), 0)
    const cleanAttempts = r.clean.karts.reduce((a, k) => a + (k.driftAttempts || 0), 0)
    if (seekAttempts > 0) anySeekDrifts = true
    if (cleanAttempts > 0) anyCleanDrifts = true
    const seekLaps = comparableLaps(r.seek)
    const cleanLaps = comparableLaps(r.clean)
    if (!seekLaps.length || !cleanLaps.length) continue
    const semSeek = stdev(seekLaps) / Math.sqrt(seekLaps.length)
    const semClean = stdev(cleanLaps) / Math.sqrt(cleanLaps.length)
    perSeed.push({
      seed: r.seed,
      seekAttempts,
      cleanAttempts,
      n: Math.min(seekLaps.length, cleanLaps.length),
      meanSeek: mean(seekLaps),
      meanClean: mean(cleanLaps),
      sdSeek: stdev(seekLaps),
      sdClean: stdev(cleanLaps),
      semSeek,
      semClean,
      margin: mean(cleanLaps) - mean(seekLaps),
      floor: Math.max(semSeek, semClean, cfg.simStep, worstRepeat === Infinity ? 0 : worstRepeat),
    })
  }
  driftPays.metrics.perSeed = perSeed
  driftPays.metrics.noiseMultiple = cfg.noiseMultiple

  const totalComparable = perSeed.reduce((a, s) => a + s.n, 0)
  if (!perSeed.length) {
    pend(driftPays, 'no seed produced both a drifting race and a clean race with comparable laps, so §10c criterion 1 measured NOTHING')
  } else if (!anySeekDrifts) {
    pend(
      driftPays,
      `the drift-seeking races banked ZERO drift attempts across ${perSeed.length} seed(s). There is no treatment ` +
        `to measure: comparing a lap with no drifts against a lap with no drifts is not criterion 1, however green ` +
        `the arithmetic comes out. Either the reference AI does not drift yet, or drift telemetry is not wired.`,
    )
  } else if (anyCleanDrifts) {
    pend(
      driftPays,
      `the CLEAN races banked ${perSeed.reduce((a, s) => a + s.cleanAttempts, 0)} drift attempt(s), so ` +
        `ResetOptions.aiDrift='clean' did not take — almost certainly because it is not in the contract yet and the ` +
        `option was ignored. Both arms of the experiment were therefore the same arm. That is a MISSING experiment, ` +
        `not a failed one: reporting it as FAIL would blame an AI that may be working perfectly. See the CONTRACT ` +
        `SURFACE block below.`,
    )
  } else if (totalComparable < cfg.minComparableLaps) {
    pend(
      driftPays,
      `only ${totalComparable} comparable lap(s) after excluding lap 1 (limit ${cfg.minComparableLaps}). A standard ` +
        `error built on that many samples is decoration, not a noise floor. Run more laps: --laps=5.`,
    )
  } else {
    const pooledMargin = mean(perSeed.map((s) => s.margin))
    const pooledFloor = Math.max.apply(null, perSeed.map((s) => s.floor))
    const ratio = pooledMargin / pooledFloor
    driftPays.metrics.marginS = pooledMargin
    driftPays.metrics.floorS = pooledFloor
    driftPays.metrics.ratio = ratio
    driftPays.metrics.comparableLaps = totalComparable
    const sameSign = perSeed.every((s) => Math.sign(s.margin) === Math.sign(pooledMargin))
    driftPays.metrics.consistentAcrossSeeds = sameSign
    const evidence =
      `Margin is the mean of the per-seed (clean - drifting) differences over laps 2..n, ${totalComparable} lap(s) ` +
      `in total; the floor is the largest standard error of a mode's mean lap time, floored at one SIMULATION_STEP ` +
      `(${cfg.simStep.toFixed(5)} s) because no lap time resolves finer than a tick. Per-seed detail is in the report.`
    if (!(pooledMargin > 0)) {
      fail(
        driftPays,
        (pooledMargin === 0
          ? `drifting laps are EXACTLY as fast as clean laps — the two arms differ by 0 s to the last bit, which ` +
            `means the drift boost is being banked and then doing nothing to the kart's speed. `
          : `drifting laps are ${(-pooledMargin).toFixed(4)} s SLOWER than clean laps. `) +
          `(drifting mean ${mean(perSeed.map((s) => s.meanSeek)).toFixed(3)} s, clean ` +
          `${mean(perSeed.map((s) => s.meanClean)).toFixed(3)} s). ` +
          `§10c 1 requires drifting to pay, and ART_DIRECTION §7 requires the release to "produce a measurable lap ` +
          `advantage". A drift that costs time makes the whole ladder decorative. ${evidence}`,
      )
    } else if (!(ratio >= cfg.noiseMultiple)) {
      fail(
        driftPays,
        `the drift margin is ${pooledMargin.toFixed(4)} s against a noise floor of ${pooledFloor.toFixed(4)} s — ` +
          `${ratio.toFixed(2)}x, and §10c 1 requires at least ${cfg.noiseMultiple}x. The margin is real in sign and ` +
          `too small to distinguish from the spread of ordinary laps, which is the same thing as saying a player ` +
          `cannot feel it. ${evidence}`,
      )
    }
    if (!sameSign) {
      driftPays.notes.push(
        `the per-seed margins do not all have the same sign (${perSeed.map((s) => s.margin.toFixed(3)).join(', ')} s). ` +
          `Reported, not gated on its own — but a margin that reverses between circuits is a property of those ` +
          `circuits rather than of drifting.`,
      )
    }
  }

  // -- ladder ---------------------------------------------------------------
  let attempts = 0
  const releases = [0, 0, 0, 0]
  let seekRaces = 0
  for (const r of runs) {
    for (const race of [r.seek, r.seekRepeat]) {
      if (!race || race.blocked) continue
      seekRaces++
      for (const k of race.karts) {
        attempts += k.driftAttempts || 0
        for (let i = 0; i < 4; i++) releases[i] += (k.driftReleases && k.driftReleases[i]) || 0
      }
    }
  }
  const released = releases[0] + releases[1] + releases[2] + releases[3]
  const tier1 = attempts > 0 ? (releases[1] + releases[2] + releases[3]) / attempts : NaN
  const tier3 = attempts > 0 ? releases[3] / attempts : NaN
  ladder.metrics.attempts = attempts
  ladder.metrics.releases = releases
  ladder.metrics.released = released
  ladder.metrics.tier1Rate = tier1
  ladder.metrics.tier3Rate = tier3
  ladder.metrics.racesPooled = seekRaces
  // Half-width of the 95% interval on the tier-3 rate, for the record.
  ladder.metrics.tier3CI95 = attempts > 0 ? 1.96 * Math.sqrt((tier3 * (1 - tier3)) / attempts) : null

  if (attempts === 0) {
    pend(
      ladder,
      `zero drift attempts across ${seekRaces} drift-seeking race(s). §10c 2 is a ratio whose denominator does not ` +
        `exist, so this gate covered NOTHING. Either the AI never initiates a drift or KartTelemetry.driftAttempts ` +
        `is not being incremented; both are findings, and neither is a pass.`,
    )
  } else if (attempts < cfg.minDriftAttempts) {
    pend(
      ladder,
      `only ${attempts} drift attempt(s) (limit ${cfg.minDriftAttempts}). Measured tier1 ` +
        `${(tier1 * 100).toFixed(1)}%, tier3 ${(tier3 * 100).toFixed(1)}% ±${(ladder.metrics.tier3CI95 * 100).toFixed(1)} ` +
        `points at 95%. Distinguishing a 25% tier-3 rate from a 32.5% one needs ${cfg.minDriftAttempts} attempts; ` +
        `below that the rate is reported and NOT gated, because a flattering ratio on a handful of attempts is the ` +
        `most persuasive kind of nothing. Run more laps or more seeds.`,
    )
  } else {
    if (!(tier1 >= cfg.tier1Rate)) {
      fail(
        ladder,
        `${(tier1 * 100).toFixed(1)}% of ${attempts} drift attempts banked tier 1 or better (§10c 2 requires ` +
          `${(cfg.tier1Rate * 100).toFixed(0)}%). Releases by tier: ${releases.join(' / ')}. A ladder whose first ` +
          `rung is missed by most attempts teaches players that drifting does not work.`,
      )
    }
    if (!(tier3 >= cfg.tier3Rate)) {
      fail(
        ladder,
        `${(tier3 * 100).toFixed(1)}% of ${attempts} drift attempts reached tier 3 (§10c 2 requires ` +
          `${(cfg.tier3Rate * 100).toFixed(0)}%). Releases by tier: ${releases.join(' / ')}. Tier 3 is the only ` +
          `state that projects the §7 ground light pool and carries the drift-tier3 vantage; a rate this low means ` +
          `the best-looking state in the game is one most players never see.`,
      )
    }
  }
  if (attempts > 0 && released !== attempts) {
    ladder.notes.push(
      `${attempts} attempts against ${released} releases (${attempts - released} unaccounted). A drift still active ` +
        `when the race ended legitimately explains a small gap; a large one means attempts and releases are counted ` +
        `at different moments and the ratios above have different denominators than they appear to.`,
    )
  }

  // -- completes ------------------------------------------------------------
  const primary = runs.find((r) => r.seek && !r.seek.blocked)
  if (!primary) {
    pend(completes, 'no unattended race completed far enough to grade, so §10c criterion 6 measured NOTHING')
  } else {
    const race = primary.seek
    completes.metrics.laps = race.laps
    completes.metrics.ticks = race.ticks
    completes.metrics.budget = race.budget
    completes.metrics.raceSeconds = race.ticks * cfg.simStep
    completes.metrics.karts = race.karts.length
    const maxRespawns = cfg.maxRespawnsPerLap * race.laps
    completes.metrics.maxRespawnsAllowed = maxRespawns
    completes.metrics.worstStallTicks = Math.max.apply(null, race.karts.map((k) => k.maxTicksWithoutProgress))
    completes.metrics.worstStallTicksLap1 = Math.max.apply(null, race.karts.map((k) => k.maxTicksWithoutProgressLap1 || 0))
    completes.metrics.worstRespawns = Math.max.apply(null, race.karts.map((k) => k.respawns))
    if (completes.metrics.worstStallTicksLap1 > cfg.maxTicksWithoutProgress) {
      completes.notes.push(
        `on LAP 1 the worst kart read ${completes.metrics.worstStallTicksLap1} ticks without progress ` +
          `(${(completes.metrics.worstStallTicksLap1 * cfg.simStep).toFixed(1)} s). Reported, NOT gated: the grid sits ` +
          `behind the start line, so a kart begins at t≈0.99, bestProgress latches that at the lights, and ` +
          `completedLaps+t cannot beat it again until the kart is nearly all the way round. The contract says ` +
          `Standing.progress "is NOT monotonic" for exactly this reason. If this number is much larger than a lap, ` +
          `something really is stuck on the grid; if it is about a lap, it is the artefact.`,
      )
    }

    if (race.hitBudget) {
      fail(
        completes,
        `the race hit its tick budget of ${race.budget} (${(race.budget * cfg.simStep).toFixed(0)} s of simulation, ` +
          `derived from ${race.laps} laps x ${Math.round(cfg.trackLength)} m at a floor of ${cfg.minMeanSpeed} m/s) with ` +
          `${race.karts.filter((k) => !k.finished).length} kart(s) still running. §10c 6 is "every kart finishes ` +
          `three laps unattended"; hitting the budget is that failing, not the harness timing out.`,
      )
    }
    for (const k of race.karts) {
      if (!k.finished || k.completedLaps < race.laps) {
        fail(
          completes,
          `kart ${k.kartId} finished=${k.finished} with ${k.completedLaps}/${race.laps} laps after ` +
            `${(race.ticks * cfg.simStep).toFixed(1)} s, ${k.respawns} respawn(s), ${k.wallHits} wall hit(s), longest ` +
            `stall ${k.maxTicksWithoutProgress} ticks (${(k.maxTicksWithoutProgress * cfg.simStep).toFixed(1)} s). ` +
            (k.completedLaps >= race.laps
              ? `It covered the distance and was never marked finished — that is race bookkeeping, not driving.`
              : `It did not cover the distance.`),
        )
      }
      if (k.respawns > maxRespawns) {
        fail(
          completes,
          `kart ${k.kartId} respawned ${k.respawns} times in ${race.laps} laps (limit ${maxRespawns}, being ` +
            `${cfg.maxRespawnsPerLap} per lap). That is a respawn loop: the kart is being returned to a place from ` +
            `which it immediately fails again. §10c 6 names this failure specifically.`,
        )
      }
      if (k.maxTicksWithoutProgress > cfg.maxTicksWithoutProgress) {
        fail(
          completes,
          `kart ${k.kartId} made no forward progress for ${k.maxTicksWithoutProgress} consecutive ticks ` +
            `(${(k.maxTicksWithoutProgress * cfg.simStep).toFixed(1)} s; limit ${cfg.maxTicksWithoutProgress} ticks). ` +
            `KartTelemetry.ticksWithoutProgress resets on any increase in bestProgress, so this kart was genuinely ` +
            `stationary or driving backwards — stuck on a wall or buried in a talus slope, which is the other ` +
            `failure §10c 6 names. Note this is the PEAK over the race, sampled every ${cfg.pollTicks} ticks, not ` +
            `the value at the flag: a kart that sticks and frees itself reads zero at the end.`,
        )
      }
    }
  }

  return checks
}

// ---------------------------------------------------------------------------
// Diagnostics. §10c 6's companion: reported, never gated.
// ---------------------------------------------------------------------------
function diagnostics(runs, cfg, checkpoints) {
  const out = { lapSpread: null, wallContacts: null, timeLoss: null, lapQuantisation: null }
  const races = []
  for (const r of runs) for (const race of [r.seek, r.seekRepeat, r.clean]) if (race && !race.blocked) races.push(race)
  if (!races.length) return out

  // -- lap time spread ------------------------------------------------------
  const all = []
  const lap1 = []
  const perKart = []
  for (const race of races) {
    if (race.mode !== 'seek') continue
    for (const k of race.karts) {
      if (k.lapTimes.length) lap1.push(k.lapTimes[0])
      const rest = k.lapTimes.slice(1)
      for (const t of rest) all.push(t)
      if (rest.length) perKart.push({ kartId: k.kartId, mean: mean(rest), best: Math.min.apply(null, rest) })
    }
  }
  if (all.length) {
    out.lapSpread = {
      n: all.length,
      mean: mean(all),
      sd: stdev(all),
      min: Math.min.apply(null, all),
      max: Math.max.apply(null, all),
      spread: Math.max.apply(null, all) - Math.min.apply(null, all),
      lap1Mean: lap1.length ? mean(lap1) : null,
      perKart: perKart.sort((a, b) => a.mean - b.mean),
    }
    // Are lap times tick-quantised? The answer decides whether §10c 1 is
    // measurable at all, and the contract does not state it either way.
    let worstResidual = 0
    for (const t of all) {
      const q = t / cfg.simStep
      const res = Math.abs(q - Math.round(q)) * cfg.simStep
      if (res > worstResidual) worstResidual = res
    }
    out.lapQuantisation = { worstResidualS: worstResidual, stepS: cfg.simStep }
  }

  // -- wall contacts --------------------------------------------------------
  let hits = 0
  let kartLaps = 0
  let respawns = 0
  for (const race of races) {
    for (const k of race.karts) {
      hits += k.wallHits || 0
      respawns += k.respawns || 0
      kartLaps += k.completedLaps || 0
    }
  }
  out.wallContacts = { hits, respawns, kartLaps, perKartLap: kartLaps ? hits / kartLaps : null }

  // -- where time is lost ---------------------------------------------------
  /*
   * For each bin of the lap: the mean ticks a kart spends crossing it, and the
   * best any kart managed. The gap is time available to a driver who is not
   * losing it there. It ranks WHERE, not WHY — a bin can be slow because the
   * corner is slow, so the number that matters is the spread between karts in
   * the same bin, not the absolute time in it.
   */
  const BINS = cfg.bins
  const binMean = new Array(BINS).fill(0)
  const binBest = new Array(BINS).fill(Infinity)
  const binCount = new Array(BINS).fill(0)
  for (const race of races) {
    if (race.mode !== 'seek') continue
    for (let b = 0; b < BINS; b++) {
      for (const k of race.karts) {
        const passes = (k.binPasses || [])[b] || 0
        if (passes < 1) continue
        const per = k.binTicks[b] / passes
        binMean[b] += per
        binCount[b] += 1
        if (per < binBest[b]) binBest[b] = per
      }
    }
  }
  const rows = []
  for (let b = 0; b < BINS; b++) {
    if (!binCount[b] || !Number.isFinite(binBest[b])) continue
    const m = binMean[b] / binCount[b]
    const t0 = b / BINS
    const t1 = (b + 1) / BINS
    let cp = -1
    for (let i = 0; i < checkpoints.length; i++) if (checkpoints[i] <= t0) cp = i
    rows.push({
      bin: b,
      tFrom: t0,
      tTo: t1,
      checkpoint: cp,
      meanSeconds: m * cfg.simStep,
      bestSeconds: binBest[b] * cfg.simStep,
      lostSeconds: (m - binBest[b]) * cfg.simStep,
      samples: binCount[b],
    })
  }
  rows.sort((a, b) => b.lostSeconds - a.lostSeconds)
  out.timeLoss = {
    bins: BINS,
    pollTicks: cfg.pollTicks,
    totalLostSeconds: rows.reduce((a, r) => a + r.lostSeconds, 0),
    worst: rows.slice(0, 6),
  }
  return out
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
const fmt = (n, d = 3) => (n === null || n === undefined || !Number.isFinite(n) ? '-' : n.toFixed(d))

function summarise(c) {
  const m = c.metrics
  switch (c.id) {
    case 'determinism':
      return `${m.pairs ?? 0} lap pairs compared, worst delta ${m.worstDeltaS === null ? '-' : fmt(m.worstDeltaS, 5)} s`
    case 'drift-pays':
      return `margin ${fmt(m.marginS, 4)} s / floor ${fmt(m.floorS, 4)} s = ${fmt(m.ratio, 2)}x (needs ${m.noiseMultiple}x, ${m.comparableLaps ?? 0} laps)`
    case 'ladder':
      return `${m.attempts ?? 0} attempts  tier1+ ${m.tier1Rate === undefined || Number.isNaN(m.tier1Rate) ? '-' : (m.tier1Rate * 100).toFixed(1) + '%'}  tier3 ${m.tier3Rate === undefined || Number.isNaN(m.tier3Rate) ? '-' : (m.tier3Rate * 100).toFixed(1) + '%'}  releases ${(m.releases || []).join('/')}`
    case 'completes':
      return `${m.karts ?? '?'} karts x ${m.laps ?? '?'} laps in ${fmt(m.raceSeconds, 1)} s  worst stall ${m.worstStallTicks ?? '-'} ticks  worst respawns ${m.worstRespawns ?? '-'}`
    default:
      return ''
  }
}

function printChecks(checks) {
  let n = 0
  for (const c of checks) {
    n++
    console.log(`${c.status.padEnd(4)} ${String(n).padStart(2)}  ${c.id.padEnd(12)} ${summarise(c)}`)
    for (const p of c.problems) console.log(`        ${p.replace(/\n/g, '\n        ')}`)
    for (const note of c.notes) console.log(`        note: ${note.replace(/\n/g, '\n        ')}`)
  }
}

function printDiagnostics(d, cfg) {
  console.log('')
  console.log('DIAGNOSTICS — §10c asks for these; nothing below is a gate')
  if (d.lapSpread) {
    const s = d.lapSpread
    console.log(
      `  lap times      n=${s.n}  mean ${fmt(s.mean)} s  sd ${fmt(s.sd)} s  range ${fmt(s.min)} … ${fmt(s.max)} s ` +
        `(spread ${fmt(s.spread)} s)`,
    )
    console.log(
      `                 lap 1 mean ${fmt(s.lap1Mean)} s — excluded from every comparison above: it carries the ` +
        `standing start and the grid slot, and no amount of drifting recovers those.`,
    )
    const fastest = s.perKart[0]
    const slowest = s.perKart[s.perKart.length - 1]
    if (fastest && slowest) {
      console.log(
        `                 fastest kart ${fastest.kartId} at ${fmt(fastest.mean)} s, slowest kart ${slowest.kartId} at ` +
          `${fmt(slowest.mean)} s — a ${fmt(slowest.mean - fastest.mean)} s field spread. Compare that against the ` +
          `drift margin above: if the margin is small next to this, the AI's own consistency dominates the effect ` +
          `the gate is trying to see.`,
      )
    }
  }
  if (d.lapQuantisation) {
    const q = d.lapQuantisation
    const quantised = q.worstResidualS < 1e-9
    console.log(
      `  lap clock      lap times are ${quantised ? 'EXACT multiples of' : `off the tick grid by up to ${q.worstResidualS.toExponential(2)} s against a`} ` +
        `SIMULATION_STEP (${q.stepS.toFixed(6)} s).`,
    )
    console.log(
      `                 ${quantised
        ? 'That is the answer you want: they came from the tick counter, so they repeat across machines.'
        : 'Two readings, and they are not equally good: sub-tick INTERPOLATION of the line crossing is legitimate ' +
          'and more precise, while a wall clock reaching the lap timer would look identical here and would make ' +
          'every margin above a measurement of machine load. The determinism gate is what tells them apart.'}`,
    )
  }
  if (d.wallContacts) {
    const w = d.wallContacts
    console.log(
      `  wall contacts  ${w.hits} over ${w.kartLaps} kart-laps = ${fmt(w.perKartLap, 2)} per kart per lap, ` +
        `${w.respawns} respawn(s). Reported because a field that never touches a wall is driving a corridor and a ` +
        `field that always does is not driving.`,
    )
  }
  if (d.timeLoss && d.timeLoss.worst.length) {
    const t = d.timeLoss
    console.log(
      `  time lost      ${fmt(t.totalLostSeconds, 2)} s per lap between the mean kart and the best kart, across ` +
        `${t.bins} bins of the lap (sampled every ${t.pollTicks} ticks, so each row is quantised to ` +
        `${(t.pollTicks * cfg.simStep).toFixed(2)} s):`,
    )
    console.log('                 bin    t range          after cp   mean      best      lost')
    for (const r of t.worst) {
      console.log(
        `                 ${String(r.bin).padStart(3)}    ${r.tFrom.toFixed(3)}–${r.tTo.toFixed(3)}     ` +
          `${String(r.checkpoint).padStart(4)}    ${fmt(r.meanSeconds, 2).padStart(6)} s  ${fmt(r.bestSeconds, 2).padStart(6)} s  ` +
          `${fmt(r.lostSeconds, 2).padStart(5)} s`,
      )
    }
    console.log(
      '                 The ranking is by SPREAD between karts in a bin, not by absolute time in it — a hairpin is\n' +
        '                 slow for everyone and that is the layout, not a loss. A bin at the top of this table is\n' +
        '                 where the AI, the surface or the racing line disagrees with itself.',
    )
  }
}

const CONTRACT_ADDITIONS = `
  CONTRACT SURFACE THIS HARNESS NEEDS — not added here; a contract change is the lead's
  ─────────────────────────────────────────────────────────────────────────────────────
  §10c criterion 1 compares a drifting lap against a clean lap. There is no way
  to ask the reference AI for a clean lap. \`DriverMode\` is human | scripted |
  referenceAI | idle, and \`setInput\` only reaches the player kart, so the
  controlled comparison the rubric is built on cannot be constructed at all.

      // src/types.ts, inside ResetOptions
      /**
       * Drift policy for every kart driven by 'referenceAI'. 'seek' takes every
       * drift the racing line offers; 'clean' never initiates one. Default 'seek'.
       *
       * §10c criterion 1 is a controlled comparison and this is the control. It
       * is an optional field on an options bag, so no existing caller changes
       * behaviour; a build that ignores it is detected by tools/autoplay.mjs
       * rather than trusted, because a silently ignored flag turns two identical
       * races into a confident zero margin.
       */
      readonly aiDrift?: 'seek' | 'clean'

  THE ALTERNATIVES, and why they lose
  · Add a 'referenceAI-clean' DriverMode. Widens an enum every subsystem
    switches on, to express a policy rather than a kind of driver.
  · Partition laps within ONE run by whether the kart happened to drift on them.
    No randomisation and a guaranteed confound: a kart drifts more on the laps
    where it is already driving well, so the comparison measures form, not
    drifting. It would produce a number, and the number would be wrong in a
    direction that flatters.
  · Drive a scripted lap by hand for the clean arm. A hand-scripted lap is not
    the same driver, so the difference measures the script.

  ALSO MISSING, and reported by this file every run rather than worked around:
  · Nothing states whether \`KartTelemetry.lapTimes\` comes from the tick counter
    or a wall clock. See the lap-clock diagnostic.
  · \`Standing.lapTimes\` is richer than \`KartTelemetry.lapTimes\` (it carries
    place and progress) and HarnessAPI exposes no route to \`IRace\`. Not needed
    for these gates; it would be needed to grade overtaking.
`

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------
const PROBE_SRC = probeSurface.toString()
const RACE_SRC = runRace.toString()
const REFERENCE_SRC = installReferenceGame.toString()

async function callInPage(page, src, arg) {
  return page.evaluate(
    async ({ s, a }) => {
      const fn = new Function('return (' + s + ')')()
      return fn(a)
    },
    { s: src, a: arg },
  )
}

async function installReference(page, sabotage) {
  await page.evaluate(
    ({ s, sab }) => {
      const fn = new Function('return (' + s + ')')()
      fn(sab)
    },
    { s: REFERENCE_SRC, sab: sabotage },
  )
}

/** Run the full experiment: for every seed, a drifting race, a repeat of it, and
 *  a clean race. Returns the raw summaries; all grading happens in Node. */
async function experiment(page, cfg, verbose) {
  const runs = []
  for (let i = 0; i < cfg.seeds; i++) {
    const seed = cfg.seed0 + i * 1009
    const row = { seed }
    for (const [key, mode] of [['seek', 'seek'], ['seekRepeat', 'seek'], ['clean', 'clean']]) {
      const t0 = Date.now()
      row[key] = await callInPage(page, RACE_SRC, { ...cfg, seed, mode })
      if (verbose) {
        const r = row[key]
        console.log(
          `  race  seed ${seed}  ${key.padEnd(10)} ${r.blocked ? `BLOCKED: ${r.blocked}` : `${r.ticks} ticks, ` +
            `${(r.ticks * cfg.simStep).toFixed(1)} s of racing, ${r.karts.filter((k) => k.finished).length}/${r.karts.length} finished`}` +
            `   [${((Date.now() - t0) / 1000).toFixed(1)}s wall]`,
        )
      }
    }
    runs.push(row)
  }
  return runs
}

// Each sabotage names the gate that owns it AND the status that gate must reach.
// A missing experiment and a failed experiment are different findings, and a
// harness that reports one as the other is how a build ships with a gate that
// covered nothing.
const SABOTAGES = [
  { name: 'drift-pays-nothing', owner: 'drift-pays', expect: 'FAIL', what: 'drifting confers no speed at all — the margin collapses to noise' },
  { name: 'drift-margin-in-the-noise', owner: 'drift-pays', expect: 'FAIL', what: 'a real but tiny margin, under 4x the floor — the arithmetic must bite' },
  { name: 'clean-mode-ignored', owner: 'drift-pays', expect: 'PEND', what: "aiDrift:'clean' silently ignored — a MISSING experiment, not a failed one" },
  { name: 'ladder-tier1-starved', owner: 'ladder', expect: 'FAIL', what: 'half of all attempts bank nothing' },
  { name: 'ladder-tier3-starved', owner: 'ladder', expect: 'FAIL', what: 'tier 1 is healthy and tier 3 is out of reach' },
  { name: 'few-attempts', owner: 'ladder', expect: 'PEND', what: 'a flattering ratio on too few attempts must not read as a pass' },
  { name: 'stuck-kart', owner: 'completes', expect: 'FAIL', what: 'one kart stops dead mid-race' },
  { name: 'respawn-loop', owner: 'completes', expect: 'FAIL', what: 'one kart respawns over and over' },
  { name: 'never-finishes', owner: 'completes', expect: 'FAIL', what: 'a kart covers the distance and is never marked finished' },
  { name: 'nondeterministic', owner: 'determinism', expect: 'FAIL', what: 'the same seed twice produces different lap times' },
]

async function main() {
  const runCfg = {
    ...CFG,
    pendingMarker: PENDING_MARKER,
    trackLength: 1000,
  }

  if (!selfTest) {
    const server = await startServer({ mode: useDev ? 'dev' : 'preview' })
    const browser = await launch({ timing: false })
    try {
      const { page, consoleErrors } = await openGame(browser, server.url, { seed: CFG.seed0, quality: 'high' })
      page.setDefaultTimeout(0)

      console.log('autoplay — unattended races, graded on outcomes   (ART_DIRECTION §10c criteria 1, 2, 6)')
      console.log(
        `thresholds parsed from ART_DIRECTION.md: margin >= ${CFG.noiseMultiple}x the noise floor; ` +
          `tier1+ >= ${(CFG.tier1Rate * 100).toFixed(0)}%; tier3 >= ${(CFG.tier3Rate * 100).toFixed(0)}%; ` +
          `${RUBRIC_LAPS} laps. SIMULATION_STEP ${CFG.simStep.toFixed(6)} s parsed from src/types.ts.`,
      )
      console.log('')

      const probe = await callInPage(page, PROBE_SRC, runCfg)
      if (probe.blocked) {
        console.log('PENDING  window.__harness is absent — the game did not boot. Nothing was measured.')
        process.exitCode = 1
        return
      }
      if (probe.broke.length) {
        for (const b of probe.broke) console.log(`FAIL     ${b}`)
        console.log('         That is not the pending marker, so it is a breakage rather than an absence.')
      }
      if (probe.missing.length) {
        console.log(`PENDING  ${probe.missing.length} HarnessAPI method(s) refused with the "not available yet" marker:`)
        console.log(`         ${probe.missing.join(', ')}`)
        console.log('')
        console.log('  Without them no race can be run at all, so all four gates measured NOTHING:')
        console.log('    determinism  the same seed twice produces the same lap times')
        console.log('    drift-pays   §10c 1 — drifting laps beat clean laps by > 4x the noise floor')
        console.log('    ladder       §10c 2 — >=60% of attempts bank tier 1+, >=25% reach tier 3')
        console.log('    completes    §10c 6 — every kart finishes, nobody loops, nobody sticks')
        console.log('')
        console.log('  This harness drives exactly the surface the contract declares:')
        console.log('    resetRace(options) · startRace() · setDriver(kartId, mode) · stepTicks(n) ·')
        console.log('    telemetry() · track  — and nothing else. Every one of them is already in HarnessAPI.')
        console.log(CONTRACT_ADDITIONS)
        console.log('  The instrument itself is proven: node tools/autoplay.mjs --broken')
        console.log('')
        console.log('PENDING — exiting non-zero on purpose. A gate that quietly covers nothing prints the same')
        console.log('green as a gate that passed.')
        writeFileSync(path.join(OUT, 'autoplay.json'), JSON.stringify({ probe }, null, 2))
        process.exitCode = 1
        return
      }

      runCfg.trackLength = probe.trackLength
      const perRaceTicks = Math.ceil((CFG.laps * probe.trackLength) / 25 / CFG.simStep)
      console.log(
        `field ${probe.kartCount} karts, circuit ${probe.trackLength.toFixed(0)} m, ${CFG.laps} laps, ` +
          `${CFG.seeds} seed(s) x 3 races. Roughly ${(perRaceTicks * CFG.seeds * 3).toLocaleString('en-US')} ticks to ` +
          `simulate; every one of them through stepTicks, never a wall-clock wait.`,
      )
      console.log('')

      const runs = await experiment(page, runCfg, true)
      const checks = grade(runs, runCfg)
      const diag = diagnostics(runs, runCfg, probe.checkpoints)
      console.log('')
      printChecks(checks)
      printDiagnostics(diag, runCfg)
      writeFileSync(path.join(OUT, 'autoplay.json'), JSON.stringify({ probe, runs, checks, diag }, null, 2))
      console.log('')
      console.log(`report   ${path.join(OUT, 'autoplay.json')}`)

      const failed = checks.filter((c) => c.status === 'FAIL')
      const pending = checks.filter((c) => c.status === 'PEND')
      if (pending.length) console.log(CONTRACT_ADDITIONS)
      console.log('')
      if (consoleErrors.length) {
        console.error(`FAIL — console errors:\n  ${consoleErrors.join('\n  ')}`)
        process.exitCode = 1
      } else if (failed.length) {
        console.error(`FAIL — ${failed.length} gate(s) violated: ${failed.map((c) => c.id).join(', ')}`)
        process.exitCode = 1
      } else if (pending.length) {
        console.log(
          `${pending.length} gate(s) PENDING: ${pending.map((c) => c.id).join(', ')}. No violations, but coverage is ` +
            `incomplete. NOT A PASS.`,
        )
        process.exitCode = 1
      } else {
        console.log('PASS — the field races itself unattended, drifting pays for it, and the ladder is reachable.')
      }
    } finally {
      await browser.close()
      await server.stop()
    }
    return
  }

  /*
   * --broken needs no server and no game. That is deliberate: a self-test that
   * can only run once the subsystem it guards exists is unavailable during
   * exactly the window when the instrument is unproven, which is now.
   */
  const browser = await launch({ timing: false })
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(0)
    page.on('pageerror', (e) => console.error(`page error: ${e}`))
    await page.goto('about:blank')

    console.log('autoplay — self-test against a reference game')
    console.log(
      `thresholds parsed from ART_DIRECTION.md: ${CFG.noiseMultiple}x noise floor, tier1+ ` +
        `${(CFG.tier1Rate * 100).toFixed(0)}%, tier3 ${(CFG.tier3Rate * 100).toFixed(0)}%, ${RUBRIC_LAPS} laps.`,
    )
    console.log('')

    await installReference(page, 'none')
    const probe = await callInPage(page, PROBE_SRC, runCfg)
    if (probe.blocked || probe.missing.length) {
      console.error(`SELF-TEST FAILED — the reference game did not install: ${probe.blocked || probe.missing.join(', ')}`)
      process.exitCode = 1
      return
    }
    runCfg.trackLength = probe.trackLength

    const cleanRuns = await experiment(page, runCfg, true)
    const cleanChecks = grade(cleanRuns, runCfg)
    const cleanDiag = diagnostics(cleanRuns, runCfg, probe.checkpoints)
    console.log('')
    console.log('reference (unsabotaged)')
    printChecks(cleanChecks)
    printDiagnostics(cleanDiag, runCfg)
    console.log('')

    const notGreen = cleanChecks.filter((c) => c.status !== 'PASS')
    if (notGreen.length) {
      console.error(
        `SELF-TEST FAILED — the clean reference did not pass ${notGreen.map((c) => `${c.id} (${c.status})`).join(', ')}.\n` +
          `Either a limit in CFG is wrong or a gate is. Until this is green the instrument's verdicts on the real\n` +
          `game mean nothing, because it has been shown to fail something correct.`,
      )
      process.exitCode = 1
      return
    }

    console.log('sabotages — each must be caught by the gate that owns it, with the status that failure deserves')
    console.log('')
    const misses = []
    const rows = []
    for (const sab of SABOTAGES) {
      await installReference(page, sab.name)
      const runs = await experiment(page, runCfg, false)
      const checks = grade(runs, runCfg)
      const byId = new Map(checks.map((c) => [c.id, c]))
      const target = byId.get(sab.owner)
      const got = target ? target.status : 'absent'
      const ok = got === sab.expect
      const collateral = checks.filter((c) => c.status !== 'PASS' && c.id !== sab.owner).map((c) => `${c.id}:${c.status}`)
      rows.push({ name: sab.name, owner: sab.owner, expect: sab.expect, got, collateral })
      console.log(
        `${ok ? 'CAUGHT' : 'MISSED'}  ${sab.name.padEnd(26)} -> ${sab.owner.padEnd(12)} expected ${sab.expect}, got ${got}` +
          `\n                                                     ${sab.what}` +
          (collateral.length ? `\n                                                     also not green: ${collateral.join(', ')}` : ''),
      )
      if (ok && target && (target.problems[0] || target.notes[0])) {
        console.log(`                                                     ${(target.problems[0] || target.notes[0]).split('\n')[0].slice(0, 130)}`)
      }
      if (!ok) misses.push(`${sab.name}: ${sab.owner} was expected to be ${sab.expect} and was ${got}`)
    }

    // A harness whose race surface is pending must report PENDING, never PASS.
    console.log('')
    const stub = await page.evaluate(
      async ({ s, a }) => {
        const boom = (what) => () => {
          throw new Error(`[harness] ${what} is not available yet — the subsystem that provides it has not been built.`)
        }
        window.__harness = {
          version: 2,
          get playerKartId() {
            return boom('playerKartId')()
          },
          get track() {
            return boom('track')()
          },
          resetRace: boom('resetRace'),
          startRace: boom('startRace'),
          setDriver: boom('setDriver'),
          stepTicks: boom('stepTicks'),
          telemetry: boom('telemetry'),
        }
        const fn = new Function('return (' + s + ')')()
        return fn(a)
      },
      { s: PROBE_SRC, a: runCfg },
    )
    if (stub.missing && stub.missing.length >= 5 && stub.broke.length === 0) {
      console.log(`CAUGHT  ${'pending-harness'.padEnd(26)} -> the probe reported ${stub.missing.length} pending method(s): ${stub.missing.join(', ')}`)
    } else {
      misses.push(`a fully-pending harness reported missing=[${(stub.missing || []).join(', ')}] broke=[${(stub.broke || []).join(', ')}]`)
      console.log(`MISSED  ${'pending-harness'.padEnd(26)} -> the probe did not report the pending surface honestly`)
    }

    // And the gates must PEND, not PASS, when no race ran at all.
    const emptyChecks = grade([], runCfg)
    const emptyGreen = emptyChecks.filter((c) => c.status === 'PASS')
    if (emptyGreen.length) {
      misses.push(`with no races at all, ${emptyGreen.map((c) => c.id).join(', ')} still reported PASS`)
      console.log(`MISSED  ${'no-races'.padEnd(26)} -> ${emptyGreen.map((c) => c.id).join(', ')} reported PASS on zero data`)
    } else {
      console.log(`CAUGHT  ${'no-races'.padEnd(26)} -> every gate reported PEND on zero data; none reported PASS`)
    }

    await page.evaluate(() => {
      delete window.__harness
    })
    const absent = await callInPage(page, PROBE_SRC, runCfg)
    if (absent.blocked === 'NO_HARNESS') {
      console.log(`CAUGHT  ${'absent-harness'.padEnd(26)} -> blocked: NO_HARNESS`)
    } else {
      misses.push(`an absent __harness produced ${absent.blocked ?? 'a result'} instead of NO_HARNESS`)
      console.log(`MISSED  ${'absent-harness'.padEnd(26)} -> ${absent.blocked ?? 'a result'}`)
    }

    writeFileSync(path.join(OUT, 'autoplay-selftest.json'), JSON.stringify({ rows, misses }, null, 2))
    console.log('')
    if (misses.length) {
      console.error(`SELF-TEST FAILED — ${misses.length} problem(s):`)
      for (const m of misses) console.error(`  ${m}`)
      console.error('A gate nobody has watched fail is not evidence. Fix it before trusting a verdict.')
      process.exitCode = 1
    } else {
      console.log(
        `SELF-TEST PASSED — the reference game passes clean, all ${SABOTAGES.length} sabotages were caught by their\n` +
          `owning gate with the status that failure deserves (including the two that must read PENDING rather than\n` +
          `FAIL), and a harness with nothing behind it reported PENDING rather than green.`,
      )
    }
  } finally {
    await browser.close()
  }
}

await main()
