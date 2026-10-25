// Shortcut friction: shortcut:ignored (a bound Studio key that did nothing),
// shortcut:unbound (a common combo the Studio has no binding for) and
// help:shortcuts_opened. Only a closed key class, reason or combo name leaves,
// never the key character. Keys typed into an input, textarea, select or
// contenteditable element, and keys of an IME composition, are never looked at.
import { track } from "./analytics.js";
import { admit, bump } from "./analytics-friction.js";
import { isImeComposing } from "./ime.js";

const IGNORED_PER_CLASS = 5, UNBOUND_PER_COMBO = 3, HELP_PER_SESSION = 3;
let send = track, defer = (run) => setTimeout(run, 0), listening = false;

const emit = (event, props) => {
	try { send(event, props); } catch { /* telemetry is advisory */ }
};

/** A target the user types into: its keys are text, never shortcuts. */
function isTypingTarget(target) {
	return Boolean(target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(String(target.tagName ?? ""))));
}

/**
 * A bound shortcut that did nothing. `keyClass` is one of undo, redo, mode,
 * transform, frame, duplicate, delete; `reason` one of no_selection, wrong_mode,
 * workflow_mode, busy, empty_history (analytics-strict.js). The friction
 * counter moves every time; the event goes out 5 times per class per session.
 */
export function noteShortcutIgnored(keyClass, reason) {
	try {
		bump("shortcut_ignored");
		if (admit(`shortcut:ignored:${keyClass}`, IGNORED_PER_CLASS)) emit("shortcut:ignored", { key_class: keyClass, reason });
	} catch { /* telemetry is advisory */ }
}

/** Ctrl/Cmd+Z (undo) or Ctrl/Cmd+Shift+Z (redo) from the keyboard: its bus receipt says whether anything moved. */
export function noteHistoryKey(keyClass, receipt) {
	// A refused undo names a running task that owns the last edit (scene-undo.js).
	if (receipt?.ok === false) noteShortcutIgnored(keyClass, "busy");
	else if (receipt?.status === "noop") noteShortcutIgnored(keyClass, "empty_history");
}

/**
 * A key that reached the global handler's "nothing selected" exit (App.jsx):
 * F, Ctrl/Cmd+D and Delete/Backspace need a selection there. Another handler
 * (a path point, a cut, a board panel) may own the key, so only a press no
 * handler claimed (defaultPrevented false after dispatch) counts.
 */
export function noteUnselectedKey(event) {
	if (!event || event.repeat || isImeComposing(event)) return;
	const mod = event.ctrlKey || event.metaKey;
	const keyClass = event.code === "KeyF" && !mod && !event.altKey ? "frame"
		: event.code === "KeyD" && mod && !event.altKey && !event.shiftKey ? "duplicate"
			: (event.key === "Delete" || event.key === "Backspace") && !mod ? "delete" : null;
	if (!keyClass) return;
	defer(() => { if (!event.defaultPrevented) noteShortcutIgnored(keyClass, "no_selection"); });
}

const modOnly = (event) => (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
const bare = (event) => !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
// The closed combo list, by physical key code (a keyboard layout or an IME never
// changes it). F2 (rename) is the one bare key; every other combo is modifier + key.
// Save, zoom-to-fit, focus-selected and deselect are left out: Ctrl/Cmd+S is bound
// (MenuBar.jsx), and the others have no modifier combo common enough to name.
const COMBOS = [
	["copy", (event) => modOnly(event) && event.code === "KeyC"],
	["paste", (event) => modOnly(event) && event.code === "KeyV"],
	["cut", (event) => modOnly(event) && event.code === "KeyX"],
	["select_all", (event) => modOnly(event) && event.code === "KeyA"],
	["group", (event) => modOnly(event) && event.code === "KeyG"],
	["find", (event) => modOnly(event) && event.code === "KeyF"],
	["rename", (event) => bare(event) && event.code === "F2"],
	["help", (event) => event.code === "Slash" && !event.altKey && (event.shiftKey || event.ctrlKey || event.metaKey)],
];
export const UNBOUND_COMBOS = Object.freeze(COMBOS.map(([name]) => name));

/** The closed combo name of a keydown, or null. */
export function comboOf(event) {
	return COMBOS.find(([, matches]) => matches(event))?.[0] ?? null;
}

// Copying or cutting page text the user selected is the browser's own job.
const hasTextSelection = () => {
	try { return globalThis.getSelection?.()?.isCollapsed === false; } catch { return false; }
};

/**
 * A keydown on the window, in the bubble phase. It is judged after dispatch
 * (deferred), so every Studio handler has run: a combo none of them claimed
 * (defaultPrevented false) is unbound. Capture-phase handlers that stop the
 * event (controls.jsx onEscapeCapture, object-gizmo.jsx's drag Escape) are
 * invisible here; none of them handles a combo on the list.
 */
export function noteUnboundKey(event) {
	if (!event || event.repeat || isImeComposing(event) || isTypingTarget(event.target)) return null;
	const combo = comboOf(event);
	if (!combo || ((combo === "copy" || combo === "cut") && hasTextSelection())) return null;
	defer(() => {
		if (event.defaultPrevented) return;
		if (admit(`shortcut:unbound:${combo}`, UNBOUND_PER_COMBO)) emit("shortcut:unbound", { combo });
	});
	return combo;
}

/** Install the unbound-combo listener once (main.jsx). */
export function listenForUnboundShortcuts(target = globalThis.window) {
	if (listening || typeof target?.addEventListener !== "function") return false;
	target.addEventListener("keydown", noteUnboundKey);
	listening = true;
	return true;
}

/** Help > Keyboard shortcuts opened: 3 per session. */
export function noteShortcutsOpened() {
	if (admit("help:shortcuts_opened", HELP_PER_SESSION)) emit("help:shortcuts_opened", {});
}

/** Tests only: capture what is sent and run deferred checks by hand; returns the restore. */
export function shortcutFrictionSeam({ track: capture = track, defer: later = defer } = {}) {
	const previous = [send, defer];
	send = capture; defer = later;
	return () => { [send, defer] = previous; };
}
