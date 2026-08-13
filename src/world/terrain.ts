/**
 * VERMILION NINE — CANYON TERRAIN
 * ==============================
 *
 * The cliffs, strata, talus, scatter and distant mesa layers that the circuit
 * runs through. Everything here is swept along `ITrack`'s spline; nothing in
 * this file knows what the spline actually is, and nothing in this file may
 * ever import an implementation of it.
 *
 * WHAT THIS REPLACES, AND WHY IT LOOKS DIFFERENT
 * ----------------------------------------------
 * `render/placeholder-canyon.ts` builds two straight rows of axis-aligned boxes
 * at fixed Z. Three things about that are visible from the first frame and none
 * of them are fixable by re-colouring it:
 *
 *   1. A box face has ONE normal. Under a hemisphere fill plus a single
 *      directional key, one normal is one colour across the whole face —
 *      variance exactly zero. ART_DIRECTION §9b forbids that outright, and the
 *      §9b unpainted-tile detector cannot tell a flat face from a region the GPU
 *      never painted. It has already fired here once on a frame where nothing
 *      was wrong. Every surface this file emits is either curved, noise-
 *      displaced, or vertex-tinted, and most are all three.
 *   2. Straight rows converge on a vanishing point that the road does not.
 *      Walls that ignore the spline read as scenery flown past, not as a place.
 *   3. Repeated primitives on a skyline are §1 Trap 4 in its purest form.
 *
 * THE FOUR THINGS THAT ARE NOT NEGOTIABLE IN HERE
 * -----------------------------------------------
 *   - `roughnessMap` MULTIPLIES `material.roughness`. Every material below that
 *     carries one either sets roughness to 1.0 or states, in a comment, the
 *     effective range the trim produces and why. A "sensible fallback" of 0.12
 *     silently crushed a whole map on this project once already.
 *   - Randomness is `ctx.rngFor(...)` and its forks. No `Math.random`, no clock.
 *     Wall PROFILE geometry additionally uses no RNG at all — only periodic
 *     noise keyed on `t` — so that the station at `t = 1` is bit-identical to
 *     the station at `t = 0` and the lap closes without a seam.
 *   - Everything repeated is instanced. Measured cost is 34 meshes, 17 of them
 *     shadow casters — 51 draw calls worst case, against a 250-call game and a
 *     90-call allowance. `TerrainStats` reports the real numbers rather than
 *     this comment's memory of them.
 *   - Vegetation is clamped to saturation ≤ 0.30 and hue 60°–95° (§3a). See the
 *     note on `DRY_BRUSH` — the art bible contradicts itself on this and this
 *     file follows the rule, not the swatch.
 *
 * OWNERSHIP
 * ---------
 * This module owns: cliff walls, strata, talus slope, the shoulder apron
 * between road edge and wall toe, boulder/pebble/brush scatter, and the distant
 * mesa layers. It does NOT own: the road surface, kerbs, the open sand plane
 * beyond the apron, the sky, or the arch roof over §1's arch tunnel section.
 * It builds the gorge the arch sits in and leaves the roof to whoever claims it.
 */

import { createNoise2D, createNoise3D } from 'simplex-noise'
import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three'

import { BARRIER_MARGIN, Surface } from '../types'
import type { Ctx, ITrack, RNG, StartSlot, TrackLocation, TrackSample } from '../types'
import { makeRockSurface } from '../render/procedural'
/*
 * The section table, the corner resolution, the talus repose run and the four
 * noise fields that jitter them USED TO LIVE IN THIS FILE. They moved out the
 * day a kart started colliding with what this file draws: `world/track.ts` has
 * to answer `ITrack.wallLimit` from the same numbers, and a second copy of the
 * envelope is a barrier that agrees with the rock today and drifts from it
 * silently. `wall-profile.ts` says the rest; nothing here re-derives any of it.
 */
import {
  CORRIDOR_CLEARANCE,
  makeResolvedSection,
  makeWallProfilePoint,
  createWallNoise,
  resolveSection,
  ringNoise2,
  wallProfileAt,
  type Noise2,
  type ResolvedSection,
} from './wall-profile'
/*
 * THE ONE THING THIS FILE IMPORTS FROM A SIBLING, AND WHY.
 *
 * `road.ts` and this file both used to draw the ground immediately beside the
 * road, each from its own idea of where the road stops. They disagreed, and the
 * disagreement is the grey z-fighting stripe along the road edge in
 * tools/out/lap-0.png. Two authors cannot converge on a shared edge by writing
 * the same number twice; one of them has to own it.
 *
 * `road.ts` owns it, because it is the file that draws the thing the edge is an
 * edge OF. This file consumes `roadEdgePoint`/`roadEdgeTuck` and derives nothing
 * of its own — so when another agent widens the track, both surfaces move
 * together, and `tools/seam-check.mjs` proves it at every station.
 *
 * This is not a violation of the "no implementation of ITrack reaches this
 * file" rule at the top. `road.ts` is not a track; it is a peer surface, and
 * these two functions are pure geometry over a `TrackSample` the caller
 * supplies.
 */
import { roadEdgePoint, roadEdgeTuck } from './road'

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface TerrainStats {
  /** Meshes added to the group. Upper bound on colour-pass draw calls. */
  readonly meshes: number
  /** Meshes with `castShadow`. Each is one extra draw in the shadow pass. */
  readonly shadowCasters: number
  /** `meshes + shadowCasters` — the number to compare against the §9 ceiling. */
  readonly drawCallsWorstCase: number
  readonly triangles: number
  readonly instances: number
  readonly stations: number
  /**
   * Scatter placements dropped because their bounding sphere could not clear
   * `halfWidth + BARRIER_MARGIN` and still land on the talus.
   *
   * Reported rather than swallowed. A build where this is large is a build
   * where the sections have no shoulder left, which is a track-width problem
   * wearing a scatter-density costume, and the number is the only place it
   * would show up before somebody noticed the scree had gone.
   */
  readonly scatterRejected: number
  /**
   * Station cross-sections whose outward reach had to be squeezed to stay out
   * of another part of the lap's corridor, and the worst squeeze factor
   * applied. See `computeCorridorReach`.
   *
   * Reported for the same reason `scatterRejected` is: a build where this is
   * large is a circuit that folds back on itself harder than the section table
   * assumes, and this number is the only place that would show up before
   * somebody noticed the hinterland had steepened.
   */
  readonly profilesCompressed: number
  readonly worstProfileSqueeze: number
  /**
   * Stations whose FACE BASE — not just its hinterland — could not clear
   * another part of the lap's corridor. Should be zero. Anything else is a
   * track layout that passes closer to itself than the section's own setback,
   * and it is a conversation about the layout, not a number to tune here.
   */
  readonly corridorConflicts: number
}

interface ProfileStats {
  readonly compressedProfiles: number
  readonly worstSqueeze: number
  readonly corridorConflicts: number
}

/**
 * §1 Trap 4 evidence, computed from the placements that were actually emitted
 * rather than asserted by the code that emitted them.
 *
 * A reviewer checks Trap 4 by reading these four numbers:
 *   `violations === 0`, `distinctProfiles >= 7`, `layers >= 5`,
 *   `minAdjacentLayerCapRatio >= 1.08`.
 * See `auditMesaField` for how each is measured.
 */
export interface MesaAudit {
  readonly layers: number
  readonly instances: number
  readonly distinctProfiles: number
  /** How many placements re-used a profile already in the field. */
  readonly reuses: number
  /** Pairs sharing a profile that fail the §1 Trap 4 separation rule. */
  readonly violations: number
  /**
   * `min over adjacent layer pairs of (lowest cap in the far layer) /
   * (highest cap in the near layer)`. §1 requires no two adjacent layers share
   * a cap height within 8%, i.e. this must be ≥ 1.08.
   */
  readonly minAdjacentLayerCapRatio: number
}

export interface CanyonTerrain {
  /** Added to `ctx.scene` by `buildCanyonTerrain`; `dispose` removes it. */
  readonly group: Object3D
  readonly stats: TerrainStats
  readonly mesaAudit: MesaAudit
  dispose(): void
}

// ---------------------------------------------------------------------------
// Palette — ART_DIRECTION §3a, verbatim. Every one of these is a spec value.
// ---------------------------------------------------------------------------

const C_CAPROCK = new Color(0xc9764a)
const C_UPPER = new Color(0xb5623f)
const C_MID = new Color(0xa0553a)
const C_LOWER = new Color(0x8f4a33)
const C_OXIDE = new Color(0x7d3529)
const C_SHALE = new Color(0x6b3c30)
/** §1 Trap 1: mandatory. The value break that stops a cliff reading as one brown thing. */
const C_GYPSUM = new Color(0xd8bfa0)
const C_VARNISH = new Color(0x4e3a30)
const C_SCREE = new Color(0xa8917a)
const C_SAND_COMPACT = new Color(0xc2a271)
const C_SAND_SUNLIT = new Color(0xe3c893)

/** §3a sage: hue 76°, saturation 0.15. Inside the §3a vegetation clamp. */
const C_SAGE = new Color(0x6b7355)
/*
 * §3a lists "Vegetation — dry brush #8c7a52, 43°, saturation 0.26" and then, two
 * lines later, "Vegetation is capped at saturation ≤ 0.30 and hue 60°–95°, with
 * no exceptions." #8c7a52 is hue 43°. The swatch and the rule contradict each
 * other and only one of them can be honoured.
 *
 * The RULE is honoured, because the rule is the one with a stated reason (§4
 * band safety and the grey-green-not-green read) and the swatch is just a
 * number. #8b8d53 is that swatch rotated to the nearest legal hue: HSL(62°,
 * 0.26, 0.44) — same saturation, same lightness, inside the band. Flagged in
 * the build report rather than silently reconciled.
 */
const C_DRY_BRUSH = new Color(0x8b8d53)

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Metres of centreline between wall cross-sections. 4.5 m puts ~20 stations
 * through §1's 92 m Slot, which is the shortest section on the lap and the one
 * whose shape matters most.
 */
const STATION_SPACING = 4.5

/**
 * Arc-length chunks the swept geometry is split into. This is a frustum-culling
 * knob and nothing else: one lap-long mesh is never culled and submits 1620 m
 * of triangles from inside a slot canyon. Six chunks costs six extra draw calls
 * and typically leaves two of them visible.
 */
const CHUNKS = 6

/** §5c: global 2.4° dip so bedding planes are not perfectly level anywhere. */
const DIP_SLOPE = Math.tan((2.4 * Math.PI) / 180)
/** Dip strike direction, radians in the XZ plane. Arbitrary but fixed. */
const DIP_AZIMUTH = 1.02

/**
 * The dip is CLAMPED to ±30% of the local face height, and that is a deliberate
 * departure from a literal reading of §5c.
 *
 * An unclamped 2.4° dip is 0.042 m of rise per metre of ground. Across a circuit
 * whose bounding box is several hundred metres, that carries the bedding stack
 * tens of metres up or down — which would take the gypsum seam clean off the top
 * of a 26 m wall in The Slot and clean under the talus somewhere else. §1 says
 * the seam "runs the whole circuit" and calls it mandatory. Both cannot hold, so
 * the dip runs at full 2.4° until it would cost the seam and then flattens.
 * The bands are still non-level everywhere, which is what §5c is protecting.
 */
const DIP_CLAMP_FRACTION = 0.3

/** §1: gypsum seam at 41% of cliff height, 0.9–1.6 m thick. */
const GYPSUM_CENTRE = 0.41
/** §3a: iron oxide band, thin, 0.4–0.8 m. */
const OXIDE_MIN = 0.4
const OXIDE_MAX = 0.8

/*
 * HEADROOM: how far above the road the corridor extends.
 *
 * It cannot be infinite. §1 gives this circuit an arch tunnel with a roof and a
 * Slot whose walls close to a 9° sky strip; both are named design intents and
 * both put rock over the road on purpose. So the rule has to be "nothing in the
 * corridor BELOW the headroom", and the headroom is the number that decides
 * whether an overhang is architecture or an obstacle.
 *
 * MEASURED, not assumed. The contract carries no kart dimensions — tools/
 * track-check.mjs flags that absence as its own finding — so this was taken off
 * the built model: every vertex of the eight grid karts projected through
 * `ITrack.locate` tops out at 0.920 m above the road plane (the helmet), with
 * the lowest at -0.042 m. 4.0 m is 4.3x that, leaving 3.08 m of air for a kart
 * that is airborne over a crest.
 *
 * It is also the number this file already committed to in prose: The Slot's
 * section entry says "Nothing overhangs below 4 m, so a kart at the barrier
 * line never touches it". That sentence was true and unenforced. It is now the
 * constant.
 */
const CORRIDOR_HEADROOM = 4.0

/*
 * Above the headroom the wall is allowed to lean back in, and this is how fast
 * it may do so.
 *
 * The forbidden region has to be described by a CONCAVE lower bound on `u` as a
 * function of height, not by a step. Rows are joined by straight quads: if
 * every row satisfies `u >= f(h)` and `f` is concave, then every point on every
 * quad between them satisfies it too, because a chord of points above a concave
 * function stays above it. A step from "full width" to "no constraint" is not
 * concave, and a face that jumped the step would sweep straight through the
 * corridor between two legal rows — which is exactly the class of miss that a
 * per-vertex check cannot see.
 *
 * Constant, then linear-decreasing, is concave. 6 m of fade takes the bound
 * from the full corridor at 4 m to zero at 10 m — steeper than anything §1
 * asks for. The Slot's crest sits at 0.34x its base offset, about 3.5 m from
 * the centreline at 26 m up, and clears this bound by 16 m of height.
 */
const CORRIDOR_LEAN_FADE = 6.0

/**
 * The concave lower bound on the profile's lateral offset — the shape of the
 * corridor, seen from a wall.
 *
 * `hAbove` is metres above the road plane at this station. Below the headroom
 * nothing may come inside `halfWidth + BARRIER_MARGIN + CORRIDOR_CLEARANCE`;
 * above it the bound falls away linearly so §1's overhangs remain buildable.
 */
function corridorMinU(hAbove: number, halfWidth: number): number {
  const w = halfWidth + BARRIER_MARGIN + CORRIDOR_CLEARANCE
  if (hAbove <= CORRIDOR_HEADROOM) return w
  return Math.max(0, w * (1 - (hAbove - CORRIDOR_HEADROOM) / CORRIDOR_LEAN_FADE))
}

/** §1 Trap 4, the three separation criteria. All three must hold to permit reuse. */
const TRAP4_MIN_AZIMUTH_DEG = 55
const TRAP4_MIN_DEPTH_M = 180
const TRAP4_MIN_APPARENT_HEIGHT_DELTA = 0.18

