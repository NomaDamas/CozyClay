import assert from 'node:assert/strict';
import { TRANSIENT_WRITERS } from './verify-bus-coverage.mjs';
import { projectFixture, ok } from './project-fixture.mjs';
import { motionFixture } from './motion-fixture.mjs';

const f = projectFixture();
try {
  const app = f.scope.appContext;
  Object.assign(f.actionHandlers.current, { readView: f.actual.readStudioState, publishView: f.actual.operateStudio });
  const before = f.project.collectProjectSnapshot('Heist'), clock = app.undoClock;
  ok(f.run('view.select', { selection: { kind: 'character', id: 'actor-b' } }, 'agent'));
  app.notify('transient-feedback-496');
  const sentinel = 'transient-state-must-not-be-saved-496';
  // Populate the same render/live/save envelopes the real serializer reads.
  // Guard both the setter names and the state fields, including nested leakage.
  for (const [setter, state] of Object.entries(TRANSIENT_WRITERS)) {
    f.scope[state] = sentinel;
    f.scope.projectStateRef.current[state] = sentinel;
    app.patchLive({ [state]: sentinel });
  }
  const serialized = await f.project.collectProjectSerialized('Heist');
  const forbidden = new Set([...Object.keys(TRANSIENT_WRITERS), ...Object.values(TRANSIENT_WRITERS)]);
  const check = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbidden.has(key), false, `${key} must never enter the saved project document`);
      check(child);
    }
  };
  check(JSON.parse(serialized));
  assert.equal(serialized.includes(sentinel), false);
  assert.equal(f.project.collectProjectSnapshot('Heist'), before);
  assert.equal(app.undoClock, clock, 'selection and feedback never author an undo entry');
  console.log('PASS #496 transient writer names and state are absent from the saved project');
} finally { f.dispose(); }

const m = motionFixture();
try {
  const app = m.scope.appContext, before = m.snapshot(), clock = app.undoClock;
  const patches = [], owner = app.storeDomain('motion'), apply = owner.setVideoDraft;
  owner.setVideoDraft = patch => { patches.push(patch); return apply(patch); };
  const patch = { instruction: 'Uncommitted draft', promptOverride: 'Draft override', duration: 10 };
  const receipt = ok(m.run('motion.setVideoDraft', patch, 'agent'));
  assert.deepEqual(patches, [patch], 'the agent reaches the real hook setter');
  assert.equal(receipt.status, 'transient');
  assert.equal(receipt.authored, false); assert.equal(receipt.undo, null);
  assert.equal(receipt.revision.before, receipt.revision.after);
  assert.deepEqual(m.snapshot(), before); assert.equal(app.undoClock, clock);
  assert.equal(m.run('motion.setVideoDraft', { duration: 3 }, 'agent').ok, false);
  assert.equal(m.run('motion.setVideoDraft', { job: {} }, 'agent').ok, false, 'job output is not an editable draft field');
  console.log('PASS #496 video draft is a schema-checked transient command without document history');
} finally { m.dispose(); }
