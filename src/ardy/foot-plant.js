import * as THREE from "three";
import {
	findBone,
	solveIk,
	solveHipsTranslate,
	ikBakeKeyframe,
} from "./ik.js";

/**
 * FOOT-SKATE / FOOT-PLANT CLEANUP — Cascadeur's "Fulcrum Motion Cleaning /
 * Fix Foot", built on Kovar–Schreiner–Gleicher's footskate cleanup.
 *
 * THE FAILURE. A generated clip puts a foot on the ground and then lets it
 * drift: the contact is there in the silhouette (the sole is at floor height,
 * the weight is on it) but the foot travels several centimetres a second in
 * XZ while it is supposed to be bearing the body. Measured on a real walk
 * window: ground truth plants each foot ~68% of frames and moves it 0.03 m/s
 * while planted; the model's output plants 10–19% and slides 0.11–0.18 m/s.
 * The eye reads that as the character skating on ice.
 *
 * THE FIX, in one sentence: find each interval where a foot is in contact,
 * pick ONE world position for that contact, and re-solve the leg every frame
 * of the interval so the ankle sits on it.
 *
 * The three things that make it safe rather than destructive:
 *
 *  - THE PLANT IS A MEDIAN. The obvious choice — the position at the first
 *    frame of the contact — hands the whole interval to whichever frame the
 *    detector happened to open on, and one noisy frame then drags the plant
 *    with it. The median over the interval is the position that minimises the
 *    total distance the pass has to move the foot, and a single outlier frame
 *    cannot move it at all.
 *  - A STEP IS NOT A SKATE. A foot that travels further than MAX_PLANT_SHIFT
 *    from that median inside one "contact" is not skating, it is stepping and
 *    the detector was wrong. Pinning it would yank the foot a quarter of a
 *    metre. Such an interval is REFUSED and reported, never half-corrected.
 *  - THE ROOT ABSORBS WHAT THE LEG CANNOT. Holding a foot still while the body
 *    keeps moving eventually asks the leg for more than its two bones have. A
 *    solver told to reach anyway straightens the leg into a stilt — the
 *    classic IK pop. Instead the hips come DOWN (and toward the plant) by the
 *    deficit, capped at MAX_ROOT_DROP, and the legs are re-solved from there.
 *    That is what a person does, and it is why this pass writes a hips key at
 *    all.
 *
 * The pass is a FIXED POINT: pressing the button twice does nothing the second
 * time. That is structural, not a coincidence of thresholds. A corrected
 * contact is keyed on every one of its frames, on the frames its ease runs
 * over, and one frame past each of those; every one of those frames is then an
 * ANCHOR that this pass refuses to touch, so a second run finds nothing left
 * inside the interval it is allowed to move and drops it whole (see the
 * planned-shift gate). What the thresholds decide is whether a contact is
 * worth touching at ALL, not whether it gets touched twice.
 *
 * ONE THING THIS PASS LEARNED THE HARD WAY, worth knowing before editing it: a
 * key whose rotation delta is the identity is NOT a no-op. ikEvaluate gives
 * every frame inside a key island bind bone translations, and a generated
 * clip's own translations sit about 19 mm off bind, so a frame keyed
 * "unchanged" still moves by that much. Every frame this pass keys for a foot
 * chain is therefore SOLVED, to the plant, to a faded target, or to the
 * position the clip already had.
 *
 * `applyFrame(frame)` must pose the rig (motion apply + ikEvaluate) exactly as
 * fixCollisionsRange and autoPhysicsRange expect — App owns that plumbing,
 * this owns the loop.
 */

/* --- what a foot is --------------------------------------------------------- */

/**
 * The two legs, each as the IK chain that drives it plus the two markers that
 * decide whether it is on the ground. Both markers matter and they say
 * different things: the ANKLE is what the solver can actually position (it is
 * the chain's effector), while the TOE BASE is what stays down when the heel
 * lifts at the end of a stance. A rule that watched only the ankle would call
 * a toe-down frame airborne.
 */
export const FOOT_PLANT_CHAINS = Object.freeze([
	Object.freeze({ id: "leftFoot", side: "Left", ankle: "mixamorigLeftFoot", toe: "mixamorigLeftToeBase" }),
	Object.freeze({ id: "rightFoot", side: "Right", ankle: "mixamorigRightFoot", toe: "mixamorigRightToeBase" }),
]);

/** Every marker name, in the order the floor calibration walks them. */
export const FOOT_PLANT_MARKERS = Object.freeze(
	FOOT_PLANT_CHAINS.flatMap((foot) => [foot.ankle, foot.toe]),
);

/* --- contact thresholds ----------------------------------------------------- */

/**
 * How close to its own floor a foot must come before a contact OPENS, and how
 * far it must rise before that contact CLOSES.
 *
 * Both are relative to the clip's own planted height for that marker (see
 * plantedFloorHeights), never to y = 0: characters rest with their soles a
 * couple of centimetres above the export's floor, ankles sit 12 cm up, and an
 * absolute threshold declares a standing character airborne. This is the same
 * clip-relative calibration auto-physics settled on for the same reason.
 *
 * The pair is a hysteresis band, not one number, because a single threshold
 * cannot both reject a heel skimming the floor mid-swing and hold a contact
 * through the small lift of a weight shift. 2 cm to open is tight enough that
 * only a foot genuinely down qualifies; 6 cm to close is above a heel lift and
 * far below any real step.
 */
export const CONTACT_ON_HEIGHT = 0.02;
export const CONTACT_OFF_HEIGHT = 0.06;

/**
 * The speed half of the same hysteresis, in metres per second of ANKLE travel
 * in XZ.
 *
 * The ON threshold has to be loose enough to fire on the clip this pass
 * exists to fix: a model's planted foot slides at 0.11–0.18 m/s, so a gate set
 * near ground truth's 0.03 m/s would refuse to see the very contacts that need
 * cleaning. 0.15 m/s opens on most of them; the much wider 0.40 m/s exit then
 * carries the contact across the frames inside it that slide fastest, which is
 * exactly the hysteresis pair's job. A real swing foot moves at 1–2 m/s and is
 * never mistaken for either.
 *
 * The speed is measured on the ANKLE and not on the lowest marker because the
 * plant this pass authors is an ankle plant: the contact state has to be a
 * statement about the thing being pinned. A heel-off frame, where the foot
 * pivots over a still toe and the ankle swings forward and up, therefore
 * leaves the interval — which is correct, because pinning the ankle through a
 * toe pivot is the pop this pass is supposed to avoid.
 */
