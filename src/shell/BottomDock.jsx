import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStudioShell } from "./studio-shell-context.js";
import { logStore } from "./log-store.js";
import "./dock.css";
import { ko } from "../locale.js";
import Timeline from "../ardy/timeline.jsx";
import { DEFAULT_PLAYBACK_SPEED, SHOT_ASPECT_PRESETS, sceneObjectNameDisplayKo } from "../app-stage.jsx";
import { motionEditLayout, createMotionEdit } from "../ardy/motion-edit.js";
import { trackFeature } from "../analytics.js";
import { defaultRailRange } from "../camera-rail-schedule.js";

// G11: the dock resizes within [220, 480] px, and never so far that the 3D
// viewport drops under 480 px (top bar 44 + status bar 24 + three 1 px gaps).
// Never below the sequencer's own grid (shell.css --shell-dock-default): a
// shorter dock would have to scroll its lanes.
export const DOCK_MIN_HEIGHT = 324;
export const DOCK_MAX_HEIGHT = 480;
const VIEWPORT_MIN_HEIGHT = 480;
const SHELL_FIXED_ROWS = 44 + 24 + 3;
const DOCK_HEIGHT_KEY = "cozyclay.dock.height.v1";

function clampDockHeight(height) {
	const roomy = Math.min(DOCK_MAX_HEIGHT, window.innerHeight - SHELL_FIXED_ROWS - VIEWPORT_MIN_HEIGHT);
	return Math.round(Math.min(Math.max(DOCK_MIN_HEIGHT, roomy), Math.max(DOCK_MIN_HEIGHT, height)));
}

function readStored(key) {
	try {
		return globalThis.localStorage?.getItem(key) ?? null;
	} catch {
		return null;
	}
}

function writeStored(key, value) {
	try {
		globalThis.localStorage?.setItem(key, value);
	} catch (error) {
		console.warn(`[cozyclay] could not store ${key}`, error);
	}
}

function readDockHeight() {
	const stored = Number(readStored(DOCK_HEIGHT_KEY));
	return Number.isFinite(stored) && stored > 0 ? stored : null;
}

