"""A source/dependency change must invalidate the CAD release and stale checks."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'cad-engine/build-release.py'
spec = importlib.util.spec_from_file_location('cad_release_build', SCRIPT)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTest(unittest.TestCase):
    def test_content_changes_and_local_artifacts(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder) / 'engine'
            browser = Path(folder) / 'browser'
            for name in release.ENTRY_POINTS:
                path = base / 'core' / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('source')
            for name in release.RUNTIME_FILES:
                (base / name).write_text('runtime')
            browser.mkdir()
            (browser / 'app.js').write_text('browser')
            initial = release.describe(base, browser)
            (base / 'core/step_convert.py').write_text('changed source')
            changed = release.describe(base, browser)
            self.assertNotEqual(initial['engineVersion'], changed['engineVersion'])
            (base / 'requirements-step.txt').write_text('changed dependency')
            dependency = release.describe(base, browser)
            self.assertNotEqual(changed['engineVersion'], dependency['engineVersion'])
            (base / 'core/__pycache__').mkdir()
            (base / 'core/__pycache__/local.pyc').write_bytes(b'cache')
            (base / 'core/tests').mkdir()
            (base / 'core/tests/test_local.py').write_text('test only')
            self.assertEqual(dependency, release.describe(base, browser))


if __name__ == '__main__':
    unittest.main()
