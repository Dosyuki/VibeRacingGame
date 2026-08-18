/**
 * ITrack, measured. The invariants a screenshot cannot see.
 *
 *   node tools/track-check.mjs              # validate the live ITrack
 *   node tools/track-check.mjs --reference  # run the battery on the built-in reference
 *   node tools/track-check.mjs --broken     # self-test: prove every detector fires
 *
 * FIXED — no `NO_COLOR=1` prefix is needed any more, and the note is kept only
 * so the next person to read a URL-scraping failure knows where to look. The
 * banner regex in `vite-server.mjs` is broken by ANSI colour codes (vite prints
 * `localhost:<ESC>[1m4173<ESC>[22m/`, the port never matches, and after 30 s
 * every harness dies claiming the server never reported a URL). `FORCE_COLOR=0`
 * does NOT suppress it; `NO_COLOR=1` does, and `vite-server.mjs` now sets both
 * in the child env with a comment saying why. Do not tidy either of them away.
 *
 * The track is the one subsystem where every serious bug is invisible in a
 * frame. A spline parameterised by knot index instead of arc length renders
 * identically to one that is not, and then lap times, checkpoint spacing and AI
 * corner-entry speeds are all quietly wrong. A `locate` that is off by five
 * metres draws nothing at all, and poisons lap counting, respawn, surface
 * queries and every AI decision at the same moment. A frame that has gone
 * slightly non-orthogonal makes karts lean wrong on banking and nobody can point
 * at which line did it. None of that is visible; all of it is measurable.
 *
 * WHAT THIS ASSERTS, and why each one is here:
 *
 *   1  arc-length     equal steps in t are equal steps in metres
 *   2  closure        t=0 and t=1 are the same place, pose and bank
 *   3  continuity     no tangent kink, no curvature step, no bank step
 *   4  frame          T, N, R unit, mutually perpendicular, R = T x N
 *   5  locate-inverse locate is the inverse of sample. THE IMPORTANT ONE.
 *   6  signs          +lateral is the driver's right, anchored to world axes
 *   7  locate-cost    ns per call, and whether it allocates
 *   8  checkpoints    ordered, ascending, first at 0, and locate agrees
 *   9  start-grid     on the road, not overlapping, oriented to the road plane
 *  10  surfaces       OffTrack beyond halfWidth + BARRIER_MARGIN, at every t
 *  11  racing-line    inside the track, and correlated with curvature
 *
 * SELF-TEST. `--broken` does not sabotage the game — there is no track to
 * sabotage yet, and a self-test that can only run after the thing it guards has
 * landed guards nothing during the window that matters. Instead it builds a
 * complete reference ITrack in the page (a smooth closed polar curve with
 * elevation, banking, checkpoints and a grid), asserts the battery passes it
 * clean, then applies fourteen specific sabotages and asserts that each one is
 * caught BY THE CHECK THAT OWNS IT. A sabotage caught by some other check is
 * recorded as a miss, because "something went red" is not the same evidence as
 * "the detector for this failure fired". It finishes by driving the real
 * extraction path — a reference ITrack installed on `window.__harness.track` —
 * so the code that must work the day world/ lands is not the one thing here
 * that nobody has watched run.
 *
 * Two detectors were inert when first written and the self-test is what found
 * them. `closure` compared sample(1) with sample(0), which is trivially equal on
 * any implementation that wraps t — including a deliberately open loop. And the
 * start-grid orientation gate was 10 degrees wide, which passed a yaw-only
 * quaternion, the exact mistake StartSlot's own comment exists to prevent. Both
 * are fixed; both would have shipped as green.
 *
 * That is the CLAUDE.md rule taken literally: proven against a known-good
 * implementation and a deliberately broken one, before any of its numbers are
 * used to make a decision. It also means the reference doubles as an executable
 * statement of what the contract means — if `src/world/track.ts` and this file
 * disagree about the sign of `bank`, one of them is wrong and the argument can
 * be had against running code.
 *
 * HOW IT REACHES THE TRACK — read this before filing a bug about the PENDING.
 * `HarnessAPI` exposes no route to `ITrack`. This file therefore asks for ONE
 * addition, and refuses to invent a substitute:
 *
 *     // src/types.ts, in HarnessAPI
 *     readonly track: ITrack        // the live ITrack, by reference
 *
 * See the PENDING block this prints for the argument and the main.ts wiring.
 * Adding it is a contract change and only the lead may make it.
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
 * These are read out of `src/types.ts` rather than copied into this file.
 *
 * A harness that hardcodes 1.5 keeps passing after somebody moves BARRIER_MARGIN
 * to 2.0, and it keeps passing for the wrong reason: it is now asserting a
 * boundary the game no longer has. Parsing the source is ugly and it is correct.
 * If the parse fails this file refuses to run rather than falling back to a
 * remembered value — a remembered value is exactly the plausible-but-unknowable
 * answer the rest of the repo exists to prevent.
 */
const TYPES_PATH = path.join(ROOT, 'src', 'types.ts')
const typesSrc = readFileSync(TYPES_PATH, 'utf8')

function fromContract(re, what) {
  const m = typesSrc.match(re)
  if (!m) {
    console.error(
      `FAIL  cannot read ${what} out of ${TYPES_PATH}.\n` +
        `      This harness re-derives the contract's constants instead of remembering them.\n` +
        `      Refusing to run against a value it cannot confirm.`,
    )
    process.exit(1)
  }
  return Number(m[1])
}

const BARRIER_MARGIN = fromContract(/BARRIER_MARGIN\s*:\s*Metres\s*=\s*([\d.]+)/, 'BARRIER_MARGIN')
const SURFACE_OFF_TRACK = fromContract(/OffTrack\s*=\s*(\d+)\s*,/, 'Surface.OffTrack')

const SURFACE_NAMES = {}
for (const m of typesSrc.matchAll(/^\s{2}(\w+)\s*=\s*(\d+),\s*$/gm)) SURFACE_NAMES[Number(m[2])] = m[1]

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
/*
 * DERIVED vs GUESS is marked per line and the distinction is load-bearing. A
 * derived number can be argued with on its arithmetic. A guess can only be
 * argued with by measuring, and the first real track to run through here is the
 * measurement that settles them — see the note each guess carries.
 */
const CFG = {
  barrierMargin: BARRIER_MARGIN,
  offTrack: SURFACE_OFF_TRACK,

  /** Centreline samples for every dense sweep. 2048 over a ~1.2 km lap is 0.6 m. */
  sweep: 2048,

  // -- 1 arc length --------------------------------------------------------
  /*
   * DERIVED. The measurement is chord length between adjacent samples, which
   * undershoots arc length by (kappa*s)^2/24. At s = 0.6 m and the tightest
   * corner this gate tolerates (kappa = 0.5, a 2 m radius) that is 0.04%. A
   * naive spline parameterisation deviates by tens of percent on a track with
   * both straights and corners. 1% sits two orders above the noise floor and two
   * orders below the failure.
   */
  arcStepTol: 0.01,
  /** DERIVED, same reasoning: sum of chords must reconstruct `length`. */
  lengthTol: 0.01,

  // -- 2 closure -----------------------------------------------------------
  /*
   * Closure is measured ACROSS THE SEAM, not by comparing sample(1) with
   * sample(0).
   *
   * The obvious test is the useless one, and the self-test is what showed it.
   * `t` wraps by contract, so almost every implementation begins with
   * `t -= Math.floor(t)` — and then sample(1) IS sample(0), bit for bit, on a
   * circuit whose two ends are fifty metres apart. The detector passed a
   * deliberately open loop and only the neighbouring checks noticed.
   *
   * What actually answers the question is the one-sided limit: step across the
   * seam by delta and the distance travelled must be delta * length, the same as
   * a step anywhere else. An open loop shows up immediately as a jump.
   */
  seamDelta: 1e-4,
  /** DERIVED. Double precision through a spline evaluation; 1 mm is ~1e13 x noise. */
  closurePosTolM: 1e-3,
  /** The seam step may differ from delta*length by this fraction, for chord shortening. */
  closureStepTol: 0.05,
  closureAngleTolRad: 1e-3,
  closureScalarTol: 1e-3,

  // -- 3 continuity --------------------------------------------------------
  /*
   * DERIVED, and stated as a RATE so it does not depend on `sweep`. The turn
   * angle between adjacent tangents divided by the step distance is curvature.
   * 0.5 1/m is a 2 m radius. Nothing a kart can drive is tighter than that, so
   * anything above it is a kink in the spline rather than a corner.
   */
  maxCurvature: 0.5,
  /*
   * guess. Rate of change of curvature, 1/m^2. A 30 m clothoid entering a 10 m
   * radius corner runs at 0.0033. 0.05 allows going from straight to a hairpin
   * in 3.3 m and still catches the real target: a piecewise-circular-arc layout,
   * whose curvature steps discontinuously at every join. If the track ships as
   * piecewise arcs this gate fires, and that is a conversation worth having
   * rather than a tolerance to widen — the AI reads `curvature` to choose entry
   * speed, and a step in curvature is a step in target speed.
   */
  maxCurvatureRate: 0.05,
  /** guess. rad/m. 0.02 takes the road from flat to 10 degrees over 8.7 m. */
  maxBankRate: 0.02,
  /** guess. metres of half-width per metre travelled — a 20% taper per metre. */
  maxWidthRate: 0.2,
  /*
   * guess on the value, DERIVED on the direction. Reported `curvature` must
   * agree with the curvature actually implied by the tangents. Finite
   * differencing a curve whose curvature is itself changing carries real error,
   * so the gate is the looser of an absolute and a relative bound.
   */
  curvatureAbsTol: 0.02,
  curvatureRelTol: 0.25,
  /** Below this |curvature| the sign is meaningless and is not asserted. */
  curvatureSignFloor: 0.01,

  // -- 4 frame -------------------------------------------------------------
  /** DERIVED. A double-precision normalize lands within 1e-16. 1e-5 is 11 orders of margin. */
  orthoTol: 1e-5,

  // -- 5 locate ------------------------------------------------------------
  locateSweep: 256,
  /** Fractions of halfWidth to offset by. Both signs, and the extremes. */
  lateralFractions: [-0.95, -0.6, -0.25, 0, 0.25, 0.6, 0.95],
  /** Metres above the road plane to offset by, exercising TrackLocation.height. */
  heights: [0, 0.8],
  /** Extra metres beyond halfWidth + BARRIER_MARGIN — the respawn query. */
  offTrackProbesM: [1.0, 3.0],
  /*
   * guess. A projection onto a polyline of 0.3 m spacing carries ~1 mm; a
   * Newton-refined analytic projection carries ~1 um. 0.10 m of arc is 0.008% of
   * a lap, far below anything lap counting or AI can feel, and far above any
   * honest implementation's error.
   */
  locateArcTolM: 0.1,
  locateLatTolM: 0.05,
  locateHeightTolM: 0.05,
  /*
   * DERIVED, and measured empirically rather than guessed from curvature.
   *
   * Offsetting a point toward the inside of a corner can put it closer to a
   * different part of the circuit than to the place it came from — past the
   * centre of curvature, or simply across a hairpin. There the query is
   * genuinely ill-posed and the round trip MUST NOT be asserted; the first
   * version of this file used |lateral * curvature| < 0.7 as the guard and the
   * reference track failed it, because a lobe of the circuit came closer than
   * the local radius of curvature predicted. A heuristic that fails a correct
   * implementation is worse than no guard.
   *
   * So the guard is exact instead: if locate returned a centreline point that is
   * at least as close to the probe as the one we constructed it from, locate did
   * its job and our expectation was wrong — count it as ambiguous. Only a result
   * that is FARTHER away than the point we already know about is a failure, and
   * that is unambiguous no matter what the geometry does. This still catches a
   * drifting locate: a 5 m error puts the returned point measurably farther out.
   */
  ambiguityToleranceM: 1e-4,

  // -- 7 cost --------------------------------------------------------------
  locateCalls: 200_000,
  sampleCalls: 200_000,
  warmupCalls: 20_000,
  /*
   * guess, with the arithmetic behind it. Eight karts x (chassis + four wheels)
   * x 120 Hz is 4800 locate calls per second. At 1 us each that is 4.8 ms of CPU
   * per second, 0.5%, which is affordable. A linear scan of a 4096-point
   * centreline costs 5-10 us and blows straight through it — which is the
   * failure this number exists to catch, and the one that stays invisible until
   * the frame rate collapses with a full field.
   */
  maxLocateNs: 1000,
  maxSampleNs: 1000,
  /** DERIVED: the contract lists ITrack.locate under MUST NOT ALLOCATE. */
  maxBytesPerLocate: 1,
  allocCalls: 100_000,

  // -- 8 checkpoints -------------------------------------------------------
  /*
   * DERIVED. A kart at 40 m/s covers 0.33 m per 120 Hz tick. Two checkpoints
   * closer together than that can be crossed within one tick, and an
   * order-sensitive lap counter can then miss one. 10 m is 30 ticks of margin.
   */
  minCheckpointSpacingM: 10,
  /** guess. Checkpoints exist to stop shortcuts; half a lap between them defeats that. */
  maxCheckpointSpacingFrac: 0.5,
  /** DERIVED: the t round-trip carries locateArcTolM, so the index legitimately
   *  flips within that band of a checkpoint. Skipped, and the count reported. */
  checkpointEdgeBandM: 0.5,

  // -- 9 start grid --------------------------------------------------------
  /*
   * guess, and it is a guess because THE CONTRACT STATES NO KART DIMENSIONS.
   * A kart is roughly 1.2 m wide and 2.0 m long, so slot centres closer than
   * 1.5 m are interpenetrating on the grid. See the report: this belongs in the
   * contract, not in a harness's opinion.
   */
  minSlotSeparationM: 1.5,
  /** guess. StartSlot.position's height datum is not specified — see the report. */
  maxSlotHeightM: 1.0,
  /*
   * guess. A staggered grid may legitimately angle a slot a little off the
   * tangent, so heading gets some room.
   */
  gridForwardTolRad: 10 * (Math.PI / 180),
  /*
   * DERIVED, and it has to be tight. An orientation built from (right, normal,
   * -tangent) lands within 1e-7 of the road normal; anything larger means the
   * quaternion was built from something other than the road plane. Two degrees
   * across a 1.2 m track lifts one wheel 4 cm off the road.
   *
   * This was 10 degrees and the self-test caught it doing nothing: a yaw-only
   * orientation — the exact mistake StartSlot's own comment warns about — was
   * only 6.5 degrees out on a mildly banked part of the reference and sailed
   * through. A gate wide enough to pass the failure it names is not a gate.
   */
  gridUpTolRad: 2 * (Math.PI / 180),
  slotTTolM: 0.5,

  // -- 10 surfaces ---------------------------------------------------------
  surfaceSweep: 256,
  /** Lateral probes expressed as multiples of (halfWidth + BARRIER_MARGIN). */
  offTrackFactors: [1.02, 1.5, 3.0],

  // -- 11 racing line ------------------------------------------------------
  /*
   * DERIVED on the direction, loose on the value. d(lateral)/ds is the tangent
   * of the angle between the ideal line and the centreline; 0.5 m/m is 26.6
   * degrees, steeper than a kart holds through a corner entry. The failure this
   * is aimed at is a STEP in the ideal line, which reads as many metres per
   * metre, not as a brisk transition. It started at 0.25 and the reference — an
   * entirely reasonable line that swings 5.7 m across a 15 m hairpin — measured
   * 0.335, so 0.25 was flagging correct work.
   */
  maxRacingLineRate: 0.5,
  /*
   * The only hard rail on the racing line, and it is a sign rail, not a quality
   * one. Positive curvature is a right-hand corner and the inside of a right-hand
   * corner is positive lateral, so the correlation must not be strongly negative.
   * A strongly negative one is an ideal line that goes to the OUTSIDE of every
   * corner, which is a sign bug and this project's most expensive failure class.
   * The magnitude is reported, never gated.
   */
  racingLineInvertedR: -0.3,
  correlationLagFrac: 0.06,
}

