"""Native name decoding, including a GB import followed by the UTF8 default."""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
try:
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.TDocStd import TDocStd_Document
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.XCAFDoc import XCAFDoc_DocumentTool
    from OCP.TDataStd import TDataStd_Name
    from OCP.STEPCAFControl import STEPCAFControl_Writer
    from OCP.IFSelect import IFSelect_RetDone
    from unified.step_adapter import read_step
except ModuleNotFoundError:
    HAVE_OCP = False
else:
    HAVE_OCP = True

@unittest.skipUnless(HAVE_OCP, 'OpenCASCADE (OCP) Python bindings are not installed')
class StepNameEncodingTests(unittest.TestCase):
    def test_utf8_escaped_and_explicit_gb_names_preserve_geometry(self):
        doc=TDocStd_Document(TCollection_ExtendedString('BinXCAF'))
        label=XCAFDoc_DocumentTool.ShapeTool_s(doc.Main()).AddShape(BRepPrimAPI_MakeBox(2,3,4).Shape(),False)
        TDataStd_Name.Set_s(label,TCollection_ExtendedString('NAME_ENCODING_TOKEN'))
        expected="键盘托（2格）-中文 O'Brien"
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'controlled.step';writer=STEPCAFControl_Writer();writer.SetNameMode(True)
            self.assertTrue(writer.Transfer(doc));self.assertEqual(writer.Write(str(path)),IFSelect_RetDone)
            template=path.read_bytes();self.assertIn(b'NAME_ENCODING_TOKEN',template)
            cases=[('GB',expected.replace("'","''").encode('gbk')),
                   ('UTF8',expected.replace("'","''").encode('utf-8')),
                   ('UTF8',('\\X2\\'+expected.encode('utf-16-be').hex().upper()+'\\X0\\').encode('ascii'))]
            geometries=[]
            for codepage,value in cases:
                path.write_bytes(template.replace(b'NAME_ENCODING_TOKEN',value))
                envelope=read_step(path,name_codepage=codepage) if codepage=='GB' else read_step(path)
                d=envelope['document']
                self.assertIn(expected,[p['name']['value'] for p in d['products'].values()])
                self.assertEqual(d['sources'][0]['sha256'],hashlib.sha256(path.read_bytes()).hexdigest())
                self.assertEqual(d['extensions']['org.cad-preview.step-audit/1']['nameEncoding']['codepage'],codepage)
                self.assertEqual(d['extensions']['org.cad-preview.completeness/1']['counts']['missingFaces'],0)
                geometries.append(sorted(b['sha256'] for b in d['buffers'].values()))
            self.assertEqual(geometries[0],geometries[1]);self.assertEqual(geometries[1],geometries[2])

    def test_unknown_codepage_is_rejected_before_reading_source(self):
        with self.assertRaisesRegex(ValueError,'unsupported-step-name-codepage'):
            read_step('not-read.step',name_codepage='guess')

if __name__=='__main__':unittest.main()
