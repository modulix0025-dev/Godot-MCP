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
using System;
using com.IvanMurzak.McpPlugin;
using Godot;

namespace ModuleX.Studio.Tools
{
    /// <summary>
    /// ModuleX project-configuration tool family (<c>project-*</c>): allowlisted ProjectSettings read/write,
    /// input actions, autoloads, and a whole-project resource validator. These replace what an agent could
    /// otherwise only do through the unrestricted <c>reflection-method-call</c>.
    ///
    /// <para>
    /// Editor-only (<c>#if TOOLS</c>): it edits and saves <c>project.godot</c> and walks <c>res://</c> in the
    /// editor. The allowlist, path rules, input-event validation and dependency parsing are pure-managed
    /// helpers in <c>addons/modulex_studio/Common/</c>, unit-tested in <c>Godot-MCP.Tests</c>. Every handler
    /// marshals onto the editor main thread through <c>MainThread.Instance.Run</c>.
    /// </para>
    /// </summary>
    [AiToolType]
    public partial class Tool_Project
    {
        static void SaveProjectSettings()
        {
            var err = ProjectSettings.Save();
            if (err != Error.Ok)
                throw new InvalidOperationException($"ProjectSettings.Save() failed: {err}.");
        }
    }
}
#endif
