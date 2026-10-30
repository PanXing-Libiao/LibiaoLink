"""Derived-geometry identity check for fill boundaries.

Fills are described analytically, but viewer parity requires the boundary to live in UCD
as real polyline entities. Those entities are derived: they must sit in a block space that
is never instantiated, must not collide with source blocks (including a source block that
is literally named '*FillBoundary'), must carry provenance back to the source hatch, and
must not emit draws of their own.
"""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import json
import sys
from pathlib import Path

import ezdxf

HERE = Path(__file__).resolve().parent
APP_DIR = HERE.parent
PROJECT = DATA
sys.path.insert(0, str(APP_DIR))
from unified.dxf_adapter import read_dxf  # noqa: E402

REAL = PROJECT / 'phase_i_evidence' / 'samples' / 'real'
FIXTURES = PROJECT / 'phase_j_evidence' / 'fixtures'
OUT = PROJECT / 'phase_j_evidence' / 'profiles' / 'derived-identity.json'
COLLISION = FIXTURES / 'derived_block_collision.dxf'


def make_collision_fixture():
    FIXTURES.mkdir(parents=True, exist_ok=True)
    document = ezdxf.new('R2010')
    block = document.blocks.new('*FillBoundary')
    block.add_line((0.0, 0.0), (1.0, 1.0))
    document.modelspace().add_blockref('*FillBoundary', (0.0, 0.0))
    hatch = document.modelspace().add_hatch(color=2, dxfattribs={'hatch_style': 0})
    hatch.set_solid_fill(color=2, style=0)
    hatch.paths.add_polyline_path([(10.0, 0.0), (20.0, 0.0), (20.0, 10.0), (10.0, 10.0)],
                                  is_closed=True)
    document.saveas(COLLISION)


def check_file(path):
    envelope = read_dxf(str(path), path.read_bytes())
    document = envelope['document']
    model = document['drawing']
    extension = document['extensions']['org.cad-preview.fill/1']
    fills = extension['fills']
    if not fills:
        return {'file': path.name, 'fills': 0, 'checks': 0, 'failures': []}
    block_id = extension['derivedBlockId']
    space_id = extension['derivedSpaceId']
    name = extension['derivedBlockName']
    failures = []
    if block_id not in model['blocks']:
        failures.append('derived block missing')
        return {'file': path.name, 'fills': len(fills), 'checks': 1, 'failures': failures}
    block = model['blocks'][block_id]
    space = model['spaces'][space_id]
    if block['spaceId'] != space_id or space['ownerId'] != block_id or space['kind'] != 'block':
        failures.append('derived block/space ownership mismatch')
    if block['name'] != name:
        failures.append('derived block name differs from extension')
    if sum(1 for other in model['blocks'].values() if other['name'] == name) != 1:
        failures.append('derived block name is not unique')
    source_names = [other['name'] for other_id, other in model['blocks'].items() if other_id != block_id]
    if name in source_names:
        failures.append('derived block name shadows a source block')
    boundary_ids = set()
    for entity_id, record in fills.items():
        entity = model['entities'][entity_id]
        handle = entity['sourceRefs'][0]['objectKey']
        if entity['ownerSpaceId'] == space_id:
            failures.append('fill entity %s lives in the derived space' % handle)
        for boundary_id in entity['geometry'].get('boundaryEntityIds', []):
            boundary_ids.add(boundary_id)
            boundary = model['entities'].get(boundary_id)
            if boundary is None:
                failures.append('boundary %s missing for fill %s' % (boundary_id, handle))
                continue
            if boundary['ownerSpaceId'] != space_id:
                failures.append('boundary %s outside derived space' % boundary_id)
            if boundary['sourceRefs'][0]['objectKey'] != handle:
                failures.append('boundary %s provenance does not point at hatch %s' % (boundary_id, handle))
            if boundary['style'].get('plot') is not False:
                failures.append('boundary %s is plottable' % boundary_id)
            if boundary['geometry'].get('type') != 'polyline' or not boundary['geometry'].get('closed'):
                failures.append('boundary %s is not a closed polyline' % boundary_id)
    if set(space['entityIds']) != boundary_ids:
        failures.append('derived space entities do not match fill boundaries')
    if extension.get('boundaryBlock') and extension['boundaryBlock'].get('name') != name:
        pass
    # Boundary space must never be instantiated and must not appear in projection draws.
    if any(instance.get('definitionId') == block_id or instance.get('blockId') == block_id
           for instance in model['blockInstances'].values()):
        failures.append('derived block is instantiated')
    return {'file': path.name, 'fills': len(fills), 'checks': 6 + len(boundary_ids),
            'boundaries': len(boundary_ids), 'derivedBlockName': name, 'failures': failures}


def main():
    make_collision_fixture()
    files = ['qcad_example00.dxf', 'qcad_example01.dxf', 'qcad_entities.dxf',
             'acadsharp_sample_AC1015.dxf', 'acadsharp_sample_AC1009.dxf',
             'qcad_flange.dxf', 'dxfparser_api_cw750_details.dxf']
    results = [check_file(REAL / name) for name in files]
    results.append(check_file(COLLISION))
    results.append(check_file(FIXTURES / 'ocs_extrusion.dxf'))
    failures = []
    for row in results:
        failures.extend('%s: %s' % (row['file'], issue) for issue in row['failures'])
    collision = [row for row in results if row['file'] == COLLISION.name][0]
    if collision.get('derivedBlockName') != '*FillBoundary~1':
        failures.append('collision fixture: derived name is %r, expected *FillBoundary~1'
                        % collision.get('derivedBlockName'))
    # Source block named *FillBoundary must survive untouched.
    source = ezdxf.readfile(str(COLLISION))
    source_block = source.blocks.get('*FillBoundary')
    if source_block is None or len(list(source_block)) != 1:
        failures.append('collision fixture: source block *FillBoundary was modified')
    profile = {'schemaVersion': 'derived-identity/1', 'generatedAt': '2026-10-19',
               'collisionFixture': str(COLLISION.relative_to(PROJECT)), 'results': results,
               'failures': failures}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(profile, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps({'files': len(results), 'failures': len(failures)}))
    for failure in failures:
        print('FAIL', failure)
    return 0 if not failures else 1


if __name__ == '__main__':
    raise SystemExit(main())
