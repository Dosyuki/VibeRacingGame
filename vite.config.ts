import { defineConfig } from 'vite'

// GitHub Pages serves a project site under /<repo>/, so the deployed build needs
// that prefix on every asset URL. Local dev, `npm run preview` and every harness
// in tools/ hit '/' instead — CI is the only place that sets PAGES_BASE, which
// keeps harness URLs identical to dev URLs and removes a whole class of
// "works locally, 404s in prod" confusion from the measurement loop.
export default defineConfig({
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
