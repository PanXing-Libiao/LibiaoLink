"""STEP surface transparency survives XDE transfer and UCD serialization."""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.TDocStd import TDocStd_Document
from OCP.TCollection import TCollection_ExtendedString
from OCP.XCAFDoc import XCAFDoc_DocumentTool,XCAFDoc_ColorSurf
from OCP.Quantity import Quantity_Color,Quantity_ColorRGBA,Quantity_TOC_RGB
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.IFSelect import IFSelect_RetDone
from unified.step_adapter import read_step

class StepRGBATests(unittest.TestCase):
    def test_native_step_transparency_is_preserved(self):
        doc=TDocStd_Document(TCollection_ExtendedString('BinXCAF'))
        shapes=XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
        colors=XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
        for index,alpha in enumerate((0.,.25,.75,1.)):
            label=shapes.AddShape(BRepPrimAPI_MakeBox(index+1,2,3).Shape(),False)
            colors.SetColor(label,Quantity_ColorRGBA(Quantity_Color(.2,.4,.6,Quantity_TOC_RGB),alpha),XCAFDoc_ColorSurf)
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'rgba.step';writer=STEPCAFControl_Writer();writer.SetColorMode(True)
            self.assertTrue(writer.Transfer(doc));self.assertEqual(writer.Write(str(path)),IFSelect_RetDone)
            self.assertIn('SURFACE_STYLE_TRANSPARENT',path.read_text())
            envelope=read_step(path)
        materials=list(envelope['document']['materials'].values())
        self.assertEqual(sorted(round(m['baseColor'][3],6) for m in materials),[0.,.25,.75,1.])
        self.assertTrue(all(m['alphaMode']==('blend' if m['baseColor'][3]<1 else 'opaque') for m in materials))
        self.assertTrue(all(m['origin']=='source' for m in materials))

if __name__=='__main__':unittest.main()
