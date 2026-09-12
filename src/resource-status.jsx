/**
 * Resource status UI (#230): what a `.cclayproject` will and will not carry.
 *
 * Both components are pure functions of their props. The manifest comes from
 * `resourceManifest()` in project-resources.js; the save-blocked reasons come
 * from the save path (a `resources-too-large` error from createProjectDocument
 * or the manifest's missing list). Neither component reads App state, so the
 * integrator decides where they mount.
 */
import { ko } from "./locale.js";

const STATUSES = Object.freeze(["embedded", "external", "missing"]);

const KIND_LABELS = {
	image: () => ko("Image", "이미지"),
	motion: () => ko("Motion", "모션"),
	pose: () => ko("Pose", "포즈"),
	"workflow-output": () => ko("Workflow output", "워크플로 출력"),
};

/** The per-item vocabulary: where this resource lives right now. */
export function resourceStatusLabel(item) {
	if (item?.status === "embedded") return ko("In project file", "프로젝트 파일에 포함됨");
	if (item?.status === "external") return ko("External URL", "외부 URL");
	if (item?.stored) return ko("Browser-only copy", "브라우저 임시 저장");
	return ko("Missing", "누락");
}

export function resourceKindLabel(kind) {
	return KIND_LABELS[kind]?.() ?? String(kind ?? "");
}

/** One reference location, readable: `scene-a / obj-1 · assetId`. */
export function resourceRefLabel(ref) {
	if (!ref || typeof ref !== "object") return "";
	const where = [ref.sceneId, ref.objectId, ref.characterId, ref.nodeId].filter((part) => typeof part === "string" && part).join(" / ");
	return where && ref.field ? `${where} · ${ref.field}` : where || ref.field || "";
}

export function formatMiB(bytes) {
	if (!Number.isFinite(bytes) || bytes < 0) return "";
	const mib = bytes / (1024 * 1024);
	return `${mib >= 100 ? mib.toFixed(0) : mib.toFixed(1)} MiB`;
}

function itemsOf(manifest) {
	return Array.isArray(manifest?.items) ? manifest.items.filter((item) => item && typeof item === "object") : [];
}

function totalsOf(manifest, items) {
	const totals = { embedded: 0, external: 0, missing: 0, bytes: 0 };
	for (const item of items) {
		if (STATUSES.includes(item.status)) totals[item.status] += 1;
		if (Number.isFinite(item.bytes)) totals.bytes += item.bytes;
	}
	const given = manifest?.totals;
	if (given && typeof given === "object") {
		for (const key of Object.keys(totals)) if (Number.isFinite(given[key])) totals[key] = given[key];
	}
	return totals;
}

function missingOf(manifest, items) {
	return Array.isArray(manifest?.missing) ? manifest.missing.filter((item) => item && typeof item === "object") : items.filter((item) => item.status === "missing");
}

function itemKey(item, index) {
	return `${item.kind ?? "?"}:${item.id ?? index}`;
}

function ResourceItem({ item, index, onSelect }) {
	const status = STATUSES.includes(item.status) ? item.status : "missing";
	const refs = Array.isArray(item.refs) ? item.refs.map(resourceRefLabel).filter(Boolean) : [];
	const body = (
		<>
			<span className="resource-status-kind">{resourceKindLabel(item.kind)}</span>
			<code className="resource-status-id">{item.id}</code>
			<span className={`resource-status-state is-${status}${item.stored ? " is-stored" : ""}`}>{resourceStatusLabel(item)}</span>
			{item.status === "external" && item.url ? <span className="resource-status-url" title={item.url}>{item.url}</span> : null}
			{refs.length ? <span className="resource-status-refs">{refs.join(", ")}</span> : null}
		</>
	);
	return (
		<li className={`resource-status-item is-${status}`} data-kind={item.kind} data-id={item.id} data-status={status} data-stored={item.stored ? "true" : undefined}>
			{onSelect ? <button type="button" className="resource-status-select" onClick={() => onSelect(item, index)}>{body}</button> : body}
		</li>
	);
}

/**
 * Counts plus, unless `compact`, every resource with its location. Missing
 * resources sort first: they are the reason to open this panel.
 */
