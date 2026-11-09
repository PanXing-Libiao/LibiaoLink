import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import type { MaterialReissueSnapshot } from "@libiaolink/contracts";
import {
  MATERIAL_REISSUE_APPLICATION_DEPARTMENT_OPTIONS,
  MATERIAL_REISSUE_FREIGHT_OPTIONS,
  MATERIAL_REISSUE_REASON_OPTIONS,
  MATERIAL_REISSUE_RESPONSIBLE_DEPARTMENT_OPTIONS,
} from "@libiaolink/contracts";

export const MATERIAL_REISSUE_DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type ZipEntry = { name: string; data: Buffer };

const BODY_FONT =
  '<w:rFonts w:hint="eastAsia" w:ascii="宋体" w:hAnsi="宋体" w:eastAsia="宋体" w:cs="宋体"/>';
const BODY_SIZE = '<w:sz w:val="21"/><w:szCs w:val="21"/>';

function bodyRunProperties(bold = false): string {
  return BODY_FONT + BODY_SIZE + (bold ? "<w:b/><w:bCs/>" : "");
}

const SHANGHAI_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});


function shanghaiPartMap(at: Date): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const part of SHANGHAI_PARTS.formatToParts(at)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return parts;
}

export function materialReissueFileName(snapshot: MaterialReissueSnapshot, at: Date): string {
  const parts = shanghaiPartMap(at);
  const stamp = (parts.year ?? "") + (parts.month ?? "") + (parts.day ?? "") + (parts.hour ?? "") + (parts.minute ?? "");
  const code = snapshot.projectCode.trim() === "" ? "项目" : snapshot.projectCode.trim();
  return "补发申请-" + code + "-" + stamp + ".docx";
}

export function materialReissueDefaultEmailTitle(projectCode: string, projectName: string): string {
  return "项目【补发申请】" + projectCode + " " + projectName + "项目/ 紧急";
}

export function buildMaterialReissueDocx(snapshot: MaterialReissueSnapshot, at: Date): Buffer {
  const entries = readTemplateEntries().map((entry) => ({
    name: entry.name,
    data: replaceTemplatePart(entry.name, documentXml(snapshot), coreXml(snapshot, at), appXml(), customXml()),
  }));
  return zipStore(entries);
}

function replaceTemplatePart(name: string, document: string, core: string, app: string, custom: string): Buffer {
  if (name === "word/document.xml") return Buffer.from(document, "utf8");
  if (name === "docProps/core.xml") return Buffer.from(core, "utf8");
  if (name === "docProps/app.xml") return Buffer.from(app, "utf8");
  if (name === "docProps/custom.xml") return Buffer.from(custom, "utf8");
  return readTemplateEntry(name);
}

let templateEntries: ZipEntry[] | null = null;

function readTemplateEntries(): ZipEntry[] {
  if (templateEntries === null) {
    const template = readFileSync(new URL("./material-reissue-template.docx", import.meta.url));
    templateEntries = readZipEntries(template);
  }
  return templateEntries;
}

function readTemplateEntry(name: string): Buffer {
  const found = readTemplateEntries().find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error("补发申请模板缺少部件：" + name);
  }
  return found.data;
}

function documentXml(snapshot: MaterialReissueSnapshot): string {
  const parts: string[] = [];
  parts.push(titleParagraph());
  parts.push(emailParagraph(snapshot));
  parts.push(mainTable(snapshot));
  parts.push(materialHeading());
  parts.push(materialTable(snapshot));
  parts.push(noteHeading());
  parts.push(noteParagraph(1, "项目部或售后部负责填写补发信息，并判断是否免费、是否质保期内。", false));
  parts.push(noteParagraph(2, "商务助理和仓库根据本申请表执行发货，不负责判断是否免费、是否保内。", false));
  parts.push(noteParagraph(3, "不属于常规免费补发范围但需免费补发的，须先经夏总审批，并在“是否已审批”处勾选“是”。", false));
  parts.push(noteParagraph(4, "收货信息、出库时间、运费承担方式需填写完整后再提交。", true));
  const sectPr =
    '<w:sectPr><w:headerReference r:id="rId3" w:type="default"/><w:footerReference r:id="rId4" w:type="default"/>' +
    '<w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1304" w:right="1077" w:bottom="1304" w:left="1077" w:header="851" w:footer="992" w:gutter="0"/>' +
    '<w:cols w:space="425" w:num="1"/><w:docGrid w:type="lines" w:linePitch="312" w:charSpace="0"/></w:sectPr>';
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    "<w:body>" + parts.join("") + sectPr + "</w:body></w:document>"
  );
}

