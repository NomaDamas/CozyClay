// Who is running the command whose edit is being applied right now: "ui" (the
// user's own control), "agent" or "mcp". The command bus wraps each owned edit in
// withRunOrigin, so an observer of authored edits (post-turn-edits.js) can tell
// the user's edits from the agent's. Edits are synchronous inside a run; the
// origin is set only for that synchronous step and is null outside any run.
let current = null;

/** fn wrapped so that, while it runs, runOrigin() answers `origin`. */
export function withRunOrigin(origin, fn) {
	return (...args) => {
		const previous = current;
		current = origin;
		try { return fn(...args); } finally { current = previous; }
	};
}

export const runOrigin = () => current;
