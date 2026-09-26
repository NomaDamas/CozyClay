"""Compose unaltered source/render comparisons and clearly labeled timing metrics."""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ap = argparse.ArgumentParser()
ap.add_argument("--input", required=True)
ap.add_argument("--source", required=True)
ap.add_argument("--frames", default="294,300,312,324")
ap.add_argument("--start", type=int, default=276)
ap.add_argument("--end", type=int, default=348)
ap.add_argument("--post-landing", type=int, default=300)
ap.add_argument("--tracks", default="tree-tracks.json")
ap.add_argument("--model", default="x-bot-tpose")
args = ap.parse_args()
folder = Path(args.input)
frames = [int(f) for f in args.frames.split(",")]
tracks = json.loads((folder / args.tracks).read_text())
fps = tracks["fps"]
font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 21)
small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 17)
width, cell_h = 420, 255
sheet = Image.new("RGB", (width * 3, 80 + cell_h * len(frames)), "#f6f7f8")
draw = ImageDraw.Draw(sheet)
draw.text((15, 12), "Same source frames - AutoPhysics OFF - scene Y=0 - identical joint rotations", fill="#18212b", font=font)
for i, title in enumerate(["Source video", "Before", "Corrected + skin floor guard"]):
    draw.text((i * width + 15, 48), title, fill="#18212b", font=small)
cap = cv2.VideoCapture(args.source)
for row, f in enumerate(frames):
    cap.set(cv2.CAP_PROP_POS_FRAMES, f)
    ok, frame = cap.read()
    if not ok:
        raise RuntimeError(f"Cannot decode source frame {f}")
    source = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    images = [source]
    for kind in ["before", "after"]:
        image = Image.open(folder / f"{args.model}-{kind}-f{f}.png").convert("RGB")
        # Identical crop only removes empty upper sky/viewport chrome.
        images.append(image.crop((round(image.width * .15), 120, round(image.width * .85), min(image.height, 595))))
    for column, im in enumerate(images):
        im.thumbnail((width - 10, cell_h - 28))
        x = column * width + (width - im.width) // 2
        y = 80 + row * cell_h
        sheet.paste(im, (x, y))
        draw.text((column * width + 12, y + cell_h - 25), f"Frame {f} | {f / fps:.2f} s", fill="#18212b", font=small)
cap.release()
sheet.save(folder / "comparison.png")
labels = Image.new("RGB", (1320, 40), "black")
label_draw = ImageDraw.Draw(labels)
for x, title in [(16, "Source"), (376, "Before"), (856, "After - AutoPhysics OFF - Y=0")]:
    label_draw.text((x, 8), title, fill="white", font=small)
labels.save(folder / "video-labels.png")

data = json.loads((folder / "retarget-metrics.json").read_text())
hip = np.array(tracks["kp2d"])[:, [11, 12], 1].mean(1)
start, end, post = args.start, args.end, args.post_landing
observed = (hip - hip[start]) / (hip[end] - hip[start])
source90 = int(np.where((np.arange(len(hip)) >= start) & (observed >= .9))[0][0])
fig, ax = plt.subplots(figsize=(11, 4.5), layout="constrained")
t = np.arange(len(hip)) / fps
ax.plot(t, observed, "k--", label="Source 2D hip progress (normalized)")
summary = {"metric": "Normalized vertical timing proxy, NOT metric 3D reconstruction accuracy", "source90Frame": source90}
for key, color in [("before", "#dc614a"), ("after", "#15847b")]:
    y = np.array(data[key]["rootY"])
    progress = (y[start] - y) / (y[start] - y[end])
    f90 = int(np.where((np.arange(len(y)) >= start) & (progress >= .9))[0][0])
    rmse = float(np.sqrt(np.mean((observed[start:end + 1] - progress[start:end + 1]) ** 2)))
    summary[key] = {"frame90": f90, "delaySeconds": (f90 - source90) / fps, "normalizedRmse": rmse,
                    "postLandingNetDropM": float(y[post] - y[end]), "postLandingRangeM": float(np.ptp(y[post:end + 1]))}
    ax.plot(t, progress, color=color, label=key.title(), linewidth=2)
ax.axvline(source90 / fps, color="#444", alpha=.25)
ax.set(xlim=(max(0, start / fps - .5), (end + 1) / fps), ylim=(-.1, 1.2), xlabel="Video time (seconds)", ylabel="Normalized descent progress",
       title="Falling timing: before / after vs. source observation")
ax.grid(alpha=.2); ax.legend(loc="lower right")
fig.savefig(folder / "timing.png", dpi=140)
(folder / "timing-metrics.json").write_text(json.dumps(summary, indent=2))
print(json.dumps(summary, indent=2))
