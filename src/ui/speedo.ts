import { INK, OUTLINE_SOLID, BONE } from './theme'
import { fitCanvas } from './dom'

/**
 * §8 bottom-right: "speedometer — analogue arc, needle with slight overshoot,
 * digital readout".
 *
 * The digital readout is a DOM string so it gets §8's outline treatment for
 * free; only the arc and the needle live on the canvas.
 *
 * ---------------------------------------------------------------------------
 * THE DIAL'S FULL SCALE IS A DISPLAY CONSTANT, AND THAT IS A CONTRACT GAP
 *
 * `KartState` exposes `speed` and `BoostState.strength`, but nothing anywhere in
 * `src/types.ts` says what a kart's top speed IS. A speedometer needs that
 * number — it is the entire meaning of the dial — so it is chosen here and
 * stated rather than derived. 160 km/h sits comfortably above an unboosted top
 * speed plus the largest boost multiplier the balance is likely to use, so the
 * needle has somewhere to go under boost instead of pinning at full lock, which
 * would delete exactly the feedback §7 wants a boost to produce.
 *
 * If `IKart` ever publishes a top speed, this constant should be deleted in the
 * same commit. Until then a rebalance of `BASE_TOP_SPEED` in `kart/` will
 * silently change how full the dial reads, and nothing will report it.
 */
const FULL_SCALE_KMH = 160

/** Sweep: 270°, from lower-left round to lower-right. */
const ANGLE_START = Math.PI * 0.75
const ANGLE_SWEEP = Math.PI * 1.5

/**
 * Needle dynamics — §8 asks for "slight overshoot", which is a second-order
 * system and not a lerp.
 *
 * ω = 26 rad/s puts the natural period at 240 ms; ζ = 0.55 is underdamped
 * enough to overshoot about 12% and settle within one further swing. Above
 * ζ ≈ 0.7 there is no visible overshoot at all and the spec is unmet; below
 * ≈ 0.4 the needle rings like a broken instrument and stops reading as speed.
 */
const NEEDLE_OMEGA = 26
const NEEDLE_ZETA = 0.55
/**
 * A frame delta larger than this is a stall, a tab returning from background,
 * or a harness stepping a burst of ticks. Integrating it explicitly would let
 * the spring go unstable and fling the needle; clamping just makes it late.
 */
const MAX_INTEGRATION_STEP = 1 / 30

export interface Speedo {
  /** `speedKmh` is already converted; `dt` comes from the sim clock, not the wall. */
  update(speedKmh: number, dt: number, accentColor: string): void
  dispose(): void
}

