"""Build DXF_CAPABILITY_MATRIX.json from the adapter registries and extend the
project-wide CAPABILITY_MATRIX.json with the DXF rows.

Phase J changes:
* SOLID and solid HATCH move from "unsupported" to the filled-entity registry;
* schema gaps are restated against the actual 2.0 schema (the Phase I claim that
  EntityStyle cannot express BYLAYER/BYBLOCK colour was wrong and is withdrawn);
* every capability row carries an evidence level (A projection parity, B browser
  render, C independent CAD visual) and the project version is recorded;
* entity-level fill reasons are published separately from HTTP/parse error codes.

Run:  python3 build_dxf_matrix.py
"""
from dev_paths import DATA, BROWSER
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECT = DATA
sys.path.insert(0, str(ROOT))
from unified.dxf_adapter import (  # noqa: E402
    ANNOTATION_ENTITIES, CORE_ENTITIES, ENGINE, FILL_ENTITIES, MAX_CURVE_SEGMENTS,
    MAX_ENTITIES, MAX_PROJECTION_DRAWS, RELEASE, UNSUPPORTED_REASONS,
)

DXF_MATRIX = PROJECT / 'DXF_CAPABILITY_MATRIX.json'
ROOT_MATRIX = PROJECT / 'CAPABILITY_MATRIX.json'

SUPPORTED = {
    'LINE': {'ucd': 'line', 'note': 'WCS endpoints; LINE is not an OCS entity, so the adapter applies no OCS transform'},
    'POINT': {'ucd': 'point', 'note': 'position only; no glyph'},
    'CIRCLE': {'ucd': 'arc', 'note': 'stored as a full-sweep arc; UCD has no circle primitive'},
    'ARC': {'ucd': 'arc', 'note': 'start/sweep kept in degrees in the DXF extension, radians in UCD'},
    'LWPOLYLINE': {'ucd': 'polyline', 'note': 'bulges preserved per segment'},
    'POLYLINE': {'ucd': 'polyline', 'note': '2D and 3D vertex lists; polyface mesh (flag 64) and 3D polygon mesh (flag 16) subtypes stay registered as unsupported instead of being flattened'},
    'ELLIPSE': {'ucd': 'ellipse', 'note': 'major/minor axis vectors and parameter range'},
    'SPLINE': {'ucd': 'spline', 'note': 'control points, knots and weights preserved'},
}
ANNOTATIONS = {
    'TEXT': {'ucd': 'text', 'note': 'insertion, height, rotation, halign/valign, style'},
    'MTEXT': {'ucd': 'mtext', 'note': 'raw content preserved; inline formatting not rendered'},
    'ATTDEF': {'ucd': 'text', 'note': 'attribute definition content'},
    'ATTRIB': {'ucd': 'text', 'note': 'attribute value as text'},
    'DIMENSION': {'ucd': 'dimension', 'note': 'record + anonymous geometry block instance; measurement not reconstructed'},
}
FILLED = {
    'SOLID': {'ucd': 'hatch', 'support': 'quad and degenerate-triangle form, solid fill',
              'note': 'DXF corners are re-ordered 1,2,4,3 before the polygon is built; boundary kept as a derived polyline entity plus an analytic record'},
    'TRACE': {'ucd': 'hatch', 'support': 'quad and triangular forms through the SOLID polygon path',
              'note': 'v0.13.0 synthetic regression preserves source corner order and OCS elevation; no original-CAD visual acceptance claimed'},
    'HATCH': {'ucd': 'hatch', 'support': 'solid-fill subset only',
              'note': 'style 0/1/2; line/arc/ellipse/spline edge paths reordered by endpoint connectivity at 1e-6 absolute; polyline paths with bulges; multiple paths and even-odd holes; coincident opposite rings cancel under even-odd. Style 1 keeps EXTERNAL/OUTERMOST paths and style 2 keeps EXTERNAL paths (group 92); a multipath hatch with no qualifying path is refused. Pattern/gradient fills, gradient 450 kind=1, style 3, unknown path-flag bits and unpaired endpoints are refused with a reason'},
}

EVIDENCE_LEVELS = {
    'A': 'Python/JS projection parity: public/drawing-projection.js and unified/dxf_adapter.py produce identical draws for the named spaces.',
    'B': 'Real browser render: the Canvas2D viewer renders the artifact and pixel probes confirm fill colour, holes and layer visibility.',
    'C': 'Independent CAD visual: a CAD application other than this viewer imports the source file and exports SVG/PDF for visual comparison.',
}


