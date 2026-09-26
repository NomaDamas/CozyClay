import * as THREE from "three";
import { findBone, ikTouch, ikBakeKeyframe, solveHipsTranslate, solveIk } from "./ik.js";

/**
 * AutoPhysics: a physical-plausibility pass for generated motion, modelled on
 * Cascadeur's ballistic-trajectory tool.
 *
 * While a character is in the air nothing but gravity acts on it, so its
 * CENTRE OF MASS must trace a parabola: a vertical velocity that falls off at
 * exactly g. Generated clips routinely break that — the character floats at
 * the apex, hovers for a few frames, or decelerates on the way down — and the
 * eye reads it instantly as "fake", even when every limb pose is fine.
 *
 * v1 fixes the ROOT height during airborne spans, which is both the cheapest
 * and the most effective correction available:
 *
 * - The CoM is a mass-weighted average of body-segment midpoints (Dempster's
 *   anthropometric fractions), so it already accounts for a swinging arm or a
 *   tucked leg without needing to touch either.
 * - Translating the hips rigidly moves EVERY segment by the same vector, so
 *   the CoM moves by exactly that vector too. The correction needed at a
 *   frame is therefore literally `fittedY − actualY` — no iteration, no
 *   solver.
 * - Only airborne spans are touched. A grounded frame has a foot carrying
 *   load, gravity is not the only force, and no parabola applies.
 *
 * Three rules earn the pass its right to run unattended on real clips, and
 * each exists because the naive version failed on one:
 *
 *  - VERTICAL ONLY. Floating is a height artefact. Line-fitting x/z as well
 *    turned a mis-detected span into metres of horizontal displacement, so
 *    the lateral track is now read-only: fitted positions keep each sample's
 *    own x and z.
 *  - CLIP-RELATIVE GROUND. Absolute floor thresholds (bone height vs. a
 *    measured mesh drop) misclassify standing as flight on any rig whose
 *    soles rest a couple of centimetres above y = 0 — which is most of them.
 *    The planted height of each foot marker is instead MEASURED from the clip
 *    itself, as that marker's minimum over the range.
 *  - REFUSE RATHER THAN WRECK. A span whose fit is wild is not a flight
 *    phase, it is a detection error; those spans are reported and skipped
 *    instead of being "corrected" by half a body length.
 *  - ANCHORED ARCS. The parabola is pinned to the take-off and landing
 *    samples rather than least-squares fitted, so the correction is zero
 *    where the pass hands back to the clip and largest where the floating
 *    actually is. That single choice is what makes the hand-off seamless and
 *    the whole pass a fixed point; see fitBallisticArc.
 *
 * Corrections are written through ikTouch/ikBakeKeyframe, so an AutoPhysics
 * pass is an ordinary IK correction key: scrubbable, undoable, and eased back
 * into the clip outside its keyed range by ikEvaluate's blend window.
 */

/* --- body segments ---------------------------------------------------------- */

/**
 * Segment mass fractions of total body mass, from Dempster's cadaver study
 * (Dempster, W.T., "Space Requirements of the Seated Operator", WADC TR
 * 55-159, 1955), in the tabulation popularised by Winter, "Biomechanics and
 * Motor Control of Human Movement". The trunk (0.497) is split into pelvis
 * (0.142) and thorax+abdomen (0.355); distal pairs are merged because their
 * combined centroid still lands near the segment midpoint and Mixamo's hand
 * and toe bones are too short to place reliably:
 *
 *   head+neck 0.081 · trunk 0.497 · upper arm 0.028 · forearm 0.016 +
 *   hand 0.006 = 0.022 · thigh 0.100 · shank 0.0465 + foot 0.0145 = 0.061
 *
 * Each entry names the two Mixamo bones whose MIDPOINT carries the fraction.
 * Dempster's true centres of mass sit ~43% down each segment rather than at
 * 50%, but the difference is a couple of centimetres on a limb and cancels
 * almost exactly between the left and right sides — while the midpoint keeps
 * the table readable and needs no extra per-segment constant.
 *
 * The fractions sum to 1, so the weighted average below is a true CoM.
 */
export const SEGMENT_MASSES = [
	{ id: "pelvis", start: "mixamorigHips", end: "mixamorigSpine1", mass: 0.142 },
	{ id: "torso", start: "mixamorigSpine1", end: "mixamorigNeck", mass: 0.355 },
	{ id: "head", start: "mixamorigNeck", end: "mixamorigHead", mass: 0.081 },
	{ id: "leftUpperArm", start: "mixamorigLeftArm", end: "mixamorigLeftForeArm", mass: 0.028 },
	{ id: "leftForeArmHand", start: "mixamorigLeftForeArm", end: "mixamorigLeftHand", mass: 0.022 },
	{ id: "rightUpperArm", start: "mixamorigRightArm", end: "mixamorigRightForeArm", mass: 0.028 },
	{ id: "rightForeArmHand", start: "mixamorigRightForeArm", end: "mixamorigRightHand", mass: 0.022 },
	{ id: "leftThigh", start: "mixamorigLeftUpLeg", end: "mixamorigLeftLeg", mass: 0.100 },
	{ id: "leftShankFoot", start: "mixamorigLeftLeg", end: "mixamorigLeftFoot", mass: 0.061 },
	{ id: "rightThigh", start: "mixamorigRightUpLeg", end: "mixamorigRightLeg", mass: 0.100 },
	{ id: "rightShankFoot", start: "mixamorigRightLeg", end: "mixamorigRightFoot", mass: 0.061 },
];

/**
 * World-space centre of mass of the rig's CURRENT pose: the mass-weighted
 * average of every segment's midpoint. Returns null when any segment bone is
 * missing — a partial CoM would silently drift the correction toward
 * whichever half of the body did resolve, so the caller must instead hide the
 * tool (the same all-or-nothing policy resolveIkRig uses).
 */
export function computeCenterOfMass(rig) {
	if (!rig) return null;
	rig.updateMatrixWorld(true);
	const com = new THREE.Vector3();
	const start = new THREE.Vector3();
	const end = new THREE.Vector3();
	let total = 0;
	for (const segment of SEGMENT_MASSES) {
		const a = findBone(rig, segment.start);
		const b = findBone(rig, segment.end);
		if (!a || !b) return null;
		a.getWorldPosition(start);
		b.getWorldPosition(end);
		com.addScaledVector(start.add(end).multiplyScalar(0.5), segment.mass);
		total += segment.mass;
	}
	if (total <= 0) return null;
	return com.divideScalar(total);
}

/* --- airborne detection ----------------------------------------------------- */

/** Shortest run of airborne frames worth correcting. Anything briefer is a
 * one- or two-frame detection blip from a foot skimming the floor, not a
 * flight phase, and fitting a parabola to it would amplify the noise. */
export const MIN_AIRBORNE_FRAMES = 4;

