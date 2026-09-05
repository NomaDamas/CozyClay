import { useEffect, useMemo, useRef, useState } from "react";
import { ko, isKo } from "./locale.js";
import { buildHierarchyNodes } from "./hierarchy-model.js";
import { sceneObjectIdFromHierarchy } from "./scene-objects.js";
import AddObjectMenu, { CatalogueEntries, displayObjectLabel } from "./object-catalog.jsx";

const HIERARCHY_LABELS_KO = {
	"SCENE 01": "장면 01",
	Camera: "카메라",
	Characters: "캐릭터",
	"Character 1": "캐릭터 1",
	"Character 2": "캐릭터 2",
	Rig: "리그",
	Torso: "몸통",
	"Root / Hips": "루트 / 골반",
	Spine: "척추",
	Chest: "가슴",
	Neck: "목",
	Head: "머리",
	"Left Arm": "왼팔",
	"Left Shoulder": "왼쪽 어깨",
	"Left Elbow": "왼쪽 팔꿈치",
	"Left Hand": "왼손",
	"Right Arm": "오른팔",
	"Right Shoulder": "오른쪽 어깨",
	"Right Elbow": "오른쪽 팔꿈치",
	"Right Hand": "오른손",
	"Left Leg": "왼다리",
	"Left Knee": "왼쪽 무릎",
	"Left Foot": "왼발",
	"Right Leg": "오른다리",
	"Right Knee": "오른쪽 무릎",
	"Right Foot": "오른발",
	Environment: "환경",
	Props: "소품",
	Light: "조명",
};

const FALLBACK_SCENES = [{ id: "current-scene", name: "SCENE 01" }];

/**
 * The drag payload for a hierarchy ROW moved onto another row (attach a prop
 * to a character, regroup it under another prop, drop it back on Props). A
 * private MIME keeps it apart from the file/picture drop that shares these
 * rows: a Files drag never carries this type, so the two never collide.
 */
export const HIERARCHY_DRAG_MIME = "application/x-cclay-hierarchy";

const carriesHierarchyRow = (event) => !!event.dataTransfer?.types?.includes?.(HIERARCHY_DRAG_MIME);

function HierarchyIcon({ kind, className = "" }) {
	const common = {
		className: `hierarchy-icon ${kind}${className ? ` ${className}` : ""}`,
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 1.7,
		strokeLinecap: "round",
		strokeLinejoin: "round",
		"aria-hidden": true,
	};

	switch (kind) {
		case "scene":
			return (
				<svg {...common}>
					<path d="M12 3.25 21 8l-9 4.75L3 8l9-4.75Z" fill="currentColor" fillOpacity=".16" />
					<path d="m4.25 12 7.75 4.1 7.75-4.1M4.25 16 12 20.1l7.75-4.1" />
				</svg>
			);
		case "camera":
			return (
				<svg {...common}>
					<rect x="3" y="6.5" width="13.5" height="11" rx="2" />
					<path d="m16.5 10 4.5-2.25v8.5L16.5 14" />
					<circle cx="9.5" cy="12" r="2.4" />
				</svg>
			);
		case "light":
			return (
				<svg {...common}>
					<circle cx="12" cy="12" r="4" fill="currentColor" fillOpacity=".16" />
					<path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" />
				</svg>
			);
		case "group":
			return (
				<svg {...common}>
					<circle cx="9" cy="8.25" r="2.75" />
					<circle cx="16.5" cy="9.25" r="2.15" />
					<path d="M3.75 18c.45-3.25 2.15-5 5.25-5s4.8 1.75 5.25 5M14 14.25c3.55-.55 5.65.75 6.25 3.75" />
				</svg>
			);
		case "character":
			return (
				<svg {...common}>
					<circle cx="12" cy="7.25" r="3" fill="currentColor" fillOpacity=".12" />
					<path d="M5.25 20c.45-5 2.7-7.5 6.75-7.5S18.3 15 18.75 20M9.25 13.25 12 16l2.75-2.75" />
				</svg>
			);
		case "rig":
			return (
				<svg {...common}>
					<circle cx="12" cy="4.5" r="1.75" fill="currentColor" fillOpacity=".18" />
					<circle cx="6" cy="11.5" r="1.75" />
					<circle cx="18" cy="11.5" r="1.75" />
					<circle cx="12" cy="19.5" r="1.75" />
					<path d="m10.8 5.8-3.6 4.4m6-4.4 3.6 4.4M7.75 12.65l3 5.4m5.5-5.4-3 5.4" />
				</svg>
			);
		case "bone":
			return (
				<svg {...common}>
					<path d="M7.4 8.25a2.5 2.5 0 1 1-3.65-3.4A2.5 2.5 0 1 1 7.2 8.5l8.3 8.3a2.5 2.5 0 1 1 3.65 3.4 2.5 2.5 0 1 1-3.4-3.65L7.4 8.25Z" />
				</svg>
			);
		case "environment":
			return (
				<svg {...common}>
					<circle cx="12" cy="12" r="8.5" fill="currentColor" fillOpacity=".08" />
					<path d="M3.8 13h16.4M12 3.5c2.25 2.35 3.4 5.2 3.4 8.5S14.25 18.15 12 20.5C9.75 18.15 8.6 15.3 8.6 12S9.75 5.85 12 3.5Z" />
				</svg>
			);
		case "props":
		case "object":
			return (
				<svg {...common}>
					<path d="m12 3.5 8 4.25v8.5l-8 4.25-8-4.25v-8.5L12 3.5Z" fill="currentColor" fillOpacity=".1" />
					<path d="m4.25 7.9 7.75 4.2 7.75-4.2M12 12.1v8.15" />
				</svg>
			);
		default:
			return (
				<svg {...common}>
					<circle cx="12" cy="12" r="7.5" />
				</svg>
			);
	}
}

