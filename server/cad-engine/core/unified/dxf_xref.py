"""XREF modelspace loading over ezdxf 1.4.2, with original source provenance.

The resolver sees only uploaded bytes. Loader performs resource/handle copying;
its LoadingCommand hook records provenance and copy failures without binding or
rewriting the source files. No filesystem or network path from a DXF is opened.
"""
import hashlib
from pathlib import Path, PurePosixPath
import posixpath
import tempfile

from .adapter import identity
from . import dxf_recovery, dxf_dwg, dxf_semantics
from .dxf_runtime import require_engine

MAX_DEPTH = 8
MAX_RECORDS = 20000


def match_file(requested, owner, files):
    requested = requested.replace('\\', '/')
    relative = posixpath.normpath(posixpath.join(posixpath.dirname(owner), requested))
    for path, method in [(relative, 'relative-path'), (requested, 'provided-path')]:
        if path in files:
            return path, method, []
    candidates = [name for name in files if name.casefold() == relative.casefold()]
    method = 'case-insensitive-path'
    if not candidates:
        basename = PurePosixPath(requested).name.casefold()
        candidates = [name for name in files if PurePosixPath(name).name.casefold() == basename]
        method = 'unique-basename'
    if len(candidates) == 1:
        return candidates[0], method, []
    return None, 'ambiguous' if candidates else 'missing', sorted(candidates)


def source_origins(doc, sid, chain, name, source_format='DXF'):
    from . import dxf_scale
    scale_state=dxf_scale.read(doc)
    origins = {}
    layouts = {layout.block_record_handle: 'MODEL' if layout.is_modelspace else 'PAPER:' + layout.name
               for layout in doc.layouts}
    for block in doc.blocks:
        space = layouts.get(block.block_record_handle, 'BLOCK:' + block.name)
        for index, entity in enumerate(block):
            for item in [entity, *getattr(entity, 'attribs', [])]:
                handle = str(item.dxf.handle)
                origins[handle] = {'sourceRefs': [{'sourceId': sid, 'objectKey': handle,
                    'path': source_format + '/' + space + '/' + handle, 'recordOffset': index}], 'chain': chain}
    for entity in doc.entitydb.values():
        if entity is None or not entity.is_alive or not entity.dxf.handle:
            continue
        handle = str(entity.dxf.handle)
        origins.setdefault(handle, {'sourceRefs': [{'sourceId': sid, 'objectKey': handle,
            'path': source_format + '/' + entity.dxftype() + '/' + handle}], 'chain': chain})
        origins[handle]['logicalSourcePath'] = name
        origins[handle]['codepage'] = doc.encoding
        if entity.has_extension_dict:
            try:
                contexts=dxf_scale.object_contexts(entity,scale_state)
                if contexts: origins[handle]['annotationContexts']=contexts
            except ValueError as error: origins[handle]['annotationContextError']=str(error)
        if hasattr(entity,'graphic_properties') or entity.dxftype()=='LAYER':
            from .dxf_plotstyles import trait
            origins[handle]['plotTrait'] = trait(entity)
        if entity.dxftype() in ('MTEXT','TEXT','ATTRIB','ATTDEF'):
            from .dxf_mtext import field_info
            fields = field_info(entity, sid)
            if fields is not None:
                origins[handle]['mtextFields'] = fields
        if entity.dxftype() == 'INSERT':
            from .dxf_clipping import block_clip
            try:
                origins[handle]['blockClip'] = block_clip(entity)
            except ValueError as error:
                origins[handle]['blockClipError'] = str(error)
        if entity.dxftype() in ('IMAGE', 'PDFUNDERLAY', 'DGNUNDERLAY', 'DWFUNDERLAY'):
            definition = entity.image_def if entity.dxftype() == 'IMAGE' else entity.get_underlay_def()
            if definition is not None:
                origins[handle]['mediaDefinition'] = {'filename': definition.dxf.filename,
                    'name': definition.dxf.get('name', '') if entity.dxftype() != 'IMAGE' else '',
                    'sourceUnits': doc.units, 'sourceRefs': [{'sourceId': sid,
                    'objectKey': str(definition.dxf.handle), 'path': source_format + '/' + definition.dxftype() + '/' + str(definition.dxf.handle)}]}
        if entity.dxf.is_supported('style'):
            style = doc.styles.get(entity.dxf.get('style', 'Standard')) if doc.styles.has_entry(entity.dxf.get('style', 'Standard')) else None
            if style:
                origins[handle]['fontStyle'] = {'name': style.dxf.name, 'font': style.dxf.get('font', 'txt'),
                    'bigfont': style.dxf.get('bigfont', ''), 'flags': style.dxf.get('flags', 0),
                    'sourceRefs': [{'sourceId': sid, 'objectKey': str(style.dxf.handle), 'path': source_format + '/STYLE/' + str(style.dxf.handle)}]}
    return origins


