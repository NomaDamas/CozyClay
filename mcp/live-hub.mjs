import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { bucketMs, sanitizeProps } from "../src/analytics.js";
import { mcpToolCategory } from "../src/execution-telemetry.js";

import { WebSocket, WebSocketServer } from "ws";

export const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
export const RUN_WORKFLOW_TIMEOUT_MS = 180_000;
export const LOAD_MOTION_TIMEOUT_MS = 30_000;
export const CAPTURE_FRAME_TIMEOUT_MS = 30_000;
export const MOTION_JOB_TTL_MS = 10 * 60_000;
export const MOTION_JOB_POLL_INTERVAL_MS = 0;
export const MAX_ACTIVE_MOTION_JOBS = 2;
export const MAX_ACTIVE_MOTION_JOBS_PER_WORKSPACE = 1;

const terminalMotionStatuses = new Set(["completed", "failed", "cancelled", "expired"]);

/** MCP-internal job retention for push-only motion work. Its clock is injected
 * so expiry is deterministic without a polling loop or timing-based test. */
export class MotionJobRegistry {
	constructor({ clock = () => Date.now(), ttlMs = MOTION_JOB_TTL_MS } = {}) {
		this.clock = clock;
		this.ttlMs = ttlMs;
		this.jobs = new Map();
	}

	create(workspaceId) {
		this.cleanup();
		const active = [...this.jobs.values()].filter((job) => !terminalMotionStatuses.has(job.status));
		if (active.length >= MAX_ACTIVE_MOTION_JOBS) throw new Error(`Motion job capacity reached (${MAX_ACTIVE_MOTION_JOBS} active globally).`);
		if (active.filter((job) => job.workspaceId === workspaceId).length >= MAX_ACTIVE_MOTION_JOBS_PER_WORKSPACE) {
			throw new Error(`This workspace already has an active motion job.`);
		}
		const now = this.clock();
		const job = {
			taskId: randomUUID(), workspaceId, status: "queued", createdAt: now,
			lastUpdatedAt: now, ttlMs: this.ttlMs, pollIntervalMs: MOTION_JOB_POLL_INTERVAL_MS,
			cancel: null, expiresAt: null, outcome: null,
			deliveredWorkspaceIds: new Set(),
			installationStates: new Map(),
		};
		this.jobs.set(job.taskId, job);
		return job;
	}

	task(job) {
		return {
			taskId: job.taskId, status: job.status, createdAt: job.createdAt,
			lastUpdatedAt: job.lastUpdatedAt, ttlMs: job.ttlMs, pollIntervalMs: job.pollIntervalMs,
		};
	}

	transition(job, status, outcome = null) {
		this.cleanup();
		job.status = status;
		job.lastUpdatedAt = this.clock();
		job.outcome = outcome;
		job.expiresAt = terminalMotionStatuses.has(status) ? job.lastUpdatedAt + job.ttlMs : null;
		if (job.expiresAt !== null) {
			const timer = setTimeout(() => this.cleanup(), job.ttlMs);
			timer.unref?.();
		}
		return this.task(job);
	}

	cancel(taskId, workspaceId) {
		this.cleanup();
		const job = this.jobs.get(taskId);
		if (!job || job.workspaceId !== workspaceId || terminalMotionStatuses.has(job.status)) return null;
		job.cancel?.();
		return this.transition(job, "cancelled", { message: "Generation cancelled before editor delivery." });
	}

	forWorkspace(workspaceId) {
		this.cleanup();
		return [...this.jobs.values()].filter((job) =>
			job.workspaceId === workspaceId && terminalMotionStatuses.has(job.status) && job.status !== "expired" && !job.deliveredWorkspaceIds.has(workspaceId));
	}

	cleanup() {
		const now = this.clock();
		for (const job of this.jobs.values()) {
			if (job.expiresAt === null || now < job.expiresAt) continue;
			if (job.status === "expired") {
				this.jobs.delete(job.taskId);
				continue;
			}
			job.status = "expired";
			job.lastUpdatedAt = now;
			job.outcome = { message: "Motion job outcome expired before this workspace reconnected." };
			job.expiresAt = now + job.ttlMs;
		}
	}
}

const mutationCommands = new Set([
	"set_camera",
	"add_character",
	"update_character",
	"remove_character",
	"place_object",
	"update_object",
	"remove_object",
	"group_objects",
	"ungroup_objects",
	"apply_batch",
	"set_prompt_blocks",
	"load_motion",
	"load_scenes",
	"operate_studio", "arrange_objects", "arrange_characters", "frame_shot", "undo_edit",
	"commit_motion_candidate", "import_asset",
]);

