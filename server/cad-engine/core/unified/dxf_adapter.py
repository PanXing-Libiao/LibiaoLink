"""DXF -> UCD 2.0 Drawing adapter over a pinned ezdxf build.

Scope: real DXF files are parsed by ezdxf 1.4.2 (no hand-written DXF decoder) and
mapped to the existing UCD 2.0 Drawing tables. Source coordinates, handles,
spaces, layers and block identities are preserved; display polylines are a
separate artifact (Representation kind "drawing") and are never treated as the
source curve. Unsupported source entities become UnsupportedEntity records with
a reason instead of guessed geometry.

Known 2.0 contract gap (reported, not silently changed): EntityStyle can carry a
BYLAYER/BYBLOCK mode only for color. Unresolved line type/line weight modes are
recorded in document.extensions["org.cad-preview.dxf/1"].styleModes and are
resolved per instance by the ViewerProjection. Core field meanings are unchanged.
"""
import hashlib
import json
import math
import struct
import time
from collections import Counter
from pathlib import Path

from .adapter import IDENTITY, identity, digest, unknown
from .dxf_fill import (boundary_paths, hatch_style, hatch_style_name, is_gradient_hatch,
                       is_solid_hatch,
                       solid_polygon, triangulate)
from .migrate import seal
from .payload_sink import Base64Sink
from .validation import validate_binary_envelope, validate_envelope
from . import stageprof

ENGINE = '1.4.2'
# Measured: schema validation costs ~0.9 ms per source record, so 20k records stay
# well inside the 60 s worker budget. Larger files fail with a clean limit error
# instead of hitting the timeout.
MAX_ENTITIES = 20000
MAX_PROJECTION_DRAWS = 400000
# Display discretisation is a viewer artifact; these bounds only cap the artifact.
RELATIVE_TOLERANCE = 1e-3
MAX_ANGULAR_STEP = math.radians(6.0)
MAX_CURVE_SEGMENTS = 4096
DEFAULT_LINE_WEIGHT_MM = 0.25
RELEASE = {'AC1009': 'R12', 'AC1012': 'R13', 'AC1014': 'R14', 'AC1015': 'R2000',
           'AC1018': 'R2004', 'AC1021': 'R2007', 'AC1024': 'R2010', 'AC1027': 'R2013',
           'AC1032': 'R2018'}
UNITS = {0: (None, 'unitless'), 1: ('inch', 'inches'), 2: ('foot', 'feet'),
         4: ('mm', 'millimetres'), 5: ('cm', 'centimetres'), 6: ('m', 'metres'),
         7: ('km', 'kilometres'), 8: ('micrometre', 'microinches'),
         9: ('mm', 'mils'), 10: ('m', 'yards'), 11: ('unknown', 'angstroms'),
         12: ('unknown', 'nanometres'), 13: ('micrometre', 'microns'),
         14: ('m', 'decimetres'), 15: ('m', 'decametres'), 16: ('m', 'hectometres'),
         17: ('unknown', 'gigametres'), 18: ('unknown', 'astronomical units'),
         19: ('unknown', 'light years'), 20: ('unknown', 'parsecs')}
CORE_ENTITIES = ('LINE', 'POINT', 'CIRCLE', 'ARC', 'LWPOLYLINE', 'POLYLINE',
                 'ELLIPSE', 'SPLINE')
ANNOTATION_ENTITIES = ('TEXT', 'MTEXT', 'DIMENSION', 'ATTDEF', 'ATTRIB')
# Filled entities map to a typed Hatch geometry; their exact boundary is carried as
# derived polyline entities plus extensions["org.cad-preview.fill/1"].
FILL_ENTITIES = ('SOLID', 'HATCH')
UNSUPPORTED_REASONS = {
    'TRACE': 'filled trace is not implemented (SOLID and solid HATCH are)',
    '3DFACE': 'filled 3D face is outside the 2D drawing contract',
    'MLINE': 'MLINE complex line geometry is not mapped',
    'LEADER': 'leader vertex/text association is not reconstructed',
    'MULTILEADER': 'MLEADER content and style are not reconstructed',
    'TOLERANCE': 'tolerance frame semantics are not reconstructed',
    'ACAD_TABLE': 'table content and cell formatting are not reconstructed',
    'WIPEOUT': 'wipeout raster mask is not mapped',
    'IMAGE': 'raster image requires an upload resource resolver',
    'PDFUNDERLAY': 'PDF underlay requires an upload resource resolver',
    'DGNUNDERLAY': 'DGN underlay requires an upload resource resolver',
    'DWFUNDERLAY': 'DWF underlay requires an upload resource resolver',
    'XLINE': 'infinite construction line cannot be clipped without guessing',
    'RAY': 'infinite ray cannot be clipped without guessing',
    'MESH': 'subdivision mesh is outside the 2D drawing contract',
    '3DSOLID': 'ACIS solid is outside the 2D drawing contract',
    'REGION': 'ACIS region is outside the 2D drawing contract',
    'BODY': 'ACIS body is outside the 2D drawing contract',
    'SURFACE': 'procedural surface is outside the 2D drawing contract',
    'HELIX': 'helix is outside the 2D drawing contract',
    'SHAPE': 'SHAPE uses an external SHX glyph that is not resolvable here',
    'OLE2FRAME': 'OLE frame is not mapped',
    'PROXYENTITY': 'proxy entity has no decoded geometry',
}


def _finite(value, fallback=0.0):
    return float(value) if math.isfinite(float(value)) else fallback


def _v3(point):
    return [_finite(point[0]), _finite(point[1]), _finite(point[2] if len(point) > 2 else 0.0)]


def mat_identity():
    return list(IDENTITY)


def mat_mul(a, b):
    out = [0.0] * 16
    for c in range(4):
        for r in range(4):
            out[c * 4 + r] = sum(a[k * 4 + r] * b[c * 4 + k] for k in range(4))
    return out


def mat_translate(x, y, z=0.0):
    m = list(IDENTITY)
    m[12], m[13], m[14] = x, y, z
    return m


def flatten(matrix44):
    """ezdxf Matrix44 -> column-major affine used by UCD."""
    return [float(matrix44.get_row(r)[c]) for r in range(4) for c in range(4)]


def ocs_matrix(entity):
    ocs = getattr(entity, 'ocs', lambda: None)()
    if ocs is None or not getattr(ocs, 'transform', False):
        return mat_identity()
    return flatten(ocs.matrix)


def _segments_for_arc(sweep, radius):
    sweep = abs(sweep)
    if sweep <= 1e-12:
        return 1
    if radius <= 0:
        return 1
    tolerance = max(radius * RELATIVE_TOLERANCE, 1e-9)
    step = 2.0 * math.acos(max(-1.0, min(1.0, 1.0 - tolerance / radius)))
    step = min(step, MAX_ANGULAR_STEP)
    if step <= 1e-9:
        step = MAX_ANGULAR_STEP
    return max(1, min(MAX_CURVE_SEGMENTS, int(math.ceil(sweep / step))))


def arc_points(center, ux, uy, radius, start, sweep):
    n = _segments_for_arc(sweep, radius)
    cx, cy, cz = center
    ax, ay, az = ux
    bx, by, bz = uy
    points = []
    for i in range(n + 1):
        t = start + sweep * i / n
        ct, st = math.cos(t), math.sin(t)
        points.append([cx + ax * radius * ct + bx * radius * st,
                       cy + ay * radius * ct + by * radius * st,
                       cz + az * radius * ct + bz * radius * st])
    return points


def ellipse_points(center, major, minor, start, sweep):
    radius = max(math.hypot(*major), 1e-9)
    n = _segments_for_arc(sweep, radius)
    cx, cy, cz = center
    ax, ay, az = major
    bx, by, bz = minor
    points = []
    for i in range(n + 1):
        t = start + sweep * i / n
        ct, st = math.cos(t), math.sin(t)
        points.append([cx + ax * ct + bx * st, cy + ay * ct + by * st, cz + az * ct + bz * st])
    return points


def bulge_points(p1, p2, bulge, z):
    """DXF bulge segment -> arc polyline; bulge = tan(included_angle/4)."""
    if abs(bulge) <= 1e-12:
        return [[p1[0], p1[1], z], [p2[0], p2[1], z]], 1
    dx, dy = p2[0] - p1[0], p2[1] - p1[1]
    chord = math.hypot(dx, dy)
    if chord <= 1e-12:
        return [[p1[0], p1[1], z], [p2[0], p2[1], z]], 1
    sweep = 4.0 * math.atan(bulge)
    mx, my = (p1[0] + p2[0]) / 2.0, (p1[1] + p2[1]) / 2.0
    offset = chord / (2.0 * math.tan(sweep / 2.0)) if abs(math.tan(sweep / 2.0)) > 1e-12 else 0.0
    nx, ny = -dy / chord, dx / chord
    cx, cy = mx + nx * offset, my + ny * offset
    radius = math.hypot(p1[0] - cx, p1[1] - cy)
    start = math.atan2(p1[1] - cy, p1[0] - cx)
    points = arc_points((cx, cy, z), (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), radius, start, sweep)
    return points, len(points) - 1


def _spline_points(control_points, knots, weights, degree, periodic):
    from ezdxf.math import BSpline
    spline = BSpline(control_points, order=degree + 1, knots=knots, weights=weights)
    count = min(MAX_CURVE_SEGMENTS, max(16, len(control_points) * 16))
    return [[float(p[0]), float(p[1]), float(p[2] if len(p) > 2 else 0.0)] for p in spline.approximate(count)]


def _bbox(points):
    low = [math.inf] * 3
    high = [-math.inf] * 3
    for point in points:
        for i in range(3):
            low[i] = min(low[i], point[i])
            high[i] = max(high[i], point[i])
    return {'min': low, 'max': high}


def _aci_rgba(aci):
    from ezdxf import colors
    if aci in (0, 256) or aci is None:
        return None
    if not 0 <= int(aci) <= 255:
        return None
    if int(aci) == 7:
        # ACI 7 is the context-dependent black/white ink; this viewer always draws on
        # a white sheet, so it resolves to black. True color values are never rewritten.
        return [0.0, 0.0, 0.0, 1.0]
    color = colors.aci2rgb(int(aci))
    return [round(color.r / 255.0, 9), round(color.g / 255.0, 9), round(color.b / 255.0, 9), 1.0]


def _layer_rgba(layer):
    rgba = _aci_rgba(layer.dxf.get('color', 7))
    if rgba is None:
        true_color = layer.dxf.get('true_color', None)
        if true_color is not None:
            rgba = [(true_color >> 16 & 255) / 255.0, (true_color >> 8 & 255) / 255.0, (true_color & 255) / 255.0, 1.0]
        else:
            rgba = [1.0, 1.0, 1.0, 1.0]
    return rgba


def _entity_rgba(entity):
    try:
        rgb = entity.rgb
    except Exception:
        rgb = None
    if rgb is not None:
        if not entity.dxf.hasattr('true_color') and entity.dxf.get('color', 256) == 7:
            return [0.0, 0.0, 0.0, 1.0]
        return [round(rgb.r / 255.0, 9), round(rgb.g / 255.0, 9), round(rgb.b / 255.0, 9), 1.0]
    return None


def _lineweight_fact(millimetres, knowledge='source-declared', evidence=('dxf-spec',)):
    return {'value': round(float(millimetres), 4), 'knowledge': knowledge,
            'validation': 'experimental', 'evidenceIds': list(evidence)}


