import { mkdirSync, writeFileSync } from "node:fs";
const OUT = "/tmp/visual-qa-car"; mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function newTab() {
	const res = await fetch("http://127.0.0.1:9222/json/new?about:blank", { method: "PUT" });
	const target = await res.json();
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((res2, rej) => { ws.onopen = res2; ws.onerror = rej; });
	let id = 0; const pending = new Map();
	const errors = [];
	ws.onmessage = (event) => {
		const msg = JSON.parse(event.data);
		if (msg.id && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id);
			if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
		} else if (msg.method === "Runtime.exceptionThrown") {
			errors.push(msg.params.exceptionDetails.text + " " + (msg.params.exceptionDetails.exception?.description ?? ""));
		}
	};
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const msgId = ++id; pending.set(msgId, { resolve, reject });
		ws.send(JSON.stringify({ id: msgId, method, params }));
	});
	return { ws, send, errors };
}
async function evaluate(tab, expression) {
	const res = await tab.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
	return res.result.value;
}
async function shot(tab, name) {
	const res = await tab.send("Page.captureScreenshot", { format: "png" });
	writeFileSync(`${OUT}/${name}.png`, Buffer.from(res.data, "base64"));
	console.log(`saved ${OUT}/${name}.png`);
}
const tab = await newTab();
await tab.send("Page.enable"); await tab.send("Runtime.enable");
await tab.send("Network.enable");
await tab.send("Network.setCacheDisabled", { cacheDisabled: true });
await tab.send("Page.navigate", { url: "http://127.0.0.1:5180/app/?v=" + Date.now() });
await sleep(7000);
await shot(tab, "car-default-view");
// wide preset for a broader read of the set
await evaluate(tab, `(() => {
	const wide = [...document.querySelectorAll("button")].find(b => /^wide$/i.test(b.textContent.trim()));
	wide?.click(); return true;
})()`);
await sleep(900);
await shot(tab, "car-wide-view");
if (tab.errors.length) console.log("--- exceptions ---\n" + tab.errors.join("\n"));
tab.ws.close();
console.log("done");
