/**
 * edit.mjs — regenerate one span of an existing take with Kimodo.
 *
 * ARDY does this by feeding the surrounding motion in as autoregressive
 * history. Kimodo has no history input, so the same intent is expressed with the
 * constraint protocol it does have: the span is regenerated as part of a whole
 * clip that is PINNED to the original take on both sides of the edit, and only
 * the edited span is kept.
 *
 *   frames <  start   anchored to the source  -> the take rejoins what came before
 *   frames in [start,end)  free, except the author's own IK keyframes
 *   frames >= end     anchored to the source  -> the take rejoins what comes after
 *
 * Anchors are ordinary `fullbody` constraints built by pose-constraints.mjs, the
 * same ones pose pinning uses and which measured 0.00 deg tracking, so the joins
 * are as tight as a pinned pose rather than a blend.
 *
 * The result is spliced back with replaceMotionSegment: everything outside the
 * edited range is copied from the source byte for byte, because the author
 * changed one span and expects the rest of their take untouched.
 *
 * ROUND 2 (contract C5) — THE AUTHOR'S KEYS MAY BE EFFECTOR-SCOPED
 * ---------------------------------------------------------------
 * A `fullbody` key freezes all 77 joints at that frame. For an ANCHOR that is the
 * point: the frame is context we want held exactly. For the author's own key it is
 * the bug C5 exists to remove — dragging one hand should move the arm, not weld
 * the legs, the spine and the head to a pose the user never authored.
 *
 * So planEditConstraints splits the two kinds of frame:
 *
 *   anchors            -> ALWAYS fullbody, in every mode
 *   author keyframes   -> end-effector constraints IFF every edited track in the
 *                         manifest maps to a limb chain, else fullbody
 *
 * "EVERY track" is the condition, not "any": the manifest's tracks describe ONE
 * authored pose per frame, and an edit that also moved the spine or the head has
 * no effector to carry those bones — emitting hand constraints for it would
 * silently drop half the user's edit. Mixed or non-effector track lists therefore
 * keep round 1's behaviour wholesale, and the chosen mode is REPORTED
 * (`constraintMode`) rather than inferred, so the wrapper can log which pinning a
 * take actually got.
 *
 * A CAVEAT WORTH REPEATING AT THE SWITCH (effector-constraints.mjs states it in
 * full): an EE constraint still pins root XZ, root height and heading at its
 * frames — Kimodo's EndEffectorConstraintSet appends them unconditionally and has
 * no flag to disable it. On an edit that is harmless by construction: every pose
 * here is either read back out of the source take or authored on top of it, so
 * the pinned root is the take's own root at that frame. It is NOT a free root.
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { buildEffectorConstraints, effectorTypeForTrack } from "./effector-constraints.mjs";
import { buildFullBodyConstraints } from "./pose-constraints.mjs";
import { readNpz } from "./read-npz.mjs";

/** How many source frames to pin on each side when the caller asks for context. */
const ANCHOR_SAMPLES = 3;

/**
 * Read the bridge's edit-manifest.json into a resolved plan.
 * Paths inside it are relative to the manifest, which is what the bridge writes.
 */
