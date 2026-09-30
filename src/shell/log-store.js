// Session log for the bottom dock's Log tab: toasts, generation jobs and
// export status, newest last. It is session-only (never persisted) and keeps
// a bounded tail so a long session cannot grow it without limit.
//
// The store is an immutable array plus a subscribe function, so a component
// can read it with React's useSyncExternalStore.

export const LOG_LIMIT = 200;

let entries = [];
let nextId = 1;
const listeners = new Set();

function publish(next) {
	entries = next;
	for (const listener of listeners) listener();
}

/**
 * Append one event. `key` coalesces progress: pushing the same key as the
 * newest entry updates that entry in place instead of adding a row, so an
 * encoding counter reads as one line that ticks.
 */
export function push({ kind = "info", text, key = null, at = Date.now() }) {
	const message = typeof text === "string" ? text.trim() : "";
	if (!message) return null;
	const last = entries[entries.length - 1];
	if (key !== null && last?.key === key) {
		if (last.text === message) return last;
		const updated = { ...last, text: message, at };
		publish([...entries.slice(0, -1), updated]);
		return updated;
	}
	const entry = { id: nextId++, kind, text: message, key, at };
	publish([...entries, entry].slice(-LOG_LIMIT));
	return entry;
}

export function getEntries() {
	return entries;
}

export function subscribe(listener) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function clear() {
	if (entries.length) publish([]);
}

export const logStore = { push, getEntries, subscribe, clear };
