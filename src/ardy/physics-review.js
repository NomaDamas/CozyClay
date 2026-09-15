import * as THREE from "three";
import { findBone, ikEvaluate, solveIk, solveHipsTranslate } from "./ik.js";
import { footLockTrack, relaxToePath } from "./foot-lock.js";
import { computeCenterOfMass } from "./auto-physics.js";
import { relaxPhysicsRoot } from "./physics-temporal.js";
import { refinePhysicsCandidate } from "./physics-refine.js";
import { createSurfaceSampler } from "./physics-surface.js";
import { createDynamicsSampler, inferSupportAlignment, supportDiagnostics } from "./physics-support.js";
import { createGroundSampler } from "./ground.js";

// A reviewable correction pass. The source key map is never modified; preview,
// strength, protected frames, and commit all use the same evaluated candidate.
export const SUPPORT_SITES = [
	{ id: "leftFoot", label: "Left foot", ko: "왼발", bone: "LeftFoot", chain: "leftFoot", kind: "foot", match: /Left(Foot|Toe)/ },
	{ id: "rightFoot", label: "Right foot", ko: "오른발", bone: "RightFoot", chain: "rightFoot", kind: "foot", match: /Right(Foot|Toe)/ },
	{ id: "leftHand", label: "Left hand", ko: "왼손", bone: "LeftHand", chain: "leftHand", kind: "hand", match: /LeftHand/ },
	{ id: "rightHand", label: "Right hand", ko: "오른손", bone: "RightHand", chain: "rightHand", kind: "hand", match: /RightHand/ },
	{ id: "leftKnee", label: "Left knee", ko: "왼무릎", bone: "LeftLeg", chain: "leftFoot", kind: "knee", match: /Left(UpLeg|Leg)$/ },
	{ id: "rightKnee", label: "Right knee", ko: "오른무릎", bone: "RightLeg", chain: "rightFoot", kind: "knee", match: /Right(UpLeg|Leg)$/ },
];
export const PHYSICS_LIMITS = Object.freeze({ root: 0.18, pull: 0.10, tilt: Math.PI / 60, floor: 0.005, slide: 0.015, float: 0.025 });
const V = () => new THREE.Vector3();
const Q = () => new THREE.Quaternion();
const clamp = THREE.MathUtils.clamp;
const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const quantile = (a, t) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s[Math.floor((s.length - 1) * t)] ?? 0; };

export function copyPhysicsKeys(keys) {
	return new Map([...keys].map(([f, entries]) => [f, new Map([...entries].map(([id, k]) => [id, {
		...k, q: k.q?.map((q) => q.clone()) ?? null, p: k.p?.clone() ?? null,
		...(k.baseQ ? { baseQ: k.baseQ.map((q) => q.clone()) } : {}),
		...(k.basePos ? { basePos: k.basePos.clone() } : {}),
		...(k.chainP ? { chainP: k.chainP.map((p) => p.clone()) } : {}),
	}]))]));
}
export function physicsKeyStamp(keys) {
	return JSON.stringify([...keys].sort((a, b) => a[0] - b[0]).map(([f, e]) => [f, [...e].sort(([a], [b]) => a.localeCompare(b)).map(([id, k]) => [id, k.p?.toArray(), k.q?.map((q) => q.toArray()), k.basePos?.toArray(), k.baseQ?.map((q) => q.toArray()), k.keepTranslations, k.chainP?.map((p) => p.toArray())])]));
}

/** Measured skin, shared exact transforms; never a cached bind-pose sole. */
export function createSupportSampler(rig) { return createSurfaceSampler(rig, SUPPORT_SITES); }

export function sitePoint(row, site) {
	return site.kind === "foot" ? (row.toes?.[site.id] ?? row.support[site.id]?.position) : row.support[site.id]?.position;
}

export function supportIntervals(samples, fps, overrides = [], floorY = 0, groundAt = null) {
	const spans = [], rejected = [], count = samples.length;
	const masks = Array.from({ length: count }, () => new Map());
	for (const site of SUPPORT_SITES) {
		const floor = quantile(samples.map((r) => r.support[site.id]?.floor), 0.08);
		const flags = samples.map((r, i) => {
			const a = samples[Math.max(0, i - 2)].support[site.id], b = samples[Math.min(count - 1, i + 2)].support[site.id], c = r.support[site.id];
			const pa = sitePoint(samples[Math.max(0, i - 2)], site), pb = sitePoint(samples[Math.min(count - 1, i + 2)], site);
			if (!a || !b || !c || !pa || !pb) return false;
			const dt = (Math.min(count - 1, i + 2) - Math.max(0, i - 2)) / fps || 1 / fps;
			const localGround = r.ground?.[site.id] ?? (groundAt ? groundAt((sitePoint(r, site) ?? c.position).x, (sitePoint(r, site) ?? c.position).z, c.position.y + 0.001) : floorY);
			return c.floor < localGround + (site.kind === "foot" ? 0.15 : 0.07)
				&& c.floor < floor + 0.055 && Math.abs(b.position.y - a.position.y) / dt < 0.25
				&& Math.hypot(pb.x - pa.x, pb.z - pa.z) / dt < 0.16;
		});
		const forced = new Set();
		for (const edit of overrides.filter((o) => o.site === site.id)) {
			for (let f = Math.max(0, edit.start); f <= Math.min(count - 1, edit.end); f += 1) {
				flags[f] = edit.mode === "plant";
				if (flags[f]) forced.add(f); else forced.delete(f);
			}
		}
		let start = -1;
		for (let f = 0; f <= count; f += 1) {
			if (flags[f] && start < 0) start = f;
			if ((f === count || !flags[f]) && start >= 0) {
				const manual = [...forced].some((i) => i >= start && i < f);
				if (f - start >= Math.max(3, Math.round(fps * 0.12)) || manual) {
					const rows = samples.slice(start, f).map((r) => sitePoint(r, site));
					const anchor = new THREE.Vector3(quantile(rows.map((r) => r.x), 0.5), 0, quantile(rows.map((r) => r.z), 0.5));
					const wander = Math.max(...rows.map((r) => Math.hypot(r.x - anchor.x, r.z - anchor.z)));
					if (site.kind === "foot") anchor.y = groundAt ? groundAt(anchor.x, anchor.z, quantile(rows.map((r) => r.y), 0.5) + 0.001) : quantile(rows.map((r) => r.y), 0.5);
					const span = { id: `${site.id}:${start}`, site: site.id, start, end: f - 1, anchor, manual, wander };
					if (wander <= PHYSICS_LIMITS.pull || manual) {
						spans.push(span);
						for (let i = start; i < f; i += 1) masks[i].set(site.id, span);
					} else rejected.push({ ...span, reason: "moving-contact" });
				}
				start = -1;
			}
		}
	}
	return { spans, masks, rejected };
}

