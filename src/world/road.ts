/**
 * The road and its kerbs, extruded along an `ITrack`. NOT the ground beside it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE UV RULE, WHICH THIS PROJECT HAS ALREADY PAID FOR ONCE
 *
 * `PlaneGeometry` hands out UVs of 0..1 on both axes no matter what shape it
 * is. The placeholder road is 18 m across and 900 m long, so every texel came
 * out stretched 50:1 along the direction of travel — and a 50:1 texel does not
 * read as a rough surface, it reads as MOTION BLUR BAKED INTO A STILL FRAME.
 * The placeholder fixes it with `repeat.set(2, 100)`, which works only because
 * that road is a rectangle.
 *
 * This one is not a rectangle: the half-width goes from 13.0 m on the dune
 * sweep to 4.6 m in the Slot, so a fixed `repeat` is wrong everywhere except
 * one width. UVs here are ARC LENGTH AND LATERAL OFFSET IN METRES, divided by
 * one tile size. Texels are square by construction at every width, and they
 * stay square when somebody edits the width table.
 *
 * The tile size is then snapped so that `length / TILE` is a whole number.
 * Without that the texture does not meet itself at the start line and there is
 * a visible mismatched band across the grid — in the one place every screenshot
 * of the §11 `grid` vantage is framed on.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHO OWNS THE GROUND BESIDE THE ROAD — READ THIS BEFORE ADDING A SHOULDER
 *
 * This file used to build its own scree shoulder, 2.8 m of it either side,
 * dropping 34 cm. `world/terrain.ts` builds an apron over the SAME ground, from
 * the road edge out to the toe of the canyon wall, because only terrain knows
 * where the wall toe ended up. Two files, two authors, one piece of ground.
 *
 * Measured (tools/seam-check.mjs, before the fix): 766 stations where the two
 * surfaces sat within 20 mm of each other — 1.6 mm at the worst — which is
 * z-fighting, not overlap. It is the grey noise along the road edge in
 * tools/out/lap-0.png and lap-5.png. Neither author could see it, because
 * neither author's file contains both surfaces.
 *
 * So: THE ROAD RIBBON ENDS AT ±halfWidth AND NOTHING IN THIS FILE DRAWS PAST
 * IT. Everything outboard is terrain's apron. What this file still owns is the
 * DEFINITION of that edge — `roadEdgeTuck` and `roadEdgePoint` below — and
 * terrain consumes it rather than re-deriving it. One owner, one number, and a
 * consumer that cannot drift because it never had its own copy.
 *
 * If you are about to re-add a shoulder here: don't. Change the apron. If the
 * apron genuinely has to go away, `CanyonTerrainOptions.apron` turns it off and
 * then — and only then — this file may grow one back.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Draw-call budget (§9 ceiling is 250 for the whole game): this file spends
 * FIVE. Road, two kerb colours, boost pads, cattle grid. Everything repeated is
 * an instance, the three boost pads are merged into one buffer, and the
 * start-line blocks ride on the kerb meshes rather than asking for a sixth.
 *
 * Albedo variation lives in VERTEX COLOURS, not in extra materials. §5a wants
 * rubber lay-down along the true optimal line, sand drift creeping from both
 * edges and the wash's sand-over-tarmac bands; as four materials that is four
 * more draw calls and three seams. As vertex colour it is free and it blends.
 */

import { createNoise2D } from 'simplex-noise'
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  RGBAFormat,
  SRGBColorSpace,
  Vector2,
  Vector3,
} from 'three'
import { Surface } from '../types'
import type { ITrack, Metres, RNG, TrackSample } from '../types'
import { makeRoadSurface } from '../render/procedural'

export interface RoadBuildOptions {
  /** Deterministic stream for the procedural surfaces. Never `Math.random`. */
  readonly rng: RNG
  /** Already clamped to the device by `QualityProfile`. */
  readonly textureSize: number
  readonly anisotropy: number
}

// --- ART_DIRECTION §3a environment palette ---------------------------------
const COL_TARMAC = 0x4b4340 // clean tarmac
const COL_RUBBER = 0x3a3330 // rubbered racing line
const COL_SAND_EDGE = 0x6b5c4e // sand-drifted edge
const COL_WASH = 0x8a7458 // wash, sand over tarmac
const COL_LINE = 0xd9cbb4 // lane edge line — worn, never pure white
const COL_KERB_DARK = 0x241f22 // kerb stripe A
const COL_KERB_LIGHT = 0xf2ead6 // kerb stripe B
const COL_GRATE = 0x6b6560 // culvert grate — a warm grey, never neutral

// --- ART_DIRECTION §4b reserved gameplay band ------------------------------
/*
 * THE BOOST PAD IS NOT A DRIFT SPARK, AND IT MUST NOT BE THE SAME COLOUR AS ONE
 *
 * This constant was `#00ffa3`. That is not "a green in the reserved band" — it
 * is the EXACT hex §4b assigns to drift tier 1: the sparks off both rear wheels
 * and the kart's rim light. The band exists so that one glance at a hue means
 * exactly one thing, and a stationary rectangle painted on the road wearing the
 * same hex as a live signal fired from the kart teaches the player two meanings
 * for one colour. The first person to play it asked "what is this green thing?",
 * which is the entire bug in five words.
 *
 * §4b's table has no boost-pad row. That omission is the root cause; the row
 * belongs in the spec, not only here.
 *
 * WHY 190°, AND WHY NOT SOMEWHERE ELSE IN THE BAND
 *
 * The band is hue 155°–320° at saturation ≥ 0.85, and four things already live
 * inside it:
 *
 *   drift tier 1   158°   #00ffa3
 *   drift tier 2   274°   #b24bff
 *   drift tier 3   314°   #ff2fd0
 *   the SKY        205°–228°   #b9c9d8 / #7fb0e0 / #3f77c4, up to saturation
 *                  0.61 — §3a's own palette, and §4b's table tracks hue
 *                  separation from it for every tier
 *
 * That leaves two real windows: 158→205 and 228→274. Both are ~46° wide, so the
 * best achievable clearance from everything is about 23° either way, and the
 * choice is decided by LUMINANCE, which is the other axis §4b's ladder escalates
 * on. The 228→274 window is blue-violet: saturation ≥ 0.85 there forces a
 * blue-dominant colour with low intrinsic luminance, and a dark blue plate on
 * dark tarmac (§3b, luma 0.27) inside a shaded canyon is a pad you cannot see.
 * The 158→205 window is cyan, whose green channel carries most of the luma, so
 * it reads against tarmac at distance and in shade. Cyan it is.
 *
 * `#00c8f0` — hue 190.0°, HSL saturation 1.00, lightness 0.47. Separation:
 *   32° from tier 1, 84° from tier 2, 124° from tier 3, 166° from sunlit sand
 *   (40°) — very nearly its complement, which is why it reads on a road at all.
 *
 * 32° from tier 1 is under the 40° that separates tier 2 from tier 3, and it is
 * the price of the sky sitting in the middle of the band. It is paid back on
 * every other axis: this is a large static ground plane with a black outline and
 * chevrons, held at emissive 0.5 with a mask, against small additive high-luma
 * sparks that move with the kart. Green-cyan and cyan-blue at those two
 * treatments are not confusable; two objects sharing a hex are.
 */
