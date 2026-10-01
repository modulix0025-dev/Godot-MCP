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
using System.ComponentModel;
using com.IvanMurzak.McpPlugin;
using Godot;
using ModuleX.Studio.Common;
using ModuleX.Studio.Data;

namespace ModuleX.Studio.Tools
{
    public partial class Tool_Game
    {
        public const string GameInputActionToolId = "game-input-action";

        [AiTool
        (
            GameInputActionToolId,
            Title = "Game / Input / Action",
            IdempotentHint = false,
            OpenWorldHint = false
        )]
        [Description("Inject an input ACTION into the RUNNING game via Input.ParseInputEvent(InputEventAction), " +
            "exactly as if the player pressed a bound key/button — _input/_unhandled_input and " +
            "Input.IsActionPressed all see it. Only actions defined in the project's InputMap are accepted.\n" +
            "With pressed=true and holdFrames>0 the action is held for that many process frames and then " +
            "released automatically; the call returns after the release (bounded by holdFrames ≤ 600). " +
            "holdFrames=0 only sets the state (press or release) and returns immediately.")]
        public GameInputResult InputAction
        (
            [Description("Input action name from the project InputMap, e.g. 'move_forward', 'jump'.")]
            string action,
            [Description("true = press, false = release. Default true.")]
            bool pressed = true,
            [Description("Action strength 0..1 (analog). Default 1.")]
            float strength = 1f,
            [Description("Frames to hold before auto-release (0..600). Default 10. Ignored when pressed=false.")]
            int holdFrames = 10
        )
        {
            EnsureGameProcess();
            if (string.IsNullOrWhiteSpace(action))
                throw new ArgumentException("action is required.", nameof(action));

            var clampedStrength = GameToolSpecs.ClampStrength(strength);
            var hold = pressed ? GameToolSpecs.ClampHoldFrames(holdFrames) : 0;

            var startFrame = OnMain(() =>
            {
                if (!InputMap.HasAction(action))
                    throw new ArgumentException(
                        $"Unknown input action '{action}'. Defined actions: {string.Join(", ", InputMap.GetActions())}.",
                        nameof(action));
                Input.ParseInputEvent(new InputEventAction { Action = action, Pressed = pressed, Strength = pressed ? clampedStrength : 0f });
                return Engine.GetProcessFrames();
            });

            var result = new GameInputResult { Action = action, Pressed = pressed, Strength = pressed ? clampedStrength : 0f };
            if (!pressed || hold == 0)
            {
                result.Released = !pressed;
                return result;
            }

            // Budget: holdFrames at a pessimistic MinBudgetFps, plus slack — the frame counter, not wall time, decides.
            var budget = TimeSpan.FromSeconds(GameToolSpecs.FrameBudgetSeconds(hold, 5, capSeconds: 120));
            WaitUntil(() => Engine.GetProcessFrames() - startFrame >= (ulong)hold, budget);

            var endFrame = OnMain(() =>
            {
                Input.ParseInputEvent(new InputEventAction { Action = action, Pressed = false, Strength = 0f });
                return Engine.GetProcessFrames();
            });
            result.HeldFrames = endFrame - startFrame;
            result.Released = true;
            return result;
        }
    }
}
