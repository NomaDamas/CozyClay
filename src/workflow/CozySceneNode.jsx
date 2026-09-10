import { useEffect, useMemo, useState } from "react";
import { track } from "../analytics.js";
import { downloadPack, requestKeyframePack } from "./keyframe-pack-request.js";
import {
	applyCozyScenePatch,
	COZY_SCENE_OUTPUTS,
	normalizeCozySceneData,
	nextSceneFrame,
	sceneInputSpecs,
	sceneTimelinePatch,
} from "./cozy-scene-node.js";
import { publishScenePlayback } from "./scene-asset-sync.js";
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
	return <iframe className="cozy-scene-live-frame nodrag nopan" src="/app/?embed=playview" title="CozyClay Studio PlayView preview" aria-label="CozyClay Studio PlayView preview" />;
}

function callbackFrom(data, prop) {
	return typeof prop === "function" ? prop : typeof data[prop] === "function" ? data[prop] : null;
}

export default function CozySceneNode({ id = "cozy-scene", data: rawData = {}, selected = false, HandleComponent = null, onDataChange = null, onRun = null, onOpenScene = null, onVideo = null }) {
	const data = useMemo(() => normalizeCozySceneData(rawData), [rawData]);
	const Handle = HandleComponent || rawData.Handle || BridgeHandle;
	// Explicit component callbacks win over generic node data callbacks. This
	// prevents a workflow-wide `onRun` handler from hijacking the Scene node's
	// own render action when ReactFlow decorates every node with shared data.
	const change = onDataChange || callbackFrom(rawData, "onDataChange");
	const run = onRun || callbackFrom(rawData, "onRun");
	const openScene = onOpenScene || callbackFrom(rawData, "onOpenScene");
	const sendToVideo = onVideo || callbackFrom(rawData, "onVideo");
	// The pack export is a one-shot side trip, not graph state: it never has to
	// survive a reload or reach the workflow runner, so it stays on the node.
	const [pack, setPack] = useState({ pending: false, message: "", error: "" });

	const sendToAi = async () => {
		setPack({ pending: true, message: "", error: "" });
		try {
			const frame = document.querySelector(`[data-node-id="${id}"] iframe`)?.contentWindow;
			// No shotId: the Scene node tracks a scene, not a shot, so the embed
			// packs the shot under its own playhead — the one being previewed.
			const result = await requestKeyframePack(frame);
			downloadPack(result);
			track("export:keyframe_pack", { entries: result.entries.length, source: "workflow" });
			// QA hook, mirroring window.__cozyclay in the Studio: the analytics
			// module is a no-op outside production, so a headless run has nothing
			// else to assert the export was reported against.
			if (typeof window !== "undefined") {
				window.__cozyclayWorkflow = { ...(window.__cozyclayWorkflow || {}), lastTrack: { event: "export:keyframe_pack", entries: result.entries.length, source: "workflow" } };
			}
			setPack({ pending: false, message: `Pack ready: ${result.name} (${result.entries.length} files)`, error: "" });
		} catch (error) {
			setPack({ pending: false, message: "", error: error?.message || String(error) });
		}
	};

	const emit = (patch, { syncPlayback = true } = {}) => {
		const nextData = applyCozyScenePatch(data, patch);
		change?.({ id, patch, data: nextData });
		if (syncPlayback && (Object.prototype.hasOwnProperty.call(patch, "frame") || patch.controls?.playing !== undefined)) {
			publishScenePlayback({ activeSceneId: nextData.sceneId, frame: nextData.frame, playing: nextData.controls.playing });
		}
	};
	const maxFrame = Math.max(0, data.frameCount - 1);
	useEffect(() => {
		if (!data.controls.playing) return undefined;
		const timer = window.setTimeout(() => {
			const next = nextSceneFrame(data);
			// The running Studio owns its own clock. Only send the terminal pause
			// back across the tab boundary; per-frame storage writes would be noisy.
			emit({ frame: next.frame, controls: { playing: next.playing } }, { syncPlayback: !next.playing });
		}, 1000 / 24);
		return () => window.clearTimeout(timer);
	}, [data.controls.playing, data.frame, data.frameCount]);

	// The take length belongs to the scene, not to this node: the embed says how
	// long it is, so the slider and the local clock stop where the previs does.
	useEffect(() => {
		const onMessage = (event) => {
			const frame = document.querySelector(`[data-node-id="${CSS.escape(id)}"] iframe`);
			if (!frame || event.source !== frame.contentWindow) return;
			const patch = sceneTimelinePatch(data, event.data);
			if (patch) emit(patch, { syncPlayback: false });
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [id, data]);

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
				<span className={`cozy-scene-node-status status-${pack.error ? "error" : pack.message ? "complete" : data.status}${pack.error || pack.message ? " has-pack" : ""}`} role="status">{pack.error || pack.message || statusLabel(data.status)}</span>
			</header>

			<section className="cozy-scene-preview" aria-label="3D scene preview">
				{/* The live previs is never swapped out for the capture: a render is a
				    still, and replacing the frame with it left Play ticking a counter
				    over a dead picture (#218). The capture rides along as a thumbnail. */}
				<SceneViewport />
				{data.preview === "render" && data.lastOutput?.renderUrl && <figure className="cozy-scene-render-thumb"><img src={data.lastOutput.renderUrl} alt="Captured scene frame" /><figcaption>Last render</figcaption></figure>}
				{data.preview === "render" && <div className="cozy-scene-preview-copy"><strong>Live previs</strong><span>{data.statusMessage || "Open Studio to edit the scene"}</span></div>}
			</section>

			<section className="cozy-scene-controls" aria-label="Scene controls">
				<div className="cozy-scene-control-row">
					<button type="button" className="cozy-scene-button" onClick={() => emit({ controls: { playing: !data.controls.playing } })} aria-label={data.controls.playing ? "Pause scene" : "Play scene"} aria-pressed={data.controls.playing}>{data.controls.playing ? "Pause" : "Play"}</button>
					<button type="button" className="cozy-scene-button" onClick={() => openScene?.({ id, data })}>Open Studio</button>
					<button type="button" className="cozy-scene-send" onClick={sendToAi} disabled={pack.pending} title="Export this shot's keyframe pack for an AI video model">{pack.pending ? "Packing…" : "Send to AI"}</button>
					<button type="button" className="cozy-scene-run" onClick={() => run?.({ id, data })} disabled={data.status === "running"}>{data.status === "running" ? "Rendering…" : "Run"}</button>
				</div>
				<label className="cozy-scene-frame-control">Frame <input aria-label="Scene frame" type="range" min="0" max={maxFrame} value={Math.min(data.frame, maxFrame)} onChange={(event) => emit({ frame: Number(event.currentTarget.value), controls: { playing: false } })} /> <output aria-live="polite">{Math.min(data.frame, maxFrame)}/{maxFrame}</output></label>
				<div className="cozy-scene-camera-row" aria-label="Camera orbit controls">
					<button type="button" onClick={() => emit({ controls: { camera: { yaw: data.controls.camera.yaw - 15 } } })} aria-label="Orbit camera left">◀</button>
					<span>Camera {Math.round(data.controls.camera.yaw)}° / {Math.round(data.controls.camera.pitch)}°</span>
					<button type="button" onClick={() => emit({ controls: { camera: { yaw: data.controls.camera.yaw + 15 } } })} aria-label="Orbit camera right">▶</button>
				</div>
				<div className="cozy-scene-handoff">
					<button type="button" className="cozy-scene-video" onClick={() => sendToVideo?.({ id, data })} title="Add a Video node fed by this scene's render">→ Video</button>
					<p className="cozy-scene-hint">Play to check the previs, then send render → Video to generate a clip.</p>
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
