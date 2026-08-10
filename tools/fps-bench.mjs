/**
 * Frame cost, measured on a GPU we can name.
 *
 *   node tools/fps-bench.mjs                    # default: require a discrete GPU
 *   node tools/fps-bench.mjs --allow-integrated # laptop-on-battery runs
 *   node tools/fps-bench.mjs --quality low      # pin a tier
 *   node tools/fps-bench.mjs --runs 3           # repeat, with cooling between
 *   node tools/fps-bench.mjs --force-software   # self-test: the refusal must fire
 *
 * Three refusals are the point of this file. It will not print a number when:
 *   - the frame was rendered by a software rasteriser
 *   - the adapter is not the one the run required
 *   - the adaptive scaler claimed to be pinned and was not
 *
 * Each of those produces a confident, precise, wrong answer otherwise, and none
 * of them look like an error in the output.
 */

import { ROOT, startServer } from './vite-server.mjs'
import { classifyRenderer, idle, launch, openGame } from './lib/browser.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(`--${name}`)

const QUALITY = flag('quality', 'high')
const RUNS = Number(flag('runs', '1'))
const WARMUP_TICKS = 240
const SAMPLE_TICKS = 600
const ALLOW_INTEGRATED = has('allow-integrated')
const FORCE_SOFTWARE = has('force-software')

/** At 60 Hz. A mean frame cost above this cannot hold the refresh rate. */
const BUDGET_MS = 1000 / 60

const OUT = path.join(ROOT, 'tools', 'out')
mkdirSync(OUT, { recursive: true })

function refuse(reason) {
  console.error(`\nREFUSED  ${reason}`)
  console.error('No frame time is reported. A number this harness cannot attribute is worse than none.')
  process.exitCode = 2
}

const server = await startServer({ mode: 'preview' })
const results = []

try {
  for (let run = 1; run <= RUNS; run++) {
    // Fresh browser per point. See lib/browser.mjs — reusing one leaves a live
    // context and its texture memory alive and the numbers walk downward.
    const browser = await launch({
      timing: !FORCE_SOFTWARE,
      extraArgs: FORCE_SOFTWARE ? ['--enable-unsafe-swiftshader', '--disable-gpu'] : [],
    })

    try {
      const { page, consoleErrors } = await openGame(browser, server.url, {
        quality: QUALITY,
        seed: 20260807,
        scaler: 'off',
      })

      const gl = await page.evaluate(() => window.__harness.glReport())
      const kind = classifyRenderer(gl.renderer)

      if (run === 1) {
        console.log(`renderer   ${gl.renderer}`)
        console.log(`class      ${kind}`)
        console.log(`quality    ${QUALITY}`)
      }

      if (kind === 'software') {
        refuse(`frame times came from a software rasteriser (${gl.renderer}).`)
        break
      }
      if (kind === 'integrated' && !ALLOW_INTEGRATED) {
        refuse(
          `rendered on the integrated GPU (${gl.renderer}), not the discrete one.\n` +
            `         Chrome picks this on its own; force the dGPU in Windows Graphics Settings for\n` +
            `         the Chromium binary, or re-run with --allow-integrated to measure it deliberately.`,
        )
        break
      }

      // Pin the scaler and verify the pin TOOK. An unpinned run spends a real
      // saving on extra pixels and reports the same fps — the optimisation is
      // genuine and completely invisible.
      await page.evaluate(() => window.__harness.pinScaler(true))
      const pinned = await page.evaluate(() => window.__harness.scalerPinned())
      if (!pinned) {
        refuse('the adaptive scaler reported it is not pinned. An unpinned A/B measures nothing.')
        break
      }

      await page.evaluate((n) => window.__harness.stepTicks(n), WARMUP_TICKS)

      const stats = await page.evaluate(async (n) => {
        window.__harness.beginSample()
        await window.__harness.stepTicks(n)
        return window.__harness.endSample()
      }, SAMPLE_TICKS)

      if (consoleErrors.length) {
        console.error(`  console errors during run ${run}:\n    ${consoleErrors.join('\n    ')}`)
      }

      results.push({ run, renderer: gl.renderer, ...stats })
      console.log(
        `run ${run}      mean ${stats.meanFrameMs.toFixed(2)} ms  ` +
          `p95 ${stats.p95FrameMs.toFixed(2)} ms  ` +
          `long ${stats.longFrames}  ` +
          `draws ${stats.drawCalls}  tris ${stats.triangles}`,
      )
    } finally {
      await browser.close()
    }

    // The machine degrades across consecutive runs with no code change at all.
    if (run < RUNS) await idle(120, 'cooling')
  }

  if (process.exitCode === 2) {
    // Refused. Nothing further to say.
  } else if (results.length === 0) {
    refuse('no runs completed.')
  } else {
    const means = results.map((r) => r.meanFrameMs)
    const best = Math.min(...means)
    const worst = Math.max(...means)
    const avg = means.reduce((a, b) => a + b, 0) / means.length

    console.log('')
    // Gate on the MEAN. The median is pinned to the vsync grid on a vsync-on
    // run and reads as a perfect pass for a build that is visibly dropping
    // frames; this harness disables vsync, and the mean is the honest figure
    // either way.
    console.log(`mean       ${avg.toFixed(2)} ms  (${(1000 / avg).toFixed(1)} fps equivalent)`)
    if (results.length > 1) {
      console.log(`spread     ${(worst - best).toFixed(2)} ms across ${results.length} runs`)
    }
    console.log(`60 fps     ${avg <= BUDGET_MS ? 'PASS' : 'FAIL'}  (budget ${BUDGET_MS.toFixed(2)} ms)`)

    const draws = results[0].drawCalls
    console.log(`draw calls ${draws <= 250 ? 'PASS' : 'FAIL'}  ${draws} / 250  (ART_DIRECTION §9)`)

    if (avg > BUDGET_MS || draws > 250) process.exitCode = 1

    writeFileSync(path.join(OUT, 'fps-bench.json'), JSON.stringify(results, null, 2))
  }

  if (FORCE_SOFTWARE) {
    console.log('')
    if (process.exitCode === 2) {
      console.log('SELF-TEST PASSED — the harness refused a software-rendered timing run.')
      process.exitCode = 0
    } else {
      console.error('SELF-TEST FAILED — the harness reported a frame time it should have refused.')
      process.exitCode = 1
    }
  }
} finally {
  await server.stop()
}
