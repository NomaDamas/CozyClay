#!/usr/bin/env node
/** Remote execution boundary for the known-character tracker. */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runBox } from "./run-box.mjs";
import { trackerBudgetMs } from "./budget.mjs";

/** Parse the two progress formats emitted by track.py. */
export function parseProgressLine(line) {
	const text = String(line).trim();
	let match = /^\[track\]\s+stage\s+(\S+)\s+(\d+)\/(\d+)\s*$/.exec(text);
	if (match) {
		const current = Number(match[2]), total = Number(match[3]);
		return { kind: "stage", stage: match[1], current, total, fraction: total > 0 ? current / total : 0 };
	}
	match = /^\[track\]\s+(\d+)\s*\/\s*(\d+)\s*$/.exec(text);
	if (match) {
		const current = Number(match[1]), total = Number(match[2]);
		return { kind: "frame", current, total, fraction: total > 0 ? current / total : 0 };
	}
	return null;
}

export const trackerInputNames = Object.freeze(["video", "obs", "masks", "init", "camera", "scene", "rig"]);
export function trackerUploadPlan({ video, obsPath, masksPath, initMotionPath, cameraPath, scenePath, rigPath } = {}) {
	return Object.fromEntries(Object.entries({ video, obs: obsPath, masks: masksPath, init: initMotionPath, camera: cameraPath, scene: scenePath, rig: rigPath }));
}

function requiredFile(path, name) {
	if (typeof path !== "string" || !path) throw new Error(`${name}: path is required`);
	return path;
}
function lineParser(onLine, progress) {
	return (text) => {
		const parsed = parseProgressLine(text);
		if (parsed) progress.push(parsed);
		onLine?.(text, parsed);
	};
}
function withTimeout(promise, timeoutMs) {
	let timer;
	const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`tracker timeout after ${timeoutMs} ms`)), timeoutMs); });
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Delegate all transfer and remote execution to run-box.mjs. The only
 * caller-owned data transfer entries are the seven declared tracker inputs;
 * run-box separately uploads the Python implementation.
 */
export async function runTracker({ host, video, obsPath, masksPath, initMotionPath, cameraPath, scenePath, rigPath, outDir, onLine, transport } = {}) {
	if (typeof host !== "string" || !host.trim()) throw new Error("host is required");
	const files = trackerUploadPlan({ video, obsPath, masksPath, initMotionPath, cameraPath, scenePath, rigPath });
	for (const [name, path] of Object.entries(files)) requiredFile(path, name);
	if (typeof outDir !== "string" || !outDir) throw new Error("outDir is required");
	mkdirSync(outDir, { recursive: true });
	const motionPath = `${outDir}/motion.npz`, diagnosticsPath = `${outDir}/diagnostics.json`;
	for (const path of [motionPath, diagnosticsPath]) rmSync(path, { force: true });
	const progress = [];
	const runner = transport?.runBox ?? runBox;
	const upload = Object.entries(files).map(([name, localPath]) => ({ localPath, remoteRelPath: name }));
	const fetch = [
		{ remoteRelPath: "motion.npz", localPath: motionPath },
		{ remoteRelPath: "diagnostics.json", localPath: diagnosticsPath },
	];
	const frames = await inferFrames(obsPath);
	const args = [
		"--video", "video", "--obs", "obs", "--masks", "masks", "--init", "init", "--camera", "camera", "--scene", "scene", "--rig", "rig", "--out", ".",
	];
	await withTimeout(Promise.resolve(runner({ entry: "track.py", args, hostName: host, onLine: lineParser(onLine, progress), upload, fetch })), trackerBudgetMs(frames));
	const diagnostics = JSON.parse(readFileSync(diagnosticsPath, "utf8"));
	validateDiagnostics(diagnostics);
	return { motionPath, diagnosticsPath, diagnostics, progress };
}

function finite(value, label) {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`diagnostics: ${label} must be finite`);
}

