#!/usr/bin/env node
// Sculpt comparison (#730): the reference becomes a mask, the recipe a fitted
// silhouette, and the score measures shape rather than framing. Synthetic
// references keep every expected number derivable by hand.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeSculptRecipe } from "../src/sculpt-recipe.js";
import { bestViewForReference, compareSculptToReference, measureReferenceOutline, referenceMask, sculptViewPolygons } from "../src/sculpt-compare.js";
import { VIEW_RATIO_TOLERANCE, VIEW_WEIGHTS, scoreSculptAgainstViews, viewOfYaw, viewWeights } from "../src/sculpt-views.js";

let failures = 0;
async function check(name, fn) {
	try {
		await fn();
		console.log(`PASS ${name}`);
	} catch (error) {
		failures += 1;
		console.log(`FAIL ${name} - ${error.stack?.split("\n").slice(0, 3).join(" | ") ?? error.message}`);
	}
}
const recipe = (parts) => {
	const result = normalizeSculptRecipe({ parts });
	assert.equal(result.ok, true, result.error);
	return result.recipe;
};
/** A flat-backdrop image with a filled rectangle (fx, fy as fractions). */
function rectImage({ width = 200, height = 200, x0, x1, y0, y1, bg = [154, 220, 254], fg = [60, 120, 140], alpha = false } = {}) {
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
		const inside = x >= x0 * width && x < x1 * width && y >= y0 * height && y < y1 * height;
		const c = inside ? fg : bg, i = (y * width + x) * 4;
		data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = alpha && !inside ? 0 : 255;
	}
	return { width, height, data };
}
const box = (w, h, d) => recipe([{ id: "b", shape: "box", size: [w, h, d], roundness: 0, position: [0, h / 2, 0] }]);

await check("a flat backdrop and a transparent background both give the subject's mask", () => {
	const flat = referenceMask(rectImage({ x0: 0.3, x1: 0.7, y0: 0.2, y1: 0.9 }));
	assert.equal(flat.source, "border-colour");
	const cut = referenceMask(rectImage({ x0: 0.3, x1: 0.7, y0: 0.2, y1: 0.9, alpha: true }));
	assert.equal(cut.source, "alpha");
	const area = (m) => m.mask.reduce((s, v) => s + v, 0) / m.mask.length;
	assert.ok(Math.abs(area(flat) - 0.28) < 0.01 && Math.abs(area(cut) - 0.28) < 0.01, `${area(flat)} ${area(cut)}`);
});

await check("a reference with no subject is refused with the reason", () => {
	assert.throws(() => referenceMask(rectImage({ x0: 0, x1: 0, y0: 0, y1: 0 })), /No subject found/);
});

await check("a box sculpt of the reference's proportions scores ~1 wherever it is framed", () => {
	for (const frame of [{ x0: 0.3, x1: 0.7, y0: 0.1, y1: 0.9 }, { x0: 0.05, x1: 0.25, y0: 0.5, y1: 0.9 }]) {
		const aspect = (frame.x1 - frame.x0) / (frame.y1 - frame.y0);
		const { report } = compareSculptToReference(box(aspect, 1, 0.2), rectImage(frame));
		assert.ok(report.iou > 0.95, JSON.stringify(report));
		assert.ok(Math.abs(report.widthToHeight.delta) < 0.03);
	}
});

await check("a sculpt too wide reports extra on the part that sticks out, and a too-narrow one reports missing", () => {
	const ref = rectImage({ x0: 0.35, x1: 0.65, y0: 0.1, y1: 0.9 });
	const wide = compareSculptToReference(recipe([
		{ id: "body", shape: "box", size: [0.375, 1, 0.2], roundness: 0, position: [0, 0.5, 0] },
		{ id: "arm", shape: "box", size: [0.3, 0.2, 0.2], roundness: 0, position: [0.3, 0.6, 0] },
	]), ref).report;
	assert.equal(wide.extraByPart[0].id, "arm");
	assert.ok(wide.widthToHeight.delta > 0.2);
	const narrow = compareSculptToReference(box(0.2, 1, 0.2), ref).report;
	assert.ok(narrow.missingFraction > 0.4 && narrow.extraFraction < 0.02, JSON.stringify(narrow));
});

await check("missing pixels are reported by height band, so the agent knows where to add", () => {
	const ref = rectImage({ x0: 0.3, x1: 0.7, y0: 0.1, y1: 0.9 });
	const pear = recipe([
		{ id: "base", shape: "box", size: [0.5, 0.33, 0.2], roundness: 0, position: [0, 0.165, 0] },
		{ id: "top", shape: "box", size: [0.25, 0.67, 0.2], roundness: 0, position: [0, 0.665, 0] },
	]);
	const { missingByBand } = compareSculptToReference(pear, ref).report;
	// The narrow part spans the top two thirds; the wide base fills the bottom third.
	assert.ok(missingByBand.top > 0.05 && missingByBand.middle > 0.05 && missingByBand.bottom < 0.01, JSON.stringify(missingByBand));
});