export class LiveMutationUncertainError extends Error {}

// Only the MCP registration wrapper opts in. Agent commands and motion's own
// lifecycle continue through their existing hooks, without parallel events.
const executionObserver = new AsyncLocalStorage();
const safely = (work) => {
	try { return work(); } catch { return undefined; }
};
const mutationState = (name, description) => {
	if (!description || typeof description !== "object") return undefined;
	if (name === "set_camera") return description.camera;
	if (["add_character", "update_character", "remove_character", "set_prompt_blocks"].includes(name)) return description.characters;
	if (name === "load_scenes") return description.document;
	return description.objects;
};

/**
 * Transport-only implementation of LIVE-PROTOCOL.md. Scene semantics remain
 * with the editor and the server's existing CozyClay imports.
 */
export class LiveHub {
	constructor(server = null) {
		this.server = server;
		this.editors = new Map();
		this.pending = new Map();
		this.workspaceIds = new Map();
		this.workspaceMeta = new Map();
		this.workspaceQueues = new Map();
		this.onWorkspaceConnected = null;
		this.onEvent = null;
	}

	get connected() {
		return this.editors.size > 0;
	}

	get workspaceHandles() {
		return [...this.editors.keys()];
	}

	/** handle → the editor's self-label ({ project, scene, cast }), when given. */
	workspaceHandleDetails() {
		return [...this.editors.keys()].map((handle) => ({ handle, meta: this.workspaceMeta.get(handle) ?? null }));
	}

	resolveWorkspace(name, workspaceHandle) {
		if (workspaceHandle !== undefined) {
			const socket = this.editors.get(workspaceHandle);
			if (socket?.readyState === WebSocket.OPEN) return workspaceHandle;
			throw new Error(`Unknown or stale live workspace handle "${workspaceHandle}".`);
		}
		const handles = this.workspaceHandles;
		if (handles.length === 0) throw new Error("No live editor is connected.");
		if (handles.length === 1) return handles[0];
		throw new Error(`Live command ${name} requires workspace_handle; connected workspaces: ${handles.join(", ")}.`);
	}

	static commandTimeoutMs(name) {
		if (name === "load_motion" || name === "prepare_motion_install") return LOAD_MOTION_TIMEOUT_MS;
		if (name === "verify_motion_candidate" || name === "repair_motion_candidate") return 60_000;
		// Close two-person shots (OTS) raycast two skinned rigs over a full-frame
		// AABB; 5 s is not enough. The PNG itself is cheap; the rays are not.
		if (name === "capture_frame") return CAPTURE_FRAME_TIMEOUT_MS;
		// A workflow run captures a frame and may generate an image upstream.
		if (name === "run_workflow") return RUN_WORKFLOW_TIMEOUT_MS;
		return DEFAULT_COMMAND_TIMEOUT_MS;
	}

	static commandMayMutate(name) {
		return mutationCommands.has(name);
	}

	workspaceId(workspaceHandle) {
		const workspaceId = this.workspaceIds.get(workspaceHandle);
		if (!workspaceId) throw new Error(`Unknown or stale live workspace handle "${workspaceHandle}".`);
		return workspaceId;
	}

	// Resolve the current command handle from the job's stable workspace id.
	// Motion jobs outlive socket handles across editor reconnects.
	handleForWorkspaceId(workspaceId) {
		for (const [handle, id] of this.workspaceIds) {
			if (id !== workspaceId) continue;
			const socket = this.editors.get(handle);
			if (socket && socket.readyState === WebSocket.OPEN) return handle;
		}
		return null;
	}

	runExclusive(name, workspaceHandle, work) {
		const handle = this.resolveWorkspace(name, workspaceHandle);
		// The MCP server mirrors one selected editor into one in-process scene
		// document while a tool runs. Serialize across workspaces so another
		// editor cannot replace that mirror between refresh and mutation.
		const queueKey = "__global_live_state__";
		const previous = this.workspaceQueues.get(queueKey) ?? Promise.resolve();
		const current = previous.catch(() => {}).then(() => work(handle));
		this.workspaceQueues.set(queueKey, current);
		return current.finally(() => {
			if (this.workspaceQueues.get(queueKey) === current) this.workspaceQueues.delete(queueKey);
		});
	}

