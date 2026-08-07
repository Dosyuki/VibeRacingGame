/**
 * THE GROUND, MEASURED. Is the world you can drive through watertight?
 *
 *   node tools/seam-check.mjs            # against the production build
 *   node tools/seam-check.mjs --dev      # against the dev server
 *   node tools/seam-check.mjs --broken   # self-test: prove every detector fires
 *
 * WHY THIS EXISTS, AND WHY smoke.mjs COULD NEVER HAVE CAUGHT IT
 * -------------------------------------------------------------
 * A player reported "parts of the ground do not meet properly and you can see a
 * hole straight through the map". Every instrument in this repo was green at the
 * time. They were all green *correctly*: smoke.mjs asks whether the GPU painted
 * every tile, and a hole in the ground is painted — with whatever is behind it.
 * track-check.mjs grades `ITrack`, which is a curve and has no surfaces on it at
 * all. fps-bench counts triangles without asking where they are. A seam between
 * two meshes written by two people who never read each other's code is invisible
 * to all three, and it is exactly the failure that shipped.
 *
 * `road.ts` and `terrain.ts` both draw the region immediately beside the road.
 * That region has to be ONE surface with two authors, and the only way to keep
 * two authors honest about a shared edge is to measure the edge.
 *
 * WHAT IT ASSERTS
 * ---------------
 *   coverage       Rays cast straight DOWN from above the road and from the
 *                  shoulder must hit SOLID GROUND — the road, the apron or the
 *                  canyon wall — inside a plausible band around the road plane.
 *                  The 2400 m sand plane and the sky dome are deliberately NOT
 *                  solid ground: a ray that finds only those has fallen through
 *                  the world, which is what "a hole straight through the map"
 *                  is. This is the hole detector.
 *   seam           At every station, on both sides, the apron must reach the
 *                  road edge and pass UNDER it — present, strictly below, and
 *                  not so far below that the road's cut edge is a visible cliff.
 *   inner-edge     The apron's inner edge, measured from the geometry, must sit
 *                  a fixed tuck inboard of `track.sample(t).halfWidth` at every
 *                  station. This is the check that survives another agent
 *                  widening the track: if either file hard-codes a width, the
 *                  measured inner edge stops tracking `halfWidth` and this fires.
 *   apron-toe      The apron's outer edge and the wall's talus toe must meet.
 *                  They can be flush in plan and still leave an open vertical
 *                  step you can see through from a low camera; this measures the
 *                  step, not the plan.
 *   chunk-closure  The apron is emitted in six arc chunks and the lap wraps.
 *                  Where two chunks cover the same ground they must agree to a
 *                  millimetre. This is what catches a profile field keyed on
 *                  arc length instead of `t`, which does not close at the start
 *                  line and leaves a step in the ground there.
 *   zfight         No two DIFFERENT ground surfaces may sit within 2 cm of each
 *                  other over the same ground. Two authors drawing the same
 *                  shoulder is not a cosmetic problem; it is a stripe of noise
 *                  that changes with view angle and cannot be art-directed.
 *   scatter        No scatter instance's BOUNDING SPHERE may intrude inside
 *                  `halfWidth + BARRIER_MARGIN`. Bounding sphere, not origin:
 *                  a 3 m boulder whose centre is legally 2 m off the road still
 *                  has a metre of itself on the racing surface, and an origin
 *                  test reports zero intrusions while the screenshot shows rocks
 *                  on the track.
 *
 * HOW IT REACHES THE GEOMETRY
 * ---------------------------
 * `HarnessAPI` exposes `track`, and `track.group` is parented into the scene, so
 * `__harness.track.group.parent` is the scene. That is the whole reach, and it
 * is used read-only. It is also a load-bearing accident rather than a contract —
 * see the PENDING notes at the bottom of the run for the one line this file
 * would rather have. Nothing is added to the contract here.
 *
 * RAYS, WITHOUT THREE
 * -------------------
 * The page does not expose `THREE`, so `Raycaster` is not reachable. Downward
 * rays are done by hand: every solid triangle is transformed to world space
 * once, indexed into a uniform XZ grid, and a "ray" is a point-in-triangle test
 * in the XZ plane with the height read off by barycentric interpolation. That is
 * strictly better than `Raycaster` here, because it also hands back the
 * triangle's GEOMETRIC winding — so "the surface is there but its front face
 * points at the ground and the GPU culls it" is a distinguishable answer rather
 * than a mystery.
 *
 * SELF-TEST. `--broken` sabotages the REAL scene — it moves, deletes and
 * duplicates actual vertices of the shipped meshes — runs the whole battery
 * against the damage, and asserts the OWNING check went red. A sabotage caught
 * by some other detector is recorded as a miss, because "something went red" is
 * not the same evidence as "the detector for this failure fired". Every
 * sabotage is undone and the battery re-run clean, so a self-test that leaves
 * the scene broken cannot masquerade as a pass.
 */

import path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { ROOT, startServer } from './vite-server.mjs'
import { launch, openGame } from './lib/browser.mjs'

const args = process.argv.slice(2)
const useDev = args.includes('--dev')
const selfTest = args.includes('--broken')
const stationsArg = Number(args.find((a) => a.startsWith('--stations='))?.split('=')[1] ?? 0)

const OUT = path.join(ROOT, 'tools', 'out')
mkdirSync(OUT, { recursive: true })

// ---------------------------------------------------------------------------
// Tolerances. Every one of these is a metre and every one has a reason.
// ---------------------------------------------------------------------------

