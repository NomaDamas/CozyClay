import * as THREE from "three";
import {
	resolveIkRig,
	createIkState,
	ikEvaluate,
	ikBakeKeyframe,
	ikKeyframes,
	solveIk,
} from "../../src/ardy/ik.js";
import { fixCollisions } from "../../src/ardy/fix-collisions.js";
import {
	SEGMENT_MASSES,
	FOOT_MARKERS,
	MIN_AIRBORNE_FRAMES,
	AIRBORNE_LIFT,
	GROUND_CONTACT_LIFT,
	GROUND_CONTACT_HORIZONTAL_SPEED,
	GROUND_LOCK_MAX_PULL,
	GROUND_LOCK_EPSILON,
	GROUND_LOCK_REACH_LIFT,
	AUTO_PHYSICS_EPSILON,
	MAX_CORRECTION,
	EXIT_LIFT,
	SPLIT_DEPTH,
	EDGE_TAPER,
	expandAirborneSpans,
	splitAtTroughs,
	edgeTaperWeight,
	FLOOR_CLEARANCE,
	GRAVITY,
	computeCenterOfMass,
	markerHeights,
	markerPositions,
	plantedFloor,
	heightsAirborne,
	frameAirborne,
	detectAirborneSpans,
	detectGroundContactSpans,
	fitBallistic,
	autoPhysicsRange,
} from "../../src/ardy/auto-physics.js";

let failures = 0;
function check(name, cond, detail = "") {
	if (cond) console.log(`PASS ${name}`);
	else {
		failures += 1;
		console.log(`FAIL ${name}${detail ? " — " + detail : ""}`);
	}
}

/* Synthetic Mixamo-spelled rig in a T-pose: arms along ±X, legs along -Y,
 * toes forward (+Z). Rig scaled 0.01 (cm → m). Same layout as
 * test/ik/verify-ik.mjs. With the hips at world height Y the foot markers sit
 * at Y − 0.90 (ankles) and Y − 0.95 (toe bases). */
function makeRig() {
	const rig = new THREE.Object3D();
	rig.scale.setScalar(0.01);
	const mk = (name, parent, x, y, z) => {
		const b = new THREE.Bone();
		b.name = name;
		b.position.set(x, y, z);
		parent.add(b);
		return b;
	};
	const hips = mk("mixamorigHips", rig, 0, 100, 0);
	const spine = mk("mixamorigSpine", hips, 0, 15, 0);
	const chest = mk("mixamorigSpine1", spine, 0, 15, 0);
	mk("mixamorigSpine2", chest, 0, 15, 0);
	const neck = mk("mixamorigNeck", chest, 0, 30, 0);
	const head = mk("mixamorigHead", neck, 0, 15, 0);
	mk("mixamorigHeadTop_End", head, 0, 20, 0);
	const lShoulder = mk("mixamorigLeftShoulder", chest, 10, 25, 0);
	const rShoulder = mk("mixamorigRightShoulder", chest, -10, 25, 0);
	const lArm = mk("mixamorigLeftArm", lShoulder, 10, -10, 0);
	const lFore = mk("mixamorigLeftForeArm", lArm, 30, 0, 0);
	mk("mixamorigLeftHand", lFore, 30, 0, 0);
	const rArm = mk("mixamorigRightArm", rShoulder, -10, -10, 0);
	const rFore = mk("mixamorigRightForeArm", rArm, -30, 0, 0);
	mk("mixamorigRightHand", rFore, -30, 0, 0);
	const lUp = mk("mixamorigLeftUpLeg", hips, 10, 0, 0);
	const lLeg = mk("mixamorigLeftLeg", lUp, 0, -45, 0);
	const lFoot = mk("mixamorigLeftFoot", lLeg, 0, -45, 0);
	mk("mixamorigLeftToeBase", lFoot, 0, -5, 12);
	const rUp = mk("mixamorigRightUpLeg", hips, -10, 0, 0);
	const rLeg = mk("mixamorigRightLeg", rUp, 0, -45, 0);
	const rFoot = mk("mixamorigRightFoot", rLeg, 0, -45, 0);
	mk("mixamorigRightToeBase", rFoot, 0, -5, 12);
	rig.updateMatrixWorld(true);
	return rig;
}

const FPS = 30;

/* A fast low transition between two stance phases must split the contact.
 * Treating the whole low run as one unit used to reject both real plants. */
{
	const positions = Array.from({ length: 30 }, (_, frame) => {
		const x = frame < 10 ? 0 : frame < 20 ? (frame - 9) * 0.02 : 0.2;
		const point = (offset = 0) => new THREE.Vector3(x + offset, 0, 0);
		return {
			mixamorigLeftFoot: point(), mixamorigLeftToeBase: point(0.05),
			mixamorigRightFoot: point(), mixamorigRightToeBase: point(0.05),
		};
	});
	const planted = Object.fromEntries(FOOT_MARKERS.map((name) => [name, 0]));
	const contacts = detectGroundContactSpans({ positions, planted, fps: FPS });
	check("a fast low step is split into the plants on either side",
		contacts.spans.length === 4 && contacts.rejected.length === 0,
		JSON.stringify(contacts));
	check("the horizontal contact-speed gate is stricter than a walking foot",
		GROUND_CONTACT_HORIZONTAL_SPEED < 0.2);
}
/* App.jsx blends IK corrections back into the clip over this many frames
 * outside the keyed range; the fake playback below mirrors it exactly. */
const BLEND = 6;

/**
 * Fake clip: `heights[frame]` is the hips' WORLD height in metres and the
 * optional `leans[frame]` its pitch in radians. The rig is scaled 0.01, so
 * the bone-local Y is 100× the world height. Nothing else animates, which is
 * exactly what the pass needs to be tested against: with a rigid pose the CoM
 * sits at a fixed offset from the hips, so a parabolic CoM and a parabolic
 * hips track are the same claim.
 */
function makeClip(rig, heights, leans = null, xs = null) {
	const hips = rig.getObjectByName("mixamorigHips");
	return (frame) => {
		const index = Math.max(0, Math.min(frame, heights.length - 1));
		// A real motion frame rewrites every joint. Reset the synthetic clip too,
		// otherwise a temporarily silenced IK layer leaves yesterday's leg pose
		// on the rig and the next frame is not a raw clip sample at all.
		rig.traverse((node) => { if (node.isBone) node.quaternion.identity(); });
		hips.position.set((xs?.[index] ?? 0) * 100, heights[index] * 100, 0);
		hips.rotation.x = leans ? leans[index] : 0;
		rig.updateMatrixWorld(true);
	};
}

/** A rig + IK state + `run()` that can be invoked repeatedly, so idempotence
 * is testable against ONE accumulated key layer. */
function makeDriver(heights, { leans = null, xs = null, ...options } = {}) {
	const rig = makeRig();
	const { chains, fkJoints } = resolveIkRig(rig);
	const ik = createIkState();
	ik.chains = chains;
	ik.fkJoints = fkJoints;
	const pose = makeClip(rig, heights, leans, xs);
	const applyFrame = (frame) => {
		pose(frame);
		ikEvaluate(chains, ik, frame, fkJoints, BLEND);
	};
	const run = () => autoPhysicsRange({
		rig,
		chains,
		fkJoints,
		ikState: ik,
		applyFrame,
		motion: { frames: heights.length },
		fps: FPS,
		...options,
	});
	return { rig, chains, fkJoints, ik, pose, applyFrame, run };
}

