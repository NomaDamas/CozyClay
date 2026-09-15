// Private Studio motion candidates. No renderer installation, App callbacks or
// telemetry: the editor owns the atomic domain commit and its shared journal.
import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { StudioProtocolError, StudioSchemas, validateStudioSchema, validateStudioIdentity, validateTargetGuard, validateFrameRange, validateReceipt, freezeStudioData } from './studio-agent-protocol.js';
import { loadMotionFromUrl, characterScaleFor } from './ardy/npz.js';
import { retimeMotion } from './ardy/retime.js';
import { applyMotionCalibration, normalizeMotionCalibration } from './ardy/motion-calibration.js';
import { applySupportRise, autoRoofDrop, applyAutoFall } from './ardy/root-drop.js';
import { createMotionEdit } from './ardy/motion-edit.js';
import { applyMotionFrame } from './ardy/playback.js';
import { resolveIkRig, createIkState, ikEvaluate, findBone, hasBindPose } from './ardy/ik.js';
import { PHYSICS_LIMITS, SUPPORT_SITES, createSupportSampler, copyPhysicsKeys, physicsKeyStamp, supportIntervals, physicsMetrics, reviewAutoPhysics } from './ardy/physics-review.js';
import { createDynamicsSampler, supportDiagnostics } from './ardy/physics-support.js';
import { computeCenterOfMass } from './ardy/auto-physics.js';
import { buildCollisionCapsules, detectPenetrations, supportsCollisionCleanup, fixCollisionsRange } from './ardy/fix-collisions.js';
import { collisionBlockers, blockerSummary } from './ardy/collision-blockers.js';
import { createGroundSampler } from './ardy/ground.js';
import { supportHeightForObject, OBJECT_LIBRARY } from './scene-objects.js';
import { objectTransformAt } from './object-path.js';
import { sampleAt } from './sample-at.js';

