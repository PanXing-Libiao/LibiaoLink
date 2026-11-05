"""Local browser acceptance for import lifecycle, using production parsing/UI.

Run from repository root: .cad-work/occt/bin/python
server/cad-engine/core/tests/import_state_server.py [8799], then open /__import-state.
Only fixed corpus files are exposed; no source files or historical reports change.
"""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import hashlib
import json
import re
from pathlib import Path
import sys
from http.server import ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

APP = Path(__file__).resolve().parents[1]
ROOT = DATA
sys.path.insert(0, str(APP))
from server import Handler

OUT = ROOT / 'docs/dxf-import-state'
FILES = {}
for cohort, report, folder in [
    ('original11', 'docs/dxf-2d/results.json', 'phase_i_evidence/samples/real'),
    ('holdout2d', 'docs/dxf-holdout-2d/after/results.json', '.phase-work/dxf-holdout/samples'),
]:
    for row in json.loads((ROOT / report).read_text())['files']:
        if row.get('non2d'):
            continue
        if row.get('id') == 'H09':
            row = json.loads((ROOT / 'docs/dxf-holdout-2d/h09-recovery/results.json').read_text())['files'][0]
        key = cohort + ':' + row.get('id', row['file'])
        path = ROOT / folder / row['file']
        raw = path.read_bytes()
        assert hashlib.sha256(raw).hexdigest() == row['sha256'], path
        FILES[key] = {'id': key, 'cohort': cohort, 'file': row['file'], 'path': path,
                      'sha256': row['sha256'], 'inputBytes': len(raw), 'expectedDisplay': row['display']}


class ImportHandler(Handler):
    def do_GET(self):
        if not self.allowed():
            return self.reply(403, {})
        request = urlsplit(self.path)
        if request.path == '/__import-state':
            raw = ('<!doctype html><meta charset="utf-8"><title>DXF import acceptance</title>'
                   '<style>body{font:14px system-ui;margin:0}iframe{width:100%;height:800px;border:0}'
                   'pre{white-space:pre-wrap;padding:12px}</style><button id="run">运行导入状态与固定语料验收</button>'
                   '<pre id="status">Ready</pre><iframe id="viewer"></iframe>'
                   '<script type="module" src="/__import-state.mjs"></script>').encode()
        elif request.path == '/__import-frame':
            raw = (APP.parent / 'dev/index.html').read_text().replace('<head>', '<head><base href="/">')
            entry = '/' + re.search(r'src="(app\.js[^\"]*)"', raw).group(1)
            raw = raw.replace('</body>', '<script type="module">import {loadPlatformModel} from '
                              + json.dumps(entry) + ';window.__acceptanceLoad=loadPlatformModel;</script></body>').encode()
        elif request.path == '/__import-state.mjs':
            raw = (APP / 'tests/browser_import_state.mjs').read_bytes()
        elif request.path == '/__fixtures':
            return self.reply(200, [{k: v for k, v in row.items() if k != 'path'} for row in FILES.values()])
        elif request.path == '/__fixture':
            row = FILES.get(parse_qs(request.query).get('id', [''])[0])
            if row is None:
                return self.reply(404, {})
            raw = row['path'].read_bytes()
        else:
            return super().do_GET()
        self.send_response(200)
        self.send_header('Content-Type', 'text/javascript' if request.path.endswith('.mjs') else
                         'application/octet-stream' if request.path == '/__fixture' else 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        if urlsplit(self.path).path != '/__report':
            return super().do_POST()
        if not self.allowed():
            return self.reply(403, {})
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 < length <= 2 * 1024 * 1024:
            return self.reply(413, {})
        report = json.loads(self.rfile.read(length))
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / 'browser.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
        return self.reply(200, {'saved': True})


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8799
    print(f'http://127.0.0.1:{port}/__import-state', flush=True)
    ThreadingHTTPServer(('127.0.0.1', port), ImportHandler).serve_forever()
