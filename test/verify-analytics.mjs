#!/usr/bin/env node
import assert from "node:assert/strict";
import * as analytics from "../src/analytics.js";
import { readFileSync } from "node:fs";
import {
	bucketMs,
	scrubEventUrls,
	isOriginAllowed,
	normalizeOrigin,
	parseAllowlist,
	resolveAnalyticsRuntime,
	motionBackendState,
	sanitizeProps,
	bucketCount,
	bucketProjectAge,
	bucketSessionDuration,
} from "../src/analytics.js";

assert.equal(normalizeOrigin("HTTPS://CozyClay.Org/"), "https://cozyclay.org");
assert.equal(normalizeOrigin("https://www.cozyclay.org.../"), "https://www.cozyclay.org");
assert.equal(normalizeOrigin("https://COZYCLAY.ORG:8443/"), "https://cozyclay.org:8443");

assert.deepEqual(parseAllowlist(), ["https://cozyclay.org", "https://www.cozyclay.org"]);
assert.deepEqual(
	parseAllowlist(" HTTPS://Preview.CozyClay.Org/ ,https://cozyclay.org... "),
	["https://preview.cozyclay.org", "https://cozyclay.org"],
);

const allowlist = parseAllowlist();
assert.equal(isOriginAllowed("https://cozyclay.org", allowlist), true);
assert.equal(isOriginAllowed("https://www.cozyclay.org", allowlist), true);
assert.equal(isOriginAllowed("https://evilcozyclay.org", allowlist), false);
assert.equal(isOriginAllowed("https://preview.cozyclay.org", allowlist), false);
assert.equal(isOriginAllowed("https://cozyclay.org.evil.example", allowlist), false);

assert.deepEqual(
	sanitizeProps("motion:job_succeeded", {
		backend: "hosted",
		duration_bucket: "1-3s",
		input_mode: "pose",
		prompt: "secret prompt",
		name: "private name",
		unknown: "discarded",
	}),
	{ backend: "hosted", duration_bucket: "1-3s", input_mode: "pose" },
);
assert.deepEqual(
	sanitizeProps("scene:created", {
		scene_source: "quick start",
		path: "private",
		url: "https://private.example",
		file: "private.blend",
	}),
	{},
	"free text and hard-denied keys are never captured",
);
assert.deepEqual(
	sanitizeProps("motion:job_failed", {
		backend: "local_kimodo",
		duration_bucket: "gte30s",
		input_mode: true,
		error_code: 503,
	}),
	{ backend: "local_kimodo", duration_bucket: "gte30s", input_mode: true, error_code: 503 },
);
assert.deepEqual(sanitizeProps("motion:job_failed", { error_code: Number.POSITIVE_INFINITY }), {});
assert.deepEqual(motionBackendState(null), { backend: "none", host_configured: false });
assert.deepEqual(motionBackendState({ ok: true, host: "local" }), { backend: "local_kimodo", host_configured: true });
assert.deepEqual(motionBackendState({ ok: true, host: "user@gpu-box" }), { backend: "local_kimodo", host_configured: true });
assert.deepEqual(motionBackendState({ ok: true, backend: "hosted", host_configured: false }), { backend: "hosted", host_configured: false });
assert.deepEqual(
	sanitizeProps("motion:backend_state", { backend: "hosted", host_configured: true, host: "user@gpu-box" }),
	{ backend: "hosted", host_configured: true },
);
assert.deepEqual(sanitizeProps("motion:generate_blocked", { surface: "timeline", prompt: "private" }), { surface: "timeline" });

const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
assert.match(appSource, /motion:job_started.*backend/);
assert.match(appSource, /motion:job_succeeded[\s\S]*?duration_bucket/);
assert.match(appSource, /motion:job_failed[\s\S]*?duration_bucket/);
assert.doesNotMatch(appSource, /latency_bucket/);
assert.deepEqual(sanitizeProps("feature:used", { name: "pose_edit", prompt: "secret" }), { name: "pose_edit" });
assert.deepEqual(sanitizeProps("feature:used", { name: "private-feature" }), {});
assert.deepEqual(sanitizeProps("install:first_launch", { heard_from: "github" }), { heard_from: "github" });
assert.deepEqual(sanitizeProps("install:first_launch", { heard_from: "skip" }), {});
assert.equal(bucketCount(0), "0");
assert.equal(bucketCount(4), "4-10");
assert.equal(bucketSessionDuration(0), "lt1m");
assert.equal(bucketProjectAge(2 * 24 * 60 * 60 * 1000), "1-7d");

