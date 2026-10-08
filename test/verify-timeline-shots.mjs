#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shotBlockGeometry } from "../src/ardy/timeline-coordinates.js";

const shots = [
	{ id: "a", name: "Wide", startFrame: 10, endFrame: 29 },
	{ id: "b", name: "Medium", startFrame: 40, endFrame: 59 },
	{ id: "c", name: "Close", startFrame: 70, endFrame: 79 },
];
assert.deepEqual(shotBlockGeometry(shots, 0, 100), { startFrame: 10, endFrame: 29, startPct: 10 / 99, endPct: 29 / 99 });
assert.deepEqual(shotBlockGeometry(shots, 1, 100), { startFrame: 40, endFrame: 59, startPct: 40 / 99, endPct: 59 / 99 });
assert.deepEqual(shotBlockGeometry(shots, 2, 100), { startFrame: 70, endFrame: 79, startPct: 70 / 99, endPct: 79 / 99 });
assert.equal(shotBlockGeometry(shots, 5, 100), null);

const timeline = readFileSync(new URL("../src/ardy/timeline.jsx", import.meta.url), "utf8");
import { readStudioSource } from "./bus/verify-domain-modules.mjs";
const app = readStudioSource();
const commands = readFileSync(new URL('../src/commands/shot.js', import.meta.url), 'utf8');
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const v2Css = readFileSync(new URL("../src/ardy/timeline.css", import.meta.url), "utf8");
assert.ok(timeline.includes('const SHOTS_LANE = "Shots"'));
assert.ok(timeline.includes('className={"timeline v2-sequencer"'));
assert.ok(v2Css.includes('--tl-track-tree-width: 190px') && v2Css.includes('--tl-track-row-height: 38px'));
assert.ok(v2Css.includes('var(--tl-camera-clip, #3d3354)') && v2Css.includes('var(--tl-body-clip, #23402f)'));
assert.ok(timeline.includes('className={"tl-shot-block"'));
assert.ok(!timeline.includes('className={"tl-camera-block"'));
assert.ok(timeline.includes("onShotBoundaryMove"));
assert.ok(timeline.includes("onShotRename"));
assert.ok(timeline.includes("onShotRemove"));
assert.ok(timeline.includes("onShotDuplicate"));
assert.ok(timeline.includes("onShotCut"));
assert.ok(timeline.includes("onShotSplit"));
assert.ok(timeline.includes('ko("+ Add shot", "+ 샷 추가")'));
assert.ok(timeline.includes('className="tl-shot-empty"'));
assert.ok(timeline.includes('className="tl-shot-camera-summary"'));
assert.ok(timeline.includes('className="tl-shot-key-surface"'));
assert.ok(timeline.includes("durationS.toFixed(1)"));
assert.ok(timeline.includes('className="tl-shot-edge end"'));
assert.ok(timeline.includes("onShotMove"));
assert.ok(app.includes("shots={shots}"));
assert.ok(app.includes(".edit('shot.setRange', { shotId, range:"));
assert.ok(commands.includes("resizeShot(rows, shotId, edge, frame, owner().state().frameCount)"));
assert.ok(commands.includes("addShotAtFrame(current, ports.state().frame, owner().state().frameCount, owner().capture())"));
assert.ok(commands.includes("cutAtFrame(current, shotId, frame, owner().capture())"));
assert.ok(!timeline.includes("disabled={shots.length <= 1}"));
assert.ok(css.includes("width: calc((var(--tl-f-end) - var(--tl-f-start)) * 100%);"));
assert.ok(!css.includes("width: max(8px, calc((var(--tl-f-end) - var(--tl-f-start)) * 100%));"));
assert.ok(v2Css.includes(".v2-sequencer .tl-shot-actions") && v2Css.includes("bottom: 100%;"));
assert.ok(!v2Css.includes("bottom: calc(100% + 2px);"));
assert.ok(v2Css.includes(".v2-sequencer .tl-shot-block.selected .tl-shot-actions") && v2Css.includes(".v2-sequencer .tl-shot-block.active .tl-shot-actions"));

console.log("timeline shots lane verified");
