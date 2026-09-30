import { ko } from "../locale.js";
import { useStudioShell } from "./studio-shell-context.js";
import TopBar from "./TopBar.jsx";
import OutlinerSlot from "./OutlinerSlot.jsx";
import DetailsSlot from "./DetailsSlot.jsx";
import BottomDock from "./BottomDock.jsx";
import StatusBar from "./StatusBar.jsx";
import PreferencesSlot from "./PreferencesSlot.jsx";
import "./shell.css";

export default function StudioShell({ viewport, children, ...props }) {
	const { beginWorkspaceResize } = useStudioShell();
	return (
		<div {...props}>
			<TopBar preferences={<PreferencesSlot />} />
			<div className="main">
				<div className="workspace">
					{viewport}
					<div className="studio-right-column">
						<OutlinerSlot />
						<div
							className="workspace-splitter workspace-splitter-vertical shell-outliner-splitter"
							role="separator"
							aria-label={ko("Resize hierarchy panel", "계층 패널 크기 조절")}
							onPointerDown={(event) => beginWorkspaceResize("hierarchy", event)}
						/>
						<DetailsSlot />
					</div>
					<div
						className="workspace-splitter workspace-splitter-vertical shell-sidebar-splitter"
						role="separator"
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
				</div>
			</div>
			<StatusBar />
			{children}
		</div>
	);
}
