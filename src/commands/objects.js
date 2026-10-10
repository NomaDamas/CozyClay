// Scene object commands: attachment, duplication and asset import.
import { studioActionDeclaration } from "../studio-actions.js";
import { characterOf, fail } from "./shared.js";
import { elementSetSchema, registerElementSet } from './elements.js';
import './elements/object.js';
import { createSceneObject, updateSceneObject, removeSceneObject, setSceneObjectParent, descendantsOf, normalizeSceneObject, groupUnderNewEmpty, objectPatchFields } from '../scene-objects.js';
import { clampWarning } from '../receipt-findings.js';
import { STUDIO_TOOL_SCHEMAS, StudioSchemas } from '../studio-agent-protocol.js';

const id = StudioSchemas.TargetGuard.properties.targetId;
const input = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const ids = { type: 'array', items: id, minItems: 1, maxItems: 100 };
const number = { type: 'number' };
const placement = input({ x: number, y: number, z: number, rot: number }, []);
const setInput = elementSetSchema('object');
const scale = setInput.properties.set.properties.scale;
setInput.properties.set.properties.scale = { oneOf: [number, scale] };
const PATCH_HINTS = { scale: 'use scaleX, scaleY, scaleZ', rotY: 'use rot for yaw', yaw: 'use rot for yaw', rotation: 'use rot, rotX, rotZ', position: 'use x, y, z', parent: 'use object.group or object.set parent', parentId: 'use object.group or object.set parent' };
const mutation = (id, label, input) => ({ id, label, description: label, kind: 'mutation', undoDomain: 'objects', input });
const semantic = [
	mutation('object.set', 'Set object fields', setInput),
	mutation('object.add', 'Add object', input({ kind: { type: 'string' }, placement, name: { type: 'string' }, parent: id, first: { type: 'boolean' } }, ['kind'])),
	mutation('object.remove', 'Remove objects', input({ ids })),
	mutation('object.rename', 'Rename object', input({ id, name: { type: 'string', maxLength: 240 } })),
	mutation('object.group', 'Group objects', input({ parent: id, children: ids })),
	mutation('object.ungroup', 'Ungroup objects', input({ children: ids })),
	// The Outliner's "Group under new Empty": the Empty and the reparent are one write, so one undo.
	{ ...mutation('object.groupUnderEmpty', 'Group object under a new Empty', input({ id })), exposure: 'ui-only' },
	{ ...mutation('object.update', 'Update object', input({ id, patch: { type: 'object', properties: {}, additionalProperties: true } }, [])), exposure: 'ui-only', agentHidden: true,
		uiOnlyHint: 'object.update is a legacy UI command that silently ignores unknown keys. Use object.set (one object, declared paths) or arrange_objects.' },
	mutation('objects.arrange', 'Arrange objects', STUDIO_TOOL_SCHEMAS.arrange_objects),
];
const batch = { id: 'objects.batch', label: 'Batch objects', description: 'Apply legacy object operations in one retained entry.', kind: 'job', domain: 'objects',
	input: input({ ops: { type: 'array', maxItems: 100, items: input({ name: { type: 'string' }, args: { type: 'object', properties: {}, additionalProperties: true } }) }, atomic: { type: 'boolean' }, stopOnError: { type: 'boolean' }, label: { type: 'string' } }, ['ops']) };
const replace = { ...mutation('objects.replace', 'Replace authored objects', input({ objects: { type: 'array', items: { type: 'object', properties: {}, additionalProperties: true } } })), exposure: 'ui-only' };
const changedIds = (before, after) => [...new Set([...before, ...after].map(row => row.id))].filter(id => JSON.stringify(before.find(row => row.id === id)) !== JSON.stringify(after.find(row => row.id === id)));
const assetProperties = { ...studioActionDeclaration('asset.import').input.properties, placement,
	...Object.fromEntries(['x', 'y', 'z', 'rot', 'height'].map(key => [key, number])), clay: { type: 'boolean' }, mimeType: { type: 'string' } };
const assetImport = { ...studioActionDeclaration('asset.import'), kind: 'job', domain: 'objects',
	input: { ...input({ ...assetProperties, assetId: id, fileToken: id }, ['placeAs']), oneOf: [
		input(assetProperties, ['source', 'name', 'placeAs']),
		input({ assetId: id, placement, placeAs: assetProperties.placeAs }, ['assetId', 'placeAs']),
		input({ fileToken: id, placeAs: { type: 'string', enum: ['mesh', 'cutout'] } }, ['fileToken', 'placeAs']),
	] } };
const matte = { id: 'object.matte', label: 'Apply object matte', description: 'Prepare derived assets, then publish one fenced object edit.', kind: 'job', domain: 'objects', exposure: 'ui-only', input: input({ objectId: id }) };
export const declarations = Object.freeze([...semantic, replace, batch, ...['object.attach', 'object.detach', 'object.duplicate'].map(studioActionDeclaration), matte, assetImport]);