/** The signal itself: chevrons, edge rails, and the emissive tint. */
const COL_BOOST = 0x00c8f0
/** The painted deck between the chevrons. Same hue, mid value — brighter than
 *  tarmac so the pad reads as paint ON the road rather than a hole THROUGH it,
 *  which is what the flat near-white version was first reported as. */
const COL_BOOST_DECK = 0x1d6b7d
/** The outline. Every marking on a real road has one; it is what stops a bright
 *  shape from dissolving into whatever it is painted on. §3 bans pure black. */
const COL_BOOST_EDGE = 0x0e2026
/** Leading-bar core. One value up the ladder, and the only near-white on the
 *  pad — §4b keeps near-white cores for tier 3, so this stays a cyan tint. */
const COL_BOOST_LEAD = 0x5ce3ff

/** Metres of road per texture tile, before the seam snap below. */
const ROAD_TILE_NOMINAL = 8

/** Longitudinal spacing of the road ribbon's rings. */
const RING_SPACING = 2.0

/**
 * Lateral stations, as a fraction of the local half-width.
 *
 * The clustered quadruples near ±1 are the lane edge line. A stripe needs its
 * own two vertices AND a pair of near-coincident neighbours, otherwise the
 * vertex-colour gradient smears it across a metre and a half of road and it
 * stops reading as paint. The 0.006 gaps are the transition quads; they are
 * about 7 cm wide on an 11 m half-width, which is under a pixel at any distance
 * the line is legible from anyway.
 */
const LATERAL: readonly number[] = [
  -1, -0.988, -0.982, -0.948, -0.942, -0.78, -0.56, -0.34, -0.12, 0, 0.12, 0.34, 0.56, 0.78, 0.942,
  0.948, 0.982, 0.988, 1,
]
/** Indices in `LATERAL` that make up the two edge stripes. */
const LINE_STATIONS = new Set([2, 3, 15, 16])

/** Kerb block: §3a says kerbs separate by VALUE, never by hue, and never red. */
const KERB_BAND = 0.95
const KERB_BLOCK = 1.0
const KERB_HEIGHT = 0.13

// ---------------------------------------------------------------------------
// THE SEAM. The road edge, as a number other modules may use.
// ---------------------------------------------------------------------------

/**
 * How far below the road plane the ground beside it starts, metres.
 *
 * Not zero, and not a hairline. Two independently tessellated surfaces that
 * claim the same plane z-fight; two that are 5 mm apart z-fight on a phone.
 *
 * 11 cm is not a taste value either — it is the `roadEdgeTuck` chord argument
 * turned on its side. The road rings every 2 m and terrain's stations are 4.5 m
 * apart, so where the circuit crests or dips the coarser polyline's chord
 * misses the finer one VERTICALLY by up to about 5.5 cm: it sags below on a
 * crest and rides above in a dip. This constant was 5.5 cm on the first pass
 * and seam-check measured the apron arriving 0.2 mm from the road at t = 0.67,
 * which is z-fighting, not a seam. The drop has to exceed the worst chord error
 * or the SIGN of the gap is not decidable.
 *
 * Measured along the road NORMAL, so it stays 11 cm through The Wall's 20° bank
 * instead of shearing to 10 cm on one side and 12 cm on the other.
 */
export const ROAD_EDGE_DROP: Metres = 0.11

/** Base overlap under the road, before the corner term. See `roadEdgeTuck`. */
const ROAD_EDGE_TUCK_BASE: Metres = 0.45

/**
 * How far a consumer must run its inner edge UNDER the road, at this station.
 *
 * A butt joint between two independently generated surfaces is a hairline of
 * background colour at grazing incidence, so the apron overlaps instead. The
 * size of the overlap is not a taste question, it is arithmetic:
 *
 * The road ribbon rings every 2 m; terrain's stations are 4.5 m apart. Both are
 * polylines through the same curve, and a chord always falls INSIDE its arc, so
 * on the inside of a corner the coarser polyline pulls away from the finer one
 * by the difference of their sagittas — `(L2² - L1²)·|curvature| / 8`. At a 20 m
 * radius that is 10 cm of daylight between two edges that were both derived
 * from the same `halfWidth` and are both, individually, correct.
 *
 * So the tuck carries a curvature term. `stationSpacing` is the CONSUMER's
 * longitudinal spacing, which is the only thing this file does not already
 * know. Doubling the sagitta is the safety factor.
 *
 * Clamped to a quarter of the half-width so a hypothetical 2 m-wide section
 * cannot tuck the apron out the other side of the road.
 */
export function roadEdgeTuck(sample: TrackSample, stationSpacing: Metres): Metres {
  const sagitta = (stationSpacing * stationSpacing * Math.abs(sample.curvature)) / 8
  return Math.min(ROAD_EDGE_TUCK_BASE + 2 * sagitta, sample.halfWidth * 0.25)
}

/**
 * A point on the seam plane: `inboard` metres inboard of the road edge on
 * `side`, dropped `ROAD_EDGE_DROP` below the road along its own normal.
 *
 * `inboard = 0` is the road edge itself. This is the ONLY definition of where
 * the road stops; anything else that needs to meet the road asks here. Note
 * that it uses `sample.right` and `sample.normal` unmodified — the banked
 * frame, not a horizontalised one. `terrain.ts` sweeps its walls on world up
 * (correctly: only the road banks), and the first version of the apron
 * inherited that flattening, which put its inner edge up to 0.8 m the wrong
 * side of the road edge through The Wall. Measured, not theorised: the
 * `inner-edge` check in tools/seam-check.mjs reported -0.80 m there.
 */
