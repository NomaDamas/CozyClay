/** Rotation-only GVHMR SMPL -> cskel27 retarget.
 * The argument is the member map returned by readNpz; plain arrays are also
 * accepted for small callers. Arrays may be nested or flat typed buffers.
 *
 * PROPORTIONS. Mocap is the product here, so the take carries the filmed
 * performer's body, not the canonical one: every cskel27 bone is scaled by
 * the ratio of the performer's SMPL rest bone length to the canonical bone
 * (`boneScale`, one factor per joint = the length of the bone ENDING at that
 * joint). posedJoints are grown with FK over those scaled offsets, so foot
 * placement, reach and stride are the performer's; playback applies the same
 * factors to the bones it drives by rotation only (the arm chain). A bone the
 * SMPL skeleton does not segment the same way (Spine..Spine3 are four links
 * against SMPL's three; hand ends; thumb) takes the nearest measured chain's
 * ratio so the body stays continuous. rootPos is the performer's pelvis
 * height as filmed: with the legs at their real length there is no height
 * ratio left to apply, and personScale is 1 by construction.
 */
import { CSKEL27_JOINTS, CSKEL27_PARENTS } from "../../src/ardy/cskel27.js";
import { deriveBoneOffsets, forwardKinematics, matMul, matTranspose } from "../../src/ardy/convert.js";
import { canonicalCskel27Reference } from "../../src/ardy/to-cskel27.js";

const SMPL_PARENTS = [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19, 20, 21];
const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const MAP = {
	Hips: 0, Spine: 3, Spine1: 6, Spine2: 9, Spine3: 9, Neck: 12, Head: 15,
	RightShoulder: 14, RightArm: 17, RightForeArm: 19, RightHand: 21,
	LeftShoulder: 13, LeftArm: 16, LeftForeArm: 18, LeftHand: 20,
	RightUpLeg: 2, RightLeg: 5, RightFoot: 8, RightToeBase: 11,
	LeftUpLeg: 1, LeftLeg: 4, LeftFoot: 7, LeftToeBase: 10,
};
// Limb rest directions are meaningful (SMPL's A-pose versus cskel27's
// T-pose), so a constant swing aligns those chains without losing source
// twist. Torso, pelvis, neck and head are deliberately absent: SMPL's joint
// regressor forms an anatomical S inside the mesh and its head joint sits
// forward inside the skull. Those are not visible-pose corrections and must
// not deform the target character's bind shape.
const CHILD = {
	RightShoulder: 17, RightArm: 19, RightForeArm: 21, RightHand: 23,
	LeftShoulder: 16, LeftArm: 18, LeftForeArm: 20, LeftHand: 22,
	RightUpLeg: 5, RightLeg: 8, RightFoot: 11,
	LeftUpLeg: 4, LeftLeg: 7, LeftFoot: 10,
};
const BORROW = { RightHandEnd: "RightHand", RightHandThumb1: "RightHand", LeftHandEnd: "LeftHand", LeftHandThumb1: "LeftHand" };
const CORRECTION_BORROW = { RightToeBase: "RightFoot", LeftToeBase: "LeftFoot" };
// Bone lengths measured on the performer, keyed by the cskel27 joint the bone
// ENDS at, as [SMPL from, SMPL to] against [cskel27 from, cskel27 to]. Where
// the two skeletons segment a limb differently the measurement spans the
// whole segment on both sides and every link in it takes the one ratio:
//  - torso: SMPL's three spine joints do not sit where cskel27's four do, so
//    pelvis -> spine3 is one measurement over Spine..Spine3;
//  - shoulder girdle: SMPL's collar is a short stub (8 cm) where Mixamo's
//    clavicle is 16 cm, so spine3 -> shoulder covers Shoulder+Arm together
//    (per-link it read 0.79 / 0.57 and would have pinched the shoulders);
//  - neck, head, hand ends, thumb: geometry of the character, not a limb
//    the mocap measures. cskel27's Neck link (25 cm) already lands on the
//    Mixamo rig at 16 cm — the skin's neck is short by construction — so
//    scaling it by SMPL's 0.84 sank the neck into the chest (measured:
//    Spine2->Neck 16.5 -> 12.5 cm on the rig). Left at 1 like the head.
const LENGTH_SOURCE = {
	Spine: [0, 9], Spine1: [0, 9], Spine2: [0, 9], Spine3: [0, 9],
	RightShoulder: [9, 17], RightArm: [9, 17], RightForeArm: [17, 19], RightHand: [19, 21],
	LeftShoulder: [9, 16], LeftArm: [9, 16], LeftForeArm: [16, 18], LeftHand: [18, 20],
	RightUpLeg: [0, 2], RightLeg: [2, 5], RightFoot: [5, 8], RightToeBase: [8, 11],
	LeftUpLeg: [0, 1], LeftLeg: [1, 4], LeftFoot: [4, 7], LeftToeBase: [7, 10],
};
const LENGTH_TARGET = {
	Spine: ["Hips", "Spine3"], Spine1: ["Hips", "Spine3"], Spine2: ["Hips", "Spine3"], Spine3: ["Hips", "Spine3"],
	RightShoulder: ["Spine3", "RightArm"], RightArm: ["Spine3", "RightArm"],
	LeftShoulder: ["Spine3", "LeftArm"], LeftArm: ["Spine3", "LeftArm"],
};

