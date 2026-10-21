"""Lossless transport-only draw dictionary; canonical UCD IDs/revisions stay intact.

Rows combine the snapshot draw and its document render owner. Every original
string is retained once; no hash truncation, inferred owner or CAD rule is used.
"""
FIELDS=('occurrenceId','bindingId','primitiveId','membership','availability','suppression','visibility','materialId')
WORKER='ucd-worker-binary-compact/1'
PUBLIC='ucd-binary-compact/1'
VERSION='draw-index-table/1'

def pack_metadata(envelope):
    profile=envelope.get('transportProfile')
    if profile not in ('ucd-worker-binary/1','ucd-binary-manifest/1'):raise ValueError('unsupported compact source profile')
    document=envelope['document'];snapshot=envelope['snapshot'];owners=document['renderOwnership']
    strings=[];indices={};rows=[]
    def index(value):
        if not isinstance(value,str):raise ValueError('draw dictionary values must be strings')
        if value not in indices:indices[value]=len(strings);strings.append(value)
        return indices[value]
    for did,draw in snapshot['draws'].items():
        if set(draw)!=set(FIELDS):raise ValueError('unsupported draw fields')
        owner=-1 if did not in owners else (None if owners[did] is None else index(owners[did]))
        rows.append([index(did),*[index(draw[k]) for k in FIELDS],owner])
    remainder=[[index(did),None if owner is None else index(owner)] for did,owner in owners.items() if did not in snapshot['draws']]
    return {**envelope,'transportProfile':WORKER if profile=='ucd-worker-binary/1' else PUBLIC,
            'document':{**document,'renderOwnership':{}},'snapshot':{**snapshot,'draws':{}},
            'drawTable':{'version':VERSION,'strings':strings,'rows':rows,'ownershipRemainder':remainder}}

def unpack_metadata(envelope):
    profile=envelope.get('transportProfile')
    if profile not in (WORKER,PUBLIC):return envelope
    table=envelope['drawTable'];strings=table['strings']
    if table['version']!=VERSION or type(strings) is not list or any(type(s) is not str for s in strings) or len(set(strings))!=len(strings):
        raise ValueError('invalid draw dictionary')
    if envelope['document']['renderOwnership'] or envelope['snapshot']['draws']:raise ValueError('ambiguous compact draw maps')
    def value(i):
        if type(i) is not int or not 0<=i<len(strings):raise ValueError('draw dictionary index out of range')
        return strings[i]
    draws={};owners={}
    for row in table['rows']:
        if type(row) is not list or len(row)!=10:raise ValueError('invalid compact draw row')
        did=value(row[0])
        if did in draws:raise ValueError('duplicate compact draw')
        draws[did]={k:value(i) for k,i in zip(FIELDS,row[1:9])}
        owner=row[9]
        # Null owner (unrepresented product) and absent ownership are distinct.
        if not (type(owner) is int and owner==-1):owners[did]=None if owner is None else value(owner)
    for pair in table['ownershipRemainder']:
        if type(pair) is not list or len(pair)!=2:raise ValueError('invalid compact ownership row')
        did=value(pair[0]);owner=None if pair[1] is None else value(pair[1])
        if did in draws or did in owners:raise ValueError('duplicate compact owner')
        owners[did]=owner
    return {**{k:v for k,v in envelope.items() if k!='drawTable'},
            'transportProfile':'ucd-worker-binary/1' if profile==WORKER else 'ucd-binary-manifest/1',
            'document':{**envelope['document'],'renderOwnership':owners},'snapshot':{**envelope['snapshot'],'draws':draws}}
