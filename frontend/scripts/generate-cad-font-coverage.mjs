// Rebuild from the checked-in WOFF2 bytes, never from system fonts.
// Requires Python fontTools with WOFF2/Brotli support for this authoring step only.
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../public/cad-viewer/fonts/', import.meta.url));
const script = String.raw`import sys,re,json,hashlib
from pathlib import Path
from fontTools.ttLib import TTFont
root=Path(sys.argv[1]); faces={}; sources={}
for sheet in ('latin.css','noto.css'):
    css=(root/sheet).read_text(encoding='utf-8')
    sources[sheet]=hashlib.sha256((root/sheet).read_bytes()).hexdigest()
    for block in re.findall(r'@font-face\s*\{([^}]+)\}',css):
        prop=dict(re.findall(r'([\w-]+)\s*:\s*([^;]+)',block))
        family=prop['font-family'].strip().strip(chr(39)+chr(34))
        weight=int(prop.get('font-weight','400')); style=prop.get('font-style','normal').strip()
        filename=re.search(r'url\([\x27\x22]?([^\)\x27\x22]+)',prop['src']).group(1)
        raw=(root/filename).read_bytes(); sources[filename]=hashlib.sha256(raw).hexdigest()
        with TTFont(root/filename) as font:
            points={cp for cp,glyph in font.getBestCmap().items() if glyph!='.notdef'}
        declared=[]
        for part in prop.get('unicode-range','U+0-10FFFF').split(','):
            token=part.strip()[2:]
            if '?' in token: bounds=(int(token.replace('?','0'),16),int(token.replace('?','F'),16))
            else:
                pair=token.split('-'); bounds=(int(pair[0],16),int(pair[-1],16))
            declared.append(bounds)
        points={cp for cp in points if any(a<=cp<=b for a,b in declared)}
        faces.setdefault((family,weight,style),set()).update(points)
result=[]
for (family,weight,style),points in sorted(faces.items()):
    ranges=[]
    for cp in sorted(points):
        if ranges and ranges[-1][1]+1==cp:ranges[-1][1]=cp
        else:ranges.append([cp,cp])
    result.append(dict(family=family,weight=weight,style=style,ranges=ranges))
print(json.dumps(dict(faces=result,sources=sources),ensure_ascii=False,separators=(',',':')))
`;
const data = JSON.parse(execFileSync(process.env.CAD_FONT_PYTHON || 'python3', ['-B', '-c', script, root], {encoding:'utf8', maxBuffer:4*1024*1024}));
const output = '// Generated from bundled CSS unicode ranges intersected with actual WOFF2 cmap.\n'
  + '// Regenerate: node frontend/scripts/generate-cad-font-coverage.mjs\n'
  + 'export const BUNDLED_FONT_FACES = ' + JSON.stringify(data.faces) + ';\n'
  + 'export const BUNDLED_FONT_SOURCE_HASHES = ' + JSON.stringify(data.sources) + ';\n';
fs.writeFileSync(fileURLToPath(new URL('../public/cad-viewer/core/drawing-font-coverage.js', import.meta.url)), output, 'utf8');
console.log('Generated bundled font coverage for ' + data.faces.length + ' faces.');
