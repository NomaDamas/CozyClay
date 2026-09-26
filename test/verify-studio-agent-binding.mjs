#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSync } from 'rolldown/experimental';
import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import * as protocol from '../src/studio-agent-protocol.js';
import * as context from '../src/studio-agent-context.js';
import * as commands from '../src/studio-agent-commands.js';
import { createStudioMotionCandidates } from '../src/studio-agent-motion.js';
import { createSceneHistoryStore } from '../src/scene-history.js';
import { createCharacterEntry } from '../src/scenes.js';
import { createSemanticState, createFirstEditTracker } from '../src/semantic-edit.js';
import * as objects from '../src/scene-objects.js';
import * as ik from '../src/ardy/ik.js';
import { copyPhysicsKeys, physicsKeyStamp } from '../src/ardy/physics-review.js';
import * as playback from '../src/ardy/playback.js';
import { primeBindPose } from '../src/poses.js';
import { sampleAt } from '../src/sample-at.js';
import { createShot, shotAtFrame, addShotAtFrame } from '../src/cuts.js';
import * as studioActions from '../src/studio-actions.js';
import { focalMmToFov, fovToFocalMm } from '../src/shot.js';
import { objectTransformAt } from '../src/object-path.js';
import { dispatchLiveFrame } from '../src/live-control.js';
import { CSKEL27_NEUTRAL } from '../src/ardy/cskel27-neutral.js';

