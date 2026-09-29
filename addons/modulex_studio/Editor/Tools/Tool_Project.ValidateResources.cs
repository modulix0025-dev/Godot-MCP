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
using com.IvanMurzak.McpPlugin;
using com.IvanMurzak.ReflectorNet.Utils;
using Godot;
using ModuleX.Studio.Common;

namespace ModuleX.Studio.Tools
{
    public partial class Tool_Project
    {
        public const string ProjectValidateResourcesToolId = "project-validate-resources";

        const int MaxValidatedFiles = 2000;

        [AiTool
        (
            ProjectValidateResourcesToolId,
            Title = "Project / Validate Resources",
            ReadOnlyHint = true,
            IdempotentHint = true,
            OpenWorldHint = false
        )]
        [Description("Walk res:// (skipping .godot, .git, .modulex, build, addons/godot_mcp, addons/modulex_studio) " +
            "and try to load every .tscn/.tres/.res/.scn/.glb/.gltf. Reports load failures, dependencies whose " +
            "target file is missing, and ext_resource UIDs that no longer resolve ('broken_uid' — Godot falls back " +
            "to the path, but the reference is stale). 'scope' restricts the walk to a folder or a single file " +
            "(e.g. one freshly imported asset). 'ok' is true when no problems were found.")]
        public ResourceValidationResult ValidateResources
        (
            [Description("res:// folder or file to validate. Default 'res://' (whole project).")]
            string scope = "res://"
        )
        {
            var normalizedScope = string.IsNullOrWhiteSpace(scope) ? "res://" : scope.Trim();
            if (normalizedScope != "res://")
            {
                var invalid = ResPathRules.Validate(normalizedScope);
                if (invalid != null)
                    throw new ArgumentException(invalid, nameof(scope));
            }

            return MainThread.Instance.Run(() =>
            {
                var files = new List<string>();
                var isFile = normalizedScope != "res://" && FileAccess.FileExists(normalizedScope);
                if (isFile) files.Add(normalizedScope);
                else CollectFiles(normalizedScope == "res://" ? "res://" : normalizedScope.TrimEnd('/'), files);

                var targets = ResourceDependencyParser.SelectTargets(files, isFile ? normalizedScope : null);
                var result = new ResourceValidationResult { Scope = normalizedScope, Truncated = targets.Count > MaxValidatedFiles };

                var checkedCount = 0;
                foreach (var path in targets)
                {
                    if (checkedCount >= MaxValidatedFiles) break;
                    checkedCount++;

                    foreach (var raw in ResourceLoader.GetDependencies(path))
                    {
                        var dep = ResourceDependencyParser.Parse(raw);
                        var uidOk = true;
                        if (dep.Uid != null)
                        {
                            var id = ResourceUid.TextToId(dep.Uid);
                            uidOk = id != ResourceUid.InvalidId && ResourceUid.HasId(id);
                        }
                        var pathOk = dep.Path != null && (ResourceLoader.Exists(dep.Path) || FileAccess.FileExists(dep.Path));
                        // A valid UID still resolves a moved file, so a missing path only counts without one.
                        if (!pathOk && (dep.Uid == null || !uidOk))
                            result.Problems.Add(new ResourceProblem { Path = path, Kind = "missing_dependency", Detail = raw });
                        else if (!uidOk)
                            result.Problems.Add(new ResourceProblem { Path = path, Kind = "broken_uid", Detail = raw });
                    }

                    var res = ResourceLoader.Load(path, "", ResourceLoader.CacheMode.Reuse);
                    if (res == null)
                        result.Problems.Add(new ResourceProblem { Path = path, Kind = "load_failed", Detail = "ResourceLoader.Load returned null (see the editor log for the engine error)." });
                }

                result.CheckedCount = checkedCount;
                result.Ok = result.Problems.Count == 0;
                return result;
            });
        }

        /// <summary>Recursive res:// walk that never descends into skipped directories.</summary>
        static void CollectFiles(string dir, List<string> into)
        {
            using var da = DirAccess.Open(dir);
            if (da == null) return;
            da.IncludeHidden = false;
            foreach (var f in da.GetFiles())
                into.Add(Join(dir, f));
            foreach (var d in da.GetDirectories())
            {
                var sub = Join(dir, d);
                if (!ResourceDependencyParser.IsSkipped(sub))
                    CollectFiles(sub, into);
            }
        }

        static string Join(string dir, string name) => dir.EndsWith("/", StringComparison.Ordinal) ? dir + name : dir + "/" + name;
    }
}
#endif
