#!/usr/bin/env node

// Line editing, wired end to end (contract C6, wave 2).
//
// Wave 1's modules are pinned by their own verify files: the runner's command
// shape (verify-projflow-runner.mjs), the skeleton converter's round trip
// (verify-projflow-cskel27.mjs), the draw UI's payload (verify-line-edit.mjs).
// THIS file pins what sits between them — the bridge's validator and routing,
// the two frame clocks, the splice, and the health capability the app gates the
// whole affordance on.
//
// Nothing here talks to a GPU. The box call (lineEditOnBox) is injected into
// runLineEditJob, and the two ssh probes are answered by a fake `ssh` on PATH,
// so every number below is produced by the same code a real run would use, on
// fixtures small enough to read.

import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalCskel27Reference } from "../src/ardy/to-cskel27.js";
import { motionArraysToNpzMembers, writeNpz } from "../tools/ardy/npz.mjs";
import { GEN_FPS, NUM_JOINTS, readNpyFloat32, writeNpyFloat32 } from "../tools/projflow/generate.mjs";
import { nativeMotionPath } from "../tools/projflow/runner.mjs";
import {
	APP_FPS,
	medianFrameStep,
	readTakeNpz,
	resamplePositions,
	runLineEditJob,
	scaleFrameRange,
	spliceEditedRange,
	toGenFrames,
} from "../tools/projflow/line-edit-job.mjs";

function pass(label) { console.log(`PASS ${label}`); }