export const CONTACT_ON_SPEED = 0.15;
export const CONTACT_OFF_SPEED = 0.4;

/** Shortest contact worth planting. A single frame under the thresholds is
 * detector noise — a foot skimming the floor at the bottom of a swing — and
 * pinning it writes a one-frame island that reads as a twitch. */
export const MIN_CONTACT_FRAMES = 2;

/* --- the guards ------------------------------------------------------------- */

/**
 * How far a foot may travel from its interval's plant before the interval is
 * refused as a STEP rather than a skate.
 *
 * A slow, low, long travel passes both contact thresholds and looks exactly
 * like a skate to the detector — and it is the one case where "fix" means
 * teleporting a foot a quarter of a metre. A stride is 60–80 cm, so a
 * deviation past 25 cm from the median cannot be a foot that meant to stay
 * put. The interval is reported with `refused: "step-not-skate"` and nothing
 * is written for it: a half-corrected step is worse than the skate.
 */
export const MAX_PLANT_SHIFT = 0.25;

/**
 * How much slide an interval must actually have before the pass touches it.
 *
 * This is the gate that makes a second press a no-op instead of a slow drift:
 * after one run the core of every corrected interval sits on its plant to
 * within microns, so the interval measures no slide and is skipped whole. It
 * doubles as the honesty gate on a clip that never skated — a foot already
 * planted to within a centimetre is planted, and rewriting it as keys would
 * replace authored motion with the pass's own idea of the same pose.
 */
export const MIN_INTERVAL_SLIDE = 0.01;

/**
 * The LONGEST ease the pass will run outside a contact, in frames.
 *
 * Without an ease the foot arrives on its plant in one frame at the contact
 * edge — the correction steps on, and the IK layer's own island boundary steps
 * with it. Six frames is the IK layer's own blend window, which is the natural
 * ceiling: a correction that reached further would be arguing with the ramp
 * the layer is already running.
 *
 * This is a MAXIMUM, not a fixed length: the ease is grown one frame at a time
 * until the correction fits under PLANT_STEP_BUDGET (see padPlan), because a
 * 5 mm plant offset needs one frame and a 4 cm one needs five. A fixed length
 * either wastes swing frames on a small fix or shoves a big one through in
 * three.
 *
 * No ease is run where an interval reaches the end of the range: there is no
 * frame outside to hand back to, and easing there would leave the clip's first
 * (or last) frames sliding for nobody.
 */
export const PLANT_TAPER = 6;

/**
 * The most the ease may ADD to any one frame's foot travel, in metres.
 *
 * The bar cannot be "never move faster than the clip's own fastest frame":
 * the frames the ease runs over are the START of a swing, which is the slow
 * part, and a 4 cm plant offset cannot be spread over slow frames without one
 * of them gaining more than a clip whose peak is 2.5 cm/frame ever does. What
 * can be bounded — and is what a viewer actually reads as a pop — is how much
 * the pass ADDS to a frame that was already moving. At 24–30 fps, 1 cm in one
 * frame is about 0.25–0.3 m/s of extra foot travel: a third of what the start
 * of a swing already does, and far under the step the eye catches. A 2 cm
 * budget was tried first and is too loose — it let a 4 cm plant offset come
 * off over two frames, which nearly doubled the motion on a 26 mm frame.
 *
 * The ease is distributed by ARC LENGTH rather than by frame count, so the
 * correction comes off fastest where the foot is already fastest and the
 * budget is spent where it is least visible. Measured on the synthetic swing:
 * a uniform three-frame smoothstep added 16 mm to a 26 mm frame; the
 * arc-length ramp grown to fit this budget adds under 10.
 */
export const PLANT_STEP_BUDGET = 0.01;

/**
 * How close to fully extended a leg may be asked to get before the ROOT takes
 * the difference. Past this fraction of (l0 + l1) the two-bone solver is
 * straightening the knee to reach, which is the stilt-leg pop; the hips come
 * down instead.
 */
export const OVER_EXTEND_FRACTION = 0.98;

/**
 * The most this pass will ever move the root to let a foot keep its plant.
 * 8 cm is a deep knee bend's worth of pelvis travel and comfortably inside
 * what a walk already does; a plant that needs more than that is asking the
 * character to sit down, and the honest answer is to let the foot come off the
 * plant (and say so in `maxRootDrop`) rather than fold the body.
 */
export const MAX_ROOT_DROP = 0.08;

/** How far below its own floor a marker may sit before the floor guard
 * re-solves the frame with a lifted target. Two millimetres is under the
 * solver's own convergence noise. */
export const PLANT_FLOOR_TOLERANCE = 0.002;

/* --- measurement ------------------------------------------------------------ */

/**
 * Every foot marker's world position in the rig's CURRENT pose, keyed by bone
 * name. Null when a marker bone is missing — the caller then cannot judge
 * contact at all and must decline rather than guess.
 */
export function markerPositions(rig, bones = null) {
	if (!rig) return null;
	rig.updateMatrixWorld(true);
	const out = {};
	for (const name of FOOT_PLANT_MARKERS) {
		// findBone traverses the whole skeleton, and a whole-clip sweep asks this
		// question four times a frame; a caller with a resolved map hands it over.
		const bone = bones?.get(name) ?? findBone(rig, name);
		if (!bone) return null;
		out[name] = bone.getWorldPosition(new THREE.Vector3());
	}
	return out;
}

/**
 * Each marker's PLANTED height for this clip: its minimum over every sampled
 * frame. That minimum is by definition a frame where the marker was as low as
 * this performance ever puts it, which is the only trustworthy definition of
 * "on the ground" available without trusting the export's floor. Same rule,
 * and the same reasoning, as auto-physics' plantedFloor — expressed over
 * marker POSITIONS here because this pass needs the XZ too.
 */
export function plantedFloorHeights(perFramePositions) {
	if (!perFramePositions?.length) return null;
	const out = {};
	for (const name of FOOT_PLANT_MARKERS) {
		let min = Infinity;
		for (const sample of perFramePositions) {
			const y = sample?.[name]?.y;
			if (Number.isFinite(y) && y < min) min = y;
		}
		if (!Number.isFinite(min)) return null;
		out[name] = min;
	}
	return out;
}

