/**
 * The first instrument, and the one every later harness depends on being right:
 * does the built game boot, and does it present a frame that is actually there?
 *
 * It asserts on pixels, not on draw calls. Every known black-screen failure mode
 * still issues a full frame's worth of draws into a canvas nobody sees, so a
 * counter cannot answer this question and neither can "no console errors".
 *
 *   node tools/smoke.mjs              # against the production build
 *   node tools/smoke.mjs --dev        # against the dev server
 *   node tools/smoke.mjs --broken     # self-test: prove the instrument fails
 *
 * `--broken` exists because a harness nobody has seen fail is not evidence. It
 * hides the canvas before sampling, and this script must report FAIL. If it
 * passes, the instrument is lying and every number downstream of it is worthless.
 */

import { chromium } from 'playwright'
import path from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'
import { ROOT, startServer } from './vite-server.mjs'

const args = process.argv.slice(2)
const useDev = args.includes('--dev')
const selfTest = args.includes('--broken')

const OUT = path.join(ROOT, 'tools', 'out')
mkdirSync(OUT, { recursive: true })

// Correctness harness, so a software rasteriser is acceptable here and the flag
// stays. Timing harnesses must NOT pass it — a frame time from SwiftShader is
// fiction, and headless Chrome falls back to it silently while still returning
// confident numbers.
const CHROME_ARGS = [
  '--use-angle=d3d11',
  '--ignore-gpu-blocklist',
  '--enable-unsafe-swiftshader',
]

function fail(msg) {
  console.error(`FAIL  ${msg}`)
  process.exitCode = 1
}

