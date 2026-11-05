"""Union-only schema wrappers must keep complete descendant validation."""
import math,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from unified.validation import shape,ValidationError

class UnionSchema(unittest.TestCase):
    def test_branch_still_validates_unknown_nested_values(self):
        schema={'oneOf':[{'type':'object'},{'type':'string'}]}
        shape({'extra':{'list':[1,2]}},schema)
        with self.assertRaises(ValidationError):shape({'extra':{'list':[math.inf]}},schema)

    def test_one_of_still_rejects_overlapping_branches(self):
        schema={'oneOf':[{'type':'object'},{}]}
        with self.assertRaises(ValidationError):shape({'valid':'both'},schema)

    def test_any_of_still_accepts_multiple_matches(self):
        shape({'valid':'both'},{'anyOf':[{'type':'object'},{}]})

    def test_wrapper_constraints_are_not_skipped(self):
        schema={'oneOf':[{'type':'object'},{'type':'string'}],'required':['needed']}
        with self.assertRaises(ValidationError):shape({},schema)
        shape({'needed':1},schema)

    def test_both_union_operators_are_applied(self):
        schema={'oneOf':[{'type':'object'},{'type':'string'}],'anyOf':[{'type':'integer'}]}
        with self.assertRaises(ValidationError):shape({},schema)

if __name__=='__main__':unittest.main()
