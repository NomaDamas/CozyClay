import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { FiBox, FiCode, FiFilm, FiImage, FiLink, FiMusic, FiPlay, FiPlus, FiUpload, FiVideo, FiType } from "react-icons/fi";
import { Toaster, toast } from "react-hot-toast";
import { loadWorkflowGraph, normalizeWorkflowGraph, storeWorkflowGraph, WORKFLOW_STORAGE_KEY } from "../project.js";
import CozySceneNode from "./CozySceneNode.jsx";
import { normalizeCozySceneData, toCozySceneRunRequest } from "./cozy-scene-node.js";
import { summarizeVibeRunStatus, toVibeWorkflowPayload } from "./vibe-payload.js";

const NODE_COLORS = { text: "#6c7cff", image: "#44c2a4", video: "#d9955b", audio: "#6bb6dc", api: "#cf8de8", "video-combiner": "#efb064", upload: "#a88cdb", concat: "#d6b55e", scene: "#ef759d" };

function makeNode(type, id, position) {
	const data = { label: type === "scene" ? "CozyClay Scene" : type[0].toUpperCase() + type.slice(1) };
	if (type === "text") data.prompt = "Describe a shot for your scene...";
	if (type === "image") data.model = "image-passthrough";
	if (type === "video") data.prompt = "Describe the motion and camera treatment";
	if (type === "audio") data.prompt = "Describe the voice or music";
	if (type === "api") { data.model = "api-model"; data.params = "{}"; }
	if (type === "video-combiner") { data.videos_list = []; data.aspect_ratio = "auto"; }
	if (type === "scene") Object.assign(data, normalizeCozySceneData({ sceneName: "CozyClay Scene" }));
	return { id, type, position, data };
}

const DEFAULT_GRAPH = {
	version: 1,
	nodes: [makeNode("text", "text-1", { x: 80, y: 100 }), makeNode("image", "image-1", { x: 380, y: 80 }), makeNode("scene", "scene-1", { x: 700, y: 140 })],
	edges: [],
};

function readGraph() {
	const graph = loadWorkflowGraph();
	return graph.nodes.length ? graph : DEFAULT_GRAPH;
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
	return <NodeShell id={id} type="image" title="Image" icon={FiImage}><label>Model</label><select value={data.model || "image-passthrough"} onChange={(event) => data.onChange?.(id, { model: event.target.value })}><option value="image-passthrough">Input Image</option><option value="image-generation">Image generation</option></select><div className="workflow-dropzone"><FiImage size={18} /><span>Connect an image or prompt</span></div><div className="workflow-node-foot"><span>Image output</span><button className="workflow-mini-button" type="button" onClick={() => data.onRun?.()}><FiPlay size={12} /></button></div></NodeShell>;
}

function VideoNode({ id, data }) {
	return <NodeShell id={id} type="video" title="Video" icon={FiVideo}><label>Motion prompt</label><input value={data.prompt || ""} onChange={(event) => data.onChange?.(id, { prompt: event.target.value })} placeholder="Motion prompt" /><label>Duration</label><select value={data.duration || "5"} onChange={(event) => data.onChange?.(id, { duration: event.target.value })}><option value="5">5 seconds</option><option value="10">10 seconds</option></select><div className="workflow-node-foot"><span>Video output</span><button className="workflow-mini-button" type="button" onClick={() => data.onRun?.()}><FiPlay size={12} /></button></div></NodeShell>;
}

function AudioNode({ id, data }) {
	return <NodeShell id={id} type="audio" title="Audio" icon={FiMusic}><label>Prompt</label><input value={data.prompt || ""} onChange={(event) => data.onChange?.(id, { prompt: event.target.value })} placeholder="Describe the voice or music" /><label>Audio URL</label><input value={data.audio_url || ""} onChange={(event) => data.onChange?.(id, { audio_url: event.target.value })} placeholder="https://…" /><div className="workflow-node-foot"><span>Audio output</span><button className="workflow-mini-button" type="button" onClick={() => data.onRun?.()}><FiPlay size={12} /></button></div></NodeShell>;
}

function ApiNode({ id, data }) {
	return <NodeShell id={id} type="api" title="API Node" icon={FiCode}><label>Model</label><input value={data.model || "api-model"} onChange={(event) => data.onChange?.(id, { model: event.target.value })} /><label>Parameters (JSON)</label><textarea className="workflow-textarea" value={data.params || "{}"} onChange={(event) => data.onChange?.(id, { params: event.target.value })} /><div className="workflow-node-foot"><span>API model</span><button className="workflow-mini-button" type="button" onClick={() => data.onRun?.()}><FiPlay size={12} /></button></div></NodeShell>;
}