const server = await startServer({ mode: useDev ? 'dev' : 'preview' })
const browser = await chromium.launch({ args: CHROME_ARGS })

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })

  const consoleErrors = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push(String(e)))

  // ?debug=frames creates the context with preserveDrawingBuffer. Without it,
  // readPixels after present returns discarded contents, which reads as
  // "100% of frames are black" and is completely false.
  await page.goto(`${server.url}?debug=frames&quality=high&seed=20260807`, {
    waitUntil: 'domcontentloaded',
  })

  await page.waitForFunction(() => Boolean(window.__harness), null, { timeout: 20_000 })
  await page.evaluate(() => window.__harness.ready)

  // Advance a fixed number of ticks rather than sleeping. A wall-clock wait
  // samples a different point of the animation on every machine, and then two
  // runs of the "same" test are not the same test.
  await page.evaluate(() => window.__harness.stepTicks(30))

  const gl = await page.evaluate(() => window.__harness.glReport())

  /*
   * The sabotage has to produce a real partial-black PRESENT, in the default
   * framebuffer, with no frame drawn in between.
   *
   * The first attempt hid the canvas with CSS and the self-test "failed" —
   * except the instrument was fine and the sabotage was inert. `visibility:
   * hidden` never touches the drawing buffer, so `readPixels` kept returning
   * the perfectly good frame that was still there. A self-test that cannot
   * actually break the thing it is testing proves nothing in either direction.
   *
   * Scissor-clearing the bottom half and reading in the SAME task is the real
   * article: it is exactly the shape of the failure this detector exists for,
   * and a whole-image standard deviation sails straight past it.
   */
  const luma = await page.evaluate((sabotage) => {
    if (sabotage) {
      const canvas = document.querySelector('#app canvas')
      const ctx = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
      ctx.bindFramebuffer(ctx.FRAMEBUFFER, null)
      ctx.enable(ctx.SCISSOR_TEST)
      ctx.scissor(0, 0, ctx.drawingBufferWidth, Math.floor(ctx.drawingBufferHeight / 2))
      ctx.clearColor(0, 0, 0, 1)
      ctx.clear(ctx.COLOR_BUFFER_BIT)
      ctx.disable(ctx.SCISSOR_TEST)
    }
    // No await, no rAF: the cleared buffer is still the presented one.
    return window.__harness.frameLumaStats()
  }, selfTest)
  const stats = await page.evaluate(() => {
    window.__harness.beginSample()
    return window.__harness.stepTicks(60).then(() => window.__harness.endSample())
  })

  console.log(`renderer     ${gl.renderer}${gl.isSoftware ? '   [SOFTWARE]' : ''}`)
  console.log(`vendor       ${gl.vendor}`)
  console.log(`preserveBuf  ${gl.preserveDrawingBuffer}`)
  console.log(`draw calls   ${stats.drawCalls}`)
  console.log(`triangles    ${stats.triangles}`)
  console.log(
    `luma         mean ${luma.mean.toFixed(4)}  sd ${luma.stdDev.toFixed(4)}  ` +
      `dark ${(luma.darkFraction * 100).toFixed(1)}%  bright ${(luma.brightFraction * 100).toFixed(2)}%  ` +
      `clipped ${(luma.clippedFraction * 100).toFixed(2)}%`,
  )
  console.log(
    `tiles        unpainted ${luma.unpaintedTiles}  ` +
      `(worst tile black ${(luma.worstTileBlackFraction * 100).toFixed(0)}% — reported, not gated)`,
  )

  // --- assertions ---------------------------------------------------------

  if (!gl.preserveDrawingBuffer) fail('context lacks preserveDrawingBuffer; pixel reads are meaningless')
  if (gl.contextLost) fail('WebGL context was lost')
  if (gl.failedShaders.length) fail(`shaders failed to compile: ${gl.failedShaders.join(', ')}`)

  // A frame that is a flat colour is what every black-screen failure looks like.
  if (luma.stdDev < 0.02) fail(`frame is nearly flat (sd ${luma.stdDev.toFixed(4)}) — nothing is being drawn`)

  /*
   * The tile check is the one that matters, and it keys on UNIFORMITY, not
   * darkness. This assertion used to read `worstTileBlackFraction > 0.98`.
   * Measuring a real shipped neon-night scene retired that outright: it has
   * tiles at 98% and 99% black which are entirely correct, so the old rule
   * would have failed exactly the frame the art direction is aiming for.
   *
   * DARKNESS SURVIVED AS A SIGNAL FOR EXACTLY ONE THEME, AND IT IS NOT THIS
   * ONE. At night a correct frame was full of near-black tiles; under a 12° sun
   * §9a puts the deepest legitimate surface at luma 0.070 and there are no
   * legitimately black tiles at all. The question "was this drawn?" is answered
   * by variance in both cases, which is why the detector outlived the theme.
   *
   * A region the GPU never painted has zero variance, AT ANY BRIGHTNESS — the
   * darkness clause was removed from the detector itself (see the note in
   * `diagnostics.ts` beside `UNPAINTED_STDDEV`), because `setClearColor(sky)`
   * is an ordinary thing to write under a bright sky and would otherwise
   * disable it. Do not put "and black" back into this message: a blown flat sky
   * trips this gate and describing it as black sends the reader to the wrong
   * subsystem. See ART_DIRECTION §9b.
   */
  if (luma.unpaintedTiles > 0) {
    fail(`${luma.unpaintedTiles} tile(s) are uniform — part of the frame was never drawn`)
  }

  if (stats.drawCalls === 0) fail('zero draw calls')
  if (consoleErrors.length) fail(`console errors:\n  ${consoleErrors.join('\n  ')}`)

  const shot = await page.screenshot()
  const shotPath = path.join(OUT, selfTest ? 'smoke-broken.png' : 'smoke.png')
  writeFileSync(shotPath, shot)
  console.log(`screenshot   ${shotPath}`)

  if (selfTest) {
    if (process.exitCode === 1) {
      console.log('\nSELF-TEST PASSED — the instrument correctly failed on a broken frame.')
      process.exitCode = 0
    } else {
      console.error('\nSELF-TEST FAILED — the instrument passed a frame it should have rejected.')
      console.error('Every number downstream of this harness is worthless until that is fixed.')
      process.exitCode = 1
    }
  } else if (process.exitCode !== 1) {
    console.log('\nPASS')
  }
} finally {
  await browser.close()
  await server.stop()
}
