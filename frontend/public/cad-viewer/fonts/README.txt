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
