#!/usr/bin/env python3
"""Compare the four icon concepts (A-D) at 256 / 48 / 24 / 16 px on light and dark tiles.

    python concept-sheet.py out.png
"""
import importlib.util
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("sheet", os.path.join(HERE, "preview-sheet.py"))
sheet = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sheet)

CONCEPTS = ["A-module-keystone", "B-forge-x", "C-stage-frame", "D-node-graph-x"]
SIZES = [256, 48, 24, 16]
CELL, PAD = 128, 16


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "icon-concepts.png"
    rows = []
    with tempfile.TemporaryDirectory() as tmp:
        for c in CONCEPTS:
            imgs = []
            for s in SIZES:
                src = os.path.join(HERE, "concepts", f"{c}.svg")
                # Concept A is judged with its hand-tuned small masters, as it would ship.
                if c.startswith("A-") and s <= 24:
                    src = os.path.join(HERE, "icon-16.svg" if s <= 20 else "icon-24.svg")
                p = os.path.join(tmp, f"{c}-{s}.png")
                subprocess.run(["rsvg-convert", "-w", str(s), "-h", str(s), src, "-o", p], check=True)
                imgs.append(sheet.read_rgba(p))
            rows.append(imgs)
    cols = len(SIZES) * 2
    width = PAD + cols * (CELL + PAD)
    height = PAD + len(CONCEPTS) * (CELL + PAD)
    canvas = [[(255, 255, 255)] * width for _ in range(height)]
    for r, imgs in enumerate(rows):
        for half, bg in enumerate(sheet.BG):
            for c, (w, h, px) in enumerate(imgs):
                col = half * len(SIZES) + c
                x0, y0 = PAD + col * (CELL + PAD), PAD + r * (CELL + PAD)
                for y in range(y0 - PAD // 2, y0 + CELL + PAD // 2):
                    for x in range(x0 - PAD // 2, x0 + CELL + PAD // 2):
                        canvas[y][x] = bg
                z = max(1, CELL // w) if w < CELL else 1
                size = w * z if w < CELL else CELL
                ox, oy = x0 + (CELL - size) // 2, y0 + (CELL - size) // 2
                for y in range(size):
                    sy = y // z if w < CELL else y * h // size
                    for x in range(size):
                        sx = x // z if w < CELL else x * w // size
                        p = px[sy][sx * 4:sx * 4 + 4]
                        a = p[3] / 255
                        canvas[oy + y][ox + x] = tuple(int(p[i] * a + bg[i] * (1 - a)) for i in range(3))
    sheet.write_rgb(out, canvas)
    print(f"wrote {out}: rows {', '.join(CONCEPTS)}; columns 256/48/24/16 px on light, then dark")


if __name__ == "__main__":
    main()
