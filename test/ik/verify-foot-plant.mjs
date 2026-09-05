import * as THREE from "three";
import {
	resolveIkRig,
	createIkState,
	ikEvaluate,
	ikBakeKeyframe,
	solveIk,
} from "../../src/ardy/ik.js";
import {
	FOOT_PLANT_CHAINS,
	CONTACT_ON_HEIGHT,
	CONTACT_OFF_HEIGHT,
	CONTACT_ON_SPEED,
	CONTACT_OFF_SPEED,
	MIN_CONTACT_FRAMES,
	MAX_PLANT_SHIFT,
	PLANT_TAPER,
	PLANT_STEP_BUDGET,
	MAX_ROOT_DROP,
	MIN_INTERVAL_SLIDE,
	PLANT_FLOOR_TOLERANCE,
	markerPositions,
	plantedFloorHeights,
	xzSpeeds,
	contactFlags,
	despeckle,
	flagsToIntervals,
	medianXZ,
	easeWeights,
	footPlantRange,
} from "../../src/ardy/foot-plant.js";

let failures = 0;
function check(name, cond, detail = "") {
	if (cond) console.log(`PASS ${name}`);
	else {
		failures += 1;
		console.log(`FAIL ${name}${detail ? " — " + detail : ""}`);
	}
}

/* Synthetic Mixamo-spelled rig, identical in layout to
 * test/ik/verify-auto-physics.mjs: T-pose, legs down -Y, toes forward +Z, rig
 * scaled 0.01 (cm -> m). With the hips at world height Y the ankles sit at
 * Y - 0.90 and the toe bases at Y - 0.95 (0.12 forward). Both leg segments are
 * 0.45 m, so a leg reaches exactly 0.90 m. */
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
/* App.jsx blends IK corrections back into the clip over this many frames. */
const BLEND = 6;

/**
 * Bake a clip from a per-frame SPEC — hips world position plus each ankle's
 * world position — into the flat table a playback function can replay.
 *
 * The spec is authored in world space and turned into bone rotations by the
 * production solver, so every clip in this file is by construction a pose the
 * IK layer can actually hold. Solving frame by frame on one rig also keeps the
 * knee on one side (solveIk's bend continuity), so the clip is smooth.
 */
/** Put a chain's effector exactly on `want`. solveIk misses a bent chain by up
 * to a centimetre (its bend-continuity vector is not orthogonalised against
 * the root->target line), and a fixture whose ankle track is a centimetre off
 * its own spec cannot be reasoned about — so the fixture closes the loop the
 * same way src/ardy/foot-plant.js does. */
function place(chain, want) {
	const aim = want.clone();
	const got = new THREE.Vector3();
	for (let pass = 0; pass < 8; pass += 1) {
		solveIk(chain, aim);
		chain.bones[2].getWorldPosition(got);
		if (got.distanceTo(want) < 1e-6) break;
		aim.add(want).sub(got);
	}
}

function bakeClip(specs) {
	const rig = makeRig();
	const { chains } = resolveIkRig(rig);
	const hips = rig.getObjectByName("mixamorigHips");
	const table = [];
	for (const spec of specs) {
		hips.position.set(spec.hips.x * 100, spec.hips.y * 100, spec.hips.z * 100);
		rig.updateMatrixWorld(true);
		place(chains.get("leftFoot"), new THREE.Vector3(spec.left.x, spec.left.y, spec.left.z));
		place(chains.get("rightFoot"), new THREE.Vector3(spec.right.x, spec.right.y, spec.right.z));
		table.push({
			hips: hips.position.clone(),
			quats: new Map([...chains].map(([id, chain]) => [id, chain.bones.map((b) => b.quaternion.clone())])),
		});
	}
	return table;
}

/** Replay a baked table onto a rig — the "motion apply" half of applyFrame. */
function makeClip(rig, chains, table) {
	const hips = rig.getObjectByName("mixamorigHips");
	return (frame) => {
		const entry = table[Math.max(0, Math.min(frame, table.length - 1))];
		hips.position.copy(entry.hips);
		for (const [id, quats] of entry.quats) {
			const chain = chains.get(id);
			chain.bones.forEach((bone, index) => {
				bone.position.copy(chain.bindPositions[index]);
				bone.quaternion.copy(quats[index]);
			});
		}
		rig.updateMatrixWorld(true);
	};
}

