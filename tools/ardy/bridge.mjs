#!/usr/bin/env node
/**
 * bridge.mjs - dev-only HTTP sidecar that drives the motion-generation loop
 * for the CozyClay SPA.
 *
 * CozyClay stays a static SPA: `vite build` emits a dist/ that needs no
 * server. The box work (pose -> npz -> remote constrained generation) cannot
 * run in a browser, so this sidecar exposes it on 127.0.0.1:5181 and the Vite
 * dev server proxies /ardy to it. The sidecar is OPTIONAL: when it is not
 * running the app behaves exactly as before, with the generate affordance
 * unavailable. The production build never depends on it.
 *
 * The heavy lifting is done by the Kimodo runner (tools/kimodo/runner.mjs),
 * never reimplemented here. Pose conversion, validation, streaming and motion
 * delivery remain backend-neutral so the browser contract stays stable.
 *
 * Security posture (detailed in BRIDGE.md):
 *  - binds 127.0.0.1 only;
 *  - every child is spawn()ed with an argv ARRAY; request data never reaches
 *    a shell string (the only remote shell strings are built from the box's
 *    own listing, regex-whitelisted, or from operator env vars);
 *  - every request field is validated before use: prompt length-capped,
 *    duration/dstFrame range-checked, base matched against the list the box
 *    actually reported, waypoints bounds/order-checked, body size-capped;
 *    preserve object/range-checked against the clip and refused alongside the
 *    modes it cannot mean anything with;
 *    posePin boolean-checked (default true = full-body pose constraint;
 *    false = path/prompt only, pose ignored, base optional - with waypoints
 *    and no base the box free-generates the base clip first, two-pass);
 *  - generated npz files are served back through an in-memory allowlist
 *    populated only after this process generated and verified the file; a
 *    path is never accepted from the URL;
 *  - a client disconnect kills the detached child process group instead of
 *    orphaning an ssh session.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeMotionNpz } from "../../src/ardy/npz.js";
import { motionArraysToNpzMembers, replaceMotionSegment, writeNpz } from "./npz.mjs";
import { globalChildren, killGroup, runStreaming, track } from "./runners/proc.mjs";
import { createRunner } from "./runners/index.mjs";
import { DURATION_MAX, DURATION_MIN, PROMPT_MAX_CHARS } from "./prompt-limits.mjs";
import { footagePath, handleFootage, serveFootage } from "./footage.mjs";
import { handleExtract } from "./extract.mjs";
import { createPrivateArtifactDir, evictPrivateArtifact, removePrivateArtifactDir } from "./artifacts.mjs";
// The IK track ids a preserve edit range may scope itself to. Imported rather
// than restated: tools/kimodo/preserve-mask.mjs is the single source of truth
// for track -> mask-group, and a list copied here would drift the first time a
// track is added. The module is pure (no side effects on import).
import { TRACK_GROUPS } from "../kimodo/preserve-mask.mjs";
// Line editing (contract C6). The projflow modules are imported DIRECTLY, not
// spawned: the runner's lineEditCommand produces raw 22-joint positions, and a
// take is only finished after the cskel27 lift, the 20 -> 24 retime and the
// splice — all of which are pure functions over files this process already
// holds. Running them in a child would mean a second argv contract and a second
// copy of the frame arithmetic for no isolation gain, so the composition layer
// is imported the way handleExtract already is, and the only child process on
// this path is the ssh inside lineEditOnBox.
import { createProjflowRunner } from "../projflow/runner.mjs";
import { runLineEditJob } from "../projflow/line-edit-job.mjs";
// Recipe replay (contract C10) and, with it, the per-field line-edit rules that
// BOTH the C6 request and every C10 entry are checked against. They live in
// tools/projflow/replay.mjs rather than here because a replay is pure
// arithmetic over an injectable job runner, and the whole contract has to be
// verifiable on a laptop with no GPU and no sidecar.
import { blockBoundaries, runReplay, validateLineEditFields, validateReplay } from "../projflow/replay.mjs";
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const OUT_DIR = join(HERE, "out");
const POSE_TO_NPZ = join(HERE, "pose-to-npz.mjs");

const BIND_HOST = "127.0.0.1"; // loopback only: this process shells out
const DEFAULT_PORT = 5181;
const HEALTH_TTL_MS = 5000; // the UI polls health; a cached answer avoids hammering ssh
const BASES_TTL_MS = 120000; // the box's motion list changes rarely
const MAX_BODY_BYTES = 1024 * 1024;
const SEED_MAX = 2 ** 31 - 1; // optional request seed: an integer in 0..2**31-1 (bridge contract)
// Kimodo is retimed directly to the app's 24 fps production clock.
const FPS = 24;
const ROOT_2D_RANGE_M = 20; // |x| and |z| cap, metres (Y-up, X/Z horizontal)
const HEADING_RANGE_RAD = 2 * Math.PI; // |heading| cap, radians
const WAYPOINTS_MAX = 32; // sparse authored root keys including frame 0
const WAYPOINT_SPEED_MIN_MPS = 0.3; // dense-sample gait floor (authored floor 0.5, arcs dip through corners)
const WAYPOINT_SPEED_MAX_MPS = 3.6; // dense-sample ceiling (authored ceiling 3.0)
const WAYPOINT_HOLD_EPS_M = 0.06; // pairs closer than this are a deliberate hold, any duration
const MOTION_ALLOWLIST_MAX = 64; // newest runs only; evicted ids become stale 404s
// The bridge's own gen stamp (<epoch-ms>-<3 random bytes hex>); keeping the
// motions URL id to that shape keeps /ardy/motions/<run-id> predictable and
// path-free (the id is a lookup key, never a path).
const MOTION_ID = /^[0-9]+-[0-9a-f]{6}$/;
// The same id embedded in the URL a client hands back to address a take it was
// given. Every field that names an earlier take (motionEdit.sourceMotion,
// regenerateSegments' sourceMotion, preserve.sourceMotion) matches THIS, so a
// take that is addressable by one of them is addressable by all of them.
const MOTION_URL = /^\/ardy\/motions\/[0-9]+-[0-9a-f]{6}$/;
// Scheduled inpainting, contract C3: strength s in (0,1] maps to the diffusion
// -time schedule the box blends over. sigma_s is where blending starts (high
// noise, so the base's structure dominates) and sigma_e where the model is
// left alone to finish; the end cap generalises the paper's recommended
// 500/50 pair to any strength.
const PRESERVE_SIGMA_MAX = 1000;
const PRESERVE_SIGMA_END_CAP = 50;
// Round 2 (C3v2): an edit range may name the IK tracks it touched, and only the
// mask groups those tracks map to are freed there. The valid ids are exactly the
// keys of the mask builder's own table.
const PRESERVE_TRACK_IDS = Object.keys(TRACK_GROUPS);
// C6's per-field rules (track ids, points2d, camera, frameRange) now live in
// tools/projflow/replay.mjs: contract C10 validates every replay entry with the
// SAME rules, and two copies of them would drift on the first joint-mapping
// change. Only the rules a line edit does not share with a replay entry —
// exclusivity, posePin, sourceMotion, preview — are still spelled out below.
//
// Every field a line edit is exclusive with (contract C6: a line edit is its own
// run mode). `poses`/`pose` are in the list because posePin defaults to true and
// a line edit authors no poses at all.
const LINE_EDIT_EXCLUSIVE = ["preserve", "waypoints", "segments", "regenerateSegments", "motionEdit", "poses", "pose"];

// The runner is the ONLY part of the bridge that knows where generation
// actually happens. Selection (runners/index.mjs) is Kimodo-only; everything
// below that boundary — validation, caching, streaming and the motion
// allowlist — is backend-agnostic.
let runner; // assigned after CLI parsing, before the server starts

// ...with ONE exception, and it is deliberate: line editing is an
// ENGINE-PER-TASK (contract C6). A lineEdit request always runs on ProjFlow
// whatever CCLAY_MOTION_BACKEND says, so this second runner exists beside the
// selected one instead of replacing it. Construction only reads env — the box
// is not touched until something probes or runs — and a box with no ProjFlow
// configuration leaves it null, which reads as "the capability is off".
let projflowRunner = null; // assigned beside `runner`

// A base path is produced by the backend's own `ls outputs/*.npz` /
// `ls outputs/omb/*.npz` and is still whitelisted before it is embedded in a
// remote shell string: only a plain, metacharacter-free relative npz path is
// ever allowed through.
const SAFE_BASE_PATH = /^outputs\/(?:omb\/)?[A-Za-z0-9._-]+\.npz$/;
const SAFE_BASE_ID = /^[A-Za-z0-9._-]+$/;

// ---------------------------------------------------------------------------
// backend probes (health, bases) with caching
// ---------------------------------------------------------------------------

// The raw listing comes from the runner (a box's `ls outputs/*.npz` over ssh,
// or a local directory scan); the bridge sanitizes every entry the same way
// regardless of backend before anything downstream can see it.
async function fetchBases() {
	const entries = await runner.listBases();
	const bases = [];
	for (const entry of entries) {
		if (
			!entry ||
			typeof entry !== "object" ||
			typeof entry.id !== "string" ||
			typeof entry.path !== "string" ||
			!Number.isInteger(entry.frames) ||
			entry.frames < 0
		) {
			console.error(`[bridge] skipping malformed bases entry: ${JSON.stringify(entry)}`);
			continue;
		}
		if (!SAFE_BASE_ID.test(entry.id) || !SAFE_BASE_PATH.test(entry.path)) {
			console.error(`[bridge] skipping unsafe bases entry: ${JSON.stringify(entry)}`);
			continue;
		}
		bases.push({ id: entry.id, path: entry.path, frames: entry.frames });
	}
	// Duplicate ids (same name under outputs/ and outputs/omb/) are kept as-is;
	// generate matches the first, which is exactly the lookup order the
	// generation path uses, so the two cannot pick different files.
	return { bases };
}

let healthCache = null;
let healthInflight = null;

// Successes AND failures are cached for the TTL so a dead box does not turn
// the UI's health polling into an ssh stampede.
async function getHealth() {
	const now = Date.now();
	if (healthCache && now - healthCache.at < HEALTH_TTL_MS) {
		if (healthCache.error) throw healthCache.error;
		return healthCache.value;
	}
	if (!healthInflight) {
		healthInflight = runner.probeHealth()
			.then((value) => {
				healthCache = { at: Date.now(), value };
				return value;
			})
			.catch((err) => {
				healthCache = { at: Date.now(), error: err };
				throw err;
			})
			.finally(() => {
				healthInflight = null;
			});
	}
	return healthInflight;
}

// Does this box actually have a ProjFlow line-edit backend?
//
// LAZY AND AWAITED, not probed at startup. The app gates the whole draw-a-line
// affordance on `capabilities.lineEdit` in the health payload, so a startup
// probe would have to finish before the first poll or the feature would be dark
// on a perfectly good box until the next one — a race with a UI. Health already
// awaits an ssh round trip for the selected backend; this one rides along beside
// it under the same 5 s TTL, and the two probes run in parallel so a healthy box
// costs no extra wall time.
//
// A FAILED probe is never an error here, only a false: the capability is an
// advertisement, and a bridge whose ProjFlow env is missing must still serve
// Kimodo health normally. That is also the "a box without the scout env must not
// advertise" rule — no host, no repo, no checkpoint, or an ssh that cannot
// connect all land in the same catch.
let lineEditCapabilityCache = null;
let lineEditCapabilityInflight = null;

async function getLineEditCapability() {
	if (!projflowRunner) return false;
	const now = Date.now();
	if (lineEditCapabilityCache && now - lineEditCapabilityCache.at < HEALTH_TTL_MS) {
		return lineEditCapabilityCache.value;
	}
	if (!lineEditCapabilityInflight) {
		lineEditCapabilityInflight = projflowRunner.probeHealth()
			.then((probe) => Boolean(probe?.ok))
			.catch((err) => {
				console.error(`[bridge] line editing unavailable: ${err.message}`);
				return false;
			})
			.then((value) => {
				lineEditCapabilityCache = { at: Date.now(), value };
				return value;
			})
			.finally(() => {
				lineEditCapabilityInflight = null;
			});
	}
	return lineEditCapabilityInflight;
}

let basesCache = null;
let basesInflight = null;

async function getBases() {
	const now = Date.now();
	if (basesCache && now - basesCache.at < BASES_TTL_MS) {
		if (basesCache.error) throw basesCache.error;
		return basesCache.value;
	}
	if (!basesInflight) {
		basesInflight = fetchBases()
			.then((value) => {
				basesCache = { at: Date.now(), value };
				return value;
			})
			.catch((err) => {
				basesCache = { at: Date.now(), error: err };
				throw err;
			})
			.finally(() => {
				basesInflight = null;
			});
	}
	return basesInflight;
}

// ---------------------------------------------------------------------------
// request validation
// ---------------------------------------------------------------------------

// Returns an error message naming the offending field, or null when valid.
function validateGenerate(body) {
	if (!body || typeof body !== "object" || Array.isArray(body)) return "request body must be a JSON object";
	if (body.posePin !== undefined && typeof body.posePin !== "boolean") {
		return `field 'posePin' must be a boolean, got ${JSON.stringify(body.posePin)}`;
	}
	if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) return "field 'prompt' must be a non-empty string";
	if (body.prompt.length > PROMPT_MAX_CHARS) return `field 'prompt' is ${body.prompt.length} chars; the cap is ${PROMPT_MAX_CHARS}`;
	if (typeof body.duration !== "number" || !Number.isFinite(body.duration)) return `field 'duration' must be a finite number`;
	if (body.duration < DURATION_MIN || body.duration > DURATION_MAX) return `field 'duration' must be in ${DURATION_MIN}..${DURATION_MAX} seconds`;
	// Optional post-processing knobs, forwarded to the box generator.
	if (body.rootMargin !== undefined && (typeof body.rootMargin !== "number" || !Number.isFinite(body.rootMargin) || body.rootMargin < 0 || body.rootMargin > 1)) return `field 'rootMargin' must be a number in 0..1 (meters)`;
	if (body.contactThreshold !== undefined && (typeof body.contactThreshold !== "number" || !Number.isFinite(body.contactThreshold) || body.contactThreshold < 0 || body.contactThreshold > 1)) return `field 'contactThreshold' must be a number in 0..1`;
	// Optional history crop (per autoregressive step), forwarded to the box
	// generators; the box enforces its own token-size multiple.
	if (body.historyFrames !== undefined && (!Number.isInteger(body.historyFrames) || body.historyFrames <= 0 || body.historyFrames > 400)) return `field 'historyFrames' must be an integer in 1..400`;
	const clipFrames = Math.floor(body.duration * FPS);
	if (clipFrames < 3) return `field 'duration' yields fewer than 3 frames`;

	// Checked BEFORE the pose block: a line edit carries no poses on purpose, so
	// the posePin rule below would refuse it with a message about a field the
	// client never sent. C6's own refusals have to win.
	if (body.lineEdit !== undefined) {
		const error = validateLineEdit(body, clipFrames);
		if (error) return error;
	}

	const posePinned = body.posePin !== false;
	if (posePinned) {
		const poses = body.motionEdit
			? body.motionEdit.edits
			: Array.isArray(body.poses)
				? body.poses
				: body.pose
					? [{ frame: body.dstFrame, pose: body.pose }]
					: null;
		if (!poses || poses.length === 0 || poses.length > 64) return `field 'poses' must have 1..64 entries when posePin is true`;
		let previous = -1;
		for (let i = 0; i < poses.length; i += 1) {
			const entry = poses[i];
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) return `field 'poses[${i}]' must be an object`;
			if (!Number.isInteger(entry.frame) || entry.frame < 0 || entry.frame >= clipFrames) return `field 'poses[${i}].frame' must be an integer in 0..${clipFrames - 1}`;
			if (entry.frame <= previous) return `field 'poses' frames must be strictly ascending and distinct`;
			previous = entry.frame;
			if (!entry.pose || typeof entry.pose !== "object" || Array.isArray(entry.pose)) return `field 'poses[${i}].pose' must be an object`;
		if (entry.pose.schema !== "cozyclay.pose.v1") return `field 'poses[${i}].pose.schema' must be "cozyclay.pose.v1"`;
			if (!Array.isArray(entry.pose.root) || entry.pose.root.length !== 3 || !entry.pose.root.every(Number.isFinite)) return `field 'poses[${i}].pose.root' must be [x, y, z] finite metres`;
		}
	}
	if (body.base !== undefined && (typeof body.base !== "string" || body.base.length === 0)) return "field 'base' must be a non-empty string";
	if (body.segments !== undefined) {
		const error = validateSegments(body.segments, clipFrames);
		if (error) return error;
		if (posePinned) return "field 'segments' uses autoregressive history and requires posePin:false";
		// segments + waypoints run TOGETHER on the sequence generator: the
		// Root2D constraint set is built over the whole rollout and each
		// chained call sees its own slice (the interactive demo's pattern).
		// The trained window then binds each segment call, not the total.
		// Kimodo owns the segment duration; no legacy trained-window cap applies.
	}
	if (body.regenerateSegments !== undefined) {
		const error = validateRegenerateSegments(body.regenerateSegments, clipFrames);
		if (error) return error;
		if (!posePinned) return "field 'regenerateSegments' requires posePin:true";
		if (body.segments !== undefined || body.waypoints !== undefined) {
			return "field 'regenerateSegments' cannot be combined with segments or waypoints";
		}
		if (typeof body.sourceMotion !== "string" || !MOTION_URL.test(body.sourceMotion)) {
			return "field 'sourceMotion' must be a generated /ardy/motions/<run-id> URL";
		}
	}
	if (body.motionEdit !== undefined) {
		const edit = body.motionEdit;
		if (!edit || typeof edit !== "object" || Array.isArray(edit)) return "field 'motionEdit' must be an object";
		if (!posePinned) return "field 'motionEdit' requires posePin:true";
		if (body.segments !== undefined || body.regenerateSegments !== undefined || body.waypoints !== undefined) {
			return "field 'motionEdit' cannot be combined with segments, regenerateSegments, or waypoints";
		}
		if (typeof edit.sourceMotion !== "string" || !MOTION_URL.test(edit.sourceMotion)) {
			return "field 'motionEdit.sourceMotion' must be a generated /ardy/motions/<run-id> URL";
		}
		if (
			!Number.isInteger(edit.startFrame) ||
			!Number.isInteger(edit.endFrame) ||
			edit.startFrame < 0 ||
			edit.endFrame > clipFrames ||
			edit.endFrame - edit.startFrame < 3
		) {
			return `field 'motionEdit' range must be 3+ frames inside 0..${clipFrames}`;
		}
		if (!Array.isArray(edit.edits) || edit.edits.length < 1 || edit.edits.length > 64) {
			return "field 'motionEdit.edits' must have 1..64 entries";
		}
		for (let index = 0; index < edit.edits.length; index += 1) {
			const entry = edit.edits[index];
			if (!Array.isArray(entry.tracks) || entry.tracks.length < 1 || entry.tracks.some((track) => typeof track !== "string")) {
				return `field 'motionEdit.edits[${index}].tracks' must contain track names`;
			}
		}
		for (const key of ["contextBefore", "contextAfter"]) {
			if (!Number.isInteger(edit[key]) || edit[key] < 0 || edit[key] > 160) {
				return `field 'motionEdit.${key}' must be an integer in 0..160`;
			}
		}
	}
	if (body.waypoints !== undefined) {
		const error = validateWaypoints(body.waypoints, clipFrames);
		if (error) return error;
	}
	if (body.preserve !== undefined) {
		const error = validatePreserve(body, clipFrames);
		if (error) return error;
	}
	// Recipe replay (contract C10): the line edits to re-apply once this request's
	// take exists. Validated LAST of the run-mode fields because it rides ON one —
	// a replay never chooses the take, it only refines whatever plain generation,
	// prompt schedule or preserved run produced.
	if (body.replay !== undefined) {
		const error = validateReplay(body, clipFrames, { seedMax: SEED_MAX });
		if (error) return error;
	}
	if (body.seed !== undefined && (!Number.isInteger(body.seed) || body.seed < 0 || body.seed > SEED_MAX)) return `field 'seed' must be an integer in 0..${SEED_MAX}`;
	if (body.cpu !== undefined && typeof body.cpu !== "boolean") return `field 'cpu' must be a boolean`;
	return null;
}

// Line editing (contract C6): the artist draws a 2D polyline over the viewport
// and ONE joint is made to follow it exactly.
//
// Style and posture match validatePreserve: one specific reason, the offending
// field named first, first failure wins, and nothing here computes anything the
// backend will compute again. In particular the 24 -> 20 fps conversion is NOT
// done here — tools/projflow/line-edit-job.mjs owns that clock, because it is
// also the layer that decides how long the resampled source is, and two places
// rounding the same frame index is how they drift. This validator's frame
// numbers are all on the app's 24 fps clip clock, exactly as sent.
//
// Returns an error message naming the offending field, or null when valid.
function validateLineEdit(body, clipFrames) {
	const lineEdit = body.lineEdit;
	if (!lineEdit || typeof lineEdit !== "object" || Array.isArray(lineEdit)) {
		return "field 'lineEdit' must be an object";
	}
	// Exclusivity first: a request that also carries a prompt schedule or a
	// preserved take is not a line edit with an extra field, it is two run modes
	// in one body, and guessing which one the artist meant is not the bridge's
	// call. C6 is named so the refusal is traceable to the contract.
	for (const field of LINE_EDIT_EXCLUSIVE) {
		if (body[field] !== undefined) {
			return `field 'lineEdit' cannot be combined with ${field}: contract C6 makes a line edit its own run mode`;
		}
	}
	// posePin defaults to TRUE, which demands a pose array. A line edit authors
	// no poses, so the client must say so explicitly rather than have the bridge
	// infer it — the same request without lineEdit would then mean something
	// completely different.
	if (body.posePin !== false) {
		return "field 'lineEdit' requires posePin:false (a line edit constrains one joint's path, not a pose)";
	}
	if (typeof lineEdit.sourceMotion !== "string" || !MOTION_URL.test(lineEdit.sourceMotion)) {
		return "field 'lineEdit.sourceMotion' must be a generated /ardy/motions/<run-id> URL";
	}
	// The 20-step draft the interactive loop asks for (contract C10's preview
	// flag). A BOOLEAN and nothing else: the step count itself is the job's, not
	// the client's, or a request could ask the box for a 10000-step sample.
	if (lineEdit.preview !== undefined && typeof lineEdit.preview !== "boolean") {
		return "field 'lineEdit.preview' must be a boolean when present";
	}
	// Everything else — track, frameRange, points2d, camera, prompt — is the
	// shared rule set a C10 replay entry is held to as well.
	return validateLineEditFields(lineEdit, clipFrames, "lineEdit");
}

function validateSegments(segments, clipFrames) {
	if (!Array.isArray(segments) || segments.length < 2 || segments.length > 64) return "field 'segments' must have 2..64 entries";
	let cursor = 0;
	for (let i = 0; i < segments.length; i += 1) {
		const segment = segments[i];
		if (!segment || typeof segment !== "object" || Array.isArray(segment)) return `field 'segments[${i}]' must be an object`;
		if (!Number.isInteger(segment.startFrame) || !Number.isInteger(segment.endFrame)) return `field 'segments[${i}]' frames must be integers`;
		if (segment.startFrame !== cursor || segment.endFrame <= segment.startFrame || segment.endFrame > clipFrames) return `field 'segments' must be contiguous from frame 0 through ${clipFrames}`;
		if (segment.endFrame - segment.startFrame < 3) return `field 'segments[${i}]' must contain at least 3 frames`;
		if (typeof segment.prompt !== "string" || !segment.prompt.trim() || segment.prompt.length > PROMPT_MAX_CHARS) return `field 'segments[${i}].prompt' must be 1..${PROMPT_MAX_CHARS} characters`;
		cursor = segment.endFrame;
	}
	return cursor === clipFrames ? null : `field 'segments' must end at frame ${clipFrames}`;
}

function validateRegenerateSegments(segments, clipFrames) {
	if (!Array.isArray(segments) || segments.length < 1 || segments.length > 64) {
		return "field 'regenerateSegments' must have 1..64 entries";
	}
	let previousEnd = -1;
	for (let i = 0; i < segments.length; i += 1) {
		const segment = segments[i];
		if (!segment || typeof segment !== "object" || Array.isArray(segment)) {
			return `field 'regenerateSegments[${i}]' must be an object`;
		}
		if (
			!Number.isInteger(segment.startFrame) ||
			!Number.isInteger(segment.endFrame) ||
			segment.startFrame < 0 ||
			segment.endFrame > clipFrames ||
			segment.endFrame - segment.startFrame < 4
		) {
			return `field 'regenerateSegments[${i}]' must be a 4+ frame range inside 0..${clipFrames}`;
		}
		if (segment.startFrame < previousEnd) {
			return "field 'regenerateSegments' must be sorted and non-overlapping";
		}
		if (typeof segment.prompt !== "string" || !segment.prompt.trim() || segment.prompt.length > PROMPT_MAX_CHARS) {
			return `field 'regenerateSegments[${i}].prompt' must be 1..${PROMPT_MAX_CHARS} characters`;
		}
		previousEnd = segment.endFrame;
	}
	return null;
}

// Scheduled inpainting (contract C3): reconstruct an existing take everywhere
// the user did NOT edit, and regenerate only the edited spans.
//
// The bridge validates the request and maps `strength` onto the diffusion-time
// schedule; it deliberately does NOT build the per-frame mask. That happens in
// tools/kimodo/generate.mjs, the only layer that knows how many frames Kimodo
// will actually produce (see preserveSigmas below and the note there).
//
// Returns an error message naming the offending field, or null when valid.
function validatePreserve(body, clipFrames) {
	const preserve = body.preserve;
	if (!preserve || typeof preserve !== "object" || Array.isArray(preserve)) {
		return "field 'preserve' must be an object";
	}
	if (typeof preserve.sourceMotion !== "string" || !MOTION_URL.test(preserve.sourceMotion)) {
		return "field 'preserve.sourceMotion' must be a generated /ardy/motions/<run-id> URL";
	}
	// 0 is not "preserve nothing", it is "do not preserve": the field carries a
	// base motion the backend would still load and blend at sigma_s 0. The
	// caller drops the whole field instead, so the request says what it means.
	if (
		typeof preserve.strength !== "number" ||
		!Number.isFinite(preserve.strength) ||
		preserve.strength <= 0 ||
		preserve.strength > 1
	) {
		return "field 'preserve.strength' must be a number greater than 0 and at most 1 (strength 0 is preserve off: omit 'preserve')";
	}
	if (!Array.isArray(preserve.editRanges)) {
		return "field 'preserve.editRanges' must be an array (an EMPTY array means preserve the whole take)";
	}
	for (let i = 0; i < preserve.editRanges.length; i += 1) {
		const range = preserve.editRanges[i];
		if (!range || typeof range !== "object" || Array.isArray(range)) {
			return `field 'preserve.editRanges[${i}]' must be an object`;
		}
		if (!Number.isInteger(range.startFrame) || !Number.isInteger(range.endFrame)) {
			return `field 'preserve.editRanges[${i}]' startFrame and endFrame must be integers`;
		}
		// Half-open, non-empty and inside the clip. That last bound is also what
		// makes every range intersect the clip: a range the take does not contain
		// cannot be scaled onto the generation clock without freeing frames at one
		// end that the user never edited, so the mask builder refuses it too.
		// Overlaps between ranges are NOT refused — the mask combines them by
		// minimum, so two overlapping edits mean the same thing as one.
		if (range.startFrame < 0 || range.endFrame <= range.startFrame || range.endFrame > clipFrames) {
			return `field 'preserve.editRanges[${i}]' must be a non-empty half-open range inside 0..${clipFrames}`;
		}
		// C3v2: an OPTIONAL `tracks` list scopes the range to the mask groups those
		// IK tracks map to (a hand edit frees the arm, not the body). Omitting the
		// key is the v1 whole-body edit.
		if (range.tracks !== undefined) {
			if (!Array.isArray(range.tracks)) {
				return `field 'preserve.editRanges[${i}].tracks' must be an array of IK track ids`;
			}
			// An EMPTY list is refused rather than read as either "whole body" or
			// "nothing": the two readings differ by the entire clip and the caller
			// meant one of them. Same rule, same wording as buildPreserveMask — a
			// request that got past here must never die inside the mask builder.
			if (range.tracks.length === 0) {
				return `field 'preserve.editRanges[${i}].tracks' is empty — omit the key entirely for a whole-body edit`;
			}
			for (let t = 0; t < range.tracks.length; t += 1) {
				const trackId = range.tracks[t];
				if (typeof trackId !== "string" || !Object.hasOwn(TRACK_GROUPS, trackId)) {
					return (
						`field 'preserve.editRanges[${i}].tracks[${t}]' ${JSON.stringify(trackId)} is not a known IK track id; ` +
						`valid ids are ${PRESERVE_TRACK_IDS.join(", ")}`
					);
				}
			}
		}
	}
	// Exclusivity. TWO fields are deliberately absent from this list:
	//
	//   `motionEdit` — an IK edit regenerates a span of the take preserve is
	//   reconstructing, which is exactly the combination scheduled inpainting
	//   exists for.
	//
	//   `waypoints` — ALLOWED since round 2 (contract C3v2, paper 4.4). Round 1
	//   refused it on the reasoning that an authored root path "re-plans the whole
	//   rollout, leaving nothing to preserve". That is true only of a mask that
	//   preserves the root: with the grouped mask of C1v2 the bridge frees the
	//   `root` group for the WHOLE clip (preserveParams.rootFree below) and keeps
	//   everything else, so the drawn path owns the trajectory and heading while
	//   the body still rides the preserved take — which is the feature. It stays
	//   SINGLE-SEGMENT: `segments` is still refused just below, so a preserve +
	//   waypoints run is always one prompt over one rollout.
	if (body.regenerateSegments !== undefined) {
		return "field 'preserve' cannot be combined with regenerateSegments: a regenerated block set replaces the take preserve would reconstruct";
	}
	// The box refuses this pairing too ("scheduled inpainting v1 supports a
	// single segment"), after loading a model and a base motion. Failing here
	// costs nothing and can name the version limit instead of a stack trace.
	if (body.segments !== undefined) {
		return "field 'preserve' cannot be combined with a prompt schedule: scheduled inpainting v1 supports a single segment";
	}
	return null;
}

// strength -> the (sigma_s, sigma_e) pair the backend blends between. This
// mapping is server-side by contract so a client never speaks in diffusion-time
// units. The mapping is INVERTED against sigma_s on purpose: alpha_time is 1
// ABOVE sigma_s and fades to 0 at sigma_e, so a SMALLER sigma_s keeps the base
// blended deeper into the low-noise steps and preserves more. Measured on the
// box (gate G3, all-ones mask, seed 5678): sigma_s 200 -> L2P 0.00455,
// 500 -> 0.00467, 800 -> 0.00480, 1000 -> 0.00487 — strictly looser as sigma_s
// rises. The first draft mapped strength straight onto sigma_s and made the
// slider work backwards. sigma_e is capped rather than scaled: below it the
// model must always be free to finish, or the take is frozen onto the base and
// the edit cannot happen. The floor at the cap keeps full strength a step
// schedule (blend until sigma_e) instead of rounding sigma_s to 0, which the
// backend reads as preserve fully off.
function preserveSigmas(strength) {
	const sigmaS = Math.max(PRESERVE_SIGMA_END_CAP, Math.round(PRESERVE_SIGMA_MAX * (1 - strength)));
	return { sigmaS, sigmaE: Math.min(PRESERVE_SIGMA_END_CAP, sigmaS) };
}

// Returns an error message naming the offending field, or null when valid.
// The fixed contract: 2..32 sparse {frame,x,z,heading} keys, starting at
// frame 0 with strictly ascending frames. The backend generates every
// in-between frame. x/z are finite metres in [-20,20], heading null or finite radians
// in [-2π,2π].
// Every rejection names 'waypoints' so the client can point at the offending
// entry.
function validateWaypoints(waypoints, clipFrames) {
	if (!Array.isArray(waypoints)) {
		return "field 'waypoints' must be an array";
	}
	if (waypoints.length < 2 || waypoints.length > WAYPOINTS_MAX) {
		return `field 'waypoints' must have 2..${WAYPOINTS_MAX} sparse entries, got ${waypoints.length}`;
	}
	let prevFrame = -1;
	for (let i = 0; i < waypoints.length; i += 1) {
		const wp = waypoints[i];
		if (!wp || typeof wp !== "object" || Array.isArray(wp)) {
			return `field 'waypoints[${i}]' must be an object`;
		}
		if (!Number.isInteger(wp.frame) || wp.frame < 0 || wp.frame >= clipFrames) {
			return `field 'waypoints[${i}].frame' must be an integer in 0..${clipFrames - 1}, got ${JSON.stringify(wp.frame)}`;
		}
		if (wp.frame <= prevFrame) {
			return `field 'waypoints' frames must be strictly ascending: frame ${wp.frame} duplicates or precedes frame ${prevFrame} (index ${i})`;
		}
		prevFrame = wp.frame;
		if (i === 0 && wp.frame !== 0) {
			return `field 'waypoints[0].frame' must be 0 (start + destination path), got ${wp.frame}`;
		}
		for (const axis of ["x", "z"]) {
			const value = wp[axis];
			if (typeof value !== "number" || !Number.isFinite(value)) {
				return `field 'waypoints[${i}].${axis}' must be a finite number, got ${JSON.stringify(value)}`;
			}
			if (value < -ROOT_2D_RANGE_M || value > ROOT_2D_RANGE_M) {
				return `field 'waypoints[${i}].${axis}' ${value} is outside -${ROOT_2D_RANGE_M}..${ROOT_2D_RANGE_M} meters`;
			}
		}
		if (!("heading" in wp) || wp.heading === undefined) {
			return `field 'waypoints[${i}].heading' is missing; must be null or a number of radians`;
		}
		if (wp.heading !== null) {
			if (typeof wp.heading !== "number" || !Number.isFinite(wp.heading)) {
				return `field 'waypoints[${i}].heading' must be null or a finite number of radians, got ${JSON.stringify(wp.heading)}`;
			}
			if (Math.abs(wp.heading) > HEADING_RANGE_RAD) {
				return `field 'waypoints[${i}].heading' ${wp.heading} rad is outside -2π..2π`;
			}
		}
	}
	// Root pins are inpainting observations the model cannot refuse, so a pin
	// pair demanding an inexpressible pace collapses the gait into
	// foot-sliding instead of erroring. The bands are wider than the authored
	// 0.5..3 m/s walk band because these are the dense C1 samples, which dip
	// through corners and pause dead in authored holds.
	// holdPair[i]: the pair ending at waypoint i is a deliberate hold.
	// Index 0 has no pair — false, so the first real leg gets no exemption.
	const holdPair = waypoints.map((wp, i) =>
		i === 0 ? false : Math.hypot(wp.x - waypoints[i - 1].x, wp.z - waypoints[i - 1].z) <= WAYPOINT_HOLD_EPS_M,
	);
	for (let i = 1; i < waypoints.length; i += 1) {
		if (holdPair[i]) continue; // a deliberate hold
		const prev = waypoints[i - 1];
		const wp = waypoints[i];
		const speed = Math.hypot(wp.x - prev.x, wp.z - prev.z) / ((wp.frame - prev.frame) / FPS);
		if (speed > WAYPOINT_SPEED_MAX_MPS) {
			return `field 'waypoints[${i}]' implies ${speed.toFixed(1)} m/s from waypoint ${i - 1} — faster than the ${WAYPOINT_SPEED_MAX_MPS} m/s locomotion ceiling`;
		}
		// Pairs beside a hold are the C1 ramp down to (or up from) zero and
		// legitimately pass under the floor; everywhere else, sub-gait creep
		// means foot-sliding.
		const besideHold = holdPair[i - 1] || (i + 1 < waypoints.length && holdPair[i + 1]);
		if (speed < WAYPOINT_SPEED_MIN_MPS && !besideHold) {
			return `field 'waypoints[${i}]' implies ${speed.toFixed(2)} m/s from waypoint ${i - 1} — below the ${WAYPOINT_SPEED_MIN_MPS} m/s gait floor (hold still or move at walking pace, nothing between)`;
		}
	}
	return null;
}

function readBody(req, limitBytes) {
	return new Promise((resolvePromise, reject) => {
		const chunks = [];
		let total = 0;
		req.on("data", (chunk) => {
			total += chunk.length;
			if (total > limitBytes) {
				reject(new Error(`request body exceeds ${limitBytes} bytes`));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
		req.on("error", (err) => reject(new Error(`request aborted: ${err.message}`)));
	});
}

// ---------------------------------------------------------------------------
// endpoints
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Cache-Control": "no-store",
	});
	res.end(`${JSON.stringify(obj)}\n`);
}

// The generator's single-line JSON report is the LAST stdout line of
// cclay_constrained_generate.py and is compact-printed (starts with "{").
// Constrained generation reports carry target_space; autoregressive sequence
// reports carry a segment table and continuity metrics.
function tryParseReport(line) {
	const trimmed = line.trimStart();
	if (!trimmed.startsWith("{")) return null;
	let parsed;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	const constrained = parsed && typeof parsed === "object" && typeof parsed.target_space === "string";
	const sequence =
		parsed &&
		typeof parsed === "object" &&
		Number.isInteger(parsed.frames) &&
		Number.isInteger(parsed.fps) &&
		Array.isArray(parsed.segments) &&
		parsed.continuity &&
		typeof parsed.continuity === "object";
	const motionEdit =
		parsed &&
		typeof parsed === "object" &&
		Array.isArray(parsed.edit_range) &&
		Array.isArray(parsed.history_range) &&
		Array.isArray(parsed.future_range);
	if (!constrained && !sequence && !motionEdit) {
		return null;
	}
	return parsed;
}

// ---------------------------------------------------------------------------
// generated-motion delivery
// ---------------------------------------------------------------------------

// run-id -> absolute npz path, populated ONLY after this process generated
// the file and verified it on disk (see handleGenerate's done branch). The
// GET handler never accepts a path from the URL: an id that is not in this
// map is 404 by definition. Capped so a long-lived dev sidecar cannot grow
// without bound; evicted ids become stale and 404, which is documented.
const motionAllowlist = new Map();

// POST /ardy/inbetween — 로컬 CMIB식 인비트위닝 (cozy-inbetween 워커).
// 김모도 박스 없이 맥 로컬 CPU로 수 ms. pose npz 변환은 기존 코드 경로 재사용.
const IB_PYTHON = "/Users/yun/cozy-inbetween/.venv/bin/python";
const IB_WORKER = "/Users/yun/cozy-inbetween/cclay_inbetween_generate.py";
const IB_CKPT = "/Users/yun/cozy-inbetween/checkpoints/ib_latest.pt";

async function handleInbetween(req, res) {
	const started = Date.now();
	const spawnTracked = (command, args, options) => {
		const child = spawn(command, args, options);
		track(child);
		return child;
	};
	let raw;
	try {
		raw = await readBody(req, MAX_BODY_BYTES);
	} catch (err) {
		sendJson(res, 400, { ok: false, reason: err.message });
		return;
	}
	let body;
	try {
		body = JSON.parse(raw);
	} catch (err) {
		sendJson(res, 400, { ok: false, reason: `malformed JSON: ${err.message}` });
		return;
	}
	const entries = Array.isArray(body?.poses) ? body.poses : [];
	const totalFrames = Number(body?.frames);
	if (entries.length < 2 || !entries.every((e) => e && Number.isInteger(e.frame) && e.pose)) {
		sendJson(res, 400, { ok: false, reason: "inbetween: poses 2개 이상 필요 ({frame, pose})" });
		return;
	}
	if (!Number.isInteger(totalFrames) || totalFrames < 2) {
		sendJson(res, 400, { ok: false, reason: "inbetween: frames(정수) 필요" });
		return;
	}
	if (!existsSync(IB_CKPT)) {
		sendJson(res, 503, { ok: false, reason: `inbetween 체크포인트 없음: ${IB_CKPT}` });
		return;
	}
	const stamp = `${Date.now()}-${randomBytes(3).toString("hex")}`;
	const artifactDir = createPrivateArtifactDir(OUT_DIR, "inbetween");
	const poseArgs = [];
	for (let i = 0; i < entries.length; i += 1) {
		const poseJsonPath = join(artifactDir, `pose-${i}.json`);
		const poseNpzPath = join(artifactDir, `pose-${i}.npz`);
		writeFileSync(poseJsonPath, `${JSON.stringify(entries[i].pose, null, 2)}\n`);
		const convCode = await runStreaming(
			spawnTracked(process.execPath, [POSE_TO_NPZ, poseJsonPath, "--out", poseNpzPath], { cwd: REPO, detached: true }),
			() => {},
		);
		if (convCode !== 0) {
			sendJson(res, 500, { ok: false, reason: `pose-to-npz 실패 (frame ${entries[i].frame})` });
			return;
		}
		poseArgs.push("--pose", poseNpzPath, String(entries[i].frame));
	}
	const outNpzPath = join(OUT_DIR, `inbetween-${stamp}.npz`);
	const code = await runStreaming(
		spawnTracked(IB_PYTHON, [IB_WORKER, "--ckpt", IB_CKPT, "--frames", String(totalFrames),
			"--style", String(Number(body.style) || 0), "--out", outNpzPath, ...poseArgs], { cwd: REPO, detached: true }),
		() => {},
	);
	if (code !== 0 || !existsSync(outNpzPath)) {
		sendJson(res, 500, { ok: false, reason: "inbetween 워커 실패" });
		return;
	}
	registerMotion(stamp, outNpzPath);
	console.log(`[bridge] inbetween 완료: ${entries.length} poses, ${totalFrames}f (${Date.now() - started} ms)`);
	sendJson(res, 200, { ok: true, motionUrl: `/ardy/motions/${stamp}`, bytes: statSync(outNpzPath).size, ms: Date.now() - started });
}

function registerMotion(runId, absPath) {
	motionAllowlist.set(runId, absPath);
	if (motionAllowlist.size > MOTION_ALLOWLIST_MAX) {
		const oldest = motionAllowlist.keys().next().value;
		evictPrivateArtifact(motionAllowlist, oldest);
	}
}

// Serves /ardy/motions/<run-id>; returns the HTTP status to log.
function serveMotion(req, res, pathname) {
	const match = /^\/ardy\/motions\/([^/]+)$/.exec(pathname);
	if (!match) {
		sendJson(res, 404, { ok: false, reason: `not found: ${req.method} ${pathname}` });
		return 404;
	}
	const runId = match[1];
	if (!MOTION_ID.test(runId) || !motionAllowlist.has(runId)) {
		sendJson(res, 404, { ok: false, reason: `unknown or expired motion "${runId}"` });
		return 404;
	}
	const absPath = motionAllowlist.get(runId);
	// The map only ever holds paths this process joined under OUT_DIR, but
	// the check is re-applied at serve time: nothing outside tools/ardy/out
	// is ever served, no matter how it got in.
	if (!absPath.startsWith(`${OUT_DIR}${sep}`)) {
		sendJson(res, 404, { ok: false, reason: `motion "${runId}" is outside ${OUT_DIR}` });
		return 404;
	}
	let size;
	try {
		size = statSync(absPath).size;
	} catch {
		sendJson(res, 404, { ok: false, reason: `motion "${runId}" is no longer on disk` });
		return 404;
	}
	res.writeHead(200, {
		"Content-Type": "application/octet-stream",
		"Content-Length": size,
		"Content-Disposition": `attachment; filename="${basename(absPath)}"`,
		"Cache-Control": "no-store",
	});
	createReadStream(absPath)
		.on("error", (err) => {
			console.error(`[bridge] error streaming ${absPath}: ${err.message}`);
			res.destroy();
		})
		.pipe(res);
	return 200;
}

async function handleGenerate(req, res) {
	const started = Date.now();
	const finish = (status) => {
		console.log(`[bridge] POST /ardy/generate -> ${status} (${Date.now() - started} ms)`);
	};

	let raw;
	try {
		raw = await readBody(req, MAX_BODY_BYTES);
	} catch (err) {
		sendJson(res, 400, { ok: false, reason: err.message });
		finish(400);
		return;
	}
	let body;
	try {
		body = JSON.parse(raw);
	} catch (err) {
		sendJson(res, 400, { ok: false, reason: `malformed JSON body: ${err.message}` });
		finish(400);
		return;
	}
	const invalid = validateGenerate(body);
	if (invalid) {
		sendJson(res, 400, { ok: false, reason: invalid });
		finish(400);
		return;
	}
	// A given base must be one of the ids the box actually reported, so a
	// typo or a guessed id never reaches the generator. posePin:false requests
	// may omit base entirely - with waypoints that is the two-pass mode
	// waypoints and without
	// waypoints it is free generation - so the listing is skipped there.
	const posePinned = body.posePin !== false;
	const requestedPoses = posePinned
		? (body.motionEdit
			? body.motionEdit.edits
			: Array.isArray(body.poses)
				? body.poses
				: [{ frame: body.dstFrame, pose: body.pose }])
		: [];
	const baseLabel = body.base === undefined ? "internal-neutral" : body.base;
	const dstFrameLabel = requestedPoses.map((entry) => entry.frame).join(",") || "none";
	let match = null;
	let sourceMotionPath = null;
	if (body.regenerateSegments || body.motionEdit) {
		const sourceUrl = body.motionEdit?.sourceMotion || body.sourceMotion;
		const sourceId = sourceUrl.slice("/ardy/motions/".length);
		sourceMotionPath = motionAllowlist.get(sourceId) || null;
		if (!sourceMotionPath || !existsSync(sourceMotionPath)) {
			sendJson(res, 400, { ok: false, reason: `field 'sourceMotion': unknown or expired motion "${sourceId}"` });
			finish(400);
			return;
		}
	}
	// Scheduled inpainting needs the BACKEND's own artifact of the take being
	// preserved: Kimodo's --base_motion reads the npz its generator wrote, and
	// the cskel27 file served at /ardy/motions/<id> is a lossy conversion of it,
	// not that file. Which artifact that is stays a backend question, so the
	// runner answers it and the bridge stays backend-neutral.
	let preserveParams = null;
	let preserveSkipped = null;
	if (body.preserve) {
		const preserveId = body.preserve.sourceMotion.slice("/ardy/motions/".length);
		const takePath = motionAllowlist.get(preserveId) || null;
		if (!takePath || !existsSync(takePath)) {
			sendJson(res, 400, { ok: false, reason: `field 'preserve.sourceMotion': unknown or expired motion "${preserveId}"` });
			finish(400);
			return;
		}
		const basePath = runner.baseMotionFor ? runner.baseMotionFor(takePath) : null;
		if (basePath) {
			preserveParams = {
				basePath,
				// The raw slider value rides along beside the derived sigmas: the
				// schedule alone is nearly binary in practice (gate G3 measured a
				// 7% L2P spread across the whole sweep), so the generator also
				// scales the blend AMPLITUDE by it to give the dial real range.
				strength: body.preserve.strength,
				...preserveSigmas(body.preserve.strength),
				// `tracks` (C3v2) rides along INSIDE each range: the mask builder is
				// the only layer that knows the generation clock, so ranges are
				// forwarded verbatim and never resolved to groups here.
				editRanges: body.preserve.editRanges,
				// preserve + waypoints (C3v2, paper 4.4): the authored path owns the
				// root for the WHOLE clip, so the mask's `root` group is zeroed end
				// to end and the drawn trajectory is not fighting a preserved one.
				// Everything else still rides the base take, including the groups the
				// edit ranges free. A FLAG, not a mask: generate.mjs builds the mask
				// in exactly one place and composes this onto it there.
				rootFree: body.waypoints !== undefined,
			};
		} else {
			// The take is real, but this backend kept no base motion for it:
			// motion edits and regenerated block sets are SPLICED from two
			// motions, so the backend's own artifact is not what the user is
			// looking at, and takes generated before scheduled inpainting landed
			// kept nothing at all. Preservation is a best-effort quality knob
			// that is ON by default, so a missing base degrades to the plain
			// generation this request would have been before the feature existed
			// — loudly, on the status stream the App logs — instead of failing a
			// run the operator did ask for.
			preserveSkipped =
				`[bridge] preserve SKIPPED: take "${preserveId}" has no ${runner.mode} base motion on disk ` +
				"(edited and spliced takes keep none); generating WITHOUT scheduled inpainting";
		}
	}
	// A line edit REWRITES an existing take, so the take it names is resolved the
	// same way preserve's is — through the allowlist this process populated, never
	// from a path in the request — and before anything opens a stream.
	let lineEditTakePath = null;
	if (body.lineEdit) {
		if (!projflowRunner) {
			sendJson(res, 503, {
				ok: false,
				reason: "line editing needs the ProjFlow backend: set CCLAY_PROJFLOW_HOST (or CCLAY_KIMODO_HOST)",
			});
			finish(503);
			return;
		}
		const lineEditId = body.lineEdit.sourceMotion.slice("/ardy/motions/".length);
		lineEditTakePath = motionAllowlist.get(lineEditId) || null;
		if (!lineEditTakePath || !existsSync(lineEditTakePath)) {
			sendJson(res, 400, { ok: false, reason: `field 'lineEdit.sourceMotion': unknown or expired motion "${lineEditId}"` });
			finish(400);
			return;
		}
	}
	// A replay needs the same backend a line edit does, and it needs it BEFORE the
	// stream opens: the generation itself would succeed, and refusing halfway
	// through would leave the client holding a take whose refinements silently
	// never ran. Checked here rather than in the validator because "is a box
	// configured" is process state, not a request rule.
	if (body.replay && body.replay.length > 0 && !projflowRunner) {
		sendJson(res, 503, {
			ok: false,
			reason: "recipe replay needs the ProjFlow backend: set CCLAY_PROJFLOW_HOST (or CCLAY_KIMODO_HOST)",
		});
		finish(503);
		return;
	}
	if (body.base !== undefined) {
		let bases;
		try {
			bases = await getBases();
		} catch (err) {
			sendJson(res, 503, { ok: false, reason: `cannot list base motions: ${err.message}` });
			finish(503);
			return;
		}
		match = bases.bases.find((entry) => entry.id === body.base);
		if (!match) {
			sendJson(res, 400, {
				ok: false,
				reason: `field 'base': unknown base "${body.base}" (the box reports ${bases.bases.length} base motion(s))`,
			});
			finish(400);
			return;
		}
	}
	res.writeHead(200, {
		"Content-Type": "application/x-ndjson",
		"Cache-Control": "no-store",
	});
	const send = (obj) => {
		if (res.writableEnded) return;
		try {
			res.write(`${JSON.stringify(obj)}\n`);
		} catch {
			/* socket gone; the close handler below kills the children */
		}
	};
	const sendStatus = (message) => send({ event: "status", message });
	const sendError = (message) => {
		send({ event: "error", message });
		res.end();
	};
	if (preserveSkipped) {
		console.error(preserveSkipped);
		sendStatus(preserveSkipped);
	}

	// Children spawned for THIS request, killed on client disconnect or any
	// terminal error. Detached groups, so killGroup takes down the whole tree
	// (bash + the ssh session it waits on).
	const children = new Set();
	const spawnTracked = (command, args, options) => {
		const child = spawn(command, args, options);
		children.add(child);
		track(child);
		return child;
	};
	const killChildren = () => {
		for (const child of children) killGroup(child);
		children.clear();
	};
	let artifactDir = null;
	const cleanupArtifacts = () => {
		if (artifactDir) removePrivateArtifactDir(artifactDir);
	};
	let clientGone = false;
	res.on("close", () => {
		if (!res.writableEnded) {
			clientGone = true;
			console.error(
				`[bridge] client disconnected mid-generate; killing ${children.size} child process group(s)`
			);
			killChildren();
			cleanupArtifacts();
		}
	});

	const stamp = `${Date.now()}-${randomBytes(3).toString("hex")}`;
	artifactDir = createPrivateArtifactDir(OUT_DIR, "generate");
	const poseJsonPaths = requestedPoses.map((_, index) => join(artifactDir, `pose-${index}.json`));
	const poseNpzPaths = requestedPoses.map((_, index) => join(artifactDir, `pose-${index}.npz`));
	// posePin:false runs carry no pose, so the artifact name says what the
	// run actually was: constrained (pose pinned) vs generated (no pose).
	const outNpzPath = join(artifactDir, body.lineEdit ? "line-edit.npz" : posePinned ? "constrained.npz" : "generated.npz");

	// --- recipe replay (contract C10) ---------------------------------------
	// A take is a RECIPE: seed + prompt blocks + the line edits drawn on top.
	// Regenerating or extending it therefore has to re-apply those edits, or
	// every "add a block" throws away the refinement work. The chain, the
	// per-entry failure policy and the boundary rule live in
	// tools/projflow/replay.mjs; what belongs HERE is only which take the chain
	// starts from, where its intermediates go, and what reaches the client.
	//
	// Called after the generated take is written and verified and BEFORE
	// anything is registered, so the motionUrl the client receives always names
	// the LAST good file in the chain — the take with the refinements in it.
	const replayEntries = Array.isArray(body.replay) ? body.replay : [];
	// The boundaries are a fact about how this take was GENERATED, so they come
	// from the request's prompt schedule and nowhere else. No `segments` field
	// means a single block, which has no internal boundary to warn about.
	const replayBoundaries = blockBoundaries(body.segments, Math.floor(body.duration * FPS));
	let replayReport = null;
	const applyReplay = async (takePath) => {
		if (replayEntries.length === 0) return takePath;
		sendStatus(
			`[bridge] replaying ${replayEntries.length} stored line edit(s) onto the new take` +
			(replayBoundaries.length ? ` (block boundaries at ${replayBoundaries.join(", ")})` : "")
		);
		const result = await runReplay({
			entries: replayEntries,
			takePath,
			artifactDir,
			boundaries: replayBoundaries,
			appFps: FPS,
			runJob: runLineEditJob,
			onStatus: (line) => sendStatus(line),
		});
		replayReport = result.entries;
		const failed = result.entries.filter((entry) => !entry.ok).length;
		const warned = result.entries.filter((entry) => entry.boundaryWarning).length;
		sendStatus(
			`[bridge] replay finished: ${result.entries.length - failed}/${result.entries.length} applied` +
			(failed ? `, ${failed} FAILED (drawn refinements missing from this take)` : "") +
			(warned ? `, ${warned} near a block boundary` : "")
		);
		return result.takePath;
	};
	// One report event, whatever produced it. The replay table rides on the
	// generator's own report when there is one and stands alone when there is
	// not, so a client never has to guess whether the replay ran.
	const sendReport = (report) => {
		if (!report && !replayReport) return;
		send({
			event: "report",
			report: { ...(report || {}), ...(replayReport ? { replay: replayReport } : {}) },
		});
	};
	try {

		// --- line edit (contract C6) ----------------------------------------
		// FIRST, and it returns: a line edit shares none of the machinery below.
		// It is its own run mode (no poses, no base, no segments), it runs on the
		// ProjFlow backend whatever CCLAY_MOTION_BACKEND says (engine-per-task),
		// and it produces a take by SPLICING a converted edit into the source
		// rather than by writing whatever the box returned.
		//
		// One honest limitation: the ssh this awaits belongs to lineEditOnBox, not
		// to `children`, so a client that disconnects mid-run does not kill it —
		// the sampling S1 measured is under a second, the wrapper removes its own
		// run directory either way, and the alternative is a cancellation channel
		// through three modules for a sub-second job.
		if (body.lineEdit) {
			sendStatus(
				`[bridge] line-editing ${body.lineEdit.track} over frames ` +
				`${body.lineEdit.frameRange.startFrame}..${body.lineEdit.frameRange.endFrame - 1} on the projflow backend` +
				(body.lineEdit.preview === true ? " (20-step preview)" : "")
			);
			const meta = await runLineEditJob({
				lineEdit: body.lineEdit,
				takePath: lineEditTakePath,
				outputPath: outNpzPath,
				// C10's preview flag, forwarded verbatim. The job owns what "preview"
				// costs (20 ODE steps instead of 100); the bridge only relays that the
				// client asked for a draft. A preview take is registered like any
				// other — the APP decides whether to keep it.
				preview: body.lineEdit.preview === true,
				seed: body.seed,
				appFps: FPS,
				onStatus: (line) => sendStatus(line),
			});
			// The seam numbers gate GP2 reads, on the status stream as well as in
			// the report: a hard cut is what this pipeline ships, and an operator
			// watching a run should see a pop without opening a file.
			sendStatus(
				`[bridge] line edit spliced: seams ${meta.seamStartDelta.toFixed(4)} / ${meta.seamEndDelta.toFixed(4)} m ` +
				`vs the take's median ${meta.medianFrameDelta.toFixed(4)} m/frame`
			);
			send({
				event: "report",
				report: {
					target_space: "skeleton_joint_center",
					engine: "projflow",
					...meta,
				},
			});
			const finalSize = statSync(outNpzPath).size;
			// Registered exactly like every other generated take, so the app can
			// load it from /ardy/motions/<id> and edit it AGAIN.
			registerMotion(stamp, outNpzPath);
			send({ event: "done", output: outNpzPath, bytes: finalSize, motionUrl: `/ardy/motions/${stamp}` });
			res.end();
			console.log(`[bridge] line edit finished: ${outNpzPath} (${body.lineEdit.track})`);
			killChildren();
			finish(200);
			return;
		}

		// --- pose -> motion npz (local, fast). Skipped when posePin is
			// false: the pose constraint is dropped, so there is nothing to
		// convert, dump a reference for, or push.
		if (posePinned) {
			for (let index = 0; index < requestedPoses.length; index += 1) {
				const entry = requestedPoses[index];
				const poseJsonPath = poseJsonPaths[index];
				const poseNpzPath = poseNpzPaths[index];
				writeFileSync(poseJsonPath, `${JSON.stringify(entry.pose, null, 2)}
`);
				sendStatus(`[bridge] pose ${index + 1}/${requestedPoses.length} frame ${entry.frame} written`);
				const conv = spawnTracked(
					process.execPath,
					[POSE_TO_NPZ, poseJsonPath, "--out", poseNpzPath],
					{ cwd: REPO, detached: true }
				);
				const convLast = { stderr: "", stdout: "" };
				const convCode = await runStreaming(conv, (line, streamName) => {
					convLast[streamName] = line;
					sendStatus(line);
				});
				children.delete(conv);
				if (convCode !== 0) {
					killChildren();
					sendError(`pose-to-npz failed (exit ${convCode}): ${convLast.stderr || convLast.stdout || "no output"}`);
					cleanupArtifacts();
					finish(200);
					return;
				}
			}
		}

		// --- generation on the box -----------------------------------------
		const clipFrames = Math.floor(body.duration * FPS);
		const segments = body.segments || [{ startFrame: 0, endFrame: clipFrames, prompt: body.prompt }];
		if (body.motionEdit) {
			const manifestPath = join(artifactDir, "edit-manifest.json");
			const manifest = {
				start_frame: body.motionEdit.startFrame,
				end_frame: body.motionEdit.endFrame,
				edits: body.motionEdit.edits.map((entry, index) => ({
					frame: entry.frame,
					tracks: entry.tracks,
					root: entry.pose.root,
					pose_path: `pose-${index}.npz`,
				})),
			};
			writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
			const cmd = await runner.editCommand({
				source: sourceMotionPath,
				manifest: manifestPath,
				prompt: body.prompt,
				contextBefore: body.motionEdit.contextBefore,
				contextAfter: body.motionEdit.contextAfter,
				seed: body.seed,
				poseNpzPaths,
				// An edit run regenerates the whole clip and splices only the
				// edited span back in, so its backend artifact is NOT the take the
				// user ends up with — it keeps no base motion of its own. It can
				// still PRESERVE one: reconstructing the source outside the edit is
				// what makes the regenerated span line up with it.
				preserve: preserveParams,
				output: outNpzPath,
			});
			sendStatus(
				`[bridge] editing frames ${body.motionEdit.startFrame}..${body.motionEdit.endFrame - 1} ` +
				"with history and sparse constraints"
			);
			const box = spawnTracked(cmd.command, cmd.args, { cwd: REPO, detached: true, env: cmd.env });
			const last = { stderr: "", stdout: "" };
			let report = null;
			let done = null;
			const code = await runStreaming(box, (line, streamName) => {
				last[streamName] = line;
				if (streamName === "stdout") {
					const parsed = tryParseReport(line);
					if (parsed) {
						report = parsed;
						return;
					}
					const marker = cmd.doneRe.exec(line);
					if (marker) {
						done = { path: marker[1], bytes: Number(marker[2]) };
						return;
					}
				}
				sendStatus(line);
			});
			children.delete(box);
			if (code !== 0) throw new Error(`${cmd.label} failed (exit ${code}): ${last.stderr || last.stdout || "no output"}`);
			if (!done || done.path !== outNpzPath) throw new Error(`${cmd.label} did not return the requested output`);
			const finalSize = statSync(outNpzPath).size;
			if (finalSize !== done.bytes) throw new Error(`${cmd.label} output size mismatch`);
			if (report) send({ event: "report", report });
			registerMotion(stamp, outNpzPath);
			send({ event: "done", output: outNpzPath, bytes: finalSize, motionUrl: `/ardy/motions/${stamp}` });
			res.end();
			console.log(`[bridge] context-aware motion edit finished: ${outNpzPath}`);
			killChildren();
			finish(200);
			return;
		}
		if (body.segments) {
			// Root waypoints ride the same chained rollout (rollout-global
			// frames): the sequence generator slices the constraint set per
			// segment call, so a path and a prompt schedule coexist.
			const cmd = await runner.sequenceCommand({
				segments: segments.map((segment) => ({
					prompt: segment.prompt,
					durationS: (segment.endFrame - segment.startFrame) / FPS,
				})),
				waypoints: body.waypoints,
				seed: body.seed,
				cpu: body.cpu,
				rootMargin: body.rootMargin,
				contactThreshold: body.contactThreshold,
				historyFrames: body.historyFrames,
				// The written take IS this run's generation, retimed — so keep the
				// backend's own npz beside it as a base a later preserve run can
				// reconstruct. (A prompt schedule can never itself preserve: v1 is
				// single-segment. Being preserved FROM is unrestricted.)
				keepNative: true,
				output: outNpzPath,
			});
			sendStatus(
				`[bridge] generating ${segments.length} blocks in one autoregressive session` +
				(body.waypoints?.length ? ` with a ${body.waypoints.length}-pin root path` : "")
			);

			const box = spawnTracked(cmd.command, cmd.args, { cwd: REPO, detached: true, env: cmd.env });
			const last = { stderr: "", stdout: "" };
			let finalReport = null;
			let done = null;
			const code = await runStreaming(box, (line, streamName) => {
				last[streamName] = line;
				if (streamName === "stdout") {
					const parsed = tryParseReport(line);
					if (parsed) {
						finalReport = parsed;
						return;
					}
					const marker = cmd.doneRe.exec(line);
					if (marker) {
						done = { path: marker[1], bytes: Number(marker[2]) };
						return;
					}
				}
				sendStatus(line);
			});
			children.delete(box);
			if (code !== 0) {
				throw new Error(`${cmd.label} failed (exit ${code}): ${last.stderr || last.stdout || "no output"}`);
			}
			if (!done) throw new Error(`${cmd.label} exited 0 without a "done" marker`);
			if (done.path !== outNpzPath) throw new Error(`${cmd.label} returned unexpected output ${done.path}`);
			const finalSize = statSync(outNpzPath).size;
			if (finalSize === 0 || finalSize !== done.bytes) {
				throw new Error(`${cmd.label} output size mismatch for ${outNpzPath}`);
			}
			// The take exists and is verified; NOW the recipe's line edits go back
			// on, and the file they leave behind is the one that gets registered.
			const deliveredPath = await applyReplay(outNpzPath);
			sendReport(finalReport);
			const deliveredSize = statSync(deliveredPath).size;
			registerMotion(stamp, deliveredPath);
			send({ event: "done", output: deliveredPath, bytes: deliveredSize, motionUrl: `/ardy/motions/${stamp}` });
			res.end();
			console.log(`[bridge] sequence generation finished: ${deliveredPath} (${segments.length} blocks)`);
			killChildren();
			finish(200);
			return;
		}
		const runSingle = async (segment, outputPath = outNpzPath) => {
			const localPoses = requestedPoses
				.map((entry, poseIndex) => ({ ...entry, poseIndex }))
				.filter((entry) => entry.frame >= segment.startFrame && entry.frame < segment.endFrame);
			if (posePinned && localPoses.length === 0) {
				throw new Error("generation has no pose constraint");
			}
			const segmentFrames = segment.endFrame - segment.startFrame;
			const cmd = await runner.singleCommand({
				poseFroms: localPoses.map((entry) => ({
					npz: poseNpzPaths[entry.poseIndex],
					srcFrame: 0,
					dstFrame: entry.frame - segment.startFrame,
				})),
				basePath: match ? match.path : null,
				prompt: segment.prompt,
				durationS: segmentFrames / FPS,
				seed: body.seed,
				cpu: body.cpu,
				waypoints: body.waypoints,
				rootMargin: body.rootMargin,
				contactThreshold: body.contactThreshold,
				historyFrames: body.historyFrames,
				preserve: preserveParams,
				// regenerateSegments calls this once per block and splices the
				// results into the source take, so no single block's backend npz is
				// the delivered take; only a whole-clip run keeps a base motion.
				keepNative: body.regenerateSegments === undefined,
				output: outputPath,
			});
			sendStatus(`[bridge] generating frames ${segment.startFrame}..${segment.endFrame - 1}`);

			const box = spawnTracked(cmd.command, cmd.args, { cwd: REPO, detached: true, env: cmd.env });
			const last = { stderr: "", stdout: "" };
			let report = null;
			let done = null;
			const code = await runStreaming(box, (line, streamName) => {
				last[streamName] = line;
				if (streamName === "stdout") {
					const parsed = tryParseReport(line);
					if (parsed) {
						report = parsed;
						return;
					}
					const marker = cmd.doneRe.exec(line);
					if (marker) {
						done = { path: marker[1], bytes: Number(marker[2]) };
						return;
					}
				}
				sendStatus(line);
			});
			children.delete(box);
			if (code !== 0) throw new Error(`${cmd.label} failed (exit ${code}): ${last.stderr || last.stdout || "no output"}`);
			if (!done) throw new Error(`${cmd.label} exited 0 without a "done" marker`);
			if (done.path !== outputPath) throw new Error(`${cmd.label} returned unexpected output ${done.path}`);
			const size = statSync(outputPath).size;
			if (size === 0 || size !== done.bytes) throw new Error(`${cmd.label} output size mismatch for ${outputPath}`);
			return report;
		};

		if (body.regenerateSegments) {
			const source = await decodeMotionNpz(new Uint8Array(readFileSync(sourceMotionPath)));
			if (source.frames !== clipFrames || source.fps !== FPS) {
				throw new Error(`source motion is ${source.frames} frames @ ${source.fps} fps; expected ${clipFrames} @ ${FPS}`);
			}
			let result = source;
			const reports = [];
			for (let index = 0; index < body.regenerateSegments.length; index += 1) {
				const segment = body.regenerateSegments[index];
				const segmentPath = join(artifactDir, `edit-${index}.npz`);
				const report = await runSingle(segment, segmentPath);
				const generated = await decodeMotionNpz(new Uint8Array(readFileSync(segmentPath)));
				const segmentFrames = segment.endFrame - segment.startFrame;
				if (generated.frames !== segmentFrames || generated.fps !== FPS) {
					throw new Error(`edited block ${index + 1} returned ${generated.frames} frames @ ${generated.fps} fps`);
				}
				result = replaceMotionSegment(result, generated, segment.startFrame);
				if (report) reports.push({ ...report, startFrame: segment.startFrame, endFrame: segment.endFrame });
			}
			writeNpz(outNpzPath, motionArraysToNpzMembers(result));
			const boundaryJumps = [];
			for (const segment of body.regenerateSegments) {
				for (const frame of [segment.startFrame, segment.endFrame]) {
					if (frame <= 0 || frame >= result.frames) continue;
					let maxJump = 0;
					for (let joint = 0; joint < 27; joint += 1) {
						const current = (frame * 27 + joint) * 3;
						const previous = current - 27 * 3;
						maxJump = Math.max(
							maxJump,
							Math.hypot(
								result.posedJoints[current] - result.posedJoints[previous],
								result.posedJoints[current + 1] - result.posedJoints[previous + 1],
								result.posedJoints[current + 2] - result.posedJoints[previous + 2]
							)
						);
					}
					boundaryJumps.push({ frame, max_joint_jump_m: maxJump });
				}
			}
			send({
				event: "report",
				report: {
					target_space: "skeleton_joint_center",
					frames: result.frames,
					fps: result.fps,
					regenerated_segments: body.regenerateSegments,
					segments: reports,
					boundaries: boundaryJumps,
				},
			});
			const finalSize = statSync(outNpzPath).size;
			registerMotion(stamp, outNpzPath);
			send({ event: "done", output: outNpzPath, bytes: finalSize, motionUrl: `/ardy/motions/${stamp}` });
			res.end();
			console.log(`[bridge] regenerated ${body.regenerateSegments.length} edited block(s): ${outNpzPath}`);
			killChildren();
			finish(200);
			return;
		}

		let finalReport;
		try {
			finalReport = await runSingle(segments[0]);
		} catch (error) {
			// The base take is a different length than this generation window —
			// Kimodo's preserve prep refuses it outright (there is no principled
			// resample). The app now avoids sending the pair, but any other client
			// (MCP, replay, an older app) can still ask; degrade to a plain
			// generation LOUDLY, the same policy as a missing base motion, instead
			// of failing a run the operator did ask for.
			if (!preserveParams || !/Base motion duration does not match/.test(String(error?.message ?? ""))) throw error;
			const skipped =
				"[bridge] preserve SKIPPED: the take being preserved is a different length than this " +
				"generation window; generating WITHOUT scheduled inpainting";
			console.error(skipped);
			sendStatus(skipped);
			preserveParams = null;
			finalReport = await runSingle(segments[0]);
		}
		if (finalReport) {
			const poseResults = finalReport.poses || [];
			const worst = (key) => poseResults.length ? Math.max(...poseResults.map((pose) => pose[key] ?? 0)) : null;
			finalReport.root_error_m = worst("root_error_m");
			finalReport.shape_mean_error_m = worst("shape_mean_error_m");
			finalReport.shape_max_error_m = worst("shape_max_error_m");
			finalReport.base_root_error_m = worst("base_root_error_m");
			finalReport.base_shape_mean_error_m = worst("base_shape_mean_error_m");
			finalReport.base_shape_max_error_m = worst("base_shape_max_error_m");
		}
		// Same order as every other branch: generate, verify, replay, report,
		// register, done. runSingle already checked the npz's size against the
		// generator's own "done" marker, so the file the replay reads is real.
		const deliveredPath = await applyReplay(outNpzPath);
		sendReport(finalReport);
		const finalSize = statSync(deliveredPath).size;
		registerMotion(stamp, deliveredPath);
		send({ event: "done", output: deliveredPath, bytes: finalSize, motionUrl: `/ardy/motions/${stamp}` });
		res.end();
		console.log(`[bridge] generate finished: ${deliveredPath} (base ${baseLabel}, ${body.duration}s, dstFrame ${dstFrameLabel})`);

		killChildren();
		finish(200);
	} catch (err) {
		killChildren();
		cleanupArtifacts();
		if (!res.writableEnded) sendError(`generate failed: ${err.message}`);
		// A run whose client already hung up dies of collateral damage — its
		// artifact dir was just removed underneath it (see the close handler), so
		// the ENOENT that follows is the abort working, not a generation failure.
		if (clientGone) console.error(`[bridge] generate aborted by client disconnect (${err.message.split("\n")[0]})`);
		else console.error(`[bridge] generate error: ${err.stack || err}`);
		finish(200);
	}
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

