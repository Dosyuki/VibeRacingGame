/**
 * The only sanctioned way for a harness to get a server.
 *
 * Four things it does that `npx vite` does not:
 *
 *  1. Spawns the vite binary directly, so there is no npx/npm shim sitting
 *     between us and the process we later have to kill.
 *  2. Kills the whole process tree on teardown. A surviving vite holds the port
 *     and the next harness run silently measures the previous build.
 *  3. REFUSES to adopt a server that is already listening. Adopting one is how
 *     an orphaned server from another worktree ends up serving stale code into
 *     every measurement for an entire round, with no error anywhere.
 *  4. REFUSES to serve a PREVIEW build that does not match the source on disk.
 *     Same sentence as (3) with a different subject: a `dist/` left behind by a
 *     build that failed at `tsc --noEmit` serves stale code into every
 *     measurement, silently, for as long as it lives. It has already cost a run
 *     here — a harness reproduced a rejected variant's numbers to four decimal
 *     places against source that had been reverted. See `build-stamp.mjs`.
 */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertBundleMatchesSource } from './build-stamp.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..')

const VITE_BIN = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')

/**
 * Is anything at all listening on this port, on EITHER loopback stack?
 *
 * This was a fetch to `http://127.0.0.1:${port}/`, and it had two blind spots
 * that both showed up in one run:
 *
 *  1. IPv4 ONLY. vite binds `localhost`, which on this machine resolves to
 *     `::1` — an orphaned `vite preview` was sitting on `[::1]:4178` while the
 *     v4 probe reported the port free. The refusal below never fired; instead
 *     `--strictPort` killed the child and the harness died eight lines deep in
 *     a vite stack saying "Port 4178 is already in use". The guard was right
 *     and its diagnosis was thrown away.
 *  2. HTTP ONLY. A process that holds the socket but never completes an HTTP
 *     response reads as "free" to fetch and as "in use" to bind(2). bind is the
 *     thing that actually decides, so ask the same question it asks.
 *
 * A raw TCP connect answers both. It is also strictly more sensitive, which is
 * the correct direction: every false positive here is a port that would have
 * failed the bind anyway.
 */
function portIsBusy(port) {
  const probe = (host) =>
    new Promise((resolve) => {
      const socket = net.connect({ host, port })
      const settle = (busy) => {
        socket.destroy()
        resolve(busy)
      }
      socket.setTimeout(1200)
      socket.once('connect', () => settle(true))
      socket.once('timeout', () => settle(false))
      socket.once('error', () => settle(false))
    })
  return Promise.all([probe('127.0.0.1'), probe('::1')]).then((r) => r.some(Boolean))
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    // /T kills the tree, /F forces it. Without /T the node wrapper dies and the
    // esbuild service it spawned keeps the port.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

/**
 * @param {{ mode?: 'preview' | 'dev', port?: number }} [options]
 * @returns {Promise<{ url: string, stop: () => Promise<void> }>}
 */
export async function startServer(options = {}) {
  const mode = options.mode ?? 'preview'
  const port = options.port ?? (mode === 'preview' ? 4173 : 5173)

  /*
   * Attribution before anything else, and before the browser exists. Measured at
   * ~12 ms on this tree (sha256 over 30 source inputs plus the 4.5 MB of emitted
   * bundle and sourcemap), spent once, before the vite child is even spawned. It
   * therefore cannot land inside any harness's measurement window: fps-bench
   * reads ~1.5 ms frames and its first sample is a browser launch, a page load
   * and a shader pre-warm after this line returns. Do not move it later.
   *
   * PREVIEW ONLY, and that asymmetry is deliberate rather than an oversight: the
   * dev server transforms each module from disk on request, so there is no
   * bundle that can go stale and a freshness refusal there could only be noise.
   * Both branches announce which regime they are in, because "no line printed"
   * and "checked and fine" must not look the same in a log.
   */
  if (mode === 'preview') {
    let freshness
    try {
      freshness = assertBundleMatchesSource(ROOT) // throws; never returns a maybe
    } catch (err) {
      /*
       * Presented as a report and hard-exited, not rethrown. Every harness calls
       * startServer at top level, so an escaping throw prints the finding buried
       * under a Node uncaught-exception banner and a six-frame stack into
       * node:internal — which reads as "the harness crashed" and gets re-run,
       * which is the one response that cannot help.
       *
       * Exit code 2 is `fps-bench`'s code for the same class of event: REFUSED,
       * no reading was produced. It is deliberately not 1, so a log can tell
       * "the instrument declined to measure" from "the measurement failed".
       */
      console.error(`\n${err.message}\n`)
      process.exit(2)
    }
    console.log(`[bundle] ${freshness.line}`)
  } else {
    console.log('[bundle] dev — vite transforms source per request; there is no built bundle to go stale')
  }

  if (await portIsBusy(port)) {
    throw new Error(
      `Port ${port} is already serving something. Refusing to adopt it — an orphaned ` +
        `server from another working tree would feed stale code into this measurement ` +
        `and nothing would report an error. Stop it and re-run.`,
    )
  }

  const child = spawn(
    process.execPath,
    [VITE_BIN, mode, '--port', String(port), '--strictPort'],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      /*
       * NO_COLOR as well as FORCE_COLOR. vite prints its banner as
       * `localhost:<ESC>[1m4173<ESC>[22m/`, and FORCE_COLOR=0 does not suppress
       * that — the port regex below then fails to match and the harness dies
       * thirty seconds later claiming the server never reported a URL. It has
       * not bitten on this machine, but it is a one-word defence against a
       * failure whose message points at entirely the wrong thing.
       */
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    },
  )

  let stderr = ''
  child.stderr.on('data', (b) => {
    stderr += String(b)
  })

  let stdout = ''
  const announcedPort = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killTree(child)
      reject(new Error(`vite ${mode} did not report a URL within 30s.\n${stdout}\n${stderr}`))
    }, 30_000)

    child.stdout.on('data', (buf) => {
      stdout += String(buf)
      const match = stdout.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)\/?/)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    })

    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`vite ${mode} exited with code ${code} before serving.\n${stdout}\n${stderr}`))
    })
  })

  // Announcing a URL and accepting connections on it are two different events,
  // and which host the port is actually bound to varies (127.0.0.1 vs ::1).
  // Poll both until one answers rather than trusting the banner — a harness
  // that races the server it started produces intermittent failures that look
  // like game bugs.
  const url = await (async () => {
    const candidates = [
      `http://127.0.0.1:${announcedPort}/`,
      `http://localhost:${announcedPort}/`,
    ]
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      for (const candidate of candidates) {
        try {
          const res = await fetch(candidate, { signal: AbortSignal.timeout(1000) })
          if (res.ok) return candidate
        } catch {
          /* not up yet */
        }
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    killTree(child)
    throw new Error(
      `vite ${mode} announced port ${announcedPort} but never accepted a connection.\n${stdout}\n${stderr}`,
    )
  })()

  return {
    url,
    async stop() {
      killTree(child)
      await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 3000))])
    },
  }
}
