"""Display area policy, revised by the user on 2026-10-20.

Ordinary faces retain the 2% check. For a microface up to the already approved
0.001 mm2 ceiling, allow an absolute discrepancy of 2% of that ceiling:
0.000020 mm2. This avoids a percentage-only rejection of a tiny display repair.
It is an engineering policy, not an OCCT/STEP accuracy guarantee. Source-domain,
boundary, winding and source-identity checks are separate and remain required.
"""
import math

AREA_POLICY='step-display-area/2'
RELATIVE_AREA_ERROR=.02
MICRO_FACE_AREA_MM2=.001
MICRO_ABSOLUTE_AREA_ERROR_MM2=MICRO_FACE_AREA_MM2*RELATIVE_AREA_ERROR

def display_area_check(source_area,mesh_area):
    valid=all(math.isfinite(x) and x>0 for x in (source_area,mesh_area))
    if not valid:return {'policy':AREA_POLICY,'accepted':False,'reason':'nonpositive-or-nonfinite-area'}
    difference=abs(mesh_area-source_area);relative_limit=source_area*RELATIVE_AREA_ERROR
    # Do not expand numerically zero faces just to obtain a visible replacement.
    micro=1e-9<source_area<=MICRO_FACE_AREA_MM2
    limit=max(relative_limit,MICRO_ABSOLUTE_AREA_ERROR_MM2) if micro else relative_limit
    return {'policy':AREA_POLICY,'accepted':difference<=limit,'sourceAreaMM2':source_area,
            'meshAreaMM2':mesh_area,'absoluteErrorMM2':difference,'relativeError':difference/source_area,
            'maximumErrorMM2':limit,'microFace':micro,
            'criterion':'relative-2-percent' if difference<=relative_limit else 'microface-absolute-area' if micro else 'relative-2-percent'}
