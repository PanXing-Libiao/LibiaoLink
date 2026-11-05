"""Byte-identical Python sorted JSON, encoded in bounded subtrees.

The standard C encoder handles small subtrees. Large containers are streamed so
a whole expanded CAD document is never materialized as a second JSON string.
"""
import hashlib
import json

ENCODER=json.JSONEncoder(ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)


_NUMERIC_TYPES={int,float,bool,type(None)}


def _small(value):
    # Bound the scan and the C encoder's temporary output; scalar strings remain indivisible.
    pending=[value];nodes=4096;chars=262144
    while pending:
        item=pending.pop();nodes-=1
        if nodes<0:return False
        # Scalar numbers cannot contain child containers or string bytes.
        if type(item) in _NUMERIC_TYPES:continue
        if isinstance(item,dict):
            if len(item)>nodes:return False
            for key in item:
                if isinstance(key,str):chars-=len(key)
            pending.extend(item.values())
        elif isinstance(item,(list,tuple)):
            if len(item)>nodes:return False
            if set(map(type,item))<=_NUMERIC_TYPES:nodes-=len(item)
            else:pending.extend(item)
        elif isinstance(item,str):chars-=len(item)
        if chars<0:return False
    return True


def _canonical_parts(value):
    markers=set()
    def encoded_inner(batch):
        raw=ENCODER.encode(batch).encode('utf-8')
        # Bound emitted fragments even when a group contains several large leaves.
        for start in range(1,len(raw)-1,64*1024):
            yield raw[start:min(start+64*1024,len(raw)-1)]
    def chunks(item,known_large=False):
        if not isinstance(item,(dict,list,tuple)) or (not known_large and _small(item)):
            yield ENCODER.encode(item).encode('utf-8');return
        if isinstance(item,dict) and not all(isinstance(k,str) for k in item):
            for text in ENCODER.iterencode(item):yield text.encode('utf-8')
            return
        marker=id(item)
        if marker in markers:raise ValueError('Circular reference detected')
        markers.add(marker)
        try:
            mapping=isinstance(item,dict)
            yield b'{' if mapping else b'['
            batch={} if mapping else [];emitted=False
            rows=((key,item[key]) for key in sorted(item)) if mapping else enumerate(item)
            for key,child in rows:
                small=_small(child)
                if batch and (len(batch)==16 or not small):
                    if emitted:yield b','
                    yield from encoded_inner(batch);batch.clear();emitted=True
                if small:
                    if mapping:batch[key]=child
                    else:batch.append(child)
                else:
                    if emitted:yield b','
                    if mapping:
                        yield ENCODER.encode(key).encode('utf-8');yield b':'
                    yield from chunks(child,known_large=True);emitted=True
            if batch:
                if emitted:yield b','
                yield from encoded_inner(batch)
            yield b'}' if mapping else b']'
        finally:markers.remove(marker)
    yield from chunks(value)


def canonical_chunks(value):
    """Coalesce encoder fragments before hashing or writing.

    The canonical encoder emits many tiny fragments for nested drawings. Hashing
    each fragment separately spends most of its time in Python/SHA call overhead;
    bounded coalescing keeps memory flat while reducing those calls by orders of
    magnitude. The concatenated bytes remain byte-identical to the profile above.
    """
    pending=bytearray()
    for part in _canonical_parts(value):
        pending.extend(part)
        if len(pending)>=64*1024:
            yield bytes(pending)
            pending.clear()
    if pending:
        yield bytes(pending)


def canonical_sha256(value):
    sha=hashlib.sha256()
    for chunk in canonical_chunks(value):sha.update(chunk)
    return sha.hexdigest()


def write_canonical(value,stream):
    for chunk in canonical_chunks(value):stream.write(chunk)
