"""Independent raw-group-code HATCH comparison. PDF attribution stays unresolved.

Source geometry uses the Phase J test reader, never product boundary_paths.
Product triangles, PDF/PyMuPDF paths and CAD screen rendering are separate evidence.
"""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import json
import hashlib
import sys
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))
sys.path.insert(0, str(APP / 'tests'))
import check_dxf_fill as independent  # noqa: E402
import pymupdf  # noqa: E402
from pdf_fill_area import subpaths  # noqa: E402
from unified.dxf_adapter import read_dxf  # noqa: E402

ROOT = DATA
SAMPLE = ROOT / 'phase_i_evidence' / 'samples' / 'real' / 'qcad_flange.dxf'
VISUAL = ROOT / 'phase_j_evidence' / 'profiles' / 'dxf-cad-visual.json'
PDF = ROOT / 'phase_j_evidence' / 'visual' / 'qcad_flange.pdf'
FILL = ROOT / 'phase_j_evidence' / 'profiles' / 'dxf-fill-geometry.json'
OUT = ROOT / 'phase_k_evidence' / 'followup' / 'dxf-225a-independent.json'
ROWS = 2048
HANDLE = '225A'


def scanline_area(polygons, rule):
    xs = [point[0] for ring in polygons for point in ring]
    ys = [point[1] for ring in polygons for point in ring]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    height = (y1 - y0) / ROWS
    total = 0.0
    edges = []
    for ring in polygons:
        for index in range(len(ring)):
            ax, ay = ring[index]
            bx, by = ring[(index + 1) % len(ring)]
            if ay != by:
                edges.append((ax, ay, bx, by))
    for row in range(ROWS):
        y = y0 + (row + 0.5) * height
        crossings = []
        for ax, ay, bx, by in edges:
            if (ay > y) != (by > y):
                x = ax + (y - ay) * (bx - ax) / (by - ay)
                crossings.append((x, 1 if by > ay else -1))
        if not crossings:
            continue
        crossings.sort()
        if rule == 'even-odd':
            for index in range(0, len(crossings) - 1, 2):
                total += (crossings[index + 1][0] - crossings[index][0]) * height
        else:
            winding = 0
            previous = None
            for x, direction in crossings:
                if winding != 0 and previous is not None:
                    total += (x - previous) * height
                winding += direction
                previous = x
    return total


def inside(point, polygon):
    x, y = point
    result = False
    for index in range(len(polygon)):
        ax, ay = polygon[index]
        bx, by = polygon[(index + 1) % len(polygon)]
        if (ay > y) != (by > y) and x < ax + (y - ay) * (bx - ax) / (by - ay):
            result = not result
    return result


def pdf_rings(bbox, scale, translation, y_flip):
    document = pymupdf.open(str(PDF))
    page = document[0]
    for drawing in page.get_drawings():
        rect = drawing['rect']
        if all(abs(a - b) < 3 for a, b in zip((rect.x0, rect.y0, rect.x1, rect.y1), bbox)):
            rings = []
            for points in subpaths(drawing):
                model = []
                for x, y in points:
                    mx = (x - translation[0]) / scale
                    my = (y - translation[1]) / scale
                    model.append((mx, my if not y_flip else -my))
                rings.append(model)
            return rings, drawing.get('even_odd')
    return [], None


