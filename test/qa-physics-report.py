"""Compose a report from real browser captures; never alter the rendered pose."""
import argparse
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

parser = argparse.ArgumentParser()
parser.add_argument("--captures", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
source, output = Path(args.captures), Path(args.output)
output.mkdir(parents=True, exist_ok=True)
metrics = json.loads((source / "metrics.json").read_text())
font_path = "/System/Library/Fonts/AppleSDGothicNeo.ttc"
font = lambda n: ImageFont.truetype(font_path, n)
width, pad, gap = 1560, 36, 20
cell_w = (width - pad * 2 - gap) // 2
frames = [(283, "발 · 서 있는 구간"), (226, "손 · 바닥을 짚는 구간"), (245, "무릎 · 무릎을 대는 구간")]
cell_h = 555
canvas = Image.new("RGB", (width, 410 + len(frames) * (cell_h + 55) + 65), "#101820")
draw = ImageDraw.Draw(canvas)
draw.text((pad, 25), "AutoPhysics — 실제 영상 전후 비교", fill="#f4f6f8", font=font(40))
draw.text((pad, 82), f"{metrics['model']} · 362프레임 / 24fps · 동일 프레임·동일 카메라", fill="#b6c5d4", font=font(23))
rows = [("최대 표면 관통", "penetration", 100, "cm"), ("최대 접지점 밀림", "slide", 100, "cm"), ("최대 접지점 뜸", "float", 100, "cm"), ("최대 무릎 각가속도", "kneeAcceleration", 1, "°/s²")]
for i, (label, key, scale, unit) in enumerate(rows):
    y = 135 + i * 43
    before, after = metrics["before"][key] * scale, metrics["after"][key] * scale
    draw.text((pad, y), label, fill="#d5e0eb", font=font(24))
    draw.text((530, y), f"{before:.2f} → {after:.2f} {unit}", fill="#85dec0" if after <= before else "#ffc579", font=font(25))
draw.text((pad, 330), "원본", fill="#ffc579", font=font(28))
draw.text((pad + cell_w + gap, 330), "보정 미리보기", fill="#85dec0", font=font(28))
for row, (frame, label) in enumerate(frames):
    y = 385 + row * (cell_h + 55)
    draw.text((pad, y), f"F{frame} · {label}", fill="#d5e0eb", font=font(24))
    for col, variant in enumerate(("before", "after")):
        im = Image.open(source / f"{variant}-f{frame}.png").convert("RGB")
        # Remove only the browser viewport's mode toolbar, then fit the
        # complete remaining viewport without changing its aspect ratio.
        im = im.crop((0, 28, im.width, im.height))
        im.thumbnail((cell_w, cell_h), Image.Resampling.LANCZOS)
        x = pad + col * (cell_w + gap)
        canvas.paste(im, (x + (cell_w - im.width) // 2, y + 40))
draw.text((pad, canvas.height - 46), "측정 대상: 변형된 발·손·무릎 표면. 보정 전 원본은 유지하며 적용/취소 가능.", fill="#b6c5d4", font=font(22))
canvas.save(output / "comparison.png")

# Dense pose sweep for visual inspection of the complete action sequence.
shots = sorted(source.glob("after-f*.png"), key=lambda p: int(p.stem.split("f")[-1]))
tile_w, tile_h, cols = 470, 410, 4
sheet = Image.new("RGB", (cols * tile_w, ((len(shots) + cols - 1) // cols) * tile_h), "#101820")
sd = ImageDraw.Draw(sheet)
for i, path in enumerate(shots):
    im = Image.open(path).convert("RGB"); im.thumbnail((tile_w - 10, tile_h - 45))
    x, y = (i % cols) * tile_w, (i // cols) * tile_h
    sd.text((x + 10, y + 6), path.stem.replace("after-", ""), fill="white", font=font(22))
    sheet.paste(im, (x + (tile_w - im.width) // 2, y + 36))
sheet.save(output / "pose-sweep.png")
if (source / "controls.png").exists():
    controls = Image.open(source / "controls.png")
    # Inspector-only UI evidence; omit the unrelated scene camera framing.
    controls.crop((1220, 80, min(1600, controls.width), min(813, controls.height))).save(output / "controls-panel.png")
print(output / "comparison.png")
