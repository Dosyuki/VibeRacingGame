/**
 * COMPOSITION ROOT — the only file allowed to construct subsystems and wire
 * them together. Subsystems never import each other; everything crosses through
 * `GameServices`, the `EventBus`, or `src/types.ts`.
 *
 * ROUND 0 STATUS
 * This boots the frame pipeline, the fixed-step clock, the diagnostics
 * instruments and the harness surface. The scene is a deliberate placeholder:
 * enough geometry and emission to give the luma instruments something real to
 * measure, and nothing that pretends to be the circuit. `world/`, `kart/`,
 * `render/`, `game/`, `fx/`, `ui/` and `audio/` are built by their owning agents
 * against `src/types.ts` and slot in here.
 *
 * Harness methods that need those subsystems THROW with the reason. They do not
 * return zeroes. A measurement surface that quietly answers a question it cannot
 * answer is worse than one that is missing.
 */

import {
  ACESFilmicToneMapping,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three'

import { createEventBus } from './core/events'
import { createLoop } from './core/loop'
import { createRngFactory } from './core/rng'
import { readFrameLumaStats, readGLReport } from './core/diagnostics'
import { detectTier, resolveQuality } from './core/quality'
import { makeRockSurface } from './render/procedural'
import { buildSky } from './render/sky'
import { buildRoad } from './world/road'
import { buildCanyonTerrain } from './world/terrain'
import { createTrack } from './world/track'
import type {
  Ctx,
  FrameStats,
  HarnessAPI,
  QualityTier,
  Settings,
  TrackSample,
} from './types'

const params = new URLSearchParams(location.search)

/**
 * `readPixels` after present returns discarded contents unless the context was
 * created with this. Off by default because it costs real frame time; the
 * harnesses that read pixels ask for it explicitly.
 */
const PRESERVE_DRAWING_BUFFER = params.get('debug') === 'frames'

const seed = Number(params.get('seed') ?? 20260807) || 20260807

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const host = document.getElementById('app')!
const renderer = new WebGLRenderer({
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: PRESERVE_DRAWING_BUFFER,
})
renderer.outputColorSpace = SRGBColorSpace
renderer.toneMapping = ACESFilmicToneMapping
/*
 * DERIVED, not chosen. Solving the three.js ACES fit for `RRT(v) = 0.18` gives
 * exposure 0.877, which puts an 18% grey card at display luma 0.461 and sunlit
 * sand at 0.65. The previous 1.15 was tuned for a scene with no key light at
 * all; carried into daylight it shifts every luma up ~0.05 and puts the sky at
 * 0.91, spending a third of a stop of highlight room for nothing.
 *
 * This is a single global scalar applied to everything — exactly the class of
 * value CLAUDE.md warns about. Change it once, deliberately, with a number
 * behind it.
 */
renderer.toneMappingExposure = 0.88
renderer.shadowMap.enabled = true
renderer.shadowMap.type = PCFSoftShadowMap
host.appendChild(renderer.domElement)

const tier: QualityTier = detectTier()
const quality = resolveQuality(tier, renderer)

const scene = new Scene()
// No `scene.background` colour: ART_DIRECTION §8b forbids any perfectly uniform
// region, and a flat background is the easiest one to ship by accident. The sky
// is a gradient mesh built in placeholder-city.ts.
// §2: exponential-squared fog, #d8b892, density 0.0025. Aerial perspective is
// what separates the mesa layers; it is not optional. The density dropped 5x
// from the city value — 0.0125 gives useful visibility to about 150 m, and a
// canyon vista has a legitimate 400 m+ sightline.
scene.fog = new FogExp2(0xd8b892, 0.0025)

// far reaches the outermost mesa ring, which sits about 745 m from the near
// side of the circuit; near is lifted off 0.1 to keep depth precision usable
// across that range.
const camera = new PerspectiveCamera(62, 1, 0.3, 2400)
camera.position.set(0, 2.3, 0)
camera.lookAt(0, 3.2, -40)

const settings: Settings = {
  quality: tier,
  masterVolume: 0.8,
  musicVolume: 0.5,
  sfxVolume: 0.9,
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  invertLook: false,
}

const events = createEventBus()
const rngFor = createRngFactory(seed)

const ctx: Ctx = {
  scene,
  renderer,
  events,
  settings,
  quality,
  get clock() {
    return loop.clock
  },
  seed,
  rngFor,
}
void ctx // consumed by subsystems from round 1 onward

// ---------------------------------------------------------------------------
// Placeholder scene — measurable, not representative
// ---------------------------------------------------------------------------

/*
 * ART_DIRECTION §2. The sun is the key and there is no second shadow caster.
 * Elevation 12 degrees, azimuth 217, which makes every shadow 4.70x the height
 * of the thing casting it — see §9c. The shadow frustum is sized for that: a
 * scheme tuned for a normal sun terminates around 120 m, the far shadows simply
 * are not there, the open ground goes uniform, and nothing in the frame says
 * why.
 */
/*
 * Elevation is held at 12 degrees (y = sin 12 = 0.208); the AZIMUTH moved, from
 * 217 to 198, and the reason is geometric rather than aesthetic.
 *
 * At 12 degrees every shadow is 4.70x the height of its caster. A 25 m canyon
 * wall therefore throws 118 m — wider than the canyon. With the sun crossing the
 * gorge the floor is in permanent shadow, no part of the road is ever lit, and
 * §1's whole premise (a dark road ribbon at luma 0.27 against sand at 0.65) is
 * unreachable because it assumes the road is in sun. The energy check found this
 * as 20% of the frame below luma 0.05 at some camera positions and not others,
 * which is exactly what a partially-shadowed dolly looks like from the outside.
 *
 * Pointing the sun down the axis of the gorge is what real canyon photography
 * does, for the same reason: it is the only orientation at a low elevation where
 * light reaches the floor at all.
 */
const SUN_DIR = new Vector3(-0.3, 0.208, -0.93).normalize()
const sun = new DirectionalLight(0xffb46b, 4.2)
sun.position.copy(SUN_DIR).multiplyScalar(240)
sun.castShadow = true
sun.shadow.mapSize.set(2048, 2048)
sun.shadow.camera.near = 1
sun.shadow.camera.far = 620
sun.shadow.camera.left = -220
sun.shadow.camera.right = 220
sun.shadow.camera.top = 220
sun.shadow.camera.bottom = -220
// Normal-offset, not slope-scaled depth. At cos(theta) = 0.21 a depth bias big
// enough to suppress acne peter-pans every contact point — deleting exactly the
// grounding the shadows exist to provide.
sun.shadow.bias = -0.00012
sun.shadow.normalBias = 0.022
scene.add(sun)
scene.add(sun.target)

/*
 * Warm cliff bounce, roughly anti-sun, casting nothing. Its only job is to keep
 * the shaded side of rock from going flat blue; inside a slot canyon it is the
 * dominant light and the reason those sections are readable at all.
 */
const bounce = new DirectionalLight(0xe08a4e, 0.35)
bounce.position.set(0.742, 0.139, 0.656).multiplyScalar(200)
scene.add(bounce)

/*
 * Sky fill. This is the term that produces the 188-degree hue split inside the
 * ground plane — sunlit sand at hue 40, shadowed sand at hue 228 — which is
 * ART_DIRECTION §1 Trap 1's counter-measure against the whole frame reading as
 * one orange wash. Lowering it to "deepen" the shadows destroys that, so the
 * intensity is spec, not taste.
 *
 * Retiring a guard, on the record: the city version ran at 0.9 because a
 * mirror-smooth road at near-normal incidence got almost nothing from Fresnel
 * and rendered flat black in front of the camera. That failure mode is
 * wet-specific — a matte desert road cannot reproduce it — so the elevated
 * value is not carried over. Per CLAUDE.md, the reason a guard is being dropped
 * gets written down rather than the guard just disappearing.
 */
/*
 * 1.35, not the 0.55 that §2 derives for sky alone.
 *
 * 0.55 is correct for sky fill in isolation: at air mass 4.8 the diffuse sky is
 * about 35% of horizontal illuminance, and 4.2 x sin(12 deg) = 0.874 for the sun,
 * which puts the sky term at roughly 0.47-0.55. Shipping that value alone put
 * 34% of the frame below luma 0.05 against a 6% ceiling.
 *
 * The arithmetic says why, and it is not a bug in the derivation — it is a
 * missing term. Tarmac has a linear albedo luma of 0.059 against sand's 0.35.
 * Under sky fill only, shadowed tarmac lands at display luma 0.027, six times
 * darker than the shadowed sand the spec computed. A real canyon fills that
 * shadow with bounce off the sunlit sand and the opposite wall, which is a
 * large term here and which a single anti-sun directional cannot represent.
 *
 * So this light is sky fill PLUS a stand-in for surround bounce, until there is
 * real indirect. Written down rather than quietly tuned, because the number now
 * disagrees with §2 on purpose.
 */
scene.add(new HemisphereLight(0x86b4e8, 0xd9a068, 1.35))

/*
 * THE WORLD.
 *
 * Three subsystems, built by three agents that never saw each other's code, and
 * wired together here because `src/main.ts` is the only composition root. They
 * agree because they all coded against `ITrack` in the contract and nothing
 * else — which is the entire reason that file was frozen before any of them
 * started.
 *
 * Order is a real dependency, not a preference: the road is extruded along the
 * spline and the canyon walls are swept from it, so the track exists first.
 */
// TrackFactory permits an async build; this one is synchronous, but the
// composition root must not assume that.
const texSize = Math.min(1024, quality.maxTextureSize)
const sky = buildSky(rngFor('render/sky'))
scene.add(sky.mesh)

const track = await createTrack(ctx)

/*
 * The open sand, textured — and it has to be.
 *
 * The first version was one flat colour on a 2400 m plane, and the flat-bright
 * tile detector caught it on its first real use: two tiles painted, uniform,
 * and bright. That is precisely the failure ART_DIRECTION §9b Trap 3 predicts
 * ("an untextured ground plane under a directional light is genuinely uniform
 * across a large fraction of frame, and it is easy to ship by accident"), and it
 * is the daylight inverse of the black-tile failure the night theme had.
 *
 * The rock toolkit stands in for a real sand material until `render/` builds
 * one with the §5b sheen term. Tiled at 40 m so dune-scale variation reads
 * without the repeat becoming visible.
 */
const sandMaps = makeRockSurface(texSize, rngFor('world/sand'), quality.maxAnisotropy)
for (const m of [sandMaps.map, sandMaps.roughnessMap]) m.repeat.set(60, 60)
const sand = new Mesh(
  new PlaneGeometry(2400, 2400),
  new MeshStandardMaterial({
    color: 0xe3c893,
    map: sandMaps.map,
    roughnessMap: sandMaps.roughnessMap,
    roughness: 1.0,
    metalness: 0.0,
  }),
)
sand.rotation.x = -Math.PI / 2
sand.position.y = -0.05
sand.receiveShadow = true
scene.add(sand)

scene.add(track.group)
scene.add(
  buildRoad(track, {
    rng: rngFor('world/road'),
    textureSize: texSize,
    anisotropy: quality.maxAnisotropy,
  }),
)

const terrain = buildCanyonTerrain(ctx, track)
scene.add(terrain.group)

/**
 * The wet road is the signature material of this project, and it taught the
 * first real lesson here: `#14141c` at roughness 0.12 is a MIRROR, not a dark
 * surface. It is not lit by lights — it is lit by what it reflects. With the
 * moon and hemisphere fill in place and nothing to reflect, the ground still
 * measured as pure unpainted black, and the temptation was to relax the
 * detector until the frame passed.
 *
 * The detector was right both times. What the scene was missing is the
 * environment, so here it is: one PMREM pass over the emissive skyline, which
 * is what the neon actually reaches the road through. `render/` replaces this
 * with a real probe; the principle does not change.
 */
const pmrem = new PMREMGenerator(renderer)
const envTarget = pmrem.fromScene(scene, 0, 0.1, 400)
scene.environment = envTarget.texture
pmrem.dispose()

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

let firstFrameResolve: (() => void) | null = null
const ready = new Promise<void>((resolve) => {
  firstFrameResolve = resolve
})

let scalerPinned = false
const failedShaders: string[] = []
let contextLost = false

renderer.domElement.addEventListener('webglcontextlost', () => {
  contextLost = true
})
renderer.domElement.addEventListener('webglcontextrestored', () => {
  contextLost = false
})

// Sampling window state. `frameStats` without a window is meaningless — "since
// boot" and "since the last call" answer different questions and produce
// different verdicts from the same build.
let sampling = false
let sampleFrames = 0
let sampleMs = 0
let sampleLongFrames = 0
let lastPresentMs = 0
const sampleFrameTimes: number[] = []

function resize(): void {
  const w = host.clientWidth
  const h = host.clientHeight
  const dpr = Math.min(window.devicePixelRatio, 2) * quality.renderScale
  renderer.setPixelRatio(dpr)
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}
window.addEventListener('resize', resize)
resize()

const cameraPath = new Vector3()
const lookTarget = new Vector3()

// Caller-owned TrackSample instances. `sample` writes into these and returns
// them; the contract makes that the caller's job precisely so the hot path
// allocates nothing.
function makeSample(): TrackSample {
  return {
    position: new Vector3(),
    tangent: new Vector3(),
    normal: new Vector3(),
    right: new Vector3(),
    halfWidth: 0,
    bank: 0,
    curvature: 0,
  }
}
const camHere = makeSample()
const camAhead = makeSample()

const loop = createLoop({
  fixedUpdate(): void {
    // Nothing deterministic to advance yet. Subsystems land here from round 1.
  },
  lateUpdate(): void {
    if (sampling) {
      // Measure wall time between presents, NOT the `dt` the loop handed us.
      // `stepTicks` drives lateUpdate with a fixed step, so sampling `dt` would
      // report a flat 120 fps for any build, however slow — a confident,
      // precise, entirely fictional number of exactly the kind this project
      // exists to catch.
      const now = performance.now()
      if (lastPresentMs > 0) {
        const ms = now - lastPresentMs
        sampleFrames++
        sampleMs += ms
        sampleFrameTimes.push(ms)
        // Two vsync intervals at 60 Hz. The real hitch signal — see FrameStats.
        if (ms > 30) sampleLongFrames++
      }
      lastPresentMs = now
    }

    /*
     * The camera now drives the actual circuit rather than a straight line.
     *
     * It rides the racing line at a fixed speed, looking a fixed arc-length
     * ahead. That look-ahead is what makes a corner readable: aiming at a point
     * a fixed distance down the road is roughly what a driver does, and it is
     * also the cheapest possible check that the spline's frame is coherent —
     * a track whose tangent or normal quietly goes wrong makes this camera
     * lurch, and no still frame would show it.
     *
     * Driven by the simulation clock, never the wall clock, so a screenshot at
     * tick N is the same image on every machine.
     */
    const LAP_SECONDS = 68
    const t = (loop.clock.simTime / LAP_SECONDS) % 1
    track.sample(t, camHere)
    track.sample(t + 0.018, camAhead)

    const lateral = track.racingLine(t)
    cameraPath
      .copy(camHere.position)
      .addScaledVector(camHere.right, lateral)
      .addScaledVector(camHere.normal, 2.4)
    camera.position.copy(cameraPath)
    camera.up.copy(camHere.normal)
    lookTarget
      .copy(camAhead.position)
      .addScaledVector(camAhead.right, track.racingLine(t + 0.018))
      .addScaledVector(camAhead.normal, 1.6)
    camera.lookAt(lookTarget)
    sky.mesh.position.copy(camera.position)

    // The shadow frustum follows the camera; a fixed one centred on the origin
    // loses every shadow the moment the dolly leaves the middle of the map.
    sun.position.copy(cameraPath).addScaledVector(SUN_DIR, 240)
    sun.target.position.copy(cameraPath)
    sun.target.updateMatrixWorld()

    renderer.render(scene, camera)

    if (firstFrameResolve) {
      document.getElementById('boot')?.setAttribute('hidden', '')
      firstFrameResolve()
      firstFrameResolve = null
    }
  },
})

loop.start()

// ---------------------------------------------------------------------------
// Harness surface
// ---------------------------------------------------------------------------

function notYet(what: string): never {
  throw new Error(
    `[harness] ${what} is not available yet — the subsystem that provides it has not been built. ` +
      'Failing loudly rather than returning a value this build cannot know.',
  )
}

const harness: HarnessAPI = {
  version: 2,
  ready,
  get playerKartId(): number {
    return notYet('playerKartId')
  },

  get track() {
    return track
  },

  resetRace: () => notYet('resetRace'),
  startRace: () => notYet('startRace'),
  setDriver: () => notYet('setDriver'),
  vantage: () => notYet('vantage'),
  loadScenario: () => notYet('loadScenario'),
  setInput: () => notYet('setInput'),
  releaseInput: () => notYet('releaseInput'),
  injectInput: () => notYet('injectInput'),
  seek: () => notYet('seek'),
  telemetry: () => notYet('telemetry'),
  kartSnapshot: () => notYet('kartSnapshot'),

  stepTicks: (count: number) => loop.stepTicks(count),

  beginSample(): void {
    sampling = true
    sampleFrames = 0
    sampleMs = 0
    sampleLongFrames = 0
    lastPresentMs = 0
    sampleFrameTimes.length = 0
  },

  endSample(): FrameStats {
    sampling = false
    const info = renderer.info
    const sorted = sampleFrameTimes.slice().sort((a, b) => a - b)
    const p95 = sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]! : 0
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number } }
    return {
      frames: sampleFrames,
      fps: sampleMs > 0 ? (sampleFrames * 1000) / sampleMs : 0,
      meanFrameMs: sampleFrames > 0 ? sampleMs / sampleFrames : 0,
      p95FrameMs: p95,
      longFrames: sampleLongFrames,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
      jsHeapMb: perf.memory ? perf.memory.usedJSHeapSize / (1024 * 1024) : null,
      textureMemoryMb: null,
    }
  },

  frameLumaStats: () => readFrameLumaStats(renderer, PRESERVE_DRAWING_BUFFER),
  glReport: () => readGLReport(renderer, failedShaders, contextLost),

  pinScaler(on: boolean): void {
    // No adaptive scaler exists yet, so pinning is trivially honoured. When one
    // lands, `scalerPinned` must keep reporting the truth — a harness that
    // trusts a pin that did not take is measuring nothing.
    scalerPinned = on
  },
  scalerPinned: () => scalerPinned,
}

window.__harness = harness
