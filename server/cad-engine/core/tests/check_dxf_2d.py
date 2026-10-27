"""DXF v0.4 display controls and the unchanged eleven-file acceptance corpus.

Run with the editable ezdxf runtime; --corpus writes docs/dxf-2d, retaining v0.3.
Controls are synthetic conformance checks, never additional real-file successes.
"""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import base64
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile

import ezdxf

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from unified.dxf_adapter import read_dxf, project_drawing
from unified.dxf_annotations import primitives
from unified.dxf_tolerance import parse_frame, symbol_primitives, SYMBOL_CODES
from unified.dxf_gradients import source_stops
import check_dxf_annotations as annotations
from check_dxf_fill import entities, tag

ROOT = DATA
OUT = ROOT / 'docs/dxf-2d'
SAMPLES = ROOT / 'phase_i_evidence/samples/real'
TARGET_TYPES = {'MLINE', 'ACAD_TABLE', 'WIPEOUT', 'XLINE', 'RAY', 'TOLERANCE'}


def control_document():
    doc = ezdxf.new('R2018')
    doc.layers.new('Mask', dxfattribs={'color': 1})
    model = doc.modelspace()
    back = model.add_line((0, 5), (10, 5), dxfattribs={'color': 1})
    text = model.add_text('MASKED', dxfattribs={'height': 1, 'insert': (2.5, 5)})
    mask = model.add_wipeout([(2, 2), (8, 2), (8, 8), (2, 8)], dxfattribs={'layer': 'Mask'})
    mask.dxf.layer = 'Mask'  # ezdxf set_masking_area resets DEFAULT_ATTRIBS.
    front = model.add_line((5, 0), (5, 10), dxfattribs={'color': 3})
    # Physical order differs from source painting order; provenance stays physical.
    model.set_redraw_order([(back.dxf.handle, '1'), (text.dxf.handle, '2'),
                            (mask.dxf.handle, '4'), (front.dxf.handle, '3')])
    block = doc.blocks.new('Infinite')
    ray = block.add_ray((0, 0), (1, 0), dxfattribs={'color': 0, 'linetype': 'BYBLOCK'})
    block.add_xline((0, 0), (0, 1))
    model.add_blockref('Infinite', (20, 0), dxfattribs={'rotation': 90, 'xscale': -2, 'yscale': .5, 'color': 3})
    model.add_blockref('Infinite', (40, 0), dxfattribs={'color': 1})
    model.add_mline([(0, -5), (5, -5), (10, -2)])
    for code in SYMBOL_CODES:
        model.new_entity('TOLERANCE', dxfattribs={'content': '{\\Fgdt;' + code + '}%%v0.1%%vA',
                         'insert': (0, -20 - SYMBOL_CODES.index(code) * 2)})
    # Unknown symbol must not turn into an ordinary letter or half a frame.
    bad = model.new_entity('TOLERANCE', dxfattribs={'content': '{\\Fgdt;?}%%v0.2', 'insert': (20, -20)})
    gradient = model.add_hatch()
    gradient.set_gradient(color1=(10, 20, 30), color2=(200, 210, 220), rotation=90, name='SPHERICAL')
    gradient.paths.add_polyline_path([(20, 20), (30, 20), (30, 30), (20, 30)], is_closed=True, flags=1)
    gradient.paths.add_polyline_path([(23, 23), (27, 23), (27, 27), (23, 27)], is_closed=True, flags=16)
    return doc, {'back': back.dxf.handle, 'text': text.dxf.handle, 'mask': mask.dxf.handle,
                 'front': front.dxf.handle, 'bad': bad.dxf.handle, 'gradient': gradient.dxf.handle,
                 'ray': ray.dxf.handle}


def browser_fixture():
    """Small synthetic mask/paint-order/infinite-line scene; not corpus evidence."""
    doc = ezdxf.new('R2018'); model = doc.modelspace()
    doc.layers.new('Mask', dxfattribs={'color': 1})
    back = model.add_line((0, 5), (10, 5), dxfattribs={'color': 1})
    text = model.add_text('MASKED', dxfattribs={'height': 1, 'insert': (2.5, 5)})
    mask = model.add_wipeout([(2, 2), (8, 2), (8, 8), (2, 8)], dxfattribs={'layer': 'Mask'})
    mask.dxf.layer = 'Mask'
    front = model.add_line((5, 0), (5, 10), dxfattribs={'color': 3})
    model.set_redraw_order([(back.dxf.handle, '1'), (text.dxf.handle, '2'),
                            (mask.dxf.handle, '4'), (front.dxf.handle, '3')])
    model.add_xline((0, 0), (0, 1), dxfattribs={'color': 4})
    model.add_ray((0, 0), (1, 0), dxfattribs={'color': 4})
    model.add_mline([(0, -5), (5, -5), (10, -2)])
    return doc


