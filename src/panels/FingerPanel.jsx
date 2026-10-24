import { ko } from "../locale.js";
import { FINGER_PRESETS, fingerCurl } from "../motion/fingers.js";

const FINGER_LABELS = { Thumb: ["Thumb", "엄지"], Index: ["Index", "검지"], Middle: ["Middle", "중지"], Ring: ["Ring", "약지"], Pinky: ["Pinky", "새끼"] };
const PRESET_LABELS = { open: ["Open", "펴기"], fist: ["Fist", "주먹"], point: ["Pointing", "가리키기"] };

/** A slider previews while it moves and bakes once on release, the same gesture shape as a viewport drag. */
export default function FingerPanel({ fingers, tick, editing = false, onToggleEdit, onCurl, onCommit, onPreset }) {
	if (!fingers.length) return null;
	const side = fingers[0].side;
	return (
		<section className="pose-section" data-testid="finger-panel">
			<h4>{side === "Left" ? ko("Left hand fingers", "왼손 손가락") : ko("Right hand fingers", "오른손 손가락")}</h4>
			<div className="pose-actions">
				<button type="button" className={"btn" + (editing ? " primary" : "")} aria-pressed={editing} data-testid="finger-edit-toggle" onClick={onToggleEdit}>
					{editing ? ko("Editing fingertips", "손끝 편집 중") : ko("Edit fingertips", "손끝 편집")}
				</button>
			</div>
			<div className="pose-actions">
				{Object.keys(FINGER_PRESETS).map((name) => (
					<button key={name} type="button" className="btn" data-testid={`finger-preset-${name}`} onClick={() => onPreset(name)}>{ko(...PRESET_LABELS[name])}</button>
				))}
			</div>
			{fingers.map((finger) => (
				<label key={`${finger.id}:${tick}`} className="pose-row pose-object-opacity">
					<span>{ko(...FINGER_LABELS[finger.name])}</span>
					<input type="range" min={0} max={100} step={1} defaultValue={Math.round(fingerCurl(finger) * 100)}
						data-testid={`finger-curl-${finger.name.toLowerCase()}`} aria-label={ko(`${finger.name} bend`, `${FINGER_LABELS[finger.name][1]} 굽힘`)}
						onChange={(event) => onCurl(finger.id, Number(event.target.value) / 100)}
						onPointerUp={onCommit} onKeyUp={onCommit} />
				</label>
			))}
			<p className="inspector-hint">{editing
				? ko("Drag a fingertip dot to bend that finger. The hand's move and rotate tools come back when you leave fingertip editing.", "손끝 점을 끌면 그 손가락이 굽어요. 손끝 편집을 끄면 손 이동·회전 도구가 돌아와요.")
				: ko("Turn on fingertip editing to drag fingertips in the viewport.", "손끝 편집을 켜면 뷰포트에서 손끝을 끌 수 있어요.")}</p>
		</section>
	);
}
