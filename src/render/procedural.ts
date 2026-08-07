import { createNoise2D } from 'simplex-noise'
import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three'
import type { RNG } from '../types'

/**
 * Procedural texture toolkit. Everything the game draws on comes from here —
 * there are no image files in this repository and there will not be any.
 *
 * These exist to satisfy ART_DIRECTION §4: roughness must vary spatially. One
 * roughness value everywhere reads as plastic no matter how good the lighting
 * is, and §9b lists it as an amateur tell. On a wet night circuit it is worse
 * than plastic — a uniformly mirrored road gives the eye no distance cue, so the
 * ground collapses into a single flat sheet and the scene loses its depth.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE TRAP, AND WHY THESE MAPS ARE BUILT THE WAY THEY ARE
 *
 * The first version generated roughness and normals independently, each with a
 * high-frequency aggregate octave, and tiled the normal map 24 times. It turned
 * the road into visual static — a field of coloured speckle with no surface in
 * it at all.
 *
 * That is specular aliasing, and a wet road is the worst possible place for it.
 * At roughness 0.03 the surface is a mirror, so the reflected direction is
 * essentially a delta function: a normal that swings by a few degrees between
 * neighbouring texels sends adjacent pixels to completely different parts of a
 * high-contrast neon scene. Mipmapping averages the normals toward flat but
 * cannot average the *reflections*, so the sparkle survives filtering and gets
 * worse with distance, not better.
 *
 * Two rules came out of it, and both are load-bearing:
 *
 *   1. Roughness and normal derive from ONE shared height field. A surface
 *      whose relief and whose wetness disagree is not a surface.
 *   2. Detail frequency is bounded by roughness. Mirror-smooth regions get
 *      gentle, low-frequency relief only. Fine aggregate belongs on the dried
 *      strips, where roughness is high enough to average it out.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Fractal Brownian motion. Deterministic in the noise function handed to it. */
function fbm(
  noise: (x: number, y: number) => number,
  x: number,
  y: number,
  octaves: number,
  lacunarity = 2.0,
  gain = 0.5,
): number {
  let sum = 0
  let amp = 1
  let freq = 1
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * freq, y * freq) * amp
    norm += amp
    amp *= gain
    freq *= lacunarity
  }
  return sum / norm
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function makeTexture(size: number, data: Uint8Array, anisotropy: number): DataTexture {
  const tex = new DataTexture(data, size, size, RGBAFormat)
  tex.wrapS = RepeatWrapping
  tex.wrapT = RepeatWrapping
  tex.magFilter = LinearFilter
  tex.minFilter = LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = anisotropy
  tex.needsUpdate = true
  return tex
}

/**
 * Concrete / rendered facade. Subtle, and mandatory.
 *
 * A flat box face lit by a hemisphere term has a constant normal and therefore
 * a constant colour: the whole face comes out as one exact value, variance
 * zero. That is an ART_DIRECTION §4 failure (uniform roughness reads as
 * plastic) and an §8b failure at the same time — the partial-present detector
 * keys on uniformity, so a perfectly flat facade is indistinguishable from a
 * region the GPU never painted. The energy check caught exactly that here,
 * reporting two unpainted tiles on a frame where everything had in fact been
 * drawn correctly.
 *
 * Weathering streaks, patch variation and grain, all low-contrast. Enough to
 * break the uniformity, not enough to look like camouflage.
 */
export function makeRockSurface(
  size: number,
  rng: RNG,
  anisotropy: number,
): { map: DataTexture; roughnessMap: DataTexture } {
  const patch = createNoise2D(rng)
  const grain = createNoise2D(rng.fork('grain'))
  const albedo = new Uint8Array(size * size * 4)
  const rough = new Uint8Array(size * size * 4)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size

      const blotch = fbm(patch, u * 3, v * 3, 4)
      /*
       * HORIZONTAL bedding, not vertical weathering.
       *
       * This band was stretched the other way when the theme was a rain-slick
       * city, because rain runs down a facade. Sedimentary rock is laid down in
       * horizontal beds, so the axes swap — and getting this backwards is not a
       * subtle error, it reads immediately as a cliff made of dripping concrete.
       */
      const bedding = fbm(patch, u * 2.5, v * 26, 3)
      const speck = grain(u * 200, v * 200)

      // Sandstone is bright in sun. The city version sat at 0.78 because it was
      // meant to disappear into the dark.
      const tint = 1 + blotch * 0.26 + bedding * 0.16 + speck * 0.05
      const a = Math.round(Math.min(1, Math.max(0, tint * 0.94)) * 255)

      // ART_DIRECTION §5a: rock 0.62-0.88, driven by strata hardness. Caprock
      // is wind-polished and smooth; shale bands are matte.
      const r = Math.round(
        Math.min(1, Math.max(0, 0.75 + bedding * 0.13 + blotch * 0.06 + speck * 0.04)) * 255,
      )

      const i = (y * size + x) * 4
      albedo[i] = a
      albedo[i + 1] = a
      albedo[i + 2] = a
      albedo[i + 3] = 255
      rough[i] = r
      rough[i + 1] = r
      rough[i + 2] = r
      rough[i + 3] = 255
    }
  }

  const map = makeTexture(size, albedo, anisotropy)
  // Albedo is colour data; roughness is not. Getting this backwards double-
  // applies the sRGB curve and quietly changes every material in the scene.
  map.colorSpace = SRGBColorSpace
  const roughnessMap = makeTexture(size, rough, anisotropy)
  map.repeat.set(2, 2)
  roughnessMap.repeat.set(2, 2)
  return { map, roughnessMap }
}

