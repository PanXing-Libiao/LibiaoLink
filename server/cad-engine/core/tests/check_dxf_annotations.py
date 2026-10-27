"""DXF annotation/attribute and layer-0 inheritance regression checks.

Real files only; the goal is that the projection tells the truth about what can be
drawn, not that a count looks bigger:

  * layer-0 content inside an INSERT follows the INSERT layer (colour, visibility)
  * ATTDEF is a template: it has no own presentation, the INSERT's ATTRIB value is drawn
  * ATTRIB is materialised in owner space with its tag/value and inherited layer hint
  * a missing DIMENSION block is rendered by ezdxf; source measurement stays unknown

Run:  ../.phase-work/dxf/bin/python tests/check_dxf_annotations.py
"""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import sys
import hashlib
import base64
import csv
import json
import subprocess
import tempfile
import time
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP_DIR = HERE.parent
sys.path.insert(0, str(APP_DIR))
from unified.dxf_adapter import read_dxf, project_drawing  # noqa: E402

SAMPLES = DATA / 'phase_i_evidence' / 'samples' / 'real'
FAILURES = []


def check(condition, message):
    if not condition:
        FAILURES.append(message)


def load(name):
    path = SAMPLES / name
    return read_dxf(str(path), path.read_bytes())


def parse_color(rgba):
    return tuple(round(value, 4) for value in rgba)


def annotation_rows(env):
    document = env['document']
    flags = document['extensions']['org.cad-preview.style-inheritance/1'].get('entityState', {})
    draws = env['snapshot']['drawingProjection']['draws']
    rows = []
    for draw in draws.values():
        if draw['kind'] != 'annotation':
            continue
        annotation = document['drawing']['annotations'][draw['itemId']]
        rows.append((draw, annotation, flags.get(draw['itemId'], {})))
    return rows


def source_annotations(document):
    return [annotation for annotation in document['drawing']['annotations'].values()
            if annotation.get('semantic', {}).get('tag')]


def test_attributes(name, expected_annotations, expected_model_draws):
    env = load(name)
    document = env['document']
    flags = document['extensions']['org.cad-preview.style-inheritance/1'].get('entityState', {})
    rows = annotation_rows(env)
    # Every source ATTRIB is materialised as an annotation, including the ones that live
    # in paper spaces and therefore do not appear in the model-space projection draws.
    source = source_annotations(document)
    check(len(source) == expected_annotations,
          '%s: expected %d ATTRIB annotations in every space, found %d'
          % (name, expected_annotations, len(source)))
    attributes = [row for row in rows
                  if row[1].get('semantic', {}).get('tag') and not row[2].get('attributeTemplate')]
    check(len(attributes) == expected_model_draws,
          '%s: expected %d ATTRIB draws in model space, found %d'
          % (name, expected_model_draws, len(attributes)))
    templates = [row for row in rows if row[2].get('attributeTemplate')]
    for draw, annotation, info in attributes:
        check(annotation.get('text'), '%s: ATTRIB %s has no text' % (name, annotation['id']))
        check(draw['availability'] == 'ready',
              '%s: ATTRIB %s is not ready (%s)' % (name, draw['itemId'], draw['availability']))
        position = annotation.get('position')
        check(position and len(position) >= 2, '%s: ATTRIB %s has no position' % (name, annotation['id']))
    for draw, annotation, info in templates:
        check(draw['availability'] == 'missing-reference',
              '%s: ATTDEF %s should be a non-drawable template, got %s'
              % (name, draw['itemId'], draw['availability']))
    return [annotation.get('text') for _, annotation, _ in attributes], len(templates)


