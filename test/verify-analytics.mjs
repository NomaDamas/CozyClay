#!/usr/bin/env node
import assert from "node:assert/strict";
import * as analytics from "../src/analytics.js";
import { createAppContext } from "../src/app-context.js";
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
	{ backend: "local_kimodo", duration_bucket: "gte30s" },
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
assert.deepEqual(sanitizeProps("motion:generate_blocked", { surface: "timeline", prompt: "private" }), {});

import { readStudioSource } from "./bus/verify-domain-modules.mjs";
const appSource = readStudioSource();
const appFunction = (name) => {
	const start = appSource.indexOf(`function ${name}(`);
	assert.notEqual(start, -1, `${name} exists`);
	return appSource.slice(start, appSource.indexOf("\n\t}\n", start) + 3);
};
for (const name of ["addPromptClip", "changePromptClip", "runLinePreview"]) {
	assert.doesNotMatch(appFunction(name), /trackGenerateBlocked|startMotionRequest|requestMotionGeneration|motion:generate_/, `${name} authors without explicit demand`);
}
assert.doesNotMatch(appSource, /trackGenerateBlocked|motion:generate_blocked/);
for (const name of ["generateMotion", "runLineEdit", "runTrailRegeneration"]) {
	assert.match(appFunction(name), /requestMotionGeneration\(/, `${name} owns explicit intent for all callers`);
}
assert.match(appFunction("executeMotionJob"), /request\.start\(\)/);
assert.match(appFunction("executeMotionJob"), /request\.succeed\(\)/);
assert.match(appFunction("executeMotionJob"), /await deliverMotion[\s\S]*?request\.apply\(\)/);
assert.match(appFunction("executeMotionJob"), /request\.fail\(/);

const motionId = "0123456789abcdef0123456789abcdef";
assert.deepEqual(sanitizeProps("motion:generate_requested", {
	surface: "timeline", input_mode: "prompt", request_id: motionId, prompt: "private", host: "user@private",
}), { surface: "timeline", input_mode: "prompt", request_id: motionId });
for (const event of ["motion:generate_requested", "motion:preflight_blocked", "motion:preflight_passed", "motion:job_started", "motion:job_succeeded", "motion:job_failed", "motion:result_applied", "motion:backend_state"]) {
	assert.deepEqual(sanitizeProps(event, { surface: "private", input_mode: true, backend: "user@private", reason: "private", error_code: "PrivateError", duration_bucket: 503, host_configured: "yes", request_id: motionId.toUpperCase() }), {}, `${event} accepts only normalized values`);
}
const remoteHealth = { ok: true, host: "private@gpu", device: "cuda:0" };
const localHealth = { ok: true, host: "local", device: "local" };
const { motionPreflightReason, motionFailureCode, startMotionRequest } = analytics;
assert.equal(typeof startMotionRequest, "function");
assert.equal(motionPreflightReason(null), "unconfigured");
assert.equal(motionPreflightReason({ ok: false, host_configured: false }), "unconfigured");
assert.equal(motionPreflightReason({ ok: false, reason: "unconfigured" }), "unconfigured", "checkBridge retains normalized server reason but drops extra fields");
assert.equal(motionPreflightReason({ ok: false, reason: "private raw failure" }), "unreachable");
assert.equal(motionPreflightReason(remoteHealth, { body: { lineEdit: {} }, lineEditSupported: false }), "unsupported_route");
assert.equal(motionPreflightReason(remoteHealth, { body: { lineEdit: {} }, lineEditSupported: true }), null);
assert.equal(motionPreflightReason(remoteHealth, { body: { replay: [{}] }, lineEditSupported: false }), "unsupported_route");
assert.equal(motionPreflightReason(localHealth, { body: { prompt: "private" } }), null, "#267 supports a local unconstrained prompt");
for (const body of [{ segments: [{}, {}] }, { posePin: true }, { waypoints: [{}] }, { motionEdit: {} }, { preserve: {} }]) {
	assert.equal(motionPreflightReason(localHealth, { body }), "unsupported_route");
}
assert.equal(motionPreflightReason(remoteHealth, { body: { motionEdit: {} } }), null);
assert.equal(motionFailureCode(new DOMException("private", "AbortError")), "aborted");
assert.equal(motionFailureCode(new Error("private")), "generation_failed");
assert.equal(motionFailureCode({ name: "private" }), "unknown");

const motionEvents = [];
let motionNow = 0;
const newMotionRequest = () => startMotionRequest({ surface: "timeline", input_mode: "prompt" }, {
	capture: (event, props) => motionEvents.push({ event, props }), now: () => motionNow,
});
for (const [health, options, reason] of [
	[null, {}, "unconfigured"],
	[{ ok: false }, {}, "unreachable"],
	[remoteHealth, { body: { lineEdit: {} } }, "unsupported_route"],
]) {
	motionEvents.length = 0;
	const request = newMotionRequest();
	request.preflight(health, options);
	request.preflight(remoteHealth);
	request.start(); request.succeed(); request.fail(new Error("private")); request.apply();
	assert.deepEqual(motionEvents.map(({ event }) => event), ["motion:generate_requested", "motion:preflight_blocked"]);
	assert.equal(motionEvents[1].props.reason, reason);
	assert.match(motionEvents[0].props.request_id, /^[a-f0-9]{32}$/);
	assert.equal(motionEvents[0].props.request_id, motionEvents[1].props.request_id);
}
motionEvents.length = 0;
const successfulMotion = newMotionRequest();
successfulMotion.apply(); successfulMotion.succeed();
successfulMotion.preflight(remoteHealth); successfulMotion.preflight(remoteHealth);
successfulMotion.start(); successfulMotion.start();
motionNow = 1500;
successfulMotion.succeed(); successfulMotion.succeed();
successfulMotion.fail(new Error("decode failed after generation"));
assert.equal(motionEvents.at(-1).event, "motion:job_succeeded", "application failure cannot rewrite job success");
successfulMotion.apply(); successfulMotion.apply();
assert.deepEqual(motionEvents.map(({ event }) => event), ["motion:generate_requested", "motion:preflight_passed", "motion:job_started", "motion:job_succeeded", "motion:result_applied"]);
assert.equal(new Set(motionEvents.map(({ props }) => props.request_id)).size, 1);
assert.equal(motionEvents[3].props.duration_bucket, "1-3s");
const priorMotionId = motionEvents[0].props.request_id;
for (const error of [new Error("private"), new DOMException("private", "AbortError")]) {
	motionEvents.length = 0;
	const request = newMotionRequest();
	request.preflight(remoteHealth); request.start(); request.fail(error); request.fail(error); request.succeed(); request.apply();
	assert.deepEqual(motionEvents.map(({ event }) => event), ["motion:generate_requested", "motion:preflight_passed", "motion:job_started", "motion:job_failed"]);
	assert.equal(motionEvents.at(-1).props.error_code, error.name === "AbortError" ? "aborted" : "generation_failed");
	assert.notEqual(motionEvents[0].props.request_id, priorMotionId);
}
for (const capture of [() => { throw new Error("transport"); }, () => Promise.reject(new Error("transport"))]) {
	const request = startMotionRequest({ surface: "trail", input_mode: "edit" }, { capture, now: () => { throw new Error("clock"); } });
	assert.doesNotThrow(() => { request.preflight(remoteHealth); request.start(); request.succeed(); request.apply(); });
}
const motionCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
try {
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues() { throw new Error("randomness unavailable"); } } });
	motionEvents.length = 0;
	const request = newMotionRequest();
	assert.doesNotThrow(() => { request.preflight(remoteHealth); request.start(); request.succeed(); request.apply(); });
	assert.deepEqual(motionEvents, [], "no weak or content-derived fallback ID");
} finally {
	Object.defineProperty(globalThis, "crypto", motionCryptoDescriptor);
}
assert.doesNotMatch(appSource, /latency_bucket/);
// Run the real queue boundary, not only the telemetry state machine: a blocked
// request must not reach generation while being absent from job counts.
for (const [health, body] of [
	[{ ok: false, reason: "unconfigured" }, {}],
	[{ ok: false }, {}],
	[localHealth, { posePin: true }],
	[remoteHealth, {}],
]) {
	const queued = [];
	const request = startMotionRequest({ surface: "timeline", input_mode: "prompt" }, { capture() {} });
	const context = {
		bridge: health, lineEditBackend: false, motionPreflightReason,
		genJobSeq: { current: 0 },
		setGenQueue(update) { queued.push(...update([])); },
		setToast() {}, isKo: false,
	};
	context.appContext = createAppContext({ notify: (...args) => context.setToast(...args) }).forRender(context);
	const enqueue = new Function(...Object.keys(context), `return ${appFunction("enqueueMotionJob")};`)(...Object.values(context));
	enqueue({ request, body, charIndex: 0 });
	assert.equal(queued.length, health === remoteHealth ? 1 : 0, "preflight refusal does not enqueue an unmeasured job");
}
// Execute the actual App job function: transport and decoded-motion delivery
// are boundaries, while its real cancellation, callback and lifecycle wiring runs.
async function boundedMotionSignal(promise) {
	let timer;
	try {
		return await Promise.race([promise, new Promise((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error("motion fixture did not settle")), 1000);
		})]);
	} finally {
		clearTimeout(timer);
	}
}
function motionJobFixture({ generate, deliver = async () => {}, capture } = {}) {
	const events = [];
	const request = startMotionRequest({ surface: "timeline", input_mode: "prompt" }, {
		capture: capture ?? ((event, props) => events.push({ event, props })), now: () => 0,
	});
	request.preflight(remoteHealth);
	const ardyAbortRef = { current: null };
	const charactersRef = { current: [{ id: "requesting-character" }] };
	const context = {
		ardyAbortRef, appContext: createAppContext({ characters: charactersRef, notify: (...args) => context.setToast(...args) }), setArdyRunning() {}, reportArdyStatus() {}, setArdyReport() {}, setArdyOutcome() {}, setReplayNotices() {},
		ko: (en) => en, isKo: false, setToast() {}, trackActivation() {}, isLineEditUnsupported: () => false,
		ardyGenerate: generate ?? (async (_body, onEvent) => {
			onEvent({ event: "done" }); onEvent({ event: "done" });
			return { motionUrl: "/ardy/motions/fixture" };
		}),
		deliverMotion: deliver, commitTakeRecipe() {},
	};
	context.appContext = context.appContext.forRender(context);
	const execute = new Function(...Object.keys(context), `return async ${appFunction("executeMotionJob")};`)(...Object.values(context));
	return { events, ardyAbortRef, charactersRef, run: () => boundedMotionSignal(execute({ request, body: {}, hasBlockEdits: false, charIndex: 0, charId: "requesting-character" })) };
}
const deliveredJob = motionJobFixture();
await deliveredJob.run();
assert.deepEqual(deliveredJob.events.map(({ event }) => event), ["motion:generate_requested", "motion:preflight_passed", "motion:job_started", "motion:job_succeeded", "motion:result_applied"]);
assert.equal(new Set(deliveredJob.events.map(({ props }) => props.request_id)).size, 1);
assert.equal(deliveredJob.ardyAbortRef.current, null);
const failedJob = motionJobFixture({ generate: async () => { throw new Error("private generation failure"); } });
await assert.rejects(failedJob.run(), /private generation failure/);
assert.equal(failedJob.events.at(-1).props.error_code, "generation_failed");
assert.equal(failedJob.events.filter(({ event }) => event === "motion:job_failed").length, 1);
const decodeFailedJob = motionJobFixture({ deliver: async () => { throw new Error("private decode failure"); } });
await assert.rejects(decodeFailedJob.run(), /private decode failure/);
assert.equal(decodeFailedJob.events.at(-1).event, "motion:job_succeeded");
const removedTarget = motionJobFixture();
removedTarget.charactersRef.current = [];
await removedTarget.run();
assert.equal(removedTarget.events.at(-1).event, "motion:job_succeeded", "delivery to a removed character is not an application");
const cancelledJob = motionJobFixture({ generate: (_body, _onEvent, { signal }) => new Promise((_resolve, reject) => {
	// Subscribed before cancellation; no sleeps or polling can make this pass.
	signal.addEventListener("abort", () => reject(signal.reason), { once: true });
}) });
const cancelledRun = cancelledJob.run();
const cancellation = assert.rejects(cancelledRun, { name: "AbortError" });
cancelledJob.ardyAbortRef.current.abort();
await cancellation;
assert.deepEqual(cancelledJob.events.map(({ event }) => event), ["motion:generate_requested", "motion:preflight_passed", "motion:job_started", "motion:job_failed"]);
assert.equal(cancelledJob.events.at(-1).props.error_code, "aborted");
// A cancellation after job success cannot manufacture a second job terminal
// or claim application when the asynchronous delivery finishes later.
const deliveryEntered = Promise.withResolvers();
const releaseDelivery = Promise.withResolvers();
const cancelledDelivery = motionJobFixture({ deliver: async () => { deliveryEntered.resolve(); await releaseDelivery.promise; } });
const deliveringRun = cancelledDelivery.run();
await boundedMotionSignal(deliveryEntered.promise);
cancelledDelivery.ardyAbortRef.current.abort();
releaseDelivery.resolve();
await deliveringRun;
assert.equal(cancelledDelivery.events.at(-1).event, "motion:job_succeeded");
for (const capture of [() => { throw new Error("transport"); }, () => Promise.reject(new Error("transport"))]) {
	await motionJobFixture({ capture }).run();
}
console.log("PASS motion request/preflight/job/application, actual App success/failure/cancel wiring and authoring exclusion");
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
		internalQa: false,
		updateStatus: null,
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
		internalQa: false,
		updateStatus: "unknown",
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
for (const export_kind of ["video", "depth_video", "frame", "keyframe_pack", "animation_project"]) {
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

// Previs events (#653): closed values only, never a caption, name or prompt.
for (const previs_mode of ["storyboard", "animation"]) assert.deepEqual(sanitizeProps("scene:created", { scene_source: "ui", previs_mode }), { scene_source: "ui", previs_mode });
assert.deepEqual(sanitizeProps("scene:created", { scene_source: "ui", previs_mode: "private mode" }), { scene_source: "ui" });
const previsContracts = {
	"storyboard:panel_created": { key: "source", good: ["agent", "manual"], bad: ["mcp", "private", true, 1, null] },
	"storyboard:panel_stylized": { key: "outcome", good: ["ok", "error"], bad: ["succeeded", "private", true, 1, null] },
	"cast:proxy_added": { key: "surface", good: ["assets", "agent", "mcp"], bad: ["studio", "private", true, 1, null] },
};
for (const [event, { key, good, bad }] of Object.entries(previsContracts)) {
	for (const value of good) assert.deepEqual(sanitizeProps(event, { [key]: value }), { [key]: value }, `${event} keeps ${key}=${value}`);
	for (const value of bad) assert.deepEqual(sanitizeProps(event, { [key]: value }), {}, `${event} rejects ${key}=${String(value)}`);
	assert.deepEqual(
		sanitizeProps(event, { [key]: good[0], caption: "A man opens the door", name: "Panel 1", prompt: "secret", text: "x", shot_id: "shot-1", character_id: "c1", count: 3 }),
		{ [key]: good[0] },
		`${event} drops captions, names, prompts and ids`,
	);
	assert.deepEqual(sanitizeProps(event, { caption: "A man opens the door" }), {}, `${event} with only a caption sends nothing`);
}
for (const export_kind of ["contact_sheet", "panel_pack", "animatic", "animation_project", "workflow_send"]) {
	assert.deepEqual(sanitizeProps("export:attempt_started", { export_kind }), { export_kind }, `export_kind ${export_kind}`);
}
assert.deepEqual(sanitizeProps("export:attempt_started", { export_kind: "panel pack" }), {});

const privacyHtml = readFileSync(new URL("../tools/dev/pages/privacy.html", import.meta.url), "utf8");
const motionDisclosure = new Map();
for (const row of privacyHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
	const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => cell[1].replace(/<[^>]*>/g, " "));
	for (const event of cells[0]?.match(/\bmotion:[a-z_]+\b/g) ?? []) {
		motionDisclosure.set(event, new Set(cells[1]?.match(/\b[a-z][a-z0-9_]*\b/g) ?? []));
	}
}
const motionSchemas = {
	"motion:backend_state": ["backend", "host_configured"],
	"motion:generate_requested": ["surface", "input_mode", "request_id"],
	"motion:preflight_blocked": ["reason", "surface", "request_id"],
	"motion:preflight_passed": ["backend", "surface", "request_id"],
	"motion:job_started": ["backend", "input_mode", "request_id"],
	"motion:job_succeeded": ["backend", "duration_bucket", "input_mode", "request_id"],
	"motion:job_failed": ["backend", "duration_bucket", "input_mode", "error_code", "request_id"],
	"motion:result_applied": ["request_id", "backend"],
};
assert.deepEqual([...motionDisclosure.keys()].sort(), Object.keys(motionSchemas).sort());
const motionProps = { backend: "local_kimodo", host_configured: true, surface: "timeline", input_mode: "prompt", reason: "unconfigured", request_id: motionId, duration_bucket: "lt1s", error_code: "aborted" };
for (const [event, properties] of Object.entries(motionSchemas)) {
	assert.deepEqual(Object.keys(sanitizeProps(event, motionProps)).sort(), [...properties].sort());
	for (const property of properties) assert.ok(motionDisclosure.get(event).has(property), `${event} discloses ${property}`);
}
for (const [event, property, values] of [
	["motion:generate_requested", "surface", ["timeline", "line_edit", "trail", "mcp"]],
	["motion:generate_requested", "input_mode", ["prompt", "pose", "edit"]],
	["motion:backend_state", "backend", ["none", "local_kimodo", "hosted"]],
	["motion:preflight_blocked", "reason", ["unconfigured", "unreachable", "unsupported_route"]],
	["motion:job_failed", "error_code", ["aborted", "unsupported_route", "generation_failed", "unknown"]],
]) {
	for (const value of values) {
		assert.deepEqual(sanitizeProps(event, { [property]: value }), { [property]: value });
		assert.ok(motionDisclosure.get(event).has(value), `${event} discloses enum ${value}`);
	}
}
console.log("PASS motion allowlists, normalized enums and disclosure schema tokens");
const shippedPrivacyHtml = readFileSync(new URL("../privacy/index.html", import.meta.url), "utf8");
assert.ok(shippedPrivacyHtml.includes(privacyHtml.split("\n---\n")[1].trimEnd()), "the shipped privacy body matches its source disclosure");
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
const { createSceneHistoryStore } = await import("../src/document-store.js");
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

