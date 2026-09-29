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
using System;
using System.ComponentModel;
using com.IvanMurzak.McpPlugin;
using Godot;
using ModuleX.Studio.Common;

namespace ModuleX.Studio.Tools
{
    public partial class Tool_Game
    {
        public const string GameSceneChangeToolId = "game-scene-change";

        [AiTool
        (
            GameSceneChangeToolId,
            Title = "Game / Scene / Change",
            IdempotentHint = false,
            OpenWorldHint = false
        )]
        [Description("Switch the RUNNING game to another scene with SceneTree.ChangeSceneToFile. The change is " +
            "applied by Godot at the end of the current frame; poll 'game-state-get' (currentScene) or use " +
            "'game-wait' to observe it. Only res:// .tscn/.scn paths that exist are accepted.")]
        public string SceneChange
        (
            [Description("res:// path of the scene to load, e.g. 'res://scenes/level_2.tscn'.")]
            string scenePath
        )
        {
            EnsureGameProcess();
            var invalid = ResPathRules.Validate(scenePath, ".tscn", ".scn");
            if (invalid != null)
                throw new ArgumentException(invalid, nameof(scenePath));

            return OnMain(() =>
            {
                if (!ResourceLoader.Exists(scenePath))
                    throw new ArgumentException($"No scene exists at '{scenePath}'.", nameof(scenePath));
                var err = Tree().ChangeSceneToFile(scenePath);
                if (err != Error.Ok)
                    throw new InvalidOperationException($"ChangeSceneToFile('{scenePath}') failed: {err}.");
                return $"Scene change to '{scenePath}' requested (applied at the end of the frame).";
            });
        }
    }
}
