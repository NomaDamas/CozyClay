import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { proxyFigureBounds } from "../src/character-kind.js";
import { placementAt } from "../src/root-path.js";
import { isProxyFigure } from "../src/scenes.js";

test("proxy bounds follow rendered stature and posture", () => {
	const stand = proxyFigureBounds({ model: "proxy-figure", posture: "stand", x: 2, z: -3 });
	assert.deepEqual(stand.min, { x: 1.78, y: 0, z: -3.22 });
	assert.deepEqual(stand.max, { x: 2.22, y: 1.7, z: -2.78 });

	const sit = proxyFigureBounds({ model: "proxy-figure", posture: "sit", scale: 2 }, { x: -1, y: 0.4, z: 3, rot: 90, scale: 2 });
	assert.equal(sit.min.y, 0.4);
	assert.equal(sit.max.y, 2.64);
	assert.ok(sit.min.x < -1.43 && sit.max.x >= -0.56);

	const lie = proxyFigureBounds({ model: "proxy-figure", posture: "lie", x: 4, z: 5, scale: 1.5 }, { x: 4, y: 0.2, z: 5, rot: 0, scale: 1.5 });
	assert.ok(Math.abs(lie.min.y - 0.35) < 1e-12);
	assert.ok(Math.abs(lie.max.y - 0.71) < 1e-12);
	assert.equal(lie.min.z, 5);
	assert.equal(lie.max.z, 7.55);
});

// App.jsx's studioBounds proxy branch is evaluated from source so a stale
// placement identifier (a missing import) throws here, not only in a browser.
test("App.jsx studioBounds resolves a proxy figure through placementAt", () => {
	const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
	const start = app.indexOf("function studioBounds(");
	const end = app.indexOf("function operateStudio(", start);
	assert.ok(start > 0 && end > start, "studioBounds source slice");
	const figure = { id: "p1", model: "proxy-figure", posture: "stand", x: 2, z: -3 };
	const scope = {
		placementAt, proxyFigureBounds, isProxyFigure,
		readStudioState: () => ({ characters: [figure], targets: new Map(), shots: [] }),
		shotAtFrame: () => null,
		sampleAt: () => ({ subject: null }),
		StudioProtocolError: Error,
	};
	const studioBounds = new Function(...Object.keys(scope), `${app.slice(start, end)}\nreturn studioBounds;`)(...Object.values(scope));
	const bounds = studioBounds({ entity: figure, frame: 0, state: {} });
	assert.deepEqual(bounds, proxyFigureBounds(figure, placementAt(figure, 0, { shotAt: () => null, takeRoot: null })));
});
