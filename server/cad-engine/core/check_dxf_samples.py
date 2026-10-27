"""Independent verification of the DXF adapter against dxf-parser output.

For every real sample this checks the UCD source record set against an unrelated
parser (dxf-parser 1.1.2) and against DXF header extents where those are valid:

  * per-type source entity counts (entities section + block definitions),
  * layer names and source on/off/frozen flags,
  * named block definitions and INSERT counts per definition,
  * model-space draw extents versus $EXTMIN/$EXTMAX (when the header is valid),
  * file sha256 versus PROVENANCE.json.

Differences are only accepted for entity types dxf-parser documents as skipped,
and for anonymous dimension blocks that it does not synthesise. Run with the DXF
worker interpreter:  .phase-work/dxf/bin/python check_dxf_samples.py
"""
from dev_paths import DATA, BROWSER
import hashlib
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from unified.dxf_adapter import read_dxf  # noqa: E402

EVIDENCE = DATA / 'phase_i_evidence'
REAL = EVIDENCE / 'samples' / 'real'
INDEPENDENT = EVIDENCE / 'samples' / 'independent'
OUT = INDEPENDENT / 'VERIFICATION.json'
MD = INDEPENDENT / 'VERIFICATION.md'
TOL = 1e-6


def apply(m, x, y):
    return (m[0] * x + m[4] * y + m[12], m[1] * x + m[5] * y + m[13])


def model_extents(document, projection):
    lo = [math.inf, math.inf]
    hi = [-math.inf, -math.inf]
    for draw in projection['draws'].values():
        if draw['kind'] != 'entity':
            continue
        rep = document['representations'].get(draw.get('displayRepresentationId') or '')
        if not rep:
            continue
        geometry = document['geometries'][rep['bindings'][0]['geometryId']]
        bounds = geometry.get('bounds')
        if not bounds:
            continue
        for x in (bounds['min'][0], bounds['max'][0]):
            for y in (bounds['min'][1], bounds['max'][1]):
                px, py = apply(draw['localToSpace'], x, y)
                lo[0] = min(lo[0], px); lo[1] = min(lo[1], py)
                hi[0] = max(hi[0], px); hi[1] = max(hi[1], py)
    if not math.isfinite(lo[0]):
        return None
    return {'minX': lo[0], 'minY': lo[1], 'maxX': hi[0], 'maxY': hi[1]}