function titleParagraph(): string {
  const rPr =
    '<w:rFonts w:hint="eastAsia" w:ascii="微软雅黑" w:hAnsi="微软雅黑" w:eastAsia="微软雅黑" w:cs="微软雅黑"/><w:b/><w:bCs/><w:sz w:val="32"/><w:szCs w:val="32"/>';
  return '<w:p><w:pPr><w:jc w:val="center"/><w:rPr>' + rPr + "</w:rPr></w:pPr><w:r><w:rPr>" + rPr + "</w:rPr><w:t>补发/补货申请表</w:t></w:r></w:p>";
}

function emailParagraph(snapshot: MaterialReissueSnapshot): string {
  const bold = bodyRunProperties(true);
  const boldEn = bold + '<w:lang w:val="en-US" w:eastAsia="zh-CN"/>';
  const title = snapshot.emailTitle?.trim() || materialReissueDefaultEmailTitle(snapshot.projectCode, snapshot.projectName);
  return (
    "<w:p><w:pPr><w:rPr><w:rFonts w:hint=\"eastAsia\" w:eastAsia=\"宋体\"/><w:lang w:eastAsia=\"zh-CN\"/></w:rPr></w:pPr>" +
    run("邮件标题：", bold) +
    run("  " + title, boldEn) +
    "</w:p>"
  );
}

function mainTable(snapshot: MaterialReissueSnapshot): string {
  const rows: string[] = [];
  rows.push(headerRow("项目", "填写内容"));
  rows.push(valueRow("项目编号", snapshot.projectCode));
  rows.push(valueRow("项目名称", snapshot.projectName));
  rows.push(valueRow("客户名称", snapshot.customerName ?? ""));
  rows.push(checkboxRow("申请部门", applicationDepartmentText(snapshot)));
  rows.push(valueRow("申请人", snapshot.applicantName));
  rows.push(checkboxRow("补发类别", reasonText(snapshot)));
  rows.push(checkboxRow("是否已验收", boolText(snapshot.accepted)));
  rows.push(checkboxRow("是否质保期内", boolText(snapshot.inWarranty)));
  rows.push(checkboxRow("是否免费补发", boolText(snapshot.freeReissue)));
  rows.push(checkboxRow("是否已审批", approvalText(snapshot.approved)));
  rows.push(checkboxRow("责任归属部门", responsibleDepartmentText(snapshot)));
  rows.push(valueRow("要求出库时间", slashDate(snapshot.requiredOutDate)));
  rows.push(checkboxRow("是否涉及旧件返还", boolText(snapshot.oldPartReturn)));
  rows.push(checkboxRow("运费承担", freightText(snapshot.freightBearer)));
  rows.push(valueRow("收货人", snapshot.recipient));
  rows.push(valueRow("联系电话", snapshot.phone));
  rows.push(valueRow("收货地址", snapshot.address));
  rows.push(valueRow("补发原因简述", snapshot.description));
  return (
    "<w:tbl><w:tblPr><w:tblStyle w:val=\"7\"/><w:tblW w:w=\"9968\" w:type=\"dxa\"/><w:jc w:val=\"center\"/>" +
    tableBorders() +
    '<w:tblLayout w:type="autofit"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr>' +
    '<w:tblGrid><w:gridCol w:w="1111"/><w:gridCol w:w="8857"/></w:tblGrid>' +
    rows.join("") +
    "</w:tbl>"
  );
}

