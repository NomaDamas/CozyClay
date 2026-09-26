import { ko, isKo } from "./locale.js";
import { buildH3MotionPrompt, FAL_MOTION_DURATIONS, FAL_MOTION_MIN_DURATION } from "./fal-motion-client.js";

// The Fal motion workflow split by what needs the viewport (#407 UX). The
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
		<div className="fal-motion-stepper" aria-label={ko("Fal 모션 진행 단계", "Fal motion steps")}>
			{[
				[1, ko("음영", "Shaded")],
				[2, "A"],
				[3, "B"],
				[4, ko("생성", "Generate")],
			].map(([n, label]) => <span key={n} className={step === n ? "active" : step > n ? "done" : ""}><b>{n}</b>{label}</span>)}
		</div>
	);
}

function CameraStatus({ model, actions }) {
	const { hasA, hasB, cameraMatch, cameraUnlocked, currentCameraMatch } = model;
	return (
		<>
			<p className={"fal-motion-camera-status" + (cameraMatch ? " ready" : "")} data-testid="fal-motion-camera-status">
				{hasA
					? cameraUnlocked
						? ko("카메라 잠금 해제됨 · A를 다시 캡처하면 새 기준을 저장합니다.", "Camera unlocked · recapture A to save a new reference.")
						: currentCameraMatch
							? cameraMatch ? ko("✓ A/B 카메라 프레이밍 일치 확인 · 카메라 잠금", "✓ A/B camera framing matched · camera locked") : ko("✓ A 카메라 기준 저장 · 카메라 잠금", "✓ A camera saved · camera locked")
							: ko("A 이후 카메라가 바뀌었어요. A 카메라로 복원하세요.", "The camera changed after A. Restore the A camera.")
					: ko("A를 먼저 캡처하면 카메라 기준을 저장합니다.", "Capture A first to save the camera reference.")}
			</p>
			{hasA && <div className="fal-motion-camera-actions">
				<button type="button" className="btn ghost" onClick={actions.toggleCameraLock}>{cameraUnlocked ? ko("카메라 잠그기", "Lock camera") : ko("카메라 잠금 해제", "Unlock camera")}</button>
				{!currentCameraMatch && <button type="button" className="btn ghost" onClick={actions.restoreCamera}>{ko("A 카메라로 복원", "Restore A camera")}</button>}
			</div>}
		</>
	);
}

function Thumbs({ model }) {
	const { falMotion } = model;
	if (!falMotion.a && !falMotion.b) return null;
	return (
		<div className="fal-motion-thumbs" aria-label={ko("Fal motion reference poses", "Fal motion reference poses")}>
			{falMotion.a && <figure><img src={falMotion.a.dataUrl} alt="Pose A" /><figcaption>A · {falMotion.a.width}×{falMotion.a.height}</figcaption></figure>}
			{falMotion.b && <figure><img src={falMotion.b.dataUrl} alt="Pose B" /><figcaption>B · {falMotion.b.width}×{falMotion.b.height}</figcaption></figure>}
		</div>
	);
}