/** Rig + IK state + a repeatable `run()`, so idempotence can be asserted
 * against ONE accumulated key layer (mirrors verify-auto-physics's driver). */
function makeDriver(specs, options = {}) {
	const table = bakeClip(specs);
	const rig = makeRig();
	const { chains, fkJoints } = resolveIkRig(rig);
	const ik = createIkState();
	ik.chains = chains;
	ik.fkJoints = fkJoints;
	const pose = makeClip(rig, chains, table);
	const applyFrame = (frame) => {
		pose(frame);
		ikEvaluate(chains, ik, frame, fkJoints, BLEND);
	};
	const run = (extra = {}) => footPlantRange(rig, chains, {
		ikState: ik,
		fkJoints,
		applyFrame,
		startFrame: 0,
		endFrame: specs.length - 1,
		fps: FPS,
		...options,
		...extra,
	});
	return { rig, chains, fkJoints, ik, pose, applyFrame, run, frames: specs.length };
}

/** Every foot marker's world position at every frame of the EVALUATED clip. */
function sweep(driver) {
	const out = [];
	for (let frame = 0; frame < driver.frames; frame += 1) {
		driver.applyFrame(frame);
		out.push(markerPositions(driver.rig));
	}
	return out;
}

/** Per-foot planted fraction and mean XZ speed while planted, measured the
 * same way the pass itself defines contact. */
function slideReport(samples, fps = FPS) {
	const floors = plantedFloorHeights(samples);
	const report = {};
	for (const foot of FOOT_PLANT_CHAINS) {
		const ankle = samples.map((s) => s[foot.ankle]);
		const toe = samples.map((s) => s[foot.toe]);
		const heights = samples.map((_, index) => Math.min(
			ankle[index].y - floors[foot.ankle],
			toe[index].y - floors[foot.toe],
		));
		const speeds = xzSpeeds(ankle, fps);
		const flags = despeckle(contactFlags({
			heights,
			speeds,
			onHeight: CONTACT_ON_HEIGHT,
			offHeight: CONTACT_OFF_HEIGHT,
			onSpeed: CONTACT_ON_SPEED,
			offSpeed: CONTACT_OFF_SPEED,
		}));
		let planted = 0;
		let total = 0;
		for (let index = 0; index < flags.length; index += 1) {
			if (!flags[index]) continue;
			planted += 1;
			total += speeds[index];
		}
		report[foot.id] = {
			planted: planted / flags.length,
			speed: planted ? total / planted : 0,
		};
	}
	return report;
}

