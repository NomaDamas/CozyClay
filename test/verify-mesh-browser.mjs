#!/usr/bin/env node
/**
 * GLB mesh props, end to end in a real browser.
 *
 * Node suites prove magic, the fit heuristic and the scene record. This
 * drives Chrome over CDP with the unit-cube fixture on a real file input:
 * the model must land in the hierarchy, sit at 1 m, draw as the file's
 * mesh (not the grey placeholder), survive clay, and come back after reload.
 *
 * Run: `npm run dev:ui -- --port 5191` then
 * `QA_URL=http://127.0.0.1:5191/app/ CDP_PORT=9322 npm run qa:browser -- node test/verify-mesh-browser.mjs`.
 */
import { fileURLToPath } from "node:url";

const glbPath = fileURLToPath(new URL("./fixtures/unit-cube.glb", import.meta.url));
const objPath = fileURLToPath(new URL("./fixtures/unit-cube.obj", import.meta.url));
const fbxPath = fileURLToPath(new URL("./fixtures/unit-cube.fbx", import.meta.url));

const port = Number(process.env.CDP_PORT || 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("no page target on the QA browser");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	ws.onopen = resolve;
	ws.onerror = reject;
});
let nextId = 1;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.method === "Runtime.exceptionThrown") {
		pageErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
		return;
	}
	if (!message.id || !pending.has(message.id)) return;
	const { resolve, reject } = pending.get(message.id);
	pending.delete(message.id);
	if (message.error) reject(new Error(JSON.stringify(message.error)));
	else resolve(message.result);
};
const send = (method, params = {}) =>
	new Promise((resolve, reject) => {
		const id = nextId++;
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ id, method, params }));
	});
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (expression, { timeoutMs = 8000, intervalMs = 120 } = {}) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate(expression).catch(() => false)) return true;
		await sleep(intervalMs);
	}
	return false;
};

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

const sceneProbe = `(() => {
	let node = window.__cozyclay?.shotCam;
	while (node && !node.isScene) node = node.parent;
	if (!node) return { error: "no scene" };
	const meshes = [];
	node.traverse((object) => {
		if (!object.isMesh || !object.material) return;
		const material = Array.isArray(object.material) ? object.material[0] : object.material;
		const color = material?.color;
		const hex = material?.color?.getHexString?.() ?? "";
		meshes.push({
			name: object.name || "",
			materialName: material?.name || "",
			materialType: material?.type || "",
			clayOwned: object.userData?.clayOwned === true,
			roughness: material?.roughness ?? null,
			r: color?.r ?? null,
			g: color?.g ?? null,
			b: color?.b ?? null,
			castShadow: object.castShadow === true,
			placeholderGrey: hex === "c2c6c8",
		});
	});
	const imported = meshes.find((mesh) => mesh.materialName === "Cube" || (mesh.r !== null && Math.abs(mesh.r - 0.8) < 0.08 && mesh.g < 0.4));
	const objFile = meshes.find((mesh) => !mesh.clayOwned && !mesh.placeholderGrey && mesh.r !== null && mesh.r > 0.9 && mesh.g > 0.9);
	const fbxFile = meshes.find((mesh) => !mesh.clayOwned && !mesh.placeholderGrey && mesh.castShadow && mesh.name === "Cube" && mesh.materialType === "MeshPhongMaterial");
	const clay = meshes.find((mesh) => mesh.clayOwned);
	return { count: meshes.length, imported: imported || null, objFile: objFile || null, fbxFile: fbxFile || null, clay: clay || null };
})()`;

await send("Page.enable");
await send("Runtime.enable");
await send("DOM.enable");
for (let i = 0; i < 60 && !(await evaluate("!!window.__sceneHistory && document.querySelectorAll('.hierarchy-row').length > 0").catch(() => false)); i++) {
	await sleep(200);
}

