"""Independent CAD visual check: LibreCAD 2.2.x (console dxf2pdf) as the CAD side.

The check renders real sample files with LibreCAD and compares the filled vector paths
of the produced PDF with the UCD fill triangles. It complements, not replaces, the
browser pixel checks: LibreCAD is a separate CAD implementation, so agreement on fill
count, colour and area ratio is C-level visual evidence.

Requires LibreCAD.app (set LIBRECAD_APP or place it at /tmp/LibreCAD.app). When the app
is missing the script exits with status 2 and writes an 'unavailable' profile instead of
pretending to have verified anything.
"""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import hashlib
import json
import math
import os
import plistlib
import subprocess
import sys
from pathlib import Path

import pymupdf

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import pdf_fill_area as fill_area  # noqa: E402
APP_DIR = HERE.parent
PROJECT = DATA
sys.path.insert(0, str(APP_DIR))
from unified.dxf_adapter import read_dxf  # noqa: E402
import check_dxf_fill as fills_check  # noqa: E402

OUT = PROJECT / 'phase_k_evidence' / 'followup' / 'dxf-cad-visual.json'
VISUAL = PROJECT / 'phase_j_evidence' / 'visual'
LIBRECAD = Path(os.environ.get('LIBRECAD_APP', '/tmp/LibreCAD.app'))
REUSE_STORED = '--reuse-pdfs' in sys.argv


def librecad_version():
    plist = LIBRECAD / 'Contents' / 'Info.plist'
    try:
        with open(plist, 'rb') as handle:
            data = plistlib.load(handle)
        return data.get('CFBundleShortVersionString') or data.get('CFBundleVersion')
    except Exception:
        return None


def render(dxf_path, name, resolution=150, measure_area=True):
    """Convert DXF to PDF with LibreCAD and return the first page's filled shapes."""
    VISUAL.mkdir(parents=True, exist_ok=True)
    pdf = VISUAL / (name + '.pdf')
    command = [str(LIBRECAD / 'Contents' / 'MacOS' / 'LibreCAD'), 'dxf2pdf', '-a',
               '-p', '420x297', '-o', str(pdf), str(dxf_path)]
    subprocess.run(command, check=True, capture_output=True, timeout=600)
    document = pymupdf.open(pdf)
    page = document[0]
    pixmap = page.get_pixmap(dpi=resolution)
    png = VISUAL / (name + '-librecad.png')
    pixmap.save(png)
    shapes = fill_area.extract_shapes(page, measure_area=measure_area)
    return shapes, page.rect, pdf, png, command


def stored_render(name, measure_area=True):
    """Re-derive the shapes of an already rendered PDF without running LibreCAD.

    Used to correct an extraction defect in an existing profile: the PDFs, page size
    and checksums stay exactly as recorded, only the decoded fill geometry is redone.
    """
    pdf = VISUAL / (name + '.pdf')
    png = VISUAL / (name + '-librecad.png')
    page = pymupdf.open(pdf)[0]
    shapes = fill_area.extract_shapes(page, measure_area=measure_area)
    return shapes, page.rect, pdf, png, ['stored PDF reused; LibreCAD not re-run']


def ucd_fills(path):
    envelope = read_dxf(str(path), path.read_bytes())
    document = envelope['document']
    registry = document['extensions']['org.cad-preview.fill/1']['fills']
    rows = []
    for entity_id, record in registry.items():
        entity = document['drawing']['entities'][entity_id]
        try:
            triangle = fills_check.triangles(document, envelope['bufferPayloads'], entity_id)
        except Exception:
            continue
        bbox = triangle['bbox']
        rows.append({'handle': entity['sourceRefs'][0]['objectKey'],
                     'area': triangle['area'],
                     'center': [(bbox[0] + bbox[2]) / 2.0, (bbox[1] + bbox[3]) / 2.0],
                     'bbox': bbox,
                     'color': entity['style'].get('color')})
    return rows


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _size(row):
    return (row['bbox'][2] - row['bbox'][0], row['bbox'][3] - row['bbox'][1])


