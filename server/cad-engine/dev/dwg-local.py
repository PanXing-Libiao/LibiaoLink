"""Loopback-only harness for an already validated, private native DWG artifact.

Reuses the platform viewer HTML and mountDrawingViewer. It does not expose an
upload route or the source DWG, and does not enable DWG in production APIs.
"""
import argparse
import gzip
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import re
from urllib.parse import urlsplit

REPO=Path(__file__).resolve().parents[3]
VIEWER=REPO/'frontend/public/cad-viewer'
BOOT=r'''
import {mountDrawingViewer} from '/core/drawing-viewer.js';
const started=performance.now(),stages={};
try {
 const envelope=await (await fetch('/manifest.json')).json();stages.manifestMs=performance.now()-started;
 const entries=Object.entries(envelope.document.buffers);
 if(entries.length!==1)throw new Error('Expected one packed native display buffer');
 const [id,description]=entries[0];if(description.byteLength>256*1024*1024)throw new Error('Display buffer budget exceeded');
 const buffer=await (await fetch('/positions.bin')).arrayBuffer();
 const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))].map(v=>v.toString(16).padStart(2,'0')).join('');
 if(hash!==description.sha256||buffer.byteLength!==description.byteLength)throw new Error('Native display buffer integrity mismatch');
 envelope.transportProfile='ucd-binary-manifest/1';envelope.decodedBuffers=new Map([[id,buffer]]);stages.bufferMs=performance.now()-started;
 for(const id of ['ground','clearGround','wire','dim','toggle','isolate','search','tree','productTree'])document.getElementById(id)?.setAttribute('hidden','');
 document.querySelector('.name-encoding').hidden=true;document.querySelector('.treehead').hidden=true;
 const viewer=mountDrawingViewer(envelope);stages.mountedMs=performance.now()-started;
 document.getElementById('fit').onclick=()=>viewer.fit();document.getElementById('focus').onclick=()=>viewer.fitSelection();
 for(const id of ['showAll','reset'])document.getElementById(id).onclick=()=>{for(const layer of Object.values(envelope.document.drawing.layers))viewer.setLayerVisible(layer.name,true);viewer.fit();};
 for(const id of ['fit','showAll','reset','export'])document.getElementById(id).disabled=false;
 document.getElementById('export').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify({source:envelope.document.sources,counts:viewer.counts(),losses:envelope.document.extensions['org.libiaolink.dwg/1'].lossCounts},null,2)],{type:'application/json'}));a.download='DWG本机检查.json';a.click();};
 document.getElementById('filename').textContent=envelope.presentation.name;
 document.getElementById('quality').textContent='DWG 本机验证 · 部分可预览';
 document.getElementById('note').textContent=envelope.presentation.note;
 document.getElementById('source').textContent='原文件 SHA-256：'+envelope.presentation.sourceSHA256;
 const losses=envelope.document.extensions['org.libiaolink.dwg/1'].lossCounts;
 const limitations=document.getElementById('drawingLimitations');limitations.hidden=false;
 const labels={'leader-arrow-presentation':'引线箭头待验证','proxy-primitive-unmapped':'代理图形或样式待验证','unrepresented-header-color':'头字段原值已保留','unsupported-native-presentation':'未显示的原生对象','mtext-special-layout-unmapped':'特殊多行文字布局未显示','hatch-gradient-unmapped':'渐变填充待验证'};
 limitations.textContent='部分可预览：原配套字体未提供，文字使用替代字体。'+Object.entries(losses).map(([k,v])=>(labels[k]||k)+' × '+v).join('；');
 document.getElementById('busy').hidden=true;document.getElementById('error').hidden=true;
 document.getElementById('sessionStatus').textContent='已打开 · 部分可预览';document.body.dataset.cadState='ready';document.body.dataset.sidebar='open';
 document.getElementById('viewport').setAttribute('aria-busy','false');
 document.getElementById('toggleSidebar').onclick=()=>{document.body.dataset.sidebar=document.body.dataset.sidebar==='open'?'closed':'open';};
 document.getElementById('closeSidebar').onclick=()=>{document.body.dataset.sidebar='closed';};
 await viewer.ready;await new Promise(requestAnimationFrame);stages.readyMs=performance.now()-started;
 window.__dwgLocal={stages,source:envelope.document.sources[0],counts:viewer.counts()};
 const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='本机验证';details.append(summary);
 const record=document.createElement('pre');record.id='dwgLocalEvidence';record.style.cssText='white-space:pre-wrap;font-size:10px;max-height:220px;overflow:auto';
 const update=()=>{record.textContent=JSON.stringify({stages,source:envelope.document.sources[0],counts:viewer.counts(),extents:viewer.extents(),selected:document.getElementById('selected').textContent},null,2);};update();
 const input=document.createElement('input');input.setAttribute('aria-label','原句柄');input.placeholder='原句柄（十六进制）';
 const focus=document.createElement('button');focus.textContent='按原句柄定位';focus.onclick=()=>{const ok=viewer.focusSourceHandle(input.value.trim());update();if(!ok)record.textContent+='\n此原对象在当前空间没有可定位的显示几何。';};
 const save=document.createElement('button');save.textContent='保存当前画面';save.onclick=async()=>{update();const canvas=document.getElementById('drawingCanvas'),blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  const response=await fetch('/evidence/canvas.png',{method:'POST',headers:{'Content-Type':'image/png'},body:blob});if(!response.ok)throw new Error('Local evidence save failed');
  await fetch('/evidence/browser.json',{method:'POST',headers:{'Content-Type':'application/json'},body:record.textContent});save.textContent='画面已保存到本机验证目录';};
 details.append(input,focus,save,record);document.querySelector('.model-info-body').append(details);
}catch(error){document.body.dataset.cadState='failed';document.getElementById('busy').hidden=true;const node=document.getElementById('error');node.hidden=false;node.textContent=error.stack;window.__dwgLocalError=error.stack;throw error;}
'''


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('artifact')
    parser.add_argument('--port',type=int,default=8768)
    args=parser.parse_args()
    artifact=Path(args.artifact).resolve()
    if not (artifact/'assembly-summary.json').is_file():raise ValueError('Validated assembly summary required')
    compressed=artifact/'manifest.json.gz'
    if not compressed.exists() or compressed.stat().st_mtime_ns<(artifact/'manifest.json').stat().st_mtime_ns:
        with (artifact/'manifest.json').open('rb') as source,gzip.open(compressed,'wb',compresslevel=3) as target:
            import shutil
            shutil.copyfileobj(source,target)
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self,*a,**kw):super().__init__(*a,directory=str(VIEWER),**kw)
        def log_message(self,*a):pass
        def do_POST(self):
            if self.headers.get('Host') not in (f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}') or self.headers.get('Origin')!=f'http://{self.headers.get("Host")}':return self.send_error(403)
            path=urlsplit(self.path).path
            allowed={'/evidence/canvas.png':('image/png','canvas.png'),'/evidence/browser.json':('application/json','browser.json')}
            if path not in allowed:return self.send_error(404)
            kind,name=allowed[path];size=int(self.headers.get('Content-Length','0'))
            if self.headers.get('Content-Type')!=kind or not 0<size<=16*1024*1024:return self.send_error(413)
            data=self.rfile.read(size);folder=artifact/'evidence';folder.mkdir(exist_ok=True)
            (folder/name).write_bytes(data);self.send_response(204);self.end_headers()
        def do_GET(self):
            if self.headers.get('Host') not in (f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}'):
                return self.send_error(403)
            path=urlsplit(self.path).path
            if path in ('/','/index.html'):
                html=(VIEWER/'index.html').read_text()
                html=re.sub(r'<script type="module" src="platform-entry[^\"]*"></script>','<script type="module" src="/dwg-local.js"></script>',html)
                data=html.encode();kind='text/html; charset=utf-8'
            elif path=='/dwg-local.js':data=BOOT.encode();kind='text/javascript; charset=utf-8'
            elif path=='/manifest.json':
                self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Encoding','gzip');self.send_header('Content-Length',str(compressed.stat().st_size));self.end_headers()
                with compressed.open('rb') as stream:
                    import shutil
                    shutil.copyfileobj(stream,self.wfile)
                return
            elif path=='/positions.bin':
                source=artifact/'native/positions.bin';self.send_response(200);self.send_header('Content-Type','application/octet-stream');self.send_header('Content-Length',str(source.stat().st_size));self.end_headers()
                with source.open('rb') as stream:
                    import shutil
                    shutil.copyfileobj(stream,self.wfile)
                return
            elif path.startswith('/core/') or path=='/platform.css':return super().do_GET()
            else:return self.send_error(404)
            self.send_response(200);self.send_header('Content-Type',kind);self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    print(f'http://127.0.0.1:{server.server_port}',flush=True)
    server.serve_forever()


if __name__=='__main__':main()
