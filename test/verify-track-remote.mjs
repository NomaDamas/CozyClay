import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeNpz } from "../tools/ardy/npz.mjs";
import { parseProgressLine, runTracker, trackerInputNames, trackerUploadPlan, validateDiagnostics } from "../tools/track/remote.mjs";
import { fallbackStep } from "../tools/track/fallback.mjs";
import { trackerBudgetMs } from "../tools/track/budget.mjs";

assert.deepEqual(parseProgressLine("[track] stage fit 2/3"), { kind: "stage", stage: "fit", current: 2, total: 3, fraction: 2 / 3 });
assert.deepEqual(parseProgressLine("[track] 12 / 40"), { kind: "frame", current: 12, total: 40, fraction: 0.3 });
assert.equal(parseProgressLine("ordinary output"), null);
assert.deepEqual(trackerInputNames, ["video", "obs", "masks", "init", "camera", "scene", "rig"]);
assert.deepEqual(Object.keys(trackerUploadPlan({ video: "v", obsPath: "o", masksPath: "m", initMotionPath: "i", cameraPath: "c", scenePath: "s", rigPath: "r" })), trackerInputNames);
assert.equal(fallbackStep([{}]), "G5");
assert.equal(fallbackStep([{}, {}]), "Gbest");
assert.equal(fallbackStep({ a: {}, b: {} }), "Gbest");
assert.equal(trackerBudgetMs(124), 306000);
assert.equal(trackerBudgetMs(362), 663000);

const valid = {
	version: 1, frames: 1, fps: 24,
	occluded: [Array(27).fill(false)], lrState: ["identity"], lrMargin: [1], ambiguous: [false],
	stance: { left: [false], right: [false] }, penetration: { maxBoxCm: 0, maxFloorCm: 0, frames: [] },
	nuisance: { scale: 1, cameraDeltaDeg: [0, 0], fovDeltaPct: 0 }, stageLosses: { total: 0 },
	runtime: { trackerSeconds: 0, peakReservedMiB: 0 }, failure: null,
};
assert.equal(validateDiagnostics(valid), valid);
assert.throws(() => validateDiagnostics({ ...valid, occluded: undefined }), /occluded/);
assert.throws(() => validateDiagnostics({ ...valid, occluded: [[]] }), /occluded\[0\].*27/);

// Exercise the real runTracker upload/fetch boundary with a deterministic transport.
const root = mkdtempSync(join(tmpdir(), "track-remote-"));
try {
	const paths = Object.fromEntries(trackerInputNames.map(name => [name, join(root, `${name}.input`)]));
	for (const path of Object.values(paths)) writeFileSync(path, "input");
	writeNpz(paths.obs, { kp2d: { data: new Float32Array(17 * 3), shape: [1, 17, 3] } });
	const uploaded = [], commands = [];
	const fakeDiagnostics = { ...valid };
	const transport = {
		runBox: async options => {
			commands.push({ entry: options.entry, args: options.args });
			for (const item of options.upload) uploaded.push({ source: item.localPath, remote: item.remoteRelPath });
			const motionFetch = options.fetch.find(item => item.remoteRelPath === "motion.npz");
			const diagnosticsFetch = options.fetch.find(item => item.remoteRelPath === "diagnostics.json");
			writeNpz(motionFetch.localPath, { posed_joints: { data: new Float32Array(81), shape: [1, 27, 3] }, local_rot_mats: { data: Float32Array.from({ length: 243 }, (_, i) => i % 10 === 0 ? 1 : 0), shape: [1, 27, 3, 3] }, fps: { data: Int32Array.of(24), shape: [] } });
			writeFileSync(diagnosticsFetch.localPath, JSON.stringify(fakeDiagnostics));
			options.onLine?.("[track] stage fit 1/1");
			return { output: "[track] stage fit 1/1", fetched: options.fetch.map(item => item.localPath) };
		},
	};
	const result = await runTracker({ host: "fake-host", video: paths.video, obsPath: paths.obs, masksPath: paths.masks, initMotionPath: paths.init, cameraPath: paths.camera, scenePath: paths.scene, rigPath: paths.rig, outDir: join(root, "out"), transport });
	assert.equal(uploaded.length, 7);
	assert.deepEqual(uploaded.map(item => item.remote).sort(), [...trackerInputNames].sort());
	assert.deepEqual(uploaded.map(item => item.source).sort(), Object.values(paths).sort());
	assert.equal(commands[0].entry, "track.py");
	assert.ok(commands[0].args.includes("--video") && commands[0].args.includes("video"));
	assert.ok(commands[0].args.every(arg => !/--keypoints|--palette|--hybrid/.test(arg)));
	assert.ok(result.progress.some(progress => progress.stage === "fit"));
	assert.deepEqual(JSON.parse(readFileSync(result.diagnosticsPath, "utf8")), fakeDiagnostics);

	// A failed track.py (exit 3) leaves diagnostics only; they ride on the original error.
	const failedRun = (diagnosticsText) => ({
		runBox: async options => {
			const diagnosticsFetch = options.fetch.find(item => item.remoteRelPath === "diagnostics.json");
			if (diagnosticsText !== undefined) writeFileSync(diagnosticsFetch.localPath, diagnosticsText);
			throw Object.assign(new Error("ssh exited 3: [track] keypoint-residual"), { fetched: diagnosticsText === undefined ? [] : [diagnosticsFetch.localPath] });
		},
	});
	const trackerArgs = { host: "fake-host", video: paths.video, obsPath: paths.obs, masksPath: paths.masks, initMotionPath: paths.init, cameraPath: paths.camera, scenePath: paths.scene, rigPath: paths.rig };
	const rejected = { ...valid, failure: "keypoint-residual" };
	const failure = await runTracker({ ...trackerArgs, outDir: join(root, "failed"), transport: failedRun(JSON.stringify(rejected)) }).then(() => null, error => error);
	assert.match(failure.message, /^ssh exited 3/);
	assert.equal(failure.diagnostics.failure, "keypoint-residual");
	assert.equal(failure.diagnosticsPath, join(root, "failed", "diagnostics.json"));
	assert.deepEqual(JSON.parse(readFileSync(failure.diagnosticsPath, "utf8")), rejected);
	const malformed = await runTracker({ ...trackerArgs, outDir: join(root, "malformed"), transport: failedRun("{\"version\":1}") }).then(() => null, error => error);
	assert.match(malformed.message, /^ssh exited 3/, "invalid diagnostics never mask the tracker error");
	assert.equal(malformed.diagnostics, undefined);
	assert.match(malformed.diagnosticsError, /diagnostics: missing/);
	const absent = await runTracker({ ...trackerArgs, outDir: join(root, "absent"), transport: failedRun(undefined) }).then(() => null, error => error);
	assert.match(absent.message, /^ssh exited 3/);
	assert.equal(absent.diagnostics, undefined);
	assert.equal(absent.diagnosticsError, undefined);
} finally { rmSync(root, { recursive: true, force: true }); }

// The CI registry must contain these Node tests, but must not register box/python execution.
const registry = readFileSync(join(process.cwd(), "tools/run-tests.mjs"), "utf8");
assert.match(registry, /test\/verify-track-gate\.mjs/);
assert.match(registry, /test\/verify-track-remote\.mjs/);
assert.doesNotMatch(registry, /run-box-tests\.mjs|pytest\s/);
console.log("verify-track-remote: boundary uploads, progress parser, fallback, budget, schema, failed-run diagnostics and registry checks passed");