/**
 * How far above its own PLANTED height a foot marker must rise before the
 * frame counts as airborne.
 *
 * This replaces the absolute floor test the first version used, which was
 * wrong in practice on every rig measured: characters rest with their soles a
 * couple of centimetres above y = 0, ankles sit 12 cm up, and measured mesh
 * drops disagree with both — so a plain STANDING frame cleared the absolute
 * thresholds and a whole clip was declared airborne. The planted height is
 * therefore taken from the clip (see `plantedFloor`), and this constant is
 * the only absolute number left: 6 cm is above the few centimetres a heel
 * lifts during a normal stride or a weight shift, and far below the tens of
 * centimetres of a real jump.
 */
export const AIRBORNE_LIFT = 0.06;

/**
 * The floor markers, matching ik.js's contact model: the ankle bones plus the
 * toe bases, because a foot rolling onto its toe keeps the ankle high while
 * the character is still very much on the ground.
 */
export const FOOT_MARKERS = ["mixamorigLeftFoot", "mixamorigRightFoot", "mixamorigLeftToeBase", "mixamorigRightToeBase"];

/**
 * World Y of every foot marker in the rig's CURRENT pose, keyed by bone name.
 * Returns null when a marker is missing — the caller then cannot judge
 * contact at all and must decline to correct anything.
 */
export function markerHeights(rig) {
	if (!rig) return null;
	rig.updateMatrixWorld(true);
	const position = new THREE.Vector3();
	const out = {};
	for (const name of FOOT_MARKERS) {
		const bone = findBone(rig, name);
		if (!bone) return null;
		bone.getWorldPosition(position);
		out[name] = position.y;
	}
	return out;
}

/**
 * Each marker's PLANTED height for this clip: its minimum over every sampled
 * frame. That minimum is by definition a frame where the marker was as low as
 * this performance ever puts it, which is the only trustworthy definition of
 * "on the ground" available without trusting the export's floor — and it
 * absorbs sole float, mesh-drop measurement error and a mis-set floorY all at
 * once. Returns null for an empty sample list.
 */
export function plantedFloor(perFrameHeights) {
	if (!perFrameHeights?.length) return null;
	const out = {};
	for (const name of FOOT_MARKERS) {
		let min = Infinity;
		for (const heights of perFrameHeights) {
			const y = heights?.[name];
			if (Number.isFinite(y) && y < min) min = y;
		}
		if (!Number.isFinite(min)) return null;
		out[name] = min;
	}
	return out;
}

/** The airborne rule itself, over PRE-MEASURED heights: every marker must
 * clear its own planted height by `lift`. Exported both so the driver never
 * re-poses the rig to re-ask a question it already has the answer to, and so
 * the rule can be checked against heights measured off a real character
 * without needing that character present. */
export function heightsAirborne(heights, planted, lift = AIRBORNE_LIFT) {
	if (!heights || !planted) return false;
	for (const name of FOOT_MARKERS) {
		if (!(heights[name] > planted[name] + lift)) return false;
	}
	return true;
}

/**
 * Is the rig's CURRENT pose airborne, relative to this clip's planted floor?
 * True only when EVERY foot marker — both ankles and both toe bases — rises
 * more than `lift` above its own planted height. A single low toe makes the
 * frame grounded, which is the conservative direction: mistaking flight for
 * contact merely skips a correction, while mistaking contact for flight drags
 * a planted foot off the floor (or, as the first version managed, buries a
 * standing character to the chest).
 *
 * `planted` comes from `plantedFloor`. Returns false when it is missing or a
 * marker bone cannot be found — an unprovable claim of flight, again the safe
 * answer.
 */
export function frameAirborne(rig, planted, lift = AIRBORNE_LIFT) {
	return heightsAirborne(markerHeights(rig), planted, lift);
}

/* --- grounded contact ------------------------------------------------------ */

/** Contact must stay close to its clip-relative low and vertically settled.
 * The final run gate below is stricter still: an ankle that wanders more than
 * three centimetres was walking, not planted, and is never snapped backward. */
export const GROUND_CONTACT_LIFT = 0.06;
export const GROUND_CONTACT_VERTICAL_SPEED = 0.6;
export const GROUND_CONTACT_HORIZONTAL_SPEED = 0.12;
export const GROUND_CONTACT_MIN_SECONDS = 0.10;
export const GROUND_LOCK_MAX_PULL = 0.03;
export const GROUND_LOCK_EPSILON = 0.005;
export const GROUND_LOCK_REACH_LIFT = 0.005;
export const GROUND_FLOOR_MAX_LIFT = 0.15;
export const GROUND_FLOOR_EPSILON = 0.005;

const FOOT_SIDES = [
	{ side: "left", chainId: "leftFoot", ankle: "mixamorigLeftFoot", toe: "mixamorigLeftToeBase", height: "LeftFoot" },
	{ side: "right", chainId: "rightFoot", ankle: "mixamorigRightFoot", toe: "mixamorigRightToeBase", height: "RightFoot" },
];

/** World positions of the same four markers markerHeights reads. */
export function markerPositions(rig) {
	if (!rig) return null;
	rig.updateMatrixWorld(true);
	const out = {};
	for (const name of FOOT_MARKERS) {
		const bone = findBone(rig, name);
		if (!bone) return null;
		out[name] = bone.getWorldPosition(new THREE.Vector3());
	}
	return out;
}

function median(values) {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) * 0.5;
}

function trueRuns(flags, minFrames) {
	const runs = [];
	let open = -1;
	for (let index = 0; index <= flags.length; index += 1) {
		const on = index < flags.length && flags[index];
		if (on && open < 0) open = index;
		if (on || open < 0) continue;
		if (index - open >= minFrames) runs.push({ start: open, end: index - 1, length: index - open });
		open = -1;
	}
	return runs;
}

/**
 * Find contact runs that are safe to lock. Height and vertical speed find a
 * stance candidate; total XZ wander then separates a planted foot from a slow
 * step. Runs outside the pull limit are reported as rejected instead of being
 * chopped into artificial mini-plants with visible jumps between anchors.
 */
