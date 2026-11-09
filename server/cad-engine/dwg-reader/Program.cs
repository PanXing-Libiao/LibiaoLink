using System.Collections;
using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using ACadSharp;
using ACadSharp.Entities;
using ACadSharp.Blocks;
using ACadSharp.Entities.ProxyGraphics;
using ACadSharp.Extensions;
using ACadSharp.IO;
using ACadSharp.Objects;
using ACadSharp.Tables;
using CSMath;
using CSMath.Extensions;
using Row = System.Collections.Generic.Dictionary<string, object?>;

// Native DWG objects -> UCD records. Geometry evaluation belongs to ACadSharp;
// this process owns source identity, mapping and an explicit loss ledger only.
static class Program
{
    static readonly double[] Identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    static StreamWriter records = null!, losses = null!;
    static BinaryWriter positions = null!;
    static string sourceId = "", drawingId = "drawing-dwg", output = "";
    static int order, lost;
    static readonly HashSet<string> ids = [];
    static readonly HashSet<string> emitted = [];
    static readonly HashSet<ulong> mappedSourceHandles = [];
    static readonly Dictionary<string,int> counts = [];
    static readonly HashSet<ulong> reachable = [];
    static readonly Dictionary<ulong, string> spaces = [];
    static readonly Dictionary<ulong, Row> dimensionSources = [];
    static readonly Dictionary<ulong, byte[]> proxySources = [];
    static Row R(params (string, object?)[] values) => values.ToDictionary(x => x.Item1, x => x.Item2);
    static double[] P(XYZ p) => [p.X, p.Y, p.Z];
    static string H(CadObject o) => o.Handle.ToString("X");
    static object[] Refs(CadObject o) => [R(("sourceId", sourceId), ("objectKey", H(o)))];
    static Row Fact(object? value) => R(("value",value),("knowledge","source-declared"),("validation","experimental"),("evidenceIds",new[]{"native-dwg-read"}));
    static Row Unknown() => R(("knowledge","unknown"),("validation","not-applicable"),("evidenceIds",Array.Empty<string>()));
    static void Emit(string table, string id, object value)
    {
        records.WriteLine(JsonSerializer.Serialize(new { table, id, value }));
        if(table is "entities" or "annotations" or "blockInstances")emitted.Add(id);
    }
    static void Loss(CadObject? obj, string code, string message)
    {
        lost++;
        losses.WriteLine(JsonSerializer.Serialize(new {code, message, handle=obj is null ? null : H(obj), sourceType=obj?.ObjectName}));
    }
    static Row ColorStyle(Color color, bool plot = true)
    {
        Row c;
        if(color.IsByLayer) c=R(("mode","by-layer"));
        else if(color.IsByBlock) c=R(("mode","by-block"));
        else if(!color.IsTrueColor && color.Index == 257) c=R(("mode","unknown"));
        else { var rgb=color.GetRgb(); c=R(("mode","explicit"),("rgba",!color.IsTrueColor&&color.Index==7?new double[]{0,0,0,1}:new double[]{rgb[0]/255.0,rgb[1]/255.0,rgb[2]/255.0,1})); }
        return R(("color",c),("plot",plot));
    }
    static Row Style(Entity e)
    {
        var style=ColorStyle(e.Color);
        if(e.LineType is not null) style["lineTypeId"]="linetype-"+H(e.LineType);
        if((short)e.LineWeight>=0) style["lineWeight"]=Fact((short)e.LineWeight/100.0);
        return style;
    }
    static bool EntityVisible(Entity e)
    {
        if(e.IsInvisible)return false;
        if(e is not AttributeEntity attribute)return true;
        var mode=attribute.Document?.Header.AttributeVisibility ?? ACadSharp.Header.AttributeVisibilityMode.Normal;
        return mode switch {
            ACadSharp.Header.AttributeVisibilityMode.None => false,
            ACadSharp.Header.AttributeVisibilityMode.All => true,
            _ => !attribute.Flags.HasFlag(AttributeFlags.Hidden)
        };
    }
    static void State(Entity e, string id, Row? extra=null)
    {
        var state=extra ?? R();
        state["visible"]=EntityVisible(e);
        if(e is AttributeEntity attribute)state["attributeFlags"]=(int)attribute.Flags;
        state["lineTypeScale"]=e.LineTypeScale;
        state["drawOrder"]=order++;
        state["nativeColor"]=R(("index",e.Color.Index),("trueColor",e.Color.TrueColor));
        Emit("entityState",id,state);
    }
    static double[] Matrix(Transform transform)
    {
        var origin=transform.ApplyTransform(XYZ.Zero);
        var x=transform.ApplyTransform(XYZ.AxisX)-origin;
        var y=transform.ApplyTransform(XYZ.AxisY)-origin;
        var z=transform.ApplyTransform(XYZ.AxisZ)-origin;
        return [x.X,x.Y,x.Z,0, y.X,y.Y,y.Z,0, z.X,z.Y,z.Z,0, origin.X,origin.Y,origin.Z,1];
    }
    // ACadSharp 3.8.30 subtracts the base before R*S; it must be in block coordinates.
    static Transform InsertTransform(Insert insert)
    {
        var basis=Matrix4.GetArbitraryAxis(insert.Normal);
        var origin=insert.Block?.BlockEntity?.BasePoint ?? XYZ.Zero;
        return new Transform(basis * Transform.CreateTranslation(insert.InsertPoint).Matrix
            * Transform.CreateRotation(XYZ.AxisZ,insert.Rotation).Matrix
            * Transform.CreateScaling(new XYZ(insert.XScale,insert.YScale,insert.ZScale)).Matrix
            * Transform.CreateTranslation(-origin).Matrix);
    }
    static List<XYZ> Closed(IEnumerable<XYZ> values)
    {
        var points=values.ToList();
        if(points.Count>1 && points[0]!=points[^1]) points.Add(points[0]);
        return points;
    }
    static Row ArcGeometry(Circle circle, double start, double sweep)
    {
        var ocs=Matrix4.GetArbitraryAxis(circle.Normal);
        return R(("type","arc"),("center",P(ocs*circle.Center)),("normal",P(circle.Normal.Normalize())),
            ("xAxis",P(ocs*XYZ.AxisX)),("radius",circle.Radius),("startAngle",start),("sweepAngle",sweep));
    }
    static void Display(string id, CadObject original, IEnumerable<XYZ> pts, string topology="lines")
    {
        var points=pts.ToList();
        if(points.Count==0 || points.Any(p=>!double.IsFinite(p.X)||!double.IsFinite(p.Y)||!double.IsFinite(p.Z)))
            throw new InvalidDataException("Community geometry returned empty or nonfinite points: "+id);
        long offset=positions.BaseStream.Position;
        var vertices=topology=="lines" ? points.Zip(points.Skip(1)).SelectMany(pair=>new[]{pair.First,pair.Second}) : points;
        int count=0;
        foreach(var p in vertices) { positions.Write(p.X); positions.Write(p.Y); positions.Write(p.Z); count++; }
        var min=new[]{points.Min(p=>p.X),points.Min(p=>p.Y),points.Min(p=>p.Z)};
        var max=new[]{points.Max(p=>p.X),points.Max(p=>p.Y),points.Max(p=>p.Z)};
        Emit("displays",id,new {offset, byteLength=count*24, count, topology, min, max, sourceRefs=Refs(original)});
    }
    static double[][] PolylineWidths(Entity entity, IPolyline polyline)
    {
        // DWG vertices carry explicit widths; LWPOLYLINE constant width overrides them.
        double constant=entity is LwPolyline lw ? lw.ConstantWidth : 0;
        return polyline.Vertices.Select(v=>constant!=0 ? new[]{constant,constant} : v switch {
            LwPolyline.Vertex vertex=>new[]{vertex.StartWidth,vertex.EndWidth},
            Vertex2D vertex=>new[]{vertex.StartWidth,vertex.EndWidth},
            _=>new[]{0.0,0.0}
        }).ToArray();
    }
    static Row Poly(IEnumerable<XYZ> values, bool closed=false)
    {
        var pts=values.ToArray(); int n=closed?pts.Length:pts.Length-1;
        return R(("type","polyline"),("points",pts.Select(P).ToArray()),("closed",closed),
                 ("bulges",Enumerable.Repeat(0.0,Math.Max(0,n)).ToArray()),("widths",Enumerable.Range(0,Math.Max(0,n)).Select(_=>new[]{0.0,0.0}).ToArray()));
    }
    // Multi-chain presentation: the buffer holds already-paired segments, so the
    // viewer's non-indexed 'lines' pair stepping sees every element chain.
    static void DisplayPairs(string id, CadObject original, IReadOnlyList<XYZ> pairs)
    {
        if(pairs.Count==0) throw new InvalidDataException("MLine produced no element segments: "+id);
        if(pairs.Any(p=>!double.IsFinite(p.X)||!double.IsFinite(p.Y)||!double.IsFinite(p.Z)))
            throw new InvalidDataException("MLine element segments are not finite: "+id);
        long offset=positions.BaseStream.Position;
        foreach(var p in pairs){positions.Write(p.X);positions.Write(p.Y);positions.Write(p.Z);}
        var min=new[]{pairs.Min(p=>p.X),pairs.Min(p=>p.Y),pairs.Min(p=>p.Z)};
        var max=new[]{pairs.Max(p=>p.X),pairs.Max(p=>p.Y),pairs.Max(p=>p.Z)};
        Emit("displays",id,new {offset, byteLength=pairs.Count*24, count=pairs.Count, topology="lines", min, max, sourceRefs=Refs(original)});
    }
    static double[]? Unit(double x, double y)
    {
        double length=Math.Sqrt(x*x+y*y);
        return length<1e-12?null:new[]{x/length,y/length};
    }
    static double[] LeftNormal(double[] direction) => new[]{-direction[1],direction[0]};
    static double Dot(double[] a, double[] b) => a[0]*b[0]+a[1]*b[1];
    // MLINE presentation. ACadSharp exposes the final per-vertex line direction,
    // miter direction, style element offsets and (when the DWG stores them) the
    // per-element miter lengths. Points follow AutoCAD's parametrization: the
    // miter length is (offset + justification shift) scaled and stretched by the
    // miter angle; style flags add square/round caps and the area fill band.
    static List<XYZ[]> MiterPointSets(MLine mline, List<double> offsets, double scale, double shift,
        List<double[]?> secondNormals)
    {
        var vertices=mline.Vertices;
        var result=new List<XYZ[]>();
        for(int i=0;i<vertices.Count;i++)
        {
            var position=vertices[i].Position;
            double[]? previous=i>0?Unit(position.X-vertices[i-1].Position.X,position.Y-vertices[i-1].Position.Y):null;
            double[]? next=i<vertices.Count-1?Unit(vertices[i+1].Position.X-position.X,vertices[i+1].Position.Y-position.Y):null;
            var stored=vertices[i].Direction;
            var direction=Unit(stored.X,stored.Y) ?? next ?? previous;
            double[]? miterDirection=null, second=null;
            double stretch=scale;
            var storedMiter=Unit(vertices[i].Miter.X,vertices[i].Miter.Y);
            if(storedMiter is not null && direction is not null && Math.Abs(Dot(storedMiter,direction))<0.5)
            {
                miterDirection=storedMiter;
                double sine=Math.Abs(storedMiter[0]*direction[1]-storedMiter[1]*direction[0]);
                stretch=sine<1e-6?1:scale/sine;
            }
            else if(previous is not null && next is not null)
            {
                var left0=LeftNormal(previous); var left1=LeftNormal(next);
                var bisector=Unit(left0[0]+left1[0],left0[1]+left1[1]);
                if(bisector is null)
                {
                    // A 180-degree turn has no bisector; carry the incoming normal
                    // into the vertex and cap over to the outgoing side.
                    miterDirection=left0; second=left1;
                }
                else {
                    double cosine=Math.Abs(Dot(bisector,left1));
                    stretch=scale/Math.Max(0.2,cosine);
                    miterDirection=bisector;
                }
            }
            else miterDirection=next is not null?LeftNormal(next):(previous is not null?LeftNormal(previous):new[]{0.0,0.0});
            miterDirection ??= new[]{0.0,0.0};
            // Stored per-element parameters already carry the final miter lengths.
            var segments=vertices[i].Segments;
            double[]? lengths=segments is not null && segments.Count==offsets.Count
                ? segments.Select(segment=>segment.Parameters.Count>0?segment.Parameters[0]:double.NaN).ToArray()
                : null;
            var set=new XYZ[offsets.Count];
            for(int e=0;e<offsets.Count;e++)
            {
                double length=lengths is not null && double.IsFinite(lengths[e]) ? lengths[e] : (offsets[e]+shift)*stretch;
                set[e]=new XYZ(position.X+miterDirection[0]*length,position.Y+miterDirection[1]*length,position.Z);
            }
            result.Add(set);
            secondNormals.Add(second);
        }
        return result;
    }
    // Half-circle between two border points, used by round caps and inner arcs.
    static List<XYZ> ArcPoints(XYZ start, XYZ end, int segments=16)
    {
        double cx=(start.X+end.X)/2, cy=(start.Y+end.Y)/2;
        double dx=start.X-cx, dy=start.Y-cy;
        double radius=Math.Sqrt(dx*dx+dy*dy);
        if(radius<1e-9) return new List<XYZ>{start,end};
        double angle=Math.Atan2(dy,dx);
        var points=new List<XYZ>(segments+1);
        for(int i=0;i<=segments;i++)
        {
            double t=angle+Math.PI*i/segments;
            points.Add(new XYZ(cx+radius*Math.Cos(t),cy+radius*Math.Sin(t),start.Z));
        }
        return points;
    }
    static void MapMLine(MLine mline, string space, string id, CadObject original)
    {
        var vertices=mline.Vertices;
        var normal=mline.Normal;
        if(vertices.Count<2 || Math.Abs(normal.X)>1e-9 || Math.Abs(normal.Y)>1e-9 || Math.Abs(normal.Z-1)>1e-9)
        {
            EntityRow(mline,space,id,R(("type","unsupported"),("sourceType","MLINE"),
                ("reason","Native object retained; no accepted 2D presentation mapping")),null,original:original);
            Loss(original,"unsupported-native-presentation","No accepted native presentation: MLine");
            return;
        }
        double scale=Math.Abs(mline.ScaleFactor)<1e-9?1:mline.ScaleFactor;
        var elements=mline.Style?.Elements;
        var offsets=elements is null?new List<double>():elements.Select(element=>element.Offset).ToList();
        if(offsets.Count==0) offsets.Add(0);
        var ordered=Enumerable.Range(0,offsets.Count).OrderBy(index=>offsets[index]).ToArray();
        int bottomIndex=ordered[0], topIndex=ordered[^1];
        double shift=mline.Justification switch {
            MLineJustification.Top=>-offsets.Max(),
            MLineJustification.Bottom=>-offsets.Min(),
            _=>0};
        var secondNormals=new List<double[]?>();
        var miterSets=MiterPointSets(mline,offsets,scale,shift,secondNormals);
        var flags=mline.Style?.Flags ?? MLineStyleFlags.None;
        bool closed=mline.Flags.HasFlag(MLineFlags.Closed);
        var segments=new List<XYZ>();
        void AddChain(IEnumerable<XYZ> chainPoints)
        {
            var list=chainPoints.ToList();
            if(closed&&list.Count>1) list.Add(list[0]);
            for(int i=0;i+1<list.Count;i++){segments.Add(list[i]);segments.Add(list[i+1]);}
        }
        for(int e=0;e<offsets.Count;e++)
        {
            var chain=new List<XYZ>();
            for(int i=0;i<miterSets.Count;i++)
            {
                chain.Add(miterSets[i][e]);
                if(secondNormals[i] is not null)
                {
                    double length=(offsets[e]+shift)*scale;
                    var position=vertices[i].Position;
                    chain.Add(new XYZ(position.X+secondNormals[i]![0]*length,position.Y+secondNormals[i]![1]*length,position.Z));
                }
            }
            AddChain(chain);
        }
        var baseline=vertices.Select(v=>v.Position).ToArray();
        EntityRow(mline,space,id,Poly(baseline),null,original:original);
        var startCapPoints=new List<XYZ>();
        var endCapPoints=new List<XYZ>();
        if(!closed)
        {
            var start=miterSets[0]; var end=miterSets[^1];
            if(flags.HasFlag(MLineStyleFlags.StartSquareCap))
            { segments.Add(start[topIndex]); segments.Add(start[bottomIndex]); }
            if(flags.HasFlag(MLineStyleFlags.EndSquareCap))
            { segments.Add(end[topIndex]); segments.Add(end[bottomIndex]); }
            if(flags.HasFlag(MLineStyleFlags.StartRoundCap))
                startCapPoints=ArcPoints(start[topIndex],start[bottomIndex]);
            if(flags.HasFlag(MLineStyleFlags.EndRoundCap))
                endCapPoints=ArcPoints(end[bottomIndex],end[topIndex]);
            if(offsets.Count>3 && flags.HasFlag(MLineStyleFlags.StartInnerArcsCap))
                startCapPoints.AddRange(ArcPoints(start[ordered[^2]],start[ordered[1]]));
            if(offsets.Count>3 && flags.HasFlag(MLineStyleFlags.EndInnerArcsCap))
                endCapPoints.AddRange(ArcPoints(end[ordered[1]],end[ordered[^2]]));
            AddChain(startCapPoints);
            AddChain(endCapPoints);
        }
        if(flags.HasFlag(MLineStyleFlags.FillOn))
        {
            // The fill band runs along the bottom border, around the end cap,
            // back along the top border and around the start cap.
            var ring=new List<XYZ>();
            for(int i=0;i<miterSets.Count;i++) ring.Add(miterSets[i][bottomIndex]);
            ring.AddRange(endCapPoints);
            for(int i=miterSets.Count-1;i>=0;i--) ring.Add(miterSets[i][topIndex]);
            ring.AddRange(startCapPoints);
            if(ring.Count>=3) Emit("fills",id,new{rings=new[]{ring.Select(P).ToArray()},fillRule="even-odd"});
        }
        DisplayPairs(id,original,segments);
    }
    static void EntityRow(Entity e, string space, string id, Row geometry, IEnumerable<XYZ>? points, double[]? local=null, string topology="lines", CadObject? original=null)
    {
        original ??= e;
        if(original.Handle!=0)mappedSourceHandles.Add(original.Handle);
        Emit("entities",id,R(("id",id),("drawingId",drawingId),("ownerSpaceId",space),("layerId","layer-"+H(e.Layer)),
             ("localFromOwner",local??Identity),("geometry",geometry),("style",Style(e)),("sourceRefs",Refs(original)),("displayOrder",order)));
        State(e,id);
        if(points is not null) Display(id,original,points,topology);
    }
    static void Infinite(Entity e,string space,string id,string kind,XYZ origin,XYZ direction,CadObject? original=null)
    {
        original ??= e;
        if(Math.Sqrt(direction.X*direction.X+direction.Y*direction.Y+direction.Z*direction.Z)<1e-12)
            throw new InvalidDataException("Infinite line has zero direction");
        Emit("infiniteLines",id,R(("kind",kind),("origin",P(origin)),("direction",P(direction)),("sourceRefs",Refs(original))));
        EntityRow(e,space,id,R(("type","unsupported"),("sourceType",kind.ToUpperInvariant()),
            ("reason","Parametric infinite line; view-dependent presentation")),null,original:original);
    }
    static XYZ[] DefaultLeaderArrowPoints(XYZ tip,XYZ next,double size)
    {
        if(!(size>0)||!double.IsFinite(size))throw new InvalidDataException("leader arrow size is invalid");
        double dx=next.X-tip.X,dy=next.Y-tip.Y,length=Math.Sqrt(dx*dx+dy*dy);
        if(length<1e-12)throw new InvalidDataException("leader arrow direction is zero");
        double ux=dx/length,uy=dy/length,half=size/6.0;
        var basePoint=new XYZ(tip.X+ux*size,tip.Y+uy*size,tip.Z);
        return new[]{tip,
            new XYZ(basePoint.X-uy*half,basePoint.Y+ux*half,tip.Z),
            new XYZ(basePoint.X+uy*half,basePoint.Y-ux*half,tip.Z)};
    }
    static void LeaderArrow(Entity e,string space,string id,Leader leader,CadObject original)
    {
        if(!leader.ArrowHeadEnabled)return;
        if(leader.Vertices.Count<2){Loss(original,"leader-arrow-presentation","Leader has no segment for arrowhead placement");return;}
        if(leader.Style?.LeaderArrow is not null){Loss(original,"leader-arrow-presentation","Custom leader arrow block retained; no accepted placement mapping");return;}
        XYZ[] points;
        try{points=DefaultLeaderArrowPoints(leader.Vertices[0],leader.Vertices[1],leader.Style?.ArrowSize??0);}
        catch(InvalidDataException error){Loss(original,"leader-arrow-presentation",error.Message);return;}
        string arrowId=id+"-leader-arrow";
        EntityRow(e,space,arrowId,Poly(points,true),Closed(points),original:original);
        Emit("fills",arrowId,new{rings=new[]{points.Select(P).ToArray()},fillRule="even-odd"});
    }
    static void WipeoutMask(Entity e,string space,string id,Wipeout wipeout,CadObject original)
    {
        if(!wipeout.ShowImage)return;
        var u=wipeout.UVector;var v=wipeout.VVector;var size=wipeout.Size;
        if(size.X<=0||size.Y<=0||(u.X==0&&u.Y==0)||(v.X==0&&v.Y==0)){
            Loss(original,"wipeout-boundary-invalid","Wipeout has no usable image size or U/V vectors");return;
        }
        // DXF/EZDXF image boundary: clipping vertices are in pixel coordinates,
        // the image origin is insert + u/2 - v/2 and y is measured from the top.
        var origin=new XYZ(wipeout.InsertPoint.X+u.X*0.5-v.X*0.5,
            wipeout.InsertPoint.Y+u.Y*0.5-v.Y*0.5,
            wipeout.InsertPoint.Z+u.Z*0.5-v.Z*0.5);
        var clips=wipeout.ClippingState?wipeout.ClipBoundaryVertices:new List<XY>();
        List<XY> pixels;
        if(clips.Count>=3) pixels=clips.ToList();
        else if(clips.Count==2){
            var p0=clips[0];var p1=clips[1];
            pixels=new List<XY>{p0,new XY(p1.X,p0.Y),p1,new XY(p0.X,p1.Y)};
        }else pixels=new List<XY>{new XY(-0.5,-0.5),new XY(size.X-0.5,-0.5),
            new XY(size.X-0.5,size.Y-0.5),new XY(-0.5,size.Y-0.5)};
        // A wipeout follows the viewer background, independent of its stored color.
        // It is not a viewer mask part, so hit testing is not occluded.
        var points=pixels.Select(p=>new XYZ(
            origin.X+u.X*p.X+v.X*(size.Y-p.Y),
            origin.Y+u.Y*p.X+v.Y*(size.Y-p.Y),
            origin.Z+u.Z*p.X+v.Z*(size.Y-p.Y))).ToArray();
        if(points.Length<3){Loss(original,"wipeout-boundary-invalid","Wipeout boundary has fewer than three vertices");return;}
        var mask=new Polyline3D(points){Layer=e.Layer,Color=new Color(255,255,255),LineType=e.LineType};
        EntityRow(mask,space,id,Poly(points,true),Closed(points),original:original);
        Emit("fills",id,new{rings=new[]{points.Select(P).ToArray()},fillRule="even-odd",mask=true});
    }
    static string FontFamily(TextStyle style) => style.ExtendedData
        .Where(pair=>pair.Key.Name=="ACAD").SelectMany(pair=>pair.Value.Records)
        .OfType<ACadSharp.XData.ExtendedDataString>().Select(record=>record.Value).FirstOrDefault() ?? "";
    static void Text(Entity e, IText text, string space, string id, CadObject? original=null)
    {
        original ??=e;
        if(original.Handle!=0)mappedSourceHandles.Add(original.Handle);
        XYZ point=text.InsertPoint;
        if(e is TextEntity t && (t.HorizontalAlignment.ToString()!="Left" || t.VerticalAlignment.ToString()!="Baseline")
            && t.HorizontalAlignment.ToString() is not ("Fit" or "Aligned")) point=t.AlignmentPoint;
        string value=e is MText m ? CommunityText.Plain(m) : CommunityText.Normalize(text.Value);
        var semantic=R(("height",Fact(text.Height)),("rotation",Fact(text.Rotation)),("textStyleId",Fact("textstyle-"+H(text.Style))),
                      ("rawText",Fact(text.Value)),("fontFilename",Fact(text.Style.Filename)),("bigFontFilename",Fact(text.Style.BigFontFilename)));
        semantic["fontFamily"]=Fact(FontFamily(text.Style));
        semantic["styleWidthFactor"]=Fact(text.Style.Width);
        semantic["styleOblique"]=Fact(text.Style.ObliqueAngle);
        semantic["styleFlags"]=Fact((int)text.Style.Flags);
        semantic["insertPoint"]=Fact(P(text.InsertPoint));
        semantic["normal"]=Fact(P(e is MText mt ? mt.Normal : ((TextEntity)e).Normal));
        if(e is TextEntity single) {
            semantic["oblique"]=Fact(single.ObliqueAngle);
            semantic["mirror"]=Fact((int)single.Mirror);
            semantic["widthFactor"]=Fact(single.WidthFactor);
            semantic["halign"]=Fact((int)single.HorizontalAlignment);
            semantic["valign"]=Fact((int)single.VerticalAlignment);
            semantic["horizontalAlignment"]=Fact(single.HorizontalAlignment.ToString());
            semantic["verticalAlignment"]=Fact(single.VerticalAlignment.ToString());
            semantic["alignmentPoint"]=Fact(P(single.AlignmentPoint));
            if(single.HorizontalAlignment.ToString() is "Fit" or "Aligned") {
                var ocs=new Transform(Matrix4.GetArbitraryAxis(single.Normal));
                semantic["fitPoints"]=Fact(new[]{P(ocs.ApplyTransform(single.InsertPoint)),P(ocs.ApplyTransform(single.AlignmentPoint))});
            }
        }
        if(e is MText multiline) {
            semantic["attachmentPoint"]=Fact((int)multiline.AttachmentPoint);
            semantic["rectangleWidth"]=Fact(multiline.RectangleWidth);
            semantic["lineSpacing"]=Fact(multiline.LineSpacing);
            semantic["lineSpacingStyle"]=Fact(multiline.LineSpacingStyle.ToString());
            semantic["drawingDirection"]=Fact(multiline.DrawingDirection.ToString());
            semantic["hasColumns"]=Fact(multiline.HasColumns);
            if(multiline.DrawingDirection.ToString()=="TopToBottom" || multiline.HasColumns)
                Loss(original,"mtext-special-layout-unmapped","Vertical/column MTEXT retained; this presentation does not claim its original layout.");
        }
        var row=R(("id",id),("ownerSpaceId",space),("layerId","layer-"+H(e.Layer)),("kind",e is MText?"mtext":"text"),
             ("position",P(point)),("direction",new[]{Math.Cos(text.Rotation),Math.Sin(text.Rotation),0.0}),
             ("text",value),("semantic",semantic),("associativeEntityIds",Array.Empty<string>()),
             ("presentationEntityIds",Array.Empty<string>()),("annotationScales",Array.Empty<double>()),("sourceRefs",Refs(original)));
        if(e is AttributeEntity attribute) semantic["attributeTag"]=Fact(attribute.Tag);
        if(e is AttributeEntity && e.Owner is Insert parent) row["ownerBlockInstanceId"]="instance-"+H(parent);
        Emit("annotations",id,row);
        Emit("annotationStyles",id,Style(e));
        State(e,id,e is AttributeDefinition ? R(("attributeTemplate",true)) : null);
        if(e is MText special && (special.DrawingDirection.ToString()=="TopToBottom" || special.HasColumns))
            Emit("entityState",id,R(("presentationGeometry","missing")));
        Emit("textAppearance",id,R(("fontFamily",Path.GetFileNameWithoutExtension(text.Style.Filename)),("fontStatus","substituted")));
    }
    static void Instance(Entity e, BlockRecord definition, string space, string id, double[] matrix)
    {
        if(e.Handle!=0)mappedSourceHandles.Add(e.Handle);
        var row=R(("id",id),("ownerSpaceId",space),("definitionId","block-"+H(definition)),("layerId","layer-"+H(e.Layer)),
                  ("localFromBlock",matrix),("attributes",R()),("style",Style(e)),("sourceRefs",Refs(e)));
        if(e is Insert i) {
            // Tags are labels, not entity identities; repeated tags must not drop the INSERT.
            var attributes=new Dictionary<string,string>();
            foreach(var group in i.Attributes.GroupBy(a=>a.Tag)) {
                attributes.Add(group.Key,group.First().Value);
                if(group.Skip(1).Any())Loss(i,"duplicate-attribute-tag",
                    "Repeated attribute tag: "+group.Key+"; tag summary keeps the first source value; all attribute entities retain their own tag, value and placement.");
            }
            row["attributes"]=attributes;
            if(i.SpatialFilter is SpatialFilter clip) {
                bool inverted=clip.XDictionary is not null
                    && clip.XDictionary.TryGetEntry("ACAD_XREC_ROUNDTRIP",out XRecord roundtrip)
                    && roundtrip.Entries.Any(entry=>entry.Value is string name && name=="ACAD_INVERTEDCLIP_ROUNDTRIP");
                Emit("nativeBlockClips",id,new{enabled=clip.DisplayBoundary,
                    boundary=clip.BoundaryPoints.Select(p=>new[]{p.X,p.Y}).ToArray(),
                    normal=P(clip.Normal),origin=P(clip.Origin),
                    inverseInsert=Matrix(new Transform(clip.InverseInsertTransform)),
                    clipTransform=Matrix(new Transform(clip.InsertTransform)),
                    front=clip.ClipFrontPlane,back=clip.ClipBackPlane,inverted,sourceRefs=Refs(clip)});
            }
            if(i.IsMultiple) row["array"]=R(("rows",(int)i.RowCount),("columns",(int)i.ColumnCount),
              ("rowOffset",new[]{-Math.Sin(i.Rotation)*i.RowSpacing,Math.Cos(i.Rotation)*i.RowSpacing,0}),
              ("columnOffset",new[]{Math.Cos(i.Rotation)*i.ColumnSpacing,Math.Sin(i.Rotation)*i.ColumnSpacing,0}));
        }
        Emit("blockInstances",id,row); State(e,id);
    }
    static void ReadDimensionSources(DwgReader reader, CadDocument doc)
    {
        // The pinned reader resolves Block=null both for a zero source pointer and
        // for an unresolved nonzero pointer. Preserve the distinction before mapping.
        var builder=typeof(DwgReader).GetField("_builder",BindingFlags.Instance|BindingFlags.NonPublic)!.GetValue(reader)!;
        var builderType=typeof(DwgReader).Assembly.GetType("ACadSharp.IO.CadDocumentBuilder")!;
        var templates=(IDictionary)builderType.GetField("templatesMap",BindingFlags.Instance|BindingFlags.NonPublic)!.GetValue(builder)!;
        foreach(var dimension in doc.BlockRecords.SelectMany(b=>b.Entities).OfType<Dimension>()) {
            var template=templates[dimension.Handle]!;
            var raw=(ulong?)template.GetType().GetProperty("BlockHandle")!.GetValue(template);
            var dependencies=new List<Row>();
            foreach(var reactor in dimension.Reactors.Where(r=>r.ObjectName=="ACDBASSOCDEPENDENCY")) {
                var dependency=templates[reactor.Handle];
                var owner=(ulong?)dependency?.GetType().GetProperty("OwnerHandle")!.GetValue(dependency);
                var ownerTemplate=owner.HasValue?templates[owner.Value]:null;
                var group=(CadObject?)ownerTemplate?.GetType().GetProperty("CadObject",typeof(CadObject))!.GetValue(ownerTemplate);
                if(group?.ObjectName=="ACDBASSOC2DCONSTRAINTGROUP")
                    dependencies.Add(R(("dependencyHandle",H(reactor)),("constraintGroupHandle",H(group))));
            }
            dimensionSources[dimension.Handle]=R(("sourcePictureBlockHandle",raw?.ToString("X")),
                ("pictureStatus",DimensionPictureStatus(dimension,raw,dependencies.Count>0)),
                ("constraintDependencies",dependencies));
        }
    }
    static void ReadProxySources(DwgReader reader, CadDocument doc)
    {
        var builder=typeof(DwgReader).GetField("_builder",BindingFlags.Instance|BindingFlags.NonPublic)!.GetValue(reader)!;
        var builderType=typeof(DwgReader).Assembly.GetType("ACadSharp.IO.CadDocumentBuilder")!;
        var templates=(IDictionary)builderType.GetField("templatesMap",BindingFlags.Instance|BindingFlags.NonPublic)!.GetValue(builder)!;
        foreach(var entity in doc.BlockRecords.SelectMany(b=>b.Entities).Where(e=>e is UnknownEntity or ProxyEntity)) {
            var template=templates[entity.Handle]!;
            if(template.GetType().GetProperty("ProxyGraphics")!.GetValue(template) is byte[] raw)
                proxySources[entity.Handle]=raw;
        }
    }
    static string DimensionPictureStatus(Dimension dimension, ulong? sourceHandle, bool constraint)
    {
        if(dimension.Block is not null)return "stored";
        if(sourceHandle>0)return "unresolved-reference";
        if(sourceHandle==0)return constraint?"constraint-without-picture":"absent";
        return "unknown";
    }
    static void MapDimension(Dimension dimension,string space,string id,Row source)
    {
        var semantic=R(("sourceType",dimension.ObjectName),("nativeType",dimension.GetType().Name),
            ("measurement",dimension.Measurement),("measurementBasis","native-geometry-derived"),
            ("text",dimension.Text),("pictureBlockHandle",dimension.Block is null?null:H(dimension.Block)),
            ("definitionPoint",P(dimension.DefinitionPoint)),("textMiddlePoint",P(dimension.TextMiddlePoint)),
            ("insertionPoint",P(dimension.InsertionPoint)),("normal",P(dimension.Normal)),
            ("dimensionStyleHandle",H(dimension.Style)),("flags",(int)dimension.Flags),("sourceRefs",Refs(dimension)));
        foreach(var item in source)semantic[item.Key]=item.Value;
        Emit("dimensionSemantics",id,semantic);
        if(dimension.Block is not null) {
            // Consume the source's stored picture; never solve constraints here.
            Instance(dimension,dimension.Block,space,id,Identity);return;
        }
        string status=(string)source["pictureStatus"]!;
        string code=status switch {
            "constraint-without-picture"=>"native-dimension-constraint-display-unavailable",
            "unresolved-reference"=>"native-dimension-picture-unresolved",
            _=>"native-dimension-picture-missing"};
        string message=status=="constraint-without-picture"
            ?"Source constraint dependency has no stored dimension picture; parameters retained, interactive constraint display unsupported."
            :"Dimension picture unavailable ("+status+"); source reference and parameters retained without inventing linework.";
        EntityRow(dimension,space,id,R(("type","unsupported"),("sourceType",dimension.ObjectName),
            ("reason",message)),null);
        Loss(dimension,code,message);
    }
    static void Map(Entity e, string space, string? derivedId=null, CadObject? original=null)
    {
        original ??= e;
        string id=derivedId ?? (e is Insert or Dimension?"instance-":e is IText?"annotation-":"entity-")+H(e);
        if(!ids.Add(id)) throw new InvalidDataException("Duplicate mapped identity "+id);
        counts[e.ObjectName]=counts.GetValueOrDefault(e.ObjectName)+1;
        try {
            switch(e) {
            case Insert i:
                Instance(e,i.Block,space,id,Matrix(InsertTransform(i)));
                foreach(var attribute in i.Attributes) Map(attribute,space);
                return;
            case Dimension dimension:
                MapDimension(dimension,space,id,dimensionSources[dimension.Handle]);return;
            case IText text: Text(e,text,space,id,original); return;
            case Line line:
                EntityRow(e,space,id,R(("type","line"),("start",P(line.StartPoint)),("end",P(line.EndPoint))),[line.StartPoint,line.EndPoint],original:original); return;
            case Arc arc:
                double sweep=arc.EndAngle-arc.StartAngle;if(sweep<=0)sweep+=Math.PI*2;
                var arcPoints=arc.PolygonalVertexes(Math.Max(2,(int)Math.Ceiling(sweep/(Math.PI*2)*80)+1));
                EntityRow(e,space,id,ArcGeometry(arc,arc.StartAngle,sweep),arcPoints,original:original);
                Emit("nativeGeometry",id,R(("type","arc"),("center",P(arc.Center)),("normal",P(arc.Normal)),("radius",arc.Radius),("startAngle",arc.StartAngle),("endAngle",arc.EndAngle))); return;
            case Circle circle:
                var circlePoints=Closed(circle.PolygonalVertexes(80));
                EntityRow(e,space,id,ArcGeometry(circle,0,Math.PI*2),circlePoints,original:original);
                Emit("nativeGeometry",id,R(("type","circle"),("center",P(circle.Center)),("normal",P(circle.Normal)),("radius",circle.Radius))); return;
            case Ellipse ellipse:
                var ellipsePoints=ellipse.PolygonalVertexes(64);
                if(ellipse.IsFullEllipse) ellipsePoints=Closed(ellipsePoints);
                EntityRow(e,space,id,R(("type","ellipse"),("center",P(ellipse.Center)),("majorAxis",P(ellipse.MajorAxisEndPoint)),
                    ("minorAxis",P(ellipse.MinorAxisEndPoint)),("startAngle",ellipse.StartParameter),("sweepAngle",ellipse.EndParameter-ellipse.StartParameter)),ellipsePoints,original:original); return;
            case Spline spline:
                var splinePoints=SplineDisplayPoints(spline);
                var weights=spline.Weights.Count==0?Enumerable.Repeat(1.0,spline.ControlPoints.Count).ToArray():spline.Weights.ToArray();
                var splineFacts=R(("type","spline"),("degree",spline.Degree),("controlPoints",spline.ControlPoints.Select(P).ToArray()),
                    ("knots",spline.Knots.ToArray()),("weights",weights),("periodic",spline.IsPeriodic));
                if(spline.ControlPoints.Count==0) {
                    splineFacts["fitPointsOnly"]=true;
                    splineFacts["fitPoints"]=spline.FitPoints.Select(P).ToArray();
                }
                EntityRow(e,space,id,splineFacts,splinePoints,original:original); return;
            case XLine xline:
                Infinite(e,space,id,"xline",xline.FirstPoint,xline.Direction,original); return;
            case Ray ray:
                Infinite(e,space,id,"ray",ray.StartPoint,ray.Direction,original); return;
            case IPolyline polyline:
                var polyPoints=polyline.GetPoints<XYZ>(64).ToList();
                var polyWidths=PolylineWidths(e,polyline);
                int polySegments=polyline.IsClosed ? polyWidths.Length : polyWidths.Length-1;
                bool wide=(e is LwPolyline or Polyline2D) && polyWidths.Take(polySegments).Any(w=>w[0]!=0||w[1]!=0);
                double[]? polyLocal=null;
                Row polyGeometry;
                if(wide) {
                    // Keep width stations and bulges in OCS. The same entity transform
                    // applies to the source curve and its generated display bands.
                    polyLocal=Matrix(new Transform(Matrix4.GetArbitraryAxis(polyline.Normal)));
                    polyPoints=polyPoints.Select(p=>new XYZ(p.X,p.Y,polyline.Elevation)).ToList();
                    polyGeometry=R(("type","polyline"),("closed",polyline.IsClosed),
                        ("points",polyline.Vertices.Select(v=>new[]{v.Location[0],v.Location[1],polyline.Elevation}).ToArray()),
                        ("bulges",polyline.Vertices.Take(polySegments).Select(v=>v.Bulge).ToArray()),
                        ("widths",polyWidths.Take(polySegments).ToArray()));
                } else {
                    if(e is LwPolyline or Polyline2D) {
                        var ocs=Matrix4.GetArbitraryAxis(polyline.Normal);
                        polyPoints=polyPoints.Select(p=>ocs*new XYZ(p.X,p.Y,polyline.Elevation)).ToList();
                    }
                    if(polyline.IsClosed) polyPoints=Closed(polyPoints);
                    polyGeometry=Poly(polyPoints);
                }
                if(polyline.IsClosed) polyPoints=Closed(polyPoints);
                EntityRow(e,space,id,polyGeometry,polyPoints,local:polyLocal,original:original);
                Emit("nativeGeometry",id,R(("type","polyline"),("closed",polyline.IsClosed),("normal",P(polyline.Normal)),("elevation",polyline.Elevation),
                    ("lineTypeContinuous",e switch { LwPolyline lw => ((int)lw.Flags&128)!=0, Polyline2D p2 => ((int)p2.Flags&128)!=0, _ => true }),
                    ("vertices",polyline.Vertices.Select((v,i)=>R(("point",new[]{v.Location[0],v.Location[1]}),("bulge",v.Bulge),
                        ("startWidth",polyWidths[i][0]),("endWidth",polyWidths[i][1]))).ToArray()))); return;
            case ACadSharp.Entities.Point point:
                EntityRow(e,space,id,R(("type","point"),("position",P(point.Location))),[point.Location],topology:"points",original:original);return;
            case Face3D face:
                MapMesh(face,space,id,new[]{face.FirstCorner,face.SecondCorner,face.ThirdCorner,face.FourthCorner},new[]{new[]{0,1,2,3}},(int)face.Flags);return;
            case Mesh mesh:
                MapMesh(mesh,space,id,mesh.Vertices,mesh.Faces,subdivision:mesh.SubdivisionLevel);return;
            case Solid solid:
                var solidPoints=new[]{solid.FirstCorner,solid.SecondCorner,solid.FourthCorner,solid.ThirdCorner};
                EntityRow(e,space,id,Poly(solidPoints,true),Closed(solidPoints),original:original);
                Emit("fills",id,new {rings=new[]{solidPoints.Select(P).ToArray()},fillRule="even-odd"});return;
            case MLine mline:
                MapMLine(mline,space,id,original);return;
            case Hatch hatch:
                MapHatch(hatch,space,id);return;
            case Leader leader:
                EntityRow(e,space,id,Poly(leader.Vertices),leader.Vertices,original:original);
                LeaderArrow(e,space,id,leader,original);return;
            case Wipeout wipeout:
                WipeoutMask(e,space,id,wipeout,original);return;
            case UnknownEntity or ProxyEntity:
                MapCachedProxy(e,space,id);return;
            case MultiLeader multi when multi.HasProxyGeometries:
                MapProxy(multi,space,id);return;
            default:
                EntityRow(e,space,id,R(("type","unsupported"),("sourceType",e.ObjectName),("reason","Native object retained; no accepted 2D presentation mapping")),null,original:original);
                if(e is ModelerGeometry region && region.AcisData is not null) {
                    var data=region.AcisData; File.WriteAllBytes(Path.Combine(output,"opaque-"+H(e)+".bin"),data);
                    Emit("opaque",id,new {handle=H(e), byteLength=data.Length, sha256=Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant(),kind="ACIS"});
                }
                Loss(original,"unsupported-native-presentation","No accepted native presentation: "+e.GetType().Name);return;
            }
        } catch(Exception error) when(error is not OutOfMemoryException) {
            // Every per-entity mapping failure — not only the expected shape errors —
            // is a reported per-handle loss: one unanticipated exception in a mapper
            // must not discard the whole drawing. Out-of-memory stays fatal because
            // the process cannot be relied on to continue.
            Loss(original,"native-presentation-failed",error.ToString());
            if(!emitted.Contains(id))EntityRow(e,space,id,R(("type","unsupported"),("sourceType",original.ObjectName),("reason","Native presentation failed; see retained per-handle loss")),null,original:original);
            Emit("entityState",id,R(("presentationGeometry","missing"),("visible",!e.IsInvisible)));
        }
    }
    static bool InsideRing(XYZ point, List<XYZ> ring)
    {
        bool inside=false;
        for(int i=0,j=ring.Count-1;i<ring.Count;j=i++) {
            var a=ring[i];var b=ring[j];
            if((a.Y>point.Y)!=(b.Y>point.Y) && point.X<(b.X-a.X)*(point.Y-a.Y)/(b.Y-a.Y)+a.X) inside=!inside;
        }
        return inside;
    }
    static List<int> FillLoops(List<List<XYZ>> rings,HatchStyleType style)
    {
        if(style==HatchStyleType.Normal)return Enumerable.Range(0,rings.Count).ToList();
        var selected=new List<int>();
        for(int i=0;i<rings.Count;i++) {
            if(rings[i].Count<3)continue;
            int depth=0;
            for(int j=0;j<rings.Count;j++)if(i!=j && InsideRing(rings[i][0],rings[j]))depth++;
            if(depth==0 || (style==HatchStyleType.Outer && depth==1))selected.Add(i);
        }
        return selected;
    }
    static int[] GradientRgb(Color color) { var rgb=color.GetRgb();return [rgb[0],rgb[1],rgb[2]]; }
    static Row HatchGradient(Hatch hatch,List<List<XYZ>> rings,Transform basis)
    {
        var g=hatch.GradientColor;
        string name=g.Name.ToUpperInvariant();
        string[] names=["LINEAR","CYLINDER","INVCYLINDER","SPHERICAL","INVSPHERICAL","HEMISPHERICAL","INVHEMISPHERICAL","CURVED","INVCURVED"];
        if(!names.Contains(name) || !double.IsFinite(g.Angle) || !double.IsFinite(g.ColorTint) || (g.Shift!=0 && g.Shift!=1))
            throw new InvalidDataException("Unsupported gradient field parameters");
        var stops=g.Colors.OrderBy(x=>x.Value).ToArray();
        if(stops.Length!=2 || stops[0].Value!=0 || stops[1].Value!=1 || stops.Any(x=>x.Color.IsByLayer || x.Color.IsByBlock || (!x.Color.IsTrueColor && x.Color.Index==257)))
            throw new InvalidDataException("Gradient needs two explicit source colour stops at 0 and 1");
        var points=rings.SelectMany(x=>x).ToArray();
        double c=Math.Cos(g.Angle),s=Math.Sin(g.Angle);
        var rotated=points.Select(p=>new XYZ(p.X*c+p.Y*s,-p.X*s+p.Y*c,0)).ToArray();
        double[] Bounds(XYZ[] ps)=>[ps.Min(p=>p.X),ps.Min(p=>p.Y),ps.Max(p=>p.X),ps.Max(p=>p.Y)];
        var domain=Bounds(points);var frame=Bounds(rotated);
        if(Math.Min(Math.Min(domain[2]-domain[0],domain[3]-domain[1]),Math.Min(frame[2]-frame[0],frame[3]-frame[1]))<=1e-12)
            throw new InvalidDataException("Degenerate gradient domain");
        return R(("profile","truedxf-gradient-field/1"),("name",name),("colors",stops.Select(x=>GradientRgb(x.Color)).ToArray()),
            ("angleRadians",g.Angle),("shift",g.Shift),("oneColor",g.IsSingleColorGradient?1:0),("tint",g.ColorTint),
            ("domain",domain),("frameBounds",frame),("localToOwner",Matrix(basis)),
            ("method","truedxf 019c2e5 calibrated field + Canvas clipped texture"),
            ("fidelity","display fit; CAD Gouraud tessellation/dither is not reproduced"));
    }
    static XYZ MeshCross(XYZ a,XYZ b)=>new XYZ(a.Y*b.Z-a.Z*b.Y,a.Z*b.X-a.X*b.Z,a.X*b.Y-a.Y*b.X);
    static double MeshDot(XYZ a,XYZ b)=>a.X*b.X+a.Y*b.Y+a.Z*b.Z;
    // Admit only the planar triangle/quad profile validated against native DWGs.
    // No new points, smoothing, subdivision or nonplanar diagonal is invented.
    static List<int[]> MeshTriangles(IReadOnlyList<XYZ> vertices,IReadOnlyList<int> source)
    {
        if(source.Count<3 || source.Count>4 || source.Any(i=>i<0||i>=vertices.Count))
            throw new InvalidDataException("mesh-face-indices-or-size-unsupported");
        var face=new List<int>();
        foreach(int i in source)if(face.Count==0||vertices[i]!=vertices[face[^1]])face.Add(i);
        if(face.Count>1&&vertices[face[0]]==vertices[face[^1]])face.RemoveAt(face.Count-1);
        if(face.Count<3)throw new InvalidDataException("mesh-face-degenerate");
        var origin=vertices[face[0]];var normal=XYZ.Zero;
        for(int i=1;i+1<face.Count;i++)normal+=MeshCross(vertices[face[i]]-origin,vertices[face[i+1]]-origin);
        double length=normal.GetLength();
        if(!double.IsFinite(length)||length<=1e-12)throw new InvalidDataException("mesh-face-degenerate");
        normal/=length;
        if(face.Any(i=>Math.Abs(MeshDot(vertices[i]-origin,normal))>1e-7))
            throw new InvalidDataException("mesh-face-nonplanar");
        bool Positive(int a,int b,int c)=>MeshDot(MeshCross(vertices[face[b]]-vertices[face[a]],vertices[face[c]]-vertices[face[a]]),normal)>1e-12;
        if(face.Count==3)return new List<int[]>{face.ToArray()};
        if(Positive(0,1,2)&&Positive(0,2,3))return new List<int[]>{new[]{face[0],face[1],face[2]},new[]{face[0],face[2],face[3]}};
        if(Positive(0,1,3)&&Positive(1,2,3))return new List<int[]>{new[]{face[0],face[1],face[3]},new[]{face[1],face[2],face[3]}};
        throw new InvalidDataException("mesh-face-invalid-boundary");
    }
    static void MapMesh(Entity entity,string space,string id,IReadOnlyList<XYZ> vertices,IEnumerable<int[]> sourceFaces,int hiddenEdges=0,int subdivision=0)
    {
        var triangles=new List<XYZ>();var edges=new List<XYZ>();var seen=new HashSet<(int,int)>();int faceCount=0;
        try {
            if(subdivision!=0)throw new InvalidDataException("mesh-subdivision-unsupported");
            foreach(var face in sourceFaces) {
                foreach(var triangle in MeshTriangles(vertices,face))foreach(int i in triangle)triangles.Add(vertices[i]);
                for(int j=0;j<face.Length;j++) {
                    int a=face[j],b=face[(j+1)%face.Length];
                    if((hiddenEdges&(1<<j))!=0||vertices[a]==vertices[b]||!seen.Add((Math.Min(a,b),Math.Max(a,b))))continue;
                    edges.Add(vertices[a]);edges.Add(vertices[b]);
                }
                faceCount++;
                if(triangles.Count>600000||edges.Count>400000)throw new InvalidDataException("mesh-presentation-budget");
            }
            if(triangles.Count==0)throw new InvalidDataException("mesh-empty");
        } catch(InvalidDataException error) {
            EntityRow(entity,space,id,R(("type","unsupported"),("sourceType",entity.ObjectName),("reason",error.Message)),null);
            Loss(entity,"native-mesh-unmapped",error.Message);return;
        }
        EntityRow(entity,space,id,R(("type","unsupported"),("sourceType",entity.ObjectName),("reason","Native mesh retained as source-owned presentation parts")),null);
        string fill=id+"-mesh-fill",stroke=id+"-mesh-edges";
        Display(fill,entity,triangles,"triangles");
        if(edges.Count>0)DisplayPairs(stroke,entity,edges);
        Emit("meshPresentations",id,new{sourceKind=entity.ObjectName,fill,stroke=edges.Count>0?stroke:null,faceCount,triangleCount=triangles.Count/3,hiddenEdges,subdivision,sourceRefs=Refs(entity)});
    }
    static void MapHatch(Hatch hatch,string space,string id)
    {
        Emit("hatchSemantics",id,new{pattern=hatch.Pattern.Name,hatch.IsSolid,hatch.PatternAngle,hatch.PatternScale,hatch.Style,
            patternLines=hatch.Pattern.Lines.Select(l=>new{l.Angle,basePoint=new[]{l.BasePoint.X,l.BasePoint.Y},offset=new[]{l.Offset.X,l.Offset.Y},dashes=l.DashLengths}).ToArray(),
            gradient=hatch.GradientColor.Enabled,loops=hatch.Paths.Select(p=>new{flags=(int)p.Flags,edges=p.Edges.Count}).ToArray(),sourceRefs=Refs(hatch)});
        var localRings=hatch.Paths.Select(loop=>Closed(loop.GetPoints(64))).ToList();
        var selected=FillLoops(localRings,hatch.Style);
        var basis=new Transform(Matrix4.GetArbitraryAxis(hatch.Normal)*Transform.CreateTranslation(new XYZ(0,0,hatch.Elevation)).Matrix);
        var boundaryIds=new List<string>(); var rings=new List<double[][]>(); int n=0;
        foreach(int index in selected) {
            var pts=localRings[index].Select(p=>basis.ApplyTransform(p)).ToList(); string child=id+"-boundary-"+n++;
            EntityRow(hatch,space,child,Poly(pts),pts); boundaryIds.Add(child); rings.Add(pts.Select(P).ToArray());
            Emit("entityState",child,R(("visible",false)));
        }
        EntityRow(hatch,space,id,R(("type","hatch"),("boundaryEntityIds",boundaryIds),("fillRule","even-odd")),null);
        if(hatch.GradientColor.Enabled) {
            try { Emit("fills",id,R(("rings",rings),("fillRule","even-odd"),("gradient",HatchGradient(hatch,localRings,basis)))); }
            catch(InvalidDataException error) { Loss(hatch,"hatch-gradient-unmapped",error.Message); }
        }
        else if(hatch.IsSolid) Emit("fills",id,new {rings,fillRule="even-odd"});
        else {
            var patternHatch=new Hatch { Pattern=hatch.Pattern };
            foreach(int index in selected)patternHatch.Paths.Add(hatch.Paths[index]);
            var lines=patternHatch.ExplodePattern().ToArray();
            if(lines.Length>200000) throw new InvalidDataException("Hatch community expansion exceeds per-object budget");
            var points=lines.SelectMany(l=>new[]{basis.ApplyTransform(l.StartPoint),basis.ApplyTransform(l.EndPoint)}).ToArray();
            // A disjoint segment list, not an invented connected polyline.
            long offset=positions.BaseStream.Position;
            foreach(var p in points){positions.Write(p.X);positions.Write(p.Y);positions.Write(p.Z);}
            if(points.Length>0) Emit("displays",id,new{offset,byteLength=points.Length*24,count=points.Length,topology="lines",min=new[]{points.Min(p=>p.X),points.Min(p=>p.Y),points.Min(p=>p.Z)},max=new[]{points.Max(p=>p.X),points.Max(p=>p.Y),points.Max(p=>p.Z)},sourceRefs=Refs(hatch)});
            else {
                var result=HatchEmptyPattern.Classify(hatch);
                Emit("hatchPatternOutcomes",id,new{result.status,result.reason,result.method,result.ranges,sourceRefs=Refs(hatch)});
                if(result.status!=HatchEmptyPattern.Empty)
                    Loss(hatch,"empty-native-hatch-pattern","No linework; needs source verification: "+result.reason);
            }
        }
    }
    static Arc CachedProxyArc(ProxyCircularArc arc)
    {
        if(arc.ArcType!=0 || arc.SweepAngle<=0 || arc.SweepAngle>Math.PI*2)
            throw new InvalidDataException("Proxy circular arc type or sweep is unsupported");
        var toOcs=Matrix4.GetArbitraryAxis(arc.Normal).Transpose();
        var start=toOcs*arc.StartVectorDirection;
        double angle=Math.Atan2(start.Y,start.X);
        return new Arc{Center=toOcs*arc.Center,Normal=arc.Normal,Radius=arc.Radius,
            StartAngle=angle,EndAngle=angle+arc.SweepAngle};
    }
    static List<(int Index,Entity Entity)> CachedProxyEntities(Entity source)
    {
        var result=new List<(int,Entity)>();
        var layers=source.Document.Layers.ToArray();
        // Proxy indices exclude the two special linetype entries.
        var lineTypes=source.Document.LineTypes.Where(l=>!l.Name.Equals("ByLayer",StringComparison.OrdinalIgnoreCase)
            &&!l.Name.Equals("ByBlock",StringComparison.OrdinalIgnoreCase)).ToArray();
        var layer=source.Layer;var lineType=source.LineType;var color=source.Color;
        var weight=source.LineWeight;double scale=source.LineTypeScale;bool fill=false;int index=0;
        foreach(var proxy in source.ProxyGeometries) {
            int ordinal=index++;
            switch(proxy) {
            case ProxyExtents or ProxySubentMarker:continue;
            case ProxySubentLayer p:
                if(p.LayerIndex<0||p.LayerIndex>=layers.Length)throw new InvalidDataException("Proxy layer index unavailable");
                layer=layers[p.LayerIndex];continue;
            case ProxySubentColor p when p.ColorIndex>=0 && p.ColorIndex<=256:
                color=new Color((short)p.ColorIndex);continue;
            case ProxySubentTrueColor p when p.ColorMethod is ProxyColorMethod.ByLayer or ProxyColorMethod.ByBlock or ProxyColorMethod.ByColor or ProxyColorMethod.ByACI or ProxyColorMethod.Foreground:
                color=p.Color;continue;
            case ProxySubentLineWeight p:weight=p.LineWeight;continue;
            case ProxySubentLineTypeScale p:scale=p.LineTypeScale;continue;
            case ProxySubentLineType p:
                if(p.IsByLayer||p.LineTypeIndex==32767)lineType=source.Document.LineTypes["ByLayer"];
                else if(p.IsByBlock||p.LineTypeIndex==32766)lineType=source.Document.LineTypes["ByBlock"];
                else if(p.LineTypeIndex<lineTypes.Length)lineType=lineTypes[p.LineTypeIndex];
                else throw new InvalidDataException("Proxy linetype index unavailable");
                continue;
            case ProxySubentFillon p:fill=p.IsOn;continue;
            case ProxySubentThickness p when p.Thickness==0:continue;
            case ProxySubentPlotStyleName p when p.PlotStyleIndex==0 && p.Type.ToString() is "ByLayer" or "ByBlock":continue;
            }
            Entity presentation=proxy switch {
                ProxyCircularArc p=>CachedProxyArc(p),
                ProxyCircle p=>new Circle{Center=Matrix4.GetArbitraryAxis(p.Normal).Transpose()*p.Center,Normal=p.Normal,Radius=p.Radius},
                ProxyPolyline p=>new Polyline3D(p.Points),
                ProxyPolygon p when !fill=>new Polyline3D(Closed(p.Points)),
                ProxyPolygon p when p.Points.Count==3=>new Solid{FirstCorner=p.Points[0],SecondCorner=p.Points[1],ThirdCorner=p.Points[2],FourthCorner=p.Points[2]},
                _=>throw new InvalidDataException("Unsupported proxy command: "+proxy.GraphicsType)
            };
            presentation.Layer=layer;presentation.LineType=lineType;presentation.Color=color;
            presentation.LineWeight=weight;presentation.LineTypeScale=scale;
            presentation.IsInvisible=source.IsInvisible;presentation.Transparency=source.Transparency;
            result.Add((ordinal,presentation));fill=false;
        }
        return result;
    }
    static void MapCachedProxy(Entity entity,string space,string id)
    {
        proxySources.TryGetValue(entity.Handle,out var raw);
        int nativeCount=raw is {Length:>=8}?System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(raw.AsSpan(4,4)):0;
        var metadata=R(("sourceType",entity.ObjectName),("sourceRefs",Refs(entity)),("byteLength",raw?.Length??0),
            ("nativeCommandCount",nativeCount),("decodedCommandCount",entity.ProxyGeometries.Count),
            ("policy","Saved proxy display only; not recovered native object semantics or current external content."));
        if(raw is {Length:>0}) {
            string artifact="proxy-"+H(entity)+".bin";File.WriteAllBytes(Path.Combine(output,artifact),raw);
            metadata["artifact"]="native/"+artifact;metadata["sha256"]=Convert.ToHexString(SHA256.HashData(raw)).ToLowerInvariant();
        }
        string? failure=null;List<(int Index,Entity Entity)>? graphics=null;
        if(raw is null || raw.Length<8 || nativeCount==0)failure="proxy-graphics-absent";
        else if(nativeCount!=entity.ProxyGeometries.Count)failure="proxy-graphics-decode-incomplete";
        else {
            try { graphics=CachedProxyEntities(entity); }
            catch(InvalidDataException error) { failure="proxy-command-unsupported";metadata["detail"]=error.Message; }
        }
        if(failure is not null || graphics!.Count==0) {
            failure??="proxy-graphics-empty";metadata["status"]=failure;
            EntityRow(entity,space,id,R(("type","unsupported"),("sourceType",entity.ObjectName),("reason",failure)),null);
            Loss(entity,failure,"Saved proxy display is unavailable; see retained native proxy data and command diagnostics.");
        } else {
            metadata["status"]="cached-display";metadata["presentationCount"]=graphics.Count;
            foreach(var (ordinal,presentation) in graphics)Map(presentation,space,id+"-proxy-"+ordinal,entity);
        }
        Emit("proxyGraphics",id,metadata);
    }
    static void MapProxy(MultiLeader entity,string space,string id)
    {
        int i=0; var failed=new List<string>();
        var document=entity.Document;
        var currentLayer=entity.Layer;
        var currentLineType=entity.LineType;
        foreach(var proxy in entity.ProxyGeometries) {
            string child=id+"-proxy-"+i++;
            if(proxy is ProxySubentLayer subLayer) {
                if(document is not null && subLayer.LayerIndex>=0 && subLayer.LayerIndex<document.Layers.Count())
                    currentLayer=document.Layers.ElementAt(subLayer.LayerIndex);
                else failed.Add("SubentLayer");
                continue;
            }
            if(proxy is ProxySubentLineType subLineType) {
                // 0x7FFF is the 16-bit proxy default seen in this drawing; it does
                // not identify a real line type and leaves the entity style intact.
                if(!subLineType.IsByLayer && !subLineType.IsByBlock && subLineType.LineTypeIndex!=0x7FFF) {
                    if(document is not null && (long)subLineType.LineTypeIndex<document.LineTypes.Count())
                        currentLineType=document.LineTypes.ElementAt((int)subLineType.LineTypeIndex);
                    else failed.Add("SubentLineType");
                }
                continue;
            }
            if(proxy is ProxySubentThickness subThickness) {
                // The UCD 2D display has no thickness channel; zero is the
                // observed default and is a no-op, any other value stays a loss.
                if(subThickness.Thickness!=0) failed.Add("SubentThickness");
                continue;
            }
            if(proxy is ProxySubentPlotStyleName subPlotStyle) {
                if(subPlotStyle.PlotStyleIndex!=0 && subPlotStyle.Type.ToString() is not ("ByLayer" or "ByBlock"))
                    failed.Add("SubentPlotStyleName");
                continue;
            }
            Entity? presentation=proxy switch {
                ProxyPolyline p=>new Polyline3D(p.Points),
                ProxyPolygon p when p.Points.Count==3=>new Solid{FirstCorner=p.Points[0],SecondCorner=p.Points[1],ThirdCorner=p.Points[2],FourthCorner=p.Points[2]},
                ProxyPolygon p=>new Polyline3D(Closed(p.Points)),
                ProxyCircle p=>new Circle{Center=p.Center,Radius=p.Radius,Normal=p.Normal},
                ProxyText p=>new TextEntity{InsertPoint=p.StartPoint,Height=p.Height,Value=p.Text,Rotation=Math.Atan2(p.TextDirection.Y,p.TextDirection.X),Normal=p.Normal,WidthFactor=p.WidthFactor},
                ProxyUnicodeText p=>new TextEntity{InsertPoint=p.StartPoint,Height=p.Height,Value=p.Text,Rotation=Math.Atan2(p.TextDirection.Y,p.TextDirection.X),Normal=p.Normal,WidthFactor=p.WidthFactor},
                ProxyUnicodeText2 p=>new TextEntity{InsertPoint=p.StartPoint,Height=p.Height,Value=p.Text,Rotation=Math.Atan2(p.TextDirection.Y,p.TextDirection.X),Normal=p.Normal,WidthFactor=p.WidthFactor,
                  Style=new TextStyle("proxy-font"){Filename=string.IsNullOrEmpty(p.FontDescriptor.FontFilename)?p.FontDescriptor.Typeface??"":p.FontDescriptor.FontFilename,BigFontFilename=p.BigFontFilename??""}},
                _=>null
            };
            if(presentation is not null) {
                presentation.Layer=currentLayer;presentation.Color=entity.Color;presentation.LineType=currentLineType;
                Map(presentation,space,child,entity);
            } else if(proxy is not (ProxyExtents or ProxySubentColor or ProxySubentTrueColor or ProxySubentLineWeight or ProxySubentFillon or ProxySubentMarker or ProxySubentLineTypeScale)) failed.Add(proxy.GraphicsType.ToString());
        }
        Emit("multiLeaderSemantics",id,new{sourceRefs=Refs(entity),nativeProxyPrimitiveCount=i,unmappedProxyTypes=failed});
        if(failed.Count>0) Loss(entity,"proxy-primitive-unmapped",string.Join(",",failed.Distinct()));
    }
    static void Visit(BlockRecord block)
    {
        if(!reachable.Add(block.Handle))return;
        foreach(var entity in block.Entities) {
            if(entity is Insert insert)Visit(insert.Block);
            if(entity is Dimension dimension && dimension.Block is not null)Visit(dimension.Block);
        }
    }
    static IEnumerable<Entity> SortedEntities(BlockRecord block)
    {
        // ACadSharp BlockRecord.GetSortedEntities + SortEntitiesTable.GetSorterHandle
        // perform one linear sorter search per entity. Reuse the same native
        // sorter handles and LINQ ordering with one index for large source blocks.
        var table=block.SortEntitiesTable;
        if(table is null)return block.Entities.OrderBy(e=>e.Handle);
        var byEntity=table.GroupBy(s=>s.Entity.Handle).ToDictionary(g=>g.Key,g=>g.First().SortHandle);
        return block.Entities.OrderBy(e=>byEntity.GetValueOrDefault(e.Handle,e.Handle));
    }
    static bool NearOrigin(XYZ p) => Math.Abs(p.X)<1e-9 && Math.Abs(p.Y)<1e-9 && Math.Abs(p.Z)<1e-9;
    static List<XYZ> CleanSplineDisplayPoints(List<XYZ> points, IReadOnlyList<XYZ> controlPoints)
    {
        // ACadSharp 3.8.30 can evaluate a periodic spline at uStart to XYZ.Zero
        // when the control polygon is away from the origin (zero basis sum).
        // Dropping that single leading vertex prevents a spurious origin-to-spline
        // segment; a spline that legitimately starts at the origin keeps its point.
        if(points.Count>1 && NearOrigin(points[0]) && controlPoints.Count>0 && !NearOrigin(controlPoints[0]))
            points.RemoveAt(0);
        return points;
    }
    static List<XYZ> SplineDisplayPoints(Spline spline)
    {
        if(spline.TryPolygonalVertexes(48,out var points))
            return CleanSplineDisplayPoints(points,spline.ControlPoints);
        // R13/R14-era splines can store only fit points; ACadSharp evaluates the
        // NURBS from the control polygon, so the stored fit points are the only
        // source geometry left. Joining them is an explicit approximation
        // (fitPointsOnly), never an invented curve; a spline with neither
        // control nor fit points stays a reported loss.
        if(spline.FitPoints.Count>=2){
            var fit=spline.FitPoints.ToList();
            return spline.IsClosed?Closed(fit):fit;
        }
        throw new InvalidDataException("ACadSharp.TryPolygonalVertexes failed; no invented fit");
    }
    static void Display2DSelfTest(string folder)
    {
        // Near-pole normals must use the same OCS orientation as exact axes.
        // The pinned helper previously evaluated the 1/64 threshold as integer zero.
        foreach(var (normal,expectedX) in new[]{
            (XYZ.AxisZ,XYZ.AxisX),(-XYZ.AxisZ,-XYZ.AxisX),
            (new XYZ(1e-28,-2e-28,1),XYZ.AxisX),
            (new XYZ(1e-28,-2e-28,-1),-XYZ.AxisX),
            (new XYZ(0,0.01,1),XYZ.AxisX),
            (new XYZ(1,0,1),XYZ.AxisY)}) {
            var basis=Matrix4.GetArbitraryAxis(normal);
            if((basis*XYZ.AxisX-expectedX).GetLength()>1e-12 ||
               (basis*XYZ.AxisZ-normal.Normalize()).GetLength()>1e-12)
                throw new InvalidDataException("OCS arbitrary-axis orientation changed");
        }
        var document=new CadDocument(ACadVersion.AC1027);
        var block=new BlockRecord("NonzeroBase");
        block.BlockEntity.BasePoint=new XYZ(1,2,0);
        block.Entities.Add(new Line(new XYZ(1,2,0),new XYZ(3,5,0)));
        document.BlockRecords.Add(block);
        var insert=new Insert(block){InsertPoint=new XYZ(10,20,0),XScale=2,YScale=3,Rotation=Math.PI/2};
        var expected=new XYZ(1,24,0);
        if((InsertTransform(insert).ApplyTransform(new XYZ(3,5,0))-expected).GetLength()>1e-9)
            throw new InvalidDataException("Nonzero-base rotated scaled block moved");
        if((insert.GetTransform().ApplyTransform(new XYZ(3,5,0))-expected).GetLength()<1)
            throw new InvalidDataException("Pinned upstream block defect no longer reproduced; review workaround");
        document.Entities.Add(insert);
        insert=new Insert(block){InsertPoint=new XYZ(30,20,0),XScale=-2,YScale=3,Rotation=Math.PI/2};
        if((InsertTransform(insert).ApplyTransform(new XYZ(3,5,0))-new XYZ(21,16,0)).GetLength()>1e-9)
            throw new InvalidDataException("Mirrored block moved");
        document.Entities.Add(insert);
        var nested=new BlockRecord("NestedBase");nested.BlockEntity.BasePoint=new XYZ(2,1,0);
        nested.Entities.Add(new Insert(block){InsertPoint=new XYZ(10,20,0),XScale=2,YScale=3,Rotation=Math.PI/2});document.BlockRecords.Add(nested);
        var parent=new Insert(nested){InsertPoint=new XYZ(50,20,0),XScale=-1,YScale=2,Rotation=Math.PI/2};
        var child=(Insert)nested.Entities.First();
        if((InsertTransform(parent).ApplyTransform(InsertTransform(child).ApplyTransform(new XYZ(3,5,0)))-new XYZ(4,21,0)).GetLength()>1e-9)
            throw new InvalidDataException("Nested mirrored block moved");
        document.Entities.Add(parent);
        var normalInsert=new Insert(block){InsertPoint=new XYZ(10,20,3),Normal=new XYZ(0,0,-1),XScale=2,YScale=3,Rotation=Math.PI/2};
        if((InsertTransform(normalInsert).ApplyTransform(new XYZ(3,5,0))-new XYZ(-1,24,-3)).GetLength()>1e-9)
            throw new InvalidDataException("Reversed extrusion block moved");
        foreach(var sign in new[]{1.0,-1.0}) {
            normalInsert.Normal=new XYZ(0,0,sign);
            var exact=InsertTransform(normalInsert).ApplyTransform(new XYZ(3,5,0));
            normalInsert.Normal=new XYZ(1e-28,-2e-28,sign);
            if((InsertTransform(normalInsert).ApplyTransform(new XYZ(3,5,0))-exact).GetLength()>1e-9)
                throw new InvalidDataException("Near-pole rotated scaled block moved");
        }
        List<XYZ> Square(double x,double y,double width)=>[new XYZ(x,y,0),new XYZ(x+width,y,0),new XYZ(x+width,y+width,0),new XYZ(x,y+width,0),new XYZ(x,y,0)];
        var rings=new List<List<XYZ>>{Square(0,0,10),Square(2,2,6),Square(4,4,2),Square(20,0,5)};
        if(!FillLoops(rings,HatchStyleType.Normal).SequenceEqual(new[]{0,1,2,3}) ||
           !FillLoops(rings,HatchStyleType.Outer).SequenceEqual(new[]{0,1,3}) ||
           !FillLoops(rings,HatchStyleType.Ignore).SequenceEqual(new[]{0,3}))throw new InvalidDataException("Island style selection changed");
        foreach(var style in new[]{HatchStyleType.Normal,HatchStyleType.Outer,HatchStyleType.Ignore}) {
            var hatch=new Hatch{IsSolid=true,Pattern=HatchPattern.Solid,Style=style};
            foreach(var ring in rings){var path=new Hatch.BoundaryPath();path.Edges.Add(new Hatch.BoundaryPath.Polyline(ring.Select(p=>p+new XYZ((int)style*30,0,0))));hatch.Paths.Add(path);}
            document.Entities.Add(hatch);
        }
        string[] names=["LINEAR","CYLINDER","INVCYLINDER","SPHERICAL","INVSPHERICAL","HEMISPHERICAL","INVHEMISPHERICAL","CURVED","INVCURVED"];
        for(int i=0;i<names.Length;i++) {
            var hatch=new Hatch{IsSolid=true,Pattern=HatchPattern.Solid};
            hatch.GradientColor.Enabled=true;hatch.GradientColor.Name=names[i];hatch.GradientColor.Angle=Math.PI/6;hatch.GradientColor.Shift=i%2;
            hatch.GradientColor.Colors.Add(new GradientColor{Value=0,Color=new Color(255,0,0)});
            hatch.GradientColor.Colors.Add(new GradientColor{Value=1,Color=new Color(0,0,255)});
            var ring=Square((i%3)*15,40+(i/3)*15,10);var path=new Hatch.BoundaryPath();
            path.Edges.Add(new Hatch.BoundaryPath.Polyline(ring));hatch.Paths.Add(path);
            var spec=HatchGradient(hatch,new List<List<XYZ>>{ring},new Transform(Matrix4.Identity));
            if((string)spec["name"]! !=names[i])throw new InvalidDataException("Gradient name changed");
            document.Entities.Add(hatch);
        }
        DwgWriter.Write(Path.Combine(folder,"display-2d.dwg"),document);
        Console.WriteLine("PASS: reproduced upstream block offset; corrected rotation/scale/mirror; three island styles and disjoint contours; nine stored-colour gradient fields.");
    }
    static void MeshSelfTest(string folder)
    {
        var triangle=new[]{XYZ.Zero,XYZ.AxisX,XYZ.AxisY,XYZ.Zero};
        if(MeshTriangles(triangle,new[]{0,1,2,3}).Count!=1)throw new InvalidDataException("Closed triangle changed");
        triangle[3]=triangle[2];
        if(MeshTriangles(triangle,new[]{0,1,2,3}).Count!=1)throw new InvalidDataException("Repeated last corner changed");
        var concave=new[]{XYZ.Zero,new XYZ(2,0,0),new XYZ(.5,.5,0),new XYZ(0,2,0)};
        if(MeshTriangles(concave,new[]{0,1,2,3}).Count!=2)throw new InvalidDataException("Concave quad changed");
        bool rejected=false;concave[2]=new XYZ(.5,.5,1);
        try{MeshTriangles(concave,new[]{0,1,2,3});}catch(InvalidDataException){rejected=true;}
        if(!rejected)throw new InvalidDataException("Nonplanar quad accepted");
        var document=new CadDocument(ACadVersion.AC1027);
        var block=new BlockRecord("MeshBase");block.BlockEntity.BasePoint=new XYZ(1,2,3);
        block.Entities.Add(new Face3D{FirstCorner=new XYZ(1,2,3),SecondCorner=new XYZ(5,2,3),ThirdCorner=new XYZ(5,6,3),FourthCorner=new XYZ(1,6,3),Color=new Color(0)});
        document.BlockRecords.Add(block);
        document.Entities.Add(new Insert(block){InsertPoint=new XYZ(10,20,5),XScale=-2,YScale=3,Rotation=Math.PI/2,Color=new Color(255,0,0)});
        var nested=new BlockRecord("NestedMesh");nested.BlockEntity.BasePoint=new XYZ(2,1,0);
        nested.Entities.Add(new Insert(block){InsertPoint=new XYZ(10,20,5),Color=new Color(0)});document.BlockRecords.Add(nested);
        document.Entities.Add(new Insert(nested){InsertPoint=new XYZ(50,20,0),XScale=-1,YScale=2,Rotation=Math.PI/2,Color=new Color(0,0,255)});
        DwgWriter.Write(Path.Combine(folder,"mesh-blocks.dwg"),document);
        Console.WriteLine("PASS: mesh closed triangles, concave quads, nonplanar rejection; mirrored nested block fixture written.");
    }
    static void AttributeVisibilitySelfTest(string folder)
    {
        foreach(var mode in new[]{ACadSharp.Header.AttributeVisibilityMode.None,
            ACadSharp.Header.AttributeVisibilityMode.Normal,ACadSharp.Header.AttributeVisibilityMode.All}) {
            var document=new CadDocument(ACadVersion.AC1027);
            document.Header.AttributeVisibility=mode;
            var block=new BlockRecord("attribute-visibility");
            block.Entities.Add(new Line(XYZ.Zero,XYZ.AxisX));document.BlockRecords.Add(block);
            var insert=new Insert(block);document.Entities.Add(insert);
            insert.Attributes.Add(new AttributeEntity{Tag="hidden",Value="hidden",Flags=AttributeFlags.Hidden});
            insert.Attributes.Add(new AttributeEntity{Tag="shown",Value="shown"});
            insert.Attributes.Add(new AttributeEntity{Tag="entity-hidden",Value="entity-hidden",IsInvisible=true});
            document.Entities.Add(new TextEntity{Value="ordinary",Height=1});
            string source=Path.Combine(folder,"attributes-"+mode+".dwg"),target=Path.Combine(folder,"attributes-"+mode);
            DwgWriter.Write(source,document);var reread=DwgReader.Read(source);
            Directory.CreateDirectory(target);
            var names=new Dictionary<string,string>();var states=new Dictionary<string,bool>();
            using(records=new StreamWriter(Path.Combine(target,"ucd-records.jsonl"))) {
                foreach(var text in reread.Entities.OfType<TextEntity>().Concat(
                    reread.Entities.OfType<Insert>().SelectMany(i=>i.Attributes))) {
                    string id="annotation-"+H(text);names[id]=text.Value;State(text,id);
                }
            }
            foreach(string line in File.ReadLines(Path.Combine(target,"ucd-records.jsonl"))) {
                using var row=JsonDocument.Parse(line);var root=row.RootElement;
                var table=root.GetProperty("table").GetString();var value=root.GetProperty("value");
                string id=root.GetProperty("id").GetString()!;
                if(table=="annotations")names[id]=value.GetProperty("text").GetString()!;
                if(table=="entityState"&&value.TryGetProperty("visible",out var visible))states[id]=visible.GetBoolean();
            }
            if(names.Count!=4)throw new InvalidDataException("Attribute visibility fixture lost source text");
            foreach(var (id,name) in names) {
                bool expected=name=="ordinary" || (name!="entity-hidden" && mode!=ACadSharp.Header.AttributeVisibilityMode.None
                    && (name=="shown"||mode==ACadSharp.Header.AttributeVisibilityMode.All));
                if(states[id]!=expected)throw new InvalidDataException("Incorrect attribute visibility: "+mode+"/"+name);
            }
        }
        Console.WriteLine("PASS: attribute Normal/All/None, dedicated Hidden flag, entity invisibility and ordinary text (12 cases).");
    }
    static void EmptyHatchSelfTest(string folder)
    {
        int count=0;
        void Check(Hatch h,bool empty,string name) {
            var actual=HatchEmptyPattern.Classify(h);
            if((actual.status==HatchEmptyPattern.Empty)!=empty)throw new InvalidDataException("Hatch empty proof: "+name+"/"+actual.reason);
            count++;
        }
        Hatch Polygon(double angle=0,double x=0,double y=0) {
            var h=new Hatch{Pattern=new HatchPattern("proof-lines")};
            XY Move(double a,double b)=>new XY(x+a*Math.Cos(angle)-b*Math.Sin(angle),y+a*Math.Sin(angle)+b*Math.Cos(angle));
            h.Pattern.Lines.Add(new HatchPattern.Line{Angle=angle,BasePoint=new XY(x,y),Offset=new XY(-Math.Sin(angle),Math.Cos(angle))});
            var path=new Hatch.BoundaryPath();
            path.Edges.Add(new Hatch.BoundaryPath.Polyline(new[]{Move(0,0.2),Move(1,0.2),Move(1,0.8),Move(0,0.8)}.Select(p=>new XYZ(p.X,p.Y,0))));h.Paths.Add(path);return h;
        }
        foreach(double angle in new[]{0.0,0.7,Math.PI/2,Math.PI}) {
            var h=Polygon(angle,2000000,-900000);Check(h,true,"rotated translated no crossing");
            h.Pattern.Lines[0].Offset*=-1;Check(h,true,"negative spacing");
            h.Pattern.Lines[0].BasePoint-=h.Pattern.Lines[0].Offset*0.5;Check(h,false,"crossing must stay unknown");
        }
        var shape=Polygon();shape.Pattern.Lines.Add(new HatchPattern.Line{BasePoint=new XY(0,0.5),Offset=new XY(0,1)});Check(shape,false,"all line families required");
        shape=Polygon();shape.IsDouble=true;Check(shape,false,"double hatch");
        shape=Polygon();shape.Pattern.Lines[0].DashLengths.Add(-1);Check(shape,false,"dash-only gap not proved");
        shape=Polygon();shape.Pattern.Lines.Clear();Check(shape,false,"missing definition");
        shape=Polygon();shape.Pattern.Lines[0].Offset=XY.Zero;Check(shape,false,"zero spacing");
        shape=Polygon();((Hatch.BoundaryPath.Polyline)shape.Paths[0].Edges[0]).IsClosed=false;Check(shape,false,"open boundary");
        shape=Polygon();shape.Paths[0].Edges.Clear();shape.Paths[0].Edges.Add(new Hatch.BoundaryPath.Spline());Check(shape,false,"unsupported spline");
        shape=Polygon();((Hatch.BoundaryPath.Polyline)shape.Paths[0].Edges[0]).Vertices[0]=new XYZ(double.NaN,0,0);Check(shape,false,"nonfinite source");
        shape=Polygon();shape.Paths.Clear();Check(shape,false,"missing boundary");
        shape=Polygon();shape.Pattern.Lines[0].BasePoint=new XY(0,0.2-5e-8);Check(shape,false,"near tangency");
        shape=Polygon();shape.Pattern.Lines[0].BasePoint=new XY(0,0.5);shape.Paths.Add(shape.Paths[0].Clone());
        if(shape.ExplodePattern().Any())throw new InvalidDataException("Expected parity-empty control");Check(shape,false,"parity emptiness outside proof scope");
        shape=Polygon();shape.Paths[0].Edges.Clear();shape.Paths[0].Edges.Add(new Hatch.BoundaryPath.Polyline(new[]{new XYZ(0,0,1),new XYZ(2,0,0),new XYZ(1,0.2,0)}));
        shape.Pattern.Lines[0].BasePoint=new XY(0,-0.5);shape.Pattern.Lines[0].Offset=new XY(0,10);Check(shape,false,"bulge interior extremum crosses");
        shape.Pattern.Lines[0].BasePoint=new XY(0,2);Check(shape,true,"bulge no crossing");
        shape.Paths[0].Edges.Clear();shape.Paths[0].Edges.Add(new Hatch.BoundaryPath.Ellipse{Center=new XY(0,0.5),MajorAxisEndPoint=new XY(0.1,0.1),RadiusRatio=0.5,EndAngle=Math.Tau});
        shape.Pattern.Lines[0].BasePoint=XY.Zero;shape.Pattern.Lines[0].Offset=new XY(0,1);Check(shape,true,"full tilted ellipse");
        ((Hatch.BoundaryPath.Ellipse)shape.Paths[0].Edges[0]).EndAngle=Math.PI;Check(shape,false,"partial ellipse");
        shape.Paths[0].Edges.Clear();shape.Paths[0].Edges.Add(new Hatch.BoundaryPath.Arc{Center=new XY(0,0.5),Radius=0.1,EndAngle=Math.Tau});Check(shape,true,"full circle");
        shape.Pattern.Lines[0].BasePoint=new XY(0,0.4);Check(shape,false,"circle tangent");
        shape=Polygon();shape.Paths[0].Edges.Clear();
        var corners=new[]{new XY(0,0.2),new XY(1,0.2),new XY(1,0.8),new XY(0,0.8)};
        for(int i=0;i<4;i++)shape.Paths[0].Edges.Add(new Hatch.BoundaryPath.Line{Start=corners[i],End=corners[(i+1)%4]});
        Check(shape,true,"explicit line boundary");
        ((Hatch.BoundaryPath.Line)shape.Paths[0].Edges[0]).End+=new XY(1e-10,0);Check(shape,false,"small open gap not silently closed");
        var doc=new CadDocument(ACadVersion.AC1027);
        doc.Entities.Add(Polygon());
        var cancelled=Polygon();cancelled.Pattern.Lines[0].BasePoint=new XY(0,0.5);cancelled.Paths.Add(cancelled.Paths[0].Clone());doc.Entities.Add(cancelled);
        var visible=Polygon();visible.Pattern.Lines[0].BasePoint=new XY(0,0.5);doc.Entities.Add(visible);
        DwgWriter.Write(Path.Combine(folder,"empty-pattern-cases.dwg"),doc);
        Console.WriteLine($"PASS: {count} conservative empty HATCH cases (including crossing/unsupported/uncertain controls).");
    }

