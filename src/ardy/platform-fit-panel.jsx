import React, { useEffect, useSyncExternalStore } from "react";
import "../panels/pose.css";
import { isImeComposing } from "../ime.js";

const FOOT_NAMES = { leftFoot: ["Left foot", "왼발"], rightFoot: ["Right foot", "오른발"] };
function stepLabel(step, ko) {
	if (step.status === "wall") return `${ko("Wall", "벽")} · F${step.start}`;
	const [en, kr] = FOOT_NAMES[step.foot] ?? [step.foot, step.foot];
	const amount = step.lift !== 0 ? step.lift : step.rise;
	return `${ko(en, kr)} F${step.start}–F${step.end} · ${amount >= 0 ? "+" : ""}${Math.round(amount * 100)}cm`;
}

export function PlatformFitPanel({ ko, disabled, running, progress: progressStore, last, applied, onRun, onApply, onCancel, onRemove, onFrame }) {
	const progress = useSyncExternalStore(progressStore.subscribe, progressStore.getSnapshot);
	const preview = Boolean(last && !applied && last.candidate);
	const steps = last?.steps?.filter((step) => step.lift !== 0 || step.status !== "ok") ?? [];
	useEffect(() => {
		if (!preview) return undefined;
		const onKeyDown = (event) => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			if (event.key === "Escape") { event.preventDefault(); onCancel?.(); }
			if (event.key === "Enter" && !isImeComposing(event)) { event.preventDefault(); onApply?.(); }
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [preview, onApply, onCancel]);
	return <section className="platform-fit auto-fix-card pose-section" data-testid="platform-fit-panel" aria-label={ko("Fit to platforms", "발판에 맞추기")}>
		<div className="auto-fix-card-head"><h4>{ko("Fit to platforms", "발판에 맞추기")}</h4><p className="inspector-hint">{ko("Raise feet and body to platforms in the path.", "경로의 발판에 맞춰 발과 몸을 올립니다.")}</p></div>
		<button type="button" data-testid="platform-fit-run" className="btn full primary" disabled={disabled || running || preview} onClick={onRun}>{running ? ko(`Fitting ${progress}%`, `맞추는 중 ${progress}%`) : ko("Run", "실행")}</button>
		{running && <progress max="100" value={progress} aria-label={ko("Platform fit progress", "발판 맞춤 진행률")} />}
		{preview && <div className="pose-preview" data-testid="platform-fit-preview">
			<strong className="pose-preview-title">{ko("Preview", "미리보기")}</strong>
			<span className="pose-preview-summary">{ko(`${last.summary.lifted} steps lifted · ${steps.length} result${steps.length === 1 ? "" : "s"}`, `${last.summary.lifted}개 단계 상승 · 결과 ${steps.length}개`)}</span>
			<ul className="pose-results">{steps.slice(0, 5).map((step) => <li key={step.id} data-status={step.status}><button type="button" className="btn ghost small" onClick={() => onFrame(step.start)}>{stepLabel(step, ko)}</button></li>)}</ul>
			<div className="pose-actions"><button data-testid="platform-fit-cancel" type="button" className="btn" onClick={onCancel}>{ko("Cancel", "취소")}</button><button data-testid="platform-fit-apply" type="button" className="btn primary" disabled={!last.changedFrames?.length || steps.some((step) => step.status === "wall" && step.lift === 0)} onClick={onApply}>{ko("Apply", "적용")}</button></div>
			<span className="pose-keyhint">{ko("Enter applies · Esc cancels", "Enter 적용 · Esc 취소")}</span>
		</div>}
		{applied && <button type="button" data-testid="platform-fit-remove" className="btn full" disabled={disabled || running} onClick={onRemove}>{ko("Remove platform fit", "발판 맞춤 제거")}</button>}
		{last && !preview && <div data-testid="platform-fit-results" className="auto-fix-result"><ul className="platform-fit-results">{steps.slice(0, 5).map((step) => <li key={step.id}><button type="button" className="btn platform-fit-step" data-status={step.status} onClick={() => onFrame(step.start)}>{stepLabel(step, ko)}</button></li>)}</ul>{steps.length === 0 && <p className="inspector-hint">{ko("No platforms in the path.", "경로에 발판이 없어요.")}</p>}</div>}
	</section>;
}