/** CoM of every frame of a clip with NO key layer at all — the pristine
 * reference a pinned or out-of-blend frame must still reproduce exactly. */
function pristineCom(heights, leans = null) {
	const rig = makeRig();
	const pose = makeClip(rig, heights, leans);
	return heights.map((_, frame) => {
		pose(frame);
		return computeCenterOfMass(rig);
	});
}

/* --- mass table ----------------------------------------------------------- */
{
	const total = SEGMENT_MASSES.reduce((sum, segment) => sum + segment.mass, 0);
	check("Dempster segment fractions sum to 1", Math.abs(total - 1) < 1e-9, `sum=${total}`);
	check("every segment names two Mixamo bones",
		SEGMENT_MASSES.every((s) => /^mixamorig/.test(s.start) && /^mixamorig/.test(s.end)));
	check("both sides are represented",
		SEGMENT_MASSES.filter((s) => s.id.startsWith("left")).length
			=== SEGMENT_MASSES.filter((s) => s.id.startsWith("right")).length);
}

/* --- centre of mass ------------------------------------------------------- */
{
	const rig = makeRig();
	const com = computeCenterOfMass(rig);
	check("CoM resolves on a complete rig", Boolean(com));
	check("CoM sits inside the body's vertical extent", com.y > 0.6 && com.y < 1.3, `y=${com?.y}`);
	check("CoM is centred left/right on a symmetric T-pose", Math.abs(com.x) < 1e-9, `x=${com?.x}`);
	// A rigid root translation must move the CoM by exactly the same vector —
	// the identity the whole correction rests on.
	const hips = rig.getObjectByName("mixamorigHips");
	hips.position.y += 37;
	rig.updateMatrixWorld(true);
	const moved = computeCenterOfMass(rig);
	check("a rigid root lift moves the CoM by exactly the same amount",
		Math.abs(moved.y - com.y - 0.37) < 1e-9, `delta=${moved.y - com.y}`);

	const broken = makeRig();
	broken.getObjectByName("mixamorigLeftForeArm").removeFromParent();
	check("a rig missing a segment bone reports no CoM", computeCenterOfMass(broken) === null);
	check("a null rig reports no CoM", computeCenterOfMass(null) === null);
}

/* --- clip-relative ground -------------------------------------------------- */
{
	const rig = makeRig();
	const pose = makeClip(rig, [0.9, 1.4]);
	pose(0);
	const standing = markerHeights(rig);
	check("marker heights cover both ankles and both toes",
		FOOT_MARKERS.every((name) => Number.isFinite(standing[name])) && FOOT_MARKERS.length === 4);
	check("a rig missing a toe marker reports no heights", (() => {
		const broken = makeRig();
		broken.getObjectByName("mixamorigRightToeBase").removeFromParent();
		return markerHeights(broken) === null;
	})());

	pose(1);
	const lifted = markerHeights(rig);
	const planted = plantedFloor([standing, lifted]);
	check("the planted floor is each marker's clip minimum",
		FOOT_MARKERS.every((name) => Math.abs(planted[name] - standing[name]) < 1e-12), JSON.stringify(planted));
	pose(0);
	check("a frame at the planted floor is not airborne", !frameAirborne(rig, planted));
	pose(1);
	check("a frame half a metre up is airborne", frameAirborne(rig, planted));
	// One low toe is enough to keep the frame grounded.
	rig.getObjectByName("mixamorigLeftToeBase").position.set(0, -55, 12);
	rig.updateMatrixWorld(true);
	check("one low toe keeps the frame grounded", !frameAirborne(rig, planted));
	check("a missing planted floor is never airborne", !frameAirborne(rig, null));
	check("plantedFloor of nothing is null", plantedFloor([]) === null);
	check("the lift threshold is a real clearance", AIRBORNE_LIFT >= 0.05 && AIRBORNE_LIFT <= 0.1);
}

/* --- REGRESSION: sole float must not read as flight ------------------------ */
/* The rig rests with its soles ABOVE y = 0 — measured on real characters at
 * +2.5 cm, ankles at +12 cm, toe bases at +4 cm. The first version compared
 * those absolute heights against floorY + a measured mesh drop + a 2 cm
 * margin and declared a STANDING character airborne for the whole clip, then
 * "corrected" it three and a half metres into the ground. The planted floor
 * is now read from the clip, so a clip that never leaves the ground has no
 * spans no matter how high off y = 0 it stands. */
{
	// Hips at 1.00 puts the ankles at 0.10 and the toe bases at 0.05 — over
	// the old absolute thresholds (ankle 0.07, toe 0.04) on every frame.
	const heights = [];
	for (let frame = 0; frame < 24; frame += 1) heights.push(1.0 + 0.01 * Math.sin(frame * 1.7));
	const driver = makeDriver(heights);
	driver.pose(0);
	const standing = markerHeights(driver.rig);
	check("the standing rig floats above the old absolute thresholds",
		standing.mixamorigLeftFoot > 0.07 && standing.mixamorigLeftToeBase > 0.04,
		`ankle=${standing.mixamorigLeftFoot} toe=${standing.mixamorigLeftToeBase}`);

	const result = driver.run();
	check("a standing clip with floating soles has no airborne spans",
		result.spans.length === 0, JSON.stringify(result.spans));
	check("a standing clip with floating soles is never keyed",
		result.keyedFrames.length === 0 && result.pinnedFrames.length === 0 && ikKeyframes(driver.ik).length === 0);
	check("a standing clip reports zero correction", result.maxCorrection === 0);
	check("the planted floor was measured from the clip",
		Math.abs(result.planted.mixamorigLeftToeBase - (Math.min(...heights) - 0.95)) < 1e-9,
		JSON.stringify(result.planted));
}

/* --- REGRESSION: the rule against heights measured off a real character ---- */
/* Browser QA on a generated clip reported these exact numbers. The absolute
 * thresholds the first version used (ankle floorY + 0.105 + 0.02 = 0.125, toe
 * floorY + 0.02 + 0.02 = 0.04) classified the STANDING frame as airborne on
 * all four markers; the clip-relative rule rejects it while still accepting
 * the genuine flight from the same clip. */
{
	const PLANTED = {
		mixamorigLeftFoot: 0.123, mixamorigRightFoot: 0.118,
		mixamorigLeftToeBase: 0.041, mixamorigRightToeBase: 0.039,
	};
	const STANDING = {
		mixamorigLeftFoot: 0.132, mixamorigRightFoot: 0.130,
		mixamorigLeftToeBase: 0.059, mixamorigRightToeBase: 0.059,
	};
	// Apex of the genuine flight phase QA confirmed the pass handled well.
	const FLIGHT = {
		mixamorigLeftFoot: 0.964, mixamorigRightFoot: 0.980,
		mixamorigLeftToeBase: 0.910, mixamorigRightToeBase: 0.925,
	};
	check("the QA standing frame cleared every OLD absolute threshold",
		STANDING.mixamorigLeftFoot > 0.125 && STANDING.mixamorigRightFoot > 0.125
			&& STANDING.mixamorigLeftToeBase > 0.04 && STANDING.mixamorigRightToeBase > 0.04);
	check("the measured standing frame is grounded under the clip-relative rule",
		!heightsAirborne(STANDING, PLANTED));
	check("the measured flight frame is still airborne", heightsAirborne(FLIGHT, PLANTED));
	check("a marker exactly at its planted height is grounded",
		!heightsAirborne(PLANTED, PLANTED));
}

