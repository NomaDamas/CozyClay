#!/usr/bin/env node
// sculpt.compare (#739): the Studio agent's read-only way to score a sculpt
// against its reference. Same scoring as MCP compare_sculpt (one function in
// src/sculpt-compare.js), run through the real command bus; candidates are
// ranked and none is applied; a non-sculpt id is refused.
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePng, encodePng } from "../mcp/image-file.mjs";
import { createToolHandlers, setLiveHub } from "../mcp/tool-handlers.mjs";
import { objectsFixture } from "./bus/objects-fixture.mjs";

const snorlax = JSON.parse(readFileSync(new URL("./fixtures/sculpt-snorlax.json", import.meta.url), "utf8"));
const mask = JSON.parse(readFileSync(new URL("./fixtures/sculpt-snorlax-mask.json", import.meta.url), "utf8"));
const rgba = new Uint8Array(mask.width * mask.height * 4).fill(255);
for (const [start, length] of mask.runs) for (let i = start; i < start + length; i += 1) rgba.set([63, 95, 90, 255], i * 4);
const png = encodePng(mask.width, mask.height, rgba);
const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
const ASSET_ID = `img-${"a".repeat(64)}`;
// A tiny reference: its reference | overlay sheet is under 64 px wide.
const SMALL_ID = `img-${"c".repeat(64)}`;
const small = { width: 24, height: 30, data: new Uint8Array(24 * 30 * 4).fill(255) };
for (let y = 0; y < 30; y += 1) for (let x = 0; x < 24; x += 1) if (((x - 11.5) / 9) ** 2 + ((y - 15) / 13) ** 2 <= 1) small.data.set([63, 95, 90, 255], (y * 24 + x) * 4);
const candidates = [
	{ label: "fat-body", edits: [{ set: "body", size: [1.9, 1.39, 0.95] }] },
	{ label: "tall-head", edits: [{ set: "head", size: [0.79, 0.9, 0.7] }] },
	{ label: "broken", edits: [{ set: "ghost", color: "#000000" }] },
];

let failures = 0;
async function check(name, fn) {
	try { await fn(); console.log(`ok - ${name}`); }
	catch (error) { failures += 1; console.log(`not ok - ${name}\n${error.stack}`); }
}

/* ------------------------------------------------ MCP compare_sculpt ---- */
setLiveHub(null);
const tools = createToolHandlers({});
const tool = name => tools.find(entry => entry.name === name);
const refPath = join(tmpdir(), `cozyclay-sculpt-compare-command-${process.pid}.png`);
writeFileSync(refPath, png);
const made = await tool("sculpt_object").handler({ recipe: snorlax, name: "Snorlax" });
assert.equal(made.isError, undefined, made.content[0].text);
const mcpId = made.content[0].text.match(/ as ([\w-]+):/)[1];
const mcp = JSON.parse((await tool("compare_sculpt").handler({ id: mcpId, reference: refPath })).content[0].text);
const mcpRanked = JSON.parse((await tool("compare_sculpt").handler({ id: mcpId, reference: refPath, candidates })).content[0].text);
rmSync(refPath, { force: true });

/* ------------------------------------------------ editor command ---- */
const f = objectsFixture();
// The Node stand-in for the browser image port: a PNG data URL or the one stored asset, decoded to RGBA.
f.actionHandlers.current.sculptImages = {
	async decode(reference) {
		if (reference.assetId === SMALL_ID) return small;
		if (reference.assetId !== undefined) {
			if (reference.assetId !== ASSET_ID) throw new Error(`no image asset ${reference.assetId} in this project`);
			return { width: mask.width, height: mask.height, data: rgba };
		}
		return decodePng(Buffer.from(reference.dataUrl.split(",")[1], "base64"));
	},
	async encodePng({ width, height, data }) { return `data:image/png;base64,${encodePng(width, height, data).toString("base64")}`; },
};
const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt; };
let sculptId;

