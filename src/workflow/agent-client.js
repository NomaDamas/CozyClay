// Data layer for the workflow Agent panel.
//
// The browser never holds a credential. Sign-in happens in the system browser
// against the local sidecar, which owns the token exchange and storage; this
// module only ever reads a *description* of the session (email/plan/expiry)
// over loopback HTTP and sends turn text. There is deliberately no field,
// parameter or storage key here that could carry a bearer token, and
// test/verify-agent-panel.mjs pins that by grepping this file.
//
// Sidecar contract:
//   GET  /oauth/status  -> { signedIn, email, plan, accountId, expiresAt }
//   POST /oauth/start   -> { ok, authorizeUrl }
//   POST /oauth/logout  -> { ok }
//   POST /agent/turn    -> SSE, lines of `data: {json}`
//   POST /agent/stop    -> { ok }
//   GET  /agent/models  -> { models: [{ id, label }] }
//
// Studio hosts add the frozen task-1 contracts on the same routes:
//   POST /agent/turn                        -> { surface, sessionId, turnId, text, context, ... }
//   GET  /agent/turn/<turnId>/events?after=N -> replay after a dropped stream
//   POST /agent/stop                        -> { surface, sessionId, turnId, jobId? }
//   POST /agent/jobs/<jobId>/accept          -> explicit "Apply with warnings"

import { bucketMs, track } from "../analytics.js";
import { AGENT_TOOL_CATEGORIES, EXECUTION_TELEMETRY_VALUES } from "../execution-telemetry.js";
import { STUDIO_VARIANTS, validateReceipt } from "../studio-agent-protocol.js";

export const AGENT_PANEL_WIDTH_KEY = "cozyclay.workflow.agentPanel.width";
export const AGENT_PANEL_WIDTH_DEFAULT = 360;
export const AGENT_PANEL_WIDTH_MIN = 300;
export const AGENT_PANEL_WIDTH_MAX = 560;
export const AGENT_PANEL_RAIL_WIDTH = 36;
export const AGENT_PANEL_OVERLAY_BREAKPOINT = 1100;

/** Panel states, in the order the issue lists them. Every name is part of the
 * source contract and is also the value of ?state= in mock mode. */
export const AGENT_STATES = [
	"signed-out",
	"signing-in",
	"no-entitlement",
	"ready",
	"streaming",
	"rate-limited",
	"error",
];

/** Studio identities are UUIDs (task 1 `StudioTurn`/`StudioStop`), never the
 * panel's old counter ids and never an analytics identifier. */
