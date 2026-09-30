import { createContext, useContext } from "react";

// App owns the document/domain wiring. Region components consume this one
// render snapshot and call its named actions; they never acquire domain state
// or call authored-state writers themselves. Ref cells keep their identity.
//
// In addition to the extracted controls, the public region contract includes:
// - spawnCharacter/addSceneObject/beginAssetDrag/runStudioAction, mode/IK tools;
// - saveStatus, all exporters, exportStatus.cancel/retry, setToast and
//   subscribeToasts (the Content Log can tee notifications without replacing UI);
// - generation, blocks/refine, takes/recipe and preserve strength;
// - agentOpen/toggleAgent, preferencesOpen/setPreferencesOpen;
// - statusText/setStatusText, previewRanges/setPreviewRanges, liveHubStatus,
//   flySpeed (the navigation multiplier, not metres per second).
export const StudioShellContext = createContext(null);

export function useStudioShell() {
	return useContext(StudioShellContext);
}
