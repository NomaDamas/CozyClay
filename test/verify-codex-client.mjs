#!/usr/bin/env node
// Verifies the Codex backend client (issue #124) against a mocked fetch.
// No network: every request is recorded and answered with canned SSE/JSON.
import assert from "node:assert/strict";
import { createCodexClient } from "../bin/agent/codex-client.mjs";

function pass(label) { console.log(`PASS ${label}`); }

// 1x1 transparent PNG; IHDR width/height live at byte offsets 16..24 (big-endian).
const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Builds a fetch mock that records requests and replays scripted responses. */
function mockFetch(script) {
	const calls = [];
	const queue = [...script];
	async function fakeFetch(url, init = {}) {
		const entry = {
			url,
			method: init.method ?? "GET",
			headers: init.headers ?? {},
			body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
			rawBody: init.body,
		};
		calls.push(entry);
		const next = queue.shift();
		if (!next) throw new Error(`unexpected request #${calls.length}: ${entry.method} ${url}`);
		return next(entry);
	}
	fakeFetch.calls = calls;
	return fakeFetch;
}

function sseResponse(events, headers = {}) {
	const payload = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream", ...headers },
	});
}

function jsonResponse(body, headers = {}) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json", ...headers },
	});
}

const COMPLETED = { type: "response.completed", response: {} };

const USER_ITEM = { type: "message", role: "user", content: [{ type: "input_text", text: "list the files" }] };

// --- 1. streamResponses: body shape + header set ----------------------------
{
	const fetch = mockFetch([
		() => sseResponse([
			{ type: "response.created", response: { id: "r1" } },
			COMPLETED,
		]),
	]);
	const client = createCodexClient({ getAccessToken: async () => "tok-123", getAccountId: async () => "acct-9", fetch });
	const stream = await client.streamResponses({ instructions: "be terse", input: [USER_ITEM], tools: [] });
	const events = [];
	for await (const event of stream) events.push(event);
	const responseHeaders = await stream.headers;

	assert.equal(events[0].type, "response.created");
	assert.equal(events[0].response.id, "r1");
	assert.equal(events[1].type, "response.completed");
	assert.equal(responseHeaders.get("content-type"), "text/event-stream");

	const call = fetch.calls[0];
	assert.equal(call.url, "https://chatgpt.com/backend-api/codex/responses");
	assert.equal(call.method, "POST");
	assert.equal(call.headers.authorization, "Bearer tok-123");
	assert.equal(call.headers["chatgpt-account-id"], "acct-9");
	assert.equal(call.headers.originator, "cozyclay");
	assert.equal(call.headers["openai-beta"], "responses=experimental");
	assert.equal(call.headers["content-type"], "application/json");

	assert.equal(call.body.store, false);
	assert.equal(call.body.stream, true);
	assert.ok(Array.isArray(call.body.input), "input must be an array of items");
	assert.equal(call.body.instructions, "be terse");
	assert.deepEqual(call.body.include, ["reasoning.encrypted_content"]);
	for (const forbidden of ["max_output_tokens", "previous_response_id", "background"]) {
		assert.ok(!(forbidden in call.body), `must never send ${forbidden}`);
	}
	pass("streamResponses sends codex /responses shape + headers");
}