export function createStudioSessionId(random = globalThis.crypto) {
	const uuid = random?.randomUUID?.();
	if (typeof uuid === "string") return uuid;
	const bytes = new Uint8Array(16);
	random.getRandomValues(bytes);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Motion job presentation. The state names are task 1's `jobStates`; nothing
 * here invents a percentage the runtime did not report. */
export const JOB_STATE_COPY = {
	queued: "Queued",
	generating: "Generating",
	preparing: "Preparing",
	verifying: "Verifying",
	repairing: "Repairing",
	committing: "Installing",
	reconciling: "Reconciling",
	installed: "Installed",
	review_required: "Needs review",
	failed: "Failed",
	cancelled: "Stopped",
	stale_target: "Target changed",
	stale_environment: "Scene changed",
};
const JOB_TERMINAL_STATES = new Set(["installed", "failed", "cancelled", "stale_target", "stale_environment"]);
export const isTerminalJobState = (state) => JOB_TERMINAL_STATES.has(state);
export const jobStateTone = (state) => state === "installed" ? "ok"
	: state === "review_required" ? "warn"
	: isTerminalJobState(state) ? "alert"
	: "busy";
/** Progress is shown only when the runtime actually reported one. */
export const formatJobProgress = (progress) => Number.isFinite(progress) ? `${Math.round(progress * 100)}%` : "";

/** One line of plain product copy for a validated receipt. */
export function receiptSummary(receipt) {
	if (receipt?.status === "installed") {
		const { installed, verification } = receipt;
		const coverage = verification.status === "verified"
			? `verified over ${verification.evaluatedFrames} frames`
			: "installed unverified";
		return `Installed ${installed.durationSeconds}s of motion on ${installed.characterId} — ${coverage}`;
	}
	if (receipt?.status === "undone") return `Undid ${receipt.undoneReceiptId}`;
	if (receipt?.status === "noop") return "Nothing to change";
	if (receipt?.status === "transient") return "Changed the view only";
	return `Applied to ${receipt?.affectedIds?.join(", ") || "the scene"}`;
}

/** Effort options for a model entry from /agent/models; the backend default comes first. */
export function effortOptions(entry) {
	const efforts = Array.isArray(entry?.efforts) ? entry.efforts : [];
	if (!efforts.length) return [];
	const fallback = entry.defaultEffort && efforts.includes(entry.defaultEffort) ? entry.defaultEffort : efforts[0];
	return [fallback, ...efforts.filter((effort) => effort !== fallback)];
}

// There is deliberately no hardcoded model list. A stale fallback id is sent
// silently and every turn then fails upstream with an opaque message; the panel
// waits for /agent/models instead and says so while it waits.

export const SUGGESTION_CHIPS = [
	"Block a two-shot conversation in this scene",
	"Render this frame as a storyboard panel",
	"Suggest a camera move for the current shot",
];

export const IMAGE_COST_HINT = "Image generation uses about 3-5x a normal turn";

export function clampPanelWidth(value) {
	const width = Number(value);
	if (!Number.isFinite(width)) return AGENT_PANEL_WIDTH_DEFAULT;
	return Math.min(AGENT_PANEL_WIDTH_MAX, Math.max(AGENT_PANEL_WIDTH_MIN, Math.round(width)));
}

export function readStoredPanelWidth(storage = globalThis.localStorage) {
	try {
		const raw = storage?.getItem(AGENT_PANEL_WIDTH_KEY);
		if (raw === null || raw === undefined || raw === "") return AGENT_PANEL_WIDTH_DEFAULT;
		return clampPanelWidth(raw);
	} catch {
		return AGENT_PANEL_WIDTH_DEFAULT;
	}
}

export function storePanelWidth(width, storage = globalThis.localStorage) {
	try {
		storage?.setItem(AGENT_PANEL_WIDTH_KEY, String(clampPanelWidth(width)));
	} catch {
		// Private-mode storage denial must never break resizing the panel.
	}
}

/** "resets in 42m" / "resets in 1h 05m" for the account strip and the paused
 * card countdown. Returns null when there is nothing to count down to. */
export function formatResetIn(resetAt, now = Date.now()) {
	if (!resetAt) return null;
	const target = typeof resetAt === "number" ? resetAt : Date.parse(resetAt);
	if (!Number.isFinite(target)) return null;
	const remaining = Math.max(0, target - now);
	const totalSeconds = Math.round(remaining / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}

const TOOL_LABELS = {
	capture_blocking_frame: { verb: "Capture", target: "blocking frame" },
	render_from_frame: { verb: "Render", target: "from frame" },
	place_image_in_scene: { verb: "Place", target: "image in scene" },
};

/** ToolCallCard shows "verb + target", never a raw function name. */
export function toolCallLabel(call) {
	if (call?.label) return call.label;
	const known = TOOL_LABELS[call?.name];
	if (known) return `${known.verb} ${known.target}`;
	const words = String(call?.name || "tool").split(/[_\-\s]+/).filter(Boolean);
	if (!words.length) return "Run tool";
	const verb = words[0][0].toUpperCase() + words[0].slice(1);
	return words.length > 1 ? `${verb} ${words.slice(1).join(" ")}` : verb;
}

export function formatElapsed(ms) {
	if (!Number.isFinite(ms) || ms < 0) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

export const ERROR_COPY = {
	auth: "Your session expired. Sign in again to continue.",
	entitlement: "This account cannot generate images.",
	rate_limit: "You have hit the usage limit for this window.",
	upstream: "The model service failed to answer.",
	overloaded: "The model service is overloaded right now. Try again in a moment.",
};

// --- activity line ---------------------------------------------------------
//
// Silence is the failure mode this replaces: a live turn says what it is doing
// and a finished turn says how it ended, in the same line, so "nothing on
// screen" can never mean "nobody knows".

/** How long a finished turn keeps explaining itself before the line goes quiet. */
export const ACTIVITY_TERMINAL_MS = 6000;
const ACTIVITY_IDLE_TEXT = "Ready";

/** Short, line-sized reasons; a transport message ("turn responded 429") is
 * already short enough and is preferred over inventing copy for it. */
const FAILURE_REASON = {
	auth: "session expired",
	entitlement: "not on this plan",
	rate_limit: "usage limit reached",
	rate_limited: "usage limit reached",
	overloaded: "service overloaded",
	no_output: "no response",
};

function shortFailureReason(failure) {
	if (!failure) return "unknown error";
	const known = FAILURE_REASON[failure.code];
	if (known) return known;
	const message = String(failure.message ?? "").trim();
	if (!message) return String(failure.code || "unknown error");
	return message.length > 64 ? `${message.slice(0, 63)}…` : message;
}

/** Elapsed clock for the activity line: "3 s", "1 m 05 s". */
export function formatTurnClock(ms) {
	const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
	if (total < 60) return `${total} s`;
	return `${Math.floor(total / 60)} m ${String(total % 60).padStart(2, "0")} s`;
}

const liveActivity = (phase, label, elapsedMs) => ({
	phase,
	kind: "live",
	tone: "busy",
	text: `${label} · ${formatTurnClock(elapsedMs)}`,
	ticking: true,
});

/** What the panel says it is doing, in plain words. Pure: the component only
 * supplies the clock, so every phase and every terminal state is testable. */
export function describeActivity(state, { now = Date.now(), toolLabel = toolCallLabel } = {}) {
	const items = state?.items ?? [];
	// A dispatched editor action outlives the turn that produced the image, so it
	// is the most specific thing the panel can be waiting for.
	const dispatched = items.find((item) => item.kind === "image" && item.apply?.status === "applying");
	if (dispatched) return liveActivity("editor", "Waiting for the editor…", now - (dispatched.apply.startedAt ?? now));
	if (state?.streaming) {
		const elapsed = now - (state.turnStartedAt ?? now);
		const job = items.findLast((item) => item.kind === "job" && !isTerminalJobState(item.state));
		if (job) {
			const percent = formatJobProgress(job.progress);
			return liveActivity("job", `${JOB_STATE_COPY[job.state] || job.state} motion${percent ? ` ${percent}` : ""}`, elapsed);
		}
		const tool = items.findLast((item) => item.kind === "tool" && item.status === "running");
		if (tool) return liveActivity("tool", `Running ${toolLabel(tool)}…`, elapsed);
		// Nothing has come back yet: the request itself is the only thing happening.
		const prompt = items.findLastIndex((item) => item.kind === "user");
		return prompt === items.length - 1
			? liveActivity("sending", "Sending…", elapsed)
			: liveActivity("thinking", "Thinking…", elapsed);
	}
	const last = state?.lastTurn;
	if (last && now - last.endedAt < ACTIVITY_TERMINAL_MS) {
		if (last.status === "stopped") return { phase: "stopped", kind: "terminal", tone: "warn", text: "Stopped", ticking: true };
		if (last.status === "failed") return { phase: "failed", kind: "terminal", tone: "alert", text: `Failed: ${shortFailureReason(last.failure)}`, ticking: true };
		return { phase: "done", kind: "terminal", tone: "ok", text: `Done · ${formatTurnClock(last.durationMs)}`, ticking: true };
	}
	return { phase: "idle", kind: "idle", tone: "", text: ACTIVITY_IDLE_TEXT, ticking: false };
}

/** Split an SSE body into `data:` payload objects. Exported so the reader can
 * be unit-tested without a socket. */
export function parseSseChunk(buffer) {
	const events = [];
	const lines = buffer.split("\n");
	const tail = lines.pop() ?? "";
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) continue;
		const payload = trimmed.slice(5).trim();
		if (!payload) continue;
		try {
			events.push(JSON.parse(payload));
		} catch {
			// A partial or malformed frame is dropped rather than killing the turn.
		}
	}
	return { events, tail };
}

// --- real transport (loopback sidecar) ------------------------------------

const SIDECAR_ORIGIN = "";

function sidecarUrl(path) {
	return `${SIDECAR_ORIGIN}${path}`;
}

const validTelemetryId = (value) => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const AGENT_FAILURE_CODES = new Set(["aborted", "auth", "rate_limited", "tool_failed", "upstream", "unknown"]);
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
	&& Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const advisory = (read, fallback) => { try { return read(); } catch { return fallback; } };
const transportFailureCode = (error) => advisory(() => error?.status === 401 || error?.code === "auth" ? "auth"
	: error?.status === 429 || error?.code === "rate_limit" ? "rate_limited" : "upstream", "upstream");

const UI_ERROR_CODES = new Set(["auth", "entitlement", "rate_limit", "overloaded", "upstream"]);

/** The UI error for a refused turn. The sidecar answers `{ error: { code,
 * message, status } }` with an already-sanitized message; a refusal without a
 * readable body still reports its HTTP status rather than a blank panel. */
export async function refusalEvent(response) {
	const status = Number.isFinite(response?.status) ? response.status : null;
	let detail = null;
	try {
		const body = await response.clone().json();
		detail = typeof body?.error === "string" ? { message: body.error } : body?.error && typeof body.error === "object" ? body.error : null;
	} catch { /* a refusal with no JSON body is still a reportable status */ }
	const reported = typeof detail?.message === "string" ? detail.message.trim() : "";
	// The sidecar already leads with the status on every route that answers JSON;
	// repeating it ("502 — 502 — …") reads as a bug in the panel.
	const message = !reported ? `The turn was refused with HTTP ${status ?? "error"}.`
		: status !== null && reported.startsWith(`${status} `) ? reported
			: `${status ?? "Upstream"} — ${reported}`;
	return {
		code: UI_ERROR_CODES.has(detail?.code) ? detail.code : status === 429 ? "rate_limit" : status === 401 ? "auth" : "upstream",
		message,
		...(status === null ? {} : { status }),
		...(detail?.resetAt ? { resetAt: detail.resetAt } : {}),
	};
}

// The real browser request owns the attempt, including HTTP refusal and Stop.
// These IDs never use panel session IDs, model call IDs or authored content.
function startAgentTurn({ surface, capture, now }) {
	const turnId = advisory(() => {
		const bytes = new Uint8Array(16);
		globalThis.crypto.getRandomValues(bytes);
		return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	}, null);
	const clock = () => advisory(() => { const value = now(); return Number.isFinite(value) ? value : NaN; }, NaN);
	const startedAt = clock();
	const hostSurface = advisory(() => ["studio", "workflow"].includes(surface) ? surface
		: /^\/workflow(?:\/|$)/.test(globalThis.location?.pathname || "") ? "workflow" : "studio", "studio");
	let terminal = false;
	let applied = false;
	const tools = new Map();
	const seenTools = new Set();
	const emit = (event, props) => {
		if (!turnId) return;
		try { Promise.resolve(capture(event, props)).catch(() => {}); } catch { /* telemetry is advisory */ }
	};
	const finish = (outcome, failureCode) => {
		if (terminal) return;
		terminal = true;
		if (outcome === "cancelled") {
			for (const [id, tool] of tools) {
				if (!seenTools.has(id)) emit("agent:tool_executed", { turn_id: turnId, tool_category: tool.category, outcome: "cancelled", duration_bucket: bucketMs(clock() - tool.startedAt) });
			}
		}
		tools.clear();
		emit(`agent:turn_${outcome}`, { turn_id: turnId, duration_bucket: bucketMs(clock() - startedAt), ...(outcome !== "succeeded" ? { failure_code: failureCode } : {}) });
	};
	emit("agent:turn_requested", { surface: hostSurface, turn_id: turnId });
	return {
		turnId,
		cancel: () => finish("cancelled", "aborted"),
		fail: (code) => finish("failed", AGENT_FAILURE_CODES.has(code) ? code : "upstream"),
		frame(frame) {
			// Local sidecar frames are still an untrusted boundary. Reject the whole
			// frame, including extra fields, before dedupe or analytics capture.
			try {
				if (!turnId || terminal) return;
				if (frame.type === "execution_tool_started") {
					if (!exactKeys(frame, ["type", "turn_id", "telemetry_id", "tool_category"]) || frame.turn_id !== turnId
						|| !validTelemetryId(frame.telemetry_id) || !AGENT_TOOL_CATEGORIES.includes(frame.tool_category)) return;
					if (!tools.has(frame.telemetry_id) && !seenTools.has(frame.telemetry_id)) tools.set(frame.telemetry_id, { category: frame.tool_category, startedAt: clock() });
					return;
				}
				const { event, props } = frame;
				if (props?.turn_id !== turnId) return;
				if (event === "agent:tool_executed") {
					if (!exactKeys(frame, ["type", "event", "props", "telemetry_id"]) || !validTelemetryId(frame.telemetry_id)
						|| !exactKeys(props, ["turn_id", "tool_category", "outcome", "duration_bucket"])
						|| !AGENT_TOOL_CATEGORIES.includes(props.tool_category) || !["succeeded", "failed", "cancelled"].includes(props.outcome)
						|| !EXECUTION_TELEMETRY_VALUES.duration_bucket.has(props.duration_bucket) || seenTools.has(frame.telemetry_id)) return;
					seenTools.add(frame.telemetry_id);
					tools.delete(frame.telemetry_id);
					emit(event, { turn_id: turnId, tool_category: props.tool_category, outcome: props.outcome, duration_bucket: props.duration_bucket });
					return;
				}
				if (!exactKeys(frame, ["type", "event", "props"])) return;
				if (event === "agent:result_applied") {
					if (!applied && exactKeys(props, ["turn_id"])) { applied = true; emit(event, { turn_id: turnId }); }
					return;
				}
				if (!["agent:turn_succeeded", "agent:turn_failed", "agent:turn_cancelled"].includes(event)) return;
				const outcome = event.slice("agent:turn_".length);
				const hasFailure = Object.hasOwn(props, "failure_code");
				if (!exactKeys(props, ["turn_id", "duration_bucket", ...(hasFailure ? ["failure_code"] : [])])
					|| !EXECUTION_TELEMETRY_VALUES.duration_bucket.has(props.duration_bucket)
					|| (hasFailure && (outcome === "succeeded" || !AGENT_FAILURE_CODES.has(props.failure_code)))) return;
				finish(outcome, outcome === "cancelled" ? "aborted" : props.failure_code || "unknown");
			} catch { /* foreign getters and malformed telemetry cannot affect a turn */ }
		},
	};
}

const RESUME_ATTEMPTS = 3;

export function createHttpTransport({ fetchImpl = globalThis.fetch?.bind(globalThis), surface, capture = track, now = () => performance.now() } = {}) {
	const activeTurns = new Map();
	const request = async (path, init) => {
		const response = await fetchImpl(sidecarUrl(path), {
			headers: { "content-type": "application/json" },
			...init,
		});
		if (!response.ok) {
			let detail = null;
			try { detail = await response.clone().json(); } catch { /* preserve the status when the server did not send JSON */ }
			const message = typeof detail?.error === "string" ? detail.error : detail?.error?.message;
			const error = new Error(message || `${path} responded ${response.status}`);
			// Keep machine-readable verification evidence alongside the human message.
			// The Workflow node can show why an H3 take was rejected without exposing
			// or retaining the rejected video itself.
			error.status = response.status;
			if (detail?.error && typeof detail.error === "object") Object.assign(error, detail.error);
			if (detail?.preservation && typeof detail.preservation === "object") error.preservation = detail.preservation;
			throw error;
		}
		return response.json();
	};
	return {
		mock: false,
		async status() {
			return request("/oauth/status");
		},
		async signIn() {
			const result = await request("/oauth/start", { method: "POST", body: "{}" });
			// The sidecar owns the code exchange; the browser only opens the page.
			if (result?.authorizeUrl) globalThis.open?.(result.authorizeUrl, "_blank", "noopener,noreferrer");
			return result;
		},
		async signOut() {
			return request("/oauth/logout", { method: "POST", body: "{}" });
		},
		async models() {
			const result = await request("/agent/models");
			return Array.isArray(result?.models) ? result.models : [];
		},
		// Legacy callers pass a session id; a Studio host passes the frozen stop
		// envelope so the sidecar can cancel one turn and one owned job.
		async stop(target) {
			const envelope = typeof target === "string" || !target
				? { sessionId: target }
				: { surface: "studio", sessionId: target.sessionId, turnId: target.turnId, ...(target.jobId ? { jobId: target.jobId } : {}) };
			activeTurns.get(envelope.sessionId)?.cancel();
			return request("/agent/stop", { method: "POST", body: JSON.stringify(envelope) });
		},
		/** Trusted "Apply with warnings": a user action, never a model bypass. */
		async acceptJob({ jobId, sessionId, turnId }) {
			return request(`/agent/jobs/${encodeURIComponent(jobId)}/accept`, {
				method: "POST",
				body: JSON.stringify({ surface: "studio", sessionId, turnId, explicitUnverifiedAcceptance: true }),
			});
		},
		// `references` are the scene's identity / environment slots (#167): extra
		// attached pictures with a role, passed through untouched so the sidecar
		// decides how they are described to the model.
		async image({ prompt, imageDataUrl, referenceDataUrl, references, quality = "auto" }, signal) {
			return request("/agent/image", { method: "POST", body: JSON.stringify({ prompt, imageDataUrl, ...(referenceDataUrl ? { referenceDataUrl } : {}), ...(Array.isArray(references) && references.length ? { references } : {}), quality }), signal });
		},
		async video(payload, signal) {
			return request("/agent/video", { method: "POST", body: JSON.stringify(payload), signal });
		},
		async videoProviders() {
			return request("/agent/video/providers");
		},
		/** Streams sidecar events to `onEvent`. Resolves when the turn ends. */
		async turn(turnRequest, onEvent, signal) {
			const { sessionId, text, attachFrame, model, effort } = turnRequest;
			const studio = turnRequest.surface === "studio";
			const turnId = studio ? turnRequest.turnId : null;
			const telemetry = startAgentTurn({ surface, capture, now });
			activeTurns.set(sessionId, telemetry);
			const onAbort = () => { if (signal.reason === "agent-stop") telemetry.cancel(); };
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
			let opened = false;
			let failureCode;
			// Studio events are sequenced so a reconnect can replay without applying
			// anything twice. A replayed event is dropped here, before the UI sees it.
			let cursor = 0;
			let terminal = false;
			const receive = (event) => {
				if (event?.type === "execution_telemetry" || event?.type === "execution_tool_started") { telemetry.frame(event); return; }
				if (studio && Number.isFinite(event?.eventSeq)) {
					if (event.eventSeq <= cursor) return;
					cursor = event.eventSeq;
				}
				if (event?.type === "error") failureCode = transportFailureCode(event);
				if (event?.type === "done") terminal = true;
				onEvent(event);
			};
			const readStream = async (response) => {
				const reader = response.body.getReader();
				opened = true;
				try {
					const decoder = new TextDecoder();
					let buffer = "";
					while (true) {
						const { value, done } = await reader.read();
						if (done) break;
						buffer += decoder.decode(value, { stream: true });
						const parsed = parseSseChunk(buffer);
						buffer = parsed.tail;
						for (const event of parsed.events) receive(event);
					}
					// Preserve legacy UI tail delivery, but never complete a telemetry
					// frame synthetically. Bare done/EOF is not completion evidence.
					for (const event of parseSseChunk(`${buffer}\n`).events) {
						if (event?.type !== "execution_telemetry" && event?.type !== "execution_tool_started") receive(event);
					}
				} finally {
					reader.releaseLock();
				}
			};
			const body = studio
				? JSON.stringify({
					surface: "studio", sessionId, turnId, text, context: turnRequest.context,
					...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(attachFrame === undefined ? {} : { attachFrame: Boolean(attachFrame) }),
				})
				: JSON.stringify({ sessionId, text, attachFrame, model, ...(effort ? { effort } : {}), ...(telemetry.turnId ? { turn_id: telemetry.turnId } : {}) });
			try {
				const response = await fetchImpl(sidecarUrl("/agent/turn"), {
					method: "POST",
					headers: { "content-type": "application/json", accept: "text/event-stream" },
					body,
					signal,
				});
				if (!response.ok || !response.body) {
					telemetry.fail(transportFailureCode(response));
					// A refused turn carries the only explanation there is. Forward the
					// status and whatever short detail the sidecar sanitized for us
					// instead of the panel inventing "something went wrong".
					onEvent({ type: "error", ...(await refusalEvent(response)) });
					onEvent({ type: "done" });
					return;
				}
				let streamError = null;
				try { await readStream(response); } catch (error) { streamError = error; }
				// A lost observer is not a lost turn: resume from the cursor instead of
				// re-sending the turn, which would authorize a second generation.
				for (let attempt = 0; studio && turnId && !terminal && !signal?.aborted && attempt < RESUME_ATTEMPTS; attempt += 1) {
					let resumed;
					try {
						resumed = await fetchImpl(sidecarUrl(`/agent/turn/${encodeURIComponent(turnId)}/events?after=${cursor}`), {
							headers: { accept: "text/event-stream" },
							signal,
						});
					} catch { break; }
					if (!resumed?.ok || !resumed.body) break;
					streamError = null;
					try { await readStream(resumed); } catch (error) { streamError = error; }
				}
				if (streamError) throw streamError;
				if (failureCode) telemetry.fail(failureCode);
			} catch (error) {
				// Refusal before the stream opens is a known failed request. Losing
				// an open stream without an outcome leaves execution unobserved.
				if (!signal?.aborted && (!opened || failureCode)) telemetry.fail(failureCode || transportFailureCode(error));
				throw error;
			} finally {
				signal?.removeEventListener("abort", onAbort);
				if (activeTurns.get(sessionId) === telemetry) activeTurns.delete(sessionId);
			}
		},
	};
}

// --- mock transport (QA) ---------------------------------------------------

/** ?agent=mock turns the panel onto a scripted transport so every state in the
 * issue can be reached and screenshotted before the sidecar exists. */
export function mockConfigFromSearch(search = globalThis.location?.search || "") {
	const params = new URLSearchParams(search);
	if (params.get("agent") !== "mock") return null;
	const requested = params.get("state");
	const state = AGENT_STATES.includes(requested) ? requested : "ready";
	return { state, speed: Number(params.get("speed")) || 1 };
}

const MOCK_ACCOUNT = {
	signedIn: true,
	email: "director@cozyclay.org",
	plan: "Plus",
	accountId: "acct_mock_126",
	expiresAt: null,
};

const MOCK_IMAGE =
	"data:image/svg+xml;utf8," +
	encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="288" viewBox="0 0 512 288">` +
			`<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
			`<stop offset="0" stop-color="#2a2f52"/><stop offset="1" stop-color="#5b3550"/></linearGradient></defs>` +
			`<rect width="512" height="288" fill="url(#g)"/>` +
			`<circle cx="150" cy="150" r="52" fill="#ef759d" opacity="0.85"/>` +
			`<rect x="250" y="112" width="180" height="112" rx="10" fill="#8994ff" opacity="0.8"/>` +
			`<rect y="240" width="512" height="48" fill="#101116" opacity="0.55"/>` +
			`<text x="24" y="272" font-family="Inter,sans-serif" font-size="18" fill="#edf0fb">mock render · wide two-shot</text>` +
			`</svg>`,
	);

