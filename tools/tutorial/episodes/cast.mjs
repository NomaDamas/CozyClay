// A new project opens on an empty stage (#986), so an episode adds its first
// character from the Scene view's Add menu before it clicks one. The Outliner
// gives the first character the legacy row id characterA (hierarchy-model.js),
// whatever its character id; evals reach it as characters[0].
export const FIRST_CHARACTER_ROW = "characterA";
export const ADD_CHARACTER = ".add-object-menu [data-add=character]";

/** Add > Y Bot, then a hold while its rig loads. */
export const castFirstCharacter = (id, narration) => [
	{ id, ...(narration ? { narration } : {}), menu: { open: "[data-testid=viewport-add]", then: ADD_CHARACTER }, until: `[data-node-id="${FIRST_CHARACTER_ROW}"]` },
	{ id: `${id}-rig`, hold: 1500 },
];
