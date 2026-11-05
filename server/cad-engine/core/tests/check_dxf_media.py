"""Targeted external image/PDF resources and same-original-file acceptance."""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import base64
import hashlib
import io
import json
import math
from pathlib import Path
import sys
import tempfile
import urllib.parse
import urllib.request

APP = Path(__file__).resolve().parents[1]
ROOT = DATA
sys.path.insert(0, str(APP))
from unified.dxf_adapter import read_dxf
from unified.dxf_media import EXTENSION, MAX_PIXELS
from unified.validation import validate_envelope
from check_dxf_xref import package
import ezdxf
from ezdxf import xref
from PIL import Image
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, NameObject, NumberObject

OUT = ROOT / 'docs/dxf-media'
CONTROLS = OUT / 'controls'
ORIGINALS = OUT / 'originals/acadsharp'
FILES = {p.name: p.read_bytes() for p in ORIGINALS.iterdir() if p.suffix.lower() in ('.jpg', '.pdf')}
SHX = (ROOT / 'docs/dxf-shx/originals/acadsharp/test_shape.shx').read_bytes()


def extension(envelope):
    return envelope['document']['extensions'][EXTENSION]


def png(envelope, item):
    return Image.open(io.BytesIO(base64.b64decode(envelope['bufferPayloads'][item['bufferId']]))).convert('RGBA')


