/**
 * pose-constraints.mjs — a CozyClay authored pose → Kimodo's `fullbody` constraint.
 *
 * This is the INVERSE of soma77-to-cskel27.mjs: that file reads a generated
 * somaskel77 take down to cskel27, this one pushes an authored cskel27 pose back
 * up to somaskel77 so Kimodo can be constrained by it.
 *
 * WHAT KIMODO ACTUALLY WANTS, read from its source rather than inferred
 * (kimodo/constraints.py FullBodyConstraintSet.from_dict):
 *
 *     local_rot = torch.tensor(dico["local_joints_rot"])
 *     local_rot_mats = axis_angle_to_matrix(local_rot)
 *     local_rot_mats = _convert_constraint_local_rots_to_skeleton(...)
 *     global_joints_rots, global_joints_positions, _ = skeleton.fk(
 *         local_rot_mats, torch.tensor(dico["root_positions"]))
 *
 * So the JSON carries LOCAL rotations as AXIS-ANGLE radians — not matrices, not
 * globals — and Kimodo runs its own FK from them. `_convert_constraint_local_rots_to_skeleton`
 * accepts 30 or 77 joints, and this file emits 77.
 *
 * WHY THE MAPPING IS NOT A GATHER. cskel27 and somaskel77 disagree on
 * segmentation (cskel27 has four torso links where somaskel77 has three, and one
 * neck link where somaskel77 has two), so a cskel27 LOCAL cannot simply be
 * copied into the somaskel77 slot of the same name. The pose is therefore
 * carried through GLOBAL space, the same invariant the forward converter is
 * pinned on: build cskel27 globals by FK, hand each somaskel77 joint the global
 * of the cskel27 joint that drives it (nearest mapped ancestor when it has
 * none), then re-derive each somaskel77 local as parentGlobalᵀ · global. A
 * somaskel77 joint whose driver is also its parent's driver comes out identity,
 * which is exactly "this joint was not authored".
 *
 * The leg names shift by one between the skeletons (somaskel77 `LeftLeg` is the
 * THIGH, cskel27 calls that `LeftUpLeg`), so mapping by equal name would put the
 * knee rotation on the hip. CSKEL27_FROM_SOMA77 already encodes the shift and is
 * reused here rather than restated.
 */

import { CSKEL27_JOINTS, CSKEL27_PARENTS } from "../../src/ardy/cskel27.js";
import { globalRotations, matMul, matTranspose } from "../../src/ardy/convert.js";
import { CSKEL27_FROM_SOMA77, SOMA77_JOINTS } from "./soma77-to-cskel27.mjs";

export const FULLBODY_TYPE = "fullbody";

/** somaskel77 parent index per joint, transcribed from the upstream definition. */
const SOMA77_PARENT_NAME = {
	Hips: null, Spine1: "Hips", Spine2: "Spine1", Chest: "Spine2",
	Neck1: "Chest", Neck2: "Neck1", Head: "Neck2", HeadEnd: "Head", Jaw: "Head",
	LeftEye: "Head", RightEye: "Head",
	LeftShoulder: "Chest", LeftArm: "LeftShoulder", LeftForeArm: "LeftArm", LeftHand: "LeftForeArm",
	RightShoulder: "Chest", RightArm: "RightShoulder", RightForeArm: "RightArm", RightHand: "RightForeArm",
	LeftLeg: "Hips", LeftShin: "LeftLeg", LeftFoot: "LeftShin", LeftToeBase: "LeftFoot", LeftToeEnd: "LeftToeBase",
	RightLeg: "Hips", RightShin: "RightLeg", RightFoot: "RightShin", RightToeBase: "RightFoot", RightToeEnd: "RightToeBase",
};
for (const name of SOMA77_JOINTS) {
	if (name in SOMA77_PARENT_NAME) continue;
	// Every remaining joint is a finger link: <side>Hand<Digit><N>, parented to
	// the previous link in its own chain and rooted at the hand.
	const match = /^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)(\d|End)$/.exec(name);
	if (!match) throw new Error(`pose-constraints: unclassified somaskel77 joint ${name}`);
	const [, side, digit, step] = match;
	if (step === "1") {
		SOMA77_PARENT_NAME[name] = `${side}Hand`;
	} else if (step === "End") {
		const previous = SOMA77_JOINTS.filter((n) => n.startsWith(`${side}Hand${digit}`) && /\d$/.test(n)).pop();
		SOMA77_PARENT_NAME[name] = previous;
	} else {
		SOMA77_PARENT_NAME[name] = `${side}Hand${digit}${Number(step) - 1}`;
	}
}
const SOMA77_INDEX = new Map(SOMA77_JOINTS.map((name, index) => [name, index]));
const SOMA77_PARENTS = SOMA77_JOINTS.map((name) => {
	const parent = SOMA77_PARENT_NAME[name];
	return parent === null || parent === undefined ? null : SOMA77_INDEX.get(parent);
});

