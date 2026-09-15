import { randomUUID } from "node:crypto";

// Small, host-agnostic Studio motion job runtime. The editor owns commit/undo;
// this module owns admission, cancellation fencing, bounded retention and receipts.
export const MOTION_STATES = Object.freeze(["queued", "running", "committing", "completed", "failed", "cancelled"]);
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export function extractNdjsonRecords(buffer, { final = false } = {}) {
	if (typeof buffer !== "string") throw new TypeError("NDJSON buffer must be a string");
	const records = [];
	let rest = buffer;
	for (;;) {
		const newline = rest.indexOf("\n");
		if (newline < 0) break;
		const line = rest.slice(0, newline).trim(); rest = rest.slice(newline + 1);
		if (!line) continue;
		try { records.push(JSON.parse(line)); } catch (error) { throw new Error(`Malformed NDJSON record: ${error.message}`); }
	}
	if (final && rest.trim()) {
		try { records.push(JSON.parse(rest.trim())); } catch (error) { throw new Error(`Malformed final NDJSON record: ${error.message}`); }
		rest = "";
	}
	return { records, remainder: rest };
}

export function createMotionRuntime({ bridgeOrigin, authorize = async () => {}, clock = () => Date.now(), maxJobs = 2, ttlMs = 600000 } = {}) {
	if (typeof bridgeOrigin !== "string" || !/^https?:\/\//.test(bridgeOrigin)) throw new TypeError("bridgeOrigin must be an http(s) origin");
	const jobs = new Map(); const receipts = new Map();
	const trim = () => { for (const [id, job] of jobs) if (TERMINAL.has(job.state) && clock() - job.updatedAt > ttlMs) jobs.delete(id); while (jobs.size > maxJobs) { const first = jobs.values().find((j) => TERMINAL.has(j.state)); if (!first) break; jobs.delete(first.id); } };
	const transition = (job, state, extra = {}) => { if (!MOTION_STATES.includes(state)) throw new Error(`Invalid motion state ${state}`); if (TERMINAL.has(job.state)) return job; job.state = state; job.updatedAt = clock(); Object.assign(job, extra); if (TERMINAL.has(state)) receipts.set(job.id, Object.freeze({ ...job })); return job; };
	return {
		bridgeOrigin,
		create({ workspaceId, characterId, token, run }) {
			trim(); if (typeof workspaceId !== "string" || typeof characterId !== "string" || typeof token !== "string") throw new Error("workspaceId, characterId and token are required");
			if ([...jobs.values()].some((j) => !TERMINAL.has(j.state) && j.workspaceId === workspaceId)) throw new Error("TARGET_BUSY");
			if ([...jobs.values()].filter((j) => !TERMINAL.has(j.state)).length >= maxJobs) throw new Error("JOB_CAPACITY");
			const job = { id: `motion-${randomUUID()}`, workspaceId, characterId, token, state: "queued", createdAt: clock(), updatedAt: clock(), cancelRequested: false, receipt: null };
			jobs.set(job.id, job);
			job.cancel = () => { job.cancelRequested = true; if (job.state === "queued" || job.state === "running") transition(job, "cancelled", { reason: "cancelled before commit" }); };
			job.promise = (async () => { try { await authorize({ workspaceId, characterId, token }); if (job.cancelRequested) return job; transition(job, "running"); const candidate = await run({ bridgeOrigin, signal: job.signal, isCancelled: () => job.cancelRequested }); if (job.cancelRequested) return transition(job, "cancelled", { reason: "cancel fence" }); transition(job, "committing"); if (typeof candidate?.commit !== "function") throw new Error("candidate commit is required"); const receipt = await candidate.commit({ characterId, token }); if (!receipt) throw new Error("missing commit receipt"); return transition(job, "completed", { receipt }); } catch (error) { return transition(job, job.cancelRequested ? "cancelled" : "failed", { error: error.message }); } })();
			return job;
		},
		cancel(id) { const job = jobs.get(id); if (!job) return null; job.cancel(); return job; },
		get(id) { trim(); const job = jobs.get(id); return job ? { ...job, promise: undefined, cancel: undefined } : receipts.get(id) ?? null; },
		list() { trim(); return [...jobs.values()].map((job) => ({ ...job, promise: undefined, cancel: undefined })); },
	};
}
