#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	effectiveTelemetryEnabled,
	markTelemetryFirstLaunch,
	readTelemetryState,
	setTelemetryEnabled,
	setTelemetryInternalQa,
	takeRuntimeTelemetryConfig,
} from "../bin/telemetry-state.mjs";

const directory = mkdtempSync(join(tmpdir(), "cozyclay-telemetry-state-"));
const stateFile = join(directory, "state.json");
const installationId = "018f0d66-3a4b-7c2d-8e9f-123456789abc";
const now = "2026-08-24T14:00:00.000Z";

try {
	const initial = readTelemetryState(stateFile);
	assert.equal(initial.telemetryEnabled, true, "telemetry defaults on for the official package");
	assert.equal(initial.internalQa, false, "internal QA defaults off");
	assert.equal(initial.installationId, null, "reading status alone does not create an installation identity");

	const first = takeRuntimeTelemetryConfig(stateFile, {
		appVersion: "1.5.0",
		env: {},
		now: () => now,
		randomUUID: () => installationId,
	});
	assert.deepEqual(first, {
		distribution: "npm",
		telemetryEnabled: true,
		internalQa: false,
		installationId,
		appVersion: "1.5.0",
		apiKey: "phc_CpizzZ8VhSorSS8yEeQhdpUcvB2erp5xkCbnFD8HTJ5m",
		apiHost: "https://t.cozyclay.org",
		firstLaunch: true,
		firstLaunchHeardFrom: null,
		installKind: "npx",
	});
	assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).installationId, installationId);
	assert.equal(
		readTelemetryState(stateFile).firstLaunchedAt,
		null,
		"starting the CLI without opening the studio does not consume first launch",
	);
	markTelemetryFirstLaunch(stateFile, () => now);

	const returning = takeRuntimeTelemetryConfig(stateFile, {
		appVersion: "1.5.0",
		env: {},
		now: () => "2026-08-25T14:00:00.000Z",
		randomUUID: () => "should-not-be-used",
	});
	assert.equal(returning.installationId, installationId, "the same device keeps one anonymous identity");
	assert.equal(returning.firstLaunch, false, "first launch is emitted exactly once");

	setTelemetryEnabled(stateFile, false);
	assert.equal(readTelemetryState(stateFile).telemetryEnabled, false);
	assert.equal(readTelemetryState(stateFile).installationId, null, "opt-out removes the anonymous device id");
	assert.equal(
		takeRuntimeTelemetryConfig(stateFile, {
			appVersion: "1.5.0",
			env: {},
			now: () => now,
			randomUUID: () => "should-not-be-used",
		}).telemetryEnabled,
		false,
	);

	setTelemetryEnabled(stateFile, true);
	setTelemetryInternalQa(stateFile, true);
	assert.equal(readTelemetryState(stateFile).internalQa, true);
	assert.equal(
		takeRuntimeTelemetryConfig(stateFile, { appVersion: "1.5.0", env: {} }).internalQa,
		true,
		"internal QA is surfaced only after explicit opt-in",
	);
	assert.equal(
		takeRuntimeTelemetryConfig(stateFile, { appVersion: "1.5.0", env: { DO_NOT_TRACK: "1" } }).internalQa,
		false,
		"environment opt-out wins over internal QA marking",
	);
	assert.equal(effectiveTelemetryEnabled(readTelemetryState(stateFile), { CI: "1" }), false, "CI is always excluded");
	assert.equal(effectiveTelemetryEnabled(readTelemetryState(stateFile), { DO_NOT_TRACK: "1" }), false, "DNT is respected");
	assert.equal(effectiveTelemetryEnabled(readTelemetryState(stateFile), { COZYCLAY_TELEMETRY: "0" }), false);
	assert.equal(effectiveTelemetryEnabled(readTelemetryState(stateFile), {}), true);
	const reenabled = takeRuntimeTelemetryConfig(stateFile, {
		appVersion: "1.5.0",
		env: {},
		randomUUID: () => "018f0d66-3a4b-7c2d-8e9f-aaaaaaaaaaaa",
	});
	assert.notEqual(reenabled.installationId, installationId, "reenabling telemetry creates a new anonymous identity");
	const second = takeRuntimeTelemetryConfig(join(directory, "second.json"), { appVersion: "1.5.0", env: {} });
	assert.notEqual(reenabled.installationId, second.installationId, "independent state files get different identities");
	assert.equal(
		takeRuntimeTelemetryConfig(stateFile, {
			appVersion: "1.5.0",
			env: { DO_NOT_TRACK: "1" },
		}).installationId,
		null,
		"a temporary environment opt-out does not expose the stored id to the browser",
	);
	assert.equal(
		takeRuntimeTelemetryConfig(stateFile, {
			appVersion: "1.5.0",
			officialPackage: false,
			env: {},
			now: () => now,
			randomUUID: () => "should-not-be-used",
		}).telemetryEnabled,
		false,
		"a source checkout cannot capture even through the package launcher",
	);

	writeFileSync(stateFile, "{ broken json");
	assert.deepEqual(
		readTelemetryState(stateFile),
		{ installationId: null, telemetryEnabled: false, internalQa: false, firstLaunchedAt: null, noticeVersion: 0, firstLaunchHeardFrom: null },
		"a corrupt state file fails closed without resurrecting telemetry",
	);
	writeFileSync(stateFile, JSON.stringify({ installationId: "person@example.com" }));
	assert.equal(readTelemetryState(stateFile).installationId, null, "a hostile state file cannot turn PII into a distinct id");
	writeFileSync(stateFile, JSON.stringify({ internalQa: "yes", telemetryEnabled: "yes" }));
	assert.deepEqual(readTelemetryState(stateFile), {
		installationId: null,
		telemetryEnabled: true,
		internalQa: false,
		firstLaunchedAt: null,
		noticeVersion: 0,
		firstLaunchHeardFrom: null,
	}, "malformed booleans are sanitized rather than truthy-coerced");

	const cliHome = join(directory, "xdg");
	const cli = (args) => spawnSync(process.execPath, ["bin/cozyclay.mjs", ...args], {
		cwd: new URL("..", import.meta.url),
		env: { ...process.env, XDG_CONFIG_HOME: cliHome },
		encoding: "utf8",
	});
	const internalOn = cli(["telemetry", "internal", "on"]);
	assert.equal(internalOn.status, 0, internalOn.stderr);
	const cliState = join(cliHome, "cozyclay", "state.json");
	assert.equal(readTelemetryState(cliState).internalQa, true);
	const beforeInvalid = readFileSync(cliState, "utf8");
	const invalid = cli(["telemetry", "internal", "maybe"]);
	assert.notEqual(invalid.status, 0);
	assert.equal(readFileSync(cliState, "utf8"), beforeInvalid, "invalid CLI arguments do not mutate state");
	for (const args of [["telemetry", "internal"], ["telemetry", "internal", "on", "extra"], ["telemetry", "off", "extra"]]) {
		assert.notEqual(cli(args).status, 0);
		assert.equal(readFileSync(cliState, "utf8"), beforeInvalid);
	}
	assert.equal(cli(["telemetry", "status"]).status, 0);
	assert.equal(readFileSync(cliState, "utf8"), beforeInvalid, "status is read-only");
	assert.equal(cli(["telemetry", "off"]).status, 0);
	assert.equal(cli(["telemetry", "internal", "on"]).status, 0);
	assert.equal(readTelemetryState(cliState).telemetryEnabled, false, "internal on does not enable collection");
	assert.equal(takeRuntimeTelemetryConfig(cliState, { env: {} }).installationId, null);
	assert.equal(cli(["telemetry", "internal", "off"]).status, 0);
	assert.equal(readTelemetryState(cliState).internalQa, false);
	assert.equal(readTelemetryState(cliState).telemetryEnabled, false, "internal off preserves consent");
	assert.equal(cli(["telemetry", "on"]).status, 0);
	assert.equal(readTelemetryState(cliState).telemetryEnabled, true);
	assert.equal(readTelemetryState(cliState).installationId, null, "on creates an ID only when the app next launches");
	setTelemetryInternalQa(cliState, true);
	for (const options of [{ env: { CI: "1" } }, { env: { COZYCLAY_TELEMETRY: "0" } }, { env: {}, officialPackage: false }]) {
		const suppressed = takeRuntimeTelemetryConfig(cliState, options);
		assert.equal(suppressed.telemetryEnabled, false);
		assert.equal(suppressed.internalQa, false);
		assert.equal(suppressed.installationId, null);
	}

	console.log("all telemetry state checks PASS");
} finally {
	rmSync(directory, { recursive: true, force: true });
}
