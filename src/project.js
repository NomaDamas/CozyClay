/**
 * CozyClay project files — game-engine style.
 *
 * A project is ONE file (`.cclayproject`, JSON) holding the full authoring
 * state: the scene document (scenes + cast + animation layers), the
 * workspace layout, and the custom pose library. Editor preferences
 * (theme, locale) deliberately stay OUT — they belong to the operator, not
 * the project.
 *
 * Files are read/written with the File System Access API when available,
 * with a plain download/upload fallback. The last-used handle is kept in
 * IndexedDB so a refresh can re-open the same project when the browser
 * still grants access.
 */

import { SCENES_VERSION } from "./scenes.js";
import { ASSET_MAX_SOURCE_BYTES, assetIdForBytes, normalizeAsset, referencedAssetIds } from "./scene-assets.js";

export const PROJECT_VERSION = 2;
export const PROJECT_EXTENSION = ".cclayproject";
const IDB_NAME = "cozyclay.project-handle.v1";
const IDB_STORE = "kv";
const IDB_KEY = "lastProjectHandle";

/* ------------------------------- envelope ------------------------------- */

function asArrayBuffer(bytes) {
	if (bytes instanceof ArrayBuffer) return bytes;
	if (ArrayBuffer.isView(bytes)) return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	return null;
}

function bytesToBase64(bytes) {
	const view = new Uint8Array(bytes);
	let binary = "";
	for (let offset = 0; offset < view.length; offset += 0x8000) {
		binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

function base64ToBytes(value) {
	if (typeof value !== "string" || value.length < 4 || value.length % 4 || value.length > Math.ceil(ASSET_MAX_SOURCE_BYTES / 3) * 4) return null;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		const base64Character = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47;
		if (!base64Character && code !== 61) return null;
		if (code === 61 && index < value.length - 2) return null;
	}
	try {
		const binary = atob(value);
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		if (bytes.byteLength > ASSET_MAX_SOURCE_BYTES || bytesToBase64(bytes) !== value) return null;
		return bytes.buffer;
	} catch {
		return null;
	}
}

function embeddedAsset(record) {
	const bytes = asArrayBuffer(record?.bytes);
	const asset = normalizeAsset({ ...record, bytes });
	if (!asset || asset.bytes.byteLength > ASSET_MAX_SOURCE_BYTES) return null;
	// Base64 keeps JSON's asset payload unambiguous; a data URL would duplicate
	// MIME metadata already carried by `type` and force every reader to strip it.
	return { ...asset, bytes: bytesToBase64(asset.bytes) };
}

/** Verify that an embedded record still belongs at its content-addressed id. */
export async function verifyEmbeddedAsset(record, subtle) {
	const bytes = asArrayBuffer(record?.bytes);
	if (!bytes) return false;
	try {
		return (await assetIdForBytes(bytes, subtle)) === record.id;
	} catch {
		return false;
	}
}

function readEmbeddedAssets(value) {
	const assets = [];
	const warnings = [];
	if (!Array.isArray(value)) return { assets, warnings };
	for (const entry of value) {
		const bytes = base64ToBytes(entry?.bytes);
		const asset = bytes && normalizeAsset({ ...entry, bytes });
		if (!asset || asset.bytes.byteLength > ASSET_MAX_SOURCE_BYTES) {
			warnings.push("Skipped an invalid embedded asset.");
			continue;
		}
		assets.push(asset);
	}
	return { assets, warnings };
}

export function createProjectDocument({ scenesDocument, workspaceLayout, customPoses, name, assets }) {
	const assetRecords = new Map();
	for (const record of Array.isArray(assets) ? assets : []) {
		const asset = embeddedAsset(record);
		if (asset) assetRecords.set(asset.id, asset);
	}
	const embeddedAssets = [];
	for (const id of referencedAssetIds(scenesDocument?.scenes)) {
		const asset = assetRecords.get(id);
		if (asset) embeddedAssets.push(asset);
	}
	return {
		app: "cozyclay",
		kind: "project",
		version: PROJECT_VERSION,
		name: typeof name === "string" && name.trim() ? name.trim() : "Untitled",
		scenes: scenesDocument,
		workspace: workspaceLayout ?? null,
		poseLibrary: Array.isArray(customPoses) ? customPoses : [],
		assets: embeddedAssets,
	};
}

/** Parse + validate a project file. Returns { ok, reason?, project? }. */
export function readProjectDocument(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, reason: "corrupt" };
	}
	if (!parsed || typeof parsed !== "object") return { ok: false, reason: "corrupt" };
	if (parsed.app !== "cozyclay" || parsed.kind !== "project") return { ok: false, reason: "not-a-project" };
	if (typeof parsed.version !== "number") return { ok: false, reason: "corrupt" };
	if (parsed.version > PROJECT_VERSION) return { ok: false, reason: "future" };
	const scenes = parsed.scenes;
	if (!scenes || typeof scenes !== "object" || scenes.version > SCENES_VERSION || !Array.isArray(scenes.scenes)) {
		return { ok: false, reason: "scenes-invalid" };
	}
	const embedded = parsed.version >= 2 ? readEmbeddedAssets(parsed.assets) : { assets: [], warnings: [] };
	return {
		ok: true,
		warnings: embedded.warnings,
		project: {
			name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : "Untitled",
			scenesDocument: { version: scenes.version, activeSceneId: scenes.activeSceneId ?? null, scenes: scenes.scenes },
			workspaceLayout: parsed.workspace && typeof parsed.workspace === "object" ? parsed.workspace : null,
			customPoses: Array.isArray(parsed.poseLibrary)
				? parsed.poseLibrary.filter((p) => p && typeof p === "object" && typeof p.id === "string" && p.bones && typeof p.bones === "object")
				: [],
			assets: embedded.assets,
		},
	};
}

