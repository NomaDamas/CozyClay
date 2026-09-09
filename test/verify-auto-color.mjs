#!/usr/bin/env node
// Auto color mode: the derivation is a CONTRACT (same id -> same hex on every
// machine, forever), so the algorithm is pinned by value, not re-derived. The
// wiring pins hold the mode to what it promises: display-only, cutouts
// excluded, persisted under its own key, one toggle.
import { readFileSync } from "node:fs";
import { AUTO_COLOR_KEY, autoColorHex, hashObjectId } from "../src/auto-color.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

/* --- the derivation is deterministic and well-spaced --------------------- */

expect(
	"same id yields the same hex on repeated calls",
	autoColorHex("cube") === autoColorHex("cube") && autoColorHex("cube") === autoColorHex("cube"),
);
// Golden pins fixed by the plan (.omo/plans/auto-object-color.md), NOT read
// from the implementation: an algorithm change that shifts every scene's
// colors must fail here first.
expect("golden pin: cube", autoColorHex("cube") === "#66b8d6", autoColorHex("cube"));
expect("golden pin: cube-2", autoColorHex("cube-2") === "#d66678", autoColorHex("cube-2"));
expect("an empty id still yields a valid color", autoColorHex("") === "#66add6", autoColorHex(""));

const forty = new Set();
for (let index = 1; index <= 40; index += 1) forty.add(autoColorHex(`obj-${index}`));
expect("40 sequential ids yield 40 distinct hexes", forty.size === 40, `got ${forty.size}`);

expect(
	"every hex is lowercase #rrggbb",
	[...forty].every((hex) => /^#[0-9a-f]{6}$/.test(hex)),
);

expect(
	"the hash is 32-bit FNV-1a",
	hashObjectId("") === 2166136261 && hashObjectId("cube") === 1804718368,
	String(hashObjectId("cube")),
);

/* --- the wiring keeps the mode display-only ------------------------------ */

const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const props = readFileSync(new URL("../src/props.jsx", import.meta.url), "utf8");
const planview = readFileSync(new URL("../src/planview.jsx", import.meta.url), "utf8");

expect(
	"App maps a display-only autoColor marker, never the authored color",
	app.includes("autoColor: autoColorHex(object.id)") && !app.includes("color: autoColorHex("),
);
expect(
	"cutouts are excluded from the mode",
	app.includes("object.renderer === CUTOUT_KIND ? object : { ...object, autoColor:"),
);
expect("the toggle persists under its own key", app.includes("saveAutoColor(") && AUTO_COLOR_KEY === "cozyclay.auto-color.v1");
// The toggle lives in the viewport bar's View menu (#194); it kept its class
// and its aria-pressed contract through the move.
expect(
	"the toggle reports its state",
	app.includes('className={"view-menu-item auto-color-toggle" + (autoColor ? " active" : "")}') &&
	app.includes("aria-pressed={autoColor}"),
);
expect(
	"the viewport renderers consume the marker with authored fallback",
	props.includes("autoColor ?? color"),
);
expect(
	"auto-colored surfaces use the flat solid-view response, not the lit clay one",
	props.includes("function autoFlat") && props.includes("emissive: hex") && props.includes("roughness: 1"),
);
expect(
	"the plan board agrees with the viewport",
	planview.includes("object.autoColor ?? OBJECT_COLOR"),
);
expect(
	"the inspector shows the derived hex without swapping its data source",
	app.includes("autoColorHex(selectedSceneObject.id)"),
);

if (failures > 0) {
	console.error(`verify-auto-color: ${failures} FAILURE${failures === 1 ? "" : "S"}`);
	process.exit(1);
}
console.log("verify-auto-color: all checks passed");