export function roadEdgePoint(
  sample: TrackSample,
  side: -1 | 1,
  inboard: Metres,
  out: Vector3,
): Vector3 {
  return out
    .copy(sample.position)
    .addScaledVector(sample.right, side * (sample.halfWidth - inboard))
    .addScaledVector(sample.normal, -ROAD_EDGE_DROP)
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function newSample(): TrackSample {
  return {
    position: new Vector3(),
    tangent: new Vector3(),
    normal: new Vector3(),
    right: new Vector3(),
    halfWidth: 0,
    bank: 0,
    curvature: 0,
  }
}

/**
 * Snap a tile size so the texture meets itself across the start line.
 *
 * `t` wraps, the geometry wraps, and if the V coordinate does not wrap with
 * them there is a hard band of mismatched aggregate at s = 0. It is the one
 * seam in the whole circuit that every `grid` screenshot contains.
 */
function seamlessTile(length: Metres, nominal: Metres): Metres {
  return length / Math.max(1, Math.round(length / nominal))
}

// ---------------------------------------------------------------------------
// Road surface
// ---------------------------------------------------------------------------

function buildRoadSurface(track: ITrack, opts: RoadBuildOptions): Mesh {
  const rings = Math.max(8, Math.round(track.length / RING_SPACING))
  const tile = seamlessTile(track.length, ROAD_TILE_NOMINAL)
  const stations = LATERAL.length
  // rings + 1 rows: the last row duplicates the first geometrically but carries
  // V = length/tile rather than 0, which is what makes the wrap seamless.
  const rows = rings + 1

  const positions = new Float32Array(rows * stations * 3)
  const normals = new Float32Array(rows * stations * 3)
  const uvs = new Float32Array(rows * stations * 2)
  const colors = new Float32Array(rows * stations * 3)
  const indices = new Uint32Array(rings * (stations - 1) * 6)

  const sample = newSample()
  const c = new Color()
  const target = new Color()
  const cTarmac = new Color().setHex(COL_TARMAC, SRGBColorSpace)
  const cRubber = new Color().setHex(COL_RUBBER, SRGBColorSpace)
  const cSandEdge = new Color().setHex(COL_SAND_EDGE, SRGBColorSpace)
  const cWash = new Color().setHex(COL_WASH, SRGBColorSpace)
  const cLine = new Color().setHex(COL_LINE, SRGBColorSpace)
  const cGrate = new Color().setHex(COL_GRATE, SRGBColorSpace)

  for (let r = 0; r < rows; r++) {
    const s = (r * track.length) / rings
    const t = r === rings ? 0 : r / rings
    track.sample(t, sample)
    const racing = track.racingLine(t)
    const hw = sample.halfWidth

    for (let k = 0; k < stations; k++) {
      const frac = LATERAL[k]!
      const lat = frac * hw
      const vi = (r * stations + k) * 3
      const ui = (r * stations + k) * 2

      positions[vi] = sample.position.x + sample.right.x * lat
      positions[vi + 1] = sample.position.y + sample.right.y * lat
      positions[vi + 2] = sample.position.z + sample.right.z * lat

      normals[vi] = sample.normal.x
      normals[vi + 1] = sample.normal.y
      normals[vi + 2] = sample.normal.z

      // ARC LENGTH AND METRES, not 0..1. See the header.
      uvs[ui] = lat / tile
      uvs[ui + 1] = s / tile

      /*
       * Colour is driven by `surfaceAt`, not by a parallel table of its own.
       * §7 makes the surface under the kart gameplay information — "the player
       * learns what is under them without looking down" — and that only holds
       * if the thing they can see and the thing the tyre model reads cannot
       * drift apart. One source, queried twice.
       */
      const surface = track.surfaceAt(t, lat)
      const latFrac = Math.abs(frac)

      c.copy(cTarmac)

      if (surface === Surface.SandDrift) {
        // §3a distinguishes the sand-drifted EDGE from the wash's sand-over-
        // tarmac. Both are Surface.SandDrift; which one you are looking at is
        // a question of where across the road it is.
        target.copy(cSandEdge).lerp(cWash, 1 - smoothstep(0.35, 0.95, latFrac))
        c.lerp(target, 0.85)
      } else if (surface === Surface.Metal) {
        c.copy(cGrate)
      }

      /*
       * Rubber lay-down along the TRUE optimal line — §5a names the field, and
       * the field is `racingLine`, not a stripe down the middle. On a circuit
       * whose ideal line crosses the centre nine times a lap, a centred rubber
       * band is worse than none: it draws a second, wrong line for the player
       * to follow.
       */
      const offLine = Math.abs(lat - racing)
      c.lerp(cRubber, 0.8 * (1 - smoothstep(0.6, 1.9, offLine)))

      // The painted edge line, suppressed under kerbs — nobody paints a line
      // and then bolts a kerb over it.
      if (LINE_STATIONS.has(k) && surface !== Surface.Kerb) c.lerp(cLine, 0.9)

      colors[vi] = c.r
      colors[vi + 1] = c.g
      colors[vi + 2] = c.b
    }
  }

  let w = 0
  for (let r = 0; r < rings; r++) {
    for (let k = 0; k < stations - 1; k++) {
      const a = r * stations + k
      const b = a + 1
      const d = (r + 1) * stations + k
      const e = d + 1
      /*
       * Winding: (b-a) is +right and (d-a) is +tangent, and right × tangent is
       * +normal — so a,b,d is front-facing and a,d,b is a road you cannot see.
       * That failure has no symptom other than "the road is missing", because
       * the vertex normals are written explicitly and would light it correctly
       * if it were ever rasterised. Backface culling is what hides it, and the
       * draw call still shows up in `FrameStats`.
       */
      indices[w++] = a
      indices[w++] = b
      indices[w++] = d
      indices[w++] = b
      indices[w++] = e
      indices[w++] = d
    }
  }

  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(positions, 3))
  geo.setAttribute('normal', new BufferAttribute(normals, 3))
  geo.setAttribute('uv', new BufferAttribute(uvs, 2))
  geo.setAttribute('color', new BufferAttribute(colors, 3))
  geo.setIndex(new BufferAttribute(indices, 1))
  geo.computeBoundingSphere()

  const maps = makeRoadSurface(opts.textureSize, opts.rng.fork('surface'), opts.anisotropy)
  /*
   * The toolkit leaves `repeat` at 1,1 and that is exactly right here: the
   * tiling is already in the UVs, in metres. Setting a repeat on top would
   * multiply it and put the aggregate back out of scale — the same class of
   * mistake as the 50:1 stretch, just in the other direction.
   */

  const mat = new MeshStandardMaterial({
    /*
     * White, and it is NOT an albedo. §3 bans pure white as a surface colour;
     * this is the multiplier three.js applies to the vertex colour, and the
     * vertex colours above are the actual §3a palette. Anything other than
     * white here silently tints the whole road.
     */
    color: 0xffffff,
    vertexColors: true,
    metalness: 0.0,
    /*
     * 1.0 BECAUSE there is a roughnessMap. It MULTIPLIES this value rather than
     * replacing it — a "sensible" 0.62 here would scale a map carrying 0.48 to
     * 0.85 down to 0.30-0.53 and no amount of retuning the noise field would
     * show up. Same applies to metalnessMap and aoMap.
     */
    roughness: 1.0,
    roughnessMap: maps.roughnessMap,
    normalMap: maps.normalMap,
    normalScale: new Vector2(maps.normalScale, maps.normalScale),
  })

  const mesh = new Mesh(geo, mat)
  mesh.name = 'road'
  mesh.receiveShadow = true
  // Not a caster. A near-flat surface lit at 12° self-shadows into acne long
  // before it throws anything useful, and the things that matter — kerbs,
  // karts, cliffs — are all casters in their own right.
  mesh.castShadow = false
  return mesh
}

