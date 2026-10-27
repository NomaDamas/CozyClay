#!/usr/bin/env node
// verify-sculpt-blueprint (#739): the model-sheet request is subject-agnostic,
// lays four orthographic views out on a fixed 2 x 2 grid, and goes to the
// sidecar as a "sheet" so nothing is added to the prompt.
import assert from "node:assert/strict";
import { BLUEPRINT_LAYOUT, BLUEPRINT_SIZE, BLUEPRINT_VIEW_YAWS, blueprintErrorMessage, blueprintRequest, blueprintRunViews, blueprintViewImages, buildBlueprintPrompt, cropBlueprintPanel, cropBlueprintViews } from "../src/sculpt-blueprint.js";

let failures = 0;
async function check(name, fn) {
	try { await fn(); console.log(`PASS ${name}`); }
	catch (error) { failures += 1; console.log(`FAIL ${name}\n${error.stack}`); }
}

await check("the layout is four equal quarters that tile the sheet, FRONT beside SIDE on the top row", () => {
	assert.deepEqual(BLUEPRINT_LAYOUT.map((panel) => panel.view), ["front", "side", "back", "top"]);
	const area = BLUEPRINT_LAYOUT.reduce((sum, panel) => sum + panel.width * panel.height, 0);
	assert.equal(area, 1);
	const front = BLUEPRINT_LAYOUT[0], side = BLUEPRINT_LAYOUT[1];
	assert.equal(front.y, side.y, "front and side share a row, so their head and foot lines are the same pixels");
	assert.equal(front.height, side.height);
	for (const a of BLUEPRINT_LAYOUT) for (const b of BLUEPRINT_LAYOUT) {
		if (a === b) continue;
		const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
		assert.ok(apart, `${a.view} and ${b.view} do not overlap`);
	}
	assert.equal(BLUEPRINT_SIZE, "1536x1024");
});

await check("the prompt names the views, orthographic projection, one scale, shared lines and a white background", () => {
	const prompt = buildBlueprintPrompt();
	for (const phrase of ["2 x 2 grid", "Top-left: FRONT view", "Top-right: LEFT SIDE view", "subject faces image left", "Bottom-left: BACK view", "Bottom-right: TOP view", "true orthographic", "One scale for all four panels", "same horizontal line", "pure white (#FFFFFF)", "Do not write any text", "exactly the pose in the reference", "motion lines", "not part of the subject itself"]) {
		assert.ok(prompt.toLowerCase().includes(phrase.toLowerCase()), `prompt says "${phrase}"`);
	}
});

await check("the template names no subject: everything specific comes from the reference and the notes", () => {
	const prompt = buildBlueprintPrompt();
	for (const word of ["snorlax", "turtle", "character", "pokemon", "animal", "person", "robot"]) assert.ok(!prompt.toLowerCase().includes(word), `no "${word}"`);
	assert.ok(prompt.includes("main subject in the attached reference image"));
});

await check("neutral pose swaps only the pose rule", () => {
	const keep = buildBlueprintPrompt({ pose: "keep" }).split("\n");
	const neutral = buildBlueprintPrompt({ pose: "neutral" }).split("\n");
	assert.equal(keep.length, neutral.length);
	const changed = keep.filter((line, index) => line !== neutral[index]);
	assert.equal(changed.length, 1);
	assert.match(neutral.find((line) => line.startsWith("Pose:")), /neutral rest pose/);
	assert.throws(() => buildBlueprintPrompt({ pose: "dance" }), /pose must be one of keep, neutral/);
});

await check("operator notes are appended as written, trimmed, single-line and capped", () => {
	assert.ok(!buildBlueprintPrompt({ notes: "   " }).includes("Notes from the operator"));
	const prompt = buildBlueprintPrompt({ notes: "  a ceramic teapot,\n  spout on its left  " });
	assert.ok(prompt.endsWith("Notes from the operator: a ceramic teapot, spout on its left"));
	assert.ok(buildBlueprintPrompt({ notes: "x".repeat(2000) }).length < buildBlueprintPrompt().length + 700);
});

await check("the request sends the reference as the edited image, as a high-quality landscape sheet", () => {
	const request = blueprintRequest({ reference: { dataUrl: "data:image/png;base64,AA==", name: "ref.png" }, pose: "neutral", notes: "teapot" });
	assert.equal(request.imageDataUrl, "data:image/png;base64,AA==");
	assert.equal(request.composition, "sheet");
	assert.equal(request.quality, "high");
	assert.equal(request.size, "1536x1024");
	assert.equal(request.prompt, buildBlueprintPrompt({ pose: "neutral", notes: "teapot" }));
	assert.throws(() => blueprintRequest({ reference: null }), /needs a reference image/);
});

await check("a safety refusal says what usually causes it and what to try; anything else keeps its message", () => {
	const refusal = blueprintErrorMessage(new Error("400 — Your request was rejected by the safety system. If you believe this is an error…"), "fallback");
	assert.match(refusal, /refused this reference/);
	assert.match(refusal, /original design/);
	assert.equal(blueprintErrorMessage(new Error("upstream timeout"), "upstream timeout"), "upstream timeout");
});

