// Codex backend client (issue #124): a zero-dependency Node 20+ module that
// talks to https://chatgpt.com/backend-api/codex with a ChatGPT OAuth bearer.
//
// Facts verified against the live backend (2026-09-06):
// - POST /responses MUST send store:false, stream:true and an array `input`;
//   the backend rejects max_output_tokens, previous_response_id, background,
//   store:true and stream:false — so those keys are never sent.
// - Reasoning items may only be replayed verbatim (never fabricated).
// - The account allows ~1 concurrent request: parallel calls get 429 with
//   Retry-After 5-8s → every request is serialized and 429s sleep Retry-After.

const CODEX_BASE = "https://chatgpt.com/backend-api/codex";
const CLIENT_VERSION = "0.153.4";

function defaultSleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Normalizes missing/absent header values. */
function readHeader(headersLike, name) {
	if (!headersLike) return undefined;
	if (typeof headersLike.get === "function") {
		const value = headersLike.get(name);
		return value === null ? undefined : value;
	}
	return headersLike[name];
}

function toNumber(value) {
	if (value === undefined || value === null || value === "") return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function toFlag(value) {
	if (value === undefined) return false;
	return String(value).trim().toLowerCase() === "true";
}

/** Parses an SSE byte stream into parsed JSON events. */
async function* parseSseEvents(body) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let boundary;
		while ((boundary = buffer.indexOf("\n\n")) !== -1) {
			const frame = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			const data = frame
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).replace(/^ /, ""))
				.join("\n");
			if (!data || data === "[DONE]") continue;
			try {
				yield JSON.parse(data);
			} catch {
				// Malformed frame: skip rather than kill the stream.
			}
		}
	}
}

function messageText(item) {
	return (item.content ?? [])
		.filter((part) => part.type === "output_text")
		.map((part) => part.text)
		.join("");
}

