/**
 * The only sanctioned way for a harness to get a server.
 *
 * Three things it does that `npx vite` does not:
 *
 *  1. Spawns the vite binary directly, so there is no npx/npm shim sitting
 *     between us and the process we later have to kill.
 *  2. Kills the whole process tree on teardown. A surviving vite holds the port
 *     and the next harness run silently measures the previous build.
 *  3. REFUSES to adopt a server that is already listening. Adopting one is how
 *     an orphaned server from another worktree ends up serving stale code into
 *     every measurement for an entire round, with no error anywhere.
 */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..')

const VITE_BIN = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')

async function portIsBusy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1200),
    })
    return res.ok || res.status < 500
  } catch {
    return false
  }
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
