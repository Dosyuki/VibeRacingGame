import { defineConfig } from 'vite'
import { buildStampPlugin } from './tools/build-stamp.mjs'

// GitHub Pages serves a project site under /<repo>/, so the deployed build needs
// that prefix on every asset URL. Local dev, `npm run preview` and every harness
// in tools/ hit '/' instead — CI is the only place that sets PAGES_BASE, which
// keeps harness URLs identical to dev URLs and removes a whole class of
// "works locally, 404s in prod" confusion from the measurement loop.
export default defineConfig({
  /*
   * Stamps dist/ with a fingerprint of the source it was built from. It lives in
   * a plugin rather than in an extra step on the `build` npm script for one
   * reason: a plugin cannot run unless `vite build` ran, so the stamp cannot be
   * produced without the bundle it vouches for. `tools/vite-server.mjs` refuses
   * to start a PREVIEW server whose dist/ does not match — see the long note at
   * the top of `tools/build-stamp.mjs` for what that is defending against.
   * Build-only; the dev server has no bundle to go stale.
   */
  plugins: [buildStampPlugin()],
  base: process.env.PAGES_BASE ?? '/',
  build: {
    target: 'es2022',
    sourcemap: true,
    // The harnesses attribute frame cost to subsystems; a single opaque bundle
    // makes that impossible to read in a profile.
    chunkSizeWarningLimit: 1500,
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
})
