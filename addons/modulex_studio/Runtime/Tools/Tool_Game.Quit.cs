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
using System.Threading.Tasks;
using com.IvanMurzak.McpPlugin;
using Godot;

namespace ModuleX.Studio.Tools
{
    public partial class Tool_Game
    {
        public const string GameQuitToolId = "game-quit";

        /// <summary>Delay before quitting so the tool response reaches the server first.</summary>
        const int QuitDelayMs = 300;

        [AiTool
        (
            GameQuitToolId,
            Title = "Game / Quit",
            IdempotentHint = true,
            OpenWorldHint = false
        )]
        [Description("Quit the RUNNING playtest game with the given exit code (SceneTree.Quit). The quit happens " +
            "~300 ms after this call returns so the response is delivered; the Studio then observes the process " +
            "exit code.")]
        public string Quit
        (
            [Description("Process exit code (0..255). Default 0.")]
            int exitCode = 0
        )
        {
            EnsureGameProcess();
            if (exitCode < 0 || exitCode > 255)
                throw new ArgumentException("exitCode must be 0..255.", nameof(exitCode));

            _ = Task.Run(async () =>
            {
                await Task.Delay(QuitDelayMs).ConfigureAwait(false);
                OnMain(() => Tree().Quit(exitCode));
            });
            return $"Quitting with exit code {exitCode} in {QuitDelayMs} ms.";
        }
    }
}
