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
using System.Globalization;
using com.IvanMurzak.McpPlugin;
using com.IvanMurzak.ReflectorNet.Utils;
using Godot;
using ModuleX.Studio.Common;

namespace ModuleX.Studio.Tools
{
    public partial class Tool_Project
    {
        public const string ProjectSettingsSetToolId = "project-settings-set";

        const string MainSceneKey = "application/run/main_scene";

        [AiTool
        (
            ProjectSettingsSetToolId,
            Title = "Project / Settings / Set",
            DestructiveHint = true,
            IdempotentHint = true,
            OpenWorldHint = false
        )]
        [Description("Write ONE ProjectSettings value from the ModuleX writable allowlist " +
            "(application/run/main_scene, application/config/name, application/config/version, display/window/*, " +
            "layer_names/*) and save project.godot. Input actions use 'project-input-action-set'; autoloads use " +
            "'project-autoload-set'; rendering/* and physics/* are read-only. 'valueType' says how to parse " +
            "'value': String, Int, Float, Bool, or Variant (Godot text syntax, e.g. 'Vector2i(1280, 720)'). " +
            "Setting main_scene requires an existing res:// .tscn/.scn.")]
        public ProjectSettingEntry SettingsSet
        (
            [Description("Setting key, e.g. 'application/run/main_scene' or 'display/window/size/viewport_width'.")]
            string key,
            [Description("New value as text (parsed according to 'valueType').")]
            string value,
            [Description("How to parse 'value': String (default), Int, Float, Bool, Variant.")]
            SettingValueType valueType = SettingValueType.String
        )
        {
            var refusal = ProjectSettingsAllowlist.RefusalReason(key, write: true);
            if (refusal != null)
                throw new ArgumentException(refusal, nameof(key));
            if (value == null)
                throw new ArgumentException("value is required.", nameof(value));
            if (key == MainSceneKey)
            {
                var invalid = ResPathRules.Validate(value, ".tscn", ".scn");
                if (invalid != null)
                    throw new ArgumentException(invalid, nameof(value));
            }

            return MainThread.Instance.Run(() =>
            {
                if (key == MainSceneKey && !ResourceLoader.Exists(value))
                    throw new ArgumentException($"No scene exists at '{value}'.", nameof(value));

                Variant parsed = valueType switch
                {
                    SettingValueType.String => value,
                    SettingValueType.Int => long.Parse(value, NumberStyles.Integer, CultureInfo.InvariantCulture),
                    SettingValueType.Float => double.Parse(value, NumberStyles.Float, CultureInfo.InvariantCulture),
                    SettingValueType.Bool => bool.Parse(value),
                    SettingValueType.Variant => GD.StrToVar(value),
                    _ => throw new ArgumentOutOfRangeException(nameof(valueType)),
                };
                if (valueType == SettingValueType.Variant && parsed.VariantType == Variant.Type.Nil)
                    throw new ArgumentException($"Could not parse '{value}' as a Godot Variant.", nameof(value));

                ProjectSettings.SetSetting(key, parsed);
                SaveProjectSettings();
                var stored = ProjectSettings.GetSetting(key);
                return new ProjectSettingEntry { Key = key, Value = GD.VarToStr(stored), Type = stored.VariantType.ToString() };
            });
        }
    }
}
#endif
