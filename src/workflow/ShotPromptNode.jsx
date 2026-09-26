import { FiCopy, FiFileText, FiPlay } from "react-icons/fi";
import { toast } from "react-hot-toast";
import { shotPromptTarget } from "./shot-prompt-node.js";

/**
 * Shot Prompt node (#166): reads the connected Scene node's capture metadata
 * (and an optional Text intent) and shows the structured prompt built by
 * src/shot-prompt.js, ready to copy or to feed an Image/Video node.
 *
 * NodeShell is injected by WorkflowBuilder so this file stays free of the
 * canvas' ReactFlow wiring.
 */
export default function ShotPromptNode({ id, data = {}, NodeShell }) {
	const target = shotPromptTarget(data.target);
	const referenceOwnsCamera = data.referenceOwnsCamera !== false;
	const prompt = typeof data.prompt === "string" ? data.prompt : "";
	const copy = async () => {
		if (!prompt) { toast.error("Run the node to build a prompt first"); return; }
		try { await navigator.clipboard.writeText(prompt); toast.success("Prompt copied"); }
		catch (error) { toast.error(`Could not copy the prompt (${error.message})`); }
	};
	return <NodeShell id={id} type="shot-prompt" title="Shot Prompt" icon={FiFileText}>
		<label htmlFor={`${id}-target`}>Target</label>
		<select id={`${id}-target`} aria-label="Prompt target" value={target} onChange={(event) => data.onChange?.(id, { target: event.target.value })}>
			<option value="image">Image</option>
			<option value="video">Video</option>
		</select>
		<label className="workflow-schema-check"><input type="checkbox" aria-label="Reference owns camera" checked={referenceOwnsCamera} onChange={(event) => data.onChange?.(id, { referenceOwnsCamera: event.target.checked })} />Reference owns camera</label>
		<label htmlFor={`${id}-prompt`}>Prompt</label>
		<textarea id={`${id}-prompt`} className="workflow-textarea workflow-shot-prompt-text" aria-label="Shot prompt" readOnly value={prompt} placeholder="Connect a Scene node and run to build the prompt" />
		{data.errorMsg && <div className="workflow-error">{data.errorMsg}</div>}
		<button type="button" className="workflow-shot-prompt-copy" onClick={copy}><FiCopy size={11} /> Copy</button>
		<div className="workflow-node-foot"><span>{target === "video" ? "Video prompt" : "Image prompt"}</span><button className="workflow-mini-button" type="button" onClick={() => data.onRun?.(id)}><FiPlay size={12} /></button></div>
	</NodeShell>;
}
