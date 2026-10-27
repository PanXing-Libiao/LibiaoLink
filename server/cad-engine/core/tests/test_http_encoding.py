"""Negotiation and byte identity, including explicit refusal and small errors."""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import gzip
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from unified.http_encoding import accepts_gzip,encode_json

class EncodingTests(unittest.TestCase):
    def test_negotiation(self):
        for value in ('gzip','br, gzip;q=0.5','*;q=1','GZIP;Q=1'):
            self.assertTrue(accepts_gzip(value),value)
        for value in ('','br','gzip;q=0','*;q=1, gzip;q=0','gzip;q=garbage','gzip;q=nan','gzip;q=2'):
            self.assertFalse(accepts_gzip(value),value)
    def test_original_bytes_and_fallback(self):
        raw=('{"draw":"保留身份及精度"}'*10000).encode()
        coded,encoding=encode_json(raw,'gzip')
        self.assertEqual(encoding,'gzip');self.assertEqual(gzip.decompress(coded),raw)
        self.assertEqual(encode_json(raw,'gzip;q=0'),(raw,None))
        self.assertEqual(encode_json(b'{"error":true}','gzip'),(b'{"error":true}',None))
        self.assertEqual(encode_json(raw,'gzip')[0],coded)

if __name__=='__main__':unittest.main()
