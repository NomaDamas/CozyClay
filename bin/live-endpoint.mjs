/**
 * Where a running live hub advertises itself to local terminal clients.
 *
 * One file per port under the same config directory bin/cozyclay.mjs already
 * uses, mode 0600 because it carries the hub token. The file is the only way a
 * controller can prove it is a local process rather than a page in a browser,
 * so it is written by the owner that started the hub and removed when that hub
 * closes or its process exits.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const liveDirectory = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cozyclay", "live");

export const liveEndpointPath = (port) => join(liveDirectory(), `${port}.json`);

/** Ports this process published, so exit cleans up exactly its own files. */
const published = new Set();
let exitHookInstalled = false;

export function publishLiveEndpoint({ port, token, owner, cwd = process.cwd() }) {
	const record = { port, token, pid: process.pid, owner, cwd, startedAt: new Date().toISOString() };
	const path = liveEndpointPath(port);
	mkdirSync(liveDirectory(), { recursive: true, mode: 0o700 });
	// `mode` only applies to a file this call creates, and a stale file from an
	// earlier run may carry anything. Replace it rather than writing into it.
	rmSync(path, { force: true });
	writeFileSync(path, `${JSON.stringify(record, null, "\t")}\n`, { mode: 0o600 });
	published.add(port);
	if (!exitHookInstalled) {
		exitHookInstalled = true;
		process.once("exit", () => {
			for (const owned of published) rmSync(liveEndpointPath(owned), { force: true });
		});
	}
	return record;
}

export function readLiveEndpoint(port) {
	try {
		const record = JSON.parse(readFileSync(liveEndpointPath(port), "utf8"));
		return typeof record?.token === "string" && Number.isInteger(record.port) ? record : null;
	} catch {
		return null;
	}
}

export function removeLiveEndpoint(port) {
	published.delete(port);
	rmSync(liveEndpointPath(port), { force: true });
}
