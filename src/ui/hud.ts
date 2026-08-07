import type {
  Ctx,
  DriftTier,
  GameServices,
  IKart,
  ItemKind,
  PlainFactory,
  Seconds,
  Standing,
  Subsystem,
} from '../types'

import { CSS, ROOT_ELEMENT_ID, STYLE_ELEMENT_ID, TIER_COLOR, TIER3_CORONA, BONE } from './theme'
import {
  button,
  canvas,
  cssColor,
  div,
  ordinalSuffix,
  pad2,
  setClass,
  setText,
  smallInt,
  span,
  splitClock,
  type TimerFields,
} from './dom'
import { createMinimap } from './minimap'
import { createSpeedo } from './speedo'
import { createTouchControls } from './touch'

/**
 * THE HUD, THE START SCREEN AND THE RESULTS SCREEN — ART_DIRECTION §8.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SUBSYSTEM EXISTS AT ALL
 *
 * Before it, `IRace.start()` had exactly one caller: `HarnessAPI.startRace()`.
 * A person who opened the page got a circuit, eight karts and a race that stayed
 * in `phase: 'idle'` forever, and nothing on screen said why. Everything below
 * is downstream of one requirement — that a human being can start and finish a
 * race — and the rest of §8 is what makes the race legible once they have.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS ALLOWED TO TOUCH
 *
 * `Ctx` at build, `GameServices` at link, the `EventBus`, and `src/types.ts`.
 * No sibling imports: `ui/` cannot reach `core/`, `game/`, `kart/` or `world/`
 * directly, and does not. Every number on screen is read back out of
 * `GameServices` — the standings from `IRace`, the speed from `IKart.state`, the
 * circuit shape from `ITrack`, the held item from `IItems`, the live input frame
 * from `IInput` — which means the HUD cannot disagree with the simulation about
 * anything, because it has no state of its own to disagree with.
 *
 * ---------------------------------------------------------------------------
 * THE FRAME BUDGET
 *
 * `lateUpdate` may allocate "sparingly — HUD string formatting is allowed once
 * per changed value, not once per frame". Every readout below caches its last
 * value and writes only on change, and the two that genuinely change every frame
 * — the timer's hundredths and the steering indicator — are served from interned
 * lookup tables so that "on change" still costs no allocation. See `dom.ts`.
 *
 * The two canvases redraw on the same rule: the speedometer when its needle has
 * moved more than a third of a degree, the minimap every frame because eight
 * dots genuinely do move every frame (one `drawImage` plus eight arcs — the
 * road underneath is rasterised once and never again).
 */

/** §1: the circuit's name, and the one string in this file that is not data. */
const CIRCUIT_NAME = 'Vermilion Nine'

/** m/s to km/h. The contract makes the HUD the ONLY place this conversion happens. */
const MS_TO_KMH = 3.6

/**
 * Item roulette, §8: "roulette spin and settle bounce". Driven off the sim clock
 * rather than `setInterval` so it cannot desynchronise from a paused or
 * step-driven game, and so nothing here reads a wall clock.
 */
const ROULETTE_SECONDS = 0.62
const ROULETTE_STEP_SECONDS = 0.055
/** §4b: "Item pickup — `#00ffa3` → `#b24bff` roulette. HUD only." */
const ROULETTE_COLORS: readonly string[] = [TIER_COLOR[1], TIER_COLOR[2]]

const ITEM_LABEL: Readonly<Record<ItemKind, string>> = {
  none: '',
  boost: 'boost',
  projectile: 'shot',
  mine: 'mine',
  shield: 'shield',
}
/** Fixed cycle order for the roulette. Deterministic — §DETERMINISM forbids RNG here. */
const ITEM_CYCLE: readonly ItemKind[] = ['boost', 'projectile', 'mine', 'shield']

/*
 * Hint strings are constants, not template literals built per frame. The screen
 * re-checks which control scheme is live on every frame it is visible — a player
 * can put a phone down and pick up a keyboard — and `setText` only writes on
 * change, so the comparison has to be against an existing string or the
 * allocation is back.
 */
const HINT_START_TOUCH = 'tap anywhere to start\ndrag left to steer · hold go to accelerate'
const HINT_START_KEYS = 'press enter or click start\narrows or wasd to steer · space to drift'
const HINT_AGAIN_TOUCH = 'tap anywhere to race again'
const HINT_AGAIN_KEYS = 'press enter to race again'

