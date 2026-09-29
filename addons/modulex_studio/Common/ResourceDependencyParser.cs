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
using System.Collections.Generic;
using System.Linq;

namespace ModuleX.Studio.Common
{
    /// <summary>One parsed entry of <c>ResourceLoader.GetDependencies</c>.</summary>
    public readonly record struct ResourceDependency(string? Uid, string? Type, string? Path);

    /// <summary>
    /// Pure helpers for <c>project-validate-resources</c>: which files to walk, and how to read the strings
    /// <c>ResourceLoader.GetDependencies</c> returns. Godot 4 emits either <c>"path::type"</c> (legacy) or
    /// <c>"uid://…::type::path"</c>; both are accepted.
    /// </summary>
    public static class ResourceDependencyParser
    {
        /// <summary>Extensions the validator tries to load.</summary>
        public static readonly string[] LoadableExtensions = { ".tscn", ".tres", ".res", ".glb", ".gltf", ".scn" };

        /// <summary>Directories (relative to res://, no trailing slash) the walk never descends into.</summary>
        public static readonly string[] SkippedDirectories =
        {
            ".godot", ".git", ".modulex", "addons/godot_mcp", "addons/modulex_studio", "build",
        };

        public static ResourceDependency Parse(string? raw)
        {
            if (string.IsNullOrWhiteSpace(raw))
                return new ResourceDependency(null, null, null);
            var parts = raw!.Split(new[] { "::" }, StringSplitOptions.None);
            string? uid = null, type = null, path = null;
            foreach (var p in parts)
            {
                if (p.StartsWith("uid://", StringComparison.Ordinal)) uid ??= p;
                else if (p.StartsWith("res://", StringComparison.Ordinal) || p.StartsWith("user://", StringComparison.Ordinal)) path ??= p;
                else if (p.Length > 0) type ??= p;
            }
            return new ResourceDependency(uid, type, path);
        }

        /// <summary>True when <paramref name="resPath"/> sits inside a skipped directory.</summary>
        public static bool IsSkipped(string resPath)
        {
            if (!resPath.StartsWith("res://", StringComparison.Ordinal))
                return true;
            var rel = resPath.Substring("res://".Length).TrimStart('/');
            return SkippedDirectories.Any(d => rel == d || rel.StartsWith(d + "/", StringComparison.Ordinal));
        }

        public static bool IsLoadable(string resPath)
            => LoadableExtensions.Any(e => resPath.EndsWith(e, StringComparison.OrdinalIgnoreCase));

        /// <summary>
        /// Filter a directory-walk result to the files that should be load-checked, optionally restricted to a
        /// scope prefix (e.g. a single imported asset or a folder). Stable, de-duplicated, ordinal-sorted.
        /// </summary>
        public static IReadOnlyList<string> SelectTargets(IEnumerable<string> allFiles, string? scope)
        {
            var scoped = string.IsNullOrWhiteSpace(scope) ? "res://" : scope!.Trim();
            return allFiles
                .Where(f => f.StartsWith(scoped, StringComparison.Ordinal))
                .Where(f => !IsSkipped(f) && IsLoadable(f))
                .Distinct(StringComparer.Ordinal)
                .OrderBy(f => f, StringComparer.Ordinal)
                .ToList();
        }
    }
}
