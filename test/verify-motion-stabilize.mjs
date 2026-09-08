import test from "node:test";
import assert from "node:assert/strict";
import { stabilizeMotion } from "../tools/ardy/motion-stabilize.mjs";

function motion(frames = 9) {
	const rootPos = new Float32Array(frames * 3);
	const posedJoints = new Float32Array(frames * 27 * 3);
	const rotMats = new Float32Array(frames * 27 * 9);
	for (let f = 0; f < frames; f += 1) {
		rootPos[f * 3] = f * 0.06;
		for (let j = 0; j < 27; j += 1) {
			const o = (f * 27 + j) * 3;
			posedJoints[o] = f * 0.06; posedJoints[o + 1] = j === 0 ? 1 : 1 - j * .02; posedJoints[o + 2] = 0;
			const r = (f * 27 + j) * 9; rotMats[r] = 1; rotMats[r + 4] = 1; rotMats[r + 8] = 1;
		}
	}
	// A one-frame segmentation spike on the hips and foot.
	posedJoints[(4 * 27) * 3] += .18; posedJoints[(4 * 27 + 7) * 3 + 1] += .12;
	return { frames, fps: 30, rootPos, posedJoints, rotMats, boneScale: new Float32Array(27).fill(1), personScale: 1 };
}

test("stabilization suppresses isolated positional spikes and keeps root coherent", () => {
	const input = motion(); const output = stabilizeMotion(input);
	const spike = output.posedJoints[(4 * 27) * 3];
	assert.ok(Math.abs(spike - .24) < .08, `spike retained too much: ${spike}`);
	assert.equal(output.rootPos[4 * 3], spike, "root follows filtered Hips");
	assert.ok(output.stabilization.correctedPositions > 0);
});

test("high-speed translation remains close to the authored trajectory", () => {
	const input = motion();
	for (let f = 0; f < input.frames; f += 1) for (let j = 0; j < 27; j += 1) input.posedJoints[(f * 27 + j) * 3] = f * .5;
	const output = stabilizeMotion(input);
	assert.ok(Math.abs(output.posedJoints[(4 * 27) * 3] - 2) < .03, "fast step should not be smoothed away");
});

test("optional contact height is explicit and bounded", () => {
	const input = motion();
	assert.equal(stabilizeMotion(input).stabilization.correctedContacts, 0, "no surface means no guessed contact snap");
	const output = stabilizeMotion(input, { contactHeight: .52 });
	assert.equal(output.stabilization.contactHeight, .52);
	assert.ok(output.stabilization.correctedContacts >= 0);
	assert.ok([...output.rootPos, ...output.posedJoints].every(Number.isFinite));
	for (let f = 0; f < output.frames; f += 1) for (let j = 0; j < 27; j += 1) {
		const o = (f * 27 + j) * 9; const a = output.rotMats[o]; const b = output.rotMats[o + 1]; const c = output.rotMats[o + 2];
		const d = output.rotMats[o + 3]; const e = output.rotMats[o + 4]; const g = output.rotMats[o + 5];
		const h = output.rotMats[o + 6]; const i = output.rotMats[o + 7]; const k = output.rotMats[o + 8];
		assert.ok(Math.abs(a * a + b * b + c * c - 1) < 1e-4 && Math.abs(d * d + e * e + g * g - 1) < 1e-4 && Math.abs(h * h + i * i + k * k - 1) < 1e-4, "rotation rows remain unit length");
	}
});
