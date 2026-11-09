"""Independent native ACadSharp DWG -> UCD assembly.

The native worker emits UCD records and community-evaluated display geometry.
The original DWG, its digest and source handles remain authoritative. This does
not import or invoke a DXF parser, converter, entity mapper or recovery path.
"""
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import struct
import subprocess
import sys
import time

from .validation import validate_binary_envelope
from .canonical import canonical_sha256,write_canonical
from .payload_sink import FileSink
from .dwg_pack import pack_document

VERSION = '0.1.0-local'
IDENTITY = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
TABLES = ('drawings','spaces','sheets','layouts','viewports','entities','annotations',
          'blocks','blockInstances','layers','lineTypes','textStyles','plotStyles','hatchPatterns')


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def run_reader(dotnet, reader, source, native, stdout=subprocess.DEVNULL):
    """Native diagnostics flow to the job's bounded stderr log, never an unbounded pipe."""
    try:
        subprocess.run([dotnet, reader, str(source), str(native)], check=True,
                       stdout=stdout, stderr=sys.stderr)
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f'native DWG reader failed (exit {error.returncode}); see bounded worker log') from error


def digest(value):
    return canonical_sha256(value)


def unknown():
    return {'knowledge':'unknown', 'validation':'not-applicable', 'evidenceIds':[]}


def fact(value):
    return {'value':value, 'knowledge':'source-declared', 'validation':'experimental', 'evidenceIds':['native-dwg-read']}


def file_identity(path):
    with Path(path).open('rb') as stream:
        signature = stream.read(6)
        if len(signature) != 6 or signature[:4] != b'AC10' or not signature[4:].isdigit():
            raise ValueError('native-dwg-signature-required')
        stream.seek(0)
        sha = hashlib.file_digest(stream, 'sha256').hexdigest()
    return {'name':Path(path).name, 'sha256':sha, 'byteLength':Path(path).stat().st_size,
            'format':'DWG', 'detectedVersion':signature.decode('ascii')}


def infinite_presentation_items(rows, entities):
    """Map native XLINE/RAY parameters to the existing view-dependent infinite
    presentation contract. The viewer clips these lines to the current view;
    they never acquire a fabricated finite engineering extent."""
    items = {}
    for key, row in rows.items():
        entity = entities.get(key)
        if not entity:
            continue
        kind = str(row.get('kind') or 'xline').lower()
        origin, direction = row.get('origin'), row.get('direction')
        if not isinstance(origin, list) or not isinstance(direction, list):
            continue
        if len(origin) < 2 or len(direction) < 2:
            continue
        try:
            values = [float(value) for value in (origin[:3] + direction[:3])]
        except (TypeError, ValueError):
            continue
        if not all(math.isfinite(value) for value in values):
            continue
        if math.sqrt(sum(value * value for value in values[3:6])) < 1e-12:
            continue
        items[key] = {
            'status': 'ready', 'sourceKind': kind.upper(),
            'sourceRefs': row.get('sourceRefs') or entity.get('sourceRefs') or [],
            'mode': 'view-dependent', 'method': 'native-DWG-parametric-view-clipping',
            'parts': [{
                'id': key + '-infinite', 'role': 'infinite',
                'line': {'kind': kind, 'origin': origin, 'direction': direction},
                'layerId': entity.get('layerId'),
                'style': entity.get('style') or {'color': {'mode': 'by-layer'}, 'plot': True},
                'ancestors': [],
            }],
        }
    return items


VENDOR_EZDXF = Path(__file__).resolve().parent.parent / 'vendor/ezdxf/src'


def add_polyline_width_displays(entities, displays, extras, buffer_bytes):
    """Build source-width bands in entity OCS; INSERT/OCS transforms stay shared."""
    if str(VENDOR_EZDXF) not in sys.path:
        sys.path.insert(0, str(VENDOR_EZDXF))
    from .dxf_stroke import display_parts_from_vertices
    for key, entity in entities.items():
        geometry = entity['geometry']
        if geometry['type'] != 'polyline' or not any(any(w) for w in geometry.get('widths', [])):
            continue
        points, widths, bulges = geometry['points'], geometry['widths'], geometry['bulges']
        stations = [(point[:2], *(widths[i] if i < len(widths) else (0, 0)),
                     bulges[i] if i < len(bulges) else 0) for i, point in enumerate(points)]
        batches = display_parts_from_vertices(stations, geometry['closed'], points[0][2], 64, 1000000)
        parts = {}
        for positions, indices, topology in batches:
            role = 'fill' if topology == 'triangles' else 'stroke'
            part_id = key + '-width-' + role
            vertices = [positions[index] for primitive in indices for index in primitive]
            offset = len(buffer_bytes)
            for point in vertices:
                buffer_bytes.extend(struct.pack('<3d', *point))
            displays[part_id] = {'offset':offset, 'byteLength':len(vertices)*24,
                'count':len(vertices), 'topology':topology,
                'min':[min(p[axis] for p in vertices) for axis in range(3)],
                'max':[max(p[axis] for p in vertices) for axis in range(3)],
                'sourceRefs':entity['sourceRefs']}
            parts[role] = part_id
        displays.pop(key, None)
        extras.setdefault('meshPresentations', {})[key] = {
            'sourceKind':'POLYLINE', 'fill':parts.get('fill'), 'stroke':parts.get('stroke')}