def estimate_transform(ucd, shapes, sample_limit=8):
    """Pick scale and translation that match the most filled shapes.

    The match uses the bounding-box width/height ratio, which is stable for skewed
    SOLID quads where the PDF rect area is larger than the polygon area. Translation is
    anchored on one UCD/PDF pair so extra PDF fills do not move the alignment.

    Large drawings (cw750 has 67 UCD fills and 575 PDF fills) would make the exhaustive
    anchor search cubic; the transform is therefore estimated from the largest
    sample_limit fills and then applied to every fill. Small files use every row and
    keep the previous result unchanged.
    """
    anchors = ucd
    if len(ucd) > sample_limit:
        anchors = sorted(ucd, key=lambda item: -item['area'])[:sample_limit]
    best = None
    span = max(max(_size(row)) for row in anchors)
    for row in anchors:
        width, height = _size(row)
        if width <= 0 or height <= 0:
            continue
        for shape in shapes:
            sw = shape['bbox'][2] - shape['bbox'][0]
            sh = shape['bbox'][3] - shape['bbox'][1]
            if sw <= 0 or sh <= 0:
                continue
            scale = sw / width
            if not (0.05 < scale < 1000.0):
                continue
            for flip in (True, False):
                tx = shape['center'][0] - scale * row['center'][0]
                ty = shape['center'][1] - (-scale * row['center'][1] if flip else scale * row['center'][1])
                matches = match(ucd, shapes, scale, flip, tx, ty, span * scale * 0.02)
                score = (len(matches), -abs(math.log(scale)))
                if best is None or score > best[0]:
                    best = (score, scale, flip, tx, ty, matches)
    return best


def match(ucd, shapes, scale, flip, tx, ty, tolerance):
    """Greedy nearest-centre matching with scale-consistent bbox dimensions."""
    used = set()
    matches = []
    for row in sorted(ucd, key=lambda item: -_size(item)[0]):
        width, height = _size(row)
        if width <= 0 or height <= 0:
            continue
        best = None
        for index, shape in enumerate(shapes):
            if index in used:
                continue
            sw = shape['bbox'][2] - shape['bbox'][0]
            sh = shape['bbox'][3] - shape['bbox'][1]
            if sw <= 0 or sh <= 0:
                continue
            if not (0.9 <= sw / (width * scale) <= 1.1 and 0.9 <= sh / (height * scale) <= 1.1):
                continue
            px = tx + scale * row['center'][0]
            py = ty + (-scale * row['center'][1] if flip else scale * row['center'][1])
            distance = math.hypot(shape['center'][0] - px, shape['center'][1] - py)
            if distance <= tolerance and (best is None or distance < best[0]):
                best = (distance, index, (sw / (width * scale), sh / (height * scale)))
        if best is not None:
            used.add(best[1])
            matches.append({'handle': row['handle'], 'pdfFill': shapes[best[1]],
                            'widthRatio': best[2][0], 'heightRatio': best[2][1], 'distance': best[0]})
    return matches





AREA_TOLERANCE = 0.02
RULE_EVIDENCE = PROJECT / 'phase_k_evidence' / 'followup' / 'dxf-225a-independent.json'


def rule_evidence():
    """Renderer-artifact evidence for a fill whose PDF differs from the source rule."""
    if not RULE_EVIDENCE.exists():
        return None
    try:
        report = json.loads(RULE_EVIDENCE.read_text())
    except (OSError, ValueError):
        return None
    # Source-rule agreement alone cannot identify the failing PDF pipeline stage.
    return report if not report.get('failures') and report.get('status') == 'independently-proven-renderer-artifact' else None


def area_comparison(ucd, matches, scale):
    """Attach true path-area and bbox-area ratios to each placement match.

    `areaRatio` compares the PDF path area (scanline, fill-rule aware) with the UCD
    triangle area; `bboxAreaRatio` keeps the weaker bounding-box ratio for reference.
    Placement agreement alone must not be reported as area agreement.
    """
    rows = {row['handle']: row for row in ucd}
    for item in matches:
        row = rows[item['handle']]
        shape = item['pdfFill']
        width = row['bbox'][2] - row['bbox'][0]
        height = row['bbox'][3] - row['bbox'][1]
        ucd_area = row['area'] * scale * scale
        ucd_bbox = width * height * scale * scale
        ratio = None if shape.get('pathArea') is None else shape['pathArea'] / ucd_area
        item['pathAreaRatio'] = ratio
        item['bboxAreaRatio'] = shape['bboxArea'] / ucd_bbox if ucd_bbox else None
        if ratio is None:
            item['areaStatus'] = 'unavailable'
        elif abs(ratio - 1.0) <= AREA_TOLERANCE:
            item['areaStatus'] = 'matched'
        else:
            item['areaStatus'] = 'diverges'
    return matches


