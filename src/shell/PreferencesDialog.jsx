import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getAnalyticsOptOut, setAnalyticsOptOut } from "../analytics.js";
import { loadAutoColor, saveAutoColor } from "../auto-color.js";
import { motionReadinessMessage } from "../motion-readiness-ui.jsx";
import { ko, LOCALE, setLocale } from "../locale.js";
import { readStoredGridView, writeStoredGridView } from "../grid-view.js";
import "./preferences.css";

const LANGUAGES = [
	{ id: "en", label: "English", action: "Switch to English" },
	{ id: "ko", label: "한국어", action: "한국어로 전환" },
];

const NAV_GROUPS = [
	{
		label: ko("General", "일반"),
		items: [
			{ id: "Appearance", label: ko("Appearance", "모양") },
			{ id: "Viewport", label: ko("Viewport", "뷰포트") },
			{ id: "Input & Camera", label: ko("Input & Camera", "입력 및 카메라") },
			{ id: "Hotkeys", label: ko("Hotkeys", "단축키") },
		],
	},
	{
		label: ko("Motion", "모션"),
		items: [
			{ id: "ARDY Connection", label: ko("ARDY Connection", "ARDY 연결") },
			{ id: "IK Correction", label: ko("IK Correction", "IK 보정") },
		],
	},
	{
		label: ko("Integrations", "통합"),
		items: [{ id: "MCP Server", label: ko("MCP Server", "MCP 서버") }],
	},
	{
		label: ko("Project", "프로젝트"),
		items: [
			{ id: "Units & Frame rate", label: ko("Units & Frame rate", "단위 및 프레임 레이트") },
			{ id: "Autosave", label: ko("Autosave", "자동 저장") },
		],
	},
];

const HOTKEYS = [
	["Move", "W", "이동"],
	["Rotate", "E", "회전"],
	["Scale", "R", "크기 조절"],
	["Frame selection", "F", "선택 프레임"],
	["Duplicate", "Ctrl D", "복제"],
	["Drop to floor", "End", "바닥에 놓기"],
];

const PREFERENCE_KEYS = Object.freeze({
	grid: "cozyclay.grid-view.v1",
	invertY: "cozyclay.preferences.invert-y.v1",
	orbit: "cozyclay.preferences.orbit-selection.v1",
	snap: "cozyclay.preferences.snapping.v1",
	ctrlSnap: "cozyclay.preferences.ctrl-snapping.v1",
	footLock: "cozyclay.preferences.foot-lock.v1",
	bodyContact: "cozyclay.preferences.body-contact.v1",
	autosave: "cozyclay.preferences.autosave.v1",
});

function readFlag(key, fallback = false) {
	try {
		return localStorage.getItem(key) === "1";
	} catch {
		return fallback;
	}
}

function writeFlag(key, value) {
	try {
		localStorage.setItem(key, value ? "1" : "0");
	} catch {
		// Viewer preferences are best effort when storage is unavailable.
	}
	if (typeof window !== "undefined") {
		window.dispatchEvent(new CustomEvent("cozyclay:preferences-changed", { detail: { key, value } }));
	}
}

function PreferenceRow({ title, description, children, testid }) {
	return (
		<div className="v2-preferences__row" data-testid={testid}>
			<div className="v2-preferences__row-copy">
				<span className="v2-preferences__row-title">{title}</span>
				{description && <span className="v2-preferences__row-description">{description}</span>}
			</div>
			<div className="v2-preferences__row-control">{children}</div>
		</div>
	);
}

function PreferenceSection({ title, children }) {
	return (
		<section className="v2-preferences__section">
			<h2 className="v2-preferences__section-title">{title}</h2>
			<div className="v2-preferences__section-rows">{children}</div>
		</section>
	);
}

function ToggleControl({ pressed, onChange, label, testid }) {
	return (
		<button
			type="button"
			className="v2-preferences__toggle"
			role="switch"
			aria-checked={pressed}
			aria-pressed={pressed}
			aria-label={label}
			data-testid={testid}
			onClick={() => onChange(!pressed)}
		>
			<span className="v2-preferences__toggle-thumb" aria-hidden="true" />
		</button>
	);
}