def test_layer_inheritance(name, minimum):
    env = load(name)
    document = env['document']
    drawings = document['drawing']
    style = document['extensions']['org.cad-preview.style-inheritance/1']
    layers = {row['id']: row for row in drawings['layers'].values()}
    inherited = set(style.get('layerInheritance', {}))
    check(inherited == {row['id'] for row in layers.values() if row['name'] == '0'},
          '%s: layerInheritance should be exactly layer 0' % name)
    zero_ids = {row['id'] for row in layers.values() if row['name'] == '0'}
    checked = 0
    mismatches = 0
    for draw in env['snapshot']['drawingProjection']['draws'].values():
        if draw['kind'] != 'entity' or not draw['blockPath']:
            continue
        entity = drawings['entities'][draw['itemId']]
        if entity['layerId'] not in zero_ids:
            continue
        if (entity.get('style', {}).get('color', {}) or {}).get('mode') != 'by-layer':
            continue  # an explicit entity colour wins over layer inheritance
        # Layer-0 inheritance walks up the whole block chain: an inner layer-0 block
        # inserted into another layer-0 block still belongs to the outer INSERT layer.
        expected_layer = None
        for step in reversed(draw['blockPath']):
            instance = drawings['blockInstances'][step['instanceId']]
            if instance['layerId'] not in zero_ids:
                expected_layer = instance['layerId']
                break
        if expected_layer is None:
            continue
        expected = parse_color(layers[expected_layer]['defaultStyle']['color']['rgba'])
        checked += 1
        if parse_color(draw['style']['color']) != expected:
            mismatches += 1
    check(checked >= minimum,
          '%s: expected at least %d layer-0 block draws, found %d' % (name, minimum, checked))
    check(mismatches == 0,
          '%s: %d layer-0 block draws did not inherit the INSERT layer colour'
          % (name, mismatches))
    return checked


def test_dimension_without_geometry():
    env = load('qcad_flange.dxf')
    document = env['document']
    losses = document['extensions']['org.cad-preview.drawing-coverage/1'].get('losses', [])
    missing = [loss for loss in losses if loss.get('code') == 'dimension-presentation-missing']
    rows = annotation_rows(env)
    dimensions = [row for row in rows if row[1]['kind'] == 'dimension']
    not_ready = [row for row in dimensions if row[0]['availability'] != 'ready']
    check(len(dimensions) >= 6, 'qcad_flange: expected 6 DIMENSION records, found %d' % len(dimensions))
    check(not missing and not not_ready, 'qcad_flange: all 6 missing presentation blocks should now render')
    entries = document['extensions']['org.cad-preview.annotation-presentation/1']['items']
    rebuilt = [entries[row[1]['id']] for row in dimensions]
    check(len(rebuilt) == 6 and all(row['status'] == 'ready' and row['parts'] for row in rebuilt),
          'qcad_flange: expected 6 complete ezdxf derivatives')
    check(all(row[1]['measuredValue']['knowledge'] == 'unknown' for row in dimensions),
          'qcad_flange: display generation must not claim engineering measurement semantics')
    return {'dimensions': len(dimensions), 'missingPresentation': len(missing),
            'notReady': len(not_ready)}


