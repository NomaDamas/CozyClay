#!/usr/bin/env node
import assert from "node:assert/strict";
import { createAssetTextureCache } from "../src/scene-asset-cache.js";

const id = `img-${"a".repeat(32)}`;
const record = { id, type: "image/png", width: 1, height: 1, bytes: new Uint8Array([1]).buffer, name: "race.png" };

const bitmapResolvers = [];
let bitmapStarts = 0;
const textures = [];
const cache = createAssetTextureCache({
	getRecord: async () => record,
	putRecord: async (asset) => asset,
	createBitmap: async () => {
		bitmapStarts += 1;
		return new Promise((resolve) => bitmapResolvers.push(resolve));
	},
	makeTexture: (bitmap) => {
		const texture = {
			image: bitmap,
			userData: {},
			disposed: false,
			dispose() { this.disposed = true; },
		};
		textures.push(texture);
		return texture;
	},
});

const updates = [];
const unsubscribe = cache.subscribeToAssetTexture(id, (texture) => updates.push(texture));
const inFlight = cache.loadAssetTexture(id);
await new Promise((resolve) => queueMicrotask(resolve));
assert.equal(bitmapStarts, 1, "the first decode reaches the deterministic bitmap seam");

cache.evictAssetTexture(id);
assert.deepEqual(updates, [null], "eviction immediately tells mounted subscribers their texture is gone");
bitmapResolvers.shift()({ close() {} });
assert.equal(await inFlight, null, "an invalidated decode cannot install a stale texture");
assert.equal(textures[0].disposed, true, "a late texture is disposed instead of leaked or announced");
assert.deepEqual(updates, [null], "a late decode sends no stale subscriber update");

const restore = cache.rememberAsset(record);
await new Promise((resolve) => queueMicrotask(resolve));
assert.equal(bitmapStarts, 2, "undo creates a fresh decode after eviction");
bitmapResolvers.shift()({ close() {} });
await restore;
assert.equal(updates.length, 2, "undo reannounces to the still-mounted subscriber");
assert.equal(updates.at(-1), textures[1], "undo announces the newly decoded texture, never deleted bytes");
unsubscribe();

{
	const meshId = `mesh-${"b".repeat(32)}`;
	const meshRecord = { id: meshId, type: "model/gltf-binary", bytes: new Uint8Array([1, 2, 3]).buffer, name: "cooker.glb" };
	let meshBitmapStarts = 0;
	const meshCache = createAssetTextureCache({
		getRecord: async () => meshRecord,
		putRecord: async (asset) => asset,
		createBitmap: async () => {
			meshBitmapStarts += 1;
			return { close() {} };
		},
		makeTexture: () => ({ dispose() {}, userData: {} }),
	});
	assert.equal(await meshCache.loadAssetTexture(meshId), null, "a mesh id is never decoded as a bitmap");
	await meshCache.rememberAsset(meshRecord);
	assert.equal(meshBitmapStarts, 0, "rememberAsset stores a GLB without createImageBitmap");
}

{
	const objId = `mesh-${"c".repeat(32)}`;
	const objRecord = { id: objId, type: "model/obj", bytes: new Uint8Array([1, 2, 3]).buffer, name: "stove.obj" };
	let objBitmapStarts = 0;
	const objCache = createAssetTextureCache({
		getRecord: async () => objRecord,
		putRecord: async (asset) => asset,
		createBitmap: async () => {
			objBitmapStarts += 1;
			return { close() {} };
		},
		makeTexture: () => ({ dispose() {}, userData: {} }),
	});
	assert.equal(await objCache.loadAssetTexture(objId), null, "an OBJ mesh id is never decoded as a bitmap");
	await objCache.rememberAsset(objRecord);
	assert.equal(objBitmapStarts, 0, "rememberAsset stores an OBJ without createImageBitmap");
}

{
	const fbxId = `mesh-${"d".repeat(32)}`;
	const fbxRecord = { id: fbxId, type: "model/fbx", bytes: new Uint8Array([1, 2, 3]).buffer, name: "stove.fbx" };
	let fbxBitmapStarts = 0;
	const fbxCache = createAssetTextureCache({
		getRecord: async () => fbxRecord,
		putRecord: async (asset) => asset,
		createBitmap: async () => {
			fbxBitmapStarts += 1;
			return { close() {} };
		},
		makeTexture: () => ({ dispose() {}, userData: {} }),
	});
	assert.equal(await fbxCache.loadAssetTexture(fbxId), null, "an FBX mesh id is never decoded as a bitmap");
	await fbxCache.rememberAsset(fbxRecord);
	assert.equal(fbxBitmapStarts, 0, "rememberAsset stores an FBX without createImageBitmap");
}

console.log("scene asset cache generation race checks PASS");