assert.equal(bucketMs(0), "lt1s");
assert.equal(bucketMs(999), "lt1s");
assert.equal(bucketMs(1000), "1-3s");
assert.equal(bucketMs(2999), "1-3s");
assert.equal(bucketMs(3000), "3-10s");
assert.equal(bucketMs(9999), "3-10s");
assert.equal(bucketMs(10000), "10-30s");
assert.equal(bucketMs(29999), "10-30s");
assert.equal(bucketMs(30000), "gte30s");

const scrubbedEvent = scrubEventUrls({
		event: "$pageview",
		properties: {
			$current_url: "https://cozyclay.org/app/?token=secret#pose=7",
			$referrer: "https://news.ycombinator.com/item?id=123",
			$referring_domain: "news.ycombinator.com",
			$pathname: "/app/",
			$set_once: {
				$initial_current_url: "https://cozyclay.org/app/?prompt=secret#pose=7",
				$initial_referrer: "https://search.example/?q=private",
				$initial_utm_source: "private-source",
				ph_keyword: "private search",
			},
			utm_source: "private-source",
			fbclid: "private-click-id",
		},
		$set_once: {
			$initial_current_url: "https://cozyclay.org/app/?token=secret",
			$initial_referrer: "https://search.example/?q=private",
			$initial_utm_campaign: "private-campaign",
			ph_keyword: "private search",
			$session_entry_url: "https://cozyclay.org/app/?token=secret",
			$session_entry_utm_source: "private-source",
		},
	});
assert.deepEqual(
	scrubbedEvent.properties,
	{
		$current_url: "https://cozyclay.org/app/",
		$referrer: "https://news.ycombinator.com/item",
		$referring_domain: "news.ycombinator.com",
		$pathname: "/app/",
		$set_once: {
			$initial_current_url: "https://cozyclay.org/app/",
			$initial_referrer: "https://search.example/",
		},
	},
	"URL tails, search terms, and campaign values never leave the browser",
);
assert.deepEqual(scrubbedEvent.$set_once, {
	$initial_current_url: "https://cozyclay.org/app/",
	$initial_referrer: "https://search.example/",
});
assert.equal(scrubEventUrls(null), null);

const installationId = "018f0d66-3a4b-7c2d-8e9f-123456789abc";
assert.deepEqual(
	resolveAnalyticsRuntime({
		env: { PROD: true, VITE_POSTHOG_KEY: "phc_hosted", VITE_POSTHOG_HOST: "https://t.cozyclay.org" },
		origin: "https://cozyclay.org",
		runtime: null,
	}),
	{
		kind: "enabled",
		distribution: "hosted",
		apiKey: "phc_hosted",
		apiHost: "https://t.cozyclay.org",
		appVersion: null,
		installationId: null,
		firstLaunch: false,
		firstLaunchHeardFrom: null,
		installKind: null,
		originKind: "hosted",
	},
);
assert.deepEqual(
	resolveAnalyticsRuntime({
		env: { PROD: true },
		origin: "http://127.0.0.1:5180",
		runtime: {
			distribution: "npm",
			telemetryEnabled: true,
			installationId,
			appVersion: "1.5.0",
			apiKey: "phc_npm",
			apiHost: "https://t.cozyclay.org",
			firstLaunch: true,
		},
	}),
	{
		kind: "enabled",
		distribution: "npm",
		apiKey: "phc_npm",
		apiHost: "https://t.cozyclay.org",
		appVersion: "1.5.0",
		installationId,
		firstLaunch: true,
		firstLaunchHeardFrom: null,
		installKind: "npx",
		originKind: "local",
	},
	"the official package can enable localhost with its injected runtime contract",
);
assert.deepEqual(
	resolveAnalyticsRuntime({
		env: { PROD: true, VITE_POSTHOG_KEY: "phc_hosted" },
		origin: "http://127.0.0.1:5180",
		runtime: null,
	}),
	{ kind: "disabled", reason: "unapproved origin" },
	"a clone or preview cannot enable localhost by origin alone",
);
assert.deepEqual(
	resolveAnalyticsRuntime({
		env: { PROD: false, VITE_POSTHOG_KEY: "phc_hosted" },
		origin: "http://127.0.0.1:5180",
		runtime: {
			distribution: "npm",
			telemetryEnabled: true,
			installationId,
			appVersion: "1.5.0",
			apiKey: "phc_npm",
			apiHost: "https://t.cozyclay.org",
			firstLaunch: false,
		},
	}),
	{ kind: "disabled", reason: "not production" },
	"source development remains excluded even if a hostile page defines the global",
);
assert.deepEqual(
	resolveAnalyticsRuntime({
		env: { PROD: true },
		origin: "http://127.0.0.1:5180",
		runtime: {
			distribution: "npm",
			telemetryEnabled: false,
			installationId,
			appVersion: "1.5.0",
			apiKey: "phc_npm",
			apiHost: "https://t.cozyclay.org",
			firstLaunch: false,
		},
	}),
	{ kind: "disabled", reason: "opted out" },
);

