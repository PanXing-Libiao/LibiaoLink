"""Validate the deployed source snapshot before accepting conversion jobs."""
import hashlib
import json
from pathlib import Path


def load_release():
    base = Path(__file__).resolve().parent
    release = json.loads((base / 'source.json').read_text())
    for field, root in (('engineFiles', base / 'core'), ('runtimeFiles', base),
                        ('readerFiles', base / 'dwg-reader')):
        for name, expected in release.get(field, {}).items():
            if hashlib.sha256((root / name).read_bytes()).hexdigest() != expected:
                raise ValueError('CAD engine release mismatch: ' + field + '/' + name)
    return release
