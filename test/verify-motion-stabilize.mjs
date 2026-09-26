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

test("short multi-frame detector dropout is corrected without flattening a jump", () => {
	const input = motion(24);
	for (let f = 0; f < input.frames; f += 1) {
		const x = f * 0.01 + (f >= 15 ? Math.min((f - 15) * 0.02, 0.12) : 0);
		for (let j = 0; j < 27; j += 1) input.posedJoints[(f * 27 + j) * 3] = x;
	}
	for (const f of [8, 9, 10]) for (let j = 0; j < 27; j += 1) input.posedJoints[(f * 27 + j) * 3] += 0.12;
	for (const f of [8, 9, 10]) input.posedJoints[(f * 27) * 3 + 1] += 0.12;
	const output = stabilizeMotion(input);
	for (const f of [8, 9, 10]) {
		const expected = f * 0.01;
		assert.ok(Math.abs(output.posedJoints[(f * 27 + 1) * 3] - expected) < .045, `dropout remains at frame ${f}`);
	}
	assert.ok(output.posedJoints[(9 * 27) * 3 + 1] > 1.06, "real root ascent was flattened");
	// A real, gradual vertical/forward jump remains intact after the dropout.
	assert.ok(output.posedJoints[(20 * 27) * 3] > .19, "real post-dropout travel was flattened");
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

// Foot-anchored root re-integration (#380). GVHMR's integrated root velocity
// under-scales the stride on rendered clips (measured on v13c: the stance
// ankle moonwalked at 45 cm/s while the hips advanced 49 cm/s), and its
// contact logits do not correlate with planted frames (r <= 0.09), so the
// anchor is derived from the take itself: whichever foot is lowest and
// slowest carries the body, and the root is re-integrated so that foot holds
// its world position over its stance run.
test("anchored feet stop skating while swing feet and stride keep their shape", () => {
	const frames = 48, fps = 24;
	const input = motion(frames);
	// A walk along +X: the hips advance 2 cm/frame; each foot alternates
	// 12-frame stance / 12-frame swing. In stance the ankle SHOULD be still,
	// but the authored take slides it backward 1 cm/frame (root under-scaled).
	const RF = 21, RT = 22, LF = 25, LT = 26;
	for (let f = 0; f < frames; f += 1) {
		const hip = f * 0.02;
		for (let j = 0; j < 27; j += 1) { const o = (f * 27 + j) * 3; input.posedJoints[o] = hip; input.posedJoints[o + 1] = j === 0 ? 0.95 : 0.9 - j * 0.01; input.posedJoints[o + 2] = 0; }
		input.rootPos[f * 3] = hip;
		// One foot: 12 frames of stance that slides BACK 1 cm/frame (the
		// defect), then 12 frames of swing that lands exactly where the next
		// stance starts, one stride (S) further on. The left foot is the same
		// gait half a cycle later.
		const S = 0.48;
		const foot = (phase, shift) => {
			const t = f + phase, cycle = Math.floor(t / 24), k = t % 24;
			if (k < 12) return { x: cycle * S - k * 0.01 + shift, y: 0.05 };
			const kk = k - 12, from = cycle * S - 0.11, to = (cycle + 1) * S;
			return { x: from + (kk + 1) * (to - from) / 12 + shift, y: 0.05 + 0.12 * Math.sin(Math.PI * (kk + 0.5) / 12) };
		};
		const r = foot(0, 0), l = foot(12, 0.2);
		for (const [j, p] of [[RF, r], [RT, r], [LF, l], [LT, l]]) { const o = (f * 27 + j) * 3; input.posedJoints[o] = p.x; input.posedJoints[o + 1] = p.y; }
	}
	const output = stabilizeMotion(input, { anchorFeet: true });
	const at = (arr, f, j, a) => arr[(f * 27 + j) * 3 + a];
	// Second right-foot stance run f=24..35: the anchored foot holds its x.
	// The authored slide is 1 cm/frame; the pass leaves a residual only where
	// its ~150 ms velocity ramp overlaps the run's edges, so the middle of the
	// run is what stance means here (the first run starts at f=0 with no
	// lead-in and is the ramp's worst case, not the typical stance).
	let slide = 0;
	for (let f = 28; f < 33; f += 1) slide = Math.max(slide, Math.abs(at(output.posedJoints, f, RF, 0) - at(output.posedJoints, f - 1, RF, 0)));
	assert.ok(slide < 0.002, `stance foot still slides ${(slide * 100).toFixed(2)} cm/frame`);
	// And the run as a whole moved far less than authored (1 cm/frame × 11).
	const runDrift = Math.abs(at(output.posedJoints, 35, RF, 0) - at(output.posedJoints, 24, RF, 0));
	assert.ok(runDrift < 0.03, `stance run drifted ${(runDrift * 100).toFixed(1)} cm (authored 11)`);
	// The body still travels forward over the whole take (not frozen).
	assert.ok(output.rootPos[(frames - 1) * 3] - output.rootPos[0] > 0.5, "root travel was flattened");
	// Every joint moved by the same per-frame offset as the root (rigid shift).
	for (let f = 0; f < frames; f += 1) {
		const dx = output.rootPos[f * 3] - input.rootPos[f * 3];
		assert.ok(Math.abs((at(output.posedJoints, f, 6, 0) - at(input.posedJoints, f, 6, 0)) - dx) < 1e-5, "head offset equals root offset");
	}
	assert.ok(output.stabilization.anchoredFrames > 0);
	assert.equal(stabilizeMotion(input).stabilization.anchoredFrames, 0, "anchoring is opt-in");
});