export function smoothPhysicsTrack(values, radius = 3, protectedFrames = []) {
	const locks = new Set(protectedFrames);
	return values.map((v, f) => {
		if (locks.has(f)) return v.map(() => 0);
		let total = 0; const result = v.map(() => 0);
		for (let i = Math.max(0, f - radius); i <= Math.min(values.length - 1, f + radius); i += 1) {
			const weight = radius + 1 - Math.abs(f - i);
			values[i].forEach((x, j) => { result[j] += x * weight; }); total += weight;
		}
		let influence = 1;
		for (const p of locks) influence = Math.min(influence, smooth(Math.abs(f - p) / (radius + 1)));
		return result.map((x) => x / total * influence);
	});
}

function poseSnapshot(chains, hips) {
	return { hips: { p: hips.position.clone(), q: hips.quaternion.clone() },
		chains: new Map([...chains].map(([id, c]) => [id, c.bones.map((b) => ({ p: b.position.clone(), q: b.quaternion.clone() }))])) };
}
function applySnapshot(pose, rig, chains, hips) {
	hips.position.copy(pose.hips.p); hips.quaternion.copy(pose.hips.q);
	for (const [id, values] of pose.chains) chains.get(id).bones.forEach((b, i) => { b.position.copy(values[i].p); b.quaternion.copy(values[i].q); });
	rig.updateMatrixWorld(true);
}
function kneeAngle(c) {
	const [a, b, d] = c.bones.map((b) => b.getWorldPosition(V()));
	return a.sub(b).angleTo(d.sub(b)) * 180 / Math.PI;
}

/** Small constrained root solve, coupled to the contact limb reach. The
 * translation and tilt compete against preserving the supplied performance;
 * this is a kinematic approximation, not a ground-reaction-force simulator. */
function fitRoot(sample, targets, seed, preserveShape = true) {
	const constraints = targets.map((t) => {
		const c = sample.chains[t.site.chain];
		return { ...t, offset: c.root.clone().sub(sample.root), max: t.site.kind === "knee" ? c.lengths[0] : t.site.kind === "foot" ? Math.min((c.lengths[0] + c.lengths[1]) * 0.998, sample.chains[t.site.chain].distance + 0.01) : (c.lengths[0] + c.lengths[1]) * 0.998 };
	});
	const cost = (x) => {
		const rotation = Q().setFromEuler(new THREE.Euler(x[3], 0, x[4]));
		let score = 2 * ((x[0] - seed[0]) ** 2 + (x[1] - seed[1]) ** 2 + (x[2] - seed[2]) ** 2) + 0.8 * (x[3] ** 2 + x[4] ** 2);
		for (const c of constraints) {
			const root = c.offset.clone().applyQuaternion(rotation).add(sample.root).add(new THREE.Vector3(...x));
			const d = root.distanceTo(c.target);
			const err = c.site.kind === "knee" ? d - c.max : Math.max(0, d - c.max);
			const original = sample.chains[c.site.chain].distance;
			const shape = c.site.kind === "knee" ? 0 : d - original;
			score += 1500 * err * err + (preserveShape ? 0.2 * shape * shape : 0);
		}
		return score;
	};
	let x = [...seed], best = cost(x);
	for (const step of [0.015, 0.006, 0.002, 0.0007]) {
		for (let pass = 0; pass < 5; pass += 1) {
			let improved = false;
			for (let j = 0; j < 5; j += 1) for (const direction of [-1, 1]) {
				const next = [...x]; next[j] += direction * step;
				next[j] = clamp(next[j], j < 3 ? -PHYSICS_LIMITS.root : -PHYSICS_LIMITS.tilt, j < 3 ? PHYSICS_LIMITS.root : PHYSICS_LIMITS.tilt);
				const value = cost(next);
				if (value + 1e-12 < best) { x = next; best = value; improved = true; }
			}
			if (!improved) break;
		}
	}
	return x;
}

