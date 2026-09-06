import assert from "node:assert/strict";
import { createPkceVerifier, pkceChallenge } from "../bin/codex-auth.mjs";
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
assert.equal(pkceChallenge(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", "RFC 7636 S256 vector");
assert.match(createPkceVerifier(), /^[A-Za-z0-9_-]{43}$/);
console.log("codex auth verification passed");
