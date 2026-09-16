#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { writeNpz, motionArraysToNpzMembers } from '../tools/ardy/npz.mjs';
import { createStudioCommandJournal } from '../src/studio-agent-commands.js';
import { compileStudioBeats, validateReceipt } from '../src/studio-agent-protocol.js';
import { createStudioMotionRuntime } from '../bin/agent/motion-runtime.mjs';
import { loadMotionFromUrl } from '../src/ardy/npz.js';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { primeBindPose } from '../src/poses.js';
import { resolveIkRig, createIkState, ikEvaluate } from '../src/ardy/ik.js';
import { applyMotionFrame } from '../src/ardy/playback.js';
import { CSKEL27_NEUTRAL } from '../src/ardy/cskel27-neutral.js';
import { reviewAutoPhysics, physicsKeyStamp } from '../src/ardy/physics-review.js';
import { supportDiagnostics } from '../src/ardy/physics-support.js';
import { fixCollisionsRange } from '../src/ardy/fix-collisions.js';
import { createSceneObject } from '../src/scene-objects.js';
import { dispatchLiveFrame } from '../src/live-control.js';

const args = process.argv.slice(2);
const CASES = ['characterization', 'pre-prepare-cancellation', 'grounded-full-range', 'floor-key-order', 'hovering-no-contact', 'no-measured-skin', 'platform-unsupported',
  'inactive-target-yaw-and-retime', 'off-playhead-path-prop', 'same-frame-other-cast', 'ground-cache-invalidation', 'decode-failure', 'bounded-real-auto-physics',
  'repair-throw', 'protected-regression', 'commit-fences', 'cancellation-checkpoint', 'expiry', 'explicit-unverified-acceptance', 'runtime-http'];
