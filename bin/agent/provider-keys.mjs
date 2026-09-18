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
	try {
		const value = JSON.parse(readFileSync(filePath(), "utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value : {};
	} catch (error) {
		if (error?.code === "ENOENT") return {};
		throw error;
	}
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

export function providersFile() {
	return filePath();
}