function usage() {
	console.log(`usage: node tools/ardy/bridge.mjs [--port <n>]

Dev-only HTTP sidecar for motion generation. See tools/ardy/BRIDGE.md.

  --port <n>            port to listen on (default 5181, loopback only)

env:
  COZYCLAY_BRIDGE_PORT    same as --port (default 5181)
  CCLAY_MOTION_BACKEND     only "kimodo" is supported (default)
  CCLAY_KIMODO_HOST        ssh destination for the Kimodo host
  CCLAY_KIMODO_REPO        Kimodo checkout on the host (default $HOME/kimodo)
  CCLAY_KIMODO_MODEL       model id (default Kimodo-SOMA-RP-v1.1)

line editing (contract C6) runs on the ProjFlow backend regardless of
CCLAY_MOTION_BACKEND, and advertises itself in /ardy/health as
capabilities.lineEdit once the box probes clean:
  CCLAY_PROJFLOW_HOST      ssh destination (defaults to CCLAY_KIMODO_HOST)
  CCLAY_PROJFLOW_REPO      ProjFlow checkout (default /home/yun/projflow-scout/repo)
  CCLAY_PROJFLOW_PYTHON    the scout venv's python
  CCLAY_PROJFLOW_HOME      HOME override for box runs
`);
}

function die(message) {
	console.error(`[bridge] ${message}`);
	process.exit(2);
}