export function detectGroundContactSpans({
	positions,
	planted,
	fps = 30,
	startFrame = 0,
	contactLift = GROUND_CONTACT_LIFT,
	verticalSpeed = GROUND_CONTACT_VERTICAL_SPEED,
	horizontalSpeed = GROUND_CONTACT_HORIZONTAL_SPEED,
	minSeconds = GROUND_CONTACT_MIN_SECONDS,
	maxPull = GROUND_LOCK_MAX_PULL,
} = {}) {
	if (!positions?.length || !planted) return { spans: [], rejected: [] };
	const rate = Number.isFinite(fps) && fps > 0 ? fps : 30;
	const minFrames = Math.max(3, Math.round(minSeconds * rate));
	const half = Math.max(1, Math.round((2 / 30) * rate));
	const spans = [];
	const rejected = [];
	for (const foot of FOOT_SIDES) {
		const flags = positions.map((frame, index) => {
			const ankle = frame?.[foot.ankle];
			const toe = frame?.[foot.toe];
			if (!ankle || !toe) return false;
			const before = positions[Math.max(0, index - half)]?.[foot.ankle];
			const after = positions[Math.min(positions.length - 1, index + half)]?.[foot.ankle];
			if (!before || !after) return false;
			const seconds = Math.max(1 / rate, (Math.min(positions.length - 1, index + half) - Math.max(0, index - half)) / rate);
			const vy = Math.abs(after.y - before.y) / seconds;
			const vxz = Math.hypot(after.x - before.x, after.z - before.z) / seconds;
			const low = Math.min(ankle.y - planted[foot.ankle], toe.y - planted[foot.toe]);
			// A low foot can still be in the sliding/swinging part of a step.
			// Horizontal speed breaks a long low run into its real plant phases;
			// maxPull below remains the second guard against slow large drifts.
			return low <= contactLift && vy <= verticalSpeed && vxz <= horizontalSpeed;
		});
		for (const run of trueRuns(flags, minFrames)) {
			const ankles = positions.slice(run.start, run.end + 1).map((frame) => frame[foot.ankle]);
			const anchor = new THREE.Vector3(
				median(ankles.map((point) => point.x)),
				median(ankles.map((point) => point.y)),
				median(ankles.map((point) => point.z)),
			);
			const pull = Math.max(...ankles.map((point) => Math.hypot(point.x - anchor.x, point.z - anchor.z)));
			const span = {
				side: foot.side,
				chainId: foot.chainId,
				start: startFrame + run.start,
				end: startFrame + run.end,
				length: run.length,
				anchor,
				maxPull: pull,
			};
			if (pull <= maxPull + 1e-9) spans.push(span);
			else rejected.push({ ...span, reason: "foot-moving" });
		}
	}
	return { spans, rejected };
}

/**
 * Group per-frame airborne flags into contiguous spans of at least
 * `minLength` frames. `isAirborne` is either an array indexed from
 * `startFrame` or a predicate called with the absolute frame number.
 * Returned spans carry ABSOLUTE frame numbers, inclusive at both ends.
 */
export function detectAirborneSpans({ frames, isAirborne, startFrame = 0, minLength = MIN_AIRBORNE_FRAMES } = {}) {
	const count = Math.max(0, Math.round(frames) || 0);
	const flagAt = typeof isAirborne === "function"
		? (index) => Boolean(isAirborne(startFrame + index))
		: (index) => Boolean(isAirborne?.[index]);
	const spans = [];
	let open = -1;
	for (let index = 0; index <= count; index += 1) {
		const flag = index < count && flagAt(index);
		if (flag && open < 0) open = index;
		if (flag || open < 0) continue;
		const length = index - open;
		if (length >= minLength) spans.push({ start: startFrame + open, end: startFrame + index - 1, length });
		open = -1;
	}
	return spans;
}

/**
 * The clearance a marker needs to STAY inside a span it is already part of —
 * the low half of a hysteresis pair with AIRBORNE_LIFT.
 *
 * A single threshold cannot both reject a stride and accept a take-off. The
 * 6 cm entry lift is set high enough to ignore a heel lift, which means the
 * first and last frames of a real jump — the ones where the foot has only
 * just left the ground — fall below it and the span is truncated at both
 * ends. A truncated span then gets a zero pin one frame from a full-strength
 * correction, and the result is a one-frame snap: on the QA clip the CoM's
 * vertical acceleration jumped from −8.6 to −36.5 m/s², roughly 4 g, at the
 * frame after the pin. Growing each span back out at 2 cm recovers exactly
 * those take-off and landing frames without letting a stride start one.
 */
export const EXIT_LIFT = 0.02;

/**
 * How deep an interior dip in the centre of mass must be, measured against
 * the lower of the two peaks around it, before it is read as a landing
 * between two separate arcs rather than noise inside one.
 *
 * Two hops in quick succession never plant a foot low enough to break the
 * span, so detection hands over one span holding two parabolas. Fitting a
 * single arc to that asks for 73 cm corrections at a 42 cm RMS — the sanity
 * gate then refuses the whole thing and the clip's actual jump goes
 * uncorrected. 8 cm of prominence is far more than a CoM ripple inside one
 * flight and far less than the trough between two real hops.
 */
export const SPLIT_DEPTH = 0.08;

/** Frames at each end of an arc over which the correction eases in and out.
 * See `edgeTaperWeight`. */
export const EDGE_TAPER = 2;

/**
 * Widen each span outward while every marker still clears its planted height
 * by `exitLift`, without ever reaching into a neighbouring span.
 *
 * `canExtend` is a per-frame boolean array indexed from `startFrame` — the
 * same airborne test run at the lower threshold. Spans are processed in
 * order, and each one's left growth stops at the previous span's ALREADY
 * EXPANDED end, so two spans can end up adjacent but never overlapping or
 * merging.
 */
export function expandAirborneSpans({ spans, canExtend, startFrame = 0 } = {}) {
	const list = spans ?? [];
	const flags = canExtend ?? [];
	const flagAt = (frame) => Boolean(flags[frame - startFrame]);
	const lastFrame = startFrame + flags.length - 1;
	const out = [];
	for (let index = 0; index < list.length; index += 1) {
		const span = list[index];
		const floorLimit = index > 0 ? out[index - 1].end + 1 : startFrame;
		const ceilLimit = index + 1 < list.length ? list[index + 1].start - 1 : lastFrame;
		let from = span.start;
		let to = span.end;
		while (from - 1 >= floorLimit && flagAt(from - 1)) from -= 1;
		while (to + 1 <= ceilLimit && flagAt(to + 1)) to += 1;
		out.push({ start: from, end: to, length: to - from + 1 });
	}
	return out;
}

/** The deepest interior dip in `values[from..to]` whose prominence — its depth
 * below the LOWER of the highest point on each side — clears `splitDepth`, or
 * −1 when the range holds no such dip. Prominence rather than a bare local
 * minimum is what distinguishes a landing from a wobble: a 2 mm ripple at the
 * apex is a local minimum too. */
function deepestTrough(values, from, to, splitDepth) {
	const span = to - from + 1;
	if (span < 3) return -1;
	const leftMax = new Array(span);
	const rightMax = new Array(span);
	leftMax[0] = values[from];
	for (let index = 1; index < span; index += 1) leftMax[index] = Math.max(leftMax[index - 1], values[from + index]);
	rightMax[span - 1] = values[to];
	for (let index = span - 2; index >= 0; index -= 1) rightMax[index] = Math.max(rightMax[index + 1], values[from + index]);
	let best = -1;
	let bestProminence = splitDepth;
	for (let index = 1; index < span - 1; index += 1) {
		const prominence = Math.min(leftMax[index], rightMax[index]) - values[from + index];
		if (prominence > bestProminence) {
			bestProminence = prominence;
			best = from + index;
		}
	}
	return best;
}

/**
 * Cut a span's centre-of-mass height track into single ballistic arcs at its
 * interior troughs, recursively, and return the resulting index ranges as
 * inclusive `[from, to]` pairs (relative to the input array).
 *
 * The trough frame ENDS its left arc: it is the lowest point of the descent
 * that precedes it, and the arc after it launches from the next frame. No
 * range is discarded here — a caller that needs a minimum length filters the
 * result, because "too short to fit" and "not an arc" are different verdicts
 * worth reporting differently.
 */
