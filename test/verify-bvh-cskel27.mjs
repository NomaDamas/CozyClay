import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CSKEL27_JOINTS } from "../src/ardy/cskel27.js";
import { canonicalCskel27Reference } from "../src/ardy/to-cskel27.js";
import { bridgeOcclusionGaps, bvhToCskel27Motion, parseBvh, shapeFloorCorrection } from "../tools/ardy/bvh-cskel27.mjs";

function pass(label) { console.log(`PASS ${label}`); }
function near(a, b, tolerance) { return Math.abs(a - b) <= tolerance; }

// ---- shared measurements --------------------------------------------------
// All of these are reported PER SECOND as well as per frame: the module now
// resolves every smoothing constant from a duration, and the only way to check
// that is to compare the same motion at two rates in time units.
const FEET = ["LeftToeBase", "RightToeBase", "LeftFoot", "RightFoot"];
function takeMetrics(motion) {
	const at = (f, j, axis) => motion.posedJoints[((f * 27 + j) * 3) + axis];
	const accelRms = (joints) => {
		let sum = 0;
		let count = 0;
		for (const j of joints) {
			for (let f = 1; f < motion.frames - 1; f += 1) {
				for (let axis = 0; axis < 3; axis += 1) {
					const acc = at(f + 1, j, axis) - 2 * at(f, j, axis) + at(f - 1, j, axis);
					sum += acc * acc;
					count += 1;
				}
			}
		}
		return Math.sqrt(sum / count) * 100; // cm per frame²
	};
	const kneeAngle = (f, side) => {
		const v = (a, b) => [0, 1, 2].map((axis) => at(f, idx[a], axis) - at(f, idx[b], axis));
		const u = v(`${side}UpLeg`, `${side}Leg`);
		const w = v(`${side}Foot`, `${side}Leg`);
		const dot = (u[0] * w[0] + u[1] * w[1] + u[2] * w[2]) / Math.max(1e-9, Math.hypot(...u) * Math.hypot(...w));
		return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
	};
	let jerkSum = 0;
	let jerkCount = 0;
	let worstKneeStep = 0;
	for (const side of ["Left", "Right"]) {
		const angles = [];
		for (let f = 0; f < motion.frames; f += 1) angles.push(kneeAngle(f, side));
		for (let f = 1; f < motion.frames - 1; f += 1) {
			const d = angles[f + 1] - 2 * angles[f] + angles[f - 1];
			jerkSum += d * d;
			jerkCount += 1;
		}
		for (let f = 1; f < motion.frames; f += 1) worstKneeStep = Math.max(worstKneeStep, Math.abs(angles[f] - angles[f - 1]));
	}
	const kneeJerk = Math.sqrt(jerkSum / jerkCount); // degrees per frame²
	const speeds = [];
	for (const j of [idx.LeftFoot, idx.RightFoot]) {
		for (let f = 1; f < motion.frames; f += 1) {
			speeds.push(Math.hypot(...[0, 1, 2].map((axis) => at(f, j, axis) - at(f - 1, j, axis))));
		}
	}
	speeds.sort((a, b) => a - b);
	const lowest = [];
	for (let f = 0; f < motion.frames; f += 1) {
		let low = Infinity;
		for (const name of FEET) low = Math.min(low, at(f, idx[name], 1));
		lowest.push(low);
	}
	const ankle = accelRms([idx.LeftFoot, idx.RightFoot]);
	const toe = accelRms([idx.LeftToeBase, idx.RightToeBase]);
	const hips = accelRms([idx.Hips]);
	// Hand speed and the guard-band wrist accel (#84). GUARD frames are the
	// ones whose hand moves under 1.2 m/s across both steps of the second
	// difference — the band the "our take jitters" complaint lives in, and the
	// band a speed-adaptive filter is allowed to touch. Peak hand speed is the
	// punch: the filter must leave it standing.
	const handSpeed = (f, j) => Math.hypot(...[0, 1, 2].map((axis) => at(f, j, axis) - at(f - 1, j, axis))) * 100 * motion.fps;
	const handSpeeds = [];
	let guardSum = 0;
	let guardCount = 0;
	for (const j of [idx.LeftHand, idx.RightHand]) {
		for (let f = 1; f < motion.frames; f += 1) handSpeeds.push(handSpeed(f, j));
		for (let f = 1; f < motion.frames - 1; f += 1) {
			if (handSpeed(f, j) > 120 || handSpeed(f + 1, j) > 120) continue;
			for (let axis = 0; axis < 3; axis += 1) {
				const acc = at(f + 1, j, axis) - 2 * at(f, j, axis) + at(f - 1, j, axis);
				guardSum += acc * acc;
				guardCount += 1;
			}
		}
	}
	const wrist = accelRms([idx.LeftHand, idx.RightHand]);
	return {
		lowest,
		wrist,
		guardWrist: Math.sqrt(guardSum / Math.max(1, guardCount)) * 100, // cm per frame²
		handSpeedMax: Math.max(...handSpeeds), // cm/s — the punch peak
		ankle, toe, hips, kneeJerk, worstKneeStep,
		// per-second forms — comparable across frame rates
		wristPerS2: wrist * motion.fps ** 2,
		anklePerS2: ankle * motion.fps ** 2,
		hipsPerS2: hips * motion.fps ** 2,
		kneeJerkPerS2: kneeJerk * motion.fps ** 2,
		ankleSpeedP95: speeds[Math.floor(speeds.length * 0.95)] * 100 * motion.fps, // cm/s
		grounded: lowest.filter((v) => v < 0.03).length / motion.frames,
		minSole: Math.min(...lowest),
	};
}