function VideoCombinerNode({ id, data }) {
	return <NodeShell id={id} type="video-combiner" title="Video Combiner" icon={FiFilm}><label>Video URLs (one per line)</label><textarea className="workflow-textarea" value={(data.videos_list || []).join("\n")} onChange={(event) => data.onChange?.(id, { videos_list: event.target.value.split(/\n+/).map((value) => value.trim()).filter(Boolean) })} placeholder="https://…" /><label>Aspect ratio</label><select value={data.aspect_ratio || "auto"} onChange={(event) => data.onChange?.(id, { aspect_ratio: event.target.value })}><option>auto</option><option>16:9</option><option>9:16</option><option>1:1</option></select><div className="workflow-node-foot"><span>Combined video</span><button className="workflow-mini-button" type="button" onClick={() => data.onRun?.()}><FiPlay size={12} /></button></div></NodeShell>;
}

function UploadNode({ id, data }) {
	return <NodeShell id={id} type="upload" title="Upload" icon={FiUpload}><label className="workflow-upload"><FiUpload size={18} /><span>{data.uploading ? "Uploading…" : "Choose image, video, or audio"}</span><input type="file" accept="image/*,video/*,audio/*" disabled={data.uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) data.onUpload?.(id, file); }} /></label><p className="workflow-hint">{data.fileName || "Upload to MuAPI or keep a local preview."}</p></NodeShell>;
}

function ConcatNode({ id, data }) {
	return <NodeShell id={id} type="concat" title="Prompt Concat" icon={FiLink}><label>Template</label><input value={data.template || "{prompt} {style}"} onChange={(event) => data.onChange?.(id, { template: event.target.value })} /><div className="workflow-node-foot"><span>Text merge</span></div><Handle type="target" position={Position.Left} id="input-a" className="workflow-handle target" /></NodeShell>;
}

const NODE_TYPES = { text: TextNode, image: ImageNode, video: VideoNode, audio: AudioNode, api: ApiNode, "video-combiner": VideoCombinerNode, upload: UploadNode, concat: ConcatNode };

function SceneNodeType({ data, ...props }) {
	return <CozySceneNode {...props} data={data} HandleComponent={Handle} onDataChange={data.onSceneChange} onRun={data.onSceneRun} onOpenScene={() => window.open("/app/", "_blank", "noopener,noreferrer")} />;
}

const FLOW_NODE_TYPES = { ...NODE_TYPES, scene: SceneNodeType };

