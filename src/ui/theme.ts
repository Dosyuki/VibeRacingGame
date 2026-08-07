/**
 * UI PALETTE AND STYLE SHEET — ART_DIRECTION §8, in one place.
 *
 * Everything the HUD paints is either a value from §3a (environment) or a value
 * from §4b (the reserved gameplay band), and the split is not decorative. §4b
 * reserves hue 155°–320° at saturation ≥ 0.85 *exclusively* for gameplay
 * feedback, so HUD chrome — panels, rules, the START button, the minimap road —
 * may not use it. Only the drift ladder, the item roulette and the boost flash
 * do, because those are the signals the band exists for.
 *
 * Chrome therefore separates by VALUE, not by hue, exactly the way §3a says the
 * kerbs do: bone `#f2ead6` against near-black `#241f22` is a 6.4:1 luma ratio
 * and it is the highest-contrast pair the environment palette contains. It
 * holds against sunlit sand at luma 0.65 without borrowing a single degree of
 * hue from the drift ladder.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY STRING IS OUTLINED AND NOTHING IS DROP-SHADOWED
 *
 * §8 is explicit and it is not the same rule the night circuit had. There, the
 * background was neon over black: arbitrary parts of the screen were bright, so
 * a soft shadow under a light glyph read fine over most of the frame. Here the
 * background is uniformly bright sand at luma 0.65 across the whole lower half
 * of every shot. A soft shadow spreads its energy over ~8 px and never gets
 * dark enough to separate `#f7f1e4` (luma ~0.93) from sand (0.65); the glyph
 * simply dissolves. A HARD outline — zero blur — puts a luma-0.03 ring in
 * contact with the glyph edge and gives 20:1 local contrast whatever is behind
 * it.
 *
 * It is built from eight zero-blur `text-shadow` offsets rather than
 * `-webkit-text-stroke`, for two reasons: a text stroke is centred on the glyph
 * outline and eats half its weight inward, which thins numerals at HUD sizes;
 * and `paint-order: stroke fill`, which would fix that, is not reliable on HTML
 * text everywhere this has to run. Diagonals are at 1.4 px, not 2 px, because
 * the diagonal of a 2 px square is 2.83 px and eight equal-length offsets leave
 * a scalloped edge.
 *
 * `text-shadow` inherits, so it is declared once on the root and every string
 * in the HUD gets it for free — including any added later, which is the point.
 */

/** §8: HUD text colour. */
export const INK = '#f7f1e4'
/** §8: outline colour, applied at 0.85 opacity. */
export const OUTLINE_RGBA = 'rgba(42, 35, 32, 0.85)'
/** A heavier, opaque version for canvas under-strokes, which have no blur to hide behind. */
export const OUTLINE_SOLID = '#2a2320'
/** §3a kerb stripe B — the light half of the highest-contrast pair in the palette. */
export const BONE = '#f2ead6'
/** §3a kerb stripe A — the dark half. */
export const NEAR_BLACK = '#241f22'
/** §3a lane edge line. Worn bone; used for the minimap road so it reads as road. */
export const LANE = '#d9cbb4'

/**
 * §4b drift ladder, indexed by `DriftTier`. Index 0 is not a tier colour — it
 * is the neutral the HUD falls back to when no drift is banked, and it is
 * deliberately outside the reserved band.
 */
export const TIER_COLOR: readonly [string, string, string, string] = [
  BONE,
  '#00ffa3', // tier 1 — hue 158°
  '#b24bff', // tier 2 — hue 274°
  '#ffe9fb', // tier 3 core — near-white, per §4b
]
/** §4b: tier 3 alone carries a corona, and it is the band's weakest link (§4c). */
export const TIER3_CORONA = '#ff2fd0'

export const STYLE_ELEMENT_ID = 'v9-ui-style'
export const ROOT_ELEMENT_ID = 'v9-ui-root'

/**
 * The style sheet.
 *
 * Sizes are in `vmin` inside `clamp()` rather than in pixels, because §10c
 * criterion 8 requires this to survive a phone and a HUD laid out in pixels is
 * either unreadable at 390 px wide or comically large at 1920. `vmin` keys to
 * the short edge, so a rotated phone does not resize the lap counter.
 *
 * Safe-area insets are honoured on every edge: `index.html` sets
 * `viewport-fit=cover`, which is what lets the canvas reach under a notch, and
 * which also puts the lap counter under it unless the HUD asks for the inset
 * back.
 */
