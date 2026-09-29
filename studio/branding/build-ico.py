#!/usr/bin/env python3
"""Build and verify the Windows multi-resolution icon (icon.ico) from the SVG masters.

Sizes 16/20 use the hand-simplified icon-16.svg, 24 uses icon-24.svg, 32+ use the master. Every entry is
a PNG-compressed ICO image (supported since Windows Vista). Needs `rsvg-convert` on PATH.

    python build-ico.py <out.ico>          # build
    python build-ico.py --verify <in.ico>  # exit 1 unless all required sizes are present
"""
import os
import struct
import subprocess
import sys
import tempfile

REQUIRED = [16, 20, 24, 32, 40, 48, 64, 256]
HERE = os.path.dirname(os.path.abspath(__file__))


def source_for(size):
    if size <= 20:
        return os.path.join(HERE, "icon-16.svg")
    if size <= 24:
        return os.path.join(HERE, "icon-24.svg")
    return os.path.join(HERE, "icon.svg")


def build(out):
    entries = []
    with tempfile.TemporaryDirectory() as tmp:
        for s in REQUIRED:
            p = os.path.join(tmp, f"{s}.png")
            subprocess.run(["rsvg-convert", "-w", str(s), "-h", str(s), source_for(s), "-o", p], check=True)
            entries.append((s, open(p, "rb").read()))
    header = struct.pack("<HHH", 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    dir_, data = b"", b""
    for s, png in entries:
        dim = 0 if s >= 256 else s  # 0 means 256 in the ICO directory
        dir_ += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(png), offset + len(data))
        data += png
    with open(out, "wb") as f:
        f.write(header + dir_ + data)
    print(f"wrote {out}: {', '.join(str(s) for s in REQUIRED)}")


def sizes_in(path):
    b = open(path, "rb").read()
    reserved, kind, count = struct.unpack("<HHH", b[:6])
    if reserved != 0 or kind != 1:
        raise ValueError("not an ICO file")
    out = []
    for i in range(count):
        w, h = struct.unpack("<BB", b[6 + 16 * i:8 + 16 * i])
        out.append((w or 256, h or 256))
    return out


def verify(path):
    found = sizes_in(path)
    missing = [s for s in REQUIRED if (s, s) not in found]
    print(f"{path}: {sorted(set(w for w, _ in found))}")
    if missing:
        print(f"MISSING sizes: {missing}")
        return 1
    print("OK: all required sizes present")
    return 0


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--verify":
        sys.exit(verify(sys.argv[2]))
    build(sys.argv[1] if len(sys.argv) > 1 else "icon.ico")