// ---------------------------------------------------------------------------
// The boost pad decal
// ---------------------------------------------------------------------------

/*
 * A BOOST PAD HAS TO SAY "DRIVE THROUGH HERE, POINTING THIS WAY".
 *
 * The old one was a flat untextured quad of one saturated colour. At the
 * vanishing point of a dark canyon that is not a surface, it is a hole — which
 * is literally how it was first reported. A flat rectangle carries no direction,
 * no scale and no edge, so nothing about it says which way to cross it or where
 * it begins.
 *
 * So the pad is drawn from a generated decal with four parts, and each one is
 * doing a job:
 *
 *   chevrons     direction. Arrowheads whose apex leads and whose legs trail
 *                back toward both edges, so the arrow points the way you drive
 *                from every angle you can see it from.
 *   edge rails   width. Two continuous bright lines say "the fast bit is
 *                between these", which a field of arrows alone does not.
 *   outline      contrast. A dark border all the way round. Without it the pad
 *                shares a boundary with the tarmac and dissolves into it at the
 *                distance you actually need to read it from.
 *   end bars     a solid bright bar at the leading edge and a thin dim one at
 *                the trailing edge. Asymmetric ON PURPOSE: a symmetric pad tells
 *                you where it is but not which end you are approaching.
 *
 * All four are baked into one 2-channel decal instead of geometry, because
 * geometry crisp enough for a chevron edge costs vertices per pad and still
 * smears under vertex-colour interpolation, whereas a texel edge is a texel
 * edge. There are no image files in this repository, so the decal is generated —
 * see `makeBoostDecal`.
 *
 * ON THE UV RULE AT THE TOP OF THIS FILE. The road gets UVs in metres because it
 * is 900 m of unbounded surface whose width changes, and a normalised UV there
 * is the 50:1 texel stretch that comment exists to prevent. A pad is the
 * opposite kind of thing: a discrete 18–22 m OBJECT with a start, an end and a
 * fixed number of arrows on it. Its UVs are 0..1 across the object, so every pad
 * carries the same eight chevrons and the same end bars regardless of how long
 * or wide `surfaceAt` says it is, and nothing has to meet itself at a seam. The
 * decal is 1:4, which puts the texels within a few percent of square on the pads
 * this circuit actually has.
 */

/** Decal layout, in pad space. `q` is |lateral| as a fraction of the pad's half
 *  width; `v` runs 0 at the leading edge to 1 at the trailing edge. */
const PAD_OUTLINE_Q = 0.945
const PAD_RAIL_Q = 0.855
const PAD_OUTLINE_V = 0.008
const PAD_LEAD_V0 = 0.008
const PAD_LEAD_V1 = 0.055
const PAD_TRAIL_V0 = 0.962
const PAD_TRAIL_V1 = 0.992
const PAD_CHEV_V0 = 0.175
const PAD_CHEV_V1 = 0.95
const PAD_CHEV_COUNT = 6
/**
 * How far a chevron's legs trail back by the time they reach the rail.
 *
 * MEASURED, not guessed. The first pass used 0.052 — about 25° of sweep in plan,
 * which is a perfectly good arrow when you are standing on the pad and a row of
 * ladder rungs from 18 m back, because a ground plane seen from 2.4 m up
 * compresses the along-road axis by roughly 8:1 at that distance and the sweep
 * goes with it. 0.115 of ~20 m against a ~2.1 m half width is 48° in plan, which
 * still reads as an arrow after that compression. It was legible in the frame at
 * 45 m, which is where the player needs the answer.
 */
const PAD_CHEV_SWEEP = 0.115
/** Fraction of a chevron period that is ink. */
const PAD_CHEV_DUTY = 0.44

/*
 * §9a caps highlight pixels (luma ≥ 0.95) at 2% of frame and clipping at 0.05%.
 * The old pad ran emissiveIntensity 1.4 across ITS ENTIRE AREA, on a saturated
 * near-white colour, for three stretches of a lap. Two things changed:
 *
 *   - the intensity came down to 0.5, and
 *   - it is masked, so the bright part is the chevrons, the rails and the
 *     leading bar — roughly a quarter of the pad — while the deck sits at 0.13
 *     and the outline at zero.
 *
 * Peak emissive is now 36% of what it was over about a quarter of the area, and
 * the pad `receiveShadow`s, so it goes dark in shade like the paint it is. It
 * still lights itself in the arch, where one of the three pads lives with no sun
 * on it at all: 0.5 against a deep-overhang niche at luma 0.070 is not subtle.
 * This is a bright painted surface, not a light source.
 */
const PAD_EMISSIVE = 0.5
const PAD_EM_DECK = 0.2
const PAD_EM_RAIL = 0.86
const PAD_EM_CHEV = 1.0
const PAD_EM_LEAD = 1.0
const PAD_EM_TRAIL = 0.42

interface BoostDecal {
  readonly map: DataTexture
  readonly emissiveMap: DataTexture
}

/** sRGB byte triple from a palette hex. The decal is authored and blended in
 *  display space, which is what its sRGB `colorSpace` tag then declares. */
function srgbBytes(hex: number): readonly [number, number, number] {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255]
}

/** Rising edge at `edge`, `half` wide either side. */
function band(x: number, lo: number, hi: number, half: number): number {
  return smoothstep(lo - half, lo + half, x) * (1 - smoothstep(hi - half, hi + half, x))
}

function padTexture(w: number, h: number, data: Uint8Array, anisotropy: number): DataTexture {
  const tex = new DataTexture(data, w, h, RGBAFormat)
  // CLAMPED, not repeating. The outline is the first and last row and column of
  // the image; a repeating wrap would filter the leading bar into the trailing
  // one and put a ghost arrow outside the pad.
  tex.wrapS = ClampToEdgeWrapping
  tex.wrapT = ClampToEdgeWrapping
  tex.magFilter = LinearFilter
  tex.minFilter = LinearMipmapLinearFilter
  tex.generateMipmaps = true
  // The pad is a ground plane read at a 12° sun and a chase-camera grazing
  // angle. Without anisotropy the chevrons mip into a smear at exactly the
  // distance the player needs them from.
  tex.anisotropy = anisotropy
  tex.needsUpdate = true
  return tex
}

/**
 * Generate the pad decal: albedo, and a separate emissive mask.
 *
 * Two maps rather than one, because they genuinely disagree. The outline needs
 * albedo (it is dark paint, and dark paint is visible) and zero emissive (an
 * outline that glows is not an outline). The deck needs a healthy albedo and
 * almost no emissive. Sharing one image would force the pad to glow in
 * proportion to how light it is, which is the flat-sticker look all over again.
 */
