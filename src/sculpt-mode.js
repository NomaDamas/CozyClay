// Sculpt mode (#739): the pure parts of the fifth viewport mode. The stage
// component (sculpt-stage.jsx) and App use these; verify-sculpt-mode pins them.
import { placementInFront, SCULPT_KIND } from "./scene-objects.js";
import { effortOptions, modelIsSelectable, readStoredModel } from "./workflow/agent-client.js";

/** The sculpt turntable's render layer. dualview.jsx owns 2-5; nothing else
 * draws on 6, so only the sculpt camera sees the turntable floor and lights. */
export const SCULPT_LAYER = 6;

/** Front / side / back, as azimuths from the sculpt's own front (+Z turned by
 * its yaw). Side is the subject's own left, sculpt.compare's positive yaw. */
export const SCULPT_VIEWS = Object.freeze({ front: 0, side: 90, back: 180 });

/** The sculpt the mode opens on: the selected object when it is a sculpt,
 * otherwise none (the first run creates one). */
export function sculptTargetFromSelection(objects, selectedId) {
	const object = (objects ?? []).find((row) => row.id === selectedId);
	return object?.renderer === SCULPT_KIND ? object.id : null;
}

/** The object ids the isolated turntable draws: the target and nothing else.
 * Every other object, character and the set stay in their records untouched;
 * they are simply not on the sculpt camera's layer. */
export function isolatedObjectIds(objects, targetId) {
	return (objects ?? []).some((row) => row.id === targetId) ? [targetId] : [];
}

/** Orbit target and camera position that frame `object` (size from
 * objectSize) from one of SCULPT_VIEWS through a `fovDeg` vertical lens. */
export function sculptFraming(object, size, view = "front", fovDeg = 35) {
	const height = Math.max(0.05, size?.height ?? 1);
	const radius = 0.5 * Math.hypot(size?.width ?? 1, height, size?.depth ?? 1);
	const base = object?.y ?? 0;
	const target = [object?.x ?? 0, base + height / 2, object?.z ?? 0];
	const distance = (radius / Math.sin(((fovDeg / 2) * Math.PI) / 180)) * 1.15;
	const azimuth = (((object?.rot ?? 0) + (SCULPT_VIEWS[view] ?? 0)) * Math.PI) / 180;
	// A slight look-down reads the volume; level would flatten it to the mask.
	const lift = distance * 0.18;
	return {
		target,
		position: [target[0] + Math.sin(azimuth) * distance, target[1] + lift, target[2] + Math.cos(azimuth) * distance],
		radius,
		floorY: base,
	};
}

/** Where Place in scene stands the sculpt: on the ground, in front of the
 * scene camera, with the same helper + Add uses. */
export function sculptPlacement(cameraPosition, yaw) {
	return { ...placementInFront({ x: cameraPosition.x, z: cameraPosition.z }, yaw), y: 0 };
}

const PENDING = new Set(["started", "queued", "running", "pending"]);

/**
 * The command feed a sculpt run listens to. The editor bus only announces
 * finished jobs, so the agent's live command handlers are wrapped to report
 * every receipt too; a receipt seen twice (a job reported by both) is fed once.
 * Events are `{ action, args, result, turnId }`, with a job's output merged into
 * result. turnId is the agent turn that ran the command (null for UI and MCP
 * commands), so a run hears only its own turns; a job that went to the
 * background keeps the turnId of the request that started it.
 */