	/** Observe one already-targeted MCP execution. IDs and state evidence are
	 * ephemeral; only enums, buckets and the fresh ID reach the editor relay. */
	async observeExecution(name, handle, work, { randomId = () => randomBytes(16).toString("hex"), now = () => performance.now() } = {}) {
		const socket = this.editors.get(handle);
		if (socket?.readyState !== WebSocket.OPEN) return work();
		const requestId = safely(randomId);
		const startedAt = safely(now);
		if (typeof requestId !== "string" || !/^[a-f0-9]{32}$/.test(requestId) || !Number.isFinite(startedAt)) return work();
		const workspaceId = this.workspaceId(handle);
		const category = mcpToolCategory(name);
		const emit = (event, props) => safely(() => {
			// Do not reconstruct this lifecycle on a replacement connection.
			if (this.editors.get(handle) !== socket || socket.readyState !== WebSocket.OPEN) return;
			Promise.resolve(this.sendEvent(workspaceId, "telemetry", { event, props: sanitizeProps(event, props) })).catch(() => {});
		});
		let terminal = false;
		let applied = false;
		let appliedEmitted = false;
		let failure = null;
		let description;
		let mutation;
		let acknowledgedMutation = false;
		const emitApplied = () => {
			if (!applied || !terminal || appliedEmitted) return;
			appliedEmitted = true;
			emit("mcp:result_applied", { request_id: requestId });
		};
		const observer = {
			hub: this, handle,
			before(command) {
				if (!LiveHub.commandMayMutate(command) || command === "load_motion") return false;
				mutation = { name: command, before: mutationState(command, description), acknowledged: false };
				description = undefined;
				return mutation.before === undefined;
			},
			baseline(value) { if (mutation) mutation.before = mutationState(mutation.name, value); },
			receipt(command, value) {
				if (command === "describe") {
					if (mutation?.acknowledged && !mutation.rolledBack) {
						const after = mutationState(mutation.name, value);
						if (mutation.before !== undefined && after !== undefined && !isDeepStrictEqual(mutation.before, after)) applied = true;
					}
					description = value;
					mutation = null;
				} else if (LiveHub.commandMayMutate(command)) {
					acknowledgedMutation = true;
					if (mutation) mutation.acknowledged = true;
					if (command === "apply_batch") {
						if (mutation) mutation.rolledBack = value?.rolledBack === true;
						if (value?.rolledBack === true || value?.failed?.length > 0) failure = "failed";
					}
					// The load acknowledgement is the existing installation receipt,
					// including generation jobs whose MCP control response was queued.
					if (command === "load_motion" && value?.loaded === true) applied = true;
				}
				emitApplied();
			},
			error(command, error) {
				if (error instanceof LiveMutationUncertainError || (command === "describe" && mutation?.acknowledged)) failure = "uncertain";
				else if (failure !== "uncertain") failure = error?.name === "AbortError" || error?.code === "ABORT_ERR" ? "cancelled" : "failed";
			},
		};
		const finish = (value, error) => safely(() => {
			if (terminal) return;
			if (error) observer.error(null, error);
			if (value?.isError === true && !failure) failure = acknowledgedMutation ? "uncertain" : "failed";
			terminal = true;
			const endedAt = safely(now);
			if (Number.isFinite(endedAt)) emit("mcp:tool_executed", { request_id: requestId, tool_category: category, outcome: failure ?? "succeeded", duration_bucket: bucketMs(endedAt - startedAt) });
			emitApplied();
			// Never retain scene data with an asynchronous motion job.
			description = undefined;
			mutation = null;
		});
		emit("mcp:tool_requested", { request_id: requestId, tool_category: category });
		return executionObserver.run(observer, async () => {
			try {
				const value = await work();
				finish(value);
				return value;
			} catch (error) {
				finish(null, error);
				throw error;
			}
		});
	}

	sendEvent(workspaceId, name, payload) {
		let delivered = 0;
		for (const [handle, socket] of this.editors) {
			if (this.workspaceIds.get(handle) !== workspaceId || socket.readyState !== WebSocket.OPEN) continue;
			socket.send(JSON.stringify({ type: "event", name, payload }));
			delivered += 1;
		}
		return delivered;
	}

	async command(name, args, workspaceHandle) {
		const handle = this.resolveWorkspace(name, workspaceHandle);
		const current = executionObserver.getStore();
		const observer = current?.hub === this && current.handle === handle ? current : null;
		if (observer && safely(() => observer.before(name))) {
			// Existing acknowledgements do not distinguish same-value updates.
			// Only when the handler has not already described the scene, take one
			// best-effort read before mutation. It never controls tool execution.
			try {
				const baseline = await this.sendCommand("describe", {}, handle);
				safely(() => observer.baseline(baseline));
			} catch { /* Missing evidence omits application, not the real command. */ }
		}
		try {
			const value = await this.sendCommand(name, args, handle);
			safely(() => observer?.receipt(name, value));
			return value;
		} catch (error) {
			safely(() => observer?.error(name, error));
			throw error;
		}
	}

