# Vermilion Nine — Art Direction Bible

**This document is the canonical reference for all visual work.** It exists so that
agents who never see each other's output still produce a coherent frame. Where
taste conflicts with a number written here, the number wins.

No reference photographs are used anywhere in this project, deliberately. A
photo creates a match-the-reference failure mode that nobody can grade. A written
spec naming concrete values is verifiable, and composable across parallel work.

Every mesh, material, sound and gradient is generated in code at load time. There
is no texture file, no model file, no font file and no audio file in this
repository, and there never will be. Nothing below may be specified in a way that
only an authored asset could satisfy. Layered noise is superb at sedimentary
strata, dune ripple, scree and wind-scour; it is hopeless at signage, insignia
and machined logos, so this circuit contains none of those.

---

## 1. The Circuit: Vermilion Nine

A desert canyon circuit an hour before sundown. Red rock, layered cliffs, open
sand, one high banked wall, and shadows nearly five times as long as the things
casting them. The lap runs eight sections:

| Section | Progress | Character |
|---|---|---|
| Hardpan grid | 0.00–0.11 | Start straight on dark compacted tarmac, sun raking in from behind-left, kart shadows thrown 4.7× ahead across the road |
| Dune sweep | 0.11–0.23 | Fast open right-hander, sand shoulders both sides, ripple sheen at grazing incidence, soft trap outside the line |
| Strata esses | 0.23–0.35 | Alternating turns cut into a 34 m cliff face; six rock bands run horizontally through frame, gypsum seam at eye height. **The middle turn is banked 10°** — the slowest corner on the lap, see below |
| The Slot | 0.35–0.44 | **Canyon narrows.** Half-width collapses to 4.6 m over 92 m, walls 26 m, sky reduced to a 9° strip, lit almost entirely by bounce |
| Mesa climb | 0.44–0.57 | Climb to +52 m, longest sightline on the lap, five silhouette layers receding into haze |
| The Wall | 0.57–0.69 | **20° banked 180°**, radius 74 m, ramp-in 40 m / sustained 145 m / ramp-out 35 m; horizon rolls 20° through the corner |
| Wash descent | 0.69–0.83 | Fast downhill on a dry riverbed, sand over tarmac, two surface-change bands, loose gravel outside |
| Arch tunnel | 0.83–1.00 | **Natural rock arch, 118 m.** Three collapse skylights throw hard shafts across the road; exit fires straight into the low sun |

**Geometry:** 1620 m centreline, half-width 4.6–13.0 m, elevation 0–52 m. No
straight longer than 145 m. **Exactly two corners are banked and no others: The
Wall at 20°, and the middle turn of the strata esses at 10°.** Gradient never
exceeds 8% up or 11% down.

**Why the second banked corner exists, and what it costs.**

This line used to read "bank is 0° everywhere except The Wall", and The Wall's
bank being the only one on the circuit was part of what The Wall was. That is
now false and the paragraph below is what replaces it, because a rule in this
document that contradicts the circuit gets "fixed" eventually and there is no
telling in which direction.

The middle esse — 66 m, turning 79.5° right, half-width 11.3 m — is the slowest
corner on the lap, and it was slower than its own geometry admitted to. The
numbers, all measured rather than chosen:

- The chassis holds **7.88 m/s² of sustained lateral**, brakes at 9.2 m/s² and
  tops out at 27.8 m/s, on a validated flat-plane bench.
- The corner's **centreline** radius is 47.6 m. Flat, that is 19.1 m/s: a slow
  corner, but an ordinary one, and it is the number the section table implies.
- The radius a player actually drives is **40.6 m**, 15% tighter. The ideal line
  is derived by minimising Σκ², and a sum-of-squares objective buys two nearly
  straight corners by making a third one tighter — 3k² beats 1·(2k)². Across the
  esses it does exactly that: line radius against centreline radius runs 72 → 268,
  **48 → 41**, 98 → 264. §5a paints the rubber lay-down along that line, so the
  tightest radius on the circuit is also the one the road invites you onto.
- Flat, 40.6 m is **17.5 m/s**. That is 1.6 m/s slower than anything else on the
  lap and 1.6 m/s below what the geometry table says the corner is.

**What 40.6 m does and does not bound, because the difference was measured and
overstating it would be the same error as the centreline.** It is the radius of
the line the circuit *paints*, confirmed by two independent estimators. It is not
a floor on what a driver can do. Driven in the game, a kart that runs 1.6 m off
that line — still on tarmac, inside wheels on the kerb — smooths the line's short
curvature spike into an **82 m** arc and carries **21.8 m/s** through the corner
with no bank at all. So 17.5 m/s bounds the painted line and not the corner, and
the strongest reading of the 40.6 m figure is that the *line* is wrong at the
esses, which is a separate change nobody has made. The bank is not a substitute
for it: it raises the limit of whatever line is driven, by 21%, and it is worth
having either way.

**10° raises it to 21.6 m/s**, and the corner keeps its job: it is still the
slowest on the circuit and still needs 24 m of threshold braking off the 27.8 m/s
the line carries out of the first esse — it was 33 m before, so the brake point
moved 10 m later rather than disappearing. The ceiling on the angle is the
first esse, whose own limit is 23.8 m/s — banking the middle one past that moves
the bottleneck onto a corner nobody has asked to change, so it buys nothing. 10°
sits under that with headroom, and it is **exactly half of The Wall's 20°**.

**What is honestly lost.** The Wall's bank is no longer singular. Some of that
section's identity was "this is the banked corner", and a second banked corner
spends part of it. Two things keep the difference real and neither is a matter of
taste: the angle is 2:1, and the cross-slope across the road is **10.3 m on The
Wall against 4.0 m on the esse**, 2.6:1, because The Wall is also 3.7 m wider on
each side. The Wall remains the only place the horizon rolls far enough to be the
subject of the shot, and §11 `banked-wall` remains the only vantage that grades a
bank.

**They must not read as the same feature, and this is a requirement on
`world/` and `render/`, not something §1 can implement.** The Wall is a *built*
bank: its outer edge stands free against sky and the road is carried on it. The
esse must be a *cambered road*: its outer edge is buried in the cliff foot and
the talus, so the road reads as leaning into the rock rather than as a wall
rising out of the desert. If a frame at the esse is ever mistaken for a frame at
The Wall, that is a defect report against this paragraph.

**One limit worth stating so it is not rediscovered as a bug.** A 10° twist needs
20 m of ramp at each end to stay inside the 0.02 rad/m continuity gate, and the
corner is only 66 m long, so the sustained bank is 22 m. That plateau cannot
cover the corner's 48 m constant-radius section, and a driver holding the middle
of the road therefore gains only 19.1 → 20.0 m/s. Covering the centreline
properly would need ramps of 9 m, which caps the bank at 5.1° and buys 19.3 m/s —
worse for everybody. The bank is sized for the line the game paints because at
this length there is no arrangement that serves both.

**Why a low sun works here, and the four traps it brings.**

A 12° sun does the racing line's job for it. The road is a dark ribbon at luma
~0.27 laid on sand at luma ~0.65, and every vertical thing in the world paints a
long hard shadow across it, so the track is legible by value alone before a
single marking is drawn.

