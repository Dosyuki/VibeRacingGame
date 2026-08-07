import type { WebGLRenderer } from 'three'
import type { FrameLumaStats, GLReport, TileLuma } from '../types'

/**
 * The two instruments that everything else trusts. Both are written against
 * failures that produce confident, precise, entirely wrong numbers.
 */

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|microsoft basic render|generic renderer/i

export function readGLReport(
  renderer: WebGLRenderer,
  failedShaders: readonly string[],
  contextLost: boolean,
): GLReport {
  const gl = renderer.getContext()
  const dbg = gl.getExtension('WEBGL_debug_renderer_info')

  // UNMASKED_* is the string that names the real adapter. `gl.RENDERER` alone
  // reports a generic value on several browsers, which is exactly specific
  // enough to look like an answer and never match a software rasteriser.
  const rendererName = String(
    (dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '',
  )
  const vendorName = String(
    (dbg && gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) || gl.getParameter(gl.VENDOR) || '',
  )

  const aniso = gl.getExtension('EXT_texture_filter_anisotropic')

  // Read from the context itself rather than trusting a flag passed in. Whether
  // the presented frame can be read back at all is a property of the context
  // that exists, not of what somebody intended to ask for.
  const preserveDrawingBuffer = gl.getContextAttributes()?.preserveDrawingBuffer ?? false

  return {
    preserveDrawingBuffer,
    renderer: rendererName,
    vendor: vendorName,
    isSoftware: SOFTWARE_RENDERER.test(rendererName),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    maxAnisotropy: aniso ? (gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number) : 1,
    failedShaders: failedShaders.slice(),
    contextLost,
  }
}

const TILES = 8

/**
 * "Black" means UNPAINTED, not dark.
 *
 * A night game needs this distinction to be sharp. ART_DIRECTION section 3
 * forbids pure `#000000` as an albedo anywhere and the sky gradient bottoms out
 * well above this value, so a tile below it was not drawn — which is the only
 * thing this number is allowed to mean. Set it any higher and it starts
 * reporting a correctly-lit 2 a.m. sky as a rendering failure.
 *
 * Worth recording how this number got picked, because the reasoning was wrong
 * the first time: the threshold started at 0.02, the very first smoke run
 * failed on it, and the initial conclusion was that the instrument was
 * miscalibrated for a dark scene. It was not. The screenshot showed a ground
 * plane lit by nothing at all — `MeshStandardMaterial` with no light in the
 * scene renders pure black, and the detector had found a genuine defect on its
 * first run. The threshold change was defensible on its own merits and was
 * kept; the diagnosis that motivated it was not. Look at the frame before
 * concluding the instrument is lying.
 */
const BLACK_LUMA = 0.004

/** Fully clipped. The section 8 additive energy budget gates on this. */
const CLIPPED_LUMA = 0.99

/**
 * Luma statistics over the PRESENTED image, on an 8x8 tile grid.
 *
 * Two things this is designed around:
 *
 * 1. Draw calls are not proof of rendering. Every known black-screen failure
 *    still issues a full frame's worth of draws into a canvas nobody sees. Only
 *    the pixels can answer the question.
 *
 * 2. A whole-image standard deviation cannot see a partially black frame. Half
 *    black and half correct scores *better* on global spread than a healthy
 *    frame does. The tile grid is what makes that failure visible, so callers
 *    assert on `worstTileBlackFraction`, not on `stdDev`.
 *
 * Reading pixels after present requires `preserveDrawingBuffer`. Without it
 * `readPixels` returns discarded contents, which reads as "100% of frames are
 * black" and is completely false. This throws in that case instead of returning
 * the lie.
 */
export function readFrameLumaStats(
  renderer: WebGLRenderer,
  preserveDrawingBuffer: boolean,
): FrameLumaStats {
  if (!preserveDrawingBuffer) {
    throw new Error(
      'frameLumaStats requires a context created with preserveDrawingBuffer (use ?debug=frames). ' +
        'Reading the presented frame without it returns discarded contents, not black frames.',
    )
  }

  const gl = renderer.getContext()
  const w = gl.drawingBufferWidth
  const h = gl.drawingBufferHeight

  // Stride-sample rather than reading every pixel; at 1080p a full read is ~8 MB
  // per call and the harness takes hundreds. The stride is deterministic, so
  // two runs sample the identical pixels.
  const stride = Math.max(1, Math.floor(Math.min(w, h) / 512))
  const sw = Math.floor(w / stride)
  const sh = Math.floor(h / stride)

  const buf = new Uint8Array(w * h * 4)
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf)

  const tileMean = new Float64Array(TILES * TILES)
  const tileSq = new Float64Array(TILES * TILES)
  const tileBlack = new Float64Array(TILES * TILES)
  const tileClip = new Float64Array(TILES * TILES)
  const tileCount = new Float64Array(TILES * TILES)

  let sum = 0
  let sumSq = 0
  let black = 0
  let clipped = 0
  let n = 0

  for (let sy = 0; sy < sh; sy++) {
    const y = sy * stride
    const ty = Math.min(TILES - 1, Math.floor((y / h) * TILES))
    for (let sx = 0; sx < sw; sx++) {
      const x = sx * stride
      const i = (y * w + x) * 4
      // Rec. 709 luma on the already-tonemapped, already-encoded output.
      const luma =
        (0.2126 * buf[i]! + 0.7152 * buf[i + 1]! + 0.0722 * buf[i + 2]!) / 255

      const tx = Math.min(TILES - 1, Math.floor((x / w) * TILES))
      const ti = ty * TILES + tx

      sum += luma
      sumSq += luma * luma
      if (luma < BLACK_LUMA) black++
      if (luma >= CLIPPED_LUMA) clipped++
      n++

      tileMean[ti]! += luma
      tileSq[ti]! += luma * luma
      if (luma < BLACK_LUMA) tileBlack[ti]! += 1
      if (luma >= CLIPPED_LUMA) tileClip[ti]! += 1
      tileCount[ti]! += 1
    }
  }

  const mean = n > 0 ? sum / n : 0
  const variance = n > 0 ? Math.max(0, sumSq / n - mean * mean) : 0

  const tiles: TileLuma[] = []
  let worstBlack = 0
  let worstClip = 0
  for (let ty = 0; ty < TILES; ty++) {
    for (let tx = 0; tx < TILES; tx++) {
      const ti = ty * TILES + tx
      const c = tileCount[ti]!
      if (c === 0) continue
      const m = tileMean[ti]! / c
      const v = Math.max(0, tileSq[ti]! / c - m * m)
      const bf = tileBlack[ti]! / c
      const cf = tileClip[ti]! / c
      if (bf > worstBlack) worstBlack = bf
      if (cf > worstClip) worstClip = cf
      tiles.push({ x: tx, y: ty, mean: m, stdDev: Math.sqrt(v), blackFraction: bf, clippedFraction: cf })
    }
  }

  return {
    mean,
    stdDev: Math.sqrt(variance),
    blackFraction: n > 0 ? black / n : 0,
    clippedFraction: n > 0 ? clipped / n : 0,
    tiles,
    worstTileBlackFraction: worstBlack,
    worstTileClippedFraction: worstClip,
  }
}
