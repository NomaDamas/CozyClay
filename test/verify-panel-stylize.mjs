#!/usr/bin/env node
// Board panel Stylize (#643): the /agent/image request a panel builds, the
// errors it shows, the size refusal, shot.setStylized as one undo entry, and
// the stylized picture staying reachable so a saved project embeds it.
import assert from "node:assert/strict";
import { FRAME_COMPOSITION_GUIDANCE } from "../bin/agent/agent-routes.mjs";
import {
	CLAY_FRAME_PREAMBLE, agentImageBody, panelStylizeRequest, requestAgentImage, stylizedPngBytes, stylizeErrorMessage,
} from "../src/agent-image-client.js";
import { createProjectDocument } from "../src/project.js";
import { referencedAssetIds, unreachableAssetIds } from "../src/scene-assets.js";
import { createSceneDocument } from "../src/scenes.js";
import { createShot } from "../src/cuts.js";
import { shotsFixture } from "./bus/shots-fixture.mjs";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const STYLIZED_ID = `img-${"e".repeat(32)}`;
const meta = { shotTitle: "Panel 1", focalMm: 35, fovDeg: 54, aspect: "16:9", frameRange: { start: 0, end: 47 }, fps: 24, cast: [{ name: "Mina" }] };

// The request body a panel sends.
{
	const body = panelStylizeRequest({ meta, caption: "  Mina opens the door  ", imageDataUrl: PNG });
	assert.deepEqual(Object.keys(body).sort(), ["imageDataUrl", "prompt", "quality"]);
	assert.equal(body.quality, "auto");
	assert.ok(body.imageDataUrl.startsWith("data:image/png;base64,"));
	assert.ok(body.prompt.includes("Mina opens the door"), body.prompt);
	assert.ok(body.prompt.includes(CLAY_FRAME_PREAMBLE), body.prompt);
	assert.ok(body.prompt.includes("SHOT: Panel 1"), "the shot's labelled image prompt rides along");
	assert.ok(!body.prompt.includes("MOTION:"), "an image prompt carries no motion line");
	assert.equal(CLAY_FRAME_PREAMBLE, FRAME_COMPOSITION_GUIDANCE, "the browser's preamble is the sidecar's");
	assert.ok(!panelStylizeRequest({ meta, caption: "", imageDataUrl: PNG }).prompt.endsWith("\n"), "an empty caption adds no blank line");
	console.log(`PASS panel request: ${JSON.stringify({ ...body, imageDataUrl: `${body.imageDataUrl.slice(0, 22)}...` }).slice(0, 220)}`);
}

// One POST to /agent/image with exactly that body; refusals keep their code.
{
	const calls = [];
	const reply = (status, json) => async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } }); };
	const request = panelStylizeRequest({ meta, caption: "Door", imageDataUrl: PNG });
	const ok = await requestAgentImage(request, { fetchImpl: reply(200, { dataUrl: PNG, width: 1, height: 1 }) });
	assert.equal(ok.dataUrl, PNG);
	assert.equal(calls[0].url, "/agent/image");
	assert.equal(calls[0].init.method, "POST");
	assert.deepEqual(JSON.parse(calls[0].init.body), request);
	assert.deepEqual(agentImageBody({ prompt: "p", imageDataUrl: PNG, references: [], composition: "frame" }), { prompt: "p", imageDataUrl: PNG, composition: "frame", quality: "auto" });

	const entitlement = await requestAgentImage(request, { fetchImpl: reply(403, { error: { code: "entitlement", message: "403 — plan" } }) }).catch(error => error);
	assert.equal(entitlement.status, 403);
	assert.equal(entitlement.code, "entitlement");
	assert.equal(stylizeErrorMessage(entitlement), "This account cannot generate images.");
	const signedOut = await requestAgentImage(request, { fetchImpl: reply(401, { error: { code: "auth", message: "Sign in with ChatGPT in the Agent panel." } }) }).catch(error => error);
	assert.equal(stylizeErrorMessage(signedOut), "Sign in with ChatGPT in the Agent panel first.");
	const upstream = await requestAgentImage(request, { fetchImpl: reply(502, { error: { code: "upstream", message: "502 — busy" } }) }).catch(error => error);
	assert.equal(stylizeErrorMessage(upstream), "Stylize failed — 502 — busy");
	console.log(`PASS refusals: entitlement -> "${stylizeErrorMessage(entitlement)}", auth -> "${stylizeErrorMessage(signedOut)}"`);
}

