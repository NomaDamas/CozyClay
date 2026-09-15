import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { motionPreflightReason, startMotionRequest } from "../src/analytics.js";
import { motionReadiness } from "../src/motion-readiness.js";

const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
function appFunction(name) {
	const start = source.indexOf(`function ${name}(`);
	assert.notEqual(start, -1, `${name} exists`);
	return source.slice(start, source.indexOf("\n\t}\n", start) + 3);
}

// Invoke the real entry points while a previous request is pending, including
// the same-tick gap before React renders the queued/running state. An extra
// request must not create telemetry, mutate authoring state, or enter the queue.
for (const name of ["runAllPromptBlocks", "runArdy", "runLineEdit", "runTrailRegeneration"]) {
	for (const phase of ["pending", "running"]) {
		let requested = 0;
		const context = {
			ardyPrompt: "A person walks.",
			ardyDuration: 4,
			motion: null,
			ikFrames: [],
			ardyStartFromPose: false,
			ardyRunning: phase === "running",
			genRunningRef: { current: phase === "running" },
			generationPendingRef: { current: phase === "pending" },
			linePreviewUrl: null,
			trailEdit: {},
			takeSourceUrl: null,
			posing: false,
			activeRig: null,
			activeChar: { model: "fixture" },
			ko: (en) => en,
			setToast() {},
			requestMotionGeneration() { requested += 1; },
		};
		const run = new Function(...Object.keys(context), `return async ${appFunction(name)};`)(...Object.values(context));
		await run();
		assert.equal(requested, 0, `${name}: ${phase} request does not duplicate generation demand`);
	}
}
console.log("PASS actual Generate entry points suppress pending and running duplicate demand");

// Run both actual App boundaries. An early readiness refusal and the final
// queue preflight must still produce just one outcome for the same request.
const remote = { ok: true, backend: "local_kimodo", host_configured: true, host: "fixture", device: "cuda:0" };
const local = { ...remote, host: "local", device: "local" };
for (const [bridge, body, surface, reason] of [
	[{ ok: false, backend: "none", host_configured: false }, {}, "timeline", "unconfigured"],
	[{ ok: false, backend: "local_kimodo", host_configured: true }, {}, "timeline", "unreachable"],
	[local, { segments: [{}, {}] }, "timeline", "unsupported_route"],
	[local, { lineEdit: true }, "line_edit", "unsupported_route"],
	[local, { motionEdit: {} }, "trail", "unsupported_route"],
	[remote, {}, "timeline", null],
]) {
	const events = [];
	const queue = [];
	const context = {
		bridge, lineEditBackend: false, motionPreflightReason, motionReadiness,
		motionReadinessMessage: () => "",
		startMotionRequest: (metadata) => startMotionRequest(metadata, {
			capture: (event, props) => events.push({ event, props }),
		}),
		setToast() {}, isKo: false, genJobSeq: { current: 0 },
		setGenQueue(update) { queue.push(...update([])); },
	};
	const compile = (name) => new Function(...Object.keys(context), `return ${appFunction(name)};`)(...Object.values(context));
	const request = compile("requestMotionGeneration")(surface, surface === "timeline" ? "prompt" : "edit", body);
	compile("enqueueMotionJob")({ request, body, charIndex: 0 });
	assert.deepEqual(events.map(({ event }) => event), [
		"motion:generate_requested", reason ? "motion:preflight_blocked" : "motion:preflight_passed",
	]);
	assert.equal(new Set(events.map(({ props }) => props.request_id)).size, 1);
	assert.match(events[0].props.request_id, /^[a-f0-9]{32}$/);
	assert.equal(events[1].props.surface, surface);
	if (reason) assert.equal(events[1].props.reason, reason);
	assert.equal(queue.length, reason ? 0 : 1);
}
console.log("PASS actual UI request and queue boundaries retain exactly one requested/preflight pair");

const setupExpression = source.match(/motionSetup={<MotionSetup state={([^}]+)}/)?.[1];
assert.ok(setupExpression, "Settings renders the selected request's current readiness");
for (const bridge of [local, remote]) {
	const context = {
		motionSetupKind: "trail",
		lineEditMode: false,
		readinessState: motionReadiness(bridge),
		lineReadinessState: motionReadiness(bridge, { body: { lineEdit: true } }),
		trailReadinessState: motionReadiness(bridge, { body: { motionEdit: true } }),
	};
	const setupState = new Function(...Object.keys(context), `return ${setupExpression}`)(...Object.values(context));
	assert.equal(setupState, context.trailReadinessState, "trail setup retains its request kind across health recovery");
}
console.log("PASS trail-origin Settings keeps current trail readiness rather than prompt readiness");
