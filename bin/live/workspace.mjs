/**
 * The hub never guesses which editor a command reaches, so neither does any
 * caller. This is the one rule both `cclay live` (bin/live/studio.mjs) and
 * the Agent sidecar (bin/agent/agent-tools.mjs) use to turn a set of
 * connected editors into a single workspace handle: prefer an explicitly
 * requested handle, keep the workflow-canvas lane separate, then prefer the
 * tab the operator authors in over an embedded preview. Anything ambiguous
 * throws rather than guessing.
 */
import { LiveCliError } from "./client.mjs";

const summarise = (entry) => ({
	handle: entry.handle,
	project: entry.meta?.project ?? null,
	scene: entry.meta?.scene ?? null,
});

const supportsCommands = (entry, requiredCommands) =>
	Array.isArray(entry.meta?.commands) && requiredCommands.every((name) => entry.meta.commands.includes(name));

/**
 * @param {object} options
 * @param {Array<{handle: string, meta?: object}>} options.details - the hub's
 *   connected editors (or their hello-meta summaries).
 * @param {string} [options.requested] - an operator-named handle or project.
 * @param {string[]} [options.requiredCommands] - commands an editor must
 *   advertise to be a candidate; ignored for kind "workflow".
 * @param {"scene"|"workflow"} [options.kind] - which lane to select from.
 * @returns {string} the chosen editor's handle.
 */
export function selectWorkspaceRule({ details, requested, requiredCommands = ["capture_framing_png", "import_asset"], kind = "scene" }) {
	if (requested !== undefined) {
		const matches = details.filter((entry) => entry.handle === requested || entry.meta?.project === requested);
		if (matches.length === 1) return matches[0].handle;
		if (matches.length === 0) {
			throw new LiveCliError("STALE_HANDLE", `No connected editor matches workspace "${requested}".`, { details: { candidates: details.map(summarise) } });
		}
		throw new LiveCliError("AMBIGUOUS_WORKSPACE", `${matches.length} connected editors answer to "${requested}"; name one by handle.`, { details: { candidates: matches.map(summarise) } });
	}

	if (kind === "workflow") {
		const workflow = details.filter((entry) => entry.meta?.kind === "workflow");
		if (workflow.length === 1) return workflow[0].handle;
		if (workflow.length > 1) {
			throw new LiveCliError("AMBIGUOUS_WORKSPACE", `${workflow.length} workflow canvases are connected; name one by handle.`, { details: { candidates: workflow.map(summarise) } });
		}
		throw new LiveCliError("NO_EDITOR", "No workflow canvas workspace is connected.");
	}

	if (details.length === 0) throw new LiveCliError("NO_EDITOR", "No live editor is connected to this hub.");

	// An editor that does not advertise the required commands cannot drive
	// this surface; it predates it, or it is the workflow canvas.
	const authoring = details.filter((entry) => entry.meta?.embed !== true && supportsCommands(entry, requiredCommands));
	if (authoring.length === 1) return authoring[0].handle;
	if (authoring.length > 1) {
		throw new LiveCliError("AMBIGUOUS_WORKSPACE", `${authoring.length} editors are connected; choose one with --workspace.`, { details: { candidates: authoring.map(summarise) } });
	}

	// The Workflow page's embedded Studio preview: use it when no standalone
	// authoring tab is open.
	const embedded = details.filter((entry) => entry.meta?.embed === true && supportsCommands(entry, requiredCommands));
	if (embedded.length === 1) return embedded[0].handle;
	if (embedded.length > 1) {
		throw new LiveCliError("AMBIGUOUS_WORKSPACE", `${embedded.length} embedded editors are connected; choose one with --workspace.`, { details: { candidates: embedded.map(summarise) } });
	}

	throw new LiveCliError("NO_EDITOR", "No connected editor can drive a Studio shot.", { details: { candidates: details.map(summarise) } });
}
