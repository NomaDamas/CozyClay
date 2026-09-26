#!/usr/bin/env node
/**
 * mocap-metrics.mjs — compare cskel27 motion npz takes on the three defects a
 * bad 2D observation produces, so an estimator change (e.g. #180's palette
 * keypoints against ViTPose) is judged by numbers instead of by eye:
 *
 *   foot slide      the planted foot's horizontal speed while it is planted.
 *                   A supporting foot should read ~0 cm/s; skate is the single
 *                   most visible mocap artefact (SAM's single-image lift
 *                   measured 250 cm/s on locomotion). "Planted" is decided
 *                   per side from the take itself: the frames whose ankle is
 *                   in the lower PLANT_HEIGHT_PERCENTILE of that side's ankle
 *                   heights AND whose horizontal speed is below the side's
 *                   median — that is the stance phase, without needing the
 *                   contact logits (a converted take has dropped them).
 *   jitter          mean |second difference| of posed_joints.  The raw
 *                   mm/frame^2 value is retained for diagnostics and the
 *                   fps-normalised mm/s^2 value is used for cross-rate gates.
 *   below floor     frames whose lowest foot joint sits under Y=0. The
 *                   converter grounds the clip on its 10th percentile, so a
 *                   few frames are expected; many mean the legs are wrong.
 *
 * usage: node tools/ardy/mocap-metrics.mjs <a.npz> [<b.npz> ...]
 */
import { readNpz } from "../kimodo/read-npz.mjs";
import { CSKEL27_JOINTS } from "../../src/ardy/cskel27.js";
import { pathToFileURL } from "node:url";

const JOINT = Object.fromEntries(CSKEL27_JOINTS.map((name, index) => [name, index]));
const JOINTS = CSKEL27_JOINTS.length;
const FEET = ["RightFoot", "RightToeBase", "LeftFoot", "LeftToeBase"].map((name) => JOINT[name]);
const ANKLES = { right: JOINT.RightFoot, left: JOINT.LeftFoot };
// The stance phase of a step: the foot is both low and slow. Deriving it from
// the take's own distribution keeps the measure comparable across clips with
// different step heights, and needs no contact channel.
const PLANT_HEIGHT_PERCENTILE = 0.35;
const FLOOR_TOLERANCE_M = 0.005; // 5 mm: float32 round-trip, not penetration

function member(members, name, path) {
	const value = members[name];
	if (!value?.data) throw new Error(`${path}: missing or unreadable member ${name}`);
	return value;
}

function percentile(values, fraction) {
	if (!values.length) return NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const at = (sorted.length - 1) * fraction;
	const low = Math.floor(at);
	return sorted[low] * (1 - (at - low)) + (sorted[Math.min(low + 1, sorted.length - 1)] ?? sorted[low]) * (at - low);
}

const median = (values) => percentile(values, 0.5);

function read(path) {
	const members = readNpz(path);
	const joints = member(members, "posed_joints", path);
	if (joints.shape.length !== 3 || joints.shape[1] !== JOINTS || joints.shape[2] !== 3) {
		throw new Error(`${path}: posed_joints must be (F, ${JOINTS}, 3), got (${joints.shape.join(", ")})`);
	}
	const fpsMember = member(members, "fps", path);
	const fps = fpsMember.data[0];
	if (!(fps > 0)) throw new Error(`${path}: invalid fps ${fps}`);
	const frames = joints.shape[0];
	const root = members.root_positions?.data ?? null;
	return { path, frames, fps, joints: joints.data, root };
}

/** Build metrics from a converted motion already held in memory. */
export function mocapMetricsFromMotion(motion, { path = "<memory>" } = {}) {
	if (!motion || !Number.isInteger(motion.frames) || motion.frames < 1) {
		throw new Error(`${path}: motion.frames must be a positive integer`);
	}
	const fps = Number(motion.fps);
	if (!(fps > 0)) throw new Error(`${path}: invalid fps ${motion.fps}`);
	const joints = motion.posedJoints ?? motion.joints;
	const expectedJoints = motion.frames * JOINTS * 3;
	if (!joints || joints.length !== expectedJoints) {
		throw new Error(`${path}: posedJoints must contain ${expectedJoints} values`);
	}
	const root = motion.rootPos ?? motion.root ?? null;
	if (root !== null && root.length !== motion.frames * 3) {
		throw new Error(`${path}: rootPos must contain ${motion.frames * 3} values`);
	}
	const take = { path, frames: motion.frames, fps, joints, root };
	const floor = belowFloor(take);
	const jitterMmPerFrame2 = jitter(take);
	return {
		path,
		frames: take.frames,
		fps: take.fps,
		footSlideCmPerS: footSlide(take),
		// Keep the raw frame-space value for backwards-compatible diagnostics,
		// but also expose a time-normalised acceleration.  A second difference
		// scales with dt², so the raw value alone would make the same physical
		// shake look 4x smaller when a 30fps take is sampled at 60fps.
		jitterMmPerFrame2,
		jitterMmPerS2: jitterMmPerFrame2 * take.fps * take.fps,
		framesBelowFloor: floor.count,
		deepestBelowFloorCm: floor.deepestCm,
		rootTravelM: travel(take),
	};
}

