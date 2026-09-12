/**
 * CozyClay project files — game-engine style.
 *
 * A project is ONE file (`.cclayproject`, JSON) holding the full authoring
 * state: the scene document (scenes + cast + animation layers), the
 * workspace layout, the custom pose library, the workflow graph, and the
 * embedded resources (images + motions) the scenes point at. Editor
 * preferences (theme, locale) deliberately stay OUT — they belong to the
 * operator, not the project.
 *
 * Files are read/written with the File System Access API when available,
 * with a plain download/upload fallback. The last-used handle is kept in
 * IndexedDB so a refresh can re-open the same project when the browser
 * still grants access.
 */

import { SCENES_VERSION } from "./scenes.js";
import { ASSET_MAX_SOURCE_BYTES, assetIdForBytes, isAssetId, normalizeAsset, referencedAssetIds } from "./scene-assets.js";

export const PROJECT_VERSION = 4;
export const PROJECT_EXTENSION = ".cclayproject";
export const WORKFLOW_VERSION = 1;
export const WORKFLOW_STORAGE_KEY = "cozyclay.workflow.v1";
const IDB_NAME = "cozyclay.project-handle.v1";
const IDB_STORE = "kv";
const IDB_KEY = "lastProjectHandle";

// Embedded resources are bounded: the file is JSON, so every raw byte costs
// 4/3 on disk and the whole file has to fit in one string on the way in.
export const MOTION_MAX_BYTES = 192 * 1024 * 1024;
export const PROJECT_MAX_RESOURCE_BYTES = 256 * 1024 * 1024;
// A motion id is the SHA-256 of the raw NPZ bytes (see motion-resources.js).
const MOTION_ID_PATTERN = /^[0-9a-f]{64}$/i;

/* ---------------------------- workflow graph --------------------------- */