/* --- span grouping -------------------------------------------------------- */
{
	const flags = [false, false, true, true, true, true, false, true, false, true, true, true, true, true, false];
	const spans = detectAirborneSpans({ frames: flags.length, isAirborne: flags });
	check("contiguous spans are grouped with inclusive bounds",
		spans.length === 2 && spans[0].start === 2 && spans[0].end === 5 && spans[1].start === 9 && spans[1].end === 13,
		JSON.stringify(spans));
	check("a one-frame blip is rejected as noise", !spans.some((s) => s.start === 7));
	check("spans report their length", spans[0].length === 4 && spans[1].length === 5);
	check("the minimum span length is at least 4 frames", MIN_AIRBORNE_FRAMES >= 4);

	const trailing = detectAirborneSpans({ frames: 5, isAirborne: [false, true, true, true, true] });
	check("a span running to the last frame still closes",
		trailing.length === 1 && trailing[0].start === 1 && trailing[0].end === 4, JSON.stringify(trailing));

	const offset = detectAirborneSpans({ frames: 6, isAirborne: (frame) => frame >= 12, startFrame: 10 });
	check("a predicate + startFrame yields absolute frame numbers",
		offset.length === 1 && offset[0].start === 12 && offset[0].end === 15, JSON.stringify(offset));
}

/* --- fitBallistic (vertical only) ------------------------------------------ */
{
	const y0 = 1.2;
	const v0 = 3;
	const exact = [];
	for (let index = 0; index < 20; index += 1) {
		const t = index / FPS;
		exact.push(new THREE.Vector3(0.4 + 1.5 * t, y0 + v0 * t - 0.5 * GRAVITY * t * t, -0.2 - 0.8 * t));
	}
	const clean = fitBallistic(exact, FPS);
	check("exact parabola recovers y0", Math.abs(clean.y0 - y0) < 1e-9, `y0=${clean.y0}`);
	check("exact parabola recovers v0", Math.abs(clean.v0 - v0) < 1e-9, `v0=${clean.v0}`);
	check("exact parabola has no residual", clean.residual < 1e-12, `residual=${clean.residual}`);
	check("fitted positions come back per frame", clean.positions.length === exact.length);
	check("gravity is fixed, not fitted", clean.g === GRAVITY);
	// The lateral track is read-only: fitting it turned a mis-detected span
	// into metres of sideways displacement on real clips.
	check("the fit leaves x and z exactly as sampled",
		clean.positions.every((p, i) => p.x === exact[i].x && p.z === exact[i].z));
	check("a wandering lateral track is not straightened", (() => {
		const wobbly = exact.map((s, i) => s.clone().setX(s.x + 0.3 * Math.sin(i)).setZ(s.z - 0.2 * Math.cos(i)));
		const fit = fitBallistic(wobbly, FPS);
		return fit.positions.every((p, i) => p.x === wobbly[i].x && p.z === wobbly[i].z);
	})());

	// Same parabola with deterministic ±3 mm noise: least squares must still
	// land on the launch state.
	const noisy = exact.map((sample, index) => sample.clone().setY(sample.y + 0.003 * Math.sin(index * 2.399963)));
	const fit = fitBallistic(noisy, FPS);
	check("noisy parabola recovers y0 within a few mm", Math.abs(fit.y0 - y0) < 0.005, `y0=${fit.y0}`);
	check("noisy parabola recovers v0 within 0.05 m/s", Math.abs(fit.v0 - v0) < 0.05, `v0=${fit.v0}`);

	// A hover cannot be explained away: forcing g means the fit refuses to
	// flatten and reports a large residual instead.
	const hover = exact.map((sample, index) => sample.clone().setY(index < 10 ? sample.y : exact[9].y));
	check("a hovering track leaves a large residual", fitBallistic(hover, FPS).residual > 0.05,
		`residual=${fitBallistic(hover, FPS).residual}`);

	check("an empty sample list is harmless", fitBallistic([], FPS).positions.length === 0);
	check("a single sample fits itself",
		Math.abs(fitBallistic([new THREE.Vector3(0, 1.4, 0)], FPS).y0 - 1.4) < 1e-12);
}

/* --- the driver: a floaty jump becomes ballistic --------------------------- */

/* Grounded lead-in, then a deliberately UNPHYSICAL flight — linear rise, four
 * frames of hover at the apex, linear fall — then a grounded lead-out. This is
 * the classic generated-motion artefact the pass exists to remove. */
const FLOATY = [
	0.90, 0.90, 0.90, 0.90,
	1.10, 1.25, 1.40, 1.55,
	1.55, 1.55, 1.55, 1.55,
	1.40, 1.25, 1.10, 1.05,
	0.90, 0.90, 0.90, 0.90,
];
const SPAN_START = 4;
const SPAN_END = 15;

{
	const driver = makeDriver(FLOATY);
	const result = driver.run();
	check("the airborne span is detected with the right bounds",
		result.spans.length === 1 && result.spans[0].start === SPAN_START && result.spans[0].end === SPAN_END,
		JSON.stringify(result.spans));
	check("the floaty span was corrected", result.keyedFrames.length > 0);
	check("every correction lands inside the airborne span",
		result.keyedFrames.every((frame) => frame >= SPAN_START && frame <= SPAN_END),
		`keyed=${result.keyedFrames.join(",")}`);
	check("the whole span is corrected",
		result.keyedFrames.length === SPAN_END - SPAN_START + 1, `keyed=${result.keyedFrames.length}`);
	check("no span was refused", result.skippedSpans.length === 0, JSON.stringify(result.skippedSpans));
	check("maxCorrection is positive and sane",
		result.maxCorrection > 0.01 && result.maxCorrection < MAX_CORRECTION, `max=${result.maxCorrection}`);
	check("grounded frames outside the pinned boundary are never keyed",
		[0, 1, 2, 17, 18, 19].every((frame) => !ikKeyframes(driver.ik).includes(frame)),
		`keys=${ikKeyframes(driver.ik).join(",")}`);

	// Replay the clip through the key layer and re-measure: the corrected CoM
	// must now sit on a parabola with real gravity.
	const after = [];
	for (let frame = SPAN_START; frame <= SPAN_END; frame += 1) {
		driver.applyFrame(frame);
		after.push(computeCenterOfMass(driver.rig));
	}
	// The physics claim lives in the FULL-WEIGHT core; the first and last
	// EDGE_TAPER frames deliberately keep a share of the clip so the correction
	// does not step onto it. Re-fitting the core reproduces the module's own
	// curve, so `fit.positions` is the arc every frame was aimed at.
	const fit = fitBallistic(after, FPS, GRAVITY, { fitFrom: EDGE_TAPER, fitTo: after.length - 1 - EDGE_TAPER });
	const core = after.slice(EDGE_TAPER, after.length - EDGE_TAPER);
	check("the corrected CoM traces a true parabola across its core",
		fit.residual < 1e-9, `residual=${fit.residual}`);
	check("the corrected flight still rises and falls",
		fit.v0 > 0 && after[6].y > after[0].y && after[11].y < after[6].y, `v0=${fit.v0}`);
	// A hover no longer exists: consecutive vertical steps must strictly
	// decrease, which is what constant gravity means frame to frame.
	const steps = core.slice(1).map((sample, index) => sample.y - core[index].y);
	check("the mid-air hover is gone (velocity falls every frame)",
		steps.every((step, index) => index === 0 || step < steps[index - 1] + 1e-9),
		steps.map((s) => s.toFixed(4)).join(" "));
	// The take-off and landing samples ANCHOR the parabola, so the pass leaves
	// them exactly where the clip put them: the hand-off to the grounded pin
	// beside them is seamless by construction, not merely by tapering.
	const clipCom = pristineCom(FLOATY);
	const anchors = [0, after.length - 1];
	check("the arc's anchor frames are left exactly on the clip",
		anchors.every((index) => Math.abs(after[index].y - clipCom[SPAN_START + index].y) < 1e-9),
		anchors.map((i) => (after[i].y - clipCom[SPAN_START + i].y).toExponential(2)).join(" "));
	// The frames just inside them are tapered: strictly between clip and curve.
	const tapered = [1, after.length - 2];
	check("the tapered frames ease between the clip and the fitted arc",
		tapered.every((index) => {
			const clip = clipCom[SPAN_START + index].y;
			const target = fit.positions[index].y;
			const value = after[index].y;
			return Math.abs(value - clip) > 1e-9 && Math.abs(value - target) > 1e-9
				&& value > Math.min(clip, target) && value < Math.max(clip, target);
		}),
		tapered.map((i) => (after[i].y - clipCom[SPAN_START + i].y).toFixed(4)).join(" "));
	// The correction is vertical only — x and z must be untouched.
	const pristine = pristineCom(FLOATY);
	check("no horizontal displacement is introduced",
		after.every((sample, index) => Math.abs(sample.x - pristine[SPAN_START + index].x) < 1e-12
			&& Math.abs(sample.z - pristine[SPAN_START + index].z) < 1e-12));

	check("the original clip really was non-ballistic",
		fitBallistic(FLOATY.slice(SPAN_START, SPAN_END + 1).map((y) => new THREE.Vector3(0, y, 0)), FPS).residual > 0.02);
}

