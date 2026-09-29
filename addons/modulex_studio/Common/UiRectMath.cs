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

namespace ModuleX.Studio.Common
{
    /// <summary>Axis-aligned rectangle in viewport pixels (pure; mirrors Godot's Rect2 without the native type).</summary>
    public readonly record struct UiRect(float X, float Y, float Width, float Height)
    {
        public float Right => X + Width;
        public float Bottom => Y + Height;
        public float Area => Math.Max(0, Width) * Math.Max(0, Height);
    }

    /// <summary>A pair of overlapping interactive controls, by index into the inspected list.</summary>
    public readonly record struct UiOverlap(int A, int B, float OverlapArea);

    /// <summary>
    /// Deterministic UI checks for <c>game-ui-inspect</c> (and the Studio's visual tier): overlap between
    /// interactive controls and containment inside the viewport. Pure maths, unit-tested.
    /// </summary>
    public static class UiRectMath
    {
        /// <summary>Area of the intersection of two rects (0 when they only touch or are disjoint).</summary>
        public static float IntersectionArea(UiRect a, UiRect b)
        {
            var w = Math.Min(a.Right, b.Right) - Math.Max(a.X, b.X);
            var h = Math.Min(a.Bottom, b.Bottom) - Math.Max(a.Y, b.Y);
            return w > 0 && h > 0 ? w * h : 0f;
        }

        /// <summary>
        /// All overlapping pairs whose intersection exceeds <paramref name="minArea"/> px². O(n²); callers cap n.
        /// A pair where one rect fully contains the other is still reported (a button hidden under a panel).
        /// </summary>
        public static IReadOnlyList<UiOverlap> FindOverlaps(IReadOnlyList<UiRect> rects, float minArea = 1f)
        {
            var result = new List<UiOverlap>();
            for (var i = 0; i < rects.Count; i++)
            {
                for (var j = i + 1; j < rects.Count; j++)
                {
                    var area = IntersectionArea(rects[i], rects[j]);
                    if (area > minArea)
                        result.Add(new UiOverlap(i, j, area));
                }
            }
            return result;
        }

        /// <summary>True when <paramref name="rect"/> lies fully inside a viewport of the given size.</summary>
        public static bool IsInsideViewport(UiRect rect, float viewportWidth, float viewportHeight)
            => rect.X >= 0 && rect.Y >= 0 && rect.Right <= viewportWidth && rect.Bottom <= viewportHeight;
    }
}
