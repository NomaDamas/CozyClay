import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
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
		// The control lives in another region than the card, so the card says
		// which way to look before it says what to do.
		where: ko("↓ Timeline, Shots lane", "↓ 타임라인 샷 레인"),
		how: () => ko(
			<>In the timeline's Shots lane click <b>+ Add shot</b>. That is your cut.</>,
			<>타임라인의 샷 레인에서 <b>+ 샷 추가</b>를 누르세요. 그게 컷입니다.</>,
		),
	},
	{
		kind: "rail",
		label: ko("Rail", "레일"),
		where: ko("↓ Timeline, Shots lane", "↓ 타임라인 샷 레인"),
		how: () => ko(
			<>Select the shot, click <b>Draw rail</b> in the camera bar, and drag a line across the top view. That line is the dolly move.</>,
			<>샷을 선택하고 카메라 바의 <b>레일 그리기</b>를 누른 뒤, 탑뷰에 선을 그으세요. 그 선이 돌리 이동입니다.</>,
		),
	},
	{
		kind: "play",
		label: ko("Play", "재생"),
		where: ko("→ Viewport", "→ 뷰포트"),
		how: () => ko(
			<>Click the look-through button in the viewport to see the shot camera; <b>▶</b> rides the rail, <kbd>Esc</kbd> returns to the free camera.</>,
			<>뷰포트의 시점 보기 버튼을 눌러 샷 카메라를 보세요. <b>▶</b>는 레일을 타고, <kbd>Esc</kbd>로 자유 카메라로 돌아옵니다.</>,
		),
	},
];

const NAV_KINDS = new Set(["fly", "walk", "dolly", "orbit"]);
const SIGNAL_KINDS = new Set(["shot", "rail"]);

/* ------------------------------------------------------------- beacons --- */

// Where each of the last three steps actually happens (#211). The card names
// the gesture; these pin a numbered circle and a caption onto the control
// itself, so "click + Add shot" stops being a treasure hunt across two panes.
//
// `absent`/`requires` gate a beacon on the studio's own state instead of on
// tutorial bookkeeping: the camera bar (.tl-rail-draw) only exists once a shot
// is selected, which is exactly the moment the rail step's advice changes.
export const TUTORIAL_BEACONS = {
	shot: [
		{ role: "add-shot", selector: ".tl-track.shots .tl-track-add", label: () => ko("Click here", "여기를 클릭") },
	],
	rail: [
		{
			role: "select-shot",
			selector: ".tl-track.shots .tl-shot-block:not(.selected)",
			absent: ".tl-rail-draw",
			label: () => ko("1. Select the shot", "1. 샷을 선택"),
		},
		{ role: "draw-rail", selector: ".tl-rail-draw", label: () => ko("2. Draw rail, then drag across the top view", "2. 레일 그리기 후 탑뷰에 선 긋기") },
		{ role: "top-view", selector: ".vp-inset", requires: ".tl-rail-draw", label: () => ko("Drag a line here", "여기에 선을 그으세요") },
	],
	play: [
		{ role: "look-through", selector: ".vp-look-through", label: () => ko("Click to look through the shot camera", "클릭해 샷 카메라로 보기") },
	],
};

/** the beacon's own geometry, in px — the circle sits above-left of the target */
const DOT = 22;
const LIFT_X = 30;
const LIFT_Y = 44;
/** nominal box used only for edge clamping; the chip itself is auto-sized */
const BEACON_W = 190;
const BEACON_H = 26;

const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

const boxOf = (element) => {
	if (!element) return null;
	const box = element.getBoundingClientRect();
	if (box.width < 2 || box.height < 2) return null;
	if (box.right < 0 || box.bottom < 0 || box.left > window.innerWidth || box.top > window.innerHeight) return null;
	return box;
};

/** first element matching `selector` that is actually laid out on screen */
const firstVisible = (selector) => {
	if (!selector) return null;
	for (const element of document.querySelectorAll(selector)) {
		const box = boxOf(element);
		if (box) return { element, box };
	}
	return null;
};

const round = (value) => Math.round(value * 2) / 2;

/**
 * Place the beacon above-left of the target and clamp it inside whatever
 * scrolls the target (the timeline body, or the viewport pane). The leader
 * line is aimed at the real target, so a shot block scrolled past the lane's
 * edge still gets an arrow pointing off toward it.
 *
 * Above is the default; when the target hugs the top of its own pane — the
 * camera bar under the transport row, the Top-View inset under the titlebar —
 * the beacon flips below rather than sitting on the pane's header controls.
 */
