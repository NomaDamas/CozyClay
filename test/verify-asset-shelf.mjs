#!/usr/bin/env node
// The Assets shelf must show what the user IMPORTED and hide what the matte
// pipeline DERIVED. This suite pins that split as pure data-in/data-out.
import { assetKind, derivedAssetIds, formatAssetBytes, sourceAssetIds } from "../src/asset-shelf.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

const hex = (seed) => seed.repeat(32).slice(0, 32);
const SOURCE = `img-${hex("a")}`; // photograph a matted cutout came from
const RENDERED = `img-${hex("b")}`; // the cut picture that cutout renders
const MATTE = `img-${hex("c")}`; // the purple selection mask
const PLAIN = `img-${hex("d")}`; // an unmatted cutout's own picture
const ORPHAN = `img-${hex("e")}`; // stored, referenced by no scene

// Manage-mode metadata stays pure so its display contract is node-tested.
expect("asset bytes use readable binary units", formatAssetBytes(1536) === "1.5 KB");
expect("asset bytes keep small values exact", formatAssetBytes(512) === "512 B");
expect("matte records expose their derivable kind", assetKind({ name: "sofa matte" }) === "matte");
expect("ordinary records expose image kind", assetKind({ name: "sofa.png" }) === "image");

const scenes = [
	{
		id: "scene-1",
		objects: [
			// A matted cutout: renders RENDERED, came from SOURCE, mask MATTE.
			{ id: "cutout", renderer: "cutout", assetId: RENDERED, sourceAssetId: SOURCE, matteAssetId: MATTE },
			// An untouched cutout: its picture is its own original.
			{ id: "cutout-2", renderer: "cutout", assetId: PLAIN, sourceAssetId: PLAIN, matteAssetId: "" },
			// A non-cutout object never contributes ids.
			{ id: "cube", renderer: "cube" },
		],
	},
];

const stored = [SOURCE, RENDERED, MATTE, PLAIN, ORPHAN];
const shown = sourceAssetIds(stored, scenes);

expect("a matted cutout's photograph is a source", shown.includes(SOURCE));
expect("its rendered (cut) picture is derived and hidden", !shown.includes(RENDERED), shown.join(", "));
expect("its matte mask is derived and hidden", !shown.includes(MATTE), shown.join(", "));
expect("an unmatted cutout's picture is a source", shown.includes(PLAIN));
expect("a stored but unreferenced picture still shows", shown.includes(ORPHAN));
expect("stored order is kept", JSON.stringify(shown) === JSON.stringify([SOURCE, PLAIN, ORPHAN]), shown.join(", "));

// The same id can be one cutout's rendered picture AND another's original —
// duplicating a card before matting does exactly this. Source status wins.
const reused = sourceAssetIds([RENDERED, SOURCE], [
	{
		objects: [
			{ renderer: "cutout", assetId: RENDERED, sourceAssetId: SOURCE, matteAssetId: MATTE },
			{ renderer: "cutout", assetId: RENDERED, sourceAssetId: RENDERED, matteAssetId: "" },
		],
	},
]);
expect("an id that is anyone's source stays visible", reused.includes(RENDERED));

// A deleted cutout leaves its pipeline outputs in storage. Persisted derived
// metadata keeps those orphaned internals out of the placeable shelf.
const orphanedDerived = sourceAssetIds([SOURCE, RENDERED, MATTE], [], new Set([RENDERED, MATTE]));
expect("orphaned rendered and matte assets stay hidden", JSON.stringify(orphanedDerived) === JSON.stringify([SOURCE]), orphanedDerived.join(", "));

// The scan backfills pre-role stores: while a matted cutout still lives, its
// pipeline outputs are identifiable from lineage alone, so the store can be
// stamped before the cutout (and the knowledge) goes away.
const backfill = derivedAssetIds(scenes);
expect(
	"scene lineage names both pipeline outputs for backfill",
	backfill.has(RENDERED) && backfill.has(MATTE) && backfill.size === 2,
	[...backfill].join(", "),
);
expect("an id that is also a source is never backfilled as derived", !derivedAssetIds([
	{ objects: [
		{ renderer: "cutout", assetId: RENDERED, sourceAssetId: SOURCE, matteAssetId: "" },
		{ renderer: "cutout", assetId: RENDERED, sourceAssetId: RENDERED, matteAssetId: "" },
	] },
]).has(RENDERED));
expect("hostile scenes yield an empty backfill set", derivedAssetIds(null).size === 0);

// A legacy record without sourceAssetId is its own original.
const legacy = sourceAssetIds([PLAIN], [{ objects: [{ renderer: "cutout", assetId: PLAIN }] }]);
expect("a cutout without lineage fields counts as unmatted", legacy.includes(PLAIN));

// A mesh prop's GLB is something the user imported, never a matte-pipeline
// output. classifyLineage used to skip everything but cutouts, which would
// hide a mesh only if it were mistakenly marked derived.
const MESH = `mesh-${hex("f")}`;
const meshScenes = [
	{
		id: "scene-1",
		objects: [
			{ id: "cooker", renderer: "mesh", assetId: MESH },
			{ id: "cutout", renderer: "cutout", assetId: RENDERED, sourceAssetId: SOURCE, matteAssetId: MATTE },
		],
	},
];
const meshShown = sourceAssetIds([MESH, SOURCE, RENDERED, MATTE], meshScenes);
expect("a mesh object's assetId is a source, shown on the shelf", meshShown.includes(MESH), meshShown.join(", "));
expect("a mesh id is never derived from cutout lineage", !derivedAssetIds(meshScenes).has(MESH));
expect("cutout mattes stay hidden next to a mesh", !meshShown.includes(MATTE) && !meshShown.includes(RENDERED), meshShown.join(", "));
expect("mesh records expose their kind", assetKind({ id: MESH, type: "model/gltf-binary", name: "stove.glb" }) === "mesh");
expect("OBJ mesh records expose their kind too", assetKind({ id: MESH, type: "model/obj", name: "stove.obj" }) === "mesh");
expect("FBX mesh records expose their kind too", assetKind({ id: MESH, type: "model/fbx", name: "stove.fbx" }) === "mesh");
expect("a type-only OBJ record without a mesh- prefix is still a mesh", assetKind({ type: "model/obj", name: "stove.obj" }) === "mesh");
expect("a type-only FBX record without a mesh- prefix is still a mesh", assetKind({ type: "model/fbx", name: "stove.fbx" }) === "mesh");
expect("ordinary records still expose image kind", assetKind({ name: "sofa.png" }) === "image");
expect("matte records still expose their derivable kind next to meshes", assetKind({ name: "sofa matte" }) === "matte");

// Garbage in, calm out: the selector never throws on hostile shapes.
expect(
	"nonsense scenes and ids are tolerated",
	JSON.stringify(sourceAssetIds(["not-an-id", null, SOURCE], [null, {}, { objects: "x" }])) === JSON.stringify([SOURCE]),
);
expect("no stored ids means an empty shelf", sourceAssetIds([], scenes).length === 0 && sourceAssetIds(null, scenes).length === 0);

if (failures) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nverify-asset-shelf: all green");
