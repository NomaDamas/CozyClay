// motion.compile's stop-rule counter: how many compiles in a row (per character) did not lower QA problems below the best so far.
// The 90-run bench spent 36-42% of its rounds without improvement; at 2 the prompts say to install the best take and stop.
// A compile of a whole new spec (no base) starts the count over.
export function createRoundWatch() {
	const byCharacter = new Map();
	return (characterId, qa, fresh) => {
		const problems = qa?.problems ?? qa?.total ?? qa?.groups?.length ?? 0;
		const seen = fresh ? null : byCharacter.get(characterId);
		const next = !seen || problems < seen.best ? { best: problems, rounds: 0 } : { best: seen.best, rounds: seen.rounds + 1 };
		byCharacter.set(characterId, next);
		return next.rounds;
	};
}
