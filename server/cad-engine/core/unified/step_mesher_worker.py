"""Isolated Gmsh worker. This process must never import the viewer's OCP runtime."""
import argparse,hashlib,json,math
from pathlib import Path

ENGINE='4.15.2'

def mesh_face(source,size):
    import gmsh
    if gmsh.__version__!=ENGINE:raise ValueError('requires gmsh=='+ENGINE)
    gmsh.initialize([],readConfigFiles=False)
    try:
        gmsh.option.setNumber('General.Terminal',0);gmsh.option.setNumber('General.NumThreads',1)
        for option in ('OCCFixDegenerated','OCCFixSmallEdges','OCCFixSmallFaces','OCCSewFaces','OCCMakeSolids'):
            gmsh.option.setNumber('Geometry.'+option,0)
        gmsh.option.setNumber('Mesh.Algorithm',2);gmsh.option.setNumber('Mesh.MeshSizeMax',size);gmsh.option.setNumber('Mesh.MaxNumThreads2D',1)
        gmsh.model.occ.importShapes(str(source));gmsh.model.occ.synchronize();surfaces=gmsh.model.getEntities(2)
        if len(surfaces)!=1:raise ValueError('mesher-requires-one-source-face')
        tag=surfaces[0][1];gmsh.model.mesh.generate(2)
        tags,coords,params=gmsh.model.mesh.getNodes(2,tag,True,True)
        if not 3<=len(tags)<=50000 or len(coords)!=3*len(tags) or len(params)!=2*len(tags):raise ValueError('mesher-node-or-chart-budget')
        index={};positions=[];uvs=[];duplicates=0
        # includeBoundary can list the same seam entity twice. Only identical
        # XYZ AND UV rows may share an index; conflicting charts still reject.
        for i,t in enumerate(tags):
            node=int(t);point=[float(v) for v in coords[i*3:i*3+3]];uv=[float(v) for v in params[i*2:i*2+2]]
            if node in index:
                j=index[node]
                if point!=positions[j] or uv!=uvs[j]:raise ValueError('ambiguous-source-chart-node')
                duplicates+=1
            else:index[node]=len(positions);positions.append(point);uvs.append(uv)
        types,_,nodes=gmsh.model.mesh.getElements(2,tag);triangles=[]
        for kind,values in zip(types,nodes):
            if int(kind)!=2 or len(values)%3:raise ValueError('mesher-requires-linear-triangles')
            if len(triangles)+len(values)//3>50000:raise ValueError('mesher-triangle-budget')
            triangles.extend([index[int(t)] for t in values[i:i+3]] for i in range(0,len(values),3))
        if not triangles:raise ValueError('mesher-empty-result')
        return {'engine':'gmsh','version':ENGINE,'sourceSHA256':hashlib.sha256(source.read_bytes()).hexdigest(),
                'maxElementSizeMM':size,'algorithm':2,'explicitCADHealing':False,
                'duplicateNodeRowsCollapsed':duplicates,'positions':positions,'uvs':uvs,'indices':triangles}
    finally:gmsh.finalize()

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('source',type=Path);parser.add_argument('output',type=Path);parser.add_argument('--size',type=float,required=True);args=parser.parse_args()
    if not math.isfinite(args.size) or args.size<=0:parser.error('invalid mesh size')
    try:result=mesh_face(args.source,args.size)
    except Exception as error:result={'error':str(error)[:512]}
    raw=json.dumps(result,allow_nan=False,separators=(',',':')).encode()
    if len(raw)>16*1024*1024:raw=b'{"error":"mesher-output-budget"}'
    args.output.write_bytes(raw)
