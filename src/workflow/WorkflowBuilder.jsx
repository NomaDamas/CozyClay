import { useCallback, useEffect, useMemo, useState } from "react";
import ReactFlow, {
	addEdge,
	Background,
	Controls,
	Handle,
	MiniMap,
	Panel,
	Position,
	useEdgesState,
	useNodesState,
} from "reactflow";
import { FiBox, FiImage, FiLink, FiPlay, FiPlus, FiUpload, FiVideo, FiType } from "react-icons/fi";
import { Toaster, toast } from "react-hot-toast";
import { normalizeWorkflowGraph } from "../project.js";
import CozySceneNode from "./CozySceneNode.jsx";
import { normalizeCozySceneData, toCozySceneRunRequest } from "./cozy-scene-node.js";

const STORAGE_KEY = "cozyclay.workflow.v1";
const NODE_COLORS = { text: "#6c7cff", image: "#44c2a4", video: "#d9955b", upload: "#a88cdb", concat: "#d6b55e", scene: "#ef759d" };

function makeNode(type, id, position) {
	const data = { label: type === "scene" ? "CozyClay Scene" : type[0].toUpperCase() + type.slice(1) };
	if (type === "text") data.prompt = "Describe a shot for your scene...";
	if (type === "image") data.model = "image-passthrough";
	if (type === "video") data.prompt = "Describe the motion and camera treatment";
	if (type === "scene") Object.assign(data, normalizeCozySceneData({ sceneName: "CozyClay Scene" }));
	return { id, type, position, data };
}

const DEFAULT_GRAPH = {
	version: 1,
	nodes: [makeNode("text", "text-1", { x: 80, y: 100 }), makeNode("image", "image-1", { x: 380, y: 80 }), makeNode("scene", "scene-1", { x: 700, y: 140 })],
	edges: [],
};

function readGraph() {
	try {
		const saved = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) || "null");
		const graph = normalizeWorkflowGraph(saved);
		return graph.nodes.length ? graph : DEFAULT_GRAPH;
	} catch {
		return DEFAULT_GRAPH;
	}
}

function stripFunctions(value) {
	if (Array.isArray(value)) return value.map(stripFunctions);
	if (!value || typeof value !== "object") return typeof value === "function" ? undefined : value;
	return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item !== "function").map(([key, item]) => [key, stripFunctions(item)]));
}

function serializableGraph(nodes, edges) {
	return normalizeWorkflowGraph({
		version: 1,
		nodes: nodes.map(({ id, type, position, data }) => ({ id, type, position, data: stripFunctions(data) })),
		edges: edges.map(({ id, source, target, sourceHandle, targetHandle, data }) => ({ id, source, target, sourceHandle, targetHandle, data: stripFunctions(data) })),
	});
}

async function jsonRequest(path, options = {}) {
	const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
	const payload = await response.json().catch(() => ({}));
	if (!response.ok) throw Object.assign(new Error(payload.error || `Workflow API ${response.status}`), { status: response.status, payload });
	return payload;
}

function NodeShell({ id, type, title, icon: Icon, children, source = true, target = true }) {
	return <div className={`workflow-node workflow-node-${type}`}>
		{target && <Handle type="target" position={Position.Left} id="input" className="workflow-handle target" />}
		<div className="workflow-node-header"><span className="workflow-node-icon"><Icon size={15} /></span><strong>{title}</strong><span className="workflow-node-id">{id.replace(/\D/g, "") || "1"}</span></div>
		<div className="workflow-node-body">{children}</div>
		{source && <Handle type="source" position={Position.Right} id="output" className="workflow-handle source" />}
	</div>;
}

function TextNode({ id, data }) {
	return <NodeShell id={id} type="text" title="Text" icon={FiType} target={false}><label>Prompt</label><textarea className="workflow-textarea" value={data.prompt || ""} onChange={(event) => data.onChange?.(id, { prompt: event.target.value })} /><div className="workflow-node-foot"><span>Prompt input</span><button className="workflow-mini-button" type="button" onClick={() => data.onRun?.()}><FiPlay size={12} /></button></div></NodeShell>;
}

function ImageNode({ id, data }) {
	return <NodeShell id={id} type="image" title="Image" icon={FiImage}><label>Model</label><select value={data.model || "image-passthrough"} onChange={(event) => data.onChange?.(id, { model: event.target.value })}><option value="image-passthrough">Input Image</option><option value="image-generation">Image generation</option></select><div className="workflow-dropzone"><FiImage size={18} /><span>Connect an image or prompt</span></div></NodeShell>;
}

