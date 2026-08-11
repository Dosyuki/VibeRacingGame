/**
 * VERMILION NINE — the circuit.
 *
 * ART_DIRECTION §1 in code: 1620 m of closed centreline through eight named
 * sections, half-width 8.0–16.0 m, elevation 0–52 m, and two banked corners —
 * The Wall at 20° and ess-2 at 10°. See `BANK` for why the second one exists
 * and what it measured; §1 was rewritten in the same commit that added it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT A CATMULL-ROM THROUGH CONTROL POINTS
 *
 * The obvious build is a closed `CatmullRomCurve3` through hand-placed points.
 * It closes for free and it is easy to author. It also makes every number in
 * §1 unmeasurable: you cannot ask a Catmull-Rom for "radius 74 m", you can only
 * place points near a circle and hope, and the radius you actually get drifts
 * every time somebody nudges a neighbouring point. §1 states a radius, a bank
 * ramp in metres, a section length table and a gradient ceiling. All four are
 * properties of the CURVATURE PROFILE, so the curvature profile is what gets
 * authored here and the geometry is integrated out of it.
 *
 * The centreline is therefore an arc/clothoid spline: a piecewise-constant
 * plan-view curvature κ(s) with smoothstep transitions between segments, which
 * is what real road geometry is made of. Three things fall out for free:
 *
 *   1. ARC LENGTH IS THE PARAMETER, exactly, by construction. There is no
 *      reparameterisation step left to get subtly wrong. The brief's warning —
 *      every lap time, AI line and checkpoint spacing quietly wrong with
 *      nothing reporting it — is answered by never creating the problem.
 *   2. `curvature` is analytic rather than a finite difference of a sampled
 *      polyline, so the AI reads the radius the corner was designed with
 *      instead of one contaminated by sampling noise.
 *   3. A SYMMETRIC smoothstep transition integrates to exactly the same total
 *      heading change as a hard curvature step (∫smoothstep = ½), so easing the
 *      corners in does not move where the track ends up. That is the property
 *      that lets the closure below be solved once and stay solved.
 *
 * What it does not give for free is closure. Heading closure is by design — the
 * turns in `PLAN` sum to exactly -360.000000°. Position closure was solved
 * offline by a weighted least-norm Gauss–Newton pass over those turns, with The
 * Wall frozen at -180° / R = 74 m; the solved values are the literals below and
 * they close the loop to well under a millimetre. A residual-distribution pass
 * mops up integrator round-off so the seam is exact regardless of step size.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * WHERE THIS DISAGREES WITH §1, ON PURPOSE. All four are in the round report;
 * none of them is a quiet edit.
 *
 *   - §1's HALF-WIDTH NUMBERS ARE SUPERSEDED. The table says 4.6–13.0 m and
 *     "half-width collapses to 4.6 m over 92 m" in The Slot. A 9.2 m road cannot
 *     hold an eight-kart field: eight karts is 9.6 m of bodywork before any gap,
 *     and overtaking needs two lines abreast plus room to be wrong about one of
 *     them. The profile is now 8.0–16.0 m — a 16 m road at the narrowest and a
 *     32 m road at the widest. The RELATIVE profile is preserved, so §1's
 *     character column still holds: The Slot is still exactly half the width of
 *     the dune sweep, and it is still the only place on the lap that gets
 *     narrower for 92 m and then stops.
 *     The centreline, the length, the elevation, the bank and the checkpoints
 *     are untouched. Nothing in this widening moves a lap time except by giving
 *     the ideal line more room to be ideal in.
 *
 *   - §1 gives The Wall 0.57–0.69 of the lap, i.e. 194 m. A 180° arc at
 *     R = 74 m is π·74 = 232.5 m. Those cannot both hold. The radius is the
 *     number a player can feel, so the radius wins and the section runs
 *     0.5525–0.7006. Every other section boundary lands within 0.018 of the
 *     table.
 *   - §1 wants the sun behind-left on the grid AND the arch exit firing
 *     straight into it. Those headings are ~180° apart and the two places are
 *     ~150 m apart on the lap. The arch exit is graded (§11 `arch-exit`) so it
 *     is exact: heading 198.0°, dead down the sun axis. The grid takes 88.2°,
 *     which puts the sun 109.8° behind-left — shadows still rake forward across
 *     the road — and the 150 m between them is an ordinary final corner rather
 *     than a hairpin nobody asked for.
 *   - §1's 1620 m is the PLAN-VIEW centreline. `length` reports true 3D arc
 *     length, ~0.15% longer because the circuit climbs 52 m, and `t` is
 *     normalised 3D arc length — because that is the length a lap time is
 *     measured over.
 */

import { Matrix4, Object3D, Quaternion, Vector3 } from 'three'
import { BARRIER_MARGIN, Surface } from '../types'
import type {
  Ctx,
  ITrack,
  Metres,
  StartSlot,
  Subsystem,
  TrackFactory,
  TrackLocation,
  TrackSample,
} from '../types'
import { buildRoad, disposeRoad } from './road'

const DEG = Math.PI / 180

// ---------------------------------------------------------------------------
// The plan-view skeleton
// ---------------------------------------------------------------------------

/**
 * Compass heading of the start straight, in the convention
 * `heading = (sin β, 0, cos β)` — β = 0 faces +Z, β increases toward +X.
 *
 * That is the same convention ART_DIRECTION §2 states the sun azimuth in, which
 * is the only reason it is worth naming: the sun sits at β = 198°, so "how far
 * off the sun axis does this section run" is a subtraction rather than a
 * coordinate conversion, and §2's ~35° rule can actually be checked.
 *
 * 88.2° is not a taste value. The layout is rigid under rotation, so this one
 * number is chosen to put the arch exit on exactly 198.0° and buy §11
 * `arch-exit` outright.
 */
const START_BEARING = 88.2 * DEG

interface PlanSegment {
  readonly name: string
  /** Plan-view length in metres. */
  readonly len: Metres
  /** Total heading change in degrees. NEGATIVE turns to the driver's right. */
  readonly turn: number
}

/**
 * The circuit, as curvature.
 *
 * `turn` is negative for a right-hand corner because heading β DECREASES when
 * the road turns right, while `TrackSample.curvature` is POSITIVE for a right
 * turn. The two therefore differ by a sign exactly once, at the single line in
 * `buildCentreline` that writes the curvature table. Nowhere else in the
 * project, per the STEERING SIGN discipline in the contract.
 *
 * Do not round the fractional turns. They carry the position closure of the
 * whole loop: 0.01° of error over the 232 m Wall arc is 4 cm of seam. They sum
 * to -360.000000 exactly.
 *
 * Heading through the lap, in degrees, against the §2 sun axis at 198°:
 *   grid       88.2 →   40.0   open hardpan; no vertical mass to shadow it
 *   dune       40.0 →  -47.3   crosses the sun axis; open sand both sides
 *   esses     -47.3 →  -41.6   one-sided cliff, worst case 96° off axis
 *   slot      -41.6 →  -65.5   §2's named bounce-lit exemption
 *   mesa      -65.5 →  -95.4   cross-lit, which is what separates the layers
 *   wall      -95.4 → -275.4   sweeps every heading; the bank is the subject
 *   wash    -275.4 → -198.0    closing on the sun axis, riverbed floor lit
 *   arch    -198.0 → -162.0    exit at 198.0°: straight down the sun axis
 *   final   -162.0 → -271.8    back to the grid heading, one turn short of 360
 */
