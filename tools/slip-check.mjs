/**
 * DOES THE KART STAY POINTED WHERE IT IS GOING, OVER A LONG RUN?
 *
 *   node tools/slip-check.mjs              # gate the live build
 *   node tools/slip-check.mjs --broken     # self-test: prove every detector fires
 *   node tools/slip-check.mjs --reference  # run the battery on the built-in reference only
 *   node tools/slip-check.mjs --seconds=60 # longer cruise
 *   node tools/slip-check.mjs --stride=2   # sample every 2nd tick (cheaper, coarser)
 *
 * WHY THIS FILE EXISTS AND WHY NOTHING ELSE IN THE REPO ANSWERS IT
 * ---------------------------------------------------------------
 * A human played the build and reported that after some seconds of driving the
 * kart "slides — the whole body slides", possibly while the road curves away.
 * Every instrument already here is blind to that:
 *
 *   steer-test.mjs   probes for 90 ticks — 0.75 s — and 36 ticks for the AI. A
 *                    divergence that needs five seconds to become visible is not
 *                    merely missed, it is *below the resolution* of the probe.
 *   autoplay.mjs     grades OUTCOMES: lap times, drift tiers, finishing. A kart
 *                    that slides its way round at a consistent lap time passes.
 *   smoke/energy/fps grade pixels and milliseconds.
 *
 * So this file drives one kart, under scripted commands of its own making, for
 * 30+ seconds of simulated time, records the state every tick, and asks four
 * questions that only a long run can answer:
 *
 *   1. SLIP ANGLE — the angle between chassis forward and the velocity vector.
 *      A kart cornering has some, legitimately. A kart that is sliding has a lot,
 *      or has it while going straight.
 *   2. LATERAL OFFSET from the centreline — and whether it walks away
 *      monotonically rather than oscillating around a line.
 *   3. onTrack AND THE REPORTED Surface — a grip change explains a slide; a
 *      *wrong* surface report explains it differently, and the two want telling
 *      apart before anyone touches the tyre model.
 *   4. WHETHER IT CORRELATES WITH CURVATURE. Slip in a corner is expected. Slip
 *      on a straight is not. Reported in separate bins, because one pooled
 *      number over a circuit that is half corners means nothing at all.
 *
 * THE HARD PART IS THE THRESHOLD, AND IT IS NOT INVENTED HERE
 * ----------------------------------------------------------
 * "5 degrees of slip is too much" is not a measurement, it is a preference. This
 * file refuses to gate on a number somebody liked. It gates on THREE things, in
 * this order, and says which one bound:
 *
 *   a. THE VEHICLE'S OWN COMPLIANCE. From the CORNER bin of the same run it
 *      computes  c = median|slip| / median(lateral acceleration demand)  — how
 *      many degrees of body slip this kart spends per m/s² of cornering. That is
 *      a property of the tyre model, measured, not assumed. The STRAIGHT bin's
 *      demand is then multiplied through the same c to predict what slip a
 *      straight legitimately costs. On a straight the demand is near zero, so
 *      the prediction is near zero, and the gate is the prediction times a
 *      tolerance.
 *   b. A NOISE FLOOR beneath it, so a gate is never quoted against zero.
 *      `slipFloorDeg` is the arithmetic floor; the run-to-run repeat spread is
 *      measured separately and must be exactly zero on a fixed-step sim.
 *   c. AN ABSOLUTE RAIL above it. Self-calibration has one blind spot and it is
 *      the important one: a kart that slides UNIFORMLY, corners and straights
 *      alike, has a huge c and therefore a huge predicted straight-line slip, so
 *      (a) alone would licence exactly the failure being hunted. The rail caps
 *      the derived gate. It is a guess and is labelled one.
 *
 * Every constant in `CFG` below is labelled DERIVED — with the derivation
 * written out — or `guess`, said plainly. That is the house style set by
 * `tools/steer-test.mjs` and it exists because a threshold whose provenance
 * nobody recorded gets "tuned" the first time it is inconvenient.
 *
 * WHY THE COMMANDS ARE OURS AND NOT THE REFERENCE AI'S
 * ---------------------------------------------------
 * `src/game/ai.ts` is known-red on `steer-test`'s checks 7 and 8 — it steers the
 * wrong way from one side of the racing line. A long run driven by it would
 * leave the road and this file would faithfully measure that instead. So the
 * cruise is driven by a pure-pursuit controller written HERE, in this file,
 * against the centreline, holding a lateral-acceleration budget so the tyres are
 * never asked for the limit. If the tyres are never asked for the limit and the
 * kart still slides, the slide is not the driver's.
 *
 * That controller is also why `driving` is its own check. A controller that
 * cannot hold the road produces slip numbers about a controller. `driving`
 * grades the run before any slip number is quoted, and its failure message says
 * out loud that the fault could be either side and how to tell.
 *
 * THE TRAP THIS FILE WAS WARNED ABOUT, GUARDED RATHER THAN REMEMBERED
 * ------------------------------------------------------------------
 * `HarnessAPI.seek`'s `lateral` is RELATIVE TO THE RACING LINE — `src/main.ts`
 * hands `racingLine(t) + lateral` to `IKart.placeAt`, whose own contract is
 * centreline-relative. That is undocumented in `src/types.ts`, and reading it
 * the other way once cost this project a round: `steer-test.mjs` added the line
 * a second time and placed a kart 22.6 m across a 14.0 m half-width road.
 *
 * This file needs the centreline, so it passes `lateral: -racingLine(t)`. Being
 * right about that by memory is not good enough, so `placement` is a check: it
 * seeks at the point on the lap where |racingLine| is LARGEST — where a doubled
 * application is most visible — and asserts the kart landed within a tick of
 * travel of the centreline. It reports the size of the racing line there, so a
 * reader can see whether the test had any teeth. `--broken` includes a
 * `seek-double-racing-line` sabotage that does exactly the round-costing thing.
 *
 * OTHER KARTS ARE ON THE CIRCUIT AND THEY ARE PART OF THE MEASUREMENT PROBLEM
 * --------------------------------------------------------------------------
 * `seek` scatters the rest of the field evenly around the lap and idles it —
 * correct for a 0.75 s probe, ruinous for a 40 s one, because the kart under
 * test drives into a parked car after an eighth of a lap. So the cruise does not
 * seek at all: it `resetRace`s with every other kart set to `'idle'`, which
 * parks the whole field on the start grid in one place, and drives away from
 * it. Ticks spent within `neighbourExclusionM` of any other kart — measured
 * from every kart's `t` as `telemetry()` reports it, never assumed from where
 * `resetRace` is thought to put them — are excluded from every statistic, and
 * the count is printed alongside every other exclusion. A filter that quietly
 * removes most of a run is a filter that manufactures a pass.
 *
 * SELF-TEST. `--broken` needs no game and no server. It builds a reference world
 * in the page: a stadium circuit, and a kart that is a REAL single-track
 * bicycle model with linear tyres, so its body slip angle is a genuine physical
 * output — near zero on the straights, a few degrees in the bends — rather than
 * a number this file gets to choose. Then ten sabotages, each owned by one named
 * check, each asserted to produce the STATUS it should (two must produce PENDING
 * rather than FAIL — a missing measurement and a failed one are different
 * findings). One of the ten is a DECOY: `soft-tyres` halves the cornering
 * stiffness so the kart legitimately corners at six degrees of slip, and NOTHING
 * may go red. A slip harness that cannot tell hard cornering from sliding is
 * worse than none, and that is not something to assert — it is something to
 * watch hold.
 */

import path from 'node:path'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { ROOT, startServer } from './vite-server.mjs'
import { launch, openGame } from './lib/browser.mjs'

const args = process.argv.slice(2)
const MODE = args.includes('--broken') ? 'broken' : args.includes('--reference') ? 'reference' : 'live'
const useDev = args.includes('--dev')
const argNum = (name, dflt) => {
  const a = args.find((x) => x.startsWith(`--${name}=`))
  const v = a ? Number(a.slice(name.length + 3)) : NaN
  return Number.isFinite(v) ? v : dflt
}

const OUT = path.join(ROOT, 'tools', 'out')
mkdirSync(OUT, { recursive: true })

// ---------------------------------------------------------------------------
// Contract constants, re-derived from the contract rather than remembered
// ---------------------------------------------------------------------------
/*
 * Same discipline as `steer-test.mjs`: a harness that hardcodes 1/120 keeps
 * reporting degrees-per-second after somebody moves the tick rate, silently. If
 * a parse fails this file refuses to run rather than measuring against a value
 * it cannot confirm.
 *
 * Surface ordinals and the grip column are parsed too, and for a sharper
 * reason than tidiness: this file's surface check compares two independent
 * routes to "what am I driving on" and only cares about a disagreement that
 * CHANGES GRIP. Kerb vs Asphalt is cosmetic; DustyAsphalt vs SandDrift is 0.88
 * against 0.62 and is an explanation for a slide.
 */
const TYPES_PATH = path.join(ROOT, 'src', 'types.ts')
const typesSrc = readFileSync(TYPES_PATH, 'utf8')

function refuse(what) {
  console.error(
    `FAIL  cannot read ${what} out of ${TYPES_PATH}.\n` +
      `      This harness re-derives the contract's constants instead of remembering them.\n` +
      `      Refusing to run against a value it cannot confirm.`,
  )
  process.exit(1)
}

function ratioFromContract(re, what) {
  const m = typesSrc.match(re)
  const num = m ? Number(m[1]) : NaN
  const den = m && m[2] !== undefined ? Number(m[2]) : 1
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) refuse(what)
  return num / den
}

const SIMULATION_STEP = ratioFromContract(
  /SIMULATION_STEP\s*:\s*Seconds\s*=\s*([\d.]+)(?:\s*\/\s*([\d.]+))?/,
  'SIMULATION_STEP',
)
const BARRIER_MARGIN = ratioFromContract(
  /BARRIER_MARGIN\s*:\s*Metres\s*=\s*([\d.]+)(?:\s*\/\s*([\d.]+))?/,
  'BARRIER_MARGIN',
)

