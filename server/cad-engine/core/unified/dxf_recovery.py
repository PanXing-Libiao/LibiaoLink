"""Bounded ezdxf recovery; original bytes and unknown source metadata stay intact."""
from collections import Counter
import io
import math

from .dxf_runtime import require_engine


def validate_source_numbers(raw):
    """Reject non-finite numeric tags before loading or recovery can alter them.

    All DXF sources, including decoded DWG companions, enter through load_dxf.
    Inspect numeric group codes, not strings: a text value 'NaN' is legitimate.
    The pinned loaders handle both containers without introducing a DXF parser.
    """
    from ezdxf.lldxf.tagger import binary_tags_loader
    from ezdxf.lldxf.types import DOUBLE
    from ezdxf.recover import bytes_loader
    tags = (binary_tags_loader(raw) if raw.startswith(b'AutoCAD Binary DXF')
            else bytes_loader(io.BytesIO(raw)))
    for tag in tags:
        if tag.code in DOUBLE:
            try:
                value = float(tag.value)
            except ValueError:
                # Non-numeric corruption remains the regular/recovery reader's
                # responsibility and is already exposed in its recovery report.
                continue
            if not math.isfinite(value):
                raise ValueError('dxf-nonfinite-number: group ' + str(tag.code))


def _inventory(tags):
    from ezdxf.lldxf.tags import group_tags
    records = []
    block = None
    for group in group_tags(tags, 0):
        kind = group[0].value
        if kind in ('SECTION', 'ENDSEC', 'EOF'):
            continue  # HEADER group 5 is $HANDSEED, not an entity handle.
        if kind == 'BLOCK':
            block = next((tag.value for tag in group if tag.code == 2), None)
        handle = next((tag.value for tag in group if tag.code == 5), None)
        if handle:
            records.append({'handle': handle, 'type': kind, 'block': block})
        if kind == 'ENDBLK':
            block = None
    return records