export function parseEditManifest(manifestPath) {
	const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
	const base = dirname(resolve(manifestPath));

	if (!Number.isInteger(raw.start_frame) || raw.start_frame < 0) {
		throw new Error(`parseEditManifest: start_frame must be a non-negative integer, got ${JSON.stringify(raw.start_frame)}`);
	}
	if (!Number.isInteger(raw.end_frame)) {
		throw new Error(`parseEditManifest: end_frame must be an integer, got ${JSON.stringify(raw.end_frame)}`);
	}
	if (raw.end_frame <= raw.start_frame) {
		throw new Error(`parseEditManifest: range ${raw.start_frame}..${raw.end_frame} is empty or inverted`);
	}
	if (!Array.isArray(raw.edits) || raw.edits.length === 0) {
		throw new Error("parseEditManifest: edits must be a non-empty array");
	}

	let previous = -1;
	const edits = raw.edits.map((entry, index) => {
		if (!entry || typeof entry !== "object") {
			throw new Error(`parseEditManifest: edits[${index}] must be an object`);
		}
		if (!Number.isInteger(entry.frame)) {
			throw new Error(`parseEditManifest: edits[${index}].frame must be an integer`);
		}
		if (entry.frame < raw.start_frame || entry.frame >= raw.end_frame) {
			throw new Error(
				`parseEditManifest: edits[${index}].frame ${entry.frame} is outside the edited range ${raw.start_frame}..${raw.end_frame}`
			);
		}
		if (entry.frame <= previous) {
			throw new Error(
				`parseEditManifest: edit frames must be strictly ascending; edits[${index}].frame ${entry.frame} follows ${previous}`
			);
		}
		previous = entry.frame;
		if (typeof entry.pose_path !== "string" || !entry.pose_path) {
			throw new Error(`parseEditManifest: edits[${index}].pose_path is required`);
		}
		return {
			frame: entry.frame,
			tracks: Array.isArray(entry.tracks) ? entry.tracks : [],
			posePath: isAbsolute(entry.pose_path) ? entry.pose_path : resolve(base, entry.pose_path),
		};
	});

	return { startFrame: raw.start_frame, endFrame: raw.end_frame, edits };
}

/** One frame of a cclay motion npz as the {local_rot_mats, posed_joints} a pose wants. */
function frameAsPose(members, frame) {
	const rot = members.local_rot_mats;
	const pos = members.posed_joints;
	const joints = rot.shape.at(-3);
	if (joints !== 27) throw new Error(`planEditConstraints: source motion has ${joints} joints, expected 27`);
	const local_rot_mats = [];
	const posed_joints = [];
	for (let j = 0; j < 27; j += 1) {
		const b = (frame * 27 + j) * 9;
		local_rot_mats.push([
			[rot.data[b], rot.data[b + 1], rot.data[b + 2]],
			[rot.data[b + 3], rot.data[b + 4], rot.data[b + 5]],
			[rot.data[b + 6], rot.data[b + 7], rot.data[b + 8]],
		]);
		const p = (frame * 27 + j) * 3;
		posed_joints.push([pos.data[p], pos.data[p + 1], pos.data[p + 2]]);
	}
	return { local_rot_mats, posed_joints };
}

/** A cclay pose npz (single keyframe) as the same shape. */
function poseFromNpz(path) {
	const members = readNpz(path);
	for (const key of ["local_rot_mats", "posed_joints"]) {
		if (!members[key]) throw new Error(`planEditConstraints: pose npz ${path} is missing ${key}`);
	}
	return frameAsPose(members, 0);
}

/**
 * Build the constraint set for an edit: the author's keyframes inside the range,
 * plus source anchors on both sides so the regenerated span rejoins the take.
 *
 * `poses` are the same pins in APP frame space, which is what generateOnBox
 * takes; `constraints` is the already-scaled Kimodo form, used by the tests and
 * for reporting how many frames ended up pinned.
 *
 * @returns {{constraints:Array<object>, poses:Array<object>, startFrame:number, endFrame:number, sourceFrames:number, fps:number}}
 */
