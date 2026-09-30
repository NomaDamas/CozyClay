import { useState, useRef } from "react";
import { ko, isKo } from "../locale.js";
import { ASSET_IMAGE_TYPES, downscaleTarget } from "../scene-assets.js";

const REFERENCE_IMAGE_MAX_DIMENSION = 1024;

async function readReferenceImage(file, { maxDimension = REFERENCE_IMAGE_MAX_DIMENSION } = {}) {
	if (!file) throw new Error("No file");
	if (!ASSET_IMAGE_TYPES.includes(String(file.type).toLowerCase())) {
		throw new Error("unsupported image type");
	}
	const dataUrl = await new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error("could not read the file"));
		reader.onload = () => resolve(String(reader.result));
		reader.readAsDataURL(file);
	});
	const bitmap = await createImageBitmap(file);
	try {
		const target = downscaleTarget(bitmap.width, bitmap.height, maxDimension);
		if (!target) throw new Error("could not decode that image");
		if (!target.scaled) return dataUrl;
		const canvas = document.createElement("canvas");
		canvas.width = target.width;
		canvas.height = target.height;
		const context = canvas.getContext("2d");
		context.drawImage(bitmap, 0, 0, target.width, target.height);
		// GIF and WebP re-encode to PNG: a still frame is what a reference is.
		const type = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
		return canvas.toDataURL(type, type === "image/jpeg" ? 0.92 : undefined);
	} finally {
		bitmap.close?.();
	}
}

export default function ReferenceImageField({ label, hint, value, alt, onPick, onClear, inputProps = {} }) {
	const inputRef = useRef(null);
	const [error, setError] = useState("");
	return (
		<div className="reference-slot v2-reference-slot">
			<div className="reference-slot-head">
				<span className="reference-slot-label">{label}</span>
				{value && (
					<button type="button" className="btn ghost small" onClick={() => { setError(""); onClear(); }}>
						{ko("Clear", "지우기")}
					</button>
				)}
			</div>
			<div className="reference-slot-body">
				<button
					type="button"
					className="reference-slot-thumb"
					data-empty={value ? undefined : "true"}
					onClick={() => inputRef.current?.click()}
					title={ko("Choose a reference picture", "참고 이미지를 선택합니다")}
				>
					{value
						? <img src={value} alt={alt ?? label} />
						: <span className="reference-slot-plus" aria-hidden="true">＋</span>}
				</button>
				<div className="reference-slot-copy">
					<p className="inspector-hint">{hint}</p>
					<button type="button" className="btn ghost small" onClick={() => inputRef.current?.click()}>
						{value ? ko("Replace", "교체") : ko("Choose image", "이미지 선택")}
					</button>
				</div>
			</div>
			{error && <p className="inspector-hint reference-slot-error" role="status">{error}</p>}
			<input
				ref={inputRef}
				type="file"
				className="multimodel-file-input"
				accept="image/*"
				{...inputProps}
				onChange={async (event) => {
					const file = event.target.files?.[0];
					// Cleared before the await: re-picking the same file after an
					// error must fire change again.
					event.target.value = "";
					if (!file) return;
					setError("");
					try {
						onPick(await readReferenceImage(file));
					} catch (failure) {
						setError(isKo ? `이미지를 불러오지 못했어요 — ${failure.message}` : `Could not load that image — ${failure.message}`);
					}
				}}
			/>
		</div>
	);
}