await check("yaw moves the camera round to the subject's own left (+x)", () => {
	const r = recipe([{ id: "nose", shape: "box", size: [0.1, 0.1, 0.1], roundness: 0, position: [0, 0.5, 1] }]);
	const [front] = sculptViewPolygons(r, { yaw: 0 });
	const [left] = sculptViewPolygons(r, { yaw: 90 });
	const cx = (p) => p.polygon.reduce((s, [x]) => s + x, 0) / p.polygon.length;
	assert.ok(Math.abs(cx(front)) < 1e-6);
	assert.ok(cx(left) < -0.9, `from the subject's left the nose points to screen left (${cx(left)})`);
});

await check("a frame keeps its opening in the silhouette", () => {
	const ref = rectImage({ x0: 0.2, x1: 0.8, y0: 0.3, y1: 0.7 });
	const solid = compareSculptToReference(recipe([{ id: "f", shape: "box", size: [0.6, 0.4, 0.05], roundness: 0, position: [0, 0.2, 0] }]), ref).report;
	const ring = compareSculptToReference(recipe([{ id: "f", shape: "frame", size: [0.6, 0.4, 0.05], border: 0.05, position: [0, 0.2, 0] }]), ref).report;
	assert.ok(ring.missingFraction > solid.missingFraction + 0.3, `${ring.missingFraction} vs ${solid.missingFraction}`);
});

await check("the turtle against its own reference: best view is the 3/4 left, IoU above 0.8", () => {
	const turtle = normalizeSculptRecipe(JSON.parse(readFileSync(new URL("./fixtures/sculpt-nerd-turtle.json", import.meta.url), "utf8"))).recipe;
	const ref = JSON.parse(readFileSync(new URL("./fixtures/sculpt-turtle-mask.json", import.meta.url), "utf8"));
	const data = new Uint8Array(ref.width * ref.height * 4).fill(255);
	for (const [start, length] of ref.runs) for (let i = start; i < start + length; i += 1) data.set([60, 120, 140, 255], i * 4);
	const best = bestViewForReference(turtle, { width: ref.width, height: ref.height, data });
	assert.equal(best.report.view.yaw, 30);
	assert.ok(best.report.iou > 0.8, JSON.stringify(best.report));
	assert.equal(best.sheet.width, best.sheet.height * 2);
});

await check("the measured Snorlax draft keeps scoring above 0.9 from the front", () => {
	const snorlax = normalizeSculptRecipe(JSON.parse(readFileSync(new URL("./fixtures/sculpt-snorlax.json", import.meta.url), "utf8")));
	assert.equal(snorlax.ok, true, snorlax.error);
	const ref = JSON.parse(readFileSync(new URL("./fixtures/sculpt-snorlax-mask.json", import.meta.url), "utf8"));
	const data = new Uint8Array(ref.width * ref.height * 4).fill(255);
	for (const [start, length] of ref.runs) for (let i = start; i < start + length; i += 1) data.set([63, 95, 90, 255], i * 4);
	const { report } = compareSculptToReference(snorlax.recipe, { width: ref.width, height: ref.height, data }, { yaw: 0 });
	assert.ok(report.iou > 0.9, JSON.stringify(report));
});

await check("the measured outline finds the raised arms apart from the head, in height fractions", () => {
	const ref = JSON.parse(readFileSync(new URL("./fixtures/sculpt-snorlax-mask.json", import.meta.url), "utf8"));
	const data = new Uint8Array(ref.width * ref.height * 4).fill(255);
	for (const [start, length] of ref.runs) for (let i = start; i < start + length; i += 1) data.set([63, 95, 90, 255], i * 4);
	const outline = measureReferenceOutline({ width: ref.width, height: ref.height, data });
	assert.equal(outline.rows.length, 12);
	assert.ok(outline.widthToHeight > 0.8 && outline.widthToHeight < 1.05, String(outline.widthToHeight));
	assert.ok(outline.rows.every(row => row.y >= 0 && row.y <= 1 && row.spans.every(([a, b]) => a < b && a >= -0.6 && b <= 0.6)), JSON.stringify(outline));
	assert.ok(outline.rows.slice(1, 4).some(row => row.spans.length >= 2), "an upper slice crosses an arm and the head separately");
	assert.ok(outline.rows.at(-1).spans.length >= 1, "the feet reach the bottom slice");
});

/* ------------------------------------------- weighted views (#970) --- */
await check("the weight table is front 0.6, side 0.25, back 0.15, read from the yaw", () => {
	assert.deepEqual(VIEW_WEIGHTS, { front: 0.6, side: 0.25, back: 0.15 });
	assert.equal(VIEW_RATIO_TOLERANCE, 0.35);
	assert.deepEqual([0, 30, -45, 46, 90, -90, 134, 135, 180, -180, -150].map(viewOfYaw), ["front", "front", "front", "side", "side", "side", "side", "back", "back", "back", "back"]);
	const same = viewWeights([{ yaw: 0, heightToWidth: 2 }, { yaw: 90, heightToWidth: 2 }, { yaw: 180, heightToWidth: 2 }]);
	assert.deepEqual(same, [{ weight: 0.6 }, { weight: 0.25 }, { weight: 0.15 }]);
	assert.deepEqual(viewWeights([{ yaw: 0, heightToWidth: 2, weight: 0.5 }, { yaw: 90, heightToWidth: 2, weight: 0.5 }]), [{ weight: 0.5 }, { weight: 0.5 }], "an explicit weight replaces the table's");
});

