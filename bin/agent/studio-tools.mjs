import { validateStudioCommand, STUDIO_TOOL_SCHEMAS, STUDIO_TOOL_FAMILIES, StudioProtocolError } from "../../src/studio-agent-protocol.js";

const STUDIO_TOOL_RECEIPT_NOTE = " The result may be a receipt with status \"partial\": ops[].droppedPaths names exactly which authored path each op refused, and delta[].after carries the value actually landed for that target -- quote both the requested and the landed value when you report this, never say only that some paths were not applied. A STALE_SCENE error means inspect_studio once for the fresh revision, then resubmit the identical operation with that revision; it is not a permanent failure.";
const STUDIO_MUTATION_TOOLS = new Set(["operate_studio", "arrange_objects", "arrange_characters", "patch_elements", "frame_shot", "verify_result", "undo_edit"]);
const schema = name => ({ type: "function", name, description: `Studio ${name.replaceAll("_", " ")} command.${name === "generate_motion" ? " Timing: give EITHER source.durationSeconds (total) with NO per-beat seconds, OR seconds on EVERY beat with NO durationSeconds. The result installs immediately as an undoable take; an unverified result still installs, with warnings[] naming each failed check, which you must report. undo_edit with its receiptId reverts it. One generation per user message: a second call fails with GENERATION_LIMIT." : ""}${name === "verify_result" ? " Pass exactly one of receiptId or targets (not both)." : ""}${STUDIO_MUTATION_TOOLS.has(name) ? STUDIO_TOOL_RECEIPT_NOTE : ""}`, parameters: STUDIO_TOOL_SCHEMAS[name] });
export const studioToolSchemas = () => STUDIO_TOOL_FAMILIES.map(schema);
const text = value => typeof value === "string" ? value : JSON.stringify(value);

export function createStudioTools({ liveHub, workspaceHandle, session, resolveImage } = {}) {
  if (!liveHub?.command || !workspaceHandle) throw new StudioProtocolError("LIVE_HUB_UNAVAILABLE", "An exact Studio workspace is required.");
  const mutationNames = STUDIO_MUTATION_TOOLS;
  const invoke = async (name, args) => {
    const command = validateStudioCommand({ name, args });
    const payload = mutationNames.has(name) && session?.admission
      ? { name, args: command.args, commandId: session.admission.commandId(), host: session.admission.host, expectedRevision: session.admission.revision }
      : command.args;
    let result;
    try {
      result = await liveHub.command(name, payload, workspaceHandle);
    } catch (error) {
      if (mutationNames.has(name) && error?.code === "UNCERTAIN_APPLY") await session.admission.refresh();
      throw error;
    }
    if (result?.ok === false) {
      // Rejection receipts carry code/message at the top level, not under `error`;
      // the receipt itself holds phase, recovery and target evidence the model needs.
      const code = result.code ?? result.error?.code;
      const message = result.message ?? result.error?.message ?? "Studio command failed";
      if (mutationNames.has(name) && code === "STALE_SCENE") await session.admission.refresh();
      throw Object.assign(new Error(message), { code, receipt: result });
    }
    if (name === "inspect_studio" && Number.isSafeInteger(result?.context?.revision?.scene) && session?.admission) {
      session.admission.revision = result.context.revision.scene;
    }
    if (mutationNames.has(name)) {
      if (Number.isSafeInteger(result?.revision?.after)) session.admission.revision = result.revision.after;
      else await session.admission.refresh();
    }
    return result;
  };
  const tools = STUDIO_TOOL_FAMILIES.map(name => ({ ...schema(name), handler: args => invoke(name, args) }));
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
