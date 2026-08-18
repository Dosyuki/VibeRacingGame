/**
 * ART_DIRECTION §9a — the frame-energy budget, enforced as a number.
 *
 *   node tools/energy-check.mjs
 *   node tools/energy-check.mjs --broken          # self-test: all three directions
 *   node tools/energy-check.mjs --broken=dim      # one direction only
 *   node tools/energy-check.mjs --port=4203       # another agent holds the default
 *
 * A frame drifts one defensible commit at a time. No single change looks wrong,
 * every reviewer says "a little brighter is fine" or "the shadows are hard to
 * read", and four rounds later the image has no range left in it. Taste cannot
 * hold that line across parallel agents who never see each other's work. A
 * measured ceiling can.
 *
 * WHICH WAY THE FRAME DRIFTS DEPENDS ON THE THEME, AND THIS FILE HAS CHANGED
 * THEME ONCE. Under the night circuit the failure was a white screen creeping
 * in. Under a 12° sun it is the opposite: a desert is *supposed* to be bright,
 * and its failure is a FLAT frame — high mean luma with collapsing variance,
 * which is what happens when shadows get lightened one commit at a time to
 * answer a readability complaint. The std-dev floor and the shadow-occupancy
 * floor are the two rows a flat frame cannot pass, and the two most likely to
 * be argued away. See §9a.
 *
 * THERE ARE THREE BANDS, NOT ONE, AND THAT IS §9a's OWN INSTRUCTION. §9a's
 * recalibration procedure has always said "bucket them into frontlit, backlit
 * and deep-shade and set three bands, not one; at this elevation they are three
 * distributions and a single band spanning all of them gates nothing." Only one
 * band was ever implemented, and the consequence was measurable: five of eleven
 * vantages failed, and they were exactly the five that frame the most shadowed
 * road. The measured frames are bimodal — a mass at luma 0.10-0.20 and a second
 * at 0.60-0.70 which is the SKY — so a single `bright` row at luma 0.5 was, in
 * practice, a sky-area meter. `strata-wall` was being asked to put 28% of its
 * frame above a threshold that not one of the six rock strata bands it exists to
 * show can physically reach. See BANDS below and §9a for the derivation.
 *
 * The numbers are NOT restated in prose here. They live in `SHARED` and `BANDS`
 * below, each one labelled derived or guess, because the previous version of
 * this comment carried the night tier's mean/clip/std-dev long after the limits
 * had moved to the desert tier — and a docblock that contradicts the gate it
 * documents will eventually be "fixed" in the wrong direction.
 *
 * It walks every §11 vantage. Those that need subsystems which do not exist yet
 * are reported as PENDING, not silently skipped — a gate that quietly covers
 * nothing reads exactly like a gate that passed.
 */

import { ROOT, startServer } from './vite-server.mjs'
import { launch, openGame } from './lib/browser.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/*
 * Which sabotage `--broken` applies.
 *
 * One direction is not enough once there are three bands. The original
 * sabotage blows a quarter of the frame to white, which catches the bright
 * direction — but the rows this change RELAXES are the mean-luma floor and the
 * sunlit-area floor in the two enclosed bands, and a white quarter fails those
 * bands for a reason that has nothing to do with what was relaxed. A corridor
 * band that cannot fail is worse than a corridor band that fails wrongly, so
 * `--broken` with no mode now runs all three directions and demands that EVERY
 * band be seen failing in each of them. See SABOTAGES.
 */
const modeArg = process.argv.find((a) => a.startsWith('--broken='))
const selfTest = process.argv.includes('--broken') || Boolean(modeArg)
const requestedMode = modeArg ? modeArg.slice('--broken='.length) : null

/*
 * A port, because another agent's harness may already hold the default and
 * `startServer` refuses — correctly — to adopt a server it did not start.
 */
const portArg = process.argv.find((a) => a.startsWith('--port='))
const port = portArg ? Number(portArg.slice('--port='.length)) : undefined