def add_short_linetype_displays(entities, line_types, displays, extras):
    """A-type paths shorter than a complete pattern keep their full source stroke.

    Only fixed simple source linetypes are resolved here. Longer patterns and
    inherited linetypes keep their existing rendering path.
    """
    if str(VENDOR_EZDXF) not in sys.path:
        sys.path.insert(0, str(VENDOR_EZDXF))
    from .dxf_linetype import Segment, fitted_events
    continuous_id = next((key for key, row in line_types.items()
                          if row['name'].upper() == 'CONTINUOUS'), None)
    settings = extras.get('nativeLineTypeSettings', {}).get('drawing-dwg')
    if continuous_id is None or settings is None:
        return
    for key, entity in entities.items():
        line_id = entity['style'].get('lineTypeId')
        definition = line_types.get(line_id, {})
        details = extras.get('nativeLineTypes', {}).get(line_id, {})
        if details.get('alignment') != 'A' or details.get('complex', True) or key not in displays:
            continue
        pattern = definition.get('segments', [])
        if not pattern or not any(p['kind'] == 'gap' for p in pattern):
            continue
        scale = settings['scale'] * extras.get('entityState', {}).get(key, {}).get('lineTypeScale', 1)
        lengths = [p['length'] * scale for p in pattern]
        period = sum(lengths)
        if scale <= 0 or period <= 0:
            continue
        groups = [{49: p['length'] * (-1 if p['kind'] == 'gap' else 1)} for p in pattern]
        geometry = entity['geometry']
        if geometry['type'] == 'line':
            paths = [math.dist(geometry['start'], geometry['end'])]
        elif geometry['type'] == 'polyline':
            native = extras.get('nativeGeometry', {}).get(key, {})
            if 'lineTypeContinuous' not in native or any(any(w) for w in geometry.get('widths', [])):
                continue
            vertices = native['vertices']
            count = len(vertices) if native['closed'] else len(vertices)-1
            paths = [Segment(tuple(vertices[i]['point'])+(native['elevation'],),
                tuple(vertices[(i+1)%len(vertices)]['point'])+(native['elevation'],),
                bulge=vertices[i]['bulge']).length for i in range(count)]
            if native['lineTypeContinuous']:
                paths = [sum(paths)]
        else:
            continue
        if not paths or any(length >= period for length in paths):
            continue
        if any(fitted_events(length, groups, lengths, period, False, 100)[0]
               != [('dash', 0, length)] for length in paths):
            continue
        part = key + '-short-linetype'
        displays[part] = dict(displays.pop(key))
        extras.setdefault('meshPresentations', {})[key] = {
            'sourceKind': geometry['type'].upper(), 'stroke': part, 'lineTypeId': continuous_id}


def region_boundary_leaves(raw):
    """Parse retained ACIS bytes through the same planar SAT/SAB reader as DXF.
    Returns (leaves, error); without the optional ACIS stack the caller keeps the
    source loss instead of guessing a boundary."""
    try:
        if str(VENDOR_EZDXF) not in sys.path and VENDOR_EZDXF.is_dir():
            sys.path.insert(0, str(VENDOR_EZDXF))
        from . import dxf_region
        class Source:
            has_binary_data = True
            sab = raw
            @staticmethod
            def graphic_properties():
                return {}
        return list(dxf_region.primitives(Source())), None
    except Exception as error:
        return None, type(error).__name__ + ': ' + str(error)


def region_leaf_pairs(leaf):
    """Flatten one planar ACIS boundary curve into a flat list of line pairs."""
    kind = leaf.dxftype()
    if kind == 'LINE':
        points = [leaf.dxf.start, leaf.dxf.end]
    elif kind in ('ELLIPSE', 'SPLINE'):
        points = list(leaf.flattening(0.01))
        if getattr(leaf, 'closed', False) and points and points[0] != points[-1]:
            points.append(points[0])
    else:
        return []
    pairs = []
    for start, end in zip(points, points[1:]):
        pairs.extend([(float(start.x), float(start.y), float(start.z)),
                      (float(end.x), float(end.y), float(end.z))])
    return pairs


def trim_spline_origin_pair(row, entity, buffer_bytes):
    """Drop the ACadSharp periodic-spline origin pair from a paired line row.

    ACadSharp 3.8.30 can evaluate a periodic spline at uStart to XYZ.Zero while
    the control polygon sits far from the origin. The reader's display writer
    stores consecutive vertex pairs, so the artifact appears as one bogus first
    pair (origin -> first real point). The current reader source removes the
    leading vertex; older engine binaries can still emit the pair, so the adapter
    trims it here as well. This keys on the spline data shape, never a file name
    or handle.
    """
    geometry = (entity or {}).get('geometry') or {}
    if geometry.get('type') != 'spline' or row.get('topology') != 'lines':
        return row
    offset, count, length = row.get('offset'), row.get('count'), row.get('byteLength')
    if not isinstance(offset, int) or not isinstance(count, int) or not isinstance(length, int):
        return row
    if count < 4 or offset < 0 or offset + 48 > len(buffer_bytes):
        return row
    first = struct.unpack_from('<3d', buffer_bytes, offset)
    second = struct.unpack_from('<3d', buffer_bytes, offset + 24)
    if max(abs(value) for value in first) > 1e-9:
        return row
    if math.hypot(second[0], second[1]) <= 1:
        return row
    control = geometry.get('controlPoints') or []
    if control and abs(control[0][0]) < 1e-6 and abs(control[0][1]) < 1e-6:
        return row
    offset += 48
    count -= 2
    remaining = struct.unpack_from('<' + 'd' * (count * 3), buffer_bytes, offset)
    xs, ys, zs = remaining[0::3], remaining[1::3], remaining[2::3]
    return {**row, 'offset': offset, 'byteLength': length - 48, 'count': count,
            'min': [min(xs), min(ys), min(zs)], 'max': [max(xs), max(ys), max(zs)]}


def _source_handle(row):
    refs = row.get("sourceRefs") if isinstance(row, dict) else None
    if not isinstance(refs, list) or not refs:
        return None
    first = refs[0]
    if not isinstance(first, dict):
        return None
    value = first.get("objectKey")
    if value is None:
        return None
    value = str(value)
    return value or None


