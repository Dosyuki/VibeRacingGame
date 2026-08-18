/**
 * THE AUTOMATED PLAYER. Full unattended races, graded on outcomes.
 *
 *   node tools/autoplay.mjs                 # gate the live build
 *   node tools/autoplay.mjs --broken        # self-test: prove every gate fires
 *   node tools/autoplay.mjs --seeds=3       # more circuits, more evidence
 *   node tools/autoplay.mjs --laps=5        # longer races for a tighter noise floor
 *   node tools/autoplay.mjs --port=4179     # run alongside another harness
 *   node tools/autoplay.mjs --repeat=0      # skip the determinism repeat  (PENDING)
 *   node tools/autoplay.mjs --clean=0       # skip the clean control arm   (PENDING)
 *
 * WHAT A RUN COSTS, AND WHY IT USED TO COST AN HOUR
 * -------------------------------------------------
 * `Loop.stepTicks` awaits one requestAnimationFrame PER SIMULATED TICK, because
 * a harness that reads pixels needs each tick to actually present. Under the
 * default correctness browser args rAF is vsync-locked, so ONE SIMULATED TICK
 * COST ONE DISPLAY REFRESH — measured on this machine at 16.67 ms/tick, which is
 * the refresh interval to two decimal places and has nothing to do with the
 * game. A field that cannot finish burns the whole tick budget, and 250k ticks
 * at 16.67 ms is over an hour. Two agents this session gave up waiting.
 *
 * Three changes, all of which are free here because THIS FILE MEASURES NO
 * WALL-CLOCK QUANTITY — every number it grades comes from the tick counter:
 *
 *   vsync off      16.67 -> 8.57 ms/tick   (fps-bench must gate on the mean for
 *                                           this reason; autoplay simply does
 *                                           not care what a frame cost)
 *   quality=low     8.57 -> 6.53 ms/tick   nothing it measures is a pixel
 *   640x360          6.53 -> 4.13 ms/tick   likewise
 *
 * 4.4 ms of what remains is the bare rAF turnaround in headless Chromium with
 * vsync already off — a floor this file cannot cross without a `stepTicks` that
 * does not present, which is a contract question and not one to work around.
 *
 * The fourth change is the tick budget itself. It was per RACE, so a field stuck
 * on lap 1 still simulated three laps' worth of budget to say so. It is now per
 * LAP and CUMULATIVE — see `completes` — which decides the same verdict from a
 * third of the ticks and prints the pace arithmetic that decided it.
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
 *   wall contacts per kart per lap — WHEN ANYTHING CAN MOVE THE COUNTER, see below
 *   WHERE ON THE LAP karts lose time, binned around the circuit and ranked
 *
 * Every threshold above is parsed out of ART_DIRECTION.md at run time rather
 * than copied here. A harness that hardcodes 60% keeps passing after somebody
 * raises the rubric to 70%, and it keeps passing for the wrong reason.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A COUNTER WHOSE SOURCE CANNOT FIRE MUST NOT PRINT A NUMBER
 *
 * For the whole life of this project this file printed, every run:
 *
 *     wall contacts  0 over 24 kart-laps = 0.00 per kart per lap … Reported
 *     because a field that never touches a wall is driving a corridor.
 *
 * NOTHING IN `src/` EVER EMITS `'kart:wall'`. `main.ts` subscribes to it and
 * increments `KartTelemetry.wallHits`; no subsystem publishes it. So the most
 * reassuring value the metric has was also the only value it could ever take,
 * printed beside a sentence inviting exactly the wrong reading.
 *
 * It survived the self-test because the self-test proved the wrong half. The
 * reference game below DRAWS wall hits itself, so the analysis path was
 * exercised end to end against numbers that could never come from the game. A
 * green self-test on an instrument with nothing plugged into it is the trap
 * CLAUDE.md names by name, and this is what it looks like from the inside.
 *
 * So every counter this file reports is now traced back to whatever would have
 * to fire to move it, BY SCANNING `src/` for the emitter at run time — the same
 * discipline as re-deriving the thresholds, and for the same reason: a
 * remembered answer is exactly the plausible-but-unknowable one. The ledger is
 * printed every run, whichever way it comes out. A counter with no emitter is
 * reported UNMEASURABLE and its number is withheld, everywhere it appears.
 *
 * The scanner is itself checked for being inert: if it can find no emitter for
 * ANY event, it refuses to run rather than declaring the whole game unmeasurable
 * from a broken regex.
 * ─────────────────────────────────────────────────────────────────────────────
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
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
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
/*
 * Separate from `argNum` because ZERO IS A MEANINGFUL VALUE for the coverage
 * switches and `argNum` silently discards it — `--repeat=0` parsed by `argNum`
 * would fall through to the default and run the repeat anyway, which is a
 * harness quietly ignoring an instruction about what it covered.
 */
const argCount = (name, dflt) => {
  const a = args.find((x) => x.startsWith(`--${name}=`))
  if (!a) return dflt
  const v = Number(a.split('=')[1])
  return Number.isFinite(v) && v >= 0 ? Math.round(v) : dflt
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
// Counter provenance — can anything in src/ actually move the number we print?
// ---------------------------------------------------------------------------
/*
 * See the header. `wallHits` printed 0.00 per kart per lap for the life of the
 * project because `'kart:wall'` has no publisher; the subscriber in `main.ts`
 * looks exactly as healthy as the four beside it that work.
 *
 * This is a STATIC scan and it is the honest kind of incomplete: it proves an
 * emitter EXISTS in the source, not that the condition guarding it is ever true.
 * An emitter behind `if (false)` still reads as wired here. What it does catch
 * — and what nothing else in this repo catches — is a counter with no publisher
 * at all, which is a different and much quieter failure: there is no line to
 * put a breakpoint on, no test that fails, and the metric reports the most
 * flattering value in its range.
 */
const SRC_DIR = path.join(ROOT, 'src')

function readSourceFiles(dir = SRC_DIR) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...readSourceFiles(full))
    else if (entry.name.endsWith('.ts')) out.push({ path: path.relative(ROOT, full), text: readFileSync(full, 'utf8') })
  }
  return out
}

/**
 * @param {{path:string,text:string}[]} files
 * @returns {Map<string, string[]>} event name -> the `file:line` that publishes it
 */
function scanEmitters(files) {
  const found = new Map()
  // `x.emit('name'` in any receiver form. Deliberately loose: a false POSITIVE
  // makes this file print a number it already printed, which is the status quo;
  // a false negative would newly hide a working metric, which is worse.
  const re = /\.emit\(\s*'([^']+)'/g
  for (const f of files) {
    const lines = f.text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(lines[i])) !== null) {
        const at = `${f.path}:${i + 1}`
        const list = found.get(m[1]) || []
        if (!list.includes(at)) list.push(at)
        found.set(m[1], list)
      }
    }
  }
  return found
}

/*
 * Every number this file puts on the screen, and what would have to happen for
 * it to be anything other than its initial value. `event: null` means the value
 * is read straight off race state or computed in `main.ts`'s fixedUpdate rather
 * than accumulated from the bus — those cannot be audited this way and say so,
 * because "not checked" and "checked and fine" must not print the same.
 */
const REPORTED_COUNTERS = [
  { id: 'driftAttempts', event: 'drift:start', usedBy: 'ladder (denominator), drift-pays (verifies aiDrift took)' },
  { id: 'driftReleases', event: 'drift:release', usedBy: 'ladder (tier-1 and tier-3 rates)' },
  { id: 'boostSecondsBySource.drift', event: 'boost:start', usedBy: 'reported in the JSON report' },
  { id: 'respawns', event: 'kart:respawn', usedBy: 'completes (respawn-loop gate), wall-contact diagnostic' },
  { id: 'wallHits', event: 'kart:wall', usedBy: 'wall-contact diagnostic, completes failure text' },
  { id: 'lapTimes', event: null, usedBy: 'determinism, drift-pays, lap-spread and lap-clock diagnostics', from: 'race standings' },
  { id: 'completedLaps / finished', event: null, usedBy: 'completes, lap binning', from: 'race standings' },
  { id: 'ticksWithoutProgress', event: null, usedBy: 'completes (stuck gate)', from: "main.ts fixedUpdate, from Standing.progress" },
  { id: 't / lateral', event: null, usedBy: 'the time-loss binning', from: 'ITrack.locate' },
]

