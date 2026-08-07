import {
  SIMULATION_STEP,
  type Clock,
  type Ctx,
  type IInput,
  type InputFactory,
  type InputFrame,
  type InputKind,
  type Seconds,
  type Subsystem,
} from '../types'

/**
 * INPUT — keyboard, touch and gamepad, collapsed into one `InputFrame`.
 *
 * STEERING SIGN, restated because this is the file that first produces it:
 * `steer > 0` means THE DRIVER WANTS TO GO RIGHT. That is the whole of this
 * file's obligation. It does not know which way yaw increases, whether the
 * chassis quaternion is left- or right-handed, or what `IKart.step` does with
 * the number — and it must not learn, because the moment an input file
 * "corrects" for a kart that turns the wrong way there are two negations in the
 * codebase and both of them look right. `tools/steer-test.mjs` asserts the whole
 * chain; if it fails, the bug is downstream of here, not here.
 *
 * Concretely: right arrow, D, the stick pushed right, and a finger dragged
 * right all produce a POSITIVE number. The only `-` on a steer value below is
 * the one that folds the left-hand key onto the same axis as the right-hand
 * one, which is not a convention flip.
 *
 * ---------------------------------------------------------------------------
 * WALL CLOCK
 * `performance.now()` appears in this file and only ever flows into
 * `lastEventAtMs`. That value is wall-clock BY DEFINITION — it is the instrument
 * the latency harness reads, and a fixed-step tick counter cannot answer "how
 * long ago did the finger move". It never reaches `steer`, `throttle`, `brake`
 * or any ramp: every rate below integrates `SIMULATION_STEP`, so the same key
 * held for the same number of ticks produces the same steer angle on every
 * machine, however busy it was.
 *
 * ALLOCATION
 * `sample()` allocates nothing. All scratch is created once, in the factory,
 * and lives in the closure rather than at module scope. That is a deliberate
 * deviation from "module-scope scratch only": the harness builds and tears down
 * the world repeatedly, and module-scope state shared between an outgoing
 * instance and its replacement is a cross-run leak that presents as an input
 * bug in the *next* run. Closure state is allocated once per world and never
 * per call, which is the reason the rule exists.
 *
 * The one allocation this file cannot avoid is `navigator.getGamepads()`, which
 * returns a fresh array on every call in every engine. It is gated behind an
 * actually-present gamepad, so keyboard and touch players never pay it.
 */

// ---------------------------------------------------------------------------
// Keyboard tuning
// ---------------------------------------------------------------------------
/**
 * A key is a step function and a steering rack is not. Feeding `steer = ±1` on
 * the frame a key goes down gives a kart that can only be pointed at three
 * angles — hard left, straight, hard right — which is the single most common
 * reason a keyboard racer feels unplaceable. Everything here exists to give a
 * digital key an analogue middle.
 *
 * ATTACK 4.0/s — 250 ms centre to full lock; 30 ticks of resolution at 120 Hz.
 * A tap is a nudge, a hold is a full lock, and the space between them is where
 * placing a line lives. Above ~6/s the middle disappears again; below ~3/s the
 * kart feels like it is steering through treacle.
 *
 * RELEASE 9.0/s — 111 ms back to centre, deliberately 2.25x the attack, and
 * this asymmetry is the important one. A rack that unwinds as slowly as it
 * winds on keeps turning after the player has let go, which reads as the game
 * ignoring them; it is the "floaty" complaint in nearly every keyboard racer
 * that has one. Centring must always be the fastest thing the wheel does.
 *
 * COUNTER 14.0/s — used only while crossing centre toward the opposite lock. A
 * mid-corner correction is the one steering input whose delay a player can
 * actually feel, and making them sit through a 250 ms unwind before the new
 * direction even begins is 250 ms of the kart doing the wrong thing.
 *
 * KICK 0.12 — applied on the tick a steer key first goes down, and only from
 * near centre. Two reasons. It puts a non-zero steer on the very first tick
 * after the keydown, so ART_DIRECTION §10c criterion 7 (steer latency under
 * 50 ms) measures the input path rather than the ramp's integration; and a
 * response that starts at literally zero feels like a dropped keypress even
 * when the event arrived on time. Restricting it to |steer| < KICK keeps it
 * from becoming a snap across centre during a counter-steer, which is what the
 * COUNTER rate is for.
 *
 * What those four numbers actually produce, at 120 Hz:
 *   first tick after keydown  0.153   (non-zero, which is the whole point)
 *   50 ms after keydown       0.320
 *   centre to full lock       225 ms
 *   full lock to centre       117 ms
 *   full lock across centre    75 ms
 *   lock to opposite lock     292 ms
 */
