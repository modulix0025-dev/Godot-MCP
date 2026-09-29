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

namespace ModuleX.Studio.Common
{
    /// <summary>
    /// Pure validation of <c>res://</c> paths handed in by the agent. Rejects anything outside the project
    /// (absolute OS paths, <c>user://</c>, <c>..</c> traversal, backslashes) so a tool can never be pointed at a
    /// file outside <c>res://</c>.
    /// </summary>
    public static class ResPathRules
    {
        public const string Prefix = "res://";

        /// <summary>Returns null when <paramref name="path"/> is a safe project path, else the refusal reason.</summary>
        public static string? Validate(string? path, params string[] allowedExtensions)
        {
            if (string.IsNullOrWhiteSpace(path))
                return "Path must not be empty.";
            var p = path!.Trim();
            if (!p.StartsWith(Prefix, StringComparison.Ordinal))
                return $"Path '{path}' must start with 'res://'.";
            if (p.Contains('\\') || p.Contains('\0'))
                return $"Path '{path}' contains an illegal character.";
            var rest = p.Substring(Prefix.Length);
            if (rest.Length == 0)
                return "Path must name a file under res://.";
            foreach (var seg in rest.Split('/'))
            {
                if (seg == ".." || seg == ".")
                    return $"Path '{path}' must not contain '.' or '..' segments.";
            }
            if (allowedExtensions.Length > 0)
            {
                foreach (var ext in allowedExtensions)
                {
                    if (p.EndsWith(ext, StringComparison.OrdinalIgnoreCase))
                        return null;
                }
                return $"Path '{path}' must end with one of: {string.Join(", ", allowedExtensions)}.";
            }
            return null;
        }

        /// <summary>True for a valid GDScript/Godot identifier usable as an autoload / action name.</summary>
        public static bool IsIdentifier(string? name, int maxLength = 64)
        {
            if (string.IsNullOrEmpty(name) || name!.Length > maxLength)
                return false;
            var first = name[0];
            if (!(char.IsLetter(first) && first < 128) && first != '_')
                return false;
            for (var i = 1; i < name.Length; i++)
            {
                var c = name[i];
                if (!((c < 128 && char.IsLetterOrDigit(c)) || c == '_'))
                    return false;
            }
            return true;
        }
    }
}
