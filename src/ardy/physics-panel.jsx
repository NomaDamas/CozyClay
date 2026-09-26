import React, { useState, useSyncExternalStore } from "react";
import { SUPPORT_SITES } from "./physics-review.js";
import "./physics-panel.css";

// Only the progress panel subscribes. Publishing a percentage must not
// rerender the full timeline/Studio hundreds of times during a solve.
export function createPhysicsProgress() {
	let value = 0;
	const listeners = new Set();
	return { getSnapshot: () => value, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
		set: (next) => { if (next === value) return; value = next; for (const listener of listeners) listener(); } };
}

export function PhysicsPanel({ ko, disabled, running, progress: progressStore, preview, show, options, frame, frames, onOptions, onRun, onShow, onApply, onCancel, onFrame }) {
	const progress = useSyncExternalStore(progressStore.subscribe, progressStore.getSnapshot);
	const [site, setSite] = useState("leftFoot");
	const [start, setStart] = useState(0), [end, setEnd] = useState(0), [mode, setMode] = useState("plant");
	const name = (id) => { const s = SUPPORT_SITES.find((s) => s.id === id); return s ? ko(s.label, s.ko) : id; };
	const set = (patch) => onOptions({ ...options, ...patch });
	const add = () => {
		const a = Math.max(0, Math.min(frames - 1, Math.round(Number(start) || 0)));
		const b = Math.max(a, Math.min(frames - 1, Math.round(Number(end) || 0)));
		set({ overrides: [...options.overrides, { site, start: a, end: b, mode }] });
	};
	const cm = (x) => `${(x * 100).toFixed(2)} cm`;
	const warning = (r) => ({ unsupported: ko("Unexplained body support", "몸을 지탱하는 접촉 미확인"), floor: ko("Floor penetration", "바닥 관통"), float: ko("Contact floats", "접지점 뜸"), slide: ko("Contact drift", "접지점 밀림"), "knee-pop": ko("Knee speed jump", "무릎 튐"), "knee-acceleration": ko("Knee acceleration increased", "무릎 가속도 증가"), "root-acceleration": ko("Root acceleration increased", "골반 가속도 증가"), replay: ko("Playback mismatch", "재생 불일치") }[r] ?? r);
	return <section className="physics-review" data-testid="physics-panel" aria-label="AutoPhysics">
		<h4>AutoPhysics <small>{ko("review before applying", "확인 후 적용")}</small></h4>
		<p className="inspector-hint">{ko("Floor-support hypotheses → force + moment check → pelvis + limbs. Flight is preserved; uncertain support stays flagged. Original stays unchanged until Apply.", "바닥 지지 후보 → 힘·회전 검사 → 골반·팔다리를 보정합니다. 비행은 보존하고, 불명확한 지지는 표시해요. 적용 전까지 원본은 바뀌지 않아요.")}</p>
		<fieldset disabled={disabled || running}>
			<label>{ko("Correction strength", "보정 강도")} <output>{Math.round(options.strength * 100)}%</output>
				<input data-testid="physics-strength" type="range" min="0" max="100" step="10" value={options.strength * 100} onChange={(e) => set({ strength: Number(e.target.value) / 100 })} />
			</label>
			<details>
				<summary>{ko("Contact overrides & protected poses", "접지 구간 지정 · 포즈 보호")}</summary>
				<div className="physics-contact-editor">
					<select aria-label={ko("Support point", "접지점")} value={site} onChange={(e) => setSite(e.target.value)}>{SUPPORT_SITES.map((s) => <option key={s.id} value={s.id}>{name(s.id)}</option>)}</select>
					<select aria-label={ko("Contact mode", "접지 방식")} value={mode} onChange={(e) => setMode(e.target.value)}><option value="plant">{ko("Plant", "접지")}</option><option value="free">{ko("Free / moving", "해제 / 이동")}</option></select>
					<input aria-label={ko("First frame", "시작 프레임")} type="number" min="0" max={frames - 1} value={start} onChange={(e) => setStart(e.target.value)} />
					<input aria-label={ko("Last frame", "끝 프레임")} type="number" min="0" max={frames - 1} value={end} onChange={(e) => setEnd(e.target.value)} />
				</div>
				<div className="physics-actions"><button className="btn" onClick={() => { setStart(frame); setEnd(frame); }}>{ko("Use playhead", "현재 프레임")}</button><button data-testid="physics-add-contact" className="btn" onClick={add}>{ko("Add interval", "구간 추가")}</button></div>
				{options.overrides.map((o, i) => <div className="physics-row" key={i}><span>{name(o.site)} · {o.start}–{o.end} · {o.mode === "plant" ? ko("Plant", "접지") : ko("Free", "해제")}</span><button className="btn" aria-label={ko("Remove interval", "구간 삭제")} onClick={() => set({ overrides: options.overrides.filter((_, j) => i !== j) })}>×</button></div>)}
				<button data-testid="physics-protect" className="btn full" onClick={() => set({ protectedFrames: [...new Set([...options.protectedFrames, frame])].sort((a, b) => a - b) })}>{ko(`Protect pose at frame ${frame}`, `${frame}프레임 포즈 보호`)}</button>
				{options.protectedFrames.map((f) => <div key={f} className="physics-row"><button className="btn" onClick={() => onFrame(f)}>{ko("Protected", "보호")} F{f}</button><button className="btn" aria-label={ko("Unprotect pose", "포즈 보호 해제")} onClick={() => set({ protectedFrames: options.protectedFrames.filter((p) => p !== f) })}>×</button></div>)}
			</details>
			<button data-testid="physics-analyse" className="btn full primary" onClick={onRun}>{running ? ko(`Analysing ${progress}%`, `분석 중 ${progress}%`) : ko("Analyse & preview", "분석 · 미리보기")}</button>
		</fieldset>
		{running && <progress max="100" value={progress} aria-label={ko("Analysis progress", "분석 진행률")} />}
		{preview && <div data-testid="physics-results">
			<div className="physics-actions"><button data-testid="physics-original" className={`btn ${!show ? "primary" : ""}`} aria-pressed={!show} onClick={() => onShow(false)}>{ko("Original", "원본")}</button><button data-testid="physics-corrected" className={`btn ${show ? "primary" : ""}`} aria-pressed={show} onClick={() => onShow(true)}>{ko("Corrected preview", "보정 미리보기")}</button></div>
			<table><thead><tr><th>{ko("Measured", "실측")}</th><th>{ko("Before", "전")}</th><th>{ko("After", "후")}</th></tr></thead><tbody>
				{[["penetration", ko("Max floor depth", "최대 바닥 관통"), cm], ["meanSlide", ko("Mean contact drift", "평균 접지 밀림"), cm], ["slide", ko("Max contact drift", "최대 접지 밀림"), cm], ["float", ko("Max contact gap", "최대 접지 뜸"), cm], ["kneeStep", ko("Knee step / frame", "무릎 변화 / 프레임"), (x) => `${x.toFixed(1)}°`]].map(([id, label, fmt]) => <tr key={id}><td>{label}</td><td>{fmt(preview.before[id])}</td><td>{fmt(preview.after[id])}</td></tr>)}
			</tbody></table>
			{preview.support && <p className="inspector-hint" data-testid="physics-support-metrics">
				{ko("Unsupported floating frames", "지지 미확인 부유 프레임")}: {preview.before.unsupportedFrames} → {preview.after.unsupportedFrames}<br />
				{ko("Unexplained floating gap", "지지 미확인 뜸")}: {cm(preview.before.unsupportedGap)} → {cm(preview.after.unsupportedGap)}<br />
				{ko("Peak force residual", "최대 잔여 지지력")}: {preview.before.forceResidual.toFixed(2)} → {preview.after.forceResidual.toFixed(2)} BW<br />
				{ko("Peak moment residual", "최대 잔여 회전력")}: {preview.before.momentResidual.toFixed(2)} → {preview.after.momentResidual.toFixed(2)} BW·H<br />
				{ko("Estimated floor support, not measured forces. Hidden props and joint torque limits are not modeled.", "바닥 지지의 근사 추정입니다. 실제 측정 힘이 아니며 숨은 물체·관절 토크 한계는 모델링하지 않아요.")}
			</p>}
			{preview.performance && <p className="inspector-hint" data-testid="physics-timing">{ko("Analysis", "분석")}: {(preview.performance.totalMs / 1000).toFixed(2)}s · {preview.performance.cacheHit ? ko("source measurements reused", "원본 측정 재사용") : ko("source measured", "원본 측정 포함")}{preview.performance.attempts > 1 && <> · {ko(`${preview.performance.attempts} candidates checked`, `${preview.performance.attempts}개 후보 비교`)}</>}</p>}
			<p className="inspector-hint">{ko("Peak knee acceleration", "최대 무릎 각가속도")}: {preview.before.kneeAcceleration.toFixed(0)} → {preview.after.kneeAcceleration.toFixed(0)}°/s²<br />{ko("Peak root acceleration", "최대 골반 가속도")}: {preview.before.rootAcceleration.toFixed(1)} → {preview.after.rootAcceleration.toFixed(1)} m/s²</p>
			<p className="inspector-hint">{preview.after.surfaceMeasured ? ko("Measured on skinned mesh surfaces, not bone height.", "뼈 높이가 아니라 변형된 캐릭터 표면을 측정했어요.") : ko("Surface unavailable: bone proxy only.", "표면 측정 불가: 뼈 기준 대체 측정이에요.")}</p>
			<details><summary>{ko(`${preview.contacts.spans.length} support intervals`, `접지 ${preview.contacts.spans.length}개 구간`)}</summary><div className="physics-list">{preview.contacts.spans.map((s) => <div className="physics-row" key={s.id}><button className="btn" onClick={() => onFrame(s.start)}>{name(s.site)} F{s.start}–{s.end}{s.manual ? " *" : ""}</button><button className="btn" onClick={() => set({ overrides: [...options.overrides, { site: s.site, start: s.start, end: s.end, mode: "free" }] })}>{ko("Free", "해제")}</button></div>)}</div></details>
			<div className={preview.warnings.length || preview.unresolved.length ? "physics-warning" : "inspector-hint"} role="status">
				{preview.warnings.length || preview.unresolved.length ? ko(`${preview.warnings.length} warnings · ${new Set(preview.unresolved.map((r) => r.frame)).size} unresolved contact / support frames`, `경고 ${preview.warnings.length}건 · 접지·지지 역학 미확정 ${new Set(preview.unresolved.map((r) => r.frame)).size}프레임`) : ko("No measured limit exceeded", "측정 기준 초과 없음")}
				{preview.warnings.map((w, i) => <button className="btn full" key={i} onClick={() => onFrame(w.frame)}>{warning(w.reason)} · F{w.frame}</button>)}
				{!!preview.unresolved.length && <button className="btn full" onClick={() => onFrame(preview.unresolved[0].frame)}>{ko("Go to first unresolved contact", "첫 미해결 접지로 이동")}</button>}
				{!!preview.skippedAir?.length && <p>{ko(`${preview.skippedAir.length} flight spans skipped`, `공중 ${preview.skippedAir.length}구간 보류`)}</p>}
				{!!preview.contacts.rejected.length && <button className="btn full" onClick={() => onFrame(preview.contacts.rejected[0].start)}>{ko(`${preview.contacts.rejected.length} moving support intervals rejected`, `움직이는 접지 ${preview.contacts.rejected.length}구간 제외`)}</button>}
			</div>
			<div className="physics-actions"><button data-testid="physics-cancel" className="btn" onClick={onCancel}>{ko("Cancel", "취소")}</button><button data-testid="physics-apply" className="btn primary" disabled={!preview.changedFrames.length || preview.strength === 0} onClick={onApply}>{ko("Apply", "적용")}</button></div>
		</div>}
	</section>;
}
