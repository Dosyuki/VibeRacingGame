import type { GameServices } from '../types'
import { div, setClass } from './dom'

/**
 * TOUCH CONTROLS — pictures of zones this file does not own.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE NUMBERS ARE DUPLICATED INSTEAD OF IMPORTED, AND WHY THAT IS THE
 * CORRECT CALL RATHER THAN A SHORTCUT
 *
 * `src/core/input.ts` exports `TOUCH_LAYOUT` and says, in its own comment, that
 * it is "exported so `src/ui/` can draw the controls over the geometry that
 * actually receives the pointers. It cannot import this — sibling imports are
 * banned and `ui/` is a sibling of `core/` — which is a real gap in the
 * contract, written up rather than worked around."
 *
 * That rule applies to this file in full. `ui/` and `core/` are siblings;
 * CLAUDE.md's table lists exactly three legal channels and none of them carries
 * a layout constant. `GameServices` exposes `IInput`, and `IInput` exposes
 * `kind`, `frame`, `lastEventAtMs`, `sample` and `dispose` — no geometry. So
 * there is no reachable route to those five rectangles, and the choice is
 * between duplicating them and shipping no touch controls at all.
 *
 * Duplicating them is right, and the reason is that the alternative is worse in
 * a specific, measurable way: a control drawn somewhere other than where it is
 * hit-tested is invisible to every harness — the pointer still lands in the real
 * zone and the kart still responds — and instantly obvious to every player,
 * who presses the picture and gets nothing. Shipping no controls at all fails
 * §10c criterion 8 outright.
 *
 * The duplication is therefore a KNOWN, DECLARED coupling rather than a hidden
 * one. If `TOUCH_LAYOUT` in `core/input.ts` changes and this table does not, the
 * controls silently move off their hit boxes. The real fix is for the contract
 * to carry the layout — a `readonly touchLayout` on `IInput` would do it in one
 * line — and that is a contract change, which is its own announced commit, not
 * a side effect of building a HUD.
 *
 * Copied verbatim from `src/core/input.ts` at Round 5. `[x0, y0, x1, y1]`,
 * normalised to the viewport, origin top-left.
 */
const TOUCH_ZONES = {
  steer: [0.0, 0.22, 0.45, 1.0],
  throttle: [0.8, 0.55, 1.0, 1.0],
  brake: [0.6, 0.78, 0.8, 1.0],
  drift: [0.6, 0.55, 0.8, 0.78],
  item: [0.6, 0.33, 1.0, 0.55],
} as const satisfies Record<string, readonly [number, number, number, number]>

/**
 * Steering-knob positions are quantised to this many steps either side of
 * centre so the transform string can be looked up instead of built. The knob
 * travels roughly 60 px on a phone, so 96 steps is well under a pixel each.
 */
const STEER_STEPS = 96
/** Fraction of the indicator track's half-width the knob is allowed to travel. */
const STEER_TRAVEL = 0.4

export interface TouchControls {
  /** The HUD owns visibility — it also has to shift §8's corners out of the pads. */
  readonly element: HTMLDivElement
  refresh(services: GameServices): void
  flashItem(): void
  dispose(): void
}

export function createTouchControls(parent: Element): TouchControls {
  const root = div('v9-touch', parent)
  root.hidden = true

  function zone(name: keyof typeof TOUCH_ZONES, className: string): HTMLDivElement {
    const node = div(`v9-zone ${className}`, root)
    /*
     * Tagged so the geometry is assertable from outside. The whole risk of this
     * file is that the drawing and the hit-testing silently disagree, and the
     * only cheap way to catch that is a harness that reads these rectangles back
     * off the laid-out page and compares them with `TOUCH_LAYOUT`. Without a
     * hook there is nothing to read.
     */
    node.dataset.zone = name
    const r = TOUCH_ZONES[name]
    node.style.left = `${r[0] * 100}%`
    node.style.top = `${r[1] * 100}%`
    node.style.width = `${(r[2] - r[0]) * 100}%`
    node.style.height = `${(r[3] - r[1]) * 100}%`
    return node
  }

  const steerZone = zone('steer', 'v9-steer')
  const steerHint = div('v9-label v9-steer-hint', steerZone)
  steerHint.textContent = 'drag to steer'
  const steerTrack = div('v9-steer-track', steerZone)
  const steerKnob = div('v9-steer-knob', steerTrack)

  function pad(name: keyof typeof TOUCH_ZONES, label: string): HTMLDivElement {
    const node = zone(name, 'v9-pad')
    const text = div('v9-pad-label', node)
    text.textContent = label
    return node
  }

  const throttlePad = pad('throttle', 'go')
  const brakePad = pad('brake', 'brake')
  const driftPad = pad('drift', 'drift')
  const itemPad = pad('item', 'item')

  /**
   * Pre-built transform strings, one per quantised knob position. Rebuilt when
   * the indicator track's pixel width changes and never otherwise, so steering
   * — the one control a player holds for whole corners — allocates nothing per
   * frame.
   */
  let transforms: string[] = []
  let transformsForWidth = -1
  let lastSteerIndex = -1

  function rebuildTransforms(halfTravelPx: number): void {
    const next: string[] = new Array<string>(STEER_STEPS * 2 + 1)
    for (let i = 0; i <= STEER_STEPS * 2; i++) {
      const offset = ((i - STEER_STEPS) / STEER_STEPS) * halfTravelPx
      next[i] = `translate(${offset.toFixed(1)}px, -50%)`
    }
    transforms = next
    lastSteerIndex = -1
  }

  /**
   * The pads mirror what `IInput` is actually reporting, not what the HUD thinks
   * the player pressed.
   *
   * This is deliberate and it is the only honest wiring available: `ui/` does
   * not receive the pointer events — `core/input.ts` does, on `window`, in the
   * capture phase — so a pad that lit on its own it would be lying about a
   * control it has no part in. Reading `input.frame` back means a pad lights
   * exactly when the kart is actually being told to accelerate, which makes a
   * mis-registered zone visible on screen instead of merely unresponsive.
   */
  function refresh(services: GameServices): void {
    if (root.hidden) return
    const frame = services.input.frame

    setClass(throttlePad, 'v9-on', frame.throttle > 0.01)
    setClass(brakePad, 'v9-on', frame.brake > 0.01)
    setClass(driftPad, 'v9-on', frame.drift)

    const width = steerTrack.clientWidth
    if (width > 0 && width !== transformsForWidth) {
      transformsForWidth = width
      rebuildTransforms(width * STEER_TRAVEL)
    }
    if (transforms.length === 0) return

    const steer = frame.steer < -1 ? -1 : frame.steer > 1 ? 1 : frame.steer
    const index = STEER_STEPS + Math.round(steer * STEER_STEPS)
    if (index !== lastSteerIndex) {
      lastSteerIndex = index
      steerKnob.style.transform = transforms[index]!
    }
  }

  /**
   * The item pad is the one control with no held state to read back — `useItem`
   * is a one-tick pulse the contract says only `game/` consumes, and `ui/` never
   * sees the tick it lands on. So the acknowledgement is driven from the
   * `item:use` event instead, and it has to clear itself.
   */
  function flashItem(): void {
    itemPad.classList.add('v9-on')
    const anim = itemPad.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.07)' }, { transform: 'scale(1)' }],
      { duration: 240, easing: 'ease-out' },
    )
    anim.addEventListener('finish', () => itemPad.classList.remove('v9-on'))
  }

  function dispose(): void {
    for (const anim of root.getAnimations({ subtree: true })) anim.cancel()
    root.remove()
    transforms = []
  }

  return { element: root, refresh, flashItem, dispose }
}