function materialHeading(): string {
  const rPr = bodyRunProperties(true);
  return '<w:p><w:pPr><w:rPr>' + rPr + "</w:rPr></w:pPr><w:r><w:rPr>" + rPr + "</w:rPr><w:t>补发物料清单</w:t></w:r></w:p>";
}

function materialTable(snapshot: MaterialReissueSnapshot): string {
  const rows: string[] = [];
  rows.push(materialHeaderRow());
  snapshot.materials.forEach((item, index) => {
    rows.push(materialDataRow([
      String(index + 1),
      item.materialCode,
      item.materialName,
      item.specification,
      String(item.quantity),
      item.unit,
      item.remark,
    ]));
  });
  return (
    "<w:tbl><w:tblPr><w:tblStyle w:val=\"7\"/><w:tblW w:w=\"9962\" w:type=\"dxa\"/><w:jc w:val=\"center\"/>" +
    tableBorders() +
    '<w:tblLayout w:type="autofit"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr>' +
    '<w:tblGrid><w:gridCol w:w="960"/><w:gridCol w:w="1704"/><w:gridCol w:w="1714"/><w:gridCol w:w="1827"/><w:gridCol w:w="1026"/><w:gridCol w:w="960"/><w:gridCol w:w="1771"/></w:tblGrid>' +
    rows.join("") +
    "</w:tbl>"
  );
}

function materialHeaderRow(): string {
  const labels = ["序号", "物料编码", "物料名称", "规格型号", "数量", "单位", "备注"];
  return (
    '<w:tr><w:trPr><w:trHeight w:val="0" w:hRule="atLeast"/><w:tblHeader/><w:jc w:val="center"/></w:trPr>' +
    labels.map((label, index) => materialCell(label, index, true)).join("") +
    "</w:tr>"
  );
}

function materialDataRow(values: string[]): string {
  return (
    '<w:tr><w:trPr><w:trHeight w:val="0" w:hRule="atLeast"/><w:jc w:val="center"/></w:trPr>' +
    values.map((value, index) => materialCell(value, index, false)).join("") +
    "</w:tr>"
  );
}

function materialCell(value: string, index: number, bold: boolean): string {
  const widths = ["0", "1704", "1714", "1827", "1026", "0", "1771"];
  const width = widths[index] ?? "0";
  const widthXml = width === "0" ? '<w:tcW w:w="0" w:type="auto"/>' : '<w:tcW w:w="' + width + '" w:type="dxa"/>';
  const pPr =
    (index === 0 || index === 5
      ? '<w:snapToGrid w:val="0"/><w:ind w:left="0" w:leftChars="0" w:right="0" w:rightChars="0" w:firstLine="0" w:firstLineChars="0"/><w:jc w:val="center"/>'
      : '<w:keepNext w:val="0"/><w:keepLines w:val="0"/><w:widowControl/><w:suppressLineNumbers w:val="0"/><w:jc w:val="center"/><w:textAlignment w:val="center"/>') +
    (bold ? "<w:rPr><w:b/></w:rPr>" : "");
  const runs = value === "" ? "" : multilineRun(value, "<w:rPr>" + bodyRunProperties(bold) + "</w:rPr>");
  return "<w:tc><w:tcPr>" + widthXml + '<w:tcMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tcMar><w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr>' + pPr + "</w:pPr>" + runs + "</w:p></w:tc>";
}

function headerRow(left: string, right: string): string {
  return (
    '<w:tr><w:trPr><w:trHeight w:val="0" w:hRule="atLeast"/><w:tblHeader/><w:jc w:val="center"/></w:trPr>' +
    mainCell(left, true, true) +
    mainCell(right, true, false) +
    "</w:tr>"
  );
}

function valueRow(label: string, value: string): string {
  return (
    '<w:tr><w:trPr><w:trHeight w:val="0" w:hRule="atLeast"/><w:tblHeader/><w:jc w:val="center"/></w:trPr>' +
    mainCell(label, false, true) +
    mainCell(value, false, false) +
    "</w:tr>"
  );
}

