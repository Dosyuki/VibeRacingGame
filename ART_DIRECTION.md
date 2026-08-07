# Neon Drift — Art Direction Bible

**This document is the canonical reference for all visual work.** It exists so that
agents who never see each other's output still produce a coherent frame. Where
taste conflicts with a number written here, the number wins.

No reference photographs are used anywhere in this project, deliberately. A
photo creates a match-the-reference failure mode that nobody can grade. A written
spec naming concrete values is verifiable, and composable across parallel work.

---

## 1. The Circuit: Kowloon Nine

A dense rain-slick night city at 2 a.m. Neon-saturated, tight, vertical. The lap
runs eight sections:

| Section | Progress | Character |
|---|---|---|
| Neon boulevard | 0.00–0.11 | Start straight, sign arch overhead, wide, wet mirror road |
| Market esses | 0.11–0.26 | Narrow alternating turns, hanging lanterns and awnings, low ceiling of signage |
| Underpass | 0.26–0.36 | **Dry** asphalt, sodium pools, two boost strips, sudden reflection loss |
| Elevated ramp | 0.36–0.48 | Climb out, city opens to the right, longest sightline on the lap |
| Rooftop hairpin | 0.48–0.58 | Highest point (+38 m), 170° turn, skyline below, rain visible falling *past* you |
| Tram descent | 0.58–0.70 | Fast downhill, tram rails crossed at 25°, metal grip trap |
| River bend | 0.70–0.86 | 18° banked 180°, black water reflecting the far bank |
| Glass tunnel | 0.86–1.00 | Lit tube, exit bloom, back onto the boulevard |

**Geometry:** ~1480 m centreline, 8–12 m half-width, elevation 0–38 m, no flat
run longer than 110 m.

**Why night works here, and the trap it brings.** A wet road reflects every sign
above it, so the track reads as a bright ribbon against dark surroundings — night
makes the racing line *more* legible than daylight would, not less. The trap is
the opposite failure: an environment made of emitters plus bloom trends toward a
white screen. §8 turns that from a matter of taste into a measured gate.

---

## 2. Lighting: 2 a.m., Rain, No Sun

There is no key light in the sky. The city is the key light. Everything below
keys off that inversion.

**Moon (rim only, never the key):**
- Direction: `normalize(0.35, 0.62, 0.70)`
- Colour `#a8c0ff`, intensity 0.55 — enough to separate rooflines from sky, no more
- Casts the only real shadows in the scene

**Sky:**
- Zenith `#05060f`
- Mid `#131034`
- Horizon light-pollution glow `#3a2258`, lifting to `#4d2a4f` behind the skyline
- Computed as a gradient plus noise-driven cloud underlighting, not a texture

**City ambient:**
- Hemisphere fill from below, warm `#2a1636`, intensity 0.35 — the ground glow
  that makes undersides of overpasses readable
- No flat ambient term anywhere. If a surface is lit, something in the scene lit it.

**Emissive sources (these are the key light):**
- Sign panels, tube lettering, window grids, vehicle lights
- ~40 significant emitters visible at once, of which at most 6 are point lights
  that actually cost anything; the rest are emissive materials plus baked-in
  reflection contribution

**Fog:**
- Exponential-squared, colour `#180f2e`, density 0.0125
- Aerial perspective is what separates the eight visible building layers on the
  rooftop hairpin. It is mandatory, not optional.

**Rain:**
- Falling streaks, camera-space, density scaled by quality tier
- Road ripple normals: two scrolling octaves plus impact rings
- Rain is visible *against dark surfaces only* — it must never wash the frame

**Post-process:**
- ACES tonemapping, exposure 1.15
- Bloom threshold 0.82, intensity 0.55, radius 0.62
- Colour grade: cool shadows lifted toward `#1a1030`, highlights held neutral
- Saturation 1.15 with a highlight desaturation rolloff — without the rolloff,
  every neon sign blows to a flat magenta blob