// somaskel77 joint -> the cskel27 joint that drives it (inverse of the forward map).
const CSKEL27_INDEX = new Map(CSKEL27_JOINTS.map((name, index) => [name, index]));
const DRIVER_BY_SOMA77 = new Map();
for (const [cskelName, somaName] of Object.entries(CSKEL27_FROM_SOMA77)) {
	if (somaName === null) continue;
	DRIVER_BY_SOMA77.set(somaName, CSKEL27_INDEX.get(cskelName));
}
/** Per somaskel77 joint, the cskel27 joint index whose global it takes. */
const SOMA77_DRIVER = SOMA77_JOINTS.map((_, index) => {
	let cursor = index;
	while (cursor !== null && cursor !== undefined) {
		const driver = DRIVER_BY_SOMA77.get(SOMA77_JOINTS[cursor]);
		if (driver !== undefined) return driver;
		cursor = SOMA77_PARENTS[cursor];
	}
	return CSKEL27_INDEX.get("Hips");
});

const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/**
 * Rotation matrix → axis-angle (radians, magnitude = angle).
 *
 * The naive extraction divides by sin(theta), which is zero at 180 degrees —
 * a pose with a fully turned joint is not exotic, so that branch is handled
 * explicitly from the diagonal instead of being allowed to produce NaN.
 */
export function axisAngleFromMatrix(m) {
	const trace = m[0][0] + m[1][1] + m[2][2];
	const cos = Math.min(1, Math.max(-1, (trace - 1) / 2));
	const angle = Math.acos(cos);
	if (angle < 1e-8) return [0, 0, 0];
	if (Math.PI - angle > 1e-6) {
		const k = angle / (2 * Math.sin(angle));
		return [(m[2][1] - m[1][2]) * k, (m[0][2] - m[2][0]) * k, (m[1][0] - m[0][1]) * k];
	}
	// theta ~= pi: R is symmetric, so the axis comes from sqrt of the diagonal.
	const xx = (m[0][0] + 1) / 2;
	const yy = (m[1][1] + 1) / 2;
	const zz = (m[2][2] + 1) / 2;
	let axis;
	if (xx >= yy && xx >= zz) {
		const x = Math.sqrt(Math.max(0, xx));
		axis = [x, m[0][1] / (2 * x), m[0][2] / (2 * x)];
	} else if (yy >= zz) {
		const y = Math.sqrt(Math.max(0, yy));
		axis = [m[0][1] / (2 * y), y, m[1][2] / (2 * y)];
	} else {
		const z = Math.sqrt(Math.max(0, zz));
		axis = [m[0][2] / (2 * z), m[1][2] / (2 * z), z];
	}
	const length = Math.hypot(...axis) || 1;
	return axis.map((v) => (v / length) * angle);
}

function requireRotation(m, label) {
	if (!Array.isArray(m) || m.length !== 3 || m.some((row) => !Array.isArray(row) || row.length !== 3)) {
		throw new Error(`buildFullBodyConstraints: ${label} must be a 3x3 matrix`);
	}
	for (const row of m) {
		for (const value of row) {
			if (typeof value !== "number" || !Number.isFinite(value)) {
				throw new Error(`buildFullBodyConstraints: ${label} has a non-finite entry`);
			}
		}
	}
	const det =
		m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
		m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
		m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
	if (Math.abs(det - 1) > 1e-3) {
		throw new Error(
			`buildFullBodyConstraints: ${label} is not a rotation (determinant ${det.toFixed(4)}, expected 1)`
		);
	}
	return m;
}

/**
 * @param {Array<{frame:number, pose:{local_rot_mats:number[][][], posed_joints:number[][]}}>} poses
 * @param {{genFrames:number}} options
 * @returns {Array<object>} zero or one Kimodo `fullbody` constraint entry
 */
