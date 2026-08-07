/**
 * DOM and formatting plumbing for `src/ui/`.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE ARE STRING TABLES IN HERE
 *
 * The contract's ALLOCATION section allows `lateUpdate` to allocate "sparingly —
 * HUD string formatting is allowed once per changed value, not once per frame".
 * Most of the HUD honours that trivially: the lap counter changes three times a
 * race, the position readout a handful of times.
 *
 * The race timer does not. At a hundredth-second resolution its value genuinely
 * changes every frame, so "once per changed value" and "once per frame" are the
 * same thing, and `toFixed(2)` per frame is a fresh string every frame forever —
 * which is precisely the continuous garbage that shows up in `fps-bench` as
 * long frames with no draw-call change to explain them.
 *
 * The way out is that the timer only ever displays integers in [0, 99]. There
 * are a hundred of them. Interning all hundred once, at module load, turns the
 * per-frame cost into an array index and a property write of an already-existing
 * string — zero allocation, forever, no matter how long the race runs.
 *
 * Module scope is correct for these specifically because they are CONSTANT
 * DATA, not per-world state. The rule against module-scope state (see
 * `core/input.ts`) exists because state shared between an outgoing world and its
 * replacement presents as a bug in the next run; a frozen lookup table cannot do
 * that.
 */

/** `"00"` … `"99"`. Zero-padded, for the seconds and hundredths fields. */
const PAD2: readonly string[] = (() => {
  const out: string[] = new Array<string>(100)
  for (let i = 0; i < 100; i++) out[i] = i < 10 ? `0${i}` : `${i}`
  return out
})()

/** `"0"` … `"999"`. Covers minutes, km/h and lap counts without formatting. */
const SMALL_INT: readonly string[] = (() => {
  const out: string[] = new Array<string>(1000)
  for (let i = 0; i < 1000; i++) out[i] = String(i)
  return out
})()

export function pad2(v: number): string {
  return PAD2[v < 0 ? 0 : v > 99 ? 99 : v]!
}

export function smallInt(v: number): string {
  return SMALL_INT[v < 0 ? 0 : v > 999 ? 999 : v]!
}

/**
 * Ordinal suffix for the §8 position readout.
 *
 * Written for the general case even though this game fields eight karts: the
 * field size is `GameServices.karts.length` and nothing in the contract caps it,
 * so a table of eight would be a silent wrong answer the first time somebody
 * grids twelve.
 */
export function ordinalSuffix(n: number): string {
  const hundreds = n % 100
  if (hundreds >= 11 && hundreds <= 13) return 'th'
  switch (n % 10) {
    case 1:
      return 'st'
    case 2:
      return 'nd'
    case 3:
      return 'rd'
    default:
      return 'th'
  }
}

/**
 * `M:SS.hh` as three separately-assignable fields.
 *
 * Split into fields rather than one string because only the hundredths field
 * changes on most frames, and assigning an unchanged `textContent` still costs a
 * style invalidation on the element.
 */
export interface TimerFields {
  minutes: number
  seconds: number
  hundredths: number
}

/** Writes into `out`; allocates nothing. Negative clocks (countdown) read zero. */
export function splitClock(seconds: number, out: TimerFields): TimerFields {
  // Truncate, never round: a timer that displays 1:00.00 while the clock says
  // 59.996 has reported a lap time that did not happen.
  const total = seconds > 0 ? Math.floor(seconds * 100) : 0
  out.hundredths = total % 100
  out.seconds = Math.floor(total / 100) % 60
  // Clamp rather than widen the field. A race that runs past 99 minutes is a
  // stuck kart, and a HUD that silently reflows to accommodate it hides that.
  const minutes = Math.floor(total / 6000)
  out.minutes = minutes > 99 ? 99 : minutes
  return out
}

/** `0xRRGGBB` (the contract's colour encoding) to a CSS hex string. */
export function cssColor(hex: number): string {
  return `#${(hex & 0xffffff).toString(16).padStart(6, '0')}`
}

// ---------------------------------------------------------------------------

export function div(className: string, parent?: Element): HTMLDivElement {
  const node = document.createElement('div')
  node.className = className
  if (parent) parent.appendChild(node)
  return node
}

export function span(className: string, parent?: Element): HTMLSpanElement {
  const node = document.createElement('span')
  node.className = className
  if (parent) parent.appendChild(node)
  return node
}

export function canvas(parent?: Element): HTMLCanvasElement {
  const node = document.createElement('canvas')
  if (parent) parent.appendChild(node)
  return node
}

/**
 * A `<button>`, and it matters that it is one.
 *
 * `core/input.ts` decides whether a pointer belongs to the game or to the UI
 * with `target.closest('button, a, input, select, textarea, [data-ui-interactive]')`.
 * A `<div role="button">` would look identical, behave identically to a mouse,
 * and floor the throttle every time somebody pressed it on a phone — the press
 * lands in the bottom-right, which is the throttle zone.
 */
export function button(className: string, label: string, parent?: Element): HTMLButtonElement {
  const node = document.createElement('button')
  node.className = className
  node.type = 'button'
  node.textContent = label
  if (parent) parent.appendChild(node)
  return node
}

/** Assign only on change. `textContent` is cheap; the invalidation it triggers is not. */
export function setText(node: { textContent: string | null }, value: string): void {
  if (node.textContent !== value) node.textContent = value
}

export function setClass(node: Element, className: string, on: boolean): void {
  // `classList.toggle(name, force)` is already idempotent, but it still touches
  // the token list every call. The read is free and the write is not.
  if (node.classList.contains(className) !== on) node.classList.toggle(className, on)
}

/**
 * Size a canvas's backing store to its CSS box at the device pixel ratio and
 * install a matching transform, so every draw call afterwards works in CSS
 * pixels. Returns true when the backing store actually changed — the callers
 * cache static layers and need to know when to rebuild them.
 *
 * DPR is capped at 2, matching what `main.ts` does to the renderer: a 3x phone
 * would otherwise pay 2.25x the fill cost for a minimap nobody can see the
 * extra detail in.
 */
export function fitCanvas(node: HTMLCanvasElement): boolean {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = Math.max(1, Math.round(node.clientWidth * dpr))
  const h = Math.max(1, Math.round(node.clientHeight * dpr))
  if (node.width === w && node.height === h) return false
  node.width = w
  node.height = h
  const c2d = node.getContext('2d')
  if (c2d) c2d.setTransform(dpr, 0, 0, dpr, 0, 0)
  return true
}