const PLAN: readonly PlanSegment[] = [
  // §1 Hardpan grid, 0.000–0.105. Grid, start line, and the run to turn one.
  { name: 'grid-straight', len: 100, turn: 0 },
  { name: 'grid-ease', len: 70, turn: -48.194533 },
  // §1 Dune sweep, 0.105–0.219. R = 121 m, and it OPENS out of the previous
  // corner rather than tightening, which is what makes it flat-out.
  { name: 'dune-sweep', len: 185, turn: -87.347523 },
  // §1 Strata esses, 0.219–0.336. R = 72 / 48 / 98, alternating.
  { name: 'ess-1', len: 62, turn: 49.042011 },
  // ess-2 is the slowest corner on the lap and the only one besides The Wall
  // that is banked — 10°, see `BANK`. Its 66 m is what sizes that bank: two
  // 20 m ramps are the minimum a 10° twist can use, and they leave 22 m of
  // plateau. Shortening this segment would take the bank with it.
  { name: 'ess-2', len: 66, turn: -79.498609 },
  { name: 'ess-3', len: 62, turn: 36.196155 },
  // §1 The Slot, 0.336–0.426. R = 348 m: a crack in the rock does not corner.
  { name: 'slot', len: 145, turn: -23.901239 },
  // §1 Mesa climb, 0.426–0.553. R = 393 m — the longest sightline on the lap
  // but NOT a straight. §1's "no straight longer than 145 m" is a composition
  // rule as much as a driving one, and 205 m of ruler kills the silhouette read.
  { name: 'mesa-climb', len: 205, turn: -29.873046 },
  // §1 The Wall, 0.553–0.701. Frozen through the closure solve: 180° at exactly
  // R = 74.0 m.
  { name: 'wall-arc', len: 232.5, turn: -180 },
  { name: 'wall-exit', len: 7.5, turn: 0 },
  // §1 Wash descent, 0.701–0.824. A LEFT-hander, deliberately: it is the only
  // fast corner on the lap that loads the other side of the kart, and §10c
  // criterion 2 grades drift-attempt outcomes that are worthless as a sample if
  // every corner on the circuit turns the same way.
  { name: 'wash', len: 200, turn: 77.385233 },
  // §1 Arch tunnel, 0.824–1.000. The arch itself is exactly 118 m and bends
  // 36°, so the exit aperture is hidden until you are inside it.
  { name: 'arch', len: 118, turn: 35.980939 },
  { name: 'final-corner', len: 132, turn: -109.789388 },
  { name: 'apron', len: 35, turn: 0 },
]

/**
 * Curvature transition length.
 *
 * A hard step from straight into R = 48 m is a step in lateral acceleration, and
 * no tyre model can follow a step. The symptom is not obviously a track bug: the
 * AI understeers off at the same point every lap and it looks like an AI
 * tuning problem. 18 m is a short clothoid at kart speeds.
 *
 * Clamped to 80% of the shorter neighbour so a transition can never consume a
 * whole segment — `wall-exit` is 7.5 m long and would otherwise be all ramp.
 */
const TRANSITION = 18

/** Plan distance at which each of the eight §1 sections begins. */
const SECTION_START: readonly Metres[] = [0, 170, 355, 545, 690, 895, 1135, 1335]

/**
 * Elevation keyframes, `[plan distance, height]`.
 *
 * §1: elevation 0–52 m, gradient never over 8% up or 11% down. The climb is
 * spread over four sections rather than dumped into "Mesa climb" — 52 m across
 * that section's 205 m is a 25% ramp, the ceiling is 8%, so the climb needs
 * 650 m of road and it gets it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE INTERPOLATOR IS THE GUARD, AND IT TOOK TWO GOES TO GET RIGHT.
 *
 * A table like this is only checkable if the gradient BETWEEN two keyframes is
 * bounded by the secant BETWEEN those two keyframes. Neither obvious spline
 * has that property. A Catmull-Rom overshoots outright. A monotone
 * (Fritsch–Carlson) Hermite does not overshoot in VALUE — the guarantee it
 * actually makes — but says nothing about slope, and it approaches the crest at
 * 895 with an end tangent near zero, so it has to run steeper than the secant
 * through the middle to make up the height. This table read 7.6% and MEASURED
 * 8.35%: over §1's ceiling, in a place no pair of numbers in it admitted to.
 *
 * So elevation is authored the same way the plan view is: as a piecewise-
 * constant GRADIENT with smoothstep corners. A symmetric smoothstep blends
 * between two constants and can never leave the interval between them, so the
 * maximum gradient on the road is exactly the maximum secant in this table —
 * and, because ∫smoothstep = ½, rounding the corners does not move any
 * keyframe height. Reading the table is now a complete check.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Secants: +2.9, +7.6, +7.4, +6.9, +6.1 up; -6.0, -10.0, -8.5, -5.3 down.
 * The first 100 m and the last 45 m are one flat run through the start line:
 * the apron carries the grid, and a grid on a 1% slope creeps before GO.
 */
const ELEVATION: readonly (readonly [Metres, Metres])[] = [
  [0, 0], // the start line is the low point of the circuit
  [100, 0], // grid straight dead flat
  [170, 2],
  [355, 16],
  [545, 30],
  [690, 40],
  // 52.4, not 52: rounding a crest costs about g·T/6 of height, and §1 asks for
  // a mesa at +52 m rather than a mesa at +51.6 m.
  [895, 52.4],
  [1135, 38], // The Wall descends gently while banked
  [1335, 18],
  [1500, 4],
  [1575, 0], // apron: flat from here through the grid straight
  [1620, 0],
]

/**
 * Corner-rounding length for the gradient profile. Long enough that a crest
 * does not read as a fold; short enough that the 45 m apron is genuinely flat
 * under the grid.
 */
const ELEVATION_TRANSITION = 40

/**
 * Half-width keyframes, `[plan distance, half-width]`. Range 8.0–16.0 m.
 *
 * SUPERSEDES §1's 4.6–13.0 m — see the fourth bullet at the top of this file for
 * why, and read that before "restoring" any number here to match the table. The
 * short version: 4.6 m of half-width is a 9.2 m road, an eight-kart field is
 * 9.6 m of bodywork, and the arithmetic does not close.
 *
 * The profile is the old one mapped through `w' = 3.62 + 0.952 w`, then rounded
 * to values worth reading. An AFFINE map rather than a scale, deliberately: a
 * pure scale (x1.23, which is what taking 13.0 to 16.0 costs) leaves The Slot at
 * 5.7 m and fixes nothing where it actually hurts. Affine lifts the floor and
 * keeps the ORDER and the SPACING of the sections, so §1's character column
 * still describes the circuit you drive:
 *
 *   dune sweep  16.0   widest, and still the only 16
 *   The Wall    15.0   wide because a 20° bank needs width or it is a ramp
 *   grid        14.0
 *   wash        13.6
 *   final       12.5 → 14.0
 *   mesa climb  11.7 → 12.7
 *   esses       12.2 → 11.2
 *   arch        11.5   the second narrows, and it reads as one
 *   The Slot     8.0   narrowest, exactly half the dune sweep, held for 92 m
 *
 * ess-2 is now banked too (10°, see `BANK`) and was NOT widened for it, which
 * is a decision and not an oversight. "A bank needs width or it is a ramp" is
 * about cross-slope over the road, and the two are not comparable: The Wall
 * drops 2·15.0·sin20° = 10.3 m across its width, ess-2 drops 2·11.6·sin10° =
 * 4.0 m across its own. Widening ess-2 would also move the racing line, which
 * is the thing the bank was sized against — the measurement would no longer be
 * about the corner it was taken on.
 *
 * Smoothstep-interpolated rather than linear. A width crease reads as a kink in
 * the barrier line from 200 m away, and the road mesh inherits it verbatim.
 *
 * THE RATE MATTERS AS MUCH AS THE VALUES, AND IT IS WHAT CONSTRAINS A WIDENING.
 * A smoothstep peaks at 1.5x its mean rate, so a pair of keyframes needs
 * `7.5 * Δwidth` metres between them to stay under 0.2 m/m — the point past
 * which the barrier line visibly steps rather than tapers. The Wall's entry was
 * once written as 9.5 → 12.0 over 10 m, which is 0.37 m/m, and
 * `tools/track-check.mjs` is what caught it: the geometry looks perfectly
 * reasonable in every static frame and only fails as a rate.
 *
 * Widening a keyframe pair without lengthening the gap between them raises that
 * rate, and two pairs here needed the gap: The Wall's exit taper went from 19 m
 * to 29 m, and the wash was held at 13.6 rather than dropped further, because
 * 15.0 → 13.6 over the original 19 m is 0.11 m/m and 16.0 → 13.6 over 19 m is
 * 0.19 — inside the limit on paper and one rounding away from tripping it. The
 * fix for a rate is a longer taper, never a looser gate. Worst pair on the lap
 * is still The Slot's exit at 662 → 700, now 0.146 m/m against 0.154 before.
 */
const HALF_WIDTH: readonly (readonly [Metres, Metres])[] = [
  [0, 14.0],
  [100, 14.0],
  [170, 15.0],
  [240, 16.0], // maximum, on the dune sweep where the trap is outside the line
  [330, 14.0],
  [360, 12.2],
  [520, 11.2],
  [545, 10.2],
  [570, 8.0], // The Slot: 8.0 m, held for 92 m. Half the dune sweep, as before.
  [662, 8.0],
  [700, 11.7],
  // The Wall opens on the APPROACH, 20 m before the arc: a 20° bank needs width
  // or it is a ramp, and the width has to arrive before the banking does.
  [875, 12.7],
  [915, 15.0],
  [1121, 15.0],
  // 29 m of taper off the banking, not the 19 m this used to take. The extra
  // 2.4 m of drop would otherwise run at 0.19 m/m — see the note above.
  [1150, 13.6],
  [1300, 13.6],
  [1335, 11.5], // inside the arch
  [1453, 11.5],
  [1470, 12.5],
  [1620, 14.0],
]

