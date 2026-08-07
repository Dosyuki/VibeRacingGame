import { createNoise2D } from 'simplex-noise'
import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  DynamicDrawUsage,
  Euler,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix3,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  Object3D,
  Quaternion,
  RGBAFormat,
  SRGBColorSpace,
  Vector3,
} from 'three'

import type { Ctx, KartIdentity, KartState, Seconds } from '../types'

/**
 * THE KART — ART_DIRECTION §6, materials §5d, reserved band §4b.
 *
 * Everything here is generated. There is no model file, no texture file, and
 * there never will be one.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY EVERY EDGE IS FILLETED AND WHY THERE IS NOT ONE NORMAL MAP IN THE FILE
 *
 * §6 asks for a 0.012–0.020 m chamfer on every edge, and it is not decoration.
 * The sun is at 12° with an angular diameter of 0.53° — a small, hard source.
 * A true 90° edge under it has exactly two states: the face is in the light or
 * it is not, and the transition happens across zero pixels. That gives a blown
 * highlight on one side and nothing at all on the other, and the silhouette
 * stops reading as a solid object. A 16 mm fillet spreads the terminator over
 * two or three pixels at chase-camera distance, which is all it takes: the
 * edge rolls, the form reads, and the kart looks machined instead of extruded.
 *
 * So `loft()` below is the only box primitive in this file. It cannot make an
 * unchamfered edge — the corner radius is a required argument.
 *
 * The complementary half of that decision is the header of `procedural.ts`,
 * whose rule 2 says detail frequency is bounded by roughness, and which notes
 * that the rule "moved onto the kart". It is honoured here in the strongest
 * possible form: THIS FILE SHIPS NO NORMAL MAP AND NO HIGH-FREQUENCY ROUGHNESS
 * MAP. Chrome at roughness 0.18 and clearcoat at 0.07 under one very small very
 * bright sun is the worst specular-aliasing case in the project, worse than the
 * wet road ever was, because a kart is also the fastest-moving thing on screen.
 * Every piece of surface detail on this vehicle is GEOMETRY — fillets, tread
 * knobs, shoulder blocks, tube flares — which mipmaps cannot smear into
 * sparkle because it is resolved by the depth buffer, not by a texture fetch.
 *
 * The one texture is the livery decal, and it is albedo only, low frequency,
 * mipmapped and anisotropic. Albedo aliasing filters correctly; reflection
 * direction does not.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE roughnessMap TRAP, STATED SO THE NEXT PERSON DOES NOT PAY FOR IT AGAIN
 *
 * `roughnessMap` MULTIPLIES `material.roughness`. A material carrying one must
 * set `roughness = 1.0` or the map is crushed — 0.30 × a map averaging 0.4 is
 * 0.12, and two rounds of tuning the map will change nothing visible because
 * the scalar is doing all the work.
 *
 * This file sidesteps the trap rather than surviving it: roughness, metalness,
 * clearcoat and the dust blend are PER-VERTEX ATTRIBUTES, not maps, and the
 * three.js chunks that would apply a map are replaced outright. There is no
 * scalar left for a map to multiply. §5a's "kart paint 0.30 → 0.66, varied by
 * the dust accumulation layer" is then literally what the shader computes.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ONE MATERIAL, ONE PROGRAM, SIX DRAW CALLS
 *
 * §9 gives 250 draw calls for the whole frame and the world already spends ~45.
 * Eight karts cannot each afford a mesh per material class.
 *
 * So the six meshes below are the six things that need INDEPENDENT TRANSFORMS
 * (body, rim strips, driver, arms-on-the-wheel, mudflaps, wheels) and nothing
 * else. Paint, chrome, rubber, skin, visor tint and both emissive strips all
 * live in the same material, selected per vertex. Geometry is built once and
 * shared by every kart; only the material — ten palette colours, one decal
 * texture, one dust scalar, one rim colour — differs.
 */

// ---------------------------------------------------------------------------
// Chassis geometry — DUPLICATED FROM src/kart/kart.ts, ON PURPOSE, UNDER PROTEST
// ---------------------------------------------------------------------------
/**
 * `src/render/` may not import from `src/kart/` (CLAUDE.md, sibling imports are
 * banned) and `src/types.ts` does not carry the chassis dimensions, so there is
 * no legal channel for these six numbers. They are copied.
 *
 * That is a real hazard and it is worth naming: if anyone widens the track,
 * moves an axle or changes the suspension travel in `kart/`, the wheels drawn
 * here detach from the wheels being simulated and NOTHING REPORTS IT. The kart
 * will simply look slightly wrong in a way no harness gates on.
 *
 * The right fix is a `KartDimensions` block in the contract. That is a contract
 * widening, which is its own announced commit that re-runs every harness, so it
 * is not done as a side effect of building a model. Flagged in the report.
 */
const WHEEL_RADIUS = 0.36
const HALF_TRACK = 0.64
const FRONT_AXLE = 0.72
const REAR_AXLE = -0.68
const SUSPENSION_TRAVEL = 0.09
const REST_LENGTH = 0.205
const FULL_EXTENSION = REST_LENGTH + SUSPENSION_TRAVEL * 0.5

/** Body length, §6. Nose tip to tail, and the wheels are deliberately huge
 *  against it: 0.36 m radius on a 2.0 m car is a toy, not a go-kart. */
const BODY_LENGTH = 2.0
const NOSE_Z = -1.05
const TAIL_Z = NOSE_Z + BODY_LENGTH

/** §6: 0.012–0.020 m. Three sizes so parts of different mass read differently;
 *  a 20 mm roll on the main tub and a 12 mm roll on trim is a size cue. */
const FILLET_BIG = 0.02
const FILLET_MID = 0.016
const FILLET_SMALL = 0.012

/** ART_DIRECTION §1 — 1620 m centreline. Used only to pace the dust layer
 *  between lap events; `lap:complete` re-anchors it, so drift is bounded. */
const LAP_LENGTH = 1620

// ---------------------------------------------------------------------------
// Palette — ART_DIRECTION §3a and §4b
// ---------------------------------------------------------------------------
/*
 * Slot indices into the shader's `uPalette`. The livery slots are per kart; the
 * rest are constant, which is exactly why geometry can be shared — a vertex
 * stores WHICH colour it wants, never the colour itself.
 */
const SLOT_PRIMARY = 0
const SLOT_SECONDARY = 1
const SLOT_CHROME = 2
const SLOT_RUBBER = 3
const SLOT_SKIN = 4
const SLOT_VISOR = 5
const SLOT_TRIM = 6
const SLOT_SUIT = 7
const SLOT_FLOOR = 8
const SLOT_RIM = 9
const PALETTE_SIZE = 10

/** Nothing in §3 may ship pure black or pure white; every one of these carries
 *  hue, and every one sits in the environment bands (8°–43°, 205°–228°) so no
 *  part of a kart can be mistaken for a §4b gameplay signal. */
const COL_CHROME = 0xd6d0c4
const COL_RUBBER = 0x2b2724
const COL_SKIN = 0xb98a63
/** §6, exactly. */
const COL_VISOR = 0x2a3a4a
const COL_TRIM = 0x241f22
const COL_FLOOR = 0x4b4340
/** §5d — the dust accumulation colour. */
const COL_DUST = 0xcbb08a

/**
 * §4b, the reserved band, and these are the only hues in this file inside it.
 * Tier 3's entry is the CORONA `#ff2fd0`; the near-white core the table also
 * names comes from driving the intensity past the §9a bloom threshold of 2.5
 * scene-linear rather than from painting a second colour, which is what makes
 * the core white on screen without a second strip to keep in sync.
 */
const TIER_COLOUR = [0x00ffa3, 0x00ffa3, 0xb24bff, 0xff2fd0] as const
const TIER_RIM_INTENSITY = [0, 0.85, 1.9, 3.6] as const

/** §5d: underglow strip per racer, emissive 1.4, livery colours only. */
const UNDERGLOW_EMISSIVE = 1.4

/** §4c / §5d: the dust layer is clamped to zero within 0.12 m of any emissive
 *  strip. The rim light is the vehicle-mounted half of the drift-tier read and
 *  it must not silt up as the race goes on. */
const EMISSIVE_CLEAR_RADIUS = 0.12

/** §5d: 0.00 at the grid, saturating at 0.55 by the end of lap 3. */
const DUST_MAX = 0.55

// ---------------------------------------------------------------------------
// Geometry builder
// ---------------------------------------------------------------------------

/**
 * Per-vertex material description. This is what replaces having six materials.
 *
 * `dustFlat` exists for the tyres: the up-facing mask is baked at build time,
 * and a wheel rotates, so a baked mask would put the dust on the underside
 * half a revolution later. A tyre picks up sand all the way round anyway.
 */
interface Surf {
  readonly tint: number
  readonly rough: number
  readonly metal: number
  readonly clear: number
  readonly emissive: number
  readonly dust: number
  readonly dustFlat?: boolean
  readonly decal?: boolean
}

const S_PAINT: Surf = { tint: SLOT_PRIMARY, rough: 0.3, metal: 0, clear: 1, emissive: 0, dust: 1, decal: true }
const S_PAINT2: Surf = { ...S_PAINT, tint: SLOT_SECONDARY }
const S_PAINT_PLAIN: Surf = { tint: SLOT_PRIMARY, rough: 0.3, metal: 0, clear: 1, emissive: 0, dust: 1 }
const S_CHROME: Surf = { tint: SLOT_CHROME, rough: 0.18, metal: 1, clear: 0, emissive: 0, dust: 0.7 }
const S_RUBBER: Surf = { tint: SLOT_RUBBER, rough: 0.92, metal: 0, clear: 0, emissive: 0, dust: 0.55, dustFlat: true }
const S_TRIM: Surf = { tint: SLOT_TRIM, rough: 0.7, metal: 0, clear: 0, emissive: 0, dust: 0.9 }
const S_FLOOR: Surf = { tint: SLOT_FLOOR, rough: 0.66, metal: 0, clear: 0.15, emissive: 0, dust: 1 }
const S_SUIT: Surf = { tint: SLOT_SUIT, rough: 0.62, metal: 0, clear: 0, emissive: 0, dust: 0.9 }
const S_SKIN: Surf = { tint: SLOT_SKIN, rough: 0.55, metal: 0, clear: 0.05, emissive: 0, dust: 0.2 }
const S_VISOR: Surf = { tint: SLOT_VISOR, rough: 0.1, metal: 0, clear: 1, emissive: 0, dust: 0.12 }
const S_RIM: Surf = { tint: SLOT_RIM, rough: 0.3, metal: 0, clear: 0.4, emissive: 1, dust: 0 }
const S_UNDER: Surf = { tint: SLOT_PRIMARY, rough: 0.35, metal: 0, clear: 0.6, emissive: UNDERGLOW_EMISSIVE, dust: 0 }

