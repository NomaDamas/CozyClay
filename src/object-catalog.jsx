import { useEffect, useRef, useState } from "react";
import { ko, isKo } from "./locale.js";
import { EMPTY_KIND, OBJECT_MENU_ENTRIES } from "./scene-objects.js";

const GROUP_LABELS_KO = {
	Primitives: "기본 도형",
	"Set pieces": "세트 소품",
};

const OBJECT_LABELS_KO = {
	Empty: "빈 오브젝트",
	Cube: "큐브",
	Sphere: "구",
	Capsule: "캡슐",
	Cylinder: "원기둥",
	Cone: "원뿔",
	Plane: "평면",
	Chair: "의자",
	Car: "자동차",
	"Plane (aircraft)": "비행기",
};

export function displayObjectGroupName(name) {
	return isKo ? (GROUP_LABELS_KO[name] ?? name) : name;
}

export function displayObjectLabel(label) {
	if (!isKo) return label;
	const numbered = label.match(/^(.+?) (\d+)$/);
	if (numbered && OBJECT_LABELS_KO[numbered[1]]) return `${OBJECT_LABELS_KO[numbered[1]]} ${numbered[2]}`;
	return OBJECT_LABELS_KO[label] ?? label;
}

/**
 * "Add object" — the hierarchy's create menu, Unity's GameObject > 3D Object
 * in one popover. Grouped by catalogue section; picking an entry drops the
 * object in front of the camera and hands selection to the caller.
 */

/** The catalogue grouped by section. Shared with the hierarchy's right-click
 * create menu so both entry points list the same objects
 * (docs/unity-reference.md §9.7). */
export function buildObjectMenuGroups() {
	const groups = [];
	for (const entry of OBJECT_MENU_ENTRIES) {
		const group = groups.find((item) => item.name === entry.group);
		if (group) group.entries.push(entry);
		else groups.push({ name: entry.group, entries: [entry] });
	}
	return groups;
}

/** One rendered entry list; the toolbar popover and the right-click create
 * menu both use it so the two can never drift apart. */
export function CatalogueEntries({ onPick }) {
	return buildObjectMenuGroups().map((group) => (
		<div className="add-object-group" key={group.name}>
			<span className="add-object-heading">{displayObjectGroupName(group.name)}</span>
			{group.entries.map((entry) => (
				<button
					type="button"
					role="menuitem"
					key={entry.kind}
					className="add-object-item"
					onClick={() => onPick(entry.kind)}
				>
					<span className={`add-object-swatch ${entry.kind}`} style={{ background: entry.color }} aria-hidden="true" />
					<span>{displayObjectLabel(entry.label)}</span>
					{/* An empty has no size to quote: say what it is instead of "0 × 0 m". */}
					<small>{entry.kind === EMPTY_KIND ? ko("node only", "노드 전용") : `${entry.footprint.width} × ${entry.footprint.depth} m`}</small>
				</button>
			))}
		</div>
	));
}

export default function AddObjectMenu({ onAdd, label = ko("Add object", "오브젝트 추가") }) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef(null);

	useEffect(() => {
		if (!open) return undefined;
		const onDocDown = (event) => {
			if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
		};
		const onKey = (event) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onDocDown);
		window.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDocDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);

	return (
		<div className={"add-object" + (open ? " open" : "")} ref={rootRef}>
			<button
				type="button"
				className="add-object-trigger"
				aria-expanded={open}
				aria-haspopup="menu"
				onClick={() => setOpen((value) => !value)}
			>
				<span aria-hidden="true">＋</span>
				{label}
			</button>
			{open && (
				<div className="add-object-menu" role="menu">
					<CatalogueEntries
						onPick={(kind) => {
							onAdd(kind);
							setOpen(false);
						}}
					/>
				</div>
			)}
		</div>
	);
}
