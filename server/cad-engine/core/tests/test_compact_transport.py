"""Transport roundtrips and corrupt wire inputs; these are not CAD evidence."""
from cad_paths import CORE, DATA, WORK, BROWSER, SAMPLE_ROOT
import copy,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from unified.compact_transport import pack_metadata,unpack_metadata

def fixture():
    draw={'occurrenceId':'scene-'+('a'*64),'bindingId':'body','primitiveId':'face-0',
          'membership':'present','availability':'ready','suppression':'not-represented',
          'visibility':'shown','materialId':'material-'+('b'*64)}
    return {'transportProfile':'ucd-worker-binary/1','document':{'revision':'unchanged',
            'renderOwnership':{'draw-'+('c'*64):'product-零件','null-owner':None,'inactive-draw':None}},
            'snapshot':{'documentRevision':'unchanged','draws':{'draw-'+('c'*64):draw,'draw-'+('c'*12+'d'*52):{**draw,'visibility':'hidden'},'null-owner':draw}}}

class CompactTests(unittest.TestCase):
    def test_full_ids_missing_owner_and_inactive_owner_roundtrip(self):
        original=fixture();before=copy.deepcopy(original);packed=pack_metadata(original)
        self.assertEqual(unpack_metadata(packed),original);self.assertEqual(original,before)
        self.assertNotEqual(*list(original['snapshot']['draws'])[:2])
        self.assertEqual(len(packed['drawTable']['rows']),3)
    def test_empty_and_public_profile(self):
        original=fixture();original['snapshot']['draws']={};original['transportProfile']='ucd-binary-manifest/1'
        self.assertEqual(unpack_metadata(pack_metadata(original)),original)
    def test_malformed_indices_reject_including_bool_and_negative(self):
        for index in (-1,True,1.5,999999,None):
            packed=pack_metadata(fixture());packed['drawTable']['rows'][0][1]=index
            with self.subTest(index=index),self.assertRaises(ValueError):unpack_metadata(packed)
    def test_duplicate_draw_dictionary_and_owner_reject(self):
        packed=pack_metadata(fixture());packed['drawTable']['rows'].append(packed['drawTable']['rows'][0])
        with self.assertRaises(ValueError):unpack_metadata(packed)
        packed=pack_metadata(fixture());packed['drawTable']['strings'].append(packed['drawTable']['strings'][0])
        with self.assertRaises(ValueError):unpack_metadata(packed)
        packed=pack_metadata(fixture());packed['drawTable']['ownershipRemainder'].append([packed['drawTable']['rows'][0][0],0])
        with self.assertRaises(ValueError):unpack_metadata(packed)
    def test_ambiguous_maps_and_unknown_layout_reject(self):
        packed=pack_metadata(fixture());packed['snapshot']['draws']={'hidden-duplicate':{}}
        with self.assertRaises(ValueError):unpack_metadata(packed)
        packed=pack_metadata(fixture());packed['drawTable']['version']='future'
        with self.assertRaises(ValueError):unpack_metadata(packed)
    def test_full_legacy_profile_is_untouched(self):
        original=fixture();self.assertIs(unpack_metadata(original),original)

if __name__=='__main__':unittest.main()
