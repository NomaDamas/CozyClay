import {
	I2V_MOTION_STILL_OUTPUT, I2V_MOTION_SHOT_ASPECT, I2V_MOTION_MIN_DURATION,
	waitForMotionJob, submitMotionJob, buildH3MotionPrompt,
} from "../i2v-motion-client.js";
import { useState, useEffect, useSyncExternalStore, useContext, useRef, useMemo } from "react";
import { AppContext } from '../app-context.js';
import { createDocumentStore } from '../document-store.js';
import { useDocumentDomain } from '../store/use-document-store.js';
import { createPhysicsProgress } from "../ardy/physics-panel.jsx";
import {
	TIMELINE_FPS,
	hierarchyIdForIkFocus,
	ARDY_PRESERVE_DEFAULT,
	MULTIMODEL_REASONS,
	nextCharacterId,
	REST_BONES,
	ARDY_SEED_MAX,
	lineTrackLabel,
	ARDY_DURATION_MIN,
	buildPromptSchedule,
	toArdyFrameEntries,
	posePlacementFrame,
	toArdySegments,
	ARDY_FPS,
	toArdyFrame,
} from "../app-stage.jsx";
import { copyPhysicsKeys, physicsKeyStamp, reviewAutoPhysics } from "../ardy/physics-review.js";
import { fitPlatforms } from "../ardy/platform-fit.js";
import {
	createIkState,
	ikTouch,
	ikKeyframes,
	ikRemoveKeyframe,
	ikSeedTargets,
	clampIkTargetToFloor,
	solveIk,
	MID_TRACKS,
	solveMidJoint,
	solveEffectorSwing,
	ikPlantFeet,
	solveHipsTranslateToFloor,
	solveHipsTranslate,
	solveSwingAngle,
	ikSolvePlantedFeet,
	applyBodyContact,
	ikBakeKeyframe,
	ikEvaluate,
	resolveIkRig,
} from "../ardy/ik.js";
import * as THREE from "three";
import { StudioProtocolError } from "../studio-agent-protocol.js";
import { restorePlaybackBones, snapshotPlaybackBones, applyMotionFrame, captureArdyRoot } from "../ardy/playback.js";
import { isKo, ko } from "../locale.js";
import {
	isPlatformPageUrl,
	normalizeSourceUrl,
	sourceLabel,
	requestBridgeFootage,
	fetchFootageBlob,
	probeFootage,
	requestBridgeExtract,
} from "../multimodel-ingest.js";
import { characterScaleFor, loadMotionFromUrl } from "../ardy/npz.js";
import { supportHeightForObject, OBJECT_LIBRARY } from "../scene-objects.js";
import { applySupportRise, autoRoofDrop, applyAutoFall, applyRootDrop, normalizeRootDrop } from "../ardy/root-drop.js";
import { takeAnchor, createCharacterEntry } from "../scenes.js";
import { retimeMotion } from "../ardy/retime.js";
import {
	createMotionEdit,
	renderMotionEdit,
	remapFrameKeyMap,
	remapTimelineFrame,
} from "../ardy/motion-edit.js";
import { DEFAULT_POSE, restoreBindPositions, applyPose, applyHipsOffset } from "../poses.js";
import { normalizeMotionCalibration, applyMotionCalibration } from "../ardy/motion-calibration.js";
import { collisionBlockers } from "../ardy/collision-blockers.js";
import { fixCollisions, fixCollisionsRange } from "../ardy/fix-collisions.js";
import { trackFeature, startMotionRequest, motionPreflightReason, trackActivation } from "../analytics.js";
import { buildArdyPose } from "../ardy/export.js";
import { slateLine } from "../shot.js";
import { motionReadiness } from "../motion-readiness.js";
import { motionReadinessMessage } from "../motion-readiness-ui.jsx";
import {
	resolveSeed,
	stripSourceMotion,
	blocksFromRequest,
	replayPayload,
	freshRecipe,
	withLineEdit,
	pushTakeVersion,
	TAKE_VERSIONS_MAX,
} from "../take-recipe.js";
import { buildGenerationRequest, generationRefusal } from '../motion/generation.js';
import { planPosePin } from '../ardy/pose-pin.js';
import { applyTrailFalloffDelta, restoreTrailEdits, trailEditRange, worldDeltaToTrailClip } from "../motion-trail.js";
import { bakeIkDragKey, chainsChangedBy, ikDragRecord, ikDragTouch } from "../ardy/ik-drag.js";
import { ikKeyJson, ikTrackKeyFromJson } from "../ardy/ik-key-json.js";
import { findAbsoluteIkKeyConflicts } from "../trail-key-conflicts.js";
import { chooseIkEntryPose } from "../ik-camera.js";
import { generate as ardyGenerate } from "../ardy/client.js";
import { isLineEditUnsupported } from "../line-edit.js";
import { openMotionDb, getMotion, putMotion } from "../motion-store.js";
import { resolveMotionSource, decodeMotionResource, encodeMotionResource, sha256Hex } from "../motion-resources.js";
import { applyRangePin, captureRangePinTarget, normalizeRangePin, rangePinTargetWorld, rangePinTracks, removeRangePinKeys } from "../ardy/range-pin.js";
import { rangePinObjectMatrixAt } from "../range-pin-object-transform.js";

const sameMotionIntent = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const emptyMotionLayer = id => ({ id, take: null, fullTake: null, ikKeys: [], ikPins: [], ikPinResiduals: [], committedIkEdits: [], takeRecipe: null, takeVersions: [] });
const keyVector = p => ({ x: p.x, y: p.y, z: p.z });
const keyQuaternion = q => ({ ...keyVector(q), w: q.w });
function encodeMotionKeys(keys) {
	return [...keys].sort(([a], [b]) => a - b).map(([frame, tracks]) => ({ frame, tracks: Object.fromEntries([...tracks].map(([track, key]) => [track, {
		...(key.q ? { q: key.q.map(keyQuaternion) } : {}), ...(key.p ? { p: keyVector(key.p) } : {}),
		...(key.baseQ ? { baseQ: key.baseQ.map(keyQuaternion) } : {}), ...(key.basePos ? { basePos: keyVector(key.basePos) } : {}),
		...(key.chainP ? { chainP: key.chainP.map(keyVector) } : {}), ...(key.keepTranslations ? { keepTranslations: true } : {}),
		...(key.blend != null ? { blend: key.blend } : {}),
		...(key.pin ? { pin: key.pin } : {}),
	}])) }));
}
function decodeMotionKeys(rows) {
	const q = value => new THREE.Quaternion(value.x, value.y, value.z, value.w).normalize();
	const p = value => new THREE.Vector3(value.x, value.y, value.z);
	return new Map(rows.map(row => [row.frame, new Map(Object.entries(row.tracks).map(([track, key]) => [track, {
		q: key.q?.map(q) ?? null, p: key.p ? p(key.p) : null,
		...(key.baseQ ? { baseQ: key.baseQ.map(q) } : {}), ...(key.basePos ? { basePos: p(key.basePos) } : {}),
		...(key.chainP ? { chainP: key.chainP.map(p) } : {}), ...(key.keepTranslations ? { keepTranslations: true } : {}),
		...(key.blend != null ? { blend: key.blend } : {}),
		...(key.pin ? { pin: key.pin } : {}),
	}]))]));
}
function cloneRangePin(pin) {
	return {
		...pin,
		target: pin.target.space === "world"
			? { space: "world", position: [...pin.target.position] }
			: { space: "object", objectId: pin.target.objectId, local: [...pin.target.local] },
	};
}
function encodeRangePins(pins) {
	return [...(pins instanceof Map ? pins.values() : pins ?? [])].map(cloneRangePin);
}
function decodeRangePins(rows) {
	return new Map((rows ?? []).map((pin) => [pin.id, cloneRangePin(pin)]));
}
function encodeRangePinResiduals(values) {
	return [...(values instanceof Map ? values.entries() : values ?? [])].map(([id, entries]) => [id, (entries ?? []).map((entry) => ({ ...entry }))]);
}
function decodeRangePinResiduals(rows) {
	return new Map((rows ?? []).map(([id, entries]) => [id, (entries ?? []).map((entry) => ({ ...entry }))]));
}

// Plain intent owns take identities and JSON keys. Decoded buffers and rig
// preimages are copy-on-record runtime resources, never mutable store values.
export function createMotionDomain(appContext, characters) {
	const takes = new Map(), decoded = new WeakMap(), rigImages = new WeakMap(), previews = new Map(), prepared = new Map();
	let running = 0;
	const references = entries => entries.map(entry => {
		const ref = entry.motionRef;
		const take = ref ? { resourceId: `restore:${entry.id}:${ref.motionId ?? ref.url}`, url: ref.url ?? null, anchorX: ref.anchorX, anchorZ: ref.anchorZ,
			rotationDeg: ref.rotationDeg, prompt: ref.prompt ?? '', ...(ref.trailEdits ? { trailEdits: ref.trailEdits } : {}), ...(ref.studioTakeId ? { studioTakeId: ref.studioTakeId } : {}) } : null;
		return { id: entry.id, take, fullTake: take, takeVersions: ref?.url ? [{ motionUrl: ref.url, recipe: null, savedAt: Date.now(), label: ko('Loaded', '불러옴') }] : [] };
	});
	function snapshotTake(take) {
		if (!take) return null;
		if (take.resourceId) return { ...take };
		const resourceId = crypto.randomUUID(), copy = structuredClone(take);
		takes.set(resourceId, copy);
		return { resourceId, frames: take.frames, fps: take.fps, url: take.url ?? null, prompt: take.prompt ?? '',
			anchorX: take.anchorX ?? 0, anchorZ: take.anchorZ ?? 0, anchorFrame: take.anchorFrame ?? 0, rotationDeg: take.rotationDeg ?? 0,
			...(take.trailEdits ? { trailEdits: take.trailEdits } : {}),
			editSegments: take.editSegments ?? createMotionEdit(take.frames), studioTakeId: take.studioTakeId ?? resourceId };
	}
	const normalize = rows => rows.map(row => ({ ...emptyMotionLayer(row.id), ...row,
		take: snapshotTake(row.take), fullTake: snapshotTake(row.fullTake ?? row.take),
		ikKeys: row.ikKeys ?? [], ikPins: row.ikPins ?? [], ikPinResiduals: row.ikPinResiduals ?? [], committedIkEdits: row.committedIkEdits ?? [] }));
	let native = createDocumentStore({ owned: { motion: normalize(references(characters)) } });
	const listeners = new Set(), notify = () => { for (const listener of listeners) listener(); };
	let release = native.subscribe(notify), viewRevision = 0;
	const documentStore = { ...Object.fromEntries(Object.keys(native).map(key => [key, (...args) => native[key](...args)])),
		subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
	const read = () => documentStore.read('motion');
	const layer = id => read().find(row => row.id === id) ?? emptyMotionLayer(id);
	function materialize(take) {
		if (!take || !takes.has(take.resourceId)) return null;
		if (!decoded.has(take)) {
			const { resourceId, ...metadata } = take;
			decoded.set(take, { ...takes.get(resourceId), ...metadata });
		}
		return decoded.get(take);
	}
	const motionFor = id => materialize(layer(id).take), fullMotionFor = id => materialize(layer(id).fullTake);
	const visibleMotion = id => previews.get(id) ?? motionFor(id);
	const frame = () => appContext.live.state?.timeline.currentFrame ?? 0;
	const rigFor = id => appContext.shared.rigs[id];
	function rigSnapshots() {
		return new Map(Object.entries(appContext.shared.rigs).map(([id, rig]) => [id, appContext.shared.snapshotExportRig(rig)]));
	}
	let publishedIds = new Set();
	function project() {
		const cast = appContext.storeDomain('cast'), states = appContext.shared.ikStatesRef.current, savedRigs = rigImages.get(read());
		const ids = new Set([...publishedIds, ...read().map(row => row.id)]);
		for (const id of ids) {
			const row = layer(id), take = visibleMotion(id), full = fullMotionFor(id);
			cast.publishMotion(id, take);
			if (full) appContext.shared.motionFullRef.current.set(id, full); else appContext.shared.motionFullRef.current.delete(id);
			const state = states.get(id) ?? createIkState();
			state.keys = decodeMotionKeys(row.ikKeys); state.tracked = new Set([...state.keys.values()].flatMap(entry => [...entry.keys()]));
			state.pins = decodeRangePins(row.ikPins);
			state.pinResiduals = decodeRangePinResiduals(row.ikPinResiduals);
			states.set(id, state);
			const rig = rigFor(id);
			if (rig) {
				const resolved = resolveIkRig(rig); if (resolved) Object.assign(state, resolved, { rig });
				if (savedRigs?.has(id) && !previews.has(id)) appContext.shared.restoreExportRig(savedRigs.get(id));
				else if (resolved) {
					if (take) applyMotionFrame(rig, take, Math.min(frame(), take.frames - 1));
					else {
						const character = cast.read().find(entry => entry.id === id);
						restoreBindPositions(rig); applyPose(rig, { ...REST_BONES, ...(character?.pose ?? DEFAULT_POSE).bones });
						applyHipsOffset(rig, character?.pose?.rootY ?? 0);
					}
					ikEvaluate(resolved.chains, state, frame(), resolved.fkJoints, take ? 6 : 0);
				}
			}
		}
		publishedIds = new Set(read().map(row => row.id));
		const id = appContext.shared.loadedLayerCharRef.current;
		appContext.shared.ikStateRef.current = states.get(id) ?? createIkState();
		appContext.shared.bufferRef.current = { ...appContext.shared.bufferRef.current, motion: visibleMotion(id), ik: appContext.shared.ikStateRef.current };
		appContext.shared.takeRecipeRef.current = layer(id).takeRecipe;
		domain.onProject?.(); viewRevision++;
	}
	const unsubscribe = documentStore.subscribe(project);
	function write(update) {
		return documentStore.write('motion', before => {
			const next = normalize(typeof update === 'function' ? update(before) : update);
			return sameMotionIntent(before, next) ? before : next;
		});
	}
	function writeLayer(id, patch) {
		return write(rows => rows.some(row => row.id === id) ? rows.map(row => row.id === id ? { ...row, ...patch } : row) : [...rows, { ...emptyMotionLayer(id), ...patch }]);
	}
	function pruneTakes() {
		const history = documentStore.history(), ids = new Set([read(), ...[...history.past, history.present, ...history.future].map(entry => entry.snapshot.motion)]
			.flatMap(rows => rows.flatMap(row => [row.take?.resourceId, row.fullTake?.resourceId])).filter(Boolean));
		for (const id of takes.keys()) if (!ids.has(id)) takes.delete(id);
	}
	function beginAction() {
		rigImages.set(read(), gesture?.rigs ?? rigSnapshots());
		const session = documentStore.beginAction('motion');
		return { ...session,
			run(fn) { return session.run(() => { running++; try { return fn(); } finally { running--; } }); },
			commit() { const result = session.commit(); rigImages.set(read(), rigSnapshots()); pruneTakes(); return result; },
		};
	}
	function setKeys(id, keys) { return writeLayer(id, { ikKeys: encodeMotionKeys(keys) }); }
	function setRangePinState(id, state) {
		return writeLayer(id, { ikKeys: encodeMotionKeys(state.keys), ikPins: encodeRangePins(state.pins), ikPinResiduals: encodeRangePinResiduals(state.pinResiduals) });
	}
	function rangePinState(id) {
		const row = layer(id), keys = decodeMotionKeys(row.ikKeys);
		return { ...createIkState(), keys, tracked: new Set([...keys.values()].flatMap(entry => [...entry.keys()])), pins: decodeRangePins(row.ikPins), pinResiduals: decodeRangePinResiduals(row.ikPinResiduals) };
	}
	function removePin(id, pinId) {
		const state = rangePinState(id);
		removeRangePinKeys(state, pinId); state.pins.delete(pinId); state.pinResiduals.delete(pinId);
		setRangePinState(id, state);
	}
	function bakeRangePin(id, spec, replaceExisting = false, projectionOnly = false) {
		const motion = motionFor(id), rig = rigFor(id), resolved = rig && resolveIkRig(rig);
		if (!motion || !resolved) throw new StudioProtocolError('TARGET_NOT_READY', 'Load a take and rig for this character first.');
		const pin = normalizeRangePin(spec, { clipFrames: motion.frames }), state = rangePinState(id);
		const tracks = rangePinTracks(pin);
		const overlap = [...state.pins.values()].find(other => other.id !== pin.id && rangePinTracks(other).some(track => tracks.includes(track)) && Math.max(pin.startFrame, other.startFrame) <= Math.min(pin.endFrame, other.endFrame));
		if (overlap) throw new StudioProtocolError('INVALID_ARGUMENT', 'A required track already has an overlapping pin.');
		for (let at = pin.startFrame; at <= pin.endFrame; at++) {
			const entry = state.keys.get(at); if (!entry) continue;
			for (const track of tracks) if (entry.has(track) && entry.get(track).pin !== pin.id) {
				if (!replaceExisting) throw new StudioProtocolError('INVALID_ARGUMENT', 'Confirm Replace existing keys before applying this pin.');
				entry.delete(track);
			}
			if (!entry.size) state.keys.delete(at);
		}
		const objectWorldMatrix = (objectId, at) => {
			const object = appContext.shared.sceneObjects.find(entry => entry.id === objectId);
			if (!object) return null;
			const local = rangePinObjectMatrixAt(object, at, { frameCount: motion.frames, fps: motion.fps }, new THREE.Matrix4());
			const parent = object.attach && appContext.shared.attachFrameRef?.current?.(object.attach.characterId, object.attach.bone ?? null, new THREE.Matrix4());
			return parent ? parent.multiply(local) : local;
		};
		const applyRaw = at => appContext.shared.poseMemberAtFrame(rig, motion, null, at);
		const savedKeys = state.keys;
		let result;
		try {
			result = applyRangePin({ ...resolved, ikState: state, pin, objectWorldMatrix, applyRaw,
				applyLayer(at) { applyRaw(at); ikEvaluate(resolved.chains, state, at, resolved.fkJoints, 6); } });
		} finally { state.keys = savedKeys; }
		removeRangePinKeys(state, pin.id);
		for (const [at, entry] of result.entries) {
			let frameEntry = state.keys.get(at); if (!frameEntry) state.keys.set(at, (frameEntry = new Map()));
			for (const [track, key] of entry) { frameEntry.set(track, key); state.tracked.add(track); }
		}
		state.pins.set(pin.id, cloneRangePin(pin));
		state.pinResiduals.set(pin.id, result.residuals.map(entry => ({ ...entry })));
		// A reload refreshes only the projected bake; authored edits use the bus.
		if (projectionOnly) Object.assign(appContext.shared.ikStatesRef.current.get(id), state);
		else setRangePinState(id, state);
		return { residuals: result.residuals };
	}
	function editKeys(id, mutate) {
		const state = { ...createIkState(), keys: decodeMotionKeys(layer(id).ikKeys) };
		state.tracked = new Set([...state.keys.values()].flatMap(entry => [...entry.keys()]));
		const result = mutate(state); setKeys(id, state.keys); return result;
	}
	function setKey(id, at, tracks) {
		editKeys(id, state => {
			const incoming = decodeMotionKeys([{ frame: at, tracks }]).get(at), entry = state.keys.get(at) ?? new Map();
			for (const [track, key] of incoming) entry.set(track, key); state.keys.set(at, entry);
		});
	}
	function castWrite(update) { return appContext.recordAction('cast', () => appContext.storeDomain('cast').write(update), null, true); }
	function synchronizeTimeline() { appContext.storeDomain('cast').syncTimeline(); }
	function replace(id, take, { fullTake = take, ikKeys = [], ikPins = [], ikPinResiduals = [],
		recipe = take ? { seed: null, blocks: [{ prompt: take.prompt ?? '', duration: take.frames / take.fps }], lineEdits: [] } : null,
		versions = take?.url ? pushTakeVersion(layer(id).takeVersions, { motionUrl: take.url, recipe, savedAt: Date.now(), label: ko('Loaded', '불러옴') }, TAKE_VERSIONS_MAX) : layer(id).takeVersions,
	} = {}) {
		previews.delete(id);
		writeLayer(id, { take: snapshotTake(take), fullTake: snapshotTake(fullTake), ikKeys, ikPins, ikPinResiduals, takeRecipe: recipe, takeVersions: versions, committedIkEdits: [] });
		synchronizeTimeline();
	}
	function clear(id) {
		previews.delete(id);
		writeLayer(id, { take: null, fullTake: null, ikKeys: [], ikPins: [], ikPinResiduals: [], committedIkEdits: [], takeRecipe: null });
		castWrite(rows => rows.map(row => row.id === id ? { ...row, scale: 1, motionRef: null,
			layer: { ...row.layer, promptClips: [] } } : row));
		synchronizeTimeline();
	}
	function editSegments(id, segments) {
		const full = fullMotionFor(id), take = motionFor(id);
		if (!full || !take) throw new StudioProtocolError('TARGET_NOT_READY', 'This character has no take to edit.');
		const previous = take.editSegments, rendered = { ...renderMotionEdit(full, segments), url: null };
		const keys = remapFrameKeyMap(decodeMotionKeys(layer(id).ikKeys), previous, segments);
		writeLayer(id, { take: snapshotTake(rendered), ikKeys: encodeMotionKeys(keys) });
		castWrite(rows => rows.map(row => row.id !== id ? row : { ...row, layer: { ...row.layer,
			promptClips: row.layer.promptClips.flatMap(clip => {
				const start = remapTimelineFrame(previous, segments, clip.startFrame), end = remapTimelineFrame(previous, segments, clip.endFrame);
				if (start === null && end === null) return [];
				const startFrame = Math.max(0, Math.min(start ?? 0, rendered.frames - 1));
				const endFrame = Math.max(0, Math.min(end ?? rendered.frames - 1, rendered.frames - 1));
				return startFrame <= endFrame ? [{ ...clip, startFrame, endFrame }] : [];
			}) } }));
		synchronizeTimeline();
	}
	function fix(id, scope = 'frame') {
		const rig = rigFor(id), resolved = rig && resolveIkRig(rig);
		if (!resolved) throw new StudioProtocolError('TARGET_NOT_READY', 'The character rig is not loaded.');
		const state = appContext.shared.ikStatesRef.current.get(id) ?? { ...createIkState(), ...resolved };
		const blockers = at => collisionBlockers({ rigs: appContext.shared.rigs, activeId: id, characterIds: appContext.live.characters,
			sceneObjects: appContext.ports.read().objects, library: OBJECT_LIBRARY, frame: at, take: { frameCount: motionFor(id)?.frames ?? 1, fps: 24 } });
		if (scope === 'clip') {
			const take = motionFor(id); if (!take) throw new StudioProtocolError('TARGET_NOT_READY', 'Load a take first.');
			const originals = rigSnapshots();
			try {
				fixCollisionsRange({ rig, ...resolved, ikState: state, startFrame: 0, endFrame: take.frames - 1,
					applyFrame(at) { applyMotionFrame(rig, take, at); ikEvaluate(resolved.chains, state, at, resolved.fkJoints, 6); },
					blockersAt(at) { for (const row of read()) if (row.id !== id) appContext.shared.poseMemberAtFrame(rigFor(row.id), motionFor(row.id), appContext.shared.ikStatesRef.current.get(row.id), at, 6); return blockers(at); } });
			} finally { for (const snapshot of originals.values()) appContext.shared.restoreExportRig(snapshot); }
		} else {
			const result = fixCollisions(rig, resolved.chains, { ikState: state, fkJoints: resolved.fkJoints, blockers: blockers(frame()) });
			if (!result.supported) throw new StudioProtocolError('TARGET_NOT_READY', 'This rig does not support collision cleanup.');
			if (result.changed) ikBakeKeyframe(resolved.chains, state, frame(), resolved.fkJoints, result.touched, null, result.baseQuats);
		}
		setKeys(id, state.keys);
	}
	function bakeCurrentKey(id, at, dragIds = null) {
		const rig = rigFor(id), resolved = rig && resolveIkRig(rig);
		if (!resolved) return null;
		const take = motionFor(id);
		if (dragIds) {
			const keyed = bakeIkDragKey(resolved.chains, resolved.fkJoints, at, dragIds, take
				? (rawRig) => applyMotionFrame(rawRig, take, at)
				: null);
			if (keyed && take) for (const key of keyed.values()) key.blend = 6;
			return keyed ? run('ik.setKey', { characterId: id, frame: at, tracks: ikKeyJson(keyed) }) : null;
		}
		const scratch = { ...createIkState(), tracked: new Set(appContext.shared.ikStatesRef.current.get(id)?.tracked) };
		ikBakeKeyframe(resolved.chains, scratch, at, resolved.fkJoints);
		const keyed = encodeMotionKeys(scratch.keys)[0];
		return keyed ? run('ik.setKey', { characterId: id, frame: at, tracks: keyed.tracks }) : null;
	}
	function keyPose(id, at, pose) {
		const rig = rigFor(id), resolved = rig && resolveIkRig(rig);
		if (!resolved) throw new StudioProtocolError('TARGET_NOT_READY', 'The character rig is not loaded.');
		restoreBindPositions(rig); applyPose(rig, { ...REST_BONES, ...pose.bones }); applyHipsOffset(rig, pose.rootY ?? 0);
		editKeys(id, state => {
			state.tracked = new Set([...resolved.chains.keys(), ...resolved.fkJoints.keys()]);
			ikBakeKeyframe(resolved.chains, state, at, resolved.fkJoints);
		});
	}
	function editTrail(id, { track = "hips", grabFrame, radiusFrames, delta }) {
		const take = motionFor(id), character = appContext.storeDomain('cast').read().find(row => row.id === id);
		if (!take) throw new StudioProtocolError('TARGET_NOT_READY', 'Load a take first.');
		const scale = character.scale ?? 1;
		const rig = rigFor(id);
		const clipDelta = worldDeltaToTrailClip(take, delta, { track, grabFrame, radiusFrames, rig, scale });
		const edited = snapshotTake(applyTrailFalloffDelta(take, { track, grabFrame, radiusFrames, clipDelta }));
		writeLayer(id, { take: edited });
		castWrite(rows => rows.map(row => row.id === id ? { ...row, motionRef: { ...row.motionRef, trailEdits: edited.trailEdits } } : row));
	}
	const physicsReviews = new Map();
	let physicsJob = 0;
	const physicsStamp = id => JSON.stringify([layer(id), appContext.storeDomain('cast').read().find(row => row.id === id)]);
	function applyPhysics(id) {
		const preview = physicsReviews.get(id);
		if (!preview || preview.stamp !== physicsStamp(id)) throw new StudioProtocolError('STALE_TARGET', 'Analyse this take again before applying corrections.');
		setKeys(id, preview.result.candidate.keys);
		domain.onPhysicsPreview?.(null);
	}
	async function autoPhysics(id, options, context) {
		const rig = rigFor(id), resolved = rig && resolveIkRig(rig), take = motionFor(id);
		if (!resolved || !take) throw new StudioProtocolError('TARGET_NOT_READY', 'Load a take and character rig first.');
		const job = ++physicsJob, stamp = physicsStamp(id), original = appContext.shared.snapshotExportRig(rig);
		let lastYield = performance.now();
		const check = () => { context.check(); if (job !== physicsJob) throw new StudioProtocolError('STALE_TARGET', 'Physics analysis was superseded.'); };
		domain.onPhysicsRunning?.(true); domain.onPhysicsPreview?.(null);
		try {
			check();
			const result = await reviewAutoPhysics({ rig, ...resolved, motion: take, sourceKeys: decodeMotionKeys(layer(id).ikKeys),
				applyRaw: at => applyMotionFrame(rig, take, at), sceneObjects: appContext.ports.read().objects,
				...options, cache: appContext.shared.physicsSourceCacheRef.current, onProgress: value => domain.onPhysicsProgress?.(value),
				yieldFrame: async () => {
					check(); if (performance.now() - lastYield < 16) return;
					appContext.shared.restoreExportRig(original);
					await new Promise(resolve => { const channel = new MessageChannel(); channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); }; channel.port2.postMessage(0); });
					lastYield = performance.now(); check();
				},
			});
			appContext.shared.restoreExportRig(original); check();
			physicsReviews.set(id, { result, stamp });
			if (options.apply) context.commit(() => applyPhysics(id)); else domain.onPhysicsPreview?.(result);
			return { before: result.before, after: result.after, changedFrames: result.changedFrames.length, warnings: result.warnings, unresolved: result.unresolved };
		} finally {
			if (job === physicsJob) { if (stamp === physicsStamp(id)) appContext.shared.restoreExportRig(original); domain.onPhysicsRunning?.(false); }
		}
	}
	function runPrepared(characterId, apply) {
		if (running) return apply();
		let result;
		const token = crypto.randomUUID(); prepared.set(token, () => { result = apply(); return result; });
		try { run('motion.applyPrepared', { characterId, token }); return result; }
		finally { prepared.delete(token); }
	}
	function persistTake(take, motionRef) {
		if (!take?.sourceBytes) return;
		(async () => {
			let record = appContext.shared.motionEncodingCacheRef.current.get(take.sourceBytes);
			if (!record) { record = await encodeMotionResource(take.sourceBytes, { prompt: motionRef?.prompt, sourceUrl: motionRef?.url }); appContext.shared.motionEncodingCacheRef.current.set(take.sourceBytes, record); }
			appContext.shared.projectMotionsRef.current.set(record.motionId.toLowerCase(), record);
			const db = await openMotionDb(); try { await putMotion(db, record); } finally { db.close(); }
		})().catch(error => console.warn('[cozyclay] could not cache motions', error));
	}
	function run(id, args) {
		const result = appContext.bus.run(id, args);
		const checked = receipt => { if (!receipt.ok) throw new StudioProtocolError(receipt.code, receipt.message); return receipt; };
		return result?.then ? result.then(checked) : checked(result);
	}
	let gesture = null;
	function finishGesture(cancel = false) {
		if (!gesture) return;
		const active = gesture; gesture = null; active.unsubscribe?.(); active.release?.();
		if (cancel && !active.txId) for (const image of active.rigs.values()) appContext.shared.restoreExportRig(image);
		if (active.txId) return run(cancel ? 'run.cancel' : 'run.commit', { txId: active.txId });
	}
	function beginGesture() {
		if (gesture) return;
		const commit = () => finishGesture(), cancel = () => finishGesture(true), key = event => { if (event.key === 'Escape') cancel(); };
		const events = { pointerup: commit, pointercancel: cancel, blur: commit, keydown: key };
		for (const [name, handler] of Object.entries(events)) globalThis.window?.addEventListener?.(name, handler);
		gesture = { rigs: rigSnapshots(), release() { for (const [name, handler] of Object.entries(events)) globalThis.window?.removeEventListener?.(name, handler); } };
	}
	function edit(id, args) {
		if (!gesture) return run(id, args);
		if (gesture.id && gesture.id !== id) { finishGesture(); beginGesture(); }
		if (!gesture.txId) {
			gesture.id = id; gesture.txId = run('run.begin', { id, args }).txId;
			gesture.unsubscribe = appContext.bus.subscribe(event => { if (event.type === 'transaction.cancelled' && event.txId === gesture?.txId) { const current = gesture; gesture = null; current.unsubscribe(); current.release(); } });
		}
		return run('run.update', { txId: gesture.txId, args });
	}
	const domain = { documentStore, read, write, layer, writeLayer, motionFor, fullMotionFor, visibleMotion, snapshotTake, project,
		setKeys, setRangePinState, bakeRangePin, removePin, editKeys, setKey, replace, clear, editSegments, fix, castWrite, run, edit, beginGesture, finishGesture, beginAction, runPrepared, persistTake,
		insideAction: () => running > 0, bakeCurrentKey, keyPose, editTrail, autoPhysics, applyPhysics,
		applyPrepared(token) { const apply = prepared.get(token); if (!apply) throw new StudioProtocolError('STALE_TARGET', 'Prepared motion is no longer available.'); return apply(); },
		bindRender(context) { appContext = context; },
		viewRevision: () => viewRevision, canUndo: id => documentStore.canUndo(id),
		stepHistory: redo => { finishGesture(); return Boolean((redo ? documentStore.redo : documentStore.undo)()); },
		document: () => ({ motion: read().map(row => {
			const take = motionFor(row.id);
			return take ? { ...row, take: { ...row.take, frames: take.frames, fps: take.fps, editSegments: take.editSegments } } : row;
		}) }), sceneSlice: slices => slices.motion ?? references(slices.cast),
		publish: rows => write(rows), commitDraft: write,
		switchLayer(id) { appContext.shared.loadedLayerCharRef.current = id; project(); notify(); },
		snapshotLegacy: () => read(), restoreLegacy: write,
		snapshotTarget(id) {
			const state = appContext.shared.readStudioState(), keys = decodeMotionKeys(layer(id).ikKeys), rig = rigFor(id);
			return { character: state.characters.find(row => row.id === id), fullMotion: fullMotionFor(id),
				ikState: { ...createIkState(), keys, tracked: new Set([...keys.values()].flatMap(entry => [...entry.keys()])) },
				frameCount: state.frameCount, committedIkEdits: layer(id).committedIkEdits, renderer: rig ? appContext.shared.snapshotExportRig(rig) : null };
		},
		removeLayer(id) { write(rows => rows.filter(row => row.id !== id)); },
		preview(id, take) { if (take) previews.set(id, take); else previews.delete(id); project(); notify(); },
		hydrate(id, take, reference) {
			const current = appContext.storeDomain('cast').read().find(row => row.id === id);
			const descriptor = layer(id).take;
			if (!descriptor || !sameMotionIntent(current?.motionRef, reference)) return false;
			takes.set(descriptor.resourceId, structuredClone(take));
			for (const rows of [read(), ...documentStore.history().past.map(entry => entry.snapshot.motion), ...documentStore.history().future.map(entry => entry.snapshot.motion)]) {
				for (const row of rows) for (const value of [row.take, row.fullTake]) if (value?.resourceId === descriptor.resourceId) decoded.delete(value);
			}
			notify(); return true;
		},
		load(rows) { finishGesture(true); previews.clear(); release(); native.dispose(); native = createDocumentStore({ owned: { motion: normalize(rows) } }); release = native.subscribe(notify); pruneTakes(); notify(); },
		dispose() { finishGesture(true); unregister(); unsubscribe(); release(); native.dispose(); listeners.clear(); takes.clear(); },
	};
	const unregister = appContext.registerStoreDomain('motion', domain);
	return domain;
}

