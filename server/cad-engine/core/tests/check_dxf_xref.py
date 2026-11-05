"""Targeted XREF upload, copying and source-identity acceptance; no full build."""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import hashlib
import base64
import json
from pathlib import Path
import struct
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

APP = Path(__file__).resolve().parents[1]
ROOT = DATA
sys.path.insert(0, str(APP))
from unified.dxf_runtime import require_engine
from unified.dxf_adapter import read_dxf
from unified.dxf_resources import MAGIC, decode_package, fingerprint

ezdxf = require_engine()
from ezdxf import xref
from ezdxf.xclip import XClip

OUT = ROOT / 'docs/dxf-xref'
FIXTURES = ROOT / '.phase-work/dxf-xref-controls'
ORIGINALS = OUT / 'originals'


def package(main, files):
    header = json.dumps({'version': 'dxf-resources/1', 'main': main,
        'files': [{'path': name, 'byteLength': len(raw)} for name, raw in files.items()]}).encode()
    return MAGIC + struct.pack('<I', len(header)) + header + b''.join(files.values())


def fixture_files():
    FIXTURES.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as folder:
        folder = Path(folder)
        def save(name, doc):
            path = folder / name; doc.saveas(path); return path.read_bytes()
        leaf = ezdxf.new('R2013'); leaf.layers.new('Referenced', dxfattribs={'color': 1})
        line = leaf.modelspace().add_line((2, 1), (12, 1), dxfattribs={'layer': 'Referenced'})
        leaf.header['$INSBASE'] = (2, 1, 0)
        leaf_raw = save('part.dxf', leaf)
        host = ezdxf.new('R2013'); host.layers.new('Host', dxfattribs={'color': 3})
        anchor = host.modelspace().add_line((0, 0), (10, 10), dxfattribs={'layer': 'Host'})
        insert = xref.attach(host, block_name='Structure', filename='refs/part.dxf', insert=(20, 0))
        host.modelspace().add_blockref('Structure', (40, 0))
        raw = save('host.dxf', host)
        (FIXTURES / 'host.dxf').write_bytes(raw)
        (FIXTURES / 'refs').mkdir(exist_ok=True)
        (FIXTURES / 'refs/part.dxf').write_bytes(leaf_raw)
        files = {'host.dxf': raw, 'refs/part.dxf': leaf_raw}
        def parse(values, data=raw):
            # Production writes precisely these bytes before calling read_dxf.
            path = folder / 'host.dxf'
            path.write_bytes(data)
            return read_dxf(path, data, resources=values)
        missing, loaded = parse(None), parse(files)
        assert missing['snapshot']['completeness'] == 'partial'
        assert loaded['snapshot']['completeness'] == 'complete'
        root_id = 'source-' + hashlib.sha256(raw).hexdigest()
        child_id = 'source-' + hashlib.sha256(leaf_raw).hexdigest()
        child_entities = [e for e in loaded['document']['drawing']['entities'].values()
                          if e['sourceRefs'][0]['sourceId'] == child_id]
        assert len(child_entities) == 1 and child_entities[0]['sourceRefs'][0]['objectKey'] == line.dxf.handle
        root_before = {e['id'] for e in missing['document']['drawing']['entities'].values()}
        root_after = {e['id'] for e in loaded['document']['drawing']['entities'].values() if e['sourceRefs'][0]['sourceId'] == root_id}
        assert root_before == root_after
        assert len(loaded['snapshot']['drawingProjection']['draws']) == 3
        # Source INSERT transforms reuse one definition at distinct positions.
        positions = sorted(round(draw['localToSpace'][12], 6) for draw in loaded['snapshot']['drawingProjection']['draws'].values() if draw['itemId'] == child_entities[0]['id'])
        assert positions == [18.0, 38.0], positions
        duplicate = parse({'a/part.dxf': leaf_raw, 'b/part.dxf': leaf_raw})
        assert duplicate['document']['externalReferences'][0]['status'] == 'ambiguous'
        assert parse({'other/part.dxf': leaf_raw})['document']['extensions']['org.cad-preview.dxf-xref/1']['references'][0]['match'] == 'unique-basename'
        encoded = package('host.dxf', files)
        assert decode_package(encoded)['files'] == files
        changed = dict(files); changed['refs/part.dxf'] = leaf_raw + b'\n'
        assert fingerprint({'main': 'host.dxf', 'files': files}) != fingerprint({'main': 'host.dxf', 'files': changed})
        try: decode_package(package('../host.dxf', {'../host.dxf': raw}))
        except ValueError: pass
        else: raise AssertionError('path traversal accepted')
        try: decode_package(encoded + b'ignored')
        except ValueError: pass
        else: raise AssertionError('trailing package bytes accepted')
        XClip(insert).set_block_clipping_path([(0, 0), (5, 5)])
        clipped = parse(files, save('clipped.dxf', host))
        assert clipped['document']['externalReferences'][0]['status'] == 'resolved'
        assert any(d.get('clipRegions') for d in clipped['snapshot']['drawingProjection']['draws'].values())
        host.blocks['Structure'].add_line((0, 0), (999, 999))
        cached_raw = save('cached-clipped.dxf', host)
        for available in [None, files]:
            cached = parse(available, cached_raw)
            assert any(d.get('clipRegions') for d in cached['snapshot']['drawingProjection']['draws'].values())
            assert cached['document']['externalReferences'][0]['status'] == ('resolved' if available else 'missing')
            if available:
                assert cached['document']['extensions']['org.cad-preview.dxf-xref/1']['references'][0]['replacedCachedRecords'] == 1
        other = ezdxf.new('R2013'); other.modelspace().add_circle((0, 0), 1)
        other_raw = save('overlay.dxf', other)
        child = ezdxf.new('R2013'); child.modelspace().add_line((0, 0), (1, 1))
        xref.attach(child, block_name='Overlay', filename='overlay.dxf', overlay=True)
        nested = parse({'refs/part.dxf': save('nested.dxf', child), 'overlay.dxf': other_raw})
        refs = nested['document']['externalReferences']
        assert len(refs) == 2 and sum(not r['required'] for r in refs) == 1
        assert nested['snapshot']['completeness'] == 'complete'
        a = ezdxf.new('R2013'); a.modelspace().add_line((0, 0), (1, 1)); xref.attach(a, block_name='B', filename='b.dxf')
        b = ezdxf.new('R2013'); b.modelspace().add_line((0, 0), (1, 1)); xref.attach(b, block_name='A', filename='host.dxf')
        a_raw, b_raw = save('a.dxf', a), save('b.dxf', b)
        cycle = parse({'host.dxf': a_raw, 'b.dxf': b_raw}, a_raw)
        assert any(r['reason'].startswith('xref-cycle') for r in cycle['document']['externalReferences'])
        dwg = ezdxf.new('R2013'); xref.attach(dwg, block_name='DWG', filename='part.dwg')
        refused = parse({'part.dwg': leaf_raw, 'part.dxf': leaf_raw}, save('dwg.dxf', dwg))
        assert refused['document']['externalReferences'][0]['status'] == 'blocked'
        # A dangling source name must not pick up an unrelated host definition.
        conflict = ezdxf.new('R2013')
        conflict.blocks.new('GHOST').add_line((0, 0), (999, 999))
        xref.attach(conflict, block_name='Source', filename='resolved_xref.dxf')
        isolated = parse({p.name: p.read_bytes() for p in ORIGINALS.glob('*.dxf')}, save('conflict.dxf', conflict))
        ghosts = [e for e in isolated['document']['drawing']['entities'].values()
                  if e['sourceRefs'][0]['objectKey'] == '203' and e['geometry']['type'] == 'unsupported']
        assert len(ghosts) == 1 and 'GHOST' in ghosts[0]['geometry']['reason']
        # Upstream Loader cannot copy this real original ACAD_TABLE. Count the
        # omitted object with its source identity, rather than claiming success.
        table = ROOT / '.phase-work/dxf-holdout/samples/H11_acad_table_with_blk_ref.dxf'
        limited = ezdxf.new('R2018'); xref.attach(limited, block_name='Table', filename=table.name)
        limited_result = parse({table.name: table.read_bytes()}, save('limited.dxf', limited))
        failures = limited_result['document']['extensions']['org.cad-preview.dxf-xref/1']['copyFailures']
        assert len(failures) == 1 and failures[0]['sourceKind'] == 'ACAD_TABLE'
        assert failures[0]['sourceRefs'][0]['objectKey'] == 'CF'
        assert limited_result['snapshot']['completeness'] == 'partial'
        (OUT / 'copy-limit.json').write_text(json.dumps({'classification': 'generated host with unchanged original H11 companion',
            'display': limited_result['document']['extensions']['org.cad-preview.drawing-coverage/1']['displayGeometry'],
            'copyFailures': failures}, ensure_ascii=False, indent=2) + '\n')
    return {'identityAndInstances': True, 'missingAndAmbiguous': True, 'relativeAndBasenameMatching': True,
            'packageBoundariesAndCacheIdentity': True, 'clippingApplied': True, 'nestedOverlayExcluded': True,
            'cycleRefused': True, 'dwgNotReplacedByDxf': True, 'clippedCachedBlockReloaded': True, 'danglingNameCannotBindHost': True,
            'uncopyableOriginalObjectCounted': True}


