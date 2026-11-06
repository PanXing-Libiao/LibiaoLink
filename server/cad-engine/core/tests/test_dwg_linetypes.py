"""Native short paths use the shared CAD linetype fitting rule."""
import copy
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from unified.dwg_adapter import add_short_linetype_displays


class ShortLinetypeTest(unittest.TestCase):
    def fixture(self, continuous=False, scale=1, width=30):
        vertices = [{'point': p, 'bulge': 0} for p in ((0,0),(width,0),(width,10),(0,10))]
        entities = {'e': {'geometry': {'type':'polyline','widths':[[0,0]]*4},
                          'style': {'lineTypeId':'dashed'}}}
        line_types = {'solid': {'name':'Continuous'}, 'dashed': {'name':'Example',
            'segments':[{'kind':'dash','length':28},{'kind':'gap','length':12}]}}
        displays = {'e': {'offset':0,'count':8,'topology':'lines'}}
        extras = {'nativeLineTypeSettings': {'drawing-dwg': {'scale':scale}},
            'nativeLineTypes': {'dashed': {'alignment':'A','complex':False}},
            'nativeGeometry': {'e': {'vertices':vertices,'closed':True,'elevation':0,
                                    'lineTypeContinuous':continuous}}}
        return entities, line_types, displays, extras

    def test_short_edges_keep_source_geometry_and_use_solid_presentation(self):
        args = self.fixture(); before = copy.deepcopy(args[0]); source = dict(args[2]['e'])
        add_short_linetype_displays(*args)
        self.assertEqual(args[0], before)
        self.assertEqual(args[2]['e-short-linetype'], source)
        self.assertEqual(args[3]['meshPresentations']['e']['lineTypeId'], 'solid')

    def test_continuous_long_or_small_scale_paths_keep_the_pattern(self):
        for kwargs in ({'continuous':True}, {'width':60}, {'scale':.1}):
            with self.subTest(**kwargs):
                args = self.fixture(**kwargs); add_short_linetype_displays(*args)
                self.assertNotIn('meshPresentations', args[3])
                self.assertIn('e', args[2])

    def test_global_and_entity_scales_control_short_path_fitting(self):
        args = self.fixture(continuous=True, scale=4)
        add_short_linetype_displays(*args)
        self.assertIn('meshPresentations', args[3])
        args = self.fixture(continuous=True)
        args[3]['entityState'] = {'e': {'lineTypeScale':4}}
        add_short_linetype_displays(*args)
        self.assertIn('meshPresentations', args[3])

    def test_complex_or_unknown_polyline_generation_is_not_assumed(self):
        for field in ('complex', 'generation'):
            args = self.fixture()
            if field == 'complex': args[3]['nativeLineTypes']['dashed']['complex'] = True
            else: del args[3]['nativeGeometry']['e']['lineTypeContinuous']
            add_short_linetype_displays(*args)
            self.assertNotIn('meshPresentations', args[3])


if __name__ == '__main__': unittest.main()
