import { useStudioShell } from "./studio-shell-context.js";
import { ko } from "../locale.js";
import { PRESETS, SHOT_ASPECT_PRESETS } from "../app-stage.jsx";
import { CAMERA_PRESETS } from "../camera-move.js";
import { saveAutoColor } from "../auto-color.js";
import { trackFeature } from "../analytics.js";

export default function ViewportToolbar() {
	const {
		workflowMode, selectWorkflowMode, gizmoMode, setGizmoMode, snapEnabled,
		setSnapEnabled, preset, applyPreset, cameraPresetId, falMotionCameraLocked,
		runStudioAction, shotAspectKey, fovDeg, shotsDomain, shot,
		setNonce, workspaceLayout, viewMenuTriggerRef, viewMenuOpen, setViewMenuAnchor,
		setViewMenuOpen, viewLooksActive, viewMenuAnchor, gridView, setGridView,
		autoColor, setAutoColor, isCharacterSelection, partColoursChoice, embedMode,
		agentCollapsed,
	} = useStudioShell();
	return (
		<div className="viewport-titlebar">
		<div className="workflow-mode-switch" role="tablist" aria-label={ko("Workflow", "작업 모드")}>
			{[
				["scene", ko("Scene", "장면"), ko("Place subjects and props", "인물과 소품 배치")],
				["camera", ko("Camera", "카메라"), ko("Frame the shot", "샷 구도 설정")],
				["motion", ko("Motion", "모션"), ko("Edit timing and movement", "타이밍과 움직임 편집")],
				["pose", ko("Pose", "포즈"), ko("Edit the pose with IK", "IK로 포즈 편집")],
			].map(([id, label, hint]) => (
				<button
					type="button"
					role="tab"
					key={id}
					className={workflowMode === id ? "active" : ""}
					aria-selected={workflowMode === id}
					title={hint}
					onClick={() => selectWorkflowMode(id)}
				>
					{label}
				</button>
			))}
		</div>
		<div className="editor-toolbar scene-tools" aria-label={ko("Scene tools", "장면 도구")}>
			{workflowMode === "motion" && (
				<span className="workflow-toolbar-hint" role="status">
					{ko("Motion mode · edit the timeline below", "모션 모드 · 아래 타임라인에서 편집하세요")}
				</span>
			)}
			{workflowMode === "pose" && (
				<span className="workflow-toolbar-hint" role="status">
					{ko("Pose mode · W IK parts · E motion trail · R range pin", "포즈 모드 · W IK 파츠 · E 궤적선 · R 범위 고정")}
				</span>
			)}
				<span className="transform-toolbar-label workflow-scene-context">{ko("Transform", "변환")}</span>
				<div className="tool-switch workflow-scene-context" role="group" aria-label={ko("Transform tools", "변환 도구")} data-transform-controls>
					<button
						type="button"
						className={gizmoMode === "move" ? "active" : ""}
						title={ko("Move tool (W)", "이동 도구 (W)")}
						aria-pressed={gizmoMode === "move"}
						onClick={() => setGizmoMode("move")}
					>
						<svg viewBox="0 0 16 16" aria-hidden="true" className="tool-icon"><path d="M8 1v14M1 8h14" stroke="currentColor" strokeWidth="1.4"/><path d="M8 1 6 3h4L8 1zM8 15l-2-2h4l-2 2zM1 8l2-2v4L1 8zM15 8l-2-2v4l2-2z" fill="currentColor"/></svg>
						{ko("Move", "이동")}
					</button>
					<button
						type="button"
						className={gizmoMode === "rotate" ? "active" : ""}
						title={ko("Rotate tool (E)", "회전 도구 (E)")}
						aria-pressed={gizmoMode === "rotate"}
						onClick={() => setGizmoMode("rotate")}
					>
						<svg viewBox="0 0 16 16" aria-hidden="true" className="tool-icon"><circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M13.4 8l2-2v4l-2 2z" fill="currentColor" transform="rotate(45 13.4 8)"/></svg>
						{ko("Rotate", "회전")}
					</button>
					<button
						type="button"
						className={gizmoMode === "scale" ? "active" : ""}
						title={ko("Scale tool (R)", "크기 도구 (R)")}
						aria-pressed={gizmoMode === "scale"}
						onClick={() => setGizmoMode("scale")}
					>
						<svg viewBox="0 0 16 16" aria-hidden="true" className="tool-icon"><rect x="3" y="3" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M13 13h-4M13 13V9M13 13l-3.5-3.5" stroke="currentColor" strokeWidth="1.4" fill="none"/></svg>
						{ko("Scale", "크기")}
					</button>
				</div>
				<button
					type="button"
					className={"snap-switch workflow-scene-context" + (snapEnabled ? " active" : "")}
					title={ko("Grid snapping — hold Ctrl during a drag to invert", "그리드 스냅 — 드래그 중 Ctrl을 누르면 반대로 작동")}
					aria-pressed={snapEnabled}
					onClick={() => setSnapEnabled((v) => !v)}
				>
					{ko("Snap", "스냅")}
				</button>
				<span className="viewport-toolbar-separator settings-separator workflow-camera-context" aria-hidden="true" />
				<label className="viewport-toolbar-field shot-field workflow-camera-context">
					<span>{ko("Shot", "샷")}</span>
					<select
						aria-label={ko("Shot preset", "샷 프리셋")}
						value={preset}
						onChange={(event) => applyPreset(event.target.value)}
					>
						{Object.entries(PRESETS).map(([key, value]) => (
							<option key={key} value={key}>{value.label}</option>
						))}
					</select>
				</label>
				<label className="viewport-toolbar-field ratio-field workflow-camera-context">
					<span>{ko("Cam", "카메라")}</span>
					<select
						aria-label={ko("Camera preset", "카메라 프리셋")}
						value={cameraPresetId ?? ""}
						disabled={falMotionCameraLocked}
						onChange={(event) => {
							const id = event.target.value;
							if (!id) { runStudioAction("stage.setFilmback", { cameraPresetId: null }); return; }
							runStudioAction("shot.frame", { preset: id });
						}}
					>
						<option value="">{ko("Free", "자유")}</option>
						{Object.values(CAMERA_PRESETS).map((value) => (
							<option key={value.id} value={value.id}>{value.label}</option>
						))}
					</select>
				</label>
				<label className="viewport-toolbar-field ratio-field workflow-camera-context">
					<span>{ko("Ratio", "비율")}</span>
					<select
						aria-label={ko("Output aspect ratio", "출력 화면 비율")}
						value={shotAspectKey}
						onChange={(event) => runStudioAction("stage.setFilmback", { shotAspect: event.target.value })}
					>
						{Object.values(SHOT_ASPECT_PRESETS).map((value) => (
							<option key={value.label} value={value.label}>{value.label}</option>
						))}
					</select>
				</label>
				<label className="viewport-fov-control workflow-camera-context">
					<span>FOV</span>
					<input
						type="range"
						min="14"
						max="90"
						step="1"
						value={fovDeg}
						disabled={falMotionCameraLocked}
						onChange={(event) => shotsDomain.changeLens(Number(event.target.value))}
					/>
					<output>{Math.round(fovDeg)}°</output>
					<small>{shot.focalMm}mm</small>
				</label>
				<span className="viewport-toolbar-spacer workflow-camera-context" />
				<button
					type="button"
					title={ko("Recenter on subject", "피사체 다시 맞추기")}
					aria-label={ko("Recenter on subject", "피사체 다시 맞추기")}
					className="workflow-camera-context"
					onClick={() => setNonce((n) => n + 1)}
				>
					◎
				</button>
				<button
					type="button"
					aria-pressed={!workspaceLayout.insetCollapsed}
					className="workflow-scene-context workflow-camera-context"
					onClick={() => {
						runStudioAction("view.setInset", { collapsed: !workspaceLayout.insetCollapsed });
					}}
				>
					{ko("Top", "탑")} {workspaceLayout.insetCollapsed ? "▸" : "▾"}
				</button>
				{/* One menu for every viewport-look toggle (R4), in every mode:
				    what the stage LOOKS like is not a mode's business. The 27px
				    bar clips its own overflow, so the panel is fixed to the
				    viewport and anchored to the trigger, like the export menu.
				    Items keep the menu open: these are toggles you compare, not
				    commands you fire. */}
				<div className="view-menu-wrap">
					<button
						type="button"
						className="view-menu-trigger"
						data-testid="view-menu-trigger"
						ref={viewMenuTriggerRef}
						aria-haspopup="menu"
						aria-expanded={viewMenuOpen}
						title={ko("Viewport display toggles", "뷰포트 표시 토글")}
						onClick={(event) => {
							const box = event.currentTarget.getBoundingClientRect();
							setViewMenuAnchor({ top: box.bottom + 6, right: Math.max(8, window.innerWidth - box.right) });
							setViewMenuOpen((open) => !open);
						}}
					>
						{ko("View", "보기")}
						<span className="caret">▾</span>
						{viewLooksActive && <span className="view-menu-dot" data-testid="view-menu-dot" aria-hidden="true" />}
					</button>
					{viewMenuOpen && (
						<div
							className="project-menu view-menu"
							role="menu"
							aria-label={ko("Viewport display", "뷰포트 표시")}
							style={{ top: `${viewMenuAnchor.top}px`, right: `${viewMenuAnchor.right}px` }}
						>
							{/* aria-pressed rides along with aria-checked: the toggles
							    published that state contract in their old homes and QA
							    still reads it, so the move keeps the signpost (R9). */}
							<button
								type="button"
								role="menuitemcheckbox"
								className={"view-menu-item grid-view-switch" + (gridView ? " active" : "")}
								aria-checked={gridView}
								aria-pressed={gridView}
								title={ko("Blender-style viewport — dark void with a reference grid instead of the deck", "Blender식 뷰포트 — 데크 대신 어두운 배경과 기준 그리드")}
								onClick={() => setGridView((v) => !v)}
							>
								<span className="view-menu-mark" aria-hidden="true">{gridView ? "✓" : ""}</span>
								{ko("Reference grid", "기준 그리드")}
							</button>
							<button
								type="button"
								role="menuitemcheckbox"
								className={"view-menu-item auto-color-toggle" + (autoColor ? " active" : "")}
								aria-checked={autoColor}
								aria-pressed={autoColor}
								title={ko(
									"Distinct display colors per object — captures include them while on",
									"오브젝트별 구분 색 — 켜둔 동안 캡처에도 포함됩니다",
								)}
								onClick={() => {
									setAutoColor((on) => {
										saveAutoColor(!on);
										trackFeature("auto_color");
										return !on;
									});
								}}
							>
								<span className="view-menu-mark" aria-hidden="true">{autoColor ? "✓" : ""}</span>
								{ko("Auto Color", "자동 색")}
							</button>
							{/* Part colours repaint a BODY, so the section only exists
							    while a character is selected (R2). */}
							{isCharacterSelection && (
								<div className="view-menu-group" role="group" aria-label={ko("Body part colours", "부위 색상")}>
									<span className="view-menu-label" aria-hidden="true">{ko("Body part colours", "부위 색상")}</span>
									{[
										{ value: "off", label: ko("Off", "끕") },
										{ value: "shaded", label: ko("Shaded", "음영") },
										{ value: "flat", label: ko("Flat", "평면") },
									].map((option) => {
										const checked = option.value === partColoursChoice;
										return (
											<button
												type="button"
												key={option.value}
												role="menuitemradio"
												className={"view-menu-item part-colour-option" + (checked ? " active" : "")}
												data-part-colours={option.value}
												aria-checked={checked}
												onClick={() => runStudioAction("view.setPartColours", { mode: option.value })}
											>
												<span className="view-menu-mark" aria-hidden="true">{checked ? "✓" : ""}</span>
												{option.label}
											</button>
										);
									})}
								</div>
							)}
							{/* Panel visibility belongs to the same menu (R4): the
							    agent column is something you show, not a mode, so it
							    gets a checkmark here instead of a topbar button. */}
							{!embedMode && (
								<div className="view-menu-group" role="group" aria-label={ko("Panels", "패널")}>
									<span className="view-menu-label" aria-hidden="true">{ko("Panels", "패널")}</span>
									<button
										type="button"
										role="menuitemcheckbox"
										className={"view-menu-item agent-panel-toggle" + (agentCollapsed ? "" : " active")}
										aria-checked={!agentCollapsed}
										aria-pressed={!agentCollapsed}
										title={ko("Show the agent chat column (Cmd/Ctrl+B)", "에이전트 채팅 열 표시 (Cmd/Ctrl+B)")}
										onClick={() => window.dispatchEvent(new CustomEvent("cozyclay:agent-panel-toggle"))}
									>
										<span className="view-menu-mark" aria-hidden="true">{agentCollapsed ? "" : "✓"}</span>
										{ko("Agent panel", "에이전트 패널")}
									</button>
								</div>
							)}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