    static void ProxyAndHatchSelfTest(string folder)
    {
        List<XYZ> Square(double x,double y,double width)=>[new XYZ(x,y,0),new XYZ(x+width,y,0),new XYZ(x+width,y+width,0),new XYZ(x,y+width,0)];
        var hatch=new Hatch{Pattern=new HatchPattern("unit-horizontal")};
        hatch.Pattern.Lines.Add(new HatchPattern.Line{BasePoint=new XY(0,0.5),Offset=new XY(0,2)});
        foreach(double x in new[]{0.0,1.0}) {
            var path=new Hatch.BoundaryPath();path.Edges.Add(new Hatch.BoundaryPath.Polyline(Square(x,0,1)));hatch.Paths.Add(path);
        }
        var spans=hatch.ExplodePattern().OrderBy(l=>l.StartPoint.X).ToArray();
        if(spans.Length!=2 || Math.Abs(spans.Sum(l=>(l.EndPoint-l.StartPoint).GetLength())-2)>1e-9)
            throw new InvalidDataException("Adjacent hatch loops lost a coincident crossing");
        // Identical loops have even parity; nested rings keep their hole.
        hatch.Paths.RemoveAt(1);hatch.Paths.Add(hatch.Paths[0].Clone());
        if(hatch.ExplodePattern().Any())throw new InvalidDataException("Duplicate hatch loops must cancel by parity");
        hatch.Paths.Clear();
        foreach(var ring in new[]{Square(0,0,4),Square(1,0.25,1)}) {
            var path=new Hatch.BoundaryPath();path.Edges.Add(new Hatch.BoundaryPath.Polyline(ring));hatch.Paths.Add(path);
        }
        if(Math.Abs(hatch.ExplodePattern().Sum(l=>(l.EndPoint-l.StartPoint).GetLength())-7)>1e-9)
            throw new InvalidDataException("Nested hatch hole changed");
        var doc=new CadDocument(ACadVersion.AC1027);var entity=new Line{IsInvisible=true};doc.Entities.Add(entity);
        var custom=new LineType("proxy-line");doc.LineTypes.Add(custom);
        int lineIndex=doc.LineTypes.Where(l=>l.Name!="ByLayer"&&l.Name!="ByBlock").ToList().IndexOf(custom);
        entity.ProxyGeometries.AddRange(new IProxyGeometry[]{new ProxySubentColor{ColorIndex=1},
            new ProxySubentLineWeight{LineWeight=(LineWeightType)50},new ProxySubentLineTypeScale{LineTypeScale=2},
            new ProxySubentLineType{LineTypeIndex=(uint)lineIndex},
            new ProxyCircularArc{Center=new XYZ(10,20,0),Radius=2,Normal=-XYZ.AxisZ,StartVectorDirection=XYZ.AxisX,SweepAngle=Math.PI*1.5},
            new ProxySubentLineType{LineTypeIndex=32767},new ProxyPolyline{Points=new(){XYZ.Zero,XYZ.AxisX}}});
        var graphics=CachedProxyEntities(entity);
        if(graphics.Count!=2 || graphics[0].Entity.LineType!=custom || graphics[1].Entity.LineType.Name!="ByLayer"
            || graphics.Any(g=>g.Entity.Color.Index!=1||g.Entity.LineWeight!=(LineWeightType)50||g.Entity.LineTypeScale!=2||!g.Entity.IsInvisible))
            throw new InvalidDataException("Proxy state or linetype indexing lost");
        var arc=(Arc)graphics[0].Entity;var points=arc.PolygonalVertexes(5).ToArray();
        if((points[0]-new XYZ(12,20,0)).GetLength()>1e-9 || (points[^1]-new XYZ(10,22,0)).GetLength()>1e-9)
            throw new InvalidDataException("Proxy arc world coordinates/negative normal changed");
        entity.ProxyGeometries.Add(new ProxyPushModelTransform());
        bool rejected=false;try{CachedProxyEntities(entity);}catch(InvalidDataException){rejected=true;}
        if(!rejected)throw new InvalidDataException("Unsupported proxy transform must not be silently ignored");
        Console.WriteLine("PASS: adjacent/nested/duplicate hatch parity; proxy arc coordinates, style state, linetype indices and unsupported transforms.");
    }
    static void DimensionSourceSelfTest(string folder)
    {
        var doc=new CadDocument(ACadVersion.AC1024);
        var dimension=new DimensionLinear{Text="WIDTH=5",FirstPoint=XYZ.Zero,SecondPoint=new XYZ(5,0,0)};
        doc.Entities.Add(dimension);
        foreach(var (handle,constraint,expected) in new (ulong?,bool,string)[]{
            (0,true,"constraint-without-picture"),(0,false,"absent"),
            (999,true,"unresolved-reference"),(999,false,"unresolved-reference"),(null,true,"unknown")}) {
            if(DimensionPictureStatus(dimension,handle,constraint)!=expected)
                throw new InvalidDataException("Dimension picture classification conflated source pointers or constraints");
        }
        var block=new BlockRecord("saved-dimension-picture");block.Entities.Add(new Line(XYZ.Zero,XYZ.AxisX));
        doc.BlockRecords.Add(block);dimension.Block=block;
        if(DimensionPictureStatus(dimension,block.Handle,true)!="stored")
            throw new InvalidDataException("Stored dimension picture must take precedence over constraint relations");
        dimension.Block=null;
        string target=Path.Combine(folder,"dimension-source");Directory.CreateDirectory(target);
        using(records=new StreamWriter(Path.Combine(target,"records.jsonl")))
        using(losses=new StreamWriter(Path.Combine(target,"losses.jsonl")))
        using(positions=new BinaryWriter(File.Create(Path.Combine(target,"positions.bin")))) {
            foreach(bool constrained in new[]{true,false}) {
                string id=constrained?"constraint":"missing";
                MapDimension(dimension,"test-space",id,R(("sourcePictureBlockHandle","0"),
                    ("pictureStatus",DimensionPictureStatus(dimension,0,constrained)),("constraintDependencies",Array.Empty<object>())));
            }
        }
        var rows=File.ReadLines(Path.Combine(target,"records.jsonl")).Select(l=>JsonDocument.Parse(l)).ToArray();
        var semantics=rows.Where(r=>r.RootElement.GetProperty("table").GetString()=="dimensionSemantics").ToArray();
        if(semantics.Length!=2 || semantics.Any(r=>r.RootElement.GetProperty("value").GetProperty("text").GetString()!="WIDTH=5")
            || rows.Any(r=>r.RootElement.GetProperty("table").GetString() is "displays" or "blockInstances")
            || new FileInfo(Path.Combine(target,"positions.bin")).Length!=0)
            throw new InvalidDataException("Missing dimension semantics lost or presentation invented");
        var codes=File.ReadLines(Path.Combine(target,"losses.jsonl")).Select(l=>JsonDocument.Parse(l).RootElement.GetProperty("code").GetString()).ToArray();
        if(!codes.SequenceEqual(new[]{"native-dimension-constraint-display-unavailable","native-dimension-picture-missing"}))
            throw new InvalidDataException("Constraint and ordinary missing picture diagnostics conflated");
        foreach(var row in rows)row.Dispose();
        Console.WriteLine("PASS: dimension source zero/nonzero/unknown pointers, constraint relations and stored pictures remain distinct; missing pictures retain parameters without invented linework.");
    }
    static void SpatialFilterSelfTest(string folder)
    {
        var document=new CadDocument(ACadVersion.AC1027);
        var block=new BlockRecord("clip-transform");
        block.Entities.Add(new Line(XYZ.Zero,new XYZ(10,5,0)));document.BlockRecords.Add(block);
        var inverse=Transform.CreateTranslation(new XYZ(10,20,0)).Matrix
            *Transform.CreateRotation(XYZ.AxisZ,Math.PI/2).Matrix;
        foreach(bool enabled in new[]{true,false}) {
            var insert=new Insert(block){InsertPoint=new XYZ(30,40,0),XScale=-2,YScale=3};
            document.Entities.Add(insert);
            insert.SpatialFilter=new SpatialFilter{DisplayBoundary=enabled,Origin=XYZ.Zero,
                BoundaryPoints=new(){new XY(0,0),new XY(4,2)},InverseInsertTransform=inverse};
        }
        string file=Path.Combine(folder,"spatial-filter.dwg");DwgWriter.Write(file,document);
        var actual=DwgReader.Read(file).Entities.OfType<Insert>().ToArray();
        if(actual.Length!=2 || !actual[0].SpatialFilter.DisplayBoundary || actual[1].SpatialFilter.DisplayBoundary)
            throw new InvalidDataException("Spatial-filter enable state changed");
        foreach(var insert in actual) {
            var clip=insert.SpatialFilter;
            var point=new Transform(clip.InverseInsertTransform).ApplyTransform(new XYZ(4,2,0));
            if((point-new XYZ(8,24,0)).GetLength()>1e-9 || clip.BoundaryPoints.Count!=2)
                throw new InvalidDataException("Spatial-filter 4x3 matrix lost rotation or translation");
        }
        Console.WriteLine("PASS: native spatial-filter DWG roundtrip retains enabled/disabled boundaries, rotation and translation.");
    }
    static void DuplicateAttributeSelfTest(string folder)
    {
        var document=new CadDocument(ACadVersion.AC1027);
        var block=new BlockRecord("duplicate-attributes");
        block.Entities.Add(new Line(XYZ.Zero,XYZ.AxisX));document.BlockRecords.Add(block);
        var insert=new Insert(block);document.Entities.Add(insert);
        insert.Attributes.Add(new AttributeEntity{Tag="NAME",Value="first",InsertPoint=new XYZ(1,2,0),Height=1});
        insert.Attributes.Add(new AttributeEntity{Tag="NAME",Value="second",InsertPoint=new XYZ(3,4,0),Height=1,Flags=AttributeFlags.Hidden});
        insert.Attributes.Add(new AttributeEntity{Tag="name",Value="case-distinct",Height=1});
        insert.Attributes.Add(new AttributeEntity{Tag="UNIQUE",Value="unique",Height=1});
        string source=Path.Combine(folder,"duplicate-attributes.dwg"),target=Path.Combine(folder,"duplicate-attributes");
        DwgWriter.Write(source,document);var reread=DwgReader.Read(source);
        var actual=reread.Entities.OfType<Insert>().Single();Directory.CreateDirectory(target);
        using(records=new StreamWriter(Path.Combine(target,"ucd-records.jsonl")))
        using(losses=new StreamWriter(Path.Combine(target,"losses.jsonl"))) {
            Instance(actual,actual.Block,"test-space","instance-"+H(actual),Matrix(InsertTransform(actual)));
            foreach(var attribute in actual.Attributes)Text(attribute,attribute,"test-space","annotation-"+H(attribute));
        }
        var rows=File.ReadLines(Path.Combine(target,"ucd-records.jsonl")).Select(line=>JsonDocument.Parse(line)).ToArray();
        var instance=rows.Single(r=>r.RootElement.GetProperty("table").GetString()=="blockInstances").RootElement.GetProperty("value");
        var tags=instance.GetProperty("attributes");
        if(tags.EnumerateObject().Count()!=3 || tags.GetProperty("NAME").GetString()!="first" || tags.GetProperty("name").GetString()!="case-distinct")
            throw new InvalidDataException("Duplicate tag summary changed source order or case");
        foreach(var attribute in actual.Attributes) {
            string id="annotation-"+H(attribute);
            var text=rows.Single(r=>r.RootElement.GetProperty("table").GetString()=="annotations"&&r.RootElement.GetProperty("id").GetString()==id).RootElement.GetProperty("value");
            var state=rows.Single(r=>r.RootElement.GetProperty("table").GetString()=="entityState"&&r.RootElement.GetProperty("id").GetString()==id).RootElement.GetProperty("value");
            if(text.GetProperty("text").GetString()!=attribute.Value || text.GetProperty("semantic").GetProperty("attributeTag").GetProperty("value").GetString()!=attribute.Tag
                || text.GetProperty("ownerBlockInstanceId").GetString()!=instance.GetProperty("id").GetString()
                || state.GetProperty("visible").GetBoolean()==attribute.Flags.HasFlag(AttributeFlags.Hidden))
                throw new InvalidDataException("Repeated attribute entity or visibility lost");
        }
        if(File.ReadLines(Path.Combine(target,"losses.jsonl")).Count()!=1)throw new InvalidDataException("Duplicate tag ambiguity was not reported once");
        foreach(var row in rows)row.Dispose();
        Console.WriteLine("PASS: repeated attribute tags retain INSERT, all values, source tags, owner links and Hidden state; summary preserves source order and case.");
    }
    static void LayerStateSelfTest(string folder)
    {
        var document=new CadDocument(ACadVersion.AC1027);
        var cases=new[]{LayerFlags.None,LayerFlags.FrozenNewViewports,LayerFlags.Frozen,
            LayerFlags.Frozen|LayerFlags.FrozenNewViewports|LayerFlags.Locked};
        foreach(var flags in cases) {
            var layer=new Layer("flags-"+(int)flags){Flags=flags};
            document.Layers.Add(layer);
            document.Entities.Add(new Line(XYZ.Zero,XYZ.AxisX){Layer=layer});
        }
        string source=Path.Combine(folder,"layer-flags.dwg"),target=Path.Combine(folder,"layer-flags-read");
        DwgWriter.Write(source,document);
        Run(new[]{source,target});
        foreach(string line in File.ReadLines(Path.Combine(target,"ucd-records.jsonl"))) {
            using var row=JsonDocument.Parse(line);
            if(row.RootElement.GetProperty("table").GetString()!="layers")continue;
            var value=row.RootElement.GetProperty("value");var name=value.GetProperty("name").GetString()!;
            if(!name.StartsWith("flags-"))continue;
            int flags=int.Parse(name[6..]);
            if(value.GetProperty("frozen").GetBoolean()!=((flags&1)!=0)
                ||value.GetProperty("lockedForEditing").GetBoolean()!=((flags&4)!=0))
                throw new InvalidDataException("Current layer freeze confused with new-viewport freeze");
        }
    }
    static void SelfTest(string folder)
    {
        Directory.CreateDirectory(folder);
        Display2DSelfTest(folder);
        MeshSelfTest(folder);
        foreach(short raw in new short[]{-1,4,257}) {
            var document=new CadDocument(ACadVersion.AC1027);
            document.Header.IntersectionColorIndex=raw;
            document.Header.InterfereColor=new Color(211,71,33);
            document.Entities.Add(new Line(XYZ.Zero,XYZ.AxisX));
            string path=Path.Combine(folder,"header-"+raw+".dwg");
            DwgWriter.Write(path,document);
            var reread=DwgReader.Read(path);
            if(reread.Header.IntersectionColorIndex!=raw || !reread.Header.InterfereColor.Equals(document.Header.InterfereColor))
                throw new InvalidDataException("Distinct native header fields did not roundtrip");
        }
        var cleaned=CleanSplineDisplayPoints(new List<XYZ>{XYZ.Zero,new XYZ(10,10,0)},new List<XYZ>{new XYZ(10,10,0)});
        if(cleaned.Count!=1 || Math.Abs(cleaned[0].X-10)>1e-9)
            throw new InvalidDataException("periodic spline leading zero vertex was not removed");
        var kept=CleanSplineDisplayPoints(new List<XYZ>{XYZ.Zero,new XYZ(10,10,0)},new List<XYZ>{XYZ.Zero});
        if(kept.Count!=2)
            throw new InvalidDataException("a spline that starts at the origin must keep its first vertex");
        var fitOnly=new Spline{Degree=3};
        fitOnly.FitPoints.Add(new XYZ(0,0,0));fitOnly.FitPoints.Add(new XYZ(10,5,0));
        var fitPoints=SplineDisplayPoints(fitOnly);
        if(fitPoints.Count!=2 || Math.Abs(fitPoints[1].Y-5)>1e-9)
            throw new InvalidDataException("fit-point-only spline fallback changed");
        bool emptySplineRejected=false;
        try{SplineDisplayPoints(new Spline{Degree=3});}
        catch(InvalidDataException){emptySplineRejected=true;}
        if(!emptySplineRejected)throw new InvalidDataException("a spline with neither control nor fit points was accepted");
        var arrow=DefaultLeaderArrowPoints(XYZ.Zero,new XYZ(100,0,0),10);
        if(Math.Abs(arrow[1].X-10)>1e-9 || Math.Abs(arrow[1].Y-10.0/6.0)>1e-9
            || Math.Abs(arrow[2].Y+10.0/6.0)>1e-9)
            throw new InvalidDataException("default leader arrow geometry changed");
        bool zeroArrowRejected=false;
        try{DefaultLeaderArrowPoints(XYZ.Zero,new XYZ(100,0,0),0);}
        catch(InvalidDataException){zeroArrowRejected=true;}
        if(!zeroArrowRejected)throw new InvalidDataException("zero-size leader arrow was accepted");
        var testMline=new MLine{ScaleFactor=20,Justification=MLineJustification.Top};
        testMline.Vertices.Add(new MLine.Vertex{Position=new XYZ(0,0,0),Direction=new XYZ(0,1,0),Miter=new XYZ(-1,0,0)});
        testMline.Vertices.Add(new MLine.Vertex{Position=new XYZ(0,100,0),Direction=new XYZ(0,1,0),Miter=new XYZ(-1,0,0)});
        var offsets=new List<double>{0.5,-0.5};
        var seconds=new List<double[]?>();
        var miterSets=MiterPointSets(testMline,offsets,20,-0.5,seconds);
        if(Math.Abs(miterSets[0][0].X)>1e-9 || Math.Abs(miterSets[0][1].X-20)>1e-9
            || Math.Abs(miterSets[1][1].Y-100)>1e-9)
            throw new InvalidDataException("MLine miter parametrization changed");
        var cap=ArcPoints(new XYZ(0,0,0),new XYZ(0,20,0),8);
        if(cap.Count!=9 || Math.Abs(cap[0].Y)>1e-9 || Math.Abs(cap[^1].Y-20)>1e-9
            || Math.Abs(Math.Abs(cap[4].X)-10)>1e-6)
            throw new InvalidDataException("MLine round cap arc changed");
        LayerStateSelfTest(folder);
        AttributeVisibilitySelfTest(folder);
        DuplicateAttributeSelfTest(folder);
        SpatialFilterSelfTest(folder);
        DimensionSourceSelfTest(folder);
        ProxyAndHatchSelfTest(folder);
        EmptyHatchSelfTest(folder);
        Console.WriteLine("PASS: native DWG header fields remain independent, including raw -1; no interchange format; spline zero vertex guard; fit-point spline fallback; default leader arrow guard; MLine miter and round cap geometry.");
    }
    static (int Width,int Height) PreviewDimensions(byte[] image,DwgPreview.PreviewType code)
    {
        if(code==DwgPreview.PreviewType.Png&&image.Length>=24
            &&image[0]==0x89&&image[1]==0x50&&image[2]==0x4E&&image[3]==0x47)
        {
            int width=(image[16]<<24)|(image[17]<<16)|(image[18]<<8)|image[19];
            int height=(image[20]<<24)|(image[21]<<16)|(image[22]<<8)|image[23];
            return (width,height);
        }
        if(code==DwgPreview.PreviewType.Bmp&&image.Length>=26)
        {
            int offset=image.Length>=18&&image[0]==0x42&&image[1]==0x4D?18:4;
            int width=BitConverter.ToInt32(image,offset);
            int height=Math.Abs(BitConverter.ToInt32(image,offset+4));
            return (width,height);
        }
        return (0,0);
    }
    static void Preview(string inputPath,string outputFolder)
    {
        string input=Path.GetFullPath(inputPath);string output=Path.GetFullPath(outputFolder);
        Directory.CreateDirectory(output);
        string metaPath=Path.Combine(output,"preview.json"),imagePath=Path.Combine(output,"preview.bin");
        using var stream=File.OpenRead(input);
        byte[] signature=new byte[6];stream.ReadExactly(signature);
        string version=System.Text.Encoding.ASCII.GetString(signature);
        if(!System.Text.RegularExpressions.Regex.IsMatch(version,"^AC10[0-9]{2}$"))
            throw new InvalidDataException("Not native DWG bytes");
        stream.Position=0;
        using var reader=new DwgReader(stream);
        var preview=reader.ReadPreview();
        string? contentType=preview?.Code switch
        {
            DwgPreview.PreviewType.Bmp=>"image/bmp",
            DwgPreview.PreviewType.Png=>"image/png",
            _=>null
        };
        if(preview is null||preview.RawImage.Length==0||preview.RawImage.Length>4*1024*1024||contentType is null)
        {
            string reason=preview is null?"missing":contentType is null?"unsupported-preview-format":"preview-too-large";
            File.WriteAllText(metaPath,JsonSerializer.Serialize(new{available=false,reason}));
            Console.WriteLine(JsonSerializer.Serialize(new{available=false,bytes=preview?.RawImage.Length??0,reason}));
            return;
        }
        byte[] image=preview.RawImage;
        File.WriteAllBytes(imagePath,image);
        var (width,height)=PreviewDimensions(image,preview.Code);
        string sha=Convert.ToHexString(SHA256.HashData(image)).ToLowerInvariant();
        File.WriteAllText(metaPath,JsonSerializer.Serialize(new{available=true,contentType,width,height,byteLength=image.Length,imageSHA256=sha}));
        Console.WriteLine(JsonSerializer.Serialize(new{available=true,bytes=image.Length,width,height,contentType}));
    }
    static int Main(string[] args)
    {
        try { return Run(args); }
        catch(Exception error) {
            // Single-line structured report so a conversion failure carries its cause
            // instead of an opaque process abort; the platform appends this line to
            // the job error message. Exit code 70 (EX_SOFTWARE) stays distinct from
            // usage errors and from the process-abort codes used by SIGABRT deaths.
            var frames=(error.StackTrace??"").Split('\n',StringSplitOptions.RemoveEmptyEntries).Take(6).Select(line=>line.Trim());
            Console.Error.WriteLine("READER-ERROR "+JsonSerializer.Serialize(new{type=error.GetType().FullName,message=error.Message,stack=frames}));
            return 70;
        }
    }
    static int Run(string[] args)
    {
        if(args.Length==2&&args[0]=="--self-test"){SelfTest(args[1]);return 0;}
        if(args.Length==3&&args[0]=="--preview"){Preview(args[1],args[2]);return 0;}
        if(args.Length!=2)throw new ArgumentException("DWG source path and private output folder are required");
        string input=Path.GetFullPath(args[0]);output=Path.GetFullPath(args[1]);
        Directory.CreateDirectory(output);
        using var inputStream=File.OpenRead(input);
        byte[] signature=new byte[6];inputStream.ReadExactly(signature);
        string version=System.Text.Encoding.ASCII.GetString(signature);
        if(!System.Text.RegularExpressions.Regex.IsMatch(version,"^AC10[0-9]{2}$"))throw new InvalidDataException("Not native DWG bytes");
        inputStream.Position=0;
        string sha=Convert.ToHexString(SHA256.HashData(inputStream)).ToLowerInvariant();sourceId="source-0";
        inputStream.Position=0;
        var time=Stopwatch.StartNew();
        string readerSha256=Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Assembly.GetExecutingAssembly().Location))).ToLowerInvariant();
        using var notifications=new StreamWriter(Path.Combine(output,"notifications.jsonl"));
        using var reader=new DwgReader(inputStream,(_,e)=>notifications.WriteLine(JsonSerializer.Serialize(new{type=e.NotificationType.ToString(),e.Message,error=e.Exception?.ToString()})));