function VideoNode({ id, data }) {
	return <NodeShell id={id} type="video" title="Video" icon={FiVideo}><label>Motion prompt</label><input value={data.prompt || ""} onChange={(event) => data.onChange?.(id, { prompt: event.target.value })} placeholder="Motion prompt" /><label>Duration</label><select value={data.duration || "5"} onChange={(event) => data.onChange?.(id, { duration: event.target.value })}><option value="5">5 seconds</option><option value="10">10 seconds</option></select><div className="workflow-node-foot"><span>Video output</span><button className="workflow-mini-button" type="button" onClick={() => data.onRun?.()}><FiPlay size={12} /></button></div></NodeShell>;
}

function UploadNode({ id, data }) {
	return <NodeShell id={id} type="upload" title="Upload" icon={FiUpload}><label className="workflow-upload"><FiUpload size={18} /><span>Choose image or video</span><input type="file" accept="image/*,video/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) data.onChange?.(id, { fileName: file.name, fileUrl: URL.createObjectURL(file) }); }} /></label><p className="workflow-hint">{data.fileName || "Files stay in this browser until connected."}</p></NodeShell>;
}

function ConcatNode({ id, data }) {
	return <NodeShell id={id} type="concat" title="Prompt Concat" icon={FiLink}><label>Template</label><input value={data.template || "{prompt} {style}"} onChange={(event) => data.onChange?.(id, { template: event.target.value })} /><div className="workflow-node-foot"><span>Text merge</span></div><Handle type="target" position={Position.Left} id="input-a" className="workflow-handle target" /></NodeShell>;
}

const NODE_TYPES = { text: TextNode, image: ImageNode, video: VideoNode, upload: UploadNode, concat: ConcatNode };