/* --- pure helpers ---------------------------------------------------------- */
{
	check("both legs are described, ankle + toe each",
		FOOT_PLANT_CHAINS.length === 2
		&& FOOT_PLANT_CHAINS.every((f) => /Foot$/.test(f.ankle) && /ToeBase$/.test(f.toe)));

	// Hysteresis: a contact that opens under the ON thresholds survives a frame
	// that is over ON but under OFF, and only ends past OFF.
	const heights = [0.0, 0.0, 0.03, 0.03, 0.09, 0.09, 0.0];
	const speeds = [0.0, 0.0, 0.2, 0.2, 0.2, 0.2, 0.0];
	const flags = contactFlags({
		heights, speeds,
		onHeight: CONTACT_ON_HEIGHT, offHeight: CONTACT_OFF_HEIGHT,
		onSpeed: CONTACT_ON_SPEED, offSpeed: CONTACT_OFF_SPEED,
	});
	check("hysteresis holds contact through the band between on and off",
		flags.join(",") === "true,true,true,true,false,false,true", flags.join(","));

	check("a one-frame contact run is removed",
		despeckle([false, true, false, false]).join(",") === "false,false,false,false");
	check("a one-frame gap inside a contact is filled",
		despeckle([true, true, false, true, true]).join(",") === "true,true,true,true,true");

	check("intervals are inclusive runs of true",
		JSON.stringify(flagsToIntervals([false, true, true, false, true]))
			=== JSON.stringify([{ start: 1, end: 2 }, { start: 4, end: 4 }]));

	// The median is the whole point of the plant: one wild frame must not drag
	// the plant off the twenty frames that agree with each other.
	const outlier = [
		...Array.from({ length: 20 }, () => new THREE.Vector3(0, 0.1, 0.5)),
		new THREE.Vector3(0, 0.1, 9),
	];
	const med = medianXZ(outlier, 0, 20);
	check("median XZ ignores a one-frame outlier",
		Math.abs(med.z - 0.5) < 1e-9, `z=${med.z}`);

	// The ease: shortest hand-back that keeps the ADDED travel per frame inside
	// the budget. Six equal 25 mm swing frames, 40 mm of correction to shed:
	// one frame would add all 40, two would add 20 each, four add 10.
	{
		const travel = [0.025, 0.025, 0.025, 0.025, 0.025, 0.025];
		const w = easeWeights(travel, 0.04, PLANT_STEP_BUDGET);
		check("the ease is the shortest hand-back that fits the step budget",
			w.length === 4, JSON.stringify(w));
		check("the ease falls monotonically to zero",
			w.every((v, i) => i === 0 || v <= w[i - 1]) && w[w.length - 1] === 0,
			JSON.stringify(w));
		let added = 0;
		let previous = 1;
		for (let i = 0; i < w.length; i += 1) { added = Math.max(added, 0.04 * (previous - w[i])); previous = w[i]; }
		check("no frame of the ease is handed more than the step budget",
			added <= PLANT_STEP_BUDGET + 1e-9, `${(added * 1000).toFixed(2)} mm`);
		check("a bigger offset borrows more swing frames",
			easeWeights(travel, 0.005, PLANT_STEP_BUDGET).length === 1
			&& easeWeights(travel, 0.02, PLANT_STEP_BUDGET).length === 2,
			`${easeWeights(travel, 0.005, PLANT_STEP_BUDGET).length} ${easeWeights(travel, 0.02, PLANT_STEP_BUDGET).length}`);
		// A foot that never moves over the candidates has no arc length to hide
		// the correction in; the ease must still terminate rather than divide by
		// zero or hold the correction for ever.
		const still = easeWeights([0, 0, 0], 0.04, PLANT_STEP_BUDGET);
		check("a stationary ease still hands the frames back",
			still.length === 3 && still[still.length - 1] === 0 && still.every(Number.isFinite),
			JSON.stringify(still));
	}

	check("named guard constants keep their measured values",
		CONTACT_ON_HEIGHT === 0.02 && CONTACT_OFF_HEIGHT === 0.06
		&& CONTACT_ON_SPEED === 0.15 && CONTACT_OFF_SPEED === 0.4
		&& MAX_PLANT_SHIFT === 0.25 && PLANT_TAPER === 6 && PLANT_STEP_BUDGET === 0.01
		&& MAX_ROOT_DROP === 0.08 && MIN_CONTACT_FRAMES === 2);
}

/* --- refusals -------------------------------------------------------------- */
{
	const refused = footPlantRange(null, null, {});
	check("a pass with no driver refuses instead of pretending",
		refused.supported === false && refused.reason === "no-driver" && refused.keyedFrames.length === 0,
		JSON.stringify(refused));

	const rig = makeRig();
	const { chains, fkJoints } = resolveIkRig(rig);
	const ik = createIkState();
	const short = footPlantRange(rig, chains, {
		ikState: ik, fkJoints, applyFrame: () => {}, startFrame: 0, endFrame: 0, fps: FPS,
	});
	check("a range too short to hold a contact refuses with a reason",
		short.supported === false && short.reason === "range-too-short", JSON.stringify(short));
}

/* --- clip 1: a planted left foot skating 8 cm ------------------------------ */
/* The left ankle stays at ankle height for the whole clip (planted the whole
 * time) but slides 8 cm in +Z between frames 10 and 30 — the exact failure the
 * pass exists for. The right foot takes a real 30 cm step in the middle. */
const skateSpecs = Array.from({ length: 40 }, (_, f) => {
	const leftZ = f < 10 ? 0 : f > 30 ? 0.08 : (0.08 * (f - 10)) / 20;
	const stepT = Math.max(0, Math.min(1, (f - 15) / 10));
	const rightZ = 0.3 * stepT;
	const rightY = 0.1 + (f > 15 && f < 25 ? 0.22 * Math.sin(Math.PI * stepT) : 0);
	return {
		hips: { x: 0, y: 0.92, z: 0.004 * f },
		left: { x: 0.1, y: 0.1, z: leftZ },
		right: { x: -0.1, y: rightY, z: rightZ },
	};
});