/** §1 Trap 4: no two adjacent mesa layers share a cap height within 8%. */
const MESA_LAYER_HEIGHT_RATIO = 1.22
const MESA_HEIGHT_JITTER = 0.05
const MESA_LAYERS = 6
const MESA_SIDES = 7

// ---------------------------------------------------------------------------
// Small maths helpers
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

type Noise3 = (x: number, y: number, z: number) => number

function ringNoise3(
  n: Noise3,
  t: number,
  lapLength: number,
  wavelength: number,
  w: number,
): number {
  const a = t * Math.PI * 2
  const r = lapLength / wavelength / (Math.PI * 2)
  return n(Math.cos(a) * r, Math.sin(a) * r, w)
}

/** §5c erosion is a RIDGED field: `1 - |noise|`, which carves creases not blobs. */
function ridged3(n: Noise3, t: number, lapLength: number, wavelength: number, w: number): number {
  return 1 - Math.abs(ringNoise3(n, t, lapLength, wavelength, w))
}

function angularSepDeg(a: number, b: number): number {
  let d = Math.abs(a - b) % 360
  if (d > 180) d = 360 - d
  return d
}

// ---------------------------------------------------------------------------
// Band layout
// ---------------------------------------------------------------------------

/**
 * The wall cross-section, bottom to top, as a fixed list of bands.
 *
 * Rows are DUPLICATED at every band boundary — band `k`'s top row and band
 * `k+1`'s bottom row are separate vertices at the same position. That is what
 * makes a strata boundary a hard value step instead of a gradient, and it is why
 * `computeVertexNormals` cannot smear shading across a bedding plane.
 *
 * `hard` selects the material. §5a splits rock roughness by strata hardness:
 * caprock is wind-polished, the gypsum evaporite and the oxide band are dense,
 * the shales are matte. Two materials is the cheapest honest split; per-band
 * roughness would need either six materials (six times the draw calls) or a
 * custom `onBeforeCompile`, and neither is worth it for a term the roughness map
 * is already varying spatially.
 */
interface BandSpec {
  readonly name: string
  readonly rows: number
  readonly colour: Color
  readonly hard: boolean
  /**
   * Metres the band weathers back (+) or stands proud (−) at its mid-height.
   * Ramped with a sine inside the band so adjacent bands still meet — a raw step
   * would open a hole in the swept surface where the ledge should be.
   */
  readonly bias: number
}

const BAND_TALUS = 0
const BAND_CAP_TOP = 8
const BAND_BACKSLOPE = 9

const BANDS: readonly BandSpec[] = [
  { name: 'talus', rows: 4, colour: C_SCREE, hard: false, bias: 0 },
  /*
   * THREE rows minimum on every band, including the thin seams.
   *
   * `bias` is ramped with `sin(pi * localFraction)`, which is zero at both band
   * edges — that is what keeps adjacent bands meeting instead of leaving a hole
   * where the ledge should be. With only TWO rows the band has no interior
   * sample, both its rows sit at local 0 and 1, and the bias evaluates to zero
   * twice: the seam comes out perfectly flush with the face. The gypsum band was
   * built that way first and the result is a stripe of paint rather than a
   * weathered-back seam with a shadow line under its lip, which is most of what
   * makes §1's mandatory value break read at distance.
   */
  { name: 'basal-shale', rows: 3, colour: C_SHALE, hard: false, bias: 0.55 },
  { name: 'iron-oxide', rows: 3, colour: C_OXIDE, hard: true, bias: 0.15 },
  { name: 'lower-strata', rows: 3, colour: C_LOWER, hard: false, bias: 0.3 },
  { name: 'mid-strata', rows: 3, colour: C_MID, hard: false, bias: 0.2 },
  { name: 'gypsum-seam', rows: 3, colour: C_GYPSUM, hard: true, bias: 0.45 },
  { name: 'upper-strata', rows: 4, colour: C_UPPER, hard: false, bias: 0.1 },
  { name: 'caprock', rows: 3, colour: C_CAPROCK, hard: true, bias: -0.9 },
  { name: 'cap-top', rows: 3, colour: C_CAPROCK, hard: true, bias: 0 },
  { name: 'backslope', rows: 4, colour: C_LOWER, hard: false, bias: 0 },
]

const ROWS_TOTAL = BANDS.reduce((s, b) => s + b.rows, 0)
const BAND_ROW_OFFSET: readonly number[] = (() => {
  const out: number[] = []
  let o = 0
  for (const b of BANDS) {
    out.push(o)
    o += b.rows
  }
  return out
})()

// ---------------------------------------------------------------------------
// Per-station data
// ---------------------------------------------------------------------------

interface Station {
  readonly t: number
  readonly arc: number
  /** Centreline position. */
  readonly px: number
  readonly py: number
  readonly pz: number
  /** Unit "driver's right", horizontalised. Walls stand on world up. */
  readonly rx: number
  readonly rz: number
  /**
   * The two components of the UNFLATTENED right vector that were thrown away
   * by horizontalising it, kept because scatter clearance is measured in the
   * ROAD's frame and not in this file's.
   *
   * `TrackLocation.lateral` — which is what `BARRIER_MARGIN` is defined
   * against, and what tools/seam-check.mjs measures — is the component along
   * the banked `right`. A rock placed `u` metres out horizontally and `dy`
   * metres up is at lateral `u·rightXZ + dy·rightY`, and through The Wall's
   * bank that second term is over a metre. Placing on `u` alone put boulders
   * a metre inside the barrier line while every number in this file said they
   * were clear.
   */
  readonly rightY: number
  readonly rightXZ: number
  /**
   * The world height the ground on this side stands on. `[left, right]`.
   *
   * NOT `py`. The road banks 20° through The Wall, so its outer edge is metres
   * above the centreline and its inner edge metres below — and a canyon floor
   * datumed on the centreline meets neither. Before this existed the apron had
   * to fall about five metres between the road edge and a scree toe 1.5 m away,
   * which seam-check reported as 186 stations of run-off outside its band and
   * which reads, from a kart, as the ground dropping away beside you.
   *
   * The walls still STAND on world up — only their base height moves. A wall
   * that leaned with the bank would be a canyon that tips over when the road
   * does, which is the thing `sampleStations` horizontalises `right` to
   * prevent, and this does not undo it.
   */
  readonly baseY: [number, number]
  readonly halfWidth: number
  readonly racingLine: number
  /** Per side (0 = left, 1 = right). */
  readonly wallH: [number, number]
  readonly toeU: [number, number]
  readonly faceBaseU: [number, number]
  readonly faceTopU: [number, number]
  readonly talusH: [number, number]
  readonly sand: [number, number]
  /**
   * The road edge, and the point the apron tucks under it to, in WORLD space
   * and on the ROAD's banked frame. Both come from `road.ts` — see the import
   * note at the top. `[side][x, y, z]`.
   *
   * These are the only two points in this file that are not built on world up.
   * They must not be: the road banks 20° through The Wall, and an apron that
   * meets a banked road edge with a horizontalised right vector misses it by
   * `sin(bank) · halfWidth`. Measured before the fix: 0.80 m of daylight
   * between the road edge and the apron's inner edge at t = 0.58.
   */
  readonly seam: [[number, number, number], [number, number, number]]
  readonly edge: [[number, number, number], [number, number, number]]
  /** Metres the apron overlaps under the road here. `road.ts` decides this. */
  readonly seamTuck: [number, number]
  readonly facePower: number
  readonly backGrade: number
  /** Metres the bedding stack is displaced by the §5c 2.4° dip at this point. */
  dip: number
  /**
   * THE FURTHEST OUT THIS STATION'S CROSS-SECTION MAY REACH, per side, before
   * it enters the drivable corridor of some OTHER part of the lap.
   *
   * `Infinity` where the ray never meets the circuit again, which is most of
   * the lap. See `computeCorridorReach` for how it is measured and
   * `buildProfiles` for what is done about it.
   */
  reachU: [number, number]
  /** Row offsets and heights, `[side][row]`. Heights are above the road plane. */
  readonly rowU: [Float64Array, Float64Array]
  readonly rowH: [Float64Array, Float64Array]
  /** Accumulated distance along the profile — the vertical texture coordinate. */
  readonly rowV: [Float64Array, Float64Array]
}

/** The noise family. One object so the fields are named once and shared. */
interface Fields {
  readonly crestLow: Noise2
  readonly crestHigh: Noise2
  readonly notch: Noise2
  readonly bandThickness: Noise2
  readonly seamThickness: Noise2
  readonly setback: Noise2
  readonly erode: Noise3
  readonly mottle: Noise3
  readonly varnish: Noise3
  readonly capRun: Noise2
}

// ---------------------------------------------------------------------------
// Geometry accumulation
// ---------------------------------------------------------------------------

class SurfaceBuilder {
  readonly pos: number[] = []
  readonly uv: number[] = []
  readonly col: number[] = []
  readonly idx: number[] = []

  vertex(x: number, y: number, z: number, u: number, v: number, c: Color): number {
    const i = this.pos.length / 3
    this.pos.push(x, y, z)
    this.uv.push(u, v)
    this.col.push(c.r, c.g, c.b)
    return i
  }

  /** `a b c d` in ring order; caller has already resolved the winding. */
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d)
  }

  build(): BufferGeometry | null {
    if (this.idx.length === 0) return null
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3))
    g.setAttribute('uv', new Float32BufferAttribute(this.uv, 2))
    g.setAttribute('color', new Float32BufferAttribute(this.col, 3))
    g.setIndex(this.idx)
    g.computeVertexNormals()
    g.computeBoundingSphere()
    return g
  }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export interface CanyonTerrainOptions {
  /**
   * Build the shoulder apron between the road edge and the wall toe. On by
   * default: only this module knows where the wall toes ended up, so only this
   * module can close that gap. Turn it off if `road.ts` grows its own shoulder.
   */
  readonly apron?: boolean
  /** Multiplier on every scatter density. Quality tier already scales these. */
  readonly scatterDensity?: number
}

/**
 * Build the canyon. Adds its group to `ctx.scene` and returns it; `dispose()`
 * detaches and frees every geometry, material and texture it created.
 *
 * `track` is read through `ITrack` and nothing else — `sample`, `racingLine`
 * and `length`. No implementation detail of the spline reaches this file.
 */
