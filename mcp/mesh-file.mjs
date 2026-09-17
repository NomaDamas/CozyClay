import { constants as fsConstants } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { ASSET_MAX_SOURCE_BYTES } from "../src/scene-assets.js";
import { classifyMeshBytes, meshMimeForKind } from "../src/mesh-sniff.js";

export function normalizeMeshPath(raw, { home = homedir() } = {}) {
	if (typeof raw !== "string" || !raw.trim()) throw new Error("A file path is required.");
	let path = raw.trim();
	if (path.startsWith("file:")) {
		try {
			const url = new URL(path);
			if (url.protocol === "file:") path = decodeURIComponent(url.pathname);
		} catch {
			path = path.replace(/^file:\/\//, "");
		}
	}
	if (path === "~") path = home;
	else if (path.startsWith("~/")) path = join(home, path.slice(2));
	return resolve(path);
}

export async function readMeshFromPath(raw) {
	const path = normalizeMeshPath(raw);
	let file;
	try {
		file = await openFile(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	} catch (error) {
		throw new Error(`Could not read that file: ${error.message}`);
	}
	try {
		const stat = await file.stat();
		if (stat.isDirectory()) throw new Error("That path is a directory, not a 3D model.");
		if (stat.size > ASSET_MAX_SOURCE_BYTES) {
			throw new Error(`That model is too large to import — larger than ${Math.round(ASSET_MAX_SOURCE_BYTES / (1024 * 1024))} MB`);
		}
		const bytes = await file.readFile();
		const kind = classifyMeshBytes(bytes);
		if (kind === "fbx-old") throw new Error("That FBX file is too old to import");
		const mimeType = meshMimeForKind(kind);
		if (!kind || !mimeType) throw new Error("That file is not a 3D model");
		return { path, name: basename(path), bytes, kind, mimeType };
	} finally {
		await file.close().catch(() => {});
	}
}
