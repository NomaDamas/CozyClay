import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appFixture } from './app-fixture.mjs';

test('#495.2: operate_studio and registered view/timeline commands replay identical bus receipts', () => {
  const f = appFixture();
  Object.assign(f.actionHandlers.current, { readView: f.actual.readStudioState, publishView: f.actual.operateStudio });
  try {
    const cases = [
      ['view.select', { selection: { kind: 'character', id: 'actor-b' } }],
      ['timeline.seek', { frame: 12 }], ['timeline.play', { playing: true }],
      ['view.setMode', { mode: 'motion', view: { grid: true } }],
      ['view.update', { selection: null, frame: 3, playing: false, mode: 'camera' }],
    ];
    for (const [action, args] of cases) {
      assert.ok(f.registry.ids().includes(action), `${action} must be registered`);
      const request = f.request('operate_studio', args);
      const alias = f.binding.handlers.operate_studio(request);
      assert.equal(alias.ok, true, JSON.stringify(alias));
      assert.equal(alias.action, action); assert.equal(alias.status, 'transient');
      assert.equal(alias.authored, false); assert.equal(alias.undo, null);
      assert.deepEqual(alias.revision, { before: request.expectedRevision, after: request.expectedRevision });
      assert.deepEqual(alias.delta[0].after.view, f.binding.refresh().view);
      const direct = f.binding.handlers.run_action({ ...request, name: 'run_action', args: { action, args } });
      assert.deepEqual(direct, alias, 'the same bus invocation must replay byte-for-byte across both doors');
    }
    const before = structuredClone(f.binding.refresh().view);
    const refused = f.binding.handlers.operate_studio(f.request('operate_studio', { frame: 999, selection: { kind: 'character', id: 'actor-a' } }));
    assert.equal(refused.code, 'INVALID_RANGE');
    assert.deepEqual(f.binding.refresh().view, before);
    assert.equal(f.binding.refresh().activeCharacterId, 'actor-b', 'invalid bundled requests publish no partial selection');
  } finally { f.dispose(); }
});

test('#495.2: view readback retains scene/project fields alongside transient state', () => {
  const f = appFixture(), domains = f.ports.storeDomains();
  f.ports.storeDomains = () => [...domains, { document: () => ({ scenes: [{ id: 'scene', name: 'Scene name', order: 0 }], project: { name: 'Project name' } }) }];
  try {
    const receipt = f.binding.handlers.operate_studio(f.request('operate_studio', { frame: 4 }));
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    const after = receipt.delta[0].after;
    assert.equal(after.view.frame, 4);
    assert.deepEqual(after.patched.filter(row => ['scene.name', 'project.name'].includes(row.path)), [
      { path: 'scene.name', text: 'Scene name' }, { path: 'project.name', text: 'Project name' },
    ]);
  } finally { f.dispose(); }
});
