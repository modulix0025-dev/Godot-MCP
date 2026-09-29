#!/usr/bin/env python3
"""Render every shipped icon raster + the Windows ICO from the SVG masters (Execution Patch 1 §5).

Outputs (studio/branding/png/):
    icon-16.png … icon-1024.png   sizes 16, 20, 24, 32, 40, 48, 64, 128, 256, 512, 1024
and copies the Tauri bundle icons + builds studio/app/src-tauri/icons/icon.ico (16–256; 256 is the ICO maximum).

Sources: 16/20 px ← icon-16.svg, 24 px ← icon-24.svg, larger ← icon.svg. The 16 and 20 px renders are
pixel-hinted: every pixel is snapped to a 4-tone palette (transparent, ink, white, rim) so the mark stays crisp in
the title bar, taskbar and Start Menu instead of an anti-aliased grey smudge. Needs `rsvg-convert`.

    python render-icons.py            # render + write ICO + copy Tauri icons
    python render-icons.py --verify   # exit 1 unless every PNG size and every ICO entry exists
"""
import importlib.util
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
PNG_DIR = os.path.join(HERE, "png")
TAURI_ICONS = os.path.normpath(os.path.join(HERE, "..", "app", "src-tauri", "icons"))
SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256, 512, 1024]
ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 256]
HINTED = {16, 20}

INK = (0x29, 0x29, 0x29)
WHITE = (0xFF, 0xFF, 0xFF)
RIM = (0x70, 0x70, 0x70)

_spec = importlib.util.spec_from_file_location("sheet", os.path.join(HERE, "preview-sheet.py"))
sheet = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sheet)


def source_for(size):
    if size <= 20:
        return os.path.join(HERE, "icon-16.svg")
    if size <= 24:
        return os.path.join(HERE, "icon-24.svg")
    return os.path.join(HERE, "icon.svg")


def write_rgba(path, w, h, rows):
    raw = b"".join(b"\0" + r for r in rows)

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def hint(rows, w):
    """Snap each pixel: alpha < 40% → transparent; partial alpha → rim; bright → white; else ink."""
    out = []
    for r in rows:
        px = bytearray()
        for x in range(w):
            cr, cg, cb, a = r[x * 4:x * 4 + 4]
            if a < 102:
                px += bytes((0, 0, 0, 0))
                continue
            lum = (0.2126 * cr + 0.7152 * cg + 0.0722 * cb) / 255
            if a < 200:
                color = RIM
            elif lum > 0.62:
                color = WHITE
            else:
                color = INK
            px += bytes((*color, 255))
        out.append(bytes(px))
    return out


def render():
    os.makedirs(PNG_DIR, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        for s in SIZES:
            raw = os.path.join(tmp, f"{s}.png")
            subprocess.run(["rsvg-convert", "-w", str(s), "-h", str(s), source_for(s), "-o", raw], check=True)
            dst = os.path.join(PNG_DIR, f"icon-{s}.png")
            if s in HINTED:
                w, h, rows = sheet.read_rgba(raw)
                write_rgba(dst, w, h, hint(rows, w))
            else:
                shutil.copyfile(raw, dst)
    # ICO: PNG-compressed entries (Vista+). 0 in the directory means 256.
    entries = [(s, open(os.path.join(PNG_DIR, f"icon-{s}.png"), "rb").read()) for s in ICO_SIZES]
    header = struct.pack("<HHH", 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    directory, data = b"", b""
    for s, png in entries:
        dim = 0 if s >= 256 else s
        directory += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(png), offset + len(data))
        data += png
    os.makedirs(TAURI_ICONS, exist_ok=True)
    with open(os.path.join(TAURI_ICONS, "icon.ico"), "wb") as f:
        f.write(header + directory + data)
    for name, s in (("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256), ("icon.png", 512)):
        shutil.copyfile(os.path.join(PNG_DIR, f"icon-{s}.png"), os.path.join(TAURI_ICONS, name))
    print(f"rendered {', '.join(map(str, SIZES))} px; ICO {', '.join(map(str, ICO_SIZES))}; Tauri icons updated")


def verify():
    missing = [s for s in SIZES if not os.path.exists(os.path.join(PNG_DIR, f"icon-{s}.png"))]
    for s in SIZES:
        p = os.path.join(PNG_DIR, f"icon-{s}.png")
        if os.path.exists(p):
            w, h, _ = sheet.read_rgba(p)
            if (w, h) != (s, s):
                missing.append(f"{s} (is {w}x{h})")
    ico = open(os.path.join(TAURI_ICONS, "icon.ico"), "rb").read()
    count = struct.unpack("<H", ico[4:6])[0]
    found = sorted({(ico[6 + 16 * i] or 256) for i in range(count)})
    missing += [f"ico:{s}" for s in ICO_SIZES if s not in found]
    print(f"png: {SIZES}\nico: {found}")
    if missing:
        print(f"MISSING: {missing}")
        return 1
    print("OK: every PNG size and every ICO entry present")
    return 0


if __name__ == "__main__":
    sys.exit(verify() if "--verify" in sys.argv else (render() or 0))
