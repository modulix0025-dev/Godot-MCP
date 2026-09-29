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

namespace ModuleX.Studio.Data
{
    /// <summary>Result of <c>game-state-get</c>. Pure data; vectors are plain float arrays.</summary>
    public class GameStateResult
    {
        [JsonInclude, JsonPropertyName("currentScene")]
        [Description("res:// path of the current scene, or null when no scene is loaded.")]
        public string? CurrentScene { get; set; }

        [JsonInclude, JsonPropertyName("frame")]
        [Description("Engine process-frame counter. Poll it: a value that stops advancing means the game hangs.")]
        public ulong Frame { get; set; }

        [JsonInclude, JsonPropertyName("fps")]
        public double Fps { get; set; }

        [JsonInclude, JsonPropertyName("timeScale")]
        public double TimeScale { get; set; }

        [JsonInclude, JsonPropertyName("paused")]
        public bool Paused { get; set; }

        [JsonInclude, JsonPropertyName("windowSize")]
        [Description("[width, height] of the main window in pixels.")]
        public int[] WindowSize { get; set; } = new int[2];

        [JsonInclude, JsonPropertyName("playerFound")]
        [Description("True when a node in the 'player' group exists.")]
        public bool PlayerFound { get; set; }

        [JsonInclude, JsonPropertyName("playerPath")]
        public string? PlayerPath { get; set; }

        [JsonInclude, JsonPropertyName("playerGlobalPosition")]
        [Description("Player global position ([x,y] for 2D, [x,y,z] for 3D), or null.")]
        public float[]? PlayerGlobalPosition { get; set; }

        [JsonInclude, JsonPropertyName("nodeCount")]
        public int NodeCount { get; set; }

        [JsonInclude, JsonPropertyName("displayServer")]
        [Description("DisplayServer name; 'headless' means no rendering (game-screenshot will fail).")]
        public string? DisplayServer { get; set; }
    }

    /// <summary>One node returned by <c>game-node-find</c>.</summary>
    public class GameNodeInfo
    {
        [JsonInclude, JsonPropertyName("path")] public string Path { get; set; } = string.Empty;
        [JsonInclude, JsonPropertyName("name")] public string Name { get; set; } = string.Empty;
        [JsonInclude, JsonPropertyName("type")] public string Type { get; set; } = string.Empty;
        [JsonInclude, JsonPropertyName("visible")] public bool? Visible { get; set; }
        [JsonInclude, JsonPropertyName("globalPosition")] public float[]? GlobalPosition { get; set; }
        [JsonInclude, JsonPropertyName("script")] public string? Script { get; set; }
        [JsonInclude, JsonPropertyName("groups")] public List<string> Groups { get; set; } = new();
    }

    public class GameNodeFindResult
    {
        [JsonInclude, JsonPropertyName("count")] public int Count { get; set; }
        [JsonInclude, JsonPropertyName("truncated")] public bool Truncated { get; set; }
        [JsonInclude, JsonPropertyName("nodes")] public List<GameNodeInfo> Nodes { get; set; } = new();
    }

    /// <summary>One visible Control returned by <c>game-ui-inspect</c>.</summary>
    public class GameUiControl
    {
        [JsonInclude, JsonPropertyName("path")] public string Path { get; set; } = string.Empty;
        [JsonInclude, JsonPropertyName("type")] public string Type { get; set; } = string.Empty;
        [JsonInclude, JsonPropertyName("rect")]
        [Description("[x, y, width, height] global rect in canvas pixels.")]
        public float[] Rect { get; set; } = new float[4];
        [JsonInclude, JsonPropertyName("text")] public string? Text { get; set; }
        [JsonInclude, JsonPropertyName("interactive")] public bool Interactive { get; set; }
        [JsonInclude, JsonPropertyName("insideViewport")] public bool InsideViewport { get; set; }
    }

    public class GameUiOverlapInfo
    {
        [JsonInclude, JsonPropertyName("a")] public string A { get; set; } = string.Empty;
        [JsonInclude, JsonPropertyName("b")] public string B { get; set; } = string.Empty;
        [JsonInclude, JsonPropertyName("overlapArea")] public float OverlapArea { get; set; }
    }

    public class GameUiInspectResult
    {
        [JsonInclude, JsonPropertyName("viewportSize")] public float[] ViewportSize { get; set; } = new float[2];
        [JsonInclude, JsonPropertyName("count")] public int Count { get; set; }
        [JsonInclude, JsonPropertyName("truncated")] public bool Truncated { get; set; }
        [JsonInclude, JsonPropertyName("controls")] public List<GameUiControl> Controls { get; set; } = new();
        [JsonInclude, JsonPropertyName("interactiveOverlaps")] public List<GameUiOverlapInfo> InteractiveOverlaps { get; set; } = new();
        [JsonInclude, JsonPropertyName("outsideViewport")] public List<string> OutsideViewport { get; set; } = new();
        [JsonInclude, JsonPropertyName("ok")]
        [Description("True when no interactive controls overlap and every control is inside the viewport.")]
        public bool Ok { get; set; }
    }

    public class GameWaitResult
    {
        [JsonInclude, JsonPropertyName("satisfied")]
        [Description("True when the wait ended because its target was reached (frames/seconds elapsed, node appeared, signal fired).")]
        public bool Satisfied { get; set; }
        [JsonInclude, JsonPropertyName("timedOut")] public bool TimedOut { get; set; }
        [JsonInclude, JsonPropertyName("framesElapsed")] public ulong FramesElapsed { get; set; }
        [JsonInclude, JsonPropertyName("secondsElapsed")] public double SecondsElapsed { get; set; }
        [JsonInclude, JsonPropertyName("note")] public string? Note { get; set; }
    }

    public class GameInputResult
    {
        [JsonInclude, JsonPropertyName("action")] public string Action { get; set; } = string.Empty;
        [JsonInclude, JsonPropertyName("pressed")] public bool Pressed { get; set; }
        [JsonInclude, JsonPropertyName("strength")] public float Strength { get; set; }
        [JsonInclude, JsonPropertyName("heldFrames")] public ulong HeldFrames { get; set; }
        [JsonInclude, JsonPropertyName("released")] public bool Released { get; set; }
    }
}