export function splitAtTroughs(heights, { splitDepth = SPLIT_DEPTH } = {}) {
	const values = heights ?? [];
	const out = [];
	const recurse = (from, to) => {
		const cut = deepestTrough(values, from, to, splitDepth);
		if (cut < 0) {
			out.push([from, to]);
			return;
		}
		recurse(from, cut);
		recurse(cut + 1, to);
	};
	if (values.length) recurse(0, values.length - 1);
	return out;
}

/**
 * Correction strength at `index` within an arc of `length` frames: 1 across
 * the middle, easing to a fraction over the first and last `taper` frames.
 *
 * Applying a correction at full strength on the very first frame of an arc,
 * one frame after a zero pin, is a step change in position — which is an
 * impulse in acceleration, and reads as a one-frame snap however correct the
 * arc either side of it is. Ramping in over two frames spreads that step
 * across three, and the smoothstep shape means the ramp meets the flat middle
 * without a corner of its own. The interior — where the physics claim
 * actually lives — is untouched at weight 1.
 */
export function edgeTaperWeight(index, length, taper = EDGE_TAPER) {
	if (!(taper > 0) || length <= 2) return 1;
	const ramp = Math.min(Math.round(taper), Math.floor((length - 1) / 2));
	if (ramp <= 0) return 1;
	const steps = Math.min(index, length - 1 - index);
	if (steps >= ramp) return 1;
	const x = (steps + 1) / (ramp + 1);
	return x * x * (3 - 2 * x);
}

/* --- ballistic fit ---------------------------------------------------------- */

/** Standard gravity (m/s²). */
export const GRAVITY = 9.81;

/**
 * Least-squares line through (t, value) pairs, solved from the 2×2 normal
 * equations directly — two unknowns need no matrix library, and writing the
 * closed form keeps the module dependency-free.
 *
 *   [ n    Σt  ] [ a ]   [ Σv   ]
 *   [ Σt   Σt² ] [ b ] = [ Σt·v ]
 *
 * Returns { a, b } for value ≈ a + b·t. A single sample (or a degenerate
 * determinant, i.e. every t identical) yields the mean with zero slope,
 * which is the correct limit rather than a divide-by-zero.
 */
function fitLine(times, values) {
	const n = times.length;
	if (n === 0) return { a: 0, b: 0 };
	let sumT = 0;
	let sumTT = 0;
	let sumV = 0;
	let sumTV = 0;
	for (let index = 0; index < n; index += 1) {
		const t = times[index];
		const v = values[index];
		sumT += t;
		sumTT += t * t;
		sumV += v;
		sumTV += t * v;
	}
	const det = n * sumTT - sumT * sumT;
	if (Math.abs(det) < 1e-12) return { a: sumV / n, b: 0 };
	return {
		a: (sumTT * sumV - sumT * sumTV) / det,
		b: (n * sumTV - sumT * sumV) / det,
	};
}

/**
 * Fit a ballistic HEIGHT curve to consecutive CoM samples.
 *
 * Gravity is not negotiable, so it is FIXED at `g` and the only free
 * parameters are the launch height y0 and the launch velocity v0.
 * Substituting d = y + ½·g·t² turns y = y0 + v0·t − ½·g·t² into the straight
 * line d = y0 + v0·t, which the 2×2 normal equations above solve. Leaving g
 * free would let the fitter "explain" a hover as weak gravity — exactly the
 * artefact this pass exists to remove.
 *
 * The horizontal track is deliberately NOT fitted. In principle x and z are
 * straight lines in flight; in practice fitting them meant that any span the
 * detector got wrong came back with metres of sideways displacement, while
 * the artefact users actually see — floating — is purely vertical. Each
 * fitted position therefore carries its own sample's x and z unchanged, so
 * `fitted − actual` is a pure Y vector by construction.
 *
 * `samples` are CoM positions at CONSECUTIVE frames; times come from `fps`.
 *
 * `fitFrom`/`fitTo` restrict WHICH samples steer the solve, while positions
 * are still produced for every sample by evaluating the curve. The driver uses
 * this to exclude the frames it intends to taper: those frames keep part of
 * the clip's own trajectory on purpose, so letting them pull the fit would
 * both bias the arc and — because the next run would then fit a slightly
 * different curve — cost the pass its idempotence.
 *
 * Returns the fitted per-frame positions, the recovered launch state, and the
 * RMS vertical residual OVER THE FITTED SUBSET (the honest "how ballistic was
 * this already?" number the span gate reads).
 */
export function fitBallistic(samples, fps, g = GRAVITY, { fitFrom = 0, fitTo = null } = {}) {
	const list = samples ?? [];
	const rate = Number.isFinite(fps) && fps > 0 ? fps : 30;
	const times = list.map((_, index) => index / rate);
	const from = Math.max(0, Math.min(fitFrom, list.length - 1));
	const to = Math.min(list.length - 1, Number.isFinite(fitTo) ? fitTo : list.length - 1);
	const used = [];
	for (let index = from; index <= to; index += 1) used.push(index);
	// d = y + ½·g·t² is linear in t with slope v0 and intercept y0.
	const vertical = fitLine(
		used.map((index) => times[index]),
		used.map((index) => list[index].y + 0.5 * g * times[index] * times[index]),
	);
	const positions = list.map((sample, index) => {
		const t = times[index];
		return new THREE.Vector3(sample.x ?? 0, vertical.a + vertical.b * t - 0.5 * g * t * t, sample.z ?? 0);
	});
	let sumSq = 0;
	for (const index of used) {
		const error = list[index].y - positions[index].y;
		sumSq += error * error;
	}
	return {
		positions,
		y0: vertical.a,
		v0: vertical.b,
		g,
		fitFrom: used.length ? used[0] : 0,
		fitTo: used.length ? used[used.length - 1] : 0,
		residual: used.length ? Math.sqrt(sumSq / used.length) : 0,
	};
}

/**
 * The parabola a flight between two known contacts MUST follow: gravity is
 * fixed at `g` and the curve is pinned to the first and last sample, so the
 * launch state is determined outright rather than fitted.
 *
 *   y(0) = yA, y(T) = yB, y(t) = yA + v0·t − ½·g·t²  ⟹  v0 = (yB − yA + ½gT²)/T
 *
 * This is the right model for an ARC — as opposed to `fitBallistic`, which
 * answers the different question "what parabola best explains these samples".
 * Least squares spreads its error evenly, which sounds fairer and behaves
 * worse in every way that matters here:
 *
 *  - Its correction is LARGEST at the arc's ends, exactly where the pass has
 *    to hand back to the clip, so the frames beside a grounded pin take the
 *    biggest step. Anchoring makes the correction identically zero there, and
 *    the hand-off seamless.
 *  - The take-off and landing frames are the trustworthy ones: the feet were
 *    on the ground a frame ago, so the clip's height there is constrained by
 *    something real. The floating is in the middle. Averaging the reliable
 *    ends together with the unreliable middle throws that information away.
 *  - It makes the pass a FIXED POINT. The endpoints are never moved, so a
 *    second run derives the identical curve and finds nothing left to do.
 *
 * The trade is deliberate: an arc whose take-off or landing height is itself
 * wrong keeps that error, because this model treats contact frames as ground
 * truth. The sanity gate in the driver is what catches the case where they
 * are wrong enough to matter.
 *
 * `residual` is the RMS distance of the samples from that curve — how
 * un-ballistic the arc was to begin with.
 */
