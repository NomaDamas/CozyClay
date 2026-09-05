const OPT_OUT_KEY = "cozyclay.analyticsOptOut";
const ACTIVATION_KEY = "cozyclay.analyticsActivation";
const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
	"https://cozyclay.org",
	"https://www.cozyclay.org",
]);
const EVENT_PROPERTIES = Object.freeze({
	"install:first_launch": [],
	"app:session_started": [],
	"scene:created": ["scene_source"],
	"scene:loaded": ["scene_source"],
	"craft:first_action": ["action_kind"],
	"motion:backend_state": ["backend", "host_configured"],
	"motion:generate_blocked": ["surface"],
	"motion:job_started": ["backend", "input_mode", "duration_bucket"],
	"motion:job_succeeded": ["backend", "duration_bucket", "input_mode"],
	"motion:job_failed": ["backend", "duration_bucket", "input_mode", "error_code"],
	"export:blocking_frame_succeeded": ["format"],
	"export:video_succeeded": ["format"],
	"sample:played": ["from"],
	"activation:completed": ["activation_path"],
});
const DENIED_PROPERTY_KEYS = new Set(["prompt", "text", "name", "url", "path", "file"]);

let posthog = null;
let initialized = false;
let enabled = false;
let initPromise = null;
let activationFired = false;
let disabledLogged = false;

function storage() {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
}

function readStorage(key) {
	try {
		return storage()?.getItem(key) ?? null;
	} catch {
		return null;
	}
}

function writeStorage(key, value) {
	try {
		storage()?.setItem(key, value);
	} catch {
		// Analytics persistence is best effort and must never affect the app.
	}
}

export function normalizeOrigin(value) {
	if (typeof value !== "string") return "";
	return value.trim().toLowerCase().replace(/[/.]+$/g, "");
}

export function parseAllowlist(value) {
	if (value === undefined) return [...DEFAULT_ALLOWED_ORIGINS];
	return value
		.split(",")
		.map(normalizeOrigin)
		.filter(Boolean);
}

export function isOriginAllowed(origin, allowlist) {
	const normalizedOrigin = normalizeOrigin(origin);
	return Array.isArray(allowlist)
		&& allowlist.some((allowed) => normalizedOrigin === normalizeOrigin(allowed));
}