assert(!args.length || (args.length === 2 && args[0] === '--case' && CASES.includes(args[1])), 'Unknown test arguments');
const selectedCase = args[1] ?? null;
const evidence = process.env.MOTION_EVIDENCE_DIR;
const metrics = {};
function rigFixture() {
  const bytes = readFileSync(new URL('../public/models/y-bot-tpose.fbx', import.meta.url));
  const rig = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  rig.scale.setScalar(.01); primeBindPose(rig); rig.updateMatrixWorld(true);
  return rig;
}
function clipFixture({ frames = 48, fps = 24, hover = 0, travel = 0 } = {}) {
  const rotMats = new Float32Array(frames * 27 * 9), rootPos = new Float32Array(frames * 3), posedJoints = new Float32Array(frames * 27 * 3);
  for (let f = 0; f < frames; f++) {
    for (let j = 0; j < 27; j++) {
      rotMats.set([1,0,0,0,1,0,0,0,1], (f * 27 + j) * 9);
      const p = CSKEL27_NEUTRAL[j];
      posedJoints.set([p[0], p[1] + .9544128 + hover, p[2] + travel * f / (frames - 1)], (f * 27 + j) * 3);
    }
    rootPos.set(posedJoints.subarray(f * 81, f * 81 + 3), f * 3);
  }
  return { frames, fps, personScale: 1, rotMats, rootPos, posedJoints };
}
const boneSnapshot = rig => { const rows = []; rig.traverse(n => { if (n.isBone) rows.push([...n.position.toArray(), ...n.quaternion.toArray()]); }); return rows; };
async function characterize() {
  const rig = rigFixture(), motion = clipFixture({ hover: .4 });
  const { chains, fkJoints } = resolveIkRig(rig), sourceKeys = new Map(), cache = { value: null };
  const options = { rig, motion, chains, fkJoints, sourceKeys, applyRaw: f => applyMotionFrame(rig, motion, f), strength: 0, cache };
  const first = await reviewAutoPhysics(options), support = supportDiagnostics(first.evaluated, 24, 0);
  assert.equal(first.after.surfaceMeasured, true); assert.equal(first.after.count, 0);
  assert.equal(first.after.penetration, 0); assert.equal(first.after.slide, 0); assert.equal(first.after.float, 0);
  assert.equal(support.unsupportedFrames, 48); assert.equal(first.support.after.unsupportedFrames, 48);
  const changedGround = await reviewAutoPhysics({ ...options, floorY: .3 });
  assert.equal(changedGround.performance.cacheHit, false);
  assert.equal(changedGround.samples[0].ground.leftFoot, .3);
  const privateKeys = createIkState(); let callbacks = 0;
  assert.throws(() => fixCollisionsRange({ rig, chains, fkJoints, ikState: privateKeys, startFrame: 0, endFrame: 3,
    applyFrame: f => { applyMotionFrame(rig, motion, f); ikEvaluate(chains, privateKeys, f, fkJoints, 6); },
    blockersAt: () => { if (++callbacks === 2) throw new Error('fixture failure after first repair frame'); return [{ id: 'fixture-box', kind: 'box', center: new THREE.Vector3(.65, 1.5, 0), halfExtents: new THREE.Vector3(.15, .3, .2), yaw: 0 }]; },
  }), /fixture failure/);
  metrics.characterization = { measuredFrames: first.evaluated.length, contacts: first.after.count, legacyWarnings: first.warnings.length, independentUnsupportedFrames: support.unsupportedFrames,
    staleGroundCacheHit: changedGround.performance.cacheHit, observedGroundY: changedGround.samples[0].ground.leftFoot, requestedGroundY: .3, repairCallbacksBeforeThrow: callbacks, keysAfterThrow: privateKeys.keys.size };
  console.log('CHARACTERIZATION', JSON.stringify(metrics.characterization));
  return { first, support, changedGround };
}
async function runCase(name) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--case', name], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${name} failed with exit code ${code}`)));
  });
}
if (!selectedCase) {
  for (const name of CASES) await runCase(name);
} else if (selectedCase === 'characterization') {
  await characterize();
} else {
  const moduleUrl = new URL('../src/studio-agent-motion.js', import.meta.url);
  if (!existsSync(moduleUrl)) {
    // Exercise the actual existing physics seam before asserting the missing
    // install contract. This is not an import/syntax/dependency failure.
    assert.equal((await characterize()).first.support?.after.unsupportedFrames, 48,
      'A measured hovering clip with zero inferred contacts must report independent unsupported frames before it can be verified');
  } else {
    const mod = await import(moduleUrl);
    await candidateTests(mod, selectedCase);
  }
}
// Metrics only exist in the child that actually ran a case, so each child
// writes its own slice; the parent has nothing to report but the roll-up.
if (selectedCase && evidence) writeFileSync(`${evidence}/motion-fixture-metrics-${selectedCase}.json`, JSON.stringify(metrics, null, 2) + '\n');
console.log(selectedCase ? `Studio motion: PASS --case ${selectedCase}` : `Studio motion: all ${CASES.length} cases PASS`);