// The result's size is checked before anything is stored.
{
	assert.equal(stylizedPngBytes(PNG, 1024).byteLength, 70);
	assert.throws(() => stylizedPngBytes(PNG, 69), /larger than 0 MB, so it was not added/);
	assert.throws(() => stylizedPngBytes("data:image/jpeg;base64,AAAA", 1024), /did not return a PNG/);
	console.log("PASS a result above the source-byte cap is refused with a reason");
}

// referencedAssetIds and the project file keep the stylized picture.
{
	const scenesDocument = createSceneDocument();
	const [scene] = scenesDocument.scenes;
	scene.shotDocument = { version: 5, frameCount: 48, waypoints: [], shots: [{ ...createShot("Panel", 0, 47), kind: "still", stylizedAssetId: STYLIZED_ID }] };
	const ids = referencedAssetIds(scenesDocument.scenes);
	assert.ok(ids.has(STYLIZED_ID), JSON.stringify([...ids]));
	assert.deepEqual(unreachableAssetIds([STYLIZED_ID], scenesDocument.scenes), [], "a stylized picture is never swept as unused");
	const project = createProjectDocument({
		scenesDocument, name: "Board", previsMode: "storyboard",
		assets: [{ id: STYLIZED_ID, type: "image/png", width: 1, height: 1, name: "panel.png", bytes: new ArrayBuffer(70) }],
	});
	assert.deepEqual(project.resources.assets.map(asset => asset.id), [STYLIZED_ID]);
	console.log(`PASS referencedAssetIds includes shot.stylizedAssetId and the project embeds ${STYLIZED_ID}`);
}

// shot.setStylized: one undo entry; null clears; a non-image id is refused.
const f = shotsFixture();
try {
	const shot = () => f.live.current.shots[0];
	f.shots.load({ shots: [{ ...createShot("Panel", 0, 47), id: "panel-a", kind: "still" }], frameCount: 48, camera: f.actual.readStudioState().camera });
	const once = (args) => {
		const clock = f.scope.appContext.undoClock, depth = f.shots.documentStore.depths().past;
		const receipt = f.run("shot.setStylized", args);
		assert.equal(receipt.ok, true, JSON.stringify(receipt));
		assert.equal(f.scope.appContext.undoClock, clock + 1);
		assert.equal(f.shots.documentStore.depths().past, depth + 1);
		assert.equal(receipt.undo.entries, 1);
		return receipt;
	};
	const first = once({ shotId: "panel-a", assetId: STYLIZED_ID });
	assert.equal(shot().stylizedAssetId, STYLIZED_ID);
	const other = `img-${"f".repeat(32)}`;
	once({ shotId: "panel-a", assetId: other });
	assert.equal(shot().stylizedAssetId, other, "Re-stylize replaces");
	assert.equal(f.run("edit.undo", {}).status, "undone");
	assert.equal(shot().stylizedAssetId, STYLIZED_ID, "undo brings the previous picture back");
	once({ shotId: "panel-a", assetId: null });
	assert.equal(shot().stylizedAssetId, null, "null clears");
	const before = f.snapshot();
	const refused = f.run("shot.setStylized", { shotId: "panel-a", assetId: "mesh-0" }, "ui");
	assert.equal(refused.ok, false);
	assert.equal(refused.code, "INVALID_ARGUMENT");
	assert.deepEqual(f.snapshot(), before);
	assert.equal(f.run("shot.setStylized", { shotId: "gone", assetId: null }).code, "STALE_TARGET");
	console.log(`PASS shot.setStylized is one undo entry (${first.undo.historyEntryId}), Re-stylize replaces, undo restores, null clears`);
} finally { f.dispose(); }

console.log("panel stylize verified");
