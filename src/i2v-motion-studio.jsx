import { ko, isKo } from "./locale.js";
import { buildH3MotionPrompt, I2V_MOTION_DURATIONS, I2V_MOTION_MIN_DURATION } from "./i2v-motion-client.js";

// The AI motion workflow split by what needs the viewport (#407 UX). The
// card stays in the Pose foldout and holds only the steps that operate on the
// 3D scene (framing, shaded mode, A/B capture, camera lock). The modal takes
// the text-heavy authoring (mode, description, duration, prompt, generate)
// onto a wide surface. A blocking overlay would hide the viewport, so capture
// never lives in the modal.
//
// App builds one `model` (state + derived booleans) and one `actions` object
// (handlers) and passes both to each surface, so the two cannot drift.

function Stepper({ step }) {
	return (
		<div className="i2v-motion-stepper" aria-label={ko("AI motion steps", "AI 모션 진행 단계")}>
			{[
				[1, ko("Shaded", "음영")],
				[2, "A"],
				[3, "B"],
				[4, ko("Generate", "생성")],
			].map(([n, label]) => <span key={n} className={step === n ? "active" : step > n ? "done" : ""}><b>{n}</b>{label}</span>)}
		</div>
	);
}

function CameraStatus({ model, actions }) {
	const { hasA, hasB, cameraMatch, cameraUnlocked, currentCameraMatch } = model;
	return (
		<>
			<p className={"i2v-motion-camera-status" + (cameraMatch ? " ready" : "")} data-testid="i2v-motion-camera-status">
				{hasA
					? cameraUnlocked
						? ko("Camera unlocked · recapture A to save a new reference.", "카메라 잠금 해제됨 · A를 다시 캡처하면 새 기준을 저장합니다.")
						: currentCameraMatch
							? cameraMatch ? ko("✓ A/B camera framing matched · camera locked", "✓ A/B 카메라 프레이밍 일치 확인 · 카메라 잠금") : ko("✓ A camera saved · camera locked", "✓ A 카메라 기준 저장 · 카메라 잠금")
							: ko("The camera changed after A. Restore the A camera.", "A 이후 카메라가 바뀌었어요. A 카메라로 복원하세요.")
					: ko("Capture A first to save the camera reference.", "A를 먼저 캡처하면 카메라 기준을 저장합니다.")}
			</p>
			{hasA && <div className="i2v-motion-camera-actions">
				<button type="button" className="btn ghost" onClick={actions.toggleCameraLock}>{cameraUnlocked ? ko("Lock camera", "카메라 잠그기") : ko("Unlock camera", "카메라 잠금 해제")}</button>
				{!currentCameraMatch && <button type="button" className="btn ghost" onClick={actions.restoreCamera}>{ko("Restore A camera", "A 카메라로 복원")}</button>}
			</div>}
		</>
	);
}

function Thumbs({ model }) {
	const { i2vMotion } = model;
	if (!i2vMotion.a && !i2vMotion.b) return null;
	return (
		<div className="i2v-motion-thumbs" aria-label={ko("AI motion reference poses", "AI motion reference poses")}>
			{i2vMotion.a && <figure><img src={i2vMotion.a.dataUrl} alt="Pose A" /><figcaption>A · {i2vMotion.a.width}×{i2vMotion.a.height}</figcaption></figure>}
			{i2vMotion.b && <figure><img src={i2vMotion.b.dataUrl} alt="Pose B" /><figcaption>B · {i2vMotion.b.width}×{i2vMotion.b.height}</figcaption></figure>}
		</div>
	);
}