const TOL = {
  /** Longitudinal probe count. Prime, so probes land BETWEEN terrain stations
   *  rather than on them — a sweep that only ever samples the station ring
   *  cannot see a chord that cuts a corner between two rings. */
  stations: 511,
  /** Lateral step of the sweep beside the road, metres. */
  lateralStep: 0.1,
  /** How far past the road edge the sweep runs. Past the talus toe everywhere. */
  lateralReach: 26,

  /** On the road, the only legal ground is the road, at the road plane. */
  onRoadBand: [-0.06, 0.06],
  /** Inside BARRIER_MARGIN the ground must stay drivable: a shallow verge. */
  shoulderBand: [-0.95, 0.4],
  /**
   * Beyond the margin the band is wide on purpose, and the width is not
   * laxness. The canyon walls stand on world up from the CENTRELINE height
   * while the road banks 20°, so on the high side of The Wall the ground
   * legitimately descends several metres between the road edge and the scree
   * toe; a tight band here fails correct geometry. The hole detector does not
   * depend on the band anyway — its power comes from the far sand plane and
   * the sky being excluded from "solid ground", so a ray over a hole finds
   * NOTHING and is caught whatever the band says.
   */
  outerBand: [-10, 60],

  /** Apron below the road edge: present, under it, not a cliff. */
  seamTuckDrop: [0.005, 0.30],
  /** Where the apron's measured inner edge sits inboard of `halfWidth`. */
  innerTuck: [0.12, 1.6],

  /** Vertical step permitted where the apron hands over to the talus toe. */
  apronToeStep: 0.22,
  /** Plan gap permitted between the last apron sample and the first wall one. */
  apronToeGap: 0.45,

  /** Two apron chunks over the same ground are the same surface or a bug. */
  chunkClosure: 0.002,
  /** Vertical step permitted between ground samples 10 cm apart along the arc.
   *  A real slope moves ~1 mm over 10 cm; anything at this scale is a cliff. */
  closureStep: 0.05,
  /** Two DIFFERENT ground surfaces closer than this z-fight. */
  zfight: 0.02,

  /** Scatter clearance slack, metres, on top of halfWidth + BARRIER_MARGIN. */
  scatterSlack: 0.0,
}

/** Kept in step with `src/types.ts`. Asserted against the live value below. */
const BARRIER_MARGIN = 1.5

// ---------------------------------------------------------------------------
// The battery. Runs entirely in the page; must not close over module scope.
// ---------------------------------------------------------------------------

