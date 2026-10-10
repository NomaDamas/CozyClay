// Manual surface gate: COZYCLAY_LIVE_PORT=5752 node test/bus/generation-browser-smoke.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { startLiveHub } from '../../mcp/live-hub.mjs';
import { createAgentHandler } from '../../bin/agent/agent-routes.mjs';
import { createSessionStore } from '../../bin/agent/session-store.mjs';
import { createFakeModel } from '../fixtures/fake-model.mjs';
import { motionArraysToNpzMembers, writeNpz } from '../../tools/ardy/npz.mjs';
import { CSKEL27_NEUTRAL } from '../../src/ardy/cskel27-neutral.js';
import { createSceneDocument, SCENES_STORAGE_KEY } from '../../src/scenes.js';
const document = createSceneDocument(), character = document.scenes[0].stage.characters[0];
character.layer.promptClips = [{ id: 'walk', startFrame: 0, endFrame: 48, text: 'Walk forward' }, { id: 'stop', startFrame: 48, endFrame: 96, text: 'Stop' }];
character.layer.waypoints = [{ id: 'path', frame: 72, x: character.x, z: character.z + 3, heading: null }];
const requests = [];
const profile = mkdtempSync(join(tmpdir(), 'generation-browser-'));
const frames = 96, rotMats = new Float32Array(frames * 243), rootPos = new Float32Array(frames * 3), posedJoints = new Float32Array(frames * 81);
for (let f = 0; f < frames; f++) for (let j = 0; j < 27; j++) {
  rotMats.set([1,0,0,0,1,0,0,0,1], (f * 27 + j) * 9);
  const p = CSKEL27_NEUTRAL[j]; posedJoints.set([p[0], p[1] + 1.3544128 - 0.05, p[2]], (f * 27 + j) * 3);
  if (j === 0) rootPos.set(posedJoints.subarray(f * 81, f * 81 + 3), f * 3);
}
const npz = join(profile, 'take.npz'); writeNpz(npz, motionArraysToNpzMembers({ frames, fps: 24, rotMats, rootPos, posedJoints }));
const bytes = readFileSync(npz);
assert.ok(process.env.COZYCLAY_LIVE_PORT, 'set the dedicated live port explicitly');
const port = Number(process.env.QA_PORT ?? 5232), origin = `http://127.0.0.1:${port}`;
const hub = await startLiveHub(Number(process.env.COZYCLAY_LIVE_PORT)); assert.ok(hub, 'dedicated live port must be available');
const connected = Promise.withResolvers(); hub.onWorkspaceConnected = connected.resolve;
const faux = createFakeModel();
const handler = createAgentHandler({ auth: { getAccessToken: async () => 'browser-fixture' }, models: faux.models, fauxProvider: faux.fauxProvider,
  liveHub: hub, handlers: [], sessionStore: createSessionStore(join(profile, 'sessions')), port });
