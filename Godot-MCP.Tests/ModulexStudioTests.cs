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
using System.Reflection;
using com.IvanMurzak.Godot.MCP.Tools;
using com.IvanMurzak.McpPlugin;
using ModuleX.Studio.Common;
using ModuleX.Studio.Qa;
using ModuleX.Studio.Tools;
using Xunit;

namespace com.IvanMurzak.Godot.MCP.Tests
{
    public class ProjectSettingsAllowlistTests
    {
        [Theory]
        [InlineData("application/run/main_scene", true, true)]
        [InlineData("application/config/name", true, true)]
        [InlineData("display/window/size/viewport_width", true, true)]
        [InlineData("layer_names/3d_physics/layer_1", true, true)]
        [InlineData("rendering/renderer/rendering_method", true, false)]
        [InlineData("physics/3d/default_gravity", true, false)]
        [InlineData("input/move_forward", true, false)]
        [InlineData("autoload/GameState", true, false)]
        [InlineData("editor_plugins/enabled", false, false)]
        [InlineData("dotnet/project/assembly_name", false, false)]
        [InlineData("debug/file_logging/log_path", false, false)]
        [InlineData("application/run/main_scene_extra", false, false)]
        public void Access_matches_allowlist(string key, bool readable, bool writable)
        {
            Assert.Equal(readable, ProjectSettingsAllowlist.IsReadable(key));
            Assert.Equal(writable, ProjectSettingsAllowlist.IsWritable(key));
        }

        [Theory]
        [InlineData("")]
        [InlineData("noslash")]
        [InlineData("display/../editor_plugins/enabled")]
        [InlineData("display//window")]
        [InlineData("display/wíndow/x")]
        [InlineData("display/window/")]
        public void Malformed_keys_are_refused(string key)
        {
            Assert.False(ProjectSettingsAllowlist.IsReadable(key));
            Assert.NotNull(ProjectSettingsAllowlist.RefusalReason(key, write: false));
        }

        [Fact]
        public void Prefix_entry_does_not_match_the_bare_prefix()
        {
            Assert.False(ProjectSettingsAllowlist.IsReadable("display/window"));
            Assert.True(ProjectSettingsAllowlist.IsReadable("display/window/stretch/mode"));
        }

        [Fact]
        public void Write_refusals_point_to_the_dedicated_tools()
        {
            Assert.Contains("project-input-action-set", ProjectSettingsAllowlist.RefusalReason("input/jump", write: true));
            Assert.Contains("project-autoload-set", ProjectSettingsAllowlist.RefusalReason("autoload/X", write: true));
            Assert.Null(ProjectSettingsAllowlist.RefusalReason("application/config/name", write: true));
        }
    }

    public class ResPathRulesTests
    {
        [Theory]
        [InlineData("res://scenes/main.tscn", null)]
        [InlineData("res://a/b/c.gd", null)]
        [InlineData("user://save.tres", "must start with 'res://'")]
        [InlineData("/etc/passwd", "must start with 'res://'")]
        [InlineData("C:\\Windows\\x.tscn", "must start with 'res://'")]
        [InlineData("res://../outside.tscn", "'..'")]
        [InlineData("res://a/./b.tscn", "'..'")]
        [InlineData("res://a\\b.tscn", "illegal character")]
        [InlineData("res://", "must name a file")]
        [InlineData("", "must not be empty")]
        public void Validate_rejects_paths_outside_the_project(string path, string? expectedFragment)
        {
            var reason = ResPathRules.Validate(path);
            if (expectedFragment == null) Assert.Null(reason);
            else Assert.Contains(expectedFragment, reason);
        }

        [Fact]
        public void Validate_enforces_extensions()
        {
            Assert.Null(ResPathRules.Validate("res://x.TSCN", ".tscn", ".scn"));
            Assert.Contains("must end with", ResPathRules.Validate("res://x.gd", ".tscn", ".scn"));
        }