export function fitBallisticArc(samples, fps, g = GRAVITY) {
	const list = samples ?? [];
	const rate = Number.isFinite(fps) && fps > 0 ? fps : 30;
	const times = list.map((_, index) => index / rate);
	if (list.length === 0) return { positions: [], y0: 0, v0: 0, g, residual: 0 };
	const y0 = list[0].y;
	const duration = times[times.length - 1];
	const v0 = duration > 0
		? (list[list.length - 1].y - y0 + 0.5 * g * duration * duration) / duration
		: 0;
	const positions = list.map((sample, index) => {
		const t = times[index];
		return new THREE.Vector3(sample.x ?? 0, y0 + v0 * t - 0.5 * g * t * t, sample.z ?? 0);
	});
	let sumSq = 0;
	for (let index = 0; index < list.length; index += 1) {
		const error = list[index].y - positions[index].y;
		sumSq += error * error;
	}
	return { positions, y0, v0, g, residual: Math.sqrt(sumSq / list.length) };
}

/* --- the driver ------------------------------------------------------------- */

/** Deviation from the fitted parabola a span must reach before it is worth
 * correcting. 5 mm is well under the eye's threshold on a character-sized
 * silhouette and comfortably above the noise in a generated root track. */
export const AUTO_PHYSICS_EPSILON = 0.005;

/** Largest root correction the pass will ever apply. Half a metre is already
 * a hip-height move; anything beyond it means the span is not a flight phase
 * and the "fix" would be a catastrophe, so such a span is skipped and
 * reported instead. */
export const MAX_CORRECTION = 0.5;

/** Worst RMS a fit may have and still be believed. A real flight phase fits a
 * parabola to a couple of centimetres; a mis-detected span (a whole walk
 * misread as one jump) fits to a metre or more. */
export const MAX_FIT_RESIDUAL = 0.25;

/** Clearance kept between the lowest foot marker and the floor when a
 * downward correction is applied. */
export const FLOOR_CLEARANCE = 0.005;

/**
 * Run AutoPhysics over a frame range: find the airborne spans and force each
 * one's centre-of-mass HEIGHT onto its best-fit ballistic curve.
 *
 * `applyFrame(frame)` must pose the rig (motion apply + ikEvaluate) exactly
 * as the fix-collisions range driver expects — App owns that plumbing, this
 * owns the loop. The pass runs in two sweeps, and the split is what makes it
 * repeatable:
 *
 *  1. Sample sweep. Every frame is posed once and its CoM, foot-marker
 *     heights and CLEAN hips transform are recorded. Nothing is written, so
 *     this is the clip as authored plus whatever IK keys the user already
 *     made — never a trajectory this pass is halfway through editing.
 *  2. Correction sweep. Each span is fitted from those samples. Before every
 *     write the hips are RESET to the sweep-1 transform, so the correction
 *     applied at a frame never depends on the keys written at earlier frames.
 *     Without that reset a second button press re-measured its own blended
 *     output and ratcheted the correction upward run after run.
 *
 * Between the two sweeps the raw detection is turned into ARCS, because a
 * span and a ballistic arc are not the same thing:
 *
 *  - HYSTERESIS. Spans are found at `lift` and then grown outward at the much
 *    lower `exitLift` (see expandAirborneSpans), recovering the take-off and
 *    landing frames a stride-proof entry threshold necessarily clips off.
 *  - SPLITTING. A span that never plants a foot can still hold two hops; it is
 *    cut at its interior centre-of-mass troughs (see splitAtTroughs) so each
 *    arc gets its own parabola. One fit spanning two hops needs corrections
 *    big enough to trip the sanity gate, which used to throw away the clip's
 *    only real jump.
 *  - TAPERING. Each arc's correction eases in and out over `edgeTaper` frames
 *    (see edgeTaperWeight), so it meets the clip's own trajectory instead of
 *    stepping onto it beside a zero pin.
 *
 * An arc is corrected only when its FULL-WEIGHT core misses the parabola
 * vertically by more than `epsilon`; an arc whose worst correction exceeds
 * `correctionLimit`, or whose fit residual exceeds `maxFitResidual`, is
 * refused outright and reported in `skippedSpans`. Every applied ΔY is
 * clamped so no foot marker is pushed below `floorY + floorClearance`.
 *
 * `spans` reports the ARCS that were considered, after expansion and
 * splitting — the units this pass actually reasons about.
 *
 * Every frame of a corrected span is keyed. So is every frame BETWEEN the
 * first and last of them that is not itself corrected — the boundary frames
 * either side of a span, and any grounded gap between two spans. Those pins
 * carry the clip's own pose and exist because ikEvaluate evaluates the whole
 * keyed range at full weight: without them the layer interpolates the hips
 * straight across the gaps and drags grounded frames along with it. A pin
 * changes nothing visually; it states that nothing changes.
 *
 * Returns { supported, reason, spans, keyedFrames, maxCorrection, corrected,
 * pinnedFrames, skippedSpans, planted }.
 *
 * `supported` separates "ran and found nothing to do" from "could not run".
 * Every refusal below — a rig with no hips joint, a range too short to hold a
 * span, a skeleton whose centre of mass or foot markers cannot be measured —
 * used to return the same empty result as a perfectly good clip that simply
 * never leaves the ground, and the UI read all of them as "no airborne frames
 * in the clip". That sentence is a lie for four of the five, and the one it
 * fits is the only one the user can do nothing about. `reason` names which.
 */
