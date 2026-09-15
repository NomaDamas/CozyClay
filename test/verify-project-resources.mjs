#!/usr/bin/env node
// The resource manifest is what tells a user whether a .cclayproject will
// survive a new browser: every picture, clip, pose and workflow output the
// project names, with a status that says where its bytes are. These checks
// pin the classification rules and the lineage walk, and that a broken
// document degrades to fewer items rather than a throw.

import { resourceManifest } from "../src/project-resources.js";
import { createCutoutObject } from "../src/scene-objects.js";
import { createSceneDocument, createSceneStage } from "../src/scenes.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

const hex32 = (seed) => seed.repeat(32).slice(0, 32);
const hex64 = (seed) => seed.repeat(64).slice(0, 64);
const RENDER_ID = `img-${hex32("a")}`;
const SOURCE_ID = `img-${hex32("b")}`;
const MATTE_ID = `img-${hex32("c")}`;
const STORED_ONLY_ID = `img-${hex32("d")}`;
const EMBEDDED_MOTION = hex64("1");
const MISSING_MOTION = hex64("2");
const RECOVERABLE_MOTION = hex64("3");

function asset(id, size) {
	return { id, type: "image/png", width: 4, height: 4, name: `${id}.png`, bytes: new ArrayBuffer(size) };
}

const itemOf = (manifest, kind, id) => manifest.items.find((item) => item.kind === kind && item.id === id);

/* ---------------------------------------------------------- images ---- */

const cutout = createCutoutObject({ assetId: RENDER_ID, sourceAssetId: SOURCE_ID, matteAssetId: MATTE_ID, name: "Hero" });
const storedOnly = createCutoutObject({ assetId: STORED_ONLY_ID, name: "Backdrop" }, [cutout]);
const scenesDocument = createSceneDocument();
const [scene] = scenesDocument.scenes;
scene.objects = [cutout, storedOnly];

const images = resourceManifest({
	scenesDocument,
	assets: [asset(RENDER_ID, 100), asset(SOURCE_ID, 250)],
	storedAssetIds: [STORED_ONLY_ID, RENDER_ID],
});
const render = itemOf(images, "image", RENDER_ID);
const source = itemOf(images, "image", SOURCE_ID);
const matte = itemOf(images, "image", MATTE_ID);
expect("all three lineage ids of a cutout become items", Boolean(render && source && matte), JSON.stringify(images.items.map((item) => item.id)));
expect("the rendered picture is embedded with its size", render?.status === "embedded" && render.bytes === 100, JSON.stringify(render));
expect("the photograph it came from is embedded", source?.status === "embedded" && source.bytes === 250, JSON.stringify(source));
expect("the matte is missing when it is nowhere", matte?.status === "missing" && matte.stored !== true, JSON.stringify(matte));
expect(
	"each lineage field is a ref on the object",
	render?.refs.length === 1 && render.refs[0].sceneId === scene.id && render.refs[0].objectId === cutout.id && render.refs[0].field === "assetId"
		&& source?.refs[0]?.field === "sourceAssetId" && matte?.refs[0]?.field === "matteAssetId",
	JSON.stringify([render?.refs, source?.refs, matte?.refs]),
);
const stored = itemOf(images, "image", STORED_ONLY_ID);
expect("an image the browser still holds is missing but stored", stored?.status === "missing" && stored.stored === true, JSON.stringify(stored));
expect("an embedded image that is also stored is just embedded", render?.status === "embedded" && render.stored === true, JSON.stringify(render));
expect(
	"a fresh cutout names its own picture as its source, once per field",
	stored?.refs.length === 2 && stored.refs.map((ref) => ref.field).join() === "assetId,sourceAssetId",
	JSON.stringify(stored?.refs),
);

const sharedDocument = createSceneDocument();
sharedDocument.scenes[0].objects = [cutout];
sharedDocument.scenes.push({ ...sharedDocument.scenes[0], id: "scene-2", name: "SCENE 02", objects: [{ ...cutout, id: "hero-copy" }] });
const shared = itemOf(resourceManifest({ scenesDocument: sharedDocument, assets: [asset(RENDER_ID, 1)] }), "image", RENDER_ID);
expect("the same picture on two scenes is one item with two refs", shared?.refs.length === 2 && shared.refs[1].sceneId === "scene-2" && shared.refs[1].objectId === "hero-copy", JSON.stringify(shared));