/* ------------------------- file system access --------------------------- */

export function hasFileSystemAccess() {
	return typeof window !== "undefined" && typeof window.showSaveFilePicker === "function" && typeof window.showOpenFilePicker === "function";
}

const PICKER_TYPES = [
	{
		description: "CozyClay Project",
		accept: { "application/json": [PROJECT_EXTENSION, ".json"] },
	},
];

export async function pickProjectFileForSave(suggestedName) {
	const handle = await window.showSaveFilePicker({
		suggestedName: `${suggestedName || "Untitled"}${PROJECT_EXTENSION}`,
		types: PICKER_TYPES,
	});
	return handle;
}

export async function pickProjectFileForOpen() {
	const [handle] = await window.showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
	return handle;
}

export async function writeProjectFile(handle, serialized) {
	const writable = await handle.createWritable();
	await writable.write(serialized);
	await writable.close();
}

export async function readProjectFile(handle) {
	const file = await handle.getFile();
	return { name: file.name.replace(/\.cclayproject$|\.json$/i, ""), text: await file.text() };
}

/* --------------------------- fallback (no FS API) ------------------------ */

export function downloadProjectFallback(serialized, name) {
	const blob = new Blob([serialized], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = `${name || "Untitled"}${PROJECT_EXTENSION}`;
	anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function openProjectFallback() {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = `${PROJECT_EXTENSION},.json,application/json`;
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return resolve(null);
			resolve({ name: file.name.replace(/\.cclayproject$|\.json$/i, ""), text: await file.text() });
		};
		input.oncancel = () => resolve(null);
		input.click();
	});
}

/* ------------------------------- IDB handle ------------------------------ */

function openIdb() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(IDB_NAME, 1);
		request.onupgradeneeded = () => request.result.createObjectStore(IDB_STORE);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

export async function storeProjectHandle(handle, name) {
	try {
		const db = await openIdb();
		await new Promise((resolve, reject) => {
			const tx = db.transaction(IDB_STORE, "readwrite");
			tx.objectStore(IDB_STORE).put({ handle, name }, IDB_KEY);
			tx.oncomplete = resolve;
			tx.onerror = () => reject(tx.error);
		});
		db.close();
	} catch {
		/* private mode etc.: the session just won't remember the handle */
	}
}

export async function loadStoredProjectHandle() {
	try {
		const db = await openIdb();
		const record = await new Promise((resolve, reject) => {
			const tx = db.transaction(IDB_STORE, "readonly");
			const request = tx.objectStore(IDB_STORE).get(IDB_KEY);
			request.onsuccess = () => resolve(request.result ?? null);
			request.onerror = () => reject(request.error);
		});
		db.close();
		return record;
	} catch {
		return null;
	}
}