interface BankWindow {
  readonly name: string
  /** Plan distances. Bank is 0 at `rampInStart`, `angle` from `fullStart` to
   *  `fullEnd`, and back to 0 at `rampOutEnd`, smoothstep either side. */
  readonly rampInStart: Metres
  readonly fullStart: Metres
  readonly fullEnd: Metres
  readonly rampOutEnd: Metres
  /**
   * Radians. POSITIVE banks the road down toward the driver's right, so a
   * positive angle helps a RIGHT-hand corner and hurts a left one. Both windows
   * below are right-handers. There is no left-hand bank on this circuit and a
   * negative value here would be a design decision, not a sign fix.
   */
  readonly angle: number
}

/**
 * The banked corners, in plan order. A TABLE rather than one special case,
 * because there are now two of them.
 *
 * Windows may not overlap and none may cross the start line — `bankAtPlan`
 * returns the first match and does not sum, so an overlap would silently
 * resolve to whichever is written first. They are 400 m apart.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ART_DIRECTION §1 SAID "BANK IS 0° EVERYWHERE EXCEPT THE WALL". IT NO LONGER
 * DOES, AND THE DOCUMENT WAS CHANGED IN THE SAME COMMIT AS THIS LINE.
 *
 * ess-2 is the slowest corner on the lap by a wide margin and it was the
 * slowest by more than the geometry admits to. Measured on a validated
 * flat-plane bench the chassis holds 7.88 m/s² of sustained lateral, brakes at
 * 9.2 and tops out at 27.8 m/s. Against ess-2's CENTRELINE radius of 47.6 m
 * that is 19.1 m/s, which is a slow corner but an ordinary one.
 *
 * The centreline is not what anybody drives. `solveRacingLine` minimises Σκ²,
 * and a sum-of-squares objective will buy two nearly-straight corners by making
 * a third one tighter — 3k² beats 1·(2k)². At the esses it does exactly that:
 * measured, line radius against centreline radius, ess-1 72.4 → 268, ess-3
 * 98.1 → 264, and ess-2 47.6 → 40.6. The line is 15% TIGHTER than the
 * centreline at the one corner that sets the lap, and §5a paints the rubber
 * lay-down along that line, so 40.6 m is the radius a player is invited to
 * drive. It allows 17.5 m/s. That was the real number and nothing in the
 * geometry table said it.
 *
 * 10° at 40.6 m allows 21.3 m/s. Why 10° and not more:
 *
 *   - The pair is limited by ess-1, not by ess-2. ess-1's own centreline limit
 *     is 23.8 m/s; banking ess-2 past that moves the bottleneck onto a corner
 *     this change does not touch and buys nothing. 10° puts ess-2's centreline
 *     limit at 23.0 and its line limit at 21.3, both under that ceiling, so
 *     there is still headroom if the line solver ever shifts.
 *   - A corner that demands braking is the point. At 21.3 m/s ess-2 is still
 *     the slowest corner on the circuit and still needs roughly 20 m of
 *     threshold braking off the 27.8 m/s the line carries out of ess-1. Making
 *     it flat out would delete the corner, not fix it.
 *   - It is exactly HALF The Wall's 20°, which keeps The Wall the extreme case
 *     by a factor of two rather than by a few degrees.
 *
 * WHAT THE 66 m COSTS, because it is a real constraint and not a rounding.
 * `tools/track-check.mjs` check 4 gates |dbank/ds| at 0.02 rad/m, and a
 * smoothstep ramp peaks at 1.5× its mean rate, so 10° needs 1.5·0.1745/0.02 =
 * 13.1 m of ramp at the gate and 17.6 m to stay under The Wall's own 0.0149.
 * Two 20 m ramps leave 22 m of plateau inside a 66 m segment. That plateau
 * cannot cover the centreline's 48 m constant-radius section, so a driver
 * holding the middle of the road gains only 19.1 → 20.0 m/s. It is not a
 * tuning failure: covering the centreline plateau would need ≤ 9 m ramps,
 * which caps the bank at 5.1° and buys 19.3 m/s. The corner is 66 m long and a
 * useful bank needs 40 m of ramp; there is no arrangement that serves both
 * lines, so it serves the one the game paints.
 *
 * The plateau is therefore CENTRED ON THE LINE'S APEX, not on the segment.
 * Measured at 1 m stations, the line's radius through ess-2 runs 268 → 180 at
 * plan 417–426, holds above 150 to 438, then collapses 90 → 59 → 46 → 41 by
 * plan 450, holds 41 through 454 and is back over 150 by 466. The tightest
 * point is plan 451; the plateau is 439–461. That is a late apex, and the bank
 * is under the car where the load is rather than where the section boundary is.
 * ────────────────────────────────────────────────────────────────────────────
 */
const BANK: readonly BankWindow[] = [
  /*
   * ess-2. 20 m ramp / 22 m plateau / 20 m ramp inside the segment's
   * 417–483 m, inset 2 m at each end so the ramp does not overhang ess-1 or
   * ess-3. The inset at the exit end also matters for a second reason: the
   * curvature transition into ess-3 — a LEFT-hander — begins at plan 474, so
   * bank that ran to the segment boundary would still be leaning right while
   * the road had started to turn left. It is under 1.5° by 474 and zero by 481.
   */
  { name: 'ess-2', rampInStart: 419, fullStart: 439, fullEnd: 461, rampOutEnd: 481, angle: 10 * DEG },
  /*
   * The Wall. §1: ramp-in 40 m, sustained 145 m, ramp-out 35 m, 20°. That is
   * 220 m of banking inside a 232.5 m arc, so it is inset 6 m at the entry and
   * 6.5 m at the exit rather than overhanging the straights either side of it.
   * The Wall is a right-hander and the angle is positive, so the road falls
   * toward the inside — which is what makes §10c criterion 5 ("mean speed
   * through The Wall exceeds an equivalent flat 74 m corner by ≥ 6%") reachable
   * rather than merely stated.
   *
   * The 35 m ramp-out is the fastest bank change on the circuit — 0.0149 rad/m
   * against the 0.02 gate — and it stays the worst on the lap after ess-2:
   * ess-2's 20 m ramps run 0.0131. If a future change makes ess-2's ramps the
   * binding pair, check 4's number moves and the report should say why.
   */
  { name: 'the-wall', rampInStart: 901, fullStart: 941, fullEnd: 1086, rampOutEnd: 1121, angle: 20 * DEG },
]

// ---------------------------------------------------------------------------
// Surface regions, authored in plan distance and converted to `t` at build time
// ---------------------------------------------------------------------------

/** Clean sealed tarmac: §3a, "under overhangs and in the slot canyon". */
const ASPHALT_ZONES: readonly (readonly [Metres, Metres])[] = [
  [566, 666], // The Slot
  [1335, 1453], // the arch
]

/** §1 wash descent: "two surface-change bands". Full width, sand over tarmac. */
const SAND_BANDS: readonly (readonly [Metres, Metres])[] = [
  [1178, 1194],
  [1246, 1266],
]

/**
 * One culvert grate across the wash floor.
 *
 * §1 does not ask for it; the CONTRACT does. `ScenarioName` contains
 * `'cattle-grid-crossing'` and `Surface.Metal` is in the enum with grip 0.55 and
 * the note "grip collapses when crossed at an angle". A scenario the world
 * cannot stage is a harness row that reads PENDING forever, which CLAUDE.md is
 * explicit about preferring to a silent skip — but better still is to make it
 * reachable. 2.6 m: crossable at speed, unmistakable when crossed sideways.
 */
const METAL_BANDS: readonly (readonly [Metres, Metres])[] = [[1214, 1216.6]]

/**
 * Boost pads: `[plan start, plan end, pad half-width]`.
 *
 * Placed by DISTANCE only. The lateral position is resolved at build time from
 * `racingLine` at the pad's midpoint, because a pad the ideal line does not
 * cross is decoration: the reference AI would drive past it every lap and §10c
 * criterion 1 would be measuring a boost source that never fires.
 */
const BOOST_PADS: readonly (readonly [Metres, Metres, Metres])[] = [
  [668, 686, 2.2], // spat out of The Slot
  [1096, 1118, 2.4], // off the banking, onto the wash descent
  [1370, 1392, 2.4], // mid-arch, in the dark, between two skylights
]