const REPO = new URL("..", import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const READY_TIMEOUT_MS = 15_000;

let failures = 0;
const work = mkdtempSync(join(tmpdir(), "cclay-projflow-bridge-"));

/* ------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* ------------------------------------------------------------------------- */

// A take whose every frame is identifiable (it slides along +Z at a constant
// 0.05 m/frame) and whose pose is the canonical cskel27 body — the converter
// measures a leg length off frame 0, so a fixture of zeros could not be lifted.
function syntheticTake(frames, { fps = APP_FPS, step = 0.05 } = {}) {
	const reference = canonicalCskel27Reference();
	const rotMats = new Float32Array(frames * 27 * 9);
	const rootPos = new Float32Array(frames * 3);
	const posedJoints = new Float32Array(frames * 27 * 3);
	for (let frame = 0; frame < frames; frame += 1) {
		for (let joint = 0; joint < 27; joint += 1) {
			const rot = (frame * 27 + joint) * 9;
			rotMats[rot] = 1; rotMats[rot + 4] = 1; rotMats[rot + 8] = 1;
			const pos = (frame * 27 + joint) * 3;
			posedJoints[pos] = reference.posed_joints[joint][0];
			posedJoints[pos + 1] = reference.posed_joints[joint][1];
			posedJoints[pos + 2] = reference.posed_joints[joint][2] + frame * step;
		}
		rootPos[frame * 3 + 1] = reference.posed_joints[0][1];
		rootPos[frame * 3 + 2] = frame * step;
	}
	return { frames, fps, rotMats, rootPos, posedJoints };
}

function writeTake(path, motion) {
	writeNpz(path, motionArraysToNpzMembers(motion));
	return path;
}

const CAMERA = {
	fx: 1.2, fy: 1.6, cx: 0.5, cy: 0.5,
	R: [1, 0, 0, 0, 1, 0, 0, 0, 1],
	t: [0, 0, 4],
};
const POINTS = [[0.3, 0.5], [0.5, 0.35], [0.7, 0.5]];

/* ------------------------------------------------------------------------- */
/* the clock: 24 fps app frames -> 20 fps generation frames                    */
/* ------------------------------------------------------------------------- */
// ONE rounding rule, half-up, used for the clip length and for both ends of the
// range. Unlike Kimodo's cliGenFrames (which must reproduce a python int() on
// the box) nothing truncates here: driver.py derives T from the source npy the
// job writes, so the source length is authoritative and the only requirement is
// that the SAME rule scales the range.
{
	assert.equal(toGenFrames(120), 100, "5 s of 24 fps is 100 generation frames");
	assert.equal(toGenFrames(24), 20);
	assert.equal(toGenFrames(196), 163, "163.33 rounds down");
	assert.equal(toGenFrames(117), 98, "97.5 rounds half UP, the same way at every call site");
	assert.equal(toGenFrames(0), 0);
	pass("the 24 -> 20 scaler is round(frames * 20/24), one rule everywhere");

	// Half-open app range -> driver.py's INCLUSIVE {start, end}.
	assert.deepEqual(scaleFrameRange({ startFrame: 48, endFrame: 72 }, 100), { start: 40, end: 59 });
	assert.deepEqual(scaleFrameRange({ startFrame: 0, endFrame: 120 }, 100), { start: 0, end: 99 },
		"a range that ends at the clip must land on the LAST row, never one past it");
	assert.deepEqual(scaleFrameRange({ startFrame: 118, endFrame: 120 }, 100), { start: 98, end: 99 },
		"a two-frame edit at the tail keeps two frames");
	assert.deepEqual(scaleFrameRange({ startFrame: 0, endFrame: 2 }, 100), { start: 0, end: 1 },
		"a two-frame edit at the head does too, even though 2 frames scale to 2");
	for (const genFrames of [2, 7, 51, 100, 163]) {
		for (const [startFrame, endFrame] of [[0, 2], [3, 9], [10, 120], [0, 144]]) {
			if (endFrame > Math.round(genFrames * 6 / 5) + 1) continue;
			const { start, end } = scaleFrameRange({ startFrame, endFrame }, genFrames);
			assert.ok(start >= 0 && end < genFrames, `${startFrame}..${endFrame} must stay inside 0..${genFrames - 1}`);
			assert.ok(end > start, "the driver's span must stay at least 2 frames");
		}
	}
	assert.throws(() => scaleFrameRange({ startFrame: 5, endFrame: 5 }, 100), /non-empty half-open range/);
	assert.throws(() => scaleFrameRange({ startFrame: 0, endFrame: 10 }, 1), /at least 2 frames/);
	pass("frameRange scales with the same rule and is clamped into the driver's inclusive index space");
}

/* ------------------------------------------------------------------------- */
/* the source resample is LINEAR, not nearest                                  */
/* ------------------------------------------------------------------------- */
// driver.py pins these frames as hard identity rows, so a resampled frame is an
// observation the sampler must satisfy exactly. Nearest-neighbour would stutter
// every 6th frame and the box would faithfully reproduce the stutter.
{
	const frames = 6;
	const positions = new Float32Array(frames * 1 * 3);
	for (let frame = 0; frame < frames; frame += 1) positions[frame * 3] = frame; // x = t
	const out = resamplePositions(positions, { joints: 1, inFrames: frames, outFrames: 5 });
	assert.equal(out.length, 15);
	assert.equal(out[0], 0, "the first frame is exact");
	for (let frame = 0; frame < 5; frame += 1) {
		assert.ok(Math.abs(out[frame * 3] - frame * (6 / 5)) < 1e-5, `frame ${frame} must interpolate, not snap`);
	}
	assert.ok(out.some((value, index) => index % 3 === 0 && !Number.isInteger(Number(value.toFixed(6)))),
		"a nearest-neighbour resample would produce only whole-numbered samples here");
	assert.throws(() => resamplePositions(positions, { joints: 1, inFrames: 5, outFrames: 5 }), /expected 15 values/);
	pass("the 24 -> 20 source resample lerps between frames");
}

/* ------------------------------------------------------------------------- */
/* the .npy round trip (the source file driver.py derives T from)              */
/* ------------------------------------------------------------------------- */
{
	const path = join(work, "roundtrip.npy");
	const data = new Float32Array(3 * NUM_JOINTS * 3);
	for (let index = 0; index < data.length; index += 1) data[index] = index * 0.25;
	writeNpyFloat32(path, data, [3, NUM_JOINTS, 3]);
	const read = readNpyFloat32(path);
	assert.deepEqual(read.shape, [3, NUM_JOINTS, 3]);
	assert.deepEqual([...read.data], [...data]);
	assert.throws(() => writeNpyFloat32(path, data, [4, NUM_JOINTS, 3]), /needs 264 values/);
	assert.throws(() => writeNpyFloat32(path, Float32Array.of(Number.NaN), [1]), /is NaN/);
	pass("writeNpyFloat32 round-trips through this module's own reader");
}

/* ------------------------------------------------------------------------- */
/* the splice: outside the range is the source take, byte for byte             */
/* ------------------------------------------------------------------------- */
const SEAM = {};
{
	const takePath = writeTake(join(work, "splice-source.npz"), syntheticTake(120));
	const take = readTakeNpz(takePath);
	assert.equal(take.frames, 120);
	assert.equal(take.fps, 24);

	// The "edited" motion is the take lifted 0.5 m: every spliced frame differs
	// from its source by a known amount, so both seams have an arithmetic answer.
	const edited = {
		frames: 120,
		fps: 24,
		rotMats: new Float32Array(take.rotMats),
		rootPos: new Float32Array(take.rootPos),
		posedJoints: Float32Array.from(take.posedJoints, (value, index) => (index % 3 === 1 ? value + 0.5 : value)),
	};
	const spliced = spliceEditedRange(take, edited, { startFrame: 48, endFrame: 72 });

	// (a) OUTSIDE the range: byte-identical, every array.
	for (const [key, stride] of [["rotMats", 27 * 9], ["rootPos", 3], ["posedJoints", 27 * 3]]) {
		for (const [from, to] of [[0, 48], [72, 120]]) {
			assert.deepEqual(
				[...spliced.motion[key].subarray(from * stride, to * stride)],
				[...take[key].subarray(from * stride, to * stride)],
				`${key} frames ${from}..${to} must be the source take's own bytes`,
			);
		}
	}
	// (b) INSIDE: replaced, every frame.
	for (let frame = 48; frame < 72; frame += 1) {
		const y = spliced.motion.posedJoints[(frame * 27) * 3 + 1];
		assert.ok(Math.abs(y - (take.posedJoints[(frame * 27) * 3 + 1] + 0.5)) < 1e-6, `frame ${frame} must be edited`);
	}
	assert.equal(spliced.framesClamped, 0, "an equal-length edit clamps nothing");

	// (c) the seam numbers gate GP2 reads. The take walks 0.05 m/frame, so its
	// median frame delta is exactly that; each seam adds the 0.5 m lift on top.
	const expected = Math.hypot(0.5, 0.05);
	assert.ok(Math.abs(spliced.medianFrameDelta - 0.05) < 1e-6, `median frame delta ${spliced.medianFrameDelta}`);
	assert.ok(Math.abs(spliced.seamStartDelta - expected) < 1e-5, `seamStartDelta ${spliced.seamStartDelta}`);
	assert.ok(Math.abs(spliced.seamEndDelta - expected) < 1e-5, `seamEndDelta ${spliced.seamEndDelta}`);
	assert.ok(Math.abs(spliced.seamStartRatio - expected / 0.05) < 1e-4, "the ratio is the gate's own unit");
	SEAM.hardCut = { ...spliced, motion: undefined };
	console.log(
		`      seam deltas (0.5 m step spliced into a 0.05 m/frame walk): ` +
		`start ${spliced.seamStartDelta.toFixed(4)} m, end ${spliced.seamEndDelta.toFixed(4)} m, ` +
		`median ${spliced.medianFrameDelta.toFixed(4)} m/frame, ratio ${spliced.seamStartRatio.toFixed(2)}x`,
	);
	pass("a hard splice keeps the take outside the range and measures both seams");

	// (d) an edit that IS the take produces no seam at all — the measurement has
	// to be able to say "nothing popped", or it cannot gate anything.
	const identity = spliceEditedRange(take, take, { startFrame: 48, endFrame: 72 });
	assert.ok(Math.abs(identity.seamStartDelta - 0.05) < 1e-6, "an unchanged splice's seam is the take's own step");
	assert.ok(Math.abs(identity.seamEndDelta - 0.05) < 1e-6);
	assert.ok(Math.abs(identity.seamStartRatio - 1) < 1e-4, "which is exactly 1x the median");
	assert.deepEqual([...identity.motion.posedJoints], [...take.posedJoints], "and the take is unchanged end to end");

	// (e) a range that reaches the clip's end has ONE seam, not a fabricated one.
	const tail = spliceEditedRange(take, edited, { startFrame: 100, endFrame: 120 });
	assert.equal(tail.seamEndDelta, 0, "there is no frame after the clip to pop into");
	assert.ok(tail.seamStartDelta > 0.4);

	// (f) the off-by-one of the 24 -> 20 -> 24 round trip is clamped, not fatal.
	const short = { ...edited, frames: 119, posedJoints: edited.posedJoints.subarray(0, 119 * 27 * 3), rotMats: edited.rotMats.subarray(0, 119 * 27 * 9), rootPos: edited.rootPos.subarray(0, 119 * 3) };
	const clamped = spliceEditedRange(take, short, { startFrame: 100, endFrame: 120 });
	assert.equal(clamped.framesClamped, 1, "exactly the one missing tail frame is reused");

	assert.throws(() => spliceEditedRange(take, edited, { startFrame: 100, endFrame: 121 }), /past the take's 120 frames/);
	assert.throws(() => spliceEditedRange(take, edited, { startFrame: 10, endFrame: 10 }), /non-empty half-open range/);
	pass("seam measurement reports 1x on an unchanged splice and skips absent seams");
}

/* ------------------------------------------------------------------------- */
/* runLineEditJob: the whole composition, with the box mocked                  */
/* ------------------------------------------------------------------------- */
{
	const takePath = writeTake(join(work, "job-source.npz"), syntheticTake(120));
	const take = readTakeNpz(takePath);
	const outputPath = join(work, "job-out.npz");
	const LINE = {
		sourceMotion: "/ardy/motions/1700000000000-abcdef",
		track: "leftHand",
		frameRange: { startFrame: 48, endFrame: 72 },
		points2d: POINTS,
		camera: CAMERA,
		prompt: "A person reaches",
	};

	let seen = null;
	// The mock stands in for the GPU and nothing else: it reads the source npy
	// the job wrote (so the file is proved to be a real .npy of the right shape),
	// moves the edited joint inside the requested range, and hands back the same
	// clip length — which is what driver.py does, since it edits in place.
	const fakeBox = async (options) => {
		const { shape, data } = readNpyFloat32(options.sourceMotionNpy);
		// Recorded here, not after the call: the job removes its run directory in
		// a `finally`, so the source npy does not outlive the box.
		seen = { ...options, sourceShape: shape };
		const positions = new Float32Array(data);
		const [frames] = shape;
		// left_wrist (hml22 20 = the leftHand track), lifted 0.25 m in +Y.
		// PERPENDICULAR to the bone on purpose: the converter takes bone LENGTHS
		// from the reference body, so a displacement along the arm's own axis is
		// discarded by construction and would make this fixture look like a
		// no-op edit.
		for (let frame = options.line.frameRange.start; frame <= options.line.frameRange.end; frame += 1) {
			positions[(frame * NUM_JOINTS + 20) * 3 + 1] += 0.25;
		}
		return {
			positions,
			frames,
			joints: NUM_JOINTS,
			fps: GEN_FPS,
			meta: { m: 214, steps: 100, sampling_seconds: 0.85, checks: { lineMaxReprojErr: 2.4e-7, preservedMaxAbsDiffM: 4.8e-7 } },
			line: options.line,
			nativeNpy: options.nativeOut || null,
		};
	};

	const meta = await runLineEditJob({ lineEdit: LINE, takePath, outputPath, seed: 7, runLineEdit: fakeBox });

	// (a) what the box was handed.
	assert.ok(seen, "the job must call the box exactly once");
	assert.deepEqual(seen.sourceShape, [100, NUM_JOINTS, 3],
		"the source npy is the take resampled onto the 20 fps clock — the T driver.py derives its columns from");
	assert.deepEqual(seen.line.frameRange, { start: 40, end: 59 }, "the range reached the driver on the 20 fps clock, inclusive");
	assert.deepEqual(seen.line.camera.R, [[1, 0, 0], [0, 1, 0], [0, 0, 1]], "flat C6 R is nested for buildLineRequest");
	assert.equal(seen.line.track, "leftHand");
	assert.equal(seen.line.prompt, "A person reaches");
	assert.equal(seen.seed, 7);
	assert.equal(seen.nativeOut, nativeMotionPath(outputPath), "the raw hml22 result is kept beside the take");

	// (b) the meta a gate reads.
	assert.equal(meta.frames, 120, "the take keeps its length");
	assert.equal(meta.fps, APP_FPS);
	assert.equal(meta.genFrames, 100);
	assert.equal(meta.genFps, GEN_FPS);
	assert.deepEqual(meta.genFrameRange, { start: 40, end: 59 });
	assert.deepEqual(meta.appFrameRange, { startFrame: 48, endFrame: 72 });
	assert.equal(meta.box.m, 214, "the driver's own numbers ride through");
	assert.ok(Number.isFinite(meta.seamStartDelta) && Number.isFinite(meta.seamEndDelta));
	assert.ok(Number.isFinite(meta.medianFrameDelta) && meta.medianFrameDelta > 0);
	assert.ok(Number.isFinite(meta.timings.totalMs));

	// (c) the written take: source outside, edited inside.
	const result = readTakeNpz(outputPath);
	assert.equal(result.frames, 120);
	assert.equal(result.fps, 24);
	for (const [key, stride] of [["rotMats", 27 * 9], ["rootPos", 3], ["posedJoints", 27 * 3]]) {
		for (const [from, to] of [[0, 48], [72, 120]]) {
			assert.deepEqual(
				[...result[key].subarray(from * stride, to * stride)],
				[...take[key].subarray(from * stride, to * stride)],
				`${key} outside the edit range must be the source take, byte for byte`,
			);
		}
	}
	let moved = 0;
	for (let frame = 48; frame < 72; frame += 1) {
		for (let joint = 0; joint < 27; joint += 1) {
			const index = (frame * 27 + joint) * 3;
			if (Math.abs(result.posedJoints[index] - take.posedJoints[index]) > 1e-4) moved += 1;
		}
	}
	assert.ok(moved > 0, "the edited span must actually differ from the source");
	console.log(
		`      composition: ${meta.genFrames} gen frames, seams ${meta.seamStartDelta.toFixed(4)} / ` +
		`${meta.seamEndDelta.toFixed(4)} m vs median ${meta.medianFrameDelta.toFixed(4)} m/frame`,
	);
	pass("runLineEditJob composes take -> hml22 -> box -> cskel27 -> retime -> splice -> npz");

	// (d) refusals that must not cost a GPU round trip.
	await assert.rejects(
		() => runLineEditJob({ lineEdit: { ...LINE, frameRange: { startFrame: 100, endFrame: 200 } }, takePath, outputPath, runLineEdit: fakeBox }),
		/frameRange ends at 200 but the source take has 120 frames/,
		"the range is re-checked against the FILE, not against the duration the request claimed",
	);
	await assert.rejects(
		() => runLineEditJob({
			lineEdit: LINE, takePath, outputPath,
			runLineEdit: async (options) => ({ ...(await fakeBox(options)), frames: 99 }),
		}),
		/returned 99 frames for a 100-frame source/,
		"a result of a different length would splice onto the wrong frames",
	);
	pass("the job refuses a range the take does not contain and a result of the wrong length");
}

/* ------------------------------------------------------------------------- */
/* the bridge, over the wire                                                   */
/* ------------------------------------------------------------------------- */
// bridge.mjs binds a socket on load, so its validator is exercised the way a
// client sees it: a real sidecar on a loopback port, one POST per rule.

function freePort() {
	return new Promise((resolvePromise, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address();
			probe.close((error) => (error ? reject(error) : resolvePromise(port)));
		});
	});
}

