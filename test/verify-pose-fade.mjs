import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { applyPoseFade, POSE_FADE_DEFAULT, POSE_FADE_STORAGE_KEY, readPoseFadeOpacity, writePoseFadeOpacity } from "../src/pose-fade.js";

function prop() {
	const shared = new THREE.MeshStandardMaterial({ opacity: 1 });
	const glass = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.5 });
	const root = new THREE.Group();
	const body = new THREE.Mesh(new THREE.BoxGeometry(), shared);
	const cab = new THREE.Mesh(new THREE.BoxGeometry(), shared);
	const window = new THREE.Mesh(new THREE.BoxGeometry(), glass);
	root.add(body, cab, window);
	return { root, shared, glass };
}

function hits(root) {
	const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1));
	return ray.intersectObject(root, true).length;
}

function memoryStorage() {
	const map = new Map();
	return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)) };
}

test("posing fades every material once and stops pointer hits", () => {
	const { root, shared, glass } = prop();
	assert.ok(hits(root) > 0);
	applyPoseFade(root, 0.2);
	applyPoseFade(root, 0.2);
	assert.equal(shared.opacity, 0.2, "a shared material fades once, not once per mesh or per frame");
	assert.equal(glass.opacity, 0.5 * 0.2);
	assert.equal(shared.transparent, true);
	assert.equal(shared.depthWrite, false);
	assert.equal(hits(root), 0, "faded props cannot take a click meant for the rig");
});

test("changing the opacity scales from the authored value, not the faded one", () => {
	const { root, shared, glass } = prop();
	applyPoseFade(root, 0.2);
	applyPoseFade(root, 0.6);
	assert.equal(shared.opacity, 0.6);
	assert.equal(glass.opacity, 0.5 * 0.6);
});

test("full opacity and leaving pose mode restore materials and picking exactly", () => {
	for (const off of [1, null]) {
		const { root, shared, glass } = prop();
		applyPoseFade(root, 0.3);
		applyPoseFade(root, off);
		applyPoseFade(root, off);
		assert.deepEqual([shared.transparent, shared.opacity, shared.depthWrite], [false, 1, true]);
		assert.deepEqual([glass.transparent, glass.opacity, glass.depthWrite], [true, 0.5, true]);
		assert.ok(hits(root) > 0);
	}
});

test("a mesh that mounts while posing is faded on the next pass", () => {
	const { root } = prop();
	applyPoseFade(root, 0.2);
	const late = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
	root.add(late);
	applyPoseFade(root, 0.2);
	assert.equal(late.material.opacity, 0.2);
});

test("the chosen opacity is remembered and bad stored values fall back", () => {
	const storage = memoryStorage();
	assert.equal(readPoseFadeOpacity(storage), POSE_FADE_DEFAULT);
	writePoseFadeOpacity(0.45, storage);
	assert.equal(readPoseFadeOpacity(storage), 0.45);
	storage.setItem(POSE_FADE_STORAGE_KEY, "7");
	assert.equal(readPoseFadeOpacity(storage), 1);
	storage.setItem(POSE_FADE_STORAGE_KEY, "nope");
	assert.equal(readPoseFadeOpacity(storage), POSE_FADE_DEFAULT);
});
