import { useState } from "react";
import { ko } from "../locale.js";
import { useStudioShell } from "./studio-shell-context.js";
import TopBar, { ProjectHead } from "./TopBar.jsx";
import OutlinerSlot from "./OutlinerSlot.jsx";
import DetailsSlot from "./DetailsSlot.jsx";
import BottomDock from "./BottomDock.jsx";
import StatusBar from "./StatusBar.jsx";
import PreferencesSlot from "./PreferencesSlot.jsx";
import "./shell.css";
import "./glass.css";
import "./glass-regions.css";
import "./agent-glass.css";

const DOCK_TAB_KEY = "cozyclay.dock.tab.v1";

function readDockTab() {
	try {
		return globalThis.localStorage?.getItem(DOCK_TAB_KEY) === "assets" ? "assets" : "animation";
	} catch {
		return "animation";
	}
}

// #570 floating-glass shell: the viewport fills the window and every region
// floats over it. Left: the Outliner. Right: Details over Agent. Bottom, from
// the left edge to the right column: the dock, switching between Animation
// (the Sequencer with the shot preview at its right end) and Assets.
export default function StudioShell({ viewport, children, ...props }) {
	const { beginWorkspaceResize } = useStudioShell();
	const [dockTab, setDockTab] = useState(readDockTab);
	// Embeds (playview, playground) keep the Sequencer-only dock.
	const embedded = Boolean(props["data-embed-mode"]);
	const shownTab = embedded ? "animation" : dockTab;
	function changeDockTab(next) {
		setDockTab(next);
		try {
			globalThis.localStorage?.setItem(DOCK_TAB_KEY, next);
		} catch (error) {
			console.warn(`[cozyclay] could not store ${DOCK_TAB_KEY}`, error);
		}
	}
	return (
		<div {...props} data-shell="glass" data-dock-tab={shownTab}>
			<TopBar preferences={<PreferencesSlot />} />
			<div className="main">
				<div className="workspace">
					{viewport}
					<div className="studio-left-column">
						<ProjectHead />
						<OutlinerSlot />
					</div>
					<div
						className="workspace-splitter shell-splitter shell-left-splitter"
						role="separator"
						aria-orientation="vertical"
						aria-label={ko("Resize hierarchy panel", "계층 패널 크기 조절")}
						onPointerDown={(event) => beginWorkspaceResize("left", event)}
					/>
					<div className="studio-right-column">
						<DetailsSlot />
					</div>
					<div
						className="workspace-splitter workspace-splitter-vertical shell-splitter shell-sidebar-splitter"
						role="separator"
						aria-orientation="vertical"
						aria-label={ko("Resize hierarchy and inspector panel", "계층 및 속성 패널 크기 조절")}
						onPointerDown={(event) => beginWorkspaceResize("sidebar", event)}
					/>
				</div>
				<div className="studio-dock-slot">
					<div
						className="workspace-splitter timeline-splitter"
						role="separator"
						aria-label={ko("Resize frame monitor", "프레임 모니터 크기 조절")}
						onPointerDown={(event) => beginWorkspaceResize("timeline", event)}
					/>
					<BottomDock tab={shownTab} onTabChange={changeDockTab} embedded={embedded} />
					<div
						className="workspace-splitter shell-splitter shell-camera-splitter"
						role="separator"
						aria-orientation="vertical"
						aria-label={ko("Resize shot preview", "샷 미리보기 크기 조절")}
						onPointerDown={(event) => beginWorkspaceResize("camera", event)}
					/>
				</div>
			</div>
			<StatusBar embedded={embedded} />
			{children}
		</div>
	);
}
