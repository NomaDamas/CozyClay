import { useRef, useState } from "react";
import { createSemanticState } from "./semantic-edit.js";

/** Explicit passive and authored setters for the same committed state owner. */
export function useSemanticState(initial, observe, domain) {
	const [value, publish] = useState(initial);
	const owner = useRef(null);
	const observer = useRef(observe);
	observer.current = observe;
	if (!owner.current) owner.current = createSemanticState(value, publish, (...args) => observer.current(...args), domain);
	return [value, owner.current.set, owner.current.edit];
}
