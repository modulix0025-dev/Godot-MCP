/*
┌──────────────────────────────────────────────────────────────────┐
│  Author: Ivan Murzak (https://github.com/IvanMurzak)             │
│  Repository: GitHub (https://github.com/IvanMurzak/Godot-MCP)    │
│  Copyright (c) 2026 Ivan Murzak                                  │
│  Licensed under the Apache License, Version 2.0.                 │
│  See the LICENSE file in the project root for more information.  │
└──────────────────────────────────────────────────────────────────┘
*/
#nullable enable
using System.ComponentModel;
using com.IvanMurzak.Godot.MCP.Tools;
using com.IvanMurzak.McpPlugin;
using com.IvanMurzak.McpPlugin.Common.Model;
using Godot;

namespace ModuleX.Studio.Tools
{
    public partial class Tool_Game
    {
        public const string GameScreenshotToolId = "game-screenshot";

        [AiTool
        (
            GameScreenshotToolId,
            Title = "Game / Screenshot",
            ReadOnlyHint = true,
            IdempotentHint = true,
            OpenWorldHint = false
        )]
        [Description("Capture the RUNNING game's main viewport (what the player sees) and return it as a PNG " +
            "image. The longest edge is capped for transport (aspect preserved). Requires a real renderer: a " +
            "game started with '--headless' (the dummy renderer) returns a structured error instead of a blank " +
            "image — the ModuleX playtest runner launches visual playtests windowed for this reason.")]
        public ResponseCallTool Screenshot()
        {
            EnsureGameProcess();
            return OnMain(() =>
            {
                if (DisplayServer.GetName() == "headless")
                    return ResponseCallTool.Error("The game runs with the headless display server (no renderer), so " +
                        "there are no pixels to capture. Launch the playtest windowed (without '--headless').");

                var texture = Tree().Root.GetTexture();
                var image = texture?.GetImage();
                if (image == null || image.IsEmpty() || image.GetWidth() <= 0 || image.GetHeight() <= 0)
                    return ResponseCallTool.Error("The game viewport read back an empty image (no GPU render yet). " +
                        "Wait a few frames after boot ('game-wait') and retry.");

                var (w, h) = ScreenshotMath.ClampToTransportLimit(image.GetWidth(), image.GetHeight());
                if (w != image.GetWidth() || h != image.GetHeight())
                    image.Resize(w, h, Image.Interpolation.Bilinear);

                var png = image.SavePngToBuffer();
                if (png == null || png.Length == 0)
                    return ResponseCallTool.Error("PNG encode produced no bytes.");

                return ResponseCallTool.Image(png, com.IvanMurzak.McpPlugin.Common.Consts.MimeType.ImagePng,
                    $"Game viewport screenshot {w}x{h} ({png.Length} bytes PNG)");
            });
        }
    }
}
