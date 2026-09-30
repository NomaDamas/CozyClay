import Foldout from "./Foldout.jsx";
import { useMotionCommands } from '../domains/motion.js';
import { ko, isKo } from "../locale.js";
import { HIERARCHY_INSPECTOR_TITLES } from "../app-stage.jsx";
import { PhysicsPanel } from "../ardy/physics-panel.jsx";
import { Field } from "../ui.jsx";
import { MotionReadiness } from "../motion-readiness-ui.jsx";
import { RangePinPanel } from "../range-pin-panel.jsx";

export default function RigControlPanel({
	isRigSelection, rigSelection, ikChains, ikFocus, footSnap, ikMode, toggleIkMode,
	collisionCleanupSupported, runFixCollisions, runFixCollisionsRange, motion, autoPhysicsRunning,
	physicsProgress, physicsPreview, physicsShow, physicsOptions, tlFrame, changePhysicsOptions,
	runAutoPhysics, showPhysicsPreview, applyPhysicsPreview, cancelPhysicsPreview, setTlFrame, ikEditTool,
	setIkEditTool, showTrails, setShowTrails, trailFalloffS, setTrailFalloffS, trailEdit, generationBusy,
	bridgeChecking, bridge, runTrailRegeneration, trailReadinessState, openMotionSetup, recheckMotionHealth,
	rangePins = [], rangePinResiduals = new Map(), rangePinSelection = null, rangePinPartPick = null, rangePinPreview = null,
	objects = [],
	setRangePinSelection, setRangePinPartPick, previewRangePinDraft, applyRangePinDraft, deleteRangePin,
}) {
	const { run } = useMotionCommands();
	return (
<Foldout hidden={!isRigSelection} title={ko("Rig Control", "리그 제어")}>
						<p className="inspector-hint">
							{rigSelection && rigSelection.token !== "rig"
							? (isKo ? `${HIERARCHY_INSPECTOR_TITLES[rigSelection.token]}이 활성 제어 그룹입니다.` : `${HIERARCHY_INSPECTOR_TITLES[rigSelection.token]} is the active control group.`)
							: ko("Choose a body group in the hierarchy, then manipulate its handle in the main view.", "계층에서 몸 그룹을 고른 뒤 메인 뷰의 핸들을 조작하세요.")}
						</p>
						<div className="inspector-status-grid">
						<span>{ko("Rig", "리그")}</span><b>{ikChains ? ko("Ready", "준비됨") : ko("Unavailable", "사용 불가")}</b>
						<span>{ko("Focus", "초점")}</span><b>{ikFocus ?? ko("None", "없음")}</b>
						<span>{ko("Foot lock", "발 고정")}</span><b>{footSnap ? ko("ON", "켜짐") : ko("OFF", "꺼짐")}</b>
						</div>
						<button type="button" className={"btn full" + (ikMode ? " primary" : "")} onClick={toggleIkMode} disabled={!ikChains}>
						{ikMode ? ko("Finish rig editing", "리그 편집 끝내기") : ko("Edit rig with IK", "IK로 리그 편집")}
						</button>
						{/* Self-collision cleanup. Hidden outright on a rig whose capsule
						    proxies cannot be built: a button whose only answer is "not
						    supported" is worse than no button, and the hint below would
						    be describing something that cannot happen. */}
						{collisionCleanupSupported && (
							<>
								<button type="button" className="btn full" onClick={() => run('motion.fixCollisions', { scope: 'frame' })} disabled={!ikChains}>
								{ko("Fix body collisions (this frame)", "콜리전 수정 (이 프레임)")}
								</button>
								<button type="button" className="btn full" onClick={() => run('motion.fixCollisions', { scope: 'clip' })} disabled={!ikChains || !motion}>
								{ko("Fix body collisions (whole clip)", "콜리전 수정 (클립 전체)")}
								</button>
								<p className="inspector-hint">
								{ko("Pushes interpenetrating body parts apart with IK and keys the fix. Whole clip walks the loaded motion and keys only the frames that changed.", "콜리전 수정은 겹쳐 들어간 신체 파츠를 IK로 밀어내고 그 결과를 키로 남깁니다. 클립 전체는 로드된 모션을 훑으며 실제로 고쳐진 프레임만 키를 찍습니다.")}
								</p>
							</>
						)}
						{/* AutoPhysics needs the hips FK joint and the mass-model bones,
						    NOT the collision capsules — a rig without toe bases still
						    qualifies, so this button is deliberately outside the
						    collisionCleanupSupported gate. Unsupported rigs get an
						    explanatory toast from the handler. */}
						<PhysicsPanel ko={ko} disabled={!ikChains || !motion} running={autoPhysicsRunning} progress={physicsProgress}
							preview={physicsPreview} show={physicsShow} options={physicsOptions} frame={tlFrame} frames={motion?.frames ?? 1}
							onOptions={changePhysicsOptions} onRun={runAutoPhysics} onShow={showPhysicsPreview}
							onApply={applyPhysicsPreview} onCancel={cancelPhysicsPreview} onFrame={setTlFrame} />
						{/* Motion trail editing: falloff radius + confirm-to-regenerate.
						    Only meaningful with IK mode on and a loaded take. */}
						{ikMode && (
							<>
								<div className="segmented ik-edit-tools" data-active={ikEditTool}>
										<button
										type="button"
										className={ikEditTool === "ik" ? "active" : ""}
										aria-pressed={ikEditTool === "ik"}
										onClick={() => setIkEditTool("ik")}
									>
										{ko("IK 파츠 편집", "IK parts")}
									</button>
									<button
										type="button"
										className={ikEditTool === "trail" ? "active" : ""}
										aria-pressed={ikEditTool === "trail"}
											disabled={!showTrails}
											onClick={() => setIkEditTool("trail")}
										>
											{ko("궤적선 편집", "Motion trail")}
										</button>
										<button
											type="button"
											data-testid="range-pin-tool"
											className={ikEditTool === "pin" ? "active" : ""}
											aria-pressed={ikEditTool === "pin"}
											disabled={!motion}
											onClick={() => { setIkEditTool("pin"); setRangePinPartPick?.(null); }}
										>
											{ko("Range pin", "범위 고정")}
										</button>
								</div>
								<p className="inspector-hint">
								{ikEditTool === "ik"
										? ko("파츠를 직접 잡아 손·발·팔꿈치·무릎을 세밀하게 수정합니다. 궤적선은 안내선으로만 표시됩니다.", "Grab a body part for detailed IK editing. Trails are guides only.")
									: ikEditTool === "pin" ? ko("Choose a hand or foot and the frame range to pin.", "손이나 발과 프레임 범위를 선택해 고정합니다.")
									: ko("궤적선을 잡아 여러 프레임의 이동을 함께 수정합니다. 파츠 핸들은 잠시 잠겨 겹침을 막습니다.", "Grab a trail to edit a range of frames. IK handles are locked to avoid overlapping picks.")}
							</p>
							{ikEditTool === "pin" && (
								<RangePinPanel
									active={ikMode && ikEditTool === "pin"}
									motion={motion}
									frame={tlFrame}
									frameCount={motion?.frames ?? 1}
									fps={motion?.fps ?? 24}
									pins={rangePins}
									residuals={rangePinResiduals}
									objects={objects}
									selectedPinId={rangePinSelection}
									partPick={rangePinPartPick}
									conflictFrames={rangePinPreview?.conflictFrames ?? []}
									overlapError={rangePinPreview?.overlapError ?? ""}
									onSelectPin={(id) => { setRangePinSelection?.(id); if (id) setIkEditTool("pin"); }}
									onApply={applyRangePinDraft}
									onCancel={() => { setRangePinSelection?.(null); setIkEditTool("ik"); }}
									onDelete={deleteRangePin}
									onPreviewTarget={previewRangePinDraft}
								/>
							)}
								{ikEditTool !== "pin" && <>
								<button
									type="button"
									className={"btn full" + (!showTrails ? " muted" : "")}
									aria-pressed={showTrails}
									onClick={() => {
										setShowTrails((value) => !value);
										setIkEditTool("ik");
									}}
								>
									{ko(`궤적선 ${showTrails ? "표시" : "숨김"}`, `Trails ${showTrails ? "on" : "off"}`)}
								</button>
								<Field label={ko("Trail falloff", "궤적 영향 범위")}>
									<div className="trail-falloff-row">
										<input
											type="range"
											min={0.1}
											max={2}
											step={0.1}
											value={trailFalloffS}
											onChange={(event) => setTrailFalloffS(Number(event.target.value))}
										/>
										<span className="trail-falloff-value">{trailFalloffS.toFixed(1)}s</span>
									</div>
								</Field>
								<button
									type="button"
									className="btn primary full trail-regenerate"
									disabled={!trailEdit || !motion?.url || generationBusy || bridgeChecking || bridge === null}
									title={!trailEdit
										? ko("Drag the trajectory line in the viewport first", "먼저 뷰포트에서 궤적선을 끌어 수정하세요")
										: !motion?.url
											? ko("The take has no bridge source to regenerate from", "재생성할 브리지 원본이 없는 테이크예요")
											: ""}
									onClick={runTrailRegeneration}
								>
									{ko("Regenerate from trail edit", "궤적 수정으로 재생성")}
								</button>
								<MotionReadiness state={trailReadinessState} checking={bridgeChecking} onSetup={() => openMotionSetup("trail")} onRetry={recheckMotionHealth} />
								<p className="inspector-hint">
									{ko(
										"Grab any point of the trajectory line to bend the motion; nearby frames follow within the falloff range. Confirm to regenerate that span with Kimodo — explicit IK keys stay pinned exactly.",
										"궤적선의 아무 지점이나 잡아 끌면 영향 범위 안의 주변 프레임이 함께 따라와요. 재생성을 누르면 그 구간을 Kimodo가 다시 생성하고, 명시적으로 잡은 IK 키는 정확히 고정됩니다.",
									)}
								</p>
								</>}
							</>
						)}
					</Foldout>
	);
}
