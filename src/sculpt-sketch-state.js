// The live sketch of the running agent turn: the sculpt, primitive and character creations a tool call has
// written so far, as the sidecar's sculpt.sketch frames carry them (bin/agent/sculpt-sketch.mjs), drawn as ghost clay.
// In-page only and per turn: nothing here is saved, undone, exported or sent to the agent. A call's sketch goes
// when its tool.done arrives (the real objects are in the scene by then, or were refused), and everything goes
// when the turn ends, fails or is stopped (agent-client.js clears it), so no ghost outlives its turn.
import { expandSculptParts, normalizeSculptRecipe } from "./sculpt-recipe.js";

const MAX_PARTS = 300;
const EMPTY = Object.freeze([]);
const sketches = new Map(), finished = new Set(), listeners = new Set();
let snapshot = EMPTY;

function emit() {
	snapshot = Object.freeze([...sketches].flatMap(([call, groups]) => groups.map((group) => ({ ...group, key: `${call}/${group.key}` }))));
	for (const listener of [...listeners]) {
		try { listener(); } catch { /* a broken view never stops the turn */ }
	}
}

/**
 * sculptSketchFrame(event) takes every frame of the running turn: sculpt.sketch sets (or, with no groups, drops)
 * one call's sketch; tool.done drops that call's sketch and ignores any sketch of it that arrives later (the final
 * one can trail a quick tool); done and error end the turn's sketches.
 */
export function sculptSketchFrame(event) {
	if (event?.type === "sculpt.sketch") {
		const call = typeof event.callId === "string" && event.callId ? event.callId : `#${event.index}`;
		if (finished.has(call)) return;
		// The same call sketched before its id was known (bin/agent/sculpt-sketch.mjs).
		const unnamed = call !== `#${event.index}` && sketches.delete(`#${event.index}`);
		const groups = (Array.isArray(event.groups) ? event.groups : [])
			.filter((group) => group && typeof group.key === "string" && Array.isArray(group.parts) && group.parts.length);
		if (groups.length) sketches.set(call, groups);
		else if (!sketches.delete(call) && !unnamed) return;
		emit();
	} else if (event?.type === "tool.done" && typeof event.callId === "string") {
		finished.add(event.callId);
		if (sketches.delete(event.callId)) emit();
	} else if (event?.type === "done" || event?.type === "error") clearSculptSketch();
}

/** Forget every sketch of the turn (it ended, failed or was stopped). */
export function clearSculptSketch() {
	finished.clear();
	if (!sketches.size) return;
	sketches.clear();
	emit();
}

/** subscribeSculptSketch(listener) -> unsubscribe; with sculptSketchSnapshot it fits React's useSyncExternalStore. */
export function subscribeSculptSketch(listener) {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

/** Every group being sketched, [{ key, name?, target?, placement?, parts }]; the same array until a frame changes it. */
export const sculptSketchSnapshot = () => snapshot;

/**
 * sketchDrawnParts(parts) -> the parts a ghost draws, as expandSculptParts gives them (object-frame matrix, mirrors
 * expanded). Lenient where the real recipe is strict: each part is checked on its own and a bad one is dropped, not
 * the whole recipe, and a part whose parent is not written yet waits, because a sketch is a recipe half written.
 */
export function sketchDrawnParts(parts) {
	const drawable = [], ids = new Set();
	for (const raw of Array.isArray(parts) ? parts.slice(0, MAX_PARTS) : []) {
		if (!raw || typeof raw !== "object" || ids.has(raw.id)) continue;
		const { parent, mirror, ...own } = raw;
		const checked = normalizeSculptRecipe({ version: 1, parts: [own] });
		if (!checked.ok || checked.recipe.parts[0].op) continue;
		ids.add(raw.id);
		drawable.push({ ...checked.recipe.parts[0], ...(typeof parent === "string" && parent ? { parent } : {}), ...(mirror === true ? { mirror: true } : {}) });
	}
	// expandSculptParts walks down from the roots, so an orphan (or a parent cycle) is never reached.
	return expandSculptParts({ version: 1, parts: drawable });
}