export function useMotionCommands() {
	const app = useContext(AppContext), owner = app.storeDomain('motion');
	return { run: (id, args = {}) => owner.run(id, { characterId: app.storeDomain('cast').activeId, ...args }) };
}

export function useMotion(appContext) {
	const [domain] = useState(() => appContext.storeDomain('motion') ?? createMotionDomain(appContext, appContext.shared.characters));
	domain.bindRender(appContext);
	useDocumentDomain(domain.documentStore, 'motion');
	useSyncExternalStore(domain.documentStore.subscribe, domain.viewRevision, domain.viewRevision);
	useEffect(() => {
		domain.switchLayer(appContext.shared.activeChar.id);
		const start = () => domain.beginGesture(); window.addEventListener('pointerdown', start, true);
		return () => { window.removeEventListener('pointerdown', start, true); domain.finishGesture(true); };
	}, [domain, appContext.shared.activeChar.id]);
	const [i2vMotion, setI2vMotion] = useState({ a: null, b: null, job: null, status: "idle", error: "", instruction: "", dailyRemaining: null });
	/* ------------------------------ IK layer ------------------------------ */
	// IK posing for Subject 1: dragging a wrist/ankle handle FOCUSES that
	// joint and solves its chain backward (two-bone analytic IK) on top of
	// the current pose; joints never dragged stay purely on the FK pose.
	// Keys land on the Full-Body lane as sparse per-chain world targets and
	// evaluate as the playhead moves. State lives in a ref — it changes
	// every drag tick and must not re-render the scene; ikTick re-renders
	// only the timeline markers.
	const [ikMode, setIkMode] = useState(false);
	// A drag records only the tracks it actually writes. The record is kept
	// outside React renders so pointer moves stay cheap and the drag-end bake
	// can create a delta key over the raw clip.
	const ikDragRef = useRef(null);
	const ikCameraMemoryRef = useRef(new Map());

	const [ikChains, setIkChains] = useState(null);

	const [ikFkJoints, setIkFkJoints] = useState(null);

	const [ikFocus, setIkFocus] = useState(null);

	// Foot snap (ground plant): while ON, body (hips) drags keep the feet at
	// the positions captured when the drag started — the knees bend instead
	// of the feet sinking through the floor. Toggleable in the timeline.
	const [footSnap, setFootSnap] = useState(true);

	const [bodyContact, setBodyContact] = useState(true);

	// How far (in frames) a correction eases back to the underlying motion
	// outside its keyed range. 6 frames @ 24 fps = 0.25 s — long enough to
	// hide the seam, short enough that a mid-clip fix stays visibly local.
	const IK_CORRECTION_BLEND_FRAMES = 6;

	const [autoPhysicsRunning, setAutoPhysicsRunning] = useState(false);

	const [physicsPreview, setPhysicsPreview] = useState(null);

	const [physicsShow, setPhysicsShow] = useState(true);

	const [physicsProgress] = useState(createPhysicsProgress);

	const setPhysicsProgress = physicsProgress.set;

	const [physicsOptions, setPhysicsOptions] = useState({ overrides: [], protectedFrames: [], strength: 1 });

	const [platformFitRunning, setPlatformFitRunning] = useState(false);
	const [platformFitLast, setPlatformFitLast] = useState(null);
	const [platformFitProgress] = useState(createPhysicsProgress);
	const platformFitProgressSet = platformFitProgress.set;
	const platformFitJobRef = useRef(0);
	const platformFitAppliedRef = useRef(null);
	const [platformFitApplied, setPlatformFitApplied] = useState(false);

	const [ikTick, setIkTick] = useState(0);

	const committedIkEdits = domain.layer(appContext.shared.activeChar.id).committedIkEdits;
	const setCommittedIkEdits = update => domain.writeLayer(appContext.shared.activeChar.id, { committedIkEdits: typeof update === 'function' ? update(domain.layer(appContext.shared.activeChar.id).committedIkEdits) : update });
	domain.onProject = () => setIkTick(value => value + 1);

	/* --------------------- IK-mode motion trail editing ---------------------
	 * Grabbing the viewport trajectory line deforms the loaded take with a
	 * smoothstep falloff around the grab frame (pure local preview). The last
	 * finished drag stays pending so "Regenerate from trail edit" can send the
	 * auto-derived window through the existing motionEdit pipeline. */
	const [trailFalloffS, setTrailFalloffS] = useState(0.5);

	const [showTrails, setShowTrails] = useState(true);

	const [ikEditTool, setIkEditTool] = useState("ik");

	const [trailEdit, setTrailEdit] = useState(null);
	const [rangePinSelection, setRangePinSelection] = useState(null);
	const [rangePinPartPick, setRangePinPartPick] = useState(null);
	const [rangePinPreview, setRangePinPreview] = useState(null);
	const pinLayer = domain.layer(appContext.shared.activeChar.id);
	const rangePins = useMemo(() => encodeRangePins(pinLayer.ikPins), [pinLayer.ikPins]);
	const rangePinResiduals = useMemo(() => decodeRangePinResiduals(pinLayer.ikPinResiduals), [pinLayer.ikPinResiduals]);

	const trailFalloffFrames = Math.max(1, Math.round(trailFalloffS * TIMELINE_FPS));

	function focusIkHandle(focus) {
		setIkFocus(focus);
		const hierarchyId = hierarchyIdForIkFocus(focus, appContext.shared.rowIdForCharIndex(appContext.shared.activeCharIndex));
		if (hierarchyId) {
			appContext.shared.setSelectedHierarchyId(hierarchyId);
		}
	}

	function ensureRangePinState(state) {
		if (!state) return state;
		if (!(state.pins instanceof Map)) state.pins = new Map();
		if (!(state.pinResiduals instanceof Map)) state.pinResiduals = new Map();
		return state;
	}
	function rangePinObjectWorldMatrix(objectId, frame) {
		const object = appContext.shared.sceneObjects.find((entry) => entry.id === objectId);
		if (!object) return null;
		const local = rangePinObjectMatrixAt(object, frame, { frameCount: motion?.frames ?? appContext.shared.tlFrameCount, fps: motion?.fps ?? appContext.shared.tlFps }, new THREE.Matrix4());
		if (!object.attach) return local;
		const attachRef = appContext.shared.attachFrameRef?.current;
		if (!attachRef) return local;
		const parent = attachRef(object.attach.characterId, object.attach.bone ?? null, new THREE.Matrix4());
		return parent ? parent.multiply(local) : local;
	}
	function rangePinApplyFrame(frame, state = appContext.shared.ikStateRef.current) {
		appContext.shared.poseMemberAtFrame(appContext.shared.activeRig, motion, null, frame);
		if (ikChains && state.keys.size > 0) ikEvaluate(ikChains, state, frame, ikFkJoints, IK_CORRECTION_BLEND_FRAMES);
	}
	function rangePinConflictFrames(draft, state = appContext.shared.ikStateRef.current) {
		if (!Number.isInteger(draft?.startFrame) || !Number.isInteger(draft?.endFrame) || draft.endFrame < draft.startFrame) return [];
		const tracks = rangePinTracks(draft), conflicts = [];
		for (let frame = draft.startFrame; frame <= draft.endFrame; frame += 1) {
			if (tracks.some((track) => { const key = state.keys.get(frame)?.get(track); return key && key.pin !== draft.id; })) conflicts.push(frame);
		}
		return conflicts;
	}
	function overlappingRangePin(draft, state = appContext.shared.ikStateRef.current) {
		return [...ensureRangePinState(state).pins.values()].find((pin) => pin.id !== draft.id && rangePinTracks(pin).some((track) => rangePinTracks(draft).includes(track)) && Math.max(pin.startFrame, draft.startFrame) <= Math.min(pin.endFrame, draft.endFrame));
	}
	function rangePinOverlapMessage(pin) {
		return pin ? ko(`A required body or limb track already has an overlapping pin (${pin.startFrame}–${pin.endFrame}).`, `필요한 몸통 또는 팔다리 파츠에 겹치는 고정이 있어요 (${pin.startFrame}–${pin.endFrame}).`) : "";
	}
	function captureRangePinTargetForDraft(draft) {
		if (!motion || !appContext.shared.activeRig || !ikChains) return null;
		const objectWorldMatrix = draft.targetKind === "object" ? (objectId, frame) => rangePinObjectWorldMatrix(objectId, frame) : null;
		const target = captureRangePinTarget({
			chains: ikChains, track: draft.track, frame: draft.startFrame,
			applyFrame: (frame) => rangePinApplyFrame(frame),
			space: draft.targetKind === "object" ? "object" : "world",
			objectId: draft.targetKind === "object" ? draft.objectId : null,
			objectWorldMatrix,
		});
		const pin = normalizeRangePin({ id: draft.id, track: draft.track, startFrame: draft.startFrame, endFrame: draft.endFrame, blend: draft.blend, reach: draft.reach ?? "body", target }, { clipFrames: motion.frames });
		return { pin, targetWorld: rangePinTargetWorld(pin, appContext.shared.tlFrame, { objectWorldMatrix }) };
	}
	function previewRangePinDraft(draft) {
		const state = ensureRangePinState(appContext.shared.ikStateRef.current);
		const conflictFrames = rangePinConflictFrames(draft, state);
		const overlapping = overlappingRangePin(draft, state);
		try {
			const resolved = captureRangePinTargetForDraft(draft);
			setRangePinPreview({ draft, track: draft.track, target: resolved?.targetWorld?.toArray() ?? null, conflictFrames, overlapError: rangePinOverlapMessage(overlapping) });
		} catch {
			setRangePinPreview({ draft, track: draft.track, target: null, conflictFrames, overlapError: rangePinOverlapMessage(overlapping) });
		}
	}
	function applyRangePinDraft(draft) {
		if (!motion || !appContext.shared.activeRig || !ikChains) return;
		const state = ensureRangePinState(appContext.shared.ikStateRef.current);
		const overlap = overlappingRangePin(draft, state);
		if (overlap) { appContext.notify(rangePinOverlapMessage(overlap)); return; }
		const conflicts = rangePinConflictFrames(draft, state);
		if (conflicts.length && !draft.replaceExisting) { appContext.notify(ko("Confirm Replace existing keys before applying this pin.", "이 고정을 적용하려면 기존 키 교체를 확인하세요.")); return; }
		try {
			const resolved = captureRangePinTargetForDraft(draft);
			domain.run('motion.rangePin.apply', { characterId: appContext.shared.activeChar.id, pin: resolved.pin, replaceExisting: Boolean(draft.replaceExisting) });
			setRangePinSelection(resolved.pin.id);
			setRangePinPreview({ draft: { ...draft, id: resolved.pin.id }, track: resolved.pin.track, target: resolved.targetWorld.toArray(), conflictFrames: [], overlapError: "" });
			appContext.shared.setTlPlaying(false);
			appContext.notify(isKo ? `${resolved.pin.track} 고정을 적용했어요 · ${resolved.pin.startFrame}–${resolved.pin.endFrame}프레임` : `Applied ${resolved.pin.track} pin · frames ${resolved.pin.startFrame}–${resolved.pin.endFrame}`);
		} catch (error) { appContext.notify(ko(`Could not apply pin — ${error.message}`, `고정을 적용하지 못했어요 — ${error.message}`)); }
	}
	function deleteRangePin(pinId) {
		const state = ensureRangePinState(appContext.shared.ikStateRef.current), pin = state.pins.get(pinId);
		if (!pin) return;
		domain.run('motion.rangePin.remove', { characterId: appContext.shared.activeChar.id, pinId });
		// Persisting the command updates the document before React publishes the
		// next render. Clear the live evaluator now too, so a draft preview made
		// during that transition cannot report the deleted pin as overlapping.
		const liveState = ensureRangePinState(appContext.shared.ikStateRef.current);
		removeRangePinKeys(liveState, pinId);
		liveState.pins.delete(pinId);
		liveState.pinResiduals.delete(pinId);
		liveState.tracked = new Set([...liveState.keys.values()].flatMap((entry) => [...entry.keys()]));
		setRangePinSelection(null); setRangePinPreview(null); setIkTick((value) => value + 1);
		appContext.notify(isKo ? `${pin.track} 고정을 삭제했어요` : `Deleted ${pin.track} pin`);
	}

	/** Deep copy of an IK state's key map: frame → Map(trackId → {q,p}), with
	 * every quaternion/position cloned so a snapshot never shares references
	 * with the live rig state (a later bake would otherwise rewrite history). */
	function snapshotIkKeys(ikState) {
		return copyPhysicsKeys(ikState?.keys ?? new Map());
	}

	function editIkKeys(mutate) {
		const before = snapshotIkKeys(appContext.shared.ikStateRef.current);
		const result = mutate();
		const owned = appContext.storeDomain('motion');
		if (owned) owned.setKeys(appContext.shared.loadedLayerCharRef.current, appContext.shared.ikStateRef.current.keys);
		else appContext.shared.markSemanticEdit("pose", before, appContext.shared.ikStateRef.current.keys);
		return result;
	}

	/* One IK-key core for every cast member, shared by the Key button, a pose
	 * drag's bake, the Full-Body lane's delete and run_action. The loaded
	 * layer's keys live on the live IK state, every other character's on its
	 * stored one (created on its first key). */
	function ikStateFor(characterId) {
		if (characterId === appContext.shared.loadedLayerCharRef.current) return appContext.shared.ikStateRef.current;
		let state = appContext.shared.ikStatesRef.current.get(characterId);
		if (!state) appContext.shared.ikStatesRef.current.set(characterId, (state = createIkState()));
		return state;
	}

	function editCharacterIkKeys(characterId, mutate) {
		if (appContext.storeDomain('motion')) return appContext.storeDomain('motion').editKeys(characterId, mutate);
		const state = ikStateFor(characterId);
		const before = snapshotIkKeys(state);
		mutate(state);
		appContext.shared.markSemanticEdit("pose", before, state.keys);
		setIkTick((value) => value + 1);
	}

	/** Write one key from its JSON form (studio-actions.js character.setIkKey):
	 * each named track replaces its key at `frame` and joins the tracked set. */
	function setCharacterIkKey(characterId, frame, tracks) {
		appContext.shared.castMemberOf(characterId);
		if (appContext.storeDomain('motion')) return appContext.storeDomain('motion').setKey(characterId, frame, tracks);
		editCharacterIkKeys(characterId, (state) => {
			let entry = state.keys.get(frame);
			if (!entry) state.keys.set(frame, (entry = new Map()));
			for (const [track, key] of Object.entries(tracks)) {
				entry.set(track, ikTrackKeyFromJson(key));
				ikTouch(state, track);
			}
		});
	}

	function removeCharacterIkKey(characterId, frame) {
		const character = appContext.shared.castMemberOf(characterId);
		const state = ikStateFor(characterId);
		if (!state.keys.has(frame)) {
			const keyed = ikKeyframes(state);
			throw new StudioProtocolError("STALE_TARGET", `${character.subject || character.id} has no IK key at frame ${frame}${keyed.length ? `; keyed frames: ${keyed.join(", ")}` : ""}.`);
		}
		editCharacterIkKeys(characterId, (target) => ikRemoveKeyframe(target, frame));
	}

	function clearCharacterIkKeys(characterId) {
		appContext.shared.castMemberOf(characterId);
		const count = ikStateFor(characterId).keys.size;
		if (!count) return 0;
		editCharacterIkKeys(characterId, (target) => {
			target.keys.clear();
			target.tracked.clear();
			target.plants.clear();
			target.pins?.clear();
			target.pinResiduals?.clear();
		});
		return count;
	}

	/** A baked key entry in the JSON form character.setIkKey takes. */
	function ikKeyJson(entry) {
		return ikKeyJson(entry);
	}

	const [bridge, setBridge] = useState(null);

	const [bridgeChecking, setBridgeChecking] = useState(false);

	const [motionSetupReveal, setMotionSetupReveal] = useState(0);

	const [motionSetupKind, setMotionSetupKind] = useState("prompt");

	const [ardyPrompt, setArdyPrompt] = useState("");

	const [ardyDuration, setArdyDuration] = useState(4);

	// Optional native-ARDY seed: empty string = omit from the request (the
	// box picks a fresh random one each run); otherwise a plain integer in
	// 0..2**31-1 to reproduce a result.
	const [ardySeed, setArdySeed] = useState("");

	// How much of the loaded take a regeneration keeps (scheduled inpainting).
	// 1 = hold the take everywhere the user did not edit, 0 = ignore it and
	// generate fresh. Only ever consulted when the take still has a bridge
	// source to preserve FROM, so the control renders with the take, not with
	// the panel.
	const [preserveStrength, setPreserveStrength] = useState(ARDY_PRESERVE_DEFAULT);

	// Off by default on purpose: pinning runs the box's pose mode, which builds
	// on a fixed reference base, so it is a choice the operator makes when they
	// actually want the pose in the generated clip.
	const [ardyStartFromPose, setArdyStartFromPose] = useState(false);

	// WHERE the pose lands in the clip. "start" leaves from it, "end" arrives at
	// it, "middle" passes through it, "playhead" places it on the frame the
	// operator scrubbed to — the box takes any destination frame.
	const [ardyPosePlacement, setArdyPosePlacement] = useState("start");

	/* ------------------- take recipes and versions (C9/C12) -------------------
	 * The recipe of the take that is loaded RIGHT NOW: seed + prompt blocks +
	 * the line edits pulled on top of it. It is written in exactly one place
	 * (commitTakeRecipe, on a successful run) and read in two: the request
	 * assembly, which attaches it as C10 `replay`, and the version strip, which
	 * stores a copy beside every motionUrl so clicking v1 restores v1's recipe
	 * and not the one the artist has since edited into existence.
	 * The ref shadows the state because the recipe is consulted from inside an
	 * async job completion, where a stale closure would silently record the
	 * previous take's edits against this take's url. */
	const takeRecipe = domain.layer(appContext.shared.activeChar.id).takeRecipe;
	const setTakeRecipe = value => domain.writeLayer(appContext.shared.activeChar.id, { takeRecipe: value });
	const takeVersions = domain.layer(appContext.shared.activeChar.id).takeVersions;
	const setTakeVersions = update => domain.writeLayer(appContext.shared.activeChar.id, { takeVersions: typeof update === 'function' ? update(domain.layer(appContext.shared.activeChar.id).takeVersions) : update });

	// Which C10 replay entries came back failed or boundary-warned. Non-blocking
	// by contract: the take generated, one refinement may not have survived it,
	// and that is worth a line next to the take rather than a toast that scrolls
	// away before the artist has looked at the result.
	const [replayNotices, setReplayNotices] = useState([]);

	// Whether the Scene entry's action menu is open. The Refine entry needs no
	// equivalent — it IS its action.
	const [sceneMenuOpen, setSceneMenuOpen] = useState(false);

	const [ardyRunning, setArdyRunning] = useState(false);

	const [ardyStatus, setArdyStatus] = useState("");

	// Keep the latest ARDY status inline with the Prompt Blocks controls. The
	// former bottom Console history was removed because it duplicated this state
	// and exposed an editor surface that is not part of the production workflow.
	function reportArdyStatus(line) {
		setArdyStatus(line);
	}

	const [ardyReport, setArdyReport] = useState(null);

	const [ardyOutcome, setArdyOutcome] = useState(null);

	// Timeline frames for the configured duration: [0, duration*TIMELINE_FPS-1].
	const maxDst = Math.max(0, Math.round(ardyDuration) * TIMELINE_FPS - 1);

	// Wave-2 gate: the bridge only routes lineEdit once M4's routing lands.
	// Until the /ardy/health payload says so, the request is never sent —
	// today's bridge ignores unknown fields, so an ungated POST would quietly
	// return a fresh unrelated take instead of an edit.
	const [lineEditBackend, setLineEditBackend] = useState(false);

	// Loaded motion: decoded arrays plus the world anchor captured at load.
	const motion = domain.visibleMotion(appContext.shared.activeChar.id);
	const rangePinRebuildRef = useRef(null);
	const rangePinSourceStamp = JSON.stringify([pinLayer.take, appContext.shared.activeChar.id]);
	// A fit is invalidated by a different take, trim or preview, not by key
	// writes: every layer write re-snapshots the take descriptor, so the decoded
	// `motion` object is new after the fit's own commit even though the take is
	// unchanged. Key the reset on the descriptor's content instead.
	const platformFitPreview = motion === domain.motionFor(appContext.shared.activeChar.id) ? null : motion;
	useEffect(() => {
		platformFitJobRef.current += 1;
		setPlatformFitRunning(false);
		setPlatformFitLast(null);
		platformFitProgressSet(0);
		platformFitAppliedRef.current = null;
		setPlatformFitApplied(false);
	}, [rangePinSourceStamp, platformFitPreview, appContext.shared.activeRig]);
	// Object-bound pins follow edited prop transforms and paths, as in the
	// source branch. Rebuilding derived keys must not create an undo entry.
	useEffect(() => {
		if (!motion || !ikChains || rangePinRebuildRef.current === rangePinSourceStamp) return;
		const timer = setTimeout(() => {
			rangePinRebuildRef.current = rangePinSourceStamp;
			const state = ensureRangePinState(appContext.shared.ikStateRef.current);
			for (const pin of [...state.pins.values()].filter(pin => pin.target.space === "object")) {
				if (!appContext.shared.sceneObjects.some(object => object.id === pin.target.objectId)) {
					removeRangePinKeys(state, pin.id);
					state.pinResiduals.set(pin.id, []);
				} else {
					try { domain.bakeRangePin(appContext.shared.activeChar.id, pin, false, true); }
					catch { /* A prop can be unavailable while its transform remounts. */ }
				}
			}
		}, 150);
		return () => clearTimeout(timer);
	}, [rangePinSourceStamp, ikChains]);


	const [motionBusy, setMotionBusy] = useState(false);

	const [motionError, setMotionError] = useState("");

	/* ------------------------- video capture (ingest) ---------------------- */
	const [multiModelUrl, setMultiModelUrl] = useState("");

	const [multiModelSource, setMultiModelSource] = useState(null);

	const [multiModelStatus, setMultiModelStatus] = useState("idle");

	// The ingest is a real download + decode, so it owns real progress and a
	// real receipt: the footage numbers below come from the decoded media.
	const [multiModelStage, setMultiModelStage] = useState("idle");

	const [multiModelProgress, setMultiModelProgress] = useState(null);

	const [multiModelFootage, setMultiModelFootage] = useState(null);

	const [multiModelError, setMultiModelError] = useState("");

	const [multiModelTake, setMultiModelTake] = useState(null);

	const [multiModelExtract, setMultiModelExtract] = useState("idle");

	const [multiModelExtractProgress, setMultiModelExtractProgress] = useState(null);

	const [multiModelExtractError, setMultiModelExtractError] = useState("");

	function advanceFrame(steps = 1) {
		const count = Math.max(1, Math.floor(steps));
		const previewEnd = appContext.shared.cameraPreviewEndRef.current;
		if (previewEnd != null && appContext.shared.tlFrameRef.current + count >= previewEnd) {
			appContext.shared.cameraPreviewEndRef.current = null;
			appContext.shared.setTlFrame(previewEnd);
			appContext.shared.setTlPlaying(false);
			return;
		}
		appContext.shared.setTlFrame((f) => (f + count) % appContext.shared.frameCountRef.current);
	}

	function stepFrame(delta) {
		appContext.shared.setTlFrame((f) => Math.max(0, Math.min(f + delta, appContext.shared.frameCountRef.current - 1)));
	}

	/* --------------------------- motion playback ---------------------------- */
	function leaveIkMode() {
		const poserCam = appContext.shared.poserCamRef?.current;
		if (ikMode && poserCam && appContext.shared.activeChar?.id) {
			const look = appContext.shared.poserLook?.current ?? {};
			ikCameraMemoryRef.current.set(appContext.shared.activeChar.id, {
				position: poserCam.position.clone(),
				quaternion: poserCam.quaternion.clone(),
				yaw: look.yaw ?? poserCam.rotation.y,
				pitch: look.pitch ?? poserCam.rotation.x,
			});
		}
		setIkMode(false);
		setIkFocus(null);
	}

	/** Hand `rig` over to playback. Every path that starts a clip — a loaded
	 *  take, a browser-baked one — does the same two things: drop out of IK
	 *  EDIT mode (playback is the new context; the IK KEYS stay and keep
	 *  correcting the clip layer-style) and swap the pre-playback bone
	 *  baseline, so a re-load never snapshots mid-animation and clearing
	 *  always returns to the blocking pose. */
	function beginPlaybackOn(rig) {
		leaveIkMode();
		const previous = appContext.shared.restoreRef.current;
		appContext.shared.restoreRef.current = null;
		if (previous) restorePlaybackBones(previous.rig, previous.bones);
		appContext.shared.restoreRef.current = { rig, bones: snapshotPlaybackBones(rig) };
	}

	/* ---------------------------- video capture ----------------------------
	 * Footage in, takes out. The ingest downloads and decodes a source so the
	 * timeline is sized by what was actually read; extraction then turns it
	 * into one take per tracked performer. Take 0 belongs to the ACTIVE
	 * character's layer, the rest are landed on their own cast members. */
	// A picked file is already local bytes: no download stage, straight to the
	// probe that produces the timeline numbers.
	function chooseMultiModelFile(event) {
		const file = event.target.files?.[0] ?? null;
		if (!file) return;
		setMultiModelUrl("");
		ingestFootage({ kind: "file", name: file.name, blob: file, bytes: file.size });
	}

	async function pasteMultiModelUrl() {
		try {
			const text = await navigator.clipboard.readText();
			if (!text.trim()) return;
			setMultiModelUrl(text.trim());
			setMultiModelStatus("idle");
		} catch {
			appContext.notify(isKo ? "클립보드를 읽지 못했어요 — 직접 붙여넣어 주세요" : "Clipboard is unavailable — paste into the field directly");
		}
	}

	function useMultiModelUrl() {
		const raw = multiModelUrl.trim();
		// A platform page (YouTube, Vimeo, …) is never browser-fetchable, but
		// the dev bridge can fetch it server-side. With the bridge up the
		// address goes there; without it the named refusal below stands.
		if (isPlatformPageUrl(raw) && bridge?.ok) {
			ingestPlatformFootage(raw);
			return;
		}
		const normalized = normalizeSourceUrl(raw);
		if (!normalized.ok) {
			setMultiModelStatus("error");
			setMultiModelStage("error");
			setMultiModelError(MULTIMODEL_REASONS[normalized.reason]?.[isKo ? 1 : 0] ?? normalized.reason);
			return;
		}
		ingestFootage({ kind: "url", name: sourceLabel(normalized.url), url: normalized.url });
	}

	/** Platform page → bridge download (yt-dlp + normalize) → the local
	 *  /ardy/footage/… address rides the ordinary ingest unchanged. */
	async function ingestPlatformFootage(pageUrl) {
		const run = appContext.shared.multiModelRunRef.current + 1;
		appContext.shared.multiModelRunRef.current = run;
		const live = () => appContext.shared.multiModelRunRef.current === run;
		setMultiModelSource({ kind: "url", name: sourceLabel(pageUrl), url: pageUrl });
		setMultiModelFootage(null);
		setMultiModelError("");
		setMultiModelStatus("busy");
		setMultiModelStage("fetching");
		setMultiModelProgress(null);
		setMultiModelTake(null);
		setMultiModelExtract("idle");
		setMultiModelExtractProgress(null);
		setMultiModelExtractError("");
		try {
			const footage = await requestBridgeFootage(pageUrl, {
				onProgress: ({ ratio }) => {
					if (live()) setMultiModelProgress(Number.isFinite(ratio) ? ratio : null);
				},
			});
			if (!live()) return;
			ingestFootage({ kind: "url", name: footage.title || sourceLabel(pageUrl), url: footage.url, fps: footage.fps, bridgeId: footage.footage ?? null });
		} catch (error) {
			if (!live()) return;
			const code = error?.message ?? String(error);
			setMultiModelStage("error");
			setMultiModelStatus("error");
			setMultiModelProgress(null);
			setMultiModelError(MULTIMODEL_REASONS[code]?.[isKo ? 1 : 0] ?? code);
		}
	}

	/** Download (when remote), decode, measure, then size the timeline from what
	 *  was actually read. Each run carries a token so a slow first source can
	 *  never land its numbers after a second one replaced it. */
	async function ingestFootage(source, commandContext = null) {
		const run = appContext.shared.multiModelRunRef.current + 1;
		appContext.shared.multiModelRunRef.current = run;
		const live = () => appContext.shared.multiModelRunRef.current === run;
		setMultiModelSource(source);
		setMultiModelFootage(null);
		setMultiModelError("");
		setMultiModelStatus("busy");
		setMultiModelProgress(null);
		// A take baked from the PREVIOUS clip must not read as this one's
		// result, so the extraction state resets with the source.
		setMultiModelTake(null);
		setMultiModelExtract("idle");
		setMultiModelExtractProgress(null);
		setMultiModelExtractError("");
		try {
			let blob = source.blob ?? null;
			let bytes = source.bytes ?? 0;
			if (!blob) {
				setMultiModelStage("fetching");
				const downloaded = await fetchFootageBlob(source.url, {
					onProgress: ({ ratio }) => {
						if (live()) setMultiModelProgress(ratio);
					},
				});
				if (!live()) return;
				blob = downloaded.blob;
				bytes = downloaded.bytes;
			}
			setMultiModelStage("probing");
			if (appContext.shared.multiModelObjectUrlRef.current) URL.revokeObjectURL(appContext.shared.multiModelObjectUrlRef.current);
			const objectUrl = URL.createObjectURL(blob);
			appContext.shared.multiModelObjectUrlRef.current = objectUrl;
			const probed = await probeFootage(objectUrl, {
				createVideo: () => document.createElement("video"),
				// The bridge normalized the clip and DECLARED its rate; a probe
				// that re-guesses it would overrule a measurement with a guess.
				knownFps: Number.isFinite(source.fps) ? source.fps : null,
			});
			if (!live()) return;
			commandContext?.check();
			const footage = { ...probed, bytes, objectUrl, blob, bridgeId: source.bridgeId ?? null };
			setMultiModelFootage(footage);
			setMultiModelStage("ready");
			setMultiModelStatus("ready");
			setMultiModelProgress(1);
			// The timeline is the point: the playhead now spans the footage that
			// was actually decoded, at the rate that was actually measured.
			appContext.shared.setTlFps(footage.fps);
			appContext.shared.setTlFrameCount(footage.frames);
			appContext.shared.setTlFrame(0);
			appContext.shared.setTlPlaying(false);
			appContext.notify((isKo, ko) => isKo
				? `${source.name} 인제스트됨 — ${footage.frames}프레임 @ ${footage.fps} fps`
				: `Ingested ${source.name} — ${footage.frames} frames @ ${footage.fps} fps`);
			return footage;
		} catch (error) {
			if (commandContext && (commandContext.signal.aborted || error.code === "STALE_TARGET")) throw error;
			if (!live()) return;
			const code = error?.message ?? String(error);
			setMultiModelStage("error");
			setMultiModelStatus("error");
			setMultiModelProgress(null);
			setMultiModelError(MULTIMODEL_REASONS[code]?.[isKo ? 1 : 0] ?? code);
		}
	}

	/** Extract motion from the ingested footage. With the bridge up this goes
	 *  to the GPU box (GVHMR: whole-clip temporal context, real 3D body
	 *  prior — previs-grade). If the bridge is unavailable or is configured for
	 *  another backend, extraction stops with a named error. */
	async function extractMultiModelMotion() {
		if (!bridge?.ok) {
			setMultiModelExtract("error");
			setMultiModelExtractError(MULTIMODEL_REASONS["extract-bridge-required"]?.[isKo ? 1 : 0] ?? "extract-bridge-required");
			return;
		}
		if (bridge.extractionBackend !== "gvhmr") {
			setMultiModelExtract("error");
			setMultiModelExtractError(MULTIMODEL_REASONS["extract-backend-unsupported"]?.[isKo ? 1 : 0] ?? "extract-backend-unsupported");
			return;
		}
		return extractMultiModelMotionGpu();
	}

	async function extractMultiModelMotionGpu() {
		const footage = multiModelFootage;
		if (!footage || multiModelExtract === "running") return;
		const run = appContext.shared.multiModelRunRef.current;
		const live = () => appContext.shared.multiModelRunRef.current === run;
		setMultiModelExtract("running");
		setMultiModelExtractProgress(null);
		setMultiModelExtractError("");
		setMultiModelTake(null);
		try {
			const done = await requestBridgeExtract(
				footage.bridgeId ? { footage: footage.bridgeId } : footage.blob,
				{
					onProgress: ({ ratio }) => {
						if (live()) setMultiModelExtractProgress(Number.isFinite(ratio) ? ratio : null);
					},
				}
			);
			if (!live()) return;
			if (done.quality && done.quality.pass === false) {
				const failed = Array.isArray(done.quality.checks)
					? done.quality.checks.filter((check) => check && check.pass === false).map((check) => check.name).join(", ")
					: "quality";
				appContext.notify(isKo
					? `모캡 품질 경고: ${failed || "검증 실패"} — 결과는 로드하지만 보정이 필요합니다`
					: `Mocap quality warning: ${failed || "validation failed"} — loaded for review, correction required`);
			}
			// One take per tracked performer. An older bridge sends a single
			// motionUrl and no list; that is the same thing with one entry.
			const takes = Array.isArray(done.takes) && done.takes.length
				? done.takes
				: [{ motionUrl: done.motionUrl, personScale: done.personScale, offsetX: 0, offsetZ: 0 }];
			const label = multiModelSource?.name ?? "extracted take";
			// The cast can change while the GPU works, so the destination is read
			// now, once, and every take is placed against THIS character.
			const active = appContext.live.characters.find((entry) => entry.id === appContext.shared.activeChar.id) ?? appContext.shared.activeChar;
			// Take 0 arrives as an ordinary motion npz; loadMotion decodes,
			// retimes to the 24 fps timeline, snapshots the rig baseline and
			// applies the stature stored in the take itself — the body matches
			// the FILMED person because the file carries the measurement, not
			// because this handler remembered to re-apply it afterwards.
			const fallbackScale = Number.isFinite(takes[0].personScale) ? takes[0].personScale : done.personScale;
			let personScale = await loadMotion(takes[0].motionUrl ?? done.motionUrl, label, active.rot, null, active.id, null, { personScaleFallback: fallbackScale });
			if (!live()) return;
			// loadMotion reports the stature it applied — 1 for a take that
			// stores none, nothing at all if the load failed. A failed load is
			// not a finished extraction: say so with the named reason instead
			// of a receipt for a take nobody can play.
			if (!Number.isFinite(personScale)) throw new Error("extract-convert-failed");
			// Only a take that stores NO stature gets the fallback for an npz
			// that predates person_scale (or an older bridge): the response
			// still carries the estimate, clamped the same way, because a bad
			// leg estimate must never produce a giant or a gnome.
			const declared = Number.isFinite(takes[0].personScale) ? takes[0].personScale : done.personScale;
			if (personScale === 1 && Number.isFinite(declared)) {
				personScale = characterScaleFor(null, declared);
			}
			// The clip itself is session-only; this reference is what a save
			// keeps and restoreMotionRefs re-fetches on the next session.
			const leadRef = {
				url: takes[0].motionUrl ?? done.motionUrl,
				prompt: label,
				rotationDeg: active.rot,
				anchorX: active.x,
				anchorZ: active.z,
			};
			if (!appContext.storeDomain('motion')) appContext.shared.publishStudioCharacters((list) => list.map((entry) => entry.id === active.id
				? { ...entry, scale: personScale, motionRef: leadRef }
				: entry));
			const placed = await deliverExtraTakes(takes.slice(1), active, label);
			if (!live()) return;
			const persons = 1 + placed;
			setMultiModelTake({ frames: done.frames, fps: done.fps, gpu: true, personScale, persons, trajectory: done.performance?.trajectory, segmentation: done.segmentation ?? done.performance?.segmentation ?? takes[0]?.segmentation ?? null, quality: done.quality ?? takes[0]?.quality ?? null });
			setMultiModelExtract("done");
			appContext.notify(isKo
				? `GPU 모션 추출됨 — ${done.frames}프레임 @ ${done.fps} fps${persons > 1 ? ` · ${persons}명` : ""} · 인물 스케일 ×${personScale.toFixed(2)}`
				: `GPU motion extracted — ${done.frames} frames @ ${done.fps} fps${persons > 1 ? ` · ${persons} performers` : ""} · person scale ×${personScale.toFixed(2)}`);
		} catch (error) {
			if (!live()) return;
			const code = error?.message ?? String(error);
			setMultiModelExtract("error");
			setMultiModelExtractError(MULTIMODEL_REASONS[code]?.[isKo ? 1 : 0] ?? code);
		}
	}

	/** Land takes 1..N-1 on the rest of the cast. Each extra take is its OWN
	 *  layer: it goes to that entry's sessionMotion, NOT through the editing
	 *  buffer, which holds the active character's clip alone. Returns how many
	 *  performers actually landed. */
	const authoredSupportDescriptors = () => appContext.shared.sceneObjects.map((object) => ({
		x: object.x,
		z: object.z,
		rotDeg: object.rot ?? 0,
		supportY: (object.y ?? 0) + supportHeightForObject(object) * (object.scaleY ?? 1),
		topY: (object.y ?? 0) + supportHeightForObject(object) * (object.scaleY ?? 1),
		width: (object.footprint?.width ?? 0) * (object.scaleX ?? 1),
		depth: (object.footprint?.depth ?? 0) * (object.scaleZ ?? 1),
	}));

	const applyAuthoredSupportRise = (clip, anchor, rotationDeg, worldScale = characterScaleFor(clip)) => applySupportRise(clip, authoredSupportDescriptors(), {
		subjectX: anchor.x,
		subjectY: anchor.y ?? 0,
		subjectZ: anchor.z,
		rotationDeg,
		worldScale,
	});

	async function deliverExtraTakes(extras, active, label) {
		const decoded = await Promise.all(extras.map(async (take, index) => {
			if (typeof take?.motionUrl !== "string" || !take.motionUrl) return null;
			try {
				// Inbound boundary, exactly like every other clip: decode, then
				// retime onto the production clock before anything counts frames.
				const anchor = takeAnchor(active, take.offsetX, take.offsetZ);
				const clip = retimeMotion(await loadMotionFromUrl(take.motionUrl), TIMELINE_FPS);
				const scale = characterScaleFor(clip, take.personScale);
				const raised = applyAuthoredSupportRise(clip, { ...anchor, y: active.y ?? 0 }, active.rot, scale);
				const staging = autoRoofDrop(
					raised,
					{ x: anchor.x, z: anchor.z, y: active.y ?? 0, rotationDeg: active.rot },
					authoredSupportDescriptors(),
					{ worldScale: scale },
				);
				const stagedClip = staging ? applyAutoFall(raised, staging, { worldScale: scale }) : raised;
				return {
					url: take.motionUrl,
					prompt: `${label} · ${index + 2}`,
					rotationDeg: active.rot,
					anchor,
					// A second performer is a DIFFERENT body: their take carries
					// their own stature, and the response estimate is only the
					// fallback for an npz that stores none.
					scale: characterScaleFor(clip, take.personScale),
					clip: stagedClip,
				};
			} catch {
				return null; // one unreadable take never voids the others
			}
		}));
		const usable = decoded.filter(Boolean);
		if (!usable.length) return 0;
		const owned = appContext.storeDomain('motion');
		// Plan against the cast as it stands, so ids are decided once and the
		// full-take map can be seeded with them.
		const list = appContext.live.characters;
		const taken = new Set([active.id]);
		let idPool = list;
		const assignments = usable.map((take) => {
			// Reuse a visible cast member with no clip of its own before adding
			// another body to the set.
			const reuse = list.find((entry) => !entry.hidden && !taken.has(entry.id) && !entry.sessionMotion && !entry.motionRef);
			const id = reuse ? reuse.id : nextCharacterId(idPool);
			if (!reuse) idPool = [...idPool, { id }];
			taken.add(id);
			return {
				id,
				spawn: !reuse,
				patch: {
					hidden: false,
					x: take.anchor.x,
					z: take.anchor.z,
					rot: take.rotationDeg,
					scale: take.scale,
					motionRef: {
						url: take.url,
						prompt: take.prompt,
						rotationDeg: take.rotationDeg,
						anchorX: take.anchor.x,
						anchorZ: take.anchor.z,
					},
					sessionMotion: {
						...take.clip,
						url: take.url,
						prompt: take.prompt,
						anchorX: take.anchor.x,
						anchorZ: take.anchor.z,
						anchorFrame: 0,
						rotationDeg: take.rotationDeg,
						editSegments: createMotionEdit(take.clip.frames),
					},
				},
			};
		});
		const place = current => {
			let next = current;
			for (const { id, spawn, patch } of assignments) {
				next = spawn && !next.some((entry) => entry.id === id)
					? [...next, { ...createCharacterEntry({ id, model: active.model, pose: DEFAULT_POSE, subject: "a person" }, next.length), ...patch }]
					: next.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
			}
			return next;
		};
		if (owned) owned.runPrepared(active.id, () => {
			owned.castWrite(place);
			for (const { id, patch } of assignments) { owned.replace(id, patch.sessionMotion); owned.persistTake(patch.sessionMotion, patch.motionRef); }
			return { affectedIds: assignments.map(row => row.id) };
		});
		else {
			appContext.shared.publishStudioCharacters(place);
			// Their takes are trimmable the moment they become the active layer.
			for (const { id, patch } of assignments) appContext.shared.motionFullRef.current.set(id, patch.sessionMotion);
		}
		return assignments.length;
	}

	function commitLoadedTake(characterId, take, { recipe = null, job = null, promptClips = null, scale = characterScaleFor(take) } = {}) {
		const owned = appContext.storeDomain('motion');
		const previous = owned.layer(characterId);
		const imported = recipe ?? (job ? previous.takeRecipe : { seed: null, blocks: [{ prompt: take.prompt, duration: take.frames / take.fps }], lineEdits: [] });
		const versions = recipe || job ? previous.takeVersions : pushTakeVersion(previous.takeVersions, {
			motionUrl: take.url, recipe: imported, savedAt: Date.now(), label: ko('Loaded', '불러옴'),
		}, TAKE_VERSIONS_MAX);
		owned.replace(characterId, take, { recipe: imported, versions });
		const motionRef = { url: take.url, prompt: take.prompt, rotationDeg: take.rotationDeg, anchorX: take.anchorX, anchorZ: take.anchorZ,
			calibration: take.sceneCalibration, ...(take.trailEdits ? { trailEdits: take.trailEdits } : {}), ...(take.motionId ? { motionId: take.motionId } : {}) };
		owned.castWrite(rows => rows.map(row => row.id === characterId ? { ...row, scale, motionRef,
			layer: promptClips ? { ...row.layer, promptClips } : row.layer } : row));
		if (job) {
			commitTakeRecipe(job, take.url);
			if (job.hasBlockEdits) owned.writeLayer(characterId, { committedIkEdits: job.committedEditKeys });
		}
		owned.persistTake(take, motionRef);
	}

	// Decoded motion + the world anchor: frame 0 always starts at Subject 1.
	// Authored root destinations are generated by ARDY as sparse constraints,
	// so playback consumes the returned trajectory without coordinate warping.
	async function loadMotion(
		url,
		prompt,
		rotationDeg = appContext.shared.charA.rot,
		drop = null,
		targetCharacterId = appContext.shared.activeChar.id,
		targetPromptClips = null,
		// `preview: true` means "put this clip on screen, do not treat it as a
		// new take". The line-edit preview loop swaps the viewport several times
		// a minute, and every announcement this function normally makes — the
		// load toast, the auto-drop toast, clearing the IK keys, snapping the
		// playhead back to 0 — is an announcement about a take CHANGING. A
		// preview is the same take seen a second time, so it makes none of them.
		{ preview = false, calibration = null, tutorialEpoch = null, commandContext = null, recipe = null, job = null, personScaleFallback = null } = {},
	) {
		setMotionBusy(true);
		setMotionError("");
		try {
			// Inbound boundary: an ARDY take (20 fps) or a filmed one (30/60)
			// becomes a production-clock clip here, once, before anything on
			// the timeline counts its frames. Same-rate input rides through.
			// A drop is staging applied to the clip itself, so it happens at
			// the same boundary — trims and IK then see the dropped take.
			const retimed = retimeMotion(await loadMotionFromUrl(url), TIMELINE_FPS);
			if (retimed.sourceBytes) retimed.motionId = await sha256Hex(retimed.sourceBytes);
			if (tutorialEpoch !== null && tutorialEpoch !== appContext.shared.tutorialProjectEpochRef.current) return null;
			const normalizedCalibration = normalizeMotionCalibration(calibration);
			// Scene yaw/XY translation belong to the character's scene transform.
			// Applying them to both the arrays and the Character group would rotate
			// the trajectory twice and leave rotMats facing the old direction.
			const playbackCalibration = { ...normalizedCalibration, yawDeg: 0, offsetX: 0, offsetZ: 0 };
			// Scene calibration is optional metadata from the capture boundary. It
			// runs before support/fall staging so every downstream measurement uses
			// the same scene-space coordinates.
			const raw = applyMotionCalibration(retimed, playbackCalibration).motion;
			// Staging descriptors are authored in scene metres while decoded
			// trajectories are canonical-body units. Resolve stature before any
			// support or fall math so a 0.8x/1.2x performer still lands exactly on
			// the same authored surface after playback multiplies the clip.
			const motionScale = characterScaleFor(raw);
			const targetCharacter = appContext.live.characters.find((entry) => entry.id === targetCharacterId);
			if (!targetCharacter) throw new Error(`Motion target ${targetCharacterId} no longer exists.`);
			const sceneAnchorX = targetCharacter.x + normalizedCalibration.offsetX;
			const sceneAnchorZ = targetCharacter.z + normalizedCalibration.offsetZ;
			const sceneRotationDeg = rotationDeg + normalizedCalibration.yawDeg;
			const rig = appContext.shared.rigs[targetCharacter.id] ?? await appContext.shared.waitForRig(targetCharacter.id);
			if (tutorialEpoch !== null && tutorialEpoch !== appContext.shared.tutorialProjectEpochRef.current) return null;
			// No explicit drop staged: a character standing on a raised object
			// whose take walks off the edge falls on its own — ARDY motion is
			// flat-ground, so the stage supplies the gravity.
			const supports = authoredSupportDescriptors();
			// A support's top is scene data, never guessed from the motion.  Apply
			// only when the clip shows an upward root trend entering its footprint;
			// ordinary deck walks remain byte-for-byte unchanged.
			const raised = drop ? raw : applySupportRise(raw, supports, {
				subjectX: sceneAnchorX,
				subjectY: targetCharacter.y ?? 0,
				subjectZ: sceneAnchorZ,
				rotationDeg: sceneRotationDeg,
				worldScale: motionScale,
			});
			const staging = drop ?? autoRoofDrop(
				raised,
				{ x: sceneAnchorX, z: sceneAnchorZ, y: targetCharacter.y ?? 0, rotationDeg: sceneRotationDeg },
				supports,
				{ worldScale: motionScale },
			);
			const decoded = drop ? applyRootDrop(raised, staging, { worldScale: motionScale }) : applyAutoFall(raised, staging, { worldScale: motionScale });
			if (!drop && staging && !preview) {
				appContext.notify((isKo, ko) => ko(
					`Auto drop staged: the take leaves its support at ${staging.fromS.toFixed(1)}s and falls ${staging.meters.toFixed(1)}m`,
					`자동 낙하 적용: ${staging.fromS.toFixed(1)}초에 지지면을 벗어나 ${staging.meters.toFixed(1)}m 낙하`,
				));
			}
			const targetStillExists = appContext.live.characters.some((entry) => entry.id === targetCharacter.id);
			if (!targetStillExists) throw new Error(`Motion target ${targetCharacterId} no longer exists.`);
			const apply = () => {
			const bufferOwnsTarget = targetCharacter.id === appContext.shared.loadedLayerCharRef.current;
			beginPlaybackOn(rig);
			// THE INVARIANT: the take's travel assumes the character is scaled.
			// Extraction divided the root translation by the filmed person's
			// stature, so the clip and that stature have to be applied together
			// or every stride overshoots by the same factor and the feet skate.
			// The scale rides INSIDE the npz, so this one line covers every path
			// that loads a motion; an ARDY-generated take stores none and is
			// canonical, 1.
			const measuredScale = characterScaleFor(decoded);
			const scale = measuredScale === 1 && Number.isFinite(personScaleFallback) ? characterScaleFor(null, personScaleFallback) : measuredScale;
			const loaded = {
			// Identity calibration retains the legacy frame-zero anchorX: targetCharacter.x
			// and anchorZ: targetCharacter.z contract; calibrated takes use the scene anchor.
			// Capture the exact prompt this motion was generated from; the
			// timeline keeps showing it even if the input field is edited
			// afterwards.
			prompt: typeof prompt === "string" ? prompt : "",
				...decoded,
				url,
				anchorX: sceneAnchorX,
				anchorZ: sceneAnchorZ,
				anchorFrame: 0,
				rotationDeg: sceneRotationDeg,
				sceneCalibration: normalizedCalibration,
				editSegments: createMotionEdit(decoded.frames),
			};
			const owned = appContext.storeDomain('motion');
			if (preview) owned.preview(targetCharacter.id, url === owned.motionFor(targetCharacter.id)?.url ? null : loaded);
			else {
				commitLoadedTake(targetCharacter.id, loaded, { recipe, job, promptClips: targetPromptClips, scale });
				if (bufferOwnsTarget) { appContext.shared.setTlFrame(0); appContext.shared.setTlPlaying(false); }
				setMotionError('');
			}
			return scale;
			};
			return preview ? apply() : commandContext ? commandContext.commit(apply)
				: appContext.storeDomain('motion').runPrepared(targetCharacterId, apply);
		} catch (err) {
			if (tutorialEpoch !== null && tutorialEpoch !== appContext.shared.tutorialProjectEpochRef.current) return null;
			setMotionError(err?.message || String(err));
			throw err;
		} finally {
			setMotionBusy(false);
		}
	}

	/** Drop the ACTIVE character's take, its IK corrections, prompt blocks and
	 * the stature the take imposed. One Ctrl+Z entry brings all four back; nothing to clear
	 * records nothing, so the shortcut never becomes a dead press.
	 *
	 * The pose flows (studio Apply/Reset, pose tiles, photo pose) call this
	 * first and then write the pose: the snapshot taken here predates both, so
	 * one undo restores the take AND the pose it replaced. */
	function clearMotion() {
		return appContext.storeDomain('motion').clear(appContext.shared.activeChar.id);
	}

	/** Cut the ACTIVE character's take to [start, end] of the CURRENT view.
	 *  Offsets compose, so a second cut still slices the original take; a cut
	 *  take drops its bridge url — its frames no longer match the source npz,
	 *  and IK-edit regeneration must not pretend they do. Per-character layers
	 *  mean the cut lands on this layer only; nobody else's clip moves. */
	function applyMotionTrim(start, end) {
		return appContext.storeDomain('motion').edit('motion.trim', { characterId: appContext.shared.activeChar.id, start, end });
	}

	function resetMotionTrim() {
		return appContext.storeDomain('motion').run('motion.resetTrim', { characterId: appContext.shared.activeChar.id });
	}

	function cutMotionAtPlayhead() {
		return appContext.storeDomain('motion').run('motion.cut', { characterId: appContext.shared.activeChar.id, frame: appContext.shared.tlFrame });
	}

	function changeMotionSegmentSpeed(id, speed) {
		return appContext.storeDomain('motion').run('motion.setSegmentSpeed', { characterId: appContext.shared.activeChar.id, id, speed });
	}

	/** Drop one Full-Body segment from the take. The removal composes like a
	 * trim: the source frames stay untouched, so the trim-reset path (right-click
	 * an outer handle) still restores the whole take. */
	function removeMotionSegmentById(id) {
		return appContext.storeDomain('motion').run('motion.removeSegment', { characterId: appContext.shared.activeChar.id, id });
	}

	// Everyone EXCEPT the active character, posed at an absolute frame from
	// their own session clips and their STORED IK corrections (#77). Factored
	// out of the effect below because the whole-clip Fix Collisions pass needs
	// the same thing: the other bodies are static blockers, and a blocker
	// sampled from a rig still standing at the playhead would block the wrong
	// volume on every other frame of the walk.
	const poseOtherCastMembers = (frame) => {
		for (const entry of appContext.shared.characters) {
			if (entry.id === appContext.shared.activeChar.id) continue;
			appContext.shared.poseMemberAtFrame(appContext.shared.rigs[entry.id], entry.sessionMotion, appContext.shared.ikStatesRef.current.get(entry.id), frame, IK_CORRECTION_BLEND_FRAMES);
		}
	};

	function toggleIkMode() {
		const next = !ikMode;
		// Authoring modes are mutually exclusive: IK mode swaps the main pane to
		// the poser camera, which would silently invalidate any pulled path
		// anyway. Leaving the line mode explicitly says so instead.
		if (next && appContext.shared.lineEditMode) appContext.shared.exitLineEditMode();
		if (next) {
			// Always enter on the safe, detailed IK tool. Trail editing is an
			// explicit second tool and must never leave the regular handles
			// locked when the user re-enters IK mode.
			setIkEditTool("ik");
			// With a motion loaded, IK edits ON TOP of it: the motion is the
			// rough base layer, the IK keys the correction layer. Every frame
			// applies the clip first and the keyed corrections after, so the
			// composite is what gets pinned for re-generation. Pause playback
			// so a running playhead cannot fight the drag.
			appContext.shared.setTlPlaying(false);
			// Self-heal the ref after a hot-reload with an older state shape:
			// a missing `tracked` set would throw on the first drag.
			if (!appContext.shared.ikStateRef.current.tracked) appContext.shared.ikStateRef.current = createIkState();
			appContext.shared.ikStateRef.current.chains = ikChains;
			appContext.shared.ikStateRef.current.fkJoints = ikFkJoints;
			appContext.shared.ikStateRef.current.rig = appContext.shared.activeRig;
			// Handles open exactly on the effectors of the CURRENT pose —
			// non-destructive entry. (The evaluate effect applies the keyed
			// pose at this frame right after ikMode flips, so re-seating on
			// frame changes is handled there.)
			if (ikChains) ikSeedTargets(ikChains, appContext.shared.ikStateRef.current);
			// The main view switches to the poser camera: start it exactly on
			// the shot camera's pose so nothing jumps, then navigation moves
			// the POSER only — the shot camera (inset) stays frozen.
			const shotCam = appContext.shared.shotCamRef.current;
			const editorCam = appContext.shared.editorCamRef?.current;
			const poserCam = appContext.shared.poserCamRef.current;
			const pose = chooseIkEntryPose({
				rememberedPose: ikCameraMemoryRef.current.get(appContext.shared.activeChar.id) ?? null,
				editorPose: editorCam ? { position: editorCam.position, quaternion: editorCam.quaternion, yaw: appContext.shared.editorLook?.current?.yaw, pitch: appContext.shared.editorLook?.current?.pitch } : null,
				shotPose: shotCam ? { position: shotCam.position, quaternion: shotCam.quaternion, yaw: shotCam.rotation.y, pitch: shotCam.rotation.x } : null,
				lookThroughShot: appContext.shared.lookThroughShot,
			});
			if (pose && poserCam) {
				poserCam.position.copy(pose.position);
				poserCam.quaternion.copy(pose.quaternion);
				poserCam.rotation.order = "YXZ";
				appContext.shared.poserLook.current = { yaw: pose.yaw ?? poserCam.rotation.y, pitch: pose.pitch ?? poserCam.rotation.x };
			}
			setIkMode(true);
			appContext.notify(motion
				? ko("Pose mode — correct the motion; drag end keys the fix at this frame", "포즈 모드 — 모션을 보정합니다. 드래그를 끝내면 이 프레임에 보정 키가 찍혀요")
				: ko("Pose mode — drag handles in the main view; the shot camera stays frozen in the inset", "포즈 모드 — 메인 뷰에서 핸들을 드래그하세요. 샷 카메라는 인셋에 고정됩니다"));
			return;
		}
		// Exit: the keyed pose stays — the evaluate effect re-applies the
		// current frame's keyed rotations the moment ikMode flips, so nothing
		// the user authored is lost by toggling. Untracked/unkeyed parts keep
		// their current (FK) pose.
		leaveIkMode();
		appContext.notify(ko("Pose mode off — keyed poses keep playing", "포즈 모드 꺼짐 — 키로 찍은 포즈는 계속 재생됩니다"));
	}

	// Drag solve, routed by handle kind: chain targets solve the two-bone
	// chain toward the target; mid joints reposition the elbow/knee with both
	// ends pinned (the handle snaps to the clamped position); FK joints swing
	// toward the pointer. Keys are baked on drag END — see ikDragEnd.
	function ikSolve(kind, trackId, targetWorld) {
		ikDragRef.current = ikDragRecord(ikDragRef.current, appContext.shared.tlFrame);
		const touch = (id) => ikDragTouch(appContext.shared.ikStateRef.current, ikDragRef.current, id);
		if (kind === "chain") {
			const chain = appContext.shared.ikStateRef.current.chains?.get(trackId);
			if (!chain) return;
			touch(trackId);
			const clampedTarget = bodyContact ? clampIkTargetToFloor(trackId, targetWorld, 0, ikChains?.get(trackId)?.contactHeights ?? ikChains?.values().next().value?.contactHeights) : targetWorld;
			appContext.shared.ikStateRef.current.targets.set(trackId, clampedTarget.clone());
			solveIk(chain, clampedTarget);
			return;
		}
		if (kind === "mid") {
			// Mid tracks reference their parent chain through MID_TRACKS.
			const midDef = MID_TRACKS.find((t) => t.id === trackId);
			const chain = midDef ? appContext.shared.ikStateRef.current.chains?.get(midDef.chain) : null;
			if (!chain) return;
			touch(chain.track.id);
			solveMidJoint(chain, bodyContact ? clampIkTargetToFloor(trackId, targetWorld, 0, chain.contactHeights) : targetWorld);
			return;
		}
		// Effector swing: the rotation ring on a focused hand/foot. Rotates
		// only the end bone — the solved limb position is untouched — and the
		// bake on drag end now stores b2's quaternion with the chain's.
		if (kind === "swing") {
			const chain = appContext.shared.ikStateRef.current.chains?.get(trackId);
			if (!chain || !targetWorld?.axis) return;
			touch(trackId);
			solveEffectorSwing(chain, targetWorld.axis, targetWorld.angle, targetWorld.startQuat, targetWorld.startParentQuat);
			return;
		}
		// Body root (hips): arrow drags translate ({ worldDelta, startLocalPos
		// }), the centre sphere swings ({ axis, angle, startQuat, ... }). With
		// foot snap ON the feet stay at the positions captured when the drag
		// started — the legs re-solve after every hips transform so the knees
		// bend instead of the feet sinking through the floor.
		if (kind === "body") {
			const joint = ikFkJoints?.get(trackId);
			if (!joint) return;
			touch(trackId);
			if (footSnap && !appContext.shared.ikBodyDragRef.current && ikChains) {
				// Capture the plant points once, BEFORE the first hips move.
				ikPlantFeet(ikChains, appContext.shared.ikStateRef.current);
				appContext.shared.ikBodyDragRef.current = true;
			}
			if (targetWorld?.worldDelta && targetWorld?.startLocalPos) {
				if (bodyContact) solveHipsTranslateToFloor(joint, targetWorld.worldDelta, targetWorld.startLocalPos, 0, ikChains?.get("leftHand")?.contactHeights);
				else solveHipsTranslate(joint, targetWorld.worldDelta, targetWorld.startLocalPos);
			} else if (targetWorld?.axis) solveSwingAngle(joint, targetWorld.axis, targetWorld.angle, targetWorld.startQuat, targetWorld.startParentQuat);
			if (footSnap && ikChains) {
				ikSolvePlantedFeet(ikChains, appContext.shared.ikStateRef.current);
				// the planted re-solve wrote the leg bones — key them too
				touch("leftFoot");
				touch("rightFoot");
			}
			if (bodyContact && ikChains) {
				for (const id of chainsChangedBy(ikChains, () => applyBodyContact(ikChains, ikFkJoints, 0, { skipFeet: footSnap }))) touch(id);
			}
			return;
		}
		// FK swing: targetWorld is the trackball payload { axis, angle,
		// startQuat, startParentQuat } from the drag layer.
		const joint = ikFkJoints?.get(trackId);
		if (!joint || !targetWorld?.axis) return;
		touch(trackId);
		solveSwingAngle(joint, targetWorld.axis, targetWorld.angle, targetWorld.startQuat, targetWorld.startParentQuat);
	}

	// Drag end: key the dragged part's local rotations at the playhead, so a
	// scrub away and back restores the dragged pose exactly (slerp).
	function ikDragEnd() {
		appContext.shared.ikBodyDragRef.current = false;
		const drag = ikDragRef.current;
		ikDragRef.current = null;
		// One entry per drag: the pointermoves only moved bones, the keys map is
		// untouched until this bake — the key it sets records the pre-drag keys.
		if (appContext.storeDomain('motion') || ikChains) keyIkPoseAtPlayhead(
			motion ? (drag ? drag.ids : null) : null,
		);
		setIkTick((n) => n + 1);
	}

	/** Bake the current tracked rotations at the playhead into a scratch layer
	 * and set them as a key through the shared registry. A bake only writes
	 * TRACKED parts: with nothing dragged yet there is no key, nothing is
	 * dispatched and Ctrl+Z never goes dead. */
	function keyIkPoseAtPlayhead(dragIds = null) {
		if (appContext.storeDomain('motion')) return appContext.storeDomain('motion').bakeCurrentKey(appContext.shared.activeChar.id, appContext.shared.tlFrame, dragIds);
		const scratch = { ...createIkState(), tracked: new Set(appContext.shared.ikStateRef.current.tracked) };
		ikBakeKeyframe(ikChains, scratch, appContext.shared.tlFrame, ikFkJoints);
		const baked = scratch.keys.get(appContext.shared.tlFrame);
		return baked ? appContext.shared.runStudioAction("character.setIkKey", { characterId: appContext.shared.activeChar.id, frame: appContext.shared.tlFrame, tracks: ikKeyJson(baked) }) : null;
	}

	// Manual key: bake the current tracked rotations at the playhead.
	function ikAddKeyframe() {
		if (!ikChains) return;
		if (!keyIkPoseAtPlayhead()) return;
		appContext.notify(isKo ? `${appContext.shared.tlFrame}프레임에 전신 IK 키를 추가했어요` : `Full-body IK key at frame ${appContext.shared.tlFrame}`);
	}

	// Self-collision cleanup: push interpenetrating body parts apart with the
	// IK solver, then bake the fix as an ordinary IK correction key so it
	// survives scrubs, undo, and blends back into the clip outside its range.
	//
	// The result has THREE outcomes, not two, and each gets its own sentence.
	// "supported: false" means the rig has no capsule proxies to build at all
	// — a non-Mixamo skeleton — and reporting that as "no collisions" would
	// be a lie the user cannot act on: they would keep clicking a button that
	// silently does nothing. The buttons below are disabled in that case, so
	// this branch is the belt to that suspenders (a rig can be swapped under
	// a stale render).
	/**
	 * Everything OUTSIDE the active character that a limb has to stay out of:
	 * the other cast members' bodies (capsules, built from the rigs AS THEY ARE
	 * POSED at the moment of the call) and every scene object (an upright box
	 * on its footprint). Ids are namespaced `char:<id>:<capsule>` / `obj:<id>`,
	 * so a penetration label names the thing that was hit.
	 *
	 * `frame` re-samples travel paths — a prop walking a route stands somewhere
	 * else on every frame — but the CAST is read live from the scene graph, so
	 * a caller walking a clip must pose the others at that frame first (see
	 * runFixCollisionsRange's blockersAt).
	 */
	const externalBlockers = (frame = appContext.shared.tlFrame) => collisionBlockers({
		rigs: appContext.shared.rigs,
		activeId: appContext.shared.activeChar.id,
		// The CAST is the authority on who is on stage, not the rig map: undo can
		// put the cast list back to one subject while the rig mounted for the
		// removed one is still in `rigs`, and a ghost body would go on blocking
		// limbs that pass through empty space.
		characterIds: appContext.shared.characters,
		sceneObjects: appContext.shared.sceneObjects,
		library: OBJECT_LIBRARY,
		frame,
		take: { frameCount: appContext.shared.tlFrameCount, fps: appContext.shared.tlFps },
	});

	function runFixCollisions() {
		if (appContext.storeDomain('motion')) return appContext.storeDomain('motion').run('motion.fixCollisions', { characterId: appContext.shared.activeChar.id, scope: 'frame' });
		if (!ikChains || !appContext.shared.activeRig) return;
		// A rig swap leaves one render where ikChains still describes the old
		// skeleton; solving the new rig with them would push the wrong bones.
		if (appContext.shared.ikStateRef.current.rig !== appContext.shared.activeRig) return;
		// The set as it stands right now: the other bodies at this frame's pose
		// and the props at this frame's placement.
		const result = fixCollisions(appContext.shared.activeRig, ikChains, { ikState: appContext.shared.ikStateRef.current, fkJoints: ikFkJoints, blockers: externalBlockers(appContext.shared.tlFrame) });
		if (!result.supported) {
			appContext.notify(ko("This rig doesn't support collision cleanup", "이 리그는 신체 관통 정리를 지원하지 않아요"));
			return;
		}
		if (!result.changed) {
			appContext.notify(ko("No body collisions at this frame", "이 프레임에는 신체 관통이 없어요"));
			return;
		}
		editIkKeys(() => ikBakeKeyframe(ikChains, appContext.shared.ikStateRef.current, appContext.shared.tlFrame, ikFkJoints, result.touched, null, result.baseQuats));
		setIkTick((n) => n + 1);
		appContext.notify(result.residual > 1e-4
			? ko(`Collisions reduced (residual ${(result.residual * 100).toFixed(1)} cm)`, `관통을 줄였어요 (잔여 ${(result.residual * 100).toFixed(1)} cm)`)
			: ko(`Collisions fixed at frame ${appContext.shared.tlFrame}`, `프레임 ${appContext.shared.tlFrame}의 관통을 정리했어요`));
	}

	// Whole-clip variant: walk the motion frame by frame, clean each pose and
	// key ONLY the frames that changed, so a clean clip stays keyless.
	function runFixCollisionsRange() {
		if (appContext.storeDomain('motion')) return appContext.storeDomain('motion').run('motion.fixCollisions', { characterId: appContext.shared.activeChar.id, scope: 'clip' });
		if (!ikChains || !appContext.shared.activeRig || !motion) return;
		if (appContext.shared.ikStateRef.current.rig !== appContext.shared.activeRig) return;
		// Screened before the undo entry: an unsupported rig would record an
		// undo step for a walk that keys nothing, leaving a no-op in history.
		if (!appContext.shared.collisionCleanupSupported) {
			appContext.notify(ko("This rig doesn't support collision cleanup", "이 리그는 신체 관통 정리를 지원하지 않아요"));
			return;
		}
		const currentFrame = appContext.shared.tlFrame;
		const applyFrame = (frame) => {
			applyMotionFrame(appContext.shared.activeRig, motion, frame);
			ikEvaluate(ikChains, appContext.shared.ikStateRef.current, frame, ikFkJoints, IK_CORRECTION_BLEND_FRAMES);
		};
		// The other bodies move too. blockersAt runs AFTER applyFrame(frame), so
		// it poses the rest of the cast at that same frame — their own clips and
		// their own stored IK layers, the very pass the viewport renders with —
		// and only then samples their capsules. Without this the blockers would
		// describe everyone frozen at the playhead, which is a wrong obstacle on
		// every frame but one.
		const blockersAt = (frame) => {
			poseOtherCastMembers(frame);
			return externalBlockers(frame);
		};
		let keyed = [];
		let unresolved = [];
		try {
			const walked = editIkKeys(() => fixCollisionsRange({
				rig: appContext.shared.activeRig,
				chains: ikChains,
				ikState: appContext.shared.ikStateRef.current,
				fkJoints: ikFkJoints,
				startFrame: 0,
				endFrame: motion.frames - 1,
				applyFrame,
				blockersAt,
			}));
			// The frames the walk keyed. `unresolved` — the frames whose residual
			// survived every pass — is ADDITIVE: read it defensively off either
			// shape so this keeps working before and after the driver grows it.
			keyed = Array.isArray(walked) ? walked : walked?.keyed ?? [];
			unresolved = (Array.isArray(walked) ? walked.unresolved : walked?.unresolved) ?? [];
		} finally {
			// The restore is the pass's CLEANUP, not its epilogue: a throw mid-walk
			// would otherwise leave the active rig and the rest of the cast frozen
			// at whatever frame it died on, which is a wrong-looking set the user
			// cannot scrub out of without touching the playhead.
			applyFrame(currentFrame);
			poseOtherCastMembers(currentFrame);
			setIkTick((n) => n + 1);
		}
		// Residual is worth saying out loud: a limb pinned between two blockers
		// (another body and a prop, say) can come out of the walk still touching,
		// and silence would read as "all clean".
		const stillPenetrating = unresolved.length
			? ko(` · ${unresolved.length} frame(s) still penetrate`, ` · ${unresolved.length}개 프레임은 남아 있어요`)
			: "";
		// "No body collisions" must never share a sentence with "still
		// penetrate": a converged pass over an unfixable clip has nothing more
		// to do, which is a different statement from the clip being clean.
		appContext.notify((keyed.length
			? ko(`Fixed collisions on ${keyed.length} frame(s)`, `${keyed.length}개 프레임의 관통을 정리했어요`)
			: unresolved.length
				? ko("Nothing more to fix", "더 고칠 수 있는 게 없어요")
				: ko("No body collisions in the clip", "클립에 신체 관통이 없어요")) + stillPenetrating);
	}

	function changePhysicsOptions(next) {
		setPhysicsOptions(next); setPhysicsPreview(null); setIkTick((n) => n + 1);
	}

	function showPhysicsPreview(show) { setPhysicsShow(show); setIkTick((n) => n + 1); }

	function cancelPhysicsPreview() { setPhysicsPreview(null); setIkTick((n) => n + 1); }

	function applyPhysicsPreview() {
		if (appContext.storeDomain('motion')) return appContext.storeDomain('motion').run('motion.applyPhysics', { characterId: appContext.shared.activeChar.id });
		if (!physicsPreview || physicsPreview.sourceStamp !== physicsKeyStamp(appContext.shared.ikStateRef.current.keys)) return;
		editIkKeys(() => { appContext.shared.ikStateRef.current.keys = copyPhysicsKeys(physicsPreview.candidate.keys); });
		appContext.shared.ikStateRef.current.tracked = new Set(physicsPreview.candidate.tracked);
		appContext.shared.autoPhysicsRunRef.current = { motion, rig: appContext.shared.activeRig, stamp: physicsKeyStamp(appContext.shared.ikStateRef.current.keys) };
		setPhysicsPreview(null); setIkTick((n) => n + 1);
		appContext.notify(ko("AutoPhysics applied · Undo restores the original", "오토피직스를 적용했어요 · 실행 취소로 원본 복구"));
	}

	async function runAutoPhysics() {
		if (appContext.storeDomain('motion')) return appContext.storeDomain('motion').run('motion.autoPhysics', { characterId: appContext.shared.activeChar.id, ...physicsOptions, apply: false });
		if (autoPhysicsRunning || !ikChains || !appContext.shared.activeRig || !motion || appContext.shared.ikStateRef.current.rig !== appContext.shared.activeRig) return null;
		const previous = appContext.shared.autoPhysicsRunRef.current;
		if (previous?.motion === motion && previous.rig === appContext.shared.activeRig && previous.stamp === physicsKeyStamp(appContext.shared.ikStateRef.current.keys)) {
			appContext.notify(ko("Already applied. Undo to review this correction again.", "이미 적용했어요. 실행 취소 후 다시 비교할 수 있어요.")); return null;
		}
		const job = ++appContext.shared.physicsJobRef.current, frame = appContext.shared.tlFrame;
		const sourceKeys = copyPhysicsKeys(appContext.shared.ikStateRef.current.keys), stamp = physicsKeyStamp(sourceKeys);
		let lastYieldAt = Date.now(), yieldWaitMs = 0, yieldCount = 0;
		const restore = () => { appContext.shared.poseMemberAtFrame(appContext.shared.activeRig, motion, appContext.shared.ikStateRef.current, frame, IK_CORRECTION_BLEND_FRAMES); };
		appContext.shared.setTlPlaying(false); setAutoPhysicsRunning(true); setPhysicsProgress(0); setPhysicsPreview(null);
		try {
			const result = await reviewAutoPhysics({ rig: appContext.shared.activeRig, motion, chains: ikChains, fkJoints: ikFkJoints, sourceKeys,
				applyRaw: (f) => appContext.shared.poseMemberAtFrame(appContext.shared.activeRig, motion, null, f), sceneObjects: appContext.shared.sceneObjects, ...physicsOptions,
				cache: appContext.shared.physicsSourceCacheRef.current,
				onProgress: setPhysicsProgress,
				yieldFrame: async () => {
					if (appContext.shared.physicsJobRef.current !== job) throw new Error("Analysis cancelled after changing the character or motion");
					// A batch is a cancellation checkpoint, not necessarily a paint/
					// event-loop boundary. Yield on a time budget, not every 12 frames.
					if (Date.now() - lastYieldAt < 16) return;
					restore();
					const queuedAt = Date.now();
					// Yield CPU work without waiting for a paint. requestAnimationFrame
					// can be throttled/paused in an occluded tab, stretching a seconds-
					// long solve into minutes. MessageChannel also lets input run.
					await new Promise((resolve) => {
						const channel = new MessageChannel();
						channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
						channel.port2.postMessage(0);
					});
					lastYieldAt = Date.now(); yieldWaitMs += lastYieldAt - queuedAt; yieldCount += 1;
					if (appContext.shared.physicsJobRef.current !== job) throw new Error("Analysis cancelled after changing the character or motion");
				},
			});
			Object.assign(result.performance, { yieldWaitMs, yieldCount });
			if (appContext.shared.physicsJobRef.current !== job || physicsKeyStamp(appContext.shared.ikStateRef.current.keys) !== stamp) return null;
			setPhysicsPreview(result); setPhysicsShow(true);
			return { before: result.before, after: result.after, warnings: result.warnings, unresolved: result.unresolved, contacts: result.contacts.spans };
		} catch (error) {
			if (appContext.shared.physicsJobRef.current === job) appContext.notify(ko(`AutoPhysics: ${error.message}`, `오토피직스: ${error.message}`));
			return null;
		} finally {
			if (appContext.shared.physicsJobRef.current === job) { restore(); setAutoPhysicsRunning(false); setIkTick((n) => n + 1); }
		}
	}

	async function platformFitRun(id, context, { removal = false, preview = false } = {}) {
		const rig = appContext.shared.rigs[id], resolved = rig && resolveIkRig(rig), take = domain.motionFor(id);
		if (!resolved || !take) throw new StudioProtocolError('TARGET_NOT_READY', 'Load a take and character rig first.');
		if (platformFitRunning) throw new StudioProtocolError('TARGET_BUSY', 'A platform fit is already running.');
		const job = ++platformFitJobRef.current;
		const sourceKeys = copyPhysicsKeys(decodeMotionKeys(domain.layer(id).ikKeys));
		const sourceTracked = new Set([...sourceKeys.values()].flatMap(entry => [...entry.keys()]));
		const stamp = physicsKeyStamp(sourceKeys);
		const prior = platformFitAppliedRef.current;
		const stacked = prior && prior.id === id && prior.stamp === stamp ? prior : null;
		const frame = appContext.shared.tlFrame;
		const restore = () => appContext.shared.poseMemberAtFrame(rig, take, appContext.shared.ikStatesRef.current.get(id), frame, 6);
		let lastYield = performance.now();
		const check = () => { context?.check?.(); if (platformFitJobRef.current !== job) throw new StudioProtocolError('STALE_TARGET', 'Platform fit was superseded.'); };
		setPlatformFitRunning(true); platformFitProgressSet(0); setPlatformFitLast(null);
		try {
			const result = await fitPlatforms({
				rig: rig, motion: take, chains: resolved.chains, fkJoints: resolved.fkJoints, sourceKeys,
				applyRaw: at => appContext.shared.poseMemberAtFrame(rig, take, null, at),
				sceneObjects: removal ? [] : (appContext.ports.read?.().objects ?? appContext.shared.sceneObjects),
				onProgress: platformFitProgressSet,
				yieldFrame: async () => {
					check(); if (performance.now() - lastYield < 16) return;
					restore();
					await new Promise(resolve => { const channel = new MessageChannel(); channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); }; channel.port2.postMessage(0); });
					lastYield = performance.now(); check();
				},
			});
			check();
			const last = { summary: result.summary, steps: result.steps, changedFrames: result.changedFrames };
			if (removal) {
				setPlatformFitLast(last);
				if (result.changedFrames.length) context.commit(() => domain.setKeys(id, result.candidate.keys));
				platformFitAppliedRef.current = null; setPlatformFitApplied(false); setPlatformFitLast(null);
				return { ...last, removed: result.changedFrames.length > 0 };
			}
			if (!preview) {
				if (result.changedFrames.length) context.commit(() => domain.setKeys(id, result.candidate.keys));
				platformFitAppliedRef.current = { id, before: stacked?.before ?? sourceKeys, tracked: stacked?.tracked ?? sourceTracked, stamp: physicsKeyStamp(decodeMotionKeys(domain.layer(id).ikKeys)) };
				setPlatformFitLast(last); setPlatformFitApplied(true);
				return last;
			}
			platformFitAppliedRef.current = { preview: { id, sourceStamp: stamp, sourceKeys, sourceTracked, candidate: result.candidate, last }, before: stacked?.before ?? sourceKeys, tracked: stacked?.tracked ?? sourceTracked, stamp };
			setPlatformFitLast({ ...last, candidate: result.candidate });
			setPlatformFitApplied(false);
			return last;
		} finally {
			if (platformFitJobRef.current === job) { restore(); setPlatformFitRunning(false); }
		}
	}

	function platformFitApply(id, context) {
		const preview = platformFitAppliedRef.current?.preview;
		if (!preview || preview.id !== id || platformFitRunning) return { applied: false };
		const current = physicsKeyStamp(decodeMotionKeys(domain.layer(id).ikKeys));
		if (current !== preview.sourceStamp) throw new StudioProtocolError('STALE_TARGET', 'The platform preview is out of date. Analyse this take again before applying.');
		context.commit(() => domain.setKeys(id, copyPhysicsKeys(preview.candidate.keys)));
		platformFitAppliedRef.current = { id, before: preview.sourceKeys, tracked: preview.sourceTracked, stamp: physicsKeyStamp(decodeMotionKeys(domain.layer(id).ikKeys)) };
		setPlatformFitApplied(true);
		setPlatformFitLast({ ...preview.last, candidate: undefined });
		return { applied: true, changedFrames: preview.last.changedFrames };
	}

	function platformFitRemove(id, context, { apply = false } = {}) {
		if (apply) return platformFitApply(id, context);
		const applied = platformFitAppliedRef.current;
		if (applied?.preview?.id === id) {
			platformFitAppliedRef.current = null; setPlatformFitLast(null); setPlatformFitApplied(false);
			return { removed: false, cancelled: true };
		}
		if (!applied || applied.id !== id || platformFitRunning) return { removed: false };
		const current = physicsKeyStamp(decodeMotionKeys(domain.layer(id).ikKeys));
		if (current === applied.stamp) {
			context.commit(() => domain.setKeys(id, copyPhysicsKeys(applied.before)));
			platformFitAppliedRef.current = null; setPlatformFitApplied(false); setPlatformFitLast(null);
			return { removed: true };
		}
		return platformFitRun(id, context, { removal: true });
	}

	function ikDeleteKeyframe(frame) {
		if (!appContext.shared.ikStateRef.current.keys.has(frame)) return;
		appContext.shared.runStudioAction("character.removeIkKey", { characterId: appContext.shared.activeChar.id, frame });
	}

	/** With IK mode on over a loaded take, a pose pick is a CORRECTION, not a
	 * replacement: write the saved pose onto the rig and bake every IK part
	 * into a full-body key at the current frame. The take survives, and the
	 * key blends back into the clip outside its window exactly like a dragged
	 * key would. Returns false when there is nothing to key against so the
	 * caller can fall through to the plain pose-apply path. */
	function ikApplyPoseAsKey(pose) {
		if (!appContext.shared.activeRig || !motion) return false;
		if (appContext.storeDomain('motion')) { appContext.storeDomain('motion').run('ik.applyPose', { characterId: appContext.shared.activeChar.id, frame: appContext.shared.tlFrame, pose }); return true; }
		if (!ikChains) return false;
		// The clip's positional skinning left per-bone translations the FK pose
		// math never produced. The bake below stores every FK joint's position
		// (p) as-is, so posing rotations over those clip translations would key
		// a torn-apart body — bind translations first, ALWAYS.
		restoreBindPositions(appContext.shared.activeRig);
		// Reset-then-pose, the same shape the Character effect applies: unlisted
		// joints return to rest instead of keeping stale limbs from the clip.
		applyPose(appContext.shared.activeRig, { ...REST_BONES, ...pose.bones });
		// The hips' measured height rides into the bake: the hips FK joint keys
		// its local position (p), so a crouched pose keys a crouched body.
		applyHipsOffset(appContext.shared.activeRig, pose.rootY ?? 0);
		// The pose authors the whole body, so every part is tracked — an
		// untracked chain would silently keep the clip's limb.
		for (const id of ikChains.keys()) ikTouch(appContext.shared.ikStateRef.current, id);
		if (ikFkJoints) for (const id of ikFkJoints.keys()) ikTouch(appContext.shared.ikStateRef.current, id);
		editIkKeys(() => ikBakeKeyframe(ikChains, appContext.shared.ikStateRef.current, appContext.shared.tlFrame, ikFkJoints));
		// Handles re-seat on the posed effectors, ready to drag into a refinement.
		ikSeedTargets(ikChains, appContext.shared.ikStateRef.current);
		setIkTick((n) => n + 1);
		appContext.notify(isKo
			? `${appContext.shared.tlFrame}프레임에 포즈를 전신 IK 보정 키로 추가했어요 — 모션은 그대로예요`
			: `Pose keyed as a full-body IK correction at frame ${appContext.shared.tlFrame} — the take stays`);
		return true;
	}

	function downloadArdyPose() {
		const rig = appContext.shared.posedRig();
		if (!rig) {
			appContext.notify(ko("Character not loaded yet", "캐릭터가 아직 로드되지 않았어요"));
			return;
		}
		trackFeature("export_pose");
		const pose = buildArdyPose({
			rig,
			camRef: appContext.shared.shotCamRef,
			look: appContext.shared.look,
			fovDeg: appContext.shared.fovDeg,
			slate: slateLine(appContext.shared.shot),
			// rigName follows the posed character's actual model below
			rigName: appContext.shared.posingChar?.model ?? appContext.shared.charA.model,
			root: captureArdyRoot(rig),
		});
		const blob = new Blob([JSON.stringify(pose, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "cozyclay-pose.json";
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
		appContext.notify(ko("Pose exported", "포즈 내보내기 완료"));
	}

	function recheckMotionHealth() {
		setBridgeChecking(true);
		return appContext.shared.bridgeRefreshRef.current().finally(() => setBridgeChecking(false));
	}

	function requestMotionGeneration(surface, inputMode, body = {}) {
		const request = startMotionRequest({ surface, input_mode: inputMode });
		const options = { body, lineEditSupported: lineEditBackend };
		// Record known readiness refusals even if existing input validation returns
		// early. A pass waits for the fully packaged payload at the queue boundary.
		// The queue independently checks readiness; telemetry failure cannot
		// enable or disable generation.
		if (motionPreflightReason(bridge, options)) {
			request.preflight(bridge, options);
			const readiness = motionReadiness(bridge, options);
			appContext.notify(motionReadinessMessage(readiness), ({ loading: "Checking motion generation…", ready: "Ready for this motion request", not_configured: "No motion backend configured", unsupported_route: "This route cannot run the selected motion request" })[readiness] ?? "The motion backend is unavailable");
		}
		return request;
	}

	// Optional native-ARDY seed. Empty = request omits seed; the raw string
	// is kept as typed (trimmed only). runArdy validates the bridge contract
	// (integer in 0..2**31-1) right before the request and toasts on a
	// violation, so an invalid seed can never reach the bridge silently.
	function changeArdySeed(value) {
		setArdySeed(value.trim());
	}

	/** THE SEED RULE (contract C9), enforced in ONE place so no take-creating
	 * call site can forget it: an empty field is rolled here, a typed one is
	 * kept exactly as typed, and either way a concrete integer comes back to be
	 * both SENT and RECORDED. A take whose seed was never written down cannot
	 * be rebuilt from its recipe, which is the one promise the whole recipe
	 * model rests on. Returns null after toasting when the typed value violates
	 * the bridge contract — the caller must then abandon the request. */
	function takeSeed() {
		try {
			return resolveSeed(ardySeed, ARDY_SEED_MAX);
		} catch {
			appContext.notify((isKo, ko) => isKo ? `Seed는 0..${ARDY_SEED_MAX} 범위의 정수여야 해요. 비워 두면 자동으로 선택됩니다` : `Seed must be an integer in 0..${ARDY_SEED_MAX} — clear it to let the box pick one`);
			return null;
		}
	}

	/** CONFIRM the pull: the full-quality run of exactly what the preview has
	 * been showing. Its own run mode — the body carries lineEdit and NOTHING
	 * else authored, because C6 makes it exclusive with preserve, waypoints,
	 * segments, regenerateSegments and motionEdit — and it is the one path that
	 * commits a recipe and a version. Same builder, same SESSION SEED and same
	 * curve as the last preview; only `preview: true` is absent, which is what
	 * buys the full step count. */
	function runLineEdit() {
		if (appContext.shared.generationPendingRef.current || appContext.shared.genRunningRef.current || ardyRunning) return;
		const generationRequest = requestMotionGeneration("line_edit", "edit", { lineEdit: true });
		if (!appContext.shared.takeSourceUrl) {
			appContext.notify(ko("The current take has no bridge source — generate it once before editing a path", "현재 테이크에 브리지 원본이 없어요 — 궤적을 편집하기 전에 한 번 생성하세요"));
			return;
		}
		// No curve object means no edit — an untouched path is the take's own
		// trajectory, and sending it would ask the box to spend eight seconds
		// reproducing what is already there.
		if (!appContext.shared.lineEditPayload) {
			appContext.notify(ko(
				"Draw along the path, pull a dot, or pin a moment first",
				"먼저 궤적을 따라 그리거나, 점을 잡아당기거나, 순간을 찍어 주세요",
			));
			return;
		}
		if (!lineEditBackend) {
			appContext.notify(ko(
				"The line-editing backend is not connected yet",
				"라인 편집 백엔드가 아직 연결 전이에요",
			));
			return;
		}
		const request = appContext.shared.buildLineEditRequest(appContext.shared.lineEditPayload);
		if (!request.ok) {
			if (request.message) appContext.notify(request.message);
			return;
		}
		const { body, lineEdit, seed } = request;
		// The take being edited, not the draft that may be on screen: a preview
		// is a picture and must never become anyone's lineage.
		const source = appContext.shared.linePreviewSource;
		const queued = enqueueMotionJob({
			request: generationRequest,
			charId: source?.charId ?? appContext.shared.activeChar.id,
			charIndex: appContext.shared.activeCharIndex,
			prompt: body.prompt,
			body,
			hasBlockEdits: false,
			committedEditKeys: [],
			rootRotationDeg: source?.rotationDeg ?? motion.rotationDeg ?? appContext.shared.activeChar.rot,
			anchor: { x: motion.anchorX ?? appContext.shared.activeChar.x, z: motion.anchorZ ?? appContext.shared.activeChar.z },
			ikState: null,
			recipeIntent: "lineEdit",
			recipeSeed: seed,
			// sourceMotion is dropped on the way into the recipe: replay rebinds
			// it to whatever take it is re-applied to.
			// (stripSourceMotion keeps only C10's replay keys, so `preview` — when
			// the object came back from a draft build — cannot leak into a recipe.)
			recipeLineEdit: stripSourceMotion({ ...lineEdit, sourceMotion: undefined, seed }),
			recipeLabel: isKo ? `다듬기 · ${lineTrackLabel(appContext.shared.lineTrack)}` : `Refine · ${lineTrackLabel(appContext.shared.lineTrack)}`,
		});
		if (!queued) return;
		appContext.shared.generationPendingRef.current = true;
		// The pull has left the building. The curve stays (it is the reference
		// the next edit starts from) but its deformation is released, so the
		// Generate button goes back to needing a fresh pull instead of inviting
		// a second identical run while the first is still queued. The undo
		// stack goes with it: restoring a pull that is already generating would
		// invite the identical run this reset exists to prevent.
		//
		// This also ENDS THE PREVIEW SESSION: the draft comes off the viewport
		// (the real result will land on it in a couple of seconds, and until it
		// does the take on screen should be the take that exists) and the seed
		// is released, so the next pull is a new piece of work with a new roll.
		appContext.shared.clearLineEdit();
	}

	function runAllPromptBlocks(commandContext = null) {
		const characterId = appContext.storeDomain('cast').activeId;
		return commandContext ? generateMotion({ characterId }, commandContext)
			: appContext.bus.run('motion.generate', { characterId });
	}

	// The UI's uncommitted prompt/fresh choice is read synchronously at admission,
	// just like its seed and pose controls. It never survives into another run.
	let uiGenerationIntent = null;
	function runArdy({ promptOverride = ardyPrompt, durationOverride = ardyDuration, promptClipsOverride = [], fresh = false } = {}) {
		uiGenerationIntent = { prompt: promptOverride, blocks: promptClipsOverride, fresh };
		try { return appContext.bus.run('motion.generate', { characterId: appContext.storeDomain('cast').activeId, durationSeconds: Math.round(Number(durationOverride)) || ARDY_DURATION_MIN }); }
		finally { uiGenerationIntent = null; }
	}

	async function generateMotion(args, commandContext) {
		if (appContext.shared.generationPendingRef.current || appContext.shared.genRunningRef.current || ardyRunning) throw generationRefusal('TARGET_BUSY', 'A motion generation is already running.');
		if (appContext.shared.linePreviewUrl) throw generationRefusal('TARGET_NOT_READY', previewBlockingReason(en => en), previewBlockingReason(ko));
		const character = appContext.storeDomain('cast').read().find(row => row.id === args.characterId);
		const active = character.id === appContext.shared.loadedLayerCharRef.current;
		const posing = active && appContext.shared.posing;
		const rig = posing ? appContext.shared.posedRig() : appContext.shared.rigs[character.id];
		if (!rig) throw generationRefusal('TARGET_NOT_READY', 'Character not loaded yet', ko('Character not loaded yet', '캐릭터가 아직 로드되지 않았어요'));
		const take = domain.motionFor(character.id), state = ikStateFor(character.id);
		const intent = commandContext.origin === 'ui' ? uiGenerationIntent : null;
		const blocks = (intent?.blocks ?? character.layer.promptClips).filter(clip => clip.text.trim()).sort((a, b) => a.startFrame - b.startFrame);
		const prompt = intent?.prompt ?? blocks[0]?.text ?? (active ? ardyPrompt : '');
		let seed;
		try { seed = resolveSeed(args.seed ?? (active ? ardySeed : ''), ARDY_SEED_MAX); }
		catch (error) { throw generationRefusal('INVALID_ARGUMENT', error.message); }
		const input = { character, prompt, blocks, seed, durationSeconds: args.durationSeconds ?? (blocks.length ? Math.max(ARDY_DURATION_MIN, Math.ceil(Math.max(...blocks.map(clip => clip.endFrame)) / TIMELINE_FPS)) : ardyDuration),
			waypoints: character.layer.waypoints, motion: take, ikKeys: state.keys,
			startFromPose: ardyStartFromPose, posePlacement: ardyPosePlacement, frame: appContext.shared.tlFrame,
			preserveStrength, recipe: domain.layer(character.id).takeRecipe, fresh: intent?.fresh ?? false };
		const plan = buildGenerationRequest(input), resolved = resolveIkRig(rig);
		const image = appContext.shared.snapshotExportRig(rig);
		let poses;
		try {
			poses = plan.constraintFrames.map(frame => {
				if (take) applyMotionFrame(rig, take, frame);
				if (resolved && state.keys.size) ikEvaluate(resolved.chains, state, frame, resolved.fkJoints, take ? IK_CORRECTION_BLEND_FRAMES : 0);
				return { frame, pose: buildArdyPose({ rig, camRef: appContext.shared.shotCamRef, look: appContext.shared.look,
					fovDeg: appContext.shared.fovDeg, slate: slateLine(appContext.shared.shot), rigName: posing ? appContext.shared.posingChar?.model ?? character.model : character.model, root: captureArdyRoot(rig) }) };
			});
		} finally { appContext.shared.restoreExportRig(image); }
		const built = buildGenerationRequest({ ...input, poses });
		for (const warning of built.warnings) appContext.notify(warning);
		const request = requestMotionGeneration('timeline', take?.url && state.keys.size ? 'edit' : ardyStartFromPose ? 'pose' : 'prompt');
		commandContext.check();
		return new Promise((resolve, reject) => {
			const job = { request, commandContext, commandCompletion: { resolve, reject }, charId: character.id,
				charIndex: appContext.live.characters.findIndex(row => row.id === character.id), prompt: built.body.prompt,
				body: built.body, hasBlockEdits: built.hasBlockEdits, committedEditKeys: built.committedEditKeys,
				rootRotationDeg: built.rootRotationDeg, anchor: { x: character.x, z: character.z }, ikState: built.hasBlockEdits ? state : null,
				recipeIntent: built.hasBlockEdits ? 'carry' : 'fresh', recipeSeed: seed,
				recipeLabel: built.hasBlockEdits ? ko('Block fix', '블록 수정') : built.hasPromptSchedule ? ko('Blocks', '블록 생성')
					: input.fresh ? ko('New', '새로 만들기') : take?.url ? ko('Again', '다시 뽑기') : ko('Generate', '생성') };
			appContext.shared.generationPendingRef.current = enqueueMotionJob(job) === true;
			if (!appContext.shared.generationPendingRef.current) reject(generationRefusal('TARGET_NOT_READY', 'The motion backend cannot run this request.'));
		});
	}

	/* --------------------- trail drag -> preview -> regen -------------------- */
	function onTrailDragStart({ grabFrame } = {}) {
		if (!motion) return;
		const frame = Math.round(grabFrame ?? appContext.shared.tlFrame);
		appContext.shared.setTlFrame(frame);
		// The pre-drag take is both the deformation base (repeated moves re-derive
		// from it, so deltas never accumulate) and the undo snapshot.
		appContext.shared.trailBaseMotionRef.current = motion;
		appContext.storeDomain('motion').beginGesture();
	}

	/** World drag delta -> clip delta, shedding the character's stature scale
	 * (the trail is drawn scaled by it). */
	function trailClipDelta(base, delta, track = "hips", grabFrame = appContext.shared.tlFrame) {
		const statureScale = appContext.shared.activeChar.scale ?? 1;
		return worldDeltaToTrailClip(base, delta, { track, grabFrame, radiusFrames: trailFalloffFrames, rig: appContext.shared.activeRig, scale: statureScale });
	}

	/** Per-rAF drag preview. Deliberately React-free: the deformed take lands in
	 * a ref and on the rig directly, so a drag never re-renders the app. The
	 * trail/highlight lines are rewritten in place by MotionTrails itself. */
	function onTrailDragPreview({ track, grabFrame, delta }) {
		const base = appContext.shared.trailBaseMotionRef.current;
		if (!base) return;
		const deformed = applyTrailFalloffDelta(base, {
			grabFrame,
			radiusFrames: trailFalloffFrames,
			track, clipDelta: trailClipDelta(base, delta, track, grabFrame),
		});
		appContext.shared.trailPreviewMotionRef.current = deformed;
		const rig = appContext.shared.activeRig;
		if (!rig) return;
		applyMotionFrame(rig, deformed, Math.round(grabFrame));
		if (ikChains && appContext.shared.ikStateRef.current.keys.size > 0) {
			ikEvaluate(ikChains, appContext.shared.ikStateRef.current, Math.round(grabFrame), ikFkJoints, IK_CORRECTION_BLEND_FRAMES);
		}
	}

	function onTrailDragEnd({ track, grabFrame, delta }) {
		const base = appContext.shared.trailBaseMotionRef.current;
		const deformed = appContext.shared.trailPreviewMotionRef.current;
		appContext.shared.trailBaseMotionRef.current = null;
		appContext.shared.trailPreviewMotionRef.current = null;
		const size = delta ? Math.hypot(delta.x, delta.y, delta.z) : 0;
		if (!base || !deformed || size < 0.01) {
			// A sub-centimetre nudge is a mis-grab, not an authored edit: the
			// motion state never changed, so only the rig pose needs restoring.
			if (base && appContext.shared.activeRig) {
				applyMotionFrame(appContext.shared.activeRig, base, appContext.shared.tlFrame);
				if (ikChains && appContext.shared.ikStateRef.current.keys.size > 0) {
					ikEvaluate(ikChains, appContext.shared.ikStateRef.current, appContext.shared.tlFrame, ikFkJoints, IK_CORRECTION_BLEND_FRAMES);
				}
			}
			setTrailEdit(null);
			return;
		}
		const owned = appContext.storeDomain('motion');
		if (base !== owned.motionFor(appContext.shared.activeChar.id)) { owned.project(); throw new StudioProtocolError('STALE_TARGET', 'The take changed during the trail drag.'); }
		owned.run('motion.editTrail', { characterId: appContext.shared.activeChar.id, track, grabFrame, radiusFrames: trailFalloffFrames, delta });
		owned.finishGesture();
		setTrailEdit({ track, grabFrame, radiusFrames: trailFalloffFrames, clipDelta: trailClipDelta(base, delta, track, grabFrame) });
		const { startFrame, endFrame } = trailEditRange(base.frames, grabFrame, trailFalloffFrames);
		const conflictFrames = findAbsoluteIkKeyConflicts({ keys: appContext.shared.ikStateRef.current.keys, track, startFrame, endFrame });
		if (conflictFrames.length) appContext.notify(`${ko("Absolute IK keys in this range override the path edit — remove or re-key them", "이 구간의 절대 IK 키가 궤적 수정을 덮어써요 — 해당 키를 지우거나 다시 찍어주세요")} ${isKo ? `프레임 ${conflictFrames.join(", ")}` : `frames ${conflictFrames.join(", ")}`}`);
	}

	/** Send the pending trail edit through the existing motionEdit pipeline:
	 * the regen window is auto-derived from the grab + falloff, explicit IK
	 * keys inside the window ride as hard constraints (their tracks), and the
	 * deformed line contributes the grab-frame pose as a root guide. */
	function runTrailRegeneration() {
		if (appContext.shared.generationPendingRef.current || appContext.shared.genRunningRef.current || ardyRunning) return;
		const request = requestMotionGeneration("trail", "edit", { motionEdit: true });
		if (!trailEdit) return;
		// Same rule as runArdy: motionEdit rewrites a span of THE take, and a
		// draft on the viewport is not it.
		if (appContext.shared.linePreviewUrl) {
			appContext.notify(previewBlockingReason());
			return;
		}
		if (!motion?.url) {
			appContext.notify(ko("The current motion has no bridge source; generate the prompt blocks once before regenerating a trail edit", "현재 모션에 브리지 원본이 없어요. 궤적 수정을 재생성하려면 프롬프트 블록을 먼저 한 번 생성하세요"));
			return;
		}
		const rig = appContext.shared.activeRig;
		if (!rig) {
			appContext.notify(ko("Character not loaded yet", "캐릭터가 아직 로드되지 않았어요"));
			return;
		}
		const { startFrame, endFrame } = trailEditRange(motion.frames, trailEdit.grabFrame, trailEdit.radiusFrames);
		const frames = [...new Set([
			trailEdit.grabFrame,
			...appContext.shared.ikFrames.filter((frame) => frame >= startFrame && frame < endFrame),
		])].sort((a, b) => a - b);
		const currentFrame = appContext.shared.tlFrame;
		const entries = [];
		for (const frame of frames) {
			applyMotionFrame(rig, motion, frame);
			if (ikChains && appContext.shared.ikStateRef.current.keys.size > 0) {
				ikEvaluate(ikChains, appContext.shared.ikStateRef.current, frame, ikFkJoints, IK_CORRECTION_BLEND_FRAMES);
			}
			const pose = buildArdyPose({
				rig,
				camRef: appContext.shared.shotCamRef,
				look: appContext.shared.look,
				fovDeg: appContext.shared.fovDeg,
				slate: slateLine(appContext.shared.shot),
				rigName: appContext.shared.activeChar.model,
				root: captureArdyRoot(rig),
			});
			const wireFrame = toArdyFrame(frame);
			if (entries.length && wireFrame <= entries[entries.length - 1].frame) continue;
			const ikTracks = [...(appContext.shared.ikStateRef.current.keys.get(frame)?.keys() || [])];
			if (frame === trailEdit.grabFrame && trailEdit.track && !ikTracks.includes(trailEdit.track)) ikTracks.push(trailEdit.track);
			entries.push({ frame: wireFrame, timelineFrame: frame, tracks: ikTracks.length ? ikTracks : ["hips"], pose });
		}
		applyMotionFrame(rig, motion, currentFrame);
		if (ikChains && appContext.shared.ikStateRef.current.keys.size > 0) {
			ikEvaluate(ikChains, appContext.shared.ikStateRef.current, currentFrame, ikFkJoints, IK_CORRECTION_BLEND_FRAMES);
		}
		const prompt = (motion.prompt || "").trim() || "A person continues the motion naturally.";
		const body = {
			prompt,
			duration: motion.frames / TIMELINE_FPS,
			posePin: true,
			motionEdit: {
				sourceMotion: motion.url,
				startFrame: toArdyFrame(startFrame),
				endFrame: toArdyFrame(endFrame),
				contextBefore: 40,
				contextAfter: 20,
				edits: entries.map(({ frame, tracks, pose }) => ({ frame, tracks, pose })),
			},
		};
		// THE SEED RULE (C9) — a trail regeneration writes a new take too, so its
		// seed is rolled, sent and recorded like every other take-creating run.
		const seed = takeSeed();
		if (seed === null) return;
		body.seed = seed;
		const queued = enqueueMotionJob({
			request,
			charId: appContext.shared.activeChar.id,
			charIndex: appContext.shared.activeCharIndex,
			prompt,
			body,
			hasBlockEdits: true,
			committedEditKeys: entries.map(({ timelineFrame, tracks }) => ({ frame: timelineFrame, tracks })),
			rootRotationDeg: motion.rotationDeg ?? appContext.shared.activeChar.rot,
			anchor: { x: motion.anchorX ?? appContext.shared.activeChar.x, z: motion.anchorZ ?? appContext.shared.activeChar.z },
			ikState: appContext.shared.ikStateRef.current,
			// motionEdit rewrites a span of the loaded take; the recipe travels
			// forward unchanged because there is no recipe field that could
			// describe the splice (C10 excludes motionEdit from replay outright).
			recipeIntent: "carry",
			recipeSeed: seed,
			recipeLabel: ko("Trail fix", "궤적 수정"),
		});
		if (!queued) return;
		appContext.shared.generationPendingRef.current = true;
		setTrailEdit(null);
	}

	/* ------------------------- motion job queue ---------------------------
	 * One box, one job at a time: explicit entry points suppress duplicate
	 * requests through queueing and execution. The
	 * payload is frozen at enqueue time; completion delivers the clip to the
	 * REQUESTING character's layer, not whoever happens to be selected then. */
	const [genQueue, setGenQueue] = useState([]);

	function enqueueMotionJob(spec) {
		const options = { body: spec.body, lineEditSupported: lineEditBackend };
		spec.request.preflight(bridge, options);
		if (motionPreflightReason(bridge, options)) return;
		const id = `gen-${++appContext.shared.genJobSeq.current}`;
		setGenQueue((queue) => [...queue, { id, status: "queued", ...spec }]);
		appContext.notify((isKo, ko) => isKo ? `인물 ${spec.charIndex + 1} 모션 생성을 대기열에 넣었어요` : `Queued motion generation for Subject ${spec.charIndex + 1}`);
		return true;
	}

	async function executeMotionJob(job) {
		job.commandContext?.check();
		const controller = new AbortController();
		const abort = () => controller.abort(job.commandContext.signal.reason);
		job.commandContext?.signal.addEventListener("abort", abort, { once: true });
		appContext.shared.ardyAbortRef.current = controller;
		setArdyRunning(true);
		reportArdyStatus(ko("connecting…", "연결 중…"));
		setArdyReport(null);
		setArdyOutcome(null);
		// Replay notices belong to ONE run; the next run re-earns them.
		setReplayNotices([]);
		const request = job.request;
		request.start();
		controller.signal.addEventListener("abort", () => request.fail(new DOMException("", "AbortError")), { once: true });
		let editCommitReport = null;
		try {
			const done = await ardyGenerate(
				job.body,
				(event) => {
					if (event.event === "status") reportArdyStatus(event.message);
					else if (event.event === "report") {
						setArdyReport(event.report);
						if (job.hasBlockEdits) editCommitReport = event.report;
						// C10's per-entry replay report. Only the entries worth
						// acting on are kept: a refinement that failed outright,
						// or one whose range straddles an internal block
						// boundary (where block N+1 was conditioned on N's
						// PRE-edit tail, so the replay is approximate rather
						// than exact). Both are non-blocking — the take exists.
						if (Array.isArray(event.report.replay)) {
							setReplayNotices(event.report.replay.filter((entry) => entry?.ok === false || entry?.boundaryWarning === true));
						}
					}
				},
				{ signal: controller.signal },
			);
			if (
				job.hasBlockEdits &&
				(
					editCommitReport?.commit_verified !== true ||
					!job.body.motionEdit.edits.every((entry) =>
						editCommitReport.committed_keys?.includes(entry.frame)
					)
				)
			) {
				throw new Error(ko("The generated motion came back without verified authored pose keys", "생성된 모션에 검증된 수동 포즈 키가 없어요"));
			}
			job.commandContext?.check();
			if (!done.motionUrl) throw generationRefusal('TARGET_NOT_READY', 'The generator finished without a motion artifact.');
			setArdyOutcome({ ok: true, output: done.output, bytes: done.bytes, motionUrl: done.motionUrl, rotationDeg: job.rootRotationDeg });
			request.succeed();
			trackActivation("motion");
			// Fetch and decode the real npz right away; decode errors are shown
			// in the card, playback is never faked. The clip lands on the
			// REQUESTING character, not whoever is selected now.
			if (done.motionUrl) {
				await deliverMotion(job, done.motionUrl);
				if (!controller.signal.aborted && appContext.live.characters.some((entry) => entry.id === job.charId)) request.apply();
				if (!appContext.storeDomain('motion')) commitTakeRecipe(job, done.motionUrl);
			}
			if (!appContext.storeDomain('motion') && job.hasBlockEdits && job.ikState) {
				// Timeline frames, not the wire frames in body.motionEdit.edits:
				// these light up the IK markers on the production clock.
				setCommittedIkEdits((current) => [...current, ...job.committedEditKeys]);
				job.ikState.keys.clear();
				job.ikState.tracked.clear();
				job.ikState.plants.clear();
				setIkTick((value) => value + 1);
			}
			appContext.notify((isKo, ko) => isKo ? `인물 ${job.charIndex + 1} 모션 생성됨` : `Motion generated for Subject ${job.charIndex + 1}`);
		} catch (err) {
			// Wave-2 gate, second line of defence. The capability preflight
			// normally stops a line edit before it is sent, but a bridge that
			// advertises the route and then 400s on the field (a half-landed
			// wave 2, an older sidecar behind the proxy) must read as "not
			// connected yet", not as a red generation failure the user could
			// act on.
			if (job.body.lineEdit && isLineEditUnsupported(err?.message)) {
				appContext.notify(ko(
					"The line-editing backend is not connected yet",
					"라인 편집 백엔드가 아직 연결 전이에요",
				));
			}
			setArdyOutcome({
				ok: false,
				message: err?.name === "AbortError" ? ko("Cancelled", "취소됨") : err?.message || String(err),
			});
			request.fail(err, job.body.lineEdit && isLineEditUnsupported(err?.message) ? "unsupported_route" : undefined);
			throw err;
		} finally {
			setArdyRunning(false);
			appContext.shared.ardyAbortRef.current = null;
			job.commandContext?.signal.removeEventListener("abort", abort);
		}
	}

	/* ------------------- recipe + version bookkeeping (C9/C12) ----------------
	 * ONE writer for both. Every take that reaches the app came out of a job,
	 * so a job's completion is the only place where "what is this take made of"
	 * can be answered honestly, and the answer is checkpointed next to the
	 * motionUrl in the same breath. Nothing else may write takeRecipeRef except
	 * loadTakeVersion, which restores a checkpoint rather than authoring one. */
	function commitTakeRecipe(job, motionUrl) {
		const owned = appContext.storeDomain('motion');
		const base = owned ? owned.layer(job.charId).takeRecipe : appContext.shared.takeRecipeRef.current;
		let next = base;
		if (job.recipeIntent === "fresh") {
			// A regeneration that carried `replay` produced a take that ALREADY
			// contains those edits, so they stay on the recipe. Resetting
			// lineEdits to [] here would make the second regeneration lose what
			// the first one preserved — the exact failure replay exists to fix.
			next = freshRecipe({
				seed: job.recipeSeed,
				blocks: blocksFromRequest(job.body, ARDY_FPS),
				lineEdits: job.body.replay ?? [],
			});
		} else if (job.recipeIntent === "lineEdit") {
			// A take imported by url (?motion=, a reload) has no recipe of its own.
			// The edit's body carries the take's prompt and length, so a
			// best-effort single block is recorded rather than dropping the
			// refinement on the floor; only the SEED is a guess, and it is the
			// one this edit actually ran with. The seedless placeholder recipe an
			// imported take is given (seedLoadedTake) counts as "no recipe" for
			// the seed specifically: adopting this edit's seed is what turns it
			// into something that can replay at all.
			const seeded = Number.isInteger(base?.seed)
				? base
				: freshRecipe({
					seed: job.recipeSeed,
					blocks: base?.blocks?.length ? base.blocks : blocksFromRequest(job.body, ARDY_FPS),
					lineEdits: base?.lineEdits ?? [],
				});
			next = withLineEdit(seeded, job.recipeLineEdit);
		}
		if (owned) {
			owned.writeLayer(job.charId, { takeRecipe: next, takeVersions: pushTakeVersion(owned.layer(job.charId).takeVersions, {
				motionUrl, recipe: next, savedAt: Date.now(), label: job.recipeLabel ?? '',
			}, TAKE_VERSIONS_MAX) });
			return;
		}
		appContext.shared.takeRecipeRef.current = next;
		setTakeRecipe(next);
		setTakeVersions((list) => pushTakeVersion(list, {
			motionUrl,
			recipe: next,
			savedAt: Date.now(),
			label: job.recipeLabel ?? "",
		}, TAKE_VERSIONS_MAX));
	}

	/* A take can also arrive WITHOUT a job behind it — ?motion=<url>, the shipped
	 * demo clip, a scene reload that re-fetches a stored motionRef. Those takes
	 * used to leave the version strip empty, so the first refinement had nothing
	 * to walk back to and the artist's only checkpoint was the thing they had
	 * just overwritten. They get a v1 like everything else.
	 *
	 * WHAT IS HONESTLY KNOWN is the take's url, its prompt and its length —
	 * NOT its seed, which was rolled on the box in a session nobody here
	 * witnessed. So the placeholder recipe carries `seed: null` and every reader
	 * treats that as "this take cannot be rebuilt": no request may attach it as
	 * C10 `replay` (a replay whose base is a different random take re-applies
	 * refinements to a stranger), and the first real edit adopts its own seed in
	 * commitTakeRecipe. A checkpoint you can return to beats a recipe you can
	 * replay, and this gets the first without pretending to the second. */
	function seedLoadedTake(url, prompt, frames) {
		if (appContext.storeDomain('motion')) return;
		if (!url || appContext.shared.takeRecipeRef.current) return;
		const recipe = Object.freeze({
			seed: null,
			blocks: Object.freeze([Object.freeze({
				prompt: typeof prompt === "string" ? prompt : "",
				duration: frames > 0 ? frames / TIMELINE_FPS : 0,
			})]),
			lineEdits: Object.freeze([]),
		});
		appContext.shared.takeRecipeRef.current = recipe;
		setTakeRecipe(recipe);
		setTakeVersions((list) => pushTakeVersion(list, {
			motionUrl: url,
			recipe,
			savedAt: Date.now(),
			label: ko("Loaded", "불러옴"),
		}, TAKE_VERSIONS_MAX));
	}

	/** Click a chip: that motionUrl becomes the active take through the SAME
	 * delivery path a fresh generation result travels, and the recipe saved
	 * beside it becomes the current one. Nothing is truncated — editing from an
	 * old version pushes a NEW version on top, so no click can destroy work. */
	async function loadTakeVersion(entry) {
		if (!entry?.motionUrl || motionBusy) return;
		if (appContext.storeDomain('motion')) return appContext.storeDomain('motion').run('motion.loadVersion', { characterId: appContext.shared.activeChar.id, motionUrl: entry.motionUrl });
		if (entry.motionUrl === appContext.shared.takeSourceUrl) return;
		// A pull in hand was authored against the take that is leaving. The
		// preview is dropped WITHOUT reverting: this call is already loading a
		// different take, and a revert would race it with a reload of the one
		// being left behind.
		appContext.shared.cancelLinePreview({ revert: false });
		if (appContext.shared.lineEditMode) appContext.shared.clearLineEdit();
		setReplayNotices([]);
		appContext.shared.takeRecipeRef.current = entry.recipe ?? null;
		setTakeRecipe(entry.recipe ?? null);
		try {
			await deliverMotion({
				charId: appContext.shared.activeChar.id,
				prompt: entry.recipe?.blocks?.[0]?.prompt ?? motion?.prompt ?? "",
				rootRotationDeg: motion?.rotationDeg ?? appContext.shared.activeChar.rot,
				anchor: { x: motion?.anchorX ?? appContext.shared.activeChar.x, z: motion?.anchorZ ?? appContext.shared.activeChar.z },
				calibration: motion?.sceneCalibration ?? null,
			}, entry.motionUrl);
		} catch {
			/* loadMotion already surfaced the decode failure in the panel */
		}
	}

	/* ---------------------- the two edit entries (C12) ------------------------
	 * Scene blocks the shot with Kimodo; Refine pulls one joint's path with
	 * ProjFlow. Everything else the pipeline can do is one of those two said
	 * more precisely, and both are reachable from the take itself instead of
	 * from a foldout the artist has to remember to open.
	 *
	 * WHY THE REASONS ARE FUNCTIONS, not toasts. An action the artist cannot
	 * take must say so BEFORE the click, in place, next to the button. A toast
	 * fired after the click teaches nothing: it arrives once, scrolls away, and
	 * leaves the button looking identical to the ones that work. Each reason
	 * below is rendered as a line under its entry AND as data-disabled-reason,
	 * which is also what the CDP surface gate reads. */
	function selectedMotionReadiness({ fresh = false, clips = appContext.shared.promptClips } = {}) {
		const authored = clips.filter((clip) => clip.text.trim()).sort((a, b) => a.startFrame - b.startFrame);
		const prompt = authored[0]?.text.trim() || ardyPrompt.trim();
		const duration = motion && appContext.shared.ikFrames.length > 0 ? motion.frames / motion.fps
			: authored.length ? Math.max(ARDY_DURATION_MIN, Math.ceil(Math.max(...authored.map((clip) => clip.endFrame)) / TIMELINE_FPS))
				: Math.round(Number(ardyDuration)) || ARDY_DURATION_MIN;
		const clipFrames = duration * TIMELINE_FPS;
		const segments = buildPromptSchedule(authored, clipFrames, prompt);
		const hasPromptSchedule = segments.length > 1;
		const editedSegments = motion?.url && hasPromptSchedule
			? segments.filter((segment) => appContext.shared.ikFrames.some((frame) => frame >= segment.startFrame && frame < segment.endFrame))
			: [];
		const hasBlockEdits = editedSegments.length > 0;
		const pinPlan = planPosePin({
			startFromPose: ardyStartFromPose,
			poseFrame: posePlacementFrame(ardyPosePlacement, clipFrames, appContext.shared.tlFrame),
			hasPromptSchedule, hasBlockEdits, waypointMode: appContext.shared.waypointMode, ikFrames: appContext.shared.ikFrames, clipFrames, segments, editedSegments,
		});
		// Only the capability-bearing fields are needed here; the queue still
		// preflights the actual frozen request before any generation HTTP call.
		const body = { prompt, duration, posePin: pinPlan.pin };
		if (hasBlockEdits) body.motionEdit = {};
		else if (hasPromptSchedule) body.segments = toArdySegments(segments);
		if (appContext.shared.waypointMode) body.waypoints = [{}];
		const recipe = appContext.shared.takeRecipeRef.current;
		if (!fresh && !hasBlockEdits && Number.isInteger(recipe?.seed)) body.replay = replayPayload(recipe);
		if (!fresh && !hasBlockEdits && !hasPromptSchedule && motion?.url && preserveStrength > 0
			&& Math.abs(motion.frames / TIMELINE_FPS - duration) <= 1 / ARDY_FPS + 1e-9) {
			const blocks = blocksFromRequest(body, ARDY_FPS);
			if (recipe?.blocks?.length === blocks.length
				&& recipe.blocks.every((block, index) => block.prompt.trim() === blocks[index].prompt.trim())) body.preserve = {};
		}
		return motionReadiness(bridge, { body, lineEditSupported: lineEditBackend });
	}

	const generationBusy = ardyRunning || genQueue.some((job) => job.status === "queued" || job.status === "running");

	function openMotionSetup(kind = "prompt") {
		setMotionSetupKind(kind);
		setMotionSetupReveal((value) => value + 1);
	}

	function refineDisabledReason() {
		if (!motion) return ko("No take yet — block a scene first", "아직 테이크가 없어요 — 먼저 장면을 만들어 주세요");
		if (!motion.url) return ko("This take has no bridge source — generate it once before refining", "이 테이크에는 브리지 원본이 없어요 — 한 번 생성해야 다듬을 수 있어요");
		return "";
	}

	function sceneDisabledReason() {
		if (bridge === null || bridgeChecking) return motionReadinessMessage("loading");
		if (generationBusy) return ko("A generation is already running", "이미 생성이 돌고 있어요");
		// NOT a line-edit preview, deliberately. Every other reason here is a
		// standing capability the entry should be greyed for; a draft on the
		// viewport lasts a second and a half, and a reason line appearing and
		// vanishing under the Scene button RESIZES THE TAKE BAR — which shortens
		// the stage, which changes the camera aspect, which the drift watcher
		// reads as "the view moved".
		//
		// THE TEETH ARE OUT OF THAT TRAP: drift no longer discards anything, so a
		// take-bar resize now costs at most a flicker of the ghosted paint and the
		// hint while the aspect settles — it used to kill the pull ~400 ms after
		// every draft landed. The refusal still lives in runArdy /
		// runTrailRegeneration rather than here, because a reason line that
		// appears and vanishes under the pointer is its own small nuisance and
		// nothing is gained by moving it back.
		return "";
	}

	/** The one sentence every take-consuming action says while a draft is up. */
	function previewBlockingReason(localize = ko) {
		return localize(
			"A line-edit preview is on the viewport — press Generate to keep it, or undo (Ctrl/Cmd+Z) to drop it",
			"라인 편집 미리보기가 떠 있어요 — 생성으로 확정하거나 Ctrl/Cmd+Z로 되돌린 뒤에 쓰세요",
		);
	}

	function sceneGenerateDisabledReason() {
		return sceneDisabledReason()
			|| (ardyPrompt.trim() || appContext.shared.promptClips.some((clip) => clip.text.trim())
				? ""
				: ko("Describe the motion first — press 4 and add a prompt with + on the Prompt lane", "먼저 어떤 동작인지 적어 주세요 — 4를 누르고 프롬프트 레인의 +로 프롬프트를 추가하세요"));
	}

	/** Taking it AGAIN needs no fresh wording: the loaded take already knows what
	 * it was asked for, so its own prompt is the fallback (the same fallback
	 * runLineEdit uses). What it does need is a take to re-take. */
	function sceneAgainPrompt() {
		return ardyPrompt.trim() || (motion?.prompt ?? "").trim();
	}

	function sceneAgainDisabledReason() {
		return sceneDisabledReason()
			|| (motion?.url ? "" : ko("Nothing to redo yet — make a take first", "다시 뽑을 테이크가 없어요 — 먼저 한 번 만들어 주세요"))
			|| (sceneAgainPrompt() || appContext.shared.promptClips.some((clip) => clip.text.trim())
				? ""
				: ko("This take carries no prompt — add a block and describe it", "이 테이크에는 프롬프트가 없어요 — 블록을 추가하고 동작을 적어 주세요"));
	}

	/** ONE CLICK from a loaded take into drag mode. The pull itself is authored
	 * on the viewport, but its controls live under the character's Inspector, so
	 * selecting that character and revealing the panel happen HERE rather than
	 * being three clicks the artist has to find first. */
	function enterRefineMode() {
		const reason = refineDisabledReason();
		if (reason) {
			appContext.notify(reason);
			return;
		}
		setSceneMenuOpen(false);
		appContext.shared.selectActiveCharacterInHierarchy();
		appContext.shared.revealPromptBlocks();
		appContext.shared.toggleLineEditMode();
	}

	/** Take it again — same blocks, same lineage, refinements replayed. Authored
	 * blocks go through the batch path so the schedule survives; a single-prompt
	 * take goes straight through runArdy. */
	function runSceneAgain() {
		if (appContext.shared.promptClips.some((clip) => clip.text.trim())) runAllPromptBlocks();
		else runArdy({ promptOverride: sceneAgainPrompt() });
	}

	/** Add a block — the timeline's own add-block gesture, said as a button. */
	function addSceneBlock() {
		appContext.shared.addPromptClip(appContext.shared.tlFrame);
		appContext.shared.selectActiveCharacterInHierarchy();
		appContext.shared.revealPromptBlocks();
	}

	/** Hand a finished clip to the layer that asked for it: the buffer when
	 * the requester is still active, its stored session motion otherwise. A
	 * lightweight motionRef is persisted with the entry either way, so the
	 * clip can be re-fetched after a reload. */
	async function deliverMotion(job, motionUrl) {
		const calibration = job.calibration ?? job.sceneCalibration ?? null;
		const normalizedCalibration = normalizeMotionCalibration(calibration);
		const sceneAnchorX = job.anchor.x + normalizedCalibration.offsetX;
		const sceneAnchorZ = job.anchor.z + normalizedCalibration.offsetZ;
		const sceneRotationDeg = job.rootRotationDeg + normalizedCalibration.yawDeg;
		const motionRef = {
			url: motionUrl,
			prompt: job.prompt,
			rotationDeg: sceneRotationDeg,
			anchorX: sceneAnchorX,
			anchorZ: sceneAnchorZ,
		};
		if (calibration && typeof calibration === "object") motionRef.calibration = normalizedCalibration;
		if (!appContext.storeDomain('motion') && !job.commandContext) appContext.shared.publishStudioCharacters((list) => list.map((entry) => entry.id === job.charId ? { ...entry, motionRef } : entry));
		if (job.charId === appContext.shared.loadedLayerCharRef.current) {
			await loadMotion(motionUrl, job.prompt, job.rootRotationDeg, null, job.charId, null, { calibration, commandContext: job.commandContext, job });
			if (!appContext.storeDomain('motion') && job.commandContext) appContext.shared.publishStudioCharacters(appContext.live.characters.map(entry => entry.id === job.charId ? { ...entry, motionRef } : entry));
			return;
		}
		// Inbound boundary for a clip delivered to a non-active layer.
		const retimed = retimeMotion(await loadMotionFromUrl(motionUrl), TIMELINE_FPS);
		if (retimed.sourceBytes) retimed.motionId = await sha256Hex(retimed.sourceBytes);
		const decoded = applyMotionCalibration(retimed, { ...normalizedCalibration, yawDeg: 0, offsetX: 0, offsetZ: 0 }).motion;
		const clip = {
			...decoded,
			url: motionUrl,
			prompt: job.prompt,
			anchorX: sceneAnchorX,
			anchorZ: sceneAnchorZ,
			anchorFrame: 0,
			rotationDeg: sceneRotationDeg,
			sceneCalibration: normalizedCalibration,
			editSegments: createMotionEdit(decoded.frames),
		};
		if (calibration && typeof calibration === "object") clip.sceneCalibration = normalizedCalibration;
		// Same stature rule as loadMotion, on the layer that asked for the clip.
		const scale = characterScaleFor(decoded);
		const apply = () => {
			if (appContext.storeDomain('motion')) return commitLoadedTake(job.charId, clip, { job });
			appContext.shared.motionFullRef.current.set(job.charId, clip);
			const next = appContext.live.characters.map(entry => entry.id === job.charId ? { ...entry, scale, sessionMotion: clip, motionRef } : entry);
			appContext.shared.publishStudioCharacters(next);
		};
		if (job.commandContext) job.commandContext.commit(apply);
		else if (appContext.storeDomain('motion')) appContext.storeDomain('motion').runPrepared(job.charId, apply);
		else apply();
	}

	/** After a scene (re)load, re-fetch every persisted clip reference and
	 * rebuild the session motions. The bridge may be gone — failures just
	 * leave the character posed, never an error the user must act on. */
	async function restoreMotionRefs(list) {
		const epoch = ++appContext.shared.restoreEpochRef.current;
		const motions = appContext.shared.projectMotionsRef.current;
		try { const db = await openMotionDb(); const ids = [...new Set(list.map((entry) => entry.motionRef?.motionId?.toLowerCase()).filter(Boolean))]; const cached = await Promise.all(ids.map((id) => getMotion(db, id))); cached.filter(Boolean).forEach((record) => motions.set(record.motionId.toLowerCase(), record)); db.close(); } catch (error) { console.warn("[cozyclay] could not restore motion cache", error); }
		for (const entry of list) {
			const source = resolveMotionSource(entry.motionRef, motions);
			if (!entry.motionRef) continue;
			if (source.kind === "missing") {
				appContext.notify(isKo ? `저장된 모션이 누락되었습니다 (${entry.subject || entry.id})` : `Saved motion is missing for ${entry.subject || entry.id}`);
				continue;
			}
			const load = source.kind === "embedded" ? decodeMotionResource(source.record) : loadMotionFromUrl(source.url);
			load.then((raw) => {
				if (epoch !== appContext.shared.restoreEpochRef.current) return;
			// Inbound boundary: a re-fetched clip is retimed exactly like a
			// freshly generated one, so a reload cannot resurrect 20 fps frames.
			const sourceUrl = source.kind === "url" ? source.url : entry.motionRef?.url;
				const retimed = retimeMotion(raw, TIMELINE_FPS);
				const normalizedCalibration = normalizeMotionCalibration(entry.motionRef.calibration);
				const decoded = applyMotionCalibration(retimed, { ...normalizedCalibration, yawDeg: 0, offsetX: 0, offsetZ: 0 }).motion;
				const clip = {
					...decoded,
					url: sourceUrl,
					sourceBytes: raw.sourceBytes,
					prompt: entry.motionRef.prompt,
					anchorX: entry.motionRef.anchorX,
					anchorZ: entry.motionRef.anchorZ,
					anchorFrame: 0,
					rotationDeg: entry.motionRef.rotationDeg,
					sceneCalibration: normalizedCalibration,
					editSegments: createMotionEdit(decoded.frames),
				};
				if (entry.motionRef.calibration) clip.sceneCalibration = entry.motionRef.calibration;
				if (entry.motionRef.trailEdits) Object.assign(clip, restoreTrailEdits(clip, entry.motionRef.trailEdits));
				if (entry.motionRef.studioTakeId) clip.studioTakeId = entry.motionRef.studioTakeId;
				appContext.storeDomain('motion').hydrate(entry.id, clip, entry.motionRef);
			}).catch((error) => {
				if (epoch !== appContext.shared.restoreEpochRef.current) return;
				appContext.shared.setProjectManifest((current) => {
					const id = entry.motionRef?.motionId?.toLowerCase();
					if (!id || !current?.items?.some((item) => item.kind === "motion" && item.id === id)) return current;
					const items = current.items.map((item) => item.kind === "motion" && item.id === id
						? { ...item, status: "missing", url: undefined }
						: item);
					const totals = { embedded: 0, external: 0, missing: 0, bytes: 0 };
					for (const item of items) {
						totals[item.status] += 1;
						if (Number.isFinite(item.bytes)) totals.bytes += item.bytes;
					}
					return { items, totals, missing: items.filter((item) => item.status === "missing") };
				});
				// A saved take that fails to refetch used to vanish silently — the
				// user would find a merely posed character and assume their motion
				// was lost. Name it and offer the reload path.
				const subject = entry.subject || entry.id;
				appContext.notify(isKo
					? `저장된 모션을 다시 불러오지 못했어요 (${subject}) [${error?.code || "decode"}]`
					: `Saved motion could not be restored for ${subject} [${error?.code || "decode"}]`);
			});
		}
	}

	function cancelArdy() {
		appContext.shared.ardyAbortRef.current?.abort();
	}
	function captureI2vStill() {
		// H3 480P renders 832x480. The still is captured at exactly that canvas
		// (x2) regardless of the Studio's shot ratio; markI2vPose also switches
		// the viewport to the matching ratio so what the user framed is what
		// gets sent.
		const captured = appContext.shared.captureLiveFraming({ output: I2V_MOTION_STILL_OUTPUT });
		if (!captured?.dataUrl?.startsWith("data:image/")) throw new Error(ko("The shot renderer is not ready.", "렌더러가 준비되지 않았어요."));
		if (captured.width !== I2V_MOTION_STILL_OUTPUT.width || captured.height !== I2V_MOTION_STILL_OUTPUT.height) {
			throw new Error(ko(`The H3 480P reference must be captured at ${I2V_MOTION_STILL_OUTPUT.width}×${I2V_MOTION_STILL_OUTPUT.height}.`, `H3 480P 참조 캡처는 ${I2V_MOTION_STILL_OUTPUT.width}×${I2V_MOTION_STILL_OUTPUT.height}이어야 해요.`));
		}
		// H3 must see the same complete subject in both endpoints. A clipped
		// foot or head makes the model invent the missing geometry during the
		// transition, which is exactly the bad motion this flow is meant to avoid.
		const rig = appContext.live.state.rigs?.[appContext.shared.activeChar.id];
		const cam = appContext.shared.shotCamRef.current;
		if (!rig || !cam) throw new Error(ko("The full-body frame is not ready yet. Wait a moment and try the reference capture again.", "전신 프레임을 확인할 수 없어 참조를 캡처할 수 없어요. 잠시 후 다시 시도하세요."));
		rig.updateWorldMatrix(true, true);
		cam.updateMatrixWorld(true);
		const bounds = new THREE.Box3().setFromObject(rig);
		const corners = [
			new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
			new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.max.z),
			new THREE.Vector3(bounds.min.x, bounds.max.y, bounds.min.z),
			new THREE.Vector3(bounds.min.x, bounds.max.y, bounds.max.z),
			new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.min.z),
			new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.max.z),
			new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.min.z),
			new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z),
		].map((corner) => corner.project(cam));
		const margin = 0.94;
		const clipped = corners.some((corner) =>
			corner.z < -1 || corner.z > 1 || Math.abs(corner.x) > margin || Math.abs(corner.y) > margin
		);
		if (clipped) {
			throw new Error(ko(
				"The full character is not inside the A/B reference. In the shot view, pull the camera back until the head and both feet are visible, then capture again.",
				"A/B 참조에 캐릭터 전신이 다 안 들어왔어요. 샷 시점에서 머리와 양발이 화면 안에 들어오도록 카메라를 뒤로 빼고 다시 캡처하세요."
			));
		}
		if (!appContext.shared.i2vMotionSegmentationReady || !Array.isArray(captured.partColours) || captured.partColours.length === 0) {
			throw new Error(ko("Enable View → Body part colours → Shaded before capturing an A/B reference.", "A/B 참조는 View에서 부위 색상 → 음영을 켜야 캡처할 수 있어요."));
		}
		return { ...captured, framing: appContext.shared.captureCurrentFraming() };
	}
	/** Put the viewport on the Fal canvas and hand the fly controls to the
	 * shot camera, so the user composes the A/B reference on exactly the
	 * 832x480 frame the clip will have. Idempotent; capture does not need it. */
	function enterI2vFraming() {
		appContext.shared.runStudioAction("stage.setFilmback", { shotAspect: I2V_MOTION_SHOT_ASPECT });
		if (!appContext.shared.lookThroughShot) appContext.shared.enterShotLook();
	}
	function markI2vPose(slot) {
		try {
			if (slot === "b" && i2vMotion.a && framingDistance(i2vMotion.a.framing, appContext.shared.captureCurrentFraming()) > 0.001) {
				throw new Error(ko("The camera moved between A and B. Capture both refs with the same camera framing.", "A와 B 사이에서 카메라가 이동했어요. 같은 카메라 프레이밍으로 다시 캡처하세요."));
			}
			const still = captureI2vStill();
			// The capture is already on the Fal canvas; make the viewport agree so
			// the user sees the frame that was just sent.
			appContext.shared.runStudioAction("stage.setFilmback", { shotAspect: I2V_MOTION_SHOT_ASPECT });
			setI2vMotion((current) => ({ ...current, [slot]: still, status: "idle", error: "" }));
			if (slot === "a") appContext.shared.setI2vMotionCameraUnlocked(false);
			appContext.notify(isKo ? `포즈 ${slot.toUpperCase()} 캡처됨 · ${still.width}×${still.height}` : `Pose ${slot.toUpperCase()} captured · ${still.width}×${still.height}`);
		} catch (error) {
			setI2vMotion((current) => ({ ...current, error: error.message, status: "error" }));
		}
	}
	function clearI2vPose(slot) {
		setI2vMotion((current) => ({ ...current, [slot]: null, status: "idle", error: "", job: null }));
		if (slot === "a") appContext.shared.setI2vMotionCameraUnlocked(false);
	}
	function clearI2vMotion() {
		setI2vMotion({ a: null, b: null, job: null, status: "idle", error: "", instruction: "", promptOverride: "", duration: I2V_MOTION_MIN_DURATION, dailyRemaining: null });
		appContext.shared.setI2vMotionCameraUnlocked(false);
	}
	function restoreI2vCamera() {
		const framing = i2vMotion.a?.framing;
		const camera = appContext.shared.shotCamRef.current;
		if (!framing || !camera) return;
		camera.position.set(framing.pos.x, framing.pos.y, framing.pos.z);
		camera.rotation.order = "YXZ";
		camera.rotation.set(framing.pitch, framing.yaw, 0);
		camera.fov = framing.fovDeg;
		camera.updateProjectionMatrix();
		appContext.shared.look.current.yaw = framing.yaw;
		appContext.shared.look.current.pitch = framing.pitch;
		appContext.shared.shotCameraPosRef.current = { ...framing.pos };
		appContext.shared.setCameraPos({ ...framing.pos });
		appContext.shared.setFovDeg(framing.fovDeg);
		appContext.shared.setI2vMotionCameraUnlocked(false);
		setI2vMotion((current) => ({ ...current, error: "", status: "idle" }));
		appContext.notify(isKo ? "A 캡처 카메라로 복원했어요." : "Restored the camera used for A.");
	}
	function framingDistance(a, b) {
		if (!a || !b) return Infinity;
		return Math.max(
			Math.abs(a.pos.x - b.pos.x), Math.abs(a.pos.y - b.pos.y), Math.abs(a.pos.z - b.pos.z),
			Math.abs(a.yaw - b.yaw), Math.abs(a.pitch - b.pitch), Math.abs(a.fovDeg - b.fovDeg),
		);
	}
	/** The AI motion card's lock line: AI video motion is not enabled for this account. */
	function showI2vMotionLock() {
		setI2vMotion((current) => ({ ...current, error: ko("AI motion generation is locked during QA.", "AI 모션 생성은 QA 중 잠겨 있어요."), status: "error" }));
	}
	/** The AI motion card shows every failure itself. For motion.generateFromVideo the
	 * answer says what happened: `{ failed }` with the reason in English, or the
	 * finished job, the footage it was ingested as (null when ingest failed) and
	 * the account's daily generations left. */
	async function generateI2vMotion(kind = "interpolate", instructionOverride = null, commandContext = null) {
		// One explicit request on the motion:* contract (#466). While the route is
		// gated, the lock itself is the demand signal. Telemetry never decides.
		const motionRequest = startMotionRequest({
			surface: !commandContext ? "fal_card" : commandContext.origin === "mcp" || commandContext.origin === "live" ? "mcp" : "agent",
			input_mode: kind === "interpolate" ? "a_to_b" : "still",
		});
		if (!appContext.shared.i2vMotionEnabled) {
			motionRequest.block("locked");
			showI2vMotionLock();
			return { failed: "AI video motion (Fal) is not enabled for this account." };
		}
		let source = i2vMotion;
		if (kind === "act" && !source.a) {
			try { source = { ...source, a: captureI2vStill() }; setI2vMotion((current) => ({ ...current, a: source.a })); }
			catch (error) {
				motionRequest.block("missing_input");
				setI2vMotion((current) => ({ ...current, error: error.message, status: "error" }));
				return { failed: "Could not capture the character's pose frame: the full body must be inside the shot frame, shaded part colours must be on (view.setPartColours { mode: \"shaded\" }), and the renderer and rig must be ready." };
			}
		}
		if (kind === "interpolate" && (!source.a || !source.b)) {
			motionRequest.block("missing_input");
			setI2vMotion((current) => ({ ...current, error: ko("Capture both A and B poses first.", "A와 B 포즈를 먼저 캡처하세요."), status: "error" }));
			return { failed: "Capture both A and B poses first." };
		}
		if (!source.a?.partColours || (kind === "interpolate" && !source.b?.partColours)) {
			motionRequest.block("missing_input");
			setI2vMotion((current) => ({ ...current, error: ko("Recapture A/B refs with shaded body-part segmentation enabled.", "색 세그멘테이션이 포함된 음영 A/B 참조를 다시 캡처하세요."), status: "error" }));
			return { failed: "The captured pose frame has no shaded body-part segmentation; the user must recapture it in the Fal card with shaded part colours on." };
		}
		if (kind === "interpolate" && framingDistance(source.a.framing, source.b.framing) > 0.001) {
			motionRequest.block("missing_input");
			setI2vMotion((current) => ({ ...current, error: ko("The camera changed between A and B. Capture both poses with the same camera.", "A와 B 사이에서 카메라가 바뀌었어요. 같은 카메라로 다시 캡처하세요."), status: "error" }));
			return { failed: "The camera changed between poses A and B; capture both with the same camera." };
		}
		// A hand-edited prompt wins verbatim; otherwise build from the description.
		// Interpolate now honours the description too (#380): the bare pose
		// difference lets the model invent the transition and produces junk.
		const description = instructionOverride || source.instruction || "";
		const prompt = source.promptOverride?.trim()
			? source.promptOverride.trim()
			: buildH3MotionPrompt(description || (kind === "interpolate" ? "" : "Make the character perform the requested action."), { interpolate: kind === "interpolate" });
		setI2vMotion((current) => ({ ...current, status: "submitting", error: "", job: null }));
		motionRequest.pass("fal");
		motionRequest.start();
		try {
			const fetchImpl = commandContext ? (url, options) => fetch(url, { ...options, signal: commandContext.signal }) : undefined;
			const submitted = await submitMotionJob({
				kind,
				stillA: source.a?.dataUrl,
				stillB: source.b?.dataUrl,
				still: source.a?.dataUrl,
				prompt,
				duration: source.duration ?? I2V_MOTION_MIN_DURATION,
			}, fetchImpl);
			const id = submitted?.job?.id;
			if (!id) throw Object.assign(new Error(ko("The server did not return a motion job ID.", "생성 작업 ID를 받지 못했어요.")), { reason: "The motion server did not return a job id." });
			setI2vMotion((current) => ({ ...current, status: "queued", job: submitted.job, dailyRemaining: submitted.dailyRemaining }));
			const finished = await waitForMotionJob(id, {
				fetchImpl,
				onUpdate: (job) => setI2vMotion((current) => ({ ...current, job, status: job?.status ?? current.status })),
			});
			commandContext?.check();
			const job = finished?.job;
			if (job?.status !== "done") throw Object.assign(new Error(job?.error || ko("AI motion generation failed.", "AI 모션 생성에 실패했어요.")), job?.error ? {} : { reason: "The AI video generation failed." });
			motionRequest.succeed();
			setI2vMotion((current) => ({ ...current, job, status: "done", dailyRemaining: finished.dailyRemaining }));
			let footage = null;
			if (job.video?.url) {
				const motionSource = { kind: "url", url: job.video.url, name: `Fal H3 Max Turbo · ${job.resolution}` };
				setMultiModelSource(motionSource);
				// Put the completed clip through the same probe/ingest path as a
				// manually supplied URL so GVHMR sees measured fps, duration and
				// a ready extraction card without another generation request.
				footage = (await ingestFootage(motionSource, commandContext)) ?? null;
				appContext.shared.setResult({
					mode: "video",
					modelLabel: "Fal H3 Max Turbo",
					prompt,
					frame: source.a?.dataUrl ?? null,
					videoUrl: job.video.url,
					motion: {
						videoUrl: job.video.url,
						resolution: job.resolution,
						width: job.width,
						height: job.height,
						fps: job.fps,
						duration: job.resultDuration ?? job.duration,
						cost: job.cost,
					},
				});
				appContext.shared.setResultOpen(true);
				// Applied = the clip is in the Studio, ready for GVHMR extraction.
				motionRequest.apply();
				// The result modal and the studio modal are both z-30; never stack them.
				appContext.shared.setI2vMotionStudioOpen(false);
				appContext.notify((isKo, ko) => isKo ? "AI 영상이 준비됐어요 · 추출 패널에서 GVHMR을 실행하세요" : "AI video is ready · run GVHMR from the extraction panel");
			}
			return { job, footage, dailyRemaining: finished.dailyRemaining ?? null };
		} catch (error) {
			const cancelled = Boolean(commandContext && (commandContext.signal.aborted || error?.code === "STALE_TARGET"));
			// 429 is the account's daily cap (workers/api daily_cap).
			motionRequest.fail(error, cancelled ? "aborted" : error?.status === 429 ? "quota" : "generation_failed");
			if (cancelled) throw error;
			setI2vMotion((current) => ({ ...current, status: "error", error: error.message || String(error) }));
			return { failed: error.reason ?? `The AI video generation failed: ${error.message || error}` };
		}
	}
	/** Why the chip cannot start an AI video motion now, as the user reads it:
	 * one already running, or none left today. The lock has its own AI motion card line. */
	function i2vMotionUnavailable() {
		if (!["idle", "done", "error", "failed"].includes(i2vMotion.status)) return ko("A generation is already running", "이미 생성이 돌고 있어요");
		if (i2vMotion.dailyRemaining === 0) return ko("No AI video motion generations left today", "오늘 남은 AI 영상 모션 생성이 없어요");
		return null;
	}
	function generateI2vMotionFromUi(instruction) {
		if (!appContext.shared.i2vMotionEnabled) {
			// Locked, the action's availability check refuses before
			// generateI2vMotion runs, so the chip records its own lock (#466).
			startMotionRequest({ surface: "agent", input_mode: "still" }).block("locked");
			showI2vMotionLock();
		} else {
			// The chip clears the typed instruction when clicked, so a refusal says why.
			const reason = i2vMotionUnavailable();
			if (reason) { appContext.notify(reason); return null; }
		}
		return appContext.shared.runStudioAction("motion.generateFromVideo", { instruction });
	}
	function updateI2vMotionQuota(dailyRemaining) { setI2vMotion((current) => ({ ...current, dailyRemaining })); }
	domain.setVideoDraft = patch => setI2vMotion(current => ({ ...current, ...patch }));
	domain.requestLineEdit = runLineEdit;
	domain.requestTrailRegeneration = runTrailRegeneration;
	domain.generate = generateMotion;
	domain.isGenerating = () => appContext.shared.generationPendingRef.current || appContext.shared.genRunningRef.current || ardyRunning;
	domain.onPhysicsRunning = setAutoPhysicsRunning;
	domain.onPhysicsProgress = setPhysicsProgress;
	domain.onPhysicsPreview = result => { setPhysicsPreview(result); setPhysicsShow(true); setIkTick(value => value + 1); };
	domain.platformFitRun = platformFitRun;
	domain.platformFitRemove = platformFitRemove;
	domain.beginPlayback = id => { const rig = appContext.shared.rigs[id]; if (rig) beginPlaybackOn(rig); };
	domain.loadRemote = async (args, context) => {
		const entry = domain.layer(args.characterId).takeVersions.find(version => version.motionUrl === args.motionUrl);
		if (args.motionUrl && !entry) throw new StudioProtocolError('TARGET_NOT_READY', 'This take version is no longer available.');
		if (args.drop != null && !normalizeRootDrop(args.drop)) throw new StudioProtocolError('INVALID_ARGUMENT', 'Invalid drop.');
		const toTimeline = frame => Math.round(frame * TIMELINE_FPS / ARDY_FPS);
		const clips = args.blocks?.length ? args.blocks.map(block => {
			if (block.endFrame <= block.startFrame) throw new StudioProtocolError('INVALID_RANGE', 'Prompt blocks must have a positive range.');
			return { id: crypto.randomUUID(), startFrame: toTimeline(block.startFrame), endFrame: toTimeline(block.endFrame), text: block.prompt };
		}) : null;
		const character = appContext.storeDomain('cast').read().find(row => row.id === args.characterId);
		const commandContext = !clips ? context : { ...context, commit: apply => context.commit(() => {
			const result = apply();
			appContext.recordAction('cast', () => appContext.storeDomain('cast').extendTimeline(Math.max(...clips.map(clip => clip.endFrame))), null, true);
			return result;
		}) };
		await loadMotion(args.url ?? args.motionUrl, args.prompt ?? entry?.recipe?.blocks?.map(block => block.prompt).join(' ') ?? domain.motionFor(args.characterId)?.prompt ?? '', character.rot,
			args.drop ?? null, args.characterId, clips, { commandContext, recipe: entry?.recipe });
	};
	appContext.updateActionPorts({ clearMotionNative: clearMotion, setCharacterIkKey, removeCharacterIkKey, clearCharacterIkKeys });
	return {
		...domain,
		i2vMotion, setI2vMotion, captureI2vStill, enterI2vFraming, markI2vPose, clearI2vPose, clearI2vMotion, restoreI2vCamera, framingDistance, showI2vMotionLock, generateI2vMotion, i2vMotionUnavailable, generateI2vMotionFromUi, updateI2vMotionQuota,
		ikMode, ikChains, setIkChains, ikFkJoints, setIkFkJoints, ikFocus, setIkFocus, footSnap, setFootSnap,
		bodyContact, setBodyContact, IK_CORRECTION_BLEND_FRAMES, autoPhysicsRunning, setAutoPhysicsRunning,
		physicsPreview, setPhysicsPreview, physicsShow, physicsProgress, physicsOptions, setPhysicsOptions,
		ikTick, setIkTick, committedIkEdits, setCommittedIkEdits, trailFalloffS, setTrailFalloffS, showTrails,
		setShowTrails, ikEditTool, setIkEditTool, trailEdit, trailFalloffFrames, focusIkHandle, snapshotIkKeys,
		rangePinApplySpec: (pin) => {
			domain.run('motion.rangePin.apply', { characterId: appContext.shared.activeChar.id, pin });
			return { residuals: decodeRangePinResiduals(domain.layer(appContext.shared.activeChar.id).ikPinResiduals).get(pin.id) };
		},
		rangePins, rangePinResiduals, rangePinSelection, setRangePinSelection, rangePinPartPick, setRangePinPartPick, rangePinPreview, previewRangePinDraft, applyRangePinDraft, deleteRangePin,
		setCharacterIkKey, removeCharacterIkKey, clearCharacterIkKeys, bridge, setBridge, bridgeChecking,
		motionSetupReveal, motionSetupKind, setArdyPrompt, setArdyDuration, ardySeed, preserveStrength,
		setPreserveStrength, takeRecipe, takeVersions, replayNotices, sceneMenuOpen, setSceneMenuOpen,
		ardyRunning, ardyStatus, ardyOutcome, lineEditBackend, setLineEditBackend, motion, motionBusy,
		multiModelUrl, setMultiModelUrl, multiModelSource, setMultiModelSource, multiModelStatus,
		multiModelStage, multiModelProgress, multiModelFootage, multiModelError, multiModelTake,
		multiModelExtract, multiModelExtractProgress, multiModelExtractError, advanceFrame, stepFrame,
		leaveIkMode, beginPlaybackOn, chooseMultiModelFile, pasteMultiModelUrl, useMultiModelUrl, ingestFootage,
		extractMultiModelMotion, deliverExtraTakes, loadMotion, clearMotion: () => appContext.bus.run('motion.clear', { characterId: appContext.shared.activeChar.id }), clearMotionNative: clearMotion, applyMotionTrim, resetMotionTrim, cutMotionAtPlayhead,
		changeMotionSegmentSpeed, removeMotionSegmentById, poseOtherCastMembers, toggleIkMode, ikSolve,
		ikDragEnd, ikAddKeyframe, externalBlockers, runFixCollisions, runFixCollisionsRange,
		changePhysicsOptions, showPhysicsPreview, cancelPhysicsPreview, applyPhysicsPreview, runAutoPhysics,
		platformFitRun, platformFitApply, platformFitRemove, platformFitRunning, platformFitLast, platformFitProgress, platformFitApplied,
		ikDeleteKeyframe, ikApplyPoseAsKey, recheckMotionHealth, changeArdySeed, takeSeed,
		runLineEdit: () => domain.run('motion.commitLineEdit', { characterId: appContext.shared.activeChar.id }),
		runAllPromptBlocks, runArdy, onTrailDragStart, onTrailDragPreview, onTrailDragEnd,
		runTrailRegeneration: () => domain.run('motion.regenerateTrail', { characterId: appContext.shared.activeChar.id }),
		genQueue, setGenQueue, executeMotionJob, seedLoadedTake, loadTakeVersion, selectedMotionReadiness,
		generationBusy, openMotionSetup, refineDisabledReason, sceneDisabledReason, sceneGenerateDisabledReason,
		sceneAgainDisabledReason, enterRefineMode, runSceneAgain, addSceneBlock, restoreMotionRefs, cancelArdy,
	};
}