def paper_space_details(m, viewport_details):
    """Explain every DXF VIEWPORT record, including the ones that are not projections.

    A paper space layout always carries one container VIEWPORT (dxf id 1) that only
    defines the paper area; it is not a view into model space. Reporting the records,
    their handles, layout ownership and projected status prevents "4 viewports but 3
    projected" from looking like data loss.
    """
    layouts = []
    for lid, layout in m['layouts'].items():
        layouts.append({'id': lid, 'name': layout['name'],
                        'viewportIds': sorted(layout['viewportIds']),
                        'sheetId': layout.get('sheetId')})
    projected = [d for d in viewport_details if d.get('projected')]
    enabled = [d for d in projected if d.get('enabled')]
    containers = [d for d in viewport_details if d.get('status') == 'paper-container']
    return {
        'layoutCount': len(layouts),
        'layouts': sorted(layouts, key=lambda row: row['name']),
        # Three explicit counts, so "4 viewports" cannot be confused with "4 projections":
        # every VIEWPORT record, the records that project model space, and the enabled ones.
        'viewportRecords': len(viewport_details),
        'modelViewports': len(projected),
        'enabledModelViewports': len(enabled),
        'paperContainerViewports': len(containers),
        'viewportsProjected': len(projected),
        'viewportsSkipped': [d['handle'] for d in viewport_details if not d.get('projected')],
        'viewports': sorted(viewport_details, key=lambda row: (row['layoutName'], str(row['handle']))),
        'note': 'DXF VIEWPORT records include one paper-container viewport per layout (dxf id 1); '
                'only viewports with a model projection appear in drawing.viewports; a projected '
                'viewport can still be disabled (status 0), in which case it is registered but '
                'emits no draws.',
    }


