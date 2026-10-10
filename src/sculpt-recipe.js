/**
 * Sculpt recipes: a clay prop described as data.
 *
 * A `sculpt` object carries a recipe of soft parts instead of a mesh file, so an
 * agent can build a prop from a reference image without anything it writes
 * being executed. This module is the pure half: it owns the schema, refuses
 * what it cannot draw, expands mirrors and parent chains into object-frame
 * transforms, and measures the standing box. It is importable without three.js
 * so the scene record, the MCP server and the tests all read one truth.
 *
 * A recipe that breaks a rule is REFUSED with the reason, never clamped into a
 * different shape: an agent that asked for a 40 m head should hear why, not
 * see a 20 m one and believe it.
 *
 * Contract: docs/sculpt-from-image.md.
 */

export const SCULPT_RECIPE_VERSION = 1;
export const SCULPT_SHAPES = Object.freeze(["blob", "box", "cylinder", "torus", "frame"]);
export const SCULPT_LIMITS = Object.freeze({
	/** after mirrors are expanded */
	maxParts: 48,
	minExtent: 0.005,
	maxExtent: 20,
	maxOffset: 20,
	maxDepth: 8,
});
export const SCULPT_DEFAULT_COLOR = "#c2c6c8";
/** The suffix a mirrored copy's id gets. `.` is outside the id alphabet, so a
 * copy can never collide with an authored part. */
export const SCULPT_MIRROR_SUFFIX = ".mirror";
const MIN_HEIGHT = 0.05;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HEX_SHORT = /^#?([0-9a-f]{3})$/i;
const HEX_LONG = /^#?([0-9a-f]{6})$/i;
const PART_KEYS = new Set(["id", "shape", "size", "position", "rotation", "color", "parent", "mirror", "roundness", "taper", "border"]);
const SHAPE_KEYS = {
	blob: new Set(["roundness", "taper"]),
	box: new Set(["roundness"]),
	cylinder: new Set(["taper"]),
	torus: new Set(),
	frame: new Set(["border"]),
};
const DEFAULT_ROUNDNESS = { blob: 0.5, box: 0.1 };

const tidy = (value) => {
	const rounded = Math.round(value * 1e4) / 1e4;
	return rounded === 0 ? 0 : rounded;
};
const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const wrapDegrees = (deg) => {
	const wrapped = ((((deg + 180) % 360) + 360) % 360) - 180;
	return wrapped === -180 ? 180 : wrapped;
};

class RecipeError extends Error {
	constructor(path, message) {
		super(`${path}: ${message}`);
		this.path = path;
	}
}

function readColor(value, path) {
	if (value === undefined) return SCULPT_DEFAULT_COLOR;
	const text = typeof value === "string" ? value.trim() : "";
	const short = HEX_SHORT.exec(text);
	if (short) return `#${short[1].toLowerCase().replace(/./g, (digit) => digit + digit)}`;
	const long = HEX_LONG.exec(text);
	if (long) return `#${long[1].toLowerCase()}`;
	throw new RecipeError(path, `colour must be #rgb or #rrggbb, got ${JSON.stringify(value)}`);
}

function readVector(value, path, fallback, check) {
	if (value === undefined && fallback) return [...fallback];
	if (!Array.isArray(value) || value.length !== 3 || !value.every(isFiniteNumber)) {
		throw new RecipeError(path, `must be three numbers [x, y, z], got ${JSON.stringify(value)}`);
	}
	value.forEach((component, axis) => check(component, `${path}[${axis}]`));
	return value.map(tidy);
}

function readUnit(value, path, fallback, min, max) {
	if (value === undefined) return fallback;
	if (!isFiniteNumber(value) || value < min || value > max) {
		throw new RecipeError(path, `must be a number from ${min} to ${max}, got ${JSON.stringify(value)}`);
	}
	return tidy(value);
}