function place(element, box) {
	const clip = element.closest(".tl-body, .timeline, .viewport")?.getBoundingClientRect();
	const edge = Math.min(14, box.height / 2);
	const above = box.top + edge - LIFT_Y - DOT / 2;
	const flip = above < (clip ? clip.top : 0) + BEACON_H;
	const aimX = box.left + Math.min(18, box.width / 2);
	const aimY = flip ? box.bottom - edge : box.top + edge;
	const minLeft = Math.max(8, clip ? clip.left + 6 : 8);
	const maxLeft = Math.max(minLeft, Math.min(window.innerWidth - 8, clip ? clip.right - 6 : window.innerWidth - 8) - BEACON_W);
	const left = Math.min(Math.max(aimX - LIFT_X - DOT / 2, minLeft), maxLeft);
	const top = Math.min(Math.max(flip ? aimY + LIFT_Y - DOT / 2 : above, 8), Math.max(8, window.innerHeight - 46));
	return { left: round(left), top: round(top), aimX: round(aimX - left), aimY: round(aimY - top) };
}

const samePlace = (a, b) => !!a && !!b && a.left === b.left && a.top === b.top && a.aimX === b.aimX && a.aimY === b.aimY;

/**
 * One numbered circle plus a caption chip, portalled to <body> and pinned to a
 * live control. It measures on mount, on resize, on scroll, on a
 * ResizeObserver of the timeline and viewport, and on any DOM mutation — the
 * camera bar mounts only after a shot is selected, so "target not there yet"
 * is the normal case, not an error. Pointer-transparent: the control it points
 * at must stay clickable through it.
 */
export function TutorialBeacon({ kind, step, role, selector, label, requires = null, absent = null }) {
	const [spot, setSpot] = useState(null);

	useEffect(() => {
		let frame = 0;
		const measure = () => {
			frame = 0;
			if (absent && firstVisible(absent)) return setSpot(null);
			if (requires && !firstVisible(requires)) return setSpot(null);
			const found = firstVisible(selector);
			if (!found) return setSpot(null);
			const next = place(found.element, found.box);
			// Same numbers means no re-render, which keeps the MutationObserver
			// below from chasing this component's own portal forever.
			setSpot((prev) => (samePlace(prev, next) ? prev : next));
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(measure);
		};
		measure();
		window.addEventListener("resize", schedule);
		window.addEventListener("scroll", schedule, true);
		const resize = new ResizeObserver(schedule);
		for (const pane of [document.querySelector(".timeline"), document.querySelector(".viewport")]) {
			if (pane) resize.observe(pane);
		}
		const mutations = new MutationObserver(schedule);
		mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
		return () => {
			if (frame) cancelAnimationFrame(frame);
			window.removeEventListener("resize", schedule);
			window.removeEventListener("scroll", schedule, true);
			resize.disconnect();
			mutations.disconnect();
		};
	}, [selector, requires, absent]);

	if (!spot) return null;
	return createPortal(
		<div
			className="tutorial-beacon"
			data-testid="camera-tutorial-beacon"
			data-kind={kind}
			data-role={role}
			style={{ left: `${spot.left}px`, top: `${spot.top}px` }}
		>
			<svg className="tutorial-beacon-leader" aria-hidden="true">
				<line x1={DOT / 2} y1={DOT / 2} x2={spot.aimX} y2={spot.aimY} />
			</svg>
			<span className="tutorial-beacon-dot" aria-hidden="true">{step}</span>
			<span className="tutorial-beacon-label">{label()}</span>
		</div>,
		document.body,
	);
}

/* -------------------------------------------------------- gesture cues --- */

// Steps 1–4 have no control to point at: the gesture IS the interface. The cue
// draws the mouse and the keys the step wants, animated the way the hand is
// supposed to move, and sits centre-bottom of the viewport where the eye
// already is while flying.
const GESTURE_CAPTIONS = {
	fly: () => ko("Right-drag to look", "오른쪽 끌어 둘러보기"),
	walk: () => ko("Hold right, press keys", "오른쪽 누른 채 키 입력"),
	dolly: () => ko("Scroll to push in", "스크롤로 밀고 당기기"),
	orbit: () => ko("Alt + left-drag to circle", "Alt+왼쪽 끌어 돌기"),
};

function MouseGlyph() {
	return (
		<svg className="tutorial-cue-mouse" viewBox="0 0 40 58" aria-hidden="true">
			<rect className="cue-mouse-body" x="4" y="3" width="32" height="52" rx="16" />
			<path className="cue-mouse-left" d="M20 3 A16 16 0 0 0 4 19 L20 19 Z" />
			<path className="cue-mouse-right" d="M20 3 A16 16 0 0 1 36 19 L20 19 Z" />
			<rect className="cue-mouse-wheel" x="17.5" y="8" width="5" height="11" rx="2.5" />
		</svg>
	);
}