assert.deepEqual(sanitizeProps("export:keyframe_pack", {
	entries: 6, source: "workflow", name: "private.zip", path: "/private", prompt: "secret",
}), { entries: 6, source: "workflow" }, "existing Workflow pack properties survive the export allowlist");
for (const entries of [-1, Infinity, NaN, "6", true]) {
	assert.deepEqual(sanitizeProps("export:keyframe_pack", { entries, source: "private" }), {});
}
assert.deepEqual(sanitizeProps("export:keyframe_pack", { entries: 0, source: "workflow" }), { entries: 0, source: "workflow" });

const descriptor = { export_kind: "video", format: "mp4", surface: "studio" };
function fixture(metadata = descriptor, captureOverride) {
	let clock = 100;
	const events = [];
	const attempt = analytics.startExportAttempt(metadata, {
		now: () => clock,
		capture: captureOverride ?? ((event, props) => events.push({ event, props })),
	});
	return { attempt, events, advance(ms) { clock += ms; } };
}
const success = fixture({ ...descriptor, filename: "private.mp4", prompt: "secret" });
assert.equal(success.events.length, 1);
assert.equal(success.events[0].event, "export:attempt_started");
assert.match(success.events[0].props.attempt_id, /^[a-f0-9]{32}$/);
assert.deepEqual(Object.keys(success.events[0].props).sort(), ["attempt_id", "export_kind", "format", "surface"]);
success.advance(3500);
success.attempt.succeed();
success.attempt.fail(new Error("late failure"));
success.attempt.succeed();
assert.deepEqual(success.events[1], {
	event: "export:attempt_succeeded",
	props: { ...success.events[0].props, duration_bucket: "3-10s" },
});
assert.equal(success.events.length, 2, "success suppresses all subsequent terminal calls");
assert.notEqual(fixture().events[0].props.attempt_id, success.events[0].props.attempt_id);

for (const [error, fallback, code, terminal] of [
	[Object.assign(new Error("private codec message"), { exportFailureCode: "unsupported_codec" }), "unknown", "unsupported_codec", "failed"],
	[Object.assign(new Error("private encode message"), { exportFailureCode: "encode_failed" }), "render_failed", "encode_failed", "failed"],
	[new Error("private render message"), "render_failed", "render_failed", "failed"],
	[new DOMException("private cancellation message", "AbortError"), "encode_failed", "aborted", "cancelled"],
	[{ exportFailureCode: "aborted" }, "unknown", "aborted", "cancelled"],
]) {
	const run = fixture();
	try {
		await Promise.reject(error);
	} catch (caught) {
		run.advance(1200);
		run.attempt.fail(caught, fallback);
	}
	run.attempt.fail(error);
	run.attempt.succeed();
	assert.equal(run.events.length, 2, `${code} emits exactly one terminal after async rejection`);
	assert.deepEqual(run.events[1], {
		event: `export:attempt_${terminal}`,
		props: { ...run.events[0].props, duration_bucket: "1-3s", failure_code: code },
	});
}
assert.equal(analytics.exportFailureCode(new Error("unsupported codec encode failed aborted")), "unknown", "messages never determine classification");
assert.equal(analytics.exportFailureCode({ exportFailureCode: "private" }, "private"), "unknown");
assert.equal(analytics.exportFailureCode({ name: "AbortError", exportFailureCode: "encode_failed" }), "aborted");
const hostileError = new Proxy({}, { get() { throw new Error("property failure"); } });
assert.equal(analytics.exportFailureCode(hostileError, "render_failed"), "render_failed");

