// Data-only half of the Shot Prompt canvas node (#166). Keeping the prompt
// assembly here — no React, no DOM — lets the node, the workflow runner, and
// the unit test share one definition of what a Shot Prompt node produces.
import { buildShotPrompt } from "../shot-prompt.js";

export const SHOT_PROMPT_TARGETS = Object.freeze(["image", "video"]);

/** Defaults a fresh Shot Prompt node starts with. */
export function shotPromptNodeData() {
	return { label: "Shot Prompt", target: "image", referenceOwnsCamera: true, prompt: "" };
}

/** Pick the prompt target, defaulting anything unknown to "image". */
export function shotPromptTarget(value) {
	return SHOT_PROMPT_TARGETS.includes(value) ? value : "image";
}

/**
 * Turn an upstream Scene node's capture metadata (plus an optional Text intent)
 * into the structured prompt shown on the node.
 *
 * Returns { prompt, error }: a missing capture is an expected state (the Scene
 * node has not been run yet), not an exception.
 */
export function shotPromptFromInputs({ meta, intent, target, referenceOwnsCamera } = {}) {
	if (!meta || typeof meta !== "object") return { prompt: "", error: "Connect a Scene node first." };
	const trimmedIntent = typeof intent === "string" ? intent.trim() : "";
	const prompt = buildShotPrompt(
		{ ...meta, ...(trimmedIntent ? { intent: trimmedIntent } : {}) },
		{ target: shotPromptTarget(target), referenceOwnsCamera: referenceOwnsCamera !== false },
	);
	return { prompt, error: null };
}