/** Double a BVH's frame rate by linear interpolation of the motion table, so
 *  the SAME performance can be measured at 30 and 60 fps. Rotation channels
 *  are unwrapped first — lerping across the ±180 seam would spin the joint the
 *  long way round and manufacture the jitter this is meant to measure. */
function doubleRate(text) {
	const head = text.slice(0, text.indexOf("MOTION"));
	const lines = text.slice(text.indexOf("MOTION")).split("\n");
	const frameTime = Number(lines.find((l) => l.trim().startsWith("Frame Time:")).split(":")[1]);
	const count = Number(lines.find((l) => l.trim().startsWith("Frames:")).split(":")[1]);
	const body = lines.slice(lines.findIndex((l) => l.trim().startsWith("Frame Time:")) + 1)
		.map((l) => l.trim()).filter(Boolean).slice(0, count)
		.map((l) => l.split(/\s+/).map(Number));
	const kinds = [];
	const tokens = head.split(/\s+/);
	for (let i = 0; i < tokens.length; i += 1) {
		if (tokens[i] !== "CHANNELS") continue;
		for (let c = 0; c < Number(tokens[i + 1]); c += 1) kinds.push(tokens[i + 2 + c]);
	}
	for (let c = 0; c < kinds.length; c += 1) {
		if (!kinds[c].endsWith("rotation")) continue;
		for (let f = 1; f < body.length; f += 1) {
			while (body[f][c] - body[f - 1][c] > 180) body[f][c] -= 360;
			while (body[f][c] - body[f - 1][c] < -180) body[f][c] += 360;
		}
	}
	const out = [];
	for (let f = 0; f < body.length - 1; f += 1) {
		out.push(body[f]);
		out.push(body[f].map((v, c) => (v + body[f + 1][c]) / 2));
	}
	out.push(body[body.length - 1]);
	return `${head}MOTION\nFrames: ${out.length}\nFrame Time: ${(frameTime / 2).toFixed(8)}\n${out.map((r) => r.join(" ")).join("\n")}\n`;
}

const idx = Object.fromEntries(CSKEL27_JOINTS.map((name, index) => [name, index]));
const fixture = readFileSync(new URL("./fixtures/shadow17-mixamo.bvh", import.meta.url), "utf8");

