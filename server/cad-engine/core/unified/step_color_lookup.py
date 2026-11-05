"""Index the unlocated-face branch of OCCT V7_8_1 ShapeTool::Search.

Source: src/XCAFDoc/XCAFDoc_ShapeTool.cxx, FindShape/FindMainShape/AddSubShape.
Only identity-located faces take the index. Located shapes retain OCCT's full
instance/component search, and Surf-before-Gen is still resolved by ColorTool.
The document's top-level shape structure is immutable after STEP Transfer.
"""


class ColorLabels:
    def __init__(self, shape_tool):
        self.tool = shape_tool
        self.top = self.main = None
        self.labels = []

    def _index(self):
        from OCP.TDF import TDF_ChildIterator, TDF_ChildIDIterator
        from OCP.TNaming import TNaming_NamedShape, TNaming_Tool
        from OCP.TopTools import TopTools_DataMapOfShapeInteger
        from OCP.TopAbs import TopAbs_FACE
        from OCP.TopExp import TopExp_Explorer
        self.top, self.main = TopTools_DataMapOfShapeInteger(), TopTools_DataMapOfShapeInteger()
        # Match FindShape's fallback iterator and first-IsSame priority exactly.
        named = TDF_ChildIDIterator(self.tool.Label(), TNaming_NamedShape.GetID_s())
        while named.More():
            attribute = named.Value();label = attribute.Label()
            shape = TNaming_Tool.GetShape_s(attribute)
            if not shape.IsNull() and shape.ShapeType() == TopAbs_FACE and not self.top.IsBound(shape):
                self.labels.append(label);self.top.Bind(shape, len(self.labels))
            named.Next()
        # Match FindMainShape's first containing simple root. OCCT's shape-map
        # key uses IsSame (location included, orientation ignored), not Python ==.
        roots = TDF_ChildIterator(self.tool.Label())
        while roots.More():
            label = roots.Value();roots.Next()
            if not self.tool.IsSimpleShape_s(label):continue
            self.labels.append(label);index = len(self.labels)
            faces = TopExp_Explorer(self.tool.GetShape_s(label), TopAbs_FACE)
            while faces.More():
                face = faces.Current();faces.Next()
                if not self.main.IsBound(face):self.main.Bind(face, index)

    def find(self, shape):
        from OCP.TDF import TDF_Label
        from OCP.TNaming import TNaming_Tool
        from OCP.TopAbs import TopAbs_FACE
        label = TDF_Label()
        if shape.ShapeType() != TopAbs_FACE or not shape.Location().IsIdentity():
            return label if self.tool.Search(shape, label) else None
        # Without a named shape, Search can only create a new, colourless
        # subshape label. It cannot discover a source colour on that new label.
        if not TNaming_Tool.HasLabel_s(self.tool.Label(), shape):return None
        label = TNaming_Tool.Label_s(self.tool.Label(), shape, 0)
        if self.tool.IsTopLevel(label):return label
        if self.main is None:self._index()
        if self.top.IsBound(shape):return self.labels[self.top.Find(shape)-1]
        if not self.main.IsBound(shape):return None
        # Still use OCCT to resolve duplicate subshape labels under the selected
        # parent; do not replace it with an arbitrary shape->label dictionary.
        return self.tool.AddSubShape(self.labels[self.main.Find(shape)-1], shape)