/** Kerbs appear wherever the corner is tight enough to want one: R < 170 m. */
const KERB_MIN_CURVATURE = 1 / 170
/** Width of the kerb band, measured inward from the road edge. */
const KERB_WIDTH = 0.95
/**
 * How far sand creeps in from both edges. §5a: "sand drift creeping from both
 * edges (0.85 plus an albedo lerp toward #8a7458)".
 */
const SAND_EDGE_WIDTH = 1.7

/**
 * Half the kart's track width: the lateral offset of a wheel's contact patch
 * from the chassis centre, metres.
 *
 * A DELIBERATE COPY of `HALF_TRACK` in `src/kart/kart.ts`, not an import.
 * Sibling imports are banned and none of the three channels that cross a
 * directory boundary carries this: it is not per-tick state, not a discrete
 * moment, and putting it in `src/types.ts` is a contract widening — its own
 * announced commit that re-runs every harness, not a side effect of this fix.
 *
 * It is a MEASURED copy rather than an assumed one. Predicting
 * `KartState.wheels[].surface` from `surfaceAt(t, lateral ± 0.64)` reproduced
 * the game's own answer at 16 of 16 seek stations, and the same predictor with
 * 0.0 substituted missed 3 of 8 — so the agreement is evidence rather than a
 * tautology.
 *
 * THE FAILURE IF THIS EVER GOES STALE is silent and one-sided: build a kart
 * wider than this and its outer wheel drops back into the sand band on the very
 * line the AI follows, which no frame shows and no lap time obviously explains.
 * That is the bug this file just paid for once; see `RACING_MARGIN`.
 */
const KART_HALF_TRACK = 0.64

/**
 * Slack between the outer wheel on the ideal line and the sand it must clear.
 *
 * Not zero, for two independent reasons. `racing` is a `Float32Array` and
 * `halfWidth` is interpolated between samples, so a margin of exactly
 * `SAND_EDGE_WIDTH + KART_HALF_TRACK` leaves the boundary case to round-off and
 * the surface under a wheel becomes a coin flip. And `surfaceAt` models a wheel
 * as a POINT while a real contact patch is about 0.2 m across, so a point query
 * reports clear while a third of the tyre is in the drift.
 */
const LINE_SAND_CLEARANCE = 0.2

/**
 * Clearance the ideal line keeps from the road edge, metres. DERIVED — and the
 * derivation is the entire reason this is no longer a hand-picked number.
 *
 * IT WAS 1.35, described as "kart half-width plus a little", and it had never
 * been compared with `SAND_EDGE_WIDTH` six lines above it. 1.35 < 1.7, so
 * wherever the clamp in `solveRacingLine` bit — 925 m of a 1624 m lap, 57% of
 * it — the ideal line sat 0.35 m INSIDE the sand band, outer wheel 0.99 m into
 * it and inner wheel 0.29 m outside it. Measured on that line over a lap:
 *
 *   - the chassis centre read `SandDrift` for 63.9% of the lap, while the
 *     CENTRELINE read `DustyAsphalt` for 84.2% of it — the ideal line was the
 *     dirtiest path around the circuit
 *   - right wheels on `SandDrift` 25.1% of the lap against the left wheels' 1.0%
 *   - 85.2% of every straight ran with a 0.88 / 0.62 grip step across the axles,
 *     always the same way round, mean signed asymmetry +0.222
 *
 * A kart with a permanent one-sided grip deficit pulls to that side for ever,
 * and it does so on the line the game paints in rubber and the reference AI
 * follows.
 *
 * THAT IS ALSO WHERE `steer-test` PUT ITS SYMMETRY PROBE. It seeks with
 * `lateral: 0`, and `seek` resolves lateral as `racingLine(t) + lateral`, so
 * "zero" is the ideal line and not the centreline. Its unexplained left/right
 * asymmetry was being measured across an axle with a 30% grip deficit on one
 * side. Run at the same t with the SAME build: on the line, a zero-steer
 * full-throttle hold moved 0.055 m sideways in 0.75 s and the two steer
 * directions differed by 8.1%; moved to the centreline, where both wheels are
 * on the same surface, the hold moved 2.8e-8 m and the two directions matched
 * to eight significant figures — 0.00%. The asymmetry was never in the chassis.
 * With this margin it is 4.2%, and the remainder is the probe steering INTO the
 * edge sand during its own 0.75 s window, which is the road being a road.
 *
 * NEITHER CONSTANT WAS WRONG ALONE, which is why this went unseen for six
 * rounds. `solveRacingLine` does not know the sand exists; `surfaceAt` does not
 * know where the line is. Two correct numbers in one file, never compared. The
 * relationship is the fix and the value is a consequence of it — if the sand
 * band widens, this follows; it can no longer be left behind.
 *
 * §1 had already made the design call this encodes. The half-width table's
 * maximum is annotated "on the dune sweep where the trap is outside the line",
 * and §5a puts the rubber lay-down "along the true optimal line". A sand trap
 * under the ideal line is not a trap, it is a handicap, and rubbering it is an
 * invitation into one.
 */
const RACING_MARGIN = SAND_EDGE_WIDTH + KART_HALF_TRACK + LINE_SAND_CLEARANCE

// ---------------------------------------------------------------------------
// Build-time construction
// ---------------------------------------------------------------------------

/**
 * Plan-view integration step. Fine enough that the residual closure error is
 * floating-point round-off rather than discretisation. Build-time only; the
 * intermediate arrays are dropped before `build` returns.
 */
const PLAN_STEP = 0.05

interface Centreline {
  readonly n: number
  readonly length: Metres
  readonly spacing: Metres
  readonly px: Float32Array
  readonly py: Float32Array
  readonly pz: Float32Array
  readonly tx: Float32Array
  readonly ty: Float32Array
  readonly tz: Float32Array
  readonly nx: Float32Array
  readonly ny: Float32Array
  readonly nz: Float32Array
  readonly rx: Float32Array
  readonly ry: Float32Array
  readonly rz: Float32Array
  readonly halfWidth: Float32Array
  readonly bank: Float32Array
  readonly curvature: Float32Array
  readonly racing: Float32Array
  /** Normalised 3D arc length at each whole metre of PLAN distance. */
  readonly planToT: Float32Array
  readonly planLength: Metres
}

function smoothstep01(x: number): number {
  const c = x < 0 ? 0 : x > 1 ? 1 : x
  return c * c * (3 - 2 * c)
}

function keyframeIndex(ks: readonly (readonly [number, number])[], x: number): number {
  let lo = 0
  let hi = ks.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (ks[mid]![0] <= x) lo = mid
    else hi = mid
  }
  return lo
}

/**
 * Gradient at a plan distance: piecewise constant between elevation keyframes,
 * smoothstep-blended across a rounded corner at each one.
 *
 * The two properties this exists for, both stated in the `ELEVATION` comment:
 * the gradient is bounded by the neighbouring secants, and the corner rounding
 * is integral-preserving so the keyframe heights survive it.
 */
function makeGradeProfile(
  ks: readonly (readonly [Metres, Metres])[],
): (s: Metres) => number {
  const segs = ks.length - 1
  const grade = new Float64Array(segs)
  for (let i = 0; i < segs; i++) {
    grade[i] = (ks[i + 1]![1] - ks[i]![1]) / (ks[i + 1]![0] - ks[i]![0])
  }
  // Half-width of the corner at keyframe i. The seam keyframes get none: the
  // first and last segments are both flat, so there is no corner there.
  const half = new Float64Array(ks.length)
  for (let i = 1; i < segs; i++) {
    half[i] =
      Math.min(
        ELEVATION_TRANSITION,
        0.8 * (ks[i]![0] - ks[i - 1]![0]),
        0.8 * (ks[i + 1]![0] - ks[i]![0]),
      ) / 2
  }
  return (s: Metres): number => {
    let j = 0
    while (j < segs - 1 && s >= ks[j + 1]![0]) j++
    const g = grade[j]!
    const hp = half[j]!
    const hn = half[j + 1]!
    if (j > 0 && hp > 0 && s < ks[j]![0] + hp) {
      const w = smoothstep01((s - (ks[j]![0] - hp)) / (2 * hp))
      return grade[j - 1]! + (g - grade[j - 1]!) * w
    }
    if (j < segs - 1 && hn > 0 && s > ks[j + 1]![0] - hn) {
      const w = smoothstep01((s - (ks[j + 1]![0] - hn)) / (2 * hn))
      return g + (grade[j + 1]! - g) * w
    }
    return g
  }
}

