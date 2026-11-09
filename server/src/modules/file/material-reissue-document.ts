import type { MaterialReissueSnapshot } from "@libiaolink/contracts";
import {
  MATERIAL_REISSUE_DEPARTMENT_OPTIONS,
  MATERIAL_REISSUE_FREIGHT_OPTIONS,
  MATERIAL_REISSUE_REASON_OPTIONS,
} from "@libiaolink/contracts";

export const MATERIAL_REISSUE_DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type ZipEntry = { name: string; data: Buffer };

/**
 * 物料变更补发 DOCX（2026-11-09）：不引入 Office 生成依赖，按 OOXML 最小包 + ZIP store 方式生成。
 * 内容对齐业务现有《补发/补货申请表》：项目 / 申请人自动带入、补发类别为已选原因、物料清单逐行落表。
 * 生成结果作为普通项目文件版本（docx）进入 ONLYOFFICE 预览与下载链路。
 */
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

function shanghaiDateTimeText(at: Date): string {
  const parts = shanghaiPartMap(at);
  return (parts.year ?? "") + "-" + (parts.month ?? "") + "-" + (parts.day ?? "") + " " + (parts.hour ?? "") + ":" + (parts.minute ?? "");
}

export function materialReissueFileName(snapshot: MaterialReissueSnapshot, at: Date): string {
  const parts = shanghaiPartMap(at);
  const stamp = (parts.year ?? "") + (parts.month ?? "") + (parts.day ?? "") + (parts.hour ?? "") + (parts.minute ?? "");
  const code = snapshot.projectCode.trim() === "" ? "项目" : snapshot.projectCode.trim();
  return "补发申请-" + code + "-" + stamp + ".docx";
}

export function buildMaterialReissueDocx(snapshot: MaterialReissueSnapshot, at: Date): Buffer {
  const reason = optionLabel(MATERIAL_REISSUE_REASON_OPTIONS, snapshot.reason);
  const reasonText = snapshot.reason === "other" && snapshot.reasonOther ? reason + "：" + snapshot.reasonOther : reason;
  const applicationDepartment = optionLabel(MATERIAL_REISSUE_DEPARTMENT_OPTIONS, snapshot.applicationDepartment);
  const applicationText =
    snapshot.applicationDepartment === "other" && snapshot.applicationDepartmentOther
      ? applicationDepartment + "：" + snapshot.applicationDepartmentOther
      : applicationDepartment;
  const responsibleDepartment = optionLabel(MATERIAL_REISSUE_DEPARTMENT_OPTIONS, snapshot.responsibleDepartment);
  const responsibleText =
    snapshot.responsibleDepartment === "other" && snapshot.responsibleDepartmentOther
      ? responsibleDepartment + "：" + snapshot.responsibleDepartmentOther
      : responsibleDepartment;
  const approved =
    snapshot.approved === "yes" ? "☑ 是　☐ 否　☐ 不涉及" : snapshot.approved === "no" ? "☐ 是　☑ 否　☐ 不涉及" : "☐ 是　☐ 否　☑ 不涉及";
  const basicRows: Array<[string, string]> = [
    ["项目", "填写内容"],
    ["项目编号", snapshot.projectCode],
    ["项目名称", snapshot.projectName],
    ["客户名称", snapshot.customerName ?? ""],
    ["来源任务", snapshot.taskTitle],
    ["申请部门", applicationText],
    ["申请人", snapshot.applicantName],
    ["申请时间", shanghaiDateTimeText(at)],
    ["补发类别", reasonText],
    ["是否已验收", yesNo(snapshot.accepted)],
    ["是否质保期内", yesNo(snapshot.inWarranty)],
    ["是否免费补发", yesNo(snapshot.freeReissue)],
    ["是否已审批", approved],
    ["责任归属部门", responsibleText],
    ["要求出库时间", snapshot.requiredOutDate],
    ["是否涉及旧件返还", yesNo(snapshot.oldPartReturn)],
    ["运费承担", optionLabel(MATERIAL_REISSUE_FREIGHT_OPTIONS, snapshot.freightBearer)],
    ["收货人", snapshot.recipient],
    ["联系电话", snapshot.phone],
    ["收货地址", snapshot.address],
    ["补发原因简述", snapshot.description],
  ];
  const body: string[] = [];
  body.push(paragraphXml("补发/补货申请表", "Title"));
  body.push(
    paragraphXml(
      "邮件标题：　项目【补发申请】" + snapshot.projectCode + " " + snapshot.projectName + " / 紧急",
      "Subtitle",
    ),
  );
  body.push(tableXml(basicRows.map((row) => [row[0], row[1]]), [2060, 8400], true, [true, false]));
  body.push(paragraphXml("补发物料清单", "Heading1"));
  const materialRows: string[][] = [
    ["序号", "物料编码", "物料名称", "规格型号", "数量", "单位", "备注"],
    ...snapshot.materials.map((item, index) => [
      String(index + 1),
      item.materialCode,
      item.materialName,
      item.specification,
      String(item.quantity),
      item.unit,
      item.remark,
    ]),
  ];
  body.push(tableXml(materialRows, [620, 1320, 2020, 2020, 760, 760, 2960], true, [false, false, false, false, true, true, false]));
  body.push(paragraphXml("备注说明：", "Heading1"));
  body.push(paragraphXml("1. 项目部或售后部负责填写补发信息，并判断是否免费、是否质保期内。", "Note"));
  body.push(paragraphXml("2. 商务助理和仓库根据本申请表执行发货，不负责判断是否免费、是否保内。", "Note"));
  body.push(paragraphXml("3. 不属于常规免费补发范围但需免费补发的，须先经夏总审批，并在“是否已审批”处勾选“是”。", "Note"));
  body.push(paragraphXml("4. 收货信息、出库时间、运费承担方式需填写完整后再提交。", "Note"));
  body.push(paragraphXml("提交时间：" + shanghaiDateTimeText(at) + "　提交人：" + snapshot.applicantName, "Note"));
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    "<w:body>" +
    body.join("") +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360" w:gutter="0"/></w:sectPr>' +
    "</w:body></w:document>";
  return zipStore([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypesXml(), "utf8") },
    { name: "_rels/.rels", data: Buffer.from(packageRelsXml(), "utf8") },
    { name: "word/document.xml", data: Buffer.from(documentXml, "utf8") },
    { name: "word/_rels/document.xml.rels", data: Buffer.from(documentRelsXml(), "utf8") },
    { name: "word/styles.xml", data: Buffer.from(stylesXml(), "utf8") },
    { name: "docProps/core.xml", data: Buffer.from(coreXml(snapshot, at), "utf8") },
    { name: "docProps/app.xml", data: Buffer.from(appXml(), "utf8") },
  ]);
}


