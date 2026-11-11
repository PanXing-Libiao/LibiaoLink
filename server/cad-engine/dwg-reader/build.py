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
    preview = acad / "src/ACadSharp/IO/DWG/DwgStreamReaders/DwgPreviewReader.cs"
    replace_once(preview, "\t\t\tDwgPreview.PreviewType previewCode = DwgPreview.PreviewType.Unknown;\n\n\t\t\t//The data follows the records in the same order\n\t\t\tfor (int i = 0; i < imagespresent; i++)\n\t\t\t{\n\t\t\t\tbyte[] data = this._reader.ReadBytes((int)sizes[i]);\n\t\t\t\tswitch (codes[i])\n\t\t\t\t{\n\t\t\t\t\tcase 1:\n\t\t\t\t\t\theader = data;\n\t\t\t\t\t\tbreak;\n\t\t\t\t\tdefault:\n\t\t\t\t\t\t//Keep the first image, a file may store a second lower quality bitmap after it\n\t\t\t\t\t\tif (previewCode == DwgPreview.PreviewType.Unknown)\n\t\t\t\t\t\t{\n\t\t\t\t\t\t\tpreviewCode = (DwgPreview.PreviewType)codes[i];\n\t\t\t\t\t\t\tbody = data;\n\t\t\t\t\t\t}\n\t\t\t\t\t\tbreak;\n\t\t\t\t}\n\t\t\t}", "\t\t\tDwgPreview.PreviewType previewCode = DwgPreview.PreviewType.Unknown;\n\t\t\tint previewPriority = -1;\n\n\t\t\t//The data follows the records in the same order. Prefer a self-contained PNG,\n\t\t\t//then BMP, then WMF; some files put a lower-priority image first.\n\t\t\tfor (int i = 0; i < imagespresent; i++)\n\t\t\t{\n\t\t\t\tbyte[] data = this._reader.ReadBytes((int)sizes[i]);\n\t\t\t\tswitch (codes[i])\n\t\t\t\t{\n\t\t\t\t\tcase 1:\n\t\t\t\t\t\theader = data;\n\t\t\t\t\t\tbreak;\n\t\t\t\t\tdefault:\n\t\t\t\t\t\tint candidatePriority = codes[i] == 6 ? 3 : codes[i] == 2 ? 2 : codes[i] == 3 ? 1 : 0;\n\t\t\t\t\t\tif (candidatePriority > previewPriority)\n\t\t\t\t\t\t{\n\t\t\t\t\t\t\tpreviewCode = (DwgPreview.PreviewType)codes[i];\n\t\t\t\t\t\t\tpreviewPriority = candidatePriority;\n\t\t\t\t\t\t\tbody = data;\n\t\t\t\t\t\t}\n\t\t\t\t\t\tbreak;\n\t\t\t\t}\n\t\t\t}");
    # C# integer division made 1 / 64 zero, rotating near-pole OCS frames.
    # Patch the shared helper so native curve evaluation and INSERT agree.
    replace_once(utilities / 'CSMath/Matrix4.cs',
                 'Math.Abs(zaxis.X) < (1 / 64) && Math.Abs(zaxis.Y) < (1 / 64)',
                 'Math.Abs(zaxis.X) < (1.0 / 64.0) && Math.Abs(zaxis.Y) < (1.0 / 64.0)')
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
    # R2000+ stores an inverted LWDISPLAY bit and an indexed CELWEIGHT.
    replace_once(header, 'public bool DisplayLineWeight { get; set; } = false;',
                 'public bool DisplayLineWeight { get; set; } = false;\n\n'
                 '\t/// <summary>Original R2000+ combined header flags; absent in earlier formats.</summary>\n'
                 '\tpublic int? NativeLineWeightFlags { get; set; }')
    header_reader = acad / 'src/ACadSharp/IO/DWG/DwgStreamReaders/DwgHeaderReader.cs'
    replace_once(header_reader, '_header.CurrentEntityLineWeight = (LineWeightType)(flags & 0x1F);',
                 '_header.NativeLineWeightFlags = flags;\n\t\t\t\t_header.CurrentEntityLineWeight = CadUtils.ToValue((byte)(flags & 0x1F));')
    replace_once(header_reader, '_header.DisplayLineWeight = (flags & 0x200) == 1;',
                 '_header.DisplayLineWeight = (flags & 0x200) == 0;')
    replace_once(acad / 'src/ACadSharp/IO/DWG/DwgStreamWriters/DwgHeaderWriter.cs',
                 '((int)this._header.CurrentEntityLineWeight & 0x1F)',
                 '(CadUtils.ToIndex(this._header.CurrentEntityLineWeight) & 0x1F)')
    # DWG spatial-filter matrices store three rows of four values. CSMath's
    # indexer is [column,row]; the pinned reader/writer used the transposed order.
    replace_once(acad / 'src/ACadSharp/IO/DWG/DwgStreamReaders/DwgObjectReader.cs',
                 'identity[i, j] = this._mergedReaders.ReadBitDouble();',
                 'identity[j, i] = this._mergedReaders.ReadBitDouble();')
    replace_once(acad / 'src/ACadSharp/IO/DWG/DwgStreamWriters/DwgObjectWriter.Objects.cs',
                 'this._writer.WriteBitDouble(matrix[i, j]);',
                 'this._writer.WriteBitDouble(matrix[j, i]);')
    # HATCH even-odd parity must retain crossing multiplicity between loops.
    replace_once(acad / 'src/ACadSharp/Entities/Hatch.cs',
                 "\tprivate bool isPointInsideByParity(XY point, double jitter = 1e-7)\n\t{\n\t\tLine2D ray = new Line2D(new XY(point.X, point.Y + jitter), XY.AxisX);\n\n\t\tList<double> hits = new();\n\t\tforeach (BoundaryPath boundary in this.Paths)\n\t\t{\n\t\t\tforeach (XY p in boundary.FindIntersections(ray))\n\t\t\t{\n\t\t\t\tif (p.X >= point.X - MathHelper.Epsilon)\n\t\t\t\t{\n\t\t\t\t\thits.Add(p.X);\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\n\t\tList<double> merged = mergeParameters(hits).ToList();\n\t\treturn merged.Count.IsOdd();\n\t}",
                 "\tprivate bool isPointInsideByParity(XY point, double jitter = 1e-7)\n\t{\n\t\tLine2D ray = new Line2D(new XY(point.X, point.Y + jitter), XY.AxisX);\n\n\t\tbool inside = false;\n\t\tforeach (BoundaryPath boundary in this.Paths)\n\t\t{\n\t\t\t// Coincident crossings cancel between loops; only deduplicate within one loop.\n\t\t\tList<double> hits = new();\n\t\t\tforeach (XY p in boundary.FindIntersections(ray))\n\t\t\t{\n\t\t\t\tif (p.X >= point.X - MathHelper.Epsilon)\n\t\t\t\t{\n\t\t\t\t\thits.Add(p.X);\n\t\t\t\t}\n\t\t\t}\n\t\t\tinside ^= mergeParameters(hits).Count().IsOdd();\n\t\t}\n\n\t\treturn inside;\n\t}")
    # Keep ExplodePattern's Line API and let the DWG writer consume the same clipped endpoints.
    hatch = acad / 'src/ACadSharp/Entities/Hatch.cs'
    replace_once(hatch,
                 """		List<Line> lines = new();

		if (this.Pattern""",
                 """		List<Line> lines = new();
		VisitPatternSegments((start, end, isDot) =>
		{
			var line = new Line(start, end);
			line.MatchProperties(this);
			if (!isDot) line.LineType = Tables.LineType.Continuous;
			lines.Add(line);
		});
		return lines;
	}

	/// <summary>Visit the endpoints of each clipped dash or dot in pattern order.</summary>
	public void VisitPatternSegments(System.Action<XY, XY, bool> emit)
	{
		if (this.Pattern""")
    replace_once(hatch,
                 "\t\t\treturn lines;",
                 "\t\t\treturn;")
    replace_once(hatch,
                 "lines.AddRange(emitDashedSegment(geomLine, tA, tB, patLine.DashLengths));",
                 "emitDashedSegment(geomLine, tA, tB, patLine.DashLengths, emit);")
    replace_once(hatch,
                 """
		return lines;
	}

	/// <inheritdoc/>""",
                 """
	}

	/// <inheritdoc/>""")
    replace_once(hatch,
                 "private IEnumerable<Line> emitDashedSegment(Line2D line, double tStart, double tEnd, List<double> dashLengths)",
                 "private void emitDashedSegment(Line2D line, double tStart, double tEnd, List<double> dashLengths, System.Action<XY, XY, bool> emit)")
    replace_once(hatch,
                 """var solid = new Line(line.PointInLine(tStart), line.PointInLine(tEnd));
			solid.MatchProperties(this);
			solid.LineType = Tables.LineType.Continuous;
			return new Line[] { solid };""",
                 """emit(line.PointInLine(tStart), line.PointInLine(tEnd), false);
			return;""")
    replace_once(hatch,
                 "return Enumerable.Empty<Line>();",
                 "return;")
    replace_once(hatch,
                 """		var result = new List<Line>();
""",
                 "")
    replace_once(hatch,
                 """var dot = new Line(line.PointInLine(cursor), line.PointInLine(cursor + MathHelper.Epsilon));
					dot.MatchProperties(this);
					result.Add(dot);""",
                 "emit(line.PointInLine(cursor), line.PointInLine(cursor + MathHelper.Epsilon), true);")
    replace_once(hatch,
                 """var dash = new Line(line.PointInLine((double)cursor), line.PointInLine((double)(cursor + step)));
				dash.MatchProperties(this);
				dash.LineType = Tables.LineType.Continuous;
				result.Add(dash);""",
                 "emit(line.PointInLine(cursor), line.PointInLine(cursor + step), false);")
    replace_once(hatch,
                 """
		return result;
	}""",
                 """
	}""")
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
