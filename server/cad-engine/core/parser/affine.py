"""Factor affine HSF matrices into two glTF-compatible TRS nodes.

glTF node matrices must be decomposable as TRS. HSF permits shear; an SVD
represents its linear part as U * diagonal(scale) * V-transpose without losing it.
"""
import math
from binary import ConversionError


def determinant(a):
    return a[0][0]*(a[1][1]*a[2][2]-a[1][2]*a[2][1])-a[0][1]*(a[1][0]*a[2][2]-a[1][2]*a[2][0])+a[0][2]*(a[1][0]*a[2][1]-a[1][1]*a[2][0])


def quaternion(a):
    trace = sum(a[i][i] for i in range(3))
    if trace > 0:
        s = math.sqrt(trace + 1) * 2
        q = [(a[2][1]-a[1][2])/s, (a[0][2]-a[2][0])/s, (a[1][0]-a[0][1])/s, s/4]
    else:
        i = max(range(3), key=lambda k:a[k][k])
        j, k = (i+1)%3, (i+2)%3
        s = math.sqrt(max(0, 1+a[i][i]-a[j][j]-a[k][k]))*2
        if s == 0:
            raise ConversionError('Invalid rotation factor', stage='export')
        q = [0.0]*4
        q[i] = s/4
        q[j] = (a[j][i]+a[i][j])/s
        q[k] = (a[k][i]+a[i][k])/s
        q[3] = (a[k][j]-a[j][k])/s
    length = math.sqrt(sum(x*x for x in q))
    return [x/length for x in q]


def factor(matrix):
    a = [[matrix[c*4+r] for c in range(3)] for r in range(3)]
    b = [[sum(a[k][r]*a[k][c] for k in range(3)) for c in range(3)] for r in range(3)]
    v = [[float(r==c) for c in range(3)] for r in range(3)]
    for _ in range(40):
        p,q = max(((0,1),(0,2),(1,2)),key=lambda pair:abs(b[pair[0]][pair[1]]))
        if abs(b[p][q]) <= max(abs(b[i][i]) for i in range(3))*1e-15:
            break
        tau = (b[q][q]-b[p][p])/(2*b[p][q])
        t = math.copysign(1,tau)/(abs(tau)+math.sqrt(1+tau*tau))
        cosine = 1/math.sqrt(1+t*t)
        sine = t*cosine
        off = b[p][q]
        b[p][p] -= t*off
        b[q][q] += t*off
        b[p][q] = b[q][p] = 0
        for k in range(3):
            if k not in (p,q):
                left,right = b[k][p],b[k][q]
                b[k][p] = b[p][k] = cosine*left-sine*right
                b[k][q] = b[q][k] = sine*left+cosine*right
            left,right = v[k][p],v[k][q]
            v[k][p],v[k][q] = cosine*left-sine*right,sine*left+cosine*right
    scale = [math.sqrt(max(0,b[i][i])) for i in range(3)]
    if min(scale) <= max(scale)*1e-10:
        raise ConversionError('Singular or ill-conditioned affine transform',stage='export')
    u = [[sum(a[r][k]*v[k][c] for k in range(3))/scale[c] for c in range(3)] for r in range(3)]
    for rotation in (u,v):
        if determinant(rotation)<0:
            for row in rotation:
                row[0] = -row[0]
            scale[0] = -scale[0]
    error = max(abs(sum(u[r][k]*scale[k]*v[c][k] for k in range(3))-a[r][c]) for r in range(3) for c in range(3))
    orthogonal_error = max(abs(sum(rotation[k][r]*rotation[k][c] for k in range(3))-(r==c)) for rotation in (u,v) for r in range(3) for c in range(3))
    if error > max(1,max(abs(x) for row in a for x in row))*1e-10 or orthogonal_error > 1e-10:
        raise ConversionError('Affine factorization failed its reconstruction check',stage='export')
    return {'translation':matrix[12:15],'rotation':quaternion(u),'scale':scale}, {'rotation':quaternion([[v[c][r] for c in range(3)] for r in range(3)])}