/** Median horizontal speed (cm/s) of each ankle over its own stance frames. */
function footSlide({ frames, fps, joints }) {
	const speeds = [];
	for (const ankle of Object.values(ANKLES)) {
		const at = (frame, axis) => joints[(frame * JOINTS + ankle) * 3 + axis];
		const step = [];
		for (let frame = 1; frame < frames; frame += 1) {
			step.push({
				speed: Math.hypot(at(frame, 0) - at(frame - 1, 0), at(frame, 2) - at(frame - 1, 2)) * fps * 100,
				height: Math.min(at(frame, 1), at(frame - 1, 1)),
			});
		}
		if (!step.length) continue;
		const lowEnough = percentile(step.map((s) => s.height), PLANT_HEIGHT_PERCENTILE);
		const slowEnough = median(step.map((s) => s.speed));
		const planted = step.filter((s) => s.height <= lowEnough && s.speed <= slowEnough);
		speeds.push(median((planted.length ? planted : step).map((s) => s.speed)));
	}
	return median(speeds);
}

/** Mean |second difference| over every joint, in mm per frame^2. */
function jitter({ frames, joints }) {
	if (frames < 3) return NaN;
	let total = 0;
	let count = 0;
	for (let frame = 1; frame < frames - 1; frame += 1) {
		for (let joint = 0; joint < JOINTS; joint += 1) {
			const base = (frame * JOINTS + joint) * 3;
			const before = ((frame - 1) * JOINTS + joint) * 3;
			const after = ((frame + 1) * JOINTS + joint) * 3;
			total += Math.hypot(
				joints[after] - 2 * joints[base] + joints[before],
				joints[after + 1] - 2 * joints[base + 1] + joints[before + 1],
				joints[after + 2] - 2 * joints[base + 2] + joints[before + 2],
			) * 1000;
			count += 1;
		}
	}
	return total / count;
}

/** Frames whose lowest foot joint is under the floor, and how deep it goes. */
function belowFloor({ frames, joints }) {
	let count = 0;
	let deepest = 0;
	for (let frame = 0; frame < frames; frame += 1) {
		let lowest = Infinity;
		for (const foot of FEET) lowest = Math.min(lowest, joints[(frame * JOINTS + foot) * 3 + 1]);
		if (lowest < -FLOOR_TOLERANCE_M) {
			count += 1;
			deepest = Math.min(deepest, lowest);
		}
	}
	return { count, deepestCm: -deepest * 100 };
}

/** Straight-line XZ travel of the root, for context on the slide number. */
function travel({ frames, joints, root }) {
	const source = root ?? joints;
	const stride = root ? 3 : JOINTS * 3;
	const last = (frames - 1) * stride;
	return Math.hypot(source[last] - source[0], source[last + 2] - source[2]);
}

/** Accept an NPZ path (legacy CLI/API) or a converted motion object. */
export function mocapMetrics(input) {
	if (typeof input === "string") {
		const take = read(input);
		return mocapMetricsFromMotion(take, { path: input });
	}
	return mocapMetricsFromMotion(input);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const paths = process.argv.slice(2);
	if (!paths.length) {
	console.error("usage: node tools/ardy/mocap-metrics.mjs <a.npz> [<b.npz> ...]");
		process.exit(2);
	}
	const rows = paths.map(mocapMetrics);
	const columns = [
		["take", (row) => row.path.replace(/^.*\//, ""), 26],
		["frames", (row) => String(row.frames), 6],
		["fps", (row) => String(row.fps), 3],
		["foot slide cm/s", (row) => row.footSlideCmPerS.toFixed(2), 15],
		["jitter mm/f^2", (row) => row.jitterMmPerFrame2.toFixed(3), 13],
		["jitter mm/s^2", (row) => row.jitterMmPerS2.toFixed(1), 13],
		["below floor", (row) => `${row.framesBelowFloor} (${row.deepestBelowFloorCm.toFixed(1)} cm)`, 16],
		["root travel m", (row) => row.rootTravelM.toFixed(2), 13],
	];
	const line = (cells) => cells.map((cell, index) => cell.padEnd(columns[index][2])).join("  ").trimEnd();
	console.log(line(columns.map(([title]) => title)));
	console.log(line(columns.map(([, , width]) => "-".repeat(width))));
	for (const row of rows) console.log(line(columns.map(([, value]) => value(row))));
}