/* ------------------------------------------------ crop per view (#970) --- */
// A synthetic 1536 x 1024 sheet on white: each quarter holds one coloured rectangle,
// placed by fractions of its panel, so every crop and box is derivable by hand.
const PANEL_COLOURS = { front: [200, 40, 40], side: [40, 160, 60], back: [40, 60, 200], top: [160, 120, 30] };
function sheetImage({ width = 1536, height = 1024, subjects = {} } = {}) {
	const data = new Uint8Array(width * height * 4).fill(255);
	for (const panel of BLUEPRINT_LAYOUT) {
		const box = subjects[panel.view] === undefined ? { x0: 0.3, x1: 0.7, y0: 0.2, y1: 0.8 } : subjects[panel.view];
		if (!box) continue;
		const px0 = panel.x * width, py0 = panel.y * height, pw = panel.width * width, ph = panel.height * height;
		for (let y = Math.round(py0 + box.y0 * ph); y < Math.round(py0 + box.y1 * ph); y += 1) for (let x = Math.round(px0 + box.x0 * pw); x < Math.round(px0 + box.x1 * pw); x += 1) data.set([...PANEL_COLOURS[panel.view], 255], (y * width + x) * 4);
	}
	return { width, height, data };
}
const pixel = (image, x, y) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];

await check("the sheet is cut into front, side, back and top by BLUEPRINT_LAYOUT, each panel exactly its quarter", () => {
	const sheet = sheetImage();
	const { views, notices } = cropBlueprintViews(sheet);
	assert.deepEqual(notices, []);
	assert.deepEqual(views.map((view) => view.view), ["front", "side", "back", "top"]);
	for (const view of views) {
		assert.deepEqual([view.image.width, view.image.height], [768, 512], view.view);
		// The panel's centre pixel is its own subject's colour: the crop came from the right quarter.
		assert.deepEqual(pixel(view.image, 384, 256), PANEL_COLOURS[view.view], view.view);
		assert.deepEqual(pixel(view.image, 0, 0), [255, 255, 255]);
		// The per-view mask finds the subject where it was drawn (fractions of the panel; the mask runs at 256 px).
		assert.equal(view.mask.source, "border-colour");
		for (const [key, want] of [["x", 0.3], ["y", 0.2], ["width", 0.4], ["height", 0.6]]) assert.ok(Math.abs(view.mask.box[key] - want) < 0.01, `${view.view} ${key} ${view.mask.box[key]}`);
	}
	assert.deepEqual(views.map((view) => view.yaw), [0, 90, 180, null], "front 0, side on the subject's own left 90, back 180; top is not compared");
	assert.deepEqual(BLUEPRINT_VIEW_YAWS, { front: 0, side: 90, back: 180 });
	// The side panel starts at x 768: its first column is the sheet's column 768.
	const side = cropBlueprintPanel(sheet, BLUEPRINT_LAYOUT[1]);
	assert.deepEqual(pixel(side, 300, 200), pixel(sheet, 768 + 300, 200));
	// An odd-sized sheet still tiles with no pixel lost or doubled.
	const odd = sheetImage({ width: 1537, height: 1023 });
	const cut = BLUEPRINT_LAYOUT.map((panel) => cropBlueprintPanel(odd, panel));
	assert.equal(cut[0].width + cut[1].width, 1537);
	assert.equal(cut[0].height + cut[2].height, 1023);
});

await check("a view whose mask fails is dropped with a notice; the others are kept", () => {
	const { views, notices } = cropBlueprintViews(sheetImage({ subjects: { back: null, top: { x0: 0, x1: 0.6, y0: 0.2, y1: 0.8 } } }));
	assert.deepEqual(views.map((view) => view.view), ["front", "side"]);
	assert.equal(notices.length, 2);
	assert.match(notices[0], /^Back view dropped: No subject found in the reference/);
	assert.match(notices[1], /^Top view dropped: the subject touches the panel edge\.$/);
	const full = cropBlueprintViews(sheetImage({ subjects: { side: { x0: 0, x1: 1, y0: 0, y1: 1 } } }));
	assert.match(full.notices[0], /^Left side view dropped: /, "a panel with no background is dropped too");
});

await check("Start takes the sheet's side and back views as PNG data URLs; front and top stay out", async () => {
	const sheet = sheetImage();
	const port = { decode: async (reference) => { assert.equal(reference.dataUrl, "data:image/png;base64,SHEET"); return sheet; }, encodePng: async (image) => `data:image/png;base64,${image.width}x${image.height}` };
	const cut = await blueprintViewImages("data:image/png;base64,SHEET", port);
	assert.deepEqual(cut.views.map((view) => [view.view, view.yaw, view.dataUrl]), [["front", 0, "data:image/png;base64,768x512"], ["side", 90, "data:image/png;base64,768x512"], ["back", 180, "data:image/png;base64,768x512"], ["top", null, "data:image/png;base64,768x512"]]);
	assert.deepEqual(blueprintRunViews({ views: cut.views }), [
		{ view: "side", yaw: 90, dataUrl: "data:image/png;base64,768x512", name: "blueprint-side.png" },
		{ view: "back", yaw: 180, dataUrl: "data:image/png;base64,768x512", name: "blueprint-back.png" },
	]);
	assert.deepEqual(blueprintRunViews({ views: cut.views.filter((view) => view.view !== "back") }).map((view) => view.view), ["side"], "a dropped back view is simply absent");
	assert.deepEqual(blueprintRunViews(null), [], "no sheet, no views");
});

if (failures) {
	console.log(`${failures} check(s) failed`);
	process.exit(1);
}
console.log("verify-sculpt-blueprint: all checks passed");
