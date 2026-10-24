// motion:draft_compiled: one event per motion.compile draft (commands/motion3.js, right
// after publishDraft), so the compile -> QA -> repair loop is visible per draft. Only
// counts, buckets and flags leave: never the spec, the take, skill names or QA text.
// At most 50 per session; past the cap only the friction counter `compiles` moves.
import { track } from "./analytics.js";
import { admit, bucketFrictionCount, bucketShortMs, bump } from "./analytics-friction.js";
import { qaProblems } from "./qa-label.js";

const DRAFTS_PER_SESSION = 50;
let send = track;

function bucketQaFrames(n) {
	if (!(n > 0)) return "0";
	if (n <= 10) return "1-10";
	if (n <= 50) return "11-50";
	if (n <= 200) return "51-200";
	return "gte201";
}

function bucketFrames(n) {
	if (!(n >= 30)) return "lt30";
	if (n <= 120) return "30-120";
	if (n <= 480) return "121-480";
	return "gte481";
}

/**
 * The draft publishDraft just stored (`n`: its ordinal for the character this turn,
 * from 1) and the compile result `r`: qa, ms.total (the whole compile, which includes
 * QA; the pipeline has no separate QA time), frameCount, search. `flags` are the
 * handler's own: installed, stuck, repaired, adjusted.
 */
export function noteDraftCompiled(draft, r, { installed = false, stuck = false, repaired = false, adjusted = false } = {}) {
	try {
		bump("compiles");
		const problems = qaProblems(r?.qa);
		const props = {
			draft_index: bucketFrictionCount(draft?.n),
			qa_clean: problems === 0,
			qa_problems: bucketFrictionCount(problems),
			// QA records one issue per frame per group (qa-label.js): frame-level issues, not distinct frames.
			qa_frames: bucketQaFrames(r?.qa?.total ?? 0),
			compile: bucketShortMs(r?.ms?.total),
			installed: Boolean(installed), stuck: Boolean(stuck), repaired: Boolean(repaired),
			searched: Boolean(r?.search), adjusted: Boolean(adjusted),
			frames: bucketFrames(r?.frameCount),
		};
		// The payload is built first: a malformed result takes no slot of the cap.
		if (admit("motion:draft_compiled", DRAFTS_PER_SESSION)) send("motion:draft_compiled", props);
	} catch {
		// Telemetry must never affect a compile.
	}
}

/** Tests only: capture what is sent; returns the restore. */
export function draftTelemetrySeam(capture) {
	const previous = send;
	send = capture;
	return () => { send = previous; };
}