        [Theory]
        [InlineData("GameState", true)]
        [InlineData("_private", true)]
        [InlineData("move_forward2", true)]
        [InlineData("2fast", false)]
        [InlineData("has space", false)]
        [InlineData("dash-name", false)]
        [InlineData("", false)]
        [InlineData("مرحبا", false)]
        public void IsIdentifier(string name, bool expected) => Assert.Equal(expected, ResPathRules.IsIdentifier(name));
    }

    public class InputEventSpecRulesTests
    {
        static bool KnownKey(string k) => k is "W" or "Space" or "Escape" or "Up";

        [Fact]
        public void Valid_player_controller_bindings_pass()
        {
            var events = new List<InputEventSpec>
            {
                new() { Kind = InputEventKind.Key, Key = "W" },
                new() { Kind = InputEventKind.JoypadAxis, Axis = 1, AxisValue = -1 },
                new() { Kind = InputEventKind.MouseButton, ButtonIndex = 1 },
                new() { Kind = InputEventKind.JoypadButton, ButtonIndex = 0 },
                new() { Kind = InputEventKind.ScreenTouch },
            };
            Assert.Empty(InputEventSpecRules.Validate("move_forward", events, KnownKey));
        }

        [Fact]
        public void Each_invalid_event_is_reported()
        {
            var events = new List<InputEventSpec>
            {
                new() { Kind = InputEventKind.Key, Key = "Spacebar" },
                new() { Kind = InputEventKind.Key },
                new() { Kind = InputEventKind.MouseButton, ButtonIndex = 0 },
                new() { Kind = InputEventKind.JoypadAxis, Axis = 12, AxisValue = 0.5f },
                new() { Kind = InputEventKind.ScreenTouch, TouchIndex = 42 },
            };
            var problems = InputEventSpecRules.Validate("jump", events, KnownKey);
            Assert.Equal(6, problems.Count); // axis event contributes two problems
            Assert.Contains(problems, p => p.Contains("unknown key 'Spacebar'"));
        }

        [Fact]
        public void Action_name_and_event_count_are_checked()
        {
            Assert.Contains(InputEventSpecRules.Validate("bad name", new[] { new InputEventSpec { Kind = InputEventKind.Key, Key = "W" } }, KnownKey),
                p => p.Contains("identifier"));
            Assert.Contains(InputEventSpecRules.Validate("jump", Array.Empty<InputEventSpec>(), KnownKey), p => p.Contains("At least one"));
            var many = Enumerable.Range(0, 17).Select(_ => new InputEventSpec { Kind = InputEventKind.Key, Key = "W" }).ToList();
            Assert.Contains(InputEventSpecRules.Validate("jump", many, KnownKey), p => p.Contains("At most 16"));
        }

        [Theory]
        [InlineData(null, 0.2f)]
        [InlineData(-1f, 0f)]
        [InlineData(0.5f, 0.5f)]
        [InlineData(3f, 1f)]
        public void Deadzone_is_clamped(float? input, float expected) => Assert.Equal(expected, InputEventSpecRules.ClampDeadzone(input));
    }

    public class ResourceDependencyParserTests
    {
        [Theory]
        [InlineData("uid://b8x::Texture2D::res://tex/a.png", "uid://b8x", "Texture2D", "res://tex/a.png")]
        [InlineData("res://tex/a.png::Texture2D", null, "Texture2D", "res://tex/a.png")]
        [InlineData("uid://abc::::res://s.gd", "uid://abc", null, "res://s.gd")]
        [InlineData("res://only.tres", null, null, "res://only.tres")]
        public void Parses_both_dependency_formats(string raw, string? uid, string? type, string? path)
        {
            var d = ResourceDependencyParser.Parse(raw);
            Assert.Equal(uid, d.Uid);
            Assert.Equal(type, d.Type);
            Assert.Equal(path, d.Path);
        }

        [Fact]
        public void Empty_input_parses_to_nothing()
            => Assert.Equal(new ResourceDependency(null, null, null), ResourceDependencyParser.Parse(""));