function resolvePort(argv) {
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--help" || argv[i] === "-h") {
			usage();
			process.exit(0);
		}
		if (argv[i] === "--port") {
			const value = argv[i + 1];
			if (value === undefined) die("--port needs a value");
			const port = Number(value);
			if (!Number.isInteger(port) || port < 1 || port > 65535) die(`invalid --port value '${value}'`);
			return port;
		}
	}
if (process.env.COZYCLAY_BRIDGE_PORT !== undefined) {
	const port = Number(process.env.COZYCLAY_BRIDGE_PORT);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
		die(`invalid COZYCLAY_BRIDGE_PORT value '${process.env.COZYCLAY_BRIDGE_PORT}'`);
		}
		return port;
	}
	return DEFAULT_PORT;
}

const port = resolvePort(process.argv.slice(2));
try {
	runner = createRunner();
} catch (err) {
	die(err.message);
}
// Beside the selected backend, never instead of it. A missing ProjFlow
// configuration is NOT fatal — the bridge's other run modes do not need it —
// so the failure is reported once at startup and the capability stays off.
try {
	projflowRunner = createProjflowRunner();
} catch (err) {
	console.error(`[bridge] line editing is unavailable: ${err.message}`);
}

const server = createServer((req, res) => {
	const started = Date.now();
	const pathname = (req.url || "/").split("?")[0];
	const log = (status) => {
		console.log(`[bridge] ${req.method} ${pathname} -> ${status} (${Date.now() - started} ms)`);
	};

	if (req.method === "OPTIONS") {
		// 204 with NO CORS headers on purpose: a cross-origin browser
		// preflight must fail, and the same-origin Vite proxy never
		// preflights the bridge (it forwards server-side).
		res.writeHead(204);
		res.end();
		log(204);
		return;
	}
	if (pathname === "/ardy/health" && req.method === "GET") {
		// `capabilities` is how the app learns that an OPTIONAL run mode is wired
		// on this box. The draw-a-line affordance is gated on capabilities.lineEdit
		// (App.jsx accepts the object or an array spelling), so a bridge whose
		// ProjFlow env is missing keeps the feature dark instead of letting the
		// artist draw a stroke that would 503. Probed, never assumed.
		Promise.all([getHealth(), getLineEditCapability()])
			.then(([value, lineEdit]) => {
				sendJson(res, 200, { ...value, capabilities: { lineEdit } });
				log(200);
			})
			.catch((err) => {
				sendJson(res, 503, { ok: false, reason: err.message });
				log(503);
			});
		return;
	}
	if (pathname === "/ardy/bases" && req.method === "GET") {
		getBases()
			.then((value) => {
				sendJson(res, 200, value);
				log(200);
			})
			.catch((err) => {
				sendJson(res, 503, { ok: false, reason: err.message });
				log(503);
			});
		return;
	}
	if (pathname === "/ardy/inbetween" && req.method === "POST") {
		handleInbetween(req, res).catch((err) => {
			if (!res.headersSent) sendJson(res, 500, { ok: false, reason: `inbetween internal: ${err.message}` });
			console.error(`[bridge] ${req.method} ${pathname} threw: ${err.stack || err}`);
			log(500);
		});
		return;
	}
	if (pathname === "/ardy/generate" && req.method === "POST") {
		handleGenerate(req, res).catch((err) => {
			if (!res.headersSent) sendJson(res, 500, { ok: false, reason: `internal error: ${err.message}` });
			else {
				try {
					res.end();
				} catch {
					/* socket gone */
				}
			}
			console.error(`[bridge] ${req.method} ${pathname} threw: ${err.stack || err}`);
			log(500);
		});
		return;
	}
	if (/^\/ardy\/motions\//.test(pathname) && req.method === "GET") {
		log(serveMotion(req, res, pathname));
		return;
	}
	if (pathname === "/ardy/footage" && req.method === "POST") {
		handleFootage(req, res, (request) => readBody(request, MAX_BODY_BYTES)).catch((err) => {
			if (!res.headersSent) sendJson(res, 500, { ok: false, reason: `internal error: ${err.message}` });
			else {
				try {
					res.end();
				} catch {
					/* socket gone */
				}
			}
			console.error(`[bridge] ${req.method} ${pathname} threw: ${err.stack || err}`);
			log(500);
		});
		return;
	}
	if (/^\/ardy\/footage\//.test(pathname) && req.method === "GET") {
		log(serveFootage(req, res, pathname));
		return;
	}
	if (pathname === "/ardy/extract" && req.method === "POST") {
		handleExtract(req, res, {
			readBody: (request) => readBody(request, MAX_BODY_BYTES),
			footagePath,
			registerMotion,
			artifactRoot: OUT_DIR,
		}).catch((err) => {
			if (!res.headersSent) sendJson(res, 500, { ok: false, reason: `internal error: ${err.message}` });
			else {
				try {
					res.end();
				} catch {
					/* socket gone */
				}
			}
			console.error(`[bridge] ${req.method} ${pathname} threw: ${err.stack || err}`);
			log(500);
		});
		return;
	}
	if (
		pathname === "/ardy/health" ||
		pathname === "/ardy/bases" ||
		pathname === "/ardy/generate" ||
		pathname === "/ardy/inbetween" ||
		pathname === "/ardy/footage" ||
		pathname === "/ardy/extract" ||
		/^\/ardy\/motions\//.test(pathname) ||
		/^\/ardy\/footage\//.test(pathname)
	) {
		sendJson(res, 405, { ok: false, reason: `method ${req.method} not allowed on ${pathname}` });
		log(405);
		return;
	}
	sendJson(res, 404, { ok: false, reason: `not found: ${req.method} ${pathname}` });
	log(404);
});