export function planEditConstraints({ sourcePath, manifestPath, contextBefore = 0, contextAfter = 0, genFps = 30, appFps = 24 }) {
	const manifest = parseEditManifest(manifestPath);
	const source = readNpz(sourcePath);
	if (!source.local_rot_mats || !source.posed_joints) {
		throw new Error(`planEditConstraints: ${sourcePath} is not a cclay motion npz`);
	}
	const sourceFrames = source.local_rot_mats.shape[0];
	const fps = source.fps ? Math.round(source.fps.data[0]) : appFps;
	if (manifest.endFrame > sourceFrames) {
		throw new Error(
			`planEditConstraints: edited range ends at ${manifest.endFrame} but the source has ${sourceFrames} frames`
		);
	}

	// Anchor frames: the last few source frames before the range and the first
	// few at/after it. Sampling several rather than one gives the model a
	// direction to rejoin on, not just a point.
	const anchors = [];
	if (contextBefore > 0) {
		const from = Math.max(0, manifest.startFrame - contextBefore);
		const step = Math.max(1, Math.floor((manifest.startFrame - from) / ANCHOR_SAMPLES) || 1);
		for (let f = from; f < manifest.startFrame; f += step) anchors.push(f);
	}
	if (contextAfter > 0) {
		const to = Math.min(sourceFrames - 1, manifest.endFrame + contextAfter - 1);
		const step = Math.max(1, Math.floor((to - manifest.endFrame) / ANCHOR_SAMPLES) || 1);
		for (let f = manifest.endFrame; f <= to; f += step) anchors.push(f);
	}

	// Author keyframes win over an anchor on the same frame: the whole point of
	// the edit is that those frames changed. `kind` rides along because round 2
	// constrains the two differently — and this map is what GUARANTEES a frame can
	// never carry both an anchor and an author key, i.e. never both a fullbody
	// anchor and an EE edit.
	const byFrame = new Map();
	for (const frame of anchors) {
		if (frame < 0 || frame >= sourceFrames) continue;
		byFrame.set(frame, { frame, kind: "anchor", pose: frameAsPose(source, frame) });
	}
	for (const edit of manifest.edits) {
		byFrame.set(edit.frame, { frame: edit.frame, kind: "edit", pose: poseFromNpz(edit.posePath) });
	}
	const poses = [...byFrame.values()].sort((a, b) => a.frame - b.frame);

	// C5's switch, decided from the MANIFEST rather than from the surviving poses:
	// an author key that lost its slot to app->gen frame rounding still describes
	// what the user edited. EVERY edited track must map to a limb chain (see the
	// header); an edit that names no tracks at all cannot claim one, so it is
	// fullbody.
	const editedTracks = [];
	let allEffector = manifest.edits.length > 0;
	for (const edit of manifest.edits) {
		if (edit.tracks.length === 0) allEffector = false;
		for (const track of edit.tracks) {
			if (effectorTypeForTrack(track) === null) allEffector = false;
			if (!editedTracks.includes(track)) editedTracks.push(track);
		}
	}
	const constraintMode = allEffector ? "effector" : "fullbody";

	// The clip Kimodo generates runs at genFps; the manifest speaks in app frames.
	// ONE scaling pass over the merged, sorted list, so the gen-frame dedup stays
	// SHARED: two source frames that round onto the same generation frame keep the
	// earlier one whatever kind it is, and an anchor and an author key can never
	// both survive onto one frame in two different constraint entries.
	const scale = genFps / appFps;
	const genFrames = Math.max(1, Math.round(sourceFrames * scale));
	const scaled = [];
	const seen = new Set();
	for (const entry of poses) {
		const genFrame = Math.min(genFrames - 1, Math.max(0, Math.round(entry.frame * scale)));
		if (seen.has(genFrame)) continue;
		seen.add(genFrame);
		scaled.push({ frame: genFrame, kind: entry.kind, pose: entry.pose });
	}

	// fullbody mode is round 1 unchanged: ONE entry over every frame, anchors and
	// author keys alike. Effector mode splits them — the anchors stay fullbody
	// (they are context to hold exactly), the author's keys become one entry per
	// distinct effector chain, over the edited frames only.
	let constraints;
	if (constraintMode === "effector") {
		const anchorPoses = scaled.filter((entry) => entry.kind === "anchor");
		const editPoses = scaled.filter((entry) => entry.kind === "edit");
		constraints = [
			...buildFullBodyConstraints(anchorPoses, { genFrames }),
			...buildEffectorConstraints(editPoses, { genFrames, tracks: editedTracks }),
		];
	} else {
		constraints = buildFullBodyConstraints(scaled, { genFrames });
	}

	return {
		constraints,
		// Which pinning the AUTHOR's keyframes got ("effector" | "fullbody"), and
		// the tracks that decided it. Reported rather than re-derived downstream:
		// run-edit-on-box logs it and the tests assert it.
		constraintMode,
		editedTracks,
		poses,
		startFrame: manifest.startFrame,
		endFrame: manifest.endFrame,
		sourceFrames,
		fps,
		genFrames,
	};
}
