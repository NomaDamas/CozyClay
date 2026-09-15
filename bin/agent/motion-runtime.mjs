import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { MAX_ACTIVE_MOTION_JOBS, MAX_ACTIVE_MOTION_JOBS_PER_WORKSPACE, MOTION_JOB_TTL_MS } from "../../mcp/live-hub.mjs";
import { normalizePhases } from "../../mcp/ardy-prompts.mjs";
import { compileStudioBeats, validateStudioCommand, validateStudioIdentity, validateTargetGuard, validateReceipt, freezeStudioData, StudioProtocolError } from "../../src/studio-agent-protocol.js";
import { motionPreflightReason } from "../../src/analytics.js";

const precommit = ["queued", "generating", "preparing", "verifying", "repairing"];
const rejected = ["failed", "cancelled", "stale_target", "stale_environment"];
export const MOTION_TRANSITIONS = freezeStudioData({
	queued: ["generating", ...rejected], generating: ["preparing", ...rejected],
	preparing: ["verifying", ...rejected], verifying: ["repairing", "committing", "review_required", ...rejected],
	repairing: ["verifying", ...rejected], committing: ["installed", "reconciling", ...rejected.filter(s => s !== "cancelled")],
	reconciling: ["installed", "proved-not-applied"], installed: [], "proved-not-applied": [],
	// Only the explicit trusted accept action may leave review_required for a new verification.
	review_required: ["verifying", "cancelled", "stale_target", "stale_environment", "failed"],
	failed: [], cancelled: [], stale_target: [], stale_environment: [],
});
export const MOTION_STATES = Object.freeze(Object.keys(MOTION_TRANSITIONS));
export function assertMotionTransition(from, to) {
	if (!MOTION_TRANSITIONS[from]?.includes(to)) throw new Error(`Illegal motion transition ${from} -> ${to}`);
}
const active = state => precommit.includes(state) || state === "committing" || state === "reconciling";
const motionUrlPattern = /^\/(ardy\/motions\/[0-9]+-[0-9a-f]{6}|ardy\/assembled\/[A-Za-z0-9._-]+\.npz)$/;
const error = (code, message) => new StudioProtocolError(code, message);
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_RECORDS = 256;
const MAX_EVENTS = 256;

/** Shared by legacy MCP and Studio. EOF is a record boundary, not a success signal. */
export function extractNdjsonRecords(buffer, { final = false } = {}) {
	if (typeof buffer !== "string") throw new TypeError("NDJSON buffer must be a string");
	const lines = buffer.split("\n");
	const remainder = final ? "" : lines.pop();
	const records = [];
	for (const line of lines) {
		if (Buffer.byteLength(line) > MAX_RECORD_BYTES) throw error("BACKEND_UNAVAILABLE", "Bridge record exceeds limit");
		if (line.trim()) {
			try { records.push(JSON.parse(line)); }
			catch { throw error("BACKEND_UNAVAILABLE", final ? "Malformed final NDJSON record" : "Malformed NDJSON record"); }
		}
	}
	if (Buffer.byteLength(remainder) > MAX_RECORD_BYTES) throw error("BACKEND_UNAVAILABLE", "Bridge record exceeds limit");
	return { records, remainder };
}
export async function readMotionStream(response, { onProgress = () => {} } = {}) {
	if (!response.ok || !response.body) throw error("BACKEND_UNAVAILABLE", `Generation refused (HTTP ${response.status})`);
	const reader = response.body.getReader(); const decoder = new TextDecoder("utf-8", { fatal: true });
	let buffer = "", motionUrl = null, finished = false;
	try {
		for (;;) {
			const chunk = await reader.read();
			buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
			const parsed = extractNdjsonRecords(buffer, { final: chunk.done }); buffer = parsed.remainder;
			for (const record of parsed.records) {
				if (!record || typeof record !== "object" || typeof record.event !== "string") throw error("BACKEND_UNAVAILABLE", "Invalid bridge record");
				if (record.event === "error") throw error("BACKEND_UNAVAILABLE", "Generator reported an error");
				if (record.event === "done") {
					if (typeof record.motionUrl !== "string" || !motionUrlPattern.test(record.motionUrl)) throw error("BACKEND_UNAVAILABLE", "Generator returned an invalid motion URL");
					if (motionUrl && motionUrl !== record.motionUrl) throw error("BACKEND_UNAVAILABLE", "Conflicting final artifacts");
					motionUrl = record.motionUrl;
				} else if (Number.isFinite(record.progress)) onProgress(record.progress);
			}
			if (chunk.done) { finished = true; break; }
		}
		if (!motionUrl) throw error("BACKEND_UNAVAILABLE", "Generation ended without a motion");
		return motionUrl;
	} finally {
		try { if (!finished) await reader.cancel(); } finally { reader.releaseLock(); }
	}
}
function pinOrigin(value) {
	if (!value) throw error("BACKEND_UNAVAILABLE", "Owned motion bridge is unavailable");
	let url; try { url = new URL(value); } catch { throw error("BACKEND_UNAVAILABLE", "Invalid owned bridge origin"); }
	if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw error("BACKEND_UNAVAILABLE", "Expected owned loopback bridge origin");
	return url.origin;
}
const identifier = value => typeof value === "string" && value.length > 0 && value.length <= 128;

