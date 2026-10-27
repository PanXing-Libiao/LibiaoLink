import io
import unittest
from pathlib import Path
from test_fonts_layout_xref import ezdxf,raw_doc
from unified.dxf_adapter import read_dxf


class GradientSourceTest(unittest.TestCase):
    def test_shift_and_original_stops_survive_ascii_newlines_and_binary_dxf(self):
        doc=ezdxf.new('R2013');hatch=doc.modelspace().add_hatch()
        hatch.set_gradient(color1=(10,20,30),color2=(200,210,220),centered=1,name='SPHERICAL')
        hatch.paths.add_polyline_path([(0,0),(10,0),(10,10),(0,10)],is_closed=True,flags=1)
        raw=raw_doc(doc);binary=io.BytesIO();doc.write(binary,fmt='bin')
        for data in (raw,raw.replace(b'\n',b'\r\n'),binary.getvalue()):
            result=read_dxf(Path('source-bytes.dxf'),data)
            fills=result['document']['extensions']['org.cad-preview.fill/1']['fills']
            gradient=next(iter(fills.values()))['gradient']
            self.assertEqual(gradient['colors'],[[10,20,30],[200,210,220]])
            self.assertEqual(gradient['shift'],1)
            self.assertEqual(result['snapshot']['completeness'],'complete')


if __name__=='__main__':unittest.main()