type ScreenMode = 'hidden' | 'start' | 'results'

/**
 * `PlainFactory` — `(ctx: Ctx) => Subsystem`. The composition root constructs
 * this like every other `ui/`-shaped subsystem, registers it in the `lateUpdate`
 * order the contract fixes (`fx -> ui -> audio -> render`), and hands it
 * `GameServices` at `link`. It deliberately takes nothing else: at construction
 * time there is no race to start and no track to trace, and a factory that asked
 * for them would force the root to build `ui/` out of order.
 */
export const createHud: PlainFactory = (ctx: Ctx): Subsystem => {
  let services: GameServices | null = null
  let player: IKart | null = null
  let disposed = false

  const unsubscribe: Array<() => void> = []

  // --- DOM -----------------------------------------------------------------

  const style = document.createElement('style')
  style.id = STYLE_ELEMENT_ID
  style.textContent = CSS

  const root = document.createElement('div')
  root.id = ROOT_ELEMENT_ID

  const hud = div('v9-hud', root)

  // §8 top-left: lap, large numeral, flash on completion.
  const lapBox = div('v9-lap', hud)
  const lapLabel = div('v9-label', lapBox)
  lapLabel.textContent = 'lap'
  const lapValue = div('v9-lap-value', lapBox)
  const lapCurrent = span('', lapValue)
  const lapTotal = span('v9-lap-total', lapValue)

  // §8 top-right: race timer, tabular numerals, no width jitter.
  const timerBox = div('v9-timer', hud)
  const timerLabel = div('v9-label', timerBox)
  timerLabel.textContent = 'time'
  const timerValue = div('v9-timer-value', timerBox)
  const timerMin = span('', timerValue)
  const timerSecSep = span('', timerValue)
  timerSecSep.textContent = ':'
  const timerSec = span('', timerValue)
  const timerCsSep = span('v9-timer-cs', timerValue)
  timerCsSep.textContent = '.'
  const timerCs = span('v9-timer-cs', timerValue)

  // §8 left-centre: position, large, ordinal suffix, punch on change.
  const posBox = div('v9-pos', hud)
  const posValue = span('v9-pos-value', posBox)
  const posSuffix = span('v9-pos-suffix', posBox)

  // §8 bottom-right: speedometer.
  const speedoBox = div('v9-speedo', hud)
  const speedoCanvas = canvas(speedoBox)
  const speedoDigital = div('v9-speedo-digital', speedoBox)
  const speedoUnit = div('v9-speedo-unit', speedoBox)
  speedoUnit.textContent = 'km/h'
  const speedo = createSpeedo(speedoCanvas)

  // §8 bottom-centre: minimap.
  const mapBox = div('v9-map', hud)
  const mapCanvas = canvas(mapBox)
  const minimap = createMinimap(mapCanvas)

  // Drift ladder, §4b. Three pips, one per tier.
  const driftBox = div('v9-drift', hud)
  const driftPips: HTMLDivElement[] = [
    div('v9-drift-pip', driftBox),
    div('v9-drift-pip', driftBox),
    div('v9-drift-pip', driftBox),
  ]

  // §8 bottom-left: item box.
  const itemBox = div('v9-item', hud)
  const itemGlyph = div('v9-item-glyph', itemBox)

  // Touch pads, drawn over core/input.ts's zones. See `touch.ts`.
  const touch = createTouchControls(root)

  // §8 countdown, and the full-screen flash it fires on GO.
  const countdown = div('v9-count', root)
  const flash = div('v9-flash', root)
  const releaseGlow = div('v9-release', root)

  // Start / results card.
  const screen = div('v9-screen', root)
  /*
   * `data-ui-interactive` is core/input.ts's opt-out marker. Without it, a tap
   * anywhere on the start card would also be a tap inside a steering or throttle
   * zone, and the player would start the race with the throttle already held —
   * which is not a cosmetic problem, it is a kart that leaves the grid before
   * the countdown finishes on a device with no keyboard to let go of.
   */
  screen.setAttribute('data-ui-interactive', '')
  screen.hidden = true

  const screenTop = div('v9-screen-top', screen)
  const eyebrow = div('v9-eyebrow', screenTop)
  const title = div('v9-title', screenTop)
  div('v9-rule', screenTop)
  const subtitle = div('v9-subtitle', screenTop)

  const screenBottom = div('v9-screen-bottom', screen)
  const results = div('v9-results', screenBottom)
  results.hidden = true
  const primaryButton = button('v9-btn', 'Start', screenBottom)
  const hint = div('v9-hint', screenBottom)

  interface ResultRow {
    readonly row: HTMLDivElement
    readonly place: HTMLDivElement
    readonly chip: HTMLDivElement
    readonly name: HTMLDivElement
    readonly time: HTMLDivElement
    kartId: number
    /* The results table is live while the rest of the field finishes, so it is
     * repainted every frame the card is up. Without these it would build sixteen
     * short strings a frame to discover that fifteen of them are unchanged —
     * which is the "toFixed per frame per element" the contract names, wearing a
     * menu instead of a HUD. */
    shownPlace: number
    shownTimeKey: number
  }
  const resultRows: ResultRow[] = []

  // --- cached readout state ------------------------------------------------
  //
  // Every one of these exists so a value is formatted once when it changes,
  // never once per frame. The contract names this explicitly, and `fps-bench`
  // reports the alternative as long frames with no draw-call change to explain
  // them.

  const timerFields: TimerFields = { minutes: 0, seconds: 0, hundredths: 0 }
  let lastMinutes = -1
  let lastSeconds = -1
  let lastHundredths = -1
  let lastLapShown = -1
  let lastTotalLaps = -1
  let lastPlace = -1
  let lastSpeedInt = -1
  let lastItem: ItemKind | null = null
  let lastDriftTier: DriftTier = 0
  let lastAccent = BONE
  let lastSimTime = 0
  let screenMode: ScreenMode = 'hidden'
  let lastTouchVisible = false
  let revealed = false

  /** Set on a banked drift release so the boost that follows wears its colour (§4b). */
  let boostAccent = BONE

  /** Item roulette state, in seconds of sim time. */
  let rouletteLeft = 0
  let rouletteCell = 0

  /**
   * A phone or a touch laptop should see the controls BEFORE the first touch,
   * not after. `IInput.kind` cannot answer that — it starts at `'keyboard'` and
   * only becomes `'touch'` once a finger has already landed somewhere, which is
   * the wrong way round for a control the player is supposed to discover.
   * `(pointer: coarse)` describes the PRIMARY pointer, so a mouse user with a
   * touchscreen attached still gets a clean frame.
   */
  const coarsePointer =
    typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)').matches : false

  // --- helpers -------------------------------------------------------------

  function standingFor(kartId: number): Standing | null {
    if (!services) return null
    const list = services.race.standings
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!
      if (s.kartId === kartId) return s
    }
    return null
  }

  function totalTime(lapTimes: readonly Seconds[]): Seconds {
    let sum = 0
    for (let i = 0; i < lapTimes.length; i++) sum += lapTimes[i]!
    return sum
  }

  /** Motion budget. §Settings carries `reducedMotion`; the HUD is where it is cheapest to honour. */
  function motion(): number {
    return ctx.settings.reducedMotion ? 0.25 : 1
  }

  function punch(node: Element, scale: number, duration: number): void {
    const s = 1 + (scale - 1) * motion()
    node.animate(
      [{ transform: `scale(${s})` }, { transform: 'scale(1)' }],
      { duration: duration * (0.4 + 0.6 * motion()), easing: 'cubic-bezier(.2,.9,.3,1)' },
    )
  }

  // --- the race controls ---------------------------------------------------

  /**
   * The one place `ui/` reaches into `IRace`, and the whole point of the round.
   *
   * It is written as a single guarded function rather than two handlers because
   * three different gestures can trigger it — the button, Enter, and a tap
   * anywhere on the card — and on a touch device the button produces both a
   * `pointerdown` on the card and a `click` on itself. A restart is
   * `reset()` + `start()`, which is emphatically NOT idempotent: running it
   * twice would reset a race that had already started counting down.
   *
   * The guard is structural rather than a latch. After the first call the race
   * is no longer `idle` and no standing is `finished`, so the second call falls
   * through both branches and does nothing. A time-based debounce would have to
   * pick a duration, and it would be wrong on a slow phone.
   */
  function activate(): void {
    if (!services || disposed) return
    const race = services.race
    if (race.phase === 'idle') {
      race.start()
      return
    }
    const playerStanding = standingFor(services.playerKartId)
    if (race.phase === 'finished' || playerStanding?.finished === true) {
      // Contract: `reset()` is synchronous and returns every kart to the grid
      // with all progress cleared, which is exactly the precondition `start()`
      // asserts (it refuses unless the phase is `idle`).
      race.reset()
      race.start()
    }
  }

  function onScreenPointerDown(e: PointerEvent): void {
    // The button raises its own `click`; letting the card handle it as well
    // would call `activate` twice for one press.
    if (e.target === primaryButton) return
    activate()
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (screen.hidden) return
    // OS auto-repeat, not a new intent.
    if (e.repeat) return
    if (e.code !== 'Enter' && e.code !== 'NumpadEnter' && e.code !== 'Space') return
    activate()
  }

  // --- events --------------------------------------------------------------

  function showCountdown(n: 3 | 2 | 1 | 0): void {
    const isGo = n === 0
    setText(countdown, isGo ? 'GO!' : smallInt(n))
    countdown.style.color = TIER_COLOR[0]

    const m = motion()
    countdown.animate(
      [
        { opacity: 0, transform: `scale(${1 + 0.7 * m})` },
        { opacity: 1, transform: 'scale(1)', offset: 0.32 },
        { opacity: isGo ? 1 : 0.95, transform: `scale(${1 + 0.06 * m})`, offset: 0.7 },
        { opacity: 0, transform: `scale(${1 + (isGo ? 0.5 : 0.22) * m})` },
      ],
      { duration: isGo ? 780 : 900, easing: 'cubic-bezier(.15,.8,.25,1)' },
    )

    if (!isGo) return
    // §8: full-screen flash on GO. Short and warm — `#f7f1e4`, the HUD ink,
    // rather than pure white, because §3 forbids shipping `#ffffff` and a white
    // flash over a warm desert reads as a blown frame even at 180 ms.
    flash.animate(
      [{ opacity: 0.85 }, { opacity: 0 }],
      { duration: 260 * (0.4 + 0.6 * m), easing: 'ease-out' },
    )
  }

  function showDriftTier(tier: 1 | 2 | 3): void {
    applyDriftTier(tier)
    punch(driftBox, 1.35, 260)
  }

  function applyDriftTier(tier: DriftTier): void {
    if (tier === lastDriftTier) return
    lastDriftTier = tier
    setClass(driftBox, 'v9-on', tier > 0)
    for (let i = 0; i < driftPips.length; i++) {
      const pip = driftPips[i]!
      const lit = i < tier
      pip.style.background = lit ? TIER_COLOR[tier] : 'rgba(42, 35, 32, 0.55)'
      /*
       * §4b tier 3 is a near-white core with a `#ff2fd0` corona, and §4c calls
       * that corona the band's weakest link — 62° from the iron-oxide band and
       * the closest approach in the table. It is never softened into a plain
       * fill: the core stays near-white and the corona is a separate, saturated
       * ring, which is what keeps it from being read as "the dust looks a bit
       * purple".
       */
      pip.style.boxShadow =
        lit && tier === 3
          ? `inset 0 0 0 1px rgba(42, 35, 32, 0.85), 0 0 0.8vmin ${TIER3_CORONA}, 0 0 2vmin ${TIER3_CORONA}`
          : 'inset 0 0 0 1px rgba(42, 35, 32, 0.85)'
    }
  }

  function showDriftRelease(tier: DriftTier): void {
    applyDriftTier(0)
    if (tier === 0) return
    boostAccent = TIER_COLOR[tier]
    const corona = tier === 3 ? TIER3_CORONA : TIER_COLOR[tier]
    releaseGlow.style.background = `linear-gradient(to top, ${corona}, transparent)`
    const peak = (tier === 3 ? 0.34 : tier === 2 ? 0.26 : 0.2) * (0.5 + 0.5 * motion())
    releaseGlow.animate(
      [{ opacity: 0 }, { opacity: peak, offset: 0.18 }, { opacity: 0 }],
      { duration: 420, easing: 'ease-out' },
    )
  }

  function subscribe(): void {
    const on = ctx.events.on.bind(ctx.events)
    const isPlayer = (kartId: number): boolean => services !== null && kartId === services.playerKartId

    unsubscribe.push(
      on('race:countdown', (p) => showCountdown(p.n)),
      on('lap:complete', (p) => {
        if (!isPlayer(p.kartId)) return
        // §8: "flash on completion".
        punch(lapBox, 1.3, 420)
        lapBox.animate(
          [{ opacity: 1 }, { opacity: 0.25, offset: 0.25 }, { opacity: 1 }],
          { duration: 420 },
        )
      }),
      on('drift:tier', (p) => {
        if (isPlayer(p.kartId)) showDriftTier(p.tier)
      }),
      on('drift:release', (p) => {
        if (isPlayer(p.kartId)) showDriftRelease(p.tier)
      }),
      on('item:pickup', (p) => {
        if (!isPlayer(p.kartId)) return
        rouletteLeft = ROULETTE_SECONDS
        rouletteCell = 0
      }),
      on('item:use', (p) => {
        if (!isPlayer(p.kartId)) return
        touch.flashItem()
        punch(itemBox, 1.2, 220)
      }),
    )
  }

  // --- per-frame readouts --------------------------------------------------

  function updateTimer(clock: Seconds): void {
    splitClock(clock, timerFields)
    if (timerFields.minutes !== lastMinutes) {
      lastMinutes = timerFields.minutes
      setText(timerMin, smallInt(timerFields.minutes))
    }
    if (timerFields.seconds !== lastSeconds) {
      lastSeconds = timerFields.seconds
      setText(timerSec, pad2(timerFields.seconds))
    }
    if (timerFields.hundredths !== lastHundredths) {
      lastHundredths = timerFields.hundredths
      setText(timerCs, pad2(timerFields.hundredths))
    }
  }

  function updateLap(standing: Standing | null, totalLaps: number): void {
    if (totalLaps !== lastTotalLaps) {
      lastTotalLaps = totalLaps
      setText(lapTotal, `/${smallInt(totalLaps)}`)
    }
    // Contract: "Laps fully completed. The grid shows 0; the HUD displays
    // `completed + 1`." Clamped, so a kart that has crossed the line for the
    // last time reads 3/3 rather than 4/3.
    const completed = standing ? standing.completedLaps : 0
    const shown = Math.min(totalLaps, completed + 1)
    if (shown !== lastLapShown) {
      lastLapShown = shown
      setText(lapCurrent, smallInt(shown))
    }
  }

  function updatePosition(standing: Standing | null): void {
    const place = standing ? standing.place : 1
    if (place === lastPlace) return
    lastPlace = place
    setText(posValue, smallInt(place))
    setText(posSuffix, ordinalSuffix(place))
    // §8: "punch on change".
    punch(posBox, 1.28, 320)
  }

  function updateSpeedo(kart: IKart, dt: number): void {
    const kmh = Math.abs(kart.state.speed) * MS_TO_KMH
    const shownInt = Math.round(kmh)
    if (shownInt !== lastSpeedInt) {
      lastSpeedInt = shownInt
      setText(speedoDigital, smallInt(shownInt))
    }

    const drift = kart.state.drift
    const boost = kart.state.boost
    const accent = drift.tier > 0 ? TIER_COLOR[drift.tier] : boost.active ? boostAccent : BONE
    if (accent !== lastAccent) {
      lastAccent = accent
      speedoDigital.style.color = accent === BONE ? '' : accent
    }
    if (!boost.active && boostAccent !== BONE) boostAccent = BONE

    speedo.update(kmh, dt, accent)
  }

  function updateItem(kind: ItemKind, dt: number): void {
    if (rouletteLeft > 0) {
      rouletteLeft -= dt
      const cell = Math.floor((ROULETTE_SECONDS - rouletteLeft) / ROULETTE_STEP_SECONDS)
      if (cell !== rouletteCell) {
        rouletteCell = cell
        const face = ITEM_CYCLE[cell % ITEM_CYCLE.length]!
        setText(itemGlyph, ITEM_LABEL[face])
        itemGlyph.style.color = ROULETTE_COLORS[cell % ROULETTE_COLORS.length]!
      }
      setClass(itemBox, 'v9-on', true)
      if (rouletteLeft > 0) return
      // Settle bounce, §8.
      lastItem = null
      punch(itemBox, 1.22, 300)
    }

    if (kind === lastItem) return
    lastItem = kind
    setText(itemGlyph, ITEM_LABEL[kind])
    itemGlyph.style.color = ''
    setClass(itemBox, 'v9-on', kind !== 'none')
  }

  // --- screens -------------------------------------------------------------

  function ensureResultRows(svc: GameServices): void {
    if (resultRows.length === svc.identities.length) return
    for (const existing of resultRows) existing.row.remove()
    resultRows.length = 0
    for (let i = 0; i < svc.identities.length; i++) {
      const row = div('v9-row', results)
      const place = div('v9-row-place', row)
      const name = div('v9-row-name', row)
      const chip = div('v9-chip', name)
      const nameText = div('', name)
      const time = div('v9-row-time', row)
      resultRows.push({
        row,
        place,
        chip,
        name: nameText,
        time,
        kartId: -1,
        shownPlace: -1,
        shownTimeKey: NaN,
      })
    }
  }

  function updateResults(svc: GameServices): void {
    ensureResultRows(svc)
    const list = svc.race.standings
    for (let i = 0; i < resultRows.length; i++) {
      const row = resultRows[i]!
      const standing = list[i]
      if (!standing) {
        row.row.hidden = true
        continue
      }
      row.row.hidden = false

      if (row.kartId !== standing.kartId) {
        row.kartId = standing.kartId
        const identity = svc.identities.find((id) => id.id === standing.kartId)
        setText(row.name, identity ? identity.displayName : `Kart ${standing.kartId}`)
        row.chip.style.background = identity ? cssColor(identity.primaryColor) : BONE
        setClass(row.row, 'v9-player', standing.kartId === svc.playerKartId)
      }

      if (row.shownPlace !== standing.place) {
        row.shownPlace = standing.place
        setText(row.place, `${smallInt(standing.place)}${ordinalSuffix(standing.place)}`)
      }

      /*
       * One number that stands for the whole time column. A finished kart's key
       * is its elapsed hundredths (which stops changing the moment it finishes);
       * an unfinished one's is the negated lap it is on. The two ranges cannot
       * collide, so a single comparison covers both branches.
       */
      const elapsed = standing.finished ? totalTime(standing.lapTimes) : 0
      const lap = Math.min(svc.race.totalLaps, standing.completedLaps + 1)
      const timeKey = standing.finished ? Math.round(elapsed * 100) : -lap
      if (row.shownTimeKey !== timeKey) {
        row.shownTimeKey = timeKey
        if (standing.finished) {
          // The seconds go in, not the key — `key / 100` would re-introduce a
          // float that `splitClock` then truncates one hundredth low.
          splitClock(elapsed, timerFields)
          setText(
            row.time,
            `${smallInt(timerFields.minutes)}:${pad2(timerFields.seconds)}.${pad2(timerFields.hundredths)}`,
          )
        } else {
          setText(row.time, `lap ${smallInt(lap)}`)
        }
      }
    }
  }

  function setScreenMode(mode: ScreenMode, svc: GameServices, touchScheme: boolean): void {
    const changed = mode !== screenMode
    screenMode = mode

    if (mode === 'hidden') {
      if (!changed) return
      screen.hidden = true
      // A button that keeps focus after its card is gone still answers Space and
      // Enter, and Space is the drift key. Hand focus back to the document.
      primaryButton.blur()
      return
    }

    if (changed) {
      screen.hidden = false
      punch(screen, 1.02, 320)
      // A target the Enter key already reaches, and a visible ring on the first
      // Tab. `preventScroll` because focusing inside a `touch-action: none`
      // viewport must not nudge the layout under the renderer.
      primaryButton.focus({ preventScroll: true })
    }

    if (mode === 'start') {
      if (changed) {
        results.hidden = true
        setText(eyebrow, 'circuit')
        setText(title, CIRCUIT_NAME)
        setText(subtitle, `${smallInt(svc.race.totalLaps)} laps · desert canyon`)
        setText(primaryButton, 'Start')
      }
      setText(hint, touchScheme ? HINT_START_TOUCH : HINT_START_KEYS)
      return
    }

    if (changed) {
      results.hidden = false
      const standing = standingFor(svc.playerKartId)
      const place = standing ? standing.place : 1
      setText(eyebrow, 'result')
      setText(title, `${smallInt(place)}${ordinalSuffix(place)}`)
      setText(subtitle, CIRCUIT_NAME)
      setText(primaryButton, 'Race again')
    }
    setText(hint, touchScheme ? HINT_AGAIN_TOUCH : HINT_AGAIN_KEYS)
    // Standings keep moving after the player crosses the line — the rest of the
    // field is still racing — so the table is live, not a snapshot.
    updateResults(svc)
  }

  // --- lifecycle -----------------------------------------------------------

  function build(): void {
    document.head.appendChild(style)
    document.body.appendChild(root)
    screen.addEventListener('pointerdown', onScreenPointerDown)
    primaryButton.addEventListener('click', activate)
    window.addEventListener('keydown', onKeyDown)
  }

  function link(svc: GameServices): void {
    services = svc
    player = svc.kartById(svc.playerKartId)
    minimap.buildPath(svc.track)
    lastSimTime = ctx.clock.simTime
    subscribe()
  }

  function lateUpdate(): void {
    if (disposed) return
    const svc = services
    if (!svc) return

    /*
     * The frame delta comes from `Clock.simTime`, not from the `dt` argument and
     * not from a wall clock.
     *
     * `main.ts` currently hands `lateUpdate` a constant `SIMULATION_STEP`, so
     * the argument is not a frame delta at all — a spring integrated against it
     * would run at half speed on a 60 Hz display and at full speed on a 120 Hz
     * one, which is exactly the machine-dependence the fixed-step rule exists to
     * remove. `simTime` advances by the whole catch-up the loop just ran, so it
     * is the real elapsed simulation time for this frame, it is zero when the
     * clock is paused, and it is identical between two runs of `stepTicks`.
     */
    const now = ctx.clock.simTime
    let dt = now - lastSimTime
    if (dt < 0) dt = 0 // a world rebuild rewinds the clock; do not integrate that
    lastSimTime = now

    // Revealed on the first frame that presents, matching `#boot`'s own fade.
    // Built any earlier and the HUD paints over the loading overlay.
    if (!revealed) {
      revealed = true
      root.classList.add('v9-visible')
    }

    const race = svc.race
    const phase = race.phase
    const playerStanding = standingFor(svc.playerKartId)

    /*
     * Screen state is POLLED from `IRace.phase`, not tracked from events.
     *
     * `HarnessAPI.resetRace()` calls `race.reset()` directly and emits nothing,
     * and `startRace()` goes straight to `race.start()`. A UI that only listened
     * would show a results card over a world the harness had already put back on
     * the grid, and every subsequent screenshot would be taken through it.
     * Polling makes the UI a function of race state and therefore incapable of
     * disagreeing with it.
     */
    const mode: ScreenMode =
      phase === 'idle'
        ? 'start'
        : phase === 'finished' || playerStanding?.finished === true
          ? 'results'
          : 'hidden'

    // The racing HUD is for racing. Behind the title card it would be three
    // zeroes; behind the results table it would be a second, worse copy of it.
    const showHud = mode === 'hidden'
    if (hud.hidden === showHud) hud.hidden = !showHud

    // Touch pads follow the live input device, so a player who picks up a
    // keyboard mid-race stops looking at controls they are not using.
    const wantTouch = svc.input.kind === 'touch' || coarsePointer
    const showTouch = wantTouch && showHud
    if (showTouch !== lastTouchVisible) {
      lastTouchVisible = showTouch
      touch.element.hidden = !showTouch
      setClass(root, 'v9-touch-mode', showTouch)
    }
    if (showTouch) touch.refresh(svc)

    if (showHud) {
      updateTimer(race.clock)
      updateLap(playerStanding, race.totalLaps)
      updatePosition(playerStanding)
      if (player) {
        updateSpeedo(player, dt)
        // The steady-state tier comes from `KartState`; the events above supply
        // the discrete moments (the tier-up punch, the release wash) that a
        // polled value cannot express because it never shows the transition.
        applyDriftTier(player.state.drift.active ? player.state.drift.tier : 0)
      }
      updateItem(svc.items.held(svc.playerKartId), dt)
      minimap.draw(svc)
    }

    setScreenMode(mode, svc, wantTouch)
  }

  function dispose(): void {
    if (disposed) return
    disposed = true

    for (let i = 0; i < unsubscribe.length; i++) unsubscribe[i]!()
    unsubscribe.length = 0

    screen.removeEventListener('pointerdown', onScreenPointerDown)
    primaryButton.removeEventListener('click', activate)
    window.removeEventListener('keydown', onKeyDown)

    // Running animations hold their target elements alive and keep firing
    // `finish` handlers into a torn-down world. The harness builds and tears
    // down repeatedly; one surviving animation is a leak per run.
    for (const anim of root.getAnimations({ subtree: true })) anim.cancel()

    touch.dispose()
    minimap.dispose()
    speedo.dispose()

    resultRows.length = 0
    root.remove()
    style.remove()
    services = null
    player = null
  }

  return {
    name: 'ui/hud',
    build,
    link,
    lateUpdate,
    dispose,
  }
}
