#!/usr/bin/env node
/**
 * A stand-in for npm, pointed at by COZYCLAY_NPM_BIN in the update tests.
 *
 *   root -g            prints FAKE_NPM_ROOT
 *   install ...        appends its argv to FAKE_NPM_LOG, waits for the
 *                      FAKE_NPM_GATE file if one is named, then acts out
 *                      FAKE_NPM_MODE: ok, eacces, network, node_version,
 *                      other, or hang (never exits on its own)
 */
import { appendFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "root" && args[1] === "-g") {
	console.log(process.env.FAKE_NPM_ROOT ?? "");
	process.exit(0);
}
if (process.env.FAKE_NPM_LOG) appendFileSync(process.env.FAKE_NPM_LOG, `${JSON.stringify(args)}\n`);

const STDERR = {
	eacces: "npm error code EACCES\nnpm error syscall mkdir\nnpm error path /usr/local/lib/node_modules/cozyclay\n",
	network: "npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/cozyclay failed\n",
	node_version: "npm error code EBADENGINE\nnpm error engine Unsupported engine\nnpm error notsup Not compatible with your version of node/npm: cozyclay@3.9.9\n",
	other: "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/cozyclay\n",
};

function act() {
	const mode = process.env.FAKE_NPM_MODE ?? "ok";
	if (mode === "hang") {
		setInterval(() => {}, 1000);
		return;
	}
	if (mode === "ok") {
		console.log("changed 1 package in 1s");
		process.exit(0);
	}
	process.stderr.write(STDERR[mode] ?? STDERR.other);
	process.exit(1);
}

const gate = process.env.FAKE_NPM_GATE;
if (gate && !existsSync(gate)) {
	const timer = setInterval(() => {
		if (!existsSync(gate)) return;
		clearInterval(timer);
		act();
	}, 20);
} else {
	act();
}
