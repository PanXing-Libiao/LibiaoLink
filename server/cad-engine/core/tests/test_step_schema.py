"""STEP dispatch preserves the small-model path and rejects invalid large data."""
import copy,unittest
from unittest.mock import patch
from test_schema_v2 import fixture
from unified import validation as v
from unified.native_schema import accepts
from unified.migrate import seal

class StepSchema(unittest.TestCase):
    def small(self):
        e=copy.deepcopy(fixture())
        e['document']['adapter']['id']='occt-xde-step'
        seal(e)
        return e

    def test_small_step_does_not_load_native_validator(self):
        with patch('unified.native_schema.accepts',side_effect=AssertionError('small STEP')):
            v.validate_envelope(self.small())

    def test_large_step_does_not_skip_structure_rejection(self):
        e=self.small();e['snapshot']['draws']={str(i):{} for i in range(2048)}
        with patch('unified.native_schema.accepts',wraps=accepts) as checked:
            with self.assertRaises(v.ValidationError):v.validate_envelope(e)
            checked.assert_called_once()

    def test_non_dwg_non_step_keeps_original_path(self):
        e=self.small();e['document']['adapter']['id']='other'
        e['snapshot']['draws']={str(i):{} for i in range(2048)}
        with patch('unified.native_schema.accepts',side_effect=AssertionError('other format')):
            with self.assertRaises(v.ValidationError):v.validate_envelope(e)

if __name__=='__main__':unittest.main()
