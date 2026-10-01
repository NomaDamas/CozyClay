import test from "node:test";
import assert from "node:assert/strict";
import { stabilizeMotion } from "../tools/ardy/motion-stabilize.mjs";
import { CSKEL27_PARENTS } from "../src/ardy/cskel27.js";
import { CSKEL27_NEUTRAL } from "../src/ardy/cskel27-neutral.js";

// Every fixture here is a kinematically consistent take, built the way the
// GVHMR conversion builds one: local rotations + root, with posedJoints grown
// by FK over the canonical cskel27 bones scaled per joint by boneScale. The FK
// below is written out independently of src/ardy/convert.js and of the
// stabilizer, so the invariant test cannot pass by sharing a bug with them.

const J = 27;
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const [HIPS, RIGHT_ARM, RIGHT_FOREARM, RIGHT_HAND, LEFT_ARM, HEAD] = [0, 8, 9, 10, 14, 6];
const RIGHT_LEG = { up: 19, knee: 20, ankle: 21, toe: 22 };
const LEFT_LEG = { up: 23, knee: 24, ankle: 25, toe: 26 };

/** Row-major 3x3 rotation about a unit axis. */
function axisAngle([x, y, z], angle) {
	const s = Math.sin(angle), c = Math.cos(angle), t = 1 - c;
	return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}
function mul(a, b) {
	const out = new Array(9);
	for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
	return out;
}
const rotAt = (rotMats, f, j) => Array.from(rotMats.subarray((f * J + j) * 9, (f * J + j + 1) * 9));
/** Angle (rad) of a row-major rotation matrix. */
const angleOf = (m) => Math.acos(Math.max(-1, Math.min(1, (m[0] + m[4] + m[8] - 1) / 2)));

/** Independent FK: joint = parent + parentGlobal * (neutral bone * boneScale[joint]). */
function fk(rotMats, rootPos, frames, boneScale) {
	const out = new Float32Array(frames * J * 3);
	for (let f = 0; f < frames; f += 1) {
		const globals = new Array(J), positions = new Array(J);
		for (let j = 0; j < J; j += 1) {
			const p = CSKEL27_PARENTS[j], local = rotAt(rotMats, f, j);
			if (p === null) { globals[j] = local; positions[j] = [rootPos[f * 3], rootPos[f * 3 + 1], rootPos[f * 3 + 2]]; } else {
				const g = globals[p], s = boneScale[j];
				const bone = [0, 1, 2].map((a) => (CSKEL27_NEUTRAL[j][a] - CSKEL27_NEUTRAL[p][a]) * s);
				positions[j] = [0, 1, 2].map((a) => positions[p][a] + g[a * 3] * bone[0] + g[a * 3 + 1] * bone[1] + g[a * 3 + 2] * bone[2]);
				globals[j] = mul(g, local);
			}
			out.set(positions[j], (f * J + j) * 3);
		}
	}
	return out;
}

/** A consistent take from a root path and per-joint local rotations (identity when `rot` returns null). */
function take({ frames, fps = 30, root, rot = () => null, boneScale = new Float32Array(J).fill(1) }) {
	const rootPos = new Float32Array(frames * 3), rotMats = new Float32Array(frames * J * 9);
	for (let f = 0; f < frames; f += 1) {
		rootPos.set(root(f), f * 3);
		for (let j = 0; j < J; j += 1) rotMats.set(rot(f, j) ?? IDENTITY, (f * J + j) * 9);
	}
	return { frames, fps, rootPos, rotMats, posedJoints: fk(rotMats, rootPos, frames, boneScale), boneScale, personScale: 1 };
}

const at = (arr, f, j, a) => arr[(f * J + j) * 3 + a];

/** Largest distance (m) between any stabilized joint and FK of the stabilized rotations + root. */
function fkResidual(output) {
	const expected = fk(output.rotMats, output.rootPos, output.frames, output.boneScale);
	let worst = 0;
	for (let i = 0; i < expected.length; i += 3) worst = Math.max(worst, Math.hypot(output.posedJoints[i] - expected[i], output.posedJoints[i + 1] - expected[i + 1], output.posedJoints[i + 2] - expected[i + 2]));
	return worst;
}

