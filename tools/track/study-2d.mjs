#!/usr/bin/env node
/**
 * study-2d.mjs - Gate 0 of the known-character tracker (#500, plan todo 4).
 * Measures, on existing data only, what the tracker has to fix and what it
 * can reach:
 *
 *   (a) stance slide: truth itself and run-492f Gbest, tools/track/metrics.mjs
 *       truthStanceSlideCmPerS (+ pelvis steps > 20 deg/frame)
 *   (b) IoU ceiling: every truth motion scored as the prediction through
 *       tools/bench/score.mjs (the same scorer and field the gate uses)
 *   (c) camera fixedness: per fal clip, the median background-pixel shift vs
 *       frame 0 over textured border-band tiles (10 % of the width; SSD block
 *       matching + Lucas-Kanade refinement), plus static truth renders as controls
 *   (d) 2D evidence: truth joints as the video shows them (the render's
 *       joints.json, verified to be the render of item.source) projected with
 *       camera.json vs the obs kp2d: per-joint pixel error split by box
 *       occlusion, L/R swap frames per bilateral group, and deltaPx
 *   (e) grey (skin) truth set: approved-skin.json and the provenance of its
 *       published observations
 *
 *   node tools/track/study-2d.mjs [--stages 2d,stance,ceiling,camera,skin] [options]
 *
 * Each stage writes <out>/stages/<stage>.json keyed by `inputKey`, the sha256
 * of everything it read (item list, input file hashes, obs root / baseline,
 * and the analysis code). A stage named in --stages is always recomputed; any
 * other stage is reused only when its stored inputKey equals the current one,
 * recomputed when its inputs changed, and left out when it never ran.
 * summary.json/summary.md merge the stages. Any item that is not ok (missing
 * obs, failed scoring, bad provenance, ...) is listed and the exit code is 1.
 * Truth is read here for measurement only; nothing here feeds a tracker.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readNpz } from "../kimodo/read-npz.mjs";
import { cameraFromJson, worldToPixel } from "../bench/obs/extrinsics.mjs";
import { pelvisStepsDeg, resampleMotion, truthStanceSlideCmPerS } from "./metrics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const STAGES = ["2d", "stance", "ceiling", "camera", "skin"];

/** COCO-17 keypoint names (ViTPose order). */
export const COCO_NAMES = ["nose", "leftEye", "rightEye", "leftEar", "rightEar", "leftShoulder", "rightShoulder", "leftElbow", "rightElbow", "leftWrist", "rightWrist", "leftHip", "rightHip", "leftKnee", "rightKnee", "leftAnkle", "rightAnkle"];
/** COCO body keypoint -> rendered rig joint (joints.json name). Face keypoints have no rig joint and are not scored. */
export const COCO_TO_RIG = { 5: "LeftArm", 6: "RightArm", 7: "LeftForeArm", 8: "RightForeArm", 9: "LeftHand", 10: "RightHand", 11: "LeftUpLeg", 12: "RightUpLeg", 13: "LeftLeg", 14: "RightLeg", 15: "LeftFoot", 16: "RightFoot" };
export const BODY_KEYPOINTS = Object.keys(COCO_TO_RIG).map(Number);
/** Bilateral groups as [left, right] COCO pairs (the Viterbi's arms/legs states). */
export const BILATERAL = { arms: [[5, 6], [7, 8], [9, 10]], legs: [[11, 12], [13, 14], [15, 16]] };
/** A group is swapped when the swapped assignment beats identity by more than this fraction of the torso height. */
export const SWAP_MARGIN = 0.2;
/** Keypoints below this ViTPose confidence do not vote in the swap classifier. */
export const SWAP_CONF_MIN = 0.3;
/** A pair vote needs this many confident L/R pairs in the group. */
export const SWAP_MIN_PAIRS = 2;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileSha = (path) => sha256(readFileSync(path));
/** sha256 of a file, or "missing" (a missing input is part of the key too). */
const shaOrMissing = (path) => (path && existsSync(path) ? fileSha(path) : "missing");
/** The analysis code every stage depends on, plus stage-specific repo files. */
const CODE = ["tools/track/study-2d.mjs", "tools/track/metrics.mjs", "tools/bench/obs/extrinsics.mjs", "tools/kimodo/read-npz.mjs"];
export const codeSha = (extra = []) => sha256([...CODE, ...extra].map((p) => `${p}:${fileSha(join(ROOT, p))}`).join("\n"));
/** The cache key of a stage: sha256 of its JSON-described inputs. */
export const inputKey = (inputs) => sha256(JSON.stringify(inputs));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const putJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`); };
const round = (v, d = 3) => (v === null || v === undefined || !Number.isFinite(v) ? v ?? null : Math.round(v * 10 ** d) / 10 ** d);
const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);

/** numpy-style linear-interpolated percentile of an unsorted list (null when empty). */
export function percentile(values, p) {
	if (!values.length) return null;
	const s = Float64Array.from(values).sort();
	const x = (p / 100) * (s.length - 1), lo = Math.floor(x), hi = Math.ceil(x);
	return s[lo] + (s[hi] - s[lo]) * (x - lo);
}
const stats = (xs) => ({ n: xs.length, medianPx: round(percentile(xs, 50), 2), p95Px: round(percentile(xs, 95), 2), meanPx: round(mean(xs), 2) });

/** Frame numbers -> "a-b" runs. */
export function frameRuns(frames) {
	const runs = [];
	for (const f of [...frames].sort((a, b) => a - b)) {
		const last = runs.at(-1);
		if (last && f === last[1] + 1) last[1] = f; else runs.push([f, f]);
	}
	return runs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`));
}

// ---------------------------------------------------------------- the scene

/** scene.json (or a bench box) -> oriented box { centre, half, yaw (rad) }. */
export function normalizeBox(box) {
	if (Array.isArray(box?.min) && Array.isArray(box?.max) && !box.halfExtents) {
		return { centre: box.min.map((v, i) => (v + box.max[i]) / 2), half: box.min.map((v, i) => (box.max[i] - v) / 2), yaw: 0 };
	}
	const centre = box?.centre ?? box?.center, half = box?.halfExtents;
	if (!Array.isArray(centre) || !Array.isArray(half)) throw new Error("box needs {min,max} or {centre, halfExtents, yawDeg}");
	const yaw = Number.isFinite(box.yawDeg) ? (box.yawDeg * Math.PI) / 180 : Number(box.yaw ?? 0);
	return { centre, half, yaw };
}

/**
 * True when the open segment camera -> point passes through the box, i.e. the
 * point is hidden by it (a point inside the box counts as hidden). The box
 * yaw is about +Y (Three's rotation.y).
 */
export function segmentHitsBox(origin, point, rawBox) {
	const { centre, half, yaw } = normalizeBox(rawBox);
	const c = Math.cos(yaw), s = Math.sin(yaw);
	const local = (p) => { const x = p[0] - centre[0], y = p[1] - centre[1], z = p[2] - centre[2]; return [c * x - s * z, y, s * x + c * z]; };
	const o = local(origin), q = local(point);
	let enter = -Infinity, exit = Infinity;
	for (let a = 0; a < 3; a += 1) {
		const d = q[a] - o[a];
		if (Math.abs(d) < 1e-12) {
			if (Math.abs(o[a]) > half[a]) return false;
			continue;
		}
		const t1 = (-half[a] - o[a]) / d, t2 = (half[a] - o[a]) / d;
		enter = Math.max(enter, Math.min(t1, t2));
		exit = Math.min(exit, Math.max(t1, t2));
	}
	return enter <= exit && exit > 1e-9 && enter < 1 - 1e-9;
}

