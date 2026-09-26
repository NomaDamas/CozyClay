#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createApiClient } from "../../tools/demo-worker/api-client.mjs";
import { processJob, runLoop } from "../../tools/demo-worker/index.mjs";
import { createGenerator } from "../../tools/demo-worker/generate.mjs";

const SECRET = "loop-test-secret";
const WORKER_ID = "loop-box";

function readBody(request) {
	return new Promise((resolvePromise, reject) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("end", () => resolvePromise(Buffer.concat(chunks)));
		request.on("error", reject);
	});
}

function json(response, status, value) {
	const body = Buffer.from(JSON.stringify(value));
	response.writeHead(status, {
		"content-type": "application/json",
		"content-length": String(body.byteLength),
	});
	response.end(body);
}

function empty(response) {
	response.writeHead(204);
	response.end();
}

async function listen(server) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return server.address().port;
}

function close(server) {
	return new Promise((resolvePromise, reject) => server.close((error) => (error ? reject(error) : resolvePromise())));
}

const state = {
	queue: [
		{ job_id: "job-loop-1", prompt: "walk", duration: 0.2, lease_token: "lease-1", lease_expires_at: Date.now() + 60_000 },
	],
	claims: [],
	heartbeats: [],
	completes: [],
	fails: [],
	mode: "normal",
	warm: null,
};

const server = createServer(async (request, response) => {
	try {
		const body = await readBody(request);
		if (!request.headers["x-cc-worker-id"] || !request.headers["x-cc-sig"]) {
			json(response, 401, { error: "missing_signature" });
			return;
		}
		if (request.url === "/worker/next" && request.method === "GET") {
			if (state.mode === "warm") {
				state.warm.nextCalls += 1;
				if (!state.warm.ready) state.warm.coldClaims += 1;
				if (state.warm.nextCalls === 1) {
					// The first empty poll simulates the runner's idle timer
					// letting its generation worker cool down.
					state.warm.ready = false;
					empty(response);
					return;
				}
				const warmJob = state.queue.shift();
				if (!warmJob) empty(response);
				else {
					state.claims.push(warmJob);
					json(response, 200, warmJob);
				}
				return;
			}
			const job = state.queue.shift();
			if (!job) empty(response);
			else {
				state.claims.push(job);
				json(response, 200, job);
			}
			return;
		}
		if (request.url === "/worker/heartbeat" && request.method === "POST") {
			state.heartbeats.push({
				jobId: request.headers["x-cc-job-id"],
				lease: request.headers["x-cc-lease"],
				body,
			});
			json(response, 200, { ok: true });
			return;
		}
		if (request.url === "/worker/fail" && request.method === "POST") {
			const jobId = request.headers["x-cc-job-id"];
			const lease = request.headers["x-cc-lease"];
			state.fails.push({ jobId, lease, reason: JSON.parse(body.toString()).reason });
			if (state.fails.length === 1) {
				state.queue.push({
					job_id: jobId,
					prompt: "walk",
					duration: 0.2,
					lease_token: "lease-2",
					lease_expires_at: Date.now() + 60_000,
				});
			}
			json(response, 200, { status: "queued" });
			return;
		}
		if (request.url === "/worker/complete" && request.method === "POST") {
			state.completes.push({
				jobId: request.headers["x-cc-job-id"],
				lease: request.headers["x-cc-lease"],
				body,
			});
			json(response, 200, { status: "done" });
			return;
		}
		json(response, 404, { error: "not_found" });
	} catch (error) {
		json(response, 500, { error: error.message });
	}
});

const port = await listen(server);
const api = createApiClient({
	baseUrl: `http://127.0.0.1:${port}`,
	secret: SECRET,
	workerId: WORKER_ID,
});
let generations = 0;
const happy = await runLoop({
	apiClient: api,
	prewarm: false,
	heartbeatIntervalMs: 1,
	pollMinMs: 1,
	pollMaxMs: 4,
	generate: async (_prompt, _duration, { signal }) => {
		generations += 1;
		if (generations === 1) throw new Error("fixture generation failed");
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 8));
		assert.equal(signal.aborted, false);
		return Buffer.from("npz-fixture");
	},
	maxJobs: 1,
	logger: { info() {}, warn() {}, error() {} },
});
assert.equal(happy.completedJobs, 1, "a retried claim eventually completes");
assert.equal(generations, 2, "the generation stub ran once per attempt");
assert.equal(state.claims.length, 2, "fail returns the job to the queue");
assert.equal(state.fails.length, 1);
assert.equal(state.completes.length, 1);
assert.ok(state.heartbeats.length >= 1, "heartbeat runs independently during generation");
assert.equal(state.completes[0].body.toString(), "npz-fixture");