def capability_rows():
    samples = 'phase_i_evidence/samples/PROVENANCE.json'
    verification = 'phase_i_evidence/samples/independent/VERIFICATION.json'
    parity = 'phase_i_evidence/profiles/dxf-projection-parity.json'
    browser = 'phase_j_evidence/profiles/browser-phase-j.json'
    browser_i = 'phase_i_evidence/profiles/browser-phase-i.json'
    browser_k = 'phase_k_evidence/profiles/browser-phase-k-dxf.json'
    annotations_check = '10_独立解析查看器/tests/check_dxf_annotations.py'
    perf = 'phase_i_evidence/profiles/dxf-performance.json'
    transport = 'phase_j_evidence/profiles/dxf-transport.json'
    perf_before = 'phase_j_evidence/profiles/dxf-performance-before.json'
    fill_geometry = 'phase_j_evidence/profiles/dxf-fill-geometry.json'
    ledger = 'phase_j_evidence/profiles/dxf-fill-ledger.json'
    cad_visual = 'phase_j_evidence/profiles/dxf-cad-visual.json'
    cad_visual_verification = 'phase_j_evidence/profiles/dxf-cad-visual-verification.json'
    ocs_audit = 'phase_j_evidence/profiles/dxf-ocs-audit.json'
    projection_audit = 'phase_j_evidence/profiles/projection-dependency.json'
    derived = 'phase_j_evidence/profiles/derived-identity.json'
    hatch_style = 'phase_j_evidence/profiles/hatch-style.json'
    hatch_tolerance = 'phase_j_evidence/profiles/hatch-tolerance.json'
    hatch_gradient = 'phase_j_evidence/profiles/hatch-gradient.json'
    refusal_audit = 'phase_j_evidence/profiles/refusal-audit.json'
    viewport_stats = 'phase_j_evidence/profiles/dxf-viewport-stats.json'
    fixture = 'phase_j_evidence/fixtures/fill_holes_curves.dxf'
    return [
        {
            'feature': 'dxf-drawing-model', 'status': 'verified-scope', 'evidenceLevel': ['A', 'B'],
            'scope': '11 real DXF files, 6 versions (AC1009/1015/1021/1024/1027/1032), 34 model+layout spaces projected',
            'mechanism': 'standard-confirmed', 'evidenceIds': ['dxf-spec', 'ezdxf', 'policy'],
            'evidence': [
                {'artifact': samples, 'observed': '11 files from ACadSharp, gdal, LibreCAD, QCAD and dxf-parser samples; sha256 and authoring metadata recorded'},
                {'artifact': verification, 'observed': 'all 11 samples structure-verified; per-type source counts match dxf-parser except its documented skipped types'},
                {'artifact': parity, 'observed': 'all 34 spaces identical between public/drawing-projection.js and unified/dxf_adapter.py, now including filled entities'},
                {'artifact': projection_audit, 'observed': 'drawing-projection.js reads no DXF keyword, field or extension; one generic extension (style-inheritance) is consumed'},
                {'artifact': ocs_audit, 'observed': '30 independent group-code checks confirm WCS entities (LINE/POINT/ELLIPSE/SPLINE/3D POLYLINE) are not double-OCS-transformed and OCS entities honour arbitrary-axis extrusion (0,0,-1)'},
            ],
            'limitations': ['Only DXF; DWG is not read and no Autodesk SDK is used',
                            'Binary DXF is not accepted; uploads must be ASCII DXF',
                            'Projection is orthographic 2D today; 3D DXF entities such as 3DFACE are registered, not rendered'],
        },
        {
            'feature': 'dxf-core-entities', 'status': 'verified-scope', 'evidenceLevel': ['A', 'B'],
            'scope': 'LINE POINT CIRCLE ARC LWPOLYLINE POLYLINE ELLIPSE SPLINE',
            'mechanism': 'standard-confirmed', 'evidenceIds': ['dxf-spec', 'ezdxf'],
            'evidence': [{'artifact': verification, 'observed': 'per-type counts equal dxf-parser on all 11 files for every type it implements'}],
            'limitations': ['CIRCLE is a full-sweep Arc in UCD',
                            'Bulge-to-arc conversion is applied at projection time, not stored as source geometry'],
        },
        {
            'feature': 'dxf-blocks-and-instances', 'status': 'verified-scope', 'evidenceLevel': ['A', 'B'],
            'scope': 'BlockDefinition per BLOCK_RECORD, BlockInstance per INSERT; MINSERT rows/columns expand to independent instances',
            'mechanism': 'standard-confirmed', 'evidenceIds': ['dxf-spec', 'ezdxf'],
            'evidence': [
                {'artifact': verification, 'observed': 'named block sets and INSERT counts per definition equal dxf-parser on all samples; anonymous dimension blocks are our own materialisation'},
                {'artifact': browser_i, 'observed': 'byblock sample: two INSERTs of BlockWithLineByBlock select disjoint draw sets (1 draw each, overlap 0)'},
            ],
            'limitations': ['Dynamic block parameters and XREF content are not evaluated',
                            'A block definition is never promoted to a CAD product/PartDefinition',
                            'Filled entities add one synthetic, never-instantiated block definition (*FillBoundary); it holds boundary polylines only and produces no draws'],
        },
        {
            'feature': 'dxf-layers-and-visibility', 'status': 'verified-scope', 'evidenceLevel': ['A', 'B'],
            'phase': 'K',
            'scope': 'layer table names, colour, linetype, lineweight, off/frozen/locked/plot flags; layer-0 content inside an INSERT inherits the INSERT layer',
            'mechanism': 'standard-confirmed', 'evidenceIds': ['dxf-spec', 'ezdxf'],
            'evidence': [
                {'artifact': verification, 'observed': 'layer name sets and on/off/frozen flags match dxf-parser; only VP-freeze (flag bit 2) is reported differently by that parser'},
                {'artifact': browser, 'observed': 'hiding the hatch layer turns the fill pixel white and restoring it brings the fill back; source visibility and user visibility stay separate'},
                {'artifact': browser_k, 'observed': 'qcad_entities layer panel totals equal the 567 built draws; 72 layer-0 block draws resolve to their INSERT layer colour, and toggling the published effective layer hides the inherited draws (567->219->567)'},
                {'artifact': annotations_check, 'observed': '0 colour mismatches for every instantiated layer-0 block entity; explicit entity colours stay explicit'},
            ],
            'limitations': ['Per-viewport layer overrides beyond the frozen list are not resolved', 'ACI 7 resolves to black for the white-sheet viewer; true colour is never rewritten'],
        },
        {
            'feature': 'dxf-annotations', 'status': 'partial', 'evidenceLevel': ['B'], 'phase': 'K',
            'scope': 'TEXT/MTEXT placement and direction, ATTDEF template vs ATTRIB instance value, DIMENSION record and anonymous geometry block, missing presentation marked explicitly',
            'mechanism': 'standard-confirmed', 'evidenceIds': ['dxf-spec', 'ezdxf', 'policy'],
            'evidence': [
                {'artifact': browser_i, 'observed': 'paper title block and dimension text render from block geometry; layout has 42 text draws'},
                {'artifact': browser_k, 'observed': 'flange layout: 46 texts with finite measured boxes and 5/5 clicked boxes select the annotation; cw750 draws 446 texts including 29 ATTRIB values (DETNO/SHEETNO/QTY)'},
                {'artifact': annotations_check, 'observed': 'AC1009 4 / cw750 91 ATTRIB annotations materialised; ATTDEF templates are missing-reference; qcad_flange 6 DIMENSIONs without a geometry block are missing-reference with dimension-presentation-missing losses'},
            ],
            'limitations': ['ATTDEF is never drawn as text; only INSERT ATTRIB values are shown',
                            'DIMENSION without its anonymous geometry block is marked missing-reference, not reconstructed',
                            'Fonts are substituted by the viewer (font-substitution); text width differences are not geometry errors',
                            'MTEXT inline formatting codes are preserved but not rendered',
                            'Dimension measurement, associativity and tolerances are not reconstructed'],
        },
        {
            'feature': 'dxf-paper-space-and-viewports', 'status': 'partial', 'evidenceLevel': ['A', 'B'],
            'scope': 'layouts, sheets, paper size, orthographic top-view viewports, rectangular clip boundary',
            'mechanism': 'standard-confirmed', 'evidenceIds': ['dxf-spec', 'ezdxf', 'policy'],
            'evidence': [
                {'artifact': browser_i, 'observed': 'QCAD flange Layout renders paper sheet, 3 projected viewports and title block; layout projection 633 draws'},
                {'artifact': perf, 'observed': 'layout projections of all 11 samples built without re-parsing the DXF'},
                {'artifact': viewport_stats, 'observed': 'qcad_flange: 6 VIEWPORT records = 4 model-projection viewports (3 enabled) + 2 paper-container viewports; coverage sourceRead reports the same 6/4/3'},
            ],
            'limitations': ['Perspective and non-top viewports are skipped and recorded as losses',
                            'Clipping is a rectangular boundary only; non-rectangular viewport clipping is not applied',
                            'qcad_flange has 6 VIEWPORT records: 4 project model space (1E80, 21AF, 21B0 disabled, 38C9) and 2 are paper containers (523B, 5241). The earlier "4 records" wording conflated the 4 model viewports with every record; the per-record status is explicit in extensions.org.cad-preview.dxf/1.paperSpace.viewports'],
        },
        {
            'feature': 'dxf-display-representation', 'status': 'verified-scope', 'evidenceLevel': ['A', 'B'],
            'scope': 'separate Representation(kind=drawing) discretisation, analytic entity geometry kept as source data; filled entities use a triangle representation and the analytic boundary keeps its source curves',
            'mechanism': 'standard-confirmed', 'evidenceIds': ['dxf-spec', 'policy'],
            'evidence': [
                {'artifact': browser, 'observed': 'display mode draws fills from triangle representations; analytic mode rebuilds the same fills from the source boundary entities (5 fills / 6 rings on the conformance fixture)'},
                {'artifact': browser_i, 'observed': 'display mode builds 222 draws from the representation; analytic mode rebuilds the same 222 draws from source curves'},
            ],
            'limitations': ['Display polylines use relative sagitta 1e-3, angular step <= 6 deg, <= 4096 segments per curve; they are not source curves',
                            'Fill triangulation is display-only; the analytic boundary stays authoritative'],
        },
        {
            'feature': 'dxf-solid-fill', 'status': 'verified-scope', 'evidenceLevel': ['A', 'B', 'C'],
            'scope': 'SOLID entities as a filled Hatch: DXF corner order 1,2,4,3, quad plus degenerate-triangle form, derived boundary entity, triangle display representation',
            'mechanism': 'standard-confirmed', 'evidenceIds': ['dxf-spec', 'policy'],
            'evidence': [
                {'artifact': verification, 'observed': 'acadsharp AC1009: 345 SOLID records are now filled; per-type source counts unchanged'},
                {'artifact': fill_geometry, 'observed': 'all 345 AC1009 SOLID triangles match the independent raw group-code polygon (area/bbox); the spline case is the only skipped fill'},
                {'artifact': ledger, 'observed': 'every SOLID in every sample is filled or explicitly refused; 564 solid source entities reconcile with 561 fills and 94 recorded refusals (2 gradient + 1 multipath style fixture + 91 pattern HATCH)'},
                {'artifact': cad_visual, 'observed': 'LibreCAD 2.2.1 dxf2pdf renders librecad_dim_sample; all 4 SOLID fills are matched by scale, bbox and centre, the extra PDF fills being dimension arrowheads'},
                {'artifact': cad_visual_verification, 'observed': 'without LibreCAD, the stored PDF/PNG artifacts are re-read: sha256 and sizes match, 4 files / 15 matches / 1 render-only / 0 failures, and ledger totals still reconcile'},
                {'artifact': browser, 'observed': '344 fills render in the browser; the fixture SOLID quad and triangle pixels match the source colour'},
            ],
            'limitations': ['C-level evidence covers 4 SOLID entities in one real file, not every sample; LibreCAD 2.2.1 is not bundled with the project',
                            'TRACE now shares the polygon path; its v0.13.0 evidence is synthetic, separate from this historical real-file audit',
                            'Non-planar/extruded solids are only correct on their OCS plane',
                            'SOLID inside blocks that are never instantiated still produces no draw'],
        },
        {
            'feature': 'dxf-hatch-solid-fill', 'status': 'verified-scope', 'evidenceLevel': ['A', 'B', 'C'],
            'scope': 'solid HATCH subset: hatch style 0/1/2 read from group 75; line/arc/ellipse/spline boundary paths reordered by endpoint pairing; polyline paths with bulges; multiple paths, even-odd holes, derived boundary polylines + analytic edge records',
            'mechanism': 'standard-confirmed', 'evidenceIds': ['dxf-spec', 'policy'],
            'evidence': [
                {'artifact': fill_geometry, 'observed': '560 fills across 11 real files and 2 fixtures match independent raw-boundary area/bbox with 0 failures (qcad_example00 6, AC1015 16, AC1032 14, cw750 67, AC1009 345, qcad_example01 27, qcad_entities 69, librecad_dim_sample 4, qcad_flange 5, fixtures 7 checked of 8); the only skipped fill is a spline edge boundary'},
                {'artifact': ledger, 'observed': '561 of 564 solid source entities are filled; solid refusals are 2 real gradient HATCH (AC1032) + 1 multipath style-1 fixture with no EXTERNAL/OUTERMOST path, plus 91 pattern HATCH refusals. qcad_flange and cw750 are no longer refused'},
                {'artifact': cad_visual, 'observed': 'LibreCAD 2.2.1 renders qcad_example00 (6/6 fills), librecad_dim_sample (4/4), qcad_flange (5/5) and cw750 as a render-only layout view; all 15 placements and the six ACI colours agree; TRUE fill-path area agrees for 14/15. qcad_flange handle 225A is reclassified as a renderer artifact: the UCD fill follows the DXF even-odd rule (ratio 1.000385 against raw boundary paths), while the LibreCAD PDF dropped the largest ring (4.702 mm2) and substituted a 0.007 mm2 ring; it is recorded in areaComparison.rendererArtifacts, not as a UCD divergence'},
                {'artifact': cad_visual_verification, 'observed': 'without LibreCAD the stored PDF/PNG artifacts are re-read: sha256/sizes match, 4 files / 15 matches / 1 render-only / 0 failures; true path area is re-measured: 14/15 agree and the 225A renderer artifact is cross-checked against the raw-boundary rule evidence (phase_k_evidence/profiles/dxf-225a-rule.json), and a record storing a bbox area as area is rejected'},
                {'artifact': browser, 'observed': 'six real solid hatches render with their ACI colours; the circular hole in the fixture stays unfilled in both pixel probe and hit test'},
                {'artifact': fixture, 'observed': 'conformance fixture (not acceptance evidence) covers holes, arcs and splines, one pattern hatch, one multipath style-1 hatch whose two paths have no EXTERNAL/OUTERMOST flag and must be refused, and an OCS extrusion (0,0,-1)'},
                {'artifact': ocs_audit, 'observed': 'independent group-code audit checks hatch extrusion, style and path flags without trusting ezdxf'},
                {'artifact': hatch_style, 'observed': '20 minimal AC1015 cases cover style 0/1/2, style 1/2 multipath with EXTERNAL/OUTERMOST/ignore combinations, no-qualifying-path refusal, raw style 3, missing group 75 (DEFAULT), flags 1/4/16, textbox-only, mixed textbox, unknown flag bit 32; each fills or is refused with the recorded reason (20/20)'},
                {'artifact': hatch_gradient, 'observed': '4 AC1018 fill modes: solid (group 70=1) fills; pattern (70=0) is pattern-fill-unsupported; gradient (70=1, group 450 kind=1) is gradient-fill-unsupported; 450 kind=0 stays solid. Group 70 alone cannot classify gradients (4/4)'},
                {'artifact': hatch_tolerance, 'observed': 'unordered closed boundaries fill at scales 1, 1e6 and 1e-3; a 1e-5 absolute gap and a missing edge are refused as hatch-boundary-discontinuous at all three scales (9/9)'},
                {'artifact': refusal_audit, 'observed': 'qcad_flange 225A-D/226A have max endpoint residual 2.3e-13 with 9-24 sequential gaps up to 2.46 units, so the old sequential check was a reader error; cw750 E53-E55/230F/2310/2311/99D2-D4 have bulges and one coincident-ring pair, and all 14 former refusals now fill and verify independently. For 225A the independent DXF-rule check (HATCH style 0, 7 rings, even-odd 4.793721 mm2 vs UCD 4.795567) reproduces the UCD fill, while the LibreCAD PDF path drops ring 6 and adds a 0.007 mm2 ring (PDF even-odd 6.43495, ratio 1.341854)'},
            ],
            'limitations': ['Pattern fills (including ANSI31 in QCAD flange), gradient fills (including the two real AC1032 gradients) and hatch associativity are not implemented and stay registered as unsupported',
                            'Style 1/2 are filtered by group 92: style 1 keeps EXTERNAL/OUTERMOST, style 2 keeps EXTERNAL. A multipath hatch with no qualifying path is refused (hatch-style-unsupported:<n>-multipath); nested selected rings still use even-odd, not a full style-0 nesting rebuild',
                            'Edge order is not semantic: endpoints are paired at 1e-6 absolute. Gaps below that floor cannot be distinguished from arc endpoint round-off and are not claimed discontinuous',
                            'A boundary with an unpaired endpoint (missing edge or branching endpoint) is refused as hatch-boundary-discontinuous rather than filling a guessed subset',
                            'Ellipse and spline edges are read, but the independent verifier only checks line/arc/bulge boundaries; one spline edge fill is therefore skipped in verification',
                            'Associative boundary re-computation from source entities is not performed',
                            'Boundary edges beyond line/arc/ellipse/spline raise a recorded reason instead of being approximated'],
        },
        {
            'feature': 'dxf-hatch-boundary-tolerance', 'status': 'verified-scope', 'evidenceLevel': ['A'],
            'scope': 'HATCH boundary reconstruction: edge endpoints are paired into closed loops at 1e-6 drawing units regardless of source edge order; polyline bulges are flattened for display while the analytic vertices/bulges stay authoritative',
            'mechanism': 'standard-confirmed', 'evidenceIds': ['dxf-spec', 'policy'],
            'evidence': [
                {'artifact': hatch_tolerance, 'observed': '9/9 cases: unordered closed boundaries fill at scales 1, 1e6 and 1e-3; a 1e-5 absolute gap and a missing edge are refused as hatch-boundary-discontinuous at every scale'},
                {'artifact': refusal_audit, 'observed': 'all 621 measured real edge endpoints pair within 6.6e-7 (qcad_flange max 2.3e-13), so the 1e-6 tolerance is numerical, not a per-sample fudge; the audit keeps the sequential-gap numbers that exposed the earlier reader error'},
                {'artifact': fill_geometry, 'observed': '560 fills with 0 failures after the reconstruction change; flange and cw750 now verify against the independent group-code reader'},
            ],
            'limitations': ['The tolerance is absolute. A real gap below 1e-6 units is indistinguishable from arc endpoint round-off and is not claimed discontinuous',
                            'Only planar HATCH boundaries on their OCS plane are reconstructed; non-planar extrusion is out of scope',
                            'Display flattening uses the documented relative sagitta; the analytic boundary remains the source record'],
        },
        {
            'feature': 'dxf-fill-boundary-model', 'status': 'verified-scope', 'evidenceLevel': ['A'],
            'scope': 'how inline DXF boundaries are represented without changing UCD 2.0 field meanings',
            'mechanism': 'standard-confirmed', 'evidenceIds': ['schema', 'policy'],
            'evidence': [
                {'artifact': verification, 'observed': 'schema validation passes for every sample; Hatch.boundaryEntityIds resolves to derived polyline entities'},
                {'artifact': parity, 'observed': 'derived boundary entities live in an uninstantiated block space, so no extra draws appear in either projection'},
                {'artifact': derived, 'observed': 'derived block/space ids and names are document-scoped, never instantiated, and carry sourceRefs to the originating hatch; a fixture whose source block is literally named *FillBoundary gets *FillBoundary~1 and keeps the source block untouched'},
                {'artifact': ledger, 'observed': 'fill entities, boundary entities and refusal reasons reconcile with the source inventory per file'},
            ],
            'limitations': ['The exact analytic boundary lives in extensions.org.cad-preview.fill/1, not in UCD 2.0 core fields',
                            'A consumer that ignores the extension still sees a valid Hatch with typed boundary entities, but loses the analytic edge detail',
                            'Fills whose boundary has an unpaired endpoint or whose style/edge subset is unsupported are refused rather than represented'],
        },
        {
            'feature': 'dxf-unsupported-registry', 'status': 'verified-scope', 'evidenceLevel': ['A'],
            'scope': 'every unmapped DXF entity type is registered as UnsupportedEntity with a reason and never given guessed geometry',
            'mechanism': 'standard-confirmed', 'evidenceIds': ['dxf-spec', 'policy'],
            'evidence': [{'artifact': verification, 'observed': 'skipped-type counts equal the difference between UCD source records and dxf-parser counts'}],
            'limitations': ['This historical row covers the original HATCH subset; later display adaptations and TRACE support require their own evidence',
                            'A partially supported type only renders its declared subset; the rest is never approximated'],
        },
        {
            'feature': 'dxf-input-limits', 'status': 'verified-scope', 'evidenceLevel': ['B'],
            'scope': '64 MiB upload/stdin, ' + str(MAX_ENTITIES) + ' source records, ' + str(MAX_PROJECTION_DRAWS) + ' projection draws, 60 s worker budget, base64 default plus opt-in binary transport',
            'mechanism': 'standard-confirmed', 'evidenceIds': ['policy'],
            'evidence': [
                {'artifact': perf_before, 'observed': 'pre-Phase-J baseline of the same benchmark: 4,488 records in 4.80 s, peak RSS 245 MB'},
                {'artifact': perf, 'observed': 'after Phase J: median 3.118 s over two independent runs (parse spread 0.8%), peak RSS 314.6 MB, envelope 16.43 MB for the same file. Parse time and envelope are reported; the RSS rise is recorded and not claimed as an improvement'},
                {'artifact': 'phase_j_evidence/profiles/dxf-performance-repeat.json', 'observed': 'two raw runs are kept; max spread across all samples is 46% (tiny files), so small deltas are not treated as regressions or improvements'},
            ],
            'limitations': ['Files above ' + str(MAX_ENTITIES) + ' records are rejected with dxf-limit-exceeded before mapping',
                            'Binary DXF files, selection-scoped parsing and DWG are rejected explicitly, not silently downgraded',
                            'Binary *transport* is opt-in (?transport=binary); the default stays base64 for unchanged clients'],
        },
        {
            'feature': 'dxf-transport', 'status': 'verified-scope', 'evidenceLevel': ['A', 'B'],
            'scope': 'base64 envelope (default) and opt-in ucd-binary-manifest/1 for the same validated envelope; the worker writes buffers next to itself',
            'mechanism': 'engineering-contract', 'evidenceIds': ['policy'],
            'evidence': [
                {'artifact': transport, 'observed': 'latest cold 4,488-record run: body 18.19 MB -> 16.63 MB manifest (-8.6%), browser install 6.25 s -> 5.26 s, wall 6.40 s -> 5.42 s; server-side parse unchanged (~3.1 s); both transports load the same 47 fills / 5,420 draws. Wall/install vary by run; the profile keeps raw numbers'},
                {'artifact': '10_独立解析查看器/tests/check_dxf_isolation.py', 'observed': 'binary manifest has no bufferPayloads, one resource per buffer, resource bytes match byteLength; base64 cache entries still serve base64'},
            ],
            'limitations': ['Binary transport is opt-in; the default stays base64 so unchanged clients keep working',
                            'Buffers are only ~1.15 MB of the 18 MB payload, so remaining transfer cost is the document/draw JSON, not base64 overhead',
                            'Resource leases expire after 300 s and are bounded to 256 MiB'],
        },
        {
            'feature': 'dxf-browser-viewer', 'status': 'verified-scope', 'evidenceLevel': ['B'], 'phase': 'K',
            'scope': 'Canvas2D viewer: pan/zoom, pick and highlight, layer panel, block instance selection, model/paper switching, display vs analytic modes, filled entities, text measurement/selection boxes',
            'mechanism': 'standard-confirmed', 'evidenceIds': ['policy'],
            'evidence': [
                {'artifact': browser_i, 'observed': 'default entry loads UCD EASM; DXF sample renders 223 draws, layer toggle 216->100->216, analytic rebuild 222, layout 633, pick hit, block instances disjoint, R12 frozen layers reported, legacy flag still selects the old bridge'},
                {'artifact': browser, 'observed': 'fill pixel probes, hole hit test, layer isolation and unsupported pattern registration pass on real files and the fixture'},
                {'artifact': transport, 'observed': 'the opt-in binary manifest hydrates the same 5,420-draw document with 47 loaded fills; latest install 5.26 s vs 6.25 s for the 18 MB base64 envelope'},
                {'artifact': browser_k, 'observed': 'flange layout 637 draws/46 texts with finite boxes, text click selects annotation, cw750 ATTRIB values render, qcad_entities layer totals match built draws and an effective-layer toggle hides/restores inherited content, layout switch is stable (637 draws before and after another upload)'},
            ],
            'limitations': ['Line weights are approximated in screen pixels; dashes use world units',
                            'Viewer-side operations never rewrite the UCD document or source visibility'],
        },
        {
            'feature': 'dxf-schema-gaps', 'status': 'partial', 'evidenceLevel': ['A'],
            'scope': 'four gaps, each with one documented resolution; one Phase I claim is withdrawn',
            'mechanism': 'standard-confirmed', 'evidenceIds': ['schema', 'policy'],
            'evidence': [
                {'artifact': 'DXF_CAPABILITY_MATRIX.json', 'observed': 'schemaGaps lists field, schema state, resolution and compatibility for every gap'},
                {'artifact': '10_独立解析查看器/unified/schema/ucd-2.0.schema.json', 'observed': 'EntityStyle.color.mode already enumerates explicit/by-layer/by-block/unknown; Hatch and HatchPattern exist in 2.0'},
            ],
            'limitations': ['Line type/line weight BYLAYER/BYBLOCK modes are still not expressible in EntityStyle',
                            'Annotation still has no style field',
                            'Hatch.boundaryEntityIds references entities only, so inline boundaries need the fill extension'],
        },
    ]