def read_dxf(path, raw, sink=None, name=None):
    """Parse a real DXF file and return a validated UCD 2.0 envelope."""
    sink = sink or Base64Sink()
    import ezdxf
    if ezdxf.__version__ != ENGINE:
        raise ValueError('DXF requires ezdxf==' + ENGINE + ' (found ' + ezdxf.__version__ + ')')
    if not raw or len(raw) > 64 * 1024 * 1024:
        raise ValueError('DXF input must be 1 byte to 64 MiB')
    from . import worker_trace
    worker_trace.mark('runtimeReady');worker_trace.mark('parseStart')
    started = time.perf_counter()
    sha = hashlib.sha256(raw).hexdigest()
    sid = 'source-' + sha
    drawing_id = 'drawing-' + sha
    stageprof.mark('dxf.read-start', bytes=len(raw))
    doc = ezdxf.readfile(str(path))
    stageprof.mark('dxf.parse', seconds=round(time.perf_counter() - started, 4))
    code = doc.dxfversion
    if code not in RELEASE:
        raise ValueError('unsupported-dxf-version: ' + str(code))
    name = name or Path(path).name

    evidence = [
        {'id': 'dxf-spec', 'kind': 'standard',
         'reference': 'Autodesk DXF Reference (group codes, entity and table definitions)',
         'scope': 'Format vocabulary for parsing/mapping; no site-specific behavior'},
        {'id': 'ezdxf', 'kind': 'official', 'reference': 'ezdxf ' + ENGINE, 'version': ENGINE,
         'scope': 'Pinned open-source DXF reader/writer API used for parsing and spline evaluation'},
        {'id': 'policy', 'kind': 'engineering-contract', 'reference': 'unified/dxf_adapter.py',
         'scope': 'OCS/insert transforms, unit declaration, display tessellation and viewer policy'},
        {'id': 'view-policy', 'kind': 'engineering-contract', 'reference': 'unified/dxf_adapter.py',
         'scope': 'System viewing context; DXF has no CAD configurations'},
    ]

    tables = ['drawings', 'spaces', 'sheets', 'layouts', 'viewports', 'entities',
              'annotations', 'blocks', 'blockInstances', 'layers', 'lineTypes',
              'textStyles', 'plotStyles', 'hatchPatterns']
    d = {'schemaVersion': '2.0.0', 'serializationProfile': 'ucd-json-python-sorted/1',
         'documentId': 'document-' + sha, 'revision': '0' * 64,
         'sources': [{'id': sid, 'name': name, 'sha256': sha, 'byteLength': len(raw),
                      'format': 'DXF', 'detectedVersion': code}],
         'adapter': {'id': 'ezdxf-dxf', 'version': '0.1.0',
                     'implementationHash': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                     'ruleSetHash': digest({'ezdxf': ENGINE, 'tolerance': RELATIVE_TOLERANCE,
                                            'maxAngularStep': MAX_ANGULAR_STEP,
                                            'maxCurveSegments': MAX_CURVE_SEGMENTS}),
                     'dependencies': [{'name': 'ezdxf', 'version': ENGINE}]},
         'coordinates': None, 'products': {}, 'productOccurrences': {}, 'productRoots': [],
         'sceneOccurrences': {}, 'renderOwnership': {}, 'representations': {},
         'geometries': {}, 'accessors': {}, 'buffers': {}, 'resources': {},
         'materials': {}, 'configurations': [], 'displayStates': [],
         'viewContexts': [{'id': 'view-default', 'origin': 'system-default',
                           'name': 'DXF drawing', 'sourceContextKey': 'dxf/drawing'}],
         'defaultSelection': {'value': {'viewContextId': 'view-default'},
                              'knowledge': 'engineering-defined', 'validation': 'experimental',
                              'evidenceIds': ['view-policy']},
         'properties': {}, 'externalReferences': [],
         'capabilities': [], 'diagnostics': [], 'evidence': evidence,
         'drawing': {key: {} for key in tables},
         'extensions': {}, 'extensionsRequired': []}

    insunits = doc.header.get('$INSUNITS', 0) or 0
    unit, unit_label = UNITS.get(int(insunits), (None, 'unknown'))
    if unit and unit != 'unknown':
        unit_fact = {'value': unit, 'knowledge': 'source-declared', 'validation': 'experimental',
                     'evidenceIds': ['dxf-spec']}
        coordinates_space = 'metric' if unit in ('mm', 'cm', 'm', 'micrometre') else 'source-unknown'
        reason = 'Declared by DXF header $INSUNITS=' + str(insunits) + ' (' + unit_label + '); no unit conversion applied'
    else:
        unit_fact = unknown()
        coordinates_space = 'source-unknown'
        reason = 'DXF header $INSUNITS is ' + str(insunits) + ' (unitless/unknown); no unit inferred'
    d['coordinates'] = {'space': coordinates_space, 'lengthUnit': unit_fact,
                        'handedness': {'value': 'right', 'knowledge': 'standard-confirmed',
                                       'validation': 'verified-scope', 'evidenceIds': ['dxf-spec']},
                        'upAxis': {'value': '+Z', 'knowledge': 'standard-confirmed',
                                   'validation': 'verified-scope', 'evidenceIds': ['dxf-spec']},
                        'sourceToDocument': mat_identity(), 'conversionReason': reason}

    ltscale = float(doc.header.get('$LTSCALE', 1.0) or 1.0)
    m = d['drawing']
    m['drawings'][drawing_id] = {'id': drawing_id, 'name': Path(name).stem,
                                 'sourceIds': [sid], 'modelSpaceId': '', 'sheetIds': [],
                                 'layoutIds': [], 'layerIds': [], 'units': unit_fact}

    # ----- line types / layers / text styles ---------------------------------
    line_type_ids = {}
    complex_line_types = []
    for lt in doc.linetypes:
        ltname = lt.dxf.name
        if ltname.upper() in ('BYLAYER', 'BYBLOCK'):
            continue
        ltid = identity('linetype', [ltname])
        line_type_ids[ltname.upper()] = ltid
        segments = []
        try:
            tags = list(lt.pattern_tags.tags)
        except Exception:
            tags = []
        complex_flag = False
        for tag in tags:
            if tag.code == 49:
                value = float(tag.value) * ltscale
                if value > 1e-12:
                    segments.append({'kind': 'dash', 'length': round(value, 6)})
                elif value < -1e-12:
                    segments.append({'kind': 'gap', 'length': round(-value, 6)})
                else:
                    segments.append({'kind': 'dot', 'length': 0.0})
            elif tag.code in (74, 75) and tag.value not in (0, None):
                complex_flag = True
        if complex_flag:
            complex_line_types.append(ltname)
        m['lineTypes'][ltid] = {'id': ltid, 'name': ltname, 'segments': segments,
                                'unit': 'source-units (pattern lengths x $LTSCALE=' + str(ltscale) + ')'}

    layer_ids = {}
    for layer in doc.layers:
        lname = layer.dxf.name
        lid = identity('layer', [sha, lname])
        layer_ids[lname] = lid
        style = {'color': {'mode': 'explicit', 'rgba': _layer_rgba(layer)},
                 'plot': bool(layer.dxf.get('plot', 1))}
        ltype = layer.dxf.get('linetype', 'Continuous')
        if ltype and ltype.upper() in line_type_ids:
            style['lineTypeId'] = line_type_ids[ltype.upper()]
        lw = layer.dxf.get('lineweight', -3)
        if 0 <= lw <= 211:
            style['lineWeight'] = _lineweight_fact(lw / 100.0)
        m['layers'][lid] = {'id': lid, 'drawingId': drawing_id, 'name': lname,
                            'visible': not layer.is_off(), 'frozen': layer.is_frozen(),
                            'lockedForEditing': layer.is_locked(),
                            'plot': bool(layer.dxf.get('plot', 1)), 'defaultStyle': style,
                            'sourceRefs': [{'sourceId': sid, 'objectKey': layer.dxf.handle,
                                            'path': 'DXF/LAYER/' + lname}]}
        m['drawings'][drawing_id]['layerIds'].append(lid)

    font_resources = {}
    for style in doc.styles:
        sname = style.dxf.name
        font = style.dxf.get('font', 'txt') or 'txt'
        if font not in font_resources:
            rid = identity('font', [font])
            font_resources[font] = rid
            d['resources'][rid] = {'id': rid, 'sha256': hashlib.sha256(font.encode()).hexdigest(),
                                   'byteLength': 0, 'mediaType': 'application/x-cad-font-name',
                                   'role': 'font', 'resourceId': font}
        tsid = identity('textstyle', [sha, sname])
        m['textStyles'][tsid] = {'id': tsid, 'name': sname,
                                 'fontResourceId': font_resources[font],
                                 'height': float(style.dxf.get('height', 0.0) or 0.0),
                                 'widthFactor': float(style.dxf.get('width', 1.0) or 1.0),
                                 'obliqueAngle': float(style.dxf.get('oblique', 0.0) or 0.0)}
    text_style_ids = {style.dxf.name: identity('textstyle', [sha, style.dxf.name]) for style in doc.styles}

    # ----- blocks, spaces and layouts ----------------------------------------
    layout_block_names = set()
    for layout in doc.layouts:
        try:
            layout_block_names.add(layout.block_record_name)
        except Exception:
            pass
    for block_layout in doc.blocks:
        block_name = block_layout.name
        if block_name in layout_block_names or block_name in ('*Model_Space', '*Paper_Space') or block_name.startswith('*Paper_Space'):
            layout_block_names.add(block_name)
    block_layout_names = {b.name for b in doc.blocks if b.name not in layout_block_names}

    block_ids = {}
    block_space_ids = {}
    block_handles = {}
    for block_layout in doc.blocks:
        bname = block_layout.name
        if bname in layout_block_names:
            continue
        bid = identity('block', [sha, bname])
        spid = identity('space', [sha, 'block', bname])
        block_ids[bname] = bid
        block_space_ids[bname] = spid
        block = block_layout.block
        base = _v3(block.dxf.get('base_point', (0, 0, 0)))
        bdef = {'id': bid, 'drawingId': drawing_id, 'name': bname, 'spaceId': spid,
                'basePoint': base, 'units': unit_fact, 'dynamicParameters': {}}
        block_handles[bname] = block.dxf.handle
        xref = block.dxf.get('xref_path', None)
        if xref:
            bdef['externalReferenceId'] = 'xref-' + hashlib.sha256(xref.encode()).hexdigest()[:32]
            d['externalReferences'].append({'id': bdef['externalReferenceId'], 'kind': 'external-file',
                                            'reference': xref, 'sourceRefs': [{'sourceId': sid}],
                                            'resolved': False, 'reason': 'external reference not uploaded'})
        m['blocks'][bid] = bdef
        m['spaces'][spid] = {'id': spid, 'drawingId': drawing_id, 'kind': 'block',
                             'ownerId': bid, 'entityIds': [], 'annotationIds': [],
                             'blockInstanceIds': []}

    model_space_id = identity('space', [sha, 'model', 'Model'])
    m['drawings'][drawing_id]['modelSpaceId'] = model_space_id
    m['spaces'][model_space_id] = {'id': model_space_id, 'drawingId': drawing_id, 'kind': 'model',
                                   'ownerId': drawing_id, 'entityIds': [], 'annotationIds': [],
                                   'blockInstanceIds': []}

    layout_ids = {}
    paper_space_ids = {}
    paper_layouts = []
    for layout in doc.layouts:
        if layout.is_modelspace:
            continue
        lname = layout.name
        lid = identity('layout', [sha, lname])
        spid = identity('space', [sha, 'paper', lname])
        layout_ids[lname] = lid
        paper_space_ids[lname] = spid
        paper_layouts.append((layout, lid, spid))
        m['layouts'][lid] = {'id': lid, 'drawingId': drawing_id, 'name': lname,
                             'paperSpaceId': spid, 'viewportIds': [],
                             'paperToSheet': mat_identity()}
        m['spaces'][spid] = {'id': spid, 'drawingId': drawing_id, 'kind': 'paper',
                             'ownerId': lid, 'entityIds': [], 'annotationIds': [],
                             'blockInstanceIds': []}
        m['drawings'][drawing_id]['layoutIds'].append(lid)

    # ----- display representation builder ------------------------------------
    class Display:
        def __init__(self):
            self.positions = bytearray()
            self.indices = bytearray()
            self.records = {}

        def add(self, item_id, points, segments, topology, source_refs):
            if topology == 'points':
                points = points[:1]
            if not points:
                return None
            base = len(self.positions) // 8
            for point in points:
                self.positions += struct.pack('<3d', float(point[0]), float(point[1]), float(point[2]))
            count = len(points)
            if topology == 'points':
                index_offset = None
                index_count = 1
            else:
                index_offset = len(self.indices) // 4
                index_count = 0
                for a, b in segments:
                    # Accessor-relative indices: the validator resolves indices inside
                    # the bound POSITION accessor, not inside the shared buffer.
                    self.indices += struct.pack('<2I', a, b)
                    index_count += 2
            gid = identity('geometry', [item_id])
            rid = identity('representation', [item_id])
            self.records[item_id] = {'geometryId': gid, 'representationId': rid,
                                     'positionOffset': len(self.positions) - count * 24,
                                     'positionCount': count, 'indexOffset': index_offset,
                                     'indexCount': index_count, 'topology': topology,
                                     'bounds': _bbox(points), 'sourceRefs': source_refs}
            return rid

        def add_fill(self, item_id, points, triangles, source_refs):
            """Filled drawing representation: triangle indices, no line primitive."""
            if not points or not triangles:
                return None
            base = len(self.positions) // 8
            for point in points:
                self.positions += struct.pack('<3d', float(point[0]), float(point[1]), float(point[2]))
            index_offset = len(self.indices) // 4
            for triangle in triangles:
                self.indices += struct.pack('<3I', int(triangle[0]), int(triangle[1]), int(triangle[2]))
            count = len(points)
            gid = identity('geometry', [item_id])
            rid = identity('representation', [item_id])
            self.records[item_id] = {'geometryId': gid, 'representationId': rid,
                                     'positionOffset': len(self.positions) - count * 24,
                                     'positionCount': count, 'indexOffset': index_offset,
                                     'indexCount': len(triangles) * 3, 'topology': 'triangles',
                                     'bounds': _bbox(points), 'sourceRefs': source_refs}
            return rid

        def commit(self, document, sink):
            if not self.records:
                return
            position_blob = bytes(self.positions)
            index_blob = bytes(self.indices)
            position_id = 'buffer-' + hashlib.sha256(position_blob).hexdigest()
            document['buffers'][position_id] = {'id': position_id,
                                                'sha256': hashlib.sha256(position_blob).hexdigest(),
                                                'byteLength': len(position_blob), 'endianness': 'little',
                                                'alignment': 8, 'storage': {'kind': 'resource', 'resourceId': position_id}}
            sink.put(position_id, position_blob)
            index_id = None
            if index_blob:
                index_id = 'buffer-' + hashlib.sha256(index_blob).hexdigest()
                document['buffers'][index_id] = {'id': index_id,
                                                 'sha256': hashlib.sha256(index_blob).hexdigest(),
                                                 'byteLength': len(index_blob), 'endianness': 'little',
                                                 'alignment': 4, 'storage': {'kind': 'resource', 'resourceId': index_id}}
                sink.put(index_id, index_blob)
            for item_id, rec in self.records.items():
                accessor = {'bufferId': position_id, 'byteOffset': rec['positionOffset'],
                            'byteLength': rec['positionCount'] * 24, 'component': 'f64',
                            'components': 3, 'count': rec['positionCount'], 'normalized': False}
                position_accessor = identity('accessor', accessor)
                document['accessors'][position_accessor] = accessor
                primitive = {'id': 'primitive-0', 'topology': rec['topology'],
                             'range': {'first': 0, 'count': rec['indexCount']}}
                if rec['topology'] in ('lines', 'triangles') and rec['indexOffset'] is not None:
                    ia = {'bufferId': index_id, 'byteOffset': rec['indexOffset'] * 4,
                          'byteLength': rec['indexCount'] * 4, 'component': 'u32',
                          'components': 1, 'count': rec['indexCount'], 'normalized': False}
                    index_accessor = identity('accessor', ia)
                    document['accessors'][index_accessor] = ia
                    primitive['indices'] = index_accessor
                document['geometries'][rec['geometryId']] = {
                    'id': rec['geometryId'], 'coordinateSpace': 'geometry-local',
                    'attributes': {'POSITION': position_accessor}, 'primitives': [primitive],
                    'bounds': rec['bounds'], 'normalOrigin': 'absent',
                    'sourceRefs': rec['sourceRefs']}
                document['representations'][rec['representationId']] = {
                    'id': rec['representationId'], 'kind': 'drawing',
                    'bindings': [{'id': 'binding-0', 'geometryId': rec['geometryId'],
                                  'localFromRepresentation': mat_identity(), 'materialSlots': {}}],
                    'sourceRefs': rec['sourceRefs']}

    display = Display()

    # ----- entity mapping -----------------------------------------------------
    counts = Counter()
    unsupported = Counter()
    partial = Counter()
    losses = []
    style_modes = {}
    annotation_styles = {}
    entity_flags = {}
    dimensions_with_geometry = 0
    dimensions_without_geometry = 0
    display_ok = Counter()
    display_missing = Counter()

    def source_ref(space_key, handle, index):
        return {'sourceId': sid, 'objectKey': str(handle),
                'path': 'DXF/' + space_key + '/' + str(handle), 'recordOffset': int(index)}

    def source_style(entity, layer_name):
        color_mode = entity.dxf.get('color', 256)
        rgba = _entity_rgba(entity)
        if rgba is not None:
            color = {'mode': 'explicit', 'rgba': rgba}
        elif color_mode == 0:
            color = {'mode': 'by-block'}
        elif color_mode == 256:
            color = {'mode': 'by-layer'}
        else:
            converted = _aci_rgba(color_mode)
            color = {'mode': 'explicit', 'rgba': converted} if converted else {'mode': 'unknown'}
        layer_row = m['layers'].get(layer_ids.get(layer_name, ''))
        style = {'color': color, 'plot': bool(layer_row['plot']) if layer_row else True}
        ltype = entity.dxf.get('linetype', 'BYLAYER')
        if ltype and ltype.upper() not in ('BYLAYER', 'BYBLOCK'):
            tid = line_type_ids.get(ltype.upper())
            if tid:
                style['lineTypeId'] = tid
        lw = entity.dxf.get('lineweight', -1)
        if 0 <= lw <= 211:
            style['lineWeight'] = _lineweight_fact(lw / 100.0)
        return style

    def record_style_modes(item_id, entity):
        mode = {}
        ltype = (entity.dxf.get('linetype', 'BYLAYER') or 'BYLAYER').upper()
        if ltype == 'BYLAYER':
            mode['lineType'] = 'by-layer'
        elif ltype == 'BYBLOCK':
            mode['lineType'] = 'by-block'
        lw = entity.dxf.get('lineweight', -1)
        if lw == -1:
            mode['lineWeight'] = 'by-layer'
        elif lw == -2:
            mode['lineWeight'] = 'by-block'
        elif lw == -3:
            mode['lineWeight'] = 'default'
        if mode:
            style_modes[item_id] = mode
        if entity.dxf.get('invisible', 0) == 1:
            entity_flags[item_id] = {'invisible': True}
        transparency = entity.dxf.get('transparency', None)
        if transparency is not None:
            entity_flags.setdefault(item_id, {})['transparency'] = float(transparency)

    # ----- filled entities (SOLID / solid HATCH) -----------------------------
    # UCD 2.0 Hatch can only reference boundary *entities*, not inline paths. The
    # adapter therefore keeps the source boundary as derived polyline entities in an
    # uninstantiated block space (no draw is emitted for them) and stores the exact
    # analytic boundary in extensions["org.cad-preview.fill/1"]. Entity.geometry stays
    # a typed Hatch; display triangles are a separate representation.
    boundary_block = {'blockId': None, 'spaceId': None, 'name': None}
    fill_registry = {}
    fill_skips = []

    def ensure_boundary_space():
        if boundary_block['blockId'] is None:
            block_id = identity('block', [sha, 'fill-boundary-block'])
            space_id = identity('space', [sha, 'fill-boundary-space'])
            # The derived block must never shadow a source block with the same name.
            existing = {b['name'] for b in m['blocks'].values()}
            name = '*FillBoundary'
            suffix = 1
            while name in existing:
                name = '*FillBoundary~%d' % suffix
                suffix += 1
            m['blocks'][block_id] = {
                'id': block_id, 'drawingId': drawing_id, 'name': name,
                'spaceId': space_id, 'basePoint': [0.0, 0.0, 0.0],
                'units': m['drawings'][drawing_id]['units'], 'dynamicParameters': {}}
            m['spaces'][space_id] = {
                'id': space_id, 'drawingId': drawing_id, 'kind': 'block', 'ownerId': block_id,
                'entityIds': [], 'annotationIds': [], 'blockInstanceIds': []}
            boundary_block.update({'blockId': block_id, 'spaceId': space_id, 'name': name})
        return boundary_block

    def add_boundary_entity(entity, ref, layer_id, style, path_index, points, bulges):
        space = ensure_boundary_space()
        boundary_id = identity('entity', [sha, 'fill-boundary', str(entity.dxf.handle), str(path_index)])
        boundary_style = dict(style)
        boundary_style['plot'] = False
        m['entities'][boundary_id] = {
            'id': boundary_id, 'drawingId': drawing_id, 'ownerSpaceId': space['spaceId'],
            'layerId': layer_id, 'localFromOwner': mat_identity(),
            'geometry': {'type': 'polyline',
                         'points': [[float(p[0]), float(p[1]), float(p[2])] for p in points],
                         'closed': True, 'bulges': [float(b) for b in bulges]},
            'style': boundary_style, 'sourceRefs': [ref], 'displayOrder': 0}
        m['spaces'][space['spaceId']]['entityIds'].append(boundary_id)
        return boundary_id

    def build_fill(entity, layer_id, style, ref):
        kind = entity.dxftype()
        skipped_textbox = 0
        style_code = 0
        pattern_name = ''
        if kind == 'HATCH':
            if is_gradient_hatch(entity):
                raise ValueError('gradient-fill-unsupported')
            if not is_solid_hatch(entity):
                raise ValueError('pattern-fill-unsupported')
            style_code = hatch_style(entity)
            pattern_name = str(entity.dxf.get('pattern_name', '') or '')
            # 0 odd parity (even-odd), 1 outer, 2 ignore. Styles 1/2 select their
            # boundary paths by group-92 flags inside boundary_paths(); a multipath
            # hatch with no EXTERNAL/OUTERMOST selection is refused there.
            if style_code not in (0, 1, 2):
                raise ValueError('hatch-style-unsupported:%d' % style_code)
            rings, skipped_textbox = boundary_paths(entity)
        else:
            polygon = solid_polygon(entity)
            rings = [{'points': polygon['points'], 'points2d': polygon['points2d'],
                      'bulges': [0.0] * len(polygon['points']),
                      'analytic': {'type': 'solid-polygon'}, 'flags': 0}]
        points, triangles = triangulate(rings)
        ids = []
        boundaries = []
        for index, ring in enumerate(rings):
            ids.append(add_boundary_entity(entity, ref, layer_id, style, index,
                                           ring['points'], ring['bulges']))
            boundaries.append({'entityId': ids[index], 'pathTypeFlags': ring['flags'],
                               'analytic': ring['analytic']})
        return {'geometry': {'type': 'hatch', 'boundaryEntityIds': ids, 'fillRule': 'even-odd'},
                'points': points, 'triangles': triangles,
                'record': {'sourceKind': kind,
                           'hatchStyle': style_code,
                           'hatchStyleName': hatch_style_name(style_code) if kind == 'HATCH' else None,
                           'patternName': pattern_name if kind == 'HATCH' else None,
                           'fillRule': 'even-odd', 'solid': True,
                           'textboxPathsSkipped': skipped_textbox,
                           'boundaryEntityIds': ids, 'boundaries': boundaries,
                           'triangleCount': len(triangles)}}

    def tessellate_entity(entity):
        """Return (geometry dict, display points, segments, topology, localFromOwner)."""
        kind = entity.dxftype()
        if kind == 'LINE':
            start, end = _v3(entity.dxf.start), _v3(entity.dxf.end)
            return ({'type': 'line', 'start': start, 'end': end},
                    [start, end], [(0, 1)], 'lines', mat_identity())
        if kind == 'POINT':
            position = _v3(entity.dxf.location)
            return ({'type': 'point', 'position': position}, [position], [], 'points', mat_identity())
        if kind == 'CIRCLE':
            center = _v3(entity.dxf.center)
            radius = _finite(entity.dxf.radius)
            if radius <= 0:
                raise ValueError('non-positive radius')
            points = arc_points(center, (1, 0, 0), (0, 1, 0), radius, 0.0, 2.0 * math.pi)
            geometry = {'type': 'arc', 'center': center, 'normal': [0.0, 0.0, 1.0],
                        'xAxis': [1.0, 0.0, 0.0], 'radius': radius,
                        'startAngle': 0.0, 'sweepAngle': 2.0 * math.pi}
            return geometry, points, [(i, i + 1) for i in range(len(points) - 1)], 'lines', ocs_matrix(entity)
        if kind == 'ARC':
            center = _v3(entity.dxf.center)
            radius = _finite(entity.dxf.radius)
            if radius <= 0:
                raise ValueError('non-positive radius')
            start = math.radians(float(entity.dxf.start_angle))
            end = math.radians(float(entity.dxf.end_angle))
            sweep = (end - start) % (2.0 * math.pi)
            if sweep <= 1e-12:
                sweep = 2.0 * math.pi
            points = arc_points(center, (1, 0, 0), (0, 1, 0), radius, start, sweep)
            geometry = {'type': 'arc', 'center': center, 'normal': [0.0, 0.0, 1.0],
                        'xAxis': [1.0, 0.0, 0.0], 'radius': radius,
                        'startAngle': start, 'sweepAngle': sweep}
            return geometry, points, [(i, i + 1) for i in range(len(points) - 1)], 'lines', ocs_matrix(entity)
        if kind == 'LWPOLYLINE':
            elevation = float(entity.dxf.get('elevation', 0.0) or 0.0)
            raw_points = list(entity.get_points('xyb'))
            points = [[float(x), float(y), elevation] for x, y, _ in raw_points]
            bulges = [float(b) for _, _, b in raw_points]
            closed = bool(entity.closed)
            if len(points) < 2:
                raise ValueError('polyline needs two vertices')
            geometry = {'type': 'polyline', 'points': points, 'closed': closed,
                        'bulges': bulges if closed else bulges[:max(0, len(points) - 1)]}
            display_points, segments = _polyline_display(points, bulges, closed)
            return geometry, display_points, segments, 'lines', ocs_matrix(entity)
        if kind == 'POLYLINE':
            if entity.is_3d_polyline or entity.is_polygon_mesh or entity.is_poly_face_mesh:
                if entity.is_polygon_mesh or entity.is_poly_face_mesh:
                    raise ValueError('polygon mesh is not a 2D drawing entity')
                points = [_v3(v.dxf.location) for v in entity.vertices]
                if len(points) < 2:
                    raise ValueError('polyline needs two vertices')
                closed = bool(entity.is_closed)
                geometry = {'type': 'polyline', 'points': points, 'closed': closed,
                            'bulges': [0.0] * (len(points) if closed else max(0, len(points) - 1))}
                display_points = points + ([points[0]] if entity.is_closed and len(points) > 2 else [])
                segments = [(i, i + 1) for i in range(len(display_points) - 1)]
                return geometry, display_points, segments, 'lines', mat_identity()
            elevation = float(entity.dxf.get('elevation', 0.0) or 0.0)
            vertices = list(entity.vertices)
            points = []
            bulges = []
            for vertex in vertices:
                loc = vertex.dxf.location
                points.append([float(loc[0]), float(loc[1]), elevation])
                bulges.append(float(vertex.dxf.get('bulge', 0.0) or 0.0))
            closed = bool(entity.is_closed)
            if len(points) < 2:
                raise ValueError('polyline needs two vertices')
            geometry = {'type': 'polyline', 'points': points, 'closed': closed,
                        'bulges': bulges if closed else bulges[:max(0, len(points) - 1)]}
            display_points, segments = _polyline_display(points, bulges, closed)
            return geometry, display_points, segments, 'lines', ocs_matrix(entity)
        if kind == 'ELLIPSE':
            center = _v3(entity.dxf.center)
            major = _v3(entity.dxf.major_axis)
            ratio = float(entity.dxf.ratio)
            extrusion = _v3(entity.dxf.get('extrusion', (0, 0, 1)))
            normal = _normalize(extrusion)
            unit_major = _normalize(major)
            minor_vector = _cross(normal, unit_major)
            minor = [minor_vector[i] * math.hypot(*major) * ratio for i in range(3)]
            start = float(entity.dxf.start_param)
            end = float(entity.dxf.end_param)
            sweep = (end - start) % (2.0 * math.pi)
            if sweep <= 1e-12:
                sweep = 2.0 * math.pi
            points = ellipse_points(center, major, minor, start, sweep)
            geometry = {'type': 'ellipse', 'center': center, 'majorAxis': major,
                        'minorAxis': minor, 'startAngle': start, 'sweepAngle': sweep}
            return geometry, points, [(i, i + 1) for i in range(len(points) - 1)], 'lines', mat_identity()
        if kind == 'SPLINE':
            control_points = [_v3(p) for p in entity.control_points]
            if len(control_points) < 2:
                raise ValueError('fit-point-only spline has no control points')
            degree = int(entity.dxf.degree)
            knots = [float(k) for k in entity.knots]
            weights = [float(w) for w in entity.weights] if entity.weights else [1.0] * len(control_points)
            periodic = bool(entity.dxf.get('flags', 0) & 2)
            if len(knots) != len(control_points) + degree + 1:
                raise ValueError('spline knot count does not match control points')
            points = _spline_points(control_points, knots, weights, degree, periodic)
            geometry = {'type': 'spline', 'degree': degree, 'controlPoints': control_points,
                        'knots': knots, 'weights': weights, 'periodic': periodic}
            return geometry, points, [(i, i + 1) for i in range(len(points) - 1)], 'lines', mat_identity()
        raise ValueError('not a core geometry entity')

    def _polyline_display(points, bulges, closed):
        display = []
        segments = []
        count = len(points)
        pairs = count if closed else count - 1
        for i in range(pairs):
            p1 = points[i]
            p2 = points[(i + 1) % count]
            bulge = bulges[i] if i < len(bulges) else 0.0
            z = (p1[2] + p2[2]) / 2.0
            arc, n = bulge_points(p1, p2, bulge, z)
            if display and _same(display[-1], arc[0]):
                arc = arc[1:]
            start_index = len(display)
            display.extend(arc)
            segments.extend((start_index + k, start_index + k + 1) for k in range(len(arc) - 1))
        if not display:
            display = [list(p) for p in points]
        return display, segments

    def _same(a, b):
        return abs(a[0] - b[0]) < 1e-9 and abs(a[1] - b[1]) < 1e-9 and abs(a[2] - b[2]) < 1e-9

    def _normalize(v):
        n = math.sqrt(sum(x * x for x in v))
        return [v[0] / n, v[1] / n, v[2] / n] if n > 1e-12 else [0.0, 0.0, 1.0]

    def _cross(a, b):
        return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

    def map_entity(entity, space_id, space_key, index):
        kind = entity.dxftype()
        handle = entity.dxf.handle
        item_id = identity('entity', [sha, space_key, str(handle)])
        layer_name = entity.dxf.get('layer', '0')
        layer_id = layer_ids.get(layer_name)
        if layer_id is None:
            layer_id = identity('layer', [sha, layer_name])
            m['layers'][layer_id] = {'id': layer_id, 'drawingId': drawing_id, 'name': layer_name,
                                     'visible': True, 'frozen': False, 'lockedForEditing': False,
                                     'plot': True, 'defaultStyle': {'color': {'mode': 'unknown'}, 'plot': True},
                                     'sourceRefs': [{'sourceId': sid}]}
            m['drawings'][drawing_id]['layerIds'].append(layer_id)
        ref = source_ref(space_key, handle, index)
        counts['total'] += 1
        counts[kind] += 1
        style = source_style(entity, layer_name)
        record_style_modes(item_id, entity)
        unsupported_reason = UNSUPPORTED_REASONS.get(kind)
        geometry = None
        points = []
        segments = []
        triangles = None
        topology = 'lines'
        local_matrix = mat_identity()
        fill = None
        if unsupported_reason is None and kind in ('SOLID', 'HATCH'):
            try:
                fill = build_fill(entity, layer_id, style, ref)
            except ValueError as error:
                unsupported_reason = str(error)
                fill_skips.append({'entityId': item_id, 'handle': str(handle),
                                   'sourceKind': kind, 'reason': unsupported_reason})
        if unsupported_reason is None and fill is not None:
            geometry = fill['geometry']
            points = fill['points']
            triangles = fill['triangles']
            topology = 'triangles'
            fill_registry[item_id] = fill['record']
        elif unsupported_reason is None:
            try:
                geometry, points, segments, topology, local_matrix = tessellate_entity(entity)
            except ValueError as error:
                unsupported_reason = str(error)
        if unsupported_reason is not None:
            unsupported[kind] += 1
            display_missing[kind] += 1
            geometry = {'type': 'unsupported', 'sourceType': kind, 'reason': unsupported_reason}
            entity_record = {'id': item_id, 'drawingId': drawing_id, 'ownerSpaceId': space_id,
                             'layerId': layer_id, 'localFromOwner': mat_identity(),
                             'geometry': geometry, 'style': style, 'sourceRefs': [ref],
                             'displayOrder': int(index)}
            m['entities'][item_id] = entity_record
            m['spaces'][space_id]['entityIds'].append(item_id)
            return ('entity', item_id, False)
        if triangles is not None:
            display.add_fill(item_id, points, triangles, [ref])
        else:
            display.add(item_id, points, segments, topology, [ref])
        display_ok[kind] += 1
        entity_record = {'id': item_id, 'drawingId': drawing_id, 'ownerSpaceId': space_id,
                         'layerId': layer_id, 'localFromOwner': local_matrix,
                         'geometry': geometry, 'style': style, 'sourceRefs': [ref],
                         'displayOrder': int(index)}
        m['entities'][item_id] = entity_record
        m['spaces'][space_id]['entityIds'].append(item_id)
        return ('entity', item_id, True)

    def map_annotation(entity, space_id, space_key, index):
        nonlocal dimensions_with_geometry, dimensions_without_geometry
        kind = entity.dxftype()
        has_display = True
        handle = entity.dxf.handle
        item_id = identity('annotation', [sha, space_key, str(handle)])
        layer_name = entity.dxf.get('layer', '0')
        layer_id = layer_ids.get(layer_name)
        if layer_id is None:
            layer_id = identity('layer', [sha, layer_name])
            m['layers'][layer_id] = {'id': layer_id, 'drawingId': drawing_id, 'name': layer_name,
                                     'visible': True, 'frozen': False, 'lockedForEditing': False,
                                     'plot': True, 'defaultStyle': {'color': {'mode': 'unknown'}, 'plot': True},
                                     'sourceRefs': [{'sourceId': sid}]}
            m['drawings'][drawing_id]['layerIds'].append(layer_id)
        ref = source_ref(space_key, handle, index)
        counts['total'] += 1
        counts[kind] += 1
        record_style_modes(item_id, entity)
        ocs = ocs_matrix(entity)
        annotation = {'id': item_id, 'ownerSpaceId': space_id, 'layerId': layer_id,
                      'kind': 'text', 'position': [0.0, 0.0, 0.0], 'direction': [1.0, 0.0, 0.0],
                      'text': '', 'associativeEntityIds': [], 'semantic': {},
                      'presentationEntityIds': [], 'annotationScales': [], 'sourceRefs': [ref]}
        # Annotation has no EntityStyle in 2.0; the source style is kept in the DXF extension
        # and resolved into DrawingDraw.style (Resolved2DStyle) by project_drawing.
        annotation_styles[item_id] = source_style(entity, layer_name)
        if kind in ('TEXT', 'ATTDEF'):
            text = entity.dxf.get('text', '') or ''
            height = float(entity.dxf.get('height', 0.0) or 0.0)
            rotation = math.radians(float(entity.dxf.get('rotation', 0.0) or 0.0))
            halign = int(entity.dxf.get('halign', 0) or 0)
            valign = int(entity.dxf.get('valign', 0) or 0)
            insert = _v3(entity.dxf.insert)
            align = entity.dxf.get('align_point', None)
            use_align = halign != 0 or valign != 0
            anchor = _v3(align) if use_align and align is not None else insert
            world = _apply(ocs, anchor)
            direction = _apply_direction(ocs, [math.cos(rotation), math.sin(rotation), 0.0])
            annotation.update({'kind': 'text', 'position': world, 'direction': direction,
                               'text': text,
                               'semantic': {
                                   'height': {'value': height, 'knowledge': 'source-declared', 'validation': 'experimental', 'evidenceIds': ['dxf-spec']},
                                   'rotationRadians': {'value': rotation, 'knowledge': 'source-declared', 'validation': 'experimental', 'evidenceIds': ['dxf-spec']},
                                   'halign': {'value': halign, 'knowledge': 'source-declared', 'validation': 'experimental', 'evidenceIds': ['dxf-spec']},
                                   'valign': {'value': valign, 'knowledge': 'source-declared', 'validation': 'experimental', 'evidenceIds': ['dxf-spec']},
                                   'widthFactor': {'value': float(entity.dxf.get('width', 1.0) or 1.0), 'knowledge': 'source-declared', 'validation': 'experimental', 'evidenceIds': ['dxf-spec']},
                                   'obliqueAngle': {'value': float(entity.dxf.get('oblique', 0.0) or 0.0), 'knowledge': 'source-declared', 'validation': 'experimental', 'evidenceIds': ['dxf-spec']},
                               }})
            if kind == 'ATTDEF':
                flags = int(entity.dxf.get('flags', 0) or 0)
                annotation['semantic']['attributeTemplate'] = {
                    'value': {'tag': entity.dxf.get('tag', ''), 'default': text,
                              'flags': flags},
                    'knowledge': 'source-declared', 'validation': 'experimental',
                    'evidenceIds': ['dxf-spec']}
                partial['attdef'] += 1
                # An ATTDEF is a definition, not an instance: the displayed value comes
                # from the ATTRIB attached to each INSERT. Constant attributes (flag 2)
                # have no ATTRIB and keep their definition text.
                if flags & 1:
                    entity_flags.setdefault(item_id, {})['invisible'] = True
                if not flags & 2:
                    entity_flags.setdefault(item_id, {})['attributeTemplate'] = True
            style_name = entity.dxf.get('style', 'Standard')
            if style_name in text_style_ids:
                annotation['semantic']['textStyleId'] = {'value': text_style_ids[style_name],
                                                         'knowledge': 'source-declared', 'validation': 'experimental',
                                                         'evidenceIds': ['dxf-spec']}
            font = doc.styles.get(style_name).dxf.get('font', 'txt') if doc.styles.has_entry(style_name) else 'txt'
            if font in font_resources:
                annotation['fontResourceId'] = font_resources[font]
        elif kind == 'MTEXT':
            raw_text = entity.text or ''
            attachment = int(entity.dxf.get('attachment_point', 1) or 1)
            anchor = _apply(ocs, _v3(entity.dxf.insert))
            rotation = math.radians(float(entity.dxf.get('rotation', 0.0) or 0.0))
            # DXF group 11 (text direction) overrides group 50 for MTEXT; it is an OCS
            # vector, so the entity OCS still applies.
            text_direction = entity.dxf.get('text_direction', None)
            if text_direction is not None and abs(text_direction[0]) + abs(text_direction[1]) > 1e-12:
                rotation = math.atan2(text_direction[1], text_direction[0])
                direction = _apply_direction(ocs, [text_direction[0], text_direction[1], 0.0])
            else:
                direction = _apply_direction(ocs, [math.cos(rotation), math.sin(rotation), 0.0])
            annotation.update({'kind': 'mtext', 'position': anchor, 'direction': direction,
                               'text': raw_text,
                               'semantic': {
                                   'plainText': {'value': entity.plain_text(), 'knowledge': 'source-declared', 'validation': 'experimental', 'evidenceIds': ['dxf-spec']},
                                   'charHeight': {'value': float(entity.dxf.get('char_height', 2.5) or 2.5), 'knowledge': 'source-declared', 'validation': 'experimental', 'evidenceIds': ['dxf-spec']},
                                   'rotationRadians': {'value': rotation, 'knowledge': 'source-declared', 'validation': 'experimental', 'evidenceIds': ['dxf-spec']},
                                   'attachmentPoint': {'value': attachment, 'knowledge': 'source-declared', 'validation': 'experimental', 'evidenceIds': ['dxf-spec']},
                               }})
            partial['mtext'] += 1
            style_name = entity.dxf.get('style', 'Standard')
            if style_name in text_style_ids:
                annotation['semantic']['textStyleId'] = {'value': text_style_ids[style_name],
                                                         'knowledge': 'source-declared', 'validation': 'experimental',
                                                         'evidenceIds': ['dxf-spec']}
            font = doc.styles.get(style_name).dxf.get('font', 'txt') if doc.styles.has_entry(style_name) else 'txt'
            if font in font_resources:
                annotation['fontResourceId'] = font_resources[font]
        elif kind == 'DIMENSION':
            position = _apply(ocs, _v3(entity.dxf.defpoint))
            text = entity.dxf.get('text', '') or ''
            dimtype = int(entity.dxf.get('dimtype', 0) or 0) & 7
            annotation.update({'kind': 'dimension', 'position': position,
                               'direction': [1.0, 0.0, 0.0], 'text': text,
                               'measuredValue': unknown(),
                               'semantic': {
                                   'dimensionType': {'value': dimtype, 'knowledge': 'source-declared', 'validation': 'experimental', 'evidenceIds': ['dxf-spec']},
                                   'measurementReconstruction': {'value': 'not-performed', 'knowledge': 'engineering-defined', 'validation': 'experimental', 'evidenceIds': ['policy']},
                               }})
            partial['dimension'] += 1
            geometry_block = entity.dxf.get('geometry', None)
            if geometry_block and geometry_block in block_ids:
                dimensions_with_geometry += 1
                entity_flags.setdefault(item_id, {})['presentationGeometry'] = 'present'
                instance_id = identity('blockInstance', [sha, space_key, str(handle) + '/dimension-geometry'])
                m['blockInstances'][instance_id] = {
                    'id': instance_id, 'ownerSpaceId': space_id,
                    'definitionId': block_ids[geometry_block], 'layerId': layer_id,
                    'localFromBlock': mat_identity(), 'attributes': {},
                    'style': source_style(entity, layer_name),
                    'sourceRefs': [ref]}
                m['spaces'][space_id]['blockInstanceIds'].append(instance_id)
                annotation['presentationEntityIds'] = []
            else:
                dimensions_without_geometry += 1
                has_display = False
                # The source has a DIMENSION record but no anonymous presentation block.
                # Nothing is invented here: the draw is published as missing-reference so
                # the viewer can report it instead of silently drawing an empty item.
                entity_flags.setdefault(item_id, {})['presentationGeometry'] = 'missing'
                losses.append(('dimension-presentation-missing', str(handle)))
        elif kind in ('ATTRIB',):
            flags = int(entity.dxf.get('flags', 0) or 0)
            annotation.update({'kind': 'text', 'position': _apply(ocs, _v3(entity.dxf.insert)),
                               'text': entity.dxf.get('text', '') or '',
                               'semantic': {'tag': {'value': entity.dxf.get('tag', ''), 'knowledge': 'source-declared', 'validation': 'experimental', 'evidenceIds': ['dxf-spec']},
                                            'height': {'value': float(entity.dxf.get('height', 0.0) or 0.0), 'knowledge': 'source-declared', 'validation': 'experimental', 'evidenceIds': ['dxf-spec']},
                                            'rotationRadians': {'value': math.radians(float(entity.dxf.get('rotation', 0.0) or 0.0)), 'knowledge': 'source-declared', 'validation': 'experimental', 'evidenceIds': ['dxf-spec']}}})
            direction = _apply_direction(ocs, [math.cos(math.radians(float(entity.dxf.get('rotation', 0.0) or 0.0))), math.sin(math.radians(float(entity.dxf.get('rotation', 0.0) or 0.0))), 0.0])
            annotation['direction'] = direction
            if flags & 1:
                entity_flags.setdefault(item_id, {})['invisible'] = True
            partial['attrib'] += 1
        else:
            raise ValueError('unmapped annotation type ' + kind)
        m['annotations'][item_id] = annotation
        m['spaces'][space_id]['annotationIds'].append(item_id)
        (display_ok if has_display else display_missing)[kind] += 1
        return ('annotation', item_id, True)

    def map_insert(entity, space_id, space_key, index):
        handle = entity.dxf.handle
        block_name = entity.dxf.get('name', '')
        layer_name = entity.dxf.get('layer', '0')
        layer_id = layer_ids.get(layer_name, identity('layer', [sha, layer_name]))
        ref = source_ref(space_key, handle, index)
        counts['total'] += 1
        counts['INSERT'] += 1
        if block_name not in block_ids:
            unsupported['INSERT-missing-block'] += 1
            display_missing['INSERT'] += 1
            item_id = identity('entity', [sha, space_key, str(handle)])
            m['entities'][item_id] = {'id': item_id, 'drawingId': drawing_id, 'ownerSpaceId': space_id,
                                      'layerId': layer_id, 'localFromOwner': mat_identity(),
                                      'geometry': {'type': 'unsupported', 'sourceType': 'INSERT',
                                                   'reason': 'block definition "' + block_name + '" is not present in the DXF'},
                                      'style': source_style(entity, layer_name), 'sourceRefs': [ref],
                                      'displayOrder': int(index)}
            m['spaces'][space_id]['entityIds'].append(item_id)
            if ('missing-block', block_name) not in losses:
                losses.append(('missing-block', block_name))
            return ('entity', item_id, False)
        instance_id = identity('blockInstance', [sha, space_key, str(handle)])
        attributes = {attrib.dxf.get('tag', ''): attrib.dxf.get('text', '') for attrib in entity.attribs}
        rows = int(entity.dxf.get('row_count', 1) or 1)
        columns = int(entity.dxf.get('column_count', 1) or 1)
        instance = {'id': instance_id, 'ownerSpaceId': space_id,
                    'definitionId': block_ids[block_name], 'layerId': layer_id,
                    'localFromBlock': flatten(entity.matrix44()),
                    'attributes': attributes,
                    'style': source_style(entity, layer_name), 'sourceRefs': [ref]}
        if rows > 1 or columns > 1:
            ocs = entity.ocs()
            origin = ocs.to_wcs((0.0, 0.0, 0.0))
            row_delta = ocs.to_wcs((0.0, float(entity.dxf.get('row_spacing', 0.0) or 0.0), 0.0)) - origin
            col_delta = ocs.to_wcs((float(entity.dxf.get('column_spacing', 0.0) or 0.0), 0.0, 0.0)) - origin
            instance['array'] = {'rows': rows, 'columns': columns,
                                 'rowOffset': [float(row_delta.x), float(row_delta.y), float(row_delta.z)],
                                 'columnOffset': [float(col_delta.x), float(col_delta.y), float(col_delta.z)]}
        record_style_modes(instance_id, entity)
        m['blockInstances'][instance_id] = instance
        m['spaces'][space_id]['blockInstanceIds'].append(instance_id)
        # Each ATTRIB is an entity in the owner space: its insert point is already the
        # transformed ATTDEF position (verified against the source on real files), so it
        # is mapped as an ordinary annotation next to the INSERT. An ATTRIB on layer 0
        # takes the INSERT layer (DXF layer-0 inheritance), carried as a projection hint.
        for attrib in entity.attribs:
            _, attrib_id, _ = map_annotation(attrib, space_id, space_key, index)
            if attrib.dxf.get('layer', '0') == '0' and layer_name != '0':
                entity_flags.setdefault(attrib_id, {})['inheritedLayerId'] = layer_id
        display_ok['INSERT'] += 1
        return ('blockInstance', instance_id, True)

    def _apply(matrix, point):
        return [matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12],
                matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13],
                matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14]]

    def _apply_direction(matrix, vector):
        out = [matrix[0] * vector[0] + matrix[4] * vector[1] + matrix[8] * vector[2],
               matrix[1] * vector[0] + matrix[5] * vector[1] + matrix[9] * vector[2],
               matrix[2] * vector[0] + matrix[6] * vector[1] + matrix[10] * vector[2]]
        length = math.sqrt(sum(x * x for x in out))
        return [out[0] / length, out[1] / length, out[2] / length] if length > 1e-12 else [1.0, 0.0, 0.0]

    def walk_space(space_id, space_key, items):
        if len(counts) and counts['total'] > MAX_ENTITIES:
            raise ValueError('entities-over-limit')
        for index, entity in enumerate(items):
            kind = entity.dxftype()
            if kind in ANNOTATION_ENTITIES:
                map_annotation(entity, space_id, space_key, index)
            elif kind == 'INSERT':
                map_insert(entity, space_id, space_key, index)
            else:
                map_entity(entity, space_id, space_key, index)

    model_space = doc.modelspace()
    walk_space(model_space_id, 'MODEL', list(model_space))
    for block_layout in doc.blocks:
        bname = block_layout.name
        if bname not in block_space_ids:
            continue
        walk_space(block_space_ids[bname], 'BLOCK:' + bname, list(block_layout))
    viewport_details = []
    for layout, lid, spid in paper_layouts:
        viewport_ids = []
        for index, entity in enumerate(list(layout)):
            if entity.dxftype() == 'VIEWPORT':
                if int(entity.dxf.get('id', 0) or 0) in (1,):
                    viewport_details.append({'handle': str(entity.dxf.handle), 'layoutId': lid,
                                             'layoutName': layout.name, 'dxfId': 1,
                                             'status': 'paper-container', 'projected': False})
                    continue
                vid = identity('viewport', [sha, lid, str(entity.dxf.handle)])
                direction = _v3(entity.dxf.get('view_direction_vector', (0, 0, 1)))
                if abs(direction[0]) > 1e-9 or abs(direction[1]) > 1e-9 or abs(direction[2]) < 1e-9:
                    losses.append(('viewport-3d', entity.dxf.handle))
                    counts['VIEWPORT-skipped'] += 1
                    viewport_details.append({'handle': str(entity.dxf.handle), 'layoutId': lid,
                                             'layoutName': layout.name, 'dxfId': int(entity.dxf.get('id', 0) or 0),
                                             'status': 'skipped-non-top-view', 'projected': False})
                    continue
                center = _v3(entity.dxf.center)
                width = float(entity.dxf.get('width', 0.0) or 0.0)
                height = float(entity.dxf.get('height', 0.0) or 0.0)
                view_center = _v3(entity.dxf.get('view_center_point', (0, 0, 0)))
                view_height = float(entity.dxf.get('view_height', 0.0) or 0.0)
                if width <= 0 or height <= 0 or view_height <= 0:
                    losses.append(('viewport-degenerate', entity.dxf.handle))
                    counts['VIEWPORT-skipped'] += 1
                    viewport_details.append({'handle': str(entity.dxf.handle), 'layoutId': lid,
                                             'layoutName': layout.name, 'dxfId': int(entity.dxf.get('id', 0) or 0),
                                             'status': 'skipped-degenerate', 'projected': False})
                    continue
                scale = height / view_height
                twist = float(entity.dxf.get('view_twist_angle', 0.0) or 0.0)
                cos_t, sin_t = math.cos(twist), math.sin(twist)
                # model -> paper: rotate by twist, scale, then center the view point.
                mtx = mat_identity()
                mtx[0] = scale * cos_t
                mtx[1] = scale * sin_t
                mtx[4] = -scale * sin_t
                mtx[5] = scale * cos_t
                mtx[12] = center[0] - (view_center[0] * mtx[0] + view_center[1] * mtx[4])
                mtx[13] = center[1] - (view_center[0] * mtx[1] + view_center[1] * mtx[5])
                frozen = []
                for fname in entity.frozen_layers:
                    if fname in layer_ids:
                        frozen.append(layer_ids[fname])
                status = int(entity.dxf.get('status', 0) or 0)
                viewport = {'id': vid, 'layoutId': lid, 'sourceSpaceId': model_space_id,
                            'modelToPaper': mtx, 'projection': 'orthographic',
                            'clipBoundary': [[center[0] - width / 2, center[1] - height / 2],
                                             [center[0] + width / 2, center[1] - height / 2],
                                             [center[0] + width / 2, center[1] + height / 2],
                                             [center[0] - width / 2, center[1] + height / 2]],
                            'enabled': status in (2, 3),
                            'frozenLayerIds': frozen, 'layerOverrides': {},
                            'annotationScale': 1.0}
                m['viewports'][vid] = viewport
                m['layouts'][lid]['viewportIds'].append(vid)
                viewport_ids.append(vid)
                viewport_details.append({'handle': str(entity.dxf.handle), 'layoutId': lid,
                                         'layoutName': layout.name,
                                         'dxfId': int(entity.dxf.get('id', 0) or 0), 'viewportId': vid,
                                         'status': 'projected', 'projected': True,
                                         'scale': round(scale, 9), 'enabled': status in (2, 3),
                                         'paperCenter': [round(center[0], 9), round(center[1], 9)],
                                         'paperSize': [round(width, 9), round(height, 9)]})
                continue
            walk_space_item = entity
            if entity.dxftype() in ANNOTATION_ENTITIES:
                map_annotation(entity, spid, 'PAPER:' + layout.name, index)
            elif entity.dxftype() == 'INSERT':
                map_insert(entity, spid, 'PAPER:' + layout.name, index)
            else:
                map_entity(entity, spid, 'PAPER:' + layout.name, index)
        # Sheet is created only when the layout declares a paper size.
        paper_width = layout.dxf.get('paper_width', None)
        paper_height = layout.dxf.get('paper_height', None)
        if paper_width and paper_height:
            plot_units = int(layout.dxf.get('plot_paper_units', 1) or 1)
            factor = 1.0 if plot_units == 1 else 25.4
            margin = [float(layout.dxf.get(k, 0.0) or 0.0) / factor for k in
                      ('left_margin', 'bottom_margin', 'right_margin', 'top_margin')]
            sheet_id = identity('sheet', [sha, lid])
            m['sheets'][sheet_id] = {'id': sheet_id, 'drawingId': drawing_id,
                                     'name': layout.name,
                                     'paperSize': [float(paper_width) / factor, float(paper_height) / factor],
                                     'paperUnit': 'mm' if plot_units == 1 else 'inch',
                                     'margins': margin, 'layoutIds': [lid]}
            m['layouts'][lid]['sheetId'] = sheet_id
            m['drawings'][drawing_id]['sheetIds'].append(sheet_id)

    display.commit(d, sink)
    stageprof.mark('dxf.mapped', entities=counts['total'], blocks=len(m['blocks']),
                   layers=len(m['layers']), viewports=len(m['viewports']))

    # ----- projection (model space) and completeness -------------------------
    total_unsupported = sum(unsupported.values())
    coverage = {'total': counts['total'], 'byType': dict(sorted(counts.items())),
                'unsupportedTotal': total_unsupported,
                'unsupportedByType': dict(sorted(unsupported.items())),
                'partialByType': dict(sorted(partial.items())),
                'dimensionWithGeometry': dimensions_with_geometry,
                'dimensionWithoutGeometry': dimensions_without_geometry}
    attribute_coverage = {
        'entityIdentity': 'mapped', 'layersAndVisibility': 'mapped',
        'blockDefinitionsAndInstances': 'mapped', 'blockAttributes': 'mapped',
        'textContentAndPlacement': 'mapped', 'textFontRendering': 'font-substitution',
        'mtextFormatting': 'raw-codes-preserved-not-rendered',
        'dimensionSemantics': 'not-reconstructed (presentation from source geometry block only)',
        'hatchPatterns': 'unsupported', 'lineTypePatterns': 'mapped (numeric dashes; complex text/shape elements not rendered)',
        'plotStyles': 'not-parsed', 'xdata': 'not-mapped', 'extensionDictionaries': 'not-mapped',
        'proxyObjects': 'not-mapped', 'units': 'declared-by-INSUNITS' if unit else 'unknown',
        'objectProperties': 'not-mapped'}
    # Three distinct axes. They are deliberately not collapsed: a file can have every
    # record enumerated and still lose display geometry, and display geometry can be
    # complete while engineering attributes (dimension semantics, MTEXT formatting,
    # plot styles, XDATA) are not reconstructed.
    with_display = sum(display_ok.values())
    without_display = sum(display_missing.values())
    viewport_losses = sum(1 for l in losses if l[0] == 'viewport-3d')
    geometry_complete = without_display == 0 and viewport_losses == 0
    coverage_axes = {
        'schemaVersion': '1.0.0',
        'sourceRead': {'status': 'complete',
                       'sourceRecords': counts['total'],
                       'byType': dict(sorted(counts.items())),
                       'viewportRecords': len(viewport_details),
                       'modelViewports': len(m['viewports']),
                       'enabledModelViewports': sum(1 for v in m['viewports'].values() if v.get('enabled')),
                       'note': 'Every entity/annotation/INSERT record enumerated in model space, paper spaces '
                               'and block definitions; viewportRecords counts every DXF VIEWPORT record '
                               '(including one paper-container per layout), modelViewports the ones that '
                               'project model space, enabledModelViewports the enabled subset.'},
        'displayGeometry': {'status': 'complete' if geometry_complete else 'partial',
                            'sourceRecords': counts['total'],
                            'withDisplayGeometry': with_display,
                            'withoutDisplayGeometry': without_display,
                            'byReason': {'unsupported': dict(sorted(unsupported.items())),
                                         'annotationWithoutPresentation': dimensions_without_geometry,
                                         'viewportSkipped': viewport_losses},
                            'note': 'complete only when every enumerated record produces a draw; '
                                    'unsupported records and skipped viewports keep this partial.'},
        'engineeringAttributes': {'status': 'partial', 'coverage': attribute_coverage,
                                  'note': 'Attribute coverage is independent of geometry completeness.'},
        'losses': [{'code': l[0], 'detail': str(l[1])} for l in losses],
    }
    # Format-neutral tables consumed by drawing projection. The viewer must not know DXF
    # keywords: the adapter resolves BYLAYER/BYBLOCK to layer/parent modes here and the
    # projection applies generic inheritance.
    d['extensions']['org.cad-preview.style-inheritance/1'] = {
        'schemaVersion': '1.1.0',
        'modes': style_modes,
        'annotationStyles': annotation_styles,
        'entityState': entity_flags,
        'lineTypeScale': ltscale,
        # Format-neutral layer inheritance: content on these layers takes the layer of
        # the innermost enclosing block reference (DXF layer "0"). The projection applies
        # it generically; the viewer uses the same table for user layer toggles.
        'layerInheritance': {lid: {'byBlockLayer': True}
                             for lid, layer in m['layers'].items() if layer['name'] == '0'},
        'projectionLimits': {'maxDraws': MAX_PROJECTION_DRAWS},
    }
    d['extensions']['org.cad-preview.drawing-coverage/1'] = coverage_axes
    # Minimal versioned extension: UCD 2.0 Hatch references boundary entities only, so
    # inline HATCH/SOLID boundaries are carried as derived polyline entities plus this
    # analytic record. Existing field meanings are unchanged.
    d['extensions']['org.cad-preview.fill/1'] = {
        'schemaVersion': '1.0.0',
        'ucdGap': 'Hatch.boundaryEntityIds references entities only; inline boundary paths '
                  'are stored here and referenced by derived polyline entities in a block '
                  'space that is never instantiated (so no extra draws are emitted).',
        'derivedBlockId': boundary_block['blockId'],
        'derivedBlockName': boundary_block['name'],
        'derivedSpaceId': boundary_block['spaceId'],
        'fills': fill_registry,
        'skipped': fill_skips,
    }
    # DXF-specific provenance only; projection never reads this extension.
    d['extensions']['org.cad-preview.dxf/1'] = {
        'engine': {'name': 'ezdxf', 'version': ENGINE},
        'dxfVersion': {'code': code, 'release': RELEASE.get(code, 'unknown')},
        'units': {'insunits': int(insunits), 'mapping': unit, 'label': unit_label},
        'globalLineTypeScale': ltscale,
        'blockHandles': block_handles,
        'coverage': coverage,
        'attributeCoverage': attribute_coverage,
        'losses': [{'code': l[0], 'detail': str(l[1])} for l in losses],
        'complexLineTypes': complex_line_types,
        'tessellation': {'policy': 'relative-sagitta', 'relativeTolerance': RELATIVE_TOLERANCE,
                         'maxAngularStepDegrees': round(math.degrees(MAX_ANGULAR_STEP), 6),
                         'maxSegmentsPerCurve': MAX_CURVE_SEGMENTS,
                         'appliesTo': 'Representation(kind=drawing) only; Entity.geometry keeps analytic source data'},
        'paperSpace': paper_space_details(m, viewport_details),
    }

    effective_layers = {}
    projection = project_drawing(d, {'kind': 'model', 'spaceId': model_space_id}, effective_layers)
    d['extensions']['org.cad-preview.drawing-layers/1'] = {'target': projection['target'], 'byDraw': effective_layers}
    completeness = coverage_axes['displayGeometry']['status']
    snapshot = {'schemaVersion': '2.0.0', 'id': 'pending', 'documentRevision': '0' * 64,
                'selection': {'viewContextId': 'view-default'}, 'sceneRoots': [],
                'occurrenceOverrides': {}, 'draws': {}, 'completeness': completeness,
                'diagnostics': [], 'drawingProjection': projection}
    for diag_code, message in [
            ('dxf-geometry-projection', 'Drawings/spaces/entities/blocks/layers are mapped from the DXF tables; display polylines are separate Representation(kind=drawing) artifacts.'),
            ('dxf-attribute-coverage', 'MTEXT formatting, dimension measurement/associativity, hatch patterns, XDATA, extension dictionaries, proxy objects and plot styles are not reconstructed.')]:
        snapshot['diagnostics'].append({'code': diag_code, 'severity': 'info', 'stage': 'mapping',
                                        'message': message, 'sourceRefs': [{'sourceId': sid}]})
    for entity_kind, count in sorted(unsupported.items()):
        snapshot['diagnostics'].append({'code': 'dxf-entity-unsupported', 'severity': 'warning',
                                        'stage': 'mapping',
                                        'message': entity_kind + ' x' + str(count) + ' mapped as UnsupportedEntity; no geometry is guessed',
                                        'sourceRefs': [{'sourceId': sid}]})

    d['capabilities'] = [
        {'feature': 'dxf-drawing-model', 'scope': 'Real DXF via pinned ezdxf; samples recorded in phase_i_evidence',
         'mechanism': 'standard-confirmed', 'implementation': 'implemented', 'validation': 'experimental',
         'evidenceIds': ['dxf-spec', 'ezdxf', 'policy'],
         'limitations': ['Only DXF; DWG is not read', 'Independent sample comparison is recorded separately per sample']},
        {'feature': 'dxf-core-entities', 'scope': 'LINE POINT CIRCLE ARC LWPOLYLINE POLYLINE ELLIPSE SPLINE',
         'mechanism': 'standard-confirmed', 'implementation': 'implemented', 'validation': 'experimental',
         'evidenceIds': ['dxf-spec', 'ezdxf'], 'limitations': ['CIRCLE is stored as a full-sw eep Arc; DXF stores no separate circle primitive in UCD']},
        {'feature': 'dxf-blocks-and-instances', 'scope': 'BlockDefinition per block record, BlockInstance per INSERT',
         'mechanism': 'standard-confirmed', 'implementation': 'implemented', 'validation': 'experimental',
         'evidenceIds': ['dxf-spec', 'ezdxf'],
         'limitations': ['Dynamic block parameters are not evaluated', 'XREF content is not resolved']},
        {'feature': 'dxf-layers-and-visibility', 'scope': 'Layer table, off/frozen/locked/plot flags',
         'mechanism': 'standard-confirmed', 'implementation': 'implemented', 'validation': 'experimental',
         'evidenceIds': ['dxf-spec', 'ezdxf'], 'limitations': ['Per-viewport layer overrides beyond frozen layers are not mapped']},
        {'feature': 'dxf-annotations', 'scope': 'TEXT and ATTDEF content/placement; MTEXT raw content; DIMENSION record',
         'mechanism': 'standard-confirmed', 'implementation': 'experimental', 'validation': 'experimental',
         'evidenceIds': ['dxf-spec', 'ezdxf', 'policy'],
         'limitations': ['Fonts are substituted by the viewer', 'MTEXT inline formatting is preserved but not rendered',
                         'Dimension measurement/associativity is not reconstructed']},
        {'feature': 'dxf-paper-space', 'scope': 'Paper space layouts, sheet paper size and orthographic top-view viewports',
         'mechanism': 'standard-confirmed', 'implementation': 'experimental', 'validation': 'experimental',
         'evidenceIds': ['dxf-spec', 'ezdxf', 'policy'],
         'limitations': ['Perspective and non-top viewports are skipped and reported', 'Viewport clipping is a rectangular boundary only']},
        {'feature': 'dxf-hatch', 'scope': 'HATCH entities', 'mechanism': 'standard-confirmed',
         'implementation': 'unsupported', 'validation': 'not-implemented', 'evidenceIds': ['dxf-spec'],
         'limitations': ['Inline boundary paths cannot be represented by Hatch entity references; recorded as UnsupportedEntity']},
        {'feature': 'dxf-plot-styles', 'scope': 'CTB/STB plot style tables', 'mechanism': 'unknown',
         'implementation': 'unsupported', 'validation': 'not-implemented', 'evidenceIds': ['dxf-spec'],
         'limitations': ['Plot style tables are not parsed; display uses resolved layer/entity colors']},
    ]

    presentation = {'name': name,
                    'view': None,
                    'quality': 'DXF 二维绘制 · ' + RELEASE.get(code, code)
                               + (' · 几何显示部分完成' if completeness == 'partial' else ' · 几何绘制项完整')
                               + ' · 属性覆盖独立评估',
                    'candidate': True,
                    'unit': ('$INSUNITS=' + str(insunits) + ' (' + unit_label + ')') if unit else '$INSUNITS=0（未声明单位）',
                    'sourceSHA256': sha,
                    'stats': {'entities': counts['total'], 'draws': len(projection['draws']),
                              'layers': len(m['layers']), 'blocks': len(m['blocks']),
                              'blockInstances': len(m['blockInstances']), 'layouts': len(m['layouts']),
                              'viewports': len(m['viewports']), 'unsupportedEntities': total_unsupported,
                              'completeness': completeness},
                    'note': 'DXF 经 ezdxf ' + ENGINE + ' 解析为 UCD Drawing；显示折线是独立 Representation(drawing)，不是源曲线。不支持实体登记为 UnsupportedEntity，未填充猜测几何。'}
    envelope = {'transportProfile': sink.profile, 'document': d, 'snapshot': snapshot,
                'presentation': presentation}
    sink.attach(envelope)
    seal(envelope)
    if isinstance(sink, Base64Sink):
        validate_envelope(envelope)
    else:
        validate_binary_envelope(d, snapshot, presentation, sink.get)
        # Binary transport: the worker now writes the already-validated buffers to its
        # private directory; the JSON body only carries document/snapshot/manifest.
        sink.finish(envelope)
    stageprof.mark('dxf.validation-done', transport=sink.profile)
    return envelope