export const CSS = `
#${ROOT_ELEMENT_ID} {
  position: fixed;
  inset: 0;
  z-index: 5;
  overflow: hidden;
  /* The HUD is a full-screen layer over the canvas. It must not eat pointers:
     core/input.ts listens on window in the CAPTURE phase precisely so a HUD
     cannot swallow steering, but a HUD that is itself the hit-test target still
     changes what core/input.ts's isUiTarget() sees. Only real controls opt back
     in, one element at a time. */
  pointer-events: none;
  -webkit-user-select: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;

  color: ${INK};
  /* §8: no default browser font. An explicit stack, and it is the HUD's own —
     inheriting body's would make the HUD's typography a side effect of a rule
     in index.html that this file may not edit. */
  font-family: "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, Roboto,
    "Helvetica Neue", Arial, sans-serif;
  font-weight: 600;
  /* §8: tabular numerals. Both spellings — the feature query is the portable
     one, the raw feature tag catches faces that expose tnum but not the
     high-level keyword. Without this the timer's digits are proportional and
     the whole readout shifts several pixels every hundredth of a second. */
  font-variant-numeric: tabular-nums lining-nums;
  font-feature-settings: "tnum" 1, "lnum" 1;
  font-kerning: none;
  line-height: 1;

  /* §8: a dark OUTLINE, not a drop shadow. Inherited by every string below. */
  text-shadow:
    2px 0 0 ${OUTLINE_RGBA}, -2px 0 0 ${OUTLINE_RGBA},
    0 2px 0 ${OUTLINE_RGBA}, 0 -2px 0 ${OUTLINE_RGBA},
    1.4px 1.4px 0 ${OUTLINE_RGBA}, -1.4px 1.4px 0 ${OUTLINE_RGBA},
    1.4px -1.4px 0 ${OUTLINE_RGBA}, -1.4px -1.4px 0 ${OUTLINE_RGBA};

  opacity: 0;
  transition: opacity 260ms ease;
}
#${ROOT_ELEMENT_ID}.v9-visible { opacity: 1; }

/* Edge insets, resolved once. Every panel positions against these. */
#${ROOT_ELEMENT_ID} {
  --pad-t: calc(env(safe-area-inset-top, 0px) + 2.4vmin);
  --pad-r: calc(env(safe-area-inset-right, 0px) + 2.4vmin);
  --pad-b: calc(env(safe-area-inset-bottom, 0px) + 2.4vmin);
  --pad-l: calc(env(safe-area-inset-left, 0px) + 2.4vmin);
  /* The minimap's geometry is shared: the drift pips sit directly above it and,
     in touch mode, so does the speedometer. Three panels deriving the same two
     numbers independently is how they drift apart the first time one is
     retuned. */
  --map-size: clamp(96px, 19vmin, 172px);
  --map-bottom: var(--pad-b);
}

/* Several panels below set 'display' explicitly, which beats the user agent's
   own hidden-attribute rule and leaves a "hidden" element on screen. One rule
   rather than a per-class override, because the next panel someone adds will
   have the same problem and will not know to write the override.
   (No backticks anywhere below this line: this whole sheet is a template
   literal and a backtick in a CSS comment terminates it.) */
#${ROOT_ELEMENT_ID} [hidden] { display: none !important; }

.v9-hud { position: absolute; inset: 0; }

.v9-label {
  font-size: clamp(9px, 1.5vmin, 14px);
  font-weight: 700;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  opacity: 0.82;
}

/* --- §8 top-left: lap ---------------------------------------------------- */
.v9-lap {
  position: absolute;
  top: var(--pad-t);
  left: var(--pad-l);
  transform-origin: left top;
}
.v9-lap-value {
  display: flex;
  align-items: baseline;
  gap: 0.06em;
  font-size: clamp(28px, 6.2vmin, 62px);
  font-weight: 800;
  letter-spacing: -0.02em;
  margin-top: 0.12em;
}
.v9-lap-total { font-size: 0.52em; opacity: 0.78; }

/* --- §8 top-right: race timer -------------------------------------------- */
.v9-timer {
  position: absolute;
  top: var(--pad-t);
  right: var(--pad-r);
  text-align: right;
}
.v9-timer-value {
  font-size: clamp(24px, 5.2vmin, 52px);
  font-weight: 700;
  letter-spacing: 0.01em;
  margin-top: 0.14em;
  /* Belt and braces against width jitter: tabular numerals fix the digit
     advance, and a fixed ch-width box fixes the box even if the resolved face
     turns out to have no tnum table at all. 1ch IS the digit advance under
     tabular numerals, so this reserves exactly the space the glyphs need. */
  display: inline-block;
  min-width: 8.2ch;
}
.v9-timer-cs { font-size: 0.66em; opacity: 0.88; }

/* --- §8 left-centre: position -------------------------------------------- */
.v9-pos {
  position: absolute;
  left: var(--pad-l);
  top: 50%;
  transform: translateY(-50%);
  transform-origin: left center;
  display: flex;
  align-items: baseline;
}
.v9-pos-value {
  font-size: clamp(38px, 9vmin, 88px);
  font-weight: 800;
  letter-spacing: -0.03em;
}
.v9-pos-suffix {
  font-size: clamp(15px, 3.2vmin, 32px);
  font-weight: 700;
  letter-spacing: 0.02em;
  margin-left: 0.06em;
}

/* --- §8 bottom-right: speedometer ---------------------------------------- */
.v9-speedo {
  position: absolute;
  right: var(--pad-r);
  bottom: var(--pad-b);
  width: clamp(104px, 21vmin, 190px);
  height: clamp(104px, 21vmin, 190px);
}
.v9-speedo canvas { display: block; width: 100%; height: 100%; }
.v9-speedo-digital {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 12%;
  text-align: center;
  font-size: clamp(20px, 4.4vmin, 44px);
  font-weight: 800;
  letter-spacing: -0.02em;
}
.v9-speedo-unit {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 3%;
  text-align: center;
  font-size: clamp(8px, 1.3vmin, 12px);
  font-weight: 700;
  letter-spacing: 0.26em;
  opacity: 0.75;
}

/* --- §8 bottom-centre: minimap ------------------------------------------- */
.v9-map {
  position: absolute;
  left: 50%;
  bottom: var(--map-bottom);
  transform: translateX(-50%);
  width: var(--map-size);
  height: var(--map-size);
}
.v9-map canvas { display: block; width: 100%; height: 100%; }

/* Drift ladder readout. §8 assigns it no slot, so it sits directly above the
   minimap: dead centre, unmissable, and outside every core/input.ts touch zone
   (which leave the 0.45–0.60 horizontal band free). §7 is clear that tier must
   be readable from the kart alone — this is confirmation, not the primary
   signal, so it is small. */
.v9-drift {
  position: absolute;
  left: 50%;
  bottom: calc(var(--map-bottom) + var(--map-size) + 1.2vmin);
  transform: translateX(-50%);
  display: flex;
  gap: 0.5vmin;
  opacity: 0;
  transition: opacity 140ms ease;
}
.v9-drift.v9-on { opacity: 1; }
.v9-drift-pip {
  width: clamp(16px, 3.4vmin, 30px);
  height: clamp(5px, 0.9vmin, 8px);
  border-radius: 99px;
  background: rgba(42, 35, 32, 0.55);
  box-shadow: inset 0 0 0 1px rgba(42, 35, 32, 0.85);
}

/* --- §8 bottom-left: item box -------------------------------------------- */
.v9-item {
  position: absolute;
  left: var(--pad-l);
  bottom: var(--pad-b);
  width: clamp(58px, 12vmin, 104px);
  height: clamp(58px, 12vmin, 104px);
  display: grid;
  place-items: center;
  border-radius: 14%;
  background: rgba(36, 31, 34, 0.42);
  box-shadow: inset 0 0 0 2px rgba(242, 234, 214, 0.55);
  opacity: 0.55;
  transition: opacity 180ms ease;
}
.v9-item.v9-on { opacity: 1; }
.v9-item-glyph {
  font-size: clamp(9px, 1.7vmin, 15px);
  font-weight: 800;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  text-align: center;
}

/* --- countdown, §8: scale-and-fade per number, full-screen flash on GO ---- */
.v9-count {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: clamp(72px, 22vmin, 260px);
  font-weight: 800;
  letter-spacing: -0.04em;
  opacity: 0;
}
.v9-flash {
  position: absolute;
  inset: 0;
  background: ${INK};
  opacity: 0;
}

/* Drift release. A bottom-edge wash in the tier colour — bounded on purpose:
   §4b puts these hues on screen for gameplay, not for atmosphere, and a
   full-frame magenta wash over a desert would be the frame a critic scores. */
.v9-release {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 26vh;
  opacity: 0;
}

/* --- start screen and results -------------------------------------------- */
.v9-screen {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2.2vmin;
  padding: var(--pad-t) var(--pad-r) var(--pad-b) var(--pad-l);
  box-sizing: border-box;
  /* The scene keeps rendering underneath, so the scrim only darkens the top and
     bottom bands where the type sits. A full wash would turn a live world into
     a wallpaper, and the middle third of the frame is where the road is. */
  background:
    linear-gradient(to bottom, rgba(36, 31, 34, 0.62) 0%, rgba(36, 31, 34, 0) 34%),
    linear-gradient(to top, rgba(36, 31, 34, 0.70) 0%, rgba(36, 31, 34, 0) 42%);
  pointer-events: auto;
}
.v9-screen-top { position: absolute; top: 8vmin; left: 0; right: 0; text-align: center; }
.v9-screen-bottom {
  position: absolute;
  bottom: calc(var(--pad-b) + 2vmin);
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2vmin;
}
.v9-eyebrow {
  font-size: clamp(9px, 1.5vmin, 14px);
  font-weight: 700;
  letter-spacing: 0.42em;
  text-transform: uppercase;
  opacity: 0.85;
}
.v9-title {
  margin-top: 1.4vmin;
  font-size: clamp(34px, 8.4vmin, 104px);
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.v9-rule {
  width: min(52vmin, 70%);
  height: 2px;
  margin: 1.8vmin auto 1.4vmin;
  background: ${BONE};
  opacity: 0.7;
}
.v9-subtitle {
  font-size: clamp(11px, 1.9vmin, 18px);
  font-weight: 700;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  opacity: 0.9;
}

.v9-btn {
  pointer-events: auto;
  /* A real <button>. core/input.ts's isUiTarget() looks for exactly this, which
     is what stops a press on START also flooring the throttle — explicitly,
     rather than by accident of stacking order. */
  appearance: none;
  border: 0;
  cursor: pointer;
  font: inherit;
  font-weight: 800;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  /* Value contrast, not hue — the §3a kerb pair. The reserved band is not
     available to chrome and gold is retired (§4a), so this is what is left, and
     it is the strongest pair in the palette anyway. */
  color: ${NEAR_BLACK};
  background: ${BONE};
  text-shadow: none;
  padding: clamp(12px, 2.4vmin, 22px) clamp(26px, 6vmin, 60px);
  border-radius: 999px;
  font-size: clamp(14px, 2.6vmin, 26px);
  box-shadow: 0 0 0 2px rgba(42, 35, 32, 0.85), 0 0.6vmin 2vmin rgba(42, 35, 32, 0.45);
  transition: transform 120ms ease, background-color 120ms ease;
  touch-action: manipulation;
}
.v9-btn:hover { background: #ffffff; }
.v9-btn:active { transform: scale(0.96); }
.v9-btn:focus-visible { outline: 3px solid ${INK}; outline-offset: 3px; }

.v9-hint {
  font-size: clamp(10px, 1.6vmin, 15px);
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  opacity: 0.85;
  text-align: center;
  line-height: 1.7;
  /* The hint is two lines authored as one string with a newline; without this
     it collapses to one long line that wraps in the wrong place on a phone. */
  white-space: pre-line;
}

.v9-results {
  display: flex;
  flex-direction: column;
  gap: 0.5vmin;
  padding: 2vmin 3vmin;
  border-radius: 1.4vmin;
  background: rgba(36, 31, 34, 0.5);
  box-shadow: inset 0 0 0 2px rgba(242, 234, 214, 0.35);
  max-height: 42vh;
  overflow: hidden;
}
.v9-row {
  display: grid;
  grid-template-columns: 3.4em 1fr 5.6em;
  align-items: center;
  gap: 1.4vmin;
  font-size: clamp(11px, 2vmin, 20px);
  font-weight: 700;
  letter-spacing: 0.06em;
  padding: 0.45vmin 0;
  opacity: 0.82;
}
.v9-row.v9-player { opacity: 1; }
.v9-row-place { text-align: right; letter-spacing: 0.02em; }
.v9-row-name { display: flex; align-items: center; gap: 0.8vmin; overflow: hidden; }
.v9-chip {
  width: 1.1em;
  height: 1.1em;
  border-radius: 3px;
  flex: 0 0 auto;
  box-shadow: inset 0 0 0 1.5px rgba(42, 35, 32, 0.85);
}
.v9-row-time { text-align: right; }

/* --- touch controls ------------------------------------------------------
   Drawn at the fractions core/input.ts hit-tests, and nothing more. See
   src/ui/touch.ts for why the numbers are duplicated rather than imported. */
.v9-touch { position: absolute; inset: 0; }
.v9-zone {
  position: absolute;
  /* Never a hit target. The zone that matters is the one core/input.ts computes
     from raw client coordinates; this is a picture of it. Taking the pointer
     here would make the picture the control, and then the two could drift. */
  pointer-events: none;
  display: grid;
  place-items: center;
  border-radius: 2.2vmin;
  box-sizing: border-box;
  transition: background-color 90ms ease, box-shadow 90ms ease;
}
.v9-pad {
  /* Deliberately faint. A pad is a diagram of a hit box, and the hit boxes are
     large — the throttle alone is a fifth of the screen. At the opacity a button
     would want, the frame becomes a wireframe of itself and the desert
     disappears behind it. */
  background: rgba(36, 31, 34, 0.22);
  box-shadow: inset 0 0 0 2px rgba(242, 234, 214, 0.36);
}
.v9-pad.v9-on {
  background: rgba(242, 234, 214, 0.34);
  box-shadow: inset 0 0 0 2px rgba(242, 234, 214, 0.95);
}
.v9-pad-label {
  font-size: clamp(10px, 1.9vmin, 18px);
  font-weight: 800;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  opacity: 0.95;
}
.v9-steer {
  background: linear-gradient(to top, rgba(36, 31, 34, 0.26), rgba(36, 31, 34, 0));
  align-items: end;
  padding-bottom: 4vmin;
}
.v9-steer-track {
  position: relative;
  width: 74%;
  height: clamp(8px, 1.6vmin, 16px);
  border-radius: 999px;
  background: rgba(36, 31, 34, 0.42);
  box-shadow: inset 0 0 0 2px rgba(242, 234, 214, 0.42);
}
.v9-steer-knob {
  position: absolute;
  top: 50%;
  left: 50%;
  width: clamp(22px, 4.4vmin, 42px);
  height: clamp(22px, 4.4vmin, 42px);
  margin: 0 0 0 clamp(-21px, -2.2vmin, -11px);
  border-radius: 999px;
  background: ${BONE};
  box-shadow: 0 0 0 2px rgba(42, 35, 32, 0.85);
  transform: translate(0, -50%);
  will-change: transform;
}
.v9-steer-hint {
  position: absolute;
  bottom: 9vmin;
  left: 0;
  right: 0;
  text-align: center;
}

/* Touch layout collides with §8's HUD corners: core/input.ts owns the whole
   bottom-right (throttle) and the whole lower-left (steer), which are exactly
   where §8 puts the speedometer and the item box. Neither can move on desktop —
   §8 names the positions — so the HUD steps aside only when the pads are
   actually on screen. The 0.45–0.60 horizontal band is free of every zone,
   which is why the minimap and the drift pips never have to move. */
.v9-touch-mode {
  /* On a 390 px portrait phone the free band between the steer zone (ends at
     0.45) and the drift/brake column (starts at 0.60) is only 58 px wide, so
     the minimap has to shrink and climb clear of the steering indicator rather
     than sit on top of it. */
  --map-size: clamp(78px, 15vmin, 130px);
  --map-bottom: calc(var(--pad-b) + 9vmin);
}
.v9-touch-mode .v9-speedo {
  right: auto;
  left: 50%;
  bottom: calc(var(--map-bottom) + var(--map-size) + 5vmin);
  transform: translateX(-50%);
  width: clamp(92px, 18vmin, 150px);
  height: clamp(92px, 18vmin, 150px);
}
.v9-touch-mode .v9-speedo-digital { bottom: 14%; }
.v9-touch-mode .v9-item {
  left: 50%;
  bottom: auto;
  top: var(--pad-t);
  transform: translateX(-50%);
}
`