/** The viewport-side strip in the Pose foldout. Capture and framing only. */
export function I2vMotionCaptureCard({ model, actions, onOpen }) {
	const { i2vMotion, mode, enabled, segmentationReady, step, hasA, hasB, cameraUnlocked, framingActive } = model;
	return (
		<section className="i2v-motion-card" data-testid="i2v-motion-studio" data-motion-enabled={enabled ? "true" : "false"}>
			<div className="i2v-motion-head">
				<strong>{ko("AI motion", "AI 모션 생성")}</strong>
				<span>{!enabled ? ko("QA lock", "QA 잠금") : i2vMotion.job?.status === "done" ? ko("Done", "완료") : i2vMotion.status === "error" ? ko("Needs attention", "확인 필요") : "H3 Max Turbo · 480P"}</span>
			</div>
			<Stepper step={step} />
			<div className="i2v-motion-segmentation-row">
				<p className="inspector-hint i2v-motion-ratio">{ko("Frame the shot at the H3 ratio (832×480) in the shot view.", "샷 시점을 H3 비율(832×480)로 맞추고 구도를 잡으세요.")}</p>
				<button type="button" className="btn i2v-motion-flat-cta" data-testid="i2v-motion-frame-shot" onClick={actions.enterFraming} disabled={framingActive}>{ko("480P shot view", "480P 비율로 샷 시점")}</button>
			</div>
			<div className={"i2v-motion-segmentation-row" + (segmentationReady ? " ready" : "")}>
				<p className="inspector-hint i2v-motion-segmentation">{segmentationReady ? ko("Shaded body-part segmentation ON · A/B capture ready", "색 세그멘테이션 음영 모드 ON · A/B 캡처 가능") : ko("Shaded body-part colours are required for A/B refs.", "A/B 참조에는 부위 색상 음영 모드가 필요합니다.")}</p>
				{!segmentationReady && <button type="button" className="btn i2v-motion-flat-cta" onClick={actions.enableShaded}>{ko("Enable Shaded", "음영 모드 켜기")}</button>}
			</div>
			<div className="i2v-motion-capture-status" aria-live="polite" data-testid="i2v-motion-capture-status">
				<div className={"i2v-motion-capture-slot" + (hasA ? " captured" : "")} data-testid="i2v-motion-ref-a-status">
					<strong>A · {hasA ? ko("Captured", "캡처 완료") : ko("Not captured", "미캡처")}</strong>
					<span>{hasA ? `${i2vMotion.a.width}×${i2vMotion.a.height} · Shaded ${i2vMotion.a.partColours.length}개` : ko("Press Capture A on the current frame", "현재 프레임에서 A 캡처를 누르세요")}</span>
				</div>
				<div className={"i2v-motion-capture-slot" + (hasB ? " captured" : "")} data-testid="i2v-motion-ref-b-status">
					<strong>B · {hasB ? ko("Captured", "캡처 완료") : ko("Not captured", "미캡처")}</strong>
					<span>{hasB ? `${i2vMotion.b.width}×${i2vMotion.b.height} · Shaded ${i2vMotion.b.partColours.length}개` : ko("Set the B pose, keep the camera still, then press Capture B", "B 포즈를 만든 뒤 카메라를 움직이지 말고 B 캡처를 누르세요")}</span>
					{hasB && <button type="button" className="i2v-motion-slot-action" onClick={() => actions.clearPose("b")}>{ko("Remove B", "B 제거")}</button>}
				</div>
			</div>
			<CameraStatus model={model} actions={actions} />
			<div className="i2v-motion-pose-row">
				<button type="button" className={i2vMotion.a ? "btn active" : "btn"} disabled={!segmentationReady} onClick={() => actions.markPose("a")}>{i2vMotion.a ? ko("Recapture A", "A 재캡처") : ko("Capture A", "A 캡처")}</button>
				{mode === "interpolate" && <button type="button" className={i2vMotion.b ? "btn active" : "btn"} disabled={!segmentationReady || cameraUnlocked} onClick={() => actions.markPose("b")}>{i2vMotion.b ? ko("Recapture B", "B 재캡처") : ko("Capture B", "B 캡처")}</button>}
				{(i2vMotion.a || i2vMotion.b) && <button type="button" className="btn ghost" onClick={actions.clear}>{ko("Clear", "초기화")}</button>}
			</div>
			<Thumbs model={model} />
			<div className="i2v-motion-open-row">
				<button type="button" className="btn primary i2v-motion-open" data-testid="i2v-motion-open" onClick={onOpen}>{ko("Describe & generate", "동작 설명 · 생성")}</button>
			</div>
		</section>
	);
}

