#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { HIERARCHY_NODES, buildHierarchyNodes, attachBoneLabel, parseRigNodeId, rigSubtree } from "../src/hierarchy-model.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
function flatten(nodes, parent = null, depth = 0, out = []) {
	for (const node of nodes) {
		out.push({ ...node, parent, depth });
		if (node.children) flatten(node.children, node.id, depth + 1, out);
	}
	return out;
}

const nodes = flatten(HIERARCHY_NODES);
const byId = new Map(nodes.map((node) => [node.id, node]));
expect("hierarchy IDs are unique", byId.size === nodes.length, `${byId.size}/${nodes.length}`);
expect("Scene is the single hierarchy root", HIERARCHY_NODES.length === 1 && HIERARCHY_NODES[0].id === "shot" && HIERARCHY_NODES[0].label === "SCENE 01" && HIERARCHY_NODES[0].kind === "scene");
expect("Camera belongs directly to Scene", byId.get("camera")?.parent === "shot");
expect("Characters group owns Character 1", byId.get("characterA")?.parent === "characters");
// The tree lists scene entities only — workflow nodes (motion, prompt
// blocks, IK, root path) moved to the sidebar's Shot/Motion tabs.
expect(
	"workflow nodes stay out of the scene tree",
	["characterA.motion", "characterA.baseMotion", "characterA.promptBlocks", "characterA.ik", "rootPath", "characterA.character", "characterB.character"].every(
		(id) => !byId.has(id),
	),
);
expect("Rig belongs to Character 1", byId.get("characterA.rig")?.parent === "characterA");
// #76: every rig node id is namespaced under its character row.
expect(
	"Rig exposes five human-readable body groups",
	["rig.torso", "rig.leftArm", "rig.rightArm", "rig.leftLeg", "rig.rightLeg"].every(
		(token) => byId.get(`characterA.${token}`)?.parent === "characterA.rig",
	),
);
expect(
	"torso, head, shoulders, elbows, hands, knees, and feet are directly selectable",
	["rig.hips", "rig.spine", "rig.chest", "rig.neck", "rig.head", "rig.leftShoulder", "rig.rightShoulder", "rig.leftElbow", "rig.rightElbow", "rig.leftHand", "rig.rightHand", "rig.leftKnee", "rig.rightKnee", "rig.leftFoot", "rig.rightFoot"]
		.every((token) => byId.has(`characterA.${token}`)),
);

/* ------------------------------------------- rig id namespace (#76) --- */

expect(
	"a rig node id parses into its row and bone token",
	JSON.stringify(parseRigNodeId("characterB.rig.leftArm")) === JSON.stringify({ rowId: "characterB", token: "rig.leftArm" }),
);
expect(
	"the rig ROOT parses with the bare rig token",
	JSON.stringify(parseRigNodeId("characterA.rig")) === JSON.stringify({ rowId: "characterA", token: "rig" }),
);
expect(
	"extra cast rows parse through their character id",
	JSON.stringify(parseRigNodeId("character:cast-9.rig.head")) === JSON.stringify({ rowId: "character:cast-9", token: "rig.head" }),
);
expect(
	"non-rig ids never parse",
	["characterA", "camera", "rig.leftArm", "object:bat", null, undefined].every((id) => parseRigNodeId(id) === null),
);
expect(
	"rigSubtree namespaces every node under the row",
	flatten([rigSubtree("characterB")]).every((node) => node.id.startsWith("characterB.rig")),
);
expect(
	"two rows' subtrees never collide",
	(() => {
		const a = flatten([rigSubtree("characterA")]).map((node) => node.id);
		const b = new Set(flatten([rigSubtree("characterB")]).map((node) => node.id));
		return a.every((id) => !b.has(id));
	})(),
);
expect("Environment stays at the Scene level", byId.get("environment")?.parent === "shot");
expect("Props stay at the Scene level", byId.get("props")?.parent === "shot");
expect("tree depth stays scannable", Math.max(...nodes.map((node) => node.depth)) <= 5);

/* ------------------------------------------------- attached props (A2) --- */

