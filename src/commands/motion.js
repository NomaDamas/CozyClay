// Motion and IK commands share one per-character authored-intent owner.
import { STUDIO_IK_CHAIN_TRACKS, studioActionDeclaration } from "../studio-actions.js";
import { fail, characterOf, checkPoseBones } from "./shared.js";
import { elementSetSchema, registerElementSet } from './elements.js';
import { registerTiming, timingDeclarations } from './motion-timing.js';
import './elements/motion.js';
import './elements/character.js';
const id = { type: 'string', minLength: 1 }, frame = { type: 'integer', minimum: 0 };
const input = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const mutation = (id, label, properties, required) => ({ id, label, description: label, kind: 'mutation', undoDomain: 'motion', input: input(properties, required) });
const setInput = elementSetSchema('motion');
// A collection transaction has no single native character target. Normalize
// that scope explicitly so begin/update carry the same target sentinel.
for (const variant of setInput.oneOf) variant.properties.characterId = { type: 'null', default: null };
const vector3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
const rangePin = input({ id: { ...id, maxLength: 64 }, track: { type: 'string', enum: ['leftHand', 'rightHand', 'leftFoot', 'rightFoot'] },
	startFrame: frame, endFrame: frame, blend: { type: 'integer', minimum: 1, maximum: 240 }, reach: { type: 'string', enum: ['limb', 'body'] },
	target: { oneOf: [input({ space: { const: 'world' }, position: vector3 }), input({ space: { const: 'object' }, objectId: id, local: vector3 })] },
}, ['id', 'track', 'startFrame', 'endFrame', 'blend', 'target']);
const rangePins = [
	mutation('motion.rangePin.apply', 'Apply range pin', { characterId: id, pin: rangePin, replaceExisting: { type: 'boolean', default: false } }, ['characterId', 'pin']),
	mutation('motion.rangePin.remove', 'Remove range pin', { characterId: id, pinId: id }),
];
const edits = [{ ...mutation('motion.set', 'Set take fields', {}), input: setInput }];
const tools = [
	mutation('ik.applyPose', 'Key full-body pose', { characterId: id, frame, pose: { type: 'object', properties: { bones: { type: 'object', properties: {}, required: [], additionalProperties: true }, rootY: { type: 'number' } }, required: ['bones'], additionalProperties: true } }),
];
// These only queue the existing editor producers. Their eventual take
// publication is owned above; generation-pipeline unification remains #444.
const legacyIk = ['character.setIkKey', 'character.removeIkKey', 'character.clearIkKeys'].map(studioActionDeclaration);
const ik = legacyIk.map((entry, index) => ({ ...entry, id: ['ik.setKey', 'ik.removeKey', 'ik.clearKeys'][index] }));

const moveIk = { ...mutation('ik.moveKey', 'Move IK key', { characterId: id, from: frame, to: frame }), exposure: 'ui-only' };
const clear = { id: 'motion.clear', label: 'Clear motion', description: 'Clear the character\'s compiled take and its IK corrections.',
	kind: 'mutation', undoDomain: 'motion', input: { type: 'object', properties: { characterId: { type: 'string' } }, required: ['characterId'], additionalProperties: false } };
export const declarations = Object.freeze([...tools, ...rangePins, ...edits, ...timingDeclarations, ...legacyIk, ...ik, moveIk, clear]);

