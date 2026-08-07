import {
  BackSide,
  BoxGeometry,
  Color,
  CylinderGeometry,
  DataTexture,
  InstancedMesh,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  RGBAFormat,
  Scene,
  SphereGeometry,
  Vector3,
} from 'three'
import type { RNG } from '../types'
import { makeRockSurface } from './procedural'

/**
 * A stand-in canyon. `world/` replaces it; the problems it solves do not change.
 *
 * Two things carried over intact from the city it replaces, because both were
 * lessons rather than decoration:
 *
 *   - Depth comes from repeated elements of KNOWN SIZE receding to a vanishing
 *     point, not from ground texture. The city had a lamp line; a daylight
 *     desert has marker posts and the canyon's own shadow bands raked across
 *     the road by a 12-degree sun.
 *   - Spatial variation with a VISIBLE CAUSE reads as depth far better than
 *     noise does, because the eye can see why it is there.
 *
 * What did not carry over: every emissive surface, all sixteen point lights,
 * and the windows. A sun key produces real shading gradients across a rock face
 * for free, which is what the windows existed to fake.
 */

export const ROAD_HALF_WIDTH = 9

export interface PlaceholderCanyon {
  readonly group: Object3D
  readonly length: number
}

/**
 * Sky gradient — vertical AND horizontal.
 *
 * The city version was a pure function of height. A late-afternoon sky is not
 * radially symmetric: it is hot toward the sun and deep blue opposite, and
 * without the horizontal term the sun direction is unreadable no matter how the
 * colours are tuned.
 *
 * The per-texel dither is mandated by ART_DIRECTION §2 and it is load-bearing
 * twice over. It stops §9b banding, and it is the only reason the flat-bright
 * tile detector can use a 2e-3 threshold — a dithered sky sits at stdDev
 * ~4.5e-3, comfortably above the gate. Remove it and the instrument lies.
 */
function makeSkyTexture(rng: RNG): DataTexture {
  const w = 256
  const h = 512
  const data = new Uint8Array(w * h * 4)

  const zenith = new Color(0x3f77c4)
  const mid = new Color(0x7fb0e0)
  const horizonSun = new Color(0xffb463)
  const horizonAway = new Color(0xb9c9d8)
  const c = new Color()
  const horizon = new Color()

  for (let y = 0; y < h; y++) {
    const v = y / (h - 1)
    for (let x = 0; x < w; x++) {
      // u wraps the dome. 0.5 faces the sun.
      const u = x / w
      // Cosine falloff away from the sun azimuth, tightened so the glow is a
      // band rather than half the sky.
      const toSun = Math.max(0, Math.cos((u - 0.5) * Math.PI * 2))
      horizon.copy(horizonAway).lerp(horizonSun, Math.pow(toSun, 2.2))

      if (v < 0.5) c.copy(horizon).lerp(mid, v / 0.5)
      else c.copy(mid).lerp(zenith, (v - 0.5) / 0.5)

      const n = (rng() - 0.5) * 0.008
      const i = (y * w + x) * 4
      data[i] = Math.round(Math.min(1, Math.max(0, c.r + n)) * 255)
      data[i + 1] = Math.round(Math.min(1, Math.max(0, c.g + n)) * 255)
      data[i + 2] = Math.round(Math.min(1, Math.max(0, c.b + n)) * 255)
      data[i + 3] = 255
    }
  }

  const tex = new DataTexture(data, w, h, RGBAFormat)
  tex.magFilter = LinearFilter
  tex.minFilter = LinearFilter
  tex.needsUpdate = true
  return tex
}

