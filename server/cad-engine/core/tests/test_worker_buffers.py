"""Worker buffer path guards: directory boundary, symlink, regular file only."""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import os,tempfile,unittest
from pathlib import Path
from unified.transport import read_worker_buffers

class GuardTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.folder=Path(self.tmp.name)/'lease';self.folder.mkdir()
        self.outside=Path(self.tmp.name)/'outside.bin';self.outside.write_bytes(b'secret')

    def entry(self,path,bid='b1'):return {'id':bid,'path':str(path)}

    def test_regular_file_inside_is_read(self):
        target=self.folder/'b1.bin';target.write_bytes(b'data')
        self.assertEqual(read_worker_buffers(self.folder,[self.entry(target)]),{'b1':b'data'})

    def test_symlink_is_rejected(self):
        link=self.folder/'b1.bin';link.symlink_to(self.outside)
        with self.assertRaises(ValueError):read_worker_buffers(self.folder,[self.entry(link)])

    def test_outside_path_is_rejected(self):
        with self.assertRaises(ValueError):read_worker_buffers(self.folder,[self.entry(self.outside)])

    def test_wrong_name_is_rejected(self):
        other=self.folder/'other.bin';other.write_bytes(b'x')
        with self.assertRaises(ValueError):read_worker_buffers(self.folder,[self.entry(other)])

    def test_directory_is_rejected(self):
        folder=self.folder/'b1.bin';folder.mkdir()
        with self.assertRaises(ValueError):read_worker_buffers(self.folder,[self.entry(folder)])

if __name__=='__main__':unittest.main()