export function physicsMetrics(samples, masks, fps, floorY = 0, groundAt = null) {
	const m = { penetration: 0, penetrationFrame: 0, float: 0, floatFrame: 0, slide: 0, slideFrame: 0, meanSlide: 0, kneeStep: 0, kneeStepFrame: 0, kneeAcceleration: 0, rootAcceleration: 0, count: 0, surfaceMeasured: samples.every((s) => SUPPORT_SITES.slice(0, 2).every((site) => s.support[site.id]?.vertices > 0)) };
	for (let f = 0; f < samples.length; f += 1) {
		for (const [id, point] of Object.entries(samples[f].support)) if (point.vertices > 0) { const g = samples[f].ground?.[id] ?? floorY; if (g - point.floor > m.penetration) { m.penetration = g - point.floor; m.penetrationFrame = f; } }
		for (const site of SUPPORT_SITES) {
			const r = samples[f].support[site.id]; if (!r) continue;
			const ground = samples[f].ground?.[site.id] ?? floorY;
			const depth = Math.max(0, ground - r.floor);
			if (depth > m.penetration) { m.penetration = depth; m.penetrationFrame = f; }
			const span = masks[f]?.get(site.id);
			if (span) {
				const point = sitePoint(samples[f], site);
				const slide = Math.hypot(point.x - span.anchor.x, point.z - span.anchor.z);
				if (slide > m.slide) { m.slide = slide; m.slideFrame = f; }
				const gap = Math.max(0, r.floor - ground);
				if (gap > m.float) { m.float = gap; m.floatFrame = f; }
				m.meanSlide += slide; m.count += 1;
			}
		}
		for (const side of ["leftFoot", "rightFoot"]) {
			if (f > 0) {
				const step = Math.abs(samples[f].knees[side] - samples[f - 1].knees[side]);
				if (step > m.kneeStep) { m.kneeStep = step; m.kneeStepFrame = f; }
			}
			if (f > 1) {
				const a = Math.abs(samples[f].knees[side] - 2 * samples[f - 1].knees[side] + samples[f - 2].knees[side]) * fps * fps;
				if (a > m.kneeAcceleration) { m.kneeAcceleration = a; m.kneeAccelerationFrame = f; }
			}
		}
		if (f > 1) {
			const a = samples[f].root.clone().add(samples[f - 2].root).addScaledVector(samples[f - 1].root, -2).length() * fps * fps;
			if (a > m.rootAcceleration) { m.rootAcceleration = a; m.rootAccelerationFrame = f; }
		}
	}
	m.meanSlide /= m.count || 1;
	return m;
}

function reviewWarnings(before, after, replayErrors = []) {
	const warnings = [];
	if (after.penetration > PHYSICS_LIMITS.floor) warnings.push({ frame: after.penetrationFrame, reason: "floor", value: after.penetration });
	if (after.float > PHYSICS_LIMITS.float) warnings.push({ frame: after.floatFrame, reason: "float", value: after.float });
	if (after.slide > PHYSICS_LIMITS.slide) warnings.push({ frame: after.slideFrame, reason: "slide", value: after.slide });
	if (after.kneeStep > Math.max(before.kneeStep + 2, 12)) warnings.push({ frame: after.kneeStepFrame, reason: "knee-pop", value: after.kneeStep });
	if (after.kneeAcceleration > Math.max(1e-6, before.kneeAcceleration * 1.1)) warnings.push({ frame: after.kneeAccelerationFrame, reason: "knee-acceleration", value: after.kneeAcceleration });
	if (after.rootAcceleration > Math.max(1e-6, before.rootAcceleration * 1.1)) warnings.push({ frame: after.rootAccelerationFrame, reason: "root-acceleration", value: after.rootAcceleration });
	if (replayErrors.length) warnings.push({ frame: replayErrors[0].frame, reason: "replay", value: replayErrors[0].error });
	return warnings;
}

