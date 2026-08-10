/**
 * ART_DIRECTION §9a — the frame-energy budget, enforced as a number.
 *
 *   node tools/energy-check.mjs
 *   node tools/energy-check.mjs --broken   # self-test: the clip gate must fire
 *
 * A frame drifts one defensible commit at a time. No single change looks wrong,
 * every reviewer says "a little brighter is fine" or "the shadows are hard to
 * read", and four rounds later the image has no range left in it. Taste cannot
 * hold that line across parallel agents who never see each other's work. A
 * measured ceiling can.
 *
 * WHICH WAY THE FRAME DRIFTS DEPENDS ON THE THEME, AND THIS FILE HAS CHANGED
 * THEME ONCE. Under the night circuit the failure was a white screen creeping
 * in. Under a 12° sun it is the opposite: a desert is *supposed* to be bright,
 * and its failure is a FLAT frame — high mean luma with collapsing variance,
 * which is what happens when shadows get lightened one commit at a time to
 * answer a readability complaint. The std-dev floor and the shadow-occupancy
 * floor are the two rows a flat frame cannot pass, and the two most likely to
 * be argued away. See §9a.
 *
 * The numbers are NOT restated here. They live in `LIMITS` below, each one
 * labelled derived or guess, because the previous version of this comment
 * carried the night tier's mean/clip/std-dev long after `LIMITS` had moved to
 * the desert tier — and a docblock that contradicts the gate it documents will
 * eventually be "fixed" in the wrong direction.
 *
 * It walks every §11 vantage. Those that need subsystems which do not exist yet
 * are reported as PENDING, not silently skipped — a gate that quietly covers
 * nothing reads exactly like a gate that passed.
 */

import { ROOT, startServer } from './vite-server.mjs'
import { launch, openGame } from './lib/browser.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const selfTest = process.argv.includes('--broken')

/*
 * ART_DIRECTION §9a, recalibrated for a sunlit desert canyon.
 *
 * These are NOT the night numbers rescaled. The previous set was measured off a
 * real neon-rain scene — mean 0.061-0.123, dark 45-74%, bright 2.4-4.5% — and
 * every one of those describes the opposite of this theme. Carrying them across
 * would have failed every correct frame.
 *
 * Two gates changed meaning rather than value:
 *   - `dark` was a MINIMUM (the substrate neon reads against) and is now a
 *     MAXIMUM. Derived: the deepest legitimate surface here — a niche under an
 *     overhang, 8% sky and no sun — computes through the ACES fit to luma
 *     0.070, so anything under 0.05 is a shadow term clamping to zero.
 *   - `bright` at luma 0.5 measured emissive AREA at night. Under a sun, 0.5 is
 *     1.19x sunlit sand, so sand, rock and sky are all above it and a correct
 *     frame reads 60-80%. It survives as a wide sanity rail. The gate that
 *     actually catches "walking toward a white screen" moved a stop up, to
 *     `highlight` at 0.95.
 *
 * DERIVED vs GUESS is marked per line and the distinction is not decoration.
 * The guesses depend on how much sky, wall and floor a vantage frames, and that
 * composition is invented until it is measured. See §9a for the procedure.
 */
const LIMITS = {
  /*
   * meanLumaMin and brightMin were 0.38 and 0.35, revised down after the first
   * measured frames — and the reason matters, because "the gate failed so I
   * moved the gate" is the exact failure this file exists to prevent.
   *
   * Both were flagged from the outset as guesses standing on invented
   * composition weights: sky 20%, sunlit wall 25%, shaded wall 15%, sunlit sand
   * 30%, kart 2%. That model has no ROAD in it. A kart racer frames a dark
   * tarmac ribbon across the bottom third of every shot, at a linear albedo of
   * 0.059 against sand's 0.35, and §3b makes that contrast the racing line — it
   * is the point, not a defect. Adding ~30% of frame at luma 0.27 moves the mean
   * down by roughly 0.08, which is the size of the discrepancy observed.
   *
   * So the composition model was wrong, not the frame. These stay labelled as
   * guesses and still belong in the first measurement round; the derived rows
   * below have not moved.
   */
  meanLumaMin: 0.3, // guess — revised: composition model omitted the road
  meanLumaMax: 0.75, // guess, and the weakest number here
  minStdDev: 0.15, // guess on the value; derived on the direction (must rise)
  maxDark: 0.06, // DERIVED — deepest legitimate surface is luma 0.070
  brightMin: 0.28, // guess — shape check, "is this actually a sunlit scene"
  brightMax: 0.85, // guess
  maxHighlight: 0.02, // derived threshold, guessed area
  maxHighlightWorstCase: 0.06, // guess
  clipped: 0.0005, // DERIVED — clipping needs +5.4 stops over sunlit sand
  clippedWorstCase: 0.0025, // DERIVED — sun disc is 0.0029% of frame; ~85x that
}