export function createSpeedo(element: HTMLCanvasElement): Speedo {
  const ctx2d = element.getContext('2d')

  /** Fraction of full scale, 0..1, as the needle actually sits. */
  let shown = 0
  let velocity = 0
  let lastDrawnFraction = -1
  let lastAccent = ''

  function draw(fraction: number, accent: string): void {
    if (!ctx2d) return
    const w = element.clientWidth
    const h = element.clientHeight
    if (w <= 0 || h <= 0) return

    const cx = w * 0.5
    const cy = h * 0.5
    const radius = Math.min(w, h) * 0.42
    const band = radius * 0.19

    ctx2d.clearRect(0, 0, w, h)
    ctx2d.lineCap = 'butt'

    // Casing. Same reason as the minimap: on sand at luma 0.65 an unbacked light
    // arc has nothing to separate against.
    ctx2d.beginPath()
    ctx2d.arc(cx, cy, radius, ANGLE_START, ANGLE_START + ANGLE_SWEEP)
    ctx2d.strokeStyle = OUTLINE_SOLID
    ctx2d.globalAlpha = 0.85
    ctx2d.lineWidth = band + 4
    ctx2d.stroke()

    // Empty track.
    ctx2d.globalAlpha = 0.35
    ctx2d.strokeStyle = BONE
    ctx2d.lineWidth = band
    ctx2d.stroke()

    // Filled arc.
    if (fraction > 0.001) {
      ctx2d.beginPath()
      ctx2d.arc(cx, cy, radius, ANGLE_START, ANGLE_START + ANGLE_SWEEP * fraction)
      ctx2d.globalAlpha = 1
      ctx2d.strokeStyle = accent
      ctx2d.lineWidth = band
      ctx2d.stroke()
    }

    // Ticks every 20 km/h. Drawn over the band so the driver can read the arc
    // as a quantity rather than as a glow.
    ctx2d.globalAlpha = 0.85
    ctx2d.strokeStyle = OUTLINE_SOLID
    ctx2d.lineWidth = 2
    const ticks = Math.round(FULL_SCALE_KMH / 20)
    for (let i = 0; i <= ticks; i++) {
      const a = ANGLE_START + (ANGLE_SWEEP * i) / ticks
      const cos = Math.cos(a)
      const sin = Math.sin(a)
      const inner = radius - band * 0.5
      const outer = radius + band * 0.5
      ctx2d.beginPath()
      ctx2d.moveTo(cx + cos * inner, cy + sin * inner)
      ctx2d.lineTo(cx + cos * outer, cy + sin * outer)
      ctx2d.stroke()
    }

    // Needle: dark under-stroke, light over-stroke. An outline again, not a glow.
    const na = ANGLE_START + ANGLE_SWEEP * fraction
    const nx = cx + Math.cos(na) * (radius - band * 0.75)
    const ny = cy + Math.sin(na) * (radius - band * 0.75)
    ctx2d.globalAlpha = 1
    ctx2d.lineCap = 'round'
    ctx2d.beginPath()
    ctx2d.moveTo(cx, cy)
    ctx2d.lineTo(nx, ny)
    ctx2d.strokeStyle = OUTLINE_SOLID
    ctx2d.lineWidth = 6
    ctx2d.stroke()
    ctx2d.strokeStyle = INK
    ctx2d.lineWidth = 2.6
    ctx2d.stroke()

    ctx2d.beginPath()
    ctx2d.arc(cx, cy, 4.2, 0, Math.PI * 2)
    ctx2d.fillStyle = OUTLINE_SOLID
    ctx2d.fill()
    ctx2d.beginPath()
    ctx2d.arc(cx, cy, 2.4, 0, Math.PI * 2)
    ctx2d.fillStyle = INK
    ctx2d.fill()
  }

  function update(speedKmh: number, dt: number, accentColor: string): void {
    const target = Math.min(1, Math.max(0, speedKmh / FULL_SCALE_KMH))
    const step = dt > MAX_INTEGRATION_STEP ? MAX_INTEGRATION_STEP : dt
    if (step > 0) {
      // Semi-implicit Euler: velocity first, then position with the NEW
      // velocity. Explicit Euler on a spring this stiff gains energy every step
      // and the needle slowly winds itself off the dial.
      velocity += (-2 * NEEDLE_ZETA * NEEDLE_OMEGA * velocity - NEEDLE_OMEGA * NEEDLE_OMEGA * (shown - target)) * step
      shown += velocity * step
      if (shown < 0) {
        shown = 0
        velocity = 0
      } else if (shown > 1.06) {
        // Allow a little overshoot past full lock, then stop: a needle that
        // wraps past the end of its own dial is a bug, not a flourish.
        shown = 1.06
        velocity = 0
      }
    }

    /*
     * Redraw only when the needle has actually moved a visible amount. At
     * 1/900 of a 270° sweep that is a third of a degree — under a pixel of tip
     * travel on a 190 px dial — so nothing visible is skipped, and a parked kart
     * on the grid stops repainting entirely.
     */
    // A resize wipes the backing store, so it forces a repaint whatever the
    // needle is doing. Without this the dial goes blank on rotation and stays
    // blank until the kart's speed happens to change.
    const resized = fitCanvas(element)

    const drawn = Math.min(shown, 1)
    if (resized || accentColor !== lastAccent || Math.abs(drawn - lastDrawnFraction) > 1 / 900) {
      draw(drawn, accentColor)
      lastDrawnFraction = drawn
      lastAccent = accentColor
    }
  }

  function dispose(): void {
    element.width = 0
    element.height = 0
    shown = 0
    velocity = 0
    lastDrawnFraction = -1
    lastAccent = ''
  }

  return { update, dispose }
}