function displaySceneName(name) {
	if (!isKo) return name;
	const generatedName = /^SCENE\s+(\d+)$/i.exec(name);
	return generatedName ? ko(`Scene ${generatedName[1]}`, `장면 ${generatedName[1]}`) : name;
}

/**
 * Scene document boundary contract:
 * - `scenes` contains lightweight `{ id, name }` records.
 * - callbacks request document changes; this panel never owns or mutates scenes.
 *
 * A compact document selector sits above the entity tree instead of mixing
 * every Scene into one tree. This keeps the current set readable and leaves
 * Shot authoring in the timeline, where directors expect to find it.
 */
function SceneSwitcher({
	scenes,
	activeSceneId,
	onSceneSelect,
	onSceneCreate,
	onSceneDuplicate,
	onSceneRename,
	onSceneDelete,
}) {
	const availableScenes = scenes?.length ? scenes : FALLBACK_SCENES;
	const selectedId = availableScenes.some((scene) => scene.id === activeSceneId) ? activeSceneId : availableScenes[0].id;
	const selectedScene = availableScenes.find((scene) => scene.id === selectedId);
	const [editingId, setEditingId] = useState(null);
	const [deleteArmed, setDeleteArmed] = useState(false);
	useEffect(() => setDeleteArmed(false), [selectedId, availableScenes.length]);

	const commitRename = (scene, value) => {
		setEditingId(null);
		const name = value.trim();
		if (name && name !== scene.name) onSceneRename?.(scene.id, name);
	};
	const requestDelete = () => {
		if (availableScenes.length <= 1 || !selectedScene) return;
		if (!deleteArmed) {
			setDeleteArmed(true);
			return;
		}
		setDeleteArmed(false);
		onSceneDelete?.(selectedScene.id);
	};

	return (
		<div className="scene-switcher" aria-label={ko("Scene documents", "장면 문서") }>
			<div className="scene-switcher-heading">
				<div>
					<strong>{ko("Scenes", "장면")}</strong>
					<span>{isKo ? `${availableScenes.length}개 장면` : `${availableScenes.length} scene${availableScenes.length === 1 ? "" : "s"}`}</span>
				</div>
				<button type="button" className="scene-create-button" onClick={() => onSceneCreate?.()}>
					{ko("+ New Scene", "+ 새 장면")}
				</button>
			</div>
			<div className="scene-list" role="listbox" aria-label={ko("Select scene", "장면 선택")}>
				{availableScenes.map((scene) => {
					const active = scene.id === selectedId;
					return (
						<div key={scene.id} className={`scene-list-item${active ? " active" : ""}`}>
							{editingId === scene.id ? (
								<input
									className="scene-rename-input"
									defaultValue={scene.name}
									autoFocus
									aria-label={ko("Rename scene", "장면 이름 바꾸기")}
									onFocus={(event) => event.currentTarget.select()}
									onBlur={(event) => commitRename(scene, event.currentTarget.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter") event.currentTarget.blur();
										else if (event.key === "Escape") setEditingId(null);
									}}
								/>
							) : (
								<button
									type="button"
									role="option"
									aria-selected={active}
									onClick={() => {
										if (!active) onSceneSelect?.(scene.id);
									}}
									onDoubleClick={() => setEditingId(scene.id)}
								>
									<HierarchyIcon kind="scene" className="scene-document-icon" />
									<span>{displaySceneName(scene.name)}</span>
								</button>
							)}
						</div>
					);
				})}
			</div>
			{/* Scene housekeeping is a once-a-session errand, so it waits under one
			    disclosure instead of holding three buttons open all day. */}
			<details className="scene-actions-pop">
				<summary title={ko("Scene actions", "장면 작업")}>{ko("Scene…", "장면…")}</summary>
			<div className="scene-actions">
				<button type="button" onClick={() => selectedScene && onSceneDuplicate?.(selectedScene.id)}>{ko("Duplicate", "복제")}</button>
				<button type="button" onClick={() => selectedScene && setEditingId(selectedScene.id)}>{ko("Rename", "이름 바꾸기")}</button>
				<button type="button" className={deleteArmed ? "danger" : undefined} disabled={availableScenes.length <= 1} onClick={requestDelete} title={availableScenes.length <= 1 ? ko("At least one scene is required", "장면은 최소 하나 필요합니다") : deleteArmed ? ko("Click again to permanently delete this scene", "한 번 더 누르면 이 장면을 완전히 삭제합니다") : undefined}>
					{deleteArmed ? ko("Confirm delete", "삭제 확인") : ko("Delete", "삭제")}
				</button>
			</div>
			</details>
		</div>
	);
}