export function ResourceStatus({ manifest, compact = false, onSelect }) {
	const items = itemsOf(manifest);
	const totals = totalsOf(manifest, items);
	const missing = missingOf(manifest, items);
	const ordered = [...items].sort((a, b) => Number(b.status === "missing") - Number(a.status === "missing"));
	const className = ["resource-status", compact ? "is-compact" : "", missing.length ? "has-missing" : ""].filter(Boolean).join(" ");
	return (
		<section className={className} aria-label={ko("Project resources", "프로젝트 자원")} data-missing-count={missing.length}>
			<dl className="resource-status-totals">
				<div className="resource-status-total is-embedded"><dt>{ko("In project file", "프로젝트 파일에 포함됨")}</dt><dd data-total="embedded">{totals.embedded}</dd></div>
				<div className="resource-status-total is-external"><dt>{ko("External URL", "외부 URL")}</dt><dd data-total="external">{totals.external}</dd></div>
				<div className="resource-status-total is-missing"><dt>{ko("Missing", "누락")}</dt><dd data-total="missing">{totals.missing}</dd></div>
				{totals.bytes > 0 ? <div className="resource-status-total is-bytes"><dt>{ko("Size", "용량")}</dt><dd data-total="bytes">{formatMiB(totals.bytes)}</dd></div> : null}
			</dl>
			{missing.length ? <p className="resource-status-warning" role="status">{ko(`${missing.length} resource${missing.length === 1 ? "" : "s"} will not travel with this project file.`, `${missing.length}개 자원이 프로젝트 파일에 담기지 않습니다.`)}</p> : null}
			{!compact && ordered.length ? (
				<ul className="resource-status-items">
					{ordered.map((item, index) => <ResourceItem key={itemKey(item, index)} item={item} index={index} onSelect={onSelect} />)}
				</ul>
			) : null}
			{compact && missing.length ? (
				<ul className="resource-status-items is-missing-only" aria-label={ko("Missing resources", "누락된 자원")}>
					{missing.map((item, index) => <ResourceItem key={itemKey(item, index)} item={item} index={index} onSelect={onSelect} />)}
				</ul>
			) : null}
		</section>
	);
}

function reasonBody(reason) {
	if (reason?.code === "resources-too-large") {
		return (
			<>
				<strong>{ko("The project file would be too large.", "프로젝트 파일이 너무 큽니다.")}</strong>
				<span className="save-blocked-size" data-bytes={reason.bytes} data-limit={reason.limit}>
					{ko(`${formatMiB(reason.bytes)} of embedded resources; the limit is ${formatMiB(reason.limit)}.`, `내장 자원 ${formatMiB(reason.bytes)}, 한도 ${formatMiB(reason.limit)}.`)}
				</span>
			</>
		);
	}
	if (reason?.code === "missing-resources") {
		const items = Array.isArray(reason.items) ? reason.items.filter((item) => item && typeof item === "object") : [];
		return (
			<>
				<strong>{ko(`${items.length} resource${items.length === 1 ? " is" : "s are"} missing.`, `${items.length}개 자원이 누락되었습니다.`)}</strong>
				<ul className="save-blocked-missing">
					{items.map((item, index) => <ResourceItem key={itemKey(item, index)} item={item} index={index} />)}
				</ul>
			</>
		);
	}
	return <strong>{typeof reason?.message === "string" && reason.message ? reason.message : String(reason?.code ?? ko("Unknown reason", "알 수 없는 원인"))}</strong>;
}

/**
 * Why the save did not happen. `reasons` is a list of
 *   { code: "missing-resources", items }            — the manifest's missing list
 *   { code: "resources-too-large", bytes, limit }   — from createProjectDocument
 *   { code, message? }                              — anything else, shown as is
 */
export function SaveBlockedDialog({ reasons, onClose }) {
	const list = Array.isArray(reasons) ? reasons.filter(Boolean) : [];
	return (
		<div className="modal-overlay" onClick={onClose}>
			<div className="modal save-blocked-dialog" role="dialog" aria-modal="true" aria-labelledby="save-blocked-title" onClick={(event) => event.stopPropagation()}>
				<div className="modal-head">
					<h3 id="save-blocked-title">{ko("The project was not saved", "프로젝트를 저장하지 못했어요")}</h3>
					<button type="button" className="x" onClick={onClose} aria-label={ko("Close", "닫기")}>✕</button>
				</div>
				<ul className="save-blocked-reasons">
					{list.map((reason, index) => <li key={`${reason.code ?? "reason"}:${index}`} className="save-blocked-reason" data-code={reason.code}>{reasonBody(reason)}</li>)}
				</ul>
				<div className="modal-actions">
					<button type="button" className="btn" onClick={onClose}>{ko("OK", "확인")}</button>
				</div>
			</div>
		</div>
	);
}

export default ResourceStatus;