expect(
	"a malformed asset id on an object is not an item",
	resourceManifest({ scenesDocument: { scenes: [{ id: "s", objects: [{ id: "o", assetId: "img-nope", sourceAssetId: 5, matteAssetId: null }] }] } }).items.length === 0,
);
expect(
	"assets given as a Map or an id-keyed object resolve the same",
	itemOf(resourceManifest({ scenesDocument, assets: new Map([[RENDER_ID, asset(RENDER_ID, 7)]]) }), "image", RENDER_ID)?.status === "embedded"
		&& itemOf(resourceManifest({ scenesDocument, assets: { [RENDER_ID]: asset(RENDER_ID, 7) } }), "image", RENDER_ID)?.status === "embedded",
);
expect(
	"base64 bytes from a project file still count",
	itemOf(resourceManifest({ scenesDocument, assets: [{ ...asset(RENDER_ID, 0), bytes: "AAAA" }] }), "image", RENDER_ID)?.bytes === 3,
);

/* --------------------------------------------------------- motions ---- */

const motionStage = createSceneStage({
	characters: [
		{ id: "char-a", motionRef: { url: "https://bridge/take-1.npz", prompt: "walk" } },
		{ id: "char-b", motionRef: { url: "https://bridge/take-2.npz", prompt: "run" } },
		{ id: "char-c", motionRef: { url: "https://bridge/take-3.npz", prompt: "jump" } },
		{ id: "char-d", motionRef: { url: "https://bridge/take-4.npz", prompt: "sit" } },
	],
});
// scenes.js does not carry motionId yet (that is another track); the manifest
// reads the field straight off the character, so set it after normalisation.
motionStage.characters[0].motionRef = { motionId: EMBEDDED_MOTION, prompt: "walk", rotationDeg: 0, anchorX: 0, anchorZ: 0 };
motionStage.characters[2].motionRef = { motionId: MISSING_MOTION, prompt: "jump", rotationDeg: 0, anchorX: 0, anchorZ: 0 };
motionStage.characters[3].motionRef = { motionId: RECOVERABLE_MOTION, url: "https://bridge/take-4.npz", prompt: "sit", rotationDeg: 0, anchorX: 0, anchorZ: 0 };
const motionDocument = createSceneDocument();
motionDocument.scenes[0].stage = motionStage;
const motionRecord = { motionId: EMBEDDED_MOTION, encoding: "base64", data: "AAAA", bytes: 3, frames: 1, fps: 30 };

const motions = resourceManifest({ scenesDocument: motionDocument, motions: [motionRecord] });
const embeddedMotion = itemOf(motions, "motion", EMBEDDED_MOTION);
const externalMotion = itemOf(motions, "motion", "https://bridge/take-2.npz");
const missingMotion = itemOf(motions, "motion", MISSING_MOTION);
const recoverableMotion = itemOf(motions, "motion", RECOVERABLE_MOTION);
expect("a motionId found in motions is embedded", embeddedMotion?.status === "embedded" && embeddedMotion.bytes === 3, JSON.stringify(embeddedMotion));
expect("a url-only motionRef is external and keeps the url", externalMotion?.status === "external" && externalMotion.url === "https://bridge/take-2.npz", JSON.stringify(externalMotion));
expect(
	"a motionId with no record and no url is missing",
	missingMotion?.status === "missing",
	JSON.stringify(missingMotion),
);
expect(
	"a motionId with no record falls back to its url as external",
	recoverableMotion?.status === "external" && recoverableMotion.url === "https://bridge/take-4.npz",
	JSON.stringify(recoverableMotion),
);
expect(
	"motion refs name the scene and the character",
	embeddedMotion?.refs.length === 1 && embeddedMotion.refs[0].sceneId === motionDocument.scenes[0].id && embeddedMotion.refs[0].characterId === "char-a" && embeddedMotion.refs[0].field === "motionRef"
		&& missingMotion?.refs.map((ref) => ref.characterId).join() === "char-c",
	JSON.stringify([embeddedMotion?.refs, missingMotion?.refs]),
);
const upgraded = itemOf(resourceManifest({ scenesDocument: { scenes: [{ id: "s", objects: [], stage: { characters: [
	{ id: "first", motionRef: { motionId: RECOVERABLE_MOTION } },
	{ id: "second", motionRef: { motionId: RECOVERABLE_MOTION, url: "https://bridge/take-4.npz" } },
] } }] } }), "motion", RECOVERABLE_MOTION);
expect(
	"a later sighting that carries a url upgrades the item, so order does not decide status",
	upgraded?.status === "external" && upgraded.url === "https://bridge/take-4.npz" && upgraded.refs.map((ref) => ref.characterId).join() === "first,second",
	JSON.stringify(upgraded),
);
expect(
	"motions given as a Map keyed by motionId resolve too",
	itemOf(resourceManifest({ scenesDocument: motionDocument, motions: new Map([[EMBEDDED_MOTION, motionRecord]]) }), "motion", EMBEDDED_MOTION)?.status === "embedded",
);
expect(
	"a character without a motionRef contributes nothing",
	resourceManifest({ scenesDocument: { scenes: [{ id: "s", objects: [], stage: { characters: [{ id: "a", motionRef: null }, { id: "b", motionRef: {} }, { id: "c" }] } }] } }).items.length === 0,
);