function plainRecord(value) {
	if (!value || typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function jsonValue(value, depth = 0) {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (depth > 32) return null;
	if (Array.isArray(value)) return value.map((entry) => jsonValue(entry, depth + 1));
	if (!plainRecord(value)) return null;
	const result = {};
	for (const [key, entry] of Object.entries(value)) {
		// These keys can mutate an object's prototype when a graph is consumed
		// by a less defensive host.
		if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
		if (entry !== undefined && typeof entry !== "function" && typeof entry !== "symbol") result[key] = jsonValue(entry, depth + 1);
	}
	return result;
}

function normalizedPosition(value) {
	return {
		x: Number.isFinite(value?.x) ? value.x : 0,
		y: Number.isFinite(value?.y) ? value.y : 0,
	};
}

/** Return a fresh empty graph for new projects and legacy-file migration. */
export function createWorkflowGraph() {
	return { version: WORKFLOW_VERSION, nodes: [], edges: [] };
}

/**
 * Validate the persisted graph envelope. Node data is intentionally opaque;
 * it is copied and JSON-sanitized by normalizeWorkflowGraph below.
 */
export function isWorkflowGraph(value) {
	if (!plainRecord(value) || value.version !== WORKFLOW_VERSION || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return false;
	const ids = new Set();
	for (const node of value.nodes) {
		if (!plainRecord(node) || typeof node.id !== "string" || !node.id.trim() || ids.has(node.id)) return false;
		if (node.type !== undefined && (typeof node.type !== "string" || !node.type.trim())) return false;
		if (!plainRecord(node.position) || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) return false;
		if (node.data !== undefined && !plainRecord(node.data)) return false;
		ids.add(node.id);
	}
	const edgeIds = new Set();
	for (const edge of value.edges) {
		if (!plainRecord(edge) || typeof edge.source !== "string" || typeof edge.target !== "string" || !ids.has(edge.source) || !ids.has(edge.target)) return false;
		if (edge.id !== undefined && (typeof edge.id !== "string" || !edge.id.trim() || edgeIds.has(edge.id))) return false;
		if (edge.sourceHandle !== undefined && typeof edge.sourceHandle !== "string") return false;
		if (edge.targetHandle !== undefined && typeof edge.targetHandle !== "string") return false;
		if (edge.data !== undefined && !plainRecord(edge.data)) return false;
		if (edge.id !== undefined) edgeIds.add(edge.id);
	}
	return true;
}

/**
 * Sanitize an arbitrary graph before it crosses the project-file boundary.
 * Invalid nodes/edges are dropped, dangling edges are removed, and every
 * returned object is detached from the caller's mutable input.
 */
export function normalizeWorkflowGraph(value) {
	if (!plainRecord(value) || (value.version !== undefined && value.version !== WORKFLOW_VERSION)) return createWorkflowGraph();
	const nodes = [];
	const nodeIds = new Set();
	for (const node of Array.isArray(value.nodes) ? value.nodes : []) {
		if (!plainRecord(node) || typeof node.id !== "string" || !node.id.trim() || nodeIds.has(node.id)) continue;
		const data = jsonValue(node.data);
		nodes.push({
			id: node.id,
			type: typeof node.type === "string" && node.type.trim() ? node.type : "default",
			position: normalizedPosition(node.position),
			data: plainRecord(data) ? data : {},
		});
		nodeIds.add(node.id);
	}
	const edges = [];
	const edgeIds = new Set();
	for (let index = 0; index < (Array.isArray(value.edges) ? value.edges.length : 0); index += 1) {
		const edge = value.edges[index];
		if (!plainRecord(edge) || typeof edge.source !== "string" || typeof edge.target !== "string" || !nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
		const candidateId = typeof edge.id === "string" && edge.id.trim() ? edge.id : `${edge.source}->${edge.target}:${index}`;
		if (edgeIds.has(candidateId)) continue;
		const normalized = { id: candidateId, source: edge.source, target: edge.target };
		if (typeof edge.sourceHandle === "string" && edge.sourceHandle) normalized.sourceHandle = edge.sourceHandle;
		if (typeof edge.targetHandle === "string" && edge.targetHandle) normalized.targetHandle = edge.targetHandle;
		const data = jsonValue(edge.data);
		if (plainRecord(data)) normalized.data = data;
		edges.push(normalized);
		edgeIds.add(candidateId);
	}
	return { version: WORKFLOW_VERSION, nodes, edges };
}

/** Read the browser-local workflow draft used by the standalone canvas. */
export function loadWorkflowGraph(storage = globalThis.localStorage) {
	try {
		return normalizeWorkflowGraph(JSON.parse(storage?.getItem(WORKFLOW_STORAGE_KEY) || "null"));
	} catch {
		return createWorkflowGraph();
	}
}

/** Persist a sanitized workflow draft without allowing storage failures to
 * take down the Studio (private browsing and full quotas are both common). */
export function storeWorkflowGraph(graph, storage = globalThis.localStorage) {
	const normalized = normalizeWorkflowGraph(graph);
	try {
		storage?.setItem(WORKFLOW_STORAGE_KEY, JSON.stringify(normalized));
	} catch {
		// localStorage is an optional session cache; the project file remains the
		// durable source of truth.
	}
	try { globalThis.dispatchEvent?.(new CustomEvent("cozyclay:workflow-change")); } catch { /* non-browser runtime */ }
	return normalized;
}

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

/**
 * Structural check of a base64 payload without decoding it: character set,
 * padding, and the byte length the string implies. Returns `{ bytes }` or
 * `{ code }` with a problem code.
 */
function base64Shape(value, limit) {
	if (typeof value !== "string" || value.length < 4 || value.length % 4) return { code: "bad-base64" };
	if (value.length > Math.ceil(limit / 3) * 4) return { code: "too-large" };
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	for (let index = 0; index < value.length - padding; index += 1) {
		const code = value.charCodeAt(index);
		const base64Character = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47;
		if (!base64Character) return { code: "bad-base64" };
	}
	const bytes = (value.length / 4) * 3 - padding;
	return bytes > limit ? { code: "too-large" } : { bytes };
}

/** Decode a base64 payload. Returns `{ buffer }` or `{ code }`. */
function base64ToBytes(value, limit) {
	const shape = base64Shape(value, limit);
	if (shape.code) return shape;
	try {
		const binary = atob(value);
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		// Only the canonical encoding is accepted so a payload has one spelling.
		if (bytesToBase64(bytes) !== value) return { code: "bad-base64" };
		return { buffer: bytes.buffer };
	} catch {
		return { code: "bad-base64" };
	}
}

function resourcesTooLarge(bytes, limit, what) {
	const error = new Error(`${what} (${bytes} bytes) exceeds the ${limit}-byte limit.`);
	error.code = "resources-too-large";
	error.bytes = bytes;
	error.limit = limit;
	return error;
}

function embeddedAsset(record) {
	const bytes = asArrayBuffer(record?.bytes);
	const asset = normalizeAsset({ ...record, bytes });
	if (!asset || asset.bytes.byteLength > ASSET_MAX_SOURCE_BYTES) return null;
	// Base64 keeps JSON's asset payload unambiguous; a data URL would duplicate
	// MIME metadata already carried by `type` and force every reader to strip it.
	return { record: { ...asset, bytes: bytesToBase64(asset.bytes) }, bytes: asset.bytes.byteLength };
}

/** The optional motion fields carried verbatim; frames/fps come from the
 * encoder (motion-resources.js), never from decoding the NPZ here. */
function motionDetails(record) {
	return {
		...(Number.isInteger(record.frames) && record.frames >= 0 ? { frames: record.frames } : {}),
		...(Number.isFinite(record.fps) && record.fps > 0 ? { fps: record.fps } : {}),
		...(typeof record.name === "string" && record.name.trim() ? { name: record.name } : {}),
		...(plainRecord(record.meta) ? { meta: jsonValue(record.meta) } : {}),
	};
}

function motionId(value) {
	return typeof value === "string" && MOTION_ID_PATTERN.test(value) ? value.toLowerCase() : null;
}

/**
 * Validate a motion record for embedding. Accepts the encoded shape
 * (`encoding: "base64"`, `data`) and raw `bytes` (ArrayBuffer or view); the
 * payload is encoded later, once the size budget is known to hold.
 */
function embeddedMotion(record) {
	if (!record || typeof record !== "object") return null;
	const id = motionId(record.motionId);
	if (!id) return null;
	const raw = asArrayBuffer(record.bytes);
	if (raw) {
		if (!raw.byteLength) return null;
		if (raw.byteLength > MOTION_MAX_BYTES) throw resourcesTooLarge(raw.byteLength, MOTION_MAX_BYTES, `Motion ${id}`);
		return { motionId: id, bytes: raw.byteLength, raw, details: motionDetails(record) };
	}
	if (record.encoding !== "base64") return null;
	const shape = base64Shape(record.data, MOTION_MAX_BYTES);
	if (shape.code === "too-large") throw resourcesTooLarge((record.data.length / 4) * 3, MOTION_MAX_BYTES, `Motion ${id}`);
	if (shape.code || (record.bytes !== undefined && record.bytes !== shape.bytes)) return null;
	return { motionId: id, bytes: shape.bytes, data: record.data, details: motionDetails(record) };
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

const PROBLEM_DETAILS = {
	"bad-id": "its id is not a content address",
	duplicate: "the same id appears earlier in the file",
	"bad-encoding": "its encoding is not base64",
	"bad-base64": "its payload is not valid base64",
	"length-mismatch": "its payload does not match the recorded byte length",
	"too-large": "its payload exceeds the size limit",
	"bad-record": "its metadata is incomplete",
};

function readEmbeddedAssets(value, report) {
	const assets = [];
	if (!Array.isArray(value)) return assets;
	const seen = new Set();
	for (const entry of value) {
		const id = typeof entry?.id === "string" ? entry.id : null;
		if (!isAssetId(id)) {
			report("image", id, "bad-id");
			continue;
		}
		if (seen.has(id)) {
			report("image", id, "duplicate");
			continue;
		}
		const decoded = base64ToBytes(entry.bytes, ASSET_MAX_SOURCE_BYTES);
		if (decoded.code) {
			report("image", id, decoded.code);
			continue;
		}
		const asset = normalizeAsset({ ...entry, bytes: decoded.buffer });
		if (!asset) {
			report("image", id, "bad-record");
			continue;
		}
		seen.add(id);
		assets.push(asset);
	}
	return assets;
}

/** Motion records are returned in their encoded shape; decoding and hash
 * verification belong to motion-resources.js. */
function readEmbeddedMotions(value, report) {
	const motions = [];
	if (!Array.isArray(value)) return motions;
	const seen = new Set();
	for (const entry of value) {
		const id = motionId(entry?.motionId);
		if (!id) {
			report("motion", typeof entry?.motionId === "string" ? entry.motionId : null, "bad-id");
			continue;
		}
		if (seen.has(id)) {
			report("motion", id, "duplicate");
			continue;
		}
		if (entry.encoding !== "base64") {
			report("motion", id, "bad-encoding");
			continue;
		}
		const shape = base64Shape(entry.data, MOTION_MAX_BYTES);
		if (shape.code) {
			report("motion", id, shape.code);
			continue;
		}
		if (entry.bytes !== shape.bytes) {
			report("motion", id, "length-mismatch");
			continue;
		}
		seen.add(id);
		motions.push({ motionId: id, encoding: "base64", data: entry.data, bytes: shape.bytes, ...motionDetails(entry) });
	}
	return motions;
}

/**
 * Build the v4 envelope. Images are embedded only when a scene references
 * them; motions are embedded as given (deduped by motionId, first record
 * wins) because the caller already knows which ones the scenes use. Throws
 * `resources-too-large` when one motion or the whole manifest exceeds its
 * budget.
 */
export function createProjectDocument({ scenesDocument, workspaceLayout, customPoses, name, assets, motions, savedAt, workflow }) {
	const assetRecords = new Map();
	for (const record of Array.isArray(assets) ? assets : []) {
		const asset = embeddedAsset(record);
		if (asset) assetRecords.set(asset.record.id, asset);
	}
	const embeddedAssets = [];
	let resourceBytes = 0;
	for (const id of referencedAssetIds(scenesDocument?.scenes)) {
		const asset = assetRecords.get(id);
		if (!asset) continue;
		embeddedAssets.push(asset.record);
		resourceBytes += asset.bytes;
	}
	const motionRecords = new Map();
	for (const record of Array.isArray(motions) ? motions : []) {
		const motion = embeddedMotion(record);
		if (!motion || motionRecords.has(motion.motionId)) continue;
		motionRecords.set(motion.motionId, motion);
		resourceBytes += motion.bytes;
	}
	if (resourceBytes > PROJECT_MAX_RESOURCE_BYTES) throw resourcesTooLarge(resourceBytes, PROJECT_MAX_RESOURCE_BYTES, "Embedded resources");
	const embeddedMotions = [...motionRecords.values()].map(({ motionId: id, bytes, raw, data, details }) => ({
		motionId: id,
		encoding: "base64",
		data: data ?? bytesToBase64(raw),
		bytes,
		...details,
	}));
	return {
		app: "cozyclay",
		kind: "project",
		version: PROJECT_VERSION,
		name: typeof name === "string" && name.trim() ? name.trim() : "Untitled",
		...(Number.isFinite(savedAt) && savedAt > 0 ? { savedAt } : {}),
		scenes: scenesDocument,
		workspace: workspaceLayout ?? null,
		poseLibrary: Array.isArray(customPoses) ? customPoses : [],
		workflow: normalizeWorkflowGraph(workflow),
		resources: { assets: embeddedAssets, motions: embeddedMotions },
	};
}

/**
 * Parse + validate a project file. Returns { ok, reason?, warnings?,
 * problems?, project? }. Invalid embedded records are skipped, each one
 * reported as a warning string and a `{ kind, id, code, message }` problem.
 * v2/v3 files carry images at the top-level `assets`; v4 moves everything
 * under `resources`. Older files are read as-is, never rewritten.
 */
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
	const warnings = [];
	const problems = [];
	const report = (kind, id, code) => {
		const message = `Skipped embedded ${kind} ${id ?? "(no id)"}: ${PROBLEM_DETAILS[code]}.`;
		problems.push({ kind, id, code, message });
		warnings.push(message);
	};
	const assetRecords = parsed.version >= 4 ? parsed.resources?.assets : parsed.version >= 2 ? parsed.assets : undefined;
	const assets = readEmbeddedAssets(assetRecords, report);
	const motions = parsed.version >= 4 ? readEmbeddedMotions(parsed.resources?.motions, report) : [];
	const workflow = normalizeWorkflowGraph(parsed.workflow);
	return {
		ok: true,
		warnings,
		problems,
		project: {
			name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : "Untitled",
			savedAt: Number.isFinite(parsed.savedAt) && parsed.savedAt > 0 ? parsed.savedAt : null,
			scenesDocument: { version: scenes.version, activeSceneId: scenes.activeSceneId ?? null, scenes: scenes.scenes },
			workspaceLayout: parsed.workspace && typeof parsed.workspace === "object" ? parsed.workspace : null,
			customPoses: Array.isArray(parsed.poseLibrary)
				? parsed.poseLibrary.filter((p) => p && typeof p === "object" && typeof p.id === "string" && p.bones && typeof p.bones === "object")
				: [],
			assets,
			motions,
			workflow,
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
	return { name: file.name.replace(/\.cclayproject$|\.json$/i, ""), text: await file.text(), savedAt: file.lastModified };
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
			resolve({ name: file.name.replace(/\.cclayproject$|\.json$/i, ""), text: await file.text(), savedAt: file.lastModified });
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
// The portable .cclayproject file is the durable source of truth, while this
// tiny browser-local record keeps an in-progress project identifiable between
// launches before the user has chosen a file location. Scene data itself is
// already autosaved by App through its scene document store.
export const PROJECT_SESSION_KEY = "cozyclay.project-session.v1";

export function loadProjectSession(storage = globalThis.localStorage) {
	try {
		const value = JSON.parse(storage?.getItem(PROJECT_SESSION_KEY) || "null");
		if (!value || typeof value !== "object") return null;
		const name = typeof value.name === "string" ? value.name.trim() : "";
		return name ? { name, updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0 } : null;
	} catch {
		return null;
	}
}

export function storeProjectSession(name, storage = globalThis.localStorage) {
	const normalized = typeof name === "string" ? name.trim() : "";
	if (!normalized) return false;
	try {
		storage?.setItem(PROJECT_SESSION_KEY, JSON.stringify({ name: normalized, updatedAt: Date.now() }));
		return true;
	} catch {
		return false;
	}
}

export function clearProjectSession(storage = globalThis.localStorage) {
	try { storage?.removeItem(PROJECT_SESSION_KEY); } catch { /* private mode */ }
}

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
