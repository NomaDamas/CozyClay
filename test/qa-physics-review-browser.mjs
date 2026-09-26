import { mkdirSync, writeFileSync } from "node:fs";
const out = process.env.QA_OUT || "/tmp/cozyclay-physics-review";
mkdirSync(out, { recursive: true });
const pages = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9222}/json`)).json();
const ws = new WebSocket(pages.find((p) => p.type === "page").webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0; const pending = new Map(), errors = [];
ws.onmessage = ({ data }) => {
	const m = JSON.parse(data);
	if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
	if (!m.id || !pending.has(m.id)) return;
	const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); ws.send(JSON.stringify({ id: key, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (expr, timeout = 60000) => { const until = Date.now() + timeout; while (Date.now() < until) { if (await ev(expr).catch(() => false)) return; await sleep(100); } throw new Error(`Timeout: ${expr}\n${await ev("document.body.innerText.slice(-2000)")}`); };
const click = async (selector) => {
	await ev(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`); await sleep(100);
	const rect = await ev(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e || e.disabled) return null; const r=e.getBoundingClientRect(); return r.width && r.height ? {x:r.x+r.width/2,y:r.y+r.height/2}:null; })()`);
	if (!rect) throw new Error(`Not clickable: ${selector}`);
	await send("Input.dispatchMouseEvent", { type: "mousePressed", ...rect, button: "left", clickCount: 1 });
	await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...rect, button: "left", clickCount: 1 }); await sleep(100);
};
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${out}/${name}.png`, Buffer.from(r.data, "base64")); };
await send("Runtime.enable"); await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
await wait("!!window.__cozyclay?.motion && !!window.__cozyclay?.rigA && !!window.__cozyclay?.physics");
await ev("window.__cozyclay.pause()"); await sleep(500);
if (process.env.MODEL && await ev("window.__cozyclay.characterModel") !== process.env.MODEL) {
	await ev(`window.__qaOldRig = window.__cozyclay.rigA; window.__cozyclay.setCharacterModel(${JSON.stringify(process.env.MODEL)})`);
	await wait("!!window.__cozyclay.rigA && window.__cozyclay.rigA !== window.__qaOldRig && !!window.__cozyclay.ikChains"); await sleep(500);
}
// Open the actual hierarchy control, then click the actual analysis button.
const rigSelector = await ev(`(() => { const es=[...document.querySelectorAll('[data-node-id]')]; return es.map(e=>({id:e.getAttribute('data-node-id'),text:e.textContent})); })()`);
console.log("hierarchy", JSON.stringify(rigSelector));
await ev(`(() => { const buttons=[...document.querySelectorAll('button')]; const b=buttons.find(e=>e.textContent.trim()==='Rig' || e.textContent.trim()==='리그'); if(b) b.click(); })()`);
await sleep(200);
if (!await ev("!!document.querySelector('[data-testid=physics-analyse]')?.getBoundingClientRect().width")) {
	console.log(await ev("[...document.querySelectorAll('button')].filter(e=>/Rig|rig|리그/.test(e.textContent+' '+e.getAttribute('aria-label'))).map(e=>({text:e.textContent,html:e.outerHTML.slice(0,400)}))"));
	await shot("unavailable"); throw new Error("Rig control not visible");
}
if (process.env.QA_UI_ONLY) {
	const checks = [], check = (name, pass) => { checks.push({ name, pass: !!pass }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`); };
	const snap = () => ev("(()=>{const a=[];window.__cozyclay.rigA.traverse(b=>{if(b.isBone)a.push(...b.position.toArray(),...b.quaternion.toArray())});return a})()");
	const form = (label, value) => ev(`(()=>{const e=document.querySelector('[aria-label="${label}"]');Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
	await ev("window.__cozyclay.scrub(86)"); await wait("window.__cozyclay.tlFrame===86"); await sleep(100);
	const original = await snap();
	await click('.physics-review details summary'); await click('[data-testid="physics-protect"]');
	await form("Support point", "leftHand"); await form("Contact mode", "free"); await form("First frame", 166); await form("Last frame", 167); await click('[data-testid="physics-add-contact"]');
	await form("Support point", "leftKnee"); await form("Contact mode", "plant"); await form("First frame", 245); await form("Last frame", 250); await click('[data-testid="physics-add-contact"]');
	await ev("document.querySelector('[data-testid=physics-panel]').scrollIntoView({block:'start'})"); await shot("controls");
	await click('[data-testid="physics-analyse"]'); await wait("!window.__cozyclay.physics.running && !!window.__cozyclay.physics.preview", 360000);
	const protectedPose = await snap(); check("Protected pose is unchanged in rendered preview", Math.max(...original.map((v, i) => Math.abs(v - protectedPose[i]))) < 1e-6);
	check("Hand/knee contact controls override detection", await ev("!window.__cozyclay.physics.preview.contacts.masks[166].has('leftHand') && window.__cozyclay.physics.preview.contacts.masks[245].get('leftKnee')?.manual===true"));
	await click('[data-testid="physics-cancel"]'); check("Cancel preserves source keys", await ev("window.__cozyclay.ik.keys.size===0"));
	await ev("document.querySelector('[data-testid=physics-strength]').scrollIntoView({block:'center'})"); await sleep(100);
	const r = await ev("(()=>{const r=document.querySelector('[data-testid=physics-strength]').getBoundingClientRect();return{x:r.x+1,y:r.y+r.height/2}})()");
	await send("Input.dispatchMouseEvent", {type:"mousePressed",...r,button:"left",clickCount:1}); await send("Input.dispatchMouseEvent", {type:"mouseReleased",...r,button:"left",clickCount:1});
	await wait("window.__cozyclay.physics.options.strength===0", 5000);
	await click('[data-testid="physics-analyse"]'); await wait("!window.__cozyclay.physics.running && !!window.__cozyclay.physics.preview", 360000);
	const zero = await snap(); check("Zero strength is the original and Apply is disabled", await ev("window.__cozyclay.physics.preview.strength===0 && window.__cozyclay.physics.preview.changedFrames.length===0 && document.querySelector('[data-testid=physics-apply]').disabled") && Math.max(...original.map((v, i) => Math.abs(v - zero[i]))) < 1e-6);
	writeFileSync(`${out}/checks-options.json`, JSON.stringify(checks, null, 2)); ws.close(); process.exit(checks.some((c) => !c.pass) ? 1 : 0);
}
await click('[data-testid="physics-analyse"]');
await wait("!window.__cozyclay.physics.running && !!window.__cozyclay.physics.preview", 360000);
const summary = await ev(`(() => {const p=window.__cozyclay.physics.preview;return {model:window.__cozyclay.characterModel,frames:p.motion.frames,before:p.before,after:p.after,warnings:p.warnings,unresolved:p.unresolved,contacts:p.contacts.spans,skippedAir:p.skippedAir,changedFrames:p.changedFrames.length,sourceKeys:window.__cozyclay.ik.keys.size};})()`);
console.log(JSON.stringify({ ...summary, unresolved: summary.unresolved.length, contacts: summary.contacts.length }, null, 2)); writeFileSync(`${out}/metrics.json`, JSON.stringify(summary, null, 2));
writeFileSync(`${out}/tracks.json`, JSON.stringify(await ev("({before:window.__cozyclay.physics.preview.samples,after:window.__cozyclay.physics.preview.evaluated})")));
writeFileSync(`${out}/replay-errors.json`, JSON.stringify(await ev("window.__cozyclay.physics.preview.replayErrors")));
await ev("document.querySelector('[data-testid=physics-results]').scrollIntoView({block:'center'})"); await sleep(200); await shot("panel");
if (process.env.QA_FULL) {
	const checks = [];
	const check = (name, condition, detail) => { checks.push({ name, pass: !!condition, detail }); console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`); };
	check("Preview does not write source keys", summary.sourceKeys === 0);
	check("Actual surfaces and temporal continuity meet the review limits", summary.after.penetration <= .005 && summary.after.slide <= .015 && summary.after.float <= .025 && summary.after.kneeAcceleration <= summary.before.kneeAcceleration * 1.1 && summary.after.rootAcceleration <= summary.before.rootAcceleration * 1.1);
	// Camera/framing only. The same original-root reference is used for both
	// variants; no image modification is used to conceal mesh penetration.
	await ev("document.querySelector('[aria-label=\"Collapse inset view\"]')?.click()");
	await click('.workflow-mode-switch [title="Edit timing and movement"]');
	await ev(`([...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Rig' || e.textContent.trim()==='리그'))?.click()`); await sleep(100);
	const selectFrame = async (f) => { await ev(`window.__cozyclay.scrub(${f})`); await wait(`window.__cozyclay.tlFrame===${f}`); await sleep(60); };
	const frames = [...new Set([0, 42, 86, 120, 159, 176, 210, 226, 245, 270, 283, 330, ...summary.warnings.map((w) => w.frame)])].sort((a, b) => a - b);
	const clip = await ev("(() => {const r=document.querySelector('.vp-main').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1};})()");
	for (const f of frames) {
		await selectFrame(f); await click('[data-testid="physics-original"]');
		await ev(`(() => {const c=window.__cozyclay, points=[];c.rigA.traverse(b=>{if(b.isBone)points.push(b.getWorldPosition(b.position.clone()));});const lo={x:Math.min(...points.map(p=>p.x)),y:0,z:Math.min(...points.map(p=>p.z))},hi={x:Math.max(...points.map(p=>p.x)),y:Math.max(...points.map(p=>p.y)),z:Math.max(...points.map(p=>p.z))};const p={x:(lo.x+hi.x)/2,y:hi.y/2,z:(lo.z+hi.z)/2};const d=Math.max(1.4,(hi.y+.3)*1.5);c.frameEditorCam({x:p.x+d*.617,y:p.y+d*.18,z:p.z+d*.787},p);})()`); await sleep(100);
		// Same layer exclusion as video export: hide camera/transform gizmos,
		// never the character mesh, floor, contacts, or shadows.
		await ev("window.__cozyclay.editorCam.layers.disable(5)"); await sleep(80);
		await ev("(()=>{let s=window.__cozyclay.rigA;while(s.parent)s=s.parent;s.traverse(n=>{if(!n.isBone && n.layers && (n.layers.mask & 32))n.visible=false;});})()");
		// An on-demand viewport does not redraw for a bare camera mutation.
		await selectFrame(f === summary.frames - 1 ? f - 1 : f + 1); await selectFrame(f);
		let r = await send("Page.captureScreenshot", { format: "png", clip }); writeFileSync(`${out}/before-f${f}.png`, Buffer.from(r.data, "base64"));
		await click('[data-testid="physics-corrected"]'); await sleep(100);
		await ev("window.__cozyclay.editorCam.layers.disable(5)"); await sleep(80);
		r = await send("Page.captureScreenshot", { format: "png", clip }); writeFileSync(`${out}/after-f${f}.png`, Buffer.from(r.data, "base64"));
	}
	// Read the live rendered skeleton, independently of the solver's saved
	// samples. This catches preview/evaluation and asynchronous-frame errors.
	await ev("(async()=>{window.__qaSurface=(await import('/src/ardy/physics-review.js')).createSupportSampler(window.__cozyclay.rigA)})()");
	let playbackError = 0;
	for (let f = 0; f < summary.frames; f += 1) {
		await selectFrame(f);
		playbackError = Math.max(playbackError, await ev(`(() => {const a=window.__qaSurface(),b=window.__cozyclay.physics.preview.evaluated[${f}].support;return Math.max(...Object.keys(a).map(k=>Math.abs(a[k].floor-b[k].floor)));})()`));
	}
	check("All rendered frames match the measured candidate surfaces", playbackError < 1e-5, playbackError);
	if (process.env.QA_FULL === "images") {
		writeFileSync(`${out}/checks.json`, JSON.stringify(checks, null, 2)); ws.close(); process.exit(checks.some((c) => !c.pass) ? 1 : 0);
	}
	const snapshot = () => ev("(() => { const out=[];window.__cozyclay.rigA.traverse(b=>{if(b.isBone)out.push(...b.position.toArray(),...b.quaternion.toArray());});return out;})()");
	await selectFrame(86); const previewPose = await snapshot();
	await click('[data-testid="physics-apply"]'); await sleep(100);
	check("Apply creates the reviewed key layer", await ev("window.__cozyclay.ik.keys.size") > 0);
	const appliedPose = await snapshot(); check("Apply exactly matches preview", Math.max(...previewPose.map((v, i) => Math.abs(v - appliedPose[i]))) < 1e-6);
	await send("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", modifiers: 4 });
	await send("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", modifiers: 4 }); await sleep(200);
	check("Undo restores source keys", await ev("window.__cozyclay.ik.keys.size") === 0);
	await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Z", code: "KeyZ", modifiers: 12 });
	await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Z", code: "KeyZ", modifiers: 12 }); await sleep(200);
	const redonePose = await snapshot(); check("Redo preserves bases, tilt and limb translations", Math.max(...previewPose.map((v, i) => Math.abs(v - redonePose[i]))) < 1e-6);
	await send("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", modifiers: 4 });
	await send("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", modifiers: 4 }); await sleep(200);
	// Protect a pose through the user-facing control.
	await click('.physics-review details summary'); await click('[data-testid="physics-protect"]');
	const formValue = async (label, value) => ev(`(()=>{const e=document.querySelector('[aria-label="${label}"]');const prototype=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
	await formValue("Support point", "leftHand"); await formValue("Contact mode", "free");
	await formValue("First frame", 166); await formValue("Last frame", 167); await click('[data-testid="physics-add-contact"]');
	await formValue("Support point", "leftKnee"); await formValue("Contact mode", "plant");
	await formValue("First frame", 245); await formValue("Last frame", 250); await click('[data-testid="physics-add-contact"]');
	await ev("document.querySelector('[data-testid=physics-panel]').scrollIntoView({block:'start'})"); await shot("controls");
	const protectedBefore = await snapshot(); await click('[data-testid="physics-analyse"]');
	await wait("!window.__cozyclay.physics.running && !!window.__cozyclay.physics.preview", 360000);
	const protectedAfter = await snapshot(); check("Protected pose is unchanged in the rendered preview", Math.max(...protectedBefore.map((v, i) => Math.abs(v - protectedAfter[i]))) < 1e-6);
	check("Contact form overrides the detected hand/knee intervals", await ev("!window.__cozyclay.physics.preview.contacts.masks[166].has('leftHand') && window.__cozyclay.physics.preview.contacts.masks[245].get('leftKnee')?.manual===true"));
	await click('[data-testid="physics-cancel"]'); check("Cancel leaves original key layer untouched", await ev("window.__cozyclay.ik.keys.size") === 0);
	// Click the real slider's minimum; synthetic Home is platform-dependent.
	await ev("document.querySelector('[data-testid=physics-strength]').scrollIntoView({block:'center'})"); await sleep(100);
	const minPoint = await ev("(()=>{const r=document.querySelector('[data-testid=physics-strength]').getBoundingClientRect();return{x:r.x+1,y:r.y+r.height/2}})()");
	await send("Input.dispatchMouseEvent", { type: "mousePressed", ...minPoint, button: "left", clickCount: 1 });
	await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...minPoint, button: "left", clickCount: 1 });
	await wait("window.__cozyclay.physics.options.strength===0", 5000);
	await click('[data-testid="physics-analyse"]'); await wait("!window.__cozyclay.physics.running && !!window.__cozyclay.physics.preview", 360000);
	check("Zero strength preserves the source and disables Apply", await ev("window.__cozyclay.physics.preview.strength===0 && window.__cozyclay.physics.preview.changedFrames.length===0 && document.querySelector('[data-testid=physics-apply]').disabled"));
	writeFileSync(`${out}/checks.json`, JSON.stringify(checks, null, 2));
	if (checks.some((c) => !c.pass)) process.exitCode = 1;
}
if (errors.length) { console.error(errors); process.exitCode = 1; }
ws.close();