const bvh = parseBvh(fixture);
assert.equal(bvh.frames, 514);
assert.equal(bvh.joints.length, 52);
assert.equal(bvh.joints[0].name, "mixamorig:Hips");
assert.equal(bvh.joints[0].channels.length, 6);
assert.ok(near(1 / bvh.frameTimeS, 30, 0.01));
pass("the real SAM-3D-Body BVH parses: 514 frames, 52 joints, 30 fps");

const motion = bvhToCskel27Motion(bvh);
assert.equal(motion.frames, 514);
assert.equal(motion.fps, 30);
assert.equal(motion.rotMats.length, 514 * 27 * 9);
assert.equal(motion.rootPos.length, 514 * 3);
assert.equal(motion.posedJoints.length, 514 * 27 * 3);
pass("conversion fills the exact npz motion shape");

// Every local matrix stays a rotation across the whole clip.
for (let f = 0; f < motion.frames; f += 37) {
	for (let j = 0; j < 27; j += 1) {
		const o = (f * 27 + j) * 9;
		for (let row = 0; row < 3; row += 1) {
			const length = Math.hypot(motion.rotMats[o + row * 3], motion.rotMats[o + row * 3 + 1], motion.rotMats[o + row * 3 + 2]);
			assert.ok(near(length, 1, 1e-4), `frame ${f} joint ${j} row ${row}`);
		}
	}
}
pass("locals stay unit rotations through the clip");

// FK ran over the CANONICAL skeleton: limb lengths must match it exactly.
const neutral = canonicalCskel27Reference().posed_joints;
for (const [parent, child] of [["LeftArm", "LeftForeArm"], ["RightUpLeg", "RightLeg"], ["LeftLeg", "LeftFoot"]]) {
	const expected = Math.hypot(...neutral[idx[child]].map((v, axis) => v - neutral[idx[parent]][axis]));
	for (const f of [0, 250, 513]) {
		const a = (f * 27 + idx[parent]) * 3;
		const b = (f * 27 + idx[child]) * 3;
		const actual = Math.hypot(
			motion.posedJoints[b] - motion.posedJoints[a],
			motion.posedJoints[b + 1] - motion.posedJoints[a + 1],
			motion.posedJoints[b + 2] - motion.posedJoints[a + 2]
		);
		assert.ok(near(actual, expected, 1e-4), `${parent}->${child} frame ${f}`);
	}
}
pass("the take moves CozyClay's canonical body, not SAM's per-clip bone lengths");

// Contact-anchored grounding: touch-downs re-anchor the floor so SAM's
// vertical drift (up to tens of cm on this clip) is gone, nothing sinks
// below Y=0, and genuinely airborne bounce frames KEEP their air — a boxer
// on his toes is not glued flat.
const lowestPerFrame = [];
for (let f = 0; f < motion.frames; f += 1) {
	let low = Infinity;
	for (const name of ["LeftToeBase", "RightToeBase", "LeftFoot", "RightFoot"]) {
		low = Math.min(low, motion.posedJoints[(f * 27 + idx[name]) * 3 + 1]);
	}
	lowestPerFrame.push(low);
}
assert.ok(Math.min(...lowestPerFrame) > -1e-4, String(Math.min(...lowestPerFrame)));
const sortedLowest = [...lowestPerFrame].sort((a, b) => a - b);
assert.ok(sortedLowest[Math.floor(sortedLowest.length / 2)] < 0.02, `median ${sortedLowest[Math.floor(sortedLowest.length / 2)]}`);
assert.ok(lowestPerFrame.filter((v) => v < 0.03).length > motion.frames * 0.6, "too few near-floor frames");
// ...while permitted jumps keep their air: this clip's hops peak past 10 cm.
assert.ok(Math.max(...lowestPerFrame) > 0.1, `max lift ${Math.max(...lowestPerFrame)}`);
// No sustained un-permitted float: every >5 cm hover must be brief (a hop),
// never the second-long drift the foot pinning exists to kill.
{
	let f = 0;
	while (f < motion.frames) {
		if (lowestPerFrame[f] <= 0.05) { f += 1; continue; }
		let g = f;
		while (g < motion.frames && lowestPerFrame[g] > 0.05) g += 1;
		assert.ok(g - f <= Math.round(0.9 * motion.fps), `float run f${f}..${g - 1} (${g - f} frames) outlives ballistic air`);
		f = g;
	}
}
pass("feet pin to the floor; drift is gone and only brief jump air survives");

