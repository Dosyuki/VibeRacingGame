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
  BoxGeometry,
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
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
import { makeWetSurface } from './render/procedural'
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
renderer.toneMappingExposure = 1.15
host.appendChild(renderer.domElement)

const tier: QualityTier = detectTier()
const quality = resolveQuality(tier, renderer)

const scene = new Scene()
scene.background = new Color(0x05060f)
// ART_DIRECTION §2: exponential-squared, #180f2e, density 0.0125. Aerial
// perspective is what separates the building layers; it is not optional.
scene.fog = new FogExp2(0x180f2e, 0.0125)

const camera = new PerspectiveCamera(62, 1, 0.1, 800)
camera.position.set(0, 6, 18)
camera.lookAt(0, 2, 0)

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

// ART_DIRECTION §2: there is no key light in the sky at 2 a.m. — the city is the
// key. Until `render/` builds the real emissive city, these two stand in for it.
// Their absence is what made the first smoke run fail: a MeshStandardMaterial
// lit by nothing renders pure black, and the luma instrument caught it before
// any game code existed.
const moon = new DirectionalLight(0xa8c0ff, 0.55)
moon.position.set(0.35, 0.62, 0.7).multiplyScalar(100)
scene.add(moon)

// Warm ground bounce from below — the city glow that keeps undersides readable.
scene.add(new HemisphereLight(0x3a2258, 0x2a1636, 0.35))

/**
 * The wet road, with spatially varying roughness per ART_DIRECTION §4.
 *
 * The first version used one flat roughness value and it was wrong in a way
 * worth naming: a uniformly mirrored road gives the eye no distance cue, so the
 * whole ground collapses into a single flat sheet and the scene reads as having
 * no depth at all. Puddles, dried tyre strips and drain streaks are not
 * decoration here — the variation IS the depth cue, because the size of the
 * features tells you how far away you are looking.
 */
const texSize = Math.min(1024, quality.maxTextureSize)
const wet = makeWetSurface(texSize, rngFor('placeholder/road'), quality.maxAnisotropy)
const ground = new Mesh(
  new PlaneGeometry(400, 400),
  new MeshStandardMaterial({
    color: 0x14141c,
    metalness: 0.0,
    /*
     * MUST be 1.0. `roughnessMap` MULTIPLIES this value, it does not replace it.
     *
     * This was set to 0.12 — the wet-asphalt figure — on the reasonable-sounding
     * theory that it was a sensible fallback. The effect was to scale the whole
     * map down by 8x: a texture carrying 0.03 to 0.58 became 0.004 to 0.07, so
     * every square inch of road stayed mirror-smooth and two rounds of tuning
     * the noise field changed nothing visible. The map was correct the entire
     * time and was being crushed on the way to the GPU.
     *
     * Same applies to metalnessMap, aoMap and the rest. When a map appears to
     * do nothing, check what it multiplies before touching the map.
     */
    roughness: 1.0,
    roughnessMap: wet.roughnessMap,
    normalMap: wet.normalMap,
    normalScale: new Vector2(wet.normalScale, wet.normalScale),
  }),
)
ground.rotation.x = -Math.PI / 2
scene.add(ground)

// Emissive blocks standing in for the skyline. Instanced from the start because
// §8 caps the frame at 250 draw calls and a per-building mesh blows that on the
// first real city.
const NEON = [0xff2d95, 0x00e5ff, 0x8b3dff, 0xffa424]
const blockRng = rngFor('placeholder/skyline')
const blockGeo = new BoxGeometry(1, 1, 1)
const blocks: InstancedMesh[] = []
const mat4 = new Matrix4()

for (let c = 0; c < NEON.length; c++) {
  const perColour = 40
  const mesh = new InstancedMesh(
    blockGeo,
    new MeshBasicMaterial({ color: NEON[c]! }),
    perColour,
  )
  for (let i = 0; i < perColour; i++) {
    const angle = blockRng() * Math.PI * 2
    const radius = 30 + blockRng() * 90
    const height = 6 + blockRng() * 44
    const width = 3 + blockRng() * 6
    mat4.makeScale(width, height, width)
    mat4.setPosition(Math.cos(angle) * radius, height / 2, Math.sin(angle) * radius)
    mesh.setMatrixAt(i, mat4)
  }
  mesh.instanceMatrix.needsUpdate = true
  scene.add(mesh)
  blocks.push(mesh)
}

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

const orbit = new Vector3()

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

    // Placeholder camera motion so the frame is never a parked still. Driven by
    // the simulation clock, not the wall clock, so a screenshot at tick N is
    // the same image on every machine.
    const a = loop.clock.simTime * 0.12
    orbit.set(Math.cos(a) * 26, 7 + Math.sin(a * 0.7) * 2, Math.sin(a) * 26)
    camera.position.copy(orbit)
    camera.lookAt(0, 4, 0)

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