A desert also fails in four predictable ways. Each is answered with a number.

**Trap 1 — large areas of similar hue.** Rock, sand, haze and low sun all sit
between hue 15° and 45°. Left alone the frame is a monochrome orange wash.

- **Shadows are blue, not dark orange.** Shadowed sand is `#9fa4b8` (hue 228°),
  sunlit sand is `#e3c893` (hue 40°). A **188° hue split inside the ground plane
  itself**, occurring at every shadow edge — and a 12° sun guarantees those edges
  are everywhere.
- **Shadow occupancy floor.** At every §11 vantage except `arch-exit`, ≥ 22% of
  ground-plane pixels must be in cast shadow. Geometry that fails this gets more
  vertical mass, not a darker grade.
- **Sky occupancy floor.** ≥ 12% of frame is sky at all vantages except
  `slot-narrows` and `arch-interior`, exempt by design.
- **The gypsum seam.** One pale band `#d8bfa0` at 41% cliff height, 0.9–1.6 m
  thick, runs the whole circuit. It is the value break that stops a cliff reading
  as one brown thing.

**Trap 2 — flat, midday lighting.** Solved by refusing to have a midday sun.
Elevation is **12°**, fixed; time does not advance. Shadow length is
`height / tan(12°)` = **4.70× object height**, a testable property rather than a
look. There is no flat ambient term anywhere in this project.

**Trap 3 — uniform sand.** A single-material ground plane is the fastest way to
look like programmer art. Sand is built from four independent fields:

- Dune-scale height noise, wavelength 22 m, amplitude 1.8 m
- Ripple normals, wavelength 0.34 m, amplitude 0.012 m, aligned to a wind vector
  of azimuth 71° constant across the whole map
- A compaction field driving albedo `#e3c893` → `#c2a271` and roughness
  0.95 → 0.78, densest in the wash floor
- Instanced pebble scatter, 3 LODs, 4.5/m² near the line falling to 0.6/m² beyond 40 m

Plus the **sheen** term (§5b). Sand without grazing sheen reads as cardboard and
no amount of albedo variation fixes it.

**Trap 4 — repeating rock silhouettes.** Instancing is mandatory (§9) and
instancing is exactly what produces a skyline of clones.

- Mesa silhouettes come from a seeded profile generator with 9 parameters. A
  profile may be reused only if the reuse is **≥ 55° away in view azimuth**,
  ≥ 180 m further in depth, and differs in apparent height by ≥ 18%.
- No two adjacent mesa layers share a cap height within 8%.
- Graded at `mesa-crest`: **≥ 5 depth layers, ≥ 7 distinct profiles, zero visible
  pairs.**

---

## 2. Lighting: 12° Sun, Clear Air, Dust Below

One dominant key from a very low angle, a strong blue sky fill, and a warm bounce
off the west-facing cliffs.

**Sun (the key — this is the whole scene):**
- Direction (surface → sun, normalized): `normalize(-0.300, 0.208, -0.930)` —
  elevation 12.0°, azimuth 198°
- **The azimuth is a geometric constraint, not a preference.** At 12° every
  shadow is 4.70× its caster, so a 25 m canyon wall throws 118 m — wider than the
  gorge. With the sun crossing the canyon the floor is in permanent shadow and
  §3b's premise, a dark road ribbon lit against bright sand, is simply
  unreachable. The sun runs down the axis, which is what real canyon photography
  does and for the same reason. Any section whose heading turns more than ~35°
  off this axis must either open out, drop its walls, or accept being a
  bounce-lit section like The Slot and be graded as one.
- Colour `#ffb46b`, intensity **4.2**
- Angular diameter 0.53°; contact-hardening penumbra required (§9c)
- Casts every shadow in the scene. There is no second shadow caster.

**Sky fill (what makes shadows readable, and blue):**
- Hemisphere light, sky `#86b4e8`, ground `#d9a068`, intensity **0.55**
- This is the term producing the 188° ground-plane hue split of Trap 1. Lowering
  it to "deepen" shadows destroys the counter-measure. Do not.

**Cliff bounce (warm, weak, directional):**
- Direction `normalize(0.742, 0.139, 0.656)`, colour `#e08a4e`, intensity **0.35**,
  casts no shadow
- Inside The Slot and the arch it is the dominant light, and it is why those
  sections are readable at all.

**Sky dome (procedural gradient plus noise, never a flat colour):**
- Zenith `#3f77c4`, mid `#7fb0e0`, anti-sun horizon `#b9c9d8`
- Sun-side horizon glow `#ffb463`, tightening to `#ffd9a0` within 14° of the sun
- **The horizon glow hue is clamped to 20°–45°. The sky may never go pink or
  magenta, at any elevation.** At a 12° sun this is physically correct, and it is
  what keeps the §4 reserved band safe. A pink horizon is a defect report.
- The gradient runs horizontally as well as vertically — hot toward the sun, deep
  blue opposite. A radially symmetric sky makes the sun direction unreadable and
  no amount of colour retuning fixes it.
- **Mandatory ≥ ±2 code values of blue-noise dither.** This is not decoration; it
  is what keeps the §9b flat-tile detector from firing on a correct sky. See §9b.

**Shadow cascades (4, tuned for a 4.70× shadow length):**

| Cascade | Range | Purpose |
|---|---|---|
| 0 | 0 – 18 m | Kart, kerbs, contact shadows, driver |
| 1 | 18 – 55 m | Track furniture, near rocks, rival karts |
| 2 | 55 – 160 m | Cliff shadows thrown across the road |
| 3 | 160 – 480 m | Mesa shadows on the open sand |

Cascade 3 is not optional — see §9c. Normal-offset bias 0.022, blend band 8%.
`low` collapses to 2 cascades at 0–24 m and 24–140 m.

**Fog and haze:**
- Exponential-squared, colour `#d8b892`, density **0.0025**
- Second layer: ground dust haze `#e6cba4`, top at y = 14 m, density 0.0031 below
  that plane, falling off over 5 m
- Distant mesa albedo is *not* pre-darkened toward the haze; the haze does it.
  Pre-tinting rock toward grey is the amateur version and produces dead colour.
- **Scatter is sun-relative, not distance-only.** At 12° elevation forward Mie
  scatter makes haze several times brighter toward the sun than away from it.
  With distance-only fog, looking into the sun and looking away are identical and
  the frame stops reading as late afternoon.

**Heat shimmer:** screen-space UV distortion between horizon −2.0° and +1.5°,
amplitude 0.0018 UV, two octaves at 1.4 Hz and 3.1 Hz, ×1.6 over tarmac and ×0.4
over sand. Disabled on `low`.

**Post-process chain, in order:**
1. ACES filmic tonemapping, **exposure 0.88** — derived, see §9a
2. Bloom: **threshold 2.5 scene-linear**, intensity 0.38, radius 0.55.
   A night-tier threshold of 0.82 blooms the entire sky and every sunlit rock
   face into a global haze, because the sky sits at 1.05 scene-linear. Only the
   sun disc, specular glints and the §4 gameplay band may cross 2.5.