const _bv = new Vector3()
const _bn = new Vector3()
const _bnm = new Matrix3()

class Build {
  readonly pos: number[] = []
  readonly nrm: number[] = []
  readonly tint: number[] = []
  /** rough, metal, clearcoat, emissive weight */
  readonly surf: number[] = []
  /** dust weight, decal mask, decal u, decal v */
  readonly misc: number[] = []
  readonly index: number[] = []

  private xf: Matrix4 | null = null

  /** Everything pushed until the next call is transformed by `m`. */
  transform(m: Matrix4 | null): void {
    this.xf = m
    if (m) _bnm.getNormalMatrix(m)
  }

  get count(): number {
    return this.pos.length / 3
  }

  vertex(s: Surf, x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
    _bv.set(x, y, z)
    _bn.set(nx, ny, nz)
    if (this.xf) {
      _bv.applyMatrix4(this.xf)
      _bn.applyMatrix3(_bnm)
    }
    _bn.normalize()
    this.pos.push(_bv.x, _bv.y, _bv.z)
    this.nrm.push(_bn.x, _bn.y, _bn.z)
    this.tint.push(s.tint)
    this.surf.push(s.rough, s.metal, s.clear, s.emissive)

    /*
     * §5d's dust mask, evaluated where the normal is known: an up-facing term
     * plus a leading-face term. Baking it as an attribute rather than deriving
     * it in the fragment shader is what lets the §4c emissive clamp below be a
     * geometric distance test instead of a second texture nobody can inspect.
     */
    let dust = s.dust
    if (!s.dustFlat) {
      const up = smoothstep(0.35, 0.8, _bn.y)
      const lead = Math.max(0, -_bn.z)
      dust *= Math.min(1, up + lead * 0.55)
    }
    const decal = s.decal === true ? 1 : 0
    this.misc.push(
      dust,
      decal,
      decal === 1 ? clamp01((_bv.z - NOSE_Z) / BODY_LENGTH) : 0.5,
      decal === 1 ? clamp01((_bv.y + 0.62) / 0.8) : 0.5,
    )
    return this.pos.length / 3 - 1
  }

  tri(a: number, b: number, c: number): void {
    // Zero-area triangles come out of the ring-to-cap transition where a fillet
    // collapses onto a corner. They cost no fill but they cost index bandwidth
    // and they inflate the triangle count this file is graded on, so drop them.
    if (a === b || b === c || a === c) return
    this.index.push(a, b, c)
  }

  /** Quad strip between two closed rings of equal length. `flip` reverses
   *  winding for the end where the sweep direction reverses. */
  ring(a: readonly number[], b: readonly number[], flip: boolean): void {
    const n = a.length
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const a0 = a[i]!
      const a1 = a[j]!
      const b0 = b[i]!
      const b1 = b[j]!
      if (this.same(a0, b0) && this.same(a1, b1)) continue
      if (flip) {
        this.tri(a0, b0, a1)
        this.tri(a1, b0, b1)
      } else {
        this.tri(a0, a1, b0)
        this.tri(a1, b1, b0)
      }
    }
  }

  private same(i: number, j: number): boolean {
    const p = this.pos
    return (
      Math.abs(p[i * 3]! - p[j * 3]!) < 1e-7 &&
      Math.abs(p[i * 3 + 1]! - p[j * 3 + 1]!) < 1e-7 &&
      Math.abs(p[i * 3 + 2]! - p[j * 3 + 2]!) < 1e-7
    )
  }

  toGeometry(): BufferGeometry {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3))
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3))
    g.setAttribute('aTint', new BufferAttribute(new Float32Array(this.tint), 1))
    g.setAttribute('aSurf', new BufferAttribute(new Float32Array(this.surf), 4))
    g.setAttribute('aMisc', new BufferAttribute(new Float32Array(this.misc), 4))
    g.setIndex(this.index.slice())
    g.computeBoundingSphere()
    return g
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

// ---------------------------------------------------------------------------
// loft() — the only box in this file, and it cannot have a sharp edge
// ---------------------------------------------------------------------------
/**
 * Sweep a rounded rectangle along +z through a list of sections and close both
 * ends with a quarter-round fillet and a flat cap.
 *
 * The corner radius `r` is the §6 chamfer and it is a required argument, which
 * is the point: there is no code path in this file that produces a 90° arris.
 * It serves three edge families at once —
 *
 *   - the four longitudinal edges, from the rounded-rect corners
 *   - the eight end edges, from the quarter-round fillet at each cap
 *   - the eight corners, where the two meet, from the fillet running round
 *
 * Normals are ANALYTIC, not accumulated from adjacent faces, and that is what
 * keeps a flat panel flat while the fillet still rolls. A profile point at
 * θ = 0/90/180/270 lies on a straight run and gets exactly the axis normal; a
 * point on a corner arc gets the arc normal. Averaging face normals instead
 * would dome every panel and lose the crease the fillet exists to soften.
 *
 * `seg` is the number of segments per quarter turn. 2 on bodywork, 1 on trim
 * too small for the difference to survive to the screen.
 */
interface Section {
  /** Sweep coordinate. Must increase. */
  readonly z: number
  readonly hw: number
  readonly hh: number
  /** Cross-section centre height, so a bar can rise or fall along its length. */
  readonly cy: number
}

/** Corner centre of profile group `k`, in section space. */
function cornerX(sec: Section, r: number, k: number): number {
  return (k === 0 || k === 3 ? 1 : -1) * Math.max(0, sec.hw - r)
}
function cornerY(sec: Section, r: number, k: number): number {
  return (k === 0 || k === 1 ? 1 : -1) * Math.max(0, sec.hh - r) + sec.cy
}

function loft(b: Build, s: Surf, sections: readonly Section[], r: number, seg: number): void {
  const n = sections.length
  const rings: number[][] = []

  // Body rings.
  for (let i = 0; i < n; i++) {
    const sec = sections[i]!
    const prev = sections[Math.max(0, i - 1)]!
    const next = sections[Math.min(n - 1, i + 1)]!
    const dz = next.z - prev.z
    const ring: number[] = []
    for (let k = 0; k < 4; k++) {
      // Taper slope of THIS corner, so the normal on a tapering flank leans
      // with the flank instead of pretending the bar is a prism.
      const dx = dz > 1e-6 ? (cornerX(next, r, k) - cornerX(prev, r, k)) / dz : 0
      const dy = dz > 1e-6 ? (cornerY(next, r, k) - cornerY(prev, r, k)) / dz : 0
      const cx = cornerX(sec, r, k)
      const cy = cornerY(sec, r, k)
      for (let j = 0; j <= seg; j++) {
        const th = (k + j / seg) * (Math.PI / 2)
        const ct = Math.cos(th)
        const st = Math.sin(th)
        ring.push(b.vertex(s, cx + r * ct, cy + r * st, sec.z, ct, st, -(st * dy + ct * dx)))
      }
    }
    rings.push(ring)
  }
  for (let i = 0; i + 1 < n; i++) b.ring(rings[i]!, rings[i + 1]!, false)

  // End fillets. `dir` is +1 at the far end, -1 at the near one; the winding
  // flips with it because the sweep direction does.
  for (const end of [0, 1]) {
    const dir = end === 1 ? 1 : -1
    const sec = sections[end === 1 ? n - 1 : 0]!
    let prevRing = rings[end === 1 ? n - 1 : 0]!
    for (let a = 1; a <= seg; a++) {
      const al = (a / seg) * (Math.PI / 2)
      const ca = Math.cos(al)
      const sa = Math.sin(al)
      const ring: number[] = []
      for (let k = 0; k < 4; k++) {
        const cx = cornerX(sec, r, k)
        const cy = cornerY(sec, r, k)
        for (let j = 0; j <= seg; j++) {
          const th = (k + j / seg) * (Math.PI / 2)
          const ct = Math.cos(th)
          const st = Math.sin(th)
          ring.push(
            b.vertex(
              s,
              cx + r * ct * ca,
              cy + r * st * ca,
              sec.z + dir * r * sa,
              ct * ca,
              st * ca,
              dir * sa,
            ),
          )
        }
      }
      b.ring(prevRing, ring, dir < 0)
      prevRing = ring
    }
    // The α = 90° ring has collapsed onto the four corner points; cap across
    // them rather than fanning through duplicates.
    const c0 = prevRing[0]!
    const c1 = prevRing[seg + 1]!
    const c2 = prevRing[2 * (seg + 1)]!
    const c3 = prevRing[3 * (seg + 1)]!
    if (dir > 0) {
      b.tri(c0, c1, c2)
      b.tri(c0, c2, c3)
    } else {
      b.tri(c0, c2, c1)
      b.tri(c0, c3, c2)
    }
  }
}

/** A bar of constant cross-section between two z values. The common case. */
function bar(
  b: Build,
  s: Surf,
  z0: number,
  z1: number,
  hw: number,
  hh: number,
  cy: number,
  r: number,
  seg = 2,
): void {
  loft(b, s, [{ z: z0, hw, hh, cy }, { z: z1, hw, hh, cy }], r, seg)
}

// ---------------------------------------------------------------------------
// tube() — swept circle, for the roll bar, exhausts, nerf bars and rim strips
// ---------------------------------------------------------------------------
const _t0 = new Vector3()
const _t1 = new Vector3()
const _nx = new Vector3()
const _ny = new Vector3()
const _tmp = new Vector3()

/**
 * Parallel-transport sweep of a circle along a polyline.
 *
 * Frames are transported rather than rebuilt per segment from a fixed up
 * vector: a fixed up vector degenerates the moment the path turns vertical,
 * which the roll bar does twice, and the failure is a 180° twist in the middle
 * of the hoop that looks like a modelling mistake rather than a maths one.
 */
