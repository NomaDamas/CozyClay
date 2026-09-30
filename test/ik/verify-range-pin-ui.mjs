import { rangePinBandGeometry } from "../../src/ardy/timeline-coordinates.js";

let failures = 0;
function check(name, condition, detail = "") {
	if (condition) console.log(`PASS ${name}`);
	else {
		failures += 1;
		console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const close = (a, b) => Math.abs(a - b) < 1e-9;
const band = rangePinBandGeometry(
	{ startFrame: 21, endFrame: 29, blend: 6 },
	60,
	60,
);
check("range pin geometry keeps the inclusive frame endpoints", band?.startFrame === 21 && band?.endFrame === 29);
check("range pin geometry maps the band to the timeline", close(band?.startPct, 21 / 59) && close(band?.endPct, 29 / 59));
check("range pin geometry exposes faded blend ramps", close(band?.rampStartPct, 15 / 59) && close(band?.rampEndPct, 35 / 59));

const clamped = rangePinBandGeometry({ startFrame: -4, endFrame: 80, blend: 100 }, 10, 10);
check("range pin geometry clamps to the displayed clip", clamped?.startFrame === 0 && clamped?.endFrame === 9);
check("range pin geometry never leaves the timeline", clamped?.rampStartPct === 0 && clamped?.rampEndPct === 1);
check("range pin geometry refuses an invalid range", rangePinBandGeometry({ startFrame: 8, endFrame: 2, blend: 2 }, 10, 10) === null);

if (failures) {
	console.log(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall range pin UI checks passed");
