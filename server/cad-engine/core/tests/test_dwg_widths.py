"""Native DWG width facts use the shared band algorithm, without a DXF document."""
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'vendor/ezdxf/src'))
from unified.dxf_stroke import display_parts_from_vertices
from unified.dwg_adapter import add_polyline_width_displays
from ezdxf.entities import LWPolyline
from unified.dxf_stroke import display_parts


def area(batches):
    total = 0
    for points, triangles, topology in batches:
        if topology != 'triangles': continue
        for a, b, c in triangles:
            p, q, r = points[a], points[b], points[c]
            total += abs((q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0])) / 2
    return total


class PolylineWidthTest(unittest.TestCase):
    def parts(self, stations, closed=False):
        return display_parts_from_vertices(stations, closed, 7, 64, 10000)

    def test_reversed_arrow_keeps_shaft_and_full_triangle(self):
        parts = self.parts([((0, 6000),0,0,0), ((0,0),0,240,0), ((0,900),0,0,0)])
        self.assertAlmostEqual(area(parts), 108000)
        line = next(batch for batch in parts if batch[2] == 'lines')
        self.assertEqual(line[0], [[0,6000,7],[0,0,7]])
        fill = next(batch for batch in parts if batch[2] == 'triangles')
        self.assertEqual(min(p[0] for p in fill[0]), -120)
        self.assertEqual(max(p[0] for p in fill[0]), 120)

    def test_forward_arrow_base_is_not_collapsed_by_zero_width_shaft(self):
        parts = self.parts([((0,2000),0,0,0),((0,600),160,0,0),((0,0),0,0,0)])
        self.assertAlmostEqual(area(parts),48000)
        self.assertEqual(next(b for b in parts if b[2]=='lines')[0],[[0,2000,7],[0,600,7]])

    def test_thin_band_at_large_coordinates_keeps_its_area(self):
        parts = self.parts([((923665.4077,3671834.5002),.001,.001,0),
                            ((923446.5669,3671834.5002),.001,.001,0),
                            ((923446.5669,3671399.8954),0,0,0)])
        self.assertAlmostEqual(area(parts),(.2188408+.4346048),delta=1e-6)

    def test_closed_constant_width_has_mitered_corners_and_open_center(self):
        parts = self.parts([(p,2,2,0) for p in [(0,0),(10,0),(10,20),(0,20)]], True)
        self.assertAlmostEqual(area(parts), 120)
        points = parts[0][0]
        self.assertEqual((min(p[0] for p in points),max(p[0] for p in points)),(-1,11))

    def test_bulge_direction_preserves_tapered_width_and_elevation(self):
        positive = self.parts([((0,0),2,4,1),((10,0),0,0,0)])
        negative = self.parts([((10,0),4,2,-1),((0,0),0,0,0)])
        self.assertAlmostEqual(area(positive), area(negative))
        self.assertAlmostEqual(area(positive), 15*math.pi, delta=.1)
        self.assertTrue(all(p[2] == 7 for part in positive for p in part[0]))

    def test_dxf_and_native_stations_share_results(self):
        source = [(0,0,2,4,1),(10,0,4,0,0),(20,0,0,0,0)]
        entity = LWPolyline.new(dxfattribs={'elevation':7})
        entity.set_points(source, format='xyseb')
        self.assertEqual(display_parts(entity,64,10000), self.parts([((x,y),sw,ew,b) for x,y,sw,ew,b in source]))

    def test_native_presentation_uses_band_bounds_and_retains_source_transform(self):
        transform = [0,1,0,0,-1,0,0,0,0,0,1,0,100,200,0,1]
        entity = {'geometry':{'type':'polyline','closed':False,'points':[[0,6000,7],[0,0,7],[0,900,7]],
            'widths':[[0,0],[0,240]],'bulges':[0,0]},'localFromOwner':transform,'sourceRefs':[]}
        displays, extras, binary = {'arrow':{}}, {}, bytearray()
        add_polyline_width_displays({'arrow':entity},displays,extras,binary)
        self.assertNotIn('arrow', displays)
        fill = displays['arrow-width-fill']
        self.assertEqual(fill['min'],[-120,0,7])
        self.assertEqual(fill['max'],[120,900,7])
        self.assertEqual(entity['localFromOwner'],transform)
        self.assertEqual(extras['meshPresentations']['arrow']['stroke'],'arrow-width-stroke')
        self.assertEqual(len(binary),sum(d['byteLength'] for d in displays.values()))
        self.assertEqual(fill['count'],3)


if __name__ == '__main__': unittest.main()