/* --- REGRESSION: boundary pins hold the grounded neighbours ---------------- */
/* ikEvaluate evaluates the whole keyed range at full weight and eases out
 * over a blend window, so a span keyed on its own dragged the frames around
 * it with it — a grounded frame moved 3.1 m on the QA clip. Zero-delta pins
 * either side anchor the blend on the clip's own pose. */
{
	const heights = [...FLOATY.slice(0, 16)];
	const leans = new Array(16).fill(0);
	// Grounded lead-out at a constant height but a changing lean, so "did the
	// pass move this frame?" is a question with a non-trivial answer.
	for (let index = 0; index < 10; index += 1) {
		heights.push(0.90);
		leans.push(Math.min(0.2, 0.05 * index));
	}
	const pristine = pristineCom(heights, leans);
	const driver = makeDriver(heights, { leans });
	const result = driver.run();
	check("the leaning lead-out does not disturb span detection",
		result.spans.length === 1 && result.spans[0].start === SPAN_START && result.spans[0].end === SPAN_END,
		JSON.stringify(result.spans));
	check("boundary pins sit either side of the span",
		result.pinnedFrames.join(",") === `${SPAN_START - 1},${SPAN_END + 1}`,
		`pins=${result.pinnedFrames.join(",")}`);

	const comAt = (frame) => {
		driver.applyFrame(frame);
		return computeCenterOfMass(driver.rig);
	};
	check("the pins carry zero delta (the clip's own pose)",
		result.pinnedFrames.every((frame) => comAt(frame).distanceTo(pristine[frame]) < 1e-9),
		result.pinnedFrames.map((f) => comAt(f).distanceTo(pristine[f])).join(" "));
	// Frames past the blend window must be bit-identical to the clip.
	const outside = [22, 23, 24, 25];
	check("grounded frames beyond the blend window do not move",
		outside.every((frame) => comAt(frame).distanceTo(pristine[frame]) < 1e-9),
		outside.map((f) => comAt(f).distanceTo(pristine[f]).toFixed(6)).join(" "));
	/* REGRESSION (defect 3): the pass writes the hips POSITION and nothing else.
	 * Keys used to bake the hips ROTATION too, and ikEvaluate slerped that
	 * absolute orientation into every neighbour inside the blend window —
	 * 8.8 mm of CoM and 1.2 cm of foot drop on grounded frames the feature
	 * never meant to touch. The lead-out below leans from 0 to 0.2 rad, so a
	 * rotation key at frame 16 (lean 0) WOULD visibly straighten them. */
	const inWindow = [17, 18, 19, 20, 21];
	check("the lead-out really does rotate away from the pin (not vacuous)",
		Math.abs(leans[20] - leans[16]) > 0.1, `${leans[16]} → ${leans[20]}`);
	const hipsBone = driver.rig.getObjectByName("mixamorigHips");
	const pristineRig = makeRig();
	const pristinePose = makeClip(pristineRig, heights, leans);
	const pristineHips = pristineRig.getObjectByName("mixamorigHips");
	// Compared component-wise, not with angleTo: acos near identity turns a
	// 1e-16 component difference into a 1e-8 "angle" and hides nothing useful.
	check("grounded frames inside the blend window keep the clip's rotation",
		inWindow.every((frame) => {
			driver.applyFrame(frame);
			pristinePose(frame);
			return ["x", "y", "z", "w"].every((axis) =>
				Math.abs(hipsBone.quaternion[axis] - pristineHips.quaternion[axis]) < 1e-12);
		}));
	const drift = inWindow.map((frame) => comAt(frame).distanceTo(pristine[frame]));
	check("grounded neighbours drift by well under a millimetre",
		drift.every((value) => value < 0.001), drift.map((v) => v.toFixed(6)).join(" "));
}

/* --- REGRESSION: a garbage span is refused, not "corrected" ---------------- */
/* On the QA clip a 52-frame stretch of ordinary walking was misread as one
 * flight phase; its fit had a 165 cm RMS and the pass happily applied 3.5 m
 * of correction, burying the character. A fit that far off is evidence the
 * span is wrong, so it is reported and skipped. */
/* A steady 28-frame rise is the shape a long mis-detection actually takes: it
 * holds no trough for the splitter to cut at, so it reaches the fitter intact,
 * and no parabola under real gravity can stay near a straight line for over a
 * second. Deliberately NOT oscillating noise — that would be split into short
 * arcs and rejected for length, which proves nothing about the sanity gate. */
{
	const heights = [0.90, 0.90, 0.90, 0.90];
	for (let index = 0; index < 40; index += 1) heights.push(1.0 + 0.03 * index);
	heights.push(0.90, 0.90, 0.90, 0.90);
	const driver = makeDriver(heights);
	const result = driver.run();
	check("the garbage stretch is still detected as one arc",
		result.spans.length === 1 && result.spans[0].start === 4 && result.spans[0].end === 43,
		JSON.stringify(result.spans));
	check("the garbage span is refused", result.skippedSpans.length === 1, JSON.stringify(result.skippedSpans));
	check("the refusal names a reason",
		["correction-too-large", "fit-too-poor"].includes(result.skippedSpans[0]?.reason),
		result.skippedSpans[0]?.reason);
	check("a refused span writes no keys at all",
		result.keyedFrames.length === 0 && result.pinnedFrames.length === 0 && ikKeyframes(driver.ik).length === 0);
	check("a refused span reports no correction", result.maxCorrection === 0);
}

