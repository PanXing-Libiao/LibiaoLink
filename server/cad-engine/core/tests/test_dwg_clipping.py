"""Native boundary coordinates feed the existing common clipping contract."""
import unittest
from unified.dwg_adapter import native_block_clip, IDENTITY


def clip(**changes):
    row = dict(enabled=True, inverted=False, front=False, back=False, normal=[0,0,1],
               origin=[0,0,0], clipTransform=IDENTITY, inverseInsert=IDENTITY,
               boundary=[[0,0],[4,2]])
    row.update(changes)
    return row


class NativeClipTest(unittest.TestCase):
    def test_rectangle_expands_before_rotated_inverse_transform(self):
        m=[0,1,0,0,-1,0,0,0,0,0,1,0,10,20,0,1]
        self.assertEqual(native_block_clip(clip(inverseInsert=m)),
            {'boundary':[[10,20],[10,24],[8,24],[8,20]],'inverted':False})

    def test_polygon_keeps_concavity_and_source_input(self):
        points=[[0,0],[4,0],[4,4],[2,1],[0,4],[0,0]]
        self.assertEqual(native_block_clip(clip(boundary=points))['boundary'],points[:-1])
        self.assertEqual(len(points),6)

    def test_disabled_clip_does_not_require_supported_shape(self):
        self.assertIsNone(native_block_clip(clip(enabled=False,inverted=True,boundary=[])))

    def test_unsupported_and_degenerate_clips_are_explicit(self):
        for fields in [{'inverted':True},{'front':True},{'back':True},
                       {'normal':[1,0,0]},{'boundary':[[0,0],[0,0]]}]:
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                native_block_clip(clip(**fields))