export const jointOccluded = (cameraCentre, point, boxes) => boxes.some((box) => segmentHitsBox(cameraCentre, point, box));

// ------------------------------------------------------------ the 2D study

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * L/R swap test for one bilateral group in one frame. kp: COCO-17 [x, y, conf];
 * truthPx: COCO index -> [u, v]. Returns { swapped: true|false|null (too few
 * confident pairs), identityPx, swappedPx, pairs }.
 */
export function classifySwap(kp, truthPx, pairs, torsoPx, { confMin = SWAP_CONF_MIN, margin = SWAP_MARGIN, minPairs = SWAP_MIN_PAIRS } = {}) {
	let identity = 0, swapped = 0, used = 0;
	for (const [l, r] of pairs) {
		if (!(kp[l][2] >= confMin && kp[r][2] >= confMin)) continue;
		identity += dist(kp[l], truthPx[l]) + dist(kp[r], truthPx[r]);
		swapped += dist(kp[l], truthPx[r]) + dist(kp[r], truthPx[l]);
		used += 1;
	}
	if (used < minPairs) return { swapped: null, identityPx: null, swappedPx: null, pairs: used };
	identity /= 2 * used; swapped /= 2 * used;
	return { swapped: identity - swapped > margin * torsoPx, identityPx: identity, swappedPx: swapped, pairs: used };
}

/**
 * The pure 2D analysis of one clip. kp2d: frames x 17 x 3 (flat); truthWorld:
 * COCO index -> [T][3] world points; cam: cameraFromJson(camera.json); boxes:
 * scene boxes. Returns per-joint visible/occluded errors, swap frames and the
 * raw error lists (visibleBest = error under the per-frame truth-chosen L/R
 * assignment, the Viterbi's noise scale).
 */
export function analyzeClip({ kp2d, frames, truthWorld, cam, boxes = [] }) {
	const centre = cam.t_c2w;
	const perJoint = Object.fromEntries(BODY_KEYPOINTS.map((k) => [COCO_NAMES[k], { visible: [], occluded: [] }]));
	const visibleBest = [], occludedBest = [], visibleIdentity = [], occludedIdentity = [];
	const swaps = { arms: [], legs: [] }, scored = { arms: 0, legs: 0 };
	const occludedPairs = [];
	for (let t = 0; t < frames; t += 1) {
		const kp = Array.from({ length: 17 }, (_, k) => [kp2d[(t * 17 + k) * 3], kp2d[(t * 17 + k) * 3 + 1], kp2d[(t * 17 + k) * 3 + 2]]);
		const px = {}, hidden = {};
		for (const k of BODY_KEYPOINTS) {
			px[k] = worldToPixel(truthWorld[k][t], cam);
			hidden[k] = jointOccluded(centre, truthWorld[k][t], boxes);
			if (hidden[k]) occludedPairs.push([t, COCO_NAMES[k]]);
		}
		const mid = (a, b) => [(px[a][0] + px[b][0]) / 2, (px[a][1] + px[b][1]) / 2];
		const torso = dist(mid(5, 6), mid(11, 12));
		const chosen = {};
		for (const [group, pairs] of Object.entries(BILATERAL)) {
			const verdict = classifySwap(kp, px, pairs, torso);
			if (verdict.swapped !== null) scored[group] += 1;
			if (verdict.swapped) swaps[group].push(t);
			for (const [l, r] of pairs) { chosen[l] = verdict.swapped ? r : l; chosen[r] = verdict.swapped ? l : r; }
		}
		for (const k of BODY_KEYPOINTS) {
			const identity = dist(kp[k], px[k]), best = dist(kp[k], px[chosen[k]]);
			perJoint[COCO_NAMES[k]][hidden[k] ? "occluded" : "visible"].push(identity);
			(hidden[k] ? occludedBest : visibleBest).push(best);
			(hidden[k] ? occludedIdentity : visibleIdentity).push(identity);
		}
	}
	const both = swaps.arms.filter((t) => swaps.legs.includes(t));
	const any = [...new Set([...swaps.arms, ...swaps.legs])].sort((a, b) => a - b);
	return {
		frames,
		perJoint: Object.fromEntries(Object.entries(perJoint).map(([name, v]) => [name, { visible: stats(v.visible), occluded: stats(v.occluded) }])),
		visible: stats(visibleIdentity), occluded: stats(occludedIdentity), visibleBest: stats(visibleBest), occludedBest: stats(occludedBest),
		swaps: {
			counts: { arms: swaps.arms.length, legs: swaps.legs.length, both: both.length, any: any.length },
			scoredFrames: scored,
			runs: { arms: frameRuns(swaps.arms), legs: frameRuns(swaps.legs) },
			frames: { arms: swaps.arms, legs: swaps.legs },
		},
		occludedJointFrames: occludedPairs.length,
		raw: { visibleBest, visibleIdentity },
	};
}

/** Load one truth item and its obs and run analyzeClip. Missing obs -> status "missing-obs" (never throws for it). */
export function studyItem(item, obsRoot) {
	const label = `${item.set}/${item.name}`;
	const obsPath = join(obsRoot, item.set, item.name, "g5", "obs.npz");
	if (!existsSync(obsPath)) return { item: label, variant: item.variant, status: "missing-obs", obsPath };
	const files = join(item.dir, item.variant);
	const camera = readJson(join(files, "camera.json")), joints = readJson(join(files, "joints.json")), meta = readJson(join(files, "meta.json"));
	if (meta.source?.path !== item.source || meta.source?.sha256 !== fileSha(item.source)) throw new Error(`${label}: ${files} is not the render of ${item.source}`);
	const cam = cameraFromJson(camera);
	const index = Object.fromEntries(joints.joints.map((j, i) => [j.name, i]));
	const truthWorld = Object.fromEntries(BODY_KEYPOINTS.map((k) => {
		const i = index[COCO_TO_RIG[k]];
		if (i === undefined) throw new Error(`${label}: joints.json has no ${COCO_TO_RIG[k]}`);
		return [k, joints.world.map((frame) => frame[i])];
	}));
	// The projection must be the render's own (joints.json uv).
	let projectionCheckPx = 0;
	for (let t = 0; t < joints.frames; t += 1) for (const k of BODY_KEYPOINTS) projectionCheckPx = Math.max(projectionCheckPx, dist(worldToPixel(truthWorld[k][t], cam), joints.uv[t][index[COCO_TO_RIG[k]]]));
	if (!(projectionCheckPx < 0.01)) throw new Error(`${label}: camera.json projection disagrees with joints.json uv by ${projectionCheckPx} px`);
	const obs = readNpz(obsPath);
	const [obsFrames] = obs.kp2d.shape;
	const Kgap = Math.max(...camera.K.flat().map((v, i) => Math.abs(v - obs.K.data[i])));
	const boxes = item.scene ? [readJson(item.scene)] : [];
	const frames = Math.min(obsFrames, joints.frames);
	const result = analyzeClip({ kp2d: obs.kp2d.data, frames, truthWorld, cam, boxes });
	return { item: label, variant: item.variant, status: "ok", obsPath, obsSha256: fileSha(obsPath), obsFrames, truthFrames: joints.frames, obsKVsCameraMax: Kgap, projectionCheckPx, boxes: boxes.length, ...result };
}