def test_formatted_block_instances():
    """Control input, not a real-file acceptance claim: colour/identity/transform."""
    import ezdxf
    with tempfile.TemporaryDirectory() as folder:
        doc = ezdxf.new('R2013')
        doc.layers.new('Yellow', dxfattribs={'color': 2})
        doc.layers.new('Green', dxfattribs={'color': 3})
        block = doc.blocks.new('Notes')
        source = block.add_mtext(r'Wide {\W2;XX} {\C1;red}\P\S1/2;',
                                 dxfattribs={'char_height': 2, 'width': 55, 'color': 0})
        doc.modelspace().add_blockref('Notes', (0, 0), dxfattribs={'layer': 'Yellow', 'color': 0})
        doc.modelspace().add_blockref('Notes', (80, 0),
                                     dxfattribs={'layer': 'Green', 'color': 0, 'rotation': 30, 'xscale': -2})
        path = Path(folder) / 'notes.dxf'
        doc.saveas(path)
        before = path.read_bytes()
        env = read_dxf(str(path), before)
        d = env['document']
        parts = d['extensions']['org.cad-preview.annotation-presentation/1']['items']
        check(len(parts) == 1, 'MTEXT reuse must keep one source item')
        item_id, entry = next(iter(parts.items()))
        check(entry['status'] == 'ready' and len(entry['parts']) >= 6, 'MTEXT fractions/formatting did not produce complete geometry')
        check(entry['sourceRefs'][0]['objectKey'] == source.dxf.handle, 'MTEXT source handle changed')
        styles = {}
        projection = project_drawing(d, env['snapshot']['drawingProjection']['target'], presentation_styles=styles)
        check(len(projection['draws']) == 2 and all(draw['itemId'] == item_id for draw in projection['draws'].values()),
              'Virtual primitives must not become independent source draws')
        colors = [{parse_color(part['style']['color']) for part in rows} for rows in styles.values()]
        check({(1, 1, 0, 1), (1, 0, 0, 1)} in colors and {(0, 1, 0, 1), (1, 0, 0, 1)} in colors,
              'Inline colour or BYBLOCK/layer-0 colour lost across instances')
        transforms = [row['localToSpace'] for row in projection['draws'].values()]
        check(transforms[0] != transforms[1] and transforms[1][0] < 0, 'Mirrored/rotated instance transform lost')
        check(path.read_bytes() == before and d['sources'][0]['sha256'] == hashlib.sha256(before).hexdigest(),
              'Rendering changed source bytes/identity')

    # Control mutation in memory: a library fallback must not become a complete
    # presentation merely because it emitted some surviving line primitives.
    from unified.dxf_annotations import primitives
    doc = ezdxf.readfile(SAMPLES / 'acadsharp_sample_AC1015.dxf')
    leader = next(entity for block in doc.blocks for entity in block if entity.dxftype() == 'MULTILEADER')
    leader.dxf.style_handle = 'missing-style-control'
    try:
        list(primitives(leader, doc))
    except ValueError as error:
        check('annotation-renderer-warning:' in str(error), 'Missing MLEADER style failure lost its reason')
    else:
        check(False, 'Missing MLEADER style was silently accepted as complete')


