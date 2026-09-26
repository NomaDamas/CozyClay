// Actual Studio render QA in an isolated profile; never touches the user's scene.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
const out = resolve(process.env.QA_OUT || ".omo/evidence/gvhmr-trajectory-20260905");
mkdirSync(out, { recursive: true });
const port = process.env.CDP_PORT || 9222;
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map(), errors = [];
ws.onmessage = ({ data }) => { const m = JSON.parse(data); if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails); if (m.method === "Page.javascriptDialogOpening" && m.params.type === "confirm" && m.params.message.includes("Discard unsaved changes and start a new project?")) void send("Page.handleJavaScriptDialog", { accept: true }); if (!pending.has(m.id)) return; const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); };
const send = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
const ev = async expression => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
const delay = ms => new Promise(r => setTimeout(r, ms));
const wait = async expr => { const limit = Date.now() + 60000; while (Date.now() < limit) { if (await ev(expr).catch(() => false)) return; await delay(100); } throw new Error(`Timeout ${expr}`); };
await send("Runtime.enable"); await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
// A fresh isolated profile must complete normal onboarding. A render behind
// the project chooser is NOT a valid visual comparison.
await send("Page.navigate", { url: "http://127.0.0.1:5180/app/" });
await wait("!!window.__cozyclay?.rigA");
if (await ev("!!document.querySelector('.project-browser.startup')")) {
	await ev("[...document.querySelectorAll('.project-browser button')].find(b=>b.textContent==='New Project')?.click()");
	await wait("!!document.querySelector('.project-name-dialog')");
	await ev("document.querySelector('.project-name-dialog').requestSubmit()");
	await wait("!document.querySelector('.project-browser-backdrop,.project-name-dialog-backdrop')");
}
const frames = (process.env.QA_FRAMES || "0,120,240,276,284,290,294,300,306,312,324,348").split(",").map(Number);
const models = (process.env.QA_MODELS || "x-bot-tpose,y-bot-tpose").split(",");
const variants = (process.env.QA_VARIANTS || "before,after").split(",");
for (const model of models) for (const variant of variants) {
	const motionUrl = `/@fs/${out}/${variant}.npz`;
	await send("Page.navigate", { url: `http://127.0.0.1:5180/app/?motion=${encodeURIComponent(motionUrl)}` });
	await wait(`!!window.__cozyclay?.rigA && window.__cozyclay?.motion?.frames===362 && window.__cozyclay.motion.url===${JSON.stringify(motionUrl)}`);
	if (await ev("!!document.querySelector('.project-browser-backdrop,.project-name-dialog-backdrop')")) throw new Error("Project dialog obstructs visual QA");
	await ev("window.__cozyclay.pause()");
	if (await ev("window.__cozyclay.characterModel") !== model) {
		await ev(`window.__qaOldRig=window.__cozyclay.rigA; window.__cozyclay.setCharacterModel(${JSON.stringify(model)})`);
		await wait("!!window.__cozyclay.rigA && window.__cozyclay.rigA !== window.__qaOldRig && !!window.__cozyclay.ikChains");
	}
	await delay(700);
	await ev("document.querySelector('.workflow-mode-switch [title=\"Edit timing and movement\"]')?.click()");
	await delay(150);
	await ev("(async()=>{window.__qaSurface=(await import('/src/ardy/physics-review.js')).createSupportSampler(window.__cozyclay.rigA)})()");
	await ev("document.querySelector('[aria-label=\"Collapse inset view\"]')?.click()");
	// Exclude the shot-camera overlay and transform gizmos, as exports do.
	// The character, floor and shadows remain visible and unmodified.
	await ev("(()=>{let s=window.__cozyclay.rigA;while(s.parent)s=s.parent;s.traverse(n=>{if(!n.isBone&&n.layers&&(n.layers.mask&32))n.visible=false;});})()");
	const samples = [];
	const inspect = async f => {
		await ev(`window.__cozyclay.scrub(${f})`); await wait(`window.__cozyclay.tlFrame===${f}`);
		return ev(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const c=window.__cozyclay,s=window.__qaSurface();const p=s.pelvis.position;c.frameEditorCam({x:p.x+3.5,y:1.8,z:p.z+4.2},{x:p.x,y:1.2,z:p.z});c.editorCam.layers.disable(5);resolve({frame:${f},root:p.toArray(),floor:Math.min(...Object.values(s).map(v=>v.floor)),support:Object.fromEntries(Object.entries(s).map(([k,v])=>[k,v.floor])),ikKeys:c.ik.keys.size,physicsPreview:!!c.physics.preview});})))`);
	};
	const sweep = process.env.QA_ALL_FRAMES ? Array.from({ length: 362 }, (_, i) => i) : frames;
	for (const f of sweep) {
		const sample = await inspect(f); samples.push(sample);
		if (frames.includes(f)) {
			// A fixed delay can capture the preceding camera on a slow render.
			await ev("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
			const clip = await ev("(()=>{const r=document.querySelector('.vp-main').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()");
			const shot = await send("Page.captureScreenshot", { format: "png", clip });
			writeFileSync(join(out, `${model}-${variant}-f${f}.png`), Buffer.from(shot.data, "base64"));
		}
	}
	writeFileSync(join(out, `${model}-${variant}${process.env.QA_PLAYBACK ? "-playback" : process.env.QA_CAPTURE_ONLY ? "-capture" : ""}-rendered.json`), JSON.stringify(samples, null, 2));
	console.log(JSON.stringify({ model, variant, frames: samples.length, minSurfaceY: Math.min(...samples.map(s => s.floor)), noPhysics: samples.every(s => !s.physicsPreview && !s.ikKeys) }));
	if (process.env.QA_PLAYBACK) {
		await inspect(264); await ev("document.activeElement?.blur()");
		await send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space" });
		await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space" });
		await wait("window.__cozyclay.playing");
		const began = performance.now(), progression = [];
		while (performance.now() - began < 6500) {
			const f = await ev("window.__cozyclay.tlFrame");
			progression.push({ wallSeconds: (performance.now() - began) / 1000, frame: f });
			if (f >= 336) break;
			await delay(100);
		}
		await ev("window.__cozyclay.pause()");
		writeFileSync(join(out, `${model}-${variant}-playback.json`), JSON.stringify(progression, null, 2));
		if (progression.at(-1).frame < 336) throw new Error("Playback did not traverse the fall interval");
	}
}
writeFileSync(join(out, process.env.QA_PLAYBACK ? "playback-errors.json" : "browser-errors.json"), JSON.stringify(errors, null, 2));
ws.close();
if (errors.length) process.exitCode = 1;
