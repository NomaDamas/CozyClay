import { mkdirSync, writeFileSync } from "node:fs";

const out = process.env.QA_OUT || "/private/tmp/cozyclay-range-pin-qa";
mkdirSync(out, { recursive: true });
const pages = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9222}/json`)).json();
const page = pages.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
if (!page) throw new Error("QA browser exposed no page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
ws.onmessage = ({ data }) => {
	const message = JSON.parse(data);
	if (!pending.has(message.id)) return;
	const job = pending.get(message.id);
	pending.delete(message.id);
	message.error ? job.reject(new Error(JSON.stringify(message.error))) : job.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const requestId = ++id;
	pending.set(requestId, { resolve, reject });
	ws.send(JSON.stringify({ id: requestId, method, params }));
});
const ev = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
	return result.result.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = async (expression, timeout = 60000) => {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await ev(expression).catch(() => false)) return;
		await sleep(100);
	}
	throw new Error(`Timeout waiting for ${expression}`);
};

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await wait("!!window.__cozyclay?.motion && !!window.__cozyclay?.ikChains");

// Selectors follow App's workflow tabs, hierarchy-panel's tree items and the
// timeline IK toggle. Support both locales; wait for each actionable control.
const click = async (selector) => {
	await wait(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});return !!el && !el.disabled && el.getClientRects().length>0})()`);
	await ev(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});el.click()})()`);
};
const motionTab = '.workflow-mode-switch [role="tab"][title="Edit timing and movement"], .workflow-mode-switch [role="tab"][title="타이밍과 움직임 편집"]';
await click(motionTab);
await wait(`document.querySelector(${JSON.stringify(motionTab)})?.getAttribute('aria-selected') === 'true'`);
const characterRow = '[role="treeitem"][aria-selected="true"][data-node-id]';
await wait(`!!document.querySelector(${JSON.stringify(characterRow)})`);
const characterNodeId = await ev(`document.querySelector(${JSON.stringify(characterRow)}).dataset.nodeId`);
const rigRow = `[role="treeitem"][data-node-id="${characterNodeId}.rig"]`;
const characterSelector = `[role="treeitem"][data-node-id="${characterNodeId}"]`;
if (await ev(`document.querySelector(${JSON.stringify(characterSelector)})?.getAttribute('aria-expanded') === 'false'`)) {
	await click(`${characterSelector} > .hierarchy-toggle`);
}
await click(`${rigRow} > button.hierarchy-row`);
await wait(`document.querySelector(${JSON.stringify(rigRow)})?.getAttribute('aria-selected') === 'true'`);
if (!await ev('window.__cozyclay.ikMode')) {
	await click('[aria-label="Inverse kinematics"], [aria-label="역운동학"]');
}
await wait('window.__cozyclay.ikMode');
// Use the same framing command as the editor's F shortcut. The motion take
// can start with the character outside the viewport; evidence should show the
// rig, feet and range-pin marker rather than an empty floor.
await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "f", code: "KeyF", windowsVirtualKeyCode: 70 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "f", code: "KeyF", windowsVirtualKeyCode: 70 });
await sleep(400);
await click('[data-testid="range-pin-tool"]');
await wait('!!document.querySelector("[data-testid=range-pin-panel]")');
await wait("[...document.querySelectorAll('[data-testid=range-pin-panel] button')].some(el=>/왼발|Left Foot/i.test(el.textContent) && !el.disabled)");
await ev("[...document.querySelectorAll('[data-testid=range-pin-panel] button')].find(el=>/왼발|Left Foot/i.test(el.textContent)).click()");
for (const [selector, value] of [['[data-testid=range-pin-in]', 96], ['[data-testid=range-pin-out]', 107]]) {
	await wait(`!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`);
	// These are controlled React inputs. Focus/select followed by the browser's
	// insertion event exercises the same commit path as a real operator typing
	// the number; setting the DOM value alone bypasses React's value tracker.
	await ev(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.focus();el.select();})()`);
	await send("Input.insertText", { text: String(value) });
	await ev(`document.querySelector(${JSON.stringify(selector)})?.blur()`);
	await wait(`document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(String(value))}`);
}
await click('[data-testid="range-pin-apply"]');
await wait("(window.__cozyclay.rangePins||[]).length === 1");
await wait("window.__cozyclay.rangePins[0].endFrame === 107");
const pinState = await ev("({pin:window.__cozyclay.rangePins[0]})");
const pinHeader = await ev("(()=>{const rect=document.querySelector('.range-pin-panel-head > div')?.getBoundingClientRect();return rect ? {width:rect.width,height:rect.height} : null})()");
if (!pinHeader || pinHeader.width <= 200 || pinHeader.height >= 60) throw new Error(`Range pin header collapsed ${JSON.stringify(pinHeader)}`);
const samples = [];
for (const frame of [96, 99, 102, 105, 107]) {
	await ev(`window.__cozyclay.scrub(${frame})`);
	await wait(`window.__cozyclay.tlFrame===${frame}`);
	// Let the render loop pose the rig after React publishes the playhead.
	await ev('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
	await wait("Array.isArray(window.__cozyclay.rangePinEffector('leftFoot'))");
	samples.push({ frame, effector: await ev("window.__cozyclay.rangePinEffector('leftFoot')") });
}
const target = pinState.pin.target.position;
const distances = samples.map((sample) => ({ ...sample, distanceM: Math.hypot(sample.effector[0] - target[0], sample.effector[1] - target[1], sample.effector[2] - target[2]) }));
const maxDistanceM = Math.max(...distances.map((sample) => sample.distanceM));
if (!Number.isFinite(maxDistanceM) || maxDistanceM >= 0.001) throw new Error(`leftFoot pin drift ${maxDistanceM}`);
const screenshot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(`${out}/task-2-pin.png`, Buffer.from(screenshot.data, "base64"));
writeFileSync(`${out}/task-2-pin.json`, JSON.stringify({ route: "/app/?motion=/demo/walk-then-stop.npz", pin: pinState.pin, pinHeader, samples: distances, maxDistanceM, pass: true }, null, 2));
// Deliberately exceed limb reach through the production solver seam; the
// actual inspector must show a warning and the rendered rig must stay finite.
await click('.range-pin-delete');
await wait("window.__cozyclay.rangePins.length===0");
await wait("![...document.querySelectorAll('.range-pin-validation,[role=alert]')].some(el=>/overlapping pin|겹치는 고정/.test(el.textContent))");
await wait("typeof window.__cozyclay.rangePinApplySpec === 'function'");
const reach = await ev(`(()=>{const pin={...${JSON.stringify(pinState.pin)},id:'qa-unreachable',reach:'limb',target:{space:'world',position:[999,999,999]}}; const result=window.__cozyclay.rangePinApplySpec(pin);return {pin,residuals:result.residuals}})()`);
await wait("!!document.querySelector('.range-pin-warning')");
const warning = await ev("document.querySelector('.range-pin-warning').textContent");
const finite = await ev("(()=>{let finite=true;window.__cozyclay.rigA.traverse(b=>{if(b.isBone) finite&&=[...b.position.toArray(),...b.quaternion.toArray()].every(Number.isFinite)});return finite})()");
if (!finite || !reach.residuals.every(entry => Number.isFinite(entry.errorM)) || !reach.residuals.some(entry => entry.errorM > .01)) throw new Error('Unreachable pin must retain finite residuals and warn');
writeFileSync(`${out}/task-2-pin-reach.json`, JSON.stringify({ ...reach, warning, finite, pass:true }, null, 2));
const reachScreenshot=await send("Page.captureScreenshot", {format:"png"});
writeFileSync(`${out}/task-2-pin-reach.png`,Buffer.from(reachScreenshot.data,"base64"));
console.log(`PASS range pin browser QA · max drift ${maxDistanceM.toFixed(6)} m`);
ws.close();