function data(value) {
	if (value && value.data !== undefined) return value.data;
	if (Array.isArray(value)) return value.flat(Infinity);
	return value;
}
function shape(value, expected, label) {
	const d = data(value);
	if (!d || d.length !== expected.reduce((a, b) => a * b, 1)) throw new Error(`${label} has the wrong size`);
	return d;
}
function vec(a) { const n = Math.hypot(...a); return n > 1e-12 ? a.map((v) => v / n) : [1, 0, 0]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function axisAngle(axis, angle) {
	const [x, y, z] = axis, s = Math.sin(angle), c = Math.cos(angle), t = 1 - c;
	return [[t * x * x + c, t * x * y - s * z, t * x * z + s * y], [t * x * y + s * z, t * y * y + c, t * y * z - s * x], [t * x * z - s * y, t * y * z + s * x, t * z * z + c]];
}
function axisAngleMat(v) {
	const angle = Math.hypot(...v); return angle < 1e-12 ? IDENTITY.map((r) => r.slice()) : axisAngle(v.map((x) => x / angle), angle);
}
function swing(from, to) {
	const a = vec(from), b = vec(to), c = Math.max(-1, Math.min(1, dot(a, b)));
	if (c > 1 - 1e-10) return IDENTITY.map((r) => r.slice());
	let ax = cross(a, b), n = Math.hypot(...ax);
	if (n < 1e-10) {
		ax = Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]); n = Math.hypot(...ax);
		return axisAngle(ax.map((x) => x / n), Math.PI);
	}
	return axisAngle(ax.map((x) => x / n), Math.acos(c));
}
function readAa(flat, frame, joint) { const o = (frame * 23 + joint - 1) * 3; return [flat[o], flat[o + 1], flat[o + 2]]; }
function sourceGlobals(go, pose, frames) {
	const worlds = new Array(frames);
	for (let f = 0; f < frames; f += 1) {
		const out = new Array(24); out[0] = axisAngleMat([go[f * 3], go[f * 3 + 1], go[f * 3 + 2]]);
		for (let j = 1; j < 24; j += 1) out[j] = matMul(out[SMPL_PARENTS[j]], axisAngleMat(readAa(pose, f, j)));
		worlds[f] = out;
	}
	return worlds;
}
function writeMat(out, offset, m) { out[offset] = m[0][0]; out[offset + 1] = m[0][1]; out[offset + 2] = m[0][2]; out[offset + 3] = m[1][0]; out[offset + 4] = m[1][1]; out[offset + 5] = m[1][2]; out[offset + 6] = m[2][0]; out[offset + 7] = m[2][1]; out[offset + 8] = m[2][2]; }
function percentile(values, p) { const a = [...values].sort((x, y) => x - y); const x = (a.length - 1) * p, i = Math.floor(x), t = x - i; return a[i] * (1 - t) + (a[i + 1] ?? a[i]) * t; }