/**
 * Per-frame XZ speed in m/s along a track of world positions. Central
 * difference in the interior (so a frame's speed is about the frame and not
 * about the gap after it) and one-sided at the ends.
 */
export function xzSpeeds(positions, fps = 30) {
	const rate = Number.isFinite(fps) && fps > 0 ? fps : 30;
	const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
	const out = [];
	for (let index = 0; index < positions.length; index += 1) {
		if (positions.length < 2) { out.push(0); continue; }
		if (index === 0) out.push(flat(positions[1], positions[0]) * rate);
		else if (index === positions.length - 1) out.push(flat(positions[index], positions[index - 1]) * rate);
		else out.push((flat(positions[index + 1], positions[index - 1]) * rate) / 2);
	}
	return out;
}

/**
 * Contact state per frame with hysteresis: a contact OPENS only when the foot
 * is both low and slow, and stays open until it is clearly high OR clearly
 * fast. `heights` are relative to the marker's own planted floor.
 */
export function contactFlags({ heights, speeds, onHeight, offHeight, onSpeed, offSpeed } = {}) {
	const out = [];
	let on = false;
	for (let index = 0; index < (heights?.length ?? 0); index += 1) {
		const height = heights[index];
		const speed = speeds?.[index] ?? 0;
		on = on
			? !(height > offHeight || speed > offSpeed)
			: (height < onHeight && speed < onSpeed);
		out.push(on);
	}
	return out;
}

/**
 * Drop one-frame contacts and fill one-frame gaps. Both are the same artefact
 * seen from the two sides: a detector reading a threshold frame by frame
 * flickers, and a flicker becomes either a one-frame island (a twitch) or a
 * one-frame hole in the middle of a stance (two intervals with two different
 * plants, and a jump between them).
 */
export function despeckle(flags) {
	const out = [...flags];
	for (let index = 0; index < out.length; index += 1) {
		if (!out[index]) continue;
		if (out[index - 1] || out[index + 1]) continue;
		out[index] = false;
	}
	for (let index = 1; index < out.length - 1; index += 1) {
		if (!out[index] && out[index - 1] && out[index + 1]) out[index] = true;
	}
	return out;
}

/** Contiguous runs of true, as inclusive [start, end] index pairs. */
export function flagsToIntervals(flags) {
	const out = [];
	let open = -1;
	for (let index = 0; index <= flags.length; index += 1) {
		const flag = index < flags.length && flags[index];
		if (flag && open < 0) open = index;
		if (flag || open < 0) continue;
		out.push({ start: open, end: index - 1 });
		open = -1;
	}
	return out;
}

/** The component-wise median X and Z over `positions[from..to)`. Component-wise
 * because the two axes are independent statements about where the foot was;
 * a "median point" would have to pick one frame and inherit its noise. */
export function medianXZ(positions, from, to) {
	const xs = [];
	const zs = [];
	for (let index = from; index < to; index += 1) {
		const p = positions[index];
		if (!p) continue;
		xs.push(p.x);
		zs.push(p.z);
	}
	if (!xs.length) return null;
	const mid = (values) => {
		values.sort((a, b) => a - b);
		const half = values.length >> 1;
		return values.length % 2 ? values[half] : (values[half - 1] + values[half]) / 2;
	};
	return { x: mid(xs), z: mid(zs) };
}

/**
 * THE EASE, as pure arithmetic: how many of the frames just outside a contact
 * the correction should be handed back over, and at what weight each.
 *
 * `travel[k]` is the clip's own foot travel on candidate k (candidate 0 is the
 * first frame outside the contact, measured from the contact's edge frame);
 * `offset` is the correction still standing at that edge. The weight falls
 * with ARC LENGTH — the distance the foot has already covered — not with frame
 * count, so the correction comes off fastest exactly where the foot is moving
 * fastest and the extra motion hides inside motion the clip already had.
 *
 * With that shape the displacement the ease ADDS on candidate k is
 * `offset · travel[k] / L`, where L is the total travel over the chosen
 * frames. So this returns the SHORTEST prefix whose L keeps every one of those
 * additions inside `budget`, and no longer: a 5 mm plant offset borrows one
 * swing frame, a 4 cm one borrows five. When no prefix fits, the longest
 * available is used — the correction is still bounded by MAX_PLANT_SHIFT, and
 * spreading it as thin as the clip allows is the best on offer.
 *
 * A foot that does not move at all over the candidates has no arc length to
 * hide anything in; the weights then fall linearly, which hands the frames
 * back immediately rather than pretending there is a ramp to run.
 */
export function easeWeights(travel, offset, budget = PLANT_STEP_BUDGET) {
	if (!travel?.length) return [];
	const cumulative = [];
	let sum = 0;
	for (const value of travel) cumulative.push((sum += value));
	let chosen = travel.length;
	for (let count = 1; count <= travel.length; count += 1) {
		const total = cumulative[count - 1];
		if (!(total > 1e-6)) continue;
		let fits = true;
		for (let index = 0; index < count; index += 1) {
			if ((offset * travel[index]) / total > budget + 1e-9) { fits = false; break; }
		}
		if (fits) { chosen = count; break; }
	}
	const total = cumulative[chosen - 1];
	const out = [];
	for (let index = 0; index < chosen; index += 1) {
		out.push(total > 1e-6
			? Math.max(0, 1 - cumulative[index] / total)
			: Math.max(0, 1 - (index + 1) / chosen));
	}
	return out;
}

/* --- putting a foot exactly where the plant says ---------------------------- */

/**
 * Solve one leg so its ankle lands ON `want`, keeping both of that foot's
 * markers at or above their own floor.
 *
 * WHY THIS IS A LOOP AND NOT ONE solveIk CALL. Two-bone IK is exact in
 * principle, and solveIk's own comment says so — an unreachable target
 * stretches straight at it, a reachable one is hit in one step. In practice
 * its BEND CONTINUITY term is not orthogonalised against the root→target line:
 * on a bent chain the hinge direction is reused as `p1cur − linePoint`, which
 * generally has a component ALONG that line, so the knee is placed off the
 * l0-sphere and the ankle lands short. Measured on the synthetic rig at a
 * normal walking pose: 12 mm of miss, in XZ, which is a quarter of the whole
 * slide budget this pass is trying to defend. (The straight-chain branch of
 * the same function does orthogonalise — `bend.addScaledVector(dir,
 * -poleWorld.dot(dir))` — which is why the error only shows on a bent leg.)
 *
 * Rather than change the contract of the solver every drag path in the editor
 * shares, this pass closes the loop itself: aim, measure where the ankle
 * actually went, and push the aim by the miss. It converges in two or three
 * passes because the miss is a smooth function of the aim.
 *
 * The floor guard rides the same loop. Only the ankle is aimed, but the solve
 * rotates the shin and the foot comes with it, so a purely horizontal
 * correction can still dip the toe under the ground; the goal's height is
 * raised by whatever penetration is left and the loop re-converges on that.
 */