// ---------------------------------------------------------------------------
// The battery. Runs in the page, against any ITrack.
// ---------------------------------------------------------------------------
/*
 * Self-contained on purpose: it is stringified and rebuilt inside the browser,
 * so it may not close over anything in this module. Everything it needs arrives
 * as arguments.
 *
 * It touches NO three.js method. It reads `.x/.y/.z/.w` and calls the
 * caller-supplied `makeVec()`. That is what lets the identical code grade the
 * real track (whose vectors are three's) and the reference (whose vectors are a
 * twelve-line shim) — one instrument, two subjects, no second implementation to
 * drift.
 */
function checkTrack(track, makeVec, CFG) {
  const R = { info: {}, checks: [] }
  const checks = R.checks

  function mk(id, title) {
    const c = { id, title, status: 'PASS', metrics: {}, problems: [], notes: [] }
    checks.push(c)
    return c
  }
  function fail(c, msg) {
    c.problems.push(msg)
    c.status = 'FAIL'
  }
  function pend(c, msg) {
    c.notes.push(msg)
    if (c.status !== 'FAIL') c.status = 'PEND'
  }

  // -- vector helpers, on plain fields --------------------------------------
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z
  const nrm = (a) => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z)
  const dist = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
  const clamp1 = (x) => (x > 1 ? 1 : x < -1 ? -1 : x)
  const angle = (a, b) => Math.acos(clamp1(dot(a, b) / (nrm(a) * nrm(b))))
  const wrap01 = (x) => x - Math.floor(x)
  function wrapDelta(a, b) {
    let d = wrap01(a) - wrap01(b)
    if (d > 0.5) d -= 1
    if (d < -0.5) d += 1
    return d
  }
  function crossInto(o, a, b) {
    const x = a.y * b.z - a.z * b.y
    const y = a.z * b.x - a.x * b.z
    const z = a.x * b.y - a.y * b.x
    o.x = x
    o.y = y
    o.z = z
    return o
  }
  function rotQ(out, v, q) {
    const x = v.x
    const y = v.y
    const z = v.z
    const qx = q.x
    const qy = q.y
    const qz = q.z
    const qw = q.w
    const ix = qw * x + qy * z - qz * y
    const iy = qw * y + qz * x - qx * z
    const iz = qw * z + qx * y - qy * x
    const iw = -qx * x - qy * y - qz * z
    out.x = ix * qw + iw * -qx + iy * -qz - iz * -qy
    out.y = iy * qw + iw * -qy + iz * -qx - ix * -qz
    out.z = iz * qw + iw * -qz + ix * -qy - iy * -qx
    return out
  }
  const finite = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)

  const mkSample = () => ({
    position: makeVec(),
    tangent: makeVec(),
    normal: makeVec(),
    right: makeVec(),
    halfWidth: 0,
    bank: 0,
    curvature: 0,
  })
  const mkLoc = () => ({ t: 0, lateral: 0, height: 0, onTrack: false, checkpointIndex: -1 })

  // =========================================================================
  // 0  structure
  // =========================================================================
  const structure = mk('structure', 'ITrack surface')
  const has = {
    length: typeof track.length === 'number' && Number.isFinite(track.length) && track.length > 0,
    group: !!track.group,
    sample: typeof track.sample === 'function',
    locate: typeof track.locate === 'function',
    surfaceAt: typeof track.surfaceAt === 'function',
    racingLine: typeof track.racingLine === 'function',
    checkpoints: Array.isArray(track.checkpoints) || (track.checkpoints && typeof track.checkpoints.length === 'number'),
    startGrid: Array.isArray(track.startGrid) || (track.startGrid && typeof track.startGrid.length === 'number'),
  }
  for (const k of Object.keys(has)) {
    if (!has[k]) fail(structure, `ITrack.${k} is missing or not usable (got ${typeof track[k]})`)
  }
  R.info.length = has.length ? track.length : null
  R.info.checkpointCount = has.checkpoints ? track.checkpoints.length : null
  R.info.gridCount = has.startGrid ? track.startGrid.length : null
  structure.metrics.length = R.info.length
  /*
   * guess, and a wide one. A kart circuit is 500-4000 m. 50 m is a rail against
   * a placeholder that returns 1, not a judgement about layout.
   */
  if (has.length && track.length < 50) {
    fail(structure, `length ${track.length.toFixed(1)} m — too short to be a circuit`)
  }

  const UP = { x: 0, y: 1, z: 0 }
  const N = CFG.sweep
  const L = has.length ? track.length : 0
  const ds = L / N

  // =========================================================================
  // dense sweep — every later check reads this
  // =========================================================================
  let samples = null
  if (has.sample && has.length) {
    samples = new Array(N)
    let identityOk = true
    let nanAt = -1
    for (let i = 0; i < N; i++) {
      const out = mkSample()
      const ret = track.sample(i / N, out)
      if (i === 0 && ret !== out) identityOk = false
      const s = ret || out
      samples[i] = s
      if (nanAt < 0 && !(finite(s.position) && finite(s.tangent) && finite(s.normal) && finite(s.right) &&
        Number.isFinite(s.halfWidth) && Number.isFinite(s.bank) && Number.isFinite(s.curvature))) nanAt = i
    }
    if (!identityOk) {
      fail(structure, 'sample(t, out) did not return `out` — the contract says it writes into out and returns it')
    }
    if (nanAt >= 0) {
      fail(structure, `sample(${(nanAt / N).toFixed(4)}) produced a non-finite field`)
      samples = null
    }
  }

  const needSample = (c) => {
    if (!samples) {
      pend(c, 'requires a working ITrack.sample over the whole lap')
      return false
    }
    return true
  }

  // =========================================================================
  // 1  arc-length parameterisation
  // =========================================================================
  const arc = mk('arc-length', 'sample(t) is parameterised by distance')
  if (needSample(arc)) {
    let sum = 0
    let min = Infinity
    let max = -Infinity
    let maxAt = 0
    const steps = new Array(N)
    for (let i = 0; i < N; i++) {
      const d = dist(samples[i].position, samples[(i + 1) % N].position)
      steps[i] = d
      sum += d
      if (d < min) min = d
      if (d > max) max = d
    }
    const mean = sum / N
    let worst = 0
    for (let i = 0; i < N; i++) {
      const rel = Math.abs(steps[i] - mean) / mean
      if (rel > worst) {
        worst = rel
        maxAt = i
      }
    }
    const lenErr = Math.abs(sum - L) / L
    arc.metrics.meanStepM = mean
    arc.metrics.minStepM = min
    arc.metrics.maxStepM = max
    arc.metrics.worstDeviation = worst
    arc.metrics.worstAtT = maxAt / N
    arc.metrics.chordSumM = sum
    arc.metrics.lengthErrorFrac = lenErr

    if (worst > CFG.arcStepTol) {
      fail(
        arc,
        `equal steps in t are not equal steps in metres: step varies ${min.toFixed(4)}-${max.toFixed(4)} m ` +
          `(${(worst * 100).toFixed(2)}% off the ${mean.toFixed(4)} m mean, worst at t=${(maxAt / N).toFixed(4)}), ` +
          `limit ${(CFG.arcStepTol * 100).toFixed(1)}%. ` +
          `TrackSample's contract is that t is normalised DISTANCE. A raw spline parameter renders ` +
          `identically and makes lap times, checkpoint spacing and AI corner entry all wrong with nothing reporting it.`,
      )
    }
    if (lenErr > CFG.lengthTol) {
      fail(
        arc,
        `ITrack.length says ${L.toFixed(2)} m but the centreline measures ${sum.toFixed(2)} m ` +
          `(${(lenErr * 100).toFixed(2)}% out). Every speed, gap and lap distance derived from ITrack.length is wrong by that factor.`,
      )
    }
  }

  // =========================================================================
  // 2  closure
  // =========================================================================
  const closure = mk('closure', 'the lap closes across the start line')
  if (has.sample && has.length) {
    /*
     * The seam. One step of `delta` across t=0 must cost the same distance, the
     * same turn and the same change in bank as a step of `delta` just before it.
     * Comparing sample(1) with sample(0) cannot answer this — see CFG.seamDelta.
     */
    const d = CFG.seamDelta
    const before2 = mkSample()
    const before1 = mkSample()
    const at0 = mkSample()
    const after1 = mkSample()
    track.sample(1 - 2 * d, before2)
    track.sample(1 - d, before1)
    track.sample(0, at0)
    track.sample(d, after1)

    const seamStep = dist(before1.position, at0.position)
    const priorStep = dist(before2.position, before1.position)
    const nextStep = dist(at0.position, after1.position)
    const expected = d * L
    closure.metrics.seamStepM = seamStep
    closure.metrics.expectedStepM = expected
    closure.metrics.neighbourStepsM = [priorStep, nextStep]
    if (Math.abs(seamStep - expected) > Math.max(CFG.closurePosTolM, CFG.closureStepTol * expected)) {
      fail(
        closure,
        `the lap does not close: stepping ${d} in t across the start line moves ${seamStep.toFixed(4)} m, ` +
          `where the same step just before it moves ${priorStep.toFixed(4)} m and ITrack.length predicts ` +
          `${expected.toFixed(4)} m. The two ends of the centreline are ${Math.abs(seamStep - expected).toFixed(2)} m apart. ` +
          `Note that sample(1) and sample(0) agreeing proves nothing here — t wraps, so they agree on an open loop too.`,
      )
    }

    const seamTurn = angle(before1.tangent, at0.tangent)
    const priorTurn = angle(before2.tangent, before1.tangent)
    const nextTurn = angle(at0.tangent, after1.tangent)
    closure.metrics.seamTurnDeg = (seamTurn * 180) / Math.PI
    if (seamTurn > Math.max(CFG.closureAngleTolRad, 3 * Math.max(priorTurn, nextTurn))) {
      fail(
        closure,
        `the tangent kinks at the start line: it turns ${((seamTurn * 180) / Math.PI).toFixed(4)} deg across the seam ` +
          `against ${((priorTurn * 180) / Math.PI).toFixed(4)} deg one step earlier. Every kart crossing the line steers ` +
          `through that discontinuity once a lap.`,
      )
    }
    for (const [what, a, b, c] of [
      ['bank', before2.bank, before1.bank, at0.bank],
      ['halfWidth', before2.halfWidth, before1.halfWidth, at0.halfWidth],
      ['curvature', before2.curvature, before1.curvature, at0.curvature],
    ]) {
      const seam = Math.abs(c - b)
      const prior = Math.abs(b - a)
      if (seam > CFG.closureScalarTol + 3 * prior) {
        fail(closure, `${what} steps by ${seam.toExponential(2)} across the start line against ${prior.toExponential(2)} one step earlier`)
      }
    }
    if (has.racingLine) {
      const seam = Math.abs(track.racingLine(0) - track.racingLine(1 - d))
      const prior = Math.abs(track.racingLine(1 - d) - track.racingLine(1 - 2 * d))
      closure.metrics.racingLineSeamM = seam
      if (seam > CFG.closureScalarTol + 3 * prior) {
        fail(closure, `racingLine steps by ${seam.toFixed(4)} m across the start line — the ideal line jumps once a lap`)
      }
    }

    /*
     * And separately: `t` wraps and callers never clamp. An implementation that
     * clamps instead of wrapping returns sample(1) for t=1.25, which is a
     * different failure from an open loop and needs its own probe.
     */
    const pairs = [
      ['t=1.25 vs t=0.25 (wrap forward)', 1.25, 0.25],
      ['t=-0.25 vs t=0.75 (wrap backward)', -0.25, 0.75],
      ['t=3.5 vs t=0.5 (wrap far)', 3.5, 0.5],
    ]
    let worstPos = 0
    let worstAng = 0
    let worstScalar = 0
    for (const [label, ta, tb] of pairs) {
      const a = mkSample()
      const b = mkSample()
      track.sample(ta, a)
      track.sample(tb, b)
      if (!finite(a.position) || !finite(b.position)) {
        fail(closure, `${label}: sample returned a non-finite position — t must wrap, callers never clamp`)
        continue
      }
      const dp = dist(a.position, b.position)
      const da = angle(a.tangent, b.tangent)
      const db = Math.abs(a.bank - b.bank)
      const dw = Math.abs(a.halfWidth - b.halfWidth)
      const dk = Math.abs(a.curvature - b.curvature)
      worstPos = Math.max(worstPos, dp)
      worstAng = Math.max(worstAng, da)
      worstScalar = Math.max(worstScalar, db, dw, dk)
      if (dp > CFG.closurePosTolM) {
        fail(closure, `${label}: positions differ by ${dp.toFixed(4)} m — t does not wrap. The contract says "t wraps; callers never clamp", so an out-of-range t is not an error case to clamp away.`)
      }
      if (da > CFG.closureAngleTolRad) {
        fail(closure, `${label}: tangents differ by ${((da * 180) / Math.PI).toFixed(3)} deg — t does not wrap`)
      }
      if (db > CFG.closureScalarTol) fail(closure, `${label}: bank differs by ${db.toExponential(2)} rad — t does not wrap`)
      if (dw > CFG.closureScalarTol) fail(closure, `${label}: halfWidth differs by ${dw.toExponential(2)} m — t does not wrap`)
      if (dk > CFG.closureScalarTol) fail(closure, `${label}: curvature differs by ${dk.toExponential(2)} 1/m — t does not wrap`)
    }
    closure.metrics.worstWrapPosM = worstPos
    closure.metrics.worstAngleRad = worstAng
    closure.metrics.worstScalar = worstScalar
  } else {
    pend(closure, 'requires ITrack.sample and ITrack.length')
  }

  // =========================================================================
  // 3  continuity
  // =========================================================================
  const cont = mk('continuity', 'no discontinuity in tangent, curvature, bank or width')
  if (needSample(cont)) {
    let maxTurn = 0
    let maxTurnAt = 0
    let maxKRate = 0
    let maxKRateAt = 0
    let maxBankRate = 0
    let maxWidthRate = 0
    let worstKErr = 0
    let worstKErrAt = 0
    let worstKObs = 0
    let worstKRep = 0
    for (let i = 0; i < N; i++) {
      const a = samples[i]
      const b = samples[(i + 1) % N]
      const turn = angle(a.tangent, b.tangent)
      if (turn > maxTurn) {
        maxTurn = turn
        maxTurnAt = i
      }
      const kr = Math.abs(b.curvature - a.curvature) / ds
      if (kr > maxKRate) {
        maxKRate = kr
        maxKRateAt = i
      }
      maxBankRate = Math.max(maxBankRate, Math.abs(b.bank - a.bank) / ds)
      maxWidthRate = Math.max(maxWidthRate, Math.abs(b.halfWidth - a.halfWidth) / ds)

      // Centred difference of the tangent, projected on `right`: this is the
      // curvature the geometry actually has, signed by the contract's own rule.
      const p = samples[(i - 1 + N) % N]
      const kObs = ((b.tangent.x - p.tangent.x) * a.right.x +
        (b.tangent.y - p.tangent.y) * a.right.y +
        (b.tangent.z - p.tangent.z) * a.right.z) / (2 * ds)
      const tol = Math.max(CFG.curvatureAbsTol, CFG.curvatureRelTol * Math.abs(a.curvature))
      const err = Math.abs(kObs - a.curvature) - tol
      if (err > worstKErr) {
        worstKErr = err
        worstKErrAt = i
        worstKObs = kObs
        worstKRep = a.curvature
      }
    }
    const impliedK = maxTurn / ds
    cont.metrics.maxTurnDeg = (maxTurn * 180) / Math.PI
    cont.metrics.impliedCurvature = impliedK
    cont.metrics.minRadiusM = impliedK > 0 ? 1 / impliedK : Infinity
    cont.metrics.maxCurvatureRate = maxKRate
    cont.metrics.maxBankRate = maxBankRate
    cont.metrics.maxWidthRate = maxWidthRate

    if (impliedK > CFG.maxCurvature) {
      fail(
        cont,
        `tangent turns ${((maxTurn * 180) / Math.PI).toFixed(2)} deg over one ${ds.toFixed(3)} m step at ` +
          `t=${(maxTurnAt / N).toFixed(4)} — an implied radius of ${(1 / impliedK).toFixed(2)} m. ` +
          `Nothing drivable is that tight; this is a discontinuity in the spline, not a corner.`,
      )
    }
    if (maxKRate > CFG.maxCurvatureRate) {
      fail(
        cont,
        `curvature steps by ${(maxKRate * ds).toFixed(4)} 1/m across one ${ds.toFixed(3)} m step at ` +
          `t=${(maxKRateAt / N).toFixed(4)} (${maxKRate.toFixed(4)} 1/m^2, limit ${CFG.maxCurvatureRate}). ` +
          `The AI picks corner-entry speed from curvature; a step here is a step in target speed. ` +
          `A piecewise-circular-arc layout fails this by construction — it needs transition curves, not a wider limit.`,
      )
    }
    if (maxBankRate > CFG.maxBankRate) {
      fail(cont, `bank changes at ${maxBankRate.toFixed(4)} rad/m (limit ${CFG.maxBankRate}) — the road twists faster than a kart can follow`)
    }
    if (maxWidthRate > CFG.maxWidthRate) {
      fail(cont, `halfWidth changes at ${maxWidthRate.toFixed(3)} m/m (limit ${CFG.maxWidthRate}) — the road steps width`)
    }
    if (worstKErr > 0) {
      fail(
        cont,
        `reported curvature disagrees with the geometry: at t=${(worstKErrAt / N).toFixed(4)} the tangents imply ` +
          `${worstKObs.toFixed(5)} 1/m and TrackSample.curvature says ${worstKRep.toFixed(5)} 1/m ` +
          `(${worstKErr.toFixed(5)} beyond tolerance). Curvature is signed 1/m, positive curving right.`,
      )
    }
  }

  // =========================================================================
  // 4  frame orthonormality
  // =========================================================================
  const frame = mk('frame', 'tangent, normal, right are an orthonormal right-handed frame')
  if (needSample(frame)) {
    let wUnit = 0
    let wUnitAt = 0
    let wPerp = 0
    let wPerpAt = 0
    let wCross = 0
    let wCrossAt = 0
    let flippedNormals = 0
    let firstFlip = -1
    const tmp = { x: 0, y: 0, z: 0 }
    for (let i = 0; i < N; i++) {
      const s = samples[i]
      const u = Math.max(Math.abs(nrm(s.tangent) - 1), Math.abs(nrm(s.normal) - 1), Math.abs(nrm(s.right) - 1))
      if (u > wUnit) {
        wUnit = u
        wUnitAt = i
      }
      const p = Math.max(Math.abs(dot(s.tangent, s.normal)), Math.abs(dot(s.tangent, s.right)), Math.abs(dot(s.normal, s.right)))
      if (p > wPerp) {
        wPerp = p
        wPerpAt = i
      }
      crossInto(tmp, s.tangent, s.normal)
      const c = dist(tmp, s.right)
      if (c > wCross) {
        wCross = c
        wCrossAt = i
      }
      if (dot(s.normal, UP) <= 0) {
        flippedNormals++
        if (firstFlip < 0) firstFlip = i
      }
    }
    frame.metrics.worstUnitError = wUnit
    frame.metrics.worstPerpDot = wPerp
    frame.metrics.worstCrossError = wCross
    frame.metrics.flippedNormals = flippedNormals

    if (wUnit > CFG.orthoTol) {
      fail(
        frame,
        `a basis vector is not unit length: worst |len-1| = ${wUnit.toExponential(3)} at t=${(wUnitAt / N).toFixed(4)} ` +
          `(limit ${CFG.orthoTol}). A frame that quietly loses normalisation makes karts lean wrong on banking ` +
          `and nothing in the frame says which line did it.`,
      )
    }
    if (wPerp > CFG.orthoTol) {
      fail(
        frame,
        `the basis is not orthogonal: worst |dot| = ${wPerp.toExponential(3)} at t=${(wPerpAt / N).toFixed(4)} ` +
          `(limit ${CFG.orthoTol}). tangent, normal and right must be mutually perpendicular at every t.`,
      )
    }
    if (wCross > CFG.orthoTol) {
      fail(
        frame,
        `right != tangent x normal: worst error ${wCross.toExponential(3)} at t=${(wCrossAt / N).toFixed(4)} ` +
          `(limit ${CFG.orthoTol}). TrackSample states right is exactly that cross product, and every ` +
          `lateral sign in the game is downstream of it.`,
      )
    }
    if (flippedNormals > 0) {
      fail(frame, `${flippedNormals} sample(s) have a normal pointing below the horizon, first at t=${(firstFlip / N).toFixed(4)} — the road is upside down there`)
    }
  }

  // =========================================================================
  // 5  locate is the inverse of sample.  THE IMPORTANT ONE.
  // =========================================================================
  const inv = mk('locate-inverse', 'locate(sample(t) + right*L + normal*H) returns (t, L, H)')
  if (!has.locate) pend(inv, 'requires ITrack.locate')
  else if (needSample(inv)) {
    const p = makeVec()
    const loc = mkLoc()
    const verify = mkSample()
    let identityOk = true
    let worstArc = 0
    let worstArcAt = null
    let worstLat = 0
    let worstLatAt = null
    let worstH = 0
    let onTrackWrong = 0
    let firstOnTrackWrong = null
    let tRangeViolations = 0
    let ambiguous = 0
    let tested = 0

    const M = CFG.locateSweep
    for (let j = 0; j < M; j++) {
      const t = j / M
      const s = samples[Math.round((j * N) / M) % N]
      const probes = []
      for (const f of CFG.lateralFractions) probes.push(f * s.halfWidth)
      for (const extra of CFG.offTrackProbesM) {
        probes.push(s.halfWidth + CFG.barrierMargin + extra)
        probes.push(-(s.halfWidth + CFG.barrierMargin + extra))
      }
      for (const lat of probes) {
        for (const h of CFG.heights) {
          p.x = s.position.x + s.right.x * lat + s.normal.x * h
          p.y = s.position.y + s.right.y * lat + s.normal.y * h
          p.z = s.position.z + s.right.z * lat + s.normal.z * h
          const ret = track.locate(p, loc)
          if (ret !== loc) identityOk = false
          const r = ret || loc

          /*
           * Ill-posed queries are detected, not guessed at. If locate came back
           * with a centreline point at least as close to the probe as the one we
           * built it from, then the probe genuinely has more than one nearest
           * point and locate is not wrong — our expectation is. Counted and
           * reported. Only a result strictly farther away is a failure.
           */
          if (Number.isFinite(r.t)) {
            track.sample(r.t, verify)
            const dGot = dist(p, verify.position)
            const dExpected = dist(p, s.position)
            if (dGot <= dExpected + CFG.ambiguityToleranceM && Math.abs(wrapDelta(r.t, t)) * L > CFG.locateArcTolM) {
              ambiguous++
              continue
            }
          }
          tested++

          if (!(r.t >= 0 && r.t < 1)) tRangeViolations++
          const arcErr = Math.abs(wrapDelta(r.t, t)) * L
          if (arcErr > worstArc) {
            worstArc = arcErr
            worstArcAt = { t, lat, h, got: r.t }
          }
          const latErr = Math.abs(r.lateral - lat)
          if (latErr > worstLat) {
            worstLat = latErr
            worstLatAt = { t, lat, h, got: r.lateral }
          }
          worstH = Math.max(worstH, Math.abs(r.height - h))

          const expectOn = Math.abs(lat) <= s.halfWidth + CFG.barrierMargin
          if (Boolean(r.onTrack) !== expectOn) {
            onTrackWrong++
            if (!firstOnTrackWrong) firstOnTrackWrong = { t, lat, expectOn, got: Boolean(r.onTrack) }
          }
        }
      }
    }

    inv.metrics.queries = tested
    inv.metrics.ambiguousSkipped = ambiguous
    inv.metrics.worstArcErrorM = worstArc
    inv.metrics.worstLateralErrorM = worstLat
    inv.metrics.worstHeightErrorM = worstH
    inv.metrics.onTrackDisagreements = onTrackWrong

    if (!identityOk) fail(inv, 'locate(p, out) did not return `out`')
    if (worstArc > CFG.locateArcTolM) {
      const w = worstArcAt
      fail(
        inv,
        `locate does not invert sample: worst arc error ${worstArc.toFixed(4)} m (limit ${CFG.locateArcTolM}) ` +
          `— a point ${w.lat.toFixed(2)} m right of the centreline at t=${w.t.toFixed(4)} located as t=${w.got.toFixed(6)}. ` +
          `locate runs once per kart per frame; a wrong one poisons lap counting, AI, respawn and surface queries at once.`,
      )
    }
    if (worstLat > CFG.locateLatTolM) {
      const w = worstLatAt
      fail(
        inv,
        `lateral does not round-trip: offset ${w.lat.toFixed(3)} m at t=${w.t.toFixed(4)} came back as ` +
          `${w.got.toFixed(3)} m (error ${worstLat.toFixed(4)} m, limit ${CFG.locateLatTolM}). ` +
          `If the sign is inverted, read the 'signs' check — positive lateral is the DRIVER'S RIGHT.`,
      )
    }
    if (worstH > CFG.locateHeightTolM) {
      fail(inv, `height does not round-trip: worst error ${worstH.toFixed(4)} m (limit ${CFG.locateHeightTolM}). TrackLocation.height is metres above the road plane.`)
    }
    if (tRangeViolations > 0) {
      fail(inv, `${tRangeViolations} of ${tested} results had t outside [0, 1) — TrackLocation.t is normalised distance in [0, 1)`)
    }
    if (onTrackWrong > 0) {
      const w = firstOnTrackWrong
      fail(
        inv,
        `onTrack disagrees with its own definition in ${onTrackWrong} of ${tested} queries — ` +
          `first at t=${w.t.toFixed(4)}, lateral ${w.lat.toFixed(2)} m: expected ${w.expectOn}, got ${w.got}. ` +
          `TrackLocation.onTrack is false once |lateral| > halfWidth + ${CFG.barrierMargin}.`,
      )
    }
    if (ambiguous > 0) {
      inv.notes.push(
        `${ambiguous} of ${tested + ambiguous} probes were geometrically ambiguous — locate returned a centreline ` +
          `point at least as close to the probe as the one it was built from, so more than one nearest point exists ` +
          `there and the round trip cannot be asserted. Reported, not skipped silently.`,
      )
    }
  }

  // =========================================================================
  // 6  sign conventions
  // =========================================================================
  const signs = mk('signs', 'positive lateral is the driver’s right, anchored to the world axes')
  if (needSample(signs)) {
    /*
     * Anchor 1: the frame against the world axes stated in the contract.
     * WORLD_FORWARD is -Z, WORLD_UP is +Y, +X is right. Rotating a heading by
     * -90 degrees about +Y gives the driver's right, so for any tangent the
     * horizontal part of `right` must satisfy dot((R.x, R.z), (-T.z, T.x)) > 0.
     * Facing -Z, right is +X. Facing +X, right is +Z. Both fall out of it.
     */
    let handednessViolations = 0
    let firstHandednessAt = -1
    let worstHeadingDeg = 0
    let degenerate = 0
    for (let i = 0; i < N; i++) {
      const s = samples[i]
      const hx = -s.tangent.z
      const hz = s.tangent.x
      const hm = Math.hypot(hx, hz)
      const rm = Math.hypot(s.right.x, s.right.z)
      if (hm < 1e-6 || rm < 1e-6) {
        degenerate++
        continue
      }
      const c = (s.right.x * hx + s.right.z * hz) / (hm * rm)
      if (c <= 0) {
        handednessViolations++
        if (firstHandednessAt < 0) firstHandednessAt = i
      }
      const dev = Math.acos(clamp1(c)) * (180 / Math.PI)
      if (dev > worstHeadingDeg) worstHeadingDeg = dev
    }
    signs.metrics.handednessViolations = handednessViolations
    signs.metrics.worstRightHeadingDeg = worstHeadingDeg
    if (handednessViolations > 0) {
      fail(
        signs,
        `${handednessViolations} sample(s) have TrackSample.right pointing to the driver's LEFT, first at ` +
          `t=${(firstHandednessAt / N).toFixed(4)}. World axes are +X right, +Y up, -Z forward: a kart heading -Z ` +
          `has its right along +X, one heading +X has its right along +Z. ` +
          `steer > 0, lateral > 0 and TrackSample.right all mean the driver's right and none of them is negated anywhere.`,
      )
    }

    // Anchor 2: locate must agree. A +2 m offset along `right` is +2 m lateral.
    if (has.locate) {
      const p = makeVec()
      const loc = mkLoc()
      let wrongSign = 0
      let firstWrong = -1
      const OFFSET = 2.0
      for (let j = 0; j < CFG.locateSweep; j++) {
        const s = samples[Math.round((j * N) / CFG.locateSweep) % N]
        if (s.halfWidth < OFFSET) continue
        p.x = s.position.x + s.right.x * OFFSET
        p.y = s.position.y + s.right.y * OFFSET
        p.z = s.position.z + s.right.z * OFFSET
        const r = track.locate(p, loc) || loc
        if (!(r.lateral > 0)) {
          wrongSign++
          if (firstWrong < 0) firstWrong = j
        }
      }
      signs.metrics.lateralSignViolations = wrongSign
      if (wrongSign > 0) {
        fail(
          signs,
          `locate reports NEGATIVE lateral for a point ${OFFSET} m along TrackSample.right, in ${wrongSign} place(s) ` +
            `(first t=${(firstWrong / CFG.locateSweep).toFixed(4)}). TrackLocation.lateral is "signed metres from the ` +
            `centreline; positive is the driver's right". Fix the frame maths, do not add a negation — the second ` +
            `negation somewhere else then looks correct too and only one of them is.`,
        )
      }
    } else {
      pend(signs, 'lateral sign against locate requires ITrack.locate')
    }

    /*
     * Anchor 3: bank. "Positive banks the road down toward the driver's right."
     * With the frame rotated about the tangent by `bank`, that is exactly
     *     dot(right, WORLD_UP) = -sin(bank) * cos(pitch),  cos(pitch) = sqrt(1 - Ty^2)
     * The right-hand edge is the low one, so `right` tilts downward. Pitch enters
     * because a climbing road still has a horizontal `right` at zero bank.
     */
    let bankedFraction = 0
    let worstBankErr = 0
    let worstBankAt = -1
    for (let i = 0; i < N; i++) {
      const s = samples[i]
      if (Math.abs(s.bank) > 1e-4) bankedFraction++
      const cosPitch = Math.sqrt(Math.max(0, 1 - s.tangent.y * s.tangent.y))
      const e = Math.abs(dot(s.right, UP) + Math.sin(s.bank) * cosPitch)
      if (e > worstBankErr) {
        worstBankErr = e
        worstBankAt = i
      }
    }
    bankedFraction /= N
    signs.metrics.bankedFraction = bankedFraction
    signs.metrics.worstBankSignError = worstBankErr
    if (worstBankErr > 1e-3) {
      const s = samples[worstBankAt]
      fail(
        signs,
        `bank does not match the frame at t=${(worstBankAt / N).toFixed(4)}: bank=${s.bank.toFixed(4)} rad predicts ` +
          `dot(right, up)=${(-Math.sin(s.bank) * Math.sqrt(1 - s.tangent.y ** 2)).toFixed(5)}, measured ` +
          `${dot(s.right, UP).toFixed(5)} (error ${worstBankErr.toExponential(2)}). ` +
          `"Positive banks the road down toward the driver's right" means the right-hand edge is the LOW one, ` +
          `so right tilts downward by sin(bank) and normal leans toward the low side.`,
      )
    }
    if (bankedFraction < 0.001) {
      pend(signs, 'bank is zero across the whole lap — the bank sign convention is UNTESTED by this run, not confirmed by it')
    }

    // Anchor 4: curvature sign. Positive curves right, so dT/ds points right.
    let kSignViolations = 0
    let firstKSign = -1
    let kTested = 0
    for (let i = 0; i < N; i++) {
      const a = samples[i]
      if (Math.abs(a.curvature) < CFG.curvatureSignFloor) continue
      kTested++
      const b = samples[(i + 1) % N]
      const pv = samples[(i - 1 + N) % N]
      const kObs = ((b.tangent.x - pv.tangent.x) * a.right.x +
        (b.tangent.y - pv.tangent.y) * a.right.y +
        (b.tangent.z - pv.tangent.z) * a.right.z) / (2 * ds)
      if (Math.sign(kObs) !== Math.sign(a.curvature)) {
        kSignViolations++
        if (firstKSign < 0) firstKSign = i
      }
    }
    signs.metrics.curvatureSignViolations = kSignViolations
    signs.metrics.curvatureSamplesTested = kTested
    if (kSignViolations > 0) {
      fail(
        signs,
        `curvature has the wrong sign at ${kSignViolations} of ${kTested} corner samples, first at ` +
          `t=${(firstKSign / N).toFixed(4)}. TrackSample.curvature is "signed 1/m, positive curves right", ` +
          `so dT/ds must point along TrackSample.right where it is positive. The AI picks entry speed from this.`,
      )
    }
    if (kTested === 0) {
      pend(signs, `no sample has |curvature| > ${CFG.curvatureSignFloor} — the curvature sign convention is UNTESTED by this run`)
    }
  }

  // =========================================================================
  // 7  locate cost and allocation
  // =========================================================================
  const cost = mk('locate-cost', 'locate is fast and does not allocate')
  if (!has.locate || !samples) pend(cost, 'requires ITrack.locate and a working sample')
  else {
    const Q = 4096
    const pts = new Array(Q)
    for (let i = 0; i < Q; i++) {
      const s = samples[Math.floor((i * N) / Q) % N]
      const lat = ((i * 2654435761) % 1000) / 1000 - 0.5
      const l = lat * 2 * s.halfWidth
      const v = makeVec()
      v.x = s.position.x + s.right.x * l
      v.y = s.position.y + s.right.y * l
      v.z = s.position.z + s.right.z * l
      pts[i] = v
    }
    const loc = mkLoc()
    const scratch = mkSample()

    for (let i = 0; i < CFG.warmupCalls; i++) track.locate(pts[i & (Q - 1)], loc)
    let t0 = performance.now()
    for (let i = 0; i < CFG.locateCalls; i++) track.locate(pts[i & (Q - 1)], loc)
    const locateNs = ((performance.now() - t0) * 1e6) / CFG.locateCalls

    for (let i = 0; i < CFG.warmupCalls; i++) track.sample((i & 4095) / 4096, scratch)
    t0 = performance.now()
    for (let i = 0; i < CFG.sampleCalls; i++) track.sample((i & 4095) / 4096, scratch)
    const sampleNs = ((performance.now() - t0) * 1e6) / CFG.sampleCalls

    cost.metrics.locateNs = locateNs
    cost.metrics.sampleNs = sampleNs
    // 8 karts x (chassis + 4 wheels) x 120 Hz.
    cost.metrics.msPerSecondAtFullField = (locateNs * 4800) / 1e6

    if (locateNs > CFG.maxLocateNs) {
      fail(
        cost,
        `locate costs ${locateNs.toFixed(0)} ns/call (limit ${CFG.maxLocateNs}). ` +
          `At 8 karts x 5 queries x 120 Hz that is ${((locateNs * 4800) / 1e6).toFixed(2)} ms of CPU per second. ` +
          `A cost in this range is what a linear scan of the centreline looks like; it shows up here and nowhere ` +
          `else until the frame rate collapses with a full field.`,
      )
    }
    if (sampleNs > CFG.maxSampleNs) {
      fail(cost, `sample costs ${sampleNs.toFixed(0)} ns/call (limit ${CFG.maxSampleNs})`)
    }

    const mem = performance.memory
    if (typeof globalThis.gc !== 'function' || !mem) {
      pend(
        cost,
        'allocation UNMEASURED: needs --js-flags=--expose-gc and performance.memory. ' +
          'ITrack.locate is on the contract’s MUST NOT ALLOCATE list and this run did not confirm it.',
      )
    } else {
      globalThis.gc()
      globalThis.gc()
      const h0 = mem.usedJSHeapSize
      for (let i = 0; i < CFG.allocCalls; i++) track.locate(pts[i & (Q - 1)], loc)
      const h1 = mem.usedJSHeapSize
      const bytes = (h1 - h0) / CFG.allocCalls
      cost.metrics.bytesPerLocate = bytes
      if (bytes < 0) {
        pend(cost, `allocation INCONCLUSIVE: the heap shrank during the window (a GC ran). Re-run.`)
      } else if (bytes > CFG.maxBytesPerLocate) {
        fail(
          cost,
          `locate allocates ~${bytes.toFixed(1)} bytes/call over ${CFG.allocCalls} calls. ` +
            `The contract lists ITrack.locate under MUST NOT ALLOCATE — use a module-scope scratch, ` +
            `never new Vector3() inside it.`,
        )
      }
    }
  }

  // =========================================================================
  // 8  checkpoints
  // =========================================================================
  const cps = mk('checkpoints', 'ordered, ascending, first at 0, and locate agrees')
  if (!has.checkpoints) pend(cps, 'requires ITrack.checkpoints')
  else {
    const c = Array.prototype.slice.call(track.checkpoints)
    cps.metrics.count = c.length
    if (c.length === 0) {
      fail(cps, 'checkpoints is empty — a lap can never be validated')
    } else {
      if (c[0] !== 0) {
        fail(cps, `checkpoints[0] is ${c[0]} — the contract says it is exactly 0 (the start line)`)
      }
      if (c.length < 2) {
        fail(cps, `only ${c.length} checkpoint(s) — with nothing between start lines, any shortcut counts as a lap`)
      }
      let minGap = Infinity
      let maxGap = 0
      for (let i = 0; i < c.length; i++) {
        if (!(c[i] >= 0 && c[i] < 1)) fail(cps, `checkpoints[${i}] = ${c[i]} is outside [0, 1)`)
        if (i > 0 && !(c[i] > c[i - 1])) {
          fail(cps, `checkpoints[${i}] = ${c[i]} is not greater than checkpoints[${i - 1}] = ${c[i - 1]} — the array must be ordered and ascending, and lap validation walks it in index order`)
        }
        const gap = i + 1 < c.length ? c[i + 1] - c[i] : 1 - c[i] + c[0]
        minGap = Math.min(minGap, gap)
        maxGap = Math.max(maxGap, gap)
      }
      cps.metrics.minGapM = minGap * L
      cps.metrics.maxGapFrac = maxGap
      if (L > 0 && minGap * L < CFG.minCheckpointSpacingM) {
        fail(
          cps,
          `closest checkpoints are ${(minGap * L).toFixed(2)} m apart (limit ${CFG.minCheckpointSpacingM} m). ` +
            `A kart at 40 m/s covers 0.33 m per 120 Hz tick; checkpoints this close can both fall inside one tick ` +
            `and an order-sensitive lap counter can miss one.`,
        )
      }
      if (maxGap > CFG.maxCheckpointSpacingFrac) {
        fail(cps, `largest checkpoint gap is ${(maxGap * 100).toFixed(1)}% of the lap (limit ${(CFG.maxCheckpointSpacingFrac * 100).toFixed(0)}%) — checkpoints that sparse do not stop a shortcut`)
      }

      // Agreement with TrackLocation.checkpointIndex at every t.
      if (has.locate && samples) {
        const loc = mkLoc()
        const p = makeVec()
        let disagreements = 0
        let firstBad = null
        let skippedEdge = 0
        const band = L > 0 ? CFG.checkpointEdgeBandM / L : 0
        for (let i = 0; i < N; i++) {
          const t = i / N
          let nearEdge = false
          for (let k = 0; k < c.length; k++) {
            if (Math.abs(wrapDelta(t, c[k])) < band) nearEdge = true
          }
          if (nearEdge) {
            skippedEdge++
            continue
          }
          let expect = -1
          for (let k = 0; k < c.length; k++) if (c[k] <= t) expect = k
          if (expect < 0) expect = c.length - 1
          const s = samples[i]
          p.x = s.position.x
          p.y = s.position.y
          p.z = s.position.z
          const r = track.locate(p, loc) || loc
          if (r.checkpointIndex !== expect) {
            disagreements++
            if (!firstBad) firstBad = { t, expect, got: r.checkpointIndex }
          }
        }
        cps.metrics.indexDisagreements = disagreements
        cps.metrics.edgeBandSkipped = skippedEdge
        if (disagreements > 0) {
          fail(
            cps,
            `TrackLocation.checkpointIndex disagrees with the checkpoints array at ${disagreements} of ${N} points ` +
              `on the centreline — first at t=${firstBad.t.toFixed(4)}, expected ${firstBad.expect}, got ${firstBad.got}. ` +
              `It is "the index of the last checkpoint at or before t".`,
          )
        }
        if (skippedEdge > 0) {
          cps.notes.push(`${skippedEdge} of ${N} points skipped within ${CFG.checkpointEdgeBandM} m of a checkpoint, where the index legitimately flips inside locate's own tolerance`)
        }
      } else {
        pend(cps, 'checkpointIndex agreement requires ITrack.locate')
      }
    }
  }

  // =========================================================================
  // 9  start grid
  // =========================================================================
  const grid = mk('start-grid', 'every slot on the road, apart, and square to the road plane')
  if (!has.startGrid) pend(grid, 'requires ITrack.startGrid')
  else {
    const g = Array.prototype.slice.call(track.startGrid)
    grid.metrics.count = g.length
    if (g.length === 0) fail(grid, 'startGrid is empty — there is nowhere to put a kart')
    else if (g.length < 2) fail(grid, `startGrid has ${g.length} slot(s); the field is eight karts`)

    if (g.length > 0 && has.sample && has.locate && samples) {
      const s = mkSample()
      const loc = mkLoc()
      const p = makeVec()
      const fwd = makeVec()
      const up = makeVec()
      let worstT = 0
      let worstLat = 0
      let worstHeight = 0
      let worstFwdDeg = 0
      let worstUpDeg = 0
      let worstQuatErr = 0
      let offRoad = 0
      let tMin = 1
      let tMax = 0
      for (let i = 0; i < g.length; i++) {
        const slot = g[i]
        if (!slot || !slot.position || !slot.orientation || typeof slot.t !== 'number') {
          fail(grid, `startGrid[${i}] is not a StartSlot (needs position, orientation, t)`)
          continue
        }
        tMin = Math.min(tMin, slot.t)
        tMax = Math.max(tMax, slot.t)
        track.sample(slot.t, s)
        p.x = slot.position.x
        p.y = slot.position.y
        p.z = slot.position.z
        const r = track.locate(p, loc) || loc
        worstT = Math.max(worstT, Math.abs(wrapDelta(r.t, slot.t)) * L)
        worstLat = Math.max(worstLat, Math.abs(r.lateral))
        worstHeight = Math.max(worstHeight, Math.abs(r.height))
        if (Math.abs(r.lateral) > s.halfWidth) {
          offRoad++
          fail(
            grid,
            `startGrid[${i}] sits ${r.lateral.toFixed(2)} m off the centreline where halfWidth is ` +
              `${s.halfWidth.toFixed(2)} m — a kart spawns off the road`,
          )
        }
        if (Math.abs(r.height) > CFG.maxSlotHeightM) {
          fail(grid, `startGrid[${i}] is ${r.height.toFixed(2)} m off the road plane (limit ${CFG.maxSlotHeightM} m) — the kart spawns buried or floating`)
        }

        const q = slot.orientation
        const qn = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w)
        worstQuatErr = Math.max(worstQuatErr, Math.abs(qn - 1))

        // WORLD_FORWARD is -Z at identity; the slot must face along the tangent.
        fwd.x = 0
        fwd.y = 0
        fwd.z = -1
        rotQ(fwd, { x: 0, y: 0, z: -1 }, q)
        const fa = angle(fwd, s.tangent)
        worstFwdDeg = Math.max(worstFwdDeg, (fa * 180) / Math.PI)
        if (fa > CFG.gridForwardTolRad) {
          fail(
            grid,
            `startGrid[${i}] faces ${((fa * 180) / Math.PI).toFixed(1)} deg off the tangent at t=${slot.t.toFixed(4)} ` +
              `(limit ${((CFG.gridForwardTolRad * 180) / Math.PI).toFixed(0)} deg) — it is not pointing down the road`,
          )
        }

        // WORLD_UP is +Y at identity; the slot's up must be the road normal.
        rotQ(up, { x: 0, y: 1, z: 0 }, q)
        const ua = angle(up, s.normal)
        worstUpDeg = Math.max(worstUpDeg, (ua * 180) / Math.PI)
        if (ua > CFG.gridUpTolRad) {
          fail(
            grid,
            `startGrid[${i}] has its up ${((ua * 180) / Math.PI).toFixed(2)} deg off the road normal at ` +
              `t=${slot.t.toFixed(4)} (limit ${((CFG.gridUpTolRad * 180) / Math.PI).toFixed(0)} deg; bank there is ` +
              `${((s.bank * 180) / Math.PI).toFixed(2)} deg and slope ${((Math.asin(s.tangent.y) * 180) / Math.PI).toFixed(2)} deg). ` +
              `StartSlot is a full quaternion precisely so a banked or sloped grid does not spawn karts intersecting ` +
              `the road; a yaw-only heading cannot express the difference, and this is what that mistake looks like.`,
          )
        }
      }
      let minSep = Infinity
      let minSepPair = null
      for (let i = 0; i < g.length; i++) {
        for (let j = i + 1; j < g.length; j++) {
          if (!g[i] || !g[j] || !g[i].position || !g[j].position) continue
          const d = dist(g[i].position, g[j].position)
          if (d < minSep) {
            minSep = d
            minSepPair = [i, j]
          }
        }
      }
      grid.metrics.minSeparationM = minSep
      grid.metrics.worstSlotTErrorM = worstT
      grid.metrics.worstLateralM = worstLat
      grid.metrics.worstHeightM = worstHeight
      grid.metrics.worstForwardDeg = worstFwdDeg
      grid.metrics.worstUpDeg = worstUpDeg
      grid.metrics.worstQuatNormError = worstQuatErr
      grid.metrics.tRange = [tMin, tMax]
      grid.metrics.offRoadSlots = offRoad

      if (minSep < CFG.minSlotSeparationM) {
        fail(
          grid,
          `startGrid[${minSepPair[0]}] and startGrid[${minSepPair[1]}] are ${minSep.toFixed(3)} m apart ` +
            `(limit ${CFG.minSlotSeparationM} m) — the karts spawn interpenetrating. ` +
            `NOTE: the contract states no kart dimensions, so that limit is this harness's estimate, not the contract's.`,
        )
      }
      if (worstT > CFG.slotTTolM) {
        fail(grid, `a slot's declared t is ${worstT.toFixed(2)} m from where locate puts its position (limit ${CFG.slotTTolM} m) — StartSlot.t is "the track coordinate of this slot" and respawn and telemetry use it`)
      }
      if (worstQuatErr > 1e-4) {
        fail(grid, `a slot orientation is not a unit quaternion (worst |q|-1 = ${worstQuatErr.toExponential(2)})`)
      }
      grid.notes.push(
        `slot t range ${tMin.toFixed(4)}..${tMax.toFixed(4)} — reported, not gated. The contract does not say ` +
          `whether the grid sits before or after the start line; if any slot is after t=0 the first lap is short ` +
          `by that distance and lap-1 times are not comparable with the rest.`,
      )
    } else if (g.length > 0) {
      pend(grid, 'grid geometry requires ITrack.sample and ITrack.locate')
    }
  }

  // =========================================================================
  // 10  surface zones
  // =========================================================================
  const surf = mk('surfaces', `surfaceAt is OffTrack beyond halfWidth + ${CFG.barrierMargin} m, at every t`)
  if (!has.surfaceAt) pend(surf, 'requires ITrack.surfaceAt')
  else if (needSample(surf)) {
    const S = CFG.surfaceSweep
    let leaks = 0
    let firstLeak = null
    let centreOff = 0
    let firstCentreOff = null
    let roadOff = 0
    let firstRoadOff = null
    let shoulderOffTrack = 0
    const histogram = {}
    for (let j = 0; j < S; j++) {
      const t = j / S
      const s = samples[Math.round((j * N) / S) % N]
      const edge = s.halfWidth + CFG.barrierMargin

      const centre = track.surfaceAt(t, 0)
      if (centre === CFG.offTrack) {
        centreOff++
        if (!firstCentreOff) firstCentreOff = t
      }
      for (const f of [-0.9, -0.5, 0, 0.5, 0.9]) {
        const lat = f * s.halfWidth
        const v = track.surfaceAt(t, lat)
        histogram[v] = (histogram[v] || 0) + 1
        if (v === CFG.offTrack) {
          roadOff++
          if (!firstRoadOff) firstRoadOff = { t, lat, hw: s.halfWidth }
        }
      }
      for (const sign of [-1, 1]) {
        for (const f of CFG.offTrackFactors) {
          const lat = sign * edge * f
          const v = track.surfaceAt(t, lat)
          if (v !== CFG.offTrack) {
            leaks++
            if (!firstLeak) firstLeak = { t, lat, edge, got: v }
          }
        }
        // The shoulder: past halfWidth but inside the barrier margin. Reported.
        const shoulder = track.surfaceAt(t, sign * (s.halfWidth + CFG.barrierMargin * 0.5))
        if (shoulder === CFG.offTrack) shoulderOffTrack++
      }
    }
    surf.metrics.histogram = histogram
    surf.metrics.offTrackLeaks = leaks
    surf.metrics.shoulderReadsOffTrack = shoulderOffTrack
    surf.metrics.shoulderProbes = S * 2

    if (leaks > 0) {
      fail(
        surf,
        `surfaceAt returned ${firstLeak.got} (not OffTrack=${CFG.offTrack}) at t=${firstLeak.t.toFixed(4)}, ` +
          `lateral ${firstLeak.lat.toFixed(2)} m, where the barrier line is ${firstLeak.edge.toFixed(2)} m ` +
          `(${leaks} such points). "Outside every defined surface region this returns Surface.OffTrack" — ` +
          `without it a kart in the scenery keeps full grip and game/ never respawns it.`,
      )
    }
    if (centreOff > 0) {
      fail(surf, `the centreline itself reads OffTrack at ${centreOff} of ${S} points, first t=${firstCentreOff.toFixed(4)}`)
    }
    if (roadOff > 0) {
      fail(
        surf,
        `surfaceAt reads OffTrack inside halfWidth — first at t=${firstRoadOff.t.toFixed(4)}, lateral ` +
          `${firstRoadOff.lat.toFixed(2)} m against halfWidth ${firstRoadOff.hw.toFixed(2)} m (${roadOff} points). ` +
          `The road is narrower than TrackSample.halfWidth claims.`,
      )
    }
    if (shoulderOffTrack > 0) {
      surf.notes.push(
        `${shoulderOffTrack} of ${S * 2} shoulder probes (between halfWidth and the barrier line) read OffTrack. ` +
          `Reported, not gated: the contract does not say what the shoulder is. It matters — OffTrack carries ` +
          `grip 0.5 and 9 m/s^2 of drag while TrackLocation.onTrack is still true, so a kart there is punished ` +
          `like it left the circuit but never respawns. See the report.`,
      )
    }
  }

  // =========================================================================
  // 11  racing line
  // =========================================================================
  const line = mk('racing-line', 'the ideal line stays on the track and goes to the inside')
  if (!has.racingLine) pend(line, 'requires ITrack.racingLine')
  else if (needSample(line)) {
    const vals = new Array(N)
    let worstOver = 0
    let worstOverAt = -1
    let maxRate = 0
    for (let i = 0; i < N; i++) {
      vals[i] = track.racingLine(i / N)
      if (!Number.isFinite(vals[i])) {
        fail(line, `racingLine(${(i / N).toFixed(4)}) is not finite`)
        vals[i] = 0
      }
      const over = Math.abs(vals[i]) - samples[i].halfWidth
      if (over > worstOver) {
        worstOver = over
        worstOverAt = i
      }
    }
    for (let i = 0; i < N; i++) {
      maxRate = Math.max(maxRate, Math.abs(vals[(i + 1) % N] - vals[i]) / ds)
    }
    line.metrics.maxAbsLateralM = Math.max(...vals.map(Math.abs))
    line.metrics.worstOverhangM = worstOver
    line.metrics.maxRate = maxRate
    if (worstOver > 0) {
      fail(
        line,
        `racingLine goes ${worstOver.toFixed(3)} m outside the road at t=${(worstOverAt / N).toFixed(4)} ` +
          `(lateral ${vals[worstOverAt].toFixed(2)} m against halfWidth ${samples[worstOverAt].halfWidth.toFixed(2)} m). ` +
          `Every AI kart and the ghost drive this line.`,
      )
    }
    if (maxRate > CFG.maxRacingLineRate) {
      fail(line, `racingLine moves at ${maxRate.toFixed(3)} m/m (limit ${CFG.maxRacingLineRate}) — the AI will saw at the wheel following it`)
    }

    // Correlation with curvature. Reported; only a strong inversion is gated.
    function pearson(a, b) {
      let ma = 0
      let mb = 0
      for (let i = 0; i < a.length; i++) {
        ma += a[i]
        mb += b[i]
      }
      ma /= a.length
      mb /= b.length
      let num = 0
      let da = 0
      let db = 0
      for (let i = 0; i < a.length; i++) {
        const x = a[i] - ma
        const y = b[i] - mb
        num += x * y
        da += x * x
        db += y * y
      }
      return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0
    }
    const kv = samples.map((s) => s.curvature)
    const r0 = pearson(vals, kv)
    let bestR = r0
    let bestLag = 0
    const maxLag = Math.round(CFG.correlationLagFrac * N)
    for (let lag = -maxLag; lag <= maxLag; lag += Math.max(1, Math.round(maxLag / 24))) {
      const shifted = new Array(N)
      for (let i = 0; i < N; i++) shifted[i] = kv[(i + lag + N * 2) % N]
      const r = pearson(vals, shifted)
      if (Math.abs(r) > Math.abs(bestR)) {
        bestR = r
        bestLag = lag
      }
    }
    line.metrics.curvatureCorrelation = r0
    line.metrics.bestCorrelation = bestR
    line.metrics.bestLagFrac = bestLag / N
    line.notes.push(
      `correlation with curvature r=${r0.toFixed(3)} at zero lag, best r=${bestR.toFixed(3)} at ` +
        `${((bestLag / N) * 100).toFixed(2)}% of a lap of lag. Positive is correct — the ideal line goes to the ` +
        `inside, and positive curvature is a right-hand corner whose inside is positive lateral. Reported, not gated.`,
    )
    if (r0 <= CFG.racingLineInvertedR) {
      fail(
        line,
        `racingLine correlates ${r0.toFixed(3)} with curvature — the ideal line runs to the OUTSIDE of every corner. ` +
          `That is a sign error, not a style choice: positive curvature curves right and the inside of a right-hand ` +
          `corner is positive lateral. This is the one hard rail on this check; the magnitude is never gated.`,
      )
    }
  }

  return R
}

