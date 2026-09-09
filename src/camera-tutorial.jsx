import { useEffect, useMemo, useState } from "react";
import { ko } from "./locale.js";

// The camera tutorial, Studio-native (#206).
//
// The landing page runs the same seven steps against the playground iframe
// (index.html), where the studio is a black box and every signal crosses the
// frame boundary as a postMessage. Inside /app/ there is no frame: the
// gestures already announce themselves on `window`, so this component listens
// to them directly.
//
//   cozyclay:nav               fly / walk / dolly / orbit  (src/controls.jsx)
//   cozyclay:playground-signal shot / rail                 (src/App.jsx)
//   previewing prop            play                        (lookThroughShot)
//
// Nothing here drives the studio. A step is done when the operator has done
// the thing in the real tool — there is no "next" button to fake progress
// with, which is the whole point of teaching a camera by flying it.

/** Right-button + these six keys is one gesture, so the walk step only counts
 * once every key has actually been pressed (the landing page's rule). */
export const WALK_KEYS = ["w", "a", "s", "d", "q", "e"];

export const CAMERA_TUTORIAL_STEPS = [
	{
		kind: "fly",
		label: ko("Look", "보기"),
		how: () => ko(
			"Right-drag in the viewport to look around.",
			"뷰포트에서 오른쪽 버튼을 끌어 주위를 둘러보세요.",
		),
	},
	{
		kind: "walk",
		label: ko("Walk", "걷기"),
		how: ({ walked }) => {
			const keys = (
				<span className="camera-tutorial-keys">
					{WALK_KEYS.map((key) => (
						<kbd key={key} data-key={key} data-done={walked.has(key) ? 1 : 0}>{key.toUpperCase()}</kbd>
					))}
				</span>
			);
			return ko(
				<>Hold the right button and press each key once: {keys} W A S D walk, Q E crane.</>,
				<>오른쪽 버튼을 누른 채 각 키를 한 번씩 누르세요: {keys} W A S D 이동, Q E 크레인.</>,
			);
		},
	},
	{
		kind: "dolly",
		label: ko("Dolly", "돌리"),
		how: () => ko(
			"Scroll in the viewport to push in and pull out.",
			"뷰포트에서 스크롤해 앞뒤로 밀고 당겨 보세요.",
		),
	},
	{
		kind: "orbit",
		label: ko("Orbit", "궤도"),
		how: () => ko(
			<>Hold <kbd>Alt</kbd> (<kbd>⌥ Option</kbd> on Mac) and left-drag to circle the character.</>,
			<><kbd>Alt</kbd>(맥은 <kbd>⌥ Option</kbd>)을 누른 채 왼쪽 버튼을 끌어 캐릭터 주위를 도세요.</>,
		),
	},
	{
		kind: "shot",
		label: ko("Shot", "샷"),
		how: () => ko(
			<>In the timeline's Shots lane click <b>+ Add shot</b>. That is your cut.</>,
			<>타임라인의 샷 레인에서 <b>+ 샷 추가</b>를 누르세요. 그게 컷입니다.</>,
		),
	},
	{
		kind: "rail",
		label: ko("Rail", "레일"),
		how: () => ko(
			<>Select the shot, click <b>Draw rail</b> in the camera bar, and drag a line across the top view. That line is the dolly move.</>,
			<>샷을 선택하고 카메라 바의 <b>레일 그리기</b>를 누른 뒤, 탑뷰에 선을 그으세요. 그 선이 돌리 이동입니다.</>,
		),
	},
	{
		kind: "play",
		label: ko("Play", "재생"),
		how: () => ko(
			<>Click the look-through button in the viewport to see the shot camera; <b>▶</b> rides the rail, <kbd>Esc</kbd> returns to the free camera.</>,
			<>뷰포트의 시점 보기 버튼을 눌러 샷 카메라를 보세요. <b>▶</b>는 레일을 타고, <kbd>Esc</kbd>로 자유 카메라로 돌아옵니다.</>,
		),
	},
];

