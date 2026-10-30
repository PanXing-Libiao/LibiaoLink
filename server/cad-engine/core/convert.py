"""Independent EASM-to-viewer adapter. No eDrawings libraries are loaded."""
import array, base64, hashlib, io, json, math, posixpath, re, sys, time, zipfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent/'parser'))
from hsf import HsfReader
from glb import SceneExporter, IDENTITY, matrix12, multiply
try:
    from unified import stageprof
except Exception:
    stageprof=None
LIMIT=128*1024*1024
VERIFIED_VERSIONS=('V7.00','V8.05','V10.02','V18.00','V19.00','V19.10')
VERSION_ERROR='当前查看接口只接入已原生逐实例对照的HSF版本（V7.00 / V8.05 / V10.02 / V18.00 / V19.00 / V19.10）；其他版本未验收'

def match_version(stream):
    found=re.match(rb';; HSF (V[0-9]+\.[0-9]+) ',stream)
    if not found:return False
    return found.group(1).decode('ascii') in VERIFIED_VERSIONS

def pack(values,code,binary=False):
    result=array.array(code,values)
    if sys.byteorder!='little':result.byteswap()
    raw=result.tobytes()
    return raw if binary else base64.b64encode(raw).decode('ascii')

def convert(data,name,configuration=None,display_state=None,*,allow_experimental=True,binary=False):
    prof=stageprof.profiler() if stageprof else None
    if len(data)>64*1024*1024:raise ValueError('文件超过64MB限额')
    if Path(name).suffix.lower()!='.easm':raise ValueError('独立候选服务仅接收EASM')
    if data.startswith(b';; HSF'):em=data
    else:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            matches=[i for i in archive.infolist() if i.filename=='eModel']
            if len(matches)!=1:raise ValueError('必须有唯一eModel，嵌套容器尚未接入')
            if matches[0].file_size>LIMIT:raise ValueError('eModel超过128MB限额')
            em=archive.read(matches[0])
    # Only stream versions that each have a native per-instance comparison are accepted; the
    # coverage and its samples are recorded in 09_跨文件验证/native-version-coverage.json.
    if not match_version(em):raise ValueError(VERSION_ERROR)
    if prof:prof.mark('easm.container',sourceBytes=len(data),emodelBytes=len(em))
    reader=HsfReader(em).run()
    if prof:prof.mark('easm.hsf-decode',records=sum(reader.histogram.values()),segments=len(reader.nodes),shapes=len(reader.shapes),tags=len(reader.tags))
    if not reader.terminated or reader.p!=len(reader.data):raise ValueError('HSF未完整终止或存在尾随数据')
    exporter=SceneExporter(reader)
    if prof:prof.mark('easm.scene-graph',configurations=len(exporter.configurations),nodes=len(exporter.node_index) if hasattr(exporter,'node_index') else None)
    selection=None;selected_state=None
    if len(exporter.configurations)>1:
        if not allow_experimental:raise ValueError('此入口未接入配置/显示状态实验，请使用旧实验链路')
        from states import manifest,apply
        selection=manifest(reader,exporter)
        config=configuration or selection['defaultConfiguration']
        selected_state=apply(reader,selection,config,display_state)
        exporter=SceneExporter(reader)
        selection={**selection,'configurations':[{**c,'states':[{k:v for k,v in st.items() if k not in ('overrides','foreignOverrides')} for st in c['states']]} for c in selection['configurations']]}
    else:
        config=exporter.configurations[0]
        if configuration not in (None,config) or display_state is not None:raise ValueError('此文件没有可选配置或显示状态')
    meshes={};sequence=0;occurrences=0;hidden=0
    mesh_stats={'calls':0,'seconds':0.0}
    def mesh(path):
        if path in meshes:return path
        started=time.perf_counter()
        positions=[];indices=[];colors=[];colored=True
        for index in reader.nodes[path].shapes:
            geo=exporter.resolved_geometry(index);offset=len(positions)//3
            positions.extend(geo['points']);indices.extend(i+offset for i in geo['indices'])
            if 'colors' in geo:colors.extend(geo['colors'])
            else:colored=False
        if not positions or not indices or not all(math.isfinite(x) for x in positions):raise ValueError('无效几何')
        if min(indices)<0 or max(indices)>=len(positions)//3:raise ValueError('网格引用越界')
        result={'positions':pack(positions,'f',binary),'indices':pack(indices,'I',binary),'vertices':len(positions)//3,'triangles':len(indices)//3}
        if colored:
            if len(colors)!=len(positions):raise ValueError('顶点色长度不符')
            result['colors']=pack((round(max(0,min(1,c))*255) for c in colors),'B',binary)
        meshes[path]=result
        mesh_stats['calls']+=1;mesh_stats['seconds']+=time.perf_counter()-started
        return path
    def visit(path,persistent,value,known,rgb,ancestors):
        nonlocal sequence,occurrences,hidden
        if path in ancestors or len(ancestors)>256:raise ValueError('场景循环或层级过深')
        sequence+=1
        if sequence>500000:raise ValueError('实例数量超过限额')
        node=reader.nodes[path];attrs=exporter.attributes(path);identifier='instance-'+str(sequence)
        persistent,value,known=exporter.visibility_state(path,persistent,value,known);rgb=attrs.get('color',rgb)
        visible=exporter.face_visible(value,known)
        children=[]
        if node.shapes:
            children.append({'id':identifier+'/geometry','name':exporter.name(node)+' · 几何','sourcePath':path,'mesh':mesh(path),'visible':visible,'color':rgb})
            occurrences+=1;hidden+=not visible
        for child in node.children+[i['path'] for i in node.includes]:
            entry=visit(child,persistent,value,known,rgb,ancestors|{path})
            if entry:children.append(entry)
        if not children:return None
        return {'id':identifier,'name':exporter.name(node),'sourcePath':path,'matrix16':matrix12(attrs['matrix']) if 'matrix'in attrs else IDENTITY,'children':children}
    chain=[];p=posixpath.dirname(config)
    while True:
        chain.append(p)
        if p=='/':break
        p=posixpath.dirname(p)
    world=IDENTITY;persistent=value=known=0;rgb=[.48,.51,.55]
    for path in reversed(chain):
        attrs=exporter.attributes(path)
        if 'matrix'in attrs:world=multiply(world,matrix12(attrs['matrix']))
        persistent,value,known=exporter.visibility_state(path,persistent,value,known);rgb=attrs.get('color',rgb)
    walk_started=time.perf_counter()
    tree=visit(config,persistent,value,known,rgb,set())
    if prof:prof.mark('easm.instance-walk',seconds=round(time.perf_counter()-walk_started,4),meshCalls=mesh_stats['calls'],meshSeconds=round(mesh_stats['seconds'],4),meshDefinitions=len(meshes),geometryInstances=occurrences,hiddenInstances=hidden)
    if tree is None:raise ValueError('没有三角几何对象')
    camera=next((v for v in reader.views if v['name']=='default'),None)
    view=None if camera is None else {'position':camera['values'][:3],'target':camera['values'][3:6],'up':camera['values'][6:9]}
    return {'name':name,'format':'eDrawings','selection':selection,'selectedConfiguration':config,'selectedDisplayState':selected_state,'quality':'实验功能未验收 · 配置/显隐' if selection else '独立解析候选 · 单配置','candidate':True,'unit':'源坐标（单位未独立核验）','sourceSHA256':hashlib.sha256(data).hexdigest(),'note':'不调用eDrawings库。共享定义保留独立实例；HSF V18.00/V19.00/V19.10候选语法，每个版本均有原生逐实例对照样本（09_跨文件验证/native-version-coverage.json）；配置/显示状态为未验收实验实现，仅有H12/H51有限案例对照，未声明任意EASM通过。材质、法线、业务名称和原软件界面仍未全面验收；隐藏对象保留，可恢复。','view':view,'meshes':meshes,'root':{'id':'source-root','name':name,'matrix16':world,'children':[tree]},'stats':{'geometryObjects':len(reader.shapes),'tags':len(reader.tags),'meshDefinitions':len(meshes),'geometryInstances':occurrences,'initialHiddenInstances':hidden,'configuration':config,'nativeDependency':False},'limitations':dict(reader.notes)}

if __name__=='__main__':
    try:print(json.dumps(convert(sys.stdin.buffer.read(64*1024*1024+1),sys.argv[1],*(json.loads(sys.argv[2]) if len(sys.argv)>2 else [])),ensure_ascii=False,allow_nan=False))
    except Exception as error:
        print(json.dumps({'error':str(error)},ensure_ascii=False));sys.exit(1)