// --- 2. SSE parsing of function_call items ----------------------------------
{
	const fetch = mockFetch([
		() => sseResponse([
			{ type: "response.created", response: {} },
			{ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc1", call_id: "call_abc", name: "list_files", arguments: "" } },
			{ type: "response.function_call_arguments.delta", item_id: "fc1", delta: "{\"path\"" },
			{ type: "response.function_call_arguments.delta", item_id: "fc1", delta: ":\"src\"}" },
			{ type: "response.function_call_arguments.done", item_id: "fc1", arguments: "{\"path\":\"src\"}" },
			{ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc1", call_id: "call_abc", name: "list_files", arguments: "{\"path\":\"src\"}" } },
			COMPLETED,
		]),
	]);
	const client = createCodexClient({ getAccessToken: async () => "t", getAccountId: async () => "a", fetch });
	const events = [];
	for await (const event of client.streamResponses({ input: [USER_ITEM] })) events.push(event);

	const done = events.find((event) => event.type === "response.output_item.done");
	assert.equal(done.item.type, "function_call");
	assert.equal(done.item.call_id, "call_abc");
	assert.equal(done.item.name, "list_files");
	assert.equal(done.item.arguments, "{\"path\":\"src\"}");
	const deltas = events.filter((event) => event.type === "response.function_call_arguments.delta");
	assert.equal(deltas.map((event) => event.delta).join(""), "{\"path\":\"src\"}");
	pass("SSE function_call events parsed with call_id/name/arguments");
}

// --- 3. runAgentTurn: tool loop appends function_call + function_call_output --
{
	const fetch = mockFetch([
		// Turn 1: model asks for a tool call.
		() => sseResponse([
			{ type: "response.created", response: {} },
			{ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs1", summary: [], encrypted_content: "ENC" } },
			{ type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc1", call_id: "call_abc", name: "list_files", arguments: "{\"path\":\"src\"}" } },
			COMPLETED,
		]),
		// Turn 2: model answers after the tool output.
		() => sseResponse([
			{ type: "response.created", response: {} },
			{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "there are 3 files" }] } },
			COMPLETED,
		]),
	]);
	const client = createCodexClient({ getAccessToken: async () => "t", getAccountId: async () => "a", fetch });

	const seenEvents = [];
	const toolCalls = [];
	const { history, finalText } = await client.runAgentTurn({
		history: [USER_ITEM],
		tools: [{ type: "function", name: "list_files", description: "list", parameters: { type: "object", properties: {} } }],
		executeTool: async (call) => {
			toolCalls.push(call);
			return ["a.mjs", "b.mjs", "c.mjs"];
		},
		onEvent: (event) => seenEvents.push(event),
	});

	assert.equal(finalText, "there are 3 files");
	assert.deepEqual(toolCalls, [{ call_id: "call_abc", name: "list_files", arguments: { path: "src" } }]);
	assert.equal(seenEvents.length > 0, true, "onEvent should see every SSE event");

	// Two POSTs: turn 1 (initial history) and turn 2 (with tool result appended).
	assert.equal(fetch.calls.length, 2);
	const firstInput = fetch.calls[0].body.input;
	assert.deepEqual(firstInput, [USER_ITEM]);

	const secondInput = fetch.calls[1].body.input;
	const callItem = secondInput.find((item) => item.type === "function_call");
	assert.ok(callItem, "re-POST must include the assistant function_call item");
	assert.equal(callItem.call_id, "call_abc");
	assert.equal(callItem.name, "list_files");
	assert.equal(callItem.arguments, "{\"path\":\"src\"}");
	const outputItem = secondInput.find((item) => item.type === "function_call_output");
	assert.ok(outputItem, "re-POST must include the function_call_output item");
	assert.equal(outputItem.call_id, "call_abc");
	assert.ok(String(outputItem.output).includes("a.mjs"));

	// Reasoning item replayed verbatim from the model output.
	const reasoning = secondInput.find((item) => item.type === "reasoning");
	assert.ok(reasoning, "reasoning item must be replayed");
	assert.equal(reasoning.encrypted_content, "ENC");
	assert.equal(reasoning.summary.length, 0);

	// Returned history is the full continued conversation.
	const historyTypes = history.map((item) => item.type);
	assert.ok(historyTypes.includes("function_call") && historyTypes.includes("function_call_output") && historyTypes.includes("message"));
	assert.equal(finalText, "there are 3 files");
	pass("runAgentTurn appends function_call + function_call_output and re-POSTs");
}

// --- 4. editImage: /images/edits body + PNG IHDR dims ------------------------
{
	const fetch = mockFetch([
		() => jsonResponse({ data: [{ b64_json: PNG_1X1_BASE64 }] }, { "x-codex-plan-type": "plus" }),
	]);
	const client = createCodexClient({ getAccessToken: async () => "t", getAccountId: async () => "a", fetch });
	const dataUrl = `data:image/png;base64,${PNG_1X1_BASE64}`;
	const result = await client.editImage({ prompt: "make it cozy", imageDataUrl: dataUrl, quality: "low" });

	const call = fetch.calls[0];
	assert.equal(call.url, "https://chatgpt.com/backend-api/codex/images/edits");
	assert.equal(call.method, "POST");
	assert.deepEqual(call.body.images, [{ image_url: dataUrl }]);
	assert.equal(call.body.model, "gpt-image-2");
	assert.equal(call.body.prompt, "make it cozy");
	assert.equal(call.body.quality, "low");
	assert.deepEqual(call.body, {
		model: "gpt-image-2",
		prompt: "make it cozy",
		images: [{ image_url: dataUrl }],
		quality: "low",
	});

	assert.equal(result.pngBase64, PNG_1X1_BASE64);
	assert.equal(result.width, 1, "dims must come from the real PNG IHDR");
	assert.equal(result.height, 1);
	assert.equal(result.headers.get("x-codex-plan-type"), "plus");
	pass("editImage body shape + IHDR dims");
}

// --- 5. generateImage: /images/generations body ------------------------------
{
	const fetch = mockFetch([
		() => jsonResponse({ data: [{ b64_json: PNG_1X1_BASE64 }] }),
	]);
	const client = createCodexClient({ getAccessToken: async () => "t", getAccountId: async () => "a", fetch });
	const result = await client.generateImage({ prompt: "a clay cat", quality: "high" });
	const call = fetch.calls[0];
	assert.equal(call.url, "https://chatgpt.com/backend-api/codex/images/generations");
	assert.deepEqual(call.body, { model: "gpt-image-2", prompt: "a clay cat", quality: "high" });
	assert.equal(result.width, 1);
	assert.equal(result.height, 1);
	pass("generateImage body shape + dims");
}

