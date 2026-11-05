"""Viewport accounting: keep the "records / model viewports / enabled" wording honest.

A DXF file stores VIEWPORT records for model projections and one paper-container viewport
per layout. Report, capability matrix and coverage must say the same numbers, so this check
derives them from the UCD document and compares the coverage view.
"""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent
PROJECT = DATA
sys.path.insert(0, str(APP))
from unified.dxf_adapter import read_dxf  # noqa: E402

OUT = PROJECT / 'phase_j_evidence' / 'profiles' / 'dxf-viewport-stats.json'
SAMPLE = PROJECT / 'phase_i_evidence' / 'samples' / 'real' / 'qcad_flange.dxf'


def stats(path):
    envelope = read_dxf(str(path), path.read_bytes())
    document = envelope['document']
    drawing = document['drawing']
    paper = document['extensions']['org.cad-preview.dxf/1']['paperSpace']
    coverage = document['extensions']['org.cad-preview.drawing-coverage/1']['sourceRead']
    viewports = drawing['viewports']
    layouts = drawing['layouts']
    projected = sum(len(layout['viewportIds']) for layout in layouts.values())
    enabled = sum(1 for row in viewports.values() if row.get('enabled'))
    statuses = {}
    for row in paper['viewports']:
        statuses[row.get('status')] = statuses.get(row.get('status'), 0) + 1
    failures = []
    if paper['viewportRecords'] != projected + len(paper['viewportsSkipped']):
        failures.append('record count != projected + skipped records')
    if statuses.get('projected', 0) != projected:
        failures.append('status=projected rows differ from projected viewports')
    if coverage['viewportRecords'] != paper['viewportRecords']:
        failures.append('coverage viewportRecords differs from paper extension')
    if coverage['modelViewports'] != len(viewports):
        failures.append('coverage modelViewports differs from drawing.viewports')
    if coverage['enabledModelViewports'] != enabled:
        failures.append('coverage enabledModelViewports differs from drawing.viewports')
    if len(paper['layouts']) != len(layouts):
        failures.append('paper extension layout count differs')
    return {'file': path.name, 'viewportRecords': paper['viewportRecords'],
            'modelViewports': len(viewports), 'enabledModelViewports': enabled,
            'paperContainerViewports': paper['paperContainerViewports'],
            'layouts': len(layouts), 'projectedViewportIds': projected,
            'skippedRecords': paper['viewportsSkipped'], 'statuses': statuses,
            'failures': failures}


def main():
    rows = [stats(path) for path in sorted((PROJECT / 'phase_i_evidence' / 'samples' / 'real').glob('*.dxf'))]
    failures = ['%s: %s' % (row['file'], issue) for row in rows for issue in row['failures']]
    flange = [row for row in rows if row['file'] == SAMPLE.name][0]
    if (flange['viewportRecords'], flange['modelViewports'], flange['enabledModelViewports'],
            flange['paperContainerViewports']) != (6, 4, 3, 2):
        failures.append('qcad_flange viewport numbers changed: %r' % (flange,))
    profile = {'schemaVersion': 'dxf-viewport-stats/1', 'generatedAt': '2026-10-19',
               'wording': '6 VIEWPORT records = 4 model-projection viewports + 2 paper containers; '
                          '3 of the 4 model viewports are enabled; every record has a status',
               'files': rows, 'failures': failures}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(profile, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps({row['file']: [row['viewportRecords'], row['modelViewports'],
                                    row['enabledModelViewports'], row['paperContainerViewports']]
                      for row in rows}))
    print('failures', failures)
    return 0 if not failures else 1


if __name__ == '__main__':
    raise SystemExit(main())
