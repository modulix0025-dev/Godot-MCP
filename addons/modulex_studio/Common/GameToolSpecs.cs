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
    /// Argument normalisation for the runtime <c>game-*</c> tools, kept pure so the caps are unit-tested and
    /// identical everywhere (the tools, the Studio QA runner, and docs quote these constants).
    /// </summary>
    public static class GameToolSpecs
    {
        /// <summary>Hard cap for <c>game-wait</c>, in seconds. A playtest step never blocks longer than this.</summary>
        public const double MaxWaitSeconds = 30.0;

        /// <summary>Hard cap for <c>game-wait</c> in frames.</summary>
        public const int MaxWaitFrames = 3600;

        /// <summary>Cap for <c>game-input-action.holdFrames</c> (10 s at 60 fps).</summary>
        public const int MaxHoldFrames = 600;

        /// <summary>Cap for <c>game-node-find</c> / <c>game-ui-inspect</c> result sizes.</summary>
        public const int MaxResults = 200;

        /// <summary>Clamp input strength into Godot's [0, 1] action-strength range.</summary>
        public static float ClampStrength(float strength) => float.IsNaN(strength) ? 1f : Math.Clamp(strength, 0f, 1f);

        /// <summary>Clamp hold frames into [0, MaxHoldFrames]. 0 = press without automatic release.</summary>
        public static int ClampHoldFrames(int holdFrames) => Math.Clamp(holdFrames, 0, MaxHoldFrames);

        public static int ClampMaxResults(int maxResults) => Math.Clamp(maxResults, 1, MaxResults);

        /// <summary>
        /// Resolve a wait request into a deadline in seconds. Exactly one of frames / seconds may be set; a
        /// wait with only a condition (node path / signal) uses <see cref="MaxWaitSeconds"/> as its timeout.
        /// Returns an error string on invalid input.
        /// </summary>
        public static string? ValidateWait(int? frames, double? seconds, bool hasCondition, out int clampedFrames, out double timeoutSeconds)
        {
            clampedFrames = 0;
            timeoutSeconds = MaxWaitSeconds;
            if (frames is not null && seconds is not null)
                return "Pass either 'frames' or 'seconds', not both.";
            if (frames is null && seconds is null && !hasCondition)
                return "Pass 'frames', 'seconds', or a condition ('untilNodePath' / 'untilSignal').";
            if (frames is { } f)
            {
                if (f < 1) return "'frames' must be >= 1.";
                clampedFrames = Math.Min(f, MaxWaitFrames);
            }
            if (seconds is { } s)
            {
                if (double.IsNaN(s) || s <= 0) return "'seconds' must be > 0.";
                timeoutSeconds = Math.Min(s, MaxWaitSeconds);
            }
            return null;
        }
    }

    /// <summary>The env gate the Studio sets on a playtest process. Pure so the gate logic is unit-tested.</summary>
    public static class ModulexQaGate
    {
        public const string EnvEnabled = "MODULEX_QA";

        public static bool IsEnabled(Func<string, string?> getEnv) => getEnv(EnvEnabled) == "1";
    }
}
