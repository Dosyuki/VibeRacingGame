import type { RNG } from '../types'

/**
 * Per-namespace deterministic streams.
 *
 * The namespace string is hashed together with the world seed, so a stream
 * depends only on *who asked* and *which world* — never on when they asked
 * relative to anyone else. That is the whole point: one shared stream plus one
 * added `await` inside somebody's `build` shifts every subsequent draw and
 * silently rebuilds a different city from an identical seed. Nothing about the
 * resulting frame says why it changed.
 */

/** FNV-1a. Stable across runs and platforms, which `String.hashCode` is not. */
function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    // 32-bit FNV prime multiply, kept in integer range via Math.imul.
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32 — small, fast, and good enough for scenery placement. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeRng(namespace: string, seed: number): RNG {
  const next = mulberry32(hashString(namespace) ^ (seed >>> 0))
  const rng = (() => next()) as RNG
  Object.defineProperty(rng, 'namespace', { value: namespace, enumerable: true })
  Object.defineProperty(rng, 'fork', {
    value: (sub: string) => makeRng(`${namespace}/${sub}`, seed),
  })
  return rng
}

/**
 * Streams are memoised per namespace so that two calls with the same name in
 * the same world return the *same* stream rather than two identical ones — two
 * callers unknowingly sharing a namespace should collide loudly in review, not
 * quietly produce duplicate scenery.
 */
export function createRngFactory(seed: number): (namespace: string) => RNG {
  const cache = new Map<string, RNG>()
  return (namespace: string): RNG => {
    let rng = cache.get(namespace)
    if (!rng) {
      rng = makeRng(namespace, seed)
      cache.set(namespace, rng)
    }
    return rng
  }
}
