"""FileSink keeps prewritten buffers on disk instead of writing them twice."""
import hashlib
import tempfile
import time
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from unified.payload_sink import FileSink  # noqa: E402


class FileSinkPrewrittenTest(unittest.TestCase):
    def test_prewritten_buffer_is_published_without_rewrite(self):
        with tempfile.TemporaryDirectory() as directory:
            sink = FileSink(directory)
            target = Path(directory) / 'buffer-0.bin'
            blob = b'abc123'
            target.write_bytes(blob)
            before = target.stat().st_mtime_ns
            time.sleep(0.02)
            sink.put_file('buffer-0', target, hashlib.sha256(blob).hexdigest(), len(blob))
            resources = sink.finish({'document': {'buffers': {'buffer-0': {}}}})
            self.assertEqual(resources, [{'id': 'buffer-0', 'sha256': hashlib.sha256(blob).hexdigest(),
                                          'byteLength': len(blob), 'file': 'buffer-0.bin'}])
            self.assertEqual(target.read_bytes(), blob)
            self.assertEqual(target.stat().st_mtime_ns, before)
            self.assertNotIn('buffer-0', sink.blobs)

    def test_prewritten_buffer_must_match_destination_and_length(self):
        with tempfile.TemporaryDirectory() as directory:
            sink = FileSink(directory)
            target = Path(directory) / 'buffer-0.bin'
            target.write_bytes(b'ab')
            with self.assertRaises(ValueError):
                sink.put_file('buffer-0', target, '0' * 64, 3)
            other = Path(directory) / 'other.bin'
            other.write_bytes(b'ab')
            with self.assertRaises(ValueError):
                sink.put_file('buffer-0', other, '0' * 64, 2)

    def test_put_still_writes_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            sink = FileSink(directory)
            sink.put('buffer-0', b'ab')
            resources = sink.finish({'document': {'buffers': {'buffer-0': {}}}})
            self.assertEqual((Path(directory) / 'buffer-0.bin').read_bytes(), b'ab')
            self.assertEqual(resources[0]['byteLength'], 2)


if __name__ == '__main__':
    unittest.main()
