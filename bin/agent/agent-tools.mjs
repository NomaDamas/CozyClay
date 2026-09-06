import { randomUUID } from "node:crypto";

const objectSchema = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
export const SYSTEM_PROMPT = "You are CozyClay's previs assistant. Use describe_scene and describe_shot to understand the scene. Capture a blocking frame before rendering; render_from_frame edits that capture. Use place_image_in_scene to add renders to the scene. Keep responses concise and practical.";

export function createAgentTools({ liveHub, handlers = [], session, emit }) {
	const registry = new Map(handlers.map((tool) => [tool.name, tool]));
	const workspace = () => {
		if (liveHub?.resolveWorkspace && session.workspaceHandle === undefined) session.workspaceHandle = liveHub.resolveWorkspace("agent turn");
		return session.workspaceHandle;
	};
	const live = (name, args = {}) => {
		if (!liveHub) throw new Error("Live editor is not connected.");
		return liveHub.command(name, args, workspace());
	};
	const registered = async (name, args = {}) => {
		const tool = registry.get(name);
		if (!tool) throw new Error(`Tool ${name} is unavailable.`);
		const result = await tool.handler(args, { workspaceHandle: workspace() });
		if (result?.isError) throw new Error("The live editor could not describe the scene.");
		return result;
	};
	const capture = {
		name: "capture_blocking_frame", description: "Capture the current blocking frame before rendering.", parameters: objectSchema(),
		handler: async () => {
			const result = await live("capture_framing_png");
			session.signal.throwIfAborted();
			const imageId = randomUUID();
			session.images.set(imageId, result.dataUrl);
			session.latestCaptureId = imageId;
			return { imageId, width: result.width, height: result.height };
		},
	};
	const render = {
		name: "render_from_frame", description: "Render an edited image from a captured frame.",
		parameters: objectSchema({ prompt: { type: "string" }, imageId: { type: "string" }, quality: { type: "string", enum: ["auto", "low", "medium", "high"] } }, ["prompt"]),
		handler: async ({ prompt, imageId, quality }) => {
			if (typeof prompt !== "string" || !prompt.trim()) throw new Error("A render prompt is required.");
			if (quality !== undefined && !["auto", "low", "medium", "high"].includes(quality)) throw new Error("Invalid image quality.");
			const source = session.images.get(imageId || session.latestCaptureId);
			if (!source) throw new Error("Capture a frame before rendering.");
			const guidance = registry.has("render_prompt") ? await registered("render_prompt", { mode: "image", environment: prompt }) : null;
			const suffix = typeof guidance === "string" ? guidance : (guidance?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
			const fullPrompt = `${prompt}${suffix ? `\n${suffix}` : ""}`;
			let result;
			try {
				session.signal.throwIfAborted();
				result = await session.codex.editImage({ prompt: fullPrompt, imageDataUrl: source, quality, signal: session.signal });
			} catch (error) {
				if (/entitlement|plan/i.test(error.message)) error.code = "entitlement";
				throw error;
			}
			session.signal.throwIfAborted();
			const newId = randomUUID();
			const dataUrl = `data:image/png;base64,${result.pngBase64}`;
			session.images.set(newId, dataUrl);
			emit({ type: "image", imageId: newId, dataUrl, width: result.width, height: result.height, prompt: fullPrompt });
			return { imageId: newId, width: result.width, height: result.height };
		},
	};
	const place = {
		name: "place_image_in_scene", description: "Place a rendered image in the scene.",
		parameters: objectSchema({ imageId: { type: "string" }, placeAs: { type: "string", enum: ["cutout", "backdrop"] } }, ["imageId"]),
		handler: async ({ imageId, placeAs = "cutout" }) => {
			const dataUrl = session.images.get(imageId);
			if (!dataUrl) throw new Error("Unknown image.");
			if (!["cutout", "backdrop"].includes(placeAs)) throw new Error("Invalid image placement.");
			return live("import_asset", { name: `${imageId}.png`, mimeType: "image/png", dataUrl, placeAs });
		},
	};
	const direct = ["describe_scene", "describe_shot"].map((name) => ({
		name, description: registry.get(name)?.description || name,
		parameters: objectSchema(), handler: () => registered(name),
	}));
	return [capture, render, place, ...direct];
}

export const agentToolSchemas = (tools) => tools.map(({ name, description, parameters }) => ({ type: "function", name, description, parameters }));
