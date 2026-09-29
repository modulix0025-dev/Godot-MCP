/*
┌──────────────────────────────────────────────────────────────────┐
│  Author: Ivan Murzak (https://github.com/IvanMurzak)             │
│  Repository: GitHub (https://github.com/IvanMurzak/Godot-MCP)    │
│  Copyright (c) 2026 Ivan Murzak                                  │
│  Licensed under the Apache License, Version 2.0.                 │
│  See the LICENSE file in the project root for more information.  │
└──────────────────────────────────────────────────────────────────┘
*/
#if TOOLS
#nullable enable
using com.IvanMurzak.Godot.MCP;
using com.IvanMurzak.Godot.MCP.Connection;
using Godot;
using ModuleX.Studio.Qa;
using ModuleX.Studio.Tools;

namespace ModuleX.Studio
{
    /// <summary>
    /// Editor side of the ModuleX Studio addon. It has no UI; on enable it:
    /// <list type="number">
    ///   <item>registers the <c>ModulexQa</c> autoload (env-gated QA runtime) when the project lacks it;</item>
    ///   <item>once the Godot-MCP editor connection exists, disables — defence in depth behind the Studio
    ///   policy gateway — <c>reflection-method-call</c> (arbitrary code execution) and the <c>game-*</c> tools
    ///   (they only make sense inside a playtest game, never in the editor).</item>
    /// </list>
    /// The Godot-MCP plugin boots its connection on its own schedule, so step 2 polls briefly (≤ 60 s) until
    /// <see cref="GodotMcpPlugin.ActiveConnection"/> accepts the toggle. <c>SetFeatureEnabled</c> persists the
    /// choice in <c>user://godot-mcp-config.json</c>, which only the editor reads (the in-game runtime never
    /// loads it), so a playtest keeps its <c>game-*</c> tools.
    /// </summary>
    [Tool]
    public partial class ModulexStudioPlugin : EditorPlugin
    {
        /// <summary>Tools disabled on the EDITOR connection.</summary>
        public static readonly string[] EditorDisabledTools = BuildEditorDisabledTools();

        const double PollIntervalSeconds = 1.0;
        const int MaxPolls = 60;

        Timer? _timer;
        int _polls;

        public override void _EnterTree()
        {
            EnsureQaAutoload();

            _timer = new Timer { WaitTime = PollIntervalSeconds, OneShot = false, Autostart = true };
            _timer.Timeout += OnPoll;
            AddChild(_timer);
            GD.Print("[ModuleX] studio addon loaded");
        }

        public override void _ExitTree()
        {
            StopTimer();
        }

        void EnsureQaAutoload()
        {
            var key = "autoload/" + ModulexQaAutoload.AutoloadName;
            if (ProjectSettings.HasSetting(key))
                return;
            AddAutoloadSingleton(ModulexQaAutoload.AutoloadName, ModulexQaAutoload.ScriptPath);
            GD.Print($"[ModuleX] registered autoload '{ModulexQaAutoload.AutoloadName}'.");
        }

        void OnPoll()
        {
            _polls++;
            var connection = GodotMcpPlugin.ActiveConnection;
            var applied = connection != null && TryDisable(connection);
            if (applied)
            {
                GD.Print($"[ModuleX] disabled on the editor connection: {string.Join(", ", EditorDisabledTools)}");
                StopTimer();
            }
            else if (_polls >= MaxPolls)
            {
                GD.PushWarning("[ModuleX] could not reach the Godot-MCP connection to disable reflection-method-call; " +
                    "the Studio policy gateway still blocks it.");
                StopTimer();
            }
        }

        static bool TryDisable(GodotMcpConnection connection)
        {
            foreach (var tool in EditorDisabledTools)
            {
                if (!connection.SetFeatureEnabled(GodotMcpFeatureKind.Tools, tool, false))
                    return false; // tool manager not built yet — retry on the next poll
            }
            return true;
        }

        void StopTimer()
        {
            if (_timer == null) return;
            _timer.Stop();
            _timer.Timeout -= OnPoll;
            _timer.QueueFree();
            _timer = null;
        }

        static string[] BuildEditorDisabledTools()
        {
            var list = new System.Collections.Generic.List<string>
            {
                com.IvanMurzak.Godot.MCP.Tools.Tool_Reflection.ReflectionMethodCallToolId,
            };
            list.AddRange(Tool_Game.AllToolIds);
            return list.ToArray();
        }
    }
}
#endif
