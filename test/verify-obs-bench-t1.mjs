#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, runT1, OBS_BENCH_STEPS } from "../tools/bench/obs-bench.mjs";

assert.ok(OBS_BENCH_STEPS.includes("T1"));
assert.deepEqual(parseArgs(["--approved", "approved.json", "--out", "out"]).steps, OBS_BENCH_STEPS);
assert.deepEqual(parseArgs(["--approved", "approved.json", "--out", "out", "--steps", "G5,T1"]).steps, ["G5", "T1"]);
assert.throws(() => parseArgs(["--approved", "approved.json", "--out", "out", "--steps", "T2"]), /unknown steps/);

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
console.log("PASS verify-obs-bench-t1: parsing, user-known tracker inputs, Gbest/G5 fallback bookkeeping");
