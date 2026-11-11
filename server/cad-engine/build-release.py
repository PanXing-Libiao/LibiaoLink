"""Build/check the release identity from this repository's canonical CAD sources."""
import argparse
import hashlib
import json
from pathlib import Path

BASE = Path(__file__).resolve().parent
COMPATIBILITY_FILE = "format-compat.json"
ENTRY_POINTS = ('convert.py', 'states.py', 'provenance.py', 'parser-provenance.json',
                'evidence-index.json', 'step_convert.py', 'dxf_convert.py', 'dwg_convert.py',
                'dwg_platform_convert.py', 'ucd_convert.py')
# The pinned ACadSharp reader source and pin define the DWG binary even though the
# compiled DLL lives outside the repository; a reader change must rebuild DWG
# artifacts, so its sources join the DWG format identity.
READER_FILES = ('Program.cs', 'CommunityText.cs', 'HatchEmptyPattern.cs', 'LegacyMTextColumns.cs',
                'Reader.csproj', 'dependency.json', 'build.py')
RUNTIME_FILES = ('bridge.py', 'result_cache.py', 'service.py', 'sandbox.py', 'edge.py',
                 'release.py', 'requirements-step.txt', 'requirements-step-mesher.txt',
                 'requirements-dxf.txt', 'requirements-dxf-build.txt', 'requirements-dwg.txt', 'requirements-acis.txt')
FORMAT_NEUTRAL_FILES = {'service.py', 'dwg_platform_convert.py', 'unified/conversion_jobs.py'}
IMPORTED_COMMIT = '337bfc0d185a82cc3e269afaff879ccfc67a2e57'
FORMAT_RELEASES = {'STEP': '0.3.3', 'DXF': '0.15.0', 'DWG': '0.1.0'}
FORMAT_RUNTIME = {
    'STEP': ('requirements-step.txt', 'requirements-step-mesher.txt'),
    'DXF': ('requirements-dxf.txt', 'requirements-dxf-build.txt'),
    'DWG': ('requirements-dwg.txt', 'requirements-acis.txt', 'requirements-step.txt'),
}


def source_files(root):
    for path in sorted(root.rglob('*')):
        if any(p == '__pycache__' or p == 'build' or p.endswith('.egg-info') for p in path.parts):
            continue
        if path.is_file() and not path.is_symlink() and path.suffix not in ('.pyc', '.so', '.pyd', '.c'):
            yield path


def hashes(paths, root):
    # Sort by the fixed POSIX relative path, not by Path objects: PurePath ordering
    # follows the host filesystem's case rules on Windows but not on Linux.
    ordered = sorted(paths, key=lambda path: path.relative_to(root).as_posix())
    return {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in ordered}


def format_of(name):
    """Keep format-specific code out of the other format's cache identity."""
    if name.startswith('dwg-reader/'):
        return 'DWG'
    if name == 'unified/dwg-reader.json':
        return 'DXF'
    if name.startswith(('parser/', 'unified/step_', 'vendor/cadcraft-display/')) \
            or name in ('step_convert.py', 'parser-provenance.json', 'evidence-index.json'):
        return 'STEP'
    if name.startswith(('unified/dxf_', 'vendor/ezdxf/')) or name == 'dxf_convert.py':
        return 'DXF'
    if name.startswith('unified/dwg_'):
        return 'DWG'
    if name in ('dwg_convert.py', 'dwg_platform_convert.py', 'unified/dwg_adapter.py', 'unified/dwg_pack.py'):
        return 'DWG'
    # LibreDWG decodes DWG external references inside the DXF path and its
    # version/spec is part of that output, so it must key DXF artifacts too.
    return 'SHARED'


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def compatibility(base, format_versions):
    path = base / COMPATIBILITY_FILE
    result = {name: [] for name in FORMAT_RELEASES}
    if not path.is_file():
        return result
    data = json.loads(path.read_text())
    formats = data.get("formats", data) if isinstance(data, dict) else None
    if not isinstance(formats, dict):
        raise ValueError("CAD format compatibility file must be an object")
    unknown = set(formats) - set(FORMAT_RELEASES)
    if unknown:
        raise ValueError("unknown CAD compatibility formats: " + ", ".join(sorted(unknown)))
    prefixes = {"STEP": "step-", "DXF": "dxf-", "DWG": "dwg-"}
    for name in FORMAT_RELEASES:
        values = formats.get(name, [])
        if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
            raise ValueError("CAD compatibility versions must be string arrays")
        for value in values:
            if not value.startswith(prefixes[name]) or not value.endswith("/gateway-1"):
                raise ValueError("invalid CAD compatibility version: " + value)
            if value == format_versions[name]:
                raise ValueError("current CAD format version cannot be a compatibility alias")
        result[name] = sorted(set(values))
    return result