async function reviewCandidate({ rig, motion, chains, fkJoints, sourceKeys, applyRaw, sceneObjects = [], overrides = [], protectedFrames = [], strength = 1, onProgress = () => {}, yieldFrame = () => Promise.resolve(), floorY = 0, cache = null, alignmentScale = 1 }) {
	const started = performance.now(), timings = {};
	const hips = fkJoints?.get("hips")?.bone;
	const toeBones = { leftFoot: findBone(rig, "mixamorigLeftToeBase"), rightFoot: findBone(rig, "mixamorigRightToeBase") };
	if (!hips || !motion || !chains) throw new Error("A loaded motion and complete rig are required");
	const count = motion.frames, fps = motion.fps || 24;
	const sample = createSupportSampler(rig), dynamics = createDynamicsSampler(rig), groundAt = createGroundSampler(sceneObjects, { floorY }), source = { keys: copyPhysicsKeys(sourceKeys), tracked: new Set([...sourceKeys.values()].flatMap((e) => [...e.keys()])) };
	const hasSceneGround = sceneObjects.length > 0;
	let grounding = null;
	const applyBase = (f) => { applyRaw(f); ikEvaluate(chains, source, f, fkJoints, 6); if (grounding?.shifts[f]) solveHipsTranslate(fkJoints.get("hips"), new THREE.Vector3(0, grounding.shifts[f], 0), hips.position.clone()); rig.updateMatrixWorld(true); };
	let raw = [], base = [], samples = [];
	const read = () => {
		const support = sample();
		const toes = Object.fromEntries(Object.entries(toeBones).map(([id, bone]) => [id, (bone ?? chains.get(id).bones[2]).getWorldPosition(V())]));
		const ground = Object.fromEntries(SUPPORT_SITES.map((site) => { const p = sitePoint({ support, toes }, site) ?? support[site.id]?.position; return [site.id, p ? groundAt(p.x, p.z, support[site.id]?.position.y + 0.001) : floorY]; }));
		return { support, toes, ground, root: hips.getWorldPosition(V()), com: computeCenterOfMass(rig), dynamics: dynamics(), knees: Object.fromEntries(["leftFoot", "rightFoot"].map((id) => [id, kneeAngle(chains.get(id))])) };
	};
	rig.updateMatrixWorld(true);
	const stamp = physicsKeyStamp(sourceKeys), matrixStamp = rig.matrixWorld.elements.join(",");
	const environmentKey = JSON.stringify({ floorY, sceneObjects: sceneObjects.map((o) => ({ id: o.id, x: o.x, y: o.y, z: o.z, rot: o.rot, rotX: o.rotX, rotZ: o.rotZ, scaleX: o.scaleX, scaleY: o.scaleY, scaleZ: o.scaleZ, path: o.path ?? null })) });
	const cached = cache?.value;
	const cacheHit = cached?.schema === 5 && cached?.rig === rig && cached?.motion === motion && cached?.stamp === stamp && cached?.matrixStamp === matrixStamp && cached?.environmentKey === environmentKey;
	if (cacheHit) { raw = cached.raw; base = cached.base; samples = cached.samples; }
	else {
	for (let f = 0; f < count; f += 1) {
		applyRaw(f); raw.push(poseSnapshot(chains, hips)); applyBase(f); base.push(poseSnapshot(chains, hips));
		const row = read(); row.chains = Object.fromEntries([...chains].map(([id, c]) => {
			const p = c.bones.map((b) => b.getWorldPosition(V()));
			return [id, { root: p[0], lengths: [p[0].distanceTo(p[1]), p[1].distanceTo(p[2])], distance: p[0].distanceTo(p[2]) }];
		})); samples.push(row);
		if (f % 12 === 0) { onProgress(Math.round(25 * f / count)); await yieldFrame(); }
	}
	if (cache) cache.value = { schema: 5, rig, motion, stamp, matrixStamp, environmentKey, raw, base, samples };
	}
	timings.sourceMs = performance.now() - started;
	const sourceSamples = samples;
	if (strength <= 0) {
		const contacts = supportIntervals(samples, fps, overrides, floorY, groundAt);
		const metrics = physicsMetrics(samples, contacts.masks, fps, floorY, groundAt);
		onProgress(100);
		const support = supportDiagnostics(samples, fps, floorY);
		metrics.unsupportedFrames = support.unsupportedFrames; metrics.unsupportedGap = support.unsupportedGap;
		metrics.forceResidual = support.forceResidual; metrics.momentResidual = support.momentResidual;
		const warnings = reviewWarnings(metrics, metrics);
		if (!support.frames.some((row) => row.measured) && samples.length) warnings.push({ frame: 0, reason: "support-unmeasured", value: 0 });
		if (support.unsupportedFrames) warnings.push({ frame: support.frames.find((row) => row.measured && !row.flight && row.clearance > .025 && row.forceResidual > .22)?.frame ?? 0, reason: "unsupported", value: support.unsupportedGap });
		return { candidate: source, contacts, before: metrics, after: { ...metrics }, samples, evaluated: samples, support: { before: support, after: support },
			warnings, unresolved: support.unresolved.map(row => ({ frame: row.frame, reason: "support-force", error: row.residual })), changedFrames: [], skippedAir: [], replayErrors: [], flightFrames: [],
			protectedFrames: [...protectedFrames], strength: 0, sourceStamp: stamp, motion, rig, performance: { ...timings, totalMs: performance.now() - started, cacheHit, ...sample.stats } };
	}
	grounding = inferSupportAlignment(samples, fps, { floorY, overrides, protectedFrames, strength: strength * alignmentScale });
	if (grounding.shifts.some((v) => Math.abs(v) > 1e-7)) {
		// Source cache is immutable: options may change without resampling the
		// original. Rebuild only the shifted baseline used by the coupled IK.
		base = []; samples = [];
		for (let f = 0; f < count; f += 1) {
			applyBase(f); base.push(poseSnapshot(chains, hips));
			const row = read(); row.chains = Object.fromEntries([...chains].map(([id, c]) => { const p = c.bones.map((b) => b.getWorldPosition(V())); return [id, { root: p[0], lengths: [p[0].distanceTo(p[1]), p[1].distanceTo(p[2])], distance: p[0].distanceTo(p[2]) }]; })); samples.push(row);
			if (f % 12 === 0) { onProgress(25 + Math.round(5 * f / count)); await yieldFrame(); }
		}
	}
	const contacts = supportIntervals(samples, fps, overrides, floorY, groundAt);
	timings.supportMs = performance.now() - started - timings.sourceMs;
	const preserveFrames = [...new Set([...protectedFrames, ...grounding.flight])];
	// Holden's lock is causal (it starts blending AT contact), which leaves the
	// blend's first frames inside the span as measurable slide. Offline we know
	// every span ahead of time, so start the lock one frame early. One frame is
	// the measured sweet spot on the reference takes: it brings peak in-span
	// slide under the origin baseline, while a 2-3 frame lead trips the knee
	// acceleration gate on x-bot at the preceding foot's release.
	const lockBlendTime = 0.1, lockLead = 1;
	const toeTracks = Object.fromEntries(SUPPORT_SITES.filter((s) => s.kind === "foot").map((site) => {
		const spanAt = (f) => contacts.masks[f].get(site.id) ?? contacts.spans.find((s) => s.site === site.id && f >= s.start - lockLead && f < s.start);
		const leads = samples.map((r, f) => spanAt(f));
		const anchors = leads.map((span, f) => span ? span.anchor.clone().setY(samples[f].toes[site.id].y) : null);
		return [site.id, footLockTrack(samples.map((r) => r.toes[site.id]), leads.map(Boolean), { fps, blendTime: lockBlendTime, anchors })];
	}));
	const influenceAt = (f) => clamp(strength, 0, 1) * Math.min(1, ...preserveFrames.map((p) => smooth(Math.abs(f - p) / 4)));
	const targets = samples.map((r, f) => {
		const out = [];
		for (const site of SUPPORT_SITES) {
			const point = r.support[site.id]; if (!point) continue;
			const supportOnly = alignmentScale > 0 && grounding.frames[f].mode === "align" && grounding.frames[f].hints?.includes(site.id);
			const planted = contacts.masks[f].get(site.id);
			const explicitlyFree = overrides.some((o) => o.site === site.id && o.mode === "free" && f >= o.start && f <= o.end);
			const span = planted ?? (!explicitlyFree && contacts.spans.find((s) => s.site === site.id && f >= s.start - 4 && f <= s.end + 4));
			const localGround = hasSceneGround ? (r.ground?.[site.id] ?? floorY) : floorY;
			if (!span && !supportOnly && point.floor >= localGround + 0.002) continue;
			// Hold the actual support interval; ease in the neighbouring swing
			// frames, not INSIDE the interval where easing is visible foot slip.
			const edge = planted ? 1 : span ? smooth(1 - Math.max(span.start - f, f - span.end) / 5) : 0;
			const toe = r.toes?.[site.id] ?? point.position;
			const target = point.position.clone();
			if (span) {
				const toeTarget = site.kind === "foot" ? toeTracks[site.id][f] : span.anchor;
				target.x += clamp(toeTarget.x - toe.x, -PHYSICS_LIMITS.pull, PHYSICS_LIMITS.pull) * (site.kind === "foot" ? 1 : edge);
				target.z += clamp(toeTarget.z - toe.z, -PHYSICS_LIMITS.pull, PHYSICS_LIMITS.pull) * (site.kind === "foot" ? 1 : edge);
			}
			target.y += clamp(localGround + 0.002 - point.floor, -0.10, 0.15) * (planted || !span ? 1 : edge);
			out.push({ site, target, edge, contact: !!planted, supportOnly, rotation: point.rotation });
		}
		return out;
	});
	const protectedSet = new Set(preserveFrames);
	const seeds = samples.map((r, f) => {
		const active = targets[f];
		const lifts = active.map((t) => t.target.y - r.support[t.site.id].position.y);
		const y = quantile(lifts, 0.5);
		return [0, clamp(y, -0.10, PHYSICS_LIMITS.root), 0, 0, 0];
	});
	let roots = smoothPhysicsTrack(seeds, 4, protectedFrames);
	for (let pass = 0; pass < 2; pass += 1) {
		roots = roots.map((seed, f) => protectedSet.has(f) ? [0, 0, 0, 0, 0] : fitRoot(samples[f], targets[f], seed));
		roots = smoothPhysicsTrack(roots, 2, protectedFrames);
	}
	// Solve a trajectory, not disconnected poses. Smooth the root and swing
	// feet in world space; planted points are exact constraints. Smoothing
	// only the correction quaternion lagged a fast knee swing at release.
	const rootPath = smoothPhysicsTrack(roots.map((r, f) => samples[f].root.toArray().map((v, j) => v + r[j])), 2);
	roots = roots.map((r, f) => protectedSet.has(f) ? [0, 0, 0, 0, 0] : [...rootPath[f].map((v, j) => v - samples[f].root.toArray()[j]), r[3], r[4]]);
	// Relax the TOE offline while keeping the solved pelvis fixed. This absorbs
	// contact drift without replacing the source gait or pulling hips downward.
	await yieldFrame();
	const pelvisPath = samples.map((r, f) => r.root.clone().add(new THREE.Vector3(...roots[f])));
	for (const site of SUPPORT_SITES.filter((s) => s.kind === "foot")) {
		const toeInput = samples.map((r) => r.toes[site.id]);
		const inertialToeTrack = toeTracks[site.id];
		const lowest = hasSceneGround ? Math.min(...samples.map((r) => r.ground?.[site.id] ?? floorY)) : Math.min(...samples.map((r) => r.support[site.id].floor));
		const lowestFrame = hasSceneGround ? samples.findIndex((r) => (r.ground?.[site.id] ?? floorY) === lowest) : samples.findIndex((r) => r.support[site.id].floor === lowest);
		const toeOffset = toeInput[lowestFrame].y - lowest;
		const relaxed = relaxToePath(toeTracks[site.id], pelvisPath, samples.map((r, f) => contacts.masks[f].has(site.id)), {
			iterations: 120, toeMinHeight: hasSceneGround ? samples.map((r) => (r.ground?.[site.id] ?? floorY) + 0.002 - toeOffset) : floorY + 0.002 - toeOffset,
			restLengths: samples.map((r, f) => r.chains[site.chain].root.distanceTo(toeInput[f])), relaxPelvis: false,
		});
		toeTracks[site.id] = relaxed.toes;
		for (let f = 0; f < count; f += 1) {
			const prior = targets[f].find((t) => t.site.id === site.id);
			if (!prior) continue;
			const ankle = samples[f].support[site.id].position, toe = toeInput[f], targetToe = contacts.masks[f].has(site.id) || prior.edge > 0 ? inertialToeTrack[f] : relaxed.toes[f];
			prior.target.x = ankle.x + clamp(targetToe.x - toe.x, -PHYSICS_LIMITS.pull, PHYSICS_LIMITS.pull);
			prior.target.z = ankle.z + clamp(targetToe.z - toe.z, -PHYSICS_LIMITS.pull, PHYSICS_LIMITS.pull);
		}
	}
	await yieldFrame();
	roots = relaxPhysicsRoot(samples, targets, roots, protectedFrames, PHYSICS_LIMITS.root);
	const solutions = [];
	for (let f = 0; f < count; f += 1) {
		applyBase(f);
		if (!protectedSet.has(f)) {
			solveHipsTranslate(fkJoints.get("hips"), new THREE.Vector3(...roots[f]), base[f].hips.p);
			const parent = hips.parent.getWorldQuaternion(Q());
			const world = parent.clone().multiply(hips.quaternion);
			const tilt = Q().setFromEuler(new THREE.Euler(roots[f][3], 0, roots[f][4]));
			hips.quaternion.copy(parent.invert().multiply(tilt.multiply(world))); rig.updateMatrixWorld(true);
			for (const t of targets[f]) {
				const chain = chains.get(t.site.chain), original = base[f].chains.get(t.site.chain);
				if (t.site.kind === "knee") {
					const b = chain.bones[0], a = b.getWorldPosition(V()), d = chain.bones[1].getWorldPosition(V()).sub(a).normalize();
					const rotation = Q().setFromUnitVectors(d, t.target.clone().sub(a).normalize());
					b.quaternion.copy(b.parent.getWorldQuaternion(Q()).invert().multiply(rotation).multiply(b.getWorldQuaternion(Q())));
				} else {
					solveIk({ ...chain, bindPositions: original.map((b) => b.p), lengths: samples[f].chains[t.site.chain].lengths }, t.target, t.site.kind === "foot" ? { maxExtension: samples[f].chains[t.site.chain].distance + 0.01, softening: 0.01 } : undefined);
				}
				// A planted sole/palm keeps its world orientation. Letting the
				// ankle inherit the knee rotation turns a position fix into toe dip.
				const end = chain.bones[2]; rig.updateMatrixWorld(true);
				const desired = t.site.kind === "knee" ? samples[f].support[t.site.chain].rotation : t.rotation;
				end.quaternion.copy(end.parent.getWorldQuaternion(Q()).invert().multiply(desired)); rig.updateMatrixWorld(true);
			}
		}
		solutions.push(poseSnapshot(chains, hips));
		if (f % 12 === 0) { onProgress(30 + Math.round(25 * f / count)); await yieldFrame(); }
	}
	// Filter correction rotations, not the original performance. Key every
	// frame in the candidate so disconnected islands cannot interpolate into
	// a swing or a protected pose. Joint translations remain the source's.
	for (const id of chains.keys()) for (let joint = 0; joint < 3; joint += 1) {
		const radius = id.endsWith("Foot") ? 0 : 2;
		const deltas = solutions.map((s, f) => base[f].chains.get(id)[joint].q.clone().invert().multiply(s.chains.get(id)[joint].q));
		for (let f = 0; f < count; f += 1) {
			let q = deltas[f].clone(), sum = 1;
			for (let d = 1; d <= radius; d += 1) for (const side of [-1, 1]) {
				const i = clamp(f + side * d, 0, count - 1), w = (radius + 1 - d) / (radius + 1);
				q.slerp(deltas[i], w / (sum + w)); sum += w;
			}
			const weight = influenceAt(f);
			q = Q().slerp(q, weight);
			solutions[f].chains.get(id)[joint].q.copy(base[f].chains.get(id)[joint].q).multiply(q);
		}
	}
	const candidate = { keys: copyPhysicsKeys(sourceKeys), tracked: new Set(source.tracked) };
	const after = [], changed = [], unresolved = [], replayErrors = [];
	for (let f = 0; f < count; f += 1) {
		const pose = solutions[f];
		const influence = influenceAt(f);
		pose.hips.p.lerpVectors(base[f].hips.p, pose.hips.p, influence);
		pose.hips.q.slerpQuaternions(base[f].hips.q, pose.hips.q, influence);
		applyBase(f); applySnapshot(pose, rig, chains, hips);
		// Project the temporally filtered solution back onto ALL active support
		// surfaces. A late whole-body lift floats the palms in a crawl; move the
		// pelvis only when the limb cannot reach, then re-solve its supports.
		if (!protectedSet.has(f) && strength > 0) {
			for (let pass = 0; pass < 4; pass += 1) {
				const surfaces = sample(), root = hips.getWorldPosition(V());
				const projection = SUPPORT_SITES.flatMap((site) => {
					const current = surfaces[site.id], original = samples[f].support[site.id];
					const contact = targets[f].find((t) => t.site.id === site.id && (t.contact || t.edge > 0 || t.supportOnly));
					// The swing trajectory already contains its transition ramp.
					// Project onto THAT height, not a second independently faded
					// floor target which can disagree by centimetres at release.
					const localGround = samples[f].ground?.[site.id] ?? floorY;
					const contactFloor = contact ? original.floor + contact.target.y - original.position.y : localGround + .002;
					const wantedFloor = Math.max(
						THREE.MathUtils.lerp(Math.min(original.floor, localGround + .002), localGround + .002, influence),
						THREE.MathUtils.lerp(original.floor, contactFloor, influence),
					);
					if (!current || (!contact && current.floor >= Math.max(wantedFloor, localGround + 0.001))) return [];
					const target = current.position.clone();
					if (contact) { target.x = THREE.MathUtils.lerp(original.position.x, contact.target.x, influence); target.z = THREE.MathUtils.lerp(original.position.z, contact.target.z, influence); }
					target.y += clamp(wantedFloor - current.floor, -PHYSICS_LIMITS.pull, PHYSICS_LIMITS.pull);
					return [{ site, target, rotation: original.rotation }];
				});
				const currentSample = { root, chains: Object.fromEntries([...chains].map(([id, c]) => {
					const points = c.bones.map((b) => b.getWorldPosition(V()));
					return [id, { root: points[0], lengths: samples[f].chains[id].lengths, distance: samples[f].chains[id].distance }];
				})) };
				const delta = fitRoot(currentSample, projection, [0, 0, 0, 0, 0], false);
				const offset = root.clone().add(new THREE.Vector3(...delta)).sub(samples[f].root).clampLength(0, PHYSICS_LIMITS.root * influence);
				const safeDelta = samples[f].root.clone().add(offset).sub(root);
				solveHipsTranslate(fkJoints.get("hips"), safeDelta, hips.position.clone());
				for (const t of projection) {
					const c = chains.get(t.site.chain);
					if (t.site.kind === "knee") {
						const b = c.bones[0], a = b.getWorldPosition(V()), d = c.bones[1].getWorldPosition(V()).sub(a).normalize();
						const rotation = Q().setFromUnitVectors(d, t.target.clone().sub(a).normalize());
						b.quaternion.copy(b.parent.getWorldQuaternion(Q()).invert().multiply(rotation).multiply(b.getWorldQuaternion(Q())));
					} else solveIk({ ...c, bindPositions: base[f].chains.get(t.site.chain).map((b) => b.p), lengths: samples[f].chains[t.site.chain].lengths }, t.target, t.site.kind === "foot" ? { maxExtension: samples[f].chains[t.site.chain].distance + 0.01, softening: 0.01 } : undefined);
					rig.updateMatrixWorld(true);
					const end = c.bones[2], rotation = t.site.kind === "knee" ? samples[f].support[t.site.chain].rotation : t.rotation;
					end.quaternion.copy(end.parent.getWorldQuaternion(Q()).invert().multiply(rotation)); rig.updateMatrixWorld(true);
				}
			}
		}
		const finalPose = poseSnapshot(chains, hips);
		const projected = read();
		let changedFrame = Math.abs(grounding.shifts[f]) > 1e-5 || finalPose.hips.p.distanceTo(base[f].hips.p) > 1e-5 || finalPose.hips.q.angleTo(base[f].hips.q) > 1e-5;
		const entry = candidate.keys.get(f) ?? new Map();
		entry.set("hips", { q: [finalPose.hips.q], p: finalPose.hips.p, baseQ: [raw[f].hips.q], basePos: raw[f].hips.p }); candidate.tracked.add("hips");
		for (const [id, values] of finalPose.chains) {
			if (values.some((v, i) => v.q.angleTo(base[f].chains.get(id)[i].q) > 1e-5)) changedFrame = true;
			entry.set(id, { q: values.map((v) => v.q), p: null, baseQ: raw[f].chains.get(id).map((b) => b.q), chainP: values.map((v) => v.p), keepTranslations: true }); candidate.tracked.add(id);
		}
		candidate.keys.set(f, entry);
		if (changedFrame) changed.push(f);
		applyRaw(f); ikEvaluate(chains, candidate, f, fkJoints, 6); const row = read(); after.push(row);
		const replayError = Math.max(...SUPPORT_SITES.map((s) => Math.abs(row.support[s.id].floor - projected.support[s.id].floor)));
		if (replayError > 1e-5) replayErrors.push({ frame: f, error: replayError, expected: projected, actual: row });
		for (const t of targets[f].filter((t) => t.contact)) {
			const surface = row.support[t.site.id], error = surface.position.distanceTo(t.target);
			if (error > 0.03) unresolved.push({ frame: f, site: t.site.id, reason: "contact-residual", error });
		}
		if (f % 12 === 0) { onProgress(55 + Math.round(25 * f / count)); await yieldFrame(); }
	}
	await refinePhysicsCandidate({ rig, chains, fkJoints, samples, after, contacts, candidate, base, roots,
		sites: SUPPORT_SITES, applyRaw, read, strength, protectedFrames: preserveFrames, yieldFrame, floorY, onProgress });
	// Exact all-body safety projection after temporal IK. A smooth upper
	// envelope clears small residual penetrations without a one-frame lift;
	// it changes no joint angles or planted XZ position. Protected/flight
	// frames remain source-exact and retain any unresolved warning.
	const clearance = after.map((r) => Math.max(0, Math.max(...Object.entries(r.support).filter(([, p]) => p.vertices > 0).map(([id, p]) => (r.ground?.[id] ?? floorY) + .001 - p.floor))));
	const liftRadius = Math.max(3, Math.round(fps * .2));
	for (let f = 0; f < count; f += 1) {
		if (protectedSet.has(f)) continue;
		let lift = 0;
		for (let i = Math.max(0, f - 3 * liftRadius); i <= Math.min(count - 1, f + 3 * liftRadius); i += 1) lift = Math.max(lift, Math.min(.06, clearance[i]) * Math.exp(-(((f - i) / liftRadius) ** 2)));
		lift *= influenceAt(f);
		if (lift > 1e-6) {
			applyRaw(f); ikEvaluate(chains, candidate, f, fkJoints, 6);
			solveHipsTranslate(fkJoints.get("hips"), new THREE.Vector3(0, lift, 0), hips.position.clone());
			candidate.keys.get(f).get("hips").p.copy(hips.position);
			applyRaw(f); ikEvaluate(chains, candidate, f, fkJoints, 6); after[f] = read();
			changed.push(f);
		}
		if (f % 12 === 0) await yieldFrame();
	}
	onProgress(98);
	// Already-ballistic CoM motion is evidence to preserve, not a trajectory
	// to refit with a different endpoint taper. Uncertain unsupported motion
	// stays in the support diagnostics instead of being declared a jump.
	const air = { keyedFrames: [], skippedSpans: [] };
	const beforeSupport = supportDiagnostics(sourceSamples, fps, floorY), afterSupport = supportDiagnostics(after, fps, floorY);
	const beforeMetrics = { ...physicsMetrics(sourceSamples, contacts.masks, fps, floorY, groundAt), unsupportedFrames: beforeSupport.unsupportedFrames, unsupportedGap: beforeSupport.unsupportedGap, forceResidual: beforeSupport.forceResidual, momentResidual: beforeSupport.momentResidual };
	const afterMetrics = { ...physicsMetrics(after, contacts.masks, fps, floorY, groundAt), unsupportedFrames: afterSupport.unsupportedFrames, unsupportedGap: afterSupport.unsupportedGap, forceResidual: afterSupport.forceResidual, momentResidual: afterSupport.momentResidual };
	// Report the final evaluated surfaces, including protected or unreachable
	// contacts, not the residual of an earlier solve that has since changed.
	unresolved.length = 0;
	for (let f = 0; f < count; f += 1) for (const site of SUPPORT_SITES) {
		const point = after[f].support[site.id], span = contacts.masks[f].get(site.id);
		if (!point) continue;
		const localGround = after[f].ground?.[site.id] ?? floorY;
		if (localGround - point.floor > PHYSICS_LIMITS.floor) unresolved.push({ frame: f, site: site.id, reason: "floor", error: localGround - point.floor });
		if (span && point.floor - localGround > PHYSICS_LIMITS.float) unresolved.push({ frame: f, site: site.id, reason: "float", error: point.floor - localGround });
		// Anchors are TOE points for feet, so measure drift from the same point
		// physicsMetrics uses; the ankle sits ~14 cm behind the toe anchor.
		const drifted = sitePoint(after[f], site);
		const drift = span ? Math.hypot(drifted.x - span.anchor.x, drifted.z - span.anchor.z) : 0;
		if (drift > PHYSICS_LIMITS.slide) unresolved.push({ frame: f, site: site.id, reason: "slide", error: drift });
	}
	const warnings = reviewWarnings(beforeMetrics, afterMetrics, replayErrors);
	if (afterSupport.unsupportedFrames) warnings.push({ frame: afterSupport.frames.find((f) => f.measured && !f.flight && f.clearance > .025 && f.forceResidual > .22).frame, reason: "unsupported", value: afterSupport.unsupportedGap });
	for (const row of afterSupport.unresolved) unresolved.push({ frame: row.frame, reason: "support-force", error: row.residual });
	onProgress(100);
	return { candidate, contacts, before: beforeMetrics, after: afterMetrics, samples: sourceSamples, evaluated: after, warnings, unresolved, support: { before: beforeSupport, after: afterSupport, alignment: grounding.frames, shifts: [...grounding.shifts] },
		changedFrames: [...new Set([...changed, ...(strength > 0 ? air.keyedFrames : [])])], skippedAir: air.skippedSpans,
		protectedFrames: [...protectedFrames], strength, sourceStamp: physicsKeyStamp(sourceKeys), motion, rig,
		replayErrors,
		flightFrames: strength > 0 ? air.keyedFrames : [],
		performance: { ...timings, totalMs: performance.now() - started, cacheHit, ...sample.stats },
	};
}

