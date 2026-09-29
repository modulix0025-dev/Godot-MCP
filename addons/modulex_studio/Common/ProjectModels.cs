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
using System.Collections.Generic;
using System.ComponentModel;
using System.Text.Json.Serialization;

namespace ModuleX.Studio.Common
{
    /// <summary>Value type hint for <c>project-settings-set</c>.</summary>
    public enum SettingValueType
    {
        String,
        Int,
        Float,
        Bool,
        /// <summary>Godot text syntax parsed with <c>GD.StrToVar</c>, e.g. <c>Vector2i(1280, 720)</c>.</summary>
        Variant,
    }

    public class ProjectSettingEntry
    {
        [JsonInclude, JsonPropertyName("key")] public string Key { get; set; } = string.Empty;
        [JsonInclude, JsonPropertyName("value")]
        [Description("Value in Godot text syntax (GD.VarToStr).")]
        public string? Value { get; set; }
        [JsonInclude, JsonPropertyName("type")] public string? Type { get; set; }
    }

    public class ProjectSettingsResult
    {
        [JsonInclude, JsonPropertyName("count")] public int Count { get; set; }
        [JsonInclude, JsonPropertyName("settings")] public List<ProjectSettingEntry> Settings { get; set; } = new();
        [JsonInclude, JsonPropertyName("refused")]
        [Description("Requested keys outside the allowlist or not present, with the reason.")]
        public List<string> Refused { get; set; } = new();
    }

    /// <summary>One problem found by <c>project-validate-resources</c>.</summary>
    public class ResourceProblem
    {
        [JsonInclude, JsonPropertyName("path")] public string Path { get; set; } = string.Empty;
        [JsonInclude, JsonPropertyName("kind")]
        [Description("'load_failed', 'missing_dependency' or 'broken_uid'.")]
        public string Kind { get; set; } = string.Empty;
        [JsonInclude, JsonPropertyName("detail")] public string Detail { get; set; } = string.Empty;
    }

    public class ResourceValidationResult
    {
        [JsonInclude, JsonPropertyName("ok")] public bool Ok { get; set; }
        [JsonInclude, JsonPropertyName("scope")] public string Scope { get; set; } = "res://";
        [JsonInclude, JsonPropertyName("checkedCount")] public int CheckedCount { get; set; }
        [JsonInclude, JsonPropertyName("truncated")] public bool Truncated { get; set; }
        [JsonInclude, JsonPropertyName("problems")] public List<ResourceProblem> Problems { get; set; } = new();
    }
}