function displayHierarchyLabel(node) {
	if (node.kind === "object") return displayObjectLabel(node.label);
	if (node.kind === "scene") return displaySceneName(node.label);
	return isKo ? (HIERARCHY_LABELS_KO[node.label] ?? node.label) : node.label;
}

function indexParents(nodes, parent = null, parents = new Map()) {
	for (const node of nodes) {
		if (parent) parents.set(node.id, parent);
		if (node.children) indexParents(node.children, node.id, parents);
	}
	return parents;
}

/** Fixed-position menu at the pointer: the object-row actions
 * (Rename / Duplicate / Delete / Frame) or the create catalogue, matching
 * Unity's Hierarchy right-click menu (docs/unity-reference.md §9.7).
 * Closes on Escape, on any outside mousedown, and after a pick. */
function RowContextMenu({ menu, onClose, onAction, onAddObject }) {
	const rootRef = useRef(null);

	useEffect(() => {
		if (!menu) return undefined;
		const onDocDown = (event) => {
			if (rootRef.current && !rootRef.current.contains(event.target)) onClose();
		};
		const onKey = (event) => {
			if (event.key !== "Escape") return;
			// Capture phase + stopImmediatePropagation: closing the menu must
			// not also run the app's window-level Escape (clear selection).
			event.stopImmediatePropagation();
			onClose();
		};
		document.addEventListener("mousedown", onDocDown);
		window.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("mousedown", onDocDown);
			window.removeEventListener("keydown", onKey, true);
		};
	}, [menu, onClose]);

	if (!menu) return null;
	// Keep the menu inside the window; `height` is an upper bound per kind,
	// so a short menu never sits below the pointer that opened it.
	const style = {
		left: Math.max(4, Math.min(menu.x, window.innerWidth - 244)),
		top: Math.max(4, Math.min(menu.y, window.innerHeight - menu.height)),
	};
	return (
		<div className="hierarchy-context-menu" role="menu" style={style} ref={rootRef}>
			{menu.kind === "object" ? (
				<>
					<button type="button" role="menuitem" className="hierarchy-context-item" onClick={() => onAction("rename", menu.id)}>
						{ko("Rename", "이름 바꾸기")}
					</button>
					<button type="button" role="menuitem" className="hierarchy-context-item" onClick={() => onAction("duplicate", menu.id)}>
						{ko("Duplicate", "복제")}
					</button>
					<button type="button" role="menuitem" className="hierarchy-context-item" onClick={() => onAction("delete", menu.id)}>
						{ko("Delete", "삭제")}
					</button>
					<button type="button" role="menuitem" className="hierarchy-context-item" onClick={() => onAction("frame", menu.id)}>
						{ko("Frame", "프레임 맞추기")}
					</button>
				</>
			) : (
				<CatalogueEntries onPick={onAddObject} />
			)}
		</div>
	);
}

