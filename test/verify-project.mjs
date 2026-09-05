// Project file envelope: create/parse round-trip, validation, and the
// boundaries that keep a project file from clobbering the session.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import {
	createProjectDocument,
	readProjectDocument,
	verifyEmbeddedAsset,
	createWorkflowGraph,
	normalizeWorkflowGraph,
	isWorkflowGraph,
	PROJECT_VERSION,
	PROJECT_EXTENSION,
} from "../src/project.js";
import { createSceneDocument, createSceneStage, SCENES_VERSION } from "../src/scenes.js";
import { ASSET_MAX_SOURCE_BYTES, assetIdForBytes, referencedAssetIds } from "../src/scene-assets.js";

// The studio source spans App.jsx and app-stage.jsx (module-level extraction); pin against both.
const appSource = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8")
	+ readFileSync(new URL("../src/app-stage.jsx", import.meta.url), "utf8");

// --- envelope round trip --------------------------------------------------
const projectPose = { id: "custom_1", label: "My Pose", bones: { hips: [0.1, 0, 0] } };
const scenesDocument = createSceneDocument("SCENE 01");
scenesDocument.scenes[0].stage = createSceneStage({
	characters: [{ id: "char-a", model: "x-bot-tpose", x: 1, z: -2, rot: 30, tint: "#a1b2c3", subject: "a robot", pose: projectPose }],
});
const doc = createProjectDocument({
	scenesDocument,
	workspaceLayout: { hierarchyWidth: 320, sidebarWidth: 400 },
	customPoses: [projectPose],
	name: "Demo Reel",
});
const parsed = readProjectDocument(JSON.stringify(doc));
assert.equal(parsed.ok, true);
assert.equal(parsed.project.name, "Demo Reel");
assert.equal(parsed.project.scenesDocument.scenes[0].stage.characters[0].model, "x-bot-tpose");
assert.equal(parsed.project.scenesDocument.scenes[0].stage.characters[0].tint, "#a1b2c3");
assert.equal(parsed.project.workspaceLayout.hierarchyWidth, 320);
assert.equal(parsed.project.customPoses.length, 1);
assert.deepEqual(parsed.project.scenesDocument.scenes[0].stage.characters[0].pose, projectPose, "a project scene keeps its embedded pose data after a file round-trip");

// --- workflow graph envelope + migration ---------------------------------
const workflow = {
	version: 1,
	nodes: [
		{ id: "prompt", type: "Text", position: { x: 24, y: 48 }, data: { text: "a clay robot", status: "ready" } },
		{ id: "scene", type: "CozyClayScene", position: { x: 320, y: 48 }, data: { sceneId: "SCENE 01", outputUrl: "/renders/scene.mp4" } },
		{ id: "bad-duplicate", type: "Ignored", position: { x: 0, y: 0 } },
	],
	edges: [
		{ id: "prompt-scene", source: "prompt", target: "scene" },
		{ source: "missing", target: "scene" },
	],
};
const workflowDocument = createProjectDocument({ scenesDocument, workflow });
assert.equal(workflowDocument.version, PROJECT_VERSION, "project envelope version advances with workflow persistence");
assert.deepEqual(workflowDocument.workflow, normalizeWorkflowGraph(workflow), "project creation stores a sanitized workflow graph");
const workflowRoundTrip = readProjectDocument(JSON.stringify(workflowDocument));
assert.equal(workflowRoundTrip.ok, true);
assert.deepEqual(workflowRoundTrip.project.workflow, workflowDocument.workflow, "workflow graph survives a project round-trip");
assert.deepEqual(createWorkflowGraph(), { version: 1, nodes: [], edges: [] }, "new projects start with an empty workflow graph");
assert.equal(isWorkflowGraph(workflowDocument.workflow), true, "normalized graph passes schema validation");
assert.equal(isWorkflowGraph({ version: 1, nodes: [{ id: "x", position: { x: 0, y: 0 } }], edges: [] }), true, "node type/data are optional in the persisted schema");
assert.equal(isWorkflowGraph({ version: 1, nodes: [], edges: [{ source: "missing", target: "also-missing" }] }), false, "dangling workflow edges fail validation");

const legacyWithoutWorkflow = { ...doc, version: 2 };
delete legacyWithoutWorkflow.workflow;
const migratedLegacy = readProjectDocument(JSON.stringify(legacyWithoutWorkflow));
assert.equal(migratedLegacy.ok, true, "pre-workflow project files remain readable");
assert.deepEqual(migratedLegacy.project.workflow, createWorkflowGraph(), "legacy files migrate to an empty workflow graph");
const malformedWorkflow = readProjectDocument(JSON.stringify({ ...doc, workflow: { version: 99, nodes: "bad", edges: [] } }));
assert.equal(malformedWorkflow.ok, true, "malformed workflow data does not block opening the scene project");
assert.deepEqual(malformedWorkflow.project.workflow, createWorkflowGraph(), "unsupported workflow data falls back to the safe default");