def load_dxf(path, raw):
    """Use the regular reader first, except known headerless ASCII fragments.

    A missing HEADER does not establish R12: modern subclass tags require the
    modern entity loader. AC1015 is ezdxf's minimum supported modern container
    profile, NOT a detected source version. It is supplied only in memory to
    ezdxf's recovery pipeline. Auditing preserves orphan BLOCK content when the
    source has no LAYOUT objects, rather than deleting it. Previews stay Partial;
    absent units/styles/layouts are never asserted to have been recovered.
    """
    ezdxf = require_engine()
    from ezdxf import recover
    validate_source_numbers(raw)

    headerless = False
    tags = None
    if not raw.startswith(b'AutoCAD Binary DXF'):
        # Only inspect the first section on the ordinary fast path.
        try:
            prefix = iter(recover.bytes_loader(io.BytesIO(raw)))
            first, second = next(prefix), next(prefix)
            if first == (0, b'SECTION') and second != (2, b'HEADER'):
                tags = list(recover.safe_tag_loader(io.BytesIO(raw), errors='strict'))
                headerless = not any(a == (0, 'SECTION') and b == (2, 'HEADER')
                                     for a, b in zip(tags, tags[1:]))
        except (StopIteration, ezdxf.DXFError, UnicodeError):
            pass  # Let the regular reader/recover API report the actual error.

    original_error = None
    if not headerless:
        try:
            # The bytes used for source IDs, validation and resource packaging
            # are authoritative. Reopening path here can parse different bytes
            # after a file replacement while retaining the old source hash.
            if raw.startswith(b'AutoCAD Binary DXF'):
                from ezdxf.document import Drawing
                from ezdxf.lldxf.tagger import binary_tags_loader
                doc=Drawing.load(binary_tags_loader(raw,errors='surrogateescape'))
            else:
                from ezdxf.filemanagement import dxf_stream_info
                info=dxf_stream_info(io.StringIO(raw.decode('utf-8',errors='ignore'),newline=None))
                doc=ezdxf.read(io.StringIO(raw.decode(info.encoding,errors='surrogateescape'),newline=None))
            doc.filename=str(path)
            return doc, None
        except (ezdxf.DXFError, AttributeError) as error:
            original_error = type(error).__name__ + ': ' + str(error)
    if raw.startswith(b'AutoCAD Binary DXF'):
        raise ValueError('dxf-recovery-failed: ASCII recovery cannot read binary DXF; ' + str(original_error))

    if tags is None:
        tags = list(recover.safe_tag_loader(io.BytesIO(raw), errors='strict'))
    source_version = next((b.value for a, b in zip(tags, tags[1:])
                           if a == (9, '$ACADVER') and b.code == 1), None)
    sections = []
    for a, b in zip(tags, tags[1:]):
        if a == (0, 'SECTION') and b.code == 2:
            sections.append(b.value)
    modern_profile = headerless and any(tag.code == 100 for tag in tags)
    payload = raw
    if modern_profile:
        payload = b'0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1015\n0\nENDSEC\n' + raw
    preserved_blocks = []
    try:
        if modern_profile:
            from ezdxf.audit import Auditor
            from ezdxf.document import Drawing
            tool = recover.Recover.run(io.BytesIO(payload), errors='strict')
            doc = Drawing()
            doc._load_section_dict(tool.section_dict)
            auditor = Auditor(doc)
            for code, message in tool.errors:
                auditor.add_error(code, message)
            for code, message in tool.fixes:
                auditor.fixed_error(code, message)
            layout_names = {layout.block_record_name for layout in doc.layouts}
            if 'OBJECTS' not in sections:
                preserved_blocks = [block.name for block in doc.blocks
                                    if block.name.lower().startswith('*paper_space')
                                    and block.name not in layout_names]
            layout_audit = doc.layouts.audit
            if preserved_blocks:
                # With no source LAYOUT objects, ezdxf's layout cleanup destroys
                # still-present paper BLOCK content. Keep it as read-only block
                # previews, without manufacturing paper layouts or model placement.
                # The rest of the upstream audit (including resource repair) runs.
                doc.layouts.audit = lambda unused: None
            try:
                auditor.run()
            finally:
                doc.layouts.audit = layout_audit
        else:
            doc, auditor = recover.read(io.BytesIO(payload), errors='strict')
    except (ezdxf.DXFError, AttributeError, UnicodeError) as error:
        raise ValueError('dxf-recovery-failed: ' + type(error).__name__ + ': ' + str(error)) from error
    inventory = _inventory(tags)
    removed = [row for row in inventory if row['handle'] not in doc.entitydb
               or not doc.entitydb[row['handle']].is_alive]
    missing_layers = sorted({entity.dxf.get('layer', '0') for entity in doc.entitydb.values()
                             if entity.is_alive and entity.dxf.is_supported('layer')
                             and entity.dxf.get('layer', '0') not in doc.layers})
    # Keep each source layer name selectable; these are explicit display defaults,
    # not recovered source colors, linetypes or original visibility states.
    for layer in missing_layers:
        doc.layers.new(layer)
    default_layers = sorted(layer.dxf.name for layer in doc.layers) if 'TABLES' not in sections else missing_layers
    record = {
        'mode': 'headerless-modern-fragment' if modern_profile else 'ezdxf-recover',
        'sourceVersion': source_version,
        'loaderProfile': 'AC1015' if modern_profile else doc.dxfversion,
        'loaderProfileIsSourceVersion': source_version == doc.dxfversion,
        'originalReadError': original_error,
        'sourceSections': sections,
        'missingSections': [name for name in ('HEADER', 'TABLES', 'ENTITIES', 'OBJECTS') if name not in sections],
        'decoding': 'ezdxf detected encoding; absent codepage uses its cp1252 default',
        'sourceRecordCount': len(inventory),
        'sourceRecordTypes': dict(sorted(Counter(row['type'] for row in inventory).items())),
        'removedSourceRecords': removed,
        'preservedOrphanBlocks': preserved_blocks,
        'displayDefaultLayers': default_layers,
        'fixes': [{'code': int(entry.code), 'message': entry.message} for entry in auditor.fixes],
        'errors': [{'code': int(entry.code), 'message': entry.message} for entry in auditor.errors],
        'status': 'partial',
        'note': 'Recovered content preview; missing source metadata and audit removals are not reconstructed. '
                'Block previews do not establish original model placement or paper layouts.',
    }
    return doc, record
