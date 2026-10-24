// Events whose every property is checked against its own closed set, never the
// generic "short string" rule. analytics.js asks strictPropValidator(event) once
// per event; a property its validator refuses is dropped.
import { STUDIO_ERROR_CODES } from "./studio-error-codes.js";
import { sessionEndedPropAllowed } from "./analytics-values.js";
import { FRICTION_SUMMARY_KEYS, frictionPropAllowed } from "./analytics-friction.js";

const TURN_ID_PATTERN = /^[a-f0-9]{32}$/;
// The friction count vocabulary (analytics-friction.js bucketFrictionCount).
const COUNT_BUCKETS = new Set(["0", "1", "2", "3", "4-5", "6-10", "gte11"]);
const LONG_BUCKETS = new Set(["lt10s", "10-30s", "30-60s", "1-2m", "2-5m", "gte5m"]);
const AGE_BUCKETS = new Set(["lt2s", "2-10s", "10-60s", "gte60s"]);
const REFUSAL_CODES = new Set([...STUDIO_ERROR_CODES, "other"]);

/** A Studio refusal code as sent: one of STUDIO_ERROR_CODES, else "other". */
export const refusalCodeOf = (code) => (STUDIO_ERROR_CODES.includes(code) ? code : "other");

/** lt10s, 10-30s, 30-60s, 1-2m, 2-5m, gte5m: agent turns and edit windows outlast bucketMs. */
export function bucketLong(ms) {
	if (!Number.isFinite(ms) || ms < 10_000) return "lt10s";
	if (ms < 30_000) return "10-30s";
	if (ms < 60_000) return "30-60s";
	if (ms < 120_000) return "1-2m";
	if (ms < 300_000) return "2-5m";
	return "gte5m";
}

/** lt2s, 2-10s, 10-60s, gte60s: how old an edit was when it was undone. */
export function bucketAge(ms) {
	if (!Number.isFinite(ms) || ms < 2000) return "lt2s";
	if (ms < 10_000) return "2-10s";
	if (ms < 60_000) return "10-60s";
	return "gte60s";
}

const oneOf = (...values) => (value) => values.includes(value);
const inSet = (set) => (value) => set.has(value);
const turnId = (value) => typeof value === "string" && TURN_ID_PATTERN.test(value);
const bool = (value) => typeof value === "boolean";
const count = inSet(COUNT_BUCKETS);
const long = inSet(LONG_BUCKETS);

// One closed check per property. The keys are the allowlist (EVENT_PROPERTIES).
const SCHEMAS = Object.freeze({
	"studio:refused": {
		code: inSet(REFUSAL_CODES), origin: oneOf("ui", "agent"), phase: oneOf("admission", "commit"),
		group: oneOf("object", "shot", "cast", "scene", "motion", "edit", "task", "agent", "other"),
	},
	"edit:undone": {
		age: inSet(AGE_BUCKETS), kind: oneOf("pose", "camera", "object", "shot", "prompt", "agent_turn", "ik_preview", "other"),
		via: oneOf("key", "menu", "button"), result: oneOf("done", "noop", "refused"),
	},
	"agent:turn_summary": {
		turn_id: turnId, outcome: oneOf("succeeded", "failed", "cancelled"), wall: long, first_tool: long,
		tool_calls: count, tool_failed: count, refused: count, refusal_top: (value) => value === "none" || REFUSAL_CODES.has(value),
		stale_retry: count, authored: bool, drafts: count, qa_first: oneOf("clean", "problems"), qa_last: oneOf("clean", "problems"),
		qa_trend: oneOf("improved", "flat", "worse", "na"), stuck: bool, cancel_phase: oneOf("before_tool", "during_tool", "after_tool", "na"),
	},
	"agent:post_turn_edit": {
		// prompt_block, not prompt: "prompt" is a denied property key (analytics.js), whatever its value.
		turn_id: turnId, edited: bool, pose: count, camera: count, object: count, shot: count, prompt_block: count, first_delay: long,
	},
});

/** EVENT_PROPERTIES rows for the strict events defined here (app:session_ended keeps its own row). */
export const STRICT_EVENT_KEYS = Object.freeze({
	"app:friction_summary": FRICTION_SUMMARY_KEYS,
	...Object.fromEntries(Object.entries(SCHEMAS).map(([event, schema]) => [event, Object.keys(schema)])),
});

/** (key, value) => allowed, for an event with a closed schema; null for every other event. */
export function strictPropValidator(event) {
	if (event === "app:session_ended") return sessionEndedPropAllowed;
	if (event === "app:friction_summary") return frictionPropAllowed;
	const schema = SCHEMAS[event];
	return schema ? (key, value) => Object.hasOwn(schema, key) && schema[key](value) : null;
}