function evalSmoothTable(ks: readonly (readonly [number, number])[], x: number): number {
  const last = ks.length - 1
  if (x <= ks[0]![0]) return ks[0]![1]
  if (x >= ks[last]![0]) return ks[last]![1]
  const i = keyframeIndex(ks, x)
  const a = ks[i]!
  const b = ks[i + 1]!
  return a[1] + (b[1] - a[1]) * smoothstep01((x - a[0]) / (b[0] - a[0]))
}

function bankAtPlan(s: Metres): number {
  for (let i = 0; i < BANK.length; i++) {
    const w = BANK[i]!
    if (s <= w.rampInStart || s >= w.rampOutEnd) continue
    if (s < w.fullStart) {
      return w.angle * smoothstep01((s - w.rampInStart) / (w.fullStart - w.rampInStart))
    }
    if (s <= w.fullEnd) return w.angle
    return w.angle * smoothstep01((w.rampOutEnd - s) / (w.rampOutEnd - w.fullEnd))
  }
  return 0
}

function buildCentreline(): Centreline {
  // --- segment bounds and per-segment curvature -----------------------------
  const segCount = PLAN.length
  const bound = new Float64Array(segCount + 1)
  for (let i = 0; i < segCount; i++) bound[i + 1] = bound[i]! + PLAN[i]!.len
  const planLength = bound[segCount]!

  const segK = new Float64Array(segCount)
  for (let i = 0; i < segCount; i++) segK[i] = (PLAN[i]!.turn * DEG) / PLAN[i]!.len

  // Half-width of the transition centred on the boundary before segment i. The
  // seam (apron → grid-straight) needs none: both are dead straight, so the
  // curvature is already continuous across it.
  const halfTrans = new Float64Array(segCount + 1)
  for (let i = 1; i < segCount; i++) {
    halfTrans[i] = Math.min(TRANSITION, 0.8 * PLAN[i - 1]!.len, 0.8 * PLAN[i]!.len) / 2
  }

  const kappaAtPlan = (s: Metres): number => {
    let j = 0
    while (j < segCount - 1 && s >= bound[j + 1]!) j++
    const k = segK[j]!
    const hp = halfTrans[j]!
    const hn = halfTrans[j + 1]!
    if (j > 0 && hp > 0 && s < bound[j]! + hp) {
      const w = smoothstep01((s - (bound[j]! - hp)) / (2 * hp))
      return segK[j - 1]! + (k - segK[j - 1]!) * w
    }
    if (j < segCount - 1 && hn > 0 && s > bound[j + 1]! - hn) {
      const w = smoothstep01((s - (bound[j + 1]! - hn)) / (2 * hn))
      return k + (segK[j + 1]! - k) * w
    }
    return k
  }

  // --- integrate the plan view ---------------------------------------------
  const steps = Math.round(planLength / PLAN_STEP)
  const step = planLength / steps
  const gradeAtPlan = makeGradeProfile(ELEVATION)

  const rawX = new Float64Array(steps + 1)
  const rawZ = new Float64Array(steps + 1)
  const rawY = new Float64Array(steps + 1)
  const rawArc = new Float64Array(steps + 1)

  let beta = START_BEARING
  let x = 0
  let z = 0
  let y = ELEVATION[0]![1]
  rawY[0] = y
  for (let i = 0; i < steps; i++) {
    const s = i * step
    // Midpoint rule on both the heading and the gradient, not Euler. Euler
    // leaves a visible bulge on the 48 m ess even at this step size, and it
    // biases the closure the same way every time — so the offline solve would
    // absorb the error rather than reveal it.
    const k = kappaAtPlan(s + step * 0.5)
    const bm = beta + k * step * 0.5
    x += Math.sin(bm) * step
    z += Math.cos(bm) * step
    beta += k * step
    y += gradeAtPlan(s + step * 0.5) * step
    rawX[i + 1] = x
    rawZ[i + 1] = z
    rawY[i + 1] = y
  }

  /*
   * Distribute the residual closure error rather than leaving a seam.
   *
   * `PLAN` closes analytically — the turns sum to exactly -360° and the offline
   * solve put the endpoint on the origin — so what remains here is integrator
   * round-off, currently far under a millimetre. It is corrected anyway,
   * because the alternative is a crack in the road mesh whose width depends on
   * PLAN_STEP, and "it is small on my machine" is not a property anyone can
   * re-check later.
   *
   * g(u) = u - sin(2πu)/(2π) has g(0)=0, g(1)=1 and g'(0)=g'(1)=0, so the
   * correction is C1 across the seam. A plain linear ramp would close the
   * position and leave a heading kink instead — which is worse, because a kink
   * is something the camera sees and a sub-millimetre gap is not.
   */
  const ex = rawX[steps]!
  const ez = rawZ[steps]!
  const TWO_PI = Math.PI * 2
  for (let i = 0; i <= steps; i++) {
    const u = i / steps
    const g = u - Math.sin(TWO_PI * u) / TWO_PI
    rawX[i] = rawX[i]! - ex * g
    rawZ[i] = rawZ[i]! - ez * g
  }

  // --- cumulative 3D arc length --------------------------------------------
  for (let i = 0; i < steps; i++) {
    const dx = rawX[i + 1]! - rawX[i]!
    const dy = rawY[i + 1]! - rawY[i]!
    const dz = rawZ[i + 1]! - rawZ[i]!
    rawArc[i + 1] = rawArc[i]! + Math.hypot(dx, dy, dz)
  }
  const length = rawArc[steps]!

  /*
   * `t` IS NORMALISED 3D ARC LENGTH, and this resample is what makes that true.
   *
   * The integration above is uniform in HORIZONTAL distance. On an 8% grade a
   * horizontal metre is 1.0032 m of road, so a table indexed by plan distance
   * runs ~3 mm/m fast uphill and correct on the flat. Over a lap that is metres
   * of drift between where a kart is and where the checkpoint table thinks it
   * is: small enough that nothing looks wrong, large enough that two lap times
   * do not compare. Resampling by arc length is the whole fix.
   */
  const n = Math.round(length)
  const spacing = length / n

  const px = new Float32Array(n)
  const py = new Float32Array(n)
  const pz = new Float32Array(n)
  const halfWidth = new Float32Array(n)
  const bank = new Float32Array(n)
  const curvature = new Float32Array(n)

  let cursor = 0
  for (let i = 0; i < n; i++) {
    const target = i * spacing
    while (cursor < steps - 1 && rawArc[cursor + 1]! < target) cursor++
    const a0 = rawArc[cursor]!
    const a1 = rawArc[cursor + 1]!
    const u = a1 > a0 ? (target - a0) / (a1 - a0) : 0
    px[i] = rawX[cursor]! + (rawX[cursor + 1]! - rawX[cursor]!) * u
    py[i] = rawY[cursor]! + (rawY[cursor + 1]! - rawY[cursor]!) * u
    pz[i] = rawZ[cursor]! + (rawZ[cursor + 1]! - rawZ[cursor]!) * u
    const planS = (cursor + u) * step
    halfWidth[i] = evalSmoothTable(HALF_WIDTH, planS)
    bank[i] = bankAtPlan(planS)
    // THE one sign conversion in this file: κ = dβ/ds and β decreases to the
    // right; TrackSample.curvature is positive to the right.
    curvature[i] = -kappaAtPlan(planS)
  }

  // Compact plan→t table, one entry per metre. The full `rawArc` is 260 kB of
  // build scratch and there is no reason to keep it alive behind a closure.
  const planToT = new Float32Array(Math.ceil(planLength) + 1)
  for (let m = 0; m < planToT.length; m++) {
    const idx = Math.min(steps, Math.round(Math.min(planLength, m) / step))
    planToT[m] = rawArc[idx]! / length
  }

  // --- frames ---------------------------------------------------------------
  const tx = new Float32Array(n)
  const ty = new Float32Array(n)
  const tz = new Float32Array(n)
  const nx = new Float32Array(n)
  const ny = new Float32Array(n)
  const nz = new Float32Array(n)
  const rx = new Float32Array(n)
  const ry = new Float32Array(n)
  const rz = new Float32Array(n)

  for (let i = 0; i < n; i++) {
    const a = i === 0 ? n - 1 : i - 1
    const b = i === n - 1 ? 0 : i + 1
    let dx = px[b]! - px[a]!
    let dy = py[b]! - py[a]!
    let dz = pz[b]! - pz[a]!
    let len = Math.hypot(dx, dy, dz)
    dx /= len
    dy /= len
    dz /= len
    tx[i] = dx
    ty[i] = dy
    tz[i] = dz

    // Flat-road right = tangent × worldUp = (-dz, 0, dx). This is the axis the
    // bank rotates about.
    let ux = -dz
    let uy = 0
    let uz = dx
    len = Math.hypot(ux, uy, uz)
    ux /= len
    uy /= len
    uz /= len

    // upRoad = right × tangent: world up made perpendicular to the tangent, so
    // a climbing section's normal leans back with the road instead of staying
    // vertical and shearing every kerb block off its edge.
    let vx = uy * dz - uz * dy
    let vy = uz * dx - ux * dz
    let vz = ux * dy - uy * dx
    len = Math.hypot(vx, vy, vz)
    vx /= len
    vy /= len
    vz /= len

    /*
     * A road banked DOWN toward the driver's right has its normal tilted TOWARD
     * the right — the same way a hillside sloping east has an east-leaning
     * normal. Getting this backwards banks the corner the wrong way, and the
     * symptom is nasty because it is not obviously a track bug: the kart still
     * sticks, it just needs more lock than it should, which reads as an
     * understeering physics problem and gets "fixed" in kart/.
     */
    const cb = Math.cos(bank[i]!)
    const sb = Math.sin(bank[i]!)
    let mx = cb * vx + sb * ux
    let my = cb * vy + sb * uy
    let mz = cb * vz + sb * uz
    len = Math.hypot(mx, my, mz)
    mx /= len
    my /= len
    mz /= len
    nx[i] = mx
    ny[i] = my
    nz[i] = mz

    // Contract: `right` is `tangent × normal`. Computed, never assumed.
    rx[i] = dy * mz - dz * my
    ry[i] = dz * mx - dx * mz
    rz[i] = dx * my - dy * mx
  }

  const cl: Centreline = {
    n,
    length,
    spacing,
    px,
    py,
    pz,
    tx,
    ty,
    tz,
    nx,
    ny,
    nz,
    rx,
    ry,
    rz,
    halfWidth,
    bank,
    curvature,
    racing: new Float32Array(n),
    planToT,
    planLength,
  }
  solveRacingLine(cl)
  return cl
}

