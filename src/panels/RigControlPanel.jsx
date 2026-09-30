import { useEffect } from "react";
import Foldout from "./Foldout.jsx";
import { useStudioShell } from "../shell/studio-shell-context.js";
import { useMotionCommands } from "../domains/motion.js";
import { ko, isKo } from "../locale.js";
import { HIERARCHY_INSPECTOR_TITLES } from "../app-stage.jsx";
import { PhysicsPanel } from "../ardy/physics-panel.jsx";
import { Field } from "../ui.jsx";
import { MotionReadiness } from "../motion-readiness-ui.jsx";
import { RangePinPanel } from "../range-pin-panel.jsx";
import { PlatformFitPanel } from "../ardy/platform-fit-panel.jsx";
import "../ardy/auto-fix-panel.css";
import "./pose.css";

export default function RigControlPanel({
 isRigSelection, rigSelection, ikChains, ikFocus, footSnap, ikMode,
 collisionCleanupSupported, motion, autoPhysicsRunning, physicsProgress, physicsPreview,
 physicsShow, physicsOptions, tlFrame, changePhysicsOptions, runAutoPhysics, showPhysicsPreview,
 applyPhysicsPreview, cancelPhysicsPreview, setTlFrame, platformFitRunning, platformFitProgress,
 platformFitLast, platformFitApplied, ikEditTool, setIkEditTool, showTrails, setShowTrails,
 trailFalloffS, setTrailFalloffS, trailEdit, generationBusy, bridgeChecking, bridge,
 runTrailRegeneration, trailReadinessState, openMotionSetup, recheckMotionHealth,
 rangePins = [], rangePinResiduals = new Map(), rangePinSelection = null, rangePinPartPick = null,
 rangePinPreview = null, objects = [], setRangePinSelection, setRangePinPartPick,
 previewRangePinDraft, applyRangePinDraft, deleteRangePin,
}) {
 const { run } = useMotionCommands();
 const shell = useStudioShell();
 useEffect(() => {
  const preview = platformFitLast && !platformFitApplied && platformFitLast.candidate;
  const physics = physicsPreview && !preview;
  if (preview) {
   shell?.setStatusText?.(ko("Platform fit preview — review before applying", "발판 맞춤 미리보기 — 적용 전에 확인하세요"));
   const next = (platformFitLast.steps ?? []).map((step) => ({ start: step.start, end: step.end, kind: "body" }));
   shell?.setPreviewRanges?.((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
  } else if (physics) {
   shell?.setStatusText?.(ko("Physics cleanup preview — review before applying", "물리 정리 미리보기 — 적용 전에 확인하세요"));
   const next = (physicsPreview.changedFrames ?? []).map((frame) => ({ start: frame, end: frame, kind: "body" }));
   shell?.setPreviewRanges?.((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
  } else if (!platformFitRunning) {
   shell?.setStatusText?.(""); shell?.setPreviewRanges?.((current) => current.length ? [] : current);
  }
 }, [platformFitLast, platformFitApplied, platformFitRunning, physicsPreview, shell]);
 const activeTool = ikEditTool === "trail" ? "Path fix" : ikEditTool === "pin" ? "Pin" : "IK";
 return <Foldout hidden={!isRigSelection} title={ko("Pose", "포즈")}>
  <div className="pose-details" data-testid="pose-details">
   <section className="pose-section">
    <h4>{ko("Pose", "포즈")}</h4>
    <div className="pose-row"><span>{ko("Foot lock", "발 고정")}</span><b>{footSnap ? ko("On", "켜짐") : ko("Off", "꺼짐")}</b></div>
    <div className="pose-row"><span>{ko("Body contact", "몸 접촉")}</span><b>{ikChains ? ko("Ready", "준비됨") : ko("Unavailable", "사용 불가")}</b></div>
    <div className="pose-row"><span>{ko("Influence", "영향")}</span><b>{ikFocus ?? ko("All", "전체")}</b></div>
    <p className="inspector-hint">{rigSelection && rigSelection.token !== "rig" ? (isKo ? `${HIERARCHY_INSPECTOR_TITLES[rigSelection.token]}이 활성 제어 그룹입니다.` : `${HIERARCHY_INSPECTOR_TITLES[rigSelection.token]} is the active control group.`) : ko("Select a body group to pose it in the viewport.", "몸 그룹을 선택해 뷰포트에서 포즈를 잡으세요.")}</p>
   </section>
   {ikMode && <section className="pose-section" data-testid="pose-active-tool">
    <h4>{ko("Active tool", "활성 도구")} · {ko(activeTool, activeTool === "Path fix" ? "경로 수정" : activeTool === "Pin" ? "고정" : "IK")}</h4>
    <div className="pose-actions">
     <button type="button" className={"btn" + (ikEditTool === "ik" ? " primary" : "")} aria-pressed={ikEditTool === "ik"} onClick={() => setIkEditTool("ik")}>{ko("IK", "IK")}</button>
     <button type="button" className={"btn" + (ikEditTool === "trail" ? " primary" : "")} aria-pressed={ikEditTool === "trail"} disabled={!showTrails} onClick={() => setIkEditTool("trail")}>{ko("Path fix", "경로 수정")}</button>
     <button type="button" data-testid="range-pin-tool" className={"btn" + (ikEditTool === "pin" ? " primary" : "")} aria-pressed={ikEditTool === "pin"} disabled={!motion} onClick={() => { setIkEditTool("pin"); setRangePinPartPick?.(null); }}>{ko("Pin", "고정")}</button>
    </div>
    {ikEditTool === "pin" && <RangePinPanel active motion={motion} frame={tlFrame} frameCount={motion?.frames ?? 1} fps={motion?.fps ?? 24} pins={rangePins} residuals={rangePinResiduals} objects={objects} selectedPinId={rangePinSelection} partPick={rangePinPartPick} conflictFrames={rangePinPreview?.conflictFrames ?? []} overlapError={rangePinPreview?.overlapError ?? ""} onSelectPin={(id) => { setRangePinSelection?.(id); if (id) setIkEditTool("pin"); }} onApply={applyRangePinDraft} onCancel={() => { setRangePinSelection?.(null); setIkEditTool("ik"); }} onDelete={deleteRangePin} onPreviewTarget={previewRangePinDraft} />}
    {ikEditTool === "trail" && <>
     <button type="button" className="btn full" aria-pressed={showTrails} onClick={() => setShowTrails((value) => !value)}>{ko(`Trails ${showTrails ? "on" : "off"}`, `궤적선 ${showTrails ? "표시" : "숨김"}`)}</button>
     <Field label={ko("Falloff", "영향 범위")}><div className="trail-falloff-row"><input type="range" min={0.1} max={2} step={0.1} value={trailFalloffS} onChange={(event) => setTrailFalloffS(Number(event.target.value))} /><span className="trail-falloff-value">{trailFalloffS.toFixed(1)}s</span></div></Field>
     <button type="button" className="btn primary full" disabled={!trailEdit || !motion?.url || generationBusy || bridgeChecking || bridge === null} onClick={runTrailRegeneration}>{ko("Regenerate", "재생성")}</button>
     <MotionReadiness state={trailReadinessState} checking={bridgeChecking} onSetup={() => openMotionSetup("trail")} onRetry={recheckMotionHealth} />
    </>}
    {ikEditTool === "ik" && <p className="inspector-hint">{ko("Grab a hand, foot, elbow or knee handle in the viewport.", "뷰포트에서 손·발·팔꿈치·무릎 핸들을 잡으세요.")}</p>}
   </section>}
   <section className="pose-section" data-testid="pose-auto-fix">
    <h4>{ko("Auto-fix", "자동 수정")}</h4>
    {collisionCleanupSupported && <div className="pose-actions"><button type="button" className="btn" disabled={!ikChains} onClick={() => run("motion.fixCollisions", { scope: "frame" })}>{ko("Body collisions · Frame", "신체 충돌 · 프레임")}</button><button type="button" className="btn" disabled={!ikChains || !motion} onClick={() => run("motion.fixCollisions", { scope: "clip" })}>{ko("Body collisions · Clip", "신체 충돌 · 클립")}</button></div>}
    <PlatformFitPanel ko={ko} disabled={!ikChains || !motion || autoPhysicsRunning} running={platformFitRunning} progress={platformFitProgress} last={platformFitLast} applied={platformFitApplied} onRun={() => run("motion.platformFit.run")} onApply={() => run("motion.platformFit.remove", { apply: true })} onCancel={() => run("motion.platformFit.remove")} onRemove={() => run("motion.platformFit.remove")} onFrame={setTlFrame} />
    <PhysicsPanel ko={ko} disabled={!ikChains || !motion} running={autoPhysicsRunning} progress={physicsProgress} preview={physicsPreview} show={physicsShow} options={physicsOptions} frame={tlFrame} frames={motion?.frames ?? 1} onOptions={changePhysicsOptions} onRun={runAutoPhysics} onShow={showPhysicsPreview} onApply={applyPhysicsPreview} onCancel={cancelPhysicsPreview} onFrame={setTlFrame} />
   </section>
  </div>
 </Foldout>;
}