export function createCommandTap() {
	const listeners = new Set();
	const seen = new Set();
	const jobTurns = new Map();
	const report = (request, receipt) => {
		if (receipt?.ok && receipt.jobId && request?.turnId && PENDING.has(receipt.status)) {
			jobTurns.set(receipt.jobId, request.turnId);
			if (jobTurns.size > 200) jobTurns.delete(jobTurns.keys().next().value);
		}
		if (!receipt?.ok || !receipt.action || PENDING.has(receipt.status)) return;
		if (receipt.receiptId) {
			if (seen.has(receipt.receiptId)) return;
			seen.add(receipt.receiptId);
			// Duplicates arrive back to back; the recent ids are enough to drop them.
			if (seen.size > 200) seen.delete(seen.values().next().value);
		}
		const args = request?.args?.action === receipt.action ? request.args.args ?? {} : request?.args ?? {};
		const turnId = request?.turnId ?? jobTurns.get(receipt.jobId) ?? null;
		const event = { action: receipt.action, args, result: { ...receipt, ...(receipt.output ?? {}) }, turnId };
		// An observer must never turn an applied command into a failed one.
		for (const listener of [...listeners]) {
			try { listener(event); } catch (error) { console.error("sculpt command tap listener failed", error); }
		}
	};
	return {
		report,
		/** Wrap live handlers so each receipt they answer is reported. */
		wrap(handlers) {
			return Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, (request, ...rest) => {
				const out = handler(request, ...rest);
				if (out?.then) return out.then((value) => { report(request, value); return value; });
				report(request, out);
				return out;
			}]));
		},
		/** createSculptRun's `bus`: tap events plus the editor bus's finished jobs. */
		subscribe(listener, bus = null) {
			listeners.add(listener);
			const off = bus?.subscribe?.((event) => { if (event?.type === "job.completed") report(null, event.receipt); });
			return () => { listeners.delete(listener); off?.(); };
		},
	};
}

/** The studio agent client a sculpt run turns through: the Agent panel's
 * transport, with the live editor context every Studio turn must carry. */
export function sculptAgentClient(transport, readContext) {
	return { turn: (request, onEvent, signal) => transport.turn({ ...request, context: readContext() }, onEvent, signal) };
}

/** Readiness for Start, from the transport's status (the Agent panel's rule:
 * signed in, or a provider key held by the sidecar). */
export const agentSessionReady = (status) => Boolean(status?.signedIn || status?.providersConfigured > 0);

/** Whether the sidecar holds a ChatGPT token: /oauth/status `signedIn` is the
 * ChatGPT login alone (a provider key only counts in providersConfigured). The
 * blueprint's image model is ChatGPT-only, so its button needs this (#970). */
export const chatgptSignedIn = (status) => status?.signedIn === true;

/** A stored image asset as a data URL (the bytes the store holds, so the run
 * scores against exactly the stored, possibly downscaled, picture). */
export function assetDataUrl(asset) {
	const bytes = new Uint8Array(asset.bytes);
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	return `data:${asset.type};base64,${globalThis.btoa(binary)}`;
}

/** Sculpt remembers its own model and effort, apart from the Agent panel's chat model. */
const SCULPT_MODEL_KEY = "cozyclay.sculpt.model";

export function readSculptModel(storage = globalThis.localStorage) {
	try {
		const value = JSON.parse(storage?.getItem(SCULPT_MODEL_KEY) ?? "null");
		return value && typeof value.model === "string" ? { model: value.model, effort: typeof value.effort === "string" ? value.effort : null } : null;
	} catch {
		return null;
	}
}

export function storeSculptModel(choice, storage = globalThis.localStorage) {
	try {
		if (choice?.model) storage?.setItem(SCULPT_MODEL_KEY, JSON.stringify({ model: choice.model, effort: choice.effort ?? null }));
	} catch {
		// Storage denial must never break picking a model.
	}
}

/**
 * The model and effort Sculpt runs on, from the sidecar's `/agent/models`
 * answer: the current pick, else Sculpt's remembered one, else the Agent
 * panel's model, else the first model a signed-in provider can run. Only a
 * model the list still carries and its provider can run is ever chosen, and
 * an effort the model does not offer falls back to its default (null).
 */
export function sculptModelChoice(advertised, current = null, stored = readSculptModel(), agentModel = readStoredModel()) {
	const models = Array.isArray(advertised?.models) ? advertised.models : [];
	const providers = Array.isArray(advertised?.providers) ? advertised.providers : [];
	const runnable = (key) => Boolean(key) && models.some((entry) => entry.id === key) && modelIsSelectable(providers, key);
	const model = [current?.model, stored?.model, agentModel].find(runnable)
		?? models.find((entry) => modelIsSelectable(providers, entry.id))?.id ?? "";
	const offered = effortOptions(models.find((entry) => entry.id === model));
	const wanted = model === current?.model ? current?.effort : model === stored?.model ? stored?.effort : null;
	return { model, effort: wanted && offered.includes(wanted) ? wanted : null };
}

/** How a model key is named to the operator: its catalogue label, else the key. */
export function sculptModelLabel(advertised, key) {
	return (Array.isArray(advertised?.models) ? advertised.models : []).find((entry) => entry.id === key)?.label ?? key ?? "";
}