/** Structural validation kept dependency-free because the bench has no schema package. */
export function validateDiagnostics(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("diagnostics: expected an object");
	const required = ["version", "frames", "fps", "occluded", "lrState", "lrMargin", "ambiguous", "stance", "penetration", "nuisance", "stageLosses", "runtime", "failure"];
	const rootKeys = new Set(required);
	for (const key of required) if (!(key in value)) throw new Error(`diagnostics: missing ${key}`);
	for (const key of Object.keys(value)) if (!rootKeys.has(key)) throw new Error(`diagnostics: unknown property ${key}`);
	if (value.version !== 1 || !Number.isInteger(value.frames) || value.frames < 1) throw new Error("diagnostics: invalid version or frames");
	finite(value.fps, "fps");
	if (!(value.fps > 0)) throw new Error("diagnostics: fps must be positive");
	const arrays = [["occluded", value.occluded], ["lrState", value.lrState], ["lrMargin", value.lrMargin], ["ambiguous", value.ambiguous], ["stance.left", value.stance?.left], ["stance.right", value.stance?.right]];
	for (const [name, array] of arrays) if (!Array.isArray(array) || array.length !== value.frames) throw new Error(`diagnostics: ${name} must have ${value.frames} frames`);
	value.occluded.forEach((row, t) => { if (!Array.isArray(row) || row.length !== 27 || row.some(v => typeof v !== "boolean")) throw new Error(`diagnostics: occluded[${t}] must contain 27 booleans`); });
	value.lrState.forEach((v, t) => { if (typeof v !== "string") throw new Error(`diagnostics: lrState[${t}] must be a string`); });
	value.lrMargin.forEach((v, t) => finite(v, `lrMargin[${t}]`));
	value.ambiguous.forEach((v, t) => { if (typeof v !== "boolean") throw new Error(`diagnostics: ambiguous[${t}] must be boolean`); });
	if (!value.stance || typeof value.stance !== "object" || Object.keys(value.stance).some(key => !["left", "right"].includes(key))) throw new Error("diagnostics: invalid stance");
	for (const side of ["left", "right"]) value.stance[side].forEach((v, t) => { if (typeof v !== "boolean") throw new Error(`diagnostics: stance.${side}[${t}] must be boolean at ${t}`); });
	if (!value.penetration || typeof value.penetration !== "object" || Object.keys(value.penetration).some(key => !["maxBoxCm", "maxFloorCm", "frames"].includes(key)) || !Array.isArray(value.penetration.frames)) throw new Error("diagnostics: invalid penetration");
	finite(value.penetration.maxBoxCm, "penetration.maxBoxCm"); finite(value.penetration.maxFloorCm, "penetration.maxFloorCm");
	if (value.penetration.maxBoxCm < 0 || value.penetration.maxFloorCm < 0 || value.penetration.frames.some(v => !Number.isInteger(v) || v < 0)) throw new Error("diagnostics: invalid penetration values");
	if (!value.nuisance || typeof value.nuisance !== "object" || Object.keys(value.nuisance).some(key => !["scale", "cameraDeltaDeg", "fovDeltaPct"].includes(key)) || !Number.isFinite(value.nuisance.scale) || !(value.nuisance.scale > 0) || !Array.isArray(value.nuisance.cameraDeltaDeg) || value.nuisance.cameraDeltaDeg.length !== 2 || value.nuisance.cameraDeltaDeg.some(v => !Number.isFinite(v)) || !Number.isFinite(value.nuisance.fovDeltaPct)) throw new Error("diagnostics: invalid nuisance");
	if (!value.stageLosses || typeof value.stageLosses !== "object" || Array.isArray(value.stageLosses) || Object.values(value.stageLosses).some(v => !Number.isFinite(v))) throw new Error("diagnostics: invalid stageLosses");
	if (!value.runtime || typeof value.runtime !== "object" || Object.keys(value.runtime).some(key => !["trackerSeconds", "peakReservedMiB"].includes(key)) || !Number.isFinite(value.runtime.trackerSeconds) || value.runtime.trackerSeconds < 0 || !Number.isFinite(value.runtime.peakReservedMiB) || value.runtime.peakReservedMiB < 0) throw new Error("diagnostics: invalid runtime");
	if (value.failure !== null && typeof value.failure !== "string") throw new Error("diagnostics: failure must be null or string");
	return value;
}

async function inferFrames(path) {
	try {
		const { readNpz } = await import("../kimodo/read-npz.mjs");
		const shape = readNpz(path).kp2d?.shape;
		if (shape && Number.isInteger(shape[0]) && shape[0] > 0) return shape[0];
	} catch { /* track.py reports malformed input; retain the safe minimum */ }
	return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	console.error("remote.mjs exports runTracker; call it from the bench or bridge runner");
	process.exitCode = 2;
}
