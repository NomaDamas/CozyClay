// One semantic entry point for timeline, camera controls and agent framing.
import { createCameraBlock, updateCameraBlock, removeCameraRail } from '../camera-block.js';
import { addShotAtFrame, createShot, cutAtFrame, duplicateShot, removeShot, reorderShot, resizeShot, renameShot, moveCameraKey, removeCameraKey } from '../cuts.js';
import { reflowStillShots, stillFrameCount, STILL_FRAME_COUNT_MAX, STILL_HOLD_DEFAULT } from '../shot-authoring.js';
import { ko } from '../locale.js';
import { track } from '../analytics.js';
import { isImageAssetId } from '../scene-assets.js';
import { createStableItemId, updateStableItem } from '../stable-items.js';
import { railFollowForNewGeometry } from '../camera-rail-schedule.js';
import { studioActionDeclaration, studioActionRefusal } from '../studio-actions.js';
import { STUDIO_TOOL_SCHEMAS, StudioSchemas } from '../studio-agent-protocol.js';
import { elementSetSchema, registerElementSet } from './elements.js';
import './elements/shot.js';
import { changedIds, fail, shotLabel } from './shared.js';

const id = StudioSchemas.TargetGuard.properties.targetId;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const number = { type: 'number' };
const frame = { type: 'integer', minimum: 0 };
const input = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const mutation = (id, label, schema) => ({ id, label, description: label, kind: 'mutation', undoDomain: 'shot', input: schema });
const existing = ['shot.create', 'shot.createStill', 'shot.setCaption', 'shot.setCastOverride', 'shot.setHold', 'shot.split', 'shot.duplicate', 'shot.remove', 'shot.setRange', 'shot.setCameraRail', 'shot.clearCameraRail', 'shot.reorder'].map(studioActionDeclaration);
const extra = [
  mutation('shot.set', 'Set shot fields', elementSetSchema('shot')),
  mutation('shot.rename', 'Rename shot', input({ shotId: id, name: { type: 'string', maxLength: 240 } })),
  mutation('shot.setCamera', 'Set camera block', input({ shotId: id, patch: { type: 'object', properties: {}, additionalProperties: true } })),
  mutation('shot.addKey', 'Add camera key', input({ shotId: id, frame })),
  mutation('shot.moveKey', 'Move camera key', input({ shotId: id, keyId: id, frame })),
  mutation('shot.removeKey', 'Remove camera key', input({ shotId: id, keyId: id })),
  mutation('shot.clearKeys', 'Clear camera keys', input({ shotId: id })),
  mutation('shot.setTimeline', 'Set shot timeline', input({ frameCount: { type: 'integer', minimum: 24, maximum: 28800 } })),
  mutation('shot.setLens', 'Set camera lens', input({ fovDeg: { ...number, minimum: 14, maximum: 90 } })),
  mutation('shot.frame', 'Frame the shot', { ...input({ ...STUDIO_TOOL_SCHEMAS.frame_shot.properties, preset: { type: 'string' } }, []), oneOf: [STUDIO_TOOL_SCHEMAS.frame_shot, input({ preset: { type: 'string' } })] }),
  { ...mutation('shot.replace', 'Replace shot authoring', input({ shots: { type: 'array', items: { type: 'object', properties: {}, additionalProperties: true } } })), exposure: 'ui-only' },
  { ...mutation('shot.captureCamera', 'Capture camera framing', input({ shotId: id }, [])), exposure: 'ui-only' },
  // The Board's Stylize result (or null to clear it). UI-only: the picture has
  // to be in the asset store first, which only the Stylize flow does.
  { ...mutation('shot.setStylized', 'Set stylized panel image', input({ shotId: id, assetId: { oneOf: [{ type: 'string' }, { type: 'null' }] } })), exposure: 'ui-only' },
  { ...mutation('shot.placeCamera', 'Place camera', input(Object.fromEntries(['x', 'y', 'z', 'lookAtX', 'lookAtY', 'lookAtZ', 'focalMm'].map(key => [key, number])), [])), exposure: 'ui-only' },
];
export const declarations = Object.freeze([extra[0], ...existing, ...extra.slice(1).map(entry => entry.id === 'shot.frame' ? entry : { ...entry, exposure: 'ui-only' })]);