const solveScratch = new THREE.Vector3();
function plantChain(chain, want, markerBones, floors, tolerance) {
	const aim = want.clone();
	const goal = want.clone();
	const got = new THREE.Vector3();
	for (let pass = 0; pass < 8; pass += 1) {
		solveIk(chain, aim);
		chain.bones[2].getWorldPosition(got);
		let penetration = 0;
		for (const [name, bone] of markerBones) {
			penetration = Math.max(penetration, floors[name] - bone.getWorldPosition(solveScratch).y);
		}
		if (penetration > tolerance) goal.y += penetration;
		if (goal.distanceTo(got) < 2e-4 && penetration <= tolerance) break;
		aim.add(goal).sub(got);
	}
	return got.clone();
}

/* --- layer plumbing --------------------------------------------------------- */

/** Every bone this pass could write, for snapshot/restore. */
function layerBones(chains, fkJoints) {
	const bones = [];
	const seen = new Set();
	const add = (bone) => {
		if (!bone || seen.has(bone)) return;
		seen.add(bone);
		bones.push(bone);
	};
	for (const chain of chains.values()) for (const bone of chain.bones) add(bone);
	if (fkJoints) for (const joint of fkJoints.values()) add(joint.bone);
	return bones;
}

function snapshotBones(bones) {
	return bones.map((bone) => ({ position: bone.position.clone(), quaternion: bone.quaternion.clone() }));
}

function restoreBones(rig, bones, snapshot) {
	for (let index = 0; index < bones.length; index += 1) {
		bones[index].position.copy(snapshot[index].position);
		bones[index].quaternion.copy(snapshot[index].quaternion);
	}
	rig.updateMatrixWorld(true);
}

/* --- the pass --------------------------------------------------------------- */

/**
 * Clean foot skate over a frame range.
 *
 * Callable either positionally — `footPlantRange(rig, chains, options)`, which
 * reads like the solver calls in ik.js — or with one options object like its
 * sibling drivers `fixCollisionsRange` / `autoPhysicsRange`. Both forms take
 * exactly the same options.
 *
 * Returns
 *   {
 *     supported, reason,
 *     intervals: [{ foot, start, end, length, plant, slide, applied, refused }],
 *     keyedFrames, anchoredFrames,
 *     maxCorrection, maxRootDrop,
 *     residualSlide, contactBefore, contactAfter, planted,
 *   }
 *
 * `supported: false` separates "could not run" from "ran and found nothing" —
 * the distinction auto-physics had to learn the hard way, because a UI that
 * says "no foot skate in this clip" about a rig it could not measure is
 * telling the user something they cannot act on.
 *
 * TWO SWEEPS, for the reason fix-collisions documents at length: `applyFrame`
 * evaluates the IK layer, so the moment this loop starts writing keys it is no
 * longer looking at the clip. Sweep 1 records each frame's pose with nothing
 * of this run's in it; sweep 2 restores that pose before solving, so every
 * frame is judged and fixed against the same clip.
 *
 * Sweep 1 records TWO poses per frame. The LAYER pose (clip + keys that
 * already existed) is what gets corrected, because the user's earlier
 * corrections are part of the pose they are asking to clean. The RAW CLIP pose
 * is what each key's rotations are stored as a DELTA FROM, because that is
 * what ikEvaluate will find on the bone when it comes to apply the key.
 */
