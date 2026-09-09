// Landing-page playground: the marketing page embeds the Studio in an iframe
// with a preset scene, so a visitor can fly the same camera that produced
// the demo reels before installing anything. Nothing here touches storage —
// the iframe shares the origin with /app/, and a visitor poking at the
// playground must never overwrite scenes they authored in the real studio.

import { readProjectDocument } from "./project.js";
import { SCENES_VERSION, migrateStageFrames } from "./scenes.js";

export const PLAYGROUND_EMBED = "playground";
const PLAYGROUND_GLOBAL = "__cozyclayPlayground";

export function isPlaygroundEmbed(search) {
	return new URLSearchParams(search ?? "").get("embed") === PLAYGROUND_EMBED;
}

/** `?scene=` is a same-origin path only (`/scenes/foo.cclayproject`): the
 * landing page owns which preset loads, never a third-party URL. */
export function playgroundSceneUrl(search) {
	const value = new URLSearchParams(search ?? "").get("scene");
	if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return null;
	return value;
}

/** Fetch and validate the preset; returns the scene document or null. */
export async function fetchPlaygroundProject(url) {
	try {
		const response = await fetch(url);
		if (!response.ok) return null;
		const result = readProjectDocument(await response.text());
		if (!result.ok) return null;
		const source = result.project.scenesDocument;
		const document = Number.isInteger(source.version) && source.version < SCENES_VERSION
			? { ...source, version: SCENES_VERSION, scenes: source.scenes.map((scene) => ({ ...scene, stage: migrateStageFrames(scene.stage) })) }
			: source;
		return { name: result.project.name, document };
	} catch {
		return null;
	}
}

export function stashPlaygroundProject(project) {
	globalThis[PLAYGROUND_GLOBAL] = project;
}

export function takePlaygroundProject() {
	const project = globalThis[PLAYGROUND_GLOBAL];
	return project && typeof project === "object" && project.document ? project : null;
}
