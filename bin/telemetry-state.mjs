import { randomUUID as nodeRandomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const TELEMETRY_NOTICE_VERSION = 1;
export const POSTHOG_PROJECT_TOKEN = "phc_CpizzZ8VhSorSS8yEeQhdpUcvB2erp5xkCbnFD8HTJ5m";
export const POSTHOG_API_HOST = "https://t.cozyclay.org";

const DEFAULT_STATE = Object.freeze({
	installationId: null,
	telemetryEnabled: true,
	firstLaunchedAt: null,
	noticeVersion: 0,
	firstLaunchHeardFrom: null,
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rawState(stateFile) {
	try {
		const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch (error) {
		return error?.code === "ENOENT" ? {} : { telemetryEnabled: false };
	}
}

function normalizedState(value) {
	return {
		installationId: typeof value.installationId === "string" && UUID_PATTERN.test(value.installationId)
			? value.installationId
			: null,
		telemetryEnabled: value.telemetryEnabled !== false,
		firstLaunchedAt: typeof value.telemetryFirstLaunchedAt === "string"
			? value.telemetryFirstLaunchedAt
			: null,
		noticeVersion: Number.isInteger(value.telemetryNoticeVersion)
			? value.telemetryNoticeVersion
			: 0,
		firstLaunchHeardFrom: ["x", "hn", "reddit", "github", "friend", "other"].includes(value.telemetryFirstLaunchHeardFrom)
			? value.telemetryFirstLaunchHeardFrom
			: null,
	};
}

function writeState(stateFile, patch) {
	const next = { ...rawState(stateFile), ...patch };
	mkdirSync(dirname(stateFile), { recursive: true });
	const temporary = `${stateFile}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(next, null, "\t"), { mode: 0o600 });
	renameSync(temporary, stateFile);
}

function envDisablesTelemetry(env) {
	if (env.CI && !/^(0|false|no|off)$/i.test(env.CI)) return true;
	if (/^(1|true|yes|on)$/i.test(env.DO_NOT_TRACK ?? "")) return true;
	return /^(0|false|no|off)$/i.test(env.COZYCLAY_TELEMETRY ?? "");
}

export function readTelemetryState(stateFile) {
	return normalizedState(rawState(stateFile));
}

export function effectiveTelemetryEnabled(state, env = process.env) {
	return state.telemetryEnabled && !envDisablesTelemetry(env);
}

export function setTelemetryEnabled(stateFile, enabled) {
	writeState(stateFile, {
		telemetryEnabled: enabled === true,
		...(enabled === true ? {} : { installationId: null }),
	});
	return readTelemetryState(stateFile);
}

export function markTelemetryNoticeShown(stateFile) {
	writeState(stateFile, { telemetryNoticeVersion: TELEMETRY_NOTICE_VERSION });
}

export function markTelemetryFirstLaunch(stateFile, now = () => new Date().toISOString()) {
	if (readTelemetryState(stateFile).firstLaunchedAt) return;
	writeState(stateFile, { telemetryFirstLaunchedAt: now() });
}

export function setTelemetryFirstLaunchSource(stateFile, heardFrom) {
	if (!["x", "hn", "reddit", "github", "friend", "other"].includes(heardFrom)) return readTelemetryState(stateFile);
	writeState(stateFile, { telemetryFirstLaunchHeardFrom: heardFrom });
	return readTelemetryState(stateFile);
}

export function takeRuntimeTelemetryConfig(
	stateFile,
	{
		appVersion,
		officialPackage = true,
		installKind = null,
		env = process.env,
		now = () => new Date().toISOString(),
		randomUUID = nodeRandomUUID,
	} = {},
) {
	const existing = readTelemetryState(stateFile);
	const telemetryEnabled = officialPackage && effectiveTelemetryEnabled(existing, env);
	let installationId = existing.installationId;
	const firstLaunch = telemetryEnabled && !existing.firstLaunchedAt;
	const patch = {};

	if (telemetryEnabled && !installationId) {
		installationId = randomUUID();
		patch.installationId = installationId;
	}
	if (Object.keys(patch).length > 0) writeState(stateFile, patch);

	return {
		distribution: "npm",
		telemetryEnabled,
		installationId: telemetryEnabled ? installationId : null,
		appVersion,
		apiKey: POSTHOG_PROJECT_TOKEN,
		apiHost: POSTHOG_API_HOST,
		firstLaunch,
		firstLaunchHeardFrom: existing.firstLaunchHeardFrom,
		installKind: ["npx", "global", "clone"].includes(installKind)
			? installKind
			: env.npm_config_global === "true" || env.npm_config_global === true ? "global" : "npx",
	};
}