function tube(
  b: Build,
  s: Surf,
  path: readonly Vector3[],
  radius: number | ((t: number) => number),
  radial: number,
  capped: boolean,
): void {
  const n = path.length
  if (n < 2) return
  const rings: number[][] = []

  _t0.copy(path[1]!).sub(path[0]!).normalize()
  // Any perpendicular will do for the first frame; pick the one furthest from
  // the tangent so the cross product is well conditioned.
  _nx.set(0, 1, 0)
  if (Math.abs(_t0.y) > 0.9) _nx.set(1, 0, 0)
  _ny.crossVectors(_t0, _nx).normalize()
  _nx.crossVectors(_ny, _t0).normalize()

  for (let i = 0; i < n; i++) {
    if (i > 0) {
      _t1
        .copy(path[Math.min(n - 1, i + 1)]!)
        .sub(path[Math.max(0, i - 1)]!)
        .normalize()
      // Transport: rotate the frame by the same rotation that takes the old
      // tangent to the new one.
      const q = _transportQ.setFromUnitVectors(_t0, _t1)
      _nx.applyQuaternion(q).normalize()
      _ny.crossVectors(_t1, _nx).normalize()
      _nx.crossVectors(_ny, _t1).normalize()
      _t0.copy(_t1)
    }
    const t = i / (n - 1)
    const rr = typeof radius === 'number' ? radius : radius(t)
    const ring: number[] = []
    const p = path[i]!
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * Math.PI * 2
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      _tmp.copy(_nx).multiplyScalar(ca).addScaledVector(_ny, sa)
      ring.push(
        b.vertex(
          s,
          p.x + _tmp.x * rr,
          p.y + _tmp.y * rr,
          p.z + _tmp.z * rr,
          _tmp.x,
          _tmp.y,
          _tmp.z,
        ),
      )
    }
    rings.push(ring)
  }
  for (let i = 0; i + 1 < n; i++) b.ring(rings[i]!, rings[i + 1]!, false)

  if (capped) {
    for (const end of [0, 1]) {
      const ring = rings[end === 1 ? n - 1 : 0]!
      const p = path[end === 1 ? n - 1 : 0]!
      _t1
        .copy(path[end === 1 ? n - 1 : 1]!)
        .sub(path[end === 1 ? n - 2 : 0]!)
        .normalize()
      const sign = end === 1 ? 1 : -1
      const c = b.vertex(s, p.x, p.y, p.z, _t1.x * sign, _t1.y * sign, _t1.z * sign)
      for (let k = 0; k < radial; k++) {
        const j = (k + 1) % radial
        if (end === 1) b.tri(c, ring[k]!, ring[j]!)
        else b.tri(c, ring[j]!, ring[k]!)
      }
    }
  }
}
const _transportQ = new Quaternion()

/** UV sphere band. Helmet shell and visor both come from this. */
function sphereBand(
  b: Build,
  s: Surf,
  radius: number,
  phi0: number,
  phiLen: number,
  theta0: number,
  thetaLen: number,
  lon: number,
  lat: number,
): void {
  const rings: number[][] = []
  for (let j = 0; j <= lat; j++) {
    const th = theta0 + (j / lat) * thetaLen
    const ring: number[] = []
    for (let i = 0; i <= lon; i++) {
      const ph = phi0 + (i / lon) * phiLen
      const x = Math.sin(th) * Math.sin(ph)
      const y = Math.cos(th)
      const z = Math.sin(th) * Math.cos(ph)
      ring.push(b.vertex(s, x * radius, y * radius, z * radius, x, y, z))
    }
    rings.push(ring)
  }
  for (let j = 0; j + 1 < rings.length; j++) {
    const a = rings[j]!
    const c = rings[j + 1]!
    for (let i = 0; i + 1 < a.length; i++) {
      b.tri(a[i]!, c[i]!, a[i + 1]!)
      b.tri(a[i + 1]!, c[i]!, c[i + 1]!)
    }
  }
}

/** Place a part: sweep axis +z rotated by (rx, ry) then translated. */
function place(rx: number, ry: number, x: number, y: number, z: number): Matrix4 {
  return new Matrix4()
    .makeTranslation(x, y, z)
    .multiply(new Matrix4().makeRotationY(ry))
    .multiply(new Matrix4().makeRotationX(rx))
}

// ---------------------------------------------------------------------------
// The chassis
// ---------------------------------------------------------------------------
/**
 * Local frame is the chassis frame handed over by `IKart.modelRoot`: +X right,
 * +Y up, −Z forward, origin at the chassis centre, ground at −(WHEEL_RADIUS +
 * REST_LENGTH) = −0.565 m.
 */
function buildChassis(b: Build): void {
  // Floor pan. Widens under the driver and pinches at both ends; the taper is
  // what stops the kart reading as a shoebox from directly above, which is the
  // one angle a chase camera spends most of its time near.
  b.transform(null)
  loft(
    b,
    S_FLOOR,
    [
      { z: -0.94, hw: 0.26, hh: 0.045, cy: -0.4 },
      { z: -0.35, hw: 0.33, hh: 0.05, cy: -0.4 },
      { z: 0.4, hw: 0.35, hh: 0.05, cy: -0.4 },
      { z: 0.86, hw: 0.28, hh: 0.045, cy: -0.4 },
    ],
    FILLET_BIG,
    2,
  )

  // Side pods. The main livery surface and the main decal surface.
  for (const sx of [-1, 1]) {
    b.transform(place(0, 0, sx * 0.37, 0, 0))
    loft(
      b,
      S_PAINT,
      [
        { z: -0.6, hw: 0.075, hh: 0.1, cy: -0.29 },
        { z: -0.25, hw: 0.105, hh: 0.14, cy: -0.26 },
        { z: 0.32, hw: 0.105, hh: 0.14, cy: -0.26 },
        { z: 0.56, hw: 0.08, hh: 0.11, cy: -0.28 },
      ],
      FILLET_BIG,
      2,
    )
  }

  // Nose cone, tapering in both axes. §6 wants a bevelled bumper in front of
  // it; the nose itself is paint and carries the decal.
  b.transform(null)
  loft(
    b,
    S_PAINT,
    [
      { z: NOSE_Z + 0.02, hw: 0.15, hh: 0.055, cy: -0.36 },
      { z: NOSE_Z + 0.22, hw: 0.28, hh: 0.085, cy: -0.35 },
      { z: -0.55, hw: 0.32, hh: 0.1, cy: -0.34 },
      { z: -0.3, hw: 0.3, hh: 0.09, cy: -0.33 },
    ],
    FILLET_BIG,
    2,
  )

  // Engine cowl behind the seat, secondary livery.
  loft(
    b,
    S_PAINT2,
    [
      { z: 0.3, hw: 0.2, hh: 0.13, cy: -0.24 },
      { z: 0.58, hw: 0.24, hh: 0.17, cy: -0.21 },
      { z: 0.8, hw: 0.2, hh: 0.14, cy: -0.23 },
    ],
    FILLET_BIG,
    2,
  )

  /*
   * Bevelled bumpers, §6. Built along +z then laid across the kart, which is
   * why `loft` sweeps on one axis and `place` does the rest — a second
   * axis-specific primitive would be two more places for the fillet to go
   * missing.
   */
  for (const [z, half] of [
    [NOSE_Z - 0.01, 0.42],
    [TAIL_Z + 0.01, 0.4],
  ] as const) {
    /*
     * PAINTED in the secondary livery, not chromed, and this changed after
     * looking at a field of eight from grid distance.
     *
     * The bumpers are the largest single area on the kart and the first thing
     * the camera sees of a rival. In chrome they are eight identical pale slabs
     * — §10b criterion 1 is "readable at thumbnail size", and a livery that
     * only appears on the side pods is not readable from behind. Chrome stays
     * on the roll bar, the exhausts, the nerf bars and the hubs, which is where
     * §5d's "chrome trim" belongs.
     */
    b.transform(place(0, Math.PI / 2, 0, -0.38, z))
    loft(
      b,
      S_PAINT2,
      [
        { z: -half, hw: 0.05, hh: 0.07, cy: 0 },
        { z: -half * 0.55, hw: 0.055, hh: 0.075, cy: 0.012 },
        { z: half * 0.55, hw: 0.055, hh: 0.075, cy: 0.012 },
        { z: half, hw: 0.05, hh: 0.07, cy: 0 },
      ],
      FILLET_MID,
      2,
    )
  }

  // Nerf bars — the side rails a kart hits other karts with.
  b.transform(null)
  for (const sx of [-1, 1]) {
    tube(
      b,
      S_CHROME,
      [
        new Vector3(sx * 0.36, -0.45, -0.42),
        new Vector3(sx * 0.52, -0.44, -0.24),
        new Vector3(sx * 0.53, -0.44, 0.3),
        new Vector3(sx * 0.4, -0.45, 0.56),
      ],
      0.024,
      8,
      true,
    )
  }

  /*
   * Roll bar. One hoop, transported round both bends — see the note on `tube`
   * about why a fixed up vector cannot do this.
   */
  tube(
    b,
    S_CHROME,
    [
      new Vector3(-0.31, -0.36, 0.5),
      new Vector3(-0.31, -0.05, 0.48),
      new Vector3(-0.29, 0.18, 0.44),
      new Vector3(-0.19, 0.29, 0.42),
      new Vector3(0, 0.32, 0.41),
      new Vector3(0.19, 0.29, 0.42),
      new Vector3(0.29, 0.18, 0.44),
      new Vector3(0.31, -0.05, 0.48),
      new Vector3(0.31, -0.36, 0.5),
    ],
    0.028,
    8,
    true,
  )

  /*
   * Exhaust stacks, §6. Two, rising out of the cowl and flaring at the tip —
   * the flare is a radius function rather than a second part so the lip stays
   * welded to the pipe under every fillet.
   */
  for (const sx of [-1, 1]) {
    tube(
      b,
      S_CHROME,
      [
        new Vector3(sx * 0.17, -0.24, 0.74),
        new Vector3(sx * 0.19, -0.06, 0.79),
        new Vector3(sx * 0.21, 0.1, 0.85),
        new Vector3(sx * 0.22, 0.2, 0.89),
        new Vector3(sx * 0.225, 0.235, 0.905),
      ],
      (t) => 0.028 + smoothstep(0.72, 1, t) * 0.017,
      10,
      true,
    )
  }

  // Seat pan and backrest. Dark trim, matte — the one large surface on the kart
  // with no clearcoat, which is what makes the painted panels read as painted.
  b.transform(null)
  bar(b, S_TRIM, 0.02, 0.34, 0.19, 0.035, -0.33, FILLET_MID, 2)
  b.transform(place(-Math.PI / 2 + 0.22, 0, 0, -0.33, 0.34))
  loft(
    b,
    S_TRIM,
    [
      { z: 0, hw: 0.19, hh: 0.035, cy: 0 },
      { z: 0.3, hw: 0.2, hh: 0.04, cy: 0 },
      { z: 0.46, hw: 0.16, hh: 0.035, cy: 0 },
    ],
    FILLET_MID,
    2,
  )

  // Steering column.
  b.transform(null)
  tube(
    b,
    S_CHROME,
    [new Vector3(0, -0.28, 0.1), new Vector3(0, -0.06, -0.16)],
    0.02,
    8,
    true,
  )

  // Front wheel-well fairings: small, but they are what stops the front wheels
  // looking bolted onto nothing at all.
  for (const sx of [-1, 1]) {
    b.transform(place(0, 0, sx * 0.3, 0, 0))
    bar(b, S_PAINT2, -0.86, -0.6, 0.06, 0.05, -0.34, FILLET_SMALL, 1)
  }
  b.transform(null)
}