class State:
    def __init__(self, doc, raw, name, chain, root_sha, recovery=None, decoded=None, facts_raw=None):
        sha = hashlib.sha256(raw).hexdigest()
        self.doc, self.name, self.sha = doc, name, sha
        self.chain, self.root_sha = chain, root_sha
        self.sid = 'source-' + sha
        source_format = 'DWG' if decoded else 'DXF'
        source = {'id': self.sid, 'name': name, 'sha256': sha, 'byteLength': len(raw), 'format': source_format}
        if not recovery or recovery.get('sourceVersion') is not None:
            source['detectedVersion'] = decoded['sourceVersion'] if decoded else doc.dxfversion
        self.sources = {self.sid: source}
        self.source_facts = {self.sid: dxf_semantics.snapshot(doc, self.sid, facts_raw if facts_raw is not None else raw,source_format)}
        if decoded:self.source_facts[self.sid]['decodePolicy']='attributes/tags from the recorded DWG decoder; sourceId and exported handles identify the original DWG'
        self.base_origins = source_origins(doc, self.sid, chain, name, source_format) if chain or any(
            b.block.is_xref or b.block.is_xref_overlay for b in doc.blocks) else {}
        self.shape_libraries = [{'sourceId': self.sid, 'chain': chain, 'logicalSourcePath': name,
            'font': style.dxf.font, 'sourceRefs': [{'sourceId': self.sid, 'objectKey': str(style.dxf.handle),
            'path': source_format + '/STYLE/' + str(style.dxf.handle)}]} for style in doc.styles.shx_files.values()]
        self.origins = {}
        self.references = {}
        self.failures = []
        self.notes = []
        self.recovery = recovery
        self.decoders = [{**decoded, 'sourceId': self.sid, 'chain': chain}] if decoded else []

    def origin(self, handle):
        return self.origins.get(str(handle), self.base_origins.get(str(handle)))

    def item_id(self, prefix, handle, fallback):
        origin = self.origins.get(str(handle))
        if not origin:
            return identity(prefix, fallback)
        return identity(prefix, [self.root_sha, 'xref', origin['chain'], origin['sourceRefs']])