/** Bounded whole-clip QA/backtracking, not per-pose exceptions. If a stronger
 * support hypothesis regresses motion continuity, compare a gentler candidate
 * using the same cached original. Never silently call a failed candidate clean. */
export async function reviewAutoPhysics(options) {
	const start = performance.now(), cache = options.cache ?? { value: null }, progress = options.onProgress ?? (() => {});
	let best = null, bestScore = Infinity, attempts = 0, initialCacheHit = false, sourceMs = 0, supportMs = 0;
	const scales = options.alignmentScale !== undefined ? [options.alignmentScale] : [1, .5, 0];
	for (const scale of scales) {
		const attempt = attempts++, lo = [0, 85, 94][attempt], range = [85, 9, 5][attempt];
		const result = await reviewCandidate({ ...options, cache, alignmentScale: scale, onProgress: (p) => progress(Math.round(lo + p * range / 100)) });
		if (attempt === 0) initialCacheHit = result.performance.cacheHit;
		sourceMs += result.performance.sourceMs; supportMs += result.performance.supportMs ?? 0;
		const b = result.before, a = result.after;
		const safe = a.penetration <= PHYSICS_LIMITS.floor && a.slide <= PHYSICS_LIMITS.slide && a.float <= PHYSICS_LIMITS.float
			&& a.kneeAcceleration <= Math.max(1e-6, b.kneeAcceleration * 1.1) && a.rootAcceleration <= Math.max(1e-6, b.rootAcceleration * 1.1);
		// Compare severity, not a binary pass flag: a sub-millimetre contact
		// miss must not win by restoring an entire floating body. Keep every
		// remaining limit violation visible in warnings/unresolved.
		const excess = (value, limit) => Math.max(0, value / limit - 1);
		const score = 10 * (a.unsupportedFrames ?? 0)
			+ 100 * excess(a.penetration, PHYSICS_LIMITS.floor)
			+ 20 * (excess(a.slide, PHYSICS_LIMITS.slide) + excess(a.float, PHYSICS_LIMITS.float))
			+ 100 * (excess(a.kneeAcceleration, Math.max(1e-6, b.kneeAcceleration * 1.1)) + excess(a.rootAcceleration, Math.max(1e-6, b.rootAcceleration * 1.1)))
			+ a.kneeAcceleration / Math.max(1, b.kneeAcceleration);
		if (score < bestScore) { best = result; bestScore = score; best.performance.alignmentScale = scale; }
		// Weaker alignment can repair overshoot/continuity, but cannot fill a
		// remaining gap (especially a user-protected floating pose). Do not
		// rerun the entire clip for an immutable or under-corrected contact.
		const needsRelaxation = a.penetration > PHYSICS_LIMITS.floor
			|| a.kneeAcceleration > Math.max(1e-6, b.kneeAcceleration * 1.1)
			|| a.rootAcceleration > Math.max(1e-6, b.rootAcceleration * 1.1);
		if (safe || !needsRelaxation || options.strength === 0) break;
	}
	best.performance.totalMs = performance.now() - start; best.performance.attempts = attempts;
	best.performance.cacheHit = initialCacheHit; best.performance.sourceMs = sourceMs; best.performance.supportMs = supportMs;
	progress(100);
	return best;
}
