# Neon Drift

A browser kart racer built in TypeScript and Three.js with **zero art assets**.
No textures, no models, no fonts, no audio files. Every mesh, material, sound and
reflection is generated in code at load time.

A rain-slick neon city at 2 a.m. Wet asphalt mirrors the signs above it, which
is what makes the racing line readable at night.

**Play:** https://dosyuki.github.io/VibeRacingGame/ · no sign-in, no install

## How it is built

Parallel agents under the **Gauntlet Loop**: a lead decomposes the work, builder
agents own one subsystem each and never see each other's code, and separate
critic agents score the result against an explicit rubric. Builders do not grade
themselves.

Two documents are frozen before any building starts, and they are what make the
parallelism work:

- **`src/types.ts`** — the interface contract. The only shared surface. Sibling
  imports are banned; everything crosses through it, `GameServices`, or the
  event bus.
- **`ART_DIRECTION.md`** — the art bible. Concrete numbers, not adjectives: sun
  absence, fog density, hex palette, material parameters, draw-call ceiling. No
  reference photographs are used anywhere in this project, deliberately — a
  photo creates a match-the-reference failure mode nobody can grade, while a
  written spec naming values is verifiable and composable across agents who
  cannot see each other's work.

## The part that is actually hard

Writing sixty thousand lines of coherent code is no longer the bottleneck.
Knowing whether it is any good is.

So the measurement layer is treated as the primary artifact. Critics score
rendered frames from real headless builds rather than source code, and an
automated player drives full races and asserts on outcomes — because a
screenshot cannot see inverted steering, a pause menu that ends the race, or
touch controls that never mount. Every harness is validated against a known-good
and a deliberately broken build before its numbers are allowed to influence a
decision.

Read `CLAUDE.md` for the conventions and for the traps that already have guards
around them.

## Local

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # typecheck + production build — the gate
npm run preview  # serve the built site
```

### Query flags

| flag | effect |
|---|---|
| `?quality=low\|medium\|high\|ultra` | override tier detection |
| `?seed=<n>` | pin the procedural world |
| `?debug=frames` | create the GL context with `preserveDrawingBuffer` so the presented frame can be read back |

## Licence

MIT
