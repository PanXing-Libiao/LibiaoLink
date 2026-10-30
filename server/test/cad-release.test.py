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
            (browser / 'app.js').write_text('changed browser')
            viewer = release.describe(base, browser)
            self.assertEqual(initial['engineVersion'], viewer['engineVersion'])
            self.assertEqual(initial['formatVersions'], viewer['formatVersions'])
            self.assertNotEqual(initial['viewerVersion'], viewer['viewerVersion'])
            self.assertNotEqual(initial['releaseDigest'], viewer['releaseDigest'])
            (base / 'core/step_convert.py').write_text('changed source')
            step = release.describe(base, browser)
            self.assertNotEqual(initial['engineVersion'], step['engineVersion'])
            self.assertNotEqual(initial['formatVersions']['STEP'], step['formatVersions']['STEP'])
            self.assertEqual(initial['formatVersions']['DXF'], step['formatVersions']['DXF'])
            (base / 'core/dxf_convert.py').write_text('changed dxf source')
            dxf = release.describe(base, browser)
            self.assertNotEqual(step['formatVersions']['DXF'], dxf['formatVersions']['DXF'])
            self.assertEqual(step['formatVersions']['STEP'], dxf['formatVersions']['STEP'])
            (base / 'requirements-step.txt').write_text('changed dependency')
            dependency = release.describe(base, browser)
            self.assertNotEqual(dxf['engineVersion'], dependency['engineVersion'])
            self.assertNotEqual(dxf['formatVersions']['STEP'], dependency['formatVersions']['STEP'])
            self.assertEqual(dxf['formatVersions']['DXF'], dependency['formatVersions']['DXF'])
            (base / 'requirements-dxf.txt').write_text('changed dxf dependency')
            dxf_dependency = release.describe(base, browser)
            self.assertNotEqual(dependency['formatVersions']['DXF'], dxf_dependency['formatVersions']['DXF'])
            self.assertEqual(dependency['formatVersions']['STEP'], dxf_dependency['formatVersions']['STEP'])
            (base / 'core/unified').mkdir(parents=True, exist_ok=True)
            (base / 'core/unified/dwg_adapter.py').write_text('dwg adapter')
            dwg = release.describe(base, browser)
            self.assertNotEqual(dxf_dependency['engineVersion'], dwg['engineVersion'])
            self.assertNotEqual(dxf_dependency['formatVersions']['DWG'], dwg['formatVersions']['DWG'])
            self.assertEqual(dxf_dependency['formatVersions']['STEP'], dwg['formatVersions']['STEP'])
            self.assertEqual(dxf_dependency['formatVersions']['DXF'], dwg['formatVersions']['DXF'])
            (base / 'core/unified/dwg-reader.json').write_text('{"version": "0.13.3"}')
            dwg_spec = release.describe(base, browser)
            self.assertNotEqual(dwg['formatVersions']['DXF'], dwg_spec['formatVersions']['DXF'])
            self.assertEqual(dwg['formatVersions']['STEP'], dwg_spec['formatVersions']['STEP'])
            self.assertEqual(dwg['formatVersions']['DWG'], dwg_spec['formatVersions']['DWG'])
            (base / 'core/__pycache__').mkdir()
            (base / 'core/__pycache__/local.pyc').write_bytes(b'cache')
            (base / 'core/tests').mkdir()
            (base / 'core/tests/test_local.py').write_text('test only')
            self.assertEqual(dwg_spec, release.describe(base, browser))


if __name__ == '__main__':
    unittest.main()
