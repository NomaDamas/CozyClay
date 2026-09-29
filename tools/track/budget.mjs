/**
 * The tracker receives a wall-clock allowance shared by bench and production.
 * Keep this formula in one place so callers cannot drift apart.
 */
export function trackerBudgetMs(frames) {
	if (!Number.isInteger(frames) || frames < 0) throw new Error("frames must be a nonnegative integer");
	return Math.max(300000, 1500 * frames + 120000);
}
