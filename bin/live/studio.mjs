/**
 * What a terminal controller has to know about the Studio command surface:
 * which editor to talk to, how an admitted command is framed, and how the
 * bytes an editor answers with become a PNG on disk.
 *
 * Everything here is JSON in and JSON out. The schemas live in
 * src/studio-agent-protocol.js and stay there: the editor validates every
 * envelope it receives, so a copy of those rules in the CLI would only be a
 * second source of truth that can drift.
 */
import { randomUUID } from "node:crypto";

import { LiveCliError } from "./client.mjs";

/** The four fields that name one document incarnation on one workspace. */
const IDENTITY = ["workspaceId", "documentEpoch", "sceneId", "sceneEpoch"];

const summarise = (editor) => ({
	handle: editor.handle,
	project: editor.meta?.project ?? null,
	scene: editor.meta?.scene ?? null,
	embed: editor.meta?.embed === true,
});

/** An editor that does not advertise the full-resolution capture cannot drive
 * a shot; it predates this surface, or it is the workflow canvas. */
const drivesTheStudio = (editor) => Array.isArray(editor.meta?.commands) && editor.meta.commands.includes("capture_framing_png");

/**
 * The hub never guesses which editor a command reaches, so neither does this.
 * `pickWorkspace` in bin/agent/agent-tools.mjs makes the same choice for the
 * Agent panel: prefer the tab the operator authors in, fall back to the
 * Workflow page's embedded Studio, and refuse anything ambiguous.
 */
export function selectWorkspace(editors, requested) {
	if (requested !== undefined) {
		const matches = editors.filter((editor) => editor.handle === requested || editor.meta?.project === requested);
		if (matches.length === 1) return matches[0].handle;
		if (matches.length === 0) {
			throw new LiveCliError("STALE_HANDLE", `No connected editor matches workspace "${requested}".`, { details: { candidates: editors.map(summarise) } });
		}
		throw new LiveCliError("AMBIGUOUS_WORKSPACE", `${matches.length} connected editors answer to "${requested}"; name one by handle.`, { details: { candidates: matches.map(summarise) } });
	}
	if (editors.length === 0) throw new LiveCliError("NO_EDITOR", "No live editor is connected to this hub.");
	const authoring = editors.filter((editor) => editor.meta?.embed !== true && drivesTheStudio(editor));
	const candidates = authoring.length > 0 ? authoring : editors.filter((editor) => editor.meta?.embed === true && drivesTheStudio(editor));
	if (candidates.length === 1) return candidates[0].handle;
	if (candidates.length === 0) {
		throw new LiveCliError("NO_EDITOR", "No connected editor can drive a Studio shot.", { details: { candidates: editors.map(summarise) } });
	}
	throw new LiveCliError("AMBIGUOUS_WORKSPACE", `${candidates.length} editors are connected; choose one with --workspace.`, { details: { candidates: candidates.map(summarise) } });
}

/** Status as a terminal reads it: the labels an operator recognises, not the
 * raw hello meta. */
export const describeEditors = (editors) => editors.map((editor) => ({
	handle: editor.handle,
	project: editor.meta?.project ?? null,
	scene: editor.meta?.scene ?? null,
	cast: editor.meta?.cast ?? null,
	embed: editor.meta?.embed === true,
	connectedAt: editor.connectedAt ?? null,
	lastSeenMs: editor.lastSeenMs ?? null,
	inFlight: editor.inFlight ?? 0,
}));

/**
 * The admission envelope, built from one `inspect_studio {scope:"selection"}`
 * read: the document this command was authored against and the scene revision
 * it expects. The editor rejects the command outright when either moved; it
 * carries no per-entity tokens, because the scene revision already bumps on
 * every authored change and a retired token only refuses a legitimate retry.
 */
export function admissionEnvelope(name, args, context) {
	if (!context?.host || !context.revision || !Array.isArray(context.entities)) {
		throw new LiveCliError("EDITOR_ERROR", "The editor did not return a Studio context to admit this command against.");
	}
	const host = Object.fromEntries(IDENTITY.map((key) => [key, context.host[key]]));
	return {
		name,
		args,
		commandId: randomUUID(),
		host,
		expectedRevision: context.revision.scene,
	};
}

export function pngFromDataUrl(dataUrl) {
	const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(typeof dataUrl === "string" ? dataUrl.trim() : "");
	if (!match) throw new LiveCliError("EDITOR_ERROR", "The editor answered without PNG bytes.");
	return Buffer.from(match[1], "base64");
}

export function pngFromCaptureFrame(value) {
	if (typeof value?.data !== "string" || value.encoding !== "base64") {
		throw new LiveCliError("EDITOR_ERROR", "The editor answered capture_frame without inline base64 PNG bytes.");
	}
	return Buffer.from(value.data, "base64");
}

/** Several visual references share one --out: the first takes the given name,
 * the rest are numbered beside it. */
export function numberedPath(path, index) {
	if (index === 0) return path;
	const dot = path.lastIndexOf(".");
	const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return dot > slash ? `${path.slice(0, dot)}-${index + 1}${path.slice(dot)}` : `${path}-${index + 1}`;
}