// -------------------------------------------------------------- (a) stance

function motionOf(path) {
	const npz = readNpz(path);
	return { frames: npz.posed_joints.shape[0], fps: npz.fps.data[0], posedJoints: npz.posed_joints.data, rotMats: npz.local_rot_mats.data };
}

export function stanceItem(item, baselineRun) {
	const label = `${item.set}/${item.name}`;
	const truth = motionOf(item.source);
	const gbestPath = join(baselineRun, item.set, item.name, "Gbest", "motion.npz");
	if (!existsSync(gbestPath)) return { item: label, status: "missing-baseline", gbestPath };
	const gbest = motionOf(gbestPath);
	// The truth is measured as a prediction on the same timeline as Gbest (its fps and frame count).
	const t = truthStanceSlideCmPerS(resampleMotion(truth, gbest.fps, gbest.frames), truth), g = truthStanceSlideCmPerS(gbest, truth);
	const steps = (m) => { const s = pelvisStepsDeg(m.rotMats, m.frames); return { over20: s.filter((v) => v > 20).length, maxDeg: round(Math.max(...s), 2) }; };
	return {
		item: label, status: "ok", gbestPath, gbestSha256: fileSha(gbestPath),
		truth: { cmPerS: round(t.meanCmPerS), stanceSamples: t.stanceSamples, fps: truth.fps, frames: truth.frames, pelvisSteps: steps(truth) },
		gbest: { cmPerS: round(g.meanCmPerS), stanceSamples: g.stanceSamples, fps: gbest.fps, frames: gbest.frames, pelvisSteps: steps(gbest) },
		rule: g.rule,
	};
}

// ------------------------------------------------------------ (b) ceiling

/** Score the truth motion as the prediction with score.mjs exactly as obs-bench does for gt/cube items. */
/** What a truth-as-prediction score depends on (score.json is reused only while this is unchanged). */
export function ceilingInputs(item) {
	return {
		item, source: shaOrMissing(item.source), scene: shaOrMissing(item.scene),
		gt: ["camera.json", "joints.json"].map((f) => shaOrMissing(join(item.dir, item.variant, f))),
		scorer: ["tools/bench/score.mjs", "tools/gt-render/render.mjs"].map((p) => shaOrMissing(join(ROOT, p))),
	};
}

export function ceilingItem(item, outDir, { port, cdpPort, force }) {
	const label = `${item.set}/${item.name}`, out = join(outDir, "gt-self", item.set, item.name);
	const scorePath = join(out, "score.json"), keyPath = join(out, "inputs.json"), key = inputKey(ceilingInputs(item));
	let reused = true;
	if (force || !existsSync(scorePath) || !existsSync(keyPath) || readJson(keyPath).inputKey !== key) {
		reused = false;
		mkdirSync(out, { recursive: true });
		const args = [join(ROOT, "tools/bench/score.mjs"), "--gt", join(item.dir, item.variant), "--pred", item.source, "--out", out, "--port", String(port), "--cdp-port", String(cdpPort)];
		if (item.scene) { const s = readJson(item.scene); args.push("--box", JSON.stringify({ min: s.min, max: s.max }), "--gt-npz", item.source); }
		const fd = openSync(join(out, "score.log"), "a");
		try {
			const run = spawnSync(process.execPath, args, { cwd: ROOT, stdio: ["ignore", fd, fd], timeout: 20 * 60000 });
			if (run.status !== 0) return { item: label, status: "score-failed", code: run.status ?? run.signal, log: join(out, "score.log") };
		} finally { closeSync(fd); }
		putJson(keyPath, { inputKey: key, inputs: ceilingInputs(item) });
	}
	const s = readJson(scorePath);
	return {
		item: label, variant: item.variant, status: "ok", reused, score: scorePath,
		maskIoURawMean: s.overlap.maskIoURawMean, maskIoUAlignedMean: s.overlap.maskIoUAlignedMean,
		paMpjpeM: s.pose.paMpjpeM, rootErrorRawRmseM: s.trajectory.rootErrorRawM.rmse, ateAlignedRmseM: s.trajectory.ateAlignedM.rmse,
	};
}

// -------------------------------------------------------------- (c) camera

const inBand = (x, y, w, h, b) => x < b || y < b || x >= w - b || y >= h - b;

function halfRes(img, w, h) {
	const W = w >> 1, H = h >> 1, out = new Float32Array(W * H);
	for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) out[y * W + x] = (img[2 * y * w + 2 * x] + img[2 * y * w + 2 * x + 1] + img[(2 * y + 1) * w + 2 * x] + img[(2 * y + 1) * w + 2 * x + 1]) / 4;
	return out;
}

/**
 * Textured tiles of the border band of the reference frame: tile x tile
 * blocks lying entirely within bandFrac x width of an image edge whose
 * structure tensor's smaller eigenvalue (per pixel, grey levels^2) is at least
 * minTexture, so flat sky/floor and single edges (aperture problem) do not vote.
 */
export function bandTiles(ref, w, h, { bandFrac = 0.1, tile = 32, margin = 14, minTexture = 2 } = {}) {
	const band = Math.round(bandFrac * w), tiles = [];
	for (let y = margin; y + tile <= h - margin; y += tile) for (let x = margin; x + tile <= w - margin; x += tile) {
		const corners = [[x, y], [x + tile - 1, y], [x, y + tile - 1], [x + tile - 1, y + tile - 1]];
		if (!corners.every(([cx, cy]) => inBand(cx, cy, w, h, band))) continue;
		let sxx = 0, syy = 0, sxy = 0;
		for (let yy = y; yy < y + tile; yy += 1) for (let xx = x; xx < x + tile; xx += 1) {
			const gx = (ref[yy * w + xx + 1] - ref[yy * w + xx - 1]) / 2, gy = (ref[(yy + 1) * w + xx] - ref[(yy - 1) * w + xx]) / 2;
			sxx += gx * gx; syy += gy * gy; sxy += gx * gy;
		}
		const n = tile * tile, a = sxx / n, c = syy / n, b = sxy / n;
		const minEig = (a + c) / 2 - Math.sqrt(((a - c) / 2) ** 2 + b * b);
		if (minEig >= minTexture) tiles.push({ x, y, minEig });
	}
	return tiles;
}

function ssd(ref, cur, w, x, y, size, dx, dy) {
	let s = 0;
	for (let yy = y; yy < y + size; yy += 1) {
		const r = yy * w, c = (yy + dy) * w + dx;
		for (let xx = x; xx < x + size; xx += 1) { const d = ref[r + xx] - cur[c + xx]; s += d * d; }
	}
	return s;
}

const parabola = (m, c0, p) => { const den = m - 2 * c0 + p; return den > 0 ? (0.5 * (m - p)) / den : 0; };

function bilinear(img, w, x, y) {
	const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * w + x0;
	return img[i] * (1 - fx) * (1 - fy) + img[i + 1] * fx * (1 - fy) + img[i + w] * (1 - fx) * fy + img[i + w + 1] * fx * fy;
}

