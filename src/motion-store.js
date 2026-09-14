export const MOTION_DB_NAME = "cozyclay.motions";
export const MOTION_DB_VERSION = 1;
export const MOTION_STORE_NAME = "motions";

const validId = (id) => typeof id === "string" && /^[0-9a-f]{64}$/i.test(id);

export function normalizeMotion(record) {
	if (!record || typeof record !== "object" || !validId(record.motionId)) return null;
	if (record.encoding !== "base64" || typeof record.data !== "string") return null;
	return { ...record, motionId: record.motionId.toLowerCase(), stored: true };
}

export function openMotionDb(factory = globalThis.indexedDB) {
	if (!factory) return Promise.reject(new Error("IndexedDB is unavailable"));
	return new Promise((resolve, reject) => {
		const req = factory.open(MOTION_DB_NAME, MOTION_DB_VERSION);
		req.onupgradeneeded = () => {
			if (!req.result.objectStoreNames.contains(MOTION_STORE_NAME)) req.result.createObjectStore(MOTION_STORE_NAME, { keyPath: "motionId" });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
		req.onblocked = () => reject(new Error("the motion database is blocked by another tab"));
	});
}

const request = (req) => new Promise((resolve, reject) => {
	req.onsuccess = () => resolve(req.result);
	req.onerror = () => reject(req.error);
});
const complete = (tx) => new Promise((resolve, reject) => {
	tx.oncomplete = resolve;
	tx.onerror = () => reject(tx.error);
	tx.onabort = () => reject(tx.error);
});

export async function putMotion(db, record) {
	const value = normalizeMotion(record);
	if (!value) throw new TypeError("putMotion needs a valid motion record");
	const tx = db.transaction(MOTION_STORE_NAME, "readwrite");
	tx.objectStore(MOTION_STORE_NAME).put(value);
	await complete(tx);
	return value;
}
export async function getMotion(db, id) {
	if (!validId(id)) return null;
	const tx = db.transaction(MOTION_STORE_NAME, "readonly");
	return normalizeMotion(await request(tx.objectStore(MOTION_STORE_NAME).get(id.toLowerCase())));
}
export async function listMotionIds(db) {
	const tx = db.transaction(MOTION_STORE_NAME, "readonly");
	return (await request(tx.objectStore(MOTION_STORE_NAME).getAllKeys()) ?? []).filter(validId).map((id) => id.toLowerCase());
}
export async function deleteMotion(db, id) {
	if (!validId(id)) return false;
	const tx = db.transaction(MOTION_STORE_NAME, "readwrite");
	tx.objectStore(MOTION_STORE_NAME).delete(id.toLowerCase());
	await complete(tx);
	return true;
}
export async function sweepMotions(db, referencedIds) {
	const keep = new Set([...referencedIds ?? []].map((id) => String(id).toLowerCase()));
	const ids = await listMotionIds(db);
	await Promise.all(ids.filter((id) => !keep.has(id)).map((id) => deleteMotion(db, id)));
	return ids.filter((id) => !keep.has(id));
}