3. Colour grade: shadows lifted toward `#3a4c74`, midtones held warm, highlights
   rolled to `#fff0dc`. Saturation 1.08 with highlight desaturation rolloff from
   luma 0.75 — without it the sand clips to a flat cream slab and takes its hue
   with it.
4. Vignette 0.22
5. Chromatic aberration 0.0011 at edges, ramping to 0.0028 during boost
6. Motion blur on `high` / `ultra` only

---

## 3. Colour

Never ship pure `#000000` or `#ffffff` as albedo. Every surface carries hue.

### 3a. Environment palette

| Element | Hex | Hue | Notes |
|---|---|---|---|
| Road, clean tarmac | `#4b4340` | 24° | roughness 0.62 |
| Road, racing line (rubbered) | `#3a3330` | 24° | roughness 0.48 |
| Road, sand-drifted edge | `#6b5c4e` | 30° | roughness 0.78 |
| Road, wash sand-over-tarmac | `#8a7458` | 33° | roughness 0.85, grip drop |
| Lane edge line | `#d9cbb4` | 36° | worn, never pure white |
| Kerb stripe A | `#241f22` | 320° | near-black |
| Kerb stripe B | `#f2ead6` | 43° | bone |
| Sand, sunlit | `#e3c893` | 40° | |
| Sand, shadowed | `#9fa4b8` | 228° | **the hue-split counter-measure** |
| Sand, compacted | `#c2a271` | 33° | |
| Gravel / scree | `#a8917a` | 29° | |
| Rock — caprock | `#c9764a` | 19° | wind-polished |
| Rock — upper strata | `#b5623f` | 18° | |
| Rock — mid strata | `#a0553a` | 17° | |
| Rock — lower strata | `#8f4a33` | 15° | |
| Rock — iron oxide band | `#7d3529` | 8° | thin, 0.4–0.8 m |
| Rock — basal shale | `#6b3c30` | 13° | |
| Rock — gypsum seam | `#d8bfa0` | 33° | pale, mandatory (Trap 1) |
| Cliff face, shaded | `#5a3b3f` | 353° | sky fill pushes it purple-brown |
| Desert varnish | `#4e3a30` | 24° | patches on near-vertical faces |
| Sky zenith | `#3f77c4` | 215° | |
| Sky mid | `#7fb0e0` | 210° | |
| Sky horizon, sun side | `#ffb463` | 31° | clamp 20°–45°, never pink |
| Sky horizon, anti-sun | `#b9c9d8` | 205° | |
| Distant haze | `#d8b892` | 32° | |
| Far mesa, fully hazed | `#b09aa0` | 344° | |
| Vegetation — sage | `#6b7355` | 76° | saturation 0.15 |
| Vegetation — dry brush | `#8c7a52` | 43° | saturation 0.26 |

**Vegetation is capped at saturation ≤ 0.30 and hue 60°–95°, with no exceptions.**
Desert plants are grey-green, not green, and a saturated shrub is a direct threat
to §4 tier 1.

**On kerbs.** Red-and-white kerbing is the racing default and unusable here:
`#e0453f` sits 3° from the upper strata and disappears into the cliff behind it.
Kerbs separate by **value, not hue** — `#241f22` against `#f2ead6` is a 6.4:1 luma
ratio, the highest-contrast pair in the environment palette, and it holds at every
sun angle and distance. Kerbs are never red.

### 3b. Why the road is dark

Sunlit sand computes to luma **≈ 0.43** horizontal, 0.748 sun-facing. Clean tarmac
computes to **0.085** horizontal, 0.197 sun-facing. That **5.0:1 ratio is the
racing line**, and it is why this circuit is readable in a wide shot without a
single HUD element. Any change that lightens the road or darkens the sand is a
gameplay change, not an art change, and must be argued as one.

*Corrected.* This paragraph read "sunlit sand 0.65, clean tarmac 0.27, a 2.4:1
ratio" for as long as the desert theme has existed, and **0.27 is the shadowed
sand row of §9a's palette table, not tarmac**. It was picked up from the old
neutral-value, normal-incidence table that §9a has now replaced; the recomputed
per-channel figures are above. The gameplay contrast is not damaged by the
correction — it is twice what was claimed — but the number was wrong and the
inflated tarmac value is the kind of thing that gets used to argue the road is
already dark enough.

---

## 4. Reserved Gameplay Band — the most important rule in this file

### 4a. The problem, stated numerically

The night circuit reserved lime and gold for gameplay because the environment
owned magenta, cyan, violet and amber. **That reservation is now inverted and
must not be carried over.** This environment is built from:

- A **warm cluster** at hue **8°–43°** — rock, sand, haze, sun, sun-side sky,
  dust, vegetation, road. Roughly 75% of every frame.
- A **cool cluster** at hue **205°–228°** — sky and every shadow.

Gold `#ffc61a` sits at hue 44°, amber `#ffa424` at 34°. Both land inside the warm
cluster; a gold spark against sunlit sand is a 4° hue separation at similar luma,
which is to say it is invisible. Lime `#6cff5a` survives on hue but not on value:
at luma 0.82 it is indistinguishable in brightness from sand at 0.65 under bloom,
and an additive spark against a bright background loses its core before its
corona. **All three night-tier colours are retired.**

### 4b. The band

**Reserved exclusively for gameplay feedback: hue 155°–320°, saturation ≥ 0.85.
No environment surface, rock, plant, sky, dust, decal, light or particle may
enter this band at any saturation above 0.30.**

This is the region the desert physically cannot produce. Iron oxide, quartz,
gypsum, dry chlorophyll and Rayleigh-scattered sky between them cover 8°–43° and
205°–228°; nothing in a canyon at a 12° sun makes spring green, electric violet or
magenta. That is not a stylistic claim — it is why the band is safe.

| Signal | Hex | Hue | Min hue separation | Where |
|---|---|---|---|---|
| Drift tier 1 | `#00ffa3` | 158° | 53° from sky, 115° from sand | Sparks from both rear wheels, faint kart rim |
| Drift tier 2 | `#b24bff` | 274° | 46° from sky, 94° from warm cluster | Sparks, brighter rim, wheel-well glow |
| Drift tier 3 | core `#ffe9fb`, corona `#ff2fd0` | 314° | 66° from warm cluster | Sparks, full chassis rim, ground light pool |
| Boost flame | tier colour that earned it, `#fff4ff` core | — | — | Exhaust plume |
| Item pickup | `#00ffa3` → `#b24bff` roulette | — | — | HUD only |

The ladder escalates on **hue rotation and luminance together**, so it survives
both a colourblind player and a bright frame: tier 1 is mid-luma green-cyan,
tier 2 is dark-luma violet with a bright core, tier 3 is near-white with a
saturated magenta corona and the only ground-projected light in the game.

### 4c. Consequences that are easy to get wrong

- **Tier 3's corona at 314° is the band's weakest link** — 62° from the 8° iron
  oxide band, the closest approach in the table. It is protected by the §2 rule
  that the horizon may never go pink, and by the near-white core no rock will
  ever have. Never soften either.
