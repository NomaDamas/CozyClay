import { useStudioShell } from "./studio-shell-context.js";
import { ko } from "../locale.js";
import AssetPane from "../asset-pane.jsx";
import TakeBarPanel from "../panels/TakeBarPanel.jsx";
import Timeline from "../ardy/timeline.jsx";
import { DEFAULT_PLAYBACK_SPEED, sceneObjectNameDisplayKo } from "../app-stage.jsx";
import { motionEditLayout, createMotionEdit } from "../ardy/motion-edit.js";
import { trackFeature } from "../analytics.js";
import { defaultRailRange } from "../camera-rail-schedule.js";

export default function BottomDock() {
	const {
		bottomTab, setBottomTab, beginAssetDrag, shelfImageIds, shelfMeshIds,
		manageAssetStorage, setManageAssetStorage, unusedAssetIds, usedAssetIds, usageCounts,
		projectAssetGraphSignature, assetTrash, deleteUnusedAsset, undoDeletedAsset, deletingAssetId,
		projectManifest, linePreviewUrl, takeSourceUrl, sceneDisabledReason, sceneMenuOpen,
		setSceneMenuOpen, refineDisabledReason, lineEditMode, enterRefineMode, readinessState,
		bridgeChecking, openMotionSetup, recheckMotionHealth, sceneGenerateDisabledReason, runArdy,
		sceneAgainDisabledReason, runSceneAgain, tlFrame, addSceneBlock, appContext,
		motion, preserveStrength, setPreserveStrength, waypointMode, preserveTracksLine,
		takeRecipe, takeVersions, loadTakeVersion, replayNotices, craneSelectedIndex,
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
		clearMotion,
	} = useStudioShell();
	return (
		<div className="bottom-window">
			<nav className="bottom-window-tabs" aria-label={ko("Bottom window", "하단 창")}>
				<button
					type="button"
					className={bottomTab === "timeline" ? "active" : ""}
					aria-pressed={bottomTab === "timeline"}
					onClick={() => setBottomTab("timeline")}
				>
					{ko("Animation", "애니메이션")}
				</button>
				<button
					type="button"
					className={bottomTab === "assets" ? "active" : ""}
					aria-pressed={bottomTab === "assets"}
					onClick={() => setBottomTab("assets")}
				>
					{ko("Assets", "에셋")}
				</button>
			</nav>
			<div className="assets-pane">
				<AssetPane
					onAssetGrab={beginAssetDrag}
					imageAssetIds={shelfImageIds}
					meshAssetIds={shelfMeshIds}
					manageStorage={manageAssetStorage}
					onManageStorageToggle={() => setManageAssetStorage((current) => !current)}
					unusedAssetIds={unusedAssetIds}
					usedAssetIds={usedAssetIds}
					usageCounts={usageCounts}
					graphSignature={projectAssetGraphSignature}
					trashCount={assetTrash.length}
					onDeleteUnusedAsset={deleteUnusedAsset}
					onUndoDelete={undoDeletedAsset}
					deletingAssetId={deletingAssetId}
					resourceManifest={projectManifest}
				/>
			</div>
			<div className="bottom-timeline">
			{/* ==================== the take bar (contract C12) ====================
			    Two primary edit entries, the take's version strip, and whatever the
			    last replay had to say — all directly above the take they act on,
			    because a feature the artist has to go hunting for in a collapsed
			    foldout is a feature they do not have. */}
			{/* The preview flag lives here TOO, on a node that exists whether or not
		    the Inspector is scrolled to the line-edit panel — it is the stable
		    handle for "the viewport is showing a draft, not the take". */}
		<TakeBarPanel
			linePreviewUrl={linePreviewUrl}
			takeSourceUrl={takeSourceUrl}
			sceneDisabledReason={sceneDisabledReason}
			sceneMenuOpen={sceneMenuOpen}
			setSceneMenuOpen={setSceneMenuOpen}
			refineDisabledReason={refineDisabledReason}
			lineEditMode={lineEditMode}
			enterRefineMode={enterRefineMode}
			readinessState={readinessState}
			bridgeChecking={bridgeChecking}
			openMotionSetup={openMotionSetup}
			recheckMotionHealth={recheckMotionHealth}
			sceneGenerateDisabledReason={sceneGenerateDisabledReason}
			runArdy={runArdy}
			sceneAgainDisabledReason={sceneAgainDisabledReason}
			runSceneAgain={runSceneAgain}
			tlFrame={tlFrame}
			addSceneBlock={addSceneBlock}
			setToast={appContext.notify}
			motion={motion}
			preserveStrength={preserveStrength}
			setPreserveStrength={setPreserveStrength}
			waypointMode={waypointMode}
			preserveTracksLine={preserveTracksLine}
			takeRecipe={takeRecipe}
			takeVersions={takeVersions}
			loadTakeVersion={loadTakeVersion}
			replayNotices={replayNotices}
		/>
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
		</div>
	);
}
