"""Native DWG width facts use the shared band algorithm, without a DXF document."""
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'vendor/ezdxf/src'))
from unified.dxf_stroke import display_parts_from_vertices
from unified.dwg_adapter import add_polyline_width_displays
from ezdxf.entities import LWPolyline
from unified.dxf_stroke import display_parts, _display_parts
from ezdxf.math import Vec2


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

    def test_collinear_nonzero_width_step_keeps_arrow_base_and_shaft_length(self):
        for angle in (0, 37, 90, 180):
            with self.subTest(angle=angle):
                c, s = math.cos(math.radians(angle)), math.sin(math.radians(angle))
                def point(x, y): return (1000000+x*c-y*s, -2000000+x*s+y*c)
                parts = self.parts([(point(0,0),2,2,0), (point(0,4),10,0,0),
                                    (point(0,24),0,0,0)])
                self.assertAlmostEqual(area(parts), 108, delta=1e-7)
                points = [p for batch in parts for p in batch[0]]
                for corner in (point(-5,4), point(5,4)):
                    self.assertLess(min(math.dist(p[:2], corner) for p in points), 1e-8)

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

    def test_crossed_band_preserves_both_lobes_without_convex_hull(self):
        # This contour encloses two triangles of area 2 each; its signed area
        # cancels to zero and its convex hull has area 8. Neither is its fill.
        source = [(-2,-1),(2,1),(-2,1),(2,-1)]
        for shift in ((0,0), (1800000,850000)):
            for reverse in (False, True):
                for offset in (0, 1):
                    with self.subTest(shift=shift, reverse=reverse, offset=offset):
                        ring = source[::-1] if reverse else source[:]
                        ring = ring[offset:] + ring[:offset]
                        face = tuple(Vec2(x+shift[0],y+shift[1]) for x,y in ring)
                        class Trace:
                            def faces(self): return iter([face])
                        parts = _display_parts(Trace(),7,100)
                        self.assertAlmostEqual(area(parts),4)
                        points, triangles, kind = parts[0]
                        self.assertEqual(kind,'triangles')
                        self.assertEqual(len(triangles),2)
                        # Both lobes meet exactly at the source-edge crossing.
                        self.assertEqual(sum(p==[shift[0],shift[1],7] for p in points),2)
                        for a,b,c in triangles:
                            ys=[points[i][1]-shift[1] for i in (a,b,c)]
                            self.assertTrue(min(ys)>=0 or max(ys)<=0)

    def test_zero_width_join_retains_exact_shaft_at_large_coordinates(self):
        for angle in (0,37,90,180):
            with self.subTest(angle=angle):
                c,s=math.cos(math.radians(angle)),math.sin(math.radians(angle))
                def point(x): return (1800000+x*c,850000+x*s)
                source=[(point(1290),0,0,0),(point(0),0,80,0),(point(300),0,0,0)]
                parts=self.parts(source)
                self.assertAlmostEqual(area(parts),12000,delta=1e-5)
                self.assertEqual(next(b for b in parts if b[2]=='lines')[0],
                                 [list(point(1290))+[7],list(point(0))+[7]])

    def test_full_width_circle_at_large_coordinates_keeps_small_inner_lobes(self):
        for radius,width in ((100/3,200/3),(5,12)):
            with self.subTest(radius=radius,width=width):
                source=[((0,radius),width,width,1),((0,-radius),width,width,1)]
                shifted=[((x+1800000,y+850000),sw,ew,b) for (x,y),sw,ew,b in source]
                local=self.parts(source,True);remote=self.parts(shifted,True)
                # Community arc sampling rounds each half-circle segment count
                # upward; float angle tails may choose 32 or 33 subdivisions.
                # Check the analytic face-area bounds, not identical sampling.
                squared_radii=(radius+width/2)**2+(radius-width/2)**2
                lower=32*math.sin(math.pi/32)*squared_radii
                upper=math.pi*squared_radii
                for parts in (local,remote):
                    self.assertGreaterEqual(area(parts),lower-1e-5)
                    self.assertLessEqual(area(parts),upper+1e-5)
                for part in remote:
                    self.assertTrue(all(math.isfinite(v) for p in part[0] for v in p))

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