	async sendCommand(name, args, handle) {
		const socket = this.editors.get(handle);
		if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error(`Unknown or stale live workspace handle "${handle}".`);

		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				const message = `Live editor timed out running ${name}.`;
				const error = LiveHub.commandMayMutate(name)
					? new LiveMutationUncertainError(`${message} The mutation may have been applied. Do not retry it; describe the scene before choosing a recovery action.`)
					: new Error(message);
				reject(error);
			}, LiveHub.commandTimeoutMs(name));
			this.pending.set(id, { name, socket, resolve, reject, timer });
			try {
				socket.send(JSON.stringify({ type: "cmd", id, name, args }));
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new Error(`Could not send ${name} to the live editor: ${error.message}`));
			}
		});
	}

	accept(socket, request = null) {
		const origin = request?.headers?.origin;
		if (typeof origin === "string") {
			let allowed = false;
			try {
				const parsed = new URL(origin);
				allowed = parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
			} catch {
				allowed = false;
			}
			if (!allowed) {
				socket.close(1008, "Live editor origin must be loopback");
				return;
			}
		}
		let greeted = false;
		socket.on("message", (message, isBinary) => {
			if (isBinary) return;
			let frame;
			try {
				frame = JSON.parse(message.toString());
			} catch {
				return;
			}
			if (!greeted) {
				if (frame?.type !== "hello" || frame.role !== "editor" || frame.version !== 1) {
					socket.close(1002, "Expected editor hello version 1");
					return;
				}
				greeted = true;
				const workspaceHandle = randomUUID();
				const workspaceId = typeof frame.workspaceId === "string" && frame.workspaceId ? frame.workspaceId : workspaceHandle;
				if ([...this.workspaceIds.values()].includes(workspaceId)) {
					socket.close(1008, "Workspace id is already connected");
					return;
				}
				this.editors.set(workspaceHandle, socket);
				this.workspaceIds.set(workspaceHandle, workspaceId);
				// The editor can label itself so live_status can tell tabs apart.
				const meta = frame.meta && typeof frame.meta === "object" ? frame.meta : null;
				this.workspaceMeta.set(workspaceHandle, meta);
				socket.send(JSON.stringify({ type: "workspace", handle: workspaceHandle }));
				this.onWorkspaceConnected?.({ workspaceHandle, workspaceId });
				return;
			}
			if (frame?.type === "event" && typeof frame.name === "string" && frame.payload && typeof frame.payload === "object") {
				const workspaceHandle = [...this.editors.entries()].find(([, editor]) => editor === socket)?.[0];
				if (workspaceHandle) this.onEvent?.({ workspaceHandle, workspaceId: this.workspaceId(workspaceHandle), name: frame.name, payload: frame.payload });
				return;
			}
			if (frame?.type !== "result" || typeof frame.id !== "string") return;
			const pending = this.pending.get(frame.id);
			if (!pending || pending.socket !== socket) return;
			clearTimeout(pending.timer);
			this.pending.delete(frame.id);
			if (frame.ok === true) {
				pending.resolve(frame.value);
			} else {
				const error = new Error(typeof frame.error === "string" ? frame.error : "Live editor rejected the command.");
				pending.reject(error);
			}
		});
		socket.on("close", () => this.disconnect(socket));
		socket.on("error", () => this.disconnect(socket));
	}

	disconnect(socket) {
		for (const [handle, editor] of this.editors) {
			if (editor === socket) {
				const workspaceId = this.workspaceIds.get(handle);
				this.editors.delete(handle);
				this.workspaceIds.delete(handle);
				this.workspaceMeta.delete(handle);
			}
		}
		for (const [id, pending] of this.pending) {
			if (pending.socket !== socket) continue;
			clearTimeout(pending.timer);
			this.pending.delete(id);
			const message = "Live editor disconnected while a command was running.";
			const error = LiveHub.commandMayMutate(pending.name)
				? new LiveMutationUncertainError(`${message} The mutation may have been applied. Do not retry it; describe the scene before choosing a recovery action.`)
				: new Error(message);
			pending.reject(error);
		}
	}
}

/** Bind only to loopback. A taken port is an intentional memory-only mode. */
export async function startLiveHub(port) {
	let server;
	try {
		server = new WebSocketServer({ host: "127.0.0.1", port, path: "/live" });
		await new Promise((resolve, reject) => {
			server.once("listening", resolve);
			server.once("error", reject);
		});
	} catch (error) {
		if (server) server.close();
		if (error?.code === "EADDRINUSE") return null;
		throw error;
	}
	const hub = new LiveHub(server);
	server.on("connection", (socket, request) => hub.accept(socket, request));
	return hub;
}
