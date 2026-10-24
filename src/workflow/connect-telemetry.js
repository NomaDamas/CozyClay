// The model-connect funnel: agent:connect_opened -> agent:connect_started ->
// agent:connect_finished, plus agent:model_changed. One attempt at a time: its
// provider, method, how far it got (step) and when it began. Only closed values
// leave: a provider id from the closed list (else "other"), a method, an outcome,
// a step and a duration bucket. Never a key, token, account, email or message.
// The connect UI needs the local sidecar, so a hosted build (no sidecar, the
// panel stays offline) never reaches these calls.
import { track } from "../analytics.js";
import { admit } from "../analytics-friction.js";
import { CONNECT_PROVIDERS, bucketLong } from "../analytics-strict.js";
const METHODS = new Set(["oauth", "api_key", "chatgpt"]);
const ENTRIES = new Set(["first_run", "failure_card", "signed_out", "menu", "other"]);
const CONNECTED_KEY = "cozyclay.agentConnected";
const OPENED_PER_SESSION = 5, MODEL_CHANGES_PER_SESSION = 10;

let send = track, now = () => Date.now();
let attempt = null;
let lastTurnFailed = false;

const providerOf = (id) => (CONNECT_PROVIDERS.includes(id) ? id : "other");
const emit = (event, props) => { try { send(event, props); } catch { /* telemetry is advisory */ } };
const storage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };

/** The connect UI opened. The signed-out card counts as first_run until this browser profile has connected once. */
export function connectOpened(entry) {
	let value = ENTRIES.has(entry) ? entry : "other";
	try { if (value === "signed_out" && storage()?.getItem(CONNECTED_KEY) !== "1") value = "first_run"; } catch { /* storage is optional */ }
	if (admit("agent:connect_opened", OPENED_PER_SESSION)) emit("agent:connect_opened", { entry: value });
}

/** One attempt begins; an attempt still open is closed as abandoned first. */
export function connectStarted(providerId, method) {
	if (attempt) connectFinished("abandoned");
	attempt = { provider: providerOf(providerId), method: METHODS.has(method) ? method : "api_key", startedAt: now(), step: "list" };
	emit("agent:connect_started", { provider: attempt.provider, method: attempt.method });
}

/** How far the open attempt got: waiting (the flow runs), prompt (it asks for a key, address or code). */
export function connectStep(step) {
	if (attempt && ["list", "prompt", "waiting", "done"].includes(step)) attempt.step = step;
}

/** The open attempt ends: ok, failed, cancelled (the user's Cancel) or abandoned (closed or left unfinished). */
export function connectFinished(outcome) {
	const ended = attempt;
	if (!ended) return;
	attempt = null;
	const step = outcome === "ok" ? "done" : ended.step;
	emit("agent:connect_finished", { provider: ended.provider, method: ended.method, outcome, step, duration: bucketLong(now() - ended.startedAt) });
	if (outcome === "ok") { try { storage()?.setItem(CONNECTED_KEY, "1"); } catch { /* storage is optional */ } }
}

/** The connect panel went away. A ChatGPT attempt goes on in the agent panel; any other is abandoned. */
export function connectPanelClosed() {
	if (attempt && attempt.method !== "chatgpt") connectFinished("abandoned");
}

/** The ChatGPT sign-in settles through the agent panel's auth state. */
export function connectAuthState(state) {
	if (attempt?.method !== "chatgpt") return;
	if (state === "signing-in") connectStep("waiting");
	else if (state === "ready" || state === "no-entitlement") connectFinished("ok");
	// The browser sign-in failed or was closed: the sidecar reports neither apart.
	else if (state === "signed-out") connectFinished("abandoned");
}

/** A model picked in the dropdown (`provider/id`), and whether the last turn had failed. */
export function modelChanged(modelKey) {
	const provider = providerOf(String(modelKey ?? "").split("/")[0]);
	if (admit("agent:model_changed", MODEL_CHANGES_PER_SESSION)) emit("agent:model_changed", { provider, after_failure: lastTurnFailed });
}

/** agent-turn-telemetry.js reports each turn's outcome, for model_changed.after_failure. */
export function noteTurnOutcome(outcome) {
	lastTurnFailed = outcome === "failed";
}

/** Tests only: capture what is sent, drive the clock, and start clean; returns the restore. */
export function connectTelemetrySeam({ capture = track, clock = () => Date.now() } = {}) {
	const previous = [send, now];
	send = capture; now = clock; attempt = null; lastTurnFailed = false;
	return () => { [send, now] = previous; attempt = null; lastTurnFailed = false; };
}
