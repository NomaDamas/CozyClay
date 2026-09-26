import { motionPreflightReason } from "./analytics.js";

/** Return the line-edit capability advertised by the structured health payload. */
export function hasLineEditCapability(health) {
	if (health?.ok !== true) return false;
	const capabilities = health.capabilities ?? health.features;
	return Array.isArray(capabilities) ? capabilities.includes("lineEdit") : capabilities?.lineEdit === true;
}

/**
 * Decide whether the hosted demo take may be seeded onto the stage. The seed
 * is for a session with no bridge (the hosted demo). The first healthy probe
 * latches `bridgeSeenOk`: after it, a failed probe is a blip, not "no bridge",
 * and must never load the demo take onto the character.
 */
export function demoSeedGate(health, bridgeSeenOk = false) {
	const seenOk = bridgeSeenOk || Boolean(health?.ok);
	return { bridgeSeenOk: seenOk, seed: Boolean(health) && !health.ok && !seenOk };
}

/**
 * Derive the generation affordance state from bridge health and request shape.
 * Health is deliberately interpreted through the analytics preflight contract;
 * error prose is never used to classify a route.
 */
export function motionReadiness(health, options = {}) {
	if (health === null || health === undefined) return "loading";
	const lineEditSupported = Object.prototype.hasOwnProperty.call(options, "lineEditSupported")
		? options.lineEditSupported === true
		: hasLineEditCapability(health);
	const reason = motionPreflightReason(health, {
		body: options.body ?? {},
		lineEditSupported,
	});
	if (reason === null) return "ready";
	if (reason === "unconfigured") return "not_configured";
	if (reason === "unreachable") return "unavailable";
	if (reason === "unsupported_route") return "unsupported_route";
	return "unavailable";
}
