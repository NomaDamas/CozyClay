// Motion and IK commands share one per-character authored-intent owner.
import { STUDIO_IK_CHAIN_TRACKS, studioActionDeclaration } from "../studio-actions.js";
import { fail, characterOf } from "./shared.js";
import { elementSetSchema, registerElementSet } from './elements.js';
import './elements/motion.js';
import './elements/character.js';
import { generationArgs } from '../motion/generation.js';
import { applyRootDrop, normalizeRootDrop } from '../ardy/root-drop.js';
import { characterScaleFor } from '../ardy/npz.js';
import { FAL_MOTION_DURATIONS } from '../fal-motion-client.js';
import { createMotionEdit, trimMotionEdit, splitMotionEdit, setMotionSegmentSpeed, removeMotionSegment } from '../ardy/motion-edit.js';
const id = { type: 'string', minLength: 1 }, frame = { type: 'integer', minimum: 0 };
const input = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const drop = { oneOf: [{ type: 'null' }, input({ from_s: { type: 'number', minimum: 0 }, to_s: { type: 'number', exclusiveMinimum: 0 }, meters: { type: 'number', exclusiveMinimum: 0, maximum: 30 } })] };
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
const edits = [
	{ ...mutation('motion.set', 'Set take fields', {}), input: setInput },
	mutation('motion.trim', 'Trim motion', { characterId: id, start: frame, end: frame }),
	mutation('motion.resetTrim', 'Restore full take', { characterId: id }),
	mutation('motion.cut', 'Cut motion segment', { characterId: id, frame }),
	mutation('motion.setSegmentSpeed', 'Set segment speed', { characterId: id, id, speed: { type: 'number', minimum: 0.05, maximum: 8 } }),
	mutation('motion.removeSegment', 'Remove motion segment', { characterId: id, id }),
	mutation('motion.fixCollisions', 'Fix body collisions', { characterId: id, scope: { type: 'string', enum: ['frame', 'clip'], default: 'frame' } }, ['characterId']),
];
const generate = { id: 'motion.generate', label: 'Generate motion', description: 'Generate the named character through the editor pipeline, following its prompt blocks, root path, pose pins and take lineage.',
	kind: 'job', domain: 'motion', generation: 'motion', background: true, timeoutMs: 1000,
	input: input({ characterId: id, drop, blocks: elementSetSchema('character').properties.set.properties.layer.properties.promptClips,
		durationSeconds: { type: 'number', minimum: 1, maximum: 1200 }, seed: { type: 'integer', minimum: 0, maximum: 2147483647 } }, ['characterId']) };
const prepared = { ...mutation('motion.applyPrepared', 'Apply prepared motion edit', { characterId: id, token: id }), exposure: 'ui-only' };
const loads = [
	{ id: 'motion.replace', label: 'Replace take', input: input({ characterId: id, url: id, prompt: { type: 'string', default: '' },
		blocks: { type: 'array', maxItems: 120, items: input({ startFrame: frame, endFrame: { ...frame, minimum: 1 }, prompt: { type: 'string' } }) },
		drop,
	}, ['characterId', 'url']) },
	{ id: 'motion.loadVersion', label: 'Restore take version', input: input({ characterId: id, motionUrl: id }) },
].map(entry => ({ ...entry, description: entry.label, kind: 'job', domain: 'motion' }));
const tools = [
	mutation('motion.applyPhysics', 'Apply reviewed physics', { characterId: id }),
	mutation('motion.editTrail', 'Edit motion trail', { characterId: id, track: { type: 'string', enum: ['hips', 'leftFoot', 'rightFoot', 'leftHand', 'rightHand', 'head'], default: 'hips' }, grabFrame: frame, radiusFrames: { ...frame, minimum: 1 }, delta: input({ x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }) }, ['characterId', 'grabFrame', 'radiusFrames', 'delta']),
	mutation('ik.applyPose', 'Key full-body pose', { characterId: id, frame, pose: { type: 'object', properties: { bones: { type: 'object', properties: {}, required: [], additionalProperties: true }, rootY: { type: 'number' } }, required: ['bones'], additionalProperties: true } }),
];
const physics = { id: 'motion.autoPhysics', label: 'Review motion physics', description: 'Analyse real rig motion and optionally apply one retained correction.', kind: 'job', domain: 'motion',
	input: input({ characterId: id, apply: { type: 'boolean', default: true }, strength: { type: 'number', minimum: 0, maximum: 1, default: 1 },
		protectedFrames: { type: 'array', items: frame, default: [] }, overrides: { type: 'array', default: [], items: input({
			site: { type: 'string', enum: ['leftFoot', 'rightFoot', 'leftHand', 'rightHand', 'leftKnee', 'rightKnee'] }, start: frame, end: frame,
			mode: { type: 'string', enum: ['plant', 'free'] },
		}) },
	}, ['characterId']) };
// These only queue the existing editor producers. Their eventual take
// publication is owned above; generation-pipeline unification remains #444.
const queued = ['motion.commitLineEdit', 'motion.regenerateTrail'].map(id => ({ id, label: id === 'motion.commitLineEdit' ? 'Commit line edit' : 'Regenerate trail edit',
	description: 'Queue the current editor draft through the existing generation producer.', kind: 'transient', exposure: 'ui-only', input: input({ characterId: { type: 'string' } }) }));