        [Fact]
        public void SelectTargets_skips_tooling_dirs_and_non_resources()
        {
            var files = new[]
            {
                "res://main.tscn", "res://player.gd", "res://.godot/imported/x.res", "res://addons/godot_mcp/a.tscn",
                "res://addons/modulex_studio/b.tres", "res://addons/other/c.tres", "res://assets/generated/hero.glb",
                "res://assets/generated/hero.glb.import", "res://build/win/x.res", "res://main.tscn",
                "res://addons/godot_mcp_fork/keep.tscn",
            };
            var targets = ResourceDependencyParser.SelectTargets(files, null);
            Assert.Equal(new[]
            {
                "res://addons/godot_mcp_fork/keep.tscn", "res://addons/other/c.tres", "res://assets/generated/hero.glb", "res://main.tscn",
            }, targets);
        }

        [Fact]
        public void SelectTargets_honours_scope()
        {
            var files = new[] { "res://a/x.tscn", "res://b/y.tscn" };
            Assert.Equal(new[] { "res://b/y.tscn" }, ResourceDependencyParser.SelectTargets(files, "res://b/"));
        }
    }

    public class UiRectMathTests
    {
        [Fact]
        public void Touching_rects_do_not_overlap()
            => Assert.Equal(0f, UiRectMath.IntersectionArea(new UiRect(0, 0, 10, 10), new UiRect(10, 0, 10, 10)));

        [Fact]
        public void Overlap_area_is_exact()
            => Assert.Equal(1200f, UiRectMath.IntersectionArea(new UiRect(10, 50, 110, 40), new UiRect(60, 70, 110, 40)));

        [Fact]
        public void FindOverlaps_reports_pairs_including_containment()
        {
            var rects = new[] { new UiRect(0, 0, 100, 100), new UiRect(10, 10, 20, 20), new UiRect(200, 200, 10, 10) };
            var overlaps = UiRectMath.FindOverlaps(rects);
            Assert.Single(overlaps);
            Assert.Equal((0, 1), (overlaps[0].A, overlaps[0].B));
        }

        [Theory]
        [InlineData(0, 0, 1280, 720, true)]
        [InlineData(-1, 0, 10, 10, false)]
        [InlineData(1275, 0, 10, 10, false)]
        [InlineData(0, 715, 10, 10, false)]
        public void Viewport_containment(float x, float y, float w, float h, bool inside)
            => Assert.Equal(inside, UiRectMath.IsInsideViewport(new UiRect(x, y, w, h), 1280, 720));
    }

    public class GameToolSpecsTests
    {
        [Theory]
        [InlineData(null, null, false, "Pass 'frames', 'seconds'")]
        [InlineData(5, 1.0, false, "not both")]
        [InlineData(0, null, false, "'frames' must be >= 1")]
        [InlineData(null, -1.0, false, "'seconds' must be > 0")]
        public void Invalid_waits_are_rejected(int? frames, double? seconds, bool cond, string fragment)
            => Assert.Contains(fragment, GameToolSpecs.ValidateWait(frames, seconds, cond, out _, out _));

        [Fact]
        public void Waits_are_capped()
        {
            Assert.Null(GameToolSpecs.ValidateWait(99999, null, false, out var f, out _));
            Assert.Equal(GameToolSpecs.MaxWaitFrames, f);
            Assert.Null(GameToolSpecs.ValidateWait(null, 999, false, out _, out var s));
            Assert.Equal(GameToolSpecs.MaxWaitSeconds, s);
            Assert.Null(GameToolSpecs.ValidateWait(null, null, true, out _, out var t));
            Assert.Equal(GameToolSpecs.MaxWaitSeconds, t);
        }

        [Theory]
        [InlineData(-5, 0)]
        [InlineData(10, 10)]
        [InlineData(100000, 600)]
        public void Hold_frames_are_clamped(int input, int expected) => Assert.Equal(expected, GameToolSpecs.ClampHoldFrames(input));

        [Theory]
        [InlineData(30, 2, 17)]     // 30 frames at 2 fps + 2 s slack (a software-rendered runner, GATE 10)
        [InlineData(0, 2, 2)]
        [InlineData(-5, 2, 2)]
        [InlineData(3600, 2, 30)]   // capped by MaxWaitSeconds
        public void Frame_budget_tolerates_slow_frame_rates(int frames, double slack, double expected)
            => Assert.Equal(expected, GameToolSpecs.FrameBudgetSeconds(frames, slack));