export function buildPlaceholderCanyon(scene: Scene, rng: RNG, anisotropy: number): PlaceholderCanyon {
  const group = new Object3D()
  const mat4 = new Matrix4()
  const scratch = new Vector3()
  const quat = new Quaternion()
  const LENGTH = 420

  // --- sky ------------------------------------------------------------------
  const sky = new Mesh(
    new SphereGeometry(900, 48, 32),
    new MeshBasicMaterial({ map: makeSkyTexture(rng.fork('sky')), side: BackSide, fog: false }),
  )
  group.add(sky)

  const rock = makeRockSurface(512, rng.fork('rock'), anisotropy)

  // --- canyon walls ---------------------------------------------------------
  /*
   * Stacked, rotated slabs rather than one box per wall. A box gives hard 90°
   * verticals — a §10b amateur tell — and a wall built from a single primitive
   * reads as architecture however it is coloured. Six strata bands each get
   * their own albedo tint and their own inset, so the wall has a profile.
   */
  const STRATA = [
    { colour: 0xc9764a, inset: 0.0 }, // caprock
    { colour: 0xb5623f, inset: 1.1 },
    { colour: 0xd8bfa0, inset: 0.4 }, // gypsum seam — the mandatory value break
    { colour: 0xa0553a, inset: 1.9 },
    { colour: 0x7d3529, inset: 2.6 }, // iron oxide
    { colour: 0x8f4a33, inset: 2.2 },
  ]
  /*
   * 21.8 m total, down from 33.4, and the walls sit further out below.
   *
   * The first pass put 33 m walls 20 m from the centreline. That is a gorge, and
   * it failed §1's sky occupancy floor and the §9a exposure band together — the
   * frame simply had no sky and no sunlit sand in it. Fixing that by widening
   * the exposure band would have been fixing the instrument to match the mistake.
   */
  const BAND_HEIGHTS = [6, 5, 1.0, 5, 0.8, 4]

  const wallRng = rng.fork('walls')
  const slabGeo = new BoxGeometry(1, 1, 1)
  const SEGMENTS = 42

  for (let s = 0; s < STRATA.length; s++) {
    const band = STRATA[s]!
    const mesh = new InstancedMesh(
      slabGeo,
      new MeshStandardMaterial({
        color: band.colour,
        map: rock.map,
        roughnessMap: rock.roughnessMap,
        roughness: 1.0,
        metalness: 0.0,
      }),
      SEGMENTS * 2,
    )
    mesh.castShadow = true
    mesh.receiveShadow = true

    // Height of this band's base, summing the ones below it.
    let base = 0
    for (let k = STRATA.length - 1; k > s; k--) base += BAND_HEIGHTS[k]!
    const bandH = BAND_HEIGHTS[s]!

    let i = 0
    for (let side = -1; side <= 1; side += 2) {
      for (let seg = 0; seg < SEGMENTS; seg++) {
        const z = -LENGTH / 2 + (seg + 0.5) * (LENGTH / SEGMENTS)
        // The canyon breathes: half-width varies along its length so the walls
        // are never two parallel planes.
        const squeeze = Math.sin(z * 0.012) * 3.5 + wallRng() * 1.6
        const depth = LENGTH / SEGMENTS + 0.6
        const w = 10 + wallRng() * 5
        const x = side * (ROAD_HALF_WIDTH + 9 + band.inset + squeeze + w / 2)

        mat4.makeRotationY((wallRng() - 0.5) * 0.09)
        mat4.scale(scratch.set(w, bandH * (0.85 + wallRng() * 0.3), depth))
        mat4.setPosition(x, base + bandH / 2, z)
        mesh.setMatrixAt(i++, mat4)
      }
    }
    mesh.instanceMatrix.needsUpdate = true
    group.add(mesh)
  }

  // --- talus ----------------------------------------------------------------
  // Scree at the foot of both walls. Breaks the wall/floor junction, which is
  // otherwise a perfectly straight line running to the vanishing point and the
  // most obvious tell that this is boxes.
  const talusRng = rng.fork('talus')
  const boulders = new InstancedMesh(
    slabGeo,
    new MeshStandardMaterial({
      color: 0xa8917a,
      map: rock.map,
      roughnessMap: rock.roughnessMap,
      roughness: 1.0,
    }),
    260,
  )
  boulders.castShadow = true
  boulders.receiveShadow = true
  for (let i = 0; i < 260; i++) {
    const side = i % 2 === 0 ? 1 : -1
    const z = -LENGTH / 2 + talusRng() * LENGTH
    const squeeze = Math.sin(z * 0.012) * 3.5
    const out = talusRng() * 4.5
    const sc = 0.5 + talusRng() * 1.9
    quat.setFromAxisAngle(scratch.set(talusRng(), talusRng(), talusRng()).normalize(), talusRng() * 3.14)
    mat4.makeRotationFromQuaternion(quat)
    mat4.scale(scratch.set(sc, sc * 0.7, sc))
    mat4.setPosition(side * (ROAD_HALF_WIDTH + 1.2 + squeeze + out), sc * 0.3, z)
    boulders.setMatrixAt(i, mat4)
  }
  boulders.instanceMatrix.needsUpdate = true
  group.add(boulders)

  // --- marker posts ---------------------------------------------------------
  /*
   * The depth line, inherited directly from the city's lamp row. Identical
   * objects at known spacing shrinking toward a vanishing point is the single
   * strongest depth cue available, and it survives the theme change unchanged —
   * only the object does. These cast 4.7x shadows across the road, which is the
   * second cue and comes free with the sun angle.
   */
  const postGeo = new CylinderGeometry(0.09, 0.11, 1.5, 6)
  const posts = new InstancedMesh(
    postGeo,
    new MeshStandardMaterial({ color: 0xf2ead6, roughness: 0.7 }),
    Math.floor(LENGTH / 12) * 2,
  )
  posts.castShadow = true
  let p = 0
  for (let z = -LENGTH / 2; z < LENGTH / 2; z += 12) {
    const squeeze = Math.sin(z * 0.012) * 3.5
    for (let side = -1; side <= 1; side += 2) {
      mat4.identity()
      mat4.setPosition(side * (ROAD_HALF_WIDTH + 0.4 + squeeze), 0.75, z)
      posts.setMatrixAt(p++, mat4)
    }
  }
  posts.count = p
  posts.instanceMatrix.needsUpdate = true
  group.add(posts)

  // --- kerbs ----------------------------------------------------------------
  // Value contrast, not hue: ART_DIRECTION §3a rules out red-and-white kerbs
  // because #e0453f sits 3 degrees from the upper strata and vanishes into the
  // cliff behind it.
  const kerbGeo = new BoxGeometry(0.6, 0.22, 3.4)
  const kerbLight = new MeshStandardMaterial({ color: 0xf2ead6, roughness: 0.44 })
  const kerbDark = new MeshStandardMaterial({ color: 0x241f22, roughness: 0.44 })
  for (const mat of [kerbLight, kerbDark]) {
    const n = Math.floor(LENGTH / 6.8) * 2
    const kerb = new InstancedMesh(kerbGeo, mat, n)
    kerb.receiveShadow = true
    let k = 0
    const phase = mat === kerbLight ? 0 : 3.4
    for (let z = -LENGTH / 2 + phase; z < LENGTH / 2; z += 6.8) {
      const squeeze = Math.sin(z * 0.012) * 3.5
      for (let side = -1; side <= 1; side += 2) {
        mat4.identity()
        mat4.setPosition(side * (ROAD_HALF_WIDTH + squeeze - 0.3), 0.11, z)
        kerb.setMatrixAt(k++, mat4)
      }
    }
    kerb.count = k
    kerb.instanceMatrix.needsUpdate = true
    group.add(kerb)
  }

  scene.add(group)
  return { group, length: LENGTH }
}