// Leg pose that puts the ankle on `target` (world). The walk is along +Z (the
// skeleton faces +Z), so the leg swings in its sagittal plane about X. The
// foot is counter-rotated to stay level, so the toe rides rigidly with the
// ankle as a planted foot does.
const swingDown = (theta) => axisAngle([1, 0, 0], -theta); // rotates (0,-1,0) toward +Z by theta
function legIK(leg, rootY, rootZ, target, boneScale) {
	const n = CSKEL27_NEUTRAL;
	const hipY = rootY + (n[leg.up][1] - n[HIPS][1]) * boneScale[leg.up], hipZ = rootZ;
	const l1 = (n[leg.up][1] - n[leg.knee][1]) * boneScale[leg.knee], l2 = (n[leg.knee][1] - n[leg.ankle][1]) * boneScale[leg.ankle];
	const vy = target[1] - hipY, vz = target[2] - hipZ;
	const d = Math.min(Math.max(Math.hypot(vy, vz), Math.abs(l1 - l2) + 1e-6), (l1 + l2) * 0.999);
	const phi = Math.atan2(vz, -vy);
	const alpha = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))));
	const gamma = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2))));
	const thigh = phi + alpha, shin = thigh - (Math.PI - gamma);
	return { [leg.up]: swingDown(thigh), [leg.knee]: swingDown(-(Math.PI - gamma)), [leg.ankle]: swingDown(-shin) };
}

// A walk along +Z: the hips advance 2 cm/frame; each ankle alternates 12
// frames of stance / 12 of swing. In stance the ankle SHOULD be still, but
// the take slides it back 1 cm/frame (GVHMR's under-scaled root); the swing
// lands exactly where the next stance starts, one stride (0.48 m) on.
function walk({ frames, fps = 24, boneScale = new Float32Array(J).fill(1), rootY = 0.82 }) {
	const S = 0.48;
	const ankle = (f, phase) => {
		const t = f + phase, cycle = Math.floor(t / 24), k = t % 24;
		if (k < 12) return { z: cycle * S - k * 0.01, y: 0.05 };
		const kk = k - 12, from = cycle * S - 0.11, to = (cycle + 1) * S;
		return { z: from + (kk + 1) * (to - from) / 12, y: 0.05 + 0.12 * Math.sin(Math.PI * (kk + 0.5) / 12) };
	};
	const poses = Array.from({ length: frames }, (_, f) => {
		const z = f * 0.02, r = ankle(f, 0), l = ankle(f, 12);
		return {
			...legIK(RIGHT_LEG, rootY, z, [0, r.y, r.z], boneScale),
			...legIK(LEFT_LEG, rootY, z, [0, l.y, l.z], boneScale),
		};
	});
	return take({ frames, fps, boneScale, root: (f) => [0, rootY, f * 0.02], rot: (f, j) => poses[f][j] ?? null });
}