const legacyIk = ['character.setIkKey', 'character.removeIkKey', 'character.clearIkKeys'].map(studioActionDeclaration);
const ik = legacyIk.map((entry, index) => ({ ...entry, id: ['ik.setKey', 'ik.removeKey', 'ik.clearKeys'][index] }));

const clear = { id: 'motion.clear', label: 'Clear motion', description: 'Clear the active take, its corrections and take-owned cast fields.',
	kind: 'mutation', undoDomain: 'motion', input: { type: 'object', properties: { characterId: { type: 'string' } }, required: ['characterId'], additionalProperties: false } };
const videoDraft = { id: 'motion.setVideoDraft', label: 'Set video motion draft', description: 'Set the uncommitted AI-video form without changing the project or its history.', kind: 'transient',
	input: input({ instruction: { oneOf: [{ const: '' }, { type: 'string', maxLength: 3700 }] }, promptOverride: { oneOf: [{ const: '' }, { type: 'string', maxLength: 3700 }] }, duration: { oneOf: FAL_MOTION_DURATIONS.map(value => ({ const: value })) } }, []) };
export const declarations = Object.freeze([videoDraft, generate, ...queued, prepared, ...loads, physics, ...tools, ...rangePins, ...edits, ...legacyIk, ...ik, clear, ...["motion.generateAllBlocks", "motion.generateFromVideo"].map(studioActionDeclaration)]);