function normalizePart(raw, index) {
	const at = `parts[${index}]`;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RecipeError(at, "must be an object");
	for (const key of Object.keys(raw)) {
		if (!PART_KEYS.has(key)) throw new RecipeError(`${at}.${key}`, `unknown key (allowed: ${[...PART_KEYS].join(", ")})`);
	}
	if (typeof raw.id !== "string" || !ID_PATTERN.test(raw.id)) {
		throw new RecipeError(`${at}.id`, `must be 1-40 characters of a-z, 0-9 and -, starting with a letter or digit; got ${JSON.stringify(raw.id)}`);
	}
	const where = `parts[${raw.id}]`;
	if (!SCULPT_SHAPES.includes(raw.shape)) {
		throw new RecipeError(`${where}.shape`, `must be one of ${SCULPT_SHAPES.join(", ")}; got ${JSON.stringify(raw.shape)}`);
	}
	for (const key of ["roundness", "taper", "border"]) {
		if (raw[key] !== undefined && !SHAPE_KEYS[raw.shape].has(key)) {
			throw new RecipeError(`${where}.${key}`, `does not apply to a ${raw.shape}`);
		}
	}
	const size = readVector(raw.size, `${where}.size`, null, (value, path) => {
		if (value < SCULPT_LIMITS.minExtent || value > SCULPT_LIMITS.maxExtent) {
			throw new RecipeError(path, `extent must be ${SCULPT_LIMITS.minExtent}-${SCULPT_LIMITS.maxExtent} m, got ${value}`);
		}
	});
	const position = readVector(raw.position, `${where}.position`, [0, 0, 0], (value, path) => {
		if (Math.abs(value) > SCULPT_LIMITS.maxOffset) throw new RecipeError(path, `must be within ±${SCULPT_LIMITS.maxOffset} m, got ${value}`);
	});
	const rotation = readVector(raw.rotation, `${where}.rotation`, [0, 0, 0], () => {}).map((deg) => tidy(wrapDegrees(deg)));
	if (raw.parent !== undefined && (typeof raw.parent !== "string" || !raw.parent)) {
		throw new RecipeError(`${where}.parent`, "must be another part's id");
	}
	if (raw.mirror !== undefined && typeof raw.mirror !== "boolean") throw new RecipeError(`${where}.mirror`, "must be true or false");
	const part = {
		id: raw.id,
		shape: raw.shape,
		size,
		position,
		rotation,
		color: readColor(raw.color, `${where}.color`),
	};
	if (raw.parent !== undefined) part.parent = raw.parent;
	if (raw.mirror === true) part.mirror = true;
	if (SHAPE_KEYS[raw.shape].has("roundness")) part.roundness = readUnit(raw.roundness, `${where}.roundness`, DEFAULT_ROUNDNESS[raw.shape], 0, 1);
	if (SHAPE_KEYS[raw.shape].has("taper")) part.taper = readUnit(raw.taper, `${where}.taper`, 0, -1, 1);
	if (raw.shape === "frame") {
		const limit = Math.min(size[0], size[1]) / 2;
		const fallback = tidy(Math.min(size[0], size[1]) * 0.15);
		const border = raw.border === undefined ? fallback : raw.border;
		if (!isFiniteNumber(border) || border <= 0 || border >= limit) {
			throw new RecipeError(`${where}.border`, `must be above 0 and below half the frame's smaller side (${tidy(limit)} m), got ${JSON.stringify(raw.border)}`);
		}
		part.border = tidy(border);
	}
	if (raw.shape === "torus" && size[2] >= Math.min(size[0], size[1])) {
		throw new RecipeError(`${where}.size`, "a torus's tube (size[2]) must be thinner than its outer diameter");
	}
	return part;
}

