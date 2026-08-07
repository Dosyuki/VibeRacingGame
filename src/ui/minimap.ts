import { Vector3 } from 'three'

import type { GameServices, ITrack, TrackSample } from '../types'
import { LANE, INK, OUTLINE_SOLID } from './theme'
import { cssColor, fitCanvas } from './dom'

/**
 * §8 bottom-centre: "minimap tracing the TRUE circuit path, player a large dot,
 * rivals in livery colours".
 *
 * TRUE PATH, and the word is doing work. The cheap version of this widget is an
 * ellipse with dots running round it, and on a circuit whose §1 section table
 * contains a slot canyon, a banked 180° and a wash descent, an ellipse is a
 * picture of a different track. It tells the player nothing about what is
 * coming, which is the only reason a minimap exists. `ITrack.sample` hands out
 * the real centreline for the asking, so it is asked.
 *
 * The path is sampled ONCE, in `link`, into a flat Float32Array of projected
 * points, and rasterised once into an offscreen layer. A circuit is immutable
 * for the life of the world — `ITrack` exposes no mutator and `HarnessAPI.track`
 * is handed out by reference precisely because of that — so re-tracing 384
 * segments every frame would be 384 segments of identical output. The per-frame
 * cost is one `drawImage` and one arc per kart.
 */

/**
 * Centreline samples. 384 over 1620 m is a point every 4.2 m, which resolves
 * The Slot (92 m) and the arch (118 m) as recognisable shapes at a 100 px
 * widget. Doubling it changes nothing visible and doubles the `link` cost.
 */
const SAMPLES = 384

/** CSS px of margin inside the widget, so the path never touches the edge. */
const INSET = 7

export interface Minimap {
  readonly element: HTMLCanvasElement
  /** Sample the circuit and rasterise the static layer. Allocates; `link` only. */
  buildPath(track: ITrack): void
  /** One frame. Allocation-free. */
  draw(services: GameServices): void
  dispose(): void
}

