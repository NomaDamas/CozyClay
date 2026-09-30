import assert from 'node:assert/strict';
import { motionFixture, seedMotion } from './motion-fixture.mjs';

const f = motionFixture();
try {
	f.motion.load([{ id: 'actor-a', take: seedMotion() }]);
	const pin = { id: 'pin-qa', track: 'leftFoot', startFrame: 5, endFrame: 5, blend: 6, reach: 'limb', target: { space: 'world', position: [0, 0, 0] } };
	const apply = (value) => { const receipt = f.run('motion.rangePin.apply', { characterId: 'actor-a', pin: value }); assert.equal(receipt.ok, true, JSON.stringify(receipt)); assert.equal(receipt.undo.entries, 1); return receipt; };
	assert.throws(() => f.motion.setRangePinState('actor-a', { keys: new Map(), pins: new Map(), pinResiduals: new Map() }), /requires a bus run/);
	apply(pin);
	const residuals = structuredClone(f.scope.ikStateRef.current.pinResiduals.get(pin.id));
	const app = f.scope.appContext;
	assert.equal(f.scope.ikStateRef.current.keys.get(5).get('leftFoot').pin, pin.id, 'projecting the document preserves key ownership');
	assert.deepEqual(f.scope.ikStateRef.current.pins.get(pin.id), pin);
	assert.equal(f.renderMotion().rangePins.length, 1, 'the panel reads pins from the motion owner');
	assert.ok(app.nextStoreHistory(false).stepHistory(false), 'pin edit is undoable');
	assert.equal(f.scope.ikStateRef.current.pins.size, 0);
	assert.equal(f.scope.ikStateRef.current.keys.size, 0);
	assert.ok(app.nextStoreHistory(true).stepHistory(true), 'pin metadata and keys redo together');
	assert.equal(f.scope.ikStateRef.current.keys.get(5).get('leftFoot').pin, pin.id);
	assert.deepEqual(f.scope.ikStateRef.current.pinResiduals.get(pin.id), residuals);
	const updated = { ...pin, endFrame: 7 };
	apply(updated);
	assert.equal(f.scope.ikStateRef.current.keys.get(7).get('leftFoot').pin, pin.id);
	assert.equal(f.motion.documentStore.depths().past, 2, 'each command records exactly one undo entry');
	assert.ok(app.nextStoreHistory(false).stepHistory(false));
	assert.deepEqual(f.scope.ikStateRef.current.pins.get(pin.id), pin);
	assert.equal(f.scope.ikStateRef.current.keys.has(7), false);
	const removed = f.run('motion.rangePin.remove', { characterId: 'actor-a', pinId: pin.id });
	assert.equal(removed.ok, true, JSON.stringify(removed));
	assert.equal(removed.undo.entries, 1);
	assert.equal(f.renderMotion().rangePins.length, 0, 'deletion clears the panel and projected keys');
	assert.ok(app.nextStoreHistory(false).stepHistory(false), 'deletion is undoable');
	assert.deepEqual(f.scope.ikStateRef.current.pins.get(pin.id), pin);
	console.log('PASS range pin document projection, key ownership, undo, redo and deletion');
} finally { f.dispose(); }