// --- embedded scene assets -------------------------------------------------
const renderedBytes = new Uint8Array([1, 2, 3]);
const sourceBytes = new Uint8Array([4, 5, 6]);
const matteBytes = new Uint8Array([7, 8, 9]);
const orphanBytes = new Uint8Array([10]);
const [renderedAssetId, sourceAssetId, matteAssetId, orphanAssetId] = await Promise.all([
	assetIdForBytes(renderedBytes, webcrypto.subtle),
	assetIdForBytes(sourceBytes, webcrypto.subtle),
	assetIdForBytes(matteBytes, webcrypto.subtle),
	assetIdForBytes(orphanBytes, webcrypto.subtle),
]);
const assetScenesDocument = createSceneDocument("CUTOUTS");
assetScenesDocument.scenes[0].objects = [{
	id: "matted-cutout",
	renderer: "cutout",
	assetId: renderedAssetId,
	sourceAssetId,
	matteAssetId,
}];
const fakeAssets = [
	{ id: renderedAssetId, type: "image/png", width: 80, height: 60, name: "rendered.png", bytes: renderedBytes },
	{ id: sourceAssetId, type: "image/jpeg", width: 80, height: 60, name: "source.jpg", bytes: sourceBytes },
	{ id: matteAssetId, type: "image/png", width: 80, height: 60, name: "matte.png", bytes: matteBytes },
	{ id: orphanAssetId, type: "image/png", width: 80, height: 60, name: "orphan.png", bytes: orphanBytes },
];
const assetDocument = createProjectDocument({ scenesDocument: assetScenesDocument, assets: fakeAssets });
const embeddedAssetIds = assetDocument.assets.map((asset) => asset.id).sort();
assert.deepEqual(embeddedAssetIds, [...referencedAssetIds(assetScenesDocument.scenes)].sort(), "only the matted cutout asset closure is embedded");
assert.equal(assetDocument.version, PROJECT_VERSION, "asset-bearing documents use the current envelope version");
assert.ok(assetDocument.assets.every((asset) => typeof asset.bytes === "string" && !asset.bytes.startsWith("data:")), "asset bytes are bare base64");
const parsedAssets = readProjectDocument(JSON.stringify(assetDocument));
assert.equal(parsedAssets.ok, true);
assert.deepEqual(
	parsedAssets.project.assets.map(({ id: assetId, type, width, height, name, bytes }) => ({ assetId, type, width, height, name, bytes: [...new Uint8Array(bytes)] })),
	assetDocument.assets.map(({ id: assetId, type, width, height, name, bytes }) => ({
		assetId,
		type,
		width,
		height,
		name,
		bytes: [...Buffer.from(bytes, "base64")],
	})),
	"embedded asset records round-trip byte-for-byte",
);

// --- embedded hash verification -------------------------------------------
assert.equal(await verifyEmbeddedAsset(fakeAssets[0], webcrypto.subtle), true, "matching embedded bytes verify against their content address");
assert.equal(await verifyEmbeddedAsset({ ...fakeAssets[0], id: sourceAssetId }, webcrypto.subtle), false, "mismatched embedded bytes fail content-address verification");
assert.deepEqual(
	fakeAssets.filter((asset) => referencedAssetIds(assetScenesDocument.scenes).has(asset.id)).map((asset) => asset.id).sort(),
	[renderedAssetId, sourceAssetId, matteAssetId].sort(),
	"the referenced closure excludes unrelated embedded ids",
);

// --- validation boundaries ------------------------------------------------
assert.equal(readProjectDocument("{broken").ok, false, "corrupt JSON rejected");
assert.equal(readProjectDocument("{broken").reason, "corrupt");
assert.equal(readProjectDocument(JSON.stringify({ app: "cozyclay", kind: "project", version: PROJECT_VERSION + 1 })).reason, "future", "a newer file version never loads");
assert.equal(readProjectDocument(JSON.stringify({ app: "other", kind: "project", version: 1 })).reason, "not-a-project");
assert.equal(
	readProjectDocument(JSON.stringify({ app: "cozyclay", kind: "project", version: 1, scenes: { version: SCENES_VERSION + 1, scenes: [] } })).reason,
	"scenes-invalid",
	"a project holding future scenes stays sealed",
);

