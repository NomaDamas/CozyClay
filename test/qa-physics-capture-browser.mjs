// Replay a numerically verified candidate through the app's normal IK player.
// This avoids another analysis when only camera framing/captures need repair.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const saved = JSON.parse(readFileSync(process.env.QA_CANDIDATE, "utf8"));
const expected = JSON.parse(readFileSync(process.env.QA_TRACKS, "utf8"));
const out = process.env.QA_OUT; if (!out) throw new Error("QA_OUT is required"); mkdirSync(out, { recursive: true });
const pages = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9222}/json`)).json();
const ws = new WebSocket(pages.find((p) => p.type === "page").webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = ({ data }) => { const m = JSON.parse(data); if (!pending.has(m.id)) return; const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); };
const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (test) => { const until = Date.now() + 60000; while (Date.now() < until) { if (await ev(test).catch(() => false)) return; await sleep(100); } throw new Error(`Timeout ${test}`); };
await send("Page.enable"); await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
await wait("!!window.__cozyclay?.rigA && !!window.__cozyclay?.motion && !!window.__cozyclay?.ikChains");
await ev("window.__cozyclay.pause()");
if (await ev("window.__cozyclay.characterModel") !== saved.model) {
	await ev(`window.__oldRig=window.__cozyclay.rigA;window.__cozyclay.setCharacterModel(${JSON.stringify(saved.model)})`);
	await wait("!!window.__cozyclay.rigA && window.__cozyclay.rigA!==window.__oldRig && window.__cozyclay.ik.rig===window.__cozyclay.rigA");
}
await sleep(250);
if (await ev("window.__cozyclay.motion.frames") !== saved.frames) throw new Error("Candidate/clip frame count mismatch");
await ev(`(()=>{const c=window.__cozyclay, b=c.ikChains.get('leftFoot').bones[0],V=b.position.constructor,Q=b.quaternion.constructor,s=${JSON.stringify(saved)};window.__qaReplay={keys:new Map(s.keys.map(([f,e])=>[f,new Map(e.map(([id,k])=>[id,{...k,q:k.q?.map(a=>new Q().fromArray(a))??null,p:k.p?new V().fromArray(k.p):null,baseQ:k.baseQ?.map(a=>new Q().fromArray(a)),basePos:k.basePos?new V().fromArray(k.basePos):undefined,chainP:k.chainP?.map(a=>new V().fromArray(a))}]))])),tracked:new Set(s.tracked)};document.querySelector('.workflow-mode-switch [title="Edit timing and movement"]')?.click();document.querySelector('[aria-label="Collapse inset view"]')?.click();})()`);
await ev("(async()=>{window.__qaSurface=(await import('/src/ardy/physics-review.js')).createSupportSampler(window.__cozyclay.rigA)})()");
const seek = async (f) => { await ev(`window.__cozyclay.scrub(${f})`); await wait(`window.__cozyclay.tlFrame===${f}`); await sleep(40); };
const pulse = async (f) => { await seek(f === saved.frames - 1 ? f - 1 : f + 1); await seek(f); await sleep(80); };
const hideGizmos = async () => ev("(()=>{let s=window.__cozyclay.rigA;while(s.parent)s=s.parent;s.traverse(n=>{if(!n.isBone && n.layers && (n.layers.mask & 32))n.visible=false;});})()");
const frames = [0, 18, 24, 38, 40, 42, 56, 66, 86, 120, 128, 129, 159, 176, 210, 226, 239, 245, 251, 253, 255, 265, 270, 282, 283, 330];
const evidence = [];
const clip = await ev("(()=>{const r=document.querySelector('.vp-main').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()");
for (const f of frames) {
	await ev("window.__cozyclay.ik.keys=new Map();window.__cozyclay.ik.tracked=new Set()"); await pulse(f);
	const framing = await ev("(()=>{const c=window.__cozyclay,p=[];c.rigA.traverse(b=>{if(b.isBone)p.push(b.getWorldPosition(b.position.clone()));});const lo={x:Math.min(...p.map(v=>v.x)),z:Math.min(...p.map(v=>v.z))},hi={x:Math.max(...p.map(v=>v.x)),y:Math.max(...p.map(v=>v.y)),z:Math.max(...p.map(v=>v.z))},t={x:(lo.x+hi.x)/2,y:hi.y/2,z:(lo.z+hi.z)/2},d=Math.max(1.4,(hi.y+.3)*1.5);return{target:t,position:{x:t.x+d*.617,y:t.y+d*.18,z:t.z+d*.787}}})()");
	let cameraBefore;
	for (const variant of ["before", "after"]) {
		await ev(`(()=>{const c=window.__cozyclay; c.ik.keys=${variant === "after" ? "window.__qaReplay.keys" : "new Map()"};c.ik.tracked=${variant === "after" ? "window.__qaReplay.tracked" : "new Set()"};c.frameEditorCam(${JSON.stringify(framing.position)},${JSON.stringify(framing.target)});})()`);
		await hideGizmos(); await pulse(f);
		const state = await ev("(()=>{const c=window.__cozyclay;return{frame:c.tlFrame,camera:[...c.editorCam.position.toArray(),...c.editorCam.quaternion.toArray(),c.editorCam.fov],surfaces:window.__qaSurface()}})()");
		const reference = expected[variant][f].support;
		const error = Math.max(...Object.keys(state.surfaces).map((s) => Math.abs(state.surfaces[s].floor - reference[s].floor)));
		if (error > .00001) throw new Error(`Replay differs from measured ${variant} F${f}: ${error}`);
		if (variant === "before") cameraBefore = state.camera;
		else if (Math.max(...state.camera.map((v, i) => Math.abs(v - cameraBefore[i]))) > 1e-9) throw new Error(`Camera mismatch F${f}`);
		const png = await send("Page.captureScreenshot", { format: "png", clip }); writeFileSync(`${out}/${variant}-f${f}.png`, Buffer.from(png.data, "base64"));
		evidence.push({ frame: f, variant, camera: state.camera, surfaceError: error });
	}
}
writeFileSync(`${out}/capture-checks.json`, JSON.stringify(evidence, null, 2));
console.log(`PASS ${evidence.length} captures: identical before/after cameras and verified skinned surfaces`);
ws.close();