- Vignette 0.26
- Chromatic aberration 0.0015 at frame edges, scaling with speed
- Motion blur on `high`/`ultra` only

---

## 3. Colour

Never ship pure `#000000` or `#ffffff` as albedo. Every surface carries hue.

### 3a. Environment palette

| Element | Hex | Notes |
|---|---|---|
| Road (wet) | `#14141c` | roughness 0.12, near-mirror |
| Road (dry, underpass) | `#26262e` | roughness 0.55 |
| Puddle | `#0d0d14` | roughness 0.03, reflection strength 1.0 |
| Lane paint | `#c8ccd8` | worn, roughness 0.4 |
| Kerb stripe A | `#e0453f` | emissive 0.25 |
| Kerb stripe B | `#f2ece0` | emissive 0.25 |
| Tram rail | `#8a8f9c` | metalness 1.0, roughness 0.22 |
| Building base | `#171a26` | |
| Building accent | `#232839` | |
| Concrete | `#2b2f3c` | |
| Water (river) | `#070a14` | roughness 0.05 |
| Neon magenta | `#ff2d95` | |
| Neon cyan | `#00e5ff` | |
| Neon violet | `#8b3dff` | |
| Neon amber | `#ffa424` | sodium lamps, underpass |
| Sign white | `#e8f4ff` | never `#ffffff` |

### 3b. Reserved gameplay band — the most important rule in this file

The environment is built from **magenta, cyan, violet and amber**. Therefore
gameplay feedback may use **none of them**. Drift sparks in cyan would vanish
into a cyan-lit street, and the player would lose the one signal the whole game
is built on.

**Reserved exclusively for gameplay feedback. Never appears on any environment
surface, sign, or light:**

| Signal | Hex | Where |
|---|---|---|
| Drift tier 1 | `#6cff5a` lime | sparks, rim glow on kart |
| Drift tier 2 | `#ffc61a` gold | sparks, brighter rim |
| Drift tier 3 | `#fffbe6` white core, `#b6ff3d` corona | sparks, full chassis rim |
| Boost flame | tier colour of the drift that earned it | exhaust plume |
| Item pickup | `#6cff5a` → `#ffc61a` roulette | HUD only |

A reviewer finding any of these three hues on a building, sign or lamp is
reporting a defect, not a preference.

---

## 4. Materials (Procedural PBR only)

Everything generates in code at load. No external texture, model, font or audio
file exists in this repository. Each material needs albedo, normal and roughness;
AO where it earns its cost.

- **Resolution:** 1024² within 5 m of camera, 512² beyond, 256² on `low`
- **Anisotropy:** `min(8, maxAnisotropy)` on road surfaces
- **Roughness must vary spatially.** Uniform roughness reads as plastic and is a
  §9 amateur tell. Wet road especially: puddle edges, tyre-worn dry lines through
  the racing line, drain streaks.
- **UVs:** triplanar or correctly tiled with a second-octave break so no tiling
  is visible in any frame
- **Never apply one scalar uniformly across materials that are not uniform.**
  Environment map intensity, emissive strength and clearcoat are per-material,
  resolved through a single accessor so a global override is impossible to write
  by accident. One flat `envMapIntensity` is enough to silently delete every
  reflection in the game, and nothing about the frame says why.

**Wet road specifically** — this is the signature material of the project:
- Base `#14141c`, metalness 0.0, roughness 0.12
- Clearcoat 1.0, clearcoatRoughness 0.08
- Screen-space reflection on `high`/`ultra`; a mirrored-probe fallback below
- Roughness map breaks the mirror along the racing line (tyre-dried strip) and
  raises it under the tunnel
- Puddles are a mask, not geometry, and they must move with the noise field, not
  the camera

