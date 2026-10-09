#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { cameraBrowser } from "./camera-browser-harness.mjs";

const outputDir = process.env.QA_OUT || "/Users/yun/CozyClay/.omo/evidence/previs-modes/previs-modes-w2a/shots";
mkdirSync(outputDir, { recursive: true });
const b = await cameraBrowser();
const errors = [];
// A separate observer leaves the shared harness's CDP response handler intact.
const targets = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9631}/json`)).json();
const target = targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
const observer = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { observer.onopen = resolve; observer.onerror = reject; });
observer.onmessage = event => {
	const message = JSON.parse(event.data);
	if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
	if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") errors.push(message.params.args.map(arg => arg.value ?? arg.description).join(" "));
};
observer.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));

try {
	await b.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
	await b.seed();
	await b.navigate(process.env.QA_URL || "http://127.0.0.1:5211/app/?previs=1");
	await b.ready();
	// Use the mounted AppContext provider, not a second command bus.
	await b.evaluate(`(() => {
		const element = document.querySelector('.app');
		let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber'))];
		while (fiber && !fiber.memoizedProps?.value?.bus) fiber = fiber.return;
		if (!fiber) throw new Error('AppContext provider not found');
		const context = fiber.memoizedProps.value;
		window.__proxyBus = { bus: context.bus, get characters() { return context.live.characters; } };
	})()`);
	await b.change("!!document.querySelector('[data-node-id=\"characterB\"]')", () => b.evaluate(`window.__proxyBus.bus.run('character.add', { character: { id: 'qa-proxy', model: 'proxy-figure', tint: '#cf946e', posture: 'stand', x: 0, z: 0, rot: 0 } })`));
	assert.equal(await b.evaluate("window.__proxyBus.characters.find(c => c.id === 'qa-proxy')?.model"), "proxy-figure");
	await b.evaluate(`(() => {
		const canvas = document.querySelector('canvas');
		window.__proxyScene = canvas.__r3f?.root?.getState?.().scene;
	})()`);
	if (!await b.evaluate("!!window.__proxyScene")) {
		await b.evaluate(`(async () => {
			const { _roots } = await import('/node_modules/.vite/deps/@react-three_fiber.js');
			window.__proxyScene = _roots.get(document.querySelector('canvas')).store.getState().scene;
		})()`);
	}
	await b.evaluate(`(async () => {
		const THREE = await import('/node_modules/.vite/deps/three.js');
		window.__proxyThree = THREE;
		window.__proxyRoot = () => {
			let found;
			window.__proxyScene.traverse(node => { if (node.userData.characterPick === 'B') found = node; });
			return found;
		};
		window.__proxyBounds = () => {
			const root = window.__proxyRoot();
			root.updateWorldMatrix(true, true);
			const box = new THREE.Box3().setFromObject(root);
			return { height: box.max.y - box.min.y, minY: box.min.y, maxZ: box.max.z, minZ: box.min.z };
		};
	})()`);
	assert.ok(await b.evaluate("!!window.__proxyRoot()"), "proxy pick root exists");
	assert.equal(await b.evaluate(`(() => { let meshes = 0; window.__proxyRoot().traverse(n => { if (n.isMesh) meshes++; }); return meshes; })()`), 3, "body, head, and facing wedge render");
	await b.evaluate(`window.__proxyBus.bus.run('character.update', { characterId: 'char-a', patch: { hidden: true } })`);
	await b.click('[data-node-id="camera"]');
	await b.evaluate("window.__cozyclay.frameEditorCam({x: 2.2, y: 1.8, z: 3}, {x: 0, y: 0.8, z: 0})");
	const point = await b.evaluate(`(() => {
		const p = new window.__proxyThree.Vector3(0, 0.7, 0).project(window.__cozyclay.editorCam);
		const r = window.__cozyclay.mainPane.getBoundingClientRect();
		return { x: r.left + (p.x + 1) * r.width / 2, y: r.top + (1 - p.y) * r.height / 2 };
	})()`);
	await b.change("document.querySelector('[data-node-id=\"characterB\"]')?.getAttribute('aria-selected') === 'true' || document.querySelector('[data-node-id=\"characterB\"]')?.classList.contains('selected')", async () => {
		await b.mouse("mousePressed", { ...point, button: "left", buttons: 1, clickCount: 1 });
		await b.mouse("mouseReleased", { ...point, button: "left", buttons: 0, clickCount: 1 });
	});
	console.log("PASS clicking proxy mesh selects characterB row");
	await b.arm("window.__characterGizmoHandles?.().some(h => h.axis === 'x')");
	await b.settled();
	for (const axis of ["x", "z"]) {
		const before = await b.evaluate(`window.__proxyBus.characters.find(c => c.id === 'qa-proxy').${axis}`);
		const handle = await b.evaluate(`window.__characterGizmoHandles().find(h => h.axis === '${axis}')`);
		await b.change(`Math.abs(window.__proxyBus.characters.find(c => c.id === 'qa-proxy').${axis} - ${before}) > 0.01`, async () => {
			await b.mouse("mousePressed", { x: handle.x, y: handle.y, button: "left", buttons: 1 });
			for (let tick = 1; tick <= 8; tick++) {
				await b.mouse("mouseMoved", { x: handle.x + tick * 8, y: handle.y + tick * 2, button: "left", buttons: 1 });
			}
			await b.mouse("mouseReleased", { x: handle.x + 64, y: handle.y + 16, button: "left", buttons: 0 });
		});
		await b.change(`Math.abs(window.__proxyBus.characters.find(c => c.id === 'qa-proxy').${axis} - ${before}) < 1e-6`, async () => {
			const key = { key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: process.platform === "darwin" ? 4 : 2 };
			await b.send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
			await b.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
		});
		console.log(`PASS ${axis} gizmo drag changes placement; Cmd/Ctrl+Z restores`);
	}
	for (const posture of ["stand", "sit", "lie"]) {
		await b.change(`window.__proxyBus.characters.find(c => c.id === 'qa-proxy').posture === '${posture}'`, () =>
			b.evaluate(`window.__proxyBus.bus.run('character.update', { characterId: 'qa-proxy', patch: { posture: '${posture}' } })`));
		await b.evaluate(posture === "lie"
			? "window.__cozyclay.frameEditorCam({x: 2.4, y: 1.4, z: 3.0}, {x: 0, y: 0.25, z: 0})"
			: "window.__cozyclay.frameEditorCam({x: 2.6, y: 1.6, z: 3.2}, {x: 0, y: 0.6, z: 0})");
		await b.settled();
		const bounds = await b.evaluate("window.__proxyBounds()");
		if (posture === "stand") assert.ok(Math.abs(bounds.height - 1.7) < 0.01);
		if (posture === "sit") assert.ok(bounds.height < 1.2 && bounds.height > 1);
		if (posture === "lie") assert.ok(bounds.height < 0.5, JSON.stringify(bounds));
		const plate = await b.evaluate(`(() => {
			const c = window.__cozyclay;
			const camera = c.editorCam;
			return c.captureFraming({
				pos: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
				yaw: camera.rotation.y,
				pitch: camera.rotation.x,
				fovDeg: camera.fov,
			});
		})()`);
		const path = `${outputDir}/proxy-figure-${posture}.png`;
		writeFileSync(path, Buffer.from(plate.split(",")[1], "base64"));
		console.log(`PASS ${posture} bounds ${JSON.stringify(bounds)}; QA_SCREENSHOT ${path}`);
	}
	await b.change("window.__proxyBus.characters.find(c => c.id === 'qa-proxy').posture === 'stand'", () =>
		b.evaluate("window.__proxyBus.bus.run('character.update', { characterId: 'qa-proxy', patch: { posture: 'unknown' } })"));
	assert.ok(await b.evaluate("!!window.__proxyRoot()"));
	assert.equal(errors.length, 0, errors.join("\n"));
	console.log("PASS unknown posture normalizes to stand; figure still renders; zero page/console errors");
	const shot = await b.send("Page.captureScreenshot", { format: "png" });
	writeFileSync(`${outputDir}/task-5-previs-modes.png`, Buffer.from(shot.data, "base64"));
	console.log(`QA_SCREENSHOT ${outputDir}/task-5-previs-modes.png`);
} finally {
	observer.close();
	b.close();
}