/**
 * @param {Map<string,string[]>} emitters
 * @returns {{ rows: object[], dead: Set<string>, inert: boolean }}
 */
function auditCounters(emitters) {
  const rows = REPORTED_COUNTERS.map((c) => {
    if (!c.event) return { ...c, status: 'NOT EVENT-SOURCED', at: [] }
    const at = emitters.get(c.event) || []
    return { ...c, status: at.length ? 'LIVE' : 'UNMEASURABLE', at }
  })
  const dead = new Set(rows.filter((r) => r.status === 'UNMEASURABLE').map((r) => r.id))
  /*
   * THE SCANNER MUST BE PROVEN NOT INERT, and this is the whole lesson of
   * smoke.mjs's first self-test. A regex that matches nothing would mark every
   * counter in the game UNMEASURABLE and the output would be full of honest,
   * confident, completely wrong PENDINGs. If not one event in the game has a
   * publisher, the scanner is what is broken, not the game.
   */
  const inert = rows.some((r) => r.event) && !rows.some((r) => r.status === 'LIVE')
  return { rows, dead, inert }
}

// ---------------------------------------------------------------------------
// Limits. DERIVED or guess, marked per line.
// ---------------------------------------------------------------------------
const CFG = {
  /*
   * The four below are PARSED, which is a third category and the strongest one:
   * not derived here and not guessed here, but read out of the file that owns
   * them on every run. `simStep` comes from `src/types.ts`, the other three from
   * ART_DIRECTION §10c. If the rubric moves, these move with it, and if either
   * file stops containing them this harness refuses to run rather than fall back
   * on a remembered number.
   */
  simStep: SIMULATION_STEP,
  noiseMultiple: NOISE_MULTIPLE,
  tier1Rate: TIER1_RATE,
  tier3Rate: TIER3_RATE,

  /** PARSED from §10c 6, which says three laps. Overridable upward; the
   *  completes gate always grades whatever was actually asked for and says so. */
  laps: argNum('laps', RUBRIC_LAPS),
  /*
   * guess — one, because one is what a run can afford and not because one
   * circuit answers the question.
   *
   * Seeds are independent CIRCUITS, not repeats: `ResetOptions.seed` regenerates
   * the world. One seed is one complete paired experiment; more seeds are
   * replications and each costs a full set of races. A margin measured on one
   * circuit is a fact about that circuit until a second one agrees, which is why
   * `drift-pays` reports whether the per-seed margins share a sign and why that
   * line reads "not gated" at `--seeds=1` — with one seed there is nothing to
   * disagree with.
   */
  seeds: argNum('seeds', 1),
  /** guess, and an arbitrary one on purpose — it is a label for a world, not a
   *  limit. It matches the seed every other harness in this repo boots with, so
   *  a finding here can be reproduced by `slip-check` and `steer-test` on the
   *  same circuit rather than on a different one that happens to also be a road. */
  seed0: 20260807,

  /*
   * COORDINATION, NOT MEASUREMENT — no threshold is derived from it.
   *
   * Harnesses in this repo run in parallel under the Gauntlet Loop and
   * `vite-server.mjs` correctly REFUSES to adopt a listening server, rather than
   * risk another worktree's build being served into this measurement. Until
   * now this file took no port at all, so any other harness holding 4173 made it
   * simply unrunnable — two agents this session could not produce an
   * after-number, and one of them abandoned a completed A/B for it. 4179 is
   * clear of the default 4173 and of slip-check's 4178. `--port=` overrides.
   */
  port: argNum('port', useDev ? 5179 : 4179),

  /*
   * COVERAGE SWITCHES. Both default to on. Set either to 0 and the gate that
   * depends on it reports PENDING with the arithmetic of what was not covered —
   * never a pass, and never a silent skip. This is the `--windows=0` pattern
   * from `tools/slip-check.mjs`.
   *
   *   --repeat=0  drops the determinism repeat race. Saves a third of the run
   *               and costs the ONLY evidence that the drift margin is a
   *               difference between two stable numbers.
   *   --clean=0   drops the clean control arm. Saves a third, and §10c
   *               criterion 1 then has no control at all.
   */
  repeats: argCount('repeat', 1) > 0 ? 1 : 0,
  cleanArm: argCount('clean', 1) > 0 ? 1 : 0,

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
   * guess, with the arithmetic. A kart that cannot average 8 m/s over a lap is
   * not racing — Surface.OffTrack is the worst the game has, at grip 0.5 and
   * 9 m/s^2 of drag, and even limping across it beats this. It exists so a stuck
   * field cannot hang the run for ever, and hitting it is itself a reported
   * failure rather than a timeout.
   *
   * THE BUDGET IS PER LAP AND CUMULATIVE, WHICH IS A COST FIX AND NOT A
   * LOOSENING. It used to be `laps * length / minMeanSpeed` applied once at the
   * end, so a field stuck on lap 1 still simulated three laps' worth of ticks
   * before anyone was told. The budget now advances one lap's worth at a time
   * and only for laps the field has actually completed: the race stops as soon
   * as the LAST kart is a whole lap-budget behind the pace it must hold, which
   * is the same verdict from a third of the ticks. A field holding 8 m/s per lap
   * is never cut short; a field that is not was already failing §10c 6, and the
   * remaining two laps only add decimal places to a failure. The pace
   * arithmetic that stopped the race is printed with the failure.
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
   *
   * OPEN, AND TWO HYPOTHESES ARE ALREADY DEAD. This gate reports 798 ticks
   * (6.6 s) for six of eight karts, and the numbers are too uniform to be six
   * independent failures: 781, 783, 789, 790, 795, 798 — a spread of 17 ticks.
   * That is one mechanism counted six times.
   *
   * Ruled out by measurement, not by argument. Both changes were made, built,
   * and run, and BOTH LEFT THE NUMBER AT EXACTLY 798:
   *
   *   - the countdown. `main.ts` counts these ticks while the field is held on
   *     the grid, and the countdown is 390 ticks against this 360 limit, so the
   *     gate looked unsatisfiable by construction. Gating the counter on
   *     `race.phase === 'racing'` changed nothing, because this file already
   *     splits lap 1 out into `maxTicksWithoutProgressLap1` for exactly that
   *     reason — see the comment there.
   *   - the respawn. `bestProgress` is a high-water mark and a respawn moves a
   *     kart back up to 285 m at zero speed, so the counter appeared to be
   *     measuring the re-drive. Re-baselining it on `kart:respawn` changed
   *     nothing either.
   *
   * The surviving candidate, from reading `race.ts` rather than from a
   * measurement: `bestProgress` only advances while `racer.armed`
   * (`race.ts:289`), and `crossBackward` disarms a kart that reverses over the
   * start line at checkpoint depth 0 (`race.ts:199`). A disarmed kart never
   * advances its high-water mark however well it drives, so this counter would
   * climb through perfect driving. `main.ts` cannot see `armed` — it is not on
   * `Standing` — so if that is the cause, the fix is a contract question and
   * not a tuning one.
   *
   * Whoever picks this up: the cheap decisive measurement is to log `armed`
   * and `bestProgress` per tick for kart 3 or 4 through the window where the
   * counter climbs. Do not change this threshold until that is done — the
   * threshold is not what is wrong.
   */
  maxTicksWithoutProgress: 360,

  /*
   * DERIVED from the default run rather than chosen. Under this many comparable
   * laps the SEM is built on so few samples that quoting it is theatre, and the
   * drift-pays gate goes PENDING instead. Two laps per kart across eight karts
   * is 16; half of that is the point at which half the field failed to produce a
   * second lap, which is a different finding and should not be quoted as a
   * margin.
   */
  minComparableLaps: 8,

  /*
   * COST, NOT MEASUREMENT — see the header arithmetic. `stepTicks` presents a
   * frame per tick and this file grades nothing that is a pixel, so the frame is
   * made as cheap as the browser allows. 640x360 measured 4.13 ms/tick against
   * 6.53 at 1920x1080 and 16.67 with vsync on.
   *
   * A timing harness must NOT copy this. `fps-bench.mjs` exists to say what a
   * frame costs at a real resolution on a named GPU, and both of these numbers
   * would make its answer fiction. Here they change nothing at all: the
   * simulation sees `SIMULATION_STEP` and a tick count, and the determinism gate
   * two hundred lines down is what proves it.
   */
  renderWidth: 640,
  renderHeight: 360,
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
   * `aiDrift` is in `ResetOptions` now. It is still VERIFIED rather than
   * trusted, downstream, by checking that a clean race banked no drifts — a
   * field that is declared but not honoured produces two identical races, a
   * margin of zero and a confident FAIL against an AI that is working perfectly.
   *
   * The whole call is guarded because `resetRace` refuses a seed or a lap count
   * it cannot honour by THROWING the pending marker — `--seeds=2` asks for a
   * world rebuild the build does not do yet. Unguarded, that escapes the page
   * evaluate and kills the run with a stack trace instead of a coverage
   * statement, which is the difference between "we could not measure this" and
   * "the harness is broken".
   */
  try {
    await h.resetRace({ seed: cfg.seed, totalLaps: cfg.laps, drivers, aiDrift: cfg.mode })
  } catch (err) {
    const msg = String((err && err.message) || err)
    return {
      seed: cfg.seed,
      mode: cfg.mode,
      blocked:
        msg.indexOf(cfg.pendingMarker) >= 0
          ? `resetRace({ seed: ${cfg.seed}, totalLaps: ${cfg.laps} }) refused: ${msg}`
          : `resetRace threw something that is NOT the pending marker, so this is a breakage rather than an absence: ${msg}`,
    }
  }
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

  /*
   * THE PACE BUDGET. One lap of ticks at the floor speed, granted one lap at a
   * time to the SLOWEST kart in the field, plus the lap it is currently on.
   *
   * The old form was `laps * length / minMeanSpeed` checked once at the end, so
   * a field that could not complete lap 1 still cost three laps of simulation to
   * say so — at one presented frame per tick that was the difference between six
   * minutes and over an hour, and it is why two agents this session killed the
   * run instead of reading its verdict.
   *
   * A field holding the floor speed on every lap is never cut short: the
   * allowance advances by exactly one lap's worth every time the slowest kart
   * banks a lap. What is cut short is a field that has already failed §10c 6,
   * and the pace arithmetic at the moment of the cut is reported with the
   * failure so nobody has to take the cut on trust.
   *
   * The stricter reading it introduces is written down rather than hidden: a
   * kart that crawls one lap at 4 m/s and then flies is now stopped, where the
   * whole-race form would have let it finish. It has still driven a lap at half
   * the floor speed, which is the failure this budget names.
   */
  const lapBudget = Math.ceil(cfg.trackLength / cfg.minMeanSpeed / cfg.simStep)
  const budget = lapBudget * cfg.laps
  let hitBudget = false
  let pace = null
  let tel = h.telemetry()
  while (true) {
    const allDone = tel.karts.every((k) => k.finished)
    if (allDone || tel.phase === 'finished') break
    const slowestLaps = Math.min.apply(null, tel.karts.map((k) => k.completedLaps || 0))
    const allowance = Math.min(budget, lapBudget * (slowestLaps + 1))
    if (ticks >= allowance) {
      hitBudget = true
      pace = {
        slowestLaps,
        allowanceTicks: allowance,
        lapBudgetTicks: lapBudget,
        wholeRaceBudgetTicks: budget,
        cutShort: allowance < budget,
        lapsRemaining: cfg.laps - slowestLaps,
        stillRunning: tel.karts.filter((k) => !k.finished).length,
      }
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
    lapBudget,
    hitBudget,
    pace,
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
        /*
         * The kart's position at the flag, kept for the determinism fallback.
         *
         * A field that completes no laps produces no lap times, and the
         * determinism gate's whole quantity is lap times — so on exactly the
         * build where the AI is broken, the gate that says whether ANY of these
         * numbers are trustworthy has nothing to compare. `t` is available on
         * every tick regardless of laps and is exquisitely sensitive to any
         * variation in speed, so two identical runs whose fields ended up in
         * different places have proven nondeterminism without a single lap.
         */
        finalT: k.t,
        finalLateral: k.lateral,
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

  /* `slow-field` drives the whole field under the pace floor, which is what the
   * per-lap budget exists to stop early. 6 m/s before the corner penalty lands
   * the mean at about 5 — comfortably under the 8 m/s floor without being a
   * nonsense value, so it is the THRESHOLD that rejects it and not the
   * magnitude. */
  const BASE_SPEED = S === 'slow-field' || S === 'nondeterministic-before-first-lap' ? 6 : 30
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
      /*
       * `nondeterministic-before-first-lap` is the same defect on a field too
       * slow to finish a lap inside the budget. It exists because the gate's own
       * quantity — lap times — does not exist on that build, so the ONLY thing
       * that can catch it is the position fallback. Without this sabotage that
       * fallback would be code nobody had watched fire, which is the same as not
       * having it.
       */
      if (S === 'nondeterministic' || S === 'nondeterministic-before-first-lap') {
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

/**
 * Is the counter behind this number one that nothing in `src/` can move?
 *
 * `cfg.deadCounters` is an ARRAY and not a Set on purpose: this config object
 * crosses into the page through `page.evaluate`, and a Set arrives there as an
 * empty object with no error anywhere — which would quietly re-enable every
 * reassuring zero this predicate exists to suppress.
 */
function counterIsDead(cfg, id) {
  return Array.isArray(cfg.deadCounters) && cfg.deadCounters.indexOf(id) >= 0
}

function mkCheck(id, title) {
  /*
   * `evaluated` and `needed` are the second half of the audit that found the
   * wall-contact hole, and they exist because the two failures turned out to be
   * the same failure in different clothes.
   *
   *   wallHits is UNFIREABLE — nothing in src/ can move the counter.
   *   determinism is UNEVALUABLE on a broken build — the field completes no
   *     laps, so the quantity the gate compares does not exist.
   *
   * Both produce a check that ran its arithmetic over nothing. The first one
   * printed a flattering number for the life of the project; the second one at
   * least printed PEND, but the note read like a shrug next to three other
   * lines that looked equally routine. Every check now states what it needed
   * and whether it got it, and the ledger is printed whichever way it comes out
   * — a gate cannot be read as having covered something it did not touch.
   */
  return { id, title, status: 'PASS', metrics: {}, problems: [], notes: [], evaluated: false, needed: null, got: null }
}
/** Declare what the check had to have, and whether it had it. */
const requires = (c, needed, got, evaluated) => {
  c.needed = needed
  c.got = got
  c.evaluated = evaluated
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
  /*
   * THE FALLBACK, AND WHY IT IS NOT A PASS.
   *
   * The gate's quantity is lap times. A field that completes no laps produces
   * none — so on exactly the build where the AI is broken, the gate that says
   * whether any number on this page can be trusted has nothing to compare, and
   * a note saying so sits in a column of four lines that all look routine.
   *
   * Position at the flag is available whatever the field did. Two identical
   * runs that ended with karts in different PLACES have proven nondeterminism
   * without a single lap, and that is a violation, so it FAILS. Two runs that
   * agree on every position and every counter have proven only that the parts
   * of the simulation which ran, ran the same way twice — which is corroborating
   * and is NOT the measurement §10c 1 divides by. That stays PENDING, and the
   * note says which of the two happened in words that cannot be skimmed as a
   * pass.
   */
  let fallback = null
  if (!repeatPairs) {
    const fields = ['finalT', 'finalLateral', 'completedLaps', 'respawns', 'driftAttempts', 'ticksWithoutProgress']
    let compared = 0
    let mismatch = null
    for (const r of runs) {
      if (!r.seek || !r.seekRepeat || r.seek.blocked || r.seekRepeat.blocked) continue
      if (r.seek.ticks !== r.seekRepeat.ticks && !mismatch) {
        mismatch = { seed: r.seed, kartId: null, field: 'race length in ticks', a: r.seek.ticks, b: r.seekRepeat.ticks }
      }
      for (let i = 0; i < r.seek.karts.length; i++) {
        const a = r.seek.karts[i]
        const b = r.seekRepeat.karts[i]
        if (!b) continue
        for (const f of fields) {
          compared++
          if (a[f] !== b[f] && !mismatch) mismatch = { seed: r.seed, kartId: a.kartId, field: f, a: a[f], b: b[f] }
        }
      }
    }
    fallback = { compared, mismatch }
    determinism.metrics.fallback = fallback
  }

  determinism.metrics.pairs = repeatPairs
  determinism.metrics.worstDeltaS = repeatPairs ? worstRepeat : null
  requires(
    determinism,
    'at least one lap time produced by both of two identical races',
    `${repeatPairs} lap pair(s)` + (fallback ? `, ${fallback.compared} position/counter pair(s) as fallback` : ''),
    repeatPairs > 0 || Boolean(fallback && fallback.mismatch),
  )

  if (!repeatPairs && fallback && fallback.mismatch) {
    const m = fallback.mismatch
    fail(
      determinism,
      `NO KART COMPLETED A LAP, so there are no lap times to difference — and the two identical races still ended ` +
        `differently. ${m.kartId === null ? 'The races' : `Kart ${m.kartId}`} disagreed on ${m.field}: ${m.a} then ` +
        `${m.b} (seed ${m.seed}). This is determinism failing before the gate's own quantity even exists. The ` +
        `contract's DETERMINISM section requires the same seed and build to produce the same race, and THE CLOCK ` +
        `requires that no wall-clock delta reaches physics, AI or race progression. Look for performance.now() or ` +
        `Date.now() inside fixedUpdate, Math.random() outside ctx.rngFor, or iteration over a Set.`,
    )
  } else if (!repeatPairs) {
    pend(
      determinism,
      cfg.repeats === 0
        ? `the repeat race was switched off with --repeat=0, so 0 of ${runs.length * 2} possible lap pairs were ` +
          `compared and determinism was NOT TESTED. That is a third of the run's cost and the whole of its evidence ` +
          `that the drift margin below is a difference between two stable numbers rather than two drifting ones. ` +
          `Re-run without --repeat=0 before quoting anything on this page.`
        : `NOT DETERMINISTIC, NOT NON-DETERMINISTIC — NOT MEASURED. No kart completed a lap in either of the two ` +
          `identical races, so the quantity this gate compares (lap times) does not exist and 0 pairs were ` +
          `differenced. ` +
          (fallback && fallback.compared
            ? `As a fallback the two races were compared on ${fallback.compared} pairs of end-of-race position and ` +
              `counter — final t, lateral, laps, respawns, drift attempts, stall ticks — and every one matched. That ` +
              `is CORROBORATION, not the measurement: it says the ticks that ran, ran the same way twice. It does ` +
              `not say lap timing is reproducible, because no lap was timed. `
            : `No fallback comparison was possible either. `) +
          `Everything on this page that divides by a noise floor is therefore resting on an untested precondition. ` +
          `Fix the field so it completes laps and this gate becomes measurable again; until then read it as absent, ` +
          `not as green.`,
    )
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
  requires(
    driftPays,
    `both arms racing, with >= ${cfg.minComparableLaps} laps after lap 1, and drift attempts in the seeking arm and none in the clean one`,
    `${perSeed.length} paired seed(s), ${totalComparable} comparable lap(s), seeking arm ${anySeekDrifts ? 'drifts' : 'NEVER DRIFTS'}, clean arm ${anyCleanDrifts ? 'DRIFTS TOO' : 'clean'}`,
    perSeed.length > 0 && anySeekDrifts && !anyCleanDrifts && totalComparable >= cfg.minComparableLaps,
  )
  if (!perSeed.length) {
    pend(
      driftPays,
      cfg.cleanArm === 0
        ? `the clean control arm was switched off with --clean=0, so 0 of ${runs.length} seed(s) produced a paired ` +
          `comparison and §10c criterion 1 measured NOTHING. The drifting arm alone gives a mean lap time and no ` +
          `control to subtract it from; there is no margin on this page, not a small one.`
        : 'no seed produced both a drifting race and a clean race with comparable laps, so §10c criterion 1 measured NOTHING',
    )
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
        `ResetOptions.aiDrift='clean' did not take. The field is declared in the contract and accepted by ` +
        `resetRace, so this is a build that reads the flag and drifts anyway rather than one that never heard of ` +
        `it. Both arms of the experiment were therefore the same arm. That is a MISSING experiment, not a failed ` +
        `one: reporting it as FAIL would blame an AI that may be working perfectly. See the CONTRACT SURFACE block ` +
        `below.`,
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
  requires(
    ladder,
    `>= ${cfg.minDriftAttempts} drift attempts pooled across the drift-seeking races`,
    `${attempts} attempt(s) over ${seekRaces} race(s)`,
    attempts >= cfg.minDriftAttempts,
  )

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
  /*
   * completes is the one gate here that a broken field cannot make unevaluable,
   * and that is by design rather than luck: its subject IS whether the field
   * got round. A race that produced nothing is not missing data for this check,
   * it is the finding. The other three all measure a PROPERTY OF LAPS and go
   * dark together the moment there are no laps — which is why they are PENDING
   * on this build and this one is red.
   */
  requires(
    completes,
    'one unattended race that reached the racing phase',
    primary ? `${primary.seek.karts.length} kart(s) over ${primary.seek.ticks} ticks` : 'no race ran',
    Boolean(primary) && (!cfg.rubricLaps || (primary.seek.laps ?? 0) >= cfg.rubricLaps),
  )
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

    if (race.laps < cfg.rubricLaps) {
      pend(
        completes,
        `this run asked for ${race.laps} lap(s) and §10c 6 is "every kart finishes ${cfg.rubricLaps} laps ` +
          `unattended". ${race.laps} of ${cfg.rubricLaps} laps is ${((race.laps / cfg.rubricLaps) * 100).toFixed(0)}% ` +
          `of the criterion, and the part not covered is the part where a kart that survives one lap runs out of ` +
          `road on the next. Graded as far as it went, and NOT a pass.`,
      )
    }

    if (race.hitBudget) {
      const p = race.pace || {}
      fail(
        completes,
        `the race ran out of pace budget after ${race.ticks} ticks ` +
          `(${(race.ticks * cfg.simStep).toFixed(0)} s of simulation) with ` +
          `${race.karts.filter((k) => !k.finished).length} kart(s) still running. ` +
          `One lap at the ${cfg.minMeanSpeed} m/s floor over ${Math.round(cfg.trackLength)} m is ` +
          `${race.lapBudget ?? '?'} ticks; the slowest kart had completed ${p.slowestLaps ?? '?'} lap(s), which buys ` +
          `${p.allowanceTicks ?? race.budget} ticks, and it spent them. ` +
          (p.cutShort
            ? `The whole-race budget is ${p.wholeRaceBudgetTicks} ticks and the remaining ${p.lapsRemaining} lap(s) ` +
              `were NOT simulated: a field that cannot hold ${cfg.minMeanSpeed} m/s over the lap it is on will not ` +
              `hold it over the two after, and simulating them costs ${(((p.wholeRaceBudgetTicks - p.allowanceTicks) * cfg.simStep) / 60).toFixed(0)} ` +
              `more minutes of wall time to add decimal places to this same sentence. `
            : `That is the whole-race budget. `) +
          `§10c 6 is "every kart finishes ${cfg.rubricLaps} laps unattended"; this is that failing, not the harness ` +
          `timing out.`,
      )
    }
    for (const k of race.karts) {
      if (!k.finished || k.completedLaps < race.laps) {
        fail(
          completes,
          `kart ${k.kartId} finished=${k.finished} with ${k.completedLaps}/${race.laps} laps after ` +
            `${(race.ticks * cfg.simStep).toFixed(1)} s, ${k.respawns} respawn(s), ` +
            // A counter with no publisher must not appear in a failure report as
            // a reassuring zero. See the header: `wallHits` read "0 wall hit(s)"
            // in this very sentence for the life of the project.
            `${counterIsDead(cfg, 'wallHits') ? 'wall hits unmeasurable' : `${k.wallHits} wall hit(s)`}, longest ` +
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
  /*
   * THE NUMBER IS WITHHELD WHEN NOTHING CAN PRODUCE IT. See the header for what
   * this line used to print and why it was the most misleading output in the
   * file. `hits` is still summed and still written to the JSON report — the raw
   * value is not a secret — but `perKartLap` is null and the printer says
   * UNMEASURABLE rather than 0.00, because "no walls were touched" and "wall
   * contact has no publisher" are opposite findings that formatted identically.
   */
  let hits = 0
  let kartLaps = 0
  let respawns = 0
  /*
   * THE POOLED RATE IS NOT ONE POPULATION, and the first run that ever produced
   * a non-zero number here proved it: 118 hits over 76 kart-laps = 1.55 per
   * kart per lap, printed beside a sentence about whether the FIELD is driving
   * a corridor. Underneath that single figure:
   *
   *   clean       0 hits over 24 kart-laps   0.00   never touches anything
   *   seek       59 hits over 26 kart-laps   2.27
   *   seekRepeat 59 hits over 26 kart-laps   2.27   (identical, as it must be)
   *
   * and inside the seek arm, two karts that never finished contributed 39 of
   * the 59 while parked against rock. So the pooled 1.55 is the average of an
   * arm that never touches a wall and two karts that live on one, and it is the
   * one value in the range that describes NEITHER. The modes are different
   * experiments — `drift-pays` is a paired within-mode comparison for exactly
   * this reason — and finished karts and stuck karts are different populations.
   * All three splits are computed; the printer shows them; the pooled figure
   * stays, because removing it would break every reader that already has it.
   */
  const byMode = new Map()
  let hitsUnfinished = 0
  let lapsUnfinished = 0
  let unfinishedKarts = 0
  for (const race of races) {
    const m = byMode.get(race.mode) || { mode: race.mode, hits: 0, kartLaps: 0, respawns: 0 }
    for (const k of race.karts) {
      hits += k.wallHits || 0
      respawns += k.respawns || 0
      kartLaps += k.completedLaps || 0
      m.hits += k.wallHits || 0
      m.respawns += k.respawns || 0
      m.kartLaps += k.completedLaps || 0
      if (!k.finished) {
        hitsUnfinished += k.wallHits || 0
        lapsUnfinished += k.completedLaps || 0
        unfinishedKarts++
      }
    }
    byMode.set(race.mode, m)
  }
  const wallDead = counterIsDead(cfg, 'wallHits')
  const respawnDead = counterIsDead(cfg, 'respawns')
  out.wallContacts = {
    hits: wallDead ? null : hits,
    rawHits: hits,
    hitsUnmeasurable: wallDead,
    respawns: respawnDead ? null : respawns,
    respawnsUnmeasurable: respawnDead,
    kartLaps,
    perKartLap: wallDead || !kartLaps ? null : hits / kartLaps,
    byMode: [...byMode.values()].map((m) => ({
      ...m,
      perKartLap: wallDead || !m.kartLaps ? null : m.hits / m.kartLaps,
    })),
    unfinished: {
      karts: unfinishedKarts,
      hits: wallDead ? null : hitsUnfinished,
      kartLaps: lapsUnfinished,
      /** What fraction of every wall contact in the run came from a kart that
       *  did not finish. High means the rate is a stuck-kart statistic. */
      shareOfHits: wallDead || !hits ? null : hitsUnfinished / hits,
    },
  }

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
      // The fallback count is on the summary line, not buried in the note. A
      // bare "0 lap pairs compared" reads as a rounding detail; "0 lap pairs,
      // no laps to compare" is the finding.
      return (
        `${m.pairs ?? 0} lap pairs compared, worst delta ${m.worstDeltaS === null ? '-' : fmt(m.worstDeltaS, 5)} s` +
        (m.fallback
          ? m.fallback.compared === 0
            ? // "0 pairs, all matched" is precisely the vacuous green this file
              // exists to stamp out. Nothing was compared; say that.
              `  — NO LAPS and NO REPEAT RACE: nothing was compared at all`
            : `  — NO LAPS: fell back to ${m.fallback.compared} position/counter pair(s), ${m.fallback.mismatch ? 'THEY DIFFER' : 'all matched'}`
          : '')
      )
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

/**
 * Which gates actually had something to grade.
 *
 * The sibling of COUNTER PROVENANCE, and it exists because the audit that found
 * the unfireable wall counter found the same shape one level up: three of these
 * four gates measure a property OF LAPS, so a field that completes none takes
 * all three dark at once — and they go dark as a one-line note in a column
 * where every other line looks equally routine. This table cannot be skimmed
 * into a pass.
 */
function printEvaluability(checks) {
  console.log('')
  console.log('EVALUABILITY — did each gate have anything to grade? (a gate covering nothing prints the same green)')
  for (const c of checks) {
    console.log(`  ${(c.evaluated ? 'EVALUATED' : 'NOT EVALUATED').padEnd(14)} ${c.id.padEnd(12)} needed: ${c.needed}`)
    console.log(`  ${''.padEnd(14)} ${''.padEnd(12)} got:    ${c.got}`)
  }
  const dark = checks.filter((c) => !c.evaluated)
  if (dark.length) {
    console.log('')
    console.log(
      `  ${dark.length} of ${checks.length} gate(s) graded nothing. Read those as ABSENT, not as green: an ` +
        `unevaluable gate\n  and a passing gate are indistinguishable in a status column, which is the whole reason ` +
        `this table is printed.`,
    )
  }
}

function printDiagnostics(d, cfg) {
  console.log('')
  console.log('DIAGNOSTICS — §10c asks for these; nothing below is a gate')
  /*
   * A DIAGNOSTIC THAT VANISHES IS NOT A DIAGNOSTIC THAT PASSED. Three of the
   * four below are computed only from laps 2..n of the drift-seeking races, so
   * a field that completes no laps takes all three out — and the old printer
   * simply skipped them, leaving a header, one line about wall contacts, and
   * nothing to say that four fifths of this section had no data. Same shape as
   * the unfireable counter, one level out.
   */
  if (!d.lapSpread) {
    console.log(
      `  lap times      UNMEASURABLE — no drift-seeking race produced a lap after lap 1. Mean, spread, per-kart\n` +
        `                 ranking and the field-spread comparison against the drift margin are all absent, not zero.`,
    )
  }
  if (!d.lapQuantisation) {
    console.log(
      `  lap clock      UNMEASURABLE — with no lap times there is nothing to test against the tick grid, so this run\n` +
        `                 cannot say whether KartTelemetry.lapTimes comes from the tick counter or a wall clock. That\n` +
        `                 question is the precondition for every margin this file quotes; it is open, not answered.`,
    )
  }
  if (!d.timeLoss || !d.timeLoss.worst.length) {
    console.log(
      `  time lost      UNMEASURABLE — the binning only counts ticks after a kart's first completed lap, and no kart\n` +
        `                 completed one. WHERE the field loses time is exactly what a broken AI most needs, and it is\n` +
        `                 the diagnostic that disappears first.`,
    )
  }
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
    if (w.hitsUnmeasurable) {
      console.log(
        `  wall contacts  UNMEASURABLE over ${w.kartLaps} kart-laps. KartTelemetry.wallHits is incremented from ` +
          `'kart:wall'\n` +
          `                 and NOTHING IN src/ EMITS IT — main.ts subscribes, no subsystem publishes. The counter ` +
          `cannot\n` +
          `                 leave zero, so this line printed "0.00 per kart per lap" for the life of the project, ` +
          `beside a\n` +
          `                 sentence explaining that a field which never touches a wall is driving a corridor. It ` +
          `was not\n` +
          `                 driving a corridor; the instrument was unplugged. ` +
          `${w.respawnsUnmeasurable ? 'Respawns too.' : `${w.respawns} respawn(s), which IS wired.`}`,
      )
    } else {
      console.log(
        `  wall contacts  ${w.hits} over ${w.kartLaps} kart-laps = ${fmt(w.perKartLap, 2)} per kart per lap, ` +
          `${w.respawnsUnmeasurable ? 'respawns unmeasurable' : `${w.respawns} respawn(s)`}. Reported because a field ` +
          `that never touches a wall is driving a corridor and a field that always does is not driving.`,
      )
      /*
       * ...but that sentence has to be applied to a population, and the pooled
       * figure above is not one. See the analysis for the run that made this
       * necessary: a 0.00 arm and a 2.27 arm averaging to a 1.55 that describes
       * neither. The modes are separate experiments and stuck karts are a
       * separate population; read the split, not the total.
       */
      if (w.byMode && w.byMode.length > 1) {
        console.log(
          `                 by mode: ${w.byMode
            .map((m) => `${m.mode} ${m.hits}/${m.kartLaps} = ${fmt(m.perKartLap, 2)}`)
            .join('   ')}`,
        )
      }
      if (w.unfinished && w.unfinished.karts > 0 && w.unfinished.hits > 0) {
        console.log(
          `                 ${w.unfinished.hits} of those ${w.hits} contacts (${fmt(w.unfinished.shareOfHits * 100, 0)}%) came from the ` +
            `${w.unfinished.karts} kart-race(s) that did NOT finish. A rate dominated by karts parked against rock is a\n` +
            `                 stuck-kart statistic, not a measure of how the field races a corridor — grade the finishers' ` +
            `rate and read this one as evidence for the completes gate above.`,
        )
      }
    }
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

/**
 * The ledger, printed every run whichever way it comes out.
 *
 * A gate that quietly covers nothing prints the same green as a gate that
 * passed — and a COUNTER that can never move prints the same zero as a counter
 * that stayed at zero honestly. This is the same argument one level down, and
 * `wallHits` is the case that proves it was worth making.
 */
function printProvenance(audit) {
  console.log('')
  console.log('COUNTER PROVENANCE — every number above, and whether anything in src/ can move it')
  for (const r of audit.rows) {
    const where = r.status === 'LIVE' ? r.at.join(', ') : r.status === 'UNMEASURABLE' ? 'NO EMITTER ANYWHERE IN src/' : r.from
    console.log(
      `  ${r.status.padEnd(18)} ${r.id.padEnd(26)} ${(r.event ? r.event : '(not from the bus)').padEnd(16)} ${where}`,
    )
  }
  const dead = audit.rows.filter((r) => r.status === 'UNMEASURABLE')
  if (dead.length) {
    console.log('')
    for (const r of dead) {
      console.log(
        `  ${r.id} is UNMEASURABLE: '${r.event}' is declared in GameEvents and consumed in src/main.ts, and no\n` +
          `  subsystem emits it. Every number this harness derives from it is withheld rather than printed —\n` +
          `  used by: ${r.usedBy}.\n` +
          `  This is a src/ change and it is not this harness's to make: an emitter belongs wherever wall contact is\n` +
          `  detected, and putting one in would be a builder grading his own instrument. Flagged, not worked around.`,
      )
    }
  }
  console.log(
    '  A static scan proves an emitter EXISTS, not that its guard is ever true. It catches the quiet failure —\n' +
      '  a counter with no publisher at all, which has no line to breakpoint, no test that fails, and reports the\n' +
      '  most flattering value in its range.',
  )
}

/**
 * What each gate is standing on. Printed with the verdict, because three of the
 * four are outcome thresholds with no reference build to compare against, and a
 * field that is uniformly broken satisfies every outcome threshold that has no
 * reference. Saying so next to the number is the cheapest available honesty.
 */
const GATE_BASIS = `
  WHAT EACH GATE IS STANDING ON — threshold origin, and what it would take to make it bite
  ───────────────────────────────────────────────────────────────────────────────────────
  determinism   THRESHOLD: exactly zero. PARSED from the contract's DETERMINISM section,
                and it is the one gate here that needs no reference: it compares a run
                against ITSELF, so a uniformly broken field cannot satisfy it by being
                uniformly broken. This is why it is the precondition for the other three.

  drift-pays    THRESHOLD: margin >= 4x the floor. The 4x is PARSED from §10c 1; the floor
                is DERIVED per run (the larger SEM, floored at one SIMULATION_STEP). Also
                needs no reference — it is a paired within-seed comparison, and the control
                arm IS the baseline. It is the best-founded gate on this page.

  ladder        THRESHOLD: tier1+ >= 60%, tier3 >= 25%, both PARSED from §10c 2; the
                128-attempt minimum is DERIVED from the confidence needed to tell 25% from
                32.5%. WHAT IT LACKS: nothing establishes that the AI attempts drifts in
                the places a player would. An AI that never drifts reads PENDING (correct),
                but an AI that drifts constantly and badly in the wrong places can hit both
                ratios. To bite it would need a per-CORNER attempt rate — a corner the AI
                never drifts is invisible in a pooled ratio — which needs corner geometry
                this file does not read today.

  completes     THRESHOLDS: 3 laps PARSED from §10c 6; <=2 respawns/lap a guess; 360 ticks
                without progress DERIVED-ish from a spin-and-recover taking ~1.5 s; the
                8 m/s pace floor a guess. WHAT IT LACKS, AND THIS IS THE REAL HOLE: these
                are absolute outcome thresholds with NO REFERENCE BUILD. Measured this
                session, a build before and after an AI fix both respawned ~85 times a
                race — the gate correctly reddens on both and says nothing about which is
                better, and "fewer laps completed than the fixed build" is not a thing it
                can express. To be a real gate it needs a STORED BASELINE: the same three
                numbers from a named commit, so the verdict is "worse than <sha>" and not
                only "outside a number somebody guessed". tools/out/autoplay.json is
                already that file's shape; nothing reads it back yet.
`

const CONTRACT_ADDITIONS = `
  SRC SURFACE THIS HARNESS NEEDS — not added here; these belong to whoever owns the subsystem
  ───────────────────────────────────────────────────────────────────────────────────────────
  1. AN EMITTER FOR \`'kart:wall'\`. The event is declared in \`GameEvents\` and
     consumed in \`src/main.ts\`, which increments \`KartTelemetry.wallHits\` from
     it. Nothing publishes it. So the wall-contact diagnostic could only ever
     print zero, and did, for the life of the project — with a sentence beside it
     inviting the reading that the field was driving cleanly.

     This file now reports it UNMEASURABLE rather than printing the zero, which
     is as far as a harness can honestly go. It is NOT this file's to fix: the
     emitter belongs wherever wall contact is already detected (the barrier
     handling that leads to \`kart:respawn\` is the obvious neighbour), and a
     harness that supplied its own source for the number it grades would be
     grading its own instrument.

         // wherever the barrier is detected, alongside the existing respawn path
         ctx.events.emit('kart:wall', { kartId, speed })

     \`HitKind\` deliberately excludes 'wall' — "wall contact emits \`kart:wall\`
     telemetry and applies no \`HitKind\`. One collision must not fire two effect
     paths." — so the shape is already decided; only the call is missing.

  2. \`ResetOptions.aiDrift\` IS PRESENT NOW, and this file no longer asks for it.
     It is still verified rather than trusted every run: an accepted-but-ignored
     flag produces two identical races, a margin of zero and a confident FAIL
     against an AI that is working perfectly. That check is the \`anyCleanDrifts\`
     PENDING in drift-pays.

  THE ALTERNATIVES CONSIDERED FOR THE CLEAN ARM, kept because they explain the shape
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
  · \`resetRace({ seed })\` refuses any seed other than the one the page booted
    with, and \`{ totalLaps }\` any count other than the built one — both throw
    the pending marker. So --seeds=2 and --laps=5 report PENDING instead of
    running; the extra circuits §10c 1 wants as replications are not reachable
    from one page load.
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
  /*
   * Which arms run at all. `--repeat=0` and `--clean=0` drop one each; the gate
   * that depended on the dropped arm reports PENDING with the arithmetic, which
   * is `slip-check.mjs`'s `--windows=0` pattern and exists for the same reason:
   * a run that covered two thirds of the experiment must not print the same
   * green as one that covered all of it.
   */
  const arms = [['seek', 'seek']]
  if (cfg.repeats > 0) arms.push(['seekRepeat', 'seek'])
  if (cfg.cleanArm > 0) arms.push(['clean', 'clean'])
  for (let i = 0; i < cfg.seeds; i++) {
    const seed = cfg.seed0 + i * 1009
    const row = { seed }
    for (const [key, mode] of arms) {
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
  { name: 'slow-field', owner: 'completes', expect: 'FAIL', what: 'the whole field drives under the pace floor — the per-lap budget must stop it early AND fail it' },
  { name: 'nondeterministic', owner: 'determinism', expect: 'FAIL', what: 'the same seed twice produces different lap times' },
  {
    name: 'nondeterministic-before-first-lap',
    owner: 'determinism',
    expect: 'FAIL',
    what: 'nondeterministic AND too slow to finish a lap — no lap times exist, so only the position fallback can catch it',
  },
]

/*
 * EVALUABILITY SABOTAGES. Nothing here is broken; the field simply never gets
 * round, which takes three of the four gates' subject matter away with it. What
 * must not happen is a status column that reads like a normal run. `slow-field`
 * is reused because it is the honest version of the state this build is
 * actually in — see the header on the wall counter for why proving the analysis
 * against numbers the game cannot produce is not proof of anything.
 */
const EVALUABILITY_SABOTAGES = [
  {
    name: 'no-laps-dark-gates',
    sabotage: 'slow-field',
    what: 'with zero completed laps, determinism/drift-pays/ladder must report NOT EVALUATED and the lap diagnostics UNMEASURABLE',
  },
]

/*
 * COVERAGE SABOTAGES. These do not break the game — they switch off part of the
 * experiment, which is a different failure and must produce PENDING rather than
 * FAIL. Run against the honest reference, so what is being proved is that
 * dropping an arm cannot produce a green run.
 */
const COVERAGE_SABOTAGES = [
  { name: '--repeat=0', over: { repeats: 0 }, owner: 'determinism', expect: 'PEND', what: 'no repeat race: determinism was not tested at all' },
  { name: '--clean=0', over: { cleanArm: 0 }, owner: 'drift-pays', expect: 'PEND', what: 'no control arm: §10c 1 has nothing to compare against' },
]

/**
 * Run `fn` with console.log captured.
 *
 * The wall-contact sabotages below assert on the PRINTED LINE and not only on
 * the object behind it, and that is the whole point of them. The bug being
 * guarded was never in the arithmetic — `hits` really was 0 — it was in a
 * sentence that formatted an impossible measurement as a good result. An
 * assertion on the data would have passed happily throughout.
 */
function captureLog(fn) {
  const lines = []
  const real = console.log
  console.log = (...a) => lines.push(a.join(' '))
  try {
    fn()
  } finally {
    console.log = real
  }
  return lines.join('\n')
}

/** A minimal fake `src/` for the emitter scanner, so the provenance mechanism
 *  can be watched deciding both ways without touching the real tree. */
const FAKE_SRC_WIRED = [
  { path: 'src/kart/kart.ts', text: "ctx.events.emit('drift:start', { kartId })\nctx.events.emit('drift:release', {})\nctx.events.emit('boost:start', {})\nctx.events.emit('kart:respawn', {})\nctx.events.emit('kart:wall', { kartId, speed })\n" },
]
const FAKE_SRC_UNWIRED = [
  { path: 'src/kart/kart.ts', text: "ctx.events.emit('drift:start', { kartId })\nctx.events.emit('drift:release', {})\nctx.events.emit('boost:start', {})\nctx.events.emit('kart:respawn', {})\n// nothing emits kart:wall\n" },
]

async function main() {
  /*
   * The counter audit runs BEFORE anything is launched, and its result travels
   * with the config. Every place that would otherwise print a number from a dead
   * counter reads `deadCounters`, so there is one decision and not five.
   */
  const audit = auditCounters(scanEmitters(readSourceFiles()))
  if (audit.inert) {
    console.error(
      `FAIL  the emitter scan found no publisher for ANY event in src/.\n` +
        `      That is the scanner being broken, not the game: this repo emits events. Refusing to run, because\n` +
        `      an inert scanner would mark every counter UNMEASURABLE and print a page of confident, honest,\n` +
        `      entirely wrong PENDINGs. Check the regex in scanEmitters() against src/kart/kart.ts.`,
    )
    process.exit(1)
  }

  const runCfg = {
    ...CFG,
    pendingMarker: PENDING_MARKER,
    trackLength: 1000,
    rubricLaps: RUBRIC_LAPS,
    deadCounters: Array.from(audit.dead),
  }

  if (!selfTest) {
    const server = await startServer({ mode: useDev ? 'dev' : 'preview', port: CFG.port })
    /*
     * vsync off. `launch({ timing: true })` is the wrong door — it also drops
     * `--enable-unsafe-swiftshader`, and this harness legitimately does not care
     * which adapter renders, because it grades no pixel and no frame time. What
     * it needs is the ONE effect: rAF not pinned to the refresh rate, because
     * `stepTicks` awaits a rAF per tick and that made one simulated tick cost
     * one display refresh — 16.67 ms measured, which is the monitor and not the
     * game. See the header arithmetic.
     */
    const browser = await launch({ timing: false, extraArgs: ['--disable-gpu-vsync', '--disable-frame-rate-limit'] })
    try {
      const { page, consoleErrors } = await openGame(browser, server.url, { seed: CFG.seed0, quality: 'low' })
      page.setDefaultTimeout(0)
      // Cheap frames for the same reason `slip-check.mjs` asks for quality low:
      // this file steps tens of thousands of ticks and presents one frame for
      // each, and nothing it measures is a pixel.
      await page.setViewportSize({ width: CFG.renderWidth, height: CFG.renderHeight })

      console.log('autoplay — unattended races, graded on outcomes   (ART_DIRECTION §10c criteria 1, 2, 6)')
      console.log(
        `thresholds parsed from ART_DIRECTION.md: margin >= ${CFG.noiseMultiple}x the noise floor; ` +
          `tier1+ >= ${(CFG.tier1Rate * 100).toFixed(0)}%; tier3 >= ${(CFG.tier3Rate * 100).toFixed(0)}%; ` +
          `${RUBRIC_LAPS} laps. SIMULATION_STEP ${CFG.simStep.toFixed(6)} s parsed from src/types.ts.`,
      )
      console.log(
        `serving on port ${CFG.port} (--port= to move it), rendering ${CFG.renderWidth}x${CFG.renderHeight} at ` +
          `quality low with vsync off — none of which the simulation can see.`,
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
      const races = 1 + CFG.repeats + CFG.cleanArm
      // The HEALTHY estimate (25 m/s) and the WORST case (the pace floor) are
      // both printed, because they differ by 3x and the difference is exactly
      // "is the AI working". A single number here would be wrong on one of the
      // two runs somebody is about to compare.
      const healthyTicks = Math.ceil((CFG.laps * probe.trackLength) / 25 / CFG.simStep)
      const worstTicks = Math.ceil(probe.trackLength / CFG.minMeanSpeed / CFG.simStep) * CFG.laps
      console.log(
        `field ${probe.kartCount} karts, circuit ${probe.trackLength.toFixed(0)} m, ${CFG.laps} laps, ` +
          `${CFG.seeds} seed(s) x ${races} race(s)` +
          `${CFG.repeats ? '' : '  [--repeat=0: no determinism repeat]'}` +
          `${CFG.cleanArm ? '' : '  [--clean=0: no clean control arm]'}.`,
      )
      console.log(
        `  ${(healthyTicks * CFG.seeds * races).toLocaleString('en-US')} ticks if the field races (25 m/s), at most ` +
          `${(worstTicks * CFG.seeds * races).toLocaleString('en-US')} if it cannot — every one through stepTicks, ` +
          `never a wall-clock wait.`,
      )
      console.log('')

      const t0 = Date.now()
      const runs = await experiment(page, runCfg, true)
      const wallSeconds = (Date.now() - t0) / 1000
      const checks = grade(runs, runCfg)
      const diag = diagnostics(runs, runCfg, probe.checkpoints)
      console.log('')
      printChecks(checks)
      printEvaluability(checks)
      printDiagnostics(diag, runCfg)
      printProvenance(audit)
      writeFileSync(
        path.join(OUT, 'autoplay.json'),
        JSON.stringify({ probe, runs, checks, diag, provenance: audit.rows, wallSeconds }, null, 2),
      )
      console.log('')
      console.log(
        `report   ${path.join(OUT, 'autoplay.json')}   (${wallSeconds.toFixed(0)} s of wall clock, ` +
          `${runs.reduce((a, r) => a + Object.values(r).reduce((b, v) => b + (v && v.ticks ? v.ticks : 0), 0), 0).toLocaleString('en-US')} ticks simulated)`,
      )

      const failed = checks.filter((c) => c.status === 'FAIL')
      const pending = checks.filter((c) => c.status === 'PEND')
      console.log(GATE_BASIS)
      if (pending.length || audit.dead.size) console.log(CONTRACT_ADDITIONS)
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
    printEvaluability(cleanChecks)
    printDiagnostics(cleanDiag, runCfg)
    /*
     * Against the REAL tree, deliberately. The reference game draws wall hits of
     * its own, so this is the one place the two halves meet: a counter the game
     * cannot produce stays withheld even when the instrument under test is
     * handing over a perfectly good number for it. That is the failure mode the
     * old self-test could not see, printed where it cannot be missed.
     */
    printProvenance(audit)
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

    /*
     * COVERAGE SABOTAGES. Switching off an arm must produce PENDING, never a
     * pass and never a FAIL — the reference game underneath is honest and
     * nothing about it is broken. This is what `--repeat=0` and `--clean=0`
     * would otherwise be free to hide.
     */
    console.log('')
    await installReference(page, 'none')
    for (const sab of COVERAGE_SABOTAGES) {
      const cfg = { ...runCfg, ...sab.over }
      const runs = await experiment(page, cfg, false)
      const checks = grade(runs, cfg)
      const target = checks.find((c) => c.id === sab.owner)
      const got = target ? target.status : 'absent'
      const ok = got === sab.expect
      rows.push({ name: sab.name, owner: sab.owner, expect: sab.expect, got, collateral: [] })
      console.log(
        `${ok ? 'CAUGHT' : 'MISSED'}  ${sab.name.padEnd(26)} -> ${sab.owner.padEnd(12)} expected ${sab.expect}, got ${got}` +
          `\n                                                     ${sab.what}` +
          (ok && target && target.notes[0] ? `\n                                                     ${target.notes[0].split('\n')[0].slice(0, 130)}` : ''),
      )
      if (!ok) misses.push(`${sab.name}: ${sab.owner} was expected to be ${sab.expect} and was ${got}`)
    }

    /*
     * EVALUABILITY. A field that never gets round is not a broken instrument,
     * but it takes three gates' subject matter away with it, and the run must
     * say so in a way that cannot be read as a normal result.
     */
    console.log('')
    for (const sab of EVALUABILITY_SABOTAGES) {
      await installReference(page, sab.sabotage)
      const runs = await experiment(page, runCfg, false)
      const checks = grade(runs, runCfg)
      const diag = diagnostics(runs, runCfg, probe.checkpoints)
      const text = captureLog(() => {
        printEvaluability(checks)
        printDiagnostics(diag, runCfg)
      })
      const byId = new Map(checks.map((c) => [c.id, c]))
      const dark = ['determinism', 'drift-pays', 'ladder'].filter((id) => byId.get(id) && !byId.get(id).evaluated)
      const green = checks.filter((c) => c.status === 'PASS').map((c) => c.id)
      const ok =
        dark.length === 3 &&
        green.length === 0 &&
        byId.get('completes').status === 'FAIL' &&
        /lap times\s+UNMEASURABLE/.test(text) &&
        /lap clock\s+UNMEASURABLE/.test(text) &&
        /time lost\s+UNMEASURABLE/.test(text) &&
        /3 of 4 gate\(s\) graded nothing/.test(text)
      rows.push({ name: sab.name, owner: 'evaluability', expect: 'CAUGHT', got: ok ? 'CAUGHT' : 'MISSED' })
      console.log(
        `${ok ? 'CAUGHT' : 'MISSED'}  ${sab.name.padEnd(26)} -> ${'evaluability'.padEnd(12)} ${sab.what}` +
          `\n                                                     dark: ${dark.join(', ') || 'none'}   still PASS: ${green.join(', ') || 'none'}   completes: ${byId.get('completes').status}`,
      )
      if (!ok) misses.push(`${sab.name}: a run with no laps did not report itself as covering nothing`)
    }

    /*
     * THE COUNTER-PROVENANCE SABOTAGES, and the reason this block exists at all.
     *
     * The old self-test proved the analysis and never the source: the reference
     * game draws its own wall hits, so `wallContacts` was exercised end to end
     * against numbers that could not come from the game. Everything below drives
     * the OTHER half — the scan that decides whether the counter can move — and
     * asserts on the PRINTED SENTENCE, because the sentence is where the lie was.
     */
    console.log('')
    {
      const wired = auditCounters(scanEmitters(FAKE_SRC_WIRED))
      const unwired = auditCounters(scanEmitters(FAKE_SRC_UNWIRED))
      const inert = auditCounters(scanEmitters([{ path: 'src/empty.ts', text: 'const x = 1\n' }]))
      const fakeRuns = await (async () => {
        await installReference(page, 'none')
        return experiment(page, runCfg, false)
      })()

      const say = (dead) => {
        const cfg = { ...runCfg, deadCounters: Array.from(dead) }
        const d = diagnostics(fakeRuns, cfg, probe.checkpoints)
        return { text: captureLog(() => printDiagnostics(d, cfg)), diag: d }
      }
      const withWall = say(wired.dead)
      const withoutWall = say(unwired.dead)

      const cases = [
        {
          name: 'wall-source-unwired',
          ok:
            unwired.dead.has('wallHits') &&
            withoutWall.diag.wallContacts.perKartLap === null &&
            /wall contacts\s+UNMEASURABLE/.test(withoutWall.text) &&
            // The LIVE format specifically — `= 0.17 per kart per lap`. The
            // unmeasurable branch quotes the phrase while explaining what it
            // used to print, and a bare substring match would reject its own
            // explanation and read as a caught sabotage for the wrong reason.
            !/=\s*[\d.]+\s*per kart per lap/.test(withoutWall.text),
          what: "no emitter for 'kart:wall': the printed line must say UNMEASURABLE and quote no rate",
          detail: (withoutWall.text.split('\n').find((l) => l.includes('wall contacts')) || '(no wall line at all)').trim(),
        },
        {
          name: 'wall-source-wired',
          ok:
            !wired.dead.has('wallHits') &&
            withWall.diag.wallContacts.perKartLap !== null &&
            /per kart per lap/.test(withWall.text),
          what: 'an emitter exists: the rate must come back, or this check is just always-off',
          detail: (withWall.text.split('\n').find((l) => l.includes('wall contacts')) || '(no wall line at all)').trim(),
        },
        {
          name: 'scanner-inert',
          ok: inert.inert === true && wired.inert === false,
          what: 'a scan that finds NO emitter anywhere is the scanner broken, not the game — it must refuse, not report',
          detail: `empty tree inert=${inert.inert}, wired tree inert=${wired.inert}`,
        },
        {
          name: 'completes-hides-dead-zero',
          ok: (() => {
            const cfg = { ...runCfg, deadCounters: ['wallHits'] }
            const broken = grade(
              [{ seed: 1, seek: { ...fakeRuns[0].seek, karts: fakeRuns[0].seek.karts.map((k, i) => (i ? k : { ...k, finished: false })) } }],
              cfg,
            ).find((c) => c.id === 'completes')
            return broken.problems.some((p) => p.includes('wall hits unmeasurable')) && !broken.problems.some((p) => /\d+ wall hit\(s\)/.test(p))
          })(),
          what: 'the completes failure text must not report a dead counter as "0 wall hit(s)" either',
          detail: 'checked against a kart forced not-finished so the sentence is produced',
        },
      ]
      for (const c of cases) {
        rows.push({ name: c.name, owner: 'provenance', expect: 'CAUGHT', got: c.ok ? 'CAUGHT' : 'MISSED' })
        console.log(
          `${c.ok ? 'CAUGHT' : 'MISSED'}  ${c.name.padEnd(26)} -> ${'provenance'.padEnd(12)} ${c.what}` +
            `\n                                                     ${c.detail.slice(0, 150)}`,
        )
        if (!c.ok) misses.push(`${c.name}: the counter-provenance report did not behave as claimed`)
      }
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
        `SELF-TEST PASSED — the reference game passes clean; all ${SABOTAGES.length} game sabotages were caught by\n` +
          `their owning gate with the status that failure deserves (including the two that must read PENDING rather\n` +
          `than FAIL, and the one that has no lap times for the gate to compare); both coverage switches produced\n` +
          `PENDING rather than a green run; a field that completes no laps reported three of four gates as NOT\n` +
          `EVALUATED and every lap diagnostic as UNMEASURABLE rather than quietly omitting them; the\n` +
          `counter-provenance scan was watched deciding BOTH ways and refusing when inert; and a harness with\n` +
          `nothing behind it reported PENDING rather than green.`,
      )
    }
  } finally {
    await browser.close()
  }
}

await main()
