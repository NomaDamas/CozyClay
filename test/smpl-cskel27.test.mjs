import test from "node:test";
import assert from "node:assert/strict";
import { smplToCskel27Motion } from "../tools/ardy/smpl-cskel27.mjs";
import { CSKEL27_JOINTS } from "../src/ardy/cskel27.js";
import { canonicalCskel27Reference } from "../src/ardy/to-cskel27.js";
import { globalRotations, matTranspose, matMul, quatToMat, forwardKinematics } from "../src/ardy/convert.js";
import { existsSync } from "node:fs";
import { readNpz } from "../tools/kimodo/read-npz.mjs";

const rest = (() => {
	const p = Array.from({ length: 24 }, () => [0, 0, 0]);
	p[0] = [0, 0, 0]; p[1] = [0.065, -0.091, -0.013]; p[2] = [-0.065, -0.091, -0.013];
	p[3] = [0, 0.108, -0.005]; p[4] = [0.098, -0.470, -0.022]; p[5] = [-0.098, -0.470, -0.022];
	p[6] = [0, 0.245, 0.008]; p[7] = [0.083, -0.867, -0.063]; p[8] = [-0.083, -0.867, -0.063];
	p[9] = [0, 0.301, 0.026]; p[10] = [0.109, -0.923, 0.053]; p[11] = [-0.109, -0.923, 0.053];
	p[12] = [0, 0.521, -0.004]; p[13] = [0.072, 0.418, -0.009]; p[14] = [-0.072, 0.418, -0.009];
	p[15] = [0, 0.581, 0.026]; p[16] = [0.153, 0.440, -0.016]; p[17] = [-0.153, 0.440, -0.016];
	p[18] = [0.399, 0.394, -0.040]; p[19] = [-0.399, 0.394, -0.040];
	p[20] = [0.635, 0.398, -0.042]; p[21] = [-0.635, 0.398, -0.042];
	p[22] = [0.715, 0.398, -0.042]; p[23] = [-0.715, 0.398, -0.042];
	return p;
})();
const parents = [-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19, 20, 21];
const axis = (a, n) => [a[0] * n, a[1] * n, a[2] * n];
const aa = (a, n) => axis(a, n);
function sourceFk(globalOrient, bodyPose, transl) {
	const locals = [quatToMat([Math.cos(Math.hypot(...globalOrient) / 2), ...axis(globalOrient, Math.sin(Math.hypot(...globalOrient) / 2) / (Math.hypot(...globalOrient) || 1))])];
	for (let j = 1; j < 24; j += 1) locals[j] = quatToMat([Math.cos(Math.hypot(...bodyPose[j - 1]) / 2), ...axis(bodyPose[j - 1], Math.sin(Math.hypot(...bodyPose[j - 1]) / 2) / (Math.hypot(...bodyPose[j - 1]) || 1))]);
	const worlds = new Array(24), positions = new Array(24);
	for (let j = 0; j < 24; j += 1) {
		worlds[j] = parents[j] < 0 ? locals[j] : matMul(worlds[parents[j]], locals[j]);
		if (parents[j] < 0) positions[j] = [...transl];
		else { const d = [rest[j][0] - rest[parents[j]][0], rest[j][1] - rest[parents[j]][1], rest[j][2] - rest[parents[j]][2]]; const q = worlds[parents[j]]; positions[j] = [positions[parents[j]][0] + q[0][0] * d[0] + q[0][1] * d[1] + q[0][2] * d[2], positions[parents[j]][1] + q[1][0] * d[0] + q[1][1] * d[1] + q[1][2] * d[2], positions[parents[j]][2] + q[2][0] * d[0] + q[2][1] * d[1] + q[2][2] * d[2]]; }
	}
	return positions;
}
function member(data, shape) { return { data: Float32Array.from(data.flat(Infinity)), shape }; }
function fixture(frames = 3) {
	const go = Array.from({ length: frames }, (_, f) => [0, f * 0.08, 0]);
	const pose = Array.from({ length: frames }, () => Array.from({ length: 23 }, () => [0, 0, 0]));
	pose[1][17] = aa([0, 0, 1], Math.PI / 3); pose[1][19] = aa([1, 0, 0], Math.PI * 40 / 180);
	pose[2][3] = aa([0, 0, 1], Math.PI / 4); pose[2][4] = aa([0, 0, 1], Math.PI / 4);
	return { smpl_global_orient: member(go, [frames, 3]), smpl_body_pose: member(pose, [frames, 23, 3]), smpl_transl: member(Array.from({ length: frames }, (_, f) => [f * 0.02, 1, 0]), [frames, 3]), smpl_rest_joints: member(rest, [24, 3]), smpl_joints: member(go.map((_, f) => sourceFk(go[f], pose[f], [f * 0.02, 1, 0])), [frames, 24, 3]), fps: { data: Float32Array.from([30]), shape: [] } };
}
const sourceByTarget = {
	Hips: 0, Spine: 3, Spine1: 6, Spine2: 9, Spine3: 9, Neck: 12, Head: 15,
	RightShoulder: 14, RightArm: 17, RightForeArm: 19, RightHand: 21,
	LeftShoulder: 13, LeftArm: 16, LeftForeArm: 18, LeftHand: 20,
	RightUpLeg: 2, RightLeg: 5, RightFoot: 8, RightToeBase: 11,
	LeftUpLeg: 1, LeftLeg: 4, LeftFoot: 7, LeftToeBase: 10,
};
function rotationGlobals(globalOrient, bodyPose) {
	const aaMat = (v) => {
		const n = Math.hypot(...v);
		return quatToMat([Math.cos(n / 2), ...axis(v, Math.sin(n / 2) / (n || 1))]);
	};
	const out = [aaMat(globalOrient)];
	for (let j = 1; j < 24; j += 1) out[j] = matMul(out[parents[j]], aaMat(bodyPose[j - 1]));
	return out;
}
function motionGlobals(motion, frame) {
	const locals = Array.from({ length: 27 }, (_, j) => {
		const o = (frame * 27 + j) * 9, a = motion.rotMats;
		return [[a[o], a[o + 1], a[o + 2]], [a[o + 3], a[o + 4], a[o + 5]], [a[o + 6], a[o + 7], a[o + 8]]];
	});
	return globalRotations(locals);
}
function maxRetargetDrift(input, motion) {
	let max = 0; const baseline = new Map();
	for (let f = 0; f < motion.frames; f += 1) {
		const go = Array.from(input.smpl_global_orient.data.slice(f * 3, f * 3 + 3));
		const pose = Array.from({ length: 23 }, (_, j) => Array.from(input.smpl_body_pose.data.slice((f * 23 + j) * 3, (f * 23 + j + 1) * 3)));
		const source = rotationGlobals(go, pose), target = motionGlobals(motion, f);
		for (const [name, sourceJoint] of Object.entries(sourceByTarget)) {
			const correction = matMul(matTranspose(source[sourceJoint]), target[CSKEL27_JOINTS.indexOf(name)]);
			if (!baseline.has(name)) baseline.set(name, correction);
			const expected = baseline.get(name);
			for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) max = Math.max(max, Math.abs(correction[r][c] - expected[r][c]));
		}
	}
	return max;
}

