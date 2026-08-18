/*
 * THE CANYON ENVELOPE — the one place that decides where the rock starts.
 *
 * This file exists because two subsystems need the same answer and neither may
 * ask the other for it.
 *
 *   - `world/terrain.ts` sweeps the visible cliff, talus and hinterland from it.
 *   - `world/track.ts` answers `ITrack.wallLimit`, which is what a kart hits.
 *
 * They used to be one derivation with one consumer, and the barrier did not
 * exist. The moment a kart collides with something, "where the rock is" becomes
 * a fact TWO modules assert, and the failure mode of two assertions is that
 * they agree today and drift in the round after next — silently, because a
 * barrier a metre inside the visible face looks exactly like a barrier in the
 * right place from every screenshot ever taken of it. See §10: a critic scoring
 * a still cannot see this class of bug, and neither can a type checker.
 *
 * So the section table, the blend, the corner resolution, the talus repose run
 * and the four noise fields that jitter them all live here, and both callers
 * read this file. `wallProfileAt` is the single evaluation: terrain draws what
 * it returns, the kart collides with what it returns.
 *
 * WHY THE NOISE IS HERE TOO, AND WHY IT KEEPS TERRAIN'S NAMESPACE.
 * The crest height and the setback are both noise-modulated, by up to ±31% and
 * ±16% respectively. Sharing only the TABLE would leave the barrier standing at
 * the table's nominal offset while the rock stands where the noise put it —
 * metres apart in the open sections, and no comment anywhere would be wrong.
 * `createWallNoise` therefore builds the fields, and it draws them from
 * `world/terrain/fields` with terrain's own fork names on purpose: those are
 * the streams the built canyon already stands on, so adopting them leaves every
 * existing vertex bit-identical while making the barrier read the same numbers.
 * `RNG.fork` is keyed by name and never consumes from its parent, so two
 * callers asking for the same fork get bit-identical streams whatever order
 * they ask in. That is the property this depends on.
 */

import { createNoise2D } from 'simplex-noise'

import { BARRIER_MARGIN } from '../types'
import type { Ctx } from '../types'

// ---------------------------------------------------------------------------
// Small maths helpers. Deliberately local: this module is imported by two
// others and must not acquire a dependency on either of them.
// ---------------------------------------------------------------------------

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

export type Noise2 = (x: number, y: number) => number

/**
 * PERIODIC noise over the lap.
 *
 * Sampling `noise(arcLength / wavelength)` does not wrap: `arc = 0` and
 * `arc = length` are different points in the field, so every field driving wall
 * height, erosion and band thickness would step discontinuously across the
 * start line. Walking a circle in the noise domain instead makes the whole
 * family exactly periodic in `t`, at the cost of one sin and one cos.
 *
 * `wavelength` is in metres of centreline; `lapLength` converts it to turns.
 */
export function ringNoise2(n: Noise2, t: number, lapLength: number, wavelength: number): number {
  const a = t * Math.PI * 2
  const r = lapLength / wavelength / (Math.PI * 2)
  return n(Math.cos(a) * r, Math.sin(a) * r)
}

/** §5c: talus at 32° repose. `run = height / tan(32°)`. */
export const TALUS_RUN_PER_METRE = 1 / Math.tan((32 * Math.PI) / 180)

/*
 * EXTRA METRES BEYOND `halfWidth + BARRIER_MARGIN` THAT THE PROFILE MUST LEAVE
 * ALONE — and every one of them is derived, not chosen.
 *
 * `halfWidth + BARRIER_MARGIN` is the corridor, from the contract. Two
 * discretisation errors sit between that line and what the terrain actually
 * emits, and both are one-sided in the dangerous direction:
 *
 *   - The corridor is tested against STATIONS, 4.5 m apart, as a union of
 *     discs. A union of discs of radius R at spacing s under-covers the true
 *     tube around the polyline by `R - sqrt(R^2 - (s/2)^2)` in the gaps. At the
 *     tightest corridor on the lap (The Slot, R = 8.0 + 1.5 = 9.5 m) that is
 *     0.27 m.
 *   - The swept surface is a chord between two stations 4.5 m apart, and the
 *     road it must clear is a curve of radius >= 47.8 m (tools/track-check
 *     reports the minimum). The chord cuts inside the arc by the sagitta,
 *     4.5^2 / (8 * 47.8) = 0.053 m.
 *
 * 0.27 + 0.05 = 0.32, rounded up to 0.5 for the arithmetic to stay obviously
 * safe rather than exactly safe. This is not a tuning knob: raise the station
 * spacing and the first term grows as s^2 and this number has to be re-derived.
 */
