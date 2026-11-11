import struct
import unittest

from unified.dwg_curve_columns import encode_curve_columns


class CurveColumnsTest(unittest.TestCase):
    def test_budget_and_exact_coordinates_in_both_arc_frames(self):
        arc = 'entity-FFFFFFFFFFFFFFFF'
        line = 'entity-FFFFFFFFFFFFFFFE'
        document = {
            'drawing': {'entities': {
                arc: {'geometry': {'type': 'arc', 'center': [-6, 2, 1], 'normal': [0, 1, 0],
                                   'xAxis': [-1, 0, 0], 'radius': 5, 'startAngle': -1, 'sweepAngle': 2}},
                line: {'geometry': {'type': 'line', 'start': [8, 5, 0], 'end': [9, 6, 0]}},
                'entity-1': {'geometry': {'type': 'line', 'start': [1, 0, 0], 'end': [2, 0, 0]}},
            }},
            'extensions': {'org.libiaolink.dwg/1': {'nativeGeometry': {
                arc: {'type': 'arc', 'center': [6, 1, 2], 'normal': [0, 2, 0],
                      'radius': 5, 'startAngle': -1, 'endAngle': 1},
            }}},
        }
        size = 40 + 2 * 56 + 176
        source = 'ab' * 32
        self.assertIsNone(encode_curve_columns(document, source, size - 1))
        raw = encode_curve_columns(document, source, size)
        self.assertEqual(raw[:32], bytes.fromhex(source))
        self.assertEqual(struct.unpack_from('<II2Q', raw, 32), (2, 1, 1, 2**64-2))
        self.assertEqual(struct.unpack_from('<12d', raw, 56), (1,0,0,2,0,0,8,5,0,9,6,0))
        self.assertEqual(struct.unpack_from('<Q21d', raw, 152),
                         (2**64-1, -6,2,1, 0,1,0, -1,0,0, 5,-1,2, 6,1,2, 0,2,0, 5,-1,1))