def project_drawing(d, target, effective_layers=None):
    """Build a DrawingProjection for a model/layout target from the UCD document.

    Pure referential resolution: no DXF object is read here. The browser implements
    the same rules so layout switching needs no re-parse; Python remains the
    reference used by the parity test.
    """
    m = d['drawing']
    drawing_id = target.get('drawingId')
    if target['kind'] == 'model':
        layout_id = None
        space_id = target['spaceId']
        drawing = m['spaces'][space_id]['drawingId']
    else:
        layout_id = target['layoutId']
        layout = m['layouts'][layout_id]
        space_id = layout['paperSpaceId']
        drawing = layout['drawingId']
    drawing_id = drawing_id or drawing
    drawing_row = m['drawings'][drawing]
    # Projection reads only the format-neutral inheritance tables; DXF keywords never
    # reach this function (or the browser port).
    style_ext = d.get('extensions', {}).get('org.cad-preview.style-inheritance/1', {})
    style_modes = style_ext.get('modes', {})
    annotation_styles = style_ext.get('annotationStyles', {})
    flags = style_ext.get('entityState', {})
    layer_states = {lid: {'visible': layer['visible'], 'frozen': layer['frozen'], 'plot': layer['plot']}
                    for lid, layer in m['layers'].items() if layer['drawingId'] == drawing}
    viewports = {}
    if layout_id:
        for vid in m['layouts'][layout_id]['viewportIds']:
            viewports[vid] = m['viewports'][vid]

    inheriting_layers = set(style_ext.get('layerInheritance', {}))

    def effective_layer(layer_id, chain):
        """Layer-0 content inside a block reference takes the enclosing instance layer.

        The table is format-neutral: the adapter marks the inheriting layers and the
        projection only walks the instance chain. A top-level item keeps its own layer.
        """
        if layer_id not in inheriting_layers:
            return layer_id
        for _parent_style, parent_layer, _parent_id in reversed(chain):
            if parent_layer not in inheriting_layers:
                return parent_layer
        return layer_id

    def item_layer(item_id, fallback):
        return flags.get(item_id, {}).get('inheritedLayerId') or fallback

    def layer_color(layer_id):
        style = m['layers'][layer_id]['defaultStyle']['color']
        return list(style.get('rgba', [1.0, 1.0, 1.0, 1.0]))

    def layer_linetype(layer_id):
        return m['layers'][layer_id]['defaultStyle'].get('lineTypeId')

    def layer_lineweight(layer_id):
        fact = m['layers'][layer_id]['defaultStyle'].get('lineWeight')
        return fact

    def color_from(style, layer_id, chain):
        mode = style['color']['mode']
        if mode == 'explicit':
            return list(style['color']['rgba'])
        if mode == 'by-layer':
            return layer_color(layer_id)
        if mode == 'by-block':
            for parent_style, parent_layer, _parent_id in reversed(chain):
                pmode = parent_style['color']['mode']
                if pmode == 'explicit':
                    return list(parent_style['color']['rgba'])
                if pmode == 'by-layer':
                    return layer_color(parent_layer)
            return layer_color(layer_id)
        return layer_color(layer_id)

    def resolve(style, layer_id, chain, item_id):
        mode = style_modes.get(item_id, {})
        lt = style.get('lineTypeId')
        lt_mode = mode.get('lineType')
        if lt is None and lt_mode == 'by-layer':
            lt = layer_linetype(layer_id)
        elif lt is None and lt_mode == 'by-block':
            for parent_style, parent_layer, parent_id in reversed(chain):
                if parent_style.get('lineTypeId'):
                    lt = parent_style['lineTypeId']
                    break
                parent_mode = style_modes.get(parent_id, {}).get('lineType')
                if parent_mode == 'by-layer':
                    lt = layer_linetype(parent_layer)
                    break
                if parent_mode == 'by-block':
                    continue
            if lt is None:
                lt = layer_linetype(layer_id)
        lw_fact = style.get('lineWeight')
        lw_mode = mode.get('lineWeight')
        if lw_fact is None and lw_mode == 'by-layer':
            lw_fact = layer_lineweight(layer_id)
        elif lw_fact is None and lw_mode == 'by-block':
            for parent_style, parent_layer, parent_id in reversed(chain):
                if parent_style.get('lineWeight'):
                    lw_fact = parent_style['lineWeight']
                    break
                parent_mode = style_modes.get(parent_id, {}).get('lineWeight')
                if parent_mode == 'by-layer':
                    lw_fact = layer_lineweight(parent_layer)
                    break
                if parent_mode == 'by-block':
                    continue
            if lw_fact is None:
                lw_fact = layer_lineweight(layer_id)
        if lw_fact is None:
            lw_fact = {'value': DEFAULT_LINE_WEIGHT_MM, 'knowledge': 'engineering-defined',
                       'validation': 'experimental', 'evidenceIds': ['policy']}
        opacity = 1.0
        info = flags.get(item_id, {})
        if 'transparency' in info:
            opacity = max(0.0, min(1.0, float(info['transparency'])))
        resolved = {'color': color_from(style, layer_id, chain),
                    'opacity': opacity,
                    'plot': bool(style.get('plot', True)) and bool(layer_states.get(layer_id, {}).get('plot', True)),
                    'lineWeight': lw_fact}
        if lt:
            resolved['lineTypeId'] = lt
        if 'fontResourceId' in style:
            resolved['fontResourceId'] = style['fontResourceId']
        return resolved

    draws = {}
    order = [0]
    max_draws = [0]

    def add_draw(kind, item_id, block_path, local_to_space, visibility, availability,
                 style, display_representation_id, viewport_id=None, layer_id=None):
        order[0] += 1
        max_draws[0] += 1
        if max_draws[0] > MAX_PROJECTION_DRAWS:
            raise ValueError('drawing-projection-over-limit')
        draw_id = identity('drawing-draw', [drawing_id, kind, item_id, block_path, viewport_id or ''])
        draw = {'kind': kind, 'itemId': item_id, 'blockPath': block_path,
                'localToSpace': local_to_space, 'visibility': visibility,
                'availability': availability, 'style': style, 'drawOrder': order[0] - 1}
        if viewport_id:
            draw['viewportId'] = viewport_id
        if display_representation_id:
            draw['displayRepresentationId'] = display_representation_id
        draws[draw_id] = draw
        if effective_layers is not None:
            effective_layers[draw_id] = layer_id

    def members(space_id):
        space = m['spaces'][space_id]
        rows = []
        for kind, table, field in (('entity', m['entities'], 'entityIds'),
                                   ('annotation', m['annotations'], 'annotationIds'),
                                   ('blockInstance', m['blockInstances'], 'blockInstanceIds')):
            for item_id in space[field]:
                item = table[item_id]
                ref = item['sourceRefs'][0] if item.get('sourceRefs') else {}
                rows.append((int(ref.get('recordOffset', 0)), kind, item_id, item))
        rows.sort(key=lambda row: (row[0], row[1], row[2]))
        return rows

    def hidden_by_layer(layer_id, viewport):
        state = layer_states.get(layer_id)
        if state is None:
            return False
        if not state['visible'] or state['frozen']:
            return True
        if viewport and layer_id in viewport['frozenLayerIds']:
            return True
        return False

    def entity_visibility(item_id, layer_id, viewport):
        if hidden_by_layer(layer_id, viewport):
            return 'hidden'
        if flags.get(item_id, {}).get('invisible'):
            return 'hidden'
        return 'shown'

    def walk(space_id, transform, path, viewport, chain, inherited_hidden=False):
        for record_offset, kind, item_id, item in members(space_id):
            if kind == 'entity':
                layer_id = effective_layer(item_layer(item_id, item['layerId']), chain)
                visibility = 'hidden' if inherited_hidden else entity_visibility(item_id, layer_id, viewport)
                availability = 'unsupported' if item['geometry']['type'] == 'unsupported' else 'ready'
                style = resolve(item['style'], layer_id, chain, item_id)
                local = mat_mul(transform, item['localFromOwner'])
                representation_id = (item.get('displayRepresentationId') or identity('representation', [item_id])
                                     if availability == 'ready' else None)
                add_draw('entity', item_id, path, local, visibility, availability,
                         style, representation_id, viewport['id'] if viewport else None, layer_id)
            elif kind == 'annotation':
                info = flags.get(item_id, {})
                layer_id = effective_layer(item_layer(item_id, item['layerId']), chain)
                visibility = 'hidden' if inherited_hidden else entity_visibility(item_id, layer_id, viewport)
                # An ATTDEF draw is a definition with no own presentation: the displayed
                # value is the ATTRIB that map_insert materializes for each INSERT. A
                # DIMENSION without a presentation block is likewise not drawable.
                availability = ('missing-reference' if info.get('attributeTemplate')
                                or info.get('presentationGeometry') == 'missing' else 'ready')
                source_style = annotation_styles.get(item_id, {'color': {'mode': 'by-layer'}, 'plot': True})
                style = resolve(source_style, layer_id, chain, item_id)
                if item.get('fontResourceId'):
                    style['fontResourceId'] = item['fontResourceId']
                add_draw('annotation', item_id, path, transform, visibility, availability,
                         style, None, viewport['id'] if viewport else None, layer_id)
            else:
                definition = m['blocks'].get(item['definitionId'])
                layer_id = effective_layer(item['layerId'], chain)
                if definition is None:
                    style = resolve(item['style'], layer_id, chain, item_id)
                    add_draw('blockInstance', item_id, path, transform, 'hidden', 'missing-reference', style, None,
                             viewport['id'] if viewport else None, layer_id)
                    continue
                style = resolve(item['style'], layer_id, chain, item_id)
                array = item.get('array')
                placements = [(0, 0, mat_mul(transform, item['localFromBlock']))]
                if array:
                    placements = []
                    for row in range(array['rows']):
                        for column in range(array['columns']):
                            offset = mat_translate(array['columnOffset'][0] * column + array['rowOffset'][0] * row,
                                                   array['columnOffset'][1] * column + array['rowOffset'][1] * row,
                                                   array['columnOffset'][2] * column + array['rowOffset'][2] * row)
                            placements.append((row, column, mat_mul(mat_mul(transform, offset), item['localFromBlock'])))
                for row, column, placement in placements:
                    child_path = path + [{'instanceId': item_id, 'row': int(row), 'column': int(column)}]
                    hidden = inherited_hidden or entity_visibility(item_id, layer_id, viewport) == 'hidden'
                    walk(definition['spaceId'], placement, child_path, viewport,
                         chain + [(item['style'], layer_id, item_id)], hidden)

    if layout_id:
        for vid in m['layouts'][layout_id]['viewportIds']:
            viewport = m['viewports'][vid]
            if not viewport['enabled']:
                continue
            walk(drawing_row['modelSpaceId'], viewport['modelToPaper'], [], viewport, [])
        walk(space_id, mat_identity(), [], None, [])
    else:
        walk(space_id, mat_identity(), [], None, [])

    return {'drawingId': drawing_id, 'target': {'kind': 'model', 'spaceId': drawing_row['modelSpaceId']}
            if not layout_id else {'kind': 'layout', 'layoutId': layout_id},
            'viewports': {vid: m['viewports'][vid] for vid in viewports},
            'layerStates': layer_states, 'draws': draws}
