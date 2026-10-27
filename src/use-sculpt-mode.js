import { useEffect, useMemo, useRef, useState } from "react";
import { createAgentTransport } from "./workflow/agent-client.js";
import { requestAgentImage, stylizeErrorMessage } from "./agent-image-client.js";
import { blueprintErrorMessage, blueprintRequest, blueprintViewImages } from "./sculpt-blueprint.js";
import { browserSculptImages } from "./commands/sculpt-images.js";
import { agentSessionReady, chatgptSignedIn, createCommandTap, sculptModelChoice, sculptTargetFromSelection, storeSculptModel } from "./sculpt-mode.js";
import { SCULPT_KIND } from "./scene-objects.js";
import { overlayOwnsEscape, sculptPartTree } from "./sculpt-pick.js";
import { GIZMO_HOTKEYS } from "./stage-startup-defaults.js";
import { ko } from "./locale.js";

export function useSculptMode({ workflowMode, sceneObjects, selectedSceneObjectId, appContext }) {
	// Sculpt mode (#739): one sculpt on an isolated turntable, the Sculpt panel
	// and its agent run. The target is the sculpt selected on entry, or a new one
	// the first run creates; picking another sculpt while here retargets.
	const sculptMode = workflowMode === "sculpt";
	const sculptCamRef = useRef(null);
	const [sculptTargetId, setSculptTargetId] = useState(null);
	const [sculptView, setSculptView] = useState({ view: "front", nonce: 0 });
	const [sculptReference, setSculptReference] = useState(null);
	const [sculptRun, setSculptRun] = useState(null);
	const sculptRunRef = useRef(null);
	const [sculptAgentStatus, setSculptAgentStatus] = useState("unknown");
	// Whether the sidecar holds a ChatGPT token: the blueprint's image model needs one (#970).
	const [sculptChatgpt, setSculptChatgpt] = useState(false);
	// The model Sculpt runs on (its own pick, remembered apart from the chat model) and the list it comes from.
	const [sculptModels, setSculptModels] = useState({ state: "loading", providers: [], models: [] });
	const [sculptModelPick, setSculptModelPick] = useState({ model: "", effort: null });
	const chooseSculptModel = (next) => setSculptModelPick((current) => {
		const choice = { ...current, ...next };
		storeSculptModel(choice);
		return choice;
	});
	const [sculptTransport] = useState(() => createAgentTransport({ surface: "studio" }));
	const [sculptTap] = useState(createCommandTap);
	const sculptTarget = sceneObjects.find((object) => object.id === sculptTargetId && object.renderer === SCULPT_KIND) ?? null;
	const requestSculptView = (view) => setSculptView((current) => ({ view, nonce: current.nonce + 1 }));
	useEffect(() => {
		if (!sculptMode) return;
		setSculptTargetId(sculptTargetFromSelection(sceneObjects, selectedSceneObjectId));
		requestSculptView("front");
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [sculptMode]);
	useEffect(() => {
		const selected = sculptMode ? sculptTargetFromSelection(sceneObjects, selectedSceneObjectId) : null;
		if (selected) setSculptTargetId(selected);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selectedSceneObjectId]);
	// Start needs the Agent panel's readiness rule (signed in, or a provider
	// key in the sidecar); a sign-in finished in another window lands on focus.
	useEffect(() => {
		if (!sculptMode) return undefined;
		let live = true;
		const read = () => {
			sculptTransport.status().then(
				(status) => { if (live) { setSculptAgentStatus(agentSessionReady(status) ? "ready" : "signed-out"); setSculptChatgpt(chatgptSignedIn(status)); } },
				() => { if (live) { setSculptAgentStatus("signed-out"); setSculptChatgpt(false); } },
			);
			// The Agent panel's catalogue: a key added or removed elsewhere changes what can run.
			sculptTransport.models().then(
				(advertised) => {
					if (!live) return;
					const list = Array.isArray(advertised?.models) ? advertised.models : [];
					setSculptModels({ state: list.length ? "ready" : "failed", providers: advertised?.providers ?? [], models: list });
					setSculptModelPick((current) => sculptModelChoice(advertised, current));
				},
				() => { if (live) setSculptModels((current) => ({ ...current, state: current.models.length ? current.state : "failed" })); },
			);
		};
		read();
		window.addEventListener("focus", read);
		return () => { live = false; window.removeEventListener("focus", read); };
	}, [sculptMode, sculptTransport]);
	// Part picking (#740 S7): one part of the target, chosen on the turntable or
	// in the panel's tree. A new target or leaving the mode drops it; Esc drops
	// it before Esc reaches the scene selection, unless an open menu or dialog takes that Esc.
	const [sculptPart, setSculptPart] = useState(null);
	useEffect(() => { setSculptPart(null); }, [sculptMode, sculptTargetId]);
	// The part gizmo (#740 S8): its tool, and the last refusal or notice it shows under the tree.
	const [partTool, setPartTool] = useState("move");
	const [partNotice, setPartNotice] = useState(null);
	useEffect(() => { setPartNotice(null); }, [sculptPart?.partId, sculptPart?.mirrored, sculptTargetId]);
	useEffect(() => {
		if (!sculptMode || !sculptPart) return undefined;
		const onKey = (event) => {
			if (event.target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
			// Delete with a part picked would take the whole sculpt: refused, Esc first.
			if (event.key === "Delete" || event.key === "Backspace") {
				event.stopPropagation();
				event.preventDefault();
				setPartNotice(ko("Delete removes the whole sculpt. Press Esc to deselect the part first.", "Delete는 조형물 전체를 지워요. 먼저 Esc로 부품 선택을 해제하세요.", "Delete 会删除整个雕塑。请先按 Esc 取消部件选择。"));
				return;
			}
			if (event.key !== "Escape" || overlayOwnsEscape()) return;
			event.stopPropagation();
			setSculptPart(null);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [sculptMode, sculptPart]);
	const sculptRecipe = sculptTarget?.recipe;
	const sculptTree = useMemo(() => sculptPartTree(sculptRecipe), [sculptRecipe]);
	// A recipe edit that removed the part leaves nothing selected.
	const selectedPart = sculptPart && sculptTree.some((row) => row.id === sculptPart.partId) ? sculptPart : null;
	// W/E/R: the selected part's move, rotate and scale; with no part, the turntable views.
	const onKey = (code) => (selectedPart ? setPartTool(GIZMO_HOTKEYS[code]) : requestSculptView({ KeyW: "front", KeyE: "side", KeyR: "back" }[code]));
	const tools = [["W", "move", ko("Move part", "부품 이동", "移动部件")], ["E", "rotate", ko("Rotate part", "부품 회전", "旋转部件")], ["R", "scale", ko("Scale part (Shift: uniform)", "부품 크기 (Shift: 균등)", "缩放部件（Shift：等比）")]]
		.map(([key, id, name]) => ({ key, id, name, active: partTool === id, pick: () => setPartTool(id) }));
	// One drag, one write: the command refuses what cannot be drawn and its reason is shown.
	const commit = (edit) => {
		if (!edit || !sculptTarget || !appContext) return false;
		let receipt;
		try { receipt = appContext.bus.run("object.sculpt", { id: sculptTarget.id, edits: [edit] }, { origin: "ui" }); } catch (error) { receipt = { ok: false, message: error?.message }; }
		setPartNotice(receipt?.ok === false ? `${ko("Edit refused", "편집 거부", "编辑被拒绝")}: ${receipt.message ?? ""}` : null);
		return receipt?.ok !== false;
	};
	const sculptParts = { tree: sculptTree, selected: selectedPart, onSelect: setSculptPart, tool: partTool, tools, onKey, commit, notice: partNotice };
	// The blueprint step: the reference turned into a four-view model sheet by one image request.
	const [sculptBlueprint, setSculptBlueprint] = useState({ state: "idle", pose: "keep", notes: "", sheet: null, error: null, startedAt: null });
	const blueprintAbortRef = useRef(null);
	async function generateSculptBlueprint() {
		if (!sculptReference) return;
		blueprintAbortRef.current?.abort();
		const controller = new AbortController();
		blueprintAbortRef.current = controller;
		const startedAt = Date.now();
		setSculptBlueprint((current) => ({ ...current, state: "generating", error: null, startedAt }));
		try {
			const result = await requestAgentImage(blueprintRequest({ reference: sculptReference, pose: sculptBlueprint.pose, notes: sculptBlueprint.notes }), { signal: controller.signal });
			if (blueprintAbortRef.current !== controller) return;
			// Cut into views (#970): side and back go to Start next to the reference; a view whose mask fails is dropped with a notice.
			let cropped;
			try { cropped = await blueprintViewImages(result.dataUrl, browserSculptImages); } catch (error) { cropped = { views: [], notices: [`The sheet could not be cut into views: ${error?.message || error}`] }; }
			if (blueprintAbortRef.current !== controller) return;
			setSculptBlueprint((current) => ({ ...current, state: "ready", sheet: { dataUrl: result.dataUrl, width: result.width, height: result.height, ms: Date.now() - startedAt, views: cropped.views, notices: cropped.notices } }));
		} catch (error) {
			if (blueprintAbortRef.current !== controller) return;
			const cancelled = controller.signal.aborted;
			setSculptBlueprint((current) => ({ ...current, state: current.sheet ? "ready" : "idle", error: cancelled ? null : blueprintErrorMessage(error, stylizeErrorMessage(error).replace(/^Stylize failed — |^스타일화 실패 — /, "")) }));
		}
	}
	function cancelSculptBlueprint() {
		const controller = blueprintAbortRef.current;
		blueprintAbortRef.current = null;
		controller?.abort();
		setSculptBlueprint((current) => ({ ...current, state: current.sheet ? "ready" : "idle" }));
	}
	return { sculptMode, sculptCamRef, sculptView, sculptReference, setSculptReference, sculptRun, setSculptRun, sculptRunRef, sculptAgentStatus, sculptChatgpt, sculptModels, sculptModelPick, chooseSculptModel, sculptTransport, sculptTap, sculptTarget, setSculptTargetId, requestSculptView, sculptBlueprint, setSculptBlueprint, generateSculptBlueprint, cancelSculptBlueprint, sculptParts };
}
