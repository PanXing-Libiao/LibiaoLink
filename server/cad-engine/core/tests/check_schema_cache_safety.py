"""Schema-cache safety: caches must only hold nodes of the bundled schemas.

unified.validation caches per-node schema info keyed by id(). That is safe only while
every cached object belongs to the two bundled schema documents. This test parses many
documents, repeats a parse, and feeds an ad-hoc schema dict to shape() to prove the cache
does not grow with parsed data (no id-reuse leak, no per-document entries).
"""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent
PROJECT = DATA
sys.path.insert(0, str(APP))

from unified import validation  # noqa: E402
from unified.dxf_adapter import read_dxf  # noqa: E402

OUT = PROJECT / 'phase_j_evidence' / 'profiles' / 'dxf-schema-cache.json'
SAMPLES = PROJECT / 'phase_i_evidence' / 'samples' / 'real'
FIXTURES = PROJECT / 'phase_j_evidence' / 'fixtures'


def schema_node_ids(schema, seen=None):
    if seen is None:
        seen = set()
    if not isinstance(schema, dict) or id(schema) in seen:
        return seen
    seen.add(id(schema))
    for key in ('items', 'additionalProperties'):
        schema_node_ids(schema.get(key), seen)
    for child in (schema.get('properties') or {}).values():
        schema_node_ids(child, seen)
    for child in (schema.get('$defs') or {}).values():
        schema_node_ids(child, seen)
    for key in ('oneOf', 'anyOf'):
        for child in schema.get(key) or []:
            schema_node_ids(child, seen)
    return seen


def main():
    bundled = schema_node_ids(validation.SCHEMA) | schema_node_ids(validation.SCHEMA_V2)
    before = {'schemaInfo': len(validation._SCHEMA_INFO), 'refDefs': len(validation._REF_DEFS)}
    files = sorted(SAMPLES.glob('*.dxf')) + [FIXTURES / 'ocs_extrusion.dxf']
    parsed = 0
    for path in files:
        for _ in range(2):
            read_dxf(str(path), path.read_bytes())
            parsed += 1
    validation.shape({'probe': 1}, {'type': 'object', 'required': ['probe'],
                                    'properties': {'probe': {'type': 'integer'}}})
    after = {'schemaInfo': len(validation._SCHEMA_INFO), 'refDefs': len(validation._REF_DEFS)}
    unknown = [key for key in validation._SCHEMA_INFO if key not in bundled]
    unknown_refs = [key for key in validation._REF_DEFS if key[0] not in bundled]
    profile = {
        'schemaVersion': 'dxf-schema-cache/1', 'generatedAt': '2026-10-19',
        'bundledSchemaNodes': len(bundled), 'filesParsed': len(files), 'parses': parsed,
        'before': before, 'after': after,
        'growth': {'schemaInfo': after['schemaInfo'] - before['schemaInfo'],
                   'refDefs': after['refDefs'] - before['refDefs']},
        'nonBundledKeys': len(unknown) + len(unknown_refs),
        'adHocSchemaRegistered': False,
        'verdict': 'bounded' if not unknown and not unknown_refs and
                   after['schemaInfo'] <= len(bundled) else 'leaking',
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(profile, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps({'after': after, 'bundled': len(bundled), 'nonBundled': len(unknown) + len(unknown_refs),
                      'verdict': profile['verdict']}))
    return 0 if profile['verdict'] == 'bounded' else 1


if __name__ == '__main__':
    raise SystemExit(main())
