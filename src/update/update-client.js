// The in-Studio update notice (U1): the launcher's GET/POST /__cozyclay/update
// (bin/update-routes.mjs) read and driven from the page. Pure apart from the
// injected fetch, timers, storage and window, so test/verify-update-client.mjs
// drives it under Node. A page without window.__COZYCLAY_RUNTIME__ (the hosted
// site, Vite dev) makes no request at all.
export const UPDATE_URL = "/__cozyclay/update";
export const DISMISS_KEY = "cozyclay:update-dismissed";
export const POLL_MS = 6 * 60 * 60 * 1000;
export const VISIBLE_STALE_MS = 60 * 60 * 1000;
export const UPDATING_POLL_MS = 2000;

const VERSION = /^\d+\.\d+\.\d+$/;
const KINDS = new Set(["global", "npx", "clone"]);
const STATUSES = new Set(["latest", "outdated", "unknown"]);
const PHASES = new Set(["idle", "updating", "restart_needed", "failed"]);
const ERROR_CLASSES = new Set(["permission", "network", "node_version", "npm_missing", "other"]);
const NOTES_PREFIX = "https://github.com/NomaDamas/CozyClay/releases/tag/v";
const GLOBAL_COMMAND = "npm install -g cozyclay@latest";
const NPX_COMMAND = "npx cozyclay";
const RESTART_COMMAND = "cclay";

/** True on a page the npm launcher served (it injects window.__COZYCLAY_RUNTIME__). */
function hasLauncherRuntime(win = globalThis.window) {
	try { return Boolean(win?.__COZYCLAY_RUNTIME__); } catch { return false; }
}

const version = (value) => (typeof value === "string" && VERSION.test(value) ? value : null);

/** The route body as the client trusts it: closed values only; anything else reads as "unknown". */
export function normalizeUpdateInfo(body) {
	if (!body || typeof body !== "object") return null;
	const kind = KINDS.has(body.kind) ? body.kind : "clone";
	const latest = version(body.latest);
	const phase = PHASES.has(body.phase) ? body.phase : "idle";
	return {
		enabled: body.enabled === true,
		current: version(body.current),
		latest,
		status: STATUSES.has(body.status) ? body.status : "unknown",
		kind,
		canSelfUpdate: body.canSelfUpdate === true,
		phase,
		errorClass: phase === "failed" ? (ERROR_CLASSES.has(body.errorClass) ? body.errorClass : "other") : null,
		durationMs: Number.isFinite(body.durationMs) && body.durationMs >= 0 ? body.durationMs : null,
		// Opened in a new tab, so only the project's own release page is accepted.
		notesUrl: latest && body.notesUrl === `${NOTES_PREFIX}${latest}` ? body.notesUrl : null,
		command: kind === "npx" ? NPX_COMMAND : GLOBAL_COMMAND,
	};
}

async function request(fetchImpl, init, win) {
	if (!hasLauncherRuntime(win) || typeof fetchImpl !== "function") return null;
	try {
		const response = await fetchImpl(UPDATE_URL, { cache: "no-store", credentials: "same-origin", ...init });
		if (!response?.ok) return null;
		return normalizeUpdateInfo(await response.json());
	} catch {
		return null;
	}
}

/** GET the launcher's update state; null on a hosted page or any failure (the notice fails silently). */
export const fetchUpdateInfo = (fetchImpl = globalThis.fetch?.bind(globalThis), win = globalThis.window) => request(fetchImpl, { method: "GET" }, win);

/** POST: ask the launcher to install `latest`. The 202 body, or null (403/409/network). No body is sent. */
export const startUpdate = (fetchImpl = globalThis.fetch?.bind(globalThis), win = globalThis.window) => request(fetchImpl, { method: "POST" }, win);

/** patch | minor | major: how far `current` is behind `latest`. */
export function behindOf(current, latest) {
	const [a, b] = [current, latest].map((value) => (version(value) ?? "0.0.0").split(".").map(Number));
	if (a[0] !== b[0]) return "major";
	return a[1] !== b[1] ? "minor" : "patch";
}

// The in-progress export phases (App.jsx updateExportStatus; StatusBar.jsx BUSY). completed, failed and
// cancelled stay in exportStatus after the job ends, so a non-null status alone is not "exporting".
const EXPORT_BUSY_PHASES = new Set(["preparing", "encoding", "finalizing"]);

/** "Update now" waits while an agent turn, an export or a recording runs: they would cross the file swap. */
export function updateBlocked({ agentRunning = false, exportStatus = null, recState = "idle" } = {}) {
	return Boolean(agentRunning) || EXPORT_BUSY_PHASES.has(exportStatus?.phase) || recState === "recording";
}

const HIDDEN = Object.freeze({ view: "hidden", actions: [] });