function SelectControl({ value, options, onChange, label, testid }) {
	const current = options.indexOf(value);
	return (
		<button
			type="button"
			className="v2-preferences__select"
			aria-label={label}
			data-testid={testid}
			onClick={() => onChange(options[(current + 1) % options.length])}
		>
			<span>{value}</span>
			<span className="v2-preferences__select-caret" aria-hidden="true">▾</span>
		</button>
	);
}

function RangeControl({ value, min, max, step, label, unit = "", onChange, testid }) {
	const percentage = ((value - min) / (max - min)) * 100;
	return (
		<div className="v2-preferences__range-wrap">
			<input
				type="range"
				className="v2-preferences__range"
				min={min}
				max={max}
				step={step}
				value={value}
				aria-label={label}
				data-testid={testid}
				style={{ "--prefs-range-progress": `${percentage}%` }}
				onChange={(event) => onChange(Number(event.target.value))}
			/>
			<span className="v2-preferences__range-value">{value}{unit}</span>
		</div>
	);
}

function ReadonlyHotkeys() {
	return (
		<div className="v2-preferences__hotkeys" data-testid="preferences-hotkeys">
			{HOTKEYS.map(([english, key, korean]) => (
				<div className="v2-preferences__hotkey" key={english}>
					<span>{ko(english, korean)}</span>
					<kbd>{key}</kbd>
				</div>
			))}
		</div>
	);
}

function MotionConnection({ state, checking, onRetry }) {
	const unavailable = state === "unavailable";
	const retryLabel = checking
		? ko("Checking…", "확인 중…")
		: unavailable
			? ko("Retry connection", "연결 다시 확인")
			: ko("Check connection", "연결 확인");
	return (
		<div className="v2-preferences__motion-setup" data-testid="motion-setup" data-state={state}>
			<div className="v2-preferences__motion-status" data-state={state} role="status" aria-busy={checking}>
				<span className="v2-preferences__status-dot" aria-hidden="true" />
				<span>{motionReadinessMessage(state)}</span>
			</div>
			<p>{ko(
				"Motion generation is optional. Sample motion, camera editing and exports work without a connection.",
				"모션 생성은 선택 사항이에요. 연결 없이도 샘플 모션, 카메라 편집, 내보내기를 쓸 수 있어요.",
			)}</p>
			<p>{ko(
				"Retry checks the local motion bridge without changing the current scene.",
				"다시 확인해도 현재 씬은 바뀌지 않고 로컬 모션 브리지 상태만 확인해요.",
			)}</p>
			<button
				type="button"
				className="v2-preferences__primary-button"
				data-testid="motion-health-retry"
				disabled={checking}
				onClick={() => onRetry?.()}
			>
				{retryLabel}
			</button>
		</div>
	);
}