export function register(registry, ports) {
	const owner = () => ports.storeDomain('motion');
	const mounted = () => Boolean(ports.storeDomain?.('motion')) || 'The motion owner is not mounted.';
	const take = characterId => { characterOf(ports, characterId); return owner().motionFor(characterId) ?? fail('TARGET_NOT_READY', 'Load a take for this character first.'); };
	for (const declaration of tools) registry.register({ ...declaration, available: mounted, run(args) {
		characterOf(ports, args.characterId);
		if (args.frame >= ports.state().frameCount) fail('INVALID_RANGE', 'IK frame is outside the timeline.');
		checkPoseBones(args.pose.bones);
		for (const angles of Object.values(args.pose.bones)) if (!Array.isArray(angles) || angles.length !== 3 || !angles.every(Number.isFinite)) fail('INVALID_ARGUMENT', 'Pose bones require three finite rotation angles.');
		owner().keyPose(args.characterId, args.frame, args.pose);
		return { affectedIds: [args.characterId], summary: declaration.label };
	} });
	for (const declaration of rangePins) registry.register({ ...declaration, available: mounted, run(args) {
		characterOf(ports, args.characterId);
		const output = declaration.id === 'motion.rangePin.apply'
			? owner().bakeRangePin(args.characterId, args.pin, args.replaceExisting)
			: owner().removePin(args.characterId, args.pinId);
		return { affectedIds: [args.characterId], summary: declaration.label, ...(output ? { output } : {}) };
	} });
	registerElementSet({ register(entry) { registry.register({ ...entry, available: mounted, run(args) {
		for (const op of args.ops ?? [args]) take(op.id);
		return entry.run(args);
	} }); } }, ports, edits[0]);
	registerTiming(registry, ports, mounted);
	for (const [index, declaration] of [...legacyIk, ...ik].entries()) registry.register({ ...declaration,
		available: state => state.characters.length > 0 || 'There are no characters in this scene.', run(args) {
			const character = characterOf(ports, args.characterId), kind = index % 3;
			if (kind === 0) {
				const { frame, tracks } = args, names = Object.keys(tracks);
				if (frame >= ports.state().frameCount) fail('INVALID_RANGE', 'IK frame is outside the timeline.');
				if (!names.length) fail('INVALID_ARGUMENT', 'Name at least one track.');
				for (const track of names) {
					const key = tracks[track], chain = STUDIO_IK_CHAIN_TRACKS.includes(track), bones = chain ? 3 : 1;
					if (!key.q && !key.p) fail('INVALID_ARGUMENT', `tracks.${track} needs q or p.`);
					if (key.chainP && !chain) fail('INVALID_ARGUMENT', `tracks.${track}.chainP is for chain tracks only.`);
					for (const field of ['q', 'baseQ', 'chainP']) if (key[field] && key[field].length !== bones) fail('INVALID_ARGUMENT', `tracks.${track}.${field} needs ${bones} entries.`);
					if ([...(key.q ?? []), ...(key.baseQ ?? [])].some(q => Math.hypot(q.x, q.y, q.z, q.w) < 1e-6)) fail('INVALID_ARGUMENT', `tracks.${track} has a zero-length quaternion.`);
				}
				ports.setCharacterIkKey(args.characterId, frame, tracks);
			} else if (kind === 1) ports.removeCharacterIkKey(args.characterId, args.frame);
			else ports.clearCharacterIkKeys(args.characterId);
			return { affectedIds: [character.id], summary: declaration.label };
		} });
	registry.register({ ...moveIk, available: mounted, run({ characterId, from, to }) {
		characterOf(ports, characterId);
		if (to >= ports.state().frameCount) fail('INVALID_RANGE', 'IK frame is outside the timeline.');
		owner().moveKey(characterId, from, to);
		return { affectedIds: [characterId], summary: moveIk.label };
	} });
	registry.register({ ...clear, available: () => Boolean(ports.storeDomain?.('motion')) || typeof ports.clearMotionNative === 'function' || 'The motion owner is not mounted.',
		run({ characterId }) {
			if (ports.storeDomain?.('motion')) { characterOf(ports, characterId); owner().clear(characterId); }
			else {
				if (ports.state().activeCharacterId !== characterId) fail('TARGET_NOT_READY', 'Select this character before clearing its take.');
				ports.clearMotionNative();
			}
			return { affectedIds: [characterId], summary: 'Cleared motion.' };
		} });
}