server.on("clientError", (err, socket) => {
	if (socket.writable) {
		socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
	}
	console.error(`[bridge] client error: ${err.message}`);
});

server.listen(port, BIND_HOST, () => {
	const address = server.address();
	const boundPort = typeof address === "object" && address ? address.port : port;
	process.send?.({ type: "cozyclay-bridge-ready", port: boundPort });
	console.log(`[bridge] motion dev bridge listening on http://${BIND_HOST}:${boundPort}`);
	console.log("[bridge] dev-only sidecar: the static dist/ build does not need it; stop with Ctrl-C");
	console.log(`[bridge] ${runner.mode} backend: ${runner.describe()}`);
});

server.on("error", (err) => {
	const override = "set COZYCLAY_BRIDGE_PORT to a free port or pass --port <n>";
	console.error(
		`[bridge] cannot listen on ${BIND_HOST}:${port}: ${err.message}` +
			(err?.code === "EADDRINUSE" ? `; ${override}` : ""),
	);
	if (process.send && process.connected) {
		process.send({ type: "cozyclay-bridge-listen-error", port, code: err?.code }, () => process.exit(1));
	} else {
		process.exit(1);
	}
});

// Ctrl-C / SIGTERM: take the in-flight process groups down with us; ssh dies,
// sshd closes the session, and the remote generation is not orphaned.
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		console.error(`[bridge] received ${signal}; killing ${globalChildren.size} in-flight child process group(s)`);
		for (const child of globalChildren) killGroup(child);
		process.exit(signal === "SIGINT" ? 130 : 143);
	});
}
