"""Planar REGION boundary display over ezdxf's lossless low-level SAT/SAB reader.

Selective curve interpretation follows truedxf acis.ts (019c2e5, MIT).
Unlike a permissive wireframe preview, unknown curves never become chords.
No ACIS boolean/editing/volume kernel is claimed. Loops/holes keep every edge.
"""
import math
from ezdxf.acis import sat,sab
from ezdxf.acis.abstract import AbstractEntity
from ezdxf.math import Vec3, Matrix44, BSpline
from ezdxf.entities import factory

MAX_RECORDS=100000
MAX_BYTES=16*1024*1024


def tokens(record):
    result=[]
    for item in record.data:
        if isinstance(item,sab.Token) and item.tag == 18:
            result.extend(item.value.split());continue
        item=item.value if isinstance(item,sab.Token) else item
        if isinstance(item,(tuple,list)): result.extend(item)
        elif isinstance(item,bool): result.append('reversed' if item else 'forward')
        else: result.append(item)
    return result


def refs(record):
    return [item for item in tokens(record) if isinstance(item,AbstractEntity) and not item.is_null_ptr]


def geometry(record):
    data=tokens(record);start=0
    for i,item in enumerate(data[:4]):
        if isinstance(item,AbstractEntity): start=i+1
    return data[start:]


def vector(data):
    point=Vec3([float(v) for v in data[:3]])
    if not all(math.isfinite(v) for v in point): raise ValueError('region-nonfinite-point')
    return point


def vertex(record):
    point=next((obj for obj in refs(record) if obj.name=='point'),None)
    if point is None: raise ValueError('region-vertex-point-missing')
    return vector(geometry(point))


def spline(record,edge,a,b,reversed):
    data=geometry(record)
    indices=[i for i,t in enumerate(data) if t in ('nubs','nurbs')]
    if len(indices)!=1: raise ValueError('region-procedural-curve-without-explicit-spline')
    i=indices[0]+1;degree=int(data[i]);rational=data[i-1]=='nurbs';i+=1
    if not 1<=degree<=25: raise ValueError('region-spline-degree')
    if data[i] in ('open','closed','periodic') or type(data[i]) is int and 0<=data[i]<=2: i+=1
    count=int(data[i]);i+=1
    if not 2<=count<=10000: raise ValueError('region-spline-knots-budget')
    knots=[]
    for _ in range(count):
        knot=float(data[i]);multiplicity=int(data[i+1]);i+=2
        if not math.isfinite(knot) or not 1<=multiplicity<=degree+1 or knots and knot<knots[-1]:
            raise ValueError('region-spline-knots-invalid')
        knots.extend([knot]*multiplicity)
    n=len(knots)-degree+1
    if not degree+1<=n<=10000: raise ValueError('region-spline-control-count')
    points=[];weights=[]
    for _ in range(n):
        points.append(vector(data[i:i+3]));i+=3
        if rational:
            weight=float(data[i]);i+=1
            if not math.isfinite(weight) or weight<=0: raise ValueError('region-spline-weight-invalid')
            weights.append(weight)
    knot_origin=knots[0];knot_span=knots[-1]-knot_origin
    if knot_span<=0: raise ValueError('region-spline-empty-domain')
    knots=[(k-knot_origin)/knot_span for k in knots]
    curve=BSpline(points,order=degree+1,knots=[knots[0],*knots,knots[-1]],weights=weights or None)
    lo,hi=knots[degree-1],knots[-degree]
    domain=knots[-1]-knots[0]
    params=[];raw=tokens(edge)
    for index,item in enumerate(raw[:-1]):
        if isinstance(item,AbstractEntity) and item.name.endswith('vertex'):
            try: params.append(float(raw[index+1]))
            except (TypeError,ValueError): pass  # older SAT has no edge parameters
    ranges=[]
    if len(params)==2:
        p,q=params
        source_ranges=((-q,-p),(p,q)) if reversed else ((p,q),(-q,-p))
        ranges.extend(((p-knot_origin)/knot_span,(q-knot_origin)/knot_span) for p,q in source_ranges)
    ranges.append((lo,hi))
    tolerance=max((p-a).magnitude for p in points)*1e-3+1e-8
    for start,end in ranges:
        if not lo-1e-9*domain<=start<end<=hi+1e-9*domain: continue
        first,last=curve.point(start),curve.point(end)
        if min((first-a).magnitude+(last-b).magnitude,(first-b).magnitude+(last-a).magnitude)>2*tolerance: continue
        # Split in the evaluator, retaining the original rational control data.
        if end<hi: curve=curve.split(end)[0]
        if start>lo: curve=curve.split(start)[1]
        leaf=factory.new('SPLINE');leaf.apply_construction_tool(curve)
        return leaf
    raise ValueError('region-spline-trim-does-not-match-vertices')


