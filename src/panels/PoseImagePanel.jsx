import { useEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Foldout from "./Foldout.jsx";
import { ko, isKo } from "../locale.js";
import { readReferenceImage } from "./ReferenceImageField.jsx";
import { createHttpTransport } from "../workflow/agent-client.js";
import "./pose-image.css";

// The sidecar accepts at most 6 references per request, shared with the scene's identity and
// environment sheets.
const REFERENCES_MAX = 6;
const USER_REFERENCES_MAX = 4;
const RESULTS_KEPT = 8;

// Module-level so leaving Pose mode (which unmounts the Details pane) keeps the references, the
// prompt, the results and an in-flight generation.
// `shot` is the pinned capture ({ dataUrl, references }): Generate sends exactly what the panel shows.
const store = { source: "view", refs: [], prompt: "", shot: null, results: [], selected: 0, busySince: null, error: "", listeners: new Set() };
function setPoseImageState(patch) {
	Object.assign(store, patch);
	for (const listener of store.listeners) listener();
}

function poseImageErrorMessage(error) {
	if (error?.status === 401 || error?.code === "auth") return ko("Sign in with ChatGPT in the Agent panel first.", "먼저 Agent 패널에서 ChatGPT로 로그인하세요.");
	return isKo ? `생성 실패 — ${error?.message || "알 수 없는 오류"}` : `Generation failed — ${error?.message || "unknown error"}`;
}

async function generatePoseImage(capturePoseImage) {
	const prompt = store.prompt.trim();
	if (!prompt || store.busySince) return;
	const shot = store.shot ?? capturePoseImage?.(store.source);
	if (!shot) { setPoseImageState({ error: ko("The shot renderer is not ready yet.", "샷 렌더러가 아직 준비되지 않았어요.") }); return; }
	const references = [
		...shot.references,
		...store.refs.map((dataUrl, index) => ({ role: "reference", name: String(index + 1), dataUrl })),
	];
	if (references.length > REFERENCES_MAX) {
		setPoseImageState({ shot, error: isKo
			? `참조 이미지는 최대 ${REFERENCES_MAX}장이에요 (인물·환경 참조 ${shot.references.length}장 포함).`
			: `At most ${REFERENCES_MAX} reference images (${shot.references.length} identity/environment included).` });
		return;
	}
	setPoseImageState({ shot, busySince: Date.now(), error: "" });
	try {
		const output = await createHttpTransport().image({ prompt, imageDataUrl: shot.dataUrl, references, composition: "frame", quality: "auto" });
		setPoseImageState({ results: [{ dataUrl: output.dataUrl, prompt, at: Date.now() }, ...store.results].slice(0, RESULTS_KEPT), selected: 0 });
	} catch (error) {
		setPoseImageState({ error: poseImageErrorMessage(error) });
	} finally {
		setPoseImageState({ busySince: null });
	}
}

export default function PoseImagePanel({ hidden, capturePoseImage }) {
	const [, rerender] = useReducer((tick) => tick + 1, 0);
	const [viewing, setViewing] = useState(false);
	const fileRef = useRef(null);
	useEffect(() => {
		store.listeners.add(rerender);
		return () => { store.listeners.delete(rerender); };
	}, []);
	useEffect(() => {
		if (!store.busySince) return undefined;
		const timer = setInterval(rerender, 1000);
		return () => clearInterval(timer);
	}, [store.busySince]);

	const { source, refs, prompt, shot, results, selected, busySince, error } = store;
	const capture = (next = source) => setPoseImageState({ source: next, shot: capturePoseImage?.(next) ?? null });
	const result = results[selected] ?? null;
	const elapsed = busySince ? Math.max(0, Math.round((Date.now() - busySince) / 1000)) : 0;
	const addFiles = async (files) => {
		const room = USER_REFERENCES_MAX - store.refs.length;
		const picked = [...files].filter((file) => file.type.startsWith("image/")).slice(0, room);
		try {
			const read = await Promise.all(picked.map((file) => readReferenceImage(file)));
			setPoseImageState({ refs: [...store.refs, ...read].slice(0, USER_REFERENCES_MAX), error: "" });
		} catch (failure) {
			setPoseImageState({ error: isKo ? `이미지를 불러오지 못했어요 — ${failure.message}` : `Could not load that image — ${failure.message}` });
		}
	};

	return (
		<Foldout hidden={hidden} title={ko("Image from pose", "포즈로 이미지 생성")}>
			<div className="pose-image" data-testid="pose-image">
				<div className="pose-image-frame">
					<div className="pose-image-source" role="radiogroup" aria-label={ko("Frame source", "프레임 시점")}>
						{[["view", ko("Current view", "지금 보는 화면")], ["shot", ko("Shot camera", "샷 카메라")]].map(([id, label]) => (
							<button key={id} type="button" role="radio" aria-checked={source === id} data-active={source === id ? "true" : undefined}
								data-testid={`pose-image-source-${id}`} onClick={() => capture(id)}>{label}</button>
						))}
					</div>
					<div className="pose-image-label">
						<span>{shot ? ko("This frame is sent", "이 프레임으로 생성해요") : source === "view" ? ko("Frame the viewport, then capture", "뷰포트를 맞춘 뒤 캡처") : ko("The shot camera's view", "샷 카메라 시점")}</span>
						<button type="button" className="btn ghost small" data-testid="pose-image-capture" onClick={() => capture()}>
							{shot ? ko("Recapture", "다시 캡처") : ko("Capture", "캡처")}
						</button>
					</div>
					{shot
						? <img className="pose-image-shot" src={shot.dataUrl} alt={ko("The frame sent to the image model", "이미지 모델에 보낼 프레임")} />
						: <p className="inspector-hint">{ko("Not captured yet — Generate captures this view.", "아직 캡처 전 — 생성하면 지금 화면을 캡처해요.")}</p>}
				</div>

				<div className="pose-image-label"><span>{ko("References", "참조 이미지")}</span><small>{refs.length}/{USER_REFERENCES_MAX}</small></div>
				<div className="pose-image-refs"
					onDragOver={(event) => { if (event.dataTransfer?.types?.includes("Files")) event.preventDefault(); }}
					onDrop={(event) => { event.preventDefault(); addFiles(event.dataTransfer?.files ?? []); }}>
					{refs.map((dataUrl, index) => (
						<div key={index} className="pose-image-ref">
							<img src={dataUrl} alt={isKo ? `참조 ${index + 1}` : `Reference ${index + 1}`} />
							<button type="button" className="pose-image-ref-remove" aria-label={ko("Remove reference", "참조 삭제")}
								onClick={() => setPoseImageState({ refs: store.refs.filter((_, at) => at !== index) })}>×</button>
						</div>
					))}
					{refs.length < USER_REFERENCES_MAX && (
						<button type="button" className="pose-image-ref pose-image-ref-add" data-testid="pose-image-add-ref"
							title={ko("Add a reference picture (or drop one here)", "참조 이미지 추가 (여기로 끌어놓아도 돼요)")}
							onClick={() => fileRef.current?.click()}>＋</button>
					)}
				</div>
				<input ref={fileRef} type="file" accept="image/*" multiple className="multimodel-file-input" data-testid="pose-image-ref-input"
					onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ""; addFiles(files); }} />

				<textarea
					className="pose-image-prompt"
					data-testid="pose-image-prompt"
					rows={3}
					value={prompt}
					placeholder={ko("Describe the image — e.g. a knight in silver armour, dusk light, cinematic", "어떤 이미지인지 적어 주세요 — 예: 은빛 갑옷의 기사, 해질녘 빛, 영화 같은 톤")}
					onChange={(event) => setPoseImageState({ prompt: event.target.value })}
					onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); generatePoseImage(capturePoseImage); } }}
				/>
				<button type="button" className="btn primary full" data-testid="pose-image-generate"
					disabled={!prompt.trim() || Boolean(busySince)}
					onClick={() => generatePoseImage(capturePoseImage)}>
					{busySince ? (isKo ? `생성 중… ${elapsed}초` : `Generating… ${elapsed}s`) : ko("Generate image", "이미지 생성")}
				</button>
				{error && <p className="inspector-hint pose-image-error" role="status" data-testid="pose-image-error">{error}</p>}

				{result && (
					<div className="pose-image-result" data-testid="pose-image-result">
						<button type="button" className="pose-image-result-open" data-testid="pose-image-open"
							title={ko("View larger", "크게 보기")} onClick={() => setViewing(true)}>
							<img src={result.dataUrl} alt={result.prompt} />
						</button>
						<div className="pose-image-result-actions">
							<a className="btn ghost small" href={result.dataUrl} download={`cozyclay-pose-${result.at}.png`}>{ko("Download", "다운로드")}</a>
							<button type="button" className="btn ghost small" disabled={refs.length >= USER_REFERENCES_MAX}
								onClick={() => setPoseImageState({ refs: [...store.refs, result.dataUrl].slice(0, USER_REFERENCES_MAX) })}>
								{ko("Use as reference", "참조로 쓰기")}
							</button>
						</div>
						{results.length > 1 && (
							<div className="pose-image-history">
								{results.map((entry, index) => (
									<button key={entry.at} type="button" data-active={index === selected ? "true" : undefined}
										title={entry.prompt} onClick={() => setPoseImageState({ selected: index })}>
										<img src={entry.dataUrl} alt="" />
									</button>
								))}
							</div>
						)}
					</div>
				)}
			</div>
			{viewing && result && createPortal(
				<PoseImageViewer results={results} selected={selected} onSelect={(index) => setPoseImageState({ selected: index })} onClose={() => setViewing(false)} />,
				document.body,
			)}
		</Foldout>
	);
}

