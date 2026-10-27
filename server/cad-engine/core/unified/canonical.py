"""UCD's existing Python sorted JSON profile, streamed by the standard encoder.

Encoding a large Chinese document as one string and then UTF-8 duplicates the
whole manifest in memory. Iterencoding preserves exactly the same bytes without
that temporary copy; this is not a new serialization profile.
"""
import hashlib
import json

ENCODER=json.JSONEncoder(ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)


def canonical_chunks(value):
    for text in ENCODER.iterencode(value):
        yield text.encode('utf-8')


def canonical_sha256(value):
    sha=hashlib.sha256()
    for chunk in canonical_chunks(value):sha.update(chunk)
    return sha.hexdigest()


def write_canonical(value,stream):
    for chunk in canonical_chunks(value):stream.write(chunk)