// ---------------------------------------------------------------------------
// The reference ITrack, and its sabotages
// ---------------------------------------------------------------------------
/*
 * A complete, honest ITrack built from a smooth closed polar curve:
 *
 *     r(theta) = R0 (1 + a cos 3theta),  y = h sin 2theta
 *
 * Single-valued in theta and strictly positive, so it is a simple closed curve
 * with no self-intersection — which is what makes `locate` well posed. It is C-
 * infinity, so curvature and bank are continuous by construction; corner radii
 * run 15-70 m; it climbs and descends; it banks in proportion to curvature; it
 * has eight checkpoints and an eight-slot staggered grid.
 *
 * Arc-length parameterisation is done the way a real implementation must do it:
 * a dense theta sweep, cumulative chord length, then a table inverting s -> theta.
 * `locate` uses a uniform spatial hash over the centreline so that it is O(1)
 * rather than O(n) — which is exactly the difference the cost check exists to
 * find, and having a worked example of the fast shape in the harness is more use
 * than a number in a comment.
 *
 * SABOTAGES. Each one is a plausible mistake, not a nonsense value, and each is
 * asserted to be caught by a NAMED check. `spline-param` is what you get by
 * forgetting the arc-length table; `grid-yaw-only` is what you get by storing a
 * heading angle; `slow-locate` is what you get by scanning the centreline.
 */