- **Dust is the other threat, and it is specific to this theme.** A drifting kart
  makes a plume exactly where the sparks are. Dust opacity is hard-capped at
  **0.55** inside a 0.6 m sphere of any active spark emitter, and sparks are
  emitted **0.10 m outboard** of the dust emitter so they sit in front of the
  plume from every camera angle. A tier-3 drift read as "the dust looks a bit
  purple" has failed.
- **The kart's dust accumulation layer is clamped to zero within 0.12 m of any
  gameplay-band emissive strip.** The rim light must not silt up.

A reviewer finding any of these hues on rock, sand, sky, plant, dust or kerb is
reporting a defect, not a preference.

---

## 5. Materials (Procedural PBR only)

- **Resolution:** 1024² within 5 m of camera, 512² beyond, 256² on `low`
- **Anisotropy:** `min(8, maxAnisotropy)` on road and sand
- **UVs:** triplanar on all rock — strata must not smear on overhangs — and
  correctly tiled elsewhere with a second-octave break
- **Never apply one scalar uniformly across materials that are not uniform.**
  Environment map intensity, sheen and clearcoat are per-material, resolved
  through a single accessor so a global override cannot be written by accident.

### 5a. Roughness must vary spatially — and here is what varies it

| Surface | Base | Range | What varies it |
|---|---|---|---|
| **Rock** | 0.74 | 0.62–0.88 | Strata hardness; a wind-scour mask on faces within 40° of azimuth 71°; desert-varnish patches (0.55) on faces < 25° from vertical |
| **Sand** | 0.88 | 0.78–0.95 | The compaction field; grain-size noise at 0.9 m wavelength; ripple crests 0.06 lower than troughs, which is what produces the grazing glint |
| **Road** | 0.62 | 0.48–0.85 | Rubber lay-down along the true optimal line (0.48); sand drift creeping from both edges (0.85 plus an albedo lerp toward `#8a7458`); aggregate-exposure noise; four patch repairs per lap |
| **Kerb** | 0.44 | 0.44–0.70 | A chipped-edge mask along the top arris |
| **Kart paint** | 0.30 | 0.30–0.66 | The dust accumulation layer |

### 5b. Sand — the signature material of this project

The wet road was the night circuit's signature. Here it is sand, and it is
harder, because sand has no reflection to carry it.

- Base `#e3c893`, metalness 0.0, roughness 0.88
- **Sheen 0.35, sheen colour `#fff0d0`, sheen roughness 0.30. Non-negotiable.**
  At a 12° sun, real sand forward-scatters into a broad grazing glint along every
  ripple crest and dune shoulder. Without sheen the dunes are matte brown paper.
- Ripple normals at 0.34 m wavelength oriented to wind azimuth 71°, second octave
  at 1.9 m for dune-scale drift
- Shadowed sand shifts to `#9fa4b8` **through the sky-fill term, not a painted
  mask**. Bake it and it will not move with the shadows, and the Trap 1
  counter-measure dies.
- Kart tracks are a decal ring buffer: 0.9 m compaction stripe, roughness −0.10,
  albedo toward `#c2a271`, 240 s fade

### 5c. Rock

- Six strata bands (§3a), horizontal, with a global 2.4° dip so bedding planes are
  not perfectly level anywhere
- Band thickness driven by 1D noise so no two vertical cross-sections match
- Erosion: a 3-octave ridged field carving gullies at 1.2–4.0 m spacing on faces
  steeper than 55°
- Talus at the base of every cliff, 32° repose angle, instanced boulders
- **Metalness 0.0 everywhere. There is no metal in this landscape.**

### 5d. Kart bodywork

- Painted `metalness 0.0, roughness 0.30`, clearcoat 1.0 / clearcoatRoughness 0.07
- Chrome trim `metalness 1.0, roughness 0.18`, environment-mapped
- **Dust accumulation layer.** An up-facing mask (`dot(normal, up) > 0.35`) plus a
  leading-face term blends albedo toward `#cbb08a` and roughness to 0.66, from
  0.00 at the grid saturating at 0.55 by the end of lap 3. This is the desert's
  answer to the wet road's reflection: the material that tells you a race has been
  happening.
- The dust mask is clamped to 0 within 0.12 m of any §4 emissive strip.
- Underglow strip per racer, emissive 1.4. **Livery colours are drawn from hue
  8°–43° and 205°–228° only** — the environment bands — so no kart can ever be
  mistaken for a drift signal.

---

## 6. The Kart

- Wheel radius **0.36 m** against body length **2.0 m**, deliberately oversized
- **7–13 k triangles**, including driver
- **Every edge chamfered**, 0.012–0.020 m. A hard 90° edge under a 12° sun gives
  either a blown highlight or nothing at all; the chamfer is what gives the
  silhouette its rolling terminator.
- Geometric tyre tread: a 14-knob ring plus a shoulder block row. Flat tyres on
  sand look wrong immediately.
- Visible driver, tinted visor `#2a3a4a`, hands tracking the wheel
- Exhaust stacks, roll bar, bevelled bumper, two mudflaps that flare with speed
- Per-wheel suspension travel 0.09 m; body rolls into corners, pitches under load
- **On a banked corner the chassis stays normal to the banked surface while the
  camera horizon rolls with the bank** — 20° on The Wall, 10° on the banked esse
  (§1). The bank must be felt, not just seen. It is stated for both because both
  exist; it is not a new treatment for the esse, it is the same road-relative
  camera doing the same thing at half the angle.
- Driver leans and counter-steers into a drift
- Kart hops on drift entry — the tell that the drift *took*
- Eight liveries, each with secondary trim and a procedural decal

---

## 7. Feedback Layer — the game is in here

All gameplay signals use the §4 reserved band; all environmental particulate uses
the environment palette, and the two never mix.

**Drift:**
- Hop and a chassis-roll snap on entry
- Sparks from both rear wheels, additive, bright core plus soft corona, emitted
  0.10 m outboard of the dust emitter
- Tier change fires a flash, a burst, and an audible step — a player must know
  their tier without looking at the HUD
- Rim light on the kart brightens with tier, so tier is readable on the vehicle
  even when sparks are off-screen
- Tier 3 alone projects a ground light pool, radius 1.8 m, `#ff2fd0` at 0.9 —
  the only coloured light the kart casts

**Boost release:**
- Flame plume in the tier colour with a `#fff4ff` core
- Radial speed lines; FOV punch +8° over 120 ms decaying over 400 ms
- Chromatic aberration ramp 0.0011 → 0.0028, motion blur step
- A **dust shockwave ring**: 4.0 m radius over 260 ms, `#e8cfa4` when lit,
  `#9aa2b8` in shadow; on tarmac a thin `#d9d2c8` smoke ring instead. It must not
  tint toward the reserved band.
- The release must be unmistakable at a glance and must produce a **measurable**
  lap advantage — see §10c

**Dust and sand (environmental — never in the reserved band):**
- Per-wheel plumes scaling with speed × surface looseness, capped at 0.55 near
  active spark emitters
- **Plumes are shadow-aware.** Lit `#e8cfa4`, in shadow `#9aa2b8`. A plume that
  stays bright inside The Slot destroys the shadow read that section exists to
  demonstrate.