const CAST = [{ id: "cast-1" }, { id: "cast-2" }];
const findRow = (nodes, id) => flatten(nodes).find((node) => node.id === id);
const rowIds = (node) => (node?.children ?? []).map((child) => child.id);

// A prop attached to a character is carried BY it, so it leaves the flat Props
// list and reads under the character row instead.
const attachedTree = buildHierarchyNodes(
	[
		{ id: "bat", name: "Bat", attach: { characterId: "cast-1", bone: "rightHand" } },
		{ id: "hat", name: "Hat", attach: { characterId: "cast-1", bone: null } },
		{ id: "ball", name: "Ball", attach: { characterId: "cast-2", bone: "leftHand" } },
		{ id: "crate", name: "Crate" },
	],
	CAST,
);
expect("attached object nests under its character row", rowIds(findRow(attachedTree, "characterA")).includes("object:bat"));
expect("attached rows keep the object row id and kind", findRow(attachedTree, "object:bat")?.kind === "object");
expect("attached object leaves the Props list", rowIds(findRow(attachedTree, "props")).join() === "object:crate");
expect("bone attach carries the bone in the label", findRow(attachedTree, "object:bat")?.label === "Bat · Right Hand");
expect("root attach keeps the plain object name", findRow(attachedTree, "object:hat")?.label === "Hat");
// #78: every cast member carries its own rig subtree ahead of its luggage.
expect("the second character carries its own attachments", rowIds(findRow(attachedTree, "characterB")).join() === "characterB.rig,object:ball");
expect("the second character's rig expands with its body groups", rowIds(findRow(attachedTree, "characterB.rig")).length === 5);
expect(
	"extra cast rows carry namespaced rigs too",
	(() => {
		const tree = buildHierarchyNodes([], [{ id: "c1" }, { id: "c2" }, { id: "c3" }]);
		return Boolean(findRow(tree, "character:c3.rig")) && rowIds(findRow(tree, "character:c3")).join() === "character:c3.rig";
	})(),
);
expect(
	"attaching to Character 1 does not displace the rig subtree",
	rowIds(findRow(attachedTree, "characterA")).join() === "characterA.rig,object:bat,object:hat",
);

// The character row a prop lands under must exist: a dangling or hidden cast
// member would swallow the row entirely, so those attachments stay in Props.
const strayTree = buildHierarchyNodes(
	[
		{ id: "bat", name: "Bat", attach: { characterId: "ghost", bone: "rightHand" } },
		{ id: "hat", name: "Hat", attach: { characterId: "cast-2", bone: null } },
		{ id: "ball", name: "Ball", attach: null },
	],
	[{ id: "cast-1" }, { id: "cast-2", hidden: true }],
);
expect("unknown characterId falls back to Props", rowIds(findRow(strayTree, "props")).includes("object:bat"));
expect("hidden characterId falls back to Props", rowIds(findRow(strayTree, "props")).includes("object:hat"));
expect("a null attach is an ordinary prop", rowIds(findRow(strayTree, "props")).includes("object:ball"));
expect("the fallback label carries no bone", findRow(strayTree, "object:bat")?.label === "Bat");
expect("hidden characters still own no row", !findRow(strayTree, "characterB"));

// Grouping is untouched by attachment: rooted parents keep nesting, orphans
// keep surfacing at the top level.
const groupedTree = buildHierarchyNodes([
	{ id: "rocket", name: "Rocket" },
	{ id: "fin", name: "Fin", parent: "rocket" },
	{ id: "lost", name: "Lost", parent: "deleted" },
]);
expect("grouped props still nest under their parent", rowIds(findRow(groupedTree, "object:rocket")).join() === "object:fin");
expect("orphaned props still surface at the Props top level", rowIds(findRow(groupedTree, "props")).join() === "object:rocket,object:lost");

