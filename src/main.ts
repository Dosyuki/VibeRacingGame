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
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'

import { createEventBus } from './core/events'
import { createLoop } from './core/loop'
import { createRngFactory } from './core/rng'
import { readFrameLumaStats, readGLReport } from './core/diagnostics'
import { detectTier, resolveQuality } from './core/quality'
import { buildPlaceholderCanyon } from './render/placeholder-canyon'
import { makeRoadSurface } from './render/procedural'
import type {
  Ctx,
  FrameStats,
  HarnessAPI,
  QualityTier,
  Settings,
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

const camera = new PerspectiveCamera(62, 1, 0.1, 800)
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

const texSize = Math.min(1024, quality.maxTextureSize)

/*
 * MUST be 1.0 on every material below. `roughnessMap` MULTIPLIES this value, it
 * does not replace it.
 *
 * This was once set to a "sensible fallback" of 0.12, which scaled the whole map
 * down by 8x: a texture carrying 0.03 to 0.58 arrived as 0.004 to 0.07, every
 * square inch stayed mirror-smooth, and two rounds of tuning the noise field
 * changed nothing visible. The map was correct the entire time and was being
 * crushed on the way to the GPU. Same applies to metalnessMap and aoMap. When a
 * map appears to do nothing, check what it multiplies before touching the map.
 */

// Sand, everywhere. ART_DIRECTION §5b: the signature material, and harder than
// the wet road was, because sand has no reflection to carry it.
const sand = new Mesh(
  new PlaneGeometry(1400, 1400),
  new MeshStandardMaterial({ color: 0xe3c893, roughness: 1.0, metalness: 0.0 }),
)
sand.rotation.x = -Math.PI / 2
sand.receiveShadow = true
scene.add(sand)

// The road, laid on top. §3b: sunlit sand at luma 0.65 against tarmac at 0.27 is
// the racing line, and it works before a single marking is drawn.
const road = makeRoadSurface(texSize, rngFor('placeholder/road'), quality.maxAnisotropy)
/*
 * The road plane is 18 m across and 900 m long, and PlaneGeometry hands out UVs
 * of 0..1 on both axes regardless. Left alone that stretches every texel 50:1
 * along the direction of travel, which does not read as a rough surface — it
 * reads as motion blur baked into a still frame. Repeat is set so texels come
 * out roughly square at about 9 m per tile.
 */
for (const map of [road.roughnessMap, road.normalMap]) map.repeat.set(2, 100)
const roadMesh = new Mesh(
  new PlaneGeometry(2 * 9, 900),
  new MeshStandardMaterial({
    color: 0x4b4340,
    metalness: 0.0,
    roughness: 1.0,
    roughnessMap: road.roughnessMap,
    normalMap: road.normalMap,
    normalScale: new Vector2(road.normalScale, road.normalScale),
  }),
)
roadMesh.rotation.x = -Math.PI / 2
roadMesh.position.y = 0.02
roadMesh.receiveShadow = true
scene.add(roadMesh)

const canyon = buildPlaceholderCanyon(scene, rngFor('placeholder/canyon'), quality.maxAnisotropy)

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
     * A dolly down the canyon, not an orbit.
     *
     * The camera is a depth cue in its own right: travelling along the axis the
     * marker posts and kerbs converge on is what makes the vanishing point
     * readable. Orbiting shows the same scene from every angle and never lets
     * the eye resolve how far away anything is.
     *
     * Driven by the simulation clock, never the wall clock, so a screenshot at
     * tick N is the same image on every machine.
     */
    const t = loop.clock.simTime * 7
    const z = ((t % canyon.length) + canyon.length) % canyon.length - canyon.length / 2
    cameraPath.set(Math.sin(loop.clock.simTime * 0.25) * 3.0, 2.1, z)
    camera.position.copy(cameraPath)
    camera.lookAt(cameraPath.x * 0.4, 3.6, z - 40)
    // The shadow frustum follows the camera; a fixed one centred on the origin
    // loses every shadow the moment the dolly leaves the middle of the canyon.
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