def corpus_report(output=None):
    """Fixed real files; JS parity is a pure projection test, not browser proof."""
    root = DATA
    cases = json.loads((root / 'docs/parse-speed-dxf/dxf-files.json').read_text())['files']
    module = 'data:text/javascript;base64,' + base64.b64encode((BROWSER / 'drawing-projection.js').read_bytes()).decode()
    script = "import {projectDrawing} from '" + module + "';import fs from 'node:fs';const input=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(input.targets.map(target=>{const layers={},styles={};const projection=projectDrawing(input.document,target,layers,styles);return {projection,layers,styles};})));"
    rows = []
    for case in cases:
        path = SAMPLES / case['file']; raw = path.read_bytes()
        check(hashlib.sha256(raw).hexdigest() == case['sha256'], path.name + ': fixed corpus changed')
        start = time.monotonic(); env = read_dxf(str(path), raw); seconds = time.monotonic() - start
        d = env['document']; ext = d['extensions']; drawing = d['drawing']
        items = ext['org.cad-preview.annotation-presentation/1']['items']
        model = next(iter(drawing['drawings'].values()))['modelSpaceId']
        targets = [{'kind': 'model', 'spaceId': model}] + [{'kind': 'layout', 'layoutId': key} for key in drawing['layouts']]
        expected = []
        for target in targets:
            layers, styles = {}, {}
            projection = project_drawing(d, target, layers, styles)
            expected.append({'projection': projection, 'layers': layers, 'styles': styles})
        actual = json.loads(subprocess.run(['node', '--input-type=module', '-e', script],
            input=json.dumps({'document': {'drawing': drawing, 'extensions': ext}, 'targets': targets}),
            text=True, capture_output=True, check=True).stdout)
        check(actual == expected, path.name + ': Python/JS projection or part styles differ')
        coverage = ext['org.cad-preview.drawing-coverage/1']['displayGeometry']
        check(coverage['sourceRecords'] == case['sourceRecords'], path.name + ': source count changed')
        source_ids = set(drawing['entities']) | set(drawing['annotations'])
        check(all(part['id'] not in source_ids for item in items.values() for part in item['parts']), path.name + ': generated parts entered source tables')
        counts = Counter(item['sourceKind'] + ':' + item['status'] for item in items.values())
        missing_records = []
        for entity_id, entity in drawing['entities'].items():
            if entity['geometry']['type'] == 'unsupported' and items.get(entity_id, {}).get('status') != 'ready':
                missing_records.append({'itemId': entity_id, 'sourceRefs': entity['sourceRefs'],
                    'sourceKind': entity['geometry']['sourceType'],
                    'reason': items.get(entity_id, {}).get('reason', entity['geometry']['reason'])})
        row = {'file': path.name, 'sha256': case['sha256'], 'inputBytes': len(raw),
               'artifactBytes': len(json.dumps(env, separators=(',', ':')).encode()),
               'parserCallSeconds': round(seconds, 4), 'display': coverage,
               'beforeDisplayStatus': case['displayGeometryStatus'], 'annotations': dict(counts),
               'pythonJsSpaces': len(targets), 'projectionAndStyleParity': actual == expected,
               'failures': [item for item in items.values() if item['status'] == 'missing'],
               'missingRecords': missing_records,
               'fonts': sorted({font['resolved'] for item in items.values() for font in item.get('fonts', [])}),
               'parts': sum(len(item['parts']) for item in items.values())}
        rows.append(row)
        print(path.name, coverage['status'], coverage['withDisplayGeometry'], '/', coverage['sourceRecords'], dict(counts), flush=True)
    out = output or root / 'docs/dxf-annotations'; out.mkdir(exist_ok=True)
    report = {'date': '2026-10-21', 'adapterVersion': d['adapter']['version'],
              'artifactByteProfile': 'compact UTF-8 base64 envelope via json.dumps(separators=(comma,colon)); HTTP JSON retains spaces and can be larger',
              'method': 'Same fixed 11 files and SHA256; source counts unchanged; complete means display-record coverage, Partial never counts complete. Parser-call times include validation, exclude process/browser startup and are not an end-to-end speed benchmark.',
              'summary': {'files': len(rows), 'complete': sum(row['display']['status'] == 'complete' for row in rows),
                          'partial': sum(row['display']['status'] == 'partial' for row in rows),
                          'pythonJsSpaces': sum(row['pythonJsSpaces'] for row in rows)}, 'files': rows}
    (out / 'results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    fields = ['file', 'inputBytes', 'artifactBytes', 'sourceRecords', 'withDisplayGeometry', 'withoutDisplayGeometry', 'status', 'remainingUnsupported']
    with (out / 'files.csv').open('w', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=fields); writer.writeheader()
        for row in rows:
            writer.writerow({**{key: row[key] for key in fields[:3]},
                **{key: row['display'][key] for key in fields[3:7]},
                'remainingUnsupported': json.dumps(row['display']['byReason'], ensure_ascii=False)})
    print(report['summary'])


def main():
    test_formatted_block_instances()
    texts, templates = test_attributes('acadsharp_sample_AC1009.dxf', 4, 4)
    print('AC1009 ATTRIB values', texts, 'ATTDEF templates', templates)
    texts, templates = test_attributes('dxfparser_api_cw750_details.dxf', 91, 43)
    print('cw750 ATTRIB sample', texts[:6], 'ATTDEF templates', templates)
    flange = test_dimension_without_geometry()
    print('qcad_flange dimensions', flange)
    checked = test_layer_inheritance('qcad_entities.dxf', 50)
    print('qcad_entities layer-0 block draws', checked)
    checked = test_layer_inheritance('acadsharp_sample_AC1009.dxf', 3)
    print('AC1009 layer-0 block draws', checked)
    if '--corpus' in sys.argv:
        corpus_report()
    print({'failed': len(FAILURES)})
    for failure in FAILURES:
        print('FAIL', failure)
    return 1 if FAILURES else 0


if __name__ == '__main__':
    raise SystemExit(main())
