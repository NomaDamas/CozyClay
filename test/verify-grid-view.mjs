#!/usr/bin/env node
// Blender-style grid viewport: persistence contract + rendering pins.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	GRID_BACKGROUND,
	GRID_COLORS,
	GRID_FOG,
	GRID_VIEW_STORAGE_KEY,
	readStoredGridView,
	writeStoredGridView,
} from "../src/grid-view.js";

// --- constants ------------------------------------------------------------
assert.equal(GRID_VIEW_STORAGE_KEY, "cozyclay.grid-view.v1");
assert.match(GRID_BACKGROUND, /^#[0-9a-f]{6}$/, "the void is a concrete colour, not a theme lookup");
assert.equal(GRID_FOG.color, GRID_BACKGROUND, "fog dissolves into the same void, no horizon line");
assert.ok(GRID_FOG.far > GRID_FOG.near && GRID_FOG.near > 0);
for (const key of ["minor", "major", "axisX", "axisZ"]) {
	assert.match(GRID_COLORS[key], /^#[0-9a-f]{6}$/, `${key} line colour is pinned`);
}
assert.ok(Object.isFrozen(GRID_COLORS) && Object.isFrozen(GRID_FOG));

// --- persistence ----------------------------------------------------------
const store = new Map();
const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
assert.equal(readStoredGridView(storage), false, "the mode ships off");
writeStoredGridView(storage, true);
assert.equal(store.get(GRID_VIEW_STORAGE_KEY), "1");
assert.equal(readStoredGridView(storage), true);
writeStoredGridView(storage, false);
assert.equal(readStoredGridView(storage), false);
assert.equal(readStoredGridView(null), false, "missing storage is safe");
writeStoredGridView({ setItem() { throw new Error("quota"); } }, true); // must not throw
assert.equal(readStoredGridView({ getItem() { throw new Error("denied"); } }), false);

// --- grid mesh pins (the shader plane, src/grid-floor.jsx) -----------------
const floor = readFileSync(new URL("../src/grid-floor.jsx", import.meta.url), "utf8");
assert.ok(floor.includes("fwidth("), "grid lines are anti-aliased in the fragment shader");
assert.ok(floor.includes("depthWrite: false"), "the transparent grid never writes depth");
assert.ok(floor.includes("fog: false"), "the reference ignores scene fog; it fades itself radially");
assert.ok(floor.includes("mesh.layers.set(layer)"), "the grid can be confined to an editor-only layer");
assert.ok(floor.includes("receiveShadow={false}"), "a reference overlay joins no light transport");

// --- App wiring pins -------------------------------------------------------
const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
assert.ok(app.includes("{gridView ? <GridFloor layer={GIZMO_LAYER} /> : <Room />}"), "grid replaces the deck on the export-stripped gizmo layer");
assert.ok(app.includes('args={[gridView ? GRID_BACKGROUND : "#eef4f3"]}'), "the background swaps to the void colour");
assert.ok(app.includes("writeStoredGridView(globalThis.localStorage, gridView)"), "the preference persists per browser");
assert.ok(app.includes('ko("Reference grid", "기준 그리드")'), "the View menu offers a bilingual toggle");
assert.ok(
	app.includes('className={"view-menu-item grid-view-switch" + (gridView ? " active" : "")}'),
	"the toggle kept its class and moved into the viewport bar's View menu",
);

console.log("verify-grid-view: all checks passed");
