#!/usr/bin/env node
/**
 * Regression coverage for the palette detector's take-level diagnostics.
 *
 * The real detector and numpy live on the GPU box, so this test executes the
 * small instrumentation hook with a deterministic runner fixture.  It checks
 * the numbers users need to diagnose a bad mask: frame hit rate, missing-frame
 * runs, and how much of each image the selected mask covers.  A runner that
 * does not expose the palette hook must remain explicitly unavailable rather
 * than making up zero-valued measurements.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("../../tools/ardy/cclay_gvhmr_worker.py", import.meta.url));
const fixture = String.raw`
import importlib.util, json, sys

spec = importlib.util.spec_from_file_location("worker", sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

# Minimal numpy surface used by install_palette_metrics().  Keeping the test
# dependency-free means it also runs on the browser/CI host, without the GPU
# environment that owns the actual detector.
class Array:
    def __init__(self, values=(), size=None):
        self.values = list(values)
        self.size = len(self.values) if size is None else size
    def sum(self):
        return sum(self.values)
    def __getitem__(self, index):
        return self.values[index]
    def __iter__(self):
        return iter(self.values)
    def __getitem__(self, index):
        return self.values[index]

class Vector(Array):
    def astype(self, _dtype): return self
    def tolist(self): return list(self.values)
    def _binary(self, other, op):
        if isinstance(other, Vector): other = other.values
        if not isinstance(other, (list, tuple)): other = [other] * len(self.values)
        return Vector([op(a, b) for a, b in zip(self.values, other)])
    def __sub__(self, other): return self._binary(other, lambda a, b: a - b)
    def __rsub__(self, other): return self._binary(other, lambda a, b: b - a)
    def __add__(self, other): return self._binary(other, lambda a, b: a + b)
    def __radd__(self, other): return self.__add__(other)
    def __mod__(self, other): return self._binary(other, lambda a, b: a % b)
    def __rmod__(self, other): return self._binary(other, lambda a, b: b % a)

class HuePlane:
    def __init__(self, values): self.values = values
    def __mul__(self, scale): return HuePlane([[v * scale for v in row] for row in self.values])
    def __getitem__(self, key):
        ys, xs = key
        return Vector([self.values[y][x] for y, x in zip(ys, xs)])

class HSV:
    def __init__(self, values): self.values = values
    def astype(self, _dtype): return self
    def __getitem__(self, _key): return HuePlane(self.values)

class Mask(Array):
    def __init__(self, values, coords, size):
        super().__init__(values, size=size); self.coords = coords

class HueCV2:
    COLOR_BGR2HSV = 0
    def cvtColor(self, frame, _code): return HSV(frame["hues"])

class Numpy:
    float64 = object()
    float32 = object()
    int32 = object()
    def asarray(self, values, dtype=None):
        return Array(values)
    def nonzero(self, mask):
        ys, xs = zip(*mask.coords) if mask.coords else ([], [])
        return list(ys), list(xs)
    def abs(self, values): return Vector([abs(value) for value in values.values])
    def quantile(self, values, q):
        values = sorted(values.values)
        if not values: return None
        at = (len(values) - 1) * q
        low = int(at)
        high = min(low + 1, len(values) - 1)
        return values[low] * (1 - (at - low)) + values[high] * (at - low)

class Runner:
    np = Numpy()
    class CV2:
        COLOR_BGR2HSV = 0
        def cvtColor(self, _frame, _code):
            return self
        def astype(self, _dtype):
            return self
        def __getitem__(self, _key):
            return 0
    cv2 = CV2()
    # Empty palette deliberately keeps hue-error optional in this fixture; the
    # area/hit diagnostics are independent of colour conversion.
    PALETTE_HUES = ()
    def __init__(self):
        self.original_mask = lambda frame: self.mask_for(frame)
        self.original_bbx = self.boxes_for
        self.palette_mask = self.original_mask
        self.palette_bbx = self.original_bbx
    def mask_for(self, frame):
        count = [2, 4, 0, 4, 2][frame["index"]]
        mask = Array([1] * count + [0] * (10 - count), size=10)
        # Two hue masks split the selected pixels; their sum is the coloured
        # coverage reported alongside total mask coverage.
        left = count // 2
        return mask, [Array([1] * left), Array([1] * (count - left))]
    def boxes_for(self, _video, _length):
        # Invoke the installed wrapper once per source frame.  Frame 2 is the
        # only miss in a five-frame take, producing one one-frame gap.
        for index in range(5):
            self.palette_mask({"index": index})
        return [], [0, 1, 3, 4], 5

# Missing upstream hooks are not an all-zero take: callers must be able to
# distinguish “not measured” from “measured and empty”.
bare_report, bare_reset, bare_restore = worker.install_palette_metrics(object())
assert bare_report()["available"] is False
assert bare_report()["reason"] == "segmentation-hooks-unavailable"
bare_reset(); bare_restore()

runner = Runner()
report, reset, restore = worker.install_palette_metrics(runner)
runner.palette_bbx("fixture.mp4", 5)
stats = report()
assert stats["detector"] == "palette"
assert stats["frames"] == 5
assert stats["detectedFrames"] == 4
assert stats["detectionRate"] == 0.8
assert stats["missingFrames"] == 1
assert stats["gapCount"] == 1
assert stats["longestGapFrames"] == 1
assert stats["coverage"]["min"] == 0
assert abs(stats["coverage"]["mean"] - 0.2) < 1e-9
assert abs(stats["coverage"]["p10"] - 0.08) < 1e-9
assert abs(stats["coverage"]["p90"] - 0.4) < 1e-9
assert abs(stats["coverage"]["colouredMean"] - 0.2) < 1e-9
assert stats["parts"]["mean"] == 2
assert stats["parts"]["min"] == 0
assert stats["perFrame"][2]["coverage"] == 0
assert stats["hueErrorDeg"] == {"mean": None, "p95": None, "max": None}

# Hue drift is measured against the part's own palette centre.  The first
# part below is observed at 100° while its centre is 10°; a nearest-centre
# implementation would incorrectly report zero by borrowing the second part's
# 100° centre.
class HueRunner:
    np = Numpy()
    cv2 = HueCV2()
    PALETTE_HUES = (10, 100)
    def __init__(self):
        self.palette_mask = self.mask_for
        self.palette_bbx = self.boxes_for
    def mask_for(self, _frame):
        coords = [(0, 0), (0, 1), (1, 0), (1, 1)]
        mask = Mask([1, 1, 1, 1], coords, 4)
        return mask, [Mask([1, 1], [coords[0], coords[2]], 4), Mask([1, 1], [coords[1], coords[3]], 4)]
    def boxes_for(self, _video, _length):
        # OpenCV stores hue on a 0..179 scale; the hook converts it to degrees
        # by multiplying by two.  50 therefore becomes 100 degrees here.
        self.palette_mask({"hues": [[50, 50], [50, 50]]})
        return [], [0], 1

hue_runner = HueRunner()
hue_report, _, hue_restore = worker.install_palette_metrics(hue_runner)
hue_runner.palette_bbx("fixture.mp4", 1)
hue_stats = hue_report()
assert hue_stats["hueErrorDeg"]["max"] == 90
assert hue_stats["hueErrorDeg"]["p95"] >= 80
hue_restore()

# Instrumentation is reversible and resettable, so a persistent worker cannot
# leak one take's counters into the next take.
assert runner.palette_mask is not runner.original_mask
reset()
assert report()["frames"] == 0
restore()
assert runner.palette_mask is runner.original_mask
assert runner.palette_bbx is runner.original_bbx
print(json.dumps({"stats": stats}))
`;

const result = spawnSync("python3", ["-c", fixture, worker], { encoding: "utf8" });
assert.equal(result.status, 0, result.stderr || result.stdout);
const { stats } = JSON.parse(result.stdout.trim());
assert.equal(stats.detectionRate, 0.8);
assert.equal(stats.longestGapFrames, 1);
console.log("PASS palette segmentation diagnostics measure coverage, hit rate, and dropout gaps; unavailable hooks stay explicit");
