"""Upload-set-only native DWG references; source geometry and INSERT matrices stay authoritative."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess

from .dxf_resources import match_file
from .canonical import canonical_sha256

IDENTITY=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
INHERITANCE='org.cad-preview.style-inheritance/1'
NATIVE='org.libiaolink.dwg/1'
COVERAGE='org.cad-preview.drawing-coverage/1'


def scoped_id(scope, original):
    return original.split('-',1)[0]+'-xref-'+hashlib.sha256((scope+'\0'+original).encode()).hexdigest()[:32]


def renamed(value, ids, key='', parent=''):
    if isinstance(value,dict):
        return {ids.get(k,k):renamed(v,ids,k,key) for k,v in value.items()}
    if isinstance(value,list):return [renamed(v,ids,key,parent) for v in value]
    if isinstance(value,str) and (key=='id' or key.endswith(('Id','Ids')) or key in ('ancestors','extensionsRequired','indices') or parent in ('attributes','materialSlots')
                                or key=='value' and parent.endswith(('Id','Ids'))):
        return ids.get(value,value)
    return value


class NativeResources:
    def __init__(self, files, folder, dotnet, reader):
        self.files=files;self.folder=Path(folder);self.dotnet=dotnet;self.reader=reader
        self.fonts={name:raw for name,raw in files.items() if PurePosixPath(name).suffix.lower() in ('.shx','.shp','.ttf','.otf','.ttc')}
        self.native={};self.serial=0

    def loader(self, logical, stack):
        return lambda doc,data:self.load(doc,data,logical,stack)

    def child(self, logical, stack):
        from .dwg_adapter import assemble_native,run_reader
        raw=self.files[logical]
        if logical not in self.native:
            directory=self.folder/hashlib.sha256(logical.encode()).hexdigest()
            directory.mkdir(parents=True,exist_ok=True)
            source=directory/PurePosixPath(logical).name
            source.write_bytes(raw)
            native=directory/'native'
            run_reader(self.dotnet,self.reader,source,native)
            self.native[logical]=(source,native)
        source,native=self.native[logical];self.serial+=1
        output=self.folder/('assembled-'+str(self.serial))
        artifact=assemble_native(native,source,output,font_files=self.fonts,logical_path=logical,
                                resource_loader=self.loader(logical,stack))
        packet=json.loads(artifact.read_bytes())
        return packet['document'],(native/'positions.bin').read_bytes()

    def load(self, doc, data, logical, stack):
        drawing=doc['drawing'];native=doc['extensions'][NATIVE]
        references=[];loaded_blocks=set();initial_instances=list(drawing['blockInstances'].values())
        for row in list(doc['externalReferences']):
            block_id=next(key for key,value in drawing['blocks'].items() if value.get('externalReferenceId')==row['id'])
            block=drawing['blocks'][block_id];meta=native['externalReferences'][block_id]
            detail={**row,'blockName':block['name'],'type':'overlay' if meta['overlay'] else 'attachment'}
            references.append(detail)
            if len(stack)>1 and meta['overlay']:
                row.update(status='blocked',required=False,reason='nested-overlay-excluded')
            else:
                path,method,candidates=match_file(row['requestedPath'],logical,self.files)
                detail.update(match=method,candidates=candidates)
                if path is None:
                    row.update(status='ambiguous' if candidates else 'missing',reason='配套文件重名，无法唯一匹配' if candidates else '此引用的配套文件尚未提供')
                elif not path.lower().endswith('.dwg'):
                    row.update(status='blocked',logicalPath=path,reason='原生 DWG 外参目前只加载 DWG 配套文件')
                else:
                    sha=hashlib.sha256(self.files[path]).hexdigest()
                    if sha in stack:
                        row.update(status='blocked',logicalPath=path,reason='xref-cycle')
                    elif len(stack)>=8:
                        row.update(status='blocked',logicalPath=path,reason='xref-depth-limit')
                    else:
                        try:
                            child,buffer=self.child(path,[*stack,sha])
                        except (OSError,ValueError,RuntimeError,subprocess.SubprocessError) as error:
                            row.update(status='blocked',logicalPath=path,reason='配套 DWG 原生解析失败：'+type(error).__name__)
                        else:
                            data=self.attach(doc,data,child,buffer,block_id,path)
                            row.update(status='resolved',logicalPath=path,reason='已加载配套原生 DWG；保留源基点、插入矩阵和部分预览边界')
                            loaded_blocks.add(block_id)
            detail.update(row)
            for diagnostic in doc['diagnostics']:
                if diagnostic['code']=='native-xref-unresolved' and diagnostic.get('sourceRefs')==meta['sourceRefs']:
                    diagnostic['message']=row['reason']
            if row['status']=='resolved':
                doc['diagnostics']=[d for d in doc['diagnostics'] if not (d['code']=='native-xref-unresolved' and d.get('sourceRefs')==meta['sourceRefs'])]
        own_ids={r['id'] for r in references}
        imported=[r for r in doc['extensions'].get('org.cad-preview.dxf-xref/1',{}).get('references',[]) if r['id'] not in own_ids]
        doc['extensions']['org.cad-preview.dxf-xref/1']={'references':[*references,*imported]}
        count=len({i['sourceRefs'][0]['objectKey'] for i in initial_instances if i['definitionId'] in loaded_blocks})
        geometry=doc['extensions'][COVERAGE]['displayGeometry'];reason=geometry['byReason']
        reason['externalReferenceUnresolved']-=count;reason['unresolved']-=count
        reason['blockInstanceIndirect']+=count
        if 'XREF' in reason['unsupported']:
            reason['unsupported']['XREF']-=count
            if not reason['unsupported']['XREF']:del reason['unsupported']['XREF']
        geometry['withDisplayGeometry']+=count;geometry['withoutDisplayGeometry']-=count
        geometry['status']='partial' if geometry['withoutDisplayGeometry'] else 'complete'
        digest=hashlib.sha256(data).hexdigest()
        doc['buffers']['buffer-0'].update(sha256=digest,byteLength=len(data))
        return data

    def attach(self, doc, data, child, buffer, block_id, logical):
        drawing=doc['drawing'];source_drawing=child['drawing'];root_id=next(iter(drawing['drawings']))
        scope=block_id+'\0'+logical
        ids={'drawing-dwg':root_id,'buffer-0':'buffer-0'}
        for table,rows in child.items():
            if isinstance(rows,dict) and table!='extensions':
                for key,value in rows.items():
                    if isinstance(value,dict) and (value.get('id')==key or table=='accessors'):ids[key]=scoped_id(scope,key)
        for rows in source_drawing.values():
            for key in rows:ids[key]=scoped_id(scope,key)
        ids['drawing-dwg']=root_id
        for table in ('sources','evidence','externalReferences'):
            for row in child[table]:ids[row['id']]=scoped_id(scope,row['id'])
        for key in child['extensions'][NATIVE]['fonts']:
            ids.setdefault('textstyle-'+key,scoped_id(scope,'textstyle-'+key))
        layer_names={row['name']:key for key,row in drawing['layers'].items()}
        host_name=drawing['blocks'][block_id]['name']
        reused=set()
        for key,row in source_drawing['layers'].items():
            name=host_name+'|'+row['name']
            if name in layer_names:ids[key]=layer_names[name];reused.add(key)
        model=next(iter(source_drawing['drawings'].values()))['modelSpaceId']
        # Ordinary draws derive their default representation from the item ID.
        # Preserve that relation after namespacing, without changing source geometry.
        for table in ('entities','annotations'):
            for key in source_drawing[table]:
                representation='representation-'+canonical_sha256([key])
                if representation in child['representations']:
                    ids[representation]='representation-'+canonical_sha256([ids[key]])
        imported=renamed(child,ids)
        padding=(-len(data))%8;offset=len(data)+padding
        data+=b'\0'*padding+buffer
        for accessor in imported['accessors'].values():accessor['bufferId']='buffer-0';accessor['byteOffset']+=offset
        for table in ('accessors','geometries','representations','resources','materials','properties'):
            doc[table].update(imported[table])
        for table,rows in imported['drawing'].items():
            if table not in ('drawings','layouts','sheets','viewports'):
                if table=='layers':
                    for old,row in source_drawing['layers'].items():
                        if old not in reused:
                            layer=rows[ids[old]];layer['name']=host_name+'|'+row['name'];drawing[table][ids[old]]=layer
                else:drawing[table].update(rows)
        model_id=ids[model];model_block=scoped_id(scope,'block-imported-model')
        drawing['spaces'][model_id].update(kind='block',ownerId=model_block)
        drawing['blocks'][model_block]={'id':model_block,'drawingId':root_id,'name':host_name+'|*Model_Space',
            'spaceId':model_id,'basePoint':[0,0,0],'units':imported['coordinates']['lengthUnit'],'dynamicParameters':{}}
        mount=scoped_id(scope,'instance-imported-model')
        layer=next(key for key,row in drawing['layers'].items() if row['name']=='0')
        original=doc['extensions'][NATIVE]['externalReferences'][block_id]
        instance={'id':mount,'ownerSpaceId':drawing['blocks'][block_id]['spaceId'],'definitionId':model_block,
            'layerId':layer,'localFromBlock':IDENTITY[:],'attributes':{},'style':{'color':{'mode':'by-block'},'plot':True},'sourceRefs':original['sourceRefs']}
        drawing['blockInstances'][mount]=instance
        drawing['spaces'][instance['ownerSpaceId']]['blockInstanceIds'].append(mount)
        drawing['drawings'][root_id]['layerIds']=list(drawing['layers'])
        for table in ('sources','evidence','externalReferences'):doc[table].extend(imported[table])
        doc['diagnostics'].extend(imported['diagnostics'])
        ext=doc['extensions'];incoming=imported['extensions']
        for name in (INHERITANCE,'org.cad-preview.annotation-presentation/1','org.cad-preview.fill/1','org.libiaolink.dwg-text/1'):
            if name not in incoming:continue
            target=ext.setdefault(name,{})
            for key,value in incoming[name].items():
                if isinstance(value,dict):target.setdefault(key,{}).update(value)
                else:target.setdefault(key,value)
        for key in ids.values():
            if key in drawing['layers'] and drawing['layers'][key]['name']!='0':ext[INHERITANCE]['layerInheritance'].pop(key,None)
        ext[INHERITANCE]['modes'][mount]={'lineType':'by-block','lineWeight':'by-block'}
        ext[INHERITANCE]['entityState'][mount]={'opacityMode':'by-block'}
        target=ext[NATIVE];facts=incoming[NATIVE]
        for key in ('nativeGeometry','layerLineWeights','dimensionSemantics','multiLeaderSemantics','hatchSemantics','hatchPatternOutcomes','meshPresentations','textAppearance','opaque','proxyGraphics','blockClips','externalReferences'):
            target.setdefault(key,{}).update(facts.get(key,{}))
        for key,value in child['extensions'][NATIVE]['fonts'].items():
            target['fonts'][ids['textstyle-'+key].removeprefix('textstyle-')]=renamed(value,ids)
        sid=ids['source-0']
        target.setdefault('sourceDocuments',{})[sid]={'logicalPath':logical,'native':facts,'coverage':incoming[COVERAGE]}
        target['sourceDocuments'].update(facts.get('sourceDocuments',{}))
        ext[COVERAGE]['losses'].extend({**loss,'sourceId':sid} for loss in incoming[COVERAGE]['losses'])
        more=incoming.get('org.cad-preview.dxf-xref/1',{}).get('references',[])
        ext.setdefault('org.cad-preview.dxf-xref/1',{'references':[]})['references'].extend(more)
        return data
