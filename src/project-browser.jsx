import { useEffect, useMemo, useRef, useState } from "react";
import packageInfo from "../package.json";
import { ko } from "./locale.js";
import {
	hasDirectoryPicker,
	hasFileSystemAccess,
	listProjectsInDirectory,
	loadProjectsDirectory,
	loadRecentProjects,
	pickProjectsDirectory,
	queryHandlePermission,
	removeRecentProject,
	requestHandlePermission,
	storeProjectsDirectory,
} from "./project.js";
import "./project-browser.css";

const APP_VERSION = packageInfo.version;
const CATEGORIES = ["All", "Film", "Dialogue", "Action", "Vehicle"];
const BLANK_TEMPLATE = Object.freeze({
	id: "blank-stage",
	name: "Blank Stage",
	category: "All",
	description: "An empty stage for blocking a new shot.",
	kind: "blank",
	code: "NEW",
});

// App.jsx keeps the project mutation behind its named requestNewProject/newProject
// path. The v2 chooser already has the name, so this short-lived handoff seeds
// the existing ProjectNameDialog and lets its normal submit path commit it.
let pendingProjectName = null;

function formatDate(value) {
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return ko("Recently", "최근");
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function sampleTemplate(scene) {
	return {
		id: `sample-${scene.id}`,
		starterId: scene.id,
		name: scene.name,
		category: "Action",
		description: scene.blurb,
		kind: "sample",
		code: "SAMPLE",
	};
}

export function ProjectNameDialog({ open, initialName = "My Project", onCancel, onSubmit }) {
	const [value, setValue] = useState(initialName);
	useEffect(() => {
		if (!open) return;
		if (pendingProjectName !== null) {
			const name = pendingProjectName;
			pendingProjectName = null;
			setValue(name);
			onSubmit(name);
			return;
		}
		setValue(initialName);
	}, [open, initialName]);
	if (!open) return null;
	const submit = (event) => {
		event.preventDefault();
		const name = value.trim() || "My Project";
		onSubmit(name);
	};
	return (
		<div className="v2-project-name-dialog-backdrop project-name-dialog-backdrop" role="presentation">
			<form className="v2-project-name-dialog project-name-dialog" role="dialog" aria-modal="true" aria-labelledby="project-name-dialog-title" onSubmit={submit}>
				<strong id="project-name-dialog-title">{ko("Project name", "프로젝트 이름")}</strong>
				<label>
					<span>{ko("Name", "이름")}</span>
					<input autoFocus value={value} onChange={(event) => setValue(event.target.value)} aria-label={ko("Project name", "프로젝트 이름")} />
				</label>
				<div className="v2-project-name-dialog-actions project-name-dialog-actions">
					<button type="button" className="v2-dialog-secondary btn ghost" onClick={onCancel}>{ko("Cancel", "취소")}</button>
					<button type="submit" className="v2-dialog-primary btn primary">{ko("Create", "생성")}</button>
				</div>
			</form>
		</div>
	);
}

/**
 * v2 start / project screen. Recent projects still come from the browser-local
 * project store, while today's starter scenes become the template cards.
 */
export default function ProjectBrowser({ currentName, onOpen, onOpenFile, onNew, onClose, startup = false, starters = [], onStarter }) {
	const starterTemplates = useMemo(() => starters.map(sampleTemplate), [starters]);
	const templates = useMemo(
		() => [BLANK_TEMPLATE, ...starterTemplates],
		[starterTemplates],
	);
	const defaultTemplate = starterTemplates[0] ?? BLANK_TEMPLATE;
	const [activeNav, setActiveNav] = useState(startup ? "new" : "recent");
	const [category, setCategory] = useState("All");
	const [selectedTemplateId, setSelectedTemplateId] = useState(defaultTemplate.id);
	const [name, setName] = useState(currentName || defaultTemplate.name || "My Project");
	const [frameRate, setFrameRate] = useState("24");
	const [units, setUnits] = useState("Meters");
	const [recents, setRecents] = useState([]);
	const [folder, setFolder] = useState(null);
	const [folderProjects, setFolderProjects] = useState([]);
	const [folderDenied, setFolderDenied] = useState(false);
	const [lostFolder, setLostFolder] = useState(null);
	const nameInputRef = useRef(null);

	useEffect(() => {
		let active = true;
		loadRecentProjects().then((entries) => {
			if (active) setRecents(Array.isArray(entries) ? entries : []);
		});
		loadProjectsDirectory().then(async (handle) => {
			if (!active || !handle) return;
			const permission = await queryHandlePermission(handle);
			if (!active) return;
			if (permission !== "granted") {
				setFolderDenied(true);
				if (permission === "prompt") setLostFolder(handle);
				return;
			}
			setFolder(handle);
			setFolderProjects(await listProjectsInDirectory(handle));
		}).catch(() => {
			if (active) setFolderDenied(true);
		});
		return () => {
			active = false;
		};
	}, []);

	useEffect(() => {
		if (startup) nameInputRef.current?.focus();
	}, [startup]);

	// File › New reaches this screen with unsaved work, so Create can be refused
	// by the discard confirmation. A name left behind then must not seed a later
	// Save's name dialog once the screen closes.
	useEffect(() => () => {
		pendingProjectName = null;
	}, []);

	const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? templates[0];
	const visibleTemplates = category === "All"
		? templates
		: templates.filter((template) => template.category === "All" || template.category === category);
	const canCreate = name.trim().length > 0;
	const createReason = ko("Enter a project name to create a project", "프로젝트를 만들려면 이름을 입력하세요");
	const locationLabel = folder?.name || ko("Browser project store", "브라우저 프로젝트 저장소");
	const canChooseFolder = hasFileSystemAccess() && hasDirectoryPicker();

	const reauthorizeFolder = async () => {
		if (!lostFolder) return;
		if ((await requestHandlePermission(lostFolder)) !== "granted") return;
		const handle = lostFolder;
		setLostFolder(null);
		setFolderDenied(false);
		setFolder(handle);
		setFolderProjects(await listProjectsInDirectory(handle));
	};

	const chooseFolder = async () => {
		if (!canChooseFolder) return;
		try {
			const handle = await pickProjectsDirectory();
			await storeProjectsDirectory(handle);
			setFolder(handle);
			setFolderDenied(false);
			setLostFolder(null);
			setFolderProjects(await listProjectsInDirectory(handle));
		} catch (error) {
			if (error?.name !== "AbortError") setFolderDenied(true);
		}
	};

	const refreshFolder = async () => {
		if (folder) setFolderProjects(await listProjectsInDirectory(folder));
	};

	const selectTemplate = (template) => {
		setSelectedTemplateId(template.id);
		setName((current) => current.trim() ? current : template.name);
	};

	const createProject = (event) => {
		event.preventDefault();
		const projectName = name.trim();
		if (!projectName) return;
		pendingProjectName = projectName;
		onNew(projectName);
	};

	const recentEntries = [
		...recents.map((entry) => ({ ...entry, key: `recent-${entry.name}`, removable: true, date: entry.openedAt })),
		...folderProjects.map((entry) => ({ ...entry, key: `folder-${entry.name}`, removable: false, date: entry.lastModified })),
	];

	const navItems = [
		{ id: "recent", label: ko("Recent", "최근") },
		{ id: "new", label: ko("New Project", "새 프로젝트") },
		{ id: "samples", label: ko("Samples", "샘플") },
		{ id: "learn", label: ko("Learn", "배우기") },
	];

	return (
		<div className={`v2-start-screen project-browser-backdrop${startup ? " startup" : ""}`} onPointerDown={(event) => { if (!startup && event.target === event.currentTarget) onClose?.(); }}>
			<div className={`v2-start-window project-browser${startup ? " startup" : ""}`} role="dialog" aria-modal="true" aria-label={ko("Choose project", "프로젝트 선택")}>
				<nav className="v2-start-nav" aria-label={ko("Project navigation", "프로젝트 탐색")}>
					<div className="v2-start-brand">
						<span className="v2-start-brand-mark" aria-hidden="true" />
						<strong>CozyClay</strong>
					</div>
					<div className="v2-start-nav-list">
						{navItems.map((item) => (
							<button
								type="button"
								key={item.id}
								className={`v2-start-nav-item${activeNav === item.id ? " active" : ""}`}
								aria-current={activeNav === item.id ? "page" : undefined}
								onClick={() => setActiveNav(item.id)}
							>
								{item.label}
							</button>
						))}
					</div>
					<div className="v2-start-version">v{APP_VERSION}</div>
				</nav>

				<main className="v2-start-main">
					<div className="v2-start-main-head">
						<div className="v2-start-title-row">
							<h1>{activeNav === "recent" ? ko("Recent", "최근") : activeNav === "samples" ? ko("Samples", "샘플") : activeNav === "learn" ? ko("Learn", "배우기") : ko("New Project", "새 프로젝트")}</h1>
							{activeNav !== "new" && <button type="button" className="v2-start-close x" onClick={onClose} aria-label={ko("Close", "닫기")}>×</button>}
						</div>
						{(activeNav === "new" || activeNav === "samples") && (
							<div className="v2-start-tabs" role="tablist" aria-label={ko("Template categories", "템플릿 카테고리")}>
								{CATEGORIES.map((entry) => (
									<button
										type="button"
										key={entry}
										role="tab"
										aria-selected={category === entry}
										className={`v2-start-tab${category === entry ? " active" : ""}`}
										onClick={() => setCategory(entry)}
									>
										{ko(entry, entry === "All" ? "전체" : entry === "Film" ? "영화" : entry === "Dialogue" ? "대화" : entry === "Action" ? "액션" : "차량")}
									</button>
								))}
							</div>
						)}
					</div>

					{activeNav === "learn" ? (
						<div className="v2-start-learn">
							<strong>{ko("Block a shot in three moves", "세 단계로 샷을 블로킹하세요")}</strong>
							<p>{ko("Choose a template, name the project, then place a character and frame the camera in the editor.", "템플릿을 고르고 프로젝트 이름을 정한 다음 편집기에서 인물을 배치하고 카메라를 잡아 보세요.")}</p>
							<button type="button" className="v2-start-learn-action" onClick={() => setActiveNav("new")}>{ko("Start a new project", "새 프로젝트 시작")}</button>
						</div>
					) : activeNav === "recent" ? (
						<div className="v2-start-recent-page">
							<div className="v2-start-recent-heading">
								<span>{ko("Recent projects", "최근 프로젝트")}</span>
								<div className="v2-start-recent-actions">
									{folder && <button type="button" onClick={refreshFolder}>{ko("Refresh", "새로고침")}</button>}
									<button type="button" onClick={onOpenFile}>{ko("Open project file…", "프로젝트 파일 열기…")}</button>
								</div>
							</div>
							<RecentList entries={recentEntries} currentName={currentName} onOpen={onOpen} onRemove={async (entry) => {
								await removeRecentProject(entry.name);
								setRecents(await loadRecentProjects());
							}} />
						</div>
					) : (
						<>
							<div className="v2-start-template-grid" role="list" aria-label={ko("Project templates", "프로젝트 템플릿")}>
								{visibleTemplates.map((template) => (
									<button
										type="button"
										role="listitem"
										key={template.id}
										className={`v2-start-template${selectedTemplate?.id === template.id ? " selected" : ""}`}
										data-template-id={template.id}
										onClick={() => selectTemplate(template)}
										onDoubleClick={() => template.starterId && onStarter?.(template.starterId)}
									>
										<span className={`v2-start-template-art ${template.kind}`} aria-hidden="true">
											<span className="v2-start-template-code">{template.code}</span>
										</span>
										<span className="v2-start-template-copy">
											<strong>{template.name}</strong>
											<span>{template.description}</span>
										</span>
									</button>
								))}
							</div>

							<div className="v2-start-recent-block">
								<div className="v2-start-recent-heading"><span>{ko("Recent", "최근")}</span></div>
								<RecentList entries={recents.map((entry) => ({ ...entry, key: `recent-${entry.name}`, removable: true, date: entry.openedAt }))} currentName={currentName} onOpen={onOpen} onRemove={async (entry) => {
									await removeRecentProject(entry.name);
									setRecents(await loadRecentProjects());
								}} compact />
							</div>
						</>
					)}
					{activeNav !== "recent" && activeNav !== "learn" && (
						<div className="v2-start-file-actions">
							<button type="button" className="v2-start-file-button" onClick={onOpenFile}>{ko("Open project file…", "프로젝트 파일 열기…")}</button>
						</div>
					)}
				</main>

				<aside className="v2-start-preview" data-testid="start-project-preview" aria-label={ko("Project preview", "프로젝트 미리보기")}>
					<div className={`v2-start-preview-art ${selectedTemplate?.kind || "blank"}`} aria-hidden="true">
						<span>{ko("template preview", "템플릿 미리보기")}</span>
					</div>
					<div className="v2-start-preview-copy">
						<strong>{selectedTemplate?.name}</strong>
						<span>{selectedTemplate?.description}</span>
					</div>
					<form className="v2-start-project-form" onSubmit={createProject}>
						<label className="v2-start-field">
							<span>{ko("Name", "이름")}</span>
							<input ref={nameInputRef} data-testid="start-project-name" aria-label={ko("Name", "이름")} value={name} onChange={(event) => setName(event.target.value)} />
						</label>
						<label className="v2-start-field">
							<span>{ko("Location", "위치")}</span>
							<button type="button" className="v2-start-location" onClick={chooseFolder} disabled={!canChooseFolder} title={canChooseFolder ? ko("Choose the project storage folder", "프로젝트 저장 폴더 선택") : ko("Projects are stored in this browser", "프로젝트는 이 브라우저에 저장됩니다")}>
								<span>{locationLabel}</span><span aria-hidden="true">⌄</span>
							</button>
						</label>
						<label className="v2-start-field">
							<span>{ko("Frame rate", "프레임 레이트")}</span>
							<span className="v2-start-select-wrap">
								<select aria-label={ko("Frame rate", "프레임 레이트")} value={frameRate} onChange={(event) => setFrameRate(event.target.value)}>
									<option value="24">24 fps</option>
									<option value="30">30 fps</option>
								</select>
							</span>
						</label>
						<label className="v2-start-field">
							<span>{ko("Units", "단위")}</span>
							<span className="v2-start-select-wrap">
								<select aria-label={ko("Units", "단위")} value={units} onChange={(event) => setUnits(event.target.value)}>
									<option value="Meters">Meters</option>
									<option value="Feet">Feet</option>
								</select>
							</span>
						</label>
						{folderDenied && (
							<p className="v2-start-location-status" role="status">
								{lostFolder ? ko("Folder access needs to be re-allowed.", "폴더 접근을 다시 허용해야 해요.") : ko("Using the browser project store.", "브라우저 프로젝트 저장소를 사용합니다.")}
								{lostFolder && <button type="button" onClick={reauthorizeFolder}>{ko("Re-allow", "다시 허용")}</button>}
							</p>
						)}
						<div className="v2-start-preview-actions">
							<button type="button" className="v2-start-cancel" onClick={onClose}>{ko("Cancel", "취소")}</button>
							<button type="submit" className="v2-start-create btn primary" data-testid="start-create" disabled={!canCreate} title={canCreate ? ko("Create project", "프로젝트 만들기") : createReason}>{ko("Create", "생성")}</button>
						</div>
					</form>
				</aside>
			</div>
		</div>
	);
}

function RecentList({ entries, currentName, onOpen, onRemove, compact = false }) {
	return entries.length === 0 ? (
		<p className={`v2-start-empty${compact ? " compact" : ""}`}>{ko("No recent projects yet.", "아직 최근 프로젝트가 없습니다.")}</p>
	) : (
		<div className={`v2-start-recent-list${compact ? " compact" : ""}`} role="list">
			{entries.map((entry) => (
				<div className={`v2-start-recent-row${entry.name === currentName ? " active" : ""}`} role="listitem" key={entry.key}>
					<button type="button" className="v2-start-recent-open" onClick={() => onOpen(entry)}>
						<strong>{entry.name}</strong>
						<span>{formatDate(entry.date)}</span>
						<small>{entry.shots ?? "—"}{ko(" shots", " 샷")}</small>
					</button>
					{entry.removable && <button type="button" className="v2-start-recent-remove" aria-label={ko(`Remove ${entry.name} from recent projects`, `최근 프로젝트에서 ${entry.name} 제거`)} title={ko("Remove from list", "목록에서 제거")} onClick={() => onRemove(entry)}>×</button>}
				</div>
			))}
		</div>
	);
}
