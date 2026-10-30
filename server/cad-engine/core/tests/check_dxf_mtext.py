"""Targeted layout/cache/identity checks. Generated controls are not real drawings."""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import hashlib
import json
import math
from pathlib import Path
import sys
import tempfile

APP = Path(__file__).resolve().parents[1]
ROOT = DATA
sys.path.insert(0, str(APP))
import ezdxf
from ezdxf.addons.mtxpl import MTextExplode
from ezdxf.entities import DXFTagStorage
from ezdxf.layouts import VirtualLayout
from ezdxf.lldxf.extendedtags import ExtendedTags
from ezdxf.lldxf.types import DXFTag

from unified.dxf_adapter import read_dxf
from unified.dxf_mtext import Renderer, Resources, EXTENSION, field_info
from unified.validation import validate_envelope

OUT = ROOT / 'docs/dxf-mtext'
CONTROL = OUT / 'controls'
ORIGINAL = OUT / 'originals/ezdxf/mtext_complex_inline_codes.dxf'
STYLE = {'style': 'Arial', 'char_height': 2, 'width': 80}


def doc():
    d = ezdxf.new('R2013'); d.units = 4
    d.styles.new('Arial', dxfattribs={'font': 'Arial.ttf'})
    return d


def leaves(content, renderer=Renderer, height=1, width=80):
    d = doc(); e = d.modelspace().add_mtext(content, dxfattribs={**STYLE, 'char_height': height, 'width': width})
    target = VirtualLayout(); r = renderer(target, d)
    r.explode(e, destroy=False); r.finalize()
    return list(target.query('TEXT')), r


def source_field(d, entity, template, cache, evaluator='_text', children=()):
    dictionary = d.objects.add_dictionary(owner=entity.new_extension_dict().dictionary.dxf.handle)
    entity.extension_dict['ACAD_FIELD'] = dictionary
    # Source-owned typed FIELD cache, serialized as DXF tags through the pinned reader.
    text = ('0\nFIELD\n100\nAcDbField\n1\n' + evaluator + '\n2\n' + template + '\n90\n' + str(len(children)) + '\n')
    for handle in children: text += '360\n' + handle + '\n'
    text += '97\n0\n91\n63\n92\n0\n94\n41\n95\n2\n96\n0\n300\n\n93\n0\n'
    if cache is not None:
        text += '7\nACFD_FIELD_VALUE\n93\n0\n90\n4\n1\n' + cache + '\n94\n0\n300\nstatic\n302\n\n304\nACVALUE_END\n'
    field = DXFTagStorage.load(ExtendedTags.from_text(text), d)
    d.entitydb.add(field); d.objects.add_object(field); field.dxf.owner = dictionary.dxf.handle
    dictionary['TEXT'] = field
    return field