/* --- REGRESSION: the floor guard clamps a burying correction --------------- */
/* A flight that ends low leaves the fitted parabola well below the clip, and
 * following it exactly would push the feet through the floor. The applied ΔY
 * is clamped so the lowest marker keeps FLOOR_CLEARANCE. */
{
	const heights = [
		0.90, 0.90, 0.90, 0.90,
		1.30, 1.60, 1.70, 1.60, 1.30, 1.05,
		1.00, 1.00, 1.00, 1.00, 1.00, 1.00,
		0.90, 0.90, 0.90, 0.90,
	];
	const driver = makeDriver(heights);
	const result = driver.run();
	check("the low-landing span is corrected", result.keyedFrames.length === 12 && result.skippedSpans.length === 0,
		`keyed=${result.keyedFrames.length} skipped=${JSON.stringify(result.skippedSpans)}`);

	let lowest = Infinity;
	const after = [];
	for (const frame of result.keyedFrames) {
		driver.applyFrame(frame);
		const marks = markerHeights(driver.rig);
		lowest = Math.min(lowest, ...FOOT_MARKERS.map((name) => marks[name]));
		after.push(computeCenterOfMass(driver.rig));
	}
	check("no corrected frame puts a foot below the floor clearance",
		lowest >= FLOOR_CLEARANCE - 1e-9, `lowest=${lowest}`);
	// If nothing had been clamped the corrected arc would be an exact
	// parabola; a non-zero residual is the proof the guard overrode the fit.
	check("the guard overrode the fit where it had to",
		fitBallistic(after, FPS).residual > 0.01, `residual=${fitBallistic(after, FPS).residual}`);
	check("the clamped correction stays under the limit",
		result.maxCorrection > 0 && result.maxCorrection <= MAX_CORRECTION, `max=${result.maxCorrection}`);
}

/* --- arc surgery: hysteresis, trough splitting, edge taper ----------------- */
{
	const spans = [{ start: 10, end: 20, length: 11 }, { start: 30, end: 40, length: 11 }];
	const canExtend = new Array(50).fill(false);
	for (let frame = 7; frame <= 23; frame += 1) canExtend[frame] = true;
	for (let frame = 27; frame <= 43; frame += 1) canExtend[frame] = true;
	const grown = expandAirborneSpans({ spans, canExtend });
	check("hysteresis grows a span out to the exit threshold",
		grown[0].start === 7 && grown[0].end === 23 && grown[1].start === 27 && grown[1].end === 43,
		JSON.stringify(grown));
	check("expansion cannot reach into the next span", (() => {
		const touching = [{ start: 10, end: 12, length: 3 }, { start: 16, end: 18, length: 3 }];
		const all = new Array(30).fill(true);
		const out = expandAirborneSpans({ spans: touching, canExtend: all });
		return out[0].end < out[1].start && out[0].end === 15 && out[1].start === 16;
	})());
	check("expansion stops at the range ends", (() => {
		const out = expandAirborneSpans({ spans: [{ start: 1, end: 3, length: 3 }], canExtend: new Array(6).fill(true) });
		return out[0].start === 0 && out[0].end === 5;
	})());
	check("nothing to extend leaves spans as they were", (() => {
		const out = expandAirborneSpans({ spans, canExtend: new Array(50).fill(false) });
		return out[0].start === 10 && out[0].end === 20;
	})());

	check("a single arc is not split", splitAtTroughs([1, 1.2, 1.4, 1.3, 1.1]).length === 1);
	check("a shallow ripple is not a split point",
		splitAtTroughs([1, 1.3, 1.28, 1.3, 1.1]).length === 1, JSON.stringify(splitAtTroughs([1, 1.3, 1.28, 1.3, 1.1])));
	check("a deep trough splits, and the trough ends the left arc", (() => {
		const out = splitAtTroughs([1.2, 1.5, 1.2, 1.55, 1.25]);
		return out.length === 2 && out[0][0] === 0 && out[0][1] === 2 && out[1][0] === 3 && out[1][1] === 4;
	})(), JSON.stringify(splitAtTroughs([1.2, 1.5, 1.2, 1.55, 1.25])));
	check("splitting recurses into three arcs",
		splitAtTroughs([1.2, 1.5, 1.2, 1.55, 1.2, 1.5, 1.2]).length === 3);
	check("the split depth is respected",
		splitAtTroughs([1.2, 1.3, 1.24, 1.3, 1.2], { splitDepth: 0.02 }).length === 2
			&& splitAtTroughs([1.2, 1.3, 1.24, 1.3, 1.2], { splitDepth: 0.2 }).length === 1);

	check("the taper eases in and out symmetrically", (() => {
		const w = Array.from({ length: 10 }, (_, index) => edgeTaperWeight(index, 10));
		return w[0] < w[1] && w[1] < 1 && w[2] === 1 && w[7] === 1 && w[8] === w[1] && w[9] === w[0];
	})(), Array.from({ length: 10 }, (_, i) => edgeTaperWeight(i, 10).toFixed(3)).join(" "));
	check("the taper never exceeds full strength",
		Array.from({ length: 12 }, (_, index) => edgeTaperWeight(index, 12)).every((w) => w > 0 && w <= 1));
	check("a short arc still gets a ramp that fits inside it",
		edgeTaperWeight(0, 4) < 1 && edgeTaperWeight(1, 4) === 1 && edgeTaperWeight(3, 4) < 1);
	check("a disabled taper is uniform",
		Array.from({ length: 8 }, (_, index) => edgeTaperWeight(index, 8, 0)).every((w) => w === 1));

	check("a fit range excludes the frames it is told to", (() => {
		// A clean parabola with two wild end samples: fitting the core ignores
		// them completely and still recovers the launch state exactly.
		const samples = [];
		for (let index = 0; index < 12; index += 1) {
			const t = index / FPS;
			samples.push(new THREE.Vector3(0, 1.2 + 3 * t - 0.5 * GRAVITY * t * t, 0));
		}
		samples[0].y += 5;
		samples[11].y -= 5;
		const fit = fitBallistic(samples, FPS, GRAVITY, { fitFrom: 1, fitTo: 10 });
		return Math.abs(fit.y0 - 1.2) < 1e-9 && Math.abs(fit.v0 - 3) < 1e-9
			&& fit.residual < 1e-12 && fit.positions.length === 12 && fit.fitFrom === 1 && fit.fitTo === 10;
	})());
}

