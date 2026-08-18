# Working on this repo

A kart racer in Three.js with **zero art assets** — every texture, mesh, material
and sound is generated in code at load time. Built by parallel agents under the
Gauntlet Loop: builders never grade their own work, critics score rendered
frames rather than source, and harnesses answer the questions a screenshot
cannot.

Read `README.md` for what this is and `ART_DIRECTION.md` for what it must look
like. **§10 of that file is the rubric, and it is the bar.**

## Commands

```bash
npm run dev        # vite dev server
npm run build      # tsc --noEmit && vite build — THIS IS THE GATE, it must pass
npm run preview    # serve the production build
npm run typecheck  # tsc --noEmit alone
```

Never start a bare `npx vite` for a harness. Use `tools/vite-server.mjs`: it
spawns the binary directly, kills the whole process group on teardown, and
refuses to adopt a server already serving a *different* working tree. An
orphaned dev server from another worktree serves stale code into every
measurement, silently, for as long as it lives.

It refuses a second thing for the same reason. `npm run build` is
`tsc --noEmit && vite build`, so a type error stops the build **before** vite
runs and leaves the *previous* bundle in `dist/` — and every preview-mode
harness then grades code that is not on disk. That has already happened here: a
run reproduced a rejected variant's numbers to four decimal places while the
source was the reverted version. `vite build` now stamps `dist/` with a content
fingerprint of the source it was built from (`tools/build-stamp.mjs`, wired as a
plugin in `vite.config.ts`), and `startServer({ mode: 'preview' })` hard-exits
with code 2 unless it matches. Dev mode is deliberately exempt — vite transforms
each module on request, so no bundle exists to go stale. Self-test:
`node tools/build-stamp.mjs --broken`.

## The contract

`src/types.ts` is the interface every subsystem codes against and the only
shared surface. It is what makes parallel work possible.

**Do not edit it as a side effect of another change.** Widening it invalidates
every other agent's assumptions simultaneously. A genuine widening is its own
commit, announced, and it re-runs every harness.

**Sibling imports are banned.** `src/render/` may not import from `src/world/`.
Cross-subsystem data travels three ways and no others:

| Need | Channel |
|---|---|
| Continuous per-tick state (kart speed, wheel slip, standings) | `GameServices` |
| Discrete moments (drift released, lap completed, wall hit) | `EventBus` |
| Shared vocabulary (`Surface`, units, enums) | `src/types.ts` |

If you want an import from a sibling directory, you are describing one of the
three above. Use it.

One concern per directory:

| path | what lives there |
|---|---|
| `src/core/` | clock, RNG, events, input, settings, quality, diagnostics, prewarm |
| `src/render/` | renderer, post chain, procedural textures/materials, sky, haze |
| `src/world/` | circuit spline + geometry, cliffs, strata, scatter, vegetation |
| `src/kart/` | chassis, suspension, tyres, kart model, liveries |
| `src/game/` | race state, AI, camera rig, items, projectiles |
| `src/fx/` | particles, trails, decals, screen effects |
| `src/ui/` | HUD, menus, minimap, touch controls |
| `src/audio/` | synthesis, music, engine |

`src/main.ts` is the ONLY composition root. It constructs subsystems through the
factory types in the contract, assembles `GameServices`, and owns update order.

## Four conventions that will cost a round if you break them

**1. Steering sign is stated once and negated nowhere.**
`steer > 0` means "toward the driver's right", for every caller, human or AI, at
every layer. The single conversion to yaw torque lives inside `IKart.step`. If
an AI implementation needs a sign flip to make karts turn correctly, the bug is
in the AI's frame maths — do not fix it with a negation, because the second
negation somewhere else then looks correct too and only one of them is.
Guard: `tools/steer-test.mjs`.

**2. Wall clock never reaches the simulation.**
`fixedUpdate` sees `SIMULATION_STEP` and nothing else. No `performance.now()`,
no `Date.now()`, no variable delta. This is a measurement requirement before it
is a physics one: a variable timestep makes substep counts depend on machine
load, which makes lap times, AI lines and every screenshot depend on how busy
the laptop was. Two rounds then cannot be compared, and the loop grades by
comparison.

**3. Randomness comes from `ctx.rngFor(namespace)`.**
Never `Math.random()`. Streams are keyed by namespace, not by call order, so
adding an `await` inside anyone's `build` cannot shift what anyone else draws.
One shared stream plus one new `await` rebuilds a different city from an
identical seed, and nothing about the frame says why.

**4. A single global constant can defeat thousands of lines of work.**
Environment map intensity, emissive strength and clearcoat are resolved
per-material through one accessor. Applying any of them flat across all
materials silently deletes every reflection in the game and the frame gives no
clue. Be suspicious of one value applied uniformly to things that are not
uniform.

## Traps already designed out — leave the guards alone

The comment explaining each of these is load-bearing. More than once elsewhere,
a correct-looking cleanup deleted a "wrong" comment and took the guard it
justified with it. **If a comment seems wrong, the guard may still be right for a
different reason. Work out which before removing either.**