const STEER_ATTACK_PER_SEC = 4.0
const STEER_RELEASE_PER_SEC = 9.0
const STEER_COUNTER_PER_SEC = 14.0
const STEER_KICK = 0.12

/*
 * Throttle and brake do NOT ramp. They are digital in the fiction as well as in
 * the hardware — a kart pedal is on or off — and a throttle ramp costs
 * acceleration at every corner exit while buying nothing, because there is no
 * "partly forward" line to hold. Steering is the only axis a keyboard has to
 * fake.
 */

// ---------------------------------------------------------------------------
// Touch layout
// ---------------------------------------------------------------------------
type Rect = readonly [number, number, number, number]

/**
 * Normalised viewport rectangles, `[x0, y0, x1, y1]`, origin top-left.
 *
 * Exported so `src/ui/` can draw the controls over the geometry that actually
 * receives the pointers. It cannot import this — sibling imports are banned and
 * `ui/` is a sibling of `core/` — which is a real gap in the contract, written
 * up rather than worked around. Until it is closed these fractions are the
 * shared source of truth by convention: a touch control drawn somewhere other
 * than where it is hit-tested is invisible to every harness and instantly
 * obvious to every player.
 *
 * The steer zone stops short of the top of the screen so the lap counter and
 * the position readout (§8, top-left and left-centre) are not a steering
 * surface. The zones are disjoint on purpose; overlapping them makes hit-test
 * order load-bearing, and hit-test order is not something a player can see.
 */
export const TOUCH_LAYOUT: Readonly<Record<'steer' | 'throttle' | 'brake' | 'drift' | 'item', Rect>> = {
  steer: [0.0, 0.22, 0.45, 1.0],
  throttle: [0.8, 0.55, 1.0, 1.0],
  brake: [0.6, 0.78, 0.8, 1.0],
  drift: [0.6, 0.55, 0.8, 0.78],
  item: [0.6, 0.33, 1.0, 0.55],
}

/**
 * Fraction of the viewport's SHORT edge the thumb travels for full lock,
 * clamped to a sane pixel range. Keyed to the short edge because it is a thumb
 * reach and not a screen size: the same phone rotated must not change the gain.
 */
const STEER_RADIUS_FRACTION = 0.14
const STEER_RADIUS_MIN_PX = 40
const STEER_RADIUS_MAX_PX = 96
/** Pixels of slop at the stick origin. Small — a resting thumb jitters 1-2 px. */
const STEER_TOUCH_DEADZONE_PX = 3

/*
 * Touch steer is passed through LINEARLY and with no smoothing.
 *
 * The temptation is an expo curve for fine control near centre. Declined: a
 * curve is an undeclared transform sitting between the finger and every
 * assertion anyone makes about steering, and this project grades steering with
 * a harness. Precision comes from the stick radius, which is a stated number.
 * Smoothing is declined for the plainer reason that §10c criterion 7 budgets
 * 50 ms end to end and a filter spends it.
 */

// ---------------------------------------------------------------------------
// Gamepad tuning
// ---------------------------------------------------------------------------
/**
 * Radial deadzone on the stick, RESCALED rather than clipped: with a plain clip
 * the first value outside the deadzone is 0.18 and the kart twitches. The
 * rescale makes the stick leave centre at zero.
 */
const STICK_DEADZONE = 0.18
/** Triggers rest at 0, but rarely at exactly 0. Enough to kill the idle creep. */
const TRIGGER_DEADZONE = 0.05
/** Movement below this is noise, not a hardware event worth timestamping. */
const GAMEPAD_EPSILON = 1e-3
/**
 * Ticks between speculative `getGamepads()` polls while no `gamepadconnected`
 * event has ever fired. A pad connected before the page loaded is invisible
 * until it is touched, and some engines only fire the event after a button
 * press. 60 ticks is twice a second: two array allocations a second on a
 * machine with no pad, and a pad found within half a second when there is one.
 */
const GAMEPAD_PROBE_TICKS = 60

// ---------------------------------------------------------------------------
// Identifiers — plain ints so the pointer and key tables can be typed arrays
// ---------------------------------------------------------------------------
const CONTROL_NONE = 0
const CONTROL_STEER = 1
const CONTROL_THROTTLE = 2
const CONTROL_BRAKE = 3
const CONTROL_DRIFT = 4
const CONTROL_ITEM = 5
const CONTROL_COUNT = 6

const KEY_NONE = 0
const KEY_LEFT = 1
const KEY_RIGHT = 2
const KEY_THROTTLE = 3
const KEY_BRAKE = 4
const KEY_DRIFT = 5
const KEY_ITEM = 6
const KEY_LOOK_BACK = 7
const KEY_LOOK_AHEAD = 8
const KEY_COUNT = 9

