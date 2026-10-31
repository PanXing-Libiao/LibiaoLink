"""Compiled structural checks for DWG and STEP; geometry and digest checks stay in validation."""
import copy
import math
import re
from functools import lru_cache
import jsonschema_rs


class StrictInteger:
    def __init__(self, parent_schema, value, schema_path):
        pass

    def validate(self, instance):
        if type(instance) is not int:
            raise ValueError('Expected integer')


class PythonPattern:
    def __init__(self, parent_schema, value, schema_path):
        self.pattern = re.compile(value)

    def validate(self, instance):
        if isinstance(instance, str) and self.pattern.search(instance) is None:
            raise ValueError('Pattern')


class KnownFact:
    def __init__(self, parent_schema, value, schema_path):
        pass

    def validate(self, instance):
        if isinstance(instance, dict) and instance.get('knowledge') == 'unknown' and 'value' in instance:
            raise ValueError('Unknown fact cannot invent a value')


@lru_cache(maxsize=1)
def _validator():
    from .validation import SCHEMA_V2, SUPPORTED
    schema = copy.deepcopy(SCHEMA_V2)

    def prepare(node):
        if not isinstance(node, dict):
            return
        if set(node) - SUPPORTED:
            raise ValueError('Unsupported schema vocabulary')
        # The existing walker resolves a ref instead of applying sibling keywords.
        if '$ref' in node:
            ref = node['$ref']
            node.clear()
            node['$ref'] = ref
            if ref == '#/$defs/Fact':
                node['x-known-fact'] = True
            return
        for key in ('properties', '$defs'):
            for child in node.get(key, {}).values():
                prepare(child)
        for key in ('items', 'additionalProperties'):
            prepare(node.get(key))
        for key in ('oneOf', 'anyOf'):
            for child in node.get(key, []):
                prepare(child)
        if node.get('type') == 'integer':
            node['x-python-integer'] = True
        if 'pattern' in node:
            node['x-python-pattern'] = node.pop('pattern')

    schema.pop('$ref', None)
    prepare(schema)
    schema['$ref'] = '#/$defs/Envelope'
    return jsonschema_rs.validator_for(schema, offline=True, keywords={
        'x-python-integer': StrictInteger, 'x-python-pattern': PythonPattern,
        'x-known-fact': KnownFact,
    })


def accepts(envelope):
    # JSON Schema leaves extension values unconstrained; our contract rejects
    # non-finite floats even there. Keep this check outside schema traversal.
    pending = [envelope]
    while pending:
        item = pending.pop()
        if isinstance(item, dict):
            pending.extend(item.values())
        elif isinstance(item, list):
            pending.extend(item)
        elif type(item) is float and not math.isfinite(item):
            return False
    return _validator().is_valid(envelope)
