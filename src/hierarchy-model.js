// The Hierarchy lists what EXISTS in the 3D scene — camera, characters
// (with their rig groups, which have viewport handles), environment, props.
// It is also the Inspector's only router: the sidebar has no tabs, so the
// selected node decides which panels App.jsx shows. Workflow surfaces are
// filed under the node that owns them — the generation prompt under the
// scene, the lens under the camera, and motion (capture, ARDY, prompt
// blocks, root path) under the character it animates.
export const HIERARCHY_NODES = [
	{
		// Keep the legacy selection id until App wiring moves to the document
		// model; its visible role is a Scene, never an editorial Shot.
		id: "shot",
		label: "SCENE 01",
		kind: "scene",
		children: [
			{ id: "camera", label: "Camera", kind: "camera" },
			{ id: "light", label: "Light", kind: "light" },
			{
				id: "characters",
				label: "Characters",
				kind: "group",
				children: [
					{
						id: "characterA",
						label: "Character 1",
						kind: "character",
						children: [
							{
								id: "characterA.rig",
								label: "Rig",
								kind: "rig",
								children: [
									{
										id: "rig.torso",
										label: "Torso",
										kind: "rig",
										children: [
											{ id: "rig.hips", label: "Root / Hips", kind: "bone" },
											{ id: "rig.spine", label: "Spine", kind: "bone" },
											{ id: "rig.chest", label: "Chest", kind: "bone" },
											{ id: "rig.neck", label: "Neck", kind: "bone" },
											{ id: "rig.head", label: "Head", kind: "bone" },
										],
									},
									{
										id: "rig.leftArm",
										label: "Left Arm",
										kind: "rig",
										children: [
											{ id: "rig.leftShoulder", label: "Left Shoulder", kind: "bone" },
											{ id: "rig.leftElbow", label: "Left Elbow", kind: "bone" },
											{ id: "rig.leftHand", label: "Left Hand", kind: "bone" },
										],
									},
									{
										id: "rig.rightArm",
										label: "Right Arm",
										kind: "rig",
										children: [
											{ id: "rig.rightShoulder", label: "Right Shoulder", kind: "bone" },
											{ id: "rig.rightElbow", label: "Right Elbow", kind: "bone" },
											{ id: "rig.rightHand", label: "Right Hand", kind: "bone" },
										],
									},
									{
										id: "rig.leftLeg",
										label: "Left Leg",
										kind: "rig",
										children: [
											{ id: "rig.leftKnee", label: "Left Knee", kind: "bone" },
											{ id: "rig.leftFoot", label: "Left Foot", kind: "bone" },
										],
									},
									{
										id: "rig.rightLeg",
										label: "Right Leg",
										kind: "rig",
										children: [
											{ id: "rig.rightKnee", label: "Right Knee", kind: "bone" },
											{ id: "rig.rightFoot", label: "Right Foot", kind: "bone" },
										],
									},
								],
							},
						],
					},
					{
						id: "characterB",
						label: "Character 2",
						kind: "character",
						optional: "showB",
					},
				],
			},
			{ id: "environment", label: "Environment", kind: "environment" },
			{ id: "props", label: "Props", kind: "props" },
		],
	},
];

/**
 * A rig track id ("rightHand", "hips") as a row-readable English label —
 * "Right Hand", "Hips". Attachment labels are built from the SAME track ids
 * the store writes, so a new bone key needs no table entry here.
 * Localization happens in the panel, not in the model.
 */
export function attachBoneLabel(bone) {
	if (typeof bone !== "string") return null;
	const key = bone.trim();
	if (!key) return null;
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.split(" ")
		.filter(Boolean)
		.map((word) => word[0].toUpperCase() + word.slice(1))
		.join(" ");
}

/** The row id a character LIST index owns — see the cast comment below. */
function characterRowId(entry, listIndex) {
	return listIndex === 0 ? "characterA" : listIndex === 1 ? "characterB" : `character:${entry.id}`;
}

/** The visible cast as `characterId → row id`; hidden entries have no row, so
 * anything attached to them has nowhere to nest and falls back to Props. */
