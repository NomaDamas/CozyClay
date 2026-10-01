#!/usr/bin/env node
// #500 todo 4: Gate 0 study helpers - box occlusion, L/R swap classifier,
// the 2D clip analysis, the camera-fixedness tile matcher, missing-obs
// reporting, the skin set derivation and publish-obs overwrite refusal.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { motionArraysToNpzMembers, writeNpz } from "../tools/ardy/npz.mjs";
import { STANCE_FEET } from "../tools/track/metrics.mjs";
import { cameraFromJson, worldToPixel } from "../tools/bench/obs/extrinsics.mjs";
import { analyzeClip, bandTiles, classifySwap, frameRuns, normalizeBox, percentile, segmentHitsBox, skinApprovedFrom, studyItem, tileShifts } from "../tools/track/study-2d.mjs";
import { main as publishMain, publish } from "../tools/track/publish-obs.mjs";

const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

// Box occlusion along the camera ray.
{
	const box = { min: [-1, 0, -1], max: [1, 2, 1] }, cam = [0, 1, 10];
	assert.equal(segmentHitsBox(cam, [0, 1, -5], box), true, "behind the box");
	assert.equal(segmentHitsBox(cam, [0, 1, 5], box), false, "in front of the box");
	assert.equal(segmentHitsBox(cam, [5, 1, -5], box), false, "beside the box");
	assert.equal(segmentHitsBox(cam, [0, 1, 0], box), true, "inside the box");
	assert.equal(segmentHitsBox(cam, [0, 3, -5], { min: [-1, 0, -1], max: [1, 1, 1] }), false, "over a low box");
	assert.deepEqual(normalizeBox(box), normalizeBox({ centre: [0, 1, 0], halfExtents: [1, 1, 1], yawDeg: 0 }));
	// A long thin wall: along x it hides x = 1.5, rotated 90 deg (along z) it does not.
	const wall = { centre: [0, 1, 0], halfExtents: [2, 1, 0.1] };
	assert.equal(segmentHitsBox([1.5, 1, 10], [1.5, 1, -5], { ...wall, yawDeg: 0 }), true, "unrotated wall");
	assert.equal(segmentHitsBox([1.5, 1, 10], [1.5, 1, -5], { ...wall, yawDeg: 90 }), false, "rotated wall");
	assert.throws(() => normalizeBox({ centre: [0, 0, 0] }), /halfExtents/);
}

// The swap classifier.
{
	const truth = { 5: [100, 100], 6: [200, 100], 7: [100, 150], 8: [200, 150], 9: [100, 200], 10: [200, 200] };
	const pairs = [[5, 6], [7, 8], [9, 10]];
	const kp = (map, conf = 0.9) => Array.from({ length: 17 }, (_, k) => (map[k] ? [map[k][0] + 2, map[k][1] - 1, conf] : [0, 0, 0]));
	const swappedMap = { 5: truth[6], 6: truth[5], 7: truth[8], 8: truth[7], 9: truth[10], 10: truth[9] };
	assert.equal(classifySwap(kp(truth), truth, pairs, 100).swapped, false);
	assert.equal(classifySwap(kp(swappedMap), truth, pairs, 100).swapped, true);
	assert.equal(classifySwap(kp(swappedMap, 0.1), truth, pairs, 100).swapped, null, "low confidence does not vote");
	// Swapped but the sides are only 10 px apart: within 20 % of a 100 px torso.
	const near = { 5: [100, 100], 6: [110, 100], 7: [100, 150], 8: [110, 150], 9: [100, 200], 10: [110, 200] };
	const nearSwapped = { 5: near[6], 6: near[5], 7: near[8], 8: near[7], 9: near[10], 10: near[9] };
	assert.equal(classifySwap(kp(nearSwapped), near, pairs, 100).swapped, false);
}

