"""Keep explicit DXF gradient stops; geometry still comes from ezdxf boundaries."""
import io
import math

GRADIENT_NAMES = ('LINEAR', 'CYLINDER', 'INVCYLINDER', 'SPHERICAL', 'INVSPHERICAL',
                  'HEMISPHERICAL', 'INVHEMISPHERICAL', 'CURVED', 'INVCURVED')


def source_stops(raw, encoding):
    """ezdxf's low-level tag reader preserves absent RGB vs default black/white.

    Gradient.load_tags supplies default RGBs, so its public color1/2 alone cannot
    distinguish an ACI-only source from explicit black/white. Read the original
    HATCH stops once, only in documents containing gradients. No new DXF decoder.
    """
    from ezdxf.lldxf.tagger import ascii_tags_loader, binary_tags_loader
    from ezdxf.lldxf.tags import group_tags
    from ezdxf.colors import aci2rgb, int2rgb
    tags = (binary_tags_loader(raw) if raw.startswith(b'AutoCAD Binary DXF') else
            ascii_tags_loader(io.StringIO(raw.decode(encoding, errors='surrogateescape'),newline=None)))
    result = {}
    for group in group_tags(tags):
        if group[0].value != 'HATCH':
            continue
        handle = next((str(tag.value) for tag in group if tag.code == 5), '')
        active, stops = False, []
        for tag in group:
            if tag.code == 450:
                active = int(tag.value) == 1
            elif active and tag.code == 463:
                stops.append({'position': float(tag.value)})
            elif active and stops and tag.code in (63, 421):
                stops[-1]['rgb' if tag.code == 421 else 'aci'] = int(tag.value)
            elif tag.code == 1001:
                active = False
        if len(stops) != 2 or [stop['position'] for stop in stops] != [0.0, 1.0]:
            continue
        colors = []
        for stop in stops:
            if 'rgb' in stop and 0 <= stop['rgb'] <= 0xffffff:
                colors.append(list(int2rgb(stop['rgb'])))
            elif 0 < stop.get('aci', 0) < 256:
                colors.append(list(aci2rgb(stop['aci'])))
        if len(colors) == 2:
            result[handle] = colors
    return result


def display_spec(entity, rings, stops, basis):
    gradient = entity.gradient
    name = gradient.name.upper()
    if name not in GRADIENT_NAMES:
        raise ValueError('gradient-name-unsupported:' + name)
    values = (gradient.rotation, gradient.centered, gradient.tint)
    if not all(math.isfinite(v) for v in values):
        raise ValueError('gradient-parameters-nonfinite')
    # Code 461 is SHIFT (ezdxf's "centered" name is misleading). The field
    # uses the pinned truedxf AutoCAD-calibrated display fit, including SHIFT.
    if gradient.centered not in (0,1):
        raise ValueError('gradient-shift-out-of-range')
    colors = stops.get(str(entity.dxf.handle))
    if gradient.number_of_colors != 2 or colors is None:
        raise ValueError('gradient-source-stops-unsupported')
    points = [point for ring in rings for point in ring['points2d']]
    angle = math.radians(gradient.rotation)
    c, s = math.cos(angle), math.sin(angle)
    rotated = [(p[0] * c + p[1] * s, -p[0] * s + p[1] * c) for p in points]

    def bounds(points):
        xs, ys = zip(*points)
        return [min(xs), min(ys), max(xs), max(ys)]

    domain, frame = bounds(points), bounds(rotated)
    if min(domain[2] - domain[0], domain[3] - domain[1], frame[2] - frame[0], frame[3] - frame[1]) <= 1e-12:
        raise ValueError('gradient-degenerate-domain')
    return {'profile': 'truedxf-gradient-field/1', 'name': name, 'colors': colors,
            'angleRadians': angle, 'shift': float(gradient.centered),
            # 452 and 462 are dialog-only, per Autodesk. Display uses the actual
            # two stored stops, including a source's precomputed single-color tint.
            'oneColor': int(gradient.one_color), 'tint': float(gradient.tint),
            'domain': domain, 'frameBounds': frame, 'localToOwner': basis,
            'method': 'truedxf 019c2e5 calibrated field + Canvas clipped texture',
            'fidelity': 'display fit; CAD Gouraud tessellation/dither is not reproduced'}