const MOCK_SCRIPT = [
	{ delay: 40, event: { type: "text.delta", text: "Framing a wide two-shot from the current blocking. " } },
	{ delay: 120, event: { type: "text.delta", text: "Capturing the viewport first." } },
	{ delay: 120, event: { type: "tool.start", callId: "call-1", name: "capture_blocking_frame", label: "Capture blocking frame", args: { shot: "current" } } },
	{ delay: 260, event: { type: "tool.done", callId: "call-1", ok: true, elapsedMs: 268, result: { width: 1280, height: 720 } } },
	{ delay: 90, event: { type: "tool.start", callId: "call-2", name: "render_from_frame", label: "Render from frame", args: { style: "storyboard", strength: 0.6 } } },
	{ delay: 420, event: { type: "tool.done", callId: "call-2", ok: true, elapsedMs: 1412, result: { imageId: "img-1" } } },
	{ delay: 80, event: { type: "image", imageId: "img-1", dataUrl: MOCK_IMAGE, width: 512, height: 288, prompt: "wide two-shot, storyboard ink" } },
	{ delay: 60, event: { type: "quota", plan: "Plus", primary: { usedPercent: 46, windowMinutes: 300, resetAt: null }, credits: { has: true } } },
	{ delay: 40, event: { type: "done" } },
];