// analyzeClip on a synthetic camera: arms swapped in frame 1, left ankle behind a box in frame 2.
const camera = { K: [[500, 0, 320], [0, 500, 240], [0, 0, 1]], worldToCamera: [[1, 0, 0, 0], [0, -1, 0, 0], [0, 0, -1, 5], [0, 0, 0, 1]] };
{
	const cam = cameraFromJson(camera);
	const base = { 5: [0.2, 1.4, 0], 6: [-0.2, 1.4, 0], 7: [0.3, 1.1, 0], 8: [-0.3, 1.1, 0], 9: [0.35, 0.8, 0], 10: [-0.35, 0.8, 0], 11: [0.1, 0.9, 0], 12: [-0.1, 0.9, 0], 13: [0.12, 0.5, 0], 14: [-0.12, 0.5, 0], 15: [0.12, 0.1, 0], 16: [-0.12, 0.1, 0] };
	const frames = 3;
	const truthWorld = Object.fromEntries(Object.entries(base).map(([k, p]) => [k, Array.from({ length: frames }, (_, t) => (Number(k) === 15 && t === 2 ? [p[0], p[1], -1] : p))]));
	const kp2d = new Float32Array(frames * 17 * 3);
	for (let t = 0; t < frames; t += 1) for (const k of Object.keys(base).map(Number)) {
		const src = t === 1 && k >= 5 && k <= 10 ? (k % 2 ? k + 1 : k - 1) : k;
		const [u, v] = worldToPixel(truthWorld[src][t], cam);
		kp2d.set([u, v, 0.9], (t * 17 + k) * 3);
	}
	const box = { min: [0, 0, -0.6], max: [0.3, 0.3, -0.4] };
	const r = analyzeClip({ kp2d, frames, truthWorld, cam, boxes: [box] });
	assert.deepEqual(r.swaps.frames.arms, [1]);
	assert.deepEqual(r.swaps.frames.legs, []);
	assert.equal(r.occludedJointFrames, 1);
	assert.equal(r.perJoint.leftAnkle.occluded.n, 1);
	close(r.visibleBest.medianPx, 0, 1e-6, "best-assignment error is zero");
	assert.ok(r.perJoint.leftShoulder.visible.meanPx > 10, `identity error sees the swap: ${r.perJoint.leftShoulder.visible.meanPx}`);
}

// Tile matcher: integer and sub-pixel background shifts on a textured image with a moving blob.
{
	const w = 256, h = 160;
	let seed = 7;
	const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
	const phases = Array.from({ length: 6 }, () => [rand() * 6, 0.05 + rand() * 0.25, 0.05 + rand() * 0.25]);
	const scene = (x, y) => phases.reduce((s, [p, fx, fy]) => s + 20 * Math.sin(fx * x + fy * y + p), 128);
	const img = (dx, dy, blob) => Float32Array.from({ length: w * h }, (_, i) => {
		const x = i % w, y = Math.floor(i / w);
		if (blob && Math.hypot(x - blob[0], y - blob[1]) < 20) return 250;
		return scene(x - dx, y - dy);
	});
	const opts = { bandFrac: 0.2 };
	const ref = img(0, 0), tiles = bandTiles(ref, w, h, opts);
	assert.ok(tiles.length >= 8, `textured tiles ${tiles.length}`);
	const median = (shifts, key) => percentile(shifts.map((s) => s[key]), 50);
	const still = tileShifts(ref, img(0, 0, [30, 30]), w, h, tiles);
	assert.ok(median(still, "shift") < 0.05, `static camera: ${median(still, "shift")}`);
	const moved = tileShifts(ref, img(3, -2, [40, 30]), w, h, tiles);
	close(median(moved, "dx"), 3, 0.02, "dx"); close(median(moved, "dy"), -2, 0.02, "dy");
	const sub = tileShifts(ref, img(1.5, 0.5), w, h, tiles);
	close(median(sub, "dx"), 1.5, 0.05, "sub-pixel dx"); close(median(sub, "dy"), 0.5, 0.05, "sub-pixel dy");
	const flat = new Float32Array(w * h).fill(90);
	assert.equal(bandTiles(flat, w, h, opts).length, 0, "flat frames have no textured tiles");
}

assert.deepEqual(frameRuns([5, 3, 4, 9, 11, 10, 20]), ["3-5", "9-11", "20"]);
close(percentile([1, 2, 3, 4], 50), 2.5, 1e-12, "median");
assert.equal(percentile([], 50), null);