function makeReferenceTrack(sabotage) {
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
  V.prototype.copy = function (v) {
    this.x = v.x
    this.y = v.y
    this.z = v.z
    return this
  }
  V.prototype.clone = function () {
    return new V(this.x, this.y, this.z)
  }
  const vec = () => new V(0, 0, 0)

  const R0 = 180
  const AMP = 0.45
  const LOBES = 3
  const ELEV = 6
  const TWO_PI = Math.PI * 2

  const rAt = (th) => R0 * (1 + AMP * Math.cos(LOBES * th))
  const r1At = (th) => -R0 * AMP * LOBES * Math.sin(LOBES * th)
  const r2At = (th) => -R0 * AMP * LOBES * LOBES * Math.cos(LOBES * th)

  function posAt(th, o) {
    const r = rAt(th)
    o.x = r * Math.cos(th)
    o.y = ELEV * Math.sin(2 * th)
    o.z = r * Math.sin(th)
    return o
  }

  // -- arc-length table ------------------------------------------------------
  const DENSE = 32768
  const cum = new Float64Array(DENSE + 1)
  {
    const a = vec()
    const b = vec()
    posAt(0, a)
    for (let i = 1; i <= DENSE; i++) {
      posAt((i / DENSE) * TWO_PI, b)
      cum[i] = cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
      a.x = b.x
      a.y = b.y
      a.z = b.z
    }
  }
  const LENGTH = cum[DENSE]

  /** s (metres) -> theta, by binary search on the cumulative table. */
  function thetaAtS(s) {
    let lo = 0
    let hi = DENSE
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (cum[mid] <= s) lo = mid
      else hi = mid
    }
    const span = cum[hi] - cum[lo] || 1
    return ((lo + (s - cum[lo]) / span) / DENSE) * TWO_PI
  }

  const wrap01 = (x) => x - Math.floor(x)
  /*
   * `spline-param`: use the raw curve parameter as if it were normalised
   * distance. Renders identically. Every lap time, checkpoint spacing and AI
   * corner-entry speed downstream of it is wrong.
   * `open-loop`: the map stops 3% short of the loop, so t=1 is not t=0.
   */
  function thetaOfT(t) {
    const u = wrap01(t)
    if (S === 'spline-param') return u * TWO_PI
    if (S === 'open-loop') return u * TWO_PI * 0.97
    return thetaAtS(u * LENGTH)
  }

  const halfWidthAtTheta = (th) => 8 + 1.5 * Math.sin(5 * th)

  function frameAt(th, out) {
    const r = rAt(th)
    const r1 = r1At(th)
    const r2 = r2At(th)
    const c = Math.cos(th)
    const s = Math.sin(th)
    const d1x = r1 * c - r * s
    const d1z = r1 * s + r * c
    const d1y = 2 * ELEV * Math.cos(2 * th)
    const d2x = r2 * c - 2 * r1 * s - r * c
    const d2z = r2 * s + 2 * r1 * c - r * s
    const d2y = -4 * ELEV * Math.sin(2 * th)
    const sp = Math.sqrt(d1x * d1x + d1y * d1y + d1z * d1z)
    const tx = d1x / sp
    const ty = d1y / sp
    const tz = d1z / sp

    // unbanked right = normalize(T x UP); unbanked normal = right x T
    let rx = tz * 1 - 0
    let ry = 0
    let rz = -tx
    // T x (0,1,0) = (Ty*0 - Tz*1, Tz*0 - Tx*0, Tx*1 - Ty*0) = (-Tz, 0, Tx)
    rx = -tz
    ry = 0
    rz = tx
    const rl = Math.hypot(rx, ry, rz) || 1
    rx /= rl
    ry /= rl
    rz /= rl
    let nx = ry * tz - rz * ty
    let ny = rz * tx - rx * tz
    let nz = rx * ty - ry * tx
    const nl = Math.hypot(nx, ny, nz) || 1
    nx /= nl
    ny /= nl
    nz /= nl

    // curvature vector = (d2 - T (T.d2)) / |d1|^2, signed on the unbanked right
    const td2 = tx * d2x + ty * d2y + tz * d2z
    const kx = (d2x - tx * td2) / (sp * sp)
    const ky = (d2y - ty * td2) / (sp * sp)
    const kz = (d2z - tz * td2) / (sp * sp)
    let curvature = kx * rx + ky * ry + kz * rz

    let bank = 0.25 * Math.tanh(curvature * 30)
    const reportedBank = bank
    if (S === 'bank-sign') bank = -bank
    const cb = Math.cos(bank)
    const sb = Math.sin(bank)

    out.position = out.position || vec()
    posAt(th, out.position)
    out.tangent.set(tx, ty, tz)
    // N' = N cos b + R sin b ; R' = R cos b - N sin b
    out.normal.set(nx * cb + rx * sb, ny * cb + ry * sb, nz * cb + rz * sb)
    out.right.set(rx * cb - nx * sb, ry * cb - ny * sb, rz * cb - nz * sb)
    if (S === 'skew-frame') {
      out.normal.set(out.normal.x + 0.02 * tx, out.normal.y + 0.02 * ty, out.normal.z + 0.02 * tz)
    }
    if (S === 'right-flip') out.right.set(-out.right.x, -out.right.y, -out.right.z)
    out.halfWidth = halfWidthAtTheta(th)
    out.bank = reportedBank
    out.curvature = S === 'curvature-sign' ? -curvature : curvature
    return out
  }

  function sample(t, out) {
    return frameAt(thetaOfT(t), out)
  }

  /*
   * -- centreline LUT + spatial hash for locate -----------------------------
   *
   * This is the shape `locate` has to have, and it is here because a number in a
   * comment is weaker evidence than a worked example. Three tiers:
   *
   *   fine LUT      8192 points uniform in arc length (0.19 m apart)
   *   coarse LUT    every 16th of those, bucketed into a uniform 2D grid
   *   query         grid lookup -> ~40 coarse distances -> 49 fine distances ->
   *                 one chord projection. Constant work, no dependence on P.
   *
   * The first draft refined with a 34-step golden-section search instead, which
   * cost 4.6 us per call and failed this file's own cost gate. That is the
   * failure the gate exists for, found on the harness's own reference before it
   * was ever pointed at anyone's track.
   */
  const P = 8192
  const STRIDE = 16
  const lut = { x: new Float64Array(P), y: new Float64Array(P), z: new Float64Array(P) }
  {
    const tmp = vec()
    for (let i = 0; i < P; i++) {
      posAt(thetaOfT(i / P), tmp)
      lut.x[i] = tmp.x
      lut.y[i] = tmp.y
      lut.z[i] = tmp.z
    }
  }
  const CELL = 16
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < P; i++) {
    if (lut.x[i] < minX) minX = lut.x[i]
    if (lut.x[i] > maxX) maxX = lut.x[i]
    if (lut.z[i] < minZ) minZ = lut.z[i]
    if (lut.z[i] > maxZ) maxZ = lut.z[i]
  }
  const GW = Math.ceil((maxX - minX) / CELL) + 3
  const GH = Math.ceil((maxZ - minZ) / CELL) + 3
  const buckets = new Array(GW * GH)
  for (let i = 0; i < P; i += STRIDE) {
    const cx = Math.min(GW - 1, Math.max(0, Math.floor((lut.x[i] - minX) / CELL) + 1))
    const cz = Math.min(GH - 1, Math.max(0, Math.floor((lut.z[i] - minZ) / CELL) + 1))
    const c = cz * GW + cx
    ;(buckets[c] || (buckets[c] = [])).push(i)
  }

  const scratchSample = {
    position: vec(),
    tangent: vec(),
    normal: vec(),
    right: vec(),
    halfWidth: 0,
    bank: 0,
    curvature: 0,
  }
  const CHECKPOINTS = (() => {
    const c = []
    for (let i = 0; i < 8; i++) c.push(i / 8)
    if (S === 'checkpoints-unsorted') {
      const tmp = c[3]
      c[3] = c[5]
      c[5] = tmp
    }
    return c
  })()

  function checkpointIndexAt(t) {
    let idx = 0
    for (let k = 0; k < CHECKPOINTS.length; k++) if (CHECKPOINTS[k] <= t) idx = k
    return idx
  }

  function locate(p, out) {
    if (S === 'slow-locate') {
      // The failure this exists to catch: an O(n) scan of the centreline.
      let bd = Infinity
      for (let i = 0; i < P; i++) {
        const d = (lut.x[i] - p.x) ** 2 + (lut.y[i] - p.y) ** 2 + (lut.z[i] - p.z) ** 2
        if (d < bd) bd = d
      }
    }
    let best = -1
    let bestD = Infinity
    const cx = Math.floor((p.x - minX) / CELL) + 1
    const cz = Math.floor((p.z - minZ) / CELL) + 1
    for (let ring = 1; ring < 40 && best < 0; ring++) {
      for (let dz = -ring; dz <= ring; dz++) {
        const z = cz + dz
        if (z < 0 || z >= GH) continue
        for (let dx = -ring; dx <= ring; dx++) {
          if (ring > 1 && Math.abs(dz) !== ring && Math.abs(dx) !== ring) continue
          const x = cx + dx
          if (x < 0 || x >= GW) continue
          const b = buckets[z * GW + x]
          if (!b) continue
          for (let k = 0; k < b.length; k++) {
            const i = b[k]
            const d = (lut.x[i] - p.x) ** 2 + (lut.y[i] - p.y) ** 2 + (lut.z[i] - p.z) ** 2
            if (d < bestD) {
              bestD = d
              best = i
            }
          }
        }
      }
    }
    if (best < 0) best = 0

    // Narrow from the coarse hit to the fine LUT: +/- 24 fine steps covers the
    // 1.5 m of arc the coarse argmin can be away from the true one.
    let fine = best
    let fineD = Infinity
    for (let k = -24; k <= 24; k++) {
      const i = (best + k + P) % P
      const d = (lut.x[i] - p.x) ** 2 + (lut.y[i] - p.y) ** 2 + (lut.z[i] - p.z) ** 2
      if (d < fineD) {
        fineD = d
        fine = i
      }
    }

    // Sub-segment: project onto the two chords either side of the fine argmin.
    let bestU = 0
    let bestBase = fine
    let bestSeg = Infinity
    for (const base of [(fine - 1 + P) % P, fine]) {
      const n = (base + 1) % P
      const ax = lut.x[base]
      const ay = lut.y[base]
      const az = lut.z[base]
      const ex = lut.x[n] - ax
      const ey = lut.y[n] - ay
      const ez = lut.z[n] - az
      const ee = ex * ex + ey * ey + ez * ez
      let u = ee > 0 ? ((p.x - ax) * ex + (p.y - ay) * ey + (p.z - az) * ez) / ee : 0
      if (u < 0) u = 0
      else if (u > 1) u = 1
      const qx = ax + ex * u - p.x
      const qy = ay + ey * u - p.y
      const qz = az + ez * u - p.z
      const d = qx * qx + qy * qy + qz * qz
      if (d < bestSeg) {
        bestSeg = d
        bestU = u
        bestBase = base
      }
    }
    let t = wrap01((bestBase + bestU) / P)
    frameAt(thetaOfT(t), scratchSample)
    const dx = p.x - scratchSample.position.x
    const dy = p.y - scratchSample.position.y
    const dz = p.z - scratchSample.position.z
    let lateral = dx * scratchSample.right.x + dy * scratchSample.right.y + dz * scratchSample.right.z
    const height = dx * scratchSample.normal.x + dy * scratchSample.normal.y + dz * scratchSample.normal.z

    if (S === 'locate-t-drift') t = wrap01(t + 0.004)
    if (S === 'locate-lateral-flip') lateral = -lateral

    out.t = t
    out.lateral = lateral
    out.height = height
    out.onTrack = Math.abs(lateral) <= scratchSample.halfWidth + 1.5
    out.checkpointIndex = checkpointIndexAt(t)
    return out
  }

  function surfaceAt(t, lateral) {
    const th = thetaOfT(t)
    const hw = halfWidthAtTheta(th)
    const a = Math.abs(lateral)
    if (S === 'surface-leak') return 1
    if (a > hw + 1.5) return 7 // OffTrack
    if (a > hw) return 5 // Gravel shoulder
    if (a > hw - 0.7) return 3 // Kerb
    const u = wrap01(t)
    if (u > 0.20 && u < 0.24) return 6 // BoostPad
    if (u > 0.55 && u < 0.62) return 2 // SandDrift
    if (u > 0.80 && u < 0.83) return 4 // Metal
    return 1 // DustyAsphalt
  }

  function racingLine(t) {
    frameAt(thetaOfT(t), scratchSample)
    const v = 0.62 * scratchSample.halfWidth * Math.tanh(scratchSample.curvature * 40)
    return S === 'racing-line-inverted' ? -v : v
  }

  // -- start grid ------------------------------------------------------------
  function quatFromFrame(right, normal, tangent) {
    // columns: X = right, Y = normal, Z = -tangent (WORLD_FORWARD is -Z)
    const m11 = right.x
    const m21 = right.y
    const m31 = right.z
    const m12 = normal.x
    const m22 = normal.y
    const m32 = normal.z
    const m13 = -tangent.x
    const m23 = -tangent.y
    const m33 = -tangent.z
    const tr = m11 + m22 + m33
    let x
    let y
    let z
    let w
    if (tr > 0) {
      const s = 0.5 / Math.sqrt(tr + 1)
      w = 0.25 / s
      x = (m32 - m23) * s
      y = (m13 - m31) * s
      z = (m21 - m12) * s
    } else if (m11 > m22 && m11 > m33) {
      const s = 2 * Math.sqrt(1 + m11 - m22 - m33)
      w = (m32 - m23) / s
      x = 0.25 * s
      y = (m12 + m21) / s
      z = (m13 + m31) / s
    } else if (m22 > m33) {
      const s = 2 * Math.sqrt(1 + m22 - m11 - m33)
      w = (m13 - m31) / s
      x = (m12 + m21) / s
      y = 0.25 * s
      z = (m23 + m32) / s
    } else {
      const s = 2 * Math.sqrt(1 + m33 - m11 - m22)
      w = (m21 - m12) / s
      x = (m13 + m31) / s
      y = (m23 + m32) / s
      z = 0.25 * s
    }
    return { x, y, z, w }
  }

  const startGrid = (() => {
    const slots = []
    const s = {
      position: vec(),
      tangent: vec(),
      normal: vec(),
      right: vec(),
      halfWidth: 0,
      bank: 0,
      curvature: 0,
    }
    for (let i = 0; i < 8; i++) {
      const row = Math.floor(i / 2)
      const side = i % 2 === 0 ? -1 : 1
      const back = 8 + row * 7
      const t = wrap01(-back / LENGTH)
      frameAt(thetaOfT(t), s)
      const lat = side * 2.6
      const pos = new V(
        s.position.x + s.right.x * lat,
        s.position.y + s.right.y * lat,
        s.position.z + s.right.z * lat,
      )
      let orientation
      if (S === 'grid-yaw-only') {
        // The mistake StartSlot's own comment warns about: a yaw scalar promoted
        // to a quaternion, which cannot express bank or slope.
        const yaw = Math.atan2(-s.tangent.x, -s.tangent.z)
        orientation = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }
      } else {
        orientation = quatFromFrame(s.right, s.normal, s.tangent)
      }
      slots.push({ position: pos, orientation, t })
    }
    if (S === 'grid-overlap') {
      slots[3].position.copy(slots[2].position)
    }
    return slots
  })()

  return {
    track: {
      length: LENGTH,
      group: { position: vec() },
      sample,
      locate,
      surfaceAt,
      racingLine,
      checkpoints: CHECKPOINTS,
      startGrid,
    },
    makeVec: vec,
  }
}

