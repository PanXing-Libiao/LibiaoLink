"""Focused regressions for lost polyline edges, numeric linetypes and XREF flags.

Real-file browser acceptance is kept separately in docs/dxf-holdout-2d/after.
Temporary control drawings below are never counted as new real-file successes.
"""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import base64
import json
import math
from pathlib import Path
import struct
import subprocess
import sys
import tempfile

import ezdxf

APP = Path(__file__).resolve().parents[1]
ROOT = DATA
sys.path.insert(0, str(APP))
from unified.dxf_adapter import read_dxf, project_block


def parse(doc, directory):
    path = Path(directory) / 'control.dxf'
    doc.saveas(path)
    original = path.read_bytes()
    envelope = read_dxf(path, original)
    assert path.read_bytes() == original
    return envelope


def display(envelope, handle):
    document = envelope['document']
    entity = next(row for row in document['drawing']['entities'].values()
                  if row['sourceRefs'][0]['objectKey'] == handle)
    rep = next(row for row in document['representations'].values()
               if row['sourceRefs'][0]['objectKey'] == handle)
    geometry = document['geometries'][rep['bindings'][0]['geometryId']]

    def decode(key):
        accessor = document['accessors'][key]
        data = base64.b64decode(envelope['bufferPayloads'][accessor['bufferId']])
        fmt = {'f64': 'd', 'u32': 'I'}[accessor['component']]
        start = accessor['byteOffset']
        return struct.unpack('<' + fmt * accessor['count'] * accessor['components'],
                             data[start:start + accessor['byteLength']])

    positions = decode(geometry['attributes']['POSITION'])
    indices = decode(geometry['primitives'][0]['indices'])
    points = [positions[i:i + 3] for i in range(0, len(positions), 3)]
    return entity, points, [(indices[i], indices[i + 1]) for i in range(0, len(indices), 2)]


def polyline_controls():
    with tempfile.TemporaryDirectory(prefix='dxf-display-repairs-') as directory:
        for kind in ('LWPOLYLINE', 'POLYLINE'):
            doc = ezdxf.new('R2013')
            vertices = [(0, 0), (10, 0), (10, 8), (0, 8)]
            if kind == 'LWPOLYLINE':
                source = doc.modelspace().add_lwpolyline(vertices, close=True)
                source.dxf.elevation = 3
            else:
                source = doc.modelspace().add_polyline2d(vertices, close=True)
                source.dxf.elevation = (0, 0, 3)
            source.dxf.extrusion = (0, 1, 0)
            envelope = parse(doc, directory)
            entity, points, edges = display(envelope, source.dxf.handle)
            assert len(edges) == 4 and len(points) == 5
            assert math.isclose(sum(math.dist(points[a], points[b]) for a, b in edges), 36)
            assert all(math.isclose(point[2], 3) for point in points)
            assert entity['localFromOwner'][10] == 0  # OCS retained, not applied twice.
            assert entity['geometry']['closed'] and len(entity['geometry']['points']) == 4
            assert points[0] == points[-1]

        # Clockwise bulge followed by straight segments: all source endpoints
        # remain connected; source analytic vertices are not replaced by leaves.
        doc = ezdxf.new('R2013')
        source = doc.modelspace().add_lwpolyline([(0, 0, -.5), (10, 0, 0), (10, 8, 0)], format='xyb')
        entity, points, edges = display(parse(doc, directory), source.dxf.handle)
        assert math.dist(points[0], (0, 0, 0)) < 1e-9
        assert math.dist(points[-1], (10, 8, 0)) < 1e-9
        assert any(math.dist(point, (10, 0, 0)) < 1e-9 for point in points)
        assert len(edges) == len(points) - 1
        assert all(b == c for (_, b), (c, _) in zip(edges, edges[1:]))
        assert entity['geometry']['bulges'] == [-.5, 0]

    path = ROOT / '.phase-work/dxf-holdout/samples/H04_nest.dxf'
    envelope = read_dxf(path, path.read_bytes())
    _, points, edges = display(envelope, '39')
    long_edges = sorted(math.dist(points[a], points[b]) for a, b in edges if math.dist(points[a], points[b]) > 1)
    assert len(long_edges) == 4
    assert all(math.isclose(a, b) for a, b in zip(long_edges, [99.8, 99.8, 139.8, 139.8]))
    print('Polyline closure, legacy elevation, tilted OCS, clockwise bulge and real sheet edges passed')