/** The viewport-side strip in the Pose foldout. Capture and framing only. */
export function FalMotionCaptureCard({ model, actions, onOpen }) {
	const { falMotion, mode, enabled, segmentationReady, step, hasA, hasB, cameraUnlocked, framingActive } = model;
	return (
		<section className="fal-motion-card" data-testid="fal-motion-studio" data-motion-enabled={enabled ? "true" : "false"}>
			<div className="fal-motion-head">
				<strong>{ko("Fal 모션 생성", "Fal motion")}</strong>
				<span>{!enabled ? ko("QA 잠금", "QA lock") : falMotion.job?.status === "done" ? ko("완료", "Done") : falMotion.status === "error" ? ko("확인 필요", "Needs attention") : "H3 Max Turbo · 480P"}</span>
			</div>
			<Stepper step={step} />
			<div className="fal-motion-segmentation-row">
				<p className="inspector-hint fal-motion-ratio">{ko("샷 시점을 H3 비율(832×480)로 맞추고 구도를 잡으세요.", "Frame the shot at the H3 ratio (832×480) in the shot view.")}</p>
				<button type="button" className="btn fal-motion-flat-cta" data-testid="fal-motion-frame-shot" onClick={actions.enterFraming} disabled={framingActive}>{ko("fal 비율로 샷 시점", "Fal-ratio shot view")}</button>
			</div>
			<div className={"fal-motion-segmentation-row" + (segmentationReady ? " ready" : "")}>
				<p className="inspector-hint fal-motion-segmentation">{segmentationReady ? ko("색 세그멘테이션 음영 모드 ON · A/B 캡처 가능", "Shaded body-part segmentation ON · A/B capture ready") : ko("A/B 참조에는 부위 색상 음영 모드가 필요합니다.", "Shaded body-part colours are required for A/B refs.")}</p>
				{!segmentationReady && <button type="button" className="btn fal-motion-flat-cta" onClick={actions.enableShaded}>{ko("음영 모드 켜기", "Enable Shaded")}</button>}
			</div>
			<div className="fal-motion-capture-status" aria-live="polite" data-testid="fal-motion-capture-status">
				<div className={"fal-motion-capture-slot" + (hasA ? " captured" : "")} data-testid="fal-motion-ref-a-status">
					<strong>A · {hasA ? ko("캡처 완료", "Captured") : ko("미캡처", "Not captured")}</strong>
					<span>{hasA ? `${falMotion.a.width}×${falMotion.a.height} · Shaded ${falMotion.a.partColours.length}개` : ko("현재 프레임에서 A 캡처를 누르세요", "Press Capture A on the current frame")}</span>
				</div>
				<div className={"fal-motion-capture-slot" + (hasB ? " captured" : "")} data-testid="fal-motion-ref-b-status">
					<strong>B · {hasB ? ko("캡처 완료", "Captured") : ko("미캡처", "Not captured")}</strong>
					<span>{hasB ? `${falMotion.b.width}×${falMotion.b.height} · Shaded ${falMotion.b.partColours.length}개` : ko("B 포즈를 만든 뒤 카메라를 움직이지 말고 B 캡처를 누르세요", "Set the B pose, keep the camera still, then press Capture B")}</span>
					{hasB && <button type="button" className="fal-motion-slot-action" onClick={() => actions.clearPose("b")}>{ko("B 제거", "Remove B")}</button>}
				</div>
			</div>
			<CameraStatus model={model} actions={actions} />
			<div className="fal-motion-pose-row">
				<button type="button" className={falMotion.a ? "btn active" : "btn"} disabled={!segmentationReady} onClick={() => actions.markPose("a")}>{falMotion.a ? ko("A 재캡처", "Recapture A") : ko("A 캡처", "Capture A")}</button>
				{mode === "interpolate" && <button type="button" className={falMotion.b ? "btn active" : "btn"} disabled={!segmentationReady || cameraUnlocked} onClick={() => actions.markPose("b")}>{falMotion.b ? ko("B 재캡처", "Recapture B") : ko("B 캡처", "Capture B")}</button>}
				{(falMotion.a || falMotion.b) && <button type="button" className="btn ghost" onClick={actions.clear}>{ko("초기화", "Clear")}</button>}
			</div>
			<Thumbs model={model} />
			<div className="fal-motion-open-row">
				<button type="button" className="btn primary fal-motion-open" data-testid="fal-motion-open" onClick={onOpen}>{ko("동작 설명 · 생성", "Describe & generate")}</button>
			</div>
		</section>
	);
}