function checkboxRow(label: string, valueXml: string): string {
  return (
    '<w:tr><w:trPr><w:trHeight w:val="0" w:hRule="atLeast"/><w:tblHeader/><w:jc w:val="center"/></w:trPr>' +
    mainCell(label, false, true) +
    "<w:tc><w:tcPr><w:tcW w:w=\"8857\" w:type=\"dxa\"/><w:tcMar><w:left w:w=\"108\" w:type=\"dxa\"/><w:right w:w=\"108\" w:type=\"dxa\"/></w:tcMar><w:vAlign w:val=\"center\"/></w:tcPr><w:p><w:pPr><w:snapToGrid w:val=\"0\"/></w:pPr>" +
    valueXml +
    "</w:p></w:tc></w:tr>"
  );
}

function mainCell(value: string, bold: boolean, label: boolean): string {
  const width = label ? '<w:tcW w:w="0" w:type="auto"/>' : '<w:tcW w:w="8857" w:type="dxa"/>';
  const pPr = '<w:snapToGrid w:val="0"/>' + (bold ? '<w:jc w:val="center"/>' : "");
  const rPr = "<w:rPr>" + bodyRunProperties(bold) + "</w:rPr>";
  const runs = value === "" ? "" : multilineRun(value, rPr);
  return "<w:tc><w:tcPr>" + width + '<w:tcMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tcMar><w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr>' + pPr + "</w:pPr>" + runs + "</w:p></w:tc>";
}

function noteHeading(): string {
  return (
    '<w:p><w:pPr><w:spacing w:before="160"/><w:ind w:firstLine="210" w:firstLineChars="100"/><w:rPr><w:rFonts w:hint="eastAsia" w:eastAsia="宋体"/><w:lang w:eastAsia="zh-CN"/></w:rPr></w:pPr>' +
    '<w:r><w:rPr>' + bodyRunProperties() + '</w:rPr><w:t xml:space="preserve"> </w:t></w:r>' +
    '<w:r><w:rPr>' + bodyRunProperties(true) + '</w:rPr><w:t>备注说明</w:t></w:r>' +
    '<w:r><w:rPr>' + bodyRunProperties(true) + '<w:lang w:eastAsia="zh-CN"/></w:rPr><w:t>：</w:t></w:r></w:p>'
  );
}

function noteParagraph(number: number, text: string, noSpacingAfter: boolean): string {
  const extra = number === 1 ? '<w:spacing w:before="0"/>' : noSpacingAfter ? '<w:spacing w:after="0"/>' : "";
  return (
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' +
    extra +
    '<w:ind w:left="720" w:hanging="360"/></w:pPr><w:r><w:rPr>' + bodyRunProperties() + '</w:rPr><w:t>' + esc(text) + "</w:t></w:r></w:p>"
  );
}

function applicationDepartmentText(snapshot: MaterialReissueSnapshot): string {
  return checkboxOptions(
    MATERIAL_REISSUE_APPLICATION_DEPARTMENT_OPTIONS,
    snapshot.applicationDepartment,
    snapshot.applicationDepartmentOther,
  );
}

function responsibleDepartmentText(snapshot: MaterialReissueSnapshot): string {
  return checkboxOptions(
    MATERIAL_REISSUE_RESPONSIBLE_DEPARTMENT_OPTIONS,
    snapshot.responsibleDepartment,
    snapshot.responsibleDepartmentOther,
  );
}

function reasonText(snapshot: MaterialReissueSnapshot): string {
  return checkboxOptions(MATERIAL_REISSUE_REASON_OPTIONS, snapshot.reason, snapshot.reasonOther);
}

function freightText(value: MaterialReissueSnapshot["freightBearer"]): string {
  return checkboxOptions(MATERIAL_REISSUE_FREIGHT_OPTIONS, value);
}