/** Depth of every part in the parent forest, refusing unknown parents and cycles. */
function partDepths(parts) {
	const byId = new Map(parts.map((part) => [part.id, part]));
	const depths = new Map();
	const depthOf = (part, trail) => {
		if (depths.has(part.id)) return depths.get(part.id);
		if (!part.parent) {
			depths.set(part.id, 0);
			return 0;
		}
		const parent = byId.get(part.parent);
		if (!parent) throw new RecipeError(`parts[${part.id}].parent`, `no part named "${part.parent}"`);
		if (trail.has(parent.id)) throw new RecipeError(`parts[${part.id}].parent`, "parents form a cycle");
		const depth = depthOf(parent, new Set([...trail, part.id])) + 1;
		if (depth > SCULPT_LIMITS.maxDepth) throw new RecipeError(`parts[${part.id}].parent`, `parent chain is deeper than ${SCULPT_LIMITS.maxDepth}`);
		depths.set(part.id, depth);
		return depth;
	};
	for (const part of parts) depthOf(part, new Set([part.id]));
	// A mirror inside a mirrored subtree would mint the same `.mirror` id twice.
	for (const part of parts) {
		if (!part.mirror) continue;
		for (let up = byId.get(part.parent); up; up = byId.get(up.parent)) {
			if (up.mirror) throw new RecipeError(`parts[${part.id}].mirror`, `"${up.id}" above it is already mirrored, which copies this part too`);
		}
	}
	return depths;
}

/**
 * The recipe as the record stores it, or the reason it cannot be drawn.
 * Returns `{ ok: true, recipe }` or `{ ok: false, error, path }`; never throws.
 */
export function normalizeSculptRecipe(input) {
	try {
		if (!input || typeof input !== "object" || Array.isArray(input)) throw new RecipeError("recipe", "must be an object with a parts array");
		for (const key of Object.keys(input)) {
			if (key !== "version" && key !== "parts") throw new RecipeError(`recipe.${key}`, "unknown key (allowed: version, parts)");
		}
		if (input.version !== undefined && input.version !== SCULPT_RECIPE_VERSION) {
			throw new RecipeError("recipe.version", `only version ${SCULPT_RECIPE_VERSION} is understood, got ${JSON.stringify(input.version)}`);
		}
		if (!Array.isArray(input.parts) || input.parts.length === 0) throw new RecipeError("recipe.parts", "must be a non-empty array");
		const parts = input.parts.map(normalizePart);
		const seen = new Set();
		for (const part of parts) {
			if (seen.has(part.id)) throw new RecipeError(`parts[${part.id}].id`, "is used twice");
			seen.add(part.id);
		}
		partDepths(parts);
		const recipe = { version: SCULPT_RECIPE_VERSION, parts };
		const count = expandSculptParts(recipe).length;
		if (count > SCULPT_LIMITS.maxParts) {
			throw new RecipeError("recipe.parts", `expands to ${count} parts with mirrors; the limit is ${SCULPT_LIMITS.maxParts}`);
		}
		return { ok: true, recipe };
	} catch (error) {
		if (error instanceof RecipeError) return { ok: false, error: error.message, path: error.path };
		throw error;
	}
}

const DEG = Math.PI / 180;

/** Column-major 4x4, three.js layout, so the geometry side can hand it to
 * Matrix4.fromArray without a transpose. Rotation order XYZ, three's default. */
function composeMatrix(position, rotationDeg) {
	const [x, y, z] = rotationDeg.map((deg) => deg * DEG);
	const a = Math.cos(x), b = Math.sin(x);
	const c = Math.cos(y), d = Math.sin(y);
	const e = Math.cos(z), f = Math.sin(z);
	const ae = a * e, af = a * f, be = b * e, bf = b * f;
	return [
		c * e, af + be * d, bf - ae * d, 0,
		-c * f, ae - bf * d, be + af * d, 0,
		d, -b * c, a * c, 0,
		position[0], position[1], position[2], 1,
	];
}

function multiply(m, n) {
	const out = new Array(16);
	for (let col = 0; col < 4; col += 1) {
		for (let row = 0; row < 4; row += 1) {
			let sum = 0;
			for (let k = 0; k < 4; k += 1) sum += m[k * 4 + row] * n[col * 4 + k];
			out[col * 4 + row] = sum;
		}
	}
	return out;
}

