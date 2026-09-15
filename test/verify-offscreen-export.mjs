#!/usr/bin/env node
import assert from "node:assert/strict";
import { exportOffscreenVideo, normalizeFrameRange } from "../src/offscreen-export.js";

class FakeVideoFrame {
	constructor(pixels, init) {
		this.pixels = pixels;
		this.timestamp = init.timestamp;
		this.duration = init.duration;
	}
	close() {}
}

class FakeVideoEncoder {
	static async isConfigSupported(config) {
		return { supported: config.codec.startsWith("avc1"), config };
	}

	constructor({ output, error }) {
		this.output = output;
		this.error = error;
		this.encodeQueueSize = 0;
		this.state = "unconfigured";
	}

	configure(config) {
		this.config = config;
		this.state = "configured";
	}

	encode(frame, options) {
		const byte = Math.round(frame.timestamp / frame.duration) & 0xff;
		const chunk = {
			byteLength: 1,
			timestamp: frame.timestamp,
			duration: frame.duration,
			type: options.keyFrame ? "key" : "delta",
			copyTo(destination) { destination[0] = byte; },
		};
		this.output(chunk, {
			decoderConfig: {
				codec: this.config.codec,
				codedWidth: this.config.width,
				codedHeight: this.config.height,
				description: new Uint8Array([
					1, 100, 0, 50, 255, 225, 0, 4, 103, 100, 0, 50,
					1, 0, 4, 104, 238, 60, 128,
				]),
			},
		});
	}

	async flush() {}

	close() {
		this.state = "closed";
	}
}

class UnsupportedVideoEncoder {
	static async isConfigSupported(config) {
		return { supported: false, config };
	}
}

class MissingAvcDescriptionEncoder extends FakeVideoEncoder {
	static async isConfigSupported(config) {
		return { supported: config.codec.startsWith("avc1"), config };
	}

	encode(frame, options) {
		const byte = Math.round(frame.timestamp / frame.duration) & 0xff;
		this.output({
			byteLength: 1,
			timestamp: frame.timestamp,
			duration: frame.duration,
			type: options.keyFrame ? "key" : "delta",
			copyTo(destination) { destination[0] = byte; },
		}, {
			decoderConfig: {
				codec: this.config.codec,
				codedWidth: this.config.width,
				codedHeight: this.config.height,
			},
		});
	}
}

const range = normalizeFrameRange(10, 153);
assert.deepEqual(range, { startFrame: 10, endFrame: 153, frameCount: 144 });
assert.throws(() => normalizeFrameRange(5, 4), /inclusive non-negative range/);

async function run() {
	const addressed = [];
	const result = await exportOffscreenVideo({
		startFrame: 10,
		endFrame: 153,
		fps: 24,
		width: 2,
		height: 2,
		capture(frame) {
			addressed.push(frame);
			return Uint8Array.from({ length: 16 }, (_, index) => (frame * 17 + index * 3) & 0xff);
		},
		VideoEncoderClass: FakeVideoEncoder,
		VideoFrameClass: FakeVideoFrame,
	});
	return { addressed, result };
}

const first = await run();
const second = await run();
assert.equal(first.result.frameCount, 144);
assert.equal(first.result.encodedFrameCount, 144);
assert.equal(first.addressed.length, 144);
assert.equal(first.addressed[0], 10);
assert.equal(first.addressed.at(-1), 153);
assert.deepEqual(first.result.hashes, second.result.hashes);
assert.equal(first.result.blob.type, "video/mp4");
assert.ok(first.result.blob.size > 144, "muxed MP4 should contain the encoded frames and headers");

const bytes = new Uint8Array(await first.result.blob.arrayBuffer());
assert.equal(new TextDecoder().decode(bytes.subarray(4, 8)), "ftyp");
await assert.rejects(
	exportOffscreenVideo({
		startFrame: 0,
		endFrame: 0,
		fps: 24,
		width: 2,
		height: 2,
		capture: () => new Uint8Array(16),
		VideoEncoderClass: UnsupportedVideoEncoder,
		VideoFrameClass: FakeVideoFrame,
	}),
	/H\.264 WebCodecs encoder for MP4 export/,
);
await assert.rejects(
	exportOffscreenVideo({
		startFrame: 0,
		endFrame: 0,
		fps: 24,
		width: 2,
		height: 2,
		capture: () => new Uint8Array(16),
		VideoEncoderClass: MissingAvcDescriptionEncoder,
		VideoFrameClass: FakeVideoFrame,
	}),
	/H\.264 MP4 needs the encoder's AVC decoder configuration/,
);