export function buildCanyonTerrain(
  ctx: Ctx,
  track: ITrack,
  options: CanyonTerrainOptions = {},
): CanyonTerrain {
  const group = new Group()
  group.name = 'canyon-terrain'

  const geometries: BufferGeometry[] = []
  const materials: MeshStandardMaterial[] = []
  let meshCount = 0
  let shadowCasters = 0
  let triangles = 0
  let instances = 0

  const lapLength = track.length
  const stationCount = Math.max(48, Math.round(lapLength / STATION_SPACING))
  const spacing = lapLength / stationCount

  // -------------------------------------------------------------------------
  // Textures. ONE set, shared by every rock material in the file.
  //
  // `makeRockSurface` ships with `repeat` at (2, 2) because its usual callers
  // hand it UVs in 0..1. Every UV in this file is already in world metres over a
  // fixed divisor, so the repeat is reset to 1 and the tiling rate is chosen per
  // mesh by the divisor instead. That is also what lets one texture serve the
  // walls, the apron, the boulders and the mesas — a shared texture cannot carry
  // two different repeats, but it can carry two different UV scales.
  // -------------------------------------------------------------------------
  const texSize = Math.min(
    ctx.quality.maxTextureSize,
    ctx.quality.tier === 'low' ? 256 : ctx.quality.tier === 'medium' ? 512 : 1024,
  )
  const rock = makeRockSurface(texSize, ctx.rngFor('world/terrain/rock-texture'), ctx.quality.maxAnisotropy)
  rock.map.repeat.set(1, 1)
  rock.roughnessMap.repeat.set(1, 1)

  const fieldRng = ctx.rngFor('world/terrain/fields')
  /*
   * The four envelope fields come from `wall-profile.ts` rather than being
   * forked here, so that the barrier `world/track.ts` reports and the rock this
   * file sweeps are driven by the SAME field objects, not by two independently
   * forked copies that happen to agree. The fork names are unchanged, so every
   * vertex this file has ever produced is bit-identical.
   */
  const wallNoise = createWallNoise(ctx)
  const fields: Fields = {
    crestLow: wallNoise.crestLow,
    crestHigh: wallNoise.crestHigh,
    notch: wallNoise.notch,
    bandThickness: createNoise2D(fieldRng.fork('band-thickness')),
    seamThickness: createNoise2D(fieldRng.fork('seam-thickness')),
    setback: wallNoise.setback,
    erode: createNoise3D(fieldRng.fork('erode')),
    mottle: createNoise3D(fieldRng.fork('mottle')),
    varnish: createNoise3D(fieldRng.fork('varnish')),
    capRun: createNoise2D(fieldRng.fork('cap-run')),
  }

  // -------------------------------------------------------------------------
  // Stations. `stationCount + 1` of them, where the last is bit-identical to the
  // first (t = 0 for both) so the swept surface closes with no seam. That is
  // only true because every field feeding the profile is periodic in t and none
  // of them draws from an RNG.
  // -------------------------------------------------------------------------
  const stations = sampleStations(track, stationCount, spacing, lapLength, fields)

  // Circuit centroid and vertical datum, needed by the dip and the mesa field.
  let cx = 0
  let cz = 0
  let minY = Infinity
  let maxR = 0
  for (let i = 0; i < stationCount; i++) {
    const s = stations[i]!
    cx += s.px
    cz += s.pz
    if (s.py < minY) minY = s.py
  }
  cx /= stationCount
  cz /= stationCount
  for (let i = 0; i < stationCount; i++) {
    const s = stations[i]!
    maxR = Math.max(maxR, Math.hypot(s.px - cx, s.pz - cz))
  }
  const floorY = minY - 3

  applyDip(stations, cx, cz)
  computeCorridorReach(stations, stationCount)
  const profileStats = buildProfiles(stations, fields, lapLength, floorY)

  // -------------------------------------------------------------------------
  // Materials
  // -------------------------------------------------------------------------
  /*
   * ROUGHNESS, AND WHY ONE OF THESE IS NOT 1.0.
   *
   * `roughnessMap` multiplies `material.roughness`. `makeRockSurface` writes
   * absolute values into that map spanning roughly 0.62–0.88, which is exactly
   * the §5a rock range, so the soft material takes 1.0 and gets the range
   * unmodified.
   *
   * The hard material trims to 0.82, giving 0.51–0.72. That is deliberate and it
   * is the §5a "desert varnish patches (0.55)" and "wind-polished caprock" end of
   * the range, which the map alone cannot reach. A 12% trim is a material
   * distinction; the failure this project already paid for was a 0.12 fallback,
   * an 8x crush that made two rounds of noise tuning invisible. Stating the
   * resulting range is the difference between the two.
   */
  const rockSoft = new MeshStandardMaterial({
    map: rock.map,
    roughnessMap: rock.roughnessMap,
    roughness: 1.0,
    metalness: 0.0, // §5c: there is no metal in this landscape.
    vertexColors: true,
  })
  const rockHard = new MeshStandardMaterial({
    map: rock.map,
    roughnessMap: rock.roughnessMap,
    roughness: 0.82,
    metalness: 0.0,
    vertexColors: true,
  })
  const apronMat = new MeshStandardMaterial({
    map: rock.map,
    roughnessMap: rock.roughnessMap,
    roughness: 1.0,
    metalness: 0.0,
    vertexColors: true,
  })
  const boulderMat = new MeshStandardMaterial({
    map: rock.map,
    roughnessMap: rock.roughnessMap,
    roughness: 1.0,
    metalness: 0.0,
    vertexColors: true,
  })
  const mesaMat = new MeshStandardMaterial({
    map: rock.map,
    roughnessMap: rock.roughnessMap,
    roughness: 1.0,
    metalness: 0.0,
    vertexColors: true,
    // §2: distant mesa albedo is NOT pre-darkened toward the haze. The fog does
    // it. Pre-tinting rock toward grey is the amateur version and it produces
    // dead colour that no grade recovers.
    fog: true,
  })
  const sageMat = new MeshStandardMaterial({
    color: C_SAGE,
    roughness: 0.92,
    metalness: 0.0,
    side: DoubleSide,
  })
  const brushMat = new MeshStandardMaterial({
    color: C_DRY_BRUSH,
    roughness: 0.95,
    metalness: 0.0,
    side: DoubleSide,
  })
  materials.push(rockSoft, rockHard, apronMat, boulderMat, mesaMat, sageMat, brushMat)

  // -------------------------------------------------------------------------
  // Cliff walls — one mesh per (chunk, hardness).
  // -------------------------------------------------------------------------
  const uvU = Math.max(1, Math.round(lapLength / 8)) / lapLength

  for (let c = 0; c < CHUNKS; c++) {
    const i0 = Math.floor((c * stationCount) / CHUNKS)
    const i1 = Math.floor(((c + 1) * stationCount) / CHUNKS)
    const soft = new SurfaceBuilder()
    const hard = new SurfaceBuilder()

    for (let b = 0; b < BANDS.length; b++) {
      const band = BANDS[b]!
      const into = band.hard ? hard : soft
      for (let side = 0; side < 2; side++) {
        emitBandStrip(into, stations, i0, i1, side, b, uvU, fields)
      }
    }

    for (const [builder, mat] of [
      [soft, rockSoft],
      [hard, rockHard],
    ] as const) {
      const geo = builder.build()
      if (!geo) continue
      geometries.push(geo)
      const mesh = new Mesh(geo, mat)
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.name = `canyon-wall-${c}-${mat === rockHard ? 'hard' : 'soft'}`
      group.add(mesh)
      meshCount++
      shadowCasters++
      triangles += builder.idx.length / 3
    }
  }

  // -------------------------------------------------------------------------
  // Shoulder apron — road edge to wall toe.
  // -------------------------------------------------------------------------
  if (options.apron !== false) {
    for (let c = 0; c < CHUNKS; c++) {
      const i0 = Math.floor((c * stationCount) / CHUNKS)
      const i1 = Math.floor(((c + 1) * stationCount) / CHUNKS)
      const builder = new SurfaceBuilder()
      for (let side = 0; side < 2; side++) {
        emitApronStrip(builder, stations, i0, i1, side, uvU, fields, lapLength)
      }
      const geo = builder.build()
      if (!geo) continue
      geometries.push(geo)
      const mesh = new Mesh(geo, apronMat)
      // Ground does not usefully cast onto anything the player sees, and every
      // caster is a second draw. It absolutely must RECEIVE — §1's 22% shadow
      // occupancy floor is measured on ground-plane pixels.
      mesh.castShadow = false
      mesh.receiveShadow = true
      mesh.name = `canyon-apron-${c}`
      group.add(mesh)
      meshCount++
      triangles += builder.idx.length / 3
    }
  }

  // -------------------------------------------------------------------------
  // Scatter — §5c talus boulders, §1 Trap 3 pebbles, §3a vegetation.
  // -------------------------------------------------------------------------
  /*
   * The geometries are built BEFORE the placements, and that ordering is the
   * fix for the boulders-on-the-road defect rather than an aesthetic choice.
   * A placement is only legal relative to how big the thing being placed is,
   * and the only honest source for that is the geometry's own bounding sphere.
   * Placing first and measuring later is what produced "0 intrusions inside
   * halfWidth" over a screenshot with rocks on the racing line.
   */
  const lodSplit = Math.min(60, ctx.quality.lodDistance)

  const boulderRng = ctx.rngFor('world/terrain/boulder-shapes')
  const boulderGeos: BufferGeometry[] = []
  for (let s = 0; s < 3; s++) {
    // Three shapes, two LODs. §9 puts the LOD break at 60 m; the split is
    // resolved ONCE at build time from each instance's distance to the racing
    // line, which is a static quantity, so there is no per-frame LOD cost and no
    // popping. A camera-relative LOD would need a per-frame pass over ~6000
    // instances to save triangles this budget does not need saved.
    boulderGeos.push(makeRockChunk(boulderRng.fork(`hi-${s}`), 1, 0.3))
    boulderGeos.push(makeRockChunk(boulderRng.fork(`lo-${s}`), 0, 0.42))
  }
  const pebbleGeos: BufferGeometry[] = [
    makeRockChunk(boulderRng.fork('pebble-a'), 0, 0.36),
    makeRockChunk(boulderRng.fork('pebble-b'), 0, 0.5),
  ]
  const tuftRng = ctx.rngFor('world/terrain/vegetation')
  const sageGeo = makeTuftGeometry(tuftRng.fork('sage'), 7, 0.62, 0.5)
  const brushGeo = makeTuftGeometry(tuftRng.fork('brush'), 5, 0.9, 0.85)
  geometries.push(...boulderGeos, ...pebbleGeos, sageGeo, brushGeo)

  const scatter = buildScatter(ctx, stations, stationCount, spacing, options.scatterDensity ?? 1, {
    boulder: maxBoundingRadius(boulderGeos),
    pebble: maxBoundingRadius(pebbleGeos),
    plant: maxBoundingRadius([sageGeo, brushGeo]),
  })

  const boulderBuckets: Matrix4[][] = [[], [], [], [], [], []]
  for (const b of scatter.boulders) {
    /*
     * LOD ON SIZE AS WELL AS DISTANCE.
     *
     * §9 puts the break at 60 m, and distance alone put 1 300 boulders on the
     * 80-triangle shape — 105 k triangles, half this subsystem's entire budget,
     * spent on scree. Apparent size is what LOD is actually about, and a 0.5 m
     * rock at 20 m subtends less than a 2 m rock at 60 m. Requiring BOTH near
     * and large drops that to about 55 k with nothing visibly different, because
     * the extra 60 triangles were never resolvable on the small ones.
     */
    const lod = b.distanceToLine < lodSplit && b.size > 0.85 ? 0 : 1
    boulderBuckets[b.shape * 2 + lod]!.push(b.matrix)
  }
  for (let k = 0; k < boulderBuckets.length; k++) {
    const mats = boulderBuckets[k]!
    if (mats.length === 0) continue
    const geo = boulderGeos[k]!
    const mesh = makeInstanced(geo, boulderMat, mats)
    // Only the near LOD casts. A 0.4 m boulder at 90 m contributes a shadow
    // smaller than one shadow texel at this cascade's density; drawing it into
    // the shadow map costs a full extra pass over 3000 instances and produces
    // nothing measurable.
    mesh.castShadow = k % 2 === 0
    mesh.receiveShadow = true
    mesh.name = `canyon-boulder-${k}`
    group.add(mesh)
    meshCount++
    if (mesh.castShadow) shadowCasters++
    instances += mats.length
    triangles += triCount(geo) * mats.length
  }

  const pebbleBuckets: Matrix4[][] = [[], []]
  for (const p of scatter.pebbles) pebbleBuckets[p.shape]!.push(p.matrix)
  for (let k = 0; k < pebbleBuckets.length; k++) {
    const mats = pebbleBuckets[k]!
    if (mats.length === 0) continue
    const geo = pebbleGeos[k]!
    const mesh = makeInstanced(geo, boulderMat, mats)
    mesh.castShadow = false
    mesh.receiveShadow = true
    mesh.name = `canyon-pebble-${k}`
    group.add(mesh)
    meshCount++
    instances += mats.length
    triangles += triCount(geo) * mats.length
  }

  for (const [kind, geo, mat] of [
    ['sage', sageGeo, sageMat],
    ['brush', brushGeo, brushMat],
  ] as const) {
    const mats = scatter.plants.filter((p) => p.kind === (kind === 'sage' ? 0 : 1)).map((p) => p.matrix)
    if (mats.length === 0) continue
    const mesh = makeInstanced(geo, mat, mats)
    // Vegetation casts. At a 12° sun a 0.7 m shrub throws 3.3 m of hard shadow
    // across bright sand — this is some of the cheapest shadow occupancy on the
    // lap and §1's 22% floor needs every bit of it.
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.name = `canyon-${kind}`
    group.add(mesh)
    meshCount++
    shadowCasters++
    instances += mats.length
    triangles += triCount(geo) * mats.length
  }

  // -------------------------------------------------------------------------
  // Distant mesa layers — §1 Trap 4, §10b criterion 5.
  // -------------------------------------------------------------------------
  const mesaField = buildMesaField(ctx.rngFor('world/terrain/mesas'), cx, cz, floorY, maxR)
  for (let l = 0; l < mesaField.layerGeometries.length; l++) {
    const geo = mesaField.layerGeometries[l]!
    geometries.push(geo)
    const mesh = new Mesh(geo, mesaMat)
    // Nothing beyond 250 m is inside a useful shadow cascade and nothing behind
    // these receives anything. Both flags off; six free meshes.
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.name = `canyon-mesa-layer-${l}`
    group.add(mesh)
    meshCount++
    triangles += triCount(geo)
  }

  const stats: TerrainStats = {
    meshes: meshCount,
    shadowCasters,
    drawCallsWorstCase: meshCount + shadowCasters,
    triangles: Math.round(triangles),
    instances,
    stations: stationCount,
    scatterRejected: scatter.rejected,
    profilesCompressed: profileStats.compressedProfiles,
    worstProfileSqueeze: profileStats.worstSqueeze,
    corridorConflicts: profileStats.corridorConflicts,
  }

  /*
   * The stats, hung where something can actually read them.
   *
   * `buildCanyonTerrain` returns them, and today nothing in `main.ts` looks at
   * the return value, so `scatterRejected` and the corridor counters would be a
   * gate that quietly covers nothing — the failure mode CLAUDE.md names about
   * `energy-check`'s PENDING rows. `userData` on the group is a channel any
   * harness already holding `HarnessAPI.scene` can read, costs nothing per
   * frame, and widens no contract.
   */
  group.userData.terrainStats = stats

  ctx.scene.add(group)

  return {
    group,
    stats,
    mesaAudit: mesaField.audit,
    dispose(): void {
      group.removeFromParent()
      group.clear()
      for (const g of geometries) g.dispose()
      for (const m of materials) m.dispose()
      rock.map.dispose()
      rock.roughnessMap.dispose()
    },
  }
}

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

function sampleStations(
  track: ITrack,
  stationCount: number,
  spacing: number,
  lapLength: number,
  fields: Fields,
): Station[] {
  const sample: TrackSample = {
    position: new Vector3(),
    tangent: new Vector3(),
    normal: new Vector3(),
    right: new Vector3(),
    halfWidth: 0,
    bank: 0,
    curvature: 0,
  }
  const resolved: ResolvedSection = makeResolvedSection()
  const profile = makeWallProfilePoint()

  const seamV = new Vector3()
  const out: Station[] = []
  for (let i = 0; i <= stationCount; i++) {
    // The wrap is what closes the lap: station `stationCount` samples t = 0.
    const t = (i % stationCount) / stationCount
    track.sample(t, sample)
    resolveSection(t, sample.curvature, sample.bank, resolved)

    /*
     * Walls stand on world up, not on the road normal.
     *
     * Through The Wall the road banks 20°, and a wall swept along the banked
     * normal would lean 20° with it — a canyon that tips over when the road
     * does. Only the road banks. `right` is therefore flattened into the
     * horizontal plane and renormalised; §1 caps the gradient at 11%, so this
     * can never be a degenerate projection.
     */
    let rx = sample.right.x
    let rz = sample.right.z
    const rl = Math.hypot(rx, rz)
    if (rl > 1e-6) {
      rx /= rl
      rz /= rl
    } else {
      rx = 1
      rz = 0
    }

    const halfWidth = sample.halfWidth
    const wallH: [number, number] = [0, 0]
    const toeU: [number, number] = [0, 0]
    const faceBaseU: [number, number] = [0, 0]
    const faceTopU: [number, number] = [0, 0]
    const talusH: [number, number] = [0, 0]
    const seam: [[number, number, number], [number, number, number]] = [
      [0, 0, 0],
      [0, 0, 0],
    ]
    const edge: [[number, number, number], [number, number, number]] = [
      [0, 0, 0],
      [0, 0, 0],
    ]
    const seamTuck: [number, number] = [0, 0]
    const baseY: [number, number] = [0, 0]

    for (let side = 0; side < 2; side++) {
      /*
       * The crest noise, the setback jitter, the 32° talus run and the
       * `minToe` clamp used to be forty lines here. They are now one call, and
       * `ITrack.wallLimit` makes the identical one. That is the point: the
       * barrier a kart hits is not "derived the same way" as this rock, it is
       * the same arithmetic on the same fields.
       */
      wallProfileAt(t, lapLength, halfWidth, resolved, side as 0 | 1, fields, profile)
      wallH[side] = profile.height
      talusH[side] = profile.talusHeight
      toeU[side] = profile.toe
      faceBaseU[side] = profile.faceBase
      faceTopU[side] = Math.max(0.8, profile.faceBase * resolved.topScale[side]!)

      // The seam, taken whole from its owner. `spacing` is this module's
      // station spacing and is the only input road.ts cannot already see; it is
      // what sizes the corner term in the overlap.
      const s = side === 0 ? -1 : 1
      // The road edge height on this side: what the ground here stands on.
      baseY[side] = sample.position.y + sample.right.y * s * halfWidth
      const tuck = roadEdgeTuck(sample, spacing)
      seamTuck[side] = tuck
      roadEdgePoint(sample, s, tuck, seamV)
      seam[side] = [seamV.x, seamV.y, seamV.z]
      roadEdgePoint(sample, s, 0, seamV)
      edge[side] = [seamV.x, seamV.y, seamV.z]
    }

    out.push({
      t,
      arc: i * spacing,
      px: sample.position.x,
      py: sample.position.y,
      pz: sample.position.z,
      rx,
      rz,
      baseY,
      rightY: sample.right.y,
      rightXZ: Math.max(1e-3, Math.hypot(sample.right.x, sample.right.z)),
      halfWidth,
      racingLine: track.racingLine(t),
      wallH,
      toeU,
      faceBaseU,
      faceTopU,
      talusH,
      sand: [resolved.sand[0]!, resolved.sand[1]!],
      seam,
      edge,
      seamTuck,
      facePower: resolved.facePower,
      backGrade: resolved.backGrade,
      dip: 0,
      reachU: [Infinity, Infinity],
      rowU: [new Float64Array(ROWS_TOTAL), new Float64Array(ROWS_TOTAL)],
      rowH: [new Float64Array(ROWS_TOTAL), new Float64Array(ROWS_TOTAL)],
      rowV: [new Float64Array(ROWS_TOTAL), new Float64Array(ROWS_TOTAL)],
    })
  }
  return out
}

