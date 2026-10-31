"""Byte-identical Python sorted JSON, encoded in bounded subtrees.

The standard C encoder handles small subtrees. Large containers are streamed so
a whole expanded CAD document is never materialized as a second JSON string.
"""
import hashlib
import json

ENCODER=json.JSONEncoder(ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)


def _small(value):
    # Bound both the scan and the C encoder's temporary output. A scalar string
    # is already an indivisible token in the standard streaming encoder.
    pending=[value];nodes=256;chars=16384
    while pending:
        item=pending.pop();nodes-=1
        if nodes<0:return False
        if isinstance(item,dict):
            if len(item)>nodes:return False
            for key in item:
                if isinstance(key,str):chars-=len(key)
            pending.extend(item.values())
        elif isinstance(item,(list,tuple)):
            if len(item)>nodes:return False
            pending.extend(item)
        elif isinstance(item,str):chars-=len(item)
        if chars<0:return False
    return True


def canonical_chunks(value):
    markers=set()
    def chunks(item):
        if _small(item) or not isinstance(item,(dict,list,tuple)):
            yield ENCODER.encode(item).encode('utf-8')
            return
        # Non-string keys retain the standard encoder's coercion/error behavior.
        if isinstance(item,dict) and not all(isinstance(k,str) for k in item):
            for text in ENCODER.iterencode(item):yield text.encode('utf-8')
            return
        marker=id(item)
        if marker in markers:raise ValueError('Circular reference detected')
        markers.add(marker)
        try:
            if isinstance(item,dict):
                yield b'{'
                for index,key in enumerate(sorted(item)):
                    if index:yield b','
                    yield ENCODER.encode(key).encode('utf-8')
                    yield b':'
                    yield from chunks(item[key])
                yield b'}'
            else:
                yield b'['
                for index,child in enumerate(item):
                    if index:yield b','
                    yield from chunks(child)
                yield b']'
        finally:markers.remove(marker)
    yield from chunks(value)


def canonical_sha256(value):
    sha=hashlib.sha256()
    for chunk in canonical_chunks(value):sha.update(chunk)
    return sha.hexdigest()


def write_canonical(value,stream):
    for chunk in canonical_chunks(value):stream.write(chunk)