def controls():
    CONTROLS.mkdir(exist_ok=True)
    image = Image.new('RGBA', (64, 48), (255, 0, 0, 255))
    for y in range(48):
        for x in range(64):
            if x >= 32: image.putpixel((x, y), (0, 0, 255, 255))
            if x >= 32 and y >= 24: image.putpixel((x, y), (0, 0, 0, 0))
    output = io.BytesIO(); image.save(output, format='PNG'); raw_png = output.getvalue()
    (CONTROLS / 'quadrants.png').write_bytes(raw_png)
    writer = PdfWriter()
    for color in [b'1 0 0', b'0 0 1']:
        page = writer.add_blank_page(width=72, height=144)
        content = DecodedStreamObject(); content.set_data(color + b' rg 0 0 72 144 re f')
        page[NameObject('/Contents')] = writer._add_object(content)
        page[NameObject('/UserUnit')] = NumberObject(2)
    output = io.BytesIO(); writer.write(output); raw_pdf = output.getvalue()
    (CONTROLS / 'two_pages.pdf').write_bytes(raw_pdf)
    doc = ezdxf.new('R2013'); doc.units = 4
    for name, color in [('Image', 1), ('PDF', 3), ('Line', 5)]: doc.layers.new(name, dxfattribs={'color': color})
    definition = doc.add_image_def(filename='quadrants.png', size_in_pixel=(64, 48))
    image_entity = doc.modelspace().add_image(definition, insert=(0, 0), size_in_units=(8, 6), dxfattribs={'layer': 'Image', 'flags': 11})
    definition_pdf = doc.add_underlay_def(filename='two_pages.pdf', name='2')
    pdf_entity = doc.modelspace().add_underlay(definition_pdf, insert=(15, 0), scale=.1, dxfattribs={'layer': 'PDF', 'flags': 2})
    doc.modelspace().add_line((-2, -2), (28, -2), dxfattribs={'layer': 'Line'})
    block = doc.blocks.new('Media')
    block.add_image(definition, insert=(0, 0), size_in_units=(8, 6), dxfattribs={'layer': 'Image', 'flags': 11})
    doc.modelspace().add_blockref('Media', (10, 17), dxfattribs={'xscale': -1, 'rotation': 30})
    doc.layouts.get('Layout1').add_image(definition, insert=(0, 0), size_in_units=(8, 6), dxfattribs={'layer': 'Image', 'flags': 11})
    viewport = doc.layouts.get('Layout1').add_viewport(center=(30, 20), size=(10, 10), view_center_point=(4, 3), view_height=4, status=1)
    doc.saveas(CONTROLS / 'media.dxf')
    main = (CONTROLS / 'media.dxf').read_bytes(); files = {'quadrants.png': raw_png, 'two_pages.pdf': raw_pdf}
    missing = read_dxf(CONTROLS / 'media.dxf', main)
    loaded = read_dxf(CONTROLS / 'media.dxf', main, resources=files)
    validate_envelope(loaded)
    assert missing['snapshot']['completeness'] == 'partial'
    assert loaded['snapshot']['completeness'] == 'complete'
    assert next(iter(loaded['document']['drawing']['viewports'].values()))['enabled']
    assert extension(loaded)['coverage']['displayedObjects'] == 4
    assert set(extension(missing)['items']) == set(extension(loaded)['items'])
    pdf_item = next(i for i in extension(loaded)['items'].values() if i['sourceKind'] == 'PDFUNDERLAY')
    assert pdf_item['details']['pageNumber'] == 2
    assert all(math.isclose(a, b, abs_tol=1e-8) for a, b in zip(pdf_item['details']['pageSizeInSourceUnits'], [50.8, 101.6]))
    assert png(loaded, pdf_item).getpixel((20, 20)) == (0, 0, 255, 255)
    image_item = next(i for i in extension(loaded)['items'].values() if i['sourceRefs'][0]['objectKey'] == image_entity.dxf.handle)
    assert [[round(v, 8) for v in p] for p in image_item['corners']] == [[0, 6, 0], [8, 6, 0], [8, 0, 0], [0, 0, 0]]
    assert png(loaded, image_item).getpixel((48, 36))[3] == 0
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / 'control.dxf'
        def parse(current, resources=files):
            current.saveas(path)
            return read_dxf(path, path.read_bytes(), resources=resources)
        for rank in [0, -1, 1, 2, 3, 4]:
            viewport.dxf.status = rank
            current = parse(doc)
            assert next(iter(current['document']['drawing']['viewports'].values()))['enabled'] == (rank > 0)
        viewport.dxf.status = 1
        viewport.dxf.flags = 0x20000
        assert not next(iter(parse(doc)['document']['drawing']['viewports'].values()))['enabled']
        viewport.dxf.flags = 0
        image_entity.set_boundary_path([(0, 0), (31, 0), (0, 23)])
        clipped = parse(doc)
        clip = next(i for i in extension(clipped)['items'].values() if i['sourceRefs'][0]['objectKey'] == image_entity.dxf.handle)
        pixels = png(clipped, clip)
        assert pixels.getpixel((2, 2)) == (255, 0, 0, 255)
        assert pixels.getpixel((25, 20))[3] == 0
        image_entity.dxf.clip_mode = 1
        inverse = parse(doc); inverse_item = next(i for i in extension(inverse)['items'].values() if i['sourceRefs'][0]['objectKey'] == image_entity.dxf.handle)
        assert png(inverse, inverse_item).getpixel((2, 2))[3] == 0
        image_entity.reset_boundary_path(); image_entity.dxf.clip_mode = 0
        image_entity.dxf.flags = 3
        no_alpha = parse(doc); no_alpha_item = next(i for i in extension(no_alpha)['items'].values() if i['sourceRefs'][0]['objectKey'] == image_entity.dxf.handle)
        assert png(no_alpha, no_alpha_item).getpixel((48, 36))[3] == 255
        image_entity.dxf.flags = 10
        off = parse(doc)
        off_id = next(k for k, i in extension(off)['items'].items() if i['sourceRefs'][0]['objectKey'] == image_entity.dxf.handle)
        assert next(d for d in off['snapshot']['drawingProjection']['draws'].values() if d['itemId'] == off_id)['visibility'] == 'hidden'
        image_entity.dxf.flags = 11
        image_entity.dxf.brightness = 70
        adjusted = parse(doc)
        changed=next(i for i in extension(adjusted)['items'].values() if i['sourceKind']=='IMAGE')
        assert changed['status']=='ready' and changed['details']['displayAdjustments']['brightness']==70
        assert png(adjusted,changed).getpixel((20,20))[:3] != png(loaded,next(i for i in extension(loaded)['items'].values() if i['sourceKind']=='IMAGE')).getpixel((20,20))[:3]
        image_entity.dxf.brightness = 50
        pdf_entity.boundary_path = [(0, 0), (50, 100)]
        limited = parse(doc)
        pdf_clip=next(i for i in extension(limited)['items'].values() if i['sourceKind']=='PDFUNDERLAY')
        assert pdf_clip['status']=='ready' and pdf_clip['details']['clipping']
        pdf_entity.reset_boundary_path()
        definition_pdf.dxf.name = '3'
        absent_page = parse(doc)
        assert 'page-missing' in next(i for i in extension(absent_page)['items'].values() if i['sourceKind'] == 'PDFUNDERLAY')['reason']
        definition_pdf.dxf.name = 'cover'
        named = parse(doc)
        assert 'page-name-unsupported' in next(i for i in extension(named)['items'].values() if i['sourceKind'] == 'PDFUNDERLAY')['reason']
        definition_pdf.dxf.name = '2'
        for key in files:
            corrupt = dict(files); corrupt[key] = b'corrupted media'
            refused = parse(doc, corrupt)
            assert extension(refused)['coverage']['missingObjects'] > 0 and refused['snapshot']['completeness'] == 'partial'
        ambiguous = parse(doc, {'a/quadrants.png': raw_png, 'b/quadrants.png': raw_png, 'two_pages.pdf': raw_pdf})
        assert any(r['status'] == 'ambiguous' for r in extension(ambiguous)['references'])
        oversized = Image.new('RGB', (3000, 3000)); output = io.BytesIO(); oversized.save(output, format='PNG')
        refused = parse(doc, {'quadrants.png': output.getvalue(), 'two_pages.pdf': raw_pdf})
        assert any('pixel-limit' in i['reason'] for i in extension(refused)['items'].values())
        assert 3000 * 3000 > MAX_PIXELS
        protected = PdfWriter(); protected.add_blank_page(72, 144); protected.encrypt('test-password'); output = io.BytesIO(); protected.write(output)
        refused = parse(doc, {'quadrants.png': raw_png, 'two_pages.pdf': output.getvalue()})
        assert any('encrypted-unsupported' in i['reason'] for i in extension(refused)['items'].values())
        child = ezdxf.new('R2013'); child.units = 4
        child_def = child.add_underlay_def('two_pages.pdf', name='2')
        child_pdf = child.modelspace().add_underlay(child_def, dxfattribs={'flags': 2})
        child.saveas(path); child_raw = path.read_bytes()
        host = ezdxf.new('R2013'); host.units = 1
        xref.attach(host, block_name='Child', filename='child/media.dxf')
        imported = parse(host, {'child/media.dxf': child_raw, 'child/two_pages.pdf': raw_pdf})
        item = next(iter(extension(imported)['items'].values()))
        assert item['status'] == 'ready' and item['details']['sourceUnits'] == 4
        assert item['sourceRefs'][0]['sourceId'] == 'source-' + hashlib.sha256(child_raw).hexdigest()
        assert item['sourceRefs'][0]['objectKey'] == child_pdf.dxf.handle
        assert item['definitionSourceRefs'][0]['objectKey'] == child_def.dxf.handle and item['chain']
    repeat = read_dxf(CONTROLS / 'media.dxf', main, resources=files)
    assert repeat['document']['revision'] == loaded['document']['revision']
    return {'validMediaAndSchema': True, 'viewportPositiveRanksAndOffFlag': True, 'missingAndOriginalIdentity': True,
        'selectedPdfPageUserUnitAndPhysicalUnits': True, 'imageBasisAndAlpha': True,
        'libraryPolygonClipAndInverse': True, 'sourceVisibilityAndTransparencyFlag': True,
        'imageAdjustmentsAndPdfClipping': True, 'missingAndNamedPdfPagesRefused': True,
        'corruptAndAmbiguousResources': True, 'pixelBudget': True, 'encryptedPdfRefused': True,
        'xrefOriginalUnitsDefinitionsAndIdentity': True, 'requestHistoryStable': True}


