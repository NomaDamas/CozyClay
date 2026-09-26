"""Build evidence sheets from actual CUA browser screenshots, never synthesize poses."""
import argparse
import base64
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

parser = argparse.ArgumentParser()
parser.add_argument("--bundle", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
data = json.loads(Path(args.bundle).read_text())
out = Path(args.output)
out.mkdir(parents=True, exist_ok=True)
font = lambda size: ImageFont.truetype("/System/Library/Fonts/AppleSDGothicNeo.ttc", size)
for shot in data["captures"]:
    (out / (shot["name"] + ".png")).write_bytes(base64.b64decode(shot["data"]))
(out / "browser-checks.json").write_text(json.dumps({k: v for k, v in data.items() if k != "captures"}, indent=2))
for model in ["y-bot-tpose", "x-bot-tpose"]:
    metrics = [m for m in data["metrics"] if m.get("model") == model][-1]
    image = Image.new("RGB", (1440, 1320), "#111c27")
    d = ImageDraw.Draw(image)
    d.text((28, 22), "AutoPhysics · 실제 브라우저 전후 비교", font=font(34), fill="white")
    d.text((28, 72), f"{model}  |  362프레임 · 24fps  |  첫 계산 {metrics['performance']['totalMs']/1000:.2f}초", font=font(23), fill="#b8c7d5")
    b, a = metrics["before"], metrics["after"]
    d.text((28, 112), f"지지 미확인 부유 {b['unsupportedFrames']} → {a['unsupportedFrames']}프레임  ·  최대 관통 {b['penetration']*100:.2f} → {a['penetration']*100:.2f}cm", font=font(24), fill="#87dcc0")
    d.text((28, 156), "원본", font=font(27), fill="#ffd09b")
    d.text((734, 156), "보정 미리보기 · 동일 카메라", font=font(27), fill="#87dcc0")
    for row, (frame, label) in enumerate([(210, "몸을 숙여 지탱하는 구간"), (245, "무릎 지지 구간"), (283, "서 있는 구간")]):
        y = 204 + row * 345
        d.text((28, y), f"F{frame} · {label}", font=font(23), fill="#d9e2eb")
        for col, variant in enumerate(["before", "after"]):
            shot = Image.open(out / f"{model}-{variant}-f{frame}.png").convert("RGB")
            # Remove only the top mode toolbar. Keep the complete scene below it.
            shot = shot.crop((0, round(shot.width * 26 / 1049), shot.width, shot.height))
            shot.thumbnail((678, 292), Image.Resampling.LANCZOS)
            image.paste(shot, (28 + col * 706 + (678 - shot.width) // 2, y + 39))
    d.text((28, 1250), f"힘·회전 근사 모델: 미확정 {len(set(x['frame'] for x in metrics['unresolved']))}프레임은 경고로 유지합니다.", font=font(23), fill="#ffd09b")
    d.text((28, 1286), "바닥만 모델링 · 손가락 원본 유지 · 숨은 의자/외력/관절 토크까지 보장하지 않음", font=font(20), fill="#b8c7d5")
    image.save(out / f"{model}-comparison.png")
    shots = sorted(out.glob(f"{model}-after-f*.png"), key=lambda p: int(p.stem.split("-f")[-1]))
    sheet = Image.new("RGB", (1800, ((len(shots) + 3) // 4) * 235), "#111c27")
    draw = ImageDraw.Draw(sheet)
    for i, path in enumerate(shots):
        shot = Image.open(path).convert("RGB")
        shot.thumbnail((444, 199), Image.Resampling.LANCZOS)
        x, y = i % 4 * 450, i // 4 * 235
        draw.text((x + 8, y + 3), "F" + path.stem.split("-f")[-1], font=font(22), fill="white")
        sheet.paste(shot, (x + (450 - shot.width) // 2, y + 33))
    sheet.save(out / f"{model}-pose-sweep.png")
print(out)