/**
 * The animated gesture glyph for one nav step. `leaving` starts the fade; the
 * parent unmounts it when the opacity transition ends, so the cue never blinks
 * out mid-step. Under prefers-reduced-motion the glyph is static (styles.css)
 * and the parent drops it outright.
 */
export function GestureCue({ kind, walked, leaving = false, onLeft }) {
	const caption = GESTURE_CAPTIONS[kind]?.() ?? "";
	return (
		<div
			className="tutorial-cue"
			data-testid="camera-tutorial-gesture"
			data-kind={kind}
			data-leaving={leaving ? 1 : 0}
			aria-hidden="true"
			onTransitionEnd={(event) => {
				if (leaving && event.propertyName === "opacity" && event.target === event.currentTarget) onLeft?.();
			}}
		>
			<div className="tutorial-cue-stage">
				{kind === "orbit" && <span className="tutorial-cue-key">Alt</span>}
				<span className="tutorial-cue-arm">
					<MouseGlyph />
					{kind === "fly" && (
						<svg className="tutorial-cue-arc" viewBox="0 0 64 20" aria-hidden="true">
							<path className="cue-arc-line" d="M8 14 Q32 3 56 14" />
							<path className="cue-arc-head" d="M13 9 L7 14 L14 17" />
							<path className="cue-arc-head" d="M51 9 L57 14 L50 17" />
						</svg>
					)}
				</span>
				{kind === "orbit" && <span className="tutorial-cue-pivot" />}
				{kind === "dolly" && (
					<svg className="tutorial-cue-updown" viewBox="0 0 14 44" aria-hidden="true">
						<path className="cue-up" d="M7 16 L7 4 M3 8 L7 4 L11 8" />
						<path className="cue-down" d="M7 28 L7 40 M3 36 L7 40 L11 36" />
					</svg>
				)}
			</div>
			{kind === "walk" && (
				<span className="tutorial-cue-keys">
					{WALK_KEYS.map((walkKey) => (
						<kbd key={walkKey} data-done={walked?.has(walkKey) ? 1 : 0}>{walkKey.toUpperCase()}</kbd>
					))}
				</span>
			)}
			<span className="tutorial-cue-caption">{caption}</span>
		</div>
	);
}

/**
 * The overlay itself: a seven-chip strip plus one hint card for the step the
 * operator is on. It sits at the top of the viewport pane, left of the
 * Top-View inset, and never takes the pointer except on its own close button
 * — every step is completed by working the studio underneath it.
 */
export function CameraTutorial({ previewing = false, onStepChange, onClose }) {
	const [done, setDone] = useState(() => new Set());
	const [walked, setWalked] = useState(() => new Set());
	const [cue, setCue] = useState(null);

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
	const currentKind = current?.kind ?? null;

	// The step the operator is on is the studio's business too: App puts it on
	// the .app root as data-tutorial-step, and styles.css spotlights whichever
	// control that step needs (#211).
	useEffect(() => {
		onStepChange?.(currentKind);
	}, [currentKind, onStepChange]);
	useEffect(() => () => onStepChange?.(null), [onStepChange]);

	// Steps 1–4 carry a gesture cue instead of a beacon. It fades out when its
	// step completes rather than vanishing under the hand that just finished it.
	useEffect(() => {
		if (currentKind && NAV_KINDS.has(currentKind)) {
			setCue({ kind: currentKind, leaving: false });
			return;
		}
		setCue((prev) => {
			if (!prev) return prev;
			if (reducedMotion()) return null;
			return prev.leaving ? prev : { ...prev, leaving: true };
		});
	}, [currentKind]);

	return (
	<>
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
						<p>
							{current.where && <span className="camera-tutorial-where">{current.where}</span>}
							{current.how({ walked })}
						</p>
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
		{cue && (
			<GestureCue
				kind={cue.kind}
				walked={walked}
				leaving={cue.leaving}
				onLeft={() => setCue((prev) => (prev?.leaving ? null : prev))}
			/>
		)}
		{(TUTORIAL_BEACONS[currentKind] ?? []).map((beacon) => (
			<TutorialBeacon
				key={beacon.role}
				kind={currentKind}
				step={CAMERA_TUTORIAL_STEPS.indexOf(current) + 1}
				role={beacon.role}
				selector={beacon.selector}
				label={beacon.label}
				requires={beacon.requires ?? null}
				absent={beacon.absent ?? null}
			/>
		))}
	</>
	);
}

export default CameraTutorial;