def original_cases():
    for row in json.loads((OUT / 'manifest.json').read_text())['files']:
        assert hashlib.sha256((ORIGINALS / row['file']).read_bytes()).hexdigest() == row['sha256']
    files = {p.name: p.read_bytes() for p in ORIGINALS.glob('*xref*.dxf')}
    results = []
    for name in ['xref_host.dxf', 'resolved_xref.dxf', 'xref_attrib_host.dxf']:
        raw = files[name]
        states = []
        for state, resources in [('main-only', None), ('companions-provided', files), ('main-only-again', None)]:
            envelope = read_dxf(ORIGINALS / name, raw, resources=resources)
            document = envelope['document']
            states.append({'state': state, 'display': document['extensions']['org.cad-preview.drawing-coverage/1']['displayGeometry'],
                'sources': document['sources'], 'externalReferences': document['externalReferences'],
                'draws': len(envelope['snapshot']['drawingProjection']['draws']),
                'missingRecords': [{'itemId': e['id'], 'sourceRefs': e['sourceRefs'], 'geometry': e['geometry']}
                    for e in document['drawing']['entities'].values() if e['geometry']['type'] == 'unsupported'],
                'annotations': [{'text': a['text'], 'sourceRefs': a['sourceRefs']} for a in document['drawing']['annotations'].values()],
                'inputBytes': len(raw), 'packageInputBytes': sum(map(len, files.values())) if resources else len(raw),
                'artifactBytes': len(json.dumps(envelope, ensure_ascii=False, separators=(',', ':')).encode())})
        assert states[0]['externalReferences'] == states[2]['externalReferences']
        assert states[0]['draws'] == states[2]['draws']
        if name == 'xref_attrib_host.dxf':
            assert states[1]['display']['status'] == 'complete'
            annotations = {a['text']: a['sourceRefs'][0] for a in states[1]['annotations']}
            sid = 'source-' + hashlib.sha256(files['xref_attrib_sub.dxf']).hexdigest()
            assert annotations['TOP-LEVEL-PART-42']['sourceId'] == sid and annotations['TOP-LEVEL-PART-42']['objectKey'] == '201'
            assert annotations['NESTED-PART-99']['sourceId'] == sid and annotations['NESTED-PART-99']['objectKey'] == '222'
        if name == 'xref_host.dxf':
            assert states[1]['display']['status'] == 'partial'
            assert sum(r['status'] == 'missing' for r in states[1]['externalReferences']) == 1
            assert states[1]['missingRecords'][0]['sourceRefs'][0]['objectKey'] == '203'
        results.append({'file': name, 'sha256': hashlib.sha256(raw).hexdigest(), 'states': states})
    return results


