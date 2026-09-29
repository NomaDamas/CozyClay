/** Choose the safe ladder fallback for the supplied endpoint poses. */
export function fallbackStep(endpoints) {
	const hasTwo = Array.isArray(endpoints)
		? endpoints.length >= 2
		: Boolean(endpoints && endpoints.a && endpoints.b);
	return hasTwo ? "Gbest" : "G5";
}