// Tutorial version 1 permits only closed enums and existing elapsed buckets.
const tutorialSchemas = {
	"tutorial:started": ["surface", "tutorial_version", "start_source"],
	"tutorial:step_entered": ["surface", "tutorial_version", "step_kind"],
	"tutorial:step_completed": ["surface", "tutorial_version", "step_kind", "elapsed_bucket"],
	"tutorial:completed": ["surface", "tutorial_version", "elapsed_bucket"],
	"tutorial:dismissed": ["surface", "tutorial_version", "step_kind"],
};
const tutorialValues = {
	surface: ["studio", "playground"],
	tutorial_version: [1],
	start_source: ["query", "settings", "landing"],
	step_kind: ["fly", "walk", "dolly", "orbit", "shot", "rail", "play"],
	elapsed_bucket: ["lt1s", "1-3s", "3-10s", "10-30s", "gte30s"],
};
const tutorialPayload = {
	surface: "studio", tutorial_version: 1, start_source: "query",
	step_kind: "fly", elapsed_bucket: "1-3s",
	attempt_id: "a".repeat(32), prompt: "secret", text: "secret",
	name: "private", path: "/private", url: "https://private", file: "private",
	elapsed_ms: 1234, definition_version: 1,
};
const tutorialDisclosure = new Map();
for (const row of privacyHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
	const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)]
		.map((cell) => cell[1].replace(/<[^>]*>/g, " "));
	for (const event of cells[0]?.match(/\btutorial:[a-z_]+\b/g) ?? []) {
		tutorialDisclosure.set(event, cells[1] ?? "");
	}
}
for (const [event, keys] of Object.entries(tutorialSchemas)) {
	const expected = Object.fromEntries(keys.map((key) => [key, tutorialPayload[key]]));
	assert.deepEqual(sanitizeProps(event, tutorialPayload), expected, `${event}: exact property contract`);
	for (const key of keys) {
		for (const value of tutorialValues[key]) {
			assert.deepEqual(sanitizeProps(event, { [key]: value }), { [key]: value }, `${event}: valid ${key}`);
		}
		for (const value of ["private", "path/to/file", "private text", 0, 2, "1", true, null, {}, [], NaN, Infinity]) {
			assert.deepEqual(sanitizeProps(event, { [key]: value }), {}, `${event}: rejects unlisted ${key}`);
		}
		const disclosed = new Set(tutorialDisclosure.get(event)?.match(/[a-z0-9][a-z0-9_-]*/g) ?? []);
		assert.ok(disclosed.has(key), `${event}: discloses property token ${key}`);
		for (const value of tutorialValues[key]) {
			assert.ok(disclosed.has(String(value)), `${event}: discloses enum token ${value}`);
		}
	}
	assert.deepEqual(sanitizeProps(event, null), {});
	assert.deepEqual(sanitizeProps(event, []), {});
}
assert.deepEqual([...tutorialDisclosure.keys()].sort(), Object.keys(tutorialSchemas).sort());
assert.deepEqual(sanitizeProps("tutorial:started", { surface: "embed", start_source: "resume" }), {});
assert.deepEqual(sanitizeProps("tutorial:step_completed", { surface: "workflow", step_kind: "look" }), {});
console.log("PASS tutorial event/property/enumeration allowlists and disclosure tokens");

