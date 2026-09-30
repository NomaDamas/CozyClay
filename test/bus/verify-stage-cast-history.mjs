import assert from 'node:assert/strict';
import { stageFixture } from './stage-fixture.mjs';
const f = stageFixture();
try {
  const cast = f.scope.appContext.storeDomain('cast');
  const before = structuredClone(cast.read());
  const edited = f.run('character.update', { characterId: 'actor-a', patch: { x: 1 } });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  const lit = f.run('stage.set', { keyLight: { intensity: 3 }, environment: 'After cast edit' });
  assert.equal(lit.ok, true, JSON.stringify(lit));
  const stage = structuredClone(f.stage.read());
  assert.equal(f.run('edit.undo', { receiptId: edited.receiptId }).code, 'UNDO_CONFLICT');
  assert.deepEqual(f.stage.read(), stage, 'an older cast receipt cannot cross a newer stage edit');
  assert.equal(f.stage.documentStore.depths().past, 1);
  for (const key of ['keyLight', 'environmentImage', 'environment', 'style', 'hasEnvSheet']) assert.equal(Object.hasOwn(cast.documentStore.history().present.snapshot.cast, key), false, `${key} is not cast history`);
  assert.equal(f.run('edit.undo', { receiptId: lit.receiptId }).status, 'undone');
  const restoredStage = structuredClone(f.stage.read());
  assert.equal(f.run('edit.undo', { receiptId: edited.receiptId }).status, 'undone');
  assert.deepEqual(cast.read(), before); assert.deepEqual(f.stage.read(), restoredStage);
  console.log('PASS cast history excludes stage and cannot cross the shared undo boundary');
} finally { f.dispose(); }
