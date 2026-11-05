"""Compiled font metadata is data, not a shape bytecode program."""
from pathlib import Path
import struct
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cad_paths import CORE
import unittest

import ezdxf
from ezdxf.fonts import shapefile
from test_fonts_layout_xref import PRIMARY_SHP, raw_doc, convert
from test_vertical_fonts import resources


def compiled_font(kind='shapes 1.0', above=5, newline=b'\r\n', trailer=b'EOF'):
    source = shapefile.shp_load(PRIMARY_SHP)
    glyphs = {n: symbol.name+b'\0'+bytes(v & 255 for v in symbol.data)
              for n, symbol in source.shapes.items()}
    signature = b'AutoCAD-86 '+kind.encode()+newline+b'\x1a'
    if kind.startswith('unifont'):
        definition = b'Original metadata\0'+bytes([above, 0, 2, 0, 0, 0])
        return (signature+struct.pack('<IH', len(glyphs)+1, len(definition))+definition+
                b''.join(struct.pack('<HH', n, len(data))+data for n, data in glyphs.items()))
    records = {0: b'Original metadata\0'+bytes([above, 0, 2, 0]), **glyphs}
    records = dict(sorted(records.items()))
    return (signature+struct.pack('<HHH', min(records), max(records), len(records))+
            b''.join(struct.pack('<HH', n, len(data)) for n, data in records.items())+
            b''.join(records.values())+trailer)


class CompiledFontHeaderTest(unittest.TestCase):
    def test_legacy_metadata_survives_zero_bytes_and_signature_line_endings(self):
        # 5 and 6 are position-stack opcodes, and below=0 terminates a program.
        # Neither is an instruction inside shape zero's metric record.
        for version in ('shapes 1.0', 'shapes 1.1', 'unifont 1.0'):
            for height in (5, 6, 8, 32):
                for newline in (b'\r\n', b'\n'):
                    with self.subTest(version=version, height=height, newline=newline):
                        doc = ezdxf.new('R2013')
                        doc.styles.new('Original', dxfattribs={'font': 'renamed.shx'})
                        text = doc.modelspace().add_text('A', dxfattribs={'style': 'Original', 'height': height})
                        data = compiled_font(version, height, newline)
                        fonts = resources(doc, {'renamed.shx': data})
                        row = fonts.binding(text, [{'sourceId': 'source'}])
                        self.assertEqual(row['status'], 'resolved', row['reason'])
                        self.assertEqual((row['_file'].above, row['_file'].below, row['_file'].mode.value), (height, 0, 2))
                        self.assertEqual(row['_file'].name, b'Original metadata')
                        self.assertEqual(convert(doc, {'renamed.shx': data})['snapshot']['completeness'], 'complete')

    def test_shape_trailer_is_optional_but_records_cannot_be_truncated_or_duplicated(self):
        doc = ezdxf.new('R2013'); doc.styles.new('Original', dxfattribs={'font': 'font.shx'})
        text = doc.modelspace().add_text('A', dxfattribs={'style': 'Original', 'height': 5})
        valid = compiled_font(trailer=b'')
        self.assertEqual(convert(doc, {'font.shx': valid})['snapshot']['completeness'], 'complete')
        marker = valid.index(b'\x1a')+1
        duplicate = bytearray(valid)
        struct.pack_into('<H', duplicate, marker+6+4, 0)
        for malformed in (valid[:-1], bytes(duplicate), valid+b'garbage', compiled_font(above=0)):
            fonts = resources(doc, {'font.shx': malformed})
            row = fonts.binding(text, [{'sourceId': 'source'}])
            self.assertEqual(row['status'], 'blocked')
            self.assertNotEqual(convert(doc, {'font.shx': malformed})['snapshot']['completeness'], 'complete')


if __name__ == '__main__':
    unittest.main()