// ---------------------------------------------------------------------------
// Emissive strips — §4b rim, §5d underglow
// ---------------------------------------------------------------------------
/**
 * Returns the polyline segments the §4c dust clamp measures against.
 *
 * The rim runs the full silhouette because §7 says tier 3 lights the FULL
 * chassis rim; tiers 1 and 2 use the same geometry at lower intensity, which is
 * the only way the ladder stays readable on the vehicle when the sparks are
 * off-screen. A separate strip per tier would be three strips to keep in sync
 * and two of them dark in every frame.
 */
function buildStrips(b: Build): Vector3[][] {
  const segs: Vector3[][] = []
  b.transform(null)

  const flank = (sx: number): Vector3[] => [
    new Vector3(sx * 0.19, -0.28, NOSE_Z + 0.06),
    new Vector3(sx * 0.34, -0.22, -0.62),
    new Vector3(sx * 0.44, -0.15, -0.2),
    new Vector3(sx * 0.44, -0.15, 0.28),
    new Vector3(sx * 0.36, -0.14, 0.62),
    new Vector3(sx * 0.26, -0.12, 0.87),
  ]
  for (const sx of [-1, 1]) {
    const path = flank(sx)
    tube(b, S_RIM, path, 0.015, 6, true)
    segs.push(path)
  }

  // Nose blade, so the rim closes at the front instead of stopping in mid-air.
  const nose = [
    new Vector3(-0.2, -0.28, NOSE_Z + 0.05),
    new Vector3(0, -0.3, NOSE_Z + 0.005),
    new Vector3(0.2, -0.28, NOSE_Z + 0.05),
  ]
  tube(b, S_RIM, nose, 0.015, 6, true)
  segs.push(nose)

  // §5d underglow, livery primary at emissive 1.4. Below the floor pan, where
  // it throws colour onto the road without entering frame as a light source.
  for (const sx of [-1, 1]) {
    const path = [
      new Vector3(sx * 0.26, -0.455, -0.72),
      new Vector3(sx * 0.31, -0.455, -0.2),
      new Vector3(sx * 0.31, -0.455, 0.32),
      new Vector3(sx * 0.26, -0.455, 0.72),
    ]
    tube(b, S_UNDER, path, 0.016, 6, true)
    segs.push(path)
  }
  return segs
}

/**
 * §4c / §5d: zero the dust weight within `EMISSIVE_CLEAR_RADIUS` of any
 * emissive strip, with a short ramp so the boundary is not a visible ring.
 *
 * Done as a post-pass over positions because the strips and the panels they
 * sit on are built by different calls and the clamp is a property of the pair.
 */
