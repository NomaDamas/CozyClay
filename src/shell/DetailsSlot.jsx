import { useStudioShell } from "./studio-shell-context.js";
import { ko } from "../locale.js";
import { sceneObjectNameDisplayKo, HIERARCHY_INSPECTOR_TITLES, CHARACTER_MODEL_LABELS } from "../app-stage.jsx";
import { CUTOUT_KIND } from "../scene-objects.js";
import LightPanel from "../panels/LightPanel.jsx";
import CameraPanel from "../panels/CameraPanel.jsx";
import SubjectsPanel from "../panels/SubjectsPanel.jsx";
import CharacterTransformPanel from "../panels/CharacterTransformPanel.jsx";
import RigPanel from "../panels/RigPanel.jsx";
import CapsulePanel from "../panels/CapsulePanel.jsx";
import PosePanel from "../panels/PosePanel.jsx";
import VideoCapturePanel from "../panels/VideoCapturePanel.jsx";
import PromptBlocksPanel from "../panels/PromptBlocksPanel.jsx";
import RigControlPanel from "../panels/RigControlPanel.jsx";
import EnvironmentPanel from "../panels/EnvironmentPanel.jsx";
import PropsPanel from "../panels/PropsPanel.jsx";
import ObjectTransformPanel from "../panels/ObjectTransformPanel.jsx";
import { ASSET_IMAGE_TYPES } from "../scene-assets.js";
import { PoseStudioPanel } from "../posestudio.jsx";
import { DEFAULT_POSE } from "../poses.js";
import "../panels/details.css";

const characterIndexForRow = (rowId, characters) => rowId === "characterA" ? 0
	: rowId === "characterB" ? 1
		: characters.findIndex((entry) => `character:${entry.id}` === rowId);
const characterTitle = (index) => ko(`Character ${index + 1}`, `인물 ${index + 1}`);

/** The 2a selection header: the selected item's name and a "Kind · detail"
 * type line. Null when nothing that owns settings is selected. */
function detailsSelection({ selectedHierarchyId: id, selectedSceneObject, rigSelection, characters, shot, inspectorHasContent }) {
	if (!inspectorHasContent) return null;
	if (selectedSceneObject) {
		const kind = selectedSceneObject.renderer === CUTOUT_KIND ? ko("Cutout", "컷아웃") : ko("Mesh", "메시");
		return { name: sceneObjectNameDisplayKo(selectedSceneObject.name), type: `${ko("Prop", "소품")} · ${kind}` };
	}
	if (rigSelection) {
		const index = characterIndexForRow(rigSelection.rowId, characters);
		const kind = rigSelection.token === "rig" ? ko("Rig", "리그") : ko("Bone", "본");
		return { name: HIERARCHY_INSPECTOR_TITLES[rigSelection.token] ?? kind, type: index >= 0 ? `${kind} · ${characterTitle(index)}` : kind };
	}
	if (id === "camera") return { name: HIERARCHY_INSPECTOR_TITLES.camera, type: `${ko("Camera", "카메라")} · ${shot.focalMm}mm` };
	if (id === "characterA" || id === "characterB" || id.startsWith("character:")) {
		const index = characterIndexForRow(id, characters);
		const model = CHARACTER_MODEL_LABELS[characters[index]?.model];
		return { name: characterTitle(Math.max(index, 0)), type: model ? `${ko("Character", "인물")} · ${model}` : ko("Character", "인물") };
	}
	const types = {
		shot: ko("Scene", "장면"),
		light: ko("Light", "조명"),
		characters: ko("Folder", "폴더"),
		environment: ko("Environment", "환경"),
		props: ko("Folder", "폴더"),
	};
	return { name: HIERARCHY_INSPECTOR_TITLES[id] ?? ko("Selection", "선택 항목"), type: types[id] ?? "" };
}