/**
 * §5c: a global 2.4° dip. Computed from world XZ about the circuit centroid, so
 * it is one plane across the whole map rather than a per-section fudge, and so
 * two walls facing each other across the gorge show the SAME bed at the same
 * height. Clamped later, per station, against the local face height.
 */
function applyDip(stations: Station[], cx: number, cz: number): void {
  const dx = Math.cos(DIP_AZIMUTH)
  const dz = Math.sin(DIP_AZIMUTH)
  for (const s of stations) {
    const d = (s.px - cx) * dx + (s.pz - cz) * dz
    s.dip = d * DIP_SLOPE
  }
}

/**
 * How far each station's cross-section may reach outward before it arrives over
 * a DIFFERENT part of the lap.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, AND WHY NOTHING ELSE IN THE FILE COULD HAVE CAUGHT IT.
 *
 * Every clearance rule above this line is written in ONE station's frame:
 * `minToe`, `legalInner`, `corridorMinU`. They are all correct, and they are all
 * blind to the same thing — the profile keeps going outward long after it has
 * left the neighbourhood the station knows about. `faceTopU` is
 * `(halfWidth + setback) * topScale`, and at the mesa climb that is
 * (12.4 + 50) * 2.1 = 131 m; the cap adds up to 7 m and the hinterland
 * `backGrade` run adds up to 70 more. The cross-section is 205 m wide.
 *
 * Vermilion Nine folds back on itself. Measured on the built circuit, the road
 * at t = 0.55 passes within 131.5 m of the road at t = 0.70, thirteen metres
 * below it. So the mesa climb's hinterland was laid straight over the wash
 * descent — 466 m² of it inside the corridor, 5.7 m above the road surface at
 * the centreline. From a kart that is a mountain you drive into and then drive
 * around inside, which is exactly what the player reported. No screenshot from
 * any §11 vantage shows it, because the vantages look along the road and this
 * is a roof.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IS MEASURED. For each station and side, the horizontal ray the profile
 * is swept along, tested against every station's corridor disc of radius
 * `halfWidth + BARRIER_MARGIN + CORRIDOR_CLEARANCE`. The union of the hit
 * intervals is merged; the component containing u = 0 is this station's OWN
 * corridor and is skipped; the start of the next interval is the answer.
 * `Infinity` where the ray never meets the circuit again — 361 of 722 rays.
 *
 * THE TEST IS PURELY 2D, AND THAT IS DELIBERATE. Height is not a defence here.
 * Terrain that passes 20 m above the road reads as a tunnel the player did not
 * expect; terrain that passes 20 m below is invisible but leaves the road on a
 * shelf with a hole beside it. Neither is something this file should produce by
 * accident at a place §1 never asked for a tunnel, and the only two places §1
 * DOES ask for one — The Slot and the arch — are a single station's own
 * cross-section closing over itself, which `corridorMinU` governs and this does
 * not touch.
 */
