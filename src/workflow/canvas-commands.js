import { schemaCategoryForType, schemaProperties } from "./node-schema.js";

const clone = (value) => structuredClone(value);
const commonKeys = new Set(["label", "model", "selectedModel", "formValues", "outputs", "outputHistory", "resultUrl", "cost", "errorMsg", "isLoading", "status", "statusMessage", "preview", "lastOutput", "assetInputs", "motionInputs", "characterInputs", "sceneName", "sceneId", "scene", "characterId", "url", "objectUrl", "fileName", "mimeType", "fileUrl", "localPreview", "uploading"]);
const typeKeys = { text: ["prompt"], image: ["prompt", "image_url"], video: ["prompt", "video_url", "duration"], audio: ["prompt", "audio_url", "duration"], api: ["params"], "video-combiner": ["videos_list", "aspect_ratio"], concat: ["template"], "motion-input": ["characterId"], upload: ["image_url", "video_url", "audio_url"], "shot-prompt": ["prompt", "target", "referenceOwnsCamera"] };

// New nodes go to the right of everything on the canvas so agent additions
// never land on top of what the user already placed.
const nextFreePosition = (graph) => ({ x: graph.nodes.reduce((max, node) => Math.max(max, (node.position?.x ?? 0) + 260), 80), y: 100 });

export function createCanvasCommands({ store, makeNode, nodeSchemas }) {
	const history = [];
	const maxHistory = 50;
	// The hub sends commands back to back, but a React-backed store only exposes
	// a mutation after the next render. Keep the last graph we committed and use
	// it until the store catches up, so connect() can see a node added a moment ago.
	let committed = null;
	const seen = new WeakSet();
	const current = () => {
		const fromStore = store.getGraph();
		// A graph we have not seen before came from the user (or the store caught
		// up with our own publish): trust it and drop the shadow copy.
		if (committed && fromStore !== committed && seen.has(fromStore)) return committed;
		committed = null;
		return fromStore;
	};
	const publish = (next) => { seen.add(store.getGraph()); seen.add(next); committed = next; store.setGraph(next); };
	const snapshot = () => clone(current());
	const mutate = (fn) => { const before = snapshot(); const next = fn(snapshot()); history.push(before); if (history.length > maxHistory) history.shift(); publish(next); return next; };
	const findNode = (graph, id) => graph.nodes.find((node) => node.id === id);
	const validateData = (node, data) => {
		if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("data must be an object");
		const properties = schemaProperties(nodeSchemas, schemaCategoryForType(node.type), node.data?.model || data.model);
		const allowed = new Set([...commonKeys, ...(typeKeys[node.type] || []), ...Object.keys(properties || {})]);
		for (const key of Object.keys(data)) if (!allowed.has(key)) throw new Error(`Unknown node data key: ${key}`);
		if (data.formValues && typeof data.formValues === "object") for (const key of Object.keys(data.formValues)) if (!allowed.has(key)) throw new Error(`Unknown node data key: ${key}`);
	};
	const handlers = {
		get_graph: () => { const graph = clone(current()); return { ...graph, nodes: graph.nodes.map((node) => ({ id: node.id, type: node.type, model: node.data?.model || null, data: node.data, position: node.position })), outputs: Object.fromEntries(graph.nodes.map((node) => [node.id, node.data?.outputs || []])) }; },
		add_node: ({ type, model, data = {}, position } = {}) => { const next = mutate((graph) => {
			if (typeof type !== "string" || !type || !["text", "image", "video", "audio", "api", "video-combiner", "scene", "upload", "concat", "motion-input", "shot-prompt"].includes(type)) throw new Error("Unknown node type");
			if (position && (!Number.isFinite(position.x) || !Number.isFinite(position.y))) throw new Error("position must contain finite x and y");
			const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
			const modelValue = typeof model === "string" ? model : model;
			const node = makeNode(type, id, position || nextFreePosition(graph), modelValue || null, nodeSchemas);
			if (modelValue && typeof modelValue === "string") {
				const models = nodeSchemas?.categories?.[schemaCategoryForType(type)]?.models || {};
				if (!models[modelValue]) throw new Error(`Unknown model: ${modelValue}`);
				node.data.model = modelValue;
			}
			validateData(node, data); node.data = { ...node.data, ...data }; graph.nodes.push(node); return graph;
		}); return { node: next.nodes.at(-1), graph: next }; },
		update_node: ({ id, data } = {}) => mutate((graph) => { const node = findNode(graph, id); if (!node) throw new Error(`Unknown node: ${id}`); validateData(node, data); node.data = { ...node.data, ...data, ...(data.formValues ? data.formValues : {}) , ...(data.formValues ? { formValues: { ...(node.data.formValues || {}), ...data.formValues } } : {}) }; return graph; }),
		remove_node: ({ id } = {}) => mutate((graph) => { if (!findNode(graph, id)) throw new Error(`Unknown node: ${id}`); graph.nodes = graph.nodes.filter((node) => node.id !== id); graph.edges = graph.edges.filter((edge) => edge.source !== id && edge.target !== id); return graph; }),
		connect: ({ source, target, sourceHandle, targetHandle = "input" } = {}) => { const next = mutate((graph) => { const from = findNode(graph, source); if (!from || !findNode(graph, target)) throw new Error("Unknown node"); const sources = from.type === "scene" ? ["render", "scene"] : ["output"]; if (sourceHandle === undefined) sourceHandle = sources[0]; if (!sources.includes(sourceHandle)) throw new Error("Invalid source handle"); if (targetHandle !== "input" && !String(targetHandle).startsWith("character:") && targetHandle !== "asset" && targetHandle !== "motion") throw new Error("Invalid target handle"); if (graph.edges.some((edge) => edge.source === source && edge.target === target && edge.targetHandle === targetHandle)) throw new Error("Nodes are already connected"); const edge = { id: `e-${source}-${target}-${Date.now()}`, source, target, sourceHandle, targetHandle, animated: true, style: { stroke: "#8994ff", strokeWidth: 2 } }; graph.edges.push(edge); return graph; }); return { edge: next.edges.at(-1), graph: next }; },
		disconnect: ({ edgeId } = {}) => mutate((graph) => { if (!graph.edges.some((edge) => edge.id === edgeId)) throw new Error(`Unknown edge: ${edgeId}`); graph.edges = graph.edges.filter((edge) => edge.id !== edgeId); return graph; }),
		run_workflow: async () => { const result = await store.run(clone(current())); const next = result?.graph || result; if (next?.nodes) publish(next); const outputs = Object.fromEntries((next?.nodes || []).map((node) => [node.id, node.data?.outputs || []])); return { outputs, graph: clone(next) }; },
		set_node_output: ({ id, value } = {}) => mutate((graph) => { const node = findNode(graph, id); if (!node) throw new Error(`Unknown node: ${id}`); node.data = { ...node.data, outputs: [{ value }], resultUrl: typeof value === "string" ? value : null }; return graph; }),
		focus_node: ({ id } = {}) => { if (!findNode(current(), id)) throw new Error(`Unknown node: ${id}`); store.focus(id); return { id }; },
		undo: () => { const previous = history.pop(); if (!previous) return { undone: false }; publish(previous); return { undone: true, graph: clone(previous) }; },
		history,
	};
	return { ...handlers, handlers, undo: handlers.undo, history };
}
