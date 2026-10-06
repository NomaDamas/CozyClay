const port = Number(process.env.CDP_PORT || 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("no page target on the QA browser");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.id && pending.has(message.id)) {
		const { resolve, reject } = pending.get(message.id);
		pending.delete(message.id);
		if (message.error) reject(new Error(JSON.stringify(message.error)));
		else resolve(message.result);
	}
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
	id += 1;
	pending.set(id, { resolve, reject });
	ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result?.value;
};
const waitFor = async (expression, ms = 60000) => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await evaluate(expression).catch(() => false)) return true;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return false;
};
if (!(await waitFor("!!(window.__cozyclay?.rigA && window.__cozyclay?.motion)"))) throw new Error("motion/rig never became ready");
await evaluate(`document.querySelector(".camera-tutorial-close")?.click()`);
await evaluate(`(() => {
	const target = [...document.querySelectorAll("button,[role=button]")].find((node) => /^Character 1(?:Cast)?$|^인물 1(?:인물)?$/.test(node.textContent.trim()));
	target?.click();
	return Boolean(target);
})()`);
await evaluate(`(() => {
	const target = [...document.querySelectorAll("button,[role=button]")].find((node) => /^Transform$|^변환$/.test(node.textContent.trim()));
	target?.click();
	return Boolean(target);
})()`);
if (!(await waitFor(`(() => [...document.querySelectorAll("input")].some((node) => /Position X|X/i.test(node.getAttribute("aria-label") || "") || /Position/.test(node.parentElement?.textContent || "")))()`))) {
	console.log(await evaluate(`JSON.stringify([...document.querySelectorAll("input")].map((node) => ({ aria: node.getAttribute("aria-label"), name: node.name, value: node.value, text: node.parentElement?.textContent?.trim().slice(0, 120) })))`));
	throw new Error("Position X input never became available");
}
const before = await evaluate(`(() => {
	const rig = window.__cozyclay.rigA;
	rig.updateMatrixWorld(true);
	let hips = null;
	rig.traverse((node) => { if (!hips && node.isBone && /hips/i.test(node.name)) hips = node; });
	return { rigX: rig.matrixWorld.elements[12], rigZ: rig.matrixWorld.elements[14], hipsX: hips?.matrixWorld.elements[12], frames: window.__cozyclay.motion.frames };
})()`);
const changed = await evaluate(`(() => {
	const input = [...document.querySelectorAll("input")].find((node) => node.parentElement?.textContent?.trim() === "X" && /PositionXYZ/.test(node.parentElement?.parentElement?.textContent || ""));
	if (!input) return false;
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
	input.focus();
	setter.call(input, "2");
	input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "2" }));
	input.dispatchEvent(new Event("change", { bubbles: true }));
	input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
	input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
	input.blur();
	return true;
})()`);
if (!changed) {
	console.log(await evaluate(`JSON.stringify([...document.querySelectorAll("input")].map((node) => ({ aria: node.getAttribute("aria-label"), value: node.value, parent: node.parentElement?.textContent?.trim().slice(0, 180), grand: node.parentElement?.parentElement?.textContent?.trim().slice(0, 220) })))`));
	throw new Error("Position X input not found");
}
if (!(await waitFor(`(() => {
	const rig = window.__cozyclay.rigA;
	rig.updateMatrixWorld(true);
	return Math.abs(rig.matrixWorld.elements[12] - 2) < 0.05;
})()`))) throw new Error("rig did not move to stage X=2");
const after = await evaluate(`(() => {
	const rig = window.__cozyclay.rigA;
	rig.updateMatrixWorld(true);
	let hips = null;
	rig.traverse((node) => { if (!hips && node.isBone && /hips/i.test(node.name)) hips = node; });
	return { rigX: rig.matrixWorld.elements[12], rigZ: rig.matrixWorld.elements[14], hipsX: hips?.matrixWorld.elements[12], frames: window.__cozyclay.motion.frames };
})()`);
if (after.frames !== before.frames || Math.abs((after.rigX - before.rigX) - 2) > 0.05 || Math.abs((after.hipsX - before.hipsX) - 2) > 0.05) {
	throw new Error(`stage transform mismatch: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
}
console.log(`PASS stage transform moves installed take: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
ws.close();