def http_cases(base):
    requests = []
    files = {'host.dxf': (FIXTURES / 'host.dxf').read_bytes(),
             'refs/part.dxf': (FIXTURES / 'refs/part.dxf').read_bytes()}
    def post(data, endpoint='/api/parse-dxf-bundle', **params):
        query = {'name': 'host.dxf', 'model': 'ucd', 'metadata': 'full', 'compression': 'identity', **params}
        request = urllib.request.Request(base + endpoint + '?' + urllib.parse.urlencode(query), data=data, method='POST')
        try:
            response = urllib.request.urlopen(request, timeout=70)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read(); payload = json.loads(body)
            record = {'status': response.code, 'cache': response.headers.get('X-Cache'),
                      'inputBytes': len(data), 'responseBytes': len(body), 'code': payload.get('code')}
        requests.append(record)
        return record, payload, body
    wire = package('host.dxf', files)
    first, before, body = post(wire)
    assert first['status'] == 200 and before['snapshot']['completeness'] == 'complete'
    again, _, same = post(wire)
    assert again['cache'] == 'hit' and body == same
    missing, missing_payload, _ = post(files['host.dxf'], endpoint='/api/parse')
    assert missing['status'] == 200 and missing_payload['snapshot']['completeness'] == 'partial'
    changed = dict(files); changed['refs/part.dxf'] += b'\n'
    fresh, after, _ = post(package('host.dxf', changed))
    assert fresh['status'] == 200 and fresh['cache'] != 'hit'
    assert before['document']['sources'][1]['sha256'] != after['document']['sources'][1]['sha256']
    returned, _, restored = post(wire)
    assert returned['cache'] == 'hit' and restored == body
    binary, manifest, _ = post(wire, transport='binary')
    assert binary['status'] == 200 and manifest['transportProfile'] == 'ucd-binary-manifest/1'
    assert manifest['document'] == before['document'] and manifest['snapshot'] == before['snapshot']
    for bid, resource in manifest['bufferResources'].items():
        raw = urllib.request.urlopen(base + resource['url'], timeout=15).read()
        assert raw == base64.b64decode(before['bufferPayloads'][bid])
    for invalid in [wire + b'ignored', package('../host.dxf', {'../host.dxf': files['host.dxf']})]:
        rejected, _, _ = post(invalid)
        assert rejected['status'] == 400 and rejected['code'] == 'invalid-dxf-package'
    result = {'base': base, 'checks': {'bundleRoundTrip': True, 'byteIdenticalCacheRepeat': True,
        'mainOnlyCacheIsolated': True, 'companionBytesInvalidateCache': True, 'originalPackageRestoresCache': True,
        'binaryDocumentSnapshotAndBuffersEqual': True, 'malformedPackageRejected': True, 'sourcePathCannotEscape': True},
        'requests': requests}
    (OUT / 'http.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    return result['checks']


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    controls = fixture_files()
    originals = original_cases()
    (OUT / 'parser.json').write_text(json.dumps({'date': '2026-10-22', 'controls': controls,
        'originalCohort': 'NovaCAD-Mac committed test fixtures; not industrial drawings and not generated for this implementation',
        'files': originals}, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'controls': controls, 'originalFiles': len(originals)}, ensure_ascii=False))
    if len(sys.argv) == 3 and sys.argv[1] == '--http':
        print(json.dumps(http_cases(sys.argv[2]), ensure_ascii=False))