async function candidateTests(mod, selectedCase) {
  const selected = name => !selectedCase || selectedCase === name;
  if (selected('pre-prepare-cancellation')) {
    const host = { workspaceId: 'cancel-workspace', documentEpoch: 'cancel-document', sceneId: 'cancel-scene', sceneEpoch: 'cancel-epoch' };
    const journal = createStudioCommandJournal({ host });
    const binding = { host, characterId: 'cancel-character', targetToken: 'cancel-token' };
    const api = mod.createStudioMotionCandidates({ journal,
      readTarget: () => ({ guard: binding }),
      readEnvironment: () => ({ host, physicsRevision: 0, floor: { model: 'flat', y: 0 }, objects: [], cast: [], frameCount: 48 }),
    });
    const first = api.cancel_motion_install({ commandId: 'cancel-before-prepare', binding });
    assert.equal(first.status, 'not_applied');
    assert.equal(first.evidence?.ok, false);
    assert.equal(first.evidence?.code, 'CANCELLED');
    assert.equal(journal.reconcile({ commandId: 'cancel-before-prepare', host }).status, 'not_applied');
    assert.deepEqual(api.cancel_motion_install({ commandId: 'cancel-before-prepare', binding }), first);
    console.log('PASS pre-prepare cancellation reserves journal and returns structured not_applied evidence');
  }
  mkdirSync('.omo/ulw-execute/task-7', { recursive: true });
  const scratch = mkdtempSync('.omo/ulw-execute/task-7/fixture-');
  const archives = new Map(); let generated = 0;
  const server = createServer((req, res) => {
    if (req.url === '/ardy/health') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, host: 'fixture', device: 'cpu-fixture' })); }
    else if (req.url === '/ardy/generate') { generated++; req.resume(); res.end(JSON.stringify({ event: 'done', motionUrl: '/ardy/motions/123456-abcdef' })); }
    else if (archives.has(req.url)) { res.setHeader('content-length', archives.get(req.url).length); res.end(archives.get(req.url)); }
    else { res.writeHead(404); res.end(); }
  });
  const listening = once(server, 'listening'); server.listen(0, '127.0.0.1'); await listening;
  const origin = `http://127.0.0.1:${server.address().port}`;
  let sequence = 0;
  const host = { workspaceId: 'motion-workspace', documentEpoch: 'motion-document', sceneId: 'motion-scene', sceneEpoch: 'motion-epoch' };
  const owners = [];
  let previousFixture = null;
  function fixture(options = {}) {
    previousFixture?.dispose();
    const number = ++sequence, rig = rigFixture(), oldMotion = clipFixture(), ikState = createIkState();
    const character = { id: 'char-b', x: 0, y: 0, z: 0, rot: 0, scale: 1, layer: { promptClips: [{ id: 'old-beat' }] }, ...options.character };
    rig.position.set(character.x, character.y, character.z); rig.rotation.y = character.rot * Math.PI / 180; rig.scale.setScalar(.01 * character.scale); rig.updateMatrixWorld(true);
    // The visible preimage includes authored IK, prompts and a prior take.
    ikState.keys.set(7, new Map([['hips', { p: new THREE.Vector3(1, 100, 0), q: [new THREE.Quaternion()] }]])); ikState.tracked.add('hips');
    const state = { host: { ...host }, token: 'target-original', physicsRevision: 1, floor: { model: 'flat', y: options.floorY ?? 0 }, objects: [], cast: [], frameCount: 48, playing: true, playhead: 17, activeId: 'char-a', busy: false };
    const domain = { take: oldMotion, full: oldMotion, schedule: structuredClone(character.layer), ikState, history: [], committed: [{ frame: 7 }], bufferOwner: 'char-a' };
    const preimage = () => ({ bones: boneSnapshot(rig), character: structuredClone(character), oldMotion: structuredClone(oldMotion), keys: physicsKeyStamp(ikState.keys), domain: { take: structuredClone(domain.take), full: structuredClone(domain.full), schedule: structuredClone(domain.schedule), history: structuredClone(domain.history), committed: structuredClone(domain.committed), bufferOwner: domain.bufferOwner }, playing: state.playing, playhead: state.playhead, activeId: state.activeId });
    const initial = preimage(), calls = [], journal = createStudioCommandJournal({ host });
    let clock = 0, committedPayload = null;
    const ports = { journal, now: () => clock, yieldTask: () => Promise.resolve(),
      readTarget: () => ({ guard: { ...state.host, targetId: character.id, token: state.token }, character, rig, ikState, protectedFrames: options.protectedFrames ?? [], busy: state.busy, calibration: options.calibration, preserveAuthoredMotion: options.preserveAuthoredMotion }),
      readEnvironment: () => ({ host: state.host, physicsRevision: state.physicsRevision, floor: state.floor, objects: state.objects, cast: state.cast, frameCount: state.frameCount }),
      commit(payload) {
        committedPayload = payload;
        const receipt = validateReceipt({ ok: true, commandId: payload.commandId, receiptId: `receipt-${number}`, status: 'installed', host: { ...state.host }, authored: true,
          revision: { before: domain.history.length, after: domain.history.length + 1 }, affectedIds: [character.id], delta: [{ id: character.id, after: { takeId: `take-${number}` } }], checks: { coverage: 'whole-clip' }, warnings: [],
          jobId: payload.jobId, artifactId: payload.artifactId, installed: { characterId: character.id, beforeTakeId: 'old-take', takeId: `take-${number}`, targetToken: 'target-installed', frameCount: payload.motion.frames, fps: 24, durationSeconds: payload.motion.frames / 24,
            blocks: payload.schedule.blocks.map(({ sourceBeat, startFrame, endFrameExclusive }) => ({ sourceBeat, startFrame, endFrameExclusive })), selectionChanged: false },
          verification: payload.verification, repairs: payload.repairs, explicitUnverifiedAcceptance: payload.explicitUnverifiedAcceptance === true, undo: { historyEntryId: `history-${number}`, entries: 1, canUndoDirect: true } });
        domain.history.push({ take: domain.take, full: domain.full, schedule: domain.schedule, ikState: domain.ikState, committed: domain.committed });
        domain.take = payload.motion; domain.full = payload.sourceMotion; domain.schedule = payload.schedule; domain.ikState = payload.ikState; domain.committed = [];
        journal.record(receipt); return receipt;
      }, ...options.ports };
    const api = mod.createStudioMotionCandidates(ports); owners.push(api);
    const motion = clipFixture(options.clip);
    const path = `${scratch}/${number}.npz`; writeNpz(path, motionArraysToNpzMembers(motion));
    const urlPath = `/fixture-${number}.npz`; archives.set(urlPath, options.decodeFailure ? Buffer.from('invalid-npz') : readFileSync(path));
    const request = { commandId: `command-${number}`, jobId: `job-${number}`, artifactId: `artifact-${number}`, artifact: { artifactId: `artifact-${number}`, url: origin + urlPath },
      binding: { host: { ...host }, characterId: character.id, targetToken: state.token }, schedule: compileStudioBeats({ kind: 'generate', beats: [{ text: 'Fixture motion.', seconds: 2 }] }), stagingPolicy: 'preserve-target-anchor' };
    const dispatch = async (name, extra = {}) => {
      calls.push(name);
      const response = await dispatchLiveFrame(JSON.stringify({ type: 'cmd', id: `dispatch-${calls.length}`, name, args: { commandId: request.commandId, binding: request.binding, ...extra } }), api);
      assert.equal(response.ok, true, response.error);
      assert(response.value && typeof response.value === 'object' && Object.keys(response.value).length > 0,
        `${name} settled without a result: ${JSON.stringify(response)}`);
      return response.value;
    };
    const prepare = () => dispatch('prepare_motion_install', request);
    const verify = c => dispatch('verify_motion_candidate', { candidateId: c.candidateId, candidateRevision: c.candidateRevision, profile: 'studio-motion-v1' });
    const repair = (c, method) => dispatch('repair_motion_candidate', { candidateId: c.candidateId, candidateRevision: c.candidateRevision, method, protectedFrames: [] });
    const commit = (c, v, extra = {}) => dispatch('commit_motion_candidate', { candidateId: c.candidateId, candidateRevision: c.candidateRevision, jobId: request.jobId, artifactId: request.artifactId,
      verificationId: v.verificationId, expectedTargetToken: request.binding.targetToken, expectedPhysicsRevision: v.physicsRevision, ...extra });
    const preserved = () => assert.deepEqual(preimage(), initial, 'visible bones, prior take/full source, authored IK, prompts, history and view stay unchanged');
    const dispose = () => { api.dispose(); assert.equal(api.size, 0); };
    const current = { api, ports, state, domain, rig, character, request, motion, calls, dispatch, prepare, verify, repair, commit, preserved, preimage, dispose, setClock: n => { clock = n; }, get payload() { return committedPayload; } };
    previousFixture = current;
    return current;
  }
  const ok = value => assert.notEqual(value.ok, false, JSON.stringify(value));
  const checked = (label, v) => { metrics[label] = v; console.log('PASS', label, JSON.stringify({ status: v.status, coverage: v.coverage, metrics: v.metrics })); };
  try {
    if (selected('grounded-full-range')) {
      const f = fixture(), c = await f.prepare(); ok(c); assert.deepEqual(await f.prepare(), c); assert.equal(f.api.size, 1);
      const v = await f.verify(c); ok(v); checked('grounded-full-range', v);
      assert.equal(v.status, 'verified'); assert.equal(v.evaluatedFrames, 48); assert.equal(v.coverage.sourceFrames, 48); assert.equal(v.coverage.measuredSupportFrames, 48);
      assert.equal(v.metrics.surfaceMeasured, true); assert.equal(v.metrics.unsupportedFrames, 0); assert(v.coverage.contactSpans > 0); f.preserved();
      const local = f.api.readEvidence(c.candidateId); assert.equal(local.before.rows.length, 48); assert.equal(local.after.poses.length, 48);
      const receipt = await f.commit(c, v); ok(receipt); validateReceipt(receipt); assert.equal(f.domain.history.length, 1); assert.equal(f.api.size, 0);
      assert.deepEqual(await f.commit(c, v), receipt); assert.equal(f.domain.history.length, 1);
      assert.equal(f.state.activeId, 'char-a'); assert.equal(f.domain.bufferOwner, 'char-a'); assert.equal(f.domain.ikState.keys.size, 0);
      const restored = f.domain.history.pop(); Object.assign(f.domain, restored); f.preserved();
    }
    if (selected('floor-key-order')) {
      const f = fixture({ clip: { hover: .08 } }), c = await f.prepare(), first = await f.verify(c); ok(first);
      assert.equal(first.repairable, true);
      const readEnvironment = f.ports.readEnvironment;
      let unstable = false, reads = 0;
      f.ports.readEnvironment = () => {
        const environment = readEnvironment();
        if (unstable && reads % 3 === 1) environment.floor = { y: environment.floor.y, model: environment.floor.model };
        reads++;
        return environment;
      };
      f.state.floor = { y: 0, model: 'flat' }; unstable = true; reads = 0;
      const v = await f.verify(c); ok(v);
      assert.equal(v.physicsRevision, 1);
      assert.equal(v.repairable, true);
      console.log('PASS environment fingerprint ignores equivalent floor key order during verification');
    }
    if (selected('hovering-no-contact')) {
      const f = fixture({ clip: { hover: .4 } }), c = await f.prepare(), v = await f.verify(c); ok(v); checked('hovering-no-contact', v);
      assert.equal(v.status, 'unverified'); assert.equal(v.metrics.unsupportedFrames, 48); assert.equal(v.coverage.contactSpans, 0); assert.equal(v.coverage.measuredSupportFrames, 48); f.preserved();
      assert.equal((await f.commit(c, v)).code, 'VERIFICATION_FAILED'); assert.equal(f.api.size, 0); f.preserved();
    }
    if (selected('no-measured-skin')) {
      const f = fixture(); const meshes = []; f.rig.traverse(n => { if (n.isSkinnedMesh) meshes.push(n); }); for (const mesh of meshes) mesh.removeFromParent();
      const c = await f.prepare(), v = await f.verify(c); ok(v); checked('no-measured-skin', v);
      assert.equal(v.status, 'unverified'); assert.equal(v.metrics.surfaceMeasured, false); assert.equal(v.coverage.measuredSupportFrames, 0); assert.equal(v.repairable, false); f.preserved();
    }
    if (selected('platform-unsupported')) {
      const f = fixture({ character: { y: .5 } }); f.state.objects = [{ ...createSceneObject('cube'), scaleX: 3, scaleY: .5, scaleZ: 3 }];
      const c = await f.prepare(), v = await f.verify(c); ok(v); checked('platform-unsupported', v);
      assert.equal(v.status, 'unverified'); assert.equal(v.repairable, false); assert(v.coverage.elevatedFrames.length > 0); f.preserved();
    }
    if (selected('inactive-target-yaw-and-retime')) {
      const f = fixture({ clip: { frames: 40, fps: 20 }, character: { x: 4, z: -2, rot: 93, scale: 1.2 } }), c = await f.prepare(); ok(c);
      assert.equal(c.plannedDelta.yawDeg, 93); assert.equal(c.plannedDelta.scale, 1.2); assert.equal(c.plannedDelta.frameCount, 48);
      const v = await f.verify(c); ok(v); checked('inactive-target-yaw-and-retime', v); f.preserved();
      const rows = f.api.readEvidence(c.candidateId).after.rows; assert(Math.abs(rows[0].root.x - 4) < .1); assert(Math.abs(rows[0].root.z + 2) < .1);
      const receipt = await f.commit(c, v, { explicitUnverifiedAcceptance: true }); ok(receipt); assert.equal(f.payload.motion.rotationDeg, 93); assert.equal(f.payload.motion.anchorX, 4); assert.equal(f.payload.motion.anchorZ, -2); assert.equal(f.payload.scale, 1.2);
    }
    if (selected('off-playhead-path-prop')) {
      const f = fixture(), prop = { ...createSceneObject('cube'), scaleX: .2, scaleY: .3, scaleZ: .2, y: 1.45,
        path: { points: [{ x: -.8, y: 1.45, z: -2 }, { x: -.8, y: 1.45, z: 2 }], speed: 0, faceTravel: false, loop: false, extend: false, timing: null } };
      f.state.objects = [prop]; const c = await f.prepare(), v = await f.verify(c); ok(v); checked('off-playhead-path-prop', v);
      const trace = f.api.readEvidence(c.candidateId).after;
      assert.equal(trace.collisions[0].length, 0); assert(trace.collisions.slice(15, 33).some(p => p.some(hit => hit.b === 'obj:cube')));
      assert.equal(trace.blockers[0][0].cz, -2); assert.equal(trace.blockers[47][0].cz, 2); assert.equal(v.status, 'unverified'); assert(v.metrics.supportedCollisionFrames > 0); f.preserved();
    }
    if (selected('same-frame-other-cast')) {
      const f = fixture(), other = rigFixture(); other.position.z = -2; other.updateMatrixWorld(true);
      const before = boneSnapshot(other);
      f.state.cast = [{ character: { id: 'char-c', hidden: false }, rig: other, motion: clipFixture({ travel: 4 }), ikState: createIkState() }];
      const c = await f.prepare(), v = await f.verify(c); ok(v); checked('same-frame-other-cast', v);
      const trace = f.api.readEvidence(c.candidateId).after;
      assert.equal(trace.collisions[0].length, 0); assert(trace.collisions.slice(15, 33).some(p => p.some(hit => hit.b.startsWith('char:char-c:'))));
      assert.notEqual(trace.blockers[0][0].az, trace.blockers[47][0].az); assert.deepEqual(boneSnapshot(other), before); f.preserved();
    }
    if (selected('ground-cache-invalidation')) {
      const f = fixture(), c = await f.prepare(), first = await f.verify(c); ok(first);
      f.state.floor.y = .3; f.state.physicsRevision++;
      const v = await f.verify(c); ok(v); checked('ground-cache-invalidation', v);
      assert.equal(v.physicsRevision, 2); const trace = f.api.readEvidence(c.candidateId);
      assert.equal(trace.before.rows[0].ground.leftFoot, .3); assert.equal(trace.after.rows[0].ground.leftFoot, .3); assert(v.metrics.maxFloorPenetrationM > .2); assert.equal(v.repairable, false);
      f.state.physicsRevision++; assert.equal((await f.verify(c)).code, 'STALE_ENVIRONMENT'); assert.equal(f.api.size, 0); f.preserved();
    }
    if (selected('decode-failure')) {
      const f = fixture({ decodeFailure: true }); const result = await f.prepare(); assert.equal(result.code, 'VERIFICATION_FAILED'); assert.equal(result.mutated, false); assert.equal(f.api.size, 0); f.preserved();
      assert.equal((await f.dispatch('reconcile_studio_command')).status, 'not_applied');
      console.log('PASS real HTTP/NPZ decode failure preserves full authored preimage');
    }
    if (selected('bounded-real-auto-physics')) {
      const f = fixture({ clip: { hover: .08 } }), c = await f.prepare(), v = await f.verify(c); ok(v); assert.equal(v.repairable, true);
      const repaired = await f.repair(c, 'auto_physics'); ok(repaired); const final = await f.verify(repaired); ok(final); checked('bounded-real-auto-physics', final);
      assert.equal(final.repairs.autoPhysicsInvocations, 1); assert.equal(final.repairs.fixCollisionsInvocations, 0); f.preserved();
      assert.notEqual((await f.repair(repaired, 'auto_physics')).ok, true); f.preserved();
    }
    if (selected('repair-throw')) {
      const f = fixture({ clip: { hover: .4 }, ports: { reviewAutoPhysics: async options => {
        options.sourceKeys.set(20, new Map([['hips', { p: new THREE.Vector3(100, 0, 0), q: [new THREE.Quaternion()] }]]));
        throw new Error('injected solver failure after private key mutation');
      } } }); const c = await f.prepare(); await f.verify(c);
      const result = await f.repair(c, 'auto_physics'); assert.equal(result.code, 'VERIFICATION_FAILED'); assert.equal(f.api.size, 0); f.preserved();
      console.log('PASS private repair throw releases candidate without partial authored mutation');
    }
    if (selected('protected-regression')) {
      const f = fixture({ clip: { hover: .08 }, floorY: .05, protectedFrames: [24], ports: { reviewAutoPhysics: async options => {
        // The protected frame's key remains absent, but a neighbouring key's
        // REAL ikEvaluate blend changes its evaluated pose.
        const keys = new Map([[23, new Map([['hips', { p: new THREE.Vector3(0, 160, 0), q: [new THREE.Quaternion()] }]])]]);
        assert(!keys.has(24)); return { candidate: { keys, tracked: new Set(['hips']) } };
      } } }); const c = await f.prepare(); ok(c); const initial = await f.verify(c);
      // A rejection receipt carries no `status`, so assert the whole object
      // first: otherwise the failure prints as `{}` and hides its real code.
      ok(initial);
      assert.equal(initial.status, 'unverified', `protected-regression fixture must remain repairable before repair: ${JSON.stringify(initial)}`);
      assert.equal(initial.repairable, true, `protected-regression fixture lost repair permission during verification: ${JSON.stringify(initial)}`);
      const result = await f.repair(c, 'auto_physics');
      assert.equal(result.code, 'REPAIR_REGRESSED', JSON.stringify(result)); assert.equal(f.api.size, 0); f.preserved(); console.log('PASS evaluated protected pose/blend regression rejected, not key-map equality');
    }
    if (selected('commit-fences')) {
      for (const kind of ['target', 'document', 'gesture', 'physics', 'cancel']) {
        const f = fixture(), c = await f.prepare(), v = await f.verify(c); ok(v);
        if (kind === 'target') f.state.token = 'edited-target';
        if (kind === 'document') f.state.host.documentEpoch = 'replacement';
        if (kind === 'gesture') f.state.busy = true;
        if (kind === 'physics') f.state.physicsRevision++;
        if (kind === 'cancel') await f.dispatch('cancel_motion_install');
        const result = await f.commit(c, v);
        if (kind === 'cancel') assert.equal(result.status, 'not_applied');
        else { assert.equal(result.ok, false); assert.equal(result.mutated, false); }
        assert.equal(f.domain.history.length, 0); f.preserved();
      }
      console.log('PASS synchronous commit target/document/gesture/physics/cancel fences');
    }
    if (selected('cancellation-checkpoint')) {
      const entered = Promise.withResolvers(), release = Promise.withResolvers(); let held = false;
      const f = fixture({ ports: { yieldTask: async () => { if (!held) { held = true; entered.resolve(); await release.promise; } } } });
      const c = await f.prepare(); const result = f.verify(c); await entered.promise;
      await f.dispatch('cancel_motion_install'); release.resolve(); assert.equal((await result).code, 'CANCELLED'); assert.equal(f.api.size, 0); f.preserved();
      console.log('PASS cancellation at subscribed evaluation checkpoint disposes private resources');
    }
    if (selected('expiry')) {
      const f = fixture(), c = await f.prepare(); f.setClock(600001); f.api.cleanup(); assert.equal(f.api.size, 0); f.preserved();
      assert.equal((await f.verify(c)).ok, false); console.log('PASS injected-clock candidate expiry');
    }
    if (selected('explicit-unverified-acceptance')) {
      const f = fixture({ clip: { hover: .4 } }), c = await f.prepare(), v = await f.verify(c); ok(v);
      const receipt = await f.commit(c, v, { explicitUnverifiedAcceptance: true }); ok(receipt); assert.equal(receipt.verification.status, 'unverified'); assert.equal(receipt.explicitUnverifiedAcceptance, true); assert.equal(f.domain.history.length, 1);
      console.log('PASS explicit warning acceptance retains unverified coverage in one receipt');
    }
    if (selected('runtime-http')) {
      const f = fixture(); archives.set('/ardy/motions/123456-abcdef', archives.get(new URL(f.request.artifact.url).pathname));
      const liveHub = { handleForWorkspaceId: () => 'fixture-handle', resolveWorkspace: () => 'fixture-handle', workspaceId: () => host.workspaceId,
        command: (name, request) => { f.request.commandId = request.commandId; f.request.jobId = request.jobId ?? f.request.jobId; f.request.artifactId = request.artifactId ?? f.request.artifactId; return f.dispatch(name, request); } };
      const runtime = createStudioMotionRuntime({ liveHub, getBridgeOrigin: () => origin });
      try {
        const job = runtime.admit({ hostBinding: { ...host, workspaceHandle: 'fixture-handle' }, characterId: 'char-b', targetToken: 'target-original', turnId: 'runtime-turn', commandId: 'runtime-command', authorization: { id: 'runtime-authorization', generations: 1 },
          source: { kind: 'generate', beats: [{ text: 'Fixture motion.', seconds: 2 }] }, repair: 'bounded' });
        const events = []; runtime.subscribe(job.jobId, e => events.push(e)); const receipt = await runtime.start(job.jobId);
        ok(receipt); assert.equal(receipt.status, 'installed'); assert.equal(generated, 1); assert.equal(f.domain.history.length, 1); assert.equal(f.api.size, 0);
        assert.equal(f.calls.filter(n => n === 'commit_motion_candidate').length, 1); validateReceipt(receipt);
        metrics.runtime = { mode: 'real-runtime-http-npz-dispatch-fixture-editor-no-model-no-gpu', generations: generated, historyEntries: f.domain.history.length, states: events.map(e => e.state), receipt };
        console.log('PASS merged task3 runtime -> HTTP fixture NPZ -> actual private verifier -> correlated fixture editor receipt');
      } finally { await runtime.dispose(); }
    }
  } finally {
    for (const owner of owners) { owner.dispose(); assert.equal(owner.size, 0); }
    server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); rmSync(scratch, { recursive: true });
    console.log('CLEANUP private candidate owners, HTTP listener and generated fixture archives released');
  }
}
