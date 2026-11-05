"""Build pinned community reader in an ignored, caller-owned directory.

No input drawing is read here. Fetches are public source archives only. Both
archives may be supplied offline, and are verified before extraction.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import urllib.request

HERE = Path(__file__).resolve().parent


def checked_archive(pin, destination, supplied):
    data = Path(supplied).read_bytes() if supplied else urllib.request.urlopen(pin['url'], timeout=60).read()
    if hashlib.sha256(data).hexdigest() != pin['sha256']:
        raise ValueError('Pinned source archive digest mismatch')
    destination.write_bytes(data)
    return destination


def replace_once(path, before, after):
    text = path.read_text(encoding='utf-8-sig')
    if text.count(before) != 1:
        raise ValueError(f'Pinned upstream patch context changed: {path.name}')
    path.write_text(text.replace(before, after))


def build(args):
    work = Path(args.work).resolve()
    work.mkdir(parents=True, exist_ok=True)
    pin = json.loads((HERE / 'dependency.json').read_text())
    source = work / 'upstream'
    if source.exists():
        raise ValueError('Use a new build work directory; existing source is never overwritten')
    source.mkdir()
    for key, supplied, target in [('source', args.source, source), ('csutilities', args.csutilities, source / 'utilities')]:
        archive = checked_archive(pin[key], work / (key + '.tar.gz'), supplied)
        target.mkdir(exist_ok=True)
        with tarfile.open(archive) as tf:
            tf.extractall(target, filter='data')
    acad = next(source.glob('ACadSharp-*'))
    utilities = next((source / 'utilities').iterdir())
    import shutil
    shutil.copytree(utilities, acad / 'src/CSUtilities', dirs_exist_ok=True)
    header = acad / 'src/ACadSharp/Header/CadHeader.cs'
    replace_once(header, 'public Color InterfereColor { get; set; } = new Color(1);',
                 'public Color InterfereColor { get; set; } = new Color(1);\n\n'
                 '\t\t/// <summary>Raw native INTERSECTIONCOLOR, distinct from INTERFERECOLOR. Negative values are preserved without assigning an invented Color.</summary>\n'
                 '\t\tpublic short IntersectionColorIndex { get; set; } = 257;')
    replace_once(acad / 'src/ACadSharp/IO/DWG/DwgStreamReaders/DwgHeaderReader.cs',
                 '//BS : INTERSECTIONCOLOR\n\t\t\t\t_header.InterfereColor = new Color(_reader.ReadBitShort());',
                 '//BS : INTERSECTIONCOLOR\n\t\t\t\t_header.IntersectionColorIndex = _reader.ReadBitShort();')
    replace_once(acad / 'src/ACadSharp/IO/DWG/DwgStreamWriters/DwgHeaderWriter.cs',
                 '//BS : INTERSECTIONCOLOR\n\t\t\t\tthis._writer.WriteBitShort(this._header.InterfereColor.Index);',
                 '//BS : INTERSECTIONCOLOR\n\t\t\t\tthis._writer.WriteBitShort(this._header.IntersectionColorIndex);')
    config = work / 'NuGet.Config'
    config.write_text('<configuration><packageSources><clear /></packageSources></configuration>')
    env = dict(os.environ, DOTNET_CLI_TELEMETRY_OPTOUT='1', DOTNET_GENERATE_ASPNET_CERTIFICATE='false',
               DOTNET_CLI_HOME=str(work / 'dotnet-home'))
    base = [args.dotnet, 'build', '-c', 'Release', '--configfile', str(config), '--disable-build-servers']
    subprocess.run(base + [str(acad / 'src/ACadSharp/ACadSharp.csproj'), '-p:TargetFrameworks=net10.0',
                          '-p:GeneratePackageOnBuild=false', '-p:SignAssembly=false',
                          '--artifacts-path', str(work / 'library')], env=env, check=True)
    dll = work / 'library/bin/ACadSharp/release_net10.0/ACadSharp.dll'
    subprocess.run(base + [str(HERE / 'Reader.csproj'), '-p:ACadSharpAssembly=' + str(dll),
                          '--artifacts-path', str(work / 'reader')], env=env, check=True)
    (work / 'build.json').write_text(json.dumps({'dependency': pin, 'assembly': str(dll),
        'assemblySha256': hashlib.sha256(dll.read_bytes()).hexdigest(),
        'reader': str(work / 'reader/bin/Reader/release/LibiaoLink.DwgReader.dll')}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work', required=True)
    parser.add_argument('--dotnet', required=True)
    parser.add_argument('--source')
    parser.add_argument('--csutilities')
    build(parser.parse_args())
