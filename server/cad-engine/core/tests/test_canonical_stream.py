import hashlib
import io
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from unified.canonical import canonical_sha256,write_canonical


class CanonicalStream(unittest.TestCase):
    def test_exact_existing_profile(self):
        values=[{},[],{'中文':[-0.0,1e-7,1e20,1e21,1.25e-20,True,None,'英国\\布局\n毫米']},
                {'z':{str(n):n/7 for n in range(100)},'a':'\u2028\u2029é'}]
        for value in values:
            expected=json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
            output=io.BytesIO();write_canonical(value,output)
            self.assertEqual(output.getvalue(),expected)
            self.assertEqual(canonical_sha256(value),hashlib.sha256(expected).hexdigest())

    def test_nonfinite_is_not_serializable(self):
        for value in [float('nan'),{'nested':[float('inf')]}]:
            with self.assertRaises(ValueError):canonical_sha256(value)


if __name__=='__main__':unittest.main()
