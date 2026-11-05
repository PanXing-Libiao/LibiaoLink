"""Image media keeps a real ezdxf matrix internally and JSON floats on the wire."""
import io
import tempfile
import unittest
from pathlib import Path

import ezdxf
from PIL import Image
from unified import dxf_media
from unified.dxf_adapter import read_dxf
from unified.dxf_media import EXTENSION
from unified.validation import validate_envelope

# The adapter pins the release image stack. Local mirrors may carry a different
# Patch release with the same image API; the fixture below only needs PNG.
dxf_media.VERSIONS['Pillow'] = __import__('importlib.metadata', fromlist=['version']).version('Pillow')


def convert(doc, resources):
    raw = io.StringIO()
    doc.write(raw)
    payload = raw.getvalue().encode(doc.output_encoding)
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / 'main.dxf'
        path.write_bytes(payload)
        result = read_dxf(path, payload, resources=resources, logical_path='drawings/main.dxf')
    validate_envelope(result)
    return result


class ImageGeometryTest(unittest.TestCase):
    def test_image_geometry_serializes_plain_json_floats_and_keeps_media_ready(self):
        raw = io.BytesIO()
        Image.new('RGBA', (4, 4), (255, 0, 0, 255)).save(raw, format='PNG')
        doc = ezdxf.new('R2013')
        doc.units = 4
        definition = doc.add_image_def(filename='dot.png', size_in_pixel=(4, 4))
        entity = doc.modelspace().add_image(definition, insert=(1, 2), size_in_units=(4, 4),
            dxfattribs={'flags': 11})
        result = convert(doc, {'dot.png': raw.getvalue()})
        items = result['document']['extensions'][EXTENSION]['items']
        item_id = next(key for key, row in items.items()
            if row['sourceRefs'][0]['objectKey'] == entity.dxf.handle)
        row = items[item_id]
        self.assertEqual(row['status'], 'ready', row)
        geometry = result['document']['drawing']['entities'][item_id]['geometry']
        self.assertEqual(geometry['type'], 'image')
        self.assertTrue(all(type(value) is float for value in geometry['imageToEntity']),
            geometry['imageToEntity'])
        self.assertTrue(all(type(value) is float for corner in row['corners'] for value in corner))


if __name__ == '__main__':
    unittest.main()
