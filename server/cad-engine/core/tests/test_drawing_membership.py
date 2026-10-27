"""Drawing membership remains strict and scales with source entities."""
import copy
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from unified.validation import validate_drawing,ValidationError

I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]


class CountedId(str):
    comparisons=0
    __hash__=str.__hash__
    def __eq__(self,other):
        type(self).comparisons+=1
        return str.__eq__(self,other)


def document(count):
    m={k:{} for k in ('drawings','spaces','sheets','layouts','viewports','entities','annotations','blocks','blockInstances','layers','lineTypes','textStyles','plotStyles','hatchPatterns')}
    style={'color':{'mode':'by-layer'},'plot':True}
    m['drawings']['D']={'id':'D','modelSpaceId':'M','sheetIds':[],'layoutIds':[],'layerIds':['L']}
    m['spaces']['M']={'id':'M','drawingId':'D','kind':'model','entityIds':[],'annotationIds':[],'blockInstanceIds':[]}
    m['layers']['L']={'id':'L','drawingId':'D','defaultStyle':style}
    for n in range(count):
        key=CountedId(str(n));m['spaces']['M']['entityIds'].append(key)
        m['entities'][key]={'id':key,'ownerSpaceId':'M','layerId':'L','drawingId':'D','localFromOwner':I,'geometry':{'type':'line'},'style':style}
    return {'drawing':m}


class DrawingMembership(unittest.TestCase):
    def test_linear_membership(self):
        doc=document(2000);CountedId.comparisons=0
        validate_drawing(doc)
        self.assertLess(CountedId.comparisons,20*2000,'Membership validation must not scan a large space once per entity')

    def test_orphan_and_duplicate_members_still_fail(self):
        for mutate in (lambda m:m['spaces']['M']['entityIds'].pop(),
                       lambda m:m['spaces']['M']['entityIds'].append('0'),
                       lambda m:m['entities']['0'].update(ownerSpaceId='missing')):
            doc=document(3);mutate(doc['drawing'])
            with self.assertRaises(ValidationError):validate_drawing(doc)


if __name__=='__main__':unittest.main()