**Kart bodywork:**
- Painted `metalness 0.0, roughness 0.26`, clearcoat 1.0 / 0.06
- Chrome trim `metalness 1.0, roughness 0.15`, environment-mapped
- Underglow strip in the livery colour, `#`-per-racer, emissive 1.4

---

## 5. The Kart

Chunky and toy-like. Not a realistic go-kart.

- Wheel radius ~0.34 m against body length 2.0 m — deliberately oversized
- 6–12 k triangles
- **Every edge chamfered.** A hard 90° edge catches no light and fails the
  silhouette test at night, where edge highlights are the only readable cue.
- Visible driver, helmet, hands tracking the wheel
- Exhaust stacks, roll bar, bevelled bumper
- Wheels steer and spin; per-wheel suspension travel
- Body rolls into corners, pitches under brake and throttle
- Driver leans and counter-steers into a drift
- Kart hops on drift entry — this is the tell that the drift *took*
- Eight liveries, each with secondary trim and a procedural decal

---

## 6. Feedback Layer — the game is in here

An arcade racer is its feedback layer. Every effect below must read within one
frame of the event that caused it. All use the §3b reserved band.

**Drift:**
- Hop and a chassis-roll snap on entry
- Sparks from both rear wheels, additive, bright core plus soft corona
- Tier change fires a flash, a burst, and an audible step — a player must know
  their tier without looking at the HUD
- Wet-road scorch decal is a *water displacement* streak here, not a burn mark
- Rim light on the kart brightens with tier, so tier is readable on the vehicle
  itself even when sparks are off-screen

**Boost release:**
- Flame plume in the tier colour
- Radial speed lines
- FOV punch (+8° over 120 ms, decaying over 400 ms)
- Chromatic aberration ramp, motion blur step
- Shockwave ring on the wet road, displacing the reflection
- The release must be unmistakable at a glance and must produce a **measurable**
  lap advantage — see §9c

**Environmental:**
- Water spray from tyres, scaled by speed and surface wetness
- Dust on gravel, sparks on metal rails and kerbs
- Speed lines above 70% top speed, framing the view, never obscuring it
- Headlight cones through rain; volumetric shafts at the tunnel mouth

**Impact:**
- Screen shake, star ring, chassis squash-and-stretch

---

## 7. HUD

Readable at a glance, animated with cubic easing, generous safe-area margins.

- **Top-left:** lap `1/3`, large numeral, flash on completion
- **Top-right:** race timer, tabular numerals, no width jitter
- **Bottom-left:** item box with roulette spin and settle bounce
- **Bottom-right:** speedometer — analogue arc, needle with slight overshoot, digital readout
- **Left-centre:** position, large, ordinal suffix, punch on change
- **Bottom-centre:** minimap tracing the true circuit path, player as a large dot, rivals in livery colours
- **Countdown:** 3 / 2 / 1 / GO! scale-and-fade, full-screen flash on GO
- **Typography:** no default browser font. Explicit system stack, explicit weights,
  letter-spacing and tabular numerals. Every string needs an outline or drop
  shadow — this frame has bright neon behind arbitrary parts of the screen.

---

## 8. Performance & Energy Budget

**Target:** 60 fps at 1080p on an RTX 4050 laptop GPU at `Quality.High`.

- ≤ 250 draw calls per frame
- Instance every repeated element: windows, signs, railings, crowd, kerbs, rain
- Frustum culling; LOD beyond 60 m
- Particles pooled and instanced; zero allocation in any per-frame path
- No `new Vector3()` inside `update()` — module-scope scratch objects only
- Quality tiers per `QualityProfile` in `src/types.ts`; `low` must hold 30 fps on
  a mid-range phone with texture memory under 40 MB

**Additive energy budget — measured, not judged.** A city of emitters plus bloom
walks toward a white screen one commit at a time, and no single change looks
wrong. So it is a number:

