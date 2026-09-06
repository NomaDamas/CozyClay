/**
 * The CozyClay authoring tools, as data.
 *
 * server.mjs used to own the 25 tool registrations inline, which meant the only
 * way to run one was to speak MCP to a running server. Every tool here is the
 * same handler that server.mjs registers — name, description, input schema,
 * safety annotations and live routing flag travel with it — so an in-process
 * agent can import this module and call a handler directly, and the MCP surface
 * stays the single definition of what a tool is.
 *
 * Importing this module has no side effects: no port is opened, no directory is
 * changed, no signal handler is installed and no temporary file is swept. The
 * owning process does that wiring — server.mjs resolves the project root (and
 * chdirs into it), sweeps stale capture artifacts and installs the exit hooks —
 * and hands what the handlers need to createToolHandlers.
 *
 * State is the same one authoring document server.mjs always had: this module
 * owns it, and `liveHub` is a live binding the owner installs with setLiveHub,
 * so every handler sees the editor connection the moment it exists.
 */
import { link, open as openFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import { LiveMutationUncertainError } from "./live-hub.mjs";
import { BLOCK_MAX_SECONDS, PROMPT_GUIDE, normalizePhases, splitLongBeat, tileClipFrames } from "./ardy-prompts.mjs";

import {
	CAMERA_MOVES,
	DEFAULT_SENSOR_FORMAT,
	IMAGE_MODELS,
	VIDEO_MODELS,
	composePrompt,
	deriveShot,
	focalMmToFov,
	nearestPrime,
	shotAspectRatio,
	slateLine,
} from "../src/shot.js";
import {
	CHARACTER_MODEL_IDS,
	activeScene,
	addScene,
	createCharacterEntry,
	createSceneDocument,
	readSceneDocument,
	serializeSceneDocument,
} from "../src/scenes.js";
import {
	OBJECT_LIBRARY,
	createSceneObject,
	objectSize,
	removeSceneObject,
	setSceneObjectParent,
	updateSceneObject,
} from "../src/scene-objects.js";
import { classifyMove, captureFraming, moveSlate } from "../src/camera-move.js";
import { createProjectDocument, readProjectDocument } from "../src/project.js";

/* ------------------------------- state ---------------------------------- */

/** The authoring state. One scene document, one camera, one project name. */
export const state = {
	doc: createSceneDocument(),
	name: "Untitled",
	camera: { x: 0, y: 1.6, z: 4.5, focalMm: 35 },
	timeline: { currentFrame: 0, frameCount: 360, fps: 24 },
	/** which character the camera frames against; null means the first of the cast */
	focus: null,
	/** true after focus_character explicitly selects the server-side subject */
	focusLocked: false,
	/** framing snapshot taken by `mark_camera_move`, consumed by `describe_camera_move` */
	markedFraming: null,
};

export let liveHub = null;
/** The live editor port this session tried to own; set by whoever starts the hub. */
let livePort = null;
/** True when another process (a sibling MCP session's child) already owns the live editor port. */
let liveHubPortBusy = false;
/** Explain a missing live editor, naming the sibling session that owns the port when that is the cause. */
const noLiveEditor = (requirement) =>
	liveHubPortBusy
		? `${requirement} Live port ${livePort} is owned by the first MCP session of this server, so this ` +
			"session is memory-only; reuse that first session, or restart the server and reconnect, to drive the editor."
		: requirement;
export const liveWorkspace = new AsyncLocalStorage();
const liveWorkspaceTools = new Set([
	"describe_scene", "describe_shot", "render_prompt", "mark_camera_move", "describe_camera_move", "save_project",
	"set_camera", "frame_shot", "add_character", "place_character", "remove_character",
	"focus_character", "place_object", "group_objects", "set_prompt_blocks", "generate_motion", "update_object",
	"remove_object", "apply_batch", "add_scene", "switch_scene", "open_project", "capture_frame", "load_motion",
]);
const MAX_CAPTURE_BYTES = 1_000_000;
const CAPTURE_ARTIFACT_TTL_MS = 10 * 60_000;
const MAX_CAPTURE_ARTIFACTS = 20;
const captureArtifacts = [];
const captureArtifactPattern = /^cozyclay-capture-[0-9a-f-]+\.png$/;
const motionUrlPattern = /^\/(ardy\/motions\/[0-9]+-[0-9a-f]{6}|ardy\/assembled\/[A-Za-z0-9._-]+\.npz)$/;
export const cleanupCaptureArtifacts = () => {
	for (const path of captureArtifacts.splice(0)) {
		try { unlinkSync(path); } catch {}
	}
};
export const sweepCaptureArtifacts = () => {
	for (const name of readdirSync(tmpdir())) {
		if (!captureArtifactPattern.test(name)) continue;
		try {
			const path = join(tmpdir(), name);
			if (Date.now() - statSync(path).mtimeMs >= CAPTURE_ARTIFACT_TTL_MS) unlinkSync(path);
		} catch {}
	}
};

/** The live editor connection, installed by whoever owns the hub. Handlers read
 * this binding directly, so a hub that arrives after registration is still seen. */
export const setLiveHub = (hub) => {
	liveHub = hub;
};

/** The live port and whether a sibling session already owns it — the two facts
 * `noLiveEditor` needs to explain a memory-only session. */
export const setLivePortInfo = (port, portBusy) => {
	livePort = port;
	liveHubPortBusy = portBusy;
};

const requirePrivateProjectInode = async (file) => {
	const stat = await file.stat();
	if (stat.nlink !== 1) throw new Error("Project files must not have hard links.");
};

const TOOL_ANNOTATIONS = Object.freeze({
	describe_scene: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	live_status: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	describe_shot: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	capture_frame: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
	set_camera: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	frame_shot: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	add_character: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	place_character: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	remove_character: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
	focus_character: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	place_object: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	group_objects: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	set_prompt_blocks: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	load_motion: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	generate_motion: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
	update_object: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	remove_object: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
	apply_batch: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
	render_prompt: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	mark_camera_move: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	describe_camera_move: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	add_scene: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	switch_scene: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
	open_project: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
	save_project: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
});

const scene = () => activeScene(state.doc.scenes, state.doc.activeSceneId);
const stage = () => scene().stage;

/** The cast of the active scene. A v3 stage carries an unbounded `characters`
 * list, so "character A/B" is simply index 0/1 of this array. */
const cast = () => stage().characters;

/** Resolve a character by id, by the A/B/C letter the studio labels them with,
 * or by 1-based slot. Returns null when nothing matches. */
const findCharacter = (ref) => {
	const list = cast();
	if (ref === undefined || ref === null || ref === "") return list[0] ?? null;
	const key = String(ref).trim();
	const byId = list.find((c) => c.id === key);
	if (byId) return byId;
	if (/^[A-Za-z]$/.test(key)) return list[key.toUpperCase().charCodeAt(0) - 65] ?? null;
	const n = Number(key);
	if (Number.isInteger(n) && n >= 1) return list[n - 1] ?? null;
	return null;
};

/** The studio labels the cast A, B, C… by position. */
const letterFor = (character) => String.fromCharCode(65 + cast().indexOf(character));

/** What to say when a character reference does not resolve. */
const castHint = () =>
	`Cast: ${cast()
		.map((c, i) => `${String.fromCharCode(65 + i)}=${c.id}`)
		.join(", ")}`;

const filmback = () => ({
	sensorId: state.camera.sensorId ?? stage().sensorId ?? DEFAULT_SENSOR_FORMAT,
	aspectRatio: state.camera.aspectRatio ?? shotAspectRatio(stage().shotAspect),
});

/** The camera's vertical FOV, derived from the focal length and cropped gate. */
const fov = () => {
	const gate = filmback();
	return focalMmToFov(state.camera.focalMm, gate.sensorId, gate.aspectRatio);
};

/** The subject `deriveShot` frames against: the framed character, which is the
 * first of the cast unless `focus_character` moved it. */
const subject = () => {
	const a = findCharacter(state.focus) ?? cast()[0];
	return a ? { x: a.x, z: a.z, rot: a.rot } : { x: 0, z: 0, rot: 0 };
};

/** The height every shot is measured to: the framed subject's chest.
 * Mirrors src/shot.js FRAMING_PIVOT_Y. */
const FRAMING_PIVOT_Y = 1.3;

/** Yaw/pitch that aim the camera at the framing pivot — what captureFraming wants. */
const aimAtSubject = () => {
	const s = subject();
	const dx = state.camera.x - s.x;
	const dz = state.camera.z - s.z;
	const dy = state.camera.y - FRAMING_PIVOT_Y;
	const horizontal = Math.hypot(dx, dz);
	return {
		yaw: (Math.atan2(dx, dz) * 180) / Math.PI,
		pitch: (-Math.atan2(dy, Math.max(horizontal, 1e-6)) * 180) / Math.PI,
	};
};

const framing = () => {
	const { yaw, pitch } = aimAtSubject();
	return captureFraming({
		pos: { x: state.camera.x, y: state.camera.y, z: state.camera.z },
		yaw,
		pitch,
		fovDeg: (fov() * 180) / Math.PI,
	});
};

const currentShot = () => deriveShot(state.camera, subject(), fov(), undefined, filmback());

const appliedLiveMutation = async (name, args) => {
	const workspaceHandle = liveWorkspace.getStore();
	const value = await liveHub.command(name, args, workspaceHandle);
	try {
		if (!await refreshLiveDescription(workspaceHandle)) throw new Error("Live editor disconnected before verification.");
	} catch (error) {
		throw new LiveMutationUncertainError(`Live editor accepted ${name}, but its state could not be verified: ${error.message} The mutation may have been applied. Do not retry it; describe the scene before choosing a recovery action.`);
	}
	return value;
};

const requireLiveSceneParity = (name, document, result) => {
	const expected = document.scenes.map(({ id, name: sceneName }) => ({ id, name: sceneName }));
	const received = Array.isArray(result?.scenes) ? result.scenes : [];
	const sameScenes = received.length === expected.length && received.every((scene, index) =>
		scene?.id === expected[index].id && scene?.name === expected[index].name,
	);
	if (sameScenes && result?.activeSceneId === document.activeSceneId) return;
	throw new LiveMutationUncertainError(
		`Live editor accepted ${name}, but did not confirm the complete scene list and active scene ` +
		`(expected ${JSON.stringify(expected)} active ${document.activeSceneId}; received ${JSON.stringify(received)} active ${result?.activeSceneId ?? "none"}). ` +
		"The mutation may have been applied. Do not retry it; describe the scene before choosing a recovery action.",
	);
};

const modelById = (id) =>
	[...VIDEO_MODELS, ...IMAGE_MODELS].find((m) => m.id === id) ?? null;

/** Copy the protocol's deliberately small live description into the existing
 * scene shape. Formatting and film vocabulary below then remain exactly the
 * same code paths as memory-only mode. */
const applyLiveDescription = (description) => {
	if (!description || typeof description !== "object") throw new Error("Live editor returned an invalid scene description.");
	if (description.document && typeof description.document === "object") {
		const parsed = readSceneDocument(serializeSceneDocument(description.document));
		if (!parsed.document) throw new Error("Live editor returned an invalid scene document.");
		state.doc = parsed.document;
	}
	const sc = scene();
	if (typeof description.sceneName === "string" && description.sceneName) sc.name = description.sceneName;
	if (description.camera && typeof description.camera === "object") {
		for (const key of ["x", "y", "z", "focalMm"]) {
			if (Number.isFinite(description.camera[key])) state.camera[key] = description.camera[key];
		}
		if (typeof description.camera.sensorId === "string") state.camera.sensorId = description.camera.sensorId;
		if (Number.isFinite(description.camera.aspectRatio)) state.camera.aspectRatio = description.camera.aspectRatio;
	}
	if (description.stage && typeof description.stage === "object") {
		if (typeof description.stage.shotAspect === "string") sc.stage.shotAspect = description.stage.shotAspect;
		if (typeof description.stage.sensorId === "string") sc.stage.sensorId = description.stage.sensorId;
		if (typeof description.stage.hasCharSheet === "boolean") sc.stage.hasCharSheet = description.stage.hasCharSheet;
	}
	if (description.timeline && typeof description.timeline === "object") {
		for (const key of ["currentFrame", "frameCount", "fps"]) {
			if (Number.isFinite(description.timeline[key])) state.timeline[key] = description.timeline[key];
		}
	}
	if (!state.focusLocked && typeof description.activeCharacterId === "string") state.focus = description.activeCharacterId;
	if (Array.isArray(description.characters)) {
		const prior = new Map(stage().characters.map((character) => [character.id, character]));
		stage().characters = description.characters.map((character, index) => {
			const previous = prior.get(character.id);
			return createCharacterEntry({ ...previous, ...character, model: character.model ?? previous?.model }, index);
		});
		if (state.focus && !stage().characters.some((character) => character.id === state.focus)) {
			state.focus = null;
			state.focusLocked = false;
		}
	}
	if (Array.isArray(description.objects)) {
		const prior = new Map(sc.objects.map((object) => [object.id, object]));
		sc.objects = description.objects.map((object) => {
			const previous = prior.get(object.id);
			// The reported renderer is the truth; the name match is only a rescue
			// for older editors that did not send one. A renamed object ("Building
			// A") defeats the name match, and a record without a renderer survives
			// the save but cannot be drawn after the load.
			const kind =
				(typeof object.renderer === "string" && OBJECT_LIBRARY.some((entry) => entry.kind === object.renderer)
					? object.renderer
					: null) ??
				OBJECT_LIBRARY.find(({ label }) => object.name === label || object.name?.startsWith(`${label} `))?.kind;
			const defaults = previous ?? (kind ? createSceneObject(kind, sc.objects, object) : null);
			// The editor is the source of truth for anything it reports; the
			// library defaults only fill what the frame omits. Defaulting AFTER
			// the spread would reset a reported scale back to 1 and make every
			// prop measure 1x1x1 no matter how it was actually built.
			return {
				...defaults,
				footprint: defaults?.footprint ?? { width: 1, depth: 1 },
				height: defaults?.height ?? 1,
				scaleX: defaults?.scaleX ?? 1,
				scaleY: defaults?.scaleY ?? 1,
				scaleZ: defaults?.scaleZ ?? 1,
				...object,
			};
		});
	}
};

const refreshLiveDescription = async (workspaceHandle = liveWorkspace.getStore()) => {
	if (!liveHub?.connected) return false;
	applyLiveDescription(await liveHub.command("describe", {}, workspaceHandle));
	return true;
};

const liveError = (error) => ({
	content: [{ type: "text", text: `Live editor error: ${error.message}` }],
	isError: true,
});

/* ------------------------------ formatting ------------------------------- */

const round = (n, places = 2) => Number(n.toFixed(places));
const metres = (n) => `${round(n)}m`;

const text = (body) => ({ content: [{ type: "text", text: body }] });

/** A scene rendered the way a crew would read it, not as JSON. */
function sceneReport({ characterCursor = 0, objectCursor = 0, limit = 50 } = {}) {
	const sc = scene();
	const st = sc.stage;
	const shot = currentShot();
	const revision = createHash("sha256")
		.update(JSON.stringify({ document: state.doc, camera: state.camera, timeline: state.timeline }))
		.digest("hex")
		.slice(0, 12);
	const characterPage = st.characters.slice(characterCursor, characterCursor + limit);
	const objectPage = sc.objects.slice(objectCursor, objectCursor + limit);
	const lines = [
		`Project: ${state.name}`,
		`Scene: ${sc.name}  (${state.doc.scenes.length} scene${state.doc.scenes.length === 1 ? "" : "s"} in project)`,
		"",
		"CAMERA",
		`  position   x ${round(state.camera.x)}  y ${round(state.camera.y)}  z ${round(state.camera.z)}`,
		`  lens       ${state.camera.focalMm}mm  (nearest prime ${nearestPrime(fov(), filmback().sensorId, filmback().aspectRatio)}mm)`,
		`  filmback   ${filmback().sensorId} · ${round(filmback().aspectRatio, 3)}:1`,
		`  framing    ${slateLine(shot)}`,
		`  distance   ${metres(shot.distance)} to the subject's centre of mass`,
		"",
		`CAST (total: ${st.characters.length}, returned: ${characterPage.length}, truncated: ${characterCursor + characterPage.length < st.characters.length}, revision: ${revision})`,
	];
	const framed = findCharacter(state.focus) ?? st.characters[0];
	for (const [offset, c] of characterPage.entries()) {
		const letter = String.fromCharCode(65 + characterCursor + offset);
		lines.push(
			`  ${letter} ${c.id}  "${c.subject}"  at x ${round(c.x)}, z ${round(c.z)}, ` +
				`facing ${round(c.rot, 1)}deg  [${c.model}]` +
				`${c.pose ? " posed" : ""}${c.hidden ? " hidden" : ""}` +
				`${c === framed ? "  <- framed" : ""}`,
			`    model: ${c.model}  pose: ${JSON.stringify(c.pose ?? null)}  tint: ${c.tint ?? null}  scale: ${c.scale ?? 1}`,
			`    motionRef: ${JSON.stringify(c.motionRef ?? null)}`,
			`    layer: ${JSON.stringify({ waypoints: c.layer?.waypoints ?? [], promptClips: c.layer?.promptClips ?? [] })}`,
		);
	}

	lines.push("", `SET (total: ${sc.objects.length}, returned: ${objectPage.length}, truncated: ${objectCursor + objectPage.length < sc.objects.length}, revision: ${revision})`);
	if (sc.objects.length === 0) {
		lines.push("  empty — add with place_object");
	} else {
		for (const object of objectPage) {
			const size = objectSize(object);
			lines.push(
				`  ${object.id}  ${object.name}  at x ${round(object.x)}, y ${round(object.y)}, z ${round(object.z)}` +
					`  yaw ${round(object.rot, 1)}deg  size ${round(size.width)}x${round(size.height)}x${round(size.depth)}m`,
				`    rotX: ${round(object.rotX ?? 0, 1)}  rotZ: ${round(object.rotZ ?? 0, 1)}  color: ${object.color ?? null}  parent: ${object.parent ?? null}`,
			);
			if (object.path?.points?.length >= 2) {
				const points = object.path.points;
				const first = points[0];
				const last = points[points.length - 1];
				lines.push(`    path: ${points.length} pts  (${round(first.x, 1)},${round(first.z, 1)}) → (${round(last.x, 1)},${round(last.z, 1)})  speed: ${object.path.speed || "fills take"}${object.path.extend ? "  keeps going" : ""}${object.path.loop ? "  loops" : ""}`);
			}
		}
	}
		lines.push(
			"",
			"STAGE",
			`  shotAspect: ${st.shotAspect}  sensorId: ${st.sensorId}  hasCharSheet: ${st.hasCharSheet}`,
		);
		// The stage's key light crosses the socket inside the stage envelope; a
		// director tool that cannot see it cannot describe the scene's light.
		const keyLight = sc.stage?.keyLight ?? st.keyLight;
		if (keyLight && typeof keyLight === "object") {
			lines.push(`  keyLight: x ${round(keyLight.x, 1)}  y ${round(keyLight.y, 1)}  z ${round(keyLight.z, 1)}  intensity ${round(keyLight.intensity, 2)}`);
		}
		// The editorial structure crosses the socket too — list the shots so an
		// agent reading describe_scene is not blind to cuts and rail/crane rigs.
		const shots = Array.isArray(sc.shotDocument?.shots) ? sc.shotDocument.shots : [];
		if (shots.length) {
			lines.push("", "SHOTS");
			for (const shotEntry of shots) {
				const cam = shotEntry.camera ?? {};
				const rig = cam.mode === "rail" ? "rail" + (cam.craneHeight ? "+crane" : "") : cam.mode ?? "keys";
				lines.push(`  ${shotEntry.name ?? shotEntry.id}  frames ${shotEntry.startFrame ?? "?"}-${shotEntry.endFrame ?? "?"}  ${rig}`);
			}
		}
		lines.push(
			"",
			"TIMELINE",
			`  currentFrame: ${state.timeline.currentFrame}  frameCount: ${state.timeline.frameCount}  fps: ${state.timeline.fps}`,
		);
		return lines.join("\n");
}

/** The shot, described in the vocabulary a director and an image model share. */
function shotReport() {
	const shot = currentShot();
	return [
		slateLine(shot),
		"",
		`size      ${shot.sizeLabel} — the subject fills ${Math.round(shot.screenFraction * 100)}% of frame height`,
		`view      ${shot.viewPhrase}`,
		`level     ${shot.levelPhrase}`,
		`lens      ${shot.focalMm}mm (exact ${round(shot.exactFocalMm, 1)}mm)`,
		`distance  ${metres(shot.distance)}`,
		`elevation ${round(shot.elevationDeg, 1)}deg`,
		"",
		`texture guidance: ${shot.sizeContext}`,
	].join("\n");
}

/* --------------------------------- tools --------------------------------- */

/** One tool, as the registry hands it out: everything server.mjs needs to
 * register it, and everything a direct caller needs to run it. */
const tool = (name, config, handler) => ({
	name,
	title: config.title,
	description: config.description,
	inputSchema: config.inputSchema,
	annotations: TOOL_ANNOTATIONS[name],
	live: liveWorkspaceTools.has(name),
	handler,
});

/**
 * Build the tool registry.
 *
 * @param {object} deps
 * @param {Promise<string>} [deps.projectRootPromise] the resolved directory
 *   `open_project`/`save_project` confine themselves to; the owner resolves it
 *   because doing so chdirs the process.
 * @param {object} [deps.motionJobs] the MotionJobRegistry `generate_motion`
 *   records work in.
 * @param {(job: object) => Promise<void>} [deps.publishMotionJob] delivers a
 *   finished job to its workspace; the owner holds it because the live hub's
 *   reconnect and cancel paths publish jobs too.
 * @returns {Array<{name: string, title: string, description: string, inputSchema: object, annotations: object, live: boolean, handler: Function}>}
 */
export const createToolHandlers = ({ projectRootPromise, motionJobs, publishMotionJob } = {}) => {
	const resolveProjectPath = async (path, { existing }) => {
		if (!path.endsWith(".cclayproject")) throw new Error("Project path must end in .cclayproject.");
		const root = await projectRootPromise;
		const requested = resolve(path);
		const requestedParent = await realpath(dirname(requested));
		if (requestedParent !== root) throw new Error(`Project files must be direct children of configured project root ${root}.`);
		const name = basename(requested);
		if (!name || name.includes("/")) throw new Error("Project filename is invalid.");
		if (existing) {
			const file = await openFile(name, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
			try {
				await requirePrivateProjectInode(file);
			} finally {
				await file.close();
			}
		}
		return { displayPath: requested, descriptorPath: name };
	};

	return [
		tool(
			"describe_scene",
			{
				title: "Describe the scene",
				description:
					"Read the authoring state: camera, lens, current framing, cast positions and set objects. " +
					"Cast and set reads return at most 50 entries by default (100 maximum); each section reports " +
					"total, returned, truncated and revision. Use character_cursor or object_cursor to read omitted entries.",
				inputSchema: {
					character_cursor: z.number().int().min(0).default(0).describe("zero-based cast entry offset"),
					object_cursor: z.number().int().min(0).default(0).describe("zero-based set object offset"),
					limit: z.number().int().min(1).max(100).default(50).describe("entries returned per cast and set section"),
				},
			},
			async ({ character_cursor, object_cursor, limit }) => {
				try {
					await refreshLiveDescription();
					return text(sceneReport({ characterCursor: character_cursor, objectCursor: object_cursor, limit }));
				} catch (error) {
					return liveError(error);
				}
			},
		),

		tool(
			"live_status",
			{
				title: "Live editor status",
				description:
					"Report connected CozyClay editor workspaces and their handles. Multiple editor instances stay connected; " +
					"mutations require a workspace_handle whenever routing would otherwise be ambiguous.",
				inputSchema: {},
			},
			async () => text(
				liveHub?.connected
					? `Live editor connected. Workspaces:\n` + liveHub.workspaceHandleDetails().map((entry) => {
						const label = entry.meta?.project || entry.meta?.scene
							? ` — ${[entry.meta.project, entry.meta.scene, entry.meta.cast != null ? `${entry.meta.cast} in cast` : null].filter(Boolean).join(" / ")}`
							: "";
						return `  ${entry.handle}${label}`;
					}).join("\n")
					: noLiveEditor("No live editor connected; using in-memory state."),
			),
		),

		tool(
			"describe_shot",
			{
				title: "Describe the current shot",
				description:
					"Turn the current camera geometry into film vocabulary — shot size, angle on the subject, " +
					"camera level, and the nearest real prime lens. This is what the camera is actually seeing.",
				inputSchema: {},
			},
			async () => {
				try {
					await refreshLiveDescription();
					return text(shotReport());
				} catch (error) {
					return liveError(error);
				}
			},
		),

		tool(
			"capture_frame",
			{
				title: "Capture a compressed blocking frame",
				description:
					"Unlike render_prompt, capture_frame reads the connected editor's rendered 640x360 preview and computed spatial assertions without changing authored scene, playback or camera state. " +
					"It returns an inline PNG when it fits max_inline_bytes, otherwise a local artifact path with the same dimensions and byte size.",
				inputSchema: {
					max_inline_bytes: z.number().int().min(1024).max(1_000_000).default(200_000)
						.describe("maximum PNG byte size returned inline; larger frames are written to a local artifact"),
				},
			},
			async ({ max_inline_bytes }) => {
				if (!liveHub?.connected) return liveError(new Error(noLiveEditor("capture_frame requires a connected CozyClay editor with a renderable shot camera.")));
				try {
					const workspaceHandle = liveWorkspace.getStore();
					const frame = await liveHub.command("capture_frame", {}, workspaceHandle);
					const beforeHash = createHash("sha256").update(frame?.authoredStateBefore ?? "").digest("hex");
					const afterHash = createHash("sha256").update(frame?.authoredStateAfter ?? "").digest("hex");
					if (beforeHash !== afterHash) {
						throw new Error(`capture_frame changed authored editor state; capture was rejected (${beforeHash} -> ${afterHash}).`);
					}
					if (!frame || frame.width !== 640 || frame.height !== 360 || frame.mimeType !== "image/png" || typeof frame.data !== "string") {
						throw new Error("Live editor returned an invalid capture payload.");
					}
					const bytes = Buffer.from(frame.data, "base64");
					if (bytes.length === 0 || bytes.length !== frame.byteSize || bytes.length > MAX_CAPTURE_BYTES) {
						throw new Error(`Live editor returned an invalid compressed image size (maximum ${MAX_CAPTURE_BYTES} bytes).`);
					}
					if (frame.assertions?.renderable !== true || frame.assertions?.blackFrame === true) {
						throw new Error("Live editor rejected the capture as non-renderable or black.");
					}
					const metadata = {
						width: frame.width,
						height: frame.height,
						mimeType: frame.mimeType,
						encoding: frame.encoding,
						byteSize: frame.byteSize,
						assertions: frame.assertions,
						stateHashBefore: beforeHash,
						stateHashAfter: afterHash,
					};
					if (bytes.length > max_inline_bytes) {
						while (captureArtifacts.length >= MAX_CAPTURE_ARTIFACTS) {
							const oldest = captureArtifacts.shift();
							await unlink(oldest).catch(() => {});
						}
						const path = join(tmpdir(), `cozyclay-capture-${randomUUID()}.png`);
						await writeFile(path, bytes, { mode: 0o600 });
						captureArtifacts.push(path);
						const expiry = setTimeout(() => {
							const index = captureArtifacts.indexOf(path);
							if (index >= 0) captureArtifacts.splice(index, 1);
							void unlink(path).catch(() => {});
						}, CAPTURE_ARTIFACT_TTL_MS);
						expiry.unref?.();
						return text(JSON.stringify({ ...metadata, artifact: { path, width: frame.width, height: frame.height, byteSize: bytes.length } }));
					}
					return {
						content: [
							{ type: "text", text: JSON.stringify({ ...metadata, image: { transport: "inline", width: frame.width, height: frame.height, byteSize: bytes.length } }) },
							{ type: "image", data: frame.data, mimeType: frame.mimeType },
						],
					};
				} catch (error) {
					return liveError(error);
				}
			},
		),

		tool(
			"set_camera",
			{
				title: "Set the camera",
				description:
					"Unlike frame_shot, set_camera applies explicit camera coordinates or focal length rather than deriving a shot. " +
					"Every field is optional — omitted fields keep their current value. The shot is measured as if the camera aims at the subject; " +
					"pass look_at_x/look_at_y/look_at_z together to actually point a connected editor's lens at a world point. Use focal_mm to change " +
					"framing without moving (longer = tighter), or move x/y/z to change the angle.",
				inputSchema: {
					x: z.number().optional().describe("world x in metres (right)"),
					y: z.number().optional().describe("lens height above the floor in metres"),
					z: z.number().optional().describe("world z in metres (toward default camera side)"),
					focal_mm: z
						.number()
						.min(8)
						.max(300)
						.optional()
						.describe("focal length on the scene's cropped filmback, e.g. 24, 35, 50, 85"),
					look_at_x: z.number().optional().describe("world x of an explicit aim point; give all three to aim the lens"),
					look_at_y: z.number().optional().describe("world y of an explicit aim point; give all three to aim the lens"),
					look_at_z: z.number().optional().describe("world z of an explicit aim point; give all three to aim the lens"),
				},
			},
			async ({ x, y, z: zPos, focal_mm, look_at_x, look_at_y, look_at_z }) => {
				if (liveHub?.connected) {
					try {
						// The aim is only forwarded when the caller gave a whole point: a
						// partial target has no direction, and an omitted one deliberately
						// leaves the live editor's orientation exactly where it was.
						const aim = [look_at_x, look_at_y, look_at_z].every((value) => value !== undefined)
							? { lookAtX: look_at_x, lookAtY: look_at_y, lookAtZ: look_at_z }
							: {};
						await appliedLiveMutation("set_camera", { x, y, z: zPos, focalMm: focal_mm, ...aim });
						return text(`Camera set.\n\n${shotReport()}`);
					} catch (error) {
						return liveError(error);
					}
				}
				if (x !== undefined) state.camera.x = x;
				if (y !== undefined) state.camera.y = y;
				if (zPos !== undefined) state.camera.z = zPos;
				if (focal_mm !== undefined) state.camera.focalMm = focal_mm;
				return text(`Camera set.\n\n${shotReport()}`);
			},
		),

		tool(
			"frame_shot",
			{
				title: "Frame a shot by intent",
				description:
					"Unlike set_camera, frame_shot derives camera position and lens from shot intent rather than applying explicit coordinates. " +
					"It chooses a distance and height that actually produce the requested size and level, " +
					"orbiting to the requested side of the subject.",
				inputSchema: {
					size: z
						.enum([
							"extreme close-up",
							"close-up",
							"medium close-up",
							"medium shot",
							"medium-wide shot",
							"wide shot",
							"extreme wide shot",
						])
						.describe("how much of the frame the subject fills"),
					view: z
						.enum(["front", "front three-quarter", "profile", "rear three-quarter", "back"])
						.default("front three-quarter")
						.describe("which side of the subject the camera sits on"),
					level: z
						.enum(["ground", "low", "hip", "eye", "high", "overhead"])
						.default("eye")
						.describe("how high the lens rides"),
					side: z.enum(["left", "right"]).default("right").describe("camera left or camera right"),
					focal_mm: z.number().min(8).max(300).default(35).describe("lens to frame with"),
				},
			},
			async ({ size, view, level, side, focal_mm }) => {
				if (liveHub?.connected) {
					try {
						await refreshLiveDescription();
					} catch (error) {
						return liveError(error);
					}
				}
				// Midpoints of shot.js's SIZE_TABLE bands, so the label that comes back is
				// the label that was asked for rather than whatever sits on a boundary.
				const FRACTION = {
					"extreme close-up": 3.4,
					"close-up": 2.2,
					"medium close-up": 1.375,
					"medium shot": 0.975,
					"medium-wide shot": 0.66,
					"wide shot": 0.41,
					"extreme wide shot": 0.2,
				};
				// Heights that land mid-band in shot.js's LEVEL_TABLE.
				const HEIGHT = { ground: 0.3, low: 0.7, hip: 1.1, eye: 1.65, high: 2.1, overhead: 2.8 };
				// Angle off the subject's facing direction, in degrees.
				const ANGLE = { front: 0, "front three-quarter": 40, profile: 90, "rear three-quarter": 140, back: 180 };

				const s = subject();
				let lensMm = focal_mm;
				// Invert deriveShot's screenFraction: distance that yields the target size.
				const distanceFor = (mm) => {
					const gate = filmback();
					return 1.8 / (2 * FRACTION[size] * Math.tan(focalMmToFov(mm, gate.sensorId, gate.aspectRatio) / 2));
				};

				// Size and level can physically conflict: an extreme close-up on a wide
				// lens sits half a metre from the pivot, which no overhead rig can also
				// satisfy. Size is the stronger request (it is the shot), so the lens is
				// lengthened until the requested level fits, exactly as a crew would swap
				// glass rather than abandon the close-up.
				const neededDy = Math.abs(HEIGHT[level] - FRAMING_PIVOT_Y);
				const MIN_HORIZONTAL = 0.25;
				const needed = Math.hypot(neededDy, MIN_HORIZONTAL);
				if (distanceFor(lensMm) < needed) {
					for (const mm of [50, 85, 100, 135, 180, 240, 300]) {
						if (mm <= lensMm) continue;
						lensMm = mm;
						if (distanceFor(mm) >= needed) break;
					}
				}
				const distance = distanceFor(lensMm);
				let camY = HEIGHT[level];
				// deriveShot measures distance in 3D to the framing pivot, so the height
				// offset has to come out of the requested distance. A very tight shot from
				// a very high or low lens can ask for more vertical offset than the whole
				// distance allows; when that happens the size is what was actually asked
				// for, so the lens is pulled toward the pivot rather than the shot widened.
				let dy = camY - FRAMING_PIVOT_Y;
				const maxDy = Math.sqrt(Math.max(distance * distance - MIN_HORIZONTAL * MIN_HORIZONTAL, 0));
				if (Math.abs(dy) > maxDy) {
					dy = Math.sign(dy) * maxDy;
					camY = FRAMING_PIVOT_Y + dy;
				}
				const horizontal = Math.sqrt(Math.max(distance * distance - dy * dy, MIN_HORIZONTAL * MIN_HORIZONTAL));

				// deriveShot calls it camera-right when cross(facing, toCamera) >= 0, which
				// is the negative yaw direction here — so camera-left orbits by +angle.
				const sign = side === "right" ? -1 : 1;
				const theta = ((s.rot + sign * ANGLE[view]) * Math.PI) / 180;

				const nextCamera = {
					x: s.x + Math.sin(theta) * horizontal,
					z: s.z + Math.cos(theta) * horizontal,
					y: camY,
					focalMm: lensMm,
				};
				if (liveHub?.connected) {
					try {
						// Placing the lens is only half the shot. deriveShot and captureFraming
						// both measure as if the lens points at the framing pivot (see
						// aimAtSubject), which the in-memory path gets for free because it has
						// no orientation at all. A live editor has one and keeps it, so a
						// position-only move orbited every view except `front` off the subject
						// while the slate still read "98% of frame height". Send the same pivot
						// the vocabulary is measured against, with the position.
						await appliedLiveMutation("set_camera", {
							...nextCamera,
							lookAtX: s.x,
							lookAtY: FRAMING_PIVOT_Y,
							lookAtZ: s.z,
						});
					} catch (error) {
						return liveError(error);
					}
				} else {
					Object.assign(state.camera, nextCamera);
				}

				const note =
					lensMm !== focal_mm
						? `Note: ${focal_mm}mm could not hold a ${size} from ${level} level — the lens would have to be ` +
							`inside the subject. Went to ${lensMm}mm to keep the size and the angle.\n\n`
						: "";
				return text(`${note}Framed.\n\n${shotReport()}`);
			},
		),

		tool(
			"add_character",
			{
				title: "Add a character to the cast",
				description:
					"Unlike place_character, add_character adds a new cast member instead of changing an existing one. " +
					"The cast is unbounded — each one gets its own letter (A, B, C…), position and prompt description.",
				inputSchema: {
					subject: z.string().describe('prompt description, e.g. "a courier holding a package"'),
					x: z.number().default(0).describe("floor position x in metres"),
					z: z.number().default(0).describe("floor position z in metres"),
					facing: z.number().default(0).describe("yaw in degrees; 0 faces the default camera"),
					model: z
						.enum(CHARACTER_MODEL_IDS)
						.optional()
						.describe("which mannequin to use"),
				},
			},
			async ({ subject: desc, x, z: zPos, facing, model }) => {
				if (liveHub?.connected) {
					try {
						const result = await appliedLiveMutation("add_character", { subject: desc, x, z: zPos, rot: facing, model });
						const added = stage().characters.find((character) => character.id === result?.id);
						if (added && model !== undefined) added.model = model;
						return text(`Added ${result?.id ?? "character"}.\n\n${sceneReport()}`);
					} catch (error) {
						return liveError(error);
					}
				}
				const st = stage();
				const index = st.characters.length;
				// The default scene already owns "char-a", and createCharacterEntry only
				// falls back to `char-<n>` when no id is supplied, so pick the first id
				// the cast is not already using instead of assuming a naming scheme.
				const taken = new Set(st.characters.map((c) => c.id));
				let id = `char-${String.fromCharCode(97 + index)}`;
				for (let n = index + 1; taken.has(id); n += 1) id = `char-${n}`;
				const entry = createCharacterEntry({ id, subject: desc, x, z: zPos, rot: facing, model }, index);
				st.characters = [...st.characters, entry];
				return text(`Added ${String.fromCharCode(65 + index)} (${entry.id}).\n\n${sceneReport()}`);
			},
		),

		tool(
			"place_character",
			{
				title: "Move or re-describe a character",
				description:
					"Unlike add_character, place_character changes an existing cast member instead of adding one. " +
					"Every field is optional; omitted fields keep their value.",
				inputSchema: {
					character: z
						.string()
						.default("A")
						.describe('which character — a letter ("A"), a slot number ("2") or an id ("char-a")'),
					x: z.number().optional().describe("floor position x in metres"),
					z: z.number().optional().describe("floor position z in metres"),
					y: z
						.number()
						.min(0)
						.optional()
						.describe("height above the floor in metres — stand a character on a roof; 0 is the street"),
					facing: z.number().optional().describe("yaw in degrees; 0 faces the default camera"),
					subject: z.string().optional().describe("prompt description"),
					hidden: z.boolean().optional().describe("hide without removing from the cast"),
				},
			},
			async ({ character, x, z: zPos, y, facing, subject: desc, hidden }) => {
				if (liveHub?.connected) {
					try {
						await appliedLiveMutation("update_character", { ref: character, x, y, z: zPos, rot: facing, subject: desc, hidden });
						return text(`Character updated.\n\n${sceneReport()}`);
					} catch (error) {
						return liveError(error);
					}
				}
				const target = findCharacter(character);
				if (!target) return text(`No character "${character}". ${castHint()}`);
				if (x !== undefined) target.x = x;
				if (y !== undefined) target.y = y;
				if (zPos !== undefined) target.z = zPos;
				if (facing !== undefined) target.rot = facing;
				if (desc !== undefined) target.subject = desc;
				if (hidden !== undefined) target.hidden = hidden;
				return text(`Character ${letterFor(target)} updated.\n\n${sceneReport()}`);
			},
		),

		tool(
			"remove_character",
			{
				title: "Remove a character",
				description: "Take a character out of the cast. The last remaining character cannot be removed.",
				inputSchema: {
					character: z.string().describe('which character — letter, slot number or id'),
				},
			},
			async ({ character }) => {
				if (liveHub?.connected) {
					try {
						await appliedLiveMutation("remove_character", { ref: character });
						return text(`Character removed.\n\n${sceneReport()}`);
					} catch (error) {
						return liveError(error);
					}
				}
				const st = stage();
				const target = findCharacter(character);
				if (!target) return text(`No character "${character}". ${castHint()}`);
				if (st.characters.length === 1) return text("The scene needs at least one character.");
				const letter = letterFor(target);
				st.characters = st.characters.filter((c) => c !== target);
				if (state.focus && !findCharacter(state.focus)) {
					state.focus = null;
					state.focusLocked = false;
				}
				return text(`Removed ${letter}.\n\n${sceneReport()}`);
			},
		),

		tool(
			"focus_character",
			{
				title: "Choose who the camera frames",
				description:
					"Pick which character the shot is measured against. describe_shot, frame_shot and " +
					"render_prompt all frame this character. Defaults to the first of the cast.",
				inputSchema: {
					character: z.string().describe('which character — letter, slot number or id'),
				},
			},
			async ({ character }) => {
				try {
					await refreshLiveDescription();
				} catch (error) {
					return liveError(error);
				}
				const target = findCharacter(character);
				if (!target) return text(`No character "${character}". ${castHint()}`);
				state.focus = target.id;
				state.focusLocked = true;
				return text(`Framing ${letterFor(target)} "${target.subject}".\n\n${shotReport()}`);
			},
		),

		tool(
			"place_object",
			{
				title: "Place an object in the set",
				description:
					`Unlike update_object, place_object adds a new prop instead of changing an existing one. Available kinds: ${OBJECT_LIBRARY.map((o) => o.kind).join(", ")}. ` +
					"It returns the object id, which update_object and remove_object take.",
				inputSchema: {
					kind: z
						.enum(OBJECT_LIBRARY.map((o) => o.kind))
						.describe("what to place"),
					x: z.number().default(0).describe("floor position x in metres"),
					z: z.number().default(0).describe("floor position z in metres"),
					y: z.number().optional().describe("height above the floor; 0 stands on the deck"),
					facing: z.number().optional().describe("yaw in degrees"),
					name: z.string().min(1).optional().describe("display name, e.g. 'Building A / Roof'"),
					parent: z
						.string()
						.optional()
						.describe("object id to attach to — the parent then carries this object when it moves"),
				},
			},
			async ({ kind, x, z: zPos, y, facing, name, parent }) => {
				if (liveHub?.connected) {
					try {
						const result = await appliedLiveMutation("place_object", { kind, x, z: zPos, y, rot: facing, name, parent });
						return text(`Placed object as ${result?.id ?? "unknown"}.\n\n${sceneReport()}`);
					} catch (error) {
						return liveError(error);
					}
				}
				const sc = scene();
				// The parent is checked before anything is created: a bad id must not
				// leave a half-made part lying around unattached.
				if (parent !== undefined && !sc.objects.some((o) => o.id === parent)) {
					return text(`No object "${parent}" to attach to. Call describe_scene for the current ids.`);
				}
				const placement = { x, z: zPos };
				if (y !== undefined) placement.y = y;
				if (facing !== undefined) placement.rot = facing;
				const object = createSceneObject(kind, sc.objects, placement);
				sc.objects = [...sc.objects, object];
				if (name !== undefined) sc.objects = updateSceneObject(sc.objects, object.id, { name });
				if (parent !== undefined) sc.objects = setSceneObjectParent(sc.objects, object.id, parent);
				const placed = sc.objects.find((o) => o.id === object.id);
				return text(
					`Placed ${placed.name} as ${placed.id}${parent !== undefined ? ` under ${parent}` : ""}.\n\n${sceneReport()}`,
				);
			},
		),


		tool(
			"group_objects",
			{
				title: "Group props so they move as one",
				description:
					"Attach objects to a parent object. The parent then carries them whenever it moves — in " +
					"the studio's gizmo as well as through update_object — so a set piece assembled from " +
					"primitives can be positioned as a single thing. Rotation and scale stay per-object. " +
					"Pass parent: null to detach.",
				inputSchema: {
					parent: z.string().nullable().describe("object id to attach to, or null to detach"),
					children: z.array(z.string()).min(1).describe("object ids to attach or detach"),
				},
			},
			async ({ parent, children }) => {
				if (liveHub?.connected) {
					try {
						await appliedLiveMutation(parent === null ? "ungroup_objects" : "group_objects", { parent, children });
						return text(
							(parent === null
								? `Detached ${children.length} object(s).`
								: `Grouped ${children.length} object(s) under ${parent} — move ${parent} and they follow.`) +
								`\n\n${sceneReport()}`,
						);
					} catch (error) {
						return liveError(error);
					}
				}
				const sc = scene();
				if (parent !== null && !sc.objects.some((o) => o.id === parent)) return text(`No object "${parent}".`);
				for (const child of children) {
					if (!sc.objects.some((o) => o.id === child)) return text(`No object "${child}".`);
				}
				sc.objects = children.reduce((acc, child) => setSceneObjectParent(acc, child, parent), sc.objects);
				return text(
					(parent === null ? `Detached ${children.length} object(s).` : `Grouped ${children.length} object(s) under ${parent}.`) +
						`\n\n${sceneReport()}`,
				);
			},
		),

		tool(
			"set_prompt_blocks",
			{
				title: "Author the motion beats on the timeline",
				description:
					"Write Prompt Blocks onto the timeline WITHOUT generating — the beats and their frame " +
					"ranges, so a schedule can be read and revised before any GPU time is spent. Hit " +
					"'Generate all N blocks' in the studio, or call generate_motion, when it reads right.\n\n" +
					PROMPT_GUIDE,
				inputSchema: {
					beats: z
						.array(
							z.object({
								text: z.string().min(3).describe("the beat, in ARDY's sentence shape"),
								seconds: z
									.number()
									.min(0.5)
									.max(20)
									.optional()
									.describe(`how long this beat holds; defaults to 3 s when omitted, and over ${BLOCK_MAX_SECONDS}s it becomes chained blocks`),
							}),
						)
						.min(1)
						.max(8)
						.describe("beats in order; each one becomes a contiguous block"),
				},
			},
			async ({ beats }) => {
				if (!liveHub?.connected) {
					return text("Prompt Blocks live on the studio timeline — open the editor and try again.");
				}
				const normalized = normalizePhases(beats.map((b) => b.text));
				// The timeline runs on a 24 fps production clock.
				const TIMELINE_FPS = 24;
				let cursor = 0;
				let chained = 0;
				const blocks = [];
				for (const [i, textValue] of normalized.texts.entries()) {
					const whole = beats[Math.min(normalized.sources[i], beats.length - 1)].seconds ?? 3;
					const spans = splitLongBeat(whole);
					if (spans.length > 1) chained += spans.length - 1;
					for (const span of spans) {
						const frames = Math.max(1, Math.round(span * TIMELINE_FPS));
						blocks.push({ startFrame: cursor, endFrame: cursor + frames, text: textValue });
						cursor += frames;
					}
				}
				try {
					await appliedLiveMutation("set_prompt_blocks", { blocks });
				} catch (error) {
					return liveError(error);
				}
				// Report the normalised text itself, not blocks[i]: a long beat becomes
				// several blocks, so block indices run ahead of phase indices and quoting
				// blocks[i] would attribute one beat's edits to another beat's wording.
				const rewrites = normalized.notes
					.map((notes, i) => (notes.length ? `  ${i + 1}. ${normalized.texts[i]}  ← ${notes.join("; ")}` : null))
					.filter(Boolean);
				return text(
					`${blocks.length} block(s) on the timeline (${(cursor / TIMELINE_FPS).toFixed(1)}s total):\n` +
						blocks.map((b) => `  ${b.startFrame}-${b.endFrame}f  ${b.text}`).join("\n") +
						(chained > 0 ? `\n  (${chained} block(s) chained to keep every block within ${BLOCK_MAX_SECONDS}s)` : "") +
						(rewrites.length ? `\n\nRewritten for ARDY:\n${rewrites.join("\n")}` : "") +
						(normalized.dropped > 0 ? `\n  (${normalized.dropped} beat(s) past the 8-phase limit were dropped)` : "") +
						"\n\nGenerate them from the studio's Prompt Blocks panel, or with generate_motion.",
				);
			},
		),

		tool(
			"load_motion",
			{
				title: "Load an existing motion take",
				description:
					"Unlike generate_motion, load_motion installs a previously generated or assembled motion take WITHOUT regenerating — " +
					"re-using a completed /ardy/motions/<id> take or an /ardy/assembled/*.npz tile (the long-take recipe). " +
					"It is synchronous and returns the editor's confirmation.",
				inputSchema: {
					url: z.string().describe("/ardy/motions/<id> or /ardy/assembled/<name>.npz"),
					prompt: z.string().optional().describe("Label shown on the timeline block."),
					character: z.string().optional().describe('which character receives the take — letter, slot number or id; defaults to the editor\u2019s active character'),
				},
			},
			async (args) => {
				if (!motionUrlPattern.test(args.url)) {
					throw new Error(`Unsupported motion url "${args.url}". Use /ardy/motions/<id> or /ardy/assembled/<name>.npz.`);
				}
				const workspaceHandle = liveWorkspace.getStore() ?? liveHub.resolveWorkspace("load_motion", args.workspace_handle);
				// Without an explicit target the editor installs onto ITS active character,
				// which silently stacks multi-cast loads onto one rig — the generate path
				// always names its target, so the load path must be able to as well.
				let characterId;
				if (args.character !== undefined) {
					try {
						await refreshLiveDescription();
					} catch (error) {
						return liveError(error);
					}
					const target = findCharacter(args.character);
					if (!target) return text(`No character "${args.character}". ${castHint()}`);
					characterId = target.id;
				}
				await liveHub.command("load_motion", { url: args.url, prompt: args.prompt ?? "", ...(characterId ? { characterId } : {}) }, workspaceHandle);
				return text(`Motion installed from ${args.url}${characterId ? ` onto ${characterId}` : ""}.`);
			},
		),

		tool(
			"generate_motion",
			{
				title: "Generate character motion (Kimodo)",
				description:
					"Start a multi-phase Kimodo motion job for the connected live editor and return immediately with its " +
					"task-shaped identity. Completion, failure, or cancellation arrives as the live socket's motion_job event; " +
					"the MCP model does not poll task state. A completed event loads the active character's timeline.\n\n" +
					PROMPT_GUIDE,
				inputSchema: {
					phases: z
						.array(
							z.union([
								z.string().min(3),
								z.object({
									text: z.string().min(3),
									seconds: z.number().min(0.5).max(30).describe("how long THIS beat holds"),
								}),
							]),
						)
						.min(1)
						.max(8)
						.describe(
							"one beat per phase, in order. Follow the shared Kimodo prompt guide in this tool's " +
								"description; it is the single source for prompt wording and phase guidance. Give a " +
								"plain string to share the clip evenly, or { text, seconds } to hold a beat for a " +
								"specific time.",
						),
					seconds: z
						.number()
						.min(2)
						.max(60)
						.default(9)
						.describe("total clip length; ignored when every phase carries its own seconds"),
					seed: z.number().int().optional().describe("generation seed"),
					motion_url: z
						.string()
						.regex(motionUrlPattern)
						.optional()
						.describe("reuse an already-generated clip, or a curated clip staged under public/ardy/assembled/"),
					drop: z
						.object({
							from_s: z.number().min(0).describe("clip time the plunge begins, seconds"),
							to_s: z.number().positive().describe("clip time it lands, seconds; must be after from_s"),
							meters: z.number().positive().max(30).describe("how far the body falls"),
						})
						.optional()
						.describe(
							"a vertical fall staged onto the clip — the whole body drops this many metres over " +
								"[from_s, to_s] on a gravity curve. Stand the character on a roof with place_character's " +
								"y, then drop them past its edge; ARDY itself only generates flat-ground motion.",
						),
				},
			},
			async ({ phases: rawPhases, seconds, seed, motion_url, drop }) => {
				const phases = rawPhases.map((p) => (typeof p === "string" ? p : p.text));
				const phaseSeconds = rawPhases.map((p) => (typeof p === "string" ? null : p.seconds));
				const timed = phaseSeconds.some((s) => s !== null);
				const bridge = process.env.COZYCLAY_BRIDGE ?? "http://127.0.0.1:5181";

				// Every phase is rewritten into ARDY's own sentence shape before it is ever
				// sent. One input beat stays one phase: the caller's phase list is the
				// sequence, so a composite beat is theirs to split, not ours to re-cut.
				const normalized = normalizePhases(phases);
				// Keep notes beside the prompt they belong to: a blank beat normalises to
				// "" and is dropped, which would otherwise slide every later note onto the
				// wrong prompt in the rewrite report.
				const kept = normalized.texts
					.map((t, i) => ({ text: t, notes: normalized.notes[i], source: normalized.sources[i] }))
					.filter((p) => p.text);
				const prompts = kept.map((p) => p.text);
				// One complete beat is a legitimate clip — ARDY's own examples are single
				// prompts ("A person walks in a circle."), so a valid one-phase request must
				// not fail merely for being one phase. Only an empty request is refused.
				if (prompts.length === 0) return text("Give at least one motion beat.");

				// ARDY Core is 20 fps; segments must tile 0..clipFrames exactly, and each
				// one needs at least 3 frames.
				const ARDY_FPS =
					(process.env.CCLAY_MOTION_BACKEND || "kimodo").trim().toLowerCase() === "kimodo" ? 24 : 20;
				let segments;
				let clipFrames;
				let chained = 0;
				if (timed) {
					// A beat that became several blocks shares its time between them, so an
					// explicit "6 seconds of walking" stays 6 seconds however it was phrased.
					const pieceCount = kept.reduce((acc, piece) => {
						acc[piece.source] = (acc[piece.source] ?? 0) + 1;
						return acc;
					}, {});
					segments = [];
					let cursor = 0;
					for (const { text: prompt, source } of kept) {
						const whole = phaseSeconds[source] ?? seconds / phases.length;
						const share = whole / pieceCount[source];
						// The studio caps a block at BLOCK_MAX_SECONDS and refuses to generate
						// a longer one, so a long beat becomes consecutive blocks here rather
						// than something the UI would reject.
						const spans = splitLongBeat(share);
						if (spans.length > 1) chained += spans.length - 1;
						for (const span of spans) {
							const startFrame = cursor;
							cursor += Math.max(3, Math.round(span * ARDY_FPS));
							segments.push({ startFrame, endFrame: cursor, prompt });
						}
					}
					clipFrames = cursor;
				} else {
					clipFrames = Math.floor(seconds * ARDY_FPS);
					// Even division must also respect the cap: enough blocks that no single
					// one exceeds it, distributed evenly across the clip.
					const perPhase = seconds / prompts.length;
					const piecesPer = Math.ceil(perPhase / BLOCK_MAX_SECONDS);
					if (piecesPer > 1) chained = prompts.length * (piecesPer - 1);
					const total = prompts.length * piecesPer;
					const per = Math.floor(clipFrames / total);
					segments = [];
					for (const [i, prompt] of prompts.entries()) {
						for (let k = 0; k < piecesPer; k += 1) {
							const index = i * piecesPer + k;
							segments.push({
								startFrame: index * per,
								endFrame: index === total - 1 ? clipFrames : (index + 1) * per,
								prompt,
							});
						}
					}
				}
				const clipSeconds = clipFrames / ARDY_FPS;
				// A single beat has no sequence to chain: send it as a plain prompt;
				// composite physical wording remains intact in the normalized text.
				// Long single prompts are the exception: split the actual clip length
				// into equal Kimodo blocks so every wire segment stays within the cap.
				const singlePromptNeedsChain = prompts.length === 1 && clipSeconds > BLOCK_MAX_SECONDS;
				if (prompts.length === 1) {
					if (singlePromptNeedsChain) {
						segments = tileClipFrames(clipFrames, clipSeconds).map((b) => ({ ...b, prompt: prompts[0] }));
						chained = segments.length - 1;
					} else {
						chained = 0;
					}
				}
				const rewrites = kept
					.map(({ text: prompt, notes }, i) => (notes.length ? `  ${i + 1}. ${prompt}  ← ${notes.join("; ")}` : null))
					.filter(Boolean);
				const chainNote = chained > 0 ? `\n  (${chained} block(s) chained to keep every block within ${BLOCK_MAX_SECONDS}s)` : "";
				// A drop is reported on its own account: a caller can send nine already-perfect
				// phases, which produces no rewrite and no chaining yet still loses the ninth
				// to the schema's 8-phase limit, and silence there would hide a lost beat.
				const dropNote =
					normalized.dropped > 0 ? `\n  (${normalized.dropped} beat(s) past the 8-phase limit were dropped)` : "";
				const promptNote =
					rewrites.length || chainNote || dropNote
						? (rewrites.length ? `\n\nRewritten for ARDY:\n${rewrites.join("\n")}` : "\n") + dropNote + chainNote
						: "";

				if (!liveHub?.connected) return text(noLiveEditor("generate_motion requires a connected CozyClay editor so completion can be delivered over its live socket."));
				try {
					await refreshLiveDescription();
				} catch (error) {
					return liveError(error);
				}
				const workspaceHandle = liveWorkspace.getStore() ?? liveHub.resolveWorkspace("generate_motion");
				const workspaceId = liveHub.workspaceId(workspaceHandle);
				const targetCharacterId = stage().characters.find((character) => character.id === state.focus)?.id ?? stage().characters[0]?.id ?? null;
				let job;
				try {
					job = motionJobs.create(workspaceId);
				} catch (error) {
					return liveError(error);
				}
				const body =
					prompts.length === 1 && !singlePromptNeedsChain
						? { prompt: prompts[0], duration: clipSeconds, posePin: false }
						: { prompt: prompts.join(" "), duration: clipSeconds, segments, posePin: false };
				if (seed !== undefined) body.seed = seed;

				// Abort tears down the HTTP stream. The bridge owns the child process group
				// and kills it on disconnect, so cancellation stops generator work before a
				// terminal cancelled event is sent; it never reaches editor installation.
				const run = async () => {
					if (job.status === "cancelled") return;
					const controller = new AbortController();
					const deadline = setTimeout(() => controller.abort(new Error("Motion generation exceeded the 5 minute deadline.")), 5 * 60_000);
					deadline.unref?.();
					job.cancel = () => controller.abort();
					if (job.status === "cancelled") return;
					motionJobs.transition(job, "running");
					try {
						let motionUrl = motion_url;
						if (!motionUrl) {
							const res = await fetch(`${bridge}/ardy/generate`, {
								method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal,
							});
							if (!res.ok) throw new Error(`Generation refused (HTTP ${res.status}): ${await res.text()}`);
							const reader = res.body?.getReader();
							if (!reader) throw new Error("Generation response has no body stream.");
							const decoder = new TextDecoder();
							let buffer = "";
							for (;;) {
								const chunk = await reader.read();
								if (chunk.done) break;
								buffer += decoder.decode(chunk.value, { stream: true });
								let newline = buffer.indexOf("\n");
								while (newline !== -1) {
									const line = buffer.slice(0, newline).trim();
									buffer = buffer.slice(newline + 1);
									if (line) {
										const event = JSON.parse(line);
										if (event.event === "error") throw new Error(event.message ?? "Generator error.");
										if (event.event === "done") motionUrl = event.motionUrl;
									}
									newline = buffer.indexOf("\n");
								}
								if (motionUrl) break;
							}
						}
						if (job.status === "cancelled") return;
						if (typeof motionUrl !== "string") throw new Error("Generation ended without a motion.");
						if (!motionUrlPattern.test(motionUrl)) throw new Error("Generator returned an invalid motion URL.");
						motionJobs.transition(job, "completed", {
							motionUrl, prompt: prompts.join(" "), blocks: segments, drop, targetCharacterId,
							summary: `${clipSeconds.toFixed(1)}s / ${clipFrames} frames${promptNote}`,
						});
						await publishMotionJob(job);
					} catch (error) {
						if (job.status === "cancelled" || error?.name === "AbortError") {
							if (job.status !== "cancelled") motionJobs.transition(job, "cancelled", { message: "Generation cancelled before editor delivery." });
						} else {
							motionJobs.transition(job, "failed", { message: error instanceof Error ? error.message : "Motion generation failed." });
						}
						await publishMotionJob(job);
					} finally {
						clearTimeout(deadline);
						job.cancel = null;
					}
				};
				queueMicrotask(run);
				return text(JSON.stringify(motionJobs.task(job)));
			},
		),

		tool(
			"update_object",
			{
				title: "Move, rotate or scale an object",
				description:
					"Unlike place_object, update_object changes an existing prop instead of adding one. " +
					"Every field is optional; omitted fields are left alone. Transforms go through the same clamp/snap path the studio's gizmo uses.",
				inputSchema: {
					id: z.string().describe("object id from place_object or describe_scene"),
					x: z.number().optional(),
					y: z.number().optional(),
					z: z.number().optional(),
					facing: z.number().optional().describe("yaw in degrees"),
					tilt: z.number().optional().describe("pitch in degrees (rotation about x)"),
					roll: z.number().optional().describe("roll in degrees (rotation about z)"),
					scale: z.number().positive().optional().describe("uniform scale factor"),
					scale_x: z.number().positive().optional().describe("width scale; overrides `scale` on this axis"),
					scale_y: z.number().positive().optional().describe("height scale; overrides `scale` on this axis"),
					scale_z: z.number().positive().optional().describe("depth scale; overrides `scale` on this axis"),
					color: z
						.string()
						.regex(/^#[0-9a-fA-F]{6}$/)
						.optional()
						.describe("hex colour, e.g. #d9b18c"),
					name: z.string().min(1).optional().describe("new display name, e.g. 'Building A'"),
					path: z
						.object({
							points: z
								.array(z.object({ x: z.number(), y: z.number().optional(), z: z.number() }))
								.min(2)
								.describe("route through the set; y lifts the object so it can climb"),
							speed: z.number().min(0).optional().describe("metres per second; 0 or omitted spans the whole take"),
							face_travel: z.boolean().optional().describe("turn to face the direction of travel (default true)"),
							loop: z.boolean().optional(),
							extend: z.boolean().optional().describe("keep going in the final direction after the route ends"),
						})
						.nullable()
						.optional()
						.describe("travel path; null clears it and the object stands still again"),
				},
			},
			async ({ id, x, y, z: zPos, facing, tilt, roll, scale, scale_x, scale_y, scale_z, color, name, path }) => {
				const travelPath = path === null
					? null
					: path
						? { points: path.points.map((point) => ({ x: point.x, y: point.y ?? 0, z: point.z })), speed: path.speed ?? 0, faceTravel: path.face_travel !== false, loop: path.loop === true, extend: path.extend === true }
						: undefined;
				if (liveHub?.connected) {
					try {
						await appliedLiveMutation("update_object", {
							id, x, y, z: zPos, rot: facing, rotX: tilt, rotZ: roll,
							scale, scaleX: scale_x, scaleY: scale_y, scaleZ: scale_z, color, name,
							...(travelPath !== undefined ? { path: travelPath } : {}),
						});
						return text(`Updated ${id}.\n\n${sceneReport()}`);
					} catch (error) {
						return liveError(error);
					}
				}
				const sc = scene();
				if (!sc.objects.some((o) => o.id === id)) {
					return text(`No object "${id}" in this scene. Call describe_scene for the current ids.`);
				}
				const patch = {};
				if (x !== undefined) patch.x = x;
				if (y !== undefined) patch.y = y;
				if (zPos !== undefined) patch.z = zPos;
				if (facing !== undefined) patch.rot = facing;
				if (tilt !== undefined) patch.rotX = tilt;
				if (roll !== undefined) patch.rotZ = roll;
				if (scale !== undefined) {
					patch.scaleX = scale;
					patch.scaleY = scale;
					patch.scaleZ = scale;
				}
				if (scale_x !== undefined) patch.scaleX = scale_x;
				if (scale_y !== undefined) patch.scaleY = scale_y;
				if (scale_z !== undefined) patch.scaleZ = scale_z;
				if (color !== undefined) patch.color = color;
				if (name !== undefined) patch.name = name;
				sc.objects = updateSceneObject(sc.objects, id, patch);
				return text(`Updated ${id}.\n\n${sceneReport()}`);
			},
		),

		tool(
			"remove_object",
			{
				title: "Remove an object",
				description: "Take a prop out of the set.",
				inputSchema: { id: z.string().describe("object id") },
			},
			async ({ id }) => {
				if (liveHub?.connected) {
					try {
						await appliedLiveMutation("remove_object", { id });
						return text(`Removed ${id}.\n\n${sceneReport()}`);
					} catch (error) {
						return liveError(error);
					}
				}
				const sc = scene();
				if (!sc.objects.some((o) => o.id === id)) {
					return text(`No object "${id}" in this scene.`);
				}
				sc.objects = removeSceneObject(sc.objects, id);
				return text(`Removed ${id}.\n\n${sceneReport()}`);
			},
		),

		tool(
			"apply_batch",
			{
				title: "Apply object mutations as one undo step",
				description:
					"Apply up to 100 object mutations in the connected CozyClay editor as one user-visible undo entry. " +
					"This v1 batch is deliberately object-only: place_character, update_character and remove_character are rejected because character history is a separate store. " +
					"atomic defaults to false; when true, any failed operation restores the whole batch. stopOnError defaults to true and independently controls whether later operations run after a failure.",
				inputSchema: {
					ops: z
						.array(
							z.object({
								name: z.enum([
									"place_object",
									"update_object",
									"remove_object",
									"place_character",
									"update_character",
									"remove_character",
									"group_objects",
									"ungroup_objects",
									"apply_batch",
								]),
								args: z.record(z.unknown()),
							}),
						)
						.max(100)
						.describe("existing mutation commands to execute in order; nested apply_batch is rejected"),
					atomic: z.boolean().default(false).describe("roll back all operations if any operation fails"),
					stopOnError: z.boolean().default(true).describe("stop executing later operations after a failure"),
					label: z.string().min(1).default("MCP batch").describe("the single editor undo entry name"),
				},
			},
			async ({ ops, atomic, stopOnError, label }) => {
				if (!liveHub?.connected) return text(noLiveEditor("apply_batch requires a connected CozyClay editor."));
				try {
					const result = await appliedLiveMutation("apply_batch", { ops, atomic, stopOnError, label });
					const applied = Array.isArray(result?.applied) ? result.applied : [];
					const failed = Array.isArray(result?.failed) ? result.failed : [];
					const failure = failed[0];
					const summary = result?.rolledBack
						? `Batch rolled back after failure at operation ${failure?.index ?? "unknown"}.`
						: `Applied ${applied.length} operation(s).`;
					const detail = failure ? ` Failure at operation ${failure.index}: ${failure.error}.` : "";
					return text(`${summary}${detail}\n\n${sceneReport()}`);
				} catch (error) {
					return liveError(error);
				}
			},
		),

		tool(
			"render_prompt",
			{
				title: "Render the AI prompt for this shot",
				description:
					"Turn the current camera, cast and set into a prompt for an AI image or video model. " +
					"The prompt carries the real framing — shot size, lens, angle and level — so the " +
					"generated frame matches the blocking.",
				inputSchema: {
					mode: z.enum(["image", "video"]).default("video").describe("still or moving"),
					model: z
						.string()
						.optional()
						.describe(
							`target model id. video: ${VIDEO_MODELS.map((m) => m.id).join(", ")}. ` +
								`image: ${IMAGE_MODELS.map((m) => m.id).join(", ")}`,
						),
					environment: z
						.string()
						.describe('the real setting, e.g. "a rain-slicked Seoul side street at night"'),
					style: z
						.string()
						.default("cinematic film still, natural light")
						.describe('look and grade, e.g. "shot on 35mm film, warm practical light"'),
					camera_move: z
						.string()
						.default(CAMERA_MOVES[0])
						.describe(`camera move. Known: ${CAMERA_MOVES.filter((m) => m !== "Custom…").join(", ")}`),
					pose_phrase: z.string().default("").describe("what character A is doing"),
					pose2_phrase: z.string().default("").describe("what character B is doing"),
				},
			},
			async ({ mode, model, environment, style, camera_move, pose_phrase, pose2_phrase }) => {
				if (liveHub?.connected) {
					try {
						await refreshLiveDescription();
					} catch (error) {
						return liveError(error);
					}
				}
				const st = stage();
				const known = CAMERA_MOVES.includes(camera_move);
				// composePrompt frames two subjects: the one the camera is on, then the
				// next visible member of the cast.
				const framed = findCharacter(state.focus) ?? st.characters[0];
				const other = st.characters.find((c) => c !== framed && !c.hidden) ?? null;
				const prompt = composePrompt({
					mode,
					model: modelById(model) ?? undefined,
					shot: currentShot(),
					subject: framed.subject,
					subject2: other?.subject ?? null,
					posePhrase: pose_phrase,
					pose2Phrase: other ? pose2_phrase : "",
					environment,
					style,
					cameraMove: known ? camera_move : "Custom…",
					customMove: known ? "" : camera_move,
					hasCharSheet: st.hasCharSheet === true,
					hasEnvSheet: false,
				});
				return text(`${slateLine(currentShot())}\n\n${prompt}`);
			},
		),

		tool(
			"mark_camera_move",
			{
				title: "Mark the start of a camera move",
				description:
					"Snapshot the current framing as the A position of a camera move. Then move the camera " +
					"and call describe_camera_move to have the move named in film vocabulary.",
				inputSchema: {},
			},
			async () => {
				try {
					await refreshLiveDescription();
				} catch (error) {
					return liveError(error);
				}
				state.markedFraming = framing();
				return text(`Marked A position: ${slateLine(currentShot())}\n\nNow move the camera, then call describe_camera_move.`);
			},
		),

		tool(
			"describe_camera_move",
			{
				title: "Name the camera move",
				description:
					"Compare the marked A position against the camera's current B position and name the move " +
					"the way a crew would — dolly in, crane down, arc left, push, and so on.",
				inputSchema: {
					duration_s: z.number().positive().default(3).describe("how long the move takes, in seconds"),
				},
			},
			async ({ duration_s }) => {
				try {
					await refreshLiveDescription();
				} catch (error) {
					return liveError(error);
				}
				if (!state.markedFraming) {
					return text("No A position marked. Call mark_camera_move first, then move the camera.");
				}
				const move = classifyMove(state.markedFraming, framing(), subject(), { durationS: duration_s, ...filmback() });
				return text(
					[
						moveSlate(move),
						"",
						`from  ${slateLine(deriveShot(state.markedFraming.pos, subject(), (state.markedFraming.fovDeg * Math.PI) / 180, undefined, filmback()))}`,
						`to    ${slateLine(currentShot())}`,
						`over  ${duration_s}s`,
					].join("\n"),
				);
			},
		),

		tool(
			"add_scene",
			{
				title: "Add a scene",
				description:
					"Add another scene to the project and make it active. With a connected editor, the complete " +
					"scene document is forwarded through that workspace's load_scenes command before success is reported; " +
					"without one, this changes MCP memory only.",
				inputSchema: { name: z.string().default("SCENE 02").describe("scene name") },
			},
			async ({ name }) => {
				if (liveHub?.connected) {
					try {
						await refreshLiveDescription();
					} catch (error) {
						return liveError(error);
					}
				}
				const document = JSON.parse(JSON.stringify(state.doc));
				document.scenes = addScene(document.scenes, name);
				document.activeSceneId = document.scenes[document.scenes.length - 1].id;
				if (liveHub?.connected) {
					try {
						const live = await appliedLiveMutation("load_scenes", { document });
						requireLiveSceneParity("add_scene", document, live);
					} catch (error) {
						return liveError(error);
					}
				}
				state.doc = document;
				return text(`Added "${scene().name}".\n\n${sceneReport()}`);
			},
		),

		tool(
			"switch_scene",
			{
				title: "Switch the active scene",
				description:
					"Make a different scene active. With a connected editor, the complete scene document is forwarded " +
					"through that workspace's load_scenes command before success is reported; without one, this changes MCP memory only.",
				inputSchema: { name: z.string().describe("scene name to switch to") },
			},
			async ({ name }) => {
				if (liveHub?.connected) {
					try {
						await refreshLiveDescription();
					} catch (error) {
						return liveError(error);
					}
				}
				const target = state.doc.scenes.find((s) => s.name.toLowerCase() === name.toLowerCase());
				if (!target) {
					return text(`No scene "${name}". Have: ${state.doc.scenes.map((s) => s.name).join(", ")}`);
				}
				const document = JSON.parse(JSON.stringify(state.doc));
				document.activeSceneId = target.id;
				if (liveHub?.connected) {
					try {
						const live = await appliedLiveMutation("load_scenes", { document });
						requireLiveSceneParity("switch_scene", document, live);
					} catch (error) {
						return liveError(error);
					}
				}
				state.doc = document;
				return text(`Switched to "${scene().name}".\n\n${sceneReport()}`);
			},
		),

		tool(
			"open_project",
			{
				title: "Open a .cclayproject file",
				description:
					"Load a project authored in the CozyClay studio (or saved here). Replaces the current state.",
				inputSchema: { path: z.string().describe("path to a .cclayproject file") },
			},
			async ({ path }) => {
				let full;
				let raw;
				try {
					const resolved = await resolveProjectPath(path, { existing: true });
					full = resolved.displayPath;
					const file = await openFile(resolved.descriptorPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
					try {
						await requirePrivateProjectInode(file);
						raw = await file.readFile("utf8");
					} finally {
						await file.close();
					}
				} catch (error) {
					return text(`Could not read project: ${error.message}`);
				}
				const result = readProjectDocument(raw);
				if (!result.ok) return text(`Not a usable project file (${result.reason}): ${full}`);

				// Round-trip through readSceneDocument so an older document is migrated to
				// the current stage shape rather than trusted as-is.
				const scenes = readSceneDocument(serializeSceneDocument(result.project.scenesDocument));
				if (!scenes.document) return text(`That project was written by a newer CozyClay: ${full}`);
				const nextDocument = scenes.document;
				if (liveHub?.connected) {
					try {
						const live = await appliedLiveMutation("load_scenes", { document: nextDocument });
						requireLiveSceneParity("open_project", nextDocument, live);
					} catch (error) {
						return liveError(error);
					}
				}
				state.doc = nextDocument;
				state.name = result.project.name;
				state.focus = null;
				state.focusLocked = false;
				state.markedFraming = null;
				return text(`Opened ${full}.\n\n${sceneReport()}`);
			},
		),

		tool(
			"save_project",
			{
				title: "Save a .cclayproject file",
				description:
					"Write the current state as a .cclayproject file. The CozyClay studio opens this file " +
					"directly, so a scene blocked here can be finished in the UI.",
				inputSchema: {
					path: z.string().describe("destination path, ending in .cclayproject"),
					name: z.string().optional().describe("project name recorded in the file"),
					overwrite: z.boolean().default(false).describe("explicitly replace an existing project file"),
				},
			},
			async ({ path, name, overwrite }) => {
				if (name) state.name = name;
				if (liveHub?.connected) {
					try {
						await refreshLiveDescription();
					} catch (error) {
						return liveError(error);
					}
				}
				let full;
				try {
					const resolved = await resolveProjectPath(path, { existing: false });
					full = resolved.displayPath;
					path = resolved.descriptorPath;
				} catch (error) {
					return text(`Could not write project: ${error.message}`);
				}
				const project = createProjectDocument({
					scenesDocument: state.doc,
					workspaceLayout: null,
					customPoses: [],
					name: state.name,
				});
				try {
					if (overwrite) {
						try {
							const existing = await openFile(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
							try {
								await requirePrivateProjectInode(existing);
							} finally {
								await existing.close();
							}
						} catch (error) {
							if (error?.code !== "ENOENT") throw error;
						}
					}
					const temporaryPath = `.${path}.${randomUUID()}.tmp`;
					const file = await openFile(
						temporaryPath,
						fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
						0o600,
					);
					try {
						await requirePrivateProjectInode(file);
						await file.writeFile(JSON.stringify(project, null, "\t"), "utf8");
					} finally {
						await file.close();
					}
					try {
						if (overwrite) {
							await rename(temporaryPath, path);
						} else {
							await link(temporaryPath, path);
							await unlink(temporaryPath);
						}
					} catch (error) {
						await unlink(temporaryPath).catch(() => {});
						throw error;
					}
				} catch (error) {
					return text(`Could not write ${full}: ${error.message}`);
				}
				return text(`Saved "${state.name}" to ${full} (${state.doc.scenes.length} scene(s)).`);
			},
		),
	];
};