export function register(registry, ports) {
	const owner = () => ports.storeDomain('motion');
	const mounted = () => Boolean(ports.storeDomain?.('motion')) || 'The motion owner is not mounted.';
	const take = characterId => { characterOf(ports, characterId); return owner().motionFor(characterId) ?? fail('TARGET_NOT_READY', 'Load a take for this character first.'); };
	registry.register({ ...videoDraft, available: mounted, run(args) {
		owner().setVideoDraft(args);
		return { affectedIds: [], summary: videoDraft.label };
	} });
	registry.registerToolAlias('generate_motion', generate.id, generationArgs);
	registry.register({ ...generate, available: mounted, target: args => args.characterId, async run(args, context) {
		characterOf(ports, args.characterId);
		if (owner().isGenerating()) fail('TARGET_BUSY', 'A motion generation is already running.');
		if (args.drop && !normalizeRootDrop(args.drop)) fail('INVALID_ARGUMENT', 'Invalid drop.');
		if (args.blocks) context.run('character.setPromptBlocks', { characterId: args.characterId, blocks: args.blocks });
		const generationContext = !args.drop ? context : { ...context, commit: apply => context.commit(() => {
			const result = apply(), take = owner().motionFor(args.characterId), layer = owner().layer(args.characterId);
			owner().replace(args.characterId, applyRootDrop(take, args.drop, { worldScale: characterScaleFor(take) }), {
				recipe: layer.takeRecipe, versions: layer.takeVersions, ikKeys: layer.ikKeys,
			});
			owner().writeLayer(args.characterId, { committedIkEdits: layer.committedIkEdits });
			return result;
		}) };
		await owner().generate(args, generationContext);
		return { affectedIds: [args.characterId], summary: 'Generated motion.' };
	} });
	for (const declaration of queued) registry.register({ ...declaration, available: mounted, run({ characterId }) {
		characterOf(ports, characterId);
		if (ports.state().activeCharacterId !== characterId) fail('TARGET_NOT_READY', 'Select the character that owns this editor draft.');
		if (declaration.id === 'motion.commitLineEdit') owner().requestLineEdit(); else owner().requestTrailRegeneration();
		return { affectedIds: [], summary: declaration.label };
	} });
	registry.register({ ...prepared, available: mounted, run({ characterId, token }) {
		characterOf(ports, characterId); const result = owner().applyPrepared(token);
		return { affectedIds: result?.affectedIds ?? [characterId], summary: prepared.label };
	} });
	for (const declaration of loads) registry.register({ ...declaration, available: mounted, target: args => args.characterId, async run(args, context) {
		characterOf(ports, args.characterId); await owner().loadRemote(args, context);
		return { affectedIds: [args.characterId], summary: declaration.label };
	} });
	registry.register({ ...physics, available: mounted, target: args => args.characterId, async run(args, context) {
		characterOf(ports, args.characterId);
		return { affectedIds: [args.characterId], summary: physics.label, output: await owner().autoPhysics(args.characterId, args, context) };
	} });
	for (const declaration of tools) registry.register({ ...declaration, available: mounted, run(args) {
		characterOf(ports, args.characterId);
		if (declaration.id === 'motion.applyPhysics') owner().applyPhysics(args.characterId);
		else if (declaration.id === 'motion.editTrail') owner().editTrail(args.characterId, args);
		else {
			if (args.frame >= ports.state().frameCount) fail('INVALID_RANGE', 'IK frame is outside the timeline.');
			for (const angles of Object.values(args.pose.bones)) if (!Array.isArray(angles) || angles.length !== 3 || !angles.every(Number.isFinite)) fail('INVALID_ARGUMENT', 'Pose bones require three finite rotation angles.');
			owner().keyPose(args.characterId, args.frame, args.pose);
		}
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
	for (const declaration of edits.slice(1)) registry.register({ ...declaration, available: mounted, run(args) {
		const { characterId } = args; characterOf(ports, characterId);
		if (declaration.id === 'motion.fixCollisions') owner().fix(characterId, args.scope);
		else {
			const current = take(characterId), full = owner().fullMotionFor(characterId);
			let segments = current.editSegments;
			if (declaration.id === 'motion.trim') {
				if (args.start > args.end || args.end >= current.frames) fail('INVALID_RANGE', 'Trim range is outside the take.');
				segments = trimMotionEdit(segments, args.start, args.end);
			} else if (declaration.id === 'motion.resetTrim') segments = createMotionEdit(full.frames);
			else if (declaration.id === 'motion.cut') segments = splitMotionEdit(segments, args.frame);
			else if (declaration.id === 'motion.setSegmentSpeed') segments = setMotionSegmentSpeed(segments, args.id, args.speed);
			else { if (segments.length <= 1) fail('INVALID_ARGUMENT', 'Use motion.clear to remove the final segment.'); segments = removeMotionSegment(segments, args.id); }
			if (segments !== current.editSegments) owner().editSegments(characterId, segments);
		}
		return { affectedIds: [characterId], summary: declaration.label };
	} });
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
	registry.register({ ...clear, available: () => Boolean(ports.storeDomain?.('motion')) || typeof ports.clearMotionNative === 'function' || 'The motion owner is not mounted.',
		run({ characterId }) {
			if (ports.storeDomain?.('motion')) { characterOf(ports, characterId); owner().clear(characterId); }
			else {
				if (ports.state().activeCharacterId !== characterId) fail('TARGET_NOT_READY', 'Select this character before clearing its take.');
				ports.clearMotionNative();
			}
			return { affectedIds: [characterId], summary: 'Cleared motion.' };
		} });
	registry.register({ ...studioActionDeclaration("motion.generateAllBlocks"), target: () => ports.state().activeCharacterId,
		available: state => state.generating ? "A motion generation is already running."
			: !state.motionReady ? "The motion backend is not ready."
				: state.promptBlockCount === 0 ? "The active character has no prompt block with text; write them with patch_elements character.promptBlocks." : true,
		run: (_args, context) => {
			const { activeCharacterId, promptBlockCount } = ports.state();
			const shown = ports.runAllPromptBlocks(context) ?? [];
			if (shown?.then) return shown.then(() => ({ affectedIds: activeCharacterId ? [activeCharacterId] : [], summary: `Generated motion from ${promptBlockCount} prompt blocks.` }));
			// The generation queues synchronously or not at all; when it does not,
			// the editor's last toast names the refusal (rig not loaded, a root
			// waypoint outside the clip, an over-long block, a line-edit draft).
			if (!ports.state().generating) fail("TARGET_NOT_READY", shown.length ? `Generation not started: ${shown.at(-1)}` : "The editor did not start the generation; check the active character's rig and prompt blocks.");
			return { affectedIds: activeCharacterId ? [activeCharacterId] : [], summary: `Started generating the active character's motion from ${promptBlockCount} prompt block${promptBlockCount === 1 ? "" : "s"}.` };
		} });
	// AI-video motion: the agent panel's Generate motion (generateFalMotion
	// "act"), awaited to its clip. The Fal card shows every failure it meets, so
	// a refusal is silent in the UI and tells the model the reason in English.
	registry.register({ ...studioActionDeclaration("motion.generateFromVideo"), domain: "motion", target: () => ports.state().activeCharacterId,
		available: ({ falMotion }) => !falMotion.enabled ? "AI video motion (Fal) is not enabled for this account."
			: !["idle", "done", "error", "failed"].includes(falMotion.status) ? "An AI video motion generation is already running; wait for it to finish."
				: falMotion.dailyRemaining === 0 ? "The account's daily AI video generations are used up." : true,
		run: async ({ instruction }, context) => {
			const outcome = await ports.generateFalMotion("act", instruction, context);
			if (outcome.failed) fail("TARGET_NOT_READY", outcome.failed);
			const { job, footage, dailyRemaining } = outcome;
			if (!job.video?.url) fail("TARGET_NOT_READY", "The AI video model finished without returning a video.");
			return { affectedIds: [], output: { videoUrl: job.video.url, resolution: job.resolution ?? null, durationSeconds: job.resultDuration ?? job.duration ?? null,
				ingested: Boolean(footage), frames: footage?.frames ?? null, fps: footage?.fps ?? null, dailyRemaining },
			summary: footage
				? `The AI video (${job.resolution}, ${footage.frames} frames at ${footage.fps} fps) is ingested as Video capture footage and the timeline now spans it; its motion becomes a take once GVHMR extraction runs in the Video capture panel.`
				: `The AI video is ready at ${job.video.url}, but ingesting it as footage failed; the Video capture panel shows why.` };
		} });
}
