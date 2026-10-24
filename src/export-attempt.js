import { bucketCount, bucketMs, exportFailureCode, sanitizeProps, track } from "./analytics.js";

// Retry re-runs the identical frozen export request, so a request seen before
// is a retry of the attempt it last started. Weak: requests are never kept.
const lastAttemptOf = new WeakMap();
const PROGRESS_STAGES = new Set(["preparing", "encoding", "finalizing"]);

/** Completed frames of the counted step as a closed percent bucket. */
function bucketProgress(done, total) {
	if (!(total > 0) || !(done > 0)) return "0";
	const percent = (done / total) * 100;
	if (percent <= 25) return "1-25";
	if (percent <= 50) return "26-50";
	if (percent <= 75) return "51-75";
	return "76-99";
}

/**
 * One user-initiated export, ending at pipeline completion/download handoff.
 * Optional { now, capture } dependencies keep fixtures deterministic. Telemetry
 * failures (including unavailable randomness) must not change export behavior.
 * `metadata.request` (never sent) identifies a retried request; a numeric
 * `metadata.objects` is sent as its count bucket.
 */
export function startExportAttempt(metadata, dependencies = {}) {
	let terminal = false;
	let props = null;
	let startedAt = NaN;
	let stage = "preparing";
	let progress = "0";
	let now = () => performance.now();
	let capture = track;
	const readClock = () => {
		try { return now(); } catch { return NaN; }
	};
	const emit = (event, payload) => {
		try {
			Promise.resolve(capture(event, sanitizeProps(event, payload))).catch(() => {
				// A rejected transport is as non-fatal as a synchronous failure.
			});
		} catch {
			// Analytics must never affect the export or its error handling.
		}
	};
	try {
		now = dependencies.now ?? now;
		capture = dependencies.capture ?? capture;
		const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
		const attempt_id = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
		const { request, objects, ...descriptor } = metadata ?? {};
		const keyed = request !== null && typeof request === "object";
		const retryOf = keyed ? lastAttemptOf.get(request) : undefined;
		props = {
			...sanitizeProps("export:attempt_started", descriptor),
			attempt_id,
			is_retry: Boolean(retryOf),
			...(retryOf ? { retry_of: retryOf } : {}),
			...(Number.isFinite(objects) ? { objects: bucketCount(objects) } : {}),
		};
		if (keyed) lastAttemptOf.set(request, attempt_id);
		startedAt = readClock();
		emit("export:attempt_started", props);
	} catch {
		// Without a secure random ID, omit the attempt rather than inventing
		// a persistent/content-derived identifier or blocking the export.
		props = null;
	}
	const finish = (result, error, fallbackCode, handedOff) => {
		if (terminal) return;
		terminal = true;
		if (!props) return;
		try {
			const payload = { ...props, duration_bucket: bucketMs(readClock() - startedAt) };
			if (result === "failed") {
				payload.failure_code = exportFailureCode(error, fallbackCode);
				if (payload.failure_code === "aborted") result = "cancelled";
				// A file already handed to the browser or folder ends the run in handoff.
				payload.stage = handedOff > 0 ? "handoff" : stage;
				payload.progress = progress;
			}
			emit(`export:attempt_${result}`, payload);
		} catch {
			// Clock/payload failures are isolated from the actual export too.
		}
	};
	return {
		/** The export's own status update: { phase, stage?, completedFrames?, frameCount? }. */
		note(phase, details = {}) {
			try {
				if (terminal || !PROGRESS_STAGES.has(phase)) return;
				stage = phase === "finalizing" && details.stage === "download" ? "handoff" : phase;
				if (Number.isFinite(details.frameCount)) progress = bucketProgress(details.completedFrames, details.frameCount);
			} catch {
				// Progress bookkeeping is advisory like the rest of the lifecycle.
			}
		},
		succeed() { finish("succeeded"); },
		fail(error, fallbackCode = "unknown", handedOff = 0) { finish("failed", error, fallbackCode, handedOff); },
	};
}
