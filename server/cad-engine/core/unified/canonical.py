"""Byte-identical Python sorted JSON, encoded in bounded subtrees.

The standard C encoder handles small subtrees. Large containers are streamed so
a whole expanded CAD document is never materialized as a second JSON string.
Small children of a large container are batched into one bounded C-encoder call;
oversized strings and arrays keep the streaming path.
"""
import hashlib
import json

ENCODER=json.JSONEncoder(ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)
_SCALAR_TYPES={int,float,bool,type(None)}
_SMALL_NODES=4096
_SMALL_CHARS=16384
_FLAT_SCALAR_LIMIT=2048
_BATCH_ITEMS=32
_BATCH_STRING_CHARS=4096
_FRAGMENT_BYTES=64*1024


def _small(value):
    # Bound both the scan and the C encoder's temporary output. A scalar string
    # is already an indivisible token in the standard streaming encoder.
    pending=[value];nodes=_SMALL_NODES;chars=_SMALL_CHARS
    while pending:
        item=pending.pop();nodes-=1
        if nodes<0:return False
        kind=type(item)
        if kind in _SCALAR_TYPES:continue
        if isinstance(item,dict):
            if len(item)>nodes:return False
            for key in item:
                if isinstance(key,str):chars-=len(key)
            pending.extend(item.values())
        elif isinstance(item,(list,tuple)):
            if len(item)>nodes:return False
            # A flat numeric/boolean/null array is small in bytes as well as in
            # nodes, so the C encoder can emit it without per-value fragments.
            if len(item)<=_FLAT_SCALAR_LIMIT and all(type(child) in _SCALAR_TYPES for child in item):
                nodes-=len(item)
            else:
                pending.extend(item)
        elif isinstance(item,str):chars-=len(item)
        if chars<0:return False
    return True


def _canonical_parts(value, small_rows=None):
    markers=set()
    def scalar(item):
        # One indivisible scalar may still exceed the fragment budget. Split the
        # encoded bytes without joining this value to the surrounding batch.
        raw=ENCODER.encode(item).encode('utf-8')
        for start in range(0,len(raw),_FRAGMENT_BYTES):
            yield raw[start:start+_FRAGMENT_BYTES]
    def inner(raw):
        # The batch is bounded, but keep every emitted fragment bounded too.
        for start in range(1,len(raw)-1,_FRAGMENT_BYTES):
            yield raw[start:min(start+_FRAGMENT_BYTES,len(raw)-1)]
    def chunks(item,known_large=False):
        if not isinstance(item,(dict,list,tuple)):
            if isinstance(item,str) and len(item)>_BATCH_STRING_CHARS:
                yield from scalar(item)
            else:
                yield ENCODER.encode(item).encode('utf-8')
            return
        if not known_large and _small(item):
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
            mapping=isinstance(item,dict)
            yield b'{' if mapping else b'['
            batch={} if mapping else []
            emitted=False
            def flush():
                nonlocal emitted
                if not batch:return
                if emitted:yield b','
                yield from inner(ENCODER.encode(batch).encode('utf-8'))
                batch.clear();emitted=True
            rows=((key,item[key]) for key in sorted(item)) if mapping else enumerate(item)
            # Only the named table uses its schema-aware size estimate; every
            # row still goes through the same sorted JSON encoder.
            row_is_small = small_rows[1] if small_rows and item is small_rows[0] else _small
            for key,child in rows:
                long_key=mapping and len(key)>_BATCH_STRING_CHARS
                long_string=isinstance(child,str) and len(child)>_BATCH_STRING_CHARS
                container_large=isinstance(child,(dict,list,tuple)) and not row_is_small(child)
                if not long_key and not long_string and not container_large:
                    if mapping:batch[key]=child
                    else:batch.append(child)
                    if len(batch)>=_BATCH_ITEMS:yield from flush()
                    continue
                yield from flush()
                if emitted:yield b','
                if mapping:
                    yield from scalar(key);yield b':'
                yield from chunks(child,known_large=container_large);emitted=True
            yield from flush()
            yield b'}' if mapping else b']'
        finally:markers.remove(marker)
    yield from chunks(value)


def canonical_chunks(value, *, small_rows=None):
    """Coalesce encoder fragments before hashing or writing.

    The canonical encoder emits many tiny fragments for nested drawings. Hashing
    each fragment separately spends most of its time in Python/SHA call overhead;
    bounded coalescing keeps memory flat while reducing those calls by orders of
    magnitude. The concatenated bytes remain byte-identical to the profile above.
    """
    pending=bytearray()
    for part in _canonical_parts(value, small_rows):
        pending.extend(part)
        if len(pending)>=64*1024:
            yield bytes(pending)
            pending.clear()
    if pending:
        yield bytes(pending)


def canonical_sha256(value, *, small_rows=None):
    sha=hashlib.sha256()
    for chunk in canonical_chunks(value, small_rows=small_rows):sha.update(chunk)
    return sha.hexdigest()


def write_canonical(value,stream):
    for chunk in canonical_chunks(value):stream.write(chunk)