export const CORRIDOR_CLEARANCE = 0.5

/*
 * The kart's half-width, as a documented local copy. `world/` may not import
 * from `kart/` — sibling imports are banned — and `world/track.ts` already
 * carries the same constant for the racing-line margin. If `HALF_TRACK` in
 * `src/kart/kart.ts` ever changes, BOTH copies go stale silently: the racing
 * line stops clearing the sand and a pinned kart stops being rescued. That is
 * the failure mode, written down because nothing enforces it.
 */
const KART_HALF_TRACK = 0.64

/*
 * WHY THE BARRIER MUST CLEAR THE KART'S BODY AND NOT ITS CENTRE POINT.
 *
 * `onTrack` is `|lateral| <= halfWidth + BARRIER_MARGIN`, and `lateral` is the
 * chassis CENTRE. The barrier stops that centre `KART_HALF_TRACK` inboard of
 * the toe. So with a toe at `halfWidth + BARRIER_MARGIN + CORRIDOR_CLEARANCE`
 * = hw + 2.00, a pinned kart sits at hw + 1.36 — 0.14 m INSIDE the corridor —
 * and `onTrack` stays TRUE while it is welded to a rock.
 *
 * That is not cosmetic. `race.ts` rescues a kart 2.25 s after it goes
 * OFF-track, so the rescue never fires and only the 12 s stall detector can
 * save it. Measured at The Slot's left face: 3600 ticks of full lock and full
 * throttle away from the wall recovered -0.01 m, wiggling recovered 0.00 m,
 * and only a continuously held brake escaped at all, taking 7.9 s. The arch
 * tunnel is worse — the kart ends welded at the limit exactly, 0.00 m gap,
 * 0.0 m/s, `onTrack` true for all 900 ticks.
 *
 * And it was systemic rather than two unlucky rocks: both trap sites measured
 * EXACTLY 0.14 m inside, because it is arithmetic. Every barrier standing at
 * the corridor floor traps, on every seed.
 *
 * So the floor is now the distance that puts the kart's OUTER EDGE on the
 * corridor line: `BARRIER_MARGIN + KART_HALF_TRACK`. The centre then rests at
 * exactly `halfWidth + BARRIER_MARGIN` — and `onTrack` compares with `<=`, so
 * resting exactly on the boundary still reads as ON track. PIN_ESCAPE is what
 * carries it past. It is one `ITrack.locate` lateral tolerance (track-check
 * reports worst 0.0017 m) rounded up two orders, for the same reason
 * CORRIDOR_CLEARANCE is 0.5 rather than 0.32: obviously safe beats exactly
 * safe.
 *
 * Cost to the visible rock: the toe moves out by
 * (1.5 + 0.64 + 0.1) - (1.5 + 0.5) = 0.24 m, against section setbacks of 2.4
 * to 50 m. The barrier and the rock still come from this one number, which is
 * the entire reason this module exists.
 */
const PIN_ESCAPE = 0.1
export const BARRIER_FLOOR_MARGIN = BARRIER_MARGIN + KART_HALF_TRACK + PIN_ESCAPE

/*
 * Below this crest height the section has NO WALL — see `wallProfileAt`.
 *
 * 2 m is not a styling choice. The dune sweep's outside collapses its wall to
 * 6% of 12 m, which is a 0.7 m sand berm sitting ~50 m off the road: nothing a
 * kart can be stopped by, and stopping one there would be an invisible wall in
 * open desert, which is worse than no wall at all. A kart is 0.92 m to the top
 * of the helmet (measured, see CORRIDOR_HEADROOM in terrain.ts), so 2 m is
 * comfortably above "drives over it" and comfortably below every real face on
 * the lap — the next lowest is The Wall's opened inside at ~8 m.
 */
export const WALL_MIN_HEIGHT = 2.0

// ---------------------------------------------------------------------------
// Section table
// ---------------------------------------------------------------------------

