// Studio-shell signals with closed values only:
// - studio:ready, once per session: navigation start to the first frame after the
//   first React commit (StudioReadyMark in main.jsx). It never delays the render.
// - agent:panel_toggled, at most 10 per session: Cmd/Ctrl+B or the toolbar control.
// - object:deleted_soon and object:delete_undone, at most 10 each per session.
//   Object ids are slugs a re-created object of the same kind can reuse, so only an
//   id this session created counts, and the age is an ESTIMATE.
// Never object ids, names, kinds or anything the user typed.
import { useEffect } from "react";
import { initAnalytics, track } from "./analytics.js";
import { admit } from "./analytics-friction.js";
import { bucketAge } from "./analytics-strict.js";

// Mirrors OBJECT_DELETE_UNDO_MS (stage-startup-defaults.js); test/verify-analytics.mjs checks both.
export const DELETE_UNDO_WINDOW_MS = 7000;
const PANEL_TOGGLES_PER_SESSION = 10, DELETES_PER_SESSION = 10;

let send = track, clock = () => Date.now();
// studio:ready lands before the SDK has loaded; initAnalytics() is idempotent (main.jsx started it).
let sendWhenReady = (event, props) => { initAnalytics().then(() => send(event, props), () => {}); };
const created = new Map(), deleted = new Map();
const guarded = (run) => { try { run(); } catch { /* Telemetry must never affect the studio. */ } };

/** lt2s, 2-5s, 5-15s, gte15s from navigation start. */
export function bucketBoot(ms) {
	if (!Number.isFinite(ms) || ms < 2000) return "lt2s";
	if (ms < 5000) return "2-5s";
	if (ms < 15_000) return "5-15s";
	return "gte15s";
}

/** The first frame after the first render; `ms` is performance.now() (navigation start origin). */
export function noteStudioReady(ms) {
	guarded(() => {
		if (Number.isFinite(ms) && ms >= 0 && admit("studio:ready", 1)) sendWhenReady("studio:ready", { boot: bucketBoot(ms) });
	});
}

/** Renders nothing; after the first commit it waits one frame and reports studio:ready. */
export function StudioReadyMark() {
	useEffect(() => {
		const raf = globalThis.requestAnimationFrame;
		if (typeof raf !== "function") return undefined;
		const id = raf(() => noteStudioReady(performance.now()));
		return () => globalThis.cancelAnimationFrame?.(id);
	}, []);
	return null;
}

/** The agent panel is about to flip; `wasCollapsed` is its state before the toggle. */
export function notePanelToggled(wasCollapsed, via) {
	guarded(() => {
		if (typeof wasCollapsed !== "boolean" || !["key", "button"].includes(via)) return;
		if (admit("agent:panel_toggled", PANEL_TOGGLES_PER_SESSION)) send("agent:panel_toggled", { open: wasCollapsed, via });
	});
}

/** The user added object `id` (Add menu, Assets shelf). */
export function noteObjectCreated(id) {
	guarded(() => { if (id) created.set(id, clock()); });
}

/** The user deleted object `id`; object:deleted_soon only when this session created that id. */
export function noteObjectDeleted(id) {
	guarded(() => {
		if (!id) return;
		const now = clock(), bornAt = created.get(id);
		deleted.set(id, now);
		if (bornAt === undefined) return;
		created.delete(id);
		if (admit("object:deleted_soon", DELETES_PER_SESSION)) send("object:deleted_soon", { age: bucketAge(now - bornAt) });
	});
}

/** The deletion of `id` was undone; counts only inside the delete-undo window. */
export function noteDeleteUndone(id) {
	guarded(() => {
		const deletedAt = deleted.get(id);
		if (deletedAt === undefined) return;
		deleted.delete(id);
		const age = clock() - deletedAt;
		if (age >= 0 && age <= DELETE_UNDO_WINDOW_MS && admit("object:delete_undone", DELETES_PER_SESSION)) {
			send("object:delete_undone", { age: bucketAge(age) });
		}
	});
}

/** Tests only: capture what is sent (studio:ready too) and drive the clock; returns the restore. */
export function studioTelemetrySeam(capture, now) {
	const previous = [send, clock, sendWhenReady];
	send = capture;
	sendWhenReady = capture;
	if (now) clock = now;
	created.clear();
	deleted.clear();
	return () => { [send, clock, sendWhenReady] = previous; created.clear(); deleted.clear(); };
}
