import { normalizeWorkflowGraph } from "../project.js";
import { motionInputOutput } from "./motion-input.js";

/**
 * Execute a workflow graph without a network runner. Nodes are deliberately
 * value transformers: this keeps the canvas useful offline and makes the
 * generated values available to the local Scene node.
 */
export function executeLocalWorkflowGraph(graph, { runId = `local-${Date.now()}` } = {}) {
	const normalized = normalizeWorkflowGraph(graph);
	const nodeById = new Map(normalized.nodes.map((node) => [node.id, node]));
	const incoming = new Map(normalized.nodes.map((node) => [node.id, []]));
	for (const edge of normalized.edges) incoming.get(edge.target)?.push(edge);
	const remaining = new Set(normalized.nodes.map((node) => node.id));
	const values = new Map();
	const updates = new Map();
	const order = [];
	while (remaining.size) {
		const ready = [...remaining].filter((id) => (incoming.get(id) || []).every((edge) => !remaining.has(edge.source)));
		const batch = ready.length ? ready : [...remaining];
		for (const id of batch) { remaining.delete(id); order.push(id); }
	}
	for (const id of order) {
		const node = nodeById.get(id);
		const inputs = (incoming.get(id) || []).map((edge) => values.get(edge.source)).filter((value) => value !== undefined);
		const output = localNodeOutput(node, inputs);
		values.set(id, output);
		const run = { id: runId, status: "complete", result: { outputs: [{ value: output }] } };
		const history = Array.isArray(node.data?.outputHistory) ? node.data.outputHistory : [];
		const deduped = history.filter((entry) => entry?.id !== runId);
		updates.set(id, {
			status: "complete",
			isLoading: false,
			errorMsg: null,
			outputs: [{ value: output }],
			resultUrl: typeof output === "string" && /^(?:https?:|blob:|data:)/.test(output) ? output : null,
			latestRun: run,
			outputHistory: [...deduped, run],
		});
	}
	return {
		...normalized,
		nodes: normalized.nodes.map((node) => ({ ...node, data: { ...node.data, ...(updates.get(node.id) || {}) } })),
		order,
	};
}

function localNodeOutput(node, inputs) {
	const data = node.data || {};
	if (node.type === "scene") return { sceneId: data.sceneId || null, assetInputs: data.assetInputs || [], motionInputs: data.motionInputs || [], characterInputs: data.characterInputs || [] };
	if (node.type === "motion-input") return motionInputOutput(data);
	if (node.type === "concat") return String(data.template || "{prompt}").replace(/\{prompt\}/g, inputs[0] == null ? "" : String(inputs[0]));
	if (node.type === "upload") return data.fileUrl || data.image_url || data.video_url || data.audio_url || null;
	if (node.type === "video-combiner") return (data.videos_list || inputs).filter(Boolean).join("\n");
	if (node.type === "api") return data.params || inputs[0] || "{}";
	if (node.type === "image") return data.image_url || inputs[0] || data.prompt || null;
	if (node.type === "video") return data.video_url || inputs[0] || data.prompt || null;
	if (node.type === "audio") return data.audio_url || inputs[0] || data.prompt || null;
	return data.prompt || inputs[0] || "";
}