const lifecycleEvents = ["started", "succeeded", "failed", "cancelled"].map((result) => `export:attempt_${result}`);
const allProps = {
	attempt_id: "a".repeat(32), ...descriptor, duration_bucket: "1-3s", failure_code: "encode_failed",
	entries: 4, source: "workflow", filename: "private", url: "https://private", path: "/private", prompt: "secret", arbitrary: 1,
};
for (const event of lifecycleEvents) {
	const expected = { attempt_id: allProps.attempt_id, ...descriptor };
	if (event !== "export:attempt_started") expected.duration_bucket = "1-3s";
	if (event.endsWith("failed") || event.endsWith("cancelled")) expected.failure_code = "encode_failed";
	assert.deepEqual(sanitizeProps(event, allProps), expected);
	for (const key of Object.keys(expected)) {
		for (const unsafe of ["private", "https://private", "private text", 7, true, null, {}]) {
			assert.equal(Object.hasOwn(sanitizeProps(event, { [key]: unsafe }), key), false, `${event} rejects unsafe ${key}`);
		}
	}
}
for (const export_kind of ["video", "depth_video", "frame", "keyframe_pack"]) {
	for (const format of ["mp4", "png", "zip"]) {
		for (const surface of ["studio", "workflow", "embed"]) {
			const props = { export_kind, format, surface };
			assert.deepEqual(sanitizeProps("export:attempt_started", props), props);
		}
	}
}
for (const code of ["unsupported_codec", "encode_failed", "render_failed", "aborted", "unknown"]) {
	assert.deepEqual(sanitizeProps("export:attempt_failed", { failure_code: code }), { failure_code: code });
}
for (const duration of ["lt1s", "1-3s", "3-10s", "10-30s", "gte30s"]) {
	assert.deepEqual(sanitizeProps("export:attempt_succeeded", { duration_bucket: duration }), { duration_bucket: duration });
}
assert.deepEqual(sanitizeProps("export:video_succeeded", { format: "mp4", ...allProps }), { format: "mp4" });
assert.deepEqual(sanitizeProps("export:blocking_frame_succeeded", { ...allProps, format: "png" }), { format: "png" });

const privacyHtml = readFileSync(new URL("../tools/dev/pages/privacy.html", import.meta.url), "utf8");
const exportDisclosure = new Map();
for (const row of privacyHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
	const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => cell[1].replace(/<[^>]*>/g, " "));
	for (const event of cells[0]?.match(/\bexport:[a-z_]+\b/g) ?? []) {
		exportDisclosure.set(event, new Set(cells[1]?.match(/\b[a-z][a-z0-9_]*\b/g) ?? []));
	}
}
assert.deepEqual([...exportDisclosure.keys()].sort(), [
	...lifecycleEvents, "export:keyframe_pack", "export:video_succeeded", "export:blocking_frame_succeeded",
].sort(), "the disclosure event tokens match the export contract");
for (const event of [...lifecycleEvents, "export:keyframe_pack"]) {
	for (const property of Object.keys(sanitizeProps(event, allProps))) {
		assert.ok(exportDisclosure.get(event).has(property), `${event} discloses schema token ${property}`);
	}
}
for (const failure_code of ["unsupported_codec", "encode_failed", "render_failed", "aborted", "unknown"]) {
	assert.ok(exportDisclosure.get("export:attempt_failed").has(failure_code), `disclosed failure enum includes ${failure_code}`);
}

