// nav:thrash and camera:thrash: flipping between panels or modes, or moving the
// camera again and again, with no edit in between. "No edit" is the command
// bus's user-edit path (command-bus-telemetry.js lastUserEditAt): agent, MCP,
// undo and redo receipts never count as an edit. Only closed values leave: a
// surface, a count bucket, a gesture-kind mix and the fixed window.
import { track } from "./analytics.js";
import { bucketFrictionCount, bump } from "./analytics-friction.js";
import { lastUserEditAt } from "./command-bus-telemetry.js";

const COOLDOWN_MS = 30_000;
let send = track, clock = () => Date.now(), lastEdit = lastUserEditAt;
let timers = { set: (run, ms) => setTimeout(run, ms), clear: (id) => clearTimeout(id) };

/** 4-5, 6-10, gte11: how many switches a thrash window held (4 is the threshold). */
const bucketSwitches = (count) => (count <= 5 ? "4-5" : count <= 10 ? "6-10" : "gte11");
const kindMix = (kinds) => (new Set(kinds).size === 1 ? kinds[0] : "mixed");

/**
 * `threshold` events inside `windowMs`, all after the last user edit, open a
 * window that closes `windowMs` after its first event; at the close the event
 * goes out with everything that window held, and a 30 s cooldown starts. A
 * window that opens during the cooldown only moves the counter. A user edit after
 * a window opened cancels it: the next event starts over from the events after
 * that edit, so a fresh run of switches is judged on its own window.
 */
function createDetector({ event, counter, threshold, windowMs, props }) {
	let stamps = [], open = null, cooledUntil = -Infinity;
	const fresh = (now) => {
		const edit = lastEdit();
		return stamps.filter(({ at }) => at > edit && at > now - windowMs);
	};
	const close = (start) => {
		open = null;
		const edit = lastEdit();
		const held = stamps.filter(({ at }) => at > edit && at >= start && at <= start + windowMs);
		stamps = [];
		if (held.length < threshold) return;
		bump(counter);
		cooledUntil = clock() + COOLDOWN_MS;
		try { send(event, props(held)); } catch { /* telemetry is advisory */ }
	};
	return {
		note(kind) {
			if (open && lastEdit() >= open.start) { timers.clear(open.id); open = null; }
			if (open) { stamps.push({ at: clock(), kind }); return; }
			const now = clock();
			stamps = [...fresh(now), { at: now, kind }];
			if (stamps.length < threshold) return;
			if (now < cooledUntil) { bump(counter); stamps = []; return; }
			const start = stamps[0].at;
			open = { start, id: timers.set(() => close(start), Math.max(0, start + windowMs - now)) };
		},
		reset() { if (open) timers.clear(open.id); stamps = []; open = null; cooledUntil = -Infinity; },
	};
}

const NAV_SURFACES = ["dock_tab", "mode", "agent_panel"];
const nav = Object.fromEntries(NAV_SURFACES.map((surface) => [surface, createDetector({
	event: "nav:thrash", counter: "nav_thrash", threshold: 4, windowMs: 10_000,
	props: (held) => ({ surface, switches: bucketSwitches(held.length), window_s: 10 }),
})]));
const camera = createDetector({
	event: "camera:thrash", counter: "camera_thrash", threshold: 6, windowMs: 20_000,
	props: (held) => ({ gestures: bucketFrictionCount(held.length), kind_mix: kindMix(held.map(({ kind }) => kind)), window_s: 20 }),
});

/**
 * One user switch on `surface`: dock_tab (StudioShell.jsx), mode (App.jsx
 * selectWorkflowMode) or agent_panel (App.jsx, the agent panel toggle). 4 or
 * more in 10 s with no edit is a thrash; 30 s cooldown per surface.
 */
export function noteNavSwitch(surface) {
	try { nav[surface]?.note(surface); } catch { /* telemetry is advisory */ }
}

/** One finished camera gesture that moved the view (controls.jsx): orbit, fly or pan. 6 or more in 20 s with no edit. */
export function noteCameraGesture(kind) {
	try { if (kind === "orbit" || kind === "fly" || kind === "pan") camera.note(kind); } catch { /* telemetry is advisory */ }
}

/** Tests only: capture what is sent, drive the clock, timers and last edit; returns the restore. */
export function thrashSeam({ track: capture = track, now = clock, set = timers.set, clear = timers.clear, lastEditAt = lastEdit } = {}) {
	const previous = [send, clock, timers, lastEdit];
	send = capture; clock = now; timers = { set, clear }; lastEdit = lastEditAt;
	for (const detector of [...Object.values(nav), camera]) detector.reset();
	return () => {
		for (const detector of [...Object.values(nav), camera]) detector.reset();
		[send, clock, timers, lastEdit] = previous;
	};
}
