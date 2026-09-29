#!/usr/bin/env python3
"""Generate the "Module Keystone" icon masters (concept A, docs/modulex/ui/ICON.md).

Geometry: an isometric cube (regular hexagon, pointy-top). In isometric projection the two long diagonals
UL->LR and LL->UR are straight lines through the centre, so carving them out as a channel leaves an X of
negative space that splits the cube into four modules: the top face, the left and right wedges, and the
front-bottom module. The front-bottom module is offset downward ("assembly in progress") and filled with
ModuleX Cobalt; the X channel shows the cobalt edge. Small sizes are hand-simplified: wider channel, no
offset, no highlight stroke.

    python generate-icons.py      # rewrites icon.svg, icon-24.svg, icon-16.svg
"""
import math

C = (512.0, 512.0)
R = 380.0


def P(deg):
    return (C[0] + R * math.cos(math.radians(deg)), C[1] + R * math.sin(math.radians(deg)))


TOP, UR, LR, BOT, LL, UL = P(-90), P(-30), P(30), P(90), P(150), P(210)


def inset(poly, d):
    """Inward parallel offset of a convex CLOCKWISE polygon (screen coords) by d."""
    n = len(poly)
    lines = []
    for i in range(n):
        (x1, y1), (x2, y2) = poly[i], poly[(i + 1) % n]
        dx, dy = x2 - x1, y2 - y1
        L = math.hypot(dx, dy)
        nx, ny = -dy / L, dx / L  # inward normal for clockwise order in y-down screen space
        lines.append(((x1 + nx * d, y1 + ny * d), (dx, dy)))
    out = []
    for i in range(n):
        (p, r), (q, s) = lines[i - 1], lines[i]
        cross = r[0] * s[1] - r[1] * s[0]
        t = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / cross
        out.append((p[0] + r[0] * t, p[1] + r[1] * t))
    return out


def pts(poly, dy=0.0):
    return " ".join(f"{x:.1f},{y + dy:.1f}" for x, y in poly)


def build(label, gap, offset, channel, highlight, rim, sides=("#12151C", "#1C2130")):
    mods = {
        "left": [UL, C, LL],
        "right": [C, UR, LR],
        "top": [UL, TOP, UR, C],
        "bottom": [LL, C, LR, BOT],
    }
    fills = {"left": sides[0], "right": sides[1], "top": "url(#mxTop)", "bottom": "url(#mxCobalt)"}
    body = []
    # Slate rim: keeps the ink silhouette legible on dark taskbars / dark-theme UIs.
    rim_poly = inset([TOP, UR, LR, BOT, LL, UL], rim / 2)
    body.append(f'<polygon points="{pts(rim_poly)}" fill="#3A4466"/>')
    # Cobalt X channel, visible through the module gaps.
    body.append(
        f'<g stroke="#4C6FFF" stroke-width="{channel}" stroke-linecap="butt">'
        f'<line x1="{UL[0]:.1f}" y1="{UL[1]:.1f}" x2="{LR[0]:.1f}" y2="{LR[1]:.1f}"/>'
        f'<line x1="{LL[0]:.1f}" y1="{LL[1]:.1f}" x2="{UR[0]:.1f}" y2="{UR[1]:.1f}"/></g>'
    )
    for k in ("left", "right", "top", "bottom"):
        dy = offset if k == "bottom" else 0.0
        body.append(f'<polygon points="{pts(inset(mods[k], gap), dy)}" fill="{fills[k]}"/>')
    if highlight:
        a, b, c, _ = inset(mods["top"], gap)
        body.append(
            f'<polyline points="{pts([a, b, c])}" fill="none" stroke="#8FA5FF" stroke-width="10" '
            'stroke-linejoin="round" stroke-linecap="round"/>'
        )
    # Clip everything to the cube silhouette (+ the offset module) so the channel never overshoots.
    clip = f'<clipPath id="mxClip"><polygon points="{pts([TOP, UR, LR, (BOT[0], BOT[1] + offset), LL, UL])}"/></clipPath>'
    defs = (
        "<defs>"
        '<linearGradient id="mxTop" x1="0" y1="0" x2="0" y2="1">'
        '<stop offset="0" stop-color="#2E3858"/><stop offset="1" stop-color="#1C2130"/></linearGradient>'
        '<linearGradient id="mxCobalt" x1="0" y1="0" x2="1" y2="1">'
        '<stop offset="0" stop-color="#5A7BFF"/><stop offset="1" stop-color="#3552E0"/></linearGradient>'
        f"{clip}</defs>"
    )
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">'
        f"<title>ModuleX Game Studio - Module Keystone ({label})</title>{defs}"
        f'<g clip-path="url(#mxClip)">{"".join(body)}</g></svg>\n'
    )


if __name__ == "__main__":
    with open("icon.svg", "w") as f:
        f.write(build("master", gap=16, offset=22, channel=40, highlight=True, rim=0))
    with open("icon-24.svg", "w") as f:
        f.write(build("24 px", gap=34, offset=0, channel=80, highlight=False, rim=0, sides=("#232A3C", "#2C3550")))
    with open("icon-16.svg", "w") as f:
        f.write(build("16 px", gap=44, offset=0, channel=100, highlight=False, rim=0, sides=("#2A3246", "#343E5C")))