function preferenceSection(section, props) {
	const {
		autoColor, setAutoColor, analyticsOptOut, setAnalyticsOptOutState,
		gridView, setGridView, flySpeed, setFlySpeed, sensitivity, setSensitivity,
		orbitSelection, setOrbitSelection, invertY, setInvertY, snapping, setSnapping,
		ctrlSnap, setCtrlSnap, footLock, setFootLock, bodyContact, setBodyContact,
		shading, setShading, gridSize, setGridSize, rotationStep, setRotationStep,
		units, setUnits, frameRate, setFrameRate, autosave, setAutosave,
		motionState, motionChecking, onRetry, cameraTutorial,
	} = props;
	const languageControls = (
		<div className="v2-preferences__language-controls">
			{LANGUAGES.map((language) => (
				<button
					type="button"
					key={language.id}
					className={"v2-preferences__language" + (LOCALE === language.id ? " is-selected" : "")}
					data-testid={`settings-locale-${language.id}`}
					aria-pressed={LOCALE === language.id}
					title={language.action}
					onClick={() => setLocale(language.id)}
				>
					{language.label}
				</button>
			))}
		</div>
	);

	switch (section) {
		case "Appearance":
			return (
				<>
					<PreferenceSection title={ko("Language", "언어")}>
						<PreferenceRow title={ko("Language", "언어")} description={ko("Choose the labels used throughout the editor.", "에디터에서 사용할 언어를 선택하세요.")}>
							{languageControls}
						</PreferenceRow>
					</PreferenceSection>
					<PreferenceSection title={ko("Editor", "에디터")}>
						<PreferenceRow title={ko("Auto colour", "자동 색")} description={ko("Give scene objects stable display colours.", "씬 오브젝트에 고정된 표시 색을 사용해요.")}>
							<ToggleControl pressed={autoColor} onChange={(value) => { setAutoColor(value); saveAutoColor(value); }} label={ko("Auto colour", "자동 색")} testid="preferences-auto-color" />
						</PreferenceRow>
						<PreferenceRow title={ko("Anonymous analytics", "익명 사용 통계")} description={ko("Help improve CozyClay with anonymous product events.", "익명 제품 이벤트로 CozyClay 개선을 도와요.")}>
							<ToggleControl
								pressed={!analyticsOptOut}
								onChange={async (value) => setAnalyticsOptOutState(await setAnalyticsOptOut(!value))}
								label={ko("Anonymous analytics", "익명 사용 통계")}
								testid="settings-analytics"
							/>
						</PreferenceRow>
					</PreferenceSection>
					{cameraTutorial && <div className="v2-preferences__help">{cameraTutorial}</div>}
				</>
			);
		case "Viewport":
			return (
				<PreferenceSection title={ko("Viewport", "뷰포트")}>
					<PreferenceRow title={ko("Reference grid", "기준 그리드")} description={ko("Use a dark reference grid instead of the clay deck.", "클레이 데크 대신 어두운 기준 그리드를 사용해요.")}>
						<ToggleControl pressed={gridView} onChange={(value) => { setGridView(value); writeStoredGridView(globalThis.localStorage, value); }} label={ko("Reference grid", "기준 그리드")} testid="preferences-grid" />
					</PreferenceRow>
					<PreferenceRow title={ko("Shading", "셰이딩")} description={ko("Choose the viewport lighting preview.", "뷰포트 조명 미리보기를 선택하세요.")}>
						<SelectControl value={shading} options={[ko("Clay Lit", "클레이 조명"), ko("Solid", "솔리드")]} onChange={setShading} label={ko("Shading mode", "셰이딩 모드")} testid="preferences-shading" />
					</PreferenceRow>
				</PreferenceSection>
			);
		case "Input & Camera":
			return (
				<>
					<PreferenceSection title={ko("Camera", "카메라")}>
						<PreferenceRow title={ko("Fly speed", "비행 속도")} description={ko("Right mouse button + WASD", "마우스 오른쪽 버튼 + WASD")}>
							<RangeControl value={flySpeed} min={1} max={6} step={1} label={ko("Fly speed", "비행 속도")} onChange={setFlySpeed} testid="preferences-fly-speed" />
						</PreferenceRow>
						<PreferenceRow title={ko("Mouse sensitivity", "마우스 감도")} description={ko("Pointer movement while looking around.", "둘러볼 때 포인터 이동 감도예요.")}>
							<RangeControl value={sensitivity} min={0.1} max={1} step={0.05} label={ko("Mouse sensitivity", "마우스 감도")} onChange={setSensitivity} testid="preferences-sensitivity" />
						</PreferenceRow>
						<PreferenceRow title={ko("Orbit around selection", "선택 항목 중심으로 회전")} description={ko("Alt-drag keeps the selected item at the pivot.", "Alt를 누르고 드래그하면 선택 항목을 중심으로 돌아요.")}>
							<ToggleControl pressed={orbitSelection} onChange={(value) => { setOrbitSelection(value); writeFlag(PREFERENCE_KEYS.orbit, value); }} label={ko("Orbit around selection", "선택 항목 중심으로 회전")} testid="preferences-orbit" />
						</PreferenceRow>
						<PreferenceRow title={ko("Invert Y", "Y축 반전")} description={ko("Reverse vertical camera movement.", "카메라의 수직 움직임을 반대로 해요.")}>
							<ToggleControl pressed={invertY} onChange={(value) => { setInvertY(value); writeFlag(PREFERENCE_KEYS.invertY, value); }} label={ko("Invert Y", "Y축 반전")} testid="preferences-invert-y" />
						</PreferenceRow>
					</PreferenceSection>
					<PreferenceSection title={ko("Snapping", "스냅")}>
						<PreferenceRow title={ko("Snapping", "스냅")} description={ko("Keep transforms on the active grid.", "변환을 활성 그리드에 맞춰요.")}>
							<ToggleControl pressed={snapping} onChange={(value) => { setSnapping(value); writeFlag(PREFERENCE_KEYS.snap, value); }} label={ko("Snapping", "스냅")} testid="preferences-snapping" />
						</PreferenceRow>
						<PreferenceRow title={ko("Grid size", "그리드 크기")} description={ko("Stage movement increment.", "스테이지 이동 단위예요.")}>
							<SelectControl value={gridSize} options={["10 cm", "25 cm", "50 cm"]} onChange={setGridSize} label={ko("Grid size", "그리드 크기")} testid="preferences-grid-size" />
						</PreferenceRow>
						<PreferenceRow title={ko("Rotation step", "회전 단위")} description={ko("Stage rotation increment.", "스테이지 회전 단위예요.")}>
							<SelectControl value={rotationStep} options={["15°", "30°", "45°"]} onChange={setRotationStep} label={ko("Rotation step", "회전 단위")} testid="preferences-rotation-step" />
						</PreferenceRow>
						<PreferenceRow title={ko("Ctrl inverts snapping", "Ctrl로 스냅 반전")} description={ko("Hold Ctrl to temporarily reverse snapping.", "Ctrl을 누르면 스냅을 잠시 반대로 적용해요.")}>
							<ToggleControl pressed={ctrlSnap} onChange={(value) => { setCtrlSnap(value); writeFlag(PREFERENCE_KEYS.ctrlSnap, value); }} label={ko("Ctrl inverts snapping", "Ctrl로 스냅 반전")} testid="preferences-ctrl-snapping" />
						</PreferenceRow>
					</PreferenceSection>
					<PreferenceSection title={ko("Hotkeys", "단축키")}>
						<ReadonlyHotkeys />
					</PreferenceSection>
				</>
			);
		case "Hotkeys":
			return (
				<PreferenceSection title={ko("Hotkeys", "단축키")}>
					<p className="v2-preferences__section-note">{ko("Shortcuts are read-only here. They stay active whenever focus is outside a text field.", "단축키는 여기서 읽기 전용이에요. 텍스트 입력란 밖에서 항상 사용할 수 있어요.")}</p>
					<ReadonlyHotkeys />
				</PreferenceSection>
			);
		case "ARDY Connection":
			return (
				<PreferenceSection title={ko("ARDY Connection", "ARDY 연결")}>
					<PreferenceRow title={ko("Motion setup", "모션 설정")} description={ko("Check today's motion generation route.", "현재 모션 생성 경로를 확인해요.")}>
						<span className="v2-preferences__value">{motionReadinessMessage(motionState)}</span>
					</PreferenceRow>
					<div className="v2-preferences__row v2-preferences__row--full">
						<MotionConnection state={motionState} checking={motionChecking} onRetry={onRetry} />
					</div>
				</PreferenceSection>
			);
		case "IK Correction":
			return (
				<PreferenceSection title={ko("IK Correction", "IK 보정")}>
					<PreferenceRow title={ko("Foot lock", "발 고정")} description={ko("Keep planted feet stable through the take.", "테이크 전체에서 발을 안정적으로 고정해요.")}>
						<ToggleControl pressed={footLock} onChange={(value) => { setFootLock(value); writeFlag(PREFERENCE_KEYS.footLock, value); }} label={ko("Foot lock", "발 고정")} testid="preferences-foot-lock" />
					</PreferenceRow>
					<PreferenceRow title={ko("Body contact", "신체 접촉")} description={ko("Keep contact points when applying corrections.", "보정을 적용할 때 접촉 지점을 유지해요.")}>
						<ToggleControl pressed={bodyContact} onChange={(value) => { setBodyContact(value); writeFlag(PREFERENCE_KEYS.bodyContact, value); }} label={ko("Body contact", "신체 접촉")} testid="preferences-body-contact" />
					</PreferenceRow>
				</PreferenceSection>
			);
		case "MCP Server":
			return (
				<PreferenceSection title={ko("MCP Server", "MCP 서버")}>
					<PreferenceRow title={ko("Status", "상태")} description={ko("Agent connections are managed by the running studio.", "에이전트 연결은 실행 중인 스튜디오가 관리해요.")}>
						<span className="v2-preferences__status-value"><span className="v2-preferences__status-dot is-muted" aria-hidden="true" />{ko("Not connected", "연결되지 않음")}</span>
					</PreferenceRow>
					<PreferenceRow title={ko("Port", "포트")} description={ko("The local command endpoint.", "로컬 명령 엔드포인트예요.")}>
						<span className="v2-preferences__value v2-preferences__value--mono">8765</span>
					</PreferenceRow>
				</PreferenceSection>
			);
		case "Units & Frame rate":
			return (
				<PreferenceSection title={ko("Units & Frame rate", "단위 및 프레임 레이트")}>
					<PreferenceRow title={ko("Units", "단위")} description={ko("Display distances in the inspector.", "인스펙터에서 거리를 표시하는 단위예요.")}>
						<SelectControl value={units} options={[ko("Centimeters", "센티미터"), ko("Meters", "미터")]} onChange={setUnits} label={ko("Units", "단위")} testid="preferences-units" />
					</PreferenceRow>
					<PreferenceRow title={ko("Frame rate", "프레임 레이트")} description={ko("Playback and timeline frame rate.", "재생 및 타임라인 프레임 레이트예요.")}>
						<SelectControl value={frameRate} options={["24 fps", "30 fps", "60 fps"]} onChange={setFrameRate} label={ko("Frame rate", "프레임 레이트")} testid="preferences-frame-rate" />
					</PreferenceRow>
				</PreferenceSection>
			);
		case "Autosave":
			return (
				<PreferenceSection title={ko("Autosave", "자동 저장")}>
					<PreferenceRow title={ko("Autosave", "자동 저장")} description={ko("Save a project snapshot after an edit settles.", "편집이 끝나면 프로젝트 스냅샷을 저장해요.")}>
						<ToggleControl pressed={autosave} onChange={(value) => { setAutosave(value); writeFlag(PREFERENCE_KEYS.autosave, value); }} label={ko("Autosave", "자동 저장")} testid="preferences-autosave" />
					</PreferenceRow>
					<PreferenceRow title={ko("Interval", "간격")} description={ko("The current editor default.", "현재 에디터 기본값이에요.")}>
						<span className="v2-preferences__value">2 min</span>
					</PreferenceRow>
				</PreferenceSection>
			);
		default:
			return null;
	}
}