for (const capture of [() => { throw new Error("transport failed"); }, async () => { throw new Error("async transport failed"); }]) {
	const run = fixture(descriptor, capture);
	assert.doesNotThrow(() => run.attempt.succeed());
	assert.doesNotThrow(() => run.attempt.fail(hostileError));
}
const clockEvents = [];
const brokenClock = analytics.startExportAttempt(descriptor, {
	now() { throw new Error("clock unavailable"); },
	capture(event, props) { clockEvents.push({ event, props }); },
});
assert.doesNotThrow(() => brokenClock.succeed());
assert.equal(clockEvents.length, 2, "clock failure does not lose pairing");
assert.equal(clockEvents[1].props.duration_bucket, "lt1s");
const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
try {
	Object.defineProperty(globalThis, "crypto", { configurable: true, get() { throw new Error("random unavailable"); } });
	const run = fixture();
	assert.doesNotThrow(() => run.attempt.succeed());
	assert.doesNotThrow(() => run.attempt.fail(new Error("export error")));
	assert.deepEqual(run.events, [], "without a secure random ID telemetry is omitted rather than affecting export");
} finally {
	Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
}
const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, "performance");
try {
	Object.defineProperty(globalThis, "performance", { configurable: true, get() { throw new Error("global clock unavailable"); } });
	const events = [];
	const attempt = analytics.startExportAttempt(descriptor, { capture(event, props) { events.push({ event, props }); } });
	assert.doesNotThrow(() => attempt.fail(new Error("render failure"), "render_failed"));
	assert.equal(events.length, 2, "a throwing global clock cannot prevent the terminal event");
	assert.equal(events[1].props.duration_bucket, "lt1s");
	assert.equal(events[1].props.failure_code, "render_failed");
} finally {
	Object.defineProperty(globalThis, "performance", performanceDescriptor);
}
try {
	Object.defineProperty(globalThis, "crypto", {
		configurable: true, value: { getRandomValues() { throw new Error("random generation failed"); } },
	});
	const run = fixture();
	assert.doesNotThrow(() => run.attempt.fail(new Error("render failure"), "render_failed"));
	assert.deepEqual(run.events, [], "a throwing random generator cannot block export error handling");
} finally {
	Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
}
// Drain rejected capture promises without timers; any unhandled rejection fails Node.
await Promise.resolve();
console.log("PASS export lifecycle pairing, async failure/cancellation, durations and duplicate suppression");
console.log("PASS export allowlists, legacy payloads and analytics failure noninterference");
console.log("PASS disclosure event/schema tokens and global clock/random failure noninterference");

// First-edit version 1 is a closed vocabulary, never a free-text payload.
const disclosedEvents = new Set([...privacyHtml.matchAll(/<td>([a-z_]+:[a-z_]+)<\/td>/g)].map((match) => match[1]));
const editKinds = ["pose_edit", "object_insert", "cutout_insert", "object_transform", "shot_add", "shot_edit", "camera_key_record", "rail_edit", "prompt_block_add", "prompt_block_edit"];
for (const event of ["craft:first_edit", "playground:first_edit"]) {
	assert.ok(disclosedEvents.has(event), `${event} has a telemetry disclosure row`);
	for (const edit_kind of editKinds) assert.deepEqual(sanitizeProps(event, { edit_kind, definition_version: 1, prompt: "private" }), { edit_kind, definition_version: 1 });
	for (const edit_kind of ["private-name", "path/to/file", 1, true, null]) assert.deepEqual(sanitizeProps(event, { edit_kind }), {});
	for (const definition_version of ["1", 2, 0, true, "private", null]) assert.deepEqual(sanitizeProps(event, { definition_version }), {});
}