function TreeRow({
	node,
	depth,
	selectedId,
	expanded,
	onSelect,
	onToggle,
	badge,
	status,
	editing,
	onRenameCommit,
	onRenameCancel,
	onRowContextMenu,
	dropHandlers,
	reparent,
	dragSourceId,
	onDragSourceChange,
}) {
	const branch = !!node.children?.length;
	// The drop BEHAVIOUR is shared by every row that accepts a picture; the
	// highlight is not. One row lit under the cursor says where the file will
	// land; a whole branch lighting up says nothing.
	const [dropOver, setDropOver] = useState(false);
	const dropDepth = useRef(0);
	const drop = dropHandlers && {
		onDragEnter: (event) => {
			dropHandlers.onDragEnter(event);
			if (!event.dataTransfer?.types?.includes?.("Files")) return;
			dropDepth.current += 1;
			setDropOver(true);
		},
		onDragOver: dropHandlers.onDragOver,
		onDragLeave: (event) => {
			dropHandlers.onDragLeave(event);
			dropDepth.current = Math.max(0, dropDepth.current - 1);
			if (!dropDepth.current) setDropOver(false);
		},
		onDrop: (event) => {
			dropDepth.current = 0;
			setDropOver(false);
			dropHandlers.onDrop(event);
		},
	};
	// Row drag: an object row is the handle, ANY row can be the landing spot —
	// the panel holds no policy, the caller's canDrop decides every rule.
	const [rowDropOver, setRowDropOver] = useState(false);
	const draggableRow = node.kind === "object" && !editing;
	const rowDropTarget = !!(reparent && dragSourceId && reparent.canDrop?.(dragSourceId, node.id));
	const rowDrag = (reparent || draggableRow) && {
		...(draggableRow
			? {
					onDragStart: (event) => {
						event.stopPropagation();
						event.dataTransfer.setData(HIERARCHY_DRAG_MIME, node.id);
						event.dataTransfer.effectAllowed = "move";
						onDragSourceChange?.(node.id);
					},
					onDragEnd: () => {
						setRowDropOver(false);
						onDragSourceChange?.(null);
					},
				}
			: {}),
		onDragEnter: (event) => {
			drop?.onDragEnter(event);
			if (!rowDropTarget || !carriesHierarchyRow(event)) return;
			event.preventDefault();
			setRowDropOver(true);
		},
		// Chrome hands back an EMPTY getData() during dragover, so the source id
		// travels in panel state (set at dragstart) and the payload itself is
		// only read at drop time, where it is readable again.
		onDragOver: (event) => {
			drop?.onDragOver(event);
			if (!rowDropTarget || !carriesHierarchyRow(event)) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "move";
			if (!rowDropOver) setRowDropOver(true);
		},
		onDragLeave: (event) => {
			drop?.onDragLeave(event);
			setRowDropOver(false);
		},
		onDrop: (event) => {
			if (carriesHierarchyRow(event)) {
				setRowDropOver(false);
				const source = event.dataTransfer.getData(HIERARCHY_DRAG_MIME) || dragSourceId;
				if (!source || !reparent?.canDrop?.(source, node.id)) return;
				event.preventDefault();
				event.stopPropagation();
				onDragSourceChange?.(null);
				reparent.onDrop?.(source, node.id);
				return;
			}
			drop?.onDrop(event);
		},
	};
	// A Files drag keeps the exact handlers it always had; the row-drag wrapper
	// only exists when the caller asked for reparenting.
	const dropEvents = rowDrag || drop || null;
	const label = displayHierarchyLabel(node);
	const rowWrapRef = useRef(null);
	const inputRef = useRef(null);
	// A commit/cancel may race the blur that follows the input unmounting;
	// the flag ends the edit session exactly once.
	const doneRef = useRef(false);

	const finish = () => {
		if (doneRef.current) return;
		doneRef.current = true;
		const name = (inputRef.current?.value ?? "").trim();
		if (name) onRenameCommit(name);
		else onRenameCancel(); // an empty name is a cancel, like Unity
		rowWrapRef.current?.focus();
	};
	const cancel = () => {
		if (doneRef.current) return;
		doneRef.current = true;
		onRenameCancel();
	};

	return (
		<div
			ref={rowWrapRef}
			className={"hierarchy-row-wrap" + (selectedId === node.id ? " selected" : "")}
			style={{ "--hierarchy-depth": depth }}
			data-node-id={node.id}
			data-drop={drop || rowDropTarget ? (dropOver || rowDropOver ? "over" : "target") : undefined}
			draggable={draggableRow || undefined}
			{...(dropEvents ?? {})}
			role="treeitem"
			tabIndex={-1}
			aria-selected={selectedId === node.id}
			aria-expanded={branch ? expanded : undefined}
			onContextMenu={(event) => onRowContextMenu(event, node.id)}
		>
			{branch ? (
				<button
					type="button"
					className="hierarchy-toggle"
					aria-label={isKo ? `${label} ${expanded ? "접기" : "펼치기"}` : `${expanded ? "Collapse" : "Expand"} ${label}`}
					onClick={() => onToggle(node.id)}
				>
					{expanded ? "▾" : "▸"}
				</button>
			) : (
				<span className="hierarchy-toggle placeholder" />
			)}
			{editing ? (
				// In-place rename, Unity-style: Enter commits, Escape reverts,
				// blur commits (docs/unity-reference.md §9.7). A div, not the
				// row button — an input inside a button is invalid HTML.
				<div className="hierarchy-row">
					<HierarchyIcon kind={node.kind} />
					<input
						ref={inputRef}
						className="hierarchy-rename-input"
						defaultValue={node.label}
						aria-label={isKo ? `${label} 이름 바꾸기` : `Rename ${label}`}
						autoFocus
						onFocus={(event) => event.currentTarget.select()}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								event.stopPropagation(); // keep the tree hotkey quiet
								finish();
							} else if (event.key === "Escape") {
								event.stopPropagation(); // revert only, not clear-selection
								cancel();
							}
						}}
						onBlur={finish}
					/>
				</div>
			) : (
				<button type="button" className="hierarchy-row" onClick={() => onSelect(node.id)}>
					<HierarchyIcon kind={node.kind} />
					<span className="hierarchy-label">{label}</span>
					{status && <span className="hierarchy-status">{status}</span>}
					{badge !== null && badge !== undefined && badge !== 0 && <span className="hierarchy-badge">{badge}</span>}
				</button>
			)}
		</div>
	);
}