export function createMinimap(element: HTMLCanvasElement): Minimap {
  const ctx2d = element.getContext('2d')

  /** Projected centreline, `[x0, y0, x1, y1, …]` in CSS pixels. */
  let path: Float32Array | null = null
  /** World-space bounds, retained so live kart positions use the same fit. */
  let originX = 0
  let originZ = 0
  let scale = 1
  let offsetX = 0
  let offsetY = 0

  /** Rasterised road, redrawn only when the widget's pixel size changes. */
  const staticLayer = document.createElement('canvas')
  let staticW = 0
  let staticH = 0

  /** Livery CSS strings, resolved once — `toString(16)` per kart per frame is 8
   *  strings a frame for a value that never changes. */
  let liveryCss: string[] = []
  let liveryBuiltFor = -1

  /** World-space extents of the circuit, from `buildPath`, consumed by `refit`. */
  let spanX = 1
  let spanZ = 1

  const sample: TrackSample = {
    position: new Vector3(),
    tangent: new Vector3(),
    normal: new Vector3(),
    right: new Vector3(),
    halfWidth: 0,
    bank: 0,
    curvature: 0,
  }

  /**
   * World XZ to widget pixels.
   *
   * North-up and fixed, not rotated to the kart's heading. A rotating minimap
   * has to spin the whole circuit every frame and, worse, it destroys the one
   * thing this widget is good at — letting a player recognise which of the eight
   * §1 sections they are about to enter from its SHAPE. A shape you have to
   * re-learn at every heading is not a shape.
   *
   * World +X is right and world -Z is forward at identity rotation (contract,
   * WORLD_FORWARD), so mapping +Z to screen-down puts "the way the grid faces"
   * at the top of the widget.
   */
  function projectX(worldX: number): number {
    return offsetX + (worldX - originX) * scale
  }
  function projectY(worldZ: number): number {
    return offsetY + (worldZ - originZ) * scale
  }

  function buildPath(track: ITrack): void {
    const points = new Float32Array(SAMPLES * 2)
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity

    for (let i = 0; i < SAMPLES; i++) {
      track.sample(i / SAMPLES, sample)
      const x = sample.position.x
      const z = sample.position.z
      points[i * 2] = x
      points[i * 2 + 1] = z
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
    }

    originX = (minX + maxX) * 0.5
    originZ = (minZ + maxZ) * 0.5
    // Store extents on the scale computation's behalf; the widget's pixel size
    // is not known until it has been laid out, so the fit is finished in
    // `refit`.
    spanX = Math.max(1e-3, maxX - minX)
    spanZ = Math.max(1e-3, maxZ - minZ)
    path = points
    staticW = 0 // force a re-rasterise
  }

  function refit(w: number, h: number): void {
    // One scale for both axes: an independent x/y fit would stretch the circuit
    // to fill a square widget, and a stretched map lies about corner radius,
    // which is the thing a driver reads off it.
    const usableW = w - INSET * 2
    const usableH = h - INSET * 2
    scale = Math.min(usableW / spanX, usableH / spanZ)
    offsetX = w * 0.5
    offsetY = h * 0.5
  }

  function rasteriseStatic(w: number, h: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    staticLayer.width = Math.max(1, Math.round(w * dpr))
    staticLayer.height = Math.max(1, Math.round(h * dpr))
    const g = staticLayer.getContext('2d')
    if (!g || !path) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, h)

    g.beginPath()
    g.moveTo(projectX(path[0]!), projectY(path[1]!))
    for (let i = 1; i < SAMPLES; i++) g.lineTo(projectX(path[i * 2]!), projectY(path[i * 2 + 1]!))
    g.closePath()

    g.lineJoin = 'round'
    g.lineCap = 'round'

    /*
     * Casing first, road second — the same §3a trick the type uses. A single
     * light stroke on sand at luma 0.65 has almost no contrast; a dark casing
     * underneath gives the road line an outline instead of a shadow, and it is
     * the reason the map is legible over the bright half of the frame.
     */
    g.strokeStyle = OUTLINE_SOLID
    g.globalAlpha = 0.85
    g.lineWidth = 7
    g.stroke()

    g.strokeStyle = LANE
    g.globalAlpha = 1
    g.lineWidth = 3.2
    g.stroke()

    // Start line. `ITrack.checkpoints[0] === 0` by contract, so t = 0 is it.
    const sx = projectX(path[0]!)
    const sy = projectY(path[1]!)
    g.strokeStyle = OUTLINE_SOLID
    g.lineWidth = 5.5
    g.beginPath()
    g.arc(sx, sy, 3.4, 0, Math.PI * 2)
    g.stroke()
    g.strokeStyle = INK
    g.lineWidth = 2.2
    g.stroke()

    staticW = w
    staticH = h
  }

  function draw(services: GameServices): void {
    if (!ctx2d || !path) return
    fitCanvas(element)
    const w = element.clientWidth
    const h = element.clientHeight
    if (w <= 0 || h <= 0) return

    if (w !== staticW || h !== staticH) {
      refit(w, h)
      rasteriseStatic(w, h)
    }

    ctx2d.clearRect(0, 0, w, h)
    ctx2d.drawImage(staticLayer, 0, 0, w, h)

    const identities = services.identities
    if (liveryBuiltFor !== identities.length) {
      liveryCss = identities.map((id) => cssColor(id.primaryColor))
      liveryBuiltFor = identities.length
    }

    const karts = services.karts
    const playerId = services.playerKartId

    /*
     * Rivals first, player last. Eight karts on a 100 px widget overlap
     * constantly on the grid and through the first corner, and z-order decides
     * whose dot is visible. The one dot the player must never lose is their own.
     */
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < karts.length; i++) {
        const kart = karts[i]!
        const isPlayer = kart.identity.id === playerId
        if (isPlayer !== (pass === 1)) continue

        const p = kart.state.position
        const x = projectX(p.x)
        const y = projectY(p.z)
        const radius = isPlayer ? 5.4 : 3.4

        ctx2d.beginPath()
        ctx2d.arc(x, y, radius + 1.6, 0, Math.PI * 2)
        ctx2d.fillStyle = OUTLINE_SOLID
        ctx2d.fill()

        ctx2d.beginPath()
        ctx2d.arc(x, y, radius, 0, Math.PI * 2)
        /*
         * The player is INK, not a reserved-band colour. §4b reserves hue
         * 155°–320° for gameplay feedback and a position marker is navigation,
         * not feedback; putting the player dot in drift-tier green would put a
         * permanent tier-1 signal on screen. Size and a white core separate it
         * from eight livery colours perfectly well — the liveries are drawn from
         * the environment bands (§5d) and none of them is near white.
         */
        ctx2d.fillStyle = isPlayer ? INK : (liveryCss[i] ?? LANE)
        ctx2d.fill()
      }
    }
  }

  function dispose(): void {
    path = null
    liveryCss = []
    liveryBuiltFor = -1
    // Drop the backing stores. A 2x-DPR pair of canvases is a few hundred KB
    // each and the harness builds and tears down the world repeatedly.
    staticLayer.width = 0
    staticLayer.height = 0
    element.width = 0
    element.height = 0
  }

  return { element, buildPath, draw, dispose }
}
