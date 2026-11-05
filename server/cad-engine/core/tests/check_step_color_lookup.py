"""Compare the indexed lookup with pinned OCCT Search, including shared faces.

Synthetic XCAF controls are engineering regression checks, not STEP acceptance.
Real-file buffer/identity comparisons are recorded with the performance results.
"""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import sys
from pathlib import Path

from OCP.BRep import BRep_Builder
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.Quantity import Quantity_ColorRGBA
from OCP.TCollection import TCollection_ExtendedString, TCollection_AsciiString
from OCP.TDF import TDF_Label, TDF_Tool
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS_Compound
from OCP.TopLoc import TopLoc_Location
from OCP.gp import gp_Trsf, gp_Vec
from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ColorSurf, XCAFDoc_ColorGen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from unified.step_color_lookup import ColorLabels


def main():
    doc = TDocStd_Document(TCollection_ExtendedString('BinXCAF'))
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    ct = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    box = BRepPrimAPI_MakeBox(1, 2, 3).Shape()
    part = st.AddShape(box, False)
    faces = [];ex = TopExp_Explorer(box, TopAbs_FACE)
    while ex.More():faces.append(ex.Current());ex.Next()
    red, blue = Quantity_ColorRGBA(1, 0, 0, .5), Quantity_ColorRGBA(0, 0, 1, 1)
    ct.SetColor(st.AddSubShape(part, faces[0]), red, XCAFDoc_ColorGen)
    ct.SetColor(st.AddSubShape(part, faces[0]), blue, XCAFDoc_ColorSurf)
    ct.SetColor(st.AddSubShape(part, faces[1]), red, XCAFDoc_ColorSurf)
    # A second part sharing the same face must not change first-parent priority.
    compound = TopoDS_Compound();builder = BRep_Builder();builder.MakeCompound(compound)
    builder.Add(compound, faces[1]);builder.Add(compound, faces[2])
    second = st.AddShape(compound, False)
    ct.SetColor(st.AddSubShape(second, faces[1]), blue, XCAFDoc_ColorSurf)
    ct.SetColor(st.AddShape(faces[0], False), red, XCAFDoc_ColorSurf)
    assembly = st.NewShape();tr = gp_Trsf();tr.SetTranslation(gp_Vec(10, 0, 0))
    component = st.AddComponent(assembly, part, TopLoc_Location(tr))
    ct.SetColor(component, blue, XCAFDoc_ColorSurf)
    lookup = ColorLabels(st)

    def value(label):
        if label is None or label.IsNull():return None
        c = Quantity_ColorRGBA()
        for kind in (XCAFDoc_ColorSurf, XCAFDoc_ColorGen):
            if ct.GetColor_s(label, kind, c):
                rgb = c.GetRGB();return (rgb.Red(), rgb.Green(), rgb.Blue(), c.Alpha())
        return None

    def entry(label):
        out = TCollection_AsciiString();TDF_Tool.Entry_s(label, out);return out.ToCString()

    queries = [box, compound, st.GetShape_s(component)] + faces + [f.Reversed() for f in faces]
    queries += [f.Moved(TopLoc_Location(tr)) for f in faces]
    for shape in queries * 2:
        indexed = lookup.find(shape)
        original = TDF_Label()
        if not st.Search(shape, original):original = None
        assert value(indexed) == value(original)
        if indexed is not None and not indexed.IsNull():
            assert original is not None and entry(indexed) == entry(original)
    print('STEP color lookup: %d native comparisons passed' % (len(queries) * 2))


if __name__ == '__main__':main()