const NAV_KINDS = new Set(["fly", "walk", "dolly", "orbit"]);
const SIGNAL_KINDS = new Set(["shot", "rail"]);

/**
 * The overlay itself: a seven-chip strip plus one hint card for the step the
 * operator is on. It sits at the top of the viewport pane, left of the
 * Top-View inset, and never takes the pointer except on its own close button
 * — every step is completed by working the studio underneath it.
 */
export function CameraTutorial({ previewing = false, onClose }) {
	const [done, setDone] = useState(() => new Set());
	const [walked, setWalked] = useState(() => new Set());

	useEffect(() => {
		const complete = (kind) => setDone((current) => (current.has(kind) ? current : new Set(current).add(kind)));
		const onNav = (event) => {
			const kind = event.detail?.kind;
			if (!NAV_KINDS.has(kind)) return;
			if (kind !== "walk") {
				complete(kind);
				return;
			}
			const key = typeof event.detail?.key === "string" ? event.detail.key.toLowerCase() : null;
			if (!WALK_KEYS.includes(key)) return;
			setWalked((current) => {
				if (current.has(key)) return current;
				const next = new Set(current).add(key);
				if (WALK_KEYS.every((walkKey) => next.has(walkKey))) complete("walk");
				return next;
			});
		};
		const onSignal = (event) => {
			if (SIGNAL_KINDS.has(event.detail?.kind)) complete(event.detail.kind);
		};
		window.addEventListener("cozyclay:nav", onNav);
		window.addEventListener("cozyclay:playground-signal", onSignal);
		return () => {
			window.removeEventListener("cozyclay:nav", onNav);
			window.removeEventListener("cozyclay:playground-signal", onSignal);
		};
	}, []);

	// The player is the last step, and only once there is a rail to ride:
	// look-through before the dolly exists shows a still frame, which teaches
	// nothing about the move.
	useEffect(() => {
		if (!previewing) return;
		setDone((current) => (!current.has("rail") || current.has("play") ? current : new Set(current).add("play")));
	}, [previewing]);

	const current = useMemo(() => CAMERA_TUTORIAL_STEPS.find((step) => !done.has(step.kind)) ?? null, [done]);
	const complete = current === null;

	return (
		<aside
			className="camera-tutorial"
			data-testid="camera-tutorial"
			data-state={complete ? "done" : "active"}
			data-previewing={previewing ? 1 : 0}
			aria-label={ko("Camera tutorial", "카메라 튜토리얼")}
		>
			<ol className="camera-tutorial-steps">
				{CAMERA_TUTORIAL_STEPS.map((step, index) => (
					<li
						key={step.kind}
						data-testid="camera-tutorial-step"
						data-kind={step.kind}
						data-done={done.has(step.kind) ? 1 : 0}
						data-current={step === current ? 1 : 0}
					>
						<i aria-hidden="true">{done.has(step.kind) ? "✓" : index + 1}</i>
						{step.label}
					</li>
				))}
			</ol>
			<div className="camera-tutorial-card" data-testid="camera-tutorial-card" role="status">
				{complete ? (
					<>
						<span className="camera-tutorial-count done">{ko("Done", "완료")}</span>
						<p>{ko(
							"That is the whole camera: look, walk, dolly, orbit, cut, rail, play.",
							"카메라의 전부입니다: 보기, 걷기, 돌리, 궤도, 컷, 레일, 재생.",
						)}</p>
					</>
				) : (
					<>
						<span className="camera-tutorial-count">{`${CAMERA_TUTORIAL_STEPS.indexOf(current) + 1} / ${CAMERA_TUTORIAL_STEPS.length}`}</span>
						<p>{current.how({ walked })}</p>
					</>
				)}
			</div>
			<button
				type="button"
				className="camera-tutorial-close"
				data-testid="camera-tutorial-close"
				aria-label={ko("Close tutorial", "튜토리얼 닫기")}
				title={ko("Close tutorial", "튜토리얼 닫기")}
				onClick={() => onClose?.()}
			>
				×
			</button>
		</aside>
	);
}

export default CameraTutorial;
