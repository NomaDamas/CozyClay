import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAppContext } from '../../src/app-context.js';
import { createDocumentStore } from '../../src/document-store.js';

// Real document owners and facade composition, with no usable native clock or
// snapshot stack. The App/binding integration is covered alongside this seam.
function fixture() {
  const forbidden = { get current() { throw new Error('native arbitration must not be read'); }, set current(_) { throw new Error('native arbitration must not be written'); } };
  const app = createAppContext({ clock: forbidden, history: forbidden, objectClock: forbidden });
  const domains = new Map();
  for (const name of ['objects', 'cast', 'shot', 'motion', 'stage']) {
    const store = createDocumentStore({ owned: { [name]: { value: 0 } } });
    const domain = { documentStore: store, beginAction: () => store.beginAction(name),
      canUndo: id => store.canUndo(id), stepHistory: redo => Boolean((redo ? store.redo : store.undo)()) };
    app.registerStoreDomain(name, domain); domains.set(name, domain);
  }
  const snapshot = () => Object.fromEntries([...domains].map(([name, domain]) => [name, domain.documentStore.read(name)]));
  const write = (name, value) => app.recordAction(name, () => domains.get(name).documentStore.write(name, { value }));
  return { app, domains, snapshot, write };
}

test('#494.1 all five owners undo/redo in exact order without native arbitration', () => {
  const f = fixture(), snapshots = [f.snapshot()];
  for (const [name, value] of [['objects', 1], ['cast', 1], ['shot', 1], ['motion', 1], ['stage', 1], ['objects', 2], ['motion', 2], ['cast', 2]]) {
    f.write(name, value); snapshots.push(f.snapshot());
  }
  for (let i = snapshots.length - 2; i >= 0; i--) {
    assert.equal(f.app.nextStoreHistory(false)?.stepHistory(false), true);
    assert.deepEqual(f.snapshot(), snapshots[i], `undo ${i}`);
  }
  assert.equal(f.app.nextStoreHistory(false), undefined);
  for (let i = 1; i < snapshots.length; i++) {
    assert.equal(f.app.nextStoreHistory(true)?.stepHistory(true), true);
    assert.deepEqual(f.snapshot(), snapshots[i], `redo ${i}`);
  }
  assert.equal(f.app.nextStoreHistory(true), undefined);
});

test('#494.1 a new owner edit discards the entire redo branch; cancelled/noop edits do not', () => {
  const f = fixture();
  f.write('objects', 1); f.write('cast', 1);
  f.app.nextStoreHistory(false).stepHistory(false);
  const tx = f.app.beginAction('stage');
  tx.run(() => f.domains.get('stage').documentStore.write('stage', { value: 9 })); tx.cancel();
  f.app.recordAction('stage', () => {});
  assert.ok(f.app.nextStoreHistory(true));
  f.write('motion', 1);
  assert.equal(f.app.nextStoreHistory(true), undefined);
  f.app.nextStoreHistory(false).stepHistory(false);
  f.app.nextStoreHistory(false).stepHistory(false);
  f.app.nextStoreHistory(true).stepHistory(true);
  f.app.nextStoreHistory(true).stepHistory(true);
  assert.equal(f.app.nextStoreHistory(true), undefined);
  assert.equal(f.snapshot().cast.value, 0, 'an abandoned cast future cannot reappear');
});

test('#494.1 composition stays atomic and partial expiry never permits a surviving member undo', () => {
  const f = fixture(), before = f.snapshot();
  const group = f.app.recordAction('shot', () => {
    f.domains.get('shot').documentStore.write('shot', { value: 1 });
    f.write('objects', 1);
    f.write('motion', 1);
  });
  const receipt = { undo: { historyEntryId: group.historyEntryId } }, after = f.snapshot();
  assert.ok(f.app.storeDomainForReceipt(receipt));
  f.app.nextStoreHistory(false).stepHistory(false); assert.deepEqual(f.snapshot(), before);
  f.app.nextStoreHistory(true).stepHistory(true); assert.deepEqual(f.snapshot(), after);
  for (let i = 2; i <= 53; i++) f.write('objects', i);
  assert.equal(f.app.storeDomainForReceipt(receipt), undefined);
  while (f.app.nextStoreHistory(false)) f.app.nextStoreHistory(false).stepHistory(false);
  assert.equal(f.snapshot().shot.value, 1, 'the expired group cannot split');
  assert.equal(f.snapshot().motion.value, 1, 'all surviving members remain behind the boundary');
});

test('#494.1 an expired newer transition blocks older owners instead of skipping history', () => {
  const f = fixture();
  f.write('cast', 1);
  for (let i = 1; i <= 52; i++) f.write('objects', i);
  for (let i = 0; i < 50; i++) assert.equal(f.app.nextStoreHistory(false)?.stepHistory(false), true);
  assert.equal(f.snapshot().objects.value, 2);
  assert.equal(f.app.nextStoreHistory(false), undefined, 'the object pre-image has expired; do not skip to older cast history');
  assert.equal(f.snapshot().cast.value, 1);
  assert.equal(f.app.nextStoreHistory(true)?.stepHistory(true), true, 'expiry does not block retained redo');
  assert.equal(f.snapshot().objects.value, 3);
});