export function register(registry, ports) {
  const owner = () => ports.storeDomain('shot');
  const mounted = () => Boolean(ports.storeDomain?.('shot')) || 'The shots document owner is not mounted.';
  const shotOf = shotId => owner().read().find(shot => shot.id === shotId) ?? fail('STALE_TARGET', `Shot ${shotId} is not in this scene.`);
  const patchShot = (shotId, update) => { shotOf(shotId); owner().write(current => updateStableItem(current, shotId, update, 'shots')); };
  const storyboard = () => ports.storeDomain?.('scenes')?.metadata?.().previsMode === 'storyboard';
  const stillOf = shotId => {
    const shot = shotOf(shotId);
    return shot.kind === 'still' ? shot : fail('INVALID_ARGUMENT', `${shot.name} is a clip shot; only stills have a hold and a place in the still order.`);
  };
  // Every still edit is one write: the stills (in their new array order) are
  // laid end to end and the timeline is sized to them, or nothing changes.
  function writeStills(shots) {
    const next = reflowStillShots(shots), frameCount = stillFrameCount(next);
    if (frameCount > STILL_FRAME_COUNT_MAX) {
      const en = `Storyboard is full (${STILL_FRAME_COUNT_MAX} frames); shorten a hold or remove a panel.`;
      throw studioActionRefusal('INVALID_ARGUMENT', en, ko(en, `스토리보드가 가득 찼습니다 (${STILL_FRAME_COUNT_MAX}프레임). 홀드를 줄이거나 패널을 지우세요.`));
    }
    const clip = next.find(shot => shot.kind !== 'still' && next.some(still => still.kind === 'still' && still.startFrame <= shot.endFrame && still.endFrame >= shot.startFrame));
    if (clip) fail('TARGET_NOT_READY', `The stills would overlap the clip shot ${clip.name} (frames ${clip.startFrame}-${clip.endFrame}); move or remove it first.`);
    owner().writeState(before => ({ ...before, shots: next, frameCount }));
    return next;
  }
  function createStill({ caption = '', hold = STILL_HOLD_DEFAULT } = {}) {
    const current = owner().read(), framing = owner().capture(), last = current.findLastIndex(shot => shot.kind === 'still');
    const keys = framing ? [{ id: createStableItemId('camera-key'), frame: 0, framing }] : [];
    const still = { ...createShot(`Shot ${current.length + 1}`, 0, hold - 1, keys), kind: 'still', caption };
    const written = writeStills([...current.slice(0, last + 1), still, ...current.slice(last + 1)]);
    // Land the playhead in the new panel (the timeline.seek path) so the placement
    // actions that follow write this panel's cast override, not the previous one's.
    const created = written.find(shot => shot.id === still.id), { selection, view } = ports.readView();
    ports.publishView({ selection, view: { ...view, frame: created.startFrame }, shotId: created.id });
  }
  function duplicate(shotId) {
    const source = shotOf(shotId), copied = { kind: source.kind, caption: source.caption, cast: structuredClone(source.cast), stylizedAssetId: source.stylizedAssetId };
    if (source.kind !== 'still') {
      const before = owner().read(), next = duplicateShot(before, shotId, owner().state().frameCount);
      return owner().write(next.map(shot => before.includes(shot) ? shot : { ...shot, ...copied }));
    }
    const current = owner().read(), index = current.indexOf(source);
    const copy = { ...createShot(`${source.name} copy`, source.startFrame, source.endFrame,
      source.cameraKeys.map(key => ({ ...key, id: createStableItemId('camera-key') })), source.camera), ...copied };
    writeStills([...current.slice(0, index + 1), copy, ...current.slice(index + 1)]);
  }
  function reorder({ shotId, startFrame, index }) {
    if ((startFrame === undefined) === (index === undefined)) fail('INVALID_ARGUMENT', 'shot.reorder takes exactly one of startFrame or index.');
    const shot = shotOf(shotId);
    if (shot.kind !== 'still') {
      if (index !== undefined) stillOf(shotId);
      return owner().write(current => reorderShot(current, shotId, startFrame, owner().state().frameCount));
    }
    const current = owner().read(), others = current.filter(row => row.kind === 'still' && row.id !== shotId);
    const target = index ?? others.filter(row => row.startFrame < startFrame).length;
    const order = [...others.slice(0, target), shot, ...others.slice(target)];
    let next = 0;
    writeStills(current.map(row => row.kind === 'still' ? order[next++] : row));
  }
  const methods = {
    'shot.create': () => storyboard() ? createStill() : owner().write(current => addShotAtFrame(current, ports.state().frame, owner().state().frameCount, owner().capture())),
    'shot.createStill': args => createStill(args),
    'shot.setCaption': ({ shotId, caption }) => patchShot(shotId, shot => ({ ...shot, caption })),
    'shot.setCastOverride': ({ shotId, characterId, override }) => owner().setCastOverride(shotId, characterId, override),
    'shot.setHold': ({ shotId, hold }) => {
      const shot = stillOf(shotId), endFrame = shot.startFrame + hold - 1;
      writeStills(owner().read().map(row => row === shot ? { ...row, endFrame, cameraKeys: row.cameraKeys.filter(key => key.frame <= endFrame) } : row));
    },
    'shot.split': ({ shotId }) => {
      const shot = shotOf(shotId), { frame } = ports.state();
      if (frame <= shot.startFrame || frame > shot.endFrame) fail('TARGET_NOT_READY', `The playhead (frame ${frame}) is not inside ${shot.name} after its first frame.`);
      owner().write(current => cutAtFrame(current, shotId, frame, owner().capture()));
    },
    'shot.duplicate': ({ shotId }) => duplicate(shotId),
    'shot.remove': ({ shotId }) => { shotOf(shotId); owner().write(current => removeShot(current, shotId)); },
    'shot.reorder': args => reorder(args),
    'shot.setRange': ({ shotId, range }) => {
      const shot = shotOf(shotId), startFrame = range.startFrame, endFrame = range.endFrameExclusive - 1;
      const edges = startFrame > shot.endFrame ? [['end', endFrame], ['start', startFrame]] : [['start', startFrame], ['end', endFrame]];
      owner().write(current => edges.reduce((rows, [edge, frame]) => resizeShot(rows, shotId, edge, frame, owner().state().frameCount), current));
    },
    'shot.setCameraRail': ({ shotId, points }) => patchShot(shotId, shot => ({ ...shot, camera: updateCameraBlock(shot.camera, {
      cameraRail: points, mode: 'rail', railFollow: railFollowForNewGeometry(shot.camera?.railFollow, shot.endFrame - shot.startFrame + 1),
    }) })),
    'shot.clearCameraRail': ({ shotId }) => {
      const shot = shotOf(shotId);
      if (!createCameraBlock(shot.camera).cameraRail) fail('TARGET_NOT_READY', `${shot.name || shotId} has no camera rail.`);
      patchShot(shotId, shot => ({ ...shot, camera: removeCameraRail(shot.camera) }));
    },
    'shot.rename': ({ shotId, name }) => { shotOf(shotId); owner().write(current => renameShot(current, shotId, name)); },
    'shot.setCamera': ({ shotId, patch }) => patchShot(shotId, shot => ({ ...shot, camera: updateCameraBlock(shot.camera, patch) })),
    'shot.addKey': ({ shotId, frame }) => {
      const shot = shotOf(shotId), target = Math.min(owner().state().frameCount - 1, frame);
      if (target < shot.startFrame || target > shot.endFrame) return;
      const framing = owner().capture();
      patchShot(shotId, shot => ({ ...shot, cameraKeys: [...shot.cameraKeys.filter(key => key.frame !== target),
        { id: shot.cameraKeys.find(key => key.frame === target)?.id ?? createStableItemId('camera-key'), frame: target, framing }].sort((a, b) => a.frame - b.frame) }));
    },
    'shot.moveKey': ({ shotId, keyId, frame }) => patchShot(shotId, shot => ({ ...shot,
      cameraKeys: moveCameraKey(shot.cameraKeys, keyId, Math.max(shot.startFrame, Math.min(shot.endFrame, frame))) })),
    'shot.removeKey': ({ shotId, keyId }) => patchShot(shotId, shot => ({ ...shot, cameraKeys: removeCameraKey(shot.cameraKeys, keyId) })),
    'shot.clearKeys': ({ shotId }) => patchShot(shotId, shot => ({ ...shot, cameraKeys: [] })),
    'shot.setTimeline': ({ frameCount }) => owner().writeState(before => ({ ...before, frameCount })),
    'shot.setLens': ({ fovDeg }) => owner().setLens(fovDeg),
    'shot.replace': ({ shots }) => owner().write(shots),
    'shot.captureCamera': args => owner().captureCamera(args.shotId),
    'shot.setStylized': ({ shotId, assetId }) => {
      if (assetId !== null && !isImageAssetId(assetId)) fail('INVALID_ARGUMENT', `${assetId} is not an image asset id.`);
      patchShot(shotId, shot => ({ ...shot, stylizedAssetId: assetId }));
    },
    'shot.placeCamera': args => owner().placeCamera(args),
  };
  const hasShots = state => state.shots.length > 0 || 'There are no shots yet; add one with shot.create.';
  const availability = {
    'shot.createStill': () => true,
    'shot.create': state => storyboard() || addShotAtFrame(state.shots, state.frame, state.frameCount, null) !== state.shots || `There is no free room for a new shot at the playhead (frame ${state.frame}); move it with operate_studio { frame } or shorten a shot.`,
    'shot.split': state => state.shots.some(shot => state.frame > shot.startFrame && state.frame <= shot.endFrame) || `The playhead (frame ${state.frame}) is not inside a shot after its first frame; move it with operate_studio { frame }.`,
    'shot.clearCameraRail': state => state.shots.some(shot => createCameraBlock(shot.camera).cameraRail) || 'No shot has a camera rail; lay one with shot.setCameraRail.',
  };
  registerElementSet(registry, ports, extra[0]);
  for (const declaration of declarations.filter(row => row.id !== 'shot.set')) registry.register({ ...declaration,
    available: state => mounted() === true ? (availability[declaration.id] ?? (existing.includes(declaration) ? hasShots : () => true))(state) : mounted(),
    run(args, context) {
      if (declaration.id === 'shot.frame') {
        const plan = owner().frame(args);
        return { affectedIds: plan.affectedIds, summary: 'Framed the shot.' };
      }
      const before = owner().read(), newPanel = declaration.id === 'shot.createStill' || (declaration.id === 'shot.create' && storyboard());
      methods[declaration.id](args);
      // Only the origin travels: never the caption, name or id of the panel.
      if (newPanel) track('storyboard:panel_created', { source: context?.origin && context.origin !== 'ui' ? 'agent' : 'manual' });
      // The owner re-normalizes every shot on write, so compare content, not
      // identity; a storyboard reflow can still move more shots than a receipt
      // names (100), and the first 100 stand for the batch.
      const after = owner().read(), changed = changedIds(before.map(row => after.find(next => next.id === row.id && same(next, row)) ?? row), after).slice(0, 100);
      const affectedIds = changed.length ? changed : [args.shotId ?? ports.state().activeSceneId];
      return { affectedIds, summary: changed.length ? `${declaration.label}: ${changed.map(id => after.find(row => row.id === id)).filter(Boolean).map(shotLabel).join('; ')}.` : `${declaration.label}.` };
    },
  });
  if (ports.storeDomain?.('shot')) registry.registerToolAlias('frame_shot', 'shot.frame');
}