function optionLabel(options: readonly { value: string; label: string }[], value: string): string {
  return options.find((item) => item.value === value)?.label ?? value;
}

function yesNo(value: boolean): string {
  return value ? "☑ 是　☐ 否" : "☐ 是　☑ 否";
}

function esc(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function textRuns(value: string, bold: boolean): string {
  const parts = String(value).split(String.fromCharCode(10)).map((part) => part.split(String.fromCharCode(13)).join(""));
  return parts
    .map((line, index) => {
      const br = index === 0 ? "" : "<w:r><w:br/></w:r>";
      const rPr = bold ? "<w:rPr><w:b/></w:rPr>" : "";
      return br + "<w:r>" + rPr + '<w:t xml:space="preserve">' + esc(line) + "</w:t></w:r>";
    })
    .join("");
}

function paragraphXml(value: string, style: string, bold = false): string {
  return "<w:p><w:pPr><w:pStyle w:val=\"" + style + '"/></w:pPr>' + textRuns(value, bold) + "</w:p>";
}

function tableXml(rows: string[][], widths: number[], header: boolean, boldColumns: boolean[]): string {
  const border =
    '<w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="A1A1AA"/>' +
    '<w:left w:val="single" w:sz="4" w:space="0" w:color="A1A1AA"/>' +
    '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="A1A1AA"/>' +
    '<w:right w:val="single" w:sz="4" w:space="0" w:color="A1A1AA"/>' +
    '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="D4D4D8"/>' +
    '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="D4D4D8"/></w:tblBorders>';
  const grid =
    "<w:tblGrid>" +
    widths.map((width) => '<w:gridCol w:w="' + String(width) + '"/>').join("") +
    "</w:tblGrid>";
  const rowXmls = rows.map((cells, rowIndex) => {
    const isHeader = header && rowIndex === 0;
    const trPr = isHeader ? "<w:trPr><w:tblHeader/></w:trPr>" : "";
    const tcs = cells.map((cell, cellIndex) => {
      const width = widths[cellIndex] ?? 1000;
      const shade = isHeader ? '<w:shd w:val="clear" w:color="auto" w:fill="F4F4F5"/>' : "";
      const bold = isHeader || boldColumns[cellIndex] === true;
      return (
        "<w:tc><w:tcPr>" +
        '<w:tcW w:w="' + String(width) + '" w:type="dxa"/>' +
        shade +
        "</w:tcPr>" +
        paragraphXml(cell, "TableText", bold) +
        "</w:tc>"
      );
    }).join("");
    return "<w:tr>" + trPr + tcs + "</w:tr>";
  }).join("");
  return (
    '<w:tbl><w:tblPr><w:tblW w:w="10460" w:type="dxa"/>' +
    border +
    '<w:tblLayout w:type="fixed"/></w:tblPr>' +
    grid +
    rowXmls +
    "</w:tbl>"
  );
}

function contentTypesXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    "</Types>",
  ].join("");
}

function packageRelsXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>',
    "</Relationships>",
  ].join("");
}

function documentRelsXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    "</Relationships>",
  ].join("");
}

function stylesXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Microsoft YaHei"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults>',
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="80" w:line="280" w:lineRule="auto"/></w:pPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:after="160"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:sz w:val="18"/><w:color w:val="52525B"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="160" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="Note"><w:name w:val="Note"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="40"/></w:pPr><w:rPr><w:sz w:val="18"/><w:color w:val="52525B"/></w:rPr></w:style>',
    '<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:style>',
    "</w:styles>",
  ].join("");
}

function coreXml(snapshot: MaterialReissueSnapshot, at: Date): string {
  const iso = at.toISOString();
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    "<dc:title>补发申请 " + esc(snapshot.projectCode) + "</dc:title>",
    "<dc:creator>" + esc(snapshot.applicantName) + "</dc:creator>",
    "<cp:lastModifiedBy>" + esc(snapshot.applicantName) + "</cp:lastModifiedBy>",
    '<dcterms:created xsi:type="dcterms:W3CDTF">' + iso + "</dcterms:created>",
    '<dcterms:modified xsi:type="dcterms:W3CDTF">' + iso + "</dcterms:modified>",
    "</cp:coreProperties>",
  ].join("");
}

function appXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">',
    "<Application>LibiaoLink</Application>",
    "</Properties>",
  ].join("");
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
