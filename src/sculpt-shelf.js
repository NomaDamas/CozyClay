// The sculpt shelf (#740 S9 + S13): sculpt cards in the shared asset store
// (`cozyclay.assets`, scene-assets.js) under `sculpt-` ids. The store belongs to
// this browser, not to a project, so every project and every scene sees the
// same cards: that is the cross-project library. Nothing here leaves the
// machine; a card travels only as a `.cozysculpt.json` the user saves.
//
// The Content pane's Sculpts folder subscribes here; Save to shelf, import and
// delete publish the new list. `openDb` is injectable for the node tests.
import { deleteAsset, getAsset, listAssetIds, openAssetDb, putAsset } from "./scene-assets.js";
import { isSculptAssetId, parseCard, readSculptCard, sculptCardFileName, sculptCardRecord, SCULPT_CARD_TYPE } from "./sculpt-shelf-file.js";
import { renderSculptThumb } from "./sculpt-thumb.js";
import { saveExport } from "./export-workspace.js";
import { ko } from "./locale.js";

const listeners = new Set();
// null until the first read: the folder shows skeletons, not "no cards".
let cards = null;

function publish(next) {
	cards = Object.freeze(next);
	for (const listener of listeners) listener();
}

/** The cards, newest name order: [{ id, name, recipe, thumb }] or null before the first read. */
export const sculptShelfCards = () => cards;
export function subscribeSculptShelf(listener) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

async function withDb(openDb, work) {
	const db = await openDb();
	try {
		return await work(db);
	} finally {
		db?.close?.();
	}
}

/** Re-read every card from the store. Without IndexedDB the shelf is empty. */
export async function refreshSculptShelf({ openDb = openAssetDb } = {}) {
	try {
		const read = await withDb(openDb, async (db) => {
			const ids = (await listAssetIds(db)).filter(isSculptAssetId);
			return (await Promise.all(ids.map((id) => getAsset(db, id)))).map(readSculptCard).filter(Boolean);
		});
		publish(read.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)));
	} catch {
		publish([]);
	}
	return cards;
}

/** Store one card { name, recipe, thumb }; the same recipe overwrites its card. Answers its id. */
export async function putSculptCard(card, { openDb = openAssetDb, subtle } = {}) {
	const record = await sculptCardRecord(card, subtle);
	await withDb(openDb, (db) => putAsset(db, record));
	await refreshSculptShelf({ openDb });
	return record.id;
}

export async function deleteSculptCard(id, { openDb = openAssetDb } = {}) {
	if (!isSculptAssetId(id)) return false;
	await withDb(openDb, (db) => deleteAsset(db, id));
	await refreshSculptShelf({ openDb });
	return true;
}

/** The stored `.cozysculpt.json` text of a card, or null when it is gone. */
async function sculptCardText(id, { openDb = openAssetDb } = {}) {
	const record = await withDb(openDb, (db) => getAsset(db, id));
	return record ? new TextDecoder().decode(record.bytes) : null;
}

/** Sculpt panel's Save to shelf: a copy of the recipe, its name and a thumbnail. Answers a toast line. */
export async function saveSculptToShelf(sculpt, { openDb = openAssetDb, renderThumb = renderSculptThumb } = {}) {
	if (!sculpt?.recipe) return ko("Select a sculpt to save it to the shelf.", "선반에 저장할 조형물을 선택하세요.");
	try {
		const thumb = await renderThumb(sculpt.recipe);
		await putSculptCard({ name: sculpt.name, recipe: sculpt.recipe, thumb }, { openDb });
		return ko(`${sculpt.name} saved to the shelf — Content › Sculpts`, `${sculpt.name} 선반에 저장됨 — 콘텐츠 › 조형물`, `${sculpt.name} 已保存到架子 — 内容 › 雕塑`);
	} catch (error) {
		return ko(`Could not save to the shelf: ${error.message}`, `선반에 저장하지 못했어요: ${error.message}`, `无法保存到架子：${error.message}`);
	}
}

/** Import `.cozysculpt.json` files as cards. Answers a toast line naming what came in or why not. */
export async function importSculptCardFiles(files, { openDb = openAssetDb } = {}) {
	const names = [], problems = [];
	for (const file of Array.from(files ?? [])) {
		const parsed = parseCard(await file.text());
		if (!parsed.ok) problems.push(`${file.name}: ${parsed.error}`);
		else {
			await putSculptCard(parsed.card, { openDb });
			names.push(parsed.card.name);
		}
	}
	if (problems.length) return ko(`Not imported — ${problems.join("; ")}`, `가져오지 못했어요 — ${problems.join("; ")}`, `未导入 — ${problems.join("; ")}`);
	return names.length ? ko(`Imported ${names.join(", ")}`, `가져옴: ${names.join(", ")}`, `已导入 ${names.join("、")}`) : "";
}

/** Save one card as `<name>.cozysculpt.json` through the export workspace (or a download). */
export async function exportSculptCard(card, { openDb = openAssetDb } = {}) {
	const text = await sculptCardText(card.id, { openDb });
	if (!text) return ko("That card is no longer on the shelf.", "이 카드는 이미 선반에 없어요.");
	const result = await saveExport(new Blob([text], { type: SCULPT_CARD_TYPE }), sculptCardFileName(card.name));
	return ko(`Saved ${result.name ?? sculptCardFileName(card.name)}`, `${result.name ?? sculptCardFileName(card.name)} 저장됨`, `已保存 ${result.name ?? sculptCardFileName(card.name)}`);
}
