"""Author the OCS/extrusion conformance fixture for check_dxf_ocs.py.

This fixture is generated, not an external sample. Every value is known from the DXF
specification, so check_dxf_ocs.py can compute the expected WCS result from raw group
codes without using the adapter under test.
"""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
from pathlib import Path

import ezdxf

OUT = DATA / 'phase_j_evidence' / 'fixtures' / 'ocs_extrusion.dxf'


def main():
    doc = ezdxf.new('R2013', setup=False)
    msp = doc.modelspace()
    extrusion = (0, 0, -1)
    # WCS entities: the extrusion vector must not move them.
    msp.add_line((1, 2, 3), (4, 6, 3), dxfattribs={'extrusion': extrusion, 'handle': '100'})
    msp.add_point((7, 8, 9), dxfattribs={'extrusion': extrusion, 'handle': '101'})
    msp.add_ellipse((0, 0, 0), major_axis=(10, 0, 0), ratio=0.5,
                    dxfattribs={'extrusion': extrusion, 'handle': '102'})
    msp.add_polyline3d([(1, 2, 3), (4, 5, 6), (7, 8, 9)],
                       dxfattribs={'extrusion': extrusion, 'handle': '103'})
    # OCS entities: coordinates are stored in the OCS plane.
    msp.add_circle((10, 0), 5, dxfattribs={'extrusion': extrusion, 'handle': '104'})
    msp.add_arc((12, 3), 4, 0, 90, dxfattribs={'extrusion': extrusion, 'handle': '105'})
    msp.add_lwpolyline([(0, 0), (4, 0), (4, 3), (0, 3)], close=True,
                       dxfattribs={'extrusion': extrusion, 'elevation': 3, 'handle': '106'})
    msp.add_solid([(1, 1), (6, 1), (1, 4), (6, 4)],
                  dxfattribs={'extrusion': extrusion, 'handle': '107'})
    # Solid hatches: one even-odd with a hole, one style-1 single ring, one style-1
    # multipath (must be refused, see the check script).
    hole = msp.add_hatch(dxfattribs={'extrusion': extrusion, 'handle': '108',
                                    'hatch_style': 0})
    hole.set_solid_fill(color=2, style=0)
    hole.paths.add_polyline_path([(0, 0), (10, 0), (10, 10), (0, 10)], is_closed=True)
    hole.paths.add_polyline_path([(3, 3), (7, 3), (7, 7), (3, 7)], is_closed=True)
    single = msp.add_hatch(dxfattribs={'extrusion': extrusion, 'handle': '109',
                                      'hatch_style': 1})
    single.set_solid_fill(color=3, style=1)
    single.paths.add_polyline_path([(20, 0), (26, 0), (26, 4), (20, 4)], is_closed=True)
    multi = msp.add_hatch(dxfattribs={'extrusion': extrusion, 'handle': '10A',
                                     'hatch_style': 1})
    multi.set_solid_fill(color=4, style=1)
    # Both paths intentionally lack EXTERNAL/OUTERMOST flags: style 1 cannot select
    # an outer boundary from them, so the product must refuse instead of guessing.
    multi.paths.add_polyline_path([(30, 0), (40, 0), (40, 10), (30, 10)], is_closed=True,
                                  flags=0)
    multi.paths.add_polyline_path([(33, 3), (37, 3), (37, 7), (33, 7)], is_closed=True,
                                  flags=0)
    # Pattern hatch must stay unsupported.
    pattern = msp.add_hatch(dxfattribs={'extrusion': extrusion, 'handle': '10B',
                                       'hatch_style': 0})
    pattern.set_pattern_fill('ANSI31', scale=1.0, color=5)
    pattern.dxf.hatch_style = 0
    pattern.paths.add_polyline_path([(50, 0), (60, 0), (60, 10), (50, 10)], is_closed=True)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc.saveas(OUT)
    print('wrote', OUT)


if __name__ == '__main__':
    main()