// Both backends probe the box by spawning `ssh`, so a fake ssh on PATH is the
// whole test harness for health: it answers the ProjFlow probe's three lines
// (device / models / checkpoint) and Kimodo's one, and it FAILS for any host
// spelled "broken" and reports a missing checkpoint for any host spelled
// "nockpt". No network, no box, no timeouts.
const fakeBin = join(work, "bin");
{
	const { mkdirSync } = await import("node:fs");
	mkdirSync(fakeBin, { recursive: true });
	const script = [
		"#!/bin/sh",
		'for arg in "$@"; do',
		'  case "$arg" in',
		"    *broken*) exit 255 ;;",
		'    *nockpt*) echo "device=cuda:0"; echo "models=3"; echo "checkpoint=no"; exit 0 ;;',
		"  esac",
		"done",
		'echo "device=cuda:0"',
		'echo "models=3"',
		'echo "checkpoint=yes"',
		"exit 0",
		"",
	].join("\n");
	const path = join(fakeBin, "ssh");
	writeFileSync(path, script);
	chmodSync(path, 0o755);
}

async function startBridge(env) {
	const port = await freePort();
	const bridge = fork(join(HERE, "..", "tools", "ardy", "bridge.mjs"), [], {
		cwd: REPO,
		env: {
			...process.env,
			PATH: `${fakeBin}:${process.env.PATH}`,
			CCLAY_MOTION_BACKEND: "kimodo",
			CCLAY_KIMODO_HOST: "test@kimodo",
			COZYCLAY_BRIDGE_PORT: String(port),
			...env,
		},
		stdio: ["ignore", "ignore", "ignore", "ipc"],
	});
	const ready = await Promise.race([
		once(bridge, "message"),
		new Promise((_, reject) => setTimeout(() => reject(new Error("bridge did not report readiness")), READY_TIMEOUT_MS).unref()),
	]);
	assert.deepEqual(ready[0], { type: "cozyclay-bridge-ready", port });
	return { bridge, port };
}

