import { bucketMs, track, EXECUTION_TELEMETRY_VALUES } from "./analytics.js";
export { AGENT_TOOL_CATEGORIES, MCP_TOOL_CATEGORIES, EXECUTION_TELEMETRY_EVENTS, EXECUTION_TELEMETRY_PROPERTY_KEYS, EXECUTION_TELEMETRY_VALUES } from "./analytics.js";
const WORKFLOW_FAILURE_CODES = new Set(["aborted", "capture_failed", "generation_failed", "unknown"]);
const AGENT_FAILURE_CODES = new Set(["aborted", "auth", "rate_limited", "tool_failed", "upstream", "unknown"]);
function secureId() {
	try {
		if (!globalThis.crypto?.getRandomValues) return null;
		const bytes = new Uint8Array(16);
		globalThis.crypto.getRandomValues(bytes);
		return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	} catch {
		return null;
	}
}

function safeCapture(capture, event, props) {
	try {
		Promise.resolve(capture(event, props)).catch(() => {
			// Analytics transport rejection cannot change execution.
		});
	} catch {
		// Execution telemetry must never affect the command it observes.
	}
}

function readNow(now) {
	try {
		return now();
	} catch {
		return NaN;
	}
}

export function executionFailureCode(error, channel, fallbackCode = "unknown") {
	const allowed = channel === "agent" ? AGENT_FAILURE_CODES : WORKFLOW_FAILURE_CODES;
	try {
		if (error?.name === "AbortError") return "aborted";
	} catch {
		// Cross-realm errors can expose throwing getters.
	}
	return allowed.has(fallbackCode) ? fallbackCode : "unknown";
}

export function mcpToolCategory(name) {
	if (name === "generate_motion") return "motion_generate";
	if (name === "load_motion") return "motion_apply";
	if (name === "capture_frame") return "frame_capture";
	if (name === "set_camera" || name === "frame_shot" || name === "mark_camera_move" || name === "describe_camera_move") return "camera";
	if (name === "set_prompt_blocks") return "prompt_authoring";
	if (name === "save_project" || name === "open_project") return "project_io";
	if (name === "describe_scene" || name === "describe_shot" || name === "render_prompt" || name === "live_status") return "read";
	if (name === "add_character" || name === "place_character" || name === "remove_character" || name === "focus_character" || name === "place_object" || name === "import_mesh" || name === "group_objects" || name === "update_object" || name === "remove_object" || name === "apply_batch" || name === "add_scene" || name === "switch_scene") return "scene_write";
	return "other";
}

export function startWorkflowExecution(metadata, { capture = track, now = () => performance.now(), durationBucket = bucketMs } = {}) {
	const runId = secureId();
	let terminal = false;
	let applied = false;
	const startedAt = readNow(now);
	const emit = (event, props) => {
		if (runId) safeCapture(capture, event, props);
	};
	if (runId) emit("workflow:run_requested", {
		surface: "workflow",
		...(EXECUTION_TELEMETRY_VALUES.node_count_bucket.has(metadata.node_count_bucket) ? { node_count_bucket: metadata.node_count_bucket } : {}),
		run_id: runId,
	});
	const finish = (outcome, error, fallbackCode) => {
		if (terminal || !runId) return;
		terminal = true;
		const failureCode = executionFailureCode(error, "workflow", fallbackCode);
		const result = outcome === "failed" && failureCode === "aborted" ? "cancelled" : outcome;
		let duration = "lt1s";
		try {
			const value = durationBucket(readNow(now) - startedAt);
			if (EXECUTION_TELEMETRY_VALUES.duration_bucket.has(value)) duration = value;
		} catch {
			// An unavailable clock or bucket function cannot break pairing.
		}
		emit(`workflow:run_${result}`, {
			run_id: runId,
			duration_bucket: duration,
			...(result !== "succeeded" ? { failure_code: failureCode } : {}),
		});
	};
	return {
		runId,
		succeed() { finish("succeeded"); },
		fail(error, fallbackCode = "unknown") { finish("failed", error, fallbackCode); },
		apply() {
			if (applied || !runId) return;
			applied = true;
			emit("workflow:result_applied", { run_id: runId });
		},
	};
}
