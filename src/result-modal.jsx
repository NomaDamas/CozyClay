import { ko, isKo } from "./locale.js";

export default function ResultModal({ result, copied, recordedVideoName, onClose, onCopy, onDownload, downloadDisabled = false, exportFeedback = null }) {
	const isVideo = result.mode === "video";
	const modelLabel = result.modelLabel ?? (isVideo ? ko("your AI video tool", "AI 영상 도구") : ko("your selected image model", "선택한 이미지 모델"));
	const hasFrame = Boolean(result.frame);

	let nextStep;
	if (isVideo && result.frameB) {
		nextStep = (
			<p>
				{ko(`Paste the prompt into ${modelLabel}, set `, `${modelLabel}에 프롬프트를 붙여 넣고 `)}
				<code>blocking-frame-A-start.png</code>
				{ko(" as the start frame, and ", "를 시작 프레임으로, ")}
				<code>blocking-frame-B-end.png</code>
				{ko(" as the end frame.", "를 끝 프레임으로 설정하세요.")}
			</p>
		);
	} else if (isVideo && hasFrame) {
		nextStep = (
			<p>
				{ko(`Paste the prompt into ${modelLabel} and attach `, `${modelLabel}에 프롬프트를 붙여 넣고 `)}
				<code>blocking-frame.png</code>
				{ko(" as the reference frame.", "를 참고 프레임으로 첨부하세요.")}
			</p>
		);
	} else if (hasFrame) {
		nextStep = (
			<p>
				{ko(`Paste the prompt into ${modelLabel} and attach `, `${modelLabel}에 프롬프트를 붙여 넣고 `)}
				<code>blocking-frame.png</code>
				{ko(" as the reference image.", "를 참고 이미지로 첨부하세요.")}
			</p>
		);
	} else {
		nextStep = <p>{ko(`Paste the copied prompt into ${modelLabel} to create the scene.`, `복사한 프롬프트를 ${modelLabel}에 붙여 넣어 장면을 만드세요.`)}</p>;
	}

	return (
		<div className="modal-overlay" onClick={onClose}>
			<div className="modal result-modal" role="dialog" aria-modal="true" aria-labelledby="result-title" onClick={(event) => event.stopPropagation()}>
				<div className="modal-head">
					<h3 id="result-title">{ko("Your shot is ready", "장면이 준비됐어요")}</h3>
					<button type="button" className="x" onClick={onClose} aria-label={ko("Close the result", "결과 닫기")}>
						✕
					</button>
				</div>
				{result.frameB ? (
					<div className="move-frames">
						<figure>
							<img className="preview" src={result.frame} alt={ko("Camera move start frame", "카메라 움직임 시작 프레임")} />
							<figcaption>A · {ko("Start", "시작")}</figcaption>
						</figure>
						<figure>
							<img className="preview" src={result.frameB} alt={ko("Camera move end frame", "카메라 움직임 끝 프레임")} />
							<figcaption>B · {ko("End", "끝")}</figcaption>
						</figure>
					</div>
				) : (
					result.frame && <img className="preview" src={result.frame} alt={ko("Finished scene frame", "완성된 장면 프레임")} />
				)}
				{result.move && (
					<div className="move-slate result-move-slate">
						<span>{result.move.displaySlate ?? result.move.slate} · {isKo ? `${result.move.spanS}초` : `${result.move.spanS}s`}</span>
						<small>{ko("Camera move made from timeline keyframes", "타임라인 키프레임으로 만든 카메라 움직임")}</small>
					</div>
				)}
				<label className="modal-label">{ko("Prompt", "프롬프트")} {copied && <em>· {ko("copied", "복사됨")}</em>}</label>
				<div className="promptbox">{result.prompt}</div>
				<div className="modal-actions">
					<button type="button" className="btn" onClick={onCopy}>
						{copied ? ko("Copied ✓", "복사됨 ✓") : ko("Copy prompt", "프롬프트 복사")}
					</button>
					{result.frame && (
						<button type="button" className="btn" onClick={onDownload} disabled={downloadDisabled}>
							{result.downloaded ? ko("Download requested", "다운로드 요청됨") : result.frameB ? ko("Download start and end frames", "시작·끝 프레임 다운로드") : ko("Download frame", "프레임 다운로드")}
						</button>
					)}
				</div>

				{exportFeedback}
				<section className="result-next" aria-labelledby="result-next-title">
					<span className="result-next-kicker">{ko(`Next · ${modelLabel}`, `다음 · ${modelLabel}`)}</span>
					<h4 id="result-next-title">{ko("Handing off to your AI", "AI에 넣는 순서")}</h4>
					<div className="result-next-intro">{nextStep}</div>
					<ol className="result-handoff-steps">
						<li>
							<strong>{ko("Copy the prompt", "프롬프트 복사")}</strong>
							<span>{copied ? ko("Copied. Paste it into your AI service's prompt box.", "복사됐어요. AI 서비스의 입력창에 붙여 넣으세요.") : ko("Press “Copy prompt” above, then paste it into your AI service.", "위의 ‘프롬프트 복사’를 누른 뒤 AI 서비스 입력창에 붙여 넣으세요.")}</span>
						</li>
						<li>
							<strong>{ko("Download the frame", "프레임 다운로드")}</strong>
							<span>{result.frameB ? ko("Press “Download start and end frames” to save both PNGs.", "‘시작·끝 프레임 다운로드’를 눌러 두 PNG를 저장하세요.") : hasFrame ? ko("Press “Download frame” to save the PNG.", "‘프레임 다운로드’를 눌러 PNG를 저장하세요.") : ko("This result has no frame to download.", "이 결과에는 내려받을 프레임이 없어요.")}</span>
						</li>
						<li>
							<strong>{ko("Attach the image to your AI", "AI에 이미지 첨부")}</strong>
							<span>{result.frameB ? ko("Use your AI service's image attach button to upload the start and end frames together.", "AI 서비스의 이미지 첨부 버튼에서 시작 프레임과 끝 프레임을 함께 올리세요.") : ko("Use your AI service's image attach button to upload blocking-frame.png.", "AI 서비스의 이미지 첨부 버튼에서 blocking-frame.png를 올리세요.")}</span>
						</li>
					</ol>
					<p className="result-handoff-note">
						{ko("The prompt describes the scene's content and mood; the frame shows the camera framing. Use both to reproduce this scene as closely as possible.", "프롬프트는 장면의 내용과 분위기를 설명하고, 프레임은 카메라 구도를 보여줘요. 둘을 함께 넣어야 이 장면을 가장 가깝게 재현할 수 있어요.")}
					</p>
					{recordedVideoName && (
						<p className="result-reference-video">
							<strong>{ko("Optional · Reference video", "선택 사항 · 참고 영상")}</strong>
							{ko("A video recorded with the recording feature: ", "녹화 기능으로 만든 ")}<code>{recordedVideoName}</code>{ko(" file. Use it separately from the reference frame in the prompt above.", " 파일이에요. 위의 프롬프트 참고 프레임과는 별도로 활용하세요.")}
						</p>
					)}
				</section>
			</div>
		</div>
	);
}