test("synthetic SMPL rotation retarget preserves global articulation and twist", () => {
	const input = fixture(), motion = smplToCskel27Motion(input); const error = maxRetargetDrift(input, motion); console.log(`max retarget correction drift: ${error}`); assert.ok(error <= 1e-6);
	assert.ok([...motion.rotMats, ...motion.posedJoints].every(Number.isFinite));
	const h = CSKEL27_JOINTS.indexOf("LeftHand"), o = (1 * 27 + h) * 9; const local = [[motion.rotMats[o], motion.rotMats[o + 1], motion.rotMats[o + 2]], [motion.rotMats[o + 3], motion.rotMats[o + 4], motion.rotMats[o + 5]], [motion.rotMats[o + 6], motion.rotMats[o + 7], motion.rotMats[o + 8]]]; assert.ok(Math.abs(Math.acos(Math.max(-1, Math.min(1, (local[0][0] + local[1][1] + local[2][2] - 1) / 2))) * 180 / Math.PI - 40) <= 3);
});
test("still input is deterministic and finite", () => { const input = fixture(12); input.smpl_global_orient.data.fill(0); input.smpl_body_pose.data.fill(0); const motion = smplToCskel27Motion(input); for (let f = 1; f < 12; f += 1) assert.deepEqual(Array.from(motion.rotMats.slice(0, 243)), Array.from(motion.rotMats.slice(f * 243, (f + 1) * 243))); assert.ok([...motion.posedJoints].every(Number.isFinite)); });
const realPath = "/tmp/sam3ab/gvhmr-walk-rot.npz";
test("real GVHMR walk keeps one constant retarget frame per joint", { skip: !existsSync(realPath) ? "skipped: /tmp/sam3ab/gvhmr-walk-rot.npz is absent" : false }, (t) => { let input; try { input = readNpz(realPath); } catch (error) { t.skip(`skipped: readNpz could not consume present file (${error.message})`); return; } const motion = smplToCskel27Motion(input); const error = maxRetargetDrift(input, motion); console.log(`real max retarget correction drift: ${error}`); assert.ok(error <= 1e-5); });

