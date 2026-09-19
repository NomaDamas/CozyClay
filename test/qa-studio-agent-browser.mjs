#!/usr/bin/env node
/** Real panel -> HTTP/SSE -> job -> LiveHub -> editor -> native Undo acceptance.
 * Requires Playwright (PLAYWRIGHT_MODULE may point to an installed index.mjs).
 * Fixture-only requires recorded real-service probes; no model/GPU/semantic claim.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { startFixtureStudio, bounded, released, sceneDocument } from './fixtures/studio-agent-motion.mjs';
const cases = ['binding','intent','framing','motion','resilience','responsive'];
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--case' || !cases.includes(args[1]))) { console.error(`Unknown case; expected ${cases.join(', ')}`); process.exit(2); }
const selected = args.length ? [args[1]] : cases;
const evidence = process.env.QA_SHOT_DIR || '.omo/ulw-execute/task-8/evidence/fixed-trunk/browser';
mkdirSync(evidence, { recursive: true });
const probes = JSON.parse(readFileSync(process.env.QA_PROBES || '.omo/ulw-execute/task-8/evidence/fixed-trunk/backend-probes.json'));
assert(probes.probes.some(p => p.path === '/oauth/status') && probes.probes.some(p => p.path === '/ardy/health'));
assert(probes.probes.some(p => p.path === '/ardy/health' && (p.status !== 200 || !p.body.ok)), 'Healthy real backend: run live acceptance, do not substitute fixtures');
console.log(`MODE ${process.env.QA_REAL_MODEL === '1' ? 'real-model-fixture-generator' : 'scripted-model-fixture-generator'}; real generator unavailable`, JSON.stringify(probes));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const port = Number(process.env.QA_PORT || 5276), cdp = Number(process.env.CDP_PORT || 9476);
await released(cdp);
const fixture = await startFixtureStudio({ port, evidence });
let browser, page;
const log = [], results = [];
const save = (name, value) => writeFileSync(`${evidence}/${name}.json`, JSON.stringify(value, null, 2));
const state = async () => {
  const r = await fixture.read();
  return { objects: r.objects, characters: r.characters, shots: r.shots, camera: r.camera, takes: r.context.entities.filter(e => e.kind === 'character').map(e => ({ id: e.id, ...e.motion })).sort((a,b)=>a.id.localeCompare(b.id)) };
};
const shot = async name => { await page.screenshot({ path: `${evidence}/${name}.png` }); console.log('SCREENSHOT', `${evidence}/${name}.png`); };
// Register in-page event listeners BEFORE the triggering action. No timer polling.
async function gate(predicate, trigger = async () => {}) {
  await page.evaluate(({ predicate, origin }) => {
    window.__qaGate = new Promise((resolve, reject) => {
      let active = true;
      const cleanup = () => { active = false; clearTimeout(timer); observer.disconnect(); window.removeEventListener('qa:render', check); };
      const check = async () => {
        try {
          const current = predicate.startsWith('STATE:') ? await (await fetch(origin+'/qa/read')).json() : null;
          const expression = predicate.replace(/^STATE:/, '');
          if (active && Function('current', `return (${expression})`)(current)) { cleanup(); resolve(true); }
        } catch (error) { cleanup(); reject(error); }
      };
      const observer = new MutationObserver(check), timer = setTimeout(() => { cleanup(); reject(Error('Event gate deadline: '+predicate)); }, 45000);
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); window.addEventListener('qa:render', check); check();
    });
    window.__qaGate.catch(() => {}); // Awaited explicitly below; prevent browser unhandled-rejection noise.
  }, { predicate, origin: fixture.origin });
  await trigger(); await page.evaluate(() => window.__qaGate);
}
async function open() {
  if (await page.locator('.studio-agent-inspector').getAttribute('hidden') !== null) {
    await page.locator('.view-menu-trigger').click();
    await gate("!document.querySelector('.studio-agent-inspector').hidden", () => page.locator('.view-menu .agent-panel-toggle').click());
    await page.locator('.view-menu-trigger').click();
  }
  await gate("!!document.querySelector('[aria-label=\"Message the agent\"]') && !document.querySelector('[aria-label=\"Message the agent\"]').disabled");
  const layout = await page.evaluate(() => {
    const i = document.querySelector('.inspector-sidebar').getBoundingClientRect(), a = document.querySelector('.studio-agent-inspector').getBoundingClientRect();
    return { width: a.width, left: a.left, right: a.right, inspectorLeft: i.left, inspectorRight: i.right };
  });
  assert(layout.width > 0 && layout.left >= layout.inspectorLeft && layout.right <= layout.inspectorRight+1);
}
async function turn(text, interleave, stopped = false) {
  const before = fixture.actions.length;
  const response = page.waitForResponse(r => r.url().endsWith('/agent/turn') && r.request().method() === 'POST');
  await page.getByLabel('Message the agent', { exact: true }).fill(text); await page.getByLabel('Message the agent', { exact: true }).press('Enter');
  const http = await response; assert.equal(http.status(), 200);
  if (interleave) await interleave();
  const request = http.request().postDataJSON();
  // Stop deliberately aborts the original browser fetch; read its retained route events.
  const body = stopped ? await page.evaluate(async id => { const r=await fetch(`/agent/turn/${id}/events?after=0`); if(!r.ok) throw Error(`Replay HTTP ${r.status}`); return r.text(); }, request.turnId) : await bounded(http.text(), 'SSE terminal');
  const stream = body.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
  assert(stream.some(e => e.type === 'done'), 'terminal SSE required');
  await gate("!document.querySelector('.agent-send.stop')");
  const value = { stream, commands: fixture.actions.slice(before) }; log.push({ action: 'panel-turn', ...value }); return { ...value, request };
}
const arrangement = 'Put a cube on the floor one metre to camera-left of the selected character. Add a second character two metres to camera-right.';
const motionIntent = 'Make the selected character walk forward, wave, then return to the starting pose over the current shot range. Verify the full take and install it.';
async function undo(before, count = 1) {
  for (let i = 0; i < count; i++) {
    const revision = (await fixture.context()).revision.scene;
    await page.evaluate(() => document.activeElement?.blur());
    await gate(`STATE:current.context.revision.scene > ${revision}`, () => page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z'));
  }
  const restored = await state(); log.push({ action: 'native-undo', count, before, restored }); assert.deepEqual(restored, before, 'native Undo restores exact authored state and take');
}
async function installed(result) {
  const outcome = result.stream.find(e => e.type === 'tool.done')?.result;
  if (outcome?.status === 'review_required') {
    await gate("!!document.querySelector('.agent-job-accept')"); await shot('motion-review-required');
    const accepted = page.waitForResponse(r => r.url().endsWith('/accept'));
    await page.locator('.agent-job-accept').last().click(); const response = await accepted; assert.equal(response.status(),200);
    const { receipt } = await response.json(); log.push({ action: 'explicit-accept', receipt }); return receipt;
  }
  const receipt = result.stream.find(e => e.type === 'receipt')?.receipt; assert(receipt, JSON.stringify(outcome)); return receipt;
}
const implementations = {
  async binding() {
    await open(); await page.getByLabel('Message the agent', { exact: true }).fill('retained draft'); await shot('binding-desktop');
    await page.evaluate(() => document.activeElement.blur());
    await gate("document.querySelector('.studio-agent-inspector').hidden", () => page.keyboard.press('Control+b'));
    await gate("!document.querySelector('.studio-agent-inspector').hidden", () => page.keyboard.press('Control+b'));
    assert.equal(await page.getByLabel('Message the agent', { exact: true }).inputValue(), 'retained draft'); await shot('binding-reopened');
  },
  async intent() {
    await open(); const before = await state(); const c = await fixture.context(); const target = c.activeCharacterId;
    const bounds = await page.evaluate(async () => { const THREE=await import('/node_modules/three/build/three.module.js'); const rig=window.__cozyclay.rigA; rig.updateWorldMatrix(true,true); const box=new THREE.Box3().setFromObject(rig,true); return { model:window.__cozyclay.characterModel,character:window.__cozyclay.charA,min:box.min.toArray(),max:box.max.toArray(),motionFrames:window.__cozyclay.motion?.frames??null }; });
    log.push({action:'initial-real-rig-bounds',bounds}); console.log('INITIAL RIG BOUNDS',JSON.stringify(bounds));
    const result = await turn(arrangement), authored = result.commands.filter(e => ['arrange_objects','arrange_characters'].includes(e.name));
    const after = await state(); log.push({ action:'arrangement-state',before,after }); await shot('intent-desktop');
    await undo(before,authored.filter(row=>row.result.ok && row.result.authored).length); await shot('intent-native-undo');
    assert.equal(authored.length,2); for (const row of authored) { assert.equal(row.result.ok,true,JSON.stringify(row.result)); assert(row.result.receiptId); assert.equal(row.result.revision.after,row.result.revision.before+1); }
    assert.equal(authored[1].expectedRevision,authored[0].result.revision.after);
    const actor = after.characters.find(e => e.id === target), object = after.objects.find(e => !before.objects.some(b => b.id === e.id)), second = after.characters.find(e => !before.characters.some(b => b.id === e.id));
    assert(object.x < actor.x && second.x > actor.x); assert.equal(object.y,0); assert.equal(second.y,0);
    assert(Math.abs(authored[0].result.checks.actualGapM-1)<1e-6); assert(Math.abs(authored[1].result.checks.actualGapM-2)<1e-6);
  },
  async framing() {
    await open(); const before = await state(); const result = await turn('Frame the selected character in a medium shot from the front at eye level and save a camera key at the current frame.');
    const receipt = result.commands.find(e => e.name === 'frame_shot')?.result; assert.equal(receipt?.ok,true,JSON.stringify(receipt));
    const after = await state(), shotId = receipt.delta[0].after.shotId, currentShot = after.shots.find(s => s.id === shotId);
    assert(currentShot.cameraKeys.some(k => k.frame === 0)); assert.notDeepEqual(after.camera,before.camera);
    log.push({ action:'framing-state',before,after,receipt }); await shot('framing-desktop'); await undo(before); await shot('framing-native-undo');
  },
  async motion() {
    await open(); const before = await state();
    const bones = () => page.evaluate(() => { const rows=[]; window.__cozyclay.rigA.traverse(n=>{if(n.isBone) rows.push([...n.position.toArray(),...n.quaternion.toArray()]);}); return rows; });
    const beforeBones = await bones(); const result = await turn(motionIntent), receipt = await installed(result);
    const names = result.commands.map(e => e.name); for (const name of ['prepare_motion_install','verify_motion_candidate','repair_motion_candidate']) assert(names.includes(name),name);
    assert(result.stream.some(e => e.type === 'job.progress' && e.progress === .25));
    for (const s of ['queued','generating','preparing','verifying','repairing']) assert(result.stream.some(e => e.state === s),s);
    assert.equal(receipt.status,'installed'); assert.equal(receipt.installed.frameCount,48); assert(receipt.undo.historyEntryId);
    const after = await state(), take = after.takes.find(e => e.id === receipt.installed.characterId);
    assert.equal(take.takeId,receipt.installed.takeId); assert.equal(take.frames,48); assert.equal(receipt.verification.status,'verified'); assert.equal(receipt.verification.evaluatedFrames,48);
    assert.equal(receipt.repairs.autoPhysicsInvocations,1); assert.equal(receipt.explicitUnverifiedAcceptance,false);
    await gate("!!document.querySelector('[data-receipt-status=\"installed\"]')"); assert((await page.locator('[data-receipt-status="installed"]').innerText()).includes('verified over 48 frames'));
    log.push({ action:'motion-state',before,after,receipt }); await shot('motion-installed-desktop');
    for (const [angle,frame,position] of [['front',16,{x:0,y:1.5,z:5}],['side',32,{x:5,y:1.5,z:0}],['shot',47,null]]) {
      const rendered = await page.evaluate(({position,frame,angle})=>new Promise((resolve,reject)=>{
        const qa=window.__cozyclay, camera=position?qa.editorCam:qa.shotCam, meshes=[];
        qa.rigA.traverse(node=>{if(node.isSkinnedMesh) meshes.push(node);});
        const evidence={angle,frame,sourceCamera:camera.uuid,debugEditorCameraExists:!!qa.editorCam,originalChosenMesh:meshes.at(-1)?.uuid,before:camera.matrixWorld.toArray(),meshes:meshes.map(m=>({id:m.uuid,visible:m.visible,parentVisible:m.parent.visible,frustumCulled:m.frustumCulled})),calls:[]};
        window.__qaCameraEvidence=evidence; const originals=meshes.map(m=>m.onAfterRender); let finishing=false;
        const cleanup=()=>{clearTimeout(timer);meshes.forEach((m,i)=>{m.onAfterRender=originals[i];});};
        const timer=setTimeout(()=>{cleanup();reject(Error('Camera render deadline '+JSON.stringify(evidence)));},10000);
        meshes.forEach((mesh,index)=>{mesh.onAfterRender=function(...args){
          originals[index].apply(this,args);const actual=args[2];
          if(evidence.calls.length<16)evidence.calls.push({mesh:mesh.uuid,camera:actual.uuid,position:actual.position.toArray(),matrix:actual.matrixWorld.toArray(),projection:actual.projectionMatrix.toArray(),sameCamera:actual===camera});
          if(!finishing && actual===camera && (position || window.__cozyclay.lookThroughShot)){finishing=true;queueMicrotask(()=>{cleanup();resolve(evidence);});}
        };});
        if(position)qa.frameEditorCam(position,{x:0,y:1,z:0});else qa.setLookThrough(true);
        // Direct camera refs do not invalidate a demand canvas. Scrub AFTER the
        // camera change so the real editor state transition requests the draw.
        evidence.positionAfterTrigger=camera.position.toArray();
        qa.scrub(frame);
      }),{position,frame,angle});
      log.push({action:'camera-render',...rendered}); assert(rendered.calls.some(call=>call.sameCamera));
      await gate(`window.__cozyclay.tlFrame === ${frame}`); await shot(`motion-${angle}`);
    }
    await gate('!window.__cozyclay.lookThroughShot',()=>page.evaluate(()=>window.__cozyclay.setLookThrough(false)));
    await undo(before); const restoredBones=await bones(); log.push({action:'renderer-native-undo',beforeBones,restoredBones}); assert.deepEqual(restoredBones,beforeBones); await shot('motion-native-undo');
  },
  async resilience() {
    await open(); const failures = []; const c = await fixture.context(), a = c.activeCharacterId;
    const created = await fixture.dispatch('arrange_characters',{ ops:[{ op:'create',name:'Fixture B',position:{ world:{ x:4,y:0,z:0 } } }] }); assert.equal(created.ok,true); const b = created.affectedIds[0];
    const before = await state(); fixture.controls.hold = Promise.withResolvers(); fixture.controls.lostAck = true; const generating = once(fixture.events,'generating');
    const selection = await turn(motionIntent+' Keep the admitted target.', async () => {
      await bounded(generating,'generation admission'); await fixture.dispatch('operate_studio',{ selection:{kind:'character',id:b} }); await shot('resilience-select-b'); fixture.controls.hold.resolve();
    }); fixture.controls.hold = null;
    const receipt = await installed(selection); assert.equal(receipt.installed.characterId,a); assert.equal((await fixture.context()).activeCharacterId,b);
    assert(selection.stream.some(e=>e.state==='reconciling')); const commitCount=fixture.actions.filter(e=>e.name==='commit_motion_candidate').length;
    const replay = await page.evaluate(async request=>{const r=await fetch('/agent/turn',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});return r.text();},selection.request);
    const acknowledgement=replay.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6))).find(e=>e.type==='receipt'); assert.deepEqual(acknowledgement.receipt,receipt); assert.equal(fixture.actions.filter(e=>e.name==='commit_motion_candidate').length,commitCount);
    log.push({action:'lost-ack-reconciled-and-turn-replayed',receipt,commitCount}); await shot('resilience-reconciled');
    await undo(before); await fixture.dispatch('operate_studio',{ selection:{kind:'character',id:a} });
    for (const scenario of ['stale','invalid','stop']) {
      const original = await state(); fixture.controls.hold = Promise.withResolvers(); fixture.controls.invalid = scenario === 'invalid'; const entered = once(fixture.events,'generating'); let expected = original;
      const result = await turn(motionIntent+` Scenario ${scenario}.`, async () => {
        await bounded(entered,'generation before interleaving');
        if (scenario === 'stale') { const edit = await fixture.dispatch('arrange_characters',{ops:[{op:'update',characterId:a,position:{world:{x:.4,y:0,z:0}}}]}); assert.equal(edit.ok,true); expected = await state(); }
        if (scenario === 'stop') { const stopped = page.waitForResponse(r => r.url().endsWith('/agent/stop')); await page.locator('.agent-job-stop').last().click(); await stopped; }
        fixture.controls.hold.resolve();
      }, scenario === 'stop'); fixture.controls.hold = null; fixture.controls.invalid = false;
      const outcome = result.stream.find(e => e.type === 'tool.done')?.result; assert.equal(outcome?.code,{stale:'STALE_TARGET',invalid:'VERIFICATION_FAILED',stop:'CANCELLED'}[scenario],JSON.stringify(outcome)); assert.equal(outcome.mutated,false);
      assert.deepEqual(await state(),expected); await shot(`resilience-${scenario}`); log.push({action:scenario,outcome,preserved:expected});
      if (scenario === 'stop') { const cancellation = await fixture.hub.command('reconcile_studio_command',{commandId:outcome.commandId,host:outcome.host},(await fixture.context()).host.workspaceHandle); log.push({action:'stop-reconcile',cancellation}); if(cancellation.status!=='not_applied') { const error=Error(`Stop journal expected not_applied, observed ${cancellation.status}`); console.error('FAIL SUBCASE stop',error.message); failures.push(error); } }
      if (scenario === 'stale') await undo(original);
    }
    const baseline = await state(), arranged = await turn(arrangement); fixture.controls.receiptId = arranged.commands.find(e => e.name === 'arrange_objects').result.receiptId;
    await turn('Frame the selected character in a medium shot from the front at eye level and save a camera key at the current frame.');
    const conflictBefore = await state(), conflict = await turn('Undo the earlier cube receipt without undoing newer edits.'); assert.equal(conflict.commands.find(e => e.name === 'undo_edit').result.code,'UNDO_CONFLICT'); assert.deepEqual(await state(),conflictBefore); await shot('resilience-undo-conflict');
    const command = arranged.commands.find(e => e.name === 'arrange_objects'); const reconciled = await fixture.hub.command('reconcile_studio_command',{commandId:command.commandId,host:command.result.host},(await fixture.context()).host.workspaceHandle); assert.deepEqual(reconciled.receipt,command.result); assert.equal(reconciled.status,'applied');
    const repeated = await fixture.hub.command('reconcile_studio_command',{commandId:command.commandId,host:command.result.host},(await fixture.context()).host.workspaceHandle); assert.deepEqual(repeated,reconciled); assert.deepEqual(await state(),conflictBefore); log.push({action:'reconcile-duplicate-ack',reconciled,repeated}); await undo(baseline,1+arranged.commands.filter(e=>e.result?.authored).length);
    fixture.controls.rateLimit = true; const limited = await turn('Inspect the current selection without changes.'); assert(limited.stream.some(e => e.type === 'error' && e.code === 'rate_limit')); assert.deepEqual(await state(),baseline); await shot('resilience-rate-limit');
    if (failures.length) throw new AggregateError(failures,'V7 has recorded production blockers');
  },
  async responsive() {
    await open(); const widths = [];
    for (const width of [375,390,768,1040,1100,1600]) {
      await page.setViewportSize({width,height:width<500?844:950});
      await page.getByLabel('Message the agent',{exact:true}).scrollIntoViewIfNeeded();
      const layout = await page.evaluate(() => { const a=document.querySelector('.studio-agent-inspector'), r=document.querySelector('[aria-label="Message the agent"]').getBoundingClientRect(); return { width:innerWidth,scrollWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,hidden:a.hidden,inspector:document.querySelectorAll('.inspector-sidebar').length,agents:document.querySelectorAll('.agent-panel').length,composer:{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height},height:innerHeight }; });
      log.push({action:'layout',...layout}); assert.equal(layout.hidden,false); assert.equal(layout.inspector,1); assert.equal(layout.agents,1); assert(layout.scrollWidth<=width && layout.bodyWidth<=width); assert(layout.composer.width>0 && layout.composer.x>=0 && layout.composer.right<=width && layout.composer.bottom<=layout.height);
      await page.getByLabel('Message the agent',{exact:true}).fill('responsive composer'); assert.equal(await page.getByLabel('Message the agent',{exact:true}).inputValue(),'responsive composer'); await shot(`responsive-${width}`); widths.push(width);
    }
    save('widths',widths);
    await page.goto(`http://127.0.0.1:${port}/workflow/?agent=mock&state=ready`); await gate("!!document.querySelector('.workflow-main > .agent-panel .agent-input')");
    assert.equal(await page.locator('.workflow-main > .agent-panel').count(),1); assert.equal(await page.locator('.studio-agent-inspector').count(),0); await shot('workflow-dock');
  },
};
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: process.env.QA_HEADLESS === '1', args:[`--remote-debugging-port=${cdp}`] });
  for (const name of selected) {
    const context = await browser.newContext({viewport:{width:1600,height:950}}); page = await context.newPage();
    const document = structuredClone(sceneDocument);
    // Layout starts with an actually restorable take; motion Undo restores these
    // real prior bytes. Intent retains the untouched default pose/bounds repro.
    if (['motion','responsive'].includes(name)) document.scenes[0].stage.characters[0].motionRef = {url:fixture.origin+'/ardy/motions/123455-abcdef',prompt:'Fixture baseline',rotationDeg:0,anchorX:0,anchorZ:0};
    await page.addInitScript(document => {
      localStorage.setItem('cozyclay.scenes.v4',JSON.stringify(document));
      localStorage.setItem('cozyclay.locale','en'); localStorage.setItem('cozyclay.project-session.v1',JSON.stringify({name:'QA',updatedAt:1}));
      let history; Object.defineProperty(window,'__sceneHistory',{configurable:true,get:()=>history,set:value=>{history=value;window.dispatchEvent(new Event('qa:render'));}});
    }, document);
    try {
      await page.goto(`http://127.0.0.1:${port}/app/`); await gate("!!window.__cozyclay?.rigA && !!document.querySelector('.view-menu-trigger')");
      if (['motion','responsive'].includes(name)) { await gate('window.__cozyclay.motion?.frames === 48'); log.push({action:'restored-fixture-baseline',case:name,state:await state()}); }
      const c = await fixture.context(); assert.equal(c.capabilities.tools.length,9);
      await fixture.command('set_camera',{x:0,y:1.6,z:5,lookAtX:0,lookAtY:1,lookAtZ:0,focalMm:35},c.host.workspaceHandle);
      await implementations[name](); results.push({name,status:'PASS'}); console.log(`PASS CASE ${name}`);
    } catch (error) { results.push({name,status:'FAIL',error:error.stack}); console.error(`FAIL CASE ${name}`,error); await shot(`${name}-failure`); }
    finally { save('actions',log); save('results',results); await context.close(); }
  }
} finally {
  await browser?.close(); await released(cdp); await fixture.close(); console.log('CLEANUP owned Chrome/profile and CDP port released',cdp);
}
console.log(`qa-studio-agent-browser: ${results.filter(r=>r.status==='PASS').length}/${selected.length} cases PASS`);
if (results.some(r=>r.status!=='PASS')) process.exitCode=1;
