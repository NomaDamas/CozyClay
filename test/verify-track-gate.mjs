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
// Joints stand in a vertical line (y = 0.05 * index) so a thin box can hide joint 0 alone.
function motion(path, delta = 0, frames = 3, { slide = 0, turnDeg = 0, fps = 24 } = {}) {
	const posed = new Float32Array(frames * 27 * 3), rot = new Float32Array(frames * 27 * 9);
	const feet = ["RightFoot", "RightToeBase", "LeftFoot", "LeftToeBase"].map(name => CSKEL27_JOINTS.indexOf(name));
	for (let t = 0; t < frames; t += 1) for (let j = 0; j < 27; j += 1) {
		posed[(t * 27 + j) * 3] = delta + (feet.includes(j) ? slide * t : 0);
		posed[(t * 27 + j) * 3 + 1] = 0.05 * j;
		const offset = (t * 27 + j) * 9;
		rot[offset] = rot[offset + 4] = rot[offset + 8] = 1;
		if (j === 0 && t === frames - 1 && turnDeg) {
			const angle = turnDeg * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
			rot[offset] = c; rot[offset + 2] = s; rot[offset + 6] = -s; rot[offset + 8] = c;
		}
	}
	writeNpz(path, { local_rot_mats: { data: rot, shape: [frames, 27, 3, 3] }, posed_joints: { data: posed, shape: [frames, 27, 3] }, fps: { data: Int32Array.of(fps), shape: [] } });
}
/**
 * Overwrite the first float32 of an NPZ member with NaN in place. writeNpz refuses non-finite
 * values, but files produced elsewhere (numpy) can hold them; readNpz reads stored members
 * without a CRC check, so this reaches the gate exactly as such a file would.
 */
function poisonNpz(path, member) {
	const bytes = readFileSync(path);
	const name = bytes.indexOf(Buffer.from(`${member}.npy`));
	const magic = bytes.indexOf(Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]), name);
	assert.ok(name >= 0 && magic > name, `${path}: no ${member}.npy`);
	bytes.writeFloatLE(Number.NaN, magic + 10 + bytes.readUInt16LE(magic + 8));
	writeFileSync(path, bytes);
}
function existsFile(path) { try { return statSync(path).isFile(); } catch { return false; } }
function row(result, name) { return result.rows.find(value => value.name === name); }
function score(overrides = {}) {
	return { pose: { paMpjpeM: 0.01 }, trajectory: { rootErrorRawM: { rmse: 0.01 }, ateAlignedM: { rmse: 0.01 } }, overlap: { maskIoURawMean: 0.9 }, ...overrides };
}
/** obs-bench scoreFal's score.json fields (real shape: evidence/obs/run-t1-gate2-r0/fal/<name>/T1/score/score.json). */
function falScore(iou, overrides = {}) {
	return { clip: "fixture", noMotionGroundTruth: true, endpointFirstM: 0.1, endpointLastM: 0.12, minDistanceM: 0, maxPenetrationM: 0, overlapIoU: iou, comparedFrames: 3, ...overrides };
}
// Camera centre (0, 0, 5); a thin box at z = 2.5 hides only joint 0 (y = 0) of the fixture skeleton.
const HIDE_JOINT0_CAMERA = { worldToCamera: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, -5], [0, 0, 0, 1]], K: [[500, 0, 100], [0, 500, 100], [0, 0, 1]] };
const HIDE_JOINT0_SCENE = { centre: [0, 0, 2.5], halfExtents: [1, 0.02, 0.1], yawDeg: 0 };
function writeStep(root, { set = "gt", name = "walk", step = "T1", scoreValue = set === "fal" ? falScore(0.5) : score(), delta = 0, slide = 0, turnDeg = 0, result = {}, diag = diagnostics(), writeDiagnostics = true, writeTruth = true, frames = 3, withScene = set.startsWith("cube") } = {}) {
	const itemDir = join(root, set, name), dir = join(itemDir, step);
	mkdirSync(join(dir, "score"), { recursive: true });
	const video = join(root, `${set}-${name}.mp4`); if (!existsFile(video)) writeFileSync(video, "fixture-video");
	// Cube truth is 30 fps like evidence/exp3/gt-motions (the gate resamples it to the 24 fps prediction).
	const truthFps = set.startsWith("cube") ? 30 : 24, truthFrames = Math.ceil((frames - 1) * truthFps / 24) + 1;
	const truth = join(root, `${set}-${name}-truth-${frames}.npz`); if (writeTruth) motion(truth, 0, truthFrames, { fps: truthFps });
	const camera = join(root, `${set}-${name}-camera.json`), scene = join(root, `${set}-${name}-scene.json`);
	writeFileSync(camera, JSON.stringify(HIDE_JOINT0_CAMERA)); writeFileSync(scene, JSON.stringify(HIDE_JOINT0_SCENE));
	motion(join(dir, "motion.npz"), delta, frames, { slide, turnDeg });
	writeFileSync(join(dir, "score", "score.json"), JSON.stringify(scoreValue));
	if (writeDiagnostics) writeFileSync(join(dir, "diagnostics.json"), JSON.stringify(diag));
	const variant = set.endsWith("-skin") ? "skin" : "shaded";
	const detector = variant === "skin" ? "yolo" : "palette";
	const sha = createHash("sha256").update("fixture-video").digest("hex");
	const item = { set, name, variant, source: truth, ...(withScene ? { scene } : {}) };
	writeFileSync(join(dir, "result.json"), JSON.stringify({ ok: true, step, fallback: null, item, inputs: { camera: { path: camera }, video, obs: { manifest: { detector, videoSha256: sha } } }, ...result }));
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
	// Every obs-bench run holds its own Gbest step (the stance comparison uses it).
	writeStep(join(root, "run"), { ...options, step: "Gbest", result: {}, writeDiagnostics: false, delta: options.baselineDelta ?? 0 });
}