/**
 * Ten simultaneous pointers. Phones report up to ten, and a hand resting on the
 * glass makes more contacts than the player thinks they are making.
 */
const MAX_POINTERS = 10

/**
 * Keys are classified by `event.code`, the PHYSICAL key, never `event.key`.
 *
 * On AZERTY, `event.key` for the key where W sits is "z", so a `key`-based
 * WASD map hands a French player a steering wheel made of Z, Q, S and D with no
 * way to discover it. `code` puts every layout's three fingers on the same
 * three keys, which is the entire point of the map.
 */
function classifyKey(code: string): number {
  switch (code) {
    case 'ArrowLeft':
    case 'KeyA':
      return KEY_LEFT
    case 'ArrowRight':
    case 'KeyD':
      return KEY_RIGHT
    case 'ArrowUp':
    case 'KeyW':
      return KEY_THROTTLE
    case 'ArrowDown':
    case 'KeyS':
      return KEY_BRAKE
    case 'Space':
    case 'ShiftLeft':
    case 'ShiftRight':
      return KEY_DRIFT
    case 'KeyE':
    case 'Enter':
      return KEY_ITEM
    case 'KeyC':
      return KEY_LOOK_BACK
    case 'KeyV':
      return KEY_LOOK_AHEAD
    default:
      return KEY_NONE
  }
}

// ---------------------------------------------------------------------------
// Standard-mapping gamepad indices
// ---------------------------------------------------------------------------
const BTN_SOUTH = 0
const BTN_EAST = 1
const BTN_WEST = 2
const BTN_L1 = 4
const BTN_R1 = 5
const BTN_L2 = 6
const BTN_R2 = 7
const BTN_DPAD_LEFT = 14
const BTN_DPAD_RIGHT = 15
const AXIS_LEFT_X = 0
const AXIS_RIGHT_Y = 3

/** Chrome's coalesced-event accessor, typed defensively — see trap 2 below. */
interface CoalescingPointerEvent {
  getCoalescedEvents?(): PointerEvent[]
}

// ---------------------------------------------------------------------------
// Pure helpers. Called from `sample`; none of them allocate.
// ---------------------------------------------------------------------------

function clamp1(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function inRect(nx: number, ny: number, r: Rect): boolean {
  return nx >= r[0] && nx < r[2] && ny >= r[1] && ny < r[3]
}

/** Deadzone with rescale — see STICK_DEADZONE. */
function applyDeadzone(v: number, dead: number): number {
  const a = v < 0 ? -v : v
  if (a <= dead) return 0
  const scaled = (a - dead) / (1 - dead)
  return v < 0 ? -scaled : scaled
}

function buttonValue(gp: Gamepad, index: number): number {
  const b = gp.buttons[index]
  if (!b) return 0
  // `value` is the analogue one and reads 0/1 on a digital button, so this
  // covers both. `pressed` alone would throw away all the trigger travel.
  return b.value > 0 ? b.value : b.pressed ? 1 : 0
}

function axisValue(gp: Gamepad, index: number): number {
  const a = gp.axes[index]
  return a === undefined ? 0 : a
}

/**
 * One integration step of the keyboard steering rack. Takes `SIMULATION_STEP`,
 * never a wall-clock delta — the ramp is part of the simulation and two
 * machines must reach the same angle after the same number of ticks.
 */
function rampSteer(current: number, target: number, step: Seconds): number {
  if (target === 0) {
    const d = STEER_RELEASE_PER_SEC * step
    if (current > d) return current - d
    if (current < -d) return current + d
    return 0
  }
  // Crossing centre toward the other lock is the correction case; take it fast.
  const rate = current * target < 0 ? STEER_COUNTER_PER_SEC : STEER_ATTACK_PER_SEC
  const d = rate * step
  if (target > current) return current + d > target ? target : current + d
  if (target < current) return current - d < target ? target : current - d
  return current
}

/**
 * True when the event landed on something `ui/` owns. Steering must not start
 * because the player pressed Pause, and a button that is also a steering
 * surface is unusable. `ui/` opts a node out by being a real interactive
 * element or by carrying `data-ui-interactive`.
 */
function isUiTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return target.closest('button, a, input, select, textarea, [data-ui-interactive]') !== null
}

/** Typing in a text field must not drive the kart. */
function isTextEntryFocused(): boolean {
  const el = document.activeElement
  if (!el) return false
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return true
  return el instanceof HTMLElement && el.isContentEditable
}

// ---------------------------------------------------------------------------