const PROFILE = 'studio-motion-v1', BLEND = 6;
const fail = (code, message) => { throw new StudioProtocolError(code, message); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const id = value => validateStudioSchema(StudioSchemas.TargetGuard.properties.targetId, value);
const copyLayer = state => ({ ...createIkState(), keys: copyPhysicsKeys(state?.keys ?? new Map()), tracked: new Set(state?.tracked ?? []) });
const poseOf = rig => { const result = []; rig.traverse(n => { if (n.isBone) result.push({ bone: n, p: n.position.clone(), q: n.quaternion.clone(), s: n.scale.clone() }); }); return result; };
const restore = pose => { for (const { bone, p, q, s } of pose) { bone.position.copy(p); bone.quaternion.copy(q); bone.scale.copy(s); } };
const poseValues = pose => pose.map(({ bone }) => [...bone.position.toArray(), ...bone.quaternion.toArray(), ...bone.scale.toArray()]);
const environmentKey = env => JSON.stringify([validateStudioIdentity(env.host), env.physicsRevision, env.floor]);
const BASE_LIMITATIONS = ['discrete-integer-24fps-frames', 'calibrated-capsule-and-upright-box-proxies', 'external-torso-head-and-other-cast-fingers-excluded', 'rest-overlap-calibration-and-4mm-actionable-depth', 'centroidal-support-not-biomechanical-certification', 'semantic-and-visual-review-unavailable'];

function isolatedRig(source) {
  if (!source || !hasBindPose(source)) fail('TARGET_NOT_READY', 'A target rig with its original bind snapshot is required.');
  // SkeletonUtils remaps skeleton bones, but Object3D's JSON userData copy does
  // not remap poseBind's Map keys. Rebuild that map against the cloned nodes.
  const original = []; source.traverse(n => original.push(n));
  const rig = cloneSkeleton(source), nodes = []; rig.traverse(n => nodes.push(n));
  rig.userData.poseBind = new Map(original.flatMap((n, i) => {
    const bind = source.userData.poseBind.get(n);
    return bind ? [[nodes[i], structuredClone(bind)]] : [];
  }));
  const parent = new THREE.Group(); parent.matrixAutoUpdate = false;
  if (source.parent) parent.matrix.copy(source.parent.matrixWorld);
  parent.add(rig); parent.updateMatrixWorld(true);
  const rest = poseOf(rig), resolved = resolveIkRig(rig);
  if (!resolved || !supportsCollisionCleanup(rig)) { disposeRig({ rig, parent }); fail('TARGET_NOT_READY', 'Complete supported target IK and collision bones are required.'); }
  return { rig, parent, rest, ...resolved, surface: createSupportSampler(rig), dynamics: createDynamicsSampler(rig) };
}
function disposeRig(value) {
  // Geometry/material/texture assets are borrowed read-only. Only cloned
  // skeleton palettes and the private hierarchy belong to this candidate.
  const skeletons = new Set(); value.rig.traverse(n => { if (n.isSkinnedMesh) skeletons.add(n.skeleton); });
  for (const skeleton of skeletons) skeleton.dispose();
  value.parent.remove(value.rig);
}
function poseFrame(evaluator, motion, layer, frame) {
  restore(evaluator.rest);
  if (motion) applyMotionFrame(evaluator.rig, motion, sampleAt({ frameCount: motion.frames, motion }, null, frame).motionFrame);
  if (layer) ikEvaluate(evaluator.chains, layer, frame, evaluator.fkJoints, motion ? BLEND : 0);
  evaluator.parent.updateMatrixWorld(true);
}
function readSample(evaluator, groundAt) {
  const support = evaluator.surface(), toes = {};
  for (const side of ['left', 'right']) toes[`${side}Foot`] = findBone(evaluator.rig, `mixamorig${side === 'left' ? 'Left' : 'Right'}ToeBase`).getWorldPosition(new THREE.Vector3());
  const knees = Object.fromEntries(['leftFoot', 'rightFoot'].map(key => {
    const [a, b, c] = evaluator.chains.get(key).bones.map(n => n.getWorldPosition(new THREE.Vector3()));
    return [key, a.sub(b).angleTo(c.sub(b)) * 180 / Math.PI];
  }));
  const ground = Object.fromEntries(Object.entries(support).map(([key, p]) => [key, groundAt(p.point.x, p.point.z, p.position.y + .001)]));
  return { support, toes, knees, ground, root: evaluator.fkJoints.get('hips').bone.getWorldPosition(new THREE.Vector3()), com: computeCenterOfMass(evaluator.rig), dynamics: evaluator.dynamics() };
}
function validateClip(clip, frameCount) {
  if (clip.fps !== 24 || clip.frames !== frameCount) fail('VERIFICATION_FAILED', 'Retimed clip and compiled schedule disagree.');
  for (const [key, width] of [['rotMats', 243], ['rootPos', 3], ['posedJoints', 81]]) {
    if (clip[key]?.length !== frameCount * width || !clip[key].every(Number.isFinite)) fail('VERIFICATION_FAILED', 'Invalid decoded motion structure.');
  }
}
function scheduleOf(value) {
  if (value?.fps !== 24 || !Number.isSafeInteger(value.frameCount) || value.frameCount < 48 || value.frameCount > 1440 || value.durationSeconds !== value.frameCount / 24 || !Array.isArray(value.blocks) || !value.blocks.length) fail('INVALID_ARGUMENT', 'A compiled 2-60 second production schedule is required.');
  let end = 0;
  for (const block of value.blocks) {
    validateFrameRange({ startFrame: block.startFrame, endFrameExclusive: block.endFrameExclusive });
    if (block.startFrame !== end || block.endFrameExclusive - end > 120) fail('INVALID_ARGUMENT', 'Schedule must be contiguous with bounded blocks.');
    validateStudioSchema(StudioSchemas.ReceiptVariants.installed.properties.installed.properties.blocks.items.properties.sourceBeat, block.sourceBeat);
    end = block.endFrameExclusive;
  }
  if (end !== value.frameCount) fail('INVALID_ARGUMENT', 'Schedule does not span the whole clip.');
  return freezeStudioData(structuredClone(value));
}

/** Required ports (all reads synchronous):
 * readTarget(binding) -> {guard, character, rig, ikState, calibration?,
 *   protectedFrames?, preserveAuthoredMotion?}; rig is that character's current
 * world-space rig with poseBind. readEnvironment() -> {host, physicsRevision,
 * floor:{model:'flat',y}, objects, cast:[{character,rig,motion,ikState}], frameCount}.
 * Character paths not baked into a supplied rig/clip require poseCast(evaluator,
 * entry,frame), which may touch ONLY that private evaluator. See contract.md.
 * journal is task 2's per-document journal. commit(payload) is task 5's single
 * synchronous atomic owner, returning/journaling the actual installed receipt.
 * loadArtifact defaults to the real bounded NPZ fetch/decode; it never installs.
 */
export function createStudioMotionCandidates(ports) {
  const candidates = new Map(), admissions = new Map();
  const now = ports.now ?? Date.now, newId = ports.newId ?? (() => crypto.randomUUID());
  const yieldTask = ports.yieldTask ?? (() => new Promise(resolve => {
    const channel = new MessageChannel(); channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); }; channel.port2.postMessage(0);
  }));
  const ttlMs = ports.ttlMs ?? 600000;
  let disposed = false;
  function checkBinding(request) {
    id(request.commandId);
    const b = request.binding;
    const expected = { ...validateStudioIdentity(b.host), targetId: id(b.characterId), token: id(b.targetToken) };
    const target = ports.readTarget(b);
    if (!equal(validateStudioIdentity(ports.readEnvironment().host), b.host)) fail('STALE_SCENE', 'Candidate document is no longer current.');
    validateTargetGuard(expected, target?.guard);
    return target;
  }
  function fence(candidate) {
    if (disposed || candidate.cancelled || ports.isCancelled?.(candidate.request.commandId)) fail('CANCELLED', 'Candidate installation permission was revoked.');
    if (now() - candidate.createdAt >= ttlMs) fail('STALE_TARGET', 'Private candidate expired.');
    checkBinding(candidate.request);
  }
  function release(candidate) {
    if (candidate.released) return;
    candidate.released = true;
    candidate.controller.abort();
    if (candidate.evaluator) disposeRig(candidate.evaluator);
    for (const member of candidate.cast ?? []) if (member.evaluator) disposeRig(member.evaluator);
    candidate.cache = null; candidate.autoCache.value = null; candidate.evidence = null;
    candidate.evaluator = null; candidate.cast = []; candidate.motion = null; candidate.layer = null;
    candidates.delete(candidate.candidateId);
  }
  function rejection(request, error, phase) {
    const code = error instanceof StudioProtocolError ? error.code : 'VERIFICATION_FAILED';
    return validateReceipt({ ok: false, commandId: request.commandId, host: request.binding.host, code, phase,
      affectedIds: [request.binding.characterId], expectedTargets: [{ ...request.binding.host, targetId: request.binding.characterId, token: request.binding.targetToken }], currentTargets: [], mutated: false,
      preserved: { authoredState: 'unchanged' }, recovery: { action: 'new_intent', retryAllowed: false } });
  }
  async function operation(request, phase, work) {
    let candidate = candidates.get(request.candidateId);
    try {
      if (phase !== 'prepare') {
        if (!candidate || candidate.request.commandId !== request.commandId || !equal(candidate.request.binding, request.binding)) fail('STALE_TARGET', 'Candidate does not belong to this command.');
        fence(candidate);
        if (request.candidateRevision !== candidate.revision) fail('STALE_TARGET', 'Candidate revision changed.');
        if (candidate.busy) fail('TARGET_BUSY', 'Candidate evaluation is already in progress.');
        candidate.busy = true;
      }
      return await work(candidate);
    } catch (error) {
      candidate ??= [...candidates.values()].find(c => c.request.commandId === request.commandId);
      // Foreign requests and concurrent calls must not dispose another owner.
      if (candidate && candidate.request.commandId === request.commandId && equal(candidate.request.binding, request.binding) && error.code !== 'TARGET_BUSY') release(candidate);
      const receipt = rejection(request, error, phase);
      if (ports.journal.get(request.commandId) == null && error.code !== 'TARGET_BUSY') ports.journal.record(receipt);
      return receipt;
    } finally { if (candidate) candidate.busy = false; }
  }
  const summary = c => ({ candidateId: c.candidateId, candidateRevision: c.revision, targetToken: c.request.binding.targetToken, physicsRevision: c.env.physicsRevision, structurallyValid: true });
  function captureEnvironment(c) {
    const env = ports.readEnvironment();
    if (!Number.isSafeInteger(env.physicsRevision) || env.physicsRevision < 0 || !Number.isFinite(env.floor?.y)) fail('TARGET_NOT_READY', 'Authoritative physics revision and floor are required.');
    const key = environmentKey(env);
    if (c.envKey === key) return;
    if (c.envKey) {
      if (c.revalidatedEnvironment) fail('STALE_ENVIRONMENT', 'The environment changed more than once.');
      c.revalidatedEnvironment = true;
    }
    for (const member of c.cast) if (member.evaluator) disposeRig(member.evaluator);
    c.cast = [];
    c.env = { ...env, host: structuredClone(env.host), floor: structuredClone(env.floor), objects: structuredClone(env.objects), cast: undefined };
    c.envKey = key; c.cache = null; c.autoCache.value = null;
    for (const member of env.cast) {
      if (member.character.id === c.request.binding.characterId || member.character.hidden) continue;
      // Unsupported bystanders remain explicit missing coverage, never vanish
      // into characterBlockers' otherwise legitimate best-effort skip path.
      const entry = { character: structuredClone(member.character), motion: member.motion ? structuredClone(member.motion) : null, layer: copyLayer(member.ikState), evaluator: null };
      c.cast.push(entry);
      if (member.rig && hasBindPose(member.rig) && supportsCollisionCleanup(member.rig)) entry.evaluator = isolatedRig(member.rig);
    }
  }
  function checkpoint(c) {
    fence(c);
    if (environmentKey(ports.readEnvironment()) !== c.envKey) fail('STALE_ENVIRONMENT', 'Physical inputs changed during evaluation.');
    if (now() > c.deadline) fail('VERIFICATION_FAILED', 'Private verification/repair budget exceeded.');
  }
  function blockersAt(c, frame) {
    checkpoint(c);
    const rigs = {};
    for (const member of c.cast) {
      if (!member.evaluator) continue;
      poseFrame(member.evaluator, member.motion, member.layer, frame);
      ports.poseCast?.(member.evaluator, member, frame);
      member.evaluator.parent.updateMatrixWorld(true);
      rigs[member.character.id] = member.evaluator.rig;
    }
    return collisionBlockers({ rigs, activeId: c.request.binding.characterId, sceneObjects: c.env.objects, library: OBJECT_LIBRARY, frame, take: { frameCount: c.env.frameCount, fps: 24 } });
  }
  async function samples(c, layer) {
    const rows = [], poses = [], collisions = [], blockers = [];
    for (let frame = 0; frame < c.motion.frames; frame++) {
      checkpoint(c); poseFrame(c.evaluator, c.motion, layer, frame);
      const shapes = blockersAt(c, frame);
      const objects = c.env.objects.map(object => {
        const at = objectTransformAt(object, frame, { frameCount: c.env.frameCount, fps: 24 });
        return at ? { ...object, x: at.x, y: at.y, z: at.z, rot: at.rot ?? object.rot } : object;
      });
      rows.push(readSample(c.evaluator, createGroundSampler(objects, { floorY: c.env.floor.y })));
      poses.push(poseValues(c.evaluator.rest));
      const capsules = buildCollisionCapsules(c.evaluator.rig);
      collisions.push(detectPenetrations(capsules, { blockers: shapes }).map(p => ({ a: p.a.def.id, b: p.b.def?.id ?? p.b.id, depth: p.depth })));
      blockers.push(blockerSummary(shapes));
      if (frame % 12 === 11) { await yieldTask(); checkpoint(c); }
    }
    const contacts = supportIntervals(rows, 24, [], c.env.floor.y);
    return { rows, poses, collisions, blockers, contacts, metrics: physicsMetrics(rows, contacts.masks, 24, c.env.floor.y), support: supportDiagnostics(rows, 24, c.env.floor.y) };
  }
  async function evaluate(c) {
    captureEnvironment(c);
    c.deadline = now() + (ports.verificationMs ?? 60000);
    if (!c.cache) c.cache = await samples(c, copyLayer());
    const before = c.cache, after = await samples(c, c.layer), m = after.metrics;
    const continuityRegressed = m.kneeStep > Math.max(before.metrics.kneeStep + 2, 12)
      || m.kneeAcceleration > Math.max(1e-6, before.metrics.kneeAcceleration * 1.1)
      || m.rootAcceleration > Math.max(1e-6, before.metrics.rootAcceleration * 1.1);
    let protectedPoseError = 0;
    for (const f of c.protectedFrames) for (let b = 0; b < before.poses[f].length; b++) for (let i = 0; i < before.poses[f][b].length; i++) protectedPoseError = Math.max(protectedPoseError, Math.abs(before.poses[f][b][i] - after.poses[f][b][i]));
    const supportedCollisionFrames = after.collisions.filter(p => p.length).length;
    const elevatedFrames = after.rows.flatMap((row, frame) => Object.values(row.ground).some(y => y !== c.env.floor.y) ? [frame] : []);
    const unsupportedObjects = c.env.objects.filter(o => o.attach || o.rotX || o.rotZ);
    const missingCast = c.cast.filter(m => !m.evaluator || ((m.character.layer?.waypoints?.length ?? 0) > 0 && !ports.poseCast));
    const measuredSupportFrames = after.support.frames.filter(f => f.measured).length;
    const flat = c.env.floor.model === 'flat' && elevatedFrames.length === 0 && Math.abs(c.character.y ?? 0) < 1e-8;
    const contactDefects = m.penetration > PHYSICS_LIMITS.floor || m.slide > PHYSICS_LIMITS.slide || m.float > PHYSICS_LIMITS.float || after.support.unsupportedFrames > 0;
    const coverageComplete = m.surfaceMeasured && measuredSupportFrames === c.motion.frames && after.contacts.spans.length > 0 && !missingCast.length && !unsupportedObjects.length;
    const verified = coverageComplete && flat && !contactDefects && !after.support.unresolved.length && !supportedCollisionFrames && !continuityRegressed && protectedPoseError <= 1e-8;
    const limitations = [...BASE_LIMITATIONS];
    if (!m.surfaceMeasured || measuredSupportFrames !== c.motion.frames) limitations.push('skin-or-dynamics-coverage-unavailable');
    if (!after.contacts.spans.length) limitations.push('no-reliable-inferred-contact-spans');
    if (!flat) limitations.push('elevated-moving-or-nonflat-support-unsupported');
    if (missingCast.length) limitations.push('other-cast-evaluation-incomplete');
    if (unsupportedObjects.length) limitations.push('attached-or-tilted-object-proxies-unsupported');
    const repairable = !c.sealed && !c.revalidatedEnvironment && flat && m.surfaceMeasured && !missingCast.length && !unsupportedObjects.length
      && ((!c.autoAttempted && contactDefects) || (!c.collisionAttempted && supportedCollisionFrames > 0));
    const result = { ...summary(c), verificationId: newId(), profile: PROFILE, status: verified ? 'verified' : 'unverified', repairable,
      range: { startFrame: 0, endFrameExclusive: c.motion.frames }, evaluatedFrames: after.rows.length,
      coverage: { sourceFrames: before.rows.length, candidateFrames: after.rows.length, measuredSupportFrames, contactSpans: after.contacts.spans.length,
        collisionFrames: after.collisions.length, otherCastIds: c.cast.map(m => m.character.id), pathObjectIds: c.env.objects.filter(o => o.path).map(o => o.id), elevatedFrames },
      metrics: { surfaceMeasured: m.surfaceMeasured, maxFloorPenetrationM: m.penetration, maxContactSlipM: m.slide, maxContactFloatM: m.float,
        unsupportedFrames: after.support.unsupportedFrames, supportedCollisionFrames, continuityRegressed, protectedPoseError,
        kneeAcceleration: m.kneeAcceleration, rootAcceleration: m.rootAcceleration, supportForceResidual: after.support.forceResidual, supportMomentResidual: after.support.momentResidual },
      limitations, visualRefs: [], semanticStatus: 'unavailable', repairs: repairCounts(c) };
    if (verified || !repairable || c.collisionAttempted) c.sealed = true;
    c.evidence = { before, after }; c.verification = freezeStudioData(result); c.verifiedStamp = physicsKeyStamp(c.layer.keys);
    checkpoint(c);
    return c.verification;
  }
  const repairCounts = c => ({ autoPhysicsInvocations: c.autoInvocations, fixCollisionsInvocations: c.collisionInvocations, remaining: c.sealed ? 0 : Number(!c.autoAttempted) + Number(!c.collisionAttempted) });
  function receiptVerification(c) {
    const v = c.verification, m = v.metrics;
    return { id: v.verificationId, status: v.status, profile: PROFILE, range: v.range, evaluatedFrames: v.evaluatedFrames, physicsRevision: v.physicsRevision,
      limitations: v.limitations, surfaceMeasured: m.surfaceMeasured, maxFloorPenetrationM: m.maxFloorPenetrationM, maxContactSlipM: m.maxContactSlipM, maxContactFloatM: m.maxContactFloatM,
      unsupportedFrames: m.unsupportedFrames, supportedCollisionFrames: m.supportedCollisionFrames, continuityRegressed: m.continuityRegressed, semanticStatus: 'unavailable' };
  }
  const api = {
    prepare_motion_install(request) {
      // Identical preparation replay shares one promise and one private rig.
      checkBinding(request);
      const signature = JSON.stringify(request);
      const existing = admissions.get(request.commandId);
      if (existing) { if (existing.signature !== signature) fail('INVALID_ARGUMENT', 'Motion command identity cannot change.'); return existing.promise; }
      ports.journal.begin(request.commandId, signature);
      const promise = operation(request, 'prepare', async () => {
        if (disposed) fail('CANCELLED', 'Candidate owner disposed.');
        const target = checkBinding(request), schedule = scheduleOf(request.schedule);
        if (target.preserveAuthoredMotion) fail('CAPABILITY_MISSING', 'Unconstrained generation cannot preserve authored motion constraints.');
        if (request.stagingPolicy !== 'preserve-target-anchor' || request.artifactId !== request.artifact?.artifactId) fail('INVALID_ARGUMENT', 'Unsupported staging policy or artifact identity.');
        id(request.artifactId); id(request.jobId);
        const c = { request: structuredClone(request), candidateId: newId(), revision: 1, createdAt: now(), controller: new AbortController(), cast: [], autoCache: { value: null },
          character: structuredClone(target.character), schedule, protectedFrames: [...new Set(target.protectedFrames ?? [])], autoAttempted: false, collisionAttempted: false, autoInvocations: 0, collisionInvocations: 0, sealed: false, busy: true };
        candidates.set(c.candidateId, c);
        for (const frame of c.protectedFrames) if (!Number.isSafeInteger(frame) || frame < 0 || frame >= schedule.frameCount) fail('INVALID_RANGE', 'Protected frame lies outside the candidate.');
        c.evaluator = isolatedRig(target.rig);
        captureEnvironment(c);
        const deadline = now() + (ports.preparationMs ?? 30000);
        const signal = AbortSignal.any([c.controller.signal, AbortSignal.timeout(ports.preparationMs ?? 30000)]);
        const decoded = structuredClone(await (ports.loadArtifact ?? ((artifact, options) => loadMotionFromUrl(artifact.url, options)))(request.artifact, { signal }));
        fence(c); signal.throwIfAborted();
        if (now() > deadline) fail('VERIFICATION_FAILED', 'Private preparation budget exceeded.');
        const calibration = normalizeMotionCalibration(target.calibration);
        // A captured take needs the same explicit calibration/stature policy.
        // Canonical generated takes preserve the bound character's stature.
        if ((decoded.boneScale || decoded.personScale !== 1) && (!target.calibration || Math.abs(characterScaleFor(decoded) - c.character.scale) > 1e-8)) fail('CAPABILITY_MISSING', 'Captured motion requires matching target calibration and stature.');
        c.calibration = calibration;
        let motion = applyMotionCalibration(retimeMotion(decoded, 24), { ...calibration, yawDeg: 0, offsetX: 0, offsetZ: 0 }).motion;
        validateClip(motion, schedule.frameCount);
        const supports = c.env.objects.filter(o => !o.path && !o.attach && !o.rotX && !o.rotZ).map(o => ({ x: o.x, z: o.z, rotDeg: o.rot ?? 0,
          supportY: (o.y ?? 0) + supportHeightForObject(o) * (o.scaleY ?? 1), topY: (o.y ?? 0) + supportHeightForObject(o) * (o.scaleY ?? 1), width: o.footprint.width * o.scaleX, depth: o.footprint.depth * o.scaleZ }));
        const anchor = { x: c.character.x, y: c.character.y ?? 0, z: c.character.z, rotationDeg: c.character.rot };
        motion = applySupportRise(motion, supports, { subjectX: anchor.x, subjectY: anchor.y, subjectZ: anchor.z, rotationDeg: anchor.rotationDeg, worldScale: c.character.scale });
        const fall = autoRoofDrop(motion, anchor, supports, { worldScale: c.character.scale });
        // AutoFall's default shortens clips; preserve the admitted schedule by
        // retaining the full landing hold instead of silently dropping beats.
        motion = applyAutoFall(motion, fall, { worldScale: c.character.scale, landHoldS: schedule.durationSeconds });
        validateClip(motion, schedule.frameCount);
        c.motion = { ...motion, personScale: c.character.scale, anchorX: anchor.x, anchorZ: anchor.z, anchorFrame: 0, rotationDeg: anchor.rotationDeg, sceneCalibration: calibration, editSegments: createMotionEdit(motion.frames) };
        c.layer = copyLayer(); c.busy = false;
        fence(c);
        return { ...summary(c), plannedDelta: { characterId: c.character.id, frameCount: motion.frames, fps: 24, scale: c.character.scale, anchor: { x: anchor.x, y: anchor.y, z: anchor.z }, yawDeg: anchor.rotationDeg, clearedIkKeyCount: target.ikState?.keys.size ?? 0 } };
      });
      admissions.set(request.commandId, { signature, promise });
      return promise;
    },
    verify_motion_candidate(request) {
      return operation(request, 'verify', async c => {
        if (request.profile !== PROFILE) fail('INVALID_ARGUMENT', 'Unsupported verification profile.');
        return evaluate(c);
      });
    },
    repair_motion_candidate(request) {
      return operation(request, 'repair', async c => {
        if (!c.verification || c.sealed || c.revalidatedEnvironment || !c.verification.repairable) fail('VERIFICATION_FAILED', 'Candidate has no remaining repair permission.');
        if (environmentKey(ports.readEnvironment()) !== c.envKey) fail('STALE_ENVIRONMENT', 'Repair cannot restage a changed environment.');
        if (!['auto_physics', 'fix_collisions'].includes(request.method)) fail('INVALID_ARGUMENT', 'Unsupported bounded repair method.');
        if ((request.protectedFrames ?? []).some(f => !c.protectedFrames.includes(f))) fail('INVALID_ARGUMENT', 'Protection must be admitted during preparation.');
        if (request.method === 'auto_physics' ? c.autoAttempted || c.collisionAttempted : c.collisionAttempted || !c.autoAttempted) fail('VERIFICATION_FAILED', 'Repair invocation budget or order exceeded.');
        const before = c.verification, draft = copyLayer(c.layer);
        c.deadline = now() + (ports.verificationMs ?? 60000);
        if (request.method === 'auto_physics') {
          c.autoAttempted = true;
          if (before.metrics.maxFloorPenetrationM > PHYSICS_LIMITS.floor || before.metrics.maxContactSlipM > PHYSICS_LIMITS.slide || before.metrics.maxContactFloatM > PHYSICS_LIMITS.float || before.metrics.unsupportedFrames > 0) {
            c.autoInvocations++;
            const result = await (ports.reviewAutoPhysics ?? reviewAutoPhysics)({ rig: c.evaluator.rig, motion: c.motion, chains: c.evaluator.chains, fkJoints: c.evaluator.fkJoints, sourceKeys: draft.keys,
              applyRaw: f => poseFrame(c.evaluator, c.motion, null, f), sceneObjects: c.env.objects, floorY: c.env.floor.y, protectedFrames: c.protectedFrames, cache: c.autoCache,
              yieldFrame: async () => { checkpoint(c); await yieldTask(); checkpoint(c); } });
            draft.keys = copyPhysicsKeys(result.candidate.keys); draft.tracked = new Set(result.candidate.tracked);
          }
        } else {
          c.collisionAttempted = true;
          if (before.metrics.supportedCollisionFrames) {
            c.collisionInvocations++;
            (ports.fixCollisionsRange ?? fixCollisionsRange)({ rig: c.evaluator.rig, chains: c.evaluator.chains, fkJoints: c.evaluator.fkJoints, ikState: draft, startFrame: 0, endFrame: c.motion.frames - 1, floorY: c.env.floor.y,
              applyFrame: f => { checkpoint(c); poseFrame(c.evaluator, c.motion, draft, f); }, blockersAt: f => blockersAt(c, f), blendWindow: BLEND });
          }
        }
        checkpoint(c); c.layer = draft; c.revision++;
        // All solver writes and their blend ramps finish BEFORE this read-only
        // full pass. A regression is a rejected private candidate, never a
        // partial change to the visible take or its authored preimage.
        const after = await evaluate(c), a = after.metrics, b = before.metrics;
        if (a.continuityRegressed || a.protectedPoseError > 1e-8 || a.maxFloorPenetrationM > Math.max(PHYSICS_LIMITS.floor, b.maxFloorPenetrationM) + 1e-8 || a.maxContactSlipM > Math.max(PHYSICS_LIMITS.slide, b.maxContactSlipM) + 1e-8 || a.maxContactFloatM > Math.max(PHYSICS_LIMITS.float, b.maxContactFloatM) + 1e-8 || a.unsupportedFrames > b.unsupportedFrames || a.supportedCollisionFrames > b.supportedCollisionFrames) fail('REPAIR_REGRESSED', 'Final evaluated repair regressed contact, protection, continuity or collisions.');
        return { ...summary(c), before, after };
      });
    },
    // Synchronous: no await between the last identity/cancel/physics/gesture
    // checks and task 5's publication. No private rig is ever installed.
    commit_motion_candidate(request) {
      const known = ports.journal.reconcile({ commandId: request.commandId, host: request.binding.host });
      if (known.status === 'applied') return known.receipt;
      if (known.status === 'not_applied') return { status: 'not_applied', evidence: known.receipt };
      const c = candidates.get(request.candidateId);
      let committing = false;
      try {
        if (!c || c.request.commandId !== request.commandId || !equal(c.request.binding, request.binding)) fail('STALE_TARGET', 'Candidate owner changed.');
        fence(c);
        if (c.busy) fail('TARGET_BUSY', 'Candidate evaluation is still running.');
        if (!c.verification || request.candidateRevision !== c.revision || request.verificationId !== c.verification.verificationId || request.expectedTargetToken !== c.request.binding.targetToken || request.jobId !== c.request.jobId || request.artifactId !== c.request.artifactId) fail('STALE_TARGET', 'Commit and verification identities disagree.');
        if (environmentKey(ports.readEnvironment()) !== c.envKey || request.expectedPhysicsRevision !== c.verification.physicsRevision) fail('STALE_ENVIRONMENT', 'Commit physics evidence is stale.');
        if (ports.readTarget(c.request.binding).busy) fail('TARGET_BUSY', 'A target gesture is in progress.');
        if (physicsKeyStamp(c.layer.keys) !== c.verifiedStamp) fail('VERIFICATION_FAILED', 'Keys changed after verification.');
        if (c.verification.status !== 'verified' && request.explicitUnverifiedAcceptance !== true) fail('VERIFICATION_FAILED', 'Unverified installation requires explicit acceptance.');
        c.sealed = true;
        if (!ports.commit) fail('CAPABILITY_MISSING', 'The editor atomic motion owner is not bound.');
        const payload = { ...request, motion: c.motion, sourceMotion: c.motion, schedule: c.schedule, ikState: c.layer, scale: c.character.scale, calibration: c.calibration,
          verification: receiptVerification(c), repairs: repairCounts(c) };
        committing = true;
        const receipt = ports.commit(payload);
        if (receipt?.then) fail('UNCERTAIN_APPLY', 'Motion publication must be synchronous.');
        const validated = validateReceipt(receipt);
        if (!validated.ok || validated.status !== 'installed' || validated.commandId !== request.commandId || validated.jobId !== request.jobId || validated.artifactId !== request.artifactId || validated.installed.characterId !== c.character.id || !equal(validated.host, request.binding.host) || !equal(validated.verification, payload.verification)) fail('UNCERTAIN_APPLY', 'Editor returned an uncorrelated installation receipt.');
        // The editor owner normally records before acknowledging. Preserve that
        // receipt if it did; otherwise record this validated synchronous result.
        if (ports.journal.reconcile({ commandId: request.commandId, host: request.binding.host }).status !== 'applied') ports.journal.record(validated);
        release(c); return validated;
      } catch (error) {
        const reconciled = ports.journal.reconcile({ commandId: request.commandId, host: request.binding.host });
        if (reconciled.status === 'applied') { if (c) release(c); return reconciled.receipt; }
        if (committing) {
          // Missing acknowledgement is not non-application proof. Keep ownership
          // until the App journals/reconciles, or explicitly disposes this owner.
          return { ...rejection(request, error, 'commit'), code: 'UNCERTAIN_APPLY', mutated: 'unknown', preserved: { authoredState: 'unknown' }, recovery: { action: 'reconcile', retryAllowed: false } };
        }
        if (c && c.request.commandId === request.commandId && equal(c.request.binding, request.binding) && error.code !== 'TARGET_BUSY') release(c);
        const receipt = rejection(request, error, 'commit'); ports.journal.record(receipt); return receipt;
      }
    },
    discard_motion_candidate(request) {
      const c = candidates.get(request.candidateId);
      if (c && (c.request.commandId !== request.commandId || !equal(c.request.binding, request.binding))) return rejection(request, new StudioProtocolError('STALE_TARGET', 'Candidate owner changed.'), 'prepare');
      if (c) { c.cancelled = true; if (!c.busy) release(c); else c.controller.abort(); }
      return { candidateId: request.candidateId, discarded: true };
    },
    cancel_motion_install(request) {
      const outcome = ports.journal.reconcile({ commandId: request.commandId, host: request.binding.host });
      if (outcome.status === 'applied') return { status: 'already_applied', receipt: outcome.receipt };
      for (const c of candidates.values()) if (c.request.commandId === request.commandId && equal(c.request.binding, request.binding)) { c.cancelled = true; c.controller.abort(); if (!c.busy) release(c); }
      const receipt = rejection(request, new StudioProtocolError('CANCELLED', 'Installation permission revoked.'), 'commit');
      ports.journal.record(receipt); return { status: 'not_applied', evidence: receipt };
    },
    reconcile_studio_command(request) {
      const value = ports.journal.reconcile({ commandId: request.commandId, host: request.binding.host });
      // Task 2 returns {status,receipt}; task 3 requires positive `evidence`
      // for not_applied. Only its recorded rejection supplies that evidence.
      return value.status === 'not_applied' ? { ...value, evidence: value.receipt } : value;
    },
    readEvidence(candidateId) { const c = candidates.get(candidateId); return c?.evidence ? structuredClone({ ...c.evidence, verification: c.verification }) : null; },
    cleanup() {
      for (const c of candidates.values()) {
        try { fence(c); } catch (error) { c.cancelled = true; c.controller.abort(); if (!c.busy) release(c); if (!ports.journal.get(c.request.commandId)) ports.journal.record(rejection(c.request, error, 'prepare')); }
      }
      for (const [commandId] of admissions) if (![...candidates.values()].some(c => c.request.commandId === commandId)) admissions.delete(commandId);
    },
    dispose() { disposed = true; for (const c of candidates.values()) { c.cancelled = true; c.controller.abort(); if (!c.busy) release(c); } admissions.clear(); },
    get size() { return candidates.size; },
  };
  return api;
}
