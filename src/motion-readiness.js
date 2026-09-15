import { motionPreflightReason } from "./analytics.js";

/** Return the line-edit capability advertised by the structured health payload. */
export function hasLineEditCapability(health) {
	if (health?.ok !== true) return false;
	const capabilities = health.capabilities ?? health.features;
	return Array.isArray(capabilities) ? capabilities.includes("lineEdit") : capabilities?.lineEdit === true;
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
