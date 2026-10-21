import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SvgPolicyError, inspectSvg } from "./svg-policy.mjs";

const fixture = (group, name) => readFileSync(fileURLToPath(new URL(`./fixtures/${group}/${name}`, import.meta.url)));
const expectCode = (bytes, code, limits = {}) => assert.throws(() => inspectSvg(bytes, limits), (error) => error instanceof SvgPolicyError && error.code === code);

test("normal fixtures resolve controlled output dimensions", () => {
  const basic = inspectSvg(fixture("normal", "basic-shapes.svg"));
  assert.deepEqual([basic.outputWidth, basic.outputHeight], [1600, 900]);
  const large = inspectSvg(fixture("normal", "near-4096.svg"));
  assert.deepEqual([large.outputWidth, large.outputHeight], [4096, 2304]);
  const gradient = inspectSvg(fixture("normal", "gradient.svg"));
  assert.equal(gradient.fitTo.mode, "width");
});

test("malicious fixtures fail closed with stable codes", () => {
  expectCode(fixture("malicious", "script.svg"), "SVG_ACTIVE_CONTENT");
  expectCode(fixture("malicious", "event-attribute.svg"), "SVG_EVENT_ATTRIBUTE");
  expectCode(fixture("malicious", "foreign-object.svg"), "SVG_ACTIVE_CONTENT");
  expectCode(fixture("malicious", "external-image.svg"), "SVG_EXTERNAL_RESOURCE");
  expectCode(fixture("malicious", "external-css.svg"), "SVG_ACTIVE_CSS");
  expectCode(fixture("malicious", "doctype.svg"), "SVG_DTD_FORBIDDEN");
  expectCode(fixture("malicious", "huge-dimensions.svg"), "SVG_DIMENSION_TOO_LARGE");
  expectCode(fixture("malicious", "extreme-aspect.svg"), "SVG_ASPECT_RATIO");
  expectCode(fixture("malicious", "css-xml-comment.svg"), "SVG_CSS_COMMENT");
  expectCode(fixture("malicious", "css-image-set.svg"), "SVG_EXTERNAL_RESOURCE");
});

test("internal references remain allowed", () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><defs><linearGradient id="g"><stop stop-color="red"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>');
  assert.equal(inspectSvg(svg).outputWidth, 1600);
});

test("element, source and pixel limits are enforced", () => {
  const many = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><g/><g/><g/><g/></svg>');
  expectCode(many, "SVG_ELEMENT_LIMIT", { maxElements: 3 });
  expectCode(Buffer.from("<svg/>"), "SVG_SOURCE_TOO_LARGE", { maxSourceBytes: 4 });
  expectCode(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'), "SVG_PIXEL_LIMIT", { maxPixels: 100 });
  expectCode(fixture("malicious", "pixel-bomb.svg"), "SVG_PIXEL_LIMIT", { maxPixels: 1_000_000 });
});

test("whole style text is checked across CDATA and active CSS markers fail closed", () => {
  const cdataSplit = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><style>express<![CDATA[ion(alert(1))]]></style><rect width="10" height="10"/></svg>');
  expectCode(cdataSplit, "SVG_ACTIVE_CSS");
  expectCode(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><style>rect{behavior:url(#default#time2)}</style></svg>'), "SVG_ACTIVE_CSS");
  expectCode(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><style>rect{-moz-binding:url(#x)}</style></svg>'), "SVG_ACTIVE_CSS");
  expectCode(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><style>rect{fill:u\\72l(https://example.com/a.png)}</style></svg>'), "SVG_CSS_ESCAPE");
});
