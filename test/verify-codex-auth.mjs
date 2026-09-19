import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPkceVerifier, pkceChallenge } from "../bin/codex-auth.mjs";
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
assert.equal(pkceChallenge(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", "RFC 7636 S256 vector");
assert.match(createPkceVerifier(), /^[A-Za-z0-9_-]{43}$/);
// Notification identity is independent of both rotating token values. A fresh
// module instance captures a scratch token path without touching owner auth.
const scratch = mkdtempSync(join(tmpdir(), "cozyclay-codex-auth-"));
const previousAuthFile = process.env.COZYCLAY_CODEX_AUTH_FILE;
const authFile = join(scratch, "codex-auth.json");
process.env.COZYCLAY_CODEX_AUTH_FILE = authFile;
let auth;
try {
	auth = await import("../bin/codex-auth.mjs?identity-test");
} finally {
	if (previousAuthFile === undefined) delete process.env.COZYCLAY_CODEX_AUTH_FILE;
	else process.env.COZYCLAY_CODEX_AUTH_FILE = previousAuthFile;
}
const changes = [];
const off = auth.onAuthChange(change => changes.push(change));
const tokenFor = accountId => `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.e30`;
const expectChange = (kind, signedIn, accountId) => {
	const change = changes.at(-1);
	assert.equal(change.kind, kind);
	assert.deepEqual(change.status, auth.status());
	assert.equal(change.status.signedIn, signedIn);
	assert.equal(change.status.accountId, accountId);
	assert.deepEqual(Object.keys(change).sort(), ["kind", "status"]);
	assert.equal(JSON.stringify(change).includes("secret"), false, "notifications never expose credentials");
};
try {
	auth.writeStored({ access_token: "secret-access-a", refresh_token: "secret-refresh-a", expires_at: Date.now() + 3600000, id_token: tokenFor("account-a") });
	expectChange("replaced", true, "account-a");
	auth.writeStored({ access_token: "secret-access-b", refresh_token: "secret-refresh-b" });
	expectChange("rotated", true, "account-a");
	assert.equal(JSON.parse(readFileSync(authFile, "utf8")).access_token, "secret-access-b");
	auth.writeStored({ id_token: tokenFor("account-b") });
	expectChange("replaced", true, "account-b");
	// Removing the refresh token signs out even if stale id_token claims remain.
	auth.writeStored({ refresh_token: null });
	expectChange("signed_out", false, "account-b");
	auth.logout();
	expectChange("signed_out", false, null);
	assert.equal(auth.readStored(), undefined);
	// Legacy credentials may have no decodable id_token: compare presence,
	// not the refresh token value, since OAuth can rotate that token as well.
	auth.writeStored({ access_token: "secret-legacy-access", refresh_token: "secret-legacy-refresh", id_token: "invalid" });
	expectChange("replaced", true, null);
	auth.writeStored({ access_token: "secret-legacy-access-2", refresh_token: "secret-legacy-refresh-2" });
	expectChange("rotated", true, null);
	let response;
	await auth.handleOAuthRequest({ method: "POST", url: "/oauth/logout" }, {
		writeHead(code) { assert.equal(code, 200); },
		end(body) { response = JSON.parse(body); },
	});
	assert.deepEqual(response, { ok: true });
	expectChange("signed_out", false, null);
	assert.equal(changes.length, 8, "exactly one notification per write or clear");
	off();
	auth.logout();
	assert.equal(changes.length, 8, "unsubscribe removes the listener");
} finally {
	off();
	rmSync(scratch, { recursive: true, force: true });
}
console.log("codex auth verification passed");