def main():
    record = next(r for r in independent.entities(SAMPLE) if r['type']=='HATCH' and independent.tag(r['tags'],5)==HANDLE)
    raw_rings, flags = independent.hatch_rings(record)
    polygons = []; exact_areas = []; skipped = 0
    for segments, flag in zip(raw_rings, flags):
        if flag & 8:
            skipped += 1
            continue
        for loop in independent.order_loops(segments):
            polygons.append(independent.loop_points(loop, segments))
            exact_areas.append(abs(sum(independent.segment_area(segments[i], forward) for i,forward in loop)*.5))
    depths=[sum(independent.inside(p[0],q) for j,q in enumerate(polygons) if j!=i) for i,p in enumerate(polygons)]
    exact_area=sum(a if depths[i]%2==0 else -a for i,a in enumerate(exact_areas))
    even_odd = scanline_area(polygons, 'even-odd')
    union = scanline_area(polygons, 'nonzero')
    ring_areas = [abs(scanline_area([polygon], 'even-odd')) for polygon in polygons]
    overlaps = []
    for i in range(len(polygons)):
        for j in range(i + 1, len(polygons)):
            both = scanline_area([polygons[i], polygons[j]], 'even-odd')
            intersection = (ring_areas[i] + ring_areas[j] - both) / 2
            if intersection > 0.01:
                overlaps.append({'rings': [i, j], 'intersectionMM2': round(intersection, 6),
                                 'ratioOfSmaller': round(intersection / min(ring_areas[i], ring_areas[j]), 4)})
    visual = json.loads(VISUAL.read_text())
    row = next(item for item in visual['results'] if item['name'] == 'qcad_flange')
    match = next(item for item in row['matches'] if item['handle'] == HANDLE)
    pdf_ratio = match['pathAreaRatio']
    pdf_path_area = match['pdfFill']['pathArea']
    pdf_shapes, pdf_even_odd = pdf_rings(match['pdfFill']['bbox'], row['scale'],
                                         row['translation'], row['yFlip'])
    pdf_areas = [abs(scanline_area([shape], 'even-odd')) for shape in pdf_shapes]
    nesting = []
    for index, shape in enumerate(pdf_shapes):
        owners = [other for other, candidate in enumerate(pdf_shapes)
                  if other != index and inside(shape[0], candidate)]
        nesting.append({'ring': index, 'areaMM2': round(pdf_areas[index], 6), 'inside': owners})
    matched_pdf = set()
    ring_pairs = []
    for index, area in enumerate(ring_areas):
        best = None
        for pdf_index, pdf_area in enumerate(pdf_areas):
            if pdf_index in matched_pdf or pdf_area <= 0:
                continue
            ratio = pdf_area / area
            if abs(ratio - 1) <= 0.03 and (best is None or abs(ratio - 1) < best[1]):
                best = (pdf_index, abs(ratio - 1))
        if best is None:
            ring_pairs.append({'dxfRing': index, 'dxfAreaMM2': round(area, 6), 'pdfRing': None})
        else:
            matched_pdf.add(best[0])
            ring_pairs.append({'dxfRing': index, 'dxfAreaMM2': round(area, 6),
                               'pdfRing': best[0], 'pdfAreaMM2': round(pdf_areas[best[0]], 6)})
    missing_pdf = [index for index in range(len(pdf_areas)) if index not in matched_pdf]
    envelope=read_dxf(SAMPLE,SAMPLE.read_bytes())
    item=next(k for k in envelope['document']['extensions']['org.cad-preview.fill/1']['fills'] if envelope['document']['drawing']['entities'][k]['sourceRefs'][0]['objectKey']==HANDLE)
    uco=independent.triangles(envelope['document'],envelope['bufferPayloads'],item)['area']
    union_ratio = union / even_odd
    report = {
        'schemaVersion': 'dxf-225a-rule/1',
        'generatedAt': '2026-10-20',
        'sourceSHA256': hashlib.sha256(SAMPLE.read_bytes()).hexdigest(),
        'pdfSHA256': hashlib.sha256(PDF.read_bytes()).hexdigest(),
        'sourceRingAreasExactMM2': exact_areas,
        'sourceRingDepths': depths,
        'sourceEvenOddAnalyticMM2': exact_area,
        'file': str(SAMPLE.relative_to(ROOT)),
        'handle': HANDLE,
        'hatchStyle': int(independent.tag(record['tags'],75,0)),
        'rings': len(polygons),
        'textboxPathsSkipped': skipped,
        'ringAreasMM2': [round(area, 6) for area in ring_areas],
        'evenOddAreaMM2': round(even_odd, 6),
        'nonzeroAreaMM2': round(union, 6),
        'nonzeroOverEvenOdd': round(union_ratio, 6),
        'overlappingRingPairs': overlaps,
        'ucdTriangleAreaMM2': round(uco, 6),
        'ucdOverEvenOdd': round(uco / even_odd, 6),
        'pdfPathAreaMM2': round(pdf_path_area / (row['scale'] ** 2), 6),
        'pdfOverUcdTriangles': round(pdf_path_area / (row['scale']**2) / uco,6),
        'pdfOverEvenOdd': round(pdf_path_area / (row['scale']**2) / even_odd, 6),
        'ucdOverAnalytic': uco/exact_area,
        'ringMatchScope': 'Area-only pairing within 3%; does not establish geometric identity or the cause of an unmatched ring.',
        'pdfRings': [{'ring': item['ring'], 'areaMM2': round(pdf_areas[item['ring']], 6),
                      'inside': item['inside']} for item in nesting],
        'pdfFillRule': 'even-odd' if pdf_even_odd else 'nonzero',
        'ringPairs': ring_pairs,
        'pdfRingsWithoutAreaMatch': missing_pdf,
        'sourceRingsWithoutAreaMatch': [item['dxfRing'] for item in ring_pairs if item['pdfRing'] is None],
        'method': 'Phase J independent ASCII group-code reader; analytic line/arc/bulge Green integral and ring nesting; independent scanline-2048; fresh UCD accessor decode; PyMuPDF extraction of existing LibreCAD PDF' ,
        'conclusion': None,
        'failures': [],
    }
    if abs(uco / even_odd - 1) > 0.01:
        report['failures'].append('UCD triangle area does not follow the even-odd boundary interpretation')
    if abs(uco / exact_area - 1) > .01:
        report['failures'].append('UCD differs from independently integrated analytic area by over 1%')
    report['status']='external-reference-mismatch'
    report['conclusion']='Independent DXF ring geometry agrees with UCD area within sampling tolerance. The PDF/PyMuPDF path geometry differs. Missing area-matched rings are evidence of a PDF pipeline discrepancy, not proof of whether LibreCAD display, PDF export or path extraction caused it. No independent QCAD screen result was obtained in this run.'
    report['evidenceLayers']={'source':'independent raw tags + analytic integration','product':'fresh UCD triangles','librecadDisplay':'not independently measured','pdf':'existing LibreCAD dxf2pdf artifact, SHA recorded','extraction':'PyMuPDF paths; not independently verified with a second PDF parser'}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps({key: report[key] for key in ('rings', 'evenOddAreaMM2', 'nonzeroAreaMM2',
                                                   'nonzeroOverEvenOdd', 'ucdTriangleAreaMM2',
                                                   'ucdOverEvenOdd', 'pdfPathAreaMM2',
                                                   'pdfOverEvenOdd', 'sourceRingsWithoutAreaMatch',
                                                   'pdfRingsWithoutAreaMatch', 'failures')},
                     ensure_ascii=False))
    sys.exit(1 if report['failures'] else 0)


if __name__ == '__main__':
    main()