export default function WorkflowBuilder() {
	const initial = useMemo(readGraph, []);
	const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
	const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
	const [locked, setLocked] = useState(false);
	const [runState, setRunState] = useState("local");
	const [lastSaved, setLastSaved] = useState(false);

	const updateNode = useCallback((id, patch) => setNodes((current) => current.map((node) => node.id === id ? { ...node, data: { ...node.data, ...patch } } : node)), [setNodes]);
	const updateScene = useCallback(({ id, patch }) => updateNode(id, patch), [updateNode]);
	const addNode = useCallback((type) => { const id = `${type}-${Date.now()}`; setNodes((current) => [...current, makeNode(type, id, { x: 220 + (current.length % 3) * 250, y: 120 + Math.floor(current.length / 3) * 220 })]); toast.success(`${type === "scene" ? "CozyClay Scene" : type} node added`); }, [setNodes]);
	const graph = useMemo(() => serializableGraph(nodes, edges), [nodes, edges]);

	useEffect(() => { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(graph)); }, [graph]);

	const saveToBridge = useCallback(async () => {
		globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(graph));
		setLastSaved(true);
		try { await jsonRequest("/workflow-api/workflow/create", { method: "POST", body: JSON.stringify({ name: "CozyClay Workflow", data: { nodes: graph.nodes }, edges: graph.edges, workflow_id: null }) }); toast.success("Workflow saved locally and to bridge"); }
		catch (error) { toast(error.status === 503 ? "Workflow saved locally; bridge is disabled" : "Workflow saved locally; bridge save failed"); }
	}, [graph]);

	const runWorkflow = useCallback(async () => {
		setRunState("running");
		try {
			const saved = await jsonRequest("/workflow-api/workflow/create", { method: "POST", body: JSON.stringify({ name: "CozyClay Workflow", data: { nodes: graph.nodes }, edges: graph.edges, workflow_id: null }) });
			const workflowId = saved.workflow_id || saved.id || "cozyclay-local";
			const result = await jsonRequest("/workflow-api/workflow/run", { method: "POST", body: JSON.stringify({ workflow_id: workflowId, cost: 0, data: { nodes: graph.nodes }, edges: graph.edges }) });
			if (result.run_id) {
				for (let attempt = 0; attempt < 30; attempt += 1) {
					const status = await jsonRequest(`/workflow-api/workflow/run/${encodeURIComponent(result.run_id)}/status`);
					if (["completed", "complete", "failed", "error"].includes(status.status)) { setRunState(status.status === "failed" || status.status === "error" ? "error" : "complete"); toast[status.status === "failed" || status.status === "error" ? "error" : "success"]("Workflow finished"); return; }
					await new Promise((resolve) => setTimeout(resolve, 1000));
				}
			}
			setRunState("complete"); toast.success("Workflow submitted");
		} catch (error) { setRunState("disabled"); toast.error(error.status === 503 ? "Workflow bridge is disabled — saved locally" : error.message); }
	}, [graph]);

	const runScene = useCallback(async ({ id, data }) => {
		updateScene({ id, patch: { status: "running", statusMessage: "Sending scene to local bridge" } });
		try {
			const payload = toCozySceneRunRequest({ id, data }, { workflow: graph });
			const result = await jsonRequest(`/workflow-api/workflow/cozyclay-scene/node/${encodeURIComponent(id)}/run`, { method: "POST", body: JSON.stringify(payload) });
			updateScene({ id, patch: { status: result?.error ? "error" : "complete", statusMessage: result?.error || result?.message || "Render complete", preview: result?.renderUrl ? "render" : "scene", lastOutput: { renderUrl: result?.renderUrl || null, sceneUrl: result?.sceneUrl || null, jobId: result?.jobId || result?.run_id || null } } });
		} catch (error) { updateScene({ id, patch: { status: "error", statusMessage: error.status === 503 ? "Bridge disabled; start workflow:bridge" : error.message } }); toast.error("Scene render is unavailable"); }
	}, [graph, updateScene]);

	const flowNodeTypes = useMemo(() => ({ ...NODE_TYPES, scene: (props) => <CozySceneNode {...props} HandleComponent={Handle} onDataChange={updateScene} onRun={runScene} onOpenScene={() => window.open("/app/", "_blank", "noopener,noreferrer")} /> }), [runScene, updateScene]);
	const decoratedNodes = useMemo(() => nodes.map((node) => ({ ...node, data: { ...node.data, id: node.id, onChange: updateNode, onRun: runWorkflow } })), [nodes, runWorkflow, updateNode]);

	const exportGraph = useCallback(() => { const blob = new Blob([JSON.stringify(graph, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "cozyclay-workflow.json"; anchor.click(); URL.revokeObjectURL(url); toast.success("Workflow exported"); }, [graph]);
	const onConnect = useCallback((params) => setEdges((current) => addEdge({ ...params, animated: true, style: { stroke: "#8994ff", strokeWidth: 2 } }, current)), [setEdges]);

	return <div className="workflow-app">
		<Toaster position="bottom-right" toastOptions={{ style: { background: "#252833", color: "#f4f5fb" } }} />
		<header className="workflow-topbar"><div className="workflow-brand"><span className="workflow-brand-mark">C</span><span>CozyClay</span><span className="workflow-divider">/</span><strong>Workflow</strong></div><div className="workflow-top-actions"><span className={`workflow-status ${runState}`}><i /> {runState === "disabled" ? "Bridge disabled" : runState === "running" ? "Running" : "Local workflow"}</span><button type="button" onClick={saveToBridge}>{lastSaved ? "Saved" : "Save"}</button><button type="button" onClick={runWorkflow}><FiPlay size={12} /> Run</button><button type="button" onClick={exportGraph}>Export</button></div></header>
		<div className="workflow-main"><aside className="workflow-sidebar"><div className="workflow-sidebar-title">Nodes</div><p className="workflow-sidebar-copy">Build a visual chain from prompts to a staged CozyClay scene.</p><div className="workflow-node-menu">{[["text", "Text", FiType], ["image", "Image", FiImage], ["video", "Video", FiVideo], ["upload", "Upload", FiUpload], ["concat", "Prompt Concat", FiLink], ["scene", "CozyClay Scene", FiBox]].map(([type, label, Icon]) => <button type="button" key={type} className="workflow-add-node" onClick={() => addNode(type)}><span style={{ color: NODE_COLORS[type] }}><Icon size={16} /></span><span>{label}</span><FiPlus size={13} /></button>)}</div><div className="workflow-sidebar-bottom"><button type="button" onClick={() => setLocked((value) => !value)}>{locked ? "Unlock canvas" : "Lock canvas"}</button><a href="/app/">Open Studio ↗</a></div></aside><section className="workflow-canvas"><ReactFlow nodes={decoratedNodes} edges={edges} nodeTypes={flowNodeTypes} onNodesChange={locked ? undefined : onNodesChange} onEdgesChange={locked ? undefined : onEdgesChange} onConnect={locked ? undefined : onConnect} fitView snapToGrid snapGrid={[16, 16]} defaultEdgeOptions={{ type: "smoothstep" }}><Background color="#282c38" gap={24} size={1} /><Controls showInteractive={false} /><MiniMap nodeColor={(node) => NODE_COLORS[node.type] || "#777"} maskColor="rgba(12,14,20,.72)" /><Panel position="top-right" className="workflow-canvas-panel"><button type="button" onClick={() => addNode("scene")}><FiPlus size={13} /> Add node</button></Panel></ReactFlow></section></div>
	</div>;
}
