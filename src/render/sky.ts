import {
  BackSide,
  Color,
  DataTexture,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  RGBAFormat,
  SphereGeometry,
} from 'three'
import type { RNG } from '../types'

/**
 * The sky dome.
 *
 * This exists as its own module because it very nearly did not exist at all.
 * The gradient lived inside the throwaway placeholder scene, and deleting that
 * placeholder deleted the sky with it — the first `npm run check` on the real
 * circuit came back with NINETEEN uniform black tiles. Nothing else in the
 * pipeline noticed: the build passed, the track validated on all twelve
 * invariants, the frame had 45 draw calls in it. The only thing that said
 * anything was the unpainted-tile detector, on its first run against the new
 * world.
 *
 * Ownership was the actual failure. Three agents built the circuit, the road and
 * the canyon, and every one of them correctly reported that the sky belonged to
 * somebody else. Nobody was that somebody. It is `render/`'s, and now it is
 * somewhere that says so.
 */

/**
 * Vertical AND horizontal gradient.
 *
 * A late-afternoon sky is not radially symmetric — it is hot toward the sun and
 * deep blue opposite (ART_DIRECTION §2). Without the horizontal term the sun
 * direction is unreadable no matter how the colours are tuned, and at a 12°
 * elevation the sun direction is most of what tells you what time it is.
 *
 * The per-texel dither is mandated by §2 and it is load-bearing twice over: it
 * stops §10b banding, and it is the only reason the flat-bright tile detector
 * can use a 2e-3 threshold. A dithered sky sits at stdDev around 4.5e-3,
 * comfortably above that gate. Remove the dither and the instrument lies.
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
      // Cosine falloff away from the sun azimuth, tightened so the glow reads as
      // a band rather than half the sky.
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

export interface Sky {
  readonly mesh: Mesh
  dispose(): void
}

/**
 * @param radius Must comfortably exceed the camera's far plane divided by the
 * furthest the camera travels from the origin, or the dome clips and the hole
 * reads as — again — a region that was never drawn.
 */
/**
 * @param radius Deliberately small, and deliberately irrelevant.
 *
 * The first version used a 4000 m dome and rendered pure black — the camera's
 * far plane was 800 m, so the entire sky sat outside the frustum and got
 * clipped. Nineteen uniform black tiles, on a frame where everything else was
 * correct. Sizing a dome to fit inside the far plane only moves the problem,
 * because the far plane also has to reach the distant mesa layers.
 *
 * So the dome does not participate in depth at all: drawn first, depth test and
 * depth write both off, everything else painted over it. Its radius then has to
 * clear the near plane and nothing else.
 */
export function buildSky(rng: RNG, radius = 500): Sky {
  const map = makeSkyTexture(rng)
  const geometry = new SphereGeometry(radius, 48, 32)
  // `fog: false` on purpose: fogging the sky toward the haze colour flattens the
  // gradient into the one uniform value §9b forbids.
  const material = new MeshBasicMaterial({
    map,
    side: BackSide,
    fog: false,
    depthTest: false,
    depthWrite: false,
  })
  const mesh = new Mesh(geometry, material)
  // The dome rides with the camera, so it must never be culled or shadowed.
  mesh.frustumCulled = false
  mesh.matrixAutoUpdate = true
  mesh.renderOrder = -1000

  return {
    mesh,
    dispose(): void {
      geometry.dispose()
      material.dispose()
      map.dispose()
    },
  }
}
