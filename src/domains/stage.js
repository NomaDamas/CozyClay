import { useContext, useEffect, useRef, useState } from 'react';
import { AppContext } from '../app-context.js';
import { createSceneStageStore } from '../store/scene-stage.js';
import { useDocumentDomain } from '../store/use-document-store.js';
import { createKeyLight } from '../scenes.js';
import { shotAspectRatio } from '../shot.js';
import { normalizeStage } from '../commands/stage.js';

// The facade composes this store's sessions with the other document owners.
export function createStageDomain(appContext) {
  const documentStore = createSceneStageStore(normalizeStage(appContext.shared.startupStage));
  const read = () => documentStore.read('stage');
  const publish = () => {
    if (appContext.live.state) appContext.patchLive({ stage: { ...appContext.live.state.stage, ...read() },
      filmback: { sensorId: read().sensorId, aspectRatio: shotAspectRatio(read().shotAspect) } });
    const persisted = appContext.shared.actorStageRef;
    if (persisted?.current) persisted.current = { ...persisted.current, ...read() };
  };
  const release = documentStore.subscribe(publish);
  function beginAction() { return documentStore.beginAction('stage'); }
  function recordAction(fn) {
    const session = beginAction();
    try { const result = session.run(fn); return { result, ...session.commit() }; }
    catch (error) { session.cancel(); throw error; }
  }
  function write(value) {
    return documentStore.write('stage', before => {
      const next = normalizeStage(typeof value === 'function' ? value(before) : value);
      return JSON.stringify(before) === JSON.stringify(next) ? before : next;
    });
  }
  const canUndo = id => documentStore.canUndo(id);
  function stepHistory(redo) { return Boolean((redo ? documentStore.redo : documentStore.undo)()); }
  const setters = Object.fromEntries(Object.entries({ 'setKeyLight': 'keyLight', 'setEnvironmentImage': 'environmentImage', 'setEnvironment': 'environment',
    'setStyle': 'style', 'setHasEnvSheet': 'hasEnvSheet', 'setShotAspectKey': 'shotAspect', 'setCameraPresetId': 'cameraPresetId', 'setSensorFormat': 'sensorId' })
    .map(([name, key]) => [name, value => write(before => ({ ...before, [key]: typeof value === 'function' ? value(before[key]) : value }))]));
  const document = () => ({ stage: { ...appContext.shared.actorStageRef.current, ...read() } });
  const domain = { documentStore, document, read, write, beginAction, recordAction, canUndo, stepHistory, ...setters,
    publish: state => write(state.stage), commitDraft: write,
    load(stage) { documentStore.load(normalizeStage(stage)); },
    dispose() { unregister(); release(); documentStore.dispose(); },
  };
  const unregister = appContext.registerStoreDomain('stage', domain);
  return domain;
}

export function useStageTransaction() {
  const app = useContext(AppContext), session = useRef(null);
  const run = (...args) => {
    const receipt = app.bus.run(...args);
    if (!receipt.ok) app.notify(receipt.message);
    return receipt;
  };
  function finish(cancel = false) {
    if (!session.current) return;
    const { txId } = session.current;
    session.current = null;
    return run(cancel ? 'run.cancel' : 'run.commit', { txId });
  }
  function begin(id) {
    if (session.current?.id !== id) finish();
    if (!session.current) {
      const receipt = run('run.begin', { id, args: {} });
      if (receipt.ok) session.current = { id, txId: receipt.txId };
    }
    return session.current?.txId;
  }
  useEffect(() => () => { if (session.current) app.bus.run('run.cancel', { txId: session.current.txId }); }, [app]);
  return { run, begin, commit: () => finish(), cancel: () => finish(true) };
}

export function useStage(appContext) {
  const [domain] = useState(() => createStageDomain(appContext));
  const stage = useDocumentDomain(domain.documentStore, 'stage');
  const [preset, setPreset] = useState('medium');
  const gesture = useRef(null);
  function finishGesture() {
    if (!gesture.current) return;
    const txId = gesture.current; gesture.current = null;
    return appContext.bus.run('run.commit', { txId });
  }
  function changeKeyLight(_gesture, patch) {
    const keyLight = domain.read().keyLight;
    if (!gesture.current) gesture.current = appContext.bus.run('run.begin', { id: 'stage.setKeyLight', args: {} }).txId;
    return appContext.bus.run('run.update', { txId: gesture.current, args: { keyLight: typeof patch === 'function' ? patch(keyLight) : patch } });
  }
  function resetKeyLight() { return appContext.bus.run('stage.setKeyLight', { keyLight: createKeyLight(null) }); }
  function changeEnvironmentImage(environmentImage) { return appContext.bus.run('stage.setEnvironment', { environmentImage }); }
  function publishStudioStage(stage) {
    return appContext.storeDomain('stage').write(stage);
  }
  return { ...domain, ...stage, shotAspectKey: stage.shotAspect, preset, setPreset, changeKeyLight, resetKeyLight, changeEnvironmentImage, finishGesture, publishStudioStage };
}