// ---------------------------------------------------------------------------
// Which check owns which sabotage
// ---------------------------------------------------------------------------
/*
 * The point of naming the owner is that "something went red" is not the same
 * evidence as "the detector for this failure fired". A sabotage caught only by a
 * neighbouring check means the detector we care about is inert and something
 * else happens to notice — which is exactly how the first smoke.mjs self-test
 * passed while proving nothing.
 */
const SABOTAGES = [
  ['spline-param', 'arc-length', 'parameterise by the raw curve parameter instead of arc length'],
  ['open-loop', 'closure', 'the t map stops 3% short, so t=1 is not t=0'],
  ['skew-frame', 'frame', 'normal picks up a component along the tangent'],
  ['right-flip', 'frame', 'right = -(tangent x normal)'],
  ['locate-t-drift', 'locate-inverse', 'locate returns t + 0.004 (about 5 m)'],
  ['locate-lateral-flip', 'signs', 'locate returns -lateral'],
  ['bank-sign', 'signs', 'the frame banks the opposite way from the reported bank'],
  ['curvature-sign', 'signs', 'curvature is reported negated'],
  ['slow-locate', 'locate-cost', 'locate scans the whole centreline'],
  ['checkpoints-unsorted', 'checkpoints', 'two checkpoints are out of order'],
  ['grid-yaw-only', 'start-grid', 'slot orientation is a yaw scalar promoted to a quaternion'],
  ['grid-overlap', 'start-grid', 'two slots share a position'],
  ['surface-leak', 'surfaces', 'surfaceAt never returns OffTrack'],
  ['racing-line-inverted', 'racing-line', 'the ideal line goes to the outside of every corner'],
]

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
const CHECK_ORDER = [
  'structure',
  'arc-length',
  'closure',
  'continuity',
  'frame',
  'locate-inverse',
  'signs',
  'locate-cost',
  'checkpoints',
  'start-grid',
  'surfaces',
  'racing-line',
]