#pragma warning disable CS0618
        // A single unreadable native object (e.g. an ACAD_TABLE cell value whose
        // CadValueType has no implemented DWG layout) must not abort the whole
        // drawing: ACadSharp's failsafe skips that object with an Error notification,
        // the handle audit below reports it as a missing-handle loss, and every other
        // object is still read from its own offset. Strictness lives in the loss ledger.
        reader.Configuration=new DwgReaderConfiguration{Failsafe=true,KeepUnknownEntities=true,KeepUnknownNonGraphicalObjects=true,IgnoreProxyGraphics=false};
#pragma warning restore CS0618
        var doc=reader.Read();double readSeconds=time.Elapsed.TotalSeconds;
        ReadDimensionSources(reader,doc);
        ReadProxySources(reader,doc);
        var readMemory=new{managedLiveBytes=GC.GetTotalMemory(false),managedCommittedBytes=GC.GetGCMemoryInfo().TotalCommittedBytes};
        using(records=new StreamWriter(Path.Combine(output,"ucd-records.jsonl")))
        using(losses=new StreamWriter(Path.Combine(output,"losses.jsonl")))
        using(positions=new BinaryWriter(File.Create(Path.Combine(output,"positions.bin")))) {
            Visit(doc.ModelSpace);
            foreach(var layout in doc.Layouts) if(layout.AssociatedBlock is not null) Visit(layout.AssociatedBlock);
            foreach(var block in doc.BlockRecords)if(reachable.Contains(block.Handle))spaces[block.Handle]="space-"+H(block);
            foreach(var layer in doc.Layers) {
                var style=ColorStyle(layer.Color,layer.PlotFlag);style["lineTypeId"]="linetype-"+H(layer.LineType);
                if((short)layer.LineWeight>=0)style["lineWeight"]=Fact((short)layer.LineWeight/100.0);
                string id="layer-"+H(layer);var flags=layer.Flags;
                Emit("layers",id,new{id,drawingId,name=layer.Name,visible=layer.IsOn,frozen=(flags&LayerFlags.Frozen)!=0,lockedForEditing=(flags&LayerFlags.Locked)!=0,plot=layer.PlotFlag,defaultStyle=style,sourceRefs=Refs(layer)});
            }
            Emit("nativeLineTypeSettings",drawingId,new{scale=doc.Header.LineTypeScale});
            foreach(var line in doc.LineTypes) {
                string id="linetype-"+H(line);
                Emit("nativeLineTypes",id,new{alignment=line.Alignment.ToString(),complex=line.Segments.Any(s=>s.IsShape||s.IsText)});
                Emit("lineTypes",id,new{id,name=line.Name,segments=line.Segments.Select(s=>new{kind=s.Length==0?"dot":s.Length<0?"gap":"dash",length=Math.Abs(s.Length)}).ToArray(),unit="drawing-unit"});
            }
            foreach(var style in doc.TextStyles) Emit("nativeFonts",H(style),new{handle=H(style),style.Name,style.Filename,style.BigFontFilename,style.Height,style.Width,style.ObliqueAngle,fontFamily=FontFamily(style)});
            foreach(var block in doc.BlockRecords) if(reachable.Contains(block.Handle)) {
                string space=spaces[block.Handle],bid="block-"+H(block);
                string kind=block==doc.ModelSpace?"model":block.Name.StartsWith("*Paper_Space",StringComparison.OrdinalIgnoreCase)?"paper":"block";
                Emit("spaces",space,new{id=space,drawingId,kind,ownerId=kind=="block"?bid:drawingId,entityIds=Array.Empty<string>(),annotationIds=Array.Empty<string>(),blockInstanceIds=Array.Empty<string>()});
                if(kind=="block")Emit("blocks",bid,new{id=bid,drawingId,name=block.Name,spaceId=space,basePoint=P(block.BlockEntity.BasePoint),units=Unknown(),dynamicParameters=R()});
                if((block.BlockEntity.Flags&(BlockTypeFlags.XRef|BlockTypeFlags.XRefOverlay))!=0)
                    Emit("nativeExternalReferences",bid,new{requestedPath=block.BlockEntity.XRefPath,
                        overlay=(block.BlockEntity.Flags&BlockTypeFlags.XRefOverlay)!=0,sourceRefs=Refs(block)});
                foreach(var e in SortedEntities(block))Map(e,space);
            }
            foreach(var layout in doc.Layouts)if(layout.AssociatedBlock is not null && layout.AssociatedBlock!=doc.ModelSpace) {
                string id="layout-"+H(layout);
                Emit("layouts",id,new{id,drawingId,name=layout.Name,paperSpaceId=spaces[layout.AssociatedBlock.Handle],viewportIds=Array.Empty<string>(),paperToSheet=Identity});
                if(layout.Viewports.Any())Loss(layout,"layout-viewport-unmapped","Native layout contains viewports requiring an accepted 2D camera mapping");
            }
            var registry=(IDictionary)typeof(CadDocument).GetField("_cadObjects",BindingFlags.Instance|BindingFlags.NonPublic)!.GetValue(doc)!;
            var handles=(Dictionary<ulong,long>)typeof(DwgReader).GetMethod("readHandles",BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(reader,null)!;
            using var ledger=new StreamWriter(Path.Combine(output,"source-handles.tsv"));
            ledger.WriteLine("handle\ttype\towner\tsourceOffset\tmapped\tscope");
            int missing=0,sourceEntities=0,mappedSource=0;var sourceTypes=new Dictionary<string,int>();
            foreach(var pair in handles) {
                var obj=registry[pair.Key] as CadObject;
                if(obj is null){missing++;ledger.WriteLine($"{pair.Key:X}\tUNKNOWN\t\t{pair.Value}\tfalse\tmissing-from-reader");continue;}
                sourceTypes[obj.ObjectName]=sourceTypes.GetValueOrDefault(obj.ObjectName)+1;
                if(obj is Entity)sourceEntities++;
                string id=(obj is Insert or Dimension?"instance-":obj is IText?"annotation-":"entity-")+H(obj);
                string scope=obj.Owner is BlockRecord owner&&!reachable.Contains(owner.Handle)?"unreferenced-definition":obj is Entity?"scene":"non-graphical";
                if(mappedSourceHandles.Contains(obj.Handle))mappedSource++;
                ledger.WriteLine($"{pair.Key:X}\t{obj.ObjectName}\t{obj.Owner?.Handle.ToString("X")}\t{pair.Value}\t{mappedSourceHandles.Contains(obj.Handle)}\t{scope}");
            }
            if(missing>0)Loss(null,"reader-missing-handles",missing+" original handles are absent from the native registry");
            // Negative INTERSECTIONCOLOR values mean "unset" in the DWG header and
            // have no 2D display effect; only an out-of-range positive index is a
            // real value this presenter cannot represent.
            if(doc.Header.IntersectionColorIndex>257) Loss(null,"unrepresented-header-color","INTERSECTIONCOLOR raw value retained without assigning a source Color");
            File.WriteAllText(Path.Combine(output,"native-summary.json"),JsonSerializer.Serialize(new{
                reader="ACadSharp",readerVersion="3.8.30+intersection-field-separation",readerSha256,readMemory,source=new{path=input,name=Path.GetFileName(input),sha256=sha,byteLength=inputStream.Length,format="DWG",detectedVersion=version},
                header=new{intersectionColorRaw=doc.Header.IntersectionColorIndex,interfereColor=new{index=doc.Header.InterfereColor.Index,trueColor=doc.Header.InterfereColor.TrueColor},codePage=doc.Header.CodePage.ToString(),insUnits=doc.Header.InsUnits.ToString(),
                    modelSpaceExtMin=new[]{doc.Header.ModelSpaceExtMin.X,doc.Header.ModelSpaceExtMin.Y,doc.Header.ModelSpaceExtMin.Z},
                    modelSpaceExtMax=new[]{doc.Header.ModelSpaceExtMax.X,doc.Header.ModelSpaceExtMax.Y,doc.Header.ModelSpaceExtMax.Z},
                    paperSpaceExtMin=new[]{doc.Header.PaperSpaceExtMin.X,doc.Header.PaperSpaceExtMin.Y,doc.Header.PaperSpaceExtMin.Z},
                    paperSpaceExtMax=new[]{doc.Header.PaperSpaceExtMax.X,doc.Header.PaperSpaceExtMax.Y,doc.Header.PaperSpaceExtMax.Z}},
                modelSpaceId=spaces[doc.ModelSpace.Handle],readSeconds,totalSeconds=time.Elapsed.TotalSeconds,sourceHandles=handles.Count,missingHandles=missing,
                mappedObjects=ids.Count,mappedSourceObjects=mappedSource,sourceEntityRecords=sourceEntities,sourceTypes,reachableBlocks=reachable.Count,totalBlocks=doc.BlockRecords.Count,counts,lossCount=lost,
                derivativePolicy="Native parameters + ACadSharp evaluated display curves; original source is authoritative; no completeness claim"}));
        }
        Console.WriteLine(JsonSerializer.Serialize(new{readSeconds,totalSeconds=time.Elapsed.TotalSeconds,mappedObjects=ids.Count,losses=lost}));
        return 0;
    }
}