function PoseImageViewer({ results, selected, onSelect, onClose }) {
	const entry = results[selected];
	useEffect(() => {
		const onKey = (event) => {
			if (event.key === "Escape") onClose();
			else if (event.key === "ArrowLeft" && selected < results.length - 1) onSelect(selected + 1);
			else if (event.key === "ArrowRight" && selected > 0) onSelect(selected - 1);
			else return;
			event.preventDefault();
			event.stopPropagation();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [results.length, selected, onSelect, onClose]);
	return (
		<div className="pose-image-viewer" role="dialog" aria-modal="true" aria-label={ko("Generated image", "생성된 이미지")} data-testid="pose-image-viewer"
			onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
			<figure className="pose-image-viewer-body">
				<img src={entry.dataUrl} alt={entry.prompt} />
				<figcaption>
					<span className="pose-image-viewer-prompt">{entry.prompt}</span>
					{results.length > 1 && <span className="pose-image-viewer-count">{results.length - selected}/{results.length}</span>}
					<a className="btn ghost small" href={entry.dataUrl} download={`cozyclay-pose-${entry.at}.png`}>{ko("Download", "다운로드")}</a>
					<button type="button" className="btn ghost small" data-testid="pose-image-viewer-close" onClick={onClose}>{ko("Close", "닫기")}</button>
				</figcaption>
			</figure>
			{selected < results.length - 1 && <button type="button" className="pose-image-viewer-nav prev" aria-label={ko("Older", "이전")} onClick={() => onSelect(selected + 1)}>‹</button>}
			{selected > 0 && <button type="button" className="pose-image-viewer-nav next" aria-label={ko("Newer", "다음")} onClick={() => onSelect(selected - 1)}>›</button>}
		</div>
	);
}