const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, hmr: false }, plugins: [{ name: 'qa-generation-bridge', enforce: 'pre', configureServer(server) {
  server.middlewares.use((req, res, next) => {
    if (req.url.startsWith('/agent/')) { void handler(req, res).catch(error => { res.statusCode = 500; res.end(error.stack); }); }
    else if (req.url === '/ardy/health') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, backend: 'local_kimodo', host: 'fixture', device: 'cpu' })); }
    else if (req.url === '/ardy/generate') {
      let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
        requests.push(JSON.parse(body)); res.setHeader('Content-Type', 'application/x-ndjson'); res.end(JSON.stringify({ event: 'done', motionUrl: '/ardy/motions/123456-abcdef' }) + '\n');
      });
    } else if (req.url === '/ardy/motions/123456-abcdef') { res.setHeader('Content-Type', 'application/octet-stream'); res.end(bytes); }
    else next();
  });
} }] });
let chrome, ws, sequence = 0, sessionId;
const pending = new Map(), pageErrors = [];
function bounded(promise, label, ms = 30000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: ${pageErrors.join('; ')}`)), ms); })]).finally(() => clearTimeout(timer));
}
const send = (method, params = {}, browser = false) => bounded(new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, ...(!browser && sessionId ? { sessionId } : {}) }));
}), method);
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
// Subscribe to the exact React DOM / QA-state publication before the gesture.
async function transition(condition, action = '') {
  return evaluate(`new Promise((resolve,reject) => {
    let timer; const cleanup = () => { observer.disconnect(); window.removeEventListener('motion-qa-state', check); clearTimeout(timer); };
    const check = () => { if (${condition}) { cleanup(); resolve(true); } };
    const observer = new MutationObserver(check); observer.observe(document, { childList:true, subtree:true, attributes:true, characterData:true });
    window.addEventListener('motion-qa-state', check);
    timer = setTimeout(() => { cleanup(); reject(new Error('Surface transition deadline: ' + ${JSON.stringify(condition)})); }, 20000);
    ${action}; check();
  })`);
}
try {
  await server.listen();
  chrome = spawn(process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1600,1100', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await bounded(new Promise((resolve, reject) => {
    let output = ''; chrome.stderr.on('data', data => { output += data; const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) resolve(match[1]); });
    chrome.once('error', reject); chrome.once('exit', code => reject(new Error(`Chrome exited ${code}`)));
  }), 'Chrome ready');
  ws = new WebSocket(endpoint);
  await bounded(new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); }), 'CDP connected');
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') { const error = message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text; pageErrors.push(error); console.error(error); }
    const result = pending.get(message.id); if (!result) return; pending.delete(message.id);
    if (message.error) result.reject(new Error(JSON.stringify(message.error))); else result.resolve(message.result);
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, true);
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, true));
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem(${JSON.stringify(SCENES_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(document))}); localStorage.setItem('cozyclay.project-session.v1', JSON.stringify({name:'Motion QA',updatedAt:Date.now()})); localStorage.setItem('cozyclay.camera-tutorial-terminal.v1',JSON.stringify({completed:true})); let qa; Object.defineProperty(window, '__cozyclay', {configurable:true,get:()=>qa,set:value=>{qa=value;window.dispatchEvent(new Event('motion-qa-state'));}});` });
  const loaded = bounded(new Promise(resolve => {
    const listener = event => { const message = JSON.parse(event.data); if (message.method === 'Page.loadEventFired' && message.sessionId === sessionId) { ws.removeEventListener('message', listener); resolve(); } }; ws.addEventListener('message', listener);
  }), 'Page load');
  await send('Page.navigate', { url: origin + '/app/' }); await loaded;
  await bounded(connected.promise, 'live editor handshake');
  await transition(`window.__cozyclay?.rigA && [...document.querySelectorAll('.foldout-title')].some(node => node.textContent === 'Prompt Blocks')`);
  await transition(`document.querySelector('[data-testid=topbar-generate]') && !document.querySelector('[data-testid=topbar-generate]').dataset.disabledReason`);
  await transition(`window.__cozyclay.motion?.frames === 96`, `document.querySelector('[data-testid=topbar-generate]').click()`);
  assert.equal(requests.length, 1); assert.equal(requests[0].segments.length, 2); assert.equal(requests[0].waypoints.at(-1).frame, 72);
  console.log('PASS browser generation: the top-bar Generate Motion button sends segments and root path and installs a take');
  await transition(`!window.__cozyclay.motion`, `window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',code:'KeyZ',metaKey:true,bubbles:true}))`);
  console.log('PASS browser generation: one keyboard undo removes the generated take');
  const receipt = await evaluate(`window.__cozyclay.runArdy({promptOverride:'Walk forward',durationOverride:4})`);
  assert.equal(receipt.ok, true, JSON.stringify(receipt)); assert.equal(receipt.action, 'motion.generate');
  await transition(`window.__cozyclay.motion?.frames === 96`);
  assert.equal(requests.length, 2); assert.ok(requests[1].waypoints.length);
  console.log('PASS browser generation: the Generate entry calls motion.generate through the same pipeline');
  await transition(`!window.__cozyclay.motion`, `window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',code:'KeyZ',metaKey:true,bubbles:true}))`);
  // The actual agent route uses the connected browser's bus, not an SSR or
  // candidate stub. Verification samples its installed real rig over the clip.
  const session = crypto.randomUUID(); let cookie;
  async function turn(steps) {
    faux.script([...steps, { type: 'text', text: 'Reported' }]);
    const { host } = await hub.command('inspect_studio', { scope: 'scene' }, hub.workspaceHandles[0]);
    const read = await hub.command('read_studio_context', { host }, hub.workspaceHandles[0]); const context = read?.context ?? read;
    const response = await fetch(origin + '/agent/turn', { method: 'POST', headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ surface: 'studio', sessionId: session, turnId: crypto.randomUUID(), text: 'Check this take', context }), signal: AbortSignal.timeout(90000) });
    assert.equal(response.status, 200); cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
    const events = [...(await response.text()).matchAll(/^data: (.+)$/gm)].map(match => JSON.parse(match[1]));
    assert.equal(events.some(event => event.type === 'error'), false, JSON.stringify(events));
    const done = events.filter(event => event.type === 'tool.done');
    assert.ok(done.every(event => event.ok), JSON.stringify(done)); return done.map(event => event.result);
  }
  const tool = (name, args) => ({ type: 'toolCall', id: crypto.randomUUID(), name, arguments: args });
  const results = await turn([
    tool('generate_motion', { characterId: character.id, source: { kind: 'generate', beats: [{ text: 'Walk forward' }, { text: 'Stop' }], durationSeconds: 4, seed: 17 } }),
    tool('verify_result', { targets: [character.id], checks: ['motion'], visual: 'none' }),
    tool('run_action', { action: 'motion.autoPhysics', args: { characterId: character.id, apply: false } }),
    tool('run_action', { action: 'motion.fixCollisions', args: { characterId: character.id, scope: 'frame' } }),
  ]);
  assert.equal(results[0].action, 'motion.generate'); assert.equal(results[0].status, 'completed'); assert.ok(results[0].undo.historyEntryId);
  assert.equal(results[1].verification.evaluatedFrames, 96); assert.deepEqual(results[1].unsupportedChecks, []);
  assert.equal(results[1].verification.status, 'unverified');
  assert.equal(results[2].status, 'completed'); assert.equal(results[3].ok, true);
  assert.equal(requests.length, 3); assert.equal(requests[2].waypoints.at(-1).frame, 72);
  const installedShot = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync('/tmp/452-agent-installed.png', Buffer.from(installedShot.data, 'base64'));
  const undo = [];
  if (results[3].undo) undo.push(tool('run_action', { action: 'edit.undo', args: { receiptId: results[3].receiptId } }));
  undo.push(tool('run_action', { action: 'edit.undo', args: { receiptId: results[0].receiptId } }));
  assert.ok((await turn(undo)).every(receipt => receipt.status === 'undone'));
  await transition(`!window.__cozyclay.motion`);
  console.log('PASS browser agent: HTTP/SSE -> live editor motion.generate -> verify_result -> AutoPhysics/collision actions -> edit.undo');
  const screenshot = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync('/tmp/452-generation-browser.png', Buffer.from(screenshot.data, 'base64'));
  assert.deepEqual(pageErrors, []);
  console.log('PASS browser generation smoke: no runtime exceptions; screenshots /tmp/452-agent-installed.png and /tmp/452-generation-browser.png');
} catch (error) {
  if (sessionId) { const screenshot = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync('/tmp/452-generation-browser-failure.png', Buffer.from(screenshot.data, 'base64')); }
  throw error;
} finally {
  ws?.close();
  if (chrome && chrome.exitCode === null) { const exited = new Promise(resolve => chrome.once('exit', resolve)); chrome.kill('SIGTERM'); await bounded(exited, 'Chrome cleanup'); }
  await handler.close(); await server.close(); rmSync(profile, { recursive: true, force: true });
}
