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
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using com.IvanMurzak.McpPlugin;
using com.IvanMurzak.ReflectorNet.Utils;
using Godot;
using ModuleX.Studio.Common;

namespace ModuleX.Studio.Tools
{
    public partial class Tool_Project
    {
        public const string ProjectSettingsGetToolId = "project-settings-get";

        const int MaxSettings = 500;

        [AiTool
        (
            ProjectSettingsGetToolId,
            Title = "Project / Settings / Get",
            ReadOnlyHint = true,
            IdempotentHint = true,
            OpenWorldHint = false
        )]
        [Description("Read ProjectSettings values from the ModuleX allowlist: application/run/main_scene, " +
            "application/config/name, application/config/version, display/window/*, rendering/*, input/*, " +
            "autoload/*, layer_names/*, physics/*. Pass explicit 'keys', or a 'prefix' (e.g. 'input/', " +
            "'autoload/') to list every allowlisted key under it. Values are returned in Godot text syntax. " +
            "Keys outside the allowlist are listed in 'refused' with the reason.")]
        public ProjectSettingsResult SettingsGet
        (
            [Description("Exact keys to read, e.g. ['application/run/main_scene'].")]
            string[]? keys = null,
            [Description("List every allowlisted key starting with this prefix, e.g. 'input/'.")]
            string? prefix = null
        )
        {
            if ((keys == null || keys.Length == 0) && string.IsNullOrWhiteSpace(prefix))
                throw new ArgumentException("Pass 'keys' or 'prefix'.");

            return MainThread.Instance.Run(() =>
            {
                var result = new ProjectSettingsResult();
                var wanted = new List<string>();
                if (keys != null)
                    wanted.AddRange(keys);
                if (!string.IsNullOrWhiteSpace(prefix))
                {
                    wanted.AddRange(ProjectSettings.Singleton.GetPropertyList()
                        .Select(p => p["name"].AsString())
                        .Where(n => n.StartsWith(prefix!, StringComparison.Ordinal)));
                }

                foreach (var key in wanted.Distinct(StringComparer.Ordinal))
                {
                    if (result.Settings.Count >= MaxSettings)
                        break;
                    var refusal = ProjectSettingsAllowlist.RefusalReason(key, write: false);
                    if (refusal != null)
                    {
                        // A prefix listing silently skips non-allowlisted neighbours; explicit keys report why.
                        if (keys != null && keys.Contains(key))
                            result.Refused.Add($"{key}: {refusal}");
                        continue;
                    }
                    if (!ProjectSettings.HasSetting(key))
                    {
                        if (keys != null && keys.Contains(key))
                            result.Refused.Add($"{key}: not set in this project.");
                        continue;
                    }
                    var value = ProjectSettings.GetSetting(key);
                    result.Settings.Add(new ProjectSettingEntry
                    {
                        Key = key,
                        Value = GD.VarToStr(value),
                        Type = value.VariantType.ToString(),
                    });
                }
                result.Count = result.Settings.Count;
                return result;
            });
        }
    }
}
#endif
