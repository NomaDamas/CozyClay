#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), "cozyclay-package-check-"));
const extractionRoot = join(temporaryRoot, "extracted");

try {
	mkdirSync(extractionRoot);
	execFileSync("npm", [
		"pack",
		"--ignore-scripts",
		"--pack-destination", temporaryRoot,
	], { cwd: packageRoot, stdio: "pipe" });

	const tarball = readdirSync(temporaryRoot)
		.filter((entry) => entry.endsWith(".tgz"))
		.map((entry) => join(temporaryRoot, entry))[0];
	if (!tarball) throw new Error("npm pack did not produce a tarball");
	execFileSync("tar", ["-xzf", tarball, "-C", extractionRoot]);

	const packedRoot = join(extractionRoot, "package");
	const metadataPath = join(packedRoot, "package.json");
	const markerPath = join(packedRoot, "dist", "cozyclay-package.json");
	const signatureModulePath = join(packedRoot, "bin", "package-signature.mjs");
	if (!existsSync(metadataPath) || !existsSync(markerPath) || !existsSync(signatureModulePath)) {
		throw new Error("npm tarball is missing package metadata or its signature marker");
	}
	const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
	const { verifyPackageMarker } = await import(pathToFileURL(signatureModulePath).href);
	if (!verifyPackageMarker(markerPath, packedRoot, metadata)) {
		throw new Error("npm tarball signature digest does not match the files npm ships");
	}
	console.log(`package tarball signature PASS (${metadata.name}@${metadata.version})`);
} finally {
	rmSync(temporaryRoot, { recursive: true, force: true });
}