def build():
    dxf = {
        'schemaVersion': '1.1.0',
        'generatedAt': '2026-10-19',
        'project': 'CAD 独立解析查看器 · Phase K',
        'projectInfo': {'name': 'CAD 独立解析查看器', 'phase': 'K',
                        'phaseTitle': '真实图纸语义、图层继承与证据更正', 'version': '2.0.0-phase-k',
                        'ucdSchema': 'urn:cad-preview:ucd:2.0.0', 'generatedAt': '2026-10-19'},
        'format': 'DXF',
        'statusVocabulary': {
            'verified-scope': 'Observed and checked on the named real files and limits with reproducible artifacts; the scope is exactly what is listed.',
            'partial': 'Some fields or sub-behaviours are carried and checked; the rest of the capability is missing.',
            'experimental': 'Implemented but not accepted as supported.',
            'unsupported': 'Not implemented or not mapped; absence is never reported as a source-file error.',
            'failed': 'A concrete attempt on a real file failed for a recorded, non-generic reason.',
        },
        'evidenceLevels': EVIDENCE_LEVELS,
        'engine': {'name': 'ezdxf', 'version': ENGINE, 'license': 'MIT',
                   'pin': 'requirements-dxf.txt', 'role': 'independent open-source DXF reader; no Autodesk SDK and no eDrawings path'},
        'input': {
            'extensions': ['.dxf'], 'encodings': ['ASCII DXF'], 'binaryDxf': False, 'dwg': False,
            'maxBytes': 67108864, 'maxEntities': MAX_ENTITIES, 'maxProjectionDraws': MAX_PROJECTION_DRAWS,
            'maxSegmentsPerCurve': MAX_CURVE_SEGMENTS, 'workerTimeoutSeconds': 60,
            'transportProfiles': ['ucd-base64-envelope/1', 'ucd-binary-manifest/1'],
            'transportDefault': 'ucd-base64-envelope/1',
            'binaryTransport': 'opt-in with ?transport=binary&model=ucd; same worker, buffers written next to the worker',
            'selectionScoped': False,
            'modelQuery': 'model=ucd (mandatory); the legacy packet path rejects DXF',
        },
        'errorClassification': [
            {'code': 'unsupported-file-type', 'meaning': 'file extension is not EASM/STEP/DXF', 'not': 'a corrupt DXF'},
            {'code': 'dxf-requires-ucd', 'meaning': 'DXF was requested without model=ucd', 'not': 'a parse failure'},
            {'code': 'dxf-selection-unsupported', 'meaning': 'selection-scoped parse requested for DXF', 'not': 'an empty file'},
            {'code': 'dxf-parse-error', 'meaning': 'ezdxf could not read the file or a record raised', 'not': 'an unsupported feature'},
            {'code': 'dxf-structure-error', 'meaning': 'the file read but required structures (tables, blocks) are missing/inconsistent', 'not': 'a version limitation'},
            {'code': 'dxf-limit-exceeded', 'meaning': 'record or projection-draw cap exceeded', 'not': 'a source-file defect'},
            {'code': 'missing-dxf-runtime', 'meaning': 'the pinned ezdxf interpreter is unavailable', 'not': 'a DXF capability limit'},
        ],
        'entityReasonCodes': [
            {'prefix': 'pattern-fill-unsupported', 'entity': 'HATCH', 'meaning': 'the HATCH is a pattern fill (group 70 solid_fill=0); pattern rendering is out of the declared subset'},
            {'prefix': 'gradient-fill-unsupported', 'entity': 'HATCH', 'meaning': 'the HATCH carries group 450 kind=1 (gradient) even though group 70 solid_fill=1; checked before pattern/solid dispatch so a gradient is never painted as one solid colour'},
            {'prefix': 'hatch-edge-unsupported', 'entity': 'HATCH', 'meaning': 'a boundary edge type outside line/arc/ellipse/spline was found; no approximation is attempted'},
            {'prefix': 'hatch-boundary-degenerate', 'entity': 'HATCH/SOLID', 'meaning': 'the boundary has fewer than three distinct points'},
            {'prefix': 'hatch-nesting-unresolved', 'entity': 'HATCH', 'meaning': 'hole nesting could not be resolved by even-odd containment'},
            {'prefix': 'hatch-triangulation-empty', 'entity': 'HATCH/SOLID', 'meaning': 'triangulation produced no triangles; the entity stays unsupported'},
            {'prefix': 'hatch-area-mismatch', 'entity': 'HATCH/SOLID', 'meaning': 'triangle area disagrees with the boundary area beyond tolerance; the fill is rejected'},
            {'prefix': 'hatch-triangulation-mismatch', 'entity': 'HATCH/SOLID', 'meaning': 'triangulation self-check failed; the fill is rejected rather than drawn'},
            {'prefix': 'hatch-style-unreadable', 'entity': 'HATCH', 'meaning': 'group 75 (hatch style) has a non-numeric value; an absent group 75 is the DXF default style 0, not an error'},
            {'prefix': 'hatch-style-unsupported', 'entity': 'HATCH', 'meaning': 'hatch style outside 0/1/2, or style 1/2 has multiple paths and none carries the flag that style requires (style 1: EXTERNAL/OUTERMOST, style 2: EXTERNAL); refused instead of filled as odd-parity'},
            {'prefix': 'hatch-path-flags-unsupported', 'entity': 'HATCH', 'meaning': 'group 92 uses bits outside the five documented flags (1 external, 2 polyline, 4 derived, 8 textbox, 16 outermost); refused rather than guessed'},
            {'prefix': 'hatch-boundary-discontinuous', 'entity': 'HATCH', 'meaning': 'at least one boundary endpoint has no partner (or more than one) within the 1e-6 numerical tolerance; refused instead of filling a guessed subset'},
            {'prefix': 'hatch-textbox-only', 'entity': 'HATCH', 'meaning': 'every boundary path is a textbox (flag 8); textbox outlines are not drawn as fill boundaries'},
            {'prefix': 'hatch-without-boundary', 'entity': 'HATCH', 'meaning': 'no non-textbox boundary path remains'},
            {'prefix': 'solid-degenerate', 'entity': 'SOLID', 'meaning': 'fewer than three distinct corners'},
        ],
        'sourceVersions': {'verified': ['AC1009', 'AC1015', 'AC1021', 'AC1024', 'AC1027', 'AC1032'],
                           'releaseNames': RELEASE,
                           'note': 'Versions not present in the sample set are not claimed'},
        'entityMapping': {
            'supported': [{'dxf': name, **SUPPORTED[name]} for name in CORE_ENTITIES],
            'filled': [{'dxf': name, **FILLED[name]} for name in FILL_ENTITIES],
            'annotations': [{'dxf': name, **ANNOTATIONS[name]} for name in ANNOTATION_ENTITIES],
            'unsupported': [{'dxf': name, 'reason': reason, 'ucd': 'UnsupportedEntity'} for name, reason in sorted(UNSUPPORTED_REASONS.items())],
        },
        'schemaGaps': [
            {'id': 'style-colour-modes', 'field': 'EntityStyle.color.mode',
             'schemaState': 'supported', 'modes': ['explicit', 'by-layer', 'by-block', 'unknown'],
             'resolution': 'native UCD 2.0 field', 'compatibility': 'none needed',
             'note': 'Phase I reported this as a gap; the schema already enumerates by-layer/by-block. The claim is withdrawn.'},
            {'id': 'style-linetype-lineweight-modes', 'field': 'EntityStyle.lineTypeId / EntityStyle.lineWeight',
             'schemaState': 'not-expressible', 'modes': ['by-layer', 'by-block', 'default'],
             'resolution': 'extensions["org.cad-preview.style-inheritance/1"].modes',
             'compatibility': 'additive extension; existing EntityStyle field meanings are unchanged'},
            {'id': 'annotation-style', 'field': 'Annotation',
             'schemaState': 'absent', 'resolution': 'extensions["org.cad-preview.style-inheritance/1"].annotationStyles, resolved into DrawingDraw.style',
             'compatibility': 'additive extension; annotations stay readable without it'},
            {'id': 'hatch-inline-boundaries', 'field': 'Hatch.boundaryEntityIds',
             'schemaState': 'entity-reference-only', 'resolution': 'derived boundary polyline entities in an uninstantiated block space + extensions["org.cad-preview.fill/1"] analytic records',
             'compatibility': 'additive extension; Hatch fields keep their meaning and the schema is not modified'},
        ],
        'capabilities': capability_rows(),
        'evidence': {
            'samples': 'phase_i_evidence/samples/real',
            'provenance': 'phase_i_evidence/samples/PROVENANCE.json',
            'independentParser': 'phase_i_evidence/samples/independent/COMPARISON.md',
            'verification': 'phase_i_evidence/samples/independent/VERIFICATION.md',
            'projectionParity': 'phase_i_evidence/profiles/dxf-projection-parity.json',
            'browser': 'phase_j_evidence/profiles/browser-phase-j.json',
            'browserPhaseI': 'phase_i_evidence/profiles/browser-phase-i.json',
            'performance': 'phase_i_evidence/profiles/dxf-performance.json',
            'transport': 'phase_j_evidence/profiles/dxf-transport.json',
            'fillGeometry': 'phase_j_evidence/profiles/dxf-fill-geometry.json',
            'fillFixture': 'phase_j_evidence/fixtures/fill_holes_curves.dxf',
            'renderReference': 'phase_i_evidence/render/RENDER_MANIFEST.json',
        },
    }
    DXF_MATRIX.write_text(json.dumps(dxf, ensure_ascii=False, indent=1) + '\n')

    root = json.loads(ROOT_MATRIX.read_text())
    root['generatedAt'] = '2026-10-19'
    root['phase'] = 'K'
    root['phaseNotes'] = ('K: layer-0 block inheritance is resolved once in projection and published as the draw effective layer; ATTDEF/ATTRIB separation and true text boxes in the 2D viewer; '
                          'STEP strict/partial audited on real assemblies and the W01 KEYPAD faces are repaired from the same B-Rep surface with area/deviation gates; the Phase J "area" value was a bbox area and is '
                          'corrected to true path area (14/15 agree; 225A is a LibreCAD dropped-ring artifact); DXF peak-RSS benchmark artefact '
                          'identified. Unchanged capabilities keep their lower status.')
    root['evidenceLevels'] = EVIDENCE_LEVELS
    root['schemaGaps'] = dxf['schemaGaps']
    root['rows'] = [row for row in root['rows'] if row['format'] != 'DXF']
    for row in dxf['capabilities']:
        root['rows'].append({
            'format': 'DXF', 'capability': row['feature'], 'status': row['status'],
            'scope': row['scope'], 'phase': row.get('phase', 'J'), 'evidenceLevel': row.get('evidenceLevel', []),
            'evidence': row['evidence'], 'limitations': row['limitations'],
        })
    root.setdefault('errorClassification', [])
    known = {entry['code'] for entry in root['errorClassification']}
    for entry in dxf['errorClassification']:
        if entry['code'] not in known:
            root['errorClassification'].append(entry)
    ROOT_MATRIX.write_text(json.dumps(root, ensure_ascii=False, indent=1) + '\n')
    print('DXF capabilities:', len(dxf['capabilities']))
    print('root rows:', len(root['rows']), 'DXF rows:', sum(1 for r in root['rows'] if r['format'] == 'DXF'))


if __name__ == '__main__':
    build()
