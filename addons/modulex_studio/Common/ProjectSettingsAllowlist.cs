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
using System.Linq;

namespace ModuleX.Studio.Common
{
    /// <summary>
    /// Allowlist for the <c>project-settings-get</c> / <c>project-settings-set</c> tools. ProjectSettings is a
    /// flat key space that also holds security-relevant switches (editor plugins, export, network, file
    /// logging paths, .NET options), so the agent only ever sees and changes the keys below — everything else
    /// is refused with an actionable error. Pure-managed (no Godot API) so it is unit-tested in the xUnit host.
    ///
    /// <para>Matching rules: an entry ending in <c>/*</c> matches that prefix (any depth); any other entry
    /// matches the exact key. Keys are compared case-sensitively (Godot keys are lowercase).</para>
    /// </summary>
    public static class ProjectSettingsAllowlist
    {
        /// <summary>Keys the agent may READ.</summary>
        public static readonly string[] Readable =
        {
            "application/run/main_scene",
            "application/config/name",
            "application/config/version",
            "display/window/*",
            "rendering/*",
            "input/*",
            "autoload/*",
            "layer_names/*",
            "physics/*",
        };

        /// <summary>
        /// Keys the agent may WRITE. <c>rendering/*</c> and <c>physics/*</c> are read-only on purpose
        /// (renderer/driver switches can make the project unopenable); <c>autoload/*</c> is written only through
        /// <c>project-autoload-set</c> (path validation) and <c>input/*</c> only through
        /// <c>project-input-action-set</c> (event validation).
        /// </summary>
        public static readonly string[] Writable =
        {
            "application/run/main_scene",
            "application/config/name",
            "application/config/version",
            "display/window/*",
            "layer_names/*",
        };

        public static bool IsReadable(string? key) => Matches(Readable, key);

        public static bool IsWritable(string? key) => Matches(Writable, key);

        /// <summary>Returns the reason a key is refused for the given access, or null when allowed.</summary>
        public static string? RefusalReason(string? key, bool write)
        {
            if (string.IsNullOrWhiteSpace(key))
                return "Setting key must not be empty.";
            if (!IsValidKeyShape(key!))
                return $"'{key}' is not a valid ProjectSettings key (expected 'section/name', ASCII letters/digits/_/./-, no '..').";
            if (write && key!.StartsWith("input/", StringComparison.Ordinal))
                return "Input actions are written with 'project-input-action-set', not 'project-settings-set'.";
            if (write && key!.StartsWith("autoload/", StringComparison.Ordinal))
                return "Autoloads are written with 'project-autoload-set', not 'project-settings-set'.";
            var list = write ? Writable : Readable;
            if (!Matches(list, key))
                return $"'{key}' is not in the ModuleX {(write ? "writable" : "readable")} allowlist. Allowed: " +
                       string.Join(", ", list) + ".";
            return null;
        }

        /// <summary>
        /// Key shape check: at least one '/', only [A-Za-z0-9_/.-], no empty segments, no '..'. Upper case is
        /// allowed because autoload and input-action names are user-cased (e.g. <c>autoload/ModulexQa</c>).
        /// </summary>
        public static bool IsValidKeyShape(string key)
        {
            if (key.Length == 0 || key.Length > 256 || !key.Contains('/') || key.Contains(".."))
                return false;
            if (key.Split('/').Any(s => s.Length == 0))
                return false;
            return key.All(c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '/' || c == '.' || c == '-');
        }

        static bool Matches(string[] list, string? key)
        {
            if (string.IsNullOrWhiteSpace(key) || !IsValidKeyShape(key!))
                return false;
            foreach (var entry in list)
            {
                if (entry.EndsWith("/*", StringComparison.Ordinal))
                {
                    var prefix = entry.Substring(0, entry.Length - 1); // keep the trailing '/'
                    if (key!.StartsWith(prefix, StringComparison.Ordinal) && key.Length > prefix.Length)
                        return true;
                }
                else if (string.Equals(entry, key, StringComparison.Ordinal))
                {
                    return true;
                }
            }
            return false;
        }
    }
}
