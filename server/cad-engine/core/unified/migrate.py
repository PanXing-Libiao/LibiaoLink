"""Explicit, restricted EASM bridge migration; never reinterprets CAD semantics."""
from copy import deepcopy
from pathlib import Path
import hashlib
from .adapter import digest,identity
from .payload_sink import Base64Sink
from .validation import validate_binary_envelope,validate_envelope

def _validate(e,sink):
    if sink is None or isinstance(sink,Base64Sink):validate_envelope(e)
    else:validate_binary_envelope(e['document'],e['snapshot'],e['presentation'],sink.get)

def seal(e):
    d,s=e['document'],e['snapshot'];d['revision']=digest({k:v for k,v in d.items() if k!='revision'});s['documentRevision']=d['revision'];s['id']=identity('snapshot',{k:v for k,v in s.items() if k!='id'});return e

def migrate_bridge_v1(e,sink=None,*,validated=False):
    """validated=True means the caller already ran the same validation on exactly
    this envelope (from_packet does); it skips one redundant full pass."""
    if not validated:_validate(e,sink)
    d=e['document']
    if d['schemaVersion']!='1.0.0' or d['adapter']['id']!='easm-packet-bridge' or len(d['configurations'])!=1 or d['displayStates'] or d['products']:
        raise ValueError('Only the single-context EASM v1 bridge has a verified migration')
    e=deepcopy(e);d,s=e['document'],e['snapshot'];old=d['revision']
    d['schemaVersion']=s['schemaVersion']='2.0.0'
    d['viewContexts']=[{'id':'view-default','origin':'system-default','name':'Source scene','sourceContextKey':d['configurations'][0]['sourceKey']}]
    d['extensions']['org.cad-preview.migration/1']={'fromVersion':'1.0.0','fromRevision':old,'configurations':d['configurations'],'defaultSelection':d['defaultSelection']}
    d['configurations']=[];s['selection']={'viewContextId':'view-default'};d['defaultSelection']={'value':s['selection'].copy(),'knowledge':'engineering-defined','validation':'experimental','evidenceIds':['view-policy']}
    d['evidence'].append({'id':'view-policy','kind':'engineering-contract','reference':'unified/migrate.py','scope':'System viewing context, not a source CAD configuration'})
    for c in d['capabilities']:
        old=c['implementation'];c['implementation']='unsupported' if old=='unsupported' else 'experimental';c['validation']='not-implemented' if old=='unsupported' else 'experimental'
    d['extensions']['org.cad-preview.migration/1']['fromAdapter']=deepcopy(d['adapter'])
    d['adapter']['version']='2.0.0'
    d['adapter']['implementationHash']=digest({'v1':d['adapter']['implementationHash'],**{name:hashlib.sha256((Path(__file__).parent/name).read_bytes()).hexdigest() for name in ['migrate.py','schema/ucd-2.0.schema.json']}})
    s['completeness']='experimental';seal(e);_validate(e,sink);return e