// The XZ foot lock may remove a slide; it may NOT relocate the leg. Loosening
// the contact gate to cover footwork once let it drag ankles 18 cm onto a run's
// median spot — legs visibly flying. The lock's own pull is the direct measure.
assert.ok(motion.lockPullMax <= 0.04 + 1e-9, `foot lock dragged an ankle ${(motion.lockPullMax * 100).toFixed(1)} cm`);
pass("the foot lock corrects slide, never throws the leg across the floor");

// The occlusion bridge pins an "airborne" gap ONLY when the foot reappears
// where it left without ever lifting like a jump — a real jump keeps its
// air, a travelling step keeps its swing.
{
	const fps = 30;
	const frames = 60;
	const makeTrack = () => {
		const contact = new Array(frames).fill(false);
		for (let f = 0; f < 20; f += 1) contact[f] = true;
		for (let f = 40; f < 60; f += 1) contact[f] = true;
		return contact;
	};
	const makeAnkle = ({ lift, travel }) => {
		const ankle = new Float64Array(frames * 3);
		for (let f = 0; f < frames; f += 1) {
			const inGap = f >= 20 && f < 40;
			const t = inGap ? (f - 20) / 19 : 0;
			ankle[f * 3] = f >= 40 ? travel : inGap ? travel * t : 0;
			ankle[f * 3 + 1] = 0.08 + (inGap ? lift * Math.sin(Math.PI * t) : 0);
			ankle[f * 3 + 2] = 0;
		}
		return ankle;
	};
	const occluded = makeTrack();
	bridgeOcclusionGaps(occluded, makeAnkle({ lift: 0.15, travel: 0 }), 0.08, fps);
	assert.ok(occluded.slice(20, 40).every(Boolean), "occlusion gap should be pinned");
	const jump = makeTrack();
	bridgeOcclusionGaps(jump, makeAnkle({ lift: 0.5, travel: 0 }), 0.08, fps);
	assert.ok(jump.slice(20, 40).every((v) => !v), "a 50 cm jump must keep its air");
	const step = makeTrack();
	bridgeOcclusionGaps(step, makeAnkle({ lift: 0.15, travel: 0.6 }), 0.08, fps);
	assert.ok(step.slice(20, 40).every((v) => !v), "a travelling step must keep its swing");
	pass("occlusion gaps are pinned; jumps and travelling steps never are");
}

// The performer stays upright: head above hips on every sampled frame.
for (let f = 0; f < motion.frames; f += 41) {
	const head = motion.posedJoints[(f * 27 + idx.Head) * 3 + 1];
	const hips = motion.posedJoints[(f * 27 + idx.Hips) * 3 + 1];
	assert.ok(head > hips + 0.3, `frame ${f}: head ${head} hips ${hips}`);
}
pass("orientation is upright throughout — no axis flip in the retarget");

// The production pipeline's own output (offline multi-pass renderer with
// zero-phase smoothing, jitter interpolation and foot contact) converts to a
// take that is BOTH smooth and grounded. The jitter metric is the RMS of the
// per-frame position second difference — the live binary scored ~4.9 cm on
// the wrists for this same clip, the offline one ~2.8; the bound catches a
// silent regression to the laggy causal path.
const offlineText = readFileSync(new URL("./fixtures/boxing-offline-mixamo.bvh", import.meta.url), "utf8");
const offline = bvhToCskel27Motion(parseBvh(offlineText));
const offlineMetrics = takeMetrics(offline);
{
	assert.ok(offlineMetrics.wrist < 3.5, `wrist accel ${offlineMetrics.wrist}`);
	assert.ok(offlineMetrics.hips < 1.5, `hip accel ${offlineMetrics.hips}`);
	assert.ok(offlineMetrics.minSole > -1e-4, `min sole ${offlineMetrics.minSole}`);
	assert.ok(offlineMetrics.grounded > 0.25, `grounded ${offlineMetrics.grounded}`);
	pass("the offline-pipeline take stays smooth (wrist accel < 3.5 cm) and grounded");
}