export function createMockTransport(config = { state: "ready" }) {
	const state = config?.state || "ready";
	const speed = config?.speed > 0 ? config.speed : 1;
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms / speed)));
	return {
		mock: true,
		state,
		async status() {
			if (state === "signed-out") return { signedIn: false, email: null, plan: null, accountId: null, expiresAt: null };
			if (state === "signing-in") return { signedIn: false, pending: true, email: null, plan: null, accountId: null, expiresAt: null };
			if (state === "no-entitlement") return { ...MOCK_ACCOUNT, plan: "Free", entitlements: { image: false } };
			return { ...MOCK_ACCOUNT, entitlements: { image: true } };
		},
		async signIn() {
			return { ok: true, authorizeUrl: "https://auth.example.invalid/mock" };
		},
		async signOut() {
			return { ok: true };
		},
		async models() {
			return [{ id: "mock-model", label: "Mock model" }];
		},
		async stop() {
			return { ok: true };
		},
		async acceptJob() {
			return { ok: true };
		},
		// In mock mode the scripted transport also stands in for the host that
		// would accept an image, so ?agent=mock keeps showing the placed state.
		async applyImage({ requestId }) {
			return { ok: true, receiptId: `mock-${requestId}` };
		},
		async turn(_request, onEvent, signal) {
			if (state === "rate-limited") {
				onEvent({ type: "text.delta", text: "Framing a wide two-shot from the current blocking." });
				onEvent({
					type: "quota",
					plan: "Plus",
					primary: { usedPercent: 100, windowMinutes: 300, resetAt: new Date(Date.now() + 42 * 60000).toISOString() },
					credits: { has: false },
				});
				onEvent({ type: "error", code: "rate_limit", message: ERROR_COPY.rate_limit, resetAt: new Date(Date.now() + 42 * 60000).toISOString() });
				onEvent({ type: "done" });
				return;
			}
			if (state === "error") {
				onEvent({ type: "text.delta", text: "Capturing the viewport first." });
				onEvent({ type: "tool.start", callId: "call-1", name: "capture_blocking_frame", label: "Capture blocking frame", args: { shot: "current" } });
				onEvent({ type: "tool.done", callId: "call-1", ok: false, elapsedMs: 812, error: "Viewport is not ready" });
				onEvent({ type: "error", code: "upstream", message: ERROR_COPY.upstream });
				onEvent({ type: "done" });
				return;
			}
			for (const step of MOCK_SCRIPT) {
				if (signal?.aborted) break;
				await wait(step.delay);
				if (signal?.aborted) break;
				onEvent(step.event);
			}
			if (signal?.aborted) onEvent({ type: "done" });
		},
	};
}

