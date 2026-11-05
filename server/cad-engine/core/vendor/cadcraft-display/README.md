# CADCraft display adaptations

Upstream: https://github.com/storytold/cadcraft
Pinned revision: `0cf3bdea83ebbe02fb2e674b23f07de4acfa73da` (read on 2026-10-21).
License selected: MIT; copyright and full terms in [LICENSE-MIT](LICENSE-MIT). No Rust runtime, branding, proprietary fonts or whole application is bundled.

- `unified/dxf_tolerance.py`: Python adaptation of `crates/doc/src/gdt.rs` parser/layout and unit-box symbol primitives, with ezdxf TEXT measurement, glyph generation and WCS entity transforms. Adds strict whole-entity refusal instead of upstream formatting skips/truncation; accepts the double-escaped GDT font spelling used by some DXF writers.
- `public/drawing-2d.js`: JavaScript adaptation of the unshifted `Field::new/value` algorithm in `crates/render/src/hatch.rs`. The Canvas texture is our bounded display backend; source boundaries and gradient colors are read by ezdxf. Shifted gradients remain unsupported.

The public DXF Reference is the field/coordinate authority. This reuse records an open-source rendering profile; it is not a claim of pixel-for-pixel equivalence to AutoCAD. Tests distinguish real corpus checks and synthetic controls.

Upstream file SHA-256 (original source, not the adapted file):

- `crates/doc/src/gdt.rs`: `f934451b70c09e8dbb68084797302711f2a0d669ab1753503d014778f32ae8c6`
- `crates/render/src/hatch.rs`: `b5f00ff068096a08d206982655f2740cc69dd9b6c615cc769cfa3eb6cec6929d`
