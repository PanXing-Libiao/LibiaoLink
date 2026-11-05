"""Targeted SHX/SHP resources, original SHAPE records and bounded font controls."""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import urllib.parse
import urllib.request

APP = Path(__file__).resolve().parents[1]
ROOT = DATA
sys.path.insert(0, str(APP))
from unified.dxf_adapter import read_dxf
from unified.dxf_shx import EXTENSION
from check_dxf_xref import package
import ezdxf
from ezdxf import xref
from ezdxf.fonts import shapefile

OUT = ROOT / 'docs/dxf-shx'
ORIGINALS = OUT / 'originals'
CONTROLS = OUT / 'controls'
ISO = (ORIGINALS / 'ezdxf/iso3098.shx').read_bytes()
KST = (ORIGINALS / 'ezdxf/kst32b.shx').read_bytes()
SHAPE = (ORIGINALS / 'acadsharp/test_shape.shx').read_bytes()
SQUARE = b'*1,5,SQUARE\n010,014,018,01C,0\n'


def controls():
    CONTROLS.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / 'control.dxf'
        def parse(doc, files=None):
            doc.saveas(path)
            return read_dxf(path, path.read_bytes(), resources=files)
        doc = ezdxf.new('R2013')
        doc.layers.new('Latin', dxfattribs={'color': 1})
        doc.layers.new('Unicode', dxfattribs={'color': 3})
        doc.styles.new('ISO', dxfattribs={'font': 'iso3098.shx'})
        doc.styles.new('Unicode', dxfattribs={'font': 'kst32b.shx'})
        latin = doc.modelspace().add_text('CAD SHX 123', dxfattribs={'style': 'ISO', 'height': 3, 'layer': 'Latin'})
        doc.modelspace().add_text('ROTATED', dxfattribs={'style': 'ISO', 'height': 2, 'insert': (36, 0), 'rotation': 45, 'oblique': 15, 'layer': 'Latin'})
        doc.modelspace().add_mtext('CAD 123\\P漢字 日本語', dxfattribs={'style': 'Unicode', 'insert': (0, 15), 'char_height': 3, 'width': 32, 'layer': 'Unicode'})
        block = doc.blocks.new('Part')
        block.add_attdef('PARTNO', text='', dxfattribs={'style': 'ISO', 'height': 2})
        insert = doc.modelspace().add_blockref('Part', (0, -5))
        insert.add_attrib('PARTNO', 'ATTRIB-42', (0, -5), dxfattribs={'style': 'ISO', 'height': 2, 'layer': 'Latin'})
        paper = doc.layouts.get('Layout1')
        paper.add_text('SHEET SHX', dxfattribs={'style': 'ISO', 'height': 3, 'layer': 'Latin'})
        doc.saveas(CONTROLS / 'font_text.dxf')
        main = (CONTROLS / 'font_text.dxf').read_bytes()
        files = {'iso3098.shx': ISO, 'kst32b.shx': KST}
        missing = read_dxf(CONTROLS / 'font_text.dxf', main)
        loaded = read_dxf(CONTROLS / 'font_text.dxf', main, resources=files)
        assert missing['snapshot']['completeness'] == 'partial'
        assert loaded['snapshot']['completeness'] == 'complete'
        assert loaded['document']['extensions'][EXTENSION]['coverage']['resolvedReferences'] == 2
        assert loaded['document']['extensions'][EXTENSION]['coverage']['missingObjects'] == 0
        ids = lambda e: {a['sourceRefs'][0]['objectKey']: a['id'] for a in e['document']['drawing']['annotations'].values()}
        assert ids(missing) == ids(loaded)
        annotation = next(a for a in loaded['document']['drawing']['annotations'].values() if a['sourceRefs'][0]['objectKey'] == latin.dxf.handle)
        assert loaded['document']['resources'][annotation['fontResourceId']]['sha256'] == hashlib.sha256(ISO).hexdigest()
        ambiguous = read_dxf(CONTROLS / 'font_text.dxf', main, resources={'a/iso3098.shx': ISO, 'b/iso3098.shx': ISO, 'kst32b.shx': KST})
        assert any(r['status'] == 'ambiguous' for r in ambiguous['document']['extensions'][EXTENSION]['references'])
        corrupted = read_dxf(CONTROLS / 'font_text.dxf', main, resources={'iso3098.shx': b'not-a-font', 'kst32b.shx': KST})
        assert any(r['status'] == 'blocked' for r in corrupted['document']['extensions'][EXTENSION]['references'])
        assert corrupted['snapshot']['completeness'] == 'partial'
        dimension_doc=ezdxf.new('R2013');dimension_doc.styles.new('ISO',dxfattribs={'font':'iso3098.shx'})
        dimension_doc.dimstyles.get('Standard').dxf.dimtxsty='ISO'
        dim=dimension_doc.modelspace().add_linear_dim(base=(0,5),p1=(0,0),p2=(10,0))
        dimension=parse(dimension_doc)
        substitute=dimension['document']['extensions'][EXTENSION]['substitutePreviews']
        assert any(row['sourceRefs'][0]['objectKey']==dim.dimension.dxf.handle for row in substitute.values())
        glyph_doc = ezdxf.new('R2013'); glyph_doc.styles.new('ISO', dxfattribs={'font': 'iso3098.shx'})
        glyph_doc.modelspace().add_text('漢', dxfattribs={'style': 'ISO', 'height': 3})
        glyph = parse(glyph_doc, {'iso3098.shx': ISO})
        assert glyph['document']['extensions'][EXTENSION]['coverage']['missingObjects'] == 1
        assert 'U+6F22' in glyph['document']['extensions'][EXTENSION]['failures'][0]['reason']
        assert glyph['document']['extensions']['org.cad-preview.drawing-coverage/1']['displayGeometry']['withoutDisplayGeometry'] == 1
        shape_doc = ezdxf.new('R2013'); shape_doc.styles.add_shx('square.shp')
        shape = shape_doc.modelspace().add_shape('SQUARE', insert=(10, 20), size=3, dxfattribs={'xscale': 2, 'rotation': 90})
        shape_result = parse(shape_doc, {'square.shp': SQUARE})
        assert shape_result['snapshot']['completeness'] == 'complete'
        # Literal square program: (0,0),(1,0),(1,1),(0,1),(0,0).
        # Size 3, X factor 2, 90-degree rotation, WCS origin (10,20).
        from unified.dxf_shx import Resources
        from unified.dxf_xref import load_references
        state = load_references(shape_doc, path.read_bytes(), path.name)
        resources = Resources(shape_doc, state, {'square.shp': SQUARE})
        pts, segments, _, _ = resources.shape_geometry(shape, [{'sourceId': state.sid, 'objectKey': shape.dxf.handle}])
        assert [[round(x, 8) for x in p[:2]] for p in pts] == [[10,20],[10,26],[7,26],[7,20],[10,20]]
        assert segments == [(0,1),(1,2),(2,3),(3,4)]
        for broken in [b'*1,3,SQUARE\n7,2,0\n', b'*1,3,SQUARE\n7,1,0\n', b'*1,2,SQUARE\n6,0\n']:
            refused = parse(shape_doc, {'square.shp': broken})
            assert refused['document']['extensions'][EXTENSION]['coverage']['missingObjects'] == 1
            assert refused['snapshot']['completeness'] == 'partial'
        big_doc = ezdxf.new('R2013');big_doc.styles.new('Big', dxfattribs={'font':'iso3098.shx','bigfont':'big.shx'})
        big_doc.modelspace().add_text('A', dxfattribs={'style':'Big'})
        big = parse(big_doc, {'iso3098.shx':ISO,'big.shx':b'AutoCAD-86 bigfont 1.0\x1a'})
        assert big['snapshot']['completeness'] == 'partial'
        assert any(r['role'] == 'bigfont' and r['status'] == 'blocked' for r in big['document']['extensions'][EXTENSION]['references'])
        isolated=ezdxf.new('R2013')
        for name,extra in [('Regular',{}),('Vertical',{'flags':4}),('Big',{'bigfont':'big.shx'})]:
            isolated.styles.new(name,dxfattribs={'font':'iso3098.shx',**extra})
            isolated.modelspace().add_text('ABC',dxfattribs={'style':name})
        split=parse(isolated,{'iso3098.shx':ISO,'big.shx':b'AutoCAD-86 bigfont 1.0\x1a'})
        font_rows=[r for r in split['document']['extensions'][EXTENSION]['references'] if r['role']=='font']
        assert len(font_rows)==3 and all(r['status']=='resolved' for r in font_rows)
        assert split['snapshot']['completeness']=='partial'
        regular_ref=isolated.styles.get('Regular').dxf.handle
        assert any(r['sourceRefs'][0]['objectKey']==regular_ref for r in font_rows)
        # A child STANDARD must retain its own source font even when Loader
        # shares the host STANDARD table entry. No global font caches change.
        child=ezdxf.new('R2013');child.styles.get('Standard').dxf.font='iso3098.shx'
        text=child.modelspace().add_text('CHILD ABC',dxfattribs={'height':3})
        child.saveas(CONTROLS/'font_child.dxf');child_raw=(CONTROLS/'font_child.dxf').read_bytes()
        host=ezdxf.new('R2013');host.styles.get('Standard').dxf.font='arial.ttf'
        xref.attach(host,block_name='A',filename='a/leaf.dxf')
        xref.attach(host,block_name='B',filename='b/leaf.dxf',insert=(50,0))
        scoped=parse(host,{'a/leaf.dxf':child_raw,'b/leaf.dxf':child_raw,'a/iso3098.shx':ISO,'b/iso3098.shx':KST})
        scoped_rows=scoped['document']['extensions'][EXTENSION]['references']
        assert {r['logicalPath'] for r in scoped_rows}=={'a/iso3098.shx','b/iso3098.shx'}
        assert len({r['sha256'] for r in scoped_rows})==2
        assert all(r['status']=='resolved' for r in scoped_rows)
        assert {r['usedSourceRefs'][0]['objectKey'] for r in scoped_rows}=={text.dxf.handle}
        sid='source-'+hashlib.sha256(child_raw).hexdigest()
        assert all(r['usedSourceRefs'][0]['sourceId']==sid for r in scoped_rows)
        # SHAPE libraries are declarations of their original source, not a
        # process-wide namespace shared by host and imported block definitions.
        shape_child=ezdxf.new('R2013');shape_child.styles.add_shx('test_shape.shx')
        child_shape=shape_child.modelspace().add_shape('MY-SHAPE',(0,0),1)
        shape_child.saveas(path);shape_child_raw=path.read_bytes()
        shape_host=ezdxf.new('R2013');shape_host.styles.add_shx('host.shp')
        shape_host.modelspace().add_shape('MY-SHAPE',(50,0),1)
        xref.attach(shape_host,block_name='ShapeChild',filename='parts/shape.dxf')
        nested=parse(shape_host,{'parts/shape.dxf':shape_child_raw,'parts/test_shape.shx':SHAPE,
            'host.shp':SQUARE.replace(b'SQUARE',b'MY-SHAPE')})
        assert nested['snapshot']['completeness']=='complete'
        nested_rows=nested['document']['extensions'][EXTENSION]['references']
        assert {r['logicalPath'] for r in nested_rows}=={'host.shp','parts/test_shape.shx'}
        child_row=next(r for r in nested_rows if r['logicalPath']=='parts/test_shape.shx')
        assert child_row['chain'] and child_row['sha256']==hashlib.sha256(SHAPE).hexdigest()
        assert child_row['usedSourceRefs'][0]['objectKey']==child_shape.dxf.handle
        assert child_row['usedSourceRefs'][0]['sourceId']=='source-'+hashlib.sha256(shape_child_raw).hexdigest()
        # Resource matching is independent of process history and logical aliases.
        repeat=read_dxf(CONTROLS/'font_text.dxf',main,resources=files)
        assert repeat['document']['revision']==loaded['document']['revision']
        # Compare compiled SHX with its unchanged source SHP plus the explicit
        # independent A stroke coordinates in that source program.
        binary=shapefile.shx_load(ISO)
        # The upstream SHP uses newline-separated opcodes which this fixed
        # reader rejects. Keep its bytes intact and independently transcribe
        # just the published A program for this coordinate control.
        original_a=[2,14,8,-12,-32,8,7,4,1,9,10,28,9,-28,0,0,2,8,-16,8,1,8,13,0,2,8,1,-12,14,8,-12,0,0]
        assert list(binary.shapes[65].data)==original_a
        a=binary.render_shape(65).to_path()
        endpoints=[[(round(p.x,6),round(p.y,6)) for p in segment.flattening(.01)] for segment in a.sub_paths()]
        endpoints=[points for points in endpoints if len(points)>1]
        assert endpoints==[[(7,4),(17,32),(26,4)],[(10,12),(23,12)]],endpoints
    return {'uploadedTextMtextAttribAndSheet':True,'originalIdentityAndActualFontHash':True,'missingPreviewExplicitlyPartial':True,
        'ambiguousAndCorruptResources':True,'dimensionGlyphSubstitutionKeepsParentIdentity':True,
        'missingGlyphNotTofu':True,'shapePoseAndPenUpPaths':True,'missingSubshapeCycleAndStackRefused':True,
        'malformedBigfontRefused':True,'unsupportedStyleDoesNotPoisonSharedFont':True,'xrefStandardAndSourceRelativeNamespaces':True,
        'xrefShapeLibrariesRetainSourceNamespace':True,'requestHistoryDoesNotChangeFonts':True,'compiledGlyphMatchesOriginalShpAndCoordinates':True}