/** The wide authoring surface: description, duration, prompt, generate. */
export function I2vMotionModal({ model, actions, onClose }) {
	const { i2vMotion, mode, enabled, hasA, hasB, step } = model;
	const interpolate = mode === "interpolate";
	const generateDisabled = interpolate
		? (!enabled || i2vMotion.status === "submitting" || i2vMotion.status === "queued" || !hasA || !hasB)
		: (!enabled || i2vMotion.status === "submitting" || i2vMotion.status === "queued" || !hasA || !!i2vMotion.b || !i2vMotion.instruction.trim());
	const generateTitle = !enabled
		? ko("Locked until owner testing is complete.", "소유자 테스트가 끝날 때까지 잠겨 있습니다.")
		: interpolate && !hasB
			? ko("Capture B before generating.", "B 포즈를 먼저 캡처하세요.")
			: !interpolate && !!i2vMotion.b
				? ko("Remove B for A-only action mode.", "A만 동작 모드에서는 B를 제거하세요.")
				: !interpolate && !i2vMotion.instruction.trim()
					? ko("Enter an action description.", "동작 설명을 입력하세요.")
					: "";
	const busy = i2vMotion.status === "submitting" || i2vMotion.status === "queued";
	return (
		<div className="modal-overlay" onClick={onClose}>
			<div className="modal i2v-motion-modal" role="dialog" aria-modal="true" aria-labelledby="i2v-motion-title" onClick={(event) => event.stopPropagation()}>
				<div className="modal-head">
					<h3 id="i2v-motion-title">{ko("AI motion", "AI 모션 생성")}</h3>
					<button type="button" className="x" onClick={onClose} aria-label={ko("Close", "닫기")}>✕</button>
				</div>
				<div className="i2v-motion-modal-body">
					<div className="i2v-motion-modal-left">
						<Stepper step={step} />
						<Thumbs model={model} />
						{step < 4 && <p className="inspector-hint">{ko("Capture A/B in the viewport — close this and use the card.", "A/B 캡처는 뷰포트에서 합니다. 닫고 카드에서 캡처하세요.")}</p>}
						{i2vMotion.job?.status === "done" && i2vMotion.job.video?.url && <video className="i2v-motion-video" src={i2vMotion.job.video.url} controls playsInline preload="metadata" />}
					</div>
					<div className="i2v-motion-modal-right">
						<div className="i2v-motion-mode-tabs" role="tablist" aria-label={ko("AI motion mode", "AI 모션 방식")}>
							<button type="button" role="tab" aria-selected={interpolate} className={interpolate ? "active" : ""} onClick={() => actions.setMode("interpolate")}>{ko("A→B interpolate", "A→B 보간")}</button>
							<button type="button" role="tab" aria-selected={!interpolate} className={!interpolate ? "active" : ""} onClick={() => actions.setMode("act")}>{ko("A-only action", "A만 동작")}</button>
						</div>
						<p className="inspector-hint i2v-motion-mode-hint">
							{interpolate
								? ko("Describe how the character moves from A to B.", "A와 B 사이를 어떻게 움직일지 설명과 함께 만듭니다.")
								: ko("Creates motion from one A pose and an action description.", "A 포즈 하나와 동작 설명으로 움직임을 만듭니다.")}
						</p>
						<textarea
							className="i2v-motion-instruction"
							value={i2vMotion.instruction}
							placeholder={interpolate
								? ko("Describe the motion from A to B. Example: walk to the bench, turn, and sit", "A에서 B로 어떻게 움직이는지 적으세요. 예: 벤치로 걸어가 돌아서 앉는다")
								: ko("With A only, describe the action. Example: swing the sword overhead and step forward", "A만 캡처한 뒤 동작을 적으세요. 예: 검을 머리 위로 휘두르고 한 걸음 전진")}
							onChange={(event) => actions.setI2vMotion((current) => ({ ...current, instruction: event.target.value }))}
						/>
						<div className="i2v-motion-duration-row">
							<span className="inspector-hint">{ko("Length", "길이")}</span>
							{I2V_MOTION_DURATIONS.map((seconds) => (
								<button key={seconds} type="button" className={"btn small" + ((i2vMotion.duration ?? I2V_MOTION_MIN_DURATION) === seconds ? " active" : "")} onClick={() => actions.setI2vMotion((current) => ({ ...current, duration: seconds }))}>{seconds}{ko("s", "초")}</button>
							))}
						</div>
						<details className="i2v-motion-prompt-edit">
							<summary>{ko("Prompt to send", "보낼 프롬프트")}</summary>
							<textarea
								className="i2v-motion-instruction i2v-motion-prompt-override"
								value={i2vMotion.promptOverride ?? ""}
								placeholder={buildH3MotionPrompt(i2vMotion.instruction, { interpolate })}
								onChange={(event) => actions.setI2vMotion((current) => ({ ...current, promptOverride: event.target.value }))}
							/>
							<p className="inspector-hint">{ko("Left blank, this is built from the description above. Edit it and your text is sent verbatim.", "비워 두면 위 설명으로 자동 생성됩니다. 직접 고치면 그대로 전송됩니다.")}</p>
						</details>
						{i2vMotion.status === "error" && <p className="studio-hint error i2v-motion-inline-error" role="alert">{i2vMotion.error}</p>}
						<div className="i2v-motion-actions">
							<button type="button" className="btn primary" title={generateTitle} disabled={generateDisabled} onClick={() => actions.generate(mode)}>
								{busy ? ko("Generating…", "생성 중…") : interpolate ? ko("Interpolate A→B", "A→B 보간 생성") : ko("Generate action", "동작 생성")}
							</button>
						</div>
						{!enabled && <p className="inspector-hint">{ko("Generation requests stay blocked on the server until owner testing is complete.", "소유자 테스트가 끝날 때까지 생성 요청은 서버에서 차단됩니다.")}</p>}
						{i2vMotion.dailyRemaining !== null && <p className="inspector-hint">{ko(`${i2vMotion.dailyRemaining} motion generations left today`, `오늘 남은 생성 ${i2vMotion.dailyRemaining}회`)}</p>}
					</div>
				</div>
			</div>
		</div>
	);
}
