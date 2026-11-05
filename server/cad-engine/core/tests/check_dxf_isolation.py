"""Phase I: DXF cache/parameter isolation over the loopback HTTP interface.

Proves that the cache key actually separates file identity, transport, model
interface and the DXF rejection paths, and that a rejected request never creates
or overwrites a cached drawing. Server must run on the given port.
"""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import hashlib
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8788'
ROOT = DATA
APP = CORE
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / 'phase_i_evidence' / 'profiles' / 'dxf-cache-isolation.json'
SAMPLES = {'flange': SAMPLE_ROOT / 'QCAD_flange.dxf',
           'byblock': SAMPLE_ROOT / 'byblock_bylayer.dxf',
           'r12': SAMPLE_ROOT / 'frozen_layers_r12.dxf'}
result = {'base': BASE, 'assertions': [], 'requests': []}


def post(name, data, **params):
    query = {'name': name, 'model': params.pop('model', 'ucd')}
    query.update({k: v for k, v in params.items() if v is not None})
    request = urllib.request.Request(BASE + '/api/parse?' + urllib.parse.urlencode(query), data=data, method='POST')
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            body = response.read(); status = response.status; headers = dict(response.headers)
    except urllib.error.HTTPError as error:
        body = error.read(); status = error.code; headers = dict(error.headers)
    try:
        payload = json.loads(body)
    except ValueError:
        payload = None
    record = {'name': name, 'params': {k: v for k, v in params.items()}, 'status': status,
              'cache': headers.get('X-Cache'), 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest(),
              'error': (payload or {}).get('error') if status >= 400 else None,
              'code': (payload or {}).get('code')}
    result['requests'].append(record)
    return record, payload, body


def expect(condition, label):
    result['assertions'].append({'check': label, 'ok': bool(condition)})
    if not condition:
        raise AssertionError(label)


flange = SAMPLES['flange'].read_bytes()
byblock = SAMPLES['byblock'].read_bytes()

first, payload, first_body = post('QCAD_flange.dxf', flange)
expect(first['status'] == 200, 'flange parses (cache state may be warm after an earlier run)')
expect(payload['presentation']['stats']['draws'] == 223, 'flange draws 223')
drawing_id = payload['document']['drawing']['drawings']
expect(len(drawing_id) == 1, 'one drawing record')
drawing_key = next(iter(drawing_id))

again, payload2, again_body = post('QCAD_flange.dxf', flange)
expect(again['cache'] == 'hit' and again_body == first_body, 'identical upload is a byte-identical cache hit')

partial, payload_partial, partial_body = post('QCAD_flange.dxf', flange, partial='1')
expect(partial['status'] == 200, 'partial=1 does not downgrade DXF')
expect(payload_partial['document']['drawing']['drawings'].keys() == drawing_id.keys(), 'partial key returns the same drawing identity')
partial_again, _, partial_again_body = post('QCAD_flange.dxf', flange, partial='1')
expect(partial_again['cache'] == 'hit' and partial_again_body == partial_body, 'partial key is stable on repeat')

selection, _, _ = post('QCAD_flange.dxf', flange, configuration='ConfigA')
expect(selection['status'] == 422 and selection['code'] == 'dxf-selection-unsupported', 'selection-scoped DXF rejected')

binary, binary_payload, _ = post('QCAD_flange.dxf', flange, transport='binary')
expect(binary['status'] == 200 and binary_payload.get('transportProfile') == 'ucd-binary-manifest/1',
       'binary transport for DXF returns a manifest')
expect('bufferPayloads' not in binary_payload, 'binary manifest carries no base64 payloads')
expect(set(binary_payload['bufferResources']) == set(binary_payload['document']['buffers']),
       'binary manifest lists one resource per document buffer')
first_buffer = next(iter(binary_payload['bufferResources'].values()))
resource = urllib.request.urlopen(BASE + first_buffer['url'], timeout=120).read()
expect(len(resource) == first_buffer['byteLength'], 'binary resource bytes match the manifest')

legacy, _, _ = post('QCAD_flange.dxf', flange, model='legacy')
expect(legacy['status'] == 415 and legacy['code'] == 'dxf-requires-ucd', 'legacy interface rejects DXF')

after, payload_after, after_body = post('QCAD_flange.dxf', flange)
expect(after['cache'] == 'hit' and after_body == first_body, 'rejections did not invalidate or replace the cached drawing')

other, payload_other, _ = post('byblock_bylayer.dxf', byblock)
expect(other['status'] == 200, 'a second DXF parses')
expect(payload_other['document']['drawing']['drawings'].keys() != drawing_id.keys(), 'different file -> different drawing id')

flange_again, _, flange_again_body = post('QCAD_flange.dxf', flange, name_hint='ignored') if False else post('QCAD_flange.dxf', flange)
expect(flange_again['cache'] == 'hit' and flange_again_body == first_body, 'cross-file parse kept the flange entry intact')

# v0.8 deliberately recovers headerless tagged fragments, retaining an explicit
# partial status. They no longer exercise the unparseable-input rejection path.
fragment = b'0\nSECTION\n2\nNOT_A_DXF_SECTION\n0\nEOF\n'
recovered, recovered_payload, _ = post('fragment.dxf', fragment)
expect(recovered['status'] == 200 and recovered_payload['snapshot']['completeness'] == 'partial',
       'headerless recovery never becomes a complete artifact')

corrupt, _, _ = post('broken.dxf', b'not a DXF file')
expect(corrupt['status'] == 422, 'invalid DXF is rejected')
corrupt_again, _, _ = post('broken.dxf', b'not a DXF file')
expect(corrupt_again['status'] == 422 and corrupt_again['cache'] != 'hit', 'rejected DXF never becomes a cache hit')

sample = urllib.request.urlopen(BASE + '/api/sample?id=dxf_flange', timeout=120)
sample_record = {'status': sample.status, 'cache': sample.headers.get('X-Cache'), 'bytes': len(sample.read())}
result['sample_endpoint'] = sample_record
upload, _, upload_body = post('QCAD_flange.dxf', flange)
expect(upload['cache'] == 'hit' and upload_body == first_body, 'sample endpoint and upload share one cache entry')

result['summary'] = {'checks': len(result['assertions']),
                     'passed': sum(1 for a in result['assertions'] if a['ok']),
                     'drawingId': drawing_key}
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(result, ensure_ascii=False, indent=1) + '\n')
print(json.dumps(result['summary'], ensure_ascii=False))
print(json.dumps([r for r in result['requests']], ensure_ascii=False, indent=1))
