#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	effectiveTelemetryEnabled,
	markTelemetryFirstLaunch,
	readTelemetryState,
	setTelemetryEnabled,
	takeRuntimeTelemetryConfig,
} from "../bin/telemetry-state.mjs";

const directory = mkdtempSync(join(tmpdir(), "cozyclay-telemetry-state-"));
const stateFile = join(directory, "state.json");
const installationId = "018f0d66-3a4b-7c2d-8e9f-123456789abc";
const now = "2026-08-24T14:00:00.000Z";

try {
	const initial = readTelemetryState(stateFile);
	assert.equal(initial.telemetryEnabled, true, "telemetry defaults on for the official package");
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
	assert.equal(effectiveTelemetryEnabled(readTelemetryState(stateFile), { CI: "1" }), false, "CI is always excluded");
	assert.equal(effectiveTelemetryEnabled(readTelemetryState(stateFile), { DO_NOT_TRACK: "1" }), false, "DNT is respected");
	assert.equal(effectiveTelemetryEnabled(readTelemetryState(stateFile), { COZYCLAY_TELEMETRY: "0" }), false);
	assert.equal(effectiveTelemetryEnabled(readTelemetryState(stateFile), {}), true);
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
		{ installationId: null, telemetryEnabled: false, firstLaunchedAt: null, noticeVersion: 0, firstLaunchHeardFrom: null },
		"a corrupt state file fails closed without resurrecting telemetry",
	);
	writeFileSync(stateFile, JSON.stringify({ installationId: "person@example.com" }));
	assert.equal(readTelemetryState(stateFile).installationId, null, "a hostile state file cannot turn PII into a distinct id");

	console.log("all telemetry state checks PASS");
} finally {
	rmSync(directory, { recursive: true, force: true });
}