/**
 * The luma at which a pixel counts as sun-struck.
 *
 * DERIVED, and it is the single number this whole revision turns on. It was
 * 0.5, chosen when §9a's palette table said sunlit vertical sandstone landed at
 * 0.86 and sunlit horizontal sand at 0.65 — so 0.5 read as "comfortably below
 * anything the sun touches". Both of those figures were wrong in the same two
 * ways: they were NEUTRAL-VALUE computations applied to a chromatic palette
 * whose green channel runs 4-9x under its red against Rec.709's 0.7152 green
 * weight, and they were NORMAL-INCIDENCE values applied to frames that are
 * mostly ground at sin(12°) = 0.208 grazing incidence.
 *
 * Recomputed per channel through the exact three.js ACES fit at exposure 0.88
 * (§9a carries the whole table), the §3a palette lands like this, sun-facing
 * vertical — the brightest state each surface can ever reach:
 *
 *   Sand sunlit  0.748   Rock caprock 0.490   Rock lower  0.297
 *   Kerb bone    0.822   Rock upper   0.407   Rock basal  0.215
 *   Gypsum seam  0.731   Rock mid     0.348   Road tarmac 0.197
 *
 * NOT ONE of the six mandated rock strata bands reaches 0.5. The old threshold
 * was unreachable by most of the palette, so `brightFraction` measured how much
 * SKY a vantage framed and nothing else.
 *
 * 0.30 is set on that recomputed table, at the sunlit/shadowed boundary of the
 * material that dominates the frame:
 *   - ABOVE the brightest shadowed surface in the palette — shadowed sand,
 *     0.27 (§9a; this is the value §3b used to misattribute to tarmac).
 *   - BELOW sunlit horizontal sand at ≈ 0.43, and below four of the six
 *     sun-facing strata bands, so a lit rock wall now reads as lit.
 * A pixel above 0.30 is one the sun reached; a pixel below it is one the sun
 * did not. That is the question the row was always asking.
 *
 * The area was NOT loosened to compensate. Each band's area floor is derived
 * from that band's own composition — see BANDS.
 */
const SUNLIT_LUMA = 0.3

/**
 * The rows that are IDENTICAL in every band, and stay identical.
 *
 * Every one of these is either derived or is the row a flat frame cannot pass,
 * and none of them depends on how much sky, wall or floor a vantage frames.
 * Bucketing by composition is not a licence to move them: a band that relaxed
 * `minStdDev` would be a band that cannot detect the one failure mode this
 * whole file exists for. `arch-interior` measures 0.152 against the 0.15 floor
 * and clears it on merit, after an arch roof was built to earn that margin —
 * moving the floor would retroactively hand it something it worked for.
 */
const SHARED = {
  minStdDev: 0.15, // guess on the value; DERIVED on the direction (must rise). DOES NOT MOVE.
  maxDark: 0.06, // DERIVED — deepest legitimate surface is luma 0.070
  maxHighlight: 0.02, // derived threshold, guessed area
  maxHighlightWorstCase: 0.06, // guess
  clipped: 0.0005, // DERIVED — clipping needs +5.4 stops over sunlit sand
  clippedWorstCase: 0.0025, // DERIVED — sun disc is 0.0029% of frame; ~85x that
}

/**
 * The three bands.
 *
 * §9a asks for frontlit / backlit / deep-shade. At THIS sun elevation, with §2's
 * key running down the canyon axis rather than across it, the camera's relation
 * to the sun is not what splits the distributions — enclosure is. `arch-exit`
 * looks straight into the 12° sun and is "backlit" in every photographic sense,
 * and its histogram sits with the open vantages; `strata-wall` is backlit by the
 * same definition and sits 0.13 of mean luma below it. Bucketing on the
 * photographic name would have put two entirely different distributions in one
 * band, which is the exact failure §9a's three-band instruction exists to
 * prevent. The buckets are therefore named for the geometry that produces them.
 * The count is three, as §9a requires, and deep-shade is `interior` unchanged.
 *
 * Composition weights below are stated so a reader can check the arithmetic
 * without running anything. They are estimates of frame area, and they are what
 * makes the mean and area floors derived rather than fitted to the measurement —
 * "the gate failed so I moved the gate" is the failure this file exists to
 * prevent, and the defence against it is that every floor here was computed from
 * a composition and a palette before it was compared to a frame.
 */
