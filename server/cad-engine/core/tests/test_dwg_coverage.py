"""DWG source-handle coverage ledger regressions."""
import unittest

from unified.dwg_adapter import source_display_coverage


def source_ref(handle):
    return [{"sourceId": "source-0", "objectKey": handle}]


class SourceDisplayCoverageTest(unittest.TestCase):
    def test_partitions_direct_annotation_block_and_unresolved_handles(self):
        drawing = {
            "entities": {
                "entity-1": {"ownerSpaceId": "space-model", "sourceRefs": source_ref("1")},
                "entity-2": {"ownerSpaceId": "space-model", "sourceRefs": source_ref("2")},
                "entity-5": {"ownerSpaceId": "space-block", "sourceRefs": source_ref("5")},
            },
            "annotations": {
                "annotation-3": {"ownerSpaceId": "space-model", "sourceRefs": source_ref("3")},
            },
            "blockInstances": {
                "instance-4": {"ownerSpaceId": "space-model", "definitionId": "block-B",
                               "sourceRefs": source_ref("4")},
            },
            "blocks": {"block-B": {"id": "block-B", "spaceId": "space-block"}},
        }
        displays = {
            "entity-1": {"sourceRefs": source_ref("1")},
            "entity-5": {"sourceRefs": source_ref("5")},
        }
        summary = {"mappedObjects": 5, "mappedSourceObjects": 5}
        coverage = source_display_coverage(drawing, displays, {}, summary, {"style": {}}, {})

        self.assertEqual(coverage["status"], "partial")
        self.assertEqual(coverage["sourceRecords"], 5)
        self.assertEqual(coverage["withDisplayGeometry"], 4)
        self.assertEqual(coverage["withoutDisplayGeometry"], 1)
        self.assertEqual(coverage["byReason"]["directGeometry"], 2)
        self.assertEqual(coverage["byReason"]["annotationPresentation"], 1)
        self.assertEqual(coverage["byReason"]["blockInstanceIndirect"], 1)
        self.assertEqual(coverage["byReason"]["unresolved"], 1)
        self.assertEqual(coverage["byReason"]["unsupported"], {"UNKNOWN": 1})
        self.assertEqual(coverage["fidelity"]["status"], "partial")
        self.assertEqual(coverage["fidelity"]["fontSubstitution"]["nativeFontRecords"], 1)

    def test_block_instances_are_accounted_once_instead_of_reported_missing(self):
        drawing = {
            "entities": {}, "annotations": {},
            "blockInstances": {
                "instance-9": {"ownerSpaceId": "space-model", "definitionId": "block-empty",
                               "sourceRefs": source_ref("9")},
            },
            "blocks": {"block-empty": {"id": "block-empty", "spaceId": "space-empty"}},
        }
        coverage = source_display_coverage(drawing, {}, {}, {"mappedObjects": 1}, {}, {})

        self.assertEqual(coverage["status"], "complete")
        self.assertEqual(coverage["withoutDisplayGeometry"], 0)
        self.assertEqual(coverage["byReason"]["blockInstanceIndirect"], 1)
        self.assertEqual(coverage["byReason"]["blockInstanceEmptyDefinition"], 1)


if __name__ == "__main__":
    unittest.main()