def check_file(name, relative, expected_colors=None, minimum_matched=None, mode='matched'):
    path = PROJECT / relative
    ucd = ucd_fills(path)
    measure_area = mode == 'matched'
    if REUSE_STORED and (VISUAL / (name + '.pdf')).exists():
        shapes, page_rect, pdf, png, command = stored_render(name, measure_area=measure_area)
    else:
        shapes, page_rect, pdf, png, command = render(
            path, name, resolution=600 if mode == 'render-only' else 150,
            measure_area=measure_area)
    if mode == 'render-only':
        document = pymupdf.open(pdf)
        page = document[0]
        ink = [drawing['rect'] for drawing in page.get_drawings()]
        ink_bbox = None
        if ink:
            ink_bbox = [min(rect.x0 for rect in ink), min(rect.y0 for rect in ink),
                        max(rect.x1 for rect in ink), max(rect.y1 for rect in ink)]
        return {'name': name, 'file': relative, 'mode': 'render-only',
                'pdfPage': [page_rect.width, page_rect.height],
                'ucdFills': len(ucd), 'pdfFills': len(shapes), 'inkBBox': ink_bbox,
                'ucdRows': ucd, 'pdfFillsAll': shapes,
                'source': {'path': relative, 'sha256': sha256_file(path)},
                'command': command,
                'limitation': 'cw750 fills live in block definitions; dxf2pdf prints a '
                              'paper layout with far fewer filled paths than the 67 UCD fills. '
                              'This artifact is an independent-CAD display check only, not a '
                              'per-fill match.',
                'artifacts': {
                    'pdf': {'path': str(pdf.relative_to(PROJECT)), 'sha256': sha256_file(pdf),
                            'bytes': pdf.stat().st_size},
                    'png': {'path': str(png.relative_to(PROJECT)), 'sha256': sha256_file(png),
                            'bytes': png.stat().st_size},
                },
                'pdf': str(pdf.relative_to(PROJECT))}
    best = estimate_transform(ucd, shapes)
    if best is None:
        return {'name': name, 'ucd': len(ucd), 'pdf': len(shapes), 'error': 'no matching transform'}
    score, scale, flip, tx, ty, matches = best
    matched_handles = {row['handle'] for row in matches}
    unmatched_ucd = [row['handle'] for row in ucd if row['handle'] not in matched_handles]
    colors = sorted(tuple(round(c, 3) for c in row['pdfFill']['color']) for row in matches)
    area_comparison(ucd, matches, scale)
    rule = rule_evidence()
    if rule is not None:
        for item in matches:
            if item['handle'] == rule.get('handle') and rule.get('file') == relative:
                item['areaStatus'] = 'renderer-artifact'
                item['rendererArtifact'] = rule.get('conclusion')
                item['ruleEvidence'] = str(RULE_EVIDENCE.relative_to(PROJECT))
    area_matched = sum(1 for item in matches if item['areaStatus'] == 'matched')
    area_renderer = [{'handle': item['handle'], 'pathAreaRatio': item['pathAreaRatio'],
                      'ruleEvidence': item.get('ruleEvidence')}
                     for item in matches if item['areaStatus'] == 'renderer-artifact']
    area_diverged = [{'handle': item['handle'], 'pathAreaRatio': item['pathAreaRatio'],
                      'bboxAreaRatio': item['bboxAreaRatio']}
                     for item in matches if item['areaStatus'] == 'diverges']
    area_renderer = [{'handle': item['handle'], 'pathAreaRatio': item['pathAreaRatio'],
                      'ruleEvidence': item.get('ruleEvidence')}
                     for item in matches if item['areaStatus'] == 'renderer-artifact']
    area_unavailable = [item['handle'] for item in matches if item['areaStatus'] == 'unavailable']
    return {'name': name, 'file': relative, 'pdfPage': [page_rect.width, page_rect.height],
            'ucdFills': len(ucd), 'pdfFills': len(shapes), 'matched': len(matches),
            'areaMatched': area_matched, 'areaDiverged': area_diverged,
            'areaRendererArtifact': area_renderer,
            'areaUnavailable': area_unavailable,
            'scale': scale, 'yFlip': flip, 'translation': [tx, ty],
            'unmatchedUcd': unmatched_ucd, 'matches': matches, 'pdfColors': colors,
            'ucdRows': ucd, 'pdfFillsAll': shapes,
            'source': {'path': relative, 'sha256': sha256_file(path)},
            'command': command,
            'artifacts': {
                'pdf': {'path': str(pdf.relative_to(PROJECT)), 'sha256': sha256_file(pdf),
                        'bytes': pdf.stat().st_size},
                'png': {'path': str(png.relative_to(PROJECT)), 'sha256': sha256_file(png),
                        'bytes': png.stat().st_size},
            },
            'pdf': str(pdf.relative_to(PROJECT))}