def original_shapes():
    results=[]
    for name in ['acadsharp_sample_AC1009.dxf','acadsharp_sample_AC1015.dxf','acadsharp_sample_AC1032.dxf']:
        p=ROOT/'phase_i_evidence/samples/real'/name;raw=p.read_bytes();states=[]
        for state,files in [('main-only',None),('original-shx-provided',{'test_shape.shx':SHAPE}),('removed-again',None)]:
            e=read_dxf(p,raw,resources=files);d=e['document'];items=d['extensions']['org.cad-preview.annotation-presentation/1']['items']
            shape=next(i for i in items.values() if i['sourceKind']=='SHAPE')
            assert shape['sourceRefs'][0]['objectKey']=='889'
            assert shape['status']==('ready' if files else 'missing')
            states.append({'state':state,'sourceRefs':shape['sourceRefs'],'shapePresentation':shape,
                'display':d['extensions']['org.cad-preview.drawing-coverage/1']['displayGeometry'],
                'fontResources':d['extensions'][EXTENSION],'overallCompleteness':e['snapshot']['completeness'],
                'artifactBytes':len(json.dumps(e,ensure_ascii=False,separators=(',',':')).encode())})
        assert states[1]['display']['withDisplayGeometry']==states[0]['display']['withDisplayGeometry']+1
        assert states[0]['display']==states[2]['display']
        results.append({'file':name,'sha256':hashlib.sha256(raw).hexdigest(),'inputBytes':len(raw),'companionBytes':len(SHAPE),'states':states})
    return results


