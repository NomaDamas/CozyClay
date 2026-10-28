// The MotionBricks SOMA model (mixed FP16 ONNX, 380 MB) on onnxruntime-node, CPU. The weights are never committed:
// the first use downloads them from the upstream repository's Git LFS store into a cache directory and checks SHA-256.
// Licensed by NVIDIA Corporation under the NVIDIA Open Model Agreement (see NOTICE.md next to this file).
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MODEL = {
	url: "https://media.githubusercontent.com/media/NVlabs/motionbricks/main/motionbricks/assets/onnx/soma/mmm_v6_soma_fp16.onnx",
	sha256: "6c9f78e23decbda8e1cfd1b0cc96980ea4b24b3ca2c808d03b058f48f82fc9ef",
	bytes: 380327058,
};

const modelPath = () => process.env.COZYCLAY_MOTIONBRICKS_MODEL
	?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "cozyclay", "motionbricks", "mmm_v6_soma_fp16.onnx");

async function sha256(path) {
	const h = createHash("sha256");
	await pipeline(createReadStream(path), h);
	return h.digest("hex");
}

/** The model file, downloaded and verified on first use. */
async function ensureModel(log = () => {}) {
	const path = modelPath();
	if (existsSync(path)) return path;
	mkdirSync(dirname(path), { recursive: true });
	log(`downloading the MotionBricks SOMA model (${Math.round(MODEL.bytes / 1e6)} MB) to ${path}`);
	const res = await fetch(MODEL.url);
	if (!res.ok) throw new Error(`MOTIONBRICKS_DOWNLOAD_FAILED: ${res.status} ${MODEL.url}`);
	const part = `${path}.part`;
	await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
	const got = await sha256(part);
	if (got !== MODEL.sha256) throw new Error(`MOTIONBRICKS_CHECKSUM_MISMATCH: got ${got}, want ${MODEL.sha256} (${part} kept)`);
	renameSync(part, path);
	return path;
}

/** run(feed) -> { out: Float32Array [64 x 366], tokens } for one request (feed from src/motion3/bricks/model-io.js). */
export async function createRunner(log) {
	const ort = await import("onnxruntime-node");
	const session = await ort.InferenceSession.create(await ensureModel(log), { executionProviders: ["cpu"] });
	return async feed => {
		const inputs = Object.fromEntries(Object.entries(feed).map(([k, { data, dims, type }]) => [k, new ort.Tensor(type, data, dims)]));
		const res = await session.run(inputs);
		return { out: res.pred_global_motions.data, tokens: Number(res.pred_num_tokens.data[0]) };
	};
}
