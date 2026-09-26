import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { resolveIkRig } from "../src/ardy/ik.js";
import { applyMotionFrame } from "../src/ardy/playback.js";
import { decodeMotionNpz } from "../src/ardy/npz.js";
import { reviewAutoPhysics } from "../src/ardy/physics-review.js";
const model = process.env.MODEL || "y-bot-tpose", out = process.env.QA_OUT || "/tmp/physics-offline";
const buf = readFileSync(`public/models/${model}.fbx`);
const rig = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "");
rig.scale.setScalar(.01 * Number(process.env.CHAR_SCALE || 1)); rig.updateMatrixWorld(true);
const { chains, fkJoints } = resolveIkRig(rig);
const motion = await decodeMotionNpz(readFileSync(process.env.MOTION || "tools/ardy/out/extract-fOE1MA/motion-0.npz"));
const start = performance.now();
const result = await reviewAutoPhysics({ rig, chains, fkJoints, motion, sourceKeys: new Map(), applyRaw: (f) => applyMotionFrame(rig, motion, f), ...(process.env.ALIGNMENT_SCALE ? { alignmentScale: Number(process.env.ALIGNMENT_SCALE) } : {}) });
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/tracks.json`, JSON.stringify({ before: result.samples, after: result.evaluated }));
writeFileSync(`${out}/replay-errors.json`, JSON.stringify(result.replayErrors));
writeFileSync(`${out}/support.json`, JSON.stringify(result.support));
writeFileSync(`${out}/candidate.json`, JSON.stringify({ model, frames: motion.frames, fps: motion.fps,
	tracked: [...result.candidate.tracked], keys: [...result.candidate.keys].map(([f, entries]) => [f, [...entries].map(([id, k]) => [id, {
		...k, q: k.q?.map((q) => q.toArray()) ?? null, p: k.p?.toArray() ?? null,
		baseQ: k.baseQ?.map((q) => q.toArray()), basePos: k.basePos?.toArray(), chainP: k.chainP?.map((p) => p.toArray()),
	}])]) }));
const accepted = result.after.surfaceMeasured && result.after.penetration <= .005 && result.after.slide <= .015 && result.after.float <= .025 && result.after.kneeAcceleration <= result.before.kneeAcceleration * 1.1 && result.after.rootAcceleration <= result.before.rootAcceleration * 1.1 && result.replayErrors.length === 0;
const metrics = { model, accepted, kinematicAccepted: accepted, supportVerified: accepted && result.support.after.unresolved.length === 0, seconds: (performance.now() - start) / 1000, performance: result.performance, before: result.before, after: result.after, warnings: result.warnings, unresolved: result.unresolved, contacts: result.contacts.spans, replayErrors: result.replayErrors.length };
writeFileSync(`${out}/metrics.json`, JSON.stringify(metrics, null, 2));
console.log(JSON.stringify({ ...metrics, unresolved: metrics.unresolved.length, contacts: metrics.contacts.length }, null, 2));
if (!accepted) process.exitCode = 1;
