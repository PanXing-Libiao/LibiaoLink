// Rebuild the pinned engineering-symbol subsets; full upstream fonts stay local.
// Usage: CAD_FONT_PYTHON=/path/to/python node frontend/scripts/generate-cad-symbol-fonts.mjs /local/upstream-fonts
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../public/cad-viewer/fonts/', import.meta.url));
if (!process.argv[2]) throw Error('Provide the local folder containing the pinned upstream OTF files.');
const script = String.raw`import sys,json,io,base64,hashlib
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools import subset
root=Path(sys.argv[1]); upstream=Path(sys.argv[2]); result=[]
for row in json.loads((root/'engineering-symbol-sources.json').read_text()):
    raw=(upstream/row['filename']).read_bytes()
    if hashlib.sha256(raw).hexdigest()!=row['sha256']:raise ValueError('upstream font hash mismatch')
    font=TTFont(io.BytesIO(raw),recalcTimestamp=False)
    points={cp for a,b in row['ranges'] for cp in range(a,b+1)}
    options=subset.Options(); options.name_IDs=['*']; options.name_legacy=True
    sub=subset.Subsetter(options=options);sub.populate(unicodes=points);sub.subset(font)
    for entry in list(font['name'].names):
        if entry.nameID in (1,4,6,16):
            value=row['family'] if entry.nameID in (1,16) else row['family']+' Engineering' if entry.nameID==4 else row['family'].replace(' ','')+'Engineering-Regular'
            font['name'].setName(value,entry.nameID,entry.platformID,entry.platEncID,entry.langID)
    font.flavor='woff2'; buffer=io.BytesIO();font.save(buffer)
    result.append(dict(output=row['output'],base64=base64.b64encode(buffer.getvalue()).decode()))
print(json.dumps(result))
`;
const outputs = JSON.parse(execFileSync(process.env.CAD_FONT_PYTHON || 'python3', ['-B','-c',script,root,process.argv[2]], {encoding:'utf8',maxBuffer:4*1024*1024}));
for (const output of outputs) fs.writeFileSync(root + output.output, Buffer.from(output.base64,'base64'));
console.log('Rebuilt ' + outputs.length + ' pinned symbol subsets; regenerate coverage after byte changes.');
