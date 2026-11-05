"""Native DWG XLINE/RAY parameters must reuse the view-dependent infinite
presentation contract; zero/non-finite parameters must never fabricate a line."""
import sys
from pathlib import Path
import unittest

CORE = Path(__file__).resolve().parents[1] / 'cad-engine/core'
sys.path.insert(0, str(CORE))
from unified.dwg_adapter import infinite_presentation_items


def entity(**overrides):
    row = {'layerId': 'layer-10', 'style': {'color': {'mode': 'by-layer'}, 'plot': True},
           'sourceRefs': [{'sourceId': 'source-0', 'objectKey': '738AAE'}]}
    row.update(overrides)
    return row


class InfinitePresentationTest(unittest.TestCase):
    def test_xline_and_ray_keep_origin_and_direction(self):
        rows = {
            'entity-738AAE': {'kind': 'xline', 'origin': [643784.0, 43284.0, 0.0],
                              'direction': [0.0, 1.0, 0.0],
                              'sourceRefs': [{'sourceId': 'source-0', 'objectKey': '738AAE'}]},
            'entity-38A': {'kind': 'ray', 'origin': [1.0, 2.0, 0.0],
                           'direction': [1.0, 0.0, 0.0]},
        }
        items = infinite_presentation_items(rows, {
            'entity-738AAE': entity(), 'entity-38A': entity(objectKey='38A')})
        self.assertEqual(set(items), {'entity-738AAE', 'entity-38A'})
        xline = items['entity-738AAE']
        self.assertEqual((xline['status'], xline['sourceKind'], xline['mode']),
                         ('ready', 'XLINE', 'view-dependent'))
        part = xline['parts'][0]
        self.assertEqual(part['role'], 'infinite')
        self.assertEqual(part['line'], {'kind': 'xline',
            'origin': [643784.0, 43284.0, 0.0], 'direction': [0.0, 1.0, 0.0]})
        self.assertEqual(part['layerId'], 'layer-10')
        self.assertEqual(items['entity-38A']['sourceKind'], 'RAY')
        self.assertEqual(items['entity-38A']['parts'][0]['line']['kind'], 'ray')

    def test_invalid_or_unowned_lines_are_dropped(self):
        rows = {
            'zero': {'kind': 'xline', 'origin': [0, 0, 0], 'direction': [0, 0, 0]},
            'nan': {'kind': 'xline', 'origin': [0, 0, 0], 'direction': [float('nan'), 1, 0]},
            'missing': {'kind': 'xline', 'origin': [0, 0, 0], 'direction': [1, 0, 0]},
            'short': {'kind': 'ray', 'origin': [0, 0, 0], 'direction': [1]},
        }
        entities = {key: entity() for key in ('zero', 'nan', 'short')}
        self.assertEqual(infinite_presentation_items(rows, entities), {})


if __name__ == '__main__':
    unittest.main()