/** Lucas-Kanade translation refinement of one tile from (dx, dy); the parabola alone is biased up to ~0.25 px. */
function refineLk(ref, cur, w, h, x, y, size, dx, dy, iterations = 6) {
	for (let it = 0; it < iterations; it += 1) {
		if (x + dx < 2 || y + dy < 2 || x + dx + size > w - 3 || y + dy + size > h - 3) break;
		let a = 0, b = 0, c = 0, gx0 = 0, gy0 = 0;
		for (let yy = y; yy < y + size; yy += 1) for (let xx = x; xx < x + size; xx += 1) {
			const u = xx + dx, v = yy + dy;
			const gx = (bilinear(cur, w, u + 1, v) - bilinear(cur, w, u - 1, v)) / 2, gy = (bilinear(cur, w, u, v + 1) - bilinear(cur, w, u, v - 1)) / 2;
			const r = bilinear(cur, w, u, v) - ref[yy * w + xx];
			a += gx * gx; b += gx * gy; c += gy * gy; gx0 += gx * r; gy0 += gy * r;
		}
		const det = a * c - b * b;
		if (!(det > 1e-9)) break;
		const sx = -(c * gx0 - b * gy0) / det, sy = -(a * gy0 - b * gx0) / det;
		if (!(Math.abs(sx) < 1.5 && Math.abs(sy) < 1.5)) break;
		dx += sx; dy += sy;
		if (Math.hypot(sx, sy) < 1e-3) break;
	}
	return [dx, dy];
}

/**
 * Translation of every tile between ref and cur (SSD block matching: +-radius
 * px on the half-resolution frames, then +-2 px at full resolution with a
 * parabolic sub-pixel fit). Returns [{ x, y, dx, dy, shift, clipped }] where
 * clipped = the best match sits on the search bound (a shift >= radius).
 */
export function tileShifts(ref, cur, w, h, tiles, { tile = 32, radius = 12, refHalf = null, curHalf = null } = {}) {
	const rh = refHalf ?? halfRes(ref, w, h), ch = curHalf ?? halfRes(cur, w, h), hw = w >> 1, hh = h >> 1, R = Math.ceil(radius / 2), ht = tile >> 1;
	return tiles.map(({ x, y }) => {
		const hx = x >> 1, hy = y >> 1;
		let best = Infinity, bx = 0, by = 0;
		for (let dy = -R; dy <= R; dy += 1) for (let dx = -R; dx <= R; dx += 1) {
			if (hx + dx < 0 || hy + dy < 0 || hx + dx + ht > hw || hy + dy + ht > hh) continue;
			const s = ssd(rh, ch, hw, hx, hy, ht, dx, dy);
			if (s < best) { best = s; bx = dx; by = dy; }
		}
		let fbest = Infinity, fx = 2 * bx, fy = 2 * by;
		const cands = [];
		for (let dy = 2 * by - 2; dy <= 2 * by + 2; dy += 1) for (let dx = 2 * bx - 2; dx <= 2 * bx + 2; dx += 1) {
			if (x + dx < 0 || y + dy < 0 || x + dx + tile > w || y + dy + tile > h) continue;
			const s = ssd(ref, cur, w, x, y, tile, dx, dy);
			cands.push([dx, dy, s]);
			if (s < fbest) { fbest = s; fx = dx; fy = dy; }
		}
		const at = (dx, dy) => cands.find((c) => c[0] === dx && c[1] === dy)?.[2];
		const sx = [at(fx - 1, fy), at(fx + 1, fy)], sy = [at(fx, fy - 1), at(fx, fy + 1)];
		const subX = sx.every(Number.isFinite) ? parabola(sx[0], fbest, sx[1]) : 0, subY = sy.every(Number.isFinite) ? parabola(sy[0], fbest, sy[1]) : 0;
		const [dx, dy] = refineLk(ref, cur, w, h, x, y, tile, fx + subX, fy + subY);
		return { x, y, dx, dy, shift: Math.hypot(dx, dy), clipped: Math.abs(bx) === R || Math.abs(by) === R };
	});
}

function decodeGrey(video, width, height) {
	const run = spawnSync("ffmpeg", ["-v", "error", "-i", video, "-vf", `scale=${width}:${height}`, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], { maxBuffer: 2 ** 31 });
	if (run.status !== 0) throw new Error(`ffmpeg ${video}: ${run.stderr}`);
	const size = width * height, frames = run.stdout.length / size;
	if (!Number.isInteger(frames) || frames < 2) throw new Error(`${video}: decoded ${run.stdout.length} bytes`);
	return Array.from({ length: frames }, (_, i) => Float32Array.from(run.stdout.subarray(i * size, (i + 1) * size)));
}

/** Median background-pixel shift vs frame 0 on the border band, per frame and summarised per clip. */
export function cameraProbe(label, video, width, height, log = () => {}) {
	const frames = decodeGrey(video, width, height), tiles = bandTiles(frames[0], width, height);
	if (tiles.length < 8) throw new Error(`only ${tiles.length} textured band tiles in frame 0`);
	const refHalf = halfRes(frames[0], width, height), perFrame = [];
	for (let t = 1; t < frames.length; t += 1) {
		const shifts = tileShifts(frames[0], frames[t], width, height, tiles, { refHalf });
		perFrame.push({ medianPx: percentile(shifts.map((s) => s.shift), 50), movedFraction: shifts.filter((s) => s.shift > 1).length / shifts.length, clipped: shifts.filter((s) => s.clipped).length, dx: percentile(shifts.map((s) => s.dx), 50), dy: percentile(shifts.map((s) => s.dy), 50) });
		if (t % 40 === 0) log(`${label}: frame ${t}/${frames.length - 1}`);
	}
	const med = perFrame.map((f) => f.medianPx), last = perFrame.at(-1);
	return {
		clip: label, video, videoSha256: fileSha(video), frames: frames.length, tiles: tiles.length,
		medianShiftPx: round(percentile(med, 50), 3), p95ShiftPx: round(percentile(med, 95), 3), maxShiftPx: round(Math.max(...med), 3),
		framesOver1Px: med.filter((v) => v >= 1).length, maxMovedTileFraction: round(Math.max(...perFrame.map((f) => f.movedFraction)), 3),
		lastFrame: { medianPx: round(last.medianPx, 3), dx: round(last.dx, 3), dy: round(last.dy, 3), movedTileFraction: round(last.movedFraction, 3) },
		perFrameMedianPx: med.map((v) => round(v, 3)),
	};
}

// ---------------------------------------------------------------- (e) skin

const SKIN_SET = { gt: "gt-skin", cube: "cube-skin" };

/** approved.json -> approved-skin.json: the truth items as variant skin under distinct set names. Deterministic. */
export function skinApprovedFrom(approved, approvedPath, approvedSha256) {
	return {
		derivedFrom: { path: approvedPath, sha256: approvedSha256 },
		note: "Grey (skin) truth set: the approved gt/cube items with variant skin under distinct set names so the obs cache and run dirs (keyed by set/name) never reuse the shaded observations. Written by tools/track/study-2d.mjs skinApprovedFrom().",
		items: approved.items.filter((i) => SKIN_SET[i.set]).map((i) => ({ set: SKIN_SET[i.set], name: i.name, variant: "skin", dir: i.dir, source: i.source, scene: i.scene, scoring: i.scoring })),
	};
}

