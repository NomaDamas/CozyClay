#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, runT1, OBS_BENCH_STEPS } from "../tools/bench/obs-bench.mjs";
import { runTracker, TRACK_ABLATIONS, trackerInputNames } from "../tools/track/remote.mjs";

assert.ok(OBS_BENCH_STEPS.includes("T1"));
assert.deepEqual(parseArgs(["--approved", "approved.json", "--out", "out"]).steps, OBS_BENCH_STEPS);
assert.deepEqual(parseArgs(["--approved", "approved.json", "--out", "out", "--steps", "G5,T1"]).steps, ["G5", "T1"]);
assert.throws(() => parseArgs(["--approved", "approved.json", "--out", "out", "--steps", "T2"]), /unknown steps/);
assert.deepEqual(TRACK_ABLATIONS, ["kp-only", "silhouette", "viterbi", "contacts", "full"]);
assert.equal(parseArgs(["--approved", "approved.json", "--out", "out"]).trackAblate, "full");
for (const name of TRACK_ABLATIONS) assert.equal(parseArgs(["--approved", "approved.json", "--out", "out", "--track-ablate", name]).trackAblate, name);
assert.throws(() => parseArgs(["--approved", "approved.json", "--out", "out", "--track-ablate", "+silhouette"]), /--track-ablate must be one of/);
assert.throws(() => parseArgs(["--approved", "approved.json", "--out", "out", "--track-ablate"]), /needs a value/);