/** Deterministic PRNG (mulberry32) so the noisy fixtures are identical every run. */
function rng(seed) {
	let a = seed >>> 0;
	return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Rebuild a take with deterministic jitter on every rotation and the root, plus a limb snap and a limb dropout. */
function noisy(base, { seed, rotationNoise, rootNoise }) {
	const random = rng(seed);
	const jitter = (amount) => { const axis = [random() - 0.5, random() - 0.5, random() - 0.5], n = Math.hypot(...axis); return axisAngle(axis.map((v) => v / n), (random() * 2 - 1) * amount); };
	const snapFrame = Math.floor(base.frames * 0.3), dropout = Math.floor(base.frames * 0.6);
	const rotations = Array.from({ length: base.frames }, (_, f) => Array.from({ length: J }, (_, j) => {
		let m = mul(rotAt(base.rotMats, f, j), jitter(rotationNoise));
		if (j === RIGHT_FOREARM && f === snapFrame) m = mul(m, axisAngle([0, 0, 1], 0.5));
		if (j === LEFT_ARM && f >= dropout && f < dropout + 3) m = mul(m, axisAngle([0, 0, 1], 0.35));
		return m;
	}));
	const roots = Array.from({ length: base.frames }, (_, f) => [0, 1, 2].map((a) => base.rootPos[f * 3 + a] + (random() * 2 - 1) * rootNoise));
	return take({ frames: base.frames, fps: base.fps, boneScale: base.boneScale, root: (f) => roots[f], rot: (f, j) => rotations[f][j] });
}

function motion(frames = 9) {
	return take({ frames, root: (f) => [f * 0.06, 1, 0] });
}

test("stabilization suppresses isolated positional spikes and keeps root coherent", () => {
	// A one-frame segmentation spike on the root and a one-frame limb snap.
	const input = take({ frames: 9, root: (f) => [f * 0.06 + (f === 4 ? 0.18 : 0), 1, 0], rot: (f, j) => (j === RIGHT_ARM && f === 4 ? axisAngle([0, 0, 1], 0.5) : null) });
	const output = stabilizeMotion(input);
	const spike = output.posedJoints[(4 * J) * 3];
	assert.ok(Math.abs(spike - .24) < .08, `spike retained too much: ${spike}`);
	assert.equal(output.rootPos[4 * 3], spike, "root follows filtered Hips");
	const snap = angleOf(rotAt(output.rotMats, 4, RIGHT_ARM));
	assert.ok(snap < 0.25, `limb snap retained ${snap.toFixed(3)} of 0.5 rad`);
	assert.ok(output.stabilization.correctedPositions > 0);
	assert.ok(output.stabilization.correctedRotations > 0);
});

test("high-speed translation remains close to the authored trajectory", () => {
	const input = take({ frames: 9, root: (f) => [f * .5, 1, 0] });
	const output = stabilizeMotion(input);
	assert.ok(Math.abs(output.posedJoints[(4 * J) * 3] - 2) < .03, "fast step should not be smoothed away");
});

test("short multi-frame detector dropout is corrected without flattening a jump", () => {
	// The root carries a real, short ascent (frames 8-10) and later a gradual
	// forward jump; the right arm is held at a wrong angle by a detector
	// dropout over the same three frames.
	const input = take({
		frames: 24,
		root: (f) => [f * 0.01 + (f >= 15 ? Math.min((f - 15) * 0.02, 0.12) : 0), 1 + (f >= 8 && f <= 10 ? 0.12 : 0), 0],
		rot: (f, j) => (j === RIGHT_ARM && f >= 8 && f <= 10 ? axisAngle([0, 0, 1], 0.3) : null),
	});
	const output = stabilizeMotion(input);
	// Clean pose is the neutral one, so the hand belongs at neutral offset from the hips.
	for (const f of [8, 9, 10]) {
		const error = Math.hypot(...[0, 1, 2].map((a) => at(output.posedJoints, f, RIGHT_HAND, a) - at(output.posedJoints, f, HIPS, a) - (CSKEL27_NEUTRAL[RIGHT_HAND][a] - CSKEL27_NEUTRAL[HIPS][a])));
		assert.ok(error < .045, `dropout remains at frame ${f}: hand ${(error * 100).toFixed(1)} cm off`);
	}
	assert.ok(output.posedJoints[(9 * J) * 3 + 1] > 1.06, "real root ascent was flattened");
	// A real, gradual forward jump remains intact after the dropout.
	assert.ok(output.posedJoints[(20 * J) * 3] > .19, "real post-dropout travel was flattened");
});

test("optional contact height is explicit and bounded", () => {
	const input = motion();
	assert.equal(stabilizeMotion(input).stabilization.correctedContacts, 0, "no surface means no guessed contact snap");
	const output = stabilizeMotion(input, { contactHeight: .52 });
	assert.equal(output.stabilization.contactHeight, .52);
	assert.ok(output.stabilization.correctedContacts >= 0);
	assert.ok([...output.rootPos, ...output.posedJoints].every(Number.isFinite));
	for (let f = 0; f < output.frames; f += 1) for (let j = 0; j < J; j += 1) {
		const o = (f * J + j) * 9; const a = output.rotMats[o]; const b = output.rotMats[o + 1]; const c = output.rotMats[o + 2];
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
	const frames = 48;
	const input = walk({ frames });
	const RF = RIGHT_LEG.ankle, Z = 2;
	// The fixture really does skate: 1 cm/frame back through each stance.
	assert.ok(Math.abs(at(input.posedJoints, 30, RF, Z) - at(input.posedJoints, 29, RF, Z) + 0.01) < 1e-4, "fixture stance slide");
	const output = stabilizeMotion(input, { anchorFeet: true });
	// Second right-foot stance run f=24..35: the anchored foot holds its z.
	// The authored slide is 1 cm/frame; the pass leaves a residual only where
	// its ~150 ms velocity ramp overlaps the run's edges, so the middle of the
	// run is what stance means here (the first run starts at f=0 with no
	// lead-in and is the ramp's worst case, not the typical stance).
	let slide = 0;
	for (let f = 28; f < 33; f += 1) slide = Math.max(slide, Math.abs(at(output.posedJoints, f, RF, Z) - at(output.posedJoints, f - 1, RF, Z)));
	assert.ok(slide < 0.002, `stance foot still slides ${(slide * 100).toFixed(2)} cm/frame`);
	// And the run as a whole moved far less than authored (1 cm/frame × 11).
	const runDrift = Math.abs(at(output.posedJoints, 35, RF, Z) - at(output.posedJoints, 24, RF, Z));
	assert.ok(runDrift < 0.03, `stance run drifted ${(runDrift * 100).toFixed(1)} cm (authored 11)`);
	// The body still travels forward over the whole take (not frozen).
	assert.ok(output.rootPos[(frames - 1) * 3 + Z] - output.rootPos[Z] > 0.5, "root travel was flattened");
	// Every joint moved by the same per-frame offset as the root (rigid shift).
	for (let f = 0; f < frames; f += 1) {
		const dz = output.rootPos[f * 3 + Z] - input.rootPos[f * 3 + Z];
		assert.ok(Math.abs((at(output.posedJoints, f, HEAD, Z) - at(input.posedJoints, f, HEAD, Z)) - dz) < 1e-5, "head offset equals root offset");
	}
	assert.ok(output.stabilization.anchoredFrames > 0);
	assert.equal(stabilizeMotion(input).stabilization.anchoredFrames, 0, "anchoring is opt-in");
});

// The output is one skeleton: every stabilized joint is the FK of the
// stabilized rotations over the take's own (boneScale'd) bones from the
// stabilized root. Filtering joint positions on their own breaks this —
// bones stretch and the drawn limbs disagree with the rotations — so each
// path that moves the take is exercised on noisy input and held to 1 mm.
test("stabilized posedJoints are FK of the stabilized rotations and root on the take's skeleton", () => {
	const boneScale = Float32Array.from({ length: J }, (_, j) => 0.94 + 0.12 * ((j * 7) % 11) / 10);
	const walking = noisy(walk({ frames: 72, fps: 30, boneScale }), { seed: 380, rotationNoise: 0.004, rootNoise: 0.002 });
	const standing = noisy(take({ frames: 48, boneScale, root: () => [0, 0.95, 0] }), { seed: 413, rotationNoise: 0.002, rootNoise: 0.001 });
	const cases = [
		{ name: "walk, defaults", input: walking, options: {}, fired: (s) => s.correctedRotations > 0 && s.correctedPositions > 0 },
		{ name: "walk, anchored feet", input: walking, options: { anchorFeet: true }, fired: (s) => s.anchoredFrames > 0 },
		{ name: "walk, anchored, rotations unsmoothed", input: walking, options: { anchorFeet: true, smoothRotations: false }, fired: (s) => s.anchoredFrames > 0 && s.correctedRotations === 0 },
		{ name: "standing, contact height", input: standing, options: { contactHeight: 0 }, fired: (s) => s.correctedContacts > 0 },
	];
	for (const { name, input, options, fired } of cases) {
		assert.ok(fkResidual(input) < 1e-5, `${name}: fixture is itself consistent`);
		const output = stabilizeMotion(input, options);
		assert.ok(fired(output.stabilization), `${name}: stabilization path did not run ${JSON.stringify(output.stabilization)}`);
		let moved = 0;
		for (let i = 0; i < input.posedJoints.length; i += 1) moved = Math.max(moved, Math.abs(output.posedJoints[i] - input.posedJoints[i]));
		assert.ok(moved > 1e-3, `${name}: stabilization left the take unchanged, so FK agreement proves nothing`);
		const residual = fkResidual(output);
		assert.ok(residual < 1e-3, `${name}: a stabilized joint is ${(residual * 1000).toFixed(2)} mm off FK`);
	}
});
