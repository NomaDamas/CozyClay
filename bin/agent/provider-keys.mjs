import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeSecureJson } from "./secure-file.mjs";

function configDir() {
	return process.env.COZYCLAY_CONFIG_DIR
		|| join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cozyclay");
}

function filePath() {
	return join(configDir(), "providers.json");
}

export function readKeys() {
	const path = filePath();
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return {};
		throw error;
	}
	let value;
	try {
		value = JSON.parse(raw);
	} catch {
		console.warn(`[agent] providers.json is not valid JSON; ignoring it: ${path}`);
		return {};
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		console.warn(`[agent] providers.json is not valid JSON; ignoring it: ${path}`);
		return {};
	}
	for (const [key, entry] of Object.entries(value)) {
		if (typeof key !== "string" || key.length === 0 || typeof entry !== "string" || entry.length === 0) {
			console.warn(`[agent] providers.json has an invalid entry; ignoring it: ${path}`);
			return {};
		}
	}
	return value;
}

export function setKey(id, key) {
	const next = { ...readKeys(), [id]: key };
	writeSecureJson(filePath(), next);
	return next;
}

export function removeKey(id) {
	const next = readKeys();
	delete next[id];
	writeSecureJson(filePath(), next);
	return next;
}