function computeCorridorReach(stations: Station[], stationCount: number): void {
  // Scratch, reused across every ray: this runs 722 times over 361 stations and
  // allocating an interval array per ray is 260 000 short-lived objects.
  const iv: number[] = []
  for (let i = 0; i < stationCount; i++) {
    const a = stations[i]!
    for (let side = 0; side < 2; side++) {
      const sg = side === 0 ? -1 : 1
      const dx = a.rx * sg
      const dz = a.rz * sg
      iv.length = 0
      for (let j = 0; j < stationCount; j++) {
        const b = stations[j]!
        const r = b.halfWidth + BARRIER_MARGIN + CORRIDOR_CLEARANCE
        const ox = a.px - b.px
        const oz = a.pz - b.pz
        // Ray-circle: |o + u*d|^2 = r^2 with |d| = 1.
        const p = ox * dx + oz * dz
        const disc = p * p - (ox * ox + oz * oz - r * r)
        if (disc <= 0) continue
        const s = Math.sqrt(disc)
        const u1 = -p + s
        if (u1 <= 0) continue
        iv.push(Math.max(0, -p - s), u1)
      }
      // Sort the intervals by entry, merge, and walk out from u = 0. Sorting a
      // flat pair array by hand keeps this allocation-free.
      const n = iv.length / 2
      for (let x = 1; x < n; x++) {
        const e0 = iv[x * 2]!
        const e1 = iv[x * 2 + 1]!
        let y = x - 1
        while (y >= 0 && iv[y * 2]! > e0) {
          iv[(y + 1) * 2] = iv[y * 2]!
          iv[(y + 1) * 2 + 1] = iv[y * 2 + 1]!
          y--
        }
        iv[(y + 1) * 2] = e0
        iv[(y + 1) * 2 + 1] = e1
      }
      let own = a.halfWidth + BARRIER_MARGIN + CORRIDOR_CLEARANCE
      let reach = Infinity
      let curLo = -1
      let curHi = -1
      for (let x = 0; x < n; x++) {
        const lo = iv[x * 2]!
        const hi = iv[x * 2 + 1]!
        if (curLo < 0) {
          curLo = lo
          curHi = hi
          continue
        }
        if (lo <= curHi) {
          if (hi > curHi) curHi = hi
          continue
        }
        // `curLo..curHi` is closed. Either it is the station's own corridor or
        // it is the first thing the profile must not reach.
        if (curLo <= 0) own = Math.max(own, curHi)
        else if (curLo > own) {
          reach = curLo
          break
        }
        curLo = lo
        curHi = hi
      }
      if (reach === Infinity && curLo >= 0) {
        if (curLo <= 0) own = Math.max(own, curHi)
        else if (curLo > own) reach = curLo
      }
      a.reachU[side] = reach
    }
  }
  // The wrap station is a duplicate of station 0 and must carry its limits, or
  // the last quad of the lap is swept against `Infinity` and the seam opens.
  const last = stations[stationCount]
  if (last) {
    last.reachU[0] = stations[0]!.reachU[0]!
    last.reachU[1] = stations[0]!.reachU[1]!
  }
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/**
 * Fill every station's row tables.
 *
 * Rows are laid out bottom to top in a fixed order that never changes shape:
 * band `b` owns rows `[BAND_ROW_OFFSET[b], +BANDS[b].rows)`. Two consecutive
 * bands therefore hold two rows at the same (u, h) — that duplication is the
 * hard strata edge, and it is also why every band strip is a regular grid that
 * can be swept without any per-station branching.
 */
function buildProfiles(
  stations: Station[],
  fields: Fields,
  lapLength: number,
  floorY: number,
): ProfileStats {
  let compressed = 0
  let worstSqueeze = 1
  let corridorConflicts = 0
  for (const st of stations) {
    for (let side = 0; side < 2; side++) {
      const u = st.rowU[side]!
      const h = st.rowH[side]!
      const v = st.rowV[side]!
      const phase = side === 0 ? 0 : 0.5
      const sideW = side === 0 ? 0 : 37.1

      const wallH = st.wallH[side]!
      const talusH = st.talusH[side]!
      const toeU = st.toeU[side]!
      const faceBase = st.faceBaseU[side]!
      const faceTop = st.faceTopU[side]!
      const faceH = Math.max(0.25, wallH - talusH)

      // --- band boundary fractions of the exposed face ----------------------
      /*
       * §5c: band thickness driven by 1D noise so no two vertical cross-sections
       * match. Each boundary gets its own wavelength so they do not move in
       * lockstep — three boundaries riding one field is a stack that breathes
       * rather than a stack that shuffles.
       */
      const dipF = clamp(st.dip / faceH, -DIP_CLAMP_FRACTION, DIP_CLAMP_FRACTION)
      const nb = (wl: number, ph: number): number =>
        ringNoise2(fields.bandThickness, st.t + ph, lapLength, wl)

      const oxT = lerp(OXIDE_MIN, OXIDE_MAX, 0.5 + 0.5 * ringNoise2(fields.seamThickness, st.t + phase, lapLength, 63))
      const gypT = lerp(0.9, 1.6, 0.5 + 0.5 * ringNoise2(fields.seamThickness, st.t + phase + 0.31, lapLength, 41))

      let f1 = 0.13 + nb(88, phase) * 0.035 + dipF // basal shale top
      let f2 = f1 + oxT / faceH // iron oxide top
      let f3 = 0.3 + nb(52, phase + 0.13) * 0.05 + dipF // lower strata top
      let f4 = GYPSUM_CENTRE + dipF - gypT / (2 * faceH) // gypsum bottom
      let f5 = f4 + gypT / faceH // gypsum top
      let f6 = 0.8 + nb(37, phase + 0.27) * 0.05 + dipF // upper strata top

      /*
       * Monotonic guard, top down. Every clamp above can collide when the face
       * is short (a 2 m dune berm still runs all seven bands), and an
       * out-of-order boundary is an inverted band — geometry that folds through
       * itself and shades as a black wedge. Squeezing from the top preserves the
       * gypsum seam's position for as long as anything can be preserved, which
       * is the §1 priority.
       */
      f6 = Math.min(f6, 0.97)
      f5 = Math.min(f5, f6 - 0.006)
      f4 = Math.min(f4, f5 - 0.006)
      f3 = Math.min(f3, f4 - 0.008)
      f2 = Math.min(f2, f3 - 0.008)
      f1 = Math.min(f1, f2 - 0.004)
      f1 = Math.max(f1, 0.004)
      f2 = Math.max(f2, f1 + 0.004)
      f3 = Math.max(f3, f2 + 0.006)
      f4 = Math.max(f4, f3 + 0.006)
      f5 = Math.max(f5, f4 + 0.005)
      f6 = Math.max(f6, f5 + 0.008)
      f6 = Math.min(f6, 0.985)

      const bandFrac: number[] = [0, f1, f2, f3, f4, f5, f6, 1]

      // --- erosion ----------------------------------------------------------
      /*
       * §5c: a 3-octave ridged field carving gullies at 1.2–4.0 m spacing on
       * faces steeper than 55°.
       *
       * The vertical frequency is deliberately ten times lower than the
       * horizontal one. That is what makes a gully a gully: it has to run DOWN
       * the face coherently. Equal frequencies give a lumpy field that reads as
       * noise applied to a wall rather than as water having been there.
       */
      const eroAmp = clamp(faceH * 0.075, 0.2, 2.4)
      const erosionAt = (phi: number): number => {
        const y = phi * faceH
        const g1 = ridged3(fields.erode, st.t, lapLength, 2.6, y * 0.038 + sideW)
        const g2 = ridged3(fields.erode, st.t, lapLength, 7.5, y * 0.022 + sideW + 11)
        const g3 = ridged3(fields.erode, st.t, lapLength, 19, y * 0.014 + sideW + 23)
        return (g1 * 0.5 + g2 * 0.32 + g3 * 0.18 - 0.62) * eroAmp * 2
      }

      const biasScale = clamp(faceH / 12, 0.35, 1.6)
      const faceU = (phi: number, band: number): number => {
        const spec = BANDS[band]!
        const lo = bandFrac[band - 1]!
        const hi = bandFrac[band]!
        // Ramped with a half sine so the band is proud or recessed at its
        // mid-height and flush at both edges. A raw step would leave a hole
        // where the ledge should be — there is no geometry between two rows at
        // the same height and different offsets.
        const local = hi > lo ? (phi - lo) / (hi - lo) : 0
        // A band cannot weather back further than it is thick, or the seam turns
        // into a slot and the lip above it into a shelf. The 0.4 m band gets
        // 0.4 m of relief at most, whatever `biasScale` says.
        const thickness = (hi - lo) * faceH
        const bias =
          spec.bias * Math.sin(Math.PI * clamp(local, 0, 1)) * biasScale * Math.min(1, thickness / 1.5)
        const raw = faceBase + (faceTop - faceBase) * Math.pow(phi, st.facePower) + bias + erosionAt(phi)
        /*
         * THE CORRIDOR BOUND GOES HERE, NOT UPSTREAM, AND THAT IS THE POINT.
         *
         * `minToe` clamps where the talus starts, and it is correct. Then this
         * expression adds two signed terms to `faceBase` — a weathering `bias`
         * and a SIGNED erosion field — and both can be negative. At the
         * amplitudes §5c asks for, `erosionAt` reaches about -1.2 * eroAmp,
         * which on a 25 m face is 2.3 m of inward displacement applied after
         * every clearance decision in this file had already been made. The lap
         * sweep found it as 0.60 m of basal shale inside the barrier line at
         * t = 0.366 and 0.72 m of upper strata at t = 0.975: small, at ride
         * height, and on the racing line.
         *
         * That is the third time this project has shipped a guard that was
         * right and applied at the wrong point in the pipeline. The bound is
         * therefore evaluated on the RESULT, at the height the row actually
         * sits at, so nothing downstream of it can move the geometry.
         */
        return Math.max(raw, corridorMinU(talusH + phi * faceH, st.halfWidth))
      }

      // --- talus ------------------------------------------------------------
      /*
       * THE TALUS RUNS TO WHERE THE FACE ACTUALLY STARTS, NOT TO `faceBase`.
       *
       * `faceU(0, 1)` is `faceBase` PLUS `erosionAt(0)`, and erosion is signed:
       * where it is positive the face's bottom row sits outboard of `faceBase`.
       * Laying the talus to `faceBase` then left a horizontal strip between the
       * top of the scree and the foot of the cliff with no geometry in it at
       * all — a slot up to 1.8 m wide running the length of the wall, open to
       * the sky above and to nothing below. That is the hole.
       *
       * It was not visible in `emitBandStrip`, because each band closes against
       * its own neighbours correctly; the only junction in the whole profile
       * between two DIFFERENT generators is this one, and it was the only one
       * nobody joined. Measured by tools/seam-check.mjs as 1283 downward rays
       * that hit nothing whatsoever.
       *
       * Solving it the other way — forcing erosion to zero at phi = 0 — would
       * flatten the base of every gully into the cliff and is a visible loss.
       * The talus following the face costs nothing.
       */
      const faceRoot = faceU(0, 1)
      const talusEnd = Math.max(toeU + 0.2, faceRoot)
      const talusRunEff = talusEnd - toeU
      const tRows = BANDS[BAND_TALUS]!.rows
      const tOff = BAND_ROW_OFFSET[BAND_TALUS]!
      for (let r = 0; r < tRows; r++) {
        const f = r / (tRows - 1)
        // Repose slopes are slightly concave; the exponent is what stops a scree
        // cone reading as a ramp.
        const jitter = ringNoise2(fields.setback, st.t + phase + f * 0.7, lapLength, 26)
        // The jitter is windowed to zero at BOTH ends: row 0 has to be exactly
        // `toeU` for the apron to meet it, and the last row has to be exactly
        // `faceRoot` for the cliff to meet it. `1 - |2f - 1|` is that window.
        u[tOff + r] = toeU + talusRunEff * f + jitter * 0.35 * (1 - Math.abs(2 * f - 1))
        h[tOff + r] = talusH * Math.pow(f, 1.35)
      }

      // --- rock bands -------------------------------------------------------
      for (let b = 1; b <= 7; b++) {
        const spec = BANDS[b]!
        const off = BAND_ROW_OFFSET[b]!
        const lo = bandFrac[b - 1]!
        const hi = bandFrac[b]!
        for (let r = 0; r < spec.rows; r++) {
          const phi = lerp(lo, hi, r / (spec.rows - 1))
          u[off + r] = faceU(phi, b)
          h[off + r] = talusH + phi * faceH
        }
      }

      // --- cap top ----------------------------------------------------------
      /*
       * A crest that ends at the face is a paper edge: from below you see a
       * one-pixel line, from a vantage you see through it. The cap runs outward
       * and slightly up before falling away, which also gives the only
       * near-horizontal rock in the section — a sun-facing horizontal surface at
       * a 12° sun is dim, and having one is part of not being uniform.
       */
      const crestU = u[BAND_ROW_OFFSET[7]! + BANDS[7]!.rows - 1]!
      const capRun = 2.5 + (0.5 + 0.5 * ringNoise2(fields.capRun, st.t + phase, lapLength, 31)) * 4.5
      const capRise = ringNoise2(fields.capRun, st.t + phase + 0.5, lapLength, 19) * 0.7
      const capDrop = 0.4 + (0.5 + 0.5 * ringNoise2(fields.capRun, st.t + phase + 0.2, lapLength, 44)) * 1.4
      const cOff = BAND_ROW_OFFSET[BAND_CAP_TOP]!
      u[cOff] = crestU
      h[cOff] = wallH
      u[cOff + 1] = crestU + capRun * 0.45
      h[cOff + 1] = wallH + capRise
      u[cOff + 2] = crestU + capRun
      h[cOff + 2] = wallH - capDrop

      // --- backslope --------------------------------------------------------
      /*
       * The hinterland behind the crest. Without it, a vantage above the crest —
       * which is the entire point of `mesa-crest` — looks over the wall into a
       * void where the world ends, with the distant mesa layers floating in it.
       *
       * The run is solved from how far there is to fall, then capped at 70 m.
       * The cap is what keeps opposite sides of a tight section from ploughing
       * deep into each other; where they do still meet, rock intersecting rock
       * is a ridge, not an artefact.
       */
      const drop = wallH - capDrop - (floorY + 1 - st.baseY[side]!)
      const run = clamp(drop / Math.max(0.05, st.backGrade), 20, 70)
      const totalDrop = run * st.backGrade
      const bOff = BAND_ROW_OFFSET[BAND_BACKSLOPE]!
      const bRows = BANDS[BAND_BACKSLOPE]!.rows
      for (let r = 0; r < bRows; r++) {
        const f = r / (bRows - 1)
        const wob = ringNoise2(fields.crestHigh, st.t + phase + f * 1.3, lapLength, 60)
        u[bOff + r] = u[cOff + 2]! + run * f
        h[bOff + r] = h[cOff + 2]! - totalDrop * Math.pow(f, 1.25) + wob * 2.2 * f
      }

      // --- corridor reach: squeeze, never clip -------------------------------
      /*
       * Everything outboard of the face base is scaled toward the face base
       * until the whole cross-section fits inside `reachU`.
       *
       * COMPRESSED RATHER THAN TRUNCATED, for two reasons that are not taste.
       * Truncating leaves the outermost rows stacked at one offset — a vertical
       * shear tens of metres high standing over the road it was cut away from,
       * and `computeVertexNormals` on the resulting sliver quads is a coin
       * flip. Compressing keeps the profile monotonic in `u`, keeps every band
       * boundary, the cap and the hinterland in the same order at the same
       * heights, and simply makes the section steeper — the crest still exists,
       * the backslope still closes against the floor.
       *
       * AND IT CANNOT OPEN A VOID. The thing that bounds the reach is a road,
       * and a road brings its own cross-section: where the mesa climb is
       * squeezed from 205 m to 131 m, the wash descent's own hinterland already
       * covers from 34 m to 146 m in the same frame. The backslope band exists
       * to stop a vantage above the crest looking into nothing — that argument
       * is unaffected here, because the ground on the far side of the cut is
       * another section's ground rather than nothing.
       *
       * The talus and the road-side face base are NOT scaled. They are governed
       * by `minToe` and `corridorMinU`, and a squeeze that moved them would be
       * one clearance rule quietly overwriting another.
       */
      const reach = st.reachU[side]!
      if (Number.isFinite(reach)) {
        const outer = u[ROWS_TOTAL - 1]!
        if (outer > reach) {
          const room = reach - faceBase
          if (room <= 0.5) {
            /*
             * The face base itself is inside another part of the lap's
             * corridor. Nothing in this file can resolve that — it is a track
             * layout that passes closer to itself than one section's setback —
             * so it is clamped hard and COUNTED, in the same spirit as
             * `scatterRejected`. A silent clamp here would hide a genuine
             * layout conflict behind a plausible-looking wall.
             */
            corridorConflicts++
            for (let r = 0; r < ROWS_TOTAL; r++) if (u[r]! > reach) u[r] = reach
          } else {
            const k = room / (outer - faceBase)
            compressed++
            if (k < worstSqueeze) worstSqueeze = k
            for (let r = 0; r < ROWS_TOTAL; r++) {
              if (u[r]! > faceBase) u[r] = faceBase + (u[r]! - faceBase) * k
            }
          }
        }
      }

      // --- texture V: distance travelled along the profile -------------------
      /*
       * v is arc length UP THE CROSS-SECTION, not world height.
       *
       * Using world height would compress the texture to nothing across the
       * talus and the cap, where the profile moves 6 m outward for 1 m upward —
       * §10b criterion 7 lists visible UV stretching as an amateur tell and this
       * is where it would appear. On a vertical face profile arc and height are
       * the same number, which is the case that matters: `makeRockSurface`
       * writes HORIZONTAL bedding into its own field, and it stays horizontal
       * because v runs up the section and u runs along the lap. That planar
       * projection is doing the job §5's triplanar mandate exists for — strata
       * cannot smear on an overhang when the coordinate that carries them is the
       * one the overhang is measured along.
       */
      let acc = 0
      let pu = u[0]!
      let ph = h[0]!
      for (let r = 0; r < ROWS_TOTAL; r++) {
        acc += Math.hypot(u[r]! - pu, h[r]! - ph)
        pu = u[r]!
        ph = h[r]!
        v[r] = acc / 8
      }
    }
  }
  return { compressedProfiles: compressed, worstSqueeze, corridorConflicts }
}

// ---------------------------------------------------------------------------
// Strip emission
// ---------------------------------------------------------------------------

const _c = new Color()
const _c2 = new Color()

function emitBandStrip(
  out: SurfaceBuilder,
  stations: Station[],
  i0: number,
  i1: number,
  side: number,
  band: number,
  uvU: number,
  fields: Fields,
): void {
  const spec = BANDS[band]!
  const rows = spec.rows
  const off = BAND_ROW_OFFSET[band]!
  const sign = side === 0 ? -1 : 1

  let prev: number[] | null = null
  for (let i = i0; i <= i1; i++) {
    const st = stations[i]!
    const ring: number[] = []
    for (let r = 0; r < rows; r++) {
      const u = st.rowU[side]![off + r]!
      const hh = st.rowH[side]![off + r]!
      const x = st.px + st.rx * sign * u
      const y = st.baseY[side]! + hh
      const z = st.pz + st.rz * sign * u
      bandColour(_c, st, side, band, r / Math.max(1, rows - 1), hh, x, y, z, fields)
      ring.push(out.vertex(x, y, z, st.arc * uvU, st.rowV[side]![off + r]!, _c))
    }
    if (prev) {
      for (let r = 0; r < rows - 1; r++) {
        const A = prev[r]!
        const B = ring[r]!
        const C = ring[r + 1]!
        const D = prev[r + 1]!
        /*
         * WINDING. With `A` at station i row r, `B` at station i+1 row r, `C` at
         * i+1 row r+1 and `D` at i row r+1, the triangle (A, B, C) has normal
         * `tangent × up`, which is `+right`. On the LEFT wall that faces the
         * road; on the RIGHT wall it faces away, so the right side reverses.
         * Both halves of the canyon then present their faces inward, and
         * `computeVertexNormals` — which reads exactly this winding — agrees.
         */
        if (sign < 0) out.quad(A, B, C, D)
        else out.quad(A, D, C, B)
      }
    }
    prev = ring
  }
}

/**
 * Vertex colour for one wall vertex.
 *
 * Six things stack here, and every one of them is a §9b or §10b line item:
 * the band's spec colour, a sand blend for shoulders that are no longer cliffs,
 * §3a desert varnish on steep faces, a wind-scour lightening on faces aligned to
 * the §1 wind azimuth, a contact darkening near the floor, and a low-amplitude
 * mottle so that even a facet whose normal never changes still has variance.
 */
function bandColour(
  out: Color,
  st: Station,
  side: number,
  band: number,
  localF: number,
  heightAboveRoad: number,
  x: number,
  y: number,
  z: number,
  fields: Fields,
): void {
  const spec = BANDS[band]!
  out.copy(spec.colour)

  // The cap is wind-polished and sees the most sky; lift it slightly so the
  // crest line separates from the face beneath it in silhouette.
  if (band === BAND_CAP_TOP) out.lerp(_c2.copy(C_SAND_COMPACT), 0.16)
  if (band === BAND_BACKSLOPE) out.lerp(_c2.copy(C_SCREE), 0.35 + localF * 0.35)

  /*
   * Where the wall has collapsed to a shoulder — §1's dune sweep outside, the
   * open sand either side of the mesa climb — the bands are still there
   * geometrically but they must not still be RED. `sand` drives the blend, and
   * it is also gated on absolute wall height so a 2 m berm reads as sand even in
   * a section whose table entry says rock.
   */
  const sandW = clamp(st.sand[side]! * smoothstep(9, 2, st.wallH[side]!) + (band === BAND_TALUS ? st.sand[side]! * 0.55 : 0), 0, 0.92)
  if (sandW > 0.001) out.lerp(_c2.copy(C_SAND_SUNLIT).lerp(C_SAND_COMPACT, 0.45), sandW)

  // §3a desert varnish: patches on near-vertical faces. Cheap, and it is the
  // single most effective break-up on a large rock face because it has a visible
  // cause — water has run down there.
  if (band >= 1 && band <= 7) {
    const vn = fields.varnish(x * 0.045, y * 0.11, z * 0.045)
    const varnish = smoothstep(0.35, 0.85, vn) * 0.55
    if (varnish > 0.001) out.lerp(_c2.copy(C_VARNISH), varnish)
  }

  /*
   * §5a wind scour: faces within 40° of azimuth 71°. §5a puts this on ROUGHNESS,
   * and roughness is exactly what a vertex colour cannot carry. It goes on
   * albedo instead — a polished face is slightly lighter and slightly less
   * saturated — and this is a knowing partial: the scour is visible but it is
   * not changing the specular response. Doing it properly needs a per-vertex
   * roughness attribute and an `onBeforeCompile`, which is the right follow-up
   * and is not worth an untestable shader patch today.
   */
  const faceAz = Math.atan2(st.rx * (side === 0 ? -1 : 1), st.rz * (side === 0 ? -1 : 1))
  const windAz = (71 * Math.PI) / 180
  let dAz = Math.abs(faceAz - windAz) % (Math.PI * 2)
  if (dAz > Math.PI) dAz = Math.PI * 2 - dAz
  const scour = smoothstep((40 * Math.PI) / 180, 0, dAz) * 0.14
  if (scour > 0.001) out.offsetHSL(0, -0.08 * scour, 0.06 * scour)

  // Contact darkening. §10b criterion 4 is grounding, and the cheapest half of
  // it is simply not having the wall meet the floor at full brightness.
  const contact = lerp(0.7, 1, smoothstep(0, 6, heightAboveRoad))

  // §9b insurance. Even a facet whose normal never varies gets ±5% here, which
  // puts a flat region three orders of magnitude above the 1e-5 unpainted gate
  // and comfortably above the 2e-3 flat-bright one.
  const mottle = 1 + fields.mottle(x * 0.09, y * 0.09, z * 0.09) * 0.05
  out.multiplyScalar(contact * mottle)
}

/**
 * The shoulder apron: the ONE surface between the road edge and the wall toe.
 *
 * It has exactly two neighbours and it is defined entirely by them, because a
 * surface that computes its own version of where its neighbours are is a
 * surface that will disagree with them:
 *
 *   row 0      `st.seam` — under the road, on the road's own banked frame,
 *              at whatever tuck `road.ts` asked for at this station.
 *   row 1      `st.edge` — the road edge itself, same plane. Rows 0-1 are the
 *              overlap; nothing between them is ever seen.
 *   rows 2..5  a straight run from the road edge to the talus toe, which is
 *              `(toeU, py)` — the SAME expression `emitBandStrip` writes for
 *              row 0 of BAND_TALUS, so the two meet to the last bit rather than
 *              to a tolerance.
 *
 * WHAT THIS REPLACES. The previous version anchored to `halfWidth - 0.25` and
 * `py + dh` on the horizontalised frame, and ended at `toeU` with `dh` still
 * non-zero. Three separate failures, all measured, none visible from inside
 * this file:
 *
 *   - the inner edge missed a banked road edge by up to 0.80 m;
 *   - `dh` at the seam ran from -0.32 m to +0.12 m, so the apron sometimes
 *     poked UP through the road (27 mm at worst) and z-fought it;
 *   - `dh` at the outer edge was likewise non-zero, leaving an open vertical
 *     step of up to 0.31 m where the apron should have met the scree — 155
 *     stations of it, both sides, the whole lap.
 *
 * AND THE NOISE IS KEYED ON `t`, NOT ON `arc`. That rule is in this file's
 * header and this function broke it: `fields.mottle(u, st.arc * 0.07, …)` is
 * not periodic over the lap, so the ring at arc = length came out 107-136 mm
 * away from the ring at arc = 0. They are the same ground. The apron did not
 * close at the start line, and there is no geometry across the step.
 */
function emitApronStrip(
  out: SurfaceBuilder,
  stations: Station[],
  i0: number,
  i1: number,
  side: number,
  uvU: number,
  fields: Fields,
  lapLength: number,
): void {
  const ROWS = 6
  const sign = side === 0 ? -1 : 1
  let prev: number[] | null = null

  for (let i = i0; i <= i1; i++) {
    const st = stations[i]!
    const seam = st.seam[side]!
    const edge = st.edge[side]!
    const toeU = st.toeU[side]!
    // Verbatim the talus toe. If this expression and the one in `buildProfiles`
    // ever stop matching, seam-check's `apron-toe` goes red.
    const toeX = st.px + st.rx * sign * toeU
    const toeY = st.baseY[side]!
    const toeZ = st.pz + st.rz * sign * toeU

    /*
     * The swale depth is capped by how much room there is. A 0.29 m ditch is
     * scenery when the toe is 20 m out and a trap when it is 1.5 m out, and
     * `BARRIER_MARGIN` says a kart may legally be on the first 1.5 m of it.
     */
    const room = Math.max(0.4, toeU - st.halfWidth)

    const ring: number[] = []
    for (let r = 0; r < ROWS; r++) {
      let x: number
      let y: number
      let z: number
      let u: number
      let f: number
      let n = 0
      if (r === 0) {
        x = seam[0]!
        y = seam[1]!
        z = seam[2]!
        u = st.halfWidth - st.seamTuck[side]!
        f = 0
      } else {
        const g = (r - 1) / (ROWS - 2)
        // Periodic in t. See the file header, and see what happened when it
        // was not.
        n = ringNoise3(fields.mottle, st.t, lapLength, 26, g * 3.1 + side * 40)
        const swale = Math.min(0.2 + n * 0.09, room * 0.12) * Math.sin(Math.PI * g)
        /*
         * PLAN IS LINEAR, HEIGHT IS EASED, and the difference matters through
         * The Wall.
         *
         * The canyon walls stand on world up from the CENTRELINE height and the
         * road banks 20 degrees, so on the high side of the bank the road edge
         * is metres above the toe the apron has to reach. A straight
         * interpolation puts that whole descent into the first metre beside the
         * road — inside `BARRIER_MARGIN`, which is run-off a kart is allowed
         * to be on. Smoothstepping the HEIGHT alone leaves a level verge at the
         * road and a level landing at the scree, and puts the drop in the
         * middle where nothing drives. The plan stays linear so the strip is
         * still a straight run in map view.
         */
        const gy = g * g * (3 - 2 * g)
        x = lerp(edge[0]!, toeX, g)
        y = lerp(edge[1]!, toeY, gy) - swale
        z = lerp(edge[2]!, toeZ, g)
        u = lerp(st.halfWidth, toeU, g)
        f = g
      }

      _c.copy(C_SAND_COMPACT).lerp(C_SCREE, smoothstep(0.15, 0.95, f))
      const sandW = st.sand[side]! * (1 - smoothstep(0.55, 1, f))
      if (sandW > 0.001) _c.lerp(_c2.copy(C_SAND_SUNLIT), sandW * 0.8)
      _c.multiplyScalar(1 + n * 0.07)
      ring.push(out.vertex(x, y, z, st.arc * uvU, u / 8, _c))
    }
    if (prev) {
      for (let r = 0; r < ROWS - 1; r++) {
        const A = prev[r]!
        const B = ring[r]!
        const C = ring[r + 1]!
        const D = prev[r + 1]!
        /*
         * SAME rule as `emitBandStrip`, and that is not an accident worth
         * "fixing".
         *
         * The instinct is that ground wants the opposite winding from a wall,
         * because one faces up and the other faces sideways. It does not. For
         * side = -1 the profile direction is `-right*du + up*dh`, so the
         * triangle normal is `du*up + dh*right`: the wall case (dh large) comes
         * out along +right, the apron case (du large) comes out along +up, and
         * both are correct from the SAME index order. Reversing it here — which
         * this code did on the first pass — backface-culls the entire left-hand
         * apron for the whole lap and leaves a hole you can see the hinterland
         * through. It fails on exactly one side, which is what makes it easy to
         * miss in a screenshot taken from the other one.
         *
         * This is now MEASURED rather than argued. tools/seam-check.mjs reads
         * each triangle's geometric winding and reports an upward ray that
         * lands on a back face as a hole, distinctly from one that lands on
         * nothing. Both sides came back front-facing at every station, so the
         * reversed-winding theory for the reported hole is dead — which is
         * worth knowing, because it was the first thing everyone suspected and
         * it was not the bug.
         */
        if (sign < 0) out.quad(A, B, C, D)
        else out.quad(A, D, C, B)
      }
    }
    prev = ring
  }
}

// ---------------------------------------------------------------------------
// Scatter
// ---------------------------------------------------------------------------

interface ScatterItem {
  readonly matrix: Matrix4
  readonly shape: number
  readonly distanceToLine: number
  /** Largest axis of the instance, metres. Feeds the LOD rule with distance. */
  readonly size: number
}
interface PlantItem {
  readonly matrix: Matrix4
  /** 0 = sage, 1 = dry brush. */
  readonly kind: number
}
interface ScatterResult {
  readonly boulders: ScatterItem[]
  readonly pebbles: ScatterItem[]
  readonly plants: PlantItem[]
  /** Placements dropped because nothing legal was left to place them in. */
  readonly rejected: number
}

/**
 * Unit-sphere radius of each scatter family's geometry, read off the geometry
 * itself rather than asserted here.
 *
 * This is the number the previous version of this file did not have, and its
 * absence is the whole of defect three. Talus was placed by ORIGIN — `u` was
 * clamped so the centre of a boulder cleared the road — and the build report
 * duly said "0 intrusions inside halfWidth". Meanwhile `makeRockChunk`
 * displaces an icosahedron out to 1.57× its nominal radius, and the largest
 * boulder is scaled by 4.1, so a rock whose centre was legally 2 m off the
 * road had six metres of itself sitting on the racing line. The screenshots
 * showed it; the check could not, because the check was measuring a point.
 *
 * Nothing here is a constant: the radii are computed from the geometries that
 * were actually built, so re-tuning `makeRockChunk`'s lumpiness moves the
 * clearance automatically instead of silently invalidating a magic number.
 */
interface ScatterRadii {
  /** Max over all boulder LOD shapes. */
  readonly boulder: number
  readonly pebble: number
  readonly plant: number
}

function maxBoundingRadius(geos: readonly BufferGeometry[]): number {
  let r = 0
  for (const g of geos) {
    if (!g.boundingSphere) g.computeBoundingSphere()
    r = Math.max(r, g.boundingSphere ? g.boundingSphere.radius : 0)
  }
  return r
}

const DENSITY_BY_TIER: Readonly<Record<string, number>> = {
  low: 0.3,
  medium: 0.6,
  high: 1.0,
  ultra: 1.3,
}

function buildScatter(
  ctx: Ctx,
  stations: Station[],
  stationCount: number,
  spacing: number,
  extra: number,
  radii: ScatterRadii,
): ScatterResult {
  const rng = ctx.rngFor('world/terrain/scatter')
  const rBoulder = rng.fork('boulders')
  const rPebble = rng.fork('pebbles')
  const rPlant = rng.fork('plants')
  const density = (DENSITY_BY_TIER[ctx.quality.tier] ?? 1) * extra

  const boulders: ScatterItem[] = []
  const pebbles: ScatterItem[] = []
  const plants: PlantItem[] = []
  let rejected = 0

  const m = () => new Matrix4()
  const q = new Quaternion()
  const axis = new Vector3()
  const scl = new Vector3()
  const pos = new Vector3()

  /*
   * DENSITY AND DISTANCE FROM THE RACING LINE.
   *
   * §1 Trap 3 asks for pebbles at 4.5/m² near the line falling to 0.6/m² beyond
   * 40 m. Taken as geometry that is not a budget, it is a refusal: a 30 m
   * corridor down a 1620 m lap is 48 000 m², and 4.5/m² is over two hundred
   * thousand instances of a 20-triangle rock. That number is only reachable as a
   * texture and normal-map term on whoever owns the sand material.
   *
   * What is built here is the part geometry is actually for: a placement rate of
   * 0.14/m² across the shoulder, thinned by a falloff that reaches zero at 40 m
   * from the line — about 1 600 stones and 33 k triangles on `high`, which is
   * what the eye reads as "the ground has stones on it" from a kart. The
   * remaining factor of thirty belongs in a normal map on the sand material. The
   * discrepancy is reported rather than quietly satisfied by shrinking the
   * corridor until the arithmetic works.
   */
  const PEBBLES_PER_SQM = 0.14

  /*
   * THE ONLY RULE ABOUT WHERE SCATTER MAY GO.
   *
   * `halfWidth + BARRIER_MARGIN` is the outside of the run-off a kart is
   * allowed to be on, and it moves when another agent widens the track. A
   * placement is legal when its BOUNDING SPHERE clears that line — centre minus
   * radius, not centre. Anything that cannot be placed legally is dropped and
   * counted, never nudged: nudging piles a hundred rocks against an invisible
   * line and reads as a wall.
   *
   * Returns the smallest HORIZONTAL offset that satisfies it, converted out of
   * this file's horizontalised frame into the road's banked one — see
   * `Station.rightY`. `dy` is the largest vertical excursion the instance can
   * have from the road plane; the bank term is signed either way, so its
   * magnitude is what has to be paid for on both sides.
   *
   * CORRIDOR_CLEARANCE is in here for the same reason it is in `minToe`: this
   * is measured against ONE station's `halfWidth`, and the barrier line the
   * result is graded against is a curve sampled every 4.5 m. Without it the lap
   * sweep reads boulders at 0.03–0.05 m inside the line — the discretisation
   * error, not a placement error, but indistinguishable from one in a report.
   */
  const legalInner = (st: Station, worldRadius: number, dy: number): number =>
    (st.halfWidth + BARRIER_MARGIN + CORRIDOR_CLEARANCE + worldRadius + Math.abs(dy * st.rightY)) /
    st.rightXZ

  for (let i = 0; i < stationCount; i++) {
    const st = stations[i]!
    for (let side = 0; side < 2; side++) {
      const sign = side === 0 ? -1 : 1
      const toe = st.toeU[side]!
      const talusRun = st.faceBaseU[side]! - toe
      const talusH = st.talusH[side]!
      const wallH = st.wallH[side]!
      const scale = clamp(wallH / 16, 0.35, 1.5)

      // --- talus boulders (§5c) ------------------------------------------
      const boulderN = 0.34 * spacing * density * clamp(talusRun / 4, 0.25, 1.6)
      const nB = Math.floor(boulderN) + (rBoulder() < boulderN % 1 ? 1 : 0)
      for (let k = 0; k < nB; k++) {
        // Biased down the slope: scree accumulates at the foot, which is also
        // where it breaks the wall/floor junction — a perfectly straight line
        // running to the vanishing point is the loudest tell that this is
        // primitives.
        const f = Math.pow(rBoulder(), 1.7)
        const s = (0.45 + Math.pow(rBoulder(), 2) * 2.3) * scale
        const yStretch = 0.62 + rBoulder() * 0.4
        // Worst-case radius after the non-uniform scale. The longest axis is
        // what a bounding sphere sees, so that is what has to clear the line.
        const worldRadius = radii.boulder * s * Math.max(1, yStretch)
        // Size is drawn BEFORE the position, because the size is what decides
        // which positions are legal.
        // `h` below never exceeds `talusH`, and the boulder is sunk 0.3·s.
        const uLo = legalInner(st, worldRadius, Math.max(talusH, s * 0.3))
        const uHi = toe + talusRun * 1.25 + 1.0
        if (uLo >= uHi) {
          rejected++
          // Burn the same number of draws either way, or a rejection shifts
          // every subsequent placement on the lap and the field stops being
          // reproducible from the seed.
          rBoulder()
          rBoulder()
          rBoulder()
          rBoulder()
          continue
        }
        const u = uLo + f * (uHi - uLo)
        const h = talusH * Math.pow(clamp((u - toe) / Math.max(0.2, talusRun), 0, 1), 1.35)
        axis.set(rBoulder() * 2 - 1, rBoulder() * 2 - 1, rBoulder() * 2 - 1)
        if (axis.lengthSq() < 1e-6) axis.set(0, 1, 0)
        axis.normalize()
        q.setFromAxisAngle(axis, rBoulder() * Math.PI * 2)
        // Sunk 30% into the ground. A sphere resting exactly on a plane reads as
        // a ball placed there; a buried one reads as a rock.
        scl.set(s, s * yStretch, s)
        pos.set(st.px + st.rx * sign * u, st.baseY[side]! + h - s * 0.3, st.pz + st.rz * sign * u)
        const mat = m().compose(pos, q, scl)
        boulders.push({
          matrix: mat,
          shape: (i + k) % 3,
          distanceToLine: Math.abs(sign * u - st.racingLine),
          size: s,
        })
      }

      // --- pebbles (§1 Trap 3) --------------------------------------------
      /*
       * `inner` used to be `halfWidth + 0.2`, which is 1.3 m INSIDE the legal
       * run-off. A 20 cm stone is not a hazard the way a 3 m boulder is, but
       * "nothing is on the drivable surface" is not a rule with a size
       * exemption — the moment there is one, the next author picks a different
       * size for it.
       */
      const inner = st.halfWidth + BARRIER_MARGIN
      const span = Math.max(1.5, toe + 3 - inner)
      const pebbleN = PEBBLES_PER_SQM * spacing * Math.min(span, 26) * density
      const nP = Math.floor(pebbleN) + (rPebble() < pebbleN % 1 ? 1 : 0)
      for (let k = 0; k < nP; k++) {
        const uf = Math.pow(rPebble(), 1.5)
        const s = 0.05 + Math.pow(rPebble(), 2) * 0.24
        // Longest axis of scl below is `s * 1.3`.
        const u = legalInner(st, radii.pebble * s * 1.3, 0.16 + s * 0.35) + uf * span
        const d = Math.abs(sign * u - st.racingLine)
        // Falls off to nothing by 40 m, per Trap 3's shape if not its magnitude.
        if (rPebble() > 1 - smoothstep(40, 4, d)) continue
        axis.set(rPebble() * 2 - 1, rPebble() * 2 - 1, rPebble() * 2 - 1)
        if (axis.lengthSq() < 1e-6) axis.set(0, 1, 0)
        axis.normalize()
        q.setFromAxisAngle(axis, rPebble() * Math.PI * 2)
        scl.set(s, s * 0.55, s * (0.8 + rPebble() * 0.5))
        pos.set(st.px + st.rx * sign * u, st.baseY[side]! - 0.16 + s * 0.35, st.pz + st.rz * sign * u)
        pebbles.push({ matrix: m().compose(pos, q, scl), shape: k % 2, distanceToLine: d, size: s })
      }

      // --- vegetation (§3a) -----------------------------------------------
      /*
       * Desert plants do not grow on the road shoulder or on live scree. They
       * grow where water sat: the apron swale, and the toe of the talus. Density
       * peaks where `sand` is moderate — pure dune has nothing, bare rock has
       * nothing.
       */
      const veg = smoothstep(0.02, 0.3, st.sand[side]!) * (1 - smoothstep(0.75, 1.0, st.sand[side]!))
      const plantN = 0.62 * spacing * density * veg * clamp(span / 8, 0.3, 2.2)
      const nV = Math.floor(plantN) + (rPlant() < plantN % 1 ? 1 : 0)
      for (let k = 0; k < nV; k++) {
        const uf = rPlant()
        const s = 0.6 + Math.pow(rPlant(), 1.6) * 1.1
        // A shrub is mostly air, but it is drawn double-sided and its blades
        // reach further than its stem — the bounding sphere is the honest
        // number and it is the one the rule is written about.
        const u = legalInner(st, radii.plant * s * 1.4, 0.16) + uf * Math.max(1, span * 0.9)
        q.setFromAxisAngle(axis.set(0, 1, 0), rPlant() * Math.PI * 2)
        scl.set(s, s * (0.7 + rPlant() * 0.7), s)
        pos.set(st.px + st.rx * sign * u, st.baseY[side]! - 0.16, st.pz + st.rz * sign * u)
        plants.push({ matrix: m().compose(pos, q, scl), kind: rPlant() < 0.55 ? 0 : 1 })
      }
    }
  }

  return { boulders, pebbles, plants, rejected }
}

/** Triangles in a geometry, indexed or not. Used only for the build report. */
function triCount(geo: BufferGeometry): number {
  const index = geo.getIndex()
  return index ? index.count / 3 : geo.getAttribute('position').count / 3
}

function makeInstanced(
  geo: BufferGeometry,
  mat: MeshStandardMaterial,
  mats: readonly Matrix4[],
): InstancedMesh {
  const mesh = new InstancedMesh(geo, mat, mats.length)
  for (let i = 0; i < mats.length; i++) mesh.setMatrixAt(i, mats[i]!)
  mesh.instanceMatrix.needsUpdate = true
  mesh.computeBoundingSphere()
  return mesh
}

/**
 * A rock. Radial displacement of an icosahedron by a noise field evaluated at
 * the UNDISPLACED position, which is what keeps the seams closed: three.js
 * polyhedra are non-indexed, so coincident vertices only stay coincident if
 * their displacement is a pure function of where they already are.
 */
function makeRockChunk(rng: RNG, detail: number, lumpy: number): BufferGeometry {
  const g = new IcosahedronGeometry(1, detail)
  const n = createNoise3D(rng)
  const p = g.getAttribute('position')
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i)
    const y = p.getY(i)
    const z = p.getZ(i)
    const r =
      1 + n(x * 1.6, y * 1.6, z * 1.6) * lumpy + n(x * 4.1, y * 4.1, z * 4.1) * lumpy * 0.35
    p.setXYZ(i, x * r, y * r, z * r)
  }
  p.needsUpdate = true
  // Faceted on purpose. Smooth-shaded boulders read as potatoes; a broken rock
  // has planes, and at a 12° sun the planes are what catch the key.
  g.computeVertexNormals()
  g.computeBoundingSphere()
  // Vertex colours are declared on the shared rock material, so every geometry
  // bound to it must supply the attribute or the shader reads garbage.
  const cols = new Float32Array(p.count * 3)
  for (let i = 0; i < p.count; i++) {
    const shade = 0.82 + ((i * 2654435761) % 1024) / 1024 * 0.3
    cols[i * 3] = C_SCREE.r * shade
    cols[i * 3 + 1] = C_SCREE.g * shade
    cols[i * 3 + 2] = C_SCREE.b * shade
  }
  g.setAttribute('color', new Float32BufferAttribute(cols, 3))
  return g
}