/** Task 6 supplies this single owner its existing liveHub and launcher getter.
 * No model polling, provider calls, second installer, or execution telemetry emitter. */
export function createStudioMotionRuntime({ liveHub, getBridgeOrigin, clock = Date.now, ttlMs = MOTION_JOB_TTL_MS, generationMs = 300000, preparationMs = 30000, verificationMs = 60000 } = {}) {
	const jobs = new Map(), records = new Map(), artifacts = new Map();
	let disposed = false;
	const snapshot = job => freezeStudioData({ jobId: job.jobId, commandId: job.input.commandId, state: job.state, eventSeq: job.eventSeq, outcome: job.outcome, artifactId: job.artifact?.artifactId ?? null });
	const handle = job => {
		const h = liveHub?.handleForWorkspaceId(job.host.workspaceId);
		if (!h) throw error("LIVE_HUB_UNAVAILABLE", "Bound live workspace is unavailable");
		return h;
	};
	const emit = (job, type, progress = null) => {
		const event = Object.freeze({ type, eventSeq: ++job.eventSeq, jobId: job.jobId, commandId: job.input.commandId, turnId: job.input.turnId, state: job.state, phase: job.state, progress });
		job.events.push(event); if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
		for (const listener of [...job.listeners]) listener(event);
	};
	const transition = (job, state) => { assertMotionTransition(job.state, state); job.state = state; job.updatedAt = clock(); emit(job, "job.state"); };
	const remember = (job, outcome) => { job.outcome = freezeStudioData(structuredClone(outcome)); records.get(job.input.commandId).outcome = job.outcome; return job.outcome; };
	const failure = (job, code, mutated = false) => ({ ok: false, commandId: job.input.commandId, host: job.host, code, phase: job.state === "reconciling" ? "reconcile" : "execution", affectedIds: [job.input.characterId], expectedTargets: [job.guard], currentTargets: [], mutated, preserved: { authoredState: mutated === "unknown" ? "unknown" : "unchanged" }, recovery: { action: mutated === "unknown" ? "reconcile" : "new_intent", retryAllowed: false } });
	const command = async (job, name, args = {}) => {
		const value = await liveHub.command(name, { commandId: job.input.commandId, binding: job.binding, ...args }, handle(job));
		if (value?.ok === false && value.mutated === false) throw error(value.code ?? "VERIFICATION_FAILED", "Editor rejected motion command");
		return value;
	};
	const fence = job => { if (job.cancelRequested) throw error("CANCELLED", "Installation permission revoked"); job.controller.signal.throwIfAborted(); };
	const checkTarget = (job, targetToken) => validateTargetGuard(job.guard, { ...job.guard, token: targetToken });
	const discard = async job => {
		if (!job.candidate || job.discarded || job.state === "reconciling" || job.state === "committing") return;
		await command(job, "discard_motion_candidate", { candidateId: job.candidate.candidateId }); job.discarded = true;
	};
	const verify = async job => {
		transition(job, "verifying"); fence(job);
		const v = await command(job, "verify_motion_candidate", { candidateId: job.candidate.candidateId, candidateRevision: job.candidate.candidateRevision, profile: "studio-motion-v1" });
		fence(job); checkTarget(job, v.targetToken);
		if (v.candidateId !== job.candidate.candidateId || v.candidateRevision !== job.candidate.candidateRevision || !identifier(v.verificationId) || !v.structurallyValid) throw error("VERIFICATION_FAILED", "Invalid candidate verification");
		job.verification = v;
		return v;
	};
	const installed = (job, receipt) => {
		receipt = validateReceipt(receipt);
		if (!receipt?.ok || receipt.status !== "installed" || receipt.commandId !== job.input.commandId || receipt.jobId !== job.jobId || receipt.artifactId !== job.artifact.artifactId || receipt.installed?.frameCount !== job.schedule.frameCount || receipt.verification?.id !== job.verification.verificationId || !identifier(receipt.receiptId) || receipt.installed?.characterId !== job.input.characterId || !isDeepStrictEqual(receipt.host, job.host)) throw error("UNCERTAIN_APPLY", "Uncorrelated installation receipt");
		remember(job, receipt); transition(job, "installed"); job.motionRequest?.apply(); return job.outcome;
	};
	const reconcile = async job => {
		if (job.state !== "reconciling") return job.outcome;
		let value;
		try { value = await command(job, "reconcile_studio_command"); }
		catch (e) { job.reconcileError = e.message; return remember(job, failure(job, "UNCERTAIN_APPLY", "unknown")); }
		if (value?.status === "applied" && value.receipt) {
			try { return installed(job, value.receipt); } catch (e) { job.reconcileError = e.message; }
		} else if (value?.status === "not_applied" && value.evidence) {
			transition(job, "proved-not-applied"); return remember(job, failure(job, "CANCELLED"));
		}
		return remember(job, failure(job, "UNCERTAIN_APPLY", "unknown"));
	};
	const commit = async (job, explicitUnverifiedAcceptance = false) => {
		fence(job); transition(job, "committing");
		try {
			const receipt = await command(job, "commit_motion_candidate", { jobId: job.jobId, artifactId: job.artifact.artifactId, candidateId: job.candidate.candidateId, candidateRevision: job.candidate.candidateRevision, expectedTargetToken: job.input.targetToken, expectedPhysicsRevision: job.verification.physicsRevision, verificationId: job.verification.verificationId, explicitUnverifiedAcceptance });
			return installed(job, receipt);
		} catch (e) {
			if (["STALE_TARGET", "STALE_ENVIRONMENT", "STALE_SCENE", "VERIFICATION_FAILED", "CANCELLED"].includes(e.code)) {
				transition(job, e.code === "STALE_TARGET" ? "stale_target" : ["STALE_ENVIRONMENT", "STALE_SCENE"].includes(e.code) ? "stale_environment" : "failed");
				return remember(job, failure(job, e.code));
			}
			transition(job, "reconciling"); return reconcile(job);
		}
	};
	async function generate(job) {
		const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(generationMs)]);
		let health;
		try { const res = await fetch(`${job.origin}/ardy/health`, { signal }); health = { ...await res.json(), ok: res.ok }; }
		catch (e) { if (job.cancelRequested) throw e; throw error("BACKEND_UNAVAILABLE", "Owned motion bridge is unreachable"); }
		job.motionRequest?.preflight(health, { body: job.body });
		if (motionPreflightReason(health, { body: job.body })) throw error("BACKEND_UNAVAILABLE", "Bridge preflight rejected motion generation");
		fence(job); job.motionRequest?.start();
		const res = await fetch(`${job.origin}/ardy/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(job.body), signal });
		const url = await readMotionStream(res, { onProgress: progress => { if (!job.cancelRequested) emit(job, "job.progress", progress); } });
		fence(job); job.motionRequest?.succeed();
		job.artifact = freezeStudioData({ artifactId: randomUUID(), url: new URL(url, job.origin).href, schedule: job.schedule, host: job.host, origin: job.origin, expiresAt: clock() + ttlMs });
		artifacts.set(job.artifact.artifactId, job.artifact);
	}
	async function execute(job) {
		let timer;
		try {
			fence(job); transition(job, "generating"); if (!job.artifact) await generate(job);
			fence(job); transition(job, "preparing");
			timer = setTimeout(() => job.controller.abort(error("VERIFICATION_FAILED", "Preparation deadline exceeded")), preparationMs);
			job.candidate = await command(job, "prepare_motion_install", { jobId: job.jobId, artifactId: job.artifact.artifactId, artifact: { artifactId: job.artifact.artifactId, url: job.artifact.url }, schedule: job.schedule, stagingPolicy: "preserve-target-anchor" });
			clearTimeout(timer); fence(job);
			if (!identifier(job.candidate?.candidateId) || !Number.isSafeInteger(job.candidate.candidateRevision) || !job.candidate.structurallyValid) throw error("VERIFICATION_FAILED", "Invalid private candidate");
			checkTarget(job, job.candidate.targetToken);
			timer = setTimeout(() => job.controller.abort(error("VERIFICATION_FAILED", "Verification deadline exceeded")), verificationMs);
			let v = await verify(job);
			if (job.input.repair === "bounded") for (const method of ["auto_physics", "fix_collisions"]) {
				if (v.status === "verified" || !v.repairable) break;
				transition(job, "repairing"); fence(job);
				job.candidate = await command(job, "repair_motion_candidate", { candidateId: job.candidate.candidateId, candidateRevision: job.candidate.candidateRevision, method, protectedFrames: [] });
				fence(job); checkTarget(job, job.candidate.targetToken); v = await verify(job);
			}
			clearTimeout(timer); fence(job);
			if (v.status !== "verified") { transition(job, "review_required"); return remember(job, { ok: false, status: "review_required", commandId: job.input.commandId, jobId: job.jobId, artifactId: job.artifact.artifactId, candidateId: job.candidate.candidateId, mutated: false, verification: v }); }
			return await commit(job);
		} catch (e) {
			if (job.state === "committing" || job.state === "reconciling") { if (job.state === "committing") transition(job, "reconciling"); return reconcile(job); }
			const code = job.cancelRequested ? "CANCELLED" : e.code ?? "BACKEND_UNAVAILABLE";
			if (!rejected.includes(job.state)) transition(job, code === "CANCELLED" ? "cancelled" : code === "STALE_TARGET" ? "stale_target" : ["STALE_ENVIRONMENT", "STALE_SCENE"].includes(code) ? "stale_environment" : "failed");
			job.motionRequest?.fail(e, job.cancelRequested ? "aborted" : undefined);
			return remember(job, failure(job, code));
		} finally { clearTimeout(timer); if (job.state !== "review_required") await discard(job); }
	}
	const getJob = id => { const job = jobs.get(id); if (!job) throw error("STALE_TARGET", "Motion job unavailable or expired"); return job; };
	return {
		admit(input) {
			if (disposed) throw error("CAPABILITY_MISSING", "Motion runtime disposed");
			const { motionRequest, ...data } = input;
			const prior = records.get(data.commandId);
			if (prior) { if (!isDeepStrictEqual(prior.input, data)) throw error("INVALID_ARGUMENT", "Command identity cannot change"); return prior.admission; }
			if (records.size >= MAX_RECORDS) throw error("TARGET_BUSY", "Motion receipt capacity reached; release retired history receipts");
			const host = validateStudioIdentity(Object.fromEntries(["workspaceId", "documentEpoch", "sceneId", "sceneEpoch"].map(k => [k, data.hostBinding?.[k]])));
			if (!liveHub || !data.hostBinding?.workspaceHandle || liveHub.workspaceId(liveHub.resolveWorkspace("generate_motion", data.hostBinding.workspaceHandle)) !== host.workspaceId) throw error("LIVE_HUB_UNAVAILABLE", "Exact live workspace is required");
			if (![data.turnId, data.commandId, data.characterId, data.targetToken, data.authorization?.id].every(identifier)) throw error("INVALID_ARGUMENT", "Motion identity and authorization required");
			if (data.authorization.generations !== 1 || [...records.values()].some(r => r.input.authorization.id === data.authorization.id)) throw error("AUTH_REQUIRED", "Generation authorization already used or invalid");
			const pending = [...jobs.values()].filter(j => active(j.state));
			if (pending.length >= MAX_ACTIVE_MOTION_JOBS) throw error("TARGET_BUSY", "Motion global capacity reached (2)");
			if (pending.filter(j => j.host.workspaceId === host.workspaceId).length >= MAX_ACTIVE_MOTION_JOBS_PER_WORKSPACE) throw error("TARGET_BUSY", "Workspace motion capacity reached (1)");
			const validated = validateStudioCommand({ name: "generate_motion", args: { characterId: data.characterId, source: data.source, repair: data.repair ?? "bounded" } }).args;
			let artifact, schedule, body;
			let origin = pinOrigin(getBridgeOrigin?.());
			if (validated.source.kind === "generate") {
				const normalized = normalizePhases(validated.source.beats.map(b => b.text));
				if (normalized.dropped || normalized.texts.length !== validated.source.beats.length || normalized.texts.some(t => !t.trim())) throw error("INVALID_ARGUMENT", "Motion beats cannot be dropped by normalization");
				schedule = compileStudioBeats({ ...validated.source, beats: validated.source.beats.map((b, i) => ({ ...b, text: normalized.texts[i] })) });
				body = { prompt: schedule.blocks.map(b => b.text).join(" "), duration: schedule.durationSeconds, posePin: false, ...(validated.source.seed === undefined ? {} : { seed: validated.source.seed }) };
				if (schedule.blocks.length > 1) body.segments = schedule.blocks.map(b => ({ prompt: b.text, startFrame: b.startFrame, endFrame: b.endFrameExclusive }));
			} else {
				artifact = artifacts.get(validated.source.artifactId);
				if (!artifact || artifact.expiresAt < clock() || !isDeepStrictEqual(artifact.host, host)) throw error("STALE_TARGET", "Owned artifact unavailable in this document");
				origin = artifact.origin; schedule = artifact.schedule;
			}
			const guard = { ...host, targetId: data.characterId, token: data.targetToken }; validateTargetGuard(guard, guard);
			const job = { jobId: randomUUID(), input: freezeStudioData(structuredClone({ ...data, repair: validated.repair })), host, guard, binding: { host, characterId: data.characterId, targetToken: data.targetToken }, motionRequest: artifact ? null : motionRequest, artifact, schedule, body, origin, state: "queued", eventSeq: 0, events: [], listeners: new Set(), controller: new AbortController(), updatedAt: clock(), outcome: null, promise: null };
			const admission = Object.freeze({ jobId: job.jobId, commandId: data.commandId, state: "queued" });
			records.set(data.commandId, { input: structuredClone(data), admission, authorization: data.authorization, outcome: null, retained: true });
			jobs.set(job.jobId, job); emit(job, "job.state"); return admission;
		},
		subscribe(id, listener, { after = 0 } = {}) {
			const job = getJob(id); if (!Number.isSafeInteger(after) || after < 0 || typeof listener !== "function") throw error("INVALID_ARGUMENT", "Invalid event subscription");
			let last = after; const deliver = event => { if (event.eventSeq > last) { last = event.eventSeq; listener(event); } };
			job.listeners.add(deliver);
			try { for (const event of [...job.events]) deliver(event); } catch (e) { job.listeners.delete(deliver); throw e; }
			return () => job.listeners.delete(deliver);
		},
		start(id) {
			const job = getJob(id); if (job.promise) return job.promise;
			if (!job.listeners.size) throw error("INVALID_ARGUMENT", "Subscribe before starting motion work");
			job.promise = Promise.resolve().then(() => execute(job)); return job.promise;
		},
		async stop(id) {
			const job = getJob(id);
			if (job.state === "installed") return { status: "already_applied", receipt: job.outcome };
			if (job.state === "committing" || job.state === "reconciling") {
				try { await command(job, "cancel_motion_install"); }
				catch (e) { job.reconcileError = e.message; /* Reconciliation below preserves unknown, never cancellation proof. */ }
				if (job.state === "committing") await job.promise;
				const outcome = job.state === "installed" ? job.outcome : await reconcile(job);
				return outcome?.status === "installed" ? { status: "already_applied", receipt: outcome } : outcome;
			}
			if (rejected.includes(job.state) || job.state === "proved-not-applied") return job.outcome;
			job.cancelRequested = true; job.controller.abort(error("CANCELLED", "User stopped motion job"));
			if (job.promise && active(job.state)) await job.promise;
			else { transition(job, "cancelled"); remember(job, failure(job, "CANCELLED")); await discard(job); }
			return { status: "cancelled", ...job.outcome };
		},
		async reconcile(id) { return reconcile(getJob(id)); },
		async accept(id) {
			const job = getJob(id);
			if (job.state !== "review_required" || job.accepting) throw error("INVALID_ARGUMENT", "Candidate is not awaiting explicit acceptance");
			if (clock() - job.updatedAt > ttlMs) throw error("STALE_TARGET", "Review candidate expired");
			const pending = [...jobs.values()].filter(j => active(j.state));
			if (pending.length >= MAX_ACTIVE_MOTION_JOBS || pending.some(j => j.host.workspaceId === job.host.workspaceId)) throw error("TARGET_BUSY", "Motion acceptance capacity reached");
			job.accepting = true;
			try { await verify(job); return await commit(job, true); }
			catch (e) {
				transition(job, e.code === "STALE_TARGET" ? "stale_target" : e.code === "STALE_ENVIRONMENT" ? "stale_environment" : "failed");
				remember(job, failure(job, e.code ?? "VERIFICATION_FAILED"));
				throw e;
			} finally { job.accepting = false; await discard(job); }
		},
		get(id) { const job = jobs.get(id); return job ? snapshot(job) : null; },
		getReceipt(commandId) { return records.get(commandId)?.outcome ?? null; },
		releaseReceipt(commandId) { const record = records.get(commandId); if (record) { record.retained = false; record.expiresAt = clock() + ttlMs; } },
		async cleanup() {
			for (const [id, job] of jobs) if (!active(job.state) && clock() - job.updatedAt > ttlMs) { await discard(job); job.listeners.clear(); jobs.delete(id); }
			for (const [id, artifact] of artifacts) if (artifact.expiresAt < clock() && ![...jobs.values()].some(j => j.artifact === artifact)) artifacts.delete(id);
			for (const [id, record] of records) if (!record.retained && record.expiresAt < clock() && !jobs.has(record.admission.jobId)) records.delete(id);
		},
		async dispose() {
			disposed = true;
			for (const job of jobs.values()) {
				if (precommit.includes(job.state) || job.state === "review_required") await this.stop(job.jobId);
				if (job.promise) await job.promise;
				await discard(job); job.listeners.clear();
			}
		},
	};
}
