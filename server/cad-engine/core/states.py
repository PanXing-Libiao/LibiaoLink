"""Visibility-only EASM state selection, independently decoded from source records."""
import re

def field(node,key):
    found=[]
    for text in node.attributes.get('options',[]):
        m=re.search(r'(?:^|,)'+re.escape(key)+r'=(`[^`]*`|[^,]*)',text)
        if m:found.append(m[1].strip('`'))
    if len(set(found))>1:raise ValueError('状态元数据冲突：'+key)
    return found[0] if found else None

def reachable(reader,configuration):
    """Source child/include reachability, not an inferred CAD product hierarchy."""
    result=set();stack=[configuration]
    while stack:
        path=stack.pop()
        if path in result:continue
        if path not in reader.nodes:raise ValueError('状态场景引用缺失')
        result.add(path);node=reader.nodes[path]
        stack.extend(node.children)
        stack.extend(include['path'] for include in node.includes)
    return result

def reject_reachable_foreign(reader,configuration,targets):
    if set(targets)&reachable(reader,configuration):
        raise ValueError('未还原的状态目标可经共享引用到达当前配置，已拒绝；不能猜测其原生语义')

def manifest(reader,exporter):
    linked=field(reader.nodes['/'],'published_link_disp_states_to_configs')
    if linked not in ('on','off'):raise ValueError('多配置文件缺少已验证的显示状态关联标记')
    configs=[];initial=[]
    for path in exporter.configurations:
        root=path.split('/sheet')[0]
        if root not in reader.nodes or not root:raise ValueError('配置层级未支持')
        container=root+'/displaystates'
        if container not in reader.nodes:raise ValueError('配置没有已验证的显示状态记录')
        default=field(reader.nodes[container],'default_linked' if linked=='on' else 'default')
        states=[]
        for sp in reader.nodes[container].children:
            node=reader.nodes[sp]
            if linked=='on' and field(node,'linked_to_this_config')!='yes':continue
            overrides=[];foreign=[];error=None;seen=set()
            for child in node.children:
                if child==sp+'/name' and len(reader.nodes[child].attributes.get('text',[]))==1:continue
                options=reader.nodes[child].attributes.get('options',[])
                if len(options)!=1: error='状态记录结构未支持';break
                m=re.fullmatch(r'path=([^,]+),vis=(on|off)',options[0])
                if not m:error='包含尚未验证的颜色、透明度或其他覆盖';break
                target='/'+m[1].lstrip('/')
                if target not in reader.nodes or target in seen:error='状态目标缺失或重复';break
                seen.add(target)
                # eDrawings records whole-document visibility, so a state of one configuration can
                # name parts of another configuration (H10 holds such records). Those targets are
                # applied like the others but cannot reach the activated view: the activation hides
                # and face-locks every other configuration root (check_display_transition.py) and the
                # exporter only walks the selected configuration.
                (overrides if target.startswith(path+'/') else foreign).append((target,m[2]=='on'))
            try:reject_reachable_foreign(reader,path,[target for target,_ in foreign])
            except ValueError as failure:error=str(failure)
            states.append({'path':sp,'name':field(node,'name') or (reader.nodes[sp+'/name'].attributes.get('text',[node.name])[0] if sp+'/name' in reader.nodes else node.name),'supported':error is None,'validation':'experimental' if error is None else 'unsupported','reason':error,'overrides':overrides+foreign,'foreignOverrides':[target for target,_ in foreign]})
        selected=container+'/'+(default or '')
        if selected not in [s['path'] for s in states]:raise ValueError('默认显示状态不存在或未关联')
        configs.append({'path':path,'root':root,'name':field(reader.nodes[root],'config name') or (reader.nodes[root+'/name'].attributes.get('text',[root])[0] if root+'/name' in reader.nodes else root),'states':states,'defaultState':selected})
        persistent,value,known=exporter.visibility_state(root,0,0,0)
        if exporter.face_visible(value,known):initial.append(path)
    if len(initial)!=1:raise ValueError('无法唯一确定初始配置')
    return {'configurations':configs,'defaultConfiguration':initial[0]}

def apply(reader,selection,config,state):
    choices=[c for c in selection['configurations'] if c['path']==config]
    if len(choices)!=1:raise ValueError('未知配置')
    chosen=choices[0];state=state or chosen['defaultState']
    choices=[s for s in chosen['states'] if s['path']==state]
    if len(choices)!=1:raise ValueError('显示状态不属于所选配置')
    selected=choices[0]
    if not selected['supported']:raise ValueError(selected['reason'])
    # Recheck the actual targets, even if a caller supplied a stale/modified manifest.
    reject_reachable_foreign(reader,config,[target for target,_ in selected['overrides']
                                          if not target.startswith(config+'/')])
    # Native activation (EBhvrChangeVCT::Initialize/Finish, 09_跨文件验证/native-state-mechanism-progress.json
    # items 9-10): the activated configuration root is unlocked on the face component, the other
    # configuration roots are hidden and locked, then the state overrides are applied. The lock
    # halves travel through reader.state_locks so the exporter's stream-derived declarations keep
    # their own meaning; 09_跨文件验证/check_display_transition.py verifies the whole result against
    # the captured native net visibility for H12 and H51.
    overrides=getattr(reader,'state_locks',None)
    if overrides is None:
        overrides={};reader.state_locks=overrides
    for c in selection['configurations']:
        attr=reader.nodes[c['root']].attributes
        if c['path']==config:
            if 'visibility' in attr:
                mask,value=attr['visibility'];attr['visibility']=(mask&~1,value&~1)
            overrides[c['root']]=(1,0)
        else:
            mask,value=attr.get('visibility',(0,0));attr['visibility']=(mask|1,value&~1)
            overrides[c['root']]=(0,1)
    for target,visible in selected['overrides']:
        attr=reader.nodes[target].attributes;mask,value=attr.get('visibility',(0,0));attr['visibility']=(mask|1,(value&~1)|visible)
    return state
