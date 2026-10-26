// A sculpt card on the asset shelf (#740 S9 + S13), and the `.cozysculpt.json`
// file that carries one between browsers. Pure: no IndexedDB, no three.js, so
// scene-assets.js, the node tests and the shelf all read one truth.
//
// A card is a record in the shared asset store (`cozyclay.assets`) under a
// `sculpt-` id. Its bytes ARE the file: the UTF-8 JSON
//   { "format": "cozysculpt", "version": 1, "name", "recipe", "thumb"? }
// so export writes the stored bytes and import stores what it parsed. The id is
// the SHA-256 of the normalized recipe, so saving the same sculpt twice keeps
// one card (the later name and thumbnail win). The store is origin-wide, so a
// card shows in every project; it is never part of a project export.
import { normalizeSculptRecipe } from "./sculpt-recipe.js";

const SCULPT_CARD_FORMAT = "cozysculpt";
const SCULPT_CARD_VERSION = 1;
export const SCULPT_CARD_TYPE = "application/vnd.cozyclay.sculpt+json";
export const SCULPT_FILE_SUFFIX = ".cozysculpt.json";
const SCULPT_ID = /^sculpt-[0-9a-f]{32}$/;
// A card file is a recipe and a 256 px picture; anything far bigger is not one.
const MAX_FILE_CHARS = 4 * 1024 * 1024;
const MAX_THUMB_CHARS = 1024 * 1024;
const THUMB = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const MAX_NAME = 120;

export const isSculptAssetId = (value) => typeof value === "string" && SCULPT_ID.test(value);

const cleanName = (name) => (typeof name === "string" ? name.trim().slice(0, MAX_NAME) : "");
const cleanThumb = (thumb) => (typeof thumb === "string" && thumb.length <= MAX_THUMB_CHARS && THUMB.test(thumb) ? thumb : null);

/** The `.cozysculpt.json` text of a card. Throws when the recipe is refused. */
export function serializeCard({ name, recipe, thumb = null }) {
	const normalized = normalizeSculptRecipe(recipe);
	if (!normalized.ok) throw new TypeError(`Recipe refused at ${normalized.error}`);
	const picture = cleanThumb(thumb);
	return JSON.stringify({ format: SCULPT_CARD_FORMAT, version: SCULPT_CARD_VERSION, name: cleanName(name) || "Sculpt", recipe: normalized.recipe, ...(picture ? { thumb: picture } : {}) });
}

/**
 * Read a `.cozysculpt.json` text: { ok: true, card: { name, recipe, thumb } }
 * or { ok: false, error } with a sentence for the user. The recipe is checked
 * as a whole, never repaired; a bad thumbnail is dropped, not fatal.
 */
export function parseCard(text) {
	if (typeof text !== "string" || !text.trim()) return { ok: false, error: "the file is empty" };
	if (text.length > MAX_FILE_CHARS) return { ok: false, error: "the file is too large to be a sculpt card" };
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		return { ok: false, error: "the file is not JSON" };
	}
	if (!data || typeof data !== "object" || Array.isArray(data) || data.format !== SCULPT_CARD_FORMAT) return { ok: false, error: "the file is not a .cozysculpt.json sculpt card" };
	if (data.version !== SCULPT_CARD_VERSION) return { ok: false, error: `card version ${JSON.stringify(data.version)} is not supported (expected ${SCULPT_CARD_VERSION})` };
	const normalized = normalizeSculptRecipe(data.recipe);
	if (!normalized.ok) return { ok: false, error: `the recipe is refused at ${normalized.error}` };
	return { ok: true, card: { name: cleanName(data.name) || "Sculpt", recipe: normalized.recipe, thumb: cleanThumb(data.thumb) } };
}

async function sha256Hex(text, subtle) {
	if (!subtle?.digest) throw new Error("SubtleCrypto is unavailable — a secure context is required to save a sculpt card");
	const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The asset-store record of a card: the file text as bytes, under its recipe's id. */
export async function sculptCardRecord(card, subtle = globalThis.crypto?.subtle) {
	const text = serializeCard(card);
	const { name, recipe } = JSON.parse(text);
	const id = `sculpt-${(await sha256Hex(JSON.stringify(recipe), subtle)).slice(0, 32)}`;
	const bytes = new TextEncoder().encode(text);
	return { id, type: SCULPT_CARD_TYPE, name, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

/** normalizeAsset's branch for a `sculpt-` id: the bytes must parse as a card. */
export function normalizeSculptAsset(record, bytes) {
	if (record.type !== SCULPT_CARD_TYPE) return null;
	const parsed = parseCard(new TextDecoder().decode(bytes));
	return parsed.ok ? { id: record.id, type: SCULPT_CARD_TYPE, bytes, name: parsed.card.name } : null;
}

/** A stored card record as the shelf shows it, or null when it does not read. */
export function readSculptCard(record) {
	if (!isSculptAssetId(record?.id) || !(record.bytes instanceof ArrayBuffer)) return null;
	const parsed = parseCard(new TextDecoder().decode(record.bytes));
	return parsed.ok ? { id: record.id, ...parsed.card } : null;
}

/** A file name for the card's export: its name, kept to safe characters. */
export function sculptCardFileName(name) {
	const stem = cleanName(name).replace(/[^\p{L}\p{N} _-]+/gu, "").trim().replace(/\s+/g, "-") || "sculpt";
	return `${stem}${SCULPT_FILE_SUFFIX}`;
}