/*
 * A note that travelled with this table from terrain.ts and still governs it:
 * "outside of the corner" is resolved per station from the sampled curvature and
 * bank rather than against a hard-coded side. §1 says the dune sweep is a
 * right-hander with no wall on the outside, and The Wall banks 20° — but this
 * file must not encode which way the real `track.ts` decided to lay those out.
 * Reading `curvature` and `bank` makes "outside" a derived fact. `hint` is the
 * fallback for a section that turns out nearly straight, and it is the only
 * place §1's stated handedness is assumed.
 */
export interface Section {
  readonly name: string
  readonly start: number
  /** Crest height above the road, metres, `[left, right]`. */
  readonly height: readonly [number, number]
  /** Face base offset beyond `halfWidth`, metres, `[left, right]`. */
  readonly setback: readonly [number, number]
  /** Crest offset / base offset. < 1 overhangs inward; > 1 slopes back. */
  readonly topScale: readonly [number, number]
  /** Face curve exponent. > 1 keeps the base steep and slopes the top back. */
  readonly facePower: number
  /** Talus height as a fraction of wall height. §5c. */
  readonly talusFrac: number
  /** 0 = bare scree shoulder, 1 = sand shoulder. */
  readonly sand: number
  /** Gradient of the hinterland behind the crest. Low = plateau. */
  readonly backGrade: number
  /** 0..1 — how far the OUTSIDE of the corner opens out and drops its wall. */
  readonly openOutside: number
  /** 0..1 — how far the OUTSIDE instead becomes a tall tight retaining wall. */
  readonly bankWall: number
  /** -1 outside-is-left, +1 outside-is-right, 0 none. Used only when flat. */
  readonly hint: -1 | 0 | 1
}

export const SECTIONS: readonly Section[] = [
  // Hardpan grid. Open enough for §1's sky occupancy floor at `grid`.
  {
    name: 'hardpan-grid',
    start: 0.0,
    height: [14, 12],
    setback: [20, 24],
    topScale: [1.55, 1.6],
    facePower: 1.2,
    talusFrac: 0.24,
    sand: 0.3,
    backGrade: 0.35,
    openOutside: 0,
    bankWall: 0,
    hint: 0,
  },
  // Dune sweep. §1: sand shoulders both sides, no wall on the outside.
  {
    name: 'dune-sweep',
    start: 0.11,
    height: [12, 12],
    setback: [26, 26],
    topScale: [1.9, 1.9],
    facePower: 1.05,
    talusFrac: 0.4,
    sand: 0.85,
    backGrade: 0.3,
    openOutside: 0.92,
    bankWall: 0,
    hint: -1,
  },
  // Strata esses. §1: a 34 m face with all six bands legible. The `strata-wall`
  // vantage is graded here and nowhere else.
  {
    name: 'strata-esses',
    start: 0.23,
    height: [34, 31],
    setback: [13, 15],
    topScale: [1.28, 1.3],
    facePower: 1.3,
    talusFrac: 0.26,
    sand: 0.1,
    backGrade: 0.4,
    openOutside: 0,
    bankWall: 0,
    hint: 0,
  },
  /*
   * The Slot. `topScale` 0.34 is the whole section.
   *
   * §1 asks for 26 m walls and sky reduced to a 9° strip. Those two numbers are
   * only compatible if the walls LEAN IN: with a base 8 m off the centreline and
   * a vertical face, 26 m up the gap is 16 m wide and subtends 34°, not 9°. At
   * `topScale` 0.34 the crests close to about 2.7 m each side and the strip lands
   * near 11°, which is as close as this gets without the roof meeting itself.
   *
   * Nothing overhangs below 4 m, so a kart at the barrier line never touches
   * it. That was a claim about this table's numbers and nothing enforced it;
   * `CORRIDOR_HEADROOM` is now that 4 m, and `corridorMinU` is what holds the
   * lean above it. The lap sweep found 0.60 m of basal shale inside the barrier
   * line here at ride height while this sentence was still true of the table —
   * the erosion field had moved the face after the table had spoken.
   */
  {
    name: 'the-slot',
    start: 0.35,
    height: [26, 26],
    setback: [2.4, 2.4],
    topScale: [0.34, 0.34],
    facePower: 1.35,
    talusFrac: 0.1,
    sand: 0.05,
    backGrade: 0.12,
    openOutside: 0,
    bankWall: 0,
    hint: 0,
  },
  // Mesa climb. Everything gets out of the way: §1 wants the longest sightline
  // on the lap and five silhouette layers, and a 34 m wall 13 m out kills both.
  {
    name: 'mesa-climb',
    start: 0.44,
    height: [10, 8],
    setback: [42, 50],
    topScale: [2.0, 2.1],
    facePower: 0.95,
    talusFrac: 0.45,
    sand: 0.55,
    backGrade: 0.5,
    openOutside: 0,
    bankWall: 0,
    hint: 0,
  },
  // The Wall. The outside of the bank gets a near-vertical retaining face that
  // the banked road runs up against; the inside opens.
  {
    name: 'the-wall',
    start: 0.57,
    height: [12, 12],
    setback: [16, 16],
    topScale: [1.3, 1.3],
    facePower: 1.15,
    talusFrac: 0.22,
    sand: 0.2,
    backGrade: 0.38,
    openOutside: 0.35,
    bankWall: 0.9,
    hint: -1,
  },
  // Wash descent. A dry riverbed: low cut banks, deep loose scree.
  {
    name: 'wash-descent',
    start: 0.69,
    height: [11, 13],
    setback: [11, 9],
    topScale: [1.55, 1.5],
    facePower: 1.1,
    talusFrac: 0.5,
    sand: 0.45,
    backGrade: 0.35,
    openOutside: 0,
    bankWall: 0,
    hint: 0,
  },
  // Arch tunnel. This builds the gorge, not the roof — see terrain.ts' header.
  {
    name: 'arch-tunnel',
    start: 0.83,
    height: [24, 24],
    setback: [3.2, 3.2],
    topScale: [0.62, 0.62],
    facePower: 1.3,
    talusFrac: 0.12,
    sand: 0.05,
    backGrade: 0.15,
    openOutside: 0,
    bankWall: 0,
    hint: 0,
  },
]

