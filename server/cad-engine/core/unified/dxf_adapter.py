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
from .dxf_runtime import ENGINE, require_engine, source_digest
from . import dxf_annotations, dxf_tolerance, dxf_gradients, dxf_recovery, dxf_xref, dxf_shx, dxf_media, dxf_mtext, dxf_clipping, dxf_stroke, dxf_linetype, dxf_proxy
from .dxf_fill import (boundary_paths, hatch_style, hatch_style_name, is_gradient_hatch,
                       is_solid_hatch, pattern_strokes, MAX_PATTERN_SEGMENTS,
                       solid_polygon, triangulate)
from .migrate import seal
from .payload_sink import Base64Sink
from .validation import validate_binary_envelope, validate_envelope
from . import stageprof

# Measured: schema validation costs ~0.9 ms per source record, so 20k records stay
# well inside the 60 s worker budget. Larger files fail with a clean limit error
# instead of hitting the timeout.
MAX_ENTITIES = 20000
MAX_PROJECTION_DRAWS = 400000
MAX_DOCUMENT_PATTERN_SEGMENTS = 250000
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
FILL_ENTITIES = ('SOLID', 'TRACE', 'HATCH')
UNSUPPORTED_REASONS = {
    '3DFACE': 'filled 3D face is outside the 2D drawing contract',
    'MESH': 'subdivision mesh is outside the 2D drawing contract',
    '3DSOLID': 'ACIS solid is outside the 2D drawing contract',
    'BODY': 'ACIS body is outside the 2D drawing contract',
    'SURFACE': 'procedural surface is outside the 2D drawing contract',
    'HELIX': 'helix is outside the 2D drawing contract',
}


def _v3(point):
    # Source numeric tags were validated before parsing/recovery. An omitted Z
    # is the DXF 2D coordinate convention, never a replacement for an invalid Z.
    return [float(point[0]), float(point[1]), float(point[2] if len(point) > 2 else 0.0)]


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
    true_color = layer.dxf.get('true_color', None)
    if true_color is not None:
        return [round((true_color >> shift & 255) / 255, 9) for shift in (16, 8, 0)] + [1.0]
    rgba = _aci_rgba(abs(layer.dxf.get('color', 7)))
    return rgba if rgba is not None else [1.0, 1.0, 1.0, 1.0]


def _entity_rgba(entity):
    true_color = entity.dxf.get('true_color', None)
    if true_color is not None:
        return [round((true_color >> shift & 255) / 255, 9) for shift in (16, 8, 0)] + [1.0]
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


