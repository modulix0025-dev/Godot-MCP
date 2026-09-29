#!/usr/bin/env python3
"""Render the icon at 16/24/32/48/256 px and compose a side-by-side review sheet on light and dark tiles.

Small sizes are upscaled with nearest-neighbour so individual pixels stay visible (that is what the
16/24 px hand-tuning is judged on). Needs `rsvg-convert` (librsvg) on PATH; pure-stdlib otherwise.

    python preview-sheet.py out.png [icon.svg icon-16.svg icon-24.svg]
"""
import os
import struct
import subprocess
import sys
import tempfile
import zlib

SIZES = [16, 24, 32, 48, 256]
CELL = 256
PAD = 24
BG = [(245, 247, 250), (11, 13, 18)]


def render(svg, size, out):
    subprocess.run(["rsvg-convert", "-w", str(size), "-h", str(size), svg, "-o", out], check=True)


def read_rgba(path):
    b = open(path, "rb").read()
    i, idat = 8, b""
    while i < len(b):
        (ln,) = struct.unpack(">I", b[i:i + 4])
        kind = b[i + 4:i + 8]
        if kind == b"IHDR":
            w, h, _, ct = struct.unpack(">IIBB", b[i + 8:i + 18])
            assert ct == 6, "expected RGBA from rsvg-convert"
        elif kind == b"IDAT":
            idat += b[i + 8:i + 8 + ln]
        i += 12 + ln
    raw, bpp = zlib.decompress(idat), 4
    stride, rows, prev, pos = w * bpp, [], bytearray(w * bpp), 0
    for _ in range(h):
        f = raw[pos]
        line = bytearray(raw[pos + 1:pos + 1 + stride])
        pos += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            up = prev[x]
            c = prev[x - bpp] if x >= bpp else 0
            if f == 1:
                line[x] = (line[x] + a) & 255
            elif f == 2:
                line[x] = (line[x] + up) & 255
            elif f == 3:
                line[x] = (line[x] + (a + up) // 2) & 255
            elif f == 4:
                p = a + up - c
                pa, pb, pc = abs(p - a), abs(p - up), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else up if pb <= pc else c)) & 255
        rows.append(bytes(line))
        prev = line
    return w, h, rows


def write_rgb(path, canvas):
    h, w = len(canvas), len(canvas[0])
    raw = b"".join(b"\0" + bytes(v for px in row for v in px) for row in canvas)

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "icon-preview-sheet.png"
    here = os.path.dirname(os.path.abspath(__file__))
    master = os.path.join(here, "icon.svg")
    source = {16: os.path.join(here, "icon-16.svg"), 24: os.path.join(here, "icon-24.svg")}
    imgs = []
    with tempfile.TemporaryDirectory() as tmp:
        for s in SIZES:
            p = os.path.join(tmp, f"{s}.png")
            render(source.get(s, master), s, p)
            imgs.append(read_rgba(p))
    width = PAD + len(SIZES) * (CELL + PAD)
    height = PAD + len(BG) * (CELL + PAD)
    canvas = [[(255, 255, 255)] * width for _ in range(height)]
    for r, bg in enumerate(BG):
        top = r * (CELL + PAD)
        for y in range(top, min(height, top + CELL + 2 * PAD)):
            canvas[y] = [bg] * width
        for c, (w, h, rows) in enumerate(imgs):
            z = CELL // w
            ox = PAD + c * (CELL + PAD) + (CELL - w * z) // 2
            oy = top + PAD + (CELL - h * z) // 2
            for y in range(h * z):
                row = canvas[oy + y]
                src = rows[y // z]
                for x in range(w * z):
                    px = src[(x // z) * 4:(x // z) * 4 + 4]
                    a = px[3] / 255
                    row[ox + x] = tuple(int(px[i] * a + bg[i] * (1 - a)) for i in range(3))
    write_rgb(out, canvas)
    print(f"wrote {out} ({', '.join(f'{s}px' for s in SIZES)}; light + dark)")


if __name__ == "__main__":
    main()