/** A shrub: tapered blades fanned around a point, drawn double-sided. */
function makeTuftGeometry(rng: RNG, blades: number, height: number, lean: number): BufferGeometry {
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + rng() * 0.7
    const h = height * (0.55 + rng() * 0.7)
    const w = 0.05 + rng() * 0.055
    const dx = Math.cos(a)
    const dz = Math.sin(a)
    const reach = h * lean * (0.35 + rng() * 0.95)
    const px = -dz * w
    const pz = dx * w
    const base = pos.length / 3
    pos.push(
      -px, 0, -pz,
      px, 0, pz,
      dx * reach + px * 0.15, h, dz * reach + pz * 0.15,
      dx * reach - px * 0.15, h, dz * reach - pz * 0.15,
    )
    uv.push(0, 0, 1, 0, 1, 1, 0, 1)
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2))
  g.setIndex(idx)
  g.computeVertexNormals()
  g.computeBoundingSphere()
  return g
}

// ---------------------------------------------------------------------------
// Mesa field — §1 Trap 4
// ---------------------------------------------------------------------------

/**
 * The nine parameters §1 Trap 4 asks for. Two mesas differing in any of these
 * differ in outline; the reuse rule below is what stops two mesas NOT differing
 * in any of them from being visible at the same time.
 */