// Run the real init/capture/unload path with only the build environment and
// SDK transport replaced. Each module load is a fresh browser/CLI restart.
const runtimeSource = readFileSync(new URL("../src/analytics.js", import.meta.url), "utf8");
const runtimeGlobals = ["localStorage", "location", "navigator", "window", "fetch", "__COZYCLAY_RUNTIME__", "__cozyclayAnalytics", "__analyticsSdkFixture"];
const savedGlobals = runtimeGlobals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
let runtimeFixtureId = 0;
async function runtimeFixture({
	runtime = { distribution: "npm", telemetryEnabled: true, installationId, appVersion: "1.8.1", apiKey: "test", apiHost: "https://telemetry.invalid", internalQa: false, installKind: "npx" },
	origin = "http://127.0.0.1:5180", search = "", store = new Map(),
	env = { PROD: true, VITE_POSTHOG_KEY: "test", VITE_APP_VERSION: "1.8.1" },
	dnt = false, beacon = true, sync,
} = {}) {
	const records = [], beacons = [], requests = [];
	const listeners = new Map();
	let options, globals = {}, optedOut = false, distinctId;
	const sdk = {
		init(_key, config) { options = config; distinctId = config.bootstrap?.distinctID ?? `hosted-${runtimeFixtureId}`; },
		register(props) { globals = { ...globals, ...props }; },
		capture(event, props = {}) {
			if (this.has_opted_out_capturing()) return;
			const payload = options.before_send({ event, properties: { ...globals, ...props, distinct_id: distinctId } });
			if (payload) records.push(payload);
		},
		get_distinct_id() { return distinctId; },
		has_opted_out_capturing() { return optedOut || dnt; },
		opt_out_capturing() { optedOut = true; },
		opt_in_capturing() { optedOut = false; },
	};
	const values = {
		localStorage: {
			getItem: (key) => store.get(key) ?? null,
			setItem: (key, value) => store.set(key, value),
			removeItem: (key) => store.delete(key),
			key: (i) => [...store.keys()][i],
			get length() { return store.size; },
		},
		location: { origin, search, reload() {} },
		navigator: { platform: "MacIntel", doNotTrack: dnt ? "1" : "0",
			...(beacon ? { sendBeacon(url, body) { beacons.push({ url, body }); return true; } } : {}),
		},
		window: { addEventListener(name, handler) { listeners.set(name, handler); } },
		fetch: async (url, init) => {
			requests.push({ url, init });
			if (url === "/__cozyclay/telemetry") {
				if (sync) return sync(url, init);
				const telemetryEnabled = JSON.parse(init.body).enabled;
				return { ok: true, json: async () => ({ ...runtime, telemetryEnabled, installationId: telemetryEnabled ? runtime.installationId : null }) };
			}
			return { ok: false };
		},
		__COZYCLAY_RUNTIME__: runtime, __analyticsSdkFixture: sdk,
	};
	for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	const source = runtimeSource
		.replace('"./semantic-edit.js"', JSON.stringify(new URL("../src/semantic-edit.js", import.meta.url).href))
		.replace("import.meta.env", JSON.stringify(env))
		.replace('import("posthog-js")', "Promise.resolve({ default: globalThis.__analyticsSdkFixture })");
	const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${++runtimeFixtureId}`);
	await module.initAnalytics();
	await Promise.resolve(); // settle the resolved health probe, never a timing wait
	return {
		module, records, beacons, requests, store, sdk, options,
		async unload() {
			listeners.get("pagehide")?.();
			listeners.get("beforeunload")?.();
			return Promise.all(beacons.map(async ({ body }) => JSON.parse(await body.text())));
		},
	};
}
try {
	const globalKeys = ["distribution", "origin_kind", "install_kind", "app_version", "internal_qa", "os"];
	const cohortFixtures = [];
	for (const internalQa of [false, true]) {
		for (const distribution of ["npm", "hosted"]) {
			const run = await runtimeFixture({
				...(distribution === "hosted" ? { runtime: null, origin: "https://cozyclay.org", search: internalQa ? "?internal_qa=1" : "" }
					: { runtime: { distribution, telemetryEnabled: true, installationId, apiKey: "test", appVersion: "1.8.1", apiHost: "https://telemetry.invalid", installKind: "global", internalQa } }),
			});
			run.module.track("scene:loaded", { scene_source: "library", internal_qa: !internalQa, distribution: "forged", prompt: "private" });
			const [ended] = await run.unload();
			assert.equal(run.beacons.length, 1, "pagehide plus beforeunload sends exactly once");
			for (const record of run.records) {
				assert.equal(record.properties.internal_qa, internalQa, "every capture carries the declared marker, never event-supplied overrides");
				for (const key of globalKeys) assert.equal(ended.properties[key], record.properties[key], `${distribution} beacon/capture parity: ${key}`);
				assert.equal(ended.properties.distinct_id, record.properties.distinct_id);
				assert.equal(Object.hasOwn(record.properties, "prompt"), false);
			}
			assert.equal(run.options.bootstrap?.isIdentifiedID, distribution === "npm" ? false : undefined);
			cohortFixtures.push(...run.records);
		}
	}
	const external = cohortFixtures.filter((row) => row.properties.internal_qa !== true);
	assert.equal(external.some((row) => row.properties.internal_qa === true), false);
	assert.ok(external.some((row) => row.properties.origin_kind === "local"), "unmarked localhost remains external");
	assert.ok(external.some((row) => row.properties.origin_kind === "hosted"));
	const firstPort = await runtimeFixture();
	const secondPort = await runtimeFixture({ origin: "http://127.0.0.1:5250" });
	assert.equal(firstPort.records[0].properties.distinct_id, secondPort.records[0].properties.distinct_id, "fresh SDK + another port retains the CLI anonymous ID");
	assert.equal(new Set([...firstPort.records, ...secondPort.records].map((row) => row.properties.distinct_id)).size, 1, "cohorts dedupe sessions and ports by distinct ID");
	const other = await runtimeFixture({ runtime: { distribution: "npm", telemetryEnabled: true, installationId: "018f0d66-3a4b-7c2d-8e9f-abcdefabcdef", apiKey: "test" } });
	assert.notEqual(other.records[0].properties.distinct_id, firstPort.records[0].properties.distinct_id, "unrelated installations are not merged");
	const hosted = await runtimeFixture({ runtime: null, origin: "https://cozyclay.org", search: "?internal_qa=1&prompt=private" });
	assert.equal(hosted.store.get("cozyclay.internalQa"), "1");
	const hostedRestart = await runtimeFixture({ runtime: null, origin: "https://cozyclay.org", store: hosted.store });
	assert.equal(hostedRestart.records[0].properties.internal_qa, true, "explicit hosted marker persists across reloads");
	const hostedOff = await runtimeFixture({ runtime: null, origin: "https://cozyclay.org", store: hosted.store, search: "?internal_qa=0" });
	assert.equal(hostedOff.records[0].properties.internal_qa, false);
	for (const search of ["?internal_qa=private", "?internal_qa=true", "?internal_qa=1&internal_qa=0"]) {
		const run = await runtimeFixture({ runtime: null, origin: "https://cozyclay.org", search });
		assert.equal(run.records[0].properties.internal_qa, false, "only an unambiguous explicit 1/0 can set the flag");
	}
	for (const input of [
		{ env: { PROD: false, VITE_POSTHOG_KEY: "test" } },
		{ runtime: null, origin: "https://unapproved.invalid" },
		{ runtime: null, origin: "https://cozyclay.org", env: { PROD: true } },
		{ runtime: null, origin: "https://cozyclay.org", store: new Map([["cozyclay.analyticsOptOut", "1"]]) },
		{ runtime: { distribution: "npm", telemetryEnabled: false, internalQa: true, installationId, apiKey: "test" } },
		{ dnt: true },
	]) {
		const run = await runtimeFixture({ ...input, search: "?internal_qa=1" });
		run.module.track("scene:created");
		await run.unload();
		assert.deepEqual(run.records, [], "internal marking cannot enable disabled telemetry");
		assert.deepEqual(run.beacons, [], "disabled telemetry never sends an end beacon, including SDK DNT");
	}
	for (const beacon of [true, false]) {
		const run = await runtimeFixture({ beacon });
		const initialCount = run.records.length;
		assert.equal(await run.module.setAnalyticsOptOut(true), true);
		run.module.track("scene:created");
		await run.unload();
		assert.equal(run.records.length, initialCount, "opt-out suppresses later captures");
		assert.equal(run.beacons.length, 0, "opt-out suppresses the direct end beacon");
		assert.equal(run.requests.filter(({ init }) => init?.keepalive).length, 0, "opt-out suppresses fallback fetch too");
	}
	{
		let finishSync;
		const syncResponse = new Promise((resolve) => { finishSync = resolve; });
		const run = await runtimeFixture({ sync: () => syncResponse });
		const initialCount = run.records.length;
		const disabling = run.module.setAnalyticsOptOut(true);
		run.module.track("scene:created");
		await run.unload();
		assert.equal(run.records.length, initialCount, "consent revocation applies while the CLI response is pending");
		assert.equal(run.beacons.length, 0, "closing during opt-out cannot leak a last beacon");
		finishSync({ ok: true, json: async () => ({ distribution: "npm", telemetryEnabled: false, installationId: null }) });
		assert.equal(await disabling, true);
	}
	for (const internalQa of ["true", 1, "private@example.com", {}]) {
		const run = await runtimeFixture({ runtime: { distribution: "npm", telemetryEnabled: true, installationId, apiKey: "test", internalQa } });
		assert.equal(run.records[0].properties.internal_qa, false, "runtime internal marker accepts only boolean true");
	}
	for (const invalidId of [null, "private@example.com", "not-a-random-id"]) {
		const run = await runtimeFixture({ runtime: { distribution: "npm", telemetryEnabled: true, installationId: invalidId, apiKey: "test" } });
		assert.deepEqual(run.records, [], "invalid CLI identity must not leak or silently fork into a per-session ID");
	}
	const fallback = await runtimeFixture({ beacon: false });
	await fallback.unload();
	const keepalive = fallback.requests.filter(({ init }) => init?.keepalive);
	assert.equal(keepalive.length, 1);
	assert.equal(JSON.parse(keepalive[0].init.body).properties.distribution, "npm");
	console.log("PASS internal/external fixtures, restart identity, capture/beacon parity, opt-out and build policy");
} finally {
	for (const [key, descriptor] of savedGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else delete globalThis[key];
	}
}

console.log("all analytics checks PASS");

// Issue #274: execution contracts (existing analytics sections above retained).
const { startWorkflowExecution } = await import("../src/execution-telemetry.js");
const executionId = "0123456789abcdef0123456789abcdef";
assert.deepEqual(
	sanitizeProps("workflow:run_requested", {
		surface: "workflow", run_id: executionId, node_count_bucket: "1-3",
		prompt: "private", graph: "private",
	}),
	{ surface: "workflow", run_id: executionId, node_count_bucket: "1-3" },
);
assert.deepEqual(
	sanitizeProps("agent:tool_executed", {
		turn_id: executionId, tool_category: "workflow_run", outcome: "succeeded", duration_bucket: "1-3s",
		name: "private_tool", args: "private",
	}),
	{ turn_id: executionId, tool_category: "workflow_run", outcome: "succeeded", duration_bucket: "1-3s" },
);
assert.deepEqual(
	sanitizeProps("mcp:tool_executed", {
		request_id: executionId, tool_category: "motion_generate", outcome: "uncertain", duration_bucket: "gte30s",
		path: "/private",
	}),
	{ request_id: executionId, tool_category: "motion_generate", outcome: "uncertain", duration_bucket: "gte30s" },
);
assert.deepEqual(sanitizeProps("mcp:tool_executed", { request_id: executionId, tool_category: "workflow_run", outcome: "succeeded" }), { request_id: executionId, outcome: "succeeded" });
assert.deepEqual(sanitizeProps("workflow:run_failed", { run_id: executionId, duration_bucket: "1-3s", failure_code: "generation_failed" }), {
	run_id: executionId, duration_bucket: "1-3s", failure_code: "generation_failed",
});
assert.deepEqual(sanitizeProps("agent:turn_failed", { turn_id: executionId, duration_bucket: "1-3s", failure_code: "private" }), {
	turn_id: executionId, duration_bucket: "1-3s",
});
assert.deepEqual(sanitizeProps("mcp:result_applied", { request_id: executionId, prompt: "private" }), { request_id: executionId });
{
	const events = [];
	let now = 100;
	const run = startWorkflowExecution(
		{ node_count_bucket: "1-3" },
		{ capture: (event, props) => events.push({ event, props }), now: () => now, durationBucket: bucketMs },
	);
	assert.match(run.runId, /^[a-f0-9]{32}$/);
	now += 3500;
	run.succeed();
	run.fail(new Error("late failure"));
	assert.deepEqual(events.map(({ event }) => event), ["workflow:run_requested", "workflow:run_succeeded"]);
	assert.equal(events[1].props.duration_bucket, "3-10s");
}

const executionDisclosure = new Map();
for (const row of privacyHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
	const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => cell[1].replace(/<[^>]*>/g, " "));
	for (const event of cells[0]?.match(/\b(?:workflow|agent|mcp):[a-z_]+\b/g) ?? []) {
		executionDisclosure.set(event, new Set(cells[1]?.match(/\b[a-z][a-z0-9_]*\b/g) ?? []));
	}
}
const executionSchemas = {
	"workflow:run_requested": ["surface", "run_id", "node_count_bucket"],
	"workflow:run_succeeded": ["run_id", "duration_bucket"],
	"workflow:run_failed": ["run_id", "duration_bucket", "failure_code"],
	"workflow:run_cancelled": ["run_id", "duration_bucket", "failure_code"],
	"workflow:result_applied": ["run_id"],
	"agent:turn_requested": ["surface", "turn_id"],
	"agent:tool_executed": ["turn_id", "tool_category", "outcome", "duration_bucket"],
	"agent:turn_succeeded": ["turn_id", "duration_bucket"],
	"agent:turn_failed": ["turn_id", "duration_bucket", "failure_code"],
	"agent:turn_cancelled": ["turn_id", "duration_bucket", "failure_code"],
	"agent:result_applied": ["turn_id"],
	"mcp:tool_requested": ["tool_category", "request_id"],
	"mcp:tool_executed": ["tool_category", "outcome", "duration_bucket", "request_id"],
	"mcp:result_applied": ["request_id"],
};
assert.deepEqual([...executionDisclosure.keys()].sort(), Object.keys(executionSchemas).sort());
const executionProps = {
	surface: "workflow", run_id: executionId, turn_id: executionId, request_id: executionId,
	node_count_bucket: "1-3", tool_category: "other", outcome: "succeeded",
	duration_bucket: "1-3s", failure_code: "unknown",
};
for (const [event, properties] of Object.entries(executionSchemas)) {
	assert.deepEqual(Object.keys(sanitizeProps(event, executionProps)).sort(), [...properties].sort(), `${event}: exact property contract`);
	for (const property of properties) assert.ok(executionDisclosure.get(event).has(property), `${event} discloses ${property}`);
}
for (const event of Object.keys(executionSchemas)) {
	assert.deepEqual(sanitizeProps(event, { ...executionProps, prompt: "private", text: "private", path: "/private", url: "https://private" }), sanitizeProps(event, executionProps));
	for (const key of executionSchemas[event]) {
		for (const value of ["private", "private text", "https://private", "/private", 42, true, null, {}, [], Infinity, NaN]) {
			assert.deepEqual(sanitizeProps(event, { [key]: value }), {}, `${event} rejects unsafe ${key}`);
		}
	}
	for (const id of ["run_id", "turn_id", "request_id"].filter((key) => executionSchemas[event].includes(key))) {
		for (const value of [executionId.toUpperCase(), executionId.slice(1), `${executionId}0`]) {
			assert.deepEqual(sanitizeProps(event, { [id]: value }), {});
		}
	}
}
const executionEnums = [
	["workflow:run_requested", "surface", ["workflow"]],
	["agent:turn_requested", "surface", ["studio", "workflow"]],
	["workflow:run_requested", "node_count_bucket", ["0", "1-3", "4-10", "gte11"]],
	["workflow:run_failed", "failure_code", ["aborted", "capture_failed", "generation_failed", "unknown"]],
	["agent:turn_failed", "failure_code", ["aborted", "auth", "rate_limited", "tool_failed", "upstream", "unknown"]],
	["agent:tool_executed", "tool_category", ["workflow_read", "workflow_write", "workflow_run", "frame_capture", "image_generate", "scene_write", "other"]],
	["mcp:tool_executed", "tool_category", ["read", "camera", "scene_write", "prompt_authoring", "frame_capture", "motion_generate", "motion_apply", "project_io", "other"]],
	["agent:tool_executed", "outcome", ["succeeded", "failed", "cancelled"]],
	["mcp:tool_executed", "outcome", ["succeeded", "failed", "uncertain", "cancelled"]],
];
for (const [event, key, values] of executionEnums) {
	const row = [...privacyHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].find(([row]) => row.includes(event))?.[0] ?? "";
	const tokens = new Set(row.match(/[a-z0-9][a-z0-9_-]*/g) ?? []);
	for (const value of values) {
		assert.deepEqual(sanitizeProps(event, { [key]: value }), { [key]: value });
		assert.ok(tokens.has(value), `${event} discloses enum token ${value}`);
	}
}
for (const event of Object.keys(executionSchemas).filter((event) => executionSchemas[event].includes("duration_bucket"))) {
	for (const duration_bucket of ["lt1s", "1-3s", "3-10s", "10-30s", "gte30s"]) {
		assert.deepEqual(sanitizeProps(event, { duration_bucket }), { duration_bucket });
	}
}
assert.deepEqual(sanitizeProps("workflow:run_requested", { surface: "studio" }), {});
assert.deepEqual(sanitizeProps("agent:tool_executed", { outcome: "uncertain" }), {});
for (const capture of [() => { throw new Error("transport"); }, () => Promise.reject(new Error("transport"))]) {
	const run = startWorkflowExecution({ node_count_bucket: "0", prompt: "private" }, { capture, now() { throw new Error("clock"); }, durationBucket: bucketMs });
	assert.doesNotThrow(() => { run.apply(); run.succeed(); run.fail(new Error("late")); });
}
const executionCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
try {
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
	const events = [];
	const run = startWorkflowExecution({ node_count_bucket: "0" }, { capture: (...args) => events.push(args), durationBucket: bucketMs });
	run.succeed(); run.apply();
	assert.deepEqual(events, [], "missing randomness omits telemetry rather than issuing a weak ID");
} finally {
	Object.defineProperty(globalThis, "crypto", executionCrypto);
}
await Promise.resolve();
const publishedPrivacy = readFileSync(new URL("../privacy/index.html", import.meta.url), "utf8");
const executionRows = (html) => [...html.matchAll(/<tr><td>(?:workflow|agent|mcp):[\s\S]*?<\/tr>/g)].map(([row]) => row);
assert.deepEqual(executionRows(publishedPrivacy), executionRows(privacyHtml), "shipped execution disclosure equals its source");
console.log("PASS Workflow, Agent and MCP execution allowlists and disclosure schema tokens");

// Issue #466: builder telemetry. Real pose edits and per-group edit gestures,
// the Fal A->B request on the motion contract, closed error/device/use-case
// vocabularies, install source values and the npm update status.
{
	const {
		EDIT_BUCKET_KEYS, EDIT_GROUPS, FEATURE_USAGE_NAMES, HEARD_FROM_SOURCES, TEAM_VALUES, USE_CASE_VALUES,
		bucketCpu, bucketFrameRate, bucketMemory, classifyGpu, describeError, startMotionRequest,
	} = analytics;
	const rowTokens = (event) => {
		for (const row of privacyHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
			const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => cell[1].replace(/<[^>]*>/g, " "));
			if ((cells[0] ?? "").split(/[\s,]+/).includes(event)) return new Set(cells[1]?.match(/[A-Za-z0-9][A-Za-z0-9_-]*/g) ?? []);
		}
		return null;
	};
	const closedSchemas = {
		"app:error": {
			error_kind: ["error", "unhandled_rejection"],
			error_type: ["TypeError", "DOMException", "other", "non_error"],
			error_source: ["app", "extension", "external", "unknown"],
		},
		"device:profile": {
			gpu_vendor: ["nvidia", "amd", "intel", "apple", "qualcomm", "arm", "software", "other", "unknown"],
			gpu_class: ["discrete", "integrated", "software", "unknown"],
			webgl: ["webgl2", "webgl1", "none"],
			cpu_bucket: ["1-4", "5-8", "9-16", "gte17", "unknown"],
			memory_bucket: ["lt4", "4-7", "gte8", "unknown"],
			frame_rate_bucket: ["lt20", "20-40", "40-55", "gte55", "unknown"],
		},
		"survey:use_case": { use_case: USE_CASE_VALUES, team: TEAM_VALUES },
	};
	for (const [event, properties] of Object.entries(closedSchemas)) {
		const tokens = rowTokens(event);
		assert.ok(tokens, `${event} has a telemetry disclosure row`);
		for (const [property, values] of Object.entries(properties)) {
			assert.ok(tokens.has(property), `${event} discloses ${property}`);
			for (const value of values) {
				assert.deepEqual(sanitizeProps(event, { [property]: value, prompt: "private" }), { [property]: value });
				assert.ok(tokens.has(value), `${event} discloses enum ${value}`);
			}
			for (const unsafe of ["private text", "https://private", "Private-Name", 7, true, null, {}]) {
				assert.deepEqual(sanitizeProps(event, { [property]: unsafe }), {}, `${event} rejects ${String(unsafe)} as ${property}`);
			}
		}
	}
	const errorTokens = rowTokens("app:error");
	for (const key of ["error_file", "error_line", "error_col"]) assert.ok(errorTokens.has(key), `app:error discloses ${key}`);
	assert.deepEqual(
		sanitizeProps("app:error", { error_file: "index-D4x9aQ1b.js", error_line: 1, error_col: 23456 }),
		{ error_file: "index-D4x9aQ1b.js", error_line: 1, error_col: 23456 },
	);
	for (const error_file of ["/Users/me/project.js", "https://cozyclay.org/a.js", "a b.js", "notes.txt", `${"x".repeat(81)}.js`]) {
		assert.deepEqual(sanitizeProps("app:error", { error_file }), {}, `error_file rejects ${error_file}`);
	}
	for (const value of [-1, 1.5, "12", 10_000_001]) assert.deepEqual(sanitizeProps("app:error", { error_line: value, error_col: value }), {});

	const origin = "http://127.0.0.1:5180";
	const secret = "private prompt /Users/me/secret.cclayproject";
	const typeError = new TypeError(secret);
	typeError.stack = `TypeError: ${secret}\n    at pose (chrome-extension://abcdef/content.js:4:2)\n    at run (${origin}/app/assets/index-D4x9aQ1b.js:1:23456)\n    at https://cdn.example.com/lib.js:9:9`;
	const described = describeError({ error: typeError, kind: "unhandled_rejection" }, origin);
	assert.deepEqual(described, { error_kind: "unhandled_rejection", error_type: "TypeError", error_source: "app", error_file: "index-D4x9aQ1b.js", error_line: 1, error_col: 23456 });
	assert.equal(JSON.stringify(described).includes("private"), false, "never the message, stack text or paths");
	assert.deepEqual(sanitizeProps("app:error", described), described, "a described error survives its own allowlist");
	assert.deepEqual(
		describeError({ error: new RangeError(secret), filename: `${origin}/app/assets/App-9f8e7d6c.js?token=private`, lineno: 12, colno: 7 }, origin),
		{ error_kind: "error", error_type: "RangeError", error_source: "app", error_file: "App-9f8e7d6c.js", error_line: 12, error_col: 7 },
		"an ErrorEvent location in our bundle wins and loses its query string",
	);
	assert.deepEqual(describeError({ error: null, filename: "chrome-extension://abc/inject.js", lineno: 1, colno: 1 }, origin), { error_kind: "error", error_type: "non_error", error_source: "extension" });
	assert.deepEqual(describeError({ error: new Error(secret), filename: "https://cdn.example.com/lib.js", lineno: 3, colno: 4 }, origin), { error_kind: "error", error_type: "Error", error_source: "external" });
	class CustomerNamedError extends Error { constructor() { super(secret); this.name = "AcmeStudioError"; } }
	assert.equal(describeError({ error: new CustomerNamedError() }, origin).error_type, "other", "custom error names are authored text");
	assert.equal(describeError({ error: "string rejection" }, origin).error_type, "non_error");
	assert.equal(describeError({ error: Object.assign(new Error(secret), { name: "AbortError" }) }, origin).error_type, "AbortError");
	const hostile = { get name() { throw new Error("getter"); }, get stack() { throw new Error("getter"); } };
	assert.doesNotThrow(() => describeError({ error: hostile }, origin));
	console.log("PASS app:error closed vocabulary: type, source and same-origin bundle location only");

	for (const [renderer, gpu_vendor, gpu_class] of [
		["ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)", "nvidia", "discrete"],
		["ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)", "intel", "integrated"],
		["ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics (0x000056A0) Direct3D11 vs_5_0 ps_5_0, D3D11)", "intel", "discrete"],
		["ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)", "amd", "integrated"],
		["ANGLE (AMD, AMD Radeon RX 6700 XT (0x000073DF) Direct3D11 vs_5_0 ps_5_0, D3D11)", "amd", "discrete"],
		["ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)", "apple", "integrated"],
		["ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)", "software", "software"],
		["ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)", "software", "software"],
		["Adreno (TM) 740", "qualcomm", "integrated"],
		["Mali-G78", "arm", "integrated"],
		["Mozilla", "other", "unknown"],
		["", "unknown", "unknown"],
	]) assert.deepEqual(classifyGpu(renderer), { gpu_vendor, gpu_class }, renderer || "(empty renderer)");
	assert.deepEqual([0, 4, 8, 12, 32, undefined].map(bucketCpu), ["unknown", "1-4", "5-8", "9-16", "gte17", "unknown"]);
	assert.deepEqual([undefined, 2, 4, 8].map(bucketMemory), ["unknown", "lt4", "4-7", "gte8"]);
	assert.deepEqual([null, 12, 30, 50, 60, 144].map(bucketFrameRate), ["unknown", "lt20", "20-40", "40-55", "gte55", "gte55"]);
	console.log("PASS device:profile buckets and GPU vendor/class without the renderer string");

	const { FIRST_EDIT_KINDS } = await import("../src/semantic-edit.js");
	assert.deepEqual(Object.values(EDIT_GROUPS).flat().sort(), [...FIRST_EDIT_KINDS].sort(), "every semantic edit kind belongs to exactly one group");
	const fresh = await import("../src/analytics.js?issue-466-edits");
	assert.deepEqual(Object.keys(fresh.sessionEditBuckets()), [...EDIT_BUCKET_KEYS]);
	assert.ok(Object.values(fresh.sessionEditBuckets()).every((bucket) => bucket === "0"));
	let now = 0;
	for (let i = 0; i < 30; i += 1) fresh.recordSemanticEdit("pose_edit", now += 40);
	assert.equal(fresh.sessionEditBuckets().pose_edit_bucket, "1-3", "one continuous bone drag is one gesture");
	for (let i = 0; i < 11; i += 1) fresh.recordSemanticEdit("pose_edit", now += 2000);
	fresh.recordSemanticEdit("camera_key_record", now += 10);
	fresh.recordSemanticEdit("rail_edit", now += 10);
	fresh.recordSemanticEdit("object_insert", now += 10);
	fresh.recordSemanticEdit("shot_add", now += 10);
	fresh.recordSemanticEdit("prompt_block_add", now += 10);
	assert.equal(fresh.recordSemanticEdit("private-kind", now += 10), false);
	assert.deepEqual(fresh.sessionEditBuckets(), {
		pose_edit_bucket: "gte11", camera_edit_bucket: "1-3", object_edit_bucket: "1-3", shot_edit_bucket: "1-3", prompt_edit_bucket: "1-3",
	});
	const sessionTokens = rowTokens("app:session_ended");
	for (const key of EDIT_BUCKET_KEYS) assert.ok(sessionTokens.has(key), `session end discloses ${key}`);
	assert.ok(FEATURE_USAGE_NAMES.includes("pose_save"));
	for (const name of ["export_depth_video", "export_keyframe_pack"]) assert.ok(FEATURE_USAGE_NAMES.includes(name), `${name} is no longer silently dropped`);
	assert.deepEqual(sanitizeProps("feature:used", { name: "pose_save" }), { name: "pose_save" });
	for (const name of ["pose_edit", "pose_save", "fal_motion_open"]) {
		assert.ok(FEATURE_USAGE_NAMES.includes(name), `${name} is a closed feature name`);
		assert.ok(rowTokens("feature:used").has(name), `feature:used discloses ${name}`);
	}
	console.log("PASS per-group edit gestures, real pose_edit vs pose_save, and session-end disclosure");

	for (const [event, property, values] of [
		["motion:generate_requested", "surface", ["fal_card", "agent"]],
		["motion:generate_requested", "input_mode", ["a_to_b", "still"]],
		["motion:preflight_blocked", "reason", ["locked", "missing_input"]],
		["motion:preflight_passed", "backend", ["fal"]],
		["motion:job_failed", "error_code", ["quota"]],
	]) {
		const tokens = rowTokens(event);
		for (const value of values) {
			assert.deepEqual(sanitizeProps(event, { [property]: value }), { [property]: value });
			assert.ok(tokens.has(value), `${event} discloses ${value}`);
		}
	}
	const motionEvents = [];
	const capture = (event, props) => motionEvents.push([event, props]);
	const locked = startMotionRequest({ surface: "fal_card", input_mode: "a_to_b" }, { capture });
	locked.block("locked"); locked.pass("fal"); locked.start(); locked.succeed(); locked.apply();
	assert.deepEqual(motionEvents.map(([event]) => event), ["motion:generate_requested", "motion:preflight_blocked"], "a locked request ends at its refusal");
	assert.deepEqual(motionEvents[1][1], { reason: "locked", surface: "fal_card", request_id: motionEvents[0][1].request_id });
	motionEvents.length = 0;
	let clock = 0;
	const fal = startMotionRequest({ surface: "agent", input_mode: "still", prompt: "private" }, { capture, now: () => clock });
	fal.pass("fal"); fal.block("locked"); fal.start(); clock = 42_000; fal.succeed(); fal.apply(); fal.apply();
	assert.deepEqual(motionEvents.map(([event]) => event), ["motion:generate_requested", "motion:preflight_passed", "motion:job_started", "motion:job_succeeded", "motion:result_applied"]);
	assert.equal(motionEvents[1][1].backend, "fal");
	assert.equal(motionEvents[3][1].duration_bucket, "gte30s");
	assert.equal(new Set(motionEvents.map(([, props]) => props.request_id)).size, 1, "one request_id pairs the whole Fal request");
	assert.equal(JSON.stringify(motionEvents).includes("private"), false);
	motionEvents.length = 0;
	const capped = startMotionRequest({ surface: "fal_card", input_mode: "a_to_b" }, { capture });
	capped.pass("fal"); capped.start(); capped.fail(Object.assign(new Error("daily cap private"), { status: 429 }), "quota");
	assert.deepEqual(motionEvents.at(-1)[0], "motion:job_failed");
	assert.equal(motionEvents.at(-1)[1].error_code, "quota");
	assert.equal(JSON.stringify(motionEvents).includes("daily cap"), false);
	console.log("PASS Fal A->B request on the motion contract: locked, missing input, passed, quota and applied");

	const { FIRST_LAUNCH_SOURCES } = await import("../bin/telemetry-state.mjs");
	assert.deepEqual([...HEARD_FROM_SOURCES].sort(), [...FIRST_LAUNCH_SOURCES].sort(), "the CLI and the browser agree on install sources");
	for (const heard_from of ["site", "playground"]) {
		assert.deepEqual(sanitizeProps("install:first_launch", { heard_from }), { heard_from });
		assert.ok(rowTokens("install:first_launch").has(heard_from), `install source ${heard_from} is disclosed`);
	}
	assert.ok(privacyHtml.includes("update_status (latest, outdated or unknown)"), "update_status is disclosed");
	assert.equal(analytics.shouldAskUseCase(), false, "never asks while telemetry is off");
}
try {
	const npmRuntime = { distribution: "npm", telemetryEnabled: true, installationId, appVersion: "1.8.1", apiKey: "test", apiHost: "https://telemetry.invalid", internalQa: false, installKind: "npx" };
	const outdated = await runtimeFixture({ runtime: { ...npmRuntime, updateStatus: "outdated" } });
	outdated.module.track("app:error", { error_kind: "error", error_type: "TypeError", error_source: "app" });
	outdated.module.track("device:profile", { gpu_vendor: "nvidia" });
	const [ended] = await outdated.unload();
	for (const record of outdated.records) assert.equal(record.properties.update_status, "outdated", `${record.event} carries update_status`);
	assert.equal(ended.properties.update_status, "outdated", "beacon/capture parity: update_status");
	assert.equal(ended.properties.action_count_bucket, "0", "passive session signals are not user actions");
	for (const key of analytics.EDIT_BUCKET_KEYS) assert.equal(ended.properties[key], "0", `the end beacon carries ${key}`);
	const forged = await runtimeFixture({ runtime: { ...npmRuntime, updateStatus: "private" } });
	assert.equal(forged.records[0].properties.update_status, "unknown", "only a closed update status crosses");
	const hostedRun = await runtimeFixture({ runtime: null, origin: "https://cozyclay.org" });
	assert.equal(Object.hasOwn(hostedRun.records[0].properties, "update_status"), false, "hosted builds have no update status");

	const survey = await runtimeFixture();
	assert.equal(survey.module.shouldAskUseCase(), true);
	survey.module.recordUseCase("film", "team");
	assert.equal(survey.module.shouldAskUseCase(), false, "asked once per browser profile and origin");
	survey.module.recordUseCase("private text", "somebody");
	const answers = survey.records.filter((record) => record.event === "survey:use_case").map((record) => [record.properties.use_case, record.properties.team]);
	assert.deepEqual(answers, [["film", "team"], ["skip", "skip"]]);
	console.log("PASS update_status parity, passive action counts, edit buckets in the end beacon and the one-time use-case answer");
} finally {
	for (const [key, descriptor] of savedGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else delete globalThis[key];
	}
}