/* --- REGRESSION (defect 1): two hops in one span become two arcs ----------- */
/* On the QA clip frames 46–71 hold two ballistic arcs with a 1.21 m trough
 * between them, and the feet never plant low enough to break the span. One
 * parabola over both needed 73 cm corrections at a 42 cm RMS, so the sanity
 * gate refused the lot and the clip's only real jump went uncorrected while a
 * 1.1 cm stride wobble elsewhere got "fixed". Splitting at the trough gives
 * each hop its own parabola. */
{
	// One symmetric arc, flattened around the apex — the hover artefact.
	const hop = (launch, frames, flatten) => {
		const duration = (frames - 1) / FPS;
		const v0 = 0.5 * GRAVITY * duration;
		const ys = [];
		for (let index = 0; index < frames; index += 1) {
			const t = index / FPS;
			ys.push(launch + v0 * t - 0.5 * GRAVITY * t * t);
		}
		const mid = Math.floor((frames - 1) / 2);
		for (let index = mid - flatten; index <= mid + flatten; index += 1) {
			if (index >= 0 && index < frames) ys[index] = ys[mid];
		}
		return ys;
	};
	const heights = [0.90, 0.90, 0.90, 0.90, ...hop(1.21, 13, 3), ...hop(1.21, 13, 3), 0.90, 0.90, 0.90, 0.90];
	const pristine = pristineCom(heights);

	const merged = pristine.slice(4, 30);
	check("the trough is deep enough to split on",
		splitAtTroughs(merged.map((sample) => sample.y)).length === 2,
		JSON.stringify(splitAtTroughs(merged.map((s) => s.y))));
	// The old behaviour, shown dead through the real code path: with splitting
	// disabled the merged span reaches the fitter whole, and the sanity gate
	// throws the clip's only jump away exactly as QA measured.
	const unsplit = makeDriver(heights, { splitDepth: 10 }).run();
	check("without splitting, one merged fit is refused outright",
		unsplit.spans.length === 1 && unsplit.skippedSpans.length === 1
			&& unsplit.keyedFrames.length === 0 && unsplit.maxCorrection === 0,
		JSON.stringify(unsplit.skippedSpans));

	const driver = makeDriver(heights);
	const result = driver.run();
	check("the merged span is split into two arcs",
		result.spans.length === 2
			&& result.spans[0].start === 4 && result.spans[0].end === 16
			&& result.spans[1].start === 17 && result.spans[1].end === 29,
		JSON.stringify(result.spans));
	check("neither arc is refused", result.skippedSpans.length === 0, JSON.stringify(result.skippedSpans));
	check("both arcs are corrected",
		result.keyedFrames.length === 26 && result.maxCorrection > 0.01 && result.maxCorrection < MAX_CORRECTION,
		`keyed=${result.keyedFrames.length} max=${result.maxCorrection}`);

	// Each sub-arc's full-weight core must now be a true parabola in its own
	// right — the claim a single merged fit could never make.
	for (const [label, span] of [["first", result.spans[0]], ["second", result.spans[1]]]) {
		const after = [];
		for (let frame = span.start; frame <= span.end; frame += 1) {
			driver.applyFrame(frame);
			after.push(computeCenterOfMass(driver.rig));
		}
		const fit = fitBallistic(after, FPS, GRAVITY, { fitFrom: EDGE_TAPER, fitTo: after.length - 1 - EDGE_TAPER });
		check(`the ${label} hop's core is a true parabola`, fit.residual < 1e-9, `residual=${fit.residual}`);
		check(`the ${label} hop still rises and falls`, fit.v0 > 0);
	}
}

/* --- REGRESSION (defect 2): hysteresis and the edge taper ------------------ */
/* On the QA clip the true flight was frames 20–33, but the 6 cm entry lift cut
 * the span to 21–32; zero pins at 20 and 33 sat one frame from +3.3 cm and
 * +2.8 cm corrections, and the CoM's vertical acceleration snapped from −8.6
 * to −36.5 m/s² in a single frame. The fixture below reproduces the shape: a
 * flight whose first and last frames clear the ground by 4 cm (between the
 * exit and entry thresholds) and whose gravity is 10% too weak — the floating
 * artefact, which needs a correction at every frame including the edges. */
const AP_FPS = 24;
const FLIGHT_FIRST = 6;
const FLIGHT_LAST = 21;
const FLOATY_G = (() => {
	const frames = FLIGHT_LAST - FLIGHT_FIRST + 1;
	const weak = GRAVITY * 0.9;
	const duration = (frames - 1) / AP_FPS;
	const v0 = 0.5 * weak * duration;
	// Stands at 0.96 rather than 0.90 so the synthetic rig's toe bases (0.95
	// below the hips) stay clear of y = 0 for the whole clip: otherwise the
	// floor guard, not the arc, decides the take-off frame's correction and
	// the fixture stops measuring what it claims to.
	const heights = new Array(FLIGHT_FIRST).fill(0.96);
	for (let index = 0; index < frames; index += 1) {
		const t = index / AP_FPS;
		heights.push(1.00 + v0 * t - 0.5 * weak * t * t);
	}
	while (heights.length < 30) heights.push(0.96);
	return heights;
})();

{
	const strict = makeDriver(FLOATY_G, { fps: AP_FPS, exitLift: AIRBORNE_LIFT }).run();
	check("the entry lift alone truncates the real flight",
		strict.spans.length === 1 && strict.spans[0].start === FLIGHT_FIRST + 1 && strict.spans[0].end === FLIGHT_LAST - 1,
		JSON.stringify(strict.spans));

	const driver = makeDriver(FLOATY_G, { fps: AP_FPS });
	const result = driver.run();
	check("hysteresis recovers the take-off and landing frames",
		result.spans.length === 1 && result.spans[0].start === FLIGHT_FIRST && result.spans[0].end === FLIGHT_LAST,
		JSON.stringify(result.spans));
	check("the recovered frames really were below the entry lift", (() => {
		driver.pose(FLIGHT_FIRST);
		const marks = markerHeights(driver.rig);
		const lift = Math.min(...FOOT_MARKERS.map((name) => marks[name] - result.planted[name]));
		return lift > EXIT_LIFT && lift < AIRBORNE_LIFT;
	})());

	const sample = (from, to) => {
		const out = [];
		for (let frame = from; frame <= to; frame += 1) {
			driver.applyFrame(frame);
			out.push(computeCenterOfMass(driver.rig));
		}
		return out;
	};
	const after = sample(FLIGHT_FIRST, FLIGHT_LAST);
	const before = pristineCom(FLOATY_G).slice(FLIGHT_FIRST, FLIGHT_LAST + 1);

	// (iii) The honest window is the true flight, which is also the window the
	// module chose — that is the point of the hysteresis fix.
	const beforeFit = fitBallistic(before, AP_FPS);
	const afterFit = fitBallistic(after, AP_FPS);
	check("the flight window's ballistic residual improves substantially",
		afterFit.residual < beforeFit.residual * 0.5,
		`before=${(beforeFit.residual * 100).toFixed(2)}cm after=${(afterFit.residual * 100).toFixed(2)}cm`);
	check("the corrected flight recovers real gravity in its core",
		fitBallistic(after, AP_FPS, GRAVITY, { fitFrom: EDGE_TAPER, fitTo: after.length - 1 - EDGE_TAPER }).residual < 1e-9);

	// (ii) No one-frame acceleration spike. Second differences of the CoM
	// height ARE its vertical acceleration (times 1/fps²), and in the corrected
	// core they must equal g exactly.
	const secondDiff = (values) => values.slice(0, -2)
		.map((_, index) => values[index + 2] - 2 * values[index + 1] + values[index]);
	const g24 = GRAVITY / (AP_FPS * AP_FPS);
	const coreAccel = secondDiff(after.map((sample) => sample.y)).slice(EDGE_TAPER, -EDGE_TAPER);
	check("the corrected core accelerates at exactly g",
		coreAccel.every((value) => Math.abs(Math.abs(value) - g24) < 1e-9),
		coreAccel.map((v) => (v * AP_FPS * AP_FPS).toFixed(3)).join(" "));

	// The spike QA measured was the PASS's own step: a zero pin beside a
	// full-strength correction. The clip's own take-off is a discontinuity too
	// and is none of this feature's business, so what is measured here is the
	// acceleration of the CORRECTION ITSELF across the pins and the whole arc.
	// It must stay under one g — the pass may not shove harder than gravity.
	const window = sample(FLIGHT_FIRST - 1, FLIGHT_LAST + 1);
	const clip = pristineCom(FLOATY_G).slice(FLIGHT_FIRST - 1, FLIGHT_LAST + 2);
	const correction = window.map((com, index) => com.y - clip[index].y);
	check("the pins really do sit at zero correction",
		Math.abs(correction[0]) < 1e-9 && Math.abs(correction[correction.length - 1]) < 1e-9);
	const spike = Math.max(...secondDiff(correction).map(Math.abs));
	check("the correction never accelerates harder than gravity",
		spike <= g24, `${(spike * AP_FPS * AP_FPS).toFixed(2)} vs ${GRAVITY} m/s²`);

	// The same measurement for the design that produced the QA spike: a
	// least-squares fit over the whole arc, applied at full strength. Its
	// correction is LARGEST at the arc ends, so it steps straight off the pin.
	const lsFit = fitBallistic(before, AP_FPS);
	const lsCorrection = [0, ...lsFit.positions.map((fitted, index) => fitted.y - before[index].y), 0];
	const lsSpike = Math.max(...secondDiff(lsCorrection).map(Math.abs));
	check("an unanchored full-strength correction really would snap",
		lsSpike > 2 * g24, `${(lsSpike * AP_FPS * AP_FPS).toFixed(2)} m/s²`);
	check("anchoring plus the taper removes most of that spike",
		spike < lsSpike / 3, `${(spike * AP_FPS * AP_FPS).toFixed(2)} vs ${(lsSpike * AP_FPS * AP_FPS).toFixed(2)} m/s²`);
}