export default function PreferencesDialog({ open, onClose, motionSetup, initialSection = "Input & Camera", cameraTutorial }) {
	const dialogRef = useRef(null);
	const searchRef = useRef(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	const [activeSection, setActiveSection] = useState(initialSection);
	const [query, setQuery] = useState("");
	const [analyticsOptOut, setAnalyticsOptOutState] = useState(getAnalyticsOptOut);
	const [autoColor, setAutoColor] = useState(() => loadAutoColor());
	const [gridView, setGridView] = useState(() => readStoredGridView(globalThis.localStorage));
	const [flySpeed, setFlySpeed] = useState(3);
	const [sensitivity, setSensitivity] = useState(0.55);
	const [orbitSelection, setOrbitSelection] = useState(() => readFlag(PREFERENCE_KEYS.orbit, true));
	const [invertY, setInvertY] = useState(() => readFlag(PREFERENCE_KEYS.invertY));
	const [snapping, setSnapping] = useState(() => readFlag(PREFERENCE_KEYS.snap, true));
	const [ctrlSnap, setCtrlSnap] = useState(() => readFlag(PREFERENCE_KEYS.ctrlSnap, true));
	const [footLock, setFootLock] = useState(() => readFlag(PREFERENCE_KEYS.footLock, true));
	const [bodyContact, setBodyContact] = useState(() => readFlag(PREFERENCE_KEYS.bodyContact, true));
	const [shading, setShading] = useState(() => ko("Clay Lit", "클레이 조명"));
	const [gridSize, setGridSize] = useState("10 cm");
	const [rotationStep, setRotationStep] = useState("15°");
	const [units, setUnits] = useState(() => ko("Centimeters", "센티미터"));
	const [frameRate, setFrameRate] = useState("24 fps");
	const [autosave, setAutosave] = useState(() => readFlag(PREFERENCE_KEYS.autosave, true));
	const setupProps = motionSetup?.props ?? {};
	const motionState = setupProps.state ?? "unavailable";
	const motionChecking = setupProps.checking === true;
	const onRetry = setupProps.onRetry;

	const filteredGroups = useMemo(() => {
		const term = query.trim().toLocaleLowerCase();
		if (!term) return NAV_GROUPS;
		return NAV_GROUPS.map((group) => ({
			...group,
			items: group.items.filter((item) => item.label.toLocaleLowerCase().includes(term)),
		})).filter((group) => group.items.length > 0);
	}, [query]);

	useEffect(() => {
		if (!open) return undefined;
		setActiveSection(initialSection);
		setQuery("");
		const frame = requestAnimationFrame(() => searchRef.current?.focus());
		const onKeyDown = (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				closeRef.current?.();
				return;
			}
			if (event.key !== "Tab") return;
			const focusable = [...dialogRef.current?.querySelectorAll("button:not([disabled]), input:not([disabled]), [tabindex=\"0\"]") ?? []];
			if (focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable.at(-1);
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => {
			cancelAnimationFrame(frame);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open, initialSection]);

	if (!open || typeof document === "undefined") return null;
	const currentProps = {
		autoColor, setAutoColor, analyticsOptOut,
		setAnalyticsOptOutState,
		gridView, setGridView, flySpeed, setFlySpeed, sensitivity, setSensitivity,
		orbitSelection, setOrbitSelection, invertY, setInvertY, snapping, setSnapping,
		ctrlSnap, setCtrlSnap, footLock, setFootLock, bodyContact, setBodyContact,
		shading, setShading, gridSize, setGridSize, rotationStep, setRotationStep,
		units, setUnits, frameRate, setFrameRate, autosave, setAutosave,
		motionState, motionChecking, onRetry, cameraTutorial,
	};

	return createPortal(
		<div className="v2-preferences" data-testid="preferences-dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) closeRef.current?.(); }}>
			<div
				className="v2-preferences__dialog settings-menu"
				role="dialog"
				aria-modal="true"
				aria-labelledby="v2-preferences-title"
				ref={dialogRef}
				tabIndex={-1}
			>
				<aside className="v2-preferences__nav" aria-label={ko("Preferences navigation", "환경설정 탐색")}>
					<div className="v2-preferences__nav-title-row">
						<strong className="v2-preferences__nav-title">{ko("Preferences", "환경설정")}</strong>
						<button type="button" className="v2-preferences__close" data-testid="preferences-close" onClick={() => closeRef.current?.()} aria-label={ko("Close preferences", "환경설정 닫기")}>×</button>
					</div>
					<label className="v2-preferences__search">
						<span className="v2-preferences__search-icon" aria-hidden="true">⌕</span>
						<input ref={searchRef} data-testid="preferences-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={ko("Search", "검색")} aria-label={ko("Search preferences", "환경설정 검색")} />
					</label>
					<nav className="v2-preferences__nav-list" aria-label={ko("Preference sections", "환경설정 섹션")}>
						{filteredGroups.map((group) => (
							<div className="v2-preferences__nav-group" key={group.label}>
								<h2 className="v2-preferences__nav-group-title" data-testid="preferences-nav-group">{group.label}</h2>
								{group.items.map((item) => (
									<button
										type="button"
										key={item.id}
										className={"v2-preferences__nav-item" + (activeSection === item.id ? " is-active" : "")}
										data-testid="preferences-nav-item"
										aria-current={activeSection === item.id ? "page" : undefined}
										onClick={() => setActiveSection(item.id)}
									>
										{item.label}
									</button>
								))}
							</div>
						))}
					</nav>
				</aside>
				<main className="v2-preferences__content">
					<header className="v2-preferences__content-header">
						<h1 id="v2-preferences-title">{ko(activeSection, activeSection)}</h1>
						<button type="button" className="v2-preferences__reset" data-testid="preferences-reset" onClick={() => {
							setFlySpeed(3); setSensitivity(0.55); setOrbitSelection(true); setInvertY(false); setSnapping(true); setCtrlSnap(true);
							setShading(ko("Clay Lit", "클레이 조명")); setGridSize("10 cm"); setRotationStep("15°"); setUnits(ko("Centimeters", "센티미터")); setFrameRate("24 fps"); setAutosave(true);
							writeFlag(PREFERENCE_KEYS.orbit, true); writeFlag(PREFERENCE_KEYS.invertY, false); writeFlag(PREFERENCE_KEYS.snap, true); writeFlag(PREFERENCE_KEYS.ctrlSnap, true); writeFlag(PREFERENCE_KEYS.autosave, true);
						}}>{ko("Reset to defaults", "기본값으로 재설정")}</button>
					</header>
					<div className="v2-preferences__content-scroll">
						{preferenceSection(activeSection, currentProps)}
					</div>
				</main>
			</div>
		</div>,
		document.body,
	);
}