def controls():
    CONTROL.mkdir(exist_ok=True)
    normal, renderer = leaves('AV')
    tracked, _ = leaves(r'{\T1.5;AV}')
    # Same resolved ezdxf font as the emitted text style, not a browser font measurement.
    font = renderer.get_font(renderer.make_mtext_context(renderer._doc.modelspace().query('MTEXT').first))
    origin = font.text_width('AV') - font.text_width('V')
    assert len(tracked) == 2 and tracked[0].dxf.text == 'A' and tracked[1].dxf.text == 'V'
    assert math.isclose(tracked[1].dxf.insert.x, 1.5 * origin, abs_tol=1e-8)
    assert tracked[0].dxf.height == normal[0].dxf.height and tracked[0].dxf.width == normal[0].dxf.width
    relative, _ = leaves(r'{\T2;\T.75x;AV}')
    assert [list(e.dxf.insert) for e in relative] == [list(e.dxf.insert) for e in tracked]
    spaced, _ = leaves(r'{\T2;A B}')
    assert spaced[1].dxf.insert.x > tracked[1].dxf.insert.x
    left, _ = leaves('A^I^I^IB', height=2)
    assert math.isclose(left[1].dxf.insert.x, 24, abs_tol=1e-8)
    old_left, _ = leaves('A^I^I^IB', renderer=MTextExplode, height=2)
    assert old_left[1].dxf.insert.x != left[1].dxf.insert.x
    right, _ = leaves(r'\pxtr20;A^Itwo words')
    right_end = right[-1].dxf.insert.x + font.text_width(right[-1].dxf.text)
    assert math.isclose(right_end, 20, abs_tol=1e-8)
    center, _ = leaves(r'\pxtc20;A^Itwo words')
    center_end = center[-1].dxf.insert.x + font.text_width(center[-1].dxf.text)
    assert math.isclose((center[1].dxf.insert.x + center_end) / 2, 20, abs_tol=1e-8)
    from types import SimpleNamespace
    from unified.dxf_shx import Resources as ShxResources
    shape_doc = doc(); shape_doc.styles.new('Uploaded', dxfattribs={'font': 'iso3098.shx'})
    shape_mtext = shape_doc.modelspace().add_mtext(r'\T2;AV', dxfattribs={**STYLE, 'style': 'Uploaded'})
    refs = [{'sourceId': 'source-control', 'objectKey': shape_mtext.dxf.handle}]
    xrefs = SimpleNamespace(sources={'source-control': {'id': 'source-control'}}, origins={}, name='control.dxf')
    shx = ShxResources(shape_doc, xrefs, {'iso3098.shx': (ROOT / 'docs/dxf-shx/originals/ezdxf/iso3098.shx').read_bytes()})
    target = VirtualLayout(); renderer = shx.mtext_renderer(target, shape_mtext, refs)
    shape_font = renderer.get_font(renderer.make_mtext_context(shape_mtext))
    renderer.explode(shape_mtext, destroy=False); renderer.finalize(); shape_leaves = list(target.query('TEXT'))
    assert len(shape_leaves) == 2 and math.isclose(shape_leaves[1].dxf.insert.x, 2 * shape_font.text_width('A'), abs_tol=1e-8)
    d = doc()
    for name, color in [('Tracking', 1), ('Tabs', 3), ('Cached field', 5), ('Unresolved', 6)]:
        d.layers.new(name, dxfattribs={'color': color})
    d.modelspace().add_mtext(r'Normal AV 123\P{\T1.5;Tracked AV 123}\P{\W1.5;\T.8;Wide glyphs, tighter tracking}',
        dxfattribs={**STYLE, 'layer': 'Tracking', 'insert': (0, 35)})
    d.modelspace().add_mtext('A^I^I^IB\\P1.^Iitem one\\P2.^Iitem two',
        dxfattribs={**STYLE, 'layer': 'Tabs', 'insert': (0, 15)})
    d.modelspace().add_mtext(r'\pxtr12,c26;A^Iright field^Icenter field',
        dxfattribs={**STYLE, 'layer': 'Tabs', 'insert': (0, -5)})
    cached = d.modelspace().add_mtext('Saved result: 42.00', dxfattribs={**STYLE, 'layer': 'Cached field', 'insert': (0, -15)})
    field = source_field(d, cached, r'Saved result: %<\_FldIdx 0>%', cached.text)
    # Record a real child evaluator, but never execute its expression.
    child_template = r'\AcExpr (6*7)'; child = DXFTagStorage.load(ExtendedTags.from_text(
        '0\nFIELD\n100\nAcDbField\n1\nAcExpr\n2\n' + child_template + '\n90\n0\n97\n0\n'), d)
    d.entitydb.add(child); d.objects.add_object(child); child.dxf.owner = field.dxf.handle
    tags = field.xtags.get_subclass('AcDbField'); at = next(i for i,t in enumerate(tags) if t.code == 90)
    tags[at] = DXFTag(90, 1); tags.insert(at + 1, DXFTag(360, child.dxf.handle))
    unresolved = d.modelspace().add_mtext(r'No saved result: %<\AcVar Unknown>%',
        dxfattribs={**STYLE, 'layer': 'Unresolved', 'insert': (0, -25)})
    d.layouts.get('Layout1').add_mtext('Sheet^I^Icolumn', dxfattribs={**STYLE, 'layer': 'Tabs'})
    d.saveas(CONTROL / 'mtext_features.dxf')
    main = (CONTROL / 'mtext_features.dxf').read_bytes()
    e = read_dxf(CONTROL / 'mtext_features.dxf', main); validate_envelope(e)
    extension = e['document']['extensions'][EXTENSION]
    assert e['snapshot']['completeness'] == 'partial'
    assert extension['coverage']['cachedFieldLayouts'] == 1 and extension['coverage']['dynamicEvaluationsUnsupported'] == 1
    assert extension['coverage']['missingObjects'] == 1
    assert any(r['sourceRefs'][0]['objectKey'] == unresolved.dxf.handle and 'expression-unresolved' in r['reason'] for r in extension['items'].values())
    with tempfile.TemporaryDirectory() as folder:
        p = Path(folder) / 'case.dxf'
        def parse(current):
            current.saveas(p)
            result = read_dxf(p, p.read_bytes()); validate_envelope(result)
            return result['document']['extensions'][EXTENSION]
        for content, reason in [(r'\T0;bad', 'tracking-nonpositive'), (r'\T-1;bad', 'tracking-nonpositive'),
                                (r'\pxqc;A^IB', 'tab-paragraph-alignment'), (r'\pxt4;A^IB^IC', 'tab-stop-exhausted')]:
            current = doc(); current.modelspace().add_mtext(content, dxfattribs=STYLE)
            assert any(reason in row['reason'] for row in parse(current)['items'].values())
        current = doc(); m = current.modelspace().add_mtext(r'Template %<\_FldIdx 0>%', dxfattribs=STYLE)
        f = source_field(current, m, m.text, 'Cached 123')
        result = parse(current); row = next(iter(result['items'].values()))
        assert row['displayText'] == 'Cached 123' and row['rawText'] == m.text
        assert row['fields']['objects'][0]['sourceRefs'][0]['objectKey'] == f.dxf.handle
        from types import SimpleNamespace
        virtual = m.copy(); virtual.translate(100, 0, 0)
        prepared, derived = Resources(SimpleNamespace(origins={})).prepare(virtual,
            [{'sourceId': 'source-test', 'objectKey': 'TABLE-parent'}], {'itemId': 'table-parent'})
        assert prepared.text == 'Cached 123' and prepared.dxf.insert.x == 100
        assert derived['fields']['objects'][0]['sourceRefs'][0]['objectKey'] == f.dxf.handle
        assert derived['mtextSourceRefs'][0]['objectKey'] == m.dxf.handle
        renamed = read_dxf(p, p.read_bytes(), name='different-name.dxf')
        assert next(iter(renamed['document']['extensions'][EXTENSION]['items'].values()))['displayText'] == 'Cached 123'
        for cache, reason in [(None, 'text-cache-missing'), ('different text', 'cache-source-conflict')]:
            bad = doc(); text = bad.modelspace().add_mtext('Saved', dxfattribs=STYLE)
            source_field(bad, text, 'Template', cache)
            assert any(reason in row['reason'] for row in parse(bad)['items'].values())
        current.saveas(p)
        child_raw = p.read_bytes()
        from ezdxf import xref
        host = doc(); xref.define(host, 'CHILD', 'child.dxf'); host.modelspace().add_blockref('CHILD', (100, 0))
        hp = Path(folder) / 'host.dxf'; host.saveas(hp)
        imported = read_dxf(hp, hp.read_bytes(), resources={'child.dxf': child_raw}); validate_envelope(imported)
        child_row = next(iter(imported['document']['extensions'][EXTENSION]['items'].values()))
        assert child_row['status'] == 'ready' and child_row['chain']
        assert child_row['fields']['objects'][0]['sourceRefs'][0]['sourceId'] == 'source-' + hashlib.sha256(child_raw).hexdigest()
        assert child_row['fields']['objects'][0]['sourceRefs'][0]['objectKey'] == f.dxf.handle
        f.xtags.get_subclass('AcDbField').append(DXFTag(360, f.dxf.handle))
        tags = f.xtags.get_subclass('AcDbField'); at = next(i for i,t in enumerate(tags) if t.code == 90); tags[at] = DXFTag(90, 1)
        assert field_info(m, 'source-test')['status'] == 'missing'
    return {'trackingGlyphsAndAdvances': True, 'relativeTracking': True, 'trackedSpaces': True,
        'consecutiveDefaultTabs': True, 'rightAndCenterWholeFields': True,
        'unsupportedTrackingAndTabsCounted': True, 'cachedFieldIdentity': True,
        'cachedTemplateAndRename': True, 'unresolvedExpressionsCounted': True, 'fieldCyclesRefused': True,
        'xrefFieldProvenance': True, 'virtualMtextFieldProvenance': True, 'uploadedShxTracking': True,
        'missingAndConflictingFieldCachesRefused': True, 'generatedControlSchema': True}