function visibleCharacterRows(characters) {
	const rows = new Map();
	if (!Array.isArray(characters)) return rows;
	characters.forEach((entry, listIndex) => {
		if (!entry || entry.hidden) return;
		rows.set(entry.id, characterRowId(entry, listIndex));
	});
	return rows;
}

export function buildHierarchyNodes(sceneObjects = [], characters = null) {
	// An attached prop is carried BY a character, so it reads under that
	// character rather than in the flat Props list it no longer follows.
	const characterRows = visibleCharacterRows(characters);
	const attachedRows = new Map(); // character row id → attached object rows
	const attachedIds = new Set();
	for (const object of sceneObjects) {
		const attach = object?.attach;
		if (!attach || typeof attach !== "object") continue;
		const rowId = characterRows.get(attach.characterId);
		// A dangling / hidden characterId keeps the object in Props: a prop that
		// vanishes from the tree is worse than one filed in the wrong place.
		if (!rowId) continue;
		attachedIds.add(object.id);
		const boneLabel = attachBoneLabel(attach.bone);
		const row = {
			id: `object:${object.id}`,
			label: boneLabel ? `${object.name} · ${boneLabel}` : object.name,
			kind: "object",
		};
		if (attachedRows.has(rowId)) attachedRows.get(rowId).push(row);
		else attachedRows.set(rowId, [row]);
	}
	// Attaching clears `parent` in the store; the model clears it again so a
	// stale record cannot hide a group's children behind an attached row.
	const listed = sceneObjects.filter((object) => !attachedIds.has(object.id));

	const clone = (node) => {
		const next = { ...node };
		if (node.id === "props") {
			// Grouped props nest under their parent, so a rocket built from ten
			// primitives reads as one thing in the tree instead of ten siblings.
			const childrenOf = (parentId) =>
				listed
					.filter((object) => (object.parent ?? null) === parentId)
					.map((object) => {
						const row = { id: `object:${object.id}`, label: object.name, kind: "object" };
						const nested = childrenOf(object.id);
						if (nested.length) row.children = nested;
						return row;
					});
			// An object whose parent is missing still has to appear somewhere, so
			// anything unreachable from the top level is shown at the top level.
			// An attached object is not a grouping parent, so its children are
			// unreachable from the top level and surface there, as orphans do.
			const ids = new Set(listed.map((object) => object.id));
			const rooted = listed.filter(
				(object) => (object.parent ?? null) === null || !ids.has(object.parent),
			);
			next.children = rooted.map((object) => {
				const row = { id: `object:${object.id}`, label: object.name, kind: "object" };
				const nested = childrenOf(object.id);
				if (nested.length) row.children = nested;
				return row;
			});
		} else if (node.children) {
			next.children = node.children.map(clone);
		}
		return next;
	};
	const nodes = HIERARCHY_NODES.map(clone);
	// The cast is list-driven: one row per visible character. The first two
	// keep the legacy row ids (characterA/characterB) that selection, IK and
	// the inspector already route to; extras carry their character id.
	if (Array.isArray(characters)) {
		const group = nodes[0]?.children?.find((node) => node.id === "characters");
		if (group) {
			const rigChildren = group.children.find((node) => node.id === "characterA")?.children;
			// Row ids follow the entry's LIST index so they match the viewport
			// pickId (A/B/charId) stamped by the Character renderer in App.jsx.
			group.children = characters.flatMap((entry, listIndex) => {
				if (entry.hidden) return [];
				const id = characterRowId(entry, listIndex);
				// Only the primary carries the rig subtree: IK and viewport pose
				// handles are scoped to it this phase. Carried props follow the rig
				// so the body reads first and the luggage after it.
				const children = [
					...(listIndex === 0 && rigChildren ? rigChildren : []),
					...(attachedRows.get(id) ?? []),
				];
				return [{
					id,
					label: `Character ${listIndex + 1}`,
					kind: "character",
					...(children.length ? { children } : {}),
				}];
			});
		}
	}
	return nodes;
}
