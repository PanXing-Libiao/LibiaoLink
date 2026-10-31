using System.Collections;
using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using ACadSharp;
using ACadSharp.Entities;
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
    static void State(Entity e, string id, Row? extra=null)
    {
        var state=extra ?? R();
        state["visible"]=!e.IsInvisible;
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
        // A wipeout is a preview mask: a white filled polygon over the source.
        // It is not a viewer mask part, so hit testing is not occluded.
        var points=pixels.Select(p=>new XYZ(
            origin.X+u.X*p.X+v.X*(size.Y-p.Y),
            origin.Y+u.Y*p.X+v.Y*(size.Y-p.Y),
            origin.Z+u.Z*p.X+v.Z*(size.Y-p.Y))).ToArray();
        if(points.Length<3){Loss(original,"wipeout-boundary-invalid","Wipeout boundary has fewer than three vertices");return;}
        var mask=new Polyline3D(points){Layer=e.Layer,Color=new Color(255,255,255),LineType=e.LineType};
        EntityRow(mask,space,id,Poly(points,true),Closed(points),original:original);
        Emit("fills",id,new{rings=new[]{points.Select(P).ToArray()},fillRule="even-odd"});
    }
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
        if(e is TextEntity single) {
            semantic["widthFactor"]=Fact(single.WidthFactor);
            semantic["halign"]=Fact((int)single.HorizontalAlignment);
            semantic["valign"]=Fact((int)single.VerticalAlignment);
            semantic["horizontalAlignment"]=Fact(single.HorizontalAlignment.ToString());
            semantic["verticalAlignment"]=Fact(single.VerticalAlignment.ToString());
            semantic["alignmentPoint"]=Fact(P(single.AlignmentPoint));
        }
        if(e is MText multiline) {
            semantic["attachmentPoint"]=Fact((int)multiline.AttachmentPoint);
            semantic["rectangleWidth"]=Fact(multiline.RectangleWidth);
            semantic["lineSpacing"]=Fact(multiline.LineSpacing);
            semantic["drawingDirection"]=Fact(multiline.DrawingDirection.ToString());
            semantic["hasColumns"]=Fact(multiline.HasColumns);
            if(multiline.DrawingDirection.ToString()=="TopToBottom" || multiline.HasColumns)
                Loss(original,"mtext-special-layout-unmapped","Vertical/column MTEXT retained; this presentation does not claim its original layout.");
        }
        var row=R(("id",id),("ownerSpaceId",space),("layerId","layer-"+H(e.Layer)),("kind",e is MText?"mtext":"text"),
             ("position",P(point)),("direction",new[]{Math.Cos(text.Rotation),Math.Sin(text.Rotation),0.0}),
             ("text",value),("semantic",semantic),("associativeEntityIds",Array.Empty<string>()),
             ("presentationEntityIds",Array.Empty<string>()),("annotationScales",Array.Empty<double>()),("sourceRefs",Refs(original)));
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
            row["attributes"]=i.Attributes.ToDictionary(a=>a.Tag,a=>a.Value);
            if(i.IsMultiple) row["array"]=R(("rows",(int)i.RowCount),("columns",(int)i.ColumnCount),
              ("rowOffset",new[]{-Math.Sin(i.Rotation)*i.RowSpacing,Math.Cos(i.Rotation)*i.RowSpacing,0}),
              ("columnOffset",new[]{Math.Cos(i.Rotation)*i.ColumnSpacing,Math.Sin(i.Rotation)*i.ColumnSpacing,0}));
        }
        Emit("blockInstances",id,row); State(e,id);
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
            case Dimension dimension when dimension.Block is not null:
                // Same strategy as ACadSharp.Formats: consume the source's stored
                // dimension picture. Do not recalculate engineering measurements.
                Instance(e,dimension.Block,space,id,Identity);
                Emit("dimensionSemantics",id,R(("sourceType",e.ObjectName),("measurement",dimension.Measurement),
                    ("text",dimension.Text),("pictureBlockHandle",H(dimension.Block)),("sourceRefs",Refs(e))));
                return;
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
                if(e is LwPolyline or Polyline2D) {
                    var ocs=Matrix4.GetArbitraryAxis(polyline.Normal);
                    polyPoints=polyPoints.Select(p=>ocs*new XYZ(p.X,p.Y,polyline.Elevation)).ToList();
                }
                if(polyline.IsClosed) polyPoints=Closed(polyPoints);
                EntityRow(e,space,id,Poly(polyPoints),polyPoints,original:original);
                Emit("nativeGeometry",id,R(("type","polyline"),("closed",polyline.IsClosed),("normal",P(polyline.Normal)),("elevation",polyline.Elevation),
                    ("vertices",polyline.Vertices.Select(v=>R(("point",new[]{v.Location[0],v.Location[1]}),("bulge",v.Bulge))).ToArray()))); return;
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
            case MultiLeader multi when multi.HasProxyGeometries:
                MapProxy(multi,space,id);return;
            default:
                EntityRow(e,space,id,R(("type","unsupported"),("sourceType",e.ObjectName),("reason","Native object retained; no accepted 2D presentation mapping")),null,original:original);
                if(e is Region region && region.AcisData is not null) {
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
            else Loss(hatch,"empty-native-hatch-pattern","Community hatch pattern returned no linework; source boundary retained.");
        }
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
                  Style=new TextStyle("proxy-font"){Filename=p.FontDescriptor.FontFilename??p.FontDescriptor.Typeface??"",BigFontFilename=p.BigFontFilename??""}},
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
        Console.WriteLine("PASS: native DWG header fields remain independent, including raw -1; no interchange format; spline zero vertex guard; fit-point spline fallback; default leader arrow guard; MLine miter and round cap geometry.");
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
                string id="layer-"+H(layer);string flags=layer.Flags.ToString();
                Emit("layers",id,new{id,drawingId,name=layer.Name,visible=layer.IsOn,frozen=flags.Contains("Frozen"),lockedForEditing=flags.Contains("Locked"),plot=layer.PlotFlag,defaultStyle=style,sourceRefs=Refs(layer)});
            }
            foreach(var line in doc.LineTypes) {
                string id="linetype-"+H(line);
                Emit("lineTypes",id,new{id,name=line.Name,segments=line.Segments.Select(s=>new{kind=s.Length==0?"dot":s.Length<0?"gap":"dash",length=Math.Abs(s.Length)}).ToArray(),unit="drawing-unit"});
            }
            foreach(var style in doc.TextStyles) Emit("nativeFonts",H(style),new{handle=H(style),style.Name,style.Filename,style.BigFontFilename,style.Height,style.Width,style.ObliqueAngle});
            foreach(var block in doc.BlockRecords) if(reachable.Contains(block.Handle)) {
                string space=spaces[block.Handle],bid="block-"+H(block);
                string kind=block==doc.ModelSpace?"model":block.Name.StartsWith("*Paper_Space",StringComparison.OrdinalIgnoreCase)?"paper":"block";
                Emit("spaces",space,new{id=space,drawingId,kind,ownerId=kind=="block"?bid:drawingId,entityIds=Array.Empty<string>(),annotationIds=Array.Empty<string>(),blockInstanceIds=Array.Empty<string>()});
                if(kind=="block")Emit("blocks",bid,new{id=bid,drawingId,name=block.Name,spaceId=space,basePoint=P(block.BlockEntity.BasePoint),units=Unknown(),dynamicParameters=R()});
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
