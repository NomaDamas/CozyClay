// update:notice_shown, update:clicked, update:finished (the U1 update notice) and
// update:restarted (Restart now, #960).
// Only closed values leave: the install kind, how far behind (patch/minor/major),
// the button, the outcome, the npm error class and a duration bucket. Never a
// version string, a path, a command or npm's output. All three are passive
// (analytics-strict.js), so none of them moves action_count_bucket.
import { initAnalytics, track } from "../analytics.js";
import { admit } from "../analytics-friction.js";
import { bucketLong } from "../analytics-strict.js";

const CLICKS_PER_SESSION = 10;
const FINISHED_PER_SESSION = 3;
const NOTICE_KINDS = new Set(["global", "npx"]);
const CLICK_ACTIONS = new Set(["update_now", "copy_command", "later", "dismiss", "release_notes", "restart"]);
const RESTART_OUTCOMES = new Set(["ok", "timeout"]);
// The install this browser already reported, shared by the tabs of one profile:
// several tabs (and several polls) see the same terminal phase, the event leaves once.
const REPORTED_KEY = "cozyclay:update-reported";

let send = (event, props) => {
	initAnalytics().then(() => track(event, props), () => {});
};
let storage = () => globalThis.localStorage;
const reportedHere = new Set();

/** The chip became visible in the "available" view: once per session. */
export function noteNoticeShown(state) {
	try {
		if (state?.view !== "available" || !NOTICE_KINDS.has(state.kind)) return;
		if (admit("update:notice_shown", 1)) send("update:notice_shown", { kind: state.kind, behind: state.behind });
	} catch {
		// Telemetry must never affect the notice.
	}
}

/** A notice button: update_now (also Try again), copy_command, later, dismiss, release_notes or restart. */
export function noteUpdateClicked(action, kind) {
	try {
		if (!CLICK_ACTIONS.has(action) || !NOTICE_KINDS.has(kind)) return;
		if (admit("update:clicked", CLICKS_PER_SESSION)) send("update:clicked", { action, kind });
	} catch {
		// Telemetry must never affect the notice.
	}
}

/** Restart now ended in the tab that pressed it: the new launcher answered (ok) or 30 s passed (timeout). Once per session. */
export function noteUpdateRestarted(outcome) {
	try {
		if (!RESTART_OUTCOMES.has(outcome)) return;
		if (admit("update:restarted", 1)) send("update:restarted", { outcome });
	} catch {
		// Telemetry must never affect the restart.
	}
}

function claim(key) {
	if (reportedHere.has(key)) return false;
	reportedHere.add(key);
	try {
		const store = storage();
		if (store?.getItem(REPORTED_KEY) === key) return false;
		store?.setItem(REPORTED_KEY, key);
	} catch {
		// No storage: this page's own memory still keeps it to once.
	}
	return true;
}

/** A poll result. A terminal install phase with its duration sends update:finished, once per install. */
export function noteUpdatePolled(info) {
	try {
		if (!info || (info.phase !== "restart_needed" && info.phase !== "failed") || !Number.isFinite(info.durationMs)) return;
		// The launcher holds one install at a time; its version, phase and wall time name it.
		if (!claim(`${info.latest}|${info.phase}|${info.durationMs}`)) return;
		if (!admit("update:finished", FINISHED_PER_SESSION)) return;
		const failed = info.phase === "failed";
		send("update:finished", { outcome: failed ? "failed" : "ok", error_class: failed ? info.errorClass ?? "other" : "none", duration: bucketLong(info.durationMs) });
	} catch {
		// Telemetry must never affect the poll.
	}
}

/** Tests only: capture what is sent and substitute the storage; returns the restore. */
export function updateTelemetrySeam(capture, store = null) {
	const previous = { send, storage };
	send = capture;
	storage = () => store;
	reportedHere.clear();
	return () => { ({ send, storage } = previous); reportedHere.clear(); };
}