const BANDS = {
  /*
   * OPEN — the sun reaches broad ground in frame and there is open sky above it.
   *
   * Composition: sky 25%, sunlit sand 30%, road ribbon 28% (§3b, all of it below
   * 0.30: tarmac computes 0.085 horizontal, 0.197 sun-facing), shaded wall 15%,
   * kart 2%.
   *   mean  = .25(.65) + .30(.43) + .15(.15) + .28(.10) = 0.342
   *   above SUNLIT_LUMA = sky 25 + sunlit sand 30 = 55%
   */
  open: {
    meanLumaMin: 0.34, // DERIVED from the composition above
    meanLumaMax: 0.75, // guess, and the weakest number in this file — unchanged
    sunlitMin: 0.5, // DERIVED — sky 25% + sunlit sand 30%, less one road-width
    sunlitMax: 0.85, // guess — unchanged; at a LOWER threshold this is stricter, not looser
  },

  /*
   * CORRIDOR — a wall stands between the sun and the framed ground. At 12° a
   * 34 m wall throws 160 m across a 24 m corridor (§9c), so the floor is inside
   * that shadow for the whole of it and the lit content is the top of the far
   * wall plus a sky strip. This is not a dispensation; it is §1's own geometry.
   *
   * Composition: sky strip 10%, sunlit caprock/upper strata 15% (0.490/0.407),
   * shaded wall 30% (shaded rock face 0.17), shadowed floor + road 45%.
   *   mean  = .10(.65) + .15(.45) + .30(.10) + .45(.15) = 0.229
   *   above SUNLIT_LUMA = sky 10 + lit wall top 15 = 25%
   */
  corridor: {
    meanLumaMin: 0.22, // DERIVED from the composition above
    meanLumaMax: 0.55, // guess on the value; derived on the direction — a corridor
    // as bright as an open vantage is a corridor whose wall
    // shadow is not being cast
    sunlitMin: 0.25, // DERIVED — sky strip 10% + sunlit wall top 15%
    sunlitMax: 0.7, // guess on the value; derived on the direction (see meanLumaMax)
  },

  /*
   * INTERIOR — no direct sun on any framed surface except what §11 explicitly
   * grants. §2 makes the cliff bounce the dominant light in exactly these two
   * places and says so.
   *
   * Composition: sky strip 7% (§11 gives `slot-narrows` a 9° strip), sun shafts
   * 5% (§11 gives `arch-interior` three), bounce-lit wall 48%, shadowed floor 40%.
   *   mean  = .07(.65) + .05(.55) + .48(.18) + .40(.15) = 0.219
   *   above SUNLIT_LUMA = sky strip 7 + shafts 5 = 12%
   */
  interior: {
    meanLumaMin: 0.18, // DERIVED from the composition above
    meanLumaMax: 0.45, // DERIVED on the direction — §11 calls `arch-interior` the
    // darkest frame in the game; at 0.45 it would be as bright
    // as `arch-exit` measures, which cannot be right
    sunlitMin: 0.12, // DERIVED — the sky strip and the sun shafts §11 mandates, and
    // nothing else. This row IS the §11 requirement: lose the
    // strip or lose the shafts and it fires.
    sunlitMax: 0.55, // guess on the value; derived on the direction — an interior
    // with more sun-struck area than that is not occluding
  },

  /*
   * UNBUCKETED — `current-view`, and only `current-view`.
   *
   * It is not a §11 vantage and nothing states what it frames, so there is no
   * composition to derive a floor from and assigning it a band would be
   * inventing one. Its limits are the union of the three real bands: the widest
   * envelope that is still a rail. Every row in SHARED — the derived ones and
   * the std-dev floor — applies to it unchanged, so this is not a free pass; it
   * is an honest statement that the composition-dependent rows cannot say much
   * about a frame whose composition is undeclared.
   */
  unbucketed: {
    meanLumaMin: 0.18,
    meanLumaMax: 0.75,
    sunlitMin: 0.12,
    sunlitMax: 0.85,
  },
}