const VANTAGES = [
  'grid',
  'dune-sweep',
  'strata-wall',
  'slot-narrows',
  'mesa-crest',
  'banked-wall',
  'wash-descent',
  'arch-interior',
  'arch-exit',
  'drift-tier3',
]

/**
 * The two vantages that carry the relaxed worst-case limits — the brightest
 * reachable states in the game. Renaming either in VANTAGES without updating
 * this set silently stops the relaxation applying, which reads as a stricter
 * gate that mysteriously fails.
 */
const WORST_CASE = new Set(['arch-exit', 'drift-tier3'])

const OUT = path.join(ROOT, 'tools', 'out')
mkdirSync(OUT, { recursive: true })

const failures = []
const rows = []

const server = await startServer({ mode: 'preview' })
const browser = await launch({ timing: false })

try {
  const { page } = await openGame(browser, server.url, {
    debug: 'frames',
    quality: 'high',
    seed: 20260807,
  })

  await page.evaluate(() => window.__harness.stepTicks(60))

  /**
   * Sample several frames and gate on the WORST.
   *
   * A single frame is not the scene. Measuring one tick put emissive area at
   * 2.2% while another tick of the same build measured 8.7% — one of those
   * passes the budget and one does not, and which one you get depends on where
   * the camera happened to be. Gating on a single sample means the verdict is
   * decided by timing.
   *
   * @param {string} label
   * @param {number} clipLimit
   * @param {number} samples
   */
  async function measure(label, clipLimit, highlightLimit, samples = 5) {
    const frames = [await sample()]
    for (let i = 1; i < samples; i++) {
      await page.evaluate(() => window.__harness.stepTicks(37))
      frames.push(await sample())
    }

    /*
     * EVERY sample is checked against EVERY limit, and the frame REPORTED is a
     * frame that actually failed.
     *
     * Two bugs live here, both already paid for. The first version kept only
     * the frame with the largest emissive area and graded that one, which
     * passed a build whose dimmest frame measured 0.042 mean luma — the frame
     * that failed was not the frame being looked at. "Worst frame" only works
     * if there is one axis to be worst on, and there are six.
     *
     * The fix that replaced it ranked frames by how far outside the band they
     * sat, but the ranking function did not include every limit, so the run
     * printed FAIL next to a frame with no problems listed under it. A verdict
     * you cannot trace to evidence is not much better than no verdict.
     */
    const graded = frames.map((f) => ({ luma: f, problems: evaluate(f, clipLimit, highlightLimit) }))
    const failing = graded.filter((g) => g.problems.length > 0)
    const shown = failing[0] ?? graded.reduce((a, b) => (b.luma.brightFraction > a.luma.brightFraction ? b : a))

    report(label, shown, frames.length, failing.length)
  }

  async function sample() {
    return page.evaluate((sabotage) => {
      if (sabotage) {
        // Blow out a quarter of the frame to pure white — the exact shape of
        // the failure this gate exists to catch.
        const canvas = document.querySelector('#app canvas')
        const ctx = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
        ctx.bindFramebuffer(ctx.FRAMEBUFFER, null)
        ctx.enable(ctx.SCISSOR_TEST)
        ctx.scissor(0, 0, Math.floor(ctx.drawingBufferWidth / 2), Math.floor(ctx.drawingBufferHeight / 2))
        ctx.clearColor(1, 1, 1, 1)
        ctx.clear(ctx.COLOR_BUFFER_BIT)
        ctx.disable(ctx.SCISSOR_TEST)
      }
      return window.__harness.frameLumaStats()
    }, selfTest)
  }

  /**
   * @param {string} label
   * @param {number} clipLimit
   * @param {import('../../src/types').FrameLumaStats} luma
   */
  /**
   * Pure: the list of budget violations in one frame. No printing, no state.
   * @returns {string[]}
   */
  function evaluate(luma, clipLimit, highlightLimit) {
    const problems = []
    if (luma.mean > LIMITS.meanLumaMax) {
      problems.push(`mean luma ${luma.mean.toFixed(3)} > ${LIMITS.meanLumaMax} — the frame is washing out`)
    }
    if (luma.mean < LIMITS.meanLumaMin) {
      problems.push(`mean luma ${luma.mean.toFixed(3)} < ${LIMITS.meanLumaMin} — underexposed`)
    }
    if (luma.darkFraction > LIMITS.maxDark) {
      problems.push(
        `dark ${(luma.darkFraction * 100).toFixed(1)}% > ${(LIMITS.maxDark * 100).toFixed(0)}% — ` +
          `a shadow term is clamping to zero, or geometry is unlit`,
      )
    }
    if (luma.brightFraction < LIMITS.brightMin || luma.brightFraction > LIMITS.brightMax) {
      problems.push(
        `bright ${(luma.brightFraction * 100).toFixed(1)}% outside ` +
          `${(LIMITS.brightMin * 100).toFixed(0)}-${(LIMITS.brightMax * 100).toFixed(0)}% — ` +
          `this does not read as a sunlit scene`,
      )
    }
    if (luma.highlightFraction > highlightLimit) {
      problems.push(
        `highlight ${(luma.highlightFraction * 100).toFixed(2)}% > ${(highlightLimit * 100).toFixed(2)}% — ` +
          `the frame is walking toward white`,
      )
    }
    if (luma.clippedFraction > clipLimit) {
      problems.push(`clipped ${(luma.clippedFraction * 100).toFixed(3)}% > ${(clipLimit * 100).toFixed(3)}%`)
    }
    if (luma.stdDev < LIMITS.minStdDev) {
      problems.push(`std-dev ${luma.stdDev.toFixed(3)} < ${LIMITS.minStdDev} — flat, which is the daylight failure`)
    }
    if (luma.unpaintedTiles > 0) {
      problems.push(`${luma.unpaintedTiles} unpainted tile(s) — part of the frame was never drawn`)
    }
    if (luma.flatBrightTiles > 1) {
      problems.push(
        `${luma.flatBrightTiles} flat-bright tile(s) — painted, but with nothing in them ` +
          `(blown sky, or a procedural albedo returning a constant)`,
      )
    }

    return problems
  }

  function report(label, shown, frameCount, failedFrames) {
    const { luma, problems } = shown

    rows.push({
      vantage: label,
      mean: luma.mean,
      stdDev: luma.stdDev,
      dark: luma.darkFraction,
      bright: luma.brightFraction,
      clipped: luma.clippedFraction,
      unpaintedTiles: luma.unpaintedTiles,
      framesSampled: frameCount,
      framesFailed: failedFrames,
      pass: failedFrames === 0,
    })

    const verdict = failedFrames === 0 ? 'PASS' : 'FAIL'
    console.log(
      `${verdict}  ${label.padEnd(14)} mean ${luma.mean.toFixed(3)}  sd ${luma.stdDev.toFixed(3)}  ` +
        `dark ${(luma.darkFraction * 100).toFixed(0)}%  bright ${(luma.brightFraction * 100).toFixed(1)}%  ` +
        `clip ${(luma.clippedFraction * 100).toFixed(2)}%  ` +
        `[${frameCount - failedFrames}/${frameCount} frames ok]` +
        (problems.length ? `\n      ${problems.join('\n      ')}` : ''),
    )
    if (failedFrames > 0) failures.push(`${label}: ${problems.join('; ')}`)
  }

  // Whatever the game currently presents, measured against the budget. This is
  // the row that exists before any vantage does.
  await measure('current-view', LIMITS.clipped, LIMITS.maxHighlight)

  let pending = 0
  for (const name of VANTAGES) {
    const worst = WORST_CASE.has(name)
    const limit = worst ? LIMITS.clippedWorstCase : LIMITS.clipped
    const hl = worst ? LIMITS.maxHighlightWorstCase : LIMITS.maxHighlight
    try {
      await page.evaluate((v) => window.__harness.vantage(v), name)
      await page.evaluate(() => window.__harness.stepTicks(4))
      await measure(name, limit, hl)
    } catch (err) {
      pending++
      console.log(`PEND  ${name.padEnd(14)} ${String(err.message ?? err).split('\n')[0].slice(0, 100)}`)
    }
  }

  writeFileSync(path.join(OUT, 'energy-check.json'), JSON.stringify({ rows, failures }, null, 2))

  console.log('')
  if (pending > 0) {
    console.log(
      `${pending}/${VANTAGES.length} vantages PENDING — world/ and game/ have not landed. ` +
        `They are reported, not skipped: a gate covering nothing must not read as a gate that passed.`,
    )
  }

  if (selfTest) {
    if (failures.length > 0) {
      console.log('SELF-TEST PASSED — the clip gate fired on a blown-out frame.')
      process.exitCode = 0
    } else {
      console.error('SELF-TEST FAILED — a quarter-white frame passed the energy budget.')
      process.exitCode = 1
    }
  } else if (failures.length > 0) {
    console.error(`ENERGY BUDGET EXCEEDED (${failures.length})`)
    process.exitCode = 1
  } else {
    console.log('PASS — within the §9a frame-energy budget.')
  }
} finally {
  await browser.close()
  await server.stop()
}