def reference_controls():
    with tempfile.TemporaryDirectory(prefix='dxf-xref-repairs-') as directory:
        doc = ezdxf.new('R2013')
        block = doc.blocks.new('Embedded', dxfattribs={'xref_path': 'former-source.dwg'})
        block.add_line((0, 0), (10, 0))
        doc.modelspace().add_blockref('Embedded', (0, 0))
        envelope = parse(doc, directory)
        assert not envelope['document']['externalReferences']
        assert envelope['snapshot']['completeness'] == 'complete'
        for name, flags in [('External', 4), ('Overlay', 8)]:
            doc.blocks.new(name, dxfattribs={'flags': flags, 'xref_path': 'same-missing.dwg'})
            doc.modelspace().add_blockref(name, (20, 0))
        envelope = parse(doc, directory)
        refs = envelope['document']['externalReferences']
        assert len(refs) == 2 and len({row['id'] for row in refs}) == 2
        assert all(row['status'] == 'missing' and row['required'] and row['requestedPath'] == 'same-missing.dwg' for row in refs)
        assert envelope['snapshot']['completeness'] == 'partial'
        coverage = envelope['document']['extensions']['org.cad-preview.drawing-coverage/1']
        assert coverage['displayGeometry']['byReason']['externalReferenceUnresolved'] == 2
    path = ROOT / '.phase-work/dxf-holdout/samples/H01_floorplan.dxf'
    envelope = read_dxf(path, path.read_bytes())
    assert not envelope['document']['extensions']['org.cad-preview.dxf-xref/1']['references']
    assert envelope['document']['extensions']['org.cad-preview.drawing-coverage/1']['displayGeometry']['status'] == 'complete'
    print('Embedded-path vs XREF/overlay flags, unique dependency IDs and real floorplan passed')


def line_controls():
    with tempfile.TemporaryDirectory(prefix='dxf-linetype-repairs-') as directory:
        doc = ezdxf.new('R2013')
        doc.header['$LTSCALE'] = 2
        lt = doc.linetypes.add('Numeric', pattern=[12, 3, -3, 0, -6])
        line = doc.modelspace().add_line((0, 0), (60, 0), dxfattribs={'linetype': 'Numeric', 'ltscale': 3})
        envelope = parse(doc, directory)
        drawing = envelope['document']['drawing']
        ext = envelope['document']['extensions']['org.cad-preview.style-inheritance/1']
        ltid = next(key for key, value in drawing['lineTypes'].items() if value['name'] == 'Numeric')
        compiled = ext['lineTypePatterns'][ltid]
        assert compiled == [value * 2 for value in lt.simplified_line_pattern()] == [6, 6, 0, 12]
        entity = next(value for value in drawing['entities'].values() if value['sourceRefs'][0]['objectKey'] == line.dxf.handle)
        assert ext['entityState'][entity['id']]['lineTypeScale'] == 3
    module = 'data:text/javascript;base64,' + base64.b64encode((BROWSER / 'drawing-2d.js').read_bytes()).decode()
    script = """import assert from 'node:assert/strict';
import {lineDashPattern,traceStrokeSegments} from 'MODULE';
assert.deepEqual(lineDashPattern(null,[6,6,0,12],3),[18,18,0,36]);
assert.deepEqual(lineDashPattern({segments:[{kind:'dash',length:12},{kind:'gap',length:6}]}),[12,6]);
assert.deepEqual(lineDashPattern(null,[]),[]);
assert.deepEqual(lineDashPattern(null,[0,0]),[]);
const commands=[],path={moveTo:(x,y)=>commands.push(['M',x,y]),lineTo:(x,y)=>commands.push(['L',x,y])};
traceStrokeSegments(path,[0,0,1,0,1,0,1,1,1,1,0,1,0,1,0,0,5,0,6,0]);
assert.deepEqual(commands,[['M',0,0],['L',1,0],['L',1,1],['L',0,1],['L',0,0],['M',5,0],['L',6,0]]);
console.log('Compiled numeric dash/dot scale and continuous Canvas stroke passed');
""".replace('MODULE', module)
    subprocess.run(['node', '--input-type=module', '-e', script], check=True)


