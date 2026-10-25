// ui:rage_click and ui:dead_click from one capture-phase pointerdown listener the
// Studio shell installs (StudioShell.jsx). Real pointer input on a natively disabled
// button still dispatches pointerdown to a document capture listener (Chrome 155,
// measured; mousedown and click do not), so no control needs the aria-disabled
// pattern for its dead clicks to be seen.
//
// Only a closed control id leaves (analytics-controls.js), never coordinates, text
// or element ids. Typing targets and IME composition are ignored outright.
import { track } from "./analytics.js";
import { admit, bump } from "./analytics-friction.js";
import { controlOf } from "./analytics-controls.js";

const RAGE_WINDOW_MS = 1000, RAGE_RADIUS_PX = 24, RAGE_MIN = 3, RAGE_COOLDOWN_MS = 10_000, EFFECT_MS = 500;
const RAGE_PER_CONTROL = 2, DEAD_PER_CONTROL = 2;
const CONTROL = "[data-fid], button, [role='button'], [role='tab'], [role='menuitem'], a[href]";

let send = track, now = () => performance.now();
let burst = null, burstTimer = null;
const lastRage = new Map();
let lastReceiptAt = -Infinity, lastRefusalAt = -Infinity, lastMutationAt = -Infinity;

/** The command bus recorded a receipt for a UI-origin command (command-bus-telemetry.js); `ok: false` is a refusal. */
export function noteBusReceipt(ok) {
	const at = now();
	lastReceiptAt = at;
	if (!ok) lastRefusalAt = at;
}

const typing = (target, event) => event?.isComposing || Boolean(target?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
const disabledOf = (control) => Boolean(control?.closest?.("[aria-disabled='true'], :disabled"));
const bucketClicks = (n) => (n >= 6 ? "gte6" : n >= 4 ? "4-5" : "3");
const emit = (event, props) => { try { send(event, props); } catch { /* telemetry is advisory */ } };

function finishBurst() {
	clearTimeout(burstTimer);
	const ended = burst;
	burst = null;
	if (!ended || ended.count < RAGE_MIN) return;
	bump("rage_clicks");
	const at = now(), last = lastRage.get(ended.control) ?? -Infinity;
	if (at - last < RAGE_COOLDOWN_MS) return;
	lastRage.set(ended.control, at);
	if (admit(`ui:rage_click:${ended.control}`, RAGE_PER_CONTROL)) emit("ui:rage_click", { control: ended.control, clicks: bucketClicks(ended.count), changed: ended.changed() });
}

function dead(control, reason) {
	bump("dead_clicks");
	if (admit(`ui:dead_click:${control}`, DEAD_PER_CONTROL)) emit("ui:dead_click", { control, reason });
}

/** One pointerdown, as the shell's capture listener sees it. `x`, `y` stay local (the rage radius). */
export function notePointerDown({ target, x, y, event, observe = () => () => {} }) {
	// A right or middle click runs no control's action: only the primary button (mouse, pen, touch: 0) counts.
	if ((event?.button ?? 0) !== 0 || typing(target, event)) return;
	const element = target?.closest?.(CONTROL);
	if (!element) return;
	const fid = element.closest("[data-fid]")?.getAttribute("data-fid");
	const control = controlOf(fid);
	const at = now();
	// A rage burst: the same control, within 1 s of its first click and 24 px of where it began.
	if (burst && burst.control === control && burst.element === element && at - burst.at <= RAGE_WINDOW_MS && Math.hypot(x - burst.x, y - burst.y) <= RAGE_RADIUS_PX) {
		burst.count += 1;
	} else {
		finishBurst();
		const since = at;
		burst = { control, element, at, x, y, count: 1, changed: () => lastReceiptAt >= since || lastMutationAt >= since };
		burstTimer = setTimeout(finishBurst, RAGE_WINDOW_MS);
	}
	if (disabledOf(element)) { dead(control, "aria_disabled"); return; }
	// refused / no_effect: watched only on the closed controls, whose clicks are meant to do something.
	if (control === "other") return;
	const stop = observe(() => { lastMutationAt = now(); });
	setTimeout(() => {
		try { stop(); } catch { /* the observer is advisory */ }
		if (lastRefusalAt >= at) dead(control, "refused");
		else if (lastReceiptAt < at && lastMutationAt < at) dead(control, "no_effect");
	}, EFFECT_MS);
}

/** The shell's listener: one capture-phase pointerdown on `root`. Returns its removal. */
export function installClickFriction(root = globalThis.document) {
	if (!root?.addEventListener) return () => {};
	const observe = (onChange) => {
		if (typeof MutationObserver !== "function") return () => {};
		const observer = new MutationObserver(onChange);
		observer.observe(root.body ?? root, { subtree: true, childList: true, attributes: true, characterData: true });
		return () => observer.disconnect();
	};
	const listener = (event) => { try { notePointerDown({ target: event.target, x: event.clientX, y: event.clientY, event, observe }); } catch { /* never affect a click */ } };
	root.addEventListener("pointerdown", listener, true);
	return () => root.removeEventListener("pointerdown", listener, true);
}

/** Tests only: capture what is sent and drive the clock; returns the restore. */
export function clickFrictionSeam({ capture = track, clock = () => performance.now() } = {}) {
	const previous = [send, now];
	send = capture; now = clock;
	const reset = () => { clearTimeout(burstTimer); burst = null; lastRage.clear(); lastReceiptAt = lastRefusalAt = lastMutationAt = -Infinity; };
	reset();
	return () => { [send, now] = previous; reset(); };
}