const isSafePropertyValue = (value) => {
	if (typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	return typeof value === "string" && value.length <= 32 && !/\s/.test(value);
};

export function sanitizeProps(event, props) {
	const allowedKeys = EVENT_PROPERTIES[event] ?? [];
	if (!props || typeof props !== "object" || Array.isArray(props)) return {};
	const sanitized = {};
	for (const key of allowedKeys) {
		if (DENIED_PROPERTY_KEYS.has(key) || !Object.hasOwn(props, key)) continue;
		if (isSafePropertyValue(props[key])) sanitized[key] = props[key];
	}
	return sanitized;
}

/**
 * Convert the bridge health payload into the analytics contract. The bridge
 * only exposes a safe location label; the configured host itself never leaves
 * the local process. A missing/unhealthy bridge is the useful `none` bucket.
 */
export function motionBackendState(health) {
	if (!health || health.ok !== true) return { backend: "none", host_configured: false };
	if (typeof health.backend === "string" && ["none", "local_kimodo", "hosted"].includes(health.backend)) {
		return {
			backend: health.backend,
			host_configured: health.host_configured === true
				|| (typeof health.host === "string" && health.host.trim().length > 0),
		};
	}
	const host = typeof health.host === "string" ? health.host.trim() : "";
	return {
		// The current /ardy bridge is the local Kimodo integration even when it
		// dispatches to a configured GPU box over SSH. A future hosted API can
		// opt into the explicit `backend: "hosted"` field above.
		backend: "local_kimodo",
		host_configured: Boolean(host),
	};
}

export function bucketMs(ms) {
	if (!Number.isFinite(ms) || ms < 1000) return "lt1s";
	if (ms < 3000) return "1-3s";
	if (ms < 10000) return "3-10s";
	if (ms < 30000) return "10-30s";
	return "gte30s";
}

const URL_PROPERTY_KEYS = [
	"$current_url",
	"$initial_current_url",
	"$referrer",
	"$initial_referrer",
];
const CAMPAIGN_PROPERTY_KEYS = [
	"utm_source",
	"utm_medium",
	"utm_campaign",
	"utm_content",
	"utm_term",
	"gad_source",
	"mc_cid",
	"gclid",
	"gclsrc",
	"dclid",
	"gbraid",
	"wbraid",
	"fbclid",
	"msclkid",
	"twclid",
	"li_fat_id",
	"igshid",
	"ttclid",
	"rdt_cid",
	"epik",
	"qclid",
	"sccid",
	"irclid",
	"_kx",
	"ph_keyword",
];

function stripUrlTail(value) {
	if (typeof value !== "string") return value;
	return value.split("#")[0].split("?")[0];
}

// SDK-standard pageview properties carry location.href/document.referrer;
// strip query strings and fragments so tokens or future URL state never
// leave the browser. Runs as posthog's before_send hook.
export function scrubEventUrls(event) {
	if (!event || typeof event !== "object" || !event.properties) return event;
	const containers = [
		event.properties,
		event.properties.$set,
		event.properties.$set_once,
		event.$set,
		event.$set_once,
	].filter((value) => value && typeof value === "object" && !Array.isArray(value));
	for (const properties of containers) {
		for (const key of URL_PROPERTY_KEYS) {
			if (typeof properties[key] === "string") {
				properties[key] = stripUrlTail(properties[key]);
			}
		}
		for (const key of CAMPAIGN_PROPERTY_KEYS) {
			delete properties[key];
			delete properties[`$initial_${key}`];
		}
		for (const key of Object.keys(properties)) {
			if (key.startsWith("$session_entry_")) delete properties[key];
		}
	}
	return event;
}

export function shouldFireActivation(state) {
	return state?.activationTracked !== true;
}

export function getAnalyticsOptOut() {
	return runtimeConfig()?.distribution === "npm"
		? runtimeConfig()?.telemetryEnabled !== true
		: readStorage(OPT_OUT_KEY) === "1";
}

function clearAnalyticsStorage() {
	try {
		const store = storage();
		if (!store) return;
		const doomed = [];
		for (let i = 0; i < store.length; i += 1) {
			const key = store.key(i);
			if (key && key.startsWith("ph_") && key.endsWith("_posthog")) doomed.push(key);
		}
		for (const key of doomed) store.removeItem(key);
	} catch {
		// Best effort; never let cleanup break the app.
	}
}

async function syncPackageTelemetry(enabled) {
	if (runtimeConfig()?.distribution !== "npm") return { ok: true, enabled };
	try {
		const response = await fetch("/__cozyclay/telemetry", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled }),
		});
		if (!response.ok) return { ok: false, enabled: !enabled };
		const next = await response.json();
		globalThis.__COZYCLAY_RUNTIME__ = next;
		return { ok: true, enabled: next.telemetryEnabled === true };
	} catch {
		return { ok: false, enabled: !enabled };
	}
}

export async function setAnalyticsOptOut(optOut) {
	const requestedOptOut = optOut === true;
	const packageRuntime = runtimeConfig()?.distribution === "npm";
	const syncResult = await syncPackageTelemetry(!requestedOptOut);
	if (!syncResult.ok) return getAnalyticsOptOut();
	const telemetryEnabled = syncResult.enabled;
	const value = !telemetryEnabled;
	writeStorage(OPT_OUT_KEY, value ? "1" : "0");
	if (value) clearAnalyticsStorage();
	if (packageRuntime && !value) {
		globalThis.location?.reload();
		return false;
	}
	if (!posthog && !value) await initAnalytics();
	if (!posthog) return value;
	try {
		if (value) {
			enabled = false;
			posthog.opt_out_capturing();
		} else {
			posthog.opt_in_capturing();
			enabled = initialized;
		}
	} catch {
		enabled = false;
		// SDK opt-in/out is best effort.
	}
	return value;
}

function environment() {
	return import.meta.env ?? {};
}

function runtimeConfig() {
	const value = globalThis.__COZYCLAY_RUNTIME__;
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value;
}

function isLoopbackOrigin(origin) {
	try {
		const parsed = new URL(origin);
		return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1";
	} catch {
		return false;
	}
}

