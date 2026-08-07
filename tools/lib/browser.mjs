/**
 * Shared browser launcher, with the GPU discipline every timing harness needs.
 *
 * This machine has two GPUs — a Radeon 780M integrated part and an RTX 4050 —
 * and the very first smoke run came back rendered on the 780M without anyone
 * asking for it. A frame time measured on the wrong adapter is not a smaller
 * number or a noisier one; it is an answer to a different question, and nothing
 * in the output says so.
 *
 * Correctness harnesses may run anywhere. Timing harnesses must state which
 * adapter they require and refuse to print a number they cannot attribute to it.
 */

import { chromium } from 'playwright'

/** Correctness work: any renderer will do, including a software one. */
export const CORRECTNESS_ARGS = [
  '--use-angle=d3d11',
  '--ignore-gpu-blocklist',
  // Explicitly allowed here. A timing harness must NOT pass this.
  '--enable-unsafe-swiftshader',
]

/**
 * Timing work. Note what is absent: `--enable-unsafe-swiftshader`. Without it,
 * a machine that cannot reach a real GPU fails to render rather than quietly
 * falling back to SwiftShader and returning confident, meaningless numbers.
 *
 * vsync is disabled on purpose. With it on, every build that can hold the
 * refresh rate reports the identical frame time, so a change that halves GPU
 * cost is invisible — and the median frame time of a build running at 48 fps is
 * exactly 16.70 ms, which reads as a perfect pass. Cost is what we optimise
 * against; whether the cost fits inside 16.7 ms is a separate question this
 * harness answers from the same measurement.
 */
export const TIMING_ARGS = [
  '--use-angle=d3d11',
  '--ignore-gpu-blocklist',
  '--force_high_performance_gpu',
  '--disable-gpu-vsync',
  '--disable-frame-rate-limit',
]

/** Substrings that mean "this is not the discrete GPU". */
const INTEGRATED = /radeon\(tm\) 7\d\dm|iris|uhd graphics|hd graphics|vega \d+ graphics/i

export function classifyRenderer(name) {
  if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(name)) return 'software'
  if (INTEGRATED.test(name)) return 'integrated'
  return 'discrete'
}

/**
 * @param {{ timing?: boolean, extraArgs?: string[] }} [options]
 */
export async function launch(options = {}) {
  const base = options.timing ? TIMING_ARGS : CORRECTNESS_ARGS
  return chromium.launch({ args: [...base, ...(options.extraArgs ?? [])] })
}

/**
 * Open the game and wait until it has genuinely presented a frame.
 *
 * @param {import('playwright').Browser} browser
 * @param {string} baseUrl
 * @param {Record<string, string|number|boolean>} [query]
 */
export async function openGame(browser, baseUrl, query = {}) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })

  const consoleErrors = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push(String(e)))

  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) params.set(k, String(v))
  const url = `${baseUrl}${params.toString() ? `?${params}` : ''}`

  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__harness), null, { timeout: 30_000 })
  await page.evaluate(() => window.__harness.ready)

  return { page, consoleErrors, url }
}

/**
 * Benchmark runs degrade this machine: consecutive runs fall away with no code
 * change at all, and a live WebGL context left behind by a previous page holds
 * its texture memory. Every sweep point therefore gets a fresh browser and a
 * cooling gap — reusing one browser and opening a page per point is how a fill
 * probe ends up reporting a negative slope.
 */
export async function idle(seconds, label = 'cooling') {
  if (seconds <= 0) return
  process.stdout.write(`  ${label} ${seconds}s…`)
  await new Promise((r) => setTimeout(r, seconds * 1000))
  process.stdout.write(' done\n')
}
