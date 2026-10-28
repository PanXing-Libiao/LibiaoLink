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
    static void EntityRow(Entity e, string space, string id, Row geometry, IEnumerable<XYZ>? points, double[]? local=null, string topology="lines", CadObject? original=null)
    {
        original ??= e;
        if(original.Handle!=0)mappedSourceHandles.Add(original.Handle);
        Emit("entities",id,R(("id",id),("drawingId",drawingId),("ownerSpaceId",space),("layerId","layer-"+H(e.Layer)),
             ("localFromOwner",local??Identity),("geometry",geometry),("style",Style(e)),("sourceRefs",Refs(original)),("displayOrder",order)));
        State(e,id);
        if(points is not null) Display(id,original,points,topology);
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
                Instance(e,i.Block,space,id,Matrix(i.GetTransform()));
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
                if(!spline.TryPolygonalVertexes(48,out var splinePoints)) throw new InvalidDataException("ACadSharp.TryPolygonalVertexes failed; no invented fit");
                splinePoints=CleanSplineDisplayPoints(splinePoints,spline.ControlPoints);
                var weights=spline.Weights.Count==0?Enumerable.Repeat(1.0,spline.ControlPoints.Count).ToArray():spline.Weights.ToArray();
                EntityRow(e,space,id,R(("type","spline"),("degree",spline.Degree),("controlPoints",spline.ControlPoints.Select(P).ToArray()),
                    ("knots",spline.Knots.ToArray()),("weights",weights),("periodic",spline.IsPeriodic)),splinePoints,original:original); return;
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
            case Solid solid:
                var solidPoints=new[]{solid.FirstCorner,solid.SecondCorner,solid.FourthCorner,solid.ThirdCorner};
                EntityRow(e,space,id,Poly(solidPoints,true),Closed(solidPoints),original:original);
                Emit("fills",id,new {rings=new[]{solidPoints.Select(P).ToArray()},fillRule="even-odd"});return;
            case Hatch hatch:
                MapHatch(hatch,space,id);return;
            case Leader leader:
                EntityRow(e,space,id,Poly(leader.Vertices),leader.Vertices,original:original);
                Loss(e,"leader-arrow-presentation","Native leader vertices retained; stored arrowhead and associated annotation need separate fidelity verification.");return;
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
        } catch(Exception error) when(error is ArgumentException or InvalidDataException or NotImplementedException or IndexOutOfRangeException) {
            // A failure is reported with its source handle. It is never a ready,
            // empty geometry or a successful complete drawing.
            Loss(original,"native-presentation-failed",error.ToString());
            if(!emitted.Contains(id))EntityRow(e,space,id,R(("type","unsupported"),("sourceType",original.ObjectName),("reason","Native presentation failed; see retained per-handle loss")),null,original:original);
            Emit("entityState",id,R(("presentationGeometry","missing"),("visible",!e.IsInvisible)));
        }
    }
    static void MapHatch(Hatch hatch,string space,string id)
    {
        Emit("hatchSemantics",id,new{pattern=hatch.Pattern.Name,hatch.IsSolid,hatch.PatternAngle,hatch.PatternScale,hatch.Style,
            gradient=hatch.GradientColor.Enabled,loops=hatch.Paths.Select(p=>new{flags=(int)p.Flags,edges=p.Edges.Count}).ToArray(),sourceRefs=Refs(hatch)});
        if(hatch.GradientColor.Enabled)Loss(hatch,"hatch-gradient-unmapped","Native gradient fields retained in source; no accepted gradient colour presentation.");
        var boundaryIds=new List<string>(); var rings=new List<double[][]>(); int n=0;
        foreach(var loop in hatch.Paths) {
            var pts=Closed(loop.GetPoints(64)); string child=id+"-boundary-"+n++;
            EntityRow(hatch,space,child,Poly(pts),pts); boundaryIds.Add(child); rings.Add(pts.Select(P).ToArray());
            Emit("entityState",child,R(("visible",false)));
        }
        EntityRow(hatch,space,id,R(("type","hatch"),("boundaryEntityIds",boundaryIds),("fillRule","even-odd")),null);
        if(hatch.IsSolid) Emit("fills",id,new {rings,fillRule="even-odd"});
        else {
            var lines=hatch.ExplodePattern().ToArray();
            if(lines.Length>200000) throw new InvalidDataException("Hatch community expansion exceeds per-object budget");
            var points=lines.SelectMany(l=>new[]{l.StartPoint,l.EndPoint}).ToArray();
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
        foreach(var proxy in entity.ProxyGeometries) {
            string child=id+"-proxy-"+i++; Entity? presentation=proxy switch {
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
                presentation.Layer=entity.Layer;presentation.Color=entity.Color;presentation.LineType=entity.LineType;
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
    static void SelfTest(string folder)
    {
        Directory.CreateDirectory(folder);
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
        Console.WriteLine("PASS: native DWG header fields remain independent, including raw -1; no interchange format; spline zero vertex guard.");
    }
    static int Main(string[] args)
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
        reader.Configuration=new DwgReaderConfiguration{Failsafe=false,KeepUnknownEntities=true,KeepUnknownNonGraphicalObjects=true,IgnoreProxyGraphics=false};
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
                string kind=block==doc.ModelSpace?"model":block.Name.StartsWith("*Paper_Space")?"paper":"block";
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
            if(doc.Header.IntersectionColorIndex<0 || doc.Header.IntersectionColorIndex>257) Loss(null,"unrepresented-header-color","INTERSECTIONCOLOR raw value retained without assigning a source Color");
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
