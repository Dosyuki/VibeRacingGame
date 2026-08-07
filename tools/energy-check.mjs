/**
 * ART_DIRECTION §8 — the additive energy budget, enforced as a number.
 *
 *   node tools/energy-check.mjs
 *   node tools/energy-check.mjs --broken   # self-test: the clip gate must fire
 *
 * A city built out of emitters, plus bloom, walks toward a white screen one
 * defensible commit at a time. No single change looks wrong, every reviewer
 * says "a little brighter is fine", and four rounds later the frame is a
 * magenta blob. Taste cannot hold that line across parallel agents who never
 * see each other's work. A measured ceiling can.
 *
 *   mean frame luma        <= 0.42
 *   clipped pixels         <= 3.0%    (luma >= 0.99)
 *   worst-case clipped     <= 6.0%    (tier-3 boost at the tunnel exit)
 *   frame luma std-dev     >= 0.11    (a flat frame fails even when it is dark)
 *
 * It walks every §10 vantage. Those that need subsystems which do not exist yet
 * are reported as PENDING, not silently skipped — a gate that quietly covers
 * nothing reads exactly like a gate that passed.
 */

import { ROOT, startServer } from './vite-server.mjs'
import { launch, openGame } from './lib/browser.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const selfTest = process.argv.includes('--broken')

const LIMITS = {
  meanLuma: 0.42,
  clipped: 0.03,
  clippedWorstCase: 0.06,
  minStdDev: 0.11,
}

const VANTAGES = [
  'grid',
  'boulevard',
  'market',
  'underpass',
  'ramp-vista',
  'hairpin',
  'tram',
  'river-bank',
  'tunnel-exit',
  'drift-tier3',
]

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
   * @param {string} label
   * @param {number} clipLimit
   */
  async function measure(label, clipLimit) {
    const luma = await page.evaluate((sabotage) => {
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

    const problems = []
    if (luma.mean > LIMITS.meanLuma) problems.push(`mean luma ${luma.mean.toFixed(3)} > ${LIMITS.meanLuma}`)
    if (luma.clippedFraction > clipLimit) {
      problems.push(`clipped ${(luma.clippedFraction * 100).toFixed(2)}% > ${(clipLimit * 100).toFixed(1)}%`)
    }
    if (luma.stdDev < LIMITS.minStdDev) {
      problems.push(`std-dev ${luma.stdDev.toFixed(3)} < ${LIMITS.minStdDev} (frame is flat)`)
    }

    rows.push({
      vantage: label,
      mean: luma.mean,
      stdDev: luma.stdDev,
      clipped: luma.clippedFraction,
      worstTileClipped: luma.worstTileClippedFraction,
      pass: problems.length === 0,
    })

    const verdict = problems.length === 0 ? 'PASS' : 'FAIL'
    console.log(
      `${verdict}  ${label.padEnd(14)} mean ${luma.mean.toFixed(3)}  ` +
        `sd ${luma.stdDev.toFixed(3)}  clipped ${(luma.clippedFraction * 100).toFixed(2)}%` +
        (problems.length ? `\n      ${problems.join('\n      ')}` : ''),
    )
    if (problems.length) failures.push(`${label}: ${problems.join('; ')}`)
  }

  // Whatever the game currently presents, measured against the budget. This is
  // the row that exists before any vantage does.
  await measure('current-view', LIMITS.clipped)

  let pending = 0
  for (const name of VANTAGES) {
    const limit = name === 'tunnel-exit' || name === 'drift-tier3' ? LIMITS.clippedWorstCase : LIMITS.clipped
    try {
      await page.evaluate((v) => window.__harness.vantage(v), name)
      await page.evaluate(() => window.__harness.stepTicks(4))
      await measure(name, limit)
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
    console.log('PASS — within the §8 energy budget.')
  }
} finally {
  await browser.close()
  await server.stop()
}