def _table_by_source_handle(table):
    rows = {}
    for row in (table or {}).values():
        handle = _source_handle(row)
        if handle is not None:
            rows.setdefault(handle, row)
    return rows


def native_block_clip(clip):
    """Map enabled planar DWG boundaries into block-definition coordinates."""
    if not clip['enabled']:
        return None
    if clip['inverted'] or clip['front'] or clip['back']:
        raise ValueError('native-xclip-inverted-or-depth-unsupported')
    if clip['normal'] != [0, 0, 1] or clip['origin'] != [0, 0, 0] or clip['clipTransform'] != IDENTITY:
        raise ValueError('native-xclip-plane-transform-unsupported')
    points = clip['boundary']
    # Expand before transforming: a rotated rectangle is not an axis-aligned box.
    if len(points) == 2:
        (x0, y0), (x1, y1) = points
        points = [[x0,y0], [x1,y0], [x1,y1], [x0,y1]]
    m = clip['inverseInsert']
    boundary = [[m[0]*x+m[4]*y+m[12], m[1]*x+m[5]*y+m[13]] for x,y in points]
    if len(boundary)>1 and boundary[0] == boundary[-1]:
        boundary.pop()
    if len(boundary)<3 or not all(math.isfinite(v) for p in boundary for v in p):
        raise ValueError('native-xclip-invalid-boundary')
    if any(abs(m[2]*x+m[6]*y+m[14])>1e-9 for x,y in points):
        raise ValueError('native-xclip-nonplanar-block-boundary')
    x0,y0 = boundary[0]
    area = sum((a[0]-x0)*(b[1]-y0)-(b[0]-x0)*(a[1]-y0)
               for a,b in zip(boundary,boundary[1:]+boundary[:1]))
    if not math.isfinite(area) or area == 0:
        raise ValueError('native-xclip-degenerate-boundary')
    return {'boundary':boundary, 'inverted':False}


def source_display_coverage(drawing, displays, presentation_items, summary, native_fonts, fills=None, text_layouts=None, dimension_semantics=None):
    """Account for every unique native source handle exactly once.

    Direct display rows, annotation presentation and block-instance indirection
    are different display mechanisms. Counting only the first while comparing
    against every mapped UCD object reports normal block reuse as missing
    geometry. This ledger partitions the union of mapped source handles and
    keeps empty-but-valid block definitions distinct from unresolved handles.
    """
    entity_rows = _table_by_source_handle(drawing.get("entities"))
    annotation_rows = _table_by_source_handle(drawing.get("annotations"))
    instance_rows = _table_by_source_handle(drawing.get("blockInstances"))
    dimension_rows = _table_by_source_handle(dimension_semantics)
    entity_handles = set(entity_rows)
    annotation_handles = set(annotation_rows)
    instance_handles = set(instance_rows)
    source_handles = entity_handles | annotation_handles | instance_handles

    direct_handles = set()
    for row in (displays or {}).values():
        handle = _source_handle(row)
        if handle is not None:
            direct_handles.add(handle)
    for row in (presentation_items or {}).values():
        handle = _source_handle(row)
        if handle is not None:
            direct_handles.add(handle)
    fill_handles = set()
    for key in (fills or {}):
        row = (drawing.get("entities") or {}).get(key)
        handle = _source_handle(row)
        if handle is not None:
            fill_handles.add(handle)
    visual_entity_handles = direct_handles | fill_handles

    entity_handles_by_space = {}
    for handle, row in entity_rows.items():
        space = row.get("ownerSpaceId")
        entity_handles_by_space.setdefault(space, set()).add(handle)
    annotation_handles_by_space = {}
    for handle, row in annotation_rows.items():
        space = row.get("ownerSpaceId")
        annotation_handles_by_space.setdefault(space, set()).add(handle)
    instances_by_space = {}
    for handle, row in instance_rows.items():
        space = row.get("ownerSpaceId")
        instances_by_space.setdefault(space, []).append((handle, row))

    blocks = drawing.get("blocks") or {}
    visual_definition_cache = {}

    def definition_has_visual_content(definition_id, active=None):
        if definition_id in visual_definition_cache:
            return visual_definition_cache[definition_id]
        if active is None:
            active = set()
        if definition_id in active:
            return False
        block = blocks.get(definition_id)
        if not isinstance(block, dict):
            return False
        active.add(definition_id)
        space = block.get("spaceId")
        visible = bool(entity_handles_by_space.get(space, set()) & visual_entity_handles)
        if not visible and annotation_handles_by_space.get(space):
            visible = True
        if not visible:
            for child_handle, child in instances_by_space.get(space, []):
                child_id = child.get("definitionId")
                if isinstance(child_id, str) and definition_has_visual_content(child_id, active):
                    visible = True
                    break
        active.remove(definition_id)
        visual_definition_cache[definition_id] = visible
        return visible

    valid_instance_handles = set()
    empty_instance_handles = set()
    missing_definition_handles = set()
    unresolved_reference_handles = set()
    for handle, row in instance_rows.items():
        definition_id = row.get("definitionId")
        if definition_id not in blocks:
            missing_definition_handles.add(handle)
        elif blocks[definition_id].get('externalReferenceId'):
            unresolved_reference_handles.add(handle)
        else:
            valid_instance_handles.add(handle)
            if not definition_has_visual_content(definition_id):
                empty_instance_handles.add(handle)

    reasons = {}
    unsupported = Counter()
    for handle in source_handles:
        if handle in direct_handles:
            reasons[handle] = "directGeometry"
        elif handle in annotation_handles:
            reasons[handle] = "annotationPresentation"
        elif handle in valid_instance_handles:
            reasons[handle] = "blockInstanceIndirect"
        else:
            reasons[handle] = "unresolved"
            row = entity_rows.get(handle)
            if handle in unresolved_reference_handles:
                unsupported['XREF'] += 1
                continue
            geometry = (row or {}).get("geometry") or {}
            source_type = ("DIMENSION_CONSTRAINT" if dimension_rows.get(handle, {}).get("pictureStatus") == "constraint-without-picture"
                           else geometry.get("sourceType"))
            unsupported[str(source_type or "UNKNOWN")] += 1

    direct_count = sum(value == "directGeometry" for value in reasons.values())
    annotation_count = sum(value == "annotationPresentation" for value in reasons.values())
    block_count = sum(value == "blockInstanceIndirect" for value in reasons.values())
    unresolved_count = sum(value == "unresolved" for value in reasons.values())
    source_count = len(source_handles)
    status = "complete" if unresolved_count == 0 else "partial"
    return {
        "status": status,
        "withDisplayGeometry": source_count - unresolved_count,
        "withoutDisplayGeometry": unresolved_count,
        "sourceRecords": source_count,
        "sourceRecordBasis": "unique-source-handle",
        "byReason": {
            "directGeometry": direct_count,
            "annotationPresentation": annotation_count,
            "blockInstanceIndirect": block_count,
            "blockInstanceEmptyDefinition": len(empty_instance_handles),
            "externalReferenceUnresolved": len(unresolved_reference_handles),
            "unresolved": unresolved_count,
            "unsupported": dict(sorted(unsupported.items())),
        },
        "blockInstanceDefinitionsMissing": len(missing_definition_handles),
        "fidelity": {
            "status": "partial" if native_fonts else "complete",
            "fontSubstitution": {
                "status": "partial" if native_fonts else "complete",
                "nativeFontRecords": len(native_fonts or {}),
                "annotationSourceRecords": len(annotation_handles),
                "originalCompanionsProvided": bool(text_layouts),
                "originalGlyphLayouts": sum(row["status"] == "ready" and not row.get("linkedCharacters") for row in (text_layouts or {}).values()),
                "linkedGlyphLayouts": sum(bool(row.get("linkedCharacters")) for row in (text_layouts or {}).values()),
                "substitutedLayouts": sum(row["status"] != "ready" for row in (text_layouts or {}).values()),
                "note": ("Original companion glyphs and layout are used where resolved; linked characters and unresolved objects are retained in the text layout records."
                         if text_layouts else "Source font companions are not supplied; text glyphs and layout remain an explicit substitution."),
            },
        },
        "mappedObjectRecords": summary.get("mappedObjects"),
        "mappedSourceObjects": summary.get("mappedSourceObjects", source_count),
    }


