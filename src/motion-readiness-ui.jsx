import { ko } from "./locale.js";

export function motionReadinessMessage(state) {
	switch (state) {
		case "loading": return ko("Checking motion generation…", "모션 생성 연결 확인 중…");
		case "ready": return ko("Ready for this motion request", "이 모션 요청을 실행할 수 있어요");
		case "not_configured": return ko("No motion backend configured", "모션 백엔드가 설정되지 않았어요");
		case "unsupported_route": return ko("This route cannot run the selected motion request", "현재 경로는 이 모션 요청을 지원하지 않아요");
		default: return ko("The motion backend is unavailable", "모션 백엔드를 사용할 수 없어요");
	}
}

export function MotionReadiness({ state, checking, onSetup, onRetry }) {
	const unavailable = state === "unavailable";
	return (
		<div className="motion-readiness" data-state={state} aria-busy={checking || state === "loading"}>
			<span role="status">{motionReadinessMessage(state)}</span>
			{state !== "ready" && state !== "loading" && (
				<button
					type="button"
					className="btn ghost"
					data-testid="motion-readiness-action"
					disabled={checking}
					onClick={unavailable ? onRetry : () => onSetup()}
				>
					{checking ? ko("Checking…", "확인 중…")
						: unavailable ? ko("Retry connection", "연결 다시 확인")
							: state === "unsupported_route" ? ko("Switch route in Settings", "설정에서 경로 변경")
								: ko("Open Settings", "설정 열기")}
				</button>
			)}
		</div>
	);
}

export function MotionSetup({ state, checking, onRetry }) {
	const localStudio = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
	const port = localStudio ? window.location.port || "5180" : "5180";
	return (
		<section className="motion-setup" data-testid="motion-setup" data-state={state} aria-label={ko("Motion generation setup", "모션 생성 설정")}>
			<p role="status">{motionReadinessMessage(state)}</p>
			<p>{ko(
				"Motion generation is optional. Sample motion, camera editing and exports work without it. Your scene and prompt blocks stay here while you set it up.",
				"모션 생성은 선택 사항이에요. 연결 없이도 샘플 모션, 카메라 편집, 내보내기를 쓸 수 있어요. 설정하는 동안 씬과 프롬프트 블록은 그대로 유지됩니다.",
			)}</p>
			<p>{ko("Use an existing Kimodo host, then restart your local launcher with:", "기존 Kimodo 호스트를 사용하려면 로컬 실행기에 다음 환경변수를 설정하세요:")}</p>
			<code>{`CCLAY_KIMODO_HOST=user@your-gpu-box npx cozyclay --port ${port} --no-open`}</code>
			<p>{localStudio ? ko(
				"Keep this tab open. After restarting the bridge on the same port, retry the connection below.",
				"이 탭은 열어 두세요. 같은 포트에서 브리지를 다시 시작한 뒤 아래에서 연결을 확인하세요.",
			) : ko(
				"New generation runs in the local Studio. Save your project here, then open that file in the local Studio to carry over your edits.",
				"새 모션 생성은 로컬 Studio에서 실행해요. 여기서 프로젝트를 저장하고 로컬 Studio에서 그 파일을 열면 편집 내용을 이어갈 수 있어요.",
			)}</p>
			<p>{ko(
				"Local MLX/cpp supports one unconstrained prompt. Sequencing, pinned poses, paths and preserve need the CUDA/SSH route. Line editing needs a configured ProjFlow route.",
				"로컬 MLX/cpp는 제약 없는 단일 프롬프트를 지원해요. 블록 연결, 포즈 고정, 경로, 테이크 보존에는 CUDA/SSH가 필요하고, 라인 편집에는 ProjFlow 설정이 필요해요.",
			)}</p>
			<a href="https://github.com/NomaDamas/CozyClay/blob/main/docs/kimodo-setup.md" target="_blank" rel="noreferrer">
				{ko("Kimodo setup and route guide", "Kimodo 설정 및 경로 안내")}
			</a>
			<button type="button" className="btn" data-testid="motion-health-retry" disabled={checking} onClick={onRetry}>
				{checking ? ko("Checking…", "확인 중…") : ko("Recheck connection", "연결 다시 확인")}
			</button>
		</section>
	);
}