def edge_entity(edge):
    links=refs(edge)
    vertices=[item for item in links if item.name.endswith('vertex')]
    if not vertices: raise ValueError('region-edge-vertices-missing')
    a,b=vertex(vertices[0]),vertex(vertices[-1])
    curves=[item for item in links if item.name.endswith('-curve') or item.name.startswith('intcurve')]
    if len(curves)!=1: raise ValueError('region-edge-curve-missing-or-ambiguous')
    curve=curves[0];reverse='reversed' in tokens(edge)
    if curve.name=='straight-curve':
        return factory.new('LINE',dxfattribs={'start':a,'end':b})
    if curve.name=='ellipse-curve':
        data=geometry(curve);center,normal,major=vector(data),vector(data[3:]),vector(data[6:]);ratio=float(data[9])
        if not 0<ratio<=1 or not normal.magnitude or not major.magnitude: raise ValueError('region-ellipse-invalid')
        minor=normal.normalize().cross(major)*ratio
        def angle(p):
            d=p-center
            return math.atan2(d.dot(minor)/minor.magnitude_square,d.dot(major)/major.magnitude_square)
        start,end=angle(a),angle(b)
        for point,t in ((a,start),(b,end)):
            if (center+major*math.cos(t)+minor*math.sin(t)-point).magnitude>major.magnitude*1e-3+1e-8:
                raise ValueError('region-ellipse-vertices-off-curve')
        if reverse: start,end=end,start
        while end-start<=1e-12: end+=2*math.pi
        return factory.new('ELLIPSE',dxfattribs={'center':center,'major_axis':major,'extrusion':normal,
            'ratio':ratio,'start_param':start,'end_param':end})
    return spline(curve,edge,a,b,reverse)


def primitives(entity):
    raw=entity.sab if entity.has_binary_data else entity.sat
    if not raw: raise ValueError('region-acis-data-missing')
    size=len(raw) if isinstance(raw,bytes) else sum(len(line) for line in raw)
    if size>MAX_BYTES: raise ValueError('region-acis-byte-budget')
    builder=sab.parse_sab(raw) if entity.has_binary_data else sat.parse_sat(raw)
    if len(builder.entities)>MAX_RECORDS: raise ValueError('region-acis-record-budget')
    if not builder.bodies: raise ValueError('region-acis-body-missing')
    emitted=set();pending=[]
    for body in builder.bodies:
        transform=next((r for r in refs(body) if r.name=='transform'),None)
        matrix=Matrix44()
        if transform is not None:
            values=[float(v) for v in tokens(transform)[:12]]
            if len(values)!=12 or not all(math.isfinite(v) for v in values): raise ValueError('region-transform-invalid')
            matrix=Matrix44([*values[:3],0,*values[3:6],0,*values[6:9],0,*values[9:12],1])
        queue=[body];seen=set();edges=[];planes=[]
        while queue:
            record=queue.pop()
            if id(record) in seen: continue
            seen.add(id(record))
            if record.name.endswith('edge') and not record.name.endswith('coedge'): edges.append(record)
            if record.name.endswith('surface'):
                if record.name!='plane-surface': raise ValueError('region-nonplanar-surface:'+record.name)
                data=geometry(record);planes.append((vector(data),vector(data[3:])))
            queue.extend(refs(record))
        if not planes: raise ValueError('region-planarity-not-declared')
        origin,normal=planes[0]
        if normal.magnitude<1e-12: raise ValueError('region-plane-normal-invalid')
        normal=normal.normalize()
        for p,n in planes:
            if n.magnitude<1e-12 or abs(abs(normal.dot(n.normalize()))-1)>1e-8 or abs((p-origin).dot(normal))>1e-7:
                raise ValueError('region-surfaces-not-coplanar')
        for edge in edges:
            key=(id(edge),tuple(matrix))
            if key in emitted: continue
            leaf=edge_entity(edge)
            kind=leaf.dxftype()
            controls=([leaf.dxf.start,leaf.dxf.end] if kind=='LINE' else list(leaf.control_points) if kind=='SPLINE'
                      else [leaf.dxf.center,leaf.dxf.center+leaf.dxf.major_axis])
            if any(abs((Vec3(p)-origin).dot(normal))>max(1,(Vec3(p)-origin).magnitude)*1e-7 for p in controls):
                raise ValueError('region-edge-outside-declared-plane')
            if kind=='ELLIPSE' and abs(abs(Vec3(leaf.dxf.extrusion).normalize().dot(normal))-1)>1e-8:
                raise ValueError('region-ellipse-outside-declared-plane')
            leaf.transform(matrix)
            for name,val in entity.graphic_properties().items(): leaf.dxf.set(name,val)
            pending.append(leaf);emitted.add(key)
    all_edges={id(r) for r in builder.entities if r.name.endswith('edge') and not r.name.endswith('coedge')}
    if not pending or all_edges-{key[0] for key in emitted}: raise ValueError('region-unreachable-or-empty-boundaries')
    yield from pending