// An attached object is not a grouping parent — its children would otherwise
// disappear with it, so they surface at the Props top level like orphans.
const carriedGroupTree = buildHierarchyNodes(
	[
		{ id: "bat", name: "Bat", attach: { characterId: "cast-1", bone: "rightHand" }, parent: "rocket" },
		{ id: "grip", name: "Grip", parent: "bat" },
		{ id: "rocket", name: "Rocket" },
	],
	CAST,
);
expect("an attached object never nests under a prop", !rowIds(findRow(carriedGroupTree, "object:rocket")).includes("object:bat"));
expect("children of an attached object surface in Props", rowIds(findRow(carriedGroupTree, "props")).includes("object:grip"));
expect("no nesting is built under an attached row", !findRow(carriedGroupTree, "object:bat")?.children);

expect(
	"bone keys read as English rig labels",
	attachBoneLabel("rightHand") === "Right Hand" && attachBoneLabel("hips") === "Hips" && attachBoneLabel("leftShoulder") === "Left Shoulder",
);
expect("a missing bone yields no label", attachBoneLabel(null) === null && attachBoneLabel("") === null && attachBoneLabel(undefined) === null);

const panelSource = await readFile(new URL("../src/hierarchy-panel.jsx", import.meta.url), "utf8");
// Row drag-and-drop. The gesture itself needs a real DragEvent, so the browser
// gate (G2) owns the behaviour; here we pin the wiring the App depends on.
expect("row drags carry the private hierarchy MIME", panelSource.includes('export const HIERARCHY_DRAG_MIME = "application/x-cclay-hierarchy"'));
expect("dragstart publishes the row id as a move", panelSource.includes("event.dataTransfer.setData(HIERARCHY_DRAG_MIME, node.id)") && panelSource.includes('event.dataTransfer.effectAllowed = "move"'));
expect("only object rows are draggable, and never mid-rename", panelSource.includes('const draggableRow = node.kind === "object" && !editing'));
expect("the panel accepts a reparent prop", panelSource.includes("reparent = null,") && panelSource.includes("reparent={reparent}"));
expect("canDrop gates both the highlight and the drop", panelSource.includes("reparent.canDrop?.(dragSourceId, node.id)") && panelSource.includes("!reparent?.canDrop?.(source, node.id)) return;"));
expect("the drop calls back exactly once per drop", (panelSource.match(/reparent\.onDrop\?\.\(/g) ?? []).length === 1);
expect("row drops reuse the existing data-drop styling", panelSource.includes('data-drop={drop || rowDropTarget ? (dropOver || rowDropOver ? "over" : "target") : undefined}'));
expect("the dragged row id survives Chrome's blank dragover payload", panelSource.includes("const [dragSourceId, setDragSourceId] = useState(null)") && panelSource.includes("onDragSourceChange?.(node.id)"));
expect("a Files drag keeps its original handlers", panelSource.includes("const dropEvents = rowDrag || drop || null") && panelSource.includes("if (!event.dataTransfer?.types?.includes?.(\"Files\")) return;"));
expect("row handlers never swallow a picture drop", panelSource.includes("if (carriesHierarchyRow(event)) {") && panelSource.includes("drop?.onDrop(event);"));

for (const callback of ["onSceneSelect", "onSceneCreate", "onSceneDuplicate", "onSceneRename", "onSceneDelete"]) {
	expect(`panel exposes ${callback}`, panelSource.includes(callback));
}
expect(
	"the scene selector rides the tree root row",
	panelSource.includes('className="hierarchy-scene-pill"') &&
		panelSource.includes("const sceneRoot = node.id === SCENE_ROOT_ID;") &&
		panelSource.includes('ariaLabel={ko("Select scene", "장면 선택")}'),
);
expect("the scene list is the portaled Dropdown, so the panel cannot clip it", panelSource.includes('import { Dropdown } from "./ui.jsx"'));
expect("the scene list ends with a create item", panelSource.includes('{ value: NEW_SCENE_OPTION, label: ko("+ New scene", "+ 새 장면") }'));
expect("the pill's clicks never reach the row, so picking a scene cannot fold the tree", panelSource.includes("onClick={(event) => event.stopPropagation()}"));
expect("the root row right-click opens scene verbs, not the object catalogue", panelSource.includes("} else if (id === SCENE_ROOT_ID) {") && panelSource.includes('kind: "scene",'));
expect(
	"the root row prints the scene name once: the pill is the name",
	panelSource.includes("showLabel={!sceneRoot}") &&
		panelSource.includes("{showLabel && <span className=\"hierarchy-label\">{label}</span>}") &&
		panelSource.includes("rowExtra={sceneRoot && !editing ? ("),
);
// The row outlives its renames: a second rename on the same row must not be
// blocked by the first session's "already finished" flag.
expect("the once-only rename flag is per edit session", panelSource.includes("if (editing) doneRef.current = false;"));
expect("scene rename supports double-click, on the row icon and on the pill", panelSource.includes("onRenameStart={sceneRoot ? () => setEditingId(node.id) : null}") && panelSource.includes("onRenameStart={() => setEditingId(node.id)}"));
expect("F2 on the root row renames the scene document", panelSource.includes("if (selectedId !== SCENE_ROOT_ID && sceneObjectIdFromHierarchy(selectedId) === null) return;") && panelSource.includes("if (hierarchyId === SCENE_ROOT_ID) {"));
expect("scene deletion requires a second deliberate click", panelSource.includes("deleteArmed") && panelSource.includes('ko("Confirm delete", "삭제 확인")'));
expect("active scene clicks do not repeat selection callbacks", panelSource.includes("else if (value !== activeSceneId) onSceneSelect?.(value)"));
expect(
	"last scene deletion is protected, with a reason",
	panelSource.includes("{menu.canDelete && (") &&
		panelSource.includes("canDelete: availableScenes.length > 1,") &&
		panelSource.includes('setSceneHint(ko("At least one scene is required", "장면은 최소 하나 필요합니다"))'),
);
expect("entity tree root follows the active scene name", panelSource.includes('node.kind === "scene" ? { ...node, label: activeSceneName } : node'));

// The studio source spans App.jsx and app-stage.jsx (module-level extraction); pin against both.
const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8")
	+ await readFile(new URL("../src/app-stage.jsx", import.meta.url), "utf8");
for (const [nodeId, focusId] of [["rig.head", "head"], ["rig.chest", "chest"], ["rig.leftShoulder", "leftShoulder"], ["rig.rightShoulder", "rightShoulder"]]) {
	expect(`${nodeId} routes to its exact IK control`, appSource.includes(`"${nodeId}": "${focusId}"`));
}
expect(
	"every IK shutdown clears mode and stale control focus",
	appSource.includes("function leaveIkMode()") &&
		appSource.includes("setIkMode(false);\n\t\tsetIkFocus(null);") &&
		(appSource.match(/leaveIkMode\(\);/g) ?? []).length === 5, // incl. the character-switch and line-edit-entry shutdowns
);
for (const prop of ["scenes={scenes}", "activeSceneId={activeSceneId}", "onSceneSelect={selectSceneDocument}", "onSceneCreate={createSceneDocumentFromUi}", "onSceneDuplicate={duplicateSceneDocumentFromUi}", "onSceneRename={renameSceneDocumentFromUi}", "onSceneDelete={deleteSceneDocumentFromUi}"]) {
	expect(`App wires ${prop.split("=")[0]}`, appSource.includes(prop));
}
// The project row keeps the name and the dirty dot; opening a project is the
// Project menu's "Open Project…", not a second button in the hierarchy column.
expect("the hierarchy column has no duplicate Projects… button", !appSource.includes('ko("Projects…", "프로젝트…")'));
expect("the Project menu still opens the project browser", appSource.includes('ko("Open Project…", "프로젝트 열기…")'));
expect("App seals shots inside the active Scene", appSource.includes("shotDocument: shotDocumentRef.current"));
expect("App persists the unified Scene document", appSource.includes("serializeSceneDocument({"));
expect("Scene switch snapshots outgoing work first", appSource.indexOf("const savedScenes = snapshotActiveScene();", appSource.indexOf("function selectSceneDocument")) < appSource.indexOf("openScene(target, savedScenes);", appSource.indexOf("function selectSceneDocument")));

if (failures) process.exit(1);
console.log("all hierarchy checks PASS");
