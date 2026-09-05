import { useCallback, useMemo, useState } from "react";
import ReactFlow, {
	addEdge,
	Background,
	Controls,
	MiniMap,
	Panel,
	Position,
	Handle,
	useEdgesState,
	useNodesState,
} from "reactflow";
import { FiImage, FiLink, FiPlay, FiPlus, FiUpload, FiVideo, FiType, FiBox } from "react-icons/fi";
import { Toaster, toast } from "react-hot-toast";

const NODE_COLORS = {
	text: "#6c7cff",
	image: "#44c2a4",
	video: "#d9955b",
	upload: "#a88cdb",
	concat: "#d6b55e",
	scene: "#ef759d",
};

const makeNode = (type, id, position) => ({
	id,
	type,
	position,
	data: { label: type === "scene" ? "CozyClay Scene" : type[0].toUpperCase() + type.slice(1) },
});

const initialNodes = [
	makeNode("text", "text-1", { x: 80, y: 100 }),
	makeNode("image", "image-1", { x: 380, y: 80 }),
	makeNode("scene", "scene-1", { x: 700, y: 140 }),
];

function HandlePort({ type, position, id }) {
	return <Handle type={type} position={position} id={id} className={`workflow-handle ${type}`} />;
}

function NodeShell({ id, type, title, icon: Icon, children }) {
	return (
		<div className={`workflow-node workflow-node-${type}`}>
			{type !== "text" && <HandlePort type="target" position={Position.Left} id="input" />}
			<div className="workflow-node-header">
				<span className="workflow-node-icon"><Icon size={15} /></span>
				<strong>{title}</strong>
				<span className="workflow-node-id">{id.replace(/\D/g, "") || "1"}</span>
			</div>
			<div className="workflow-node-body">{children}</div>
			{type !== "upload" && <HandlePort type="source" position={Position.Right} id="output" />}
		</div>
	);
}

function TextNode({ data }) {
	return <NodeShell id={data.id || "text-1"} type="text" title="Text" icon={FiType}>
		<label>Prompt</label><textarea className="workflow-textarea" defaultValue="Describe a shot for your scene..." />
		<div className="workflow-node-foot"><span>AI Text</span><button className="workflow-mini-button"><FiPlay size={12} /></button></div>
	</NodeShell>;
}

function ImageNode({ data }) {
	return <NodeShell id={data.id || "image-1"} type="image" title="Image" icon={FiImage}>
		<label>Model</label><select defaultValue="image-passthrough"><option value="image-passthrough">Input Image</option><option>Image generation</option></select>
		<div className="workflow-dropzone"><FiImage size={18} /><span>Drop image or connect input</span></div>
	</NodeShell>;
}

function VideoNode({ data }) {
	return <NodeShell id={data.id || "video-1"} type="video" title="Video" icon={FiVideo}>
		<label>Prompt</label><input placeholder="Motion prompt" />
		<label>Duration</label><select defaultValue="5"><option value="5">5 seconds</option><option value="10">10 seconds</option></select>
		<div className="workflow-node-foot"><span>Video output</span><button className="workflow-mini-button"><FiPlay size={12} /></button></div>
	</NodeShell>;
}

function UploadNode({ data }) {
	return <NodeShell id={data.id || "upload-1"} type="upload" title="Upload" icon={FiUpload}>
		<label className="workflow-upload"><FiUpload size={18} /><span>Choose image or video</span><input type="file" accept="image/*,video/*" /></label>
		<p className="workflow-hint">Files stay in this browser until connected.</p>
	</NodeShell>;
}

function ConcatNode({ data }) {
	return <NodeShell id={data.id || "concat-1"} type="concat" title="Prompt Concat" icon={FiLink}>
		<label>Template</label><input defaultValue="{prompt} {style}" />
		<div className="workflow-node-foot"><span>2 text inputs</span></div>
		<HandlePort type="target" position={Position.Left} id="input-a" />
	</NodeShell>;
}

function SceneNode({ data }) {
	return <NodeShell id={data.id || "scene-1"} type="scene" title="CozyClay Scene" icon={FiBox}>
		<div className="workflow-scene-preview"><div className="workflow-scene-grid" /><span>3D scene preview</span></div>
		<div className="workflow-scene-controls"><button>Scene</button><button>Camera</button><button>Motion</button></div>
		<div className="workflow-node-foot"><span>Ready to stage</span><button className="workflow-run-button"><FiPlay size={12} /> Run</button></div>
	</NodeShell>;
}