/* eslint-disable */
function battery(opts) {
  const TOL = opts.tol
  const BARRIER_MARGIN = opts.barrierMargin

  const harness = window.__harness
  if (!harness) return { blocked: 'NO_HARNESS' }
  let track
  try {
    track = harness.track
  } catch (err) {
    return { blocked: 'TRACK_PENDING', message: String((err && err.message) || err) }
  }
  if (!track || typeof track.sample !== 'function') return { blocked: 'NO_TRACK_ON_HARNESS' }
  const scene = track.group && track.group.parent
  if (!scene) return { blocked: 'NO_SCENE_VIA_TRACK_GROUP' }

  const V3 = track.group.position.constructor
  const M4 = track.group.matrix.constructor
  const newSample = () => ({
    position: new V3(), tangent: new V3(), normal: new V3(), right: new V3(),
    halfWidth: 0, bank: 0, curvature: 0,
  })
  const newLocation = () => ({ t: 0, lateral: 0, height: 0, onTrack: false, checkpointIndex: 0 })

  // -------------------------------------------------------------------------
  // Classification. Names are the contract between these two files and this
  // one; an unnamed mesh is scenery (sky dome, the 2400 m sand plane) and is
  // deliberately NOT solid ground.
  // -------------------------------------------------------------------------
  const groupOf = (name) => {
    if (name === 'road') return 'road'
    if (name === 'road-shoulder') return 'road-shoulder'
    if (name.indexOf('canyon-apron-') === 0) return 'apron'
    if (name.indexOf('canyon-wall-') === 0) return 'wall'
    return null
  }

  const solid = []
  const scatterMeshes = []
  const background = []
  scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return
    o.updateWorldMatrix(true, false)
    const name = o.name || ''
    if (o.isInstancedMesh) {
      // Scatter is what `terrain.ts` instances. Kerbs, boost pads and the cattle
      // grid are road furniture that BELONGS on the road and is excluded on
      // purpose — testing them against BARRIER_MARGIN would be a false alarm by
      // construction.
      if (name.indexOf('canyon-') === 0) scatterMeshes.push(o)
      return
    }
    const g = groupOf(name)
    if (g) solid.push({ mesh: o, group: g })
    else background.push(name || o.type)
  })

  if (!solid.some((s) => s.group === 'road')) return { blocked: 'NO_ROAD_MESH' }
  const hasApron = solid.some((s) => s.group === 'apron')

  // -------------------------------------------------------------------------
  // World-space triangle soup + uniform XZ grid.
  // -------------------------------------------------------------------------
  const TA = []; const TB = []; const TC = []; const TG = []; const TM = []; const TD = []
  for (const { mesh, group } of solid) {
    const geo = mesh.geometry
    const pos = geo.attributes.position
    const idx = geo.index
    const e = mesh.matrixWorld.elements
    const dbl = mesh.material && mesh.material.side === 2
    const n = idx ? idx.count : pos.count
    const wx = (i) => e[0] * pos.getX(i) + e[4] * pos.getY(i) + e[8] * pos.getZ(i) + e[12]
    const wy = (i) => e[1] * pos.getX(i) + e[5] * pos.getY(i) + e[9] * pos.getZ(i) + e[13]
    const wz = (i) => e[2] * pos.getX(i) + e[6] * pos.getY(i) + e[10] * pos.getZ(i) + e[14]
    for (let i = 0; i < n; i += 3) {
      const i0 = idx ? idx.getX(i) : i
      const i1 = idx ? idx.getX(i + 1) : i + 1
      const i2 = idx ? idx.getX(i + 2) : i + 2
      TA.push(wx(i0), wy(i0), wz(i0))
      TB.push(wx(i1), wy(i1), wz(i1))
      TC.push(wx(i2), wy(i2), wz(i2))
      TG.push(group)
      TM.push(mesh.name)
      TD.push(dbl)
    }
  }
  const triCount = TG.length

  const CELL = 3
  const grid = new Map()
  const oversize = []
  const key = (i, j) => i * 1000003 + j
  for (let t = 0; t < triCount; t++) {
    const k = t * 3
    const x0 = Math.min(TA[k], TB[k], TC[k]); const x1 = Math.max(TA[k], TB[k], TC[k])
    const z0 = Math.min(TA[k + 2], TB[k + 2], TC[k + 2]); const z1 = Math.max(TA[k + 2], TB[k + 2], TC[k + 2])
    const ci0 = Math.floor(x0 / CELL); const ci1 = Math.floor(x1 / CELL)
    const cj0 = Math.floor(z0 / CELL); const cj1 = Math.floor(z1 / CELL)
    if ((ci1 - ci0 + 1) * (cj1 - cj0 + 1) > 64) { oversize.push(t); continue }
    for (let i = ci0; i <= ci1; i++) for (let j = cj0; j <= cj1; j++) {
      const kk = key(i, j)
      let a = grid.get(kk)
      if (!a) grid.set(kk, (a = []))
      a.push(t)
    }
  }

  /** All solid surfaces directly under (x, z), highest first. */
  function hitsAt(x, z) {
    const cell = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)))
    const out = []
    const test = (t) => {
      const k = t * 3
      const ax = TA[k], ay = TA[k + 1], az = TA[k + 2]
      const bx = TB[k], by = TB[k + 1], bz = TB[k + 2]
      const cx = TC[k], cy = TC[k + 1], cz = TC[k + 2]
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
      if (d > -1e-12 && d < 1e-12) return
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d
      const l3 = 1 - l1 - l2
      if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) return
      // y component of (B-A) x (C-A): > 0 means the front face points up.
      const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az)
      out.push({ y: l1 * ay + l2 * by + l3 * cy, up: ny > 0 || TD[t], group: TG[t], mesh: TM[t] })
    }
    if (cell) for (let i = 0; i < cell.length; i++) test(cell[i])
    for (let i = 0; i < oversize.length; i++) test(oversize[i])
    out.sort((p, q) => q.y - p.y)
    return out
  }

  // -------------------------------------------------------------------------
  // Findings
  // -------------------------------------------------------------------------
  const checks = {
    coverage: { id: 'coverage', fails: [], n: 0, worst: null },
    seam: { id: 'seam', fails: [], n: 0, worst: null },
    'inner-edge': { id: 'inner-edge', fails: [], n: 0, worst: null },
    'apron-toe': { id: 'apron-toe', fails: [], n: 0, worst: null },
    'chunk-closure': { id: 'chunk-closure', fails: [], n: 0, worst: null },
    zfight: { id: 'zfight', fails: [], n: 0, worst: null },
    scatter: { id: 'scatter', fails: [], n: 0, worst: null },
  }
  const note = (id, msg, magnitude) => {
    const c = checks[id]
    if (c.fails.length < 12) c.fails.push(msg)
    c.n++
    if (c.worst === null || magnitude > c.worst) c.worst = magnitude
  }

  // -------------------------------------------------------------------------
  // The march
  // -------------------------------------------------------------------------
  const s = newSample()
  const N = TOL.stations
  const p = new V3()
  let hwMin = Infinity, hwMax = -Infinity
  let seamDropMin = Infinity, seamDropMax = -Infinity
  let innerTuckMin = Infinity, innerTuckMax = -Infinity

  for (let i = 0; i < N; i++) {
    const t = i / N
    track.sample(t, s)
    const hw = s.halfWidth
    if (hw < hwMin) hwMin = hw
    if (hw > hwMax) hwMax = hw
    const roadY = s.position.y

    // --- on the road ------------------------------------------------------
    for (const frac of [-0.99, -0.7, -0.35, 0, 0.35, 0.7, 0.99]) {
      const lat = frac * hw
      const x = s.position.x + s.right.x * lat
      const z = s.position.z + s.right.z * lat
      const y0 = roadY + s.right.y * lat
      const hits = hitsAt(x, z)
      const ok = hits.some((h) => h.up && h.y - y0 >= TOL.onRoadBand[0] && h.y - y0 <= TOL.onRoadBand[1])
      if (!ok) {
        note('coverage',
          `t=${t.toFixed(4)} lat=${lat.toFixed(2)} (on road): no upward-facing ground within ` +
          `[${TOL.onRoadBand[0]}, ${TOL.onRoadBand[1]}] m of the road plane. hits=` +
          JSON.stringify(hits.slice(0, 4).map((h) => `${h.mesh}@${(h.y - y0).toFixed(2)}${h.up ? '^' : 'v(BACKFACE)'}`)),
          1)
      }
    }

    // --- the lateral sweep, both sides ------------------------------------
    for (let side = -1; side <= 1; side += 2) {
      let innerEdge = null       // smallest offset at which the apron exists
      // The lateral profile, kept so the apron/talus handover can be resolved
      // after the sweep instead of guessed during it. `wallYs` is EVERY wall
      // surface at that offset, not the topmost: through The Slot the wall
      // leans in over the road, so the highest wall hit beside the road is a
      // cliff 25 m up and the talus toe is the LOW one. A first version of this
      // check took the topmost and reported a 25 m step at every station of the
      // Slot, which is the detector being wrong, not the geometry.
      const sweepOff = []
      const sweepApron = []
      const sweepWallYs = []
      const start = hw - 2.0

      for (let off = start; off <= hw + TOL.lateralReach; off += TOL.lateralStep) {
        const lat = side * off
        const x = s.position.x + s.right.x * lat
        const z = s.position.z + s.right.z * lat
        // The road plane at this lateral offset, so a banked section is judged
        // against the road it actually has rather than against the centreline.
        const planeY = roadY + s.right.y * (Math.min(off, hw) * side)
        const hits = hitsAt(x, z)

        const byGroup = {}
        for (const h of hits) if (!byGroup[h.group] || h.y > byGroup[h.group].y) byGroup[h.group] = h

        // ---- z-fight: two different ground surfaces on top of each other ---
        const gs = Object.keys(byGroup)
        for (let a = 0; a < gs.length; a++) for (let b = a + 1; b < gs.length; b++) {
          const dy = Math.abs(byGroup[gs[a]].y - byGroup[gs[b]].y)
          if (dy < TOL.zfight) {
            note('zfight',
              `t=${t.toFixed(4)} off=${(side * off).toFixed(2)}: '${gs[a]}' and '${gs[b]}' are ` +
              `${(dy * 1000).toFixed(1)} mm apart (${byGroup[gs[a]].mesh} / ${byGroup[gs[b]].mesh})`,
              TOL.zfight - dy)
          }
        }

        // ---- chunk closure: two apron chunks over the same ground ----------
        const aprons = hits.filter((h) => h.group === 'apron')
        for (let a = 0; a < aprons.length; a++) for (let b = a + 1; b < aprons.length; b++) {
          if (aprons[a].mesh === aprons[b].mesh) continue
          const dy = Math.abs(aprons[a].y - aprons[b].y)
          if (dy > TOL.chunkClosure) {
            note('chunk-closure',
              `t=${t.toFixed(4)} off=${(side * off).toFixed(2)}: ${aprons[a].mesh} and ${aprons[b].mesh} ` +
              `disagree by ${(dy * 1000).toFixed(0)} mm over the same ground — the apron does not close`,
              dy)
          }
        }

        if (byGroup.apron && innerEdge === null) innerEdge = off
        sweepOff.push(off)
        sweepApron.push(byGroup.apron ? byGroup.apron.y : null)
        sweepWallYs.push(hits.filter((h) => h.group === 'wall').map((h) => h.y))

        // ---- coverage ------------------------------------------------------
        if (off < hw - 0.05) continue // handled by the on-road probes
        const band = off <= hw + BARRIER_MARGIN ? TOL.shoulderBand : TOL.outerBand
        const ok = hits.some((h) => h.up && h.y - planeY >= band[0] && h.y - planeY <= band[1])
        if (!ok) {
          note('coverage',
            `t=${t.toFixed(4)} off=${(side * off).toFixed(2)} (hw=${hw.toFixed(2)}): no upward-facing ` +
            `ground within [${band[0]}, ${band[1]}] m of the road plane — the ray falls through. hits=` +
            JSON.stringify(hits.slice(0, 4).map((h) => `${h.mesh}@${(h.y - planeY).toFixed(2)}${h.up ? '^' : 'v(BACKFACE)'}`)),
            1)
        }
      }

      // ---- seam: the apron under the road edge ---------------------------
      if (hasApron) {
        const lat = side * (hw - 0.03)
        const x = s.position.x + s.right.x * lat
        const z = s.position.z + s.right.z * lat
        const hits = hitsAt(x, z)
        const road = hits.find((h) => h.group === 'road')
        const apron = hits.find((h) => h.group === 'apron')
        if (!road) {
          note('seam', `t=${t.toFixed(4)} side=${side}: no ROAD surface at the road edge`, 1)
        } else if (!apron) {
          note('seam',
            `t=${t.toFixed(4)} side=${side}: the apron does not reach under the road edge ` +
            `(hw=${hw.toFixed(2)}) — that is a gap between the two authors' surfaces`, 1)
        } else {
          const drop = road.y - apron.y
          if (drop < seamDropMin) seamDropMin = drop
          if (drop > seamDropMax) seamDropMax = drop
          if (drop < TOL.seamTuckDrop[0]) {
            note('seam',
              `t=${t.toFixed(4)} side=${side}: apron is ${(-drop * 1000).toFixed(0)} mm ABOVE / level with ` +
              `the road edge — it pokes through the road and z-fights it`, TOL.seamTuckDrop[0] - drop)
          } else if (drop > TOL.seamTuckDrop[1]) {
            note('seam',
              `t=${t.toFixed(4)} side=${side}: apron is ${drop.toFixed(3)} m below the road edge — ` +
              `the road's cut edge is an open cliff`, drop - TOL.seamTuckDrop[1])
          }
        }

        // ---- inner-edge: derived from halfWidth, or hard-coded? -----------
        if (innerEdge === null) {
          note('inner-edge', `t=${t.toFixed(4)} side=${side}: no apron found anywhere in the sweep`, 1)
        } else {
          const tuck = hw - innerEdge
          if (tuck < innerTuckMin) innerTuckMin = tuck
          if (tuck > innerTuckMax) innerTuckMax = tuck
          if (tuck < TOL.innerTuck[0] || tuck > TOL.innerTuck[1]) {
            note('inner-edge',
              `t=${t.toFixed(4)} side=${side}: apron inner edge is ${tuck.toFixed(2)} m inboard of ` +
              `halfWidth=${hw.toFixed(2)}; expected [${TOL.innerTuck[0]}, ${TOL.innerTuck[1]}]. Either the ` +
              `apron is not derived from track.sample().halfWidth, or the tuck has drifted`,
              Math.max(TOL.innerTuck[0] - tuck, tuck - TOL.innerTuck[1]))
          }
        }

        // ---- apron-toe: does the apron actually meet the talus? ----------
        //
        // The invariant is that the apron's OUTER edge and the talus toe are
        // the same ground. Find where the apron stops, then look just outboard
        // of it for the wall surface CLOSEST in height to the apron's last
        // sample. If the talus is where it should be that is a few millimetres
        // away; if the apron stops short, the nearest wall surface is the cliff
        // metres above and this fires.
        let lastIdx = -1
        for (let q = sweepApron.length - 1; q >= 0; q--) {
          if (sweepApron[q] !== null) { lastIdx = q; break }
        }
        if (lastIdx >= 0) {
          const endY = sweepApron[lastIdx]
          let found = null
          const maxAhead = Math.ceil(TOL.apronToeGap / TOL.lateralStep)
          for (let d = 1; d <= maxAhead && lastIdx + d < sweepWallYs.length; d++) {
            const ys = sweepWallYs[lastIdx + d]
            for (const y of ys) {
              const dy = Math.abs(y - endY)
              if (found === null || dy < found.dy) found = { dy, off: sweepOff[lastIdx + d], y }
            }
            if (found) break
          }
          if (found === null) {
            // Sections where the wall has collapsed to open sand legitimately
            // have no talus within reach of the apron. Not a failure.
          } else if (found.dy > TOL.apronToeStep) {
            note('apron-toe',
              `t=${t.toFixed(4)} side=${side}: the apron ends at off ${sweepOff[lastIdx].toFixed(2)} and the ` +
              `nearest wall surface outboard of it is ${found.dy.toFixed(2)} m ` +
              `${found.y > endY ? 'above' : 'below'} it, with nothing bridging the step — an open vertical ` +
              `slot the length of the lap`, found.dy - TOL.apronToeStep)
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Start-line closure.
  //
  // The lap wraps and the apron is emitted in arc chunks, so the last chunk's
  // final cross-section and the first chunk's opening one describe the SAME
  // ground and must be the same numbers. A profile field sampled on arc length
  // — `noise(arc * k)` — is not periodic over the lap: arc = 0 and arc = length
  // are different points in the field, the two rings come out at different
  // heights, and there is no geometry between them. That is a step in the
  // ground at the start line with nothing bridging it, and it is invisible in
  // any screenshot not taken standing on it.
  //
  // Measured as a fine arc scan straight through t = 0. Real ground moves about
  // a millimetre over 10 cm; a wrap discontinuity moves tens of centimetres.
  // -------------------------------------------------------------------------
  {
    const s2 = newSample()
    track.sample(0, s2)
    const hw0 = s2.halfWidth
    const dt = 0.1 / track.length
    for (let side = -1; side <= 1; side += 2) {
      for (const off of [hw0 * 0.5, hw0 - 0.1, hw0 + 0.3, hw0 + 0.8, hw0 + 1.6, hw0 + 3, hw0 + 5]) {
        let prev = null
        for (let k = -15; k <= 15; k++) {
          const tt = ((k * dt) % 1 + 1) % 1
          track.sample(tt, s2)
          const lat = side * off
          const x = s2.position.x + s2.right.x * lat
          const z = s2.position.z + s2.right.z * lat
          const planeY = s2.position.y + s2.right.y * (Math.min(off, s2.halfWidth) * side)
          const hits = hitsAt(x, z)
          const band = off <= s2.halfWidth ? TOL.onRoadBand : off <= s2.halfWidth + BARRIER_MARGIN ? TOL.shoulderBand : TOL.outerBand
          const h = hits.find((q) => q.up && q.y - planeY >= band[0] && q.y - planeY <= band[1])
          const rel = h ? h.y - planeY : null
          if (prev !== null && rel !== null) {
            const step = Math.abs(rel - prev)
            if (step > TOL.closureStep) {
              note('chunk-closure',
                `across the start line at off=${(side * off).toFixed(2)}: the ground steps ` +
                `${(step * 1000).toFixed(0)} mm over 10 cm of arc (${prev.toFixed(3)} → ${rel.toFixed(3)} m ` +
                `below the road plane). The lap does not close — a profile field keyed on arc length ` +
                `instead of t does exactly this`,
                step)
            }
          }
          prev = rel
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Scatter: BOUNDING SPHERE, not origin.
  // -------------------------------------------------------------------------
  const loc = newLocation()
  const m = new M4()
  let scatterInstances = 0
  let worstClearance = Infinity
  let radiusless = 0
  for (const mesh of scatterMeshes) {
    const geo = mesh.geometry
    if (!geo.boundingSphere) geo.computeBoundingSphere()
    const r0 = geo.boundingSphere ? geo.boundingSphere.radius : 0
    if (!(r0 > 0)) { radiusless++; continue }
    const e0 = mesh.matrixWorld.elements
    const meshScale = Math.max(
      Math.hypot(e0[0], e0[1], e0[2]), Math.hypot(e0[4], e0[5], e0[6]), Math.hypot(e0[8], e0[9], e0[10]),
    )
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m)
      const e = m.elements
      // Largest singular-value bound: the longest column is the worst-case
      // stretch a unit sphere can take. Conservative on purpose.
      const sc = Math.max(
        Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10]),
      )
      const radius = r0 * sc * meshScale
      p.set(e[12], e[13], e[14])
      p.applyMatrix4(mesh.matrixWorld)
      track.locate(p, loc)
      track.sample(loc.t, s)
      const limit = s.halfWidth + BARRIER_MARGIN + TOL.scatterSlack
      const clearance = Math.abs(loc.lateral) - radius - limit
      scatterInstances++
      if (clearance < worstClearance) worstClearance = clearance
      if (clearance < 0) {
        note('scatter',
          `${mesh.name}[${i}] centre at lateral ${loc.lateral.toFixed(2)} m, radius ${radius.toFixed(2)} m ` +
          `— its bounding sphere reaches ${(-clearance).toFixed(2)} m inside halfWidth+BARRIER_MARGIN ` +
          `(${limit.toFixed(2)} m) at t=${loc.t.toFixed(4)}`,
          -clearance)
      }
    }
  }

  return {
    ok: true,
    triCount,
    meshes: solid.map((x) => x.mesh.name),
    background,
    hasApron,
    hasRoadShoulder: solid.some((x) => x.group === 'road-shoulder'),
    scatterMeshes: scatterMeshes.map((x) => `${x.name}x${x.count}`),
    scatterInstances,
    radiusless,
    hwRange: [hwMin, hwMax],
    seamDrop: [seamDropMin, seamDropMax],
    innerTuck: [innerTuckMin, innerTuckMax],
    worstScatterClearance: worstClearance,
    checks: Object.values(checks).map((c) => ({ id: c.id, n: c.n, worst: c.worst, fails: c.fails })),
  }
}

// ---------------------------------------------------------------------------
// Sabotage. Mutates the REAL scene; every one is undone by `restore`.
// ---------------------------------------------------------------------------

function sabotage(spec) {
  const scene = window.__harness.track.group.parent
  const undo = []
  const find = (pred) => {
    const out = []
    scene.traverse((o) => { if ((o.isMesh || o.isInstancedMesh) && pred(o)) out.push(o) })
    return out
  }
  const snapshotPositions = (mesh) => {
    const a = mesh.geometry.attributes.position
    const copy = new Float32Array(a.array)
    undo.push(() => { a.array.set(copy); a.needsUpdate = true })
  }

  if (spec.kind === 'hole-apron-drop') {
    const mesh = find((o) => o.name === 'canyon-apron-2')[0]
    if (!mesh) return { applied: false, why: 'no canyon-apron-2' }
    snapshotPositions(mesh)
    const a = mesh.geometry.attributes.position
    for (let i = 0; i < a.count; i++) a.setY(i, a.getY(i) - 6)
    a.needsUpdate = true
  } else if (spec.kind === 'hole-apron-missing') {
    const mesh = find((o) => o.name === 'canyon-apron-3')[0]
    if (!mesh) return { applied: false, why: 'no canyon-apron-3' }
    const geo = mesh.geometry
    const idx = geo.index
    const copy = new Uint32Array(idx.array)
    undo.push(() => { idx.array.set(copy); idx.needsUpdate = true })
    // Collapse every triangle to a degenerate point: the mesh is still there,
    // still drawn, and covers nothing. That is what a missing strip looks like.
    for (let i = 0; i < idx.count; i++) idx.setX(i, 0)
    idx.needsUpdate = true
  } else if (spec.kind === 'seam-poke') {
    const mesh = find((o) => o.name === 'canyon-apron-1')[0]
    if (!mesh) return { applied: false, why: 'no canyon-apron-1' }
    snapshotPositions(mesh)
    const a = mesh.geometry.attributes.position
    for (let i = 0; i < a.count; i++) a.setY(i, a.getY(i) + 0.5)
    a.needsUpdate = true
  } else if (spec.kind === 'seam-gap') {
    // Push every apron vertex that lies under the road out from the centreline,
    // which is precisely "the apron does not reach the road edge".
    const mesh = find((o) => o.name === 'canyon-apron-0')[0]
    if (!mesh) return { applied: false, why: 'no canyon-apron-0' }
    snapshotPositions(mesh)
    const track = window.__harness.track
    const V3 = track.group.position.constructor
    const p = new V3(); const s = {
      position: new V3(), tangent: new V3(), normal: new V3(), right: new V3(),
      halfWidth: 0, bank: 0, curvature: 0,
    }
    const loc = { t: 0, lateral: 0, height: 0, onTrack: false, checkpointIndex: 0 }
    const a = mesh.geometry.attributes.position
    for (let i = 0; i < a.count; i++) {
      p.set(a.getX(i), a.getY(i), a.getZ(i))
      track.locate(p, loc)
      track.sample(loc.t, s)
      if (Math.abs(loc.lateral) < s.halfWidth + 0.05) {
        const sign = loc.lateral >= 0 ? 1 : -1
        a.setX(i, a.getX(i) + s.right.x * sign * 1.1)
        a.setZ(i, a.getZ(i) + s.right.z * sign * 1.1)
      }
    }
    a.needsUpdate = true
  } else if (spec.kind === 'zfight-duplicate') {
    // A second author draws the same shoulder 4 mm above the first.
    const mesh = find((o) => o.name === 'canyon-apron-4')[0]
    if (!mesh) return { applied: false, why: 'no canyon-apron-4' }
    const clone = mesh.clone()
    clone.name = 'road-shoulder'
    clone.position.y += 0.004
    clone.updateWorldMatrix(true, false)
    mesh.parent.add(clone)
    undo.push(() => clone.removeFromParent())
  } else if (spec.kind === 'closure-chunk-step') {
    const mesh = find((o) => o.name === 'canyon-apron-0')[0]
    if (!mesh) return { applied: false, why: 'no canyon-apron-0' }
    snapshotPositions(mesh)
    const a = mesh.geometry.attributes.position
    for (let i = 0; i < a.count; i++) a.setY(i, a.getY(i) - 0.03)
    a.needsUpdate = true
  } else if (spec.kind === 'toe-step') {
    const walls = find((o) => o.name.indexOf('canyon-wall-') === 0)
    if (!walls.length) return { applied: false, why: 'no canyon-wall meshes' }
    for (const w of walls) {
      const before = w.position.y
      w.position.y += 0.6
      w.updateWorldMatrix(true, false)
      undo.push(() => { w.position.y = before; w.updateWorldMatrix(true, false) })
    }
  } else if (spec.kind === 'scatter-intrusion') {
    const mesh = find((o) => o.isInstancedMesh && o.name.indexOf('canyon-boulder-') === 0)[0]
    if (!mesh) return { applied: false, why: 'no canyon-boulder mesh' }
    const copy = new Float32Array(mesh.instanceMatrix.array)
    undo.push(() => { mesh.instanceMatrix.array.set(copy); mesh.instanceMatrix.needsUpdate = true })
    const track = window.__harness.track
    const V3 = track.group.position.constructor
    const M4 = track.group.matrix.constructor
    const m = new M4(); const p = new V3()
    const s = {
      position: new V3(), tangent: new V3(), normal: new V3(), right: new V3(),
      halfWidth: 0, bank: 0, curvature: 0,
    }
    const n = Math.min(30, mesh.count)
    for (let i = 0; i < n; i++) {
      track.sample(i / n, s)
      mesh.getMatrixAt(i, m)
      m.elements[12] = s.position.x
      m.elements[13] = s.position.y
      m.elements[14] = s.position.z
      mesh.setMatrixAt(i, m)
    }
    mesh.instanceMatrix.needsUpdate = true
  } else {
    return { applied: false, why: `unknown sabotage ${spec.kind}` }
  }

  window.__seamCheckUndo = undo
  return { applied: true }
}

function restore() {
  const undo = window.__seamCheckUndo || []
  for (let i = undo.length - 1; i >= 0; i--) undo[i]()
  window.__seamCheckUndo = []
  return undo.length
}
/* eslint-enable */

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const SABOTAGES = [
  { kind: 'hole-apron-drop', owner: 'coverage', what: 'a sixth of the apron dropped 6 m — a hole you fall through' },
  { kind: 'hole-apron-missing', owner: 'coverage', what: 'a sixth of the apron collapsed to nothing — bare gap beside the road' },
  { kind: 'seam-gap', owner: 'seam', what: 'the apron pulled 1.1 m off the road edge — the two surfaces stop meeting' },
  { kind: 'seam-poke', owner: 'seam', what: 'the apron raised 0.5 m — it pokes up through the road' },
  { kind: 'zfight-duplicate', owner: 'zfight', what: 'a second author draws the same shoulder 4 mm above the first' },
  { kind: 'closure-chunk-step', owner: 'chunk-closure', what: 'one apron chunk stepped 3 cm — the lap does not close' },
  { kind: 'toe-step', owner: 'apron-toe', what: 'the walls lifted 0.6 m — the apron no longer reaches the talus toe' },
  { kind: 'scatter-intrusion', owner: 'scatter', what: '30 boulders moved onto the racing line' },
]

const opts = {
  tol: { ...TOL, stations: stationsArg > 0 ? stationsArg : TOL.stations },
  barrierMargin: BARRIER_MARGIN,
}

function fmtResult(res) {
  const lines = []
  lines.push(`triangles    ${res.triCount} in ${res.meshes.length} solid ground meshes`)
  lines.push(`ground       ${res.meshes.join(', ')}`)
  lines.push(`not ground   ${res.background.join(', ') || '(none)'}   [sky dome, far sand plane — a ray that finds only these has fallen through]`)
  lines.push(`scatter      ${res.scatterMeshes.join(', ')}  (${res.scatterInstances} instances)`)
  lines.push(`halfWidth    ${res.hwRange[0].toFixed(2)} … ${res.hwRange[1].toFixed(2)} m  (everything below is measured against THIS, never a constant)`)
  if (Number.isFinite(res.seamDrop[0])) {
    lines.push(`seam tuck    apron sits ${res.seamDrop[0].toFixed(3)} … ${res.seamDrop[1].toFixed(3)} m below the road edge`)
  }
  if (Number.isFinite(res.innerTuck[0])) {
    lines.push(`inner edge   ${res.innerTuck[0].toFixed(2)} … ${res.innerTuck[1].toFixed(2)} m inboard of halfWidth`)
  }
  lines.push(`scatter clr  worst ${res.worstScatterClearance === Infinity ? 'n/a' : `${res.worstScatterClearance.toFixed(2)} m`} outside halfWidth+BARRIER_MARGIN`)
  return lines.join('\n')
}

function grade(res) {
  const failed = []
  for (const c of res.checks) if (c.n > 0) failed.push(c)
  return failed
}

let exitCode = 0
const pendings = []
const server = await startServer({ mode: useDev ? 'dev' : 'preview' })
const browser = await launch({})

try {
  const { page, consoleErrors } = await openGame(browser, server.url, {
    quality: 'high',
    seed: 20260807,
  })

  const clean = await page.evaluate(battery, opts)

  if (clean.blocked) {
    const why = {
      NO_HARNESS: '`window.__harness` is absent.',
      NO_TRACK_ON_HARNESS: '`__harness.track` is absent. Nothing about the ground can be located without it.',
      TRACK_PENDING: `\`__harness.track\` refused honestly: ${clean.message}`,
      NO_SCENE_VIA_TRACK_GROUP:
        '`__harness.track.group.parent` is not the scene. This harness reaches the world through the ' +
        'track node because `HarnessAPI` exposes no other route. See the PENDING note below.',
      NO_ROAD_MESH: 'No mesh named `road` in the scene. Either road.ts renamed it or the road is not built.',
    }[clean.blocked]
    console.log(`PENDING  ${why}`)
    console.log('')
    console.log('CONTRACT SURFACE THIS HARNESS NEEDS (not added here — a contract change is the lead\'s):')
    console.log('    // src/types.ts, in HarnessAPI')
    console.log('    readonly scene: Object3D    // the live scene root, by reference')
    console.log('')
    console.log('Nothing was measured. Exiting non-zero on purpose.')
    process.exitCode = 1
  } else {
    console.log(fmtResult(clean))
    console.log('')

    const failed = grade(clean)
    for (const c of clean.checks) {
      if (c.n === 0) {
        console.log(`PASS     ${c.id}`)
      } else {
        console.log(`FAIL     ${c.id}   ${c.n} violation(s), worst ${c.worst === null ? '?' : c.worst.toFixed(3)}`)
        for (const f of c.fails) console.log(`           ${f}`)
        if (c.n > c.fails.length) console.log(`           … and ${c.n - c.fails.length} more`)
      }
    }

    // --- honest PENDINGs ---------------------------------------------------
    if (!clean.hasApron) {
      pendings.push('apron: no `canyon-apron-*` mesh exists, so seam / inner-edge / apron-toe / chunk-closure validated NOTHING.')
    }
    if (clean.radiusless > 0) {
      pendings.push(`scatter: ${clean.radiusless} instanced mesh(es) have no bounding sphere; their instances were NOT tested.`)
    }
    pendings.push(
      'visible-through-the-camera: this harness proves the ground is watertight in GEOMETRY. It cannot prove ' +
      'no hole is visible from the game camera, because `HarnessAPI` exposes no camera. Adding ' +
      '`readonly camera: Camera` to HarnessAPI would let this file unproject the frame and gate on pixels too.',
    )

    if (failed.length) exitCode = 1
    if (consoleErrors.length) {
      console.log(`FAIL     console errors:\n           ${consoleErrors.join('\n           ')}`)
      exitCode = 1
    }

    writeFileSync(path.join(OUT, 'seam-check.json'), JSON.stringify(clean, null, 2))
    console.log(`\nreport       ${path.join(OUT, 'seam-check.json')}`)
  }

  // -------------------------------------------------------------------------
  // Self-test
  // -------------------------------------------------------------------------
  if (selfTest) {
    console.log('\n--- SELF-TEST: sabotaging the real scene -------------------------------')
    if (clean.blocked) {
      console.error('SELF-TEST FAILED — could not reach the scene, so no sabotage could be applied.')
      process.exitCode = 1
    } else {
      const cleanFailed = grade(clean).map((c) => c.id)
      const misses = []
      if (cleanFailed.length) {
        console.log(
          `note: the build under test is ALREADY failing [${cleanFailed.join(', ')}]. A sabotage owned by one ` +
          'of those cannot be attributed, and is reported as a miss.',
        )
      }
      for (const sab of SABOTAGES) {
        const applied = await page.evaluate(sabotage, sab)
        if (!applied.applied) {
          misses.push(`${sab.kind}: could not be applied (${applied.why})`)
          console.log(`MISS     ${sab.kind.padEnd(22)} not applied — ${applied.why}`)
          continue
        }
        const broken = await page.evaluate(battery, opts)
        const restored = await page.evaluate(restore)
        const fired = broken.blocked ? [] : grade(broken).map((c) => c.id)
        const ownerFired = fired.includes(sab.owner) && !cleanFailed.includes(sab.owner)
        const label = ownerFired ? 'CAUGHT  ' : 'MISS    '
        console.log(
          ` ${label} ${sab.kind.padEnd(22)} owner=${sab.owner.padEnd(14)} fired=[${fired.join(', ') || 'nothing'}]  (undo ${restored})`,
        )
        if (!ownerFired) misses.push(`${sab.kind}: ${sab.owner} did not fire; ${fired.join(', ') || 'nothing'} did`)
      }

      const after = await page.evaluate(battery, opts)
      const afterFailed = grade(after).map((c) => c.id)
      if (afterFailed.join('|') !== cleanFailed.join('|')) {
        misses.push(
          `the scene was not fully restored: before [${cleanFailed.join(', ') || 'clean'}] after [${afterFailed.join(', ') || 'clean'}]`,
        )
      }

      if (misses.length) {
        console.error(`\nSELF-TEST FAILED — ${misses.length} sabotage(s) were not caught by their own detector:`)
        for (const m of misses) console.error(`  ${m}`)
        process.exitCode = 1
      } else {
        console.log(`\nSELF-TEST PASSED — all ${SABOTAGES.length} sabotages were caught by their owning check, and the scene restored clean.`)
        process.exitCode = 0
      }
    }
  } else {
    if (pendings.length) {
      console.log('')
      for (const p of pendings) console.log(`PENDING  ${p}`)
      console.log('(reported, never silently skipped)')
    }
    if (exitCode === 0) console.log('\nPASS')
    else {
      console.log('\nFAIL — the ground is not watertight. Prove the instrument first: node tools/seam-check.mjs --broken')
      process.exitCode = 1
    }
  }
} finally {
  await browser.close()
  await server.stop()
}