function checkboxOptions(
  options: ReadonlyArray<{ value: string; label: string }>,
  selected: string,
  otherText?: string,
): string {
  return options
    .map((option, index) => {
      const checked = option.value === selected;
      const label =
        option.value === "other" ? option.label + "：" + (checked && otherText ? otherText : "______") : option.label;
      return symbolRun(checked) + textRun(" " + label + (index === options.length - 1 ? "" : "　"));
    })
    .join("");
}

function boolText(value: boolean): string {
  return symbolRun(value) + textRun(" 是　") + symbolRun(!value) + textRun(" 否");
}

function approvalText(value: MaterialReissueSnapshot["approved"]): string {
  return (
    symbolRun(value === "yes") + textRun(" 是　") +
    symbolRun(value === "no") + textRun(" 否　") +
    symbolRun(value === "not_applicable") + textRun(" 不涉及")
  );
}

function symbolRun(checked: boolean): string {
  return (
    '<w:r><w:rPr>' + bodyRunProperties() + '</w:rPr><w:t>' + (checked ? "☑" : "☐") + "</w:t></w:r>"
  );
}

function textRun(text: string): string {
  return '<w:r><w:rPr>' + bodyRunProperties() + '</w:rPr><w:t xml:space="preserve">' + esc(text) + "</w:t></w:r>";
}

function multilineRun(value: string, rPr: string): string {
  return value
    .split(/\r?\n/)
    .map((line, index) => (index === 0 ? "" : "<w:r><w:br/></w:r>") + "<w:r>" + rPr + '<w:t xml:space="preserve">' + esc(line) + "</w:t></w:r>")
    .join("");
}

function run(text: string, rPr: string): string {
  return "<w:r><w:rPr>" + rPr + "</w:rPr><w:t xml:space=\"preserve\">" + esc(text) + "</w:t></w:r>";
}

function tableBorders(): string {
  return (
    '<w:tblBorders><w:top w:val="single" w:color="auto" w:sz="4" w:space="0"/><w:left w:val="single" w:color="auto" w:sz="4" w:space="0"/>' +
    '<w:bottom w:val="single" w:color="auto" w:sz="4" w:space="0"/><w:right w:val="single" w:color="auto" w:sz="4" w:space="0"/>' +
    '<w:insideH w:val="single" w:color="auto" w:sz="4" w:space="0"/><w:insideV w:val="single" w:color="auto" w:sz="4" w:space="0"/></w:tblBorders>'
  );
}

function slashDate(value: string): string {
  return value.replace(/-/g, "/");
}

function esc(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function coreXml(snapshot: MaterialReissueSnapshot, at: Date): string {
  const iso = at.toISOString();
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    "<dc:title>补发申请 " + esc(snapshot.projectCode) + "</dc:title>" +
    "<dc:creator>" + esc(snapshot.applicantName) + "</dc:creator>" +
    "<cp:lastModifiedBy>" + esc(snapshot.applicantName) + "</cp:lastModifiedBy>" +
    '<dcterms:created xsi:type="dcterms:W3CDTF">' + iso + "</dcterms:created>" +
    '<dcterms:modified xsi:type="dcterms:W3CDTF">' + iso + "</dcterms:modified>" +
    "</cp:coreProperties>"
  );
}

function appXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    "<Application>LibiaoLink</Application></Properties>"
  );
}

function customXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"></Properties>'
  );
}

function readZipEntries(buffer: Buffer): ZipEntry[] {
  const eocd = findSignature(buffer, 0x06054b50, Math.max(0, buffer.length - 65557));
  if (eocd < 0) throw new Error("补发申请模板不是有效的 DOCX（缺少 ZIP 目录）");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("补发申请模板 ZIP 目录损坏");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("补发申请模板 ZIP 文件头损坏");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : (() => { throw new Error("补发申请模板使用了不支持的 ZIP 压缩方式"); })();
    entries.push({ name, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findSignature(buffer: Buffer, signature: number, from: number): number {
  for (let offset = buffer.length - 22; offset >= from; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = 33;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}