function fmt(n, digits = 4) {
  if (n === null || n === undefined) return '-'
  if (!Number.isFinite(n)) return String(n)
  if (n !== 0 && (Math.abs(n) < 1e-3 || Math.abs(n) >= 1e6)) return n.toExponential(2)
  return n.toFixed(digits)
}

function summarise(c) {
  const m = c.metrics
  switch (c.id) {
    case 'structure':
      return `length ${fmt(m.length, 2)} m`
    case 'arc-length':
      return `step ${fmt(m.meanStepM)} m  worst dev ${(m.worstDeviation * 100).toFixed(3)}%  chord sum vs length ${(m.lengthErrorFrac * 100).toFixed(3)}%`
    case 'closure':
      return `seam step ${fmt(m.seamStepM)} m vs ${fmt(m.expectedStepM)} m expected  turn ${fmt(m.seamTurnDeg, 5)} deg  wrap ${fmt(m.worstWrapPosM)} m`
    case 'continuity':
      return `min radius ${fmt(m.minRadiusM, 2)} m  dk/ds ${fmt(m.maxCurvatureRate)}  dbank/ds ${fmt(m.maxBankRate)}  dw/ds ${fmt(m.maxWidthRate)}`
    case 'frame':
      return `unit ${fmt(m.worstUnitError)}  perp ${fmt(m.worstPerpDot)}  cross ${fmt(m.worstCrossError)}`
    case 'locate-inverse':
      return `${m.queries} queries  worst arc ${fmt(m.worstArcErrorM)} m  lateral ${fmt(m.worstLateralErrorM)} m  height ${fmt(m.worstHeightErrorM)} m`
    case 'signs':
      return `handedness ${m.handednessViolations ?? '-'}  lateral ${m.lateralSignViolations ?? '-'}  bank err ${fmt(m.worstBankSignError)}  curvature ${m.curvatureSignViolations ?? '-'}/${m.curvatureSamplesTested ?? '-'}`
    case 'locate-cost':
      return `locate ${fmt(m.locateNs, 0)} ns  sample ${fmt(m.sampleNs, 0)} ns  ${fmt(m.msPerSecondAtFullField, 3)} ms/s at full field  alloc ${m.bytesPerLocate === undefined ? 'unmeasured' : fmt(m.bytesPerLocate, 2) + ' B/call'}`
    case 'checkpoints':
      return `${m.count} checkpoints  min gap ${fmt(m.minGapM, 1)} m  max gap ${((m.maxGapFrac ?? 0) * 100).toFixed(1)}%  index mismatches ${m.indexDisagreements ?? '-'}`
    case 'start-grid':
      return `${m.count} slots  min sep ${fmt(m.minSeparationM, 2)} m  forward ${fmt(m.worstForwardDeg, 2)} deg  up ${fmt(m.worstUpDeg, 2)} deg`
    case 'surfaces':
      return `leaks ${m.offTrackLeaks}  shoulder reads OffTrack ${m.shoulderReadsOffTrack}/${m.shoulderProbes}  surfaces seen ${Object.keys(m.histogram ?? {}).map((k) => SURFACE_NAMES[k] ?? k).join(',')}`
    case 'racing-line':
      return `max |lateral| ${fmt(m.maxAbsLateralM, 2)} m  overhang ${fmt(m.worstOverhangM, 3)} m  r=${fmt(m.curvatureCorrelation, 3)} (best ${fmt(m.bestCorrelation, 3)} at lag ${((m.bestLagFrac ?? 0) * 100).toFixed(1)}%)`
    default:
      return ''
  }
}

