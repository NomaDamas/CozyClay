import assert from 'node:assert/strict';
import { test } from 'node:test';
import { objectsFixture } from './objects-fixture.mjs';

const input = { type: 'object', properties: {}, required: [], additionalProperties: false };
const snapshot = f => structuredClone({ shots: f.scope.shotsDomain.read(), objects: f.objects.read(),
  stage: f.stage.read(), characters: f.actual.readStudioState().characters });
const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt; };
function register(f, id, domain, run) {
  f.registry.register({ id, label: id, description: id, kind: 'mutation', undoDomain: domain,
    input, available: () => true, run: (_args, context) => run(context) });
}
function composite(f, id = 'fixture.ownedComposite', domain = 'shot', withNative = false) {
  register(f, id, domain, context => {
    const shot = context.run('shot.create');
    context.run('shot.setCameraRail', { shotId: shot.affectedIds[0], points: [{ x: -2, z: 4 }, { x: 2, z: 4 }] });
    context.run('object.rename', { id: 'cube', name: 'Composed cube' });
    context.run('stage.setStyle', { style: 'Composed stage' });
    if (withNative) context.run('character.addWaypoint', { characterId: 'actor-a', frame: 24, position: { x: 1, z: 0 } });
    return { affectedIds: shot.affectedIds, summary: 'Composed edit.' };
  });
}

test('nested same-store commands join the outer owned session through actual App routing', () => {
  const f = objectsFixture();
  try {
    const before = snapshot(f), domain = f.scope.shotsDomain;
    const depth = domain.documentStore.depths().past;
    register(f, 'fixture.sameStore', 'shot', context => {
      const shot = context.run('shot.create');
      context.run('shot.setCameraRail', { shotId: shot.affectedIds[0], points: [{ x: -2, z: 4 }, { x: 2, z: 4 }] });
      return { affectedIds: shot.affectedIds, summary: 'Two shot edits.' };
    });
    const receipt = ok(f.run('fixture.sameStore'));
    assert.equal(receipt.undo.entries, 1);
    assert.equal(domain.documentStore.depths().past, depth + 1);
    assert.equal(f.scope.appContext.storeDomain('cast').documentStore.depths().past, 0, 'nested shots do not duplicate history in cast');
    assert.equal(f.run('edit.undo', { receiptId: receipt.receiptId }).status, 'undone');
    assert.deepEqual(snapshot(f), before);
  } finally { f.dispose(); }
});

test('one promised entry undoes and redoes every touched owned domain, never just shots', () => {
  const f = objectsFixture();
  try {
    composite(f);
    const before = snapshot(f);
    const receipt = ok(f.run('fixture.ownedComposite'));
    assert.equal(receipt.undo.entries, 1);
    assert.ok(receipt.affectedIds.includes('cube'));
    assert.ok(receipt.affectedIds.includes(f.host().sceneId));
    const after = snapshot(f);
    assert.notDeepEqual(after.shots, before.shots);
    assert.notDeepEqual(after.objects, before.objects);
    assert.notDeepEqual(after.stage, before.stage);
    for (const domain of [f.scope.shotsDomain, f.objects, f.stage]) assert.equal(domain.documentStore.depths().past, 1);
    assert.equal(f.run('edit.undo', { receiptId: receipt.receiptId }).status, 'undone');
    assert.deepEqual(snapshot(f), before, 'the complete promised pre-image is restored');
    f.actual.redoScene();
    assert.deepEqual(snapshot(f), after, 'keyboard redo restores the complete post-image');
    assert.equal(f.actual.canUndoStudioReceipt(receipt), true);
  } finally { f.dispose(); }
});

test('a later refusal rolls back all enlisted domains and adds no history', () => {
  const f = objectsFixture();
  try {
    register(f, 'fixture.refusedComposite', 'shot', context => {
      context.run('shot.create');
      context.run('object.rename', { id: 'cube', name: 'Must roll back' });
      context.run('stage.setStyle', { style: 'Must also roll back' });
      context.run('object.rename', { id: 'missing', name: 'Refused' });
      throw new Error('the invalid target must refuse before this line');
    });
    const before = snapshot(f), clock = f.scope.appContext.undoClock;
    const receipt = f.run('fixture.refusedComposite');
    assert.equal(receipt.ok, false);
    assert.equal(receipt.code, 'STALE_TARGET');
    assert.deepEqual(snapshot(f), before);
    for (const domain of [f.scope.shotsDomain, f.objects, f.stage]) assert.equal(domain.documentStore.depths().past, 0);
    assert.equal(f.scope.appContext.undoClock, clock, 'rolled-back groups never stamp committed history');
    assert.throws(() => f.objects.write([]), /requires a bus run/);
    ok(f.run('shot.create'));
  } finally { f.dispose(); }
});

test('receipt and keyboard history keep a composite atomic across newer independent edits', () => {
  const f = objectsFixture();
  try {
    composite(f);
    const before = snapshot(f), group = ok(f.run('fixture.ownedComposite')), composed = snapshot(f);
    const latest = ok(f.run('object.rename', { id: 'sphere', name: 'Later edit' })), after = snapshot(f);
    assert.equal(f.run('edit.undo', { receiptId: group.receiptId }).code, 'UNDO_CONFLICT');
    assert.equal(f.run('edit.undo', { receiptId: latest.receiptId }).status, 'undone');
    assert.deepEqual(snapshot(f), composed);
    f.actual.undoScene(); assert.deepEqual(snapshot(f), before);
    f.actual.redoScene(); assert.deepEqual(snapshot(f), composed);
    f.actual.redoScene(); assert.deepEqual(snapshot(f), after);
  } finally { f.dispose(); }
});

test('evicting one member expires the composite receipt instead of promising partial undo', () => {
  const f = objectsFixture();
  try {
    composite(f);
    const receipt = ok(f.run('fixture.ownedComposite'));
    for (let i = 0; i < 51; i++) ok(f.run('object.rename', { id: 'cube', name: `Retention ${i}` }));
    const before = snapshot(f);
    assert.equal(f.run('edit.undo', { receiptId: receipt.receiptId }).code, 'UNDO_EXPIRED');
    assert.deepEqual(snapshot(f), before);
  } finally { f.dispose(); }
});

for (const rootDomain of ['shot', 'cast']) test(`facade composition enlists owned cast history with an ${rootDomain} root`, () => {
  const f = objectsFixture();
  try {
    const app = f.scope.appContext;
    // Exercise composition directly over the shipped owners. App's delegation
    // is also covered by verify-app-session-composition.
    assert.equal(typeof app.recordAction, 'function');
    f.ports.recordAction = (domain, run, targetId, nested) => app.recordAction(domain, run, targetId, nested);
    composite(f, 'fixture.mixedComposite', rootDomain, true);
    const before = snapshot(f), receipt = ok(f.run('fixture.mixedComposite')), after = snapshot(f);
    assert.equal(receipt.undo.entries, 1);
    assert.notDeepEqual(after.characters, before.characters);
    assert.equal(f.run('edit.undo', { receiptId: receipt.receiptId }).status, 'undone');
    assert.deepEqual(snapshot(f), before);
    f.actual.redoScene(); assert.deepEqual(snapshot(f), after);
    assert.equal(f.actual.canUndoStudioReceipt(receipt), true);
  } finally { f.dispose(); }
});