/**
 * The ideal line, by minimising path curvature inside the track boundaries.
 *
 * The brief says derive it from curvature and do not hand-place it. The cheap
 * reading is `lateral = k · sign(curvature)`, which puts the kart on the apex —
 * and ONLY on the apex. It has no entry and no exit, because a pointwise
 * function of curvature cannot know a corner is coming.
 *
 * So this minimises Σ|Pᵢ₊₁ - 2Pᵢ + Pᵢ₋₁|² around the whole closed loop, clamped
 * to the track width. That is still deriving it from curvature — it is the
 * integral of the squared curvature of the driven path — but wide entry, a
 * clipped apex and a wide exit all fall out of the minimisation instead of
 * being written down. Where the road is wide enough for the solution to be
 * unconstrained it comes out straight; where it is not, the clamp bites and the
 * line runs parallel to the edge at `RACING_MARGIN`.
 *
 * That used to read "and the line rides the inside kerb", and it was true: at a
 * margin of 1.35 m the outer wheel sat 0.71 m from the edge, inside the 0.95 m
 * kerb band. It is no longer true and the change is deliberate — the same
 * placement put the outer wheel 0.99 m into the sand band on every stretch with
 * NO kerb, which is where the damage was. See `RACING_MARGIN` for the
 * measurement. Kerb-riding is a thing a driver may still choose; it is no
 * longer a thing the reference line does on the driver's behalf.
 *
 * Relaxed on a coarse lattice first. Jacobi on a Laplacian needs O(m²)
 * iterations to settle its longest wavelength, so 203 nodes converge roughly
 * 60× faster than 1622 do and the fine pass has only local detail left — most
 * importantly the 4.6 m Slot, which is narrower than the coarse node spacing
 * and therefore invisible to the first pass.
 */
function solveRacingLine(cl: Centreline): void {
  const { n, px, py, pz, rx, ry, rz, halfWidth, racing } = cl

  const limit = new Float32Array(n)
  for (let i = 0; i < n; i++) limit[i] = Math.max(0.2, halfWidth[i]! - RACING_MARGIN)

  const relax = (nodes: Int32Array, lat: Float32Array, iters: number, rate: number): void => {
    const m = nodes.length
    const next = new Float32Array(m)
    for (let it = 0; it < iters; it++) {
      for (let k = 0; k < m; k++) {
        const ka = k === 0 ? m - 1 : k - 1
        const kb = k === m - 1 ? 0 : k + 1
        const ia = nodes[ka]!
        const ib = nodes[kb]!
        const ic = nodes[k]!
        const ax = px[ia]! + lat[ka]! * rx[ia]!
        const ay = py[ia]! + lat[ka]! * ry[ia]!
        const az = pz[ia]! + lat[ka]! * rz[ia]!
        const bx = px[ib]! + lat[kb]! * rx[ib]!
        const by = py[ib]! + lat[kb]! * ry[ib]!
        const bz = pz[ib]! + lat[kb]! * rz[ib]!
        const cx = px[ic]! + lat[k]! * rx[ic]!
        const cy = py[ic]! + lat[k]! * ry[ic]!
        const cz = pz[ic]! + lat[k]! * rz[ic]!
        // Move toward the point that straightens this triple, projected onto
        // the only axis this node is allowed to move along.
        const d =
          ((ax + bx) * 0.5 - cx) * rx[ic]! +
          ((ay + by) * 0.5 - cy) * ry[ic]! +
          ((az + bz) * 0.5 - cz) * rz[ic]!
        let v = lat[k]! + rate * d
        const lim = limit[ic]!
        if (v > lim) v = lim
        else if (v < -lim) v = -lim
        next[k] = v
      }
      // Jacobi, not Gauss–Seidel. In-place updates converge faster and sweep a
      // direction bias around the loop with them, which shows up as a racing
      // line that is subtly better on left-handers than right-handers.
      lat.set(next)
    }
  }

  const coarseCount = 203
  const coarseNodes = new Int32Array(coarseCount)
  for (let k = 0; k < coarseCount; k++) coarseNodes[k] = Math.round((k * n) / coarseCount) % n
  const coarseLat = new Float32Array(coarseCount)
  relax(coarseNodes, coarseLat, 14000, 0.6)

  const fineNodes = new Int32Array(n)
  for (let i = 0; i < n; i++) fineNodes[i] = i
  const fineLat = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const kf = (i * coarseCount) / n
    const k0 = Math.floor(kf) % coarseCount
    const k1 = (k0 + 1) % coarseCount
    fineLat[i] = coarseLat[k0]! + (coarseLat[k1]! - coarseLat[k0]!) * (kf - Math.floor(kf))
  }
  relax(fineNodes, fineLat, 900, 0.6)
  racing.set(fineLat)
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/*
 * `sample`, `locate` and `surfaceAt` are on the contract's MUST NOT ALLOCATE
 * list and `locate` runs once per kart per tick at 120 Hz. Nothing below
 * constructs a Vector3 or a closure per call; every intermediate is a scalar,
 * and the vectors that do exist are built once, in the factory.
 */

function wrap01(t: number): number {
  const v = t - Math.floor(t)
  return v >= 1 ? 0 : v
}

