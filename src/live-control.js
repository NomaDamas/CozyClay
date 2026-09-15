// Browser-side client for the editor half of mcp/LIVE-PROTOCOL.md. This
// module has no browser-only dependencies, so its frame dispatcher is directly
// testable in Node with a fake WebSocket.
import { sanitizeProps, track } from "./analytics.js";
import { EXECUTION_TELEMETRY_EVENTS, EXECUTION_TELEMETRY_PROPERTY_KEYS } from "./execution-telemetry.js";

const MOTION_TELEMETRY_EVENTS = new Set([
	"motion:generate_requested", "motion:preflight_blocked", "motion:preflight_passed",
	"motion:job_started", "motion:job_succeeded", "motion:job_failed", "motion:result_applied",
]);
const LIVE_TELEMETRY_EVENTS = new Set([...MOTION_TELEMETRY_EVENTS, ...EXECUTION_TELEMETRY_EVENTS.filter((event) => event.startsWith("mcp:"))]);

export const LIVE_CONTROL_PORT = import.meta.env?.VITE_COZYCLAY_LIVE_PORT ?? "5184";
export const liveControlUrl = (port = LIVE_CONTROL_PORT) => `ws://127.0.0.1:${port}/live`;
export const LIVE_CONTROL_URL = liveControlUrl();
export const LIVE_CONTROL_RECONNECT_MS = 3000;

function errorMessage(error) {
	if (error instanceof Error && error.message) return error.message;
	return typeof error === "string" && error ? error : "Command failed";
}

function result(id, ok, body) {
	return ok
		? { type: "result", id, ok: true, value: body ?? {} }
		: { type: "result", id, ok: false, error: body };
}

/**
 * Parse and dispatch one incoming text frame. Non-command frames are ignored;
 * a command with a valid id always receives a protocol result, including for
 * malformed arguments and unknown command names.
 */
export async function dispatchLiveFrame(data, handlers = {}) {
	if (typeof data !== "string") return null;
	let frame;
	try {
		frame = JSON.parse(data);
	} catch {
		return null;
	}
	if (!frame || typeof frame !== "object" || Array.isArray(frame) || frame.type !== "cmd") return null;
	if (typeof frame.id !== "string") return null;
	if (typeof frame.name !== "string" || !frame.name) return result(frame.id, false, "Invalid command name");
	if (!frame.args || typeof frame.args !== "object" || Array.isArray(frame.args)) return result(frame.id, false, "Invalid command arguments");
	const handler = handlers[frame.name];
	if (typeof handler !== "function") return result(frame.id, false, `Unknown command: ${frame.name}`);
	try {
		return result(frame.id, true, await handler(frame.args));
	} catch (error) {
		return result(frame.id, false, errorMessage(error));
	}
}

/**
 * Open the editor's one-way client connection. Failures are intentionally
 * silent: a studio remains a fully local editor when the MCP server is absent.
 */
export function createLiveControl({
	handlers = {},
	onWorkspace = () => {},
	onEvent = () => {},
	captureMotionTelemetry = track,
	captureTelemetry = track,
	workspaceId = "",
	// Optional identity for the hub's live_status listing (scene/project names).
	meta = null,
	WebSocketImpl = globalThis.WebSocket,
	url = LIVE_CONTROL_URL,
	reconnectMs = LIVE_CONTROL_RECONNECT_MS,
} = {}) {
	let currentHandlers = handlers;
	let socket = null;
	let retry = null;
	let stopped = false;
	const capturedStages = new Set();
	const receiveTelemetry = (payload) => {
		if (!LIVE_TELEMETRY_EVENTS.has(payload.event)) return;
		const props = sanitizeProps(payload.event, payload.props);
		const correlationId = props.request_id;
		if (!correlationId) return;
		if (EXECUTION_TELEMETRY_EVENTS.includes(payload.event)
			&& EXECUTION_TELEMETRY_PROPERTY_KEYS[payload.event]?.some((key) => !Object.hasOwn(props, key))) return;
		if ((payload.event === "motion:generate_requested" || payload.event.startsWith("motion:preflight_")) && props.surface !== "mcp") return;
		const key = `${correlationId}:${payload.event}`;
		if (capturedStages.has(key)) return;
		capturedStages.add(key);
		const capture = payload.event.startsWith("motion:") ? captureMotionTelemetry : captureTelemetry;
		try {
			Promise.resolve(capture(payload.event, props)).catch(() => {
				// SDK failures must not affect command dispatch or generation.
			});
		} catch {
			// The shared analytics gate and SDK are both best effort.
		}
	};

	const clearRetry = () => {
		if (retry !== null) clearTimeout(retry);
		retry = null;
	};
	const scheduleReconnect = () => {
		if (stopped || retry !== null) return;
		retry = setTimeout(() => {
			retry = null;
			connect();
		}, reconnectMs);
	};
	const send = (frame) => {
		if (!socket || socket.readyState !== (socket.OPEN ?? 1)) return;
		try {
			socket.send(JSON.stringify(frame));
		} catch {
			// A close between readyState and send is indistinguishable from an
			// absent server to the editor, so leave it silent and retry on close.
		}
	};
	const connect = () => {
		if (stopped || !WebSocketImpl) return;
		try {
			socket = new WebSocketImpl(url);
		} catch {
			scheduleReconnect();
			return;
		}
		const connected = socket;
		connected.onopen = () => {
			if (socket !== connected || stopped) return;
			send({
				type: "hello",
				role: "editor",
				version: 1,
				...(workspaceId ? { workspaceId } : {}),
				// Identify the workspace to live_status: bare UUIDs alone left an
				// agent unable to tell two editor tabs apart.
				...(meta ? { meta } : {}),
			});
		};
		connected.onmessage = async (event) => {
			if (socket !== connected || stopped) return;
			if (typeof event?.data === "string") {
				try {
					const frame = JSON.parse(event.data);
					if (frame?.type === "workspace" && typeof frame.handle === "string") {
						onWorkspace(frame.handle);
						return;
					}
					if (frame?.type === "event" && typeof frame.name === "string" && frame.payload && typeof frame.payload === "object") {
						if (frame.name === "motion_telemetry" || frame.name === "telemetry") {
							receiveTelemetry(frame.payload);
							return;
						}
						onEvent(frame.name, frame.payload);
						return;
					}
				} catch {
					// dispatchLiveFrame owns malformed command handling.
				}
			}
			const response = await dispatchLiveFrame(event?.data, currentHandlers);
			if (response) send(response);
		};
		// Suppress browser error reporting for an optional local endpoint.
		connected.onerror = () => {};
		connected.onclose = () => {
			if (socket === connected) socket = null;
			scheduleReconnect();
		};
	};

	connect();
	return {
		setHandlers(nextHandlers) {
			currentHandlers = nextHandlers && typeof nextHandlers === "object" ? nextHandlers : {};
		},
		close() {
			stopped = true;
			clearRetry();
			const current = socket;
			socket = null;
			try {
				current?.close();
			} catch {
				// Optional transport cleanup must not affect the editor.
			}
		},
	};
}
