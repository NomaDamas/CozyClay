import assert from "node:assert/strict";
import { openMotionDb, putMotion, getMotion, listMotionIds, sweepMotions, deleteMotion } from "../src/motion-store.js";
const rows = new Map();
function operation(result) { const req = { result }; queueMicrotask(() => req.onsuccess?.()); return req; }
const factory = { open() { const req = {}; queueMicrotask(() => { req.result = { objectStoreNames: { contains: () => true }, transaction: () => { const tx = { objectStore: () => ({ put: (v) => rows.set(v.motionId, v), get: (id) => operation(rows.get(id)), getAllKeys: () => operation([...rows.keys()]), delete: (id) => { rows.delete(id); } }) }; queueMicrotask(() => tx.oncomplete?.()); return tx; } }; req.onsuccess?.(); }); return req; } };
const db = await openMotionDb(factory);
const id = "a".repeat(64);
await putMotion(db, { motionId: id, encoding: "base64", data: "AAAA", bytes: 3 });
assert.equal((await getMotion(db, id)).stored, true);
assert.deepEqual(await listMotionIds(db), [id]);
await putMotion(db, { motionId: "b".repeat(64), encoding: "base64", data: "AAAA", bytes: 3 });
assert.deepEqual(await sweepMotions(db, [id]), ["b".repeat(64)]);
assert.deepEqual(await listMotionIds(db), [id]);
assert.equal(await deleteMotion(db, id), true);
assert.equal(await deleteMotion(db, "bad"), false);
assert.deepEqual(await listMotionIds(db), []);
console.log("motion store IndexedDB adapter checks PASS");