/** Half-width in `t` of the cross-fade between adjacent sections. */
export const SECTION_BLEND = 0.018

export interface ResolvedSection {
  /** `[left, right]`. */
  readonly height: [number, number]
  readonly setback: [number, number]
  readonly topScale: [number, number]
  facePower: number
  readonly talusFrac: [number, number]
  readonly sand: [number, number]
  backGrade: number
}

/** A zeroed `ResolvedSection` for a caller that needs a reusable scratch. */
export function makeResolvedSection(): ResolvedSection {
  return {
    height: [0, 0],
    setback: [0, 0],
    topScale: [1, 1],
    facePower: 1,
    talusFrac: [0, 0],
    sand: [0, 0],
    backGrade: 0.35,
  }
}

export function sectionIndexAt(t: number): number {
  let i = 0
  for (let k = 0; k < SECTIONS.length; k++) if (t >= SECTIONS[k]!.start) i = k
  return i
}

/**
 * Blend the section table at `t`, then resolve the per-side corner terms from
 * the sampled curvature and bank.
 *
 * Writes into `out`. On the terrain side this runs once per station per build,
 * so it is not a hot path; on the kart side it runs inside `ITrack.wallLimit`,
 * which IS, and that is why it writes into a caller-owned object rather than
 * returning one.
 */