const cases = ['inspect-entity-transforms', 'targeted-commit-and-undo', 'stale-target-and-epoch', 'selected-B-while-A-generates', 'edit-during-generation', 'invalid-prepare', 'mid-gesture-target', 'lost-acknowledgement', 'camera-undo', 'rail-camera-undo', 'rail-camera-undo-after-object-undo', 'stop-before-commit', 'explicit-unverified-acceptance', 'context-revisions', 'recreated-motion-read-and-verify', 'stale-receipt-undo', 'unverified-default-refusal', 'reverted-edit-invalidates-target', 'motion-preserves-playhead', 'patch-character-tint-and-undo', 'patch-stage-key-light-and-undo', 'patch-partial-drop', 'patch-during-gesture', 'patch-shot-and-prompt-blocks', 'patch-stage-environment-text-and-undo', 'run-action-shot-create-and-undo', 'run-action-object-duplicate-and-undo', 'run-action-refusals', 'context-entity-index'];
const argv = process.argv.slice(2);
assert(!argv.length || (argv.length === 2 && argv[0] === '--case' && cases.includes(argv[1])), 'Unknown test arguments');
const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const parsed = parseSync('App.jsx', app);
assert.deepEqual(parsed.errors, []);
const declarations = new Map();
function visit(value) {
 if (!value || typeof value !== 'object') return;
 if (value.type === 'FunctionDeclaration') declarations.set(value.id.name, app.slice(value.start, value.end));
 for (const [key, child] of Object.entries(value)) if (key !== 'parent') Array.isArray(child) ? child.forEach(visit) : visit(child);
}
visit(parsed.program);
// The RED path executes the pre-binding App registry through the real dispatcher.
if (!declarations.has('createStudioAppBinding')) {
 const start = app.indexOf('\tif (!liveHandlersRef.current) {'), end = app.indexOf('\n\n\tuseEffect(() => {', start);
 const liveHandlersRef = { current: null };
 new Function('liveHandlersRef', app.slice(start, end))(liveHandlersRef);
 const result = await dispatchLiveFrame(JSON.stringify({ type: 'cmd', id: 'binding-red', name: 'arrange_objects', args: {} }), liveHandlersRef.current);
 assert.equal(result.ok, true, `App must bind Studio arrangements: ${result.error}`);
 throw new Error('Missing integrated binding');
}
const ref = current => ({ current });
function bounded(promise) {
 let timer;
 return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('binding event deadline')), 10000); })]).finally(() => clearTimeout(timer));
}
const aimAt = (p,t) => ({ yaw: Math.atan2(-(t.x-p.x), -(t.z-p.z)), pitch: Math.atan2(t.y-p.y, Math.hypot(t.x-p.x,t.z-p.z)) });
const forwardFrom = (yaw,pitch) => new THREE.Vector3(-Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),-Math.cos(yaw)*Math.cos(pitch));
function clip() {
 const frames=48,rotMats=new Float32Array(frames*243),rootPos=new Float32Array(frames*3),posedJoints=new Float32Array(frames*81);
 for(let f=0;f<frames;f++) {for(let j=0;j<27;j++){rotMats.set([1,0,0,0,1,0,0,0,1],(f*27+j)*9);const p=CSKEL27_NEUTRAL[j];posedJoints.set([p[0],p[1]+1.3544128,p[2]],(f*27+j)*3);}rootPos.set(posedJoints.subarray(f*81,f*81+3),f*3);}
 return { frames,fps:24,personScale:1,rotMats,rootPos,posedJoints };
}
const bytes = readFileSync(new URL('../public/models/y-bot-tpose.fbx', import.meta.url));
function rig() { const r=new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');r.scale.setScalar(.01);primeBindPose(r);const parent=new THREE.Group();parent.add(r);parent.updateMatrixWorld(true);return r; }
function fixture() {
 const a=createCharacterEntry({id:'actor-a',model:'y-bot-tpose',x:0,z:0}), b=createCharacterEntry({id:'actor-b',model:'y-bot-tpose',x:4,z:0});
 const chars=[a,b], rigs={'actor-a':rig(),'actor-b':rig()}; rigs['actor-b'].parent.position.x=4;rigs['actor-b'].parent.updateMatrixWorld(true);
 const revision=ref(0), clock=ref(0), lastObject=ref(0), history=ref({past:[],future:[]}), studioHistory=ref(new Map()), characterRef=ref(chars), buffer=ref({waypoints:[],promptClips:[],motion:null}), state=ref(ik.createIkState()), layers=ref(new Map());
 const stage={shotAspect:'16:9',cameraPresetId:null,sensorId:'fullFrame',hasCharSheet:false,environmentImage:null,environment:'a sunlit modern living room',style:'moody cinematic lighting, 35mm film look',hasEnvSheet:false,keyLight:{x:6,y:9,z:4,intensity:1.12,warmth:0.5}};
 const live=ref({characters:chars,objects:[],rigs,shots:[],scenes:[{id:'scene',name:'Fixture'}],activeCharacterId:a.id,stage,timeline:{currentFrame:0,frameCount:48},filmback:{sensorId:'fullFrame',aspectRatio:16/9},studioSelection:{kind:'character',id:a.id},studioShotId:null,studioView:{mode:'scene',frame:0,playing:false,lookThrough:false,grid:false,autoColor:false}});
 const camera=new THREE.PerspectiveCamera(45,16/9); camera.position.set(0,1.6,5);
 const values={}, semantic=[];
 let currentBinding;
 const firstEdit = createFirstEditTracker(() => {});
 const markSemanticEdit=(domain,before,after)=>{if(before!==after)revision.current++;currentBinding?.invalidate?.(domain,before,after);semantic.push(domain);firstEdit('craft',domain,before,after);if(domain==='characters'&&Array.isArray(after)){characterRef.current=after;live.current.characters=after;}if(domain==='shots')live.current.shots=after;};
 const castOwner=createSemanticState(chars,v=>{values.characters=v;},markSemanticEdit,'characters');
 const shotsOwner=createSemanticState([],v=>{values.shots=v;},markSemanticEdit,'shots');
 const suppressObjectClock=ref(false);
 const store=ref(createSceneHistoryStore([], {onObjects(next){if(!suppressObjectClock.current)lastObject.current=++clock.current;values.objects=next;},onCommit(before,after){markSemanticEdit('objects',before,after);}}));
 const noPublish = name => value => {values[name]=typeof value==='function'?value(values[name]??0):value;};
 const scope={THREE,cloneSkeleton,...protocol,...context,...commands,...objects,...ik,...playback,createStudioMotionCandidates,copyPhysicsKeys,physicsKeyStamp,sampleAt,shotAtFrame,focalMmToFov,fovToFocalMm,objectTransformAt,aimAt,forwardFrom,
 liveStateRef:live,sceneRevisionRef:revision,charactersRef:characterRef,loadedLayerCharRef:ref(a.id),bufferRef:buffer,ikStateRef:state,ikStatesRef:layers,storeRef:store,
 charHistoryRef:history,opClockRef:clock,lastObjectOpRef:lastObject,studioHistoryRef:studioHistory,motionFullRef:ref(new Map()),
 store:store.current,suppressObjectClockRef:suppressObjectClock,studioBindingRef:ref(null),objectDeleteUndo:null,selectedSceneObjectId:null,
 liveWorkspaceIdRef:ref('workspace'),liveWorkspaceHandleRef:ref('handle'),studioDocumentEpochRef:ref('document'),activeSceneIdRef:ref('scene'),studioSceneEpochRef:ref('epoch'),
 look:ref({yaw:0,pitch:0}),shotCamRef:ref(camera),shotCameraPosRef:ref(null),manualCameraOverrideRef:ref(false),frameCountRef:ref(48),tlFrameRef:ref(0),
 physicsOptions:{protectedFrames:[]},bridge:{ok:false},studioGestureRef:ref(false),ikBodyDragRef:ref(false),lineDragRef:ref(null),lineDrawRef:ref(null),linePinDragRef:ref(null),autoPhysicsRunRef:ref(null),recRef:ref(null),restoreRef:ref(null),
 committedIkEdits:[],IK_CORRECTION_BLEND_FRAMES:6,snapshotCast:()=>({}),markSemanticEdit,setCharacters:castOwner.set,editCharacters:castOwner.edit,setShots:shotsOwner.set,editShots:shotsOwner.edit,
 ...studioActions,addShotAtFrame,shots:[],tlFrame:0,tlFrameCount:48,captureCurrentFraming:()=>({pos:{x:0,y:1.6,z:5},yaw:0,pitch:0,fovDeg:40}),trackFeature:()=>{},window:{dispatchEvent:()=>true},
 ko:en=>en};
 for(const name of ['setCameraPos','setFovDeg','setCameraPresetId','setWaypoints','setPromptClips','setMotion','setCommittedIkEdits','setIkTick','setTlFrameCount','setToast','setActiveCharacterId','setSelectedHierarchyId','setTlFrame','setWorkflowMode','setLookThroughShot','setGridView','setAutoColor','setTlPlaying','setIkMode','setIkFocus','setKeyLight','setEnvironmentImage','setEnvironment','setStyle','setHasEnvSheet','setShotAspectKey','setSensorFormat','setMovePlaying'])scope[name]=noPublish(name);
 const names=['createStudioAppBinding','readStudioCamera','readStudioState','publishStudioCamera','publishStudioStage','snapshotStudioDomain','publishStudioCharacters','syncStudioLayerBuffer','recordStudioHistory','publishStudioMotion','stepStudioHistory','undoScene','redoScene','commitStudioDraft','commitStudioMotion','studioBounds','operateStudio','snapshotExportRig','restoreExportRig','poseMemberAtFrame','beginPlaybackOn','leaveIkMode','sceneObjectWorldMatrix','createStudioAppActions','recordStudioAction','addTimelineShot','recordShotUndo'];
 const code=names.map(n=>{assert(declarations.has(n),`actual App function ${n}`);return declarations.get(n);}).join('\n');
 const actual=new Function(...Object.keys(scope),code+`\nreturn {${names.join(',')}};`)(...Object.values(scope));
 let binding; let artifactLoader=async()=>clip(); const stamps=new Map();
 // The editor's own handlers stand behind the registry. Shot creation is the
 // real App handler; object duplication is a stand-in with the same store write.
 const unwired = name => () => { throw new Error(`${name} is not wired in this fixture`); };
 const actionHandlers=ref({
  state:()=>({shots:live.current.shots,objects:store.current.objects,frame:0,frameCount:48,selectedObjectId:null,activeCharacterId:'actor-a',promptBlockCount:0,generating:false,motionReady:true}),
  addTimelineShot:()=>actual.addTimelineShot(),
  duplicateSelectedSceneObject:id=>{const source=store.current.objects.find(o=>o.id===id);store.current.applyAtomic(list=>[...list,{...source,id:'copy-1',name:'Copy',x:source.x+0.5}]);},
  ...Object.fromEntries(['splitTimelineShot','duplicateTimelineShot','removeTimelineShot','setTimelineShotRange','moveTimelineShot','runAllPromptBlocks'].map(name=>[name,unwired(name)])),
 });
 const registry=actual.createStudioAppActions(actionHandlers);
 const poses=[{id:'pose-rest',label:'Rest',bones:{}},{id:'pose-wave',label:'Wave',bones:{}}];
 const ports={revision,read:actual.readStudioState,bounds:actual.studioBounds,commit:actual.commitStudioDraft,commitMotion:actual.commitStudioMotion,operate:actual.operateStudio,loadArtifact:(...args)=>artifactLoader(...args),poses:()=>poses,
 ikRevision(id,stamp){const old=stamps.get(id);if(!old||old.stamp!==stamp)stamps.set(id,{stamp,revision:(old?.revision??0)+1});return stamps.get(id).revision;},
 isRetained:r=>Boolean(r?.undo&&studioHistory.current.has(r.undo.historyEntryId)),
 canUndo(r){const entry=r?.undo&&studioHistory.current.get(r.undo.historyEntryId);if(!entry||r.revision.after!==revision.current)return false;return entry.domain==='objects'?entry.tick===lastObject.current&&entry.tick>=(history.current.past.at(-1)?.tick??0)&&entry.depth===store.current.depths().past:entry.tick===history.current.past.at(-1)?.tick&&entry.tick>lastObject.current;},
 undo:actual.undoScene,capture(){throw new Error('renderer capture requires browser');},actions:()=>registry,recordAction:actual.recordStudioAction};
 binding=actual.createStudioAppBinding(ports);currentBinding=binding;scope.studioBindingRef.current={stepHistory:actual.stepStudioHistory};binding.refresh();
 const host=()=>binding.refresh().host;
 const request=(name,args)=>({name,args,host:host(),commandId:crypto.randomUUID(),expectedRevision:binding.refresh().revision,expectedTargets:[...store.current.objects,...characterRef.current].map(c=>binding.guard(c.id))});
 const call=async(name,args)=>{const response=await dispatchLiveFrame(JSON.stringify({type:'cmd',id:crypto.randomUUID(),name,args}),binding.handlers);assert(response.ok, response.error);return response.value;};
 const motionRequest=()=>{const g=binding.guard(a.id);return {commandId:crypto.randomUUID(),binding:{host:host(),characterId:a.id,targetToken:g.token},jobId:crypto.randomUUID(),artifactId:'artifact',artifact:{artifactId:'artifact',url:'http://127.0.0.1:12345/ardy/motions/123456-abcdef'},schedule:protocol.compileStudioBeats({kind:'generate',durationSeconds:2,beats:[{text:'Stand'}]}),stagingPolicy:'preserve-target-anchor'};};
 return {setArtifactLoader:loader=>{artifactLoader=loader;},binding,actual,scope,ports,request,call,motionRequest,revision,semantic,live,store,history,characterRef,buffer,rigs,host,poses,dispose:()=>binding.dispose()};
}
const createArgs={ops:[{op:'create',source:{kind:'cube'},position:{world:{x:2,y:0,z:0}}}]};
async function candidate(f) {const req=f.motionRequest();const prepared=await f.call('prepare_motion_install',req);assert(prepared.candidateId,JSON.stringify(prepared));const next={...req,...prepared,profile:'studio-motion-v1'};const verified=await f.call('verify_motion_candidate',next);assert(verified.verificationId,JSON.stringify(verified));return {req,next,verified};}
async function railCameraUndo(f, interleaveObject) {
 const shot=createShot('Rail shot',0,47,[],{mode:'rail',cameraRail:[{x:-2,z:4},{x:2,z:4}],railFollow:{mode:'range',startFrame:0,endFrame:47},followCam:{pitchOffsetDeg:4},craneHeight:{points:[{t:0,height:1.2},{t:1,height:2.4}]}});
 f.scope.setShots([shot]);f.live.current.shots=[shot];
 const before=structuredClone(f.actual.snapshotStudioDomain('shot'));
 assert.equal(f.binding.context().shot.mode,'rail');
 const receipt=await f.call('frame_shot',f.request('frame_shot',{subjectIds:['actor-a'],keyAtFrame:12,framing:{exact:{position:{x:1,y:2,z:6},lookAt:{x:0,y:1,z:0},focalMm:35}}}));
 assert.equal(receipt.ok,true,JSON.stringify(receipt));
 assert.equal(f.binding.context().shot.mode,'keys');
 assert.equal(f.live.current.shots[0].cameraKeys.length,1);
 if(interleaveObject){
  const result=await f.call('arrange_objects',f.request('arrange_objects',createArgs));
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(f.actual.stepStudioHistory(false),false,'the newer object edit owns Undo first');
  f.actual.undoScene();
  assert.equal(f.store.current.objects.length,0);
  assert.equal(f.binding.context().shot.mode,'keys','object Undo must not undo the camera');
 }
 const stepped=f.actual.stepStudioHistory(false);
 assert.deepEqual({stepped,mode:f.binding.context().shot.mode,camera:f.actual.snapshotStudioDomain('shot').camera},
  {stepped:true,mode:'rail',camera:before.camera},'Undo must restore the rail camera and shot chip');
 assert.deepEqual(f.actual.snapshotStudioDomain('shot'),before,'restore the complete camera block and camera keys');
 assert.deepEqual(f.scope.shotCamRef.current.position.toArray(),Object.values(before.camera.position));
}
const implementations={
 async 'inspect-entity-transforms'(f){
  const created=await f.call('arrange_objects',f.request('arrange_objects',{ops:Array.from({length:30},(_,i)=>({op:'create',source:{kind:'cube'},name:`Prop ${i}`,position:{world:{x:i+2,y:1,z:3}},facing:{yawDeg:30},scale:{x:2,y:3,z:4}}))}));
  assert.equal(created.status,'applied',JSON.stringify(created));
  const id=f.store.current.objects.at(-1).id;
  const c=f.binding.context();
  assert.equal(c.units.pivot,'base');
  assert.equal(c.entityPage.truncated,true);
  assert(!c.entities.some(row=>row.id===id),'fixture target must be outside the bounded context');
  const result=await f.call('inspect_studio',{scope:'entities',ids:[id,'actor-a']});
  assert.equal(result.total,2);
  const row=result.entities.find(row=>row.id===id),character=result.entities.find(row=>row.id==='actor-a');
  assert.deepEqual(row.position,{x:31,y:1,z:3},'entity inspect must carry object position beyond the context page');
  assert.deepEqual(row.rotationDeg,{x:0,y:30,z:0});
  assert.deepEqual(row.scale,{x:2,y:3,z:4});
  assert.equal(row.renderer,'cube');assert.equal(row.parentId,null);assert.equal(row.attachment,null);
  assert.equal(row.token,f.binding.guard(id).token);
  assert.deepEqual(character,c.entities.find(row=>row.id==='actor-a'),'character inspect reuses the context projection');
  assert.deepEqual(character.position,{x:0,y:0,z:0});assert.equal(character.yawDeg,0);
  const first=await f.call('inspect_studio',{scope:'entities',query:'Prop',limit:29});
  assert.equal(first.total,30);assert.equal(first.entities.length,29);
  const last=await f.call('inspect_studio',{scope:'entities',query:'Prop',limit:29,cursor:first.nextCursor});
  assert.deepEqual(last.entities,[row]);assert.equal(last.nextCursor,null);
 },
 async 'context-entity-index'(f){
  const created=await f.call('arrange_objects',f.request('arrange_objects',{ops:Array.from({length:61},(_,i)=>({op:'create',source:{kind:'cube'},name:`Crate ${i}`,position:{world:{x:i,y:0,z:-3}}}))}));
  assert.equal(created.status,'applied',JSON.stringify(created));
  f.actual.operateStudio({selection:{kind:'object',id:'cube-40'}},f.binding.refresh());
  const c=f.binding.context();
  protocol.validateStudioContext(c);
  assert.equal(c.entityPage.total,63);assert.equal(c.entities.length,24);
  assert.deepEqual(c.entities.slice(0,2).map(e=>e.id),['cube-40','actor-a'],'selected, then active, lead the detail');
  const all=[...f.store.current.objects.map(o=>o.id),'actor-a','actor-b'].sort();
  assert.deepEqual(c.entityIndex.map(e=>e.id),all,'the per-turn context indexes all 63 entities');
  assert.deepEqual(c.entityIndex.find(e=>e.id==='cube-40'),{id:'cube-40',kind:'object',name:'Crate 39',position:{x:39,y:0,z:-3}});
  assert.equal(c.entityIndex.find(e=>e.id==='actor-b').kind,'character');
 },
 async 'motion-preserves-playhead'(f){f.live.current.timeline.frameCount=96;f.live.current.studioView.frame=80;const {req,next,verified}=await candidate(f);const result=await f.call('commit_motion_candidate',{...next,verificationId:verified.verificationId,expectedTargetToken:req.binding.targetToken,expectedPhysicsRevision:verified.physicsRevision,explicitUnverifiedAcceptance:true});assert.equal(result.status,'installed',JSON.stringify(result));assert.equal(f.binding.context().view.frame,80);assert(f.binding.context().scene.frameCount>80);},
 async 'patch-character-tint-and-undo'(f){const before=f.binding.refresh().revision;const r=await f.call('patch_elements',f.request('patch_elements',{ops:[{target:{kind:'character',id:'actor-a'},set:{tint:'#123456',pose:'pose-wave'}}]}));assert.equal(r.status,'applied',JSON.stringify(r));assert.equal(r.revision.before,before);assert.equal(r.revision.after,before+1);assert.deepEqual(r.ops,[{index:0,status:'applied'}]);assert.deepEqual(r.delta,[{id:'actor-a',after:{patched:[{path:'character.tint',text:'#123456'},{path:'character.pose',text:'pose-wave'}]}}]);assert.equal(f.characterRef.current.find(c=>c.id==='actor-a').tint,'#123456');assert.equal(f.characterRef.current.find(c=>c.id==='actor-a').pose.id,'pose-wave');assert.equal(f.history.current.past.length,1);const undo=await f.call('undo_edit',f.request('undo_edit',{receiptId:r.receiptId}));assert.equal(undo.status,'undone',JSON.stringify(undo));assert.equal(f.characterRef.current.find(c=>c.id==='actor-a').tint,null);assert.equal(f.characterRef.current.find(c=>c.id==='actor-a').pose,null);},
 async 'patch-stage-key-light-and-undo'(f){const before=f.binding.refresh().revision;const r=await f.call('patch_elements',f.request('patch_elements',{ops:[{target:{kind:'stage'},set:{'keyLight.intensity':2.5,camera:'9:16'}}]}));assert.equal(r.status,'applied',JSON.stringify(r));assert.equal(r.revision.after,before+1);assert.deepEqual(r.affectedIds,['scene']);assert.deepEqual(r.delta[0].after.patched,[{path:'stage.keyLight.intensity',number:2.5},{path:'stage.camera',text:'9:16'}]);assert.equal(f.live.current.stage.keyLight.intensity,2.5);assert.equal(f.live.current.stage.shotAspect,'9:16');assert.equal(f.history.current.past.length,1);assert.equal(f.binding.refresh().revision,before+1,'one stage patch is one authored revision');const undo=await f.call('undo_edit',f.request('undo_edit',{receiptId:r.receiptId}));assert.equal(undo.status,'undone',JSON.stringify(undo));assert.equal(f.live.current.stage.keyLight.intensity,1.12);assert.equal(f.live.current.stage.shotAspect,'16:9');},
 async 'patch-partial-drop'(f){const created=await f.call('arrange_objects',f.request('arrange_objects',createArgs));assert.equal(created.ok,true,JSON.stringify(created));const id=created.affectedIds[0];const r=await f.call('patch_elements',f.request('patch_elements',{ops:[{target:{kind:'object',id},set:{name:'Stand-in',renderer:'sphere'}}]}));assert.equal(r.status,'partial',JSON.stringify(r));assert.deepEqual(r.ops,[{index:0,status:'partial',droppedPaths:['object.renderer']}]);assert.equal(f.store.current.objects.find(o=>o.id===id).name,'Stand-in');assert.equal(f.store.current.objects.find(o=>o.id===id).renderer,'cube');const noop=await f.call('patch_elements',f.request('patch_elements',{ops:[{target:{kind:'object',id},set:{renderer:'sphere'}}]}));assert.equal(noop.status,'noop',JSON.stringify(noop));assert.deepEqual(noop.ops,[{index:0,status:'partial',droppedPaths:['object.renderer']}]);assert.equal(noop.undo,null);},
 async 'patch-shot-and-prompt-blocks'(f){const framed=await f.call('frame_shot',f.request('frame_shot',{subjectIds:['actor-a'],keyAtFrame:0,framing:{exact:{position:{x:0,y:1.6,z:5},lookAt:{x:0,y:1,z:0},focalMm:35}}}));assert.equal(framed.ok,true,JSON.stringify(framed));const shotId=f.live.current.shots[0].id;const model=await f.call('patch_elements',f.request('patch_elements',{ops:[{target:{kind:'shot',id:shotId},set:{targetModel:'seedance-2.5'}}]}));assert.equal(model.status,'applied',JSON.stringify(model));assert.equal(f.live.current.shots[0].targetModel,'seedance-2.5');assert.deepEqual(model.delta,[{id:shotId,after:{patched:[{path:'shot.targetModel',text:'seedance-2.5'}]}}]);const unknown=await f.call('patch_elements',f.request('patch_elements',{ops:[{target:{kind:'shot'},set:{targetModel:'no-such-model'}}]}));assert.equal(unknown.status,'partial',JSON.stringify(unknown));assert.deepEqual(unknown.ops,[{index:0,status:'partial',droppedPaths:['shot.targetModel']}]);assert.equal(f.live.current.shots[0].targetModel,undefined,'an unknown video model is dropped by the shot document repair');const blocks=[{startFrame:0,endFrame:24,text:'walks in'}];const schedule=await f.call('patch_elements',f.request('patch_elements',{ops:[{target:{kind:'character',id:'actor-a'},set:{promptBlocks:blocks}}]}));assert.equal(schedule.status,'applied',JSON.stringify(schedule));assert.deepEqual(schedule.delta[0].after.patched,[{path:'character.promptBlocks',count:1}]);assert.equal(f.buffer.current.promptClips.length,1,'the active layer buffer carries the published schedule');assert.equal(f.buffer.current.promptClips[0].text,'walks in');assert(f.actual.stepStudioHistory(false));assert.equal(f.buffer.current.promptClips.length,0);},
 async 'patch-stage-environment-text-and-undo'(f){const before=f.binding.refresh().revision;const r=await f.call('patch_elements',f.request('patch_elements',{ops:[{target:{kind:'stage'},set:{environment:'a rainy rooftop at dusk',style:'handheld 16mm',hasEnvSheet:true}}]}));assert.equal(r.status,'applied',JSON.stringify(r));assert.equal(r.revision.after,before+1);assert.deepEqual(r.delta[0].after.patched,[{path:'stage.environment',text:'a rainy rooftop at dusk'},{path:'stage.style',text:'handheld 16mm'},{path:'stage.hasEnvSheet',flag:true}]);assert.equal(f.live.current.stage.environment,'a rainy rooftop at dusk');assert.equal(f.live.current.stage.style,'handheld 16mm');assert.equal(f.live.current.stage.hasEnvSheet,true);assert.equal(f.history.current.past.length,1,'one stage patch is one history entry');const undo=await f.call('undo_edit',f.request('undo_edit',{receiptId:r.receiptId}));assert.equal(undo.status,'undone',JSON.stringify(undo));assert.notEqual(f.live.current.stage.environment,'a rainy rooftop at dusk');assert.equal(f.live.current.stage.hasEnvSheet,false);},
 async 'patch-during-gesture'(f){f.scope.studioGestureRef.current=true;const r=await f.call('patch_elements',f.request('patch_elements',{ops:[{target:{kind:'stage'},set:{'keyLight.warmth':0.9}}]}));assert.equal(r.code,'TARGET_BUSY',JSON.stringify(r));assert.equal(f.history.current.past.length,0);assert.equal(f.live.current.stage.keyLight.warmth,0.5);},
 async 'run-action-shot-create-and-undo'(f){
  const listed=await f.call('inspect_studio',{scope:'actions'});
  assert.deepEqual(listed.actions.map(a=>a.id).sort(),[...studioActions.STUDIO_ACTION_IDS].sort(),'the App registers every declared action');
  const byId=Object.fromEntries(listed.actions.map(a=>[a.id,a]));
  assert.equal(byId['shot.create'].available,true,JSON.stringify(byId['shot.create']));
  assert.deepEqual(byId['shot.create'].input,studioActions.studioActionDeclaration('shot.create').input);
  assert.equal(byId['shot.remove'].available,false);assert.equal(typeof byId['shot.remove'].reason,'string');
  assert.equal(byId['motion.generateAllBlocks'].available,false,'there are no prompt blocks to generate');
  const before=f.binding.refresh().revision;
  const r=await f.call('run_action',f.request('run_action',{action:'shot.create',args:{}}));
  assert.equal(r.status,'applied',JSON.stringify(r));assert.equal(r.action,'shot.create');assert.equal(typeof r.summary,'string');
  assert.deepEqual(r.revision,{before,after:before+1});
  assert.equal(f.live.current.shots.length,1);const shot=f.live.current.shots[0];
  assert.deepEqual(r.affectedIds,[shot.id]);
  assert.deepEqual(r.delta,[{id:shot.id,after:{name:shot.name,range:{startFrame:shot.startFrame,endFrameExclusive:shot.endFrame+1}}}]);
  assert.equal(f.history.current.past.length,1,'one native Ctrl+Z entry');
  assert.equal((await f.call('reconcile_studio_command',{host:f.host(),commandId:r.commandId})).status,'applied');
  const undo=await f.call('undo_edit',f.request('undo_edit',{receiptId:r.receiptId}));
  assert.equal(undo.status,'undone',JSON.stringify(undo));assert.deepEqual(f.live.current.shots,[]);assert.equal(f.history.current.past.length,0);
 },
 async 'run-action-object-duplicate-and-undo'(f){
  const created=await f.call('arrange_objects',f.request('arrange_objects',createArgs));assert.equal(created.ok,true,JSON.stringify(created));const id=created.affectedIds[0];
  const r=await f.call('run_action',f.request('run_action',{action:'object.duplicate',args:{objectId:id}}));
  assert.equal(r.status,'applied',JSON.stringify(r));assert.deepEqual(r.affectedIds,['copy-1']);assert.equal(r.revision.after,r.revision.before+1);
  assert.deepEqual(r.delta,[{id:'copy-1',after:{name:'Copy',position:{x:2.5,y:0,z:0}}}]);
  assert.equal(f.store.current.objects.length,2);
  const undo=await f.call('undo_edit',f.request('undo_edit',{receiptId:r.receiptId}));
  assert.equal(undo.status,'undone',JSON.stringify(undo));assert.deepEqual(f.store.current.objects.map(o=>o.id),[id]);
 },
 async 'run-action-refusals'(f){
  const refused=async(args,code)=>{const r=await f.call('run_action',f.request('run_action',args));assert.equal(r.ok,false,JSON.stringify(r));assert.equal(r.code,code,JSON.stringify(r));assert.equal(r.mutated,false);};
  await refused({action:'shot.teleport'},'INVALID_ARGUMENT');
  await refused({action:'shot.create',args:{frame:3}},'INVALID_ARGUMENT');
  await refused({action:'shot.remove',args:{shotId:'shot-missing'}},'TARGET_NOT_READY');
  await refused({action:'motion.generateAllBlocks'},'TARGET_NOT_READY');
  await refused({action:'object.duplicate',args:{objectId:'missing'}},'TARGET_NOT_READY');
  const stale=f.request('run_action',{action:'shot.create'});stale.expectedRevision++;
  assert.equal((await f.call('run_action',stale)).code,'STALE_SCENE');
  assert.equal(f.history.current.past.length,0);assert.deepEqual(f.live.current.shots,[]);
 },
 async 'stale-receipt-undo'(f){const first=await f.call('arrange_objects',f.request('arrange_objects',createArgs));await f.call('arrange_objects',f.request('arrange_objects',createArgs));const before=f.store.current.objects;const r=await f.call('undo_edit',f.request('undo_edit',{receiptId:first.receiptId}));assert.equal(r.code,'UNDO_CONFLICT');assert.strictEqual(f.store.current.objects,before);},
 async 'unverified-default-refusal'(f){const {req,next,verified}=await candidate(f);const result=await f.call('commit_motion_candidate',{...next,verificationId:verified.verificationId,expectedTargetToken:req.binding.targetToken,expectedPhysicsRevision:verified.physicsRevision});assert.equal(result.code,'VERIFICATION_FAILED');assert.equal(f.history.current.past.length,0);assert.equal(f.buffer.current.motion,null);},
 async 'reverted-edit-invalidates-target'(f){const token=f.binding.guard('actor-a').token,original=f.characterRef.current;f.actual.publishStudioCharacters(original.map(c=>c.id==='actor-a'?{...c,x:1}:c),true);f.actual.publishStudioCharacters(original,true);assert.notEqual(f.binding.guard('actor-a').token,token,'editing and reverting must not revive an admitted target');},
 async 'targeted-commit-and-undo'(f){const before=f.store.current.objects;const r=await f.call('arrange_objects',f.request('arrange_objects',createArgs));assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.revision.after,1);assert.equal(f.store.current.depths().past,1);assert.equal(f.store.current.objects[0].x,2);assert.equal(f.semantic.length,1);const undo=await f.call('undo_edit',f.request('undo_edit',{receiptId:r.receiptId}));assert.equal(undo.status,'undone',JSON.stringify(undo));assert.strictEqual(f.store.current.objects,before);},
 async 'stale-target-and-epoch'(f){const r=f.request('arrange_characters',{ops:[{op:'update',characterId:'actor-a',position:{world:{x:1,y:0,z:0}}}]});f.scope.studioSceneEpochRef.current='new-epoch';const result=await f.call('arrange_characters',r);assert.equal(result.code,'STALE_SCENE');assert.equal(f.history.current.past.length,0);},
 async 'selected-B-while-A-generates'(f){const req=f.motionRequest();let entered,release;const arrived=new Promise(r=>entered=r),artifact=new Promise(r=>release=r);f.setArtifactLoader(()=>{entered();return artifact;});const preparing=f.call('prepare_motion_install',req);await bounded(arrived);f.actual.operateStudio({selection:{kind:'character',id:'actor-b'}},f.binding.refresh());release(clip());const prepared=await bounded(preparing);assert(prepared.candidateId,JSON.stringify(prepared));assert.equal(f.binding.guard('actor-a').token,req.binding.targetToken);assert.equal(f.binding.refresh().activeCharacterId,'actor-b');assert.equal(f.binding.refresh().characters[0].id,'actor-a');},
 async 'edit-during-generation'(f){const {next}=await candidate(f);f.actual.publishStudioCharacters(f.characterRef.current.map(c=>c.id==='actor-a'?{...c,x:1}:c),true);const r=await f.call('verify_motion_candidate',next);assert.equal(r.code,'STALE_TARGET');assert.equal(f.history.current.past.length,0);assert.equal(f.characterRef.current[0].x,1);},
 async 'invalid-prepare'(f){const req=f.motionRequest();req.schedule={...req.schedule,frameCount:0};const result=await f.call('prepare_motion_install',req);assert.equal(result.ok,false);assert.equal(result.mutated,false);assert.equal(f.history.current.past.length,0);const reconciled=await f.call('reconcile_studio_command',req);assert.equal(reconciled.status,'not_applied');},
 async 'mid-gesture-target'(f){f.scope.studioGestureRef.current=true;const r=await f.call('arrange_objects',f.request('arrange_objects',createArgs));assert.equal(r.code,'TARGET_BUSY');assert.equal(f.store.current.depths().past,0);},
 async 'lost-acknowledgement'(f){const request=f.request('arrange_objects',createArgs);const r=await f.call('arrange_objects',request);assert(r.ok);const replay=await f.call('reconcile_studio_command',{host:f.host(),commandId:request.commandId});assert.equal(replay.status,'applied');assert.deepEqual(replay.receipt,r);assert.deepEqual(await f.call('arrange_objects',request),r);assert.equal(f.store.current.depths().past,1);assert.equal((await f.call('reconcile_studio_command',{host:f.host(),commandId:'unknown'})).status,'unknown');},
 async 'camera-undo'(f){const before=f.actual.snapshotStudioDomain('shot');const r=await f.call('frame_shot',f.request('frame_shot',{subjectIds:['actor-a'],keyAtFrame:0,framing:{exact:{position:{x:0,y:1.6,z:5},lookAt:{x:0,y:1,z:0},focalMm:35}}}));assert.equal(r.ok,true,JSON.stringify(r));assert.equal(f.live.current.shots[0].cameraKeys.length,1);assert.equal(f.history.current.past.length,1);assert(f.actual.stepStudioHistory(false));assert.deepEqual(f.live.current.shots,before.shots);assert.deepEqual(f.scope.shotCamRef.current.position.toArray(),Object.values(before.camera.position));assert(Math.abs(f.scope.shotCamRef.current.fov-focalMmToFov(before.camera.focalMm,'fullFrame',16/9)*180/Math.PI)<1e-9);},
 async 'rail-camera-undo'(f){await railCameraUndo(f,false);},
 async 'rail-camera-undo-after-object-undo'(f){await railCameraUndo(f,true);},
 async 'stop-before-commit'(f){const req=f.motionRequest();const cancelled=await f.call('cancel_motion_install',req);assert.equal(cancelled.status,'not_applied');assert.equal((await f.call('reconcile_studio_command',req)).status,'not_applied');assert.equal(f.history.current.past.length,0);},
 async 'explicit-unverified-acceptance'(f){const {req,next,verified}=await candidate(f);assert.equal(verified.status,'unverified');const before=f.actual.snapshotStudioDomain('motion','actor-a');const commit={...next,jobId:req.jobId,artifactId:req.artifactId,verificationId:verified.verificationId,expectedTargetToken:req.binding.targetToken,expectedPhysicsRevision:verified.physicsRevision,explicitUnverifiedAcceptance:true};const result=await f.call('commit_motion_candidate',commit);assert.equal(result.status,'installed',JSON.stringify(result));assert.equal(result.verification.status,'unverified');assert.equal(f.history.current.past.length,1);assert.equal(f.buffer.current.motion.studioTakeId,result.installed.takeId);assert(f.actual.stepStudioHistory(false));assert.equal(f.buffer.current.motion,before.character.sessionMotion??null);assert.deepEqual(f.scope.ikStateRef.current.keys,before.ikState.keys);assert.deepEqual(playback.snapshotPlaybackBones(f.rigs['actor-a']),before.renderer.bones);},
 async 'context-revisions'(f){const before=f.binding.context();assert.equal(before.host.workspaceHandle,'handle');f.actual.operateStudio({frame:3},f.binding.refresh());const view=f.binding.context();assert.equal(view.revision.scene,before.revision.scene);assert.equal(view.revision.physics,before.revision.physics);assert(view.revision.view>before.revision.view);assert.equal(view.entities.find(e=>e.id==='actor-a').token,before.entities.find(e=>e.id==='actor-a').token);f.scope.ikStatesRef.current.set('actor-b',{...ik.createIkState(),keys:new Map([[1,new Map([['hips',{p:new THREE.Vector3(0,1,0),q:[new THREE.Quaternion()]}]])]])});const changed=f.binding.context();assert(changed.revision.physics>view.revision.physics);assert.notEqual(changed.entities.find(e=>e.id==='actor-b').token,view.entities.find(e=>e.id==='actor-b').token);},
 async 'recreated-motion-read-and-verify'(f){const baseline=f.binding.context();const equivalent=()=>({...clip(),studioTakeId:'equivalent-take'});f.buffer.current.motion=equivalent();const first=f.binding.context();assert.equal(first.revision.scene,baseline.revision.scene);assert.equal(first.recentReceipts.length,0);f.buffer.current.motion=equivalent();const second=f.binding.context();assert.equal(second.revision.scene,baseline.revision.scene);assert.equal(second.recentReceipts.length,0);const mutation=await f.call('arrange_objects',f.request('arrange_objects',createArgs));assert.equal(mutation.ok,true,JSON.stringify(mutation));assert.equal(mutation.revision.before,baseline.revision.scene);assert.equal(mutation.revision.after,baseline.revision.scene+1);const verified=await f.call('verify_result',f.request('verify_result',{receiptId:mutation.receiptId,checks:['placement'],visual:'none'}));assert.equal(verified.receiptId,mutation.receiptId);assert.equal(verified.revision,mutation.revision.after);assert(!verified.staleScene,'verify_result must not be stale after an immediate authored receipt');}
};
let passed=0;
for(const name of argv.length?[argv[1]]:cases){const f=fixture();try{await implementations[name](f);console.log('PASS',name);passed++;}finally{f.dispose();}}
console.log(`Studio App binding: ${passed}/${argv.length?1:cases.length} passed`);