function makeBoostDecal(width: number, rng: RNG, anisotropy: number): BoostDecal {
  const height = width * 4
  const grain = createNoise2D(rng)
  const fleck = createNoise2D(rng.fork('fleck'))

  const albedo = new Uint8Array(width * height * 4)
  const emissive = new Uint8Array(width * height * 4)

  const deck = srgbBytes(COL_BOOST_DECK)
  const signal = srgbBytes(COL_BOOST)
  const edge = srgbBytes(COL_BOOST_EDGE)
  const lead = srgbBytes(COL_BOOST_LEAD)

  /*
   * Antialiasing half-widths: one and a half texels on each axis, CAPPED at a
   * third of the narrowest feature. Anything narrower crawls when the pad is
   * moving; anything wider is a soft-edged sticker, which is the thing being
   * fixed. The cap is what makes `low` survive — at 32 texels across, a plain
   * 1.5-texel ramp is wider than the 0.055 outline band and dissolves it, so the
   * one feature holding the pad apart from the tarmac would go missing on
   * exactly the devices that need the help. Hard edges plus the mip chain are
   * the right failure there, not mush.
   *
   * `q` spans 0..1 over half the texels `u` does, hence the 2x.
   */
  const aaV = Math.min(1.5 / height, PAD_OUTLINE_V / 3)
  const aaQ = Math.min(3.0 / width, (1 - PAD_OUTLINE_Q) / 3)
  const period = (PAD_CHEV_V1 - PAD_CHEV_V0) / PAD_CHEV_COUNT
  const aaF = aaV / period

  const rgb = [0, 0, 0]

  for (let y = 0; y < height; y++) {
    // DataTexture does not flip, so row 0 is v = 0 is the LEADING edge. Getting
    // that backwards points every arrow on the circuit the wrong way, and it is
    // not visible in the generated image on its own.
    const v = (y + 0.5) / height
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width
      const q = Math.abs(u * 2 - 1)

      const mOutline = Math.max(
        smoothstep(PAD_OUTLINE_Q - aaQ, PAD_OUTLINE_Q + aaQ, q),
        1 - smoothstep(PAD_OUTLINE_V - aaV, PAD_OUTLINE_V + aaV, v),
        smoothstep(1 - PAD_OUTLINE_V - aaV, 1 - PAD_OUTLINE_V + aaV, v),
      )
      const inside = 1 - mOutline
      const mRail = smoothstep(PAD_RAIL_Q - aaQ, PAD_RAIL_Q + aaQ, q) * inside
      const mLead = band(v, PAD_LEAD_V0, PAD_LEAD_V1, aaV) * inside
      const mTrail = band(v, PAD_TRAIL_V0, PAD_TRAIL_V1, aaV) * inside

      /*
       * The chevron. `p` shears the pattern coordinate by the lateral distance
       * from the centreline, so a stripe of constant `p` sits at
       * `v = p - sweep * q`: furthest forward at the centre, trailing back
       * toward both edges. That is an arrowhead pointing along +v, which is the
       * direction of travel. The sign of `sweep` is the whole thing — flip it
       * and every pad on the circuit points backward.
       */
      const p = v + PAD_CHEV_SWEEP * q
      const f = (((p - PAD_CHEV_V0) / period) % 1 + 1) % 1
      // Fold to a signed distance from the middle of the ink, so both edges of
      // the stripe antialias with one smoothstep and neither wraps.
      const half = PAD_CHEV_DUTY * 0.5
      const sd = half - Math.abs(f - half)
      const mChev =
        smoothstep(-aaF, aaF, sd) *
        band(p, PAD_CHEV_V0, PAD_CHEV_V1, aaV) *
        inside *
        (1 - mRail) *
        (1 - mLead) *
        (1 - mTrail)

      rgb[0] = deck[0]
      rgb[1] = deck[1]
      rgb[2] = deck[2]
      let em = PAD_EM_DECK

      const mix = (c: readonly [number, number, number], k: number, e: number): void => {
        if (k <= 0) return
        rgb[0] = rgb[0]! + (c[0] - rgb[0]!) * k
        rgb[1] = rgb[1]! + (c[1] - rgb[1]!) * k
        rgb[2] = rgb[2]! + (c[2] - rgb[2]!) * k
        em += (e - em) * k
      }

      mix(signal, mChev, PAD_EM_CHEV)
      mix(signal, mRail, PAD_EM_RAIL)
      mix(lead, mLead, PAD_EM_LEAD)
      mix(signal, mTrail, PAD_EM_TRAIL)
      // Outline last: it wins over anything that ran to the border.
      mix(edge, mOutline, 0)

      /*
       * §9b: no perfectly uniform region anywhere, and a painted pad is a prime
       * offender — the deck between two chevrons is otherwise a single exact
       * value over a couple of square metres. Wear and grit, applied to albedo
       * and emissive together so the paint looks worn rather than lit unevenly.
       * Amplitude is small; this is not camouflage.
       */
      const wear =
        grain(u * 6, v * 26) * 0.6 + fleck(u * 27, v * 110) * 0.4
      const albedoGain = 1 + wear * 0.1
      const emGain = 1 + wear * 0.14

      const i = (y * width + x) * 4
      for (let ch = 0; ch < 3; ch++) {
        albedo[i + ch] = Math.round(Math.min(255, Math.max(0, rgb[ch]! * albedoGain)))
      }
      albedo[i + 3] = 255
      const e = Math.round(Math.min(255, Math.max(0, em * emGain * 255)))
      emissive[i] = e
      emissive[i + 1] = e
      emissive[i + 2] = e
      emissive[i + 3] = 255
    }
  }

  const map = padTexture(width, height, albedo, anisotropy)
  // Albedo is colour data. The emissive mask is an intensity, but three.js
  // decodes `emissiveMap` as colour regardless, so both carry the same tag and
  // PAD_EMISSIVE is tuned against the decoded value rather than the byte.
  map.colorSpace = SRGBColorSpace
  const emissiveMap = padTexture(width, height, emissive, anisotropy)
  emissiveMap.colorSpace = SRGBColorSpace
  return { map, emissiveMap }
}

// ---------------------------------------------------------------------------
// Kerbs, the start line, and the surface overlays
// ---------------------------------------------------------------------------

interface Placement {
  readonly matrix: Matrix4
}

/**
 * Everything instanced, in one walk of the circuit.
 *
 * Kerbs, boost pads and the cattle grid are all discovered by ASKING
 * `surfaceAt`, never by re-declaring where they are. `track.ts` owns those
 * regions; a second copy of the table here is a copy that goes stale silently,
 * and the failure — a boost pad you can see but not trigger, or trigger but not
 * see — is exactly the kind a screenshot review cannot catch.
 */
