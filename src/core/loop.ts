import { MAX_CATCHUP_STEPS, SIMULATION_STEP, type Clock, type Seconds } from '../types'

/**
 * Fixed-step accumulator.
 *
 * `fixedUpdate` sees `SIMULATION_STEP` and nothing else, ever. Wall-clock time
 * enters here and stops here. Everything downstream of this file is a pure
 * function of tick count, which is what makes two rounds comparable: the same
 * seed and the same tick produce the same frame regardless of how busy the
 * machine was while producing it.
 *
 * Debt beyond MAX_CATCHUP_STEPS is DROPPED, not repaid. A tab that was
 * backgrounded for thirty seconds must not return and run 3600 physics steps in
 * one frame — that is a freeze, and then a second freeze when the watchdog
 * decides the page is unresponsive.
 */
export interface LoopCallbacks {
  fixedUpdate(step: Seconds): void
  lateUpdate(dt: Seconds): void
}

export interface Loop {
  readonly clock: Clock
  start(): void
  stop(): void
  setPaused(paused: boolean): void
  /**
   * Run exactly `count` ticks and present a frame for each, ignoring the wall
   * clock entirely. This is how the harness advances the game: a deterministic
   * step count is the only way a screenshot taken on round 7 is comparable to
   * the one taken on round 3.
   */
  stepTicks(count: number): Promise<void>
}

class MutableClock implements Clock {
  tick = 0
  simTime: Seconds = 0
  alpha = 0
  paused = false
}

export function createLoop(cb: LoopCallbacks): Loop {
  const clock = new MutableClock()
  let running = false
  let rafId = 0
  let lastMs = 0
  let accumulator: Seconds = 0

  function advanceOneTick(): void {
    cb.fixedUpdate(SIMULATION_STEP)
    clock.tick += 1
    clock.simTime = clock.tick * SIMULATION_STEP
  }

  function frame(nowMs: number): void {
    if (!running) return
    rafId = requestAnimationFrame(frame)

    // Clamp the very first delta and any pathological one. `nowMs - lastMs` on
    // the frame after a tab regains focus can be arbitrarily large.
    const rawDt = lastMs === 0 ? SIMULATION_STEP : (nowMs - lastMs) / 1000
    lastMs = nowMs
    const dt = Math.min(Math.max(rawDt, 0), 0.25)

    if (!clock.paused) {
      accumulator += dt
      let steps = 0
      while (accumulator >= SIMULATION_STEP && steps < MAX_CATCHUP_STEPS) {
        advanceOneTick()
        accumulator -= SIMULATION_STEP
        steps++
      }
      // Drop unrepayable debt rather than spiralling.
      if (accumulator > SIMULATION_STEP * MAX_CATCHUP_STEPS) accumulator = 0
      clock.alpha = accumulator / SIMULATION_STEP
    }

    cb.lateUpdate(dt)
  }

  return {
    clock,
    start(): void {
      if (running) return
      running = true
      lastMs = 0
      accumulator = 0
      rafId = requestAnimationFrame(frame)
    },
    stop(): void {
      running = false
      if (rafId) cancelAnimationFrame(rafId)
      rafId = 0
    },
    setPaused(paused: boolean): void {
      clock.paused = paused
      // Drop accumulated debt on resume; otherwise the game fast-forwards
      // through however long the pause lasted.
      if (!paused) accumulator = 0
    },
    async stepTicks(count: number): Promise<void> {
      /*
       * STOP THE LIVE LOOP FIRST. This is the whole correctness of the method.
       *
       * The first version just ran its ticks and yielded to rAF between them —
       * and the ordinary frame loop was still scheduled on that same rAF, still
       * accumulating wall-clock time, still calling `advanceOneTick` on its own
       * schedule. Every harness "step N ticks" was therefore N ticks PLUS
       * however many the live loop got in edgeways, which depended on how long
       * the machine took.
       *
       * That is not a small error. It made the DETERMINISM guarantee in the
       * contract false for every measurement this project has ever taken: the
       * steering harness saw repeatability spreads between 0.009 m and 0.138 m
       * on a bit-identical binary, and the physics fix that finally exposed it
       * spent its investigation chasing a kart that was being stepped by two
       * drivers at once.
       *
       * Deterministic stepping and a free-running loop cannot both own the
       * clock. While a harness is stepping, it owns it.
       */
      const wasRunning = running
      if (wasRunning) {
        running = false
        if (rafId) cancelAnimationFrame(rafId)
        rafId = 0
      }

      try {
        for (let i = 0; i < count; i++) {
          advanceOneTick()
          clock.alpha = 0
          cb.lateUpdate(SIMULATION_STEP)
          // Yield to the compositor so the frame actually presents. Without this
          // the whole loop collapses into one long task and `readPixels` reads a
          // frame that was never shown.
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        }
      } finally {
        if (wasRunning) {
          // Drop the wall-clock debt accrued while stepping, or the loop
          // fast-forwards through however long the harness took.
          lastMs = 0
          accumulator = 0
          running = true
          rafId = requestAnimationFrame(frame)
        }
      }
    },
  }
}