// name fallback + pose filtering
const unnamed = readProjectDocument(JSON.stringify(createProjectDocument({ scenesDocument, name: "  " })));
assert.equal(unnamed.project.name, "Untitled");
const dirtyPoses = readProjectDocument(JSON.stringify({ ...doc, poseLibrary: [{ id: "ok", bones: {} }, { nope: true }, null, { id: 3, bones: {} }] }));
assert.equal(dirtyPoses.project.customPoses.length, 1, "pose library entries without id+bones are dropped");

const { assets: _v2Assets, ...v1Document } = { ...doc, version: 1 };
const parsedV1 = readProjectDocument(JSON.stringify(v1Document));
assert.equal(parsedV1.ok, true, "v1 documents without assets remain readable");
assert.deepEqual(parsedV1.project.assets, [], "v1 documents produce no assets to hydrate");
const malformedAssets = readProjectDocument(JSON.stringify({
	...assetDocument,
	assets: [
		{ ...assetDocument.assets[0], id: "junk" },
		{ ...assetDocument.assets[1], bytes: "not base64!" },
		{ ...assetDocument.assets[2], bytes: "A".repeat(Math.ceil((ASSET_MAX_SOURCE_BYTES + 1) / 3) * 4) },
	],
}));
assert.equal(malformedAssets.ok, true, "malformed embedded assets never reject a project");
assert.deepEqual(malformedAssets.project.assets, [], "malformed embedded assets are skipped");
assert.equal(malformedAssets.warnings.length, 3, "each skipped embedded asset is warned about");

// --- handle re-authorization (#51) -----------------------------------------
// Chromium demotes a persisted handle's permission to "prompt" on the next
// visit; requestHandlePermission escalates it back inside a user gesture.
import { requestHandlePermission } from "../src/project.js";

{
	const calls = [];
	const handle = (query, request) => ({
		async queryPermission(options) {
			calls.push(["query", options?.mode]);
			if (query instanceof Error) throw query;
			return query;
		},
		async requestPermission(options) {
			calls.push(["request", options?.mode]);
			if (request instanceof Error) throw request;
			return request;
		},
	});

	calls.length = 0;
	assert.equal(await requestHandlePermission(handle("granted", "granted")), "granted", "a granted handle stays granted");
	assert.deepEqual(calls, [["query", "readwrite"]], "a granted handle never re-prompts");

	calls.length = 0;
	assert.equal(await requestHandlePermission(handle("prompt", "granted")), "granted", "a demoted handle is re-requested");
	assert.deepEqual(calls, [["query", "readwrite"], ["request", "readwrite"]], "a demoted handle escalates through requestPermission");

	assert.equal(await requestHandlePermission(handle("prompt", "denied")), "denied", "a refused prompt reports denied");
	assert.equal(await requestHandlePermission(handle(new Error("boom"), "granted")), "denied", "a throwing queryPermission reports denied, never throws");
	assert.equal(await requestHandlePermission(handle("prompt", new Error("boom"))), "denied", "a throwing requestPermission reports denied, never throws");
}

const browserSource = readFileSync(new URL("../src/project-browser.jsx", import.meta.url), "utf8");
assert.match(appSource, /requestHandlePermission/, "opening a stored handle re-authorizes it inside the click gesture (#51)");
assert.match(browserSource, /requestHandlePermission/, "the projects folder offers one-click re-authorization (#51)");

// --- App wiring ------------------------------------------------------------
assert.match(appSource, /createProjectDocument/, "App builds the project envelope");
assert.match(appSource, /readProjectDocument/, "App parses project files");
assert.match(appSource, /pickProjectFileForSave/, "Save uses the FS Access picker");
assert.match(appSource, /downloadProjectFallback/, "non-FS-Access browsers get a download fallback");
// The store itself happens inside project.js (openProjectFile/pickProjectFileForSave
// call storeProjectHandle); App's side of the contract is restoring it. The old pin
// on appSource was satisfied by a dead import, not by a call.
assert.match(readFileSync(new URL("../src/project.js", import.meta.url), "utf8"), /await storeProjectHandle\(/, "the last handle is remembered for auto-restore");
assert.match(appSource, /loadStoredProjectHandle/, "App restores the remembered handle on boot");
assert.match(appSource, /queryHandlePermission/, "auto-restore only with a granted handle");
assert.match(appSource, /referencedAssetIds/, "export finds the complete referenced asset closure");
assert.match(appSource, /getAsset/, "export reads referenced asset records from IndexedDB");
assert.match(appSource, /putAsset/, "open restores embedded asset records to IndexedDB");
assert.match(appSource, /projectDirty/, "unsaved changes surface as a dirty marker");
assert.ok(PROJECT_EXTENSION.length > 1, "project files carry an extension");

console.log("embedded asset round-trip and compatibility checks PASS");
console.log("all project file checks PASS");