- **Surface-change smoke is colour-coded, and this is gameplay information.**
  Tarmac → grey `#d9d2c8`. Sand → warm `#e8cfa4`. Gravel → `#a8917a` plus flying
  chips. The player learns what is under them without looking down.
- Rooster tails off the sand shoulders, 2.4 m at top speed
- Wind streamers along the ridgelines on wind azimuth 71° — the same wind that
  orients the ripples. One wind vector, globally.
- Sun shafts through the three arch skylights; volumetric on `high`/`ultra`

**Impact:** screen shake, star ring, chassis squash-and-stretch. Rock impacts
spall `#c9764a` chips and a `#d8bfa0` puff. Sand impacts throw a wide low puff and
cost more speed than they look like they should — the outside of every corner is
soft, and it must be visibly soft.

---

## 8. HUD

- **Top-left:** lap `1/3`, large numeral, flash on completion
- **Top-right:** race timer, tabular numerals, no width jitter
- **Bottom-left:** item box with roulette spin and settle bounce
- **Bottom-right:** speedometer — analogue arc, needle with slight overshoot, digital readout
- **Left-centre:** position, large, ordinal suffix, punch on change
- **Bottom-centre:** minimap tracing the true circuit path, player a large dot, rivals in livery colours
- **Countdown:** 3 / 2 / 1 / GO! scale-and-fade, full-screen flash on GO
- **Typography:** no default browser font. Explicit stack, weights, letter-spacing,
  tabular numerals.
- **Every string needs a dark outline, not a drop shadow.** The night circuit had
  bright neon behind arbitrary parts of the screen; this one is worse, because the
  background is uniformly bright sand and a light glyph with a soft shadow simply
  disappears. HUD text is `#f7f1e4` with a 2 px `#2a2320` outline at 0.85 opacity.

---

## 9. Performance & Energy Budget

**Target:** 60 fps at 1080p on an RTX 4050 laptop GPU at `Quality.High`.

- ≤ **250 draw calls** per frame
- Instance every repeated element: strata bands, boulders, pebbles, shrubs, kerb
  segments, arch ribs, dust particles, ripple patches
- Frustum culling; LOD beyond 60 m; mesa layers beyond 250 m are impostors
  regenerated only on a 25° camera azimuth change
- Particles pooled and instanced; zero allocation in any per-frame path
- No `new Vector3()` inside `update()` — module-scope scratch objects only
- `low` must hold 30 fps on a mid-range phone with texture memory under 40 MB

### 9a. Frame energy

The night circuit's table was calibrated against a measured neon-rain reference:
mean luma 0.05–0.18, ≥ 30% dark pixels, ≤ 8% bright pixels. **Those numbers
describe the opposite of this scene and carrying any of them across would be a
serious error.** A sunlit desert is a bright-field image. Its failure mode is not
a white screen creeping in; it is a *flat* screen — high mean luma with collapsing
variance, which is what happens when shadows get lightened one commit at a time
to answer a readability complaint.

**Derivation basis.** three.js applies `colour *= exposure / 0.6` then the ACES
RRT/ODT fit, then sRGB encode. For neutral values the matrices are
value-preserving, so display luma is a closed-form function of scene-linear
luminance and exposure, and it inverts. Everything in the DERIVED column below
comes from that inversion plus 12°-sun geometry, not from taste.

At 12° elevation a horizontal surface receives `sin(12°) = 0.208` of normal
incidence while a **sun-facing vertical wall receives `cos(12°) = 0.978`, 4.7×
the floor** — the defining fact of this theme is that the walls are the bright
thing and the floor is not. Air mass is ≈ 4.8, so diffuse sky rises to ~35% of
horizontal illuminance and **open-ground shadows are only 1.5–2 stops down, not
3–4.** A low sun is a low-contrast light on horizontal surfaces and a
high-contrast light between wall faces.

**The first version of this table was neutral-value and normal-incidence, and
both of those were wrong here.** It is superseded. It computed a single
achromatic value per surface and applied it to a palette whose green channel runs
4–9× under its red — and Rec. 709 weights green at 0.7152, so "sunlit sandstone
0.86" was really the red channel of `#c9764a` reported as its luma, when the
surface measures rgb(196,123,95) and lands at 0.55 in frame. It then applied
normal-incidence numbers to frames that are mostly *ground*, at `sin(12°) = 0.208`
grazing incidence. Those two errors compound in the same direction and inflated
every row.

**Recomputed per channel** through the exact three.js ACES fit at exposure 0.88,
with one free parameter fitted to a measured sunlit-sand pixel. The model then
reproduces, independently, the measured sky (0.675 computed against 0.65
measured) and the measured brightest wall. Display luma, **sun-facing vertical —
the brightest state each surface can ever reach**:

| Surface | Display luma, sun-facing vertical |
|---|---|
| Kerb stripe B, bone `#f2ead6` | **0.822** |
| Sand, sunlit `#e3c893` | **0.748** |
| Rock — gypsum seam `#d8bfa0` | **0.731** |
| Rock — caprock `#c9764a` | **0.490** |
| 18% grey card | 0.444 |
| Rock — upper strata `#b5623f` | **0.407** |
| Rock — mid strata `#a0553a` | **0.348** |
| Rock — lower strata `#8f4a33` | **0.297** |
| Rock — basal shale `#6b3c30` | **0.215** |
| Road, clean tarmac `#4b4340` | **0.197** |
| Sky, mid elevation | 0.675 (measured 0.65) |
| Shadowed sand (sky fill only) | 0.27 |
| Shaded rock face | 0.17 |
| Deep overhang niche | 0.070 |
| ACES clip point | 1.00 |

**A horizontal surface lands at roughly 0.43–0.57× its sun-facing figure**, the
ratio rising with level because of where the tone curve compresses. Anchored
points: the 18% grey card at **0.241**, clean tarmac at **0.085**, sunlit sand at
**≈ 0.43**. Read the column above as a ceiling, not as what a frame full of
ground will show — that misreading is half of what was wrong with the version
this table replaces.

The near-sun haze band is the one row not re-derived; treat its old 0.97 as
suspect in exactly the same way until someone computes it per channel.

**Three consequences, and the third one resets the whole gate table.**

- The darkest legitimate surface in the scene computes to **luma 0.070 — above
  the 0.05 dark threshold**, so a correct daylight frame contains essentially
  nothing below 0.05 and the night-tier `minDark ≥ 30%` gate inverts into a
  *maximum*. Unchanged, and still derived.
- **Not one of the six mandated rock strata bands reaches 0.5**, even sun-facing.
  Neither does tarmac, at any orientation. The old "bright pixels ≥ 0.5" row was
  therefore unreachable by most of the palette, and what it actually measured was
  **how much sky a vantage framed**. Measured frames are bimodal — a mass at
  0.10–0.20 and a second at 0.60–0.70, and the second one is the sky. `grid`
  (passing) put 41.3% of frame in that upper mass; `arch-interior` put 3.0%.
- Consequently `strata-wall`, whose §11 job is "all six rock bands legible", was
  being required to put 28% of its frame above a threshold its subject cannot
  physically reach. **The threshold moves, not the area.** See the three bands
  below. Twelve sun azimuths were swept at 12° before concluding this: four of
  the five failing vantages failed at all twelve, because at 12° a 34 m wall
  throws 160 m across a 24 m corridor and no azimuth changes that.

