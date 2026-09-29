import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeNpz } from "../tools/ardy/npz.mjs";
import { CSKEL27_JOINTS } from "../src/ardy/cskel27.js";
import { runGate } from "../tools/track/gate.mjs";

function diagnostics(frames = 3, flags = null) {
	return {
		version: 1, frames, fps: 24, occluded: flags ?? Array.from({ length: frames }, () => Array(27).fill(false)),
		lrState: Array(frames).fill("identity"), lrMargin: Array(frames).fill(1), ambiguous: Array(frames).fill(false),
		stance: { left: Array(frames).fill(false), right: Array(frames).fill(false) },
		penetration: { maxBoxCm: 0, maxFloorCm: 0, frames: [] }, nuisance: { scale: 1, cameraDeltaDeg: [0, 0], fovDeltaPct: 0 },
		stageLosses: { total: 0 }, runtime: { trackerSeconds: 1, peakReservedMiB: 100 }, failure: null,
	};
}
function motion(path, delta = 0, frames = 3, { slide = 0, turnDeg = 0 } = {}) {
	const posed = new Float32Array(frames * 27 * 3), rot = new Float32Array(frames * 27 * 9);
	const feet = ["RightFoot", "RightToeBase", "LeftFoot", "LeftToeBase"].map(name => CSKEL27_JOINTS.indexOf(name));
	for (let t = 0; t < frames; t += 1) for (let j = 0; j < 27; j += 1) {
		posed[(t * 27 + j) * 3] = delta + (feet.includes(j) ? slide * t : 0);
		const offset = (t * 27 + j) * 9;
		rot[offset] = rot[offset + 4] = rot[offset + 8] = 1;
		if (j === 0 && t === frames - 1 && turnDeg) {
			const angle = turnDeg * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
			rot[offset] = c; rot[offset + 2] = s; rot[offset + 6] = -s; rot[offset + 8] = c;
		}
	}
	writeNpz(path, { local_rot_mats: { data: rot, shape: [frames, 27, 3, 3] }, posed_joints: { data: posed, shape: [frames, 27, 3] }, fps: { data: Int32Array.of(24), shape: [] } });
}
function existsFile(path) { try { return statSync(path).isFile(); } catch { return false; } }
function row(result, name) { return result.rows.find(value => value.name === name); }
function score(overrides = {}) {
	return { pose: { paMpjpeM: 0.01 }, trajectory: { rootErrorRawM: { rmse: 0.01 }, ateAlignedM: { rmse: 0.01 } }, overlap: { maskIoURawMean: 0.9 }, ...overrides };
}
function writeStep(root, { set = "gt", name = "walk", step = "T1", scoreValue = score(), delta = 0, slide = 0, turnDeg = 0, result = {}, diag = diagnostics(), writeDiagnostics = true, writeTruth = true, frames = 3 } = {}) {
	const itemDir = join(root, set, name), dir = join(itemDir, step);
	mkdirSync(join(dir, "score"), { recursive: true });
	const video = join(root, `${set}-${name}.mp4`); if (!existsFile(video)) writeFileSync(video, "fixture-video");
	const truth = join(root, `${set}-${name}-truth-${frames}.npz`); if (writeTruth) motion(truth, 0, frames);
	motion(join(dir, "motion.npz"), delta, frames, { slide, turnDeg });
	writeFileSync(join(dir, "score", "score.json"), JSON.stringify(scoreValue));
	if (writeDiagnostics) writeFileSync(join(dir, "diagnostics.json"), JSON.stringify(diag));
	const variant = set.endsWith("-skin") ? "skin" : "shaded";
	const detector = variant === "skin" ? "yolo" : "palette";
	const sha = createHash("sha256").update("fixture-video").digest("hex");
	writeFileSync(join(dir, "result.json"), JSON.stringify({ ok: true, step, fallback: null, item: { set, name, variant, source: truth }, inputs: { video, obs: { manifest: { detector, videoSha256: sha } } }, ...result }));
}
function writeCeiling(root, perSet = { gt: 0.81 }) {
	const ceiling = { iouCeiling: { perSet: Object.fromEntries(Object.entries(perSet).map(([set, is1Threshold]) => [set, { is1Threshold }])) } };
	const path = join(root, "ceiling.json"); writeFileSync(path, JSON.stringify(ceiling)); return path;
}
function writeMeanCeiling(root, perSet = { gt: 1 }) {
	const ceiling = { iouCeiling: { perSet: Object.fromEntries(Object.entries(perSet).map(([set, meanIoURaw]) => [set, { meanIoURaw }])) } };
	const path = join(root, "ceiling-mean.json"); writeFileSync(path, JSON.stringify(ceiling)); return path;
}
function makePair(root, options = {}) {
	writeStep(join(root, "run"), { ...options, step: "T1" });
	writeStep(join(root, "baseline"), { ...options, step: "Gbest", result: {}, writeDiagnostics: false, delta: options.baselineDelta ?? 0 });
}