def controls():
    # Ported upstream parser/layout cases plus our strict refusal contract.
    rows = parse_frame('{\\Fgdt;j}%%v{\\Fgdt;n}0.1{\\Fgdt;m}%%vA%%vB^J2.5{\\Fgdt;p}')
    assert rows[0][0] == [('symbol', 'j')]
    assert rows[0][1] == [('symbol', 'n'), ('text', '0.1'), ('symbol', 'm')]
    assert rows[1][0] == [('text', '2.5'), ('symbol', 'p')]
    assert parse_frame(r'{\\Fgdt;j}') == [[ [('symbol', 'j')] ]]
    for text in ['{\\Fgdt;?', '{\\Fgdt;?}', '\\H2x;A', 'A' * 4097]:
        try:
            parse_frame(text)
        except ValueError:
            pass
        else:
            raise AssertionError('incomplete frame accepted: ' + text[:20])
    assert len(SYMBOL_CODES) == 19 and all(symbol_primitives(c) for c in SYMBOL_CODES)
    with tempfile.TemporaryDirectory(prefix='dxf-2d-') as directory:
        doc, handles = control_document()
        path = Path(directory) / 'control.dxf'; doc.saveas(path)
        env = read_dxf(path, path.read_bytes()); d = env['document']; drawing = d['drawing']
        entries = d['extensions']['org.cad-preview.annotation-presentation/1']['items']
        by_handle = {item['sourceRefs'][0]['objectKey']: item for item in drawing['entities'].values()}
        bad = entries[by_handle[handles['bad']]['id']]
        assert bad['status'] == 'missing' and not bad['parts'] and 'gdt-symbol-unsupported' in bad['reason']
        assert sum(e['sourceKind'] == 'TOLERANCE' and e['status'] == 'ready' for e in entries.values()) == 19
        ray = entries[by_handle[handles['ray']]['id']]
        assert ray['mode'] == 'view-dependent' and 'representationId' not in ray['parts'][0]
        styles = {}; projection = project_drawing(d, env['snapshot']['drawingProjection']['target'], presentation_styles=styles)
        ray_draws = [(key, draw) for key, draw in projection['draws'].items() if draw['itemId'] == by_handle[handles['ray']]['id']]
        assert len(ray_draws) == 2 and len({key for key, _ in ray_draws}) == 2
        assert all('displayRepresentationId' not in draw for _, draw in ray_draws)
        assert {tuple(styles[key][0]['style']['color'][:3]) for key, _ in ray_draws} == {(0, 1, 0), (1, 0, 0)}
        order = {drawing['entities'][draw['itemId']]['sourceRefs'][0]['objectKey']: draw['drawOrder']
                 for draw in projection['draws'].values() if draw['kind'] == 'entity'}
        assert order[handles['back']] < order[handles['front']] < order[handles['mask']]
        assert by_handle[handles['mask']]['sourceRefs'][0]['recordOffset'] == 2
        spec = d['extensions']['org.cad-preview.fill/1']['fills'][by_handle[handles['gradient']]['id']]['gradient']
        assert spec['colors'] == [[10, 20, 30], [200, 210, 220]] and math.isclose(spec['angleRadians'], math.pi / 2)
        # The same derivative must atomically refuse unsupported table content.
        source = ezdxf.readfile(SAMPLES / 'acadsharp_sample_AC1015.dxf')
        table = source.entitydb['528']; block = source.blocks.get(table.get_block_name())
        block.add_3dface([(0, 0), (1, 0), (1, 1)])
        source.saveas(path)
        table_env = read_dxf(path, path.read_bytes())
        table_rows = table_env['document']['extensions']['org.cad-preview.annotation-presentation/1']['items']
        row = next(row for row in table_rows.values() if row['sourceKind'] == 'ACAD_TABLE' and row['sourceRefs'][0]['objectKey'] == '528')
        assert row['status'] == 'missing' and not row['parts']
        # 3D plane conversion uses ezdxf transforms; never flatten a tilted frame.
        tol = doc.modelspace().new_entity('TOLERANCE', dxfattribs={
            'content': '{\\Fgdt;j}%%v0.1', 'insert': (7, 8, 9),
            'extrusion': (0, 1, 0), 'x_axis_vector': (0, 0, 1)})
        for leaf, _ in primitives(tol, doc):
            if leaf.dxftype() == 'LINE':
                assert math.isclose(leaf.dxf.start.y, 8) and math.isclose(leaf.dxf.end.y, 8)
        # Both declared SHIFT states are supported; other values are invalid.
        gradient = doc.modelspace().query('HATCH')[0]; gradient.gradient.centered = .5
        doc.saveas(path); refused = read_dxf(path, path.read_bytes())
        skipped = refused['document']['extensions']['org.cad-preview.fill/1']['skipped']
        assert any(row['reason'] == 'gradient-shift-out-of-range' for row in skipped)
        # Explicit default black/white must win over the ACI fallback; removing
        # the RGB tags must instead use the declared ACI colors. Binary DXF uses
        # the same low-level ezdxf reader, with no ASCII-only fallback.
        colors_doc = ezdxf.new('R2018'); colors_hatch = colors_doc.modelspace().add_hatch()
        colors_hatch.set_gradient(color1=(0,0,0),color2=(255,255,255))
        colors_hatch.gradient.aci1, colors_hatch.gradient.aci2 = 1, 3
        colors_doc.saveas(path); raw = path.read_bytes(); handle = colors_hatch.dxf.handle
        assert source_stops(raw,colors_doc.output_encoding)[handle] == [[0,0,0],[255,255,255]]
        lines = raw.decode(colors_doc.output_encoding).splitlines()
        aci_only = '\n'.join(line for i in range(0,len(lines)-1,2) if int(lines[i])!=421 for line in lines[i:i+2])+'\n'
        assert source_stops(aci_only.encode(),colors_doc.output_encoding)[handle] == [[255,0,0],[0,255,0]]
        with path.open('wb') as stream:
            colors_doc.write(stream,fmt='bin')
        assert source_stops(path.read_bytes(),colors_doc.output_encoding)[handle] == [[0,0,0],[255,255,255]]
    module = 'data:text/javascript;base64,' + base64.b64encode((BROWSER / 'drawing-2d.js').read_bytes()).decode()
    script = """import assert from 'node:assert/strict';
import {clipInfiniteLine,gradientField,triangleBoundarySegments} from 'MODULE';
const box={minX:0,minY:0,maxX:10,maxY:10};
assert.deepEqual(clipInfiniteLine({kind:'xline',origin:[5,5],direction:[1,0]},box),[0,5,10,5]);
assert.deepEqual(clipInfiniteLine({kind:'ray',origin:[5,5],direction:[1,0]},box),[5,5,10,5]);
assert.equal(clipInfiniteLine({kind:'ray',origin:[20,5],direction:[1,0]},box),null);
assert.deepEqual(clipInfiniteLine({kind:'xline',origin:[5,5],direction:[1,1]},box),[0,0,10,10]);
assert.deepEqual(clipInfiniteLine({kind:'ray',origin:[20,5],direction:[-2,0]},box),[10,5,0,5]);
assert.equal(clipInfiniteLine({kind:'xline',origin:[20,5],direction:[0,1]},box),null);
const spec={frameBounds:[0,0,10,10],domain:[0,0,10,10],angleRadians:0,shift:0};
const linear=gradientField({...spec,name:'LINEAR'}), sphere=gradientField({...spec,name:'SPHERICAL'});
assert.equal(linear(0,5),0); assert.equal(linear(10,5),1);
assert.equal(sphere(5,5),1); assert(Math.abs(sphere(0,0))<1e-12);
assert.equal(gradientField({...spec,name:'INVSPHERICAL'})(5,5),0);
assert.equal(gradientField({...spec,name:'CYLINDER'})(5,5),1);
assert(Math.abs(gradientField({...spec,name:'CURVED'})(5,5)-Math.SQRT1_2)<1e-12);
assert.equal(gradientField({...spec,name:'HEMISPHERICAL'})(5,0),1);
assert.equal(gradientField({...spec,name:'SPHERICAL',shift:1})(2.5,7.5),1);
assert.equal(gradientField({...spec,name:'LINEAR',shift:1})(3.125,5),.5);
assert.throws(()=>gradientField({...spec,name:'UNKNOWN'}));
const outline=triangleBoundarySegments([[[0,0],[1,0],[1,1]],[[0,0],[1,1],[0,1]]]);
assert.equal(outline.length,4); assert(!outline.some(([a,b])=>a[0]!==b[0]&&a[1]!==b[1]));
console.log('View clipping and gradient field controls passed');
""".replace('MODULE', module)
    subprocess.run(['node', '--input-type=module', '-e', script], check=True)
    print('2D library/identity/order/refusal/plane controls passed', flush=True)


