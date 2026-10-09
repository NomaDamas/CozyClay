import { validateStudioCommand, validateStudioIdentity, STUDIO_TOOL_SCHEMAS, STUDIO_TOOLS, StudioProtocolError } from "../../src/studio-agent-protocol.js";
import { MAX_COMMAND_TIMEOUT_MS } from "../../mcp/live-hub.mjs";
import { generationArgs } from '../../src/motion/generation.js';

const STUDIO_TOOL_RECEIPT_NOTE = " The result may be a receipt with status \"partial\": ops[].droppedPaths names exactly which authored path each op refused, and delta[].after carries the value actually landed for that target -- quote both the requested and the landed value when you report this, never say only that some paths were not applied. A STALE_SCENE error means inspect_studio once for the fresh revision, then resubmit the identical operation with that revision; it is not a permanent failure.";
const STUDIO_INSPECT_NOTE = ' The per-turn context contains entityIndex and actionIndex. Read authored state and its set schemas with scope "document", optionally selecting kinds or ids. Legacy scene/shot/motion/selection scopes are document projections too; runtime facts remain in context. Scope "entities" pages entity detail by ids or query. Pass nextCursor as cursor for the next page; on STALE_CURSOR restart without it. Scope "catalogue" lists placeable kinds and patchable paths.';
const STUDIO_MUTATION_TOOLS = new Set(["operate_studio", "arrange_objects", "arrange_characters", "patch_elements", "frame_shot", "verify_result", "undo_edit", "run_action"]);
const schema = name => ({ type: "function", name, description: `Studio ${name.replaceAll("_", " ")} command.${name === "generate_motion" ? " Timing: give EITHER source.durationSeconds (total) with NO per-beat seconds, OR seconds on EVERY beat with NO durationSeconds. Generation is an alias for motion.generate in the editor, including the character's root path, pose controls and take preservation. A completed receipt is undoable with undo_edit; a started receipt carries jobId for run_action job.await or job.cancel. Generation does not certify motion quality: use verify_result for motion checks and report its evidence and any warnings. One generation per user message: a second call fails with GENERATION_LIMIT." : ""}${name === "verify_result" ? " Pass exactly one of receiptId or targets (not both). An earlier receipt stays verifiable after later edits: it answers stale: true with evidenceRevision (the revision that receipt describes) beside revision (the current one), and a requested frame is captured from the current scene; report the evidence as stale, never as current." : ""}${name === "inspect_studio" ? `${STUDIO_INSPECT_NOTE} scope "actions" lists the editor actions for run_action with their availability (the reason when unavailable); with ids it answers those actions' descriptions and input schemas.` : ""}${name === "run_action" ? " Run one editor action by id (actionIndex in the context lists them) with args matching its input schema; read the schema first with inspect_studio scope \"actions\" and ids instead of guessing. A mutating action answers with a receipt (action, summary, delta) that undo_edit reverts; a job action answers status \"started\", or \"completed\" with its output when it runs to its end; only an action declared generation \"motion\" counts as this message's one generation. A document action (scenes, the project file) answers status \"completed\" and is not undoable; when it opens another scene, its host names that scene and later commands are admitted there." : ""}${STUDIO_MUTATION_TOOLS.has(name) ? STUDIO_TOOL_RECEIPT_NOTE : ""}`, parameters: STUDIO_TOOL_SCHEMAS[name] });
export const studioToolSchemas = () => STUDIO_TOOLS.map(schema);
const text = value => typeof value === "string" ? value : JSON.stringify(value);

export function createStudioTools({ liveHub, workspaceHandle, session, resolveImage, previsMode } = {}) {
  if (!liveHub?.command || !workspaceHandle) throw new StudioProtocolError("LIVE_HUB_UNAVAILABLE", "An exact Studio workspace is required.");
  const mutationNames = STUDIO_MUTATION_TOOLS;
  // The turn's command index (the context's actionIndex, from the editor's own
  // registry) carries each action's declarations: `generation: "motion"` takes
  // the message's one motion generation (one tools instance serves one turn;
  // other jobs neither take nor meet that gate), and `timeoutMs` is the hub
  // deadline it runs under, which the hub bounds by MAX_COMMAND_TIMEOUT_MS.
  const declared = new Map((session?.actionIndex ?? []).map(row => [row.id, row]));
  // One motion generation per user message, shared with generate_motion when
  // the route passes the turn's gate; a bare tools instance keeps its own.
  const generationGate = session?.generation ?? { used: false, failures: 0 };
  const invoke = async (name, args) => {
    const command = validateStudioCommand({ name, args });
    if (name === 'generate_motion' && command.args.source.kind === 'generate') return invoke('run_action', { action: 'motion.generate', args: generationArgs(command.args) });
    const action = name === "run_action" ? declared.get(command.args.action) : undefined;
    const generation = action?.generation === "motion";
    if (generation && (generationGate.used || generationGate.pending)) throw new StudioProtocolError("GENERATION_LIMIT", "One motion generation per user message. Report this result and ask the user before generating again.");
    if (generation && (generationGate.failures ?? 0) >= 2) throw new StudioProtocolError("GENERATION_LIMIT", "Two motion generation attempts already failed in this user message. Report both failures to the user and ask before generating again.");
    const payload = mutationNames.has(name) && session?.admission
      ? { name, args: command.args, commandId: session.admission.commandId(), host: session.admission.host, expectedRevision: session.admission.revision, ...(session.admission.turnId ? { turnId: session.admission.turnId } : {}),
          ...(generation && session.onJob ? { wait: false } : {}) }
      : command.args;
    let result;
    if (generation) generationGate.pending = true;
    try {
      // A motion check samples the whole take in the editor, minutes on a long
      // take, so it waits under the hub ceiling rather than the Studio default.
      const timeoutMs = name === "run_action" ? (action?.timeoutMs === undefined ? undefined : Math.min(MAX_COMMAND_TIMEOUT_MS, action.timeoutMs + (generation ? 5000 : 0)))
        : name === "verify_result" && command.args.checks.includes("motion") ? MAX_COMMAND_TIMEOUT_MS : undefined;
      result = await (timeoutMs === undefined ? liveHub.command(name, payload, workspaceHandle) : liveHub.command(name, payload, workspaceHandle, { timeoutMs }));
      if (generation && result?.status === 'started' && session?.onJob) result = await session.onJob(result);
    } catch (error) {
      // A STALE_SCENE re-admits whichever family met it, so the retry the
      // model is told to make is admitted at the live revision.
      if (generation) generationGate.failures = (generationGate.failures ?? 0) + 1;
      if (session?.admission && (error?.code === "STALE_SCENE" || (mutationNames.has(name) && error?.code === "UNCERTAIN_APPLY"))) await session.admission.refresh();
      throw error;
    } finally { if (generation) generationGate.pending = false; }
    if (result?.ok === false) {
      // Rejection receipts carry code/message at the top level, not under `error`;
      // the receipt itself holds phase, recovery and target evidence the model needs.
      const code = result.code ?? result.error?.code;
      const message = result.message ?? result.error?.message ?? "Studio command failed";
      if (generation) generationGate.failures = (generationGate.failures ?? 0) + 1;
      if (session?.admission && (code === "STALE_SCENE" || result.mutated === true)) await session.admission.refresh();
      // An acknowledged Stop must settle its held card with the bus outcome,
      // not turn a proved cancellation into an interrupted/unknown tool.
      if (code === 'CANCELLED' && session?.onJob) return result;
      throw Object.assign(new Error(message), { code, receipt: result });
    }
    if (generation) generationGate.used = true;
    // A scene action that opened another scene answers the new host; later
    // commands in this turn are admitted there, never in another workspace.
    if (name === "run_action" && result?.host && session?.admission && result.host.workspaceId === session.admission.host.workspaceId) {
      session.admission.host = validateStudioIdentity(result.host);
    }
    if (name === "inspect_studio" && Number.isSafeInteger(result?.context?.revision?.scene) && session?.admission) {
      session.admission.revision = result.context.revision.scene;
    }
    if (mutationNames.has(name) && session?.admission) {
      if (Number.isSafeInteger(result?.revision?.after)) session.admission.revision = result.revision.after;
      else await session.admission.refresh();
    }
    return result;
  };
	const availableTools = previsMode === "storyboard" ? STUDIO_TOOLS.filter(name => name !== "generate_motion") : STUDIO_TOOLS;
	const tools = availableTools.map(name => ({ ...schema(name), handler: args => invoke(name, args) }));
  tools.resolveImage = async (imageId, correlation = {}) => {
    if (typeof resolveImage !== "function") return { visualStatus: "unavailable", reason: "image resolver unavailable" };
    try {
      const result = await resolveImage(imageId, correlation);
      if (!result?.dataUrl?.startsWith("data:image/")) return { visualStatus: "unavailable", reason: "editor did not provide image bytes" };
      return { visualStatus: "attached", dataUrl: result.dataUrl, imageId, revision: result.revision ?? null, receiptId: result.receiptId ?? correlation.receiptId ?? null };
    } catch { return { visualStatus: "unavailable", reason: "image attachment failed", imageId }; }
  };
  tools.internal = { invoke };
  return tools;
}
export function studioToolResult(result) { return text(result); }