def originals():
    rows = []
    for p in [ORIGINAL, ROOT / 'phase_i_evidence/samples/real/dxfparser_api_cw750_details.dxf']:
        raw = p.read_bytes(); e = read_dxf(p, raw); validate_envelope(e)
        ext = e['document']['extensions'][EXTENSION]
        rows.append({'file': p.name, 'sha256': hashlib.sha256(raw).hexdigest(), 'inputBytes': len(raw),
            'display': e['document']['extensions']['org.cad-preview.drawing-coverage/1']['displayGeometry'],
            'overall': e['snapshot']['completeness'], 'mtext': ext})
    assert rows[0]['mtext']['coverage']['cachedFieldLayouts'] == 8
    assert rows[0]['display']['withDisplayGeometry'] == 12 and rows[0]['overall'] == 'partial'
    assert rows[1]['mtext']['coverage']['tabLayouts'] == 1 and rows[1]['display']['withDisplayGeometry'] == 4576
    return rows


if __name__ == '__main__':
    checks = controls(); files = originals()
    control = CONTROL / 'mtext_features.dxf'
    control_doc = ezdxf.readfile(control)
    (OUT / 'parser.json').write_text(json.dumps({'date': '2026-10-23', 'viewerVersion': '0.8.0',
        'controls': checks, 'originalFiles': files,
        'generatedControl': {'file': control.name, 'sha256': hashlib.sha256(control.read_bytes()).hexdigest(),
            'inputBytes': control.stat().st_size,
            'handles': {e.dxf.layer: str(e.dxf.handle) for e in control_doc.modelspace().query('MTEXT')}},
        'controlClassification': 'Generated controls kept separate from unchanged upstream originals'}, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'controls': checks, 'unchangedOriginalFiles': len(files)}))
