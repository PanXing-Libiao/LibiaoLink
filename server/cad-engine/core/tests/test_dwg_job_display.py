"""A DWG display belongs to one running archive job; it never becomes a job result."""
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest

CORE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CORE))
from unified.conversion_jobs import ConversionJobs


class DisplayLifetime(unittest.TestCase):
    def test_owner_can_read_until_job_cancellation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            worker = root/'dwg_platform_convert.py'
            worker.symlink_to(Path(__file__).resolve())
            jobs = ConversionJobs(root/'store', root, threading.Lock(),
                                  lambda proc: proc.kill() if proc and proc.poll() is None else None,
                                  'fixture', sys.executable, dwg_interpreter=sys.executable)
            owner, other = '1'*64, '2'*64
            try:
                row, _ = jobs.submit(b'AC1032example', 'fixture.dwg', False, 'request', namespace=owner)
                job = row['id']
                deadline = time.monotonic()+10
                while (manifest := jobs.display(owner, job)) is None and time.monotonic()<deadline:
                    time.sleep(.02)
                self.assertIsNotNone(manifest)
                lease = json.loads(Path(manifest['path']).read_bytes())['lease']
                digest = hashlib.sha256(b'geometry').hexdigest()
                self.assertIsNone(jobs.display(other))
                self.assertIsNone(jobs.display(owner, buffer=True, lease='wrong', sha256=digest))
                self.assertIsNone(jobs.display(owner, buffer=True, lease=lease, sha256='0'*64))
                resource = jobs.display(owner, buffer=True, lease=lease, sha256=digest)
                self.assertEqual(Path(resource['path']).read_bytes(), b'geometry')
                self.assertIsNone(jobs.result(job)[1])
                jobs.cancel(job)
                self.assertIsNone(jobs.display(owner))
            finally:
                jobs.close()
            self.assertEqual(list((root/'store/temporary').iterdir()), [])

    def test_cancelling_first_archive_releases_second_with_its_original_view(self):
        def wait_for(read):
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                if value := read():return value
                time.sleep(.02)
            self.fail('scheduled job did not reach expected phase')

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'dwg_platform_convert.py').symlink_to(Path(__file__).resolve())
            def stop(proc):
                if proc and proc.poll() is None:
                    proc.kill()
                    proc.wait()
            jobs = ConversionJobs(root/'store', root, threading.Lock(), stop, 'fixture',
                                  sys.executable, dwg_interpreter=sys.executable)
            def submit(label, namespace):
                return jobs.submit(b'AC1032example', label + '.dwg', False, label, namespace=namespace)[0]['id']
            try:
                first = submit('first', '1'*64)
                view = wait_for(lambda: jobs.display('1'*64))
                second = submit('second', '2'*64)
                wait_for(lambda: 'archiveResumed' in jobs.status(first)['trace']['events'])
                self.assertEqual(view, jobs.display('1'*64))
                second_view = jobs.display('2'*64)
                self.assertTrue(Path(second_view['path']).is_file())
                self.assertNotIn('archiveResumed', jobs.status(second)['trace']['events'])
                jobs.cancel(first)
                wait_for(lambda: 'archiveResumed' in jobs.status(second)['trace']['events'])
                self.assertEqual(second_view, jobs.display('2'*64))
                jobs.cancel(second)
            finally:
                jobs.close()
            self.assertEqual(list((root/'store/temporary').iterdir()), [])


if __name__ == '__main__' and Path(sys.argv[0]).name == 'dwg_platform_convert.py':
    binary = Path(os.environ['CAD_BINARY_DIR'])
    folder = binary.parent/'scratch'/'display'
    if os.environ.get("CAD_DWG_RESUME_ARCHIVE"):
        time.sleep(20)
        sys.exit(1)
    folder.mkdir()
    (binary/'buffer-0.bin').write_bytes(b'geometry')
    (folder/(hashlib.sha256(b'geometry').hexdigest()+'.json')).write_text(json.dumps({'lease':os.environ['CAD_DWG_DISPLAY_LEASE']}))
    time.sleep(20)
