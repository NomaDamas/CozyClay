/**
 * A monotone piecewise cubic through authored knots (harmonic-mean tangents,
 * Fritsch–Carlson family): it hits every knot exactly, never overshoots between
 * two of them, runs flat across a local extremum and degrades to the exact
 * straight lerp for two knots. The camera crane's height profile and a route's
 * lean (bank / pitch) marks share it, so a dot means the same thing on both rails.
 *
 * @param {object[]} knots ascending by `t`; at least one
 * @param {number} x position along the profile (clamped to the knots' span)
 * @param {(knot: object) => number} read the knot's value; defaults to `knot.v`
 */
export function monotoneCubicAt(knots, x, read = (knot) => knot.v) {
	const last = knots.length - 1;
	const clamped = Math.max(knots[0].t, Math.min(knots[last].t, x));
	if (clamped <= knots[0].t) return read(knots[0]);
	if (clamped >= knots[last].t) return read(knots[last]);
	let i = 0;
	while (i < knots.length - 2 && clamped > knots[i + 1].t) i += 1;
	const p0 = knots[i];
	const p1 = knots[i + 1];
	const h = p1.t - p0.t;
	if (h < 1e-9) return read(p1);
	const v0 = read(p0);
	const v1 = read(p1);
	const secant = (a, b) => (read(b) - read(a)) / Math.max(b.t - a.t, 1e-9);
	const d = secant(p0, p1);
	// harmonic mean of neighbouring secants; zero across a local extremum
	const mono = (sa, sb) => (sa * sb <= 0 ? 0 : (2 * sa * sb) / (sa + sb));
	const m0 = i > 0 ? mono(secant(knots[i - 1], p0), d) : d;
	const m1 = i < knots.length - 2 ? mono(d, secant(p1, knots[i + 2])) : d;
	const u = (clamped - p0.t) / h;
	const u2 = u * u;
	const u3 = u2 * u;
	return (
		(2 * u3 - 3 * u2 + 1) * v0 +
		(u3 - 2 * u2 + u) * h * m0 +
		(-2 * u3 + 3 * u2) * v1 +
		(u3 - u2) * h * m1
	);
}
