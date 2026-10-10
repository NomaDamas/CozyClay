import assert from 'node:assert/strict';
import { stageFixture } from './stage-fixture.mjs';
import { readStudioFunction } from './verify-domain-modules.mjs';
const f = stageFixture();
try {
  const snapshotActiveScene = new Function('appContext', `${readStudioFunction('snapshotActiveScene')}\nreturn snapshotActiveScene;`)(f.scope.appContext);
  f.scope.shotDocumentRef = { current: null };
  for (const environment of ['document fixture one', 'document fixture two']) {
    assert.equal(f.run('stage.set', { environment, keyLight: { intensity: 2 } }).ok, true);
    const reply = f.binding.handlers.inspect_studio({ scope: 'document', select: ['stage'] });
    assert.deepEqual(reply.document.stage, snapshotActiveScene()[0].stage, 'the synchronous persisted scene projection is authoritative');
    assert.equal(reply.schema.stage.properties.keyLight.properties.intensity.type, 'number');
    assert.equal(reply.revision.scene, f.binding.refresh().revision);
    assert.deepEqual(f.binding.handlers.inspect_studio({ scope: 'document', ids: ['missing'], select: ['stage'] }).document, {});
  }
  console.log('PASS document scope matches snapshotActiveScene synchronously and returns generated schema');
} finally { f.dispose(); }