def assemble_native(folder, original, output, platform=False, binary_dir=None, packed=False, font_files=None):
    started=time.perf_counter()
    def phase(name):print(f'DWG UCD {name}: {time.perf_counter()-started:.3f}s',file=sys.stderr,flush=True)
    folder, output = Path(folder), Path(output)
    summary = json.loads((folder/'native-summary.json').read_text())
    identity = file_identity(original)
    if any(summary['source'][k] != v for k,v in identity.items()):
        raise ValueError('native-worker-source-identity-mismatch')
    # SourceRef foreign keys are scoped by this immutable UCD document. Full
    # source/buffer digests stay in their authoritative records, never truncated.
    sid = 'source-0'
    did = 'drawing-dwg'
    doc = {
        'schemaVersion':'2.0.0', 'serializationProfile':'ucd-json-python-sorted/1',
        'documentId':'document-'+identity['sha256'], 'revision':'0'*64,
        'sources':[{'id':sid, **identity}],
        'adapter':{'id':'libiaolink-acadsharp-dwg', 'version':VERSION,
            'implementationHash':digest({'wrapper':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                'nativeReader':summary['readerSha256']}),
            'ruleSetHash':digest({'reader':'3.8.30', 'nativeProtocol':1, 'curveDisplay':'ACadSharp evaluated', 'version':VERSION}),
            'dependencies':[{'name':'ACadSharp', 'version':'3.8.30+intersection-field-separation'}]},
        'coordinates':{'space':'source-unknown', 'lengthUnit':fact('mm') if summary['header']['insUnits']=='Millimeters' else unknown(),
            'handedness':unknown(), 'upAxis':unknown(), 'sourceToDocument':IDENTITY,
            'conversionReason':'Preserve native DWG coordinates, including Z; viewer uses a top 2D projection.'},
        **{k:{} for k in ('products','productOccurrences','sceneOccurrences','renderOwnership',
                          'representations','geometries','accessors','buffers','resources','materials','properties')},
        'productRoots':[], 'configurations':[], 'displayStates':[],
        'viewContexts':[{'id':'native-dwg', 'origin':'system-default', 'name':'DWG model'}],
        'defaultSelection':fact({'viewContextId':'native-dwg'}), 'externalReferences':[], 'capabilities':[],
        'diagnostics':[],
        'evidence':[{'id':'native-dwg-read', 'kind':'native', 'reference':identity['sha256'],
                     'scope':'Pinned ACadSharp native read, original handle ledger and explicit mapping losses'}],
        'drawing':{table:{} for table in TABLES}, 'extensions':{}, 'extensionsRequired':[]}
    drawing = doc['drawing']
    extras = {}
    displays = {}
    for line in (folder/'ucd-records.jsonl').open():
        row = json.loads(line)
        table, key, value = row['table'], row['id'], row['value']
        target = drawing[table] if table in drawing else displays if table=='displays' else extras.setdefault(table,{})
        # Native state updates intentionally refine one item (e.g. hidden hatch
        # boundary); other rows must never silently replace a source identity.
        if key in target and table != 'entityState':
            raise ValueError('duplicate-native-record:'+table+':'+key)
        if table=='entityState':
            target.setdefault(key,{}).update(value)
        else:
            target[key] = value
    phase('native records loaded')
    for block_id, reference in extras.get('nativeExternalReferences', {}).items():
        reference_id = 'xref-' + block_id
        drawing['blocks'][block_id]['externalReferenceId'] = reference_id
        doc['externalReferences'].append({'id':reference_id, 'ownerSourceId':sid,
            'requestedPath':reference['requestedPath'], 'required':True, 'status':'blocked',
            'reason':'原生 DWG 外参关系已保留；配套外参加载尚未接入，不能将其视为有效空块。'})
        doc['diagnostics'].append({'code':'native-xref-unresolved','severity':'warning','stage':'mapping',
            'message':'External DWG reference retained but not loaded; no source filesystem path was opened.',
            'sourceRefs':reference['sourceRefs']})
    block_clips = {}
    clip_losses = []
    for key, clip in extras.get('nativeBlockClips', {}).items():
        try:
            result = native_block_clip(clip)
            if result is not None: block_clips[key] = result
        except ValueError as error:
            clip_losses.append({'code':str(error), 'message':'Source clip retained but not applied.',
                'handle':drawing['blockInstances'][key]['sourceRefs'][0]['objectKey'], 'sourceType':'INSERT'})
    for table, member in [('entities','entityIds'),('annotations','annotationIds'),('blockInstances','blockInstanceIds')]:
        for key,row in drawing[table].items():
            drawing['spaces'][row['ownerSpaceId']][member].append(key)
    for key,fill in extras.get('fills',{}).items():
        row=drawing['entities'][key]
        if row['geometry']['type']=='polyline':
            boundary_id=key+'-solid-boundary'
            boundary={**row,'id':boundary_id}
            drawing['entities'][boundary_id]=boundary
            drawing['spaces'][row['ownerSpaceId']]['entityIds'].append(boundary_id)
            extras.setdefault('entityState',{})[boundary_id]={'visible':False}
            row['geometry']={'type':'hatch','boundaryEntityIds':[boundary_id],'fillRule':'even-odd'}
    for key,row in drawing['entities'].items():
        if row['geometry']['type']=='hatch' and key in displays and key not in extras.get('fills',{}):
            pattern_id='pattern-'+key
            row['geometry']['patternId']=pattern_id
            native=extras.get('hatchSemantics',{}).get(key,{})
            drawing['hatchPatterns'][pattern_id]={'id':pattern_id,'name':native.get('pattern','Native ACadSharp evaluated pattern'),'lines':[]}
    drawing['drawings'][did] = {'id':did, 'name':identity['name'], 'sourceIds':[sid],
        'modelSpaceId':summary['modelSpaceId'], 'sheetIds':[], 'layoutIds':list(drawing['layouts']),
        'layerIds':list(drawing['layers']), 'units':doc['coordinates']['lengthUnit']}
    buffer_path = folder/'positions.bin'
    bid = 'buffer-0'
    # Reassembly starts at the native display extent, excluding previously appended derivatives.
    native_bytes = max((row['offset'] + row['byteLength'] for row in displays.values()), default=0)
    buffer_bytes = bytearray(buffer_path.read_bytes()[:native_bytes])
    from .dwg_acis import reconstruct
    acis_rows,acis_errors,acis_bytes=reconstruct(folder,extras.get('opaque',{}),drawing['entities'])
    acis_handles=set()
    acis_base=len(buffer_bytes);buffer_bytes.extend(acis_bytes)
    for result in acis_rows:
        key=result['id'];entity=drawing['entities'][key];parts={}
        for part in result['parts']:
            part_id=key+'-acis-'+part['role'];parts[part['role']]=part_id
            displays[part_id]={**part,'offset':acis_base+part['offset'],
                'topology':'triangles' if part['role']=='fill' else 'lines','sourceRefs':entity['sourceRefs']}
        extras.setdefault('meshPresentations',{})[key]={
            'sourceKind':entity['geometry']['sourceType'],'fill':parts['fill'],'stroke':parts.get('stroke'),
            'faceCount':result['faceCount'],'triangleCount':result['triangleCount'],
            'acis':{k:result[k] for k in ('unitsMM','resabs','resnor','saveVersion')}}
        acis_handles.add(extras['opaque'][key]['handle'])
    if acis_rows:
        doc['adapter']['dependencies'].extend([{'name':'cq-acis','version':'0.3.12'},{'name':'cadquery','version':'2.8.0'},{'name':'cadquery-ocp','version':'7.9.3.1.1'}])
    for key,reason in acis_errors.items():
        doc['diagnostics'].append({'code':'native-acis-unavailable','severity':'warning','stage':'mapping',
            'message':reason,'sourceRefs':drawing['entities'][key]['sourceRefs']})
    add_polyline_width_displays(drawing['entities'], displays, extras, buffer_bytes)
    add_short_linetype_displays(drawing['entities'], drawing['lineTypes'], displays, extras)
    text_layouts = {}
    if font_files:
        from .dwg_text import add_text_displays
        text_layouts = add_text_displays(drawing['annotations'], displays, extras, buffer_bytes, font_files)
        phase('original-font text laid out')
    for key,row in displays.items():
        row = trim_spline_origin_pair(row, drawing['entities'].get(key), buffer_bytes)
        aid, gid = 'a-'+key, 'g-'+key
        doc['accessors'][aid] = {'bufferId':bid, 'byteOffset':row['offset'], 'byteLength':row['byteLength'],
            'component':'f64', 'components':3, 'count':row['count'], 'normalized':False}
        doc['geometries'][gid] = {'id':gid, 'coordinateSpace':'geometry-local', 'attributes':{'POSITION':aid},
            'primitives':[{'id':'p','topology':row['topology'],'range':{'first':0,'count':row['count']}}],
            'bounds':{'min':row['min'],'max':row['max']}, 'normalOrigin':'absent', 'sourceRefs':row['sourceRefs']}
        rid = 'representation-'+digest([key])
        doc['representations'][rid] = {'id':rid, 'kind':'drawing', 'bindings':[{'id':'b','geometryId':gid,
            'localFromRepresentation':IDENTITY, 'materialSlots':{}}], 'sourceRefs':row['sourceRefs']}
    mesh_items = {}
    for key, meta in extras.get('meshPresentations', {}).items():
        entity = drawing['entities'].get(key) or drawing['annotations'][key]
        parts = []
        source_parts = meta.get('textParts')
        if source_parts is None:
            source_parts = [{'id': meta.get(role), 'role': role, 'color': {'mode':'by-block'}}
                            for role in ('fill', 'stroke')]
        for source_part in source_parts:
            role, part_id = source_part['role'], source_part['id']
            if not part_id:
                continue
            rid = 'representation-' + digest([part_id])
            geometry = doc['geometries'][doc['representations'][rid]['bindings'][0]['geometryId']]
            primitive = geometry['primitives'][0]
            # Presentation consumers require an explicit index accessor.
            iaid = 'i-' + part_id
            offset = len(buffer_bytes)
            indices = displays[part_id].get('indices')
            if indices is None: indices = range(displays[part_id]['count'])
            count = len(indices)
            buffer_bytes.extend(struct.pack('<' + str(count) + 'I', *indices))
            primitive['range']['count'] = count
            while len(buffer_bytes) % 8:
                buffer_bytes.append(0)
            doc['accessors'][iaid] = {'bufferId':bid, 'byteOffset':offset, 'byteLength':count*4,
                'component':'u32', 'components':1, 'count':count, 'normalized':False}
            primitive['indices'] = iaid
            parts.append({'id':part_id, 'representationId':rid, 'role':role,
                'layerId':entity['layerId'], 'style':{'color':source_part['color'],'plot':True},
                'ancestors':[]})
            if meta.get('lineTypeId'):
                parts[-1]['style']['lineTypeId'] = meta['lineTypeId']
        mesh_items[key] = {'status':'ready', 'sourceKind':meta['sourceKind'],
            'sourceRefs':entity['sourceRefs'], 'mode':'geometry', 'parts':parts}
    region_items = {}
    region_handles = set()
    region_errors = []
    for key,meta in extras.get('opaque',{}).items():
        entity = drawing['entities'].get(key)
        if not entity or key in mesh_items or (entity.get('geometry') or {}).get('sourceType')!='REGION':
            continue
        opaque_path = folder/('opaque-'+str(meta.get('handle'))+'.bin')
        if not opaque_path.is_file():
            continue
        leaves,error = region_boundary_leaves(opaque_path.read_bytes())
        if leaves is None:
            region_errors.append((entity,error))
            continue
        parts = []
        for index,leaf in enumerate(leaves):
            pairs = region_leaf_pairs(leaf)
            if not pairs or not all(math.isfinite(value) for point in pairs for value in point):
                continue
            xs = [point[0] for point in pairs]; ys = [point[1] for point in pairs]; zs = [point[2] for point in pairs]
            offset = len(buffer_bytes)
            for point in pairs:
                buffer_bytes.extend(struct.pack('<3d',*point))
            index_offset = len(buffer_bytes)
            indices = list(range(len(pairs)))
            for value in indices:
                buffer_bytes.extend(struct.pack('<I',value))
            while len(buffer_bytes)%8:
                buffer_bytes.append(0)
            aid = 'a-'+key+'-region-'+str(index)
            iaid = 'i-'+key+'-region-'+str(index)
            gid = 'g-'+key+'-region-'+str(index)
            rid = 'representation-'+digest([key,'region',index])
            doc['accessors'][aid] = {'bufferId':bid, 'byteOffset':offset, 'byteLength':len(pairs)*24,
                'component':'f64', 'components':3, 'count':len(pairs), 'normalized':False}
            doc['accessors'][iaid] = {'bufferId':bid, 'byteOffset':index_offset, 'byteLength':len(indices)*4,
                'component':'u32', 'components':1, 'count':len(indices), 'normalized':False}
            doc['geometries'][gid] = {'id':gid, 'coordinateSpace':'geometry-local', 'attributes':{'POSITION':aid},
                'primitives':[{'id':'p','topology':'lines','indices':iaid,'range':{'first':0,'count':len(indices)}}],
                'bounds':{'min':[min(xs),min(ys),min(zs)],'max':[max(xs),max(ys),max(zs)]},
                'normalOrigin':'absent', 'sourceRefs':entity.get('sourceRefs') or []}
            doc['representations'][rid] = {'id':rid, 'kind':'drawing', 'bindings':[{'id':'b','geometryId':gid,
                'localFromRepresentation':IDENTITY, 'materialSlots':{}}], 'sourceRefs':entity.get('sourceRefs') or []}
            parts.append({'id':key+'-region-'+str(index), 'representationId':rid, 'role':'geometry',
                'layerId':entity.get('layerId'),
                'style':entity.get('style') or {'color':{'mode':'by-layer'},'plot':True}, 'ancestors':[]})
        if parts:
            region_items[key] = {'status':'ready', 'sourceKind':'REGION',
                'sourceRefs':entity.get('sourceRefs') or [], 'mode':'geometry', 'parts':parts}
            region_handles.add(str(meta.get('handle')))
    if region_handles or mesh_items:
        buffer_path.write_bytes(buffer_bytes)
    # Freeze once; validation and publication share the exact same immutable bytes.
    buffer_bytes = bytes(buffer_bytes)
    sha = hashlib.sha256(buffer_bytes).hexdigest()
    doc['buffers'][bid] = {'id':bid, 'sha256':sha, 'byteLength':len(buffer_bytes),
        'endianness':'little', 'alignment':8, 'storage':{'kind':'resource','resourceId':bid}}
    inheritance = {key:True for key,row in drawing['layers'].items() if row['name']=='0'}
    for state in extras.get('entityState',{}).values():
        if 'visible' in state:state['invisible']=not state.pop('visible')
    # LWDEFAULT belongs to the author's application registry, not the DWG.
    default_weight = {'value':0.25, 'knowledge':'engineering-defined',
        'validation':'experimental', 'evidenceIds':['dwg-lineweight-policy']}
    doc['evidence'].append({'id':'dwg-lineweight-policy', 'kind':'engineering-contract',
        'reference':'dwg-viewer-default-lineweight/1',
        'scope':'0.25 mm viewer substitute; original author LWDEFAULT is not stored in DWG.'})
    for key, state in extras.get('nativeLayerLineWeights',{}).items():
        if state['value'] == -3:
            drawing['layers'][key]['defaultStyle']['lineWeight'] = dict(default_weight)
    modes = {}
    for table in ('entities','blockInstances','annotations'):
        for key,row in drawing[table].items():
            style = (extras.get('annotationStyles',{}).get(key,{})
                     if table == 'annotations' else row['style'])
            weight = extras.get('entityState',{}).get(key,{}).get('nativeLineWeight')
            if weight in (-1, -2):
                modes.setdefault(key,{})['lineWeight'] = 'by-layer' if weight == -1 else 'by-block'
            if weight == -3:
                modes.setdefault(key,{})['lineWeight'] = 'default'
                style['lineWeight'] = dict(default_weight)
            lt = drawing['lineTypes'].get(style.get('lineTypeId'),{}).get('name','').upper()
            if lt in ('BYLAYER','BYBLOCK'):
                modes.setdefault(key,{})['lineType'] = 'by-layer' if lt=='BYLAYER' else 'by-block'
                del style['lineTypeId']
    for entry in mesh_items.values():
        for part in entry['parts']:
            modes[part['id']] = {'lineType':'by-block', 'lineWeight':'by-block'}
            extras.setdefault('entityState', {})[part['id']] = {'opacityMode':'by-block'}
    doc['extensions']['org.cad-preview.style-inheritance/1'] = {
        'layerInheritance':inheritance, 'modes':modes, 'blockClips':block_clips,
        'defaultLineWeight':default_weight,
        'drawOrder':{key:state['drawOrder'] for key,state in extras.get('entityState',{}).items() if 'drawOrder' in state},
        'entityState':extras.get('entityState',{}), 'annotationStyles':extras.get('annotationStyles',{})}
    infinite_items = infinite_presentation_items(extras.get('infiniteLines',{}),drawing['entities'])
    presentation_items = {**infinite_items, **region_items, **mesh_items}
    if presentation_items:
        doc['extensions']['org.cad-preview.annotation-presentation/1'] = {
            'schemaVersion':'1.3.0','items':presentation_items}
    doc['extensions']['org.cad-preview.fill/1'] = {'fills':extras.get('fills',{})}
    raw_losses = [json.loads(line) for line in (folder/'losses.jsonl').open()] + clip_losses
    if region_handles or acis_handles:
        raw_losses = [row for row in raw_losses
            if not (row.get('code')=='unsupported-native-presentation'
                    and str(row.get('handle')) in (region_handles|acis_handles))]
    by_loss = Counter(row['code'] for row in raw_losses)
    for code,count in by_loss.items():
        refs = [{'sourceId':sid,'objectKey':row['handle']} for row in raw_losses if row['code']==code and row['handle']]
        message = (f'{count} 个 HATCH 空输出待核实；尚不能按已读取源定义证明为空，'
                   '也不能据此认定读取或转换损失。请核对保留的图案定义、边界及判定原因。'
                   if code == 'empty-native-hatch-pattern' else
                   f'{count} native object/field losses; see retained per-handle loss ledger.')
        doc['diagnostics'].append({'code':code, 'severity':'warning', 'stage':'mapping',
            'message':message, 'sourceRefs':refs})
    hatch_outcomes = extras.get('hatchPatternOutcomes', {})
    proven_empty = [row for row in hatch_outcomes.values() if row['status'] == 'empty-by-read-definition']
    if proven_empty:
        doc['diagnostics'].append({'code':'hatch-empty-by-read-definition', 'severity':'info', 'stage':'mapping',
            'message':f'{len(proven_empty)} 个 HATCH 按已读取源定义为空；不代表读取完整或整图无损。',
            'sourceRefs':[ref for row in proven_empty for ref in row['sourceRefs']]})
    notifications = [json.loads(line) for line in (folder/'notifications.jsonl').open()]
    for index,row in enumerate(notifications):
        if row['type'] in ('Warning','Error','NotSupported','NotImplemented'):
            doc['diagnostics'].append({'code':'acadsharp-'+row['type'].lower(), 'severity':'warning', 'stage':'parse',
                'message':row['Message'], 'sourceRefs':[]})
    if font_files:
        doc['extensions']['org.libiaolink.dwg-text/1'] = {'items':text_layouts,
            'policy':'Original companion advances and glyphs share MTEXT layout; unresolved objects retain explicit substituted text.'}
        for key, row in text_layouts.items():
            if row['status'] != 'ready':
                doc['diagnostics'].append({'code':'source-text-layout-unavailable','severity':'warning','stage':'presentation',
                    'message':row['reason'],'sourceRefs':drawing['annotations'][key]['sourceRefs']})
            elif row.get('layoutStatus') == 'approximate':
                doc['diagnostics'].append({'code':'source-text-layout-approximate','severity':'warning','stage':'presentation',
                    'message':row['layoutReason'],'sourceRefs':drawing['annotations'][key]['sourceRefs']})
    if not font_files: doc['diagnostics'].append({'code':'source-fonts-not-provided','severity':'warning','stage':'presentation',
        'message':'Original font companions were not supplied. Native Unicode and font requests are retained; browser text is explicitly substituted, with no original glyph/layout fidelity claim.', 'sourceRefs':[]})
    for entity,error in region_errors:
        doc['diagnostics'].append({'code':'region-acis-boundary-unavailable','severity':'warning','stage':'mapping',
            'message':error, 'sourceRefs':entity.get('sourceRefs') or []})
    ledger = folder/'source-handles.tsv'
    doc['extensions']['org.libiaolink.dwg/1'] = {
        'header':summary['header'], 'nativeGeometry':extras.get('nativeGeometry',{}),
        'lineWeightSettings':{**extras.get('nativeLineWeightSettings',{}).get(did,{}),
            'authorDefaultStatus':'not-stored-in-dwg', 'viewerDefault':default_weight},
        'pointDisplaySettings':extras.get('nativePointDisplaySettings',{}).get(did,{}),
        'layerLineWeights':extras.get('nativeLayerLineWeights',{}),
        'nativeReaderSha256':summary['readerSha256'],'readMemory':summary.get('readMemory'),
        'dimensionSemantics':extras.get('dimensionSemantics',{}), 'multiLeaderSemantics':extras.get('multiLeaderSemantics',{}),
        'hatchSemantics':extras.get('hatchSemantics',{}), 'hatchPatternOutcomes':hatch_outcomes, 'meshPresentations':extras.get('meshPresentations',{}),
        'fonts':extras.get('nativeFonts',{}), 'textAppearance':extras.get('textAppearance',{}),
        'opaque':extras.get('opaque',{}), 'proxyGraphics':extras.get('proxyGraphics',{}),
        'blockClips':extras.get('nativeBlockClips',{}), 'externalReferences':extras.get('nativeExternalReferences',{}),
        'sourceLedger':{'artifact':'native/source-handles.tsv', 'sha256':hashlib.file_digest(ledger.open('rb'),'sha256').hexdigest(),
            'byteLength':ledger.stat().st_size,'sourceHandles':summary['sourceHandles'], 'missingHandles':summary['missingHandles'],
            'offsetSpace':'decompressed AcDbObjects, not original file byte offsets'},
        'lossCounts':dict(by_loss), 'lossLedger':'native/losses.jsonl', 'readSeconds':summary['readSeconds'],
        'scope':'All native source handles audited; model and layout reachable definitions mapped; unreferenced definitions remain in original source/ledger.',
        'curveDisplay':{'library':'ACadSharp','circleVertices':80,'ellipseVertices':64,'splineVertices':48,
            'policy':'Sampled display is a derivative, not an engineering tolerance guarantee.'}}
    doc["extensions"]["org.cad-preview.drawing-coverage/1"] = {
        "sourceRead":{"status":"partial" if summary["missingHandles"] else "read-with-warnings","sourceRecords":summary.get("sourceEntityRecords",summary["sourceHandles"])},
        "displayGeometry":source_display_coverage(drawing, displays, presentation_items, summary,
            extras.get("nativeFonts",{}), extras.get("fills",{}), text_layouts, extras.get("dimensionSemantics",{})),
        "engineeringAttributes":{"status":"partial","sourceRecords":summary.get("mappedSourceObjects",summary["mappedObjects"])},
        "losses":raw_losses}
    doc['revision'] = digest({k:v for k,v in doc.items() if k!='revision'})
    phase('document sealed')
    snapshot = {'schemaVersion':'2.0.0','id':'pending','documentRevision':doc['revision'],
        'selection':{'viewContextId':'native-dwg'},'sceneRoots':[],'occurrenceOverrides':{},'draws':{},
        'completeness':'partial','diagnostics':doc['diagnostics'][:]}
    snapshot['id'] = 'snapshot-'+digest({k:v for k,v in snapshot.items() if k!='id'})
    presentation = {'name':identity['name'],'view':None,'unit':'mm' if summary['header']['insUnits']=='Millimeters' else 'unknown',
        'sourceSHA256':identity['sha256'],'candidate':True,
        'quality':'partial','note':'Native DWG → UCD; source handles preserved. See explicit decoder/mapping/font losses.',
        'stats':{'sourceHandles':summary['sourceHandles'],'mappedSourceObjects':summary.get('mappedSourceObjects',summary['mappedObjects']),'displayGeometry':len(displays)+len(infinite_items)+len(region_items)}}
    validate_binary_envelope(doc,snapshot,presentation,lambda key:buffer_bytes)
    phase('contract and binary validated')
    if packed:
        doc = pack_document(doc)
        phase('document packed')
    envelope = {'transportProfile':'ucd-worker-binary/1','document':doc,'snapshot':snapshot,
        'bufferPayloads':{bid:'native/positions.bin'},'presentation':presentation}
    if platform:
        # The platform worker consumes bufferResources directly. Writing them here
        # avoids parsing and re-serialising the full manifest in the worker wrapper.
        sink = FileSink(binary_dir or (output/'buffers'))
        for buffer_id, relative in envelope.pop('bufferPayloads').items():
            sink.put(buffer_id, buffer_bytes if buffer_id == bid else (output/relative).read_bytes())
        sink.attach(envelope)
        sink.finish(envelope)
    output.mkdir(parents=True,exist_ok=True)
    artifact = output/'manifest.json'
    pending=output/'manifest.json.tmp'
    with pending.open('wb') as stream:write_canonical(envelope,stream)
    if pending.stat().st_size>256*1024*1024:
        raise ValueError('dwg-manifest-budget-exceeded: '+str(pending.stat().st_size)+' bytes; retained temporary output is not a successful artifact')
    pending.replace(artifact)
    phase('artifact written')
    (output/'assembly-summary.json').write_text(json.dumps({'validated':True,'manifestBytes':artifact.stat().st_size,
        'bufferBytes':buffer_path.stat().st_size,'source':identity,'tables':{k:len(v) for k,v in drawing.items()},
        'lossCounts':dict(by_loss),'completeness':'partial'},ensure_ascii=False,indent=2))
    return artifact