def originals():
    rows = []
    for name in ['acadsharp_sample_AC1015.dxf', 'acadsharp_sample_AC1032.dxf']:
        path = ROOT / 'phase_i_evidence/samples/real' / name; raw = path.read_bytes(); states = []
        for state, resources in [('main-only', None), ('shx-only', {'test_shape.shx': SHX}),
                                 ('media-only', FILES), ('all-original-companions', {**FILES, 'test_shape.shx': SHX}), ('removed-again', None)]:
            e = read_dxf(path, raw, resources=resources); d = e['document']; validate_envelope(e)
            states.append({'state': state, 'display': d['extensions']['org.cad-preview.drawing-coverage/1']['displayGeometry'],
                'media': extension(e), 'overallCompleteness': e['snapshot']['completeness'],
                'artifactBytes': len(json.dumps(e, ensure_ascii=False, separators=(',', ':')).encode())})
        assert states[3]['display']['withDisplayGeometry'] == states[0]['display']['withDisplayGeometry'] + 3
        assert states[1]['display']['withDisplayGeometry'] + 2 == states[3]['display']['withDisplayGeometry']
        assert states[0]['display'] == states[4]['display']
        refs = lambda state: {k: i['sourceRefs'] for k, i in state['media']['items'].items()}
        assert refs(states[0]) == refs(states[3]) == refs(states[4])
        rows.append({'file': name, 'sha256': hashlib.sha256(raw).hexdigest(), 'inputBytes': len(raw),
            'mediaBytes': sum(map(len, FILES.values())), 'shxBytes': len(SHX), 'states': states})
    return rows


