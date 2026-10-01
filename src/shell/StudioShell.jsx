import { ko } from "../locale.js";
import { useStudioShell } from "./studio-shell-context.js";
import TopBar from "./TopBar.jsx";
import OutlinerSlot from "./OutlinerSlot.jsx";
import LibrarySlot from "./LibrarySlot.jsx";
import DetailsSlot from "./DetailsSlot.jsx";
import BottomDock from "./BottomDock.jsx";
import StatusBar from "./StatusBar.jsx";
import PreferencesSlot from "./PreferencesSlot.jsx";
import "./shell.css";
import "./glass.css";

// #570 floating-glass shell: the viewport fills the window and every region
// floats over it. Left: Outliner over Library. Right: Details over Agent.
// Bottom: the Sequencer, with the shot preview docked at its right end.
export default function StudioShell({ viewport, children, ...props }) {
	const { beginWorkspaceResize } = useStudioShell();
	return (
		<div {...props} data-shell="glass">
			<TopBar preferences={<PreferencesSlot />} />
			<div className="main">
				<div className="workspace">
					{viewport}
					<div className="studio-left-column">
						<OutlinerSlot />
						<div
							className="workspace-splitter shell-splitter shell-outliner-splitter"
							role="separator"
							aria-orientation="horizontal"
							aria-label={ko("Resize hierarchy panel", "계층 패널 크기 조절")}
							onPointerDown={(event) => beginWorkspaceResize("hierarchy", event)}
						/>
						<LibrarySlot />
					</div>
					<div
						className="workspace-splitter shell-splitter shell-left-splitter"
						role="separator"
						aria-orientation="vertical"
						aria-label={ko("Resize hierarchy and library panel", "계층 및 라이브러리 패널 크기 조절")}
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
					<BottomDock />
					<div
						className="workspace-splitter shell-splitter shell-camera-splitter"
						role="separator"
						aria-orientation="vertical"
						aria-label={ko("Resize shot preview", "샷 미리보기 크기 조절")}
						onPointerDown={(event) => beginWorkspaceResize("camera", event)}
					/>
				</div>
			</div>
			<StatusBar />
			{children}
		</div>
	);
}