/** Width/height from a PNG IHDR chunk: bytes 16..24, big-endian. */
function pngDimensions(base64) {
	const buffer = Buffer.from(base64, "base64");
	return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export function createCodexClient({
	getAccessToken,
	getAccountId,
	fetch = globalThis.fetch,
	originator = "cozyclay",
	sleep = defaultSleep,
}) {
	// The account allows ~1 concurrent request: chain every backend request so
	// at most one is in flight, regardless of how callers interleave calls.
	let chain = Promise.resolve();
	function enqueue(task) {
		const run = chain.then(task);
		chain = run.then(() => {}, () => {});
		return run;
	}

	async function requestHeaders(extra = {}) {
		const [accessToken, accountId] = await Promise.all([getAccessToken(), getAccountId()]);
		return {
			authorization: `Bearer ${accessToken}`,
			"chatgpt-account-id": accountId,
			originator,
			"openai-beta": "responses=experimental",
			...extra,
		};
	}

	/** POST/GET with 429 Retry-After backoff; returns the final Response. */
	async function fetchWithRetry(url, init) {
		while (true) {
			const response = await fetch(url, init);
			if (response.status === 429) {
				const retryAfter = toNumber(response.headers.get("retry-after")) ?? 5;
				await sleep(retryAfter * 1000);
				continue;
			}
			if (!response.ok) {
				const detail = await response.text();
				const error = new Error(`codex request failed (${response.status}): ${detail}`);
				error.status = response.status;
				if (response.status === 401) error.code = "unauthorized"; // bearer expired → re-login
				throw error;
			}
			return response;
		}
	}

	function postJson(path, body, signal) {
		return enqueue(async () =>
			fetchWithRetry(`${CODEX_BASE}${path}`, {
				method: "POST",
				headers: await requestHeaders({ "content-type": "application/json" }),
				body: JSON.stringify(body),
				signal,
			}));
	}

	function buildResponsesBody(request) {
		return {
			instructions: request.instructions ?? "",
			input: request.input ?? [],
			tools: request.tools ?? [],
			include: ["reasoning.encrypted_content"],
			store: false,
			stream: true,
			...(request.model ? { model: request.model } : {}),
		};
	}

	/**
	 * POST /responses and stream the parsed SSE events.
	 * Returns { headers, [Symbol.asyncIterator] } — `headers` resolves with the
	 * Response headers as soon as they are available (including quota headers).
	 */
	function streamResponses(request) {
		let resolveHeaders;
		let rejectHeaders;
		const headers = new Promise((resolve, reject) => {
			resolveHeaders = resolve;
			rejectHeaders = reject;
		});
		let started;
		const start = () => {
			if (!started) {
				started = postJson("/responses", buildResponsesBody(request), request.signal)
					.then((response) => {
						resolveHeaders(response.headers);
						return parseSseEvents(response.body);
					});
				started.catch(rejectHeaders);
			}
			return started;
		};
		return {
			headers,
			async *[Symbol.asyncIterator]() {
				yield* await start();
			},
		};
	}

	/**
	 * Runs a full agent turn: consumes `history`, executes tool calls through
	 * `executeTool`, appends the function_call item plus a function_call_output
	 * item and re-POSTs until the model produces a final assistant message.
	 * Reasoning items are replayed verbatim exactly as the backend emitted them.
	 */
	async function runAgentTurn({ history, tools = [], executeTool, onEvent, signal, instructions, model }) {
		const continued = [...history];
		let finalText = "";
		while (true) {
			const stream = streamResponses({ input: continued, tools, instructions, model, signal });
			const outputItems = [];
			for await (const event of stream) {
				if (onEvent) onEvent(event);
				if (event.type === "response.output_item.done") outputItems.push(event.item);
			}
			let calledTool = false;
			for (const item of outputItems) {
				if (item.type === "message" && item.role === "assistant") {
					finalText += messageText(item);
				}
			}
			for (const item of outputItems) {
				if (item.type === "function_call") {
					calledTool = true;
					let parsedArguments = item.arguments;
					try {
						parsedArguments = JSON.parse(item.arguments);
					} catch {
						// Non-JSON arguments: hand the raw string to the executor.
					}
					const result = await executeTool({
						call_id: item.call_id,
						name: item.name,
						arguments: parsedArguments,
					});
					continued.push(item);
					continued.push({
						type: "function_call_output",
						call_id: item.call_id,
						output: typeof result === "string" ? result : JSON.stringify(result),
					});
				} else {
					continued.push(item); // message/reasoning replayed verbatim
				}
			}
			if (!calledTool) break;
		}
		return { history: continued, finalText };
	}

	async function editImage({ prompt, imageDataUrl, quality = "auto", signal }) {
		const response = await postJson("/images/edits", {
			model: "gpt-image-2",
			prompt,
			images: [{ image_url: imageDataUrl }],
			quality,
		}, signal);
		const payload = await response.json();
		const pngBase64 = payload.data[0].b64_json;
		return { pngBase64, ...pngDimensions(pngBase64), headers: response.headers };
	}

	async function generateImage({ prompt, quality = "auto", signal }) {
		const response = await postJson("/images/generations", {
			model: "gpt-image-2",
			prompt,
			quality,
		}, signal);
		const payload = await response.json();
		const pngBase64 = payload.data[0].b64_json;
		return { pngBase64, ...pngDimensions(pngBase64), headers: response.headers };
	}

	async function listModels() {
		const response = await enqueue(async () => fetchWithRetry(`${CODEX_BASE}/models?client_version=${CLIENT_VERSION}`, {
			headers: await requestHeaders(),
		}));
		return response.json();
	}

	function parseQuotaHeaders(headersLike) {
		return {
			planType: readHeader(headersLike, "x-codex-plan-type"),
			primary: {
				usedPercent: toNumber(readHeader(headersLike, "x-codex-primary-used-percent")),
				windowMinutes: toNumber(readHeader(headersLike, "x-codex-primary-window-minutes")),
				resetAfterSeconds: toNumber(readHeader(headersLike, "x-codex-primary-reset-after-seconds")),
				resetAt: readHeader(headersLike, "x-codex-primary-reset-at"),
			},
			secondary: {
				usedPercent: toNumber(readHeader(headersLike, "x-codex-secondary-used-percent")),
				windowMinutes: toNumber(readHeader(headersLike, "x-codex-secondary-window-minutes")),
				resetAfterSeconds: toNumber(readHeader(headersLike, "x-codex-secondary-reset-after-seconds")),
				resetAt: readHeader(headersLike, "x-codex-secondary-reset-at"),
			},
			credits: {
				balance: toNumber(readHeader(headersLike, "x-codex-credits-balance")),
				hasCredits: toFlag(readHeader(headersLike, "x-codex-credits-has-credits")),
				unlimited: toFlag(readHeader(headersLike, "x-codex-credits-unlimited")),
			},
		};
	}

	return { streamResponses, runAgentTurn, editImage, generateImage, listModels, parseQuotaHeaders };
}