const root = mkdtempSync(join(tmpdir(), "obs-bench-t1-"));
try {
	const itemDir = join(root, "gt", "walk"), stepDir = join(itemDir, "T1");
	mkdirSync(join(itemDir, "Gbest"), { recursive: true });
	mkdirSync(stepDir, { recursive: true });
	const fallbackMotion = join(itemDir, "Gbest", "motion.npz");
	writeFileSync(fallbackMotion, "fallback-motion");
	const init = join(itemDir, "G5.npz"); writeFileSync(init, "init");
	const masks = join(itemDir, "masks.npz"); writeFileSync(masks, "masks");
	writeFileSync(join(itemDir, "camera.json"), JSON.stringify({ width: 832, height: 480, K: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }));
	const endpoint = { rootPos: Float32Array.of(1, 2, 3), rotMats: Float32Array.from({ length: 243 }, (_, i) => i) };
	const seen = [];
	const common = {
		item: { set: "gt", name: "walk" }, itemDir, stepDir, options: { character: "y-bot-tpose", host: "stub", obsRoot: root },
		inputs: { video: join(itemDir, "video.mp4"), obs: join(itemDir, "obs.npz"), camera: join(itemDir, "camera.json"), scene: null },
		g5MotionPath: init, obsPath: join(itemDir, "obs.npz"), log: () => {},
		masksRunner: async (args) => { seen.push(args); return { path: masks }; },
	};
	const failure = async (args) => { seen.push(args); throw new Error("ssh: Could not resolve hostname nobody"); };
	const ab = await runT1({ ...common, endpoints: [endpoint, endpoint], trackerRunner: failure });
	assert.equal(ab.fallback, "Gbest");
	assert.equal(readFileSync(join(stepDir, "motion.npz"), "utf8"), "fallback-motion");
	assert.equal(seen.at(-1).scenePath, join(itemDir, "empty-scene.json"));
	assert.ok(!Object.hasOwn(seen.at(-1), "source"));

	assert.equal(ab.diagnostics, null);

	// A rejected fit: fallback motion plus the tracker's own diagnostics.json.
	const rejectedStep = join(root, "rejected"); mkdirSync(rejectedStep, { recursive: true });
	writeFileSync(join(rejectedStep, "diagnostics.json"), "stale");
	const rejectedDiagnostics = { failure: "keypoint-residual", runtime: { trackerSeconds: 63, peakReservedMiB: 560 }, lrState: ["identity"], occluded: [[false]] };
	const rejected = await runT1({ ...common, stepDir: rejectedStep, endpoints: [endpoint, endpoint], trackerRunner: async (args) => {
		mkdirSync(args.outDir, { recursive: true });
		const diagnosticsPath = join(args.outDir, "diagnostics.json");
		writeFileSync(diagnosticsPath, JSON.stringify(rejectedDiagnostics));
		throw Object.assign(new Error("ssh exited 3: [track] result keypoint-residual"), { diagnostics: rejectedDiagnostics, diagnosticsPath });
	} });
	assert.equal(rejected.fallback, "Gbest");
	assert.equal(readFileSync(join(rejectedStep, "motion.npz"), "utf8"), "fallback-motion");
	assert.deepEqual(rejected.diagnostics, rejectedDiagnostics);
	assert.deepEqual(JSON.parse(readFileSync(join(rejectedStep, "diagnostics.json"), "utf8")), rejectedDiagnostics);
	assert.equal(rejected.trackerError.failure, "keypoint-residual");
	assert.match(rejected.trackerError.message, /ssh exited 3/);
	// A later failure without diagnostics leaves no stale file behind.
	await runT1({ ...common, stepDir: rejectedStep, endpoints: [endpoint, endpoint], trackerRunner: failure });
	assert.equal(existsSync(join(rejectedStep, "diagnostics.json")), false);

	const onlyA = join(root, "a-only");
	mkdirSync(join(onlyA, "G5"), { recursive: true });
	writeFileSync(join(onlyA, "G5", "motion.npz"), "g5-motion");
	const g5Step = join(onlyA, "T1"); mkdirSync(g5Step, { recursive: true });
	const result = await runT1({ ...common, itemDir: onlyA, stepDir: g5Step, endpoints: [endpoint], g5MotionPath: init, trackerRunner: failure });
	assert.equal(result.fallback, "G5");
	assert.equal(readFileSync(join(g5Step, "motion.npz"), "utf8"), "g5-motion");
	const aOnlyCamera = JSON.parse(readFileSync(join(g5Step, "camera.json"), "utf8"));
	assert.deepEqual(Object.keys(aOnlyCamera.tracker.endpoints), ["a"]);
	assert.match(result.trackerError.message, /Could not resolve hostname/);

	let captured;
	const outputDir = join(root, "stub-out");
	const success = await runT1({ ...common, endpoints: [endpoint, endpoint], trackerRunner: async (args) => {
		captured = args; mkdirSync(args.outDir, { recursive: true });
		writeFileSync(join(args.outDir, "motion.npz"), "tracked");
		writeFileSync(join(args.outDir, "diagnostics.json"), "{}");
		return { motionPath: join(args.outDir, "motion.npz"), diagnosticsPath: join(args.outDir, "diagnostics.json"), diagnostics: { runtime: { trackerSeconds: 1, peakReservedMiB: 2 }, lrState: ["identity"], occluded: [[false]] } };
	}, stepDir: join(root, "success"), masksRunner: async () => ({ path: masks }) });
	assert.equal(success.fallback, null);
	assert.equal(readFileSync(join(root, "success", "motion.npz"), "utf8"), "tracked");
	assert.equal(captured.initMotionPath, init);
	for (const key of ["video", "obsPath", "masksPath", "cameraPath", "scenePath", "rigPath", "initMotionPath"]) assert.ok(captured[key], `${key} wired`);
	const abCamera = JSON.parse(readFileSync(captured.cameraPath, "utf8"));
	assert.deepEqual(Object.keys(abCamera.tracker.endpoints).sort(), ["a", "b"]);
	assert.deepEqual(abCamera.tracker.endpoints.a.rootPos, [1, 2, 3]);
	assert.equal(abCamera.tracker.endpoints.b.rotMats.length, 243);
	assert.equal(Object.hasOwn(captured, "source"), false, "truth source never reaches runTracker");
	assert.equal(captured.ablate, undefined, "no option -> track.py default");

	let ablateCaptured;
	await runT1({ ...common, options: { ...common.options, trackAblate: "viterbi" }, endpoints: [endpoint, endpoint], stepDir: join(root, "ablate"), trackerRunner: async (args) => {
		ablateCaptured = args; mkdirSync(args.outDir, { recursive: true });
		writeFileSync(join(args.outDir, "motion.npz"), "tracked");
		writeFileSync(join(args.outDir, "diagnostics.json"), "{}");
		return { motionPath: join(args.outDir, "motion.npz"), diagnosticsPath: join(args.outDir, "diagnostics.json"), diagnostics: { runtime: { trackerSeconds: 1, peakReservedMiB: 2 }, lrState: ["identity"], occluded: [[false]] } };
	} });
	assert.equal(ablateCaptured.ablate, "viterbi", "obs-bench --track-ablate reaches runTracker");

	// runTracker forwards the level to track.py argv and keeps the seven-input upload set.
	const diagnosticsFixture = { version: 1, frames: 1, fps: 24, occluded: [Array(27).fill(false)], lrState: ["identity"], lrMargin: [0], ambiguous: [false], stance: { left: [false], right: [false] }, penetration: { maxBoxCm: 0, maxFloorCm: 0, frames: [] }, nuisance: { scale: 1, cameraDeltaDeg: [0, 0], fovDeltaPct: 0 }, stageLosses: { "ablation.kp-only": 1 }, runtime: { trackerSeconds: 1, peakReservedMiB: 0 }, failure: null };
	const boxCalls = [];
	const transport = { runBox: async (call) => { boxCalls.push(call); for (const item of call.fetch) writeFileSync(item.localPath, item.remoteRelPath === "diagnostics.json" ? JSON.stringify(diagnosticsFixture) : "motion"); } };
	const trackerArgs = { host: "stub", video: "v", obsPath: "o", masksPath: "m", initMotionPath: "i", cameraPath: "c", scenePath: "s", rigPath: "r", transport };
	await runTracker({ ...trackerArgs, outDir: join(root, "rt-ablate"), ablate: "kp-only" });
	await runTracker({ ...trackerArgs, outDir: join(root, "rt-default") });
	assert.deepEqual(boxCalls[0].args.slice(-2), ["--track-ablate", "kp-only"]);
	assert.equal(boxCalls[1].args.includes("--track-ablate"), false);
	for (const call of boxCalls) assert.deepEqual(call.upload.map((item) => item.remoteRelPath), [...trackerInputNames]);
	await assert.rejects(runTracker({ ...trackerArgs, outDir: join(root, "rt-bad"), ablate: "everything" }), /ablate must be one of/);

	const falStep = join(root, "fal-t1"); mkdirSync(falStep, { recursive: true });
	let falCaptured, falMaskArgs;
	const falInputs = { ...common.inputs, video: join(root, "normalised-video.mp4"), rawVideo: join(root, "approved-raw-video.mp4") };
	const falResult = await runT1({
		...common, item: { set: "fal", name: "stepup-shaded-01" }, itemDir: root, stepDir: falStep,
		inputs: falInputs, endpoints: [endpoint, endpoint],
		masksRunner: async (args) => { falMaskArgs = args; return { path: masks }; },
		trackerRunner: async (args) => {
			falCaptured = args; mkdirSync(args.outDir, { recursive: true });
			writeFileSync(join(args.outDir, "motion.npz"), "fal-tracked");
			writeFileSync(join(args.outDir, "diagnostics.json"), "{}");
			return { motionPath: join(args.outDir, "motion.npz"), diagnosticsPath: join(args.outDir, "diagnostics.json"), diagnostics: { runtime: { trackerSeconds: 1, peakReservedMiB: 2 }, lrState: ["identity"], occluded: [[false]] } };
		},
	});
	assert.equal(falResult.fallback, null);
	assert.equal(falMaskArgs.video, falInputs.rawVideo, "Fal masks use the approved raw video");
	assert.equal(falCaptured.video, falInputs.rawVideo, "Fal tracker uses the same raw video as obs/masks");
} finally {
	rmSync(root, { recursive: true, force: true });
}
console.log("PASS verify-obs-bench-t1: parsing, user-known tracker inputs, --track-ablate pass-through, Gbest/G5 fallback bookkeeping with failed-fit diagnostics");