def main():
    version = librecad_version()
    if not LIBRECAD.exists():
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps({'schemaVersion': 'dxf-cad-visual/1',
                                   'status': 'unavailable',
                                   'reason': 'LibreCAD.app not found at ' + str(LIBRECAD)},
                                  ensure_ascii=False, indent=1) + '\n')
        print('LibreCAD unavailable:', LIBRECAD)
        return 2
    targets = [
        ('qcad_example00', 'phase_i_evidence/samples/real/qcad_example00.dxf', 6, 6, 'matched'),
        ('librecad_dim_sample', 'phase_i_evidence/samples/real/librecad_dim_sample.dxf', 4, 4, 'matched'),
        ('qcad_flange', 'phase_i_evidence/samples/real/qcad_flange.dxf', 5, 5, 'matched'),
        ('dxfparser_api_cw750_details',
         'phase_i_evidence/samples/real/dxfparser_api_cw750_details.dxf', 67, 0, 'render-only'),
    ]
    results = []
    failures = []
    for name, relative, expected_ucd, minimum_matched, mode in targets:
        row = check_file(name, relative, mode=mode)
        results.append(row)
        if row.get('error'):
            failures.append(name + ': ' + row['error'])
            continue
        if row['ucdFills'] != expected_ucd:
            failures.append(name + ': expected %d UCD fills, found %d' % (expected_ucd, row['ucdFills']))
        if mode == 'render-only':
            if row['pdfFills'] == 0 or not row.get('inkBBox'):
                failures.append(name + ': LibreCAD produced an empty render')
            continue
        if row['matched'] < minimum_matched:
            failures.append(name + ': only %d/%d fills matched in the LibreCAD render'
                            % (row['matched'], expected_ucd))
        if name == 'qcad_example00':
            expected = sorted([(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (1.0, 1.0, 0.0),
                               (0.0, 1.0, 0.0), (0.0, 1.0, 1.0), (0.0, 0.0, 1.0)])
            if sorted(tuple(round(c, 3) for c in color) for color in row['pdfColors']) != expected:
                failures.append(name + ': LibreCAD fill colours do not match ACI set')
    area_matched = sum(row.get('areaMatched', 0) for row in results)
    area_diverged = [{'file': row['file'], **item} for row in results
                     for item in row.get('areaDiverged', [])]
    area_unavailable = [{'file': row['file'], 'handle': handle} for row in results
                        for handle in row.get('areaUnavailable', [])]
    area_renderer = [{'file': row['file'], **item} for row in results
                     for item in row.get('areaRendererArtifact', [])]
    profile = {'schemaVersion': 'dxf-cad-visual/1', 'generatedAt': '2026-10-19',
               'tool': {'name': 'LibreCAD', 'version': version, 'app': str(LIBRECAD),
                        'invocation': 'LibreCAD dxf2pdf -a -p 420x297 -o <pdf> <dxf>'},
               'comparison': 'filled vector paths extracted from the LibreCAD PDF (PyMuPDF); placement, colour and bounding box are matched per fill, and the TRUE path area (scanline, fill-rule aware) is compared separately with the UCD triangle area. bboxArea is recorded but never presented as filled area. render-only rows are display evidence without a per-fill match',
               'areaComparison': {'tolerance': AREA_TOLERANCE, 'method': 'scanline-%d even-odd/nonzero' % fill_area.DEFAULT_ROWS,
                                  'matched': area_matched, 'diverged': len(area_diverged),
                                  'unavailable': len(area_unavailable),
                                  'rendererArtifacts': area_renderer,
                                  'divergences': area_diverged},
               'results': results, 'failures': failures,
               'summary': {'files': len(results), 'matched': sum(row.get('matched', 0) for row in results),
                           'areaMatched': area_matched, 'areaDiverged': len(area_diverged),
                           'areaRendererArtifact': len(area_renderer),
                           'renderOnly': sum(1 for row in results if row.get('mode') == 'render-only'),
                           'failed': len(failures)}}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(profile, ensure_ascii=False, indent=1) + '\n')
    lines = ['# Independent CAD visual check (LibreCAD ' + str(version) + ')', '',
             'LibreCAD is a separate CAD implementation. Each file is rendered with its console',
             'dxf2pdf tool; filled vector paths are decoded from the PDF. Placement (centre,',
             'bounding box, colour) and the TRUE path area are checked separately:',
             'pathArea comes from a fill-rule-aware scanline of the PDF path, while bboxArea is',
             'only the bounding box and is not a filled area.', '',
             '| file | mode | UCD fills | LibreCAD fills | matched | area matched | scale |',
             '| --- | --- | --- | --- | --- | --- | --- |']
    for row in results:
        if row.get('error'):
            lines.append('| %s | error | %s | %s | - | - |' % (row['name'], row['ucdFills'], row['pdfFills']))
            continue
        if row.get('mode') == 'render-only':
            lines.append('| %s | render-only | %d | %d | - | - |'
                         % (row['name'], row['ucdFills'], row['pdfFills']))
            continue
        lines.append('| %s | matched | %d | %d | %d | %d/%d | %.4f |'
                     % (row['name'], row['ucdFills'], row['pdfFills'], row['matched'],
                        row.get('areaMatched', 0), row['matched'], row['scale']))
    if area_diverged:
        lines.extend(['', '## True-area divergences (recorded, not hidden)', '',
                      'Placement matches but the filled path area does not. These are kept as',
                      'limitations: the UCD side is checked against the source boundary rings,',
                      'so a divergence is a real difference between the two implementations or',
                      'fill-rule interpretations, not an excuse to call the area equal.', ''])
        for item in area_diverged:
            lines.append('- %s handle %s: pathArea ratio %.4f (bboxArea ratio %.4f)'
                         % (item['file'], item['handle'], item['pathAreaRatio'],
                            item['bboxAreaRatio'] or 0.0))
    if area_renderer:
        lines.extend(['', '## Renderer artifacts (PDF differs from the source fill rule)', '',
                      'The UCD fill was checked against the raw boundary paths and follows the DXF',
                      'style rule; the PDF side is a converter artifact, so it is not counted as a',
                      'UCD divergence. See phase_k_evidence/profiles/dxf-225a-rule.json.', ''])
        for item in area_renderer:
            lines.append('- handle %s: PDF/UCD area ratio %.4f; rule evidence %s'
                         % (item['handle'], item['pathAreaRatio'], item['ruleEvidence']))
    if any(row.get('mode') == 'render-only' for row in results):
        lines.extend(['', 'Render-only rows keep the LibreCAD PDF/PNG as independent display evidence,',
                      'but do not claim a per-fill match: cw750 fills live in block definitions and',
                      'the dxf2pdf console tool prints a paper layout with far fewer filled paths',
                      'than the 67 UCD fills.'])
    OUT.with_suffix('.md').write_text('\n'.join(lines) + '\n')
    print(json.dumps(profile['summary'], ensure_ascii=False))
    for failure in failures:
        print('FAIL', failure)
    return 0 if not failures else 1


if __name__ == '__main__':
    raise SystemExit(main())
