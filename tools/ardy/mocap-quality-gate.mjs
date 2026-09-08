#!/usr/bin/env node
/**
 * Acceptance gate for a converted CSKEL27 mocap take.
 *
 * The report in mocap-metrics.mjs is intentionally descriptive.  This gate
 * turns the values into an explicit, reviewable decision so a visibly shaky
 * clip cannot be shipped by accident.  Thresholds are defaults for ordinary
 * 24–60 fps footage and can be overridden per footage class with flags.
 */
import { mocapMetrics } from "./mocap-metrics.mjs";
import { pathToFileURL } from "node:url";

export const DEFAULT_LIMITS = Object.freeze({
	maxFootSlideCmPerS: 3,
	maxJitterMmPerFrame2: 6,
	// 6 mm/frame² at the 30fps reference rate.  The gate prefers the
	// time-normalised metric when the extractor provides it, so a 60fps clip
	// cannot pass merely because its frame interval is shorter.
	maxJitterMmPerS2: 5400,
	maxBelowFloorFraction: 0.02,
	maxDeepestBelowFloorCm: 1.5,
	maxVerticalContactErrorCm: 2,
	maxCameraDriftPx: 2,
	maxBackgroundDriftP95: 8,
});

/** Return a structured decision; pure so CI and browser QA can reuse it. */
export function evaluateQuality(metrics, limits = DEFAULT_LIMITS) {
	const fps = Number(metrics?.fps);
	const jitterIsNormalised = Number.isFinite(metrics?.jitterMmPerS2);
	const jitterValue = jitterIsNormalised ? metrics.jitterMmPerS2 : metrics?.jitterMmPerFrame2;
	// Preserve callers that override the legacy frame-space limit.  Its
	// historical meaning was measured at 30fps, so convert it to acceleration
	// units when a normalised metric is available.
	const frameJitterLimit = Number(limits.maxJitterMmPerFrame2);
	const secondJitterLimit = Number(limits.maxJitterMmPerS2);
	const jitterLimit = jitterIsNormalised
		? (Number.isFinite(frameJitterLimit) &&
			(!Number.isFinite(secondJitterLimit) || secondJitterLimit === DEFAULT_LIMITS.maxJitterMmPerS2)
			? frameJitterLimit * 30 * 30
			: secondJitterLimit)
		: limits.maxJitterMmPerFrame2;
	const checks = [
		{
			name: "foot-slide",
			value: metrics.footSlideCmPerS,
			limit: limits.maxFootSlideCmPerS,
			pass: metrics.footSlideCmPerS <= limits.maxFootSlideCmPerS,
			unit: "cm/s",
		},
		{
			name: "jitter",
			value: jitterValue,
			limit: jitterLimit,
			pass: Number.isFinite(jitterValue) && jitterValue <= jitterLimit,
			unit: jitterIsNormalised ? "mm/s²" : "mm/frame²",
			...(jitterIsNormalised ? { rawValue: metrics.jitterMmPerFrame2, fps } : {}),
		},
		{
			name: "below-floor-fraction",
			value: metrics.framesBelowFloor / metrics.frames,
			limit: limits.maxBelowFloorFraction,
			pass: metrics.framesBelowFloor / metrics.frames <= limits.maxBelowFloorFraction,
			unit: "fraction",
		},
		{
			name: "deepest-below-floor",
			value: metrics.deepestBelowFloorCm,
			limit: limits.maxDeepestBelowFloorCm,
			pass: metrics.deepestBelowFloorCm <= limits.maxDeepestBelowFloorCm,
			unit: "cm",
		},
	];
	// These checks need scene/video observations that an NPZ alone does not
	// contain.  Include them whenever the extractor supplies the measurements;
	// omission is reported to callers as "unmeasured" rather than guessed.
	for (const [name, valueKey, limitKey, unit] of [
		["vertical-contact", "verticalContactErrorCm", "maxVerticalContactErrorCm", "cm"],
		["camera-drift", "cameraDriftPx", "maxCameraDriftPx", "px"],
		["background-drift", "backgroundDriftP95", "maxBackgroundDriftP95", "mean-absolute-RGB"],
	]) {
		if (Number.isFinite(metrics[valueKey]) && Number.isFinite(limits[limitKey])) {
			checks.push({ name, value: metrics[valueKey], limit: limits[limitKey], pass: metrics[valueKey] <= limits[limitKey], unit });
		}
	}
	return { pass: checks.every((check) => check.pass), checks, metrics };
}

function usage() {
	console.error("usage: node tools/ardy/mocap-quality-gate.mjs <take.npz> [--foot-slide cm/s] [--jitter mm/frame² @30fps] [--jitter-s2 mm/s²] [--below-floor fraction] [--depth cm]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [path, ...args] = process.argv.slice(2);
	if (!path) { usage(); process.exit(2); }
	const limits = { ...DEFAULT_LIMITS };
	for (let i = 0; i < args.length; i += 2) {
		const value = Number(args[i + 1]);
		if (!Number.isFinite(value)) { usage(); process.exit(2); }
		if (args[i] === "--foot-slide") limits.maxFootSlideCmPerS = value;
		else if (args[i] === "--jitter") limits.maxJitterMmPerFrame2 = value;
		else if (args[i] === "--jitter-s2") limits.maxJitterMmPerS2 = value;
		else if (args[i] === "--below-floor") limits.maxBelowFloorFraction = value;
		else if (args[i] === "--depth") limits.maxDeepestBelowFloorCm = value;
		else { usage(); process.exit(2); }
	}
	const result = evaluateQuality(mocapMetrics(path), limits);
	console.log(JSON.stringify(result, null, 2));
	if (!result.pass) process.exitCode = 1;
}
