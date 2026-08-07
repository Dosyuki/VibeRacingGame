import type { Ctx, IItems, ItemKind, ItemsFactory, Seconds, Subsystem } from '../types'

/**
 * Items — a deliberate, declared stub.
 *
 * `GameServices` requires an `IItems`, so something has to satisfy the shape or
 * nothing composes. This is that something, and it is written as an explicit
 * no-op rather than left out with a `null` and a cast, because the shape of the
 * lie matters: a cast would let a caller believe items work and get silence,
 * while this at least reports `'none'` truthfully to anyone who asks.
 *
 * What it does NOT do is pretend. `grant` and `use` are inert. Nothing rolls,
 * nothing fires, no `item:pickup` / `item:use` / `item:hit` event is ever
 * emitted — so `fx/`, `ui/` and `audio/` will correctly show nothing rather
 * than showing a roulette that resolves to a weapon that does not exist.
 *
 * The one thing to be careful about when this is replaced: `IItems.grant` reads
 * the standings itself through `GameServices.race` rather than being handed a
 * place. The contract says why — two subsystems sampling standings at different
 * moments roll different items, and the difference is invisible.
 */
export const createItems: ItemsFactory = (_ctx: Ctx): IItems & Subsystem => {
  return {
    name: 'game/items',
    build(): void {
      /* nothing to build */
    },
    step(_step: Seconds): void {
      /* nothing to step */
    },
    held(_kartId: number): ItemKind {
      return 'none'
    },
    grant(_kartId: number, _tick: number): void {
      /* inert — see the note above */
    },
    use(_kartId: number): void {
      /* inert */
    },
    reset(): void {
      /* nothing to reset */
    },
    update(): void {
      /* nothing per tick */
    },
    dispose(): void {
      /* nothing to free */
    },
  } as IItems & Subsystem
}
