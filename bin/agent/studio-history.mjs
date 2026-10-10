// Every Studio turn opens with a full <studio-context>, and the lane re-sends
// all earlier turns on each model request. Only the newest context describes
// the editor now; older ones are stale by construction, so a request keeps the
// last one whole and sends a stub for the rest. This runs on the request copy
// (pi's transform_context hook): the stored history is never rewritten.
const OPEN = "<studio-context>", CLOSE = "</studio-context>";

const isContextPart = part => (part?.type === "text" || part?.type === "input_text") && typeof part.text === "string" && part.text.startsWith(OPEN) && part.text.includes(CLOSE);

const stubFor = text => {
	let scene;
	try { scene = JSON.parse(text.slice(OPEN.length, text.indexOf(CLOSE))).revision?.scene; } catch { /* a malformed block still stubs, without a revision */ }
	return Number.isSafeInteger(scene) ? `<studio-context revision="${scene}" omitted/>` : "<studio-context omitted/>";
};

const hasContext = message => message?.role === "user" && Array.isArray(message.content) && message.content.some(isContextPart);

/** Keep the newest turn's context and stub the older ones. Pure and idempotent. */
export function compactStudioContexts(messages) {
	if (!Array.isArray(messages)) return messages;
	const last = messages.findLastIndex(hasContext);
	if (last <= 0) return messages;
	let changed = false;
	const next = messages.map((message, index) => {
		if (index >= last || !hasContext(message)) return message;
		changed = true;
		return { ...message, content: message.content.map(part => !isContextPart(part) ? part
			: { ...part, text: stubFor(part.text) + part.text.slice(part.text.indexOf(CLOSE) + CLOSE.length) }) };
	});
	return changed ? next : messages;
}
