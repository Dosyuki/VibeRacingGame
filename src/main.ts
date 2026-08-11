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
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three'

import { createEventBus } from './core/events'
import { createLoop, type Loop } from './core/loop'
import { createRngFactory } from './core/rng'
import { readFrameLumaStats, readGLReport } from './core/diagnostics'
import { detectTier, resolveQuality } from './core/quality'
import { makeRockSurface } from './render/procedural'
import { createInput } from './core/input'
import { createAIDriver, type AIDriver } from './game/ai'
import { createCameraRig } from './game/camera'
import { createItems } from './game/items'
import { createRace } from './game/race'
import { createKart } from './kart/kart'
import { createHud } from './ui/hud'
import { createKartModel, type KartModel } from './render/kart-model'
import { buildSky } from './render/sky'
import { buildRoad } from './world/road'
import { buildCanyonTerrain } from './world/terrain'
import { createTrack } from './world/track'
import { SIMULATION_STEP } from './types'
import type {
  BoostSource,
  Clock,
  Ctx,
  DriverMode,
  FrameStats,
  GameServices,
  HarnessAPI,
  IKart,
  InputFrame,
  KartIdentity,
  KartState,
  QualityTier,
  RaceTelemetry,
  Settings,
  Subsystem,
  TrackLocation,
  TrackSample,
  VantageName,
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

/*
 * The clock does not exist during `build` and `link`, and that is not a bug to
 * paper over — it is the lifecycle. The loop is constructed after the
 * subsystems it drives, so a subsystem asking the time while it is being wired
 * up is asking before there is one.
 *
 * The getter used to reach straight for `loop`, which is a `const` declared
 * further down, so the first subsystem to read `ctx.clock` inside its `link`
 * hit the temporal dead zone and took the whole page down with
 * "Cannot read properties of undefined (reading 'clock')". `ui/` was that
 * subsystem; anything reading the clock at link time would have been.
 *
 * Handing back tick zero is the truthful answer to "what time is it" before the
 * first tick, and it keeps the failure from being a boot crash.
 */
const BOOT_CLOCK: Clock = { tick: 0, simTime: 0, alpha: 0, paused: false }
let loopRef: Loop | undefined

const ctx: Ctx = {
  scene,
  renderer,
  events,
  settings,
  quality,
  get clock() {
    return loopRef?.clock ?? BOOT_CLOCK
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

/*
 * One PMREM pass over the built world, so metal and clearcoat on the karts have
 * something to reflect. Under a sun key this matters far less than it did when
 * the road was a mirror lit by nothing, but ART_DIRECTION §5d still puts chrome
 * trim at roughness 0.18 and it needs a probe.
 */
const pmrem = new PMREMGenerator(renderer)
const envTarget = pmrem.fromScene(scene, 0, 1, 1200)
scene.environment = envTarget.texture
pmrem.dispose()

// ---------------------------------------------------------------------------
// THE FIELD
// ---------------------------------------------------------------------------
/*
 * Eight karts, and the wiring that turns six independently-written subsystems
 * into a race.
 *
 * ART_DIRECTION §5d: livery colours come from the ENVIRONMENT bands (hue 8-43
 * and 205-228) and never from the reserved gameplay band, so that no kart can
 * ever be mistaken at a glance for a drift signal.
 */
const LIVERIES: readonly [number, number][] = [
  [0xc9764a, 0x3a2a24],
  [0x3f77c4, 0x1b2c46],
  [0xe3c893, 0x6b5c4e],
  [0x8f4a33, 0x2a1a14],
  [0x86b4e8, 0x2f4560],
  [0xd9a068, 0x4e3a30],
  [0x7d3529, 0x24120e],
  [0xb9c9d8, 0x4a5560],
]

const PLAYER_KART_ID = 0

const identities: KartIdentity[] = LIVERIES.map((colours, i) => ({
  id: i,
  isPlayer: i === PLAYER_KART_ID,
  displayName: `Racer ${i + 1}`,
  primaryColor: colours[0],
  secondaryColor: colours[1],
  liverySeed: 1000 + i * 7919,
}))

const input = createInput(ctx)
const cameraRig = createCameraRig(ctx)

/*
 * THERE MUST BE EXACTLY ONE CAMERA, AND IT IS THE RIG'S.
 *
 * This file used to construct its own `PerspectiveCamera` for the placeholder
 * dolly, and never stopped: `renderer.render(scene, camera)` and the harness
 * getter both pointed at that module-local object, while `cameraRig` quietly
 * maintained a second one that was never rendered, never resized and never read.
 *
 * The rig was working correctly the entire time. Nobody was looking at its
 * output. At the grid the kart faces +X and the abandoned dolly still looked
 * down -Z, which is the 90-degree across-the-road view every player saw as the
 * first frame of the game.
 *
 * Seven harnesses missed it because `vantage()` writes this same module-local
 * camera, so every mid-circuit review shot was taken through the object that
 * was actually being rendered and looked perfectly fine.
 */
const camera = cameraRig.camera
// far reaches the outermost mesa ring, about 745 m from the near side of the
// circuit; near is lifted off 0.1 to keep depth precision usable across it.
camera.fov = 62
camera.near = 0.3
camera.far = 2400
camera.updateProjectionMatrix()
const race = createRace(ctx)
const items = createItems(ctx)

const karts: (IKart & Subsystem)[] = identities.map((identity, i) => {
  const slot = track.startGrid[i % track.startGrid.length]!
  return createKart(ctx, identity, slot)
})
for (const kart of karts) scene.add(kart.modelRoot)

/*
 * The karts become visible here. Eight of them have been driving the circuit
 * with full physics since the last round while nothing at all was drawn — the
 * camera was following an invisible object, and no instrument in the project
 * could have told you, because every one of them measures either geometry or
 * pixels of the WORLD.
 */
const kartModels: KartModel[] = karts.map((kart) => {
  const model = createKartModel(ctx, kart.identity)
  kart.modelRoot.add(model.root)
  return model
})

const hud = createHud(ctx)

const services: GameServices = {
  track,
  input,
  race,
  items,
  camera: cameraRig,
  karts,
  identities,
  playerKartId: PLAYER_KART_ID,
  kartById: (id: number) => karts.find((k) => k.identity.id === id) ?? null,
}

/*
 * Lifecycle, exactly as the contract's Composition section lays it out: every
 * `build` resolves before any `link` runs, because `link` is where a subsystem
 * picks up references to things that did not exist during its own build.
 */
// `PlainFactory` permits an async construction; `createHud` is synchronous, but
// the root must not assume that of any factory.
const subsystems: Subsystem[] = [input, cameraRig, race, items, ...karts, await hud]
for (const s of subsystems) await s.build(ctx)
for (const s of subsystems) s.link?.(services, ctx)

/*
 * Drivers. The reference AI is a MEASURING INSTRUMENT as much as an opponent —
 * ART_DIRECTION §10c is graded with it — so the composition root owns the
 * bridge between `DriverMode` and the driver's own mode, and `aiDrift` selects
 * clean-line versus drift-seeking for the criterion-1 benchmark.
 */
type DriverSlot = { mode: DriverMode; ai: AIDriver }
let aiDrift: 'seek' | 'clean' = 'seek'
const drivers: DriverSlot[] = karts.map((kart) => ({
  mode: kart.identity.isPlayer ? 'human' : 'referenceAI',
  ai: createAIDriver(ctx, track, kart, { mode: 'drift' }),
}))

/** The frame each driver produced last tick, for `HarnessAPI.lastInput`. */
const lastFrames: InputFrame[] = karts.map(() => ({
  steer: 0,
  throttle: 0,
  brake: 0,
  drift: false,
  useItem: false,
  look: 0,
}))

/** Scripted override for the player, set by `HarnessAPI.setInput`. */
let scriptedInput: InputFrame | null = null

/*
 * TELEMETRY.
 *
 * `RaceTelemetry` lives on `HarnessAPI`, not on `IRace`, and this is why: the
 * counters it needs are spread across four subsystems. Drift attempts and tiers
 * come from `kart/` via events, respawns and wall hits from `game/`, lap times
 * from the standings, and position from the track. Nobody but the composition
 * root can see all of them, and asking one subsystem to collect the others'
 * numbers would be exactly the cross-subsystem coupling the contract exists to
 * prevent.
 *
 * It accumulates from the event bus, which is also a live check that the events
 * are actually being emitted — a kart that drifts without emitting `drift:start`
 * shows up here as a ladder that never fires, and §10c criterion 2 is what
 * catches it.
 */
interface Counters {
  driftAttempts: number
  driftReleases: [number, number, number, number]
  boostSecondsBySource: Record<BoostSource, number>
  respawns: number
  wallHits: number
  bestProgress: number
  ticksWithoutProgress: number
}

function newCounters(): Counters {
  return {
    driftAttempts: 0,
    driftReleases: [0, 0, 0, 0],
    boostSecondsBySource: { none: 0, drift: 0, pad: 0, item: 0, slipstream: 0 },
    respawns: 0,
    wallHits: 0,
    bestProgress: -Infinity,
    ticksWithoutProgress: 0,
  }
}

const counters: Counters[] = karts.map(newCounters)
let telemetrySinceTick = 0

function countersFor(kartId: number): Counters | null {
  const i = karts.findIndex((k) => k.identity.id === kartId)
  return i < 0 ? null : counters[i]!
}

events.on('drift:start', (p) => {
  const c = countersFor(p.kartId)
  if (c) c.driftAttempts++
})
events.on('drift:release', (p) => {
  const c = countersFor(p.kartId)
  if (c) c.driftReleases[p.tier]++
})
events.on('boost:start', (p) => {
  const c = countersFor(p.kartId)
  if (c) c.boostSecondsBySource[p.source] += p.seconds
})
events.on('kart:respawn', (p) => {
  const c = countersFor(p.kartId)
  if (c) c.respawns++
})
events.on('kart:wall', (p) => {
  const c = countersFor(p.kartId)
  if (c) c.wallHits++
})

const telemetryLocation: TrackLocation = {
  t: 0,
  lateral: 0,
  height: 0,
  onTrack: true,
  checkpointIndex: 0,
}

const idleFrame: InputFrame = {
  steer: 0,
  throttle: 0,
  brake: 0,
  drift: false,
  useItem: false,
  look: 0,
}

function driverFrame(index: number, step: number): Readonly<InputFrame> {
  const slot = drivers[index]!
  switch (slot.mode) {
    case 'human':
      return scriptedInput ?? input.frame
    case 'scripted':
      return scriptedInput ?? idleFrame
    case 'referenceAI':
      slot.ai.mode = aiDrift === 'clean' ? 'clean' : 'drift'
      return slot.ai.step(step)
    case 'idle':
    default:
      return idleFrame
  }
}

/*
 * THE STARTING LIGHTS. Found by a human pressing START, not by a harness.
 *
 * `driverFrame` above was handed straight to `IKart.step` on every tick with no
 * reference to `IRace.phase`, so the player could drive during 3-2-1 and so
 * could the seven reference AI karts. Measured by `tools/grid-start.mjs` on the
 * build before this function existed: the field covered 17.8 m and reached
 * 11.9 m/s BEFORE GO.
 *
 * IT TAKES TWO CHANGES TO HOLD A STANDING START AND THIS IS ONLY ONE OF THEM.
 * Stopping the input is not enough on its own, because momentum the karts
 * already had carries straight through the countdown: with this gate alone the
 * field still coasted 2.605 m and peaked at 1.07 m/s before GO. The other half
 * is `game/race.ts:start`, which establishes the grid when the race begins;
 * together they measure 0.000 m. Neither is redundant and removing either one
 * brings the creep back.
 *
 * WHY HERE. The gate is a cross-subsystem rule — `game/`'s race phase deciding
 * what `kart/` is allowed to receive — and the contract bans a `src/game/`
 * import into `src/kart/` for exactly that shape of coupling. `src/main.ts` is
 * the only composition root, it already owns update order, and `race` is one of
 * the objects it assembled. Inside `IKart.step` this would give every kart
 * implementation a dependency on race policy; inside `game/ai.ts` it would gate
 * the AI and leave the human ungated, which is the same bug with fewer symptoms.
 *
 * 'countdown' AND ONLY 'countdown'. THE OTHER THREE PHASES ARE NOT THIS BUG, AND
 * GATING THEM COSTS MORE THAN IT BUYS.
 *
 *   'idle' — the first version of this gate DID hold input here, on the argument
 *     that a field driving away before anybody presses START is the same defect
 *     and makes the grid's state depend on how long the machine took to boot the
 *     page. That argument is real. It is outweighed: every measuring harness in
 *     this repo drives a kart in whatever phase the game happens to be in, and a
 *     gate here turns a probe that drove into a probe that measured a parked
 *     kart AND REPORTED NO ERROR. It cost another agent a live investigation
 *     before this comment was written. That is the identical failure the
 *     `releaseInput` note ninety lines below is about — a harness reading a
 *     confident 0.0000 against a subsystem that was working perfectly — and
 *     re-creating it one commit later in a different file is not a trade worth
 *     making for a cosmetic improvement to the attract screen. What the grid
 *     actually costs in 'idle' is measured and printed by `grid-start.mjs`, and
 *     `grid-karts` asserts the field is still exactly on its slots.
 *
 *   'finished' — nobody has reported it, no harness has measured it, and
 *     freezing eight karts on the instant the last one crosses the line is a
 *     GAMEPLAY decision about what the results screen looks like, not a bug fix.
 *     It also carries the same silent-freeze hazard as 'idle' for any future
 *     harness that measures after a race. Left alone deliberately.
 *
 *   'racing' — the phase a kart is supposed to be driven in.
 *
 * 'scripted' BYPASSES THE GATE, and that is not an exception to the rule so much
 * as what the rule is about. `DriverMode` 'scripted' exists solely so a harness
 * can seize the controls, and `HarnessAPI.setInput` is documented as switching
 * the player into it. A caller who has explicitly taken the wheel being silently
 * overridden by race phase is a trap, not a safety feature: it produces exactly
 * the reading — commanded full throttle, zero metres, no error — that this
 * project keeps paying to discover. The gate's job is the player's KEYBOARD and
 * the AI drivers, which are the two paths that actually had the bug, and both
 * are still gated. `tools/grid-start.mjs` proves it on those paths because it
 * presses START and never calls `seek()` or `setInput()`.
 *
 * NO ROCKET START. The gate means "the countdown holds the field" and nothing
 * more: no charge accumulates and no held throttle is banked. A player still
 * holding throttle at GO gets full throttle on the first racing tick anyway,
 * because that tick reads `input.frame` normally — so the simple rule already
 * produces the only launch behaviour the code implies, and a launch-timing
 * mechanic would be a feature, not this fix.
 *
 * ONE TICK OF LAG, AND IT IS DELIBERATE. `race.fixedUpdate` runs in the
 * subsystem loop BELOW the kart loop, so on the tick the countdown expires the
 * karts have already stepped against phase 'countdown' and input starts on the
 * NEXT tick. That is one SIMULATION_STEP, it is identical on every machine, and
 * closing it would mean stepping `race` before the karts — which reverses the
 * order the contract fixes ("input -> kart physics -> race -> items -> camera")
 * and would compute standings from where the karts were last tick.
 */
function inputReachesKart(index: number): boolean {
  if (race.phase !== 'countdown') return true
  return drivers[index]!.mode === 'scripted'
}

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

/*
 * THE VANTAGES — ART_DIRECTION §11.
 *
 * Ten fixed camera positions, so a score from round 7 is comparable with one
 * from round 3. They were the last thing standing between `energy-check.mjs`
 * and covering anything: it has reported "10/10 vantages PENDING" every run
 * since it was written, and a gate covering nothing prints the same green as a
 * gate that passed.
 *
 * `t` values come from §1's section table. Each is placed on the racing line so
 * the shot is what a driver actually sees, not an aerial nobody will ever look
 * at.
 */
interface Vantage {
  readonly t: number
  /** Metres above the road surface. */
  readonly height: number
  /** Arc-length fraction to look ahead by. Negative looks back. */
  readonly ahead: number
  /** Extra lateral offset from the racing line, metres. */
  readonly lateral?: number
}

const VANTAGES: Readonly<Record<VantageName, Vantage>> = {
  grid: { t: 0.015, height: 1.9, ahead: 0.012 },
  'dune-sweep': { t: 0.17, height: 2.4, ahead: 0.02 },
  'strata-wall': { t: 0.29, height: 2.2, ahead: 0.014 },
  'slot-narrows': { t: 0.4, height: 2.1, ahead: 0.012 },
  'mesa-crest': { t: 0.53, height: 3.2, ahead: 0.03 },
  'banked-wall': { t: 0.63, height: 2.3, ahead: 0.016 },
  'wash-descent': { t: 0.76, height: 2.6, ahead: 0.022 },
  'arch-interior': { t: 0.9, height: 2.2, ahead: 0.012 },
  'arch-exit': { t: 0.985, height: 2.2, ahead: 0.014 },
  'drift-tier3': { t: 0.3, height: 1.8, ahead: 0.01, lateral: 2.5 },
}

let detachedVantage: Vantage | null = null
const vantageAhead = makeSample()
const vantageLook = new Vector3()

function applyVantage(v: Vantage): void {
  track.sample(v.t, camHere)
  track.sample(v.t + v.ahead, vantageAhead)

  cameraPath
    .copy(camHere.position)
    .addScaledVector(camHere.right, track.racingLine(v.t) + (v.lateral ?? 0))
    .addScaledVector(camHere.normal, v.height)
  camera.position.copy(cameraPath)
  camera.up.copy(camHere.normal)

  vantageLook
    .copy(vantageAhead.position)
    .addScaledVector(vantageAhead.right, track.racingLine(v.t + v.ahead))
    .addScaledVector(vantageAhead.normal, v.height * 0.6)
  camera.lookAt(vantageLook)
}

const loop = createLoop({
  /*
   * The order here IS the contract, stated in its Composition section:
   *   input -> kart physics -> race -> items -> camera
   *
   * It is fixed by the root and not negotiable per subsystem, because a
   * subsystem that wants a different order is describing a data dependency it
   * should be reading from `GameServices` instead. Race after physics because
   * standings are computed from where the karts ended up; camera last because
   * it follows a kart that has already moved.
   */
  fixedUpdate(step: number): void {
    input.sample(loop.clock)

    for (let i = 0; i < karts.length; i++) {
      const command = driverFrame(i, step)
      /*
       * Record the COMMAND, not the outcome. This is what makes the steering
       * sign convention falsifiable — see HarnessAPI.lastInput.
       *
       * THE COMMAND IS RECORDED UNGATED, AND THE COUNTDOWN GATE IS APPLIED ONLY
       * TO WHAT REACHES `IKart.step`. The two differ for exactly the 360 ticks
       * of a countdown and the choice is deliberate in that direction:
       *
       *   - Recording the GATED frame would make `lastInput` report all zeros
       *     for every kart during the countdown, and a harness could then not
       *     tell "the driver commanded nothing" from "the driver commanded full
       *     throttle and the gate held it". The gate would be INVISIBLE from the
       *     harness surface, and an invisible gate is how the ungated version of
       *     it survived this long. It would also make `steer-test`'s ai-command
       *     check read a commanded steer of exactly 0.0000 against a working AI
       *     if it were ever run outside 'racing' — the precise failure the
       *     `releaseInput` note below exists to prevent, arrived by another road.
       *
       *   - Recording the DRIVER'S command keeps the field meaning what its name
       *     and its comment say, keeps the sign convention checkable in any
       *     phase, and makes the gate observable: throttle 1.0 against 0.00 m/s
       *     during a countdown is the gate working, and it is a reading a harness
       *     can assert on. `grid-start.mjs` states this where it prints it, so
       *     nobody reads it as a physics failure.
       *
       * The driver is therefore STEPPED during the countdown even though its
       * frame is discarded, which is the cost of the above and is what keeps the
       * reference AI's pursuit state continuous across GO rather than cold.
       */
      const record = lastFrames[i]!
      record.steer = command.steer
      record.throttle = command.throttle
      record.brake = command.brake
      record.drift = command.drift
      record.useItem = command.useItem
      record.look = command.look
      karts[i]!.step(step, inputReachesKart(i) ? command : idleFrame)
    }

    /*
     * `race` and `items` are stepped by their own `fixedUpdate` below, through
     * the subsystem loop. Calling `race.step` here as well ran the whole race
     * at double rate — the three-second countdown finished in 1.55 s, and every
     * lap time the project has recorded was against a clock running twice as
     * fast as the simulation. `camera.ts` guards this exact hazard with a
     * `lastFollowTick` check; nothing in `race.ts` did.
     */

    // Stall detection. `Standing.progress` is NOT monotonic — it decreases on a
    // reverse or a respawn — which is exactly why the contract carries
    // `bestProgress` separately and says it exists only for this.
    for (let i = 0; i < karts.length; i++) {
      const standing = race.standings.find((s2) => s2.kartId === karts[i]!.identity.id)
      const c = counters[i]!
      const best = standing?.bestProgress ?? -Infinity
      if (best > c.bestProgress) {
        c.bestProgress = best
        c.ticksWithoutProgress = 0
      } else {
        c.ticksWithoutProgress++
      }
    }

    const player = services.kartById(PLAYER_KART_ID)
    if (player) cameraRig.follow(player, step)
    for (const s of subsystems) s.fixedUpdate?.(step, ctx)
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
     * The camera rig owns the transform now — the scripted dolly that used to
     * live here is gone.
     *
     * `ICameraRig` is explicit that exactly one subsystem writes the camera and
     * everything else contributes an additive decaying channel. A dolly here
     * would be a second writer, and last-writer-wins between two of them is a
     * camera bug with no owner. `vantage()` parks the rig deliberately instead.
     */
    for (const s of subsystems) s.lateUpdate?.(SIMULATION_STEP, ctx)
    for (let i = 0; i < kartModels.length; i++) kartModels[i]!.update(karts[i]!.state, SIMULATION_STEP)
    if (detachedVantage) applyVantage(detachedVantage)
    sky.mesh.position.copy(camera.position)

    // The shadow frustum follows the camera; a fixed one centred on the origin
    // loses every shadow the moment the camera leaves the middle of the map.
    sun.position.copy(camera.position).addScaledVector(SUN_DIR, 240)
    sun.target.position.copy(camera.position)
    sun.target.updateMatrixWorld()

    renderer.render(scene, camera)

    if (firstFrameResolve) {
      document.getElementById('boot')?.setAttribute('hidden', '')
      firstFrameResolve()
      firstFrameResolve = null
    }
  },
})

loopRef = loop
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
  playerKartId: PLAYER_KART_ID,

  get track() {
    return track
  },
  get scene() {
    return scene
  },
  get camera() {
    return camera
  },

  lastInput(kartId: number): Readonly<InputFrame> | null {
    const i = karts.findIndex((k) => k.identity.id === kartId)
    return i < 0 ? null : lastFrames[i]!
  },

  async resetRace(options): Promise<void> {
    if (options?.totalLaps !== undefined && options.totalLaps !== race.totalLaps) {
      // A lap count baked in at construction cannot be changed without a
      // rebuild, and silently ignoring the request would make every gate that
      // asks for three laps measure whatever the default was.
      notYet(`resetRace({ totalLaps }) — race.totalLaps is fixed at ${race.totalLaps}`)
    }
    if (options?.seed !== undefined && options.seed !== seed) {
      notYet('resetRace({ seed }) — a new seed needs a full world rebuild')
    }
    aiDrift = options?.aiDrift ?? 'seek'
    for (let i = 0; i < drivers.length; i++) {
      const mode = options?.drivers?.[karts[i]!.identity.id]
      // The contract's default: referenceAI for every kart INCLUDING the player,
      // because a harness benchmark wants a full field of reference drivers.
      drivers[i]!.mode = mode ?? 'referenceAI'
      drivers[i]!.ai.reset()
    }
    scriptedInput = null
    detachedVantage = null
    race.reset()
    items.reset()

    // Put every kart back on its grid slot and zero the counters. Without this
    // a "reset" leaves the field wherever it was and the next run's telemetry
    // carries the previous run's drift attempts — a controlled comparison that
    // is not controlled.
    for (let i = 0; i < karts.length; i++) {
      karts[i]!.respawn(track.startGrid[i % track.startGrid.length]!.t)
      counters[i] = newCounters()
    }
    telemetrySinceTick = loop.clock.tick
    // Present one frame so the caller is looking at the reset world, not the
    // one before it.
    await loop.stepTicks(1)
  },

  startRace(): void {
    race.start()
  },

  setDriver(kartId: number, mode: DriverMode): void {
    const i = karts.findIndex((k) => k.identity.id === kartId)
    if (i < 0) throw new Error(`[harness] setDriver: no kart ${kartId}`)
    drivers[i]!.mode = mode
  },

  async vantage(name): Promise<void> {
    const v = VANTAGES[name]
    // Throw on an unknown name rather than silently no-op: a misspelling would
    // otherwise invalidate an entire review run and read as a pass.
    if (!v) throw new Error(`[harness] vantage: unknown name "${name}"`)
    detachedVantage = v
    await loop.stepTicks(2)
  },

  loadScenario: () => notYet('loadScenario'),

  /** PERSISTENT MERGE, per the contract: omitted fields keep their last value. */
  setInput(frame): void {
    const base = scriptedInput ?? { ...idleFrame }
    scriptedInput = { ...base, ...frame }
    const i = karts.findIndex((k) => k.identity.isPlayer)
    if (i >= 0 && drivers[i]!.mode !== 'scripted') drivers[i]!.mode = 'scripted'
  },

  /**
   * Releases the SCRIPTED OVERRIDE, and nothing else.
   *
   * This used to end `drivers[i].mode = 'human'` unconditionally, which made it
   * the exact hazard `seek` documents forty lines above and guards against: a
   * player left in a driver mode nobody asked for, reading a commanded steer of
   * exactly 0.0000 against a perfectly working AI. `seek` restores the mode it
   * found and then `steer-test` does this, which is the only ordering that
   * matters:
   *
   *     h.seek(...)                       // mode restored
   *     h.setDriver(pid, 'referenceAI')   // mode := referenceAI
   *     h.releaseInput()                  // mode := human   <- clobbered
   *
   * The AI was never asked for a frame, so `lastInput` reported the live
   * keyboard — all zeros in a headless run. Two gates went red on `game/` and
   * the defect was here, in `core`'s side of the harness surface.
   *
   * `setInput` is documented in the contract as switching the player to
   * `'scripted'`; the symmetric release is therefore to undo THAT, not to
   * impose a third mode. An explicit `setDriver` outranks us — if the caller
   * put this kart under a driver, releasing scripted input must not take it
   * away. Only a player still sitting in `'scripted'` goes back to `'human'`.
   */
  releaseInput(): void {
    scriptedInput = null
    const i = karts.findIndex((k) => k.identity.isPlayer)
    if (i >= 0 && drivers[i]!.mode === 'scripted') drivers[i]!.mode = 'human'
  },

  injectInput: () => notYet('injectInput'),

  /*
   * `IKart` exposes no position or velocity setter, so this reaches the
   * requested state by DRIVING to it rather than by teleporting into it.
   *
   * That is slower and it is also more honest: a kart placed at 18 m/s by
   * assignment has whatever suspension compression and tyre load the assignment
   * happened to leave behind, and a harness measuring steering response off
   * that is measuring a state the physics never produces. Accelerating under
   * full throttle at a fixed timestep is deterministic and lands the kart in a
   * state the game can actually be in.
   *
   * Lateral offset still has no route. Reported as unavailable rather than
   * approximated, because a seek that silently lands somewhere else makes every
   * measurement taken from it wrong in a way nothing reports.
   */
  async seek(options): Promise<void> {
    const kart = services.kartById(PLAYER_KART_ID)
    if (!kart) notYet('seek — no player kart')

    /*
     * A seek sets up a CONTROLLED EXPERIMENT, so it has to control the whole
     * world and not just the one kart.
     *
     * The first version placed the player and left the other seven driving.
     * `steer-test.mjs` caught it immediately on its repeatability check — two
     * identical runs produced different numbers, because run two started from
     * wherever run one's AI field had got to. Every measurement downstream of a
     * non-repeatable initial condition is noise wearing a decimal point.
     *
     * It also forced the player into scripted mode and never restored it, which
     * is why the AI-command check read a commanded steer of exactly zero: the
     * AI was not driving anything.
     */
    const playerIndex = karts.findIndex((k) => k.identity.isPlayer)
    const playerMode = drivers[playerIndex]!.mode

    /*
     * Scatter the field around the lap and idle it — do NOT park it on the grid.
     *
     * Parking on the grid was the second version, and it was worse than leaving
     * the field alone: the grid sits at t ≈ 0.98 and the flattest straight the
     * harness picks for a steering test is t ≈ 0.007. Those are the same
     * fifteen metres of road. Seven idle karts were being teleported directly
     * on top of the kart under test, and the repeatability spread went to 24 m.
     *
     * Evenly spaced and idle keeps the physics running on a full field — which
     * is the state a real race is in — while guaranteeing nothing is anywhere
     * near the measurement.
     */
    for (let k = 0; k < karts.length; k++) {
      if (k === playerIndex) continue
      karts[k]!.respawn((options.t + k / karts.length) % 1)
      drivers[k]!.mode = 'idle'
    }

    kart.placeAt(
      options.t,
      track.racingLine(options.t) + (options.lateral ?? 0),
      options.speed ?? 0,
    )
    // Every driver's internal state now refers to a world that no longer exists
    // — a pursuit controller carrying a stale previous position and yaw rate
    // across a teleport produces a first command with no relationship to where
    // the kart actually is.
    for (const d of drivers) d.ai.reset()
    scriptedInput = { ...idleFrame }
    drivers[playerIndex]!.mode = 'scripted'
    await loop.stepTicks(1)

    /*
     * Restore the PLAYER's driver and leave the rest idle.
     *
     * A seek that silently leaves the player scripted makes the next AI
     * measurement read a commanded steer of exactly 0.0000 against a perfectly
     * working driver — which is how the AI-command check first came back red.
     * The field stays idle on purpose: a seek is a controlled experiment and
     * seven cars driving through it is not a control.
     */
    drivers[playerIndex]!.mode = playerMode
    scriptedInput = playerMode === 'scripted' ? scriptedInput : null
  },

  telemetry(): RaceTelemetry {
    const standings = race.standings
    return {
      sinceTick: telemetrySinceTick,
      tick: loop.clock.tick,
      phase: race.phase,
      clock: race.clock,
      karts: karts.map((kart, i) => {
        const c = counters[i]!
        const standing = standings.find((s) => s.kartId === kart.identity.id)
        track.locate(kart.state.position, telemetryLocation)
        const lapTimes = standing ? standing.lapTimes.slice() : []
        return {
          kartId: kart.identity.id,
          driftAttempts: c.driftAttempts,
          driftReleases: [
            c.driftReleases[0],
            c.driftReleases[1],
            c.driftReleases[2],
            c.driftReleases[3],
          ] as const,
          boostSecondsBySource: { ...c.boostSecondsBySource },
          respawns: c.respawns,
          wallHits: c.wallHits,
          lapTimes,
          bestLap: lapTimes.length > 0 ? Math.min(...lapTimes) : null,
          finished: standing?.finished ?? false,
          completedLaps: standing?.completedLaps ?? 0,
          lastCheckpoint: telemetryLocation.checkpointIndex,
          t: telemetryLocation.t,
          lateral: telemetryLocation.lateral,
          ticksWithoutProgress: c.ticksWithoutProgress,
        }
      }),
    }
  },

  kartSnapshot(kartId: number): Readonly<KartState> | null {
    const kart = services.kartById(kartId)
    return kart ? kart.state : null
  },

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