/**
 * Every §11 vantage, its band, and the §11 sentence the band is read off.
 *
 * THE BAND IS ASSIGNED FROM WHAT §11 SAYS THE VANTAGE IS, NOT FROM WHETHER IT
 * CURRENTLY PASSES. A reader should be able to check every one of these against
 * §11 without running anything, and two of the assignments below go against the
 * measurement on purpose: `arch-exit` is photographically backlit and is graded
 * against the brightest band, and `banked-wall` currently clears the open band's
 * floors but is a corridor by §11's description and is graded as one.
 */
const VANTAGES = [
  {
    name: 'grid',
    band: 'open',
    why: '§11 requires a "contact shadow on tarmac", which requires direct sun on the tarmac',
  },
  {
    name: 'dune-sweep',
    band: 'open',
    why: '§11 requires "4.70x raking shadows across the road" — the sun reaches the road — over open sand',
  },
  {
    name: 'strata-wall',
    band: 'corridor',
    why: '§11 requires "all six rock bands legible ... unsmeared on the overhang": a wall subject under an overhang, whose brightest band (caprock) tops out at 0.490',
  },
  {
    name: 'slot-narrows',
    band: 'interior',
    why: '§11 says "lit by cliff bounce alone ... 9° sky strip" — bounce-only by its own definition',
  },
  {
    name: 'mesa-crest',
    band: 'open',
    why: '§11 requires "longest sightline, aerial perspective, >= 5 depth layers" — nothing encloses it',
  },
  {
    name: 'banked-wall',
    band: 'corridor',
    why: '§11 grades "the 20° bank read ... kerb value contrast at 6.4:1" against a wall; the bank is the inside of a corridor, not open ground',
  },
  {
    name: 'wash-descent',
    band: 'open',
    why: '§11 says "dust plume against bright sand" — §11 itself calls the sand bright',
  },
  {
    name: 'arch-interior',
    band: 'interior',
    why: '§11 says "three sun shafts, bounce-only lighting, the darkest frame in the game"',
  },
  {
    name: 'arch-exit',
    band: 'open',
    why: '§11 says "bloom control firing into a 12° sun" — the disc is in frame. Backlit photographically, brightest state in the game, so it is graded against the brightest band and NOT relaxed',
  },
  {
    name: 'drift-tier3',
    band: 'corridor',
    why: '§11 sets the sparks "against warm rock and sand" — a rock-enclosed corner, and the §4 proof needs the reserved band to sit against unlit rock',
  },
]

/**
 * The two vantages that carry the relaxed worst-case CLIP and HIGHLIGHT limits —
 * the brightest reachable states in the game. Renaming either in VANTAGES
 * without updating this set silently stops the relaxation applying, which reads
 * as a stricter gate that mysteriously fails.
 *
 * This is orthogonal to the band. `arch-exit` is worst-case AND open;
 * `drift-tier3` is worst-case AND corridor. Folding one into the other would
 * hand `drift-tier3` the open band's floors, which its composition cannot meet.
 */
const WORST_CASE = new Set(['arch-exit', 'drift-tier3'])

/**
 * The sabotages, and what each one is for.
 *
 * `white` is the original and it stays exactly as it was: it catches the bright
 * direction, and CLAUDE.md names it. The two new ones exist because this change
 * relaxes floors in the dark direction, and a relaxed floor that has never been
 * watched firing is not a floor.
 *
 * All three write into the DEFAULT FRAMEBUFFER after present and before the
 * read, so they change the pixels the gate actually measures. That distinction
 * is the whole lesson from `smoke.mjs`: its first sabotage hid the canvas with
 * CSS, never touched the drawing buffer, and the detector was fine while the
 * test was inert.
 */
const SABOTAGES = {
  white: 'a quarter of the frame cleared to pure white — fires highlight, clip and flat-bright tiles',
  dim: 'every pixel halved in display space — fires the mean-luma and sun-struck floors, which is the direction the corridor and interior bands relax in',
  flat: 'every pixel pulled 80% of the way to one mid grey — mean preserved, std-dev cut to a fifth. THE daylight failure',
}

const OUT = path.join(ROOT, 'tools', 'out')
mkdirSync(OUT, { recursive: true })

const rows = []
const failures = []

const server = await startServer({ mode: 'preview', port })
const browser = await launch({ timing: false })