/** Provenance of one published skin obs: manifest video sha / detector, and separation from the shaded obs. */
export function skinProvenance(item, obsRoot, shadedSet) {
	const g5 = join(obsRoot, item.set, item.name, "g5"), manifestPath = join(g5, "manifest.json"), obsPath = join(g5, "obs.npz");
	const label = `${item.set}/${item.name}`;
	if (!existsSync(obsPath) || !existsSync(manifestPath)) return { item: label, status: "missing-obs", g5 };
	const manifest = readJson(manifestPath), video = join(item.dir, "skin", "video.mp4"), shadedVideo = join(item.dir, "shaded", "video.mp4");
	const shadedObs = join(obsRoot, shadedSet, item.name, "g5", "obs.npz");
	const videoSha256 = fileSha(video), obsSha256 = fileSha(obsPath);
	const checks = {
		manifestVideoSha256MatchesSkinVideo: manifest.videoSha256 === videoSha256,
		manifestVideoIsSkin: resolve(manifest.video) === resolve(video),
		detectorYolo: manifest.detector === "yolo",
		keypointsVitpose: manifest.keypoints === "vitpose",
		obsShaMatchesManifest: manifest.obsSha256 === obsSha256,
		skinVideoDiffersFromShaded: videoSha256 !== fileSha(shadedVideo),
		skinObsDiffersFromShadedObs: existsSync(shadedObs) ? obsSha256 !== fileSha(shadedObs) : null,
	};
	return { item: label, status: Object.values(checks).every((v) => v !== false) ? "ok" : "bad-provenance", g5, videoSha256, obsSha256, detector: manifest.detector, checks };
}

/** The no-extract handoff run: every item read its mannequin obs from the obs root and G5 scored. */
export function handoffCheck(item, runDir, obsRoot) {
	const dir = join(runDir, item.set, item.name), log = join(dir, "bench.log"), label = `${item.set}/${item.name}`;
	if (!existsSync(log)) return { item: label, status: "missing-log" };
	const text = readFileSync(log, "utf8");
	const manifest = existsSync(join(dir, "obs-mannequin", "manifest.json")) ? readJson(join(dir, "obs-mannequin", "manifest.json")) : null;
	const result = existsSync(join(dir, "G5", "result.json")) ? readJson(join(dir, "G5", "result.json")) : null;
	const expected = join(obsRoot, item.set, item.name, "g5", "obs.npz");
	const checks = {
		fromObsRootLine: text.includes("obs-mannequin: from obs root"),
		noExtraction: !text.includes("extracting on"),
		manifestSourceIsPublished: resolve(manifest?.source ?? "") === resolve(expected),
		g5Ok: result?.ok === true,
		g5ScoreFileParses: result?.ok ? existsSync(join(dir, "G5", "score", "score.json")) && Number.isFinite(readJson(join(dir, "G5", "score", "score.json")).overlap?.maskIoURawMean) : false,
	};
	return { item: label, status: Object.values(checks).every(Boolean) ? "ok" : "failed", checks, g5: result?.score ? { paMpjpeM: result.score.paMpjpeM, iouRaw: result.score.iouRaw, rootErrorRawRmseM: result.score.rootErrorRawRmseM } : null };
}

// ---------------------------------------------------------------- summary

