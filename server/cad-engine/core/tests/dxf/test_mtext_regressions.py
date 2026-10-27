"""Generated layout controls: visible text, wrapping and unresolved FIELD gates."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cad_paths import CORE
import unittest

import ezdxf
from ezdxf.layouts import VirtualLayout
from unified.dxf_adapter import read_dxf
from unified.dxf_mtext import Renderer
from unified.validation import validate_envelope

FIXTURES = Path(__file__).resolve().parents[1] / 'fixtures/mtext'


def display(name):
    path = FIXTURES / name
    envelope = read_dxf(path, path.read_bytes())
    validate_envelope(envelope)
    return envelope['document']['extensions']['org.cad-preview.drawing-coverage/1']['displayGeometry']


def layout(content, width):
    doc = ezdxf.new('R2013')
    entity = doc.modelspace().add_mtext(content, dxfattribs={'char_height': 1, 'width': width})
    target = VirtualLayout()
    renderer = Renderer(target, doc)
    renderer.explode(entity, destroy=False)
    renderer.finalize()
    return [(e.dxf.text, tuple(e.dxf.insert)) for e in target.query('TEXT')]


class MTextRegressionTests(unittest.TestCase):
    def test_all_saved_counterexamples_keep_the_source_object_visible(self):
        for name in ('default-width-tab.dxf', 'default-width-tabs.dxf', 'left-tab-wrap.dxf',
                     'left-tab-unused-right-wrap.dxf', 'literal-percent-less.dxf'):
            with self.subTest(name=name):
                self.assertEqual(display(name)['withDisplayGeometry'], 1)

    def test_unbounded_tabs_advance_to_real_stops_without_wrapping(self):
        for count in (1, 3, 12):
            with self.subTest(count=count):
                cells = layout('A' + '^I' * count + 'B', 0)
                self.assertEqual([text for text, _ in cells], ['A', 'B'])
                self.assertAlmostEqual(cells[1][1][0] - cells[0][1][0], 4 * count)
                self.assertAlmostEqual(cells[1][1][1], cells[0][1][1])

    def test_unused_center_or_right_stop_does_not_change_left_field_wrapping(self):
        content = 'A^Ione two three four five six seven eight'
        expected = layout(r'\pxt4;' + content, 20)
        self.assertGreater(len({point[1] for _, point in expected}), 1)
        for unused in ('r19', 'c19'):
            with self.subTest(unused=unused):
                self.assertEqual(layout(r'\pxt4,' + unused + ';' + content, 20), expected)

    def test_complete_uncached_field_expression_remains_unsupported(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'unresolved.dxf'
            doc = ezdxf.new('R2013')
            doc.modelspace().add_mtext(r'Value: %<\AcVar Unknown>%',
                                      dxfattribs={'char_height': 1, 'width': 40})
            doc.saveas(path)
            result = read_dxf(path, path.read_bytes())
            rows = result['document']['extensions']['org.cad-preview.dxf-mtext/1']['items'].values()
            self.assertTrue(any('expression-unresolved' in row.get('reason', '') for row in rows))
            self.assertEqual(result['snapshot']['completeness'], 'partial')


if __name__ == '__main__':
    unittest.main()
