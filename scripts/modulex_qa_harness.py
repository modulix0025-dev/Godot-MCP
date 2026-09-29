#!/usr/bin/env python3
"""
ModuleX QA harness — live end-to-end check of addons/modulex_studio against a real Godot + a real
gamedev-mcp-server, the way ModuleX Game Studio will drive them. Stdlib only.

It reproduces the Studio topology proven in Phase 0 (docs/modulex/DECISIONS.md):

  * TWO servers in TOKEN mode on loopback, one per session, each with its own random token — the editor
    session and the playtest session. (A shared server maps a token to ONE plugin connection: the last
    plugin to connect wins and the other disappears — see DECISIONS.md D-008.)
  * Server command line = McpPlugin 8.6.0 ServerLaunchArguments.BuildCommandLine(..., token) verbatim:
        port=<p> plugin-timeout=10000 client-transport=streamableHttp auth=token token=<t>

Legs:
  1. editor   — boots `godot --headless --editor`, then exercises the project-* tools over REST and checks
                the MCP tools/list (project-* present; reflection-method-call and game-* hidden editor-side).
  2. playtest — boots the GAME (windowed; needs a DISPLAY, e.g. under xvfb-run) with MODULEX_QA=1 so the
                ModulexQa autoload connects the in-game runtime, then drives every game-* tool, reads the
                deliberate runtime error back, checks the screenshot has real pixels, and quits via game-quit.

Writes a JSON result ({ok, checks:[{leg,name,ok,detail}]}) and exits 0 only when every check passed.
Tokens are never printed: every string that reaches stdout or the result file is redacted.

Usage:
  xvfb-run -a -s "-screen 0 1600x1000x24" python scripts/modulex_qa_harness.py \\
      --godot <godot-mono-binary> --server <gamedev-mcp-server> --project Godot-Tests-Modulex \\
      --result modulex-qa-result.json
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zlib
from pathlib import Path

TOKENS: list[str] = []


def redact(text: str) -> str:
    for t in TOKENS:
        text = text.replace(t, "<redacted-token>")
    return text


def log(msg: str) -> None:
    print(redact(f"[modulex-qa] {msg}"), flush=True)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def http(method: str, url: str, token: str | None, body=None, timeout=60, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json, text/event-stream")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace"), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), dict(e.headers)
    except (urllib.error.URLError, ConnectionError, TimeoutError, socket.timeout) as e:
        return 0, str(e), {}


class Session:
    """One gamedev-mcp-server in token mode on loopback."""

    def __init__(self, server_bin: str, name: str, workdir: Path):
        self.name = name
        self.port = free_port()
        self.token = secrets.token_urlsafe(32)
        TOKENS.append(self.token)
        self.base = f"http://127.0.0.1:{self.port}"
        # Server stdout echoes the token: it goes to a private file that is never printed or uploaded.
        self._log = open(workdir / f"server-{name}.private.log", "wb")
        self.proc = subprocess.Popen(
            [server_bin, f"port={self.port}", "plugin-timeout=10000", "client-transport=streamableHttp",
             "auth=token", f"token={self.token}"],
            stdout=self._log, stderr=subprocess.STDOUT)

    def wait_ready(self, timeout=60) -> bool:
        end = time.time() + timeout
        while time.time() < end:
            code, _, _ = http("GET", f"{self.base}/help", None, timeout=5)
            if code == 200:
                return True
            time.sleep(0.5)
        return False

    def tool(self, name: str, args: dict | None = None, token: str | None = "default", timeout=60):
        tok = self.token if token == "default" else token
        code, text, _ = http("POST", f"{self.base}/api/tools/{name}", tok, args or {}, timeout=timeout)
        try:
            return code, json.loads(text)
        except json.JSONDecodeError:
            return code, {"raw": text}

    def ping(self, token: str | None = "default"):
        tok = self.token if token == "default" else token
        code, text, _ = http("POST", f"{self.base}/api/system-tools/ping", tok, {"message": "modulex"}, timeout=10)
        return code, text

    def wait_plugin(self, timeout=120) -> bool:
        end = time.time() + timeout
        while time.time() < end:
            code, text = self.ping()
            if code == 200 and "modulex" in text:
                return True
            time.sleep(1)
        return False

    def mcp_tool_names(self) -> list[str]:
        """Minimal streamable-HTTP MCP client: initialize → notifications/initialized → tools/list."""
        url = f"{self.base}/mcp"

        def rpc(payload, sid=None):
            hdr = {"Mcp-Session-Id": sid} if sid else {}
            code, text, headers = http("POST", url, self.token, payload, timeout=30, headers=hdr)
            msg = None
            if text.lstrip().startswith("{"):
                msg = json.loads(text)
            else:  # text/event-stream: take the last `data:` JSON message
                for line in text.splitlines():
                    if line.startswith("data:"):
                        msg = json.loads(line[5:].strip())
            lower = {k.lower(): v for k, v in headers.items()}
            return code, msg, lower.get("mcp-session-id")

        _, _, sid = rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "modulex-qa", "version": "0.1.0"}}})
        rpc({"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
        _, msg, _ = rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}, sid)
        return sorted(t["name"] for t in (msg or {}).get("result", {}).get("tools", []))

    def stop(self):
        self.proc.terminate()
        try:
            self.proc.wait(10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self._log.close()


def structured(resp: dict):
    return (resp or {}).get("structured", {}).get("result") if isinstance(resp, dict) else None


def png_stats(data: bytes):
    """(width, height, distinct sampled pixel values) for an 8-bit RGB/RGBA PNG — no PIL needed."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    i, idat = 8, b""
    w = h = 0
    ct = 6
    while i < len(data):
        (ln,) = struct.unpack(">I", data[i:i + 4])
        kind = data[i + 4:i + 8]
        if kind == b"IHDR":
            w, h, _, ct = struct.unpack(">IIBB", data[i + 8:i + 18])
        elif kind == b"IDAT":
            idat += data[i + 8:i + 8 + ln]
        i += 12 + ln
    raw = zlib.decompress(idat)
    bpp = 4 if ct == 6 else 3
    stride = 1 + w * bpp
    samples = set()
    for y in range(0, h, max(1, h // 40)):
        row = raw[y * stride + 1:(y + 1) * stride]  # filter byte skipped; filtered bytes still vary with content
        for x in range(0, w, max(1, w // 40)):
            samples.add(row[x * bpp:(x + 1) * bpp])
    return w, h, len(samples)


class Checks:
    def __init__(self):
        self.items = []

    def add(self, leg, name, ok, detail=""):
        self.items.append({"leg": leg, "name": name, "ok": bool(ok), "detail": redact(str(detail))[:600]})
        log(f"{'PASS' if ok else 'FAIL'} [{leg}] {name}" + ("" if ok else f" :: {redact(str(detail))[:300]}"))

    @property
    def ok(self):
        return bool(self.items) and all(c["ok"] for c in self.items)


def godot_env(session: Session, extra: dict | None = None) -> dict:
    env = dict(os.environ)
    for k in list(env):
        if k.startswith("GODOT_MCP_") or k == "MODULEX_QA":
            env.pop(k)
    env.update({
        "GODOT_MCP_CONNECTION_MODE": "Custom",
        "GODOT_MCP_HOST": session.base,
        "GODOT_MCP_AUTH_OPTION": "token",
        "GODOT_MCP_TOKEN": session.token,
    })
    env.update(extra or {})
    return env


def editor_leg(args, work: Path, c: Checks):
    leg = "editor"
    s = Session(args.server, "editor", work)
    editor = None
    try:
        c.add(leg, "server ready (/help)", s.wait_ready())
        code, _ = s.ping(token=None)
        c.add(leg, "ping without bearer is refused (401)", code == 401, code)
        code, _ = s.ping(token="wrong-token")
        c.add(leg, "ping with a wrong bearer is refused (401)", code == 401, code)

        elog = open(work / "editor.log", "wb")
        editor = subprocess.Popen([args.godot, "--headless", "--path", args.project, "--editor"],
                                  env=godot_env(s), stdout=elog, stderr=subprocess.STDOUT)
        c.add(leg, "editor plugin connected (ping with bearer)", s.wait_plugin(args.connect_timeout))
        time.sleep(3)  # let ModulexStudioPlugin apply its editor-side disables

        names = s.mcp_tool_names()
        c.add(leg, "MCP tools/list includes the five project-* tools",
              all(t in names for t in ("project-settings-get", "project-settings-set", "project-input-action-set",
                                       "project-autoload-set", "project-validate-resources")), names)
        c.add(leg, "MCP tools/list hides reflection-method-call editor-side", "reflection-method-call" not in names, names)
        c.add(leg, "MCP tools/list hides game-* editor-side", not any(n.startswith("game-") for n in names), names)

        _, r = s.tool("project-settings-get", {"keys": ["application/run/main_scene", "editor_plugins/enabled"]})
        res = structured(r) or {}
        c.add(leg, "project-settings-get reads main_scene",
              any(e["key"] == "application/run/main_scene" and "res://Qa/Main.tscn" in e["value"]
                  for e in res.get("settings", [])), r)
        c.add(leg, "project-settings-get refuses a non-allowlisted key",
              any("editor_plugins/enabled" in x for x in res.get("refused", [])), r)

        _, r = s.tool("project-settings-set", {"key": "editor_plugins/enabled", "value": "x"})
        c.add(leg, "project-settings-set refuses a non-allowlisted key", "error" in r and "allowlist" in r["error"], r)

        _, r = s.tool("project-input-action-set", {"action": "qa_probe", "events": [{"kind": "Key", "key": "Q"}]})
        c.add(leg, "project-input-action-set adds an action", "1 event" in json.dumps(r), r)
        _, r = s.tool("project-settings-get", {"prefix": "input/qa_probe"})
        c.add(leg, "the new action is persisted in ProjectSettings", (structured(r) or {}).get("count") == 1, r)
        _, r = s.tool("project-input-action-set", {"action": "qa_probe", "remove": True})
        c.add(leg, "project-input-action-set removes the action", "Removed" in json.dumps(r), r)

        _, r = s.tool("project-autoload-set", {"name": "Evil", "path": "/etc/passwd"})
        c.add(leg, "project-autoload-set refuses a path outside res://", "error" in r and "res://" in r["error"], r)

        _, r = s.tool("project-validate-resources", {})
        res = structured(r) or {}
        c.add(leg, "project-validate-resources walks the project and reports ok",
              res.get("ok") is True and res.get("checkedCount", 0) >= 1, r)

        _, r = s.tool("game-state-get", {})
        c.add(leg, "game-* refuses to run inside the editor", "error" in r and "editor" in r["error"], r)
    finally:
        if editor:
            editor.terminate()
            try:
                editor.wait(20)
            except subprocess.TimeoutExpired:
                editor.kill()
        s.stop()


def playtest_leg(args, work: Path, c: Checks):
    leg = "playtest"
    s = Session(args.server, "playtest", work)
    game = None
    glog_path = work / "game.log"
    try:
        c.add(leg, "server ready (/help)", s.wait_ready())
        glog = open(glog_path, "wb")
        cmd = [args.godot, "--path", args.project, "--windowed", "--resolution", "1280x720", "--position", "0,0"]
        if args.rendering_driver:
            cmd[1:1] = ["--rendering-driver", args.rendering_driver]
        game = subprocess.Popen(cmd, env=godot_env(s, {"MODULEX_QA": "1"}), stdout=glog, stderr=subprocess.STDOUT)

        end = time.time() + args.connect_timeout
        status_line = None
        while time.time() < end and game.poll() is None:
            text = glog_path.read_text("utf-8", "replace")
            if "[ModuleX-QA]" in text:
                status_line = next(l for l in text.splitlines() if "[ModuleX-QA]" in l)
                if "connected" in status_line or "failed" in status_line or "disabled" in status_line:
                    break
            time.sleep(0.5)
        c.add(leg, "ModulexQa autoload logs '[ModuleX-QA] connected'", status_line == "[ModuleX-QA] connected", status_line)
        c.add(leg, "in-game plugin answers ping", s.wait_plugin(30))

        names = s.mcp_tool_names()
        c.add(leg, "playtest tools/list = game-* + runtime-errors-* only (no reflection, no console)",
              any(n.startswith("game-") for n in names) and "reflection-method-call" not in names
              and not any(n.startswith("console-") for n in names)
              and all(n.startswith("game-") or n.startswith("runtime-errors-") for n in names), names)

        code, _ = s.tool("game-state-get", {}, token=None)
        c.add(leg, "game tool without bearer is refused (401)", code == 401, code)

        _, r = s.tool("game-state-get")
        st1 = structured(r) or {}
        c.add(leg, "game-state-get: main scene + player found",
              st1.get("currentScene") == "res://Qa/Main.tscn" and st1.get("playerFound") is True, r)
        _, r = s.tool("game-wait", {"frames": 20})
        c.add(leg, "game-wait frames is satisfied", (structured(r) or {}).get("satisfied") is True, r)
        _, r = s.tool("game-state-get")
        st2 = structured(r) or {}
        c.add(leg, "frame counter advances (no hang)", st2.get("frame", 0) > st1.get("frame", 0), (st1.get("frame"), st2.get("frame")))

        z0 = (st2.get("playerGlobalPosition") or [0, 0, 0])[2]
        _, r = s.tool("game-input-action", {"action": "move_forward", "holdFrames": 30})
        c.add(leg, "game-input-action holds and releases", (structured(r) or {}).get("released") is True, r)
        _, r = s.tool("game-state-get")
        z1 = ((structured(r) or {}).get("playerGlobalPosition") or [0, 0, 0])[2]
        c.add(leg, "held move_forward moves the player (z decreases)", z1 < z0 - 0.1, (z0, z1))

        _, r = s.tool("game-input-action", {"action": "does_not_exist"})
        c.add(leg, "game-input-action rejects unknown actions", "error" in r and "Unknown input action" in r["error"], r)

        _, r = s.tool("game-wait", {"untilSignal": "Player:jumped", "seconds": 5, "pressAction": "jump", "pressHoldFrames": 5})
        c.add(leg, "game-wait(pressAction=jump, untilSignal=Player:jumped) is satisfied",
              (structured(r) or {}).get("satisfied") is True, r)

        _, r = s.tool("runtime-errors-get", {"sinceSequence": 0})
        res = structured(r) or {}
        errs = res.get("errors", [])
        hit = [e for e in errs if "deliberate jump error" in e.get("message", "")]
        c.add(leg, "runtime-errors-get captures the in-game push_error", res.get("available") and hit, r)
        c.add(leg, "captured error carries the GDScript frame (engine logger, 4.5+)",
              bool(hit) and any(f.get("file") == "res://Qa/player.gd" for f in hit[0].get("frames", [])), hit[:1])

        _, r = s.tool("game-node-find", {"group": "player"})
        c.add(leg, "game-node-find finds the player by group", (structured(r) or {}).get("count") == 1, r)

        _, r = s.tool("game-ui-inspect", {})
        res = structured(r) or {}
        ov = res.get("interactiveOverlaps", [])
        c.add(leg, "game-ui-inspect detects the deliberate Start/Quit overlap",
              res.get("ok") is False and any({o["a"], o["b"]} == {"/root/Main/HUD/Start", "/root/Main/HUD/Quit"} for o in ov), r)

        _, r = s.tool("game-scene-change", {"scenePath": "res://../escape.tscn"})
        c.add(leg, "game-scene-change refuses paths outside res://", "error" in r, r)

        _, r = s.tool("game-screenshot", {})
        img = next((x for x in (r.get("content") or []) if x.get("type") == "image"), None) if isinstance(r, dict) else None
        stats = png_stats(base64.b64decode(img["data"])) if img else None
        if img:
            (work / "game-screenshot.png").write_bytes(base64.b64decode(img["data"]))
        c.add(leg, "game-screenshot returns a 1280x720 PNG with real pixels",
              stats is not None and stats[0] == 1280 and stats[1] == 720 and stats[2] >= 5, stats or r)

        _, r = s.tool("game-quit", {"exitCode": 0})
        c.add(leg, "game-quit acknowledged", "Quitting" in json.dumps(r), r)
        try:
            rc = game.wait(20)
        except subprocess.TimeoutExpired:
            rc = None
        c.add(leg, "game process exits 0 after game-quit", rc == 0, rc)
    finally:
        if game and game.poll() is None:
            game.kill()
        s.stop()


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="ModuleX QA live harness")
    p.add_argument("--godot", required=True)
    p.add_argument("--server", required=True)
    p.add_argument("--project", default="Godot-Tests-Modulex")
    p.add_argument("--result", default="modulex-qa-result.json")
    p.add_argument("--workdir", default="modulex-qa-work")
    p.add_argument("--rendering-driver", default="opengl3", help="'' to use the project default")
    p.add_argument("--connect-timeout", type=int, default=120)
    p.add_argument("--legs", default="editor,playtest")
    args = p.parse_args(argv)

    work = Path(args.workdir)
    work.mkdir(parents=True, exist_ok=True)
    c = Checks()
    legs = [l.strip() for l in args.legs.split(",") if l.strip()]
    for name, fn in (("editor", editor_leg), ("playtest", playtest_leg)):
        if name in legs:
            try:
                fn(args, work, c)
            except Exception as e:  # a crashed leg is a failed leg, never a silent pass
                c.add(name, "leg completed without an exception", False, repr(e))

    # Defence in depth: the editor/game logs are uploaded as CI evidence, so scrub any token that leaked into
    # them. (The *.private.log server logs echo the token by design and are never uploaded.)
    for f in work.glob("*.log"):
        if not f.name.endswith(".private.log"):
            f.write_text(redact(f.read_text("utf-8", "replace")), "utf-8")

    Path(args.result).write_text(json.dumps({"ok": c.ok, "checks": c.items}, indent=2), "utf-8")
    failed = [x for x in c.items if not x["ok"]]
    log(f"{len(c.items) - len(failed)}/{len(c.items)} checks passed -> {'OK' if c.ok else 'FAILED'}")
    return 0 if c.ok else 1


if __name__ == "__main__":
    sys.exit(main())