export function footPlantRange(rigOrOptions, chainsArgument, positionalOptions) {
	const options = chainsArgument === undefined && positionalOptions === undefined
		? (rigOrOptions ?? {})
		: { ...(positionalOptions ?? {}), rig: rigOrOptions, chains: chainsArgument };
	const {
		rig,
		chains,
		ikState,
		fkJoints = null,
		applyFrame,
		motion = null,
		startFrame = 0,
		endFrame = null,
		fps = 30,
		onHeight = CONTACT_ON_HEIGHT,
		offHeight = CONTACT_OFF_HEIGHT,
		onSpeed = CONTACT_ON_SPEED,
		offSpeed = CONTACT_OFF_SPEED,
		minContactFrames = MIN_CONTACT_FRAMES,
		maxPlantShift = MAX_PLANT_SHIFT,
		minSlide = MIN_INTERVAL_SLIDE,
		taperFrames = PLANT_TAPER,
		stepBudget = PLANT_STEP_BUDGET,
		blendWindow = 6,
		overExtendFraction = OVER_EXTEND_FRACTION,
		rootDropLimit = MAX_ROOT_DROP,
		floorTolerance = PLANT_FLOOR_TOLERANCE,
	} = options;

	const refuse = (reason) => ({
		supported: false, reason,
		intervals: [], keyedFrames: [], anchoredFrames: [],
		maxCorrection: 0, maxRootDrop: 0, residualSlide: 0,
		contactBefore: null, contactAfter: null, planted: null,
	});
	if (!rig || !chains || !ikState || typeof applyFrame !== "function") return refuse("no-driver");
	const feet = FOOT_PLANT_CHAINS.filter((foot) => chains.get(foot.id));
	if (feet.length === 0) return refuse("no-leg-chains");

	const start = Math.max(0, Math.round(startFrame) || 0);
	const lastFrame = Number.isFinite(endFrame) ? Math.round(endFrame) : (motion?.frames ?? 0) - 1;
	const end = Math.max(start, Math.round(lastFrame));
	const count = end - start + 1;
	if (count < Math.max(2, minContactFrames)) return refuse("range-too-short");

	const hips = fkJoints?.get?.("hips") ?? null;

	// Marker bones, resolved once: findBone walks the skeleton, and both sweeps
	// below ask for all four markers on every frame.
	const boneByName = new Map();
	for (const name of FOOT_PLANT_MARKERS) {
		const bone = findBone(rig, name);
		if (!bone) return refuse("rig-not-measurable");
		boneByName.set(name, bone);
	}
	/** foot id -> [[markerName, bone], ...], for the floor guard. */
	const markerBones = new Map(feet.map((foot) => [
		foot.id,
		[[foot.ankle, boneByName.get(foot.ankle)], [foot.toe, boneByName.get(foot.toe)]],
	]));

	/* --- sweep 1: measure the clip, writing nothing ------------------------ */
	const bones = layerBones(chains, fkJoints);
	const chainIds = [...chains.keys()];
	const readChainQuats = () => new Map(chainIds.map(
		(id) => [id, chains.get(id).bones.map((b) => b.quaternion.clone())],
	));
	const layerActive = ikState.tracked.size > 0;
	const basePose = [];
	const samples = [];
	const clipQuats = [];
	const clipHips = [];
	for (let frame = start; frame <= end; frame += 1) {
		if (layerActive) {
			// Silence the layer for one sample: ikEvaluate walks `tracked`, so an
			// empty set makes the caller's applyFrame pure clip. Restored on the
			// same iteration — this loop owns the rig for its duration.
			const tracked = ikState.tracked;
			ikState.tracked = new Set();
			try {
				applyFrame(frame);
				clipQuats.push(readChainQuats());
				clipHips.push(hips ? hips.bone.position.clone() : null);
			} finally {
				ikState.tracked = tracked;
			}
		}
		applyFrame(frame);
		const marks = markerPositions(rig, boneByName);
		if (!marks) return refuse("rig-not-measurable");
		samples.push(marks);
		basePose.push(snapshotBones(bones));
		if (!layerActive) {
			clipQuats.push(readChainQuats());
			clipHips.push(hips ? hips.bone.position.clone() : null);
		}
	}
	const planted = plantedFloorHeights(samples);
	if (!planted) return refuse("rig-not-measurable");

	/* --- contact detection -------------------------------------------------- */
	/** Per foot: the ankle track, its speed, the height of the LOWEST of its
	 * two markers above that marker's own floor, and the resulting contact
	 * flags. The height is the minimum of the two because a foot rolled onto
	 * its toe is still on the ground even with the ankle 5 cm up. */
	const perFoot = new Map();
	for (const foot of feet) {
		const ankle = samples.map((sample) => sample[foot.ankle]);
		const toe = samples.map((sample) => sample[foot.toe]);
		const heights = samples.map((_, index) => Math.min(
			ankle[index].y - planted[foot.ankle],
			toe[index].y - planted[foot.toe],
		));
		const speeds = xzSpeeds(ankle, fps);
		const flags = despeckle(contactFlags({ heights, speeds, onHeight, offHeight, onSpeed, offSpeed }));
		perFoot.set(foot.id, { foot, ankle, toe, heights, speeds, flags });
	}
	/** Planted fraction and mean XZ speed while planted, per foot — the exact
	 * pair the QA numbers are quoted in, measured before and after. */
	const contactReport = (byFoot) => {
		const out = {};
		for (const [id, track] of byFoot) {
			let frames = 0;
			let total = 0;
			for (let index = 0; index < track.flags.length; index += 1) {
				if (!track.flags[index]) continue;
				frames += 1;
				total += track.speeds[index];
			}
			out[id] = { planted: frames / track.flags.length, speed: frames ? total / frames : 0, frames };
		}
		return out;
	};
	const contactBefore = contactReport(perFoot);

	/* --- which frames are ANCHORS ------------------------------------------- */
	/**
	 * A frame that already carries a key for a foot chain is a statement
	 * somebody else made about that foot — a user's drag, an earlier collision
	 * fix, or this pass's own previous run. The pass does not touch it. That is
	 * the same provenance rule the collision pass follows, and it is what makes
	 * "run it twice" structurally safe rather than merely usually safe: the
	 * second run cannot rewrite the first one's answer even if the detector
	 * drew its intervals one frame differently.
	 */
	const anchoredAt = (frame, id) => Boolean(ikState.keys.get(frame)?.has(id));
	const anchoredFrames = [];

	/* --- turn contacts into plants ------------------------------------------ */
	const intervals = [];
	for (const foot of feet) {
		const track = perFoot.get(foot.id);
		for (const run of flagsToIntervals(track.flags)) {
			const length = run.end - run.start + 1;
			const record = {
				foot: foot.id,
				start: start + run.start,
				end: start + run.end,
				length,
				plant: null,
				slide: 0,
				applied: false,
				refused: null,
			};
			intervals.push(record);
			if (length < minContactFrames) { record.refused = "too-short"; continue; }
			const median = medianXZ(track.ankle, run.start, run.end + 1);
			if (!median) { record.refused = "too-short"; continue; }
			record.plant = { x: median.x, y: planted[foot.ankle], z: median.z };
			// How far the foot actually travels from the plant. This is both the
			// slide the pass would remove and, past MAX_PLANT_SHIFT, the evidence
			// that this was never a plant.
			let worst = 0;
			for (let index = run.start; index <= run.end; index += 1) {
				const p = track.ankle[index];
				worst = Math.max(worst, Math.hypot(p.x - median.x, p.z - median.z));
			}
			record.slide = worst;
			if (worst > maxPlantShift) { record.refused = "step-not-skate"; continue; }
			// THE WHOLE INTERVAL VOTES, not just its full-weight core.
			//
			// The core-only rule (auto-physics' own, and the first thing tried
			// here) is wrong for this pass, because a skate's worst frames are at
			// the ENDS of a stance and the taper is exactly what excludes them.
			// Measured on a 24 fps walk: a nine-frame stance leaves a three-frame
			// core whose deviation from the interval median is a fifth of the
			// interval's own, so an 8 cm skate voted 0.9 cm and every stance in
			// the clip was skipped as clean. The interval's real slide is the
			// number the user can see, so it is the number that decides.
			//
			// What keeps the pass a fixed point is therefore not this gate but
			// the anchor rule: a corrected interval keys EVERY one of its frames
			// and one frame past each end, so on a second run there is nothing
			// left in it that this pass is allowed to touch (see the planned-shift
			// gate below, which is where that shows up).
			if (worst <= minSlide) { record.refused = null; continue; } // already planted
			record.applied = true;
		}
	}

	/* --- sweep 2: pin each accepted interval, frame by frame ---------------- */
	/**
	 * THE TAPER LIVES IN THE SWING, NOT IN THE CONTACT.
	 *
	 * The first version eased the correction in and out over the interval's own
	 * first and last frames, which is where the reasoning goes wrong: those
	 * frames are contact frames, the metric the whole pass is judged by is the
	 * foot's speed WHILE IN CONTACT, and a ramp is motion. Measured on a
	 * 24 fps walk with a ~3 cm plant offset, the six tapered frames each gained
	 * about 0.2 m/s while the thirteen core frames each lost 0.03 — the mean
	 * slide over the clip went UP, from 0.035 to 0.038 m/s, on an interval the
	 * pass had just "fixed".
	 *
	 * So the contact is held at full strength end to end, and the hand-back
	 * happens on the frames either side of it, which are swing frames: the foot
	 * is already travelling at a metre a second there, and a couple of
	 * centimetres of ease is invisible against that. This is also what Kovar's
	 * original does — the constraint is absolute over the contact, and the
	 * transition windows are outside it.
	 *
	 * The pad never crosses into another contact of the same foot (that
	 * interval owns those frames), never leaves the range, and never overwrites
	 * an anchor.
	 */
	/** frame -> [{ foot, target, weight, shift }] */
	const plan = new Map();
	const footById = new Map(feet.map((foot) => [foot.id, foot]));
	for (const record of intervals) {
		if (!record.applied) continue;
		const track = perFoot.get(record.foot);
		const descriptor = footById.get(record.foot);
		const entries = [];
		let anchored = 0;
		/**
		 * Plan one frame, or count it as an anchor.
		 *
		 * Inside the contact the correction is "go to the plant" — a different
		 * vector every frame, because the frame's own position is different.
		 * Over the EASE it is the contact edge's correction FADING OUT: one fixed
		 * vector times a falling weight. The distinction is not cosmetic. Lerping
		 * toward the plant out in the swing eases a distance that is itself
		 * growing (the foot is running away from the plant at a metre a second),
		 * so the residual correction barely shrinks for the first frames and then
		 * collapses — measured 13.4 mm of added travel on a frame the budget said
		 * would get 10. A fixed vector times the weight removes exactly
		 * `|offset| · Δw` per frame, which is the quantity padPlan budgets.
		 */
		const planFrame = (frame, weight, fade = null) => {
			if (frame < start || frame > end) return false;
			if (anchoredAt(frame, record.foot)) {
				if (!anchoredFrames.includes(frame)) anchoredFrames.push(frame);
				anchored += 1;
				return false;
			}
			const index = frame - start;
			const current = track.ankle[index];
			const target = new THREE.Vector3(
				current.x + (fade ? fade.x : record.plant.x - current.x) * weight,
				// The plant's HEIGHT is the clip's own ankle height for this frame,
				// never the interval's floor: pinning y flat would flatten the
				// heel-to-toe roll, which is real motion the clip got right. All the
				// floor does here is stop the correction pushing the ankle under it.
				Math.max(current.y, planted[descriptor.ankle]),
				current.z + (fade ? fade.z : record.plant.z - current.z) * weight,
			);
			const shift = Math.hypot(target.x - current.x, target.z - current.z);
			// EVERY frame the correction reaches gets a key, including the ones
			// where it rounds to nothing. The ease is an authored curve, and the
			// layer only replays a curve it can see: leaving a zero-weight frame
			// unkeyed makes ikEvaluate interpolate it between the last real
			// correction and the pin beyond, which puts back a share of the
			// correction on the one frame the ease had just finished removing it
			// from.
			entries.push({ frame, foot: record.foot, target, weight, shift });
			return true;
		};
		for (let frame = record.start; frame <= record.end; frame += 1) planFrame(frame, 1);
		/** One side's ease: the frames just outside the contact it may run over —
		 * stopping at the range, at an anchor, or at this foot's next contact —
		 * paired with the weights easeWeights works out for them. */
		const padPlan = (direction) => {
			const edgeFrame = direction < 0 ? record.start : record.end;
			const edge = track.ankle[edgeFrame - start];
			const offset = Math.hypot(edge.x - record.plant.x, edge.z - record.plant.z);
			const candidates = [];
			const travel = [];
			let previous = edge;
			for (let step = 1; step <= taperFrames; step += 1) {
				const frame = edgeFrame + direction * step;
				if (frame < start || frame > end) break;
				if (track.flags[frame - start]) break; // this foot's next contact owns it
				if (anchoredAt(frame, record.foot)) break;
				const here = track.ankle[frame - start];
				candidates.push(frame);
				travel.push(here.distanceTo(previous));
				previous = here;
			}
			if (!candidates.length) return [];
			return easeWeights(travel, offset, stepBudget)
				.map((weight, index) => ({ frame: candidates[index], weight }));
		};
		for (const direction of [-1, 1]) {
			const edge = track.ankle[(direction < 0 ? record.start : record.end) - start];
			const fade = { x: record.plant.x - edge.x, z: record.plant.z - edge.z };
			for (const { frame, weight } of padPlan(direction)) {
				if (!planFrame(frame, weight, fade)) break;
			}
		}
		record.anchored = anchored;
		record.plannedFrames = entries.length;
		// THE PLANNED-SHIFT GATE, and the reason a second press keys nothing.
		//
		// The interval's slide says the clip needs work; this says THIS RUN can
		// still do some. On a second press every frame the first press touched is
		// an anchor, so what is left to plan is either nothing at all or a frame
		// or two the detector drew differently this time — out in the ease, where
		// the correction is small by construction. Either way the biggest move on
		// offer falls under the same centimetre the interval had to clear to be
		// worth doing, and the interval is dropped whole rather than
		// half-rewritten around its neighbour's keys.
		let plannedShift = 0;
		for (const entry of entries) plannedShift = Math.max(plannedShift, entry.shift);
		record.plannedShift = plannedShift;
		if (!entries.length) { record.applied = false; record.refused = "all-frames-anchored"; continue; }
		if (plannedShift <= minSlide) { record.applied = false; record.refused = anchored ? "already-keyed" : null; continue; }
		for (const entry of entries) {
			if (!plan.has(entry.frame)) plan.set(entry.frame, []);
			plan.get(entry.frame).push(entry);
		}
		// The contact's frames are planned first and the two eases after it, so
		// the entry order is not the frame order — take the extremes, not the ends.
		record.plannedRange = entries.reduce(
			(range, entry) => [Math.min(range[0], entry.frame), Math.max(range[1], entry.frame)],
			[entries[0].frame, entries[0].frame],
		);
	}

	const keyedFrames = [];
	const hipsKeyed = new Set();
	/** foot id -> the frames this run keyed for it, so the edge pins below
	 * cannot overwrite a correction written for a neighbouring interval. */
	const keyedByFoot = new Map(feet.map((foot) => [foot.id, new Set()]));
	let maxCorrection = 0;
	let maxRootDrop = 0;
	const target3 = new THREE.Vector3();
	const hipPosition = new THREE.Vector3();
	const rootDelta = new THREE.Vector3();
	const perFootDelta = new THREE.Vector3();

	const restoreFrame = (frame) => {
		applyFrame(frame);
		restoreBones(rig, bones, basePose[frame - start]);
	};

	for (const frame of [...plan.keys()].sort((a, b) => a - b)) {
		const active = plan.get(frame);
		const index = frame - start;
		restoreFrame(frame);

		/* --- root absorption ------------------------------------------------ */
		/**
		 * A leg asked to reach past OVER_EXTEND_FRACTION of its own length is
		 * being asked to become a stilt. The deficit goes into the ROOT instead:
		 * the hips travel toward the plant along the hip→plant line, which on a
		 * standing character is mostly downward — the knee bends, the foot keeps
		 * its plant, and the body reads as taking the weight.
		 *
		 * DOUBLE SUPPORT. With both feet planted and both over-extended the two
		 * demands generally point in different directions, and satisfying either
		 * one alone tears the other foot off its plant. The hips go to the
		 * MIDPOINT of the two: the horizontal halves cancel when the feet pull
		 * opposite (a wide stance), leaving exactly the vertical drop both of
		 * them were asking for.
		 */
		rootDelta.set(0, 0, 0);
		let pulls = 0;
		if (hips) {
			for (const entry of active) {
				const chain = chains.get(entry.foot);
				if (!chain) continue;
				const reach = chain.lengths[0] + chain.lengths[1];
				chain.bones[0].getWorldPosition(hipPosition);
				const distance = hipPosition.distanceTo(entry.target);
				const over = distance - overExtendFraction * reach;
				if (!(over > 0)) continue;
				perFootDelta.copy(entry.target).sub(hipPosition).normalize().multiplyScalar(over * entry.weight);
				rootDelta.add(perFootDelta);
				pulls += 1;
			}
			if (pulls > 0) {
				rootDelta.divideScalar(pulls);
				if (rootDelta.length() > rootDropLimit) rootDelta.setLength(rootDropLimit);
				// THE ROOT MAY NOT PUSH A FOOT THROUGH THE FLOOR.
				//
				// Lowering the hips lowers the WHOLE body, and the planted legs are
				// re-solved back onto their plants afterwards while the SWING foot
				// simply comes down with the root. On a 24 fps walk that put a
				// swing toe 9.6 mm under the floor the clip itself never went below
				// — invisible in the numbers the pass was reporting, and exactly
				// the kind of thing the eye catches. So the drop is scaled back to
				// whatever headroom the feet this frame is NOT planting actually
				// have.
				let headroom = Infinity;
				const pinning = new Set(active.map((entry) => entry.foot));
				for (const foot of feet) {
					if (pinning.has(foot.id)) continue;
					for (const [name, bone] of markerBones.get(foot.id)) {
						headroom = Math.min(headroom, bone.getWorldPosition(solveScratch).y - planted[name]);
					}
				}
				if (Number.isFinite(headroom) && rootDelta.y < -Math.max(0, headroom)) {
					rootDelta.multiplyScalar(Math.max(0, headroom) / -rootDelta.y);
				}
				if (rootDelta.lengthSq() > 1e-12) {
					solveHipsTranslate(hips, rootDelta, hips.bone.position.clone());
					maxRootDrop = Math.max(maxRootDrop, rootDelta.length());
				} else {
					pulls = 0;
				}
			}
		}

		/* --- solve each planted leg onto its target ------------------------- */
		/**
		 * EVERY KEYED FRAME IS SOLVED, INCLUDING THE ONES WITH NOTHING TO FIX.
		 *
		 * A key whose rotation delta is the identity is not a no-op. ikEvaluate
		 * gives a frame inside a key island BIND bone translations (see
		 * restoreChainPositions — it has to, because the authored pose is defined
		 * at bind translations), and a generated clip's own translations sit
		 * about 19 mm off bind. So a frame keyed "unchanged" still moves: measured
		 * on a 24 fps walk, three mid-stance frames whose plant offset was under
		 * half a millimetre — and which the pass therefore keyed without solving —
		 * came out 13 mm off the plant their neighbours were pinned to, and the
		 * contact's total travel went from 16 mm to 36.
		 *
		 * Solving them fixes it, because the solve happens in the same bind
		 * translations playback will use: the ankle is put where it belongs in the
		 * space the key is evaluated in, not in the space the clip happened to be
		 * measured in.
		 */
		for (const entry of active) {
			const chain = chains.get(entry.foot);
			if (!chain) continue;
			target3.copy(entry.target);
			plantChain(chain, target3, markerBones.get(entry.foot), planted, floorTolerance);
			maxCorrection = Math.max(maxCorrection, entry.shift);
		}

		/* --- bake ------------------------------------------------------------ */
		const touched = active.map((entry) => entry.foot);
		const baseQuats = new Map();
		for (const id of touched) baseQuats.set(id, clipQuats[index].get(id));
		let basePositions = null;
		if (hips && pulls > 0 && !anchoredAt(frame, "hips")) {
			touched.push("hips");
			basePositions = new Map([["hips", clipHips[index]]]);
			hipsKeyed.add(frame);
		}
		ikBakeKeyframe(chains, ikState, frame, fkJoints, touched, basePositions, baseQuats);
		// Provenance, so a later pass (and the tests) can tell this pass's own
		// keys from a pose the user authored by hand. ikEvaluate ignores it.
		const entry = ikState.keys.get(frame);
		for (const id of touched) {
			const key = entry?.get(id);
			if (key) key.src = "footPlant";
			keyedByFoot.get(id)?.add(frame);
		}
		keyedFrames.push(frame);
	}

	/* --- zero pins just outside each corrected interval --------------------- */
	/**
	 * The taper brings the correction to zero at the interval's own edge frame,
	 * but the IK layer does not stop there: the last key is the nearest key for
	 * the six frames of blend window past it, so a share of that key's
	 * correction is replayed onto frames the interval never claimed — and it is
	 * replayed onto a SWING pose, where a rotation delta authored for a planted
	 * leg means something else entirely. A zero-delta key one frame outside each
	 * corrected interval ends the island there instead: past it every frame
	 * finds a key whose delta is the identity, so the clip comes back exactly.
	 *
	 * Same construction as the hips pins below and as auto-physics' boundary
	 * pins — the key is baked over the pose the frame already had, so its delta
	 * is zero by construction and not merely zero at the pinned frame.
	 */
	for (const record of intervals) {
		if (!record.applied || !record.plannedRange) continue;
		for (const frame of [record.plannedRange[0] - 1, record.plannedRange[1] + 1]) {
			if (frame < start || frame > end) continue;
			if (anchoredAt(frame, record.foot)) continue;
			if (keyedByFoot.get(record.foot)?.has(frame)) continue;
			restoreFrame(frame);
			// Solved, not merely baked, and for the same reason every frame inside
			// the island is: the key hands this frame BIND translations, so the
			// only way to say "leave the ankle where the clip put it" is to solve
			// for that position in the space the key will be evaluated in.
			const chain = chains.get(record.foot);
			if (chain) {
				target3.copy(perFoot.get(record.foot).ankle[frame - start]);
				plantChain(chain, target3, markerBones.get(record.foot), planted, floorTolerance);
			}
			ikBakeKeyframe(chains, ikState, frame, fkJoints, [record.foot], null, new Map([
				[record.foot, clipQuats[frame - start].get(record.foot)],
			]));
			const key = ikState.keys.get(frame)?.get(record.foot);
			if (key) key.src = "footPlant";
			keyedByFoot.get(record.foot)?.add(frame);
			if (!keyedFrames.includes(frame)) keyedFrames.push(frame);
		}
	}
	keyedFrames.sort((a, b) => a - b);

	/* --- hips pins ---------------------------------------------------------- */
	/**
	 * EVERY FRAME OF A HIPS ISLAND GETS A HIPS KEY, not just the ones the root
	 * actually moved on.
	 *
	 * ikEvaluate holds a track at full strength across the whole ISLAND between
	 * two keys and interpolates the frames in between, so two hips keys six
	 * frames apart hand every frame between them a share of the root drop —
	 * frames nobody solved, and whose feet were never checked against the floor
	 * with the root down there. Two things go wrong at once, and both were
	 * measured on a 24 fps walk:
	 *
	 *  - a swing toe ended 7 mm under a floor the clip itself never crossed,
	 *    because the interpolated drop is applied to a pose the floor guard
	 *    never saw;
	 *  - and worse, THE PLANTS COME OFF. A foot key stores local rotations, so
	 *    the ankle's world position is only as good as the root it hangs from;
	 *    a root that sits somewhere else at playback than it did at solve time
	 *    slides the "planted" foot by exactly that difference. The clip's mean
	 *    slide while planted came out unchanged (0.031 -> 0.036 m/s) after a
	 *    pass that had pinned every contact perfectly.
	 *
	 * So each contiguous GROUP of hips keys — runs closer together than the
	 * blend window, which is exactly ikEvaluate's own island rule — is filled
	 * in solid, plus one frame either side. A pin carries the pose the frame
	 * already had over the clip's own position as its base, so its delta is
	 * zero by construction and not merely zero at the pinned frame. Groups
	 * further apart than the window are separate islands with clip in between,
	 * and need nothing.
	 */
	if (hips && hipsKeyed.size > 0) {
		const sorted = [...hipsKeyed].sort((a, b) => a - b);
		const groups = [];
		let first = sorted[0];
		let previous = sorted[0];
		for (let index = 1; index < sorted.length; index += 1) {
			if (sorted[index] - previous > blendWindow) {
				groups.push([first, previous]);
				first = sorted[index];
			}
			previous = sorted[index];
		}
		groups.push([first, previous]);
		const pins = new Set();
		for (const [from, to] of groups) {
			for (let frame = Math.max(start, from - 1); frame <= Math.min(end, to + 1); frame += 1) {
				if (hipsKeyed.has(frame) || anchoredAt(frame, "hips")) continue;
				pins.add(frame);
			}
		}
		for (const frame of [...pins].sort((a, b) => a - b)) {
			restoreFrame(frame);
			ikBakeKeyframe(chains, ikState, frame, fkJoints, ["hips"], new Map([["hips", clipHips[frame - start]]]), null);
			const key = ikState.keys.get(frame)?.get("hips");
			if (key) key.src = "footPlant";
			if (!keyedFrames.includes(frame)) keyedFrames.push(frame);
		}
		keyedFrames.sort((a, b) => a - b);
	}

	/* --- the truth on the pose the viewer will actually see ----------------- */
	/**
	 * Everything above judges a frame at the moment it is solved. What the
	 * viewer gets is the EVALUATED pose — clip plus every key's blend ramp —
	 * and the last key written can move a frame that was already measured. So
	 * one read-only walk at the end, and let that be the number the toast says
	 * out loud. Nothing is written here: writing would move the ramps again and
	 * there would be no frame left to check it.
	 */
	let contactAfter = contactBefore;
	let residualSlide = 0;
	for (const value of Object.values(contactBefore)) residualSlide = Math.max(residualSlide, value.speed);
	if (keyedFrames.length) {
		const after = [];
		for (let frame = start; frame <= end; frame += 1) {
			applyFrame(frame);
			after.push(markerPositions(rig, boneByName));
		}
		const afterFoot = new Map();
		for (const foot of feet) {
			const ankle = after.map((sample) => sample[foot.ankle]);
			const toe = after.map((sample) => sample[foot.toe]);
			const heights = after.map((_, index) => Math.min(
				ankle[index].y - planted[foot.ankle],
				toe[index].y - planted[foot.toe],
			));
			const speeds = xzSpeeds(ankle, fps);
			const flags = despeckle(contactFlags({ heights, speeds, onHeight, offHeight, onSpeed, offSpeed }));
			afterFoot.set(foot.id, { foot, ankle, toe, heights, speeds, flags });
		}
		contactAfter = contactReport(afterFoot);
		residualSlide = 0;
		for (const value of Object.values(contactAfter)) residualSlide = Math.max(residualSlide, value.speed);
	}

	return {
		supported: true,
		reason: "",
		intervals,
		keyedFrames,
		anchoredFrames: anchoredFrames.sort((a, b) => a - b),
		maxCorrection,
		maxRootDrop,
		residualSlide,
		contactBefore,
		contactAfter,
		planted,
	};
}
