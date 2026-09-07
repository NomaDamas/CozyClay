#!/usr/bin/env node
// The Workflow page's "Send to AI" handshake (#168). The Scene node cannot
// build a keyframe pack itself — the rig and the renderer live inside its
// embedded Studio — so the whole feature rests on one postMessage round trip.
// These checks drive it against a fake frame window and fake listeners: the
// request has to reach the right frame, only that frame's reply may resolve
// it, an { error } reply and a silent frame both have to reject, and the
// message listener must be gone on every path (a leaked listener would resolve
// a later, unrelated export into the wrong node).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { KEYFRAME_PACK_REQUEST, KEYFRAME_PACK_RESULT, requestKeyframePack } from "../src/workflow/keyframe-pack-request.js";

function harness() {
	const posted = [];
	const listeners = [];
	const timers = [];
	const frame = { postMessage: (message, origin, transfer) => posted.push({ message, origin, transfer }) };
	const context = {
		frame,
		posted,
		listeners,
		addListener: (type, handler) => listeners.push({ type, handler }),
		removeListener: (type, handler) => {
			const index = listeners.findIndex((entry) => entry.type === type && entry.handler === handler);
			if (index >= 0) listeners.splice(index, 1);
		},
		setTimer: (handler) => { timers.push(handler); return timers.length; },
		clearTimer: (id) => { timers[id - 1] = null; },
		fireTimers: () => { for (const handler of timers.splice(0)) handler?.(); },
		deliver: (event) => { for (const entry of [...listeners]) entry.handler(event); },
	};
	return context;
}

const options = (context, extra = {}) => ({
	addListener: context.addListener,
	removeListener: context.removeListener,
	setTimer: context.setTimer,
	clearTimer: context.clearTimer,
	...extra,
});

/* --- the happy path -------------------------------------------------------- */
{
	const context = harness();
	const bytes = new ArrayBuffer(8);
	const promise = requestKeyframePack(context.frame, options(context, { shotId: "shot-2" }));
	assert.equal(context.posted.length, 1, "the request is posted to the frame window");
	assert.deepEqual(context.posted[0].message, { type: KEYFRAME_PACK_REQUEST, shotId: "shot-2" });
	assert.equal(context.posted[0].origin, "*");
	assert.equal(context.listeners.length, 1, "one message listener is installed while the request is open");

	// Noise first: another frame's reply, and this frame's reply to a different
	// request. Neither may settle this promise.
	context.deliver({ source: {}, data: { type: KEYFRAME_PACK_RESULT, name: "other.zip", bytes, entries: [] } });
	context.deliver({ source: context.frame, data: { type: "cozyclay:capture-framing-result", dataUrl: "data:," } });
	assert.equal(context.listeners.length, 1, "unrelated messages leave the request open");

	context.deliver({ source: context.frame, data: { type: KEYFRAME_PACK_RESULT, name: "cozyclay-shot-2-take.zip", bytes, entries: ["shot/first.png", "shot/last.png"] } });
	const pack = await promise;
	assert.deepEqual(pack, { name: "cozyclay-shot-2-take.zip", bytes, entries: ["shot/first.png", "shot/last.png"] });
	assert.equal(context.listeners.length, 0, "the listener is removed once the pack arrives");
	console.log("PASS requestKeyframePack posts the request and resolves on that frame's reply");
}

/* --- the Studio reports a failure ------------------------------------------ */
{
	const context = harness();
	const promise = requestKeyframePack(context.frame, options(context));
	assert.deepEqual(context.posted[0].message, { type: KEYFRAME_PACK_REQUEST }, "no shotId means the Studio picks the current shot");
	context.deliver({ source: context.frame, data: { type: KEYFRAME_PACK_RESULT, error: "The shot renderer is not ready" } });
	await assert.rejects(promise, /The shot renderer is not ready/);
	assert.equal(context.listeners.length, 0, "the listener is removed after an error reply");
	console.log("PASS requestKeyframePack rejects with the Studio's error message");
}

/* --- the Studio never answers ---------------------------------------------- */
{
	const context = harness();
	const promise = requestKeyframePack(context.frame, options(context, { timeoutMs: 1000 }));
	assert.equal(context.listeners.length, 1);
	context.fireTimers();
	await assert.rejects(promise, /timed out/);
	assert.equal(context.listeners.length, 0, "the listener is removed after a timeout");
	console.log("PASS requestKeyframePack rejects when the embedded Studio never answers");
}

/* --- there is no embedded Studio ------------------------------------------- */
{
	const context = harness();
	await assert.rejects(requestKeyframePack(null, options(context)), /Scene preview is unavailable/);
	assert.equal(context.listeners.length, 0, "a missing frame installs no listener at all");
	assert.equal(context.posted.length, 0);
	console.log("PASS requestKeyframePack rejects without an embedded Studio and installs no listener");
}

/* --- the node wiring ------------------------------------------------------- */
// The helper is only useful if the node actually reaches its own frame, sends
// the pack to disk and reports the export. Assert the wiring in source: a
// browser QA run (test/qa-send-to-ai-browser.mjs) proves it end to end.
{
	const node = readFileSync(new URL("../src/workflow/CozySceneNode.jsx", import.meta.url), "utf8");
	assert.match(node, /cozy-scene-send/, "the node renders the Send to AI control");
	assert.match(node, /Packing…/, "the pending label replaces the button text");
	assert.match(node, /\[data-node-id="\$\{id\}"\] iframe/, "the handler looks up this node's own embedded Studio");
	assert.match(node, /requestKeyframePack\(/);
	assert.match(node, /downloadPack\(/);
	assert.match(node, /track\("export:keyframe_pack", \{ entries: result\.entries\.length, source: "workflow" \}\)/, "the export is reported to analytics");
	assert.match(node, /Pack ready: \$\{result\.name\} \(\$\{result\.entries\.length\} files\)/, "success shows the pack name and file count");
	const css = readFileSync(new URL("../src/workflow/cozy-scene-node.css", import.meta.url), "utf8");
	assert.match(css, /\.cozy-scene-send \{/, "the control is styled with the node's own button vocabulary");
	console.log("PASS the Scene node wires Send to AI to the helper, the download and analytics");
}
