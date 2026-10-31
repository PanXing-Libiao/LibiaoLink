"""DWG native schema parity and retained semantic/security checks."""
import copy
import unittest
from unittest.mock import patch
from test_schema_v2 import fixture
from test_schema import drawing_fixture
from unified import validation as v
from unified.native_schema import accepts, _validator
from unified.migrate import seal


def dwg_fixture():
    e = copy.deepcopy(drawing_fixture(fixture()))
    e['document']['extensions']['org.libiaolink.dwg/1'] = {}
    seal(e)
    return e


class DwgSchema(unittest.TestCase):
    def test_valid_uses_native_without_mutating(self):
        e = dwg_fixture()
        before = copy.deepcopy(e)
        with patch.object(v, 'shape', side_effect=AssertionError('legacy walk')):
            v._envelope_shape(e, v.SCHEMA_V2)
        self.assertEqual(e, before)
        self.assertIs(_validator(), _validator())
        v.validate_envelope(e)

    def test_invalid_structure_preserves_legacy_error(self):
        edits = [
            lambda e: e.pop('presentation'),
            lambda e: e['document']['sources'][0].update(byteLength=1.0),
            lambda e: e['document']['sources'][0].update(byteLength=True),
            lambda e: e['document']['sources'][0].update(sha256='bad'),
            lambda e: e['document']['extensions'].update(extra={'x':[float('inf')]}),
            lambda e: e['document']['extensions'].update(extra={'x':[float('nan')]}),
            lambda e: e['document']['drawing']['drawings']['D']['units'].update(value='mm'),
            lambda e: e['document']['drawing']['entities']['E']['geometry'].update(type='unknown'),
            lambda e: e['document']['drawing']['entities']['E']['localFromOwner'].pop(),
        ]
        for edit in edits:
            with self.subTest(edit=edits.index(edit)):
                e = dwg_fixture()
                edit(e)
                with self.assertRaises(v.ValidationError) as legacy:
                    v.shape(e, v.SCHEMA_V2['$defs']['Envelope'], root_schema=v.SCHEMA_V2)
                self.assertFalse(accepts(e))
                with self.assertRaises(v.ValidationError) as native:
                    v._envelope_shape(e, v.SCHEMA_V2)
                self.assertEqual((native.exception.code, native.exception.path, native.exception.message),
                                 (legacy.exception.code, legacy.exception.path, legacy.exception.message))

    def test_python_pattern_keeps_trailing_newline_semantics(self):
        e = dwg_fixture()
        e['document']['sources'][0]['sha256'] = 'a'*64+'\n'
        # If length bounds reject this, both paths must reject it; otherwise
        # Python's dollar-anchor behaviour must remain unchanged.
        try:
            v.shape(e, v.SCHEMA_V2['$defs']['Envelope'], root_schema=v.SCHEMA_V2)
            legacy = True
        except v.ValidationError:
            legacy = False
        self.assertEqual(accepts(e), legacy)

    def test_semantic_reference_and_revision_checks_remain(self):
        for edit in [lambda e: e['document']['drawing']['entities']['E'].update(layerId='missing'),
                     lambda e: e['snapshot']['selection'].update(viewContextId='missing')]:
            e = dwg_fixture()
            edit(e)
            seal(e)
            self.assertTrue(accepts(e))
            with self.assertRaises(v.ValidationError):
                v.validate_envelope(e)
        e = dwg_fixture()
        e['document']['revision'] = '0'*64
        with self.assertRaises(v.ValidationError):
            v.validate_envelope(e)

    def test_binary_hash_and_decoded_budget_remain(self):
        import hashlib
        e = dwg_fixture()
        raw = b'1234'
        e['document']['buffers']['b'] = {
            'id':'b', 'sha256':hashlib.sha256(raw).hexdigest(), 'byteLength':4,
            'endianness':'little', 'alignment':1,
            'storage':{'kind':'resource', 'resourceId':'b'},
        }
        seal(e)
        self.assertTrue(accepts(e))
        args = (e['document'], e['snapshot'], e['presentation'])
        for blob in (b'xxxx', b'123'):
            with self.assertRaises(v.ValidationError) as error:
                v.validate_binary_envelope(*args, lambda key:blob)
            self.assertEqual(error.exception.code, 'invalid-buffer')
        with self.assertRaises(v.ValidationError) as error:
            v.validate_binary_envelope(*args, lambda key:raw, max_decoded=3)
        self.assertEqual(error.exception.code, 'limit-exceeded')

    def test_other_formats_keep_original_path(self):
        with patch('unified.native_schema.accepts', side_effect=AssertionError('DWG only')):
            v.validate_envelope(fixture())

    def test_native_rejection_never_bypassed(self):
        with patch('unified.native_schema.accepts', return_value=False):
            with self.assertRaises(v.ValidationError):
                v._envelope_shape(dwg_fixture(), v.SCHEMA_V2)


if __name__ == '__main__':
    unittest.main()
