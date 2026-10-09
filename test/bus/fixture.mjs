import { createStudioActionRegistry, studioActionDeclaration } from '../../src/studio-actions.js';
import { createStudioCommandJournal } from '../../src/studio-agent-commands.js';
import { createHistory, pushHistory, undoHistory } from '../../src/history.js';
import { createCommandBus } from '../../src/command-bus.js';

export const host = { workspaceId: 'workspace', documentEpoch: 'document', sceneId: 'scene', sceneEpoch: 'epoch' };
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    const timer = setTimeout(() => no(new Error('Expected bus test signal did not arrive.')), 5000);
    resolve = value => { clearTimeout(timer); yes(value); };
    reject = error => { clearTimeout(timer); no(error); };
  });
  return { promise, resolve, reject };
};
export function fixture(entries = []) {
  let state = { host, revision: 0, domainRevisions: { shot: 0, cast: 0, objects: 0, motion: 0 }, tokens: { target: 'target-1' }, busy: false, value: 0 };
  let history = createHistory({ value: 0, id: null });
  let sink = null;
  const registry = createStudioActionRegistry({ readState: () => state });
  const receipts = new Map();
  const ports = {
    read: () => state,
    isRetained: r => Boolean(r?.undo && [...history.past, history.present, ...history.future].some(e => e.id === r.undo.historyEntryId)),
    canUndo: r => history.present.id === r.undo?.historyEntryId,
    undo: () => { history = undoHistory(history); state = { ...state, value: history.present.value, revision: state.revision + 1 }; },
    remember: r => { if (r.receiptId) receipts.set(r.receiptId, r); },
    receipt: id => receipts.get(id),
    captureToasts: listener => { const previous = sink; sink = listener; return () => { sink = previous; }; },
    readTarget: id => state.tokens[id],
    recordAction(domain, run) {
      const before = state.value;
      const finish = result => {
        const historyEntryId = before === state.value ? null : crypto.randomUUID();
        if (historyEntryId) history = pushHistory(history, { value: state.value, id: historyEntryId });
        return { result, historyEntryId };
      };
      const result = run();
      return result?.then ? result.then(finish) : finish(result);
    },
  };
  const journal = createStudioCommandJournal({ host, isRetained: ports.isRetained });
  ports.journal = () => journal;
  const f = { registry, ports, journal, receipts, get state() { return state; }, get history() { return history; },
    edit(value, domain = 'shot') { state = { ...state, value, revision: state.revision + 1, domainRevisions: { ...state.domainRevisions, [domain]: state.domainRevisions[domain] + 1 } }; },
    patch(patch) { state = { ...state, ...patch }; },
    toast(message, uiMessage = message) { sink?.({ message, uiMessage }); },
    request(origin = 'agent', extra = {}) { return { origin, commandId: crypto.randomUUID(), host, expectedRevision: state.revision, ...extra }; },
    register(id, run, overrides = {}) { registry.register({ ...studioActionDeclaration(id), available: () => true, run, ...overrides }); },
  };
  for (const entry of entries) registry.register(entry);
  f.bus = createCommandBus({ registry, ports });
  return f;
}
export const result = (affectedIds = ['target']) => ({ affectedIds, summary: 'Fixture action.' });
export function sample(schema) {
  if (schema.oneOf) return sample(schema.oneOf[0]);
  if (schema.enum) return schema.enum[0];
  if (schema.type === 'object') return Object.fromEntries(schema.required.map(key => [key, sample(schema.properties[key])]));
  if (schema.type === 'array') return Array.from({ length: schema.minItems ?? 0 }, () => sample(schema.items));
  if (schema.type === 'integer' || schema.type === 'number') return schema.minimum ?? 1;
  if (schema.type === 'boolean') return false;
  return schema.pattern?.startsWith('^(data:') ? 'data:image/png;base64,AAAA' : 'target';
}
