"""Periodic-spline origin-pair trimming (general rule, no file/handle specifics)."""
import struct
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from unified.dwg_adapter import trim_spline_origin_pair  # noqa: E402


def row(offset, count):
    return {'offset': offset, 'byteLength': count * 24, 'count': count,
            'topology': 'lines', 'min': [0, 0, 0], 'max': [0, 0, 0]}


def spline(first_control):
    return {'geometry': {'type': 'spline', 'controlPoints': [first_control]}}


class TrimSplineOriginPairTest(unittest.TestCase):
    def test_drops_origin_pair_for_far_control_polygon(self):
        # pairs: (0,0)-(100,0), (100,0)-(101,0), (101,0)-(102,0)
        pts = [0, 0, 0, 100, 0, 0, 100, 0, 0, 101, 0, 0, 101, 0, 0, 102, 0, 0]
        buffer = struct.pack('<' + 'd' * len(pts), *pts)
        out = trim_spline_origin_pair(row(0, 6), spline([100, 0, 0]), buffer)
        self.assertEqual(out['count'], 4)
        self.assertEqual(out['offset'], 48)
        self.assertEqual(out['byteLength'], 96)
        self.assertEqual(out['min'][0], 100)

    def test_keeps_a_spline_that_starts_at_the_origin(self):
        pts = [0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 0, 0]
        buffer = struct.pack('<' + 'd' * len(pts), *pts)
        out = trim_spline_origin_pair(row(0, 4), spline([0, 0, 0]), buffer)
        self.assertEqual(out['count'], 4)
        self.assertEqual(out['offset'], 0)

    def test_ignores_non_spline_rows(self):
        buffer = struct.pack('<6d', *([0] * 6))
        out = trim_spline_origin_pair(row(0, 4), {'geometry': {'type': 'line'}}, buffer)
        self.assertEqual(out['count'], 4)


if __name__ == '__main__':
    unittest.main()
