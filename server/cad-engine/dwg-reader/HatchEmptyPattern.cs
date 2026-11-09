using ACadSharp.Entities;
using CSMath;
using CSMath.Extensions;

// A sufficient no-crossing proof, not a second hatch renderer or read-completeness check.
internal static class HatchEmptyPattern
{
    internal const string Empty = "empty-by-read-definition";
    internal record Range(int line, double kMin, double kMax, double tolerance);
    internal record Result(string status, string reason, string method, List<Range> ranges);
    internal static Result Classify(Hatch hatch)
    {
        var ranges = new List<Range>();
        Result Review(string reason) => new("needs-review", reason, "analytic-boundary-projection/1", ranges);
        if (hatch.IsSolid || hatch.GradientColor.Enabled || hatch.IsDouble || hatch.Pattern == null
            || hatch.Pattern.Lines.Count == 0 || hatch.Paths.Count == 0)
            return Review("unsupported-or-missing-pattern-definition");
        for (int i = 0; i < hatch.Pattern.Lines.Count; i++)
        {
            var line = hatch.Pattern.Lines[i];
            if (line.DashLengths.Count != 0 || !double.IsFinite(line.Angle)
                || !Finite(line.BasePoint) || !Finite(line.Offset))
                return Review("unsupported-or-invalid-pattern-line");
            var normal = new XY(-Math.Sin(line.Angle), Math.Cos(line.Angle));
            var bounds = new Projection(normal, line.BasePoint);
            foreach (var path in hatch.Paths)
                if (!bounds.Add(path)) return Review(bounds.Reason);
            double spacing = Dot(line.Offset, normal);
            // Expand, never shrink, the source interval. Near tangencies and numerically
            // dense line families remain unknown; no geometry tolerance is relaxed.
            double tolerance = 1e-7 + 64 * 2.220446049250313e-16 * (bounds.Scale + Math.Abs(line.Offset.X) + Math.Abs(line.Offset.Y));
            if (!double.IsFinite(spacing) || Math.Abs(spacing) <= tolerance)
                return Review("zero-or-numerically-dense-spacing");
            double a = (bounds.Min - tolerance) / spacing, b = (bounds.Max + tolerance) / spacing;
            double min = Math.Min(a, b), max = Math.Max(a, b);
            if (!double.IsFinite(min) || !double.IsFinite(max) || Math.Max(Math.Abs(min), Math.Abs(max)) >= 4503599627370496)
                return Review("unreliable-projection-range");
            ranges.Add(new(i, min, max, tolerance));
            if (Math.Ceiling(min) <= Math.Floor(max)) return Review("pattern-line-may-cross-boundary");
        }
        return new(Empty, "no-integer-line-crosses-read-boundaries", "analytic-boundary-projection/1", ranges);
    }
    static double Dot(XY a, XY b) => a.X * b.X + a.Y * b.Y;
    static bool Finite(XY p) => double.IsFinite(p.X) && double.IsFinite(p.Y);
    sealed class Projection(XY normal, XY origin)
    {
        public string Reason = "unsupported-or-invalid-boundary";
        public double Min = double.PositiveInfinity, Max = double.NegativeInfinity;
        public double Scale = Math.Abs(origin.X) + Math.Abs(origin.Y);
        bool Value(double value)
        {
            if (!double.IsFinite(value)) return false;
            Min = Math.Min(Min, value); Max = Math.Max(Max, value); return true;
        }
        bool Point(XY p)
        {
            if (!Finite(p)) return false;
            Scale = Math.Max(Scale, Math.Abs(p.X) + Math.Abs(p.Y) + Math.Abs(origin.X) + Math.Abs(origin.Y));
            return Value(Dot(p - origin, normal));
        }
        bool Segment(XY a, XY b, double bulge)
        {
            if (!Point(a) || !Point(b) || !double.IsFinite(bulge)) return false;
            if (bulge == 0) return true;
            if (a == b) return false;
            var delta = b - a;
            double f = (1 - bulge * bulge) / (4 * bulge);
            var center = (a + b) / 2 + new XY(-delta.Y, delta.X) * f;
            double radius = (a - center).GetLength();
            if (!Finite(center) || !double.IsFinite(radius) || radius <= 0) return false;
            Scale = Math.Max(Scale, Math.Abs(center.X) + Math.Abs(center.Y) + radius + Math.Abs(origin.X) + Math.Abs(origin.Y));
            double start = Math.Atan2(a.Y - center.Y, a.X - center.X), sweep = 4 * Math.Atan(bulge);
            double direction = Math.Atan2(normal.Y, normal.X);
            foreach (double angle in new[] { direction, direction + Math.PI })
            {
                double offset = sweep > 0 ? angle - start : start - angle;
                offset = (offset % Math.Tau + Math.Tau) % Math.Tau;
                // Including an extremum just outside the arc only makes the proof more conservative.
                if (offset <= Math.Abs(sweep) + 1e-12
                    && !Value(Dot(center - origin, normal) + radius * (Math.Cos(angle) * normal.X + Math.Sin(angle) * normal.Y))) return false;
            }
            return true;
        }
        public bool Add(Hatch.BoundaryPath path)
        {
            if (path.Edges.Count == 1 && path.Edges[0] is Hatch.BoundaryPath.Polyline poly)
            {
                if (!poly.IsClosed || poly.Vertices.Count < 3) return false;
                for (int i = 0; i < poly.Vertices.Count; i++)
                {
                    var a = poly.Vertices[i]; var b = poly.Vertices[(i + 1) % poly.Vertices.Count];
                    if (!Segment(new XY(a.X, a.Y), new XY(b.X, b.Y), a.Z)) return false;
                }
                return true;
            }
            if (path.Edges.Count == 1 && path.Edges[0] is Hatch.BoundaryPath.Arc circle)
            {
                if (!Finite(circle.Center) || !double.IsFinite(circle.Radius) || circle.Radius <= 0
                    || !double.IsFinite(circle.StartAngle) || !double.IsFinite(circle.EndAngle)
                    || Math.Abs(Math.Abs(circle.EndAngle - circle.StartAngle) - Math.Tau) > 1e-12) return false;
                Scale = Math.Max(Scale, Math.Abs(circle.Center.X) + Math.Abs(circle.Center.Y) + circle.Radius + Math.Abs(origin.X) + Math.Abs(origin.Y));
                double center = Dot(circle.Center - origin, normal);
                return Value(center - circle.Radius) && Value(center + circle.Radius);
            }
            if (path.Edges.Count == 1 && path.Edges[0] is Hatch.BoundaryPath.Ellipse ellipse)
            {
                if (!double.IsFinite(ellipse.StartAngle) || !double.IsFinite(ellipse.EndAngle)
                    || Math.Abs(Math.Abs(ellipse.EndAngle - ellipse.StartAngle) - Math.Tau) > 1e-12
                    || !Finite(ellipse.Center) || !Finite(ellipse.MajorAxisEndPoint)
                    || !double.IsFinite(ellipse.RadiusRatio) || ellipse.RadiusRatio <= 0 || ellipse.RadiusRatio > 1) return false;
                var major = ellipse.MajorAxisEndPoint;
                if (major.GetLength() == 0) return false;
                var minor = new XY(-major.Y, major.X) * ellipse.RadiusRatio;
                double x = Dot(major, normal), y = Dot(minor, normal), radius = Math.Sqrt(x * x + y * y);
                Scale = Math.Max(Scale, Math.Abs(ellipse.Center.X) + Math.Abs(ellipse.Center.Y) + major.GetLength() + Math.Abs(origin.X) + Math.Abs(origin.Y));
                double center = Dot(ellipse.Center - origin, normal);
                return Value(center - radius) && Value(center + radius);
            }
            if (path.Edges.Count < 3 || path.Edges.Any(e => e is not Hatch.BoundaryPath.Line)) return false;
            for (int i = 0; i < path.Edges.Count; i++)
            {
                var line = (Hatch.BoundaryPath.Line)path.Edges[i];
                var next = (Hatch.BoundaryPath.Line)path.Edges[(i + 1) % path.Edges.Count];
                if (line.End != next.Start) { Reason = "line-boundary-not-exactly-closed"; return false; }
                if (!Segment(line.Start, line.End, 0)) return false;
            }
            return true;
        }
    }
}
