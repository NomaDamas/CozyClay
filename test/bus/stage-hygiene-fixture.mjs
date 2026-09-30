import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useStage } from '../../src/domains/stage.js';
import { createSceneStage } from '../../src/scenes.js';
import { createCommandBus } from '../../src/command-bus.js';
import { createStudioActionRegistry } from '../../src/studio-actions.js';
import { createStudioCommandJournal } from '../../src/studio-agent-commands.js';
import { register } from '../../src/commands/stage.js';

// The old hygiene suite still drives the same UI handlers, but stage assertions
// now observe the real owned store alongside its existing native cast fixture.
export function attachStageHistory(scope) {
  const fields = ['keyLight', 'environmentImage', 'environment', 'style', 'hasEnvSheet'];
  scope.startupStage = createSceneStage(Object.fromEntries(fields.map(key => [key, scope[key]])));
  scope.actorStageRef = { current: scope.startupStage };
  scope.objects = scope.store.objects;
  scope.appContext.publishLive({ stage: scope.startupStage, objects: scope.objects });
  let domain, bus;
  Object.defineProperty(scope.appContext, 'bus', { get: () => bus });
  function Mount() { domain = useStage(scope.appContext); return null; }
  renderToStaticMarkup(createElement(Mount));
  Object.assign(scope, domain);
  for (const field of fields) Object.defineProperty(scope, field, { configurable: true, get: () => domain.read()[field] });
  const host = { workspaceId: 'workspace', documentEpoch: 'document', sceneId: 'scene', sceneEpoch: 'epoch' };
  const registry = createStudioActionRegistry();
  register(registry, { ...scope.appContext.actionPorts, state: () => ({ activeSceneId: host.sceneId }) });
  const journal = createStudioCommandJournal({ host }), receipts = new Map();
  bus = createCommandBus({ registry, ports: {
    read: () => ({ host, revision: domain.documentStore.getSnapshot().revision }), journal: () => journal,
    recordAction: (_kind, fn) => scope.appContext.recordAction('stage', fn), beginAction: () => domain.beginAction(),
    remember: receipt => receipts.set(receipt.receiptId, receipt), receipt: id => receipts.get(id),
    history: redo => scope.appContext.historyEntry(redo),
    isRetained: receipt => Boolean(scope.appContext.storeDomainForReceipt(receipt)),
    canUndo: receipt => scope.appContext.historyEntry() === receipt.undo?.historyEntryId,
    undo: () => domain.stepHistory(false), redo: () => domain.stepHistory(true), finishHistoryGesture: domain.finishGesture,
  } });
  scope.run = (...args) => bus.run(...args);
  scope.studioBindingRef.current = { stepHistory: domain.stepHistory };
}