await check("a view whose height:width differs from the front's by more than 35% gets weight 0, with the reason", () => {
	// Front 2.0: a side at 2.6 (+30%) and a back at 1.4 (-30%) keep their weight; 2.8 (+40%) and 1.2 (-40%) do not.
	const kept = viewWeights([{ yaw: 0, heightToWidth: 2 }, { yaw: 90, heightToWidth: 2.6 }, { yaw: 180, heightToWidth: 1.4 }]);
	assert.deepEqual(kept.map((row) => row.weight), [0.6, 0.25, 0.15]);
	const cut = viewWeights([{ yaw: 0, heightToWidth: 2 }, { yaw: 90, heightToWidth: 2.8 }, { yaw: 180, heightToWidth: 1.2 }]);
	assert.deepEqual(cut.map((row) => row.weight), [0.6, 0, 0]);
	assert.match(cut[1].excluded, /height:width 2\.80 differs from the front's 2\.00 by 40% \(over 35%\)/);
	// The front is the front view nearest yaw 0; with no front view the rule has nothing to measure against.
	assert.deepEqual(viewWeights([{ yaw: 20, heightToWidth: 9 }, { yaw: 0, heightToWidth: 2 }]).map((row) => row.weight), [0, 0.6]);
	assert.deepEqual(viewWeights([{ yaw: 90, heightToWidth: 2 }, { yaw: 180, heightToWidth: 9 }]).map((row) => row.weight), [0.25, 0.15]);
});

await check("a sculpt scored on front, side and back blends the IoUs by weight and drops an off-scale view", () => {
	const slab = box(0.4, 1.2, 0.36);
	const front = rectImage({ x0: 0.4, x1: 0.6, y0: 0.2, y1: 0.8 });
	const side = rectImage({ x0: 0.41, x1: 0.59, y0: 0.2, y1: 0.8 });
	const { result } = scoreSculptAgainstViews(slab, [{ yaw: 0, image: front }, { yaw: 90, image: side }, { yaw: 180, image: front }]);
	const rows = result.report.views;
	assert.deepEqual(rows.map((row) => [row.view, row.yaw, row.weight]), [["front", 0, 0.6], ["side", 90, 0.25], ["back", 180, 0.15]]);
	const blended = rows.reduce((sum, row) => sum + row.iou * row.weight, 0);
	assert.ok(Math.abs(result.report.iou - blended) < 0.002, `${result.report.iou} vs ${blended}`);
	assert.ok(result.report.iou > 0.9, JSON.stringify(rows));
	assert.equal(result.report.view.yaw, 0, "the report and its sheet are the front's, the heaviest view");
	// A side drawn square (height:width 1 against the front's 3) is off scale: weight 0, and the rest renormalize.
	const square = rectImage({ x0: 0.2, x1: 0.8, y0: 0.2, y1: 0.8 });
	const off = scoreSculptAgainstViews(slab, [{ yaw: 0, image: front }, { yaw: 90, image: square }, { yaw: 180, image: front }]).result.report;
	assert.deepEqual(off.views.map((row) => row.weight), [0.8, 0, 0.2]);
	assert.match(off.views[1].excluded, /differs from the front's/);
	assert.ok(Math.abs(off.iou - (off.views[0].iou * 0.8 + off.views[2].iou * 0.2)) < 0.002);
	assert.throws(() => scoreSculptAgainstViews(slab, [{ yaw: 0, image: front, weight: 0 }]), /No view carries any weight/);
	assert.throws(() => scoreSculptAgainstViews(slab, []), /at least one/);
});

await check("candidates are ranked on the same views and weights; none is applied", () => {
	const slab = box(0.4, 1.2, 0.36);
	const front = rectImage({ x0: 0.4, x1: 0.6, y0: 0.2, y1: 0.8 });
	const side = rectImage({ x0: 0.41, x1: 0.59, y0: 0.2, y1: 0.8 });
	const scored = scoreSculptAgainstViews(slab, [{ yaw: 0, image: front }, { yaw: 90, image: side }], { candidates: [{ label: "deep", edits: [{ set: "b", size: [0.4, 1.2, 0.9] }] }, { label: "ghost", edits: [{ set: "nope", color: "#000000" }] }] });
	assert.deepEqual(scored.ranked.map((row) => row.label), ["current", "deep"], "a too-deep slab loses on the side view");
	assert.ok(scored.ranked[1].result.report.views[1].iou < scored.ranked[0].result.report.views[1].iou);
	assert.match(scored.refused[0].error, /no part named "nope"/);
});

if (failures) {
	console.log(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nverify-sculpt-compare: all checks passed");