const scratch = mkdtempSync(join(tmpdir(), "verify-track-study-2d-"));
try {
	// An item whose obs.npz is missing is reported, not thrown.
	const missing = studyItem({ set: "gt", name: "nothing", variant: "shaded", dir: join(scratch, "nope"), source: join(scratch, "nope.npz"), scene: null }, join(scratch, "obs"));
	assert.equal(missing.status, "missing-obs");
	assert.equal(missing.obsPath, join(scratch, "obs", "gt", "nothing", "g5", "obs.npz"));

	// The grey truth set: gt/cube only, distinct set names, variant skin, deterministic.
	const approved = { items: [
		{ set: "gt", name: "walk", variant: "shaded", dir: "/e/gt/walk", source: "/e/walk.npz", scene: null, scoring: "full" },
		{ set: "cube", name: "sit", variant: "shaded", dir: "/e/exp3/gt/sit", source: "/e/sit.npz", scene: "/e/sit/scene.json", scoring: "full" },
		{ set: "fal", name: "sit-skin-01", variant: "skin", video: "/v.mp4", dir: "/e/exp3/gt/sit", scene: null, scoring: "endpoints-contact" },
	] };
	const skin = skinApprovedFrom(approved, "/e/approved.json", "abc");
	assert.deepEqual(skin.items.map((i) => `${i.set}/${i.name}/${i.variant}`), ["gt-skin/walk/skin", "cube-skin/sit/skin"]);
	assert.equal(skin.items[1].scene, "/e/sit/scene.json");
	assert.equal(skin.items[0].dir, "/e/gt/walk");
	assert.deepEqual(skinApprovedFrom(approved, "/e/approved.json", "abc"), skin);

	// publish-obs: publish, idempotent re-run, refusal to overwrite, copies and signature checks.
	const sha = (...parts) => { const hash = createHash("sha256"); for (const p of parts) hash.update(p); return hash.digest("hex"); };
	const video = join(scratch, "video.mp4");
	writeFileSync(video, "skin video bytes");
	const run = join(scratch, "run"), root = join(scratch, "root"), obsDir = join(run, "gt-skin", "walk", "obs-mannequin");
	mkdirSync(obsDir, { recursive: true });
	const K = [[777, 0, 416], [0, 777, 240], [0, 0, 1]], betas = [0.5, -0.25];
	const manifest = { video, K, betas, detector: "yolo", keypoints: "vitpose", wrapperSha256: "w".repeat(64) };
	manifest.signature = sha(sha(readFileSync(video)), JSON.stringify(K), JSON.stringify(betas), manifest.wrapperSha256, "yolo", "vitpose");
	writeFileSync(join(obsDir, "manifest.json"), JSON.stringify(manifest));
	writeFileSync(join(obsDir, "obs.npz"), "npz bytes");
	writeFileSync(join(obsDir, "extract.log"), "log");
	const quiet = console.log; console.log = () => {};
	let code;
	try { code = publishMain(["--run", run, "--obs-root", root]); } finally { console.log = quiet; }
	assert.equal(code, 0);
	const g5 = join(root, "gt-skin", "walk", "g5");
	assert.equal(readFileSync(join(g5, "obs.npz"), "utf8"), "npz bytes");
	const published = JSON.parse(readFileSync(join(g5, "manifest.json"), "utf8"));
	assert.equal(published.videoSha256, sha(readFileSync(video)));
	assert.equal(published.detector, "yolo");
	assert.equal(published.obsSha256, sha("npz bytes"));
	assert.ok(existsSync(join(run, "publish.json")));
	assert.equal(publish({ run, obsRoot: root, dryRun: false }).results[0].status, "same", "re-publishing identical files is a no-op");
	// A different existing file is never replaced, and nothing of the item is written.
	writeFileSync(join(g5, "obs.npz"), "someone else's obs");
	rmSync(join(g5, "extract.log"));
	const refused = publish({ run, obsRoot: root, dryRun: false });
	assert.equal(refused.ok, false);
	assert.equal(refused.results[0].status, "refused");
	assert.match(refused.results[0].reason, /not overwritten/);
	assert.equal(readFileSync(join(g5, "obs.npz"), "utf8"), "someone else's obs");
	assert.equal(existsSync(join(g5, "extract.log")), false);
	// Obs copied from an obs root, or whose video changed since extraction, are refused.
	const root2 = join(scratch, "root2");
	writeFileSync(join(obsDir, "manifest.json"), JSON.stringify({ ...manifest, source: "/cache/x/obs.npz" }));
	assert.match(publish({ run, obsRoot: root2, dryRun: false }).results[0].reason, /not an extraction/);
	writeFileSync(join(obsDir, "manifest.json"), JSON.stringify(manifest));
	writeFileSync(video, "a different video");
	assert.match(publish({ run, obsRoot: root2, dryRun: false }).results[0].reason, /signature mismatch/);
	writeFileSync(join(obsDir, "manifest.json"), "{not json");
	assert.match(publish({ run, obsRoot: root2, dryRun: false }).results[0].reason, /unreadable manifest/);
	rmSync(join(obsDir, "extract.log"));
	assert.equal(publish({ run, obsRoot: root2, dryRun: true }).results[0].status, "incomplete");
	assert.equal(existsSync(root2), false, "refused items write nothing");
	const quietErr = console.error; console.error = () => {};
	try { assert.equal(publishMain(["--run", run]), 2, "usage error"); } finally { console.error = quietErr; }
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

// The CLI: stage caches are keyed by their inputs, and any item that is not ok gives exit 1.
{
	const dir = mkdtempSync(join(tmpdir(), "verify-track-study-2d-cli-"));
	const STUDY = fileURLToPath(new URL("../tools/track/study-2d.mjs", import.meta.url));
	try {
		/** A cskel27 motion whose four foot joints follow footX(t); identity rotations. */
		const writeMotion = (path, fps, frames, footX) => {
			const posedJoints = new Float32Array(frames * 27 * 3), rotMats = new Float32Array(frames * 27 * 9);
			for (let k = 0; k < frames; k += 1) {
				for (const j of STANCE_FEET) posedJoints[(k * 27 + j) * 3] = footX(k / fps);
				for (let j = 0; j < 27; j += 1) rotMats.set([1, 0, 0, 0, 1, 0, 0, 0, 1], (k * 27 + j) * 9);
			}
			mkdirSync(join(path, ".."), { recursive: true });
			writeNpz(path, motionArraysToNpzMembers({ frames, fps, rotMats, rootPos: new Float32Array(frames * 3), posedJoints }));
		};
		const source = join(dir, "truth.npz"), gbest = join(dir, "baseline", "gt", "fake", "Gbest", "motion.npz");
		writeMotion(source, 30, 60, (t) => (t < 1 ? 0 : t - 1));
		writeMotion(gbest, 24, 48, (t) => 0.03 * t);
		const approved = { items: [{ set: "gt", name: "fake", variant: "shaded", dir: join(dir, "render"), source, scene: null, scoring: "full" }] };
		const approvedPath = join(dir, "approved.json"), skinPath = join(dir, "approved-skin.json");
		writeFileSync(approvedPath, JSON.stringify(approved));
		writeFileSync(skinPath, JSON.stringify(skinApprovedFrom(approved, approvedPath, createHash("sha256").update(readFileSync(approvedPath)).digest("hex"))));
		const out = join(dir, "out"), stancePath = join(out, "stages", "stance.json");
		const study = (...args) => spawnSync(process.execPath, [STUDY, "--approved", approvedPath, "--approved-skin", skinPath, "--obs-root", join(dir, "no-obs"), "--baseline", join(dir, "baseline"), "--out", out, ...args], { encoding: "utf8" });
		const gbestSlide = () => JSON.parse(readFileSync(stancePath, "utf8")).items[0].gbest.cmPerS;

		// All items ok -> exit 0; the stage records its input key.
		let run = study("--stages", "stance");
		assert.equal(run.status, 0, run.stderr);
		close(gbestSlide(), 3, 0.01, "first Gbest slide");
		const first = readFileSync(stancePath, "utf8");
		assert.match(JSON.parse(first).inputKey, /^[0-9a-f]{64}$/);
		// Unchanged inputs, stance not requested: reused byte for byte.
		run = study("--stages", "");
		assert.equal(run.status, 0, run.stderr);
		assert.match(run.stdout, /stage stance: reused/);
		assert.equal(readFileSync(stancePath, "utf8"), first);
		// Regression: a changed input (the Gbest motion) recomputes the unrequested stage instead of reusing it.
		writeMotion(gbest, 24, 48, (t) => 0.1 * t);
		run = study("--stages", "");
		assert.equal(run.status, 0, run.stderr);
		assert.match(run.stdout, /stage stance: inputs changed .*; recomputing/);
		close(gbestSlide(), 10, 0.01, "recomputed Gbest slide");
		close(JSON.parse(readFileSync(join(out, "summary.json"), "utf8")).stance.items[0].gbest.cmPerS, 10, 0.01, "summary carries the recomputed stage");
		assert.notEqual(JSON.parse(readFileSync(stancePath, "utf8")).inputKey, JSON.parse(first).inputKey);

		// Regression: missing skin observations are reported per item AND fail the run (exit 1), after writing the summary.
		run = study("--stages", "skin");
		assert.equal(run.status, 1, `skin stage with missing obs must exit 1:\n${run.stdout}\n${run.stderr}`);
		assert.match(run.stderr, /skin-provenance:gt-skin\/fake=missing-obs/);
		assert.equal(JSON.parse(readFileSync(join(out, "summary.json"), "utf8")).skin.provenance[0].status, "missing-obs");
		// The 2D stage keeps going past missing obs (shaded and skin) and still exits 1.
		run = study("--stages", "2d");
		assert.equal(run.status, 1);
		assert.match(run.stderr, /2d:gt\/fake=missing-obs/);
		assert.match(run.stderr, /2d:gt-skin\/fake=missing-obs/);
		assert.deepEqual(JSON.parse(readFileSync(join(out, "summary.json"), "utf8")).study2d.items.map((r) => r.status), ["missing-obs", "missing-obs"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log("verify-track-study-2d: ok");