function applyMatrix(m, [x, y, z]) {
	return [
		m[0] * x + m[4] * y + m[8] * z + m[12],
		m[1] * x + m[5] * y + m[9] * z + m[13],
		m[2] * x + m[6] * y + m[10] * z + m[14],
	];
}

/** A reflection across x = 0 of the parent frame keeps the part's shape and
 * negates the lateral axis only: position.x flips, and the yaw and roll turn
 * the other way. All five shapes are symmetric about their own x, so no
 * negative scale (and no winding flip) is needed. */
function mirroredPart(part, parentId) {
	const copy = {
		...part,
		id: `${part.id}${SCULPT_MIRROR_SUFFIX}`,
		position: [tidy(-part.position[0]), part.position[1], part.position[2]],
		rotation: [part.rotation[0], tidy(-part.rotation[1]), tidy(-part.rotation[2])],
	};
	delete copy.mirror;
	if (parentId !== undefined) copy.parent = parentId;
	return copy;
}

/**
 * Every part that will be drawn, in parent-before-child order, with its
 * object-frame `matrix`. A mirrored part brings its whole subtree with it:
 * a pupil on a mirrored eye shows up in both eyes.
 */
export function expandSculptParts(recipe) {
	const parts = recipe.parts;
	const children = new Map();
	for (const part of parts) {
		const key = part.parent ?? "";
		if (!children.has(key)) children.set(key, []);
		children.get(key).push(part);
	}
	const out = [];
	const visit = (part, parentMatrix, idPrefixParent, reflect) => {
		const placed = reflect ? mirroredPart(part, idPrefixParent) : idPrefixParent !== undefined ? { ...part, parent: idPrefixParent } : { ...part };
		const matrix = multiply(parentMatrix, composeMatrix(placed.position, placed.rotation));
		out.push({ ...placed, matrix });
		for (const child of children.get(part.id) ?? []) visit(child, matrix, placed.id, reflect);
		if (part.mirror && !reflect) {
			const mirror = mirroredPart(part, idPrefixParent);
			const mirrorMatrix = multiply(parentMatrix, composeMatrix(mirror.position, mirror.rotation));
			out.push({ ...mirror, matrix: mirrorMatrix });
			for (const child of children.get(part.id) ?? []) visit(child, mirrorMatrix, mirror.id, true);
		}
	};
	const identity = composeMatrix([0, 0, 0], [0, 0, 0]);
	for (const root of children.get("") ?? []) visit(root, identity, undefined, false);
	return out;
}

/** The part's own box, in its local frame, as eight corners. A tapered blob
 * or cylinder never grows past its declared size, so the box stays honest. */
function localCorners(part) {
	const [sx, sy, sz] = part.size.map((value) => value / 2);
	const corners = [];
	for (const x of [-sx, sx]) for (const y of [-sy, sy]) for (const z of [-sz, sz]) corners.push([x, y, z]);
	return corners;
}

export function sculptBounds(recipe) {
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (const part of expandSculptParts(recipe)) {
		for (const corner of localCorners(part)) {
			const point = applyMatrix(part.matrix, corner);
			for (let axis = 0; axis < 3; axis += 1) {
				min[axis] = Math.min(min[axis], point[axis]);
				max[axis] = Math.max(max[axis], point[axis]);
			}
		}
	}
	return { min: min.map(tidy), max: max.map(tidy) };
}

/**
 * The standing box the scene record stores: a footprint centred on the object
 * origin (the plan board and the blockers assume a centred rectangle, so an
 * off-centre recipe gets the conservative box that contains it) and the
 * height of the highest point above the floor.
 */
export function sculptStandingBox(recipe) {
	const { min, max } = sculptBounds(recipe);
	return {
		footprint: {
			width: tidy(Math.max(SCULPT_LIMITS.minExtent, 2 * Math.max(Math.abs(min[0]), Math.abs(max[0])))),
			depth: tidy(Math.max(SCULPT_LIMITS.minExtent, 2 * Math.max(Math.abs(min[2]), Math.abs(max[2])))),
		},
		height: tidy(Math.max(MIN_HEIGHT, max[1])),
	};
}