export const createInput: InputFactory = (ctx: Ctx): IInput & Subsystem => {
  // Everything below is allocated exactly once, here. `sample` reads and writes
  // it and allocates nothing.

  const frame: InputFrame = {
    steer: 0,
    throttle: 0,
    brake: 0,
    drift: false,
    useItem: false,
    look: 0,
  }

  let kind: InputKind = 'keyboard'
  let lastEventAtMs = 0

  // --- keyboard ---
  const keyHeld = new Uint8Array(KEY_COUNT)
  let keySteer = 0
  let prevKeySteerTarget = 0

  // --- touch ---
  // Parallel tables rather than a Map: an out-of-order `pointerup` has to find
  // its own slot by id, and a linear scan of ten ints is both faster and easier
  // to reason about than a Map whose iteration order nobody should depend on.
  const ptrId = new Int32Array(MAX_POINTERS).fill(-1)
  const ptrControl = new Int32Array(MAX_POINTERS)
  /**
   * Held COUNT per control, not a boolean. Two fingers on the throttle, one
   * lifted, must leave it held; a boolean turns that into a stuck-or-dropped
   * pedal depending on which contact the browser reports first.
   */
  const touchHeld = new Int32Array(CONTROL_COUNT)
  let steerPointerId = -1
  let steerOriginX = 0
  let steerValue = 0

  // --- one-tick item pulse, shared by every device ---
  let itemPending = false
  let keyItemLatched = false
  let padItemLatched = false

  // --- gamepad ---
  let gamepadSeen = false
  let gamepadIndex = -1
  let probeCountdown = 0
  let padSteer = 0
  let padThrottle = 0
  let padBrake = 0
  let padDrift = false
  let padLook = 0
  // Previous poll, for change detection. A pad's `timestamp` advances on every
  // poll in some engines whether or not anything moved, so it cannot itself be
  // the change signal — only the timing of a change detected some other way.
  let prevPadSteer = 0
  let prevPadThrottle = 0
  let prevPadBrake = 0
  let prevPadDriftDown = false
  let prevPadItemDown = false
  let prevPadLook = 0

  /**
   * Guards double consumption of the one-tick item pulse. If `sample` runs
   * twice for the same tick — a composition root calling both `sample` and
   * `fixedUpdate`, a harness stepping by hand — the second call would clear a
   * pulse the kart never saw, and item presses would vanish at random.
   */
  let lastSampledTick = -1

  const teardown: Array<() => void> = []
  let disposed = false

  /**
   * The only place wall clock enters this file.
   *
   * `performance.now()` at listener entry, deliberately, and not
   * `event.timeStamp`. `timeStamp` is stamped when the event was CREATED, which
   * is earlier and therefore flattering — it excludes the queueing delay that is
   * most of what a player experiences as input lag. The contract asks when the
   * event was RECEIVED. This is that, honestly.
   */
  function markEvent(from: InputKind): void {
    lastEventAtMs = performance.now()
    if (kind !== from) kind = from
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  function onKeyDown(e: KeyboardEvent): void {
    if (isTextEntryFocused()) return
    const k = classifyKey(e.code)
    if (k === KEY_NONE) return
    // Arrows scroll the page and Space scrolls it a screenful at a time. On a
    // full-viewport canvas that is invisible until the layout shifts under the
    // renderer. Claim only the keys actually mapped.
    e.preventDefault()
    // `repeat` is OS auto-repeat firing at the keyboard repeat rate; it would
    // re-trigger the steer kick and the item pulse dozens of times a second.
    // The key is already down and there is nothing new in it.
    if (e.repeat) return
    keyHeld[k] = 1
    if (k === KEY_ITEM && !keyItemLatched) {
      keyItemLatched = true
      itemPending = true
    }
    markEvent('keyboard')
  }

  function onKeyUp(e: KeyboardEvent): void {
    const k = classifyKey(e.code)
    if (k === KEY_NONE) return
    keyHeld[k] = 0
    if (k === KEY_ITEM) keyItemLatched = false
    markEvent('keyboard')
  }

  // -------------------------------------------------------------------------
  // Touch
  // -------------------------------------------------------------------------
  //
  // Three browser behaviours, all of them failures somebody has already paid
  // for:
  //
  // 1. `touch-action` does not inherit, but its EFFECT is the intersection of
  //    the declared values up the whole ancestor chain. Declaring it on the
  //    controls alone leaves an ancestor free to claim the drag as a scroll or
  //    a pinch, and the first symptom is steering that dies mid-corner on one
  //    device and works everywhere else. `index.html` sets `touch-action: none`
  //    on `html`, which is the only place that reliably stops it, and this file
  //    depends on that and does not duplicate it. What this file adds is
  //    `preventDefault` on pointerdown/pointermove inside a zone, which kills
  //    the compatibility mouse events and the double-tap zoom that survive
  //    `touch-action` regardless — and that is why those two listeners are
  //    registered explicitly non-passive.
  //
  // 2. Chrome COALESCES pointermove within a frame. A slow, careful drag
  //    dispatches fewer moves than the digitiser produced and the dispatched
  //    event is a merge of the batch rather than the newest sample.
  //    `getCoalescedEvents()` returns the raw ones; the LAST of them is where
  //    the finger actually is. Using the dispatched event's coordinates lags the
  //    stick by up to a frame — a fifth of the §10c criterion 7 budget spent on
  //    nothing.
  //
  // 3. Multi-touch releases arrive out of order. A `pointerup` is NOT the
  //    partner of the most recent `pointerdown`. Every contact is tracked by its
  //    `pointerId` and released only against its own id, so lifting the steering
  //    thumb while the throttle thumb stays down cannot strand the throttle
  //    held. Anything that could orphan a contact — `pointercancel`,
  //    `lostpointercapture`, losing the window, the tab going to background —
  //    releases everything.

  function zoneAt(nx: number, ny: number): number {
    if (inRect(nx, ny, TOUCH_LAYOUT.steer)) return CONTROL_STEER
    if (inRect(nx, ny, TOUCH_LAYOUT.throttle)) return CONTROL_THROTTLE
    if (inRect(nx, ny, TOUCH_LAYOUT.brake)) return CONTROL_BRAKE
    if (inRect(nx, ny, TOUCH_LAYOUT.drift)) return CONTROL_DRIFT
    if (inRect(nx, ny, TOUCH_LAYOUT.item)) return CONTROL_ITEM
    return CONTROL_NONE
  }

  function steerRadiusPx(): number {
    const short = Math.min(window.innerWidth, window.innerHeight)
    const r = short * STEER_RADIUS_FRACTION
    return r < STEER_RADIUS_MIN_PX ? STEER_RADIUS_MIN_PX : r > STEER_RADIUS_MAX_PX ? STEER_RADIUS_MAX_PX : r
  }

  function findSlot(id: number): number {
    for (let i = 0; i < MAX_POINTERS; i++) if (ptrId[i]! === id) return i
    return -1
  }

  function releaseSlot(i: number): void {
    const control = ptrControl[i]!
    if (control !== CONTROL_NONE && touchHeld[control]! > 0) {
      touchHeld[control] = touchHeld[control]! - 1
    }
    if (control === CONTROL_STEER && ptrId[i]! === steerPointerId) {
      steerPointerId = -1
      steerValue = 0
    }
    ptrId[i] = -1
    ptrControl[i] = CONTROL_NONE
  }

  function releaseAllPointers(): void {
    for (let i = 0; i < MAX_POINTERS; i++) {
      ptrId[i] = -1
      ptrControl[i] = CONTROL_NONE
    }
    for (let c = 0; c < CONTROL_COUNT; c++) touchHeld[c] = 0
    steerPointerId = -1
    steerValue = 0
  }

  /**
   * Pen counts as touch; mouse does not, or a desktop player clicking the
   * bottom-right of the screen floors the throttle. `?input=touch` promotes the
   * mouse so the touch layout can be driven on a desktop without a phone in
   * hand. The harness needs no flag — it dispatches pointer events with
   * `pointerType: 'touch'`, which is the real path.
   */
  const mouseIsTouch = new URLSearchParams(location.search).get('input') === 'touch'
  function isTouchPointer(e: PointerEvent): boolean {
    return (
      e.pointerType === 'touch' ||
      e.pointerType === 'pen' ||
      (mouseIsTouch && e.pointerType === 'mouse')
    )
  }

  function onPointerDown(e: PointerEvent): void {
    if (!isTouchPointer(e)) return
    if (isUiTarget(e.target)) return
    const nx = e.clientX / window.innerWidth
    const ny = e.clientY / window.innerHeight
    const control = zoneAt(nx, ny)
    if (control === CONTROL_NONE) return

    let slot = findSlot(e.pointerId)
    if (slot === -1) slot = findSlot(-1)
    // More than ten live contacts: drop the newest rather than evict a control
    // somebody is holding, which is the stuck-pedal bug wearing a new hat.
    if (slot === -1) return

    ptrId[slot] = e.pointerId
    ptrControl[slot] = control
    touchHeld[control] = touchHeld[control]! + 1

    if (control === CONTROL_STEER) {
      // Relative origin, not an absolute stick: the thumb lands where the thumb
      // lands, and an absolute stick makes the first touch of every corner a
      // full-lock input.
      steerPointerId = e.pointerId
      steerOriginX = e.clientX
      steerValue = 0
    } else if (control === CONTROL_ITEM) {
      itemPending = true
    }

    // Non-passive on purpose — see trap 1.
    e.preventDefault()
    markEvent('touch')
  }

  function applySteerSample(clientX: number): void {
    const dx = clientX - steerOriginX
    if (dx > -STEER_TOUCH_DEADZONE_PX && dx < STEER_TOUCH_DEADZONE_PX) {
      steerValue = 0
      return
    }
    const beyond = dx > 0 ? dx - STEER_TOUCH_DEADZONE_PX : dx + STEER_TOUCH_DEADZONE_PX
    const radius = steerRadiusPx()
    const raw = beyond / radius
    steerValue = clamp1(raw)
    // Origin drag: past full lock the origin follows the finger, so releasing
    // back toward centre starts unwinding immediately instead of after however
    // far past the edge the thumb wandered. Without this a long corner leaves a
    // dead region at the end of the stick's travel and the player cannot find
    // centre again — which reads as steering that has stopped responding.
    if (raw > 1) steerOriginX = clientX - radius - STEER_TOUCH_DEADZONE_PX
    else if (raw < -1) steerOriginX = clientX + radius + STEER_TOUCH_DEADZONE_PX
  }

  function onPointerMove(e: PointerEvent): void {
    if (!isTouchPointer(e)) return
    if (e.pointerId !== steerPointerId) return

    // Trap 2. `getCoalescedEvents` allocates, which is fine — this is an event
    // handler, not `sample`, and the allocation rule names the hot paths.
    const ce = e as unknown as CoalescingPointerEvent
    if (typeof ce.getCoalescedEvents === 'function') {
      const list = ce.getCoalescedEvents()
      const last = list.length > 0 ? list[list.length - 1] : undefined
      applySteerSample(last ? last.clientX : e.clientX)
    } else {
      applySteerSample(e.clientX)
    }

    e.preventDefault()
    markEvent('touch')
  }

  function onPointerUp(e: PointerEvent): void {
    // Trap 3. Release by id, never by recency.
    const slot = findSlot(e.pointerId)
    if (slot === -1) return
    releaseSlot(slot)
    markEvent('touch')
  }

  function onWindowBlur(): void {
    // A key held when the window loses focus never delivers its keyup. Without
    // this the kart drives into a wall while the player is in another tab, and
    // they come back to a race already lost.
    keyHeld.fill(0)
    keyItemLatched = false
    prevKeySteerTarget = 0
    releaseAllPointers()
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === 'hidden') onWindowBlur()
  }

  function onGamepadConnected(): void {
    gamepadSeen = true
  }

  function onGamepadDisconnected(): void {
    gamepadIndex = -1
    padSteer = 0
    padThrottle = 0
    padBrake = 0
    padDrift = false
    padLook = 0
    padItemLatched = false
  }

  // -------------------------------------------------------------------------
  // Gamepad — the API has no events for axis or button state, only for
  // connection, so it is polled from `sample` and nowhere else.
  // -------------------------------------------------------------------------

  function pollGamepad(): void {
    if (!gamepadSeen) {
      if (probeCountdown > 0) {
        probeCountdown--
        return
      }
      probeCountdown = GAMEPAD_PROBE_TICKS
      if (typeof navigator.getGamepads !== 'function') return
    }

    const pads = navigator.getGamepads()
    let gp: Gamepad | null = gamepadIndex >= 0 ? (pads[gamepadIndex] ?? null) : null
    if (!gp || !gp.connected) {
      gp = null
      for (let i = 0; i < pads.length; i++) {
        const candidate = pads[i]
        if (candidate && candidate.connected) {
          gp = candidate
          gamepadIndex = i
          gamepadSeen = true
          break
        }
      }
    }
    if (!gp) {
      gamepadIndex = -1
      return
    }

    /*
     * A pad reporting a non-standard mapping has unknown button indices. The
     * sticks and the first two face buttons are conventional enough to be worth
     * using; the triggers are not, so the fallback reads face buttons rather
     * than treating a garbage axis as throttle.
     */
    const standard = gp.mapping === 'standard'

    // Stick right is positive in the standard mapping, and `steer > 0` is the
    // driver's right. They already agree. There is nothing here to negate.
    let steer = applyDeadzone(axisValue(gp, AXIS_LEFT_X), STICK_DEADZONE)
    if (standard) {
      // The d-pad is a legitimate steering input and it is digital, so it goes
      // to full lock. Someone playing on a d-pad asked for exactly that.
      if (buttonValue(gp, BTN_DPAD_LEFT) > 0.5) steer = -1
      else if (buttonValue(gp, BTN_DPAD_RIGHT) > 0.5) steer = 1
    }
    steer = clamp1(steer)

    const throttle = standard
      ? clamp01(
          Math.max(applyDeadzone(buttonValue(gp, BTN_R2), TRIGGER_DEADZONE), buttonValue(gp, BTN_SOUTH)),
        )
      : clamp01(buttonValue(gp, BTN_SOUTH))
    const brake = standard
      ? clamp01(
          Math.max(applyDeadzone(buttonValue(gp, BTN_L2), TRIGGER_DEADZONE), buttonValue(gp, BTN_EAST)),
        )
      : clamp01(buttonValue(gp, BTN_EAST))
    const driftDown = standard
      ? buttonValue(gp, BTN_L1) > 0.5 || buttonValue(gp, BTN_R1) > 0.5
      : buttonValue(gp, BTN_WEST) > 0.5
    const itemDown = standard ? buttonValue(gp, BTN_WEST) > 0.5 : false
    // Stick forward is negative Y; forward means looking ahead, which is +1.
    const look = standard ? -applyDeadzone(axisValue(gp, AXIS_RIGHT_Y), STICK_DEADZONE) : 0

    const moved =
      Math.abs(steer - prevPadSteer) > GAMEPAD_EPSILON ||
      Math.abs(throttle - prevPadThrottle) > GAMEPAD_EPSILON ||
      Math.abs(brake - prevPadBrake) > GAMEPAD_EPSILON ||
      Math.abs(look - prevPadLook) > GAMEPAD_EPSILON ||
      driftDown !== prevPadDriftDown ||
      itemDown !== prevPadItemDown

    padSteer = steer
    padThrottle = throttle
    padBrake = brake
    padDrift = driftDown
    padLook = look

    // Rising edge only. The pulse is one tick; a held button is not a stream of
    // uses, and latching here is what stops it becoming one.
    if (itemDown && !padItemLatched) {
      padItemLatched = true
      itemPending = true
    } else if (!itemDown) {
      padItemLatched = false
    }

    prevPadSteer = steer
    prevPadThrottle = throttle
    prevPadBrake = brake
    prevPadDriftDown = driftDown
    prevPadItemDown = itemDown
    prevPadLook = look

    if (!moved) return

    /*
     * A polled device has no receipt time of its own, so the API's `timestamp`
     * is the closest thing to one: the moment the user agent last refreshed the
     * pad's state, in the `performance.now()` time origin, and genuinely earlier
     * than this poll. It is trusted only while it is plausible — some engines
     * report 0, some report a different epoch, and a `lastEventAtMs` in the
     * future or an hour in the past would silently corrupt the one number
     * another instrument reads out of this file.
     */
    const nowMs = performance.now()
    const ts = gp.timestamp
    lastEventAtMs = ts > 0 && ts <= nowMs && nowMs - ts < 1000 ? ts : nowMs
    kind = 'gamepad'
  }

  // -------------------------------------------------------------------------

  function sample(clock: Clock): void {
    // Idempotent within a tick — see `lastSampledTick`.
    if (clock.tick === lastSampledTick) return
    lastSampledTick = clock.tick

    pollGamepad()

    // The keyboard rack integrates every tick regardless of which device is
    // active, so a player who reaches for the pad mid-race and comes back finds
    // the wheel already centred rather than wherever they abandoned it.
    const target = (keyHeld[KEY_RIGHT]! ? 1 : 0) - (keyHeld[KEY_LEFT]! ? 1 : 0)
    if (target !== 0 && target !== prevKeySteerTarget && Math.abs(keySteer) < STEER_KICK) {
      keySteer = STEER_KICK * target
    }
    prevKeySteerTarget = target
    keySteer = rampSteer(keySteer, target, SIMULATION_STEP)

    let steer = 0
    let throttle = 0
    let brake = 0
    let drift = false
    let look = 0

    /*
     * Exactly one device drives the frame: the one most recently used.
     *
     * Summing them looks friendlier and is not. Two devices feeding one axis
     * means a gamepad resting a hair outside its deadzone permanently biases the
     * keyboard, and a touch control left held under a palm fights every other
     * input with nothing on screen to say why.
     */
    if (kind === 'gamepad') {
      steer = padSteer
      throttle = padThrottle
      brake = padBrake
      drift = padDrift
      look = padLook
    } else if (kind === 'touch') {
      steer = steerPointerId !== -1 ? steerValue : 0
      throttle = touchHeld[CONTROL_THROTTLE]! > 0 ? 1 : 0
      brake = touchHeld[CONTROL_BRAKE]! > 0 ? 1 : 0
      drift = touchHeld[CONTROL_DRIFT]! > 0
      look = 0
    } else {
      steer = keySteer
      throttle = keyHeld[KEY_THROTTLE]! ? 1 : 0
      brake = keyHeld[KEY_BRAKE]! ? 1 : 0
      drift = keyHeld[KEY_DRIFT]! === 1
      look = (keyHeld[KEY_LOOK_AHEAD]! ? 1 : 0) - (keyHeld[KEY_LOOK_BACK]! ? 1 : 0)
    }

    frame.steer = clamp1(steer)
    frame.throttle = clamp01(throttle)
    frame.brake = clamp01(brake)
    frame.drift = drift
    frame.look = clamp1(ctx.settings.invertLook ? -look : look)

    // ONE-TICK PULSE. Set for exactly this tick and cleared here, so `game/` is
    // the only consumer and nothing downstream has to edge-detect a level that
    // was never a level.
    frame.useItem = itemPending
    itemPending = false
  }

  function build(): void {
    if (disposed) return

    /*
     * Listeners live on `window`, in the CAPTURE phase, not on the canvas.
     *
     * `ui/` puts a full-screen HUD overlay above the canvas; anything bound to
     * `renderer.domElement` then receives no pointer events at all and touch
     * steering is simply dead, with nothing in a screenshot to say why. Capture
     * also means a `stopPropagation` somewhere in the HUD cannot quietly take
     * the controls away. `isUiTarget` is what gives real buttons back their
     * exclusivity — explicitly, rather than by accident of stacking order.
     *
     * Nothing here checks `isTrusted`, on purpose: a harness dispatching real
     * KeyboardEvent and PointerEvent objects at `window` then drives the same
     * code path a player does, which is the only way `injectInput` measures the
     * input path instead of a mock of it.
     */
    const add = <K extends keyof WindowEventMap>(
      type: K,
      fn: (ev: WindowEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ): void => {
      window.addEventListener(type, fn, opts)
      teardown.push(() => window.removeEventListener(type, fn, opts))
    }

    add('keydown', onKeyDown, { capture: true })
    add('keyup', onKeyUp, { capture: true })
    // Non-passive: `preventDefault` on these is what kills double-tap zoom and
    // the compatibility mouse events riding behind every touch.
    add('pointerdown', onPointerDown, { capture: true, passive: false })
    add('pointermove', onPointerMove, { capture: true, passive: false })
    add('pointerup', onPointerUp, { capture: true })
    add('pointercancel', onPointerUp, { capture: true })
    // Fired when the browser hands the pointer to something else mid-drag.
    // Without it that contact never releases and its control stays held.
    add('lostpointercapture', onPointerUp, { capture: true })
    add('blur', onWindowBlur)
    add('gamepadconnected', onGamepadConnected)
    add('gamepaddisconnected', onGamepadDisconnected)

    document.addEventListener('visibilitychange', onVisibilityChange)
    teardown.push(() => document.removeEventListener('visibilitychange', onVisibilityChange))

    // A long press on a touch control opens the context menu and cancels the
    // drag underneath it. Holding the throttle is a long press by definition.
    const onContextMenu = (e: Event): void => {
      if (!isUiTarget(e.target)) e.preventDefault()
    }
    window.addEventListener('contextmenu', onContextMenu)
    teardown.push(() => window.removeEventListener('contextmenu', onContextMenu))
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    // Every listener, unconditionally. The harness builds and tears down the
    // world repeatedly; one leaked keydown listener from the previous run steers
    // the next one, and it looks like a physics bug.
    for (let i = 0; i < teardown.length; i++) teardown[i]!()
    teardown.length = 0
    releaseAllPointers()
    keyHeld.fill(0)
    keyItemLatched = false
    padItemLatched = false
    itemPending = false
    gamepadSeen = false
    gamepadIndex = -1
  }

  /*
   * `kind` and `lastEventAtMs` are live values, so they are accessors over the
   * closure. Plain fields would freeze whatever they held at construction time,
   * and `lastEventAtMs` frozen at 0 is a latency harness reporting a confident,
   * precise, entirely fictional number — the exact failure this repo exists to
   * catch.
   */
  return {
    name: 'input',
    get kind(): InputKind {
      return kind
    },
    frame,
    get lastEventAtMs(): number {
      return lastEventAtMs
    },
    build,
    /**
     * The composition root may drive this through `IInput.sample` or through the
     * `Subsystem` lifecycle. Both are wired, and `sample` is idempotent per
     * tick, so calling both in one tick is harmless rather than being the bug
     * where the item pulse disappears.
     */
    fixedUpdate(_step: Seconds, c: Ctx): void {
      sample(c.clock)
    },
    sample,
    dispose,
  }
}