function buildInstanced(track: ITrack, opts: RoadBuildOptions): Object3D[] {
  const out: Object3D[] = []
  const sample = newSample()
  const basis = new Matrix4()
  const scale = new Vector3()
  const backward = new Vector3()
  const pos = new Vector3()

  const kerbLight: Placement[] = []
  const kerbDark: Placement[] = []
  const grates: Placement[] = []

  const stepCount = Math.max(8, Math.round(track.length / KERB_BLOCK))
  const step = track.length / stepCount

  // Per-step pad extent, still discovered by probing `surfaceAt`. Kept as a
  // parallel array rather than a per-step mesh because the pad is now one
  // continuous ribbon and needs to know where its run starts and ends.
  const padHit = new Uint8Array(stepCount)
  const padLo = new Float64Array(stepCount)
  const padHi = new Float64Array(stepCount)

  const place = (
    lateral: number,
    liftAlongNormal: number,
    width: number,
    height: number,
    len: number,
  ): Placement => {
    backward.copy(sample.tangent).multiplyScalar(-1)
    basis.makeBasis(sample.right, sample.normal, backward)
    basis.scale(scale.set(width, height, len))
    pos
      .copy(sample.position)
      .addScaledVector(sample.right, lateral)
      .addScaledVector(sample.normal, liftAlongNormal)
    basis.setPosition(pos)
    return { matrix: basis.clone() }
  }

  for (let i = 0; i < stepCount; i++) {
    const t = i / stepCount
    track.sample(t, sample)
    const hw = sample.halfWidth

    // --- kerbs, both edges ---------------------------------------------------
    for (let side = -1; side <= 1; side += 2) {
      if (track.surfaceAt(t, side * (hw - KERB_BAND * 0.5)) !== Surface.Kerb) continue
      // Sunk 2 cm so the block reads as bolted to the road rather than resting
      // on it; the visible rise is 11 cm, which is what a kart can ride.
      const p = place(side * (hw - KERB_BAND * 0.5), KERB_HEIGHT * 0.5 - 0.02, KERB_BAND, KERB_HEIGHT, step * 0.94)
      // Stripe by absolute block index so the two sides stay in phase across
      // the road; alternating per side makes the kerbs look sheared in plan.
      if (i % 2 === 0) kerbLight.push(p)
      else kerbDark.push(p)
    }

    // --- boost pads and the culvert grate ------------------------------------
    // Probed laterally rather than declared. 0.4 m probes: finer than the
    // narrowest region either produces, coarse enough to stay cheap.
    let padMin = Infinity
    let padMax = -Infinity
    let grateMin = Infinity
    let grateMax = -Infinity
    for (let lat = -hw; lat <= hw; lat += PAD_PROBE) {
      const surface = track.surfaceAt(t, lat)
      if (surface === Surface.BoostPad) {
        if (lat < padMin) padMin = lat
        if (lat > padMax) padMax = lat
      } else if (surface === Surface.Metal) {
        if (lat < grateMin) grateMin = lat
        if (lat > grateMax) grateMax = lat
      }
    }
    if (padMax >= padMin) {
      padHit[i] = 1
      padLo[i] = padMin
      padHi[i] = padMax
    }
    if (grateMax > grateMin) {
      grates.push(
        place((grateMin + grateMax) * 0.5, 0.008, grateMax - grateMin + 0.4, 0.016, step * 0.96),
      )
    }
  }

  // --- start line -----------------------------------------------------------
  /*
   * Fourteen alternating blocks across the road, riding on the kerb meshes
   * rather than asking for their own draw call and their own checker texture.
   * §3a's kerb pair is a 6.4:1 luma ratio, the highest-contrast pair in the
   * environment palette, so it is already the right ink for a start line.
   */
  {
    // t = 0 exactly. `checkpoints[0]` is 0 and a lap counts on crossing it, so
    // a line painted "just past" the logical line is a line that lies to the
    // player by however far past it was painted.
    const t = 0
    track.sample(t, sample)
    const hw = sample.halfWidth
    const blocks = 14
    const bw = (hw * 2) / blocks
    for (let k = 0; k < blocks; k++) {
      const lateral = -hw + bw * (k + 0.5)
      const p = place(lateral, 0.015, bw * 0.96, 0.03, 1.4)
      if (k % 2 === 0) kerbLight.push(p)
      else kerbDark.push(p)
    }
  }

  const unitBox = new BoxGeometry(1, 1, 1)

  const emit = (
    name: string,
    placements: readonly Placement[],
    mat: MeshStandardMaterial,
    shadows: boolean,
  ): void => {
    if (placements.length === 0) {
      mat.dispose()
      return
    }
    const mesh = new InstancedMesh(unitBox, mat, placements.length)
    mesh.name = name
    mesh.castShadow = shadows
    mesh.receiveShadow = shadows
    for (let i = 0; i < placements.length; i++) mesh.setMatrixAt(i, placements[i]!.matrix)
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
    out.push(mesh)
  }

  // §5a: kerb roughness 0.44. No roughnessMap on these, so 0.44 is the literal
  // value and NOT the 1.0 the mapped materials above have to carry.
  emit(
    'kerb-light',
    kerbLight,
    new MeshStandardMaterial({ color: COL_KERB_LIGHT, roughness: 0.44, metalness: 0.0 }),
    true,
  )
  emit(
    'kerb-dark',
    kerbDark,
    new MeshStandardMaterial({ color: COL_KERB_DARK, roughness: 0.44, metalness: 0.0 }),
    true,
  )
  emit(
    'cattle-grid',
    grates,
    new MeshStandardMaterial({ color: COL_GRATE, roughness: 0.5, metalness: 0.7 }),
    true,
  )

  if (out.length === 0) unitBox.dispose()

  const pads = buildBoostPads(track, collectPadSpans(track, padHit, padLo, padHi), opts)
  if (pads) out.push(pads)
  return out
}

// ---------------------------------------------------------------------------
// Boost pads
// ---------------------------------------------------------------------------

/** Lateral probe pitch used to discover pads. See `collectPadSpans`. */
const PAD_PROBE: Metres = 0.4
/** Longitudinal spacing of the pad ribbon's rings. */
const PAD_ROW_SPACING: Metres = 1.0
/** Lateral stations across a pad. The decal carries every crisp feature, so
 *  these exist only to follow the road's bank and curvature across ~5 m. */
const PAD_STATIONS = 9
/**
 * Height of the pad's top face above the road, along the road normal.
 *
 * Not a taste value, the same argument as `ROAD_EDGE_DROP`. The road ribbon
 * rings every `RING_SPACING` = 2 m and the pad rings every 1 m; both are
 * polylines through the same curve with different phases, so through a vertical
 * dip the road's coarser chord can sit above the pad's finer one by up to the
 * 2 m sagitta, `RING_SPACING² · curvature / 8`. 3.5 cm covers every vertical
 * radius down to 14 m, which is a ramp, not a road. Below that the pad does not
 * z-fight — it disappears under the tarmac, and no screenshot review catches a
 * pad that is simply not there.
 */