/* ---- health: the capability the app gates the affordance on ---- */
{
	// (a) a box whose ProjFlow probe passes ADVERTISES the capability.
	const ok = await startBridge({ CCLAY_PROJFLOW_HOST: "test@projflow" });
	try {
		const response = await fetch(`http://127.0.0.1:${ok.port}/ardy/health`);
		assert.equal(response.status, 200);
		const payload = await response.json();
		assert.equal(payload.ok, true);
		assert.equal(payload.capabilities?.lineEdit, true, "capabilities.lineEdit must be advertised");
		// App.jsx reads `payload.capabilities.lineEdit === true`; anything else
		// (a bare string, a missing object) leaves the feature dark.
		assert.equal(typeof payload.capabilities, "object");
		pass("health advertises capabilities.lineEdit when the projflow probe passes");
	} finally {
		ok.bridge.kill("SIGTERM");
	}

	// (b) same bridge, unreachable ProjFlow box: Kimodo health is UNAFFECTED and
	// the capability is simply absent. A box without the scout env must not
	// advertise, and must not 503 the endpoint either.
	const broken = await startBridge({ CCLAY_PROJFLOW_HOST: "broken@projflow" });
	try {
		const response = await fetch(`http://127.0.0.1:${broken.port}/ardy/health`);
		assert.equal(response.status, 200, "the selected backend's health is not the line editor's business");
		const payload = await response.json();
		assert.equal(payload.ok, true);
		assert.equal(payload.capabilities.lineEdit, false, "an unreachable box must not advertise line editing");
		pass("health reports capabilities.lineEdit:false when the projflow probe fails");
	} finally {
		broken.bridge.kill("SIGTERM");
	}

	// (c) reachable box, missing checkpoint: the other half of the probe, and the
	// one a stale scout directory actually hits.
	const noCheckpoint = await startBridge({ CCLAY_PROJFLOW_HOST: "nockpt@projflow" });
	try {
		const payload = await (await fetch(`http://127.0.0.1:${noCheckpoint.port}/ardy/health`)).json();
		assert.equal(payload.capabilities.lineEdit, false, "no checkpoint, no capability");
		pass("a reachable box with no ACMDM checkpoint does not advertise line editing");
	} finally {
		noCheckpoint.bridge.kill("SIGTERM");
	}
}