function markdown(summary) {
	const L = [], f = (v, d = 2) => (v === null || v === undefined ? "-" : Number(v).toFixed(d));
	L.push("# Gate 0: 2D evidence, headroom ceiling, camera fixedness (#500 todo 4)", "", `Generated ${summary.createdAt} by tools/track/study-2d.mjs (commit ${summary.commit}). Numbers below are copied from summary.json.`, "");
	const a = summary.stance;
	L.push("## (a) Stance slide on truth-stance frames (truthStanceSlideCmPerS)", "");
	if (a) {
		L.push(`Rule: ${a.rule}`, "", "| item | truth cm/s | Gbest cm/s | stance samples | Gbest pelvis steps >20 deg | Gbest max step deg |", "| --- | --- | --- | --- | --- | --- |");
		for (const r of a.items) L.push(r.status === "ok" ? `| ${r.item} | ${f(r.truth.cmPerS)} | ${f(r.gbest.cmPerS)} | ${r.gbest.stanceSamples} | ${r.gbest.pelvisSteps.over20} | ${f(r.gbest.pelvisSteps.maxDeg, 1)} |` : `| ${r.item} | ${r.status} | | | | |`);
		L.push(`| **mean** | **${f(a.mean.truthCmPerS)}** | **${f(a.mean.gbestCmPerS)}** | | | |`, "");
	}
	const b = summary.iouCeiling;
	L.push("## (b) Truth-as-prediction IoU ceiling (overlap.maskIoURawMean)", "");
	if (b) {
		L.push("| set | items | mean IoU raw | min | IS-1 truth threshold (0.9 x) |", "| --- | --- | --- | --- | --- |");
		for (const [set, v] of Object.entries(b.perSet)) L.push(`| ${set} | ${v.items} | ${f(v.meanIoURaw, 4)} | ${f(v.minIoURaw, 4)} | ${f(v.is1Threshold, 4)} |`);
		L.push("", "| item | IoU raw | IoU aligned | PA-MPJPE m | root raw m |", "| --- | --- | --- | --- | --- |");
		for (const r of b.items) L.push(r.status === "ok" ? `| ${r.item} | ${f(r.maskIoURawMean, 4)} | ${f(r.maskIoUAlignedMean, 4)} | ${f(r.paMpjpeM, 4)} | ${f(r.rootErrorRawRmseM, 4)} |` : `| ${r.item} | ${r.status} | | | |`);
		L.push("", b.skinNote, "");
	}
	const c = summary.camera;
	L.push("## (c) Camera fixedness (fal clips)", "");
	if (c) {
		L.push(`Method: ${c.method}`, "", `**cameraFixed: ${c.cameraFixed}** (rule: median shift < ${c.thresholdPx} px on every fal clip; worst clip ${c.worst?.clip ?? "-"} ${f(c.worst?.medianShiftPx, 3)} px)`, "");
		L.push("| clip | median shift px | p95 px | max px | frames >= 1 px | textured tiles | last-frame dx, dy |", "| --- | --- | --- | --- | --- | --- | --- |");
		for (const r of [...c.clips, ...c.controls.map((x) => ({ ...x, clip: `control ${x.clip}` }))]) L.push(r.status !== "ok" ? `| ${r.clip ?? r.item} | ${r.status}: ${r.error} | | | | |` : `| ${r.clip} | ${f(r.medianShiftPx, 3)} | ${f(r.p95ShiftPx, 3)} | ${f(r.maxShiftPx, 3)} | ${r.framesOver1Px} | ${r.tiles} | ${f(r.lastFrame.dx)}, ${f(r.lastFrame.dy)} |`);
		L.push("");
	}
	const d = summary.study2d;
	L.push("## (d) 2D evidence: truth projected vs obs kp2d", "");
	if (d) {
		L.push(`deltaPx (median visible error under the truth-chosen L/R assignment, shaded set): **${f(summary.deltaPx)} px**. ${d.deltaNote}`, "");
		for (const [variant, v] of Object.entries(d.perVariant)) L.push(`- ${variant}: deltaPx ${f(v.deltaPx)} px, identity-assignment visible median ${f(v.visibleIdentityMedianPx)} px, items ok ${v.itemsOk}/${v.items}`);
		L.push("", "| item | variant | status | frames | arm swaps | leg swaps | swap runs (arms / legs) | visible median / p95 px (identity) | occluded median / p95 px (n) |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
		for (const r of d.items) {
			if (r.status !== "ok") { L.push(`| ${r.item} | ${r.variant} | ${r.status} | | | | | | |`); continue; }
			L.push(`| ${r.item} | ${r.variant} | ok | ${r.frames} | ${r.swaps.counts.arms} | ${r.swaps.counts.legs} | ${r.swaps.runs.arms.join(",") || "-"} / ${r.swaps.runs.legs.join(",") || "-"} | ${f(r.visible.medianPx)} / ${f(r.visible.p95Px)} | ${f(r.occluded.medianPx)} / ${f(r.occluded.p95Px)} (${r.occluded.n}) |`);
		}
		L.push("", "Per-joint median px (visible | occluded), shaded set pooled:", "", "| joint | visible median | visible p95 | occluded median | occluded p95 | occluded n |", "| --- | --- | --- | --- | --- | --- |");
		for (const [joint, v] of Object.entries(d.pooledPerJoint.shaded ?? {})) L.push(`| ${joint} | ${f(v.visible.medianPx)} | ${f(v.visible.p95Px)} | ${f(v.occluded.medianPx)} | ${f(v.occluded.p95Px)} | ${v.occluded.n} |`);
		if (d.walkFlipWindow) L.push("", `gt/walk known flip window f18-51: swap frames inside it ${d.walkFlipWindow.inside}, outside ${d.walkFlipWindow.outside} (overlap: ${d.walkFlipWindow.overlaps}).`);
		L.push("");
	}
	const e = summary.skin;
	L.push("## (e) Grey (skin) truth set", "");
	if (e) {
		L.push(`approved-skin.json: ${e.approvedSkin.items} items, sets ${e.approvedSkin.sets.join(", ")}; selectItems ok: ${e.approvedSkin.selectItemsOk}; equals skinApprovedFrom(approved.json): ${e.approvedSkin.matchesGenerator}.`, "");
		L.push("| item | provenance | video sha256 (skin) | detector | skin obs != shaded obs | handoff |", "| --- | --- | --- | --- | --- | --- |");
		for (const r of e.provenance) {
			const h = e.handoff?.find((x) => x.item === r.item);
			L.push(`| ${r.item} | ${r.status} | ${r.videoSha256?.slice(0, 12) ?? "-"} | ${r.detector ?? "-"} | ${r.checks?.skinObsDiffersFromShadedObs ?? "-"} | ${h ? h.status : "not run"} |`);
		}
		L.push("");
	}
	return `${L.join("\n")}\n`;
}

// -------------------------------------------------------------------- main

export const USAGE = `usage: node tools/track/study-2d.mjs [options]

  --stages 2d,stance,ceiling,camera,skin   stages to recompute (default all); other stages
                          are reused only while their inputs are unchanged, else recomputed
  --approved <json>       shaded truth + fal items (default evidence/obs/approved.json)
  --approved-skin <json>  grey truth items (default evidence/obs/approved-skin.json)
  --write-approved-skin   write --approved-skin from --approved (refuses to replace a different file)
  --obs-root <dir>        obs cache <dir>/<set>/<name>/g5/obs.npz (default evidence/obs/cache)
  --baseline <run>        Gbest baseline run (default evidence/obs/run-492f)
  --handoff <run>         a no-extract obs-bench run of approved-skin.json to verify
  --items a,b             limit to these set/name items
  --out <dir>             default evidence/obs/study-2d
  --port 5504 --cdp-port 9504   scorer ports for the ceiling stage
  --force                 re-score the ceiling even when score.json matches its inputs

Exit code 1 when any item is not ok (missing obs, failed scoring, bad provenance, failed handoff).`;

export function parseArgs(argv) {
	const o = { stages: STAGES, approved: "evidence/obs/approved.json", approvedSkin: "evidence/obs/approved-skin.json", obsRoot: "evidence/obs/cache", baseline: "evidence/obs/run-492f", out: "evidence/obs/study-2d", port: 5504, cdpPort: 9504, force: false, writeApprovedSkin: false };
	const names = { "--stages": "stages", "--approved": "approved", "--approved-skin": "approvedSkin", "--obs-root": "obsRoot", "--baseline": "baseline", "--handoff": "handoff", "--items": "items", "--out": "out", "--port": "port", "--cdp-port": "cdpPort" };
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		if (flag === "--help" || flag === "-h") { o.help = true; continue; }
		if (flag === "--force") { o.force = true; continue; }
		if (flag === "--write-approved-skin") { o.writeApprovedSkin = true; continue; }
		if (!names[flag]) throw new Error(`unknown option ${flag}`);
		const value = argv[++i];
		if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
		o[names[flag]] = value;
	}
	if (typeof o.stages === "string") o.stages = o.stages.split(",").map((s) => s.trim()).filter(Boolean);
	const bad = o.stages.filter((s) => !STAGES.includes(s));
	if (bad.length) throw new Error(`unknown stages ${bad.join(",")}; known ${STAGES.join(",")}`);
	if (typeof o.items === "string") o.items = o.items.split(",").map((s) => s.trim()).filter(Boolean);
	for (const key of ["port", "cdpPort"]) { o[key] = Number(o[key]); if (!Number.isInteger(o[key])) throw new Error(`--${key} must be an integer`); }
	for (const key of ["approved", "approvedSkin", "obsRoot", "baseline", "out", "handoff"]) if (o[key]) o[key] = resolve(o[key]);
	return o;
}

function commitId() {
	const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
	const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
	return `${head}${dirty ? "-dirty" : ""}`;
}