export const createTrack: TrackFactory = (ctx: Ctx): ITrack & Subsystem => {
  const cl = buildCentreline()
  const { n, length, px, py, pz, tx, ty, tz, nx, ny, nz, rx, ry, rz } = cl
  const { halfWidth, bank, curvature, racing } = cl

  /** Plan distance → normalised arc length, from the compact build-time table. */
  const tAtPlan = (planDistance: Metres): number => {
    const d = Math.min(cl.planLength, Math.max(0, planDistance))
    const i = Math.floor(d)
    const a = cl.planToT[i]!
    const b = cl.planToT[Math.min(cl.planToT.length - 1, i + 1)]!
    return a + (b - a) * (d - i)
  }

  // --- checkpoints ----------------------------------------------------------
  const checkpoints: number[] = SECTION_START.map(tAtPlan)
  // Contract: `checkpoints[0] === 0`. It is 0 by construction — plan distance 0
  // is arc length 0 is the start line — but assigning it makes that a promise
  // rather than a property of the interpolation.
  checkpoints[0] = 0
  const checkpointCount = checkpoints.length

  // --- surface region tables ------------------------------------------------
  const toRanges = (src: readonly (readonly [Metres, Metres])[]): Float64Array => {
    const out = new Float64Array(src.length * 2)
    for (let i = 0; i < src.length; i++) {
      out[i * 2] = tAtPlan(src[i]![0])
      out[i * 2 + 1] = tAtPlan(src[i]![1])
    }
    return out
  }
  const asphalt = toRanges(ASPHALT_ZONES)
  const sandBands = toRanges(SAND_BANDS)
  const metalBands = toRanges(METAL_BANDS)

  const inRanges = (ranges: Float64Array, t: number): boolean => {
    for (let i = 0; i < ranges.length; i += 2) {
      if (t >= ranges[i]! && t <= ranges[i + 1]!) return true
    }
    return false
  }

  const lerpAt = (arr: Float32Array, t: number): number => {
    const f = wrap01(t) * n
    const i0 = Math.floor(f)
    const a = i0 % n
    const b = (a + 1) % n
    return arr[a]! + (arr[b]! - arr[a]!) * (f - i0)
  }

  const racingLineAt = (t: number): Metres => lerpAt(racing, t)

  /** `[t0, t1, lat0, lat1]` per pad, lateral resolved against the ideal line. */
  const pads = new Float64Array(BOOST_PADS.length * 4)
  for (let i = 0; i < BOOST_PADS.length; i++) {
    const spec = BOOST_PADS[i]!
    const t0 = tAtPlan(spec[0])
    const t1 = tAtPlan(spec[1])
    const centre = racingLineAt((t0 + t1) * 0.5)
    pads[i * 4] = t0
    pads[i * 4 + 1] = t1
    pads[i * 4 + 2] = centre - spec[2]
    pads[i * 4 + 3] = centre + spec[2]
  }

  // --- spatial index for `locate` ------------------------------------------
  /*
   * A linear scan of 1622 samples per kart per tick is 1.5 million distance
   * tests a second before the AI has done anything. This replaces it with a
   * uniform XZ grid over coarse centreline nodes.
   *
   * Each cell holds EVERY coarse node within reach of it, not just the nearest.
   * A nearest-node-per-cell index is half the memory and wrong in exactly the
   * place it matters: where the loop doubles back the query can land in the
   * basin of the wrong branch and the kart teleports a third of a lap for one
   * tick — which surfaces as a lap counter that occasionally skips, not as a
   * geometry bug. The closest non-adjacent approach on this circuit is 106 m so
   * that failure is not reachable today, but "the current layout happens not to
   * trigger it" is not something the next person moving a corner will re-check.
   */
  const COARSE_STRIDE = 8
  const CELL = 16
  /** How far off the centreline a query may be and still resolve exactly. */
  const REACH = 40

  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < n; i++) {
    if (px[i]! < minX) minX = px[i]!
    if (px[i]! > maxX) maxX = px[i]!
    if (pz[i]! < minZ) minZ = pz[i]!
    if (pz[i]! > maxZ) maxZ = pz[i]!
  }
  const gridOriginX = minX - REACH - CELL
  const gridOriginZ = minZ - REACH - CELL
  const gridW = Math.ceil((maxX + REACH + CELL - gridOriginX) / CELL)
  const gridH = Math.ceil((maxZ + REACH + CELL - gridOriginZ) / CELL)
  const cellCount = gridW * gridH

  const cellReach = CELL * 0.7072 + (COARSE_STRIDE * cl.spacing) / 2 + REACH
  const cellReach2 = cellReach * cellReach

  // CSR: count, prefix-sum, fill. Two passes so the payload is one flat array
  // rather than 1500 little ones — this is built once but read every tick, and
  // an array of arrays is a pointer chase per cell.
  const cellStart = new Int32Array(cellCount + 1)
  for (let cz = 0; cz < gridH; cz++) {
    const centreZ = gridOriginZ + (cz + 0.5) * CELL
    for (let cx = 0; cx < gridW; cx++) {
      const centreX = gridOriginX + (cx + 0.5) * CELL
      let count = 0
      for (let i = 0; i < n; i += COARSE_STRIDE) {
        const dx = px[i]! - centreX
        const dz = pz[i]! - centreZ
        if (dx * dx + dz * dz <= cellReach2) count++
      }
      cellStart[cz * gridW + cx + 1] = count
    }
  }
  for (let c = 0; c < cellCount; c++) cellStart[c + 1] = cellStart[c + 1]! + cellStart[c]!
  const cellItems = new Int32Array(cellStart[cellCount]!)
  {
    const cursor = new Int32Array(cellCount)
    for (let cz = 0; cz < gridH; cz++) {
      const centreZ = gridOriginZ + (cz + 0.5) * CELL
      for (let cx = 0; cx < gridW; cx++) {
        const centreX = gridOriginX + (cx + 0.5) * CELL
        const c = cz * gridW + cx
        for (let i = 0; i < n; i += COARSE_STRIDE) {
          const dx = px[i]! - centreX
          const dz = pz[i]! - centreZ
          if (dx * dx + dz * dz <= cellReach2) {
            cellItems[cellStart[c]! + cursor[c]!] = i
            cursor[c] = cursor[c]! + 1
          }
        }
      }
    }
  }

  // --- frame sampling -------------------------------------------------------
  const sampleInto = (t: number, out: TrackSample): TrackSample => {
    const f = wrap01(t) * n
    const i0 = Math.floor(f)
    const u = f - i0
    const a = i0 % n
    const b = (a + 1) % n

    out.position.set(
      px[a]! + (px[b]! - px[a]!) * u,
      py[a]! + (py[b]! - py[a]!) * u,
      pz[a]! + (pz[b]! - pz[a]!) * u,
    )

    out.tangent
      .set(
        tx[a]! + (tx[b]! - tx[a]!) * u,
        ty[a]! + (ty[b]! - ty[a]!) * u,
        tz[a]! + (tz[b]! - tz[a]!) * u,
      )
      .normalize()

    out.normal.set(
      nx[a]! + (nx[b]! - nx[a]!) * u,
      ny[a]! + (ny[b]! - ny[a]!) * u,
      nz[a]! + (nz[b]! - nz[a]!) * u,
    )
    /*
     * Re-orthogonalise against the tangent before normalising. Lerping two unit
     * normals a metre apart and calling it done leaves `normal` a fraction of a
     * degree off perpendicular; `right = tangent × normal` then comes out
     * slightly short, and anything treating the three as an orthonormal basis —
     * the kart's contact frame, the camera's up — picks up a small shear that is
     * invisible per frame and accumulates.
     */
    const dot =
      out.normal.x * out.tangent.x + out.normal.y * out.tangent.y + out.normal.z * out.tangent.z
    out.normal.x -= out.tangent.x * dot
    out.normal.y -= out.tangent.y * dot
    out.normal.z -= out.tangent.z * dot
    out.normal.normalize()

    out.right.crossVectors(out.tangent, out.normal)

    out.halfWidth = halfWidth[a]! + (halfWidth[b]! - halfWidth[a]!) * u
    out.bank = bank[a]! + (bank[b]! - bank[a]!) * u
    out.curvature = curvature[a]! + (curvature[b]! - curvature[a]!) * u
    return out
  }

  // --- start grid -----------------------------------------------------------
  /*
   * Eight slots, two abreast, on the 35 m apron in front of the line — which is
   * why the apron exists, is straight, and is flat. `StartSlot.orientation` is a
   * full quaternion rather than a yaw because the contract says so; here the
   * grid IS level so it costs nothing, and it stays correct if the elevation
   * table ever moves under it.
   */
  const startGrid: StartSlot[] = []
  {
    const scratch: TrackSample = {
      position: new Vector3(),
      tangent: new Vector3(),
      normal: new Vector3(),
      right: new Vector3(),
      halfWidth: 0,
      bank: 0,
      curvature: 0,
    }
    const basis = new Matrix4()
    const backward = new Vector3()
    for (let i = 0; i < 8; i++) {
      const t = wrap01((length - (6 + (i >> 1) * 7)) / length)
      sampleInto(t, scratch)
      const position = new Vector3()
        .copy(scratch.position)
        .addScaledVector(scratch.right, (i % 2 === 0 ? -1 : 1) * 2.7)
      // Basis columns are the kart's local axes: +X right, +Y up, +Z BACKWARD,
      // because the contract's identity rotation faces -Z.
      backward.copy(scratch.tangent).multiplyScalar(-1)
      basis.makeBasis(scratch.right, scratch.normal, backward)
      startGrid.push({
        position,
        orientation: new Quaternion().setFromRotationMatrix(basis),
        t,
      })
    }
  }

  // --- the interface --------------------------------------------------------
  const group = new Object3D()
  group.name = 'world/track'

  const track: ITrack & Subsystem = {
    name: 'world/track',
    length,
    group,
    checkpoints,
    startGrid,

    sample: sampleInto,

    locate(p: Vector3, out: TrackLocation): TrackLocation {
      const qx = p.x
      const qy = p.y
      const qz = p.z

      // 1. Broad phase: the bucket this point sits in.
      let cx = Math.floor((qx - gridOriginX) / CELL)
      let cz = Math.floor((qz - gridOriginZ) / CELL)
      if (cx < 0) cx = 0
      else if (cx >= gridW) cx = gridW - 1
      if (cz < 0) cz = 0
      else if (cz >= gridH) cz = gridH - 1
      const cell = cz * gridW + cx
      const lo = cellStart[cell]!
      const hi = cellStart[cell + 1]!

      let seed = 0
      let bestD2 = Infinity
      if (hi > lo) {
        for (let k = lo; k < hi; k++) {
          const i = cellItems[k]!
          const dx = px[i]! - qx
          const dy = py[i]! - qy
          const dz = pz[i]! - qz
          const d2 = dx * dx + dy * dy + dz * dz
          if (d2 < bestD2) {
            bestD2 = d2
            seed = i
          }
        }
      } else {
        /*
         * Off the edge of the index entirely — a kart launched off the mesa, or
         * a harness `seek` to a silly coordinate. Fall back to the full coarse
         * scan rather than returning a confident wrong answer. 203 tests, and
         * it cannot happen while anybody is racing.
         */
        for (let i = 0; i < n; i += COARSE_STRIDE) {
          const dx = px[i]! - qx
          const dy = py[i]! - qy
          const dz = pz[i]! - qz
          const d2 = dx * dx + dy * dy + dz * dz
          if (d2 < bestD2) {
            bestD2 = d2
            seed = i
          }
        }
      }

      // 2. Narrow phase: exact point-to-segment projection over the fine
      //    samples bracketing the winning coarse node. ±STRIDE, so the true
      //    nearest cannot fall outside the window on any radius this circuit has.
      let bestIdx = seed
      let bestU = 0
      bestD2 = Infinity
      for (let d = -COARSE_STRIDE; d < COARSE_STRIDE; d++) {
        const i = (seed + d + n) % n
        const j = (i + 1) % n
        const ax = px[i]!
        const ay = py[i]!
        const az = pz[i]!
        const ex = px[j]! - ax
        const ey = py[j]! - ay
        const ez = pz[j]! - az
        const seg2 = ex * ex + ey * ey + ez * ez
        let u = seg2 > 0 ? ((qx - ax) * ex + (qy - ay) * ey + (qz - az) * ez) / seg2 : 0
        if (u < 0) u = 0
        else if (u > 1) u = 1
        const wx = qx - (ax + ex * u)
        const wy = qy - (ay + ey * u)
        const wz = qz - (az + ez * u)
        const d2 = wx * wx + wy * wy + wz * wz
        if (d2 < bestD2) {
          bestD2 = d2
          bestIdx = i
          bestU = u
        }
      }

      const a = bestIdx
      const b = (a + 1) % n
      const u = bestU

      const dx = qx - (px[a]! + (px[b]! - px[a]!) * u)
      const dy = qy - (py[a]! + (py[b]! - py[a]!) * u)
      const dz = qz - (pz[a]! + (pz[b]! - pz[a]!) * u)

      const rxi = rx[a]! + (rx[b]! - rx[a]!) * u
      const ryi = ry[a]! + (ry[b]! - ry[a]!) * u
      const rzi = rz[a]! + (rz[b]! - rz[a]!) * u
      const rl = Math.hypot(rxi, ryi, rzi) || 1
      const nxi = nx[a]! + (nx[b]! - nx[a]!) * u
      const nyi = ny[a]! + (ny[b]! - ny[a]!) * u
      const nzi = nz[a]! + (nz[b]! - nz[a]!) * u
      const nl = Math.hypot(nxi, nyi, nzi) || 1

      const t = wrap01((a + u) / n)
      const lateral = (dx * rxi + dy * ryi + dz * rzi) / rl
      const hw = halfWidth[a]! + (halfWidth[b]! - halfWidth[a]!) * u

      out.t = t
      out.lateral = lateral
      out.height = (dx * nxi + dy * nyi + dz * nzi) / nl
      out.onTrack = Math.abs(lateral) <= hw + BARRIER_MARGIN

      // Eight comparisons beats a bucketed lookup table. A table gets the answer
      // wrong for the few metres either side of every checkpoint, and "wrong for
      // 3 m at exactly the line" is a lap that does not count.
      let cp = checkpointCount - 1
      for (let i = 1; i < checkpointCount; i++) {
        if (t < checkpoints[i]!) {
          cp = i - 1
          break
        }
      }
      out.checkpointIndex = cp
      return out
    },

    surfaceAt(t: number, lateral: Metres): Surface {
      const w = wrap01(t)
      const f = w * n
      const i0 = Math.floor(f)
      const uu = f - i0
      const a = i0 % n
      const b = (a + 1) % n
      const hw = halfWidth[a]! + (halfWidth[b]! - halfWidth[a]!) * uu
      const curv = curvature[a]! + (curvature[b]! - curvature[a]!) * uu

      const off = Math.abs(lateral) - hw
      if (off > BARRIER_MARGIN) return Surface.OffTrack
      if (off > 0) return Surface.Gravel

      // Kerbs win over everything inside the road edge, including the tunnel.
      // §11 `banked-wall` grades the 6.4:1 kerb value contrast, and a kerb a
      // boost pad or a sand band can overwrite is a kerb that disappears from
      // exactly the frames that measure it.
      const kerbed = Math.abs(curv) > KERB_MIN_CURVATURE
      if (kerbed && off > -KERB_WIDTH) return Surface.Kerb

      for (let i = 0; i < pads.length; i += 4) {
        if (w >= pads[i]! && w <= pads[i + 1]! && lateral >= pads[i + 2]! && lateral <= pads[i + 3]!) {
          return Surface.BoostPad
        }
      }

      if (inRanges(metalBands, w)) return Surface.Metal
      // Sealed tarmac runs wall to wall, with no sand creep at the edges: The
      // Slot and the arch are the two sections with no wind reaching the floor.
      if (inRanges(asphalt, w)) return Surface.Asphalt
      if (inRanges(sandBands, w)) return Surface.SandDrift
      /*
       * THE EDGE DRIFT STOPS AT A KERB, and the `!kerbed` is the whole point.
       *
       * Without it the lateral profile at every kerbed corner is
       * NON-MONOTONIC: Kerb 0.95 -> SandDrift 0.62 -> DustyAsphalt 0.88, with
       * the sand exactly `SAND_EDGE_WIDTH - KERB_WIDTH` = 0.75 m wide, pinned
       * between two grippier surfaces at the apex. 61.1% of the lap had one. It
       * rewards running WIDER onto the kerb over a tidy apex, which is backwards
       * — and a 0.3 m wander at an apex drops one wheel from 0.95 to 0.62 and
       * back for no reason a driver can construct.
       *
       * It was also INVISIBLE. `road.ts` derives its vertex colours from this
       * function precisely so that what the tyre reads and what the player sees
       * cannot drift apart, but its lateral stations are fractions of the
       * half-width, and on this circuit's 8.0-16.0 m profile not one of them
       * ever lands between `KERB_WIDTH` and `SAND_EDGE_WIDTH`. Measured over
       * 20000 stations: 11779 samples carried a kerb-edge sliver and a road
       * vertex fell inside NONE of them. (446 more looked like slivers to the
       * probe and all 446 had a vertex — those are the full-width wash bands
       * under a kerb, which are sand on purpose and survive this change.) So
       * the sliver had no vertex anywhere to tint, and §7's "the player learns
       * what is under them without looking down" was quietly false for 0.75 m
       * of every apex.
       *
       * Two independent band rules stacked without either knowing about the
       * other — the same shape of bug as `RACING_MARGIN` above, in the same
       * function. A kerb is a built edge: it is the thing that stops the drift,
       * so there is no sand behind one. The wash's full-width `sandBands` are
       * checked above this line and are unaffected; those are meant to be seen.
       */
      if (!kerbed && off > -SAND_EDGE_WIDTH) return Surface.SandDrift
      return Surface.DustyAsphalt
    },

    racingLine: racingLineAt,

    build(): void {
      group.add(
        buildRoad(track, {
          rng: ctx.rngFor('world/track').fork('road'),
          textureSize: Math.min(1024, ctx.quality.maxTextureSize),
          // §5: "anisotropy min(8, maxAnisotropy) on road and sand".
          anisotropy: Math.min(8, ctx.quality.maxAnisotropy),
        }),
      )
      ctx.scene.add(group)
    },

    dispose(): void {
      group.removeFromParent()
      disposeRoad(group)
      group.clear()
    },
  }

  return track
}