/* ----------------------------------------------------------- poses ---- */

const wave = { id: "custom_1", label: "Wave", prompt: "waving", bones: { lArm: [1, 0, 0], lForeArm: [0, 0.5, 0] }, custom: true };
const crouch = { id: "photo_1", label: "Crouch", prompt: "crouching", bones: { hips: [0.2, 0, 0] }, custom: true };
const poseStage = createSceneStage({
	characters: [
		{ id: "char-a", pose: { id: "custom_1", label: "Wave", bones: { lArm: [1, 0, 0], lForeArm: [0, 0.5, 0] } } },
		{ id: "char-b", pose: { id: "default", bones: { lArm: [1.5632, 0.1164, -0.2889] } } },
		{ id: "char-c", pose: { id: "custom_1", bones: { lForeArm: [0, 0.5, 0], lArm: [1, 0, 0] } } },
		{ id: "char-d", pose: null },
	],
});
const poseDocument = createSceneDocument();
poseDocument.scenes[0].stage = poseStage;
const poses = resourceManifest({ scenesDocument: poseDocument, poseLibrary: [wave, crouch, { id: "broken" }, null, { id: "custom_1", bones: {} }] });
const waveItem = itemOf(poses, "pose", "custom_1");
const crouchItem = itemOf(poses, "pose", "photo_1");
expect("every library pose is an embedded item", waveItem?.status === "embedded" && crouchItem?.status === "embedded", JSON.stringify(poses.items));
expect("a library entry without bones is not a pose", !itemOf(poses, "pose", "broken") && poses.items.filter((item) => item.kind === "pose").length === 2);
expect(
	"a character whose bones deep-equal a library pose is a ref, key order aside",
	waveItem?.refs.length === 2 && waveItem.refs.map((ref) => ref.characterId).join() === "char-a,char-c" && waveItem.refs.every((ref) => ref.field === "pose" && ref.sceneId === poseDocument.scenes[0].id),
	JSON.stringify(waveItem?.refs),
);
expect("a character in a pose the library does not hold is not a ref", crouchItem?.refs.length === 0 && poses.items.every((item) => item.kind !== "pose" || item.refs.every((ref) => ref.characterId !== "char-b")));
expect("a pose sharing an id but not bones is not matched", resourceManifest({ scenesDocument: poseDocument, poseLibrary: [{ ...wave, bones: { lArm: [9, 9, 9] } }] }).items[0].refs.length === 0);

/* ------------------------------------------------- workflow outputs ---- */