function clampDustNearStrips(b: Build, offset: Vector3, segments: readonly Vector3[][]): void {
  const p = new Vector3()
  const ab = new Vector3()
  const ap = new Vector3()
  const q = new Vector3()
  for (let i = 0; i < b.count; i++) {
    p.set(b.pos[i * 3]!, b.pos[i * 3 + 1]!, b.pos[i * 3 + 2]!).add(offset)
    let best = Infinity
    for (const path of segments) {
      for (let k = 0; k + 1 < path.length; k++) {
        const a = path[k]!
        ab.copy(path[k + 1]!).sub(a)
        ap.copy(p).sub(a)
        const len2 = ab.lengthSq()
        const t = len2 > 1e-9 ? clamp01(ap.dot(ab) / len2) : 0
        q.copy(a).addScaledVector(ab, t)
        const d = q.distanceTo(p)
        if (d < best) best = d
      }
    }
    if (best < EMISSIVE_CLEAR_RADIUS * 1.6) {
      b.misc[i * 4] = b.misc[i * 4]! * smoothstep(EMISSIVE_CLEAR_RADIUS, EMISSIVE_CLEAR_RADIUS * 1.6, best)
    }
  }
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------
/** Where the driver group hangs off the chassis. */
const DRIVER_ORIGIN = new Vector3(0, -0.34, 0.14)
/** Steering wheel centre, in driver-group space, and the column rake. */
const WHEEL_HUB = new Vector3(0, 0.3, -0.34)
const COLUMN_RAKE = -0.62

/**
 * §6 wants a VISIBLE driver, and the reason is not decoration: the driver is
 * the only part of the kart that can lean, and lean is what carries the drift
 * read at the moment the sparks are behind the bodywork.
 *
 * Torso, helmet and visor only — the legs are stubs, because everything below
 * the knee is inside the tub from every angle the camera can reach.
 */
function buildDriver(b: Build): void {
  // Torso, swept upward and tilted back into the seat.
  b.transform(place(-Math.PI / 2 + 0.2, 0, 0, 0.02, 0.06))
  loft(
    b,
    S_SUIT,
    [
      { z: 0, hw: 0.15, hh: 0.1, cy: 0 },
      { z: 0.16, hw: 0.16, hh: 0.105, cy: 0 },
      { z: 0.34, hw: 0.175, hh: 0.11, cy: 0 },
      { z: 0.44, hw: 0.14, hh: 0.095, cy: 0 },
    ],
    FILLET_BIG,
    2,
  )

  // Shoulder stubs. The forearms belong to the steering group, so these are
  // what keep the arms attached to a body rather than floating at the wheel.
  for (const sx of [-1, 1]) {
    b.transform(place(0.5, sx * 0.55, sx * 0.16, 0.42, -0.02))
    loft(
      b,
      S_SUIT,
      [
        { z: -0.02, hw: 0.055, hh: 0.055, cy: 0 },
        { z: 0.16, hw: 0.045, hh: 0.045, cy: 0 },
      ],
      FILLET_SMALL,
      1,
    )
  }

  // Legs, forward and down into the footwell.
  for (const sx of [-1, 1]) {
    b.transform(place(-1.32, sx * 0.1, sx * 0.12, 0.02, -0.06))
    loft(
      b,
      S_SUIT,
      [
        { z: 0, hw: 0.07, hh: 0.075, cy: 0 },
        { z: 0.3, hw: 0.06, hh: 0.065, cy: 0 },
        { z: 0.5, hw: 0.05, hh: 0.06, cy: 0 },
      ],
      FILLET_MID,
      2,
    )
  }

  // Neck.
  b.transform(null)
  tube(b, S_SKIN, [new Vector3(0, 0.4, 0.0), new Vector3(0, 0.5, -0.02)], 0.045, 8, false)

  /*
   * Helmet. A sphere scaled slightly long and slightly tall, in the livery
   * PRIMARY with full clearcoat — a helmet is the glossiest thing on a kart and
   * making it share the body's paint response is what ties the driver to the
   * vehicle at thumbnail size.
   */
  const helmet = place(0, 0, 0, 0.575, -0.03)
  helmet.multiply(new Matrix4().makeScale(1.0, 1.06, 1.1))
  b.transform(helmet)
  sphereBand(b, S_PAINT_PLAIN, 0.132, 0, Math.PI * 2, 0, Math.PI, 14, 9)

  // Helmet peak, and the chin bar the visor sits above.
  b.transform(place(-0.35, 0, 0, 0.645, -0.13))
  bar(b, S_TRIM, -0.04, 0.055, 0.1, 0.014, 0, FILLET_SMALL, 1)
  b.transform(place(0, 0, 0, 0.487, -0.1))
  bar(b, S_TRIM, -0.045, 0.02, 0.085, 0.03, 0, FILLET_SMALL, 1)

  /*
   * Visor. §6 names the colour and §5d the response: `#2a3a4a` at roughness
   * 0.10. It is the one deliberately sharp specular on the kart and it is small
   * on purpose — see the header on why 0.10 under this sun is the aliasing
   * case, and note there is no normal detail anywhere near it.
   */
  const visor = place(0, 0, 0, 0.575, -0.03)
  visor.multiply(new Matrix4().makeScale(1.0, 1.06, 1.1))
  b.transform(visor)
  sphereBand(b, S_VISOR, 0.136, Math.PI - 1.15, 2.3, 1.15, 0.52, 12, 4)
  b.transform(null)
}

/**
 * Forearms, gloves and the steering wheel — one group, because §6 says the
 * hands TRACK the wheel and the cheapest way to guarantee they never slide off
 * it is to make them the same rigid body.
 */
function buildArms(b: Build): void {
  // Rim of the wheel, in the XY plane so the group's own rake tilts it.
  const rimPath: Vector3[] = []
  const RIM_R = 0.125
  for (let i = 0; i <= 20; i++) {
    const a = (i / 20) * Math.PI * 2
    rimPath.push(new Vector3(Math.cos(a) * RIM_R, Math.sin(a) * RIM_R, 0))
  }
  b.transform(null)
  tube(b, S_TRIM, rimPath, 0.018, 6, false)

  // Three spokes and a boss.
  for (const a of [Math.PI * 0.5, Math.PI * 1.17, Math.PI * 1.83]) {
    b.transform(new Matrix4().makeRotationZ(a - Math.PI / 2))
    tube(b, S_CHROME, [new Vector3(0, 0.01, 0), new Vector3(0, RIM_R, 0)], 0.014, 6, true)
  }
  b.transform(null)
  tube(b, S_CHROME, [new Vector3(0, 0, -0.02), new Vector3(0, 0, 0.03)], 0.035, 10, true)

  // Gloves at 9 and 3 o'clock, and the forearms running back to the shoulders.
  for (const sx of [-1, 1]) {
    b.transform(place(0, 0, sx * RIM_R, 0.01, 0))
    loft(
      b,
      S_TRIM,
      [
        { z: -0.045, hw: 0.036, hh: 0.05, cy: 0 },
        { z: 0.045, hw: 0.04, hh: 0.055, cy: 0 },
      ],
      FILLET_SMALL,
      2,
    )
    b.transform(null)
    tube(
      b,
      S_SUIT,
      [
        new Vector3(sx * RIM_R, 0.01, 0.03),
        new Vector3(sx * 0.185, -0.03, 0.16),
        new Vector3(sx * 0.2, -0.06, 0.28),
      ],
      (t) => 0.042 + t * 0.014,
      8,
      true,
    )
  }
  b.transform(null)
}

/** §6: two mudflaps behind the rear axle, flaring with speed. */
const FLAP_ORIGIN = new Vector3(0, -0.3, 0.82)

function buildFlaps(b: Build): void {
  for (const sx of [-1, 1]) {
    b.transform(place(-Math.PI / 2, 0, sx * 0.43, 0, 0))
    loft(
      b,
      S_TRIM,
      [
        { z: -0.25, hw: 0.13, hh: 0.014, cy: 0 },
        { z: -0.03, hw: 0.125, hh: 0.014, cy: 0 },
        { z: 0, hw: 0.11, hh: 0.014, cy: 0 },
      ],
      // At the §6 floor of 0.012 on a 28 mm flap the fillet is already 86% of
      // the half-thickness; anything larger and the flap stops being a flap.
      FILLET_SMALL,
      1,
    )
  }
  b.transform(null)
}

// ---------------------------------------------------------------------------
// The wheel
// ---------------------------------------------------------------------------
/** §6: 14-knob ring plus a shoulder block row. */
const TREAD_KNOBS = 14
/**
 * 20, and the ceiling in §6 is what sets it.
 *
 * At radius 0.36 a 20-gon flattens the outline by 4.4 mm, about two pixels at
 * the `grid` vantage, and the 14 tread knobs break that outline anyway. 24
 * segments cost 512 triangles across four wheels and put the kart at 13.1 k
 * against a 13 k ceiling — spending the whole budget on a curve the tread is
 * already hiding.
 */
const WHEEL_SEGMENTS = 20
/** The knobs stand proud to the nominal 0.36 m; the carcass sits under them. */
const CARCASS_R = WHEEL_RADIUS - 0.016
const WHEEL_HALF_W = 0.13
/**
 * Small, and it was 0.21 first.
 *
 * A 0.21 m chrome hub on a 0.36 m wheel is 58% of the wheel face, and at
 * metalness 1.0 against a bright sky it renders as one perfectly uniform pale
 * disc — an §9b flat region on the second most looked-at part of the kart, and
 * a wheel that reads as a hubcap with a tyre round it rather than a tyre.
 */
const HUB_R = 0.165

/**
 * One wheel, symmetric about its own mid-plane.
 *
 * SYMMETRIC IS DELIBERATE. The obvious way to face a dished hub outward on both
 * sides is `scale.x = -1` on the left instances, and a negative determinant
 * inverts triangle winding — every left-hand wheel then renders its back faces,
 * which under a low sun looks like the tyre is inside out and reads as a
 * lighting bug rather than a transform bug. A wheel with the same dish on both
 * faces costs about 90 triangles and cannot do that.
 *
 * §6: "flat tyres on sand look wrong immediately". The tread is real geometry —
 * a normal map at this roughness under this sun is the aliasing case the header
 * of `procedural.ts` argues about, and a tyre is the fastest-rotating thing in
 * frame.
 */
const _tfX = new Vector3()
const _tfY = new Vector3()
const _tfZ = new Vector3(1, 0, 0)

/**
 * Frame for one tread block: local +z runs along the axle, local +y points
 * radially out, local +x runs round the circumference.
 *
 * Built with `makeBasis` rather than a chain of `makeRotation*` calls, because
 * the handedness is then checkable by inspection: x × y must equal z, and if it
 * does not the basis has a negative determinant, every block in the row renders
 * its back faces, and the symptom is "the shoulders are lit from inside the
 * tyre" rather than anything that says transform. Three winding errors in this
 * file's first draft were found by screenshot and not by review; this is the
 * one place the error cannot hide in a sign.
 */
function treadFrame(a: number, radius: number, axial: number): Matrix4 {
  const c = Math.cos(a)
  const s = Math.sin(a)
  _tfX.set(0, s, -c)
  _tfY.set(0, c, s)
  return new Matrix4().makeBasis(_tfX, _tfY, _tfZ).setPosition(axial, c * radius, s * radius)
}

function buildWheel(b: Build): void {
  b.transform(null)

  // Carcass barrel, slightly crowned so the shoulders fall away.
  const rings: number[][] = []
  const profile: readonly [number, number][] = [
    [-WHEEL_HALF_W, CARCASS_R - 0.03],
    [-WHEEL_HALF_W * 0.82, CARCASS_R - 0.004],
    [0, CARCASS_R],
    [WHEEL_HALF_W * 0.82, CARCASS_R - 0.004],
    [WHEEL_HALF_W, CARCASS_R - 0.03],
  ]
  for (const [x, r] of profile) {
    const ring: number[] = []
    for (let i = 0; i < WHEEL_SEGMENTS; i++) {
      const a = (i / WHEEL_SEGMENTS) * Math.PI * 2
      const ny = Math.cos(a)
      const nz = Math.sin(a)
      // Crown normal: lean the shoulder normals outboard so the shoulder catches
      // the sun separately from the crown. This is the whole reason the barrel
      // is five rings rather than two.
      const lean = x / WHEEL_HALF_W
      ring.push(b.vertex(S_RUBBER, x, ny * r, nz * r, lean * 0.55, ny, nz))
    }
    rings.push(ring)
  }
  for (let i = 0; i + 1 < rings.length; i++) b.ring(rings[i]!, rings[i + 1]!, false)

  // Sidewalls, from the shoulder in to the hub flange.
  for (const side of [-1, 1]) {
    const outer: number[] = []
    const inner: number[] = []
    const x = side * WHEEL_HALF_W
    for (let i = 0; i < WHEEL_SEGMENTS; i++) {
      const a = (i / WHEEL_SEGMENTS) * Math.PI * 2
      const ny = Math.cos(a)
      const nz = Math.sin(a)
      outer.push(b.vertex(S_RUBBER, x, ny * (CARCASS_R - 0.03), nz * (CARCASS_R - 0.03), side * 0.92, ny * 0.38, nz * 0.38))
      inner.push(b.vertex(S_RUBBER, x - side * 0.012, ny * HUB_R, nz * HUB_R, side * 0.99, ny * 0.14, nz * 0.14))
    }
    b.ring(outer, inner, side < 0)
  }

  /*
   * Tread. 14 knobs on the crown, tapered so the block has a draft angle —
   * a moulded tyre has one, and at 16 mm tall a §6 fillet does not fit, so the
   * draft is what stops the knob top blowing out under a raking sun.
   */
  for (let k = 0; k < TREAD_KNOBS; k++) {
    b.transform(treadFrame((k / TREAD_KNOBS) * Math.PI * 2, CARCASS_R + 0.008, 0))
    loft(
      b,
      S_RUBBER,
      [
        { z: -0.075, hw: 0.036, hh: 0.014, cy: 0 },
        { z: 0.075, hw: 0.036, hh: 0.014, cy: 0 },
      ],
      0.01,
      1,
    )
  }

  /*
   * §6's shoulder block row — ONE row of 14, staggered alternately onto the two
   * shoulders rather than 14 on each.
   *
   * That is what a real staggered tread looks like, and it is also what the
   * triangle budget allows: 28 blocks per wheel came to 2 664 triangles a wheel
   * and put the kart at 14.9 k against §6's 13 k ceiling, with the extra
   * spent on blocks that are never both in frame at once.
   */
  for (let k = 0; k < TREAD_KNOBS; k++) {
    {
      const side = k % 2 === 0 ? -1 : 1
      const a = ((k + 0.5) / TREAD_KNOBS) * Math.PI * 2
      b.transform(treadFrame(a, CARCASS_R - 0.012, side * (WHEEL_HALF_W - 0.03)))
      loft(
        b,
        S_RUBBER,
        [
          { z: -0.032, hw: 0.03, hh: 0.016, cy: 0 },
          { z: 0.032, hw: 0.03, hh: 0.016, cy: 0 },
        ],
        0.011,
        1,
      )
    }
  }

  // Chrome hub: a barrel with a flange each side and five spokes across the
  // face. §5d puts chrome at metalness 1.0 / roughness 0.18, environment
  // mapped, and this is where most of that area lives on the kart.
  b.transform(null)
  const hubRings: number[][] = []
  for (const [x, r] of [
    [-WHEEL_HALF_W - 0.01, HUB_R - 0.05],
    [-WHEEL_HALF_W + 0.01, HUB_R],
    [WHEEL_HALF_W - 0.01, HUB_R],
    [WHEEL_HALF_W + 0.01, HUB_R - 0.05],
  ] as const) {
    const ring: number[] = []
    for (let i = 0; i < WHEEL_SEGMENTS; i++) {
      const a = (i / WHEEL_SEGMENTS) * Math.PI * 2
      const ny = Math.cos(a)
      const nz = Math.sin(a)
      ring.push(b.vertex(S_CHROME, x, ny * r, nz * r, Math.sign(x) * 0.3, ny, nz))
    }
    hubRings.push(ring)
  }
  for (let i = 0; i + 1 < hubRings.length; i++) b.ring(hubRings[i]!, hubRings[i + 1]!, false)

  /*
   * Hub face: two stepped cones and a raised centre boss rather than one flat
   * disc. The two creases are what give a mirror-finish circle something to
   * reflect differently at, which is both the §9b uniformity rule and the only
   * reason a wheel reads as machined when it is standing still.
   */
  for (const side of [-1, 1]) {
    const x0 = side * (WHEEL_HALF_W + 0.01)
    const face: number[][] = []
    for (const [dx, r, nz] of [
      [0, HUB_R - 0.05, 0.35],
      [0.014, HUB_R * 0.62, 0.5],
      [0.03, HUB_R * 0.3, 0.8],
      [0.042, HUB_R * 0.16, 0.95],
    ] as const) {
      const ring: number[] = []
      for (let i = 0; i < WHEEL_SEGMENTS; i++) {
        const a = (i / WHEEL_SEGMENTS) * Math.PI * 2
        const ny = Math.cos(a)
        const nzc = Math.sin(a)
        const k = Math.sqrt(Math.max(0, 1 - nz * nz))
        ring.push(b.vertex(S_CHROME, x0 + side * dx, ny * r, nzc * r, side * nz, ny * k, nzc * k))
      }
      face.push(ring)
    }
    for (let i = 0; i + 1 < face.length; i++) b.ring(face[i]!, face[i + 1]!, side < 0)
    const c = b.vertex(S_CHROME, x0 + side * 0.05, 0, 0, side, 0, 0)
    const ring = face[face.length - 1]!
    for (let i = 0; i < WHEEL_SEGMENTS; i++) {
      const j = (i + 1) % WHEEL_SEGMENTS
      if (side > 0) b.tri(c, ring[i]!, ring[j]!)
      else b.tri(c, ring[j]!, ring[i]!)
    }
  }
  b.transform(null)
}

// ---------------------------------------------------------------------------
// The livery decal
// ---------------------------------------------------------------------------
/**
 * One procedural decal per kart, seeded from `KartIdentity.liverySeed`.
 *
 * ART_DIRECTION's opening rule — layered noise is superb at strata and hopeless
 * at insignia — applies to karts too, so this draws no logo, no number and no
 * lettering. It draws swept bands: the one graphic language a noise-and-
 * smoothstep pipeline can produce at a quality that survives being looked at.
 *
 * Built the same way `world/road.ts` builds `makeBoostDecal`: authored in
 * display space, antialiased with an explicit half-width rather than by
 * resolution, and tagged `SRGBColorSpace` so the GPU decodes it back to linear
 * before it reaches the mix in the fragment shader. It carries a grain term
 * because §9b forbids a perfectly uniform region and a flat colour slab is
 * exactly that.
 *
 * `procedural.ts` keeps `fbm`, `smoothstep` and its DataTexture plumbing
 * module-private and exports only two finished surfaces, neither of which is a
 * kart livery. Exporting them is an edit to a file this change does not own, so
 * this reaches for `createNoise2D` — the same underlying toolkit — directly, and
 * uses one octave rather than reimplementing `fbm`. Flagged in the report.
 */
function srgbBytes(hex: number): readonly [number, number, number] {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255]
}

