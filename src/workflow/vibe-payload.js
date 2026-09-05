import { normalizeWorkflowGraph } from "../project.js";

/**
 * Convert CozyClay's local graph envelope to the payload shape expected by
 * Vibe-Workflow/MuAPI. Custom CozyClay Scene nodes stay local and are omitted
 * from the remote graph; their inputs are retained in the local project file.
 */
export function toVibeWorkflowPayload(graph, { name = "CozyClay Workflow", workflowId = null, sourceWorkflowId = null } = {}) {
	const normalized = normalizeWorkflowGraph(graph);
	const remoteNodes = normalized.nodes.filter((node) => node.type !== "scene");
	const remoteIds = new Set(remoteNodes.map((node) => node.id));
	const edges = normalized.edges.filter((edge) => remoteIds.has(edge.source) && remoteIds.has(edge.target));
	const nodeData = remoteNodes.map((node) => toVibeNode(node, edges));
	return {
		workflow_id: workflowId,
		source_workflow_id: sourceWorkflowId,
		name,
		edges,
		data: { nodes: nodeData },
		is_vadoo: false,
		category: "custom",
	};
}

function categoryFor(type) {
	return ({ text: "text", image: "image", video: "video", audio: "audio", api: "api", concat: "utility", "video-combiner": "utility", vidConcat: "utility" })[type] || "utility";
}

function uploadCategory(node) {
	const mimeType = String(node.data?.mimeType || "").toLowerCase();
	if (mimeType.startsWith("audio/")) return "audio";
	if (mimeType.startsWith("video/")) return "video";
	const filename = String(node.data?.fileName || "").toLowerCase();
	if (/\.(mp3|wav|m4a|ogg|aac|flac)$/.test(filename)) return "audio";
	return /\.(mp4|mov|webm|m4v|avi)$/.test(filename) ? "video" : "image";
}

function modelFor(node, category) {
	const data = node.data || {};
	if (node.type === "upload") return `${uploadCategory(node)}-passthrough`;
	if (typeof data.selectedModel?.id === "string" && data.selectedModel.id) return data.selectedModel.id;
	if (typeof data.model === "string" && data.model) return data.model;
	if (node.type === "concat") return "prompt-concatenator";
	if (node.type === "video-combiner" || node.type === "vidConcat") return "video-combiner";
	return `${category}-passthrough`;
}

function formValuesFor(node) {
	const data = node.data || {};
	const values = data.formValues && typeof data.formValues === "object" ? { ...data.formValues } : {};
	for (const key of ["prompt", "image_url", "video_url", "audio_url", "duration", "template", "aspect_ratio", "videos_list", "fileUrl", "fileName", "mimeType", "params"]) {
		if (data[key] !== undefined && values[key] === undefined) values[key] = data[key];
	}
	if (typeof values.params === "string") {
		try { values.params = JSON.parse(values.params); } catch { values.params = {}; }
	}
	if (values.fileUrl && values.image_url === undefined && values.video_url === undefined && values.audio_url === undefined) {
		values[uploadCategory(node) === "video" ? "video_url" : "image_url"] = values.fileUrl;
	}
	return values;
}

function reference(edge) {
	return `{{ ${edge.source}.outputs[0].value }}`;
}

function paramsFor(node, edges, formValues) {
	const incoming = edges.filter((edge) => edge.target === node.id);
	const params = { ...formValues };
	const refs = incoming.map(reference);
	if (refs.length) {
		if (node.type === "concat") params.prompt = refs;
		else if (node.type === "image") params.image_url = refs[0];
		else if (node.type === "video") params.video_url = refs[0];
		else if (node.type === "audio") params.audio_url = refs[0];
		else if (node.type === "api") params.input = refs[0];
		else if (node.type === "video-combiner" || node.type === "vidConcat") params.videos_list = refs;
		else params.prompt = refs[0];
	}
	return params;
}

function toVibeNode(node, edges) {
	const category = node.type === "upload" ? uploadCategory(node) : categoryFor(node.type);
	const input_params = formValuesFor(node);
	const params = paramsFor(node, edges, input_params);
	const incoming = edges.filter((edge) => edge.target === node.id);
	const output_params = {
		resultUrl: node.data?.resultUrl || null,
		outputs: Array.isArray(node.data?.outputs) ? node.data.outputs : [],
	};
	return {
		id: node.id,
		category,
		model: modelFor(node, category),
		input_params,
		output_params,
		params,
		position: node.position,
		...(incoming.length ? { inputs: incoming.map((edge) => edge.source) } : {}),
	};
}

export function remoteWorkflowNodeCount(graph) {
	return normalizeWorkflowGraph(graph).nodes.filter((node) => node.type !== "scene").length;
}

/** Collapse MuAPI's per-node run arrays into the status used by the canvas. */
export function summarizeVibeRunStatus(payload) {
	const direct = typeof payload?.status === "string" ? payload.status.toLowerCase() : "";
	const success = new Set(["succeeded", "success", "completed", "complete"]);
	const failure = new Set(["failed", "failure", "error", "cancelled", "canceled"]);
	if (success.has(direct)) return { terminal: true, ok: true, status: "complete" };
	if (failure.has(direct)) return { terminal: true, ok: false, status: "error" };
	const runs = Object.values(payload?.nodes || {}).flatMap((value) => Array.isArray(value) ? value : [value]).filter(Boolean);
	const statuses = runs.map((run) => String(run?.status || "").toLowerCase()).filter(Boolean);
	if (statuses.some((status) => failure.has(status))) return { terminal: true, ok: false, status: "error" };
	if (statuses.length > 0 && statuses.every((status) => success.has(status))) return { terminal: true, ok: true, status: "complete" };
	return { terminal: false, ok: false, status: "running" };
}
