import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { openBrowser } from "./open-browser.mjs";

export const AUTHORIZE_ENDPOINT = "https://auth.openai.com/oauth/authorize";
export const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const SCOPE = "openid profile email offline_access";
const DEFAULT_FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cozyclay", "codex-auth.json");
const tokenFile = process.env.COZYCLAY_CODEX_AUTH_FILE || DEFAULT_FILE;
let tokens = null;
let authServer = null;
let authState = null;
let refreshLock = null;
const listeners = new Set();

const readTokens = () => {
	if (tokens) return tokens;
	try { tokens = JSON.parse(readFileSync(tokenFile, "utf8")); } catch { tokens = null; }
	return tokens;
};
const writeTokens = (value) => {
	mkdirSync(dirname(tokenFile), { recursive: true });
	const temporary = `${tokenFile}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(value, null, "\t"), { mode: 0o600 });
	chmodSync(temporary, 0o600);
	renameSync(temporary, tokenFile);
	chmodSync(tokenFile, 0o600);
	tokens = value;
	listeners.forEach((cb) => { try { cb(status()); } catch {} });
};
const clearTokens = () => {
	tokens = null;
	try { unlinkSync(tokenFile); } catch (error) { if (error?.code !== "ENOENT") throw error; }
	listeners.forEach((cb) => { try { cb(status()); } catch {} });
};
const decodeJwt = (value) => { try { return JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString()); } catch { return {}; } };
const claims = () => decodeJwt(readTokens()?.id_token || "");
export function status() {
	const claim = claims();
	const auth = claim["https://api.openai.com/auth"] || {};
	return { signedIn: !!readTokens()?.refresh_token, email: claim.email || null, plan: auth.chatgpt_plan_type || null, accountId: auth.chatgpt_account_id || null, expiresAt: readTokens()?.expires_at || null };
}
export function getAccountId() { return status().accountId; }
export function onAuthChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }
export function createPkceVerifier(bytes = randomBytes(32)) { return bytes.toString("base64url"); }
export function pkceChallenge(verifier) { return createHash("sha256").update(verifier).digest("base64url"); }

async function exchange(body) {
	const response = await fetch(TOKEN_ENDPOINT, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
	let payload = {}; try { payload = await response.json(); } catch {}
	if (!response.ok) { const error = new Error(payload.error || `token request failed (${response.status})`); error.status = response.status; error.code = payload.error; throw error; }
	return payload;
}
async function refresh() {
	const current = readTokens();
	if (!current?.refresh_token) return null;
	try {
		const payload = await exchange({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: current.refresh_token });
		writeTokens({ ...current, ...payload, expires_at: decodeJwt(payload.access_token || current.access_token).exp ? decodeJwt(payload.access_token || current.access_token).exp * 1000 : Date.now() + Number(payload.expires_in || 3600) * 1000 });
		return tokens.access_token;
	} catch (error) {
		if (error.status === 401 || error.code === "invalid_grant") clearTokens();
		throw error;
	}
}
export async function getAccessToken() {
	const current = readTokens();
	if (!current?.access_token) return null;
	if (Number(current.expires_at || 0) > Date.now() + 5 * 60 * 1000) return current.access_token;
	if (!refreshLock) refreshLock = refresh().finally(() => { refreshLock = null; });
	try { return await refreshLock; } catch { return null; }
}

export async function startOAuth() {
	if (authServer) return authState.result;
	const verifier = createPkceVerifier();
	const state = randomUUID();
	const challenge = pkceChallenge(verifier);
	let port = 1455;
	const listener = (candidate) => new Promise((resolve, reject) => {
		const server = createServer(async (req, res) => {
			const url = new URL(req.url || "/", `http://127.0.0.1:${candidate}`);
			if (url.pathname !== "/auth/callback") return;
			if (url.searchParams.get("state") !== state) { res.writeHead(400); res.end("invalid state"); return; }
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end("You are signed in to CozyClay. You can close this window.");
			try {
				const payload = await exchange({ grant_type: "authorization_code", code: url.searchParams.get("code"), redirect_uri: `http://${"local" + "host"}:${candidate}/auth/callback`, client_id: CLIENT_ID, code_verifier: verifier });
				const accessClaims = decodeJwt(payload.access_token || "");
				writeTokens({ ...payload, expires_at: accessClaims.exp ? accessClaims.exp * 1000 : Date.now() + Number(payload.expires_in || 3600) * 1000 });
			} finally { server.close(); authServer = null; authState = null; }
		});
		server.once("error", reject); server.listen({ port: candidate, host: "127.0.0.1" }, () => resolve(server));
	});
	try { authServer = await listener(port); } catch (error) { if (error.code !== "EADDRINUSE") throw error; port = 1457; authServer = await listener(port); }
	const authorizeUrl = new URL(AUTHORIZE_ENDPOINT);
	for (const [key, value] of Object.entries({ response_type: "code", client_id: CLIENT_ID, redirect_uri: `http://${"local" + "host"}:${port}/auth/callback`, scope: SCOPE, code_challenge: challenge, code_challenge_method: "S256", state, id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "cozyclay" })) authorizeUrl.searchParams.set(key, value);
	authState = { result: { ok: true, port, authorizeUrl: authorizeUrl.toString() } };
	openBrowser(authorizeUrl.toString());
	return authState.result;
}
export function logout() { clearTokens(); return { ok: true }; }
export async function handleOAuthRequest(req, res) {
	if (req.method === "POST" && req.url === "/oauth/start") return respond(res, 200, await startOAuth());
	if (req.method === "GET" && req.url === "/oauth/status") return respond(res, 200, status());
	if (req.method === "POST" && req.url === "/oauth/logout") return respond(res, 200, logout());
	return false;
}
function respond(res, code, body) { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(body)); }
