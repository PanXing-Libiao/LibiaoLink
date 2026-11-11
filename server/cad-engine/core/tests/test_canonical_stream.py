import hashlib
import io
import json
import tracemalloc
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

    def test_batched_tables_keep_large_scalars_and_array_boundaries(self):
        value={'rows':[[i, -0.0, True, None] for i in range(5000)],
               'large':{'text':'中文'*200000},'after':list(range(33))}
        expected=json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
        output=io.BytesIO();write_canonical(value,output)
        self.assertEqual(output.getvalue(),expected)
        self.assertEqual(canonical_sha256(value),hashlib.sha256(expected).hexdigest())

    def test_large_scalar_strings_stay_on_the_bounded_path(self):
        value={'text':'中文'*200000,'after':list(range(33))}
        expected=json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
        chunks=list(canonical_chunks(value))
        self.assertEqual(b''.join(chunks),expected)
        self.assertLess(max(map(len,chunks)),128*1024)

    def test_long_strings_do_not_join_one_batch(self):
        values=['x'*(1024*1024) for _ in range(32)]
        expected=json.dumps(values,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
        tracemalloc.start()
        try:
            sha=hashlib.sha256()
            for chunk in canonical_chunks(values):sha.update(chunk)
            _,peak=tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertEqual(sha.hexdigest(),hashlib.sha256(expected).hexdigest())
        self.assertLess(peak,8*1024*1024)

    def test_long_keys_do_not_join_one_batch(self):
        values={('k'*(1024*1024))+str(i):i for i in range(8)}
        expected=json.dumps(values,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
        tracemalloc.start()
        try:
            sha=hashlib.sha256()
            for chunk in canonical_chunks(values):sha.update(chunk)
            _,peak=tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertEqual(sha.hexdigest(),hashlib.sha256(expected).hexdigest())
        self.assertLess(peak,8*1024*1024)

    def test_random_structures_stay_byte_identical(self):
        import random
        rng=random.Random(20261110)
        scalars=[None,True,False,0,-0.0,1,-1,1e-7,1e20,1.25e-20,'','中文','a\\b','英国\\布局\n毫米']
        def make(depth):
            if depth<=0 or rng.random()<0.55:return rng.choice(scalars)
            if rng.random()<0.5:return [make(depth-1) for _ in range(rng.randrange(6))]
            keys=[rng.choice(['a','b','z','中文','k'+str(rng.randrange(8))]) for _ in range(rng.randrange(6))]
            return {key:make(depth-1) for key in keys}
        for _ in range(300):
            value=make(4)
            expected=json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
            self.assertEqual(b''.join(canonical_chunks(value)),expected)
            self.assertEqual(canonical_sha256(value),hashlib.sha256(expected).hexdigest())

    def test_nonfinite_is_not_serializable(self):
        for value in [float('nan'),{'nested':[float('inf')]}]:
            with self.assertRaises(ValueError):canonical_sha256(value)


if __name__=='__main__':unittest.main()