const nodeTypes = { text: TextNode, image: ImageNode, video: VideoNode, upload: UploadNode, concat: ConcatNode, scene: SceneNode };

export default function WorkflowBuilder() {
	const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
	const [edges, setEdges, onEdgesChange] = useEdgesState([]);
	const [locked, setLocked] = useState(false);
	const [saved, setSaved] = useState(false);
	const onConnect = useCallback((params) => setEdges((eds) => addEdge({ ...params, animated: true, style: { stroke: "#8994ff", strokeWidth: 2 } }, eds)), [setEdges]);
	const addNode = useCallback((type) => {
		const id = `${type}-${Date.now()}`;
		setNodes((current) => [...current, makeNode(type, id, { x: 220 + (current.length % 3) * 250, y: 120 + Math.floor(current.length / 3) * 220 })]);
		toast.success(`${type === "scene" ? "CozyClay Scene" : type} node added`);
	}, [setNodes]);
	const onNodeDragStop = useCallback((_event, node) => setNodes((current) => current.map((item) => item.id === node.id ? { ...item, position: node.position } : item)), [setNodes]);
	const exportGraph = useCallback(() => {
		const blob = new Blob([JSON.stringify({ nodes, edges }, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "cozyclay-workflow.json"; anchor.click(); URL.revokeObjectURL(url);
		toast.success("Workflow exported");
	}, [nodes, edges]);
	const flowNodeTypes = useMemo(() => nodeTypes, []);
	return <div className="workflow-app">
		<Toaster position="bottom-right" toastOptions={{ style: { background: "#252833", color: "#f4f5fb" } }} />
		<header className="workflow-topbar"><div className="workflow-brand"><span className="workflow-brand-mark">C</span><span>CozyClay</span><span className="workflow-divider">/</span><strong>Workflow</strong></div><div className="workflow-top-actions"><span className="workflow-status"><i /> Local workflow</span><button onClick={() => { setSaved(true); toast.success("Workflow saved"); }}>{saved ? "Saved" : "Save"}</button><button onClick={exportGraph}>Export</button></div></header>
		<div className="workflow-main">
			<aside className="workflow-sidebar"><div className="workflow-sidebar-title">Nodes</div><p className="workflow-sidebar-copy">Build a visual chain from prompts to a staged CozyClay scene.</p><div className="workflow-node-menu">{[["text", "Text", FiType], ["image", "Image", FiImage], ["video", "Video", FiVideo], ["upload", "Upload", FiUpload], ["concat", "Prompt Concat", FiLink], ["scene", "CozyClay Scene", FiBox]].map(([type, label, Icon]) => <button key={type} className="workflow-add-node" onClick={() => addNode(type)}><span style={{ color: NODE_COLORS[type] }}><Icon size={16} /></span><span>{label}</span><FiPlus size={13} /></button>)}</div><div className="workflow-sidebar-bottom"><button onClick={() => setLocked((value) => !value)}>{locked ? "Unlock canvas" : "Lock canvas"}</button><a href="/app/">Open Studio ↗</a></div></aside>
			<section className="workflow-canvas"><ReactFlow nodes={nodes.map((node) => ({ ...node, data: { ...node.data, id: node.id } }))} edges={edges} nodeTypes={flowNodeTypes} onNodesChange={locked ? undefined : onNodesChange} onEdgesChange={locked ? undefined : onEdgesChange} onConnect={locked ? undefined : onConnect} onNodeDragStop={locked ? undefined : onNodeDragStop} fitView snapToGrid snapGrid={[16, 16]} defaultEdgeOptions={{ type: "smoothstep" }}><Background color="#282c38" gap={24} size={1} /><Controls showInteractive={false} /><MiniMap nodeColor={(node) => NODE_COLORS[node.type] || "#777"} maskColor="rgba(12,14,20,.72)" /><Panel position="top-right" className="workflow-canvas-panel"><button onClick={() => addNode("scene")}><FiPlus size={13} /> Add node</button></Panel></ReactFlow></section>
		</div>
	</div>;
}