/* --- REGRESSION: running twice changes nothing the second time ------------- */
/* The first version re-measured its own blended output, so a second button
 * press keyed 12 more frames and grew the correction from 10 cm to 55 cm.
 * Sweep 2 now resets the hips to the sweep-1 transform before every write, so
 * a corrected clip is a fixed point. */
{
	const driver = makeDriver(FLOATY);
	const first = driver.run();
	const keysAfterFirst = ikKeyframes(driver.ik).join(",");
	const second = driver.run();
	check("the first run corrected the clip", first.keyedFrames.length > 0 && first.maxCorrection > 0.01);
	check("a second run keys nothing new", second.keyedFrames.length === 0 && second.pinnedFrames.length === 0,
		`keyed=${second.keyedFrames.join(",")} pins=${second.pinnedFrames.join(",")}`);
	check("a second run reports zero correction", second.maxCorrection === 0, `max=${second.maxCorrection}`);
	check("the key set is identical after the second run",
		ikKeyframes(driver.ik).join(",") === keysAfterFirst,
		`before=${keysAfterFirst} after=${ikKeyframes(driver.ik).join(",")}`);
	check("the span survives a second detection pass",
		second.spans.length === 1 && second.spans[0].start === SPAN_START && second.spans[0].end === SPAN_END,
		JSON.stringify(second.spans));

	// The corrected clip is still ballistic after the no-op run.
	const after = [];
	for (let frame = SPAN_START; frame <= SPAN_END; frame += 1) {
		driver.applyFrame(frame);
		after.push(computeCenterOfMass(driver.rig));
	}
	check("the corrected arc is unchanged by the second run",
		fitBallistic(after, FPS, GRAVITY, { fitFrom: EDGE_TAPER, fitTo: after.length - 1 - EDGE_TAPER }).residual < 1e-9);
}

/* --- idempotence on an already-ballistic clip ------------------------------ */
{
	// Twelve airborne frames whose height is exactly y0 + v0·t − ½·g·t², with
	// v0 chosen so the arc lands back at its launch height on the last frame.
	const flight = 11 / FPS;
	const v0 = 0.5 * GRAVITY * flight;
	const heights = [0.9, 0.9, 0.9, 0.9];
	for (let index = 0; index < 12; index += 1) {
		const t = index / FPS;
		heights.push(1.05 + v0 * t - 0.5 * GRAVITY * t * t);
	}
	heights.push(0.9, 0.9, 0.9, 0.9);

	const driver = makeDriver(heights);
	const result = driver.run();
	check("an already-ballistic span is still detected",
		result.spans.length === 1 && result.spans[0].start === SPAN_START && result.spans[0].end === SPAN_END,
		JSON.stringify(result.spans));
	check("an already-ballistic clip gets zero keys",
		result.keyedFrames.length === 0 && result.pinnedFrames.length === 0, `keyed=${result.keyedFrames.join(",")}`);
	check("an already-ballistic clip reports no correction", result.maxCorrection === 0);
	check("an already-ballistic clip leaves the IK layer empty", ikKeyframes(driver.ik).length === 0);
}

/* --- a fully grounded clip is never touched ------------------------------- */
{
	const driver = makeDriver(new Array(20).fill(0.9));
	const result = driver.run();
	check("a grounded clip has no airborne spans", result.spans.length === 0);
	check("a grounded clip gets no keys",
		result.keyedFrames.length === 0 && ikKeyframes(driver.ik).length === 0);
}

/* --- AutoPhysics v2: safe grounded contact + foot lock -------------------- */
{
	const frames = 24;
	const heights = new Array(frames).fill(0.96); // toe bases clear y=0 by 1 cm
	const xs = Array.from({ length: frames }, (_, frame) => 0.03 * frame / (frames - 1));
	const probe = makeDriver(heights, { xs });
	const positions = [];
	const perFrameHeights = [];
	for (let frame = 0; frame < frames; frame += 1) {
		probe.pose(frame);
		positions.push(markerPositions(probe.rig));
		perFrameHeights.push(markerHeights(probe.rig));
	}
	const contacts = detectGroundContactSpans({ positions, planted: plantedFloor(perFrameHeights), fps: FPS });
	check("a low settled three-centimetre drift is accepted as two planted feet",
		contacts.spans.length === 2 && contacts.rejected.length === 0, JSON.stringify(contacts));
	check("the accepted contact stays inside the three-centimetre safety pull",
		contacts.spans.every((span) => span.maxPull <= GROUND_LOCK_MAX_PULL));
	check("the straight-leg retry cannot lift a foot more than five millimetres",
		GROUND_LOCK_REACH_LIFT <= 0.005);

	const driver = makeDriver(heights, { xs, grounding: true });
	const result = driver.run();
	check("ground AutoPhysics keys the drifting stance",
		result.groundedKeyedFrames.length > 0 && result.groundContactSpans.length === 2,
		`contacts=${result.groundContactSpans.length} keys=${result.groundedKeyedFrames.length}`);
	check("the planted-foot slide is reduced below five millimetres",
		result.maxFootSlideBefore > 0.01 && result.maxFootSlideAfter < GROUND_LOCK_EPSILON,
		`before=${(result.maxFootSlideBefore * 100).toFixed(2)}cm after=${(result.maxFootSlideAfter * 100).toFixed(2)}cm`);
	check("ground correction does not invent floor penetration",
		result.floorPenetrationBefore === 0 && result.floorPenetrationAfter < 1e-6,
		`before=${result.floorPenetrationBefore} after=${result.floorPenetrationAfter}`);
	const second = driver.run();
	check("the grounded pass is a fixed point",
		second.groundedKeyedFrames.length === 0 && second.maxFootCorrection === 0,
		`keys=${second.groundedKeyedFrames.length} max=${second.maxFootCorrection}`);
}