const workflow = { version: 1, nodes: [{ id: "n1" }], edges: [] };
let receivedGraph = null;
const workflowOutputRefs = (graph) => {
	receivedGraph = graph;
	return [
		{ nodeId: "n1", field: "data.resultUrl", value: "data:image/png;base64,AAAA", kind: "data-url" },
		{ nodeId: "n1", field: "data.videoUrl", value: "https://cdn/out.mp4", kind: "http" },
		{ nodeId: "n2", field: "data.lastOutput.renderUrl", value: { assetRef: RENDER_ID }, kind: "asset-ref" },
		{ nodeId: "n2", field: "data.fileUrl", value: "blob:https://app/abc", kind: "blob" },
		{ nodeId: "n3", field: "data.outputs[0].value", value: { assetRef: "img-nope" }, kind: "asset-ref" },
		{ nodeId: "", field: "data.resultUrl", value: "data:image/png;base64,AAAA", kind: "data-url" },
		null,
	];
};
const outputs = resourceManifest({ scenesDocument, workflow, assets: [asset(RENDER_ID, 5)], workflowOutputRefs });
const outputItems = outputs.items.filter((item) => item.kind === "workflow-output");
const byId = Object.fromEntries(outputItems.map((item) => [item.id, item]));
expect("the injected walker receives the workflow graph", receivedGraph === workflow);
expect("a data: URL output is embedded with its decoded size", byId["n1:data.resultUrl"]?.status === "embedded" && byId["n1:data.resultUrl"].bytes === 3, JSON.stringify(byId["n1:data.resultUrl"]));
expect("an http output is external with its url", byId["n1:data.videoUrl"]?.status === "external" && byId["n1:data.videoUrl"].url === "https://cdn/out.mp4", JSON.stringify(byId["n1:data.videoUrl"]));
expect("an interned output follows its image", byId["n2:data.lastOutput.renderUrl"]?.status === "embedded" && !("bytes" in byId["n2:data.lastOutput.renderUrl"]), JSON.stringify(byId["n2:data.lastOutput.renderUrl"]));
expect(
	"the interned output's node is a ref on the image item",
	itemOf(outputs, "image", RENDER_ID)?.refs.some((ref) => ref.nodeId === "n2" && ref.field === "data.lastOutput.renderUrl"),
	JSON.stringify(itemOf(outputs, "image", RENDER_ID)?.refs),
);
expect("a blob: URL is missing (it died with its page)", byId["n2:data.fileUrl"]?.status === "missing" && byId["n2:data.fileUrl"].url === "blob:https://app/abc", JSON.stringify(byId["n2:data.fileUrl"]));
expect("an asset-ref to an unknown id is missing", byId["n3:data.outputs[0].value"]?.status === "missing", JSON.stringify(byId["n3:data.outputs[0].value"]));
expect("refs without a node or that are not objects are skipped", outputItems.length === 5, JSON.stringify(Object.keys(byId)));
expect("each output ref names its node and field", outputItems.every((item) => item.refs.length === 1 && item.refs[0].nodeId && item.refs[0].field));
expect("without a walker the workflow contributes nothing", resourceManifest({ scenesDocument, workflow }).items.every((item) => item.kind !== "workflow-output"));
expect("a walker returning garbage contributes nothing", resourceManifest({ scenesDocument, workflow, workflowOutputRefs: () => "nope" }).items.every((item) => item.kind !== "workflow-output"));

/* ---------------------------------------------------------- totals ---- */

const everything = resourceManifest({
	scenesDocument: { version: 4, activeSceneId: "s1", scenes: [{ ...scene, stage: { ...motionStage, characters: [...motionStage.characters, ...poseStage.characters] } }] },
	workflow,
	poseLibrary: [wave, crouch],
	assets: [asset(RENDER_ID, 100), asset(SOURCE_ID, 250)],
	motions: [motionRecord],
	storedAssetIds: [STORED_ONLY_ID],
	workflowOutputRefs,
});
const counted = everything.items.reduce((sum, item) => {
	sum[item.status] += 1;
	return sum;
}, { embedded: 0, external: 0, missing: 0 });
expect(
	"totals count every item exactly once by status",
	everything.totals.embedded === counted.embedded && everything.totals.external === counted.external && everything.totals.missing === counted.missing
		&& everything.totals.embedded + everything.totals.external + everything.totals.missing === everything.items.length,
	JSON.stringify([everything.totals, counted]),
);
expect(
	"the expected split: 2 images + 1 motion + 2 poses + 2 outputs embedded, 2 motions + 1 output external, 2 images + 1 motion + 2 outputs missing",
	everything.totals.embedded === 7 && everything.totals.external === 3 && everything.totals.missing === 5,
	JSON.stringify(everything.totals),
);
expect("bytes sum the embedded payloads", everything.totals.bytes === 100 + 250 + 3 + 3, String(everything.totals.bytes));
expect(
	"missing is the items whose status is missing, in item order",
	everything.missing.length === 5 && everything.missing.every((item) => item.status === "missing")
		&& everything.missing.map((item) => item.id).join() === `${MATTE_ID},${STORED_ONLY_ID},${MISSING_MOTION},n2:data.fileUrl,n3:data.outputs[0].value`,
	JSON.stringify(everything.missing.map((item) => item.id)),
);
expect(
	"items are grouped image, motion, pose, workflow-output",
	everything.items.map((item) => item.kind).join() === "image,image,image,image,motion,motion,motion,motion,pose,pose,workflow-output,workflow-output,workflow-output,workflow-output,workflow-output",
	everything.items.map((item) => item.kind).join(),
);
expect("every item has a unique (kind, id)", new Set(everything.items.map((item) => `${item.kind}\u0000${item.id}`)).size === everything.items.length);