export function resolveSection(
  t: number,
  curvature: number,
  bank: number,
  out: ResolvedSection,
): void {
  const n = SECTIONS.length
  const i = sectionIndexAt(t)
  const prevB = SECTIONS[i]!.start
  const nextB = i + 1 < n ? SECTIONS[i + 1]!.start : 1
  const dPrev = t - prevB
  const dNext = nextB - t

  let other = i
  let w = 1
  if (dPrev < SECTION_BLEND) {
    other = (i - 1 + n) % n
    w = 0.5 + 0.5 * smoothstep(0, 1, dPrev / SECTION_BLEND)
  } else if (dNext < SECTION_BLEND) {
    other = (i + 1) % n
    w = 0.5 + 0.5 * smoothstep(0, 1, dNext / SECTION_BLEND)
  }

  const a = SECTIONS[other]!
  const b = SECTIONS[i]!

  for (let s = 0; s < 2; s++) {
    out.height[s] = lerp(a.height[s]!, b.height[s]!, w)
    out.setback[s] = lerp(a.setback[s]!, b.setback[s]!, w)
    out.topScale[s] = lerp(a.topScale[s]!, b.topScale[s]!, w)
    out.talusFrac[s] = lerp(a.talusFrac, b.talusFrac, w)
    out.sand[s] = lerp(a.sand, b.sand, w)
  }
  out.facePower = lerp(a.facePower, b.facePower, w)
  out.backGrade = lerp(a.backGrade, b.backGrade, w)

  const openOutside = lerp(a.openOutside, b.openOutside, w)
  const bankWall = lerp(a.bankWall, b.bankWall, w)
  const hint = w > 0.5 ? b.hint : a.hint

  /*
   * Which side is the outside of this corner.
   *
   * `curvature > 0` curves right (contract), so the outside is the driver's
   * LEFT. `bank > 0` banks the road down toward the driver's right, which puts
   * the high — outside — edge on the left as well. The two agree, so they can be
   * maxed together: whichever signal is stronger wins, and a section with
   * neither falls back to §1's stated handedness through `hint`.
   *
   * 160 is the curvature gain: it saturates at about a 90 m radius, so a
   * genuinely fast sweeper still reads as a corner instead of a straight.
   */
  const curvSign = clamp(curvature * 160, -1, 1)
  const bankSign = clamp(bank * 6, -1, 1)
  let wl = Math.max(0, curvSign, bankSign)
  let wr = Math.max(0, -curvSign, -bankSign)
  if (wl + wr < 0.3 && hint !== 0) {
    if (hint < 0) wl = 0.6
    else wr = 0.6
  }
  // Two scalars rather than the `[wl, wr]` tuple this used to build: on the
  // terrain side an array literal per station is free, but `wallLimit` calls
  // through here once per kart per tick and is on the contract's MUST NOT
  // ALLOCATE list beside `surfaceAt`.
  for (let s = 0; s < 2; s++) {
    const outsideWeight = s === 0 ? wl : wr
    const ow = outsideWeight * openOutside
    if (ow > 0) {
      // §1 dune sweep: sand shoulders and no wall on the outside. The wall does
      // not vanish — it collapses into a low dune berm, so the horizon still has
      // an edge and the §9b variance floor still has something to sit on.
      out.height[s] = out.height[s]! * (1 - 0.94 * ow)
      out.setback[s] = out.setback[s]! + 26 * ow
      out.sand[s] = lerp(out.sand[s]!, 0.95, ow)
      out.talusFrac[s] = lerp(out.talusFrac[s]!, 0.66, ow)
      out.topScale[s] = lerp(out.topScale[s]!, 2.6, ow)
    }
    const bw = outsideWeight * bankWall
    if (bw > 0) {
      out.height[s] = lerp(out.height[s]!, 26, bw)
      out.setback[s] = lerp(out.setback[s]!, 2.6, bw)
      out.topScale[s] = lerp(out.topScale[s]!, 1.02, bw)
      out.talusFrac[s] = lerp(out.talusFrac[s]!, 0.1, bw)
      out.sand[s] = lerp(out.sand[s]!, 0.08, bw)
    }
  }
}

// ---------------------------------------------------------------------------
// The noise fields that move the envelope
// ---------------------------------------------------------------------------

export interface WallNoise {
  readonly crestLow: Noise2
  readonly crestHigh: Noise2
  readonly notch: Noise2
  readonly setback: Noise2
}

/**
 * The four fields the envelope depends on.
 *
 * The namespace is `world/terrain/fields` with terrain's own fork names, and
 * that is deliberate — see the file header. Changing either the namespace or a
 * fork name here rebuilds the canyon from a different seed.
 */
export function createWallNoise(ctx: Ctx): WallNoise {
  const rng = ctx.rngFor('world/terrain/fields')
  return {
    crestLow: createNoise2D(rng.fork('crest-low')),
    crestHigh: createNoise2D(rng.fork('crest-high')),
    notch: createNoise2D(rng.fork('notch')),
    setback: createNoise2D(rng.fork('setback')),
  }
}

// ---------------------------------------------------------------------------
// The envelope itself
// ---------------------------------------------------------------------------

export interface WallProfilePoint {
  /** Crest height above the road plane, metres. */
  height: number
  /** Lateral offset of the face base from the centreline, metres, unsigned. */
  faceBase: number
  /**
   * Lateral offset of the TALUS TOE — the innermost point of the swept
   * cross-section. Always finite: terrain builds vertices here.
   */
  toe: number
  /**
   * `toe` again, or `Infinity` where the section has no wall to hit. This is
   * the number `ITrack.wallLimit` returns, and it is a SEPARATE field from
   * `toe` on purpose: terrain must still draw the dune berm it declines to
   * collide with, and a shared field would have to be either a barrier terrain
   * cannot see past or an `Infinity` terrain would build NaN vertices from.
   */
  barrier: number
  /** Height of the talus wedge that runs from `toe` up to `faceBase`. */
  talusHeight: number
}