export default function DetailsSlot() {
	const {
		selectedHierarchyId, sceneSaveError, studioAgentError, embedMode, studioAgentMode,
		setStudioAgentMode, AgentPanel, setAgentCollapsed, scenes, activeSceneId,
		buildStudioAgentContext, highlightAgentTargets, generateI2vMotionFromUi, selectedSceneObject, rigSelection,
		inspectorActionsOpen, setInspectorActionsOpen, runStudioAction, deleteSelectedSceneObject, inspectorHasContent,
		keyLightSelected, keyLight, isCameraSelection,
		shot, moveSequence, cameraKeys, activeShot,
		isCharacterSelection, showB, characters, openStudio,
		posing, workflowMode, activeChar,
		activeCharIndex, i2vMotionModel, i2vMotionActions, setI2vMotionStudioOpen,
		selectablePoses, ikMode, ikApplyPoseAsKey, motion, setStudioPick,
		appContext, removePose, setPhotoPoseError, photoPoseFileRef, photoPoseState,
		photoPoseError, activeRig, saveCurrentPose, multiModelStatus, multiModelStage,
		multiModelFileRef, chooseMultiModelFile, multiModelSource, multiModelUrl, setMultiModelUrl,
		useMultiModelUrl, pasteMultiModelUrl, multiModelProgress, multiModelError, multiModelFootage,
		extractMultiModelMotion, multiModelExtract, multiModelTake, multiModelExtractProgress, multiModelExtractError,
		bridge, promptBlocksReveal, promptClips, selectedPromptId, setSelectedPromptId,
		setArdyPrompt, setTlFrame, tlFrameCount, ardySeed,
		changeArdySeed, lineEditMode, toggleLineEditMode, linePreviewUrl, lineCurve,
		lineDrifted, lineTrack, setLineTrack, linePinMode, setLinePinMode,
		linePins, lineClipFrames, lineEditRange, setLineRange, lineRadius,
		changeLineRadius, lineCurveDirty, lineEditFrom, lineEditTo, lineCurvePointCount,
		lineDriftHint, lineCurveHidden, linePreviewBusy, linePreviewMs, linePreviewError,
		generationBusy, bridgeChecking, lineReadinessState, runLineEdit, openMotionSetup,
		recheckMotionHealth, resetLineCurve, exitLineEditMode, readinessState, ardyRunning,
		cancelArdy, ardyStatus, ardyOutcome, tlFrame,
		isRigSelection, ikChains, ikFocus, footSnap, collisionCleanupSupported,
		autoPhysicsRunning, physicsProgress, physicsPreview,
		physicsShow, physicsOptions, platformFitRunning, platformFitProgress, platformFitLast,
		platformFitApplied, changePhysicsOptions, runAutoPhysics, showPhysicsPreview, applyPhysicsPreview,
		cancelPhysicsPreview, ikEditTool, setIkEditTool, showTrails, setShowTrails,
		trailFalloffS, setTrailFalloffS, trailEdit, trailTrackFocus, selectTrailTrack, clearTrailTrackFocus, runTrailRegeneration, trailReadinessState,
		pendingIkEdit, applyPendingIkEdit, cancelPendingIkEdit,
		rangePins, rangePinResiduals, rangePinSelection, rangePinPartPick, rangePinPreview,
		sceneObjects, setRangePinSelection, setRangePinPartPick, previewRangePinDraft, applyRangePinDraft,
		deleteRangePin, hasEnvSheet, environment, style, environmentImage,
		inspectorDrop, cutoutInputRef, meshInputRef, importCutout,
		importMesh, selectHierarchy, snapEnabled, setSnapEnabled,
		attachTargetLabel, beginSceneTransaction, endSceneTransaction,
		matteCanvasRef, matteStats, matteMode, setMatteMode, matteEditorRef,
		matteTolerance, setMatteTolerance, matteBrush, setMatteBrush, matteShrink,
		setMatteShrink, matteFeather, setMatteFeather, matteBusy,
		autoColor, recentObjectColors, rememberSceneObjectColor, objectColorDraft, setObjectColorDraft,
		posePhotoFile, posingIndex, posingChar, charA, allPoses,
		studioPick, posingClosing, closeStudio, castDomain, setToast,
		savePose, beginWorkspaceResize,
	} = useStudioShell();
	const selection = detailsSelection({ selectedHierarchyId, selectedSceneObject, rigSelection, characters, shot, inspectorHasContent });
	return (
		<aside className="panel hierarchy-sidebar inspector-sidebar" data-inspector={selectedHierarchyId}>
			{/* Save failures live above the tab content, not inside the Props
			    card: that card is hidden whenever any hierarchy node is
			    selected, and saves fire exactly while objects are being
			    edited — the one case where a failure line inside it is
			    invisible. As a sibling of the tab panes this line stays
			    on screen for every selection and every tab until the
			    next successful write clears it (plan §8.4); the one-shot
			    toast still announces each failure episode. */}
			{sceneSaveError && (
				<p className="scene-save-error" role="status">
					{sceneSaveError}
				</p>
			)}
			{studioAgentError && <p className="scene-save-error" role="alert">{studioAgentError}</p>}
			{/* #570: the Agent no longer replaces Details. It docks under it in
			    the right column, and Window › Agent folds it away again. */}
			<section className="inspector-pane">
			<div className="inspector-heading details-panel-head">
				{/* #570: the selection is the panel's title; "Details" only
				    names an empty panel. */}
				{selection ? (
					<div className="details-selection" data-testid="details-selection">
						<span className="details-selection-name inspector-heading-selection">{selection.name}</span>
						{selection.type && <span className="details-selection-type">{selection.type}</span>}
					</div>
				) : <strong className="details-panel-title">{ko("Details", "세부 정보")}</strong>}
				{selectedSceneObject && (
					<div className="inspector-actions-wrap">
						<button
							type="button"
							className="inspector-actions-trigger"
							aria-label={ko("Object actions", "오브젝트 작업")}
							aria-expanded={inspectorActionsOpen}
							onClick={() => setInspectorActionsOpen((open) => !open)}
						>
							⋮
						</button>
						{inspectorActionsOpen && (
							<div className="inspector-actions-menu" role="menu">
								<button type="button" role="menuitem" onClick={() => { runStudioAction("object.duplicate"); setInspectorActionsOpen(false); }}>
									{ko("Duplicate", "복제")}
								</button>
								<button type="button" role="menuitem" onClick={() => { deleteSelectedSceneObject(); setInspectorActionsOpen(false); }}>
									{ko("Delete", "삭제")}
								</button>
							</div>
						)}
					</div>
				)}
			</div>
			<div className="inspector-scroll">
		{/* Nothing is selected that owns settings — say so rather than
		    showing an empty column the user has to interpret. */}
		{!inspectorHasContent && (
			<p className="inspector-empty" data-inspector-empty role="status">
				{ko(
					"Select something in the hierarchy — the scene, the camera, a character, the environment or a prop — and its settings appear here.",
					"계층에서 항목을 고르면 — 씨, 카메라, 캐릭터, 환경, 소품 — 그 설정이 여기 나타납니다.",
				)}
			</p>
		)}
		{/* Shot TYPE presets live in the viewport toolbar dropdown — not
			    duplicated here. */}

			{/* Camera animation is authored against the same playhead as motion,
			    so keep its controls beside the Motion tools as well as Shot setup. */}
			<LightPanel keyLightSelected={keyLightSelected} keyLight={keyLight} />
			{/* Lens, Recenter and Record used to live here as well as in the
			    viewport camera bar and the topbar Export menu. One home each
			    (#193, R1): framing is the bar's job, delivery is Export's, and
			    selecting the camera now switches to Camera mode so the bar's
			    controls are on screen when this panel opens. */}
			<CameraPanel isCameraSelection={isCameraSelection} shot={shot} moveSequence={moveSequence} cameraKeys={cameraKeys} activeShot={activeShot} />

		<SubjectsPanel
			isCharacterSelection={isCharacterSelection}
			showB={showB}
			characters={characters}
			openStudio={openStudio}
			posing={posing}
		/>

		{/* Scene mode: the viewport gizmo and Move/Rotate/Scale are the primary
		    path, so the numeric form starts folded (R5). Motion mode hides
		    those tools, so the same foldout becomes the open Placement row —
		    where the body stands on stage, which is all Motion can restage.
		    Foldout reads defaultOpen once, so the key remounts it per mode. */}
		<CharacterTransformPanel
			workflowMode={workflowMode}
			isCharacterSelection={isCharacterSelection}
			activeChar={activeChar}
		/>

		{/* Rig and Pose are chosen once when a character is cast and then left
		    alone, so they open on demand — Subject and Prompt are the panels
		    you actually work in. */}
		<RigPanel
			isCharacterSelection={isCharacterSelection}
			activeChar={activeChar}
		/>

		<CapsulePanel
			isCharacterSelection={isCharacterSelection}
			activeChar={activeChar}
		/>

		<PosePanel
			isCharacterSelection={isCharacterSelection}
			activeCharIndex={activeCharIndex}
			i2vMotionModel={i2vMotionModel}
			i2vMotionActions={i2vMotionActions}
			setI2vMotionStudioOpen={setI2vMotionStudioOpen}
			selectablePoses={selectablePoses}
			activeChar={activeChar}
			ikMode={ikMode}
			ikApplyPoseAsKey={ikApplyPoseAsKey}
			motion={motion}
			setStudioPick={setStudioPick}
			setToast={appContext.notify}
			removePose={removePose}
			setPhotoPoseError={setPhotoPoseError}
			photoPoseFileRef={photoPoseFileRef}
			photoPoseState={photoPoseState}
			photoPoseError={photoPoseError}
			activeRig={activeRig}
			saveCurrentPose={saveCurrentPose}
		/>

		<VideoCapturePanel
			isCharacterSelection={isCharacterSelection}
			multiModelStatus={multiModelStatus}
			multiModelStage={multiModelStage}
			multiModelFileRef={multiModelFileRef}
			chooseMultiModelFile={chooseMultiModelFile}
			multiModelSource={multiModelSource}
			multiModelUrl={multiModelUrl}
			setMultiModelUrl={setMultiModelUrl}
			useMultiModelUrl={useMultiModelUrl}
			pasteMultiModelUrl={pasteMultiModelUrl}
			multiModelProgress={multiModelProgress}
			multiModelError={multiModelError}
			multiModelFootage={multiModelFootage}
			extractMultiModelMotion={extractMultiModelMotion}
			multiModelExtract={multiModelExtract}
			multiModelTake={multiModelTake}
			multiModelExtractProgress={multiModelExtractProgress}
			multiModelExtractError={multiModelExtractError}
			activeChar={activeChar}
			bridge={bridge}
		/>
		<PromptBlocksPanel
			isCharacterSelection={isCharacterSelection}
			promptBlocksReveal={promptBlocksReveal}
			promptClips={promptClips}
			selectedPromptId={selectedPromptId}
			setSelectedPromptId={setSelectedPromptId}
			setArdyPrompt={setArdyPrompt}
			setTlFrame={setTlFrame}
			tlFrameCount={tlFrameCount}
			ardySeed={ardySeed}
			changeArdySeed={changeArdySeed}
			motion={motion}
			lineEditMode={lineEditMode}
			toggleLineEditMode={toggleLineEditMode}
			linePreviewUrl={linePreviewUrl}
			lineCurve={lineCurve}
			lineDrifted={lineDrifted}
			lineTrack={lineTrack}
			setLineTrack={setLineTrack}
			linePinMode={linePinMode}
			setLinePinMode={setLinePinMode}
			linePins={linePins}
			lineClipFrames={lineClipFrames}
			lineEditRange={lineEditRange}
			setLineRange={setLineRange}
			lineRadius={lineRadius}
			changeLineRadius={changeLineRadius}
			lineCurveDirty={lineCurveDirty}
			lineEditFrom={lineEditFrom}
			lineEditTo={lineEditTo}
			lineCurvePointCount={lineCurvePointCount}
			lineDriftHint={lineDriftHint}
			lineCurveHidden={lineCurveHidden}
			linePreviewBusy={linePreviewBusy}
			linePreviewMs={linePreviewMs}
			linePreviewError={linePreviewError}
			generationBusy={generationBusy}
			bridgeChecking={bridgeChecking}
			bridge={bridge}
			lineReadinessState={lineReadinessState}
			runLineEdit={runLineEdit}
			openMotionSetup={openMotionSetup}
			recheckMotionHealth={recheckMotionHealth}
			resetLineCurve={resetLineCurve}
			exitLineEditMode={exitLineEditMode}
			readinessState={readinessState}
			ardyRunning={ardyRunning}
			cancelArdy={cancelArdy}
			ardyStatus={ardyStatus}
			ardyOutcome={ardyOutcome}
		/>

			<RigControlPanel
				isRigSelection={isRigSelection}
				rigSelection={rigSelection}
				ikChains={ikChains}
				ikFocus={ikFocus}
				footSnap={footSnap}
				ikMode={ikMode}
				collisionCleanupSupported={collisionCleanupSupported}
				motion={motion}
				autoPhysicsRunning={autoPhysicsRunning}
				physicsProgress={physicsProgress}
				physicsPreview={physicsPreview}
				physicsShow={physicsShow}
				physicsOptions={physicsOptions}
				platformFitRunning={platformFitRunning}
				platformFitProgress={platformFitProgress}
				platformFitLast={platformFitLast}
				platformFitApplied={platformFitApplied}
				tlFrame={tlFrame}
				changePhysicsOptions={changePhysicsOptions}
				runAutoPhysics={runAutoPhysics}
				showPhysicsPreview={showPhysicsPreview}
				applyPhysicsPreview={applyPhysicsPreview}
				cancelPhysicsPreview={cancelPhysicsPreview}
				setTlFrame={setTlFrame}
				ikEditTool={ikEditTool}
				setIkEditTool={setIkEditTool}
				showTrails={showTrails}
				setShowTrails={setShowTrails}
				trailFalloffS={trailFalloffS}
				setTrailFalloffS={setTrailFalloffS}
				trailEdit={trailEdit}
				trailTrackFocus={trailTrackFocus}
				selectTrailTrack={selectTrailTrack}
				clearTrailTrackFocus={clearTrailTrackFocus}
				pendingIkEdit={pendingIkEdit}
				applyPendingIkEdit={applyPendingIkEdit}
				cancelPendingIkEdit={cancelPendingIkEdit}
				generationBusy={generationBusy}
				bridgeChecking={bridgeChecking}
				bridge={bridge}
				runTrailRegeneration={runTrailRegeneration}
				trailReadinessState={trailReadinessState}
				openMotionSetup={openMotionSetup}
				recheckMotionHealth={recheckMotionHealth}
				rangePins={rangePins}
				rangePinResiduals={rangePinResiduals}
				rangePinSelection={rangePinSelection}
				rangePinPartPick={rangePinPartPick}
				rangePinPreview={rangePinPreview}
				objects={sceneObjects}
				setRangePinSelection={setRangePinSelection}
				setRangePinPartPick={setRangePinPartPick}
				previewRangePinDraft={previewRangePinDraft}
				applyRangePinDraft={applyRangePinDraft}
				deleteRangePin={deleteRangePin}
			/>

		<EnvironmentPanel
			selectedHierarchyId={selectedHierarchyId}
			hasEnvSheet={hasEnvSheet}
			environment={environment}
			style={style}
			environmentImage={environmentImage}
			setToast={appContext.notify}
		/>

		<PropsPanel
			selectedHierarchyId={selectedHierarchyId}
			inspectorDrop={inspectorDrop}
			cutoutInputRef={cutoutInputRef}
			meshInputRef={meshInputRef}
			importCutout={importCutout}
			importMesh={importMesh}
			sceneObjects={sceneObjects}
			selectHierarchy={selectHierarchy}
		/>

		<ObjectTransformPanel
			selectedSceneObject={selectedSceneObject}
			snapEnabled={snapEnabled}
			setSnapEnabled={setSnapEnabled}
			attachTargetLabel={attachTargetLabel}
			sceneObjects={sceneObjects}
			beginSceneTransaction={beginSceneTransaction}
			endSceneTransaction={endSceneTransaction}
			matteCanvasRef={matteCanvasRef}
			matteStats={matteStats}
			matteMode={matteMode}
			setMatteMode={setMatteMode}
			matteEditorRef={matteEditorRef}
			matteTolerance={matteTolerance}
			setMatteTolerance={setMatteTolerance}
			matteBrush={matteBrush}
			setMatteBrush={setMatteBrush}
			matteShrink={matteShrink}
			setMatteShrink={setMatteShrink}
			matteFeather={matteFeather}
			setMatteFeather={setMatteFeather}
			matteBusy={matteBusy}
			autoColor={autoColor}
			recentObjectColors={recentObjectColors}
			rememberSceneObjectColor={rememberSceneObjectColor}
			objectColorDraft={objectColorDraft}
			setObjectColorDraft={setObjectColorDraft}
		/>
			</div>
			{selectedSceneObject && (
				<div className="inspector-footer">
					<span>{ko("Delete or Backspace to remove", "Delete 또는 Backspace로 삭제")}</span>
				</div>
			)}
			</section>
			{/* #570: the Agent always sits at the foot of the right column.
			    Collapsed it is one 44px bar; Window › Agent, Cmd/Ctrl+B and
			    the bar's own chevron fold it open and shut. */}
			{!embedMode && !studioAgentMode && (
				<button
					type="button"
					className="studio-agent-bar"
					data-testid="studio-agent-bar"
					aria-expanded="false"
					title={ko("Open Agent (Cmd/Ctrl+B)", "에이전트 열기 (Cmd/Ctrl+B)")}
					onClick={() => setStudioAgentMode(true)}
				>
					<svg className="studio-agent-spark" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.25c.4 2.9 1.85 4.35 4.75 4.75-2.9.4-4.35 1.85-4.75 4.75-.4-2.9-1.85-4.35-4.75-4.75 2.9-.4 4.35-1.85 4.75-4.75z M12.75 11.5v2.5 M11.5 12.75H14" /></svg>
					<span className="studio-agent-bar-title">{ko("Agent", "에이전트")}</span>
					<span className="studio-agent-bar-hint">{ko("Ask the agent…", "에이전트에게 요청하기…")}</span>
					<svg viewBox="0 0 10 10" aria-hidden="true"><path d="m2.5 6 2.5-2.5L7.5 6" /></svg>
				</button>
			)}
			{!embedMode && <div className="studio-agent-inspector" hidden={!studioAgentMode}>
				<div
					className="workspace-splitter shell-splitter shell-agent-splitter"
					role="separator"
					aria-orientation="horizontal"
					aria-label={ko("Resize Details and Agent", "세부 정보와 에이전트 크기 조절")}
					onPointerDown={(event) => beginWorkspaceResize("agent", event)}
				/>
				<button
					type="button"
					className="studio-agent-collapse"
					aria-expanded="true"
					aria-label={ko("Collapse Agent", "에이전트 접기")}
					title={ko("Collapse Agent (Cmd/Ctrl+B)", "에이전트 접기 (Cmd/Ctrl+B)")}
					onClick={() => setStudioAgentMode(false)}
				>
					<svg viewBox="0 0 10 10" aria-hidden="true"><path d="m2.5 4 2.5 2.5L7.5 4" /></svg>
				</button>
				<AgentPanel embedded hidden={!studioAgentMode} surface="studio" defaultCollapsed onCollapsedChange={setAgentCollapsed}
					sceneName={scenes.find((entry) => entry.id === activeSceneId)?.name ?? ko("Untitled Scene", "제목 없는 씬")}
					buildContext={buildStudioAgentContext} onReceipt={highlightAgentTargets}
					onI2vAction={(instruction) => void generateI2vMotionFromUi(instruction)} />
			</div>}
			{/* The reference-photo picker sits outside the panel so re-mounting
			    the studio cannot cancel an in-flight read. */}
			<input
				ref={photoPoseFileRef}
				className="multimodel-file-input"
				type="file"
				accept={ASSET_IMAGE_TYPES.join(",")}
				data-pose-photo-input
				onChange={(event) => {
					const file = event.target.files?.[0];
					event.target.value = ""; // the same photo must be re-pickable after an error
					if (file) posePhotoFile(file);
				}}
			/>
			{/* Pose Studio docks under the inspector instead of floating over
			    the shot: the viewport keeps the posed character unobstructed. */}
			{posing && (
				<PoseStudioPanel
					docked
					subject={posingIndex >= 0 ? posingIndex + 1 : 1}
					model={posingChar?.model ?? charA.model}
					poses={allPoses}
					selectedId={studioPick}
					closing={posingClosing}
					motionActive={Boolean(motion)}
					ikCorrection={ikMode && Boolean(motion) && posingChar?.id === activeChar.id}
					onSelect={setStudioPick}
					onApply={(selectedPoseId) => {
						const pose = selectablePoses.find((p) => p.id === selectedPoseId);
						if (pose) {
							// IK mode over a take, on the active character: key the
							// pose as a correction instead of erasing the motion.
							if (ikMode && posingChar?.id === activeChar.id && ikApplyPoseAsKey(pose)) {
								closeStudio();
								return;
							}
							const hadMotion = Boolean(motion);
							if (posingChar) castDomain.run('character.setPose', { characterId: posingChar.id, pose: pose.id, clearMotion: hadMotion });
							closeStudio();
							setToast(hadMotion ? ko("Cleared the current motion and applied the pose", "현재 모션을 지우고 포즈를 적용했어요") : ko("Pose applied", "포즈를 적용했어요"));
						} else {
							setToast(ko("Couldn't find the selected pose — pick again", "선택한 포즈를 찾지 못했어요. 다시 골라 주세요"));
						}
					}}
					onReset={() => {
						if (posingChar) castDomain.run('character.setPose', { characterId: posingChar.id, pose: DEFAULT_POSE.id, clearMotion: Boolean(motion) });
						setStudioPick(DEFAULT_POSE.id);
						setToast(ko("Back to the default pose", "기본 포즈로 돌아왔어요"));
					}}
					onSave={savePose}
					onPhoto={() => {
						setPhotoPoseError("");
						photoPoseFileRef.current?.click();
					}}
					photoState={photoPoseState}
					photoError={photoPoseError}
					onDelete={removePose}
					onClose={closeStudio}
				/>
			)}
		</aside>
	);
}