const PAD_LIFT: Metres = 0.035
/** How far the skirt runs below the road. Buried, so the rim cannot z-fight. */
const PAD_SKIRT_DROP: Metres = 0.02

/** A discovered pad: a rectangle in `(t, lateral)`, exactly as `surfaceAt`
 *  reports it. `t1` may exceed 1 where a pad crosses the start line. */
interface PadSpan {
  readonly t0: number
  readonly t1: number
  readonly lat0: Metres
  readonly lat1: Metres
}

/**
 * Walk in from a point known to be outside the pad toward one known to be
 * inside, and return the innermost boundary the test still passes at.
 *
 * Fourteen halvings takes the 1 m longitudinal step to 61 µm and the 0.4 m
 * lateral probe to 24 µm, which is exact for this purpose. The result is always
 * a point that IS inside, so the drawn pad is a subset of the triggering pad and
 * never the other way round.
 */
function bisectInward(
  outside: number,
  inside: number,
  isInside: (x: number) => boolean,
): number {
  let lo = outside
  let hi = inside
  for (let n = 0; n < 14; n++) {
    const mid = (lo + hi) * 0.5
    if (isInside(mid)) hi = mid
    else lo = mid
  }
  return hi
}

/**
 * Group the per-step probe hits into pads, then sharpen every edge.
 *
 * THE CONSTRAINT THIS FILE HAS ALWAYS HAD, AND WHY THE BISECTION IS PART OF IT.
 *
 * Pads are found by asking `surfaceAt`, never by a second copy of `track.ts`'s
 * table — see the note on `buildInstanced`. The failure that prevents is a pad
 * you can see but not trigger, or trigger but not see. Asking is necessary but
 * it is not sufficient: the probe grid is 1 m along the road and 0.4 m across
 * it, so a pad discovered by grid alone is drawn up to a metre short at each end
 * and up to 0.4 m narrow at each side. The old code papered over the lateral
 * half of that by adding a flat 0.4 m to the width, which overshoots as often as
 * it undershoots.
 *
 * So each of the four edges is bisected against `surfaceAt` itself. The drawn
 * rectangle then agrees with the triggering rectangle to well under a
 * millimetre, and it agrees because it was measured, not because two tables
 * happen to match today.
 */
function collectPadSpans(
  track: ITrack,
  hit: Uint8Array,
  lo: Float64Array,
  hi: Float64Array,
): PadSpan[] {
  const steps = hit.length
  const spans: PadSpan[] = []

  let scanned = 0
  // Start the scan at a step that is NOT a pad, so a pad straddling t = 0 is
  // found as one run rather than as two half-pads with a butt joint on the
  // start line. If every step is a pad something is very wrong; bail rather
  // than loop.
  let start = 0
  while (start < steps && hit[start] === 1) start++
  if (start === steps) return spans

  for (let n = 0; n < steps; n++) {
    const i = (start + n) % steps
    if (hit[i] === 0) continue
    if (n < scanned) continue

    let len = 0
    let latLo = Infinity
    let latHi = -Infinity
    while (len < steps && hit[(start + n + len) % steps] === 1) {
      const j = (start + n + len) % steps
      if (lo[j]! < latLo) latLo = lo[j]!
      if (hi[j]! > latHi) latHi = hi[j]!
      len++
    }
    scanned = n + len

    // Grid t values, in an unwrapped frame so arithmetic across t = 0 is plain
    // addition. `track.sample` and `track.surfaceAt` both wrap for us.
    const tIn0 = (start + n) / steps
    const tIn1 = (start + n + len - 1) / steps
    const tOut0 = tIn0 - 1 / steps
    const tOut1 = tIn1 + 1 / steps
    const mid = (latLo + latHi) * 0.5

    const t0 = bisectInward(tOut0, tIn0, (t) => track.surfaceAt(t, mid) === Surface.BoostPad)
    const t1 = bisectInward(tOut1, tIn1, (t) => track.surfaceAt(t, mid) === Surface.BoostPad)
    const tMid = (t0 + t1) * 0.5
    const lat0 = bisectInward(
      latLo - PAD_PROBE,
      latLo,
      (x) => track.surfaceAt(tMid, x) === Surface.BoostPad,
    )
    const lat1 = bisectInward(
      latHi + PAD_PROBE,
      latHi,
      (x) => track.surfaceAt(tMid, x) === Surface.BoostPad,
    )

    if (t1 > t0 && lat1 > lat0) spans.push({ t0, t1, lat0, lat1 })
  }

  return spans
}

/**
 * One mesh, one material, one draw call, all pads.
 *
 * Merged rather than one mesh per pad: three meshes would cull individually and
 * save nothing worth having — a pad is ~500 triangles — while costing two of the
 * five draw calls this file is allowed. The road itself is one circuit-spanning
 * mesh for the same reason.
 *
 * The ribbon is a top face plus a skirt down past the road. The skirt is what
 * makes the leading edge an EDGE rather than a printed line: it catches the 12°
 * sun on one side and shades on the other, so the pad reads as a plate bolted to
 * the road from any angle. Its UVs are pinned to the decal's border, so it is
 * the outline colour all the way round without needing a second material.
 */
