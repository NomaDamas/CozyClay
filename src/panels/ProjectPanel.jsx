import { ko } from "../locale.js";
import ResourceStatus from "../resource-status.jsx";
import { useBus } from "../app-context.js";
import "./details.css";

export default function ProjectPanel({
	projectMenuOpen, setProjectMenuOpen, projectDirty, projectName, projectStartupOpen, projectManifest,
}) {
	const { run } = useBus();
	return (
<div className="project-menu-wrap v2-project-menu">
					<button
						type="button"
						className="project-menu-trigger"
						aria-expanded={projectMenuOpen}
						onClick={() => setProjectMenuOpen((open) => !open)}
					>
						{projectDirty && <i className="project-dirty-dot" aria-label={ko("Unsaved changes", "저장되지 않은 변경사항")} />}
						{projectName ?? (projectStartupOpen ? ko("Choose Project", "프로젝트 선택") : ko("Untitled Project", "제목 없는 프로젝트"))}
						<span className="caret">▾</span>
					</button>
					{projectMenuOpen && (
						<div className="project-menu" role="menu" onClick={() => setProjectMenuOpen(false)}>
							<button type="button" role="menuitem" onClick={() => run("project.new")}>{ko("New Project", "새 프로젝트")}</button>
							<button type="button" role="menuitem" onClick={() => run("project.browse")}>{ko("Open Project…", "프로젝트 열기…")}</button>
							<button type="button" role="menuitem" onClick={() => run("project.save")}>{ko("Save Project", "프로젝트 저장")}</button>
							<button type="button" role="menuitem" onClick={() => run("project.saveAs")}>{ko("Save Project As…", "다른 이름으로 저장…")}</button>
							<ResourceStatus manifest={projectManifest} compact />
						</div>
					)}
				</div>
	);
}
