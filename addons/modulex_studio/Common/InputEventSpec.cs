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

namespace ModuleX.Studio.Common
{
    /// <summary>Kind of a single input event bound to an input action.</summary>
    public enum InputEventKind
    {
        Key,
        MouseButton,
        JoypadButton,
        JoypadAxis,
        ScreenTouch,
    }

    /// <summary>
    /// One input event of an input action, as the agent describes it for <c>project-input-action-set</c>.
    /// Pure data + validation; the editor tool turns a validated spec into a real Godot <c>InputEvent*</c>.
    /// </summary>
    public sealed class InputEventSpec
    {
        [Description("Event kind: 'Key', 'MouseButton', 'JoypadButton', 'JoypadAxis' or 'ScreenTouch'.")]
        public InputEventKind Kind { get; set; }

        [Description("Key: a Godot Key enum name, e.g. 'W', 'Space', 'Escape', 'Up'. Kind=Key only.")]
        public string? Key { get; set; }

        [Description("Use the physical (layout-independent) keycode instead of the logical one. Kind=Key only. Default true.")]
        public bool Physical { get; set; } = true;

        [Description("Mouse button index (1=left, 2=right, 3=middle) or joypad button index (0..127).")]
        public int? ButtonIndex { get; set; }

        [Description("Joypad axis index (0..9). Kind=JoypadAxis only.")]
        public int? Axis { get; set; }

        [Description("Joypad axis direction: -1 or +1. Kind=JoypadAxis only.")]
        public float? AxisValue { get; set; }

        [Description("Touch index (0..9). Kind=ScreenTouch only. Default 0.")]
        public int? TouchIndex { get; set; }
    }

    /// <summary>Validation for <see cref="InputEventSpec"/> lists and action names.</summary>
    public static class InputEventSpecRules
    {
        public const int MaxEventsPerAction = 16;

        /// <summary>
        /// Validates the spec list. <paramref name="isKnownKey"/> resolves a key name (the editor passes a
        /// Godot <c>Key</c> enum parse; tests pass a stub). Returns the list of problems (empty = valid).
        /// </summary>
        public static IReadOnlyList<string> Validate(string? action, IReadOnlyList<InputEventSpec>? events, Func<string, bool> isKnownKey)
        {
            var problems = new List<string>();
            if (!ResPathRules.IsIdentifier(action))
                problems.Add($"Action name '{action}' must be an identifier ([A-Za-z_][A-Za-z0-9_]*, max 64 chars).");
            if (events == null || events.Count == 0)
            {
                problems.Add("At least one input event is required.");
                return problems;
            }
            if (events.Count > MaxEventsPerAction)
                problems.Add($"At most {MaxEventsPerAction} events per action (got {events.Count}).");

            for (var i = 0; i < events.Count; i++)
            {
                var e = events[i];
                var at = $"events[{i}]";
                if (e == null)
                {
                    problems.Add($"{at} is null.");
                    continue;
                }
                switch (e.Kind)
                {
                    case InputEventKind.Key:
                        if (string.IsNullOrWhiteSpace(e.Key))
                            problems.Add($"{at}: 'key' is required for Kind=Key.");
                        else if (!isKnownKey(e.Key!))
                            problems.Add($"{at}: unknown key '{e.Key}' (use a Godot Key enum name such as 'W', 'Space', 'Escape').");
                        break;
                    case InputEventKind.MouseButton:
                        if (e.ButtonIndex is not (>= 1 and <= 9))
                            problems.Add($"{at}: 'buttonIndex' must be 1..9 for Kind=MouseButton.");
                        break;
                    case InputEventKind.JoypadButton:
                        if (e.ButtonIndex is not (>= 0 and <= 127))
                            problems.Add($"{at}: 'buttonIndex' must be 0..127 for Kind=JoypadButton.");
                        break;
                    case InputEventKind.JoypadAxis:
                        if (e.Axis is not (>= 0 and <= 9))
                            problems.Add($"{at}: 'axis' must be 0..9 for Kind=JoypadAxis.");
                        if (e.AxisValue is not (-1f or 1f))
                            problems.Add($"{at}: 'axisValue' must be -1 or 1 for Kind=JoypadAxis.");
                        break;
                    case InputEventKind.ScreenTouch:
                        if (e.TouchIndex is { } ti && (ti < 0 || ti > 9))
                            problems.Add($"{at}: 'touchIndex' must be 0..9 for Kind=ScreenTouch.");
                        break;
                    default:
                        problems.Add($"{at}: unsupported kind '{e.Kind}'.");
                        break;
                }
            }
            return problems;
        }

        /// <summary>Clamp a deadzone to [0, 1]; null → 0.2 (the <c>InputMap.AddAction</c> API default).</summary>
        public static float ClampDeadzone(float? deadzone) => deadzone is { } d ? Math.Clamp(d, 0f, 1f) : 0.2f;
    }
}