| Metric | Limit | Where measured |
|---|---|---|
| Mean frame luma | ≤ 0.42 | every §10 vantage |
| Clipped pixels (luma ≥ 0.99) | ≤ 3.0% | every §10 vantage |
| Clipped pixels, worst case | ≤ 6.0% | tier-3 boost + tunnel exit, simultaneously |
| Frame luma std-dev | ≥ 0.11 | every §10 vantage — a flat frame fails even if dark |

The worst case is a real test, not a hypothetical: stacking a tier-3 boost
release against the tunnel exit is the brightest reachable state in the game and
`tools/energy-check.mjs` drives the game into it on purpose.

---

## 9. Review Rubric

### 9a. Calibrated bands

Scores are anchored. A reviewer who grades generously produces a worse game,
because the loop stops improving the moment the number says it is finished.

| Band | Meaning |
|---|---|
| 0–40 | Programmer-art prototype |
| 40–60 | Competent hobby project |
| 60–75 | Good indie game; still clearly not first-party |
| 75–88 | Near-professional |
| 88–95 | Shipped-AAA quality |
| 95–100 | Best in class; reserve for work that redefines the category |

State the band name alongside the number in every review. A score without its
band is not a review.

### 9b. Frame criteria — a frame passes when all seven hold

1. **Silhouette & composition** — readable at thumbnail size
2. **Lighting narrative** — clear key/fill/rim separation from *scene* sources;
   warm/cool contrast; no flat ambient; nothing lit by nothing
3. **Material diversity** — ≥5 visibly distinct surface responses, each with
   spatially varying roughness
4. **Grounding** — contact shadows and AO under every object; the wet road must
   show a reflection of anything standing on it. Nothing floats.
5. **Depth layering** — foreground, midground, background all present; fog
   separates the planes
6. **Amateur tells absent** — no visible UV tiling, no z-fighting, no unchamfered
   edges, no uniform roughness, no crushed-black shadows, no sky banding, no
   aliasing crawl on thin geometry (railings and sign poles are the risk here),
   no reserved-band hue (§3b) on an environment surface
7. **Motion & energy** — the frame reads as active play, not a parked screenshot

### 9c. Gameplay criteria — a screenshot cannot judge these

Scored from harness output only. A critic looking at a PNG must not score this
section; it has no access to the evidence.

1. **Drift pays.** A drifting lap is measurably faster than a clean lap, by a
   margin exceeding the run-to-run noise floor by at least 4×.
2. **The ladder is reachable.** ≥60% of drift attempts by the reference AI bank
   at least tier 1; ≥25% reach tier 3.
3. **Steering is honest.** `steer > 0` moves the kart right, for player and AI.
4. **The race completes.** Every kart finishes three laps unattended, with no
   respawn loop and no kart stuck on a wall.
5. **Input is prompt.** Touch and keyboard steer latency under 50 ms, measured
   with stun frames excluded.
6. **It survives a phone.** No context loss, no memory kill, over a full race.

---

## 10. Vantage Points

Fixed camera positions. Every screenshot review and every energy measurement
uses these, so scores are comparable across rounds. `__harness.vantage(name)`
parks the camera; the seed is pinned, so the frame is reproducible.

| Name | What it must prove |
|---|---|
| `grid` | Kart detail, chamfers, livery, wet reflection under the vehicle |
| `boulevard` | Sign density, depth layering, the road-as-ribbon read |
| `market` | Narrow-space readability, hanging clutter, no tiling on close walls |
| `underpass` | The dry/wet transition, sodium colour shift, reflection loss |
| `ramp-vista` | Longest sightline, aerial perspective, skyline layer separation |
| `hairpin` | Elevation read, rain falling past camera, city below |
| `tram` | Metal rails, specular anisotropy, crossing angle legibility |
| `river-bank` | Banked road, water reflection, horizon separation |
| `tunnel-exit` | Bloom control at the brightest transition in the lap |
| `drift-tier3` | Reserved-band sparks against neon background; the §3b proof |

---

**This document is law.**
