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
	MOTION_MAX_BYTES,
	PROJECT_MAX_RESOURCE_BYTES,
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
const embeddedAssetIds = assetDocument.resources.assets.map((asset) => asset.id).sort();
assert.deepEqual(embeddedAssetIds, [...referencedAssetIds(assetScenesDocument.scenes)].sort(), "only the matted cutout asset closure is embedded");
assert.equal(assetDocument.version, PROJECT_VERSION, "asset-bearing documents use the current envelope version");
assert.equal("assets" in assetDocument, false, "v4 documents carry images only under resources, never at the top level");
assert.ok(assetDocument.resources.assets.every((asset) => typeof asset.bytes === "string" && !asset.bytes.startsWith("data:")), "asset bytes are bare base64");
const parsedAssets = readProjectDocument(JSON.stringify(assetDocument));
assert.equal(parsedAssets.ok, true);
assert.deepEqual(parsedAssets.problems, [], "a clean document reports no resource problems");
assert.deepEqual(
	parsedAssets.project.assets.map(({ id: assetId, type, width, height, name, bytes }) => ({ assetId, type, width, height, name, bytes: [...new Uint8Array(bytes)] })),
	assetDocument.resources.assets.map(({ id: assetId, type, width, height, name, bytes }) => ({
		assetId,
		type,
		width,
		height,
		name,
		bytes: [...Buffer.from(bytes, "base64")],
	})),
	"embedded asset records round-trip byte-for-byte",
);
const workflowAssetDocument = createProjectDocument({
	scenesDocument: createSceneDocument("WORKFLOW ONLY"),
	workflow: {
		version: 1,
		nodes: [{
			id: "scene-output",
			type: "scene",
			position: { x: 0, y: 0 },
			data: { resultUrl: { assetRef: sourceAssetId } },
		}],
		edges: [],
	},
	assets: fakeAssets,
});
assert.deepEqual(
	workflowAssetDocument.resources.assets.map((asset) => asset.id),
	[sourceAssetId],
	"workflow assetRefs are included even without a scene-object reference",
);
const workflowAssetRoundTrip = readProjectDocument(JSON.stringify(workflowAssetDocument));
assert.deepEqual(
	workflowAssetRoundTrip.project.assets.map((asset) => asset.id),
	[sourceAssetId],
	"workflow-only embedded assets round-trip through the project reader",
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

const { resources: _v4Resources, ...v1Document } = { ...doc, version: 1 };
const parsedV1 = readProjectDocument(JSON.stringify(v1Document));
assert.equal(parsedV1.ok, true, "v1 documents without assets remain readable");
assert.deepEqual(parsedV1.project.assets, [], "v1 documents produce no assets to hydrate");
assert.deepEqual(parsedV1.project.motions, [], "pre-v4 documents produce no motions to hydrate");
const malformedAssets = readProjectDocument(JSON.stringify({
	...assetDocument,
	resources: {
		...assetDocument.resources,
		assets: [
			{ ...assetDocument.resources.assets[0], id: "junk" },
			{ ...assetDocument.resources.assets[1], bytes: "not base64!" },
			{ ...assetDocument.resources.assets[2], bytes: "A".repeat(Math.ceil((ASSET_MAX_SOURCE_BYTES + 1) / 3) * 4) },
			assetDocument.resources.assets[0],
			assetDocument.resources.assets[0],
		],
	},
}));
assert.equal(malformedAssets.ok, true, "malformed embedded assets never reject a project");
assert.deepEqual(malformedAssets.project.assets.map((asset) => asset.id), [assetDocument.resources.assets[0].id], "malformed and repeated embedded assets are skipped");
assert.equal(malformedAssets.warnings.length, 4, "each skipped embedded asset is warned about");
assert.deepEqual(
	malformedAssets.problems.map(({ kind, id, code }) => ({ kind, id, code })),
	[
		{ kind: "image", id: "junk", code: "bad-id" },
		{ kind: "image", id: assetDocument.resources.assets[1].id, code: "bad-base64" },
		{ kind: "image", id: assetDocument.resources.assets[2].id, code: "too-large" },
		{ kind: "image", id: assetDocument.resources.assets[0].id, code: "duplicate" },
	],
	"each skipped embedded asset is reported as a structured problem",
);
assert.ok(malformedAssets.problems.every((problem) => typeof problem.message === "string" && problem.message), "every problem carries a message");

// --- v3 compatibility: top-level assets ------------------------------------
const { resources: v3Resources, ...v3Document } = { ...assetDocument, version: 3, assets: assetDocument.resources.assets };
const parsedV3 = readProjectDocument(JSON.stringify(v3Document));
assert.equal(parsedV3.ok, true, "v3 documents with top-level assets remain readable");
assert.deepEqual(parsedV3.project.assets.map((asset) => asset.id).sort(), v3Resources.assets.map((asset) => asset.id).sort(), "v3 top-level assets hydrate as before");
assert.deepEqual(parsedV3.project.motions, [], "v3 documents have no motions");
const v4IgnoresTopLevel = readProjectDocument(JSON.stringify({ ...assetDocument, resources: { assets: [], motions: [] }, assets: assetDocument.resources.assets }));
assert.deepEqual(v4IgnoresTopLevel.project.assets, [], "a v4 document reads images from resources only");

// --- v4 resources manifest: embedded motions (#227) ------------------------
const walkBytes = new Uint8Array(Array.from({ length: 300 }, (_, index) => (index * 37 + 11) & 0xff));
const walkId = "a".repeat(64);
const runId = "b".repeat(64);
const walkMeta = { prompt: "walk forward", sourceUrl: "https://example.test/walk.npz", personScale: 1.02, createdAt: 1700000000000 };
const motionDocument = createProjectDocument({
	scenesDocument,
	motions: [
		{ motionId: walkId, bytes: walkBytes, frames: 30, fps: 24, name: "walk", meta: walkMeta },
		{ motionId: walkId.toUpperCase(), bytes: walkBytes.buffer, frames: 30, fps: 24, name: "walk (duplicate)" },
		{ motionId: runId, encoding: "base64", data: Buffer.from([1, 2, 3, 4, 5]).toString("base64"), bytes: 5, frames: 2, fps: 30 },
		{ motionId: "not-a-hash", bytes: walkBytes },
		{ motionId: "c".repeat(64), encoding: "base64", data: "not base64!" },
		{ motionId: "d".repeat(64), bytes: new Uint8Array(0) },
	],
});
assert.equal(motionDocument.version, PROJECT_VERSION);
assert.equal("assets" in motionDocument, false, "motion-bearing documents keep the v4 layout");
assert.deepEqual(motionDocument.resources.assets, [], "no scene images means no embedded assets");
assert.deepEqual(motionDocument.resources.motions.map((motion) => motion.motionId), [walkId, runId], "motions are deduped by motionId and invalid records are dropped");
const [walkRecord, runRecord] = motionDocument.resources.motions;
assert.equal(walkRecord.encoding, "base64");
assert.equal(walkRecord.bytes, walkBytes.byteLength, "the record carries the raw byte length");
assert.equal(walkRecord.name, "walk", "the first record for a motionId wins");
assert.deepEqual({ frames: walkRecord.frames, fps: walkRecord.fps, meta: walkRecord.meta }, { frames: 30, fps: 24, meta: walkMeta }, "frames/fps/meta are carried verbatim");
assert.deepEqual([...Buffer.from(walkRecord.data, "base64")], [...walkBytes], "raw bytes are stored as base64");
assert.deepEqual({ ...runRecord }, { motionId: runId, encoding: "base64", data: Buffer.from([1, 2, 3, 4, 5]).toString("base64"), bytes: 5, frames: 2, fps: 30 }, "pre-encoded records are stored as given");
const motionRoundTrip = readProjectDocument(JSON.stringify(motionDocument));
assert.equal(motionRoundTrip.ok, true);
assert.deepEqual(motionRoundTrip.warnings, [], "a clean v4 document reads without warnings");
assert.deepEqual(motionRoundTrip.project.motions, motionDocument.resources.motions, "motion records round-trip through the file");
assert.deepEqual([...Buffer.from(motionRoundTrip.project.motions[0].data, "base64")], [...walkBytes], "motion bytes round-trip byte-for-byte");

const badMotions = readProjectDocument(JSON.stringify({
	...motionDocument,
	resources: {
		...motionDocument.resources,
		motions: [
			{ ...walkRecord, motionId: "bad" },
			{ ...walkRecord, data: "not base64!" },
			{ ...walkRecord, data: "QUJD", bytes: 4 },
			{ ...walkRecord, encoding: "gzip" },
			walkRecord,
			walkRecord,
			"junk",
		],
	},
}));
assert.equal(badMotions.ok, true, "malformed embedded motions never reject a project");
assert.deepEqual(badMotions.project.motions.map((motion) => motion.motionId), [walkId], "malformed and repeated motions are skipped");
assert.deepEqual(
	badMotions.problems.map(({ kind, id, code }) => ({ kind, id, code })),
	[
		{ kind: "motion", id: "bad", code: "bad-id" },
		{ kind: "motion", id: walkId, code: "bad-base64" },
		{ kind: "motion", id: walkId, code: "length-mismatch" },
		{ kind: "motion", id: walkId, code: "bad-encoding" },
		{ kind: "motion", id: walkId, code: "duplicate" },
		{ kind: "motion", id: null, code: "bad-id" },
	],
	"each skipped motion is reported with its structural problem",
);
assert.equal(badMotions.warnings.length, badMotions.problems.length, "every problem is also a warning string");
assert.ok(badMotions.warnings.every((warning) => typeof warning === "string" && warning.includes("motion")), "motion warnings are human-readable strings");

// Size budgets: one motion is capped by MOTION_MAX_BYTES, the manifest as a
// whole by PROJECT_MAX_RESOURCE_BYTES. Both checks fire before any base64
// encoding, so the buffers can be allocated without being touched.
assert.ok(MOTION_MAX_BYTES < PROJECT_MAX_RESOURCE_BYTES, "a single motion never exhausts the manifest budget alone");
assert.throws(
	() => createProjectDocument({ scenesDocument, motions: [{ motionId: walkId, bytes: new ArrayBuffer(MOTION_MAX_BYTES + 1) }] }),
	(error) => error instanceof Error && error.code === "resources-too-large" && error.bytes === MOTION_MAX_BYTES + 1 && error.limit === MOTION_MAX_BYTES,
	"a motion over MOTION_MAX_BYTES throws resources-too-large",
);
const halfBudget = Math.ceil(PROJECT_MAX_RESOURCE_BYTES / 2) + 1;
assert.throws(
	() => createProjectDocument({ scenesDocument, motions: [{ motionId: walkId, bytes: new ArrayBuffer(halfBudget) }, { motionId: runId, bytes: new ArrayBuffer(halfBudget) }] }),
	(error) => error instanceof Error && error.code === "resources-too-large" && error.bytes === halfBudget * 2 && error.limit === PROJECT_MAX_RESOURCE_BYTES,
	"motions that together exceed PROJECT_MAX_RESOURCE_BYTES throw resources-too-large",
);
assert.throws(
	() => createProjectDocument({ scenesDocument, motions: [{ motionId: walkId, encoding: "base64", data: "A".repeat(Math.ceil((MOTION_MAX_BYTES + 3) / 3) * 4) }] }),
	(error) => error instanceof Error && error.code === "resources-too-large" && error.limit === MOTION_MAX_BYTES,
	"an oversized pre-encoded motion throws resources-too-large",
);

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
assert.match(appSource, /encodeMotionResource\(/, "project save encodes the loaded NPZ bytes");
assert.match(appSource, /decodeMotionResource\(/, "project open decodes embedded motion resources");
assert.match(appSource, /resolveMotionSource\(/, "motion restore uses the embedded-first resolver");
assert.match(appSource, /internWorkflowOutputs\(/, "project save interns workflow image outputs");
assert.match(appSource, /resolveWorkflowOutputs\(/, "project open restores runtime workflow output URLs");
assert.match(appSource, /resourceManifest\(/, "App computes project resource status");
assert.match(appSource, /<ResourceStatus\b/, "the project menu shows resource status");
assert.match(appSource, /<SaveBlockedDialog\b/, "missing or oversized resources have a save-blocked dialog");
assert.match(appSource, /__cozyclayProject/, "browser QA can exercise the production project export/open path");
assert.match(appSource, /projectDirty/, "unsaved changes surface as a dirty marker");
assert.ok(PROJECT_EXTENSION.length > 1, "project files carry an extension");

console.log("embedded asset round-trip and compatibility checks PASS");
console.log("all project file checks PASS");
