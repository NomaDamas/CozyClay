// What the model is doing BETWEEN tool calls, as frames the agent panel shows while a turn runs: the
// reasoning summary it streams (thinking.delta, batched) and the tool call it is writing (tool.compose: the
// tool, and for run_action the action and its subject as soon as the streamed arguments name them). A long
// motion spec or script takes the model many seconds to write; without these the panel could only say
// "Thinking…". Frames only: nothing here reaches the model or the scene.
import { createSculptSketch } from "./sculpt-sketch.mjs";

const FLUSH_MS = 400;
const MIN_BATCH = 16;
const SCAN_LIMIT = 8192;
const SUBJECT_MAX = 80;

// Complete JSON strings only: a streamed fragment never names half an action.
const ACTION = /"action"\s*:\s*"([a-zA-Z0-9_.-]{1,80})"/;
const LABEL = /"(?:label|caption)"\s*:\s*"((?:[^"\\]|\\.){1,200})"/;
const SCRIPT_TITLE = /"code"\s*:\s*"\s*\/\/\s*((?:[^"\\]|\\[^n]){1,200})(?:\\n|")/;

const unescape = text => { try { return JSON.parse(`"${text}"`); } catch { return text; } };
const clip = text => { const line = unescape(text).trim(); return line.length > SUBJECT_MAX ? `${line.slice(0, SUBJECT_MAX - 1)}…` : line; };

/** The action and subject named by a tool call's raw argument JSON so far: { action?, subject? }. */
function composedCall(name, raw) {
	const action = name === "run_action" ? ACTION.exec(raw)?.[1] : undefined;
	const subject = name === "script" ? SCRIPT_TITLE.exec(raw)?.[1] : LABEL.exec(raw)?.[1];
	return { ...(action ? { action } : {}), ...(subject ? { subject: clip(subject) } : {}) };
}

/**
 * createReasoningFrames(push, clock) -> { onMessageEvent(event), flush() }
 * onMessageEvent takes pi's assistant message events (thinking_*, toolcall_*, text_*); push gets
 * { type: "thinking.delta", text } at most every FLUSH_MS, and { type: "tool.compose", index, name, action?, subject? }
 * whenever what the call being written names changes.
 */
export function createReasoningFrames(push, clock = () => Date.now(), { onScene } = {}) {
	let thinking = "", flushedAt = clock();
	const calls = new Map();
	// The sculpt, primitive and character creations written so far, as sculpt.sketch frames (sculpt-sketch.mjs).
	const sketch = createSculptSketch(push, clock, { onScene });
	const flush = () => {
		if (!thinking) return;
		push({ type: "thinking.delta", text: thinking });
		thinking = "";
		flushedAt = clock();
	};
	return {
		flush,
		settled: () => sketch.settled(),
		onMessageEvent(event) {
			sketch.onMessageEvent(event);
			if (event?.type === "thinking_delta") {
				thinking += event.delta ?? "";
				// a batch says something: not a lone word at the start of a paragraph
				if (clock() - flushedAt >= FLUSH_MS && thinking.length >= MIN_BATCH) flush();
				return;
			}
			flush();
			if (event?.type !== "toolcall_start" && event?.type !== "toolcall_delta") return;
			const call = event.partial?.content?.[event.contentIndex];
			if (call?.type !== "toolCall" || typeof call.name !== "string" || !call.name) return;
			// contentIndex restarts with every assistant message, so a start begins a new call
			const seen = event.type === "toolcall_start" ? { raw: "", key: null } : calls.get(event.contentIndex) ?? { raw: "", key: null };
			if (event.type === "toolcall_delta" && seen.raw.length < SCAN_LIMIT) seen.raw += event.delta ?? "";
			const named = composedCall(call.name, seen.raw);
			const key = `${call.name}|${named.action ?? ""}|${named.subject ?? ""}`;
			calls.set(event.contentIndex, seen);
			if (seen.key === key) return;
			seen.key = key;
			push({ type: "tool.compose", index: event.contentIndex, name: call.name, ...named });
		},
	};
}