export function resolveAnalyticsRuntime({
	env = environment(),
	origin = globalThis.location?.origin ?? "",
	runtime = runtimeConfig(),
} = {}) {
	if (!env.PROD) return { kind: "disabled", reason: "not production" };
	if (runtime?.distribution === "npm") {
		if (runtime.telemetryEnabled !== true) return { kind: "disabled", reason: "opted out" };
		if (!isLoopbackOrigin(origin)) return { kind: "disabled", reason: "unapproved origin" };
		if (typeof runtime.apiKey !== "string" || runtime.apiKey.length === 0) {
			return { kind: "disabled", reason: "no key" };
		}
		return {
			kind: "enabled",
			distribution: "npm",
			apiKey: runtime.apiKey,
			apiHost: runtime.apiHost || "https://t.cozyclay.org",
			appVersion: runtime.appVersion || null,
			installationId: runtime.installationId || null,
			firstLaunch: runtime.firstLaunch === true,
		};
	}
	if (!env.VITE_POSTHOG_KEY) return { kind: "disabled", reason: "no key" };
	if (!isOriginAllowed(origin, parseAllowlist(env.VITE_POSTHOG_ALLOWED_ORIGINS))) {
		return { kind: "disabled", reason: "unapproved origin" };
	}
	return {
		kind: "enabled",
		distribution: "hosted",
		apiKey: env.VITE_POSTHOG_KEY,
		apiHost: env.VITE_POSTHOG_HOST || "https://us.i.posthog.com",
		appVersion: env.VITE_APP_VERSION || null,
		installationId: null,
		firstLaunch: false,
	};
}

function disabledReason(env) {
	const runtime = resolveAnalyticsRuntime({ env });
	return runtime.kind === "disabled" ? runtime.reason : getAnalyticsOptOut() ? "opted out" : null;
}

export async function initAnalytics() {
	if (initialized || initPromise) return initPromise;
	const env = environment();
	const reason = disabledReason(env);
	if (reason) {
		if (!disabledLogged) {
			console.info("[analytics] disabled: " + reason);
			disabledLogged = true;
		}
		return undefined;
	}

	initPromise = (async () => {
		try {
			const module = await import("posthog-js");
			if (getAnalyticsOptOut()) return;
			const resolved = resolveAnalyticsRuntime({ env });
			if (resolved.kind === "disabled") return;
			posthog = module.default ?? module;
			posthog.init(resolved.apiKey, {
				api_host: resolved.apiHost,
				defaults: "2025-05-24",
				autocapture: false,
				capture_pageview: false,
				// Keep the wire contract at the disclosed events: no $pageleave.
				capture_pageleave: false,
				person_profiles: "never",
				// Hosted visits persist in the browser. Official npm sessions
				// bootstrap from the CLI-owned installation id instead.
				persistence: resolved.distribution === "npm" ? "memory" : "localStorage",
				respect_dnt: true,
				disable_session_recording: true,
				capture_dead_clicks: false,
				capture_performance: false,
				disable_capture_url_hashes: true,
				save_campaign_params: false,
				save_referrer: false,
				mask_personal_data_properties: true,
				request_batching: false,
				advanced_disable_feature_flags: true,
				disable_external_dependency_loading: true,
				disable_surveys: true,
				// Needed once api_host points at a first-party proxy; harmless otherwise.
				ui_host: "https://us.posthog.com",
				bootstrap: resolved.installationId
					? { distinctID: resolved.installationId, isIdentifiedID: false }
					: undefined,
				before_send: scrubEventUrls,
			});
			initialized = true;
			enabled = true;
			posthog.register({
				distribution: resolved.distribution,
				...(resolved.appVersion ? { app_version: resolved.appVersion } : {}),
			});
			// Test hook, mirroring the window.__cozyclay convention: lets QA
			// drivers inspect the live SDK without shipping a real global API.
			globalThis.__cozyclayAnalytics = { instance: posthog };
			posthog.capture("$pageview");
			if (resolved.distribution === "npm") {
				track("app:session_started");
				// This follows the session marker so the two events form one
				// capability baseline in funnel queries.
				void recordMotionBackendState();
				if (resolved.firstLaunch) track("install:first_launch");
			} else {
				// Hosted sessions have PostHog's native session marker rather than
				// the npm-only custom event above.
				void recordMotionBackendState();
			}
		} catch {
			console.info("[analytics] initialization failed");
		}
	})();
	await initPromise;
}

async function recordMotionBackendState() {
	let health = null;
	try {
		const response = await fetch("/ardy/health", { signal: AbortSignal.timeout(5000) });
		if (response.ok) health = await response.json();
	} catch {
		// No bridge is a normal hosted/demo state.
	}
	track("motion:backend_state", motionBackendState(health));
}

export function track(event, props = {}) {
	if (!initialized || !enabled || !posthog) return;
	try {
		posthog.capture(event, sanitizeProps(event, props));
	} catch {
		// Analytics must never affect app behavior.
	}
}

export function trackActivation(path) {
	if (!initialized || !enabled || activationFired) return;
	const tracked = readStorage(ACTIVATION_KEY) === "1";
	if (!shouldFireActivation({ activationTracked: tracked })) {
		activationFired = true;
		return;
	}
	activationFired = true;
	writeStorage(ACTIVATION_KEY, "1");
	track("activation:completed", { activation_path: path });
}