function printReport(result) {
  const byId = new Map(result.checks.map((c) => [c.id, c]))
  let n = 0
  for (const id of CHECK_ORDER) {
    const c = byId.get(id)
    if (!c) continue
    n++
    console.log(`${c.status.padEnd(4)} ${String(n).padStart(2)}  ${c.id.padEnd(15)} ${summarise(c)}`)
    for (const p of c.problems) console.log(`        ${p.replace(/\n/g, '\n        ')}`)
    for (const note of c.notes) console.log(`        note: ${note.replace(/\n/g, '\n        ')}`)
  }
  return {
    failed: result.checks.filter((c) => c.status === 'FAIL'),
    pending: result.checks.filter((c) => c.status === 'PEND'),
  }
}

// ---------------------------------------------------------------------------
// The contract addition this file needs
// ---------------------------------------------------------------------------
const CONTRACT_ADDITION = `
  WHAT THIS HARNESS NEEDS, and why it is not inventing a way around it
  ────────────────────────────────────────────────────────────────────
  HarnessAPI has no route to ITrack. One line closes it:

      // src/types.ts, inside HarnessAPI
      /**
       * The live ITrack, by reference — not a snapshot.
       *
       * Every other method here returns a deep value copy because it reports
       * state that changes between the call and the assertion. A track does
       * not: it is built once and is immutable for the life of the world, so
       * the flakiness that rule exists to prevent cannot occur. And a copy
       * would defeat the point — locate's per-call cost and its
       * allocation-freedom are properties of the real function, and there is
       * no way to measure either through a serialised snapshot.
       *
       * It is the same object GameServices.track already hands to every
       * subsystem, so it widens no privilege that does not already exist.
       */
      readonly track: ITrack

  and one line wires it, in src/main.ts:

      get track(): ITrack { return trackSubsystem ?? notYet('track') }

  THE ALTERNATIVES, and why they lose
  · seek() + telemetry() round trips. Needs kart/, race/ and game/ before it
    measures anything, cannot see arc-length, frames, or per-call cost, and
    tests three subsystems at once so a failure names none of them.
  · Importing src/world/track.ts into the page directly. Works only on the dev
    server, so it measures a module graph players never run — the exact thing
    HarnessAPI's own docs say makes a harness meaningless. It also needs the
    factory's export name and a hand-built Ctx, which is depending on another
    agent's internals and duplicating the one authorised composition root.
  · A bundle of value-copy probes (trackSample/trackLocate/trackBenchmark).
    Three or four additions instead of one, and the benchmark one has to live
    in production code to be honest about cost.
`

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------
const CHECKER_SRC = checkTrack.toString()
const REFERENCE_SRC = makeReferenceTrack.toString()

