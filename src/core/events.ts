import type { EventBus, EventName, GameEvents } from '../types'

type AnyListener = (payload: never) => void

/**
 * Synchronous dispatch, registration order, over a snapshot of the listener
 * list taken at emit time.
 *
 * The snapshot is what makes this safe to reason about: `fx/` unsubscribing
 * itself from inside a `drift:release` handler must not change who else gets
 * that same release. Without it, listener order becomes load-bearing and the
 * bug it causes only appears when two subsystems happen to subscribe in a
 * particular order on a particular round.
 *
 * A throwing listener is logged and the rest still run. One broken effect must
 * not take the audio down with it.
 */
export function createEventBus(): EventBus {
  const listeners = new Map<EventName, AnyListener[]>()

  return {
    on<K extends EventName>(name: K, fn: (payload: GameEvents[K]) => void): () => void {
      let list = listeners.get(name)
      if (!list) {
        list = []
        listeners.set(name, list)
      }
      list.push(fn as AnyListener)
      return () => {
        const current = listeners.get(name)
        if (!current) return
        const i = current.indexOf(fn as AnyListener)
        if (i >= 0) current.splice(i, 1)
      }
    },

    emit<K extends EventName>(name: K, payload: GameEvents[K]): void {
      const list = listeners.get(name)
      if (!list || list.length === 0) return
      // Copy before dispatch — see the note above.
      const snapshot = list.slice()
      for (const fn of snapshot) {
        try {
          ;(fn as (p: GameEvents[K]) => void)(payload)
        } catch (err) {
          console.error(`[events] listener for "${name}" threw`, err)
        }
      }
    },

    clear(): void {
      listeners.clear()
    },
  }
}
