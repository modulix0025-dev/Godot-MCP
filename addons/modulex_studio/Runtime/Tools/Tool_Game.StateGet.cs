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
using com.IvanMurzak.McpPlugin;
using Godot;
using ModuleX.Studio.Data;

namespace ModuleX.Studio.Tools
{
    public partial class Tool_Game
    {
        public const string GameStateGetToolId = "game-state-get";

        /// <summary>Group the QA runtime treats as "the player".</summary>
        public const string PlayerGroup = "player";

        [AiTool
        (
            GameStateGetToolId,
            Title = "Game / State / Get",
            ReadOnlyHint = true,
            IdempotentHint = true,
            OpenWorldHint = false
        )]
        [Description("Snapshot of the RUNNING game (ModuleX playtest process): current scene, process frame " +
            "counter, fps, time scale, pause state, window size, node count, the display server, and whether a " +
            "node in the 'player' group exists (with its global position). Poll 'frame' to detect hangs: if it " +
            "does not advance between two calls a few seconds apart, the game loop is stuck.")]
        public GameStateResult StateGet()
        {
            EnsureGameProcess();
            return OnMain(() =>
            {
                var tree = Tree();
                var player = tree.GetFirstNodeInGroup(PlayerGroup);
                var size = DisplayServer.WindowGetSize();
                return new GameStateResult
                {
                    CurrentScene = tree.CurrentScene?.SceneFilePath is { Length: > 0 } p ? p : null,
                    Frame = Engine.GetProcessFrames(),
                    Fps = Engine.GetFramesPerSecond(),
                    TimeScale = Engine.TimeScale,
                    Paused = tree.Paused,
                    WindowSize = new[] { size.X, size.Y },
                    PlayerFound = player != null,
                    PlayerPath = player != null ? player.GetPath().ToString() : null,
                    PlayerGlobalPosition = player != null ? GlobalPositionOf(player) : null,
                    NodeCount = tree.GetNodeCount(),
                    DisplayServer = DisplayServer.GetName(),
                };
            });
        }
    }
}
