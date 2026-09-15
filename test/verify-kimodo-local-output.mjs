import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLocalKimodoNpz } from "../tools/kimodo/local-output.mjs";
import { readKimodoMotion, readNpz } from "../tools/kimodo/read-npz.mjs";
import { soma77ToCskel27Motion } from "../tools/kimodo/soma77-to-cskel27.mjs";

const work = mkdtempSync(join(tmpdir(), "kimodo-local-output-"));
const rootPath = join(work, "root_positions.f32");
const rotationPath = join(work, "local_rotations_xyzw.f32");
const output = join(work, "take.npz");
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const RY = [0, 0, 1, 0, 1, 0, -1, 0, 0];
const RYRZ = [0, 0, 1, 1, 0, 0, 0, 1, 0];
const roots = [[1.25, 2, -3], [-4, 0.5, 6], [2, 3, 4]];
// Independently extracted from NVIDIA's neutral joints asset, not converter exports.
const arm = [0.16527769707014453, 0.4291629326601865, -0.012884350363538723];
const forearmOffset = [0.287393077898987, 2.5026838934572022e-9, -0.000025878773664946];
const handOffset = [0.2709398120004038, -7.066251084264952e-9, 0.000026089724817621];
const thumbRest = [0.980038046836853, 0.10456321388483047, 0.16909213364124298,
	-0.10096757858991623, 0.9944452047348022, -0.02974773570895195,
	-0.17126333713531494, 0.012080984190106392, 0.985151469707489];