def read_dxf(path, raw, sink=None, name=None, resources=None, logical_path=None):
    """Parse a real DXF file and return a validated UCD 2.0 envelope."""
    sink = sink or Base64Sink()
    ezdxf = require_engine()
    if not raw or len(raw) > 64 * 1024 * 1024:
        raise ValueError('DXF input must be 1 byte to 64 MiB')
    from . import worker_trace
    worker_trace.mark('runtimeReady');worker_trace.mark('parseStart')
    started = time.perf_counter()
    sha = hashlib.sha256(raw).hexdigest()
    sid = 'source-' + sha
    drawing_id = 'drawing-' + sha
    stageprof.mark('dxf.read-start', bytes=len(raw))
    doc, recovery = dxf_recovery.load_dxf(path, raw)
    stageprof.mark('dxf.parse', seconds=round(time.perf_counter() - started, 4))
    code = doc.dxfversion
    if code not in RELEASE:
        raise ValueError('unsupported-dxf-version: ' + str(code))
    name = name or Path(path).name
    xrefs = dxf_xref.load_references(doc, raw, logical_path or name, resources, recovery)
    shx = dxf_shx.Resources(doc, xrefs, resources)
    block_clips = {}
    layer_opacities, viewport_opacities = {}, {}
    media = dxf_media.Resources(doc, xrefs, resources, shx)
    mtext = dxf_mtext.Resources(xrefs)
    mapped_origins = {}
    record_indices = {}

    def source_item_id(prefix, handle, fallback):
        item_id = xrefs.item_id(prefix, handle, fallback)
        origin = xrefs.origins.get(str(handle))
        if origin:
            mapped_origins[item_id] = {'sourceRefs': origin['sourceRefs'], 'referenceIds': origin['chain']}
        return item_id

    evidence = [
        {'id': 'dxf-spec', 'kind': 'standard',
         'reference': 'Autodesk DXF Reference (group codes, entity and table definitions)',
         'scope': 'Format vocabulary for parsing/mapping; no site-specific behavior'},
        {'id': 'ezdxf', 'kind': 'official', 'reference': 'ezdxf ' + ENGINE, 'version': ENGINE,
         'scope': 'Pinned open-source DXF reader/writer API used for parsing and spline evaluation'},
        {'id': 'cadcraft-display', 'kind': 'official',
         'reference': 'https://github.com/storytold/cadcraft/tree/0cf3bdea83ebbe02fb2e674b23f07de4acfa73da',
         'version': '0cf3bdea83ebbe02fb2e674b23f07de4acfa73da',
         'scope': 'MIT GDT frame parser/layout/symbols; display only'},
        {'id':'truedxf-display','kind':'official',
         'reference':'https://github.com/tth05/truedxf/tree/019c2e504738965c17818a5780097fef0e7a52f4',
         'version':'019c2e504738965c17818a5780097fef0e7a52f4',
         'scope':'selective dash/glyph, SHIFT gradient, planar ACIS curve, pen and raster fill/underlay display rules; community CAD evidence is not independent local acceptance'},
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
         'sources': [{**source, 'name': name if source['id'] == sid else source['name']} for source in xrefs.sources.values()],
         'adapter': {'id': 'ezdxf-dxf', 'version': '0.15.0',
                     'implementationHash': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                     'ruleSetHash': digest({'ezdxf': ENGINE, 'ezdxfSourceHash': source_digest(),
                                            'tolerance': RELATIVE_TOLERANCE,
                                            'maxAngularStep': MAX_ANGULAR_STEP,
                                            'maxCurveSegments': MAX_CURVE_SEGMENTS,
                                            'hatchPatterns': 'stored-definition-polygon-clipping/1',
                                            'annotations': 'ezdxf-parameter-renderer-glyph-paths/1',
                                            'annotationImplementation': hashlib.sha256(Path(dxf_annotations.__file__).read_bytes()).hexdigest(),
                                            'strokeImplementation': hashlib.sha256(Path(dxf_stroke.__file__).read_bytes()).hexdigest(),
                                            'lineTypeImplementation': hashlib.sha256(Path(dxf_linetype.__file__).read_bytes()).hexdigest(),
                                            'proxyImplementation': hashlib.sha256(Path(dxf_proxy.__file__).read_bytes()).hexdigest(),
                                            'fillImplementation': hashlib.sha256(Path(__file__).with_name('dxf_fill.py').read_bytes()).hexdigest(),
                                            'toleranceFrameImplementation': hashlib.sha256(Path(dxf_tolerance.__file__).read_bytes()).hexdigest(),
                                            'gradientImplementation': hashlib.sha256(Path(dxf_gradients.__file__).read_bytes()).hexdigest(),
                                            'recoveryImplementation': hashlib.sha256(Path(dxf_recovery.__file__).read_bytes()).hexdigest(),
                                            'xrefImplementation': hashlib.sha256(Path(dxf_xref.__file__).read_bytes()).hexdigest(),
                                            'shxImplementation': hashlib.sha256(Path(dxf_shx.__file__).read_bytes()).hexdigest(),
                                            'shxContainerImplementation': hashlib.sha256(Path(__file__).with_name('dxf_shxfont.py').read_bytes()).hexdigest(),
                                            'bigfontImplementation': hashlib.sha256(Path(dxf_shx.dxf_bigfont.__file__).read_bytes()).hexdigest(),
                                            'verticalImplementation': hashlib.sha256(Path(__file__).with_name('dxf_vertical.py').read_bytes()).hexdigest(),
                                            'dwgImplementation': hashlib.sha256(Path(dxf_xref.dxf_dwg.__file__).read_bytes()).hexdigest(),
                                            'dwgReaderSpec': dxf_xref.dxf_dwg.SPEC,
                                            'mediaImplementation': hashlib.sha256(Path(dxf_media.__file__).read_bytes()).hexdigest(),
                                            'mtextImplementation': hashlib.sha256(Path(dxf_mtext.__file__).read_bytes()).hexdigest(),
                                            'additional2dImplementations': {name:hashlib.sha256(Path(__file__).with_name(name+'.py').read_bytes()).hexdigest()
                                                for name in ('dxf_scale','dxf_semantics','dxf_fields','dxf_region','dxf_ole','dxf_underlays','dxf_plotstyles')},
                                            'mediaReaders':dxf_media.VERSIONS,
                                            'patternSegmentsPerEntity': MAX_PATTERN_SEGMENTS,
                                            'patternSegmentsPerDocument': MAX_DOCUMENT_PATTERN_SEGMENTS}),
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
    from . import dxf_scale
    annotation_scale = dxf_scale.read(doc)
    model_line_type_factor = annotation_scale['modelLineTypeFactor']
    m = d['drawing']
    m['drawings'][drawing_id] = {'id': drawing_id, 'name': Path(name).stem,
                                 'sourceIds': list(xrefs.sources), 'modelSpaceId': '', 'sheetIds': [],
                                 'layoutIds': [], 'layerIds': [], 'units': unit_fact}

    # ----- line types / layers / text styles ---------------------------------
    line_type_ids = {}
    complex_line_types = []
    line_type_patterns = {}
    line_type_definitions = {}
    line_type_periods = {}
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
        # Use ezdxf's compiler for merged dashes, leading gaps and dot entries.
        # It explicitly returns continuous for unsupported embedded text/shapes.
        # Both this display pattern and the source segments already include LTSCALE.
        line_type_patterns[ltid] = [float(value) * ltscale for value in lt.simplified_line_pattern()]
        line_type_definitions[ltid] = dxf_linetype.definition(lt)
        line_type_periods[ltid] = float(next((tag.value for tag in tags if tag.code == 40), 0))
        m['lineTypes'][ltid] = {'id': ltid, 'name': ltname, 'segments': segments,
                                'unit': 'source-units (pattern lengths x $LTSCALE=' + str(ltscale) + ')'}

    layer_ids = {}
    for layer in doc.layers:
        lname = layer.dxf.name
        lid = source_item_id('layer', layer.dxf.handle, [sha, lname])
        layer_ids[lname] = lid
        layer_opacities[lid] = 1 - layer.transparency
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
        if recovery and lname in recovery['displayDefaultLayers']:
            m['layers'][lid]['sourceRefs'] = []
        elif str(layer.dxf.handle) in xrefs.origins:
            m['layers'][lid]['sourceRefs'] = xrefs.origins[str(layer.dxf.handle)]['sourceRefs']
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
    preserved_blocks = set(recovery.get('preservedOrphanBlocks', [])) if recovery else set()
    for layout in doc.layouts:
        try:
            layout_block_names.add(layout.block_record_name)
        except Exception:
            pass
    for block_layout in doc.blocks:
        block_name = block_layout.name
        if block_name in preserved_blocks:
            continue
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
        bid = source_item_id('block', block_layout.block.dxf.handle, [sha, bname])
        spid = source_item_id('space', block_layout.block.dxf.handle, [sha, 'block', bname])
        block_ids[bname] = bid
        block_space_ids[bname] = spid
        block = block_layout.block
        base = _v3(block.dxf.get('base_point', (0, 0, 0)))
        bdef = {'id': bid, 'drawingId': drawing_id, 'name': bname, 'spaceId': spid,
                'basePoint': base, 'units': unit_fact, 'dynamicParameters': {}}
        block_handles[bname] = block.dxf.handle
        # BLOCK group 1 may survive in an ordinary embedded block. Only the
        # library's group-70 XREF/overlay flags establish an external reference.
        if block.is_xref or block.is_xref_overlay:
            xref = block.dxf.get('xref_path', '') or ''
            reference = xrefs.references.get(str(block.dxf.handle))
            if reference is None:
                raise ValueError('xref-provenance-missing: ' + bname)
            bdef['externalReferenceId'] = reference['id']
            d['externalReferences'].append({key: reference[key] for key in
                ('id', 'ownerSourceId', 'requestedPath', 'status', 'required', 'reason', 'logicalPath', 'candidates') if key in reference})
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
            self.groups = {}
            self.variant_groups = {}

        def add(self, item_id, points, segments, topology, source_refs):
            if not points:
                return None
            base = len(self.positions) // 8
            for point in points:
                self.positions += struct.pack('<3d', float(point[0]), float(point[1]), float(point[2]))
            count = len(points)
            if topology == 'points':
                index_offset = None
                index_count = len(points)
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
            for item_id, (parts, refs) in self.groups.items():
                document['representations'][identity('representation', [item_id])] = {
                    'id': identity('representation', [item_id]), 'kind': 'drawing',
                    'bindings': [dict(document['representations'][part['representationId']]['bindings'][0],
                                      id=part['id']) for part in parts], 'sourceRefs': refs}
            for rid, (parts, refs) in self.variant_groups.items():
                document['representations'][rid] = {'id': rid, 'kind': 'drawing',
                    'bindings': [dict(document['representations'][part['representationId']]['bindings'][0],
                                      id=str(index)) for index, part in enumerate(parts)], 'sourceRefs': refs}

    display = Display()

    # ----- entity mapping -----------------------------------------------------
    counts = Counter()
    unsupported = Counter()
    partial = Counter()
    losses = [('external-reference-unresolved', ref['requestedPath'] + ': ' + ref['reason'])
              for ref in d['externalReferences'] if ref['required'] and ref['status'] != 'resolved']
    if recovery:
        losses.append(('source-recovery-partial', recovery['mode']))
    style_modes = {}
    annotation_styles = {}
    entity_flags = {}
    dimensions_with_geometry = 0
    dimensions_without_geometry = 0
    display_ok = Counter()
    display_missing = Counter()
    annotation_presentations = {}
    presentation_vertices = 0
    stroke_sources = {}
    annotation_contexts = {}
    from . import dxf_plotstyles
    plot_styles = dxf_plotstyles.collect(doc,xrefs,resources,
        [(doc.layouts.get('Model'),'model')]+[(layout,lid) for layout,lid,_ in paper_layouts],layer_ids)

    def source_ref(space_key, handle, index):
        if str(handle) in xrefs.origins:
            return dict(xrefs.origins[str(handle)]['sourceRefs'][0])
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

    def record_style_modes(item_id, entity, source_item=False):
        mode = {}
        origin=xrefs.origin(entity.dxf.handle)
        if source_item and entity.dxf.handle and item_id not in annotation_contexts:
            try:
                if origin and origin.get('annotationContextError'):raise ValueError(origin['annotationContextError'])
                contexts=origin.get('annotationContexts') if origin else None
                if contexts is None:contexts=dxf_scale.object_contexts(entity,annotation_scale)
                if contexts:annotation_contexts[item_id]={'status':'source-retained','contexts':contexts}
            except ValueError as error:annotation_contexts[item_id]={'status':'partial','reason':str(error)}
        plot_styles['traits'][item_id]={**(origin['plotTrait'] if origin and 'plotTrait' in origin else dxf_plotstyles.trait(entity)),
                                       'layerId':layer_ids.get(entity.dxf.get('layer','0'),layer_ids['0'])}
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
        ltype_scale = float(entity.dxf.get('ltscale', 1.0))
        if ltype_scale != 1.0 and math.isfinite(ltype_scale) and ltype_scale > 0.0:
            entity_flags.setdefault(item_id, {})['lineTypeScale'] = ltype_scale
        if entity.dxf.get('invisible', 0) == 1:
            entity_flags.setdefault(item_id, {})['invisible'] = True
        opacity = entity_flags.setdefault(item_id, {})
        transparency = entity.dxf.get('transparency', None)
        opacity['opacityMode'] = ('by-layer' if transparency is None else
                                  'by-block' if transparency == 0x1000000 else 'explicit')
        if opacity['opacityMode'] == 'explicit':
            opacity['opacity'] = (int(transparency) & 255) / 255

    # ----- filled entities (SOLID / solid HATCH) -----------------------------
    # UCD 2.0 Hatch can only reference boundary *entities*, not inline paths. The
    # adapter therefore keeps the source boundary as derived polyline entities in an
    # uninstantiated block space (no draw is emitted for them) and stores the exact
    # analytic boundary in extensions["org.cad-preview.fill/1"]. Entity.geometry stays
    # a typed Hatch; display triangles are a separate representation.
    boundary_block = {'blockId': None, 'spaceId': None, 'name': None}
    fill_registry = {}
    fill_skips = []
    pattern_segment_count = 0
    gradient_stops = None

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
        nonlocal pattern_segment_count, gradient_stops
        kind = entity.dxftype()
        skipped_textbox = 0
        style_code = 0
        pattern_name = ''
        solid = kind != 'HATCH' or is_solid_hatch(entity)
        gradient_spec = None
        if kind == 'HATCH':
            style_code = hatch_style(entity)
            pattern_name = str(entity.dxf.get('pattern_name', '') or '')
            # 0 odd parity (even-odd), 1 outer, 2 ignore. Styles 1/2 select their
            # boundary paths by group-92 flags inside boundary_paths(); a multipath
            # hatch with no EXTERNAL/OUTERMOST selection is refused there.
            if style_code not in (0, 1, 2):
                raise ValueError('hatch-style-unsupported:%d' % style_code)
            rings, skipped_textbox = boundary_paths(entity)
            if is_gradient_hatch(entity):
                if gradient_stops is None:
                    gradient_stops = dxf_gradients.source_stops(raw, doc.output_encoding)
                basis = ocs_matrix(entity)
                basis[12:15] = list(entity.ocs().to_wcs((0, 0, entity.dxf.elevation.z)))
                gradient_spec = dxf_gradients.display_spec(entity, rings, gradient_stops, basis)
                solid = True
        else:
            polygon = solid_polygon(entity)
            rings = [{'points': polygon['points'], 'points2d': polygon['points2d'],
                      'bulges': [0.0] * len(polygon['points']),
                      'analytic': {'type': 'solid-polygon'}, 'flags': 0}]
        if solid:
            points, triangles = triangulate(rings)
            segments = []
        else:
            points, segments = pattern_strokes(entity, rings,
                                               MAX_DOCUMENT_PATTERN_SEGMENTS - pattern_segment_count)
            pattern_segment_count += len(segments)
            triangles = None
        geometry = {'type': 'hatch', 'boundaryEntityIds': [], 'fillRule': 'even-odd'}
        if not solid:
            lines = [{'angle': math.radians(line.angle), 'origin': list(line.base_point),
                      'offset': list(line.offset), 'dashes': list(line.dash_length_items)}
                     for line in entity.pattern.lines]
            pattern_id = identity('hatch-pattern', [pattern_name, lines])
            m['hatchPatterns'][pattern_id] = {'id': pattern_id, 'name': pattern_name, 'lines': lines}
            # Effective definition already includes DXF scale/rotation. Retain the
            # source header values in the registry, not as a second transform.
            geometry.update(patternId=pattern_id, scale=1.0, angle=0.0)
        ids = []
        boundaries = []
        for index, ring in enumerate(rings):
            ids.append(add_boundary_entity(entity, ref, layer_id, style, index,
                                           ring['points'], ring['bulges']))
            boundaries.append({'entityId': ids[index], 'pathTypeFlags': ring['flags'],
                               'analytic': ring['analytic']})
        geometry['boundaryEntityIds'] = ids
        return {'geometry': geometry, 'points': points, 'triangles': triangles, 'segments': segments,
                'record': {'sourceKind': kind,
                           'hatchStyle': style_code,
                           'hatchStyleName': hatch_style_name(style_code) if kind == 'HATCH' else None,
                           'patternName': pattern_name if kind == 'HATCH' else None,
                           'fillRule': 'even-odd', 'solid': solid,
                           'textboxPathsSkipped': skipped_textbox,
                           'boundaryEntityIds': ids, 'boundaries': boundaries,
                           'triangleCount': len(triangles) if triangles is not None else 0,
                           **({'gradient': gradient_spec} if gradient_spec else {}),
                           **({'segmentCount': len(segments),
                               'sourcePatternScale': float(entity.dxf.pattern_scale),
                               'sourcePatternAngleDegrees': float(entity.dxf.pattern_angle),
                               'patternOriginJiggled': False} if not solid else {})}}

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
            radius = float(entity.dxf.radius)
            if radius <= 0:
                raise ValueError('non-positive radius')
            points = arc_points(center, (1, 0, 0), (0, 1, 0), radius, 0.0, 2.0 * math.pi)
            geometry = {'type': 'arc', 'center': center, 'normal': [0.0, 0.0, 1.0],
                        'xAxis': [1.0, 0.0, 0.0], 'radius': radius,
                        'startAngle': 0.0, 'sweepAngle': 2.0 * math.pi}
            return geometry, points, [(i, i + 1) for i in range(len(points) - 1)], 'lines', ocs_matrix(entity)
        if kind == 'ARC':
            center = _v3(entity.dxf.center)
            radius = float(entity.dxf.radius)
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
            widths = dxf_stroke.segment_widths(entity, len(geometry['bulges']))
            if widths: geometry['widths'] = widths
            display_points, segments = _polyline_display(entity, points[0])
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
            elevation = _v3(entity.dxf.get('elevation', (0, 0, 0)))[2]
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
            widths = dxf_stroke.segment_widths(entity, len(geometry['bulges']))
            if widths: geometry['widths'] = widths
            display_points, segments = _polyline_display(entity, points[0])
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

    def _polyline_display(entity, first_point):
        # ezdxf supplies exact LINE/ARC leaves, including the closing edge and
        # signed bulges. Keep the existing arc discretisation policy and source
        # OCS; virtual leaves never become new source identities.
        ocs = entity.ocs()
        display = []
        segments = []
        cursor = first_point
        for leaf in entity.virtual_entities():
            _, points, _, _, matrix = tessellate_entity(leaf)
            points = [_v3(ocs.from_wcs(_apply(matrix, point))) for point in points]
            # ARC leaves are always CCW; a negative bulge traverses them backwards.
            if not _same(cursor, points[0]) and _same(cursor, points[-1]):
                points.reverse()
            if not _same(cursor, points[0]):
                raise ValueError('polyline virtual segment does not join source vertices')
            cursor = points[-1]
            if display and _same(display[-1], points[0]):
                start_index = len(display) - 1
                display.extend(points[1:])
            else:
                start_index = len(display)
                display.extend(points)
            segments.extend((start_index + k, start_index + k + 1) for k in range(len(points) - 1))
        if not display:
            raise ValueError('polyline has no drawable virtual segments')
        return display, segments

    def _same(a, b):
        return abs(a[0] - b[0]) < 1e-9 and abs(a[1] - b[1]) < 1e-9 and abs(a[2] - b[2]) < 1e-9

    def _normalize(v):
        n = math.sqrt(sum(x * x for x in v))
        return [v[0] / n, v[1] / n, v[2] / n] if n > 1e-12 else [0.0, 0.0, 1.0]

    def _cross(a, b):
        return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

    def annotation_presentation(entity, item_id, ref, origin_entity=None):
        """Atomic display derivative: every generated leaf must be mapped.

        Parts have no synthetic source handles and never enter source counts or
        spaces. All parts select the original item/draw. Style chains preserve
        layer-0/BYBLOCK inheritance through virtual INSERT arrowheads/content.
        """
        pending, fonts_used, construction_points, pending_vertices = [], [], 0, 0
        original_geometry = entity.dxf.get('geometry', None) if entity.dxftype() == 'DIMENSION' else None
        source=origin_entity if origin_entity is not None else entity
        resource_context = {**shx.context(source, [ref]), 'itemId': item_id, 'sourceTextStyleNames': text_style_ids}
        if origin_entity is not None and resource_context.get('fontStyle'):
            # This explicit source-derived text copy keeps its original style;
            # arbitrary virtual MTEXT/proxy runs still require their own binding.
            resource_context['virtualFontStyles']={entity.dxf.get('style','Standard'):resource_context['fontStyle']}
        if (origin := xrefs.origin(source.dxf.handle)) and 'proxyTables' in origin:
            resource_context['proxyTables'] = origin['proxyTables']
        try:
            if entity.dxftype() in ('MTEXT', 'TEXT', 'ATTRIB', 'ATTDEF'):
                binding = shx.binding(entity, [ref], resource_context)
                if binding and binding['status'] != 'resolved':
                    shx.fallback(item_id, [ref], binding)
            if entity.dxftype() in ('XLINE', 'RAY'):
                origin, direction = _v3(entity.dxf.start), _v3(entity.dxf.unit_vector)
                if sum(v * v for v in direction) <= 1e-24:
                    raise ValueError('infinite-line-zero-direction')
                # These entities have no finite engineering extent. Keep the source
                # ray/line and clip in the viewer. Only a finite clipping region
                # supplies fit extents; never bake an arbitrary long source LINE.
                part_id = identity('annotation-part', [item_id, 0])
                record_style_modes(part_id, entity)
                annotation_presentations[item_id] = {
                    'status': 'ready', 'sourceKind': entity.dxftype(), 'sourceRefs': [ref],
                    'mode': 'view-dependent', 'method': 'DXF-parametric-view-clipping',
                    'parts': [{'id': part_id, 'role': 'infinite',
                               'line': {'kind': entity.dxftype().lower(), 'origin': origin, 'direction': direction},
                               'layerId': layer_ids[entity.dxf.layer],
                               'style': source_style(entity, entity.dxf.layer), 'ancestors': []}]}
                return True
            for leaf, ancestors in dxf_annotations.primitives(entity, doc, shx, [ref], resource_context, mtext):
                # Same default as ezdxf drawing Frontend.draw_point_entity():
                # DEFPOINTS are construction anchors, not dimension artwork.
                if leaf.dxftype() == 'POINT' and leaf.dxf.layer.lower() == 'defpoints':
                    construction_points += 1
                    continue
                if leaf.dxftype() in ('LWPOLYLINE', 'POLYLINE') and leaf.has_width:
                    leaf_geometry, _, _, _, matrix = tessellate_entity(leaf)
                    if leaf_geometry.get('widths'):
                        batches = dxf_stroke.display_parts(leaf, _segments_for_arc(2 * math.pi, 1),
                                                          dxf_annotations.MAX_VERTICES - presentation_vertices - pending_vertices)
                        for points, indices, topology in batches:
                            pending.append((leaf, ancestors, [_apply(matrix, point) for point in points], indices, topology))
                            pending_vertices += len(points)
                        continue
                font = None
                if leaf.dxftype() in ('TEXT', 'ATTRIB', 'ATTDEF'):
                    points, indices, topology, font = dxf_annotations.text_geometry(leaf, shx, [ref], resource_context)
                elif leaf.dxftype() == 'SHAPE':
                    points, indices, topology, font = shx.shape_geometry(leaf, [ref], resource_context)
                elif leaf.dxftype() in ('SOLID', 'TRACE'):
                    points = [list(point) for point in leaf.wcs_vertices()]
                    indices = [(0, i, i + 1) for i in range(1, len(points) - 1)]
                    topology = 'triangles'
                elif leaf.dxftype() == 'HATCH':
                    if not is_solid_hatch(leaf) or is_gradient_hatch(leaf):
                        raise ValueError('presentation-non-solid-hatch-unsupported')
                    rings, _ = boundary_paths(leaf)
                    points, indices = triangulate(rings)
                    topology = 'triangles'
                elif leaf.dxftype() == 'WIPEOUT':
                    # ezdxf drawing.Frontend.draw_wipeout_entity uses exactly this
                    # WCS polygon and the layout background, without an IMAGEDEF.
                    points = [list(point) for point in leaf.boundary_path_wcs()]
                    if len(points) > 1 and points[0] == points[-1]:
                        points.pop()
                    from ezdxf.math import triangulation
                    triangles = list(triangulation.mapbox_earcut_3d(points))
                    points = [list(p) for tri in triangles for p in tri]
                    indices = [(i, i + 1, i + 2) for i in range(0, len(points), 3)]
                    topology = 'triangles'
                else:
                    _, points, indices, topology, matrix = tessellate_entity(leaf)
                    points = [_apply(matrix, point) for point in points]
                if not points:
                    continue  # Whitespace has no glyph contours.
                pending.append((leaf, ancestors, points, indices, topology))
                pending_vertices += len(points)
                if font and font not in fonts_used:
                    fonts_used.append(font)
                if presentation_vertices + pending_vertices > dxf_annotations.MAX_VERTICES:
                    raise ValueError('annotation-document-vertex-budget')
            if not pending:
                raise ValueError('annotation-presentation-empty')
        except Exception as error:
            mtext.fail(item_id, type(error).__name__ + ': ' + str(error))
            if entity.dxftype() == 'SHAPE' or any(marker in str(error) for marker in ('shx-', 'font-', 'vertical-text-')):
                shx.failure(item_id, [ref], type(error).__name__ + ': ' + str(error))
            annotation_presentations[item_id] = {
                'status': 'missing', 'sourceKind': entity.dxftype(), 'sourceRefs': [ref],
                'reason': type(error).__name__ + ': ' + str(error), 'parts': []}
            losses.append(('annotation-presentation-failed', str(entity.dxf.handle) + ': ' + str(error)))
            return False
        return save_presentation(entity, item_id, ref, pending, fonts_used, construction_points, original_geometry)

    def save_presentation(entity, item_id, ref, pending, fonts_used=(), construction_points=0,
                          original_geometry=None, method=None, local_geometry=False):
        """One source identity, shared styling and bounded derived primitive batches."""
        nonlocal presentation_vertices
        parts = []
        seen_strokes = {}
        for index, (leaf, ancestors, points, indices, topology) in enumerate(pending):
            part_id = identity('annotation-part', [item_id, index])
            layer_name = leaf.dxf.get('layer', '0')
            record_style_modes(part_id, leaf)
            owner_opacity = entity_flags[item_id]
            if entity_flags[part_id]['opacityMode'] == 'by-layer' and owner_opacity['opacityMode'] != 'by-layer':
                # Generated primitives have no independent source transparency.
                # Retain the owning object's explicit/BYBLOCK choice rather than
                # accidentally replacing it with the viewport's layer opacity.
                entity_flags[part_id]['opacityMode'] = owner_opacity['opacityMode']
                if 'opacity' in owner_opacity:
                    entity_flags[part_id]['opacity'] = owner_opacity['opacity']
            chain = []
            for depth, ancestor in enumerate(ancestors):
                ancestor_id = identity('annotation-style', [item_id, index, depth])
                record_style_modes(ancestor_id, ancestor)
                name = ancestor.dxf.get('layer', '0')
                chain.append({'id': ancestor_id, 'layerId': layer_ids.get(name, layer_ids['0']),
                              'style': source_style(ancestor, name)})
            rid = (display.add_fill(part_id, points, indices, [ref]) if topology == 'triangles'
                   else display.add(part_id, points, indices, topology, [ref]))
            parts.append({'id': part_id, 'representationId': rid,
                          'role': ('text' if leaf.dxftype() in ('TEXT', 'ATTRIB', 'ATTDEF') else
                                   'mask' if leaf.dxftype() == 'WIPEOUT' else 'geometry'),
                          'layerId': layer_ids.get(layer_name, layer_ids['0']),
                          'style': source_style(leaf, layer_name), 'ancestors': chain})
            if getattr(leaf,'_cad_clip_regions',None): parts[-1]['clipRegions']=leaf._cad_clip_regions
            if topology == 'triangles' and leaf.dxftype() in ('LWPOLYLINE', 'POLYLINE'):
                parts[-1]['role'] = 'stroke'
                parts[-1]['fillRule'] = 'nonzero'
            if leaf.dxftype() in dxf_linetype.CURVES and (plot_styles['tables'] or complex_line_types or model_line_type_factor != 1 or leaf.dxftype() in ('LWPOLYLINE', 'POLYLINE') and leaf.has_width):
                # Several batches (band + zero-width edges) can belong to one
                # path. Its patterned replacement is emitted exactly once.
                key = id(leaf)
                if key in seen_strokes:
                    parts[-1]['patternContinuation'] = seen_strokes[key]
                else:
                    seen_strokes[key] = part_id
                    parts[-1]['patternedStroke'] = True
                    stroke_sources[part_id] = (leaf, local_geometry, ref, entity)
            presentation_vertices += len(points)
        annotation_presentations[item_id] = {
            'status': 'ready', 'sourceKind': entity.dxftype(), 'sourceRefs': [ref],
            'method': method or ('cadcraft-gdt-layout+ezdxf-glyphs/1' if entity.dxftype() == 'TOLERANCE'
                       else 'ezdxf-' + ENGINE + '-parameter-renderer'),
            'fonts': list(fonts_used), 'constructionPointsOmitted': construction_points, 'parts': parts}
        if getattr(entity,'_cad_proxy_ignored_3d',None):
            annotation_presentations[item_id]['ignored3dMaterialCommands']=entity._cad_proxy_ignored_3d
        if entity.dxftype() == 'DIMENSION':
            annotation_presentations[item_id]['sourceGeometryBlock'] = original_geometry
        display.groups[item_id] = (parts, [ref])
        return True

    def map_entity(entity, space_id, space_key, index):
        kind = entity.dxftype()
        handle = entity.dxf.handle
        item_id = source_item_id('entity', handle, [sha, space_key, str(handle)])
        record_indices[item_id] = index
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
        record_style_modes(item_id, entity,source_item=True)
        if kind in ('IMAGE', 'PDFUNDERLAY', 'OLE2FRAME', 'DGNUNDERLAY', 'DWFUNDERLAY'):
            geometry, corners, source_on = media.map(entity, item_id, [ref])
            ready = bool(corners)
            if ready:
                display.add(item_id, corners, [(0, 1), (1, 2), (2, 3), (3, 0)], 'lines', [ref])
                display_ok[kind] += 1
                if not source_on:
                    entity_flags.setdefault(item_id, {})['invisible'] = True
            else:
                unsupported[kind] += 1
                display_missing[kind] += 1
                losses.append(('media-presentation-missing', str(handle) + ': ' + geometry['reason']))
            m['entities'][item_id] = {'id': item_id, 'drawingId': drawing_id, 'ownerSpaceId': space_id,
                'layerId': layer_id, 'localFromOwner': mat_identity(), 'geometry': geometry,
                'style': style, 'sourceRefs': [ref], 'displayOrder': int(index)}
            m['spaces'][space_id]['entityIds'].append(item_id)
            return ('entity', item_id, ready)
        if kind in ('LEADER', 'MULTILEADER', 'MLINE', 'ACAD_TABLE', 'ACAD_PROXY_ENTITY', 'WIPEOUT', 'XLINE', 'RAY', 'TOLERANCE', 'SHAPE', 'REGION') or getattr(entity,'proxy_graphic',None) and kind not in CORE_ENTITIES:
            ready = annotation_presentation(entity, item_id, ref)
            # UCD's analytic Entity union has no LEADER type. Keep that semantic
            # gap explicit while the separately validated presentation is drawable.
            m['entities'][item_id] = {
                'id': item_id, 'drawingId': drawing_id, 'ownerSpaceId': space_id,
                'layerId': layer_id, 'localFromOwner': mat_identity(),
                'geometry': {'type': 'unsupported', 'sourceType': kind,
                             'reason': annotation_presentations[item_id]['reason'] if kind == 'SHAPE' and not ready else
                                 'Analytic ' + kind + ' semantics retained by source reference; display uses explicit presentation'},
                'style': style, 'sourceRefs': [ref], 'displayOrder': int(index)}
            m['spaces'][space_id]['entityIds'].append(item_id)
            (display_ok if ready else display_missing)[kind] += 1
            if not ready:
                unsupported[kind] += 1
            partial[kind.lower() + '-semantics'] += 1
            return ('entity', item_id, ready)
        unsupported_reason = UNSUPPORTED_REASONS.get(kind)
        geometry = None
        points = []
        segments = []
        triangles = None
        topology = 'lines'
        local_matrix = mat_identity()
        fill = None
        if unsupported_reason is None and kind in FILL_ENTITIES:
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
            segments = fill['segments']
            topology = 'triangles' if triangles is not None else 'lines'
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
        ready = True
        if geometry.get('widths'):
            try:
                batches = dxf_stroke.display_parts(entity, _segments_for_arc(2 * math.pi, 1),
                                                  dxf_annotations.MAX_VERTICES - presentation_vertices)
                save_presentation(entity, item_id, ref, [(entity, [], p, i, t) for p, i, t in batches],
                                  method='ezdxf-TraceBuilder/1', local_geometry=True)
            except ValueError as error:
                ready = False
                annotation_presentations[item_id] = {'status': 'missing', 'sourceKind': kind,
                    'sourceRefs': [ref], 'reason': str(error), 'parts': []}
                losses.append(('polyline-width-presentation-failed', str(handle) + ': ' + str(error)))
                unsupported[kind] += 1
        elif triangles is not None:
            display.add_fill(item_id, points, triangles, [ref])
        elif (plot_styles['tables'] or complex_line_types or model_line_type_factor != 1) and kind in dxf_linetype.CURVES:
            save_presentation(entity, item_id, ref, [(entity, [], points, segments, topology)], local_geometry=True)
        else:
            display.add(item_id, points, segments, topology, [ref])
        (display_ok if ready else display_missing)[kind] += 1
        entity_record = {'id': item_id, 'drawingId': drawing_id, 'ownerSpaceId': space_id,
                         'layerId': layer_id, 'localFromOwner': local_matrix,
                         'geometry': geometry, 'style': style, 'sourceRefs': [ref],
                         'displayOrder': int(index)}
        m['entities'][item_id] = entity_record
        m['spaces'][space_id]['entityIds'].append(item_id)
        return ('entity', item_id, ready)

    def map_annotation(entity, space_id, space_key, index):
        nonlocal dimensions_with_geometry, dimensions_without_geometry
        kind = entity.dxftype()
        has_display = True
        handle = entity.dxf.handle
        item_id = source_item_id('annotation', handle, [sha, space_key, str(handle)])
        record_indices[item_id] = index
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
        record_style_modes(item_id, entity,source_item=True)
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
            has_display = annotation_presentation(entity, item_id, ref)
            binding = shx.binding(entity, [ref])
            if binding and binding['status'] == 'resolved':
                annotation['fontResourceId'] = binding['resourceId']
            if not has_display:
                entity_flags.setdefault(item_id, {})['presentationGeometry'] = 'missing'
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
                has_display = annotation_presentation(entity, item_id, ref)
                entity_flags.setdefault(item_id, {})['presentationGeometry'] = 'rebuilt' if has_display else 'missing'
                if not has_display:
                    dimensions_without_geometry += 1
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
        if kind in ('TEXT', 'ATTRIB', 'ATTDEF') and annotation['text'].strip() and (kind != 'ATTDEF' or entity.dxf.get('flags', 0) & 2):
            binding = shx.binding(entity, [ref])
            if binding:
                if binding['status'] == 'resolved':
                    has_display = annotation_presentation(entity, item_id, ref)
                    entity_flags.setdefault(item_id, {})['presentationGeometry'] = 'rebuilt' if has_display else 'missing'
                    annotation['fontResourceId'] = binding['resourceId']
                else:
                    shx.fallback(item_id, [ref], binding)
        try:
            context_record=annotation_contexts.get(item_id,{})
            if context_record.get('reason'):raise ValueError(context_record['reason'])
            contexts=context_record.get('contexts',[])
            if contexts:
                annotation['annotationScales']=sorted({row['scale']['drawingPerPaper'] for row in contexts})
                annotation_contexts[item_id]={'status':'source-retained','contexts':contexts}
                defaults=[row for row in contexts if row['default']]
                if len(defaults)!=1: raise ValueError('annotation-context-default-not-unique')
                base=annotation_presentations.get(item_id)
                if base and base['status']=='ready' and kind in ('TEXT','MTEXT','ATTRIB','ATTDEF'):
                    base['scaleVariants']=[]
                    for context in contexts:
                        key=identity('annotation-context',[item_id,context['sourceHandle']])
                        try:
                            copy=dxf_scale.apply_context(entity,context,defaults[0]['scale']['drawingPerPaper'])
                            record_style_modes(key,copy)
                            annotation_presentation(copy,key,ref,origin_entity=entity)
                            variant=annotation_presentations.pop(key)
                            variant['drawingPerPaper']=context['scale']['drawingPerPaper']
                            base['scaleVariants'].append(variant)
                            display.groups.pop(key,None)
                            for row in mtext.items.values():
                                if row['itemId']==key: row.update(itemId=item_id,annotationScale=context['scale']['drawingPerPaper'])
                        except (ValueError,TypeError,KeyError) as error:
                            base['scaleVariants'].append({'status':'missing','parts':[],
                                'drawingPerPaper':context['scale']['drawingPerPaper'],'reason':str(error)})
                    base['defaultScale']=defaults[0]['scale']['drawingPerPaper']
                    annotation_contexts[item_id]['status']='ready' if all(v['status']=='ready' for v in base['scaleVariants']) else 'partial'
        except ValueError as error:
            annotation_contexts[item_id]={'status':'partial','reason':str(error)}
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
        clip_error = None
        origin = xrefs.origins.get(str(handle), {})
        try:
            if origin.get('blockClipError'):
                raise ValueError(origin['blockClipError'])
            clip = origin['blockClip'] if 'blockClip' in origin else dxf_clipping.block_clip(entity)
        except ValueError as error:
            clip_error = str(error)
        if block_name not in block_ids or clip_error:
            missing_name = xrefs.origins.get(str(handle), {}).get('missingBlockName', block_name)
            reason = clip_error or 'block definition "' + missing_name + '" is not present in the DXF'
            unsupported['INSERT-clipping' if clip_error else 'INSERT-missing-block'] += 1
            display_missing['INSERT'] += 1
            item_id = source_item_id('entity', handle, [sha, space_key, str(handle)])
            record_indices[item_id] = index
            m['entities'][item_id] = {'id': item_id, 'drawingId': drawing_id, 'ownerSpaceId': space_id,
                                      'layerId': layer_id, 'localFromOwner': mat_identity(),
                                      'geometry': {'type': 'unsupported', 'sourceType': 'INSERT',
                                                   'reason': reason},
                                      'style': source_style(entity, layer_name), 'sourceRefs': [ref],
                                      'displayOrder': int(index)}
            m['spaces'][space_id]['entityIds'].append(item_id)
            loss = ('block-clipping' if clip_error else 'missing-block', missing_name)
            if loss not in losses:
                losses.append(loss)
            return ('entity', item_id, False)
        instance_id = source_item_id('blockInstance', handle, [sha, space_key, str(handle)])
        if clip:
            block_clips[instance_id] = clip
        record_indices[instance_id] = index
        attributes = {attrib.dxf.get('tag', ''): attrib.dxf.get('text', '') for attrib in entity.attribs}
        rows = int(entity.dxf.get('row_count', 1) or 1)
        columns = int(entity.dxf.get('column_count', 1) or 1)
        instance = {'id': instance_id, 'ownerSpaceId': space_id,
                    'definitionId': block_ids[block_name], 'layerId': layer_id,
                    'localFromBlock': flatten(entity.matrix44()),
                    'attributes': attributes,
                    'style': source_style(entity, layer_name), 'sourceRefs': [ref]}
        if rows > 1 or columns > 1:
            from ezdxf.math import Vec3
            ocs = entity.ocs()
            rotation = entity.dxf.rotation
            # MINSERT spacing is rotated in OCS but is not block-scaled. Publish
            # offsets in owner-space axes so every projector uses the same rule.
            row_delta = ocs.to_wcs(Vec3(0.0, entity.dxf.row_spacing, 0.0).rotate_deg(rotation))
            col_delta = ocs.to_wcs(Vec3(entity.dxf.column_spacing, 0.0, 0.0).rotate_deg(rotation))
            instance['array'] = {'rows': rows, 'columns': columns,
                                 'rowOffset': [float(row_delta.x), float(row_delta.y), float(row_delta.z)],
                                 'columnOffset': [float(col_delta.x), float(col_delta.y), float(col_delta.z)]}
        record_style_modes(instance_id, entity,source_item=True)
        m['blockInstances'][instance_id] = instance
        m['spaces'][space_id]['blockInstanceIds'].append(instance_id)
        # Source ATTRIB coordinates already live in the INSERT's owner space.
        # Retain that coordinate context and its actual instance owner separately.
        # Projection then shares the owner's array, style, visibility and clipping.
        for attrib in entity.attribs:
            _, attrib_id, _ = map_annotation(attrib, space_id, space_key, index)
            m['annotations'][attrib_id]['ownerBlockInstanceId'] = instance_id
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
    for block_layout in list(doc.blocks):
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
                if entity.dxf.flags & 1 or abs(direction[0]) > 1e-9 or abs(direction[1]) > 1e-9 or abs(direction[2]) < 1e-9:
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
                try:
                    clip_boundary = dxf_clipping.viewport_boundary(entity)
                except (ValueError, TypeError) as error:
                    losses.append(('viewport-clipping', str(entity.dxf.handle) + ': ' + str(error)))
                    viewport_details.append({'handle': str(entity.dxf.handle), 'layoutId': lid,
                        'layoutName': layout.name, 'status': 'skipped-invalid-clipping', 'projected': False})
                    continue
                layer_overrides = {}
                viewport_opacities[vid] = {}
                for layer in doc.layers:
                    override = layer.get_vp_overrides()
                    if not override.has_overrides(entity.dxf.handle):
                        continue
                    viewport_opacities[vid][layer_ids[layer.dxf.name]] = 1 - override.get_transparency(entity.dxf.handle)
                    rgb = override.get_rgb(entity.dxf.handle)
                    plot_styles['viewportLayers'].setdefault(vid,{})[layer_ids[layer.dxf.name]]={
                        'colorIndex':abs(override.get_color(entity.dxf.handle)),'trueColor':rgb is not None}
                    override_style = {'plot': bool(layer.dxf.get('plot', 1)), 'color': {'mode': 'explicit', 'rgba':
                        [round(c / 255, 9) for c in rgb] + [1.0] if rgb is not None else _aci_rgba(abs(override.get_color(entity.dxf.handle)))}}
                    line_type = override.get_linetype(entity.dxf.handle).upper()
                    if line_type in line_type_ids:
                        override_style['lineTypeId'] = line_type_ids[line_type]
                    weight = override.get_lineweight(entity.dxf.handle)
                    if weight >= 0:
                        override_style['lineWeight'] = _lineweight_fact(weight / 100)
                    layer_overrides[layer_ids[layer.dxf.name]] = override_style
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
                            'clipBoundary': clip_boundary,
                            # Group 68: positive stacking ranks are active;
                            # group 90 bit 0x20000 explicitly turns the viewport off.
                            'enabled': status > 0 and not (entity.dxf.flags & 0x20000),
                            'frozenLayerIds': frozen, 'layerOverrides': layer_overrides,
                            'annotationScale': dxf_scale.viewport_scale(entity,annotation_scale)}
                m['viewports'][vid] = viewport
                m['layouts'][lid]['viewportIds'].append(vid)
                viewport_ids.append(vid)
                viewport_details.append({'handle': str(entity.dxf.handle), 'layoutId': lid,
                                         'layoutName': layout.name,
                                         'dxfId': int(entity.dxf.get('id', 0) or 0), 'viewportId': vid,
                                         'status': 'projected', 'projected': True,
                                         'scale': round(scale, 9), 'enabled': viewport['enabled'],
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

    # Source recordOffset remains the physical source index (and part of the
    # provenance contract). SORTENTSTABLE affects painting only, not source IDs.
    redraw_order = {}
    source_layouts = [(model_space_id, model_space)] + [(block_space_ids[b.name], b)
                       for b in doc.blocks if b.name in block_space_ids]
    source_layouts += [(spid, layout) for layout, _, spid in paper_layouts]
    for owner_id, layout in source_layouts:
        ranks = {e.dxf.handle: rank for rank, e in enumerate(layout.entities_in_redraw_order())}
        by_index = {index: ranks[e.dxf.handle] for index, e in enumerate(layout)}
        for table, field in (('entities', 'entityIds'), ('annotations', 'annotationIds'),
                             ('blockInstances', 'blockInstanceIds')):
            for item_id in m['spaces'][owner_id][field]:
                item = m[table][item_id]
                index = record_indices.get(item_id, item['sourceRefs'][0].get('recordOffset', 0))
                if by_index[index] != index:
                    redraw_order[item_id] = by_index[index]

    block_owner_spaces = {layout.block_record_handle: block_space_ids[layout.name]
                          for layout in doc.blocks if layout.name in block_space_ids}
    for failure in xrefs.failures:
        space_id = block_owner_spaces.get(failure['ownerHandle'])
        if space_id is None:
            raise ValueError('xref-copy-failure-owner-missing')
        item_id = identity('entity', [sha, 'xref-copy-failure', failure['chain'], failure['sourceRefs']])
        m['entities'][item_id] = {'id': item_id, 'drawingId': drawing_id, 'ownerSpaceId': space_id,
            'layerId': layer_ids['0'], 'localFromOwner': mat_identity(), 'style': {'color': {'mode': 'unknown'}, 'plot': True},
            'geometry': {'type': 'unsupported', 'sourceType': failure['sourceKind'], 'reason': failure['reason']},
            'sourceRefs': failure['sourceRefs'], 'displayOrder': 0}
        m['spaces'][space_id]['entityIds'].append(item_id)
        counts['total'] += 1; counts[failure['sourceKind']] += 1
        unsupported[failure['sourceKind']] += 1; display_missing[failure['sourceKind']] += 1
        mapped_origins[item_id] = {'sourceRefs': failure['sourceRefs'], 'referenceIds': failure['chain']}
    d['extensions']['org.cad-preview.annotation-presentation/1'] = {
        'schemaVersion': '1.3.0', 'items': annotation_presentations,
        'glyphSagittaRelativeToCapHeight': 1e-3,
        'sourceFileUnchanged': True,
        'limits': {'verticesPerDocument': dxf_annotations.MAX_VERTICES,
                   'partsPerSource': dxf_annotations.MAX_PARTS, 'depth': dxf_annotations.MAX_DEPTH}}
    stageprof.mark('dxf.mapped', entities=counts['total'], blocks=len(m['blocks']),
                   layers=len(m['layers']), viewports=len(m['viewports']))

    # ----- projection (model space) and completeness -------------------------
    # Format-neutral tables consumed by drawing projection. The viewer must not know DXF
    # keywords: the adapter resolves BYLAYER/BYBLOCK to layer/parent modes here and the
    # projection applies generic inheritance.
    d['extensions']['org.cad-preview.style-inheritance/1'] = {
        'schemaVersion': '1.3.0',
        'modes': style_modes,
        'annotationStyles': annotation_styles,
        'entityState': entity_flags,
        'drawOrder': redraw_order,
        'blockClips': block_clips,
        'layerOpacity': layer_opacities, 'viewportLayerOpacity': viewport_opacities,
        'lineTypeScale': ltscale,
        'annotationScale': annotation_scale,
        'lineTypePatterns': line_type_patterns,
        'complexLineTypeIds': [line_type_ids[name.upper()] for name in complex_line_types],
        'lineTypeDefinitions': {key: [{'code': tag.code, 'value': tag.value} for tag in lt.pattern_tags.tags]
            for lt in doc.linetypes if (key := line_type_ids.get(lt.dxf.name.upper()))},
        # Format-neutral layer inheritance: content on these layers takes the layer of
        # the innermost enclosing block reference (DXF layer "0"). The projection applies
        # it generically; the viewer uses the same table for user layer toggles.
        'layerInheritance': {lid: {'byBlockLayer': True}
                             for lid, layer in m['layers'].items() if layer['name'] == '0'},
        'projectionLimits': {'maxDraws': MAX_PROJECTION_DRAWS},
    }
    d['extensions'][dxf_plotstyles.EXTENSION] = plot_styles
    d['extensions']['org.cad-preview.dxf-annotation-contexts/1']={'version':'1.0.0','items':annotation_contexts,
        'modelDrawingPerPaper':annotation_scale['currentDrawingPerPaper'],
        'allVisible':annotation_scale['variables'].get('ANNOALLVISIBLE','1')!='0',
        'policy':'source scale representations; unknown context payloads retained separately'}
    # Resolve real usage first, so unused complex styles do not request fonts.
    # Include isolated block views, which the viewer can open independently.
    targets = [{'kind': 'model', 'spaceId': model_space_id}] + [
        {'kind': 'layout', 'layoutId': key} for key in m['layouts']] + [
        {'kind': 'model', 'spaceId': block['spaceId']} for block in m['blocks'].values()]
    parts_by_id = {part['id']: (key, part) for key, entry in annotation_presentations.items()
        for presentation_entry in [entry,*entry.get('scaleVariants',[])] for part in presentation_entry['parts']}
    continuations = {}
    for _, part in parts_by_id.values():
        if part.get('patternContinuation'):
            continuations.setdefault(part['patternContinuation'], []).append(part)
    demands = {}
    draw_demands = {}
    plot_demands = {}
    for target in targets if stroke_sources or plot_styles['tables'] else []:
        rows, effective_layers = {}, {}
        projected = project_drawing(d, target, effective_layers=effective_layers, presentation_styles=rows)
        context=target.get('layoutId','model')
        if target.get('spaceId',model_space_id)==model_space_id:
            resolved=plot_styles['resolved'].setdefault(context,{})
            for draw_id,draw in projected['draws'].items():
                parents=[entry['instanceId'] for entry in draw['blockPath']]
                root=dxf_plotstyles.select(plot_styles,context,draw['itemId'],effective_layers[draw_id],parents,draw.get('viewportId'))
                entry={'root':root,'parts':{}}
                resolved[draw_id]=entry
                for row in rows.get(draw_id,[]):
                    part=parts_by_id[row['id']][1]
                    chain=parents+[draw['itemId']]+[ancestor['id'] for ancestor in part['ancestors']]
                    pen=dxf_plotstyles.select(plot_styles,context,row['id'],row['layerId'],chain,draw.get('viewportId'))
                    entry['parts'][row['id']]=pen
                    primary=part.get('patternContinuation',row['id'])
                    if primary==row['id'] and primary in stroke_sources and pen and pen['status']=='ready' and 0<pen['style']['lineType']<31:
                        matrix=list(draw['localToSpace'])
                        factor=plot_styles['layouts'][context]['drawingToPaperMm']
                        for col in range(3):
                            for axis in range(3): matrix[col*4+axis]*=factor
                        leaf,local_geometry,_,_=stroke_sources[primary]
                        if not local_geometry: matrix=mat_mul(matrix,tessellate_entity(leaf)[4])
                        plot_demands[(primary,context,draw_id)]=(pen['style'],matrix)
        for draw_id, styles in rows.items():
            for row in styles:
                part = parts_by_id[row['id']][1]
                primary = part.get('patternContinuation', row['id'])
                line_type = row['style'].get('lineTypeId')
                if primary in stroke_sources and (line_type_patterns.get(line_type) or line_type in d['extensions']['org.cad-preview.style-inheritance/1']['complexLineTypeIds']):
                    demands.setdefault(primary, set()).add(line_type)
                    matrix = list(projected['draws'][draw_id]['localToSpace'])
                    viewport_id = projected['draws'][draw_id].get('viewportId')
                    model_factor = model_line_type_factor if target['kind'] == 'model' else 1
                    if model_factor is None:
                        draw_demands[(primary,draw_id)] = (line_type,None)
                        continue
                    if model_factor != 1:
                        for col in range(3):
                            for axis in range(3): matrix[col*4+axis] /= model_factor
                    if viewport_id and not doc.header.get('$PSLTSCALE',1):
                        vp_matrix = m['viewports'][viewport_id]['modelToPaper']
                        factor = math.sqrt(sum(vp_matrix[i]**2 for i in (0,1,2)))
                        for col in range(3):
                            for axis in range(3): matrix[col*4+axis] /= factor
                    leaf, local_geometry, _, _ = stroke_sources[primary]
                    if not local_geometry:
                        matrix = mat_mul(matrix, tessellate_entity(leaf)[4])
                    lengths = [sum(matrix[col*4+axis]**2 for axis in range(3)) for col in (0,1)]
                    dot = sum(matrix[axis]*matrix[4+axis] for axis in range(3))
                    if any(abs(value-1)>1e-10 for value in lengths) or abs(dot)>1e-10:
                        draw_demands[(primary,draw_id)] = (line_type,matrix)
    def bake_line_type(part_id, line_type, draw_id=None, metric_matrix=None, pen=None):
        nonlocal presentation_vertices, pattern_segment_count
        owner_id, part = parts_by_id[part_id]
        leaf, local_geometry, ref, owner = stroke_sources[part_id]
        variant = {'status': 'ready', 'parts': []}
        try:
            _, path_points, path_indices, _, matrix = tessellate_entity(leaf)
            groups=([{49:v*25.4} for v in dxf_plotstyles.PEN_PATTERNS[pen['lineType']]] if pen is not None else line_type_definitions[line_type])
            period=(12.7 if pen['lineType']>=17 else sum(abs(group[49]) for group in groups)) if pen is not None else line_type_periods[line_type]
            batches, fonts_used, generated_runs = dxf_linetype.display_parts(leaf, groups,
                1 if pen is not None else ltscale * entity_flags.get(part_id, {}).get('lineTypeScale', 1), path_points, path_indices,
                doc, shx, [ref], {**shx.context(owner, [ref]), 'itemId': owner_id},
                dxf_annotations.MAX_VERTICES - presentation_vertices,
                min(MAX_PATTERN_SEGMENTS, MAX_DOCUMENT_PATTERN_SEGMENTS-pattern_segment_count),
                declared_period=period, metric_matrix=metric_matrix, pen=pen)
            pattern_segment_count += generated_runs
            for index, (points, indices, topology, role) in enumerate(batches):
                if not local_geometry: points = [_apply(matrix, point) for point in points]
                variant_id = identity('linetype-part', [part_id, line_type, draw_id or '', index])
                rid = (display.add_fill(variant_id, points, indices, [ref]) if topology == 'triangles' else
                       display.add(variant_id, points, indices, topology, [ref]))
                variant['parts'].append({'representationId': rid, 'role': role, 'fillRule': 'nonzero'})
                presentation_vertices += len(points)
            annotation_presentations[owner_id]['fonts'].extend(font for font in fonts_used if font not in annotation_presentations[owner_id]['fonts'])
        except Exception as error:
            variant = {'status': 'missing', 'parts': [], 'reason': type(error).__name__ + ': ' + str(error)}
        return variant
    for part_id, line_types in demands.items():
        _, part = parts_by_id[part_id]
        for line_type in sorted(line_types):
            part.setdefault('lineTypeVariants', {})[line_type] = bake_line_type(part_id,line_type)
    for (part_id,draw_id), (line_type,matrix) in draw_demands.items():
        part=parts_by_id[part_id][1]
        variant = (bake_line_type(part_id,line_type,draw_id,matrix) if matrix is not None else
                   {'status':'missing','parts':[],'reason':'model-annotation-scale-unresolved'})
        part.setdefault('drawVariants',{})[draw_id] = {**variant,'lineTypeId':line_type}
    for (part_id,context,draw_id),(pen,matrix) in plot_demands.items():
        part=parts_by_id[part_id][1]
        variant=bake_line_type(part_id,'plot:'+context+':'+str(pen['lineType']),draw_id,matrix,pen)
        part.setdefault('plotVariants',{}).setdefault(context,{})[draw_id]=variant
        for continuation in continuations.get(part_id,[]):
            continuation.setdefault('plotVariants',{}).setdefault(context,{})[draw_id]={**variant,'parts':[]}
    for part_id in demands:
        part=parts_by_id[part_id][1]
        for continuation in continuations.get(part_id, []):
            continuation['lineTypeVariants'] = {key: {'status': value['status'], 'parts': [],
                **({'reason': value['reason']} if 'reason' in value else {})} for key, value in part['lineTypeVariants'].items()}
            if part.get('drawVariants'):
                continuation['drawVariants'] = {key:{**value,'parts':[]} for key,value in part['drawVariants'].items()}
    pattern_gaps = set()
    if demands or any(entry.get('scaleVariants') for entry in annotation_presentations.values()):
        pattern_owners = {parts_by_id[key][0] for key in demands} | {key for key,entry in annotation_presentations.items() if entry.get('scaleVariants')}
        for target in targets:
            rows = {}
            for draw_id, draw in project_drawing(d, target, presentation_styles=rows)['draws'].items():
                if draw['itemId'] not in pattern_owners: continue
                if draw['availability'] in ('unsupported','missing-reference'): pattern_gaps.add(draw['itemId'])
                elif annotation_presentations[draw['itemId']].get('scaleVariants') or any('presentationParts' in row for row in rows.get(draw_id, [])):
                    selected = [sub for row in rows[draw_id] for sub in row.get('presentationParts', [parts_by_id[row['id']][1]])]
                    display.variant_groups[draw['displayRepresentationId']] = (selected, annotation_presentations[draw['itemId']]['sourceRefs'])
        for key in sorted(pattern_gaps):
            kind = annotation_presentations[key]['sourceKind']
            display_ok[kind] -= 1; display_missing[kind] += 1; unsupported[kind] += 1
            source_item = m['entities'].get(key) or m['annotations'][key]
            losses.append(('linetype-presentation-failed', source_item['sourceRefs'][0]['objectKey']))
    display.commit(d, sink)
    shx_coverage = shx.commit(d)
    media_coverage = media.commit(d, sink)
    mtext_coverage = mtext.commit(d)
    plot_coverage = dxf_plotstyles.commit(d,plot_styles,sid)
    context_coverage={'status':'complete' if all(row['status']=='ready' for row in annotation_contexts.values()) else 'partial',
        'sourceObjects':len(annotation_contexts),'readyObjects':sum(row['status']=='ready' for row in annotation_contexts.values()),
        'policy':'source context placements rendered for supported payloads; original graphs retained for every type'}
    d['extensions']['org.cad-preview.dxf-annotation-contexts/1']['coverage']=context_coverage
    if media.items:
        d['adapter']['dependencies'].extend({'name': key, 'version': value} for key, value in dxf_media.VERSIONS.items())
    shx.assign_text_styles(m, text_style_ids)
    from . import dxf_semantics
    d['extensions'][dxf_semantics.EXTENSION] = dxf_semantics.extension(xrefs.source_facts)
    facts_partial=[key for key,row in xrefs.source_facts.items() if row['status']!='ready']
    facts_coverage={'status':'partial' if facts_partial else 'complete','sources':len(xrefs.source_facts),
        'partialSourceIds':facts_partial,'policy':'source-tag attributes and references; reader repairs and budget losses explicit'}
    total_unsupported = sum(unsupported.values())
    coverage = {'total': counts['total'], 'byType': dict(sorted(counts.items())),
                'unsupportedTotal': total_unsupported,
                'unsupportedByType': dict(sorted(unsupported.items())),
                'partialByType': dict(sorted(partial.items())),
                'dimensionWithGeometry': dimensions_with_geometry,
                'dimensionRebuiltGeometry': sum(item['sourceKind'] == 'DIMENSION' and item['status'] == 'ready'
                                                for item in annotation_presentations.values()),
                'dimensionWithoutGeometry': dimensions_without_geometry}
    attribute_coverage = {
        'entityIdentity': 'mapped', 'layersAndVisibility': 'mapped',
        'blockDefinitionsAndInstances': 'mapped', 'blockAttributes': 'mapped',
        'textContentAndPlacement': 'mapped', 'textFontRendering': 'uploaded SHX/SHP/TTF/OTF; code-page Big Fonts and declared dual-orientation vertical TEXT; explicit substitutions',
        'mtextFormatting': 'shared layout/glyphs with tracking/tabs/columns/mixed fonts; source FIELD caches preferred and deterministic built-ins evaluated read-only',
        'multilineAndTables': 'ezdxf MLINE primitives and source ACAD_TABLE presentation blocks',
        'toleranceFrames': 'CADCraft GDT layout and ezdxf glyph/plane transforms; display only',
        'wipeouts': 'ezdxf WCS mask boundary with source redraw order',
        'infiniteLines': 'source parametric RAY/XLINE clipped to current view; no finite fit extent',
        'gradientFills': 'truedxf calibrated SHIFT 0/1 field; source stops, boundary holes and OCS preserved; screen approximation',
        'dimensionSemantics': 'declared measurement, definition points, styles, overrides and original association graph retained; no inspection or constraint solver',
        'polylineWidths': 'source segment widths; bounded TraceBuilder bands and arc-length pattern variants after instance/viewport inheritance',
        'hatchPatterns': 'stored effective definition; bounded pattern strokes', 'lineTypePatterns': 'numeric dashes and uploaded text/shape glyph variants; source definitions retained',
        'plotStyles': 'uploaded CTB/STB source layout or explicit screen print preview; colors, pens and device-pixel fill patterns',
        'xdata': 'original typed tags with source handles', 'extensionDictionaries': 'original handle graph including shared/cyclic references',
        'proxyObjects': 'stored custom-object proxy graphics, composed matrices/clips and source traits; no application evaluator',
        'annotationScales':'MSLTSCALE/CANNOSCALE, saved viewport scale and TEXT/MTEXT contexts including columns; other type payloads retained and explicit partial',
        'planarRegions':'SAT/SAB planar straight/ellipse/explicit rational spline boundary loops; unknown procedural curves refused',
        'media':'uploaded raster/PDF/DWF/DWFx/V7 2D DGN and OLE CF_DIB content caches; source-dependent reader limits explicit',
        'units': 'declared-by-INSUNITS' if unit else 'unknown',
        'objectProperties': 'original attributes, dictionaries, table/cell tags, current dynamic-block state and document custom properties'}
    # Three distinct axes. They are deliberately not collapsed: a file can have every
    # record enumerated and still lose display geometry, and display geometry can be
    # complete while engineering attributes (dimension semantics, MTEXT formatting,
    # plot styles, XDATA) are not reconstructed.
    with_display = sum(display_ok.values())
    without_display = sum(display_missing.values())
    viewport_losses = sum(1 for l in losses if l[0].startswith('viewport-'))
    xref_ids = {row['id'] for row in xrefs.references.values()}
    external_losses = sum(ref['required'] and ref['status'] != 'resolved' for ref in d['externalReferences'] if ref['id'] in xref_ids)
    decoder_partial = [report for report in xrefs.decoders if report['status'] != 'complete']
    geometry_complete = without_display == 0 and viewport_losses == 0 and external_losses == 0 and not recovery and not decoder_partial
    coverage_axes = {
        'schemaVersion': '1.0.0',
        'sourceRead': {'status': 'partial' if recovery or decoder_partial else 'complete',
                       'partialDwgDecoders': len(decoder_partial),
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
                                         'viewportSkipped': viewport_losses,
                                         'externalReferenceUnresolved': external_losses,
                                         'sourceRecoveryPartial': 1 if recovery else 0},
                            'note': 'complete only when every enumerated record produces a draw; '
                                    'unsupported records, skipped viewports, unresolved external references and source recovery keep this partial.'},
        'engineeringAttributes': {'status': 'partial', 'coverage': attribute_coverage,
                                  'note': 'Attribute coverage is independent of geometry completeness.'},
        'sourceFacts':facts_coverage,
        'fontResources': shx_coverage,
        'mediaResources': media_coverage,
        'mtextLayout': mtext_coverage,
        'annotationContexts':context_coverage,
        'plotStyles':plot_coverage,
        'losses': [{'code': l[0], 'detail': str(l[1])} for l in losses],
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
        'patternPolicy': {'maxSegmentsPerEntity': MAX_PATTERN_SEGMENTS,
                          'maxSegmentsPerDocument': MAX_DOCUMENT_PATTERN_SEGMENTS,
                          'generatedSegments': pattern_segment_count,
                          'randomOriginJiggle': False,
                          'boundaryFlattening': 'same relative-sagitta policy as solid fills'},
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
    d['extensions']['org.cad-preview.dxf-xref/1'] = {
        'version': '1.1.0', 'references': list(xrefs.references.values()), 'itemOrigins': mapped_origins,
        'decoders': xrefs.decoders,
        'copyFailures': xrefs.failures,
        'providedFiles': [{'logicalPath': key, 'sha256': hashlib.sha256(value).hexdigest(), 'byteLength': len(value)}
                          for key, value in sorted((resources or {}).items())],
        'policy': 'upload-only; exact relative path, then unique case-insensitive path/basename; no extension replacement',
        'limits': {'depth': dxf_xref.MAX_DEPTH, 'records': dxf_xref.MAX_RECORDS},
    }
    if xrefs.decoders:
        d['adapter']['dependencies'].append({'name': 'libredwg', 'version': dxf_xref.dxf_dwg.VERSION})
    if recovery:
        # Source version/units stay unknown when HEADER is absent. The profile
        # selects an ezdxf loader only; it must not become source-declared metadata.
        if recovery['sourceVersion'] is None:
            d['sources'][0].pop('detectedVersion', None)
            d['extensions']['org.cad-preview.dxf/1']['dxfVersion'] = {'code': None, 'release': 'unknown'}
        recovery['blockPreviews'] = sorted(
            [{'blockId': bid, 'name': block['name'],
              'sourceItems': sum(len(m['spaces'][block['spaceId']][key])
                                 for key in ('entityIds', 'annotationIds', 'blockInstanceIds'))}
             for bid, block in m['blocks'].items() if block['name'] in block_handles
             and any(m['spaces'][block['spaceId']][key]
                     for key in ('entityIds', 'annotationIds', 'blockInstanceIds'))],
            key=lambda row: (-row['sourceItems'], row['name'].startswith('*'), row['name']))
        d['extensions']['org.cad-preview.dxf/1']['recovery'] = recovery
        coverage_axes['sourceRead']['rawHandleRecords'] = recovery['sourceRecordCount']
        coverage_axes['sourceRead']['removedHandleRecords'] = len(recovery['removedSourceRecords'])

    effective_layers = {}
    projection = project_drawing(d, {'kind': 'model', 'spaceId': model_space_id}, effective_layers)
    d['extensions']['org.cad-preview.drawing-layers/1'] = {'target': projection['target'], 'byDraw': effective_layers}
    completeness = 'complete' if geometry_complete and all(axis['status'] == 'complete' for axis in [shx_coverage, media_coverage, mtext_coverage,context_coverage,plot_coverage,facts_coverage]) else 'partial'
    snapshot = {'schemaVersion': '2.0.0', 'id': 'pending', 'documentRevision': '0' * 64,
                'selection': {'viewContextId': 'view-default'}, 'sceneRoots': [],
                'occurrenceOverrides': {}, 'draws': {}, 'completeness': completeness,
                'diagnostics': [], 'drawingProjection': projection}
    for report in decoder_partial:
        snapshot['diagnostics'].append({'code': 'dxf-dwg-decode-partial', 'severity': 'warning', 'stage': 'parse',
            'message': 'DWG 外参解码报告含损失，已加载的显示内容不代表原图完整。',
            'sourceRefs': [{'sourceId': report['sourceId']}]})
    for source in facts_partial:
        snapshot['diagnostics'].append({'code':'dxf-source-facts-partial','severity':'warning','stage':'mapping',
            'message':'; '.join(xrefs.source_facts[source]['issues']),'sourceRefs':[{'sourceId':source}]})
    for diag_code, message in [
            ('dxf-geometry-projection', 'Drawings/spaces/entities/blocks/layers are mapped from the DXF tables; display polylines are separate Representation(kind=drawing) artifacts.'),
            ('dxf-attribute-coverage', 'Source attributes, declared dimensions, XDATA, dictionary/association graphs and saved dynamic-block states are retained. Derived glyphs, proxy graphics, REGION curves and print/media previews do not provide CAD editing, constraint solving or inspection results.')]:
        snapshot['diagnostics'].append({'code': diag_code, 'severity': 'info', 'stage': 'mapping',
                                        'message': message, 'sourceRefs': [{'sourceId': sid}]})
    for row in d['extensions'][dxf_shx.EXTENSION]['references']:
        if row['status'] != 'resolved':
            snapshot['diagnostics'].append({'code': 'dxf-shx-unavailable', 'severity': 'warning',
                'stage': 'resource-resolution', 'message': row['requestedPath'] + ': ' + row['reason'],
                'sourceRefs': row['usedSourceRefs']})
    for item in media.items.values():
        if item['status'] != 'ready':
            snapshot['diagnostics'].append({'code': 'dxf-media-unavailable', 'severity': 'warning',
                'stage': 'resource-resolution', 'message': item['reason'], 'sourceRefs': item['sourceRefs']})
    for item_id,row in annotation_contexts.items():
        if row['status']!='ready':
            snapshot['diagnostics'].append({'code':'dxf-annotation-context-partial','severity':'warning','stage':'mapping',
                'message':row.get('reason','Saved annotation context retained; type-specific placement is not verified'),
                'sourceRefs':(m['entities'].get(item_id) or m['annotations'].get(item_id) or m['blockInstances'].get(item_id) or {}).get('sourceRefs',[])})
    for failure in plot_coverage['sourceDisplayFailures']:
        snapshot['diagnostics'].append({'code':'dxf-plot-style-unavailable','severity':'warning','stage':'resource-resolution',
            'message':str(failure),'sourceRefs':[{'sourceId':sid}]})
    for item in mtext.items.values():
        if item['status'] != 'ready' or item['dynamicEvaluationsUnsupported'] or item.get('layoutWarnings'):
            snapshot['diagnostics'].append({'code': 'dxf-mtext-partial', 'severity': 'warning',
                'stage': 'mapping', 'message': '; '.join(item.get('layoutWarnings', []) +
                    ([item.get('fieldPolicy', item.get('reason', 'MTEXT layout unavailable'))]
                     if item['status'] != 'ready' or item['dynamicEvaluationsUnsupported'] else [])),
                'sourceRefs': item['sourceRefs']})
    for entity_kind, count in sorted(unsupported.items()):
        snapshot['diagnostics'].append({'code': 'dxf-entity-unsupported', 'severity': 'warning',
                                        'stage': 'mapping',
                                        'message': entity_kind + ' x' + str(count) + ' mapped as UnsupportedEntity; no geometry is guessed',
                                        'sourceRefs': [{'sourceId': sid}]})

    d['capabilities'] = [
        {'feature': 'dxf-drawing-model', 'scope': 'Real DXF via pinned ezdxf; samples recorded in phase_i_evidence',
         'mechanism': 'standard-confirmed', 'implementation': 'implemented', 'validation': 'experimental',
         'evidenceIds': ['dxf-spec', 'ezdxf', 'policy'],
         'limitations': ['DXF main drawing; uploaded DWG xrefs use the separately reported decoder', 'Independent sample comparison is recorded separately per sample']},
        {'feature': 'dxf-core-entities', 'scope': 'LINE POINT CIRCLE ARC LWPOLYLINE POLYLINE ELLIPSE SPLINE',
         'mechanism': 'standard-confirmed', 'implementation': 'implemented', 'validation': 'experimental',
         'evidenceIds': ['dxf-spec', 'ezdxf'], 'limitations': ['CIRCLE is stored as a full-sw eep Arc; DXF stores no separate circle primitive in UCD']},
        {'feature': 'dxf-blocks-and-instances', 'scope': 'BlockDefinition per block record, BlockInstance per INSERT',
         'mechanism': 'standard-confirmed', 'implementation': 'implemented', 'validation': 'experimental',
         'evidenceIds': ['dxf-spec', 'ezdxf'],
         'limitations': ['Stored dynamic-block state/parameter graph is read; editing and regeneration are not executed', 'XREF requires uploaded DXF/DWG companions; nested 2D clipping and host dependent layers supported; 3D depth clipping remains outside the 2D scope']},
        {'feature': 'dxf-layers-and-visibility', 'scope': 'Layer table, off/frozen/locked/plot flags',
         'mechanism': 'standard-confirmed', 'implementation': 'implemented', 'validation': 'experimental',
         'evidenceIds': ['dxf-spec', 'ezdxf'], 'limitations': ['Viewport color/linetype/weight/transparency and ACI plot pens apply to inherited properties; explicit source traits are preserved']},
        {'feature': 'dxf-annotations', 'scope': 'TEXT and ATTDEF content/placement; ezdxf MTEXT layout, LEADER/MULTILEADER presentation; missing DIMENSION block rendering',
         'mechanism': 'standard-confirmed', 'implementation': 'experimental', 'validation': 'experimental',
         'evidenceIds': ['dxf-spec', 'ezdxf', 'policy'],
         'limitations': ['Unavailable fonts/substitutions stay partial', 'Complex vertical/mixed-font layouts retain a source-CAD precision warning',
                         'Custom/application FIELD evaluators require source caches; saved non-text annotation contexts are retained with explicit coverage',
                         'Declared dimensions/associations are source facts; no CAD constraint solver or editing']},
        {'feature': 'dxf-paper-space', 'scope': 'Paper space layouts, sheet paper size and orthographic top-view viewports',
         'mechanism': 'standard-confirmed', 'implementation': 'experimental', 'validation': 'experimental',
         'evidenceIds': ['dxf-spec', 'ezdxf', 'policy'],
         'limitations': ['Perspective and non-top viewports are skipped and reported', 'Closed polygon/curve paper-space clipping is flattened for display; missing or invalid boundaries are skipped and reported']},
        {'feature': 'dxf-2d-presentation', 'scope': 'MLINE ACAD_TABLE WIPEOUT XLINE RAY TOLERANCE REGION and stored custom-object proxy pictures',
         'mechanism': 'standard-confirmed', 'implementation': 'implemented', 'validation': 'experimental',
         'evidenceIds': ['dxf-spec', 'ezdxf', 'cadcraft-display', 'policy'],
         'limitations': ['Source identities retained; derived artwork is not editable engineering geometry',
                         'Tables require a complete source presentation block',
                         'GDT supports 19 geometric symbols; unhandled text codes refuse the entire frame',
                         'Infinite entities are excluded from fit extents; infinite-only initial view spans 100 drawing units']},
        {'feature': 'dxf-hatch', 'scope': 'HATCH entities', 'mechanism': 'standard-confirmed',
         'implementation': 'implemented', 'validation': 'experimental', 'evidenceIds': ['dxf-spec', 'ezdxf', 'policy'],
         'limitations': ['SHIFT 0/1 use the pinned truedxf calibrated continuous field; source CAD mesh interpolation/dither are not reproduced; invalid values and unresolved boundaries are refused',
                         'Pattern display uses flattened boundaries; maximum %d strokes per entity' % MAX_PATTERN_SEGMENTS]},
        {'feature': 'dxf-plot-styles', 'scope': 'uploaded CTB/STB tables and source/explicit print preview', 'mechanism': 'standard-confirmed',
         'implementation': 'implemented', 'validation': 'experimental', 'evidenceIds': ['dxf-spec','ezdxf','truedxf-display'],
         'limitations': ['Screen preview is not a PC3/physical printer or device-halftone implementation; diamond cap/join shapes require original-CAD calibration']},
        {'feature':'dxf-media-underlays','scope':'raster/PDF/DWF/DWFx/V7 2D DGN and embedded OLE content bitmap',
         'mechanism':'standard-confirmed','implementation':'experimental','validation':'experimental','evidenceIds':['dxf-spec','policy'],
         'limitations':['Upload-only bounded readers; unknown graphical records, truncation and unresolved source fonts fail explicitly',
            'DGN V8/RSC fonts/shared-cell transforms and unsupported native curves require verified source decoding; no control-polygon substitution',
            'OLE requires one saved CF_DIB content presentation; native Office execution, EMF/WMF and rotated binary-only placement are not provided']},
    ]

    presentation = {'name': name,
                    'view': None,
                    'quality': 'DXF 二维绘制 · ' + RELEASE.get(code, code)
                               + (' · 几何显示部分完成' if not geometry_complete else ' · 几何绘制项完整')
                               + (' · SHX 配套不完整/替代预览' if shx_coverage['status'] != 'complete' else '')
                               + (' · MTEXT 部分/字段未求值' if mtext_coverage['status'] != 'complete' else '')
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
    if recovery:
        presentation['quality'] = 'DXF 恢复内容预览 · 原图信息不完整（Partial）'
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


def project_drawing(d, target, effective_layers=None, presentation_styles=None):
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
    annotation_items = d.get('extensions', {}).get('org.cad-preview.annotation-presentation/1', {}).get('items', {})
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

    def layer_style(layer_id, viewport):
        base = m['layers'][layer_id]['defaultStyle']
        return {**base, **(viewport['layerOverrides'].get(layer_id, {}) if viewport else {})}

    def layer_color(layer_id, viewport):
        style = layer_style(layer_id, viewport)['color']
        return list(style.get('rgba', [1.0, 1.0, 1.0, 1.0]))

    def layer_linetype(layer_id, viewport):
        return layer_style(layer_id, viewport).get('lineTypeId')

    def layer_lineweight(layer_id, viewport):
        fact = layer_style(layer_id, viewport).get('lineWeight')
        return fact

    def color_from(style, layer_id, chain, viewport):
        mode = style['color']['mode']
        if mode == 'explicit':
            return list(style['color']['rgba'])
        if mode == 'by-layer':
            return layer_color(layer_id, viewport)
        if mode == 'by-block':
            for parent_style, parent_layer, _parent_id in reversed(chain):
                pmode = parent_style['color']['mode']
                if pmode == 'explicit':
                    return list(parent_style['color']['rgba'])
                if pmode == 'by-layer':
                    return layer_color(parent_layer, viewport)
            return layer_color(layer_id, viewport)
        return layer_color(layer_id, viewport)

    def resolve(style, layer_id, chain, item_id, viewport):
        mode = style_modes.get(item_id, {})
        lt = style.get('lineTypeId')
        lt_mode = mode.get('lineType')
        if lt is None and lt_mode == 'by-layer':
            lt = layer_linetype(layer_id, viewport)
        elif lt is None and lt_mode == 'by-block':
            for parent_style, parent_layer, parent_id in reversed(chain):
                if parent_style.get('lineTypeId'):
                    lt = parent_style['lineTypeId']
                    break
                parent_mode = style_modes.get(parent_id, {}).get('lineType')
                if parent_mode == 'by-layer':
                    lt = layer_linetype(parent_layer, viewport)
                    break
                if parent_mode == 'by-block':
                    continue
            if lt is None:
                lt = layer_linetype(layer_id, viewport)
        lw_fact = style.get('lineWeight')
        lw_mode = mode.get('lineWeight')
        if lw_fact is None and lw_mode == 'by-layer':
            lw_fact = layer_lineweight(layer_id, viewport)
        elif lw_fact is None and lw_mode == 'by-block':
            for parent_style, parent_layer, parent_id in reversed(chain):
                if parent_style.get('lineWeight'):
                    lw_fact = parent_style['lineWeight']
                    break
                parent_mode = style_modes.get(parent_id, {}).get('lineWeight')
                if parent_mode == 'by-layer':
                    lw_fact = layer_lineweight(parent_layer, viewport)
                    break
                if parent_mode == 'by-block':
                    continue
            if lw_fact is None:
                lw_fact = layer_lineweight(layer_id, viewport)
        if lw_fact is None:
            lw_fact = {'value': DEFAULT_LINE_WEIGHT_MM, 'knowledge': 'engineering-defined',
                       'validation': 'experimental', 'evidenceIds': ['policy']}
        info = flags.get(item_id, {})
        def layer_opacity(lid):
            overrides = style_ext.get('viewportLayerOpacity', {}).get(viewport['id'], {}) if viewport else {}
            return overrides.get(lid, style_ext.get('layerOpacity', {}).get(lid, 1.0))
        opacity = layer_opacity(layer_id)
        if info.get('opacityMode') == 'explicit':
            opacity = info['opacity']
        elif info.get('opacityMode') == 'by-block':
            for _, parent_layer, parent_id in reversed(chain):
                parent = flags.get(parent_id, {})
                if parent.get('opacityMode') == 'explicit':
                    opacity = parent['opacity']; break
                if parent.get('opacityMode') != 'by-block':
                    opacity = layer_opacity(parent_layer); break
        resolved = {'color': color_from(style, layer_id, chain, viewport),
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

    def transformed_clip(instance_id, placement):
        clip = style_ext.get('blockClips', {}).get(instance_id)
        if not clip:
            return []
        return [{'boundary': [[placement[0]*x + placement[4]*y + placement[12],
                               placement[1]*x + placement[5]*y + placement[13]] for x, y in clip['boundary']],
                 'inverted': clip['inverted']}]

    def add_draw(kind, item_id, block_path, local_to_space, visibility, availability,
                 style, display_representation_id, viewport_id, layer_id, clips, chain):
        order[0] += 1
        max_draws[0] += 1
        if max_draws[0] > MAX_PROJECTION_DRAWS:
            raise ValueError('drawing-projection-over-limit')
        draw_id = identity('drawing-draw', [drawing_id, kind, item_id, block_path, viewport_id or ''])
        draw = {'kind': kind, 'itemId': item_id, 'blockPath': block_path,
                'localToSpace': local_to_space, 'visibility': visibility,
                'availability': availability, 'style': style, 'drawOrder': order[0] - 1,
                'visibilityLayerIds': list(dict.fromkeys([layer_id] + [parent[1] for parent in chain]))}
        if clips:
            draw['clipRegions'] = list(clips)
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
                if kind == 'annotation' and item.get('ownerBlockInstanceId'):
                    continue
                ref = item['sourceRefs'][0] if item.get('sourceRefs') else {}
                rank = style_ext.get('drawOrder', {}).get(item_id, int(ref.get('recordOffset', 0)))
                rows.append((rank, kind, item_id, item))
        rows.sort(key=lambda row: (row[0], row[1], row[2]))
        return rows

    attached_annotations = {}
    for item_id, item in m['annotations'].items():
        owner = item.get('ownerBlockInstanceId')
        if owner:
            ref = item['sourceRefs'][0] if item.get('sourceRefs') else {}
            rank = style_ext.get('drawOrder', {}).get(item_id, int(ref.get('recordOffset', 0)))
            attached_annotations.setdefault(owner, []).append((rank, 'annotation', item_id, item))
    for rows in attached_annotations.values():
        rows.sort(key=lambda row: (row[0], row[1], row[2]))

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

    def resolve_presentation(item_id, source_style, layer_id, chain, path, viewport, visibility, kind):
        entry = annotation_items.get(item_id, {})
        if entry.get('status') != 'ready':
            return
        draw_id = identity('drawing-draw', [drawing_id, kind, item_id, path, viewport['id'] if viewport else ''])
        selected_entry=entry
        if entry.get('scaleVariants'):
            contexts=d['extensions'].get('org.cad-preview.dxf-annotation-contexts/1',{})
            scale=viewport['annotationScale'] if viewport else contexts.get('modelDrawingPerPaper',1) if not layout_id else 1
            selected_entry=next((v for v in entry['scaleVariants'] if scale is not None and abs(v['drawingPerPaper']-scale)<=1e-9*max(1,scale)),None)
            if selected_entry is None:
                if not contexts.get('allVisible',True):
                    visibility='hidden';draws[draw_id]['visibility']='hidden'
                selected_entry=next((v for v in entry['scaleVariants'] if v['drawingPerPaper']==entry['defaultScale']),entry)
            if selected_entry['status']!='ready':
                draws[draw_id]['availability']='missing-reference' if kind=='annotation' else 'unsupported';draws[draw_id].pop('displayRepresentationId',None)
                if presentation_styles is not None: presentation_styles[draw_id]=[]
                return
        selected_parts=selected_entry['parts']
        has_stroke = any(part.get('patternedStroke') or part.get('patternContinuation') for part in selected_parts)
        if presentation_styles is None and not has_stroke and not entry.get('scaleVariants'): return
        rows = []
        pattern_gap = False
        for part in selected_parts:
            part_chain = chain + [(source_style, layer_id, item_id)]
            for ancestor in part['ancestors']:
                inherited_layer = effective_layer(ancestor['layerId'], part_chain)
                part_chain.append((ancestor['style'], inherited_layer, ancestor['id']))
            part_layer = effective_layer(part['layerId'], part_chain)
            rows.append({'id': part['id'], 'layerId': part_layer,
                         'style': resolve(part['style'], part_layer, part_chain, part['id'], viewport),
                         'visibility': 'hidden' if visibility == 'hidden' else entity_visibility(part['id'], part_layer, viewport)})
            line_type = rows[-1]['style'].get('lineTypeId')
            variant = part.get('drawVariants', {}).get(draw_id)
            if variant is None or variant['lineTypeId'] != line_type:
                variant = part.get('lineTypeVariants', {}).get(line_type)
            if variant:
                rows[-1]['presentationParts'] = variant['parts']
                if variant['status'] != 'ready': pattern_gap = True
            elif (part.get('patternedStroke') or part.get('patternContinuation')) and (
                    style_ext.get('lineTypePatterns', {}).get(line_type) or line_type in style_ext.get('complexLineTypeIds', [])):
                rows[-1]['presentationParts'] = []
                pattern_gap = True
        if pattern_gap:
            draws[draw_id]['availability'] = 'missing-reference' if kind=='annotation' else 'unsupported'
            draws[draw_id].pop('displayRepresentationId', None)
        elif entry.get('scaleVariants') or any('presentationParts' in row for row in rows):
            selected = [sub['representationId'] for row, part in zip(rows, selected_parts)
                        for sub in row.get('presentationParts', [part])]
            draws[draw_id]['displayRepresentationId'] = identity('representation', [item_id, 'linetype', selected])
        if presentation_styles is not None: presentation_styles[draw_id] = rows

    def walk(space_id, transform, path, viewport, chain, inherited_hidden=False, clips=()):
        visit(members(space_id), transform, path, viewport, chain, inherited_hidden, clips)

    def visit(rows, transform, path, viewport, chain, inherited_hidden, clips):
        for record_offset, kind, item_id, item in rows:
            if kind == 'entity':
                layer_id = effective_layer(item['layerId'], chain)
                visibility = 'hidden' if inherited_hidden else entity_visibility(item_id, layer_id, viewport)
                presentation = annotation_items.get(item_id, {})
                rendered = presentation.get('status') == 'ready'
                availability = 'unsupported' if presentation.get('status') == 'missing' or item['geometry']['type'] == 'unsupported' and not rendered else 'ready'
                style = resolve(item['style'], layer_id, chain, item_id, viewport)
                local = mat_mul(transform, item['localFromOwner'])
                representation_id = (item.get('displayRepresentationId') or identity('representation', [item_id])
                                     if availability == 'ready' and annotation_items.get(item_id, {}).get('mode') != 'view-dependent' else None)
                add_draw('entity', item_id, path, local, visibility, availability,
                         style, representation_id, viewport['id'] if viewport else None, layer_id, clips, chain)
                resolve_presentation(item_id, item['style'], layer_id, chain, path, viewport, visibility, 'entity')
            elif kind == 'annotation':
                info = flags.get(item_id, {})
                layer_id = effective_layer(item['layerId'], chain)
                visibility = 'hidden' if inherited_hidden else entity_visibility(item_id, layer_id, viewport)
                # An ATTDEF draw is a definition with no own presentation: the displayed
                # value is the ATTRIB that map_insert materializes for each INSERT. A
                # DIMENSION without a presentation block is likewise not drawable.
                availability = ('missing-reference' if info.get('attributeTemplate')
                                or info.get('presentationGeometry') == 'missing' else 'ready')
                source_style = annotation_styles.get(item_id, {'color': {'mode': 'by-layer'}, 'plot': True})
                style = resolve(source_style, layer_id, chain, item_id, viewport)
                if item.get('fontResourceId'):
                    style['fontResourceId'] = item['fontResourceId']
                add_draw('annotation', item_id, path, transform, visibility, availability,
                         style, identity('representation', [item_id]) if annotation_items.get(item_id, {}).get('status') == 'ready' else None,
                         viewport['id'] if viewport else None, layer_id, clips, chain)
                resolve_presentation(item_id, source_style, layer_id, chain, path, viewport, visibility, 'annotation')
            else:
                definition = m['blocks'][item['definitionId']]
                layer_id = effective_layer(item['layerId'], chain)
                array = item.get('array')
                row_offset = array['rowOffset'] if array else (0, 0, 0)
                column_offset = array['columnOffset'] if array else (0, 0, 0)
                # A zero-spaced dimension is one placement, as in source MINSERT.
                rows = array['rows'] if array and any(row_offset) else 1
                columns = array['columns'] if array and any(column_offset) else 1
                if rows * columns > MAX_PROJECTION_DRAWS:
                    raise ValueError('drawing-projection-over-limit')
                hidden = inherited_hidden or entity_visibility(item_id, layer_id, viewport) == 'hidden'
                child_chain = chain + [(item['style'], layer_id, item_id)]
                for row in range(rows):
                    for column in range(columns):
                        offset = mat_translate(*(column_offset[axis] * column + row_offset[axis] * row for axis in range(3)))
                        owner_placement = mat_mul(transform, offset)
                        placement = mat_mul(owner_placement, item['localFromBlock'])
                        child_path = path + [{'instanceId': item_id, 'row': row, 'column': column}]
                        child_clips = list(clips) + transformed_clip(item_id, placement)
                        walk(definition['spaceId'], placement, child_path, viewport, child_chain, hidden, child_clips)
                        visit(attached_annotations.get(item_id, ()), owner_placement, child_path,
                              viewport, child_chain, hidden, child_clips)

    if layout_id:
        for vid in m['layouts'][layout_id]['viewportIds']:
            viewport = m['viewports'][vid]
            if not viewport['enabled']:
                continue
            walk(viewport['sourceSpaceId'], viewport['modelToPaper'], [], viewport, [])
        walk(space_id, mat_identity(), [], None, [])
    else:
        walk(space_id, mat_identity(), [], None, [])

    return {'drawingId': drawing_id, 'target': {'kind': 'model', 'spaceId': drawing_row['modelSpaceId']}
            if not layout_id else {'kind': 'layout', 'layoutId': layout_id},
            'viewports': {vid: m['viewports'][vid] for vid in viewports},
            'layerStates': layer_states, 'draws': draws}


def project_block(d, block_id, effective_layers=None, presentation_styles=None):
    """Read-only definition preview, separate from persisted UCD projections."""
    block = d['drawing']['blocks'][block_id]
    drawings = dict(d['drawing']['drawings'])
    drawings[block['drawingId']] = dict(drawings[block['drawingId']], modelSpaceId=block['spaceId'])
    view = dict(d, drawing=dict(d['drawing'], drawings=drawings))
    result = project_drawing(view, {'kind': 'model', 'spaceId': block['spaceId']},
                             effective_layers, presentation_styles)
    result['target'] = {'kind': 'block-preview', 'blockId': block_id}
    return result
