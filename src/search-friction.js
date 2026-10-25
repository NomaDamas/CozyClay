// search:no_results: a search box whose query has shown nothing for 1 s.
// Only the surface and a bucket of the query's length leave; the query text
// itself never leaves this module.
import { useEffect } from "react";
import { track } from "./analytics.js";
import { admit, bump } from "./analytics-friction.js";

const STABLE_MS = 1000, PER_SURFACE = 3;
const SURFACES = new Set(["assets", "outliner"]);
let send = track, timers = { set: (run, ms) => setTimeout(run, ms), clear: (id) => clearTimeout(id) };

/** 1, 2-3, 4-8, gte9: how long a query was, never what it said. */
export function bucketQueryLength(length) {
	if (length <= 1) return "1";
	if (length <= 3) return "2-3";
	if (length <= 8) return "4-8";
	return "gte9";
}

/**
 * An empty result shown for `query` on `surface`. Once the query has stayed the
 * same for 1 s, the search_empty counter moves and search:no_results goes out
 * (3 per surface per session). Returns the cancel: a new query or results
 * showing up again before 1 s sends nothing.
 */
export function watchNoResults(surface, query) {
	const length = String(query ?? "").trim().length;
	if (!SURFACES.has(surface) || !length) return () => {};
	const id = timers.set(() => {
		try {
			bump("search_empty");
			if (admit(`search:no_results:${surface}`, PER_SURFACE)) send("search:no_results", { surface, query_len: bucketQueryLength(length) });
		} catch { /* telemetry is advisory */ }
	}, STABLE_MS);
	return () => timers.clear(id);
}

/** Wraps a search's empty state: watching while it is shown, restarted when the query changes. */
export function SearchEmpty({ surface, query, children }) {
	useEffect(() => watchNoResults(surface, query), [surface, query]);
	return children;
}

/** Tests only: capture what is sent and drive the timer; returns the restore. */
export function searchFrictionSeam({ track: capture = track, set = timers.set, clear = timers.clear } = {}) {
	const previous = [send, timers];
	send = capture; timers = { set, clear };
	return () => { [send, timers] = previous; };
}
