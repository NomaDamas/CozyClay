import { useEffect, useMemo, useRef, useState } from "react";
import { createAgentTransport } from "./workflow/agent-client.js";
import { requestAgentImage, stylizeErrorMessage } from "./agent-image-client.js";
import { blueprintErrorMessage, blueprintRequest } from "./sculpt-blueprint.js";
import { agentSessionReady, createCommandTap, sculptModelChoice, sculptTargetFromSelection, storeSculptModel } from "./sculpt-mode.js";
import { SCULPT_KIND } from "./scene-objects.js";
import { sculptPartTree } from "./sculpt-pick.js";

export function useSculptMode({ workflowMode, sceneObjects, selectedSceneObjectId }) {
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
				(status) => { if (live) setSculptAgentStatus(agentSessionReady(status) ? "ready" : "signed-out"); },
				() => { if (live) setSculptAgentStatus("signed-out"); },
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
	// it before Esc reaches the scene selection.
	const [sculptPart, setSculptPart] = useState(null);
	useEffect(() => { setSculptPart(null); }, [sculptMode, sculptTargetId]);
	useEffect(() => {
		if (!sculptMode || !sculptPart) return undefined;
		const onKey = (event) => {
			if (event.key !== "Escape" || event.target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
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
	const sculptParts = { tree: sculptTree, selected: selectedPart, onSelect: setSculptPart };
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
			setSculptBlueprint((current) => ({ ...current, state: "ready", sheet: { dataUrl: result.dataUrl, width: result.width, height: result.height, ms: Date.now() - startedAt } }));
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
	return { sculptMode, sculptCamRef, sculptView, sculptReference, setSculptReference, sculptRun, setSculptRun, sculptRunRef, sculptAgentStatus, sculptModels, sculptModelPick, chooseSculptModel, sculptTransport, sculptTap, sculptTarget, setSculptTargetId, requestSculptView, sculptBlueprint, setSculptBlueprint, generateSculptBlueprint, cancelSculptBlueprint, sculptParts };
}
