#!/usr/bin/env node
import assert from "node:assert/strict";
import { studio, receipt } from "./verify-live.mjs";

const s = await studio({ withCast: true });
try {
	const added = receipt(await s.call("add_character", { subject: "Capsule live target", model: "proxy-figure", posture: "sit", x: 0, z: 0 }), "character.add");
	const proxyId = added.affectedIds.find(id => s.f.cast.read().find(row => row.id === id)?.model === "proxy-figure");
	assert(proxyId, JSON.stringify(added));
	const selected = await s.f.call("operate_studio", s.f.request("operate_studio", { selection: { kind: "character", id: proxyId }, frame: 0 }));
	assert.equal(selected.ok, true, JSON.stringify(selected));
	const framed = receipt(await s.call("frame_shot", { size: "medium shot", view: "front", level: "eye", side: "right", focal_mm: 35 }), "shot.frame");
	const verified = await s.f.call("verify_result", s.f.request("verify_result", { receiptId: framed.receiptId, checks: ["framing"], visual: "none" }));
	const verification = verified;
	assert.notEqual(verification.code, "TARGET_NOT_READY", JSON.stringify(verification));
	console.log(`PASS cclay live frame-shot proxy: ok=true receiptId=${framed.receiptId} affectedIds=${JSON.stringify(framed.affectedIds)}`);
	console.log(`PASS cclay live verify-result proxy: code=${verification.code ?? "none"} checks=${JSON.stringify(verification.checks)}`);
} finally {
	await s.close();
}