/** Run the battery in the page, against either the live track or the reference. */
async function runIn(page, { reference }) {
  return page.evaluate(
    async ({ checkerSrc, refSrc, cfg, reference }) => {
      const checker = new Function('return (' + checkerSrc + ')')()
      if (reference !== null && reference !== undefined) {
        const build = new Function('return (' + refSrc + ')')()
        const { track, makeVec } = build(reference)
        return { source: 'reference:' + reference, result: checker(track, makeVec, cfg) }
      }

      const h = window.__harness
      if (!h) return { blocked: 'NO_HARNESS' }
      if (!('track' in h)) return { blocked: 'NO_TRACK_ON_HARNESS' }
      let track
      try {
        track = h.track
      } catch (err) {
        return { blocked: 'TRACK_PENDING', message: String((err && err.message) || err) }
      }
      if (!track) return { blocked: 'TRACK_NULL' }

      /*
       * Vector3 instances without importing three: ITrack.group is an Object3D
       * by contract, and every Object3D carries a Vector3 `position`. Cloning it
       * gives the harness real three vectors for the `out` objects that
       * sample() and locate() write into, with no build-time dependency and no
       * second entry in the contract.
       */
      let makeVec = null
      if (track.group && track.group.position && typeof track.group.position.clone === 'function') {
        makeVec = () => track.group.position.clone()
      } else if (track.startGrid && track.startGrid[0] && typeof track.startGrid[0].position?.clone === 'function') {
        makeVec = () => track.startGrid[0].position.clone()
      }
      if (!makeVec) return { blocked: 'NO_VECTOR_SOURCE' }

      return { source: 'window.__harness.track', result: checker(track, makeVec, cfg) }
    },
    { checkerSrc: CHECKER_SRC, refSrc: REFERENCE_SRC, cfg: CFG, reference: reference ?? null },
  )
}

/*
 * --expose-gc is what turns the allocation check from an opinion into a
 * measurement. Without it the run still works and reports the allocation
 * sub-check as PENDING rather than assuming it is fine.
 */
const GC_ARGS = ['--js-flags=--expose-gc']

async function main() {
  if (MODE === 'live') {
    const server = await startServer({ mode: useDev ? 'dev' : 'preview' })
    const browser = await launch({ timing: false, extraArgs: GC_ARGS })
    try {
      const { page } = await openGame(browser, server.url, { debug: 'frames', seed: 20260807 })
      const out = await runIn(page, { reference: null })

      if (out.blocked) {
        const why = {
          NO_HARNESS: 'window.__harness is absent — the game did not boot.',
          NO_TRACK_ON_HARNESS:
            'HarnessAPI has no `track` member. There is no route from a harness to ITrack, so this run ' +
            'validated NOTHING. That is reported as PENDING rather than passed, because a gate covering ' +
            'nothing prints the same green as a gate that passed.',
          TRACK_PENDING: `__harness.track exists and refused honestly: ${out.message}`,
          TRACK_NULL: '__harness.track returned null/undefined instead of throwing. It must refuse, not hand back a value it cannot know.',
          NO_VECTOR_SOURCE:
            'ITrack.track is present but neither `group.position` nor `startGrid[0].position` is a Vector3, ' +
            'so the harness cannot build the caller-owned TrackSample the contract requires.',
        }[out.blocked]

        console.log('track-check — ITrack invariants')
        console.log('')
        console.log(`PENDING  ${why}`)
        console.log('')
        console.log(`0 of ${CHECK_ORDER.length} invariants checked. Every one of them is a bug that is invisible in a frame:`)
        console.log('  arc-length, closure, continuity, frame orthonormality, locate-inverse, sign conventions,')
        console.log('  locate cost and allocation, checkpoints, start grid, surface zones, racing line.')
        if (out.blocked === 'NO_TRACK_ON_HARNESS' || out.blocked === 'TRACK_PENDING') {
          console.log(CONTRACT_ADDITION)
        }
        console.log('The instrument itself is proven: run `node tools/track-check.mjs --broken`.')
        console.log('')
        console.log('PENDING — exiting non-zero on purpose. Nothing was measured.')
        writeFileSync(path.join(OUT, 'track-check.json'), JSON.stringify({ mode: MODE, blocked: out.blocked }, null, 2))
        process.exitCode = 1
        return
      }

      console.log('track-check — ITrack invariants')
      console.log(`source  ${out.source}`)
      console.log('')
      const { failed, pending } = printReport(out.result)
      writeFileSync(path.join(OUT, 'track-check.json'), JSON.stringify({ mode: MODE, ...out }, null, 2))
      console.log('')
      if (pending.length) {
        console.log(`${pending.length} check(s) PENDING — reported, not skipped: ${pending.map((c) => c.id).join(', ')}`)
      }
      if (failed.length) {
        console.error(`FAIL — ${failed.length} invariant(s) violated: ${failed.map((c) => c.id).join(', ')}`)
        process.exitCode = 1
      } else if (pending.length) {
        console.log('No violations, but coverage is incomplete. Not a pass.')
        process.exitCode = 1
      } else {
        console.log('PASS — every ITrack invariant holds.')
      }
    } finally {
      await browser.close()
      await server.stop()
    }
    return
  }

  /*
   * reference and --broken need no server and no game: they grade an ITrack
   * built in the page. That is deliberate — a self-test that can only run once
   * the subsystem it guards exists is unavailable during exactly the window
   * when the instrument is unproven.
   */
  const browser = await launch({ timing: false, extraArgs: GC_ARGS })
  try {
    const page = await browser.newPage()
    await page.goto('about:blank')

    console.log('track-check — self-test against a reference ITrack')
    console.log('')
    const clean = await runIn(page, { reference: 'none' })
    console.log('reference (unsabotaged)')
    const { failed, pending } = printReport(clean.result)
    console.log('')

    if (failed.length) {
      console.error(
        `SELF-TEST FAILED — the clean reference violated ${failed.length} check(s): ` +
          `${failed.map((c) => c.id).join(', ')}.\n` +
          `Either a limit in CFG is wrong or a detector is. Until this is green the instrument's verdicts on a\n` +
          `real track mean nothing, because it has been shown to fail something correct.`,
      )
      process.exitCode = 1
      return
    }
    const unmeasured = pending.filter((c) => c.id !== 'locate-cost')
    if (unmeasured.length) {
      console.error(`SELF-TEST FAILED — the clean reference left ${unmeasured.map((c) => c.id).join(', ')} PENDING; the reference is meant to exercise every check.`)
      process.exitCode = 1
      return
    }
    if (MODE === 'reference') {
      console.log('PASS — the reference ITrack satisfies every invariant.')
      return
    }

    console.log('sabotages — each must be caught by the check that owns it')
    console.log('')
    const misses = []
    const rows = []
    for (const [name, owner, description] of SABOTAGES) {
      const out = await runIn(page, { reference: name })
      const byId = new Map(out.result.checks.map((c) => [c.id, c]))
      const target = byId.get(owner)
      const caught = target && target.status === 'FAIL'
      const collateral = out.result.checks.filter((c) => c.status === 'FAIL' && c.id !== owner).map((c) => c.id)
      rows.push({ name, owner, caught, collateral })
      console.log(
        `${caught ? 'CAUGHT' : 'MISSED'}  ${name.padEnd(21)} -> ${owner.padEnd(15)} ${description}` +
          (collateral.length ? `\n                                                also red: ${collateral.join(', ')}` : ''),
      )
      if (caught) {
        console.log(`                               ${target.problems[0].split('\n')[0].slice(0, 150)}`)
      } else {
        misses.push(`${name}: ${owner} stayed ${target ? target.status : 'absent'}`)
      }
    }

    // The blocked paths are part of the instrument too: a missing ITrack must
    // read as PENDING, never as a pass.
    const stub = await page.evaluate(
      ({ checkerSrc, cfg }) => {
        const checker = new Function('return (' + checkerSrc + ')')()
        function V() {
          this.x = 0
          this.y = 0
          this.z = 0
        }
        const half = { length: 100, group: {}, checkpoints: [], startGrid: [] }
        return checker(half, () => new V(), cfg)
      },
      { checkerSrc: CHECKER_SRC, cfg: CFG },
    )
    const stubGreen = stub.checks.filter((c) => c.status === 'PASS' && c.id !== 'structure')
    console.log('')
    if (stubGreen.length) {
      misses.push(`an ITrack missing sample/locate/surfaceAt/racingLine still passed: ${stubGreen.map((c) => c.id).join(', ')}`)
      console.log(`MISSED  empty-itrack        -> ${stubGreen.map((c) => c.id).join(', ')} reported PASS on a track with no methods`)
    } else {
      console.log('CAUGHT  empty-itrack        -> every check reported PEND or FAIL; none reported PASS')
    }

    /*
     * The extraction path is part of the instrument too, and it is the part that
     * only ever runs against a real game. Exercise it here by installing a
     * `window.__harness` with the reference behind it: once as a member that
     * refuses honestly, and once live. Without this, the code that reaches
     * ITrack — the bit that must work on the day world/ lands — would be the
     * only thing in the file nobody had watched succeed or fail.
     */
    console.log('')
    const install = (mode) =>
      page.evaluate(
        ({ refSrc, mode }) => {
          const build = new Function('return (' + refSrc + ')')()
          if (mode === 'refuse') {
            window.__harness = {
              get track() {
                throw new Error('[harness] track is not available yet — the subsystem that provides it has not been built.')
              },
            }
          } else if (mode === 'absent') {
            window.__harness = { version: 2 }
          } else {
            window.__harness = { track: build('none').track }
          }
        },
        { refSrc: REFERENCE_SRC, mode },
      )

    await install('absent')
    const absent = await runIn(page, { reference: null })
    await install('refuse')
    const refused = await runIn(page, { reference: null })
    await install('live')
    const live = await runIn(page, { reference: null })

    const liveFailed = live.result ? live.result.checks.filter((c) => c.status !== 'PASS') : null
    for (const [label, ok, detail] of [
      ['harness without `track`', absent.blocked === 'NO_TRACK_ON_HARNESS', `got ${absent.blocked ?? 'a result'}`],
      ['`track` that refuses honestly', refused.blocked === 'TRACK_PENDING', `got ${refused.blocked ?? 'a result'}`],
      [
        'live `track` on __harness',
        !live.blocked && liveFailed && liveFailed.length === 0,
        live.blocked ? `blocked: ${live.blocked}` : `not green: ${(liveFailed ?? []).map((c) => c.id).join(', ')}`,
      ],
    ]) {
      console.log(`${ok ? 'CAUGHT' : 'MISSED'}  ${'extraction'.padEnd(21)} -> ${label}${ok ? '' : ` — ${detail}`}`)
      if (!ok) misses.push(`extraction path, ${label}: ${detail}`)
    }

    writeFileSync(path.join(OUT, 'track-check-selftest.json'), JSON.stringify({ rows, misses }, null, 2))
    console.log('')
    if (misses.length) {
      console.error(`SELF-TEST FAILED — ${misses.length} sabotage(s) were not caught by their own detector:`)
      for (const m of misses) console.error(`  ${m}`)
      console.error('A detector that only goes red because a neighbour noticed is inert. Fix it before trusting a verdict.')
      process.exitCode = 1
    } else {
      console.log(`SELF-TEST PASSED — the reference passes clean, and all ${SABOTAGES.length} sabotages were caught by their owning check.`)
    }
  } finally {
    await browser.close()
  }
}

await main()