def load_references(doc, raw, name, files=None, recovery=None):
    require_engine()
    root_sha = hashlib.sha256(raw).hexdigest()
    files = dict(files or {})
    files.setdefault(name, raw)

    def resolve(doc, raw, name, chain, stack, recovery=None, decoded=None, facts_raw=None):
        from ezdxf import xref
        from ezdxf.entities import is_graphic_entity
        state = State(doc, raw, name, chain, root_sha, recovery, decoded,facts_raw)
        definitions = [block for block in doc.blocks if block.block.is_xref or block.block.is_xref_overlay]
        for block in definitions:
            original_handle = str(block.block.dxf.handle)
            requested = str(block.block.dxf.get('xref_path', '') or '')
            ref_id = identity('xref', [state.sha, block.name, requested] if not chain
                              else [root_sha, chain, state.sha, block.name, requested])
            row = {'id': ref_id, 'ownerSourceId': state.sid, 'requestedPath': requested,
                   'status': 'missing', 'required': True, 'reason': 'XREF 配套文件未提供',
                   'blockName': block.name, 'sourceRefs': state.base_origins[original_handle]['sourceRefs'],
                   'type': 'overlay' if block.block.is_xref_overlay else 'attachment', 'chain': chain}
            state.references[original_handle] = row
            if chain and block.block.is_xref_overlay:
                row.update(status='blocked', required=False, reason='nested-overlay-excluded')
                block.delete_all_entities()
                continue
            if not requested:
                row.update(status='blocked', reason='xref-path-empty')
                continue
            path, method, candidates = match_file(requested, name, files)
            row['match'] = method
            if not path:
                row.update(status='ambiguous' if candidates else 'missing', candidates=candidates,
                           reason='同名配套文件不唯一，请保留相对目录' if candidates else 'XREF 配套文件未提供')
                continue
            row['logicalPath'] = path
            suffix = PurePosixPath(path).suffix.lower()
            if suffix not in ('.dxf', '.dwg'):
                row.update(status='blocked', reason='xref-format-unsupported: requires DXF or DWG bytes')
                continue
            child_raw = files[path]
            child_sha = hashlib.sha256(child_raw).hexdigest()
            row['sha256'] = child_sha
            if child_sha in stack:
                row.update(status='blocked', reason='xref-cycle: 循环引用未加载')
                continue
            if len(chain) >= MAX_DEPTH:
                row.update(status='blocked', reason='xref-depth-limit')
                continue
            copy_started = False
            try:
                decoded = None
                parse_raw = child_raw
                if suffix == '.dwg':
                    parse_raw, decoded = dxf_dwg.decode(child_raw)
                    row['decoder'] = decoded
                with tempfile.TemporaryDirectory(prefix='dxf-xref-read-') as folder:
                    source_path = Path(folder) / 'source.dxf'
                    source_path.write_bytes(parse_raw)
                    child_doc, child_recovery = dxf_recovery.load_dxf(source_path, parse_raw)
                if (decoded['sourceVersion'] if decoded else child_doc.dxfversion) > doc.dxfversion:
                    row.update(status='blocked', reason='xref-version-newer-than-host')
                    continue
                if child_recovery:
                    row.update(status='blocked', reason='xref-source-requires-recovery: 配套残片未作为完整外参加载')
                    continue
                child = resolve(child_doc, child_raw, path, chain + [ref_id], stack + [child_sha], decoded=decoded,facts_raw=parse_raw)
                if sum(len(b) for b in doc.blocks) + sum(len(b) for b in child.doc.blocks) > MAX_RECORDS:
                    row.update(status='blocked', reason='xref-record-limit')
                    continue
                existing_handles = set(doc.entitydb)
                # _Transfer.get_block_name returns an unchanged name when no
                # source definition exists. Isolate dangling source INSERTs so
                # they cannot accidentally bind to an unrelated host block.
                for entity in list(child.doc.entitydb.values()):
                    if entity is None or not entity.is_alive or entity.dxftype() != 'INSERT' or entity.dxf.name in child.doc.blocks:
                        continue
                    old_name = entity.dxf.name
                    original = child.origin(entity.dxf.handle)
                    child.origins[entity.dxf.handle] = {**original, 'missingBlockName': original.get('missingBlockName', old_name)}
                    isolated = '__XREF_MISSING_' + identity('block', [root_sha, chain, child.sha, old_name]).split('-', 1)[1]
                    while isolated in doc.blocks or isolated in child.doc.blocks:
                        isolated += '_'
                    entity.dxf.name = isolated

                class Origins(xref.LoadingCommand):
                    def register_resources(self, registry):
                        if any(getattr(e,'proxy_graphic',None) for e in child.doc.entitydb.values() if e is not None):
                            # Proxy binary traits use source table indices, which
                            # are opaque to Loader's normal resource scanner.
                            for layer in child.doc.layers: registry.add_layer(layer.dxf.name)
                            for linetype in child.doc.linetypes: registry.add_linetype(linetype.dxf.name)

                    def execute(self, transfer):
                        # Public LoadingCommand receives the pinned transfer object.
                        # Resource copying/renaming stays entirely in upstream Loader.
                        dependent_layers = {}
                        for source_layer in child.doc.layers:
                            source_name = source_layer.dxf.name
                            copied_name = transfer.get_layer(source_name)
                            if copied_name == source_name:
                                continue  # upstream shares the special layer 0
                            dependent = block.name + '|' + source_name
                            dependent_layers[copied_name.casefold()] = dependent
                            if not doc.layers.has_entry(dependent):
                                doc.layers.get(copied_name).rename(dependent)
                        for old, new in transfer.handle_mapping.items():
                            origin = child.origin(old)
                            if origin and new in doc.entitydb and new not in existing_handles:
                                state.origins[new] = origin
                                source_entity = child.doc.entitydb.get(old)
                                clone = doc.entitydb[new]
                                # A host's dependent layer (Part|Steel) owns its
                                # display overrides. Bind copied graphics to that
                                # actual layer, including viewport overrides,
                                # rather than discarding or duplicating its state.
                                if is_graphic_entity(clone):
                                    dependent = dependent_layers.get(clone.dxf.layer.casefold())
                                    if dependent:
                                        clone.dxf.layer = doc.layers.get(dependent).dxf.name
                                if hasattr(source_entity, 'all_sub_entities') and hasattr(clone, 'all_sub_entities'):
                                    originals, copies = list(source_entity.all_sub_entities()), list(clone.all_sub_entities())
                                    if len(originals) != len(copies):
                                        raise ValueError('xref-subentity-provenance-mismatch')
                                    # LinkedEntities.copy_data preserves this order;
                                    # its own map_resources uses the same pairing.
                                    for original, copied in zip(originals, copies):
                                        sub_origin = child.origin(original.dxf.handle)
                                        if sub_origin:
                                            state.origins[copied.dxf.handle] = sub_origin
                            if old in child.references and new in doc.entitydb:
                                state.references[new] = child.references[old]
                        model_owner = child.doc.modelspace().block_record_handle

                        def target_owner(owner):
                            return block.block_record_handle if owner == model_owner else transfer.get_handle(owner)

                        for source_block in transfer.registry.source_blocks.values():
                            for entity in source_block.values():
                                if is_graphic_entity(entity) and transfer.get_entity_copy(entity) is None:
                                    if entity.dxftype() == 'OLE2FRAME':
                                        from ezdxf.entities import factory
                                        from ezdxf.lldxf.tags import Tags
                                        clone=factory.new('OLE2FRAME',doc=doc,dxfattribs=entity.graphic_properties())
                                        clone.acdb_ole2frame=Tags(entity.acdb_ole2frame) if entity.acdb_ole2frame is not None else None
                                        clone.dxf.layer=transfer.get_layer(entity.dxf.layer)
                                        clone.dxf.layer=dependent_layers.get(clone.dxf.layer.casefold(),clone.dxf.layer)
                                        clone.dxf.linetype=transfer.get_linetype(entity.dxf.linetype)
                                        target=target_owner(entity.dxf.owner)
                                        layout=next(b for b in doc.blocks if b.block_record_handle==target)
                                        layout.add_entity(clone)
                                        state.origins[clone.dxf.handle]=child.origin(entity.dxf.handle)
                                        continue
                                    if entity.dxftype() == 'ACAD_PROXY_ENTITY' and entity.proxy_graphic:
                                        from ezdxf.entities import factory
                                        from ezdxf.lldxf.tags import Tags
                                        # A display derivative only: never copy
                                        # opaque application objects/handle data.
                                        clone = factory.new('ACAD_PROXY_ENTITY',doc=doc,
                                            dxfattribs=entity.graphic_properties())
                                        clone.proxy_graphic = entity.proxy_graphic
                                        clone.acdb_proxy_entity = Tags([(100,'AcDbProxyEntity')])
                                        target = target_owner(entity.dxf.owner)
                                        layout = next(b for b in doc.blocks if b.block_record_handle == target)
                                        clone.dxf.layer = transfer.get_layer(entity.dxf.layer)
                                        clone.dxf.layer = dependent_layers.get(clone.dxf.layer.casefold(),clone.dxf.layer)
                                        clone.dxf.linetype = transfer.get_linetype(entity.dxf.linetype)
                                        layout.add_entity(clone)
                                        origin = child.origin(entity.dxf.handle)
                                        old_tables = origin.get('proxyTables',{'layers':[e.dxf.name for e in child.doc.layers],
                                            'linetypes':[e.dxf.name for e in child.doc.linetypes], 'plotStyles':list(child.doc.plotstyles.keys()), 'encoding':child.doc.encoding})
                                        def layer_name(name):
                                            mapped = transfer.get_layer(name)
                                            return dependent_layers.get(mapped.casefold(),mapped)
                                        maps = {'layers':{name:layer_name(name) for name in old_tables['layers']},
                                                'linetypes':{name:transfer.get_linetype(name) for name in old_tables['linetypes']}}
                                        name_maps = {kind:{original:maps[kind].get(mapped,mapped) for original,mapped in
                                            old_tables.get('nameMaps',{}).get(kind,{}).items()} for kind in maps}
                                        for kind in maps:
                                            for name,mapped in maps[kind].items(): name_maps[kind].setdefault(name,mapped)
                                        state.origins[clone.dxf.handle] = {**origin,'proxyTables':{
                                            'layers':[layer_name(name) for name in old_tables['layers']],
                                            'linetypes':[transfer.get_linetype(name) for name in old_tables['linetypes']],
                                            'plotStyles':old_tables.get('plotStyles',list(child.doc.plotstyles.keys())),
                                            'encoding':old_tables['encoding'], 'nameMaps':name_maps}}
                                        continue
                                    state.failures.append({'ownerHandle': target_owner(entity.dxf.owner),
                                        'sourceKind': entity.dxftype(), 'reason': 'ezdxf-xref-copy-unsupported',
                                        **child.origin(entity.dxf.handle)})
                        for failure in child.failures:
                            state.failures.append({**failure, 'ownerHandle': target_owner(failure['ownerHandle'])})

                loader = xref.Loader(child.doc, doc, conflict_policy=xref.ConflictPolicy.XREF_PREFIX)
                loader.load_modelspace(block)
                loader.add_command(Origins())
                copy_started = True
                cached_records = len(block)
                # Selected companion bytes are authoritative. Keep the cached
                # content only when the companion could not be resolved/parsed;
                # never combine an old picture with the newly selected version.
                block.delete_all_entities()
                loader.execute(xref_prefix=block.name)
                # This is the same base-point update as pinned xref.embed().
                origin = child.doc.header.get('$INSBASE')
                if origin is not None:
                    block.block.dxf.base_point = origin
                state.sources.update(child.sources)
                state.source_facts.update(child.source_facts)
                state.shape_libraries.extend(child.shape_libraries)
                state.decoders.extend(child.decoders)
                reason = 'ezdxf 1.4.2 xref.Loader 已加载模型空间'
                if decoded:
                    reason += '；LibreDWG ' + dxf_dwg.VERSION + (' 解码报告含损失，预览不完整' if decoded['status'] == 'partial' else ' DWG 原件解码')
                row.update(status='resolved', reason=reason,
                           resolvedSourceId=child.sid, replacedCachedRecords=cached_records)
            except Exception as error:
                if copy_started:
                    raise ValueError('xref-copy-failed: ' + requested + ': ' + str(error)) from error
                row.update(status='blocked', reason='xref-load-error: ' + type(error).__name__ + ': ' + str(error))
        return state

    return resolve(doc, raw, name, [], [root_sha], recovery)
