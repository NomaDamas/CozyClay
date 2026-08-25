import { useEffect, useState } from "react";
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

/**
 * Game-engine style project picker. Two sources of truth:
 *  - Recents: everything the operator opened or saved before (always works).
 *  - A projects folder: when granted, the folder is enumerated so files the
 *    operator never opened in THIS browser show up too.
 * Fallback for browsers without the File System Access API: recents plus a
 * plain "open file" button (the folder section is hidden).
 */
export default function ProjectBrowser({ currentName, onOpen, onOpenFile, onNew, onClose }) {
	const [recents, setRecents] = useState([]);
	const [folder, setFolder] = useState(null);
	const [folderProjects, setFolderProjects] = useState([]);
	const [folderDenied, setFolderDenied] = useState(false);
	// A stored folder handle Chromium demoted to "prompt": one click on the
	// re-allow button re-grants it without re-picking the folder (#51).
	const [lostFolder, setLostFolder] = useState(null);

	useEffect(() => {
		loadRecentProjects().then(setRecents);
		loadProjectsDirectory().then(async (handle) => {
			if (!handle) return;
			const permission = await queryHandlePermission(handle);
			if (permission !== "granted") {
				setFolderDenied(true);
				if (permission === "prompt") setLostFolder(handle);
				return;
			}
			setFolder(handle);
			setFolderProjects(await listProjectsInDirectory(handle));
		});
	}, []);

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
		try {
			const handle = await pickProjectsDirectory();
			await storeProjectsDirectory(handle);
			setFolder(handle);
			setFolderDenied(false);
			setLostFolder(null);
			setFolderProjects(await listProjectsInDirectory(handle));
		} catch (err) {
			if (err?.name !== "AbortError") setFolderDenied(true);
		}
	};

	const refreshFolder = async () => {
		if (folder) setFolderProjects(await listProjectsInDirectory(folder));
	};

	return (
		<div className="project-browser-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
			<div className="project-browser" role="dialog" aria-label={ko("Open project", "프로젝트 열기")}>
				<div className="project-browser-head">
					<strong>{ko("Projects", "프로젝트")}</strong>
					<button type="button" className="x" onClick={onClose} aria-label={ko("Close", "닫기")}>✕</button>
				</div>

				<section>
					<div className="project-browser-section-head">
						<span>{ko("Recent projects", "최근 프로젝트")}</span>
					</div>
					{recents.length === 0 ? (
						<p className="project-browser-empty">{ko("No projects yet — save one and it shows up here.", "아직 프로젝트가 없어요. 저장하면 여기에 나타납니다.")}</p>
					) : (
						<ul className="project-browser-list">
							{recents.map((entry) => (
								<li key={entry.name} className={entry.name === currentName ? "active" : ""}>
									<button type="button" onClick={() => onOpen(entry)}>
										<strong>{entry.name}</strong>
										<span>{new Date(entry.openedAt).toLocaleString()}</span>
									</button>
									<button
										type="button"
										className="del"
										title={ko("Remove from list", "목록에서 제거")}
										onClick={async () => {
											await removeRecentProject(entry.name);
											setRecents(await loadRecentProjects());
										}}
									>
										✕
									</button>
								</li>
							))}
						</ul>
					)}
				</section>

				{hasFileSystemAccess() && hasDirectoryPicker() && (
					<section>
						<div className="project-browser-section-head">
							<span>{ko("Projects folder", "프로젝트 폴더")}</span>
							<div className="row-actions">
								{folder && <button type="button" onClick={refreshFolder}>{ko("Refresh", "새로고침")}</button>}
								<button type="button" onClick={chooseFolder}>
									{folder ? ko("Change folder…", "폴더 변경…") : ko("Choose folder…", "폴더 지정…")}
								</button>
							</div>
						</div>
						{folderDenied && (
							<p className="project-browser-empty">
								{lostFolder
									? ko("Folder access needs to be re-allowed.", "폴더 접근을 다시 허용해야 해요.")
									: ko("Folder access is not granted — choose it again.", "폴더 접근 권한이 없어요. 다시 지정해 주세요.")}
								{lostFolder && (
									<button type="button" onClick={reauthorizeFolder}>{ko("Re-allow", "다시 허용")}</button>
								)}
							</p>
						)}
						{folder && folderProjects.length === 0 && !folderDenied && (
							<p className="project-browser-empty">{ko("No .cclayproject files in this folder.", "이 폴더에 .cclayproject 파일이 없어요.")}</p>
						)}
						{folderProjects.length > 0 && (
							<ul className="project-browser-list">
								{folderProjects.map((entry) => (
									<li key={entry.name} className={entry.name === currentName ? "active" : ""}>
										<button type="button" onClick={() => onOpen(entry)}>
											<strong>{entry.name}</strong>
											<span>{new Date(entry.lastModified).toLocaleString()}</span>
										</button>
									</li>
								))}
							</ul>
						)}
					</section>
				)}

				<div className="project-browser-foot">
					<button type="button" className="btn ghost" onClick={onOpenFile}>{ko("Open file…", "파일로 열기…")}</button>
					<button type="button" className="btn primary" onClick={onNew}>{ko("New Project", "새 프로젝트")}</button>
				</div>
			</div>
		</div>
	);
}