/** name -> ordinal, straight out of `export enum Surface`. */
const SURFACE = {}
{
  const block = typesSrc.match(/export enum Surface \{([\s\S]*?)\n\}/)
  if (!block) refuse('the Surface enum')
  for (const m of block[1].matchAll(/^\s*(\w+)\s*=\s*(\d+),/gm)) SURFACE[m[1]] = Number(m[2])
  if (Object.keys(SURFACE).length < 2) refuse('the Surface enum members')
}
/** ordinal -> grip, straight out of SURFACE_PROPS. */
const GRIP = {}
{
  for (const m of typesSrc.matchAll(/\[Surface\.(\w+)\]:\s*\{\s*grip:\s*([\d.]+)/g)) {
    if (SURFACE[m[1]] === undefined) refuse(`SURFACE_PROPS names Surface.${m[1]}, which the enum does not`)
    GRIP[SURFACE[m[1]]] = Number(m[2])
  }
  if (Object.keys(GRIP).length !== Object.keys(SURFACE).length) refuse('a grip for every Surface member')
}

/*
 * The marker `src/main.ts` throws for a surface that does not exist yet.
 * `tools/contract-check.mjs` keys on the same literal; if it moves, both files
 * start reporting a real method as broken rather than pending.
 */
const PENDING_MARKER = 'is not available yet'

// ---------------------------------------------------------------------------
// Limits. DERIVED or guess, marked per line, derivation written out.
// ---------------------------------------------------------------------------
const CFG = {
  simStep: SIMULATION_STEP,
  barrierMargin: BARRIER_MARGIN,
  surface: SURFACE,
  grip: GRIP,
  pendingMarker: PENDING_MARKER,
  seed: 20260807,

  /*
   * DERIVED from the question. The reported symptom is "after some seconds of
   * driving", and the longest existing probe in the repo is 0.75 s, so anything
   * under a few seconds reproduces the blind spot rather than filling it. 40 s
   * is 4800 ticks; at the speeds below it covers 600-900 m, which on a ~1.2 km
   * circuit is most of a lap and therefore several corners and both directions
   * of turn. It is deliberately SHORTER than one lap: coming back round to the
   * parked field would put a collision inside the measurement.
   */
  runSeconds: argNum('seconds', 40),
  /*
   * DERIVED. The determinism floor does not need its own long run — a wall clock
   * reaching `fixedUpdate` or a `Math.random()` outside `ctx.rngFor` perturbs the
   * very first ticks, and 10 s is 1200 independent opportunities to differ. The
   * repeat is compared against the FIRST 10 s OF THE CRUISE ITSELF rather than
   * against a separate short run, so what is proven to repeat is the actual
   * measurement, not a cousin of it.
   */
  determinismSeconds: 10,
  /** Ticks advanced per sample. 1 = every tick, which is the default and the
   *  point; larger is a cost lever, and the report states what was used. */
  stride: Math.max(1, Math.round(argNum('stride', 1))),
  /*
   * guess, and a well-founded one: 30 Hz is roughly a human's steering
   * bandwidth, and a controller that re-decides every 8.3 ms would be flattering
   * the vehicle in a way no player ever does. It also keeps `setInput` off the
   * per-tick path.
   */
  controlEveryTicks: 4,

  // -- how the cruise is driven ---------------------------------------------
  /*
   * guess: 8 m/s² is 0.82 g. The whole design of this probe is that the tyres
   * are never asked for the limit — the cruise picks its speed from
   * v = sqrt(budget / |curvature|) so the lateral demand is capped here
   * everywhere on the lap. If a kart slides while never being asked for more
   * than 0.82 g on a 0.88-grip road, the slide is not the driver's fault. Raise
   * this and the probe stops being able to make that argument.
   */
  latAccelBudget: 8,
  /** guess. Fast enough that the tyres are doing real work, slow enough that a
   *  simple pursuit controller is stable. */
  speedMax: 24,
  /** guess. A floor so the cruise does not crawl through the tightest bend. */
  speedMin: 7,
  /** guess. Pure pursuit looks ~0.7 s down the road; shorter oscillates, longer
   *  cuts corners. `lookAheadMinM` keeps it sane at low speed. */
  lookAheadSeconds: 0.7,
  lookAheadMinM: 8,
  /** guess. How far ahead the speed target looks for the worst curvature, so
   *  the kart slows BEFORE the corner rather than in it. */
  brakeLookSeconds: 1.5,
  /** guess. Proportional gain on the pursuit angle. */
  steerGain: 1.6,
  /** guess. Dead band around the speed target, in m/s. */
  speedBandMs: 1.0,
  brakeStrength: 0.5,

  // -- binning ---------------------------------------------------------------
  /*
   * DERIVED. A "straight" is a piece of road whose own geometry demands
   * essentially no lateral force. At the `speedMax` cap, radius 400 m demands
   * v²/R = 1.44 m/s², which is 0.15 g and 18% of the budget above — an order
   * below what the corner bin sees. Anything tighter is a corner and is graded
   * as one.
   */
  straightCurvature: 1 / 400,
  /*
   * DERIVED. Corner exit is a transient: the yaw rate and the tyre lateral
   * forces have to unwind, and for that window the kart legitimately still has
   * slip on nominally straight road. A single-track vehicle's yaw mode settles
   * in a few tenths of a second; 0.5 s is generous. Ticks inside it are binned
   * `transition` and REPORTED, never pooled into either gate — silently pooling
   * them into `straight` is how a harness invents a slip problem out of correct
   * physics.
   */
  settleSeconds: 0.5,
  /*
   * DERIVED. `atan2` of a velocity vector shorter than this is an angle computed
   * from numerical dust: at 3 m/s a 1 cm/s lateral component is already 0.2°,
   * and below it the number swings freely with no physical meaning.
   */
  speedFloor: 3,
  /** DERIVED. A respawn teleports the kart; the tick that spans a teleport shows
   *  an enormous fake slip. One second either side is discarded and counted. */
  respawnBlankSeconds: 1,
  /*
   * guess. Karts left parked on the grid are obstacles. 15 m of track distance
   * is a couple of car lengths plus the length of a kart, and it is measured
   * against every other kart's `t` as `telemetry()` reports it rather than
   * against an assumption about where `resetRace` put them.
   */
  neighbourExclusionM: 15,
  /*
   * DERIVED. A sample whose position moved further than `speed * dt * 3` did not
   * get there by driving. That is a teleport — a respawn, a seek, or a collision
   * resolution shoving the body — and the slip computed across it is fiction.
   */
  jumpFactor: 3,

  // -- the slip gate ---------------------------------------------------------
  /*
   * guess. The arithmetic floor under the self-calibrated gate, so a straight
   * whose predicted slip is 0.02° does not produce a gate of 0.06° and fail a
   * healthy kart on suspension jitter. A chassis with independent suspension and
   * load transfer wanders a degree or so about its own heading over bumps
   * without anything being wrong. This is the number most likely to need moving
   * once real numbers exist, and it is the one to move — not the rail.
   */
  slipFloorDeg: 1.5,
  /*
   * guess. How far above the vehicle's OWN measured compliance a straight-line
   * slip may sit before it is called a slide. Three is the same order as the 4x
   * §10c uses for a margin over a noise floor, relaxed by one because the
   * denominator here is a physical prediction rather than a repeat spread.
   */
  slipComplianceMultiple: 3,
  /*
   * guess, and the most load-bearing one on the page. It caps the
   * self-calibrated gate, because self-calibration is blind to exactly the
   * failure being hunted: a kart sliding uniformly everywhere has a huge
   * compliance and would licence its own straight-line slide. 8° is chosen
   * because the game has a DRIFT SYSTEM — a deliberate, player-triggered,
   * tier-scoring state whose whole purpose is large slip angles. A kart holding
   * more than 8° on a straight, with drift inactive, is doing uncommanded what
   * the game makes a mechanic out of doing on purpose.
   */
  slipAbsoluteMaxDeg: 8,
  /** guess. The p95 may sit this multiple above the median gate; a distribution
   *  with a healthy median and a p95 four times it is not "a bit of slip". */
  slipP95Multiple: 2,
  /*
   * DERIVED, and not a taste judgement. Past 45° the velocity vector is more
   * sideways than forward: the kart is no longer travelling in the direction it
   * is pointed in any useful sense, no corner can be driven through it, and the
   * lap is over. This is the only gate on the CORNER bin, because how much slip
   * a corner legitimately costs is precisely what this file measures rather than
   * assumes.
   */
  spinDeg: 45,
  /*
   * guess. `DriftState.slipAngle` is contractually "Angle between chassis
   * forward and velocity" — the same quantity this file computes independently
   * from `KartState.velocity` and `KartState.quaternion`. They should agree.
   * 3° of p95 disagreement allows for a different filter or a different
   * reference frame; a larger gap means one of the two is measuring something
   * else, and a wrong slip report drives the drift system, the spark rate and
   * anyone's diagnosis of this very bug.
   */
  slipAgreeDeg: 3,

  // -- is there enough run to grade -----------------------------------------
  /*
   * DERIVED. 240 ticks is 2 s. A gate quoted over less than that is quoting a
   * transient. Below it the check reports PENDING — it measured nothing, and a
   * gate that quietly covers nothing prints the same green as one that passed.
   */
  minBinTicks: 240,
  /** guess. Below this the scripted controller did not keep the kart on the
   *  road, and `driving` says so before any slip number is quoted. */
  minOnTrackFrac: 0.85,
  /** guess. Fraction of the distance the cruise should have covered at its own
   *  commanded speed. Well under 1 to allow for the standing start. */
  minDistanceFrac: 0.4,
  /** guess. Fraction of control updates whose commanded steer must actually
   *  arrive at the kart, read back through `HarnessAPI.lastInput`. */
  maxInputMismatchFrac: 0.25,
  /*
   * guess on the fraction, DERIVED on the rule. When this file commands a steer
   * of real size, `wheels[].steerAngle` — "Steer angle applied to this wheel" —
   * must be non-zero. There is no state of a working kart in which a commanded
   * steer produces exactly zero at the wheel. 0.9 rather than 1.0 only because
   * `stunTime > 0` legitimately forces steer to zero, and a bump on a kerb can
   * stun a kart mid-run.
   */
  minWheelObservedFrac: 0.9,
  /** guess. Large enough that no dead band or rounding can eat it, short of full
   *  lock so a clamp cannot be mistaken for a discarded command. */
  commandProbeSteer: 0.8,
  /** DERIVED: 12 ticks is 0.10 s, several times any plausible steering-rate
   *  filter, and short enough not to drive the kart off the grid straight. */
  commandProbeTicks: 12,
  /** DERIVED: 60 ticks is 0.5 s of full throttle, enough to leave a standstill —
   *  an implementation is not obliged to apply a steer angle at zero speed. */
  commandProbeSpinUpTicks: 60,

  // -- wheel contact ---------------------------------------------------------
  /*
   * DERIVED on the direction, guess on the number. On FLAT, LEVEL, STRAIGHT road
   * nothing launches a kart: there is no jump, no crest, and lateral load
   * transfer needs lateral acceleration, which a straight does not demand. Zero
   * wheels in contact there is not a tolerance question. 1% rather than 0%
   * allows for a kerb strip or the roughness `SurfaceProps` gives every surface
   * (0.01-0.12 m of chassis perturbation), which can genuinely unload a wheel
   * for a tick.
   */
  maxAirborneFrac: 0.01,
  /*
   * guess. Mean wheels in contact across settled straight ticks. Four is the
   * physical answer; 3.5 leaves a wheel unloaded an eighth of the time for
   * roughness before anything is said. A kart that cannot keep its tyres on a
   * flat road has no grip to corner with, and NO SLIP-ANGLE GATE ON THIS PAGE
   * WOULD NECESSARILY NOTICE — a kart with 40% of its grip still corners, just
   * badly and wide. That is why this check exists separately and is not folded
   * into the slip gates.
   */
  minMeanGroundedWheels: 3.5,

  // -- monotone lane drift ---------------------------------------------------
  /*
   * guess on the fraction, DERIVED on the pair. "Drifting monotonically rather
   * than oscillating around a line" is two claims and needs both: the lateral
   * offset kept the same sign for essentially the whole run AND it moved further
   * than a road half-width in that one direction. Either alone is innocent — a
   * controller can sit at a small steady offset forever (sign-consistent, no
   * travel), and a kart can swing a half-width and come back (travel, no
   * consistency).
   */
  laneSignConsistency: 0.98,

  /*
   * DERIVED: 36 ticks is exactly the window `steer-test.mjs` gives its AI probe,
   * and 90 ticks is its chassis probe. The slip measured inside those two
   * windows is reported next to the slip measured over the whole run, so the
   * claim "a short probe cannot see this" is a number on the page rather than an
   * assertion in a comment. `--broken`'s `slip-ramps` sabotage asserts it.
   */
  shortProbeTicks: 36,

  // -- the seek placement guard ---------------------------------------------
  /*
   * DERIVED. `seek` runs one tick before returning, so the kart has already
   * travelled `speed * simStep` — 0.17 m at 20 m/s — before anything can be
   * measured, essentially all of it forward. 0.35 m is twice that, and still an
   * order below the racing-line offsets a doubled application would produce.
   */
  placementToleranceM: 0.35,
  /** guess. Below this the racing line is not far enough off the centreline for
   *  a doubled application to be visible, so the check reports PENDING rather
   *  than a pass it did not earn. */
  minRacingLineForPlacementM: 0.5,

  // -- the open-loop hold ----------------------------------------------------
  /** guess. Long enough for a slow divergence to show, short enough to stay
   *  inside a straight. Clamped at run time by how long the straight is. */
  holdMaxSeconds: 4,
  /** guess. Under this the hold has not outlived the transient from the seek. */
  holdMinSeconds: 1.5,
  /** guess. The same order as the cruise, so the two are comparable. */
  holdSpeed: 20,

  /** DERIVED: a deterministic fixed-step sim repeats bit for bit, so the measured
   *  repeat spread should be 0. This is only the guard against dividing by it. */
  epsilonM: 1e-4,
  epsilonDeg: 1e-6,
  /** DERIVED: the countdown is 3 s (§ GameEvents race:countdown 3/2/1/0); 1200
   *  ticks is 10 s, so a build that never reaches 'racing' is a real fault. */
  phaseTicksMax: 1200,

  gravity: 9.81,
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
 * the same trick `track-check.mjs` and `steer-test.mjs` use, and for the same
 * reason: no build-time dependency and no second entry in the contract.
 */
async function battery(CFG) {
  const R = { checks: [], info: {}, missing: [], broke: [] }
  const checks = R.checks
  const MARKER = CFG.pendingMarker
  const DEG = 180 / Math.PI

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

  // -- small statistics, written out because the page has none ---------------
  const sorted = (a) => Array.prototype.slice.call(a).sort((x, y) => x - y)
  function quantile(s, q) {
    if (!s.length) return null
    const i = (s.length - 1) * q
    const lo = Math.floor(i)
    const hi = Math.ceil(i)
    return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo)
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)

  // =========================================================================
  // surface — what this needs, and what refused
  // =========================================================================
  /*
   * Probed by CALLING, not by `typeof`. `src/main.ts` declares every method the
   * contract lists and throws the pending marker from the ones that do not
   * exist yet, so presence proves nothing. Anything throwing something OTHER
   * than the marker is a genuine breakage and is reported separately — that
   * distinction is the whole value of the marker.
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
    const t = h.track
    for (const m of ['sample', 'locate', 'surfaceAt', 'racingLine']) {
      if (typeof t[m] !== 'function') throw new Error(`present but not an ITrack (needs ${m})`)
    }
  })
  await probe('playerKartId', () => {
    if (typeof h.playerKartId !== 'number') throw new Error(`playerKartId is ${typeof h.playerKartId}, not a number`)
  })
  await probe('telemetry', () => {
    const t = h.telemetry()
    if (!t || !Array.isArray(t.karts)) throw new Error('telemetry() did not return a RaceTelemetry with a karts array')
  })
  await probe('resetRace', () => h.resetRace())
  await probe('startRace', () => h.startRace())
  await probe('setDriver', () => h.setDriver(have.playerKartId ? h.playerKartId : 0, 'scripted'))
  await probe('setInput', () => h.setInput({ steer: 0, throttle: 0, brake: 0, drift: false, useItem: false, look: 0 }))
  await probe('stepTicks', () => h.stepTicks(1))
  await probe('seek', () => h.seek({ t: 0 }))
  await probe('kartSnapshot', () => {
    const s = h.kartSnapshot(have.playerKartId ? h.playerKartId : 0)
    if (!s || !s.position || !s.quaternion || !s.velocity) {
      throw new Error('kartSnapshot() returned no position/quaternion/velocity')
    }
  })
  await probe('lastInput', () => {
    const f = h.lastInput(have.playerKartId ? h.playerKartId : 0)
    if (f !== null && typeof f.steer !== 'number') throw new Error('lastInput() returned neither null nor an InputFrame')
  })

  R.missing = missing
  R.broke = broke
  surface.metrics.live = Object.keys(have).filter((k) => have[k]).length
  surface.metrics.pending = missing.length
  for (const b of broke) fail(surface, `${b} — that is not the pending marker, so it is a breakage, not an absence`)
  if (missing.length) {
    pend(
      surface,
      `NOT AVAILABLE YET: ${missing.join(', ')}. Every check below that needs one reports PENDING and measures ` +
        `nothing. It is not a pass.`,
    )
  }

  const placement = mk('placement', 'seek lands the kart where this file thinks it asked for')
  const commandPath = mk('command-path', "this file's commands reached the kart and moved its wheels")
  const driving = mk('driving', 'the long scripted run actually drove a kart down a road')
  const determinism = mk('determinism', 'the same 10 s driven twice produces the same numbers')
  const slipStraight = mk('slip-straight', 'on straight road the kart points where it is going')
  const slipCorner = mk('slip-corner', 'in corners it is cornering, not spinning')
  const laneDrift = mk('lane-drift', 'lateral offset oscillates around the line, it does not walk away')
  const surfaceReport = mk('surface-report', 'onTrack and Surface agree with the track they came from')
  const slipAgreement = mk('slip-agreement', "the kart's own reported slip angle matches an independent one")
  const wheelContact = mk('wheel-contact', 'on flat level road the wheels stay on the ground')
  const straightHold = mk('straight-hold', 'open loop, steer released, on the longest straight')

  const graded = [placement, commandPath, driving, determinism, slipStraight, slipCorner, laneDrift, surfaceReport, slipAgreement, wheelContact, straightHold]

  const needed = ['track', 'playerKartId', 'telemetry', 'resetRace', 'startRace', 'setDriver', 'setInput', 'stepTicks', 'kartSnapshot']
  const lack = needed.filter((n) => !have[n])
  if (lack.length) {
    const why =
      `requires ${lack.join(', ')}; ${lack.length === 1 ? 'it is' : 'they are'} not available in this build, so ` +
      `NOTHING about how the kart tracks its own heading was measured by this run`
    for (const c of graded) pend(c, why)
    return R
  }

  const track = h.track
  const pid = h.playerKartId
  const L = track.length
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
  const wrap01 = (x) => x - Math.floor(x)
  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x)
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

  const sTmp = mkSample()
  const sLook = mkSample()
  const locTmp = mkLoc()
  const pTmp = makeVec()
  const fwdV = { x: 0, y: 0, z: 0 }
  const rightV = { x: 0, y: 0, z: 0 }

  /** Curvature magnitude at `t`, sampled fresh. */
  function curvatureAt(t) {
    track.sample(wrap01(t), sTmp)
    return Math.abs(sTmp.curvature)
  }

  function locateSnapshot(snap) {
    pTmp.set(snap.position.x, snap.position.y, snap.position.z)
    const r = track.locate(pTmp, locTmp) || locTmp
    return { t: r.t, lateral: r.lateral, height: r.height, onTrack: Boolean(r.onTrack) }
  }

  /**
   * THE MEASUREMENT. Slip angle from `KartState` alone.
   *
   * Chassis forward and right come from the quaternion by the contract's own
   * axis statement — "+X right, +Y up, -Z forward at identity rotation" — and
   * from nothing else, so no bug in `ITrack` can move this number.
   *
   * Both the heading and the velocity are FLATTENED TO HORIZONTAL first. A ramp
   * or a banked wall gives the velocity a vertical component that is pitch, not
   * slip, and folding it in would report a climbing kart as a sliding one.
   */
  function slipOf(snap) {
    const q = snap.quaternion
    rotQ(fwdV, { x: 0, y: 0, z: -1 }, q)
    rotQ(rightV, { x: 1, y: 0, z: 0 }, q)
    const fl = Math.hypot(fwdV.x, fwdV.z)
    const rl = Math.hypot(rightV.x, rightV.z)
    if (fl < 1e-6 || rl < 1e-6) return null // the kart is pointing straight up
    const fx = fwdV.x / fl
    const fz = fwdV.z / fl
    const rx = rightV.x / rl
    const rz = rightV.z / rl
    const vx = snap.velocity.x
    const vz = snap.velocity.z
    const vf = vx * fx + vz * fz
    const vl = vx * rx + vz * rz
    if (Math.hypot(vx, vz) < CFG.speedFloor) return null
    /*
     * Reversing is not slip. `atan2` of a backwards velocity returns ~180° and
     * would dominate every statistic on this page; a kart going backwards is a
     * different fault and `driving` is the check that owns it.
     */
    if (vf <= 0) return { deg: null, reversing: true }
    return { deg: Math.atan2(vl, vf) * DEG, reversing: false, vf, vl }
  }

  /** Bring the race to 'racing' without a wall-clock wait. */
  async function ensureRacing() {
    let phase = h.telemetry().phase
    if (phase === 'finished') {
      await h.resetRace()
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

  // =========================================================================
  // The scripted driver. Pure pursuit on the CENTRELINE, inside an
  // acceleration budget. No negation anywhere — STEERING SIGN, as stated.
  // =========================================================================
  /*
   * `lat` is the target's offset in the kart's own frame, positive to the
   * driver's right. `InputFrame.steer` is "-1 hard left .. +1 hard right,
   * positive = driver's right". Those are the same space, so the command is the
   * angle and there is nothing to flip. If this controller ever appears to need
   * a minus sign, the bug is here in the frame maths — see STEERING SIGN and
   * `tools/steer-test.mjs`, which grades the conversion independently.
   */
  function command(snap, loc) {
    const q = snap.quaternion
    rotQ(fwdV, { x: 0, y: 0, z: -1 }, q)
    rotQ(rightV, { x: 1, y: 0, z: 0 }, q)
    const speed = Math.max(0, snap.speed)

    const lookM = Math.max(CFG.lookAheadMinM, speed * CFG.lookAheadSeconds)
    track.sample(wrap01(loc.t + lookM / L), sLook)
    const dx = sLook.position.x - snap.position.x
    const dz = sLook.position.z - snap.position.z
    const lat = dx * rightV.x + dz * rightV.z
    const fwd = dx * fwdV.x + dz * fwdV.z
    const steer = clamp(CFG.steerGain * Math.atan2(lat, Math.max(2, fwd)), -1, 1)

    // Worst curvature between here and where a corner would already be biting.
    const brakeM = Math.max(CFG.lookAheadMinM, speed * CFG.brakeLookSeconds)
    let worst = 0
    for (let i = 0; i <= 6; i++) {
      const k = curvatureAt(loc.t + ((brakeM * i) / 6) / L)
      if (k > worst) worst = k
    }
    const vTarget = clamp(worst > 0 ? Math.sqrt(CFG.latAccelBudget / worst) : CFG.speedMax, CFG.speedMin, CFG.speedMax)
    const throttle = speed < vTarget - CFG.speedBandMs ? 1 : 0
    const brake = speed > vTarget + CFG.speedBandMs ? CFG.brakeStrength : 0
    return { steer, throttle, brake, drift: false, useItem: false, look: 0, vTarget, worstK: worst }
  }

  // =========================================================================
  // One long run. Every tick recorded; nothing thrown away silently.
  // =========================================================================
  /*
   * `opts.steer === null` means DRIVE (closed loop, the controller above).
   * A number means HOLD IT OPEN LOOP and let the road do what it likes — which
   * is the only way to see a lateral offset walk away, because a closed-loop
   * controller's whole job is to hide exactly that.
   */
  async function drive(totalTicks, opts) {
    const o = opts || {}
    const openLoopSteer = o.steer === undefined ? null : o.steer
    const rec = {
      tick: [],
      slipDeg: [],
      lateral: [],
      kappa: [],
      speed: [],
      steer: [],
      onTrack: [],
      surfaceKart: [],
      surfaceTrack: [],
      driftSlipDeg: [],
      grounded: [],
      compression: [],
      wheelSteerRad: [],
      halfWidth: [],
      bank: [],
      usable: [],
      bin: [],
      t: [],
    }
    const info = {
      reversingTicks: 0,
      nullSlipTicks: 0,
      slowTicks: 0,
      offTrackTicks: 0,
      stunTicks: 0,
      neighbourTicks: 0,
      jumpTicks: 0,
      respawnBlankTicks: 0,
      respawns: 0,
      inputChecks: 0,
      inputMismatches: 0,
      steerCommandedTicks: 0,
      steerObservedTicks: 0,
      steerSignAgreeTicks: 0,
      noWheelTicks: 0,
      maxSpeed: 0,
      distanceM: 0,
      driftActiveTicks: 0,
      driftSlipAllZero: true,
    }

    let neighbours = []
    function refreshNeighbours() {
      const tel = h.telemetry()
      const out = []
      for (const k of tel.karts) if (k.kartId !== pid) out.push(k.t)
      neighbours = out
      return tel
    }
    let tel = refreshNeighbours()
    let respawnsAt = 0
    for (const k of tel.karts) if (k.kartId === pid) respawnsAt = k.respawns

    const settleTicks = Math.round(CFG.settleSeconds / CFG.simStep)
    const blankTicks = Math.round(CFG.respawnBlankSeconds / CFG.simStep)
    let sinceCorner = settleTicks
    let blankFor = 0
    let prev = null
    let commanded = null

    for (let done = 0; done < totalTicks; done += CFG.stride) {
      const n = Math.min(CFG.stride, totalTicks - done)

      const snapPre = h.kartSnapshot(pid)
      if (!snapPre) return { blocked: `kartSnapshot(${pid}) returned null` }
      const locPre = locateSnapshot(snapPre)

      if (done % CFG.controlEveryTicks === 0 || commanded === null) {
        /*
         * OPEN LOOP means open loop IN STEERING. The throttle still holds a
         * speed, because a coasting kart decays through the speed floor and the
         * back half of the probe then measures nothing. Nothing touches the
         * steer: that is the whole point of this mode.
         */
        const c =
          openLoopSteer === null
            ? command(snapPre, locPre)
            : {
                steer: openLoopSteer,
                throttle:
                  o.holdSpeed !== undefined
                    ? snapPre.speed < o.holdSpeed
                      ? 1
                      : 0
                    : o.throttle === undefined
                      ? 1
                      : o.throttle,
                brake: 0,
                drift: false,
                useItem: false,
                look: 0,
              }
        commanded = c
        h.setInput({ steer: c.steer, throttle: c.throttle, brake: c.brake, drift: false, useItem: false, look: 0 })
      }

      await h.stepTicks(n)

      const snap = h.kartSnapshot(pid)
      if (!snap) return { blocked: `kartSnapshot(${pid}) returned null mid-run` }
      const loc = locateSnapshot(snap)
      track.sample(loc.t, sTmp)
      const kappa = Math.abs(sTmp.curvature)

      /*
       * DID OUR COMMAND REACH THE KART? Asked twice, on purpose, at two
       * different layers.
       *
       * A slip harness measuring a kart that is not being driven reports a
       * beautiful slip angle of zero and prints a pass, which is the worst
       * failure a gate of this kind can have. It is not hypothetical: a
       * starting-lights gate in `driverFrame` that returns the idle frame
       * outside phase 'racing' turns every `setInput` into nothing and raises no
       * error anywhere.
       *
       *   lastInput      the frame the DRIVER produced — one layer below setInput
       *   wheels[].steerAngle  "Steer angle applied to this wheel" — the command
       *                        made physical, several layers below that
       *
       * Either alone can be satisfied by a build that never acts on the frame.
       * Both together mean the command was produced AND applied.
       */
      if (have.lastInput) {
        const f = h.lastInput(pid)
        info.inputChecks++
        if (!f || Math.abs(f.steer - commanded.steer) > 1e-6) info.inputMismatches++
      }
      let grounded = null
      let compression = null
      let wheelSteer = null
      if (snap.wheels && snap.wheels.length >= 4) {
        grounded = 0
        compression = 0
        for (const w of snap.wheels) {
          if (w.grounded) grounded++
          compression += w.compression
        }
        compression /= snap.wheels.length
        // Front left and front right, per KartState.wheels' stated order.
        wheelSteer = (snap.wheels[0].steerAngle + snap.wheels[1].steerAngle) * 0.5
        if (Math.abs(commanded.steer) > 0.1) {
          info.steerCommandedTicks++
          if (Math.abs(wheelSteer) > 1e-9) info.steerObservedTicks++
          if (Math.sign(wheelSteer) === Math.sign(commanded.steer)) info.steerSignAgreeTicks++
        }
      } else {
        info.noWheelTicks++
      }

      // Respawns, teleports and neighbours: the three ways a tick stops being
      // about how the kart drives.
      if (done % 30 === 0) {
        tel = refreshNeighbours()
        for (const k of tel.karts) {
          if (k.kartId !== pid) continue
          if (k.respawns > respawnsAt) {
            info.respawns += k.respawns - respawnsAt
            respawnsAt = k.respawns
            blankFor = blankTicks
          }
        }
      }
      let jumped = false
      if (prev) {
        const moved = Math.hypot(snap.position.x - prev.x, snap.position.z - prev.z)
        const couldMove = Math.max(1, Math.abs(snap.speed), Math.abs(prev.speed)) * CFG.simStep * n * CFG.jumpFactor
        if (moved > couldMove) {
          jumped = true
          blankFor = blankTicks
        }
        info.distanceM += Math.min(moved, couldMove)
      }
      prev = { x: snap.position.x, z: snap.position.z, speed: snap.speed }

      let nearNeighbour = false
      for (const nt of neighbours) {
        let d = Math.abs(nt - loc.t)
        if (d > 0.5) d = 1 - d
        if (d * L < CFG.neighbourExclusionM) nearNeighbour = true
      }

      const s = slipOf(snap)
      const slipDeg = s && !s.reversing ? s.deg : null
      const isStraightRoad = kappa <= CFG.straightCurvature
      sinceCorner = isStraightRoad ? sinceCorner + n : 0
      const bin = !isStraightRoad ? 'corner' : sinceCorner >= settleTicks ? 'straight' : 'transition'

      if (s === null) info.nullSlipTicks++
      if (s && s.reversing) info.reversingTicks++
      if (Math.abs(snap.speed) < CFG.speedFloor) info.slowTicks++
      if (!loc.onTrack) info.offTrackTicks++
      if (snap.stunTime > 0) info.stunTicks++
      if (nearNeighbour) info.neighbourTicks++
      if (jumped) info.jumpTicks++
      if (blankFor > 0) {
        info.respawnBlankTicks++
        blankFor -= n
      }
      if (snap.drift && snap.drift.active) info.driftActiveTicks++
      const driftSlipDeg = snap.drift && typeof snap.drift.slipAngle === 'number' ? snap.drift.slipAngle * DEG : null
      if (driftSlipDeg !== null && Math.abs(driftSlipDeg) > CFG.epsilonDeg) info.driftSlipAllZero = false

      /*
       * USABLE. Everything excluded here is excluded because the slip angle it
       * would contribute is a fact about something other than how the kart
       * tracks its heading. Each exclusion is counted and printed — a filter
       * that quietly removes most of a run is a filter that manufactures a pass.
       */
      const usable =
        slipDeg !== null &&
        loc.onTrack &&
        snap.stunTime <= 0 &&
        !nearNeighbour &&
        !jumped &&
        blankFor <= 0 &&
        Math.abs(snap.speed) >= CFG.speedFloor

      rec.tick.push(done + n)
      rec.slipDeg.push(slipDeg)
      rec.lateral.push(loc.lateral)
      rec.kappa.push(kappa)
      rec.speed.push(snap.speed)
      rec.steer.push(commanded.steer)
      rec.onTrack.push(loc.onTrack)
      rec.surfaceKart.push(snap.surface)
      rec.surfaceTrack.push(track.surfaceAt(loc.t, loc.lateral))
      rec.driftSlipDeg.push(driftSlipDeg)
      rec.grounded.push(grounded)
      rec.compression.push(compression)
      rec.wheelSteerRad.push(wheelSteer)
      if (Math.abs(snap.speed) > info.maxSpeed) info.maxSpeed = Math.abs(snap.speed)
      rec.halfWidth.push(sTmp.halfWidth)
      rec.bank.push(sTmp.bank)
      rec.usable.push(usable)
      rec.bin.push(bin)
      rec.t.push(loc.t)
    }

    return { rec, info, seconds: totalTicks * CFG.simStep, samples: rec.tick.length }
  }

  // =========================================================================
  // placement — the racing-line trap, guarded rather than remembered
  // =========================================================================
  /*
   * Probe where |racingLine| is LARGEST on the lap. A doubled application is
   * invisible where the line sits on the centreline, so testing anywhere else
   * would be testing nothing and printing a pass for it.
   */
  {
    const N = 2048
    let bestT = 0
    let bestLine = 0
    for (let i = 0; i < N; i++) {
      const t = i / N
      const line = track.racingLine(t)
      if (Math.abs(line) > Math.abs(bestLine)) {
        bestLine = line
        bestT = t
      }
    }
    track.sample(bestT, sTmp)
    placement.metrics.t = bestT
    placement.metrics.racingLineM = bestLine
    placement.metrics.halfWidthM = sTmp.halfWidth
    placement.metrics.toleranceM = CFG.placementToleranceM

    if (!have.seek) {
      pend(placement, 'requires seek; it is not available in this build')
    } else if (Math.abs(bestLine) < CFG.minRacingLineForPlacementM) {
      pend(
        placement,
        `the racing line never leaves the centreline by more than ${Math.abs(bestLine).toFixed(3)} m anywhere on the ` +
          `lap (floor ${CFG.minRacingLineForPlacementM} m). Applying it twice would move the kart by that much and no ` +
          `more, which this check cannot resolve — so it measured NOTHING and is not a pass.`,
      )
    } else {
      /*
       * `HarnessAPI.seek`'s `lateral` is RELATIVE TO THE RACING LINE: main.ts
       * calls `placeAt(t, racingLine(t) + lateral)`. This file wants the
       * CENTRELINE, so it asks for `-racingLine(t)`. That is undocumented in
       * types.ts, which is precisely why it is asserted here rather than
       * trusted.
       */
      await h.seek({ t: bestT, lateral: -bestLine, speed: 0 })
      const snap = h.kartSnapshot(pid)
      const loc = snap ? locateSnapshot(snap) : null
      placement.metrics.landedLateralM = loc ? loc.lateral : null
      placement.metrics.landedT = loc ? loc.t : null
      if (!loc) {
        pend(placement, 'kartSnapshot returned null after the seek')
      } else if (!(Math.abs(loc.lateral) <= CFG.placementToleranceM)) {
        fail(
          placement,
          `asked seek for lateral ${(-bestLine).toFixed(3)} m at t=${bestT.toFixed(4)}, where racingLine is ` +
            `${bestLine.toFixed(3)} m, expecting to land on the CENTRELINE. The kart landed at lateral ` +
            `${loc.lateral.toFixed(3)} m (tolerance ±${CFG.placementToleranceM} m). ` +
            (Math.abs(loc.lateral - bestLine) < CFG.placementToleranceM
              ? `That is exactly one racing line off, so the offset is being applied TWICE — once by this file and ` +
                `once by seek. `
              : Math.abs(loc.lateral + 2 * bestLine) < CFG.placementToleranceM
                ? `That is two racing lines the other way, so this file's sign is inverted. `
                : '') +
            `HarnessAPI.seek's 'lateral' is relative to the RACING LINE — src/main.ts hands ` +
            `racingLine(t) + lateral to IKart.placeAt, whose own contract is centreline-relative — and types.ts ` +
            `documents neither. Reading it the other way once put a kart 22.6 m across a 14.0 m half-width road and ` +
            `cost a round. Every measurement below starts from a seek, so fix this before reading any of them.`,
        )
      }
    }
  }

  // =========================================================================
  // The cruise. Park the field, drive away from it, record every tick.
  // =========================================================================
  /*
   * NOT a seek. `seek` scatters the rest of the field evenly around the lap and
   * idles it, which is exactly right for a sub-second probe and ruinous for a
   * forty-second one: the kart under test reaches the first parked car after an
   * eighth of a lap and the rest of the run is a collision study.
   *
   * `resetRace` with every other kart idle parks the whole field on the start
   * grid instead, and the run drives away from it. One lap is longer than the
   * run, so it never comes back.
   */
  const tel0 = h.telemetry()
  const drivers = {}
  for (const k of tel0.karts) drivers[k.kartId] = k.kartId === pid ? 'scripted' : 'idle'
  await h.resetRace({ drivers })
  const racing = await ensureRacing()
  R.info.racing = racing
  R.info.fieldSize = tel0.karts.length
  if (!racing.ok) {
    for (const c of [commandPath, driving, determinism, slipStraight, slipCorner, laneDrift, surfaceReport, slipAgreement, wheelContact, straightHold]) {
      pend(
        c,
        `the race never reached phase 'racing' (${racing.why}) — a kart that is not racing does not respond to ` +
          `input, so nothing here was measured`,
      )
    }
    return R
  }

  /*
   * THE ACTIVE COMMAND PROBE, and it is active for a reason worth writing down.
   *
   * The first version of `command-path` read the cruise's own statistics: how
   * often a commanded steer showed up at the wheels. That is PASSIVE, and it has
   * a hole big enough to drive the exact bug through. A kart that ignores every
   * command sits still on a straight grid; a centreline-following controller
   * looking at straight road ahead of a stationary kart asks for almost no
   * steer; so there were no large-steer ticks to check and the gate reported a
   * pass over nothing. The `commands-ignored` sabotage walked straight through
   * it, which is exactly what a self-test is for.
   *
   * So this COMMANDS a known steer, both signs, and looks for it. It does not
   * depend on the run happening to produce one.
   */
  const cmdProbe = { ok: false }
  {
    // Get the kart moving first: a steer angle at a standstill is not something
    // every implementation is obliged to apply.
    h.setInput({ steer: 0, throttle: 1, brake: 0, drift: false, useItem: false, look: 0 })
    await h.stepTicks(CFG.commandProbeSpinUpTicks)
    const arms = []
    for (const s of [CFG.commandProbeSteer, -CFG.commandProbeSteer]) {
      h.setInput({ steer: s, throttle: 1, brake: 0, drift: false, useItem: false, look: 0 })
      await h.stepTicks(CFG.commandProbeTicks)
      const snap = h.kartSnapshot(pid)
      const f = have.lastInput ? h.lastInput(pid) : null
      const w = snap && snap.wheels && snap.wheels.length >= 4 ? (snap.wheels[0].steerAngle + snap.wheels[1].steerAngle) * 0.5 : null
      arms.push({
        commanded: s,
        lastInputSteer: f ? f.steer : null,
        wheelSteerRad: w,
        speed: snap ? snap.speed : null,
        stunTime: snap ? snap.stunTime : null,
      })
    }
    h.setInput({ steer: 0, throttle: 0, brake: 0, drift: false, useItem: false, look: 0 })
    commandPath.metrics.probe = arms
    const wheelsSeen = arms.every((a) => a.wheelSteerRad !== null)
    const wheelsMoved = wheelsSeen && arms.every((a) => Math.abs(a.wheelSteerRad) > 1e-9)
    const inputSeen = arms.every((a) => a.lastInputSteer !== null)
    const inputMatched = inputSeen && arms.every((a) => Math.abs(a.lastInputSteer - a.commanded) <= 1e-6)
    cmdProbe.wheelsSeen = wheelsSeen
    cmdProbe.wheelsMoved = wheelsMoved
    cmdProbe.inputSeen = inputSeen
    cmdProbe.inputMatched = inputMatched
    cmdProbe.ok = (wheelsSeen ? wheelsMoved : true) && (inputSeen ? inputMatched : true) && (wheelsSeen || inputSeen)
  }

  // The probe drove the kart down the road; put it back before the run that
  // gets measured. A cruise that starts from wherever the probe finished is a
  // cruise whose initial condition depends on the probe.
  await h.resetRace({ drivers })
  const racingAgain = await ensureRacing()
  if (!racingAgain.ok) {
    for (const c of [commandPath, driving, determinism, slipStraight, slipCorner, laneDrift, surfaceReport, slipAgreement, wheelContact, straightHold]) {
      pend(c, `the race did not return to phase 'racing' after the command probe (${racingAgain.why})`)
    }
    return R
  }

  const cruiseTicks = Math.round(CFG.runSeconds / CFG.simStep)
  const cruise = await drive(cruiseTicks, {})
  if (cruise.blocked) {
    for (const c of [commandPath, driving, determinism, slipStraight, slipCorner, laneDrift, surfaceReport, slipAgreement, wheelContact, straightHold]) {
      pend(c, `the cruise was blocked: ${cruise.blocked}`)
    }
    return R
  }

  const rec = cruise.rec
  const info = cruise.info
  const nS = rec.tick.length

  // =========================================================================
  // command-path — THE INSTRUMENT SELF-CHECK, and it outranks every gate below
  // =========================================================================
  /*
   * A slip harness that measures a kart nobody is driving reports a slip angle
   * of zero and prints a pass. That is not a theoretical failure: a phase gate
   * in `driverFrame` returning the idle frame outside 'racing' silently discards
   * every `setInput` and raises no error anywhere, and it has already cost part
   * of one investigation on this project.
   *
   * So the run is not allowed to print a verdict it has not earned. If the
   * command cannot be OBSERVED arriving, every slip check below reports PENDING
   * — not PASS, and not FAIL either, because a measurement that did not happen
   * is neither.
   *
   * Two independent observations, because either alone is satisfiable by a build
   * that never acts on the frame:
   *   1. `lastInput(pid).steer` — the frame the driver produced.
   *   2. `wheels[0..1].steerAngle` — "Steer angle applied to this wheel", the
   *      command made physical several layers further down.
   *
   * The SIGN is reported and not gated: `tools/steer-test.mjs` owns that, and
   * duplicating its gate here would mean two files going red for one bug.
   */
  const inputMismatchFrac = info.inputChecks ? info.inputMismatches / info.inputChecks : null
  const observedFrac = info.steerCommandedTicks ? info.steerObservedTicks / info.steerCommandedTicks : null
  const signAgreeFrac = info.steerCommandedTicks ? info.steerSignAgreeTicks / info.steerCommandedTicks : null
  const probeArms = commandPath.metrics.probe
  commandPath.metrics = {
    probe: probeArms,
    probeOk: cmdProbe.ok,
    lastInputChecks: info.inputChecks,
    lastInputMismatchFrac: inputMismatchFrac,
    lastInputMismatchGate: CFG.maxInputMismatchFrac,
    steerCommandedTicks: info.steerCommandedTicks,
    wheelObservedFrac: observedFrac,
    wheelObservedGate: CFG.minWheelObservedFrac,
    wheelSignAgreeFrac: signAgreeFrac,
    ticksWithNoWheelArray: info.noWheelTicks,
  }
  // -- the active probe, first, because it is the one that cannot be dodged ---
  if (!cmdProbe.wheelsSeen && !cmdProbe.inputSeen) {
    pend(
      commandPath,
      `neither route to "did the command arrive" was available: HarnessAPI.lastInput refused, and no snapshot carried ` +
        `a four-wheel KartState.wheels array to read steerAngle from. This run CANNOT show that it drove the kart, so ` +
        `every slip number below is unattributable.`,
    )
  } else {
    const arm = (a) =>
      `steer ${a.commanded >= 0 ? '+' : ''}${a.commanded} -> lastInput ${a.lastInputSteer === null ? 'n/a' : a.lastInputSteer.toFixed(4)}, ` +
      `wheels[].steerAngle ${a.wheelSteerRad === null ? 'n/a' : a.wheelSteerRad.toFixed(5)} rad, speed ${a.speed === null ? 'n/a' : a.speed.toFixed(1)} m/s`
    if (cmdProbe.wheelsSeen && !cmdProbe.wheelsMoved) {
      fail(
        commandPath,
        `THE COMMANDS ARE NOT REACHING THE KART. Held steer ${CFG.commandProbeSteer} and then ` +
          `${-CFG.commandProbeSteer} for ${(CFG.commandProbeTicks * CFG.simStep).toFixed(2)} s each at speed, and ` +
          `wheels[].steerAngle — "Steer angle applied to this wheel" — stayed at exactly zero. ` +
          `[${probeArms.map(arm).join('] [')}]. ` +
          `Something between setInput and the physics is discarding the frame; a phase gate in driverFrame that ` +
          `returns the idle frame outside 'racing' is the commonest, and it raises no error anywhere. Note that ` +
          `lastInput can AGREE while this fails — it reads the frame the driver produced, one layer above the frame ` +
          `the kart acted on, which is exactly why both are checked. Every slip check below is PENDING: a slip ` +
          `harness measuring a kart nobody is driving reports a beautiful zero and prints a pass.`,
      )
    }
    if (cmdProbe.inputSeen && !cmdProbe.inputMatched) {
      fail(
        commandPath,
        `lastInput did not echo the commanded steer during the probe: [${probeArms.map(arm).join('] [')}]. The frame ` +
          `this file handed setInput is not the frame the driver produced.`,
      )
    }
  }

  if (info.inputChecks === 0 && info.steerCommandedTicks === 0) {
    commandPath.notes.push(
      'the cruise itself never commanded |steer| > 0.1 and lastInput was unavailable, so the passive statistics below ' +
        'are empty. The active probe above is what this check rests on, and it is why it is active.',
    )
  } else {
    if (info.inputChecks === 0) {
      commandPath.notes.push('HarnessAPI.lastInput was unavailable; only the wheel-angle route was checked.')
    } else if (inputMismatchFrac > CFG.maxInputMismatchFrac) {
      fail(
        commandPath,
        `${(inputMismatchFrac * 100).toFixed(1)}% of control updates did not arrive: the steer read back through ` +
          `lastInput differed from the one setInput was handed (limit ${(CFG.maxInputMismatchFrac * 100).toFixed(0)}%). ` +
          `Something between setInput and the driver is discarding the frame — a phase gate in driverFrame is the ` +
          `commonest way, and it reports no error. This run was not driven by this file.`,
      )
    }
    if (info.steerCommandedTicks === 0) {
      commandPath.notes.push(
        'no tick carried a four-wheel wheels array, so only the lastInput route was checked. That route is one layer ' +
          'above the physics: a build that produces the frame and never applies it still passes it.',
      )
    } else if (observedFrac < CFG.minWheelObservedFrac) {
      fail(
        commandPath,
        `over ${info.steerCommandedTicks} ticks on which this file commanded |steer| > 0.1, only ` +
          `${(observedFrac * 100).toFixed(1)}% showed a non-zero wheels[].steerAngle (floor ` +
          `${(CFG.minWheelObservedFrac * 100).toFixed(0)}%). The command was produced and NOT applied. A slip harness ` +
          `measuring a kart that is not being steered reports a beautiful zero and passes, which is why this check ` +
          `outranks every gate below it.`,
      )
    } else if (signAgreeFrac !== null && signAgreeFrac < 0.5) {
      commandPath.notes.push(
        `the wheels moved, but their steerAngle agreed in SIGN with the command on only ` +
          `${(signAgreeFrac * 100).toFixed(1)}% of those ticks. WheelState.steerAngle's contract is "Sign follows ` +
          `STEERING SIGN". Reported and not gated here — tools/steer-test.mjs owns the sign, end to end, and two ` +
          `files going red for one bug helps nobody. Run it.`,
      )
    }
  }
  const commandsReached = commandPath.status === 'PASS'

  // =========================================================================
  // driving — did a kart drive down a road, before any slip number is quoted
  // =========================================================================
  const expectedM = CFG.runSeconds * ((CFG.speedMin + CFG.speedMax) / 2) * CFG.minDistanceFrac
  const onTrackFrac = nS ? rec.onTrack.filter(Boolean).length / nS : 0
  const usableFrac = nS ? rec.usable.filter(Boolean).length / nS : 0
  driving.metrics.seconds = cruise.seconds
  driving.metrics.samples = nS
  driving.metrics.stride = CFG.stride
  driving.metrics.distanceM = info.distanceM
  driving.metrics.expectedAtLeastM = expectedM
  driving.metrics.meanSpeed = mean(rec.speed)
  driving.metrics.onTrackFrac = onTrackFrac
  driving.metrics.usableFrac = usableFrac
  driving.metrics.excluded = {
    offTrack: info.offTrackTicks,
    stunned: info.stunTicks,
    nearAnotherKart: info.neighbourTicks,
    teleported: info.jumpTicks,
    afterRespawn: info.respawnBlankTicks,
    belowSpeedFloor: info.slowTicks,
    reversing: info.reversingTicks,
    noSlipAngle: info.nullSlipTicks,
  }
  driving.metrics.respawns = info.respawns
  driving.metrics.driftActiveTicks = info.driftActiveTicks
  driving.metrics.inputMismatchFrac = info.inputChecks ? info.inputMismatches / info.inputChecks : null

  const controllerCaveat =
    `The cruise is driven by a pure-pursuit controller written INSIDE this harness, not by src/game/ai.ts, so a ` +
    `failure here is either the kart or this file's controller. To tell them apart: tools/steer-test.mjs grades the ` +
    `steering conversion in isolation over 0.75 s. If it is green and this is red, suspect the controller (or a ` +
    `divergence that only appears after seconds — which is what this file exists to find). If both are red, the ` +
    `chassis is where to look.`

  if (!(info.distanceM >= expectedM)) {
    fail(
      driving,
      `the kart covered ${info.distanceM.toFixed(1)} m in ${cruise.seconds.toFixed(1)} s (expected at least ` +
        `${expectedM.toFixed(0)} m at the commanded speeds). It did not drive, so every slip number below is about a ` +
        `kart that was not moving. ${controllerCaveat}`,
    )
  }
  if (!(onTrackFrac >= CFG.minOnTrackFrac)) {
    fail(
      driving,
      `the kart was on track for ${(onTrackFrac * 100).toFixed(1)}% of the run (floor ` +
        `${(CFG.minOnTrackFrac * 100).toFixed(0)}%), with ${info.respawns} respawn(s). ${controllerCaveat}`,
    )
  }
  // Whether the commands arrived at all is `command-path`'s job, above, and it
  // is deliberately a separate check: "the kart did not drive" and "the kart was
  // not being driven by this file" are different findings with different fixes.

  // =========================================================================
  // determinism — the floor every threshold is quoted against
  // =========================================================================
  /*
   * The repeat is compared against the FIRST 10 s OF THE CRUISE ITSELF, not
   * against a separate short run, so what is proven to repeat is the actual
   * measurement rather than a cousin of it. A fixed-step seeded simulation
   * should land at exactly zero; if it does not, nothing else on this page is a
   * measurement, because two runs of the "same" test are not the same test.
   */
  {
    await h.resetRace({ drivers })
    const again = await ensureRacing()
    const detTicks = Math.min(cruiseTicks, Math.round(CFG.determinismSeconds / CFG.simStep))
    const repeat = again.ok ? await drive(detTicks, {}) : { blocked: `race did not reach 'racing': ${again.why}` }
    if (repeat.blocked) {
      pend(determinism, `the repeat run was blocked: ${repeat.blocked}`)
    } else {
      const m = Math.min(repeat.rec.tick.length, nS)
      let dSlip = 0
      let dLat = 0
      let dSpeed = 0
      let firstDivergeTick = null
      for (let i = 0; i < m; i++) {
        const a = rec.slipDeg[i]
        const b = repeat.rec.slipDeg[i]
        const ds = a === null || b === null ? (a === b ? 0 : Infinity) : Math.abs(a - b)
        const dl = Math.abs(rec.lateral[i] - repeat.rec.lateral[i])
        const dv = Math.abs(rec.speed[i] - repeat.rec.speed[i])
        if (firstDivergeTick === null && (ds > CFG.epsilonDeg || dl > CFG.epsilonM || dv > CFG.epsilonM)) {
          firstDivergeTick = rec.tick[i]
        }
        if (ds > dSlip) dSlip = ds
        if (dl > dLat) dLat = dl
        if (dv > dSpeed) dSpeed = dv
      }
      determinism.metrics.comparedSamples = m
      determinism.metrics.seconds = m * CFG.stride * CFG.simStep
      determinism.metrics.maxSlipSpreadDeg = dSlip
      determinism.metrics.maxLateralSpreadM = dLat
      determinism.metrics.maxSpeedSpreadMs = dSpeed
      determinism.metrics.firstDivergeTick = firstDivergeTick
      if (dSlip > CFG.epsilonDeg || dLat > CFG.epsilonM || dSpeed > CFG.epsilonM) {
        fail(
          determinism,
          `two identical ${(m * CFG.stride * CFG.simStep).toFixed(1)} s runs from the same reset differ by up to ` +
            `${dSlip.toFixed(4)} deg of slip, ${dLat.toExponential(2)} m of lateral and ${dSpeed.toExponential(2)} m/s ` +
            `of speed, first at tick ${firstDivergeTick}. The simulation is fixed-step and seeded, so this should be ` +
            `zero to the last bit. Until it is, "the kart slid after twenty seconds" is not a reproducible ` +
            `observation and no threshold on this page is quoted against a floor that holds still. Look for a wall ` +
            `clock reaching fixedUpdate, or Math.random() outside ctx.rngFor.`,
        )
      } else {
        determinism.notes.push(
          `identical to the last bit over ${(m * CFG.stride * CFG.simStep).toFixed(1)} s. The gates below therefore ` +
            `stand on the arithmetic floors in CFG, not on a measured spread — which is what THE CLOCK is for.`,
        )
      }
    }
  }

  // =========================================================================
  // Binning: straight, transition, corner — reported separately, always
  // =========================================================================
  /*
   * "Slip correlates with curvature" is not a claim this file makes on the
   * reader's behalf; it is the axis everything is reported along. One pooled
   * number over a circuit that is half corners is a number about the circuit.
   */
  function binOf(rec, name, filter) {
    const slip = []
    const aLat = []
    const speed = []
    const steer = []
    const lateral = []
    const kappa = []
    for (let i = 0; i < rec.tick.length; i++) {
      if (!rec.usable[i]) continue
      if (rec.bin[i] !== name) continue
      if (filter && !filter(i)) continue
      slip.push(Math.abs(rec.slipDeg[i]))
      aLat.push(rec.speed[i] * rec.speed[i] * rec.kappa[i])
      speed.push(rec.speed[i])
      steer.push(rec.steer[i])
      lateral.push(rec.lateral[i])
      kappa.push(rec.kappa[i])
    }
    const ss = sorted(slip)
    const sa = sorted(aLat)
    return {
      name,
      ticks: slip.length * CFG.stride,
      samples: slip.length,
      medianSlipDeg: quantile(ss, 0.5),
      p95SlipDeg: quantile(ss, 0.95),
      maxSlipDeg: ss.length ? ss[ss.length - 1] : null,
      medianLatAccel: quantile(sa, 0.5),
      maxLatAccel: sa.length ? sa[sa.length - 1] : null,
      meanSpeed: mean(speed),
      meanSteer: mean(steer),
      meanAbsSteer: mean(steer.map(Math.abs)),
      meanLateralM: mean(lateral),
      meanKappa: mean(kappa),
    }
  }
  const bStraight = binOf(rec, 'straight')
  const bTransition = binOf(rec, 'transition')
  const bCorner = binOf(rec, 'corner')
  R.info.bins = { straight: bStraight, transition: bTransition, corner: bCorner }

  /*
   * COMPLIANCE. Degrees of body slip this kart spends per m/s² of lateral
   * demand, measured from its own corners. This is the only place a slip
   * threshold comes from that is not somebody's preference — and it is measured
   * on the same lap, the same tyres and the same surfaces as the number it is
   * about to grade.
   */
  const complianceDegPerG =
    bCorner.samples && bCorner.medianLatAccel > 0.05 ? bCorner.medianSlipDeg / bCorner.medianLatAccel : null
  R.info.complianceDegPerMs2 = complianceDegPerG

  function gateFor(latAccelDemand, label) {
    const predicted = complianceDegPerG === null ? null : complianceDegPerG * latAccelDemand
    const fromCompliance = predicted === null ? null : CFG.slipComplianceMultiple * predicted
    const derived = Math.max(fromCompliance === null ? 0 : fromCompliance, CFG.slipFloorDeg)
    const capped = Math.min(derived, CFG.slipAbsoluteMaxDeg)
    let bound = 'the arithmetic floor'
    if (derived > CFG.slipAbsoluteMaxDeg) bound = 'the absolute rail (guess) — the compliance-derived gate exceeded it'
    else if (fromCompliance !== null && fromCompliance > CFG.slipFloorDeg) bound = "this kart's own measured compliance"
    return { deg: capped, bound, predictedDeg: predicted, label, latAccelDemand }
  }

  // =========================================================================
  // slip-straight — THE gate
  // =========================================================================
  const gate = gateFor(bStraight.medianLatAccel === null ? 0 : bStraight.medianLatAccel, 'straight')
  slipStraight.metrics = {
    samples: bStraight.samples,
    seconds: bStraight.ticks * CFG.simStep,
    medianSlipDeg: bStraight.medianSlipDeg,
    p95SlipDeg: bStraight.p95SlipDeg,
    maxSlipDeg: bStraight.maxSlipDeg,
    gateDeg: gate.deg,
    gateBoundBy: gate.bound,
    predictedFromComplianceDeg: gate.predictedDeg,
    complianceDegPerMs2: complianceDegPerG,
    medianLatAccel: bStraight.medianLatAccel,
    meanSpeed: bStraight.meanSpeed,
    meanSteer: bStraight.meanSteer,
    straightCurvatureLimit: CFG.straightCurvature,
  }

  /*
   * A SHORT PROBE WOULD HAVE MISSED IT. The same statistic over the first 36
   * ticks — the window tools/steer-test.mjs gives its AI probe — printed next to
   * the whole-run number. This is not decoration: it is the evidence for why
   * this file exists, and `--broken`'s `slip-ramps` sabotage asserts that the
   * short number stays clean while the long one goes red.
   */
  {
    /*
     * Counted over the FIRST usable settled-straight samples, not the first
     * samples of the run. A standing start spends its opening second under the
     * speed floor with no meaningful slip angle at all, and quoting that as
     * "what a short probe would have seen" would be quoting the exclusions
     * rather than the vehicle. `steer-test.mjs` seeks to speed before it probes;
     * this is the same window it gets, taken from the same place it would take it.
     */
    const shortSamples = Math.max(1, Math.round(CFG.shortProbeTicks / CFG.stride))
    const early = []
    for (let i = 0; i < nS && early.length < shortSamples; i++) {
      if (rec.usable[i] && rec.bin[i] === 'straight' && rec.slipDeg[i] !== null) early.push(Math.abs(rec.slipDeg[i]))
    }
    slipStraight.metrics.firstShortProbeMaxDeg = early.length ? Math.max.apply(null, early) : null
    slipStraight.metrics.firstShortProbeSamples = early.length
    slipStraight.metrics.shortProbeSeconds = CFG.shortProbeTicks * CFG.simStep
  }

  if (bStraight.samples * CFG.stride < CFG.minBinTicks) {
    pend(
      slipStraight,
      `only ${bStraight.samples * CFG.stride} usable ticks of settled straight road ` +
        `(${(bStraight.ticks * CFG.simStep).toFixed(2)} s, floor ${CFG.minBinTicks} ticks). This gate MEASURED ` +
        `NOTHING. Either the run did not reach a straight, or the exclusions above removed it — the excluded-tick ` +
        `ledger under 'driving' says which. A gate that quietly covers nothing prints the same green as one that passed.`,
    )
  } else {
    const why =
      `A straight demands essentially no lateral force (median ${bStraight.medianLatAccel.toFixed(2)} m/s² here), so a ` +
      `kart that points where it is going has essentially no slip on one. The gate is ${gate.deg.toFixed(2)} deg, set ` +
      `by ${gate.bound}` +
      (complianceDegPerG === null
        ? ' (no corner data, so no compliance could be measured)'
        : `: this kart spends ${complianceDegPerG.toFixed(3)} deg of body slip per m/s² in its own corners, which ` +
          `predicts ${gate.predictedDeg.toFixed(3)} deg here`) +
      `. That number is measured off this same run, not chosen.`
    if (!(bStraight.medianSlipDeg <= gate.deg)) {
      fail(
        slipStraight,
        `median |slip| on settled straight road is ${bStraight.medianSlipDeg.toFixed(2)} deg over ` +
          `${(bStraight.ticks * CFG.simStep).toFixed(1)} s at ${bStraight.meanSpeed.toFixed(1)} m/s ` +
          `(gate ${gate.deg.toFixed(2)} deg). The kart is not pointed where it is going. ${why} Mean commanded steer ` +
          `across those ticks was ${bStraight.meanSteer.toFixed(4)}, so the controller ` +
          `${Math.abs(bStraight.meanSteer) > 0.05 ? 'was holding a standing correction into it' : 'was not steering it there'}.`,
      )
    }
    if (!(bStraight.p95SlipDeg <= gate.deg * CFG.slipP95Multiple)) {
      fail(
        slipStraight,
        `p95 |slip| on settled straight road is ${bStraight.p95SlipDeg.toFixed(2)} deg (limit ` +
          `${(gate.deg * CFG.slipP95Multiple).toFixed(2)} deg = ${CFG.slipP95Multiple}x the median gate). The median ` +
          `may be fine; a tail this heavy means the kart is letting go intermittently rather than continuously, which ` +
          `is a different fault with a different cause. ${why}`,
      )
    }
  }

  // =========================================================================
  // slip-corner — reported, gated only on the one thing a corner cannot be
  // =========================================================================
  slipCorner.metrics = {
    samples: bCorner.samples,
    seconds: bCorner.ticks * CFG.simStep,
    medianSlipDeg: bCorner.medianSlipDeg,
    p95SlipDeg: bCorner.p95SlipDeg,
    maxSlipDeg: bCorner.maxSlipDeg,
    medianLatAccel: bCorner.medianLatAccel,
    maxLatAccel: bCorner.maxLatAccel,
    meanSpeed: bCorner.meanSpeed,
    complianceDegPerMs2: complianceDegPerG,
    spinGateDeg: CFG.spinDeg,
    transition: bTransition,
  }
  if (bCorner.samples * CFG.stride < CFG.minBinTicks) {
    pend(
      slipCorner,
      `only ${bCorner.samples * CFG.stride} usable ticks of corner (floor ${CFG.minBinTicks}). No compliance could be ` +
        `measured, so slip-straight's gate fell back to the ${CFG.slipFloorDeg} deg arithmetic floor instead of being ` +
        `derived from this vehicle. Both checks are weaker for it and this is not a pass.`,
    )
  } else if (!(bCorner.maxSlipDeg <= CFG.spinDeg)) {
    /*
     * WHERE THE PEAK HAPPENED, printed with it. A peak reached while the
     * controller is holding full opposite lock at walking pace is a failure to
     * RECOVER; one reached at speed under a modest steer is a failure to hold.
     * Those are different faults and the bare maximum cannot tell them apart.
     */
    let pi = -1
    let pv = -1
    for (let i = 0; i < nS; i++) {
      if (!rec.usable[i] || rec.bin[i] !== 'corner' || rec.slipDeg[i] === null) continue
      if (Math.abs(rec.slipDeg[i]) > pv) {
        pv = Math.abs(rec.slipDeg[i])
        pi = i
      }
    }
    const at =
      pi < 0
        ? ''
        : `The peak occurred at t=${(rec.tick[pi] * CFG.simStep).toFixed(2)} s, at ${rec.speed[pi].toFixed(1)} m/s ` +
          `with the road asking for only ${(rec.speed[pi] * rec.speed[pi] * rec.kappa[pi]).toFixed(2)} m/s² and this ` +
          `file's controller commanding steer ${rec.steer[pi].toFixed(2)}` +
          `${Math.abs(rec.steer[pi]) > 0.95 ? ' — full lock, i.e. already trying to catch it, so read this as a failure to RECOVER rather than a failure to hold' : ''}. ` +
          `The median for the bin is ${bCorner.medianSlipDeg.toFixed(2)} deg, which is the number to compare across builds.`
    slipCorner.metrics.peakAtSeconds = pi < 0 ? null : rec.tick[pi] * CFG.simStep
    slipCorner.metrics.peakAtSpeed = pi < 0 ? null : rec.speed[pi]
    slipCorner.metrics.peakAtDemand = pi < 0 ? null : rec.speed[pi] * rec.speed[pi] * rec.kappa[pi]
    slipCorner.metrics.peakAtSteer = pi < 0 ? null : rec.steer[pi]
    fail(
      slipCorner,
      `peak |slip| in a corner reached ${bCorner.maxSlipDeg.toFixed(1)} deg (limit ${CFG.spinDeg} deg). ${at} Past 45 deg ` +
        `the velocity is more sideways than forward: that is not cornering, it is a spin, and no lap is driveable ` +
        `through it. How much slip a corner legitimately costs is what this file MEASURES rather than assumes — hence ` +
        `the only gate here being the one thing a corner cannot be.`,
    )
  } else {
    slipCorner.notes.push(
      `reported, not gated on value: ${bCorner.medianSlipDeg.toFixed(2)} deg median at ` +
        `${bCorner.medianLatAccel.toFixed(2)} m/s² of demand -> ${complianceDegPerG === null ? '-' : complianceDegPerG.toFixed(3)} ` +
        `deg per m/s² of compliance. THIS is what sets the straight-line gate. Cornering slip is legitimate and is ` +
        `not graded against a number anyone chose.`,
    )
  }

  // =========================================================================
  // lane-drift — monotone departure versus oscillation around a line
  // =========================================================================
  {
    const lat = []
    const secs = []
    for (let i = 0; i < nS; i++) {
      if (!rec.onTrack[i]) continue
      lat.push(rec.lateral[i])
      secs.push(rec.tick[i] * CFG.simStep)
    }
    const pos = lat.filter((x) => x > 0).length
    const neg = lat.filter((x) => x < 0).length
    const consistency = lat.length ? Math.max(pos, neg) / lat.length : 0
    let crossings = 0
    for (let i = 1; i < lat.length; i++) if (lat[i] > 0 !== lat[i - 1] > 0) crossings++
    // Least-squares trend, m per second.
    let slope = 0
    if (lat.length > 2) {
      const mx = mean(secs)
      const my = mean(lat)
      let num = 0
      let den = 0
      for (let i = 0; i < lat.length; i++) {
        num += (secs[i] - mx) * (lat[i] - my)
        den += (secs[i] - mx) * (secs[i] - mx)
      }
      slope = den > 0 ? num / den : 0
    }
    const net = lat.length ? lat[lat.length - 1] - lat[0] : 0
    const halfWidth = quantile(sorted(rec.halfWidth), 0.5) || 0
    laneDrift.metrics = {
      samples: lat.length,
      signConsistency: consistency,
      crossingsPerMinute: cruise.seconds > 0 ? (crossings * 60) / cruise.seconds : 0,
      trendMPerSecond: slope,
      netTravelM: net,
      meanLateralM: mean(lat),
      maxAbsLateralM: lat.length ? Math.max.apply(null, lat.map(Math.abs)) : null,
      halfWidthM: halfWidth,
      signConsistencyGate: CFG.laneSignConsistency,
      netTravelGateM: halfWidth,
    }
    if (!lat.length) {
      pend(laneDrift, 'no on-track samples; nothing to say about where the kart sat on the road')
    } else if (consistency >= CFG.laneSignConsistency && Math.abs(net) > halfWidth) {
      fail(
        laneDrift,
        `the lateral offset stayed on the same side of the centreline for ${(consistency * 100).toFixed(1)}% of the ` +
          `run AND travelled ${net.toFixed(2)} m in that one direction (half-width ${halfWidth.toFixed(2)} m, trend ` +
          `${slope.toFixed(3)} m/s, ${laneDrift.metrics.crossingsPerMinute.toFixed(1)} centreline crossings per ` +
          `minute). That is a departure, not an oscillation. Both halves are required on purpose: a controller can ` +
          `sit at a small steady offset forever without anything being wrong, and a kart can swing a half-width and ` +
          `come back.`,
      )
    } else {
      laneDrift.notes.push(
        `sign consistency ${(consistency * 100).toFixed(1)}%, net travel ${net.toFixed(2)} m, trend ` +
          `${slope.toFixed(3)} m/s, ${laneDrift.metrics.crossingsPerMinute.toFixed(1)} crossings/min. NOTE: the cruise ` +
          `is CLOSED LOOP on the centreline, so a slow drift is something the controller is actively fighting and can ` +
          `hide. Where it shows up instead is the standing steer bias on straights ` +
          `(${bStraight.meanSteer === null ? '-' : bStraight.meanSteer.toFixed(4)}) and in 'straight-hold', which ` +
          `releases the steer entirely.`,
      )
    }
  }

  // =========================================================================
  // surface-report — two independent routes to "what am I driving on"
  // =========================================================================
  /*
   * `KartState.surface` is "Surface under the chassis centre", produced by
   * `kart/`. `ITrack.surfaceAt(t, lateral)` is the same fact, produced by
   * `world/`. They are computed by different subsystems from the same geometry
   * and they must agree, because the grip the kart is actually using comes from
   * the first and every diagnosis of a slide comes from the second.
   *
   * Only a GRIP-CHANGING disagreement is gated. Kerb against Asphalt is 0.95
   * against 1.00 and is cosmetic; DustyAsphalt against SandDrift is 0.88
   * against 0.62 and is an explanation.
   */
  {
    let compared = 0
    let differ = 0
    let gripDiffer = 0
    let worstGripGap = 0
    const pairs = {}
    const histKart = {}
    for (let i = 0; i < nS; i++) {
      if (!rec.usable[i]) continue
      const a = rec.surfaceKart[i]
      const b = rec.surfaceTrack[i]
      histKart[a] = (histKart[a] || 0) + 1
      if (typeof a !== 'number' || typeof b !== 'number') continue
      compared++
      if (a === b) continue
      differ++
      const key = `${a}->${b}`
      pairs[key] = (pairs[key] || 0) + 1
      const ga = CFG.grip[a]
      const gb = CFG.grip[b]
      if (ga === undefined || gb === undefined) continue
      const gap = Math.abs(ga - gb)
      if (gap > worstGripGap) worstGripGap = gap
      if (gap >= 0.1) gripDiffer++
    }

    /*
     * The two contradictions, both derived from what the contract SAYS these
     * fields mean rather than from what looks odd.
     *
     *   A. `TrackLocation.onTrack` is false "once |lateral| > halfWidth +
     *      BARRIER_MARGIN". Past that line `ITrack.surfaceAt` is "outside every
     *      defined surface region", i.e. OffTrack. A kart the track has placed
     *      beyond the barrier while reporting a road surface under itself is
     *      being handed grip it should not have — and that is a slide with an
     *      entirely different cause.
     *   B. A kart inside HALF of the half-width is not within a barrier margin
     *      of anything. `onTrack` false there is the track contradicting its own
     *      definition, and every off-track penalty downstream is then firing on
     *      a kart in the middle of the road.
     */
    /*
     * GATED ON THE LONGEST UNBROKEN RUN, NOT THE TOTAL COUNT, and the difference
     * is not leniency. `KartState.surface` is resolved inside `fixedUpdate` by
     * `kart/`; `TrackLocation.onTrack` is produced by the harness calling
     * `track.locate` after the tick has run. At the instant the kart crosses the
     * barrier line those two are one tick out of phase with each other, and a
     * single-tick disagreement there is a sampling artefact, not a disagreement
     * about the world. `contradictionTicks` is 2: one tick of phase plus one of
     * margin. Anything the two subsystems disagree about for longer than that is
     * a disagreement they are both holding on to, which is the thing worth
     * knowing. The raw totals are reported either way.
     */
    let contraA = 0
    let contraB = 0
    let runA = 0
    let runB = 0
    let worstRunA = 0
    let worstRunB = 0
    const OFF = CFG.surface.OffTrack
    for (let i = 0; i < nS; i++) {
      const a = !rec.onTrack[i] && rec.surfaceKart[i] !== OFF
      const b = Math.abs(rec.lateral[i]) <= 0.5 * rec.halfWidth[i] && !rec.onTrack[i]
      if (a) {
        contraA++
        runA += CFG.stride
        if (runA > worstRunA) worstRunA = runA
      } else runA = 0
      if (b) {
        contraB++
        runB += CFG.stride
        if (runB > worstRunB) worstRunB = runB
      } else runB = 0
    }
    const contradictionTicks = 2

    surfaceReport.metrics = {
      comparedSamples: compared,
      disagreeFrac: compared ? differ / compared : null,
      gripChangingDisagreeFrac: compared ? gripDiffer / compared : null,
      worstGripGap,
      disagreements: pairs,
      kartSurfaceHistogram: histKart,
      onTrackFrac,
      contradictionOffTrackWithRoadSurface: contraA,
      contradictionInsideRoadButOffTrack: contraB,
      longestContradictionRunTicks: { offTrackWithRoadSurface: worstRunA, insideRoadButOffTrack: worstRunB },
      contradictionRunToleranceTicks: contradictionTicks,
      barrierMargin: CFG.barrierMargin,
    }
    /*
     * THE CONTRADICTION GATES ARE OUTSIDE THE `compared` GUARD ON PURPOSE.
     *
     * They were inside it once, and the `ontrack-inverted` sabotage walked
     * straight through: negating `onTrack` empties the usable-sample filter
     * (which requires onTrack), `compared` goes to zero, and the check reported
     * PENDING — "nothing to compare" — about a build whose entire fault is that
     * it says the kart is off the road. A detector switched off by the thing it
     * detects is not a detector. These two read `onTrack`, `lateral` and
     * `halfWidth`, all of which are recorded on every tick regardless.
     */
    if (worstRunA > contradictionTicks) {
      fail(
        surfaceReport,
        `for ${worstRunA} consecutive ticks (${contraA} in total) TrackLocation.onTrack was false — which by contract ` +
          `means |lateral| exceeded halfWidth + ${CFG.barrierMargin} m — while KartState.surface still reported a road ` +
          `surface rather than OffTrack. Past the barrier there is no defined surface region, so one of the two is ` +
          `wrong, and whichever it is the kart is driving on grip nobody intended. (A run of ${contradictionTicks} ` +
          `ticks or fewer is the sampling phase between the two and is not gated.)`,
      )
    }
    if (worstRunB > contradictionTicks) {
      fail(
        surfaceReport,
        `for ${worstRunB} consecutive ticks (${contraB} in total) onTrack was false while the kart sat within half of ` +
          `the road's own half-width of the centreline. onTrack is defined as |lateral| > halfWidth + ` +
          `${CFG.barrierMargin} m; a kart in the middle of the road cannot satisfy it. Every off-track penalty and ` +
          `every respawn downstream is firing on a kart that is on the road.`,
      )
    }

    if (!compared) {
      pend(
        surfaceReport,
        'no usable sample carried both a kart surface and a track surface, so the two routes to "what am I driving ' +
          'on" were never compared. The onTrack contradictions above still ran.',
      )
    } else {
      if (gripDiffer / compared > 0.1) {
        fail(
          surfaceReport,
          `${((gripDiffer / compared) * 100).toFixed(1)}% of ticks have KartState.surface and ` +
            `ITrack.surfaceAt(t, lateral) reporting surfaces whose grip differs by 0.1 or more (worst gap ` +
            `${worstGripGap.toFixed(2)}, limit 10% of ticks). Commonest disagreement: ` +
            `${Object.keys(pairs).sort((x, y) => pairs[y] - pairs[x])[0]} (kart -> track, by Surface ordinal). ` +
            `The kart is being given grip from a different place than the track says it is driving on. That is an ` +
            `explanation for a slide, and it is a completely different one from a tyre model that lets go.`,
        )
      }
    }
  }

  // =========================================================================
  // slip-agreement — the kart's own slip angle against an independent one
  // =========================================================================
  /*
   * `DriftState.slipAngle` is contractually "Angle between chassis forward and
   * velocity" — the same quantity computed above from `KartState.quaternion` and
   * `KartState.velocity` and nothing else. Two routes to one fact, which is the
   * same argument `steer-test.mjs` makes for having two anchors: if they
   * disagree, one of them is wrong, and the one that drives the drift system,
   * the spark rate and anyone's diagnosis of this very bug is the reported one.
   */
  {
    const diffs = []
    for (let i = 0; i < nS; i++) {
      if (!rec.usable[i]) continue
      if (rec.driftSlipDeg[i] === null || rec.slipDeg[i] === null) continue
      diffs.push(Math.abs(Math.abs(rec.driftSlipDeg[i]) - Math.abs(rec.slipDeg[i])))
    }
    const sd = sorted(diffs)
    slipAgreement.metrics = {
      comparedSamples: diffs.length,
      medianDiffDeg: quantile(sd, 0.5),
      p95DiffDeg: quantile(sd, 0.95),
      maxDiffDeg: sd.length ? sd[sd.length - 1] : null,
      gateDeg: CFG.slipAgreeDeg,
      reportedAllZero: info.driftSlipAllZero,
    }
    if (!diffs.length) {
      pend(slipAgreement, 'no usable samples carried both slip angles; nothing was compared')
    } else if (info.driftSlipAllZero) {
      pend(
        slipAgreement,
        `DriftState.slipAngle was exactly 0 for every one of ${diffs.length} usable ticks, while this file measured ` +
          `up to ${(bCorner.maxSlipDeg === null ? 0 : bCorner.maxSlipDeg).toFixed(2)} deg independently. That is far ` +
          `more likely to mean the field is not populated yet than that it is wrong, so this reports PENDING rather ` +
          `than FAIL — but it is NOT a pass: the cross-check measured nothing, and anything reading slipAngle (the ` +
          `drift tier ladder, the spark rate) is reading a constant.`,
      )
    } else if (!(quantile(sd, 0.95) <= CFG.slipAgreeDeg)) {
      fail(
        slipAgreement,
        `p95 disagreement between DriftState.slipAngle and the slip angle computed here from KartState.quaternion ` +
          `and KartState.velocity is ${quantile(sd, 0.95).toFixed(2)} deg (gate ${CFG.slipAgreeDeg} deg, median ` +
          `${quantile(sd, 0.5).toFixed(2)} deg, worst ${sd[sd.length - 1].toFixed(2)} deg). The contract defines ` +
          `slipAngle as "Angle between chassis forward and velocity", which is exactly what was computed here from ` +
          `the two fields it is derived from. One of the two is measuring something else. Note which way to read ` +
          `this: if the REPORTED one is wrong, the drift system and every diagnosis of a slide are being made on a ` +
          `number that is not the slip angle.`,
      )
    }
  }

  // =========================================================================
  // wheel-contact — a grip invariant that slip angle alone cannot see
  // =========================================================================
  /*
   * ADDED AFTER THE FACT, AND SAYING SO IS THE POINT.
   *
   * This file was written to ask about slip angle, and slip angle has a blind
   * spot: a kart with 40% of its grip still corners, just badly and wide. It
   * does not necessarily slide, so a slip gate can be green while the tyres are
   * barely touching the road. `WheelState.grounded` and `WheelState.compression`
   * are already on the contract and cost nothing to read, and the invariant they
   * support is derivable without knowing anything about any particular bug:
   *
   *     on flat, level, straight road, at every speed the game supports,
   *     all four wheels stay in contact.
   *
   * Nothing on a straight launches a kart. There is no crest and no jump, and
   * lateral load transfer requires lateral acceleration, which a straight does
   * not demand. This is graded on the STRAIGHT bin only, for exactly that
   * reason — a kerb, a crest or a hard corner can legitimately lift a wheel and
   * the corner bin is reported, never gated.
   *
   * It shares no threshold with the slip gates and cannot change one. The
   * `hovering` sabotage in `--broken` asserts that: it lifts the kart off the
   * road while leaving the tyre model untouched, and slip-straight must stay
   * QUIET while this goes red.
   */
  {
    let sTicks = 0
    let sGroundSum = 0
    let sAir = 0
    let sComp = 0
    let sHave = 0
    let cTicks = 0
    let cGroundSum = 0
    let cAir = 0
    for (let i = 0; i < nS; i++) {
      if (!rec.usable[i]) continue
      if (rec.grounded[i] === null) continue
      if (rec.bin[i] === 'straight') {
        sTicks++
        sGroundSum += rec.grounded[i]
        if (rec.grounded[i] === 0) sAir++
        if (rec.compression[i] !== null) {
          sComp += rec.compression[i]
          sHave++
        }
      } else if (rec.bin[i] === 'corner') {
        cTicks++
        cGroundSum += rec.grounded[i]
        if (rec.grounded[i] === 0) cAir++
      }
    }
    wheelContact.metrics = {
      straightSamples: sTicks,
      meanGroundedOnStraight: sTicks ? sGroundSum / sTicks : null,
      airborneFracOnStraight: sTicks ? sAir / sTicks : null,
      meanCompressionOnStraight: sHave ? sComp / sHave : null,
      cornerSamples: cTicks,
      meanGroundedInCorner: cTicks ? cGroundSum / cTicks : null,
      airborneFracInCorner: cTicks ? cAir / cTicks : null,
      maxSpeedReached: info.maxSpeed,
      speedCeilingCommanded: CFG.speedMax,
      meanGroundedGate: CFG.minMeanGroundedWheels,
      airborneFracGate: CFG.maxAirborneFrac,
    }
    if (info.noWheelTicks === nS) {
      pend(wheelContact, 'no tick carried a four-wheel KartState.wheels array; wheel contact was never observed')
    } else if (sTicks * CFG.stride < CFG.minBinTicks) {
      pend(
        wheelContact,
        `only ${sTicks * CFG.stride} usable ticks of settled straight road carried wheel state (floor ` +
          `${CFG.minBinTicks}). This gate MEASURED NOTHING.`,
      )
    } else {
      const g = sGroundSum / sTicks
      const air = sAir / sTicks
      const why =
        `Graded on settled STRAIGHT road only: nothing there launches a kart, and lateral load transfer needs ` +
        `lateral acceleration a straight does not demand (median demand ${bStraight.medianLatAccel.toFixed(2)} m/s²). ` +
        `The corner bin is reported and never gated, because a kerb or a hard corner legitimately lifts a wheel. ` +
        `A kart that cannot keep its tyres on a flat road has no grip to corner with — and a slip-angle gate need ` +
        `not notice, because a kart with a fraction of its grip still corners, just wide.`
      if (!(g >= CFG.minMeanGroundedWheels)) {
        fail(
          wheelContact,
          `mean wheels in contact on settled straight road is ${g.toFixed(2)} of 4 (floor ` +
            `${CFG.minMeanGroundedWheels}), over ${(sTicks * CFG.stride * CFG.simStep).toFixed(1)} s at ` +
            `${bStraight.meanSpeed.toFixed(1)} m/s, mean suspension compression ` +
            `${wheelContact.metrics.meanCompressionOnStraight === null ? '-' : wheelContact.metrics.meanCompressionOnStraight.toFixed(3)} ` +
            `(0 = fully extended, 1 = bottomed out). ${why}`,
        )
      }
      if (!(air <= CFG.maxAirborneFrac)) {
        fail(
          wheelContact,
          `${(air * 100).toFixed(1)}% of settled straight-road ticks had ZERO wheels in contact — the kart was fully ` +
            `airborne — against a limit of ${(CFG.maxAirborneFrac * 100).toFixed(0)}%. ${why}`,
        )
      }
      /*
       * THE RANGE OF THE ANSWER, PRINTED WITH THE ANSWER. This probe holds its
       * speed inside a lateral-acceleration budget, which caps it at
       * `CFG.speedMax`. Suspension and tyre-load faults are commonly a function
       * of SPEED rather than of time — a damper that pumps energy in does it
       * harder the faster the road passes under it — so a green here is a green
       * up to the speed actually reached and no further. Saying so is cheaper
       * than a reader assuming otherwise.
       */
      wheelContact.notes.push(
        `graded over ${(sTicks * CFG.stride * CFG.simStep).toFixed(1)} s of straight road up to a peak of ` +
          `${info.maxSpeed.toFixed(1)} m/s, which is the ceiling this probe commands (CFG.speedMax = ` +
          `${CFG.speedMax} m/s, chosen from the lateral-acceleration budget and not from anything about the ` +
          `suspension). A contact failure that only appears ABOVE that speed is outside this run's range and this ` +
          `check says nothing about it. Raise --seconds or CFG.speedMax to extend the range; do not read this pass ` +
          `as covering speeds it never reached.`,
      )
    }
  }

  // =========================================================================
  // straight-hold — open loop, on the longest straight on the lap
  // =========================================================================
  /*
   * The cruise is closed loop, and a closed-loop controller's job is to hide
   * exactly the drift being hunted. So: find the longest genuinely straight
   * stretch on the circuit, put the kart on the centreline at its entry, release
   * the steer entirely, and watch. There is no controller in this measurement at
   * all, which is the point — anything that happens is the kart and the road.
   */
  {
    if (!have.seek) {
      pend(straightHold, 'requires seek; it is not available in this build')
    } else {
      const N = 2048
      const ds = L / N
      const straightAt = new Uint8Array(N)
      for (let i = 0; i < N; i++) straightAt[i] = curvatureAt(i / N) <= CFG.straightCurvature ? 1 : 0
      let bestStart = -1
      let bestLen = 0
      let start = -1
      for (let i = 0; i < 2 * N; i++) {
        const j = i % N
        if (straightAt[j]) {
          if (start < 0) start = i
          const len = i - start + 1
          if (len > bestLen && len <= N) {
            bestLen = len
            bestStart = start
          }
        } else {
          start = -1
        }
      }
      const straightM = bestLen * ds
      const holdSeconds = Math.min(CFG.holdMaxSeconds, (straightM * 0.9) / CFG.holdSpeed)
      straightHold.metrics.longestStraightM = straightM
      straightHold.metrics.holdSeconds = holdSeconds
      straightHold.metrics.entryT = bestStart < 0 ? null : (bestStart % N) / N

      if (bestStart < 0 || holdSeconds < CFG.holdMinSeconds) {
        pend(
          straightHold,
          `the longest stretch of road under |curvature| ${CFG.straightCurvature.toExponential(2)} 1/m is ` +
            `${straightM.toFixed(0)} m, which at ${CFG.holdSpeed} m/s is ${holdSeconds.toFixed(2)} s of open-loop hold ` +
            `(floor ${CFG.holdMinSeconds} s). Shorter than that and the probe has not outlived the transient from the ` +
            `seek, so it MEASURED NOTHING. The closed-loop cruise above still covers straight road; what is missing ` +
            `is the controller-free vantage on it.`,
        )
      } else {
        const t0 = (bestStart % N) / N
        const line0 = track.racingLine(t0)
        // `lateral` is racing-line relative — see `placement` above.
        await h.seek({ t: t0, lateral: -line0, speed: CFG.holdSpeed })
        h.setDriver(pid, 'scripted')
        const holdTicks = Math.round(holdSeconds / CFG.simStep)
        const hold = await drive(holdTicks, { steer: 0, holdSpeed: CFG.holdSpeed })
        if (hold.blocked) {
          pend(straightHold, `the open-loop hold was blocked: ${hold.blocked}`)
        } else {
          const hr = hold.rec
          const slips = []
          const lats = []
          let bankMax = 0
          for (let i = 0; i < hr.tick.length; i++) {
            if (!hr.usable[i]) continue
            slips.push(Math.abs(hr.slipDeg[i]))
            lats.push(hr.lateral[i])
            if (Math.abs(hr.bank[i]) > bankMax) bankMax = Math.abs(hr.bank[i])
          }
          /*
           * A BANKED straight legitimately slides the kart downhill: the road
           * asks for g·sin(bank) of lateral force whether anyone steers or not.
           * That demand goes through the SAME measured compliance as everything
           * else, so a cambered road raises this gate by exactly what the camber
           * costs and not a degree more.
           */
          const bankDemand = CFG.gravity * Math.sin(bankMax)
          const hGate = gateFor(bankDemand, 'open-loop hold')
          const ss = sorted(slips)
          straightHold.metrics.samples = slips.length
          straightHold.metrics.medianSlipDeg = quantile(ss, 0.5)
          straightHold.metrics.maxSlipDeg = ss.length ? ss[ss.length - 1] : null
          straightHold.metrics.startSlipDeg = hr.slipDeg[0]
          straightHold.metrics.endSlipDeg = hr.slipDeg[hr.tick.length - 1]
          straightHold.metrics.lateralTravelM = lats.length ? lats[lats.length - 1] - lats[0] : null
          straightHold.metrics.maxBankDeg = (bankMax * 180) / Math.PI
          straightHold.metrics.bankLatAccel = bankDemand
          straightHold.metrics.gateDeg = hGate.deg
          straightHold.metrics.gateBoundBy = hGate.bound

          if (slips.length * CFG.stride < Math.min(CFG.minBinTicks, holdTicks * 0.5)) {
            pend(
              straightHold,
              `only ${slips.length * CFG.stride} of ${holdTicks} ticks of the hold were usable — the exclusions in ` +
                `'driving' say why. Not enough to grade, and not a pass.`,
            )
          } else if (!(ss[ss.length - 1] <= hGate.deg)) {
            fail(
              straightHold,
              `with the steer released entirely on ${straightM.toFixed(0)} m of straight road, |slip| reached ` +
                `${ss[ss.length - 1].toFixed(2)} deg (median ${quantile(ss, 0.5).toFixed(2)}, gate ` +
                `${hGate.deg.toFixed(2)} deg set by ${hGate.bound}). It began the hold at ` +
                `${(hr.slipDeg[0] === null ? 0 : hr.slipDeg[0]).toFixed(2)} deg and ended at ` +
                `${(straightHold.metrics.endSlipDeg === null ? 0 : straightHold.metrics.endSlipDeg).toFixed(2)} deg, ` +
                `moving ${(straightHold.metrics.lateralTravelM || 0).toFixed(2)} m across the road. There is no ` +
                `controller in this measurement: nothing steered, nothing corrected. The road's own camber here is ` +
                `${straightHold.metrics.maxBankDeg.toFixed(2)} deg, which is already allowed for in the gate.`,
            )
          }
        }
      }
    }
  }

  /*
   * COMMAND-PATH OUTRANKS EVERYTHING. If this file could not observe its own
   * commands arriving, no slip number below is attributable to them, and each
   * one is downgraded to PENDING. `pend` only moves a PASS — a check that
   * already went red stays red, because a fault it found is still a fault
   * whoever was driving.
   */
  if (!commandsReached) {
    for (const c of [slipStraight, slipCorner, laneDrift, wheelContact, straightHold]) {
      pend(
        c,
        `command-path did not confirm that this file's commands reached the kart, so whatever was measured here is ` +
          `not a measurement of the commands above. A slip harness driving nothing reports zero and passes; this ` +
          `refuses to print that pass.`,
      )
    }
  }

  // -- the report keeps a decimated series so a human can look at the shape --
  const every = Math.max(1, Math.round(0.1 / (CFG.simStep * CFG.stride)))
  const series = []
  for (let i = 0; i < nS; i += every) {
    series.push({
      s: +(rec.tick[i] * CFG.simStep).toFixed(3),
      slipDeg: rec.slipDeg[i] === null ? null : +rec.slipDeg[i].toFixed(3),
      lateral: +rec.lateral[i].toFixed(3),
      kappa: +rec.kappa[i].toFixed(5),
      speed: +rec.speed[i].toFixed(2),
      steer: +rec.steer[i].toFixed(3),
      bin: rec.bin[i],
      onTrack: rec.onTrack[i],
      surfKart: rec.surfaceKart[i],
      surfTrack: rec.surfaceTrack[i],
      usable: rec.usable[i],
    })
  }
  R.info.series = series

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
 * THE KART IS A REAL SINGLE-TRACK BICYCLE MODEL WITH LINEAR TYRES, and that is
 * the whole reason this self-test is worth anything. `steer-test.mjs` can get
 * away with a kinematic reference — velocity along the chassis, no slip at all —
 * because it grades a SIGN. This file grades a slip angle, so a reference with
 * no slip in it would only ever prove that zero is less than the gate. Here the
 * body slip angle is an OUTPUT of the tyre equations:
 *
 *     alpha_f = delta - (vLat + a*r) / vLong        front tyre slip
 *     alpha_r =       - (vLat - b*r) / vLong        rear tyre slip
 *     m (vLatDot + r vLong) = Cf alpha_f + Cr alpha_r
 *     Iz rDot               = a Cf alpha_f - b Cr alpha_r
 *     beta = atan2(vLat, vLong)                     what this file measures
 *
 * which produces essentially zero slip on the straights and a few degrees in
 * the bends, all by itself, from parameters that are a kart. That is the shape
 * the gate has to be able to pass, and nobody chose it.
 *
 * THE TRACK is a stadium: two 180 m straights joined by two 80 m-radius
 * semicircles, flat and unbanked, with a SandDrift band across a fifth of the
 * lap so `surfaceAt` has more than one answer and the surface cross-check has
 * something to cross-check.
 *
 * SABOTAGES. Each is a plausible mistake rather than a nonsense value, each is
 * owned by one named check, and each declares the STATUS it should produce —
 * two of them PENDING rather than FAIL, because a missing measurement and a
 * failed one are different findings. One is a DECOY that must be caught by
 * NOTHING.
 */
function installReferenceWorld(sabotage, CFG) {
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

  const SIM_STEP = CFG.simStep
  const SURF = CFG.surface
  const MARGIN = CFG.barrierMargin

  // -- the stadium -----------------------------------------------------------
  const STRAIGHT = 180
  const RADIUS = 80
  const HALF_WIDTH = 9
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
    let px, pz, tx, tz, k
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

  const P = 2048
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
    const lateral = dx * locScratch.right.x + dz * locScratch.right.z
    const honestOnTrack = Math.abs(lateral) <= HALF_WIDTH + MARGIN
    out.t = bt
    out.lateral = lateral
    out.height = dy
    out.onTrack = S === 'ontrack-inverted' ? !honestOnTrack : honestOnTrack
    out.checkpointIndex = Math.floor(bt * 8)
    return out
  }

  /** More than one answer, so the surface cross-check has work to do. */
  function surfaceAt(t, lateral) {
    const a = Math.abs(lateral)
    if (a > HALF_WIDTH + MARGIN) return SURF.OffTrack
    if (a > HALF_WIDTH) return SURF.Gravel
    const u = wrap01(t)
    if (u >= 0.28 && u < 0.46) return SURF.SandDrift
    return SURF.DustyAsphalt
  }

  const rlScratch = mkSample()
  function racingLine(t) {
    frameAt(wrap01(t) * LENGTH, rlScratch)
    return 0.5 * HALF_WIDTH * Math.tanh(rlScratch.curvature * 40)
  }

  const startGrid = [
    { position: vec(), orientation: { x: 0, y: 0, z: 0, w: 1 }, t: 0.01 },
    { position: vec(), orientation: { x: 0, y: 0, z: 0, w: 1 }, t: 0.004 },
    { position: vec(), orientation: { x: 0, y: 0, z: 0, w: 1 }, t: 0.0 },
  ]

  const track = {
    length: LENGTH,
    group: { position: vec() },
    sample,
    locate,
    surfaceAt,
    racingLine,
    checkpoints: [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875],
    startGrid,
  }

  // -- the kart --------------------------------------------------------------
  /*
   * Yaw about +Y. Rotating (0,0,-1) by `a` about +Y gives (-sin a, 0, -cos a),
   * whose derivative with respect to `a` is -right. So INCREASING yaw turns the
   * kart LEFT, and a rightward yaw rate must DECREASE it. `r` below is positive
   * to the driver's RIGHT, in the same space as `vLat` and `steer`, which is why
   * the pose integration reads `yaw -= r * dt` and why nothing else on this page
   * needs a sign flip.
   */
  const M = 180
  const IZ = 110
  const A_LEN = 0.55
  const B_LEN = 0.55
  const SOFT = S === 'soft-tyres' ? 0.5 : 1
  const CF = 12000 * SOFT
  const CR = 12000 * SOFT
  const MAX_STEER_RAD = 0.45
  const TOP_SPEED = 30
  const ACCEL_K = 0.02
  const BRAKE_A = 12

  const idleFrame = { steer: 0, throttle: 0, brake: 0, drift: false, useItem: false, look: 0 }
  const NKARTS = 3
  const karts = []
  for (let i = 0; i < NKARTS; i++) {
    karts.push({ id: i, x: 0, y: 0, z: 0, yaw: 0, vLong: 0, vLat: 0, r: 0, steerRad: 0, mode: 'idle', frame: { ...idleFrame }, respawns: 0 })
  }
  const PLAYER = 0
  let injected = { ...idleFrame }
  let phase = 'idle'
  let tick = 0
  let raceStartTick = 0
  let nonce = 0

  function placeAt(k, t, lateral, speed) {
    const s = mkSample()
    frameAt(wrap01(t) * LENGTH, s)
    k.x = s.position.x + s.right.x * lateral
    k.y = 0
    k.z = s.position.z + s.right.z * lateral
    k.yaw = Math.atan2(-s.tangent.x, -s.tangent.z)
    k.vLong = speed === undefined ? 0 : speed
    k.vLat = 0
    k.r = 0
  }

  /** The extra lateral velocity a sabotage injects. Nothing else touches it. */
  function slideOffset() {
    if (S === 'body-slide') return 1.5
    if (S === 'slip-ramps') {
      const secs = Math.max(0, (tick - raceStartTick) * SIM_STEP)
      return Math.min(1.5, 0.12 * secs)
    }
    return 0
  }

  function stepKart(k) {
    /*
     * `commands-ignored` models the phase-gate trap exactly: the DRIVER still
     * reports the frame it was handed — so `lastInput` agrees perfectly and a
     * harness checking only that route prints a pass — while the physics runs on
     * the idle frame. Nothing throws. The kart simply is not being driven.
     */
    const wanted = k.mode === 'scripted' ? injected : idleFrame
    const frame = S === 'commands-ignored' ? idleFrame : wanted
    k.frame = { ...wanted }
    let steer = Math.max(-1, Math.min(1, frame.steer))
    if (S === 'nondeterministic') {
      /*
       * The stream is deliberately NOT reset by `resetRace` — see the note
       * there. A perturbation that restarts with the race is perfectly
       * repeatable and the determinism check correctly reports a pass on it,
       * which is exactly what the first version of this sabotage did. What
       * breaks determinism in a real build is state that outlives the reset: a
       * wall clock, or one RNG stream shared across races.
       *
       * The amplitude is small on purpose. It must break bit-identity by orders
       * of magnitude (the floor is 1e-4 m) without wandering the kart off the
       * road, or `driving` fails too and the sabotage stops being about
       * determinism.
       */
      nonce = (nonce * 1103515245 + 12345) & 0x7fffffff
      steer += (nonce / 0x7fffffff - 0.5) * 0.002
    }
    const delta = steer * MAX_STEER_RAD
    k.steerRad = delta

    if (phase !== 'racing') return

    // Longitudinal
    if (S === 'stuck') {
      // Frozen, and frozen COMPLETELY. Zeroing only the forward speed leaves the
      // tyre equations dividing by it, which produces NaN positions and a
      // `driving` failure that reads as arithmetic rather than as a stuck kart.
      k.vLong = 0
      k.vLat = 0
      k.r = 0
      return
    }
    const target = frame.throttle * TOP_SPEED
    k.vLong += (target - k.vLong) * ACCEL_K
    if (frame.brake > 0) k.vLong -= frame.brake * BRAKE_A * SIM_STEP
    if (k.vLong < 0.05) k.vLong = 0.05

    // Lateral: linear-tyre single-track model. The denominator is floored, as
    // every real single-track model floors it: the slip-angle definition has a
    // singularity at rest and a kart on a grid is at rest.
    const vRef = Math.max(0.5, k.vLong)
    const af = delta - (k.vLat + A_LEN * k.r) / vRef
    const ar = -(k.vLat - B_LEN * k.r) / vRef
    const fyf = CF * af
    const fyr = CR * ar
    k.vLat += ((fyf + fyr) / M - k.r * k.vLong) * SIM_STEP
    k.r += ((A_LEN * fyf - B_LEN * fyr) / IZ) * SIM_STEP

    k.yaw -= k.r * SIM_STEP
    const fx = -Math.sin(k.yaw)
    const fz = -Math.cos(k.yaw)
    const rx = Math.cos(k.yaw)
    const rz = -Math.sin(k.yaw)
    const vLatTotal = k.vLat + slideOffset()
    k.x += (fx * k.vLong + rx * vLatTotal) * SIM_STEP
    k.z += (fz * k.vLong + rz * vLatTotal) * SIM_STEP
  }

  function stepOne() {
    for (const k of karts) stepKart(k)
    tick++
    if (phase === 'countdown' && tick > countdownEndsAt) {
      phase = 'racing'
      raceStartTick = tick
    }
  }
  let countdownEndsAt = 0

  const snapLoc = { t: 0, lateral: 0, height: 0, onTrack: true, checkpointIndex: 0 }
  const snapP = vec()

  function snapshot(k) {
    const vLatTotal = k.vLat + slideOffset()
    const fx = -Math.sin(k.yaw)
    const fz = -Math.cos(k.yaw)
    const rx = Math.cos(k.yaw)
    const rz = -Math.sin(k.yaw)
    const beta = Math.atan2(vLatTotal, Math.max(1e-6, k.vLong))
    snapP.set(k.x, k.y, k.z)
    locate(snapP, snapLoc)
    let surf = surfaceAt(snapLoc.t, snapLoc.lateral)
    if (S === 'surface-lies') surf = SURF.Asphalt
    let reportedSlip = beta
    if (S === 'drift-slip-zero') reportedSlip = 0
    if (S === 'drift-slip-3x') reportedSlip = beta * 3
    /*
     * `hovering` lifts the kart off the road ABOVE A SPEED and leaves the tyre
     * equations completely untouched, so it still drives and still slips exactly
     * as much as it did before. That is the whole demonstration: slip-straight
     * must stay QUIET and wheel-contact must go red, which is the evidence that
     * a slip-angle gate does not subsume a grip one.
     */
    const airborne = S === 'hovering' && k.vLong > 15
    const wheel = (sa) => ({
      compression: airborne ? 0.02 : 0.5,
      steerAngle: sa,
      spin: 0,
      grounded: !airborne,
      surface: surf,
      slip: 0,
    })
    return {
      position: { x: k.x, y: k.y, z: k.z },
      quaternion: { x: 0, y: Math.sin(k.yaw / 2), z: 0, w: Math.cos(k.yaw / 2) },
      velocity: { x: fx * k.vLong + rx * vLatTotal, y: 0, z: fz * k.vLong + rz * vLatTotal },
      speed: k.vLong,
      surface: surf,
      grounded: true,
      drift: { active: false, direction: 0, charge: 0, tier: 0, slipAngle: reportedSlip },
      boost: { active: false, remaining: 0, strength: 1, source: 'none' },
      wheels: [wheel(k.steerRad), wheel(k.steerRad), wheel(0), wheel(0)],
      stunTime: 0,
    }
  }

  const telLoc = { t: 0, lateral: 0, height: 0, onTrack: true, checkpointIndex: 0 }
  const telP = vec()

  window.__harness = {
    version: 2,
    ready: Promise.resolve(),
    get playerKartId() {
      return PLAYER
    },
    get track() {
      return track
    },
    lastInput(id) {
      const k = karts.find((x) => x.id === id)
      return k ? k.frame : null
    },
    async resetRace(options) {
      phase = 'idle'
      tick = 0
      // `nonce` is NOT reset. Anything a reset puts back is repeatable by
      // construction; the state that breaks determinism is the state that
      // survives one. See the `nondeterministic` sabotage.
      injected = { ...idleFrame }
      for (let i = 0; i < karts.length; i++) {
        const k = karts[i]
        k.mode = (options && options.drivers && options.drivers[k.id]) || 'referenceAI'
        k.respawns = 0
        placeAt(k, startGrid[i % startGrid.length].t, racingLine(startGrid[i % startGrid.length].t), 0)
      }
    },
    startRace() {
      phase = 'countdown'
      countdownEndsAt = tick + 360
    },
    setDriver(id, mode) {
      const k = karts.find((x) => x.id === id)
      if (k) k.mode = mode
    },
    setInput(frame) {
      injected = Object.assign({}, injected, frame)
      karts[PLAYER].mode = 'scripted'
    },
    releaseInput() {
      injected = { ...idleFrame }
      if (karts[PLAYER].mode === 'scripted') karts[PLAYER].mode = 'human'
    },
    async stepTicks(n) {
      for (let i = 0; i < n; i++) stepOne()
    },
    /*
     * FAITHFUL TO src/main.ts: `lateral` is added to `racingLine(t)` before it
     * reaches `placeAt`, and the rest of the field is scattered evenly round the
     * lap and idled. The `seek-double-racing-line` sabotage applies the line
     * twice — the exact mistake that cost this project a round — so the
     * `placement` guard has something real to catch.
     */
    async seek(o) {
      const line = racingLine(o.t)
      const lat = (S === 'seek-double-racing-line' ? 2 * line : line) + (o.lateral || 0)
      for (let i = 0; i < karts.length; i++) {
        if (i === PLAYER) continue
        placeAt(karts[i], (o.t + i / karts.length) % 1, racingLine((o.t + i / karts.length) % 1), 0)
        karts[i].mode = 'idle'
      }
      placeAt(karts[PLAYER], o.t, lat, o.speed)
      stepOne()
    },
    telemetry() {
      return {
        sinceTick: 0,
        tick,
        phase,
        clock: tick * SIM_STEP,
        karts: karts.map((k) => {
          telP.set(k.x, k.y, k.z)
          locate(telP, telLoc)
          return {
            kartId: k.id,
            driftAttempts: 0,
            driftReleases: [0, 0, 0, 0],
            boostSecondsBySource: {},
            respawns: k.respawns,
            wallHits: 0,
            lapTimes: [],
            bestLap: null,
            finished: false,
            completedLaps: 0,
            lastCheckpoint: telLoc.checkpointIndex,
            t: telLoc.t,
            lateral: telLoc.lateral,
            ticksWithoutProgress: 0,
          }
        }),
      }
    },
    kartSnapshot(id) {
      const k = karts.find((x) => x.id === id)
      return k ? snapshot(k) : null
    },
  }
}

// ---------------------------------------------------------------------------
// Which check owns which sabotage, which status it must produce, and which
// checks must stay QUIET
// ---------------------------------------------------------------------------
const SABOTAGES = [
  {
    name: 'body-slide',
    owner: 'slip-straight',
    expect: 'FAIL',
    quiet: ['slip-corner', 'surface-report'],
    what: 'a constant 1.5 m/s of lateral velocity — the whole body slides, exactly as reported by the human',
  },
  {
    name: 'slip-ramps',
    owner: 'slip-straight',
    expect: 'FAIL',
    quiet: ['slip-corner'],
    shortProbeMustStayClean: true,
    what: 'the slide GROWS from nothing over ~12 s. A 0.30 s probe sees nothing; that is why this file is long',
  },
  {
    name: 'surface-lies',
    owner: 'surface-report',
    expect: 'FAIL',
    quiet: ['slip-straight', 'slip-corner'],
    what: 'KartState.surface says Asphalt everywhere while the track says SandDrift — a grip story, not a slip one',
  },
  {
    name: 'ontrack-inverted',
    owner: 'surface-report',
    expect: 'FAIL',
    what: 'TrackLocation.onTrack is negated: a kart in the middle of the road reads as past the barrier',
  },
  {
    name: 'drift-slip-3x',
    owner: 'slip-agreement',
    expect: 'FAIL',
    quiet: ['slip-straight', 'slip-corner'],
    what: "the kart's own DriftState.slipAngle is three times the truth — the drift ladder reads a number that is not slip",
  },
  {
    name: 'drift-slip-zero',
    owner: 'slip-agreement',
    expect: 'PEND',
    quiet: ['slip-straight', 'slip-corner'],
    what: 'DriftState.slipAngle is identically zero. Not populated and wrong are different findings: PENDING, not FAIL',
  },
  {
    name: 'nondeterministic',
    owner: 'determinism',
    expect: 'FAIL',
    what: 'a per-tick perturbation — "it slid after twenty seconds" stops being a reproducible observation',
  },
  {
    name: 'seek-double-racing-line',
    owner: 'placement',
    expect: 'FAIL',
    what: 'seek applies racingLine twice. THE round-costing bug, guarded rather than remembered',
  },
  {
    name: 'stuck',
    owner: 'driving',
    expect: 'FAIL',
    pend: ['slip-straight'],
    what: 'the kart never moves. driving must go red and slip-straight must PEND, not print a green gate over nothing',
  },
  {
    name: 'commands-ignored',
    owner: 'command-path',
    expect: 'FAIL',
    pend: ['slip-straight', 'slip-corner', 'wheel-contact'],
    what: "the physics runs on the idle frame while lastInput still echoes ours — a phase gate in driverFrame, exactly",
  },
  {
    name: 'hovering',
    owner: 'wheel-contact',
    expect: 'FAIL',
    quiet: ['slip-straight', 'slip-corner', 'slip-agreement'],
    what: 'the kart flies above 15 m/s with the tyre model untouched. THE proof that a slip gate does not subsume a grip one',
  },
  {
    name: 'soft-tyres',
    owner: null,
    expect: 'QUIET',
    what: 'DECOY: half the cornering stiffness, so it legitimately corners at ~6 deg of slip. NOTHING may fire',
  },
]

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
const CHECK_ORDER = [
  'surface',
  'placement',
  'command-path',
  'driving',
  'determinism',
  'slip-straight',
  'slip-corner',
  'lane-drift',
  'surface-report',
  'slip-agreement',
  'wheel-contact',
  'straight-hold',
]

function fmt(n, digits = 3) {
  if (n === null || n === undefined) return '-'
  if (!Number.isFinite(n)) return String(n)
  if (n !== 0 && (Math.abs(n) < 1e-3 || Math.abs(n) >= 1e6)) return n.toExponential(2)
  return n.toFixed(digits)
}
const pct = (x) => (x === null || x === undefined ? '-' : `${(x * 100).toFixed(1)}%`)

function summarise(c) {
  const m = c.metrics
  switch (c.id) {
    case 'surface':
      return `${m.live ?? 0} live, ${m.pending ?? 0} pending`
    case 'placement':
      return `racingLine ${fmt(m.racingLineM, 2)} m at t=${fmt(m.t, 4)}  ->  landed ${fmt(m.landedLateralM, 3)} m from the centreline (±${fmt(m.toleranceM, 2)} m)`
    case 'command-path':
      return `lastInput mismatch ${pct(m.lastInputMismatchFrac)}   wheel angle observed ${pct(m.wheelObservedFrac)} of ${m.steerCommandedTicks ?? '-'} commanded ticks   sign agrees ${pct(m.wheelSignAgreeFrac)}`
    case 'wheel-contact':
      return `straight: ${fmt(m.meanGroundedOnStraight, 2)}/4 grounded (floor ${fmt(m.meanGroundedGate, 1)}), airborne ${pct(m.airborneFracOnStraight)}, compression ${fmt(m.meanCompressionOnStraight, 3)}   corner: ${fmt(m.meanGroundedInCorner, 2)}/4, airborne ${pct(m.airborneFracInCorner)}   peak speed ${fmt(m.maxSpeedReached, 1)} m/s`
    case 'driving':
      return `${fmt(m.distanceM, 0)} m in ${fmt(m.seconds, 1)} s at ${fmt(m.meanSpeed, 1)} m/s   onTrack ${pct(m.onTrackFrac)}   usable ${pct(m.usableFrac)}   respawns ${m.respawns ?? '-'}`
    case 'determinism':
      return `over ${fmt(m.seconds, 1)} s: slip ${fmt(m.maxSlipSpreadDeg)} deg, lateral ${fmt(m.maxLateralSpreadM)} m, speed ${fmt(m.maxSpeedSpreadMs)} m/s`
    case 'slip-straight':
      return `median ${fmt(m.medianSlipDeg, 2)} deg  p95 ${fmt(m.p95SlipDeg, 2)}  max ${fmt(m.maxSlipDeg, 2)}   gate ${fmt(m.gateDeg, 2)} deg   over ${fmt(m.seconds, 1)} s`
    case 'slip-corner':
      return `median ${fmt(m.medianSlipDeg, 2)} deg at ${fmt(m.medianLatAccel, 2)} m/s²  ->  compliance ${fmt(m.complianceDegPerMs2)} deg per m/s²   peak ${fmt(m.maxSlipDeg, 2)} deg (spin ${fmt(m.spinGateDeg, 0)})`
    case 'lane-drift':
      return `same side ${pct(m.signConsistency)}   net ${fmt(m.netTravelM, 2)} m   trend ${fmt(m.trendMPerSecond)} m/s   ${fmt(m.crossingsPerMinute, 1)} crossings/min`
    case 'surface-report':
      return (
        `kart vs track disagree ${pct(m.disagreeFrac)} (grip-changing ${pct(m.gripChangingDisagreeFrac)})   ` +
        `contradiction runs ${m.longestContradictionRunTicks ? `${m.longestContradictionRunTicks.offTrackWithRoadSurface}/${m.longestContradictionRunTicks.insideRoadButOffTrack}` : '-'} ticks ` +
        `(tolerance ${m.contradictionRunToleranceTicks ?? '-'}, totals ${m.contradictionOffTrackWithRoadSurface ?? '-'}/${m.contradictionInsideRoadButOffTrack ?? '-'})`
      )
    case 'slip-agreement':
      return `p95 |diff| ${fmt(m.p95DiffDeg, 2)} deg (gate ${fmt(m.gateDeg, 1)})   max ${fmt(m.maxDiffDeg, 2)}   reported-all-zero ${m.reportedAllZero === undefined ? '-' : m.reportedAllZero}`
    case 'straight-hold':
      return `${fmt(m.longestStraightM, 0)} m straight, ${fmt(m.holdSeconds, 2)} s open loop: max ${fmt(m.maxSlipDeg, 2)} deg (gate ${fmt(m.gateDeg, 2)})   moved ${fmt(m.lateralTravelM, 2)} m`
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

/** The curvature axis, printed, because "slip correlates with curvature" is the
 *  whole reason a single pooled number would have been worthless. */
function printBins(result) {
  const b = result.info && result.info.bins
  if (!b) return
  console.log('')
  console.log('SLIP AGAINST CURVATURE — the axis, not a summary')
  console.log('  bin          ticks   median |slip|   p95     max     demand m/s²   peak m/s²   mean speed   mean steer   mean |steer|')
  for (const key of ['straight', 'transition', 'corner']) {
    const x = b[key]
    if (!x) continue
    console.log(
      `  ${key.padEnd(11)}${String(x.ticks).padStart(6)}   ${fmt(x.medianSlipDeg, 2).padStart(13)}   ` +
        `${fmt(x.p95SlipDeg, 2).padStart(5)}   ${fmt(x.maxSlipDeg, 2).padStart(5)}   ` +
        `${fmt(x.medianLatAccel, 2).padStart(11)}   ${fmt(x.maxLatAccel, 2).padStart(9)}   ` +
        `${fmt(x.meanSpeed, 1).padStart(10)}   ${fmt(x.meanSteer, 4).padStart(10)}   ${fmt(x.meanAbsSteer, 4).padStart(12)}`,
    )
  }
  console.log(
    '  `transition` is the first 0.5 s of straight road after a corner, where the yaw mode is still unwinding. It is\n' +
      '  reported and pooled into neither gate: folding corner exits into the straight bin is how a harness invents a\n' +
      '  slip problem out of correct physics.\n' +
      '  The last three columns are the CONTROLLER, printed so its contribution can be argued with. `demand` is what\n' +
      '  the ROAD asks for at the speed being held (v² x curvature) and is capped by design at the CFG budget; if the\n' +
      '  demand is inside the budget and `mean |steer|` is small while the slip is large, the slip is not the driving.',
  )
  const st = result.checks.find((c) => c.id === 'slip-straight')
  if (st && st.metrics && st.metrics.firstShortProbeMaxDeg !== undefined) {
    console.log('')
    console.log(
      `WOULD A SHORT PROBE HAVE SEEN IT?  max |slip| inside the first ${fmt(st.metrics.shortProbeSeconds, 2)} s ` +
        `(the window steer-test gives its AI probe) was ${fmt(st.metrics.firstShortProbeMaxDeg, 3)} deg, against ` +
        `${fmt(st.metrics.maxSlipDeg, 3)} deg over the whole settled straight run. If the first number is small and\n` +
        `  the second is not, every existing harness in this repo is blind to what this one is looking at.`,
    )
  }
}

// ---------------------------------------------------------------------------
// The contract surface this file would like and does not have
// ---------------------------------------------------------------------------
const CONTRACT_NOTES = `
  WHAT THIS HARNESS STILL CANNOT SEE — no contract change made here; that is the lead's
  ─────────────────────────────────────────────────────────────────────────────────────
  · PER-WHEEL slip. KartState.wheels[].slip is "0..1, how much this wheel is
    sliding" — a normalised magnitude with no sign and no stated relationship to
    a slip ANGLE, so it cannot separate "the front is washing out" from "the rear
    has stepped out". Those are opposite bugs with opposite fixes and this file
    reports one number for the body. A signed per-wheel slip angle would split
    them; nothing in the contract offers one.

  · YAW RATE. Neither KartState nor HarnessAPI exposes angular velocity. Body
    slip and yaw rate together separate a kart that is rotating without turning
    from one that is turning without rotating; alone, slip cannot. This file
    differences quaternions across a tick only for its teleport detector, and
    does not claim a yaw rate from it.

  · ANYTHING ABOVE ITS OWN SPEED CEILING. The cruise picks its speed from a
    lateral-acceleration budget and never exceeds CFG.speedMax. Suspension and
    tyre-load faults are often a function of SPEED, not of elapsed time, so every
    green on this page is green up to the peak speed wheel-contact prints and
    no further. This is the widest hole in the file and it is a design choice,
    not an oversight: driving faster than the budget means asking the tyres for
    the limit, and then a slide is no longer evidence of anything.

  · WHY the kart slid. This is an instrument, not a diagnosis. It reports that
    the slip is there, where on the lap, on what surface, at what demand, and
    whether the kart's own report of it agrees. What it deliberately does NOT do
    is pick a cause — a gate shaped around one hypothesis cannot falsify it.

  · A HUMAN'S "it feels like it slides". Slip angle is the measurable that best
    matches the words, and it is not the same thing. A camera lagging the
    chassis, a visual model root that yaws separately from the collider, or a
    ground-plane texture scrolling wrong all read as sliding and none of them
    move this number. A screenshot cannot find a gameplay bug; a physics probe
    cannot find a presentation one.
`

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------
const BATTERY_SRC = battery.toString()
const REFERENCE_SRC = installReferenceWorld.toString()

async function runIn(page, cfg) {
  return page.evaluate(
    async ({ src, c }) => {
      const fn = new Function('return (' + src + ')')()
      return fn(c)
    },
    { src: BATTERY_SRC, c: cfg },
  )
}

async function install(page, sabotage, cfg) {
  await page.evaluate(
    ({ src, sab, c }) => {
      const fn = new Function('return (' + src + ')')()
      fn(sab, c)
    },
    { src: REFERENCE_SRC, sab: sabotage, c: cfg },
  )
}

async function main() {
  if (MODE === 'live') {
    /*
     * A port of its own, and not out of tidiness. Harnesses in this repo run in
     * parallel under the Gauntlet Loop, and `vite-server.mjs` correctly REFUSES
     * to adopt a listening server rather than risk serving another worktree's
     * build into this measurement. Two harnesses both defaulting to 4173
     * therefore means the second one dies. `--port=` overrides.
     */
    const server = await startServer({ mode: useDev ? 'dev' : 'preview', port: argNum('port', useDev ? 5178 : 4178) })
    const browser = await launch({ timing: false })
    try {
      // `quality: 'low'` on purpose: this harness steps thousands of ticks and
      // presents a frame for each, and nothing it measures is a pixel.
      const { page, consoleErrors } = await openGame(browser, server.url, { seed: CFG.seed, quality: 'low' })
      const out = await runIn(page, CFG)

      console.log('slip-check — does the kart stay pointed where it is going, over a long run?')
      console.log(
        `             ${CFG.runSeconds} s of simulated driving, sampled every ${CFG.stride === 1 ? 'tick' : `${CFG.stride} ticks`} ` +
          `(${CFG.simStep.toFixed(5)} s), scripted commands only`,
      )
      console.log('')

      if (out.blocked) {
        console.log('PENDING  window.__harness is absent — the game did not boot. Nothing was measured.')
        console.log('         The instrument itself is proven: node tools/slip-check.mjs --broken')
        process.exitCode = 1
        return
      }

      const { failed, pending } = printReport(out)
      printBins(out)
      writeFileSync(path.join(OUT, 'slip-check.json'), JSON.stringify(out, null, 2))
      console.log('')
      if (out.missing.length) {
        console.log(
          `PENDING  ${out.missing.length} HarnessAPI method(s) refused with the "not available yet" marker: ` +
            `${out.missing.join(', ')}. Everything downstream of them measured NOTHING.`,
        )
      }
      for (const b of out.broke) console.log(`FAIL     ${b}`)
      console.log(CONTRACT_NOTES)
      console.log(`report   ${path.join(OUT, 'slip-check.json')}`)
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
        console.log(
          `PASS — over ${CFG.runSeconds} s of scripted driving the kart's heading and its velocity stayed together on ` +
            `straight road, and its corner slip is reported rather than assumed.`,
        )
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
   * unavailable during exactly the window when the instrument is unproven.
   */
  const browser = await launch({ timing: false })
  try {
    const page = await browser.newPage()
    page.on('pageerror', (e) => console.error(`page error: ${e}`))
    await page.goto('about:blank')

    console.log('slip-check — self-test against a reference world with a real tyre model')
    console.log('')

    await install(page, 'none', CFG)
    const clean = await runIn(page, CFG)
    if (clean.blocked) {
      console.error(`SELF-TEST FAILED — the reference world did not install: ${clean.blocked}`)
      process.exitCode = 1
      return
    }
    console.log('reference (unsabotaged)')
    const { failed, pending } = printReport(clean)
    printBins(clean)
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
    if (pending.length) {
      console.error(
        `SELF-TEST FAILED — the clean reference left ${pending.map((c) => c.id).join(', ')} PENDING; the reference is\n` +
          `meant to exercise every check. A PENDING here means the sabotages below are being asked to break a gate\n` +
          `that was never running.`,
      )
      process.exitCode = 1
      return
    }
    if (MODE === 'reference') {
      console.log('PASS — the reference world satisfies every check, with a tyre model that genuinely slips in corners.')
      return
    }

    console.log('sabotages — each must produce the STATUS it owns, and leave the named others QUIET')
    console.log('')
    const misses = []
    const rows = []
    for (const sab of SABOTAGES) {
      await install(page, sab.name, CFG)
      const out = await runIn(page, CFG)
      const byId = new Map((out.checks || []).map((c) => [c.id, c]))
      const reds = (out.checks || []).filter((c) => c.status === 'FAIL').map((c) => c.id)
      const pends = (out.checks || []).filter((c) => c.status === 'PEND').map((c) => c.id)

      let caught
      if (sab.owner === null) {
        // The decoy. "Caught" means nothing fired at all.
        caught = reds.length === 0 && pends.length === 0
      } else {
        const target = byId.get(sab.owner)
        caught = Boolean(target && target.status === sab.expect)
      }

      /*
       * "Quiet" means DID NOT GO RED, not "reported PASS". A check that is
       * PENDING because there was nothing to measure has not fired, and
       * demanding PASS would make the independence test fail for a reason that
       * has nothing to do with independence.
       */
      const noisy = (sab.quiet || []).filter((id) => {
        const c = byId.get(id)
        return !c || c.status === 'FAIL'
      })
      const notPending = (sab.pend || []).filter((id) => {
        const c = byId.get(id)
        return !c || c.status !== 'PEND'
      })

      // The long-run argument, asserted rather than claimed.
      let shortProbeNote = ''
      if (sab.shortProbeMustStayClean) {
        const st = byId.get('slip-straight')
        const early = st && st.metrics ? st.metrics.firstShortProbeMaxDeg : null
        const g = st && st.metrics ? st.metrics.gateDeg : null
        const clean36 = early !== null && g !== null && early <= g
        shortProbeNote = `\n                                                    a ${fmt(st?.metrics?.shortProbeSeconds, 2)} s probe saw ${fmt(early, 3)} deg (gate ${fmt(g, 2)}) — ${clean36 ? 'CLEAN, so a short harness would have missed this' : 'NOT clean, so this sabotage does not demonstrate the long-run argument'}`
        if (!clean36) {
          misses.push(
            `${sab.name}: the first ${fmt(st?.metrics?.shortProbeSeconds, 2)} s already exceeded the gate, so this ` +
              `sabotage does not demonstrate that a long run was needed to see it`,
          )
        }
      }

      const collateral = reds.filter((id) => id !== sab.owner)
      const ok = caught && noisy.length === 0 && notPending.length === 0
      rows.push({ name: sab.name, owner: sab.owner, expect: sab.expect, caught, noisy, notPending, reds, pends })
      console.log(
        `${ok ? 'CAUGHT' : 'MISSED'}  ${sab.name.padEnd(24)} -> ${(sab.owner ?? 'nothing').padEnd(15)} ${sab.expect.padEnd(5)}  ${sab.what}` +
          (sab.owner !== null && collateral.length ? `\n                                                    also red: ${collateral.join(', ')}` : '') +
          ((sab.quiet || []).length ? `\n                                                    must stay quiet: ${sab.quiet.join(', ')} — ${noisy.length ? 'DID NOT: ' + noisy.join(', ') : 'held'}` : '') +
          ((sab.pend || []).length ? `\n                                                    must report PEND: ${sab.pend.join(', ')} — ${notPending.length ? 'DID NOT: ' + notPending.join(', ') : 'held'}` : '') +
          shortProbeNote,
      )
      if (caught && sab.owner !== null) {
        const target = byId.get(sab.owner)
        const line = (target.problems[0] || target.notes[0] || '').split('\n')[0]
        console.log(`                                 ${line.slice(0, 150)}`)
      }
      if (!caught) {
        if (sab.owner === null) {
          misses.push(`${sab.name}: the DECOY fired — red: [${reds.join(', ')}] pending: [${pends.join(', ')}]. This harness cannot tell legitimate hard cornering from a slide, which makes every green above meaningless.`)
        } else {
          const target = byId.get(sab.owner)
          misses.push(`${sab.name}: ${sab.owner} reported ${target ? target.status : 'absent'}, expected ${sab.expect}`)
        }
      }
      if (noisy.length) {
        misses.push(
          `${sab.name}: ${noisy.join(', ')} was supposed to stay quiet and did not — the checks are not independent, ` +
            `so "several went red" is not evidence that any one of them works`,
        )
      }
      if (notPending.length) {
        misses.push(
          `${sab.name}: ${notPending.join(', ')} was supposed to report PEND and did not. A gate with nothing to ` +
            `measure printing anything other than PENDING is the failure mode this whole repo is built against`,
        )
      }
    }

    // A harness with the kart surface missing must PEND, never PASS.
    console.log('')
    const stubSrc = (marker) => {
      const t = (n) => `() => { throw new Error('[harness] ${n} ${marker} — the subsystem that provides it has not been built.') }`
      return `({
        version: 2,
        get playerKartId() { throw new Error('[harness] playerKartId ${marker} — the subsystem that provides it has not been built.') },
        get track() { throw new Error('[harness] track ${marker} — the subsystem that provides it has not been built.') },
        lastInput: ${t('lastInput')},
        resetRace: ${t('resetRace')},
        startRace: ${t('startRace')},
        setDriver: ${t('setDriver')},
        setInput: ${t('setInput')},
        releaseInput: ${t('releaseInput')},
        stepTicks: ${t('stepTicks')},
        seek: ${t('seek')},
        telemetry: ${t('telemetry')},
        kartSnapshot: ${t('kartSnapshot')},
      })`
    }
    const stub = await page.evaluate(
      async ({ src, c, stubExpr }) => {
        // eslint-disable-next-line no-new-func
        window.__harness = new Function('return ' + stubExpr)()
        const fn = new Function('return (' + src + ')')()
        return fn(c)
      },
      { src: BATTERY_SRC, c: CFG, stubExpr: stubSrc(PENDING_MARKER) },
    )
    const stubGreen = (stub.checks || []).filter((c) => c.status === 'PASS')
    if (stubGreen.length) {
      misses.push(`a harness with no kart surface still passed: ${stubGreen.map((c) => c.id).join(', ')}`)
      console.log(`MISSED  ${'pending-harness'.padEnd(24)} -> ${stubGreen.map((c) => c.id).join(', ')} reported PASS with nothing to measure`)
    } else {
      console.log(
        `CAUGHT  ${'pending-harness'.padEnd(24)} -> every check reported PEND; none reported PASS. ` +
          `Missing: ${(stub.missing || []).join(', ')}`,
      )
    }

    await page.evaluate(() => {
      delete window.__harness
    })
    const absent = await runIn(page, CFG)
    if (absent.blocked === 'NO_HARNESS') {
      console.log(`CAUGHT  ${'absent-harness'.padEnd(24)} -> blocked: NO_HARNESS`)
    } else {
      misses.push(`an absent __harness produced ${absent.blocked ?? 'a result'} instead of NO_HARNESS`)
      console.log(`MISSED  ${'absent-harness'.padEnd(24)} -> ${absent.blocked ?? 'a result'}`)
    }

    writeFileSync(path.join(OUT, 'slip-check-selftest.json'), JSON.stringify({ rows, misses }, null, 2))
    console.log('')
    if (misses.length) {
      console.error(`SELF-TEST FAILED — ${misses.length} problem(s):`)
      for (const m of misses) console.error(`  ${m}`)
      console.error('A detector nobody has watched fail is not evidence. Fix it before trusting a verdict.')
      process.exitCode = 1
    } else {
      console.log(
        `SELF-TEST PASSED — the reference passes clean with a tyre model that really does slip; all ${SABOTAGES.length}\n` +
          `sabotages produced the status their owning check declared, including the two that must PEND rather than\n` +
          `FAIL; the decoy that corners legitimately at six degrees of slip fired NOTHING; and a harness with nothing\n` +
          `behind it reported PENDING rather than green.`,
      )
    }
  } finally {
    await browser.close()
  }
}

await main()