interface MesaProfile {
  readonly id: number
  /** 1. Footprint radius as a multiple of height. */
  readonly capW: number
  /** 2. Fraction of total height occupied by the caprock block. */
  readonly capH: number
  /** 3. Extra exponent on the vertical curve — how much the base flares. */
  readonly shoulder: number
  /** 4. How much the radius shrinks between base and cap. */
  readonly taper: number
  /** 5. Number of bench steps. */
  readonly benches: number
  /** 6. Radius lost at each bench. */
  readonly inset: number
  /** 7. Bearing of the notch. */
  readonly notchPhase: number
  /** 8. Depth of the notch. */
  readonly notchDepth: number
  /** 9. Asymmetry of the footprint. */
  readonly skew: number
}

interface MesaPlacement {
  readonly profileId: number
  readonly azimuthDeg: number
  readonly depth: number
  /** `height / depth` — angular size, which is what "apparent height" means. */
  readonly apparent: number
}

interface MesaField {
  readonly layerGeometries: BufferGeometry[]
  readonly audit: MesaAudit
}

function makeMesaProfile(rng: RNG, id: number): MesaProfile {
  return {
    id,
    capW: 0.85 + rng() * 1.35,
    capH: 0.06 + rng() * 0.16,
    shoulder: 0.25 + rng() * 1.1,
    taper: 0.18 + rng() * 0.34,
    benches: 1 + Math.floor(rng() * 3),
    inset: 0.04 + rng() * 0.1,
    notchPhase: rng() * Math.PI * 2,
    notchDepth: rng() * rng() * 0.42,
    skew: (rng() - 0.5) * 0.34,
  }
}

/**
 * §1 Trap 4, implemented rather than asserted.
 *
 * "A profile may be reused only if the reuse is ≥ 55° away in view azimuth,
 * ≥ 180 m further in depth, and differs in apparent height by ≥ 18%." The three
 * clauses are conjunctive, which has one consequence worth stating: within a
 * single depth layer the depth clause can never hold, so NO profile is ever
 * reused inside a layer. Reuse only happens between layers 180 m or more apart,
 * and only where the angular size also differs by 18%.
 *
 * The rule is enforced at placement, not checked afterward: a candidate profile
 * is admitted only if it satisfies all three clauses against EVERY placement
 * already using it, and a fresh profile is minted when none qualifies. The
 * invariant therefore holds by construction. `auditMesaField` then re-derives it
 * independently from the emitted placements, which is the number a reviewer
 * should read — a builder attesting to its own output is not evidence.
 *
 * "View azimuth" is taken as bearing from the circuit centroid. The rule is
 * stated from a camera, but the camera moves through 1620 m of lap and the mesas
 * do not; a camera-relative reading would be true at one vantage and meaningless
 * at the other nine. Bearing from the centroid is the camera-independent proxy
 * and it is conservative at `mesa-crest`, which sits near the middle of the map.
 */
function buildMesaField(rng: RNG, cx: number, cz: number, floorY: number, circuitRadius: number): MesaField {
  const profiles: MesaProfile[] = []
  const placements: MesaPlacement[] = []
  const layerGeometries: BufferGeometry[] = []
  const layerHeights: { min: number; max: number }[] = []

  /*
   * Layer radii. §2's fog is exponential-squared at density 0.0025, so
   * transmittance is exp(-(d*0.0025)^2): 0.78 at 210 m, 0.43 at 410 m, 0.10 at
   * 690 m. Beyond about 760 m a layer contributes nothing but cost. Six layers
   * inside that window is what §10b criterion 5 and §11's `mesa-crest` need —
   * five is the floor, and building exactly the floor leaves nothing when one of
   * them ends up behind a cliff.
   */
  const offsets = [55, 130, 235, 370, 545, 745]
  const baseHeight = 26

  const rShape = rng.fork('profiles')
  const rPlace = rng.fork('placement')

  for (let l = 0; l < MESA_LAYERS; l++) {
    const radius = circuitRadius + offsets[l]!
    /*
     * §1: no two adjacent mesa layers share a cap height within 8%.
     *
     * Layer heights step by 1.22 and jitter by ±5%, so the tallest possible mesa
     * in layer l is 1.05x its base and the shortest in layer l+1 is 1.159x —
     * 10.4% apart, with no overlap possible. That is enforcement by
     * construction; `auditMesaField` measures what was actually emitted.
     */
    const layerBase = baseHeight * Math.pow(MESA_LAYER_HEIGHT_RATIO, l)
    let hMin = Infinity
    let hMax = 0

    // Enough mesas to close the horizon with roughly their own width of sky
    // between them. Fewer and the layer is a picket fence; more and it is a wall.
    const meanWidth = 2 * 1.3 * layerBase
    const count = Math.max(9, Math.round((Math.PI * 2 * radius) / (2.1 * meanWidth)))

    const builder = new SurfaceBuilder()
    for (let k = 0; k < count; k++) {
      const azJitter = (rPlace() - 0.5) * 0.55
      const azimuthDeg = (((k + 0.5 + azJitter) / count) * 360) % 360
      const az = (azimuthDeg * Math.PI) / 180
      // Radial jitter stays well under the 180 m depth clause so it can never
      // accidentally license an intra-layer reuse.
      const depth = radius + (rPlace() - 0.5) * 44
      const height = layerBase * (1 + (rPlace() * 2 - 1) * MESA_HEIGHT_JITTER)
      hMin = Math.min(hMin, height)
      hMax = Math.max(hMax, height)
      const apparent = height / depth

      let chosen = -1
      for (const p of profiles) {
        if (admissible(placements, p.id, azimuthDeg, depth, apparent)) {
          chosen = p.id
          break
        }
      }
      if (chosen < 0) {
        const p = makeMesaProfile(rShape, profiles.length)
        profiles.push(p)
        chosen = p.id
      }
      placements.push({ profileId: chosen, azimuthDeg, depth, apparent })

      emitMesa(
        builder,
        profiles[chosen]!,
        cx + Math.cos(az) * depth,
        cz + Math.sin(az) * depth,
        floorY,
        height,
        rPlace() * Math.PI * 2,
      )
    }

    layerHeights.push({ min: hMin, max: hMax })
    const geo = builder.build()
    if (geo) layerGeometries.push(geo)
  }

  return {
    layerGeometries,
    audit: auditMesaField(placements, profiles.length, layerGeometries.length, layerHeights),
  }
}

function admissible(
  placements: readonly MesaPlacement[],
  profileId: number,
  azimuthDeg: number,
  depth: number,
  apparent: number,
): boolean {
  for (const p of placements) {
    if (p.profileId !== profileId) continue
    if (!separated(p, azimuthDeg, depth, apparent)) return false
  }
  return true
}

function separated(p: MesaPlacement, azimuthDeg: number, depth: number, apparent: number): boolean {
  const dAz = angularSepDeg(azimuthDeg, p.azimuthDeg)
  const dDepth = Math.abs(depth - p.depth)
  const dApp = Math.abs(apparent - p.apparent) / Math.max(apparent, p.apparent)
  return (
    dAz >= TRAP4_MIN_AZIMUTH_DEG &&
    dDepth >= TRAP4_MIN_DEPTH_M &&
    dApp >= TRAP4_MIN_APPARENT_HEIGHT_DELTA
  )
}

/**
 * Independent re-derivation of the Trap 4 invariant from the emitted
 * placements. This runs the O(n²) pairwise check the placement loop's greedy
 * search is a shortcut for, so a bug in the shortcut shows up here as a non-zero
 * `violations`.
 */