#### The three bands

This section has always required three bands and only ever had one. The
recalibration procedure at the end of §9a says it in plain words — *"bucket them
into frontlit, backlit and deep-shade and set three bands, not one; at this
elevation they are three distributions and a single band spanning all of them
gates nothing"* — and a single band is exactly what shipped.

**The buckets are named for enclosure, not for the camera's relation to the
sun.** §2 runs the key *down* the canyon axis rather than across it, which makes
the photographic names useless as a sort key here: `arch-exit` looks straight
into the 12° sun and is backlit by any definition, and its histogram sits with
the open vantages; `strata-wall` is backlit by the same definition and sits 0.13
of mean luma below it. Sorting on the photographic name would have put two
entirely different distributions in one band, which is the failure the three-band
instruction exists to prevent. The count is three, as required. Deep-shade is
`interior` unchanged.

Rows that are **identical in all three bands** — every derived row, plus the
std-dev floor. None of them depends on composition, so bucketing by composition
is not a licence to move them:

| Metric | Budget | Status |
|---|---|---|
| Frame luma std-dev | **≥ 0.15** | guess on the value, derived on the direction (must rise from 0.10). **Does not move, in any band.** |
| Dark pixels (luma < 0.05) | **≤ 6%** | **derived** — deepest legitimate surface is 0.070 |
| Highlight pixels (luma ≥ 0.95) | **≤ 2%**, ≤ 6% with the sun in frame | **derived threshold**, guessed area |
| Clipped (luma ≥ 0.99), sun out of frame | **≤ 0.05%** | **derived** — clipping needs +5.4 stops over sunlit sand |
| Clipped, sun in frame | **≤ 0.25%** | **derived** — the sun disc is 0.0029% of a 1080p frame at 65° FOV; this allows ~85× that |
| Shadowed ground pixels | **≥ 22%** | design requirement (Trap 1) |
| Hue mass outside 8°–43° | **≥ 28%** | design requirement (Trap 1) |

Rows that **differ by band**, because they and only they depend on how much sky,
wall and floor a vantage frames:

| Metric | open | corridor | interior | Status |
|---|---|---|---|---|
| Mean frame luma, floor | **0.34** | **0.22** | **0.18** | **derived** from each band's composition, below |
| Mean frame luma, ceiling | **0.75** | **0.55** | **0.45** | guess (open, unchanged); **derived on the direction** for the other two — a corridor as bright as an open vantage is one whose wall shadow is not being cast, and §11 calls `arch-interior` the darkest frame in the game |
| Sun-struck pixels (luma ≥ **0.30**), floor | **50%** | **25%** | **12%** | **derived** from each band's composition, below |
| Sun-struck pixels, ceiling | **85%** | **70%** | **55%** | guess on the value, derived on the direction |

**The sun-struck threshold is 0.30 and it is derived**, off the recomputed table
above and nothing else. It sits *above* the brightest shadowed surface in the
palette — shadowed sand at 0.27 — and *below* sunlit horizontal sand at ≈ 0.43 and
below four of the six sun-facing strata bands. A pixel above it is one the sun
reached; a pixel below it is one the sun did not. That is the question the row
was always asking, and at 0.5 it could not ask it. **The 28% area was not
loosened to compensate**: each band's floor is computed from that band's own
composition and lands where it lands.

Compositions, stated so the arithmetic is checkable without running anything:

| Band | Composition | Mean | Above 0.30 |
|---|---|---|---|
| **open** — sun on broad ground, open sky above | sky 25%, sunlit sand 30%, road ribbon 28% (§3b — all of it under 0.30), shaded wall 15%, kart 2% | .25(.65)+.30(.43)+.15(.15)+.28(.10) = **0.342** | sky 25 + sunlit sand 30 = **55%** |
| **corridor** — a wall between the sun and the framed ground; at 12° a 34 m wall throws 160 m across a 24 m corridor (§9c), so the floor is inside that shadow for all of it | sky strip 10%, sunlit caprock/upper strata 15%, shaded wall 30%, shadowed floor + road 45% | .10(.65)+.15(.45)+.30(.10)+.45(.15) = **0.229** | sky 10 + lit wall top 15 = **25%** |
| **interior** — no direct sun on any framed surface except what §11 explicitly grants; §2 makes the cliff bounce dominant here and says so | sky strip 7%, sun shafts 5%, bounce-lit wall 48%, shadowed floor 40% | .07(.65)+.05(.55)+.48(.18)+.40(.15) = **0.219** | sky strip 7 + shafts 5 = **12%** |

The interior sun-struck floor **is** the §11 requirement written as a number:
§11 grants `slot-narrows` a 9° sky strip and `arch-interior` three sun shafts,
those are the only above-0.30 content the band is entitled to, and if either goes
away the row fires.

#### Which vantage is in which band

Assigned from **what §11 says the vantage is**, never from whether it currently
passes. Two assignments go against the measurement on purpose.

| Vantage | Band | The §11 sentence it is read off |
|---|---|---|
| `grid` | open | "contact shadow on tarmac" — which requires direct sun on the tarmac |
| `dune-sweep` | open | "4.70× raking shadows across the road" — the sun reaches the road — over open sand |
| `strata-wall` | corridor | "all six rock bands legible … unsmeared on the overhang": a wall subject under an overhang, whose brightest band tops out at 0.490 |
| `slot-narrows` | interior | "lit by cliff bounce alone … 9° sky strip" — bounce-only by its own definition |
| `mesa-crest` | open | "longest sightline, aerial perspective, ≥ 5 depth layers" — nothing encloses it |
| `banked-wall` | corridor | "the 20° bank read … kerb value contrast at 6.4:1" is graded against a wall; the bank is the inside of a corridor, not open ground. **Against the measurement:** it clears the open band's floors today and is still graded as a corridor |
| `wash-descent` | open | "dust plume against **bright sand**" — §11 itself calls the sand bright |
| `arch-interior` | interior | "three sun shafts, bounce-only lighting, the darkest frame in the game" |
| `arch-exit` | open | "bloom control firing into a 12° sun" — the disc is in frame. **Against the measurement:** photographically backlit, but it is the brightest reachable state in the game and is graded against the brightest band, not relaxed |
| `drift-tier3` | corridor | sparks set "against warm rock and sand" — a rock-enclosed corner, and the §4 proof needs the reserved band to sit against unlit rock |

`arch-exit` and `drift-tier3` also carry the relaxed worst-case **clip and
highlight** limits. That is orthogonal to the band and must stay orthogonal:
folding one into the other would hand `drift-tier3` the open band's floors, which
its composition cannot meet.

`current-view` is **unbucketed**. It is not a §11 vantage and nothing states what
it frames, so there is no composition to derive a floor from and assigning it a
band would be inventing one. Its composition-dependent limits are the union of
the three bands; every shared row above still applies to it unchanged.

**The derived/guess split in those columns is not decoration.** The guesses
depend on how much sky, wall and floor a given vantage frames, and that
composition is invented until it is measured. Shipping a guess styled as a
derivation is the exact mistake §9a already paid for once.

