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
using com.IvanMurzak.Godot.MCP.MainThreadDispatch;
using com.IvanMurzak.Godot.MCP.Runtime;
using com.IvanMurzak.Godot.MCP.Tools;
using Godot;
using ModuleX.Studio.Common;
using ModuleX.Studio.Tools;

namespace ModuleX.Studio.Qa
{
    /// <summary>
    /// ModuleX QA runtime host, registered as the <c>ModulexQa</c> autoload in every ModuleX game project.
    /// It does NOTHING unless the process was started by the ModuleX Studio playtest runner with
    /// <c>MODULEX_QA=1</c>: a normal run, an editor "Play", or a shipped build stays inert.
    ///
    /// <para>
    /// When enabled it follows <c>Godot-Tests/Harness/RuntimeHarness.cs</c>: build the in-game
    /// <see cref="GodotMcpRuntime"/> with an EXPLICIT tool set — <see cref="Tool_Game"/>, <see cref="Tool_Ping"/>
    /// and <see cref="Tool_RuntimeErrors"/> (auto-added by <c>WithRuntimeErrorCapture</c>) — then connect.
    /// <c>Tool_Reflection</c> (arbitrary method calls) is deliberately NOT registered, and neither is
    /// <c>Tool_Console</c> (it only ever reports the editor process). Connection settings come solely from the
    /// env the Studio sets for this process (<c>GODOT_MCP_CONNECTION_MODE=Custom</c>, <c>GODOT_MCP_HOST</c>,
    /// <c>GODOT_MCP_AUTH_OPTION=token</c>, <c>GODOT_MCP_TOKEN</c>); <c>GodotMcpConfig</c> reads them live.
    /// </para>
    ///
    /// <para>Logs exactly one status line: <c>[ModuleX-QA] connected</c>, <c>[ModuleX-QA] disabled</c>, or
    /// <c>[ModuleX-QA] connect failed: …</c>. The Studio waits for the first before running scenarios.</para>
    /// </summary>
    public partial class ModulexQaAutoload : Node
    {
        public const string AutoloadName = "ModulexQa";
        public const string ScriptPath = "res://addons/modulex_studio/Runtime/Qa/ModulexQaAutoload.cs";

        /// <summary>The explicit tool set a playtest exposes (reflection and console excluded on purpose).</summary>
        public static readonly Type[] QaToolTypes = { typeof(Tool_Game), typeof(Tool_Ping), typeof(Tool_RuntimeErrors) };

        /// <summary>Name of the pause-proof main-thread dispatcher this autoload owns (see <see cref="_Ready"/>).</summary>
        public const string DispatcherNodeName = "ModulexQaMainThreadDispatcher";

        GodotMcpRuntimeHandle? _handle;

        public override async void _Ready()
        {
            if (Engine.IsEditorHint() || !ModulexQaGate.IsEnabled(OS.GetEnvironment))
            {
                GD.Print("[ModuleX-QA] disabled");
                return;
            }

            // Keep processing while the game is paused so waits/state/screenshots still work.
            ProcessMode = ProcessModeEnum.Always;

            // Every QA tool call marshals onto the main thread through the MainThreadDispatcher queue, which is
            // drained from Node._Process. The runtime's own dispatcher sits under the tree root with the default
            // (Inherit -> Pausable) mode, so once a scenario pauses the game the queue stops draining and every
            // call hangs (GATE 9 'pause-resume', D-049). Install the dispatcher here first, as a child of this
            // Always-processing autoload: AddChild enters the tree synchronously, so GodotMcpRuntime sees a live
            // Instance and skips its own. No change to addons/godot_mcp is needed.
            if (MainThreadDispatcher.Instance == null)
                AddChild(new MainThreadDispatcher { Name = DispatcherNodeName, ProcessMode = ProcessModeEnum.Always });

            try
            {
                _handle = GodotMcpRuntime.Initialize(b => b
                    .WithTools(QaToolTypes)
                    .WithRuntimeErrorCapture()).Build();
                var ok = await _handle.Connect();
                GD.Print(ok ? "[ModuleX-QA] connected" : "[ModuleX-QA] connect failed: Connect() returned false");
            }
            catch (Exception ex)
            {
                GD.PushError($"[ModuleX-QA] connect failed: {ex.Message}");
            }
        }

        public override void _ExitTree()
        {
            var handle = _handle;
            _handle = null;
            handle?.Dispose();
        }
    }
}