export function buildFullBodyConstraints(poses, { genFrames } = {}) {
	if (!poses || poses.length === 0) return [];
	if (!Array.isArray(poses)) throw new Error("buildFullBodyConstraints: poses must be an array");
	if (!Number.isFinite(genFrames) || genFrames < 1) {
		throw new Error(`buildFullBodyConstraints: genFrames must be >= 1, got ${genFrames}`);
	}

	const frameIndices = [];
	const localJointsRot = [];
	const rootPositions = [];
	let previousFrame = -1;

	for (const [entryIndex, entry] of poses.entries()) {
		if (!entry || typeof entry !== "object") {
			throw new Error(`buildFullBodyConstraints: poses[${entryIndex}] must be an object`);
		}
		const frame = entry.frame;
		if (!Number.isInteger(frame) || frame < 0 || frame >= genFrames) {
			throw new Error(
				`buildFullBodyConstraints: poses[${entryIndex}].frame must be an integer in 0..${genFrames - 1}, got ${JSON.stringify(frame)}`
			);
		}
		if (frame <= previousFrame) {
			throw new Error(
				`buildFullBodyConstraints: pose frames must be strictly ascending; poses[${entryIndex}].frame ${frame} follows ${previousFrame}`
			);
		}
		previousFrame = frame;

		const pose = entry.pose;
		const locals = pose?.local_rot_mats;
		const posed = pose?.posed_joints;
		if (!Array.isArray(locals) || locals.length !== 27) {
			throw new Error(
				`buildFullBodyConstraints: poses[${entryIndex}].pose.local_rot_mats must have 27 joints, got ${locals?.length}`
			);
		}
		if (!Array.isArray(posed) || posed.length !== 27) {
			throw new Error(
				`buildFullBodyConstraints: poses[${entryIndex}].pose.posed_joints must have 27 joints, got ${posed?.length}`
			);
		}
		locals.forEach((m, index) => requireRotation(m, `poses[${entryIndex}].local_rot_mats[${index}]`));

		// cskel27 locals -> cskel27 globals -> somaskel77 globals -> somaskel77 locals.
		const cskelGlobals = globalRotations(locals);
		const somaGlobals = SOMA77_DRIVER.map((driver) => cskelGlobals[driver]);
		const somaLocals = somaGlobals.map((global, index) => {
			const parent = SOMA77_PARENTS[index];
			return parent === null || parent === undefined
				? global
				: matMul(matTranspose(somaGlobals[parent]), global);
		});
		localJointsRot.push(somaLocals.map((m) => axisAngleFromMatrix(m)));

		const hips = posed[CSKEL27_INDEX.get("Hips")];
		if (!Array.isArray(hips) || hips.length !== 3 || hips.some((v) => !Number.isFinite(v))) {
			throw new Error(`buildFullBodyConstraints: poses[${entryIndex}] has a non-finite root position`);
		}
		// Kimodo reads root_positions Y as the hip height ABOVE THE GROUND. A
		// CozyClay pose is authored in its take's own space and is not floor
		// aligned — a pose measured off the running app had its hips at 1.781 m
		// with its lowest joint at 0.787 m, the whole character 79 cm in the air.
		// Forwarding that raw told Kimodo to generate a floating character, and
		// since a motion edit re-authors its pose from the previous take, the
		// drift compounded on every round trip.
		//
		// So the pose is grounded on its own lowest joint first. Only the height
		// changes: XZ is the author's placement and rides through untouched, and
		// the pose's internal shape is carried by the rotations, not by this.
		let lowest = Infinity;
		for (const joint of posed) {
			if (!Array.isArray(joint) || joint.length !== 3 || joint.some((v) => !Number.isFinite(v))) {
				throw new Error(`buildFullBodyConstraints: poses[${entryIndex}] has a non-finite joint position`);
			}
			if (joint[1] < lowest) lowest = joint[1];
		}
		rootPositions.push([hips[0], hips[1] - lowest, hips[2]]);
		frameIndices.push(frame);
	}

	return [
		{
			type: FULLBODY_TYPE,
			frame_indices: frameIndices,
			local_joints_rot: localJointsRot,
			root_positions: rootPositions,
		},
	];
}