export function createAgentTransport(options = {}) {
	const config = options.mockConfig !== undefined ? options.mockConfig : mockConfigFromSearch();
	return config ? createMockTransport(config) : createHttpTransport(options);
}

// --- chat store (framework-free) -------------------------------------------
//
// One conversation: session identity, transcript, motion jobs, receipts and
// acknowledged image actions. It lives here rather than inside the component so
// the dock, an embedded Studio host and the test runner drive the SAME state
// machine over the SAME transport events. It is not a second analytics emitter:
// telemetry stays in the transport, unchanged.

/** What an acknowledged Stop actually established. An installation the runtime
 * already committed belongs to its receipt, not here; anything short of an
 * explicit not-applied answer stays unknown, because the alternative is telling
 * an author the scene is clean when nobody checked. */
export function stopOutcome(result) {
	const outcome = result?.outcome;
	if (outcome?.status === "already_applied") return null;
	if (outcome && outcome.mutated === false) return { status: "not_applied", code: outcome.code ?? "CANCELLED", mutated: false };
	return { status: "unknown", code: outcome?.code ?? null, mutated: "unknown" };
}

/** A host claims a placement by calling preventDefault() on the dispatched
 * event, then answers with `cozyclay:agent-image-result`. An unclaimed action
 * fails immediately: nothing applied it. */