def corpus():
    annotations.corpus_report(OUT)
    assert not annotations.FAILURES, annotations.FAILURES
    report = json.loads((OUT / 'results.json').read_text())
    summarize_corpus(report)


def summarize_corpus(report):
    fixed = 0; remaining = []
    for row in report['files']:
        assert row['projectionAndStyleParity']
        remaining.extend({'file': row['file'], **record} for record in row['missingRecords'])
        fixed += sum(count for key, count in row['annotations'].items() if key.split(':')[0] in TARGET_TYPES and key.endswith(':ready'))
        # Independent raw group-code checks: actual source stops, not public API defaults.
        if row['file'] == 'acadsharp_sample_AC1032.dxf':
            count = 0
            for source in entities(SAMPLES / row['file']):
                if source['type'] != 'HATCH' or tag(source['tags'], 450) != '1':
                    continue
                assert [int(value) for code, value in source['tags'] if code == 421] == [255, 16776960]
                assert tag(source['tags'], 461) == '0.0' or float(tag(source['tags'], 461)) == 0
                count += 1
            assert count == 2
    report['summary']['new2dSourcePresentations'] = fixed
    report['summary']['gradientSourceFills'] = 2
    report['summary']['remainingMissingSourceRecords'] = len(remaining)
    assert fixed == 22 and len(remaining) == 28
    assert not any(record['sourceKind'] in TARGET_TYPES for record in remaining)
    report['baseline'] = {'commit': '7d8842e', 'report': 'docs/dxf-annotations/results.json',
                          'missingSourceRecords': 52, 'addedDisplaySourceRecords': 24}
    baseline = json.loads((ROOT / 'docs/dxf-annotations/KNOWN_MISSING.json').read_text())
    previous = {(row['file'],record['itemId']):record for row in baseline['files'] for record in row['records']}
    current = {(record['file'],record['itemId']):record for record in remaining}
    assert current.keys() <= previous.keys(), 'A different source became missing'
    assert all(row['sourceRefs'] == previous[key]['sourceRefs'] for key,row in current.items())
    added = [{'file':name, **{key:value for key,value in previous[(name,item_id)].items() if key!='reason'},
              'baselineReason':previous[(name,item_id)]['reason'], 'status':'display-ready'}
             for name,item_id in previous.keys()-current.keys()]
    assert len(added) == 24
    report['newDisplayRecords'] = sorted(added,key=lambda row:(row['file'],row['sourceRefs'][0]['recordOffset']))
    (OUT / 'results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    known = {'date': '2026-10-21', 'adapterVersion': '0.4.0', 'sourceRecordsWithoutDisplay': len(remaining),
             'files': [{'file':row['file'],'sha256':row['sha256'],'records':row['missingRecords'],
                        'otherLosses':next(item['otherLosses'] for item in baseline['files'] if item['file']==row['file'])}
                       for row in report['files']],
             'note': '28 missing source records remain explicit; source-empty leaders, external resources and 3D/ACIS are not counted as success. Non-top viewport remains separately recorded in the per-file table.'}
    (OUT / 'KNOWN_MISSING.json').write_text(json.dumps(known, ensure_ascii=False, indent=2) + '\n')
    print(report['summary'])


if __name__ == '__main__':
    controls()
    if '--write-controls' in sys.argv:
        fixture = ROOT / '.phase-work/dxf-2d-controls/mask-control.dxf'
        fixture.parent.mkdir(parents=True,exist_ok=True)
        browser_fixture().saveas(fixture)
        print('Synthetic browser fixture:',fixture)
    if '--corpus' in sys.argv:
        corpus()
