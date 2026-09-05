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

/**
 * MuAPI charges the sum of the node generation costs when a workflow run is
 * started. Vibe keeps that value on each node (and sends the aggregate in the
 * run request), so preserve the same contract for the CozyClay adapter.
 */
export function workflowCost(graph) {
	return normalizeWorkflowGraph(graph).nodes.reduce((total, node) => {
		const cost = Number(node.data?.cost);
		return Number.isFinite(cost) && cost > 0 ? total + cost : total;
	}, 0);
}

/** Build the body used by Vibe's per-node run endpoint. */
export function toVibeNodeRunRequest(graph, nodeId, runId) {
	const normalized = normalizeWorkflowGraph(graph);
	const localNode = normalized.nodes.find((node) => node.id === nodeId);
	const remoteNode = toVibeWorkflowPayload(normalized).data.nodes.find((node) => node.id === nodeId);
	if (!localNode || !remoteNode || !runId) return null;
	return {
		run_id: runId,
		model: remoteNode.model,
		params: remoteNode.params,
		cost: Number.isFinite(Number(localNode.data?.cost)) ? Number(localNode.data.cost) : 0,
		node_id: nodeId,
	};
}

export function remoteWorkflowNodeCount(graph) {
	return normalizeWorkflowGraph(graph).nodes.filter((node) => node.type !== "scene").length;
}

function latestNodeRun(runs) {
	if (Array.isArray(runs)) return runs.at(-1) || null;
	return runs && typeof runs === "object" ? runs : null;
}

/**
 * Normalize MuAPI's run status map (`nodes[id] = run[]`) into updates that can
 * be merged into ReactFlow node data. Keeping the complete latest run in
 * outputHistory is what lets Vibe's previous/next output controls survive a
 * refresh or a second run.
 */
export function extractVibeRunUpdates(payload) {
	const nodeRuns = payload?.nodes || payload?.runData?.nodes || payload?.data?.nodes || {};
	if (!nodeRuns || typeof nodeRuns !== "object" || Array.isArray(nodeRuns)) return {};
	const updates = {};
	for (const [id, runs] of Object.entries(nodeRuns)) {
		const latest = latestNodeRun(runs);
		if (!latest) continue;
		const result = latest.result || latest.output || null;
		const outputs = Array.isArray(result?.outputs) ? result.outputs : [];
		const first = outputs[0]?.value ?? null;
		const status = String(latest.status || "").toLowerCase();
		const currentHistory = Array.isArray(latest.outputHistory) ? latest.outputHistory : [];
		const runKey = latest.id || latest.run_id || result?.id || latest.started_at || null;
		const update = {
			status,
			isLoading: ["processing", "running", "queued", "pending"].includes(status),
			errorMsg: ["failed", "failure", "error", "cancelled", "canceled"].includes(status)
				? (result?.error || latest.error || "Generation failed") : null,
			...(runKey ? {
				outputHistory: currentHistory,
				latestRun: { ...latest, result: result || latest.result },
			} : {}),
		};
		// A processing poll carries no result. Keep the previous output visible
		// until a terminal run replaces it, matching Vibe's node behaviour.
		if (result || outputs.length) Object.assign(update, { outputs, resultUrl: first });
		updates[id] = update;
	}
	return updates;
}

/** Merge one status response into a serializable CozyClay graph. */
export function applyVibeRunUpdates(graph, payload) {
	const normalized = normalizeWorkflowGraph(graph);
	const updates = extractVibeRunUpdates(payload);
	if (!Object.keys(updates).length) return normalized;
	return {
		...normalized,
			nodes: normalized.nodes.map((node) => {
			const update = updates[node.id];
			if (!update) return node;
			const { latestRun, ...nodeUpdate } = update;
			const previous = Array.isArray(node.data?.outputHistory) ? node.data.outputHistory : [];
			const latest = latestRun;
			let outputHistory = previous;
			if (latest) {
				const key = latest.id || latest.run_id || latest.result?.id || latest.started_at;
				const existing = key && previous.findIndex((entry) => (entry.id || entry.run_id || entry.result?.id || entry.started_at) === key);
				outputHistory = existing >= 0
					? previous.map((entry, index) => index === existing ? latest : entry)
					: [...previous, latest];
			}
			return { ...node, data: { ...node.data, ...nodeUpdate, outputHistory } };
		}),
	};
}

/** Collapse MuAPI's per-node run arrays into the status used by the canvas. */
export function summarizeVibeRunStatus(payload) {
	const direct = typeof payload?.status === "string" ? payload.status.toLowerCase() : "";
	const success = new Set(["succeeded", "success", "completed", "complete"]);
	const failure = new Set(["failed", "failure", "error", "cancelled", "canceled"]);
	if (success.has(direct)) return { terminal: true, ok: true, status: "complete" };
	if (failure.has(direct)) return { terminal: true, ok: false, status: "error" };
	const nodeRuns = payload?.nodes || payload?.runData?.nodes || payload?.data?.nodes || {};
	const runs = Object.values(nodeRuns).flatMap((value) => Array.isArray(value) ? value : [value]).filter(Boolean);
	const statuses = runs.map((run) => String(run?.status || "").toLowerCase()).filter(Boolean);
	if (statuses.some((status) => failure.has(status))) return { terminal: true, ok: false, status: "error" };
	if (statuses.length > 0 && statuses.every((status) => success.has(status))) return { terminal: true, ok: true, status: "complete" };
	return { terminal: false, ok: false, status: "running" };
}
