import { describe, expect, it } from "vitest";
import {
  CAD_EXTENSIONS,
  canonicalMimeForExtension,
  isRasterImageFile,
  isSvgFile,
  kindForExtension,
  normalizeMime,
  safePreviewContentType,
  validateUploadFileType,
} from "../src/modules/file/file-mime.js";

const encoder = new TextEncoder();
const PDF = encoder.encode("%PDF-1.7\n");
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
const GIF = encoder.encode("GIF89a");
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50,
]);
const BMP = encoder.encode("BM");
const TIFF = Uint8Array.from([0x49, 0x49, 0x2a, 0x00]);
const AVIF = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18,
  0x66, 0x74, 0x79, 0x70,
  0x61, 0x76, 0x69, 0x66,
]);
const ZIP = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);
const OLE = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const SVG = encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const XML_SVG = encoder.encode('<?xml version="1.0"?>\n<!-- leading comment -->\n<svg xmlns="http://www.w3.org/2000/svg"/>');
const HTML = encoder.encode("<!doctype html><html><script>alert(1)</script></html>");
const RTF = encoder.encode("{\\rtf1\\ansi test}");
const TEXT = encoder.encode("plain text");
const GLB = encoder.encode("glTF");

describe("H1 · S2 文件类型裁决", () => {
  it("normalizeMime：去参数 / 空白、转小写、常见别名归一；非法值 fail closed", () => {
    expect(normalizeMime(" IMAGE/PNG ; charset=binary")).toBe("image/png");
    expect(normalizeMime("image/svg+xml; charset=utf-8")).toBe("image/svg+xml");
    expect(normalizeMime("image/jpg")).toBe("image/jpeg");
    expect(normalizeMime("image/x-png")).toBe("image/png");
    expect(normalizeMime("image/tif")).toBe("image/tiff");
    expect(normalizeMime(null)).toBeNull();
    expect(normalizeMime("")).toBeNull();
    expect(normalizeMime("application/pdf\r\nX-Evil: 1")).toBeNull();
    expect(normalizeMime("not-a-mime")).toBeNull();
  });

  it("扩展名 → 规范 MIME / 类型：扩展名大小写不敏感，未知回落 null", () => {
    expect(canonicalMimeForExtension("图纸.PNG")).toBe("image/png");
    expect(canonicalMimeForExtension("图纸.JPEG")).toBe("image/jpeg");
    expect(canonicalMimeForExtension("方案.DOCX")).toContain("wordprocessingml.document");
    expect(canonicalMimeForExtension("未知.exe")).toBeNull();
    expect(kindForExtension("矢量图.svg")).toBe("svg");
    expect(kindForExtension("三维.step")).toBe("cad");
    expect(kindForExtension("未知.exe")).toBeNull();
    expect(CAD_EXTENSIONS.has("step")).toBe(true);
  });

  it("安全位图：扩展名 + 规范 MIME 精确匹配；MIME 缺失 / 冲突 / 无扩展名都不直签", () => {
    expect(isRasterImageFile({ fileName: "a.PNG", mime: "IMAGE/PNG; charset=binary" })).toBe(true);
    expect(isRasterImageFile({ fileName: "a.jpg", mime: "image/jpg" })).toBe(true);
    expect(isRasterImageFile({ fileName: "a.avif", mime: "image/avif" })).toBe(true);
    expect(isRasterImageFile({ fileName: "a.png", mime: null })).toBe(false);
    expect(isRasterImageFile({ fileName: "a.png", mime: "image/svg+xml" })).toBe(false);
    expect(isRasterImageFile({ fileName: "a.svg", mime: "image/png" })).toBe(false);
    expect(isRasterImageFile({ fileName: "无扩展名", mime: "image/png" })).toBe(false);
  });

  it("SVG：扩展名或规范 MIME 可进入 PNG 产物通道；声明冲突 / 空 MIME 非 SVG 不混入", () => {
    expect(isSvgFile({ fileName: "a.SVG", mime: null })).toBe(true);
    expect(isSvgFile({ fileName: "a.svg", mime: "IMAGE/SVG+XML; charset=utf-8" })).toBe(true);
    expect(isSvgFile({ fileName: "legacy.bin", mime: "image/svg+xml" })).toBe(true);
    expect(isSvgFile({ fileName: "无扩展名", mime: "image/svg+xml" })).toBe(true);
    expect(isSvgFile({ fileName: "a.svg", mime: "image/png" })).toBe(false);
    expect(isSvgFile({ fileName: "a.png", mime: "image/svg+xml" })).toBe(false);
  });

  it("上传校验：位图魔数矩阵 + 参数 MIME 规范化", () => {
    const cases = [
      ["a.png", "IMAGE/PNG; charset=binary", PNG, "image/png", "raster"],
      ["a.jpg", "image/jpg", JPEG, "image/jpeg", "raster"],
      ["a.gif", null, GIF, "image/gif", "raster"],
      ["a.webp", "image/webp", WEBP, "image/webp", "raster"],
      ["a.bmp", null, BMP, "image/bmp", "raster"],
      ["a.tiff", "image/tif", TIFF, "image/tiff", "raster"],
      ["a.avif", "image/avif", AVIF, "image/avif", "raster"],
    ] as const;
    for (const [fileName, mime, bytes, canonical, kind] of cases) {
      expect(validateUploadFileType({ fileName, mime, bytes })).toEqual({
        ok: true,
        mime: canonical,
        kind,
        extension: fileName.split(".").at(-1),
      });
    }
  });

  it("上传校验：PDF / Office / 文本 / HTML / SVG / CAD 各走对应文件头族", () => {
    const cases = [
      ["a.pdf", "application/pdf", PDF, "application/pdf", "pdf"],
      ["a.docx", null, ZIP, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "office"],
      ["a.xls", "application/vnd.ms-excel", OLE, "application/vnd.ms-excel", "office"],
      ["a.rtf", null, RTF, "application/rtf", "office"],
      ["a.txt", "text/plain", TEXT, "text/plain", "text"],
      ["a.html", "TEXT/HTML; charset=utf-8", HTML, "text/html", "html"],
      ["a.svg", "IMAGE/SVG+XML; charset=utf-8", SVG, "image/svg+xml", "svg"],
      ["a.xml-declared.svg", "image/svg+xml", XML_SVG, "image/svg+xml", "svg"],
      ["a.step", "model/step", TEXT, "application/octet-stream", "cad"],
      ["a.glb", "model/gltf-binary", GLB, "application/octet-stream", "cad"],
    ] as const;
    for (const [fileName, mime, bytes, canonical, kind] of cases) {
      expect(validateUploadFileType({ fileName, mime, bytes })).toMatchObject({
        ok: true,
        mime: canonical,
        kind,
      });
    }
  });

  it("上传校验：64 KiB 前缀截断 UTF-8 多字节字符时，合法 SVG / HTML 仍可识别", () => {
    const svgHead = encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"><text>');
    const chineseLeadByte = encoder.encode("中")[0]!;
    const truncatedSvg = Uint8Array.from([...svgHead, chineseLeadByte]);
    expect(validateUploadFileType({ fileName: "大图.svg", mime: "image/svg+xml", bytes: truncatedSvg })).toMatchObject({
      ok: true,
      mime: "image/svg+xml",
      kind: "svg",
    });

    const htmlHead = encoder.encode("<!doctype html><html><body>");
    const truncatedHtml = Uint8Array.from([...htmlHead, chineseLeadByte]);
    expect(
      validateUploadFileType({ fileName: "大页面.html", mime: "text/html", bytes: truncatedHtml }),
    ).toMatchObject({ ok: true, mime: "text/html", kind: "html" });
  });

  it("上传校验：声明 MIME 冲突 / 文件头冲突 / 双扩展名均拒绝，不能靠改名绕过", () => {
    expect(validateUploadFileType({ fileName: "poc.png", mime: "image/svg+xml", bytes: PNG })).toMatchObject({
      ok: false,
      code: "mime_mismatch",
      expectedMime: "image/png",
    });
    expect(validateUploadFileType({ fileName: "poc.svg", mime: "image/png", bytes: SVG })).toMatchObject({
      ok: false,
      code: "mime_mismatch",
      expectedMime: "image/svg+xml",
    });
    expect(validateUploadFileType({ fileName: "poc.svg.png", mime: "image/png", bytes: SVG })).toMatchObject({
      ok: false,
      code: "content_mismatch",
      expectedMime: "image/png",
    });
    expect(validateUploadFileType({ fileName: "poc.png", mime: "image/png", bytes: SVG })).toMatchObject({
      ok: false,
      code: "content_mismatch",
    });
    expect(validateUploadFileType({ fileName: "poc.pdf", mime: "application/pdf", bytes: HTML })).toMatchObject({
      ok: false,
      code: "content_mismatch",
    });
  });

  it("上传校验：未知扩展名不信任声明，统一 application/octet-stream / opaque", () => {
    expect(validateUploadFileType({ fileName: "payload.exe", mime: "image/svg+xml", bytes: SVG })).toEqual({
      ok: true,
      mime: "application/octet-stream",
      kind: "opaque",
      extension: "exe",
    });
    expect(validateUploadFileType({ fileName: "无扩展名", mime: "image/png", bytes: PNG })).toEqual({
      ok: true,
      mime: "application/octet-stream",
      kind: "opaque",
      extension: "bin",
    });
  });

  it("preview-content 响应：精确白名单类型 inline；SVG / HTML / 未知 / 非法 MIME 一律 attachment + octet-stream", () => {
    expect(safePreviewContentType("IMAGE/PNG; charset=binary")).toEqual({
      contentType: "image/png",
      disposition: "inline",
    });
    expect(safePreviewContentType("application/pdf")).toEqual({
      contentType: "application/pdf",
      disposition: "inline",
    });
    for (const mime of ["image/svg+xml", "text/html", "application/xhtml+xml", "application/xml", null]) {
      expect(safePreviewContentType(mime)).toEqual({
        contentType: "application/octet-stream",
        disposition: "attachment",
      });
    }
  });
});