def recovery_controls():
    def strip_sections(raw, names):
        lines = raw.splitlines(keepends=True)
        pairs = list(zip(lines[::2], lines[1::2]))
        out, skipping = [], False
        for i, (code, value) in enumerate(pairs):
            if code.strip() == b'0' and value.strip() == b'SECTION':
                skipping = i + 1 < len(pairs) and pairs[i + 1][1].strip() in names
            if not skipping:
                out.extend((code, value))
            if code.strip() == b'0' and value.strip() == b'ENDSEC':
                skipping = False
        return b''.join(out)

    with tempfile.TemporaryDirectory(prefix='dxf-recovery-') as directory:
        for version in ('R12', 'R2013'):
            doc = ezdxf.new(version)
            doc.modelspace().add_line((0, 0), (10, 0))
            if version != 'R12':
                doc.layers.new('SourceLayer', dxfattribs={'color': 2})
                block = doc.blocks.new('SourceBlock')
                block.add_lwpolyline([(0, 0), (8, 0), (8, 5), (0, 5)], close=True,
                                     dxfattribs={'layer': 'SourceLayer'})
                doc.modelspace().add_blockref('SourceBlock', (20, 30))
                paper_circle = doc.layouts.new('SourceSheet').add_circle((5, 6), 3)
            path = Path(directory) / 'original.dxf'
            doc.saveas(path)
            raw = strip_sections(path.read_bytes(), {b'HEADER', b'OBJECTS'})
            path.write_bytes(raw)
            envelope = read_dxf(path, raw)
            mapped = envelope['document']
            record = mapped['extensions']['org.cad-preview.dxf/1']['recovery']
            assert path.read_bytes() == raw and record['sourceVersion'] is None
            assert 'detectedVersion' not in mapped['sources'][0]
            assert mapped['coordinates']['lengthUnit']['knowledge'] == 'unknown'
            assert envelope['snapshot']['completeness'] == 'partial'
            assert not record['removedSourceRecords']
            if version != 'R12':
                assert record['mode'] == 'headerless-modern-fragment'
                assert record['preservedOrphanBlocks']
                assert any(row['sourceRefs'][0]['objectKey'] == paper_circle.dxf.handle
                           for row in mapped['drawing']['entities'].values())
                layer = next(row for row in mapped['drawing']['layers'].values() if row['name'] == 'SourceLayer')
                assert layer['defaultStyle']['color']['rgba'][:3] == [1, 1, 0]
        bad = Path(directory) / 'invalid.dxf'
        bad.write_bytes(b'0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC9999\n0\nENDSEC\n0\nEOF\n')
        try:
            read_dxf(bad, bad.read_bytes())
        except (ValueError, ezdxf.DXFError):
            pass
        else:
            raise AssertionError('A declared unsupported version must not enter headerless recovery')

    path = ROOT / '.phase-work/dxf-holdout/samples/H09_blocks.dxf'
    original = path.read_bytes()
    envelope = read_dxf(path, original)
    document = envelope['document']
    before = json.dumps(document, sort_keys=True)
    recovery = document['extensions']['org.cad-preview.dxf/1']['recovery']
    assert recovery['mode'] == 'headerless-modern-fragment'
    assert recovery['sourceSections'] == ['BLOCKS'] and len(recovery['blockPreviews']) == 322
    assert len(recovery['fixes']) == 201 and not recovery['removedSourceRecords']
    assert len(recovery['preservedOrphanBlocks']) == 3
    assert len(recovery['displayDefaultLayers']) == 14 and not recovery['errors']
    coverage = document['extensions']['org.cad-preview.drawing-coverage/1']['displayGeometry']
    assert coverage['sourceRecords'] == 3155 and coverage['withDisplayGeometry'] == 3142
    assert coverage['byReason']['unsupported'] == {'MULTILEADER': 4, 'VIEWPORT': 9}
    assert document['extensions']['org.cad-preview.drawing-coverage/1']['sourceRead']['status'] == 'partial'
    assert envelope['snapshot']['completeness'] == 'partial'
    assert path.read_bytes() == original
    previews = recovery['blockPreviews'][:2] + [next(row for row in recovery['blockPreviews'] if row['name'] == '*D138')]
    expected = [project_block(document, row['blockId']) for row in previews]
    assert all(row['draws'] for row in expected)
    assert json.dumps(document, sort_keys=True) == before  # View roots never edit source placement.
    module = 'data:text/javascript;base64,' + base64.b64encode((BROWSER / 'drawing-projection.js').read_bytes()).decode()
    script = "import {projectBlock} from 'MODULE';let s='';for await(const c of process.stdin)s+=c;const x=JSON.parse(s);console.log(JSON.stringify(x.blocks.map(b=>projectBlock(x.document,b))));".replace('MODULE', module)
    result = subprocess.run(['node', '--input-type=module', '-e', script],
                            input=json.dumps({'document': document, 'blocks': [row['blockId'] for row in previews]}),
                            text=True, capture_output=True, check=True)
    assert json.loads(result.stdout) == expected
    print('Headerless R12/modern recovery, unknown metadata, strict version refusal and original H09 block-preview parity passed')


if __name__ == '__main__':
    polyline_controls()
    reference_controls()
    line_controls()
    recovery_controls()
