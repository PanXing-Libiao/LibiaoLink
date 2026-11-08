Bundled viewer fonts (explicit replacements after resolved original glyph parts):

- latin.css / latin/: Arimo, Tinos, Cousine (Google Fonts, Apache License 2.0);
  metrically compatible with Arial, Times New Roman and Courier New.
- noto.css / noto/: Noto Sans SC and Noto Serif SC subsets (Google Fonts, SIL Open Font License 1.1).
  Family names are rewritten to Libiao Sans/Serif/Mono and Libiao Sans SC/Serif SC.

Licenses: LICENSE-APACHE.txt (Arimo/Tinos/Cousine), LICENSE-OFL.txt (Noto).

Replacement selection uses only these bundled families. The same loaded face
is used for width/cap-height measurement, wrapping and Canvas painting. Existing
resolved original presentation parts keep priority; replacements remain approximate.
The checked-in Chinese faces declare weight 400 only; Latin faces declare 400/700.
Unavailable bold/italic styles are reported, without synthesizing a matching face.

Coverage is generated from actual WOFF2 cmap intersected with each CSS unicode-range:
  CAD_FONT_PYTHON=/path/to/python node frontend/scripts/generate-cad-font-coverage.mjs
The authoring Python environment needs fontTools with WOFF2/Brotli support; this is
not a viewer/runtime dependency. Regenerate core/drawing-font-coverage.js after
changing bundled CSS or font bytes. Missing characters stay in source annotations;
the substitute preview uses a covered square marker and reports the source code point.

The same two Noto CJK families also supply pinned common engineering-symbol
subsets (no drawing-specific character list). Upstream URLs, source/output hashes,
versions, copyright and Unicode ranges: engineering-symbol-sources.json.
They remain under LICENSE-OFL.txt; modified subset family names use Libiao.
Rebuild these bytes from the pinned local OTF files with:
  CAD_FONT_PYTHON=/path/to/python node frontend/scripts/generate-cad-symbol-fonts.mjs /local/upstream-fonts
Then regenerate the coverage table. Existing bundled glyphs retain priority within
each family; symbol subsets add only previously absent code points in the documented blocks.


Automatic matching and source layout constraints (2026-11-08)
- Resolved original glyph presentations remain first. Supplied files are matched automatically by logical filename or declared family; no manual font-selection UI is added.
- Missing faces use the checked-in mapping: Song/FangSong/Kai -> Noto Serif SC; Hei/YaHei -> Noto Sans SC; Arial/Swiss/Helvetica -> Arimo; Times -> Tinos; Courier -> Cousine. SHX names initially use the Latin sans category; uncovered CJK are supplied by the finite bundled CJK faces. Unknown names use script-based defaults.
- Per-character cmap coverage and available weights/styles select actual faces before measuring. This is category matching, not recovery of the missing original font metrics.
- Original explicit height, width, tracking, paragraph indents/alignment and left tab stops drive replacement wrapping and painting. Absolute inline width overrides style width; relative values and nested groups keep their source contexts. Tracking changes advances rather than scaling glyph outlines.
- Reference frame widths are constraints; stored measured extents and unparsed legacy column heights are not target sizes for automatic compression. Source coordinates, reference widths and font requests are retained. No per-drawing fitting or automatic text relocation is used.
- Right/center tab fields, justified/distributed paragraphs, paragraph spacing controls and other unmodelled commands remain approximate. Font substitution may still change visible height, widths and line breaks.

- Historical CAD cap-height measurement, source width/height controls, CJK punctuation, whole English words, original-glyph priority and shared scaled painting remain in use with these faces. Native MTEXT wrapping also ignores line-end ordinary spaces, as the earlier plain path did; leading spaces, explicit empty paragraphs, tabs and TEXT endpoint spacing remain source-defined. Raw source text is retained.
