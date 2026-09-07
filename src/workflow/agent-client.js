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

/** Effort options for a model entry from /agent/models; the backend default comes first. */
export function effortOptions(entry) {
	const efforts = Array.isArray(entry?.efforts) ? entry.efforts : [];
	if (!efforts.length) return [];
	const fallback = entry.defaultEffort && efforts.includes(entry.defaultEffort) ? entry.defaultEffort : efforts[0];
	return [fallback, ...efforts.filter((effort) => effort !== fallback)];
}

export const DEFAULT_MODELS = [
	{ id: "gpt-5.1-codex", label: "Codex (default)" },
	{ id: "gpt-5.1", label: "GPT-5.1" },
	{ id: "gpt-5.1-mini", label: "GPT-5.1 mini" },
];

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

export function createHttpTransport({ fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
	const request = async (path, init) => {
		const response = await fetchImpl(sidecarUrl(path), {
			headers: { "content-type": "application/json" },
			...init,
		});
		if (!response.ok) throw new Error(`${path} responded ${response.status}`);
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
			return Array.isArray(result?.models) && result.models.length ? result.models : DEFAULT_MODELS;
		},
		async stop(sessionId) {
			return request("/agent/stop", { method: "POST", body: JSON.stringify({ sessionId }) });
		},
		async image({ prompt, imageDataUrl, referenceDataUrl, quality = "auto" }, signal) {
			return request("/agent/image", { method: "POST", body: JSON.stringify({ prompt, imageDataUrl, ...(referenceDataUrl ? { referenceDataUrl } : {}), quality }), signal });
		},
		async video(payload, signal) {
			return request("/agent/video", { method: "POST", body: JSON.stringify(payload), signal });
		},
		async videoProviders() {
			return request("/agent/video/providers");
		},
		/** Streams sidecar events to `onEvent`. Resolves when the turn ends. */
		async turn({ sessionId, text, attachFrame, model, effort }, onEvent, signal) {
			const response = await fetchImpl(sidecarUrl("/agent/turn"), {
				method: "POST",
				headers: { "content-type": "application/json", accept: "text/event-stream" },
				body: JSON.stringify({ sessionId, text, attachFrame, model, ...(effort ? { effort } : {}) }),
				signal,
			});
			if (!response.ok || !response.body) {
				onEvent({ type: "error", code: "upstream", message: `turn responded ${response.status}` });
				onEvent({ type: "done" });
				return;
			}
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const parsed = parseSseChunk(buffer);
				buffer = parsed.tail;
				for (const event of parsed.events) onEvent(event);
			}
			const parsed = parseSseChunk(`${buffer}\n`);
			for (const event of parsed.events) onEvent(event);
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
			return DEFAULT_MODELS;
		},
		async stop() {
			return { ok: true };
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