/** The wide authoring surface: description, duration, prompt, generate. */
export function FalMotionModal({ model, actions, onClose }) {
	const { falMotion, mode, enabled, hasA, hasB, step } = model;
	const interpolate = mode === "interpolate";
	const generateDisabled = interpolate
		? (!enabled || falMotion.status === "submitting" || falMotion.status === "queued" || !hasA || !hasB)
		: (!enabled || falMotion.status === "submitting" || falMotion.status === "queued" || !hasA || !!falMotion.b || !falMotion.instruction.trim());
	const generateTitle = !enabled
		? ko("소유자 테스트가 끝날 때까지 잠겨 있습니다.", "Locked until owner testing is complete.")
		: interpolate && !hasB
			? ko("B 포즈를 먼저 캡처하세요.", "Capture B before generating.")
			: !interpolate && !!falMotion.b
				? ko("A만 동작 모드에서는 B를 제거하세요.", "Remove B for A-only action mode.")
				: !interpolate && !falMotion.instruction.trim()
					? ko("동작 설명을 입력하세요.", "Enter an action description.")
					: "";
	const busy = falMotion.status === "submitting" || falMotion.status === "queued";
	return (
		<div className="modal-overlay" onClick={onClose}>
			<div className="modal fal-motion-modal" role="dialog" aria-modal="true" aria-labelledby="fal-motion-title" onClick={(event) => event.stopPropagation()}>
				<div className="modal-head">
					<h3 id="fal-motion-title">{ko("Fal 모션 생성", "Fal motion")}</h3>
					<button type="button" className="x" onClick={onClose} aria-label={ko("닫기", "Close")}>✕</button>
				</div>
				<div className="fal-motion-modal-body">
					<div className="fal-motion-modal-left">
						<Stepper step={step} />
						<Thumbs model={model} />
						{step < 4 && <p className="inspector-hint">{ko("A/B 캡처는 뷰포트에서 합니다. 닫고 카드에서 캡처하세요.", "Capture A/B in the viewport — close this and use the card.")}</p>}
						{falMotion.job?.status === "done" && falMotion.job.video?.url && <video className="fal-motion-video" src={falMotion.job.video.url} controls playsInline preload="metadata" />}
					</div>
					<div className="fal-motion-modal-right">
						<div className="fal-motion-mode-tabs" role="tablist" aria-label={ko("Fal 모션 방식", "Fal motion mode")}>
							<button type="button" role="tab" aria-selected={interpolate} className={interpolate ? "active" : ""} onClick={() => actions.setMode("interpolate")}>{ko("A→B 보간", "A→B interpolate")}</button>
							<button type="button" role="tab" aria-selected={!interpolate} className={!interpolate ? "active" : ""} onClick={() => actions.setMode("act")}>{ko("A만 동작", "A-only action")}</button>
						</div>
						<p className="inspector-hint fal-motion-mode-hint">
							{interpolate
								? ko("A와 B 사이를 어떻게 움직일지 설명과 함께 만듭니다.", "Describe how the character moves from A to B.")
								: ko("A 포즈 하나와 동작 설명으로 움직임을 만듭니다.", "Creates motion from one A pose and an action description.")}
						</p>
						<textarea
							className="fal-motion-instruction"
							value={falMotion.instruction}
							placeholder={interpolate
								? ko("A에서 B로 어떻게 움직이는지 적으세요. 예: 벤치로 걸어가 돌아서 앉는다", "Describe the motion from A to B. Example: walk to the bench, turn, and sit")
								: ko("A만 캡처한 뒤 동작을 적으세요. 예: 검을 머리 위로 휘두르고 한 걸음 전진", "With A only, describe the action. Example: swing the sword overhead and step forward")}
							onChange={(event) => actions.setFalMotion((current) => ({ ...current, instruction: event.target.value }))}
						/>
						<div className="fal-motion-duration-row">
							<span className="inspector-hint">{ko("길이", "Length")}</span>
							{FAL_MOTION_DURATIONS.map((seconds) => (
								<button key={seconds} type="button" className={"btn small" + ((falMotion.duration ?? FAL_MOTION_MIN_DURATION) === seconds ? " active" : "")} onClick={() => actions.setFalMotion((current) => ({ ...current, duration: seconds }))}>{seconds}{ko("초", "s")}</button>
							))}
						</div>
						<details className="fal-motion-prompt-edit">
							<summary>{ko("보낼 프롬프트", "Prompt to send")}</summary>
							<textarea
								className="fal-motion-instruction fal-motion-prompt-override"
								value={falMotion.promptOverride ?? ""}
								placeholder={buildH3MotionPrompt(falMotion.instruction, { interpolate })}
								onChange={(event) => actions.setFalMotion((current) => ({ ...current, promptOverride: event.target.value }))}
							/>
							<p className="inspector-hint">{ko("비워 두면 위 설명으로 자동 생성됩니다. 직접 고치면 그대로 전송됩니다.", "Left blank, this is built from the description above. Edit it and your text is sent verbatim.")}</p>
						</details>
						{falMotion.status === "error" && <p className="studio-hint error fal-motion-inline-error" role="alert">{falMotion.error}</p>}
						<div className="fal-motion-actions">
							<button type="button" className="btn primary" title={generateTitle} disabled={generateDisabled} onClick={() => actions.generate(mode)}>
								{busy ? ko("생성 중…", "Generating…") : interpolate ? ko("A→B 보간 생성", "Interpolate A→B") : ko("동작 생성", "Generate action")}
							</button>
						</div>
						{!enabled && <p className="inspector-hint">{ko("소유자 테스트가 끝날 때까지 생성 요청은 서버에서 차단됩니다.", "Generation requests stay blocked on the server until owner testing is complete.")}</p>}
						{falMotion.dailyRemaining !== null && <p className="inspector-hint">{ko(`오늘 남은 생성 ${falMotion.dailyRemaining}회`, `${falMotion.dailyRemaining} motion generations left today`)}</p>}
					</div>
				</div>
			</div>
		</div>
	);
}
