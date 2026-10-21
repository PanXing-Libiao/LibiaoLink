"""HTTP content coding; revisioned UCD bytes and schemas are unchanged."""
import gzip

def accepts_gzip(value):
    qualities={}
    for entry in (value or '').split(','):
        parts=entry.strip().lower().split(';');coding=parts[0];quality=1.
        for parameter in parts[1:]:
            key,_,val=parameter.strip().partition('=')
            if key=='q':
                try:quality=float(val)
                except ValueError:quality=0.
        qualities[coding]=quality if 0<=quality<=1 else 0.
    return qualities.get('gzip',qualities.get('*',0))>0

def encode_json(raw,accept_encoding):
    if len(raw)<32768 or not accepts_gzip(accept_encoding):return raw,None
    coded=gzip.compress(raw,compresslevel=1,mtime=0)
    return (coded,'gzip') if len(coded)<len(raw) else (raw,None)
