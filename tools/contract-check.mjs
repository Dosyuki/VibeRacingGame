/**
 * Guards the measurement surface itself.
 *
 *   node tools/contract-check.mjs
 *
 * Every method `HarnessAPI` declares must either work or throw the explicit
 * "not available yet" marker. What it must never do is return a plausible
 * value it cannot know — a stubbed `telemetry()` handing back zeroed counters
 * makes every gate downstream of it pass, and the run looks like success.
 *
 * That is the failure this file exists for. A builder under time pressure
 * stubbing a method to `return 0` is not malice, it is the obvious thing to do,
 * and nothing else in the pipeline would ever notice.
 *
 * It also prints the coverage ledger: how much of the surface is live. That
 * number is the honest progress metric for the whole project — far more than
 * lines of code.
 */

import { startServer } from './vite-server.mjs'
import { launch, openGame } from './lib/browser.mjs'

/**
 * Name -> how to call it. Anything requiring an argument gets a harmless one;
 * we are testing the shape of the response, not the behaviour.
 */
const SURFACE = [
  ['version', (h) => h.version],
  ['ready', (h) => (h.ready instanceof Promise ? 'promise' : null)],
  ['playerKartId', (h) => h.playerKartId],
  ['glReport', (h) => h.glReport()],
  ['frameLumaStats', (h) => h.frameLumaStats()],
  ['beginSample', (h) => h.beginSample()],
  ['endSample', (h) => h.endSample()],
  ['pinScaler', (h) => h.pinScaler(true)],
  ['scalerPinned', (h) => h.scalerPinned()],
  ['stepTicks', (h) => 'callable-async'],
  ['resetRace', (h) => h.resetRace()],
  ['startRace', (h) => h.startRace()],
  ['setDriver', (h) => h.setDriver(0, 'referenceAI')],
  ['vantage', (h) => h.vantage('grid')],
  ['loadScenario', (h) => h.loadScenario('grid-idle')],
  ['setInput', (h) => h.setInput({ steer: 0 })],
  ['releaseInput', (h) => h.releaseInput()],
  ['injectInput', (h) => h.injectInput('keyboard', { steer: 1 }, 0)],
  ['seek', (h) => h.seek({ t: 0 })],
  ['telemetry', (h) => h.telemetry()],
  ['kartSnapshot', (h) => h.kartSnapshot(0)],
]

const MARKER = 'is not available yet'

const server = await startServer({ mode: 'preview' })
const browser = await launch({ timing: false })
let live = 0
let pending = 0
const violations = []

try {
  const { page } = await openGame(browser, server.url, { debug: 'frames', seed: 20260807 })

  const missing = await page.evaluate((names) => {
    const h = window.__harness
    if (!h) return ['__harness itself is absent']
    return names.filter((n) => !(n in h))
  }, SURFACE.map(([n]) => n))

  for (const name of missing) violations.push(`${name}: declared by the contract, absent at runtime`)

  for (const [name, call] of SURFACE) {
    const outcome = await page.evaluate(
      async ({ n, src }) => {
        const h = window.__harness
        try {
          // eslint-disable-next-line no-new-func
          const fn = new Function('h', `return (${src})(h)`)
          const value = await fn(h)
          return { kind: 'value', type: typeof value, isNull: value === null || value === undefined }
        } catch (err) {
          return { kind: 'throw', message: String(err && err.message ? err.message : err) }
        }
      },
      { n: name, src: call.toString() },
    )

    if (outcome.kind === 'throw') {
      if (outcome.message.includes(MARKER)) {
        pending++
        console.log(`PEND  ${name}`)
      } else {
        violations.push(`${name}: threw something other than the pending marker — ${outcome.message}`)
        console.log(`FAIL  ${name}  ${outcome.message.slice(0, 90)}`)
      }
    } else {
      live++
      console.log(`LIVE  ${name.padEnd(16)} -> ${outcome.isNull ? 'undefined/null' : outcome.type}`)
    }
  }

  const total = live + pending
  console.log('')
  console.log(`coverage   ${live}/${total} live, ${pending} pending`)

  if (violations.length) {
    console.error('')
    for (const v of violations) console.error(`VIOLATION  ${v}`)
    console.error(
      '\nA harness method that returns a value it cannot know makes every gate below it pass.\n' +
        'Throw the pending marker instead.',
    )
    process.exitCode = 1
  } else {
    console.log('PASS — every declared method either works or refuses honestly.')
  }
} finally {
  await browser.close()
  await server.stop()
}