const backoff = [];
const stopBackoff = new AbortController();
const emptyResult = await runLoop({
	apiClient: api,
	prewarm: false,
	pollMinMs: 2,
	pollMaxMs: 10,
	heartbeatIntervalMs: 0,
	shutdownSignal: stopBackoff.signal,
	sleep: async (ms) => {
		backoff.push(ms);
		if (backoff.length === 3) stopBackoff.abort();
	},
	generate: async () => Buffer.from("unused"),
	logger: { info() {}, warn() {}, error() {} },
});
assert.equal(emptyResult.stopped, true);
assert.deepEqual(backoff, [2, 4, 8], "204 responses use capped exponential backoff");

// A local runner's probeHealth() is not enough: the warm-worker path must be
// awaited before every claim, including after an idle period cools it down.
const runnerWarmCalls = [];
const wrappedGenerator = createGenerator({
	runner: {
		mode: "local",
		async probeHealth() {
			runnerWarmCalls.push("probeHealth");
			return { ok: true };
		},
		async singleCommand() {
			runnerWarmCalls.push("singleCommand");
			return { command: "fixture-warm-command" };
		},
	},
	workerReady: async () => {
		runnerWarmCalls.push("workerPing");
		return true;
	},
});
await wrappedGenerator.prepare();
assert.deepEqual(runnerWarmCalls, ["singleCommand", "workerPing"], "prewarm waits for a ping-confirmed worker, not probeHealth alone");
await wrappedGenerator.prepare();
assert.deepEqual(runnerWarmCalls, ["singleCommand", "workerPing", "workerPing"], "a warm check does not reset the runner idle timer on every poll");
wrappedGenerator.invalidateWarm();
await wrappedGenerator.prepare();
assert.deepEqual(
	runnerWarmCalls,
	["singleCommand", "workerPing", "workerPing", "singleCommand", "workerPing"],
	"an invalidated/cool worker is explicitly re-prepared",
);

const probeOnlyGenerator = createGenerator({
	runner: {
		async probeHealth() {
			return { ok: true, device: "fixture", encoder: "fixture" };
		},
	},
});
const probeOnlyReadiness = await probeOnlyGenerator.prepare();
assert.equal(probeOnlyReadiness.ready, false, "probe-only runners are not treated as warm");
assert.match(probeOnlyReadiness.reason, /warm_worker_unconfirmed/u, "probe-only readiness names the missing warm confirmation");

state.mode = "warm";
state.warm = { ready: false, nextCalls: 0, coldClaims: 0 };
state.queue.push({
	job_id: "job-warm",
	prompt: "warm",
	duration: 0.2,
	lease_token: "lease-warm",
	lease_expires_at: Date.now() + 60_000,
});
const warmEvents = [];
const warmRun = await runLoop({
	apiClient: api,
	generator: {
		async prepare() {
			warmEvents.push("prepare");
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
			state.warm.ready = true;
		},
		async generate() {
			warmEvents.push("generate");
			return Buffer.from("warm-npz");
		},
	},
	prewarm: true,
	heartbeatIntervalMs: 0,
	pollMinMs: 1,
	pollMaxMs: 2,
	sleep: async (ms) => {
		warmEvents.push(`sleep:${ms}`);
	},
	maxJobs: 1,
	logger: { info() {}, warn() {}, error() {} },
});
assert.equal(warmRun.completedJobs, 1, "warm-gated loop eventually completes its job");
assert.equal(state.warm.coldClaims, 0, "no claim is sent while the generation worker is cold");
assert.ok(state.warm.nextCalls >= 2, "the loop observes an empty poll before the eventual claim");
assert.ok(warmEvents.filter((event) => event === "prepare").length >= 2, "the worker is re-prepared after idle cooling");
state.mode = "normal";