export function requestHostImageAction(request) {
	return new Promise((resolve) => {
		const onResult = (event) => {
			if (event.detail?.requestId !== request.requestId) return;
			globalThis.removeEventListener("cozyclay:agent-image-result", onResult);
			resolve({ ok: Boolean(event.detail.ok), error: event.detail.error, receiptId: event.detail.receiptId });
		};
		globalThis.addEventListener?.("cozyclay:agent-image-result", onResult);
		const claimed = globalThis.dispatchEvent
			? !globalThis.dispatchEvent(new CustomEvent("cozyclay:agent-image", { cancelable: true, detail: request }))
			: false;
		if (claimed) return;
		globalThis.removeEventListener?.("cozyclay:agent-image-result", onResult);
		resolve({ ok: false, error: "No editor accepted the image. Open the scene that should receive it." });
	});
}

export function createAgentChatStore({
	transport,
	surface = "workflow",
	buildContext = null,
	requestImageAction = null,
	onAuthLost = null,
	newId = createStudioSessionId,
	clock = () => Date.now(),
} = {}) {
	const studio = surface === "studio";
	const listeners = new Set();
	const seenReceipts = new Set();
	const settledActions = new Set();
	let controller = null;
	// What the running turn has actually produced, so a turn that ends with
	// nothing on screen can be reported as the failure it is.
	let activeTurn = null;
	let state = {
		sessionId: newId(),
		turnId: null,
		draft: "",
		items: [],
		streaming: false,
		quota: null,
		rateLimit: null,
		lastPrompt: "",
		turnStartedAt: null,
		lastTurn: null,
	};
	const set = (patch) => {
		state = { ...state, ...patch };
		for (const listener of [...listeners]) listener(state);
	};
	const setItems = (update) => set({ items: update(state.items) });
	const patchItem = (predicate, patch) => setItems((items) => items.map((item) => predicate(item) ? { ...item, ...patch } : item));
	const findJob = (jobId) => state.items.find((item) => item.kind === "job" && item.jobId === jobId);

	function applyJobEvent(event) {
		if (!event?.jobId || !STUDIO_VARIANTS.jobStates.includes(event.state)) return;
		const reported = typeof event.progress === "number" && Number.isFinite(event.progress)
			? Math.min(1, Math.max(0, event.progress))
			: null;
		setItems((items) => {
			const existing = items.find((item) => item.kind === "job" && item.jobId === event.jobId);
			const next = {
				kind: "job",
				id: existing?.id ?? `job:${event.jobId}`,
				jobId: event.jobId,
				commandId: event.commandId ?? existing?.commandId ?? null,
				state: event.state,
				phase: typeof event.phase === "string" ? event.phase : existing?.phase ?? null,
				progress: reported ?? existing?.progress ?? null,
				verification: existing?.verification ?? null,
				receiptId: existing?.receiptId ?? null,
				// A settled outcome survives later frames, exactly like a receipt: a
				// buffered event arriving after an acknowledged Stop must not quietly
				// erase the panel's "nothing was applied" claim.
				outcome: existing?.outcome ?? null,
				acceptance: event.state === "review_required" ? existing?.acceptance ?? { status: "required" } : existing?.acceptance ?? null,
			};
			return existing ? items.map((item) => item === existing ? next : item) : [...items, next];
		});
	}

	function applyReceiptEvent(raw) {
		let receipt;
		try {
			receipt = validateReceipt(raw);
		} catch (error) {
			// An unreadable receipt is never rendered as a success.
			setItems((items) => [...items, { kind: "failure", id: newId(), failure: { code: error?.code || "INVALID_RECEIPT", message: error?.message || "The host returned an unreadable receipt.", preserved: { authoredState: "unknown" }, recovery: { action: "inspect" } } }]);
			return;
		}
		if (receipt.ok === false) {
			const key = `failure:${receipt.commandId}:${receipt.code}`;
			if (seenReceipts.has(key)) return;
			seenReceipts.add(key);
			setItems((items) => [
				...items.map((item) => item.kind === "job" && item.commandId === receipt.commandId && !isTerminalJobState(item.state)
					? { ...item, state: "failed", phase: receipt.phase, acceptance: null }
					: item),
				{ kind: "failure", id: key, failure: receipt },
			]);
			return;
		}
		if (seenReceipts.has(receipt.receiptId)) return;
		seenReceipts.add(receipt.receiptId);
		setItems((items) => [
			...items.map((item) => item.kind === "job" && item.jobId === receipt.jobId
				? {
					...item,
					state: receipt.status === "installed" ? "installed" : item.state,
					verification: receipt.verification ?? null,
					receiptId: receipt.receiptId,
					acceptance: receipt.explicitUnverifiedAcceptance ? { status: "accepted" } : null,
				}
				: item),
			{ kind: "receipt", id: `receipt:${receipt.receiptId}`, receiptId: receipt.receiptId, receipt, summary: receiptSummary(receipt) },
		]);
	}

	function applyEvent(event) {
		if (activeTurn && event?.type !== "quota") activeTurn.produced = true;
		if (event?.type === "text.delta") {
			setItems((items) => {
				const last = items[items.length - 1];
				if (last?.kind === "assistant") return [...items.slice(0, -1), { ...last, text: last.text + event.text }];
				return [...items, { kind: "assistant", id: newId(), text: event.text }];
			});
			return;
		}
		if (event?.type === "tool.start") {
			setItems((items) => [...items, { kind: "tool", id: event.callId || newId(), callId: event.callId, name: event.name, label: event.label, args: event.args, status: "running" }]);
			return;
		}
		if (event?.type === "tool.done") {
			patchItem((item) => item.kind === "tool" && item.callId === event.callId, { status: event.ok ? "done" : "failed", elapsedMs: event.elapsedMs, result: event.result, error: event.error });
			return;
		}
		if (event?.type === "image") {
			setItems((items) => [...items, { kind: "image", id: event.imageId || newId(), imageId: event.imageId, dataUrl: event.dataUrl, width: event.width, height: event.height, prompt: event.prompt, placed: false, apply: null }]);
			return;
		}
		if (event?.type === "job.state" || event?.type === "job.progress") { applyJobEvent(event); return; }
		if (event?.type === "receipt") { applyReceiptEvent(event.receipt); return; }
		if (event?.type === "quota") {
			set({ quota: { plan: event.plan, usedPercent: event.primary?.usedPercent, windowMinutes: event.primary?.windowMinutes, resetAt: event.primary?.resetAt, credits: event.credits } });
			return;
		}
		if (event?.type !== "error") return;
		const failure = { code: event.code || "upstream", message: event.message || ERROR_COPY[event.code] || "The turn failed.", ...(Number.isFinite(event.status) ? { status: event.status } : {}) };
		if (activeTurn) activeTurn.failure = failure;
		if (event.code === "rate_limit") { set({ rateLimit: { resetAt: event.resetAt || null, message: event.message || ERROR_COPY.rate_limit } }); return; }
		if (event.code === "auth") { onAuthLost?.(); return; }
		setItems((items) => {
			// Only THIS turn's failed tool call can carry the failure. Attaching it to
			// an older card would hide the new failure inside finished history.
			const prompt = items.findLastIndex((item) => item.kind === "user");
			const position = items.findLastIndex((item, at) => at > prompt && item.kind === "tool" && item.status === "failed");
			if (position === -1) return [...items, { kind: "failure", id: newId(), failure: { ...failure, recovery: { action: "retry", retryAllowed: true } } }];
			return items.map((item, at) => at === position ? { ...item, failure } : item);
		});
	}

	function settleImageAction(requestId, result, intent) {
		// One acknowledgement per request: a duplicate receipt cannot place an
		// image twice, and a late answer cannot flip a settled card.
		if (!requestId || settledActions.has(requestId)) return;
		settledActions.add(requestId);
		const ok = Boolean(result?.ok);
		const patch = { apply: { requestId, status: ok ? "settled" : "failed", error: ok ? null : result?.error || "The editor did not apply the image.", receiptId: result?.receiptId ?? null } };
		// Only an acknowledged action changes what the card claims happened.
		if (ok) patch.placed = intent === "place";
		patchItem((item) => item.kind === "image" && item.apply?.requestId === requestId, patch);
	}

	async function runImageAction(itemId, intent) {
		const item = state.items.find((entry) => entry.kind === "image" && entry.id === itemId);
		if (!item || item.apply?.status === "applying") return;
		if (intent === "place" ? item.placed : !item.placed) return;
		const requestId = newId();
		patchItem((entry) => entry.kind === "image" && entry.id === itemId, { apply: { requestId, status: "applying", error: null, receiptId: null, startedAt: clock() } });
		const request = { action: intent, requestId, imageId: item.imageId, dataUrl: item.dataUrl, width: item.width, height: item.height, prompt: item.prompt };
		try {
			const result = await (requestImageAction ?? requestHostImageAction)(request);
			settleImageAction(requestId, result, intent);
		} catch (error) {
			settleImageAction(requestId, { ok: false, error: String(error?.message || error) }, intent);
		}
	}

	const resetSession = () => {
		seenReceipts.clear();
		settledActions.clear();
		// Clearing the transcript also retires the server session: a cleared chat
		// the model still remembers is the divergence this replaces.
		set({ sessionId: newId(), turnId: null, items: [], rateLimit: null, lastPrompt: "", turnStartedAt: null, lastTurn: null });
	};

	return {
		getState: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		setDraft: (draft) => set({ draft: String(draft ?? "") }),
		async send(text, options = {}) {
			const trimmed = String(text ?? "").trim();
			if (!trimmed || state.streaming) return;
			const turnId = newId();
			// Context is read at Send, from the host's current authoritative refs.
			const context = studio ? buildContext?.() ?? null : null;
			if (studio && !context) {
				applyEvent({ type: "error", code: "upstream", message: "The editor is not ready to describe the scene yet." });
				return;
			}
			const startedAt = clock();
			const turn = { produced: false, failure: null };
			activeTurn = turn;
			set({
				lastPrompt: trimmed,
				rateLimit: null,
				turnId,
				streaming: true,
				draft: "",
				turnStartedAt: startedAt,
				lastTurn: null,
				items: [...state.items, { kind: "user", id: newId(), text: trimmed, attachFrame: Boolean(options.attachFrame) }],
			});
			controller = new AbortController();
			const signal = controller.signal;
			try {
				await transport.turn({
					...(studio ? { surface: "studio", turnId, context } : {}),
					sessionId: state.sessionId,
					text: trimmed,
					attachFrame: Boolean(options.attachFrame),
					model: options.model,
					effort: options.effort ?? undefined,
				}, applyEvent, signal);
			} catch (error) {
				if (!signal.aborted) applyEvent({ type: "error", code: "upstream", message: String(error?.message || error) });
			} finally {
				if (controller?.signal === signal) controller = null;
				// A turn the author already replaced owns none of this state.
				if (activeTurn === turn) {
					// Ending with nothing on screen is a failure, not a result.
					if (!turn.produced && !turn.failure && !signal.aborted) {
						turn.failure = { code: "no_output", message: "The turn ended without a response.", recovery: { action: "retry", retryAllowed: true } };
						setItems((items) => [...items, { kind: "failure", id: newId(), failure: turn.failure }]);
					}
					const endedAt = clock();
					activeTurn = null;
					set({
						streaming: false,
						turnStartedAt: null,
						lastTurn: {
							status: signal.aborted ? "stopped" : turn.failure ? "failed" : "done",
							endedAt,
							durationMs: endedAt - startedAt,
							failure: turn.failure,
						},
					});
				}
			}
		},
		stop() {
			const running = [...state.items].reverse().find((item) => item.kind === "job" && !isTerminalJobState(item.state));
			controller?.abort("agent-stop");
			controller = null;
			const target = studio
				? { sessionId: state.sessionId, turnId: state.turnId, ...(running ? { jobId: running.jobId } : {}) }
				: state.sessionId;
			Promise.resolve(transport.stop?.(target))
				.then((result) => {
					// Only an acknowledged Stop marks the job stopped; an aborted stream
					// on its own proves nothing about the runtime. Nor does a 200: the
					// host answers every owned Stop, so "scene unchanged" may only be
					// claimed when the runtime actually reported it was not applied.
					if (!running) return;
					const outcome = stopOutcome(result);
					if (!outcome) return;
					patchItem((item) => item.kind === "job" && item.jobId === running.jobId && !isTerminalJobState(item.state), {
						state: outcome.status === "not_applied" ? "cancelled" : "reconciling",
						phase: null,
						outcome,
						acceptance: null,
					});
					patchItem((item) => item.kind === "tool" && item.status === "running", {
						status: "cancelled",
						result: outcome,
						elapsedMs: null,
					});
				})
				.catch(() => {});
			// Stop is an answer too: the line says "Stopped" now, not when the aborted
			// request finally settles.
			if (!state.streaming) { set({ streaming: false }); return; }
			const endedAt = clock();
			set({
				streaming: false,
				turnStartedAt: null,
				lastTurn: { status: "stopped", endedAt, durationMs: endedAt - (state.turnStartedAt ?? endedAt), failure: null },
			});
		},
		async acceptJob(jobId) {
			const job = findJob(jobId);
			if (!job || job.acceptance?.status !== "required") return;
			patchItem((item) => item.kind === "job" && item.jobId === jobId, { acceptance: { status: "accepting" } });
			try {
				const result = await transport.acceptJob?.({ jobId, sessionId: state.sessionId, turnId: state.turnId });
				if (result?.receipt) applyReceiptEvent(result.receipt);
				else patchItem((item) => item.kind === "job" && item.jobId === jobId, { acceptance: { status: "required", error: "The host did not acknowledge the acceptance." } });
			} catch (error) {
				patchItem((item) => item.kind === "job" && item.jobId === jobId, { acceptance: { status: "required", error: String(error?.message || error) } });
			}
		},
		applyImage: (itemId) => runImageAction(itemId, "place"),
		undoImage: (itemId) => runImageAction(itemId, "remove"),
		acknowledgeImageAction: ({ requestId, ok, error, receiptId }) => {
			const item = state.items.find((entry) => entry.kind === "image" && entry.apply?.requestId === requestId);
			settleImageAction(requestId, { ok, error, receiptId }, item?.placed ? "remove" : "place");
		},
		clearRateLimit: () => set({ rateLimit: null }),
		clearContext: resetSession,
		newSession: resetSession,
	};
}