export function smplToCskel27Motion(members, { boneScale: boneScaleOption = "derive" } = {}) {
	if (boneScaleOption !== "derive" && !(typeof boneScaleOption === "number" && Number.isFinite(boneScaleOption) && boneScaleOption > 0)) throw new Error('smplToCskel27Motion: boneScale must be "derive" or a positive number');
	const go = data(members.smpl_global_orient), poseMember = members.smpl_body_pose;
	const goShape = poseMember?.shape?.[0] ?? members.smpl_global_orient?.shape?.[0];
	const frames = Number.isInteger(goShape) ? goShape : go.length / 3;
	if (!Number.isInteger(frames) || frames < 1) throw new Error("smplToCskel27Motion: invalid frame count");
	shape(go, [frames, 3], "smpl_global_orient");
	const pose = shape(poseMember, [frames, 23, 3], "smpl_body_pose");
	const transl = shape(members.smpl_transl, [frames, 3], "smpl_transl");
	const rest = shape(members.smpl_rest_joints, [24, 3], "smpl_rest_joints");
	const fpsValue = data(members.fps); const fps = Number(fpsValue?.[0] ?? fpsValue);
	if (!(fps > 0)) throw new Error("smplToCskel27Motion: invalid fps");
	const skeleton = canonicalCskel27Reference();
	const cpos = skeleton.posed_joints;
	const restVec = (j) => [rest[j * 3], rest[j * 3 + 1], rest[j * 3 + 2]];
	const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
	const boneScale = new Float32Array(27).fill(typeof boneScaleOption === "number" ? boneScaleOption : 1);
	for (let j = 1; j < 27 && boneScaleOption === "derive"; j += 1) {
		const name = CSKEL27_JOINTS[j];
		if (!LENGTH_SOURCE[name]) continue;
		const [s0, s1] = LENGTH_SOURCE[name];
		const source = dist(restVec(s0), restVec(s1));
		const [t0, t1] = LENGTH_TARGET[name] ?? [CSKEL27_JOINTS[CSKEL27_PARENTS[j]], name];
		const target = dist(cpos[CSKEL27_JOINTS.indexOf(t0)], cpos[CSKEL27_JOINTS.indexOf(t1)]);
		if (source > 1e-6 && target > 1e-6) boneScale[j] = source / target;
	}
	const offsets = deriveBoneOffsets(cpos, skeleton.local_rot_mats).map((o, j) => [o[0] * boneScale[j], o[1] * boneScale[j], o[2] * boneScale[j]]);
	const corrections = {};
	for (const [name, sourceChild] of Object.entries(CHILD)) {
		const c = CSKEL27_JOINTS.indexOf(name);
		const targetChild = CSKEL27_PARENTS.findIndex((parent) => parent === c);
		if (c < 0 || targetChild < 0) continue;
		const source = MAP[name];
		const a = [cpos[targetChild][0] - cpos[c][0], cpos[targetChild][1] - cpos[c][1], cpos[targetChild][2] - cpos[c][2]];
		const b = [rest[sourceChild * 3] - rest[source * 3], rest[sourceChild * 3 + 1] - rest[source * 3 + 1], rest[sourceChild * 3 + 2] - rest[source * 3 + 2]];
		corrections[name] = swing(a, b);
	}
	for (const [name, ancestor] of Object.entries(CORRECTION_BORROW)) corrections[name] = corrections[ancestor] ?? IDENTITY;
	const worlds = sourceGlobals(go, pose, frames), rotMats = new Float32Array(frames * 27 * 9), rootPos = new Float32Array(frames * 3), posedJoints = new Float32Array(frames * 27 * 3);
	// The legs now have the performer's length, so the pelvis rides at its
	// filmed height: no ratio between the two skeletons is left to apply.
	const rootScale = 1;
	for (let f = 0; f < frames; f += 1) {
		const globals = new Array(27);
		for (let j = 0; j < 27; j += 1) {
			const name = CSKEL27_JOINTS[j], ancestor = BORROW[name];
			// body_pose is already a rotation FROM SMPL's zero pose. Torso/head
			// therefore keep cskel27's bind shape; only visible limb rest-pose
			// differences use the constant correction built above.
			globals[j] = ancestor ? globals[CSKEL27_JOINTS.indexOf(ancestor)] : matMul(worlds[f][MAP[name]], corrections[name] ?? IDENTITY);
		}
		for (let j = 0; j < 27; j += 1) {
			const p = CSKEL27_PARENTS[j], local = p === null ? globals[j] : matMul(matTranspose(globals[p]), globals[j]);
			writeMat(rotMats, (f * 27 + j) * 9, local);
		}
		rootPos[f * 3] = transl[f * 3] * rootScale; rootPos[f * 3 + 1] = transl[f * 3 + 1] * rootScale; rootPos[f * 3 + 2] = transl[f * 3 + 2] * rootScale;
	}
	const readLocals = (f) => Array.from({ length: 27 }, (_, j) => { const o = (f * 27 + j) * 9; return [[rotMats[o], rotMats[o + 1], rotMats[o + 2]], [rotMats[o + 3], rotMats[o + 4], rotMats[o + 5]], [rotMats[o + 6], rotMats[o + 7], rotMats[o + 8]]]; });
	const lows = new Array(frames);
	for (let f = 0; f < frames; f += 1) { const p = forwardKinematics(readLocals(f), offsets, [rootPos[f * 3], rootPos[f * 3 + 1], rootPos[f * 3 + 2]]); lows[f] = Math.min(...[21, 22, 25, 26].map((j) => p[j][1])); }
	const floor = percentile(lows, 0.1);
	for (let f = 0; f < frames; f += 1) { rootPos[f * 3 + 1] -= floor; const p = forwardKinematics(readLocals(f), offsets, [rootPos[f * 3], rootPos[f * 3 + 1], rootPos[f * 3 + 2]]); for (let j = 0; j < 27; j += 1) posedJoints.set(p[j], (f * 27 + j) * 3); }
	return { frames, fps, rotMats, rootPos, posedJoints, boneScale, personScale: 1, rawRootStart: [transl[0], transl[1], transl[2]] };
}