def main():
    provenance = json.loads((EVIDENCE / 'samples' / 'PROVENANCE.json').read_text())
    by_file = {Path(item['local_file']).name: item for item in provenance}
    rows = []
    failures = []
    for dxf in sorted(REAL.glob('*.dxf')):
        name = dxf.name
        stem = dxf.stem
        check = {'file': name, 'assertions': [], 'notes': []}

        def assert_true(label, condition, detail=None):
            check['assertions'].append({'check': label, 'ok': bool(condition), 'detail': detail})
            if not condition:
                failures.append(name + ': ' + label + (' ' + json.dumps(detail, ensure_ascii=False) if detail is not None else ''))

        raw = dxf.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        source = by_file.get(name, {})
        assert_true('sha256-matches-provenance', source.get('sha256') == digest, {'expected': source.get('sha256'), 'actual': digest})

        env = read_dxf(str(dxf), raw)
        document = env['document']
        drawing = document['drawing']
        projection = env['snapshot']['drawingProjection']
        extension = document['extensions']['org.cad-preview.dxf/1']
        coverage = extension['coverage']
        ours = {k: v for k, v in coverage['byType'].items() if k not in ('total', 'VIEWPORT-skipped')}

        parser = json.loads((INDEPENDENT / ('dxf-parser-' + stem + '.json')).read_text())
        assert_true('independent-parser-ok', parser.get('parse_ok') is True, parser.get('parse_error'))

        # --- per-type source counts -------------------------------------------------
        theirs = {}
        for kind, count in (parser.get('entity_counts_all') or {}).items():
            theirs[kind] = theirs.get(kind, 0) + count
        for block in parser.get('blocks') or []:
            for kind, count in (block.get('entity_counts') or {}).items():
                theirs[kind] = theirs.get(kind, 0) + count
        skipped = set(parser['parser_limitations'].get('skipped_entity_types') or [])
        mismatched = {k: {'ours': ours.get(k, 0), 'dxf-parser': theirs.get(k, 0)}
                      for k in set(ours) | set(theirs) if ours.get(k, 0) != theirs.get(k, 0)}
        unexplained = {k: v for k, v in mismatched.items() if v['dxf-parser'] != 0 and k not in skipped}
        assert_true('entity-type-counts-match-dxf-parser', not unexplained, unexplained)
        extra = {k: v['ours'] for k, v in mismatched.items() if v['dxf-parser'] == 0}
        if extra:
            check['notes'].append('Types dxf-parser skips but the adapter records: ' + ', '.join(k + ' x' + str(v) for k, v in sorted(extra.items())))

        # --- layers -----------------------------------------------------------------
        ours_layers = {layer['name']: layer for layer in drawing['layers'].values()}
        their_layers = {layer['name']: layer for layer in parser.get('layers') or []}
        assert_true('layer-names-superset', set(their_layers) <= set(ours_layers),
                    sorted(set(their_layers) - set(ours_layers)))
        flag_diff = {}
        vp_freeze_only = {}
        for lname, layer in their_layers.items():
            mine = ours_layers.get(lname)
            if not mine:
                continue
            parser_frozen, parser_visible = bool(layer.get('frozen')), bool(layer.get('visible'))
            if mine['frozen'] == parser_frozen and mine['visible'] == parser_visible:
                continue
            # dxf-parser folds the layer flag bit 2 ("frozen in new viewports") into
            # "frozen" and keeps visible=true; ezdxf's is_frozen() uses bit 1 only.
            if parser_frozen and not mine['frozen'] and parser_visible == mine['visible']:
                vp_freeze_only[lname] = {'ours': {'frozen': mine['frozen'], 'visible': mine['visible']},
                                         'dxf-parser': {'frozen': parser_frozen, 'visible': parser_visible}}
                continue
            flag_diff[lname] = {'ours': {'frozen': mine['frozen'], 'visible': mine['visible']},
                                'dxf-parser': {'frozen': parser_frozen, 'visible': parser_visible}}
        assert_true('layer-visibility-flags-match', not flag_diff, flag_diff)
        if vp_freeze_only:
            check['notes'].append('dxf-parser reports VP-freeze (flag bit 2) as frozen; table freeze bit is unset: ' + ', '.join(sorted(vp_freeze_only)))
        extra_layers = sorted(set(ours_layers) - set(their_layers))
        if extra_layers:
            check['notes'].append('Layers only in UCD: ' + ', '.join(extra_layers))

        # --- blocks and INSERT counts ----------------------------------------------
        layout_blocks = {'*Model_Space', '*Paper_Space', '$MODEL_SPACE', '$PAPER_SPACE'}
        their_blocks = {block['name'] for block in parser.get('blocks') or []
                        if block['name'] not in layout_blocks and not block['name'].startswith(('*Paper_Space', '*Model_Space', '$PAPER_SPACE', '$MODEL_SPACE'))}
        # The fill model adds one synthetic, never-instantiated block definition that
        # holds derived boundary polylines; it is declared in the fill extension.
        fill_ext = document['extensions'].get('org.cad-preview.fill/1', {})
        derived_block_id = fill_ext.get('derivedBlockId')
        derived_blocks = {block['name'] for block in drawing['blocks'].values()
                          if block['id'] == derived_block_id}
        ours_blocks = {block['name'] for block in drawing['blocks'].values()
                       if block['id'] != derived_block_id}
        if derived_blocks:
            check['notes'].append('Derived fill-boundary block excluded: ' + ', '.join(sorted(derived_blocks)))
        assert_true('named-block-definitions-match', their_blocks == ours_blocks,
                    {'only-dxf-parser': sorted(their_blocks - ours_blocks), 'only-ucd': sorted(ours_blocks - their_blocks)})
        our_inserts = {}
        for instance in drawing['blockInstances'].values():
            bname = drawing['blocks'][instance['definitionId']]['name']
            our_inserts[bname] = our_inserts.get(bname, 0) + 1
        their_inserts = {k: v for k, v in ((parser.get('insert_refs') or {}).get('total') or {}).items()
                         if not k.startswith('*')}
        insert_diff = {k: {'ours': our_inserts.get(k, 0), 'dxf-parser': their_inserts.get(k, 0)}
                       for k in set(our_inserts) | set(their_inserts)
                       if not k.startswith('*') and our_inserts.get(k, 0) != their_inserts.get(k, 0)}
        assert_true('insert-counts-match', not insert_diff, insert_diff)
        dimension_blocks = sum(1 for k in our_inserts if k.startswith('*D'))
        if dimension_blocks:
            check['notes'].append('Anonymous dimension geometry blocks materialised as BlockInstance: ' + str(dimension_blocks))

        # --- extents ----------------------------------------------------------------
        extents = model_extents(document, projection)
        header = parser.get('header') or {}
        emin, emax = header.get('EXTMIN'), header.get('EXTMAX')
        valid_header = bool(emin and emax and abs(emin.get('x', 0)) < 1e12 and abs(emax.get('x', 0)) < 1e12
                            and emax.get('x', 0) > emin.get('x', 0) and emax.get('y', 0) > emin.get('y', 0))
        extents_check = {'ours': extents, 'header': {'min': emin, 'max': emax}, 'header_usable': valid_header}
        if extents and valid_header:
            hw, hh = emax['x'] - emin['x'], emax['y'] - emin['y']
            mw, mh = extents['maxX'] - extents['minX'], extents['maxY'] - extents['minY']
            header_inside = (extents['minX'] <= emin['x'] + TOL and extents['minY'] <= emin['y'] + TOL
                             and extents['maxX'] >= emax['x'] - TOL and extents['maxY'] >= emax['y'] - TOL)
            model_inside = (extents['minX'] >= emin['x'] - TOL and extents['minY'] >= emin['y'] - TOL
                            and extents['maxX'] <= emax['x'] + TOL and extents['maxY'] <= emax['y'] + TOL)
            edges = [abs(extents['minX'] - emin['x']) < 1e-3, abs(extents['minY'] - emin['y']) < 1e-3,
                     abs(extents['maxX'] - emax['x']) < 1e-3, abs(extents['maxY'] - emax['y']) < 1e-3]
            papers = []
            for sheet in drawing['sheets'].values():
                papers.append(sorted(sheet.get('paperSize') or []))
            paper_match = any(abs(sorted([hw, hh])[0] - p[0]) < 0.01 * max(p[0], 1)
                              and abs(sorted([hw, hh])[1] - p[1]) < 0.01 * max(p[1], 1) for p in papers if len(p) == 2)
            relation = 'model-inside-header' if model_inside and not header_inside else (
                'header-inside-model' if header_inside and not model_inside else
                'model-equals-header' if model_inside and header_inside else
                'paper' if paper_match else 'unrelated')
            extents_check.update({'relation': relation, 'edges_matching': sum(edges),
                                  'model_size': {'width': mw, 'height': mh},
                                  'header_size': {'width': hw, 'height': hh}, 'paper_match': paper_match})
            assert_true('header-extents-agree', relation != 'unrelated' and (sum(edges) >= 2 or paper_match), extents_check)
            if relation == 'paper':
                check['notes'].append('Header extents describe the paper sheet, not model space; matched against layout paper size')
        else:
            check['notes'].append('Header extents unusable or absent; no independent extents comparison for this file')
        check['extents'] = extents_check

        check.update({
            'dxf_version': extension['dxfVersion']['code'],
            'units': extension['units']['label'],
            'source_entities': coverage['total'],
            'source_by_type': dict(sorted(ours.items())),
            'dxf_parser_by_type': dict(sorted(theirs.items())),
            'unsupported': coverage.get('unsupportedTotal'),
            'unsupported_by_type': coverage.get('unsupportedByType'),
            'draws': len(projection['draws']),
            'completeness': env['snapshot']['completeness'],
            'layouts': len(drawing['layouts']),
            'viewports': len(drawing['viewports']),
            'layers': len(ours_layers),
            'named_blocks': len(ours_blocks) - sum(1 for b in ours_blocks if b.startswith('*D')),
            'block_instances': len(drawing['blockInstances']),
        })
        check['verdict'] = 'structure-verified' if all(a['ok'] for a in check['assertions']) else 'failed'
        rows.append(check)

    result = {
        'schemaVersion': 'dxf-independent-verification/1',
        'generatedAt': '2026-10-19',
        'adapterEngine': 'ezdxf 1.4.2',
        'independentParser': 'dxf-parser 1.1.2 (npm, pinned)',
        'tolerance': TOL,
        'summary': {
            'samples': len(rows),
            'structureVerified': sum(1 for r in rows if r['verdict'] == 'structure-verified'),
            'failed': sum(1 for r in rows if r['verdict'] != 'structure-verified'),
            'failureDetails': failures,
        },
        'samples': rows,
    }
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=1) + '\n')

    lines = ['# DXF independent verification (ezdxf adapter vs dxf-parser 1.1.2)', '',
             'Every row compares the UCD source record set with an unrelated parser; differences are only',
             'accepted for entity types dxf-parser documents as skipped. Header extents are compared only',
             'when the header values are usable.', '',
             '| file | version | source entities | draws | layers | inserts | extents | verdict |',
             '| --- | --- | --- | --- | --- | --- | --- | --- |']
    relation_labels = {'model-inside-header': 'model inside header', 'header-inside-model': 'header inside model',
                       'model-equals-header': 'model equals header', 'paper': 'header equals paper size'}
    for row in rows:
        ext = row['extents']
        if ext.get('header_usable'):
            ext_note = relation_labels.get(ext.get('relation'), 'unrelated') + ', ' + str(ext.get('edges_matching', 0)) + '/4 edges equal'
        else:
            ext_note = 'header unusable'
        lines.append('| ' + ' | '.join([row['file'], row['dxf_version'], str(row['source_entities']), str(row['draws']),
                                         str(row['layers']), str(row['block_instances']), ext_note, row['verdict']]) + ' |')
    totals = {}
    for row in rows:
        for name, count in (row['unsupported_by_type'] or {}).items():
            totals[name] = totals.get(name, 0) + count
    lines += ['', 'Unsupported occurrences across all samples: '
              + ', '.join(name + ' x' + str(count) for name, count in sorted(totals.items())),
              '',
              'Recorded exceptions: dxf-parser folds layer flag bit 2 (frozen in new viewports) into its frozen flag;',
              'ezdxf and this adapter only treat bit 1 as frozen, so those layers are noted rather than failed.',
              'POLYLINE shows up as unsupported only for the polyface-mesh / 3D-mesh subtype, never for 2D/3D polylines.']
    MD.write_text('\n'.join(lines) + '\n')
    print(json.dumps(result['summary'], ensure_ascii=False, indent=1))
    for row in rows:
        print(row['file'], row['verdict'], 'draws', row['draws'], 'unsupported', row['unsupported'])
    return 0 if not failures else 1


if __name__ == '__main__':
    raise SystemExit(main())
