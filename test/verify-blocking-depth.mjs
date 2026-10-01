#!/usr/bin/env node

// The blocking frame is the only thing that tells an AI how far away the
// subject is. The stage has no walls, so every depth cue it carries is one we
// put there on purpose: the grid's converging cells, the floor's distance
// shading and contact shadow, and a horizon the fog does not eat.
//
// Each of those was absent, and each went absent for a defensible reason
// (chrome belongs in the viewport; an unlit deck is cheap; a fogged horizon is
// tidy). These checks pin the reasons back to the surface that needs them, so
// a future cleanup cannot quietly flatten the deliverable again.

import { readFileSync } from "node:fs";
import { composePrompt, deriveShot } from "../src/shot.js";

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

// The studio source spans App.jsx and app-stage.jsx (module-level extraction); pin against both.
const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8")
	+ readFileSync(new URL("../src/app-stage.jsx", import.meta.url), "utf8");
const room = readFileSync(new URL("../src/room.jsx", import.meta.url), "utf8");

/* --- the grid is baked into the deck, not floated over it ----------------- */

// A helper two millimetres above a 500 m plane loses to the floor across the
// whole frame and survives only at the grazed horizon, which is where it is
// useless. Drawing the lines in the floor's own shader ends that contest; the
// lines are computed per pixel (fwidth), so they stay ~1 px at any distance
// and fade out before they alias into a moire band.
expect("the deck draws its grid in its own shader", room.includes("function makeDeckMaterial(light)") && room.includes("material.onBeforeCompile") && room.includes("material={material}"));
expect("the grid has metre lines and heavier ten-metre lines", room.includes("gridLines(1.0, 1.0)") && room.includes("gridLines(${TILE_M.toFixed(1)}, 1.6)") && room.includes("const TILE_M = 10;"));
expect("the grid lines are pixel-wide and fade before they alias", room.includes("fwidth(cell)") && room.includes("1.0 - smoothstep(0.08, 0.2,"));
expect("the material is released with the room", room.includes("material.dispose()"));
expect("no floating grid helper is layered over the deck", !app.includes("new THREE.GridHelper"));

/* --- the floor shades with distance and takes a contact shadow ------------- */

expect("the deck is lit rather than flat-filled", room.includes("new THREE.MeshLambertMaterial({") && room.includes("color: light ? FLOOR_LIGHT : FLOOR,"));
expect("the deck receives shadow", room.includes("receiveShadow"));
expect("the key light casts one shadow", room.includes("castShadow") && room.includes("shadow-mapSize-width={2048}"));
expect(
	"the shadow frustum covers the blocking area, not the whole 500 m deck",
	// far=40 clipped every shadow once the user dragged the light past 40 m
	// (verified with the three.js shadow frustum); 60 covers the clamp corner.
	room.includes("shadow-camera-left={-14}") && room.includes("shadow-camera-far={60}"),
);
expect("the renderer actually has shadows enabled", app.includes("<Canvas") && app.includes("shadows") && app.includes("frameloop={renderActive ?"));
expect("the subject casts its own shadow", app.includes("child.castShadow = true;"));

/* --- the exported frame keeps a horizon ------------------------------------ */

// Both fog bounds must stay inside the shot camera's 100 m far plane, or the
// deck is clipped mid-fade and the horizon never resolves.
expect("the capture fog stays inside the camera far plane", app.includes("const CAPTURE_FOG_FAR = 95;") && app.includes("far={100}"));
expect(
	"the capture pushes the fog back and restores it",
	app.includes("const CAPTURE_FOG_NEAR = 55;") &&
	app.includes("const CAPTURE_FOG_FAR = 95;") &&
	app.includes("fog.near = CAPTURE_FOG_NEAR;") &&
	app.includes("fog.near = fogNear;"),
);
expect(
	"the viewport fog is untouched",
	// Clay stage keeps its tuned values; grid view swaps to the void fog whose
	// far plane also sits below CAPTURE_FOG_NEAR, so the capture trick holds.
	app.includes('args={gridView ? [GRID_FOG.color, GRID_FOG.near, GRID_FOG.far] : [stageBackground(uiTheme), 18, 54]}'),
);
const captureFog = app.indexOf("fog.near = CAPTURE_FOG_NEAR;");
const restoreFog = app.indexOf("fog.near = fogNear;");
expect("the restore happens after the render, in a finally", captureFog > 0 && restoreFog > captureFog);

/* --- the AI is told to read the grid, not draw it -------------------------- */

const shot = deriveShot({ x: 0, y: 1.6, z: 3 }, { x: 0, z: 0, rot: 0 }, (45 * Math.PI) / 180);
const prompt = composePrompt({
	shot,
	subject: "a young woman in a tan coat",
	environment: "a sunlit modern living room",
	style: "35mm film look",
});
expect("the prompt explains the grid encodes distance", /grid is a measuring aid/i.test(prompt), prompt.slice(0, 120));
expect("the prompt forbids drawing the grid", /do NOT draw the grid itself/i.test(prompt));
expect("the grid joins the do-not-reproduce list", /measurement grid/i.test(prompt));

const sheeted = composePrompt({
	shot,
	subject: "a young woman in a tan coat",
	environment: "a sunlit modern living room",
	style: "35mm film look",
	hasCharSheet: true,
	hasEnvSheet: true,
});
expect("sheet mode still carries the grid instruction", /do NOT draw the grid itself/i.test(sheeted));
expect("sheet mode drops the preset subject and environment text", !sheeted.includes("tan coat") && !sheeted.includes("sunlit modern living room"));

if (failures) process.exit(1);
console.log("blocking-frame depth checks PASS");
