"""Analytic pattern controls, independent of ezdxf's hatch intersection algorithm.

Temporary DXFs cover phase/scale, hole clipping, dash/dot strokes, OCS, identity,
and refusal budgets. Real-file/browser results are recorded separately.
"""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import math
import sys
import tempfile
from pathlib import Path

import ezdxf

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from unified.dxf_adapter import read_dxf
from unified.dxf_fill import boundary_paths, pattern_strokes


def hatch(doc, dashes=(), hole=False, ocs=False):
    entity = doc.modelspace().add_hatch()
    entity.set_pattern_fill('CONTROL', scale=2, definition=[
        [0, (0, .25), (0, 1), list(dashes)]])
    entity.paths.add_polyline_path([(0, 0), (10, 0), (10, 10), (0, 10)], is_closed=True, flags=1)
    if hole:
        entity.paths.add_polyline_path([(3, 3), (7, 3), (7, 7), (3, 7)], is_closed=True, flags=16)
    if ocs:
        entity.dxf.extrusion = (0, 0, -1)
        entity.dxf.elevation = (0, 0, 3)
    return entity


def strokes(entity, **options):
    rings, _ = boundary_paths(entity)
    points, segments = pattern_strokes(entity, rings, **options)
    return [(points[a], points[b]) for a, b in segments]


def real_definitions():
    # Reuse the independent ASCII group-code reader, not ezdxf's pattern API.
    from check_dxf_fill import entities, tag
    root = DATA
    checked = 0
    for path in sorted((root / 'phase_i_evidence/samples/real').glob('*.dxf')):
        envelope = read_dxf(path, path.read_bytes());drawing = envelope['document']['drawing']
        by_handle = {e['sourceRefs'][0]['objectKey']: e for e in drawing['entities'].values()
                     if e['geometry'].get('patternId')}
        for source in entities(path):
            if source['type'] != 'HATCH' or tag(source['tags'], 5) not in by_handle:continue
            lines = []
            for code, value in source['tags']:
                if code == 53:
                    lines.append({'angle': math.radians(float(value)), 'origin': [0, 0],
                                  'offset': [0, 0], 'dashes': []})
                elif lines:
                    if code in (43, 44):lines[-1]['origin'][code-43] = float(value)
                    elif code in (45, 46):lines[-1]['offset'][code-45] = float(value)
                    elif code == 49:lines[-1]['dashes'].append(float(value))
            entity = by_handle[tag(source['tags'], 5)]
            pattern = drawing['hatchPatterns'][entity['geometry']['patternId']]
            assert pattern['lines'] == lines, (path.name, tag(source['tags'], 5))
            checked += 1
    assert checked == 89, checked
    print('Real DXF patterns: %d stored definitions match independent raw tags' % checked)


def main():
    count = 0
    doc = ezdxf.new('R2000')
    entity = hatch(doc, hole=True)
    lines = strokes(entity)
    assert len(lines) == 7
    assert {round(a[1], 8) for a, b in lines} == {.5, 2.5, 4.5, 6.5, 8.5}
    assert math.isclose(sum(math.dist(a, b) for a, b in lines), 42)
    assert all(not (3 < (a[0]+b[0])/2 < 7 and 3 < a[1] < 7) for a, b in lines)
    assert lines == strokes(entity)  # no random origin displacement
    count += 5
    flipped = hatch(ezdxf.new(), hole=True, ocs=True)
    assert strokes(flipped) == [([-a[0], a[1], -3], [-b[0], b[1], -3]) for a, b in lines]
    count += 1
    # Effective scale=2 changes both a one-unit dash and its one-unit gap to 2.
    dashed = strokes(hatch(ezdxf.new(), dashes=(1, -1)))
    assert len(dashed) == 15 and all(math.isclose(math.dist(a, b), 2) for a, b in dashed)
    dotted = strokes(hatch(ezdxf.new(), dashes=(0, -1)))
    assert len(dotted) == 25 and all(a == b for a, b in dotted)
    count += 2
    degenerate = hatch(ezdxf.new(), dashes=(0, 0))
    double = hatch(ezdxf.new());double.dxf.pattern_double = 1
    for bad, reason in [(degenerate, 'hatch-pattern-degenerate-dashes'),
                        (double, 'hatch-pattern-double-unsupported')]:
        try:strokes(bad)
        except ValueError as error:assert str(error) == reason
        else:raise AssertionError('invalid pattern silently substituted')
        count += 1
    try:
        strokes(entity, max_segments=1)
    except ValueError as error:
        assert str(error) == 'hatch-pattern-segment-budget'
    else:raise AssertionError('budget published a truncated hatch')
    count += 1
    open_entity = hatch(ezdxf.new())
    open_entity.paths.paths[0].is_closed = False
    try:strokes(open_entity)
    except ValueError as error:assert str(error) == 'hatch-boundary-discontinuous'
    else:raise AssertionError('open polyline silently closed')
    count += 1
    with tempfile.TemporaryDirectory(prefix='dxf-pattern-') as folder:
        path = Path(folder) / 'control.dxf';doc.saveas(path)
        envelope = read_dxf(path, path.read_bytes())
        drawing = envelope['document']['drawing']
        source = [e for e in drawing['entities'].values() if e['geometry'].get('patternId')]
        assert len(source) == 1
        source = source[0]
        assert source['sourceRefs'][0]['objectKey'] == entity.dxf.handle
        pattern = drawing['hatchPatterns'][source['geometry']['patternId']]
        assert source['geometry']['scale'] == 1 and source['geometry']['angle'] == 0
        assert pattern['lines'] == [{'angle': 0, 'origin': [0, .5], 'offset': [0, 2], 'dashes': []}]
        draws = envelope['snapshot']['drawingProjection']['draws']
        assert len(draws) == 1 and next(iter(draws.values()))['itemId'] == source['id']
        count += 5
    print('DXF pattern controls: %d assertions passed' % count)
    if '--corpus' in sys.argv:real_definitions()


if __name__ == '__main__':main()