def http_cases(base):
    rows=[];main=(CONTROLS/'font_text.dxf').read_bytes();files={'font_text.dxf':main,'iso3098.shx':ISO,'kst32b.shx':KST}
    def post(values):
        body=package('font_text.dxf',values);query=urllib.parse.urlencode({'name':'font_text.dxf','model':'ucd','metadata':'full','compression':'identity'})
        with urllib.request.urlopen(urllib.request.Request(base+'/api/parse-dxf-bundle?'+query,data=body,method='POST'),timeout=70) as response:
            raw=response.read();payload=json.loads(raw);rows.append({'status':response.status,'cache':response.headers.get('X-Cache'),'requestBytes':len(body),'artifactBytes':len(raw)})
        return payload,raw,rows[-1]
    before,body,_=post(files);assert before['snapshot']['completeness']=='complete'
    _,again,row=post(files);assert row['cache']=='hit' and body==again
    only,_,_=post({'font_text.dxf':main});assert only['snapshot']['completeness']=='partial'
    changed=dict(files);changed['iso3098.shx']=KST
    fresh,_,row=post(changed);assert row['cache']!='hit'
    assert {r['sha256'] for r in fresh['document']['extensions'][EXTENSION]['references']}=={hashlib.sha256(KST).hexdigest()}
    _,restored,row=post(files);assert row['cache']=='hit' and body==restored
    result={'base':base,'checks':{'fontBundleRoundTrip':True,'sameBytesCacheHit':True,'mainOnlyIsolated':True,'fontBytesInvalidateCache':True,'originalFontRestoresOriginalCache':True},'requests':rows}
    (OUT/'http.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');return result['checks']


if __name__=='__main__':
    for row in json.loads((OUT/'manifest.json').read_text())['resourceFiles']:
        assert hashlib.sha256((ORIGINALS/row['file']).read_bytes()).hexdigest()==row['sha256']
    checks=controls();originals=original_shapes()
    (OUT/'parser.json').write_text(json.dumps({'date':'2026-10-22','controls':checks,'originalFiles':originals,
        'controlClassification':'Generated DXF engineering controls, using unchanged upstream SHX font originals; not new industrial drawings'},ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'controls':checks,'unchangedOriginalShapes':len(originals)}))
    if len(sys.argv)==3 and sys.argv[1]=='--http':print(json.dumps(http_cases(sys.argv[2])))
