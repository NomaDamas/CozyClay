import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appFixture } from './app-fixture.mjs';
import { createShot } from '../../src/cuts.js';

test('#495: legacy inspection aliases retain query filtering on the canonical document', () => {
  const f = appFixture();
  try {
    const hero = createShot('Hero', 0, 23), wide = createShot('Wide', 24, 47);
    f.scope.setShots([hero, wide]);
    f.scope.setCharacters(f.characterRef.current.map((row, index) => ({ ...row, subject: index === 0 ? 'Hero performer' : 'Other performer' })));
    const inspect = args => f.binding.handlers.inspect_studio(args);
    const shot = inspect({ scope: 'shot', query: 'Hero' });
    assert.equal(shot.scope, 'document');
    assert.deepEqual(shot.document.shots.map(row => row.id), [hero.id]);
    const motion = inspect({ scope: 'motion', query: 'Other performer' });
    assert.deepEqual(motion.document.characters.map(row => row.id), ['actor-b']);
    assert.deepEqual(motion.document.motion.map(row => row.id), ['actor-b']);
    for (const scope of ['shot', 'motion']) assert.deepEqual(inspect({ scope, query: 'missing-name' }).document, {});
  } finally { f.dispose(); }
});