{
	const driver = makeDriver(skateSpecs);
	const beforeSamples = sweep(driver);
	const beforeFloors = plantedFloorHeights(beforeSamples);
	const before = slideReport(beforeSamples);
	const result = driver.run();

	check("the skating clip is supported", result.supported === true && result.reason === "",
		JSON.stringify({ supported: result.supported, reason: result.reason }));

	const left = result.intervals.filter((i) => i.foot === "leftFoot");
	const right = result.intervals.filter((i) => i.foot === "rightFoot");
	check("the sliding left foot is seen as one long contact",
		left.length === 1 && left[0].start === 0 && left[0].end === 39,
		JSON.stringify(left.map((i) => [i.start, i.end])));
	check("the 8 cm skate is measured as a slide worth fixing",
		left[0] && left[0].slide > 0.03 && left[0].applied === true,
		JSON.stringify(left[0]));

	// The step: two separate contacts either side of a swing, never one
	// interval spanning the lift (which would yank the foot 15 cm sideways).
	check("a real step is two contacts, not one skate",
		right.length === 2 && right[0].end < 20 && right[1].start > 20,
		JSON.stringify(right.map((i) => [i.start, i.end])));
	check("a genuinely planted foot is left keyless",
		right.every((i) => i.applied === false && !i.refused),
		JSON.stringify(right));

	check("the pass keys frames", result.keyedFrames.length > 0, `${result.keyedFrames.length}`);
	check("the correction is a skate-sized move, not a leap",
		result.maxCorrection > 0.02 && result.maxCorrection < MAX_PLANT_SHIFT,
		`${result.maxCorrection}`);

	const after = slideReport(sweep(driver));
	check("slide while planted drops below 5 cm/s on the skating foot",
		after.leftFoot.speed <= 0.05,
		`before ${before.leftFoot.speed.toFixed(3)} after ${after.leftFoot.speed.toFixed(3)}`);
	check("the pass reports the residual slide it actually left",
		Math.abs(result.residualSlide - Math.max(after.leftFoot.speed, after.rightFoot.speed)) < 0.02,
		`reported ${result.residualSlide} measured ${Math.max(after.leftFoot.speed, after.rightFoot.speed)}`);
	check("the foot stays planted at least as often as before",
		after.leftFoot.planted >= before.leftFoot.planted - 1e-9,
		`before ${before.leftFoot.planted} after ${after.leftFoot.planted}`);

	// No marker may end up under the floor the SOURCE clip established. The
	// floors have to come from the before-sweep: recomputing them on the
	// corrected clip makes the assertion vacuous, because the floor is defined
	// as that sweep's own minimum.
	const samples = sweep(driver);
	let worst = 0;
	for (const sample of samples) {
		for (const foot of FOOT_PLANT_CHAINS) {
			for (const name of [foot.ankle, foot.toe]) {
				worst = Math.max(worst, beforeFloors[name] - sample[name].y);
			}
		}
	}
	check("no foot marker is pushed below the clip's own floor",
		worst <= PLANT_FLOOR_TOLERANCE, `worst penetration ${(worst * 1000).toFixed(2)} mm`);

	// Idempotence: the fixed point, not a "we skipped our own keys" tautology.
	const keysBefore = result.keyedFrames.length;
	const second = driver.run();
	check("a second run keys nothing — the pass is a fixed point",
		second.keyedFrames.length === 0,
		`first ${keysBefore}, second ${second.keyedFrames.length}`);
	check("the second run still reports the clip as supported",
		second.supported === true, JSON.stringify(second.reason));
}

