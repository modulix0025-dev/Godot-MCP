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
using System.Diagnostics;
using com.IvanMurzak.McpPlugin;
using Godot;
using ModuleX.Studio.Common;
using ModuleX.Studio.Data;

namespace ModuleX.Studio.Tools
{
    public partial class Tool_Game
    {
        public const string GameWaitToolId = "game-wait";

        [AiTool
        (
            GameWaitToolId,
            Title = "Game / Wait",
            ReadOnlyHint = true,
            IdempotentHint = false,
            OpenWorldHint = false
        )]
        [Description("Wait inside the RUNNING game without blocking its loop. Pass 'frames' (≤ 3600) or 'seconds' " +
            "(≤ 30), and/or a condition: 'untilNodePath' (wait until the node exists) or 'untilSignal' " +
            "('<nodePath>:<signal>', wait until it is emitted). A condition without frames/seconds times out " +
            "after 30 s. 'satisfied' says whether the target was reached; 'timedOut' when the cap hit first.\n" +
            "Tool calls to one game are executed ONE AT A TIME, so a separate 'game-input-action' call cannot " +
            "trigger a condition this wait is watching. To test 'pressing X causes Y', pass 'pressAction' " +
            "(and optionally 'pressHoldFrames'): the condition is armed first, then the action is pressed and " +
            "auto-released inside this same call.")]
        public GameWaitResult Wait
        (
            [Description("Process frames to wait (1..3600).")]
            int? frames = null,
            [Description("Seconds to wait (> 0, ≤ 30). With a condition this is the timeout.")]
            double? seconds = null,
            [Description("Wait until this node exists ('/root/…' or relative to the current scene).")]
            string? untilNodePath = null,
            [Description("Wait until '<nodePath>:<signalName>' is emitted, e.g. 'Player:died'.")]
            string? untilSignal = null,
            [Description("Optional input action to press AFTER the condition is armed (e.g. 'jump').")]
            string? pressAction = null,
            [Description("Frames to hold 'pressAction' before auto-release (1..600). Default 10.")]
            int pressHoldFrames = 10
        )
        {
            EnsureGameProcess();
            var hasNode = !string.IsNullOrWhiteSpace(untilNodePath);
            var hasSignal = !string.IsNullOrWhiteSpace(untilSignal);
            if (hasNode && hasSignal)
                throw new ArgumentException("Pass at most one condition: 'untilNodePath' or 'untilSignal'.");
            var error = GameToolSpecs.ValidateWait(frames, seconds, hasNode || hasSignal, out var clampedFrames, out var timeoutSeconds);
            if (error != null)
                throw new ArgumentException(error);

            var fired = false;
            if (hasSignal)
            {
                var sep = untilSignal!.LastIndexOf(':');
                if (sep <= 0 || sep == untilSignal.Length - 1)
                    throw new ArgumentException("untilSignal must be '<nodePath>:<signalName>'.", nameof(untilSignal));
                var nodePath = untilSignal.Substring(0, sep);
                var signal = untilSignal.Substring(sep + 1);
                OnMain(() =>
                {
                    var node = ResolveNode(nodePath)
                        ?? throw new ArgumentException($"Node '{nodePath}' not found.", nameof(untilSignal));
                    if (!node.HasSignal(signal))
                        throw new ArgumentException($"Node '{nodePath}' has no signal '{signal}'.", nameof(untilSignal));
                    // SignalAwaiter accepts any argument count, unlike a zero-arg Callable.
                    node.ToSignal(node, signal).OnCompleted(() => fired = true);
                });
            }

            var hasPress = !string.IsNullOrWhiteSpace(pressAction);
            var hold = (ulong)Math.Max(1, GameToolSpecs.ClampHoldFrames(pressHoldFrames));
            var pressReleased = !hasPress;
            var startFrame = OnMain(() =>
            {
                if (hasPress)
                {
                    if (!InputMap.HasAction(pressAction!))
                        throw new ArgumentException($"Unknown input action '{pressAction}'.", nameof(pressAction));
                    Input.ParseInputEvent(new InputEventAction { Action = pressAction!, Pressed = true, Strength = 1f });
                }
                return Engine.GetProcessFrames();
            });
            var sw = Stopwatch.StartNew();

            Func<bool> target;
            if (hasNode) target = () => ResolveNode(untilNodePath!) != null;
            else if (hasSignal) target = () => fired;
            else if (frames != null) target = () => Engine.GetProcessFrames() - startFrame >= (ulong)clampedFrames;
            else target = () => false; // pure seconds wait: satisfied when the timeout elapses

            // Runs on the main thread each poll: release the pressed action once its hold elapsed.
            Func<bool> done = () =>
            {
                if (!pressReleased && Engine.GetProcessFrames() - startFrame >= hold)
                {
                    Input.ParseInputEvent(new InputEventAction { Action = pressAction!, Pressed = false, Strength = 0f });
                    pressReleased = true;
                }
                return target();
            };

            // Frame waits get a wall-clock budget of frames at a pessimistic 10 fps, capped by MaxWaitSeconds.
            var budget = frames != null && !hasNode && !hasSignal
                ? Math.Min(clampedFrames / 10.0 + 2, GameToolSpecs.MaxWaitSeconds)
                : timeoutSeconds;
            var satisfied = WaitUntil(done, TimeSpan.FromSeconds(budget));
            var pureSeconds = frames == null && !hasNode && !hasSignal;

            var endFrame = OnMain(() =>
            {
                if (!pressReleased) // condition met before the hold elapsed: never leave the action stuck down
                {
                    Input.ParseInputEvent(new InputEventAction { Action = pressAction!, Pressed = false, Strength = 0f });
                    pressReleased = true;
                }
                return Engine.GetProcessFrames();
            });
            return new GameWaitResult
            {
                Satisfied = satisfied || pureSeconds,
                TimedOut = !satisfied && !pureSeconds,
                FramesElapsed = endFrame - startFrame,
                SecondsElapsed = sw.Elapsed.TotalSeconds,
                Note = frames != null && frames > clampedFrames ? $"frames capped to {clampedFrames}." : null,
            };
        }

        static Node? ResolveNode(string path)
        {
            var tree = Tree();
            return path.StartsWith("/", StringComparison.Ordinal)
                ? tree.Root.GetNodeOrNull(path)
                : tree.CurrentScene?.GetNodeOrNull(path) ?? tree.Root.GetNodeOrNull(path);
        }
    }
}