export async function main(argv = process.argv.slice(2)) {
	const o = parseArgs(argv);
	if (o.help) { console.log(USAGE); return; }
	const approvedBytes = readFileSync(o.approved), approved = JSON.parse(approvedBytes);
	if (!Array.isArray(approved?.items)) throw new Error(`${o.approved}: no items array`);
	const generated = skinApprovedFrom(approved, o.approved, sha256(approvedBytes));
	if (o.writeApprovedSkin) {
		const text = `${JSON.stringify(generated, null, "\t")}\n`;
		if (existsSync(o.approvedSkin) && readFileSync(o.approvedSkin, "utf8") !== text) throw new Error(`${o.approvedSkin} exists and differs; not replacing it`);
		writeFileSync(o.approvedSkin, text);
		console.log(`study-2d: wrote ${o.approvedSkin} (${generated.items.length} items)`);
	}
	const pick = (items) => (o.items ? items.filter((i) => o.items.includes(`${i.set}/${i.name}`)) : items);
	const truthItems = pick(approved.items.filter((i) => i.set === "gt" || i.set === "cube"));
	const falItems = pick(approved.items.filter((i) => i.set === "fal"));
	const skinApproved = existsSync(o.approvedSkin) ? readJson(o.approvedSkin) : null;
	const skinItems = skinApproved ? pick(skinApproved.items) : [];
	const stageDir = join(o.out, "stages"), log = (line) => console.log(`[study-2d] ${line}`);
	/** Run, reuse or skip one stage by its input key (see the header). */
	const stage = async (name, inputs, fn) => {
		const path = join(stageDir, `${name}.json`), key = inputKey(inputs);
		const cached = existsSync(path) ? readJson(path) : null;
		if (!o.stages.includes(name)) {
			if (!cached) return null;
			if (cached.inputKey === key) { log(`stage ${name}: reused (inputs unchanged since ${cached.createdAt})`); return cached; }
			log(`stage ${name}: inputs changed since ${cached.createdAt}; recomputing`);
		} else log(`stage ${name}`);
		const value = { createdAt: new Date().toISOString(), commit: commitId(), inputKey: key, ...(await fn()) };
		putJson(path, value);
		return value;
	};
	const obsPathOf = (i) => join(o.obsRoot, i.set, i.name, "g5", "obs.npz");
	const truthFiles = (i) => ({ item: i, source: shaOrMissing(i.source), scene: shaOrMissing(i.scene), ...Object.fromEntries(["camera.json", "joints.json", "meta.json"].map((f) => [f, shaOrMissing(join(i.dir, i.variant, f))])) });
	const guard = (label, fn) => { try { return fn(); } catch (error) { log(`${label}: FAILED ${error.message}`); return { item: label, status: "failed", error: error.message }; } };

	const study2d = await stage("2d", { code: codeSha(), obsRoot: o.obsRoot, items: [...truthItems, ...skinItems].map((i) => ({ ...truthFiles(i), obs: shaOrMissing(obsPathOf(i)) })) }, () => {
		const items = [...truthItems, ...skinItems].map((item) => guard(`${item.set}/${item.name}`, () => { const r = studyItem(item, o.obsRoot); log(`2d ${item.set}/${item.name} (${item.variant}): ${r.status}${r.status === "ok" ? ` visible median ${r.visible.medianPx} px, swaps arms ${r.swaps.counts.arms} legs ${r.swaps.counts.legs}` : ` ${r.obsPath}`}`); return r; }));
		const perVariant = {}, pooledPerJoint = {};
		for (const variant of ["shaded", "skin"]) {
			const ok = items.filter((r) => r.variant === variant && r.status === "ok");
			const all = items.filter((r) => r.variant === variant);
			perVariant[variant] = { items: all.length, itemsOk: ok.length, deltaPx: round(percentile(ok.flatMap((r) => r.raw.visibleBest), 50), 3), visibleIdentityMedianPx: round(percentile(ok.flatMap((r) => r.raw.visibleIdentity), 50), 3) };
			pooledPerJoint[variant] = Object.fromEntries(COCO_NAMES.filter((_, k) => BODY_KEYPOINTS.includes(k)).map((name) => {
				// Pooled as the median over items of each item's median / p95 (items weigh equally).
				const vis = ok.map((r) => r.perJoint[name].visible.medianPx).filter(Number.isFinite), occ = ok.map((r) => r.perJoint[name].occluded.medianPx).filter(Number.isFinite);
				const visP = ok.map((r) => r.perJoint[name].visible.p95Px).filter(Number.isFinite), occP = ok.map((r) => r.perJoint[name].occluded.p95Px).filter(Number.isFinite);
				return [name, { visible: { medianPx: round(percentile(vis, 50), 2), p95Px: round(percentile(visP, 50), 2), items: vis.length }, occluded: { medianPx: round(percentile(occ, 50), 2), p95Px: round(percentile(occP, 50), 2), n: ok.reduce((s, r) => s + r.perJoint[name].occluded.n, 0) } }];
			}));
		}
		const walk = items.find((r) => r.item === "gt/walk" && r.status === "ok");
		const walkFrames = walk ? [...new Set([...walk.swaps.frames.arms, ...walk.swaps.frames.legs])] : [];
		for (const r of items) delete r.raw;
		return {
			items, perVariant, pooledPerJoint,
			deltaNote: "Error of each visible body keypoint (COCO shoulders..ankles vs the rendered rig's Arm/ForeArm/Hand/UpLeg/Leg/Foot) under the per-frame, per-group L/R assignment the truth prefers; occluded = the truth joint lies behind a scene box along the camera ray. Face keypoints have no rig joint and are not scored. Per-joint pooled values are the median over items of each item's median / p95.",
			walkFlipWindow: walk ? { window: [18, 51], inside: walkFrames.filter((t) => t >= 18 && t <= 51).length, outside: walkFrames.filter((t) => t < 18 || t > 51).length, overlaps: walkFrames.some((t) => t >= 18 && t <= 51) } : null,
		};
	});

	const stance = await stage("stance", { code: codeSha(), baseline: o.baseline, items: truthItems.map((i) => ({ item: i, source: shaOrMissing(i.source), gbest: shaOrMissing(join(o.baseline, i.set, i.name, "Gbest", "motion.npz")) })) }, () => {
		const items = truthItems.map((item) => guard(`${item.set}/${item.name}`, () => { const r = stanceItem(item, o.baseline); log(`stance ${r.item}: ${r.status} truth ${r.truth?.cmPerS} Gbest ${r.gbest?.cmPerS} cm/s`); return r; }));
		const ok = items.filter((r) => r.status === "ok");
		return { baseline: o.baseline, rule: ok[0]?.rule ?? null, items, mean: { truthCmPerS: round(mean(ok.map((r) => r.truth.cmPerS))), gbestCmPerS: round(mean(ok.map((r) => r.gbest.cmPerS))), items: ok.length } };
	});

	const ceiling = await stage("ceiling", { code: codeSha(), out: o.out, items: truthItems.map((i) => ({ ...ceilingInputs(i), skin: ["camera.json", "joints.json"].map((f) => shaOrMissing(join(i.dir, "skin", f))) })) }, () => {
		const items = truthItems.map((item) => guard(`${item.set}/${item.name}`, () => { log(`ceiling ${item.set}/${item.name}: scoring truth as prediction`); const r = ceilingItem(item, o.out, o); log(`ceiling ${r.item}: ${r.status} IoU raw ${r.maskIoURawMean}`); return r; }));
		// The skin renders use a byte-identical camera.json/joints.json and the shared mask/, so the score of the truth is the same: verified, not assumed.
		const skinSame = truthItems.map((item) => ({ item: `${item.set}/${item.name}`, same: ["camera.json", "joints.json"].every((f) => fileSha(join(item.dir, "shaded", f)) === fileSha(join(item.dir, "skin", f))) }));
		const perSet = {};
		for (const set of ["gt", "cube"]) {
			const ok = items.filter((r) => r.status === "ok" && r.item.startsWith(`${set}/`));
			const ious = ok.map((r) => r.maskIoURawMean);
			perSet[set] = { items: ok.length, meanIoURaw: round(mean(ious), 4), minIoURaw: round(Math.min(...ious), 4), is1Threshold: round(0.9 * mean(ious), 4) };
			if (skinSame.filter((s) => s.item.startsWith(`${set}/`)).every((s) => s.same)) perSet[`${SKIN_SET[set]}`] = { ...perSet[set], derivedFrom: set };
		}
		const exp3 = items.filter((r) => r.item.startsWith("cube/")).map((r) => {
			const path = join(dirname(dirname(truthItems.find((i) => `${i.set}/${i.name}` === r.item).dir)), "gt-path", "gt-self", "shaded", r.item.split("/")[1], "score.json");
			return existsSync(path) ? { item: r.item, exp3GtSelf: path, maskIoURawMean: readJson(path).overlap.maskIoURawMean } : { item: r.item, exp3GtSelf: null };
		});
		return {
			items, perSet, skinSame, exp3CrossCheck: exp3,
			skinNote: `Skin ceiling: camera.json and joints.json are byte-identical between shaded and skin for ${skinSame.filter((s) => s.same).length}/${skinSame.length} items and both score against the shared mask/, so the truth-as-prediction score of the skin variant equals the shaded one (gt-skin/cube-skin rows are derived, not re-rendered).`,
		};
	});

	const cameraVideos = [...falItems.map((i) => [i.video, join(i.dir, i.variant, "camera.json")]), ...truthItems.map((i) => [join(i.dir, i.variant, "video.mp4"), join(i.dir, i.variant, "camera.json")])];
	const camera = await stage("camera", { code: codeSha(), fal: falItems.map((i) => i.name), controls: truthItems.map((i) => `${i.set}/${i.name}`), files: cameraVideos.map(([v, c]) => [v, shaOrMissing(v), shaOrMissing(c)]) }, () => {
		const probe = (label, video, width, height) => guard(label, () => { const t0 = Date.now(); const r = cameraProbe(label, video, width, height, log); log(`camera ${label}: median ${r.medianShiftPx} px, max ${r.maxShiftPx} px (${((Date.now() - t0) / 1000).toFixed(1)} s)`); return { status: "ok", ...r }; });
		const clips = falItems.map((item) => { const cam = readJson(join(item.dir, item.variant, "camera.json")); return probe(item.name, item.video, cam.width, cam.height); });
		const controls = truthItems.filter((i) => ["gt/walk", "cube/bump"].includes(`${i.set}/${i.name}`)).map((item) => { const cam = readJson(join(item.dir, item.variant, "camera.json")); return probe(`${item.set}/${item.name} (${item.variant} truth render, static camera)`, join(item.dir, item.variant, "video.mp4"), cam.width, cam.height); });
		const ok = clips.filter((c) => c.status === "ok"), thresholdPx = 1;
		const worst = ok.reduce((w, c) => (!w || c.medianShiftPx > w.medianShiftPx ? c : w), null);
		return {
			method: "frame 0 border band (pixels within 10 % of the width of any image edge; the person is mostly inside) split into 32 px tiles, keeping tiles whose structure-tensor min eigenvalue >= 2 grey^2 (no flat sky/floor, no single edges); per frame t each tile's translation vs frame 0 by SSD block matching (+-12 px, half-res coarse then full-res +-2 px with parabolic sub-pixel fit) refined by Lucas-Kanade; the per-frame shift is the median tile shift magnitude (the moving person is a minority of the tiles). Per clip: median / p95 / max over frames 1..T-1. Controls are truth renders with a known static camera.",
			thresholdPx, cameraFixed: ok.length === falItems.length && ok.length > 0 && ok.every((c) => c.medianShiftPx < thresholdPx), clipsOk: ok.length, clipsTotal: falItems.length,
			worst: worst ? { clip: worst.clip, medianShiftPx: worst.medianShiftPx } : null, clips, controls,
		};
	});

	const shadedSetOf = { "gt-skin": "gt", "cube-skin": "cube" };
	const skinInputs = {
		code: codeSha(["tools/bench/obs-bench.mjs"]), approvedSkin: shaOrMissing(o.approvedSkin), approved: sha256(approvedBytes), obsRoot: o.obsRoot,
		items: skinItems.map((i) => ({ item: i, ...Object.fromEntries(["obs.npz", "manifest.json"].map((f) => [f, shaOrMissing(join(o.obsRoot, i.set, i.name, "g5", f))])), skinVideo: shaOrMissing(join(i.dir, "skin", "video.mp4")), shadedVideo: shaOrMissing(join(i.dir, "shaded", "video.mp4")), shadedObs: shaOrMissing(join(o.obsRoot, shadedSetOf[i.set] ?? "-", i.name, "g5", "obs.npz")) })),
		handoff: o.handoff ? { dir: o.handoff, files: skinItems.map((i) => ["bench.log", "obs-mannequin/manifest.json", "G5/result.json", "G5/score/score.json"].map((f) => shaOrMissing(join(o.handoff, i.set, i.name, f)))) } : null,
	};
	// (e) imports obs-bench (three/FBXLoader) only when the stage runs.
	const skinSummary = await stage("skin", skinInputs, async () => {
		if (!skinApproved) throw new Error(`${o.approvedSkin} does not exist (use --write-approved-skin)`);
		const { selectItems, itemInputs } = await import("../bench/obs-bench.mjs");
		const selected = selectItems(skinApproved);
		const result = {
			approvedSkin: {
				path: o.approvedSkin, items: selected.length, sets: [...new Set(selected.map((i) => i.set))],
				selectItemsOk: selected.every((i) => itemInputs(i, "/unused").detector === "yolo" && itemInputs(i, "/unused").video === join(i.dir, "skin", "video.mp4")),
				matchesGenerator: JSON.stringify(skinApproved.items) === JSON.stringify(generated.items),
			},
			provenance: skinItems.map((item) => guard(`${item.set}/${item.name}`, () => skinProvenance(item, o.obsRoot, shadedSetOf[item.set]))),
			handoff: o.handoff ? skinItems.map((item) => guard(`${item.set}/${item.name}`, () => handoffCheck(item, o.handoff, o.obsRoot))) : null,
			handoffRun: o.handoff ?? null,
		};
		for (const r of result.provenance) log(`skin provenance ${r.item}: ${r.status}`);
		for (const r of result.handoff ?? []) log(`skin handoff ${r.item}: ${r.status}`);
		return result;
	});

	const summary = {
		tool: "tools/track/study-2d.mjs", createdAt: new Date().toISOString(), commit: commitId(),
		inputs: { approved: o.approved, approvedSkin: o.approvedSkin, obsRoot: o.obsRoot, baseline: o.baseline },
		deltaPx: study2d?.perVariant?.shaded?.deltaPx ?? null,
		cameraFixed: camera?.cameraFixed ?? null,
		study2d, stance, iouCeiling: ceiling, camera, skin: skinSummary,
	};
	putJson(join(o.out, "summary.json"), summary);
	writeFileSync(join(o.out, "summary.md"), markdown(summary));
	log(`wrote ${join(o.out, "summary.json")} and summary.md`);
	const failed = [
		...[["2d", study2d?.items], ["stance", stance?.items], ["ceiling", ceiling?.items], ["camera", camera?.clips], ["camera", camera?.controls], ["skin-provenance", skinSummary?.provenance], ["skin-handoff", skinSummary?.handoff]]
			.flatMap(([name, rows]) => (rows ?? []).filter((r) => r.status !== "ok").map((r) => ({ stage: name, item: r.item ?? r.clip, status: r.status }))),
		...(skinSummary && !(skinSummary.approvedSkin?.selectItemsOk && skinSummary.approvedSkin?.matchesGenerator) ? [{ stage: "skin", item: o.approvedSkin, status: "bad-approved-skin" }] : []),
	];
	if (failed.length) console.error(`[study-2d] ${failed.length} item(s) not ok: ${failed.map((r) => `${r.stage}:${r.item}=${r.status}`).join(", ")}`);
	return { summary, failed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().then((result) => { if (result?.failed.length) process.exitCode = 1; }, (error) => { console.error(`study-2d: ${error.stack ?? error}`); process.exitCode = 1; });
}