function makeLiveryDecal(
  width: number,
  rng: () => number,
  anisotropy: number,
  secondary: number,
): DataTexture {
  const height = Math.max(16, Math.round(width / 4))
  const grain = createNoise2D(rng)
  const data = new Uint8Array(width * height * 4)

  // Bone and near-black are both §3a environment entries. The band palette
  // never leaves the environment hues, so a livery cannot be read as a §4b
  // gameplay signal at any distance.
  const inks = [srgbBytes(secondary), srgbBytes(0xf2ead6), srgbBytes(0x241f22)]

  interface Band {
    readonly c: number
    readonly slope: number
    readonly t0: number
    readonly t1: number
    readonly ink: readonly [number, number, number]
  }
  /*
   * BAND WIDTHS ARE SMALL ON PURPOSE, and the first pass got this badly wrong.
   *
   * With half-thicknesses around 0.10 the bands covered the entire projected
   * height of the bodywork, so every kart rendered as a bone-white slab and the
   * livery primary never appeared on screen at all. A decal is a graphic ON the
   * paint; when it covers the panel it IS the paint, and eight karts that
   * differ only in a colour nothing shows are eight identical karts.
   */
  const bands: Band[] = []
  const count = 2 + (rng() < 0.4 ? 1 : 0)
  for (let i = 0; i < count; i++) {
    bands.push({
      c: 0.28 + rng() * 0.42,
      slope: (rng() - 0.5) * 0.4,
      t0: 0.022 + rng() * 0.04,
      t1: 0.01 + rng() * 0.045,
      ink: inks[i % inks.length]!,
    })
  }

  const aa = 1.5 / height

  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width
      let r = 0
      let g = 0
      let bl = 0
      let a = 0

      for (const band of bands) {
        // A band that tapers along the body reads as a swept dart under
        // perspective; a constant-thickness stripe reads as tape.
        const half = Math.max(0.008, band.t0 + (band.t1 - band.t0) * u)
        const d = Math.abs(v - (band.c + band.slope * (u - 0.5)))
        const m = 1 - smoothstep(half - aa, half + aa, d)
        if (m <= 0) continue
        r = r + (band.ink[0] - r) * m
        g = g + (band.ink[1] - g) * m
        bl = bl + (band.ink[2] - bl) * m
        a = Math.max(a, m)
      }

      // Grain and a scuff mask. Not decoration: a decal that returns one exact
      // value over a large area is a §9b flat region and the frame instruments
      // cannot tell it apart from a tile that was never drawn.
      // Frequencies are ASPECT-CORRECTED — the map is 4:1, so equal numbers on
      // both axes give features four times finer in v than in u, which is a
      // stripe pattern that aliases into horizontal banding the moment the
      // panel tilts away. Grain modulates tone hard and alpha barely: alpha
      // noise on a graphic edge is a ragged sticker, not weathering.
      const n = grain(u * 30, v * 7.5) * 0.55 + grain(u * 120, v * 30) * 0.45
      const tone = 1 + n * 0.13
      a *= clamp01(0.94 + n * 0.12)

      // Two texels of transparent border, so the decal cannot bleed past its
      // projection onto a panel that curves away.
      const edge = Math.min(u, 1 - u, v, 1 - v)
      a *= smoothstep(0, 3 / height, edge)

      const i = (y * width + x) * 4
      data[i] = Math.round(clamp(r * tone, 0, 255))
      data[i + 1] = Math.round(clamp(g * tone, 0, 255))
      data[i + 2] = Math.round(clamp(bl * tone, 0, 255))
      data[i + 3] = Math.round(clamp01(a) * 255)
    }
  }

  const tex = new DataTexture(data, width, height, RGBAFormat)
  tex.colorSpace = SRGBColorSpace
  tex.wrapS = ClampToEdgeWrapping
  tex.wrapT = ClampToEdgeWrapping
  tex.magFilter = LinearFilter
  tex.minFilter = LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = anisotropy
  tex.needsUpdate = true
  return tex
}

// ---------------------------------------------------------------------------
// The material
// ---------------------------------------------------------------------------

interface KartUniforms {
  readonly uPalette: { value: Color[] }
  readonly uEmissive: { value: Color[] }
  readonly uDust: { value: number }
  readonly uDustColour: { value: Color }
  readonly uDecal: { value: DataTexture }
}

interface ShaderLike {
  uniforms: Record<string, unknown>
  vertexShader: string
  fragmentShader: string
}

const VERTEX_DECLS = /* glsl */ `
attribute float aTint;
attribute vec4 aSurf;
attribute vec4 aMisc;
uniform vec3 uPalette[ ${PALETTE_SIZE} ];
uniform vec3 uEmissive[ ${PALETTE_SIZE} ];
varying vec3 vKartTint;
varying vec3 vKartEmissive;
varying vec4 vKartSurf;
varying vec3 vKartDecal;
`

const FRAGMENT_DECLS = /* glsl */ `
uniform float uDust;
uniform vec3 uDustColour;
uniform sampler2D uDecal;
varying vec3 vKartTint;
varying vec3 vKartEmissive;
varying vec4 vKartSurf;
varying vec3 vKartDecal;
`

/**
 * ONE function object, shared by all eight materials.
 *
 * `Material.customProgramCacheKey()` returns `onBeforeCompile.toString()`, so a
 * shared reference means one compiled program for the whole field while each
 * material still carries its own uniform values. Writing this as a closure per
 * kart — the obvious thing — would compile eight identical programs and stall
 * the first frame each kart appears in.
 */
function kartOnBeforeCompile(this: MeshPhysicalMaterial, shader: ShaderLike): void {
  const u = (this.userData as { kart: KartUniforms }).kart
  shader.uniforms.uPalette = u.uPalette
  shader.uniforms.uEmissive = u.uEmissive
  shader.uniforms.uDust = u.uDust
  shader.uniforms.uDustColour = u.uDustColour
  shader.uniforms.uDecal = u.uDecal

  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${VERTEX_DECLS}`)
    .replace(
      '#include <begin_vertex>',
      /* glsl */ `#include <begin_vertex>
	int kSlot = int( aTint + 0.5 );
	vKartTint = uPalette[ kSlot ];
	vKartEmissive = uEmissive[ kSlot ] * aSurf.w;
	vKartSurf = vec4( aSurf.xyz, aMisc.x );
	vKartDecal = aMisc.yzw;`,
    )

  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${FRAGMENT_DECLS}`)
    /*
     * Livery, then decal, then dust — in that order, because the dust settles
     * ON the decal and not under it. §5d's dust layer is "the desert's answer
     * to the wet road's reflection": the material that tells you a race has
     * been happening. A decal that stays clean while the paint around it dulls
     * is the tell that it was composited in the wrong order.
     */
    .replace(
      '#include <color_fragment>',
      /* glsl */ `#include <color_fragment>
	diffuseColor.rgb *= vKartTint;
	vec4 kDecal = texture2D( uDecal, vKartDecal.yz );
	diffuseColor.rgb = mix( diffuseColor.rgb, kDecal.rgb, kDecal.a * vKartDecal.x );
	float kDust = clamp( vKartSurf.w * uDust, 0.0, 1.0 );
	diffuseColor.rgb = mix( diffuseColor.rgb, uDustColour, kDust );`,
    )
    /*
     * These two replacements are where the roughnessMap trap dies. There is no
     * scalar `roughness` left in the chain for a map to multiply, because there
     * is no map: §5a's kart row — base 0.30, range 0.30 to 0.66, varied by the
     * dust accumulation layer — is this one line.
     */
    .replace(
      '#include <roughnessmap_fragment>',
      'float roughnessFactor = mix( vKartSurf.x, 0.66, kDust );',
    )
    .replace(
      '#include <metalnessmap_fragment>',
      // Dust is a dielectric film. Chrome under it stops being chrome, which is
      // the entire visual point of a car that has been racing in a desert.
      'float metalnessFactor = vKartSurf.y * ( 1.0 - kDust * 0.85 );',
    )
    .replace(
      '#include <emissivemap_fragment>',
      /* glsl */ `#include <emissivemap_fragment>
	totalEmissiveRadiance += vKartEmissive;`,
    )
    .replace(
      '#include <lights_physical_fragment>',
      /* glsl */ `#include <lights_physical_fragment>
	material.clearcoat = clamp( vKartSurf.z * ( 1.0 - kDust ), 0.0, 1.0 );
	material.clearcoatRoughness = clamp( mix( 0.07, 0.5, kDust ) + geometryRoughness, 0.0525, 1.0 );`,
    )
}

