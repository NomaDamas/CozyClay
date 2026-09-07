import { randomUUID } from "node:crypto";

const objectSchema = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
export const SYSTEM_PROMPT = "You are CozyClay's workflow agent. The user is looking at the Workflow canvas, and you work by building and running nodes on that canvas, so every step is visible and editable. Always call describe_workflow first to read the current graph. To render the scene in a new look: reuse the existing Scene node, add an Image node with model image-generation whose data.prompt is the user's intent, connect the Scene node to it with connect_workflow_nodes (sourceHandle render, targetHandle input), and when the user attached or mentioned a reference image, add one with add_reference_node and connect it to the same Image node's input handle; then call run_workflow. Finish with one or two sentences naming the nodes you created. Never describe results you did not run. Keep responses concise and practical.";

/** The Workflow page embeds the Studio as a live preview, so the hub usually
 * sees at least two editors. Prefer the tab the user is authoring in: any
 * workspace whose hello meta does not say embed:true. Fall back to the hub's
 * own single-workspace rule (which throws when the choice is ambiguous). */
export function pickWorkspace(liveHub, requiredCommands = ["capture_framing_png", "import_asset"], kind = "scene") {
	const details = typeof liveHub.workspaceHandleDetails === "function" ? liveHub.workspaceHandleDetails() : [];
	if (kind === "workflow") {
		const workflow = details.filter((entry) => entry.meta?.kind === "workflow").map((entry) => entry.handle);
		if (workflow.length) return workflow[workflow.length - 1];
		throw new Error("No workflow canvas workspace is connected.");
	}
	// An editor that does not advertise its commands predates the agent work;
	// it cannot answer capture_framing_png, so it is never a candidate.
	const supports = (entry) => Array.isArray(entry.meta?.commands) && requiredCommands.every((name) => entry.meta.commands.includes(name));
	const authoring = details.filter((entry) => entry.meta?.embed !== true && supports(entry)).map((entry) => entry.handle);
	if (authoring.length === 1) return authoring[0];
	if (authoring.length > 1) return authoring[authoring.length - 1];
	// On the Workflow page the embedded Studio IS the scene the user is looking
	// at; use it when no standalone editor tab is open.
	const embedded = details.filter((entry) => entry.meta?.embed === true && supports(entry)).map((entry) => entry.handle);
	if (embedded.length) return embedded[embedded.length - 1];
	return liveHub.resolveWorkspace("agent turn");
}

export function createAgentTools({ liveHub, handlers = [], session, emit }) {
	const registry = new Map(handlers.map((tool) => [tool.name, tool]));
	const workspace = (kind = "scene") => {
		const key = kind === "workflow" ? "workflowHandle" : "workspaceHandle";
		if (liveHub?.resolveWorkspace && session[key] === undefined) session[key] = pickWorkspace(liveHub, kind === "workflow" ? [] : undefined, kind);
		return session[key];
	};
	const live = (name, args = {}, kind = "scene") => {
		if (!liveHub) throw new Error("Live editor is not connected.");
		return liveHub.command(name, args, workspace(kind));
	};
	const registered = async (name, args = {}) => {
		const tool = registry.get(name);
		if (!tool) throw new Error(`Tool ${name} is unavailable.`);
		const result = await tool.handler(args, { workspaceHandle: workspace("scene") });
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
		parameters: objectSchema({ prompt: { type: "string" }, imageId: { type: "string" }, quality: { type: "string", enum: ["auto", "low", "medium", "high"] }, addAsNode: { type: "boolean" } }, ["prompt"]),
		handler: async ({ prompt, imageId, quality, addAsNode = false }) => {
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
			if (addAsNode) await live("add_node", { type: "image", model: "image-passthrough", data: { image_url: dataUrl, outputs: [{ value: dataUrl }] } }, "workflow");
			return { imageId: newId, width: result.width, height: result.height, ...(addAsNode ? { addedAsNode: true } : {}) };
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
	const reference = {
		name: "add_reference_node", description: "Add an attached or captured image to the canvas as a reference upload node.",
		parameters: objectSchema({ imageId: { type: "string" } }),
		handler: async ({ imageId } = {}) => {
			const dataUrl = session.images.get(imageId ?? session.latestCaptureId);
			if (!dataUrl) throw new Error("No reference image is available. Capture or attach one first.");
			return live("add_node", { type: "upload", data: { image_url: dataUrl, fileName: "reference.png", mimeType: "image/png", outputs: [{ value: dataUrl }] } }, "workflow");
		},
	};
	const workflow = [
		["describe_workflow", "Describe the current workflow canvas.", "get_graph", objectSchema()],
		["add_workflow_node", "Add a node to the workflow canvas.", "add_node", objectSchema({ type: { type: "string" }, model: { type: "string" }, data: { type: "object" }, position: { type: "object" } }, ["type"])],
		["update_workflow_node", "Update a workflow node.", "update_node", objectSchema({ id: { type: "string" }, data: { type: "object" } }, ["id", "data"])],
		["remove_workflow_node", "Remove a workflow node.", "remove_node", objectSchema({ id: { type: "string" } }, ["id"])],
		["connect_workflow_nodes", "Connect two workflow nodes.", "connect", objectSchema({ source: { type: "string" }, target: { type: "string" }, sourceHandle: { type: "string" }, targetHandle: { type: "string" } }, ["source", "target"])],
		["disconnect_workflow_nodes", "Disconnect workflow nodes.", "disconnect", objectSchema({ edgeId: { type: "string" } }, ["edgeId"])],
		["run_workflow", "Run the workflow locally.", "run_workflow", objectSchema()],
		["set_workflow_node_output", "Set a workflow node output.", "set_node_output", objectSchema({ id: { type: "string" }, value: {} }, ["id", "value"])],
		["focus_workflow_node", "Focus a workflow node.", "focus_node", objectSchema({ id: { type: "string" } }, ["id"])],
	].map(([name, description, command, parameters]) => ({ name, description, parameters, handler: (args) => live(command, args, "workflow") }));
	const direct = ["describe_scene", "describe_shot"].map((name) => ({
		name, description: registry.get(name)?.description || name,
		parameters: objectSchema(), handler: () => registered(name),
	}));
	const tools = [reference, ...workflow, ...direct];
	// The sidecar captures the frame itself when the user attaches it; the
	// model never sees this tool, it builds an Image node instead.
	tools.internal = { capture };
	return tools;
}

export const agentToolSchemas = (tools) => tools.map(({ name, description, parameters }) => ({ type: "function", name, description, parameters }));
