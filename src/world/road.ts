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
 * an instance, and the start-line blocks ride on the kerb meshes rather than
 * asking for a sixth.
 *
 * Albedo variation lives in VERTEX COLOURS, not in extra materials. §5a wants
 * rubber lay-down along the true optimal line, sand drift creeping from both
 * edges and the wash's sand-over-tarmac bands; as four materials that is four
 * more draw calls and three seams. As vertex colour it is free and it blends.
 */

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
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
/** §4b reserved gameplay band. Boost is gameplay feedback, so this is legal
 *  here and illegal on every environment surface in this file. */
const COL_BOOST = 0x00ffa3

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
function buildInstanced(track: ITrack): Object3D[] {
  const out: Object3D[] = []
  const sample = newSample()
  const basis = new Matrix4()
  const scale = new Vector3()
  const backward = new Vector3()
  const pos = new Vector3()

  const kerbLight: Placement[] = []
  const kerbDark: Placement[] = []
  const boostPads: Placement[] = []
  const grates: Placement[] = []

  const stepCount = Math.max(8, Math.round(track.length / KERB_BLOCK))
  const step = track.length / stepCount

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
    for (let lat = -hw; lat <= hw; lat += 0.4) {
      const surface = track.surfaceAt(t, lat)
      if (surface === Surface.BoostPad) {
        if (lat < padMin) padMin = lat
        if (lat > padMax) padMax = lat
      } else if (surface === Surface.Metal) {
        if (lat < grateMin) grateMin = lat
        if (lat > grateMax) grateMax = lat
      }
    }
    if (padMax > padMin) {
      boostPads.push(
        place((padMin + padMax) * 0.5, 0.012, padMax - padMin + 0.4, 0.024, step * 0.96),
      )
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
    'boost-pad',
    boostPads,
    new MeshStandardMaterial({
      color: COL_BOOST,
      emissive: COL_BOOST,
      /*
       * 1.4, deliberately under §2's bloom threshold of 2.5 scene-linear. A pad
       * that blooms is a pad that hazes the whole road ahead of it under a 12°
       * sun, and §9a's clipping rows have no room for a light source that is on
       * for a third of the lap.
       */
      emissiveIntensity: 1.4,
      roughness: 0.35,
      metalness: 0.0,
    }),
    false,
  )
  emit(
    'cattle-grid',
    grates,
    new MeshStandardMaterial({ color: COL_GRATE, roughness: 0.5, metalness: 0.7 }),
    true,
  )

  if (out.length === 0) unitBox.dispose()
  return out
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
  for (const node of buildInstanced(track)) root.add(node)
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
      m.dispose()
    }
  })
}
