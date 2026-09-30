import { mkdirSync, writeFileSync } from "node:fs";

const out = process.env.QA_OUT || "/tmp/cozyclay-qa-platform-fit";
mkdirSync(out, { recursive: true });
const pages = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9222}/json`)).json();
const page = pages.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("No Chrome page target");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
const runtimeExceptions = [];
const consoleErrors = [];
ws.onmessage = ({ data }) => {
	const message = JSON.parse(data);
	if (message.method === "Runtime.exceptionThrown") {
		runtimeExceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
	}
	if (message.method === "Runtime.consoleAPICalled" && (message.params.type === "error" || message.params.type === "assert")) {
		consoleErrors.push(message.params.args?.map((arg) => arg.value ?? arg.description ?? "").join(" ") || message.params.type);
	}
	if (!message.id || !pending.has(message.id)) return;
	const promise = pending.get(message.id);
	pending.delete(message.id);
	if (message.error) promise.reject(new Error(JSON.stringify(message.error)));
	else promise.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const requestId = ++id;
	pending.set(requestId, { resolve, reject });
	ws.send(JSON.stringify({ id: requestId, method, params }));
});
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
	return result.result.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = async (expression, timeout = 60000) => {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await evaluate(expression).catch(() => false)) return;
		await sleep(100);
	}
	throw new Error(`Timeout waiting for ${expression}`);
};
const click = async (selector) => {
	await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`);
	const rect = await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if (!e || e.disabled) return null; const r=e.getBoundingClientRect(); return r.width && r.height ? {x:r.x+r.width/2,y:r.y+r.height/2} : null; })()`);
	if (!rect) throw new Error(`Not clickable: ${selector}`);
	await send("Input.dispatchMouseEvent", { type: "mousePressed", ...rect, button: "left", clickCount: 1 });
	await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...rect, button: "left", clickCount: 1 });
};
const screenshot = async (name) => {
	const result = await send("Page.captureScreenshot", { format: "png" });
	writeFileSync(`${out}/${name}.png`, Buffer.from(result.data, "base64"));
};
const scrub = async (frame) => {
	await evaluate(`window.__cozyclay.scrub(${Math.round(frame)})`);
	await wait(`window.__cozyclay.tlFrame===${Math.round(frame)}`, 10000);
	await sleep(25);
};
const sample = async () => evaluate(`(async()=>{
	const c=window.__cozyclay;
	const sampler=(window.__qaSupportSampler ||= (await import('/src/ardy/physics-review.js')).createSupportSampler(c.rigA));
	const support=sampler();
	const feet={};
	for(const id of ['leftFoot','rightFoot']){
		const chain=c.ikChains?.get(id);
		const toe=chain?.bones?.[2];
		const p=toe?.getWorldPosition(toe.position.clone());
		feet[id]={sole:support[id]?.floor ?? null,toe:p?{x:p.x,y:p.y,z:p.z}:null};
	}
	const hips=c.rigA?.userData?.hips || [...(c.rigA?.children||[])].find(b=>b.name?.includes('Hips'));
	let pelvis=null;
	if(c.ikChains?.get('leftFoot')?.bones?.[0]) { const hip=c.ikChains.get('leftFoot').bones[0]; pelvis=hip.getWorldPosition(hip.position.clone()); }
	return {frame:c.tlFrame,feet,pelvis:pelvis?{x:pelvis.x,y:pelvis.y,z:pelvis.z}:null};
})()`);
const rawSamples = [];
const checks = [];
const check = (name, pass, detail = "") => {
	const record = { name, pass: !!pass, detail };
	checks.push(record);
	console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

await send("Runtime.enable");
await send("Page.enable");
await send("Log.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
await wait("!!window.__cozyclay?.motion && !!window.__cozyclay?.rigA && !!window.__cozyclay?.platformFit", 120000);
await evaluate("window.__cozyclay.pause()");
const motionInfo = await evaluate("({frames:window.__cozyclay.motion.frames,fps:window.__cozyclay.motion.fps,model:window.__cozyclay.characterModel})");
console.log("motion", JSON.stringify(motionInfo));

// Establish the unmodified walk and choose a later-footstep region from the
// actual rendered toe trajectories, rather than assuming the walk axis.
for (let frame = 0; frame < motionInfo.frames; frame += 1) {
	await scrub(frame);
	rawSamples.push(await sample());
}
const later = rawSamples.slice(Math.floor(rawSamples.length * 0.55));
const finiteToes = later.flatMap((row) => Object.values(row.feet).map((foot) => foot.toe).filter(Boolean));
const boxCenter = {
	x: finiteToes.reduce((sum, point) => sum + point.x, 0) / finiteToes.length,
	z: finiteToes.reduce((sum, point) => sum + point.z, 0) / finiteToes.length,
};
const sourceHeights = rawSamples.map((row) => ({ frame: row.frame, leftFoot: row.feet.leftFoot.sole, rightFoot: row.feet.rightFoot.sole, pelvis: row.pelvis?.y ?? null }));
// main's QA surface places objects through the owned object.add command and
// returns the created id (src/App.jsx sceneObject.place).
const objectId = await evaluate(`window.__cozyclay.sceneObject.place({ kind: 'cube', x: ${boxCenter.x}, z: ${boxCenter.z} }).id`);
if (!objectId) throw new Error("addSceneObject did not return an id");
await evaluate(`window.__cozyclay.sceneObject.update({ id: ${JSON.stringify(objectId)}, scaleY: 0.2 })`);
await wait(`window.__cozyclay.objects.some(o=>o.id===${JSON.stringify(objectId)} && Math.abs(o.height*o.scaleY-0.2)<1e-9)`);
console.log("box", JSON.stringify(await evaluate(`window.__cozyclay.objects.find(o=>o.id===${JSON.stringify(objectId)})`)));
await evaluate(`(()=>{const row=[...document.querySelectorAll('[role=treeitem][data-node-id]')].find(e=>/\.rig$/.test(e.dataset.nodeId)); if(row && row.getAttribute('aria-expanded')==='false') row.querySelector('.hierarchy-toggle')?.click(); row?.querySelector('button.hierarchy-row')?.click(); return !!row;})()`);
await evaluate(`[...document.querySelectorAll('.workflow-mode-switch button')].find(e=>/Pose|포즈/.test(e.textContent))?.click()`);
await wait("window.__cozyclay.ikMode === true && !!document.querySelector('[data-testid=platform-fit-run]')?.getBoundingClientRect().width", 20000);
await screenshot("before");

await click('[data-testid="platform-fit-run"]');
await wait("!window.__cozyclay.platformFit.running && !!window.__cozyclay.platformFit.last && !!document.querySelector('[data-testid=platform-fit-apply]')", 360000);
const fitLast = await evaluate("window.__cozyclay.platformFit.last");
await screenshot("preview");
await click('[data-testid="platform-fit-apply"]');
await wait("window.__cozyclay.platformFit.applied===true && !document.querySelector('[data-testid=platform-fit-apply]')", 60000);
console.log("fit-summary", JSON.stringify(fitLast.summary));
console.log("fit-steps", JSON.stringify(fitLast.steps));
await screenshot("after");

const fittedSamples = [];
for (let frame = 0; frame < motionInfo.frames; frame += 1) {
	await scrub(frame);
	fittedSamples.push(await sample());
}
const boxTop = 0.2;
const boxSteps = fitLast.steps.filter((step) => step.objectId === objectId && step.status === "ok");
const preBoxSteps = fitLast.steps.filter((step) => step.objectId === null && step.status === "ok");
const plantedDiffs = [];
let lowestPlanted = Infinity;
let pelvisRise = 0;
for (const step of boxSteps) {
	for (let frame = step.start; frame <= step.end; frame += 1) {
		const row = fittedSamples[frame];
		const sole = row.feet[step.foot].sole;
		plantedDiffs.push(Math.abs(sole - boxTop));
		lowestPlanted = Math.min(lowestPlanted, sole);
		pelvisRise = Math.max(pelvisRise, (row.pelvis?.y ?? 0) - (rawSamples[frame].pelvis?.y ?? 0));
	}
}
let preBoxMovement = 0;
for (const step of preBoxSteps) {
	for (let frame = step.start; frame <= step.end; frame += 1) {
		preBoxMovement = Math.max(preBoxMovement, Math.abs(fittedSamples[frame].feet[step.foot].sole - rawSamples[frame].feet[step.foot].sole));
	}
}
const fitMetrics = {
	boxSteps: boxSteps.length,
	maxPlantedSoleDiff: plantedDiffs.length ? Math.max(...plantedDiffs) : null,
	lowestPlantedSole: Number.isFinite(lowestPlanted) ? lowestPlanted : null,
	pelvisRise,
	preBoxMovement,
};
check("0.20 m box has planted ok steps", boxSteps.length > 0, JSON.stringify(fitMetrics));
check("ok planted soles match box top within 0.015 m", plantedDiffs.length > 0 && fitMetrics.maxPlantedSoleDiff <= 0.015, JSON.stringify(fitMetrics));
check("no planted sole is below box top by more than 0.01 m", plantedDiffs.length > 0 && fitMetrics.lowestPlantedSole >= boxTop - 0.01, JSON.stringify(fitMetrics));
check("pelvis rises over the box by more than 0.08 m", fitMetrics.pelvisRise > 0.08, JSON.stringify(fitMetrics));
check("steps before the box remain unchanged below 0.002 m", preBoxSteps.length > 0 && preBoxMovement < 0.002, JSON.stringify(fitMetrics));

// Undo the fit (not the box placement) through the application's real history.
const preUndoKeys = await evaluate("window.__cozyclay.ik.keys.size");
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "z", code: "KeyZ", modifiers: 4 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", modifiers: 4 });
await wait(`window.__cozyclay.ik.keys.size===0 && ${preUndoKeys}>0`, 10000);
const undoSamples = [];
for (let frame = 0; frame < motionInfo.frames; frame += 1) {
	await scrub(frame);
	undoSamples.push(await sample());
}
let undoMovement = 0;
for (let frame = 0; frame < motionInfo.frames; frame += 1) {
	for (const foot of ["leftFoot", "rightFoot"]) undoMovement = Math.max(undoMovement, Math.abs(undoSamples[frame].feet[foot].sole - rawSamples[frame].feet[foot].sole));
}
check("Undo returns feet to pre-fit heights below 0.002 m", undoMovement < 0.002, `${undoMovement.toFixed(6)} m`);

// Fit again, then take it back with the panel's own "Remove platform fit" button.
await click('[data-testid="platform-fit-run"]');
await wait("!window.__cozyclay.platformFit.running && !!document.querySelector('[data-testid=platform-fit-apply]')", 360000);
await click('[data-testid="platform-fit-apply"]');
await wait("window.__cozyclay.platformFit.applied===true && !document.querySelector('[data-testid=platform-fit-apply]')", 60000);
await wait("document.querySelector('[data-testid=platform-fit-remove]')?.disabled===false", 30000);
await screenshot("remove-button");
await click('[data-testid="platform-fit-remove"]');
await wait("window.__cozyclay.platformFit.applied===false && window.__cozyclay.ik.keys.size===0", 60000);
let removeMovement = 0;
for (let frame = 0; frame < motionInfo.frames; frame += 1) {
	await scrub(frame);
	const row = await sample();
	for (const foot of ["leftFoot", "rightFoot"]) removeMovement = Math.max(removeMovement, Math.abs(row.feet[foot].sole - rawSamples[frame].feet[foot].sole));
}
const removeGone = await evaluate("!document.querySelector('[data-testid=platform-fit-remove]')");
check("Remove platform fit returns feet to pre-fit heights below 0.002 m", removeMovement < 0.002, `${removeMovement.toFixed(6)} m`);
check("Remove button disappears after removal", removeGone);

// Replace the box with a 1.5 m version and run the same real button again.
await evaluate(`window.__cozyclay.sceneObject.update({ id: ${JSON.stringify(objectId)}, scaleY: 1.5 })`);
await wait(`window.__cozyclay.objects.some(o=>o.id===${JSON.stringify(objectId)} && Math.abs(o.height*o.scaleY-1.5)<1e-9)`);
await screenshot("wall");
await click('[data-testid="platform-fit-run"]');
await wait("!window.__cozyclay.platformFit.running && !!window.__cozyclay.platformFit.last && !!document.querySelector('[data-testid=platform-fit-preview]')", 360000);
const wallLast = await evaluate("window.__cozyclay.platformFit.last");
await sleep(300);
await screenshot("wall-result");
console.log("wall-summary", JSON.stringify(wallLast.summary));
console.log("wall-steps", JSON.stringify(wallLast.steps));
const wallSamples = [];
for (let frame = 0; frame < motionInfo.frames; frame += 1) {
	await scrub(frame);
	wallSamples.push(await sample());
}
let wallMovement = 0;
for (let frame = 0; frame < motionInfo.frames; frame += 1) {
	for (const foot of ["leftFoot", "rightFoot"]) wallMovement = Math.max(wallMovement, Math.abs(wallSamples[frame].feet[foot].sole - rawSamples[frame].feet[foot].sole));
}
const wallSteps = wallLast.steps.filter((step) => step.objectId === objectId);
const wallMetrics = { flagged: wallSteps.filter((step) => step.status === "wall" || step.status === "tooHigh").length, lifted: wallLast.summary.lifted, feetMovement: wallMovement };
check("1.5 m box reports wall or tooHigh", wallMetrics.flagged > 0, JSON.stringify(wallMetrics));
check("1.5 m box lifts zero steps", wallLast.summary.lifted === 0, JSON.stringify(wallMetrics));
check("wall run leaves feet unchanged", wallMovement < 0.002, JSON.stringify(wallMetrics));

const report = {
	motion: motionInfo,
	box: { id: objectId, center: boxCenter, climbableHeight: 0.2, wallHeight: 1.5 },
	fit: { summary: fitLast.summary, steps: fitLast.steps, metrics: fitMetrics },
	undo: { maxFootHeightDifference: undoMovement },
	wall: { summary: wallLast.summary, steps: wallLast.steps, metrics: wallMetrics },
	checks,
	runtimeExceptions,
	consoleErrors,
	screenshots: ["before.png", "after.png", "wall.png", "wall-result.png"].map((name) => `${out}/${name}`),
};
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log("runtime-exceptions", JSON.stringify(runtimeExceptions));
console.log("console-errors", JSON.stringify(consoleErrors));
if (runtimeExceptions.length || consoleErrors.length) {
	check("No Runtime.exceptionThrown or console error", false, JSON.stringify({ runtimeExceptions, consoleErrors }));
}
console.log("report", `${out}/report.json`);
ws.close();
process.exit(checks.some((entry) => !entry.pass) || runtimeExceptions.length || consoleErrors.length ? 1 : 0);