const root = mkdtempSync(join(tmpdir(), "track-gate-"));
try {
	const run = join(root, "run"), baseline = join(root, "baseline");
	makePair(root);
	const ceilingPath = writeCeiling(root);
	let result = runGate({ run, baseline, ceiling: ceilingPath });
	assert.ok(result.rows.every(check => check.pass), result.rows.filter(check => !check.pass).map(check => `${check.name}: ${check.detail}`).join("\n"));

	// Numeric thresholds are pinned independently: matching Gbest avoids the per-item comparison masking the limit.
	for (const [name, options] of [
		["pose.paMpjpeM", { scoreValue: score({ pose: { paMpjpeM: 0.06 } }) }],
		["trajectory.rootErrorRawM", { scoreValue: score({ trajectory: { rootErrorRawM: { rmse: 0.2 }, ateAlignedM: { rmse: 0.01 } } }) }],
		["trajectory.ateAlignedM", { scoreValue: score({ trajectory: { rootErrorRawM: { rmse: 0.01 }, ateAlignedM: { rmse: 0.2 } } }) }],
	]) {
		rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
		makePair(root, options); result = runGate({ run, baseline, ceiling: ceilingPath }); assert.equal(row(result, name).pass, false, `${name} relaxed threshold would pass`);
	}

	// PA's 50 mm limit is the mean per appearance set; only the Gbest +5 mm rule is per item.
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	const mixedPa = [0.06, 0.04, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05];
	mixedPa.forEach((pa, index) => {
		const name = `mixed-${index}`;
		writeStep(run, { name, scoreValue: score({ pose: { paMpjpeM: pa } }) });
		writeStep(baseline, { name, step: "Gbest", scoreValue: score({ pose: { paMpjpeM: pa } }), writeDiagnostics: false });
	});
	result = runGate({ run, baseline, ceiling: ceilingPath }); assert.equal(row(result, "pose.paMpjpeM").pass, true);
	// Isolate the per-item Gbest +5 mm comparator while the appearance-set mean remains below 50 mm.
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { scoreValue: score({ pose: { paMpjpeM: 0.02 } }) });
	writeStep(baseline, { step: "Gbest", scoreValue: score({ pose: { paMpjpeM: 0.01 } }), writeDiagnostics: false });
	result = runGate({ run, baseline, ceiling: ceilingPath }); assert.equal(row(result, "pose.paMpjpeM").pass, false);

	// Penetration, floor, stance, pelvis, runtime and reserved-memory limits are pinned too.
	for (const [name, options] of [
		["penetration.maxBoxCm", { diag: { ...diagnostics(), penetration: { maxBoxCm: 1.01, maxFloorCm: 0, frames: [0] } } }],
		["penetration.maxFloorCm", { diag: { ...diagnostics(), penetration: { maxBoxCm: 0, maxFloorCm: 1.01, frames: [0] } } }],
		["truthStanceSlideCmPerS", { slide: 0.01 }],
		["pelvisSteps>20", { turnDeg: 25 }],
		["runtime.trackerSeconds", { diag: { ...diagnostics(), runtime: { trackerSeconds: 180.1, peakReservedMiB: 100 } } }],
		["runtime.peakReservedMiB", { diag: { ...diagnostics(), runtime: { trackerSeconds: 1, peakReservedMiB: 5633 } } }],
	]) {
		rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
		makePair(root, options); result = runGate({ run, baseline, ceiling: ceilingPath }); assert.equal(row(result, name).pass, false, `${name} relaxed threshold would pass`);
	}
	// Isolate the mean-vs-Gbest stance comparison below the 2.5 cm/s cap.
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { slide: 0.001 }); writeStep(baseline, { step: "Gbest", writeDiagnostics: false });
	result = runGate({ run, baseline, ceiling: ceilingPath }); assert.equal(row(result, "truthStanceSlideCmPerS").pass, false);
	// Isolate the 362-frame runtime limit from the 124-frame limit.
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	makePair(root, { frames: 362, diag: { ...diagnostics(362), runtime: { trackerSeconds: 540.1, peakReservedMiB: 100 } } });
	result = runGate({ run, baseline, ceiling: ceilingPath }); assert.equal(row(result, "runtime.trackerSeconds").pass, false);

	// Truth ceiling is per appearance/set, not the Fal floor.
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	makePair(root, { scoreValue: score({ overlap: { maskIoURawMean: 0.5 } }) });
	result = runGate({ run, baseline, ceiling: writeMeanCeiling(root, { gt: 1 }) }); assert.equal(row(result, "overlap.maskIoURawMean").pass, false);

	// Grey truth is a first-class truth set and uses yolo provenance plus its own ceiling.
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	makePair(root, { set: "gt-skin" }); result = runGate({ run, baseline, ceiling: writeCeiling(root, { "gt-skin": 0.81 }) });
	assert.ok(result.rows.every(check => check.pass), result.rows.filter(check => !check.pass).map(check => check.detail).join("\n"));

	// Fal uses a mean 0.40 threshold and a matched per-item Gbest regression check.
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { set: "fal", name: "a", scoreValue: score({ overlap: { maskIoURawMean: 0.3 } }) });
	writeStep(run, { set: "fal", name: "b", scoreValue: score({ overlap: { maskIoURawMean: 0.5 } }) });
	writeStep(baseline, { set: "fal", name: "a", step: "Gbest", scoreValue: score({ overlap: { maskIoURawMean: 0.3 } }), writeDiagnostics: false });
	writeStep(baseline, { set: "fal", name: "b", step: "Gbest", scoreValue: score({ overlap: { maskIoURawMean: 0.5 } }), writeDiagnostics: false });
	result = runGate({ run, baseline, ceiling: ceilingPath }); assert.equal(row(result, "fal.overlapIoU").pass, true);
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { set: "fal", name: "a", scoreValue: score({ overlap: { maskIoURawMean: 0.37 } }) });
	writeStep(run, { set: "fal", name: "b", scoreValue: score({ overlap: { maskIoURawMean: 0.5 } }) });
	writeStep(baseline, { set: "fal", name: "a", step: "Gbest", scoreValue: score({ overlap: { maskIoURawMean: 0.4 } }), writeDiagnostics: false });
	writeStep(baseline, { set: "fal", name: "b", step: "Gbest", scoreValue: score({ overlap: { maskIoURawMean: 0.5 } }), writeDiagnostics: false });
	result = runGate({ run, baseline, ceiling: ceilingPath }); assert.equal(row(result, "fal.overlapIoU").pass, false);
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { set: "fal", name: "a", scoreValue: score({ overlap: { maskIoURawMean: 0.39 } }) });
	writeStep(run, { set: "fal", name: "b", scoreValue: score({ overlap: { maskIoURawMean: 0.39 } }) });
	writeStep(baseline, { set: "fal", name: "a", step: "Gbest", scoreValue: score({ overlap: { maskIoURawMean: 0.39 } }), writeDiagnostics: false });
	writeStep(baseline, { set: "fal", name: "b", step: "Gbest", scoreValue: score({ overlap: { maskIoURawMean: 0.39 } }), writeDiagnostics: false });
	result = runGate({ run, baseline, ceiling: ceilingPath }); assert.equal(row(result, "fal.overlapIoU").pass, false);
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { set: "gt", name: "walk" }); writeStep(baseline, { set: "gt", name: "walk", step: "Gbest", writeDiagnostics: false });
	writeStep(run, { set: "fal", name: "without-truth", writeTruth: false });
	writeStep(baseline, { set: "fal", name: "without-truth", step: "Gbest", writeTruth: false, writeDiagnostics: false });
	result = runGate({ run, baseline, ceiling: ceilingPath }); assert.equal(row(result, "pelvisSteps>20").pass, true);

	// Missing score fields, failed T1, fallback T1, malformed diagnostics and detector omission all fail closed.
	for (const mutation of [
		{ name: "missing score", options: { scoreValue: { pose: {}, trajectory: {}, overlap: {} } }, check: "pose.paMpjpeM" },
		{ name: "failed T1", options: { result: { ok: false }, writeDiagnostics: false }, check: "pose.paMpjpeM" },
		{ name: "fallback T1", options: { result: { fallback: "Gbest" } }, check: "pose.paMpjpeM" },
		{ name: "malformed diagnostics", options: { diag: { version: 1 }, }, check: "pose.paMpjpeM" },
		{ name: "diagnostics failure", options: { diag: { ...diagnostics(), failure: "no-evidence" } }, check: "pose.paMpjpeM" },
		{ name: "missing detector", options: { result: { inputs: { obs: { manifest: { videoSha256: createHash("sha256").update("fixture-video").digest("hex") } } } } }, check: "obsProvenance" },
	]) {
		rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
		makePair(root, mutation.options); result = runGate({ run, baseline, ceiling: ceilingPath }); assert.equal(row(result, mutation.check).pass, false, mutation.name);
	}
	// A hashless manifest cannot be repaired by hashing the current video path after it changes.
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	makePair(root);
	const staleResultPath = join(run, "gt", "walk", "T1", "result.json");
	const staleResult = JSON.parse(readFileSync(staleResultPath, "utf8"));
	delete staleResult.inputs.obs.manifest.videoSha256;
	staleResult.inputs.obs.manifest.video = staleResult.inputs.video;
	writeFileSync(staleResultPath, JSON.stringify(staleResult));
	writeFileSync(staleResult.inputs.video, "changed-after-extraction");
	result = runGate({ run, baseline, ceiling: ceilingPath }); assert.equal(row(result, "obsProvenance").pass, false);

	// Hidden comparison is T1 flags against same-run G5, never Gbest or G5's flags.
	const flags = Array.from({ length: 3 }, () => Array(27).fill(false)); flags.forEach(rowValue => { rowValue[0] = true; });
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { set: "cube", name: "bump", delta: 0.05, diag: diagnostics(3, flags), result: { truthVisibility: Array.from({ length: 3 }, () => [false, ...Array(26).fill(true)]) } });
	writeStep(run, { set: "cube", name: "bump", step: "G5", delta: 0.1, writeDiagnostics: false });
	writeStep(baseline, { set: "cube", name: "bump", step: "Gbest", delta: 0.3, writeDiagnostics: false });
	result = runGate({ run, baseline, ceiling: writeCeiling(root, { cube: 0.81 }) }); assert.equal(row(result, "hiddenJointErrorT1<=G5").pass, true);
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { set: "cube", name: "bump", delta: 0.2, diag: diagnostics(3, flags), result: { truthVisibility: Array.from({ length: 3 }, () => [false, ...Array(26).fill(true)]) } });
	writeStep(run, { set: "cube", name: "bump", step: "G5", delta: 0.1, writeDiagnostics: false });
	writeStep(baseline, { set: "cube", name: "bump", step: "Gbest", delta: 0.3, writeDiagnostics: false });
	result = runGate({ run, baseline, ceiling: writeCeiling(root, { cube: 0.81 }) });
	assert.equal(row(result, "occlusionAgreement").pass, true); assert.equal(row(result, "hiddenJointErrorT1<=G5").pass, false);
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { set: "cube", name: "bump", diag: diagnostics(3, flags) });
	writeStep(run, { set: "cube", name: "bump", step: "G5", writeDiagnostics: false });
	writeStep(baseline, { set: "cube", name: "bump", step: "Gbest", writeDiagnostics: false });
	result = runGate({ run, baseline, ceiling: writeCeiling(root, { cube: 0.81 }) }); assert.equal(row(result, "occlusionAgreement").pass, false);
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	const weakFlags = Array.from({ length: 3 }, () => Array(27).fill(false)); weakFlags.forEach(rowValue => { rowValue[0] = rowValue[1] = rowValue[2] = true; });
	writeStep(run, { set: "cube", name: "bump", diag: diagnostics(3, weakFlags), result: { truthVisibility: Array.from({ length: 3 }, () => Array(27).fill(false)) } });
	writeStep(run, { set: "cube", name: "bump", step: "G5", writeDiagnostics: false });
	writeStep(baseline, { set: "cube", name: "bump", step: "Gbest", writeDiagnostics: false });
	result = runGate({ run, baseline, ceiling: writeCeiling(root, { cube: 0.81 }) }); assert.equal(row(result, "occlusionAgreement").pass, false);

	console.log("verify-track-gate: all-pass control, pinned thresholds, per-set ceiling/skin, Fal mean, fail-closed T1/provenance, and T1-flags-vs-G5 hidden gate passed");
} finally { rmSync(root, { recursive: true, force: true }); }