// --- 6. listModels ------------------------------------------------------------
{
	const fetch = mockFetch([
		() => jsonResponse({ data: [{ slug: "gpt-5.1-codex", input_modalities: ["text", "image"] }] }),
	]);
	const client = createCodexClient({ getAccessToken: async () => "t", getAccountId: async () => "a", fetch });
	const models = await client.listModels();
	const call = fetch.calls[0];
	assert.equal(call.url, "https://chatgpt.com/backend-api/codex/models?client_version=0.153.4");
	assert.equal(call.method, "GET");
	assert.equal(call.headers.authorization, "Bearer t");
	assert.equal(models.data[0].slug, "gpt-5.1-codex");
	pass("listModels GET with client_version");
}

// --- 7. parseQuotaHeaders ------------------------------------------------------
{
	const client = createCodexClient({ getAccessToken: async () => "t", getAccountId: async () => "a", fetch: async () => { throw new Error("no network"); } });
	const quota = client.parseQuotaHeaders({
		"x-codex-plan-type": "pro",
		"x-codex-primary-used-percent": "42.5",
		"x-codex-primary-window-minutes": "300",
		"x-codex-primary-reset-after-seconds": "1234",
		"x-codex-primary-reset-at": "2026-09-06T18:00:00Z",
		"x-codex-secondary-used-percent": "7",
		"x-codex-secondary-window-minutes": "10080",
		"x-codex-secondary-reset-after-seconds": "600000",
		"x-codex-secondary-reset-at": "2026-09-13T00:00:00Z",
		"x-codex-credits-balance": "12.5",
		"x-codex-credits-has-credits": "True",
		"x-codex-credits-unlimited": "False",
	});
	assert.equal(quota.planType, "pro");
	assert.equal(quota.primary.usedPercent, 42.5);
	assert.equal(quota.primary.windowMinutes, 300);
	assert.equal(quota.primary.resetAfterSeconds, 1234);
	assert.equal(quota.primary.resetAt, "2026-09-06T18:00:00Z");
	assert.equal(quota.secondary.usedPercent, 7);
	assert.equal(quota.secondary.windowMinutes, 10080);
	assert.equal(quota.secondary.resetAfterSeconds, 600000);
	assert.equal(quota.secondary.resetAt, "2026-09-13T00:00:00Z");
	assert.equal(quota.credits.balance, 12.5);
	assert.equal(quota.credits.hasCredits, true);
	assert.equal(quota.credits.unlimited, false);
	// Missing headers must not crash.
	const empty = client.parseQuotaHeaders({});
	assert.equal(empty.planType, undefined);
	assert.equal(empty.primary.usedPercent, undefined);
	assert.equal(empty.credits.hasCredits, false);
	pass("parseQuotaHeaders numbers/booleans");
}

// --- 8. 429 Retry-After honored (injected sleep, serialized) --------------------
{
	const sleeps = [];
	const fetch = mockFetch([
		(entry) => new Response(JSON.stringify({ detail: "rate limited" }), {
			status: 429,
			headers: { "retry-after": "6" },
		}),
		() => sseResponse([
			{ type: "response.created", response: {} },
			{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "ok" }] } },
			COMPLETED,
		]),
	]);
	const client = createCodexClient({
		getAccessToken: async () => "t",
		getAccountId: async () => "a",
		fetch,
		sleep: async (ms) => { sleeps.push(ms); },
	});
	const { finalText } = await client.runAgentTurn({ history: [USER_ITEM], tools: [], executeTool: async () => null });
	assert.equal(finalText, "ok");
	assert.deepEqual(sleeps, [6000], "must sleep Retry-After seconds after a 429");
	assert.equal(fetch.calls.length, 2);
	pass("429 Retry-After honored via injected sleep");
}

// --- 9. two overlapping calls are serialized (one in flight) ---------------------
{
	let inFlight = 0;
	let maxInFlight = 0;
	const fetch = mockFetch([
		() => sseResponse([COMPLETED]),
		() => sseResponse([COMPLETED]),
	]);
	const wrappedFetch = async (url, init) => {
		inFlight += 1;
		maxInFlight = Math.max(maxInFlight, inFlight);
		try {
			await new Promise((resolve) => setTimeout(resolve, 10));
			return await fetch(url, init);
		} finally {
			inFlight -= 1;
		}
	};
	const client = createCodexClient({ getAccessToken: async () => "t", getAccountId: async () => "a", fetch: wrappedFetch });
	const consume = async (stream) => { for await (const _ of stream); };
	await Promise.all([
		consume(client.streamResponses({ input: [USER_ITEM] })),
		consume(client.streamResponses({ input: [USER_ITEM] })),
	]);
	assert.equal(maxInFlight, 1, "codex account allows ~1 concurrent request; calls must serialize");
	pass("overlapping requests serialized");
}

console.log("PASS test/verify-codex-client.mjs");