const { createFirstEditTracker, createSemanticState, semanticEditKind } = await import("../src/semantic-edit.js");
const { createSceneObject, createCutoutObject, updateSceneObject } = await import("../src/scene-objects.js");
const { createSceneHistoryStore } = await import("../src/scene-history.js");
const { createCameraBlock, updateCameraBlock } = await import("../src/camera-block.js");
const { dispatchLiveFrame } = await import("../src/live-control.js");
const { addShotAtFrame, resizeShot, renameShot, moveCameraKey } = await import("../src/cuts.js");
const { createIkState, ikBakeKeyframe, ikTouch } = await import("../src/ardy/ik.js");
const { copyPhysicsKeys } = await import("../src/ardy/physics-review.js");
const { Bone } = await import("three");
const framing = { pos: { x: 0, y: 2, z: 3 }, yaw: 0, pitch: 0, fovDeg: 40 };
const shot = { id: "shot-1", name: "private shot", startFrame: 0, endFrame: 95, camera: createCameraBlock(), cameraKeys: [] };
const block = { id: "block-1", startFrame: 0, endFrame: 48, text: "private prompt" };
const actor = { id: "actor-1", x: 0, pose: { bones: { Head: [0, 0, 0] }, rootY: 0 } };
const object = createSceneObject("chair", []);
assert.ok(object);
const matrix = [
	["pose_edit", "characters", [actor], (items) => items.map((entry) => ({ ...entry, pose: { ...entry.pose, bones: { Head: [0, 20, 0] } } }))],
	["object_insert", "objects", [], (items) => [...items, object]],
	["cutout_insert", "objects", [], (items) => [...items, createCutoutObject({ assetId: "a".repeat(64), aspect: 1, height: 2 }, items)]],
	["object_transform", "objects", [object], (items) => updateSceneObject(items, object.id, { x: object.x + 1 })],
	["shot_add", "shots", [], (items) => addShotAtFrame(items, 0, 96, framing)],
	["shot_edit", "shots", [shot], (items) => resizeShot(items, shot.id, "end", 80, 96)],
	["camera_key_record", "shots", [shot], (items) => items.map((entry) => ({ ...entry, cameraKeys: [{ id: "key-1", frame: 0, framing }] }))],
	["rail_edit", "shots", [shot], (items) => items.map((entry) => ({ ...entry, camera: updateCameraBlock(entry.camera, { cameraRail: [{ x: 0, z: 0 }, { x: 2, z: 3 }], mode: "rail" }) }))],
	["prompt_block_add", "promptClips", [], () => [block]],
	["prompt_block_edit", "promptClips", [block], (items) => items.map((entry) => ({ ...entry, text: "changed private prompt" }))],
];
for (const surface of ["craft", "playground"]) {
	for (const [kind, domain, before, mutate] of matrix) {
		const events = [];
		const observe = createFirstEditTracker((event, props) => events.push({ event, props }));
		const state = createSemanticState(before, () => {}, (domain, before, after) => observe(surface, domain, before, after), domain);
		state.edit((value) => structuredClone(value));
		assert.equal(events.length, 0, `${kind}: unchanged value`);
		state.edit(mutate);
		state.edit((value) => structuredClone(value)); // repeated callback / React echo
		state.edit(mutate); // another actual edit still dedupes at the mount boundary
		assert.deepEqual(events, [{ event: `${surface}:first_edit`, props: { edit_kind: kind, definition_version: 1 } }], `${surface}: ${kind}`);
	}
}
// Passive writes still advance the before-state. A subsequent edit is measured
// against the restored document, not an initialization snapshot or old closure.
for (const excluded of ["initialization", "load", "restore", "tutorial_seed", "undo", "redo", "look_through", "orbit", "fly", "dolly", "playback", "scrub"]) {
	const events = [];
	const observe = createFirstEditTracker((...event) => events.push(event));
	const state = createSemanticState([shot], () => {}, (domain, a, b) => observe("craft", domain, a, b), "shots");
	const next = [{ ...shot, camera: updateCameraBlock(shot.camera, { followCam: { distance: 8 } }) }];
	state.set(next);
	state.edit(() => structuredClone(next));
	assert.equal(events.length, 0, excluded);
	state.edit((shots) => renameShot(shots, shot.id, "authored name"));
	assert.equal(events.length, 1, `${excluded}: subsequent edit`);
}
{
	const events = [];
	const observe = createFirstEditTracker((...event) => events.push(event));
	const state = createSemanticState([object], () => {}, (domain, a, b) => observe("craft", domain, a, b), "objects");
	state.edit((items) => updateSceneObject(items, "missing", { x: 9 }));
	state.edit((items) => updateSceneObject(items, object.id, { x: object.x }));
	assert.throws(() => state.edit(() => { throw new Error("rejected"); }), /rejected/);
	assert.equal(events.length, 0, "failed and no-op reducers cannot emit");
	// Exercise the actual MCP dispatcher through the same authored state boundary.
	const reply = await dispatchLiveFrame(JSON.stringify({ type: "cmd", id: "1", name: "update_object", args: {} }), {
		update_object: () => state.edit((items) => updateSceneObject(items, object.id, { x: object.x + 2 })),
	});
	assert.equal(reply.ok, true);
	assert.equal(events.length, 1);
	observe("playground", "objects", [], [object]);
	assert.deepEqual(events.map(([name]) => name), ["craft:first_edit", "playground:first_edit"]);
	createFirstEditTracker((...event) => events.push(event))("craft", "objects", [], [object]);
	assert.equal(events.length, 3, "a new App mount starts a new dedupe boundary");
}
// Store commits, not pointer previews or undo notifications, are authoring.
for (const commit of [false, true]) {
	const events = [];
	const observe = createFirstEditTracker((...event) => events.push(event));
	const store = createSceneHistoryStore([object], { onObjects() {}, onCommit: (a, b) => observe("craft", "objects", a, b) });
	const token = store.begin("MCP batch / pointer drag", () => {});
	store.applyIn(token, (items) => updateSceneObject(items, object.id, { x: object.x + 1 }));
	assert.equal(events.length, 0, "uncommitted preview");
	store.end(token, { commit });
	assert.equal(events.length, commit ? 1 : 0, "rollback vs commit");
	store.undo(); store.redo(); store.end(token, { commit: true });
	assert.equal(events.length, commit ? 1 : 0, "history and duplicate end callbacks");
}
{
	const events = [];
	const observe = createFirstEditTracker((...event) => events.push(event));
	// UUID churn does not turn an identical camera key or prompt into an edit.
	observe("craft", "shots", [{ ...shot, cameraKeys: [{ id: "old", frame: 0, framing }] }], [{ ...shot, cameraKeys: [{ id: "new", frame: 0, framing }] }]);
	observe("craft", "promptClips", [block], [{ ...block, id: "new-id" }]);
	observe("craft", "characters", [actor], [{ ...actor, pose: { ...actor.pose, id: "new-library-id", label: "private" } }]);
	observe("craft", "pose", { Head: [0, 0, 0] }, { Head: [0, 0, 0] });
	assert.equal(events.length, 0);
	observe("craft", "pose", { Head: [0, 0, 0] }, { Head: [0, 1, 0] });
	assert.equal(events[0][1].edit_kind, "pose_edit", "direct FK / IK mutations");
}
// A history-only session can have entries predating telemetry (restored state
// or a navigation gesture). Replaying them must not become the first edit.
for (const inFlight of [false, true]) {
	const events = [];
	const observe = createFirstEditTracker((...event) => events.push(event));
	let listening = false;
	const store = createSceneHistoryStore([object], { onObjects() {}, onCommit: (a, b) => { if (listening) observe("craft", "objects", a, b); } });
	if (inFlight) {
		const token = store.begin("drag", () => {});
		store.applyIn(token, (items) => updateSceneObject(items, object.id, { x: object.x + 1 }));
	} else store.applyAtomic((items) => updateSceneObject(items, object.id, { x: object.x + 1 }));
	listening = true;
	store.undo(); store.redo();
	assert.equal(events.length, 0, "undo/redo alone, including settling an in-flight gesture");
}
{
	const state = createIkState();
	const bone = new Bone();
	const joints = new Map([["head", { bone }]]);
	const bake = () => ikBakeKeyframe(new Map(), state, 0, joints);
	let before = copyPhysicsKeys(state.keys);
	bake();
	assert.equal(semanticEditKind("pose", before, state.keys), null, "untracked IK bake is a no-op");
	ikTouch(state, "head");
	bone.rotation.y = 0.2;
	bake();
	assert.equal(semanticEditKind("pose", before, state.keys), "pose_edit", "real bone quaternion -> IK key mutation");
	before = copyPhysicsKeys(state.keys);
	bake();
	assert.equal(semanticEditKind("pose", before, state.keys), null, "repeated IK bake / callback echo");
	const keyed = { ...shot, cameraKeys: [{ id: "key", frame: 0, framing }] };
	const retimed = { ...keyed, cameraKeys: moveCameraKey(keyed.cameraKeys, "key", 10) };
	assert.equal(semanticEditKind("shots", [keyed], [retimed]), "shot_edit", "key retiming is not a new record");
	const crane = updateCameraBlock(shot.camera, { craneHeight: { points: [{ t: 0, height: 1 }, { t: 1, height: 2 }] } });
	assert.equal(semanticEditKind("shots", [shot], [{ ...shot, camera: crane }]), "rail_edit", "crane authoring");
	assert.equal(semanticEditKind("shots", [shot], resizeShot([shot], shot.id, "end", 95, 96)), null, "clamped shot boundary is a no-op");
}
console.log("first-edit semantic matrix PASS (10 kinds x 2 surfaces; passive/no-op/history/rollback/duplicates)");

console.log("all analytics checks PASS");
