import { ko } from "../locale.js";
import Foldout from "./Foldout.jsx";
import { Slider } from "../ui.jsx";
import { createKeyLight } from "../scenes.js";
import { useStageTransaction } from "../domains/stage.js";

export default function LightPanel({ keyLightSelected, keyLight }) {
	const { run, begin, commit, cancel } = useStageTransaction();
	return (
<Foldout hidden={!keyLightSelected} title={ko("Light", "조명")}>
						<p className="hint v2-details-hint">{ko("Drag the sun in the scene to move the light. Shadows and warmth follow it.", "씬의 해를 드래그해 조명을 옮깁니다. 그림자와 빛의 방향이 따라옵니다.")}</p>
						<div onPointerUp={commit} onPointerCancel={cancel} onKeyUp={commit} onBlur={commit}>
						<Slider label={ko("Brightness", "밝기")} min={0} max={4} step={0.05} value={keyLight.intensity} onChange={(value) => run("run.update", { txId: begin("stage.setKeyLight"), args: { keyLight: { intensity: value } } })} />
						<Slider label={ko("Warm ↔ Cool", "따뜻함 ↔ 차가움")} min={0} max={1} step={0.05} value={keyLight.warmth ?? 0.5} onChange={(value) => run("run.update", { txId: begin("stage.setKeyLight"), args: { keyLight: { warmth: value } } })} />
						</div>
						<div className="readout v2-details-readout">
							<span title={ko("light position", "조명 위치")}>{`x ${keyLight.x.toFixed(1)}  y ${keyLight.y.toFixed(1)}  z ${keyLight.z.toFixed(1)}`}</span>
						</div>
						<button className="btn ghost" onClick={() => run("stage.setKeyLight", { keyLight: createKeyLight(null) })}>
							{ko("Reset light", "조명 초기화")}
						</button>
					</Foldout>
	);
}
