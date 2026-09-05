#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { HIERARCHY_NODES, buildHierarchyNodes, attachBoneLabel } from "../src/hierarchy-model.js";

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
expect(
	"Rig exposes five human-readable body groups",
	["rig.torso", "rig.leftArm", "rig.rightArm", "rig.leftLeg", "rig.rightLeg"].every(
		(id) => byId.get(id)?.parent === "characterA.rig",
	),
);
expect(
	"torso, head, shoulders, elbows, hands, knees, and feet are directly selectable",
	["rig.hips", "rig.spine", "rig.chest", "rig.neck", "rig.head", "rig.leftShoulder", "rig.rightShoulder", "rig.leftElbow", "rig.rightElbow", "rig.leftHand", "rig.rightHand", "rig.leftKnee", "rig.rightKnee", "rig.leftFoot", "rig.rightFoot"]
		.every((id) => byId.has(id)),
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
expect("the second character carries its own attachments", rowIds(findRow(attachedTree, "characterB")).join() === "object:ball");
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
expect("scene selector is separate from entity tree", panelSource.includes('className="scene-switcher"') && panelSource.includes('className="hierarchy-tree"'));
expect("scene rename supports double-click", panelSource.includes("onDoubleClick={() => setEditingId(scene.id)}"));
expect("scene deletion requires a second deliberate click", panelSource.includes("deleteArmed") && panelSource.includes('ko("Confirm delete", "삭제 확인")'));
expect("active scene clicks do not repeat selection callbacks", panelSource.includes("if (!active) onSceneSelect?.(scene.id)"));
expect("last scene deletion is protected", panelSource.includes("disabled={availableScenes.length <= 1}"));
expect("entity tree root follows the active scene name", panelSource.includes('node.kind === "scene" ? { ...node, label: activeSceneName } : node'));

const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
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
expect("App seals shots inside the active Scene", appSource.includes("shotDocument: shotDocumentRef.current"));
expect("App persists the unified Scene document", appSource.includes("serializeSceneDocument({"));
expect("Scene switch snapshots outgoing work first", appSource.indexOf("const savedScenes = snapshotActiveScene();", appSource.indexOf("function selectSceneDocument")) < appSource.indexOf("openScene(target, savedScenes);", appSource.indexOf("function selectSceneDocument")));

if (failures) process.exit(1);
console.log("all hierarchy checks PASS");
