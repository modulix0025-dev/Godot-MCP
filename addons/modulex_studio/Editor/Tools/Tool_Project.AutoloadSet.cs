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
using System.ComponentModel;
using com.IvanMurzak.McpPlugin;
using com.IvanMurzak.ReflectorNet.Utils;
using Godot;
using ModuleX.Studio.Common;
using ModuleX.Studio.Qa;

namespace ModuleX.Studio.Tools
{
    public partial class Tool_Project
    {
        public const string ProjectAutoloadSetToolId = "project-autoload-set";

        [AiTool
        (
            ProjectAutoloadSetToolId,
            Title = "Project / Autoload / Set",
            DestructiveHint = true,
            IdempotentHint = true,
            OpenWorldHint = false
        )]
        [Description("Add, replace, or remove an autoload singleton in project.godot ('autoload/<name>') and " +
            "save. 'path' must be an existing res:// .gd/.cs/.tscn/.scn file; paths outside res:// are refused. " +
            "The ModuleX QA autoload ('ModulexQa') is managed by the ModuleX addon and cannot be changed here. " +
            "The editor's Autoload list refreshes on the next project reload.")]
        public string AutoloadSet
        (
            [Description("Autoload (singleton) name, an identifier, e.g. 'GameState'.")]
            string name,
            [Description("res:// path of the script or scene. Required unless remove=true.")]
            string? path = null,
            [Description("Remove the autoload instead of setting it. Default false.")]
            bool remove = false
        )
        {
            if (!ResPathRules.IsIdentifier(name))
                throw new ArgumentException($"Autoload name '{name}' must be an identifier.", nameof(name));
            if (name == ModulexQaAutoload.AutoloadName)
                throw new ArgumentException($"'{name}' is managed by the ModuleX addon.", nameof(name));

            var settingKey = "autoload/" + name;
            if (remove)
            {
                return MainThread.Instance.Run(() =>
                {
                    if (!ProjectSettings.HasSetting(settingKey))
                        return $"Autoload '{name}' does not exist; nothing removed.";
                    ProjectSettings.Clear(settingKey);
                    SaveProjectSettings();
                    return $"Removed autoload '{name}'.";
                });
            }

            var invalid = ResPathRules.Validate(path, ".gd", ".cs", ".tscn", ".scn");
            if (invalid != null)
                throw new ArgumentException(invalid, nameof(path));

            return MainThread.Instance.Run(() =>
            {
                if (!FileAccess.FileExists(path!))
                    throw new ArgumentException($"No file exists at '{path}'.", nameof(path));
                // A leading '*' marks the autoload as a global singleton (Godot's project.godot convention).
                ProjectSettings.SetSetting(settingKey, "*" + path);
                SaveProjectSettings();
                return $"Autoload '{name}' -> '{path}' saved.";
            });
        }
    }
}
#endif