const root = mkdtempSync(join(tmpdir(), "track-gate-"));
try {
	const run = join(root, "run"), baseline = join(root, "baseline");
	makePair(root);
	const ceilingPath = writeCeiling(root);
	let result = runGate({ run, ceiling: ceilingPath });
	assert.ok(result.rows.every(check => check.pass), result.rows.filter(check => !check.pass).map(check => `${check.name}: ${check.detail}`).join("\n"));

	// Numeric thresholds are pinned independently: matching Gbest avoids the per-item comparison masking the limit.
	for (const [name, options] of [
		["pose.paMpjpeM", { scoreValue: score({ pose: { paMpjpeM: 0.06 } }) }],
		["trajectory.rootErrorRawM", { scoreValue: score({ trajectory: { rootErrorRawM: { rmse: 0.2 }, ateAlignedM: { rmse: 0.01 } } }) }],
		["trajectory.ateAlignedM", { scoreValue: score({ trajectory: { rootErrorRawM: { rmse: 0.01 }, ateAlignedM: { rmse: 0.2 } } }) }],
	]) {
		rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
		makePair(root, options); result = runGate({ run, ceiling: ceilingPath }); assert.equal(row(result, name).pass, false, `${name} relaxed threshold would pass`);
	}

	// PA's 50 mm limit is the mean per appearance set; only the Gbest +5 mm rule is per item.
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	const mixedPa = [0.06, 0.04, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05];
	mixedPa.forEach((pa, index) => {
		const name = `mixed-${index}`;
		writeStep(run, { name, scoreValue: score({ pose: { paMpjpeM: pa } }) });
		writeStep(run, { name, step: "Gbest", scoreValue: score({ pose: { paMpjpeM: pa } }), writeDiagnostics: false });
	});
	result = runGate({ run, ceiling: ceilingPath }); assert.equal(row(result, "pose.paMpjpeM").pass, true);
	// Isolate the per-item Gbest +5 mm comparator while the appearance-set mean remains below 50 mm.
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { scoreValue: score({ pose: { paMpjpeM: 0.02 } }) });
	writeStep(run, { step: "Gbest", scoreValue: score({ pose: { paMpjpeM: 0.01 } }), writeDiagnostics: false });
	result = runGate({ run, ceiling: ceilingPath }); assert.equal(row(result, "pose.paMpjpeM").pass, false);

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
		makePair(root, options); result = runGate({ run, ceiling: ceilingPath }); assert.equal(row(result, name).pass, false, `${name} relaxed threshold would pass`);
	}
	// Isolate the mean-vs-Gbest stance comparison below the 2.5 cm/s cap.
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { slide: 0.001 }); writeStep(run, { step: "Gbest", writeDiagnostics: false });
	result = runGate({ run, ceiling: ceilingPath }); assert.equal(row(result, "truthStanceSlideCmPerS").pass, false);
	assert.match(row(result, "truthStanceSlideCmPerS").detail, /^2\.4\d* cm\/s <= 2\.5 \[ok\]; <= same-run Gbest mean 0 \[FAIL\]$/);

	// Regression (r1 skin gate printed "Gbest mean NaN"): the stance comparison uses the SAME run's
	// Gbest, even when --baseline (run-492f) has no item of this appearance set.
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { set: "gt-skin", slide: 0.0005 }); writeStep(run, { set: "gt-skin", step: "Gbest", slide: 0.001, writeDiagnostics: false });
	writeStep(baseline, { set: "gt", step: "Gbest", writeDiagnostics: false });
	result = runGate({ run, baseline, ceiling: ceilingPath });
	assert.equal(row(result, "truthStanceSlideCmPerS").pass, true, row(result, "truthStanceSlideCmPerS").detail);
	assert.match(row(result, "truthStanceSlideCmPerS").detail, /^1\.2\d* cm\/s <= 2\.5 \[ok\]; <= same-run Gbest mean 2\.4\d* \[ok\]$/);
	// The --baseline Gbest is not the comparator: a lenient baseline cannot rescue a worse-than-own-Gbest T1.
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { slide: 0.001 }); writeStep(run, { step: "Gbest", writeDiagnostics: false });
	writeStep(baseline, { step: "Gbest", slide: 0.01, writeDiagnostics: false });
	result = runGate({ run, baseline, ceiling: ceilingPath }); assert.equal(row(result, "truthStanceSlideCmPerS").pass, false);
	// No same-run Gbest: explicit reason, explicit FAIL of that sub-check, never NaN.
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { set: "gt-skin" }); writeStep(baseline, { set: "gt-skin", step: "Gbest", writeDiagnostics: false });
	result = runGate({ run, baseline, ceiling: ceilingPath });
	assert.equal(row(result, "truthStanceSlideCmPerS").pass, false);
	assert.equal(row(result, "truthStanceSlideCmPerS").detail, "0 cm/s <= 2.5 [ok]; <= same-run Gbest mean missing (gt-skin/walk: no same-run Gbest/result.json) [FAIL]");
	assert.doesNotMatch(row(result, "truthStanceSlideCmPerS").detail, /NaN/);

	// Regression (per-item Gbest checks): PA +5 mm, fal IoU -0.02 and fal pelvis steps compare to the
	// SAME run's Gbest. A decoy --baseline whose Gbest would pass every item must not rescue them.
	const decoy = () => {
		writeStep(baseline, { name: "walk", step: "Gbest", scoreValue: score({ pose: { paMpjpeM: 0.5 } }), writeDiagnostics: false });
		writeStep(baseline, { set: "fal", name: "a", step: "Gbest", scoreValue: falScore(0), turnDeg: 90, writeDiagnostics: false });
	};
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { scoreValue: score({ pose: { paMpjpeM: 0.02 } }) }); writeStep(run, { step: "Gbest", scoreValue: score({ pose: { paMpjpeM: 0.01 } }), writeDiagnostics: false });
	writeStep(run, { set: "fal", name: "a", scoreValue: falScore(0.45), turnDeg: 25 }); writeStep(run, { set: "fal", name: "a", step: "Gbest", scoreValue: falScore(0.5), writeDiagnostics: false });
	decoy();
	result = runGate({ run, baseline, ceiling: ceilingPath });
	assert.equal(row(result, "pose.paMpjpeM").pass, false);
	assert.match(row(result, "pose.paMpjpeM").detail, /^gt mean 20 mm <= 50 mm per appearance set \[ok\]; each <= same-run Gbest\+5 mm \[FAIL: gt\/walk 20 mm > Gbest 10\+5 mm\]$/);
	assert.equal(row(result, "fal.overlapIoU").pass, false);
	assert.match(row(result, "fal.overlapIoU").detail, /^mean 0\.45 >= 0\.4 \[ok\]; every item >= same-run Gbest-0\.02 \[FAIL: fal\/a IoU 0\.45 < Gbest 0\.5-0\.02\]/);
	assert.equal(row(result, "pelvisSteps>20").pass, false);
	assert.equal(row(result, "pelvisSteps>20").detail, "0 truth frames == 0 [ok]; Fal <= same-run Gbest [FAIL: fal/a 1 frames > Gbest 0]");
	// The same run with its Gbest equal to T1 passes every per-item sub-check, whatever --baseline says.
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { scoreValue: score({ pose: { paMpjpeM: 0.02 } }) }); writeStep(run, { step: "Gbest", scoreValue: score({ pose: { paMpjpeM: 0.02 } }), writeDiagnostics: false });
	writeStep(run, { set: "fal", name: "a", scoreValue: falScore(0.45) }); writeStep(run, { set: "fal", name: "a", step: "Gbest", scoreValue: falScore(0.45), writeDiagnostics: false });
	writeStep(baseline, { name: "walk", step: "Gbest", scoreValue: score({ pose: { paMpjpeM: 0.001 } }), writeDiagnostics: false });
	writeStep(baseline, { set: "fal", name: "a", step: "Gbest", scoreValue: falScore(0.99), writeDiagnostics: false });
	result = runGate({ run, baseline, ceiling: ceilingPath });
	for (const name of ["pose.paMpjpeM", "fal.overlapIoU", "pelvisSteps>20"]) assert.equal(row(result, name).pass, true, `${name}: ${row(result, name).detail}`);
	// Missing same-run Gbest: each per-item sub-check names the reason and fails; nothing reads NaN.
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { set: "gt-skin" }); writeStep(run, { set: "fal", name: "a" });
	writeStep(run, { set: "fal", name: "a", step: "Gbest", scoreValue: { overlap: { maskIoURawMean: 0.5 } }, writeDiagnostics: false });
	rmSync(join(run, "fal", "a", "Gbest", "motion.npz"));
	decoy();
	result = runGate({ run, baseline, ceiling: ceilingPath });
	assert.equal(row(result, "pose.paMpjpeM").detail, "gt-skin mean 10 mm <= 50 mm per appearance set [ok]; each <= same-run Gbest+5 mm [FAIL: gt-skin/walk: no same-run Gbest/result.json]");
	assert.match(row(result, "fal.overlapIoU").detail, /every item >= same-run Gbest-0\.02 \[FAIL: fal\/a: same-run Gbest score\.json has no overlapIoU\] \[fal\/a IoU 0\.5 \(Gbest missing\)/);
	assert.match(row(result, "pelvisSteps>20").detail, /Fal <= same-run Gbest \[FAIL: fal\/a: same-run Gbest motion\.npz missing\]/);
	for (const name of ["pose.paMpjpeM", "fal.overlapIoU", "pelvisSteps>20"]) { assert.equal(row(result, name).pass, false, name); assert.doesNotMatch(row(result, name).detail, /NaN/); }
	// --baseline is optional: the gate runs on the run dir alone.
	assert.deepEqual(runGate({ run, ceiling: ceilingPath }).rows.map(check => check.detail), result.rows.map(check => check.detail));

	// Regression B1 (gate review): only a genuine Gbest result is a comparator. With genuine Gbest the four
	// comparisons fail; a lenient stand-in under Gbest/ that declares a fallback, another step or another
	// item must not turn them green - each is rejected with a named reason.
	const comparisonRows = ["pose.paMpjpeM", "fal.overlapIoU", "truthStanceSlideCmPerS", "pelvisSteps>20"];
	const standIn = (result) => {
		rmSync(run, { recursive: true, force: true });
		writeStep(run, { scoreValue: score({ pose: { paMpjpeM: 0.02 } }), slide: 0.0005 });
		writeStep(run, { set: "fal", name: "a", scoreValue: falScore(0.45), turnDeg: 25 });
		writeStep(run, { step: "Gbest", scoreValue: score({ pose: { paMpjpeM: 0.1 } }), slide: 0.001, result, writeDiagnostics: false });
		writeStep(run, { set: "fal", name: "a", step: "Gbest", scoreValue: falScore(0.4), turnDeg: 90, result, writeDiagnostics: false });
		return runGate({ run, ceiling: ceilingPath });
	};
	result = standIn({});
	for (const name of comparisonRows) assert.equal(row(result, name).pass, true, `control: a lenient genuine Gbest passes ${name}`);
	for (const [label, declared, reason] of [
		["fallback G5", { fallback: "G5" }, /same-run Gbest declares fallback=G5; not a Gbest comparator/],
		["step G5", { step: "G5" }, /same-run Gbest\/result\.json declares step "G5", not "Gbest"/],
		["no step", { step: null }, /declares step null/],
		["other item", { item: { set: "gt", name: "run" } }, /same-run Gbest\/result\.json is for gt\/run/],
	]) {
		result = standIn(declared);
		for (const name of comparisonRows) {
			assert.equal(row(result, name).pass, false, `${label}: ${name} must not pass on a non-Gbest comparator`);
			assert.match(row(result, name).detail, reason, `${label}: ${name} names the reason`);
		}
	}

	// Regression B2 (gate review): a non-finite value in any measured motion fails with a named reason
	// at the NPZ boundary, never as a silently clean count (NaN angles vanished in `> 20` filtering).
	const poisoned = (step, set, name, member = "local_rot_mats") => {
		rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
		makePair(root, {}); makePair(root, { set: "fal", name: "a" });
		poisonNpz(join(run, set, name, step, "motion.npz"), member);
		return runGate({ run, ceiling: ceilingPath });
	};
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	makePair(root, {}); makePair(root, { set: "fal", name: "a" });
	result = runGate({ run, ceiling: ceilingPath });
	assert.ok(result.rows.every(check => check.pass), "control: unpoisoned gt + fal pair passes every row");
	result = poisoned("Gbest", "fal", "a");
	assert.equal(row(result, "pelvisSteps>20").pass, false);
	assert.match(row(result, "pelvisSteps>20").detail, /fal\/a: same-run Gbest motion\.npz non-finite local_rot_mats\[0\] = NaN/);
	result = poisoned("Gbest", "gt", "walk", "posed_joints");
	assert.equal(row(result, "truthStanceSlideCmPerS").pass, false);
	assert.match(row(result, "truthStanceSlideCmPerS").detail, /gt\/walk: same-run Gbest motion\.npz non-finite posed_joints\[0\] = NaN/);
	result = poisoned("T1", "fal", "a");
	assert.equal(row(result, "pelvisSteps>20").pass, false);
	assert.match(row(result, "pelvisSteps>20").detail, /fal\/a\/T1: motion\.npz non-finite local_rot_mats\[0\] = NaN/);
	rmSync(run, { recursive: true, force: true });
	makePair(root, {});
	poisonNpz(JSON.parse(readFileSync(join(run, "gt", "walk", "T1", "result.json"), "utf8")).item.source, "posed_joints");
	result = runGate({ run, ceiling: ceilingPath });
	assert.equal(row(result, "pose.paMpjpeM").pass, false);
	assert.match(row(result, "pose.paMpjpeM").detail, /gt\/walk\/T1: truth motion .* non-finite posed_joints\[0\] = NaN/);
	// Isolate the 362-frame runtime limit from the 124-frame limit.
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	makePair(root, { frames: 362, diag: { ...diagnostics(362), runtime: { trackerSeconds: 540.1, peakReservedMiB: 100 } } });
	result = runGate({ run, ceiling: ceilingPath }); assert.equal(row(result, "runtime.trackerSeconds").pass, false);

	// Truth ceiling is per appearance/set, not the Fal floor.
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	makePair(root, { scoreValue: score({ overlap: { maskIoURawMean: 0.5 } }) });
	result = runGate({ run, ceiling: writeMeanCeiling(root, { gt: 1 }) }); assert.equal(row(result, "overlap.maskIoURawMean").pass, false);

	// Grey truth is a first-class truth set and uses yolo provenance plus its own ceiling.
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	makePair(root, { set: "gt-skin" }); result = runGate({ run, ceiling: writeCeiling(root, { "gt-skin": 0.81 }) });
	assert.ok(result.rows.every(check => check.pass), result.rows.filter(check => !check.pass).map(check => check.detail).join("\n"));

	// Fal uses a mean 0.40 threshold and a matched per-item Gbest regression check.
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { set: "fal", name: "a", scoreValue: falScore(0.3) });
	writeStep(run, { set: "fal", name: "b", scoreValue: falScore(0.5) });
	writeStep(run, { set: "fal", name: "a", step: "Gbest", scoreValue: falScore(0.3), writeDiagnostics: false });
	writeStep(run, { set: "fal", name: "b", step: "Gbest", scoreValue: falScore(0.5), writeDiagnostics: false });
	result = runGate({ run, ceiling: ceilingPath }); assert.equal(row(result, "fal.overlapIoU").pass, true);
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { set: "fal", name: "a", scoreValue: falScore(0.37) });
	writeStep(run, { set: "fal", name: "b", scoreValue: falScore(0.5) });
	writeStep(run, { set: "fal", name: "a", step: "Gbest", scoreValue: falScore(0.4), writeDiagnostics: false });
	writeStep(run, { set: "fal", name: "b", step: "Gbest", scoreValue: falScore(0.5), writeDiagnostics: false });
	result = runGate({ run, ceiling: ceilingPath }); assert.equal(row(result, "fal.overlapIoU").pass, false);
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { set: "fal", name: "a", scoreValue: falScore(0.39) });
	writeStep(run, { set: "fal", name: "b", scoreValue: falScore(0.39) });
	writeStep(run, { set: "fal", name: "a", step: "Gbest", scoreValue: falScore(0.39), writeDiagnostics: false });
	writeStep(run, { set: "fal", name: "b", step: "Gbest", scoreValue: falScore(0.39), writeDiagnostics: false });
	result = runGate({ run, ceiling: ceilingPath }); assert.equal(row(result, "fal.overlapIoU").pass, false);
	// Regression (todo 22b): fal items are read through scoreFal's own fields, never the truth scorer's.
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { set: "fal", name: "a", scoreValue: falScore(0.42, { endpointFirstM: 0.2, endpointLastM: 0.3, maxPenetrationM: 0.004 }) });
	writeStep(run, { set: "fal", name: "a", step: "Gbest", scoreValue: falScore(0.41), writeDiagnostics: false });
	result = runGate({ run, ceiling: ceilingPath });
	assert.equal(result.invalid.length, 0, result.invalid.flatMap(m => m.record.errors).join("; "));
	assert.equal(row(result, "fal.overlapIoU").pass, true);
	assert.match(row(result, "fal.overlapIoU").detail, /^mean 0\.42 >= 0\.4 \[ok\]; every item >= same-run Gbest-0\.02 \[ok\] \[fal\/a IoU 0\.42 \(Gbest 0\.41\) A 0\.2 m B 0\.3 m pen 0\.4 cm\]$/);
	assert.equal(row(result, "penetration.maxBoxCm").pass, true);
	// The scorer's independent penetration counts even when the tracker reports none.
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { set: "fal", name: "a", scoreValue: falScore(0.5, { maxPenetrationM: 0.065 }) });
	writeStep(run, { set: "fal", name: "a", step: "Gbest", scoreValue: falScore(0.5), writeDiagnostics: false });
	result = runGate({ run, ceiling: ceilingPath }); assert.equal(row(result, "penetration.maxBoxCm").pass, false);
	// A fal score.json carrying only the truth scorer's field is incomplete, not IoU 0.
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { set: "fal", name: "a", scoreValue: { overlap: { maskIoURawMean: 0.5 } } });
	writeStep(run, { set: "fal", name: "a", step: "Gbest", scoreValue: falScore(0.5), writeDiagnostics: false });
	result = runGate({ run, ceiling: ceilingPath });
	assert.deepEqual(result.invalid[0].record.errors, ["fal/a/T1: missing score field overlapIoU", "fal/a/T1: missing score field endpointFirstM", "fal/a/T1: missing score field endpointLastM", "fal/a/T1: missing score field maxPenetrationM"]);
	assert.equal(row(result, "fal.overlapIoU").pass, false);
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { set: "gt", name: "walk" }); writeStep(run, { set: "gt", name: "walk", step: "Gbest", writeDiagnostics: false });
	writeStep(run, { set: "fal", name: "without-truth", writeTruth: false });
	writeStep(run, { set: "fal", name: "without-truth", step: "Gbest", writeTruth: false, writeDiagnostics: false });
	result = runGate({ run, ceiling: ceilingPath }); assert.equal(row(result, "pelvisSteps>20").pass, true);

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
		makePair(root, mutation.options); result = runGate({ run, ceiling: ceilingPath }); assert.equal(row(result, mutation.check).pass, false, mutation.name);
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
	result = runGate({ run, ceiling: ceilingPath }); assert.equal(row(result, "obsProvenance").pass, false);

	// Regression (todo 22c): the real layout - T1's obs is a run copy whose manifest names the obs-root
	// original (source/sourceSha256); the gate follows it and accepts a backfilled-path manifest there.
	const sha = value => createHash("sha256").update(value).digest("hex");
	const obsChain = ({ set = "gt", name = "walk", origin = {}, copyBytes = "cache-obs", t1 = {}, itemVideo = null } = {}) => {
		const cacheDir = join(root, "cache", set, name, "g5"), copyDir = join(run, set, name, "obs-mannequin");
		mkdirSync(cacheDir, { recursive: true }); mkdirSync(copyDir, { recursive: true });
		writeFileSync(join(cacheDir, "obs.npz"), "cache-obs"); writeFileSync(join(copyDir, "obs.npz"), copyBytes);
		const resultPath = join(run, set, name, "T1", "result.json"), value = JSON.parse(readFileSync(resultPath, "utf8"));
		const video = itemVideo ?? value.inputs.video;
		writeFileSync(join(cacheDir, "manifest.json"), JSON.stringify({ video, videoSha256: sha(readFileSync(video)), obsSha256: sha("cache-obs"), detector: set === "gt" || set === "fal" ? "palette" : "yolo", provenance: "backfilled-path", backfilledAt: "2026-09-30T00:00:00.000Z", ...origin }));
		const copyManifest = { source: join(cacheDir, "obs.npz"), sourceSha256: sha("cache-obs"), video: value.inputs.video, detector: "palette" };
		writeFileSync(join(copyDir, "manifest.json"), JSON.stringify(copyManifest));
		writeFileSync(resultPath, JSON.stringify({ ...value, ...t1, item: { ...value.item, ...(itemVideo ? { video: itemVideo } : {}) }, inputs: { ...value.inputs, obs: { obs: join(copyDir, "obs.npz"), manifest: copyManifest } } }));
		return cacheDir;
	};
	const provenanceCase = (options, pairOptions = {}) => {
		rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true }); rmSync(join(root, "cache"), { recursive: true, force: true });
		makePair(root, pairOptions);
		const cacheDir = obsChain(options);
		return { cacheDir, check: () => row(runGate({ run, ceiling: ceilingPath }), "obsProvenance") };
	};
	let provenanceRun = provenanceCase({});
	assert.deepEqual(provenanceRun.check(), { name: "obsProvenance", pass: true, detail: "backfilled-path 1 (gt/walk)" });
	// Input provenance does not depend on whether T1 fell back (the T1 rows fail on that separately).
	provenanceRun = provenanceCase({ t1: { fallback: "Gbest" } });
	assert.equal(provenanceRun.check().pass, true);
	assert.equal(row(runGate({ run, ceiling: ceilingPath }), "pose.paMpjpeM").pass, false);
	// The original obs changed after its manifest vouched for it.
	provenanceRun = provenanceCase({});
	writeFileSync(join(provenanceRun.cacheDir, "obs.npz"), "re-extracted");
	assert.match(provenanceRun.check().detail, /^gt\/walk: .*obs-copy-mismatch|changed after its manifest/);
	assert.equal(provenanceRun.check().pass, false);
	// Only recorded|backfilled-path is accepted; masks.mjs's path-only is not a hash.
	assert.match(provenanceCase({ origin: { provenance: "path-only" } }).check().detail, /provenance path-only is not recorded\|backfilled-path/);
	assert.equal(provenanceCase({ origin: { backfilledAt: undefined } }).check().pass, false);
	// The run copy must be the obs its manifest names.
	assert.match(provenanceCase({ copyBytes: "other-obs" }).check().detail, /obs-copy-mismatch/);
	// A recorded skin manifest is reported as recorded.
	assert.deepEqual(provenanceCase({ set: "gt-skin", origin: { provenance: undefined } }, { set: "gt-skin" }).check().detail, "recorded 1 (gt-skin/walk)");
	// Fal: the obs came from the approved clip (item.video), not the run's normalised inputs.video copy.
	const rawClip = join(root, "fal-raw-clip.mp4"); writeFileSync(rawClip, "raw-fal-clip");
	assert.deepEqual(provenanceCase({ set: "fal", name: "a", itemVideo: rawClip }, { set: "fal", name: "a" }).check(), { name: "obsProvenance", pass: true, detail: "backfilled-path 1 (fal/a)" });
	rmSync(join(root, "cache"), { recursive: true, force: true });

	// Regression (todo 22d): truth visibility is computed by the gate from the truth motion (30 fps,
	// resampled to the 24 fps T1), camera.json and scene.json; nothing upstream has to provide it.
	// Hidden comparison is T1 flags against same-run G5, never Gbest or G5's flags.
	const flags = Array.from({ length: 3 }, () => Array(27).fill(false)); flags.forEach(rowValue => { rowValue[0] = true; });
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { set: "cube", name: "bump", delta: 0.05, diag: diagnostics(3, flags) });
	writeStep(run, { set: "cube", name: "bump", step: "G5", delta: 0.1, writeDiagnostics: false });
	writeStep(run, { set: "cube", name: "bump", step: "Gbest", delta: 0.3, writeDiagnostics: false });
	result = runGate({ run, ceiling: writeCeiling(root, { cube: 0.81 }) }); assert.equal(row(result, "hiddenJointErrorT1<=G5").pass, true);
	assert.equal(row(result, "occlusionAgreement").detail, "cube/bump: 1 >= 0.9");
	assert.match(row(result, "hiddenJointErrorT1<=G5").detail, /^cube\/bump: T1 0\.05\d* <= G5 0\.1\d* on T1 flags$/);
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { set: "cube", name: "bump", delta: 0.2, diag: diagnostics(3, flags) });
	writeStep(run, { set: "cube", name: "bump", step: "G5", delta: 0.1, writeDiagnostics: false });
	writeStep(run, { set: "cube", name: "bump", step: "Gbest", delta: 0.3, writeDiagnostics: false });
	result = runGate({ run, ceiling: writeCeiling(root, { cube: 0.81 }) });
	assert.equal(row(result, "occlusionAgreement").pass, true); assert.equal(row(result, "hiddenJointErrorT1<=G5").pass, false);
	// No scene -> no truth visibility: fails closed and says why.
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	writeStep(run, { set: "cube", name: "bump", diag: diagnostics(3, flags), withScene: false });
	writeStep(run, { set: "cube", name: "bump", step: "G5", writeDiagnostics: false });
	writeStep(run, { set: "cube", name: "bump", step: "Gbest", writeDiagnostics: false });
	result = runGate({ run, ceiling: writeCeiling(root, { cube: 0.81 }) }); assert.equal(row(result, "occlusionAgreement").pass, false);
	assert.match(row(result, "occlusionAgreement").detail, /cube\/bump: missing \(no truth visibility/);
	// Over-flagging visible joints (1..5 are in front of the box) drops agreement to 22/27.
	rmSync(run, { recursive: true, force: true }); rmSync(baseline, { recursive: true, force: true });
	const weakFlags = Array.from({ length: 3 }, () => Array(27).fill(false)); weakFlags.forEach(rowValue => { for (let j = 0; j < 6; j += 1) rowValue[j] = true; });
	writeStep(run, { set: "cube", name: "bump", diag: diagnostics(3, weakFlags) });
	writeStep(run, { set: "cube", name: "bump", step: "G5", writeDiagnostics: false });
	writeStep(run, { set: "cube", name: "bump", step: "Gbest", writeDiagnostics: false });
	result = runGate({ run, ceiling: writeCeiling(root, { cube: 0.81 }) }); assert.equal(row(result, "occlusionAgreement").pass, false);
	assert.equal(row(result, "occlusionAgreement").detail, `cube/bump: ${22 / 27} >= 0.9`);

	console.log("verify-track-gate: all-pass control, pinned thresholds, per-set ceiling/skin, Fal mean, fail-closed T1/provenance, and T1-flags-vs-G5 hidden gate passed");
} finally { rmSync(root, { recursive: true, force: true }); }