export async function clearStoredProjectHandle() {
	try {
		const db = await openIdb();
		await new Promise((resolve, reject) => {
			const tx = db.transaction(IDB_STORE, "readwrite");
			tx.objectStore(IDB_STORE).delete(IDB_KEY);
			tx.oncomplete = resolve;
			tx.onerror = () => reject(tx.error);
		});
	db.close();
	} catch {
		/* ignore */
	}
}

/* --------------------- recent projects + projects folder ---------------------
 * The browser (game-engine style project picker) needs two things the File
 * System Access API cannot give for free: a HISTORY of what was opened
 * (stored here), and an optional directory handle it can enumerate. */

const RECENTS_KEY = "recentProjects";
const FOLDER_KEY = "projectsDirectory";
const RECENTS_MAX = 8;

async function idbSet(key, value) {
	try {
		const db = await openIdb();
		await new Promise((resolve, reject) => {
			const tx = db.transaction(IDB_STORE, "readwrite");
			tx.objectStore(IDB_STORE).put(value, key);
			tx.oncomplete = resolve;
			tx.onerror = () => reject(tx.error);
		});
		db.close();
	} catch {
		/* private mode etc. */
	}
}

async function idbGet(key) {
	try {
		const db = await openIdb();
		const record = await new Promise((resolve, reject) => {
			const tx = db.transaction(IDB_STORE, "readonly");
			const request = tx.objectStore(IDB_STORE).get(key);
			request.onsuccess = () => resolve(request.result ?? null);
			request.onerror = () => reject(request.error);
		});
	db.close();
		return record;
	} catch {
		return null;
	}
}

/** Record a project open/save in the recents list (most recent first). */
export async function rememberRecentProject(handle, name) {
	const list = (await idbGet(RECENTS_KEY)) ?? [];
	const next = [
		{ handle, name, openedAt: Date.now() },
		...list.filter((entry) => entry.name !== name),
	].slice(0, RECENTS_MAX);
	await idbSet(RECENTS_KEY, next);
	await storeProjectHandle(handle, name);
}

export async function loadRecentProjects() {
	return (await idbGet(RECENTS_KEY)) ?? [];
}

export async function removeRecentProject(name) {
	const list = (await idbGet(RECENTS_KEY)) ?? [];
	await idbSet(RECENTS_KEY, list.filter((entry) => entry.name !== name));
}

/* Projects directory: optional; when set, the browser can LIST the folder. */

export function hasDirectoryPicker() {
	return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

export async function pickProjectsDirectory() {
	return window.showDirectoryPicker({ mode: "readwrite" });
}

export async function storeProjectsDirectory(handle) {
	await idbSet(FOLDER_KEY, { handle });
}

export async function loadProjectsDirectory() {
	const record = await idbGet(FOLDER_KEY);
	return record?.handle ?? null;
}

/** Enumerate `.cclayproject` files in a directory handle, newest first. */
export async function listProjectsInDirectory(dirHandle) {
	const out = [];
	try {
		for await (const [name, handle] of dirHandle.entries()) {
			if (handle.kind !== "file" || !name.endsWith(PROJECT_EXTENSION)) continue;
			const file = await handle.getFile();
			out.push({ name: name.slice(0, -PROJECT_EXTENSION.length), handle, lastModified: file.lastModified });
		}
	} catch {
		return [];
	}
	return out.sort((a, b) => b.lastModified - a.lastModified);
}

/** "granted" | "prompt" | "denied" — never throws. */
export async function queryHandlePermission(handle) {
	try {
		return await handle.queryPermission({ mode: "readwrite" });
	} catch {
		return "denied";
	}
}

/** Escalate a stored handle back to "granted". Chromium demotes a persisted
 * handle's permission to "prompt" when the page is next opened; inside a user
 * gesture the browser answers requestPermission() with a one-click prompt.
 * "granted" | "prompt" | "denied" — never throws. */
export async function requestHandlePermission(handle) {
	try {
		if ((await handle.queryPermission({ mode: "readwrite" })) === "granted") return "granted";
		return await handle.requestPermission({ mode: "readwrite" });
	} catch {
		return "denied";
	}
}