def http_cases(base):
    rows = []; main = (CONTROLS / 'media.dxf').read_bytes()
    files = {'media.dxf': main, 'quadrants.png': (CONTROLS / 'quadrants.png').read_bytes(), 'two_pages.pdf': (CONTROLS / 'two_pages.pdf').read_bytes()}
    def post(values, transport='base64'):
        body = package('media.dxf', values)
        query = urllib.parse.urlencode({'name': 'media.dxf', 'model': 'ucd', 'metadata': 'full', 'compression': 'identity', 'transport': transport})
        with urllib.request.urlopen(urllib.request.Request(base + '/api/parse-dxf-bundle?' + query, data=body, method='POST'), timeout=70) as response:
            raw = response.read(); env = json.loads(raw); rows.append({'cache': response.headers.get('X-Cache'), 'requestBytes': len(body), 'artifactBytes': len(raw), 'transport': transport})
        return env, raw
    before, data = post(files); assert before['snapshot']['completeness'] == 'complete'
    _, repeated = post(files); assert rows[-1]['cache'] == 'hit' and data == repeated
    missing, _ = post({'media.dxf': main}); assert missing['snapshot']['completeness'] == 'partial'
    changed = dict(files); changed['quadrants.png'] = FILES['image.JPG']
    invalid, _ = post(changed); assert rows[-1]['cache'] != 'hit' and invalid['snapshot']['completeness'] == 'partial'
    _, restored = post(files); assert rows[-1]['cache'] == 'hit' and restored == data
    binary, _ = post(files, 'binary'); assert binary['transportProfile'] == 'ucd-binary-manifest/1'
    assert extension(binary)['items'] == extension(before)['items']
    result = {'base': base, 'checks': {'bundleRoundTrip': True, 'sameByteCache': True, 'missingPackageIsolated': True,
        'actualMediaBytesInvalidateCache': True, 'originalPackageRestoresCache': True, 'binaryMediaMetadataParity': True}, 'requests': rows}
    (OUT / 'http.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    return result['checks']


if __name__ == '__main__':
    checks = controls(); files = originals()
    (OUT / 'parser.json').write_text(json.dumps({'date': '2026-10-23', 'controls': checks, 'originalFiles': files,
        'controlClassification': 'Generated DXF/PNG/PDF engineering controls, separate from unchanged upstream originals'}, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'controls': checks, 'unchangedOriginalFiles': len(files)}), flush=True)
    if len(sys.argv) == 3 and sys.argv[1] == '--http': print(json.dumps(http_cases(sys.argv[2])), flush=True)