**Revision on record, because "the gate failed so I moved the gate" is the
failure this section exists to prevent.** The mean-luma floor and the bright
floor started at 0.38 and 35%, and the first measured frames of the built scene
came in at 0.36 and 33%. Both were revised down — not because they failed, but
because the composition model behind them was demonstrably wrong: it weighted
sky, wall and sand and contained **no road at all**. A kart racer frames a dark
tarmac ribbon across the bottom third of every shot, at a linear albedo of 0.059
against sand's 0.35, and §3b makes exactly that contrast the racing line. Roughly
30% of frame at luma 0.27 pulls the mean down about 0.08, which is the size of
the discrepancy seen. The derived rows did not move, and neither floor has
graduated out of the guess column.

**Second revision on record — one band became three, and the reasoning is held
to the same standard.** Five of eleven vantages failed: `strata-wall`,
`slot-narrows`, `banked-wall`, `arch-interior`, `drift-tier3`. Two separate
investigations, neither of which changed any code, established that the gate was
wrong rather than the frame, and the evidence is on the record above: the
recomputed palette puts every rock stratum under the 0.5 threshold the gate
required 28% of frame to clear; twelve sun azimuths at 12° fail four of the five
at all twelve; and the old composition model was an *open* vantage — sky 20% /
wall 25% / sand 30% — while half the §11 set is enclosed by §1's own design and
§11 itself calls one of them "the darkest frame in the game". Both rows that
failed were already flagged **guess**, and both had already been revised once for
the same class of reason.

What moved: the sun-struck threshold, from a wrong number to a derived one, and
the mean and area floors, per band, each recomputed from that band's composition.
What did not move, and must not: **`minStdDev` in any band** — `arch-interior`
measures 0.152 against the 0.15 floor and clears it on merit, after an arch roof
was built to earn that margin — and `maxDark`, `maxHighlight` and `clipped`, all
of which measure 0.00% and all of which are derived. The area was not widened to
compensate for the threshold move.

**And every band was watched failing.** A relaxed floor nobody has seen fire is
not a floor. `tools/energy-check.mjs --broken` now runs three sabotages, not one,
and demands that each fire in *every* band: `white` (a quarter of the frame
cleared to white, the original), `dim` (every pixel halved in display space —
the direction the corridor and interior floors relax in), and `flat` (every pixel
pulled 80% of the way to one mid grey, which preserves the mean and cuts the
std-dev to a fifth). Under `flat` the corridor and interior bands fail on
`minStdDev` **alone**, which is the demonstration that mattered.

Three consequences worth stating plainly:

- **Brightness is not the enemy; sameness is.** A desert is supposed to be bright.
  It is not supposed to be *even*. The std-dev floor and the shadow occupancy
  floor are the two rows a flat frame cannot pass, and the two most likely to be
  argued away.
- **The hue row is the Trap 1 gate.** A frame that passes on luma and fails on hue
  is a brown photograph of a brown thing.
- **Almost nothing should clip.** Bloom sells a low sun far better than a blown
  highlight does, and a clipped sand pixel has thrown away the `#e3c893` that made
  it sand.

**Recalibration procedure.** Capture 8–12 rendered — never photographed —
references at low sun, admitted only if an in-frame shadow measures a
shadow/height ratio of 3.2–7.1 (elevation 8°–17.5°), which is the one filter that
stops "golden hour" quietly meaning 30°. Bucket them into frontlit, backlit and
deep-shade and set three bands, not one; at this elevation they are three
distributions and a single band spanning all of them gates nothing. Then re-derive
exposure by solving the ACES fit for where the references put sunlit high-albedo
ground, which turns exposure from taste into a fitted parameter.

**This procedure has now been run once**, and the three bands above are its
output — bucketed by enclosure rather than by the photographic names, for the
reason given there. The exposure re-derivation was done the same way: the ACES
fit was solved per channel with one free parameter against a measured sunlit-sand
pixel, and the fitted model then predicted the sky and the brightest wall without
being told either. Anyone re-running it should expect the bucket *names* to be
arguable and the bucket *count* not to be: the ten §11 vantages are three
distributions and no fewer.

### 9b. No perfectly uniform region — anywhere

No surface, sky included, may render as a single flat value across any region.
**Sand is the bigger offender in this theme** — an untextured ground plane under a
directional light is genuinely uniform across a large fraction of frame, and it is
easy to ship by accident.

This is an art rule with a second job, and the job changed shape with the theme.
The partial-present detector keys on uniformity because darkness is unusable as a
signal: at night a correct frame was full of near-black tiles, and in daylight
there are no legitimately black tiles at all. Either way, "was this drawn?" is
answered by variance.

**Two detectors, and the second one is new because the failure inverted:**

- **Unpainted** — `stdDev < 1e-5`, *at any brightness*. The night version also
  required `mean < 0.004`, which was harmless when the clear colour was black and
  is actively dangerous now: `renderer.setClearColor(skyColour)` is an ordinary,
  defensible thing to write under a bright sky, and it would silently disable the
  detector. A sky shader that fails to compile and falls back to a constant is the
  same hole.
- **Flat-bright** — `stdDev < 2e-3 && mean ≥ 0.5`, at most one tile of 64. This is
  the daylight equivalent of the coloured-slab failure: a blown sky, a procedural
  sand albedo returning a constant. The threshold is only safe because §2 mandates
  ≥ ±2 code values of sky dither, which puts a correct sky at stdDev ≈ 4.5e-3,
  2.3× above the gate. Remove the dither mandate and this detector starts lying.

### 9c. Shadows are the content — cascade coverage is required, not a luxury

The night circuit mandated screen-space reflection because a wet road without
anchored reflections is a mirror with a texture on it. **The dry equivalent is
cast shadows, and the argument is structurally identical**: the reflection began
where the tyre met the road; the shadow begins where the tyre meets the sand. Same
§10b criterion 4, same failure, different mechanism.

Cascade 3 (160–480 m) is mandatory on `medium` and above.

- **Range.** A 34 m cliff throws 160 m of shadow; a 52 m mesa throws 244 m. A
  cascade scheme tuned for a normal sun terminates around 120 m and what happens
  is not a visible artefact — the far shadows simply are not there, the open sand
  goes uniform, the std-dev row fails, and nothing in the frame says why.
- **Resolution.** Light-space projection stretches by `1/sin(12°) = 4.8×`, so a low
  sun needs roughly 5× the texel density of a noon scene for the same ground
  detail. Budget for it or the kart's shadow is a 24 cm-quantised blob.
- **Contact hardening is not stylistic.** Penumbra width is blocker distance ×
  0.0093 rad: ~0 cm at the contact patch, ~1.75 m on the 188 m wall shadow. A
  **40:1 penumbra range inside one frame** — a fixed PCF radius is provably wrong
  at one end or the other.
- **Bias must be normal-offset, not slope-scaled depth.** At `cos θ = 0.21` a depth
  bias large enough to suppress acne peter-pans every contact point, deleting
  exactly the contact this mandate exists to protect.

A desert without long shadows is not a desert. It is an orange plane.

---

## 10. Review Rubric

### 10a. Calibrated bands