function buildBoostPads(
  track: ITrack,
  spans: readonly PadSpan[],
  opts: RoadBuildOptions,
): Mesh | null {
  if (spans.length === 0) return null

  const position: number[] = []
  const normal: number[] = []
  const uv: number[] = []
  const index: number[] = []

  const sample = newSample()
  const p = new Vector3()
  const sideNormal = new Vector3()
  const endNormal = new Vector3()

  const push = (x: Vector3, n: Vector3, u: number, v: number): number => {
    position.push(x.x, x.y, x.z)
    normal.push(n.x, n.y, n.z)
    uv.push(u, v)
    return position.length / 3 - 1
  }

  for (const span of spans) {
    const length = (span.t1 - span.t0) * track.length
    const rows = Math.max(4, Math.round(length / PAD_ROW_SPACING)) + 1
    const centre = (span.lat0 + span.lat1) * 0.5
    const half = (span.lat1 - span.lat0) * 0.5

    const base = position.length / 3
    // Skirt rings are interleaved with the top ring, row by row, so a row of the
    // ribbon is `PAD_STATIONS` top vertices followed by two skirt vertices —
    // one per side. Everything below indexes off `row(r)`.
    const stride = PAD_STATIONS + 2
    const row = (r: number): number => base + r * stride

    for (let r = 0; r < rows; r++) {
      const t = span.t0 + ((span.t1 - span.t0) * r) / (rows - 1)
      track.sample(t, sample)
      const v = r / (rows - 1)

      for (let k = 0; k < PAD_STATIONS; k++) {
        const u = k / (PAD_STATIONS - 1)
        p.copy(sample.position)
          .addScaledVector(sample.right, centre + (u * 2 - 1) * half)
          .addScaledVector(sample.normal, PAD_LIFT)
        push(p, sample.normal, u, v)
      }

      // The two side-skirt bottoms. Same lateral position as the outer top
      // vertices, dropped below the road, normal pointing outboard.
      for (const side of [-1, 1] as const) {
        p.copy(sample.position)
          .addScaledVector(sample.right, centre + side * half)
          .addScaledVector(sample.normal, -PAD_SKIRT_DROP)
        sideNormal.copy(sample.right).multiplyScalar(side)
        push(p, sideNormal, side < 0 ? 0 : 1, v)
      }
    }

    // --- top face ----------------------------------------------------------
    /*
     * Winding matches the road's, and for the same reason: `+u` is `+right` and
     * `+v` is `+tangent`, and right × tangent is +normal, so a,b,d faces up. A
     * pad wound the other way is invisible and still costs its draw call.
     */
    for (let r = 0; r < rows - 1; r++) {
      for (let k = 0; k < PAD_STATIONS - 1; k++) {
        const a = row(r) + k
        const b = a + 1
        const d = row(r + 1) + k
        const e = d + 1
        index.push(a, b, d, b, e, d)
      }
    }

    // --- side skirts -------------------------------------------------------
    for (let r = 0; r < rows - 1; r++) {
      // Left: outward is -right.
      const lt0 = row(r)
      const lt1 = row(r + 1)
      const lb0 = row(r) + PAD_STATIONS
      const lb1 = row(r + 1) + PAD_STATIONS
      index.push(lt0, lt1, lb0, lt1, lb1, lb0)
      // Right: outward is +right, so the winding mirrors.
      const rt0 = row(r) + PAD_STATIONS - 1
      const rt1 = row(r + 1) + PAD_STATIONS - 1
      const rb0 = row(r) + PAD_STATIONS + 1
      const rb1 = row(r + 1) + PAD_STATIONS + 1
      index.push(rt0, rb0, rt1, rt1, rb0, rb1)
    }

    // --- leading and trailing skirts ---------------------------------------
    for (const end of [0, rows - 1] as const) {
      const leading = end === 0
      const t = span.t0 + (leading ? 0 : span.t1 - span.t0)
      track.sample(t, sample)
      endNormal.copy(sample.tangent).multiplyScalar(leading ? -1 : 1)
      const v = leading ? 0 : 1

      const first = position.length / 3
      for (let k = 0; k < PAD_STATIONS; k++) {
        const u = k / (PAD_STATIONS - 1)
        p.copy(sample.position)
          .addScaledVector(sample.right, centre + (u * 2 - 1) * half)
          .addScaledVector(sample.normal, -PAD_SKIRT_DROP)
        push(p, endNormal, u, v)
      }
      for (let k = 0; k < PAD_STATIONS - 1; k++) {
        const top0 = row(end) + k
        const top1 = row(end) + k + 1
        const bot0 = first + k
        const bot1 = first + k + 1
        if (leading) index.push(top0, bot0, top1, top1, bot0, bot1)
        else index.push(top0, top1, bot0, top1, bot1, bot0)
      }
    }
  }

  const geo = new BufferGeometry()
  geo.setAttribute('position', new BufferAttribute(new Float32Array(position), 3))
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(normal), 3))
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2))
  geo.setIndex(index)
  geo.computeBoundingSphere()

  /*
   * Decal resolution tracks the quality profile, but 128 x 512 is the ceiling
   * and it is plenty: at ~5 m x 20 m that is 3.9 cm per texel on both axes, so
   * a chevron edge is already finer than the anisotropic filter can resolve at
   * the distance the pad has to be read from. Two RGBA maps at that size are
   * 512 kB, against §9's 40 MB texture budget on `low` — where this drops to
   * 64 x 256 and 128 kB. 64 is the floor rather than 32 because the outline is
   * 5.5% of the width, and below 64 that is under two texels.
   */
  const decalWidth = Math.max(64, Math.min(128, Math.round(opts.textureSize / 8)))
  const decal = makeBoostDecal(decalWidth, opts.rng.fork('boost'), opts.anisotropy)

  const mesh = new Mesh(
    geo,
    new MeshStandardMaterial({
      /*
       * White for the same reason the road's is: this multiplies the decal, and
       * the decal carries the §4b palette. Any other value tints every pad.
       */
      color: 0xffffff,
      map: decal.map,
      emissive: COL_BOOST,
      emissiveMap: decal.emissiveMap,
      emissiveIntensity: PAD_EMISSIVE,
      // Paint over tarmac: smoother than the road's 0.48-0.85, not a mirror.
      roughness: 0.5,
      metalness: 0.0,
    }),
  )
  mesh.name = 'boost-pad'
  // Receives, and this is load-bearing rather than housekeeping: the arch pad
  // and every pad under a cliff shadow have to go dark with the road around
  // them. A decal that ignores shadow is a decal that reads as a light source,
  // which is the half of the defect the colour change does not fix.
  mesh.receiveShadow = true
  // A 3.5 cm plate casts nothing worth a shadow-map slot.
  mesh.castShadow = false
  return mesh
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Build the road surface and its kerbs for `track` and return them under one
 * node. The caller owns the node; `world/track` parents it into `ITrack.group`.
 *
 * Nothing here draws outboard of ±halfWidth — the ground beside the road is
 * terrain.ts's apron. See the ownership note at the top of the file.
 */
export function buildRoad(track: ITrack, opts: RoadBuildOptions): Object3D {
  const root = new Object3D()
  root.name = 'road-group'
  root.add(buildRoadSurface(track, opts))
  for (const node of buildInstanced(track, opts)) root.add(node)
  return root
}

/**
 * Free everything `buildRoad` created, including the procedural textures.
 *
 * The harness creates and destroys the world repeatedly — every `resetRace`
 * with a new seed rebuilds it — so a texture leaked here is leaked once per
 * reset, and the failure shows up as a phone dying two-thirds of the way
 * through §10c criterion 8 rather than as anything that looks like a leak.
 */
export function disposeRoad(root: Object3D): void {
  root.traverse((node) => {
    const mesh = node as Partial<Mesh>
    if (mesh.geometry) mesh.geometry.dispose()
    const material = mesh.material
    if (!material) return
    const list = Array.isArray(material) ? material : [material]
    for (const m of list) {
      const standard = m as MeshStandardMaterial
      standard.map?.dispose()
      standard.roughnessMap?.dispose()
      standard.normalMap?.dispose()
      // The boost pad's decal. Missed on the first pass, and a texture leaked
      // here is leaked once per `resetRace` — see the note above.
      standard.emissiveMap?.dispose()
      m.dispose()
    }
  })
}
