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
using System.ComponentModel;
using System.Linq;
using com.IvanMurzak.McpPlugin;
using Godot;
using ModuleX.Studio.Common;
using ModuleX.Studio.Data;

namespace ModuleX.Studio.Tools
{
    public partial class Tool_Game
    {
        public const string GameNodeFindToolId = "game-node-find";

        [AiTool
        (
            GameNodeFindToolId,
            Title = "Game / Node / Find",
            ReadOnlyHint = true,
            IdempotentHint = true,
            OpenWorldHint = false
        )]
        [Description("Query the RUNNING game's scene tree (read-only). Select by exactly one of: 'path' (absolute " +
            "'/root/…' or relative to the current scene), 'group' (SceneTree group), or 'type' (Godot class name " +
            "such as 'CharacterBody3D', matched with IsClass, or a script class name). Returns path, name, type, " +
            "visibility, global position, script path and groups for each match.")]
        public GameNodeFindResult NodeFind
        (
            [Description("Node path: '/root/Main/Player' or relative to the current scene, e.g. 'Player'.")]
            string? path = null,
            [Description("Group name, e.g. 'player', 'enemies', 'collectibles'.")]
            string? group = null,
            [Description("Godot class name (IsClass) or C#/GDScript class name.")]
            string? type = null,
            [Description("Maximum nodes to return (1..200). Default 50.")]
            int maxResults = 50
        )
        {
            EnsureGameProcess();
            var selectors = new[] { path, group, type }.Count(s => !string.IsNullOrWhiteSpace(s));
            if (selectors != 1)
                throw new ArgumentException("Pass exactly one of 'path', 'group' or 'type'.");
            var cap = GameToolSpecs.ClampMaxResults(maxResults);

            return OnMain(() =>
            {
                var tree = Tree();
                IEnumerable<Node> matches;
                if (!string.IsNullOrWhiteSpace(path))
                {
                    Node? node = path!.StartsWith("/", StringComparison.Ordinal)
                        ? tree.Root.GetNodeOrNull(path)
                        : tree.CurrentScene?.GetNodeOrNull(path) ?? tree.Root.GetNodeOrNull(path);
                    matches = node != null ? new[] { node } : Array.Empty<Node>();
                }
                else if (!string.IsNullOrWhiteSpace(group))
                {
                    matches = tree.GetNodesInGroup(group!);
                }
                else
                {
                    matches = Walk(tree.Root).Where(n => n.IsClass(type!) || ScriptClassName(n) == type);
                }

                var list = matches.Take(cap + 1).ToList();
                var result = new GameNodeFindResult { Truncated = list.Count > cap };
                foreach (var n in list.Take(cap))
                    result.Nodes.Add(Describe(n));
                result.Count = result.Nodes.Count;
                return result;
            });
        }

        static GameNodeInfo Describe(Node n) => new GameNodeInfo
        {
            Path = n.GetPath().ToString(),
            Name = n.Name.ToString(),
            Type = n.GetClass(),
            Visible = VisibleOf(n),
            GlobalPosition = GlobalPositionOf(n),
            Script = (n.GetScript().Obj as Script)?.ResourcePath,
            Groups = n.GetGroups().Select(g => g.ToString()).Where(g => !g.StartsWith("_", StringComparison.Ordinal)).ToList(),
        };

        static string? ScriptClassName(Node n)
        {
            var script = n.GetScript().Obj as Script;
            if (script == null) return null;
            var global = script.GetGlobalName().ToString();
            if (!string.IsNullOrEmpty(global)) return global;
            var rp = script.ResourcePath;
            return string.IsNullOrEmpty(rp) ? null : System.IO.Path.GetFileNameWithoutExtension(rp);
        }

        /// <summary>Depth-first walk of the tree (iterative, so deep scenes cannot overflow the stack).</summary>
        static IEnumerable<Node> Walk(Node root)
        {
            var stack = new Stack<Node>();
            stack.Push(root);
            while (stack.Count > 0)
            {
                var n = stack.Pop();
                yield return n;
                var count = n.GetChildCount();
                for (var i = count - 1; i >= 0; i--)
                    stack.Push(n.GetChild(i));
            }
        }
    }
}