const probeHoldAbort = new AbortController();
let probeHoldClaims = 0;
let probeHoldSleeps = 0;
const probeHoldLogs = [];
const probeHoldResult = await runLoop({
	apiClient: {
		next: async () => {
			probeHoldClaims += 1;
			return null;
		},
	},
	generator: {
		async prepare() {
			return { ok: false, ready: false, reason: "warm_worker_unconfirmed: probe-only fixture" };
		},
		async generate() {
			return Buffer.from("unreachable");
		},
	},
	prewarm: true,
	pollMinMs: 1,
	pollMaxMs: 2,
	shutdownSignal: probeHoldAbort.signal,
	sleep: async () => {
		probeHoldSleeps += 1;
		if (probeHoldSleeps >= 2) probeHoldAbort.abort();
	},
	logger: {
		info() {},
		warn(message) {
			probeHoldLogs.push(message);
		},
		error() {},
	},
});
assert.equal(probeHoldResult.stopped, true, "probe-only warm uncertainty waits for shutdown rather than claiming");
assert.equal(probeHoldClaims, 0, "probe-only runners never send a claim");
assert.ok(probeHoldLogs.some((message) => message.includes("warm_worker_unconfirmed")), "warm uncertainty is explicit in the log");

// A signal during generation must fail the lease before the process returns.
state.queue.push({
	job_id: "job-signal",
	prompt: "stop",
	duration: 0.2,
	lease_token: "lease-signal",
	lease_expires_at: Date.now() + 60_000,
});
// The signal must land while the job is being generated: wait for the
// generate callback itself, not a fixed delay - under a loaded runner the
// loop had not claimed the job yet when a 10 ms sleep expired (#413).
const generating = Promise.withResolvers();
const signalRun = runLoop({
	apiClient: api,
	prewarm: false,
	heartbeatIntervalMs: 0,
	installSignalHandlers: true,
	generate: async (_prompt, _duration, { signal }) => new Promise((resolvePromise, reject) => {
		signal.addEventListener("abort", () => reject(new Error("aborted by test")), { once: true });
		generating.resolve();
	}),
	logger: { info() {}, warn() {}, error() {} },
});
await generating.promise;
process.emit("SIGINT");
const signalResult = await signalRun;
assert.equal(signalResult.signal, "SIGINT");
assert.ok(state.fails.some((entry) => entry.jobId === "job-signal"), "SIGINT sends fail for the active job");

let failDeliveryAttempts = 0;
await assert.rejects(
	processJob(
		{ job_id: "job-fail-report", lease_token: "lease-fail-report", prompt: "broken", duration: 0.2 },
		{
			api: {
				heartbeat: async () => {},
				complete: async () => { throw new Error("complete should not run"); },
				fail: async () => {
					failDeliveryAttempts += 1;
					throw Object.assign(new Error("temporary API outage"), { status: 503, code: "http_503" });
				},
			},
			generator: async () => {
				throw new Error("generation fixture failed");
			},
			heartbeatIntervalMs: 0,
			logger: { info() {}, warn() {}, error() {} },
		},
	),
	(error) => error.name === "FailDeliveryError"
		&& error.code === "FAIL_DELIVERY_FAILED"
		&& error.cause?.status === 503,
	"non-lease fail-report errors are surfaced instead of being marked failed",
);
assert.equal(failDeliveryAttempts, 1, "a failed transition is not silently treated as accepted");

let failingLoopClaims = 0;
await assert.rejects(
	runLoop({
		apiClient: {
			next: async () => {
				failingLoopClaims += 1;
				return { job_id: "job-loop-fail-report", lease_token: "lease-loop-fail-report", prompt: "broken", duration: 0.2 };
			},
			heartbeat: async () => {},
			complete: async () => {},
			fail: async () => {
				throw Object.assign(new Error("API unavailable"), { status: 503, code: "http_503" });
			},
		},
		prewarm: false,
		heartbeatIntervalMs: 0,
		generate: async () => { throw new Error("generation failed"); },
		logger: { info() {}, warn() {}, error() {} },
	}),
	(error) => error.code === "FAIL_DELIVERY_FAILED",
	"the poll loop exposes a failed transition so its service supervisor can retry",
);
assert.equal(failingLoopClaims, 1, "the loop does not claim another job after fail delivery is unknown");

const leaseLostResult = await processJob(
	{ job_id: "job-lease-lost", lease_token: "lease-lost", prompt: "gone", duration: 0.2 },
	{
		api: {
			heartbeat: async () => {},
			complete: async () => {},
			fail: async () => {
				throw Object.assign(new Error("lease already reclaimed"), { status: 409, code: "lease_lost" });
			},
		},
		generator: async () => {
			throw new Error("late generation");
		},
		heartbeatIntervalMs: 0,
		logger: { info() {}, warn() {}, error() {} },
	},
);
assert.equal(leaseLostResult.status, "lease_lost", "only an explicit lease loss is quietly ignored");

await close(server);
console.log("demo worker loop checks PASS");

