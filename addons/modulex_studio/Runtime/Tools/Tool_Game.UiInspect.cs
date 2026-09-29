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
using System.Linq;
using com.IvanMurzak.McpPlugin;
using Godot;
using ModuleX.Studio.Common;
using ModuleX.Studio.Data;

namespace ModuleX.Studio.Tools
{
    public partial class Tool_Game
    {
        public const string GameUiInspectToolId = "game-ui-inspect";

        [AiTool
        (
            GameUiInspectToolId,
            Title = "Game / UI / Inspect",
            ReadOnlyHint = true,
            IdempotentHint = true,
            OpenWorldHint = false
        )]
        [Description("Deterministic UI check of the RUNNING game: lists every visible Control (IsVisibleInTree) " +
            "with its global rect, type and text, flags interactive controls (buttons, inputs, sliders, lists) " +
            "that overlap each other, and controls that fall outside the viewport. 'ok' is true when there are " +
            "no interactive overlaps and nothing is off-screen. Rects are canvas coordinates; a CanvasLayer with " +
            "a custom transform is reported in its own layer space.")]
        public GameUiInspectResult UiInspect
        (
            [Description("Maximum controls to list (1..200). Default 100. Overlap checks use the listed controls.")]
            int maxResults = 100
        )
        {
            EnsureGameProcess();
            var cap = GameToolSpecs.ClampMaxResults(maxResults);

            return OnMain(() =>
            {
                var tree = Tree();
                var vp = tree.Root.GetVisibleRect().Size;
                var controls = Walk(tree.Root).OfType<Control>().Where(c => c.IsVisibleInTree()).Take(cap + 1).ToList();

                var result = new GameUiInspectResult
                {
                    ViewportSize = new[] { vp.X, vp.Y },
                    Truncated = controls.Count > cap,
                };

                var interactiveRects = new List<UiRect>();
                var interactivePaths = new List<string>();
                foreach (var c in controls.Take(cap))
                {
                    var r = c.GetGlobalRect();
                    var rect = new UiRect(r.Position.X, r.Position.Y, r.Size.X, r.Size.Y);
                    var interactive = IsInteractive(c);
                    var path = c.GetPath().ToString();
                    var inside = UiRectMath.IsInsideViewport(rect, vp.X, vp.Y);
                    result.Controls.Add(new GameUiControl
                    {
                        Path = path,
                        Type = c.GetClass(),
                        Rect = new[] { rect.X, rect.Y, rect.Width, rect.Height },
                        Text = TextOf(c),
                        Interactive = interactive,
                        InsideViewport = inside,
                    });
                    // Zero-size containers are layout helpers, not visible UI — ignore them for placement checks.
                    if (!inside && rect.Area > 0)
                        result.OutsideViewport.Add(path);
                    if (interactive && rect.Area > 0)
                    {
                        interactiveRects.Add(rect);
                        interactivePaths.Add(path);
                    }
                }

                foreach (var o in UiRectMath.FindOverlaps(interactiveRects))
                {
                    result.InteractiveOverlaps.Add(new GameUiOverlapInfo
                    {
                        A = interactivePaths[o.A],
                        B = interactivePaths[o.B],
                        OverlapArea = o.OverlapArea,
                    });
                }

                result.Count = result.Controls.Count;
                result.Ok = result.InteractiveOverlaps.Count == 0 && result.OutsideViewport.Count == 0;
                return result;
            });
        }

        static bool IsInteractive(Control c) => c switch
        {
            BaseButton => true,
            LineEdit => true,
            TextEdit => true,
            ItemList => true,
            ProgressBar => false,
            Godot.Range => true,
            _ => false,
        };

        static string? TextOf(Control c) => c switch
        {
            Label l => l.Text,
            Button b => b.Text,
            LineEdit le => le.Text,
            RichTextLabel rt => rt.GetParsedText(),
            _ => null,
        };
    }
}