export function makeWallProfilePoint(): WallProfilePoint {
  return { height: 0, faceBase: 0, toe: 0, barrier: 0, talusHeight: 0 }
}

/**
 * Evaluate the canyon envelope on one side at one station.
 *
 * `side` is 0 for the driver's left and 1 for the driver's right, matching the
 * `[left, right]` ordering of every pair in `Section`. The returned offsets are
 * UNSIGNED distances from the centreline; the caller applies the sign.
 *
 * `toe` is what a kart hits and what terrain stands its scree on. It is the
 * same number for both, by construction, because there is only one of it.
 */
export function wallProfileAt(
  t: number,
  lapLength: number,
  halfWidth: number,
  resolved: ResolvedSection,
  side: 0 | 1,
  noise: WallNoise,
  out: WallProfilePoint,
): void {
  // Crest line. Two octaves plus an occasional notch — §1 Trap 4 is about
  // mesas, but a crest that is a smooth offset of the road is the same
  // failure at a different scale.
  const phase = side === 0 ? 0 : 0.5
  const nLow = ringNoise2(noise.crestLow, t + phase, lapLength, 70)
  const nHigh = ringNoise2(noise.crestHigh, t + phase, lapLength, 22)
  const notch = smoothstep(0.55, 0.95, 1 - Math.abs(ringNoise2(noise.notch, t + phase, lapLength, 150)))
  let h = resolved.height[side]! * (1 + nLow * 0.22 + nHigh * 0.09)
  h *= 1 - notch * 0.38
  h = Math.max(0.6, h)
  out.height = h

  // Face base sits at halfWidth + setback, jittered. The talus then runs
  // DOWN and IN from there at the §5c 32° repose angle, so the toe is what
  // moves when there is not enough room — never the face.
  const setJitter = ringNoise2(noise.setback, t + phase * 1.7, lapLength, 55) * 0.16
  const base = halfWidth + Math.max(0.6, resolved.setback[side]! * (1 + setJitter))
  let tH = Math.min(resolved.talusFrac[side]! * h, 7)
  let run = tH * TALUS_RUN_PER_METRE
  /*
   * BARRIER_MARGIN is the shoulder a kart may legally be on. Nothing the
   * terrain emits starts inboard of it — and that used to be a comment over
   * `BARRIER_MARGIN * 0.4`, which let the scree toe sit 0.6 m off the road
   * on a 1.5 m margin. The comment was right and the code was not; a kart
   * inside its own legal run-off was inside a talus slope. Full margin.
   *
   * Plus CORRIDOR_CLEARANCE, and that is not belt-and-braces. Terrain evaluates
   * this at a STATION, 4.5 m from its neighbours, and the road it must clear is
   * a curve; a toe placed at exactly `halfWidth + BARRIER_MARGIN` there
   * measures up to 0.32 m INSIDE the barrier line when it is projected back
   * through `ITrack.locate` from a point between stations. The lap sweep
   * measured 0.08 m of exactly that before this term existed. The clearance
   * is the discretisation error, derived where it is declared.
   *
   * It is ALSO what keeps `ITrack.wallLimit` honest about off-track driving:
   * the contract forbids a wall inboard of `halfWidth + BARRIER_MARGIN`
   * because grip 0.5 and drag 9.0 on the shoulder are a designed penalty, and
   * a barrier there deletes it. This clamp is that promise, and it is the same
   * line of code that holds it for the visible rock.
   */
  const minToe = halfWidth + BARRIER_FLOOR_MARGIN + CORRIDOR_CLEARANCE
  if (base - run < minToe) {
    run = Math.max(0, base - minToe)
    tH = run / TALUS_RUN_PER_METRE
  }
  out.talusHeight = tH
  out.faceBase = base
  out.toe = base - run
  /*
   * NO WALL is a legal answer, and it is not the same as a wall at a large
   * offset. Where `openOutside` has collapsed the crest to a dune berm there is
   * nothing here for a kart to hit; reporting the berm's toe as a barrier would
   * stop a kart dead in open desert against something it can see over.
   * `ITrack.wallLimit` passes this straight through as its non-finite answer.
   */
  out.barrier = h < WALL_MIN_HEIGHT ? Infinity : out.toe
}
