import type { WebGLRenderer } from 'three'
import type { QualityProfile, QualityTier } from '../types'

/**
 * Tier tables are requests. `resolveQuality` clamps them against what the GPU
 * actually reports before anything is published.
 *
 * An unclamped profile asking for 2048² textures on a device that caps at 1024
 * fails inside whichever material happens to build first, and the error surfaces
 * as somebody else's texture bug in somebody else's subsystem.
 */

interface QualityRequest {
  readonly renderScale: number
  readonly shadows: boolean
  readonly shadowCascades: 0 | 2 | 3 | 4
  readonly ssr: boolean
  readonly ssao: boolean
  readonly bloom: boolean
  readonly motionBlur: boolean
  readonly particleBudget: number
  readonly lodDistance: number
  readonly maxTextureSize: number
  readonly maxAnisotropy: number
}

const REQUESTS: Readonly<Record<QualityTier, QualityRequest>> = {
  low: {
    renderScale: 0.7,
    shadows: false,
    shadowCascades: 0,
    ssr: false,
    ssao: false,
    bloom: true,
    motionBlur: false,
    particleBudget: 400,
    lodDistance: 35,
    maxTextureSize: 256,
    maxAnisotropy: 1,
  },
  medium: {
    renderScale: 1.0,
    shadows: true,
    shadowCascades: 2,
    ssr: false,
    ssao: false,
    bloom: true,
    motionBlur: false,
    particleBudget: 1200,
    lodDistance: 50,
    maxTextureSize: 512,
    maxAnisotropy: 4,
  },
  high: {
    renderScale: 1.0,
    shadows: true,
    shadowCascades: 3,
    ssr: true,
    ssao: true,
    bloom: true,
    motionBlur: true,
    particleBudget: 3000,
    lodDistance: 60,
    maxTextureSize: 1024,
    maxAnisotropy: 8,
  },
  ultra: {
    renderScale: 1.0,
    shadows: true,
    shadowCascades: 4,
    ssr: true,
    ssao: true,
    bloom: true,
    motionBlur: true,
    particleBudget: 6000,
    lodDistance: 90,
    maxTextureSize: 2048,
    maxAnisotropy: 8,
  },
}

export function resolveQuality(tier: QualityTier, renderer: WebGLRenderer): QualityProfile {
  const req = REQUESTS[tier]
  const gl = renderer.getContext()
  const glMaxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
  const anisoExt = gl.getExtension('EXT_texture_filter_anisotropic')
  const glMaxAniso = anisoExt
    ? (gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number)
    : 1

  return {
    tier,
    renderScale: req.renderScale,
    shadows: req.shadows,
    shadowCascades: req.shadowCascades,
    ssr: req.ssr,
    ssao: req.ssao,
    bloom: req.bloom,
    motionBlur: req.motionBlur,
    particleBudget: req.particleBudget,
    lodDistance: req.lodDistance,
    maxTextureSize: Math.min(req.maxTextureSize, glMaxTexture),
    maxAnisotropy: Math.min(req.maxAnisotropy, glMaxAniso),
  }
}

/**
 * Detection is deliberately coarse and always overridable with `?quality=`.
 * Every harness pins it, because a tier that changes with ambient machine load
 * would make two measurement runs incomparable.
 */
export function detectTier(): QualityTier {
  const params = new URLSearchParams(location.search)
  const forced = params.get('quality')
  if (forced === 'low' || forced === 'medium' || forced === 'high' || forced === 'ultra') {
    return forced
  }
  const coarsePointer = matchMedia('(pointer: coarse)').matches
  const cores = navigator.hardwareConcurrency ?? 4
  if (coarsePointer) return cores >= 8 ? 'medium' : 'low'
  return cores >= 12 ? 'high' : 'medium'
}