try {
	await evaluate("[...document.querySelectorAll('.hierarchy-row')].find((row) => /Props|소품/.test(row.textContent))?.click()");
	await sleep(300);
	const hasButton = await waitFor("!!document.querySelector('input[type=file][accept*=\".glb\"]')");
	expect("the set offers a GLB import", hasButton);

	const { root } = await send("DOM.getDocument");
	const { nodeId } = await send("DOM.querySelector", { nodeId: root.nodeId, selector: 'input[type=file][accept*=".glb"]' });
	await send("DOM.setFileInputFiles", { nodeId, files: [glbPath] });

	const arrived = await waitFor(
		"[...document.querySelectorAll('.hierarchy-row')].some((row) => /unit-cube/.test(row.textContent))",
		{ timeoutMs: 10000 },
	);
	expect("a picked GLB becomes an object in the set", arrived);

	const inspector = await evaluate(`(() => {
		const height = document.querySelector('.inspector-scroll input[data-field="mesh-height"]');
		const clay = document.querySelector('.inspector-scroll input[data-field="mesh-clay"]');
		return { height: height ? Number(height.value) : null, clay: clay ? clay.checked : null };
	})()`);
	expect("a fresh model stands 1 m tall (unit cube, in-range)", inspector.height !== null && Math.abs(inspector.height - 1) < 0.02, JSON.stringify(inspector));
	expect("clay is off until asked for", inspector.clay === false, JSON.stringify(inspector));

	const drawn = await waitFor(`(() => { const probe = ${sceneProbe}; return !!(probe && probe.imported); })()`, { timeoutMs: 12000 });
	const graph = await evaluate(sceneProbe);
	expect("the file mesh is on stage, not the grey placeholder", drawn && graph.imported, JSON.stringify(graph));
	expect("the imported mesh casts a shadow", graph.imported?.castShadow === true, JSON.stringify(graph.imported));

	await evaluate(`(() => {
		const input = document.querySelector('.inspector-scroll input[data-field="mesh-clay"]');
		if (!input) return;
		input.click();
	})()`);
	const clayOn = await waitFor(`(() => { const probe = ${sceneProbe}; return !!(probe && probe.clay); })()`, { timeoutMs: 4000 });
	const afterClay = await evaluate(sceneProbe);
	expect("turning clay on replaces the file material", clayOn && Boolean(afterClay.clay), JSON.stringify(afterClay));

	await evaluate(`(() => {
		const input = document.querySelector('.inspector-scroll input[data-field="mesh-height"]');
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
		setter.call(input, "0.5");
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));
	})()`);
	await sleep(300);
	const resized = await evaluate(`(() => {
		const height = document.querySelector('.inspector-scroll input[data-field="mesh-height"]');
		return height ? Number(height.value) : null;
	})()`);
	expect("the inspector can set height to 0.5 m", resized !== null && Math.abs(resized - 0.5) < 0.02, JSON.stringify(resized));

	await evaluate("[...document.querySelectorAll('button')].find((button) => /^(Assets|에셋)$/.test(button.textContent.trim()))?.click()");
	const onShelf = await waitFor(
		"[...document.querySelectorAll('.assets-section-title, .asset-card-label')].some((node) => /My models|내 모델|unit-cube/.test(node.textContent))",
		{ timeoutMs: 8000 },
	);
	expect("the Assets tab lists the imported model under My models", onShelf);

	await sleep(600);
	await send("Page.reload");
	for (let i = 0; i < 150; i++) {
		await sleep(200);
		if (await evaluate("!!document.querySelector('canvas')").catch(() => false)) break;
	}
	for (let i = 0; i < 60 && !(await evaluate("!!window.__sceneHistory && document.querySelectorAll('.hierarchy-row').length > 0").catch(() => false)); i++) {
		await sleep(200);
	}
	await evaluate("[...document.querySelectorAll('.hierarchy-row')].find((row) => /Props|소품/.test(row.textContent))?.click()");
	const survived = await waitFor(
		`(() => {
			const named = [...document.querySelectorAll('.hierarchy-row')].some((row) => /unit-cube/.test(row.textContent));
			if (named) return true;
			const probe = ${sceneProbe};
			return !!(probe && (probe.imported || probe.clay));
		})()`,
		{ timeoutMs: 15000 },
	);
	expect("the mesh object comes back after a reload", survived);

	const { nodeId: objInput } = await send("DOM.querySelector", { nodeId: (await send("DOM.getDocument")).root.nodeId, selector: 'input[type=file][accept*=".obj"]' });
	expect("the set offers an OBJ import on the same control", Boolean(objInput));
	await send("DOM.setFileInputFiles", { nodeId: objInput, files: [objPath] });
	const objArrived = await waitFor(
		"[...document.querySelectorAll('.hierarchy-row')].filter((row) => /unit-cube/.test(row.textContent)).length >= 2",
		{ timeoutMs: 10000 },
	);
	expect("a picked OBJ becomes a second object in the set", objArrived);
	const objInspector = await evaluate(`(() => {
		const height = document.querySelector('.inspector-scroll input[data-field="mesh-height"]');
		const clay = document.querySelector('.inspector-scroll input[data-field="mesh-clay"]');
		return { height: height ? Number(height.value) : null, clay: clay ? clay.checked : null };
	})()`);
	expect("a fresh OBJ stands 1 m tall", objInspector.height !== null && Math.abs(objInspector.height - 1) < 0.02, JSON.stringify(objInspector));
	expect("a fresh OBJ has clay off", objInspector.clay === false, JSON.stringify(objInspector));
	const objDrawn = await waitFor(`(() => { const probe = ${sceneProbe}; return !!(probe && probe.objFile); })()`, { timeoutMs: 12000 });
	const objGraph = await evaluate(sceneProbe);
	expect("the OBJ file mesh is on stage, not the grey placeholder", objDrawn && objGraph.objFile, JSON.stringify(objGraph));

	await evaluate(`(() => {
		const input = document.querySelector('.inspector-scroll input[data-field="mesh-clay"]');
		if (!input) return;
		input.click();
	})()`);
	const objClayOn = await waitFor(`(() => { const probe = ${sceneProbe}; return !!(probe && probe.clay); })()`, { timeoutMs: 4000 });
	expect("turning clay on an OBJ replaces the default material", objClayOn);

	await sleep(600);
	await send("Page.reload");
	for (let i = 0; i < 150; i++) {
		await sleep(200);
		if (await evaluate("!!document.querySelector('canvas')").catch(() => false)) break;
	}
	for (let i = 0; i < 60 && !(await evaluate("!!window.__sceneHistory && document.querySelectorAll('.hierarchy-row').length > 0").catch(() => false)); i++) {
		await sleep(200);
	}
	// A reload lands with Props folded. Clicking the row selects the group
	// without opening it, so the two unit-cube names stay out of the DOM.
	const objSurvived = await waitFor(
		`(() => {
			const props = document.querySelector('.hierarchy-row-wrap[data-node-id="props"]');
			if (props?.getAttribute("aria-expanded") === "false") props.querySelector(".hierarchy-toggle")?.click();
			return [...document.querySelectorAll(".hierarchy-row")].filter((row) => /unit-cube/.test(row.textContent)).length >= 2;
		})()`,
		{ timeoutMs: 15000 },
	);
	expect("the OBJ object comes back after a reload next to the GLB", objSurvived, await evaluate(`(() => {
		const named = [...document.querySelectorAll(".hierarchy-row")].filter((row) => /unit-cube/.test(row.textContent)).map((row) => row.textContent.trim());
		const probe = ${sceneProbe};
		return JSON.stringify({ named, probe });
	})()`));

	const { nodeId: fbxInput } = await send("DOM.querySelector", { nodeId: (await send("DOM.getDocument")).root.nodeId, selector: 'input[type=file][accept*=".fbx"]' });
	expect("the set offers an FBX import on the same control", Boolean(fbxInput));
	await send("DOM.setFileInputFiles", { nodeId: fbxInput, files: [fbxPath] });
	const fbxArrived = await waitFor(
		`(() => {
			const props = document.querySelector('.hierarchy-row-wrap[data-node-id="props"]');
			if (props?.getAttribute("aria-expanded") === "false") props.querySelector(".hierarchy-toggle")?.click();
			return [...document.querySelectorAll(".hierarchy-row")].filter((row) => /unit-cube/.test(row.textContent)).length >= 3;
		})()`,
		{ timeoutMs: 10000 },
	);
	expect("a picked FBX becomes a third object in the set", fbxArrived);
	const fbxInspector = await evaluate(`(() => {
		const height = document.querySelector('.inspector-scroll input[data-field="mesh-height"]');
		const clay = document.querySelector('.inspector-scroll input[data-field="mesh-clay"]');
		return { height: height ? Number(height.value) : null, clay: clay ? clay.checked : null };
	})()`);
	expect("a fresh FBX stands 1 m tall", fbxInspector.height !== null && Math.abs(fbxInspector.height - 1) < 0.02, JSON.stringify(fbxInspector));
	expect("a fresh FBX has clay off", fbxInspector.clay === false, JSON.stringify(fbxInspector));
	const fbxDrawn = await waitFor(`(() => { const probe = ${sceneProbe}; return !!(probe && probe.fbxFile); })()`, { timeoutMs: 12000 });
	const fbxGraph = await evaluate(sceneProbe);
	expect("the FBX file mesh is on stage, not the grey placeholder", fbxDrawn && Boolean(fbxGraph.fbxFile) && fbxGraph.fbxFile.castShadow === true, JSON.stringify(fbxGraph.fbxFile));

	await evaluate(`(() => {
		const input = document.querySelector('.inspector-scroll input[data-field="mesh-clay"]');
		if (!input) return;
		input.click();
	})()`);
	const fbxClayOn = await waitFor(`(() => { const probe = ${sceneProbe}; return !!(probe && probe.clay) && !probe.fbxFile; })()`, { timeoutMs: 4000 });
	expect("turning clay on an FBX replaces the file material", fbxClayOn);

	await sleep(600);
	await send("Page.reload");
	for (let i = 0; i < 150; i++) {
		await sleep(200);
		if (await evaluate("!!document.querySelector('canvas')").catch(() => false)) break;
	}
	for (let i = 0; i < 60 && !(await evaluate("!!window.__sceneHistory && document.querySelectorAll('.hierarchy-row').length > 0").catch(() => false)); i++) {
		await sleep(200);
	}
	const fbxSurvived = await waitFor(
		`(() => {
			const props = document.querySelector('.hierarchy-row-wrap[data-node-id="props"]');
			if (props?.getAttribute("aria-expanded") === "false") props.querySelector(".hierarchy-toggle")?.click();
			return [...document.querySelectorAll(".hierarchy-row")].filter((row) => /unit-cube/.test(row.textContent)).length >= 3;
		})()`,
		{ timeoutMs: 15000 },
	);
	expect("the FBX object comes back after a reload next to the GLB and OBJ", fbxSurvived, await evaluate(`(() => {
		const named = [...document.querySelectorAll(".hierarchy-row")].filter((row) => /unit-cube/.test(row.textContent)).map((row) => row.textContent.trim());
		const probe = ${sceneProbe};
		return JSON.stringify({ named, probe });
	})()`));

	expect("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
} finally {
	ws.close();
}

if (failures) process.exit(1);
console.log("all mesh browser checks PASS");