/* --- clip 2: standing still ------------------------------------------------ */
{
	const standing = Array.from({ length: 40 }, () => ({
		hips: { x: 0, y: 0.92, z: 0 },
		left: { x: 0.1, y: 0.1, z: 0 },
		right: { x: -0.1, y: 0.1, z: 0 },
	}));
	const driver = makeDriver(standing);
	const result = driver.run();
	check("a standing clip is supported and keys nothing",
		result.supported === true && result.keyedFrames.length === 0 && result.maxCorrection === 0,
		JSON.stringify({ keyed: result.keyedFrames.length, max: result.maxCorrection }));
	check("standing contacts are seen but not corrected",
		result.intervals.length === 2 && result.intervals.every((i) => i.applied === false),
		JSON.stringify(result.intervals.map((i) => [i.foot, i.start, i.end, i.applied])));
	check("a clip with nothing to fix leaves the key layer empty",
		driver.ik.keys.size === 0, `${driver.ik.keys.size}`);
}

/* --- clip 3: a 60 cm drag is a step, not a skate --------------------------- */
/* MAX_PLANT_SHIFT exists because a slow, low, LONG travel is a step the model
 * got right, and pinning it to its median would yank the foot 30 cm. */
{
	const frames = 180;
	const drag = Array.from({ length: frames }, (_, f) => {
		const z = (0.6 * f) / (frames - 1);
		return {
			hips: { x: 0, y: 0.92, z },
			left: { x: 0.1, y: 0.1, z },
			right: { x: -0.1, y: 0.1, z },
		};
	});
	const driver = makeDriver(drag);
	const result = driver.run();
	check("a 60 cm low travel is refused as a step, not yanked to a plant",
		result.intervals.length > 0 && result.intervals.every((i) => i.refused === "step-not-skate"),
		JSON.stringify(result.intervals.map((i) => [i.foot, i.start, i.end, i.refused])));
	check("a refused interval keys nothing",
		result.keyedFrames.length === 0 && driver.ik.keys.size === 0,
		`${result.keyedFrames.length} / ${driver.ik.keys.size}`);
}

/* --- clip 4: root absorption ----------------------------------------------- */
/* Both feet planted and sliding while the root walks away from them: pinning
 * the feet over-extends the legs, and the answer is to lower the hips rather
 * than straighten the knees into a stilt. */
{
	const frames = 80;
	const specs = Array.from({ length: frames }, (_, f) => {
		const t = f / (frames - 1);
		const footZ = 0.3 * t;
		return {
			hips: { x: 0, y: 0.92, z: 0.62 * t },
			left: { x: 0.1, y: 0.1, z: footZ },
			right: { x: -0.1, y: 0.1, z: footZ },
		};
	});
	const driver = makeDriver(specs);
	const result = driver.run();
	check("an over-extended plant lowers the root instead of straightening the leg",
		result.maxRootDrop > 0 && result.maxRootDrop <= MAX_ROOT_DROP + 1e-9,
		`${result.maxRootDrop}`);
	check("root absorption keys the hips joint",
		[...driver.ik.keys.values()].some((entry) => entry.has("hips")),
		JSON.stringify([...driver.ik.keys.keys()]));
	check("root absorption is still a fixed point",
		driver.run().keyedFrames.length === 0);
}

/* --- user keys are anchors ------------------------------------------------- */
{
	const driver = makeDriver(skateSpecs);
	// A hand-authored foot key at frame 20: rotate the knee, bake it the way a
	// gizmo drag would, and record it byte for byte.
	driver.applyFrame(20);
	const chain = driver.chains.get("leftFoot");
	solveIk(chain, chain.bones[2].getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.03, 0.02)));
	ikBakeKeyframe(driver.chains, driver.ik, 20, driver.fkJoints, ["leftFoot"]);
	const authored = driver.ik.keys.get(20).get("leftFoot");
	const snapshot = JSON.stringify(authored.q.map((q) => [q.x, q.y, q.z, q.w]));

	const result = driver.run();
	const after = driver.ik.keys.get(20).get("leftFoot");
	check("a user-authored foot key survives the pass byte for byte",
		after === authored
		&& JSON.stringify(after.q.map((q) => [q.x, q.y, q.z, q.w])) === snapshot
		&& after.baseQ === undefined,
		JSON.stringify(after?.q?.map((q) => [q.x, q.y, q.z, q.w])));
	check("the anchored frame is reported, not silently skipped",
		result.anchoredFrames.includes(20), JSON.stringify(result.anchoredFrames));
	check("the pass still fixes the frames around the anchor",
		result.keyedFrames.length > 0 && !result.keyedFrames.includes(20),
		JSON.stringify(result.keyedFrames));
}

