// What the user changed right after an agent turn: agent:post_turn_edit, one per
// turn. The window opens when a turn ends and closes 120 s later, when the next
// turn starts, or when the page goes away, whichever comes first. It counts the
// user's edits that changed the scene, by group, as the command bus records them
// (command-bus-telemetry.js: UI-origin receipts only, one drag is one receipt).
import { bucketFrictionCount } from "./analytics-friction.js";
import { bucketLong } from "./analytics-strict.js";

export const POST_TURN_WINDOW_MS = 120_000;
const GROUPS = Object.freeze(["pose", "camera", "object", "shot", "prompt"]);
let open = null;
let pageListener = false;

const defaultTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id), now: () => Date.now() };

/** Send the open window's summary, if any, and close it. */
export function closePostTurnWindow() {
	const window = open;
	if (!window) return null;
	open = null;
	try { window.timers.clear(window.timer); } catch { /* a foreign timer cannot keep the window open */ }
	const edited = window.firstAt !== null;
	const props = {
		turn_id: window.turnId, edited,
		// The prompt group is sent as prompt_block: "prompt" is a denied property key.
		...Object.fromEntries(GROUPS.map((group) => [group === "prompt" ? "prompt_block" : group, bucketFrictionCount(window.counts[group])])),
		...(edited ? { first_delay: bucketLong(window.firstAt - window.openedAt) } : {}),
	};
	try { Promise.resolve(window.emit("agent:post_turn_edit", props)).catch(() => {}); } catch { /* telemetry is advisory */ }
	return props;
}

/** A turn ended: watch the user's next 120 s. Any window still open is closed first. */
export function openPostTurnWindow(turnId, emit, timers = defaultTimers) {
	closePostTurnWindow();
	if (typeof turnId !== "string" || typeof emit !== "function") return;
	try {
		const openedAt = timers.now();
		open = { turnId, emit, timers, openedAt, firstAt: null, counts: Object.fromEntries(GROUPS.map((group) => [group, 0])) };
		open.timer = timers.set(closePostTurnWindow, POST_TURN_WINDOW_MS);
		if (!pageListener && typeof globalThis.addEventListener === "function") {
			pageListener = true;
			globalThis.addEventListener("pagehide", closePostTurnWindow);
		}
	} catch {
		open = null;
	}
}

/** One user edit of `group` (the caller passes only the user's own edits); counted while a window is open. */
export function noteEditGesture(group) {
	if (!open || !GROUPS.includes(group)) return false;
	try {
		const at = open.timers.now();
		if (at - open.openedAt >= POST_TURN_WINDOW_MS) { closePostTurnWindow(); return false; }
		open.counts[group] += 1;
		if (open.firstAt === null) open.firstAt = at;
		return true;
	} catch {
		return false;
	}
}