/** The chip and dialog view for one poll result and the local dismiss state ({ dismissed }). */
export function nextUpdateState(info, local = {}) {
	if (!info || !info.enabled) return HIDDEN;
	const base = {
		current: info.current, latest: info.latest, kind: info.kind, notesUrl: info.notesUrl,
		command: info.command, canSelfUpdate: info.canSelfUpdate, errorClass: null,
	};
	const oneClick = info.kind === "global" && info.canSelfUpdate;
	if (info.phase === "updating") return { ...base, view: "updating", actions: [] };
	if (info.phase === "restart_needed") return { ...base, view: "restart_needed", command: RESTART_COMMAND, actions: ["copy_command"] };
	if (info.phase === "failed") {
		return { ...base, view: "failed", errorClass: info.errorClass ?? "other", command: GLOBAL_COMMAND,
			actions: oneClick ? ["retry", "copy_command"] : ["copy_command"] };
	}
	const shown = info.status === "outdated" && (info.kind === "global" || info.kind === "npx") && info.latest && local.dismissed !== info.latest;
	if (!shown) return HIDDEN;
	return { ...base, view: "available", behind: behindOf(info.current, info.latest), actions: [oneClick ? "update_now" : "copy_command", "later"] };
}

// Reading window.localStorage itself throws when site data is blocked, so even the default is guarded.
const safeStorage = () => { try { return globalThis.localStorage; } catch { return null; } };

/** The dismissed version, or null. Storage that throws reads as "nothing dismissed". */
export function readDismissed(storage = safeStorage()) {
	try { return version(storage?.getItem(DISMISS_KEY)); } catch { return null; }
}

/** Hide `latest` for good (per version). False when storage refused; the notice still hides for this page. */
export function writeDismissed(latest, storage = safeStorage()) {
	try { storage.setItem(DISMISS_KEY, latest); return true; } catch { return false; }
}

const defaultTimers = {
	set: (fn, ms) => setTimeout(fn, ms),
	clear: (timer) => clearTimeout(timer),
	now: () => Date.now(),
	// After the Studio's first frame, then idle: the check never competes with boot.
	afterFirstFrame(fn) {
		const idle = globalThis.requestIdleCallback ?? ((run) => setTimeout(run, 200));
		const frame = globalThis.requestAnimationFrame ?? ((run) => setTimeout(run, 16));
		frame(() => idle(fn));
	},
};

/**
 * The poll loop: once after the first frame and idle, every 6 h, on a visible
 * tab whose last check is over 1 h old, every 2 s while installing. `onState`
 * gets { state, info } after every change. Returns { dismiss, update, stop }.
 */
export function createUpdatePoller({
	fetchImpl = globalThis.fetch?.bind(globalThis), onState = () => {}, timers = defaultTimers,
	storage = safeStorage(), win = globalThis.window, doc = globalThis.document,
} = {}) {
	const noop = { dismiss() {}, update: async () => null, stop() {} };
	if (!hasLauncherRuntime(win)) return noop;
	let info = null, timer = null, stopped = false, inflight = null, lastCheck = -Infinity;
	let dismissed = readDismissed(storage);
	const emit = () => { if (!stopped) onState({ state: nextUpdateState(info, { dismissed }), info }); };
	const schedule = () => {
		if (stopped) return;
		if (timer !== null) timers.clear(timer);
		timer = timers.set(check, info?.phase === "updating" ? UPDATING_POLL_MS : POLL_MS);
	};
	const apply = (next) => { if (next) { info = next; emit(); } };
	function check() {
		if (stopped) return Promise.resolve(info);
		if (inflight) return inflight;
		// An early check (a visible tab) replaces the pending poll; the schedule never doubles.
		if (timer !== null) { timers.clear(timer); timer = null; }
		lastCheck = timers.now();
		inflight = fetchUpdateInfo(fetchImpl, win);
		return inflight.then((next) => { inflight = null; apply(next); schedule(); return info; });
	}
	const onVisible = () => {
		if (doc?.visibilityState === "visible" && timers.now() - lastCheck > VISIBLE_STALE_MS) void check();
	};
	const onStorage = (event) => {
		if (event?.key !== DISMISS_KEY && event?.key !== null) return;
		dismissed = readDismissed(storage);
		emit();
	};
	try { doc?.addEventListener?.("visibilitychange", onVisible); win?.addEventListener?.("storage", onStorage); } catch { /* no listeners: the 6 h poll still runs */ }
	timers.afterFirstFrame(() => { if (!stopped) void check(); });
	return {
		dismiss(latest) {
			if (!version(latest)) return;
			writeDismissed(latest, storage);
			dismissed = latest;
			emit();
		},
		async update() {
			const next = await startUpdate(fetchImpl, win);
			apply(next);
			schedule();
			return next;
		},
		stop() {
			stopped = true;
			if (timer !== null) timers.clear(timer);
			try { doc?.removeEventListener?.("visibilitychange", onVisible); win?.removeEventListener?.("storage", onStorage); } catch { /* best effort */ }
		},
	};
}
