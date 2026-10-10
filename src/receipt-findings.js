// Findings an edit receipt reports beside its readback: a value the domain
// moved to stay inside its limits, so a request that did not land as asked is
// never silent.
const round = value => Number(value.toFixed(4));

/** One CLAMPED warning for an entity when any requested number differs from
 * the number the domain kept, or null. `requested` and `applied` are keyed by
 * the same channel names (x, y, z, scaleX, scale, ...). */
export function clampWarning(id, requested, applied) {
	const parts = [];
	for (const [key, asked] of Object.entries(requested)) {
		const kept = applied?.[key];
		if (!Number.isFinite(asked) || !Number.isFinite(kept) || Math.abs(asked - kept) < 1e-9) continue;
		const limit = asked < kept ? 'minimum' : 'maximum';
		parts.push(`${key} ${round(asked)}→${round(kept)} (${limit} ${round(kept)}${/^(x|y|z)$/.test(key) ? ' m' : ''})`);
	}
	if (!parts.length) return null;
	const message = [...`Clamped: ${parts.join('; ')}`];
	return { code: 'CLAMPED', id, message: message.length > 120 ? `${message.slice(0, 119).join('')}…` : message.join('') };
}