| Band | Meaning |
|---|---|
| 0–40 | Programmer-art prototype |
| 40–60 | Competent hobby project |
| 60–75 | Good indie game; still clearly not first-party |
| 75–88 | Near-professional |
| 88–95 | Shipped-AAA quality |
| 95–100 | Best in class; reserve for work that redefines the category |

State the band name alongside the number in every review. A score without its band
is not a review.

### 10b. Frame criteria — a frame passes when all eight hold

1. **Silhouette & composition** — readable at thumbnail size; no two mesa profiles
   visibly repeat
2. **Lighting narrative** — one clear 12° key, blue sky fill, warm cliff bounce; no
   flat ambient; nothing lit by nothing
3. **Material diversity** — ≥ 5 visibly distinct surface responses, each with
   spatially varying roughness driven by the field named in §5a
4. **Grounding** — contact shadows and AO under every object; every kart throws a
   4.7× shadow. Nothing floats.
5. **Depth layering** — foreground, midground, background all present; haze
   separates the planes; ≥ 5 layers at `mesa-crest`
6. **Hue is not monotone** — ≥ 28% of pixels outside hue 8°–43°; visible blue
   shadow / warm sun split within the ground plane
7. **Amateur tells absent** — no visible UV tiling, no strata smearing on
   overhangs, no z-fighting, no unchamfered edges, no uniform roughness, no flat
   sand, no sky banding, no hard far shadows, no reserved-band hue on an
   environment surface, no pink horizon
8. **Motion & energy** — the frame reads as active play, not a parked screenshot

### 10c. Gameplay criteria — a screenshot cannot judge these

Scored from harness output only. A critic looking at a PNG must not score this
section; it has no access to the evidence.

1. **Drift pays.** A drifting lap is measurably faster than a clean lap, by a
   margin exceeding the run-to-run noise floor by at least 4×.
2. **The ladder is reachable.** ≥ 60% of drift attempts by the reference AI bank
   at least tier 1; ≥ 25% reach tier 3.
3. **Sparks survive dust.** At tier 3 in a full plume, the spark core occupies
   ≥ 60% of the pixels it occupies with dust disabled. The §4c gate, and the one
   most likely to regress silently.
4. **Steering is honest.** `steer > 0` moves the kart right, for player and AI.
5. **The bank does something.** Mean speed through The Wall exceeds mean speed
   through an equivalent flat 74 m-radius corner by ≥ 6%.
6. **The race completes.** Every kart finishes three laps unattended, with no
   respawn loop and nobody stuck on a wall or buried in a talus slope.
7. **Input is prompt.** Touch and keyboard steer latency under 50 ms, with stun
   frames excluded.
8. **It survives a phone.** No context loss, no memory kill, over a full race.

**Criterion 1 is currently unreachable, and the measurement says why.** Recorded
here rather than argued about, because two attempts to fix it in `game/ai.ts`
regressed and the target was never the AI's to hit.

A scripted controller, entry speed identical by construction across arms, split
only on the drift button, measured over corner + 150 m at every drift-eligible
corner on the lap:

| corner | R | Δ vs clean | | corner | R | Δ vs clean |
|---|---|---|---|---|---|---|
| grid-ease | 83 | **+6.50 s** | | wall-arc | 74, 20° | −0.00 s |
| dune-sweep | 118 | +0.05 s | | wash | 148 | −0.03 s |
| ess-1 | 72 | **> +16 s** | | final-corner | 69 | **−0.51 s** |
| ess-2 | 48, 10° | **+5.83 s** | | ess-3 | 98 | cannot charge |

Drifting only where it pays is worth **0.54 s** on a 62.76 s lap. The gate wants
4 × the 1.62 s noise floor, i.e. **6.48 s**. Short by a factor of twelve, with a
perfect policy, after a search over slip target, chase gain, flick length and
release timing.

**The mechanism is the button, not the technique.** Arms with `kSlip = 0` — the
same pure-pursuit command the clean arm uses, no flick, no brake — reproduce the
whole loss. `rearDriftScale = 0.61` cut rear peak force 39% for as long as
`drift.active`, keyed on the button rather than on slip, and that is paid for the
entire hold while the boost repays for 0.72–2.05 s. Entry speed is never the
loss; where a drift survives, exit speed actually *rises* 1.1–1.3 m/s.

**A drift boost has nothing to push against on a big corner.** The boost raises
`topSpeed`, which raises the drive-force headroom term — at 28 m/s a 1.22×
boost is +144% of drive force. But `wall-arc` at 28 m/s is at its LATERAL limit
and cannot spend longitudinal force, so the longest fastest corner on the lap
returns 0.003 s, while the short `final-corner`, the only one exiting onto real
straight, returns 0.507 s. **Drift value tracks how power-limited the exit is,
not corner radius** — which means it is a property of where the straights are,
and a circuit with one real straight can only ever have one paying corner.

Criteria 1 and 2 are also in tension on this chassis: 2 wants most attempts
banked, 1 wants drifting to be fast, and drifting is a loss at six of eight
eligible corners. Meeting 2 by drifting everywhere costs at least 12 s/lap.

Closing this needs the drift MODEL to change further — the peak cut now
scales with slip (`DRIFT_PEAK_CUT_SLIP`), which took the margin from -28.47 s
to -5.94 s; what is left is a boost that
is thrust rather than a `topSpeed` raise, or a rear cut that scales with slip
instead of with the button — or it needs the criterion restated. Both are design
decisions and neither belongs to a harness or an AI.

---

## 11. Vantage Points

Fixed camera positions. Every screenshot review and every energy measurement uses
these, so scores are comparable across rounds. These names are the enum — exactly
ten, kebab-case, no aliases.

| Name | What it must prove |
|---|---|
| `grid` | Kart detail, chamfers, tyre tread, livery, contact shadow on tarmac, dust layer at exactly zero |
| `dune-sweep` | Sand ripple normals, grazing sheen at 12°, 4.70× raking shadows across the road, no uniform sand region |
| `strata-wall` | All six rock bands legible with the gypsum seam present, triplanar strata unsmeared on the overhang |
| `slot-narrows` | Narrow-space readability lit by cliff bounce alone, blue-shifted shadowed sand, 9° sky strip, shadow-aware dust |
| `mesa-crest` | Longest sightline, aerial perspective, ≥ 5 depth layers, ≥ 7 distinct profiles, zero visible repeats |
| `banked-wall` | The 20° bank read, 20° horizon roll, chassis normal to surface, kerb value contrast at 6.4:1 |
| `wash-descent` | Dust plume against bright sand, the tarmac/sand/gravel smoke colour split, loose-shoulder softness |
| `arch-interior` | Three sun shafts, bounce-only lighting, the darkest frame in the game |
| `arch-exit` | Bloom control firing into a 12° sun, heat shimmer band, clipping under 0.25% |
| `drift-tier3` | Reserved-band sparks and ground pool against warm rock and sand; the §4 proof, with the dust-suppression cap visibly holding |

`arch-exit` and `drift-tier3` carry the relaxed worst-case clip limit. Renaming
either without updating `tools/energy-check.mjs` in the same commit silently stops
that limit applying to the brightest state in the game.

---

**This document is law.**