// The arm One-Euro (#84), pinned from both sides. Unfiltered, this fixture
// measures wrist accel 2.76 cm and guard-band wrist accel 1.36; the filter
// takes them to 2.56 / 1.24 while peak hand speed keeps 799 of its 802 cm/s.
// The rejected leg-style slerp on the arms scores 724 cm/s of peak with the
// guard band UNTOUCHED at 1.36 — so the peak bound catches swapping in any
// blunt smoother, and the two accel bounds catch removing the filter.
{
	assert.ok(offlineMetrics.wrist < 2.7, `wrist accel ${offlineMetrics.wrist} — arm filter missing?`);
	assert.ok(offlineMetrics.guardWrist < 1.32, `guard-band wrist accel ${offlineMetrics.guardWrist} — arm filter missing?`);
	assert.ok(offlineMetrics.handSpeedMax > 760, `peak hand speed ${offlineMetrics.handSpeedMax} cm/s — the punch got smoothed`);
	pass("the arm One-Euro quiets the guard-band wrists without collapsing punch speed");
}

// The legs get the same zero-lag slerp as the torso (harder), and the 4f
// penetration guard's correction is dilated-then-blurred rather than applied
// raw. Together they took ankle accel RMS 2.33 → 1.72 cm, knee angle jerk
// 3.68 → 2.63°/frame² and the worst single-frame knee change 19.1 → 14.5° on
// this fixture. Each bound sits between the two, so it catches either lever
// being removed rather than merely drifting: dropping the leg slerp alone puts
// the ankle back at 2.35 cm, and applying the guard's correction raw — it
// fired on 44 % of frames in 3-frame bursts, with 1.10 cm RMS of second
// difference of its own — puts the knee back at 3.04°/frame² and the worst
// step at 16.2°.
{
	assert.ok(offlineMetrics.ankle < 2.0, `ankle accel ${offlineMetrics.ankle}`);
	assert.ok(offlineMetrics.toe < 2.1, `toe accel ${offlineMetrics.toe}`);
	assert.ok(offlineMetrics.kneeJerk < 3.0, `knee angle jerk ${offlineMetrics.kneeJerk}`);
	assert.ok(offlineMetrics.worstKneeStep < 16, `worst knee step ${offlineMetrics.worstKneeStep}`);
	// ...and the footwork is smoothed, not killed: the boxer's feet still move.
	assert.ok(offlineMetrics.ankleSpeedP95 > 260, `95th pct ankle speed ${offlineMetrics.ankleSpeedP95} cm/s`);
	pass("leg smoothing and the shaped floor guard cut foot tremble without killing footwork");
}

// The guard's shaping is only allowed because dilate-then-blur can never
// return less than it was given — otherwise it would smooth a sole straight
// back through the floor. Asserted on the operator itself, on a track built
// to be the worst case: isolated one-frame spikes, which a plain blur would
// cut to a fifth.
{
	const spiky = new Float64Array(40);
	for (let f = 0; f < 40; f += 1) spiky[f] = f % 7 === 0 ? 0.05 : f % 11 === 0 ? 0.02 : 0;
	const shaped = shapeFloorCorrection(spiky, 2);
	for (let f = 0; f < 40; f += 1) assert.ok(shaped[f] >= spiky[f] - 1e-12, `frame ${f}: ${shaped[f]} < ${spiky[f]}`);
	const secondDiff = (track) => {
		let sum = 0;
		for (let f = 1; f < track.length - 1; f += 1) {
			const d = track[f + 1] - 2 * track[f] + track[f - 1];
			sum += d * d;
		}
		return Math.sqrt(sum / (track.length - 2));
	};
	assert.ok(secondDiff(shaped) < secondDiff(spiky) / 3, `shaped jerk ${secondDiff(shaped)} vs raw ${secondDiff(spiky)}`);
	// Degenerate half-window: a 0-frame window must be the identity, never a wipe.
	const flat = shapeFloorCorrection(Float64Array.from([0, 0.03, 0]), 0);
	assert.deepEqual([...flat], [0, 0.03, 0]);
	pass("the shaped floor correction is never below the raw deficit — no sole can sink");
}