export interface RoadSurfaceMaps {
  readonly roughnessMap: DataTexture
  readonly normalMap: DataTexture
  /** Feed to `MeshStandardMaterial.normalScale`. Kept low on purpose. */
  readonly normalScale: number
}

/**
 * Wet-road roughness and relief, from one height field.
 *
 * Mapped 1:1 across the surface rather than tiled: puddles are large formations
 * and a repeating puddle pattern destroys the very distance read this texture
 * exists to create. Feature size is the depth cue — how big the puddles look is
 * how far away you are.
 *
 * Roughness regimes, from ART_DIRECTION §3a:
 *   puddle      0.03   standing water, a true mirror
 *   wet asphalt 0.12   the default road
 *   dried strip 0.42   where tyres have cleared the water
 */
export function makeRoadSurface(size: number, rng: RNG, anisotropy: number): RoadSurfaceMaps {
  const base = createNoise2D(rng)
  const detail = createNoise2D(rng.fork('detail'))

  /*
   * FEATURE SCALE IS THE DEPTH CUE.
   *
   * The first tuning put the pools at 4 cycles across the whole surface — about
   * 100 m per puddle on a 400 m plane. Technically "varying", visually useless:
   * one or two features fill the entire view, so every part of the road looks
   * the same distance away and the ground still reads as a single flat sheet.
   *
   * Perspective only tells you about distance when there are repeated features
   * of KNOWN size to compare. Puddles around 8-15 m across put a dozen of them
   * in view at once, shrinking as they recede, and that ladder is what the eye
   * actually measures depth with.
   */
  const bandLow = (u: number, v: number): number =>
    // Large wet and dry regions. Also the band the normals are built from.
    fbm(base, u * 6, v * 6, 2) * 0.55 +
    // Drain streaks: the field stretched hard along one axis, so water reads as
    // running somewhere rather than sitting in circular blobs.
    fbm(base, u * 3, v * 26, 2) * 0.3

  const height = (u: number, v: number): number =>
    bandLow(u, v) + fbm(base, u * 34, v * 34, 4) * 0.75

  const roughData = new Uint8Array(size * size * 4)
  const normData = new Uint8Array(size * size * 4)

  // Cache both bands once; each is sampled several times per texel for the
  // derivatives and the noise is the expensive part.
  const h = new Float32Array(size * size)
  const hLow = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      h[y * size + x] = height(u, v)
      hLow[y * size + x] = bandLow(u, v)
    }
  }
  const at = (x: number, y: number): number =>
    h[((y + size) % size) * size + ((x + size) % size)]!
  const atLow = (x: number, y: number): number =>
    hLow[((y + size) % size) * size + ((x + size) % size)]!

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const hv = at(x, y)

      /*
       * Sand collects in the low ground; the racing line is where tyres have
       * polished the tarmac. Bands stay tight — a wide, gentle ramp averages
       * back into the uniform sheet this whole file exists to avoid.
       *
       * ART_DIRECTION §5a: road 0.48-0.85. The whole range shifted upward and
       * compressed when the theme went dry. Nothing here is a mirror any more,
       * which is what lets the fine detail below come back.
       */
      const sanded = smoothstep(-0.02, -0.28, hv)
      const polished = smoothstep(0.06, 0.38, hv)

      let rough = 0.66
      rough += (0.85 - rough) * sanded
      rough += (0.48 - rough) * polished

      /*
       * Fine grain, applied EVERYWHERE now rather than gated to the rough
       * regions. Rule 2 in the header bounds detail frequency by roughness, and
       * the bound has gone slack: at roughness 0.48-0.85 the specular lobe is
       * broad, so a few degrees of normal swing between texels moves the sample
       * within a lobe that is already integrating a large solid angle, and
       * mipmaps average it correctly. The gate that used to be here was
       * suppressing exactly the aggregate detail a dry road needs.
       *
       * The rule has NOT gone away — it moved onto the kart. Chrome at
       * roughness 0.18 and clearcoat at 0.07, under a single very small very
       * bright sun, is a harsher aliasing driver than forty neon signs ever
       * were.
       */
      rough += detail((x / size) * 90, (y / size) * 90) * 0.06

      const g = Math.round(Math.min(1, Math.max(0, rough)) * 255)
      roughData[i] = g
      roughData[i + 1] = g
      roughData[i + 2] = g
      roughData[i + 3] = 255

      /*
       * Normals come from the LOW BAND of the same field, not the full one.
       *
       * This is rule 2 in the header, applied precisely: band-limiting the
       * normals is what lets the roughness carry sharp, small features without
       * the mirror turning them into sparkle. Reflection direction is what
       * aliases; roughness only changes how blurry the reflection is, and a
       * blurry patch next to a sharp one is exactly the contrast we want.
       *
       * Same field, different band — still one coherent surface.
       */
      const dx = (atLow(x + 1, y) - atLow(x - 1, y)) * 0.5
      const dy = (atLow(x, y + 1) - atLow(x, y - 1)) * 0.5

      let nx = -dx
      let ny = -dy
      const nz = 1
      const len = Math.hypot(nx, ny, nz)
      nx /= len
      ny /= len

      normData[i] = Math.round((nx * 0.5 + 0.5) * 255)
      normData[i + 1] = Math.round((ny * 0.5 + 0.5) * 255)
      normData[i + 2] = Math.round((nz / len) * 0.5 * 255 + 127.5)
      normData[i + 3] = 255
    }
  }

  return {
    roughnessMap: makeTexture(size, roughData, anisotropy),
    normalMap: makeTexture(size, normData, anisotropy),
    // Raised from 0.35. That value existed to keep a mirror from turning back
    // into sandpaper; a matte road has no such constraint and needs the relief
    // to read at all under a raking 12-degree sun.
    normalScale: 0.85,
  }
}