// ---------------------------------------------------------------------------
// Shared geometry
// ---------------------------------------------------------------------------
/**
 * Built once, referenced by every kart, freed when the last one goes.
 *
 * §9 gives 250 draw calls a frame and the world already spends ~45. Eight karts
 * with private geometry would also be eight copies of ~9 k triangles of vertex
 * data on the GPU for no reason: the karts are identical, and the ONLY thing
 * that differs between them is the material — ten palette colours, one decal
 * and two animated scalars.
 *
 * Refcounted rather than left alive, because `resetRace` tears the world down
 * and rebuilds it, so anything leaked here is leaked once per harness reset and
 * shows up as a phone dying two-thirds of the way through §10c criterion 8.
 */
interface Kit {
  readonly chassis: BufferGeometry
  readonly strips: BufferGeometry
  readonly driver: BufferGeometry
  readonly arms: BufferGeometry
  readonly flaps: BufferGeometry
  readonly wheel: BufferGeometry
  readonly triangles: number
  refs: number
}

let kit: Kit | null = null

function tris(g: BufferGeometry): number {
  return (g.getIndex()?.count ?? 0) / 3
}

function acquireKit(): Kit {
  if (kit) {
    kit.refs++
    return kit
  }

  const chassis = new Build()
  buildChassis(chassis)
  const strips = new Build()
  const stripPaths = buildStrips(strips)
  const driver = new Build()
  buildDriver(driver)
  const arms = new Build()
  buildArms(arms)
  const flaps = new Build()
  buildFlaps(flaps)
  const wheel = new Build()
  buildWheel(wheel)

  // §4c: the dust layer is clamped to zero within 0.12 m of an emissive strip.
  // Only the parts that come within that of one need the test — the driver and
  // the wheels are nowhere near, and running it on them would be a distance
  // query per vertex that provably returns the same answer every time.
  clampDustNearStrips(chassis, ZERO, stripPaths)
  clampDustNearStrips(flaps, FLAP_ORIGIN, stripPaths)

  const geo = {
    chassis: chassis.toGeometry(),
    strips: strips.toGeometry(),
    driver: driver.toGeometry(),
    arms: arms.toGeometry(),
    flaps: flaps.toGeometry(),
    wheel: wheel.toGeometry(),
  }
  kit = {
    ...geo,
    triangles:
      tris(geo.chassis) +
      tris(geo.strips) +
      tris(geo.driver) +
      tris(geo.arms) +
      tris(geo.flaps) +
      tris(geo.wheel) * 4,
    refs: 1,
  }
  return kit
}

function releaseKit(): void {
  if (!kit) return
  kit.refs--
  if (kit.refs > 0) return
  kit.chassis.dispose()
  kit.strips.dispose()
  kit.driver.dispose()
  kit.arms.dispose()
  kit.flaps.dispose()
  kit.wheel.dispose()
  kit = null
}

const ZERO = new Vector3()

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export interface KartModel {
  /** Add to `IKart.modelRoot`. Nothing else may parent it. */
  readonly root: Object3D
  /** Triangles this kart renders, driver and all four wheels included. */
  readonly triangles: number
  /** Draw calls in the colour pass. The shadow pass adds one per caster. */
  readonly drawCalls: number
  /**
   * Once per rendered frame, from `lateUpdate`. Reads state, writes transforms
   * and uniforms, and mutates no simulation value.
   */
  update(state: Readonly<KartState>, dt: Seconds): void
  dispose(): void
}

/** Front-left, front-right, rear-left, rear-right — `KartState.wheels` order. */
const WHEEL_MOUNT: readonly (readonly [number, number, number])[] = [
  [-HALF_TRACK, -FRONT_AXLE, 0.85],
  [HALF_TRACK, -FRONT_AXLE, 0.85],
  [-HALF_TRACK, -REAR_AXLE, 1.16],
  [HALF_TRACK, -REAR_AXLE, 1.16],
]

const _pos = new Vector3()
const _quat = new Quaternion()
const _euler = new Euler(0, 0, 0, 'YXZ')
const _scale = new Vector3()
const _mat = new Matrix4()
const _accel = new Vector3()
const _inv = new Quaternion()

/**
 * Build the visual kart for one identity.
 *
 * The composition root owns the wiring:
 *
 *     const model = createKartModel(ctx, kart.identity)
 *     kart.modelRoot.add(model.root)
 *     // in lateUpdate, once per frame, per kart:
 *     model.update(kart.state, dt)
 *     // in dispose:
 *     model.dispose()
 *
 * `modelRoot` already carries the chassis position and the chassis quaternion,
 * and `kart/` keeps that quaternion NORMAL TO THE ROAD SURFACE. Everything this
 * function animates is therefore expressed in chassis-local space and stays
 * normal to the bank for free — which is precisely what §6 asks for on The
 * Wall, and precisely what would break if any of it were levelled against world
 * up. Do not add a world-up correction here. The horizon is the camera's job.
 */
