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
 * Thresholds, all of them calibrated against a measured reference rather than
 * chosen by eye. See FrameLumaStats in types.ts for the full reasoning.
 */

/** Below the 24-bit encode floor. On a night scene, 6-24% of pixels sit here. */
const BLACK_LUMA = 0.004

/**
 * Under a sun this is a CEILING, not a floor. The deepest legitimate surface in
 * the scene — a niche under an overhang seeing 8% of sky and no sun — computes
 * through the ACES fit to luma 0.070, so anything below 0.05 is a shadow term
 * clamping to zero or geometry that never got lit.
 */
const DARK_LUMA = 0.05

/**
 * A wide sanity rail, no longer a budget. At night this threshold separated
 * light SOURCES from lit surfaces and was capped at 8%. Under a 12-degree sun,
 * luma 0.5 is only 1.19x sunlit sand, so sand, rock and sky are all above it.
 */
const BRIGHT_LUMA = 0.5

/**
 * Where "walks toward a white screen" lives in daylight. Derived: reaching 0.95
 * takes 6.6x sunlit sand, roughly +2.7 stops, which only the near-sun haze band,
 * the sun disc, specular glints and bloom can do.
 */
const HIGHLIGHT_LUMA = 0.95

/** Fully clipped. The section 9a energy budget gates on this. */
const CLIPPED_LUMA = 0.99

/**
 * Painted, but with nothing in it — the daylight inversion of an unpainted tile.
 * A blown sky, a constant-colour shader fallback, a procedural sand albedo that
 * returned one value.
 *
 * The threshold is only safe because ART_DIRECTION section 2 mandates at least
 * +/-2 code values of blue-noise dither in the sky gradient. That dither puts a
 * correct sky at stdDev around 4.5e-3, which is 2.3x above this gate. Remove the
 * dither mandate and this detector starts lying. The value itself is a GUESS and
 * belongs in the first measurement round.
 */
const FLAT_STDDEV = 2e-3

/**
 * A tile below this standard deviation was not rendered — it was cleared.
 *
 * The darkest tiles of a real shipped neon-night scene measure 8.2e-4 to
 * 1.8e-2. A cleared buffer measures exactly 0. This sits about 80x below the
 * smallest real value observed, which is the margin that keeps a legitimately
 * black alley wall from being reported as a rendering failure.
 */
const UNPAINTED_STDDEV = 1e-5

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
  let dark = 0
  let bright = 0
  let highlight = 0
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
      if (luma < DARK_LUMA) dark++
      if (luma >= BRIGHT_LUMA) bright++
      if (luma >= HIGHLIGHT_LUMA) highlight++
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
  let unpainted = 0
  let flatBright = 0
  for (let ty = 0; ty < TILES; ty++) {
    for (let tx = 0; tx < TILES; tx++) {
      const ti = ty * TILES + tx
      const c = tileCount[ti]!
      if (c === 0) continue
      const m = tileMean[ti]! / c
      const v = Math.max(0, tileSq[ti]! / c - m * m)
      const sd = Math.sqrt(v)
      const bf = tileBlack[ti]! / c
      const cf = tileClip[ti]! / c
      if (bf > worstBlack) worstBlack = bf
      if (cf > worstClip) worstClip = cf
      // Uniform, at ANY brightness. The `m < BLACK_LUMA` clause that used to be
      // here made this detector silently inoperative the moment anything cleared
      // to a bright colour — see the note on FrameLumaStats in types.ts.
      if (sd < UNPAINTED_STDDEV) unpainted++
      else if (sd < FLAT_STDDEV && m >= BRIGHT_LUMA) flatBright++
      tiles.push({ x: tx, y: ty, mean: m, stdDev: sd, blackFraction: bf, clippedFraction: cf })
    }
  }

  return {
    mean,
    stdDev: Math.sqrt(variance),
    blackFraction: n > 0 ? black / n : 0,
    darkFraction: n > 0 ? dark / n : 0,
    brightFraction: n > 0 ? bright / n : 0,
    highlightFraction: n > 0 ? highlight / n : 0,
    clippedFraction: n > 0 ? clipped / n : 0,
    tiles,
    unpaintedTiles: unpainted,
    flatBrightTiles: flatBright,
    worstTileBlackFraction: worstBlack,
    worstTileClippedFraction: worstClip,
  }
}
