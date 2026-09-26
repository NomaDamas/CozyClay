#!/usr/bin/env node

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
const send = (method, params = {}) => new Promise((resolve, reject) => {
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
const waitFor = async (expression, timeoutMs = 5000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate(expression)) return true;
		await sleep(50);
	}
	return false;
};

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};
const mouse = (type, x, y, { modifiers = 0 } = {}) => send("Input.dispatchMouseEvent", {
	type,
	x: Math.round(x),
	y: Math.round(y),
	button: "left",
	clickCount: 1,
	buttons: type === "mouseReleased" ? 0 : 1,
	modifiers,
});
const click = async ({ x, y }) => {
	await mouse("mousePressed", x, y);
	await mouse("mouseReleased", x, y);
	await sleep(180);
};
const drag = async (from, to) => {
	await mouse("mousePressed", from.x, from.y);
	for (let i = 1; i <= 8; i++) {
		await mouse("mouseMoved", from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
		await sleep(16);
	}
	await mouse("mouseReleased", to.x, to.y);
	await sleep(180);
};
const altDrag = async (from, to) => {
	await mouse("mousePressed", from.x, from.y, { modifiers: 1 });
	for (let i = 1; i <= 8; i++) {
		await mouse("mouseMoved", from.x + ((to.x - from.x) * i) / 8, from.y, { modifiers: 1 });
		await sleep(16);
	}
	await mouse("mouseReleased", to.x, to.y, { modifiers: 1 });
	await sleep(160);
};

await send("Runtime.enable");
await send("Page.enable");
const baseUrl = process.env.QA_URL || "http://127.0.0.1:5180/app/";
const contactButton = ` [...document.querySelectorAll("button")].find((item) => item.textContent.includes("Body contact"))`;
const bodyY = async (name) => evaluate(`(() => { const rig=window.__cozyclay.rigA; rig.updateMatrixWorld(true); let bone=null; rig.traverse((node) => { if (node.isBone && node.name === ${JSON.stringify(name)} && !bone) bone=node; }); return bone?.matrixWorld.elements[13] ?? null; })()`);
const boneSnapshot = async () => evaluate(`(() => { const rig=window.__cozyclay.rigA; rig.updateMatrixWorld(true); const out={}; rig.traverse((node) => { if (node.isBone) out[node.name]=node.matrixWorld.elements.slice(); }); return out; })()`);
const snapshotEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const meshMinY = async (frame) => {
	await evaluate(`window.__cozyclay.scrub(${frame})`);
	await waitFor(`window.__cozyclay.tlFrame === ${frame}`, 2000);
	return evaluate(`(() => { const rig=window.__cozyclay.rigA; rig.updateMatrixWorld(true); let min=Infinity; rig.traverse((mesh) => { if (!mesh.isSkinnedMesh || !mesh.geometry?.attributes?.position) return; const p=mesh.geometry.attributes.position; const v=mesh.position.clone(); const step=Math.max(1, Math.ceil(p.count / 4000)); for (let i=0; i<p.count; i+=step) { v.fromBufferAttribute(p, i); mesh.getVertexPosition(i, v); mesh.localToWorld(v); min=Math.min(min, v.y); } }); return min; })()`);
};
const contactTable = async (label) => {
	const values = {};
	for (const frame of [10, 40, 70]) values[frame] = await meshMinY(frame);
	console.log(`${label} skinned-mesh min Y`, JSON.stringify(values));
	return values;
};
// Foot snap and Body contact are IK drag modifiers, so they only exist while
// IK does (#191). Every fresh navigation lands with IK off: enter it before
// reading or driving the contact toggle.
const ikButton = (state) => `[...document.querySelectorAll("button")].find((item) => item.textContent.trim() === "IK ${state}")`;
const enterIk = async () => {
	expect("IK rig resolves", await waitFor("!!window.__cozyclay?.ikChains", 10000));
	if (!(await evaluate("window.__cozyclay?.ikMode === true"))) await evaluate(`(${ikButton("off")})?.click()`);
	expect("IK mode is on before the contact toggle", await waitFor("window.__cozyclay?.ikMode === true", 4000));
	expect("Body contact appears with IK on", await waitFor(`!!(${contactButton})`, 4000));
};
const toggleContact = async (on) => {
	const pressed = await evaluate(`${contactButton}?.getAttribute("aria-pressed") === "true"`);
	if (pressed !== on) await evaluate(`(${contactButton})?.click()`);
	expect(`body contact is ${on ? "ON" : "OFF"}`, await waitFor(`${contactButton}?.getAttribute("aria-pressed") === ${JSON.stringify(String(on))}`, 2000));
};

await send("Page.navigate", { url: `${baseUrl}?motion=/demo/qa-lying.npz` });
expect("app becomes ready", await waitFor("!!window.__cozyclay?.rigA && !window.__cozyclay?.ikMode", 10000));
expect("lying QA motion becomes ready", await waitFor("!!window.__cozyclay?.motion", 10000));
expect("body contact stays hidden while IK is off", await evaluate(`!(${contactButton})`));
await enterIk();
expect("body contact toggle exists", await evaluate(`!!(${contactButton})`));
const radii = await evaluate("window.__cozyclay.contactRadii");
console.log("measured contact radii", JSON.stringify(radii));
expect("all required demo contact radii are measured", ["LeftHand", "RightHand", "LeftFoot", "RightFoot", "LeftForeArm", "RightForeArm", "LeftLeg", "RightLeg", "Hips", "Head"].every((name) => Number.isFinite(radii?.[name]) && radii[name] >= 0.01 && radii[name] <= 0.25), JSON.stringify(radii));
// Playback is deliberately untouched by Body contact: the lying clip sinks
// its mesh identically with the toggle in either state.
const lyingOn = await contactTable("qa-lying ON");
await toggleContact(false);
const lyingOff = await contactTable("qa-lying OFF");
expect("qa-lying playback penetration is identical with contact ON/OFF", [10, 40, 70].every((frame) => Math.abs(lyingOn[frame] - lyingOff[frame]) <= 0.005), JSON.stringify({ on: lyingOn, off: lyingOff }));
expect("qa-lying mesh penetrates during playback (no playback correction)", [10, 40, 70].every((frame) => lyingOff[frame] < -0.02), JSON.stringify(lyingOff));
await toggleContact(true);

await send("Page.navigate", { url: `${baseUrl}?motion=/demo/walk-then-stop.npz` });
expect("walk motion resets after contact regression", await waitFor("!!window.__cozyclay?.rigA && !!window.__cozyclay?.motion", 10000));
await enterIk();
const walkOn = await contactTable("walk-then-stop ON");
await toggleContact(false);
const walkOff = await contactTable("walk-then-stop OFF");
expect("walk mesh remains visually unchanged by contact", [10, 40, 70].every((frame) => Math.abs(walkOn[frame] - walkOff[frame]) <= 0.005), JSON.stringify({ on: walkOn, off: walkOff }));
await toggleContact(true);

// Playback is intentionally independent of Body contact. Compare every bone's
// world matrix at fixed frames with the toggle in both states.
await send("Page.navigate", { url: `${baseUrl}?motion=/demo/qa-lying.npz` });
expect("playback identity fixture loads", await waitFor("!!window.__cozyclay?.rigA && !!window.__cozyclay?.motion", 10000));
await enterIk();
await toggleContact(true);
const playbackOn = {};
for (const frame of [0, 23, 47, 71]) { await evaluate(`window.__cozyclay.scrub(${frame})`); await waitFor(`window.__cozyclay.tlFrame === ${frame}`, 2000); playbackOn[frame] = await boneSnapshot(); }
await toggleContact(false);
for (const frame of [0, 23, 47, 71]) { await evaluate(`window.__cozyclay.scrub(${frame})`); await waitFor(`window.__cozyclay.tlFrame === ${frame}`, 2000); expect(`playback frame ${frame} is identical with contact ON/OFF`, snapshotEqual(playbackOn[frame], await boneSnapshot())); }
await toggleContact(true);

await send("Page.navigate", { url: baseUrl });
expect("app resets before IK manipulator checks", await waitFor("!!window.__cozyclay?.rigA && !window.__cozyclay?.ikMode", 10000));

expect("IK rig resolves before manipulator checks", await waitFor("!!window.__cozyclay?.ikChains", 10000));
expect("IK toggle exists", await evaluate(`(() => {
	const button = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === "IK off");
	if (!button) return false;
	button.click();
	return true;
})()`));
expect("IK mode enables", await waitFor("window.__cozyclay?.ikMode === true && !!window.__ikVisibilityDetails"));
await sleep(300);

const front = await evaluate("({ visible: window.__ikVisibleControls(), positions: window.__ikControlScreenPositions() })");
for (const id of ["hips", "spine", "chest", "neck", "head", "leftShoulder", "rightShoulder"]) {
	expect(`front view exposes ${id}`, front.visible.includes(id));
	expect(`front view projects ${id}`, Number.isFinite(front.positions[id]?.x) && front.positions[id]?.exposed === true);
}
const idlePerfStart = await evaluate("window.__ikVisibilityPerformance()");
expect(
	"initial IK visibility pass stays below the interaction-jank threshold",
	idlePerfStart.lastPassMs < 100,
	JSON.stringify(idlePerfStart),
);
await sleep(500);
const idlePerfEnd = await evaluate("window.__ikVisibilityPerformance()");
expect(
	"idle IK reuses its exposure result instead of raycasting every frame",
	idlePerfEnd.passes - idlePerfStart.passes <= 1,
	JSON.stringify({ before: idlePerfStart, after: idlePerfEnd }),
);

await click(front.positions.head);
expect("visible head takes exact focus", await evaluate("window.__cozyclay?.ikFocus === 'head'"));
await click((await evaluate("window.__ikControlScreenPositions()" )).head);
expect("focused head toggles off", await evaluate("window.__cozyclay?.ikFocus === null"));

const stage = await evaluate(`(() => {
	const rect = document.querySelector(".stage").getBoundingClientRect();
	return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
})()`);
let profile = null;
for (let i = 0; i < 8; i++) {
	await altDrag(
		{ x: stage.left + stage.width * 0.18, y: stage.top + stage.height * 0.42 },
		{ x: stage.left + stage.width * 0.28, y: stage.top + stage.height * 0.42 },
	);
	profile = await evaluate("({ details: window.__ikVisibilityDetails(), positions: window.__ikControlScreenPositions() })");
	if (profile.details.leftShoulder.exposed !== profile.details.rightShoulder.exposed) break;
}
const hiddenShoulder = profile.details.leftShoulder.exposed ? "rightShoulder" : "leftShoulder";
const visibleShoulder = hiddenShoulder === "leftShoulder" ? "rightShoulder" : "leftShoulder";
expect("profile separates near and far shoulders", profile.details[hiddenShoulder].exposed === false && profile.details[visibleShoulder].exposed === true);
expect("hidden shoulder keeps a projected test position", Number.isFinite(profile.positions[hiddenShoulder]?.x) && profile.positions[hiddenShoulder].exposed === false);
expect("profile screen-position evidence matches the exposed shoulder mesh", profile.positions[visibleShoulder]?.exposed === true);
const profilePerf = await evaluate("window.__ikVisibilityPerformance()");
expect("camera orbit invalidates cached exposure", profilePerf.passes > idlePerfEnd.passes);
expect(
	"camera-only visibility updates stay within one frame",
	profilePerf.lastPassMs < 20,
	JSON.stringify(profilePerf),
);

await click(profile.positions[hiddenShoulder]);
const hiddenClickFocus = await evaluate("window.__cozyclay?.ikFocus");
expect(
	"hidden shoulder cannot take its own focus",
	hiddenClickFocus !== hiddenShoulder,
	JSON.stringify({ hiddenShoulder, focus: hiddenClickFocus, detail: profile.details[hiddenShoulder] }),
);
const overlapFocus = hiddenClickFocus;
if (overlapFocus) {
	const overlapPosition = await evaluate(`window.__ikControlScreenPositions()[${JSON.stringify(overlapFocus)}]`);
	await click(overlapPosition);
}
expect("overlapping front-control focus toggles off", await evaluate("window.__cozyclay?.ikFocus === null"));
const currentVisibleShoulder = await evaluate(`window.__ikControlScreenPositions()[${JSON.stringify(visibleShoulder)}]`);
await click(currentVisibleShoulder);
expect("exposed shoulder remains clickable", await evaluate(`window.__cozyclay?.ikFocus === ${JSON.stringify(visibleShoulder)}`));

expect("IK exit button exists", await evaluate(`(() => {
	const button = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === "IK on");
	if (!button) return false;
	button.click();
	return true;
})()`));
expect("IK exit clears mode and stale focus", await waitFor("window.__cozyclay?.ikMode === false && window.__cozyclay?.ikFocus === null"));
expect("IK can re-enter for compound manipulator QA", await evaluate(`(() => {
	const button = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === "IK off");
	if (!button) return false;
	button.click();
	return true;
})()`));
expect("IK re-entry starts clean", await waitFor("window.__cozyclay?.ikMode === true && window.__cozyclay?.ikFocus === null"));
await sleep(250);

const manipulatorControls = await evaluate("window.__ikControlScreenPositions()");
const handTrack = manipulatorControls.leftHand?.exposed ? "leftHand" : "rightHand";
await click(manipulatorControls[handTrack]);
expect("hand focus mounts its compound manipulator", await waitFor(`window.__cozyclay?.ikFocus === ${JSON.stringify(handTrack)} && window.__ikRingVisible()`));
const handCenter = await evaluate(`window.__ikControlScreenPositions()[${JSON.stringify(handTrack)}]`);
const handPicks = await evaluate(`window.__ikPickScreenPositions().filter((pick) => pick.trackId === ${JSON.stringify(handTrack)})`);
expect(
	"focused hand registers enlarged invisible axis hit volumes",
	handPicks.some((pick) => pick.part === "hit-shaft") && handPicks.some((pick) => pick.part === "hit-tip"),
	JSON.stringify(handPicks),
);
const axisTip = handPicks.find((pick) => pick.part === "tip" && pick.axis === "x") ?? handPicks.find((pick) => pick.part === "tip");
expect("focused hand exposes an axis tip pick target", Number.isFinite(axisTip?.x), JSON.stringify(handPicks));
const axisDx = axisTip.x - handCenter.x;
const axisDy = axisTip.y - handCenter.y;
const axisLength = Math.hypot(axisDx, axisDy) || 1;
const handBeforeAxis = await evaluate(`window.__ikHandlePos(${JSON.stringify(handTrack)})`);
const perfBeforeAxis = await evaluate("window.__ikVisibilityPerformance()");
await drag(axisTip, {
	x: axisTip.x + (axisDx / axisLength) * 36,
	y: axisTip.y + (axisDy / axisLength) * 36,
});
const handAfterAxis = await evaluate(`window.__ikHandlePos(${JSON.stringify(handTrack)})`);
const axisWorldDelta = Math.hypot(
	handAfterAxis.x - handBeforeAxis.x,
	handAfterAxis.y - handBeforeAxis.y,
	handAfterAxis.z - handBeforeAxis.z,
);
const perfAfterAxis = await evaluate("window.__ikVisibilityPerformance()");
expect("axis drag moves the focused hand", axisWorldDelta > 0.005, `delta=${axisWorldDelta}`);
expect("axis drag invalidates the cached exposure", perfAfterAxis.passes > perfBeforeAxis.passes);

const ringPick = (await evaluate(`window.__ikPickScreenPositions().filter((pick) => pick.trackId === ${JSON.stringify(handTrack)})`))
	.find((pick) => pick.part === "ring");
expect("focused hand exposes a swing-ring pick target", Number.isFinite(ringPick?.x));
const movedHandCenter = await evaluate(`window.__ikControlScreenPositions()[${JSON.stringify(handTrack)}]`);
const ringDx = ringPick.x - movedHandCenter.x;
const ringDy = ringPick.y - movedHandCenter.y;
const ringLength = Math.hypot(ringDx, ringDy) || 1;
const quatBeforeRing = await evaluate(`window.__ikEffectorQuat(${JSON.stringify(handTrack)})`);
await drag(ringPick, {
	x: ringPick.x - (ringDy / ringLength) * 34,
	y: ringPick.y + (ringDx / ringLength) * 34,
});
const quatAfterRing = await evaluate(`window.__ikEffectorQuat(${JSON.stringify(handTrack)})`);
const lastRingPick = await evaluate("window.__ikLastPick");
const quatDot = Math.abs(
	quatBeforeRing.x * quatAfterRing.x +
	quatBeforeRing.y * quatAfterRing.y +
	quatBeforeRing.z * quatAfterRing.z +
	quatBeforeRing.w * quatAfterRing.w
);
const ringAngle = 2 * Math.acos(Math.min(1, quatDot));
expect("swing-ring drag rotates the hand effector", ringAngle > 0.01, JSON.stringify({ ringAngle, lastRingPick }));

// Body-contact regression: use the real hips Y-axis gizmo and drag far below
// the floor. Contact must hold the skinned mesh and hand chains live, while
// disabling it must expose the same downward body translation.
await click((await evaluate("window.__ikControlScreenPositions()")).hips);
expect("hips click mounts the body drag control", await waitFor("window.__ikPickScreenPositions().some((pick) => pick.trackId === 'hips')"));
const hipsPicks = await evaluate("window.__ikPickScreenPositions().filter((pick) => pick.trackId === 'hips')");
const hipsAxis = hipsPicks.find((pick) => pick.part === "tip" && pick.axis === "y") ?? hipsPicks.find((pick) => pick.part === "tip") ?? hipsPicks[0];
expect("hips exposes a drag target", Number.isFinite(hipsAxis?.x) && Number.isFinite(hipsAxis?.y), JSON.stringify(hipsPicks));
const meshBeforeDrag = await meshMinY(0);
await toggleContact(true);
await drag(hipsAxis, { x: hipsAxis.x, y: hipsAxis.y + 420 });
const meshOnDrag = await meshMinY(0);
const plantedOn = { left: await bodyY("mixamorigLeftFoot"), right: await bodyY("mixamorigRightFoot") };
const handOn = { left: await bodyY("mixamorigLeftHand"), right: await bodyY("mixamorigRightHand") };
expect("contact ON keeps dragged skinned mesh on the floor", meshOnDrag >= -0.03, JSON.stringify({ before: meshBeforeDrag, after: meshOnDrag }));
expect("contact ON keeps planted feet at their plant height", plantedOn.left >= -0.03 && plantedOn.right >= -0.03, JSON.stringify(plantedOn));
expect("contact ON keeps hands at or above contact height", handOn.left >= -0.03 && handOn.right >= -0.03, JSON.stringify(handOn));
await click((await evaluate("window.__ikControlScreenPositions()")).hips);
await toggleContact(false);
await click((await evaluate("window.__ikControlScreenPositions()")).hips);
const hipsPicksOff = await evaluate("window.__ikPickScreenPositions().filter((pick) => pick.trackId === 'hips')");
const hipsAxisOff = hipsPicksOff.find((pick) => pick.part === "tip" && pick.axis === "y") ?? hipsPicksOff.find((pick) => pick.part === "tip") ?? hipsPicksOff[0];
await drag(hipsAxisOff, { x: hipsAxisOff.x, y: hipsAxisOff.y + 420 });
const meshOffDrag = await meshMinY(0);
expect("contact OFF allows the dragged mesh to sink below the floor", meshOffDrag < -0.02, JSON.stringify({ after: meshOffDrag }));

expect("final IK exit button exists", await evaluate(`(() => {
	const button = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === "IK on");
	if (!button) return false;
	button.click();
	return true;
})()`));
expect("final IK exit clears compound focus", await waitFor("window.__cozyclay?.ikMode === false && window.__cozyclay?.ikFocus === null"));
expect("browser run has no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

ws.close();
if (failures) process.exit(1);
console.log("all IK browser checks PASS");
