// Session friction counters for app:friction_summary, sent once at session end.
// Detectors bump a counter on every occurrence; a detector that also has its
// own event asks admit() first, so past its per-session cap only the counter
// here moves. Counts leave only as closed buckets. Nothing here reads input
// elements or text: callers pass counts and durations, never content.
import { SESSION_DURATION_BUCKETS } from "./analytics-values.js";

// Counters with a source today: refusals_ui/refusals_agent and undos (command
// bus), errors (app:error listener, ErrorBoundary), long_tasks (longtask observer), compiles
// (every motion.compile draft, motion-draft-telemetry.js). The rest
// are reserved names for the click, shortcut, search, thrash and playback
// detectors; they report "0" until those land.
const COUNTERS = Object.freeze([
	"refusals_ui", "refusals_agent", "undos", "errors", "rage_clicks", "dead_clicks",
	"shortcut_ignored", "search_empty", "nav_thrash", "camera_thrash", "long_tasks", "compiles",
]);
export const FRICTION_SUMMARY_KEYS = Object.freeze(["active_time", ...COUNTERS, "long_task_max", "late_tick_ratio"]);
const COUNT_BUCKETS = new Set(["0", "1", "2", "3", "4-5", "6-10", "gte11"]);
const LONG_TASK_BUCKETS = new Set(["lt50", "50-150", "150-500", "500-2000", "gte2000"]);
const LATE_TICK_BUCKETS = new Set(["0", "lt5", "5-20", "20-50", "gte50"]);

const counts = new Map(COUNTERS.map((name) => [name, 0]));
const admitted = new Map();
let longTaskMax = 0;
let lateTicks = 0;
let totalTicks = 0;
let observing = false;

/** 0, 1, 2, 3, 4-5, 6-10, gte11: small counts stay distinguishable. */
export function bucketFrictionCount(value) {
	const count = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
	if (count <= 3) return String(count);
	if (count <= 5) return "4-5";
	if (count <= 10) return "6-10";
	return "gte11";
}

/** lt50, 50-150, 150-500, 500-2000, gte2000 ms: long tasks and compile times. */
export function bucketShortMs(ms) {
	if (!(ms >= 50)) return "lt50";
	if (ms < 150) return "50-150";
	if (ms < 500) return "150-500";
	if (ms < 2000) return "500-2000";
	return "gte2000";
}

/** Share of playback ticks that ran late, as a closed percent bucket. */
function bucketLateTicks(late, total) {
	if (!(total > 0) || !(late > 0)) return "0";
	const percent = (late / total) * 100;
	if (percent < 5) return "lt5";
	if (percent < 20) return "5-20";
	if (percent < 50) return "20-50";
	return "gte50";
}

/** Count n occurrences of a known counter. Unknown names are ignored. */
export function bump(name, n = 1) {
	if (!counts.has(name) || !Number.isFinite(n) || n < 1) return false;
	counts.set(name, counts.get(name) + Math.floor(n));
	return true;
}

/** True while `event` has been admitted fewer than `cap` times this session. */
export function admit(event, cap) {
	const seen = admitted.get(event) ?? 0;
	if (!(seen < cap)) return false;
	admitted.set(event, seen + 1);
	return true;
}

export function noteLongTask(ms) {
	if (!Number.isFinite(ms) || ms < 0) return;
	bump("long_tasks");
	longTaskMax = Math.max(longTaskMax, ms);
}

/** One playback run's ticks: how many ran late out of how many. */
export function noteTick(late, total) {
	if (!Number.isInteger(late) || !Number.isInteger(total) || late < 0 || total < late) return;
	lateTicks += late;
	totalTicks += total;
}

/** Feed long tasks into the counters where the browser reports them; a no-op elsewhere. */
export function observeLongTasks(Observer = globalThis.PerformanceObserver) {
	if (observing) return true;
	try {
		if (typeof Observer !== "function" || !Observer.supportedEntryTypes?.includes("longtask")) return false;
		new Observer((list) => {
			for (const entry of list.getEntries()) noteLongTask(entry.duration);
		}).observe({ type: "longtask" });
		observing = true;
		return true;
	} catch {
		return false;
	}
}

/** The session's counters as closed buckets, without active_time. */
export function snapshot() {
	return {
		...Object.fromEntries([...counts].map(([name, count]) => [name, bucketFrictionCount(count)])),
		long_task_max: bucketShortMs(longTaskMax),
		late_tick_ratio: bucketLateTicks(lateTicks, totalTicks),
	};
}

/** One app:friction_summary property, checked against its closed set. */
export function frictionPropAllowed(key, value) {
	if (key === "active_time") return SESSION_DURATION_BUCKETS.has(value);
	if (key === "long_task_max") return LONG_TASK_BUCKETS.has(value);
	if (key === "late_tick_ratio") return LATE_TICK_BUCKETS.has(value);
	return counts.has(key) && COUNT_BUCKETS.has(value);
}

/** Tests only: a fresh session. The long-task observer stays installed. */
export function reset() {
	for (const name of counts.keys()) counts.set(name, 0);
	admitted.clear();
	longTaskMax = 0;
	lateTicks = 0;
	totalTicks = 0;
}