export function register(registry, ports) {
	const objectOf = objectId => ports.state().objects.find(object => object.id === objectId)
		?? fail("STALE_TARGET", `Object ${objectId} is not in this scene.`);
	const owned = () => ports.storeDomain('objects');
	const available = () => Boolean(ports.storeDomain?.('objects')) || 'The objects document owner is not mounted.';
	const result = (before, summary) => ({ affectedIds: changedIds(before, owned().read()), summary });
	const methods = {
		'object.add': args => {
			const before = owned().read();
			if (args.parent !== undefined) objectOf(args.parent);
			const object = createSceneObject(args.kind, before, args.placement);
			if (!object) fail('INVALID_ARGUMENT', `Unknown object kind: ${args.kind}`);
			const placed = updateSceneObject([object], object.id, { ...(args.placement ?? {}), ...(args.name === undefined ? {} : { name: args.name }) })[0];
			// `first`: the Outliner lists Props in record order, so a UI-made object
			// goes to the top where it is seen, not below a long expanded group.
			const next = args.first ? [placed, ...before] : [...before, placed];
			owned().write(args.parent === undefined ? next : setSceneObjectParent(next, placed.id, args.parent));
			return result(before, 'Added object.');
		},
		'object.remove': ({ ids }) => {
			const before = owned().read(); ids.forEach(objectOf);
			owned().write(ids.reduce((rows, id) => removeSceneObject(rows, id), before));
			return result(before, 'Removed objects.');
		},
		'object.rename': ({ id, name }) => {
			objectOf(id); const before = owned().read();
			owned().write(updateSceneObject(before, id, { name }));
			return result(before, 'Renamed object.');
		},
		'object.update': ({ id, patch }, context) => {
			const target = objectOf(id), before = owned().read();
			// Wire callers get an error for a key nothing reads; the UI's own patches stay lenient.
			const unknown = Object.keys(patch ?? {}).filter(key => !objectPatchFields(target).includes(key));
			if (unknown.length && context?.origin && context.origin !== 'ui') fail('INVALID_ARGUMENT', `object.update cannot set ${unknown.join(', ')}${unknown.some(key => PATCH_HINTS[key]) ? ` (${unknown.filter(key => PATCH_HINTS[key]).map(key => `${key}: ${PATCH_HINTS[key]}`).join('; ')})` : ''}. Supported fields: ${objectPatchFields(target).join(', ')}.`);
			const next = updateSceneObject(before, id, patch);
			owned().write(next);
			const kept = next.find(row => row.id === id);
			const warning = clampWarning(id, Object.fromEntries(['x', 'y', 'z', 'scaleX', 'scaleY', 'scaleZ'].filter(key => Object.hasOwn(patch ?? {}, key)).map(key => [key, Number(patch[key])])), kept);
			return { ...result(before, 'Updated object.'), ...(warning ? { warnings: [warning] } : {}) };
		},
		'object.group': ({ parent, children }) => {
			objectOf(parent); children.forEach(objectOf);
			const before = owned().read();
			if (children.some(id => id === parent || descendantsOf(before, id).some(row => row.id === parent))) fail('INVALID_ARGUMENT', 'Grouping would create a cycle.');
			owned().group(parent, children);
			return result(before, 'Grouped objects.');
		},
		'object.ungroup': ({ children }) => {
			children.forEach(objectOf); const before = owned().read();
			owned().write(children.reduce((rows, id) => setSceneObjectParent(rows, id, null), before));
			return result(before, 'Ungrouped objects.');
		},
		'object.groupUnderEmpty': ({ id }) => {
			const object = objectOf(id); const before = owned().read();
			if (object.attach) fail('CAPABILITY_MISSING', 'Detach the object from its character before grouping it.');
			const grouped = groupUnderNewEmpty(before, id);
			if (!grouped) fail('INVALID_ARGUMENT', 'Cannot group this object.');
			owned().write(grouped.objects);
			return { affectedIds: [grouped.emptyId, id], summary: 'Grouped the object under a new Empty.' };
		},
		'objects.arrange': args => {
			const plan = owned().arrange(args);
			return { affectedIds: plan.affectedIds, summary: 'Arranged objects.', checks: plan.checks, warnings: plan.warnings };
		},
	};
	// Scalar scale is a convenience at the command boundary; the registry still
	// owns all field mapping, normalization, publication and patch aliases.
	registerElementSet({ register(entry) {
		const expand = op => typeof op.set.scale === 'number' ? { ...op, set: { ...op.set, scale: { x: op.set.scale, y: op.set.scale, z: op.set.scale } } } : op;
		registry.register({ ...entry, available, run: args => {
			const ops = (args.ops ?? [args]).map(expand);
			let draft = owned().read();
			for (const { id, set } of ops) if (Object.hasOwn(set, 'parent')) {
				const object = objectOf(id), parent = set.parent;
				if (parent !== null) objectOf(parent);
				if (parent === id || descendantsOf(draft, id).some(row => row.id === parent)) fail('INVALID_ARGUMENT', 'Grouping would create a cycle.');
				if (object.attach) fail('CAPABILITY_MISSING', 'Use object.group to preserve an attached object world transform.');
				draft = setSceneObjectParent(draft, id, parent);
			}
			return entry.run(args.ops ? { ops } : ops[0]);
		} });
	} }, ports, semantic[0]);
	for (const declaration of semantic.slice(1)) registry.register({ ...declaration, available, run: methods[declaration.id] });
	// Native adapters stay usable until their owner is mounted. In the editor,
	// domains mount before registry construction, so this is always the bus alias.
	if (ports.storeDomain?.('objects')) registry.registerToolAlias('arrange_objects', 'objects.arrange');
	registry.register({ ...replace, available, run: ({ objects }) => {
		const next = objects.map(normalizeSceneObject);
		if (next.some(row => !row) || new Set(next.map(row => row.id)).size !== next.length) fail('INVALID_ARGUMENT', 'Objects require valid records and unique ids.');
		const before = owned().read(); owned().write(next);
		return result(before, 'Replaced authored objects.');
	} });
	registry.register({ ...batch, available, run: (args, context) => {
		const before = owned().read();
		const output = context.commit(() => owned().batch(args));
		return { ...result(before, 'Applied object batch.'), output };
	} });
	registry.register({ ...studioActionDeclaration("object.attach"),
		available: state => state.objects.length === 0 ? "There are no scene objects to attach."
			: state.characters.length === 0 ? "There are no characters to attach an object to." : true,
		run: ({ objectId, characterId, bone }) => {
			const object = objectOf(objectId), character = characterOf(ports, characterId), before = ports.state().objects;
			ports.attachSceneObject(objectId, { characterId, bone: bone ?? null });
			const frameName = `${character.subject || character.id}'s ${bone ?? "root"}`;
			return { affectedIds: [objectId], summary: ports.state().objects === before
				? `${object.name || objectId} already rides ${frameName}; nothing changed.`
				: `Attached ${object.name || objectId} to ${frameName}, keeping its place on screen.` };
		} });
	registry.register({ ...studioActionDeclaration("object.detach"),
		available: state => state.objects.some(object => object.attach || object.parent) || "No scene object is attached to a character or grouped.",
		run: ({ objectId }) => {
			const object = objectOf(objectId);
			if (!object.attach && !object.parent) fail("TARGET_NOT_READY", `${object.name || objectId} is not attached to a character or in a group.`);
			ports.attachSceneObject(objectId, null);
			return { affectedIds: [objectId], summary: `Put ${object.name || objectId} back in the world where it is now.` };
		} });
	registry.register({ ...studioActionDeclaration("object.duplicate"),
		available: state => state.objects.length > 0 || "There are no scene objects to duplicate.",
		run: ({ objectId }) => {
			const state = ports.state(), id = objectId ?? state.selectedObjectId;
			if (!id) fail("TARGET_NOT_READY", "Name objectId or select an object first.");
			const source = state.objects.find(object => object.id === id) ?? fail("STALE_TARGET", `Object ${id} is not in this scene.`);
			ports.duplicateSelectedSceneObject(id);
			const after = ports.state().objects, affectedIds = changedIds(state.objects, after);
			const copy = after.find(object => affectedIds.includes(object.id));
			return { affectedIds, summary: copy ? `Duplicated ${source.name || source.id} as ${copy.name || copy.id}.` : "Duplicate object: nothing changed." };
		} });
	// The live import_asset path (validate, store the bytes, ONE atomic store
	// entry), fed a data URL; an http(s) source is fetched into one first.
	registry.register({ ...matte, available, run: async ({ objectId }, context) => {
		await owned().applyMatte(objectId, context);
		return { affectedIds: [objectId], summary: 'Applied the object matte.' };
	} });
	registry.register({ ...assetImport, available: () => true,
		run: async (args, context) => {
			const { source, ...options } = args;
			const { name, placeAs } = options;
			let dataUrl = source;
			if (source && !source.startsWith("data:")) {
				try { dataUrl = await ports.fetchImportSource(source); }
				catch (error) { fail("TARGET_NOT_READY", `Could not fetch the source (${error?.message || error}); its server must allow cross-origin reads.`); }
			}
			let imported;
			try { imported = await (ports.storeDomain?.('objects')?.importAsset ?? ports.importAsset)({ ...options, dataUrl }, context); }
			catch (error) { fail(error.code ?? "INVALID_ARGUMENT", `Not imported: ${error?.message || error}`); }
			return { affectedIds: [imported.objectId], output: imported, summary: `Imported ${name ?? imported.objectId} as a ${placeAs} (object ${imported.objectId}, asset ${imported.assetId}).` };
		} });
}