// FIX 1's whole point: the fixtures are 30 fps and the real extraction is 60,
// so the same performance rendered at both rates must come out with comparable
// jitter PER UNIT TIME. With the constants written as frame counts it did not
// — every smoothing window covered half the time and the 60 fps conversion
// scored 1.81x the 30 fps ankle jitter, 1.68x the knee jerk, and lost five
// points of grounding. The upsampled input is itself 1.50x jitterier per
// second (linear interpolation puts a corner at every original sample), so
// that ratio is the ceiling any honest conversion has to beat.
{
	const doubled = bvhToCskel27Motion(parseBvh(doubleRate(offlineText)));
	assert.equal(doubled.fps, 60);
	assert.equal(doubled.frames, offline.frames * 2 - 1);
	const fast = takeMetrics(doubled);
	assert.ok(fast.anklePerS2 < offlineMetrics.anklePerS2 * 1.35,
		`60 fps ankle jitter ${fast.anklePerS2.toFixed(0)} cm/s² vs 30 fps ${offlineMetrics.anklePerS2.toFixed(0)}`);
	assert.ok(fast.kneeJerkPerS2 < offlineMetrics.kneeJerkPerS2 * 1.35,
		`60 fps knee jerk ${fast.kneeJerkPerS2.toFixed(0)} °/s² vs 30 fps ${offlineMetrics.kneeJerkPerS2.toFixed(0)}`);
	// The arm One-Euro's constants are Hz, not frame counts: measured 1.20x
	// here, held to the same bar as the legs.
	assert.ok(fast.wristPerS2 < offlineMetrics.wristPerS2 * 1.35,
		`60 fps wrist jitter ${fast.wristPerS2.toFixed(0)} cm/s² vs 30 fps ${offlineMetrics.wristPerS2.toFixed(0)}`);
	// The hip bound is looser because the hips ride the ground line, which is
	// read from the input sole track and cannot be smoother than it: measured
	// 1.34x here against 1.72x before the conversion.
	assert.ok(fast.hipsPerS2 < offlineMetrics.hipsPerS2 * 1.5,
		`60 fps hip jitter ${fast.hipsPerS2.toFixed(0)} cm/s² vs 30 fps ${offlineMetrics.hipsPerS2.toFixed(0)}`);
	// The stance detector must also survive the rate change: runs, blends and
	// speed baselines are all durations now, so grounding and floor contact
	// land in the same place.
	assert.ok(Math.abs(fast.grounded - offlineMetrics.grounded) < 0.03,
		`grounded ${(fast.grounded * 100).toFixed(1)}% at 60 fps vs ${(offlineMetrics.grounded * 100).toFixed(1)}% at 30`);
	assert.ok(fast.minSole > -1e-4, `min sole at 60 fps ${fast.minSole}`);
	assert.ok(fast.ankleSpeedP95 > 260, `95th pct ankle speed at 60 fps ${fast.ankleSpeedP95} cm/s`);
	assert.ok(doubled.lockPullMax <= 0.04 + 1e-9, `foot lock dragged an ankle ${(doubled.lockPullMax * 100).toFixed(1)} cm at 60 fps`);
	pass("a 60 fps clip converts with the same jitter per second as the 30 fps one");
}

const truncated = fixture.slice(0, fixture.length / 2);
let named = null;
try {
	parseBvh(truncated);
} catch (error) { named = error.message; }
assert.equal(named, "bvh-motion-truncated");
pass("a truncated BVH fails closed by name");

console.log("verify-bvh-cskel27: all checks passed");
