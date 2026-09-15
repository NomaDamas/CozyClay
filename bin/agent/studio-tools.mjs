import { validateStudioCommand, STUDIO_TOOL_SCHEMAS, STUDIO_TOOL_FAMILIES, StudioProtocolError } from "../../src/studio-agent-protocol.js";

const schema = name => ({ type: "function", name, description: `Studio ${name.replaceAll("_", " ")} command.`, parameters: STUDIO_TOOL_SCHEMAS[name] });
export const studioToolSchemas = () => STUDIO_TOOL_FAMILIES.map(schema);
const text = value => typeof value === "string" ? value : JSON.stringify(value);

export function createStudioTools({ liveHub, workspaceHandle, session, resolveImage } = {}) {
  if (!liveHub?.command || !workspaceHandle) throw new StudioProtocolError("LIVE_HUB_UNAVAILABLE", "An exact Studio workspace is required.");
  const mutationNames = new Set(["operate_studio", "arrange_objects", "arrange_characters", "frame_shot", "verify_result", "undo_edit"]);
  const invoke = async (name, args) => {
    const command = validateStudioCommand({ name, args });
    const payload = mutationNames.has(name) && session?.admission
      ? { name, args: command.args, commandId: session.admission.commandId(), host: session.admission.host, expectedRevision: session.admission.revision, expectedTargets: session.admission.targets }
      : command.args;
    const result = await liveHub.command(name, payload, workspaceHandle);
    if (result?.ok === false) throw Object.assign(new Error(result.error?.message || "Studio command failed"), { code: result.error?.code });
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
export const studioToolSchemasFor = studioToolSchemas;
export function studioToolResult(result) { return text(result); }