/* ---- validation ---- */
{
	const { bridge, port } = await startBridge({ CCLAY_PROJFLOW_HOST: "test@projflow" });
	try {
		// duration 5 s on the bridge's 24 fps clock = a 120-frame clip.
		const CLIP_FRAMES = 120;
		const MOTION = "/ardy/motions/1700000000000-abcdef";
		const POSE = { schema: "cozyclay.pose.v1", root: [0, 0.9, 0] };
		const OK_LINE = {
			sourceMotion: MOTION,
			track: "leftHand",
			frameRange: { startFrame: 48, endFrame: 72 },
			points2d: POINTS,
			camera: CAMERA,
			prompt: "A person reaches",
		};
		const BODY = { prompt: "A person walks", duration: 5, posePin: false };

		async function post(body) {
			const response = await fetch(`http://127.0.0.1:${port}/ardy/generate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const text = await response.text();
			const first = text.split("\n").find(Boolean) ?? "";
			return { status: response.status, ...JSON.parse(first) };
		}

		async function refuses(label, body, pattern) {
			const { status, reason, message } = await post(body);
			const said = reason ?? message ?? "";
			try {
				assert.equal(status, 400, `${label} must be refused with 400, got ${status} (${said})`);
				assert.match(said, pattern, label);
				pass(label);
			} catch (error) {
				failures += 1;
				console.error(`FAIL ${error.message}`);
			}
		}

		// ---- shape ---------------------------------------------------------
		await refuses("lineEdit must be an object", { ...BODY, lineEdit: [] }, /field 'lineEdit' must be an object/);
		await refuses("lineEdit must not be a string", { ...BODY, lineEdit: "leftHand" }, /field 'lineEdit' must be an object/);

		// ---- exclusivity: every pair C6 names ------------------------------
		for (const [field, value] of [
			["preserve", { sourceMotion: MOTION, strength: 0.5, editRanges: [] }],
			["waypoints", [{ frame: 0, x: 0, z: 0, heading: null }, { frame: 60, x: 3, z: 0, heading: null }]],
			["segments", [{ startFrame: 0, endFrame: 60, prompt: "a" }, { startFrame: 60, endFrame: 120, prompt: "b" }]],
			["regenerateSegments", [{ startFrame: 0, endFrame: 60, prompt: "a" }]],
			["motionEdit", { sourceMotion: MOTION, startFrame: 10, endFrame: 40, contextBefore: 8, contextAfter: 8, edits: [{ frame: 20, tracks: ["hips"], pose: POSE }] }],
			["poses", [{ frame: 0, pose: POSE }]],
			["pose", POSE],
		]) {
			await refuses(
				`lineEdit + ${field} is refused by name`,
				{ ...BODY, lineEdit: OK_LINE, [field]: value },
				new RegExp(`field 'lineEdit' cannot be combined with ${field}: contract C6`),
			);
		}
		// posePin defaults to TRUE, which would demand a pose array a line edit
		// does not have; the refusal must name lineEdit, not 'poses'.
		await refuses(
			"a line edit must say posePin:false",
			{ prompt: "A person walks", duration: 5, lineEdit: OK_LINE },
			/field 'lineEdit' requires posePin:false/,
		);

		// ---- sourceMotion ---------------------------------------------------
		await refuses(
			"sourceMotion must be a motion URL",
			{ ...BODY, lineEdit: { ...OK_LINE, sourceMotion: "/etc/passwd" } },
			/'lineEdit\.sourceMotion' must be a generated \/ardy\/motions\/<run-id> URL/,
		);
		await refuses(
			"sourceMotion must carry a well-formed run id",
			{ ...BODY, lineEdit: { ...OK_LINE, sourceMotion: "/ardy/motions/../../etc" } },
			/'lineEdit\.sourceMotion'/,
		);
		await refuses("sourceMotion is required", { ...BODY, lineEdit: { ...OK_LINE, sourceMotion: undefined } }, /'lineEdit\.sourceMotion'/);

		// ---- track ----------------------------------------------------------
		await refuses(
			"an unknown track is named, with the valid ones",
			{ ...BODY, lineEdit: { ...OK_LINE, track: "LeftArm" } },
			/'lineEdit\.track' "LeftArm" is not a line-editable IK track id; valid ids are .*leftHand/,
		);
		await refuses("a non-string track is refused", { ...BODY, lineEdit: { ...OK_LINE, track: 20 } }, /'lineEdit\.track' 20 is not a line-editable/);
		await refuses(
			"a prototype property is not a track id",
			{ ...BODY, lineEdit: { ...OK_LINE, track: "constructor" } },
			/is not a line-editable IK track id/,
		);
		// `chest` is a REAL pose-studio track with no hml22 source joint. It must
		// be refused by name and with the reason, never retargeted.
		await refuses(
			"chest is refused by name, with the reason and an alternative",
			{ ...BODY, lineEdit: { ...OK_LINE, track: "chest" } },
			/'lineEdit\.track' "chest" cannot be line-edited: cskel27 Spine2 has no hml22 source joint.*draw on spine or neck instead/,
		);

		// ---- frameRange (app clip frames) -----------------------------------
		await refuses("frameRange must be an object", { ...BODY, lineEdit: { ...OK_LINE, frameRange: [48, 72] } }, /'lineEdit\.frameRange' must be an object/);
		await refuses(
			"frameRange must be integers",
			{ ...BODY, lineEdit: { ...OK_LINE, frameRange: { startFrame: 48.5, endFrame: 72 } } },
			/'lineEdit\.frameRange' startFrame and endFrame must be integers/,
		);
		await refuses(
			"frameRange must not be inverted",
			{ ...BODY, lineEdit: { ...OK_LINE, frameRange: { startFrame: 72, endFrame: 48 } } },
			/'lineEdit\.frameRange' must be a non-empty half-open range inside 0\.\.120/,
		);
		await refuses(
			"frameRange must not start before the clip",
			{ ...BODY, lineEdit: { ...OK_LINE, frameRange: { startFrame: -1, endFrame: 48 } } },
			/'lineEdit\.frameRange' must be a non-empty half-open range inside 0\.\.120/,
		);
		await refuses(
			"frameRange must not run past the clip",
			{ ...BODY, lineEdit: { ...OK_LINE, frameRange: { startFrame: 100, endFrame: CLIP_FRAMES + 1 } } },
			/'lineEdit\.frameRange' must be a non-empty half-open range inside 0\.\.120/,
		);
		await refuses(
			"a one-frame range is a pin, not a line",
			{ ...BODY, lineEdit: { ...OK_LINE, frameRange: { startFrame: 48, endFrame: 49 } } },
			/'lineEdit\.frameRange' must span at least 2 frames/,
		);

		// ---- points2d --------------------------------------------------------
		await refuses("points2d must be an array", { ...BODY, lineEdit: { ...OK_LINE, points2d: "line" } }, /'lineEdit\.points2d' needs at least 2 points/);
		await refuses("one point is not a line", { ...BODY, lineEdit: { ...OK_LINE, points2d: [[0.5, 0.5]] } }, /'lineEdit\.points2d' needs at least 2 points/);
		await refuses(
			"the 64-point cap is the box's solver budget",
			{ ...BODY, lineEdit: { ...OK_LINE, points2d: Array.from({ length: 65 }, (_, i) => [i / 64, 0.5]) } },
			/'lineEdit\.points2d' is capped at 64 points, got 65/,
		);
		await refuses(
			"a point must be a pair",
			{ ...BODY, lineEdit: { ...OK_LINE, points2d: [[0.5, 0.5], [0.6]] } },
			/'lineEdit\.points2d\[1\]' must be \[u, v\] finite numbers/,
		);
		await refuses(
			"a point must be finite",
			{ ...BODY, lineEdit: { ...OK_LINE, points2d: [[0.5, 0.5], [0.6, null]] } },
			/'lineEdit\.points2d\[1\]'/,
		);
		await refuses(
			"pixels are not normalised coordinates",
			{ ...BODY, lineEdit: { ...OK_LINE, points2d: [[0.5, 0.5], [640, 360]] } },
			/'lineEdit\.points2d\[1\]' must be viewport-normalized into 0\.\.1/,
		);

		// ---- camera ----------------------------------------------------------
		await refuses("camera is required", { ...BODY, lineEdit: { ...OK_LINE, camera: undefined } }, /'lineEdit\.camera' must be an object/);
		await refuses("camera must not be an array", { ...BODY, lineEdit: { ...OK_LINE, camera: [] } }, /'lineEdit\.camera' must be an object/);
		for (const key of ["fx", "fy", "cx", "cy"]) {
			await refuses(
				`camera.${key} must be finite`,
				{ ...BODY, lineEdit: { ...OK_LINE, camera: { ...CAMERA, [key]: null } } },
				new RegExp(`'lineEdit\\.camera\\.${key}' must be a finite number`),
			);
		}
		await refuses(
			"a negative focal length means the uv flip was applied twice",
			{ ...BODY, lineEdit: { ...OK_LINE, camera: { ...CAMERA, fx: -1.2 } } },
			/non-positive focal length/,
		);
		await refuses(
			"pixel focal lengths beside normalised points",
			{ ...BODY, lineEdit: { ...OK_LINE, camera: { ...CAMERA, fx: 1200, fy: 1200 } } },
			/PIXEL focal lengths \(1200, 1200\)/,
		);
		await refuses(
			"R must be 9 numbers, not a 3x3",
			{ ...BODY, lineEdit: { ...OK_LINE, camera: { ...CAMERA, R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] } } },
			/'lineEdit\.camera\.R' must be 9 finite numbers/,
		);
		await refuses(
			"R must be full",
			{ ...BODY, lineEdit: { ...OK_LINE, camera: { ...CAMERA, R: [1, 0, 0, 0, 1, 0] } } },
			/'lineEdit\.camera\.R' must be 9 finite numbers/,
		);
		await refuses(
			"t must be a 3-vector",
			{ ...BODY, lineEdit: { ...OK_LINE, camera: { ...CAMERA, t: [0, 0] } } },
			/'lineEdit\.camera\.t' must be 3 finite numbers/,
		);
		await refuses(
			"a non-finite extrinsic is refused",
			{ ...BODY, lineEdit: { ...OK_LINE, camera: { ...CAMERA, t: [0, 0, "4"] } } },
			/'lineEdit\.camera\.t' must be 3 finite numbers/,
		);
		await refuses("prompt must be a string when present", { ...BODY, lineEdit: { ...OK_LINE, prompt: 7 } }, /'lineEdit\.prompt' must be a string/);

		// ---- accepted: validation passes and the take is resolved ------------
		{
			const { status, reason } = await post({ ...BODY, lineEdit: OK_LINE });
			assert.equal(status, 400);
			assert.match(reason, /field 'lineEdit\.sourceMotion': unknown or expired motion "1700000000000-abcdef"/,
				"a well-formed line edit gets past the validator and dies on the allowlist");
			pass("a well-formed line edit is resolved against the motion allowlist");
		}
		{
			// The whole clip, every mappable track, and a 64-point stroke: the
			// boundary cases the app can actually produce.
			for (const track of ["rightHand", "leftFoot", "hips", "head", "leftShoulder", "leftElbow", "spine", "neck"]) {
				const { reason } = await post({
					...BODY,
					lineEdit: {
						...OK_LINE,
						track,
						frameRange: { startFrame: 0, endFrame: CLIP_FRAMES },
						points2d: Array.from({ length: 64 }, (_, i) => [i / 63, 0.5]),
					},
				});
				assert.match(reason, /unknown or expired motion/, `${track} must be accepted`);
			}
			pass("every mappable track, the whole clip and a full 64-point stroke are accepted");
		}
		{
			// Nothing above may have disturbed a request that carries no lineEdit.
			const { status, reason } = await post({ ...BODY, duration: 0.05 });
			assert.equal(status, 400);
			assert.match(reason, /field 'duration' must be in /, "unrelated validation is unchanged");
			pass("requests without lineEdit validate exactly as before");
		}
	} finally {
		bridge.kill("SIGTERM");
	}
}

/* ------------------------------------------------------------------------- */
/* the source says what the wiring is, where a live run cannot reach           */
/* ------------------------------------------------------------------------- */
// Routing and the capability gate are only observable through a real box, so the
// two decisions are pinned against the source the way the sigma mapping is in
// verify-preserve-bridge.mjs.
{
	const bridgeSource = readFileSync(new URL("tools/ardy/bridge.mjs", REPO), "utf8");
	// Engine-per-task: the projflow runner is built BESIDE the selected one, and
	// a lineEdit never consults CCLAY_MOTION_BACKEND.
	assert.match(bridgeSource, /projflowRunner = createProjflowRunner\(\);/);
	assert.match(bridgeSource, /Promise\.all\(\[getHealth\(\), getLineEditCapability\(\)\]\)/);
	assert.match(bridgeSource, /capabilities: \{ lineEdit,/);
	// The take is registered like every other output, or the app could not load
	// the result of an edit — nor edit it a second time.
	assert.match(bridgeSource, /registerMotion\(stamp, outNpzPath\);\n\t\t\tsend\(\{ event: "done", output: outNpzPath, bytes: finalSize, motionUrl: `\/ardy\/motions\/\$\{stamp\}` \}\);/);
	assert.equal(medianFrameStep({ frames: 1, posedJoints: new Float32Array(81) }), 0, "a one-frame take has no delta");
	pass("line editing is engine-per-task, capability-gated, and registers its take");
}

rmSync(work, { recursive: true, force: true });

if (failures > 0) {
	console.error(`${failures} projflow bridge check(s) failed`);
	process.exit(1);
}
console.log("OK verify-projflow-bridge");
