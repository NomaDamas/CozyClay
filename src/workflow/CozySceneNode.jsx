import { useMemo } from "react";
import {
	applyCozyScenePatch,
	COZY_SCENE_OUTPUTS,
	normalizeCozySceneData,
	sceneInputSpecs,
} from "./cozy-scene-node.js";
import "./cozy-scene-node.css";

/**
 * ReactFlow-compatible node UI without a ReactFlow dependency.
 *
 * Pass ReactFlow's Handle component through `data.Handle` (or the optional
 * `HandleComponent` prop) when registering the node type. Keeping the bridge
 * boundary injectable lets CozyClay build and test this adapter by itself,
 * while the workflow surface can use @xyflow/react later.
 */
function BridgeHandle({ type, position, id, label }) {
	return <span className={`cozy-scene-handle cozy-scene-handle-${type}`} data-handle-type={type} data-handle-position={position} data-handle-id={id} aria-label={label} />;
}

function statusLabel(status) {
	return ({ idle: "Ready when connected", ready: "Ready", running: "Rendering…", complete: "Render complete", error: "Needs attention" })[status] ?? status;
}

function SceneViewport() {
	return <div className="cozy-scene-canvas nodrag nopan" role="img" aria-label="CozyClay world environment preview">
		<div className="cozy-scene-world-image" aria-hidden="true" />
		<div className="cozy-scene-world-tint" aria-hidden="true" />
	</div>;
}

function callbackFrom(data, prop) {
	return typeof prop === "function" ? prop : typeof data[prop] === "function" ? data[prop] : null;
}

export default function CozySceneNode({ id = "cozy-scene", data: rawData = {}, selected = false, HandleComponent = null, onDataChange = null, onRun = null, onOpenScene = null }) {
	const data = useMemo(() => normalizeCozySceneData(rawData), [rawData]);
	const Handle = HandleComponent || rawData.Handle || BridgeHandle;
	// Explicit component callbacks win over generic node data callbacks. This
	// prevents a workflow-wide `onRun` handler from hijacking the Scene node's
	// own render action when ReactFlow decorates every node with shared data.
	const change = onDataChange || callbackFrom(rawData, "onDataChange");
	const run = onRun || callbackFrom(rawData, "onRun");
	const openScene = onOpenScene || callbackFrom(rawData, "onOpenScene");

	const emit = (patch) => {
		const nextData = applyCozyScenePatch(data, patch);
		change?.({ id, patch, data: nextData });
	};

	const handleProps = (spec, type, position) => ({
		 type,
		 position,
		 id: spec.id,
		 label: spec.label,
		className: `cozy-scene-reactflow-handle cozy-scene-reactflow-handle-${spec.id}`,
	});

	return (
		<article className={`cozy-scene-node${selected ? " is-selected" : ""}`} data-node-id={id} data-node-type="cozyclay-scene" aria-label="CozyClay Scene node">
			<div className="cozy-scene-node-inputs" aria-label="Scene inputs">
				{sceneInputSpecs(data.characters?.length ? data.characters : (data.characterInputs || []).map((entry) => ({ id: entry.characterId, subject: entry.characterId })), { includeLegacyMotion: true }).map((spec) => <Handle key={spec.id} {...handleProps(spec, "target", "left")} />)}
			</div>
			<header className="cozy-scene-node-header">
				<div>
					<span className="cozy-scene-node-kicker">COZYCLAY</span>
					<h3>{data.sceneName}</h3>
				</div>
				<span className={`cozy-scene-node-status status-${data.status}`} role="status">{statusLabel(data.status)}</span>
			</header>

			<section className="cozy-scene-preview" aria-label="3D scene preview">
				{data.preview === "render" && data.lastOutput?.renderUrl ? <video className="cozy-scene-render" src={data.lastOutput.renderUrl} controls muted /> : <SceneViewport />}
		<div className="cozy-scene-preview-copy"><strong>{data.preview === "render" ? "Rendered frame" : "World environment"}</strong><span>{data.statusMessage || "Open Studio to edit the scene"}</span></div>
			</section>

			<section className="cozy-scene-controls" aria-label="Scene controls">
				<div className="cozy-scene-control-row">
					<button type="button" className="cozy-scene-button" onClick={() => emit({ controls: { playing: !data.controls.playing } })} aria-label={data.controls.playing ? "Pause scene" : "Play scene"}>{data.controls.playing ? "Pause" : "Play"}</button>
					<button type="button" className="cozy-scene-button" onClick={() => openScene?.({ id, data })}>Open Studio</button>
					<button type="button" className="cozy-scene-run" onClick={() => run?.({ id, data })} disabled={data.status === "running"}>{data.status === "running" ? "Rendering…" : "Run"}</button>
				</div>
				<label className="cozy-scene-frame-control">Frame <input type="range" min="0" max={Math.max(1, data.frameCount - 1)} value={Math.min(data.frame, Math.max(0, data.frameCount - 1))} onChange={(event) => emit({ frame: Number(event.currentTarget.value) })} /> <output>{data.frame}/{Math.max(0, data.frameCount - 1)}</output></label>
				<div className="cozy-scene-camera-row" aria-label="Camera orbit controls">
					<button type="button" onClick={() => emit({ controls: { camera: { yaw: data.controls.camera.yaw - 15 } } })} aria-label="Orbit camera left">◀</button>
					<span>Camera {Math.round(data.controls.camera.yaw)}° / {Math.round(data.controls.camera.pitch)}°</span>
					<button type="button" onClick={() => emit({ controls: { camera: { yaw: data.controls.camera.yaw + 15 } } })} aria-label="Orbit camera right">▶</button>
				</div>
			</section>

			<footer className="cozy-scene-node-footer"><span>{data.assetInputs.length} asset{data.assetInputs.length === 1 ? "" : "s"}</span><span>{data.motionInputs.length} motion{data.motionInputs.length === 1 ? "" : "s"}</span></footer>
			<div className="cozy-scene-node-outputs" aria-label="Scene outputs">
				{COZY_SCENE_OUTPUTS.map((spec) => <Handle key={spec.id} {...handleProps(spec, "source", "right")} />)}
			</div>
		</article>
	);
}

export { BridgeHandle };
