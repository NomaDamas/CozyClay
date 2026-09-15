// Studio composites prepare private domain drafts; the App owns publication,
// history, gesture fences and semantic revision/telemetry. No UI callbacks here.
import { Euler, Vector3, PerspectiveCamera } from 'three';
import { createSceneObject, updateSceneObject, removeSceneObject, setSceneObjectParent, descendantsOf, supportHeightForObject, OBJECT_LIBRARY } from './scene-objects.js';
import { createCharacterEntry } from './scenes.js';
import { createShot, shotAtFrame } from './cuts.js';
import { captureFraming } from './camera-move.js';
import { createStableItemId } from './stable-items.js';
import { focalMmToFov, SENSOR_FORMATS } from './shot.js';
import { StudioProtocolError, StudioSchemas, validateStudioSchema, validateStudioCommand, validateStudioIdentity, validateTargetGuard, validateReceipt, freezeStudioData, utf8ByteLength } from './studio-agent-protocol.js';

const DEG = Math.PI / 180, EPS = 1e-8;
const fail = (code, message) => { throw new StudioProtocolError(code, message); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pos = e => ({ x: e.x, y: e.y ?? 0, z: e.z });
const vector = p => new Vector3(p.x, p.y, p.z);
const normalizedName = name => name.normalize('NFC').trim();
const entityById = (state, id) => {
  const entity = [...state.objects, ...state.characters].find(e => e.id === id);
  if (!entity) fail('AMBIGUOUS_TARGET', 'Target ID is not present in the admitted scene.');
  return entity;
};
function boxPoints(bounds) {
  if (!bounds || ['x', 'y', 'z'].some(a => !Number.isFinite(bounds.min?.[a]) || !Number.isFinite(bounds.max?.[a]) || bounds.min[a] > bounds.max[a])) fail('TARGET_NOT_READY', 'Evaluated bounds are unavailable.');
  return [bounds.min.x, bounds.max.x].flatMap(x => [bounds.min.y, bounds.max.y].flatMap(y => [bounds.min.z, bounds.max.z].map(z => new Vector3(x, y, z))));
}
function geometry(entity, state, ports) {
  // Attached/path objects need evaluated world geometry, never local channels.
  if (!entity.renderer || entity.attach || entity.path) return boxPoints(ports.bounds({ entity, frame: state.frame, state }));
  const rotation = new Euler(entity.rotX * DEG, entity.rot * DEG, entity.rotZ * DEG, 'XYZ');
  const w = entity.footprint.width * entity.scaleX / 2, d = entity.footprint.depth * entity.scaleZ / 2;
  return [-w, w].flatMap(x => [0, entity.height * entity.scaleY].flatMap(y => [-d, d].map(z => new Vector3(x, y, z).applyEuler(rotation).add(vector(pos(entity))))));
}
const interval = (points, axis) => { const values = points.map(p => p.dot(axis)); return { min: Math.min(...values), max: Math.max(...values) }; };
const aabb = points => Object.fromEntries(['x', 'y', 'z'].map(a => [a, { min: Math.min(...points.map(p => p[a])), max: Math.max(...points.map(p => p[a])) }]));
function overlap(a, b) {
  const depth = ['x', 'y', 'z'].map(axis => Math.min(a[axis].max, b[axis].max) - Math.max(a[axis].min, b[axis].min));
  return depth.every(d => d > EPS) ? Math.min(depth[0], depth[2]) : 0;
}
function basisAxis(spec, reference, state) {
  let forward, right;
  if (spec.basis === 'world') { forward = new Vector3(0, 0, 1); right = new Vector3(1, 0, 0); }
  else if (spec.basis === 'subject') {
    forward = new Vector3(Math.sin(reference.rot * DEG), 0, Math.cos(reference.rot * DEG));
    right = forward.clone().cross(new Vector3(0, 1, 0));
  } else {
    if (!state.camera) fail('TARGET_NOT_READY', 'Shot camera is unavailable.');
    forward = vector(state.camera.lookAt).sub(vector(state.camera.position)); forward.y = 0;
    if (forward.length() < EPS) fail('AMBIGUOUS_BASIS', 'Shot camera has no horizontal forward direction.');
    forward.normalize(); right = forward.clone().cross(new Vector3(0, 1, 0));
  }
  return (['left', 'right'].includes(spec.side) ? right : forward).multiplyScalar(['left', 'behind'].includes(spec.side) ? -1 : 1);
}
function support(spec, state) {
  const id = spec.onObject ?? (typeof spec.support === 'object' ? spec.support.objectId : null);
  if (!id) return { y: state.floorY, label: 'floor' };
  const object = entityById(state, id);
  if (!object.renderer || object.renderer === 'cutout' || ['sphere', 'capsule', 'cone', 'car', 'small-plane'].includes(object.renderer) || object.path || object.attach || Math.abs(object.rotX) > EPS || Math.abs(object.rotZ) > EPS) fail('TARGET_NOT_READY', 'Support must be a stationary solid upright surface.');
  return { y: object.y + supportHeightForObject(object) * object.scaleY, label: `object:${id}`, object };
}
function facingYaw(spec, entity, state) {
  if (!spec) return entity.rot;
  if ('yawDeg' in spec) return spec.yawDeg;
  const target = entityById(state, spec.towardId ?? spec.awayFromId ?? spec.sameAsId);
  if (spec.sameAsId) return target.rot;
  const dx = target.x - entity.x, dz = target.z - entity.z;
  if (Math.hypot(dx, dz) < EPS) fail('AMBIGUOUS_BASIS', 'Coincident targets have no facing direction.');
  return Math.atan2(dx, dz) / DEG + (spec.awayFromId ? 180 : 0);
}
function patchEntity(entity, patch) {
  if (entity.renderer) return updateSceneObject([entity], entity.id, patch)[0];
  // Reuse the domain normalizer for clamps, preserving runtime/layer ownership.
  const normalized = createCharacterEntry({ ...entity, ...patch });
  return { ...entity, ...patch, y: normalized.y, scale: normalized.scale };
}
function place(entity, op, state, ports) {
  let result = entity;
  const spec = op.position;
  if (!spec) return { entity: patchEntity(result, { rot: facingYaw(op.facing, result, state) }), relation: null };
  if (spec.world) {
    result = patchEntity(result, spec.world);
    return { entity: patchEntity(result, { rot: facingYaw(op.facing, result, state) }), relation: null };
  }
  const surface = support(spec, state);
  let axis, reference;
  if (spec.relativeTo) { reference = entityById(state, spec.relativeTo); axis = basisAxis(spec, reference, state); }
  let location;
  if (spec.between) {
    const a = entityById(state, spec.between[0]), b = entityById(state, spec.between[1]);
    location = { x: a.x + (b.x - a.x) * spec.fraction, y: surface.y, z: a.z + (b.z - a.z) * spec.fraction };
  } else if (spec.onObject) location = { x: surface.object.x + (spec.offsetXZ?.x ?? 0), y: surface.y, z: surface.object.z + (spec.offsetXZ?.z ?? 0) };
  else location = { x: reference.x + axis.x, y: surface.y, z: reference.z + axis.z };
  result = patchEntity(result, location);
  // Facing and anisotropic extents are coupled. Iterate on the private draft,
  // refusing a nonconvergent relation instead of publishing guessed geometry.
  let converged = false;
  for (let i = 0; i < 32; i++) {
    const previous = result;
    result = patchEntity(result, { rot: facingYaw(op.facing, result, state) });
    if (axis) {
      const refInterval = interval(geometry(reference, state, ports), axis);
      const own = interval(geometry(result, state, ports), axis);
      const shift = refInterval.max + spec.gapM - own.min;
      result = patchEntity(result, { x: result.x + axis.x * shift, z: result.z + axis.z * shift });
    }
    if (Math.hypot(result.x - previous.x, result.z - previous.z, result.rot - previous.rot) < EPS) { converged = true; break; }
  }
  if (!converged) fail('AMBIGUOUS_BASIS', 'Facing and placement cannot satisfy the requested relation.');
  const points = geometry(result, state, ports);
  if (Math.abs(Math.min(...points.map(p => p.y)) - surface.y) > EPS) fail('TARGET_NOT_READY', 'Tilted or offset bounds cannot rest on the requested support.');
  let actualGapM;
  if (axis) {
    actualGapM = interval(points, axis).min - interval(geometry(reference, state, ports), axis).max;
    if (Math.abs(actualGapM - spec.gapM) > EPS) fail('INVALID_ARGUMENT', 'Domain limits prevent the requested clearance.');
  }
  return { entity: result, relation: { id: result.id, spec, axis, support: surface.label, baseY: surface.y, ...(axis ? { actualGapM, requestedGapM: spec.gapM, basis: spec.basis } : {}) } };
}
function overlapsFor(entity, state, ports) {
  const own = aabb(geometry(entity, state, ports));
  return [...state.objects, ...state.characters].filter(e => e.id !== entity.id && !e.hidden).map(other => ({ id: other.id, bounds: aabb(geometry(other, state, ports)) })).map(other => ({ ...other, depth: overlap(own, other.bounds) })).filter(o => o.depth > EPS);
}
function avoid(entity, relation, state, ports) {
  const blocked = overlapsFor(entity, state, ports);
  if (!blocked.length) return entity;
  const own = aabb(geometry(entity, state, ports));
  const distance = Math.max(...blocked.map(other => Math.min(...['x', 'z'].filter(a => Math.abs(relation.axis[a]) > EPS).map(a => relation.axis[a] > 0 ? (other.bounds[a].max - own[a].min) / relation.axis[a] : (other.bounds[a].min - own[a].max) / relation.axis[a]))));
  if (distance > 0.3 + EPS) fail('VERIFICATION_FAILED', 'Avoidance needs more than the authorized 0.3 m adjustment.');
  const adjusted = patchEntity(entity, { x: entity.x + relation.axis.x * distance, z: entity.z + relation.axis.z * distance });
  if (overlapsFor(adjusted, state, ports).length) fail('VERIFICATION_FAILED', 'The single outward avoidance adjustment is still blocked.');
  relation.actualGapM += distance;
  relation.adjustmentM = distance;
  return adjusted;
}
function transformPatch(op, isObject) {
  const patch = {};
  if (op.name !== undefined) patch[isObject ? 'name' : 'subject'] = normalizedName(op.name);
  if (op.color !== undefined) patch.color = op.color;
  if (op.hidden !== undefined) patch.hidden = op.hidden;
  if (op.scale !== undefined) Object.assign(patch, isObject ? { scaleX: op.scale.x, scaleY: op.scale.y, scaleZ: op.scale.z } : { scale: op.scale });
  if (op.rotationDeg) Object.assign(patch, { rotX: op.rotationDeg.x, rot: op.rotationDeg.y, rotZ: op.rotationDeg.z });
  return patch;
}
function arrangement(command, before, ports) {
  const isObject = command.name === 'arrange_objects', key = isObject ? 'objects' : 'characters';
  let rows = before[key];
  const relations = [], warnings = [];
  for (const op of command.args.ops) {
    const id = op.id ?? op.characterId;
    let entity = id ? rows.find(e => e.id === id) : null;
    if (id && !entity) fail('AMBIGUOUS_TARGET', 'Edited target is not present in the draft.');
    if (op.op === 'create') {
      if (op.name && rows.some(e => normalizedName(e.name ?? e.subject) === normalizedName(op.name))) fail('DUPLICATE_NAME', 'Create name already exists in the domain.');
      entity = isObject ? createSceneObject(op.source.kind, rows) : createCharacterEntry({ id: createStableItemId('character'), subject: normalizedName(op.name) });
      if (!entity) fail('INVALID_ARGUMENT', 'Unsupported object library kind.');
      rows = [...rows, entity];
    }
    if (['create', 'update'].includes(op.op)) {
      if (entity.attach) fail('CAPABILITY_MISSING', 'Attached transforms require a world-preserving attachment adapter.');
      entity = patchEntity(entity, transformPatch(op, isObject));
      const placed = place(entity, op, before, ports);
      entity = placed.entity;
      if (command.args.collisionPolicy === 'avoid') {
        entity = avoid(entity, placed.relation, { ...before, [key]: rows }, ports);
        entity = patchEntity(entity, { rot: facingYaw(op.facing, entity, before) });
        const reference = entityById(before, op.position.relativeTo);
        placed.relation.actualGapM = interval(geometry(entity, before, ports), placed.relation.axis).min - interval(geometry(reference, before, ports), placed.relation.axis).max;
        if (placed.relation.actualGapM < op.position.gapM - EPS) fail('VERIFICATION_FAILED', 'Avoidance cannot preserve the requested facing and minimum clearance.');
      }
      const patch = Object.fromEntries(Object.entries(entity).filter(([k, v]) => !equal(v, rows.find(e => e.id === entity.id)[k])));
      rows = isObject ? updateSceneObject(rows, entity.id, patch) : rows.map(e => e.id === entity.id ? entity : e);
      if (placed.relation) relations.push(placed.relation);
    } else if (op.op === 'remove') {
      if (!isObject && (rows.length <= 1 || entity.id === before.activeCharacterId)) fail('INVALID_ARGUMENT', 'Cannot remove the final or active character without a separate selection operation.');
      rows = isObject ? removeSceneObject(rows, id) : rows.filter(e => e.id !== id);
    } else {
      if (op.op === 'group' && !rows.some(e => e.id === op.parentId)) fail('AMBIGUOUS_TARGET', 'Group parent is unavailable.');
      for (const child of op.childIds) {
        const target = rows.find(e => e.id === child);
        if (!target) fail('AMBIGUOUS_TARGET', 'Group child is unavailable.');
        if (target.attach) fail('CAPABILITY_MISSING', 'Attached grouping requires world transform conversion.');
        if (op.op === 'group' && descendantsOf(rows, child).some(e => e.id === op.parentId)) fail('INVALID_ARGUMENT', 'Grouping would create a cycle.');
        rows = setSceneObjectParent(rows, child, op.op === 'group' ? op.parentId : null);
      }
    }
  }
  const after = { ...before, [key]: rows };
  const affectedIds = [...new Set([...before[key], ...rows].map(e => e.id))].filter(id => !equal(before[key].find(e => e.id === id), rows.find(e => e.id === id)));
  const overlaps = affectedIds.flatMap(id => { const e = rows.find(e => e.id === id); return e ? overlapsFor(e, after, ports) : []; });
  for (const relation of relations) {
    if (!relation.spec.relativeTo) continue;
    const subject = rows.find(e => e.id === relation.id), reference = entityById(after, relation.spec.relativeTo);
    const finalAxis = basisAxis(relation.spec, reference, after);
    const actualGapM = interval(geometry(subject, after, ports), finalAxis).min - interval(geometry(reference, after, ports), finalAxis).max;
    if (relation.adjustmentM === undefined && Math.abs(actualGapM - relation.spec.gapM) > EPS) fail('STALE_SCENE', 'A relative reference changed during the atomic batch.');
    if (actualGapM < relation.spec.gapM - EPS) fail('VERIFICATION_FAILED', 'The final batch no longer satisfies its minimum clearance.');
    relation.actualGapM = actualGapM;
  }
  if (command.args.collisionPolicy === 'avoid' && overlaps.length) fail('VERIFICATION_FAILED', 'The final batch is still blocked after its outward adjustments.');
  for (const item of overlaps.slice(0, 10)) warnings.push({ code: 'FOOTPRINT_OVERLAP', id: item.id });
  if (relations.some(r => r.adjustmentM)) warnings.push({ code: 'OUTWARD_ADJUSTMENT', count: relations.filter(r => r.adjustmentM).length });
  const relation = relations.length === 1 ? relations[0] : null;
  return { domain: isObject ? 'objects' : 'cast', draft: equal(rows, before[key]) ? before[key] : rows, affectedIds,
    checks: { coverage: 'same-frame-world-AABB-proxies', overlapIds: [...new Set(overlaps.map(o => o.id))].slice(0, 100), maximumFootprintOverlapM: Math.max(0, ...overlaps.map(o => o.depth)),
      ...(relation ? { support: relation.support, baseY: relation.baseY, relationSatisfied: true, ...(relation.axis ? { basis: relation.basis, requestedGapM: relation.requestedGapM, actualGapM: relation.actualGapM } : {}) } : {}) },
    warnings, details: relations.map(({ axis, ...rest }) => rest) };
}

const FRACTIONS = { 'extreme close-up': 3.4, 'close-up': 2.2, 'medium close-up': 1.375, 'medium shot': 0.975, 'medium-wide shot': 0.66, 'wide shot': 0.41, 'extreme wide shot': 0.2 };
const LEVELS = { ground: 0.3 / 1.8, low: 0.7 / 1.8, hip: 1.1 / 1.8, eye: 1.65 / 1.8, high: 2.1 / 1.8, overhead: 2.8 / 1.8 };
const ANGLES = { front: 0, 'front three-quarter': 40, profile: 90, 'rear three-quarter': 140, back: 180 };
function frameDraft(command, state, ports) {
  if (state.frameCount <= 0) fail('TARGET_NOT_READY', 'A nonempty timeline is required.');
  const subject = state.characters.find(e => e.id === command.args.subjectIds[0]);
  if (!subject || subject.hidden) fail('TARGET_NOT_READY', 'Framing requires one visible character.');
  const points = geometry(subject, state, ports), bounds = aabb(points), height = bounds.y.max - bounds.y.min;
  if (height <= EPS || !state.camera || !SENSOR_FORMATS[state.filmback?.sensorId] || !(state.filmback.aspectRatio > 0)) fail('TARGET_NOT_READY', 'Subject stature and camera filmback must be available.');
  let shot = command.args.shotId ? state.shotDocument.shots.find(s => s.id === command.args.shotId) : shotAtFrame(state.shotDocument.shots, state.frame) ?? state.shotDocument.shots.find(s => s.id === state.selectedShotId);
  const created = !shot && !state.shotDocument.shots.length && !command.args.shotId;
  if (created) shot = createShot('Shot 1', 0, state.frameCount - 1);
  if (!shot) fail('AMBIGUOUS_TARGET', 'No shot owns this frame; select an existing shot explicitly.');
  const frame = command.args.keyAtFrame ?? state.frame;
  if (frame < shot.startFrame || frame > shot.endFrame || shot.endFrame >= state.frameCount) fail('INVALID_RANGE', 'Framing/key frame must be inside the shot range.');
  const intent = command.args.framing.intent;
  let camera = command.args.framing.exact;
  const focalMm = camera?.focalMm ?? intent.focalMm ?? state.camera.focalMm;
  const fov = focalMmToFov(focalMm, state.filmback.sensorId, state.filmback.aspectRatio);
  if (fov / DEG < 14 || fov / DEG > 90) fail('INVALID_ARGUMENT', 'Requested lens is outside the editor FOV range.');
  if (intent) {
    const lookAt = { x: (bounds.x.min + bounds.x.max) / 2, y: bounds.y.min + height * (1.3 / 1.8), z: (bounds.z.min + bounds.z.max) / 2 };
    const distance = height / (2 * FRACTIONS[intent.size] * Math.tan(fov / 2));
    const y = bounds.y.min + height * LEVELS[intent.level], dy = y - lookAt.y;
    if (distance * distance <= dy * dy + EPS) fail('INVALID_ARGUMENT', 'The exact lens cannot satisfy both requested size and level.');
    const horizontal = Math.sqrt(distance * distance - dy * dy);
    const angle = (subject.rot + (intent.side === 'right' ? -1 : 1) * ANGLES[intent.view]) * DEG;
    camera = { position: { x: lookAt.x + Math.sin(angle) * horizontal, y, z: lookAt.z + Math.cos(angle) * horizontal }, lookAt, focalMm };
  }
  const direction = vector(camera.lookAt).sub(vector(camera.position));
  if (direction.length() <= EPS) fail('INVALID_ARGUMENT', 'Camera position and aim must differ.');
  const framing = captureFraming({ pos: camera.position, yaw: Math.atan2(-direction.x, -direction.z), pitch: Math.atan2(direction.y, Math.hypot(direction.x, direction.z)), fovDeg: fov / DEG });
  let keyId;
  let keys = shot.cameraKeys;
  if (command.args.keyAtFrame !== undefined) {
    keyId = keys.find(k => k.frame === frame)?.id ?? createStableItemId('camera-key');
    keys = [...keys.filter(k => k.frame !== frame), { id: keyId, frame, framing }].sort((a, b) => a.frame - b.frame);
  }
  const nextShot = { ...shot, cameraKeys: keys, camera: { ...shot.camera, mode: 'keys' } };
  const shots = created ? [nextShot] : state.shotDocument.shots.map(s => s.id === shot.id ? nextShot : s);
  const projection = new PerspectiveCamera(fov / DEG, state.filmback.aspectRatio, 0.01, 10000);
  projection.position.copy(vector(camera.position)); projection.lookAt(vector(camera.lookAt)); projection.updateMatrixWorld(true);
  const screen = points.map(p => p.clone().project(projection));
  const screenBounds = aabb(screen);
  const behindCamera = points.some(p => p.clone().sub(projection.position).dot(direction) <= 0);
  // Measured projection, not distance to an arbitrary aim point. Moving lookAt
  // along the same ray cannot change the subject's observed screen coverage.
  const screenFraction = (screenBounds.y.max - screenBounds.y.min) / 2;
  const derivedSize = [['extreme close-up', 2.8], ['close-up', 1.6], ['medium close-up', 1.15], ['medium shot', 0.8], ['medium-wide shot', 0.52], ['wide shot', 0.3], ['extreme wide shot', 0]].find(([, threshold]) => screenFraction >= threshold)[0];
  const resolvedCamera = { ...camera, sensorId: state.filmback.sensorId, slate: derivedSize };
  const draft = { shotDocument: { ...state.shotDocument, shots }, camera: resolvedCamera, manual: true };
  return { domain: 'shot', draft, affectedIds: [shot.id, ...(keyId ? [keyId] : [])],
    checks: { coverage: 'same-frame-subject-bounds-projection', screenFraction, derivedSize, behindCamera, clipped: behindCamera || screen.some(p => Math.abs(p.x) > 1 || Math.abs(p.y) > 1 || p.z < -1 || p.z > 1) },
    warnings: [{ code: 'OCCLUSION_UNMEASURED' }], details: { created, shotId: shot.id, keyId, frame, framing, screenBounds, subjectIds: [subject.id] } };
}

/** Local journal. Unsettled/protected records are never evicted. Call prune on
 * history/job release; completed unprotected outcomes expire after ten minutes. */
export function createStudioCommandJournal({ host, now = Date.now, isRetained = () => false, maxCompleted = 256, retentionMs = 600000 } = {}) {
  const identity = validateStudioIdentity(host), records = new Map();
  const prune = () => {
    const eligible = [...records].filter(([, r]) => r.outcome && !isRetained(r.receipt));
    let excess = Math.max(0, [...records.values()].filter(r => r.outcome).length - maxCompleted);
    for (const [id, r] of eligible) if (now() - r.finishedAt >= retentionMs || excess > 0) { records.delete(id); excess--; }
  };
  const checkHost = value => equal(validateStudioIdentity(value), identity);
  return {
    host: freezeStudioData(identity), prune,
    begin(commandId, signature = commandId) {
      validateStudioSchema(StudioSchemas.TargetGuard.properties.targetId, commandId);
      prune();
      const existing = records.get(commandId);
      if (existing && existing.signature !== signature) fail('INVALID_ARGUMENT', 'Command ID was reused with different arguments.');
      if (existing) return false;
      records.set(commandId, { signature }); return true;
    },
    record(receipt, details = null) {
      const validated = validateReceipt(receipt);
      if (!checkHost(validated.host)) fail('STALE_SCENE', 'Receipt belongs to a different live document.');
      const record = records.get(validated.commandId);
      if (!record) fail('INVALID_ARGUMENT', 'Journal command must begin before recording.');
      if (record.receipt && record.outcome) { if (!equal(record.receipt, validated)) fail('INVALID_ARGUMENT', 'Journal outcome cannot be overwritten.'); return record.receipt; }
      const outcome = validated.ok ? (validated.authored ? 'applied' : 'not_applied') : validated.mutated === false ? 'not_applied' : null;
      Object.assign(record, { receipt: validated, details: freezeStudioData(structuredClone(details)), outcome, finishedAt: now() });
      return validated;
    },
    reconcile({ commandId, host: submitted = identity }) {
      prune();
      const record = checkHost(submitted) ? records.get(commandId) : null;
      return record?.outcome ? { status: record.outcome, receipt: record.receipt } : { status: 'unknown' };
    },
    get(commandId) { return records.get(commandId)?.receipt ?? null; },
    details(commandId) { return records.get(commandId)?.details ?? null; },
  };
}
function dependencies(command, state) {
  if (command.name === 'frame_shot') {
    const shotId = command.args.shotId ?? shotAtFrame(state.shotDocument.shots, state.frame)?.id ?? state.selectedShotId;
    return [...command.args.subjectIds, ...(shotId ? [shotId] : [])];
  }
  return [...new Set(command.args.ops.flatMap(op => [op.id, op.characterId, op.parentId, ...(op.childIds ?? []), op.position?.relativeTo, ...(op.position?.between ?? []), op.position?.onObject, op.position?.support?.objectId, op.facing?.towardId, op.facing?.awayFromId, op.facing?.sameAsId].filter(Boolean)))];
}
function readback(plan, state) {
  return plan.affectedIds.map(id => {
    if (plan.domain === 'shot') {
      const shot = state.shotDocument.shots.find(s => s.id === plan.details.shotId);
      if (!shot) fail('UNCERTAIN_APPLY', 'Committed shot is unavailable at readback.');
      return { id, after: { shotId: shot.id, range: { startFrame: shot.startFrame, endFrameExclusive: shot.endFrame + 1 }, camera: state.camera, subjectIds: plan.details.subjectIds, ...(id === plan.details.keyId ? { keyId: id, frame: shot.cameraKeys.find(k => k.id === id).frame } : {}) } };
    }
    const entity = state[plan.domain === 'objects' ? 'objects' : 'characters'].find(e => e.id === id);
    return { id, after: !entity ? { removed: true } : { position: pos(entity), yawDeg: entity.rot,
      ...(entity.renderer ? { name: entity.name, renderer: entity.renderer, rotationDeg: { x: entity.rotX, y: entity.rot, z: entity.rotZ }, scale: { x: entity.scaleX, y: entity.scaleY, z: entity.scaleZ }, parentId: entity.parent, color: entity.color } : { name: entity.subject, scale: entity.scale, modelId: entity.model, hidden: entity.hidden, activeCharacterId: state.activeCharacterId }) } };
  });
}
/** ports: synchronous read/guard/bounds/commit. commit must atomically publish
 * exactly the draft and one history entry, or throw before changing anything.
 * A thrown/invalid commit is conservatively unknown, never automatically retried. */
export function createStudioCommands(ports) {
  const journal = ports.journal ?? createStudioCommandJournal({ host: ports.read().host, isRetained: ports.isRetained });
  const documentIsCurrent = () => equal(validateStudioIdentity(ports.read().host), journal.host);
  function execute(request) {
    const host = validateStudioIdentity(request.host);
    validateStudioSchema(StudioSchemas.TargetGuard.properties.targetId, request.commandId);
    const signature = JSON.stringify(request);
    let phase = 'admission', committing = false;
    function failure(code, failurePhase, mutated, message) {
      return validateReceipt({ ok: false, commandId: request.commandId, host, code, phase: failurePhase, affectedIds: [], expectedTargets: [], currentTargets: [], mutated,
        preserved: { authoredState: mutated === false ? 'unchanged' : 'unknown' }, recovery: { action: mutated === false ? 'inspect' : 'reconcile', ...(mutated === false ? { retryAllowed: false } : {}) }, ...(message ? { message: [...message].slice(0, 120).join('') } : {}) });
    }
    if (!equal(host, journal.host) || !documentIsCurrent()) return failure('STALE_SCENE', phase, false, 'Request belongs to a different live document.');
    try {
      if (!journal.begin(request.commandId, signature)) return journal.get(request.commandId) ?? failure('UNCERTAIN_APPLY', 'reconcile', 'unknown');
    } catch (error) { return failure(error.code, phase, false, error.message); }
    try {
      const command = validateStudioCommand({ name: request.name, args: request.args });
      if (!['arrange_objects', 'arrange_characters', 'frame_shot'].includes(command.name)) fail('CAPABILITY_MISSING', 'This module exposes arrangement and framing only.');
      const before = structuredClone(ports.read());
      const fence = () => {
        const current = ports.read();
        if (!equal(host, validateStudioIdentity(current.host)) || !equal(host, journal.host)) fail('STALE_SCENE', 'Live document identity changed.');
        if (request.expectedRevision !== current.revision) fail('STALE_SCENE', 'Authored scene revision changed.');
        if (current.busy) fail('TARGET_BUSY', 'A domain gesture is in progress.');
        for (const id of dependencies(command, before)) {
          const expected = request.expectedTargets?.find(t => t.targetId === id);
          validateTargetGuard(expected, ports.guard(id));
        }
        if (current.frame !== before.frame || !equal(current.camera, before.camera)) fail('STALE_SCENE', 'Reference view changed during draft evaluation.');
      };
      fence(); phase = 'prepare';
      const plan = command.name === 'frame_shot' ? frameDraft(command, before, ports) : arrangement(command, before, ports);
      const unchanged = plan.domain === 'shot' ? equal(plan.draft, before.shotState ?? { shotDocument: before.shotDocument, camera: before.camera, manual: before.manual }) : !plan.affectedIds.length;
      const base = { ok: true, commandId: request.commandId, receiptId: createStableItemId('receipt'), host, revision: { before: before.revision, after: before.revision }, affectedIds: plan.affectedIds, delta: [], checks: plan.checks, warnings: plan.warnings, undo: null };
      if (unchanged) return journal.record({ ...base, status: 'noop', authored: false, mutated: false });
      if (plan.affectedIds.length > 100) fail('INVALID_ARGUMENT', 'Affected domain exceeds receipt capacity.');
      const preview = { ...before, ...(plan.domain === 'shot' ? plan.draft : { [plan.domain === 'objects' ? 'objects' : 'characters']: plan.draft }) };
      const allDelta = readback(plan, preview);
      const makeReceipt = (delta, historyEntryId) => {
        const r = { ...base, status: 'applied', authored: true, revision: { before: before.revision, after: before.revision + 1 }, delta: delta.slice(0, 8), undo: { historyEntryId, entries: 1, canUndoDirect: true }, detailCursor: request.commandId };
        while (r.delta.length > 1 && utf8ByteLength(JSON.stringify(r)) > 8000) r.delta.pop();
        return validateReceipt(r);
      };
      makeReceipt(allDelta, 'preflight-history'); // Reject receipt overflow BEFORE mutation.
      fence(); phase = 'commit'; committing = true;
      const committed = ports.commit({ domain: plan.domain, before, draft: plan.draft, commandId: request.commandId, host, expectedRevision: before.revision });
      if (committed?.then) fail('UNCERTAIN_APPLY', 'Commit must publish synchronously.');
      const current = ports.read();
      const actual = plan.domain === 'shot' ? { shotDocument: current.shotDocument, camera: current.camera, manual: current.manual } : current[plan.domain === 'objects' ? 'objects' : 'characters'];
      if (current.revision !== before.revision + 1 || !equal(current.host, host) || !equal(actual, plan.draft)) fail('UNCERTAIN_APPLY', 'Commit did not synchronously publish the admitted poststate.');
      const delta = readback(plan, current);
      return journal.record(makeReceipt(delta, committed.historyEntryId), { delta, geometry: plan.details });
    } catch (error) {
      const receipt = failure(committing ? 'UNCERTAIN_APPLY' : error instanceof StudioProtocolError ? error.code : 'INVALID_ARGUMENT', phase, committing ? 'unknown' : false, error.message);
      // An owner may already have journaled the commit before a lost ack.
      const recorded = journal.reconcile({ commandId: request.commandId });
      if (recorded.status === 'applied') return recorded.receipt;
      return journal.record(receipt);
    }
  }
  return { execute, journal,
    reconcile_studio_command: args => documentIsCurrent() ? journal.reconcile(args) : { status: 'unknown' },
    readDetails: commandId => documentIsCurrent() ? journal.details(commandId) : null };
}
export function studioObjectCatalogue() {
  return freezeStudioData({ objects: OBJECT_LIBRARY.map(({ kind, footprint, height, supportY }) => ({ kind, footprint: { ...footprint }, height, supportY: supportY ?? height })), imageRefs: [] });
}
