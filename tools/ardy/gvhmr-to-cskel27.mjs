#!/usr/bin/env node
import { readNpz } from "../kimodo/read-npz.mjs";
import { motionArraysToNpzMembers, writeNpz } from "./npz.mjs";
import { smplToCskel27Motion } from "./smpl-cskel27.mjs";

const args = process.argv.slice(2);
const input = args[0], output = args[1];
let boneScale = "derive";
for (let i = 2; i < args.length; i += 1) {
	if (args[i] !== "--bone-scale" || i + 1 >= args.length) { console.error("usage: node tools/ardy/gvhmr-to-cskel27.mjs <gvhmr.npz> <motion.npz> [--bone-scale derive|number]"); process.exit(2); }
	const value = args[++i];
	if (value !== "derive") { boneScale = Number(value); if (!(Number.isFinite(boneScale) && boneScale > 0)) { console.error("--bone-scale must be derive or a positive number"); process.exit(2); } }
}
if (!input || !output) {
	console.error("usage: node tools/ardy/gvhmr-to-cskel27.mjs <gvhmr.npz> <motion.npz> [--bone-scale derive|number]");
	process.exit(2);
}

const motion = smplToCskel27Motion(readNpz(input), { boneScale });
writeNpz(output, motionArraysToNpzMembers(motion));
console.log(JSON.stringify({ output, frames: motion.frames, fps: motion.fps, boneScale }));
