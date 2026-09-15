import { STUDIO_CONTEXT_MAX_BYTES, validateStudioContext, StudioProtocolError } from "./studio-agent-protocol.js";

export function encodeStudioContext(context) {
	validateStudioContext(context);
	const encoded = JSON.stringify(context).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
	if (Buffer.byteLength(encoded, "utf8") > STUDIO_CONTEXT_MAX_BYTES) throw new StudioProtocolError("CONTEXT_TOO_LARGE", "Studio context exceeds 16 KiB");
	return encoded;
}

export function buildStudioHistoryItem(context, userText) {
	if (typeof userText !== "string") throw new StudioProtocolError("INVALID_REQUEST", "user text must be a string");
	return { role: "user", content: [{ type: "input_text", text: `<studio-context>\n${encodeStudioContext(context)}\n</studio-context>` }, { type: "input_text", text: userText }] };
}

export function studioCacheKey(context, projectionKind = "scene") {
	validateStudioContext(context);
	return [context.host.workspaceId, context.host.documentEpoch, context.host.sceneEpoch, context.revision.scene, projectionKind].join(":");
}