- **MSAA is incompatible with an AO pass that samples the composer input as a
  texture.** A multisampled target cannot resolve for that read. Elsewhere this
  produced part-black presents on 7.6% of frames against 0.2% with the guard.
  When `render/` adds SSAO, the sample count goes to 0 and stays there.

- **Reading the presented frame requires `preserveDrawingBuffer`.** Without it
  `readPixels` after present returns discarded contents, which reads as "100% of
  frames are black" and is completely false. `readFrameLumaStats` throws rather
  than returning that lie; `?debug=frames` creates the context correctly.

- **Draw calls are not proof of rendering.** Every known black-screen failure
  still issues a full frame of draws into a canvas nobody sees. Trust
  `frameLumaStats`, not the counter.

- **A whole-image standard deviation cannot see a partially black frame.** Half
  black and half correct scores *better* on global spread than a healthy frame.
  Assert on `worstTileBlackFraction` from the 8×8 grid, never on `stdDev`.

- **Shader pre-warm must bind a render target.** `WebGLPrograms.getParameters()`
  reads `outputColorSpace` and `toneMapping` off the currently bound target, so
  `renderer.compile()` with nothing bound compiles default-framebuffer variants
  the composer never uses — and every real shader still stalls on first use.

## Verifying a change

The harnesses are the point of this repo more than the game is. Each answers a
question that is genuinely hard to answer by looking.

| harness | the question it answers | self-test |
|---|---|---|
| `smoke.mjs` | Did a frame actually reach the screen, all of it? | `--broken` scissor-clears half the buffer |
| `fps-bench.mjs` | What does a frame cost, on a GPU we can name? | `--force-software` must be refused |
| `energy-check.mjs` | Is the frame inside the §9a frame-energy budget? | `--broken` blows a quarter to white |
| `contract-check.mjs` | Does every harness method work, or refuse honestly? | reports its own coverage ledger |

```bash
npm run check          # all of them
npm run check:smoke    # and :fps, :energy, :contract
npm run selftest       # prove each instrument fails when it should
```

**Every harness ships a self-test, and it is not optional.** A harness nobody
has watched fail is not evidence. The first version of `smoke.mjs` "failed" its
own self-test because the sabotage — hiding the canvas with CSS — never touched
the drawing buffer; the detector was fine and the test was inert. That is the
shape of the problem: you cannot tell a working instrument from a broken one
without making it report a failure you constructed on purpose.

`energy-check.mjs` reports vantages it cannot reach yet as **PENDING**, never as
skipped. A gate that quietly covers nothing produces the same green output as a
gate that passed.

Rules learned at other people's expense, applied here from the start:

- **Validate the instrument before trusting the reading.** Every harness must be
  proven against a known-good build *and* a deliberately broken one before its
  numbers are used to make a decision. Two harnesses elsewhere produced
  confident, precise, entirely fictional numbers before anyone checked them.

- **A timing number from a software rasteriser is fiction.** Headless Chrome
  falls back to SwiftShader silently and still returns confident numbers. This
  machine also has *two* GPUs — a Radeon 780M and an RTX 4050 — and Chrome will
  happily pick the wrong one. `glReport().renderer` names what actually
  rendered; timing harnesses hard-exit rather than report a frame time they
  cannot attribute to the intended GPU.

- **At 60 Hz there is no such thing as a 20 ms frame.** vsync returns ~16.7 or
  ~33.4 ms, so the *median* frame time of a build running at 48 fps is exactly
  16.70 and reads as a perfect pass, while "% of frames over 16.7 ms" is ~45% on
  a flawless run purely from jitter. `fps-bench.mjs` disables vsync so the
  number reflects actual cost rather than the refresh grid, and gates on the
  MEAN either way. Do not tidy that onto the obvious statistic, and do not
  re-enable vsync for a comparison — with it on, a change that halves GPU cost
  reports the identical frame time.

- **Pin the adaptive scaler for every A/B.** A scaler that spends resolution to
  protect frame rate is right for a player and ruinous for a measurement: an
  optimisation that genuinely saves 2 ms lets the ladder hold a higher rung, so
  it draws more pixels and reports the same fps. The saving is real and
  completely invisible. `scalerPinned()` must report the truth, and any harness
  claiming a pin that did not take must refuse to print its run.

- **Benchmark runs degrade the machine.** Consecutive runs fall away with no
  code change at all. Idle between them, and relaunch the browser per sweep
  point — reusing one browser leaves a live WebGL context and its texture
  memory alive each time.

- **A screenshot cannot find a gameplay bug.** Inverted steering, unusable touch
  controls and a pause menu that permanently ends the race all survived three
  full rounds of six reviewers scoring beautiful stills, elsewhere. This is the
  single most expensive lesson available from prior art, and it is why the
  automated player is built in round 1 rather than round 9. If a change affects
  how the game *plays*, it needs a harness or a human — not a critic looking at
  a PNG.

Before calling anything done: `npm run build` must pass, and the harness
covering what you touched must pass.

## Style

Match the surrounding code. It is heavily commented and deliberately so:
comments here explain *why*, and the "why" is usually a bug that has already
been paid for once.