try {
  const { page } = await openGame(browser, server.url, {
    debug: 'frames',
    quality: 'high',
    seed: 20260807,
  })

  await page.evaluate(() => window.__harness.stepTicks(60))

  /**
   * Sample the presented frame: `frameLumaStats` plus the one statistic it
   * cannot carry.
   *
   * `FrameLumaStats.brightFraction` is fixed at luma 0.5 inside
   * `src/core/diagnostics.ts` and that threshold is wrong for this gate (see
   * SUNLIT_LUMA), so the sun-struck area is counted here instead — from the same
   * default framebuffer, with the same deterministic stride and the same
   * Rec. 709 weights as `readFrameLumaStats`, so the two are directly
   * comparable.
   *
   * "Comparable" is asserted, not assumed: the same pass also counts pixels at
   * >= 0.5 and that count must reproduce `brightFraction` to within rounding. A
   * second implementation of a measurement that silently disagrees with the
   * first is worse than having one, and the two most likely ways for this one to
   * drift — a different stride, or reading a framebuffer that is not the one
   * `readFrameLumaStats` read — both show up in that comparison immediately.
   *
   * @param {string|null} mode
   */
  async function sample(mode) {
    const result = await page.evaluate((sabotage) => {
      const canvas = document.querySelector('#app canvas')
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')

      if (sabotage === 'white') {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.enable(gl.SCISSOR_TEST)
        gl.scissor(0, 0, Math.floor(gl.drawingBufferWidth / 2), Math.floor(gl.drawingBufferHeight / 2))
        gl.clearColor(1, 1, 1, 1)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.disable(gl.SCISSOR_TEST)
      } else if (sabotage === 'dim' || sabotage === 'flat') {
        if (!gl.createVertexArray) {
          throw new Error(
            `the '${sabotage}' sabotage needs a WebGL2 vertex array object to leave three.js's ` +
              `attribute state untouched, and this context is WebGL1. Refusing rather than ` +
              `corrupting every frame after the first sample.`,
          )
        }
        // Blend a constant over the whole frame. `dim` multiplies the frame by
        // 0.5 (black at alpha 0.5); `flat` pulls it 80% of the way to a mid grey,
        // which preserves the mean and divides the std-dev by five.
        const [r, g, b, a] = sabotage === 'dim' ? [0, 0, 0, 0.5] : [0.3, 0.3, 0.3, 0.8]

        let kit = window.__energySabotage
        if (!kit) {
          const compile = (type, src) => {
            const s = gl.createShader(type)
            gl.shaderSource(s, src)
            gl.compileShader(s)
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s))
            return s
          }
          const program = gl.createProgram()
          gl.attachShader(program, compile(gl.VERTEX_SHADER, 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'))
          gl.attachShader(
            program,
            compile(gl.FRAGMENT_SHADER, 'precision highp float;uniform vec4 c;void main(){gl_FragColor=c;}'),
          )
          gl.linkProgram(program)
          if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program))

          // The quad lives in its own VAO. Without one, binding a buffer and
          // setting a vertex attrib pointer here desyncs three.js's cached
          // attribute state and every LATER frame renders wrong — which would
          // make the remaining vantages of a self-test fail for a reason that
          // has nothing to do with the sabotage under test.
          const vao = gl.createVertexArray()
          gl.bindVertexArray(vao)
          const buffer = gl.createBuffer()
          gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
          const loc = gl.getAttribLocation(program, 'p')
          gl.enableVertexAttribArray(loc)
          gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
          gl.bindVertexArray(null)
          gl.bindBuffer(gl.ARRAY_BUFFER, null)

          kit = { program, vao, colour: gl.getUniformLocation(program, 'c') }
          window.__energySabotage = kit
        }

        const prev = {
          fb: gl.getParameter(gl.FRAMEBUFFER_BINDING),
          vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
          program: gl.getParameter(gl.CURRENT_PROGRAM),
          blend: gl.isEnabled(gl.BLEND),
          srcRGB: gl.getParameter(gl.BLEND_SRC_RGB),
          dstRGB: gl.getParameter(gl.BLEND_DST_RGB),
          srcA: gl.getParameter(gl.BLEND_SRC_ALPHA),
          dstA: gl.getParameter(gl.BLEND_DST_ALPHA),
          depth: gl.isEnabled(gl.DEPTH_TEST),
          scissor: gl.isEnabled(gl.SCISSOR_TEST),
          viewport: gl.getParameter(gl.VIEWPORT),
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
        gl.disable(gl.DEPTH_TEST)
        gl.disable(gl.SCISSOR_TEST)
        gl.enable(gl.BLEND)
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
        gl.useProgram(kit.program)
        gl.uniform4f(kit.colour, r, g, b, a)
        gl.bindVertexArray(kit.vao)
        gl.drawArrays(gl.TRIANGLES, 0, 3)

        gl.bindVertexArray(prev.vao)
        gl.useProgram(prev.program)
        gl.blendFuncSeparate(prev.srcRGB, prev.dstRGB, prev.srcA, prev.dstA)
        if (!prev.blend) gl.disable(gl.BLEND)
        if (prev.depth) gl.enable(gl.DEPTH_TEST)
        if (prev.scissor) gl.enable(gl.SCISSOR_TEST)
        gl.viewport(prev.viewport[0], prev.viewport[1], prev.viewport[2], prev.viewport[3])
        gl.bindFramebuffer(gl.FRAMEBUFFER, prev.fb)
      }

      const luma = window.__harness.frameLumaStats()

      // Same framebuffer, same stride, same weights as readFrameLumaStats.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      const w = gl.drawingBufferWidth
      const h = gl.drawingBufferHeight
      const stride = Math.max(1, Math.floor(Math.min(w, h) / 512))
      const sw = Math.floor(w / stride)
      const sh = Math.floor(h / stride)
      const buf = new Uint8Array(w * h * 4)
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf)

      let sunlit = 0
      let atHalf = 0
      let n = 0
      for (let sy = 0; sy < sh; sy++) {
        const y = sy * stride
        for (let sx = 0; sx < sw; sx++) {
          const i = (y * w + sx * stride) * 4
          const l = (0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2]) / 255
          if (l >= 0.3) sunlit++
          if (l >= 0.5) atHalf++
          n++
        }
      }
      return { luma, sunlitFraction: sunlit / n, halfFraction: atHalf / n }
    }, mode)

    const drift = Math.abs(result.halfFraction - result.luma.brightFraction)
    if (drift > 0.002) {
      throw new Error(
        `the harness-side pixel read disagrees with frameLumaStats at the same threshold ` +
          `(${result.halfFraction.toFixed(4)} vs ${result.luma.brightFraction.toFixed(4)}). ` +
          `One of them is reading a different framebuffer or a different stride. Refusing to ` +
          `print a sun-struck area measured by an instrument that does not agree with itself.`,
      )
    }
    return { ...result.luma, sunlitFraction: result.sunlitFraction }
  }

  /**
   * Sample several frames and gate on the WORST.
   *
   * A single frame is not the scene. Measuring one tick put emissive area at
   * 2.2% while another tick of the same build measured 8.7% — one of those
   * passes the budget and one does not, and which one you get depends on where
   * the camera happened to be. Gating on a single sample means the verdict is
   * decided by timing.
   *
   * @param {string} label
   * @param {keyof BANDS} bandName
   * @param {number} clipLimit
   * @param {number} highlightLimit
   * @param {string|null} mode
   * @param {number} samples
   */
  async function measure(label, bandName, clipLimit, highlightLimit, mode, samples = 5) {
    const band = BANDS[bandName]
    const frames = [await sample(mode)]
    for (let i = 1; i < samples; i++) {
      await page.evaluate(() => window.__harness.stepTicks(37))
      frames.push(await sample(mode))
    }

    /*
     * EVERY sample is checked against EVERY limit, and the frame REPORTED is a
     * frame that actually failed.
     *
     * Two bugs live here, both already paid for. The first version kept only
     * the frame with the largest emissive area and graded that one, which
     * passed a build whose dimmest frame measured 0.042 mean luma — the frame
     * that failed was not the frame being looked at. "Worst frame" only works
     * if there is one axis to be worst on, and there are six.
     *
     * The fix that replaced it ranked frames by how far outside the band they
     * sat, but the ranking function did not include every limit, so the run
     * printed FAIL next to a frame with no problems listed under it. A verdict
     * you cannot trace to evidence is not much better than no verdict.
     */
    const graded = frames.map((f) => ({ luma: f, problems: evaluate(f, band, clipLimit, highlightLimit) }))
    const failing = graded.filter((g) => g.problems.length > 0)
    const shown = failing[0] ?? graded.reduce((a, b) => (b.luma.sunlitFraction > a.luma.sunlitFraction ? b : a))

    report(label, bandName, shown, frames.length, failing.length)
    return failing.length > 0
  }

  /**
   * Pure: the list of budget violations in one frame. No printing, no state.
   * @returns {string[]}
   */
  function evaluate(luma, band, clipLimit, highlightLimit) {
    const problems = []
    if (luma.mean > band.meanLumaMax) {
      problems.push(`mean luma ${luma.mean.toFixed(3)} > ${band.meanLumaMax} — the frame is washing out`)
    }
    if (luma.mean < band.meanLumaMin) {
      problems.push(`mean luma ${luma.mean.toFixed(3)} < ${band.meanLumaMin} — underexposed for this band`)
    }
    if (luma.darkFraction > SHARED.maxDark) {
      problems.push(
        `dark ${(luma.darkFraction * 100).toFixed(1)}% > ${(SHARED.maxDark * 100).toFixed(0)}% — ` +
          `a shadow term is clamping to zero, or geometry is unlit`,
      )
    }
    if (luma.sunlitFraction < band.sunlitMin || luma.sunlitFraction > band.sunlitMax) {
      problems.push(
        `sunlit ${(luma.sunlitFraction * 100).toFixed(1)}% outside ` +
          `${(band.sunlitMin * 100).toFixed(0)}-${(band.sunlitMax * 100).toFixed(0)}% ` +
          `(pixels >= luma ${SUNLIT_LUMA}) — this does not read as this band's lighting`,
      )
    }
    if (luma.highlightFraction > highlightLimit) {
      problems.push(
        `highlight ${(luma.highlightFraction * 100).toFixed(2)}% > ${(highlightLimit * 100).toFixed(2)}% — ` +
          `the frame is walking toward white`,
      )
    }
    if (luma.clippedFraction > clipLimit) {
      problems.push(`clipped ${(luma.clippedFraction * 100).toFixed(3)}% > ${(clipLimit * 100).toFixed(3)}%`)
    }
    if (luma.stdDev < SHARED.minStdDev) {
      problems.push(`std-dev ${luma.stdDev.toFixed(3)} < ${SHARED.minStdDev} — flat, which is the daylight failure`)
    }
    if (luma.unpaintedTiles > 0) {
      problems.push(`${luma.unpaintedTiles} unpainted tile(s) — part of the frame was never drawn`)
    }
    if (luma.flatBrightTiles > 1) {
      problems.push(
        `${luma.flatBrightTiles} flat-bright tile(s) — painted, but with nothing in them ` +
          `(blown sky, or a procedural albedo returning a constant)`,
      )
    }

    return problems
  }

  function report(label, bandName, shown, frameCount, failedFrames) {
    const { luma, problems } = shown

    rows.push({
      vantage: label,
      band: bandName,
      mean: luma.mean,
      stdDev: luma.stdDev,
      dark: luma.darkFraction,
      sunlit: luma.sunlitFraction,
      bright: luma.brightFraction,
      clipped: luma.clippedFraction,
      unpaintedTiles: luma.unpaintedTiles,
      framesSampled: frameCount,
      framesFailed: failedFrames,
      pass: failedFrames === 0,
    })

    const verdict = failedFrames === 0 ? 'PASS' : 'FAIL'
    console.log(
      `${verdict}  ${label.padEnd(14)} ${bandName.padEnd(10)} mean ${luma.mean.toFixed(3)}  sd ${luma.stdDev.toFixed(3)}  ` +
        `dark ${(luma.darkFraction * 100).toFixed(0)}%  sunlit ${(luma.sunlitFraction * 100).toFixed(1)}%  ` +
        `clip ${(luma.clippedFraction * 100).toFixed(2)}%  ` +
        `[${frameCount - failedFrames}/${frameCount} frames ok]` +
        (problems.length ? `\n      ${problems.join('\n      ')}` : ''),
    )
    if (failedFrames > 0) failures.push(`${label}: ${problems.join('; ')}`)
  }

  /**
   * One full walk of every vantage under one sabotage mode (or none).
   * @returns {Promise<{ pending: number, failedBands: Set<string> }>}
   */
  async function sweep(mode) {
    const failedBands = new Set()

    // Whatever the game currently presents, measured against the budget. This is
    // the row that exists before any vantage does, and the only unbucketed one.
    if (await measure('current-view', 'unbucketed', SHARED.clipped, SHARED.maxHighlight, mode)) {
      failedBands.add('unbucketed')
    }

    let pending = 0
    for (const { name, band } of VANTAGES) {
      const worst = WORST_CASE.has(name)
      const limit = worst ? SHARED.clippedWorstCase : SHARED.clipped
      const hl = worst ? SHARED.maxHighlightWorstCase : SHARED.maxHighlight
      try {
        await page.evaluate((v) => window.__harness.vantage(v), name)
        await page.evaluate(() => window.__harness.stepTicks(4))
        if (await measure(name, band, limit, hl, mode)) failedBands.add(band)
      } catch (err) {
        pending++
        console.log(`PEND  ${name.padEnd(14)} ${String(err.message ?? err).split('\n')[0].slice(0, 100)}`)
      }
    }
    return { pending, failedBands }
  }

  if (selfTest) {
    /*
     * A self-test that only proves "something failed somewhere" would pass with
     * two of the three bands inert. Each mode must be seen failing in EVERY band
     * that has a vantage in it, which is the property that was actually at risk
     * when the corridor and interior floors came down.
     */
    const modes = requestedMode ? [requestedMode] : Object.keys(SABOTAGES)
    /*
     * The three real bands, and not `unbucketed`. `unbucketed` is deliberately
     * the union of the other three, so demanding that every sabotage clear its
     * wider envelope would be demanding a stronger sabotage than the thing being
     * tested needs — and the honest description of `current-view` is that its
     * composition-dependent rows are weak, not that they are strong.
     */
    const expected = new Set(VANTAGES.map((v) => v.band))
    const missed = []

    for (const mode of modes) {
      if (!SABOTAGES[mode]) {
        console.error(`Unknown sabotage '${mode}'. Known: ${Object.keys(SABOTAGES).join(', ')}`)
        process.exitCode = 1
        break
      }
      console.log(`\n--- sabotage: ${mode} ---`)
      const { failedBands } = await sweep(mode)
      for (const band of expected) {
        if (!failedBands.has(band)) missed.push(`${mode} never failed the '${band}' band`)
      }
      console.log(`  ${mode}: fired in ${[...failedBands].sort().join(', ') || '(nothing)'}`)
    }

    console.log('')
    if (missed.length === 0 && process.exitCode !== 1) {
      console.log(`SELF-TEST PASSED — every sabotage fired in every band (${modes.join(', ')}).`)
    } else {
      for (const m of missed) console.error(`SELF-TEST FAILED — ${m}.`)
      process.exitCode = 1
    }
  } else {
    const { pending } = await sweep(null)

    console.log('')
    if (pending > 0) {
      console.log(
        `${pending}/${VANTAGES.length} vantages PENDING — world/ and game/ have not landed. ` +
          `They are reported, not skipped: a gate covering nothing must not read as a gate that passed.`,
      )
    }

    if (failures.length > 0) {
      console.error(`ENERGY BUDGET EXCEEDED (${failures.length})`)
      process.exitCode = 1
    } else {
      console.log('PASS — within the §9a frame-energy budget.')
    }
  }

  writeFileSync(
    path.join(OUT, 'energy-check.json'),
    JSON.stringify({ sunlitLuma: SUNLIT_LUMA, shared: SHARED, bands: BANDS, rows, failures }, null, 2),
  )
} finally {
  await browser.close()
  await server.stop()
}