function near(actual, expected, label) {
	assert.equal(actual.length, expected.length, label);
	for (let i = 0; i < actual.length; i++) assert.ok(Math.abs(actual[i] - expected[i]) < 2e-6,
		`${label}[${i}]: ${actual[i]} != ${expected[i]}`);
}
function f32(path, values) {
	const bytes = Buffer.alloc(values.length * 4);
	values.forEach((value, i) => bytes.writeFloatLE(value, i * 4));
	writeFileSync(path, bytes);
}
function fixture(frames = 1) {
	const rotations = new Array(frames * 30 * 4).fill(0);
	for (let i = 3; i < rotations.length; i += 4) rotations[i] = 1;
	f32(rootPath, roots.slice(0, frames).flat());
	f32(rotationPath, rotations);
	return rotations;
}
function position(motion, frame, joint) { return motion.posedJoints.slice((frame * 77 + joint) * 3, (frame * 77 + joint + 1) * 3); }
function matrix(motion, frame, joint) { return motion.globalRotMats.slice((frame * 77 + joint) * 9, (frame * 77 + joint + 1) * 9); }
function add(a, b) { return a.map((x, i) => x + b[i]); }
function y90([x, y, z]) { return [z, y, -x]; }
function z90([x, y, z]) { return [-y, x, z]; }
function rejectsFile(mutate, pattern) {
	fixture();
	mutate();
	const before = readFileSync(output);
	assert.throws(() => writeLocalKimodoNpz(work, output, { expectedFrames: 1 }), pattern);
	assert.deepEqual(readFileSync(output), before, "invalid input must not overwrite a good NPZ");
}
try {
	fixture();
	writeLocalKimodoNpz(work, output, { expectedFrames: 1 });
	const rest = readKimodoMotion(output);
	assert.equal(rest.frames, 1);
	assert.equal(rest.joints, 77);
	assert.equal(rest.fps, 30);
	const members = readNpz(output);
	assert.deepEqual(members.posed_joints.shape, [1, 77, 3]);
	assert.deepEqual(members.global_rot_mats.shape, [1, 77, 3, 3]);
	assert.equal(members.posed_joints.dtype, "<f4");
	assert.equal(members.global_rot_mats.dtype, "<f4");
	assert.deepEqual(members.fps.shape, []);
	near(position(rest, 0, 0), roots[0], "root world translation, no pelvis offset");
	near(position(rest, 0, 1), add(roots[0], [-0.00013727, 0.050037625614476805, -0.0005372666896067667]), "Spine1 rest");
	near(position(rest, 0, 12), add(roots[0], arm), "arm rest");
	near(position(rest, 0, 69), add(roots[0], [0.10043214, -0.9381137633633632, -0.016887810498092126]), "LeftFoot rest");
	near(position(rest, 0, 76), add(roots[0], [-0.10037743671281639, -1.0048884756355425, 0.18081150073751506]), "RightToeEnd rest");
	near(position(rest, 0, 18), add(roots[0], [0.8420162306335847, 0.3761233312997569, 0.013589434439147854]), "relaxed thumb endpoint");
	near(position(rest, 0, 28), add(roots[0], [0.8896022277884339, 0.371272506263597, -0.0198056002247797]), "relaxed middle endpoint");
	near(matrix(rest, 0, 12), I, "body identity");
	near(matrix(rest, 0, 15), thumbRest, "missing finger uses upstream relaxed hand, not identity");

	const rotations = fixture(3);
	const q = Math.SQRT1_2;
	rotations.splice((1 * 30) * 4, 4, 0, q, 0, q);
	// Root Y90 and arm Z90 do not commute. Non-unit and negative q are equivalent rotations.
	rotations.splice((2 * 30) * 4, 4, 0, -2 * q, 0, -2 * q);
	rotations.splice((2 * 30 + 11) * 4, 4, 0, 0, 3 * q, 3 * q);
	f32(rotationPath, rotations);
	writeLocalKimodoNpz(work, output, { expectedFrames: 3 });
	const motion = readKimodoMotion(output);
	for (let j = 0; j < 77; j++) {
		near(position(motion, 0, j), position(rest, 0, j), `frame-major rest joint ${j}`);
		const relative = Array.from(position(rest, 0, j), (x, k) => x - roots[0][k]);
		near(position(motion, 1, j), add(roots[1], y90(relative)), `root Y90 joint ${j}`);
	}
	near(matrix(motion, 1, 12), RY, "root Y90 propagates");
	near(matrix(motion, 2, 12), RYRZ, "global = parent times local");
	near(matrix(motion, 2, 13), RYRZ, "non-root rotation propagates to descendants");
	near(matrix(motion, 2, 40), RY, "other branch unaffected");
	near(position(motion, 2, 12), add(roots[2], y90(arm)), "arm pivot unaffected by own rotation");
	near(position(motion, 2, 13), add(roots[2], y90(add(arm, z90(forearmOffset)))), "analytic rotated forearm");
	near(position(motion, 2, 14), add(roots[2], y90(add(arm, z90(add(forearmOffset, handOffset))))), "analytic rotated hand");
	const studio = soma77ToCskel27Motion(motion);
	assert.equal(studio.frames, 3);
	assert.equal(studio.fps, 30);
	assert.equal(studio.rotMats.length, 3 * 27 * 9);
	assert.ok([...studio.rotMats, ...studio.posedJoints].every(Number.isFinite));

	// File boundaries: no implicit partial frame, guessed joint layout, or bad arithmetic.
	rejectsFile(() => rmSync(rootPath), /root_positions\.f32/);
	rejectsFile(() => rmSync(rotationPath), /local_rotations_xyzw\.f32/);
	rejectsFile(() => writeFileSync(rootPath, Buffer.alloc(0)), /root_positions.*(?:empty|frame|bytes)/i);
	rejectsFile(() => writeFileSync(rootPath, Buffer.alloc(11)), /root_positions.*(?:frame|bytes)/i);
	rejectsFile(() => writeFileSync(rotationPath, Buffer.alloc(479)), /local_rotations.*(?:30|bytes|frame)/i);
	rejectsFile(() => writeFileSync(rotationPath, Buffer.alloc(484)), /local_rotations.*(?:30|bytes|frame)/i);
	rejectsFile(() => writeFileSync(rotationPath, Buffer.alloc(77 * 16)), /local_rotations.*(?:30|bytes|frame)/i);
	rejectsFile(() => f32(rootPath, [1, 2, 3, 4, 5, 6]), /(?:expectedFrames|expected.*1|frames)/i);
	for (const value of [NaN, Infinity, -Infinity]) {
		rejectsFile(() => f32(rootPath, [1, value, 3]), /root_positions.*non-finite/i);
		rejectsFile(() => { const values = fixture(); values[17] = value; f32(rotationPath, values); }, /local_rotations.*non-finite/i);
	}
	rejectsFile(() => { const values = fixture(); values.fill(0, 4, 8); f32(rotationPath, values); }, /(?:zero.*quaternion|quaternion.*zero)/i);
	fixture();
	for (const expectedFrames of [0, -1, 1.5, NaN, Infinity, "1"]) {
		assert.throws(() => writeLocalKimodoNpz(work, output, { expectedFrames }), /expectedFrames/);
	}
	writeLocalKimodoNpz(work, output);
	assert.equal(readKimodoMotion(output).frames, 1, "optional expectedFrames infers from root bytes");
	assert.throws(() => writeLocalKimodoNpz(work, join(work, "missing", "take.npz")), /ENOENT/);
	assert.equal(existsSync(join(work, "missing", "take.npz")), false);
	console.log("kimodo local output: identity/rest, relaxed SOMA30 -> SOMA77, analytic rotations, NPZ integration and malformed-file checks passed");
} finally {
	rmSync(work, { recursive: true, force: true });
}