def describe(base, browser):
    core = base / 'core'
    paths = [core / name for name in ENTRY_POINTS]
    for directory in ('parser', 'unified', 'vendor'):
        paths.extend(source_files(core / directory))
    engine_files = hashes(paths, core)
    reader_files = hashes([base / 'dwg-reader' / name for name in READER_FILES], base / 'dwg-reader')
    browser_files = hashes(source_files(browser), browser)
    runtime_files = hashes([base / name for name in RUNTIME_FILES], base)

    shared = {}
    format_files = {'STEP': {}, 'DXF': {}, 'DWG': {}}
    for name, value in engine_files.items():
        if name in FORMAT_NEUTRAL_FILES:
            continue
        kind = format_of(name)
        if kind in format_files:
            format_files[kind][name] = value
        else:
            shared[name] = value
    runtime_shared = {'runtime/' + name: value for name, value in runtime_files.items()
                      if name not in {item for names in FORMAT_RUNTIME.values() for item in names}
                      and name not in FORMAT_NEUTRAL_FILES}
    runtime_format = {format_name: {'runtime/' + name: runtime_files[name] for name in names}
                      for format_name, names in FORMAT_RUNTIME.items()}
    # ACIS reconstruction also consumes the pinned ezdxf record decoder and OCP runtime.
    format_files['DWG'].update({name: value for name, value in engine_files.items() if name.startswith('vendor/ezdxf/')})
    format_files['DWG'].update({name: engine_files[name] for name in ('unified/dxf_stroke.py', 'unified/dxf_fill.py',
        'unified/dxf_shx.py', 'unified/dxf_shxfont.py', 'unified/dxf_bigfont.py',
        'unified/dxf_mtext.py', 'unified/dxf_xref.py', 'unified/dxf_region.py', 'unified/dxf_resources.py')})
    format_files['DWG'].update({'dwg-reader/' + name: value for name, value in reader_files.items()})

    format_versions = {}
    for format_name, release in FORMAT_RELEASES.items():
        identity = {
            'format': format_name,
            'release': release,
            'gatewayProtocol': 'libiaolink-cad-gateway/1',
            'files': {**shared, **runtime_shared, **format_files[format_name], **runtime_format[format_name]},
        }
        prefix = {'STEP': 'step-', 'DXF': 'dxf-', 'DWG': 'dwg-'}[format_name]
        format_versions[format_name] = prefix + release + '/' + digest(identity) + '/gateway-1'

    compatibility_versions = compatibility(base, format_versions)

    engine_digest = digest({
        'stepRelease': FORMAT_RELEASES['STEP'],
        'dxfRelease': FORMAT_RELEASES['DXF'],
        'gatewayProtocol': 'libiaolink-cad-gateway/1',
        'engineFiles': engine_files,
        'readerFiles': reader_files,
        'runtimeFiles': runtime_files,
    })
    viewer_digest = digest({'browserFiles': browser_files})
    release_digest = digest({
        'sourceCommit': IMPORTED_COMMIT,
        'engineDigest': engine_digest,
        'viewerDigest': viewer_digest,
        'formatVersions': format_versions,
        'compatibility': compatibility_versions,
    })
    result = {
        'sourceCommit': IMPORTED_COMMIT,
        'stepRelease': FORMAT_RELEASES['STEP'],
        'dxfRelease': FORMAT_RELEASES['DXF'],
        'gatewayProtocol': 'libiaolink-cad-gateway/1',
        'engineFiles': engine_files,
        'readerFiles': reader_files,
        'browserFiles': browser_files,
        'runtimeFiles': runtime_files,
        'formatVersions': format_versions,
        'compatibility': compatibility_versions,
        'engineDigest': engine_digest,
        'viewerDigest': viewer_digest,
        'releaseDigest': release_digest,
        'engineVersion': 'step-' + FORMAT_RELEASES['STEP'] + '/' + engine_digest + '/gateway-1',
        'viewerVersion': 'viewer-' + viewer_digest,
    }
    return result


def typescript(release):
    return (
        '// Generated by cad-engine/build-release.py; do not edit.\n'
        'export const CAD_ENGINE_VERSION = ' + json.dumps(release['engineVersion']) + ';\n'
        'export const CAD_VIEWER_VERSION = ' + json.dumps(release['viewerVersion']) + ';\n'
        'export const CAD_FORMAT_VERSIONS = ' + json.dumps(
            release['formatVersions'], ensure_ascii=False, separators=(',', ':')) + ' as const;\n'
        'export type CadFormatVersion = keyof typeof CAD_FORMAT_VERSIONS;\n'
        'export const CAD_FORMAT_COMPAT_VERSIONS = ' + json.dumps(
            release.get('compatibility', {}), ensure_ascii=False, separators=(',', ':')) + ' as const satisfies Record<CadFormatVersion, readonly string[]>;\n'
        'export function cadFormatVersion(format: CadFormatVersion): string { return CAD_FORMAT_VERSIONS[format]; }\n'
        'export function cadFormatVersions(format: CadFormatVersion): readonly string[] {\n'
        '  return [CAD_FORMAT_VERSIONS[format], ...CAD_FORMAT_COMPAT_VERSIONS[format]];\n'
        '}\n'
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    browser = BASE.parents[1] / 'frontend/public/cad-viewer/core'
    release = describe(BASE, browser)
    outputs = {
        BASE / 'source.json': json.dumps(release, ensure_ascii=False, indent=2) + '\n',
        BASE.parent / 'src/modules/file/cad-release.ts': typescript(release),
    }
    for path, content in outputs.items():
        if args.check:
            if not path.is_file() or path.read_text() != content:
                raise SystemExit('CAD release is stale: run python3 server/cad-engine/build-release.py')
        else:
            path.write_text(content)
    print(('Checked' if args.check else 'Built') + ' CAD release ' + release['releaseDigest'])


if __name__ == '__main__':
    main()