try {
	await check("the declaration is a read-only job the agent can see", () => {
		const entry = f.registry.get("sculpt.compare");
		assert.equal(entry.kind, "job");
		assert.equal(entry.undoDomain, undefined);
		assert.equal(entry.exposure, "open");
		assert.ok(f.binding.handlers.inspect_studio({ scope: "actions" }).actions.some(row => row.id === "sculpt.compare"));
	});

	await check("editor IoU and view equal MCP compare_sculpt on the same recipe and reference", async () => {
		sculptId = ok(f.run("object.sculpt", { recipe: snorlax, name: "Snorlax" })).affectedIds[0];
		const before = structuredClone(f.objects.read());
		const receipt = ok(await f.run("sculpt.compare", { id: sculptId, reference: { dataUrl } }, "agent"));
		assert.equal(receipt.status, "completed");
		assert.deepEqual([receipt.authored, receipt.undo, receipt.revision.after], [false, null, receipt.revision.before]);
		const out = receipt.output;
		console.log(`  IoU editor ${out.iou} vs MCP ${mcp.iou} (yaw ${out.view.yaw} vs ${mcp.view.yaw})`);
		assert.ok(Math.abs(out.iou - mcp.iou) < 0.001);
		assert.ok(out.iou > 0.9, JSON.stringify(out));
		for (const key of ["view", "widthToHeight", "missingByBand", "extraByPart", "missingFraction", "extraFraction", "mask"]) assert.deepEqual(out[key], mcp[key], key);
		assert.match(receipt.summary, /^Compared Snorlax with the reference at yaw -?\d+: IoU 0\.\d+\.$/);
		const sheet = decodePng(Buffer.from(out.sheetDataUrl.split(",")[1], "base64"));
		// reference | overlay side by side, shrunk (sheetScale) when the full sheet would not fit the 8 KiB receipt.
		const scale = out.sheetScale ?? 1;
		assert.deepEqual([sheet.width, sheet.height], [Math.floor(2 * mask.width * scale), Math.floor(mask.height * scale)]);
		console.log(`  sheet ${sheet.width}x${sheet.height} (scale ${scale}), receipt ${JSON.stringify(receipt).length} bytes`);
		assert.deepEqual(f.objects.read(), before, "scoring changes nothing");
	});

	await check("an asset reference and a fixed yaw score the same way", async () => {
		const out = ok(await f.run("sculpt.compare", { id: sculptId, reference: { assetId: ASSET_ID }, yaw: 0 }, "agent")).output;
		assert.equal(out.view.yaw, 0);
		const front = JSON.parse((await (async () => {
			const path = join(tmpdir(), `cozyclay-sculpt-compare-yaw0-${process.pid}.png`);
			writeFileSync(path, png);
			try { return (await tool("compare_sculpt").handler({ id: mcpId, reference: path, yaw: 0 })).content[0].text; } finally { rmSync(path, { force: true }); }
		})()));
		assert.ok(Math.abs(out.iou - front.iou) < 0.001, `${out.iou} vs ${front.iou}`);
		const missing = await f.run("sculpt.compare", { id: sculptId, reference: { assetId: `img-${"b".repeat(64)}` } }, "agent");
		assert.equal(missing.ok, false);
		assert.match(missing.message, /Could not read the reference image: no image asset/);
	});

	await check("candidates are ranked like MCP's and none is applied", async () => {
		const before = structuredClone(f.objects.read());
		const revision = f.binding.refresh().revision;
		const receipt = ok(await f.run("sculpt.compare", { id: sculptId, reference: { dataUrl }, candidates }, "agent"));
		const { ranking } = receipt.output;
		const scored = ranking.filter(row => !row.refused);
		assert.deepEqual(scored.map(row => row.label), mcpRanked.ranking.map(row => row.label));
		scored.forEach((row, i) => assert.ok(Math.abs(row.iou - mcpRanked.ranking[i].iou) < 0.001, row.label));
		assert.deepEqual(scored.map(row => row.iou), [...scored.map(row => row.iou)].sort((a, b) => b - a), "best first");
		assert.equal(scored.find(row => row.label === "current").delta, 0);
		assert.match(ranking.find(row => row.label === "broken").refused, /no part named "ghost"/);
		assert.equal(receipt.output.sheetLabel, scored[0].label, "the sheet is the winner's");
		assert.ok(receipt.output.sheetDataUrl.startsWith("data:image/png;base64,"));
		assert.match(receipt.output.note, /Nothing was applied/);
		assert.deepEqual(f.objects.read(), before, "no candidate was applied");
		assert.equal(f.binding.refresh().revision, revision, "the scene revision did not move");
		assert.equal(receipt.undo, null);
	});

	await check("inside an open agent turn the score completes with no undo entry", async () => {
		const turnId = crypto.randomUUID();
		ok(f.run("agent.turn.begin", { turnId }, "agent", { turnId }));
		try {
			const receipt = ok(await f.run("sculpt.compare", { id: sculptId, reference: { assetId: ASSET_ID } }, "agent", { turnId }));
			assert.equal(receipt.status, "completed");
			assert.equal(receipt.authored, false);
			assert.equal(receipt.undo, null);
			assert.ok(Math.abs(receipt.output.iou - mcp.iou) <= 0.001, `${receipt.output.iou} vs ${mcp.iou}`);
		} finally {
			f.run("agent.turn.cancel", { turnId }, "agent", { turnId });
		}
	});

	await check("views [{ yaw, reference, weight }] score weighted views, the same in the editor and MCP; the old shape still works", async () => {
		const views = [{ yaw: 0, reference: { dataUrl } }, { yaw: 180, reference: { assetId: ASSET_ID } }];
		const receipt = ok(await f.run("sculpt.compare", { id: sculptId, views }, "agent"));
		const out = receipt.output;
		assert.deepEqual(out.views.map(row => [row.view, row.yaw, row.weight]), [["front", 0, 0.8], ["back", 180, 0.2]], "front 0.6 and back 0.15, renormalized");
		assert.ok(Math.abs(out.iou - (out.views[0].iou * 0.8 + out.views[1].iou * 0.2)) < 0.002);
		assert.match(receipt.summary, /^Compared Snorlax with 2 weighted views \(front 0\.8, back 0\.2\): IoU 0\.\d+\.$/);
		assert.ok(out.sheetDataUrl.startsWith("data:image/png;base64,"), "the front's sheet rides along");
		const path = join(tmpdir(), `cozyclay-sculpt-compare-views-${process.pid}.png`);
		writeFileSync(path, png);
		let viaMcp;
		try { viaMcp = JSON.parse((await tool("compare_sculpt").handler({ id: mcpId, views: [{ yaw: 0, reference: path }, { yaw: 180, reference: path }] })).content[0].text); } finally { rmSync(path, { force: true }); }
		assert.ok(Math.abs(out.iou - viaMcp.iou) < 0.001, `${out.iou} vs ${viaMcp.iou}`);
		assert.deepEqual(viaMcp.views.map(row => row.weight), [0.8, 0.2]);
		// An explicit weight replaces the table's.
		const even = ok(await f.run("sculpt.compare", { id: sculptId, views: views.map(view => ({ ...view, weight: 0.5 })) }, "agent")).output;
		assert.deepEqual(even.views.map(row => row.weight), [0.5, 0.5]);
		for (const args of [{ id: sculptId }, { id: sculptId, reference: { dataUrl }, views }]) {
			const refused = await f.run("sculpt.compare", args, "agent");
			assert.equal(refused.code, "INVALID_ARGUMENT");
			assert.match(refused.message, /exactly one of reference .* or views/);
		}
		assert.equal((await tool("compare_sculpt").handler({ id: mcpId })).isError, true, "MCP refuses neither shape too");
	});

	await check("a sheet narrower than 64 px is still sent when it fits", async () => {
		const out = ok(await f.run("sculpt.compare", { id: sculptId, reference: { assetId: SMALL_ID } }, "agent")).output;
		assert.equal(out.sheetOmitted, undefined, out.sheetOmitted);
		const sheet = decodePng(Buffer.from(out.sheetDataUrl.split(",")[1], "base64"));
		assert.ok(sheet.width < 64, `sheet ${sheet.width} px wide`);
		assert.equal(out.sheetScale, undefined, "sent at full size");
	});

	await check("a non-sculpt id is refused and nothing changes", async () => {
		const before = structuredClone(f.objects.read());
		const refused = await f.run("sculpt.compare", { id: "cube", reference: { dataUrl } }, "agent");
		assert.equal(refused.ok, false);
		assert.equal(refused.code, "INVALID_ARGUMENT");
		assert.match(refused.message, /cube is a \w+, not a sculpt/);
		const ghost = await f.run("sculpt.compare", { id: "ghost", reference: { dataUrl } }, "agent");
		assert.equal(ghost.code, "STALE_TARGET");
		assert.deepEqual(f.objects.read(), before);
	});
} finally {
	f.dispose();
}

if (failures) {
	console.log(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nverify-sculpt-compare-command: all checks passed");