/* -------------------------------------------------- hostile input ---- */

const empty = { items: [], totals: { embedded: 0, external: 0, missing: 0, bytes: 0 }, missing: [] };
const hostile = [
	undefined,
	null,
	"scenes",
	42,
	[],
	{},
	{ scenesDocument: null, workflow: null, poseLibrary: null, assets: null, motions: null, storedAssetIds: null },
	{ scenesDocument: "x", workflow: 1, poseLibrary: "poses", assets: "assets", motions: 7, storedAssetIds: "img-1" },
	{ scenesDocument: { scenes: "nope" }, poseLibrary: {}, assets: {}, motions: {}, storedAssetIds: {} },
	{ scenesDocument: { scenes: [null, 1, "s", [], { id: 3, objects: null, stage: null }, { objects: [null, 1, "o", []], stage: { characters: [null, 1, "c", [], { pose: "x", motionRef: "y" }, { pose: { bones: "b" } }] } }] } },
	{ scenesDocument, assets: [null, 1, "a", [], { id: RENDER_ID, bytes: NaN }, { bytes: new ArrayBuffer(2) }], motions: [null, { motionId: 5 }, { data: 1 }], poseLibrary: [1, "p", [], { id: 1, bones: {} }, { id: "x", bones: [] }] },
	{ scenesDocument, workflowOutputRefs: "not a function" },
	{ scenesDocument, workflowOutputRefs: () => null },
	{ scenesDocument, workflowOutputRefs: () => [{ nodeId: "n", field: "f", kind: "data-url", value: 5 }, { nodeId: "n", field: "g", kind: "http", value: {} }, { nodeId: "n", field: "h", kind: "asset-ref", value: null }, { nodeId: "n", field: "i", kind: "weird" }] },
];
for (const [index, input] of hostile.entries()) {
	let result = null;
	let error = null;
	try {
		result = resourceManifest(input);
	} catch (caught) {
		error = caught;
	}
	const shaped = result && Array.isArray(result.items) && Array.isArray(result.missing) && result.totals
		&& ["embedded", "external", "missing", "bytes"].every((key) => Number.isInteger(result.totals[key]) && result.totals[key] >= 0)
		&& result.items.every((item) => ["image", "motion", "pose", "workflow-output"].includes(item.kind) && typeof item.id === "string" && ["embedded", "external", "missing"].includes(item.status) && Array.isArray(item.refs));
	expect(`hostile input #${index} yields a well-formed manifest`, !error && shaped, error ? String(error.stack ?? error) : JSON.stringify(result));
}
expect("nothing at all is an empty manifest", JSON.stringify(resourceManifest()) === JSON.stringify(empty), JSON.stringify(resourceManifest()));
expect(
	"the manifest never mutates its inputs",
	(() => {
		const before = JSON.stringify([scenesDocument, [wave, crouch]]);
		resourceManifest({ scenesDocument, poseLibrary: [wave, crouch], assets: [asset(RENDER_ID, 1)], storedAssetIds: [STORED_ONLY_ID] });
		return JSON.stringify([scenesDocument, [wave, crouch]]) === before;
	})(),
);

if (failures) process.exit(1);
console.log("all project resource checks PASS");