export default function HierarchyPanel({
	selectedId,
	onSelect,
	showB,
	characters = null,
	motionFrames,
	ikMode,
	// The ACTIVE character's row id (#76): IK badges and the IK-mode
	// auto-expand follow whichever cast member owns the session.
	ikRowId = "characterA",
	sceneObjects = [],
	onAddObject,
	onRenameObject,
	onDuplicateObject,
	onDeleteObject,
	onFrameObject,
	propsDrop = null,
	reparent = null,
	scenes,
	activeSceneId,
	onSceneSelect,
	onSceneCreate,
	onSceneDuplicate,
	onSceneRename,
	onSceneDelete,
	beginnerMode = false,
}) {
	const [expanded, setExpanded] = useState(() => new Set(["shot", "characters", "characterA"]));
	const [contextMenu, setContextMenu] = useState(null);
	// Row currently in in-place rename. The panel owns it: F2/Return and the
	// row context menu are the only ways in, so app state stays out of it.
	const [editingId, setEditingId] = useState(null);
	// The row being dragged. dataTransfer.getData() is deliberately blank during
	// dragover in Chrome, so canDrop could never gate the highlight from the
	// payload alone — the id lives here from dragstart until dragend/drop.
	const [dragSourceId, setDragSourceId] = useState(null);
	const treeRef = useRef(null);
	const lastTreeSelectRef = useRef(null);
	const firstRenderRef = useRef(true);
	const pendingScrollRef = useRef(false);
	const activeSceneName = useMemo(() => {
		const availableScenes = scenes?.length ? scenes : FALLBACK_SCENES;
		return (availableScenes.find((scene) => scene.id === activeSceneId) ?? availableScenes[0]).name;
	}, [activeSceneId, scenes]);
	const hierarchyNodes = useMemo(() => {
		const nodes = buildHierarchyNodes(sceneObjects, characters);
		const labelled = nodes.map((node) => node.kind === "scene" ? { ...node, label: activeSceneName } : node);
		if (!beginnerMode) return labelled;
		// Beginner mode keeps the cast as the only editable hierarchy surface.
		// Rig and bone rows are expert controls; they return with Advanced.
		return labelled.map((node) => {
			if (node.id !== "shot") return node;
			const charactersGroup = node.children?.find((child) => child.id === "characters");
			const propsGroup = node.children?.find((child) => child.id === "props");
			// Keep the beginner tree focused on the cast while still exposing
			// objects after the user creates one. This preserves direct selection
			// for viewport/object workflows without surfacing empty expert groups.
			const children = charactersGroup
				? [{ ...charactersGroup, children: (charactersGroup.children ?? []).map(({ children, ...character }) => character) }]
				: [];
			if (propsGroup?.children?.length) children.push(propsGroup);
			return { ...node, children };
		});
	}, [activeSceneName, sceneObjects, characters, beginnerMode]);
	const parents = useMemo(() => indexParents(hierarchyNodes), [hierarchyNodes]);

	useEffect(() => {
		setExpanded((current) => {
			const next = new Set(current);
			let id = selectedId;
			while (parents.has(id)) {
				id = parents.get(id);
				next.add(id);
			}
			if (ikMode) {
				next.add(ikRowId);
				next.add(`${ikRowId}.rig`);
			}
			return next;
		});
	}, [ikMode, ikRowId, parents, selectedId]);

	// Selection made outside the tree (viewport click, plan board, inspector)
	// scrolls the row into view (docs/unity-reference.md §9.6). Tree-originated
	// selections skip this — the browser already scrolls the clicked row. The
	// tab may be hidden at selection time (selecting switches to the inspector),
	// so a hidden-tree selection is remembered and scrolled once the tree shows.
	useEffect(() => {
		if (firstRenderRef.current) {
			firstRenderRef.current = false;
			return;
		}
		if (lastTreeSelectRef.current !== selectedId) pendingScrollRef.current = true;
	}, [selectedId]);

	useEffect(() => {
		const tree = treeRef.current;
		if (!tree || tree.offsetParent === null) return;
		if (!pendingScrollRef.current) return;
		pendingScrollRef.current = false;
		if (!selectedId) return;
		const row = tree.querySelector(`[data-node-id="${CSS.escape(selectedId)}"]`);
		row?.scrollIntoView({ block: "nearest" });
	});

	const toggle = (id) => {
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};
	const badgeFor = (id) => {
		if (id === "characters") {
			return Array.isArray(characters) ? characters.filter((entry) => !entry.hidden).length : (showB ? 2 : 1);
		}
		if (id === "props") return sceneObjects.length;
		return null;
	};
	const statusFor = (id) => {
		if (id === ikRowId && ikMode) return ko("IK ON", "IK 켜짐");
		return null;
	};

	const handleSelect = (id) => {
		lastTreeSelectRef.current = id;
		onSelect(id);
	};

	const openRowMenu = (event, id) => {
		event.preventDefault();
		event.stopPropagation(); // a row pick must not also open the create menu
		if (sceneObjectIdFromHierarchy(id) !== null) {
			setContextMenu({ x: event.clientX, y: event.clientY, height: 148, kind: "object", id });
		} else {
			setContextMenu({ x: event.clientX, y: event.clientY, height: 344, kind: "create" });
		}
	};

	const openCreateMenu = (event) => {
		event.preventDefault(); // suppress the browser menu on the tree only
		setContextMenu({ x: event.clientX, y: event.clientY, height: 344, kind: "create" });
	};

	const handleMenuAction = (action, hierarchyId) => {
		setContextMenu(null);
		if (action === "rename") {
			setEditingId(hierarchyId);
			return;
		}
		const objectId = sceneObjectIdFromHierarchy(hierarchyId);
		if (!objectId) return;
		if (action === "duplicate") onDuplicateObject?.(objectId);
		else if (action === "delete") onDeleteObject?.(objectId);
		else if (action === "frame") onFrameObject?.(objectId);
	};

	const commitRename = (hierarchyId, name) => {
		setEditingId(null);
		const objectId = sceneObjectIdFromHierarchy(hierarchyId);
		if (objectId) onRenameObject?.(objectId, name);
	};

	const cancelRename = () => {
		setEditingId(null);
	};

	// F2 / Return rename the selected row in place while focus is in the
	// tree (docs/unity-reference.md §9.2). The rename input stops its own
	// Enter/Escape, so an active edit never re-triggers this.
	const onTreeKeyDown = (event) => {
		if (editingId) return;
		if (event.key !== "F2" && event.key !== "Enter") return;
		if (sceneObjectIdFromHierarchy(selectedId) === null) return;
		event.preventDefault();
		setEditingId(selectedId);
	};

	const renderNodes = (nodes, depth = 0) =>
		nodes.flatMap((node) => {
			if (node.optional === "showB" && !showB) return [];
			const open = expanded.has(node.id);
			return [
				<TreeRow
					key={node.id}
					node={node}
					depth={depth}
					selectedId={selectedId}
					expanded={open}
					onSelect={handleSelect}
					onToggle={toggle}
					badge={badgeFor(node.id)}
					status={statusFor(node.id)}
					editing={editingId === node.id}
					onRenameCommit={(name) => commitRename(node.id, name)}
					onRenameCancel={cancelRename}
					onRowContextMenu={openRowMenu}
					// A picture dropped on Props — or on any prop already in it —
					// becomes a cutout in the set. Dropping ON an object is the
					// same gesture as dropping on the group it lives in: people
					// aim at the list, not at the heading.
					dropHandlers={propsDrop && (node.kind === "props" || node.kind === "object") ? propsDrop.handlers : null}
					reparent={reparent}
					dragSourceId={dragSourceId}
					onDragSourceChange={setDragSourceId}
				/>,
				...(node.children && open ? renderNodes(node.children, depth + 1) : []),
			];
		});

	return (
		<section className="hierarchy-pane" aria-label={ko("Scene hierarchy", "장면 계층")}>
			<div className="hierarchy-heading">
				<div>
					<span className="hierarchy-kicker">{ko("Hierarchy", "계층")}</span>
					<strong>{ko("Scene structure", "장면 구조")}</strong>
				</div>
				<span className="hierarchy-frame-status">{motionFrames ? (isKo ? `${motionFrames}프레임` : `${motionFrames} frames`) : ko("Blocking", "블로킹")}</span>
			</div>
			<SceneSwitcher
				scenes={scenes}
				activeSceneId={activeSceneId}
				onSceneSelect={onSceneSelect}
				onSceneCreate={onSceneCreate}
				onSceneDuplicate={onSceneDuplicate}
				onSceneRename={onSceneRename}
				onSceneDelete={onSceneDelete}
			/>
			{onAddObject && (
				<div className="hierarchy-toolbar">
					<AddObjectMenu onAdd={onAddObject} />
					<span className="hierarchy-frame-status">{motionFrames ? (isKo ? `${motionFrames}프레임` : `${motionFrames} frames`) : ko("Blocking", "블로킹")}</span>
				</div>
			)}
			<div className="hierarchy-tree" role="tree" ref={treeRef} onKeyDown={onTreeKeyDown} onContextMenu={openCreateMenu}>
				{renderNodes(hierarchyNodes)}
			</div>
			<RowContextMenu
				menu={contextMenu}
				onClose={() => setContextMenu(null)}
				onAction={handleMenuAction}
				onAddObject={(kind) => {
					setContextMenu(null);
					onAddObject?.(kind);
				}}
			/>
		</section>
	);
}
