"""Result-cache lifecycle tests; metadata only. Native validation is exercised by cad-platform.test.ts."""
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'cad-engine'))
from result_cache import ResultCache


class Jobs:
    rule_version = 'pinned-parser-release'
    binary = compact = True
    policy = {'inputBytes': 1024, 'retentionSeconds': 86400, 'workerWallSeconds': 600,
              'queueWallSeconds': 900, 'version': 'policy/3'}

    def __init__(self, row):
        self.row = row
        self.calls = 0
        self.raw = json.dumps({'snapshot': {'completeness': 'complete'}, 'transportProfile': 'ucd-worker-binary-compact/1'}).encode()

    def status(self, job_id):
        return self.row if self.row['id'] == job_id else None

    def result(self, job_id):
        self.calls += 1
        return self.row, self.raw


class ResultCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'results.sqlite3'
        self.request = {'namespace': 'a' * 64, 'cacheScope': 'b' * 64, 'sourceSHA256': 'c' * 64,
                        'sourceByteLength': 100, 'name': 'box.step', 'nameCodepage': 'UTF8'}
        self.row = {**self.request, 'id': 'd' * 32, 'state': 'completed', 'createdAt': time.time(), 'updatedAt': time.time()}
        self.jobs = Jobs(self.row)
        self.cache = ResultCache(self.path, self.jobs)
        self.cache.remember(self.request, self.row)

    def tearDown(self):
        self.cache.close()
        self.temp.cleanup()

    def test_new_view_requires_an_explicit_binding(self):
        other = {**self.request, 'namespace': 'e' * 64}
        self.assertFalse(self.cache.allows(other['namespace'], self.row['id']))
        self.assertEqual(self.cache.lookup(other)['id'], self.row['id'])
        self.assertTrue(self.cache.allows(other['namespace'], self.row['id']))
        self.assertEqual(self.jobs.calls, 1)

    def test_file_version_content_encoding_and_parser_are_separate(self):
        for field, value in [('cacheScope', 'f' * 64), ('sourceSHA256', 'f' * 64),
                             ('sourceByteLength', 101), ('name', 'renamed.step'), ('nameCodepage', 'GB')]:
            with self.subTest(field=field):
                self.assertIsNone(self.cache.lookup({**self.request, field: value}))
        self.jobs.rule_version = 'new-parser-release'
        self.assertIsNone(self.cache.lookup(self.request))

    def test_nonterminal_failed_expired_and_partial_results_do_not_reuse(self):
        for state in ('queued', 'running', 'failed', 'cancelled', 'timed-out'):
            with self.subTest(state=state):
                self.row['state'] = state
                self.cache.remember(self.request, self.row)
                self.assertIsNone(self.cache.lookup(self.request))
        self.row['state'] = 'completed'
        self.cache.remember(self.request, self.row)
        self.row['updatedAt'] = time.time() - 86401
        self.assertIsNone(self.cache.lookup(self.request))
        self.row['updatedAt'] = time.time()
        self.jobs.raw = json.dumps({'snapshot': {'completeness': 'partial'}, 'transportProfile': 'ucd-worker-binary-compact/1'}).encode()
        self.assertIsNone(self.cache.lookup(self.request))

    def test_integrity_failure_does_not_grant_access(self):
        self.jobs.raw = None
        other = {**self.request, 'namespace': 'e' * 64}
        self.assertIsNone(self.cache.lookup(other))
        self.assertEqual(self.jobs.calls, 1)
        self.assertFalse(self.cache.allows(other['namespace'], self.row['id']))

    def test_index_survives_restart_but_bindings_expire(self):
        other = {**self.request, 'namespace': 'e' * 64}
        self.cache.lookup(other)
        self.cache.close()
        self.cache = ResultCache(self.path, self.jobs)
        self.assertTrue(self.cache.allows(other['namespace'], self.row['id']))
        self.cache.db.execute('UPDATE bindings SET expires=0'); self.cache.db.commit()
        self.assertFalse(self.cache.allows(other['namespace'], self.row['id']))
        self.assertEqual(self.cache.lookup(other)['id'], self.row['id'])

    def test_releasing_one_binding_keeps_the_other_view(self):
        for namespace in ('e' * 64, 'f' * 64):
            self.cache.lookup({**self.request, 'namespace': namespace})
        self.cache.revoke('e' * 64, self.row['id'])
        self.assertFalse(self.cache.allows('e' * 64, self.row['id']))
        self.assertTrue(self.cache.allows('f' * 64, self.row['id']))
        self.assertEqual(self.row['state'], 'completed')


if __name__ == '__main__':
    unittest.main()
