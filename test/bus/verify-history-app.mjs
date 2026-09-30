import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSync } from 'rolldown/experimental';
import { motionFixture } from './motion-fixture.mjs';
import { createObjectsDomain } from './objects-fixture.mjs';
import { createStageDomain } from '../../src/domains/stage.js';
import { createSceneObject } from '../../src/scene-objects.js';

const source = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
let keyboard;
function walk(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'VariableDeclarator' && node.id.name === 'onKeyDown' && source.slice(node.start, node.end).includes('event.code === "KeyZ"')) keyboard = source.slice(node.init.start, node.init.end);
  for (const [key, child] of Object.entries(node)) if (key !== 'parent') Array.isArray(child) ? child.forEach(walk) : walk(child);
}
walk(parseSync('App.jsx', source).program);
assert.ok(keyboard, 'execute the shipped keyboard callback, not a test substitute');
const f = motionFixture(), app = f.scope.appContext;
const objects = createObjectsDomain(app, [{ ...createSceneObject('cube'), id: 'cube' }]);
f.store.current = objects.store;
f.scope.actorStageRef = { current: f.live.current.stage };
const stage = createStageDomain(app.forRender({ ...f.scope, startupStage: f.live.current.stage }));
const snapshot = () => structuredClone(Object.fromEntries(app.storeDomains().map(owner => [Object.keys(owner.documentStore.getSnapshot().slices)[0], owner.documentStore.getSnapshot().slices])));
const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt; };
const input = class {}, textarea = class {}, select = class {};
const handler = new Function('scope', `with (scope) { return (${keyboard}); }`)({
  HTMLInputElement: input, HTMLTextAreaElement: textarea, HTMLSelectElement: select,
  flyingRef: { current: false }, undoScene: f.actual.undoScene, redoScene: f.actual.redoScene,
});
function key(redo = false, target = null) {
  let prevented = false;
  handler({ code: 'KeyZ', ctrlKey: true, shiftKey: redo, target, preventDefault() { prevented = true; } });
  return prevented;
}
try {
  // The camera mounts after its owner; prime the same lazy runtime pre-image
  // that the first shot session captures, without authoring a history entry.
  f.scope.shotsDomain.beginAction().cancel();
  const snapshots = [snapshot()], receipts = [];
  for (const redo of [false, true]) {
    f.values.setToast = undefined;
    assert.equal(key(redo), true);
    assert.equal(typeof f.values.setToast, 'string', 'empty keyboard history still gives UI feedback');
    assert.ok(f.values.setToast.length > 0);
    assert.deepEqual(snapshot(), snapshots[0]);
  }
  for (const [id, args] of [
    ['object.rename', { id: 'cube', name: 'Changed' }],
    ['character.update', { characterId: 'actor-a', patch: { x: 1 } }],
    ['shot.setLens', { fovDeg: 35 }],
    ['ik.setKey', { characterId: 'actor-a', frame: 0, tracks: { head: { q: [{ x: 0, y: 0.2, z: 0, w: Math.sqrt(0.96) }] } } }],
    ['stage.setStyle', { style: 'Changed stage' }],
    ['object.rename', { id: 'cube', name: 'Latest' }],
  ]) { receipts.push(ok(f.run(id, args))); snapshots.push(snapshot()); }
  assert.equal(key(false, new input()), false, 'text inputs keep browser text undo');
  assert.deepEqual(snapshot(), snapshots.at(-1));
  for (let i = receipts.length - 1; i >= 0; i--) {
    assert.equal(key(), true); assert.deepEqual(snapshot(), snapshots[i], `Ctrl+Z ${i}`);
  }
  for (let i = 1; i < snapshots.length; i++) {
    assert.equal(key(true), true); assert.deepEqual(snapshot(), snapshots[i], `Ctrl+Shift+Z ${i}`);
  }
  const request = f.request('undo_edit', { receiptId: receipts.at(-1).receiptId });
  const alias = ok(f.binding.handlers.undo_edit(request));
  assert.deepEqual(snapshot(), snapshots.at(-2));
  assert.equal(alias.undo.historyEntryId, receipts.at(-1).undo.historyEntryId);
  assert.equal(ok(f.run('edit.redo')).action, 'edit.redo');
  assert.deepEqual(snapshot(), snapshots.at(-1));
  console.log('PASS #494.4 shipped keyboard callback, real five-domain owners, alias and receipt redo round-trip');
} finally { stage.dispose(); objects.dispose(); f.dispose(); }