function auditMesaField(
  placements: readonly MesaPlacement[],
  distinctProfiles: number,
  layers: number,
  layerHeights: readonly { min: number; max: number }[],
): MesaAudit {
  let violations = 0
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      const a = placements[i]!
      const b = placements[j]!
      if (a.profileId !== b.profileId) continue
      if (!separated(a, b.azimuthDeg, b.depth, b.apparent)) violations++
    }
  }
  const used = new Set<number>()
  let reuses = 0
  for (const p of placements) {
    if (used.has(p.profileId)) reuses++
    else used.add(p.profileId)
  }
  let minRatio = Infinity
  for (let l = 0; l + 1 < layerHeights.length; l++) {
    const near = layerHeights[l]!
    const far = layerHeights[l + 1]!
    if (near.max > 0) minRatio = Math.min(minRatio, far.min / near.max)
  }
  return {
    layers,
    instances: placements.length,
    distinctProfiles,
    reuses,
    violations,
    minAdjacentLayerCapRatio: Number.isFinite(minRatio) ? minRatio : 0,
  }
}

/** One mesa: a stepped prism with a caprock flare and a flat top. */
function emitMesa(
  out: SurfaceBuilder,
  p: MesaProfile,
  cx: number,
  cz: number,
  baseY: number,
  height: number,
  yaw: number,
): void {
  const R = p.capW * height

  const levels: { yf: number; rf: number }[] = []
  levels.push({ yf: 0, rf: 1 })
  levels.push({ yf: 0.08 + p.shoulder * 0.06, rf: 1 - p.taper * 0.28 })
  for (let b = 1; b <= p.benches; b++) {
    const f = 0.22 + (0.66 - 0.22) * (b / (p.benches + 1))
    const r = 1 - p.taper * (0.28 + 0.5 * (b / (p.benches + 1))) - p.inset * b * 0.6
    levels.push({ yf: f, rf: Math.max(0.16, r) })
    levels.push({ yf: f + 0.03, rf: Math.max(0.14, r - p.inset) })
  }
  const rTop = Math.max(0.13, 1 - p.taper * 0.92 - p.inset * p.benches * 0.6 - p.inset)
  levels.push({ yf: Math.max(0.7, 1 - p.capH), rf: rTop })
  // The caprock flares back out. That overhang is the single feature that says
  // "mesa" rather than "cone" in silhouette, and it is why §3a gives the caprock
  // its own colour.
  levels.push({ yf: 1 - p.capH * 0.2, rf: rTop * 1.08 })
  levels.push({ yf: 1, rf: rTop * 0.99 })
  for (let i = 1; i < levels.length; i++) {
    const prev = levels[i - 1]!
    const cur = levels[i]!
    if (cur.yf <= prev.yf) cur.yf = prev.yf + 0.004
  }

  const shapeAt = (a: number): number => {
    const d = a - p.notchPhase
    const notch = p.notchDepth * Math.pow(Math.max(0, Math.cos(d - Math.PI)), 2)
    return Math.max(0.35, 1 + p.skew * Math.cos(d) - notch)
  }

  const rings: number[][] = []
  for (let l = 0; l < levels.length; l++) {
    const lv = levels[l]!
    const y = baseY + height * Math.pow(lv.yf, 1 + p.shoulder * 0.35)
    const ring: number[] = []
    for (let k = 0; k < MESA_SIDES; k++) {
      const a = yaw + (k / MESA_SIDES) * Math.PI * 2
      const r = R * lv.rf * shapeAt(a)
      const x = cx + Math.cos(a) * r
      const z = cz + Math.sin(a) * r
      // §2: no pre-darkening toward the haze. The variation here is geological —
      // the caprock band is lighter than the slopes below it — and the fog is
      // what turns it into aerial perspective.
      _c.copy(C_LOWER).lerp(C_CAPROCK, smoothstep(0.35, 0.92, lv.yf))
      _c.multiplyScalar(0.9 + ((p.id * 37 + k * 13) % 17) / 17 * 0.22)
      ring.push(out.vertex(x, y, z, (a * r) / 12, y / 12, _c))
    }
    rings.push(ring)
  }

  for (let l = 0; l + 1 < rings.length; l++) {
    const lo = rings[l]!
    const hi = rings[l + 1]!
    for (let k = 0; k < MESA_SIDES; k++) {
      const k2 = (k + 1) % MESA_SIDES
      /*
       * With A = lo[k], B = lo[k+1], C = hi[k+1], D = hi[k] and the ring angle
       * increasing with k, (A, B, C) points INWARD — check it at k = 0 on a
       * four-sided ring and the cross product comes out at -X-Z while the face
       * midpoint is at +X+Z. The outward pair is (A, C, B) and (A, D, C).
       * Getting this backwards makes an entire silhouette layer invisible under
       * front-face culling, and it fails silently.
       */
      out.idx.push(lo[k]!, hi[k2]!, lo[k2]!)
      out.idx.push(lo[k]!, hi[k]!, hi[k2]!)
    }
  }

  // Flat top. Without it a mesa is a hollow tube and the sun shines through it.
  const top = rings[rings.length - 1]!
  const lv = levels[levels.length - 1]!
  _c.copy(C_CAPROCK)
  const centre = out.vertex(cx, baseY + height * Math.pow(lv.yf, 1 + p.shoulder * 0.35), cz, 0, 0, _c)
  for (let k = 0; k < MESA_SIDES; k++) {
    const k2 = (k + 1) % MESA_SIDES
    out.idx.push(centre, top[k2]!, top[k]!)
  }
}

// ---------------------------------------------------------------------------
// TEST FIXTURE — a synthetic ITrack
// ---------------------------------------------------------------------------

/**
 * A stadium oval that satisfies `ITrack`, so this module can be exercised before
 * `world/track.ts` exists.
 *
 * It is NOT a stand-in for the circuit and must never ship in one. What it is
 * for is proving that the terrain builder survives the parts of the contract
 * that a straight corridor never exercises: a half-width that changes by 2:1
 * along the lap, an elevation profile with real gradient, and curvature that
 * changes sign of "outside" halfway round. If the walls come out right on this,
 * the section table's curvature resolution is right.
 *
 * The default 340 m straights and 148 m radius give 1610 m, within 1% of §1's
 * 1620 m centreline, so scatter counts and draw calls measured against this are
 * representative.
 */
export interface OvalTrackOptions {
  readonly straight?: number
  readonly radius?: number
  readonly gridSlots?: number
}

const _fx = { x: 0, z: 0, tx: 0, tz: 0, curv: 0 }
const _ovalResolved = makeResolvedSection()
const _ovalProfile = makeWallProfilePoint()
/*
 * The fixture's stand-in for the envelope noise. See the note on its
 * `wallLimit`.
 *
 * `notch` returns 1, not 0, and that is not a typo. The notch term is
 * `smoothstep(0.55, 0.95, 1 - |noise|)`, so a field of zeros reads as a notch
 * at FULL depth everywhere and quietly shortens every wall on the fixture by
 * 38%. "Unmodulated" is |noise| = 1 for that one field and 0 for the others.
 */
const _zeroNoise: Noise2 = () => 0
const _oneNoise: Noise2 = () => 1
const FLAT_WALL_NOISE = {
  crestLow: _zeroNoise,
  crestHigh: _zeroNoise,
  notch: _oneNoise,
  setback: _zeroNoise,
}
const _tan = new Vector3()
const _rgt = new Vector3()
const _nrm = new Vector3()
const _pos = new Vector3()
const _up = new Vector3(0, 1, 0)
const _delta = new Vector3()

export function makeOvalTrack(options: OvalTrackOptions = {}): ITrack {
  const straight = options.straight ?? 340
  const radius = options.radius ?? 148
  const slots = options.gridSlots ?? 8
  const H = straight / 2
  const length = 2 * straight + 2 * Math.PI * radius

  const a1 = straight
  const a2 = straight + Math.PI * radius
  const a3 = 2 * straight + Math.PI * radius

  const wrap = (t: number): number => t - Math.floor(t)
  /** 0 to 26 m and back, smooth and periodic. Gradient peaks near 5%. */
  const elev = (t: number): number => 26 * (0.5 - 0.5 * Math.cos(Math.PI * 2 * t))
  const dElev = (t: number): number => 26 * Math.PI * Math.sin(Math.PI * 2 * t) / length
  /** 4.6 m to 9.0 m: §1's Slot half-width at the tightest point. */
  const halfWidthAt = (t: number): number => 4.6 + 4.4 * (0.5 - 0.5 * Math.cos(Math.PI * 4 * t))

  function planar(s: number): void {
    if (s < a1) {
      _fx.x = radius
      _fx.z = -H + s
      _fx.tx = 0
      _fx.tz = 1
      _fx.curv = 0
    } else if (s < a2) {
      const th = (s - a1) / radius
      _fx.x = radius * Math.cos(th)
      _fx.z = H + radius * Math.sin(th)
      _fx.tx = -Math.sin(th)
      _fx.tz = Math.cos(th)
      // Heading swings +Z -> -X -> -Z. Driver's right when heading +Z is -X, so
      // this is a RIGHT turn and curvature is positive per the contract.
      _fx.curv = 1 / radius
    } else if (s < a3) {
      _fx.x = -radius
      _fx.z = H - (s - a2)
      _fx.tx = 0
      _fx.tz = -1
      _fx.curv = 0
    } else {
      const th = Math.PI + (s - a3) / radius
      _fx.x = radius * Math.cos(th)
      _fx.z = -H + radius * Math.sin(th)
      _fx.tx = -Math.sin(th)
      _fx.tz = Math.cos(th)
      _fx.curv = 1 / radius
    }
  }

  function frame(t: number): void {
    const tw = wrap(t)
    planar(tw * length)
    _pos.set(_fx.x, elev(tw), _fx.z)
    _tan.set(_fx.tx, dElev(tw), _fx.tz).normalize()
    _rgt.copy(_tan).cross(_up).normalize()
    _nrm.copy(_rgt).cross(_tan).normalize()
  }

  const checkpoints: readonly number[] = [0, 0.25, 0.5, 0.75]

  const startGrid: StartSlot[] = []
  for (let i = 0; i < slots; i++) {
    // Two columns marching back from the line, staggered like a real grid.
    const row = Math.floor(i / 2)
    const t = wrap(-(6 + row * 7) / length)
    frame(t)
    const lateral = (i % 2 === 0 ? -1 : 1) * 2.2
    const p = new Vector3(
      _pos.x + _rgt.x * lateral,
      _pos.y + _rgt.y * lateral,
      _pos.z + _rgt.z * lateral,
    )
    const m = new Matrix4().makeBasis(
      _rgt.clone(),
      _nrm.clone(),
      _tan.clone().multiplyScalar(-1),
    )
    startGrid.push({ position: p, orientation: new Quaternion().setFromRotationMatrix(m), t })
  }

  const group = new Group()
  group.name = 'oval-test-track'

  return {
    length,
    group,
    checkpoints,
    startGrid,

    sample(t: number, out: TrackSample): TrackSample {
      frame(t)
      out.position.copy(_pos)
      out.tangent.copy(_tan)
      out.right.copy(_rgt)
      out.normal.copy(_nrm)
      out.halfWidth = halfWidthAt(wrap(t))
      out.bank = 0
      out.curvature = _fx.curv
      return out
    },

    /**
     * Closed form, not a search.
     *
     * A stadium oval is exactly the set of points at distance `radius` from the
     * segment joining the two arc centres, so the nearest centreline point comes
     * from projecting onto that segment. A sampled nearest-point search would
     * cost 200 evaluations and be wrong by half a sample interval; this is
     * neither.
     */
    locate(p: Vector3, out: TrackLocation): TrackLocation {
      const zc = clamp(p.z, -H, H)
      let s: number
      if (p.z > H) {
        let th = Math.atan2(p.z - H, p.x)
        if (th < 0) th += Math.PI * 2
        s = a1 + clamp(th, 0, Math.PI) * radius
      } else if (p.z < -H) {
        let th = Math.atan2(p.z + H, p.x)
        if (th < 0) th += Math.PI * 2
        s = a3 + (clamp(th, Math.PI, Math.PI * 2) - Math.PI) * radius
      } else if (p.x >= 0) {
        s = zc + H
      } else {
        s = a2 + (H - zc)
      }
      const t = wrap(s / length)
      frame(t)
      _delta.set(p.x - _pos.x, p.y - _pos.y, p.z - _pos.z)
      const hw = halfWidthAt(t)
      out.t = t
      out.lateral = _delta.dot(_rgt)
      out.height = _delta.dot(_nrm)
      out.onTrack = Math.abs(out.lateral) <= hw + BARRIER_MARGIN
      let ci = 0
      for (let i = 0; i < checkpoints.length; i++) if (t >= checkpoints[i]!) ci = i
      out.checkpointIndex = ci
      return out
    },

    surfaceAt(t: number, lateral: number): Surface {
      const hw = halfWidthAt(wrap(t))
      const a = Math.abs(lateral)
      if (a > hw + BARRIER_MARGIN) return Surface.OffTrack
      if (a > hw) return Surface.Gravel
      if (a > hw - 0.6) return Surface.Kerb
      if (a > hw - 2.2) return Surface.SandDrift
      return Surface.DustyAsphalt
    },

    /*
     * The fixture answers `wallLimit` from the SAME `wall-profile.ts` the real
     * circuit does — the table, the corner resolution and the talus run all
     * apply to any `ITrack`, and this one exists precisely to exercise them
     * where the half-width changes 2:1 and "outside" swaps sides mid-lap.
     *
     * What it cannot share is the noise: `createWallNoise` needs a `Ctx` and
     * this fixture takes none, by design — it is constructed by harnesses that
     * have no world seed. The un-jittered envelope is therefore what it
     * reports, and it says so rather than pretending: a fixture whose barrier
     * is a few per cent off the fixture's own rock is fine, because nothing
     * grades the fixture's rock.
     */
    wallLimit(t: number, side: -1 | 1): number {
      const tw = wrap(t)
      frame(tw)
      resolveSection(tw, _fx.curv, 0, _ovalResolved)
      wallProfileAt(tw, length, halfWidthAt(tw), _ovalResolved, side > 0 ? 1 : 0, FLAT_WALL_NOISE, _ovalProfile)
      return side * _ovalProfile.barrier
    },

    racingLine(t: number): number {
      /*
       * The oval turns right throughout, so the line hugs positive lateral
       * through both arcs and runs central down the straights. Ramped over 40 m
       * either side of each transition: scatter density is driven by distance to
       * this line, and a step in it would print a visible seam of pebbles across
       * the desert.
       */
      const tw = wrap(t)
      const s = tw * length
      const inArc = (s > a1 && s < a2) || s > a3
      if (!inArc) return 0
      let d = Infinity
      for (const b of [0, a1, a2, a3, length]) d = Math.min(d, Math.abs(s - b))
      return smoothstep(0, 40, d) * 0.45 * halfWidthAt(tw)
    },
  }
}