        [Fact]
        public void Frame_budget_cap_is_configurable()
            => Assert.Equal(120, GameToolSpecs.FrameBudgetSeconds(600, 5, capSeconds: 120));

        [Theory]
        [InlineData(-1f, 0f)]
        [InlineData(0.4f, 0.4f)]
        [InlineData(7f, 1f)]
        [InlineData(float.NaN, 1f)]
        public void Strength_is_clamped(float input, float expected) => Assert.Equal(expected, GameToolSpecs.ClampStrength(input));

        [Theory]
        [InlineData("1", true)]
        [InlineData("0", false)]
        [InlineData("true", false)]
        [InlineData(null, false)]
        public void Qa_gate_requires_exactly_1(string? value, bool expected)
            => Assert.Equal(expected, ModulexQaGate.IsEnabled(k => k == "MODULEX_QA" ? value : null));
    }

    /// <summary>
    /// Pins the ModuleX tool surface by reflection over the REAL [AiTool] attributes: ids, read-only hints,
    /// and the playtest tool set (reflection + console must never be exposed inside a game).
    /// </summary>
    public class ModulexToolSurfaceTests
    {
        static Dictionary<string, AiToolAttribute> ToolsOf(Type t)
            => t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static)
                .Select(m => m.GetCustomAttribute<AiToolAttribute>())
                .Where(a => a != null)
                .ToDictionary(a => a!.Name, a => a!);

        [Fact]
        public void Game_family_exposes_exactly_the_eight_documented_tools()
        {
            var tools = ToolsOf(typeof(Tool_Game));
            Assert.Equal(new[]
            {
                "game-input-action", "game-node-find", "game-quit", "game-scene-change", "game-screenshot",
                "game-state-get", "game-ui-inspect", "game-wait",
            }, tools.Keys.OrderBy(k => k, StringComparer.Ordinal));
            Assert.Equal(tools.Keys.OrderBy(k => k), Tool_Game.AllToolIds.OrderBy(k => k));
        }

        [Theory]
        [InlineData("game-state-get", true)]
        [InlineData("game-screenshot", true)]
        [InlineData("game-node-find", true)]
        [InlineData("game-ui-inspect", true)]
        [InlineData("game-wait", true)]
        [InlineData("game-input-action", false)]
        [InlineData("game-scene-change", false)]
        [InlineData("game-quit", false)]
        public void Read_only_hints_match_behaviour(string id, bool readOnly)
            => Assert.Equal(readOnly, ToolsOf(typeof(Tool_Game))[id].ReadOnlyHint);

        [Fact]
        public void Game_family_is_an_AiToolType()
            => Assert.NotNull(typeof(Tool_Game).GetCustomAttribute<AiToolTypeAttribute>());

        [Fact]
        public void Qa_tool_set_excludes_reflection_and_console()
        {
            var set = ModulexQaAutoload.QaToolTypes;
            Assert.Contains(typeof(Tool_Game), set);
            Assert.Contains(typeof(Tool_Ping), set);
            Assert.Contains(typeof(Tool_RuntimeErrors), set);
            // By name: Tool_Reflection is not compiled into this test assembly.
            Assert.DoesNotContain(set, t => t.Name == "Tool_Reflection" || t.Name == "Tool_Console");
            Assert.Equal(3, set.Length);
        }

        [Fact]
        public void Qa_autoload_script_path_matches_the_file_on_disk()
        {
            var repo = FindRepoRoot();
            var rel = ModulexQaAutoload.ScriptPath.Substring("res://".Length);
            Assert.True(System.IO.File.Exists(System.IO.Path.Combine(repo, rel)), $"missing {rel}");
        }

        static string FindRepoRoot()
        {
            var dir = new System.IO.DirectoryInfo(AppContext.BaseDirectory);
            while (dir != null && !System.IO.File.Exists(System.IO.Path.Combine(dir.FullName, "Godot-MCP.sln")))
                dir = dir.Parent;
            return dir?.FullName ?? throw new InvalidOperationException("repo root not found");
        }
    }
}
