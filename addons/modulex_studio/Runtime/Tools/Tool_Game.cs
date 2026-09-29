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
using System.Threading;
using com.IvanMurzak.McpPlugin;
using com.IvanMurzak.ReflectorNet.Utils;
using Godot;

namespace ModuleX.Studio.Tools
{
    /// <summary>
    /// ModuleX runtime QA tool family (<c>game-*</c>). These tools run INSIDE a playtest game process that the
    /// ModuleX Studio launched with <c>MODULEX_QA=1</c>; <c>ModulexQaAutoload</c> registers them explicitly with
    /// <c>GodotMcpRuntime</c>. They give the QA agent eyes and hands in the running game: state, screenshot,
    /// input, scene change, node/UI queries, bounded waits and quit.
    ///
    /// <para>
    /// Runtime code (NOT <c>#if TOOLS</c>): it ships into a debug export and must never touch an editor API —
    /// <c>scripts/check-runtime-boundary.py</c> enforces that. Every Godot call is marshalled onto the game main
    /// thread through <see cref="MainThread"/> (the runtime installs the dispatcher).
    /// </para>
    ///
    /// <para>
    /// Because Godot compiles every project <c>.cs</c> into one assembly, the editor connection ALSO discovers
    /// this family. Inside the editor these tools would act on the editor's own SceneTree (and <c>game-quit</c>
    /// would close the editor), so every entry point refuses to run when <see cref="Engine.IsEditorHint"/> is
    /// true, and <c>ModulexStudioPlugin</c> additionally disables them on the editor connection.
    /// </para>
    /// </summary>
    [AiToolType]
    public partial class Tool_Game
    {
        /// <summary>All tool ids of this family (used by the editor plugin to disable them editor-side).</summary>
        public static readonly string[] AllToolIds =
        {
            GameStateGetToolId, GameScreenshotToolId, GameInputActionToolId, GameSceneChangeToolId,
            GameNodeFindToolId, GameUiInspectToolId, GameWaitToolId, GameQuitToolId,
        };

        static void EnsureGameProcess()
        {
            if (Engine.IsEditorHint())
                throw new InvalidOperationException(
                    "game-* tools only run inside a playtest game process started by ModuleX Studio " +
                    "(MODULEX_QA=1). They are refused inside the Godot editor.");
        }

        static SceneTree Tree()
            => Engine.GetMainLoop() as SceneTree
               ?? throw new InvalidOperationException("The main loop is not a SceneTree.");

        /// <summary>Run on the game main thread (inline when already on it).</summary>
        static T OnMain<T>(Func<T> func) => MainThread.Instance.Run(func);

        static void OnMain(Action action) => MainThread.Instance.Run(action);

        /// <summary>
        /// Block the CALLING (non-main) thread until <paramref name="done"/> returns true (evaluated on the main
        /// thread) or the timeout elapses. Returns true when satisfied. Refuses to run on the main thread, where
        /// blocking would freeze the very frames it waits for.
        /// </summary>
        static bool WaitUntil(Func<bool> done, TimeSpan timeout, int pollMs = 15)
        {
            if (MainThread.Instance.IsMainThread)
                throw new InvalidOperationException("Waiting on the game main thread would deadlock the game loop.");
            var deadline = DateTime.UtcNow + timeout;
            while (DateTime.UtcNow < deadline)
            {
                if (OnMain(done))
                    return true;
                Thread.Sleep(pollMs);
            }
            return OnMain(done);
        }

        static float[]? GlobalPositionOf(Node node) => node switch
        {
            Node3D n3 => new[] { n3.GlobalPosition.X, n3.GlobalPosition.Y, n3.GlobalPosition.Z },
            Node2D n2 => new[] { n2.GlobalPosition.X, n2.GlobalPosition.Y },
            Control c => new[] { c.GlobalPosition.X, c.GlobalPosition.Y },
            _ => null,
        };

        static bool? VisibleOf(Node node) => node switch
        {
            Node3D n3 => n3.IsVisibleInTree(),
            CanvasItem ci => ci.IsVisibleInTree(),
            _ => null,
        };
    }
}
