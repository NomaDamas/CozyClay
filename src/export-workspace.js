// Optional export folder. When the browser grants a directory, download-type
// exports are written there; every failure path falls back to the browser's
// normal download so an export is never lost.
import { track } from "./analytics.js";

const DB_NAME = "cozyclay-export-workspace";
const DB_VERSION = 1;
const STORE = "handles";
const FOLDER_KEY = "folder";
const MAX_NAME = 180;
let writeQueue = Promise.resolve();

function splitExtension(name) {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

/** A file name that cannot leave the chosen directory or break the file system. */
function safeNameCharacter(character) {
	const code = character.codePointAt(0);
	if (code < 0x20 || code === 0x7f || '<>:"/\\|?*'.includes(character)) return "-";
	return character;
}

export function sanitizeExportName(name) {
	const leaf = String(name ?? "").split(/[\\/]/).pop() ?? "";
	const cleaned = [...leaf]
		.map(safeNameCharacter)
		.join("")
		.replace(/^[.\s]+/, "")
		.replace(/[.\s]+$/, "")
		.trim();
	if (!cleaned) return "cozyclay-export";
	if (cleaned.length <= MAX_NAME) return cleaned;
	const [base, extension] = splitExtension(cleaned);
	return `${base.slice(0, Math.max(1, MAX_NAME - extension.length))}${extension}`;
}

/** Browser download naming: shot.zip, shot (1).zip, shot (2).zip, ... */
export function collisionName(name, index) {
	const [base, extension] = splitExtension(String(name));
	return `${base} (${index})${extension}`;
}

async function fileHandleForWrite(directory, name) {
	const safe = sanitizeExportName(name);
	for (let index = 0; index < 10_000; index += 1) {
		const candidate = index === 0 ? safe : collisionName(safe, index);
		try {
			await directory.getFileHandle(candidate);
		} catch (error) {
			if (error?.name === "NotFoundError") {
				return { handle: await directory.getFileHandle(candidate, { create: true }), name: candidate };
			}
			// A folder with the export's name is a collision, not a reason to fail.
			if (error?.name === "TypeMismatchError") continue;
			throw error;
		}
	}
	throw new Error("No free export file name.");
}

async function writeBlobNow(directory, blob, name) {
	const target = await fileHandleForWrite(directory, name);
	let writable = null;
	try {
		writable = await target.handle.createWritable();
		await writable.write(blob);
		await writable.close();
		return { name: target.name, bytes: blob.size };
	} catch (error) {
		try { await writable?.abort(); } catch { /* the stream may already be closed */ }
		try { await directory.removeEntry(target.name); } catch { /* best-effort cleanup */ }
		throw error;
	}
}

/** Write one export without overwriting an existing file. Writes are serialized
 * so two overlapping exports cannot both claim the same free name. */
export function writeBlobToDirectory(directory, blob, name) {
	const run = () => writeBlobNow(directory, blob, name);
	const result = writeQueue.then(run, run);
	writeQueue = result.then(() => undefined, () => undefined);
	return result;
}

function clickDownload(source, name) {
	if (typeof document === "undefined") throw new Error("A browser download is unavailable here.");
		if (typeof source === "string" && !/^(?:blob:|data:|https?:\/\/|\/)/i.test(source)) {
		throw new Error("Unsupported export source.");
	}
	const anchor = document.createElement("a");
	let url = null;
	if (typeof source === "string") {
		anchor.href = source;
	} else {
		url = URL.createObjectURL(source);
		anchor.href = url;
	}
	anchor.download = sanitizeExportName(name);
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	if (url) setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function toBlob(source) {
	if (source instanceof Blob) return source;
	if (typeof source === "string") {
		const response = await fetch(source);
		if (!response.ok) throw new Error(`Export source could not be read: ${response.status}`);
		return response.blob();
	}
	throw new TypeError("An export must be a Blob or a URL.");
}

function openDb() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => request.result.createObjectStore(STORE);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
		request.onblocked = () => reject(new Error("Export folder storage is blocked."));
	});
}

