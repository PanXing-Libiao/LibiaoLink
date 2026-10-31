"""Targeted resource accounting regression; no CAD samples required."""
import subprocess
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from unified.conversion_jobs import process_tree_rss

class ResourceAccountingTests(unittest.TestCase):
    def test_native_child_in_separate_session_is_counted(self):
        child = "import time; data=bytearray(32*1024*1024); print('ready',flush=True); time.sleep(8)"
        parent = ("import subprocess,sys; p=subprocess.Popen([sys.executable,'-c',"+repr(child)+"],"
                  "stdout=subprocess.PIPE,text=True,start_new_session=True); print(p.stdout.readline(),flush=True); p.wait()")
        proc = subprocess.Popen([sys.executable,'-c',parent],stdout=subprocess.PIPE,text=True)
        try:
            self.assertEqual(proc.stdout.readline().strip(),'ready')
            own=int(subprocess.check_output(['ps','-o','rss=','-p',str(proc.pid)],text=True))*1024
            self.assertGreater(process_tree_rss(proc.pid),own+24*1024*1024)
        finally:
            children=subprocess.check_output(['ps','--ppid',str(proc.pid),'-o','pid='],text=True).split()
            for child_pid in children:
                subprocess.run(['kill','-KILL',child_pid],check=False)
            proc.wait(timeout=3)
            proc.stdout.close()

if __name__=='__main__':unittest.main()