export function createKartModel(ctx: Ctx, identity: KartIdentity): KartModel {
  const k = acquireKit()

  const root = new Object3D()
  root.name = `kart-model/${identity.id}`

  /*
   * Sprung mass. Roll, pitch and the drift hop live here so the wheels, which
   * are unsprung and follow the road, do not inherit them.
   */
  const body = new Object3D()
  body.name = 'sprung'
  root.add(body)

  const driverPivot = new Object3D()
  driverPivot.position.copy(DRIVER_ORIGIN)
  body.add(driverPivot)

  const columnPivot = new Object3D()
  columnPivot.position.copy(WHEEL_HUB)
  columnPivot.rotation.x = COLUMN_RAKE
  driverPivot.add(columnPivot)

  const flapPivot = new Object3D()
  flapPivot.position.copy(FLAP_ORIGIN)
  body.add(flapPivot)

  const decalSize = Math.min(256, ctx.quality.maxTextureSize)
  const decal = makeLiveryDecal(
    decalSize,
    ctx.rngFor('render/kart-model').fork(`livery/${identity.liverySeed}`),
    ctx.quality.maxAnisotropy,
    identity.secondaryColor,
  )

  const palette: Color[] = new Array(PALETTE_SIZE).fill(null).map(() => new Color(0xffffff))
  palette[SLOT_PRIMARY] = new Color(identity.primaryColor)
  palette[SLOT_SECONDARY] = new Color(identity.secondaryColor)
  palette[SLOT_CHROME] = new Color(COL_CHROME)
  palette[SLOT_RUBBER] = new Color(COL_RUBBER)
  palette[SLOT_SKIN] = new Color(COL_SKIN)
  palette[SLOT_VISOR] = new Color(COL_VISOR)
  palette[SLOT_TRIM] = new Color(COL_TRIM)
  // The suit reads as the kart's own team, so it is the secondary colour taken
  // down in value — a driver in the livery primary competes with the bodywork
  // for the eye at exactly the distance where the kart should read as one shape.
  // Lifted toward §3a's dry-brush tone rather than used raw: several of the
  // eight secondaries are near-black by design, and a driver rendered at
  // luma 0.02 is a hole in the middle of the kart, not a person.
  palette[SLOT_SUIT] = new Color(identity.secondaryColor).lerp(new Color(0x8c7a52), 0.42)
  palette[SLOT_FLOOR] = new Color(COL_FLOOR)
  // The rim strip's ALBEDO is a dark body line; its tier colour is emissive
  // only. Putting the §4b hue in the albedo would leave a saturated green-cyan
  // stripe on a parked kart, which is a reserved-band hue on a surface that is
  // not signalling anything.
  palette[SLOT_RIM] = new Color(0x2a2622)

  const emissive: Color[] = new Array(PALETTE_SIZE).fill(null).map(() => new Color(0x000000))
  emissive[SLOT_PRIMARY] = new Color(identity.primaryColor)
  emissive[SLOT_RIM] = new Color(0x000000)

  const uniforms: KartUniforms = {
    uPalette: { value: palette },
    uEmissive: { value: emissive },
    uDust: { value: 0 },
    uDustColour: { value: new Color(COL_DUST) },
    uDecal: { value: decal },
  }

  const material = new MeshPhysicalMaterial({
    // White, because everything colouring this material arrives per vertex. A
    // tint here would multiply the whole kart including the chrome and the
    // visor, which is the "one global scalar defeats a thousand lines" failure
    // CLAUDE.md names.
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    // Non-zero so USE_CLEARCOAT is defined and the per-vertex override above
    // has something to override. §5d: clearcoat 1.0 / clearcoatRoughness 0.07
    // on paint, and the attribute carries 0 on everything that is not paint.
    clearcoat: 1,
    clearcoatRoughness: 0.07,
    emissive: 0x000000,
  })
  material.userData = { kart: uniforms }
  material.onBeforeCompile = kartOnBeforeCompile
  // Per-material, never a global sweep: §5 forbids one scalar across materials
  // that are not uniform, and this is the one the chrome trim actually needs.
  material.envMapIntensity = 1

  const meshes: Mesh[] = []
  const attach = (geometry: BufferGeometry, parent: Object3D, name: string, casts: boolean): Mesh => {
    const mesh = new Mesh(geometry, material)
    mesh.name = name
    mesh.castShadow = casts
    mesh.receiveShadow = true
    parent.add(mesh)
    meshes.push(mesh)
    return mesh
  }

  attach(k.chassis, body, 'chassis', true)
  // The strips cast nothing: they are 30 mm of tube sitting on bodywork that is
  // already in the shadow map, and a self-shadowing emissive strip is a shadow
  // acne generator for zero silhouette gain.
  attach(k.strips, body, 'strips', false)
  attach(k.driver, driverPivot, 'driver', true)
  attach(k.arms, columnPivot, 'arms', true)
  attach(k.flaps, flapPivot, 'mudflaps', true)

  const wheels = new InstancedMesh(k.wheel, material, 4)
  wheels.name = 'wheels'
  wheels.castShadow = true
  wheels.receiveShadow = true
  wheels.instanceMatrix.setUsage(DynamicDrawUsage)
  root.add(wheels)

  // ---- per-frame state -----------------------------------------------------

  const prevVelocity = new Vector3()
  let havePrev = false
  let roll = 0
  let pitch = 0
  let snap = 0
  let hop = 0
  let hopVel = 0
  let flap = 0
  let hands = 0
  let wasDrifting = false
  let rimLevel = 0
  let rimTier = 1
  let dust = 0
  let laps = 0
  let lapDistance = 0

  const rimColour = new Color()

  const offLap = ctx.events.on('lap:complete', (p) => {
    if (p.kartId !== identity.id) return
    laps++
    // Re-anchor rather than trusting the integrator: LAP_LENGTH is a constant
    // read out of ART_DIRECTION §1, and if the circuit is ever re-cut the dust
    // pacing would drift a little more every lap without this.
    lapDistance = 0
  })
  const offStart = ctx.events.on('race:start', () => {
    // §11: the `grid` vantage exists to prove the dust layer is at EXACTLY zero
    // at the start. Anything driven during a countdown or a warm-up is not a
    // race and must not have aged the paint.
    laps = 0
    lapDistance = 0
    dust = 0
  })

  const model: KartModel = {
    root,
    triangles: k.triangles,
    drawCalls: 6,

    update(state: Readonly<KartState>, dt: Seconds): void {
      const step = clamp(dt, 1 / 400, 0.1)

      /*
       * Longitudinal and lateral acceleration, differentiated from velocity and
       * rotated into the chassis frame.
       *
       * Wheel compressions cannot supply this. They are raycast lengths, so on
       * a flat road they are identical in a corner and identical under braking
       * — the physics chassis has no roll or pitch degree of freedom at all.
       * They DO carry the bumps, which is why both terms are summed below: the
       * dynamic term gives the corner, the geometric term gives the kerb.
       */
      _accel.copy(state.velocity)
      if (havePrev) {
        _accel.sub(prevVelocity).divideScalar(step)
        // A respawn teleports velocity. Clamping is cheaper and more honest
        // than trying to detect the teleport.
        if (_accel.lengthSq() > 1600) _accel.setLength(40)
      } else {
        _accel.set(0, 0, 0)
        havePrev = true
      }
      prevVelocity.copy(state.velocity)

      _inv.copy(state.quaternion).invert()
      _accel.applyQuaternion(_inv)
      const latAccel = _accel.x
      const longAccel = -_accel.z

      const w = state.wheels
      const cFront = (w[0].compression + w[1].compression) * 0.5
      const cRear = (w[2].compression + w[3].compression) * 0.5
      const cLeft = (w[0].compression + w[2].compression) * 0.5
      const cRight = (w[1].compression + w[3].compression) * 0.5

      // Geometric: a wheel that is more compressed has the body lower over it.
      const rollGeo = ((cLeft - cRight) * SUSPENSION_TRAVEL) / (2 * HALF_TRACK)
      const pitchGeo = (-(cFront - cRear) * SUSPENSION_TRAVEL) / (FRONT_AXLE - REAR_AXLE)

      // Dynamic: the body leans away from the corner and squats under power.
      const rollTarget = clamp(latAccel * 0.011, -0.13, 0.13) + rollGeo
      const pitchTarget = clamp(longAccel * 0.0085, -0.1, 0.1) + pitchGeo
      const kf = 1 - Math.exp(-step * 9)
      roll += (rollTarget - roll) * kf
      pitch += (pitchTarget - pitch) * kf

      /*
       * §6: the kart hops on drift entry — the tell that the drift TOOK.
       *
       * `kart/` already adds a real 1.72 m/s vertical impulse, so the whole
       * vehicle rises. This is the second half of that read: the sprung mass
       * unloads on its springs and snaps into the lean, which is what makes the
       * hop look like a driver doing something rather than a bump.
       */
      const drifting = state.drift.active
      if (drifting && !wasDrifting) {
        hopVel += 1.15
        snap = state.drift.direction * 0.11
      }
      wasDrifting = drifting
      hopVel += (-hop * 110 - hopVel * 11) * step
      hop = clamp(hop + hopVel * step, -0.03, 0.09)
      snap -= snap * Math.min(1, step * 4.5)

      body.rotation.z = roll + snap
      body.rotation.x = pitch
      body.position.y = hop

      // §6: mudflaps flare with speed.
      const flapTarget = Math.pow(clamp01(Math.abs(state.speed) / 31.5), 1.4) * 0.8
      flap += (flapTarget - flap) * (1 - Math.exp(-step * 5))
      flapPivot.rotation.x = -flap

      /*
       * §6: the driver leans and counter-steers into a drift.
       *
       * The lean is opposite the body roll — the body falls outward, the driver
       * holds himself inward — which is what makes the two read as separate
       * masses instead of one welded lump.
       */
      driverPivot.rotation.z = -(roll + snap) * 0.85
      driverPivot.rotation.x = -pitch * 0.5
      driverPivot.position.x = clamp(-latAccel * 0.0035, -0.045, 0.045)

      const steer = w[0].steerAngle
      const driftLean =
        drifting && state.drift.direction !== 0
          ? -state.drift.direction * clamp01(Math.abs(state.drift.slipAngle) / 0.45) * 0.55
          : 0
      const handTarget = clamp(steer * 2.2 + driftLean, -1.6, 1.6)
      hands += (handTarget - hands) * (1 - Math.exp(-step * 18))
      columnPivot.rotation.z = -hands

      /*
       * Wheels. Steer about the suspension axis, then spin about the axle, in
       * that order — YXZ Euler is exactly R_y(steer) · R_x(spin).
       *
       * Both signs are negated against the contract's values and both negations
       * are here on purpose rather than in the state: STEERING SIGN says
       * `steer > 0` is the driver's right, and rotating a −Z forward vector
       * toward +X is a NEGATIVE rotation about +Y. Likewise a wheel rolling
       * forward turns negatively about +X. Neither is a compensation for a bug
       * elsewhere; they are the one conversion from the convention to a
       * three.js transform, at the only place that draws a wheel.
       */
      for (let i = 0; i < 4; i++) {
        const mount = WHEEL_MOUNT[i]!
        const wheel = w[i]!
        _pos.set(
          mount[0],
          -(FULL_EXTENSION - wheel.compression * SUSPENSION_TRAVEL),
          mount[1],
        )
        _euler.set(-wheel.spin, -wheel.steerAngle, 0, 'YXZ')
        _quat.setFromEuler(_euler)
        _scale.set(mount[2], 1, 1)
        _mat.compose(_pos, _quat, _scale)
        wheels.setMatrixAt(i, _mat)
      }
      wheels.instanceMatrix.needsUpdate = true

      /*
       * §4b: the rim light brightens with drift tier, so tier is readable on
       * the vehicle when the sparks are off-screen.
       *
       * Fast attack, slow release. A tier change has to be legible as a STEP —
       * §7 says a player must know their tier without looking at the HUD — and
       * a symmetric filter turns the step into a ramp that reads as one
       * continuous glow with no rungs in it.
       */
      if (drifting && state.drift.tier > 0) rimTier = state.drift.tier
      const rimTarget = drifting ? TIER_RIM_INTENSITY[state.drift.tier]! : 0
      const rimRate = rimTarget > rimLevel ? 16 : 4.5
      rimLevel += (rimTarget - rimLevel) * (1 - Math.exp(-step * rimRate))
      rimColour.setHex(TIER_COLOUR[rimTier]!)
      emissive[SLOT_RIM]!.copy(rimColour).multiplyScalar(rimLevel)

      /*
       * §5d: the dust accumulation layer. 0.00 at the grid, saturating at 0.55
       * by the end of lap 3.
       *
       * Paced on DISTANCE DRIVEN rather than on lap events alone, so a kart
       * halfway round lap two is halfway between two lap values instead of
       * jumping a step every time it crosses the line. `lap:complete` re-anchors
       * the fraction, which bounds the error from LAP_LENGTH being a constant.
       */
      if (state.grounded) lapDistance += Math.abs(state.speed) * step
      const progress = laps + Math.min(1, lapDistance / LAP_LENGTH)
      const dustTarget = DUST_MAX * (1 - Math.exp(-2.2 * progress))
      dust += (dustTarget - dust) * (1 - Math.exp(-step * 0.6))
      uniforms.uDust.value = dust
    },

    dispose(): void {
      offLap()
      offStart()
      root.removeFromParent()
      for (const mesh of meshes) mesh.removeFromParent()
      wheels.removeFromParent()
      wheels.dispose()
      material.dispose()
      decal.dispose()
      releaseKit()
    },
  }

  // Rest pose, so the first presented frame is not a kart with its wheels at
  // the origin. `InstancedMesh` also computes its culling sphere from whatever
  // the matrices say at first render.
  for (let i = 0; i < 4; i++) {
    const mount = WHEEL_MOUNT[i]!
    _pos.set(mount[0], -REST_LENGTH, mount[1])
    _quat.identity()
    _scale.set(mount[2], 1, 1)
    _mat.compose(_pos, _quat, _scale)
    wheels.setMatrixAt(i, _mat)
  }
  wheels.instanceMatrix.needsUpdate = true
  wheels.computeBoundingSphere()
  // Suspension travel and steer move the instances a little after that sphere
  // is computed; a margin is cheaper than recomputing it every frame and safer
  // than turning culling off for eight karts.
  if (wheels.boundingSphere) wheels.boundingSphere.radius += 0.2

  return model
}
