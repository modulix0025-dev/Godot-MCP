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
using com.IvanMurzak.McpPlugin;
using com.IvanMurzak.ReflectorNet.Utils;
using Godot;
using ModuleX.Studio.Common;

namespace ModuleX.Studio.Tools
{
    public partial class Tool_Project
    {
        public const string ProjectInputActionSetToolId = "project-input-action-set";

        [AiTool
        (
            ProjectInputActionSetToolId,
            Title = "Project / Input Action / Set",
            IdempotentHint = true,
            OpenWorldHint = false
        )]
        [Description("Add or replace an input action in project.godot (the 'input/<action>' setting) and save. " +
            "Each event is { kind: Key|MouseButton|JoypadButton|JoypadAxis|ScreenTouch, key (Godot Key enum name " +
            "such as 'W', 'Space', 'Escape'), physical (default true), buttonIndex, axis, axisValue (-1|1), " +
            "touchIndex }. By default the action's events are REPLACED; set append=true to add to the existing " +
            "ones. Set remove=true (no events) to delete the action. Used for the player controller " +
            "(move_forward/back/left/right, jump, interact, pause).")]
        public string InputActionSet
        (
            [Description("Action name (identifier), e.g. 'move_forward'.")]
            string action,
            [Description("Events bound to the action (1..16). Ignored when remove=true.")]
            InputEventSpec[]? events = null,
            [Description("Analog deadzone 0..1. Default 0.2.")]
            float? deadzone = null,
            [Description("Append to the existing events instead of replacing them. Default false.")]
            bool append = false,
            [Description("Delete the action instead of setting it. Default false.")]
            bool remove = false
        )
        {
            var settingKey = "input/" + action;
            if (remove)
            {
                if (!ResPathRules.IsIdentifier(action))
                    throw new ArgumentException($"Action name '{action}' must be an identifier.", nameof(action));
                return MainThread.Instance.Run(() =>
                {
                    if (!ProjectSettings.HasSetting(settingKey))
                        return $"Input action '{action}' does not exist; nothing removed.";
                    ProjectSettings.Clear(settingKey);
                    SaveProjectSettings();
                    return $"Removed input action '{action}'.";
                });
            }

            var problems = InputEventSpecRules.Validate(action, events, k => Enum.TryParse<Key>(k, ignoreCase: true, out _));
            if (problems.Count > 0)
                throw new ArgumentException(string.Join(" ", problems), nameof(events));

            return MainThread.Instance.Run(() =>
            {
                var list = new Godot.Collections.Array<InputEvent>();
                if (append && ProjectSettings.HasSetting(settingKey))
                {
                    var existing = ProjectSettings.GetSetting(settingKey).AsGodotDictionary();
                    if (existing.TryGetValue("events", out var ev))
                        foreach (var e in ev.AsGodotArray())
                            if (e.Obj is InputEvent ie) list.Add(ie);
                }
                foreach (var spec in events!)
                    list.Add(ToInputEvent(spec));

                var dict = new Godot.Collections.Dictionary
                {
                    ["deadzone"] = InputEventSpecRules.ClampDeadzone(deadzone),
                    ["events"] = list,
                };
                ProjectSettings.SetSetting(settingKey, dict);
                SaveProjectSettings();
                return $"Input action '{action}' now has {list.Count} event(s).";
            });
        }

        /// <summary>Device id the Godot editor writes for "All Devices"; bindings must not pin one pad/keyboard.</summary>
        const int AllDevices = -1;

        static InputEvent ToInputEvent(InputEventSpec spec)
        {
            var ev = CreateInputEvent(spec);
            ev.Device = AllDevices;
            return ev;
        }

        static InputEvent CreateInputEvent(InputEventSpec spec)
        {
            switch (spec.Kind)
            {
                case InputEventKind.Key:
                    var key = Enum.Parse<Key>(spec.Key!, ignoreCase: true);
                    return spec.Physical
                        ? new InputEventKey { PhysicalKeycode = key }
                        : new InputEventKey { Keycode = key };
                case InputEventKind.MouseButton:
                    return new InputEventMouseButton { ButtonIndex = (MouseButton)spec.ButtonIndex!.Value };
                case InputEventKind.JoypadButton:
                    return new InputEventJoypadButton { ButtonIndex = (JoyButton)spec.ButtonIndex!.Value };
                case InputEventKind.JoypadAxis:
                    return new InputEventJoypadMotion { Axis = (JoyAxis)spec.Axis!.Value, AxisValue = spec.AxisValue!.Value };
                case InputEventKind.ScreenTouch:
                    return new InputEventScreenTouch { Index = spec.TouchIndex ?? 0 };
                default:
                    throw new ArgumentOutOfRangeException(nameof(spec), $"Unsupported kind '{spec.Kind}'.");
            }
        }
    }
}
#endif