export default function WorkflowBuilder() {
	const initial = useMemo(readGraph, []);
	const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
	const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
	const [locked, setLocked] = useState(false);
	const [runState, setRunState] = useState("local");
	const [lastSaved, setLastSaved] = useState(false);
	const graph = useMemo(() => serializableGraph(nodes, edges), [nodes, edges]);
	const graphRef = useRef(graph);
	useEffect(() => { graphRef.current = graph; }, [graph]);

	const updateNode = useCallback((id, patch) => setNodes((current) => current.map((node) => node.id === id ? { ...node, data: { ...node.data, ...patch } } : node)), [setNodes]);
	const updateScene = useCallback(({ id, patch, data }) => {
		// CozySceneNode already applies nested patches (camera/playing) against
		// its normalized envelope. Store that complete envelope so a later control
		// change cannot shallow-replace sibling controls and reset them.
		updateNode(id, data || patch);
	}, [updateNode]);
	const addNode = useCallback((type) => {
		const id = `${type}-${Date.now()}`;
		setNodes((current) => {
			const extraIndex = Math.max(0, current.length - 3);
			const position = current.length < 3
				? { x: 80 + current.length * 300, y: 100 }
				: { x: 80 + (extraIndex % 2) * 360, y: 560 + Math.floor(extraIndex / 2) * 260 };
			return [...current, makeNode(type, id, position)];
		});
		toast.success(`${type === "scene" ? "CozyClay Scene" : type} node added`);
	}, [setNodes]);
	useEffect(() => { storeWorkflowGraph(graph); }, [graph]);
	useEffect(() => {
		const onStorage = (event) => {
			if (event.key !== WORKFLOW_STORAGE_KEY) return;
			const next = loadWorkflowGraph();
			// An explicit empty graph is a real new-project state. Only a removed
			// key means there is no draft and should restore the starter nodes.
			setNodes(event.newValue === null ? DEFAULT_GRAPH.nodes : next.nodes);
			setEdges(event.newValue === null ? DEFAULT_GRAPH.edges : next.edges);
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, [setEdges, setNodes]);
	useEffect(() => {
		const connected = (handle) => edges.filter((edge) => edge.targetHandle === handle).map((edge) => edge.source).filter((source, index, values) => values.indexOf(source) === index);
		const assetInputs = connected("asset");
		const motionInputs = connected("motion");
		setNodes((current) => {
			let changed = false;
			const next = current.map((node) => {
				if (node.type !== "scene") return node;
				const oldAssets = Array.isArray(node.data?.assetInputs) ? node.data.assetInputs : [];
				const oldMotion = Array.isArray(node.data?.motionInputs) ? node.data.motionInputs : [];
				if (JSON.stringify(oldAssets) === JSON.stringify(assetInputs) && JSON.stringify(oldMotion) === JSON.stringify(motionInputs)) return node;
				changed = true;
				return { ...node, data: { ...node.data, assetInputs, motionInputs } };
			});
			return changed ? next : current;
		});
	}, [edges, setNodes]);

	const uploadFile = useCallback(async (id, file) => {
		updateNode(id, { uploading: true, fileName: file.name });
		try {
			const query = `?filename=${encodeURIComponent(file.name)}`;
			const signed = await jsonRequest(`/workflow-api/app/get_file_upload_url${query}`);
			if (!signed.url || !signed.fields?.key) throw new Error("MuAPI upload URL is incomplete");
			const form = new FormData();
			Object.entries(signed.fields).forEach(([key, value]) => form.append(key, value));
			form.append("file", file);
			const uploaded = await fetch(signed.url, { method: "POST", body: form });
			if (!uploaded.ok) throw new Error(`Upload failed (${uploaded.status})`);
			const hostedUrl = `https://cdn.muapi.ai/${signed.fields.key}`;
			const kind = file.type.startsWith("video/") ? "video_url" : file.type.startsWith("audio/") ? "audio_url" : "image_url";
			updateNode(id, { uploading: false, fileName: file.name, mimeType: file.type, fileUrl: hostedUrl, [kind]: hostedUrl });
			toast.success("File uploaded to MuAPI");
		} catch (error) {
			const localUrl = URL.createObjectURL(file);
			updateNode(id, { uploading: false, fileName: file.name, mimeType: file.type, fileUrl: localUrl, localPreview: true });
			toast(`Bridge upload unavailable; local preview kept (${error.message})`);
		}
	}, [updateNode]);

	const saveToBridge = useCallback(async () => {
		storeWorkflowGraph(graph);
		setLastSaved(true);
		try { await jsonRequest("/workflow-api/workflow/create", { method: "POST", body: JSON.stringify(toVibeWorkflowPayload(graph)) }); toast.success("Workflow saved locally and to bridge"); }
		catch (error) { toast(error.status === 503 ? "Workflow saved locally; bridge is disabled" : "Workflow saved locally; bridge save failed"); }
	}, [graph]);

	const runWorkflow = useCallback(async () => {
		if (!toVibeWorkflowPayload(graph).data.nodes.length) {
			setRunState("complete");
			toast.success("Local CozyClay scene is ready");
			return;
		}
		setRunState("running");
		try {
			const saved = await jsonRequest("/workflow-api/workflow/create", { method: "POST", body: JSON.stringify(toVibeWorkflowPayload(graph)) });
			const workflowId = saved.workflow_id || saved.id || "cozyclay-local";
			const result = await jsonRequest("/workflow-api/workflow/run", { method: "POST", body: JSON.stringify({ workflow_id: workflowId, cost: 0 }) });
			if (result.run_id) {
				for (let attempt = 0; attempt < 30; attempt += 1) {
					const status = await jsonRequest(`/workflow-api/workflow/run/${encodeURIComponent(result.run_id)}/status`);
					const summary = summarizeVibeRunStatus(status);
					if (summary.terminal) { setRunState(summary.status); toast[summary.ok ? "success" : "error"](summary.ok ? "Workflow finished" : "Workflow failed"); return; }
					await new Promise((resolve) => setTimeout(resolve, 1000));
				}
			}
			setRunState("complete"); toast.success("Workflow submitted");
		} catch (error) { setRunState("disabled"); toast.error(error.status === 503 ? "Workflow bridge is disabled — saved locally" : error.message); }
	}, [graph]);

	const runScene = useCallback(async ({ id, data }) => {
		const payload = toCozySceneRunRequest({ id, data }, { workflow: graphRef.current });
		updateScene({ id, patch: { status: "complete", statusMessage: `Local scene ready at frame ${payload.frame}`, preview: "scene", lastOutput: { renderUrl: null, sceneUrl: "/app/", jobId: null } } });
		toast.success("CozyClay Scene updated locally");
	}, [updateScene]);

	const decoratedNodes = useMemo(() => nodes.map((node) => ({
		...node,
		data: {
			...node.data,
			id: node.id,
			onChange: updateNode,
			...(node.type === "scene" ? { onSceneChange: updateScene, onSceneRun: runScene } : { onRun: runWorkflow }),
			...(node.type === "upload" ? { onUpload: uploadFile } : {}),
		},
	})), [nodes, runScene, runWorkflow, updateNode, updateScene, uploadFile]);

	const exportGraph = useCallback(() => { const blob = new Blob([JSON.stringify(graph, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "cozyclay-workflow.json"; anchor.click(); URL.revokeObjectURL(url); toast.success("Workflow exported"); }, [graph]);
	const onConnect = useCallback((params) => setEdges((current) => addEdge({ ...params, animated: true, style: { stroke: "#8994ff", strokeWidth: 2 } }, current)), [setEdges]);
	const runLabel = { local: "Local workflow", running: "Running", complete: "Complete", error: "Failed", disabled: "Bridge disabled" }[runState] || "Local workflow";

	return <div className="workflow-app">
		<Toaster position="bottom-right" toastOptions={{ style: { background: "#252833", color: "#f4f5fb" } }} />
		<header className="workflow-topbar"><div className="workflow-brand"><span className="workflow-brand-mark">C</span><span>CozyClay</span><span className="workflow-divider">/</span><strong>Workflow</strong></div><div className="workflow-top-actions"><span className={`workflow-status ${runState}`}><i /> {runLabel}</span><button type="button" onClick={saveToBridge}>{lastSaved ? "Saved" : "Save"}</button><button type="button" onClick={runWorkflow}><FiPlay size={12} /> Run</button><button type="button" onClick={exportGraph}>Export</button></div></header>
		<div className="workflow-main"><aside className="workflow-sidebar"><div className="workflow-sidebar-title">Nodes</div><p className="workflow-sidebar-copy">Build a visual chain from prompts to a staged CozyClay scene.</p><div className="workflow-node-menu">{[["text", "Text", FiType], ["image", "Image", FiImage], ["video", "Video", FiVideo], ["audio", "Audio", FiMusic], ["api", "API Node", FiCode], ["video-combiner", "Video Combiner", FiFilm], ["upload", "Upload", FiUpload], ["concat", "Prompt Concat", FiLink], ["scene", "CozyClay Scene", FiBox]].map(([type, label, Icon]) => <button type="button" key={type} className="workflow-add-node" onClick={() => addNode(type)}><span style={{ color: NODE_COLORS[type] }}><Icon size={16} /></span><span>{label}</span><FiPlus size={13} /></button>)}</div><div className="workflow-sidebar-bottom"><button type="button" onClick={() => setLocked((value) => !value)}>{locked ? "Unlock canvas" : "Lock canvas"}</button><a href="/app/">Open Studio ↗</a></div></aside><section className="workflow-canvas"><ReactFlow nodes={decoratedNodes} edges={edges} nodeTypes={FLOW_NODE_TYPES} onNodesChange={locked ? undefined : onNodesChange} onEdgesChange={locked ? undefined : onEdgesChange} onConnect={locked ? undefined : onConnect} fitView snapToGrid snapGrid={[16, 16]} defaultEdgeOptions={{ type: "smoothstep" }}><Background color="#282c38" gap={24} size={1} /><Controls showInteractive={false} /><MiniMap nodeColor={(node) => NODE_COLORS[node.type] || "#777"} maskColor="rgba(12,14,20,.72)" /><Panel position="top-right" className="workflow-canvas-panel"><button type="button" onClick={() => addNode("scene")}><FiPlus size={13} /> Add node</button></Panel></ReactFlow></section></div>
	</div>;
}
