import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ko } from "../locale.js";
import { loadAutoColor, preferenceSection, readStoredGridView } from "./preference-pages.jsx";
import "./preferences.css";

const NAV_GROUPS = [
	{
		label: ko("General", "일반"),
		items: [
			{ id: "Appearance", label: ko("Appearance", "모양") },
			{ id: "Viewport", label: ko("Viewport", "뷰포트") },
			{ id: "Export", label: ko("Export", "내보내기") },
			{ id: "Hotkeys", label: ko("Hotkeys", "단축키") },
		],
	},
];
const NAV_LABELS = Object.fromEntries(NAV_GROUPS.flatMap((group) => group.items.map((item) => [item.id, item.label])));

export default function PreferencesDialog({ open, onClose, initialSection = "Appearance" }) {
	const dialogRef = useRef(null);
	const searchRef = useRef(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	const [activeSection, setActiveSection] = useState(initialSection);
	const [query, setQuery] = useState("");
	const [autoColor, setAutoColor] = useState(() => loadAutoColor());
	const [gridView, setGridView] = useState(() => readStoredGridView(globalThis.localStorage));

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
	const currentProps = { autoColor, setAutoColor, gridView, setGridView };

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
						<h1 id="v2-preferences-title">{NAV_LABELS[activeSection] ?? activeSection}</h1>
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
