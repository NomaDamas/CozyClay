import { useSyncExternalStore } from "react";

const KEY = "cozyclay.viewport-tools.v1";
const DEFAULTS = Object.freeze({ xray: false, surfaceSnap: false, measure: false, annotate: false });
let current = { ...DEFAULTS };
try {
	const saved = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "null");
	if (saved && typeof saved === "object") current = { ...DEFAULTS, ...saved, measure: false, annotate: false };
} catch { /* viewer preferences never block the Studio */ }
const listeners = new Set();
const emit = () => { for (const listener of listeners) listener(); };

export function viewportTools() { return current; }
export function setViewportTool(name, value) {
	if (!(name in DEFAULTS)) return;
	current = { ...current, [name]: Boolean(value) };
	try {
		const { measure, annotate, ...persisted } = current;
		globalThis.localStorage?.setItem(KEY, JSON.stringify(persisted));
	} catch { /* non-fatal */ }
	emit();
}
export function toggleViewportTool(name) { setViewportTool(name, !current[name]); }
function subscribeViewportTools(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function useViewportTools() { return useSyncExternalStore(subscribeViewportTools, viewportTools, () => DEFAULTS); }