// Proportions: a mocap take wears the performer's limb lengths, not the
// canonical body's. Measured on the synthetic rest above, so the expected
// lengths are known exactly.
test("posed limb lengths equal the SMPL rest limb lengths and boneScale says so", () => {
	const input = fixture(3); input.smpl_global_orient.data.fill(0); input.smpl_body_pose.data.fill(0);
	const motion = smplToCskel27Motion(input);
	const J = (n) => CSKEL27_JOINTS.indexOf(n);
	const at = (f, j) => Array.from(motion.posedJoints.slice((f * 27 + j) * 3, (f * 27 + j + 1) * 3));
	const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
	const smpl = (a, b) => len(rest[a], rest[b]);
	for (const f of [0, 1]) {
		assert.ok(Math.abs(len(at(f, J("LeftUpLeg")), at(f, J("LeftLeg"))) - smpl(1, 4)) < 1e-3, "thigh");
		assert.ok(Math.abs(len(at(f, J("LeftLeg")), at(f, J("LeftFoot"))) - smpl(4, 7)) < 1e-3, "shin");
		assert.ok(Math.abs(len(at(f, J("LeftArm")), at(f, J("LeftForeArm"))) - smpl(16, 18)) < 1e-3, "upper arm");
		assert.ok(Math.abs(len(at(f, J("LeftForeArm")), at(f, J("LeftHand"))) - smpl(18, 20)) < 1e-3, "forearm");
		// The four spine links are scaled by one ratio taken on the straight
		// pelvis->spine3 distance; the chain itself is slightly curved, so the
		// invariant is that the CURVE scales by that ratio, i.e. the polyline
		// length grows by exactly boneScale[Spine].
		const chain = ["Hips", "Spine", "Spine1", "Spine2", "Spine3"];
		const polyline = chain.slice(1).reduce((sum, n, i) => sum + len(at(f, J(chain[i])), at(f, J(n))), 0);
		const canonPoly = chain.slice(1).reduce((sum, n, i) => sum + len(canonicalCskel27Reference().posed_joints[J(chain[i])], canonicalCskel27Reference().posed_joints[J(n)]), 0);
		assert.ok(Math.abs(polyline / canonPoly - motion.boneScale[J("Spine")]) < 1e-6, "torso");
	}
	const canon = canonicalCskel27Reference().posed_joints;
	const canonLen = (a, b) => len(canon[J(a)], canon[J(b)]);
	assert.ok(Math.abs(motion.boneScale[J("LeftLeg")] - smpl(1, 4) / canonLen("LeftUpLeg", "LeftLeg")) < 1e-6);
	assert.ok(Math.abs(motion.boneScale[J("LeftForeArm")] - smpl(16, 18) / canonLen("LeftArm", "LeftForeArm")) < 1e-6);
	assert.equal(motion.boneScale[J("Hips")], 1);
	assert.equal(motion.boneScale[J("Head")], 1, "head is character geometry, not measured");
	assert.equal(motion.personScale, 1);
	// Standing on real legs: the lowest foot sits on the floor after the shift.
	let low = Infinity; for (const j of ["LeftFoot", "RightFoot", "LeftToeBase", "RightToeBase"]) low = Math.min(low, at(0, J(j))[1]);
	assert.ok(Math.abs(low) < 1e-3);
});
test("bone-scale override uses one uniform factor without changing timing", () => {
	const input = fixture(3), derived = smplToCskel27Motion(input), uniform = smplToCskel27Motion(input, { boneScale: 1 });
	assert.equal(uniform.frames, derived.frames); assert.equal(uniform.fps, derived.fps);
	assert.ok([...uniform.boneScale].every((value) => value === 1)); assert.ok([...derived.boneScale].some((value) => value !== 1));
});

// Retarget POSE rotations, not the anatomical shape of SMPL's J-regressor.
// Its zero-pose spine is an S curve and its head joint sits ~43 degrees in
// front of the neck. Copying those internal directions into a Mixamo mesh
// visibly folds the belly/chest before the performer has moved at all.
test("zero pose keeps the target bind shape through spine, neck and head", () => {
	const input = fixture(3); input.smpl_global_orient.data.fill(0); input.smpl_body_pose.data.fill(0);
	// Real SMPL neutral neck/head stubs measured on the GVHMR rest skeleton.
	const r = input.smpl_rest_joints.data;
	const set = (j, v) => { r[j * 3] = v[0]; r[j * 3 + 1] = v[1]; r[j * 3 + 2] = v[2]; };
	set(12, [rest[9][0] - 0.003, rest[9][1] + 0.217, rest[9][2] - 0.052]);
	set(15, [r[12 * 3] + 0.005, r[12 * 3 + 1] + 0.059, r[12 * 3 + 2] + 0.055]);
	const motion = smplToCskel27Motion(input);
	const J = (n) => CSKEL27_JOINTS.indexOf(n);
	const at = (f, j) => Array.from(motion.posedJoints.slice((f * 27 + j) * 3, (f * 27 + j + 1) * 3));
	const bind = canonicalCskel27Reference().posed_joints;
	const angle = (a, b, c, d) => {
		const u = b.map((v, i) => v - a[i]), v = d.map((x, i) => x - c[i]);
		return Math.acos(Math.max(-1, Math.min(1, u.reduce((sum, x, i) => sum + x * v[i], 0) / Math.hypot(...u) / Math.hypot(...v)))) * 180 / Math.PI;
	};
	for (const [a, b] of [["Hips", "Spine"], ["Spine", "Spine1"], ["Spine1", "Spine2"], ["Spine2", "Spine3"], ["Spine3", "Neck"], ["Neck", "Head"]]) {
		const error = angle(at(0, J(a)), at(0, J(b)), bind[J(a)], bind[J(b)]);
		assert.ok(error < 0.05, `${a}->${b} changed target bind direction by ${error.toFixed(3)} degrees`);
	}
});
