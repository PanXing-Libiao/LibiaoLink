"""The local DWG harness must read the viewer HTML as UTF-8, not the OS locale."""
import importlib.util
from pathlib import Path
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / 'cad-engine/dev/dwg-local.py'
spec = importlib.util.spec_from_file_location('dwg_local_harness', SCRIPT)
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)


class PageEncodingTest(unittest.TestCase):
    def test_page_source_reads_utf8_and_replaces_the_platform_entry(self):
        original = Path.read_text
        encodings = []

        def spy(path, *args, **kwargs):
            encodings.append(kwargs.get('encoding'))
            return original(path, *args, **kwargs)

        with mock.patch.object(Path, 'read_text', spy):
            source = harness.page_source()
        self.assertEqual(encodings, ['utf-8'])
        self.assertIn('CAD 模型查看器', source)
        self.assertIn('/dwg-local.js', source)
        self.assertNotIn('platform-entry.js', source)


if __name__ == '__main__':
    unittest.main()
