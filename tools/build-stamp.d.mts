/**
 * Types for the one export `vite.config.ts` reaches for.
 *
 * `tsconfig.json` includes `vite.config.ts`, so the config file is inside the
 * `tsc --noEmit` gate — and under `strict` an untyped import of a `.mjs` fails
 * that gate. Rather than turn on `allowJs` for the whole project (which would
 * drag every harness in `tools/` into the typecheck and change what the gate
 * means for everyone else), the plugin declares its own surface here.
 *
 * `.d.mts` and not `.d.ts`: `moduleResolution: bundler` resolves an import of
 * `./tools/build-stamp.mjs` to `./tools/build-stamp.d.mts`.
 *
 * Only `buildStampPlugin` is declared. The rest of the module — the fingerprint
 * and verification API — is consumed from `.mjs` harness code, which is not
 * typechecked, and declaring it here would be a second definition to keep in
 * step with no compiler checking that it was.
 */

import type { Plugin } from 'vite'

export declare function buildStampPlugin(): Plugin