export function autoPhysicsRange({
	rig,
	motion = null,
	chains,
	fkJoints = null,
	ikState,
	applyFrame,
	floorY = 0,
	fps = 30,
	gravity = GRAVITY,
	lift = AIRBORNE_LIFT,
	exitLift = EXIT_LIFT,
	splitDepth = SPLIT_DEPTH,
	edgeTaper = EDGE_TAPER,
	margin = null,
	minSpanFrames = MIN_AIRBORNE_FRAMES,
	epsilon = AUTO_PHYSICS_EPSILON,
	correctionLimit = MAX_CORRECTION,
	maxFitResidual = MAX_FIT_RESIDUAL,
	floorClearance = FLOOR_CLEARANCE,
	contactHeights = null,
	supportFrames = null,
	grounding = false,
	startFrame = 0,
	endFrame = null,
} = {}) {
	const refuse = (reason) => ({
		supported: false, reason,
		spans: [], keyedFrames: [], maxCorrection: 0, corrected: 0, pinnedFrames: [], skippedSpans: [], planted: null,
		groundContactSpans: [], rejectedGroundSpans: [], groundedKeyedFrames: [], maxFootCorrection: 0,
		maxFootSlideBefore: 0, maxFootSlideAfter: 0, meanFootSlideBefore: 0, meanFootSlideAfter: 0,
		floorPenetrationBefore: 0, floorPenetrationAfter: 0, skippedFloorFrames: [],
	});
	if (!rig || !chains || !ikState || typeof applyFrame !== "function") return refuse("no-driver");
	// The whole correction is a root translation, so without the hips FK joint
	// (the body-root control that owns the hips' local position) there is
	// nothing this pass can write.
	const hips = fkJoints?.get?.("hips");
	if (!hips) return refuse("no-hips-joint");
	// `margin` is the old option name from the absolute-threshold version; it
	// meant the same thing (clearance a foot must have) against a different
	// reference, so honouring it as an alias keeps old callers working.
	const liftThreshold = Number.isFinite(margin) ? margin : lift;
	void contactHeights; // accepted for API compatibility; the clip-relative
	// planted floor below is strictly better and must dominate, so measured
	// mesh drops no longer take part in detection at all.
	const start = Math.max(0, Math.round(startFrame) || 0);
	const lastFrame = Number.isFinite(endFrame) ? Math.round(endFrame) : (motion?.frames ?? 0) - 1;
	const end = Math.max(start, Math.round(lastFrame));
	const count = end - start + 1;
	if (count < minSpanFrames) return refuse("range-too-short");

	/* --- sweep 1: measure the clip, touching nothing ----------------------- */
	const samples = [];
	const heights = [];
	const footPositions = [];
	const clipFootPositions = [];
	const basePose = [];
	const footIds = FOOT_SIDES.map((foot) => foot.chainId).filter((id) => chains.has(id));
	const readFootQuats = () => new Map(footIds.map((id) => [id, chains.get(id).bones.map((bone) => bone.quaternion.clone())]));
	const layerFootQuats = [];
	const clipFootQuats = [];
	const layerActive = ikState.tracked.size > 0;
	for (let frame = start; frame <= end; frame += 1) {
		if (layerActive) {
			const tracked = ikState.tracked;
			ikState.tracked = new Set();
			try {
				applyFrame(frame);
				clipFootQuats.push(readFootQuats());
				clipFootPositions.push(markerPositions(rig));
			} finally {
				ikState.tracked = tracked;
			}
		}
		applyFrame(frame);
		const com = computeCenterOfMass(rig);
		const marks = markerHeights(rig);
		const points = markerPositions(rig);
		if (!com || !marks || !points) return refuse("rig-not-measurable"); // cannot be judged — decline
		samples.push(com);
		heights.push(marks);
		footPositions.push(points);
		basePose.push({ position: hips.bone.position.clone(), quaternion: hips.bone.quaternion.clone() });
		layerFootQuats.push(readFootQuats());
		if (!layerActive) {
			clipFootQuats.push(readFootQuats());
			clipFootPositions.push(points);
		}
	}
	const planted = plantedFloor(heights);
	const ground = grounding
		? detectGroundContactSpans({
			positions: clipFootPositions,
			planted: plantedFloor(clipFootPositions.map((frame) => Object.fromEntries(FOOT_MARKERS.map((name) => [name, frame[name].y])))),
			fps,
			startFrame: start,
		})
		: { spans: [], rejected: [] };
	const flags = heights.map((marks, i) => !supportFrames?.has(start + i) && heightsAirborne(marks, planted, liftThreshold));
	const lowest = heights.map((marks) => Math.min(...FOOT_MARKERS.map((name) => marks[name])));
	// Detect strictly, then grow: the entry lift has to be high enough to
	// ignore a stride, which necessarily clips the take-off and landing frames
	// off a real jump. The exit lift puts them back.
	const detected = detectAirborneSpans({ frames: count, isAirborne: flags, startFrame: start, minLength: minSpanFrames });
	const exitFlags = heights.map((marks, i) => !supportFrames?.has(start + i) && heightsAirborne(marks, planted, Math.min(exitLift, liftThreshold)));
	const expanded = expandAirborneSpans({ spans: detected, canExtend: exitFlags, startFrame: start });

	/* --- split each span into single arcs ---------------------------------- */
	const skippedSpans = [];
	const spans = [];
	for (const span of expanded) {
		const first = span.start - start;
		const track = samples.slice(first, first + span.length).map((sample) => sample.y);
		for (const [from, to] of splitAtTroughs(track, { splitDepth })) {
			const arc = { start: span.start + from, end: span.start + to, length: to - from + 1 };
			// A sub-arc too short to fit is not evidence of anything; report it
			// rather than fitting two points and calling the result physics.
			if (arc.length < minSpanFrames) {
				skippedSpans.push({ ...arc, reason: "too-short", maxDelta: 0, residual: 0 });
				continue;
			}
			spans.push(arc);
		}
	}

	/** Restore the hips to the pose sweep 1 saw, so every write starts from
	 * the clip rather than from this pass's own partial output. */
	const restoreBase = (frame) => {
		const base = basePose[frame - start];
		hips.bone.position.copy(base.position);
		hips.bone.quaternion.copy(base.quaternion);
		hips.bone.updateMatrixWorld(true);
	};

	/* --- sweep 2: correct the arcs that deserve it ------------------------- */
	const keyedFrames = [];
	const pinnedFrames = [];
	const corrections = new Map();
	let maxCorrection = 0;
	for (const span of spans) {
		const first = span.start - start;
		const spanSamples = samples.slice(first, first + span.length);
		const weights = spanSamples.map((_, index) => edgeTaperWeight(index, span.length, edgeTaper));
		// Anchored to the take-off and landing samples, so the correction is
		// zero at both ends by construction and the arc hands back to the clip
		// without a step. See fitBallisticArc for why not least squares.
		const fit = fitBallisticArc(spanSamples, fps, gravity);
		const raw = fit.positions.map((fitted, index) => fitted.y - spanSamples[index].y);
		// Only the FULL-WEIGHT core votes on whether the arc needs work. The
		// tapered frames deliberately keep a share of the clip, so they are
		// permanently a little off the curve and would otherwise ask for the
		// same correction on every run for ever.
		let coreFrom = weights.findIndex((weight) => weight >= 1);
		let coreTo = weights.length - 1 - [...weights].reverse().findIndex((weight) => weight >= 1);
		if (coreFrom < 0 || coreTo < coreFrom) {
			coreFrom = 0;
			coreTo = span.length - 1;
		}
		let worstCore = 0;
		for (let index = coreFrom; index <= coreTo; index += 1) worstCore = Math.max(worstCore, Math.abs(raw[index]));
		if (worstCore <= epsilon) continue; // already ballistic — leave it keyless

		// Floor guard: never push a foot marker through the ground. Only a
		// downward correction can, so this is a one-sided clamp, applied AFTER
		// the taper so the clamp governs what actually lands on the bone.
		const applied = raw.map((value, index) =>
			Math.max(value * weights[index], floorY + floorClearance - lowest[first + index]));
		const worstApplied = applied.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
		const worstRaw = raw.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
		// Deltas, not the clamped result, decide whether the arc is believable:
		// a floor clamp could shrink an absurd correction into the accepted
		// range and hide exactly the failure this gate exists to catch.
		if (worstRaw > correctionLimit || worstApplied > correctionLimit || fit.residual > maxFitResidual) {
			skippedSpans.push({
				start: span.start,
				end: span.end,
				length: span.length,
				reason: fit.residual > maxFitResidual ? "fit-too-poor" : "correction-too-large",
				maxDelta: Math.max(worstRaw, worstApplied),
				residual: fit.residual,
			});
			continue;
		}
		for (let index = 0; index < span.length; index += 1) {
			corrections.set(span.start + index, applied[index]);
			maxCorrection = Math.max(maxCorrection, Math.abs(applied[index]));
		}
	}

	/* --- write: corrections, then zero-delta pins across the keyed range --- */
	const lift3 = new THREE.Vector3();
	/** The pass writes exactly one thing: the hips' local position (and, as a
	 * pin, the clip's own hips rotation). Naming that in the bake keeps it from
	 * re-keying every limb the user has ever dragged — and the clip's own hips
	 * position rides along as `basePos`, so ikEvaluate applies the correction as
	 * a DELTA over the clip instead of splicing this frame's absolute height
	 * onto its neighbours. A pin's delta is then exactly zero by construction,
	 * not merely zero at the pinned frame. */
	const writeFrame = (frame, delta) => {
		applyFrame(frame);
		restoreBase(frame);
		const clipPosition = hips.bone.position.clone();
		if (delta) {
			lift3.set(0, delta, 0);
			solveHipsTranslate(hips, lift3, clipPosition.clone());
		}
		ikTouch(ikState, "hips");
		ikBakeKeyframe(chains, ikState, frame, fkJoints, ["hips"], new Map([["hips", clipPosition]]));
	};
	if (corrections.size > 0) {
		for (const [frame, delta] of [...corrections.entries()].sort((a, b) => a[0] - b[0])) {
			writeFrame(frame, delta);
			keyedFrames.push(frame);
		}
		const pinFrom = Math.max(start, Math.min(...corrections.keys()) - 1);
		const pinTo = Math.min(end, Math.max(...corrections.keys()) + 1);
		for (let frame = pinFrom; frame <= pinTo; frame += 1) {
			if (corrections.has(frame)) continue;
			writeFrame(frame, 0);
			pinnedFrames.push(frame);
		}
	}

	/* --- grounded feet: lock safe stance runs, lift only real penetration --- */
	const groundedKeyedFrames = [];
	let maxFootCorrection = 0;
	let floorPenetrationBefore = 0;
	let floorPenetrationAfter = 0;
	let maxFootSlideBefore = ground.spans.reduce((max, span) => Math.max(max, span.maxPull), 0);
	let maxFootSlideAfter = 0;
	let slideSumBefore = 0;
	let slideSumAfter = 0;
	let slideSampleCount = 0;
	for (const span of ground.spans) {
		const foot = FOOT_SIDES.find((item) => item.chainId === span.chainId);
		if (!foot) continue;
		for (let frame = span.start; frame <= span.end; frame += 1) {
			const point = footPositions[frame - start]?.[foot.ankle];
			if (!point) continue;
			slideSumBefore += Math.hypot(point.x - span.anchor.x, point.z - span.anchor.z);
			slideSampleCount += 1;
		}
	}
	const contactHeight = (foot) => chains.get(foot.chainId)?.contactHeights?.[foot.height] ?? 0;
	const penetrationAt = (points) => {
		let worst = 0;
		for (const foot of FOOT_SIDES) {
			const ankle = points?.[foot.ankle];
			if (!ankle) continue;
			// Use the bind-pose MEASURED mesh drop below the ankle. ToeBase is a
			// useful contact marker but not a sole: on X-Bot its bone sits about
			// 12 cm below Y-Bot's relative to the visible foot, which made the old
			// absolute toe test lift an otherwise grounded body by a false 12 cm.
			worst = Math.max(worst, floorY + contactHeight(foot) - ankle.y);
		}
		return Math.max(0, worst);
	};
	const contactFrames = new Set();
	for (const span of ground.spans) for (let frame = span.start; frame <= span.end; frame += 1) contactFrames.add(frame);
	const floorLifts = new Map();
	const skippedFloorFrames = new Set();
	for (const frame of contactFrames) {
		const penetration = penetrationAt(footPositions[frame - start]);
		floorPenetrationBefore = Math.max(floorPenetrationBefore, penetration);
		if (penetration > GROUND_FLOOR_MAX_LIFT) skippedFloorFrames.add(frame);
		else if (penetration > GROUND_FLOOR_EPSILON) floorLifts.set(frame, penetration);
	}
	// A floor offset is a body placement error, not a bent-leg error. Lift the
	// hips/root rigidly so the entire character clears the floor without
	// changing either knee. The foot solve below then handles XZ only.
	for (const [frame, lift] of floorLifts) {
		writeFrame(frame, lift);
		groundedKeyedFrames.push(frame);
		maxCorrection = Math.max(maxCorrection, lift);
	}

	const groundWrites = new Map();
	for (const span of ground.spans) {
		const foot = FOOT_SIDES.find((item) => item.chainId === span.chainId);
		if (!foot) continue;
		for (let frame = span.start; frame <= span.end; frame += 1) {
			const index = frame - start;
			const ankle = footPositions[index]?.[foot.ankle];
			if (!ankle) continue;
			const target = ankle.clone();
			target.x = span.anchor.x;
			target.z = span.anchor.z;
			// The parent root has already been lifted on a penetrated frame. Move
			// the ankle by the same amount so the leg keeps its vertical pose.
			target.y += floorLifts.get(frame) ?? 0;
			const delta = Math.hypot(target.x - ankle.x, target.z - ankle.z);
			if (delta <= GROUND_LOCK_EPSILON) continue;
			if (!groundWrites.has(frame)) groundWrites.set(frame, []);
			groundWrites.get(frame).push({ foot, target, delta });
		}
	}
	for (const [frame, writes] of [...groundWrites.entries()].sort((a, b) => a[0] - b[0])) {
		applyFrame(frame);
		const index = frame - start;
		// Restore the sweep-1 layer pose before solving either leg. This keeps
		// a key written on frame N from becoming frame N+1's starting pose.
		for (const id of footIds) {
			const chain = chains.get(id);
			const quats = layerFootQuats[index]?.get(id);
			if (!chain || !quats) continue;
			chain.bones.forEach((bone, boneIndex) => bone.quaternion.copy(quats[boneIndex]));
		}
		rig.updateMatrixWorld(true);
		const successful = [];
		for (const write of writes) {
			const { foot, target } = write;
			const chain = chains.get(foot.chainId);
			solveIk(chain, target);
			rig.updateMatrixWorld(true);
			let achieved = findBone(rig, foot.ankle)?.getWorldPosition(new THREE.Vector3());
			let residual = achieved ? Math.hypot(achieved.x - target.x, achieved.z - target.z) : Infinity;
			// A fully straight leg has no sideways reach even for a two-centimetre
			// plant. On failure only, permit five millimetres of sole clearance to
			// create knee bend, then retry from the untouched clip pose once.
			if (residual > GROUND_LOCK_EPSILON) {
				const quats = layerFootQuats[index]?.get(foot.chainId);
				if (quats) chain.bones.forEach((bone, boneIndex) => bone.quaternion.copy(quats[boneIndex]));
				rig.updateMatrixWorld(true);
				target.y += GROUND_LOCK_REACH_LIFT;
				solveIk(chain, target);
				rig.updateMatrixWorld(true);
				achieved = findBone(rig, foot.ankle)?.getWorldPosition(new THREE.Vector3());
				residual = achieved ? Math.hypot(achieved.x - target.x, achieved.z - target.z) : Infinity;
			}
			// A straight or fully stretched leg may not reach a sideways plant.
			// Do not bake a half-fix that a second run would ratchet further.
			if (residual <= GROUND_LOCK_EPSILON) {
				successful.push(write);
				maxFootCorrection = Math.max(maxFootCorrection, write.delta);
			} else {
				const quats = layerFootQuats[index]?.get(foot.chainId);
				if (quats) chain.bones.forEach((bone, boneIndex) => bone.quaternion.copy(quats[boneIndex]));
				rig.updateMatrixWorld(true);
			}
		}
		for (const { foot } of successful) {
			ikBakeKeyframe(chains, ikState, frame, fkJoints, [foot.chainId], null, clipFootQuats[index]);
		}
		if (successful.length) groundedKeyedFrames.push(frame);
	}

	// A root lift can turn a previously straight, unreachable leg into a
	// solvable one. Re-sample the FINISHED layer and take at most three bounded
	// refinement sweeps now, so pressing the button again cannot discover a
	// second batch and ratchet the take. Each sweep is still snapshotted before
	// it writes, so neighbouring keys never become one another's input.
	for (let refinement = 0; grounding && refinement < 3; refinement += 1) {
		const currentPositions = [];
		const currentQuats = [];
		for (let frame = start; frame <= end; frame += 1) {
			applyFrame(frame);
			currentPositions.push(markerPositions(rig));
			currentQuats.push(readFootQuats());
		}
		let wrote = 0;
		for (let frame = start; frame <= end; frame += 1) {
			const active = ground.spans.filter((span) => frame >= span.start && frame <= span.end);
			if (!active.length) continue;
			const index = frame - start;
			const candidates = [];
			for (const span of active) {
				const foot = FOOT_SIDES.find((item) => item.chainId === span.chainId);
				const ankle = foot && currentPositions[index]?.[foot.ankle];
				if (!foot || !ankle) continue;
				const delta = Math.hypot(span.anchor.x - ankle.x, span.anchor.z - ankle.z);
				if (delta > GROUND_LOCK_EPSILON) candidates.push({ foot, delta, target: ankle.clone().setX(span.anchor.x).setZ(span.anchor.z) });
			}
			if (!candidates.length) continue;
			applyFrame(frame);
			for (const { foot } of candidates) {
				const chain = chains.get(foot.chainId);
				const quats = currentQuats[index]?.get(foot.chainId);
				if (chain && quats) chain.bones.forEach((bone, boneIndex) => bone.quaternion.copy(quats[boneIndex]));
			}
			rig.updateMatrixWorld(true);
			for (const candidate of candidates) {
				const { foot, target } = candidate;
				const chain = chains.get(foot.chainId);
				solveIk(chain, target);
				rig.updateMatrixWorld(true);
				const achieved = findBone(rig, foot.ankle)?.getWorldPosition(new THREE.Vector3());
				const residual = achieved ? Math.hypot(achieved.x - target.x, achieved.z - target.z) : Infinity;
				if (residual <= GROUND_LOCK_EPSILON) {
					ikBakeKeyframe(chains, ikState, frame, fkJoints, [foot.chainId], null, clipFootQuats[index]);
					groundedKeyedFrames.push(frame);
					maxFootCorrection = Math.max(maxFootCorrection, candidate.delta);
					wrote += 1;
				} else {
					const quats = currentQuats[index]?.get(foot.chainId);
					if (quats) chain.bones.forEach((bone, boneIndex) => bone.quaternion.copy(quats[boneIndex]));
					rig.updateMatrixWorld(true);
				}
			}
		}
		if (!wrote) break;
	}

	// Foot IK can lower an ankle slightly after the first root lift. Re-check
	// the evaluated layer and add only the remaining clearance to that frame's
	// existing root correction. Two bounded passes settle interpolation without
	// ever accumulating beyond the measured need or the 15 cm safety cap.
	if (grounding) {
		for (let pass = 0; pass < 2; pass += 1) {
			let wrote = 0;
			for (const frame of contactFrames) {
				applyFrame(frame);
				const residual = penetrationAt(markerPositions(rig));
				if (residual <= GROUND_FLOOR_EPSILON) continue;
				const total = (floorLifts.get(frame) ?? 0) + residual;
				if (total > GROUND_FLOOR_MAX_LIFT) {
					skippedFloorFrames.add(frame);
					continue;
				}
				floorLifts.set(frame, total);
				writeFrame(frame, total);
				groundedKeyedFrames.push(frame);
				maxCorrection = Math.max(maxCorrection, total);
				wrote += 1;
			}
			if (!wrote) break;
		}
		// Read back the final evaluated result, not the solver's momentary pose:
		// this is the same truth the viewer sees after all keys and blend ramps.
		const afterPositions = [];
		for (let frame = start; frame <= end; frame += 1) {
			applyFrame(frame);
			const points = markerPositions(rig);
			if (!points) continue;
			afterPositions.push(points);
				if (contactFrames.has(frame)) floorPenetrationAfter = Math.max(floorPenetrationAfter, penetrationAt(points));
		}
		for (const span of ground.spans) {
			const foot = FOOT_SIDES.find((item) => item.chainId === span.chainId);
			if (!foot) continue;
			for (let frame = span.start; frame <= span.end; frame += 1) {
				const point = afterPositions[frame - start]?.[foot.ankle];
				if (point) {
					const distance = Math.hypot(point.x - span.anchor.x, point.z - span.anchor.z);
					maxFootSlideAfter = Math.max(maxFootSlideAfter, distance);
					slideSumAfter += distance;
				}
			}
		}
	}
	const allKeyed = [...new Set([...keyedFrames, ...groundedKeyedFrames])].sort((a, b) => a - b);
	return {
		supported: true, reason: "",
		spans, keyedFrames: allKeyed, airborneKeyedFrames: keyedFrames, maxCorrection,
		corrected: allKeyed.length, pinnedFrames, skippedSpans, planted,
		groundContactSpans: ground.spans,
		rejectedGroundSpans: ground.rejected,
		groundedKeyedFrames: [...new Set(groundedKeyedFrames)].sort((a, b) => a - b),
		maxFootCorrection,
		maxFootSlideBefore,
		maxFootSlideAfter,
		meanFootSlideBefore: slideSampleCount ? slideSumBefore / slideSampleCount : 0,
		meanFootSlideAfter: slideSampleCount ? slideSumAfter / slideSampleCount : 0,
		floorPenetrationBefore,
		floorPenetrationAfter,
		skippedFloorFrames: [...skippedFloorFrames].sort((a, b) => a - b),
	};
}
