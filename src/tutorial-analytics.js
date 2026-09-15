import { bucketMs, getAnalyticsOptOut, initAnalytics, track } from "./analytics.js";

const KINDS = new Set(["fly", "walk", "dolly", "orbit", "shot", "rail", "play"]);
const SOURCES = new Set(["query", "settings", "landing"]);

/** One explicit opening, never persisted or identified on the wire. The UI's
 * done/current state is authoritative; this observer cannot advance a step.
 * Reuse the object on rerender/BFCache resume, create another on explicit start
 * or reload, and call dismiss only for an explicit close (not effect cleanup).
 *
 * Buckets use occurrence time even while initAnalytics is pending. The existing
 * two-argument track API uses capture timestamps, so a delayed SDK flush cannot
 * preserve exact started->play timestamp differences. No raw time is sent.
 */
export function createTutorialAnalytics({ surface, startSource }, {
	now = () => performance.now(),
	initialize = initAnalytics,
	capture = track,
	optedOut = getAnalyticsOptOut,
} = {}) {
	const metadata = { surface: surface === "playground" ? "playground" : "studio", tutorial_version: 1 };
	const startedAt = now();
	const entered = new Map();
	const completed = new Set();
	let currentStep = "fly";
	let terminal = false;
	let initialized = false;
	let muted = false;
	let pending = [];
	const canCapture = () => {
		// Do not replay an opted-out portion of an attempt after later opt-in,
		// or emit orphan completions for a suppressed started/entered marker.
		if (optedOut()) muted = true;
		if (muted) pending = [];
		return !muted;
	};
	const emit = (event, props = {}) => {
		if (!canCapture()) return;
		const payload = { ...metadata, ...props };
		if (initialized) capture(event, payload);
		else pending.push([event, payload]);
	};
	const enter = (kind, at) => {
		if (!KINDS.has(kind) || entered.has(kind)) return;
		entered.set(kind, at);
		emit("tutorial:step_entered", { step_kind: kind });
	};
	emit("tutorial:started", { start_source: SOURCES.has(startSource) ? startSource : "settings" });
	enter("fly", startedAt);
	const ready = Promise.resolve(initialize()).then(() => {
		initialized = true;
		if (!canCapture()) return;
		const events = pending;
		pending = [];
		for (const [event, props] of events) {
			if (!canCapture()) break;
			capture(event, props);
		}
	});
	return {
		ready,
		observe(done, currentKind) {
			if (terminal) return;
			const at = now();
			currentStep = KINDS.has(currentKind) ? currentKind : null;
			for (const kind of done) {
				if (!KINDS.has(kind) || completed.has(kind)) continue;
				// Existing tutorials accept out-of-order gestures. Give those an
				// entry at observation time, without moving their visible hint.
				enter(kind, at);
				completed.add(kind);
				emit("tutorial:step_completed", { step_kind: kind, elapsed_bucket: bucketMs(at - entered.get(kind)) });
			}
			enter(currentStep, at);
			if (completed.size === KINDS.size) {
				terminal = true;
				emit("tutorial:completed", { elapsed_bucket: bucketMs(at - startedAt) });
			}
		},
		dismiss() {
			if (terminal) return;
			terminal = true;
			emit("tutorial:dismissed", { step_kind: currentStep });
		},
	};
}