/* --- the taper ------------------------------------------------------------- */
/* An interval that ends inside the clip must hand the foot back to the motion
 * over a few frames instead of stepping off the plant. */
{
	// Left foot: planted and skating for the first half, then a clean swing.
	const frames = 60;
	const specs = Array.from({ length: frames }, (_, f) => {
		const leftZ = f <= 30 ? (0.08 * f) / 30 : 0.08 + 0.4 * ((f - 30) / 29);
		const leftY = f <= 30 ? 0.1 : 0.1 + 0.2 * Math.sin((Math.PI * (f - 30)) / 29);
		return {
			hips: { x: 0, y: 0.92, z: 0.004 * f },
			left: { x: 0.1, y: leftY, z: leftZ },
			right: { x: -0.1, y: 0.1, z: 0 },
		};
	});
	const driver = makeDriver(specs);
	let previous = null;
	let clipStep = 0;
	const clipSteps = [];
	for (let f = 0; f < frames; f += 1) {
		driver.applyFrame(f);
		const p = markerPositions(driver.rig).mixamorigLeftFoot.clone();
		const d = previous ? p.distanceTo(previous) : 0;
		clipSteps.push(d);
		clipStep = Math.max(clipStep, d);
		previous = p;
	}
	const result = driver.run();
	const left = result.intervals.find((i) => i.foot === "leftFoot" && i.applied);
	check("the interval ends before the swing starts",
		Boolean(left) && left.end < 34, JSON.stringify(left && [left.start, left.end]));

	// The pop detector. "Never faster than the clip's own fastest frame" is the
	// wrong bar and was tried first: the ease necessarily runs over the START of
	// a swing, which is the slow part, so a 4 cm plant offset cannot come off
	// there without one frame beating a clip whose peak is 2.6 cm. What the
	// viewer reads as a pop is what the pass ADDS to a frame, and that is
	// exactly what PLANT_STEP_BUDGET bounds.
	previous = null;
	let step = 0;
	let stepAt = -1;
	let added = 0;
	let addedAt = -1;
	const afterSteps = [];
	for (let f = 0; f < frames; f += 1) {
		driver.applyFrame(f);
		const p = markerPositions(driver.rig).mixamorigLeftFoot.clone();
		const d = previous ? p.distanceTo(previous) : 0;
		afterSteps.push(d);
		if (previous && d > step) { step = d; stepAt = f; }
		previous = p;
	}
	for (let f = 1; f < frames; f += 1) {
		const delta = afterSteps[f] - clipSteps[f];
		if (delta > added) { added = delta; addedAt = f; }
	}
	check("the ease adds no more than the step budget to any one frame",
		added <= PLANT_STEP_BUDGET + 1e-6,
		`worst added ${(added * 1000).toFixed(1)} mm at f${addedAt} (budget ${(PLANT_STEP_BUDGET * 1000).toFixed(0)} mm); after peak ${(step * 1000).toFixed(1)} mm at f${stepAt}, clip peak ${(clipStep * 1000).toFixed(1)} mm`);

	// And the point of moving the ease out of the contact in the first place:
	// the foot must be still WHILE PLANTED, which is the metric the pass is
	// judged by. A ramp inside the contact used to make this number worse.
	const after = slideReport(sweep(driver));
	check("the corrected contact leaves no slide inside it",
		after.leftFoot.speed <= 0.05,
		`${after.leftFoot.speed.toFixed(3)} m/s`);
}

/* --- the object-form signature --------------------------------------------- */
{
	const driver = makeDriver(skateSpecs);
	const result = footPlantRange({
		rig: driver.rig,
		chains: driver.chains,
		ikState: driver.ik,
		fkJoints: driver.fkJoints,
		applyFrame: driver.applyFrame,
		startFrame: 0,
		endFrame: skateSpecs.length - 1,
		fps: FPS,
	});
	check("footPlantRange also takes one options object, like its siblings",
		result.supported === true && result.keyedFrames.length > 0,
		JSON.stringify({ supported: result.supported, keyed: result.keyedFrames.length }));
}

console.log(failures === 0 ? "\nALL FOOT-PLANT CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