/* A slow 12 cm translation can look low and settled, but pinning it would
 * drag the leg across the floor. The whole run is refused, never sliced into
 * fake three-centimetre plants. */
{
	const frames = 24;
	const heights = new Array(frames).fill(0.96);
	const xs = Array.from({ length: frames }, (_, frame) => 0.12 * frame / (frames - 1));
	const driver = makeDriver(heights, { xs, grounding: true });
	const positions = [];
	const perFrameHeights = [];
	for (let frame = 0; frame < frames; frame += 1) {
		driver.pose(frame);
		positions.push(markerPositions(driver.rig));
		perFrameHeights.push(markerHeights(driver.rig));
	}
	const contacts = detectGroundContactSpans({ positions, planted: plantedFloor(perFrameHeights), fps: FPS });
	check("a moving foot is excluded instead of snapped backward",
		contacts.spans.length === 0, JSON.stringify(contacts));
	const result = driver.run();
	check("an excluded moving foot receives no ground correction keys",
		result.groundedKeyedFrames.length === 0,
		`keys=${result.groundedKeyedFrames.length}`);
}

/* The contact lock also owns one-sided floor cleanup. It may lift a sunken
 * body from the root, but never lowers an already clean take. */
{
	const driver = makeDriver(new Array(18).fill(0.88), { grounding: true });
	const result = driver.run();
	check("a sunken planted foot is detected and corrected",
		result.floorPenetrationBefore > 0.02 && result.groundedKeyedFrames.length > 0,
		`before=${(result.floorPenetrationBefore * 100).toFixed(2)}cm keys=${result.groundedKeyedFrames.length}`);
	check("floor penetration falls below one millimetre after evaluated playback",
		result.floorPenetrationAfter < 0.001,
		`after=${(result.floorPenetrationAfter * 100).toFixed(3)}cm`);
}

/* --- REGRESSION (R4): AutoPhysics keys the hips, and only the hips --------- */
/* ikBakeKeyframe defaults to the whole TRACKED set, so a session where the user
 * had already fixed an arm re-keyed that arm on every frame this pass wrote —
 * at whatever blended value the layer happened to be showing there. Run twice,
 * that ratchets: the second run bakes the first run's own blend ramp as an
 * authored pose (10.0 cm → 54.6 cm measured). The pass now names "hips". */
{
	// The synthetic rig has no skinned mesh to measure, so collision detection
	// needs radii injected, exactly as verify-fix-collisions.mjs does.
	const RADII = {
		Spine: 0.13, Head: 0.11, Neck: 0.06,
		LeftArm: 0.05, LeftForeArm: 0.045, LeftHand: 0.05,
		RightArm: 0.05, RightForeArm: 0.045, RightHand: 0.05,
		LeftUpLeg: 0.075, LeftLeg: 0.055, LeftFoot: 0.05,
		RightUpLeg: 0.075, RightLeg: 0.055, RightFoot: 0.05,
	};
	const driver = makeDriver(FLOATY);
	// A collision fix earlier in the session, on a frame AutoPhysics never
	// touches: the arm is now tracked and carries a key of its own at frame 0.
	driver.pose(0);
	solveIk(driver.chains.get("leftHand"), new THREE.Vector3(0.05, 1.45, 0));
	const fix = fixCollisions(driver.rig, driver.chains, { radii: RADII, ikState: driver.ik });
	ikBakeKeyframe(driver.chains, driver.ik, 0, driver.fkJoints, fix.touched);
	check("the collision fix keyed and tracked the arm",
		fix.changed && driver.ik.tracked.has("leftHand") && driver.ik.keys.get(0).has("leftHand"),
		`touched=${fix.touched.join(",")}`);

	const result = driver.run();
	const written = [...result.keyedFrames, ...result.pinnedFrames];
	check("AutoPhysics still corrects the span with an arm already tracked",
		written.length > 0 && result.maxCorrection > 0.01, `keyed=${result.keyedFrames.length}`);
	check("every frame AutoPhysics wrote carries the hips",
		written.every((frame) => driver.ik.keys.get(frame)?.has("hips")));
	check("no chain the pass did not move is keyed by it",
		written.every((frame) => ![...driver.chains.keys()].some((id) => driver.ik.keys.get(frame).has(id))),
		written.map((f) => `${f}:${[...driver.ik.keys.get(f).keys()].join("+")}`).join(" "));
	check("the earlier arm key survives untouched",
		driver.ik.keys.get(0).has("leftHand") && !driver.ik.keys.get(0).has("hips"));
}

/* --- guards --------------------------------------------------------------- */
{
	const rig = makeRig();
	const { chains, fkJoints } = resolveIkRig(rig);
	const ik = createIkState();
	check("a missing applyFrame is refused",
		autoPhysicsRange({ rig, chains, fkJoints, ikState: ik }).keyedFrames.length === 0);
	// REGRESSION (R6): "could not run" and "ran, found nothing" were the same
	// empty result, and the App read every one of them as "no airborne frames
	// in the clip" — a sentence that is false for four of the five paths here.
	check("a missing hips joint is refused", (() => {
		const out = autoPhysicsRange({
			rig, chains, fkJoints: new Map(), ikState: ik, applyFrame: () => {}, endFrame: 19,
		});
		return out.spans.length === 0 && out.keyedFrames.length === 0
			&& out.supported === false && out.reason === "no-hips-joint";
	})());
	check("a missing driver is refused with its own reason",
		autoPhysicsRange({ rig, chains, fkJoints, ikState: ik }).reason === "no-driver");
	check("a range shorter than the minimum span is refused",
		autoPhysicsRange({ rig, chains, fkJoints, ikState: ik, applyFrame: () => {}, endFrame: 2 }).spans.length === 0);
	check("a too-short range says so", (() => {
		const out = autoPhysicsRange({ rig, chains, fkJoints, ikState: ik, applyFrame: () => {}, endFrame: 2 });
		return out.supported === false && out.reason === "range-too-short";
	})());
	check("a rig whose CoM cannot be measured is refused, not called clean", (() => {
		const broken = makeRig();
		const resolved = resolveIkRig(broken);
		const pose = makeClip(broken, new Array(20).fill(0.9));
		broken.getObjectByName("mixamorigLeftForeArm").removeFromParent();
		const out = autoPhysicsRange({
			rig: broken, chains: resolved.chains, fkJoints: resolved.fkJoints,
			ikState: createIkState(), applyFrame: pose, endFrame: 19,
		});
		return out.supported === false && out.reason === "rig-not-measurable" && out.spans.length === 0;
	})());
	check("a clip that simply never leaves the ground is SUPPORTED", (() => {
		const out = makeDriver(new Array(20).fill(0.9)).run();
		return out.supported === true && out.reason === "" && out.spans.length === 0;
	})());
	check("an already-ballistic clip is supported too", (() => {
		const out = makeDriver(FLOATY).run();
		return out.supported === true && out.keyedFrames.length > 0;
	})());
	check("the legacy `margin` option still sets the lift threshold", (() => {
		// A 2 m lift can never be reached, so the whole clip reads grounded.
		const driver = makeDriver(FLOATY, { margin: 2 });
		return driver.run().spans.length === 0;
	})());
	check("epsilon is 5 mm as documented", AUTO_PHYSICS_EPSILON === 0.005);
}

console.log(failures ? `\n${failures} FAIL` : "\nall pass");
process.exit(failures ? 1 : 0);
