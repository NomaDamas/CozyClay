import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MAX_PERSISTED_IMAGE_BYTES = 2 * 1024 * 1024;

function configDir() {
	return process.env.COZYCLAY_CONFIG_DIR
		|| join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cozyclay");
}

export function agentSessionsDir() {
	return process.env.COZYCLAY_AGENT_SESSIONS_DIR || join(configDir(), "agent-sessions");
}

function validSessionId(sessionId) {
	if (typeof sessionId !== "string" || !sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("Invalid session id.");
	return sessionId;
}

function paths(dir, sessionId) {
	const id = validSessionId(sessionId);
	return { history: join(dir, `${id}.jsonl`), meta: join(dir, `${id}.meta.json`) };
}

function imageTooLarge(value) {
	return typeof value === "string" && value.startsWith("data:") && Buffer.byteLength(value) > MAX_PERSISTED_IMAGE_BYTES;
}

/** Keep codex history as the sole persisted format, omitting only oversized inline images. */
export function persistableHistoryItem(item) {
	if (!item || typeof item !== "object") return item;
	if (!Array.isArray(item.content)) return item;
	const content = item.content.flatMap((part) => {
		if (part?.type !== "input_image") return [part];
		const image = part.image_url ?? part.imageUrl ?? part.dataUrl;
		return imageTooLarge(image) ? [] : [part];
	});
	return content.length === item.content.length ? item : { ...item, content };
}

function cleanUserText(text) {
	const value = String(text || "");
	const marker = "</studio-context>";
	const end = value.indexOf(marker);
	return end === -1 ? value : value.slice(end + marker.length).trim();
}

function firstUserText(history) {
	for (const item of history) {
		if (item?.role !== "user" || !Array.isArray(item.content)) continue;
		const text = item.content.find((part) => part?.type === "input_text" && typeof part.text === "string")?.text;
		if (text) return cleanUserText(text);
	}
	return "";
}

export function createSessionStore(dir = agentSessionsDir()) {
	mkdirSync(dir, { recursive: true });
	return {
		dir,
		read(sessionId) {
			const { history: historyFile, meta: metaFile } = paths(dir, sessionId);
			let historyText;
			try { historyText = readFileSync(historyFile, "utf8"); }
			catch (error) { if (error?.code === "ENOENT") return null; throw error; }
			const history = historyText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
			let meta = null;
			try { meta = JSON.parse(readFileSync(metaFile, "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
			return { history, meta };
		},
		append(sessionId, items, meta = {}) {
			const { history: historyFile, meta: metaFile } = paths(dir, sessionId);
			const persisted = (Array.isArray(items) ? items : []).map(persistableHistoryItem);
			if (persisted.length) appendFileSync(historyFile, `${persisted.map((item) => JSON.stringify(item)).join("\n")}\n`, { mode: 0o600 });
			const now = new Date().toISOString();
			let previous = null;
			try { previous = JSON.parse(readFileSync(metaFile, "utf8")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
			const next = {
				sessionId: validSessionId(sessionId),
				surface: meta.surface ?? previous?.surface ?? "studio",
				createdAt: previous?.createdAt ?? meta.createdAt ?? now,
				updatedAt: now,
				sceneName: meta.sceneName ?? previous?.sceneName ?? null,
				firstText: previous?.firstText || meta.firstText || firstUserText(items),
			};
			writeFileSync(metaFile, `${JSON.stringify(next, null, "\t")}\n`, { mode: 0o600 });
			return next;
		},
		list({ surface } = {}) {
			let names = [];
			try { names = readdirSync(dir); } catch (error) { if (error?.code !== "ENOENT") throw error; }
			return names.filter((name) => name.endsWith(".meta.json")).flatMap((name) => {
				try {
					const meta = JSON.parse(readFileSync(join(dir, name), "utf8"));
					return (!surface || meta.surface === surface) ? [meta] : [];
				} catch { return []; }
			}).sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0)).slice(0, 50);
		},
	};
}

function textParts(content, type = "output_text") {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part) => part?.type === type || (type === "output_text" && part?.type === "text"))
		.map((part) => part.text || "").join("");
}

function receiptSummary(value) {
	if (!value || typeof value !== "object") return "Receipt";
	if (typeof value.summary === "string" && value.summary) return value.summary;
	if (value.status === "installed") return `Installed ${value.installed?.durationSeconds ?? ""}s of motion`;
	if (value.status === "undone") return `Undid ${value.undoneReceiptId || "edit"}`;
	if (value.status === "noop") return "Nothing to change";
	return value.status === "applied" ? "Applied to the scene" : `Receipt: ${value.status || "complete"}`;
}

/** Convert codex input/output items into the one transcript view consumed by the panel. */
export function transcriptFromHistory(history = []) {
	const transcript = [];
	const calls = new Map();
	for (const item of history) {
		if (item?.type === "message") {
			const text = textParts(item.content);
			if (text) transcript.push({ kind: item.role === "user" ? "user" : "assistant", text });
			continue;
		}
		if (item?.role === "user") {
			const text = cleanUserText(textParts(item.content, "input_text"));
			if (text) transcript.push({ kind: "user", text });
			continue;
		}
		if (item?.type === "function_call") {
			const tool = { kind: "tool", name: item.name || "tool", label: String(item.name || "tool").replaceAll("_", " "), ok: true, elapsedMs: null };
			transcript.push(tool);
			calls.set(item.call_id, tool);
			continue;
		}
		if (item?.type !== "function_call_output") continue;
		let output = null;
		try { output = JSON.parse(item.output); } catch { /* keep an unstructured tool output successful */ }
		const tool = calls.get(item.call_id);
		if (tool) {
			tool.ok = output?.ok !== false && !output?.error;
			if (Number.isFinite(output?.elapsedMs)) tool.elapsedMs = output.elapsedMs;
		}
		const receipt = output?.receiptId ? output : output?.receipt;
		if (receipt?.receiptId) transcript.push({ kind: "receipt", receiptId: receipt.receiptId, summary: receiptSummary(receipt) });
	}
	return transcript;
}
