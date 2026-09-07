// /agent/image with scene references (#167). Boots the real route handler with
// a fake codex client (same pattern as test/verify-agent-routes.mjs) and proves
// three things: every reference reaches the backend as another attached image,
// the prompt says what each attachment is for, and a reference that is not an
// inline image is a 400 rather than something the backend has to sort out.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createAgentHandler, referenceGuidance } from "../bin/agent/agent-routes.mjs";
import { createCodexClient } from "../bin/agent/codex-client.mjs";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const jpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

const seen = [];
const fakeCodex = {
	parseQuotaHeaders: () => ({ planType: "Plus", primary: {}, credits: { hasCredits: true } }),
	editImage: async (args) => { seen.push(args); return { pngBase64: png.split(",")[1], width: 1, height: 1 }; },
};

let server;
const handler = createAgentHandler({
	auth: { getAccessToken: async () => "token" },
	codex: fakeCodex,
	liveHub: { command: async () => ({}) },
	handlers: [],
	port: () => server.address().port,
});
server = createServer((req, res) => handler(req, res).catch((error) => { res.writeHead(500); res.end(error.message); }));
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();
const post = (body) => fetch(`http://127.0.0.1:${port}/agent/image`, {
	method: "POST",
	headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
	body: JSON.stringify(body),
});

/* --- the happy path --------------------------------------------------------- */

const references = [
	{ role: "character", name: "Alpha", dataUrl: png },
	{ role: "character", name: "Beta", dataUrl: jpeg },
	{ role: "environment", dataUrl: png },
];
const withReference = await post({ prompt: "golden hour", imageDataUrl: png, referenceDataUrl: jpeg, references });
assert.equal(withReference.status, 200, "a request with references is accepted");
const call = seen.at(-1);
assert.equal(call.extraImages.length, references.length, "every reference is forwarded to the client");
assert.deepEqual(call.extraImages, references.map((entry) => entry.dataUrl), "references keep their order");
assert.ok(call.prompt.includes("Character Alpha"), `prompt names the character: ${call.prompt}`);
assert.ok(call.prompt.includes("Character Beta"), "prompt names every character");
assert.ok(call.prompt.includes("Environment:"), "prompt describes the environment reference");
assert.ok(call.prompt.includes("Geometry, camera and blocking come from the first image (the clay frame)."), "the clay frame keeps the geometry");
assert.ok(call.prompt.startsWith("golden hour"), "the node's own prompt still leads");

// What the codex client actually attaches: frame + reference + the references.
const attached = [call.imageDataUrl, call.referenceDataUrl, ...call.extraImages].filter(Boolean);
assert.equal(attached.length, 1 + 1 + references.length, `images length = 1 + referenceDataUrl + references (${attached.length})`);

// Without a referenceDataUrl the count drops by exactly one.
await post({ prompt: "golden hour", imageDataUrl: png, references: [references[0]] });
const bare = seen.at(-1);
assert.equal([bare.imageDataUrl, bare.referenceDataUrl, ...bare.extraImages].filter(Boolean).length, 1 + 0 + 1);

// No references at all: the prompt is untouched and nothing extra is attached.
await post({ prompt: "golden hour", imageDataUrl: png });
assert.equal(seen.at(-1).prompt, "golden hour", "an unreferenced shot sends the prompt as written");
assert.deepEqual(seen.at(-1).extraImages, []);

/* --- rejections ------------------------------------------------------------- */

const before = seen.length;
assert.equal((await post({ prompt: "x", imageDataUrl: png, references: [{ role: "character", name: "Alpha", dataUrl: "https://example.com/a.png" }] })).status, 400, "a remote reference URL is rejected");
assert.equal((await post({ prompt: "x", imageDataUrl: png, references: [{ role: "environment", dataUrl: "data:text/plain;base64,aGk=" }] })).status, 400, "a non-image data URL is rejected");
assert.equal((await post({ prompt: "x", imageDataUrl: png, references: [{ name: "Alpha", dataUrl: png }] })).status, 400, "a reference without a role is rejected");
assert.equal((await post({ prompt: "x", imageDataUrl: png, references: png })).status, 400, "references must be a list");
assert.equal((await post({ prompt: "x", imageDataUrl: png, references: Array.from({ length: 7 }, () => ({ role: "character", dataUrl: png })) })).status, 400, "at most six references");
assert.equal(seen.length, before, "a rejected request never reaches the backend");

/* --- the guidance itself ---------------------------------------------------- */

assert.equal(referenceGuidance([]), "", "no references, no appended guidance");
assert.equal(
	referenceGuidance([{ role: "character", name: "Alpha", dataUrl: png }, { role: "environment", dataUrl: png }]),
	"\nGeometry, camera and blocking come from the first image (the clay frame)."
	+ "\nCharacter Alpha: match the identity, face, hair and wardrobe from the attached character sheet."
	+ "\nEnvironment: take the location look, materials, palette and lighting from the attached environment reference.",
);

/* --- what the backend finally receives -------------------------------------- */

// The route hands `extraImages` to the client; the client is what turns them
// into the images[] the backend reads, frame first.
{
	const calls = [];
	const client = createCodexClient({
		getAccessToken: async () => "t",
		getAccountId: async () => "a",
		fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ data: [{ b64_json: png.split(",")[1] }] }), { status: 200, headers: { "content-type": "application/json" } }); },
	});
	await client.editImage({ prompt: "p", imageDataUrl: png, referenceDataUrl: jpeg, extraImages: references.map((entry) => entry.dataUrl) });
	assert.deepEqual(
		calls[0].body.images,
		[png, jpeg, ...references.map((entry) => entry.dataUrl)].map((image_url) => ({ image_url })),
		"the clay frame leads, then the reference image, then the scene references",
	);
	await client.editImage({ prompt: "p", imageDataUrl: png });
	assert.deepEqual(calls[1].body.images, [{ image_url: png }], "no references, one image");
}

server.close();
await handler.close();
console.log("PASS /agent/image references: forwarded as extra images, described in the prompt, validated");