const singleFrame = {
	startFrame: 0, endFrame: 0, fps: 24, width: 2, height: 2,
	capture: () => new Uint8Array(16),
	VideoEncoderClass: FakeVideoEncoder, VideoFrameClass: FakeVideoFrame,
};
await assert.rejects(exportOffscreenVideo({ ...singleFrame, VideoEncoderClass: null }), {
	exportFailureCode: "unsupported_codec",
});
await assert.rejects(exportOffscreenVideo({ ...singleFrame, VideoEncoderClass: UnsupportedVideoEncoder }), {
	exportFailureCode: "unsupported_codec",
});
const alreadyAborted = new AbortController();
alreadyAborted.abort();
await assert.rejects(exportOffscreenVideo({ ...singleFrame, signal: alreadyAborted.signal, VideoEncoderClass: null }), {
	name: "AbortError",
});
await assert.rejects(exportOffscreenVideo({ ...singleFrame, VideoEncoderClass: MissingAvcDescriptionEncoder }), {
	exportFailureCode: "encode_failed",
});
let lastEncoder;
class ObservedEncoder extends FakeVideoEncoder {
	constructor(callbacks) { super(callbacks); lastEncoder = this; }
}
for (const capture of [() => { throw new Error("private render failure"); }, () => null]) {
	await assert.rejects(exportOffscreenVideo({ ...singleFrame, capture, VideoEncoderClass: ObservedEncoder }), {
		exportFailureCode: "render_failed",
	});
	assert.equal(lastEncoder.state, "closed", "capture failure closes the encoder");
}
const encodeError = new Error("private encoder failure");
class AsyncFailureEncoder extends ObservedEncoder {
	async flush() {
		await Promise.resolve();
		this.error(encodeError);
	}
}
await assert.rejects(exportOffscreenVideo({ ...singleFrame, VideoEncoderClass: AsyncFailureEncoder }), (error) => {
	assert.equal(error, encodeError, "the original encoder error is preserved");
	assert.equal(error.exportFailureCode, "encode_failed");
	return true;
});
assert.equal(lastEncoder.state, "closed");
const flushError = new Error("private flush failure");
class RejectedFlushEncoder extends ObservedEncoder {
	async flush() { throw flushError; }
}
await assert.rejects(exportOffscreenVideo({ ...singleFrame, VideoEncoderClass: RejectedFlushEncoder }), (error) => {
	assert.equal(error, flushError);
	assert.equal(error.exportFailureCode, "encode_failed");
	return true;
});
assert.equal(lastEncoder.state, "closed");
class BrokenOutputEncoder extends ObservedEncoder {
	async flush() {
		await Promise.resolve();
		this.output({ byteLength: 1, copyTo() { throw encodeError; } });
	}
}
await assert.rejects(exportOffscreenVideo({ ...singleFrame, VideoEncoderClass: BrokenOutputEncoder }), { exportFailureCode: "encode_failed" });
assert.equal(lastEncoder.state, "closed");
class ConfigureFailureEncoder extends ObservedEncoder {
	configure() { throw encodeError; }
}
await assert.rejects(exportOffscreenVideo({ ...singleFrame, VideoEncoderClass: ConfigureFailureEncoder }), { exportFailureCode: "encode_failed" });
assert.equal(lastEncoder.state, "closed");
class ConstructorFailureEncoder extends FakeVideoEncoder {
	constructor() { throw encodeError; }
}
await assert.rejects(exportOffscreenVideo({ ...singleFrame, VideoEncoderClass: ConstructorFailureEncoder }), { exportFailureCode: "encode_failed" });
const renderError = new Error("private hash failure");
const subtleDescriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, "subtle");
try {
	Object.defineProperty(globalThis.crypto, "subtle", { configurable: true, value: { async digest() { throw renderError; } } });
	await assert.rejects(exportOffscreenVideo({ ...singleFrame, VideoEncoderClass: ObservedEncoder }), (error) => {
		assert.equal(error, renderError);
		assert.equal(error.exportFailureCode, "render_failed");
		return true;
	});
	assert.equal(lastEncoder.state, "closed", "async pixel processing failure closes the encoder");
} finally {
	if (subtleDescriptor) Object.defineProperty(globalThis.crypto, "subtle", subtleDescriptor);
	else delete globalThis.crypto.subtle;
}
const cancelled = new AbortController();
class CancelDuringFlushEncoder extends ObservedEncoder {
	async flush() { cancelled.abort(); }
}
await assert.rejects(exportOffscreenVideo({ ...singleFrame, signal: cancelled.signal, VideoEncoderClass: CancelDuringFlushEncoder }), { name: "AbortError" });
assert.equal(lastEncoder.state, "closed");
const abort = new DOMException("cancel capture", "AbortError");
await assert.rejects(exportOffscreenVideo({ ...singleFrame, capture() { throw abort; }, VideoEncoderClass: ObservedEncoder }), (error) => error === abort);
assert.equal(lastEncoder.state, "closed");
console.log("PASS safe unsupported/encode/render failure codes preserve original errors and cleanup");
console.log("PASS already-aborted and in-flight signals remain cancellation");
console.log("PASS 6-second range addresses and encodes exactly 144 frames");
console.log("PASS two exports have identical per-frame SHA-256 pixel hashes");
console.log("PASS WebCodecs chunks are muxed into an MP4 container");
console.log("PASS browsers without an MP4-capable encoder fail by name");
console.log("PASS H.264 export fails closed without AVC decoder metadata");
