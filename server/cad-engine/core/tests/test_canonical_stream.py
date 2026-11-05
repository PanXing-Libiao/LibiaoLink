import hashlib
import io
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from unified.canonical import canonical_sha256,write_canonical,canonical_chunks


class CanonicalStream(unittest.TestCase):
    def test_exact_existing_profile(self):
        values=[{},[],{'中文':[-0.0,1e-7,1e20,1e21,1.25e-20,True,None,'英国\\布局\n毫米']},
                {'z':{str(n):n/7 for n in range(100)},'a':'\u2028\u2029é'}]
        for value in values:
            expected=json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
            output=io.BytesIO();write_canonical(value,output)
            self.assertEqual(output.getvalue(),expected)
            self.assertEqual(canonical_sha256(value),hashlib.sha256(expected).hexdigest())

    def test_large_nested_unicode_and_numeric_document_is_byte_identical(self):
        value={'drawing':{'entities':{str(i):{'text':'中文\\字体\n'+chr(i%32),
            'points':[[j/7,-0.0,1e-12] for j in range(80)],'visible':True}
            for i in range(300)}},'references':list(range(1000))}
        expected=json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
        output=io.BytesIO();write_canonical(value,output)
        self.assertEqual(output.getvalue(),expected)
        self.assertEqual(canonical_sha256(value),hashlib.sha256(expected).hexdigest())

    def test_large_non_string_keys_retain_standard_json_behavior(self):
        value={i:[i,None,False] for i in range(300)}
        output=io.BytesIO();write_canonical(value,output)
        self.assertEqual(output.getvalue(),json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode())

    def test_cycles_and_late_nonfinite_are_rejected(self):
        cycle=[];cycle.append(cycle)
        for value in [cycle,{'rows':list(range(1000))+[float('inf')]}]:
            with self.assertRaises(ValueError):canonical_sha256(value)

    def test_large_document_is_not_encoded_as_one_temporary_string(self):
        value={'rows':[{'label':'中文'*100,'points':list(range(64))} for _ in range(2000)]}
        sizes=[len(chunk) for chunk in canonical_chunks(value)]
        self.assertGreater(sum(sizes),1000000)
        self.assertLess(max(sizes),128*1024)

    def test_nonfinite_is_not_serializable(self):
        for value in [float('nan'),{'nested':[float('inf')]}]:
            with self.assertRaises(ValueError):canonical_sha256(value)


if __name__=='__main__':unittest.main()