export default function BottomDock() {
	const {
		tlFrame, motion, waypointMode, craneSelectedIndex,
		isCameraSelection, addActiveCranePoint, deleteSelectedCranePoint, setCraneSelectedIndex, tlFrameCount,
		tlFps, characters, activeCharIndex, ghostLayers, pathSpeed,
		tlPlaying, workflowMode, waypoints, pendingWaypointFrame, promptClips,
		selectedPromptId, stateBadge, ikMode, ikChains, applyMotionTrim,
		resetMotionTrim, cutMotionAtPlayhead, changeMotionSegmentSpeed, removeMotionSegmentById, ikFrames,
		rangePins, rangePinSelection, ikEditTool, rangePinPreview, footSnap,
		bodyContact, shots, shotAspectKey, activeShotIdx, railDraw,
		pathDraw, selectedSceneObject, setPathDraw, setRailDraw, setWorkspaceLayout,
		changeSceneObject, timingTokenRef, beginSceneTransaction, endSceneTransaction, railCurve,
		posing, ikAddKeyframe, ikDeleteKeyframe, setRangePinSelection, setIkEditTool,
		setBodyContact, setToast, setFootSnap, setTlFrame, advanceFrame,
		stepFrame, cameraPreviewEndRef, manualCameraOverrideRef, setTlPlaying, toggleWaypointMode,
		setWaypointMode, selectActiveCharacterInHierarchy, setActiveWaypointId, setPendingWaypointFrame, removeWaypoint,
		queueRootWaypointFrame, addPromptClip, revealPromptBlocks, setSelectedPromptId, setArdyPrompt,
		changePromptClip, resizePromptClip, movePromptClip, removePromptClip, setSelectedHierarchyId,
		selectWorkflowMode, addCameraKeyframe, moveCameraKeyframe, removeCameraKeyframe, syncActiveCameraFraming,
		activeCamera, activeShotDuration, changeActiveCamera, cameraRail, previewCameraShot,
		toggleCameraRailDraw, deleteCameraRail, selectTimelineShot, shotsDomain, runStudioAction,
		clearMotion, subscribeToasts, exportStatus, exportPhaseLabel, ardyRunning, ardyStatus,
		ardyOutcome,
	} = useStudioShell();
	const dockRef = useRef(null);
	const [dockHeight, setDockHeight] = useState(readDockHeight);
	const dockHeightRef = useRef(dockHeight);
	dockHeightRef.current = dockHeight;

	// The dock height is the shell row's --shell-dock-height. null keeps the
	// shell's responsive default; a stored size is re-clamped on every window
	// resize so the viewport never drops under its minimum height.
	useLayoutEffect(() => {
		const app = dockRef.current?.closest(".app");
		if (!app) return undefined;
		const apply = () => {
			if (dockHeightRef.current === null) app.style.removeProperty("--shell-dock-height");
			else app.style.setProperty("--shell-dock-height", `${clampDockHeight(dockHeightRef.current)}px`);
		};
		apply();
		window.addEventListener("resize", apply);
		return () => window.removeEventListener("resize", apply);
	}, [dockHeight]);

	function commitDockHeight(next) {
		const height = clampDockHeight(next);
		setDockHeight(height);
		writeStored(DOCK_HEIGHT_KEY, String(height));
	}

	function beginDockResize(event) {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		const startY = event.clientY;
		const startHeight = dockRef.current.getBoundingClientRect().height;
		let latest = startHeight;
		const onMove = (move) => {
			latest = clampDockHeight(startHeight - (move.clientY - startY));
			setDockHeight(latest);
		};
		const onUp = () => {
			document.body.classList.remove("is-resizing", "resize-timeline");
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			commitDockHeight(latest);
		};
		document.body.classList.add("is-resizing", "resize-timeline");
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
	}

	function onDockResizeKey(event) {
		const step = event.shiftKey ? 48 : 16;
		const current = dockRef.current.getBoundingClientRect().height;
		if (event.key === "ArrowUp") commitDockHeight(current + step);
		else if (event.key === "ArrowDown") commitDockHeight(current - step);
		else if (event.key === "Home") commitDockHeight(DOCK_MIN_HEIGHT);
		else if (event.key === "End") commitDockHeight(DOCK_MAX_HEIGHT);
		else return;
		event.preventDefault();
	}

	// Session Log: every toast (App fans each one out to subscribeToasts),
	// generation jobs and export phases. The toast sink set lives for the
	// whole session, so one subscription on mount is enough.
	useEffect(() => subscribeToasts((toast) => logStore.push({ kind: "toast", text: toast.uiMessage })),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[]);
	const generationWasRunning = useRef(false);
	useEffect(() => {
		if (ardyRunning && !generationWasRunning.current) logStore.push({ kind: "generation", text: ko("Motion generation started", "모션 생성을 시작했어요") });
		generationWasRunning.current = ardyRunning;
	}, [ardyRunning]);
	useEffect(() => {
		if (ardyRunning && ardyStatus) logStore.push({ kind: "generation", key: "generation:status", text: ardyStatus });
	}, [ardyRunning, ardyStatus]);
	useEffect(() => {
		if (!ardyOutcome) return;
		logStore.push({ kind: "generation", text: ardyOutcome.ok
			? ko("Motion generation finished", "모션 생성을 마쳤어요")
			: ko(`Motion generation failed — ${ardyOutcome.message}`, `모션 생성 실패 — ${ardyOutcome.message}`) });
	}, [ardyOutcome]);
	const exportPhase = exportStatus?.phase, exportLabel = exportStatus?.label, exportMessage = exportStatus?.message;
	const exportDone = exportStatus?.completedFrames, exportTotal = exportStatus?.frameCount;
	useEffect(() => {
		if (!exportPhase) return;
		const progress = exportPhase === "encoding" && exportTotal ? ` ${exportDone ?? 0}/${exportTotal}` : "";
		const detail = ["completed", "failed", "cancelled"].includes(exportPhase) && exportMessage ? ` — ${exportMessage}` : "";
		logStore.push({
			kind: "export",
			key: `export:${exportLabel}:${exportPhase}`,
			text: `${ko("Export", "내보내기")} ${exportPhaseLabel(exportPhase)}${exportLabel ? ` · ${exportLabel}` : ""}${progress}${detail}`,
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [exportPhase, exportLabel, exportMessage, exportDone, exportTotal]);

	return (
		<div className="bottom-window v2-dock" ref={dockRef}>
			<div
				className="v2-dock-resize"
				data-testid="dock-resize-handle"
				role="separator"
				tabIndex={0}
				aria-orientation="horizontal"
				aria-label={ko("Resize bottom dock", "하단 도크 크기 조절")}
				aria-valuemin={DOCK_MIN_HEIGHT}
				aria-valuemax={DOCK_MAX_HEIGHT}
				aria-valuenow={dockHeight ?? undefined}
				onPointerDown={beginDockResize}
				onKeyDown={onDockResizeKey}
			/>
			<div className="bottom-timeline">
			<Timeline
				frame={tlFrame}
				craneSelectedIndex={craneSelectedIndex}
				cameraSelected={isCameraSelection}
				onCranePointAdd={addActiveCranePoint}
				onCranePointDelete={deleteSelectedCranePoint}
				onCranePointSelect={setCraneSelectedIndex}
				frameCount={tlFrameCount}
				fps={tlFps}
				playbackSpeed={DEFAULT_PLAYBACK_SPEED}
			trackOwner={characters.length > 1 ? `S${activeCharIndex + 1}` : null}
			ghostLayers={ghostLayers}
			pathSpeed={pathSpeed}
			playing={tlPlaying}
			workflowMode={workflowMode === "pose" ? "motion" : workflowMode}
			waypointMode={waypointMode}
			waypoints={waypoints}
			pathSpeed={pathSpeed}
			pendingWaypointFrame={pendingWaypointFrame}
			promptClips={promptClips}
			selectedPromptId={selectedPromptId}
			badge={stateBadge}
			ikMode={ikMode}
			ikDisabled={!ikChains}
			motion={motion ? {
				frames: motion.frames,
				label: motion.prompt || ko("Loaded take", "불러온 테이크"),
				segments: motionEditLayout(motion.editSegments ?? createMotionEdit(motion.frames)),
			} : null}
			onMotionTrim={applyMotionTrim}
			onMotionTrimReset={resetMotionTrim}
			onMotionCut={cutMotionAtPlayhead}
			onMotionSpeedChange={changeMotionSegmentSpeed}
			onMotionSegmentRemove={removeMotionSegmentById}
			ikFrames={ikFrames}
			rangePins={rangePins}
			selectedPinId={rangePinSelection}
			pendingPinRange={ikMode && ikEditTool === "pin" ? rangePinPreview?.draft ?? null : null}
			footSnap={footSnap}
			bodyContact={bodyContact}
				shots={shots}
				shotAspect={shotAspectKey}
				activeShotIdx={activeShotIdx}
				railDraw={railDraw}
				pathDraw={pathDraw}
				pathObject={selectedSceneObject ? { id: selectedSceneObject.id, name: sceneObjectNameDisplayKo(selectedSceneObject.name), path: selectedSceneObject.path } : null}
				onObjectPathDrawToggle={() => {
					setPathDraw((current) => !current);
					if (!pathDraw) setRailDraw(false);
					setWorkspaceLayout((current) => ({ ...current, insetCollapsed: false }));
				}}
				onObjectPathChange={(path) => {
					if (selectedSceneObject) changeSceneObject(selectedSceneObject.id, { path }, timingTokenRef.current ?? undefined);
				}}
				onObjectPathClear={() => {
					if (!selectedSceneObject) return;
					const token = beginSceneTransaction({ owner: "object-path", cancel: () => {} });
					changeSceneObject(selectedSceneObject.id, { path: null }, token);
					endSceneTransaction(token, { commit: true });
				}}
				onObjectTimingGestureStart={() => {
					timingTokenRef.current = beginSceneTransaction({ owner: "object-timing", cancel: () => { timingTokenRef.current = null; } });
				}}
				onObjectTimingGestureEnd={() => {
					if (timingTokenRef.current != null) endSceneTransaction(timingTokenRef.current, { commit: true });
					timingTokenRef.current = null;
				}}
				cameraRailLength={railCurve?.length ?? null}
			shotCutDisabled={!!posing || ikMode || waypointMode}
			onIkKeyframeAdd={ikAddKeyframe}
			onIkKeyframeRemove={ikDeleteKeyframe}
			onPinSelect={(id) => { setRangePinSelection(id); setIkEditTool("pin"); }}
			onBodyContactToggle={() => {
				setBodyContact((v) => {
					setToast(v ? ko("Body contact off — floor constraints are disabled", "바닥 접촉 꺼짐 — 바닥 제약이 비활성화됩니다") : ko("Body contact on — body markers stay above the floor", "바닥 접촉 켜짐 — 신체 접촉점이 바닥 아래로 내려가지 않습니다"));
					return !v;
				});
			}}
			onFootSnapToggle={() => {
				setFootSnap((v) => {
			setToast(v ? ko("Foot snap off — the feet follow the body", "발 스냅 꺼짐 — 발이 몸을 따라갑니다") : ko("Foot snap on — the feet stay planted while the body moves", "발 스냅 켜짐 — 몸이 움직여도 발은 바닥에 고정됩니다"));
					return !v;
				});
			}}
			onScrub={(frame) => { trackFeature("timeline_scrub"); setTlFrame(frame); }}
			onAdvance={advanceFrame}
			onStep={stepFrame}
			onPlayToggle={() => {
				cameraPreviewEndRef.current = null;
				manualCameraOverrideRef.current = false;
				setTlPlaying((v) => !v);
			}}
			onWaypointToggle={toggleWaypointMode}
			onMarkerSelect={(id) => {
				const waypoint = waypoints.find((entry) => entry.id === id);
				if (!waypoint) throw new Error(`Unknown waypoints ID: ${id}`);
				setTlFrame(Math.min(waypoint.frame, tlFrameCount - 1));
				setWaypointMode(true);
				selectActiveCharacterInHierarchy();
				setActiveWaypointId(id);
				setPendingWaypointFrame(null);
			}}
			onMarkerRemove={removeWaypoint}
			onRootKeyframeAdd={queueRootWaypointFrame}
			onPromptAdd={(frame) => {
				addPromptClip(frame);
				selectActiveCharacterInHierarchy();
				revealPromptBlocks();
			}}
			onPromptSelect={(id) => {
				setSelectedPromptId(id);
				setArdyPrompt(promptClips.find((clip) => clip.id === id)?.text ?? "");
				selectActiveCharacterInHierarchy();
				revealPromptBlocks();
			}}
			onPromptChange={changePromptClip}
			onPromptResize={resizePromptClip}
			onPromptMove={movePromptClip}
			onPromptRemove={removePromptClip}
			onCameraMoveSelect={() => {
				setSelectedHierarchyId("camera");
				if (workflowMode !== "camera") selectWorkflowMode("camera");
			}}
			onCameraKeyframeAdd={addCameraKeyframe}
			onCameraKeyframeMove={moveCameraKeyframe}
				onCameraKeyframeRemove={removeCameraKeyframe}
				onCameraBlockSelect={(shotId) => {
					const selected = shots.find((entry) => entry.id === shotId);
					if (!selected) throw new Error(`Unknown shots ID: ${shotId}`);
					setTlFrame(selected.startFrame);
					setSelectedHierarchyId("camera");
					if (workflowMode !== "camera") selectWorkflowMode("camera");
				}}
				onCameraBlockChange={(patch, shotId) => {
					if (patch.mode === "follow") syncActiveCameraFraming();
					const nextPatch = patch.mode === "rail" && activeCamera.railFollow?.mode === "off"
						? { ...patch, railFollow: defaultRailRange(activeShotDuration) }
						: patch;
					// The embedded dolly graph edits the shot it sits in; the
					// camera bar above edits the selected one.
					changeActiveCamera(nextPatch, shotId);
					if (patch.mode === "follow" && !motion) {
						setToast(ko(
							"Follow rides the subject's motion — without a loaded motion the camera composes a static frame",
							"팔로우 카메라는 인물 모션을 따라 움직입니다 — 모션이 없으면 카메라는 정지 구도를 유지합니다",
						));
					}
					if (patch.mode === "rail" && !cameraRail) {
						setRailDraw(true);
						setWorkspaceLayout((current) => ({ ...current, insetCollapsed: false }));
						setToast(ko("Draw this Camera Block's rail in the Top-View", "탑뷰에서 이 카메라 블록의 레일을 그리세요"));
					}
				}}
				onCameraPreview={previewCameraShot}
				onCameraRailDrawToggle={toggleCameraRailDraw}
				onCameraRailDelete={deleteCameraRail}
			onShotSelect={selectTimelineShot}
			onShotBoundaryMove={shotsDomain.resizeTimelineShot}
			onShotRename={shotsDomain.renameTimelineShot}
			onShotRemove={(shotId) => runStudioAction("shot.remove", { shotId })}
			onShotDuplicate={(shotId) => runStudioAction("shot.duplicate", { shotId })}
			onShotCut={() => runStudioAction("shot.create")}
			onShotSplit={(shotId) => runStudioAction("shot.split", { shotId })}
			onShotMove={(shotId, targetFrame) => runStudioAction("shot.reorder", { shotId, startFrame: Math.max(0, Math.round(targetFrame)) })}
			onClearMotion={motion ? clearMotion : null}
		/>
			</div>
			<ShotCard />
		</div>
	);
}

// #570: the ratios offered on the card; the rest stay in Camera mode's menu.
const CARD_RATIOS = [
	{ key: "16:9", label: "16:9" },
	{ key: "2.39:1", label: "2.39" },
	{ key: "4:3", label: "4:3" },
	{ key: "1:1", label: "1:1" },
	{ key: "9:16", label: "9:16" },
];

/** The shot camera's card at the dock's right end. The camera itself is drawn
 * into the stage canvas under `.vp-shot-preview`, which sits over the card's
 * frame slot (see glass.css); the card holds its title, ratio and look-through. */
function ShotCard() {
	const { activeShot, shot, shotAspectKey, runStudioAction, enterShotLook, tlFps, embedMode } = useStudioShell();
	if (embedMode) return null;
	const ratio = SHOT_ASPECT_PRESETS[shotAspectKey]?.label?.replace(/:1$/, "") ?? shotAspectKey;
	const frames = activeShot && Number.isFinite(activeShot.startFrame) && Number.isFinite(activeShot.endFrame)
		? `${activeShot.startFrame}–${activeShot.endFrame} · ${((activeShot.endFrame - activeShot.startFrame + 1) / (tlFps || 24)).toFixed(1)}s`
		: null;
	return (
		<section className="dock-shot-card" aria-label={ko("Shot Camera", "샷 카메라")}>
			<header className="dock-shot-head">
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5.75A1.5 1.5 0 0 1 3.5 4.25h6A1.5 1.5 0 0 1 11 5.75v4.5a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 2 10.25z M11 7l3-1.5v5L11 9" /></svg>
				<span className="dock-shot-title">{ko("Shot Camera", "샷 카메라")}</span>
				<span className="dock-shot-meta">{shot.focalMm} mm · {ratio}</span>
			</header>
			<div className="dock-shot-frame" aria-hidden="true" />
			<div className="dock-shot-ratios" role="radiogroup" aria-label={ko("Shot aspect ratio", "샷 화면 비율")}>
				{CARD_RATIOS.map((entry) => (
					<button
						type="button"
						role="radio"
						key={entry.key}
						data-aspect={entry.key}
						aria-checked={shotAspectKey === entry.key}
						onClick={() => runStudioAction("stage.setFilmback", { shotAspect: entry.key })}
					>
						{entry.label}
					</button>
				))}
			</div>
			<footer className="dock-shot-foot">
				<span className="dock-shot-name">
					{activeShot?.name ?? ko("No shot yet", "샷 없음")}
					{frames && <span className="dock-shot-range"> · {frames}</span>}
				</span>
				<button type="button" className="dock-shot-look" onClick={enterShotLook} title={ko("Look through the shot camera (Esc returns)", "샷 카메라 시점으로 보기 (Esc로 복귀)")}>
					<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z M8 6.25a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 1 1 0-3.5z" /></svg>
					{ko("Look through", "샷 시점")}
				</button>
			</footer>
		</section>
	);
}
