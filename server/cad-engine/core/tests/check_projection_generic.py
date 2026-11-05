"""Projection dependency audit: the generic viewport projection must stay format-agnostic.

The browser and the Python adapter share one set of projection rules. This check proves
that public/drawing-projection.js does not read DXF-specific metadata or entity types;
everything it consumes is part of the generic UCD drawing/layout/viewport model.
"""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP_DIR = HERE.parent
PROJECT = DATA
OUT = PROJECT / 'phase_j_evidence' / 'profiles' / 'projection-dependency.json'

FORBIDDEN = [r'\bdxf\b', r'\bhatch\b', r'\bocs\b', r'\bextrusion\b', r'\blwpolyline\b',
             r'\bspline\b', r'org\.cad-preview\.dxf', r'hatchStyle', r'patternName', r'AcDb']
ALLOWED_EXTENSIONS = {'org.cad-preview.style-inheritance/1',
                      'org.cad-preview.fill/1'}


def strip_comments(source):
    source = re.sub(r'/\*.*?\*/', '', source, flags=re.S)
    return re.sub(r'//[^\n]*', '', source)


def main():
    path = BROWSER / 'drawing-projection.js'
    source = path.read_text()
    code = strip_comments(source)
    hits = []
    for pattern in FORBIDDEN:
        for match in re.finditer(pattern, code, flags=re.I):
            hits.append({'pattern': pattern, 'offset': match.start()})
    extension_keys = sorted(set(re.findall(r"extensions\['([^']+)'\]", source)))
    unexpected = [key for key in extension_keys if key not in ALLOWED_EXTENSIONS]
    fields = sorted(set(re.findall(r'\b(?:m|document|model)\.([A-Za-z]+)', code)))
    profile = {
        'schemaVersion': 'projection-dependency/1',
        'generatedAt': '2026-10-19',
        'file': '10_独立解析查看器/public/drawing-projection.js',
        'forbiddenHits': hits,
        'extensionKeys': extension_keys,
        'unexpectedExtensionKeys': unexpected,
        'documentFieldsRead': fields,
        'verdict': 'generic' if not hits and not unexpected else 'format-specific',
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(profile, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps({'forbiddenHits': len(hits), 'extensionKeys': extension_keys,
                      'verdict': profile['verdict']}))
    return 0 if profile['verdict'] == 'generic' else 1


if __name__ == '__main__':
    raise SystemExit(main())