async function storedHandle() {
	try {
		const db = await openDb();
		try {
			return await new Promise((resolve, reject) => {
				const request = db.transaction(STORE, "readonly").objectStore(STORE).get(FOLDER_KEY);
				request.onsuccess = () => resolve(request.result ?? null);
				request.onerror = () => reject(request.error);
			});
		} finally {
			db.close();
		}
	} catch {
		return null;
	}
}

async function storeHandle(handle) {
	const db = await openDb();
	try {
		await new Promise((resolve, reject) => {
			const transaction = db.transaction(STORE, "readwrite");
			transaction.objectStore(STORE).put(handle, FOLDER_KEY);
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
		});
	} finally {
		db.close();
	}
}

async function permissionOf(handle) {
	if (!handle) return "denied";
	if (typeof handle.queryPermission !== "function") return "granted";
	try {
		return await handle.queryPermission({ mode: "readwrite" });
	} catch {
		return "denied";
	}
}

export function canChooseExportWorkspace() {
	return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

/** Ask for the folder; the picker grants read/write for this session. */
export async function chooseExportWorkspace() {
	if (!canChooseExportWorkspace()) throw new Error("This browser cannot choose an export folder.");
	const handle = await window.showDirectoryPicker({ id: "cozyclay-export-folder", mode: "readwrite" });
	await storeHandle(handle);
	return handle;
}

/** The remembered folder and its current permission, if any. */
export async function loadExportWorkspace() {
	const handle = await storedHandle();
	if (!handle) return null;
	return { handle, permission: await permissionOf(handle) };
}

export async function requestExportWorkspacePermission(handle) {
	if (await permissionOf(handle) === "granted") return "granted";
	if (typeof handle?.requestPermission !== "function") return "granted";
	try {
		return await handle.requestPermission({ mode: "readwrite" });
	} catch {
		return "denied";
	}
}

export async function clearExportWorkspace() {
	let db = null;
	try {
		db = await openDb();
		await new Promise((resolve, reject) => {
			const transaction = db.transaction(STORE, "readwrite");
			transaction.objectStore(STORE).delete(FOLDER_KEY);
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
		});
		return true;
	} catch {
		return false;
	} finally {
		db?.close();
	}
}

// saveExport's fallback reasons as the closed export:saved vocabulary.
const SAVED_REASONS = { "unsupported": "unsupported", "no-workspace": "no_workspace", "workspace-permission": "permission", "workspace-write-failed": "write_failed" };

/** Save an export to the chosen folder, or hand it to the browser on any miss.
 * Every call reports export:saved (method and fallback reason, never a name). */
export async function saveExport(source, name, options = {}) {
	const result = await saveExportFile(source, name, options);
	(options.track ?? track)("export:saved", { method: result.method, reason: SAVED_REASONS[result.reason] ?? "none" });
	return result;
}

async function saveExportFile(source, name, options) {
	const injectedDirectory = Object.prototype.hasOwnProperty.call(options, "directory");
	const download = options.download ?? clickDownload;
	if (!injectedDirectory && !canChooseExportWorkspace()) {
		download(source, name);
		return { method: "download", name: sanitizeExportName(name), reason: "unsupported" };
	}
	let directory = options.directory ?? null;
	let permission = injectedDirectory ? (options.permission ?? "granted") : "denied";
	if (!injectedDirectory) {
		const workspace = await loadExportWorkspace();
		directory = workspace?.handle ?? null;
		permission = workspace?.permission ?? "denied";
	}
	if (!directory) {
		download(source, name);
		return { method: "download", name: sanitizeExportName(name), reason: "no-workspace" };
	}
	if (permission !== "granted") {
		download(source, name);
		return { method: "download", name: sanitizeExportName(name), reason: "workspace-permission" };
	}
	try {
		const written = await writeBlobToDirectory(directory, await toBlob(source), name);
		return { method: "workspace", ...written, folderName: directory.name ?? "Export folder" };
	} catch (error) {
		download(source, name);
		return { method: "download", name: sanitizeExportName(name), reason: "workspace-write-failed", error };
	}
}
